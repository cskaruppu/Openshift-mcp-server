/**
 * Kubernetes Cluster Scanner.
 * Uses in-cluster service account to scan pods, nodes, events, deployments.
 */

import { readFile } from "node:fs/promises";

const API_URL = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
  : process.env.API_SERVER_URL || "https://kubernetes.default.svc";

let _token = null;
let _ca = null;

async function loadToken() {
  if (_token) return _token;
  try {
    _token = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
  } catch {
    _token = process.env.BEARER_TOKEN || null;
  }
  return _token;
}

async function loadCA() {
  if (_ca) return _ca;
  try {
    _ca = await readFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "utf8");
  } catch {
    _ca = null;
  }
  return _ca;
}

async function k8sGet(path, timeoutMs = 10000) {
  const tk = await loadToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_URL}${path}`, {
      signal: controller.signal,
      headers: {
        Authorization: tk ? `Bearer ${tk}` : undefined,
        Accept: "application/json",
      },
    });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function scanCluster(platform) {
  const scan = {
    timestamp: new Date().toISOString(),
    platform,
    kubernetesVersion: null,
    nodes: { total: 0, ready: 0, items: [] },
    pods: { total: 0, running: 0, failed: 0, pending: 0, issues: [], byNamespace: {} },
    deployments: { total: 0, available: 0, items: [] },
    events: { warnings: 0, recent: [] },
    metrics: null,
    namespaces: { total: 0, user: 0, system: 0, items: [] },
    clusterHealth: { status: "Healthy", apiServerHealthy: true },
    resourceSummary: { totalCPU: 0, totalMemoryGi: 0, allocatableCPU: 0, allocatableMemoryGi: 0 },
  };

  await Promise.allSettled([
    scanVersion(scan),
    scanNodes(scan),
    scanPods(scan),
    scanDeployments(scan),
    scanEvents(scan),
    scanMetrics(scan),
    scanNamespaces(scan),
    platform === "openshift" ? scanOpenShift(scan) : Promise.resolve(),
  ]);

  // Compute cluster health based on collected data
  computeClusterHealth(scan);

  return scan;
}

// Generic Kubernetes server version — works on every distribution
async function scanVersion(scan) {
  try {
    const v = await k8sGet("/version");
    // gitVersion looks like "v1.28.4+k3s1" or "v1.29.5"
    scan.kubernetesVersion = (v.gitVersion || `${v.major}.${v.minor}`).replace(/^v/, "");
  } catch {
    // /version may be restricted; fall back to node kubelet version later
  }
}

function parseCPU(cpuStr) {
  if (!cpuStr) return 0;
  if (cpuStr.endsWith("m")) return parseInt(cpuStr, 10) / 1000;
  return parseFloat(cpuStr) || 0;
}

function parseMemoryToGi(memStr) {
  if (!memStr) return 0;
  if (memStr.endsWith("Ki")) return parseInt(memStr, 10) / (1024 * 1024);
  if (memStr.endsWith("Mi")) return parseInt(memStr, 10) / 1024;
  if (memStr.endsWith("Gi")) return parseFloat(memStr);
  if (memStr.endsWith("Ti")) return parseFloat(memStr) * 1024;
  // Plain bytes
  return parseInt(memStr, 10) / (1024 * 1024 * 1024);
}

async function scanNodes(scan) {
  const data = await k8sGet("/api/v1/nodes");
  const nodes = data.items || [];
  scan.nodes.total = nodes.length;
  for (const node of nodes) {
    const conditions = node.status?.conditions || [];
    const ready = conditions.find((c) => c.type === "Ready");
    const isReady = ready?.status === "True";
    if (isReady) scan.nodes.ready++;

    const pressure = [];
    for (const c of conditions) {
      if (c.type !== "Ready" && c.status === "True") pressure.push(c.type);
    }

    const memoryPressureCond = conditions.find((c) => c.type === "MemoryPressure");
    const diskPressureCond = conditions.find((c) => c.type === "DiskPressure");
    const pidPressureCond = conditions.find((c) => c.type === "PIDPressure");

    const cpuCores = parseCPU(node.status?.capacity?.cpu);
    const memoryGi = parseMemoryToGi(node.status?.capacity?.memory);
    const allocatableCPU = parseCPU(node.status?.allocatable?.cpu);
    const allocatableMemoryGi = parseMemoryToGi(node.status?.allocatable?.memory);

    // Accumulate resource summary
    scan.resourceSummary.totalCPU += cpuCores;
    scan.resourceSummary.totalMemoryGi += memoryGi;
    scan.resourceSummary.allocatableCPU += allocatableCPU;
    scan.resourceSummary.allocatableMemoryGi += allocatableMemoryGi;

    scan.nodes.items.push({
      name: node.metadata.name,
      ready: isReady,
      roles: Object.keys(node.metadata.labels || {})
        .filter((l) => l.startsWith("node-role.kubernetes.io/"))
        .map((l) => l.split("/")[1]),
      kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
      os: node.status?.nodeInfo?.osImage,
      capacity: {
        cpu: node.status?.capacity?.cpu,
        memory: node.status?.capacity?.memory,
        pods: node.status?.capacity?.pods,
      },
      pressure,
      memoryPressure: memoryPressureCond?.status === "True",
      diskPressure: diskPressureCond?.status === "True",
      pidPressure: pidPressureCond?.status === "True",
      maxPods: parseInt(node.status?.capacity?.pods, 10) || 0,
      cpu: cpuCores,
      memory: Math.round(memoryGi * 100) / 100,
    });
  }

  // Round resource summary values
  scan.resourceSummary.totalCPU = Math.round(scan.resourceSummary.totalCPU * 100) / 100;
  scan.resourceSummary.totalMemoryGi = Math.round(scan.resourceSummary.totalMemoryGi * 100) / 100;
  scan.resourceSummary.allocatableCPU = Math.round(scan.resourceSummary.allocatableCPU * 100) / 100;
  scan.resourceSummary.allocatableMemoryGi = Math.round(scan.resourceSummary.allocatableMemoryGi * 100) / 100;
}

async function scanPods(scan) {
  const data = await k8sGet("/api/v1/pods");
  const pods = data.items || [];
  scan.pods.total = pods.length;

  const nsCounts = {};

  for (const pod of pods) {
    const ns = pod.metadata?.namespace;

    // Track per-namespace pod breakdown for all namespaces
    if (ns) {
      if (!nsCounts[ns]) nsCounts[ns] = { total: 0, running: 0, failed: 0, pending: 0 };
      nsCounts[ns].total++;
    }

    if (ns?.startsWith("kube-") || ns === "kube-system") continue;

    const phase = pod.status?.phase;
    if (phase === "Running") {
      scan.pods.running++;
      if (ns && nsCounts[ns]) nsCounts[ns].running++;
    } else if (phase === "Failed") {
      scan.pods.failed++;
      if (ns && nsCounts[ns]) nsCounts[ns].failed++;
    } else if (phase === "Pending") {
      scan.pods.pending++;
      if (ns && nsCounts[ns]) nsCounts[ns].pending++;
    }

    const containers = pod.status?.containerStatuses || [];
    const ownerRef = pod.metadata?.ownerReferences?.[0];
    const podCreation = pod.metadata?.creationTimestamp;
    const podAgeHours = podCreation
      ? Math.round((Date.now() - new Date(podCreation).getTime()) / (1000 * 60 * 60))
      : null;

    for (const c of containers) {
      const waiting = c.state?.waiting;
      const restarts = c.restartCount || 0;
      const lastTerminated = c.lastState?.terminated;

      let issue = null;
      if (waiting?.reason === "CrashLoopBackOff") {
        issue = { type: "CrashLoopBackOff", severity: 85 };
      } else if (waiting?.reason === "ImagePullBackOff" || waiting?.reason === "ErrImagePull") {
        issue = { type: "ImagePullBackOff", severity: 70 };
      } else if (lastTerminated?.reason === "OOMKilled") {
        issue = { type: "OOMKilled", severity: 90 };
      } else if (restarts > 10) {
        issue = { type: "HighRestartRate", severity: 60 };
      }

      if (issue) {
        scan.pods.issues.push({
          ...issue,
          namespace: ns,
          pod: pod.metadata.name,
          container: c.name,
          restarts,
          message: waiting?.message || lastTerminated?.reason || "",
          node: pod.spec?.nodeName || null,
          podAge: podAgeHours,
          ownerKind: ownerRef?.kind || null,
          ownerName: ownerRef?.name || null,
        });
      }
    }
  }

  // Build byNamespace: top 20 namespaces by pod count
  const sortedNs = Object.entries(nsCounts)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 20);
  scan.pods.byNamespace = {};
  for (const [nsName, counts] of sortedNs) {
    scan.pods.byNamespace[nsName] = counts;
  }
}

async function scanDeployments(scan) {
  const data = await k8sGet("/apis/apps/v1/deployments");
  const deps = data.items || [];
  scan.deployments.total = deps.length;

  for (const d of deps) {
    const ns = d.metadata?.namespace;
    if (ns?.startsWith("kube-")) continue;
    const desired = d.spec?.replicas || 0;
    const available = d.status?.availableReplicas || 0;
    if (available >= desired) scan.deployments.available++;

    if (desired > 0 && available < desired) {
      scan.deployments.items.push({
        name: d.metadata.name,
        namespace: ns,
        desired,
        available,
        ready: d.status?.readyReplicas || 0,
      });
    }
  }
}

async function scanEvents(scan) {
  const data = await k8sGet("/api/v1/events");
  const events = data.items || [];
  const now = Date.now();
  const thirtyMinAgo = now - 30 * 60 * 1000;

  for (const evt of events) {
    if (evt.type !== "Warning") continue;
    const ts = new Date(evt.lastTimestamp || evt.metadata.creationTimestamp).getTime();
    if (ts < thirtyMinAgo) continue;
    scan.events.warnings++;
    if (scan.events.recent.length < 50) {
      scan.events.recent.push({
        reason: evt.reason,
        message: (evt.message || "").substring(0, 200),
        namespace: evt.involvedObject?.namespace,
        object: `${evt.involvedObject?.kind}/${evt.involvedObject?.name}`,
        count: evt.count || 1,
        lastSeen: evt.lastTimestamp || evt.metadata.creationTimestamp,
        type: evt.type,
        source: evt.source?.component || null,
        involvedObject: {
          kind: evt.involvedObject?.kind || null,
          name: evt.involvedObject?.name || null,
        },
      });
    }
  }
}

async function scanMetrics(scan) {
  try {
    const data = await k8sGet("/apis/metrics.k8s.io/v1beta1/nodes");
    scan.metrics = { nodes: [] };
    for (const node of data.items || []) {
      scan.metrics.nodes.push({
        name: node.metadata.name,
        cpu: node.usage?.cpu,
        memory: node.usage?.memory,
      });
    }
  } catch {
    // metrics-server may not be installed
  }
}

async function scanNamespaces(scan) {
  try {
    const data = await k8sGet("/api/v1/namespaces");
    const items = data.items || [];
    scan.namespaces = { total: items.length, user: 0, system: 0, items: [] };

    for (const ns of items) {
      const name = ns.metadata?.name || "";
      const isSystem = name.startsWith("openshift-") || name.startsWith("kube-") || name === "default";
      if (isSystem) {
        scan.namespaces.system++;
      } else {
        scan.namespaces.user++;
      }
      scan.namespaces.items.push({
        name,
        status: ns.status?.phase || "Active",
        created: ns.metadata?.creationTimestamp || null,
        labels: ns.metadata?.labels || {},
      });
    }
  } catch { /* skip */ }
}

async function scanOpenShift(scan) {
  try {
    const cv = await k8sGet("/apis/config.openshift.io/v1/clusterversions/version");
    scan.openshiftVersion = cv.status?.desired?.version;

    const co = await k8sGet("/apis/config.openshift.io/v1/clusteroperators");
    const operators = co.items || [];

    let degradedCount = 0;
    let progressingCount = 0;
    const operatorItems = [];

    for (const op of operators) {
      const conditions = op.status?.conditions || [];
      const availableCond = conditions.find((c) => c.type === "Available");
      const degradedCond = conditions.find((c) => c.type === "Degraded");
      const progressingCond = conditions.find((c) => c.type === "Progressing");

      const isDegraded = degradedCond?.status === "True";
      const isProgressing = progressingCond?.status === "True";

      if (isDegraded) degradedCount++;
      if (isProgressing) progressingCount++;

      // Get version from status.versions where name === "operator"
      const versionEntry = (op.status?.versions || []).find((v) => v.name === "operator");

      operatorItems.push({
        name: op.metadata?.name,
        version: versionEntry?.version || null,
        available: availableCond?.status === "True",
        degraded: isDegraded,
        progressing: isProgressing,
        message: degradedCond?.message || progressingCond?.message || null,
      });
    }

    scan.clusterOperators = {
      total: operators.length,
      healthy: operators.length - degradedCount,
      degraded: degradedCount,
      progressing: progressingCount,
      items: operatorItems,
    };
  } catch {
    // Not OpenShift or insufficient permissions
  }
}

function computeClusterHealth(scan) {
  const degradedOps = scan.clusterOperators?.degraded || 0;
  const failedPods = scan.pods.failed || 0;
  const issueCount = scan.pods.issues?.length || 0;

  if (degradedOps >= 3 || failedPods >= 10) {
    scan.clusterHealth.status = "Critical";
  } else if (degradedOps >= 1 || failedPods >= 3 || issueCount >= 5) {
    scan.clusterHealth.status = "Warning";
  } else {
    scan.clusterHealth.status = "Healthy";
  }

  scan.clusterHealth.apiServerHealthy = true;
}

export function clearTokenCache() {
  _token = null;
}
