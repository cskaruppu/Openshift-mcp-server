/**
 * MCP-compatible tools for on-demand K8s API queries.
 *
 * Each tool is a function that calls the Kubernetes API using the same
 * in-cluster authentication as the scanner. Tools are exposed to the hub
 * via the bidirectional bridge so that MCP clients can invoke them.
 *
 * Zero npm dependencies — uses native fetch() (Node 18+).
 */

import { readFile } from "node:fs/promises";

// ── K8s API plumbing (mirrors scanner.js) ────────────────────────────

const API_URL = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
  : process.env.API_SERVER_URL || "https://kubernetes.default.svc";

const PLATFORM = process.env.CLUSTER_PLATFORM || "k8s";

// Remote actions (writes) are OFF by default — zero-trust posture.
// Enable per-cluster by setting ALLOW_REMOTE_ACTIONS=true in the agent
// ConfigMap AND granting the scoped write RBAC in the ClusterRole.
const WRITES_ENABLED = process.env.ALLOW_REMOTE_ACTIONS === "true";

let _token = null;

async function loadToken() {
  if (_token) return _token;
  try {
    _token = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
  } catch {
    _token = process.env.BEARER_TOKEN || null;
  }
  return _token;
}

/**
 * Lightweight GET against the K8s API server.
 * For log endpoints the response is plain text, so `asText` can be set.
 */
