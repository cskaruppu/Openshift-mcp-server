import { ocpGet } from "../utils/openshift-client.js";
import { query as dbQuery } from "../utils/db.js";

const SYSTEM_NAMESPACES = new Set([
  "kube-system", "kube-public", "kube-node-lease",
  "openshift", "openshift-apiserver", "openshift-authentication",
  "openshift-cloud-controller-manager", "openshift-cloud-credential-operator",
  "openshift-cluster-csi-drivers", "openshift-cluster-machine-approver",
  "openshift-cluster-node-tuning-operator", "openshift-cluster-samples-operator",
  "openshift-cluster-storage-operator", "openshift-cluster-version",
  "openshift-config", "openshift-config-managed", "openshift-console",
  "openshift-console-operator", "openshift-controller-manager",
  "openshift-dns", "openshift-dns-operator", "openshift-etcd",
  "openshift-etcd-operator", "openshift-image-registry",
  "openshift-infra", "openshift-ingress", "openshift-ingress-canary",
  "openshift-ingress-operator", "openshift-insights",
  "openshift-kni-infra", "openshift-kube-apiserver",
  "openshift-kube-controller-manager", "openshift-kube-scheduler",
  "openshift-kube-storage-version-migrator", "openshift-machine-api",
  "openshift-machine-config-operator", "openshift-marketplace",
  "openshift-monitoring", "openshift-multus", "openshift-network-diagnostics",
  "openshift-network-operator", "openshift-node", "openshift-oauth-apiserver",
  "openshift-operator-lifecycle-manager", "openshift-operators",
  "openshift-ovn-kubernetes", "openshift-sdn", "openshift-service-ca",
  "openshift-service-ca-operator", "openshift-user-workload-monitoring",
]);

const MAX_SNAPSHOTS = 168;
const DB_SNAPSHOT_COUNT = 48;
const DB_KEY = "capacity_snapshots";

let _snapshots = [];

function parseCpu(s) {
  if (!s) return 0;
  if (typeof s === "number") return s;
  const str = String(s);
  if (str.endsWith("n")) return parseFloat(str) / 1e9;
  if (str.endsWith("u")) return parseFloat(str) / 1e6;
  if (str.endsWith("m")) return parseFloat(str) / 1000;
  return parseFloat(str) || 0;
}

function parseMem(s) {
  if (!s) return 0;
  if (typeof s === "number") return s;
  const str = String(s);
  const units = {
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1000, M: 1e6, G: 1e9, T: 1e12,
  };
  for (const [u, mult] of Object.entries(units)) {
    if (str.endsWith(u)) return parseFloat(str) * mult;
  }
  return parseFloat(str) || 0;
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0 };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const { x, y } of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function exhaustionDays(current, capacity, slopePerHour) {
  if (slopePerHour <= 0) return null;
  const remaining = capacity - current;
  if (remaining <= 0) return 0;
  const hours = remaining / slopePerHour;
  return Math.round((hours / 24) * 100) / 100;
}

async function persistSnapshots() {
  try {
    const toStore = _snapshots.slice(-DB_SNAPSHOT_COUNT);
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [DB_KEY, JSON.stringify(toStore)]
    );
  } catch {
    // DB persistence is best-effort
  }
}

async function loadSnapshotsFromDb() {
  try {
    const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [DB_KEY]);
    if (result?.rows?.length > 0) {
      const stored = result.rows[0].value;
      const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
      if (Array.isArray(parsed) && parsed.length > 0 && _snapshots.length === 0) {
        _snapshots = parsed;
      }
    }
  } catch {
    // Non-critical
  }
}

export async function captureSnapshot() {
  try {
    await loadSnapshotsFromDb();

    const [nodesResp, podsResp] = await Promise.all([
      ocpGet("/api/v1/nodes"),
      ocpGet("/api/v1/pods"),
    ]);

    const nodes = nodesResp.items || [];
    let totalAllocatableCpu = 0;
    let totalAllocatableMemory = 0;

    for (const node of nodes) {
      totalAllocatableCpu += parseCpu(node.status?.allocatable?.cpu);
      totalAllocatableMemory += parseMem(node.status?.allocatable?.memory);
    }

    const namespaceMap = {};
    const pods = (podsResp.items || []).filter(
      (p) => !SYSTEM_NAMESPACES.has(p.metadata?.namespace)
    );

    for (const pod of pods) {
      const ns = pod.metadata?.namespace;
      if (!ns) continue;

      if (!namespaceMap[ns]) {
        namespaceMap[ns] = {
          namespace: ns,
          usedCpu: 0,
          usedMemory: 0,
          requestedCpu: 0,
          requestedMemory: 0,
          limitsCpu: 0,
          limitsMemory: 0,
          podCount: 0,
        };
      }

      const entry = namespaceMap[ns];
      entry.podCount++;

      for (const container of pod.spec?.containers || []) {
        const res = container.resources || {};
        entry.requestedCpu += parseCpu(res.requests?.cpu);
        entry.requestedMemory += parseMem(res.requests?.memory);
        entry.limitsCpu += parseCpu(res.limits?.cpu);
        entry.limitsMemory += parseMem(res.limits?.memory);
      }

      for (const cs of pod.status?.containerStatuses || []) {
        if (cs.state?.running) {
          const container = (pod.spec?.containers || []).find((c) => c.name === cs.name);
          if (container) {
            entry.usedCpu += parseCpu(container.resources?.requests?.cpu);
            entry.usedMemory += parseMem(container.resources?.requests?.memory);
          }
        }
      }
    }

    let quotas = {};
    try {
      const quotaResp = await ocpGet("/api/v1/resourcequotas");
      for (const q of quotaResp.items || []) {
        const ns = q.metadata?.namespace;
        if (!ns || SYSTEM_NAMESPACES.has(ns)) continue;
        if (!quotas[ns]) quotas[ns] = { cpuLimit: 0, memoryLimit: 0 };
        quotas[ns].cpuLimit += parseCpu(q.spec?.hard?.["limits.cpu"] || q.spec?.hard?.cpu);
        quotas[ns].memoryLimit += parseMem(q.spec?.hard?.["limits.memory"] || q.spec?.hard?.memory);
      }
    } catch {
      // ResourceQuotas may not be available
    }

    const snapshot = {
      timestamp: new Date().toISOString(),
      cluster: {
        totalCpu: totalAllocatableCpu,
        totalMemory: totalAllocatableMemory,
        nodeCount: nodes.length,
      },
      namespaces: Object.values(namespaceMap),
      quotas,
    };

    _snapshots.push(snapshot);
    if (_snapshots.length > MAX_SNAPSHOTS) {
      _snapshots = _snapshots.slice(-MAX_SNAPSHOTS);
    }

    await persistSnapshots();

    return snapshot;
  } catch (err) {
    throw new Error(`Failed to capture capacity snapshot: ${err.message}`);
  }
}

