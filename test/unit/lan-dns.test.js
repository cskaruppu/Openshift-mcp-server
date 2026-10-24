/**
 * Lab DNS fallback (utils/lan-dns.js): a name the normal resolver cannot find
 * is retried against SPOKE_DNS_SERVER — here a real DNS server on loopback.
 * Run with: node --test test/unit/lan-dns.test.js
 */
import { test, after } from "node:test";
import assert from "node:assert";
import dgram from "node:dgram";

// Minimal DNS server: answers A 10.131.20.15 for *.aiinfra.tcs.local (127.0.0.1
// for loop.aiinfra.tcs.local), NXDOMAIN otherwise.
const sock = dgram.createSocket("udp4");
sock.on("message", (q, rinfo) => {
  let i = 12; const labels = [];
  while (q[i]) { labels.push(q.subarray(i + 1, i + 1 + q[i]).toString()); i += q[i] + 1; }
  const name = labels.join("."), qEnd = i + 5;
  const hit = name.endsWith("aiinfra.tcs.local");
  const head = Buffer.from([q[0], q[1], 0x81, hit ? 0x80 : 0x83, 0, 1, 0, hit ? 1 : 0, 0, 0, 0, 0]);
  const question = q.subarray(12, qEnd);
  const ip = name === "loop.aiinfra.tcs.local" ? [127, 0, 0, 1] : [10, 131, 20, 15];
  const answer = hit ? Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...ip]) : Buffer.alloc(0);
  sock.send(Buffer.concat([head, question, answer]), rinfo.port, rinfo.address);
});
await new Promise((r) => sock.bind(0, "127.0.0.1", r));
// A second lab DNS that knows only *.second.lab.local, and is listed AFTER the first.
const sock2 = dgram.createSocket("udp4");
sock2.on("message", (q, rinfo) => {
  let i = 12; const labels = [];
  while (q[i]) { labels.push(q.subarray(i + 1, i + 1 + q[i]).toString()); i += q[i] + 1; }
  const hit = labels.join(".").endsWith("second.lab.local");
  const head = Buffer.from([q[0], q[1], 0x81, hit ? 0x80 : 0x83, 0, 1, 0, hit ? 1 : 0, 0, 0, 0, 0]);
  const answer = hit ? Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 10, 131, 16, 50]) : Buffer.alloc(0);
  sock2.send(Buffer.concat([head, q.subarray(12, i + 5), answer]), rinfo.port, rinfo.address);
});
await new Promise((r) => sock2.bind(0, "127.0.0.1", r));
process.env.SPOKE_DNS_SERVER = `127.0.0.1:${sock.address().port}, 127.0.0.1:${sock2.address().port}`;
process.env.LAN_HOSTS = "api.pinned.lab.local=10.131.74.6, *.apps.pinned.lab.local=10.131.74.7";
const L = await import("../../src/utils/lan-dns.js");
after(() => { sock.close(); sock2.close(); });

const look = (host, opts = {}) => new Promise((res) => L.lanLookup(host, opts, (err, address, family) => res({ err, address, family })));

test("a lab name the system resolver cannot find is answered by the lab DNS", async () => {
  const r = await look("api.aiinfra.tcs.local");
  assert.equal(r.err, null);
  assert.deepEqual([r.address, r.family], ["10.131.20.15", 4]);
  const all = await look("gpt-oss-120b-tcs-private-ai.apps.aiinfra.tcs.local", { all: true });
  assert.deepEqual(all.address, [{ address: "10.131.20.15", family: 4 }]);
});

test("names the system resolver knows never reach the lab DNS", async () => {
  const r = await look("localhost");
  assert.equal(r.err, null);
  assert.ok(["127.0.0.1", "::1"].includes(r.address));
});

test("a name neither knows fails, and the error says where it looked", async () => {
  const r = await look("api.unknown-zone.invalid");
  assert.ok(r.err);
  assert.match(r.err.message, /also not found via SPOKE_DNS_SERVER 127\.0\.0\.1:\d+, 127\.0\.0\.1:\d+/);
});

test("connect options carry the lookup only when a lab DNS is configured", () => {
  assert.equal(L.withLanDns({ timeout: 1 }).lookup, L.lanLookup);
  assert.equal(L.lanDnsServers().length, 2);
});

test("a cluster API call and a model health check by lab name both get through", async () => {
  const http = await import("node:http");
  const srv = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ status: { desired: { version: "4.22.4" } }, data: [] })); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const { withRemoteCluster, ocpGet } = await import("../../src/utils/openshift-client.js");
    const base = `http://loop.aiinfra.tcs.local:${srv.address().port}`;
    const cv = await withRemoteCluster(base, "t", () => ocpGet("/apis/config.openshift.io/v1/clusterversions/version"));
    assert.equal(cv.status.desired.version, "4.22.4");
    const r = await L.lanFetch(`${base}/v1/models`);
    assert.equal(r.status, 200);
  } finally { srv.close(); }
});

test("LAN_HOSTS pins names like a hosts file, with wildcards for a cluster's Routes", async () => {
  assert.equal((await look("api.pinned.lab.local")).address, "10.131.74.6");
  assert.equal((await look("gpt-oss-120b-tcs-private-ai.apps.pinned.lab.local")).address, "10.131.74.7");
  assert.ok((await look("apps.pinned.lab.local")).err, "a wildcard does not match the zone itself");
  const list = L.parseLanHosts("a.x.local=1.1.1.1\n*.x.local=2.2.2.2, junk, *.y.x.local=3.3.3.3");
  assert.equal(list.length, 3);
  assert.equal(L.lanHostsMatch("a.x.local", list), "1.1.1.1");
  assert.equal(L.lanHostsMatch("b.y.x.local", list), "3.3.3.3", "the most specific wildcard wins");
  assert.equal(L.lanHostsMatch("b.x.local", list), "2.2.2.2");
});

test("each lab DNS is asked in turn: the second answers for its own domain after the first says no", async () => {
  const r = await look("api.second.lab.local");
  assert.equal(r.err, null);
  assert.equal(r.address, "10.131.16.50");
});

test("the spoke proxy starts with several DNS servers and with an invalid entry (it once crashed the pod)", async () => {
  const { execFileSync } = await import("node:child_process");
  for (const value of ["10.131.19.154,10.131.16.39", "10.131.19.154, not-an-ip"]) {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", 'await import("./src/services/spoke-proxy.js"); console.log("started")'],
      { env: { ...process.env, SPOKE_DNS_SERVER: value }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(out, /started/, `did not start with SPOKE_DNS_SERVER="${value}"`);
  }
});
