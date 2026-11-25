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
  usage: null,                            // async () → { "ns/pod": { cpu: milli, mem: MiB } } (p95) or null
  store: null,                            // { get(key), set(key, value) } for accuracy and resilience records
  notify: null,                           // ({ type, title, message, severity }) → void
  now: () => Date.now(),
};
export function configureOpsTwin(deps) { _deps = { ..._deps, ...deps }; }

const _cache = new Map();                 // cluster → { at, twin }
const _history = new Map();               // cluster → [{ at, scenario, verdict, actor }]
export function _resetOpsTwin() { _cache.clear(); _history.clear(); _state = null; }

/* Records kept across restarts: predictions (for accuracy) and resilience scores. */
const STATE_KEY = "ops_twin_state";
let _state = null;
async function loadState() {
  if (_state) return _state;
  let v = null;
  try { v = await _deps.store?.get(STATE_KEY); } catch { /* none */ }
  _state = { predictions: [], resilience: {}, ...(v && typeof v === "object" ? v : {}) };
  return _state;
}
async function saveState() { try { await _deps.store?.set(STATE_KEY, _state); } catch { /* memory only */ } }

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
      pvcs: (p.spec?.volumes || []).filter((v) => v.persistentVolumeClaim?.claimName).map((v) => v.persistentVolumeClaim.claimName),
      antiAffinity: (p.spec?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution || []).map((t) => ({ selector: t.labelSelector || null, topologyKey: t.topologyKey || "kubernetes.io/hostname", namespaces: t.namespaces || null })),
      spread: (p.spec?.topologySpreadConstraints || []).filter((t) => (t.whenUnsatisfiable || "DoNotSchedule") === "DoNotSchedule").map((t) => ({ selector: t.labelSelector || null, topologyKey: t.topologyKey, maxSkew: t.maxSkew || 1 })),
      sa: p.spec?.serviceAccountName || "default",
      privileged: (p.spec?.containers || []).some((c) => c.securityContext?.privileged) || !!p.spec?.hostNetwork || !!p.spec?.hostPID || (p.spec?.volumes || []).some((v) => v.hostPath),
      secrets: [...new Set((p.spec?.volumes || []).filter((v) => v.secret?.secretName).map((v) => v.secret.secretName))],
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
  // Sites (zones, data centres) for site-failure and DR scenarios.
  const siteKeys = (process.env.OPS_TWIN_SITE_LABEL ? [process.env.OPS_TWIN_SITE_LABEL] : []).concat(["tcs.io/site", "topology.kubernetes.io/zone", "topology.kubernetes.io/region"]);
  const sites = {};
  for (const n of nodes) { const k = siteKeys.find((x) => n.labels[x]); n.site = k ? n.labels[k] : null; if (n.site) (sites[n.site] ||= []).push(n.name); }
  // Storage: which nodes each claimed volume can attach to.
  const pvByName = new Map((raw.pvs || []).map((v) => [v.metadata.name, v]));
  const volumes = {};
  for (const c of raw.pvcs || []) {
    const pv = pvByName.get(c.spec?.volumeName);
    const terms = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms || null;
    volumes[`${c.metadata.namespace}/${c.metadata.name}`] = {
      pv: pv?.metadata?.name || null, terms, local: !!(pv?.spec?.local || pv?.spec?.hostPath),
      rwo: (c.spec?.accessModes || []).every((m) => m === "ReadWriteOnce" || m === "ReadWriteOncePod"),
      storageClass: c.spec?.storageClassName || null,
    };
  }
  // Namespace quotas: hard limits and what is used, for requests.cpu / requests.memory / pods.
  const quotas = {};
  for (const q of raw.quotas || []) {
    const h = q.status?.hard || q.spec?.hard || {}, u = q.status?.used || {};
    const ns = q.metadata.namespace;
    const cur = (quotas[ns] ||= { cpu: null, mem: null, pods: null });
    const pick = (keys, conv) => { const k = keys.find((x) => h[x] != null); return k ? { hard: conv(h[k]), used: conv(u[k] || 0) } : null; };
    cur.cpu = pick(["requests.cpu", "cpu"], cpuMilli) || cur.cpu;
    cur.mem = pick(["requests.memory", "memory"], memMiB) || cur.mem;
    cur.pods = pick(["pods", "count/pods"], (x) => Number(x) || 0) || cur.pods;
  }
  // Real usage (95th percentile, when Prometheus answers): per pod, and per node.
  const usage = raw.usage || null;
  if (usage) {
    for (const n of nodes) { n.cpuUsed = 0; n.memUsed = 0; }
    for (const pd of pods) { const u = usage[`${pd.ns}/${pd.name}`]; const n = byNode.get(pd.node); if (u && n) { n.cpuUsed += u.cpu || 0; n.memUsed += u.mem || 0; pd.usage = u; } }
  }
  const saBindings = raw.saBindings || [];
  const powerKnown = nodes.some((n) => n.cards.some((c) => c.powerW != null));
  return { cluster, at, nodes, pods, vms, models, pdbs, racks, sites, volumes, quotas, usageKnown: !!usage, saBindings, powerKnown, racksKnown: nodes.some((n) => n.rack) };
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
  const [nodes, pods, pdbs, vmis, vms, isvcs, pvcs, pvs, quotas, crbs, rbs] = await Promise.all([
    list("/api/v1/nodes"),
    list("/api/v1/pods?limit=5000"),
    list("/apis/policy/v1/poddisruptionbudgets"),
    list("/apis/kubevirt.io/v1/virtualmachineinstances"),
    list("/apis/kubevirt.io/v1/virtualmachines"),
    list("/apis/serving.kserve.io/v1beta1/inferenceservices"),
    list("/api/v1/persistentvolumeclaims"),
    list("/api/v1/persistentvolumes"),
    list("/api/v1/resourcequotas"),
    list("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings"),
    list("/apis/rbac.authorization.k8s.io/v1/rolebindings"),
  ]);
  // Which roles service accounts hold (for blast radius), without the rest of RBAC.
  const saBindings = [];
  for (const b of [...(crbs || []).map((x) => ({ ...x, cl: true })), ...(rbs || [])]) for (const sub of b.subjects || []) if (sub.kind === "ServiceAccount") saBindings.push({ ns: sub.namespace, sa: sub.name, role: b.roleRef?.name, scope: b.cl ? "cluster" : b.metadata?.namespace });
  let usage = null;
  try { usage = await _deps.usage?.(); } catch { /* optional */ }
  if (nodes === null || pods === null) throw Object.assign(new Error("Could not read nodes and pods from this cluster"), { status: 502 });
  let telemetry = null;
  try { telemetry = await _deps.gpuTelemetry(); } catch { /* optional */ }
  const twin = buildTwin({ nodes, pods, pdbs: pdbs || [], vmis: vmis || [], vms: vms || [], isvcs: isvcs || [], telemetry: telemetry || [], pvcs: pvcs || [], pvs: pvs || [], quotas: quotas || [], usage, saBindings },
    { cluster, at: new Date(_deps.now()).toISOString() });
  twin.sources = { kubernetes: true, pdbs: pdbs !== null, virtualization: vmis !== null, models: isvcs !== null, gpuTelemetry: !!(telemetry && telemetry.length), storage: pvcs !== null && pvs !== null, quotas: quotas !== null, usage: !!usage };
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
  { id: "site-fail", label: "Site or zone fails", hint: "data centre, availability zone", needs: ["site"] },
  { id: "peak", label: "Peak load", hint: "sale day, month-end, ×N traffic", needs: ["namespaces", "factor"] },
  { id: "window", label: "Maintenance window", hint: "patch every node in N hours", needs: ["windowHours"] },
  { id: "retire", label: "Retire nodes", hint: "cost and power saving", needs: ["nodes"] },
  { id: "blast", label: "Security blast radius", hint: "compromised node or account", needs: ["node|serviceAccount"] },
];

