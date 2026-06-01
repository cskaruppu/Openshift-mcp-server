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
    // Advanced feature parity — each gracefully degrades if the
    // underlying API/CRD is not present on this platform.
    scanWorkloads(scan),
    scanSecurity(scan, platform),
    scanGitOps(scan),
    scanDR(scan),
    scanOptimization(scan),
    scanImageVulns(scan),
    scanRBAC(scan),
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

// Optional GET — returns { ok, data, status }. Never throws.
// Used for CRD-based features that may not be installed on every platform.
async function k8sGetOptional(path, timeoutMs = 10000) {
  try {
    const data = await k8sGet(path, timeoutMs);
    return { ok: true, data, status: 200 };
  } catch (err) {
    const m = (err.message || "").match(/^(\d{3})/);
    const status = m ? parseInt(m[1], 10) : 0;
    return { ok: false, data: null, status };
  }
}

// ---------------------------------------------------------------------------
// Workloads — deployments, statefulsets, daemonsets, services (portable)
// ---------------------------------------------------------------------------
async function scanWorkloads(scan) {
  scan.workloads = {
    deployments: 0, statefulsets: 0, daemonsets: 0,
    services: 0, ingresses: 0, routes: 0, items: [],
  };
  const [deps, sts, ds, svc, ing] = await Promise.all([
    k8sGetOptional("/apis/apps/v1/deployments"),
    k8sGetOptional("/apis/apps/v1/statefulsets"),
    k8sGetOptional("/apis/apps/v1/daemonsets"),
    k8sGetOptional("/api/v1/services"),
    k8sGetOptional("/apis/networking.k8s.io/v1/ingresses"),
  ]);
  const userNs = (n) => n && !n.startsWith("kube-") && !n.startsWith("openshift-");
  if (deps.ok) {
    const items = (deps.data.items || []).filter((d) => userNs(d.metadata?.namespace));
    scan.workloads.deployments = items.length;
    // Keep a capped list of the largest/most-relevant workloads
    for (const d of items.slice(0, 50)) {
      scan.workloads.items.push({
        kind: "Deployment", name: d.metadata.name, namespace: d.metadata.namespace,
        desired: d.spec?.replicas || 0, ready: d.status?.readyReplicas || 0,
        available: d.status?.availableReplicas || 0,
        images: (d.spec?.template?.spec?.containers || []).map((c) => c.image).filter(Boolean),
      });
    }
  }
  if (sts.ok) scan.workloads.statefulsets = (sts.data.items || []).filter((s) => userNs(s.metadata?.namespace)).length;
  if (ds.ok) scan.workloads.daemonsets = (ds.data.items || []).filter((s) => userNs(s.metadata?.namespace)).length;
  if (svc.ok) scan.workloads.services = (svc.data.items || []).filter((s) => userNs(s.metadata?.namespace)).length;
  if (ing.ok) scan.workloads.ingresses = (ing.data.items || []).filter((s) => userNs(s.metadata?.namespace)).length;
  // OpenShift Routes (optional)
  const routes = await k8sGetOptional("/apis/route.openshift.io/v1/routes");
  if (routes.ok) scan.workloads.routes = (routes.data.items || []).filter((s) => userNs(s.metadata?.namespace)).length;
}

