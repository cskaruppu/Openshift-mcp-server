// Private AI model catalogue: the models approved for this platform, whether
// each one is running, whether it fits on the GPUs right now, and deploying one
// from the console (Admin, audited).
//
// Source per model:
//   oci  an OpenShift AI catalog image (ModelCar, oci://registry.redhat.io/…):
//        pulled like any Red Hat image — no download job, no Hugging Face token
//   hf   a Hugging Face repository: downloaded once into a PVC by a Job (the
//        same steps as rhoai/deploy-rhoai.sh), then served from the PVC
// An Admin can set the catalog image for any entry (copied from the OpenShift AI
// dashboard's model catalog); that choice is stored like the other settings.
//
// GPU memory is reserved through HAMi (nvidia.com/gpumem), so "fits" means a card
// with at least that much memory not reserved by anyone. HAMi picks the card; we
// can choose the node.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { query as dbQuery, isEnabled as dbEnabled } from "../../utils/db.js";
import { registerPart, changed } from "./persist.js";

const MODELS_NS = () => process.env.PRIVATE_AI_MODELS_NAMESPACE || "openshift-mcp";
const DB_KEY = "private_ai_catalogue";
const FILE_PATH = process.env.PRIVATE_AI_CATALOGUE_PATH || "/data/mcp-private-ai-catalogue.json";
const HAMI_ENV = [{ name: "CUDA_DEVICE_MEMORY_SHARED_CACHE", value: "/tmp/hami-vgpu.cache" }];

/** The approved models. Sizes are the HAMi GPU-memory slices used by rhoai/*.yaml. */
export const CATALOGUE = [
  { id: "llama-3-1-8b", name: "Llama 3.1 8B Instruct", role: "small", runtime: "vllm", validated: true, licence: "Llama 3.1",
    hf: "RedHatAI/Llama-3.1-8B-Instruct", skip: "original/*", diskGi: 60, gpuMiB: 24576, context: "16K",
    args: ["--gpu-memory-utilization=0.90", "--max-model-len=16384", "--max-num-seqs=64", "--enable-auto-tool-choice", "--tool-call-parser=llama3_json"],
    desc: "Fast answers, summaries and tool calls. The router's fast model." },
  { id: "gpt-oss-120b", name: "gpt-oss-120b", role: "large", runtime: "vllm", validated: false, licence: "Apache 2.0",
    hf: "openai/gpt-oss-120b", skip: "original/*,metal/*", diskGi: 200, gpuMiB: 76000, context: "32K",
    args: ["--gpu-memory-utilization=0.92", "--max-model-len=32768", "--tool-call-parser=openai", "--enable-auto-tool-choice"],
    desc: "Deep reasoning and agent work: investigations, root cause, plans. Needs most of an H100." },
  { id: "gpt-oss-20b", name: "gpt-oss-20b", role: "large", runtime: "vllm", validated: true, licence: "Apache 2.0",
    hf: "RedHatAI/gpt-oss-20b", skip: "original/*,metal/*", diskGi: 60, gpuMiB: 24576, context: "32K",
    args: ["--gpu-memory-utilization=0.90", "--max-model-len=32768", "--max-num-seqs=32", "--tool-call-parser=openai", "--enable-auto-tool-choice"],
    desc: "Reasoning model small enough to sit beside the others. Enables Side by side." },
  { id: "qwen2-5-vl-7b", name: "Qwen2.5-VL 7B Instruct", role: "vision", runtime: "vllm", validated: false, licence: "Apache 2.0",
    hf: "Qwen/Qwen2.5-VL-7B-Instruct", skip: "", diskGi: 60, gpuMiB: 24576, context: "8K",
    args: ["--gpu-memory-utilization=0.90", "--max-model-len=8192", "--max-num-seqs=8", "--limit-mm-per-prompt={\"image\":2}"],
    desc: "Reads screenshots, dashboards and diagrams attached in AI Chat." },
  { id: "granite-3-3-8b", name: "Granite 3.3 8B Instruct", role: "small", runtime: "vllm", validated: true, licence: "Apache 2.0",
    hf: "RedHatAI/granite-3.3-8b-instruct", skip: "", diskGi: 60, gpuMiB: 24576, context: "16K",
    args: ["--gpu-memory-utilization=0.90", "--max-model-len=16384", "--max-num-seqs=64", "--enable-auto-tool-choice", "--tool-call-parser=granite"],
    desc: "IBM Granite, Apache-licensed: an alternative fast model for regulated customers." },
  { id: "bge-m3", name: "bge-m3 embeddings", role: "embed", runtime: "tei", validated: false, licence: "MIT",
    hf: "BAAI/bge-m3", skip: "onnx/*,imgs/*", diskGi: 20, gpuMiB: 6144, context: "8K",
    args: [], desc: "Incident memory: finds similar past incidents by meaning." },
];

