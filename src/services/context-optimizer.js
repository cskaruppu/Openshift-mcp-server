const NOISE_FIELDS = new Set([
  "managedFields", "resourceVersion", "uid", "selfLink", "generation",
]);

const HASH_ANNOTATION_RE = /(?:sha256|checksum|kubectl\.kubernetes\.io\/last-applied-configuration)/;

const HAPPY_PATH_CONDITIONS = new Set(["Ready", "Initialized", "ContainersReady"]);

const MAX_LABELS = 10;

export function stripMetadata(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    const filtered = [];
    for (const item of obj) {
      const cleaned = stripMetadata(item);
      if (cleaned !== null && cleaned !== undefined) filtered.push(cleaned);
    }
    return filtered.length === 0 ? [] : filtered;
  }
  if (typeof obj !== "object") return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (NOISE_FIELDS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;

    if (key === "annotations" && typeof value === "object" && !Array.isArray(value)) {
      const cleaned = {};
      for (const [ak, av] of Object.entries(value)) {
        if (!HASH_ANNOTATION_RE.test(ak)) cleaned[ak] = av;
      }
      if (Object.keys(cleaned).length > 0) result[key] = cleaned;
      continue;
    }

    if (key === "labels" && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length > MAX_LABELS) {
        const truncated = {};
        for (const [lk, lv] of entries.slice(0, MAX_LABELS)) truncated[lk] = lv;
        result[key] = truncated;
      } else {
        result[key] = value;
      }
      continue;
    }

    if (key === "conditions" && Array.isArray(value)) {
      const parentKeys = Object.keys(obj);
      const isStatusConditions = parentKeys.includes("phase") ||
        parentKeys.includes("containerStatuses") ||
        parentKeys.includes("availableReplicas");

      if (isStatusConditions) {
        const kept = value.filter((c) => {
          if (c.status === "True" && HAPPY_PATH_CONDITIONS.has(c.type)) return false;
          return true;
        });
        if (kept.length > 0) result[key] = kept.map((c) => stripMetadata(c));
        continue;
      }
    }

    result[key] = stripMetadata(value);
  }

  return result;
}

const ERROR_PATTERNS = /\b(error|fatal|panic|exception|killed|oom)\b/i;
const STACK_TRACE_RE = /^\s+at\s|^Traceback|^Caused by:|^Exception in|^\s*File "/;