// ---------------------------------------------------------------------------
// Security posture — privileged pods, root, missing limits, host access,
// cluster-admin bindings. Uses only core/RBAC APIs — works on every platform.
// ---------------------------------------------------------------------------
async function scanSecurity(scan, platform) {
  const sec = {
    available: true, score: 100,
    privilegedPods: 0, runAsRootPods: 0, hostNetworkPods: 0,
    hostPathPods: 0, noResourceLimits: 0, defaultSAPods: 0,
    clusterAdminBindings: 0, totalWorkloadPods: 0,
    findings: [],
  };
  const podsResp = await k8sGetOptional("/api/v1/pods");
  if (!podsResp.ok) { sec.available = false; scan.security = sec; return; }
  const pods = (podsResp.data.items || []).filter((p) => {
    const ns = p.metadata?.namespace || "";
    return !ns.startsWith("kube-") && !ns.startsWith("openshift-");
  });
  sec.totalWorkloadPods = pods.length;
  for (const p of pods) {
    const spec = p.spec || {};
    const containers = [...(spec.containers || []), ...(spec.initContainers || [])];
    if (spec.hostNetwork) sec.hostNetworkPods++;
    if ((spec.volumes || []).some((v) => v.hostPath)) sec.hostPathPods++;
    if (!spec.serviceAccountName || spec.serviceAccountName === "default") sec.defaultSAPods++;
    let privileged = false, root = false, noLimits = false;
    for (const c of containers) {
      const sc = c.securityContext || {};
      if (sc.privileged) privileged = true;
      if (sc.runAsUser === 0 || (sc.runAsNonRoot === false)) root = true;
      const r = c.resources || {};
      if (!r.limits || (!r.limits.cpu && !r.limits.memory)) noLimits = true;
    }
    if (privileged) sec.privilegedPods++;
    if (root) sec.runAsRootPods++;
    if (noLimits) sec.noResourceLimits++;
  }
  // RBAC: cluster-admin bindings (standard API)
  const crb = await k8sGetOptional("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings");
  if (crb.ok) {
    sec.clusterAdminBindings = (crb.data.items || []).filter(
      (b) => b.roleRef?.name === "cluster-admin"
    ).length;
  }
  // Score: deduct for risky configurations (capped at 0)
  let score = 100;
  const pct = (n) => (sec.totalWorkloadPods ? n / sec.totalWorkloadPods : 0);
  if (sec.privilegedPods) { score -= Math.min(25, Math.round(pct(sec.privilegedPods) * 50)); sec.findings.push({ severity: "high", title: `${sec.privilegedPods} privileged pod(s)`, detail: "Containers running with privileged security context" }); }
  if (sec.runAsRootPods) { score -= Math.min(20, Math.round(pct(sec.runAsRootPods) * 30)); sec.findings.push({ severity: "medium", title: `${sec.runAsRootPods} pod(s) running as root`, detail: "Set runAsNonRoot: true" }); }
  if (sec.hostNetworkPods) { score -= Math.min(15, sec.hostNetworkPods * 3); sec.findings.push({ severity: "high", title: `${sec.hostNetworkPods} pod(s) using host network`, detail: "Host network bypasses network policies" }); }
  if (sec.hostPathPods) { score -= Math.min(15, sec.hostPathPods * 3); sec.findings.push({ severity: "high", title: `${sec.hostPathPods} pod(s) mounting hostPath`, detail: "hostPath volumes expose the node filesystem" }); }
  if (sec.noResourceLimits) { score -= Math.min(15, Math.round(pct(sec.noResourceLimits) * 20)); sec.findings.push({ severity: "medium", title: `${sec.noResourceLimits} pod(s) without resource limits`, detail: "Unbounded pods can starve the node" }); }
  if (sec.clusterAdminBindings > 1) { score -= Math.min(10, (sec.clusterAdminBindings - 1) * 2); sec.findings.push({ severity: "medium", title: `${sec.clusterAdminBindings} cluster-admin bindings`, detail: "Limit cluster-admin to reduce blast radius" }); }
  sec.score = Math.max(0, score);
  scan.security = sec;
}

// ---------------------------------------------------------------------------
// GitOps — ArgoCD Applications (optional CRD). Portable: skipped if absent.
// ---------------------------------------------------------------------------
async function scanGitOps(scan) {
  const gitops = { installed: false, totalApps: 0, synced: 0, outOfSync: 0, healthy: 0, degraded: 0, apps: [] };
  // ArgoCD apps can live in any namespace; query cluster-wide
  const resp = await k8sGetOptional("/apis/argoproj.io/v1alpha1/applications");
  if (resp.ok) {
    gitops.installed = true;
    const apps = resp.data.items || [];
    gitops.totalApps = apps.length;
    for (const a of apps) {
      const sync = a.status?.sync?.status || "Unknown";
      const health = a.status?.health?.status || "Unknown";
      if (sync === "Synced") gitops.synced++; else if (sync === "OutOfSync") gitops.outOfSync++;
      if (health === "Healthy") gitops.healthy++; else if (health === "Degraded") gitops.degraded++;
      if (gitops.apps.length < 50) {
        gitops.apps.push({
          name: a.metadata?.name, namespace: a.metadata?.namespace,
          sync, health,
          destination: a.spec?.destination?.namespace || "—",
          repo: a.spec?.source?.repoURL || "—",
        });
      }
    }
  }
  scan.gitops = gitops;
}