/* ─────────────────────────── settings: catalog images, deployments ─────────────────────────── */

let _over = {};           // id → { oci, setBy, setAt }
let _deploys = {};        // `${cluster}/${id}` → { phase, steps[], startedAt, by, node, error }
let _deps = { runForCluster: (_c, fn) => fn(), ocp: null, floor: null, models: null, discover: null };
export function configureCatalogue(deps) { _deps = { ..._deps, ...deps }; }

registerPart("catalogue", {
  exportState: () => ({ deploys: _deploys }),
  importState: (st) => {
    _deploys = st.deploys || {};
    // A deploy that was running when the platform stopped is shown as interrupted.
    for (const d of Object.values(_deploys)) if (!["ready", "failed"].includes(d.phase)) { d.phase = "failed"; d.error = "Interrupted by a platform restart — deploy again (downloaded weights are kept)"; }
  },
});

export async function restoreCatalogue() {
  try {
    if (await dbEnabled()) {
      const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [DB_KEY]);
      let v = r?.rows?.[0]?.value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
      if (v && typeof v === "object") { _over = v; return; }
    }
  } catch { /* fall through */ }
  try { const v = JSON.parse(await readFile(FILE_PATH, "utf8")); if (v && typeof v === "object") _over = v; } catch { /* nothing saved */ }
}
async function persistOver() {
  try {
    if (await dbEnabled()) {
      await dbQuery(`INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`, [DB_KEY, JSON.stringify(_over)]);
      return "database";
    }
  } catch { /* fall back */ }
  try { await mkdir(dirname(FILE_PATH), { recursive: true }).catch(() => {}); await writeFile(FILE_PATH, JSON.stringify(_over, null, 2), "utf8"); return "file"; } catch { return "memory"; }
}

const entry = (id) => CATALOGUE.find((e) => e.id === id) || null;
const sourceOf = (e) => (_over[e.id]?.oci ? { kind: "oci", uri: _over[e.id].oci } : { kind: "hf", repo: e.hf });

/** Use an OpenShift AI catalog image (oci://…) for a model, or clear it ("") to go back to Hugging Face. */
export async function setCatalogImage(id, oci, { actor = "admin" } = {}) {
  const e = entry(id);
  if (!e) throw Object.assign(new Error("Not in the catalogue"), { status: 404 });
  const v = String(oci || "").trim();
  if (v && !/^oci:\/\/[a-z0-9.-]+(:\d+)?\/[A-Za-z0-9._\/-]+(:[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})?$/.test(v)) {
    throw Object.assign(new Error("Paste the catalog image as oci://registry/path:tag (from the OpenShift AI model catalog)"), { status: 400 });
  }
  if (v) _over[id] = { oci: v, setBy: actor, setAt: new Date().toISOString() }; else delete _over[id];
  return { id, source: sourceOf(e), storage: await persistOver() };
}

/* ─────────────────────────── fit ─────────────────────────── */

/**
 * Where a model needing `needMiB` of GPU memory can go now. Best fit: the card
 * with the least free memory that is still enough, so whole free cards stay
 * free for big models. "tight" = it fits, but only by taking the last card big
 * enough for a larger approved model that is not running.
 */
export function fitFor(needMiB, cards, { biggerNeeds = [] } = {}) {
  const ok = cards.filter((c) => c.freeMiB != null && c.freeMiB >= needMiB).sort((a, b) => a.freeMiB - b.freeMiB);
  if (!ok.length) {
    const best = cards.filter((c) => c.freeMiB != null).sort((a, b) => b.freeMiB - a.freeMiB)[0];
    return { status: cards.some((c) => c.freeMiB != null) ? "no-fit" : "unknown", largestFreeMiB: best?.freeMiB ?? null };
  }
  const pick = ok[0];
  const after = cards.map((c) => (c === pick ? { ...c, freeMiB: c.freeMiB - needMiB } : c));
  const blocks = biggerNeeds.filter((n) => cards.some((c) => c.freeMiB >= n) && !after.some((c) => c.freeMiB >= n));
  return { status: blocks.length ? "tight" : "fits", node: pick.node, index: pick.index, freeMiB: pick.freeMiB, candidates: ok.map((c) => ({ node: c.node, index: c.index, freeMiB: c.freeMiB })) };
}