function extractKeyLogLines(logs, exitCode) {
  if (!logs) return [];
  const lines = logs.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return [];

  const scored = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let score = 0;
    if (ERROR_PATTERNS.test(line)) score += 10;
    if (STACK_TRACE_RE.test(line)) score += 8;
    if (score > 0) scored.push({ line: line.trim(), score, idx: i });
  }

  // If there was a crash, include the last 2 lines before the end
  if (exitCode != null && exitCode !== 0 && lines.length >= 2) {
    const tailStart = Math.max(0, lines.length - 2);
    for (let i = tailStart; i < lines.length; i++) {
      const already = scored.find((s) => s.idx === i);
      if (!already) {
        scored.push({ line: lines[i].trim(), score: 5, idx: i });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const seen = new Set();
  const result = [];
  for (const entry of scored) {
    if (seen.has(entry.line)) continue;
    seen.add(entry.line);
    result.push(entry.line);
    if (result.length >= 5) break;
  }

  return result;
}

function deduplicateEvents(events) {
  if (!events || events.length === 0) return [];
  const groups = new Map();
  for (const evt of events) {
    const key = `${evt.reason || ""}::${evt.message || ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count = (existing.count || 1) + (evt.count || 1);
      const ts = new Date(evt.lastSeen || evt.lastTimestamp || 0).getTime();
      const existingTs = new Date(existing.lastSeen || existing.lastTimestamp || 0).getTime();
      if (ts > existingTs) {
        existing.lastSeen = evt.lastSeen || evt.lastTimestamp;
      }
    } else {
      groups.set(key, { ...evt });
    }
  }
  return Array.from(groups.values());
}

function computeAge(startTime) {
  if (!startTime) return "unknown";
  const diffMs = Date.now() - new Date(startTime).getTime();
  if (diffMs < 0) return "just created";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

export function buildDiagnosticBrief(podData, events, logs, autoDiagnosis) {
  const containers = podData.containers || [];
  const restartCount = containers.reduce((s, c) => s + (c.restarts || c.restartCount || 0), 0);

  const crashedContainer = containers.find(
    (c) => c.exitCode != null || c.state === "CrashLoopBackOff" || c.state === "OOMKilled" || c.state === "Error"
  ) || containers[0] || {};

  const exitCode = crashedContainer.exitCode ??
    crashedContainer.lastState?.exitCode ?? null;

  const terminationReason = crashedContainer.lastState?.reason ||
    crashedContainer.state || null;

  const resourceLimits = (podData.resourceLimits || []).find(
    (r) => r.name === crashedContainer.name
  ) || {};

  const warningEvents = (events || []).filter((e) => e.type === "Warning" || !e.type);
  const dedupedEvents = deduplicateEvents(warningEvents);
  const recentEvents = dedupedEvents
    .slice(0, 5)
    .map((e) => `${e.reason}: ${(e.message || "").slice(0, 200)}${e.count > 1 ? ` (x${e.count})` : ""}`);

  const keyLogLines = extractKeyLogLines(logs, exitCode);

  let rootCause = autoDiagnosis?.rootCause || null;
  if (!rootCause) {
    if (exitCode === 137 || terminationReason === "OOMKilled") rootCause = "OOMKilled";
    else if (terminationReason === "CrashLoopBackOff") rootCause = "CrashLoopBackOff";
    else if (terminationReason === "ImagePullBackOff" || terminationReason === "ErrImagePull") rootCause = "ImagePullFailure";
    else if (terminationReason === "CreateContainerConfigError") rootCause = "ConfigError";
    else if (exitCode != null && exitCode !== 0) rootCause = `NonZeroExit(${exitCode})`;
    else if (podData.phase === "Pending") rootCause = "Pending";
    else rootCause = "unknown";
  }

  let verdict = autoDiagnosis?.diagnosis || "";
  if (!verdict) {
    if (rootCause === "OOMKilled") {
      verdict = `Container killed by OOM Killer (exit 137)${resourceLimits.memLimit ? `, limit ${resourceLimits.memLimit}` : ""} — increase memory limits`;
    } else if (rootCause === "CrashLoopBackOff") {
      verdict = `Container crash-looping with ${restartCount} restarts${exitCode != null ? `, exit code ${exitCode}` : ""} — check logs for startup errors`;
    } else if (rootCause === "ImagePullFailure") {
      verdict = `Image pull failing — verify image name, tag, and registry credentials`;
    } else if (rootCause === "ConfigError") {
      verdict = `Container config error — check mounted secrets, configmaps, and env vars`;
    } else if (rootCause === "Pending") {
      verdict = `Pod stuck in Pending — likely insufficient resources or scheduling constraints`;
    } else if (exitCode != null && exitCode !== 0) {
      verdict = `Container exiting with code ${exitCode} — inspect application logs`;
    } else {
      verdict = `Pod ${podData.name} in phase ${podData.phase || "unknown"} with ${restartCount} restart(s)`;
    }
  }

  return {
    podName: podData.name,
    namespace: podData.namespace,
    phase: podData.phase || "Unknown",
    restartCount,
    rootCause,
    exitCode,
    terminationReason,
    memoryLimit: resourceLimits.memLimit || null,
    cpuLimit: resourceLimits.cpuLimit || null,
    memoryRequest: resourceLimits.memRequest || null,
    cpuRequest: resourceLimits.cpuRequest || null,
    keyLogLines,
    recentEvents,
    ownerKind: podData.ownerKind || null,
    ownerName: podData.ownerName || null,
    age: computeAge(podData.startTime),
    nodeScheduledOn: podData.node || null,
    verdict,
  };
}

const TIER1_INTENT_MAP = {
  specific_pod: "pod_issues",
  pod_issues: "pod_issues",
  pod_summary: "pod_issues",
  nodes: "nodes",
  cluster_health: "cluster_health",
  deployments: "deployments",
  operators: "operators",
  events: "events",
  metrics: "metrics",
  namespaces: "namespaces",
  services: "services",
  rbac: "rbac",
  certificate_expiry: "certificate_expiry",
  cluster_upgrade: "cluster_upgrade",
};

function formatTier1(context) {
  const lines = [];
  if (context.clusterVersion) {
    const ver = typeof context.clusterVersion === "object"
      ? (context.clusterVersion.desired || context.clusterVersion.version || "unknown")
      : context.clusterVersion;
    lines.push(`Cluster version: ${ver}`);
  }
  if (context.nodeCount != null) {
    lines.push(`Nodes: ${context.nodeCount} total, ${context.readyNodes ?? "?"} ready`);
  }
  if (context.platform) {
    lines.push(`Platform: ${context.platform}`);
  }
  if (context.channel) {
    lines.push(`Channel: ${context.channel}`);
  }
  if (context.totalPods != null) {
    lines.push(`Total pods: ${context.totalPods}`);
  }
  return lines.join("\n");
}

// Determine the primary focus from intents
function resolvePrimaryFocus(intents) {
  if (!intents || intents.length === 0) return null;
  for (const intent of intents) {
    const mapped = TIER1_INTENT_MAP[intent];
    if (mapped) return mapped;
  }
  return null;
}

const TIER2_KEYS = {
  pod_issues: ["targetPod", "targetPodEvents", "targetPodLogs", "targetPodLogsPrevious",
    "targetPodMetrics", "problemPods", "correlations", "_autoDiagnosis"],
  nodes: ["nodes", "nodeMetrics"],
  cluster_health: ["nodes", "problemPods", "operators", "warningEvents", "correlations"],
  deployments: ["deployments", "targetDeployment", "targetDeploymentEvents",
    "targetDeploymentPods", "targetDeploymentReplicaSets", "namespaceDeployments"],
  operators: ["operators"],
  events: ["warningEvents", "targetPodEvents", "targetDeploymentEvents"],
  metrics: ["podMetrics", "nodeMetrics"],
  namespaces: ["namespaces", "namespacePods", "namespaceDeployments"],
  services: ["services"],
  rbac: ["rbacBindings", "ocpUsers", "ocpGroups"],
  certificate_expiry: ["certificateExpiry", "pendingCSRs"],
  cluster_upgrade: ["clusterUpgrade", "pendingChangeRequests"],
};

function formatPeriphery(key, value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return `${key}: ${value.length} item(s)`;
  }
  if (typeof value === "object") {
    const name = value.name || value.podName || "";
    return `${key}: ${name || "present"}`;
  }
  return `${key}: ${value}`;
}

export function buildTieredContext(context, intent) {
  const sections = [];

  sections.push("=== CLUSTER OVERVIEW ===");
  sections.push(formatTier1(context));

  const focus = resolvePrimaryFocus(
    intent ? [intent, ...(context.intents || [])] : (context.intents || [])
  );

  const tier2Keys = focus ? (TIER2_KEYS[focus] || []) : [];
  const tier2Set = new Set(tier2Keys);

  if (tier2Keys.length > 0) {
    sections.push("");
    sections.push(`=== DETAIL (${focus}) ===`);
    for (const key of tier2Keys) {
      const val = context[key];
      if (val === undefined || val === null) continue;
      if (Array.isArray(val) && val.length === 0) continue;
      sections.push(JSON.stringify({ [key]: val }, null, 2));
    }
  }

  const peripheryLines = [];
  const skipKeys = new Set([
    "intents", "queryFilter", "targetPodName", "targetResourceName",
    "targetResourceType", "targetNamespaceFromMemory", "targetNamespace",
    "clusterVersion", "channel", "nodeCount", "readyNodes", "platform",
    "totalPods", "podsByPhase", "_remoteCluster", "_source",
    "_skippedClusterContext", "_contextAge",
  ]);

  for (const [key, value] of Object.entries(context)) {
    if (key.startsWith("_") && key !== "_autoDiagnosis") continue;
    if (skipKeys.has(key)) continue;
    if (tier2Set.has(key)) continue;
    const line = formatPeriphery(key, value);
    if (line) peripheryLines.push(line);
  }

  if (peripheryLines.length > 0) {
    sections.push("");
    sections.push("=== OTHER CONTEXT ===");
    sections.push(peripheryLines.join("\n"));
  }

  return sections.join("\n");
}

const ARRAY_CAPS = {
  problemPods: 20,
  warningEvents: 15,
  events: 15,
  targetPodEvents: 15,
  targetDeploymentEvents: 15,
  deployments: 10,
  namespaceDeployments: 10,
  operators: 30,
  podMetrics: 30,
  namespacePods: 30,
};

const REDUNDANT_FIELDS = new Set(["apiVersion", "kind"]);

function stripRedundantFields(obj) {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripRedundantFields);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDUNDANT_FIELDS.has(k)) continue;
    out[k] = stripRedundantFields(v);
  }
  return out;
}

function deduplicateContextEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const WINDOW_MS = 5 * 60 * 1000;
  const groups = new Map();

  for (const evt of events) {
    const key = `${evt.reason || ""}::${evt.message || ""}`;
    const ts = new Date(evt.lastSeen || evt.lastTimestamp || 0).getTime();
    const existing = groups.get(key);

    if (existing && Math.abs(ts - existing._ts) < WINDOW_MS) {
      existing.count = (existing.count || 1) + (evt.count || 1);
      if (ts > existing._ts) {
        existing.lastSeen = evt.lastSeen || evt.lastTimestamp;
        existing._ts = ts;
      }
    } else if (!existing) {
      groups.set(key, { ...evt, _ts: ts });
    } else {
      // Outside the window — keep both by using a disambiguated key
      groups.set(`${key}::${ts}`, { ...evt, _ts: ts });
    }
  }

  return Array.from(groups.values()).map(({ _ts, ...rest }) => rest);
}

export function compressContext(rawContext) {
  if (!rawContext || typeof rawContext !== "object") return rawContext;
  const ctx = { ...rawContext };
  const gatherTime = Date.now();

  for (const [key, value] of Object.entries(ctx)) {
    if (value === null || value === undefined) {
      delete ctx[key];
      continue;
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      ctx[key] = stripRedundantFields(stripMetadata(value));
    } else if (Array.isArray(value)) {
      let processed = value.map((item) =>
        typeof item === "object" && item !== null
          ? stripRedundantFields(stripMetadata(item))
          : item
      );

      const eventKeys = ["warningEvents", "targetPodEvents", "targetDeploymentEvents"];
      if (eventKeys.includes(key)) {
        processed = deduplicateContextEvents(processed);
      }

      if (ARRAY_CAPS[key] && processed.length > ARRAY_CAPS[key]) {
        processed = processed.slice(0, ARRAY_CAPS[key]);
      }

      ctx[key] = processed;
    }
  }

  ctx._contextAge = Math.round((Date.now() - gatherTime) / 1000) || 0;

  return ctx;
}
