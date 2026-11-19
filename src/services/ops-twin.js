/**
 * Ops Twin — an operational digital twin of one cluster, for "what if" questions
 * asked before a change: drain a node, a node or GPU fails, a rack loses power,
 * a model is added, the cluster is upgraded node by node, VMs are migrated in.
 *
 * The twin is a snapshot of live state read from the Kubernetes API (nodes,
 * pods and their requests, PodDisruptionBudgets, OpenShift Virtualization VMs,
 * KServe models, HAMi GPU slices), optionally enriched with DCGM power and
 * temperature per card. A scenario takes nodes or cards away (or adds load),
 * replays every displaced pod, VM and model through a small scheduler model
 * (CPU and memory requests, taints, node selectors and required node affinity,
 * HAMi GPU memory per card) and reports what moves, what cannot, what stops,
 * and what to do first. Nothing is changed on the cluster.
 *
 * It is a model, not the real scheduler: pod affinity/anti-affinity, topology
 * spread, storage zones and quotas are not simulated, and every result says so.
 */

import { parseHamiRegister, parseHamiAllocation } from "../tools/gpu-metrics.js";

const CACHE_MS = Number(process.env.OPS_TWIN_CACHE_MS) || 30_000;
const RACK_LABELS = () => (process.env.OPS_TWIN_RACK_LABEL ? [process.env.OPS_TWIN_RACK_LABEL] : [])
  .concat(["tcs.io/rack", "topology.kubernetes.io/rack", "rack", "topology.kubernetes.io/zone"]);
const MODEL_LABEL = "serving.kserve.io/inferenceservice";
const STOP_ANNOTATION = "serving.kserve.io/stop";

let _deps = {
  ocp: null,                              // { fetch(path) → parsed JSON }
  gpuTelemetry: async () => null,         // → [{ uuid, powerW, tempC }] or null
  now: () => Date.now(),
};
export function configureOpsTwin(deps) { _deps = { ..._deps, ...deps }; }

const _cache = new Map();                 // cluster → { at, twin }
const _history = new Map();               // cluster → [{ at, scenario, verdict, actor }]
export function _resetOpsTwin() { _cache.clear(); _history.clear(); }

/* ─────────────────────────── quantities ─────────────────────────── */

/** "500m" → 500, "2" → 2000 (millicores). */
export function cpuMilli(q) {
  if (q == null || q === "") return 0;
  const s = String(q).trim();
  if (s.endsWith("m")) return Math.round(Number(s.slice(0, -1)) || 0);
  if (s.endsWith("n")) return Math.round((Number(s.slice(0, -1)) || 0) / 1e6);
  return Math.round((Number(s) || 0) * 1000);
}
/** "2Gi", "2048Mi", "1G", bytes → MiB. */
export function memMiB(q) {
  if (q == null || q === "") return 0;
  const m = String(q).trim().match(/^([0-9.]+)\s*([KMGTPE]i?|k|m)?$/);
  if (!m) return 0;
  const MI = 1048576;
  const per = { Ki: 1024, Mi: MI, Gi: 1024 * MI, Ti: 1048576 * MI, Pi: 1073741824 * MI, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, m: 1e-3 }[m[2] || ""] ?? 1;
  return Math.round((Number(m[1]) * per) / MI);
}
const gib = (mib) => `${Math.round((mib / 1024) * 10) / 10} GiB`;
const cores = (m) => `${Math.round(m / 100) / 10} cores`;

/* ─────────────────────────── matching ─────────────────────────── */

function matchExpr(labels, e) {
  const v = labels?.[e.key];
  switch (e.operator) {
    case "In": return v != null && (e.values || []).includes(v);
    case "NotIn": return v == null || !(e.values || []).includes(v);
    case "Exists": return v != null;
    case "DoesNotExist": return v == null;
    case "Gt": return v != null && Number(v) > Number(e.values?.[0]);
    case "Lt": return v != null && Number(v) < Number(e.values?.[0]);
    default: return true;
  }
}
/** A label selector (matchLabels + matchExpressions) against labels. An empty selector matches everything. */
export function selectorMatches(sel, labels) {
  if (!sel) return false;
  for (const [k, v] of Object.entries(sel.matchLabels || {})) if (labels?.[k] !== v) return false;
  return (sel.matchExpressions || []).every((e) => matchExpr(labels, e));
}
function tolerates(tolerations, taint) {
  return (tolerations || []).some((t) => {
    if (t.effect && t.effect !== taint.effect) return false;
    if (!t.key) return t.operator === "Exists";
    if (t.key !== taint.key) return false;
    return t.operator === "Exists" || (t.value || "") === (taint.value || "");
  });
}
/** Could this pod land on this node, setting capacity aside? */
export function nodeAccepts(node, pod) {
  if (!node.ready || !node.schedulable) return false;
  for (const t of node.taints) {
    if ((t.effect === "NoSchedule" || t.effect === "NoExecute") && !tolerates(pod.tolerations, t)) return false;
  }
  for (const [k, v] of Object.entries(pod.nodeSelector || {})) if (node.labels[k] !== v) return false;
  const terms = pod.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  if (terms?.length && !terms.some((t) => (t.matchExpressions || []).every((e) => matchExpr(node.labels, e)))) return false;
  return true;
}

/* ─────────────────────────── building the twin ─────────────────────────── */

function ownerOf(p) {
  const ref = (p.metadata?.ownerReferences || []).find((o) => o.controller) || (p.metadata?.ownerReferences || [])[0];
  if (!ref) return null;
  if (ref.kind === "ReplicaSet") {
    const h = p.metadata?.labels?.["pod-template-hash"];
    const name = h && ref.name.endsWith(`-${h}`) ? ref.name.slice(0, -(h.length + 1)) : ref.name.replace(/-[a-z0-9]{5,10}$/, "");
    return { kind: "Deployment", name };
  }
  return { kind: ref.kind, name: ref.name };
}
function podRequests(p) {
  let cpu = 0, mem = 0, gpuMem = 0, gpus = 0;
  for (const c of p.spec?.containers || []) {
    const r = c.resources || {};
    cpu += cpuMilli(r.requests?.cpu ?? r.limits?.cpu);
    mem += memMiB(r.requests?.memory ?? r.limits?.memory);
    gpus += Number(r.limits?.["nvidia.com/gpu"] ?? r.requests?.["nvidia.com/gpu"] ?? 0) || 0;
    gpuMem += Number(r.limits?.["nvidia.com/gpumem"] ?? 0) || 0;
  }
  return { cpu, mem, gpus, gpuMem };
}

/**
 * Build the twin from raw API lists. Pure: tests call it with fixtures.
 * raw = { nodes, pods, pdbs, vmis, vms, isvcs, telemetry }
 */