/** Working copy of capacity: free CPU/memory per node, free MiB per card. */
function capacity(twin, gone = new Set(), goneCards = new Set()) {
  const cap = new Map();
  cap.twin = twin;
  cap.gone = gone;
  cap.quota = JSON.parse(JSON.stringify(twin.quotas || {}));
  for (const n of twin.nodes) {
    if (gone.has(n.name)) continue;
    cap.set(n.name, {
      node: n, cpu: n.cpuAlloc - n.cpuReq, mem: n.memAlloc - n.memReq,
      pods: twin.pods.filter((p) => p.node === n.name).map((p) => ({ ns: p.ns, labels: p.labels })),
      cards: n.cards.filter((c) => !goneCards.has(c.uuid)).map((c) => ({ uuid: c.uuid, index: c.index, free: c.totalMiB - c.slices.reduce((a, s) => a + s.mib, 0), total: c.totalMiB, hami: c.hami })),
    });
  }
  return cap;
}


/* ─────────────── placement rules beyond CPU and memory ─────────────── */

const domainOf = (node, key) => (key === "kubernetes.io/hostname" ? node.labels?.[key] || node.name : node.labels?.[key] ?? null);

/** Storage, required pod anti-affinity and topology spread (DoNotSchedule). */
function rulesAllow(cap, c, item) {
  const twin = cap.twin;
  // Volumes that can only attach to some nodes (local disks, zonal storage).
  for (const claim of item.pvcs || []) {
    const v = twin?.volumes?.[`${item.ns}/${claim}`];
    if (!v) continue;
    if (v.local && item.node && cap.gone?.has(item.node)) return false;
    if (v.terms?.length && !v.terms.some((t) => (t.matchExpressions || []).every((e) => matchExpr(c.node.labels, e)))) return false;
  }
  // Required anti-affinity: no matching pod already in the same domain.
  for (const t of item.antiAffinity || []) {
    if (!t.selector) continue;
    const dom = domainOf(c.node, t.topologyKey);
    if (dom == null) continue;
    for (const other of cap.values()) {
      if (domainOf(other.node, t.topologyKey) !== dom) continue;
      if (other.pods.some((p) => (t.namespaces ? t.namespaces.includes(p.ns) : p.ns === item.ns) && selectorMatches(t.selector, p.labels))) return false;
    }
  }
  // Topology spread: placing here must keep the skew within maxSkew.
  for (const t of item.spread || []) {
    if (!t.selector || !t.topologyKey) continue;
    const counts = new Map();
    for (const other of cap.values()) {
      if (!nodeAccepts(other.node, item)) continue;
      const d = domainOf(other.node, t.topologyKey);
      if (d == null) continue;
      counts.set(d, (counts.get(d) || 0) + other.pods.filter((p) => p.ns === item.ns && selectorMatches(t.selector, p.labels)).length);
    }
    const dom = domainOf(c.node, t.topologyKey);
    if (dom == null || !counts.size) continue;
    const min = Math.min(...counts.values());
    if ((counts.get(dom) || 0) + 1 - min > t.maxSkew) return false;
  }
  return true;
}

/** Why storage alone blocks an item, or null. */
function volumeBlock(cap, item) {
  for (const claim of item.pvcs || []) {
    const v = cap.twin?.volumes?.[`${item.ns}/${claim}`];
    if (!v) continue;
    if (v.local && item.node && cap.gone?.has(item.node)) return `its data is on a local volume (${claim}) of the node that is gone`;
    if (v.terms?.length && ![...cap.values()].some((c) => v.terms.some((t) => (t.matchExpressions || []).every((e) => matchExpr(c.node.labels, e))))) return `its volume ${claim} can only attach to nodes that are gone (zonal or local storage)`;
  }
  return null;
}

/** A new pod (scale-up, new workload) must fit its namespace quota. */
function quotaAllows(cap, item, { dry = false } = {}) {
  const q = cap.quota?.[item.ns];
  if (!q) return true;
  if (q.cpu && q.cpu.used + item.cpu > q.cpu.hard) return false;
  if (q.mem && q.mem.used + item.mem > q.mem.hard) return false;
  if (q.pods && q.pods.used + 1 > q.pods.hard) return false;
  if (!dry) { if (q.cpu) q.cpu.used += item.cpu; if (q.mem) q.mem.used += item.mem; if (q.pods) q.pods.used += 1; }
  return true;
}