/* ─────────────────────────── the read ─────────────────────────── */

export async function catalogueState({ cluster = "local", since } = {}) {
  const fy = _deps.floor ? await _deps.floor({ cluster, since }).catch(() => null) : null;
  const cards = (fy?.floor?.nodes || []).flatMap((n) => n.cards.map((c) => ({ node: n.name, index: c.index, freeMiB: c.freeMiB, memTotalMiB: c.memTotalMiB, slices: c.slices || [] })));
  const models = fy?.models || [];
  const running = models.filter((m) => m.ready);
  const items = CATALOGUE.map((e) => {
    const m = models.find((x) => x.model === e.id);
    const dep = _deploys[`${cluster}/${e.id}`] || null;
    const status = m?.control?.stopped ? "stopped" : m?.ready ? "running" : m?.notConnected ? (m.control?.ready ? "not-connected" : "starting")
      : m ? "down" : dep && !["ready", "failed"].includes(dep.phase) ? "deploying" : "not-deployed";
    const biggerNeeds = CATALOGUE.filter((x) => x.gpuMiB > e.gpuMiB && !running.some((r) => r.model === x.id)).map((x) => x.gpuMiB);
    const fit = ["running", "starting", "deploying", "down", "not-connected"].includes(status) ? null : fitFor(e.gpuMiB, cards, { biggerNeeds });
    return { ...e, source: sourceOf(e), catalogImageSetBy: _over[e.id]?.setBy || null, status, fit, deploy: dep, model: m || null };
  });
  const free = cards.reduce((a, c) => a + (c.freeMiB || 0), 0);
  return {
    cluster, items, cards,
    totals: { approved: CATALOGUE.length, validated: CATALOGUE.filter((e) => e.validated).length, catalogImages: Object.keys(_over).length,
      running: items.filter((i) => i.status === "running").length, freeMiB: free, largestFreeMiB: Math.max(0, ...cards.map((c) => c.freeMiB || 0)),
      fitsNow: items.filter((i) => i.fit && i.fit.status !== "no-fit" && i.fit.status !== "unknown").length },
  };
}

/* ─────────────────────────── deploy ─────────────────────────── */

const DOWNLOAD_PY = `import os, sys, socket, pathlib
os.environ["HF_HUB_OFFLINE"] = "0"
d = pathlib.Path("/cache/model"); done = d / ".tcs-complete"
if done.exists(): print("already downloaded"); sys.exit(0)
import huggingface_hub.constants as hc
from huggingface_hub import snapshot_download
hc.HF_HUB_OFFLINE = False
skip = [p for p in os.environ.get("SKIP", "").split(",") if p]
snapshot_download(os.environ["REPO"], local_dir=str(d), ignore_patterns=skip or None, token=os.environ.get("HF_TOKEN") or None)
done.write_text("ok"); print("downloaded", os.environ["REPO"])`;

/** The InferenceService for a catalogue entry, in the same shape as rhoai/*.yaml. */
export function inferenceService(e, { runtime, storageUri, node = null }) {
  const ns = MODELS_NS();
  return {
    apiVersion: "serving.kserve.io/v1beta1", kind: "InferenceService",
    metadata: {
      name: e.id, namespace: ns,
      labels: { "opendatahub.io/dashboard": "true", "tcs.com/demo": "private-ai-ops", "tcs.com/catalogue": e.id },
      annotations: { "serving.kserve.io/deploymentMode": "RawDeployment", "security.opendatahub.io/enable-auth": "false", "openshift.io/display-name": e.name, "tcs.com/role": e.role },
    },
    spec: { predictor: {
      minReplicas: 1, maxReplicas: 1,
      tolerations: [{ key: "nvidia.com/gpu", operator: "Exists", effect: "NoSchedule" }],
      ...(node ? { nodeSelector: { "kubernetes.io/hostname": node } } : {}),
      model: {
        modelFormat: { name: e.runtime === "tei" ? "tei" : "vLLM" }, runtime, storageUri,
        ...(e.args.length ? { args: e.args } : {}),
        env: HAMI_ENV,
        resources: {
          requests: { cpu: e.role === "embed" ? "2" : "4", memory: e.role === "embed" ? "8Gi" : "24Gi", "nvidia.com/gpu": "1", "nvidia.com/gpumem": String(e.gpuMiB) },
          limits: { cpu: e.role === "embed" ? "8" : "16", memory: e.role === "embed" ? "16Gi" : "96Gi", "nvidia.com/gpu": "1", "nvidia.com/gpumem": String(e.gpuMiB) },
        },
      },
    } },
  };
}