// ---------------------------------------------------------------------------
// Disaster Recovery — Velero backups & schedules (optional CRD). Portable.
// ---------------------------------------------------------------------------
async function scanDR(scan) {
  const dr = { installed: false, totalBackups: 0, completed: 0, failed: 0, schedules: 0, lastBackup: null, backups: [] };
  const backups = await k8sGetOptional("/apis/velero.io/v1/backups");
  if (backups.ok) {
    dr.installed = true;
    const items = backups.data.items || [];
    dr.totalBackups = items.length;
    let latest = 0;
    for (const b of items) {
      const phase = b.status?.phase || "Unknown";
      if (phase === "Completed") dr.completed++;
      else if (phase === "Failed" || phase === "PartiallyFailed") dr.failed++;
      const ts = new Date(b.status?.completionTimestamp || b.metadata?.creationTimestamp || 0).getTime();
      if (ts > latest) { latest = ts; dr.lastBackup = b.status?.completionTimestamp || b.metadata?.creationTimestamp; }
      if (dr.backups.length < 30) {
        dr.backups.push({
          name: b.metadata?.name, phase,
          created: b.metadata?.creationTimestamp,
          completed: b.status?.completionTimestamp || null,
          errors: b.status?.errors || 0,
        });
      }
    }
    const sched = await k8sGetOptional("/apis/velero.io/v1/schedules");
    if (sched.ok) dr.schedules = (sched.data.items || []).length;
  }
  scan.dr = dr;
}

