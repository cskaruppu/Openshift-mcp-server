import { ocpGet } from "../utils/openshift-client.js";

const MAX_HISTORY = 100;
const _rcaHistory = [];
const _activeInvestigations = new Map();

let _nextId = 1;

function generateId() {
  return `rca-${Date.now().toString(36)}-${(_nextId++).toString(36)}`;
}

function parseResourceValue(val) {
  if (!val) return 0;
  const str = String(val);
  if (str.endsWith("Gi")) return parseFloat(str) * 1073741824;
  if (str.endsWith("Mi")) return parseFloat(str) * 1048576;
  if (str.endsWith("Ki")) return parseFloat(str) * 1024;
  if (str.endsWith("G")) return parseFloat(str) * 1e9;
  if (str.endsWith("M")) return parseFloat(str) * 1e6;
  if (str.endsWith("m")) return parseFloat(str) / 1000;
  return parseFloat(str) || 0;
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)}Gi`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)}Mi`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}Ki`;
  return `${bytes}`;
}

function determineSeverity(rootCause) {
  const critical = [
    "CrashLoopBackOff", "OOMKilled", "NodeNotReady", "NodeDiskPressure",
    "NodeMemoryPressure", "ErrImagePull", "ImagePullBackOff",
    "CreateContainerConfigError",
  ];
  const warning = [
    "HighRestartCount", "Pending", "ReadinessProbeFailure",
    "LivenessProbeFailure", "InsufficientResources", "Unschedulable",
    "OOMRisk",
  ];
  if (critical.includes(rootCause)) return "critical";
  if (warning.includes(rootCause)) return "warning";
  return "info";
}

function pushHistory(entry) {
  _rcaHistory.push(entry);
  if (_rcaHistory.length > MAX_HISTORY) {
    _rcaHistory.splice(0, _rcaHistory.length - MAX_HISTORY);
  }
}

async function safeFetch(path) {
  try {
    return await ocpGet(path);
  } catch {
    return null;
  }
}

function extractContainerDiagnostics(pod) {
  const findings = [];
  const allStatuses = [
    ...(pod.status?.containerStatuses || []),
    ...(pod.status?.initContainerStatuses || []),
  ];

  for (const cs of allStatuses) {
    const waitReason = cs.state?.waiting?.reason;
    const terminatedReason = cs.lastState?.terminated?.reason;
    const exitCode = cs.lastState?.terminated?.exitCode;

    if (waitReason === "CrashLoopBackOff") {
      findings.push({
        cause: "CrashLoopBackOff",
        evidence: `Container "${cs.name}" is crash-looping with ${cs.restartCount} restarts`,
        confidence: 0.95,
      });
    }

    if (waitReason === "ImagePullBackOff" || waitReason === "ErrImagePull") {
      findings.push({
        cause: waitReason,
        evidence: `Container "${cs.name}" cannot pull image: ${cs.image || "unknown"}. ${cs.state?.waiting?.message || ""}`.trim(),
        confidence: 0.99,
      });
    }

    if (waitReason === "CreateContainerConfigError") {
      findings.push({
        cause: "CreateContainerConfigError",
        evidence: `Container "${cs.name}" has a config error: ${cs.state?.waiting?.message || "missing ConfigMap/Secret or volume"}`,
        confidence: 0.95,
      });
    }

    if (terminatedReason === "OOMKilled" || exitCode === 137) {
      findings.push({
        cause: "OOMKilled",
        evidence: `Container "${cs.name}" was OOM-killed (exit code 137). Restarts: ${cs.restartCount}`,
        confidence: 0.98,
      });
    }

    if (exitCode === 1 && cs.restartCount > 0) {
      findings.push({
        cause: "ApplicationError",
        evidence: `Container "${cs.name}" exited with code 1 (application error). Restarts: ${cs.restartCount}`,
        confidence: 0.7,
      });
    }

    if (exitCode === 2) {
      findings.push({
        cause: "Misconfiguration",
        evidence: `Container "${cs.name}" exited with code 2 (bad arguments/config). Restarts: ${cs.restartCount}`,
        confidence: 0.8,
      });
    }

    if (exitCode === 127) {
      findings.push({
        cause: "CommandNotFound",
        evidence: `Container "${cs.name}" exited with code 127 — entrypoint command not found`,
        confidence: 0.95,
      });
    }

    if (cs.restartCount > 10 && !findings.some((f) => f.cause === "CrashLoopBackOff")) {
      findings.push({
        cause: "HighRestartCount",
        evidence: `Container "${cs.name}" has ${cs.restartCount} restarts`,
        confidence: 0.8,
      });
    }
  }

  return findings;
}

function analyzeEvents(events) {
  const findings = [];
  const items = events?.items || [];
  const warnings = items.filter((e) => e.type === "Warning");

  const schedulingFailures = warnings.filter(
    (e) => e.reason === "FailedScheduling" || e.reason === "Unschedulable"
  );
  if (schedulingFailures.length > 0) {
    const messages = schedulingFailures.map((e) => e.message).filter(Boolean);
    findings.push({
      cause: "Unschedulable",
      evidence: `Pod cannot be scheduled: ${messages[0] || "no nodes available"}`,
      confidence: 0.95,
    });
  }

  const pullFailures = warnings.filter(
    (e) => e.reason === "Failed" && e.message?.toLowerCase().includes("pull")
  );
  if (pullFailures.length > 0) {
    findings.push({
      cause: "ImagePullBackOff",
      evidence: `Image pull failed: ${pullFailures[0].message?.substring(0, 200) || "unknown error"}`,
      confidence: 0.95,
    });
  }

  const livenessFailures = warnings.filter(
    (e) => e.reason === "Unhealthy" && /liveness/i.test(e.message || "")
  );
  if (livenessFailures.length > 0) {
    findings.push({
      cause: "LivenessProbeFailure",
      evidence: `Liveness probe failing (${livenessFailures.length} events): ${livenessFailures[0].message?.substring(0, 200) || ""}`,
      confidence: 0.85,
    });
  }

  const readinessFailures = warnings.filter(
    (e) => e.reason === "Unhealthy" && /readiness/i.test(e.message || "")
  );
  if (readinessFailures.length > 0) {
    findings.push({
      cause: "ReadinessProbeFailure",
      evidence: `Readiness probe failing (${readinessFailures.length} events): ${readinessFailures[0].message?.substring(0, 200) || ""}`,
      confidence: 0.8,
    });
  }

  const backoffs = warnings.filter((e) => e.reason === "BackOff");
  if (backoffs.length > 5) {
    findings.push({
      cause: "CrashLoopBackOff",
      evidence: `${backoffs.length} BackOff events observed`,
      confidence: 0.75,
    });
  }

  return findings;
}

function analyzeResourceLimits(pod) {
  const findings = [];
  const containers = pod.spec?.containers || [];

  for (const c of containers) {
    const requests = c.resources?.requests || {};
    const limits = c.resources?.limits || {};

    if (!limits.memory && !limits.cpu) {
      findings.push({
        cause: "NoResourceLimits",
        evidence: `Container "${c.name}" has no resource limits set — unbounded resource usage`,
        confidence: 0.5,
      });
      continue;
    }

    if (limits.memory && requests.memory) {
      const limitBytes = parseResourceValue(limits.memory);
      const requestBytes = parseResourceValue(requests.memory);
      // When request is very close to limit, OOM risk is high under burst
      if (limitBytes > 0 && requestBytes / limitBytes > 0.9) {
        findings.push({
          cause: "OOMRisk",
          evidence: `Container "${c.name}" memory request (${requests.memory}) is >${Math.round((requestBytes / limitBytes) * 100)}% of limit (${limits.memory}) — high OOM risk under burst`,
          confidence: 0.6,
        });
      }
    }

    if (limits.memory && !requests.memory) {
      findings.push({
        cause: "MissingMemoryRequest",
        evidence: `Container "${c.name}" has memory limit (${limits.memory}) but no memory request — scheduler cannot make informed placement decisions`,
        confidence: 0.4,
      });
    }
  }

  return findings;
}

function analyzeProbes(pod) {
  const findings = [];
  const containers = pod.spec?.containers || [];

  for (const c of containers) {
    if (!c.readinessProbe && !c.livenessProbe) {
      findings.push({
        cause: "NoHealthProbes",
        evidence: `Container "${c.name}" has no readiness or liveness probes configured`,
        confidence: 0.3,
      });
    } else if (c.livenessProbe && !c.readinessProbe) {
      findings.push({
        cause: "MissingReadinessProbe",
        evidence: `Container "${c.name}" has a liveness probe but no readiness probe — traffic may be sent before the container is ready`,
        confidence: 0.3,
      });
    }

    if (c.livenessProbe) {
      const delay = c.livenessProbe.initialDelaySeconds || 0;
      const period = c.livenessProbe.periodSeconds || 10;
      const threshold = c.livenessProbe.failureThreshold || 3;
      // If the liveness window is very tight, it can cause false positive kills
      if (delay < 5 && period * threshold < 30) {
        findings.push({
          cause: "AggressiveLivenessProbe",
          evidence: `Container "${c.name}" liveness probe is aggressive: initialDelay=${delay}s, period=${period}s, failureThreshold=${threshold}. The container has only ${delay + period * threshold}s before being killed`,
          confidence: 0.5,
        });
      }
    }
  }

  return findings;
}

async function analyzeNode(pod) {
  const nodeName = pod.spec?.nodeName;
  if (!nodeName) {
    return [{
      cause: "NoNodeAssigned",
      evidence: "Pod has no node assigned — it may be pending scheduling",
      confidence: 0.7,
    }];
  }

  const node = await safeFetch(`/api/v1/nodes/${nodeName}`);
  if (!node) return [];

  const findings = [];
  const conditions = node.status?.conditions || [];

  const ready = conditions.find((c) => c.type === "Ready");
  if (ready && ready.status !== "True") {
    findings.push({
      cause: "NodeNotReady",
      evidence: `Node "${nodeName}" is not Ready: ${ready.message || ready.reason || "unknown"}`,
      confidence: 0.9,
    });
  }

  const pressureTypes = ["MemoryPressure", "DiskPressure", "PIDPressure"];
  for (const pType of pressureTypes) {
    const cond = conditions.find((c) => c.type === pType);
    if (cond && cond.status === "True") {
      findings.push({
        cause: `Node${pType}`,
        evidence: `Node "${nodeName}" is under ${pType}: ${cond.message || cond.reason || ""}`,
        confidence: 0.85,
      });
    }
  }

  return findings;
}

function buildRecommendation(rootCause, causalChain, pod) {
  const recommendations = {
    CrashLoopBackOff:
      "Check application logs with `oc logs <pod> --previous`. Verify environment variables, config mounts, and entrypoint command. If the application is healthy outside K8s, compare the container spec against a known-good configuration.",
    OOMKilled:
      "Increase the container memory limit. Analyze memory usage patterns to right-size the limit. If the application has a memory leak, profile it and fix the root cause before simply raising limits.",
    ImagePullBackOff:
      "Verify the image name and tag exist in the registry. Check imagePullSecrets on the pod spec or service account. Ensure network connectivity to the container registry.",
    ErrImagePull:
      "Verify the image name and tag exist in the registry. Check imagePullSecrets on the pod spec or service account. Ensure network connectivity to the container registry.",
    CreateContainerConfigError:
      "Check that all referenced ConfigMaps and Secrets exist in the namespace. Verify volume mount paths and names match the defined volumes.",
    Unschedulable:
      "Check cluster capacity, node taints/tolerations, node selectors, affinity rules, and resource quotas. The cluster may need to scale up or resource requests may need to be reduced.",
    LivenessProbeFailure:
      "Increase initialDelaySeconds and timeoutSeconds on the liveness probe to give the application more startup time. Verify the probe endpoint is correct and the application responds under load.",
    ReadinessProbeFailure:
      "Verify the readiness probe endpoint is correct. Check if the application needs more time to initialize or if a dependency is unavailable.",
    NodeNotReady:
      "Investigate the node health — check kubelet logs, system resources, and network connectivity. Consider cordoning the node and migrating workloads.",
    NodeMemoryPressure:
      "The node is running low on memory. Consider adding nodes to the cluster, reducing workload memory requests, or migrating pods to nodes with more capacity.",
    NodeDiskPressure:
      "The node is running low on disk space. Clean up unused images and containers, increase disk size, or add storage capacity.",
    HighRestartCount:
      "The pod is restarting frequently. Check logs from previous container instances. Look for OOM kills, application crashes, or probe failures as the underlying cause.",
    Pending:
      "The pod is stuck in Pending state. Check events for scheduling failures, resource quota limits, or PersistentVolumeClaim binding issues.",
    ApplicationError:
      "The application is crashing with exit code 1. Check application logs for error messages. Verify configuration, database connectivity, and dependent services.",
    Misconfiguration:
      "The container is exiting with code 2 (bad arguments). Check the container command and args in the deployment spec. Verify compatibility between the image version and the provided arguments.",
    CommandNotFound:
      "The container entrypoint command was not found (exit code 127). Verify the image contains the expected binary and the command/args fields in the pod spec are correct.",
    OOMRisk:
      "Memory request is very close to the limit. Increase the limit to provide headroom for burst usage, or reduce the request if steady-state usage is lower.",
    NoResourceLimits:
      "Set resource requests and limits for all containers to ensure fair scheduling and prevent unbounded resource consumption.",
    AggressiveLivenessProbe:
      "The liveness probe timing is aggressive and may kill healthy-but-slow containers. Increase initialDelaySeconds and failureThreshold.",
    Healthy:
      "No issues detected. The pod appears to be running normally.",
  };

  return recommendations[rootCause] || `Investigate the ${rootCause} condition. Review pod events, container logs, and node status for more details.`;
}

function deduplicateChain(chain) {
  const seen = new Set();
  return chain.filter((item) => {
    const key = `${item.cause}:${item.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectRootCause(causalChain) {
  if (causalChain.length === 0) return "Unknown";

  const priority = [
    "NodeNotReady", "NodeMemoryPressure", "NodeDiskPressure", "NodePIDPressure",
    "OOMKilled", "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull",
    "CreateContainerConfigError", "CommandNotFound",
    "Unschedulable", "LivenessProbeFailure",
    "Misconfiguration", "ApplicationError",
    "ReadinessProbeFailure", "HighRestartCount", "Pending",
    "OOMRisk", "AggressiveLivenessProbe",
    "NoResourceLimits", "NoHealthProbes", "MissingReadinessProbe",
    "MissingMemoryRequest", "NoNodeAssigned",
  ];

  const sorted = [...causalChain].sort((a, b) => {
    const aIdx = priority.indexOf(a.cause);
    const bIdx = priority.indexOf(b.cause);
    const aPri = aIdx === -1 ? priority.length : aIdx;
    const bPri = bIdx === -1 ? priority.length : bIdx;
    if (aPri !== bPri) return aPri - bPri;
    return b.confidence - a.confidence;
  });

  return sorted[0].cause;
}

export async function runRCA(namespace, podName) {
  const id = generateId();
  const investigation = {
    id,
    namespace,
    pod: podName,
    rootCause: null,
    severity: "info",
    causalChain: [],
    recommendation: null,
    investigatedAt: new Date().toISOString(),
    status: "investigating",
  };

  _activeInvestigations.set(id, investigation);

  try {
    const [pod, events] = await Promise.all([
      safeFetch(`/api/v1/namespaces/${namespace}/pods/${podName}`),
      safeFetch(`/api/v1/namespaces/${namespace}/events?fieldSelector=involvedObject.name=${encodeURIComponent(podName)}`),
    ]);

    if (!pod) {
      investigation.status = "failed";
      investigation.rootCause = "PodNotFound";
      investigation.severity = "info";
      investigation.recommendation = `Pod "${podName}" not found in namespace "${namespace}". Verify the pod name and namespace are correct.`;
      _activeInvestigations.delete(id);
      pushHistory(investigation);
      return investigation;
    }

    const phase = pod.status?.phase;
    const causalChain = [];

    if (phase === "Pending") {
      causalChain.push({
        cause: "Pending",
        evidence: `Pod is in Pending phase since ${pod.metadata?.creationTimestamp || "unknown"}`,
        confidence: 0.9,
      });
    }

    causalChain.push(...extractContainerDiagnostics(pod));
    causalChain.push(...analyzeEvents(events));
    causalChain.push(...analyzeResourceLimits(pod));
    causalChain.push(...analyzeProbes(pod));

    const nodeFindings = await analyzeNode(pod);
    causalChain.push(...nodeFindings);

    const deduplicated = deduplicateChain(causalChain);

    if (deduplicated.length === 0 && phase === "Running") {
      const allReady = (pod.status?.containerStatuses || []).every((cs) => cs.ready);
      const totalRestarts = (pod.status?.containerStatuses || []).reduce(
        (sum, cs) => sum + (cs.restartCount || 0), 0
      );
      if (allReady && totalRestarts === 0) {
        investigation.rootCause = "Healthy";
        investigation.severity = "info";
        investigation.causalChain = [];
        investigation.recommendation = buildRecommendation("Healthy", [], pod);
        investigation.status = "completed";
        _activeInvestigations.delete(id);
        pushHistory(investigation);
        return investigation;
      }
    }

    const rootCause = selectRootCause(deduplicated);
    investigation.rootCause = rootCause;
    investigation.severity = determineSeverity(rootCause);
    investigation.causalChain = deduplicated;
    investigation.recommendation = buildRecommendation(rootCause, deduplicated, pod);
    investigation.status = "completed";
  } catch (err) {
    investigation.status = "failed";
    investigation.rootCause = "InvestigationError";
    investigation.severity = "info";
    investigation.recommendation = `RCA investigation failed: ${err.message}`;
  }

  _activeInvestigations.delete(id);
  pushHistory(investigation);
  return investigation;
}

export async function runNamespaceRCA(namespace) {
  const pods = await safeFetch(`/api/v1/namespaces/${namespace}/pods`);

  if (!pods || !pods.items) {
    return {
      namespace,
      error: `Could not fetch pods for namespace "${namespace}"`,
      unhealthyCount: 0,
      results: [],
    };
  }

  const unhealthyPods = pods.items.filter((p) => {
    const phase = p.status?.phase;
    if (phase === "Succeeded" || phase === "Completed") return false;
    if (phase === "Failed" || phase === "Unknown" || phase === "Pending") return true;

    const containerStatuses = p.status?.containerStatuses || [];
    const hasWaitingIssue = containerStatuses.some((cs) => {
      const reason = cs.state?.waiting?.reason;
      return reason === "CrashLoopBackOff" ||
             reason === "ImagePullBackOff" ||
             reason === "ErrImagePull" ||
             reason === "CreateContainerConfigError";
    });
    if (hasWaitingIssue) return true;

    const highRestarts = containerStatuses.some((cs) => cs.restartCount > 5);
    if (highRestarts) return true;

    const notReady = containerStatuses.some((cs) => !cs.ready);
    if (phase === "Running" && notReady) return true;

    return false;
  });

  const results = await Promise.all(
    unhealthyPods.map((p) => runRCA(namespace, p.metadata.name))
  );

  const severityCounts = { critical: 0, warning: 0, info: 0 };
  for (const r of results) {
    severityCounts[r.severity] = (severityCounts[r.severity] || 0) + 1;
  }

  return {
    namespace,
    totalPods: pods.items.length,
    unhealthyCount: unhealthyPods.length,
    severityCounts,
    results,
  };
}

export function getActiveInvestigations() {
  return Array.from(_activeInvestigations.values());
}

export function getRCAHistory() {
  return [..._rcaHistory];
}