function downloadJob(e, image) {
  const ns = MODELS_NS();
  return {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name: `download-${e.id}`, namespace: ns, labels: { "tcs.com/demo": "private-ai-ops" } },
    spec: { backoffLimit: 1, activeDeadlineSeconds: 10800, template: { metadata: { labels: { "tcs.com/demo": "private-ai-ops" } }, spec: {
      restartPolicy: "Never",
      containers: [{ name: "download", image, command: ["python3", "-c"], args: [DOWNLOAD_PY],
        env: [{ name: "REPO", value: e.hf }, { name: "SKIP", value: e.skip || "" }, { name: "HOME", value: "/tmp" }, { name: "HF_HOME", value: "/tmp/hf" },
          { name: "HF_HUB_OFFLINE", value: "0" }, { name: "TRANSFORMERS_OFFLINE", value: "0" },
          { name: "HF_TOKEN", valueFrom: { secretKeyRef: { name: "hf-token", key: "HF_TOKEN", optional: true } } }],
        resources: { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "4", memory: "8Gi" } },
        volumeMounts: [{ name: "cache", mountPath: "/cache" }] }],
      volumes: [{ name: "cache", persistentVolumeClaim: { claimName: `${e.id}-cache` } }],
    } } },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop a deploy that is still in progress (downloading or waiting to become
 * ready). The download job is removed; a model service already created is
 * stopped in OpenShift AI (not deleted). Downloaded weights stay in the claim.
 */
export async function cancelDeploy({ cluster = "local", id, actor = "admin" }) {
  const key = `${cluster}/${id}`;
  const dep = _deploys[key];
  if (!dep || ["ready", "failed"].includes(dep.phase)) throw Object.assign(new Error("No deploy in progress for this model"), { status: 409 });
  dep.cancelled = true;
  dep.steps.push({ at: new Date().toISOString(), text: `Cancelled by ${actor}` });
  const ns = MODELS_NS();
  await _deps.runForCluster(cluster, async () => {
    try { await _deps.ocp.del(`/apis/batch/v1/namespaces/${ns}/jobs/download-${id}?propagationPolicy=Background`); } catch { /* not created yet */ }
    try { await _deps.ocp.patch(`/apis/serving.kserve.io/v1beta1/namespaces/${ns}/inferenceservices/${id}`, { metadata: { annotations: { "serving.kserve.io/stop": "true" } } }, "application/merge-patch+json"); } catch { /* not created yet */ }
  });
  dep.phase = "failed"; dep.error = "Cancelled — downloaded weights are kept; deploy again to resume"; changed();
  return { id, cluster, cancelled: true };
}

/**
 * Deploy a catalogue model on a GPU cluster. Returns at once; progress is in the
 * catalogue read (deploy.phase / steps). Refuses when it does not fit now.
 */