// ---------------------------------------------------------------------------
// Resource optimization — over/under-provisioned pods (requests vs metrics).
// Uses core API + metrics-server (optional). Portable.
// ---------------------------------------------------------------------------
async function scanOptimization(scan) {
  const opt = {
    available: true, metricsAvailable: true,
    totalPods: 0, podsNoRequests: 0, podsNoLimits: 0,
    overProvisioned: 0, underProvisioned: 0,
    wastedCPUcores: 0, wastedMemGi: 0,
    cpuHeadroom: 0, memHeadroom: 0,
    offenders: [],
  };
  const podsResp = await k8sGetOptional("/api/v1/pods");
  if (!podsResp.ok) { opt.available = false; scan.optimization = opt; return; }
  const pods = (podsResp.data.items || []).filter((p) => {
    const ns = p.metadata?.namespace || "";
    return !ns.startsWith("kube-") && !ns.startsWith("openshift-") && p.status?.phase === "Running";
  });
  opt.totalPods = pods.length;
  // Build a requests map for waste calc
  const reqMap = {};
  let clusterReqCpu = 0, clusterReqMem = 0;
  for (const p of pods) {
    const key = `${p.metadata.namespace}/${p.metadata.name}`;
    let reqCpu = 0, reqMem = 0, hasReq = true, hasLim = true;
    for (const c of p.spec?.containers || []) {
      const r = c.resources || {};
      if (!r.requests?.cpu && !r.requests?.memory) hasReq = false;
      if (!r.limits?.cpu && !r.limits?.memory) hasLim = false;
      reqCpu += parseCPU(r.requests?.cpu);
      reqMem += parseMemoryToGi(r.requests?.memory);
    }
    if (!hasReq) opt.podsNoRequests++;
    if (!hasLim) opt.podsNoLimits++;
    clusterReqCpu += reqCpu;
    clusterReqMem += reqMem;
    reqMap[key] = { reqCpu, reqMem, name: p.metadata.name, namespace: p.metadata.namespace };
  }
  // Cluster headroom — allocatable vs requested (from node resourceSummary)
  const allocCpu = scan.resourceSummary?.allocatableCPU || 0;
  const allocMem = scan.resourceSummary?.allocatableMemoryGi || 0;
  if (allocCpu > 0) opt.cpuHeadroom = Math.max(0, Math.round(((allocCpu - clusterReqCpu) / allocCpu) * 100));
  if (allocMem > 0) opt.memHeadroom = Math.max(0, Math.round(((allocMem - clusterReqMem) / allocMem) * 100));
  // Compare against actual usage from metrics-server (optional)
  const metricsResp = await k8sGetOptional("/apis/metrics.k8s.io/v1beta1/pods");
  if (metricsResp.ok) {
    for (const m of metricsResp.data.items || []) {
      const key = `${m.metadata.namespace}/${m.metadata.name}`;
      const req = reqMap[key];
      if (!req) continue;
      let useCpu = 0, useMem = 0;
      for (const c of m.containers || []) {
        useCpu += parseCPU(c.usage?.cpu);
        useMem += parseMemoryToGi(c.usage?.memory);
      }
      const wasteCpu = Math.max(0, req.reqCpu - useCpu);
      const wasteMem = Math.max(0, req.reqMem - useMem);
      opt.wastedCPUcores += wasteCpu;
      opt.wastedMemGi += wasteMem;
      // Over-provisioned: requesting much more than used
      if (req.reqCpu > 0.1 && useCpu < req.reqCpu * 0.5 && wasteCpu > 0.1) {
        opt.overProvisioned++;
        opt.offenders.push({
          name: req.name, ns: req.namespace, type: "over",
          cpuReq: Math.round(req.reqCpu * 1000), cpuUsed: Math.round(useCpu * 1000),
          cpuRecommend: Math.max(50, Math.round(useCpu * 1300)),
          memReq: Math.round(req.reqMem * 1024), memUsed: Math.round(useMem * 1024),
          wasteSort: wasteCpu,
          detail: `CPU: using ${Math.round(useCpu * 1000)}m, requested ${Math.round(req.reqCpu * 1000)}m`,
        });
      } else if (req.reqCpu > 0 && useCpu > req.reqCpu * 1.5) {
        // Under-provisioned: using much more than requested
        opt.underProvisioned++;
        opt.offenders.push({
          name: req.name, ns: req.namespace, type: "under",
          cpuReq: Math.round(req.reqCpu * 1000), cpuUsed: Math.round(useCpu * 1000),
          cpuRecommend: Math.max(50, Math.round(useCpu * 1300)),
          memReq: Math.round(req.reqMem * 1024), memUsed: Math.round(useMem * 1024),
          wasteSort: useCpu - req.reqCpu,
          detail: `CPU: using ${Math.round(useCpu * 1000)}m, requested ${Math.round(req.reqCpu * 1000)}m`,
        });
      }
    }
  } else {
    opt.metricsAvailable = false;
  }
  opt.wastedCPUcores = Math.round(opt.wastedCPUcores * 100) / 100;
  opt.wastedMemGi = Math.round(opt.wastedMemGi * 100) / 100;
  opt.offenders = opt.offenders.sort((a, b) => b.wasteSort - a.wasteSort).slice(0, 20);
  // Efficiency score: penalize waste, missing limits, and provisioning issues
  let score = 100;
  const noLimitPct = opt.totalPods ? opt.podsNoLimits / opt.totalPods : 0;
  score -= Math.round(noLimitPct * 30);
  score -= Math.min(25, opt.overProvisioned * 2);
  score -= Math.min(15, opt.underProvisioned * 3);
  opt.efficiencyScore = Math.max(0, score);
  opt.grade = opt.efficiencyScore >= 90 ? "A" : opt.efficiencyScore >= 80 ? "B" : opt.efficiencyScore >= 70 ? "C" : opt.efficiencyScore >= 60 ? "D" : "F";
  scan.optimization = opt;
}