/** Place one item; returns { node, card } or null. Picks the node with the most memory left (spread). */
function place(cap, item, { exclude = new Set() } = {}) {
  let best = null;
  for (const [name, c] of cap) {
    if (exclude.has(name)) continue;
    if (!nodeAccepts(c.node, item)) continue;
    if (c.cpu < item.cpu || c.mem < item.mem) continue;
    if (!rulesAllow(cap, c, item)) continue;
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
  if (item.newPod && !quotaAllows(cap, item)) return null;
  best.c.cpu -= item.cpu; best.c.mem -= item.mem;
  best.c.pods.push({ ns: item.ns, labels: item.labels || {} });
  if (best.card) best.card.free -= item.gpuMem > 0 ? item.gpuMem : best.card.total;
  return { node: best.name, card: best.card ? { uuid: best.card.uuid, index: best.card.index } : null };
}

const why = (cap, item) => {
  const nodes = [...cap.values()];
  if (item.newPod && !quotaAllows(cap, item, { dry: true })) return `the ${item.ns} namespace quota is used up`;
  const vol = volumeBlock(cap, item);
  if (vol) return vol;
  const ok = nodes.filter((c) => nodeAccepts(c.node, item));
  if (!ok.length) return "no remaining node accepts it (taints, node selector or affinity)";
  const fitting = ok.filter((c) => c.cpu >= item.cpu && c.mem >= item.mem);
  if (fitting.length && !fitting.some((c) => rulesAllow(cap, c, item))) return "its spreading rules (pod anti-affinity or topology spread) allow none of the nodes with room";
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
  if (kind === "upgrade" || kind === "window") return simulateUpgrade(twin, sc);
  if (kind === "add-model" || kind === "add-vms") return simulateAdd(twin, sc);
  if (kind === "peak") return simulatePeak(twin, sc);
  if (kind === "retire") return simulateRetire(twin, sc);
  if (kind === "blast") return simulateBlast(twin, sc);
  const critical = criticalSet(sc.critical);

  const fail = kind === "node-fail" || kind === "rack-fail" || kind === "site-fail";
  let gone = new Set(), goneCards = new Set(), subject;
  if (kind === "drain" || kind === "node-fail") {
    const n = twin.nodes.find((x) => x.name === sc.node);
    if (!n) throw Object.assign(new Error(`No node called ${sc.node} in this cluster`), { status: 400 });
    gone.add(n.name); subject = n.name;
  } else if (kind === "rack-fail") {
    const names = twin.racks[sc.rack];
    if (!names?.length || sc.rack === "Unassigned") throw Object.assign(new Error(`No rack called ${sc.rack}. Label nodes with tcs.io/rack to group them`), { status: 400 });
    gone = new Set(names); subject = `rack ${sc.rack}`;
  } else if (kind === "site-fail") {
    const names = twin.sites?.[sc.site];
    if (!names?.length) throw Object.assign(new Error(`No site or zone called ${sc.site}. Nodes are grouped by tcs.io/site or topology.kubernetes.io/zone`), { status: 400 });
    gone = new Set(names); subject = `site ${sc.site}`;
  } else if (kind === "gpu-fail") {
    const n = twin.nodes.find((x) => x.name === sc.node);
    const card = n?.cards.find((c) => c.uuid === sc.card || String(c.index) === String(sc.card));
    if (!card) throw Object.assign(new Error("Pick a GPU card on that node"), { status: 400 });
    goneCards.add(card.uuid); subject = `GPU-${card.index} on ${n.name}`;
  }
  return replay(twin, { kind, fail, gone, goneCards, subject, critical });
}

/** Critical namespaces: exact names or prefixes ending in *. */
function criticalSet(list) {
  const items = (Array.isArray(list) ? list : String(list || "").split(",")).map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
  return (ns) => items.some((i) => (i.endsWith("*") ? ns.startsWith(i.slice(0, -1)) : ns === i));
}

function replay(twin, { kind, fail, gone, goneCards, subject, critical = () => false }) {
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
    c.pods = c.pods.filter((x) => !(x.ns === p.ns && x.labels === p.labels));
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
  const plat = singles.filter((s) => s.platform), crit1 = singles.filter((s) => !s.platform && critical(s.ns)), apps = singles.filter((s) => !s.platform && !critical(s.ns));
  if (crit1.length) {
    outages += crit1.length;
    impact.push({ level: "crit", title: `${crit1.length} critical app${crit1.length > 1 ? "s" : ""} would be down`, text: `${crit1.slice(0, 8).map((s) => `${s.ns}/${s.name}`).join(", ")}: a single replica on the lost capacity ${fail ? "is down until rescheduled" : "is down while it restarts"}`, fix: { kind: "scale", text: "Run at least 2 replicas of every critical app, spread across nodes", targets: crit1.map((s) => `${s.ns}/${s.kind}/${s.name}`) } });
  }
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

  // ── real usage on the nodes that receive work ──
  if (twin.usageKnown) {
    const hot = [];
    for (const n of twin.nodes.filter((x) => !gone.has(x.name))) {
      const add = moves.filter((m) => m.to === n.name && m.kind !== "vm").map((m) => twin.pods.find((p) => p.ns === m.ns && (p.name === m.name || p.model === m.name))?.usage).filter(Boolean);
      if (!add.length) continue;
      const cpu = (n.cpuUsed || 0) + add.reduce((a, u) => a + (u.cpu || 0), 0), mem = (n.memUsed || 0) + add.reduce((a, u) => a + (u.mem || 0), 0);
      const cp = n.cpuAlloc ? Math.round((cpu / n.cpuAlloc) * 100) : 0, mp = n.memAlloc ? Math.round((mem / n.memAlloc) * 100) : 0;
      if (cp > 85 || mp > 85) hot.push(`${n.name} (${cp}% CPU, ${mp}% memory)`);
    }
    if (hot.length) impact.push({ level: "warn", title: `By real usage, ${hot.length} node${hot.length > 1 ? "s" : ""} would run hot`, text: `${hot.join(", ")}: requests fit, but measured use (95th percentile, 7 days) goes above 85%`, fix: { kind: "capacity", text: "Spread the move, or add capacity before the change" } });
    checks.push({ name: "Real usage", level: hot.length ? "warn" : "ok" });
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

const ASSUMPTIONS = "Modelled on CPU and memory requests, taints, node selectors, required node affinity, required pod anti-affinity, topology spread (DoNotSchedule), volumes that attach only to some nodes, namespace quotas for new pods, and GPU memory per card; real usage (95th percentile over 7 days) where Prometheus answers. Preferred (soft) rules, network and storage throughput are not simulated.";

function simulateAdd(twin, sc) {
  const cap = capacity(twin);
  const impact = [], moves = [];
  let sizing = null;
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
    sizing = { nodesNeeded: nodesFor(twin, (count - fit) * item.cpu, (count - fit) * item.mem), withSpare: nodesFor(twin, (count - fit) * item.cpu, (count - fit) * item.mem) + 1, vmsPerNode: Math.max(1, Math.floor(Math.min(workerShape(twin).cpu / item.cpu, workerShape(twin).mem / item.mem))) };
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
    kpis: { downtime: "none", moves: moves.filter((m) => m.to).length, cannotMove: moves.filter((m) => !m.to).length, gpusInService: null, powerW: null, minutes: null, ...(sizing ? { nodesNeeded: sizing.withSpare } : {}) },
    sizing,
    impact, checks: [{ name: "Scheduler fit", level: crit ? "crit" : warn ? "warn" : "ok" }, ...(sc.kind === "add-model" ? [{ name: "GPU memory per card", level: crit ? "crit" : "ok" }] : [])],
    plan: [], moves,
    view: twin.nodes.map((n) => nodeView(n, twin, { state: moves.some((m) => m.to === n.name) ? "receives" : "same", incoming: moves.filter((m) => m.to === n.name).map((m) => ({ kind: m.kind, name: m.name, card: m.card?.uuid || null, gpuMiB: m.gpuMiB || null })), goneCards: [] })),
    assumptions: ASSUMPTIONS,
  };
}

/** A rolling upgrade drains each worker in turn: each drain is checked on the twin as it is. */
function simulateUpgrade(twin, sc = {}) {
  const critical = criticalSet(sc.critical);
  const workers = twin.nodes.filter((n) => !n.roles.includes("master") && !n.roles.includes("control-plane"));
  const steps0 = workers.map((n) => ({ node: n.name, r: replay(twin, { kind: "drain", fail: false, gone: new Set([n.name]), goneCards: new Set(), subject: n.name, critical }) }));
  // Clean nodes first, then those needing actions, blocked last: the window is used where it is safe.
  const rank = { ok: 0, warn: 1, crit: 2 };
  const steps = sc.kind === "window" ? [...steps0].sort((a, b) => rank[a.r.verdict.level] - rank[b.r.verdict.level]) : steps0;
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
    ...(sc.kind === "window" ? windowPlan(steps, sc) : {}),
  };
}

/** Fit the node-by-node drains into a maintenance window. */
function windowPlan(steps, sc) {
  const hours = Math.min(48, Math.max(1, Number(sc.windowHours) || 4));
  const per = Math.min(120, Math.max(3, Number(sc.rebootMinutes) || 8));
  const start = sc.start && Date.parse(sc.start) ? Date.parse(sc.start) : null;
  let t = 0;
  const schedule = [];
  for (const s of steps) {
    const mins = Math.round((s.r.kpis.minutes || 1) + per);
    const blocked = s.r.verdict.level === "crit";
    schedule.push({ node: s.node, from: t, to: t + (blocked ? 0 : mins), minutes: blocked ? 0 : mins, inWindow: !blocked && t + mins <= hours * 60, level: s.r.verdict.level, note: s.r.verdict.title, at: start ? new Date(start + t * 60000).toISOString() : null });
    if (!blocked) t += mins;
  }
  const fit = schedule.filter((x) => x.inWindow).length, todo = schedule.filter((x) => x.level !== "crit").length;
  const windows = Math.max(1, Math.ceil(t / (hours * 60)));
  return {
    scenario: { kind: "window", subject: `${steps.length} worker nodes in a ${hours} h window` },
    window: { hours, perNodeMinutes: per, totalMinutes: t, fits: fit === todo, nodesInWindow: fit, windowsNeeded: windows, schedule },
    verdict: schedule.some((x) => x.level === "crit")
      ? { level: "crit", title: `${schedule.filter((x) => x.level === "crit").length} node(s) cannot be patched as things stand`, text: `${fit} of ${todo} patchable nodes fit in the ${hours} h window.` }
      : fit === todo ? { level: steps.some((s) => s.r.verdict.level === "warn") ? "warn" : "ok", title: `All ${todo} nodes fit in the ${hours} h window`, text: `About ${Math.round(t / 6) / 10} h of work, in the order below.` }
        : { level: "warn", title: `${fit} of ${todo} nodes fit in the ${hours} h window`, text: `The rest needs ${windows - 1} more window${windows > 2 ? "s" : ""} of ${hours} h.` },
    plan: schedule.map((x) => ({ text: `${x.at ? `${x.at.slice(11, 16)} ` : `+${Math.floor(x.from / 60)}:${String(x.from % 60).padStart(2, "0")} `}${x.node}${x.level === "crit" ? ": blocked" : `: ${x.minutes} min`}${x.inWindow || x.level === "crit" ? "" : " (next window)"}`, level: x.level === "crit" ? "crit" : x.inWindow ? (x.level === "warn" ? "warn" : "info") : "warn" })),
  };
}

/* ─────────────────────────── more scenarios ─────────────────────────── */

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
function workerShape(twin) {
  const w = twin.nodes.filter((n) => !n.roles.includes("master") && !n.roles.includes("control-plane"));
  return { cpu: median(w.map((n) => n.cpuAlloc)) || 1, mem: median(w.map((n) => n.memAlloc)) || 1, count: w.length };
}
const nodesFor = (twin, cpu, mem) => { const sh = workerShape(twin); return Math.max(0, Math.ceil(Math.max(cpu / sh.cpu, mem / sh.mem))); };

/** Peak load: extra replicas of every workload in the chosen namespaces. */
function simulatePeak(twin, sc) {
  const factor = Number(sc.factor);
  if (!(factor > 1 && factor <= 10)) throw Object.assign(new Error("Give a load factor between 1.1 and 10 (e.g. 3 for ×3)"), { status: 400 });
  const pick = criticalSet(sc.namespaces);
  const groups = new Map();
  for (const p of twin.pods.filter((x) => x.owner && ["Deployment", "StatefulSet", "ReplicaSet"].includes(x.owner.kind) && !x.daemon && pick(x.ns))) {
    const k = `${p.ns}/${p.owner.kind}/${p.owner.name}`;
    if (!groups.has(k)) groups.set(k, { sample: p, n: 0 });
    groups.get(k).n++;
  }
  if (!groups.size) throw Object.assign(new Error("No Deployments or StatefulSets in those namespaces"), { status: 400 });
  const cap = capacity(twin);
  const impact = [], moves = [];
  let missCpu = 0, missMem = 0, extra = 0, unplaced = 0;
  const short = [], quotaHit = new Set();
  for (const g of [...groups.values()].sort((a, b) => b.sample.mem - a.sample.mem)) {
    const add = Math.ceil(g.n * factor) - g.n;
    let miss = 0;
    for (let i = 0; i < add; i++) {
      const item = { ...g.sample, newPod: true, node: null };
      const to = place(cap, item);
      extra++;
      if (to) moves.push({ kind: "pod", name: `${g.sample.owner.name} +${i + 1}`, workload: g.sample.owner.name, ns: g.sample.ns, from: null, to: to.node });
      else { miss++; unplaced++; missCpu += item.cpu; missMem += item.mem; if (!quotaAllows(cap, item, { dry: true })) quotaHit.add(item.ns); }
    }
    if (miss) short.push(`${g.sample.ns}/${g.sample.owner.name} (${miss} of ${add})`);
  }
  // Real usage scaled by the factor, on the busiest nodes.
  const hot = [];
  if (twin.usageKnown) for (const n of twin.nodes) {
    const mine = twin.pods.filter((p) => p.node === n.name && pick(p.ns) && p.usage);
    if (!mine.length) continue;
    const cpu = (n.cpuUsed || 0) + mine.reduce((a, p) => a + p.usage.cpu * (factor - 1), 0);
    const pct = n.cpuAlloc ? Math.round((cpu / n.cpuAlloc) * 100) : 0;
    if (pct > 85) hot.push(`${n.name} ${pct}% CPU`);
  }
  const need = nodesFor(twin, missCpu, missMem);
  if (moves.length) impact.push({ level: "ok", title: `${moves.length} of ${extra} extra replicas fit`, text: `across ${[...new Set(moves.map((m) => m.to))].length} nodes`, fix: null });
  if (unplaced) impact.push({ level: "crit", title: `${unplaced} extra replicas do not fit`, text: `${short.slice(0, 8).join(", ")}${short.length > 8 ? "…" : ""}`, fix: { kind: "capacity", text: `Add about ${need + 1} worker node${need + 1 > 1 ? "s" : ""} of the usual size (${need} for the load, 1 to survive a node failure), or raise the limits` } });
  if (quotaHit.size) impact.push({ level: "warn", title: "Namespace quotas stop the scale-up", text: [...quotaHit].join(", "), fix: { kind: "quota", text: "Raise the quota for the peak period" } });
  if (hot.length) impact.push({ level: "warn", title: "By real usage, these nodes would run hot", text: hot.join(", "), fix: { kind: "capacity", text: "Add capacity or spread the busiest apps" } });
  const crit = unplaced > 0;
  return {
    scenario: { kind: "peak", subject: `×${factor} on ${groups.size} workload${groups.size === 1 ? "" : "s"}` }, at: twin.at, cluster: twin.cluster,
    verdict: crit ? { level: "crit", title: `Not ready for ×${factor}`, text: `${unplaced} replicas have nowhere to run; about ${need} more node${need === 1 ? "" : "s"} needed.` }
      : hot.length || quotaHit.size ? { level: "warn", title: `Fits ×${factor}, with cautions`, text: "Requests fit, but see below." } : { level: "ok", title: `Ready for ×${factor}`, text: "Every extra replica fits." },
    kpis: { downtime: crit ? "outage" : "none", moves: moves.length, cannotMove: unplaced, nodesNeeded: need, gpusInService: null, powerW: null, minutes: null },
    impact, checks: [{ name: `Scheduler fit · ${extra} extra replicas`, level: crit ? "crit" : "ok" }, { name: "Namespace quotas", level: quotaHit.size ? "warn" : "ok" }, ...(twin.usageKnown ? [{ name: "Real usage ×factor", level: hot.length ? "warn" : "ok" }] : [])],
    plan: [], moves,
    view: twin.nodes.map((n) => nodeView(n, twin, { state: moves.some((m) => m.to === n.name) ? "receives" : "same", incoming: moves.filter((m) => m.to === n.name).map((m) => ({ kind: "pod", name: m.name })), goneCards: [] })),
    assumptions: `${ASSUMPTIONS} Peak load is modelled as extra replicas of each workload in the chosen namespaces, with the same requests.`,
  };
}

/** Retire nodes: drain them all at once, and what it saves. */
function simulateRetire(twin, sc) {
  const names = (Array.isArray(sc.nodes) ? sc.nodes : String(sc.nodes || "").split(",")).map((x) => String(x).trim()).filter(Boolean);
  const gone = new Set(names.filter((n) => twin.nodes.some((x) => x.name === n)));
  if (!gone.size) throw Object.assign(new Error("Pick the nodes to retire"), { status: 400 });
  const out = replay(twin, { kind: "drain", fail: false, gone, goneCards: new Set(), subject: `${gone.size} node${gone.size > 1 ? "s" : ""}`, critical: criticalSet(sc.critical) });
  const nodeW = Number(process.env.OPS_TWIN_NODE_WATTS) || 350;
  const gpuW = twin.nodes.filter((n) => gone.has(n.name)).flatMap((n) => n.cards).reduce((a, c) => a + (c.powerW || 0), 0);
  const watts = gone.size * nodeW + gpuW;
  const kwhMonth = Math.round((watts * 730) / 1000);
  const perNode = Number(process.env.OPS_TWIN_NODE_COST_MONTH) || 0, kwhPrice = Number(process.env.OPS_TWIN_KWH_PRICE) || 0;
  const currency = process.env.OPS_TWIN_CURRENCY || "";
  const money = perNode || kwhPrice ? Math.round(gone.size * perNode + kwhMonth * kwhPrice) : null;
  out.scenario = { kind: "retire", subject: [...gone].join(", ") };
  out.savings = { nodes: gone.size, watts, kwhMonth, money, currency, basis: `${nodeW} W per node${gpuW ? ` + ${Math.round(gpuW)} W of GPUs measured` : ""}${perNode ? `, ${perNode} per node per month` : ""}${kwhPrice ? `, ${kwhPrice} per kWh` : ""}` };
  out.impact.unshift({ level: "ok", title: `Saves about ${kwhMonth} kWh a month${money != null ? ` and ${currency}${money.toLocaleString()} a month` : ""}`, text: out.savings.basis + (money == null ? ". Set OPS_TWIN_NODE_COST_MONTH or OPS_TWIN_KWH_PRICE to see money." : ""), fix: null });
  if (out.verdict.level === "ok") out.verdict = { level: "ok", title: `Safe to retire ${gone.size} node${gone.size > 1 ? "s" : ""}`, text: "Everything on them fits on the remaining nodes." };
  return out;
}

/** Security blast radius: what a compromised node or service account can reach. Read-only. */
function simulateBlast(twin, sc) {
  const impact = [], plan = [];
  let subject, crit = 0;
  const rolesOf = (ns, sa) => (twin.saBindings || []).filter((b) => b.ns === ns && b.sa === sa);
  const strong = (r) => ["cluster-admin", "admin", "edit"].includes(r.role) || /admin/.test(r.role || "");
  if (sc.node) {
    const n = twin.nodes.find((x) => x.name === sc.node);
    if (!n) throw Object.assign(new Error(`No node called ${sc.node}`), { status: 400 });
    subject = `node ${n.name}`;
    const pods = twin.pods.filter((p) => p.node === n.name);
    const sas = [...new Set(pods.map((p) => `${p.ns}/${p.sa}`))];
    const priv = pods.filter((p) => p.privileged);
    const secrets = pods.reduce((a, p) => a + (p.secrets?.length || 0), 0);
    const elevated = sas.flatMap((k) => { const [ns, sa] = k.split("/"); return rolesOf(ns, sa).filter(strong).map((r) => `${k} → ${r.role} ${r.scope === "cluster" ? "cluster-wide" : `in ${r.scope}`}`); });
    impact.push({ level: "warn", title: `${pods.length} pods in ${new Set(pods.map((p) => p.ns)).size} namespaces run here`, text: `${sas.length} service accounts' tokens and ${secrets} mounted secrets are readable from the node`, fix: null });
    if (elevated.length) { crit += elevated.some((e) => /cluster-admin|cluster-wide/.test(e)) ? 1 : 0; impact.push({ level: elevated.some((e) => /cluster-admin/.test(e)) ? "crit" : "warn", title: `${elevated.length} powerful service account${elevated.length > 1 ? "s" : ""} reachable`, text: elevated.slice(0, 8).join("; "), fix: { kind: "rbac", text: "Reduce those roles, or keep these workloads off shared nodes" } }); }
    if (priv.length) impact.push({ level: "warn", title: `${priv.length} privileged or host-level pod${priv.length > 1 ? "s" : ""}`, text: priv.slice(0, 6).map((p) => `${p.ns}/${p.name}`).join(", "), fix: { kind: "scc", text: "Review why they need host access (SCC)" } });
    if (n.cards.length) impact.push({ level: "warn", title: `${n.cards.length} GPU${n.cards.length > 1 ? "s" : ""} and their models`, text: "model weights and prompts in memory on this node", fix: null });
    plan.push({ text: `Cordon ${n.name} and drain it (see "Drain a node" for the impact)`, level: "info" }, { text: `Rotate tokens of the ${sas.length} service accounts that ran here`, level: "warn" }, { text: "Rotate the secrets mounted here", level: "warn" }, { text: "Rebuild the node from a clean image before it rejoins", level: "info" });
  } else {
    const [ns, sa] = String(sc.serviceAccount || "").split("/");
    if (!ns || !sa) throw Object.assign(new Error("Give a node, or a service account as namespace/name"), { status: 400 });
    subject = `service account ${ns}/${sa}`;
    const roles = rolesOf(ns, sa);
    const pods = twin.pods.filter((p) => p.ns === ns && p.sa === sa);
    const clusterWide = roles.filter((r) => r.scope === "cluster");
    const nsReach = [...new Set(roles.filter((r) => r.scope !== "cluster").map((r) => r.scope))];
    if (clusterWide.some((r) => r.role === "cluster-admin")) { crit++; impact.push({ level: "crit", title: "Full control of the cluster", text: "bound to cluster-admin: every namespace, secret and node", fix: { kind: "rbac", text: "Replace cluster-admin with the narrowest role it needs" } }); }
    else if (clusterWide.length) impact.push({ level: "warn", title: `Cluster-wide: ${clusterWide.map((r) => r.role).join(", ")}`, text: "reaches objects in every namespace", fix: { kind: "rbac", text: "Scope it to the namespaces it needs" } });
    if (nsReach.length) impact.push({ level: roles.some((r) => ["admin", "edit"].includes(r.role)) ? "warn" : "ok", title: `Namespaces it can act in: ${nsReach.length}`, text: nsReach.slice(0, 12).join(", ") + (roles.some((r) => ["admin", "edit"].includes(r.role)) ? " (including secrets)" : ""), fix: null });
    if (!roles.length) impact.push({ level: "ok", title: "No roles bound", text: "only what every authenticated account can do", fix: null });
    impact.push({ level: "ok", title: `${pods.length} running pod${pods.length === 1 ? "" : "s"} use it`, text: [...new Set(pods.map((p) => p.owner?.name || p.name))].slice(0, 8).join(", ") || "none", fix: null });
    plan.push({ text: `Rotate the token of ${ns}/${sa}`, level: "warn" }, { text: "Restart the pods that use it", level: "info" }, { text: "Review its role bindings", level: "info" });
  }
  return {
    scenario: { kind: "blast", subject }, at: twin.at, cluster: twin.cluster,
    verdict: crit ? { level: "crit", title: "Wide blast radius", text: "A compromise here reaches the whole cluster." } : impact.some((i) => i.level === "warn") ? { level: "warn", title: "Contained, with exposures", text: "See what it reaches and the steps below." } : { level: "ok", title: "Narrow blast radius", text: "Little is reachable from here." },
    kpis: { downtime: "none", moves: 0, cannotMove: 0, gpusInService: null, powerW: null, minutes: null },
    impact, checks: [{ name: "Role bindings of service accounts", level: crit ? "crit" : "ok" }], plan, moves: [],
    view: twin.nodes.map((n) => nodeView(n, twin, { state: sc.node === n.name ? "lost" : "same", incoming: [], goneCards: [] })),
    assumptions: "Read from role bindings, pod service accounts, mounted secrets and pod security settings. Network reach (NetworkPolicies) is not modelled.",
  };
}

/**
 * DR failover between clusters: can the target cluster run everything from the
 * source (outside OpenShift's own namespaces)? Pure; takes two twins.
 */
export function failover(src, dst, { namespaces = null, critical = null } = {}) {
  const pick = namespaces && String(namespaces).trim() ? criticalSet(namespaces) : (ns) => !/^(openshift|kube-|default$)/.test(ns);
  const isCrit = criticalSet(critical);
  const cap = capacity(dst);
  const groups = new Map();
  for (const p of src.pods.filter((x) => !x.daemon && !x.mirror && pick(x.ns) && !x.vm)) {
    const k = p.owner ? `${p.ns}/${p.owner.kind}/${p.owner.name}` : `${p.ns}/Pod/${p.name}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const impact = [], moves = [], missing = [];
  let missCpu = 0, missMem = 0;
  for (const [k, pods] of [...groups].sort((a, b) => b[1][0].gpuMem - a[1][0].gpuMem || b[1][0].mem - a[1][0].mem)) {
    let placed = 0;
    for (const p of pods) {
      const item = { ...p, node: null, pvcs: [], newPod: false };
      const to = place(cap, item);
      if (to) { placed++; moves.push({ kind: p.model ? "model" : "pod", name: p.model || p.name, ns: p.ns, from: `${src.cluster}/${p.node}`, to: to.node }); }
      else { missCpu += p.cpu; missMem += p.mem; }
    }
    if (placed < pods.length) missing.push({ k, critical: isCrit(pods[0].ns), placed, of: pods.length, gpu: pods[0].gpuMem > 0 });
  }
  let vmMiss = 0;
  for (const v of src.vms.filter((x) => pick(x.ns))) {
    const to = place(cap, { cpu: v.cpu, mem: v.mem, gpus: 0, gpuMem: 0, tolerations: [], nodeSelector: {} });
    if (to) moves.push({ kind: "vm", name: v.name, ns: v.ns, from: `${src.cluster}/${v.node}`, to: to.node, how: "restore" }); else { vmMiss++; missCpu += v.cpu; missMem += v.mem; }
  }
  const critMiss = missing.filter((m) => m.critical);
  const need = nodesFor(dst, missCpu, missMem);
  if (moves.length) impact.push({ level: "ok", title: `${moves.length} pods, models and VMs fit on ${dst.cluster}`, text: `${groups.size} workloads and ${src.vms.filter((x) => pick(x.ns)).length} VMs checked`, fix: null });
  if (critMiss.length) impact.push({ level: "crit", title: `${critMiss.length} critical workload${critMiss.length > 1 ? "s" : ""} would not run`, text: critMiss.slice(0, 8).map((m) => `${m.k} (${m.placed}/${m.of})`).join(", "), fix: { kind: "capacity", text: `Add about ${need} node${need === 1 ? "" : "s"} at the DR site, or reserve capacity for critical apps` } });
  const other = missing.filter((m) => !m.critical);
  if (other.length) impact.push({ level: "warn", title: `${other.length} other workload${other.length > 1 ? "s" : ""} would run short`, text: other.slice(0, 8).map((m) => `${m.k} (${m.placed}/${m.of})${m.gpu ? " GPU" : ""}`).join(", "), fix: { kind: "capacity", text: `About ${need} more node${need === 1 ? "" : "s"} for everything` } });
  if (vmMiss) impact.push({ level: "warn", title: `${vmMiss} VM${vmMiss > 1 ? "s" : ""} would not fit`, text: "restored from backup or replicated", fix: null });
  impact.push({ level: "ok", title: "Data", text: "Persistent volumes must be replicated or restored to the DR site (ODF Regional-DR, OADP/Velero); the twin checks compute only.", fix: null });
  const level = critMiss.length ? "crit" : other.length || vmMiss ? "warn" : "ok";
  return {
    scenario: { kind: "dr-failover", subject: `${src.cluster} → ${dst.cluster}` }, at: dst.at, cluster: dst.cluster,
    verdict: level === "crit" ? { level, title: "DR site cannot take the critical load", text: `${critMiss.length} critical workload(s) have nowhere to run on ${dst.cluster}.` }
      : level === "warn" ? { level, title: "Critical load fits; the rest runs short", text: `About ${need} more node(s) to run everything.` } : { level, title: `${dst.cluster} can take everything`, text: "Every workload, model and VM fits." },
    kpis: { downtime: level === "crit" ? "outage" : "none", moves: moves.length, cannotMove: missing.reduce((a, m) => a + m.of - m.placed, 0) + vmMiss, nodesNeeded: need, gpusInService: null, powerW: null, minutes: null },
    impact, checks: [{ name: "Compute and GPU fit at the DR site", level }, { name: "Data replication", level: "ok", note: "not modelled" }],
    plan: [], moves, view: dst.nodes.map((n) => nodeView(n, dst, { state: moves.some((m) => m.to === n.name) ? "receives" : "same", incoming: moves.filter((m) => m.to === n.name).map((m) => ({ kind: m.kind, name: m.name })), goneCards: [] })),
    assumptions: `${ASSUMPTIONS} Failover places every workload of the source cluster on the target as it is now; storage placement is not checked across sites.`,
  };
}

/** N+1: can the cluster lose any one worker without an outage? */
export function resilience(twin, { critical = null } = {}) {
  const crit = criticalSet(critical);
  const workers = twin.nodes.filter((n) => !n.roles.includes("master") && !n.roles.includes("control-plane"));
  const per = workers.map((n) => { const r = replay(twin, { kind: "node-fail", fail: true, gone: new Set([n.name]), goneCards: new Set(), subject: n.name, critical: crit }); return { node: n.name, level: r.verdict.level, title: r.verdict.title, stops: r.impact.filter((i) => i.level === "crit").map((i) => i.title) }; });
  const ok = per.filter((x) => x.level !== "crit").length;
  return { at: twin.at, cluster: twin.cluster, score: workers.length ? Math.round((ok / workers.length) * 100) : 100, workers: workers.length, survivable: ok, failing: per.filter((x) => x.level === "crit"), per };
}

/* ─────────────────────────── service entry points ─────────────────────────── */

export async function run(cluster, sc, { actor = null, fresh = false } = {}) {
  const twin = await snapshot(cluster, { fresh });
  const out = simulate(twin, sc);
  out.risk = computeRisk(out, { cluster, critical: sc?.critical });
  if (sc?.kind === "drain" && out.moves.some((m) => m.to && m.kind !== "vm")) await recordPrediction(cluster, sc.node, out, actor).catch(() => {});
  const h = _history.get(cluster) || [];
  h.unshift({ at: new Date(_deps.now()).toISOString(), scenario: out.scenario, verdict: out.verdict.title, level: out.verdict.level, risk: out.risk.score, actor });
  _history.set(cluster, h.slice(0, 20));
  return out;
}
export function history(cluster) { return _history.get(cluster) || []; }

/* ─────────────────────────── risk score ─────────────────────────── */

const PROD = () => new RegExp(process.env.OPS_TWIN_PROD_PATTERN || process.env.USER_ACCESS_PROD_PATTERN || "prod", "i");

/**
 * One number a change board can use: 0–100, Low / Medium / High, and the
 * reasons that made it. Deterministic, from the simulation only.
 */
export function computeRisk(out, { cluster = out.cluster, critical = null } = {}) {
  const reasons = [];
  let score = { ok: 8, warn: 35, crit: 70 }[out.verdict.level] ?? 35;
  reasons.push({ points: score, text: `Verdict: ${out.verdict.title}` });
  const add = (points, text) => { if (points) { score += points; reasons.push({ points, text }); } };
  const crits = out.impact.filter((i) => i.level === "crit").length, warns = out.impact.filter((i) => i.level === "warn").length;
  add(Math.min(15, Math.max(0, crits - 1) * 5), `${crits} findings that stop the change`);
  add(Math.min(12, warns * 3), `${warns} findings that need action first`);
  const k = out.kpis || {};
  if (k.cannotMove) add(Math.min(10, 2 + k.cannotMove), `${k.cannotMove} items with nowhere to run`);
  if (k.downtime && k.downtime !== "none" && k.downtime !== "outage") add(4, `Brief interruption expected (${k.downtime})`);
  if (k.minutes > 60) add(4, `Long change (about ${k.minutes} min)`);
  const isCrit = criticalSet(critical);
  if (critical && out.moves?.some((m) => m.ns && isCrit(m.ns))) add(6, "Critical applications are moved");
  if (PROD().test(String(cluster))) add(10, "Production cluster");
  if (out.scenario?.kind === "blast") { score = Math.min(score, out.verdict.level === "crit" ? 90 : score); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= 67 ? "High" : score >= 34 ? "Medium" : "Low";
  return { score, level, snow: level === "High" ? "high" : level === "Medium" ? "moderate" : "low", reasons };
}

/* ─────────────────────────── accuracy ─────────────────────────── */

/**
 * A drain simulation predicts where each workload goes. When that node is
 * later drained for real, the prediction is compared with where the pods
 * actually landed: the twin's track record, in the open.
 */
async function recordPrediction(cluster, node, out, actor) {
  const st = await loadState();
  const moves = out.moves.filter((m) => m.to && m.kind !== "vm").map((m) => ({ ns: m.ns, workload: m.workload || m.name, to: m.to, kind: m.kind }));
  st.predictions = st.predictions.filter((x) => !(x.cluster === cluster && x.node === node && !x.checkedAt));
  st.predictions.unshift({ id: `P${_deps.now().toString(36)}`, cluster, node, at: new Date(_deps.now()).toISOString(), actor, verdict: out.verdict.level, moves: moves.slice(0, 300) });
  st.predictions = st.predictions.slice(0, 200);
  await saveState();
}

/** Score a prediction against the twin as it is now. Pure. */
export function scorePrediction(pred, twin) {
  const node = twin.nodes.find((n) => n.name === pred.node);
  const left = twin.pods.filter((p) => p.node === pred.node && !p.daemon && !p.mirror).length;
  if (node && node.schedulable && left) return null;                      // not drained yet
  let hit = 0, landed = 0;
  const rows = [];
  for (const m of pred.moves) {
    const now = twin.pods.filter((p) => p.ns === m.ns && (p.model === m.workload || p.owner?.name === m.workload || p.name === m.workload || wlabel(p) === m.workload));
    if (!now.length) { rows.push({ ...m, actual: null, match: null }); continue; }
    landed++;
    const ok = now.some((p) => p.node === m.to);
    if (ok) hit++;
    rows.push({ ...m, actual: [...new Set(now.map((p) => p.node))].join(", "), match: ok });
  }
  // Also right if the prediction was "everything keeps running somewhere".
  return { landed, hit, placementPct: landed ? Math.round((hit / landed) * 100) : null, rows };
}

/** Check open predictions on a cluster against the live twin. */
export async function verifyPredictions(cluster, twin) {
  const st = await loadState();
  let changed = 0;
  for (const p of st.predictions.filter((x) => x.cluster === cluster && !x.checkedAt)) {
    const r = scorePrediction(p, twin);
    if (r === null) {
      if (_deps.now() - Date.parse(p.at) > 30 * 86400000) { p.checkedAt = new Date(_deps.now()).toISOString(); p.expired = true; changed++; }
      continue;
    }
    Object.assign(p, { checkedAt: new Date(_deps.now()).toISOString(), result: { landed: r.landed, hit: r.hit, placementPct: r.placementPct }, rows: r.rows.slice(0, 50) });
    changed++;
  }
  if (changed) await saveState();
  return accuracy(cluster);
}

/** The track record: how often the twin put work where the scheduler did. */
export async function accuracy(cluster = null) {
  const st = await loadState();
  const mine = st.predictions.filter((x) => !cluster || x.cluster === cluster);
  const done = mine.filter((x) => x.result && x.result.landed);
  const landed = done.reduce((a, x) => a + x.result.landed, 0), hit = done.reduce((a, x) => a + x.result.hit, 0);
  return {
    evaluated: done.length, open: mine.filter((x) => !x.checkedAt).length,
    placementPct: landed ? Math.round((hit / landed) * 100) : null, workloads: landed,
    recent: done.slice(0, 10).map((x) => ({ id: x.id, node: x.node, at: x.at, checkedAt: x.checkedAt, ...x.result, misses: (x.rows || []).filter((r) => r.match === false).slice(0, 5) })),
    note: "A prediction is checked once its node has been drained for real: each workload counts as right when it landed on the node the twin named. Kubernetes may also choose another node that fits; that counts as a miss here.",
  };
}

/* ─────────────────────────── resilience trend ─────────────────────────── */

/** Score N+1 now, keep a daily trend, and say if it dropped. */
export async function resilienceCheck(cluster, { critical = process.env.OPS_TWIN_CRITICAL_NAMESPACES || null, fresh = true } = {}) {
  const twin = await snapshot(cluster, { fresh });
  const r = resilience(twin, { critical });
  const st = await loadState();
  const trend = st.resilience[cluster] || [];
  const day = new Date(_deps.now()).toISOString().slice(0, 10);
  const prev = trend[0];
  const entry = { day, at: twin.at, score: r.score, survivable: r.survivable, workers: r.workers };
  if (prev?.day === day) trend[0] = entry; else trend.unshift(entry);
  st.resilience[cluster] = trend.slice(0, 90);
  await saveState();
  if (prev && r.score < prev.score && _deps.notify) {
    try { _deps.notify({ type: "ops-twin", severity: r.score < 100 ? "warning" : "info", title: `Resilience on ${cluster} fell to ${r.score}%`, message: `${r.failing.length} node failure(s) would now cause an outage: ${r.failing.slice(0, 5).map((f) => f.node).join(", ")}. It was ${prev.score}% on ${prev.day}.` }); } catch { /* best effort */ }
  }
  return { ...r, trend: st.resilience[cluster] };
}
export async function resilienceTrend(cluster) { const st = await loadState(); return st.resilience[cluster] || []; }

/** The compact twin a hub needs from another cluster for a DR check. */
export function exportTwin(twin) {
  return {
    cluster: twin.cluster, at: twin.at,
    nodes: twin.nodes.map((n) => ({ ...n })), pods: twin.pods.map((p) => ({ ...p, secrets: undefined })), vms: twin.vms, models: twin.models,
    pdbs: twin.pdbs, racks: twin.racks, sites: twin.sites, volumes: {}, quotas: {}, usageKnown: false, saBindings: [],
  };
}

/** Evidence for auditors: the simulation, its risk, and the model behind it. */
export function evidence(out, { actor = null, ticket = null } = {}) {
  return [
    `OPS TWIN — PRE-CHANGE EVIDENCE`,
    `Generated ${new Date(_deps.now()).toISOString()}${actor ? ` by ${actor}` : ""}${ticket ? ` · change ${ticket}` : ""}`,
    out.risk ? `Risk score: ${out.risk.score}/100 (${out.risk.level})\n${out.risk.reasons.map((r) => `  +${r.points}  ${r.text}`).join("\n")}` : "",
    "",
    report(out),
    "",
    "Method: the twin is a read-only copy of the cluster's nodes, pods, disruption budgets, volumes, quotas and GPUs, taken at the time above. The change was replayed with the scheduler's rules; nothing was changed on the cluster.",
  ].filter((x) => x !== "").join("\n");
}

/** A plain-text report: for a change request, an export, or AI Chat. */
export function report(out) {
  const L = [];
  L.push(`Ops Twin — what if: ${SCENARIOS.find((s) => s.id === out.scenario.kind)?.label || out.scenario.kind} (${out.scenario.subject})`);
  L.push(`Cluster: ${out.cluster} · twin read ${out.at}`);
  L.push("", `Verdict: ${out.verdict.title}. ${out.verdict.text}`);
  if (out.risk) L.push(`Risk: ${out.risk.score}/100 (${out.risk.level})`);
  if (out.window) L.push(`Window: ${out.window.hours} h · ${out.window.nodesInWindow} nodes fit · ${out.window.windowsNeeded} window(s) needed`);
  if (out.savings) L.push(`Saves: about ${out.savings.kwhMonth} kWh a month${out.savings.money != null ? `, ${out.savings.currency}${out.savings.money} a month` : ""}`);
  if (out.sizing) L.push(`Sizing: ${out.sizing.nodesNeeded} more node(s), ${out.sizing.withSpare} with one spare; about ${out.sizing.vmsPerNode} such VMs per node`);
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
  const hours = s.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?)\b/);
  if (/\b(window|patch)/.test(s) && hours) return { kind: "window", windowHours: Number(hours[1]) };
  if (/\bupgrad/.test(s)) return { kind: "upgrade" };
  const factor = s.match(/(?:x|×)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:x|×|times)\b/);
  if (factor && /\b(peak|traffic|load|sale|month.end|scale)/.test(s)) {
    const ns = [...new Set(twin.pods.map((p) => p.ns))].filter((n) => s.includes(n.toLowerCase()));
    return { kind: "peak", factor: Number(factor[1] || factor[2]), namespaces: ns.length ? ns : twin.pods.filter((p) => !/^(openshift|kube-)/.test(p.ns)).map((p) => p.ns).filter((v, i, a) => a.indexOf(v) === i) };
  }
  const site = Object.keys(twin.sites || {}).sort((a, b) => b.length - a.length).find((x) => s.includes(x.toLowerCase()));
  if (site && /\b(site|zone|dc|data ?cent|region|down|fail|lose|outage)/.test(s)) return { kind: "site-fail", site };
  if (/\b(retire|decommission|switch off|remove)\b/.test(s) && node) return { kind: "retire", nodes: twin.nodes.map((n) => n.name).filter((n) => s.includes(n.toLowerCase())) };
  if (/\b(compromis|breach|hacked|blast)/.test(s)) {
    const sa = s.match(/([a-z0-9-]+)\/([a-z0-9-]+)/);
    if (node) return { kind: "blast", node };
    if (sa) return { kind: "blast", serviceAccount: `${sa[1]}/${sa[2]}` };
  }
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
