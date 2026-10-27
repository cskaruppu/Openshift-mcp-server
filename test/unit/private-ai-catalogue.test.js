import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { readFileSync } from "node:fs";

process.env.PRIVATE_AI_CATALOGUE_PATH = join(mkdtempSync(join(tmpdir(), "cat-")), "cat.json");
const C = await import("../../src/services/private-ai/catalogue.js");

const GB = 1024;
const cards = [
  { node: "n1", index: 0, freeMiB: 6 * GB }, { node: "n1", index: 1, freeMiB: 62 * GB },
  { node: "n2", index: 0, freeMiB: 26 * GB }, { node: "n2", index: 1, freeMiB: 80 * GB },
];

test("best fit keeps whole cards free for big models", () => {
  const f = C.fitFor(24576, cards);
  assert.equal(f.status, "fits");
  assert.deepEqual([f.node, f.index], ["n2", 0]);                    // 26 GB card, not the 80 GB one
  assert.equal(C.fitFor(90 * GB, cards).status, "no-fit");
  assert.equal(C.fitFor(90 * GB, cards).largestFreeMiB, 80 * GB);
  // 78 GB fits only on the 80 GB card, which a stopped 74 GB model also needs → tight
  assert.equal(C.fitFor(78 * GB, cards, { biggerNeeds: [] }).status, "fits");
  assert.equal(C.fitFor(70 * GB, cards, { biggerNeeds: [76000] }).status, "tight");
  assert.equal(C.fitFor(1, []).status, "unknown");
});

test("the model service matches rhoai/*.yaml for the same model", () => {
  const e = C.CATALOGUE.find((x) => x.id === "llama-3-1-8b");
  const gen = C.inferenceService(e, { runtime: "vllm-cuda-runtime", storageUri: "pvc://llama-3-1-8b-cache/model", node: "n2" });
  const file = yaml.load(readFileSync("deploy/demo/private-ai-ops/rhoai/30-llama-3-1-8b.yaml", "utf8").replace("__VLLM_RUNTIME__", "vllm-cuda-runtime"));
  assert.deepEqual(gen.spec.predictor.model.args, file.spec.predictor.model.args);
  assert.deepEqual(gen.spec.predictor.model.resources, file.spec.predictor.model.resources);
  assert.deepEqual(gen.spec.predictor.model.env, file.spec.predictor.model.env);
  assert.equal(gen.spec.predictor.model.storageUri, file.spec.predictor.model.storageUri);
  assert.equal(gen.spec.predictor.nodeSelector["kubernetes.io/hostname"], "n2");
  assert.equal(gen.metadata.annotations["tcs.com/role"], "small");
});

test("a catalog image must be an oci:// reference; clearing it goes back to Hugging Face", async () => {
  await assert.rejects(C.setCatalogImage("llama-3-1-8b", "https://evil/x"), /oci:\/\//);
  await assert.rejects(C.setCatalogImage("nope", "oci://registry.redhat.io/a/b:1"), /Not in the catalogue/);
  const r = await C.setCatalogImage("llama-3-1-8b", "oci://registry.redhat.io/rhelai1/modelcar-llama-3-1-8b-instruct:1.5");
  assert.equal(r.source.kind, "oci");
  assert.equal((await C.setCatalogImage("llama-3-1-8b", "")).source.kind, "hf");
  C._resetCatalogue();
});

test("a deploy in progress can be cancelled: download job removed, model service stopped, weights kept", async () => {
  C._resetCatalogue();
  const calls = [];
  C.configureCatalogue({
    runForCluster: (_c, fn) => fn(),
    ocp: {
      fetch: async (p) => {
        if (p.endsWith("/servingruntimes")) return { items: [{ metadata: { name: "vllm-cuda-runtime" }, spec: { containers: [{ image: "img" }] } }] };
        if (p.includes("/persistentvolumeclaims/")) return {};
        return { status: { conditions: [] } };
      },
      post: async (p) => { calls.push(["post", p]); return {}; },
      del: async (p) => { calls.push(["del", p]); return {}; },
      patch: async (p, body) => { calls.push(["patch", p, body]); return {}; },
    },
    floor: async () => ({ floor: { nodes: [{ name: "n1", cards: [{ index: 0, freeMiB: 80 * 1024, memTotalMiB: 80 * 1024, slices: [] }] }] }, models: [] }),
  });
  const out = await C.deployModel({ cluster: "gpu", id: "gpt-oss-20b", actor: "t" });
  assert.equal(out.node, "n1");
  await new Promise((r) => setTimeout(r, 50));
  const c = await C.cancelDeploy({ cluster: "gpu", id: "gpt-oss-20b", actor: "t" });
  assert.equal(c.cancelled, true);
  assert.ok(calls.some(([m, p]) => m === "del" && p.includes("/jobs/download-gpt-oss-20b")));
  assert.ok(calls.some(([m, p, b]) => m === "patch" && p.endsWith("/inferenceservices/gpt-oss-20b") && b.metadata.annotations["serving.kserve.io/stop"] === "true"));
  await assert.rejects(C.cancelDeploy({ cluster: "gpu", id: "gpt-oss-20b" }), /No deploy in progress/);
  C._resetCatalogue();
});