async function k8sGet(path, timeoutMs = 10000, asText = false) {
  const tk = await loadToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_URL}${path}`, {
      signal: controller.signal,
      headers: {
        Authorization: tk ? `Bearer ${tk}` : undefined,
        Accept: asText ? "text/plain" : "application/json",
      },
    });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return asText ? await resp.text() : await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write request against the K8s API server (PATCH / POST / DELETE).
 * `patchType` selects the Content-Type for PATCH operations.
 */
async function k8sWrite(method, path, body, patchType = "merge", timeoutMs = 15000) {
  const tk = await loadToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Authorization: tk ? `Bearer ${tk}` : undefined,
    Accept: "application/json",
  };
  if (method === "PATCH") {
    headers["Content-Type"] =
      patchType === "strategic" ? "application/strategic-merge-patch+json"
      : patchType === "json" ? "application/json-patch+json"
      : "application/merge-patch+json";
  } else if (body) {
    headers["Content-Type"] = "application/json";
  }
  try {
    const resp = await fetch(`${API_URL}${path}`, {
      method,
      signal: controller.signal,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(`${resp.status} ${data?.message || resp.statusText}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function assertWritesEnabled() {
  if (!WRITES_ENABLED) {
    throw new Error(
      "Remote actions are disabled on this cluster. Set ALLOW_REMOTE_ACTIONS=true in the agent ConfigMap and grant write RBAC to enable."
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseCPU(cpuStr) {
  if (!cpuStr) return 0;
  if (cpuStr.endsWith("m")) return parseInt(cpuStr, 10) / 1000;
  if (cpuStr.endsWith("n")) return parseInt(cpuStr, 10) / 1e9;
  return parseFloat(cpuStr) || 0;
}

function parseMemoryToGi(memStr) {
  if (!memStr) return 0;
  if (memStr.endsWith("Ki")) return parseInt(memStr, 10) / (1024 * 1024);
  if (memStr.endsWith("Mi")) return parseInt(memStr, 10) / 1024;
  if (memStr.endsWith("Gi")) return parseFloat(memStr);
  if (memStr.endsWith("Ti")) return parseFloat(memStr) * 1024;
  return parseInt(memStr, 10) / (1024 * 1024 * 1024);
}

async function isOpenShift() {
  if (PLATFORM === "openshift") return true;
  try {
    await k8sGet("/apis/config.openshift.io/v1", 5000);
    return true;
  } catch {
    return false;
  }
}

// Map of common resource kinds to their API paths.
const RESOURCE_MAP = {
  pod:                   { base: "/api/v1",                        resource: "pods",                  namespaced: true },
  pods:                  { base: "/api/v1",                        resource: "pods",                  namespaced: true },
  service:               { base: "/api/v1",                        resource: "services",              namespaced: true },
  services:              { base: "/api/v1",                        resource: "services",              namespaced: true },
  configmap:             { base: "/api/v1",                        resource: "configmaps",            namespaced: true },
  configmaps:            { base: "/api/v1",                        resource: "configmaps",            namespaced: true },
  secret:                { base: "/api/v1",                        resource: "secrets",               namespaced: true },
  secrets:               { base: "/api/v1",                        resource: "secrets",               namespaced: true },
  namespace:             { base: "/api/v1",                        resource: "namespaces",            namespaced: false },
  namespaces:            { base: "/api/v1",                        resource: "namespaces",            namespaced: false },
  node:                  { base: "/api/v1",                        resource: "nodes",                 namespaced: false },
  nodes:                 { base: "/api/v1",                        resource: "nodes",                 namespaced: false },
  event:                 { base: "/api/v1",                        resource: "events",                namespaced: true },
  events:                { base: "/api/v1",                        resource: "events",                namespaced: true },
  persistentvolume:      { base: "/api/v1",                        resource: "persistentvolumes",     namespaced: false },
  persistentvolumes:     { base: "/api/v1",                        resource: "persistentvolumes",     namespaced: false },
  persistentvolumeclaim: { base: "/api/v1",                        resource: "persistentvolumeclaims", namespaced: true },
  persistentvolumeclaims:{ base: "/api/v1",                        resource: "persistentvolumeclaims", namespaced: true },
  serviceaccount:        { base: "/api/v1",                        resource: "serviceaccounts",       namespaced: true },
  serviceaccounts:       { base: "/api/v1",                        resource: "serviceaccounts",       namespaced: true },
  deployment:            { base: "/apis/apps/v1",                  resource: "deployments",           namespaced: true },
  deployments:           { base: "/apis/apps/v1",                  resource: "deployments",           namespaced: true },
  statefulset:           { base: "/apis/apps/v1",                  resource: "statefulsets",          namespaced: true },
  statefulsets:          { base: "/apis/apps/v1",                  resource: "statefulsets",          namespaced: true },
  daemonset:             { base: "/apis/apps/v1",                  resource: "daemonsets",            namespaced: true },
  daemonsets:            { base: "/apis/apps/v1",                  resource: "daemonsets",            namespaced: true },
  replicaset:            { base: "/apis/apps/v1",                  resource: "replicasets",           namespaced: true },
  replicasets:           { base: "/apis/apps/v1",                  resource: "replicasets",           namespaced: true },
  job:                   { base: "/apis/batch/v1",                 resource: "jobs",                  namespaced: true },
  jobs:                  { base: "/apis/batch/v1",                 resource: "jobs",                  namespaced: true },
  cronjob:               { base: "/apis/batch/v1",                 resource: "cronjobs",              namespaced: true },
  cronjobs:              { base: "/apis/batch/v1",                 resource: "cronjobs",              namespaced: true },
  ingress:               { base: "/apis/networking.k8s.io/v1",     resource: "ingresses",             namespaced: true },
  ingresses:             { base: "/apis/networking.k8s.io/v1",     resource: "ingresses",             namespaced: true },
  networkpolicy:         { base: "/apis/networking.k8s.io/v1",     resource: "networkpolicies",       namespaced: true },
  networkpolicies:       { base: "/apis/networking.k8s.io/v1",     resource: "networkpolicies",       namespaced: true },
  clusterrole:           { base: "/apis/rbac.authorization.k8s.io/v1", resource: "clusterroles",     namespaced: false },
  clusterroles:          { base: "/apis/rbac.authorization.k8s.io/v1", resource: "clusterroles",     namespaced: false },
  clusterrolebinding:    { base: "/apis/rbac.authorization.k8s.io/v1", resource: "clusterrolebindings", namespaced: false },
  clusterrolebindings:   { base: "/apis/rbac.authorization.k8s.io/v1", resource: "clusterrolebindings", namespaced: false },
  role:                  { base: "/apis/rbac.authorization.k8s.io/v1", resource: "roles",            namespaced: true },
  roles:                 { base: "/apis/rbac.authorization.k8s.io/v1", resource: "roles",            namespaced: true },
  rolebinding:           { base: "/apis/rbac.authorization.k8s.io/v1", resource: "rolebindings",     namespaced: true },
  rolebindings:          { base: "/apis/rbac.authorization.k8s.io/v1", resource: "rolebindings",     namespaced: true },
  storageclass:          { base: "/apis/storage.k8s.io/v1",        resource: "storageclasses",       namespaced: false },
  storageclasses:        { base: "/apis/storage.k8s.io/v1",        resource: "storageclasses",       namespaced: false },
  route:                 { base: "/apis/route.openshift.io/v1",    resource: "routes",               namespaced: true },
  routes:                { base: "/apis/route.openshift.io/v1",    resource: "routes",               namespaced: true },
  clusteroperator:       { base: "/apis/config.openshift.io/v1",   resource: "clusteroperators",     namespaced: false },
  clusteroperators:      { base: "/apis/config.openshift.io/v1",   resource: "clusteroperators",     namespaced: false },
};

function buildResourcePath(kind, namespace, name) {
  const entry = RESOURCE_MAP[kind.toLowerCase()];
  if (!entry) throw new Error(`Unknown resource kind: ${kind}`);

  let path;
  if (entry.namespaced && namespace) {
    path = `${entry.base}/namespaces/${namespace}/${entry.resource}`;
  } else {
    path = `${entry.base}/${entry.resource}`;
  }
  if (name) path += `/${name}`;
  return path;
}

// ── Tool catalogue ───────────────────────────────────────────────────

export const TOOLS = {
  get_cluster_summary: {
    description: "Get cluster health summary: version, node count, health status",
    parameters: {},
  },
  get_nodes: {
    description: "List all nodes with status, roles, capacity, and conditions",
    parameters: {},
  },
  get_pods: {
    description: "List pods, optionally filtered by namespace",
    parameters: { namespace: { type: "string", description: "Namespace filter (optional)" } },
  },
  get_pod_issues: {
    description: "Get pods with issues (CrashLoopBackOff, OOMKilled, ImagePullBackOff, etc.)",
    parameters: {},
  },
  get_namespaces: {
    description: "List all namespaces with status and pod counts",
    parameters: {},
  },
  get_events: {
    description: "Get recent warning events",
    parameters: {
      namespace: { type: "string", description: "Namespace filter (optional)" },
      limit: { type: "number", description: "Max events (default 50)" },
    },
  },
  get_operators: {
    description: "List OpenShift ClusterOperators with health status (OpenShift only)",
    parameters: {},
  },
  get_metrics: {
    description: "Get node CPU and memory metrics from metrics-server",
    parameters: {},
  },
  describe_resource: {
    description: "Describe a specific Kubernetes resource",
    parameters: {
      kind: { type: "string", required: true },
      name: { type: "string", required: true },
      namespace: { type: "string" },
    },
  },
  get_logs: {
    description: "Get logs from a specific pod",
    parameters: {
      name: { type: "string", required: true },
      namespace: { type: "string", required: true },
      container: { type: "string" },
      tail: { type: "number" },
      previous: { type: "boolean" },
    },
  },
  list_resources: {
    description: "List any Kubernetes resource type",
    parameters: {
      kind: { type: "string", required: true },
      namespace: { type: "string" },
      labelSelector: { type: "string" },
    },
  },
  // ── Write tools (require ALLOW_REMOTE_ACTIONS=true + write RBAC) ──
  scale_workload: {
    description: "Scale a deployment or statefulset to N replicas (requires remote actions enabled)",
    parameters: {
      kind: { type: "string", description: "deployment | statefulset" },
      name: { type: "string", required: true },
      namespace: { type: "string", required: true },
      replicas: { type: "number", required: true },
    },
    mutating: true,
  },
  restart_workload: {
    description: "Rolling-restart a deployment/statefulset/daemonset (requires remote actions enabled)",
    parameters: {
      kind: { type: "string", description: "deployment | statefulset | daemonset" },
      name: { type: "string", required: true },
      namespace: { type: "string", required: true },
    },
    mutating: true,
  },
  delete_pod: {
    description: "Delete (restart) a pod (requires remote actions enabled)",
    parameters: {
      name: { type: "string", required: true },
      namespace: { type: "string", required: true },
    },
    mutating: true,
  },
  cordon_node: {
    description: "Cordon or uncordon a node (requires remote actions enabled)",
    parameters: {
      name: { type: "string", required: true },
      uncordon: { type: "boolean", description: "true to uncordon" },
    },
    mutating: true,
  },
};

// ── Tool implementations ─────────────────────────────────────────────

async function toolGetClusterSummary() {
  const [versionData, nodesData] = await Promise.all([
    k8sGet("/version").catch(() => null),
    k8sGet("/api/v1/nodes"),
  ]);

  const nodes = nodesData.items || [];
  const total = nodes.length;
  let ready = 0;
  for (const node of nodes) {
    const conds = node.status?.conditions || [];
    if (conds.find((c) => c.type === "Ready")?.status === "True") ready++;
  }

  let platform = PLATFORM;
  let openshiftVersion = null;
  const oc = await isOpenShift();
  if (oc) {
    platform = "openshift";
    try {
      const cv = await k8sGet("/apis/config.openshift.io/v1/clusterversions/version");
      openshiftVersion = cv.status?.desired?.version || null;
    } catch { /* not available */ }
  }

  const kubernetesVersion = versionData
    ? (versionData.gitVersion || `${versionData.major}.${versionData.minor}`).replace(/^v/, "")
    : null;

  // Determine health
  let health = "Healthy";
  if (ready === 0 && total > 0) health = "Critical";
  else if (ready < total) health = "Warning";

  return {
    version: openshiftVersion || kubernetesVersion,
    platform,
    health,
    nodes: { total, ready },
    kubernetesVersion,
    openshiftVersion,
  };
}

async function toolGetNodes() {
  const data = await k8sGet("/api/v1/nodes");
  const nodes = data.items || [];
  return nodes.map((node) => {
    const conditions = node.status?.conditions || [];
    const readyCond = conditions.find((c) => c.type === "Ready");
    return {
      name: node.metadata.name,
      roles: Object.keys(node.metadata.labels || {})
        .filter((l) => l.startsWith("node-role.kubernetes.io/"))
        .map((l) => l.split("/")[1]),
      ready: readyCond?.status === "True",
      cpu: parseCPU(node.status?.capacity?.cpu),
      memory: Math.round(parseMemoryToGi(node.status?.capacity?.memory) * 100) / 100,
      maxPods: parseInt(node.status?.capacity?.pods, 10) || 0,
      kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
      osImage: node.status?.nodeInfo?.osImage,
      conditions: {
        memoryPressure: conditions.find((c) => c.type === "MemoryPressure")?.status === "True",
        diskPressure: conditions.find((c) => c.type === "DiskPressure")?.status === "True",
        pidPressure: conditions.find((c) => c.type === "PIDPressure")?.status === "True",
      },
    };
  });
}

async function toolGetPods({ namespace } = {}) {
  const path = namespace
    ? `/api/v1/namespaces/${namespace}/pods`
    : "/api/v1/pods";
  const data = await k8sGet(path);
  const pods = data.items || [];

  let running = 0;
  let failed = 0;
  let pending = 0;
  const nonRunning = [];

  for (const pod of pods) {
    const phase = pod.status?.phase;
    if (phase === "Running") { running++; continue; }
    if (phase === "Failed") failed++;
    else if (phase === "Pending") pending++;

    if (nonRunning.length < 100) {
      const containers = (pod.status?.containerStatuses || []).map((c) => ({
        name: c.name,
        ready: c.ready || false,
        restarts: c.restartCount || 0,
        state: c.state?.waiting?.reason || c.state?.terminated?.reason || (c.state?.running ? "Running" : "Unknown"),
      }));
      nonRunning.push({
        name: pod.metadata.name,
        namespace: pod.metadata?.namespace,
        phase,
        node: pod.spec?.nodeName || null,
        restarts: containers.reduce((sum, c) => sum + c.restarts, 0),
        containers,
      });
    }
  }

  return {
    total: pods.length,
    running,
    failed,
    pending,
    items: nonRunning,
  };
}

async function toolGetPodIssues() {
  const data = await k8sGet("/api/v1/pods");
  const pods = data.items || [];
  const issues = [];

  for (const pod of pods) {
    const ns = pod.metadata?.namespace;
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
        issues.push({
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

  return issues;
}

async function toolGetNamespaces() {
  const data = await k8sGet("/api/v1/namespaces");
  const items = data.items || [];
  return items.map((ns) => {
    const name = ns.metadata?.name || "";
    return {
      name,
      status: ns.status?.phase || "Active",
      created: ns.metadata?.creationTimestamp || null,
      isSystem: name.startsWith("openshift-") || name.startsWith("kube-") || name === "default",
    };
  });
}

async function toolGetEvents({ namespace, limit } = {}) {
  const max = limit || 50;
  const basePath = namespace
    ? `/api/v1/namespaces/${namespace}/events`
    : "/api/v1/events";
  const path = `${basePath}?fieldSelector=type=Warning`;
  const data = await k8sGet(path);
  const events = data.items || [];

  // Sort by lastTimestamp descending
  events.sort((a, b) => {
    const tsA = new Date(a.lastTimestamp || a.metadata.creationTimestamp).getTime();
    const tsB = new Date(b.lastTimestamp || b.metadata.creationTimestamp).getTime();
    return tsB - tsA;
  });

  return events.slice(0, max).map((evt) => ({
    reason: evt.reason,
    message: (evt.message || "").substring(0, 200),
    namespace: evt.involvedObject?.namespace,
    object: `${evt.involvedObject?.kind}/${evt.involvedObject?.name}`,
    count: evt.count || 1,
    lastSeen: evt.lastTimestamp || evt.metadata.creationTimestamp,
    type: evt.type,
  }));
}

async function toolGetOperators() {
  const oc = await isOpenShift();
  if (!oc) return [];

  const data = await k8sGet("/apis/config.openshift.io/v1/clusteroperators");
  const operators = data.items || [];

  return operators.map((op) => {
    const conditions = op.status?.conditions || [];
    const availableCond = conditions.find((c) => c.type === "Available");
    const degradedCond = conditions.find((c) => c.type === "Degraded");
    const progressingCond = conditions.find((c) => c.type === "Progressing");
    const versionEntry = (op.status?.versions || []).find((v) => v.name === "operator");

    return {
      name: op.metadata?.name,
      version: versionEntry?.version || null,
      available: availableCond?.status === "True",
      degraded: degradedCond?.status === "True",
      progressing: progressingCond?.status === "True",
      message: degradedCond?.message || progressingCond?.message || null,
    };
  });
}

async function toolGetMetrics() {
  const data = await k8sGet("/apis/metrics.k8s.io/v1beta1/nodes");
  return (data.items || []).map((node) => ({
    name: node.metadata.name,
    cpu: node.usage?.cpu,
    cpuCores: parseCPU(node.usage?.cpu),
    memory: node.usage?.memory,
    memoryGi: Math.round(parseMemoryToGi(node.usage?.memory) * 100) / 100,
  }));
}

async function toolDescribeResource({ kind, name, namespace }) {
  if (!kind) throw new Error("Parameter 'kind' is required");
  if (!name) throw new Error("Parameter 'name' is required");

  const path = buildResourcePath(kind, namespace, name);
  return await k8sGet(path);
}

async function toolGetLogs({ name, namespace, container, tail, previous }) {
  if (!name) throw new Error("Parameter 'name' is required");
  if (!namespace) throw new Error("Parameter 'namespace' is required");

  const params = [];
  if (container) params.push(`container=${encodeURIComponent(container)}`);
  params.push(`tailLines=${tail || 100}`);
  if (previous) params.push("previous=true");

  const qs = params.length ? `?${params.join("&")}` : "";
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}/log${qs}`;
  const logs = await k8sGet(path, 15000, true);
  return { logs };
}

async function toolListResources({ kind, namespace, labelSelector }) {
  if (!kind) throw new Error("Parameter 'kind' is required");

  let path = buildResourcePath(kind, namespace, null);
  if (labelSelector) {
    path += `?labelSelector=${encodeURIComponent(labelSelector)}`;
  }
  const data = await k8sGet(path);
  const items = data.items || [];
  return items.map((item) => ({
    name: item.metadata?.name,
    namespace: item.metadata?.namespace || null,
    kind: item.kind || kind,
    created: item.metadata?.creationTimestamp || null,
    labels: item.metadata?.labels || {},
  }));
}

// ── Write tool implementations ───────────────────────────────────────

async function toolScaleWorkload({ kind, name, namespace, replicas }) {
  assertWritesEnabled();
  if (!name || !namespace) throw new Error("'name' and 'namespace' are required");
  if (replicas == null || replicas < 0) throw new Error("'replicas' must be >= 0");
  const k = (kind || "deployment").toLowerCase();
  const resource = k.startsWith("statefulset") ? "statefulsets" : "deployments";
  const path = `/apis/apps/v1/namespaces/${namespace}/${resource}/${name}/scale`;
  await k8sWrite("PATCH", path, { spec: { replicas: Number(replicas) } }, "merge");
  return { kind: resource, name, namespace, replicas: Number(replicas), action: "scaled" };
}

async function toolRestartWorkload({ kind, name, namespace }) {
  assertWritesEnabled();
  if (!name || !namespace) throw new Error("'name' and 'namespace' are required");
  const k = (kind || "deployment").toLowerCase();
  const resource = k.startsWith("statefulset") ? "statefulsets"
    : k.startsWith("daemonset") ? "daemonsets" : "deployments";
  const path = `/apis/apps/v1/namespaces/${namespace}/${resource}/${name}`;
  const patch = {
    spec: { template: { metadata: { annotations: {
      "tcs-agentic-ai/restartedAt": new Date().toISOString(),
    } } } },
  };
  await k8sWrite("PATCH", path, patch, "strategic");
  return { kind: resource, name, namespace, action: "rollout-restarted" };
}

async function toolDeletePod({ name, namespace }) {
  assertWritesEnabled();
  if (!name || !namespace) throw new Error("'name' and 'namespace' are required");
  const path = `/api/v1/namespaces/${namespace}/pods/${name}`;
  await k8sWrite("DELETE", path, null);
  return { name, namespace, action: "deleted" };
}

async function toolCordonNode({ name, uncordon }) {
  assertWritesEnabled();
  if (!name) throw new Error("'name' is required");
  const path = `/api/v1/nodes/${name}`;
  await k8sWrite("PATCH", path, { spec: { unschedulable: !uncordon } }, "merge");
  return { name, action: uncordon ? "uncordoned" : "cordoned" };
}

// ── Dispatch map ─────────────────────────────────────────────────────

const TOOL_FNS = {
  get_cluster_summary: toolGetClusterSummary,
  get_nodes:           toolGetNodes,
  get_pods:            toolGetPods,
  get_pod_issues:      toolGetPodIssues,
  get_namespaces:      toolGetNamespaces,
  get_events:          toolGetEvents,
  get_operators:       toolGetOperators,
  get_metrics:         toolGetMetrics,
  describe_resource:   toolDescribeResource,
  get_logs:            toolGetLogs,
  list_resources:      toolListResources,
  // Write tools (gated by ALLOW_REMOTE_ACTIONS)
  scale_workload:      toolScaleWorkload,
  restart_workload:    toolRestartWorkload,
  delete_pod:          toolDeletePod,
  cordon_node:         toolCordonNode,
};

export function writesEnabled() {
  return WRITES_ENABLED;
}

/**
 * Execute a named tool with the given arguments.
 * Returns { success, data } or { success, error }.
 */
export async function executeTool(toolName, args = {}) {
  const fn = TOOL_FNS[toolName];
  if (!fn) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }
  try {
    const data = await fn(args);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}