export function buildTwin(raw, { cluster = "local", at = new Date().toISOString() } = {}) {
  const tele = new Map((raw.telemetry || []).filter((g) => g.uuid).map((g) => [g.uuid, g]));
  const rackKeys = RACK_LABELS();
  const nodes = (raw.nodes || []).map((n) => {
    const L = n.metadata?.labels || {};
    const A = n.metadata?.annotations || {};
    const alloc = n.status?.allocatable || {};
    const rackKey = rackKeys.find((k) => L[k]);
    const roles = Object.keys(L).filter((k) => k.startsWith("node-role.kubernetes.io/")).map((k) => k.split("/")[1]).filter(Boolean);
    // GPU cards: HAMi's register says which cards and how much memory each;
    // without HAMi, GPU Feature Discovery's count and per-card memory.
    let cards = parseHamiRegister(A["hami.io/node-nvidia-register"]).map((c, i) => ({ uuid: c.uuid, index: i, totalMiB: c.mib || Number(L["nvidia.com/gpu.memory"]) || 0, slices: [], hami: true }));
    if (!cards.length && Number(L["nvidia.com/gpu.count"]) > 0) {
      cards = Array.from({ length: Number(L["nvidia.com/gpu.count"]) }, (_, i) => ({ uuid: `${n.metadata.name}/gpu${i}`, index: i, totalMiB: Number(L["nvidia.com/gpu.memory"]) || 0, slices: [], hami: false }));
    }
    for (const c of cards) { const t = tele.get(c.uuid); c.powerW = t?.powerW ?? null; c.tempC = t?.tempC ?? null; }
    return {
      name: n.metadata.name,
      rack: rackKey ? L[rackKey] : null,
      roles: roles.length ? roles : ["worker"],
      labels: L,
      taints: n.spec?.taints || [],
      ready: (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True"),
      schedulable: !n.spec?.unschedulable,
      cpuAlloc: cpuMilli(alloc.cpu), memAlloc: memMiB(alloc.memory),
      cpuReq: 0, memReq: 0,
      product: L["nvidia.com/gpu.product"] || null,
      cards,
    };
  });
  const byNode = new Map(nodes.map((n) => [n.name, n]));

  const vmis = new Map((raw.vmis || []).map((v) => [`${v.metadata.namespace}/${v.metadata.name}`, v]));
  const vmSpec = new Map((raw.vms || []).map((v) => [`${v.metadata.namespace}/${v.metadata.name}`, v]));
  const pods = [];
  for (const p of raw.pods || []) {
    const phase = p.status?.phase;
    if (phase === "Succeeded" || phase === "Failed" || !p.spec?.nodeName) continue;
    const req = podRequests(p);
    const owner = ownerOf(p);
    const L = p.metadata?.labels || {};
    const vmName = L["kubevirt.io/created-by"] || L["vm.kubevirt.io/name"] ? (L["vm.kubevirt.io/name"] || (owner?.kind === "VirtualMachineInstance" ? owner.name : null)) : null;
    const hami = parseHamiAllocation(p.metadata?.annotations?.["hami.io/vgpu-devices-allocated"]);
    const pod = {
      ns: p.metadata.namespace, name: p.metadata.name, node: p.spec.nodeName,
      cpu: req.cpu, mem: req.mem, gpus: req.gpus, gpuMem: hami.reduce((a, x) => a + x.mib, 0) || req.gpuMem,
      cards: hami.map((x) => ({ uuid: x.uuid, mib: x.mib })),
      owner, labels: L,
      daemon: owner?.kind === "DaemonSet",
      mirror: !!p.metadata?.annotations?.["kubernetes.io/config.mirror"] || owner?.kind === "Node",
      job: owner?.kind === "Job",
      nodeSelector: p.spec?.nodeSelector || {}, tolerations: p.spec?.tolerations || [], affinity: p.spec?.affinity || null,
      model: L[MODEL_LABEL] || null,
      vm: owner?.kind === "VirtualMachineInstance" ? owner.name : (vmName || null),
    };
    pods.push(pod);
    const n = byNode.get(pod.node);
    if (!n) continue;
    n.cpuReq += pod.cpu; n.memReq += pod.mem;
    // Place the pod's GPU memory on its cards.
    if (pod.gpus > 0 || pod.cards.length) {
      if (pod.cards.length) {
        for (const c of pod.cards) {
          const card = n.cards.find((x) => x.uuid === c.uuid);
          if (card) card.slices.push({ ns: pod.ns, pod: pod.name, mib: c.mib, model: pod.model, owner: pod.model || pod.owner?.name || pod.name, team: pod.ns });
        }
      } else {
        // Whole cards, no HAMi record: take the first free ones.
        let want = Math.max(1, pod.gpus);
        for (const card of n.cards) {
          if (!want) break;
          if (card.slices.length) continue;
          card.slices.push({ ns: pod.ns, pod: pod.name, mib: card.totalMiB, model: pod.model, owner: pod.model || pod.owner?.name || pod.name, team: pod.ns, whole: true });
          want--;
        }
      }
    }
  }

  // VMs, from their VMI and launcher pod.
  const vms = [];
  for (const [key, vmi] of vmis) {
    const [ns, name] = key.split("/");
    const launcher = pods.find((p) => p.ns === ns && p.vm === name);
    const conds = vmi.status?.conditions || [];
    const migratable = conds.some((c) => c.type === "LiveMigratable" && c.status === "True");
    const strategy = vmi.spec?.evictionStrategy || (migratable ? "LiveMigrate" : "None");
    const vm = vmSpec.get(key);
    const runStrategy = vm?.spec?.runStrategy || (vm?.spec?.running === false ? "Halted" : "Always");
    vms.push({ ns, name, node: vmi.status?.nodeName || launcher?.node || null, cpu: launcher?.cpu || 0, mem: launcher?.mem || 0, migratable, strategy, runStrategy, launcher: launcher?.name || null, phase: vmi.status?.phase || null });
  }

  // Models: running KServe pods, and stopped InferenceServices (asleep).
  const models = [];
  const seen = new Set();
  for (const p of pods.filter((x) => x.model)) {
    if (seen.has(`${p.ns}/${p.model}`)) continue;
    seen.add(`${p.ns}/${p.model}`);
    const replicas = pods.filter((x) => x.model === p.model && x.ns === p.ns).length;
    models.push({ ns: p.ns, name: p.model, node: p.node, gpuMiB: p.gpuMem, replicas, asleep: false });
  }
  for (const s of raw.isvcs || []) {
    const ns = s.metadata?.namespace, name = s.metadata?.name;
    if (seen.has(`${ns}/${name}`)) continue;
    const stopped = String(s.metadata?.annotations?.[STOP_ANNOTATION] || "") === "true";
    const lim = s.spec?.predictor?.model?.resources?.limits || s.spec?.predictor?.containers?.[0]?.resources?.limits || {};
    models.push({ ns, name, node: null, gpuMiB: Number(lim["nvidia.com/gpumem"]) || null, gpus: Number(lim["nvidia.com/gpu"]) || 0, replicas: 0, asleep: stopped });
  }

  const pdbs = (raw.pdbs || []).map((b) => ({
    ns: b.metadata.namespace, name: b.metadata.name, selector: b.spec?.selector || null,
    allowed: Number(b.status?.disruptionsAllowed ?? 0), healthy: Number(b.status?.currentHealthy ?? 0), desired: Number(b.status?.desiredHealthy ?? 0),
    minAvailable: b.spec?.minAvailable ?? null, maxUnavailable: b.spec?.maxUnavailable ?? null,
  }));

  const racks = {};
  for (const n of nodes) (racks[n.rack || "Unassigned"] ||= []).push(n.name);
  const powerKnown = nodes.some((n) => n.cards.some((c) => c.powerW != null));
  return { cluster, at, nodes, pods, vms, models, pdbs, racks, powerKnown, racksKnown: nodes.some((n) => n.rack) };
}

/* ─────────────────────────── reading the cluster ─────────────────────────── */

async function list(path) {
  try { return (await _deps.ocp.fetch(path))?.items || []; } catch { return null; }
}

/** The live twin of a cluster, cached for a short while. `fresh` skips the cache. */
export async function snapshot(cluster = "local", { fresh = false } = {}) {
  const hit = _cache.get(cluster);
  if (!fresh && hit && _deps.now() - hit.atMs < CACHE_MS) return hit.twin;
  if (!_deps.ocp?.fetch) throw Object.assign(new Error("Ops Twin is not connected to a cluster"), { status: 503 });
  const [nodes, pods, pdbs, vmis, vms, isvcs] = await Promise.all([
    list("/api/v1/nodes"),
    list("/api/v1/pods?limit=5000"),
    list("/apis/policy/v1/poddisruptionbudgets"),
    list("/apis/kubevirt.io/v1/virtualmachineinstances"),
    list("/apis/kubevirt.io/v1/virtualmachines"),
    list("/apis/serving.kserve.io/v1beta1/inferenceservices"),
  ]);
  if (nodes === null || pods === null) throw Object.assign(new Error("Could not read nodes and pods from this cluster"), { status: 502 });
  let telemetry = null;
  try { telemetry = await _deps.gpuTelemetry(); } catch { /* optional */ }
  const twin = buildTwin({ nodes, pods, pdbs: pdbs || [], vmis: vmis || [], vms: vms || [], isvcs: isvcs || [], telemetry: telemetry || [] },
    { cluster, at: new Date(_deps.now()).toISOString() });
  twin.sources = { kubernetes: true, pdbs: pdbs !== null, virtualization: vmis !== null, models: isvcs !== null, gpuTelemetry: !!(telemetry && telemetry.length) };
  _cache.set(cluster, { atMs: _deps.now(), twin });
  return twin;
}

/** What the page shows before any scenario: the estate, compactly. */
export function overview(twin) {
  const gpuCards = twin.nodes.flatMap((n) => n.cards.map((c) => ({ ...c, node: n.name })));
  return {
    cluster: twin.cluster, at: twin.at, sources: twin.sources || null,
    counts: {
      nodes: twin.nodes.length, workers: twin.nodes.filter((n) => !n.roles.includes("master") && !n.roles.includes("control-plane")).length,
      racks: Object.keys(twin.racks).filter((r) => r !== "Unassigned").length,
      gpus: gpuCards.length, pods: twin.pods.length, vms: twin.vms.length,
      models: twin.models.length, modelsAsleep: twin.models.filter((m) => m.asleep).length, pdbs: twin.pdbs.length,
    },
    racksKnown: twin.racksKnown, powerKnown: twin.powerKnown,
    racks: twin.racks,
    nodes: twin.nodes.map((n) => nodeView(n, twin)),
    models: twin.models.map((m) => ({ ns: m.ns, name: m.name, node: m.node, gpuMiB: m.gpuMiB, asleep: m.asleep, replicas: m.replicas })),
  };
}

function nodeView(n, twin, overlay = {}) {
  const vms = twin.vms.filter((v) => v.node === n.name).map((v) => v.name);
  return {
    name: n.name, rack: n.rack, roles: n.roles, ready: n.ready, schedulable: n.schedulable, product: n.product,
    cpu: { alloc: n.cpuAlloc, req: n.cpuReq }, mem: { alloc: n.memAlloc, req: n.memReq },
    pods: twin.pods.filter((p) => p.node === n.name && !p.daemon && !p.mirror).length,
    vms,
    cards: n.cards.map((c) => ({ uuid: c.uuid, index: c.index, totalMiB: c.totalMiB, powerW: c.powerW, tempC: c.tempC, slices: c.slices.map((s) => ({ owner: s.owner, ns: s.ns, mib: s.mib, model: s.model || null })) })),
    ...overlay,
  };
}

/* ─────────────────────────── simulation ─────────────────────────── */

export const SCENARIOS = [
  { id: "drain", label: "Drain a node", hint: "maintenance, patching", needs: ["node"] },
  { id: "node-fail", label: "A node fails", hint: "sudden loss, no warning", needs: ["node"] },
  { id: "gpu-fail", label: "A GPU fails", hint: "one card stops", needs: ["node", "card"] },
  { id: "rack-fail", label: "Rack loses power", hint: "PDU or feed", needs: ["rack"] },
  { id: "add-model", label: "Add a model", hint: "will it fit?", needs: ["gpuGiB"] },
  { id: "upgrade", label: "Upgrade cluster", hint: "rolling, one node at a time", needs: [] },
  { id: "add-vms", label: "Migrate VMs in", hint: "from VMware or elsewhere", needs: ["count", "cpu", "memGiB"] },
];

/** Working copy of capacity: free CPU/memory per node, free MiB per card. */
function capacity(twin, gone = new Set(), goneCards = new Set()) {
  const cap = new Map();
  for (const n of twin.nodes) {
    if (gone.has(n.name)) continue;
    cap.set(n.name, {
      node: n, cpu: n.cpuAlloc - n.cpuReq, mem: n.memAlloc - n.memReq,
      cards: n.cards.filter((c) => !goneCards.has(c.uuid)).map((c) => ({ uuid: c.uuid, index: c.index, free: c.totalMiB - c.slices.reduce((a, s) => a + s.mib, 0), total: c.totalMiB, hami: c.hami })),
    });
  }
  return cap;
}

/** Place one item; returns { node, card } or null. Picks the node with the most memory left (spread). */
function place(cap, item, { exclude = new Set() } = {}) {
  let best = null;
  for (const [name, c] of cap) {
    if (exclude.has(name)) continue;
    if (!nodeAccepts(c.node, item)) continue;
    if (c.cpu < item.cpu || c.mem < item.mem) continue;
    let card = null;
    if (item.gpuMem > 0 || item.gpus > 0) {
      const need = item.gpuMem > 0 ? item.gpuMem : null;
      const fits = c.cards.filter((k) => (need ? k.free >= need : k.free >= k.total && k.total > 0));
      if (!fits.length) continue;
      // Tightest fit keeps big holes for big models.
      card = fits.sort((a, b) => a.free - b.free)[0];
    }
    const score = c.mem / Math.max(1, c.node.memAlloc);
    if (!best || score > best.score) best = { name, c, card, score };
  }
  if (!best) return null;
  best.c.cpu -= item.cpu; best.c.mem -= item.mem;
  if (best.card) best.card.free -= item.gpuMem > 0 ? item.gpuMem : best.card.total;
  return { node: best.name, card: best.card ? { uuid: best.card.uuid, index: best.card.index } : null };
}

const why = (cap, item) => {
  const nodes = [...cap.values()];
  const ok = nodes.filter((c) => nodeAccepts(c.node, item));
  if (!ok.length) return "no remaining node accepts it (taints, node selector or affinity)";
  if (item.gpuMem > 0 || item.gpus > 0) {
    const most = Math.max(0, ...ok.flatMap((c) => c.cards.map((k) => k.free)));
    if (!ok.some((c) => c.cards.length)) return "no remaining node it may run on has a GPU";
    if (item.gpuMem > 0) return `it needs ${gib(item.gpuMem)} on one card and the most free is ${gib(most)}`;
    return "no whole GPU is free";
  }
  const mostMem = Math.max(0, ...ok.map((c) => c.mem)), mostCpu = Math.max(0, ...ok.map((c) => c.cpu));
  if (mostMem < item.mem) return `it asks for ${gib(item.mem)} of memory and the most free on a node is ${gib(mostMem)}`;
  return `it asks for ${cores(item.cpu)} and the most free on a node is ${cores(mostCpu)}`;
};

const wkey = (p) => (p.owner ? `${p.ns}/${p.owner.kind}/${p.owner.name}` : `${p.ns}/Pod/${p.name}`);
const wlabel = (p) => (p.model ? p.model : p.owner ? `${p.owner.name}` : p.name);

/**
 * Run one scenario on the twin. Pure. Returns
 * { scenario, verdict: { level, title, text }, kpis, impact: [{ level, title, text, fix }],
 *   checks: [{ name, level, note }], plan: [{ at, text, level }], moves, view, assumptions }
 */
export function simulate(twin, sc) {
  const kind = sc?.kind;
  if (!SCENARIOS.some((s) => s.id === kind)) throw Object.assign(new Error("Unknown scenario"), { status: 400 });
  if (kind === "upgrade") return simulateUpgrade(twin, sc);
  if (kind === "add-model" || kind === "add-vms") return simulateAdd(twin, sc);

  const fail = kind === "node-fail" || kind === "rack-fail";
  let gone = new Set(), goneCards = new Set(), subject;
  if (kind === "drain" || kind === "node-fail") {
    const n = twin.nodes.find((x) => x.name === sc.node);
    if (!n) throw Object.assign(new Error(`No node called ${sc.node} in this cluster`), { status: 400 });
    gone.add(n.name); subject = n.name;
  } else if (kind === "rack-fail") {
    const names = twin.racks[sc.rack];
    if (!names?.length || sc.rack === "Unassigned") throw Object.assign(new Error(`No rack called ${sc.rack}. Label nodes with tcs.io/rack to group them`), { status: 400 });
    gone = new Set(names); subject = `rack ${sc.rack}`;
  } else if (kind === "gpu-fail") {
    const n = twin.nodes.find((x) => x.name === sc.node);
    const card = n?.cards.find((c) => c.uuid === sc.card || String(c.index) === String(sc.card));
    if (!card) throw Object.assign(new Error("Pick a GPU card on that node"), { status: 400 });
    goneCards.add(card.uuid); subject = `GPU-${card.index} on ${n.name}`;
  }
  return replay(twin, { kind, fail, gone, goneCards, subject });
}

function replay(twin, { kind, fail, gone, goneCards, subject }) {
  const cap = capacity(twin, gone, goneCards);
  const impact = [], moves = [], checks = [];
  const displaced = twin.pods.filter((p) => !p.daemon && !p.mirror && (gone.has(p.node) || (goneCards.size && p.cards.some((c) => goneCards.has(c.uuid)))));
  const vmsHit = twin.vms.filter((v) => gone.has(v.node));
  const vmLaunchers = new Set(vmsHit.map((v) => `${v.ns}/${v.launcher}`));
  const podsToMove = displaced.filter((p) => !vmLaunchers.has(`${p.ns}/${p.name}`));
  // A pod pushed off a failed card stays on a node that is still there: give
  // back what it held, so it can land on another card of the same node.
  for (const p of podsToMove) {
    const c = cap.get(p.node);
    if (!c) continue;
    c.cpu += p.cpu; c.mem += p.mem;
    for (const s of p.cards) { const k = c.cards.find((x) => x.uuid === s.uuid); if (k) k.free += s.mib; }
  }

  // ── VMs ──
  let vmDown = 0;
  const vmMoves = [];
  // Biggest first: they are the hardest to fit.
  for (const v of [...vmsHit].sort((a, b) => b.mem - a.mem)) {
    const item = { cpu: v.cpu, mem: v.mem, gpus: 0, gpuMem: 0, tolerations: [], nodeSelector: {} };
    const canLive = !fail && v.migratable && v.strategy !== "None";
    const restarts = v.runStrategy === "Always" || v.runStrategy === "RerunOnFailure";
    const to = place(cap, item);
    if (to && canLive) { vmMoves.push({ ...v, to: to.node, how: "live" }); continue; }
    if (to && restarts) { vmMoves.push({ ...v, to: to.node, how: "restart" }); vmDown++; continue; }
    vmMoves.push({ ...v, to: null, how: to ? "stays-off" : "no-room", reason: to ? null : why(cap, item) }); vmDown++;
  }
  const live = vmMoves.filter((m) => m.how === "live"), restart = vmMoves.filter((m) => m.how === "restart"), stuck = vmMoves.filter((m) => !m.to);
  if (live.length) impact.push({ level: "ok", title: `${live.length} VM${live.length > 1 ? "s live-migrate" : " live-migrates"}`, text: live.map((m) => `${m.name} → ${m.to}`).join(", "), fix: null });
  if (restart.length) {
    impact.push({ level: "warn", title: `${restart.length} VM${restart.length > 1 ? "s restart" : " restarts"} elsewhere`, text: `${restart.map((m) => m.name).join(", ")} ${restart.length > 1 ? (fail ? "go down with the node and are restarted on another node" : "cannot live-migrate, so they are shut down and started on another node") : (fail ? "goes down with the node and is restarted on another node" : "cannot live-migrate, so it is shut down and started on another node")}`, fix: fail ? null : { kind: "vm-migratable", text: `Make ${restart.length > 1 ? "them" : restart[0]?.name} live-migratable (shared RWX storage, eviction strategy LiveMigrate)`, targets: restart.map((m) => `${m.ns}/${m.name}`) } });
  }
  if (stuck.length) {
    const blocks = !fail && stuck.some((m) => m.strategy === "LiveMigrate");
    impact.push({ level: "crit", title: `${stuck.length} VM${stuck.length > 1 ? "s" : ""} would stay down`, text: `${stuck.map((m) => `${m.name}${m.reason ? ` (${m.reason})` : m.how === "stays-off" ? " (run strategy is not Always)" : ""}`).join("; ")}${blocks ? ". A VM set to live-migrate blocks the drain when it has nowhere to go" : ""}`, fix: { kind: "capacity", text: "Free memory on another node first, or add a node" } });
  }
  for (const m of vmMoves) moves.push({ kind: "vm", name: m.name, ns: m.ns, from: m.node, to: m.to, how: m.how });
  if (vmsHit.length) checks.push({ name: "VM live-migration", level: stuck.length ? "crit" : restart.length ? "warn" : "ok" });

  // ── pods, by workload ──
  const groups = new Map();
  for (const p of podsToMove) {
    const k = wkey(p);
    if (!groups.has(k)) groups.set(k, { key: k, sample: p, pods: [] });
    groups.get(k).pods.push(p);
  }
  const order = [...groups.values()].sort((a, b) => (b.sample.gpuMem - a.sample.gpuMem) || (b.sample.mem - a.sample.mem));
  let unplaced = 0, outages = 0;
  const modelMoves = [], singles = [], bare = [];
  for (const g of order) {
    if (!g.sample.owner) { bare.push(...g.pods.map((p) => `${p.ns}/${p.name}`)); continue; }
    const all = twin.pods.filter((p) => wkey(p) === g.key);
    const survivors = all.length - g.pods.length;
    let placed = 0, reason = null;
    for (const p of g.pods) {
      if (p.job) { placed++; continue; }               // a Job reruns where it can; not a service
      const to = place(cap, p);
      if (to) {
        placed++;
        const mv = { kind: p.model ? "model" : "pod", name: p.model || p.name, workload: wlabel(p), ns: p.ns, from: p.node, to: to.node, card: to.card, gpuMiB: p.gpuMem || null };
        moves.push(mv);
        if (p.model) modelMoves.push(mv);
      } else { reason = why(cap, p); moves.push({ kind: p.model ? "model" : "pod", name: p.model || p.name, workload: wlabel(p), ns: p.ns, from: p.node, to: null, reason }); }
    }
    const missing = g.pods.length - placed;
    unplaced += missing;
    const name = wlabel(g.sample);
    if (missing && survivors + placed === 0) {
      outages++;
      impact.push({ level: "crit", title: `${name} stops`, text: `${g.pods.length === 1 ? "Its only pod" : `All ${g.pods.length} pods`} ${gone.size ? "on the lost capacity" : "on that GPU"} cannot be placed: ${reason}`, fix: g.sample.model ? { kind: "gpu-room", text: "Make room on a GPU first (auto-sleep a quieter model) or keep this node" } : { kind: "capacity", text: "Free capacity on another node first" } });
    } else if (missing) {
      impact.push({ level: "warn", title: `${name} runs short`, text: `${missing} of ${all.length} pods cannot be placed (${reason}); ${survivors + placed} keep serving`, fix: null });
    } else if (survivors === 0 && !g.sample.job) {
      if (g.sample.model) {
        const to = [...new Set(moves.filter((m) => m.workload === name && m.to).map((m) => m.to))].join(", ");
        const card = moves.find((m) => m.workload === name && m.card)?.card;
        impact.push({ level: "ok", title: `${name} moves to ${card ? `GPU-${card.index} on ` : ""}${to}`, text: `${all.length === 1 ? "Single replica" : "Every replica is here"}: it restarts there, and the router answers with the other models meanwhile${g.sample.gpuMem ? ` · ${gib(g.sample.gpuMem)} GPU memory` : ""}`, fix: null });
      } else singles.push({ name, ns: g.sample.ns, kind: g.sample.owner.kind, platform: /^(openshift|kube-|default$)/.test(g.sample.ns) });
    }
  }
  // Single replicas restart once: OpenShift's own components expect it; an app is briefly down.
  const plat = singles.filter((s) => s.platform), apps = singles.filter((s) => !s.platform);
  if (plat.length) impact.push({ level: "ok", title: `${plat.length} platform component${plat.length > 1 ? "s" : ""} restart once`, text: "OpenShift’s own single-replica operators; they are built to be rescheduled", fix: null });
  if (apps.length) {
    impact.push({ level: "warn", title: `${apps.length} app${apps.length > 1 ? "s" : ""} with a single replica here`, text: `${apps.slice(0, 8).map((s) => `${s.ns}/${s.name}`).join(", ")}${apps.length > 8 ? ` and ${apps.length - 8} more` : ""}: ${fail ? "down until rescheduled" : "a short outage while each restarts"}`, fix: { kind: "scale", text: `Run 2 replicas of ${apps.length > 1 ? "each" : apps[0].name} so one keeps serving`, targets: apps.map((s) => `${s.ns}/${s.kind}/${s.name}`) } });
  }
  if (bare.length) impact.push({ level: "warn", title: `${bare.length} pod${bare.length > 1 ? "s" : ""} without a controller`, text: `${bare.slice(0, 6).join(", ")}${bare.length > 6 ? "…" : ""}: deleted and not recreated${fail ? "" : "; the drain needs --force for them"}`, fix: { kind: "bare", text: "Recreate them from a Deployment, or accept they are gone" } });
  const briefs = apps.length;
  const placedPods = moves.filter((m) => (m.kind === "pod" || m.kind === "model") && m.to).length;
  if (placedPods) impact.unshift({ level: "ok", title: `${placedPods} pod${placedPods > 1 ? "s" : ""} rescheduled`, text: `onto ${[...new Set(moves.filter((m) => m.kind !== "vm" && m.to).map((m) => m.to))].join(", ")} within CPU, memory${modelMoves.length ? " and GPU memory" : ""} limits`, fix: null });
  checks.unshift({ name: `Scheduler fit · ${podsToMove.length} pods`, level: outages ? "crit" : unplaced ? "warn" : "ok" });
  if (twin.nodes.some((n) => n.cards.length)) checks.push({ name: twin.nodes.some((n) => n.cards.some((c) => c.hami)) ? "HAMi GPU memory" : "GPU capacity", level: modelMoves.some((m) => !m.to) || moves.some((m) => m.kind === "model" && !m.to) ? "crit" : "ok" });

  // ── disruption budgets (a drain respects them; a failure does not) ──
  let pdbLevel = "ok";
  for (const b of twin.pdbs) {
    const hit = displaced.filter((p) => p.ns === b.ns && selectorMatches(b.selector, p.labels));
    if (!hit.length) continue;
    if (fail) {
      const left = b.healthy - hit.length;
      if (left < b.desired) { pdbLevel = "warn"; impact.push({ level: "warn", title: `${b.name} drops below its budget`, text: `${left} of the ${b.desired} pods it requires stay healthy until the lost ones are replaced`, fix: null }); }
      continue;
    }
    if (hit.length > b.allowed) {
      const need = hit.length - b.allowed;
      pdbLevel = pdbLevel === "crit" ? "crit" : "warn";
      const owner = hit[0].owner;
      impact.push({
        level: "warn", title: `${b.name} holds the drain`,
        text: `${hit.length} of its pods ${hit.length === 1 ? "is" : "are"} here and it allows ${b.allowed} disruption${b.allowed === 1 ? "" : "s"} (${b.healthy} healthy, ${b.desired} required): the drain waits${b.allowed === 0 ? " and never finishes" : ""}`,
        fix: owner && owner.kind !== "Job" ? { kind: "scale", text: `Scale ${owner.name} up by ${need} first`, target: { ns: b.ns, kind: owner.kind, name: owner.name, replicas: twin.pods.filter((p) => wkey(p) === wkey(hit[0])).length + need } } : { kind: "pdb", text: `Relax ${b.name} for the window` },
      });
    }
  }
  if (displaced.length) checks.push({ name: "Disruption budgets", level: pdbLevel });

  // ── models asleep that could not wake while this lasts ──
  const asleep = twin.models.filter((m) => m.asleep && m.gpuMiB);
  if (asleep.length) {
    const freeMax = Math.max(0, ...[...cap.values()].flatMap((c) => c.cards.map((k) => k.free)));
    let wakeLevel = "ok";
    for (const m of asleep) {
      if (m.gpuMiB > freeMax) {
        wakeLevel = "warn";
        impact.push({ level: "warn", title: `${m.name} can’t wake meanwhile`, text: `it needs ${gib(m.gpuMiB)} on one card; the most free will be ${gib(freeMax)}`, fix: { kind: "hold-wake", text: `Keep ${m.name} asleep until ${subject} is back`, target: { model: m.name } } });
      }
    }
    checks.push({ name: "Auto-wake", level: wakeLevel });
  }

  // ── rack and power ──
  const lostCards = twin.nodes.flatMap((n) => n.cards.filter((c) => gone.has(n.name) || goneCards.has(c.uuid)));
  const powerW = twin.powerKnown ? -Math.round(lostCards.reduce((a, c) => a + (c.powerW || 0), 0)) : null;
  if (twin.racksKnown) checks.push({ name: "Rack grouping", level: "ok" });

  const totalCards = twin.nodes.reduce((a, n) => a + n.cards.length, 0);
  const crit = impact.filter((i) => i.level === "crit").length;
  const actions = impact.filter((i) => i.level === "warn" && i.fix).length;
  const downtime = crit ? "outage" : (vmDown || (briefs && !fail)) ? "brief restarts" : fail && displaced.length ? "until rescheduled" : "none";
  const verdict = crit
    ? { level: "crit", title: "Not safe as it stands", text: `${crit} thing${crit > 1 ? "s" : ""} would stop. Fix ${crit > 1 ? "them" : "it"} before ${kind === "drain" ? "draining" : "this happens"}.` }
    : actions
      ? { level: "warn", title: `Safe with ${actions} action${actions > 1 ? "s" : ""} first`, text: `No outage expected once the action${actions > 1 ? "s" : ""} below ${actions > 1 ? "are" : "is"} done.` }
      : { level: "ok", title: "Safe", text: fail ? "Everything that was there can run elsewhere once it is rescheduled." : "Everything moves without an outage." };
  // A rough drain time: VMs migrate two at a time, pods restart in parallel.
  const minutes = Math.max(1, Math.round((1 + Math.ceil(live.length / 2) * 1.5 + Math.ceil(restart.length / 2) * 2 + (podsToMove.length ? 1 : 0)) * 10) / 10);
  const kpis = {
    downtime, minutes: kind === "drain" ? minutes : null,
    moves: moves.filter((m) => m.to).length, cannotMove: moves.filter((m) => !m.to).length + stuck.length,
    gpusInService: totalCards ? `${totalCards - lostCards.length} / ${totalCards}` : null,
    powerW,
  };

  // ── a plan, in order ──
  const plan = [];
  if (kind === "drain") {
    plan.push({ text: `Cordon ${subject}`, level: "info" });
    for (const i of impact.filter((x) => x.level === "warn" && x.fix)) plan.push({ text: i.fix.text, level: "warn" });
    if (modelMoves.length) plan.push({ text: `Move ${modelMoves.map((m) => m.name).join(", ")}`, level: "info" });
    if (live.length) plan.push({ text: `Live-migrate ${live.length} VM${live.length > 1 ? "s" : ""}`, level: "info" });
    if (podsToMove.length) plan.push({ text: `Evict ${podsToMove.length} pod${podsToMove.length > 1 ? "s" : ""}`, level: "info" });
    plan.push({ text: crit ? "Stop: fix what would stop first" : `${subject} is empty, ready to patch`, level: crit ? "crit" : "ok" });
  }

  // The view: what the page draws, with this scenario overlaid.
  const view = twin.nodes.map((n) => nodeView(n, twin, {
    state: gone.has(n.name) ? (fail ? "lost" : "draining") : moves.some((m) => m.to === n.name) ? "receives" : "same",
    incoming: moves.filter((m) => m.to === n.name).map((m) => ({ kind: m.kind, name: m.name, card: m.card?.uuid || null, gpuMiB: m.gpuMiB || null })),
    goneCards: n.cards.filter((c) => goneCards.has(c.uuid)).map((c) => c.uuid),
  }));

  return {
    scenario: { kind, subject }, at: twin.at, cluster: twin.cluster,
    verdict, kpis, impact, checks, plan, moves, view,
    assumptions: ASSUMPTIONS,
  };
}

const ASSUMPTIONS = "Modelled on CPU and memory requests, taints, node selectors, required node affinity and GPU memory per card. Pod affinity, topology spread, storage zones and quotas are not simulated.";

function simulateAdd(twin, sc) {
  const cap = capacity(twin);
  const impact = [], moves = [];
  let subject;
  if (sc.kind === "add-model") {
    const mib = Math.round(Number(sc.gpuGiB) * 1024);
    if (!(mib > 0 && mib <= 1024 * 1024)) throw Object.assign(new Error("Give the model’s GPU memory in GiB"), { status: 400 });
    const count = Math.min(8, Math.max(1, Number(sc.count) || 1));
    const name = String(sc.name || "new-model").slice(0, 63);
    subject = `${name} (${gib(mib)}${count > 1 ? ` × ${count}` : ""})`;
    for (let i = 0; i < count; i++) {
      const item = { cpu: cpuMilli(sc.cpu || "2"), mem: memMiB(`${Number(sc.memGiB) || 16}Gi`), gpus: 1, gpuMem: mib, tolerations: [{ operator: "Exists" }], nodeSelector: {} };
      const to = place(cap, item);
      moves.push({ kind: "model", name: count > 1 ? `${name} #${i + 1}` : name, from: null, to: to?.node || null, card: to?.card || null, gpuMiB: mib, reason: to ? null : why(cap, item) });
    }
    const ok = moves.filter((m) => m.to);
    if (ok.length) impact.push({ level: "ok", title: `${ok.length === moves.length ? "Fits" : `${ok.length} of ${moves.length} fit`}`, text: ok.map((m) => `${m.name} → GPU-${m.card?.index ?? "?"} on ${m.to}`).join(", "), fix: null });
    if (ok.length < moves.length) {
      const asleepRoom = twin.models.filter((m) => !m.asleep && m.gpuMiB).sort((a, b) => a.gpuMiB - b.gpuMiB);
      impact.push({ level: "crit", title: "Does not fit", text: moves.find((m) => !m.to).reason, fix: asleepRoom.length ? { kind: "gpu-room", text: `Turn on auto-sleep for quieter models (${asleepRoom.slice(0, 3).map((m) => m.name).join(", ")}) so room can be made, or add a GPU` } : { kind: "capacity", text: "Add a GPU or a smaller variant of the model" } });
    }
  } else {
    const count = Math.min(500, Math.max(1, Number(sc.count) || 0));
    const cpu = cpuMilli(String(Number(sc.cpu) || 2)), mem = memMiB(`${Number(sc.memGiB) || 4}Gi`);
    subject = `${count} VM${count > 1 ? "s" : ""} of ${cores(cpu)}, ${gib(mem)}`;
    // A VM's launcher asks for a little more than the guest: ~10% overhead.
    const item = { cpu: Math.round(cpu * 1.1), mem: Math.round(mem * 1.1 + 200), gpus: 0, gpuMem: 0, tolerations: [], nodeSelector: {} };
    const per = new Map();
    let fit = 0, reason = null;
    for (let i = 0; i < count; i++) {
      const to = place(cap, item);
      if (!to) { reason = why(cap, item); break; }
      fit++; per.set(to.node, (per.get(to.node) || 0) + 1);
    }
    for (const [node, n] of per) moves.push({ kind: "vm", name: `${n} VM${n > 1 ? "s" : ""}`, from: null, to: node, how: "new" });
    if (fit) impact.push({ level: fit === count ? "ok" : "warn", title: `${fit} of ${count} fit`, text: [...per].map(([n, k]) => `${k} on ${n}`).join(", "), fix: null });
    if (fit < count) impact.push({ level: "crit", title: `${count - fit} do not fit`, text: `the next one: ${reason}`, fix: { kind: "capacity", text: `Add about ${Math.ceil(((count - fit) * item.mem) / 1024)} GiB of memory and ${Math.ceil(((count - fit) * item.cpu) / 1000)} cores, or migrate in waves` } });
    // Headroom left for a node failure.
    const after = [...cap.values()];
    const biggest = Math.max(0, ...twin.nodes.map((n) => n.memReq));
    const spare = after.reduce((a, c) => a + Math.max(0, c.mem), 0);
    if (fit === count) impact.push({ level: spare >= biggest ? "ok" : "warn", title: spare >= biggest ? "Room left for a node failure" : "No room left for a node failure", text: `${gib(spare)} of memory left free; the busiest node uses ${gib(biggest)}`, fix: spare >= biggest ? null : { kind: "capacity", text: "Keep one node’s worth of memory free (N+1)" } });
  }
  const crit = impact.some((i) => i.level === "crit"), warn = impact.some((i) => i.level === "warn");
  return {
    scenario: { kind: sc.kind, subject }, at: twin.at, cluster: twin.cluster,
    verdict: crit ? { level: "crit", title: "Does not fit as it stands", text: "See below for what is missing." }
      : warn ? { level: "warn", title: "Fits, with a caution", text: "It fits, but leaves the cluster tight." }
        : { level: "ok", title: "Fits", text: "There is room, with headroom to spare." },
    kpis: { downtime: "none", moves: moves.filter((m) => m.to).length, cannotMove: moves.filter((m) => !m.to).length, gpusInService: null, powerW: null, minutes: null },
    impact, checks: [{ name: "Scheduler fit", level: crit ? "crit" : warn ? "warn" : "ok" }, ...(sc.kind === "add-model" ? [{ name: "GPU memory per card", level: crit ? "crit" : "ok" }] : [])],
    plan: [], moves,
    view: twin.nodes.map((n) => nodeView(n, twin, { state: moves.some((m) => m.to === n.name) ? "receives" : "same", incoming: moves.filter((m) => m.to === n.name).map((m) => ({ kind: m.kind, name: m.name, card: m.card?.uuid || null, gpuMiB: m.gpuMiB || null })), goneCards: [] })),
    assumptions: ASSUMPTIONS,
  };
}

/** A rolling upgrade drains each worker in turn: each drain is checked on the twin as it is. */
function simulateUpgrade(twin) {
  const workers = twin.nodes.filter((n) => !n.roles.includes("master") && !n.roles.includes("control-plane"));
  const steps = workers.map((n) => ({ node: n.name, r: replay(twin, { kind: "drain", fail: false, gone: new Set([n.name]), goneCards: new Set(), subject: n.name }) }));
  const worst = steps.some((s) => s.r.verdict.level === "crit") ? "crit" : steps.some((s) => s.r.verdict.level === "warn") ? "warn" : "ok";
  const impact = steps.map((s) => ({ level: s.r.verdict.level, title: `${s.node}: ${s.r.verdict.title}`, text: s.r.impact.filter((i) => i.level !== "ok").map((i) => i.title).join("; ") || "drains cleanly", fix: s.r.impact.find((i) => i.fix && i.level !== "ok")?.fix || null }));
  const minutes = Math.round(steps.reduce((a, s) => a + (s.r.kpis.minutes || 1) + 8, 0));   // + reboot and rejoin
  const blocked = steps.filter((s) => s.r.verdict.level === "crit").length, actions = steps.filter((s) => s.r.verdict.level === "warn").length;
  return {
    scenario: { kind: "upgrade", subject: `${workers.length} worker nodes, one at a time` }, at: twin.at, cluster: twin.cluster,
    verdict: worst === "crit" ? { level: "crit", title: `Blocked on ${blocked} node${blocked > 1 ? "s" : ""}`, text: "Those nodes cannot be drained without stopping something. Fix them first." }
      : worst === "warn" ? { level: "warn", title: `Safe with actions on ${actions} node${actions > 1 ? "s" : ""}`, text: "Each node drains without an outage once its actions are done." }
        : { level: "ok", title: "Safe", text: "Every worker drains cleanly in turn." },
    kpis: { downtime: worst === "crit" ? "outage" : "none", minutes, moves: steps.reduce((a, s) => a + s.r.kpis.moves, 0), cannotMove: steps.reduce((a, s) => a + s.r.kpis.cannotMove, 0), gpusInService: null, powerW: null },
    impact, checks: [{ name: `Drain check · ${workers.length} workers`, level: worst }, { name: "Control plane", level: "ok", note: "updated by the Machine Config Operator, one at a time" }],
    plan: steps.map((s) => ({ text: `Drain, update and reboot ${s.node}`, level: s.r.verdict.level === "ok" ? "info" : s.r.verdict.level })),
    moves: [], view: twin.nodes.map((n) => nodeView(n, twin, { state: "same", incoming: [], goneCards: [] })),
    perNode: steps.map((s) => ({ node: s.node, verdict: s.r.verdict, impact: s.r.impact })),
    assumptions: `${ASSUMPTIONS} Each node is checked against the cluster as it is now; the time adds about 8 minutes per node for update and reboot.`,
  };
}

/* ─────────────────────────── service entry points ─────────────────────────── */

export async function run(cluster, sc, { actor = null, fresh = false } = {}) {
  const twin = await snapshot(cluster, { fresh });
  const out = simulate(twin, sc);
  const h = _history.get(cluster) || [];
  h.unshift({ at: new Date(_deps.now()).toISOString(), scenario: out.scenario, verdict: out.verdict.title, level: out.verdict.level, actor });
  _history.set(cluster, h.slice(0, 20));
  return out;
}
export function history(cluster) { return _history.get(cluster) || []; }

/** A plain-text report: for a change request, an export, or AI Chat. */
export function report(out) {
  const L = [];
  L.push(`Ops Twin — what if: ${SCENARIOS.find((s) => s.id === out.scenario.kind)?.label || out.scenario.kind} (${out.scenario.subject})`);
  L.push(`Cluster: ${out.cluster} · twin read ${out.at}`);
  L.push("", `Verdict: ${out.verdict.title}. ${out.verdict.text}`);
  const k = out.kpis;
  L.push(`Expected downtime: ${k.downtime}${k.minutes ? ` · about ${k.minutes} min` : ""} · moves: ${k.moves}${k.cannotMove ? ` · cannot move: ${k.cannotMove}` : ""}${k.gpusInService ? ` · GPUs in service: ${k.gpusInService}` : ""}${k.powerW != null ? ` · GPU power: ${k.powerW} W` : ""}`);
  if (out.impact.length) { L.push("", "Expected impact:"); for (const i of out.impact) L.push(`- [${i.level === "ok" ? "OK" : i.level === "warn" ? "ACTION" : "STOPS"}] ${i.title}: ${i.text}${i.fix ? ` → Fix: ${i.fix.text}` : ""}`); }
  if (out.plan?.length) { L.push("", "Plan:"); out.plan.forEach((p, n) => L.push(`${n + 1}. ${p.text}`)); }
  L.push("", `Checked: ${out.checks.map((c) => `${c.name} (${c.level})`).join(", ")}`);
  L.push("", `Model limits: ${out.assumptions}`);
  return L.join("\n");
}

/**
 * "Ask the twin": turn a short question into a scenario. Deliberately simple
 * and predictable — node, rack and GPU names come from the twin itself.
 */
export function parseQuestion(twin, q) {
  const s = String(q || "").toLowerCase();
  const node = twin.nodes.map((n) => n.name).sort((a, b) => b.length - a.length).find((n) => s.includes(n.toLowerCase()));
  const rack = Object.keys(twin.racks).filter((r) => r !== "Unassigned").find((r) => new RegExp(`\\brack\\s*${r.toLowerCase().replace(/[^a-z0-9]/g, ".?")}\\b|\\b${r.toLowerCase()}\\b`).test(s));
  const gpu = s.match(/\bgpu[-\s#]?(\d+)\b/);
  const gibM = s.match(/(\d+(?:\.\d+)?)\s*(gib|gb|g)\b/);
  if (/\bupgrad/.test(s)) return { kind: "upgrade" };
  if (/\b(migrat|move|bring)\b.*\bvms?\b|\bvms?\b.*\b(fit|add|migrat)/.test(s)) {
    const count = Number(s.match(/(\d+)\s*vms?/)?.[1]) || 10;
    const cpu = Number(s.match(/(\d+)\s*(v?cpus?|cores?)/)?.[1]) || 2;
    return { kind: "add-vms", count, cpu, memGiB: gibM ? Number(gibM[1]) : 8 };
  }
  if (/\b(add|deploy|fit|run)\b.*\bmodel\b|\bmodel\b.*\b(fit|add)/.test(s) && gibM) return { kind: "add-model", gpuGiB: Number(gibM[1]) };
  if (rack && /\b(power|rack|lose|loses|down|fail)/.test(s)) return { kind: "rack-fail", rack };
  if (gpu && node) {
    const card = twin.nodes.find((n) => n.name === node).cards.find((c) => String(c.index) === gpu[1] || String(c.index + 1) === gpu[1]);
    if (card) return { kind: "gpu-fail", node, card: card.uuid };
  }
  if (node && /\b(fail|fails|crash|dies|goes down|go down|lose|lost|power)\b/.test(s)) return { kind: "node-fail", node };
  if (node) return { kind: "drain", node };
  return null;
}
