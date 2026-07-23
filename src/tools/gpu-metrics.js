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

/** Run a PromQL instant query, returning [] on any failure (unreachable, 4xx). */
async function safeQuery(q) {
  try {
    return await promQuery(q);
  } catch {
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
 * Build a fleet-wide GPU overview from DCGM metrics.
 * @returns {Promise<object>} inventory + utilization + health, or { available:false }.
 */
export async function getGpuOverview() {
  // Utilization is the presence probe — if there are no GPU_UTIL series, there
  // is no DCGM exporter reporting and we treat GPUs as absent.
  const util = await safeQuery("DCGM_FI_DEV_GPU_UTIL");

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
    return {
      available: false,
      reason: "no-gpu-operator",
      message: "No GPU metrics found. Install the NVIDIA GPU Operator (or AMD device-metrics-exporter) so the DCGM exporter can publish DCGM_FI_* series to Prometheus.",
      docs: "https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/openshift/mirror-gpu-ocp-disconnected.html",
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

    // Pod attribution requires DCGM's kubernetes integration (exported_pod /
    // pod labels). Absent that, the GPU is "unattributed".
    const pod = m.exported_pod || m.pod || null;
    const namespace = m.exported_namespace || m.namespace || null;
    const container = m.exported_container || m.container || null;

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
    summary: {
      totalGpus: total,
      nodes: nodeMap.size,
      models: modelCounts,
      avgUtilPct: total ? Math.round(sumUtil / total) : 0,
      maxUtilPct: Math.round(maxUtil),
      allocatedGpus: allocated,
      unallocatedGpus: total - allocated,
      idleAllocatedGpus: idleAllocated,
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
