/**
 * GPU fleet overview — inventory, utilization, health and cost-waste signals
 * for NVIDIA (and AMD) accelerators, sourced entirely from the cluster's
 * existing monitoring stack.
 *
 * Data source (global industry standard):
 *   NVIDIA GPU Operator → DCGM Exporter (DCGM_FI_* series) + Node Feature
 *   Discovery, scraped by the in-cluster Prometheus/Thanos. AMD Instinct nodes
 *   expose the analogous device-metrics-exporter (gpu_* / amd_* series). We read
 *   only what Prometheus already collects — no privileged host access, no new
 *   agents, all read-only PromQL.
 *
 * Everything degrades gracefully: if DCGM metrics are absent (operator not
 * installed, or no GPU nodes) the caller gets { available:false, reason } and
 * the dashboard renders a "GPU Operator not detected" empty state rather than an
 * error.
 */

import { promQuery } from "../services/prometheus.js";
import { ocpGet } from "../utils/openshift-client.js";

// A failed query and an empty result are NOT the same thing. Swallowing the
// difference is how this view told an operator to install an operator that was
// already installed and healthy. The last error is kept so the presence probe
// can report "cannot reach Prometheus" instead of "no GPUs".
let _lastProbeError = null;

/** Run a PromQL instant query, returning [] on failure and recording why. */
async function safeQuery(q) {
  try {
    return await promQuery(q);
  } catch (e) {
    _lastProbeError = e?.message || String(e);
    return [];
  }
}