export function getCapacityForecast() {
  if (_snapshots.length < 2) {
    return {
      cluster: {
        totalCPU: 0, usedCPU: 0,
        totalMemory: 0, usedMemory: 0,
        cpuExhaustionDays: null, memoryExhaustionDays: null,
      },
      namespaces: [],
      snapshotCount: _snapshots.length,
      message: "Insufficient data. At least 2 snapshots are required for forecasting.",
    };
  }

  const baseTime = new Date(_snapshots[0].timestamp).getTime();

  let clusterCpuPoints = [];
  let clusterMemPoints = [];

  const nsDataMap = {};

  for (const snap of _snapshots) {
    const hoursElapsed = (new Date(snap.timestamp).getTime() - baseTime) / 3600000;

    let totalUsedCpu = 0;
    let totalUsedMem = 0;

    for (const nsEntry of snap.namespaces || []) {
      totalUsedCpu += nsEntry.requestedCpu;
      totalUsedMem += nsEntry.requestedMemory;

      if (!nsDataMap[nsEntry.namespace]) {
        nsDataMap[nsEntry.namespace] = { cpuPoints: [], memPoints: [] };
      }
      nsDataMap[nsEntry.namespace].cpuPoints.push({ x: hoursElapsed, y: nsEntry.requestedCpu });
      nsDataMap[nsEntry.namespace].memPoints.push({ x: hoursElapsed, y: nsEntry.requestedMemory });
    }

    clusterCpuPoints.push({ x: hoursElapsed, y: totalUsedCpu });
    clusterMemPoints.push({ x: hoursElapsed, y: totalUsedMem });
  }

  const latestSnap = _snapshots[_snapshots.length - 1];
  const clusterTotalCpu = latestSnap.cluster.totalCpu;
  const clusterTotalMem = latestSnap.cluster.totalMemory;

  const cpuReg = linearRegression(clusterCpuPoints);
  const memReg = linearRegression(clusterMemPoints);

  const latestUsedCpu = clusterCpuPoints[clusterCpuPoints.length - 1].y;
  const latestUsedMem = clusterMemPoints[clusterMemPoints.length - 1].y;

  const cluster = {
    totalCPU: clusterTotalCpu,
    usedCPU: latestUsedCpu,
    totalMemory: clusterTotalMem,
    usedMemory: latestUsedMem,
    cpuExhaustionDays: exhaustionDays(latestUsedCpu, clusterTotalCpu, cpuReg.slope),
    memoryExhaustionDays: exhaustionDays(latestUsedMem, clusterTotalMem, memReg.slope),
  };

  const namespaces = [];
  for (const [ns, data] of Object.entries(nsDataMap)) {
    const nsCpuReg = linearRegression(data.cpuPoints);
    const nsMemReg = linearRegression(data.memPoints);

    const latestCpu = data.cpuPoints[data.cpuPoints.length - 1].y;
    const latestMem = data.memPoints[data.memPoints.length - 1].y;

    const quota = latestSnap.quotas?.[ns];
    const cpuCap = quota?.cpuLimit > 0 ? quota.cpuLimit : clusterTotalCpu;
    const memCap = quota?.memoryLimit > 0 ? quota.memoryLimit : clusterTotalMem;

    namespaces.push({
      namespace: ns,
      cpuUsedPct: cpuCap > 0 ? Math.round((latestCpu / cpuCap) * 10000) / 100 : 0,
      memUsedPct: memCap > 0 ? Math.round((latestMem / memCap) * 10000) / 100 : 0,
      cpuTrend: Math.round(nsCpuReg.slope * 1e6) / 1e6,
      memTrend: Math.round(nsMemReg.slope * 100) / 100,
      cpuExhaustionDays: exhaustionDays(latestCpu, cpuCap, nsCpuReg.slope),
      memExhaustionDays: exhaustionDays(latestMem, memCap, nsMemReg.slope),
    });
  }

  namespaces.sort((a, b) => {
    const aUrgency = Math.min(a.cpuExhaustionDays ?? Infinity, a.memExhaustionDays ?? Infinity);
    const bUrgency = Math.min(b.cpuExhaustionDays ?? Infinity, b.memExhaustionDays ?? Infinity);
    return aUrgency - bUrgency;
  });

  return { cluster, namespaces, snapshotCount: _snapshots.length };
}

export function getNamespaceForecasts() {
  const forecast = getCapacityForecast();
  return forecast.namespaces;
}

export function getCapacityHistory() {
  return _snapshots;
}
