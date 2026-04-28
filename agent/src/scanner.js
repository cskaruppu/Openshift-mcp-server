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
    nodes: { total: 0, ready: 0, items: [] },
    pods: { total: 0, running: 0, failed: 0, pending: 0, issues: [] },
    deployments: { total: 0, available: 0, items: [] },
    events: { warnings: 0, recent: [] },
    metrics: null,
    namespaces: 0,
  };

  await Promise.allSettled([
    scanNodes(scan),
    scanPods(scan),
    scanDeployments(scan),
    scanEvents(scan),
    scanMetrics(scan),
    scanNamespaces(scan),
    platform === "openshift" ? scanOpenShift(scan) : Promise.resolve(),
  ]);

  return scan;
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
    });
  }
}

async function scanPods(scan) {
  const data = await k8sGet("/api/v1/pods");
  const pods = data.items || [];
  scan.pods.total = pods.length;

  for (const pod of pods) {
    const ns = pod.metadata?.namespace;
    if (ns?.startsWith("kube-") || ns === "kube-system") continue;

    const phase = pod.status?.phase;
    if (phase === "Running") scan.pods.running++;
    else if (phase === "Failed") scan.pods.failed++;
    else if (phase === "Pending") scan.pods.pending++;

    const containers = pod.status?.containerStatuses || [];
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
        });
      }
    }
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
    if (scan.events.recent.length < 25) {
      scan.events.recent.push({
        reason: evt.reason,
        message: (evt.message || "").substring(0, 200),
        namespace: evt.involvedObject?.namespace,
        object: `${evt.involvedObject?.kind}/${evt.involvedObject?.name}`,
        count: evt.count || 1,
        lastSeen: evt.lastTimestamp || evt.metadata.creationTimestamp,
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
    scan.namespaces = (data.items || []).length;
  } catch { /* skip */ }
}

async function scanOpenShift(scan) {
  try {
    const cv = await k8sGet("/apis/config.openshift.io/v1/clusterversions/version");
    scan.openshiftVersion = cv.status?.desired?.version;

    const co = await k8sGet("/apis/config.openshift.io/v1/clusteroperators");
    const operators = co.items || [];
    scan.clusterOperators = {
      total: operators.length,
      degraded: operators.filter((o) =>
        (o.status?.conditions || []).some((c) => c.type === "Degraded" && c.status === "True")
      ).length,
      progressing: operators.filter((o) =>
        (o.status?.conditions || []).some((c) => c.type === "Progressing" && c.status === "True")
      ).length,
    };
  } catch {
    // Not OpenShift or insufficient permissions
  }
}

export function clearTokenCache() {
  _token = null;
}