/** First numeric value of a metric series, or null. */
function val(series) {
  const v = series?.value?.[1];
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Stable identity for a physical GPU across the different DCGM series. */
function gpuKey(m) {
  const host = m.Hostname || m.instance || m.node || m.exported_node || "";
  const idx = m.gpu ?? m.device ?? m.minor_number ?? "";
  const uuid = m.UUID || m.uuid || "";
  return uuid ? `${host}#${uuid}` : `${host}#${idx}`;
}

/** GPU health verdict from temperature and error counters. */
function gpuStatus({ tempC, xid, eccDbe }) {
  if ((xid != null && xid > 0) || (eccDbe != null && eccDbe > 0)) return "critical";
  if (tempC != null && tempC >= 87) return "critical";
  if (tempC != null && tempC >= 80) return "warning";
  return "healthy";
}

/**
 * GPU inventory straight from the Kubernetes API — no Prometheus involved.
 *
 * This is the presence source of truth. DCGM telemetry is an ENRICHMENT: it
 * tells you how hard the cards are working, not whether they exist. Treating
 * metrics as the presence probe meant a cluster with healthy GPUs reported
 * none whenever monitoring was misconfigured, which is the wrong answer to a
 * question the API server can always answer.
 *
 * Detail comes from the labels GPU Feature Discovery writes onto each node.
 */
export async function getGpuInventory() {
  let nodeList;
  try {
    nodeList = await ocpGet("/api/v1/nodes");
  } catch (e) {
    return { nodes: [], totalGpus: 0, error: `Could not list nodes: ${e.message}` };
  }

  const RES = ["nvidia.com/gpu", "amd.com/gpu", "intel.com/gpu"];
  const nodes = [];
  for (const n of nodeList.items || []) {
    const cap = n.status?.capacity || {};
    const alloc = n.status?.allocatable || {};
    const resKey = RES.find((r) => Number(cap[r]) > 0);
    if (!resKey) continue;

    const L = n.metadata?.labels || {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const memMiB = num(L["nvidia.com/gpu.memory"]);
    nodes.push({
      name: n.metadata?.name,
      vendor: resKey.split(".")[0],
      resource: resKey,
      capacity: num(cap[resKey]) || 0,
      allocatable: num(alloc[resKey]) || 0,
      product: L["nvidia.com/gpu.product"] || L["amd.com/gpu.product"] || "GPU",
      memoryMiBPerGpu: memMiB,
      driverVersion: L["nvidia.com/cuda.driver-version.full"]
        || [L["nvidia.com/cuda.driver.major"], L["nvidia.com/cuda.driver.minor"], L["nvidia.com/cuda.driver.rev"]].filter(Boolean).join(".")
        || null,
      cudaVersion: L["nvidia.com/cuda.runtime-version.full"]
        || [L["nvidia.com/cuda.runtime.major"], L["nvidia.com/cuda.runtime.minor"]].filter(Boolean).join(".")
        || null,
      machine: L["nvidia.com/gpu.machine"] || null,
      migCapable: L["nvidia.com/mig.capable"] === "true",
      migStrategy: L["nvidia.com/mig.strategy"] || null,
      computeCapability: L["nvidia.com/gpu.compute.major"]
        ? `${L["nvidia.com/gpu.compute.major"]}.${L["nvidia.com/gpu.compute.minor"] || 0}` : null,
      ready: (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True"),
      schedulable: !n.spec?.unschedulable,
    });
  }
  if (!nodes.length) return { nodes: [], totalGpus: 0 };

  // Who is actually holding the cards? Sum GPU limits across running pods.
  const consumers = [];
  const perNode = new Map();
  try {
    const pods = await ocpGet("/api/v1/pods?fieldSelector=status.phase%3DRunning&limit=3000");
    for (const pod of pods.items || []) {
      let want = 0;
      for (const c of pod.spec?.containers || []) {
        for (const r of RES) {
          const v = Number(c.resources?.limits?.[r] ?? c.resources?.requests?.[r] ?? 0);
          if (Number.isFinite(v)) want += v;
        }
      }
      if (want <= 0) continue;
      const node = pod.spec?.nodeName || "unknown";
      consumers.push({ namespace: pod.metadata?.namespace, pod: pod.metadata?.name, node, gpus: want });
      perNode.set(node, (perNode.get(node) || 0) + want);
    }
  } catch { /* pod read is best-effort — inventory still stands */ }

  let totalGpus = 0, totalAllocated = 0;
  const models = {};
  for (const n of nodes) {
    totalGpus += n.capacity;
    n.allocatedGpus = perNode.get(n.name) || 0;
    n.freeGpus = Math.max(0, n.allocatable - n.allocatedGpus);
    totalAllocated += n.allocatedGpus;
    models[n.product] = (models[n.product] || 0) + n.capacity;
  }
  consumers.sort((a, b) => b.gpus - a.gpus);

  // Who is WAITING for a GPU. Pending demand is half the picture — free
  // capacity means nothing if jobs are queued behind it, and queued jobs
  // alongside idle cards is the most actionable thing a GPU view can show.
  const pending = [];
  try {
    const pp = await ocpGet("/api/v1/pods?fieldSelector=status.phase%3DPending&limit=2000");
    for (const pod of pp.items || []) {
      let want = 0;
      for (const c of pod.spec?.containers || []) {
        for (const r of RES) {
          const v = Number(c.resources?.limits?.[r] ?? c.resources?.requests?.[r] ?? 0);
          if (Number.isFinite(v)) want += v;
        }
      }
      if (want <= 0) continue;
      const cond = (pod.status?.conditions || []).find((c) => c.type === "PodScheduled" && c.status === "False");
      const since = pod.metadata?.creationTimestamp;
      pending.push({
        namespace: pod.metadata?.namespace, pod: pod.metadata?.name, gpus: want,
        reason: cond?.reason || "Unschedulable",
        detail: (cond?.message || "").slice(0, 220) || null,
        waitingMinutes: since ? Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 60000)) : null,
      });
    }
  } catch { /* best-effort */ }
  pending.sort((a, b) => (b.waitingMinutes || 0) - (a.waitingMinutes || 0));

  // Fragmentation: four free GPUs spread one-per-node cannot run a 4-GPU job.
  // The largest contiguous single-node block is what actually schedules.
  const freeByNode = nodes.map((n) => ({ node: n.name, free: n.freeGpus })).sort((a, b) => b.free - a.free);
  const largestFreeBlock = freeByNode.length ? freeByNode[0].free : 0;
  const totalFree = Math.max(0, totalGpus - totalAllocated);
  const biggestPendingAsk = pending.reduce((m, p) => Math.max(m, p.gpus), 0);

  // MIG profiles, when the cards are sliced.
  for (const n of nodes) {
    const node = (nodeList.items || []).find((x) => x.metadata?.name === n.name);
    const L = node?.metadata?.labels || {};
    const profiles = {};
    for (const [k, v] of Object.entries(L)) {
      const m = /^nvidia\.com\/mig-(\S+)\.count$/.exec(k);
      if (m && Number(v) > 0) profiles[m[1]] = Number(v);
    }
    n.migProfiles = Object.keys(profiles).length ? profiles : null;
  }

  return {
    nodes, totalGpus, totalAllocated, totalFree, models,
    consumers: consumers.slice(0, 25),
    consumerCount: consumers.length,
    pending: pending.slice(0, 25),
    pendingCount: pending.length,
    pendingGpus: pending.reduce((s, p) => s + p.gpus, 0),
    fragmentation: {
      freeByNode, largestFreeBlock, biggestPendingAsk,
      // Free capacity exists, but not in one place big enough for the queue.
      blocked: biggestPendingAsk > 0 && totalFree >= biggestPendingAsk && largestFreeBlock < biggestPendingAsk,
    },
  };
}

/**
 * Build a fleet-wide GPU overview from DCGM metrics.
 * @returns {Promise<object>} inventory + utilization + health, or { available:false }.
 */
/**
 * Fleet insights that do not need telemetry.
 *
 * GPUs are the most expensive thing in the estate, so the useful questions are
 * about contention and waste, not averages. Each insight is a claim with the
 * evidence attached, so an operator can act on it or dismiss it.
 */
function buildInsights(inv, { idleAllocated = null, idleDetail = [] } = {}) {
  const out = [];
  const f = inv.fragmentation || {};

  if (inv.pendingCount > 0 && inv.totalFree > 0 && !f.blocked) {
    out.push({
      severity: "warning", kind: "queued-with-capacity",
      title: `${inv.pendingCount} job(s) waiting for ${inv.pendingGpus} GPU(s) while ${inv.totalFree} sit free`,
      detail: "Free capacity exists but the queue is not draining — usually a taint, node selector, or a resource other than the GPU (CPU, memory, storage) blocking placement.",
      evidence: inv.pending.slice(0, 3).map((p) => `${p.namespace}/${p.pod} waiting ${p.waitingMinutes}m: ${p.detail || p.reason}`),
    });
  }
  if (f.blocked) {
    out.push({
      severity: "warning", kind: "fragmented",
      title: `${inv.totalFree} GPUs free, but the largest single-node block is ${f.largestFreeBlock}`,
      detail: `A job asking for ${f.biggestPendingAsk} GPUs cannot be placed even though the fleet has capacity. Consolidating workloads onto fewer nodes would unblock it.`,
      evidence: f.freeByNode.filter((n) => n.free > 0).map((n) => `${n.node}: ${n.free} free`),
    });
  }
  if (idleAllocated > 0) {
    out.push({
      severity: "critical", kind: "idle-allocated",
      title: `${idleAllocated} GPU(s) reserved but idle`,
      detail: "Claimed by a workload and doing no work. This is the clearest GPU waste signal — the card is unavailable to everyone else while producing nothing.",
      evidence: idleDetail.slice(0, 4).map((w) => `${w.namespace || "?"}/${w.pod || "?"} on ${w.node} — ${w.utilPct ?? 0}% utilised`),
    });
  }
  if (inv.totalGpus > 0 && inv.totalAllocated === 0 && inv.pendingCount === 0) {
    out.push({
      severity: "info", kind: "wholly-idle",
      title: `All ${inv.totalGpus} GPUs are unallocated`,
      detail: "No workload is requesting GPUs on this cluster. Expected in a lab; in production it usually means jobs are not reaching this cluster.",
      evidence: [],
    });
  }
  return out;
}

/**
 * Is a GPU stack actually installed on this cluster?
 *
 * Inferring this from metrics was the original sin here: absent telemetry was
 * reported as "no GPU Operator", which was wrong in both directions. Ask the
 * API server directly instead, so the widget can say something true and
 * specific — including the honest, unremarkable answer "this cluster has no
 * GPUs", which is the correct answer for most clusters.
 */
export async function detectGpuStack() {
  const out = {
    operatorInstalled: false, clusterPolicyState: null,
    gpuNodes: 0, gpuCapacity: 0,
    pciGpuNodes: 0,        // NVIDIA PCI devices seen by Node Feature Discovery
    nfdPresent: false,
  };

  // The ClusterPolicy CRD only exists once the GPU Operator is installed.
  try {
    const cps = await ocpGet("/apis/nvidia.com/v1/clusterpolicies");
    out.operatorInstalled = true;
    const cp = (cps.items || [])[0];
    if (cp) {
      out.clusterPolicyName = cp.metadata?.name || null;
      out.clusterPolicyState = cp.status?.state || "unknown";
    }
  } catch { /* 404 = CRD absent = operator not installed */ }

  try {
    const nodes = await ocpGet("/api/v1/nodes");
    for (const n of nodes.items || []) {
      const cap = Number(n.status?.capacity?.["nvidia.com/gpu"]
        || n.status?.capacity?.["amd.com/gpu"] || 0);
      if (cap > 0) { out.gpuNodes++; out.gpuCapacity += cap; }
      const L = n.metadata?.labels || {};
      if (Object.keys(L).some((k) => k.startsWith("feature.node.kubernetes.io/"))) out.nfdPresent = true;
      // 10de is NVIDIA's PCI vendor id; 1002 is AMD. NFD sets these when the
      // hardware is physically present, whether or not a driver is loaded.
      if (L["feature.node.kubernetes.io/pci-10de.present"] === "true"
        || L["feature.node.kubernetes.io/pci-1002.present"] === "true") out.pciGpuNodes++;
    }
  } catch { /* node read failed — caller reports separately */ }

  return out;
}

/**
 * MCP tool surface for GPU inventory and telemetry.
 */
export function registerGpuTools(server) {
  server.tool(
    "gpu_inventory",
    "GPU hardware on this cluster, read from the Kubernetes API: per-node model, count, allocated vs free, memory per GPU, driver version and MIG capability, plus which pods are holding GPUs. Works without Prometheus.",
    {},
    async () => {
      const inv = await getGpuInventory();
      return { content: [{ type: "text", text: JSON.stringify(inv, null, 2) }] };
    }
  );
  server.tool(
    "gpu_stack_check",
    "Whether this cluster has GPU hardware and whether the NVIDIA GPU Operator is installed and working. Answers from the API server, so it is valid even when monitoring is broken.",
    {},
    async () => {
      const s = await detectGpuStack();
      const verdict = s.gpuCapacity > 0
        ? `${s.gpuCapacity} GPU(s) allocatable across ${s.gpuNodes} node(s). Operator ${s.operatorInstalled ? "installed" : "not installed"}${s.clusterPolicyState ? `, ClusterPolicy ${s.clusterPolicyState}` : ""}.`
        : s.pciGpuNodes > 0
          ? (s.operatorInstalled
              ? `GPU hardware on ${s.pciGpuNodes} node(s), operator installed${s.clusterPolicyState ? ` (ClusterPolicy ${s.clusterPolicyState})` : ""}, but nothing allocatable — the driver or device plugin is not completing.`
              : `GPU hardware on ${s.pciGpuNodes} node(s), but the NVIDIA GPU Operator is not installed.`)
          : s.operatorInstalled
            ? "GPU Operator installed, but no GPU hardware on any node."
            : "This cluster has no GPUs and no GPU Operator.";
      return { content: [{ type: "text", text: JSON.stringify({ ...s, verdict }, null, 2) }] };
    }
  );
  server.tool(
    "gpu_overview",
    "Full GPU fleet view: inventory from the Kubernetes API, enriched with live DCGM utilisation, memory, temperature, power and error counters when the exporter is being scraped.",
    {},
    async () => {
      const out = await getGpuOverview();
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );
}

export async function getGpuOverview() {
  _lastProbeError = null;

  // Ask the API server first. It always knows whether GPUs exist, and it is
  // routed to the SAME cluster the user selected. Metrics are enrichment.
  const inv = await getGpuInventory();
  const util = await safeQuery("DCGM_FI_DEV_GPU_UTIL");

  // Hardware present but no telemetry — show everything we DO know rather than
  // an empty state. This is the common real-world case: the GPU Operator is
  // healthy but user-workload monitoring is off, so DCGM is never scraped.
  if (!util.length && inv.totalGpus > 0) {
    return {
      available: true,
      telemetry: "unavailable",
      telemetryReason: _lastProbeError
        ? `Metrics backend unreachable: ${_lastProbeError}`
        : "No DCGM_FI_* series found. The GPU Operator is installed and the cards are visible to Kubernetes, but the DCGM exporter is not being scraped.",
      telemetryRemediation: _lastProbeError
        ? ["Check this cluster's Thanos route is reachable and the stored credential has cluster-monitoring-view."]
        : [
            "Enable user-workload monitoring — the DCGM exporter runs in nvidia-gpu-operator, a user namespace that platform Prometheus does not scrape:",
            "oc -n openshift-monitoring edit configmap cluster-monitoring-config  →  data.config.yaml: enableUserWorkload: true",
            "Then: oc get servicemonitor -n nvidia-gpu-operator",
          ],
      summary: {
        totalGpus: inv.totalGpus,
        nodes: inv.nodes.length,
        models: inv.models,
        allocatedGpus: inv.totalAllocated,
        unallocatedGpus: inv.totalFree,
        avgUtilPct: null, maxUtilPct: null, idleAllocatedGpus: null,
        fleetHealth: "unknown",
      },
      inventory: inv,
      insights: buildInsights(inv),
      nodes: inv.nodes.map((n) => ({
        name: n.name, gpuCount: n.capacity, model: n.product,
        avgUtil: null, allocated: n.allocatedGpus, free: n.freeGpus,
        memoryMiBPerGpu: n.memoryMiBPerGpu, driverVersion: n.driverVersion,
        migCapable: n.migCapable, ready: n.ready,
      })),
      gpus: [],
      generatedAt: new Date().toISOString(),
    };
  }

  if (!util.length) {
    // Second chance: a node may advertise nvidia.com/gpu capacity even before
    // DCGM is scraping (operator installing). Surface that as "detected, no
    // metrics yet" rather than a flat "not detected".
    const cap = await safeQuery('sum(kube_node_status_capacity{resource="nvidia_com_gpu"}) or sum(kube_node_status_capacity{resource="amd_com_gpu"})');
    const capCount = val(cap[0]);
    if (capCount && capCount > 0) {
      return {
        available: false,
        reason: "gpu-nodes-without-metrics",
        message: `${capCount} GPU(s) detected on cluster nodes, but the DCGM exporter is not reporting metrics yet. If the NVIDIA GPU Operator was just installed, allow a few minutes for the DCGM DaemonSet to start scraping.`,
        detectedGpuCapacity: capCount,
        generatedAt: new Date().toISOString(),
      };
    }
    // Ordering matters. The API server is authoritative about whether GPUs
    // exist, so a metrics outage must NOT mask an answer we already have. Only
    // when the inventory read ALSO failed are we genuinely unable to say.
    if (_lastProbeError && inv.error) {
      return {
        available: false,
        reason: "metrics-unreachable",
        message: `Could not query the metrics backend for this cluster, so GPU presence is unknown — this is NOT a statement that the GPU Operator is missing. Error: ${_lastProbeError}`,
        remediation: [
          "Confirm the selected cluster's Thanos route is reachable from this server: oc get route thanos-querier -n openshift-monitoring",
          "Confirm the cluster credential has cluster-monitoring-view: oc adm policy add-cluster-role-to-user cluster-monitoring-view <sa>",
          "For DCGM metrics specifically, user-workload monitoring must be enabled — the exporter lives in nvidia-gpu-operator, a user namespace.",
        ],
        error: _lastProbeError,
        generatedAt: new Date().toISOString(),
      };
    }
    // No telemetry AND no GPU hardware visible to Kubernetes. Ask what is
    // actually installed so we can name the situation instead of describing
    // the absence of a metric.
    const stack = await detectGpuStack();

    if (!inv.error) {
      // Hardware is physically present but Kubernetes cannot see it — the
      // operator is missing, or installed and not working.
      if (stack.pciGpuNodes > 0 && stack.gpuCapacity === 0) {
        return {
          available: false,
          reason: stack.operatorInstalled ? "operator-not-working" : "operator-missing",
          stack,
          message: stack.operatorInstalled
            ? `GPU hardware is present on ${stack.pciGpuNodes} node(s) and the NVIDIA GPU Operator is installed`
              + `${stack.clusterPolicyState ? ` (ClusterPolicy state: ${stack.clusterPolicyState})` : ""}, `
              + `but no node is advertising allocatable GPUs. The driver or device plugin is not completing.`
            : `GPU hardware is present on ${stack.pciGpuNodes} node(s), but the NVIDIA GPU Operator is not installed, `
              + `so Kubernetes cannot schedule work onto these GPUs.`,
          remediation: stack.operatorInstalled
            ? [
                "oc get clusterpolicy -o yaml   — check status.conditions for the failing component",
                "oc get pods -n nvidia-gpu-operator   — look for driver-daemonset or device-plugin not Running",
                "oc logs -n nvidia-gpu-operator -l app=nvidia-driver-daemonset --tail=50",
              ]
            : [
                "Install the NVIDIA GPU Operator from OperatorHub into the nvidia-gpu-operator namespace",
                "It requires Node Feature Discovery, which " + (stack.nfdPresent ? "is already installed." : "is NOT installed — install that first."),
              ],
          docs: "https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/openshift/steps-overview.html",
          generatedAt: new Date().toISOString(),
        };
      }

      // Operator installed, no hardware. Unusual but worth naming exactly.
      if (stack.operatorInstalled && stack.gpuCapacity === 0) {
        return {
          available: false, reason: "operator-without-hardware", stack,
          message: "The NVIDIA GPU Operator is installed on this cluster, but no node has GPU hardware. Nothing to report.",
          generatedAt: new Date().toISOString(),
        };
      }

      // The ordinary case: a CPU-only cluster. Not a fault, not a warning.
      return {
        available: false, reason: "no-gpu-hardware", stack,
        message: "This cluster has no GPUs. No node reports GPU hardware, and the NVIDIA GPU Operator is not installed.",
        generatedAt: new Date().toISOString(),
      };
    }

    return {
      available: false,
      reason: "inventory-unreadable",
      stack,
      message: `Could not read node inventory for this cluster, so GPU presence is unknown: ${inv.error}`,
      remediation: ["Check that the stored credential for this cluster can list nodes."],
      generatedAt: new Date().toISOString(),
    };
  }

  // Fan out the remaining DCGM series in parallel. Each is optional — DCGM
  // profiles vary by driver version, so a missing series just leaves a null.
  const [
    fbUsed, fbFree, temp, power, smClock, memClock,
    smActive, tensorActive, xid, eccSbe, eccDbe,
  ] = await Promise.all([
    safeQuery("DCGM_FI_DEV_FB_USED"),            // MiB
    safeQuery("DCGM_FI_DEV_FB_FREE"),            // MiB
    safeQuery("DCGM_FI_DEV_GPU_TEMP"),           // °C
    safeQuery("DCGM_FI_DEV_POWER_USAGE"),        // W
    safeQuery("DCGM_FI_DEV_SM_CLOCK"),           // MHz
    safeQuery("DCGM_FI_DEV_MEM_CLOCK"),          // MHz
    safeQuery("DCGM_FI_PROF_SM_ACTIVE"),         // 0-1 ratio
    safeQuery("DCGM_FI_PROF_PIPE_TENSOR_ACTIVE"),// 0-1 ratio
    safeQuery("DCGM_FI_DEV_XID_ERRORS"),         // last XID (0 = none)
    safeQuery("DCGM_FI_DEV_ECC_SBE_VOL_TOTAL"),  // single-bit ECC (correctable)
    safeQuery("DCGM_FI_DEV_ECC_DBE_VOL_TOTAL"),  // double-bit ECC (uncorrectable)
  ]);

  // Index every optional series by GPU key for O(1) join against utilization.
  const index = (series) => {
    const m = new Map();
    for (const s of series) m.set(gpuKey(s.metric || {}), val(s));
    return m;
  };
  const iFbUsed = index(fbUsed), iFbFree = index(fbFree), iTemp = index(temp);
  const iPower = index(power), iSm = index(smClock), iMem = index(memClock);
  const iSmAct = index(smActive), iTensor = index(tensorActive);
  const iXid = index(xid), iSbe = index(eccSbe), iDbe = index(eccDbe);

  const gpus = [];
  for (const s of util) {
    const m = s.metric || {};
    const key = gpuKey(m);
    const utilPct = val(s);
    const memUsed = iFbUsed.get(key);
    const memFree = iFbFree.get(key);
    const memTotal = (memUsed != null && memFree != null) ? memUsed + memFree : null;
    const tempC = iTemp.get(key);
    const xidErr = iXid.get(key);
    const eccDbe = iDbe.get(key);

    // Attribution comes ONLY from DCGM's kubernetes integration, which reports
    // the consuming pod as exported_pod. The plain `pod` label is Prometheus's
    // own scrape-target metadata — the dcgm-exporter pod itself — so falling
    // back to it attributed every GPU to the monitoring agent and reported a
    // wholly idle fleet as fully allocated and wasted.
    let pod = m.exported_pod || null;
    let namespace = m.exported_namespace || null;
    let container = m.exported_container || null;
    // Belt and braces: the exporter is never a GPU consumer.
    if (namespace && /^(nvidia-gpu-operator|gpu-operator(-resources)?)$/.test(namespace)) {
      pod = null; namespace = null; container = null;
    }

    gpus.push({
      id: key,
      node: m.Hostname || m.instance || m.node || "unknown",
      index: m.gpu ?? m.device ?? null,
      model: m.modelName || m.device_model || "GPU",
      uuid: m.UUID || m.uuid || null,
      utilPct,
      memUsedMiB: memUsed,
      memTotalMiB: memTotal,
      memPct: (memUsed != null && memTotal) ? Math.round((memUsed / memTotal) * 100) : null,
      tempC,
      powerW: iPower.get(key),
      smClockMHz: iSm.get(key),
      memClockMHz: iMem.get(key),
      smActivePct: iSmAct.get(key) != null ? Math.round(iSmAct.get(key) * 100) : null,
      tensorActivePct: iTensor.get(key) != null ? Math.round(iTensor.get(key) * 100) : null,
      xidError: xidErr,
      eccSbe: iSbe.get(key),
      eccDbe,
      pod,
      namespace,
      container,
      allocated: !!pod,
      status: gpuStatus({ tempC, xid: xidErr, eccDbe }),
    });
  }

  // Aggregate the fleet summary.
  const nodeMap = new Map();
  const modelCounts = {};
  let sumUtil = 0, maxUtil = 0, allocated = 0, idleAllocated = 0;
  let memUsedTot = 0, memTot = 0, maxTemp = 0, powerTot = 0;
  let xidCount = 0, eccCount = 0, unhealthy = 0;
  const waste = [];

  for (const g of gpus) {
    sumUtil += g.utilPct || 0;
    if ((g.utilPct || 0) > maxUtil) maxUtil = g.utilPct;
    modelCounts[g.model] = (modelCounts[g.model] || 0) + 1;
    if (g.memUsedMiB != null) memUsedTot += g.memUsedMiB;
    if (g.memTotalMiB != null) memTot += g.memTotalMiB;
    if (g.tempC != null && g.tempC > maxTemp) maxTemp = g.tempC;
    if (g.powerW != null) powerTot += g.powerW;
    if (g.xidError != null && g.xidError > 0) xidCount++;
    if (g.eccDbe != null && g.eccDbe > 0) eccCount++;
    if (g.status !== "healthy") unhealthy++;

    const nm = nodeMap.get(g.node) || { name: g.node, gpuCount: 0, sumUtil: 0, model: g.model };
    nm.gpuCount++; nm.sumUtil += g.utilPct || 0;
    nodeMap.set(g.node, nm);

    if (g.allocated) {
      allocated++;
      // Idle-but-allocated: reserved to a pod yet effectively unused → the
      // clearest GPU cost-waste signal (GPUs are the most expensive resource in
      // the fleet, and a claimed-but-idle card blocks other workloads).
      if ((g.utilPct == null || g.utilPct < 5) && (g.smActivePct == null || g.smActivePct < 5)) {
        idleAllocated++;
        waste.push({ id: g.id, node: g.node, model: g.model, pod: g.pod, namespace: g.namespace, utilPct: g.utilPct });
      }
    }
  }

  const nodes = [...nodeMap.values()].map((n) => ({
    name: n.name,
    gpuCount: n.gpuCount,
    avgUtil: n.gpuCount ? Math.round(n.sumUtil / n.gpuCount) : 0,
    model: n.model,
  })).sort((a, b) => b.gpuCount - a.gpuCount);

  const total = gpus.length;
  const fleetHealth = (xidCount > 0 || eccCount > 0 || maxTemp >= 87)
    ? "critical"
    : (unhealthy > 0 || maxTemp >= 80) ? "warning" : "healthy";

  return {
    available: true,
    telemetry: "live",
    inventory: inv,
    // The API server is authoritative on allocation — it IS the scheduler's
    // record. DCGM attribution only says WHICH pod holds a card, and only when
    // its kubernetes integration is configured. Where they disagree, trust
    // Kubernetes; otherwise the panel contradicts itself on screen.
    insights: buildInsights(inv, {
      idleAllocated: inv.totalAllocated > 0 ? idleAllocated : 0,
      idleDetail: waste,
    }),
    summary: {
      totalGpus: total,
      nodes: nodeMap.size,
      models: modelCounts,
      avgUtilPct: total ? Math.round(sumUtil / total) : 0,
      maxUtilPct: Math.round(maxUtil),
      allocatedGpus: inv.totalGpus > 0 ? inv.totalAllocated : allocated,
      unallocatedGpus: inv.totalGpus > 0 ? inv.totalFree : (total - allocated),
      idleAllocatedGpus: inv.totalAllocated > 0 ? idleAllocated : 0,
      memUsedGiB: Math.round((memUsedTot / 1024) * 10) / 10,
      memTotalGiB: Math.round((memTot / 1024) * 10) / 10,
      memPct: memTot ? Math.round((memUsedTot / memTot) * 100) : null,
      maxTempC: Math.round(maxTemp),
      totalPowerW: Math.round(powerTot),
      totalPowerKW: Math.round((powerTot / 1000) * 10) / 10,
      xidErrorGpus: xidCount,
      eccErrorGpus: eccCount,
      unhealthyGpus: unhealthy,
      health: fleetHealth,
    },
    gpus: gpus.sort((a, b) => (b.utilPct || 0) - (a.utilPct || 0)),
    nodes,
    waste: waste.sort((a, b) => (a.utilPct || 0) - (b.utilPct || 0)).slice(0, 20),
    generatedAt: new Date().toISOString(),
  };
}