export async function deployModel({ cluster = "local", id, node = null, actor = "admin", since = null }) {
  const e = entry(id);
  if (!e) throw Object.assign(new Error("Not in the catalogue"), { status: 404 });
  const key = `${cluster}/${id}`;
  if (_deploys[key] && !["ready", "failed"].includes(_deploys[key].phase)) throw Object.assign(new Error(`${e.name} is already being deployed`), { status: 409 });
  const st = await catalogueState({ cluster, since });
  const item = st.items.find((i) => i.id === id);
  if (["running", "starting", "deploying", "down", "not-connected"].includes(item.status)) throw Object.assign(new Error(`${e.name} is already deployed (${item.status})`), { status: 409 });
  if (item.status === "stopped") throw Object.assign(new Error(`${e.name} is deployed but stopped — use Start`), { status: 409 });
  const target = node ? item.fit?.candidates?.find((c) => c.node === node) : item.fit?.candidates?.[0];
  if (!target) throw Object.assign(new Error(`${e.name} needs ${Math.round(e.gpuMiB / 1024)} GB of GPU memory on one card; the most free on any card is ${Math.round((item.fit?.largestFreeMiB || 0) / 1024)} GB`), { status: 409 });
  const dep = { phase: "starting", steps: [], startedAt: new Date().toISOString(), by: actor, node: target.node, source: sourceOf(e), error: null };
  _deploys[key] = dep; changed();
  const step = (text) => { dep.steps.push({ at: new Date().toISOString(), text }); changed(); };
  run().catch((err) => { if (dep.cancelled) return; dep.phase = "failed"; dep.error = err.message; step(`Failed: ${err.message}`); });
  return { id, cluster, node: target.node, phase: dep.phase };

  async function run() {
    const ns = MODELS_NS();
    const O = _deps.ocp;
    await _deps.runForCluster(cluster, async () => {
      // The serving runtime OpenShift AI uses for this kind of model (created by deploy-rhoai.sh).
      const rts = (await O.fetch(`/apis/serving.kserve.io/v1alpha1/namespaces/${ns}/servingruntimes`)).items || [];
      const rt = e.runtime === "tei" ? rts.find((r) => r.metadata.name === "tei-runtime") : rts.find((r) => /vllm/i.test(r.metadata.name));
      if (!rt) throw new Error(`No ${e.runtime === "tei" ? "tei-runtime" : "vLLM"} serving runtime in ${ns} — run rhoai/deploy-rhoai.sh once to create the runtimes`);
      step(`Serving runtime: ${rt.metadata.name}`);
      let storageUri;
      if (dep.source.kind === "oci") {
        storageUri = dep.source.uri;
        step(`OpenShift AI catalog image ${storageUri} — no download needed`);
      } else {
        dep.phase = "downloading"; changed();
        try { await O.fetch(`/api/v1/namespaces/${ns}/persistentvolumeclaims/${e.id}-cache`); step(`Storage ${e.id}-cache found (weights may already be there)`); }
        catch {
          await O.post(`/api/v1/namespaces/${ns}/persistentvolumeclaims`, { apiVersion: "v1", kind: "PersistentVolumeClaim",
            metadata: { name: `${e.id}-cache`, namespace: ns, labels: { "tcs.com/demo": "private-ai-ops" } },
            spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: `${e.diskGi}Gi` } } } });
          step(`Storage ${e.id}-cache created (${e.diskGi} Gi)`);
        }
        try { await O.del(`/apis/batch/v1/namespaces/${ns}/jobs/download-${e.id}?propagationPolicy=Background`); await sleep(3000); } catch { /* none yet */ }
        await O.post(`/apis/batch/v1/namespaces/${ns}/jobs`, downloadJob(e, rt.spec?.containers?.[0]?.image || ""));
        step(`Downloading ${e.hf} from Hugging Face (job download-${e.id})`);
        for (let i = 0; ; i++) {
          await sleep(15000);
          if (dep.cancelled) throw new Error("cancelled");
          const j = await O.fetch(`/apis/batch/v1/namespaces/${ns}/jobs/download-${e.id}`);
          const conds = (j.status?.conditions || []).filter((c) => c.status === "True").map((c) => c.type).join(" ");
          if (/Complete/.test(conds)) { step("Weights downloaded"); break; }
          if (/Fail/.test(conds)) throw new Error(`download failed — oc -n ${ns} logs job/download-${e.id}`);
          if (i > 720) throw new Error("download still running after 3 hours");
        }
        storageUri = `pvc://${e.id}-cache/model`;
      }
      dep.phase = "starting"; changed();
      if (dep.cancelled) throw new Error("cancelled");
      await O.post(`/apis/serving.kserve.io/v1beta1/namespaces/${ns}/inferenceservices`, inferenceService(e, { runtime: rt.metadata.name, storageUri, node: dep.node }));
      step(`Model service created on ${String(dep.node).split(".")[0]} (${Math.round(e.gpuMiB / 1024)} GB GPU slice)`);
      for (let i = 0; ; i++) {
        await sleep(15000);
        if (dep.cancelled) throw new Error("cancelled");
        const isvc = await O.fetch(`/apis/serving.kserve.io/v1beta1/namespaces/${ns}/inferenceservices/${e.id}`);
        if (isvc.metadata?.annotations?.["serving.kserve.io/stop"] === "true") { dep.cancelled = true; dep.phase = "failed"; dep.error = "Stopped before it was ready — Start it when there is room"; changed(); return; }
        if ((isvc.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True")) break;
        if (i > 160) throw new Error(`not ready after 40 minutes — oc -n ${ns} describe inferenceservice ${e.id}`);
      }
      step("Model ready in OpenShift AI");
    });
    if (dep.cancelled) return;
    if (_deps.discover) { await _deps.discover(cluster, actor); step("Connected to the AI router (GPU fleet → Discover models)"); }
    dep.phase = "ready"; dep.readyAt = new Date().toISOString(); changed();
  }
}

export function _resetCatalogue() { _over = {}; _deploys = {}; }