// ---------------------------------------------------------------------------
// Image vulnerabilities — Trivy Operator reports (optional CRD). Portable.
// Falls back to Aqua/StackRox CRD names if present.
// ---------------------------------------------------------------------------
async function scanImageVulns(scan) {
  const iv = { installed: false, scanner: null, critical: 0, high: 0, medium: 0, low: 0, totalImages: 0, images: [] };
  // Trivy Operator (most common, portable across platforms)
  let resp = await k8sGetOptional("/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports");
  let scanner = "Trivy";
  if (!resp.ok) {
    // OpenShift / Quay container security operator
    resp = await k8sGetOptional("/apis/secscan.quay.redhat.com/v1alpha1/imagemanifestvulns");
    scanner = "Quay";
  }
  if (resp.ok) {
    iv.installed = true;
    iv.scanner = scanner;
    const reports = resp.data.items || [];
    const imageMap = {};
    for (const r of reports) {
      const summary = r.report?.summary || r.spec?.features ? null : r.report?.summary;
      // Trivy schema
      const s = r.report?.summary;
      if (s) {
        iv.critical += s.criticalCount || 0;
        iv.high += s.highCount || 0;
        iv.medium += s.mediumCount || 0;
        iv.low += s.lowCount || 0;
        const img = r.report?.artifact?.repository ? `${r.report.artifact.repository}:${r.report.artifact.tag || "latest"}` : (r.metadata?.labels?.["trivy-operator.resource.name"] || r.metadata?.name);
        if (!imageMap[img]) { imageMap[img] = { image: img, critical: 0, high: 0, medium: 0 }; }
        imageMap[img].critical += s.criticalCount || 0;
        imageMap[img].high += s.highCount || 0;
        imageMap[img].medium += s.mediumCount || 0;
      }
    }
    const imgs = Object.values(imageMap).sort((a, b) => (b.critical * 10 + b.high) - (a.critical * 10 + a.high));
    iv.totalImages = imgs.length;
    iv.images = imgs.slice(0, 20);
  }
  scan.imageVulns = iv;
}

// ---------------------------------------------------------------------------
// RBAC summary — roles, bindings, subjects. Standard API. Portable.
// ---------------------------------------------------------------------------
async function scanRBAC(scan) {
  const rbac = { available: true, clusterRoleBindings: 0, clusterRoles: 0, clusterAdmins: [], serviceAccounts: 0 };
  const [crb, cr, sa] = await Promise.all([
    k8sGetOptional("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings"),
    k8sGetOptional("/apis/rbac.authorization.k8s.io/v1/clusterroles"),
    k8sGetOptional("/api/v1/serviceaccounts"),
  ]);
  if (!crb.ok) { rbac.available = false; scan.rbac = rbac; return; }
  const bindings = crb.data.items || [];
  rbac.clusterRoleBindings = bindings.length;
  for (const b of bindings) {
    if (b.roleRef?.name === "cluster-admin") {
      for (const s of b.subjects || []) {
        rbac.clusterAdmins.push({ kind: s.kind, name: s.name, namespace: s.namespace || null, binding: b.metadata?.name });
      }
    }
  }
  rbac.clusterAdmins = rbac.clusterAdmins.slice(0, 30);
  if (cr.ok) rbac.clusterRoles = (cr.data.items || []).length;
  if (sa.ok) rbac.serviceAccounts = (sa.data.items || []).length;
  scan.rbac = rbac;
}

function computeClusterHealth(scan) {
  const degradedOps = scan.clusterOperators?.degraded || 0;
  const totalNodes = scan.nodes?.total || 0;
  const readyNodes = scan.nodes?.ready || 0;
  const notReadyNodes = totalNodes - readyNodes;

  if (degradedOps > 0) {
    scan.clusterHealth.status = "Degraded";
  } else if (notReadyNodes > 0) {
    scan.clusterHealth.status = "Warning";
  } else {
    scan.clusterHealth.status = "Healthy";
  }

  scan.clusterHealth.apiServerHealthy = true;
}

export function clearTokenCache() {
  _token = null;
}
