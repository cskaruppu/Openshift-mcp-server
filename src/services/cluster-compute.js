// Compute at a glance, for the cluster cards: CPU capacity and how much is in
// use, and — only when the nodes advertise them — the GPUs, their model, MIG
// slices and utilisation. Detected from the cluster itself; a number that
// cannot be measured is null, never estimated.
//
//   capacity   node .status.capacity (cpu, nvidia.com/gpu, nvidia.com/mig-*)
//   model      node label nvidia.com/gpu.product, e.g. NVIDIA-H100-80GB-HBM3
//   CPU %      metrics.k8s.io node usage ÷ capacity
//   GPU %      DCGM through the cluster's monitoring (tools/gpu-metrics.js)

import { ocpGet } from "../utils/openshift-client.js";

const CACHE_MS = 20_000;
let _cache = { at: 0, value: null };

/** "250m" → 0.25, "2" → 2, "1500000n" → 0.0015 cores. */
export function parseCores(q) {
  const s = String(q ?? "").trim();
  if (!s) return 0;
  if (s.endsWith("n")) return Number(s.slice(0, -1)) / 1e9;
  if (s.endsWith("u")) return Number(s.slice(0, -1)) / 1e6;
  if (s.endsWith("m")) return Number(s.slice(0, -1)) / 1e3;
  return Number(s) || 0;
}

/** "NVIDIA-H100-80GB-HBM3" → "H100", "NVIDIA-A100-SXM4-40GB" → "A100", "Tesla-T4" → "T4". */
export function shortGpuModel(product) {
  const p = String(product || "").replace(/^(NVIDIA|AMD)[-_ ]/i, "").replace(/^Tesla[-_ ]/i, "");
  const m = p.match(/^([A-Z]+\d+[A-Z]*)/i) || p.match(/^([^-_ ]+)/);
  return m ? m[1].toUpperCase() : null;
}

/** Capacity from the node list: vCPU, GPUs, MIG slices and the model(s). */
export function computeFromNodes(nodes) {
  let vcpu = 0, gpus = 0, migSlices = 0;
  const models = new Map();
  for (const n of nodes || []) {
    const cap = n.status?.capacity || {};
    vcpu += parseCores(cap.cpu);
    let nodeGpus = 0;
    for (const [k, v] of Object.entries(cap)) {
      const q = parseInt(v, 10) || 0;
      if (k === "nvidia.com/gpu" || k === "amd.com/gpu") nodeGpus += q;
      else if (k.startsWith("nvidia.com/mig-")) migSlices += q;
    }
    // A MIG-partitioned card shows as slices, not as nvidia.com/gpu: count the
    // physical card from its label so "2× H100" stays true after partitioning.
    const L = n.metadata?.labels || {};
    const physical = parseInt(L["nvidia.com/gpu.count"], 10) || 0;
    const counted = Math.max(nodeGpus, physical);
    gpus += counted;
    const model = shortGpuModel(L["nvidia.com/gpu.product"] || L["amd.com/gpu.product"]);
    if (counted && model) models.set(model, (models.get(model) || 0) + counted);
  }
  const top = [...models.entries()].sort((a, b) => b[1] - a[1])[0];
  return { vcpu: Math.round(vcpu), gpus, migSlices, gpuModel: top ? top[0] : null, gpuModels: models.size > 1 ? Object.fromEntries(models) : null };
}

async function cpuPercent(capacityCores) {
  if (!capacityCores) return null;
  try {
    const m = await ocpGet("/apis/metrics.k8s.io/v1beta1/nodes");
    const used = (m.items || []).reduce((s, n) => s + parseCores(n.usage?.cpu), 0);
    return Math.max(0, Math.min(100, Math.round((used / capacityCores) * 100)));
  } catch { return null; }
}

async function gpuPercent() {
  try {
    const { getGpuOverview } = await import("../tools/gpu-metrics.js");
    const o = await getGpuOverview();
    const v = o?.summary?.avgUtilPct;
    return Number.isFinite(v) ? Math.round(v) : null;
  } catch { return null; }
}

const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

/**
 * Compute for the current cluster context. `nodes` is the node list the caller
 * already fetched. The live percentages are cached briefly and time-boxed, so
 * the cluster summary stays fast.
 */
export async function clusterCompute(nodes, { now = Date.now(), cacheKey = "local" } = {}) {
  const base = computeFromNodes(nodes);
  if (_cache.value && _cache.key === cacheKey && now - _cache.at < CACHE_MS) {
    return { ...base, cpuPct: _cache.value.cpuPct, gpuPct: base.gpus ? _cache.value.gpuPct : null };
  }
  const [cpuPct, gpuPct] = await Promise.all([
    within(cpuPercent(base.vcpu), 4000),
    base.gpus ? within(gpuPercent(), 5000) : null,
  ]);
  _cache = { at: now, key: cacheKey, value: { cpuPct, gpuPct } };
  return { ...base, cpuPct, gpuPct };
}

export function _resetComputeCache() { _cache = { at: 0, value: null }; }
