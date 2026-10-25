// Compute at a glance, for the cluster cards: CPU capacity and how much is in
// use, and — only when the nodes advertise them — the GPUs, their model, MIG
// slices and utilisation. Detected from the cluster itself; a number that
// cannot be measured is null, never estimated.
//
//   capacity   node .status.capacity (cpu, nvidia.com/gpu, nvidia.com/mig-*);
//              physical GPUs from the nvidia.com/gpu.count label (time-slicing
//              and MIG change what nvidia.com/gpu advertises)
//   model      node label nvidia.com/gpu.product, e.g. NVIDIA-H100-80GB-HBM3
//   CPU %      metrics.k8s.io node usage ÷ capacity
//   GPU %      DCGM through the cluster's monitoring (tools/gpu-metrics.js)
//   vendors    GPU: the resource name (nvidia.com / amd.com / gpu.intel.com).
//              CPU: Node Feature Discovery's cpu-model.vendor_id label, else
//              the architecture (x86-64 / Arm64). The family (Xeon, EPYC) is
//              not in any label: it comes from /proc/cpuinfo of the node this
//              pod runs on, and only when its vendor matches the nodes'.

import { readFile } from "node:fs/promises";
import { ocpGet } from "../utils/openshift-client.js";

const CACHE_MS = 20_000;

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

const GPU_VENDOR = [[/^nvidia\.com\/gpu$/, "NVIDIA"], [/^amd\.com\/gpu$/, "AMD"], [/^gpu\.intel\.com\/(i915|xe)$/, "Intel"]];
const CPU_VENDOR = { intel: "Intel", genuineintel: "Intel", amd: "AMD", authenticamd: "AMD", arm: "Arm", ampere: "Ampere" };
const ARCH = { amd64: "x86-64", x86_64: "x86-64", arm64: "Arm64", aarch64: "Arm64", ppc64le: "POWER", s390x: "IBM Z" };
const FAMILY = { xeon: "Xeon", epyc: "EPYC", core: "Core", ryzen: "Ryzen", threadripper: "Threadripper", opteron: "Opteron", atom: "Atom", celeron: "Celeron", pentium: "Pentium" };
const most = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
const bump = (m, k, n = 1) => k && m.set(k, (m.get(k) || 0) + n);

/** "Intel(R) Xeon(R) Gold 6430" → { vendor: "Intel", family: "Xeon" }. */
export function parseCpuModel(modelName) {
  const s = String(modelName || "");
  const vendor = /intel/i.test(s) ? "Intel" : /\bamd\b/i.test(s) ? "AMD" : null;
  const fam = s.match(/\b(Xeon|EPYC|Core|Ryzen|Threadripper|Opteron|Atom|Celeron|Pentium)\b/i);
  return { vendor, family: fam ? FAMILY[fam[1].toLowerCase()] : null };
}

/** Capacity from the node list: vCPU, GPUs, MIG slices, the model(s) and the vendors. */
export function computeFromNodes(nodes) {
  let vcpu = 0, gpus = 0, migSlices = 0, shared = false;
  const models = new Map(), gpuVendors = new Map(), cpuVendors = new Map(), arches = new Map();
  for (const n of nodes || []) {
    const cap = n.status?.capacity || {};
    vcpu += parseCores(cap.cpu);
    let nodeGpus = 0;
    for (const [k, v] of Object.entries(cap)) {
      const q = parseInt(v, 10) || 0;
      const gv = GPU_VENDOR.find(([re]) => re.test(k));
      if (gv && q > 0) { nodeGpus += q; bump(gpuVendors, gv[1], q); }
      else if (k.startsWith("nvidia.com/mig-") && q > 0) { migSlices += q; bump(gpuVendors, "NVIDIA", q); }
    }
    const lab = n.metadata?.labels || {};
    bump(cpuVendors, CPU_VENDOR[String(lab["feature.node.kubernetes.io/cpu-model.vendor_id"] || "").toLowerCase()]);
    bump(arches, ARCH[n.status?.nodeInfo?.architecture || lab["kubernetes.io/arch"]]);
    // Count physical cards. The GPU Operator's nvidia.com/gpu.count label is
    // the physical count; the advertised nvidia.com/gpu is not — time-slicing
    // multiplies it by the replicas (2 cards × 20 replicas = 40) and MIG
    // replaces cards with slices.
    const L = n.metadata?.labels || {};
    const physical = parseInt(L["nvidia.com/gpu.count"], 10) || 0;
    const replicas = parseInt(L["nvidia.com/gpu.replicas"], 10) || 1;
    if (replicas > 1) shared = true;
    const counted = physical || (replicas > 1 ? Math.round(nodeGpus / replicas) : nodeGpus);
    gpus += counted;
    const model = shortGpuModel(L["nvidia.com/gpu.product"] || L["amd.com/gpu.product"]);
    if (counted && model) models.set(model, (models.get(model) || 0) + counted);
  }
  const top = [...models.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    vcpu: Math.round(vcpu), gpus, migSlices, shared, gpuModel: top ? top[0] : null, gpuModels: models.size > 1 ? Object.fromEntries(models) : null,
    gpuVendor: gpus ? most(gpuVendors) : null, cpuVendor: most(cpuVendors), cpuFamily: null, arch: most(arches),
  };
}

