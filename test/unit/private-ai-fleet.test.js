import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRIVATE_AI_FLEET_PATH = join(mkdtempSync(join(tmpdir(), "fleet-")), "fleet.json");
const FL = await import("../../src/services/private-ai/fleet.js");
const R = await import("../../src/services/private-ai/router.js");

test("a model's role comes from its annotation, else its name", () => {
  assert.equal(FL.inferRole("bge-m3"), "embed");
  assert.equal(FL.inferRole("qwen2-5-vl-7b"), "vision");
  assert.equal(FL.inferRole("gpt-oss-120b"), "large");
  assert.equal(FL.inferRole("llama-3-1-8b"), "small");
  assert.equal(FL.inferRole("granite-34b-code"), "large");
  assert.equal(FL.inferRole("my-model", { "tcs.com/role": "vision" }), "vision");
});

const M = (cluster, role, url, extra = {}) => ({ cluster, role, url, model: `${role}-${cluster}`, routing: true, sensitiveOk: true, ...extra });

test("candidates follow the cluster policy: no-answer clusters out, sensitive data only where allowed", () => {
  R.setFleetProvider({ models: () => [], mode: () => "preferred", preferred: () => "india" });
  const list = [M("eu", "small", "http://eu", { sensitiveOk: false }), M("india", "small", "http://in"), M("dr", "small", "http://dr", { routing: false })];
  assert.deepEqual(R.rankCandidates(list, "small").map((m) => m.cluster), ["india", "eu"]);
  assert.deepEqual(R.rankCandidates(list, "small", { sensitive: true }).map((m) => m.cluster), ["india"]);
});

test("least-loaded puts the cluster with fewer running requests first", () => {
  R.setFleetProvider({ models: () => [], mode: () => "least-loaded", preferred: () => "india" });
  R.noteLoad("http://in2", 9); R.noteLoad("http://eu2", 1);
  assert.deepEqual(R.rankCandidates([M("india", "small", "http://in2"), M("eu", "small", "http://eu2")], "small").map((m) => m.cluster), ["eu", "india"]);
  R.setFleetProvider({ models: () => [], mode: () => "preferred", preferred: () => null });
});

test("if the selected cluster's model is down, the same model on another cluster answers", async () => {
  const up = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end('{"data":[]}'); });
  await new Promise((res) => up.listen(0, "127.0.0.1", res));
  const live = `http://127.0.0.1:${up.address().port}`;
  const dead = "http://127.0.0.1:9";   // nothing listens on the discard port
  R.setFleetProvider({ models: () => [M("india", "small", dead), M("eu", "small", live)], mode: () => "preferred", preferred: () => "india" });
  R.resetTraffic();
  try {
    const out = await R.route({}, [{ role: "user", content: "how many pods are pending?" }]);
    assert.equal(out.o.apiUrl, live);
    assert.equal(out.decision.cluster, "eu");
    assert.match(out.decision.reason, /unavailable, answered on eu/);
  } finally {
    up.close(); R.setFleetProvider({ models: () => [], mode: () => "preferred", preferred: () => null }); R.resetTraffic();
  }
});

test("discovery lists a cluster's OpenShift AI models, exposes missing Routes and keeps the list per cluster", async () => {
  FL._resetFleet();
  const posted = [];
  FL.configureFleet({
    runForCluster: (_c, fn) => fn(),
    ocp: {
      fetch: async (p) => p.includes("inferenceservices")
        ? { items: [{ metadata: { name: "llama-3-1-8b", annotations: {} }, status: { conditions: [{ type: "Ready", status: "True" }] } },
                    { metadata: { name: "bge-m3", annotations: {} }, status: { conditions: [] } }] }
        : { items: [{ metadata: { name: "llama-3-1-8b" }, spec: { host: "llama-3-1-8b-openshift-mcp.apps.gpu.lab", to: { name: "llama-3-1-8b-predictor" } } }] },
      post: async (p, body) => { posted.push(body.metadata.name); return { spec: { host: `${body.metadata.name}-openshift-mcp.apps.gpu.lab` } }; },
    },
  });
  const out = await FL.discoverModels("gpu-a", { actor: "t" });
  assert.deepEqual(posted, ["bge-m3"]);
  assert.deepEqual(out.models.map((m) => [m.model, m.role, m.url]), [
    ["llama-3-1-8b", "small", "http://llama-3-1-8b-openshift-mcp.apps.gpu.lab"],
    ["bge-m3", "embed", "http://bge-m3-openshift-mcp.apps.gpu.lab"]]);
  await FL.setClusterPolicy("gpu-a", { sensitive: false, region: "EU" });
  const fm = FL.fleetModels();
  assert.equal(fm.length, 2);
  assert.ok(fm.every((m) => m.cluster === "gpu-a" && m.sensitiveOk === false && m.region === "EU"));
  FL._resetFleet(); await FL.restoreFleet();
  assert.equal(FL.fleetModels().length, 2, "kept across a restart");
  await assert.rejects(FL.setRoutingMode("random"), /preferred or least-loaded/);
  FL._resetFleet();
});
