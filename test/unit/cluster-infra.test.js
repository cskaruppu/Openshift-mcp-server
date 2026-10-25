/**
 * What a cluster runs on (services/cluster-infra.js): bare metal and whose
 * servers, VMware, other hypervisors, clouds.
 * Run with: node --test test/unit/cluster-infra.test.js
 */
import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";

const I = await import("../../src/services/cluster-infra.js");
const { withRemoteCluster } = await import("../../src/utils/openshift-client.js");

test("the machine: Dell bare metal, VMware, KVM, Hyper-V, and a maker we do not know", () => {
  assert.deepEqual(I.fromDmi("Dell Inc.", "PowerEdge R760xa"), { kind: "baremetal", name: "Bare metal", maker: "Dell", family: "PowerEdge", model: "PowerEdge R760xa", source: "machine" });
  assert.equal(I.fromDmi("HPE", "ProLiant DL380 Gen11").maker, "HPE");
  assert.equal(I.fromDmi("VMware, Inc.", "VMware7,1").kind, "vsphere");
  assert.equal(I.fromDmi("QEMU", "Standard PC (Q35 + ICH9, 2009)").name, "KVM");
  assert.equal(I.fromDmi("Red Hat", "KVM").name, "KVM");
  assert.equal(I.fromDmi("Microsoft Corporation", "Virtual Machine").name, "Hyper-V");
  assert.equal(I.fromDmi("Acme Widgets", "Box 1"), null, "an unknown maker is not called bare metal");
  assert.equal(I.fromDmi("", ""), null);
});

test("the platform type, then the nodes' providerID", () => {
  assert.equal(I.fromPlatform("VSphere", []).name, "VMware vSphere");
  assert.equal(I.fromPlatform("BareMetal", []).kind, "baremetal");
  assert.equal(I.fromPlatform("AWS", []).name, "AWS");
  assert.equal(I.fromPlatform("None", []), null, "platform None says nothing by itself");
  assert.equal(I.fromPlatform("None", [{ spec: { providerID: "vsphere://4230-ab" } }, { spec: {} }]).name, "VMware vSphere");
  assert.equal(I.fromPlatform(null, [{ spec: {} }]), null);
});

const serve = (platformType) => new Promise((res) => {
  const srv = http.createServer((q, r) => {
    r.setHeader("content-type", "application/json");
    if (q.url === "/apis/config.openshift.io/v1/infrastructures/cluster" && platformType !== undefined) return r.end(JSON.stringify({ status: { platformStatus: { type: platformType } } }));
    r.statusCode = 404; r.end("{}");
  });
  srv.listen(0, "127.0.0.1", () => res(srv));
});

test("platform None on Dell servers (agent-based bare metal): the machine decides", async () => {
  const srv = await serve("None");
  try {
    I._resetInfra(); I._setDmiForTest(I.fromDmi("Dell Inc.", "PowerEdge R760xa"));
    const r = await withRemoteCluster(`http://127.0.0.1:${srv.address().port}`, "t", () => I.clusterInfra([], { cacheKey: "local" }));
    assert.deepEqual([r.kind, r.maker, r.family], ["baremetal", "Dell", "PowerEdge"]);
  } finally { srv.close(); }
});

test("platform BareMetal: the server maker comes from the machine; VMware platform wins over the machine", async () => {
  const bm = await serve("BareMetal");
  try {
    I._resetInfra(); I._setDmiForTest(I.fromDmi("Dell Inc.", "PowerEdge R660"));
    const r = await withRemoteCluster(`http://127.0.0.1:${bm.address().port}`, "t", () => I.clusterInfra([], { cacheKey: "local" }));
    assert.deepEqual([r.kind, r.maker, r.model, r.source], ["baremetal", "Dell", "PowerEdge R660", "platform"]);
  } finally { bm.close(); }
  const vs = await serve("VSphere");
  try {
    I._resetInfra(); I._setDmiForTest(I.fromDmi("Dell Inc.", "PowerEdge R660"));
    const r = await withRemoteCluster(`http://127.0.0.1:${vs.address().port}`, "t", () => I.clusterInfra([], { cacheKey: "local" }));
    assert.equal(r.name, "VMware vSphere");
  } finally { vs.close(); }
});

test("another cluster seen from the hub never uses the hub's own machine", async () => {
  const srv = await serve(undefined);
  try {
    I._resetInfra(); I._setDmiForTest(I.fromDmi("Dell Inc.", "PowerEdge R760xa"));
    const r = await withRemoteCluster(`http://127.0.0.1:${srv.address().port}`, "t", () => I.clusterInfra([], { cacheKey: "https://api.other:6443" }));
    assert.equal(r, null);
  } finally { srv.close(); }
});