// The family of the CPU this pod runs on (read once). Linux only; null elsewhere.
let _localCpu;
async function localCpu() {
  if (_localCpu !== undefined) return _localCpu;
  try {
    const t = await readFile("/proc/cpuinfo", "utf8");
    _localCpu = parseCpuModel((t.match(/^model name\s*:\s*(.+)$/m) || [])[1]);
  } catch { _localCpu = { vendor: null, family: null }; }
  return _localCpu;
}

/** Add the CPU family when the local CPU's vendor agrees with the nodes' (or the nodes say nothing). */
export function withCpuFamily(base, local) {
  if (!local?.vendor || base.arch === "Arm64") return base;
  if (base.cpuVendor && base.cpuVendor !== local.vendor) return base;
  return { ...base, cpuVendor: base.cpuVendor || local.vendor, cpuFamily: local.family || null };
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

// Live usage per cluster context, measured in the background: the summary
// never waits for it (a GPU cluster's monitoring can take seconds, and the hub
// gives a spoke's summary only a few). A summary returns the latest values —
// null until the first measurement lands — and starts a refresh when they are
// older than CACHE_MS.
const _live = new Map(); // cacheKey → { at, cpuPct, gpuPct, running }

function refreshLive(key, vcpu, gpus, now) {
  const cur = _live.get(key) || { at: 0, cpuPct: null, gpuPct: null };
  if (cur.running) return;
  _live.set(key, { ...cur, running: true });
  Promise.all([within(cpuPercent(vcpu), 8000), gpus ? within(gpuPercent(), 10000) : null])
    .then(([cpuPct, gpuPct]) => _live.set(key, { at: now, cpuPct, gpuPct, running: false }))
    .catch(() => _live.set(key, { ...cur, running: false }));
}

/**
 * Compute for the current cluster context. `nodes` is the node list the caller
 * already fetched. Never slower than reading the nodes: live usage comes from
 * the background measurement (see refreshLive).
 */
export async function clusterCompute(nodes, { now = Date.now(), cacheKey = "local" } = {}) {
  // /proc/cpuinfo describes the node this pod runs on: only for its own cluster.
  const base = cacheKey === "local" ? withCpuFamily(computeFromNodes(nodes), await localCpu()) : computeFromNodes(nodes);
  const live = _live.get(cacheKey);
  if (!live || (!live.running && now - live.at >= CACHE_MS)) refreshLive(cacheKey, base.vcpu, base.gpus, now);
  return { ...base, cpuPct: live?.cpuPct ?? null, gpuPct: base.gpus ? live?.gpuPct ?? null : null };
}

/** Wait for the background measurement of `cacheKey` (tests). */
export async function _settleLive(cacheKey = "local") {
  for (let i = 0; i < 200 && _live.get(cacheKey)?.running; i++) await new Promise((r) => setTimeout(r, 10));
}

export function _resetComputeCache() { _live.clear(); }
