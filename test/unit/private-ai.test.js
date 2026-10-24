/**
 * Private AI Operations Center: model routing, sensitive-data rule, the
 * llm.js hook, incident memory, the bad-rollout remediation, the Act 2
 * scenario, the egress switch, the batch VM assessment and the
 * Settings → Private AI switches.
 * Run with: node --test test/unit/private-ai.test.js
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert";

process.env.PRIVATE_AI_LARGE_URL = "http://large.test";
process.env.PRIVATE_AI_SMALL_URL = "http://small.test";
process.env.PRIVATE_AI_VISION_URL = "http://vision.test";
process.env.PRIVATE_AI_LARGE_GPU = "GPU 0 · H100";
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
process.env.PRIVATE_AI_SETTINGS_PATH = `${mkdtempSync(`${tmpdir()}/pai-`)}/settings.json`;

const R = await import("../../src/services/private-ai/router.js");
const E = await import("../../src/services/private-ai/embeddings.js");
const SC = await import("../../src/services/private-ai/scenario.js");
const CC = await import("../../src/services/private-ai/command-center.js");
const VB = await import("../../src/services/private-ai/vm-batch.js");
const PS = await import("../../src/services/private-ai/settings.js");
const { recentBadRollout } = await import("../../src/services/incident-orchestrator.js");

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });
const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });

describe("routing decisions", () => {
  const all = ["large", "small", "vision"];
  const d = (q, extra = {}) => R.decide({ messages: [{ role: "user", content: q }], available: all, ...extra });
  test("quick question → small, investigation → large, image → vision", () => {
    assert.equal(d("What does CrashLoopBackOff mean?").role, "small");
    assert.equal(d("Why is payments-api failing? Fix it.").role, "large");
    assert.equal(d("what is this", { images: [{ base64: "x" }] }).role, "vision");
    assert.equal(d("list pods", { tools: [{ name: "get_pods" }] }).role, "large");
  });
  test("YAML and code go to the coder model when there is one, else large", () => {
    assert.equal(d("Write a NetworkPolicy for payments").role, "large");
    assert.equal(R.decide({ messages: [{ role: "user", content: "write a YAML manifest" }], available: [...all, "coder"] }).role, "coder");
  });
  test("@deep / @fast override the choice and are stripped from the question", () => {
    const x = d("@deep what is a pod");
    assert.equal(x.role, "large");
    assert.equal(x.cleaned, "what is a pod");
    assert.equal(d("@fast why is it failing").role, "small");
  });
  test("secrets, tokens and keys are recognised as sensitive; ordinary numbers are not", () => {
    assert.deepEqual(R.sensitivity("db_password=Sup3rSecret!"), ["credential"]);
    assert.ok(R.sensitivity("-----BEGIN RSA PRIVATE KEY-----").includes("private key"));
    assert.ok(R.sensitivity("token ghp_abcdefghijklmnop1234").includes("GitHub / GitLab token"));
    assert.ok(R.sensitivity("card 4111 1111 1111 1111").includes("card number"));
    assert.deepEqual(R.sensitivity("pod restarted 1792824144123 times since CVE-2021-44228"), []);
  });
});

describe("route(): health, fallback and the on-prem rule", () => {
  beforeEach(() => { R.resetTraffic(); delete process.env.PRIVATE_AI_CLOUD_PROVIDER; });
  const o = { provider: "private", system: null, images: null, tools: null, apiKey: "", apiUrl: "" };
  const up = (set) => async (url) => reply(set.some((h) => String(url).startsWith(h)) ? 200 : 503, { data: [] });

  test("routes to the chosen model and records it in the traffic log", async () => {
    global.fetch = up(["http://small.test", "http://large.test"]);
    const r = await R.route({ ...o }, [{ role: "user", content: "what is a pod?" }], {});
    assert.equal(r.o.provider, "openai");
    assert.equal(r.o.apiUrl, "http://small.test");
    assert.equal(R.trafficLog(1)[0].model, "llama-3-1-8b");
  });
  test("a down model falls back to the nearest healthy on-prem one", async () => {
    await new Promise((res) => setTimeout(res, 5));
    global.fetch = up(["http://large.test"]);
    const r = await R.checkHealth({ url: "http://small.test" }, { force: true }) && await R.route({ ...o }, [{ role: "user", content: "what is a pod (fallback)?" }], {});
    assert.equal(r.o.apiUrl, "http://large.test");
    assert.match(r.decision.reason, /unavailable/);
  });
  test("sensitive data never goes to the cloud, even when cloud fallback is configured", async () => {
    process.env.PRIVATE_AI_CLOUD_PROVIDER = "azure";
    global.fetch = up([]);
    for (const m of R.models()) await R.checkHealth(m, { force: true });
    await assert.rejects(R.route({ ...o }, [{ role: "user", content: "check password=hunter2hunter2" }], {}), /not sent to a cloud model/);
    const ok = await R.route({ ...o }, [{ role: "user", content: "what is a pod?" }], {});
    assert.equal(ok.o.provider, "azure");
    assert.equal(ok.decision.onPrem, false);
    assert.equal(R.trafficCounts().cloudCalls, 1);
  });
  test("the traffic log masks sensitive text and hides the conversation id", async () => {
    global.fetch = up(["http://small.test", "http://large.test"]);
    for (const m of R.models()) await R.checkHealth(m, { force: true });
    await R.route({ ...o }, [{ role: "user", content: "rotate token=abcd1234efgh" }], { conversationId: "c-1" });
    const row = R.trafficLog(1, { conversationId: "c-1" })[0];
    assert.ok(!row.question.includes("abcd1234efgh"));
    assert.equal(row.conversationId, undefined);
    assert.ok(row.sensitive.includes("credential"));
  });
});

describe("llm.js with LLM_PROVIDER=private", () => {
  test("callLLM is answered by the routed on-prem endpoint (a real local HTTP server)", async () => {
    const http = await import("node:http");
    const hits = [];
    const srv = http.createServer((req, res) => {
      hits.push(req.url);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "llama-3-1-8b" }] }));
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        const j = JSON.parse(body);
        res.end(JSON.stringify({ model: j.model, choices: [{ message: { role: "assistant", content: `pong from ${j.model}` }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const saved = { s: process.env.PRIVATE_AI_SMALL_URL, l: process.env.PRIVATE_AI_LARGE_URL, np: process.env.NO_PROXY };
    process.env.PRIVATE_AI_SMALL_URL = url; process.env.PRIVATE_AI_LARGE_URL = url;
    process.env.NO_PROXY = `${process.env.NO_PROXY ? process.env.NO_PROXY + "," : ""}127.0.0.1,localhost`;
    global.fetch = realFetch;
    try {
      const { callLLM } = await import("../../src/services/llm.js");
      const r = await callLLM({ messages: [{ role: "user", content: "ping?" }], provider: "private", maxRetries: 0 });
      assert.equal(r.text, "pong from llama-3-1-8b");
      assert.ok(hits.includes("/v1/chat/completions"));
      const last = R.trafficLog(1)[0];
      assert.equal(last.ok, true);
      assert.equal(last.tokens, 8);
    } finally {
      process.env.PRIVATE_AI_SMALL_URL = saved.s; process.env.PRIVATE_AI_LARGE_URL = saved.l; process.env.NO_PROXY = saved.np;
      srv.close();
    }
  });
});

describe("incident memory embeddings", () => {
  test("batches texts, normalises and caches vectors", async () => {
    process.env.PRIVATE_AI_EMBED_URL = "http://embed.test";
    E._resetEmbeddings();
    let posts = 0;
    const fetchImpl = async (_u, opts) => { posts++; const input = JSON.parse(opts.body).input; return reply(200, { data: input.map((t, i) => ({ index: i, embedding: t.includes("connections") ? [3, 4] : [0, 1] })) }); };
    const v = await E.embedMany(["too many connections", "disk full"], { fetchImpl });
    assert.equal(posts, 1);
    assert.ok(Math.abs(E.denseCosine(v[0], v[0]) - 1) < 1e-6);
    await E.embedMany(["too many connections"], { fetchImpl });
    assert.equal(posts, 1, "served from cache");
    delete process.env.PRIVATE_AI_EMBED_URL;
  });
});

describe("bad-rollout remediation", () => {
  const dep = { metadata: { name: "payments-api", annotations: { "deployment.kubernetes.io/revision": "2" } }, spec: { replicas: 3 } };
  const rs = (rev, ready, ageMin, now) => ({ metadata: { name: `rs-${rev}`, annotations: { "deployment.kubernetes.io/revision": String(rev) }, ownerReferences: [{ kind: "Deployment", name: "payments-api" }], creationTimestamp: new Date(now - ageMin * 60000).toISOString() }, spec: { replicas: 3 }, status: { readyReplicas: ready } });
  test("a failing revision that rolled out recently, with the previous one retained, is rolled back", async () => {
    const now = Date.now();
    const get = async () => ({ items: [rs(1, 3, 600, now), rs(2, 0, 4, now)] });
    assert.deepEqual(await recentBadRollout("p", dep, { now, get }), { current: 2, previous: 1, ageMin: 4 });
  });
  test("not when the new revision is healthy, or rolled out long ago", async () => {
    const now = Date.now();
    assert.equal(await recentBadRollout("p", dep, { now, get: async () => ({ items: [rs(1, 3, 600, now), rs(2, 3, 4, now)] }) }), null);
    assert.equal(await recentBadRollout("p", dep, { now, get: async () => ({ items: [rs(1, 3, 6000, now), rs(2, 0, 5000, now)] }) }), null);
  });
});

describe("Act 2 scenario", () => {
  test("inject rolls out the bad config; reset restores the good one", async () => {
    SC._resetScenarioForTest();
    const patches = [];
    SC.configureScenario({ ocp: { fetch: async () => ({ metadata: { annotations: { "deployment.kubernetes.io/revision": "1" } }, spec: { replicas: 3, template: { spec: { volumes: [{ name: "config", configMap: { name: "payments-api-config" } }] } } }, status: { readyReplicas: 3 } }), patch: async (_p, b) => patches.push(b) }, detect: null });
    const s = await SC.injectFault({ actor: "presenter" });
    assert.equal(s.phase, "faulted");
    assert.equal(patches[0].spec.template.spec.volumes[0].configMap.name, "payments-api-config-v2");
    await assert.rejects(SC.injectFault({}), /already in progress/);
    const r = await SC.resetScenario({});
    assert.equal(r.phase, "idle");
    assert.equal(patches[1].spec.template.spec.volumes[0].configMap.name, "payments-api-config");
  });
});

describe("egress switch", () => {
  test("blocks the public internet and keeps private ranges and the cluster", () => {
    const p = CC.egressPolicy();
    assert.deepEqual(p.spec.policyTypes, ["Egress"]);
    const cidrs = p.spec.egress[0].to.map((t) => t.ipBlock.cidr);
    assert.ok(cidrs.includes("10.0.0.0/8") && cidrs.includes("172.16.0.0/12"));
    assert.ok(!cidrs.includes("0.0.0.0/0"));
  });
  test("block creates the policy, restore deletes it", async () => {
    const calls = [];
    let exists = false;
    CC.configureCommandCenter({ ocp: {
      fetch: async () => { if (!exists) throw new Error("OCP API 404: not found"); return { metadata: { creationTimestamp: "2026-10-24T10:00:00Z" } }; },
      post: async () => { calls.push("post"); exists = true; }, del: async () => { calls.push("delete"); exists = false; },
    } });
    assert.equal((await CC.setEgress(true)).blocked, true);
    assert.equal((await CC.setEgress(false)).blocked, false);
    assert.deepEqual(calls, ["post", "delete"]);
  });
});

describe("batch VM assessment", () => {
  test("the sample estate is deterministic and every VM gets exactly one decision", async () => {
    VB._resetBatch();
    assert.deepEqual(VB.sampleEstate(5).map((v) => v.name), VB.sampleEstate(5).map((v) => v.name));
    VB.startBatch({ sample: true, count: 300 });
    while (VB.batchStatus().state === "running") await new Promise((r) => setTimeout(r, 10));
    const s = VB.batchStatus();
    assert.equal(s.state, "done");
    assert.equal(s.synthetic, true);
    assert.equal(s.decisions.reduce((n, d) => n + d.n, 0), 300);
    assert.equal(s.waves.reduce((n, w) => n + w.n, 0), 300);
  });
});

test("on-prem model URLs bypass the egress proxy; cloud AI does not", async () => {
  const { bypassesProxy } = await import("../../src/services/llm.js");
  const np = process.env.NO_PROXY, np2 = process.env.no_proxy;
  process.env.NO_PROXY = ""; process.env.no_proxy = "";
  after(() => { process.env.NO_PROXY = np; process.env.no_proxy = np2; });
  assert.equal(bypassesProxy("http://gpt-oss-120b-predictor.tcs-private-ai.svc.cluster.local:80"), true);
  assert.equal(bypassesProxy("http://10.128.4.7:8080"), true);
  assert.equal(bypassesProxy("https://myco.openai.azure.com"), false);
  assert.equal(bypassesProxy("https://api.anthropic.com"), false);
});

describe("Settings → Private AI switches", () => {
  const ENV = ["PRIVATE_AI_OPS", "COMMAND_CENTER_BANNER", "LLM_PROVIDER", "PRIVATE_AI_CLUSTER"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  beforeEach(() => { PS._resetPrivateAiSettings(); for (const k of ENV) delete process.env[k]; });
  after(() => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; PS._resetPrivateAiSettings(); });

  test("off by default; the environment is the starting point", () => {
    assert.equal(CC.commandCenterEnabled(), false);
    process.env.PRIVATE_AI_OPS = "true"; process.env.COMMAND_CENTER_BANNER = "true"; process.env.LLM_PROVIDER = "private";
    const e = PS.effectiveSettings();
    assert.deepEqual([e.commandCenter, e.banner, e.routeChat, e.cluster], [true, true, true, "local"]);
    assert.equal(e.source.commandCenter, "environment");
  });
  test("a saved switch wins over the environment, survives a restart, and null goes back to it", async () => {
    process.env.PRIVATE_AI_OPS = "true";
    await PS.savePrivateAiSettings({ commandCenter: false }, { actor: "karuppu" });
    assert.equal(CC.commandCenterEnabled(), false);
    assert.equal(PS.effectiveSettings().source.commandCenter, "settings");
    await PS.savePrivateAiSettings({ commandCenter: true, cluster: "cluster02-gpu" });
    PS._resetPrivateAiSettings();
    await PS.restorePrivateAiSettings();
    assert.equal(CC.commandCenterEnabled(), true);
    assert.equal(PS.effectiveSettings().cluster, "cluster02-gpu");
    await PS.savePrivateAiSettings({ commandCenter: null });
    assert.equal(PS.effectiveSettings().source.commandCenter, "environment");
  });
  test("the banner never shows without the Command Center", async () => {
    await PS.savePrivateAiSettings({ commandCenter: false, banner: true });
    assert.equal(PS.effectiveSettings().banner, false);
  });
  test("PRIVATE_AI_OPS=false (disable.sh) switches everything off and Settings cannot override it", async () => {
    await PS.savePrivateAiSettings({ commandCenter: true, routeChat: true });
    process.env.PRIVATE_AI_OPS = "false";
    const e = PS.effectiveSettings();
    assert.deepEqual([e.commandCenter, e.routeChat, e.lockedOff], [false, false, true]);
    await assert.rejects(PS.savePrivateAiSettings({ commandCenter: true }), /switched off by the deployment/);
  });
  test("a cluster name is validated", async () => {
    await assert.rejects(PS.savePrivateAiSettings({ cluster: "../etc" }), /valid cluster/);
  });
});

describe("prerequisites", () => {
  test("GPU inventory counts whole GPUs and MIG slices per profile", () => {
    const inv = CC.gpuInventory([
      { status: { allocatable: { "nvidia.com/gpu": "1", "nvidia.com/mig-3g.40gb": "1", "nvidia.com/mig-1g.10gb": "2", cpu: "64" } } },
      { status: { allocatable: { cpu: "8" } } },
    ]);
    assert.deepEqual(inv, { nodes: 1, gpus: 1, mig: { "3g.40gb": 1, "1g.10gb": 2 } });
  });
  test("each check reports what it found and how to fix it, on the chosen cluster", async () => {
    const seen = [];
    CC.configureCommandCenter({
      runForCluster: (c, fn) => { seen.push(c); return fn(); },
      ocp: {
        fetch: async (path) => {
          if (path === "/api/v1/nodes") return { items: [{ status: { allocatable: { "nvidia.com/gpu": "2" } } }] };
          throw new Error("OCP API 404: not found");
        },
        post: async (_p, body) => ({ status: { allowed: body.spec.resourceAttributes.resource !== "networkpolicies" } }),
      },
    });
    SC.configureScenario({ runForCluster: (_c, fn) => fn(), ocp: { fetch: async () => { throw new Error("OCP API 404: not found"); } } });
    global.fetch = async (u) => (String(u).startsWith("http://small.test") ? reply(200, { data: [] }) : reply(503, {}));
    R.models().forEach((m) => R.checkHealth(m, { force: true }).catch(() => {}));
    const pre = await CC.prerequisites({ cluster: "cluster02-gpu" });
    assert.ok(seen.every((c) => c === "cluster02-gpu") && seen.length >= 2);
    assert.equal(pre.gpu.ok, true);
    assert.match(pre.gpu.detail, /2 whole GPUs/);
    assert.equal(pre.demo.ok, false);
    assert.match(pre.demo.fix, /scenario-payments\.yaml/);
    assert.equal(pre.permissions.ok, false);
    assert.match(pre.permissions.detail, /network policies/);
    assert.equal(pre.models.total, 3);
    assert.equal(pre.models.chatReady, true);
    assert.equal(pre.models.ok, false);
    global.fetch = realFetch;
  });
});
