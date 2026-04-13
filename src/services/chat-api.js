/**
 * LLM-powered Chat API for the dashboard.
 *
 * Connects to an external LLM (OpenAI-compatible API, Ollama, or Anthropic)
 * to provide intelligent cluster analysis and fix recommendations.
 *
 * The chat flow:
 *   1. User sends a message via the dashboard
 *   2. This service gathers relevant cluster context (nodes, pods, events, etc.)
 *   3. Sends the user message + cluster context to the LLM
 *   4. Returns the LLM's analysis to the dashboard
 *
 * Supported LLM backends (set via LLM_PROVIDER env var):
 *   - "openai"    — OpenAI / Azure OpenAI / any OpenAI-compatible API
 *   - "anthropic"  — Anthropic Claude API
 *   - "ollama"     — Local Ollama instance
 *   - "none"       — Built-in rule-based analysis (no external LLM)
 */

import { ocpGet, ocpDelete, ocpPatch, ocpPost, ocpFetch } from "../utils/openshift-client.js";
import { cacheGet, cacheSet, isEnabled as cacheEnabled } from "../utils/cache.js";
import {
  addMessage as histAddMessage,
  logQuery as histLogQuery,
  logExecutedAction as histLogExecutedAction,
  isHistoryEnabled,
} from "./chat-history.js";
import { parse as nluParse, describeParse } from "./nlu.js";
import { getMemory, updateMemory, memoryPatchFromParse } from "./conversation-memory.js";
import {
  actionFromParse,
  createPendingAction,
  confirmAction,
  cancelAction,
  executeAction,
  getAction,
  renderPendingMessage,
  isServiceNowEnabled,
} from "./action-workflow.js";

// Map an NLU intent to the legacy "operation" string used by the response
// handlers below, plus a few normalizations.
function nluToCommand(p) {
  // Map intent → operation.
  let operation = null;
  if (p.intent === "list" || p.intent === "get") operation = p.intent;
  else if (p.intent === "logs") operation = "logs";
  else if (p.intent === "top") operation = "top";
  else if (p.intent === "delete") operation = "delete";
  else if (p.intent === "exec") operation = "exec";
  else if (p.intent === "run") operation = "run";
  else if (p.intent === "create") operation = "create";
  else if (p.intent === "update") operation = "update";
  return {
    operation,
    resourceType: p.resource,
    resourceName: p.name,
    namespace: p.namespace,
    filter: p.filter,
    allNs: p.allNs,
    scope: p.scope,
    options: p.options,
    confidence: p.confidence,
    intent: p.intent,
  };
}

// ---------------------------------------------------------------------------
// Cache config — TTL in seconds for cached chat replies / cluster context
// ---------------------------------------------------------------------------
const CHAT_CACHE_TTL = parseInt(process.env.CHAT_CACHE_TTL || "60", 10);
const CONTEXT_CACHE_TTL = parseInt(process.env.CONTEXT_CACHE_TTL || "30", 10);

function cacheKeyForChat(message, provider) {
  // Normalize whitespace + lowercase so trivial variants share the cache.
  const norm = String(message || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `chat:${provider || "none"}:${norm}`;
}

/**
 * Check if a pod matches an issue-type filter. Looks at container statuses
 * because phase==Running can still hide CrashLoopBackOff in waiting reason.
 */
function podMatchesFilter(pod, filter) {
  const cs = (pod.status?.containerStatuses || [])
    .concat(pod.status?.initContainerStatuses || []);
  const reasons = cs.flatMap((c) => [
    c.state?.waiting?.reason,
    c.state?.terminated?.reason,
    c.lastState?.terminated?.reason,
  ]).filter(Boolean);
  const phase = pod.status?.phase;
  switch (filter) {
    case "CrashLoopBackOff":
      return reasons.includes("CrashLoopBackOff");
    case "ImagePullBackOff":
      return reasons.includes("ImagePullBackOff") || reasons.includes("ErrImagePull");
    case "OOMKilled":
      return reasons.includes("OOMKilled");
    case "CreateContainerConfigError":
      return reasons.includes("CreateContainerConfigError");
    case "Pending":
      return phase === "Pending";
    case "Evicted":
      return pod.status?.reason === "Evicted";
    case "Failed":
      return phase !== "Running" && phase !== "Succeeded";
    default:
      return true;
  }
}

/**
 * Curated help/cheat-sheet shown when the user asks "help" or "what can you do".
 */
function buildHelpMessage() {
  return [
    "### OpenShift MCP AI Assistant — what I can do",
    "",
    "I understand natural-language questions about your cluster and run them as live API calls. No external LLM required for any of the items below.",
    "",
    "**Pods**",
    "  - `list pods in trident namespace` / `pods in all namespaces`",
    "  - `how many pods are running in default?`",
    "  - `show crashloopbackoff pods` / `imagepullbackoff` / `oomkilled`",
    "  - `describe pod <name> in <ns>`",
    "  - `logs <pod> in <ns>` / `logs <pod> tail 200`",
    "  - `top pods in <ns>`",
    "  - `delete pod <name> in <ns>`",
    "  - `exec <pod> in <ns> -- ls /tmp`",
    "  - `run image: nginx:latest in <ns>`",
    "",
    "**Generic resources** (deployments, services, configmaps, secrets, routes, statefulsets, daemonsets, jobs, cronjobs, pvcs, ingresses, hpa, ...)",
    "  - `list deployments in <ns>` / `describe deployment <name> in <ns>`",
    "  - `delete <kind> <name> in <ns>`",
    "  - `scale deployment <name> to 5 in <ns>`",
    "",
    "**Cluster scoped**",
    "  - `list nodes` / `list namespaces` / `list projects`",
    "  - `list clusteroperators` / `list pvs`",
    "  - `is the cluster healthy?`",
    "",
    "**Events**",
    "  - `show events` / `events in <ns>` / `warning events`",
    "",
    "**Follow-ups** — I remember the last resource you mentioned",
    "  - `delete it` / `show its logs` / `same in production namespace`",
    "",
    "Type any of the above naturally — punctuation, casing, and word order don't matter.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LLM_PROVIDER = process.env.LLM_PROVIDER || "none";
const LLM_API_URL = process.env.LLM_API_URL || "http://localhost:11434";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4";

// ---------------------------------------------------------------------------
// Resource API mapping — maps resource types to K8s/OCP API paths
// ---------------------------------------------------------------------------
const RESOURCE_MAP = {
  pod:                   { api: "/api/v1", resource: "pods", namespaced: true },
  pods:                  { api: "/api/v1", resource: "pods", namespaced: true },
  deployment:            { api: "/apis/apps/v1", resource: "deployments", namespaced: true },
  deployments:           { api: "/apis/apps/v1", resource: "deployments", namespaced: true },
  deploy:                { api: "/apis/apps/v1", resource: "deployments", namespaced: true },
  service:               { api: "/api/v1", resource: "services", namespaced: true },
  services:              { api: "/api/v1", resource: "services", namespaced: true },
  svc:                   { api: "/api/v1", resource: "services", namespaced: true },
  configmap:             { api: "/api/v1", resource: "configmaps", namespaced: true },
  configmaps:            { api: "/api/v1", resource: "configmaps", namespaced: true },
  cm:                    { api: "/api/v1", resource: "configmaps", namespaced: true },
  secret:                { api: "/api/v1", resource: "secrets", namespaced: true },
  secrets:               { api: "/api/v1", resource: "secrets", namespaced: true },
  serviceaccount:        { api: "/api/v1", resource: "serviceaccounts", namespaced: true },
  serviceaccounts:       { api: "/api/v1", resource: "serviceaccounts", namespaced: true },
  sa:                    { api: "/api/v1", resource: "serviceaccounts", namespaced: true },
  event:                 { api: "/api/v1", resource: "events", namespaced: true },
  events:                { api: "/api/v1", resource: "events", namespaced: true },
  statefulset:           { api: "/apis/apps/v1", resource: "statefulsets", namespaced: true },
  statefulsets:          { api: "/apis/apps/v1", resource: "statefulsets", namespaced: true },
  sts:                   { api: "/apis/apps/v1", resource: "statefulsets", namespaced: true },
  daemonset:             { api: "/apis/apps/v1", resource: "daemonsets", namespaced: true },
  daemonsets:            { api: "/apis/apps/v1", resource: "daemonsets", namespaced: true },
  ds:                    { api: "/apis/apps/v1", resource: "daemonsets", namespaced: true },
  replicaset:            { api: "/apis/apps/v1", resource: "replicasets", namespaced: true },
  replicasets:           { api: "/apis/apps/v1", resource: "replicasets", namespaced: true },
  rs:                    { api: "/apis/apps/v1", resource: "replicasets", namespaced: true },
  job:                   { api: "/apis/batch/v1", resource: "jobs", namespaced: true },
  jobs:                  { api: "/apis/batch/v1", resource: "jobs", namespaced: true },
  cronjob:               { api: "/apis/batch/v1", resource: "cronjobs", namespaced: true },
  cronjobs:              { api: "/apis/batch/v1", resource: "cronjobs", namespaced: true },
  pvc:                   { api: "/api/v1", resource: "persistentvolumeclaims", namespaced: true },
  pvcs:                  { api: "/api/v1", resource: "persistentvolumeclaims", namespaced: true },
  persistentvolumeclaim: { api: "/api/v1", resource: "persistentvolumeclaims", namespaced: true },
  ingress:               { api: "/apis/networking.k8s.io/v1", resource: "ingresses", namespaced: true },
  ingresses:             { api: "/apis/networking.k8s.io/v1", resource: "ingresses", namespaced: true },
  route:                 { api: "/apis/route.openshift.io/v1", resource: "routes", namespaced: true },
  routes:                { api: "/apis/route.openshift.io/v1", resource: "routes", namespaced: true },
  node:                  { api: "/api/v1", resource: "nodes", namespaced: false },
  nodes:                 { api: "/api/v1", resource: "nodes", namespaced: false },
  namespace:             { api: "/api/v1", resource: "namespaces", namespaced: false },
  namespaces:            { api: "/api/v1", resource: "namespaces", namespaced: false },
  ns:                    { api: "/api/v1", resource: "namespaces", namespaced: false },
  project:               { api: "/apis/project.openshift.io/v1", resource: "projects", namespaced: false },
  projects:              { api: "/apis/project.openshift.io/v1", resource: "projects", namespaced: false },
  pv:                    { api: "/api/v1", resource: "persistentvolumes", namespaced: false },
  pvs:                   { api: "/api/v1", resource: "persistentvolumes", namespaced: false },
  persistentvolume:      { api: "/api/v1", resource: "persistentvolumes", namespaced: false },
  clusteroperator:       { api: "/apis/config.openshift.io/v1", resource: "clusteroperators", namespaced: false },
  clusteroperators:      { api: "/apis/config.openshift.io/v1", resource: "clusteroperators", namespaced: false },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Fetch pod logs (plain text, not JSON) */
async function fetchPodLogs(namespace, podName, tailLines = 80) {
  const { readFile } = await import("node:fs/promises");
  let tk = process.env.OPENSHIFT_TOKEN || "";
  if (!tk) {
    try { tk = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim(); } catch {}
  }
  const apiUrl = process.env.OPENSHIFT_API_URL ||
    `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;
  const resp = await fetch(
    `${apiUrl}/api/v1/namespaces/${namespace}/pods/${podName}/log?tailLines=${tailLines}`,
    { headers: { Authorization: `Bearer ${tk}`, Accept: "text/plain" } }
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${resp.status}: ${body}`);
  }
  return resp.text();
}

// ---------------------------------------------------------------------------
// Command parser — extract operation, resource, name, namespace from message
// ---------------------------------------------------------------------------
function parseCommand(message, memory) {
  return nluToCommand(nluParse(message, memory));
}
function _legacyParseCommand_unused(message) {
  const lower = message.toLowerCase().trim();

  // Words that look like namespaces but are actually resource types — never
  // accept these as namespace names. Built from RESOURCE_MAP keys plus a few
  // common verbs/qualifiers.
  const RESOURCE_WORDS = new Set([
    ...Object.keys(RESOURCE_MAP),
    "running", "pending", "failed", "completed", "all", "any", "the",
    "issue", "issues", "error", "errors", "status", "summary", "info",
    "details", "list", "show", "get", "describe", "logs", "log", "top",
    "metrics", "delete", "remove", "kill", "create", "apply", "exec",
    "run", "image", "container", "containers",
  ]);
  function isValidNs(s) {
    if (!s) return false;
    if (RESOURCE_WORDS.has(s)) return false;
    return true;
  }

  // Extract namespace — try the most explicit patterns first so that a
  // generic "in/of/under X" never wins over "namespace X".
  let namespace = null;
  const nsCandidates = [
    // "namespace trident", "ns trident", "project trident"
    lower.match(/(?:namespace|ns|project)\s+["']?([a-z0-9][-a-z0-9]*)["']?/),
    // "trident namespace", "trident ns", "trident project"
    lower.match(/\b([a-z0-9][-a-z0-9]+)\s+(?:namespace|ns|project)\b/),
    // "-n trident"
    lower.match(/-n\s+["']?([a-z0-9][-a-z0-9]*)["']?/),
    // "in/under/from/on namespace? X" — prepositional, weakest signal.
    // Drop "of" and "for" entirely because they collide with phrases like
    // "list of pods" / "metrics for nodes".
    lower.match(
      /(?:\bin|\bunder|\bfrom|\bon)\s+(?:the\s+)?(?:namespace|ns|project\s+)?["']?([a-z0-9][-a-z0-9]*)["']?(?:\s+namespace|\s+ns|\s+project)?/
    ),
  ];
  for (const m of nsCandidates) {
    if (m && isValidNs(m[1])) { namespace = m[1]; break; }
  }

  // Detect operation
  let operation = null;
  if (lower.match(/\blogs?\b|show.*logs?|get.*logs?|view.*logs?|logs?\s+(for|of|from)/)) {
    operation = "logs";
  } else if (lower.match(/\btop\b|metrics?|resource.*usage|cpu.*usage|memory.*usage|consumption/)) {
    operation = "top";
  } else if (lower.match(/\bdelete\b|\bremove\b|\bkill\b/)) {
    operation = "delete";
  } else if (lower.match(/\bdescribe\b|\bdetail|get\s+\w+\s+[a-z0-9]|\binfo\b|explain\s/)) {
    operation = "get";
  } else if (lower.match(/\bexec\b|\bexecute\b|run.*command\s+in/)) {
    operation = "exec";
  } else if (lower.match(/\brun\b.*\bimage\b|create.*pod\b|start.*container/)) {
    operation = "run";
  } else if (lower.match(/\bcreate\b|\bapply\b/)) {
    operation = "create";
  }
  // "list" and "show" are handled by the intent system for simple cases

  // Detect resource type from message
  let resourceType = null;
  const resPatterns = [
    [/\bpods?\b/, "pod"], [/\bdeployments?\b|\bdeploy\b/, "deployment"],
    [/\bservices?\b|\bsvc\b/, "service"], [/\broutes?\b/, "route"],
    [/\bconfigmaps?\b|\bcm\b/, "configmap"], [/\bsecrets?\b/, "secret"],
    [/\bnodes?\b/, "node"], [/\bnamespaces?\b|\bns\b/, "namespace"],
    [/\bprojects?\b/, "project"], [/\bevents?\b/, "event"],
    [/\bstatefulsets?\b|\bsts\b/, "statefulset"], [/\bdaemonsets?\b|\bds\b/, "daemonset"],
    [/\breplicasets?\b|\brs\b/, "replicaset"], [/\bjobs?\b/, "job"],
    [/\bcronjobs?\b/, "cronjob"], [/\bpvcs?\b|\bpersistentvolumeclaims?\b/, "pvc"],
    [/\bpvs?\b|\bpersistentvolumes?\b/, "pv"], [/\bingress(es)?\b/, "ingress"],
    [/\bserviceaccounts?\b|\bsa\b/, "serviceaccount"],
    [/\bclusteroperators?\b|\bco\b/, "clusteroperator"],
  ];
  for (const [pat, type] of resPatterns) {
    if (pat.test(lower)) { resourceType = type; break; }
  }

  // Extract resource name — look for name after resource type or after operation
  let resourceName = null;
  if (operation && resourceType) {
    // "delete pod my-pod-name" or "get deployment nginx"
    const namePatterns = [
      new RegExp(`${resourceType}s?\\s+["']?([a-z0-9][-a-z0-9.]*)["']?`),
      new RegExp(`(delete|remove|describe|get|logs?|top)\\s+${resourceType}s?\\s+["']?([a-z0-9][-a-z0-9.]*)["']?`),
    ];
    for (const pat of namePatterns) {
      const m = lower.match(pat);
      if (m) {
        resourceName = m[m.length - 1]; // last capture group
        // Don't treat the namespace, resource type, or common words as names
        if (["in", "from", "under", "all", "the", "my", "for", "with", namespace].includes(resourceName)) {
          resourceName = null;
        }
        if (resourceName) break;
      }
    }
    // "show logs for my-pod-name" — name after "for/of/from"
    if (!resourceName && operation === "logs") {
      const logNameMatch = lower.match(/logs?\s+(?:for|of|from)\s+["']?([a-z0-9][-a-z0-9.]*)["']?/);
      if (logNameMatch) resourceName = logNameMatch[1];
    }
  }

  // For logs without explicit "pod" keyword, infer pod
  if (operation === "logs" && !resourceType) resourceType = "pod";
  if (operation === "top" && !resourceType) resourceType = "pod";

  return { operation, resourceType, resourceName, namespace };
}

// ---------------------------------------------------------------------------
// Direct command handler — handles specific CRUD/operations without LLM
// Returns null if the message isn't a recognized direct command
// ---------------------------------------------------------------------------
async function handleDirectCommand(message, preParsed) {
  const cmd = preParsed || parseCommand(message);
  const lower = message.toLowerCase().trim();

  // Only handle the *specific* CRUD verbs here. List/get queries are
  // routed through handleListCommand so they share one code path.
  if (!cmd.operation || !cmd.resourceType) return null;
  if (cmd.operation === "list" || cmd.operation === "get") return null;

  const resInfo = RESOURCE_MAP[cmd.resourceType];
  if (!resInfo) return null;

  const parts = [];

  // -----------------------------------------------------------------------
  // LOGS — show pod logs
  // -----------------------------------------------------------------------
  if (cmd.operation === "logs" && cmd.resourceType === "pod") {
    if (!cmd.resourceName || !cmd.namespace) {
      parts.push(`### Pod Logs`);
      parts.push(`[WARNING] Please specify both pod name and namespace.`);
      parts.push(`\n**Example:** "show logs for my-pod in namespace my-ns"`);
      return parts.join("\n");
    }
    try {
      // Pod logs return plain text, not JSON — use raw fetch
      const logText = await fetchPodLogs(cmd.namespace, cmd.resourceName, 80);
      parts.push(`### Logs: \`${cmd.resourceName}\` in \`${cmd.namespace}\``);
      parts.push(`Last 80 lines:`);
      parts.push("```" + logText.substring(0, 4000) + "```");
      if (logText.length > 4000) parts.push(`\n[WARNING] Logs truncated. Use \`oc logs ${cmd.resourceName} -n ${cmd.namespace}\` for full output.`);
    } catch (err) {
      parts.push(`### Pod Logs Error`);
      parts.push(`[CRITICAL] Failed to get logs for \`${cmd.resourceName}\` in \`${cmd.namespace}\``);
      parts.push(`**Error:** ${err.message}`);
      parts.push("```" + `oc logs ${cmd.resourceName} -n ${cmd.namespace}` + "```");
    }
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // TOP — pod resource usage metrics
  // -----------------------------------------------------------------------
  if (cmd.operation === "top") {
    try {
      let path = "/apis/metrics.k8s.io/v1beta1";
      if (cmd.resourceType === "node") {
        path += "/nodes";
      } else if (cmd.namespace && cmd.resourceName) {
        path += `/namespaces/${cmd.namespace}/pods/${cmd.resourceName}`;
      } else if (cmd.namespace) {
        path += `/namespaces/${cmd.namespace}/pods`;
      } else {
        path += "/pods";
      }
      const data = await ocpGet(path);
      const items = data.items || (data.metadata ? [data] : []);
      if (items.length === 0) {
        parts.push(`### Resource Usage`);
        parts.push(`No metrics data available. Ensure metrics-server is installed.`);
        return parts.join("\n");
      }

      if (cmd.resourceType === "node") {
        parts.push(`### Node Resource Usage`);
        items.forEach((n) => {
          const cpu = n.usage?.cpu || "?";
          const mem = n.usage?.memory || "?";
          parts.push(`  - **${n.metadata.name}** — CPU: ${cpu}, Memory: ${mem}`);
        });
      } else {
        const label = cmd.namespace ? `in \`${cmd.namespace}\`` : "(all namespaces)";
        parts.push(`### Pod Resource Usage ${label}`);
        items.slice(0, 30).forEach((p) => {
          const containers = (p.containers || []).map((c) =>
            `${c.name}: CPU ${c.usage?.cpu || "?"}, Mem ${c.usage?.memory || "?"}`
          ).join(" | ");
          parts.push(`  - **${p.metadata.name}** (${p.metadata.namespace}) — ${containers}`);
        });
        if (items.length > 30) parts.push(`\n... and ${items.length - 30} more pods`);
      }
    } catch (err) {
      parts.push(`### Metrics Error`);
      parts.push(`[WARNING] ${err.message}`);
      parts.push(`\nMetrics server may not be installed. Install with:`);
      parts.push("```" + `oc apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml` + "```");
    }
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // DELETE — delete a resource
  // -----------------------------------------------------------------------
  if (cmd.operation === "delete") {
    if (!cmd.resourceName) {
      parts.push(`### Delete ${cmd.resourceType}`);
      parts.push(`[WARNING] Please specify the resource name to delete.`);
      parts.push(`\n**Example:** "delete pod my-pod in namespace my-ns"`);
      return parts.join("\n");
    }
    if (resInfo.namespaced && !cmd.namespace) {
      parts.push(`### Delete ${cmd.resourceType}`);
      parts.push(`[WARNING] Please specify the namespace.`);
      parts.push(`\n**Example:** "delete ${cmd.resourceType} ${cmd.resourceName} in namespace my-ns"`);
      return parts.join("\n");
    }
    const path = resInfo.namespaced
      ? `${resInfo.api}/namespaces/${cmd.namespace}/${resInfo.resource}/${cmd.resourceName}`
      : `${resInfo.api}/${resInfo.resource}/${cmd.resourceName}`;
    try {
      await ocpDelete(path);
      parts.push(`### Deleted: \`${cmd.resourceName}\``);
      parts.push(`[OK] **${cmd.resourceType}** \`${cmd.resourceName}\`${cmd.namespace ? ` in \`${cmd.namespace}\`` : ""} has been deleted.`);
      if (cmd.resourceType === "pod") {
        parts.push(`\nIf the pod is managed by a Deployment/ReplicaSet, a new one will be created automatically.`);
      }
    } catch (err) {
      parts.push(`### Delete Failed`);
      parts.push(`[CRITICAL] Failed to delete ${cmd.resourceType} \`${cmd.resourceName}\``);
      parts.push(`**Error:** ${err.message}`);
    }
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // GET / DESCRIBE — get details of a specific resource
  // -----------------------------------------------------------------------
  if (cmd.operation === "get" && cmd.resourceName) {
    if (resInfo.namespaced && !cmd.namespace) {
      parts.push(`### Get ${cmd.resourceType}`);
      parts.push(`[WARNING] Please specify the namespace.`);
      parts.push(`\n**Example:** "describe ${cmd.resourceType} ${cmd.resourceName} in namespace my-ns"`);
      return parts.join("\n");
    }
    const path = resInfo.namespaced
      ? `${resInfo.api}/namespaces/${cmd.namespace}/${resInfo.resource}/${cmd.resourceName}`
      : `${resInfo.api}/${resInfo.resource}/${cmd.resourceName}`;
    try {
      const data = await ocpGet(path);
      parts.push(`### ${cmd.resourceType}: \`${cmd.resourceName}\`${cmd.namespace ? ` in \`${cmd.namespace}\`` : ""}`);

      // Resource-specific formatting
      if (cmd.resourceType === "pod") {
        const phase = data.status?.phase || "Unknown";
        const node = data.spec?.nodeName || "unassigned";
        const startTime = data.status?.startTime || "unknown";
        const icon = phase === "Running" ? "[OK]" : phase === "Succeeded" ? "[OK]" : "[CRITICAL]";
        parts.push(`${icon} **Phase:** ${phase}`);
        parts.push(`**Node:** ${node}`);
        parts.push(`**Started:** ${startTime}`);
        parts.push(`**IP:** ${data.status?.podIP || "none"}`);
        parts.push(`\n**Containers:**`);
        (data.status?.containerStatuses || []).forEach((c) => {
          const state = Object.keys(c.state || {})[0] || "unknown";
          const stateDetail = c.state?.[state]?.reason || state;
          const icon2 = c.ready ? "[OK]" : "[CRITICAL]";
          parts.push(`  - ${icon2} **${c.name}** — ${stateDetail} — restarts: ${c.restartCount} — ready: ${c.ready}`);
          parts.push(`    Image: \`${c.image}\``);
        });
        if (data.spec?.containers) {
          parts.push(`\n**Resource Requests/Limits:**`);
          data.spec.containers.forEach((c) => {
            const req = c.resources?.requests || {};
            const lim = c.resources?.limits || {};
            parts.push(`  - **${c.name}** — CPU: ${req.cpu || "none"}/${lim.cpu || "none"}, Mem: ${req.memory || "none"}/${lim.memory || "none"}`);
          });
        }
      } else if (cmd.resourceType === "deployment") {
        const desired = data.spec?.replicas ?? 0;
        const ready = data.status?.readyReplicas ?? 0;
        const available = data.status?.availableReplicas ?? 0;
        const icon = ready === desired ? "[OK]" : "[CRITICAL]";
        parts.push(`${icon} **Replicas:** ${ready}/${desired} ready, ${available} available`);
        parts.push(`**Strategy:** ${data.spec?.strategy?.type || "RollingUpdate"}`);
        const img = data.spec?.template?.spec?.containers?.[0]?.image;
        if (img) parts.push(`**Image:** \`${img}\``);
        const conds = data.status?.conditions || [];
        conds.forEach((c) => {
          const ci = c.status === "True" ? "[OK]" : "[WARNING]";
          parts.push(`  - ${ci} ${c.type}: ${c.message || c.reason || ""}`);
        });
      } else if (cmd.resourceType === "service") {
        parts.push(`**Type:** ${data.spec?.type}`);
        parts.push(`**ClusterIP:** ${data.spec?.clusterIP}`);
        parts.push(`**Ports:**`);
        (data.spec?.ports || []).forEach((p) => {
          parts.push(`  - ${p.name || "unnamed"}: ${p.port}/${p.protocol}${p.targetPort ? ` -> ${p.targetPort}` : ""}`);
        });
        if (data.spec?.selector) {
          parts.push(`**Selector:** ${Object.entries(data.spec.selector).map(([k,v]) => `${k}=${v}`).join(", ")}`);
        }
      } else if (cmd.resourceType === "node") {
        const conds = (data.status?.conditions || []).reduce((a, c) => { a[c.type] = c.status; return a; }, {});
        const ready = conds.Ready === "True";
        const icon = ready ? "[OK]" : "[CRITICAL]";
        parts.push(`${icon} **Status:** ${ready ? "Ready" : "NotReady"}`);
        const roles = Object.keys(data.metadata?.labels || {}).filter(l => l.startsWith("node-role.kubernetes.io/")).map(l => l.split("/")[1]);
        parts.push(`**Roles:** ${roles.join(", ") || "worker"}`);
        parts.push(`**OS:** ${data.status?.nodeInfo?.osImage || "?"}`);
        parts.push(`**Kubelet:** ${data.status?.nodeInfo?.kubeletVersion || "?"}`);
        parts.push(`**CPU:** ${data.status?.capacity?.cpu || "?"}`);
        parts.push(`**Memory:** ${data.status?.capacity?.memory || "?"}`);
        parts.push(`**Pods:** ${data.status?.capacity?.pods || "?"} capacity`);
      } else {
        // Generic resource — show key metadata
        parts.push(`**Kind:** ${data.kind}`);
        parts.push(`**Created:** ${data.metadata?.creationTimestamp || "unknown"}`);
        if (data.metadata?.labels) {
          const labels = Object.entries(data.metadata.labels).slice(0, 10).map(([k,v]) => `${k}=${v}`).join(", ");
          parts.push(`**Labels:** ${labels}`);
        }
        // Show spec summary for known types
        if (data.spec) {
          const specStr = JSON.stringify(data.spec, null, 2);
          if (specStr.length < 2000) {
            parts.push(`\n**Spec:**`);
            parts.push("```" + specStr + "```");
          }
        }
      }
    } catch (err) {
      parts.push(`### Error`);
      parts.push(`[CRITICAL] Failed to get ${cmd.resourceType} \`${cmd.resourceName}\`: ${err.message}`);
    }
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // EXEC — not supported in chat (requires WebSocket/TTY)
  // -----------------------------------------------------------------------
  if (cmd.operation === "exec") {
    parts.push(`### Exec`);
    parts.push(`[WARNING] Interactive exec is not supported in the chat UI.`);
    parts.push(`\nUse the CLI instead:`);
    parts.push("```" + `oc exec -it ${cmd.resourceName || "<pod-name>"} -n ${cmd.namespace || "<namespace>"} -- /bin/sh` + "```");
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // RUN — create a pod from an image
  // -----------------------------------------------------------------------
  if (cmd.operation === "run") {
    const imageMatch = lower.match(/image\s+["']?([a-z0-9./:-]+)["']?/);
    const image = imageMatch?.[1];
    if (!image) {
      parts.push(`### Run Pod`);
      parts.push(`[WARNING] Please specify the container image.`);
      parts.push(`\n**Example:** "run pod my-test image nginx:latest in namespace default"`);
      return parts.join("\n");
    }
    const podName = cmd.resourceName || `run-${Date.now().toString(36)}`;
    const ns = cmd.namespace || "default";
    try {
      await ocpPost(`/api/v1/namespaces/${ns}/pods`, {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: podName, namespace: ns },
        spec: {
          containers: [{ name: "main", image }],
          restartPolicy: "Never",
        },
      });
      parts.push(`### Pod Created`);
      parts.push(`[OK] Pod \`${podName}\` created in \`${ns}\` with image \`${image}\``);
      parts.push(`\n**Check status:**`);
      parts.push("```" + `oc get pod ${podName} -n ${ns}\noc logs ${podName} -n ${ns}` + "```");
    } catch (err) {
      parts.push(`### Run Failed`);
      parts.push(`[CRITICAL] Failed to create pod: ${err.message}`);
    }
    return parts.join("\n");
  }

  return null; // Not a recognized direct command
}

// ---------------------------------------------------------------------------
// List resources — handles "list/show X" queries
// ---------------------------------------------------------------------------
async function handleListCommand(message, preParsed) {
  const lower = message.toLowerCase().trim();
  const cmd = preParsed || parseCommand(message);

  // Must have a resource type and a list/get-style intent.
  if (!cmd.resourceType) return null;
  if (!["list", "get"].includes(cmd.operation)) return null;
  // Issue/health questions go through the intent-driven analysis path
  // (gatherClusterContext) — but only when there's no explicit list verb,
  // so "list crashloopbackoff pods" still returns a focused list.
  if (cmd.filter && !["list", "get"].includes(cmd.operation)) return null;
  if (!cmd.filter && lower.match(/\bhealth\b|\bdiagnos|\bwhat.*wrong\b|\boverview\b/)) return null;

  const resInfo = RESOURCE_MAP[cmd.resourceType];
  if (!resInfo) return null;

  // Special handling for projects
  if (cmd.resourceType === "project") {
    try {
      const data = await ocpGet("/apis/project.openshift.io/v1/projects");
      const items = data.items || [];
      const parts = [`### OpenShift Projects (${items.length})`];
      items.forEach((p) => {
        const displayName = p.metadata?.annotations?.["openshift.io/display-name"] || "";
        const status = p.status?.phase || "Active";
        const icon = status === "Active" ? "[OK]" : "[WARNING]";
        parts.push(`  - ${icon} **${p.metadata.name}**${displayName ? ` (${displayName})` : ""} — ${status}`);
      });
      return parts.join("\n");
    } catch (err) {
      return `### Projects\n[CRITICAL] ${err.message}`;
    }
  }

  // Special handling for events — show with severity
  if (cmd.resourceType === "event") {
    try {
      const path = cmd.namespace
        ? `/api/v1/namespaces/${cmd.namespace}/events`
        : "/api/v1/events";
      const data = await ocpGet(path);
      const items = (data.items || [])
        .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0))
        .slice(0, 25);
      const label = cmd.namespace ? `in \`${cmd.namespace}\`` : "(all namespaces)";
      const parts = [`### Events ${label} (showing ${items.length})`];
      items.forEach((e) => {
        const icon = e.type === "Warning" ? "[WARNING]" : "[OK]";
        const age = e.lastTimestamp ? ` — ${new Date(e.lastTimestamp).toLocaleString()}` : "";
        parts.push(`  - ${icon} **${e.reason}** — ${e.involvedObject.kind}/${e.involvedObject.name} in \`${e.metadata.namespace}\`: ${(e.message || "").substring(0, 120)}${e.count > 1 ? ` (x${e.count})` : ""}${age}`);
      });
      return parts.join("\n");
    } catch (err) {
      return `### Events\n[CRITICAL] ${err.message}`;
    }
  }

  // Generic list for any resource
  try {
    const path = (resInfo.namespaced && cmd.namespace)
      ? `${resInfo.api}/namespaces/${cmd.namespace}/${resInfo.resource}`
      : `${resInfo.api}/${resInfo.resource}`;
    const data = await ocpGet(path);
    let items = data.items || [];

    // Filter by issue type when one was extracted from the query.
    if (cmd.filter && (cmd.resourceType === "pod" || cmd.resourceType === "pods")) {
      items = items.filter((p) => podMatchesFilter(p, cmd.filter));
    } else if (cmd.filter === "Failed" && (cmd.resourceType === "pod" || cmd.resourceType === "pods")) {
      items = items.filter((p) => p.status?.phase !== "Running" && p.status?.phase !== "Succeeded");
    }

    const label = cmd.namespace ? `in \`${cmd.namespace}\`` : "(all namespaces)";
    const filterLabel = cmd.filter ? ` matching **${cmd.filter}**` : "";

    // ---- Count-scope: user asked "how many", return a single line ----
    if (cmd.scope === "count") {
      return `**${items.length}** ${resInfo.resource}${filterLabel} ${label}.`;
    }

    const parts = [`### ${resInfo.resource}${filterLabel} ${label} (${items.length})`];

    if (items.length === 0) {
      parts.push(`No ${resInfo.resource}${filterLabel} found ${label}.`);
      return parts.join("\n");
    }

    // Resource-specific formatting
    if (cmd.resourceType === "pod" || cmd.resourceType === "pods") {
      items.slice(0, 40).forEach((p) => {
        const phase = p.status?.phase || "Unknown";
        const restarts = (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
        const icon = phase === "Running" ? "[OK]" : phase === "Succeeded" ? "[OK]" : "[CRITICAL]";
        const ns = p.metadata.namespace;
        parts.push(`  - ${icon} **${p.metadata.name}** (${ns}) — ${phase}${restarts > 0 ? ` — restarts: ${restarts}` : ""}`);
      });
    } else if (["deployment", "deployments", "deploy"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((d) => {
        const ready = d.status?.readyReplicas ?? 0;
        const desired = d.spec?.replicas ?? 0;
        const icon = ready === desired ? "[OK]" : "[CRITICAL]";
        parts.push(`  - ${icon} **${d.metadata.name}** (${d.metadata.namespace}) — ${ready}/${desired} ready`);
      });
    } else if (["service", "services", "svc"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((s) => {
        const ports = (s.spec?.ports || []).map((p) => `${p.port}/${p.protocol}`).join(", ");
        parts.push(`  - **${s.metadata.name}** (${s.metadata.namespace}) — ${s.spec?.type} — ${s.spec?.clusterIP} — ${ports}`);
      });
    } else if (["node", "nodes"].includes(cmd.resourceType)) {
      items.forEach((n) => {
        const ready = (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True");
        const roles = Object.keys(n.metadata?.labels || {}).filter(l => l.startsWith("node-role.kubernetes.io/")).map(l => l.split("/")[1]);
        const icon = ready ? "[OK]" : "[CRITICAL]";
        parts.push(`  - ${icon} **${n.metadata.name}** (${roles.join(", ") || "worker"}) — CPU: ${n.status?.capacity?.cpu}, Mem: ${n.status?.capacity?.memory}`);
      });
    } else if (["namespace", "namespaces", "ns"].includes(cmd.resourceType)) {
      items.forEach((ns) => {
        const icon = ns.status?.phase === "Active" ? "[OK]" : "[WARNING]";
        parts.push(`  - ${icon} **${ns.metadata.name}** — ${ns.status?.phase}`);
      });
    } else if (["route", "routes"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((r) => {
        parts.push(`  - **${r.metadata.name}** (${r.metadata.namespace}) — host: ${r.spec?.host || "?"} -> ${r.spec?.to?.name || "?"}`);
      });
    } else if (["configmap", "configmaps", "cm"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((c) => {
        const keys = Object.keys(c.data || {}).length;
        parts.push(`  - **${c.metadata.name}** (${c.metadata.namespace}) — ${keys} key(s)`);
      });
    } else if (["secret", "secrets"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((s) => {
        const keys = Object.keys(s.data || {}).length;
        parts.push(`  - **${s.metadata.name}** (${s.metadata.namespace}) — type: ${s.type} — ${keys} key(s)`);
      });
    } else if (["pvc", "pvcs", "persistentvolumeclaim"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((p) => {
        const icon = p.status?.phase === "Bound" ? "[OK]" : "[WARNING]";
        parts.push(`  - ${icon} **${p.metadata.name}** (${p.metadata.namespace}) — ${p.status?.phase} — ${p.spec?.resources?.requests?.storage || "?"} — ${p.spec?.storageClassName || "default"}`);
      });
    } else {
      // Generic format
      items.slice(0, 30).forEach((item) => {
        const ns = item.metadata?.namespace ? ` (${item.metadata.namespace})` : "";
        parts.push(`  - **${item.metadata?.name}**${ns}`);
      });
    }

    if (items.length > 40) {
      parts.push(`\n... showing first 40 of ${items.length} total`);
    }
    return parts.join("\n");
  } catch (err) {
    return `### ${resInfo.resource}\n[CRITICAL] ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Gather cluster context based on user query
// ---------------------------------------------------------------------------
async function gatherClusterContext(userMessage) {
  const lower = userMessage.toLowerCase();
  const context = {};
  const tasks = [];

  // -------------------------------------------------------------------------
  // Intent detection — understand WHAT the user is asking about
  // -------------------------------------------------------------------------
  context.intents = [];

  // Specific issue type filters
  context.queryFilter = null;
  if (lower.match(/crash\s*loop|crashloop|crash.?back|crashlook|cras.*loop/)) context.queryFilter = "CrashLoopBackOff";
  else if (lower.match(/image\s*pull|imagepull|errimagepull|image.?pull.?back|pull.?back/)) context.queryFilter = "ImagePullBackOff";
  else if (lower.match(/oom|out.?of.?memory|oomkill/)) context.queryFilter = "OOMKilled";
  else if (lower.match(/config.?error|createcontainer/)) context.queryFilter = "CreateContainerConfigError";
  else if (lower.match(/\bnot.?ready|notready/)) context.queryFilter = "NotReady";

  // Detect specific namespace early — check multiple patterns
  // "in trident namespace", "under trident namespace", "namespace trident",
  // "ns trident", "trident namespace", "in trident", "under trident"
  // Extract namespace name — try multiple patterns in priority order
  // "in/under/from/for trident namespace", "in namespace trident", "trident namespace", "namespace trident"
  const nsMatch = lower.match(
    /(?:in|under|from|for|of)\s+(?:namespace|ns|project)?\s*["']?([a-z0-9][-a-z0-9]*)["']?(?:\s+namespace)?/
  ) || lower.match(
    /\b([a-z0-9][-a-z0-9]+)\s+(?:namespace|ns|project)\b/
  ) || lower.match(
    /(?:namespace|ns|project)\s+["']?([a-z0-9][-a-z0-9]+)["']?/
  );

  // If a specific namespace is mentioned, that takes priority
  if (nsMatch) {
    context.intents.push("namespace_specific");
  }

  // Intent: pod count / pod summary (how many pods, count, running, completed, etc.)
  if (lower.match(/how many.*pod|count.*pod|pod.*count|number.*pod|pod.*number|pod.*running|running.*pod|pod.*complet|complet.*pod|pod.*succeed|succeed.*pod|pod.*status|status.*pod|pod.*summary|summary.*pod|total.*pod|pod.*total|list.*pod.*status/)) {
    context.intents.push("pod_summary");
  }

  // Intent: pod issues / failed / problems
  if (lower.match(/pod.*issue|pod.*problem|pod.*fail|pod.*error|fail.*pod|issue.*pod|problem.*pod|what.*wrong/)) {
    context.intents.push("pod_issues");
  }

  // Intent: specific issue type (from queryFilter)
  if (context.queryFilter) {
    context.intents.push("pod_issues");
  }

  // Intent: nodes
  if (lower.match(/\bnode\b|worker|master|control.?plane/)) {
    context.intents.push("nodes");
  }

  // Intent: cluster health / overview
  if (lower.match(/cluster.*health|health.*cluster|cluster.*overview|overview|cluster.*status/)) {
    context.intents.push("cluster_health");
  }

  // Intent: namespaces (list all namespaces)
  if (lower.match(/list.*namespace|all.*namespace|show.*namespace|namespace.*list/) && !nsMatch) {
    context.intents.push("namespaces");
  }

  // Intent: deployments
  if (lower.match(/deploy|scale|replica|rollout|redeploy/)) {
    context.intents.push("deployments");
  }

  // Intent: events / alerts
  if (lower.match(/event|alert|warn/)) {
    context.intents.push("events");
  }

  // Intent: operators
  if (lower.match(/operator|degrad/)) {
    context.intents.push("operators");
  }

  // Intent: services / routes
  if (lower.match(/service|route|endpoint|ingress|url/)) {
    context.intents.push("services");
  }

  // Intent: restart
  if (lower.match(/restart/)) {
    context.intents.push("pod_issues");
  }

  // Intent: diagnose / troubleshoot
  if (lower.match(/diagnos|troubleshoot|debug|investig|analyz|analyse|check/)) {
    if (!context.intents.includes("pod_issues") && !context.intents.includes("nodes")) {
      context.intents.push("cluster_health");
    }
  }

  // If no intent detected, default to a help response
  if (context.intents.length === 0) {
    context.intents.push("help");
  }

  // -------------------------------------------------------------------------
  // Fetch ONLY the data needed for detected intents
  // -------------------------------------------------------------------------

  // Always get cluster version (it's lightweight)
  tasks.push(
    ocpGet("/apis/config.openshift.io/v1/clusterversions/version")
      .then((d) => { context.clusterVersion = d.status?.desired?.version; context.channel = d.spec?.channel; })
      .catch(() => {})
  );

  // Nodes — only if intent is nodes or cluster_health
  if (context.intents.includes("nodes") || context.intents.includes("cluster_health")) {
    tasks.push(
      ocpGet("/api/v1/nodes").then((d) => {
        context.nodes = (d.items || []).map((n) => ({
          name: n.metadata.name,
          roles: Object.keys(n.metadata.labels || {})
            .filter((l) => l.startsWith("node-role.kubernetes.io/"))
            .map((l) => l.replace("node-role.kubernetes.io/", "")),
          ready: (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True"),
          cpu: n.status?.capacity?.cpu,
          memory: n.status?.capacity?.memory,
        }));
      }).catch(() => {})
    );
  }

  // Pods — fetch when asking about pods (summary, issues, or specific filter)
  if (context.intents.includes("pod_summary") || context.intents.includes("pod_issues") || context.intents.includes("cluster_health")) {
    tasks.push(
      ocpGet("/api/v1/pods").then((d) => {
        const allPods = d.items || [];
        context.totalPods = allPods.length;
        context.podsByPhase = {};
        allPods.forEach((p) => {
          const phase = p.status?.phase || "Unknown";
          context.podsByPhase[phase] = (context.podsByPhase[phase] || 0) + 1;
        });
        // Find problem pods — only truly broken ones
        context.problemPods = allPods
          .filter((p) => {
            if (p.status?.phase === "Failed" || p.status?.phase === "Unknown") return true;
            return (p.status?.containerStatuses || []).some(
              (c) =>
                c.state?.waiting?.reason === "CrashLoopBackOff" ||
                c.state?.waiting?.reason === "ImagePullBackOff" ||
                c.state?.waiting?.reason === "ErrImagePull" ||
                c.state?.waiting?.reason === "CreateContainerConfigError" ||
                c.state?.waiting?.reason === "RunContainerError" ||
                c.state?.terminated?.reason === "OOMKilled" ||
                c.state?.terminated?.reason === "Error" ||
                (!c.ready && !c.state?.running)
            );
          })
          .slice(0, 20)
          .map((p) => ({
            name: p.metadata.name,
            namespace: p.metadata.namespace,
            phase: p.status?.phase,
            node: p.spec?.nodeName,
            images: (p.spec?.containers || []).map((c) => c.image),
            resourceLimits: (p.spec?.containers || []).map((c) => ({
              name: c.name,
              memLimit: c.resources?.limits?.memory,
              memRequest: c.resources?.requests?.memory,
              cpuLimit: c.resources?.limits?.cpu,
            })),
            ownerKind: p.metadata?.ownerReferences?.[0]?.kind,
            ownerName: p.metadata?.ownerReferences?.[0]?.name,
            events: [],
            containers: (p.status?.containerStatuses || [])
              .filter((c) => !c.ready || !c.state?.running)
              .map((c) => ({
                name: c.name,
                ready: c.ready,
                restarts: c.restartCount,
                state: c.state?.waiting?.reason || c.state?.terminated?.reason || (c.state?.running ? "Running" : "Unknown"),
                exitCode: c.state?.terminated?.exitCode ?? c.lastState?.terminated?.exitCode,
                lastReason: c.lastState?.terminated?.reason,
              })),
          }))
          .filter((p) => p.containers.length > 0);
      }).catch(() => {})
    );
  }

  // Namespaces (list all)
  if (context.intents.includes("namespaces")) {
    tasks.push(
      ocpGet("/api/v1/namespaces").then((d) => {
        context.namespaces = (d.items || [])
          .filter((ns) =>
            !ns.metadata.name.startsWith("openshift-") &&
            !ns.metadata.name.startsWith("kube-") &&
            ns.metadata.name !== "default" &&
            ns.metadata.name !== "openshift"
          )
          .map((ns) => ({ name: ns.metadata.name, status: ns.status?.phase }));
      }).catch(() => {})
    );
  }

  // Specific namespace pods/deployments
  if (nsMatch) {
    const ns = nsMatch[1];
    tasks.push(
      ocpGet(`/api/v1/namespaces/${ns}/pods`).then((d) => {
        context.namespacePods = (d.items || []).map((p) => ({
          name: p.metadata.name,
          phase: p.status?.phase,
          restarts: (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0),
          containers: (p.status?.containerStatuses || []).map((c) => ({
            name: c.name,
            ready: c.ready,
            state: c.state?.waiting?.reason || c.state?.terminated?.reason || (c.state?.running ? "Running" : "Unknown"),
          })),
        }));
        context.targetNamespace = ns;
      }).catch(() => {})
    );
    tasks.push(
      ocpGet(`/apis/apps/v1/namespaces/${ns}/deployments`).then((d) => {
        context.namespaceDeployments = (d.items || []).map((dep) => ({
          name: dep.metadata.name,
          replicas: dep.spec?.replicas,
          ready: dep.status?.readyReplicas || 0,
          available: dep.status?.availableReplicas || 0,
          image: dep.spec?.template?.spec?.containers?.[0]?.image,
        }));
      }).catch(() => {})
    );
  }

  // Deployments
  if (context.intents.includes("deployments")) {
    tasks.push(
      ocpGet("/apis/apps/v1/deployments").then((d) => {
        context.deployments = (d.items || []).slice(0, 30).map((dep) => ({
          name: dep.metadata.name,
          namespace: dep.metadata.namespace,
          replicas: dep.spec?.replicas,
          ready: dep.status?.readyReplicas || 0,
          available: dep.status?.availableReplicas || 0,
        }));
      }).catch(() => {})
    );
  }

  // Events (warnings)
  if (context.intents.includes("events") || context.intents.includes("cluster_health")) {
    tasks.push(
      ocpGet("/api/v1/events").then((d) => {
        context.warningEvents = (d.items || [])
          .filter((e) => e.type === "Warning")
          .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0))
          .slice(0, 15)
          .map((e) => ({
            reason: e.reason,
            message: e.message,
            object: `${e.involvedObject.kind}/${e.involvedObject.name}`,
            namespace: e.metadata.namespace,
            count: e.count,
            lastSeen: e.lastTimestamp,
          }));
      }).catch(() => {})
    );
  }

  // Operators
  if (context.intents.includes("operators") || context.intents.includes("cluster_health")) {
    tasks.push(
      ocpGet("/apis/config.openshift.io/v1/clusteroperators").then((d) => {
        context.operators = (d.items || []).map((op) => {
          const conds = (op.status?.conditions || []).reduce((a, c) => { a[c.type] = c.status; return a; }, {});
          return {
            name: op.metadata.name,
            available: conds.Available,
            degraded: conds.Degraded,
            progressing: conds.Progressing,
          };
        });
      }).catch(() => {})
    );
  }

  // Services, routes (need a specific namespace)
  if (context.intents.includes("services") && nsMatch) {
    const ns = nsMatch[1];
    tasks.push(
      ocpGet(`/api/v1/namespaces/${ns}/services`).then((d) => {
        context.services = (d.items || []).map((s) => ({
          name: s.metadata.name, type: s.spec?.type, clusterIP: s.spec?.clusterIP,
          ports: s.spec?.ports?.map((p) => `${p.port}/${p.protocol}`),
        }));
      }).catch(() => {})
    );
    tasks.push(
      ocpGet(`/apis/route.openshift.io/v1/namespaces/${ns}/routes`).then((d) => {
        context.routes = (d.items || []).map((r) => ({
          name: r.metadata.name, host: r.spec?.host, service: r.spec?.to?.name,
        }));
      }).catch(() => {})
    );
  }

  await Promise.all(tasks);

  // Secondary pass: fetch events for problem pods to understand root causes
  if (context.problemPods && context.problemPods.length > 0) {
    const problemNs = [...new Set(context.problemPods.map((p) => p.namespace))];
    await Promise.all(
      problemNs.map((ns) =>
        ocpGet(`/api/v1/namespaces/${ns}/events`)
          .then((d) => {
            (d.items || [])
              .filter((e) => e.involvedObject.kind === "Pod" && e.type === "Warning")
              .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0))
              .forEach((evt) => {
                const pod = context.problemPods.find(
                  (p) => p.name === evt.involvedObject.name && p.namespace === ns
                );
                if (pod && pod.events.length < 5) {
                  pod.events.push({
                    reason: evt.reason,
                    message: evt.message,
                    count: evt.count,
                  });
                }
              });
          })
          .catch(() => {})
      )
    );
  }

  return context;
}

// ---------------------------------------------------------------------------
// LLM System Prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an OpenShift Cluster AI Assistant. You help users understand their OpenShift cluster status, diagnose issues, and recommend fixes.

You have access to live cluster data provided as JSON context. Use this data to give accurate, specific answers.

When diagnosing issues:
- Identify the root cause from events, pod status, and container states
- Provide specific fix commands (oc commands or YAML patches)
- Explain the impact and risk of the fix
- For critical issues, mention the emergency_fix MCP tool
- For changes that need approval, mention the ServiceNow change request flow

When listing resources:
- Format data clearly with tables or bullet points
- Highlight any unhealthy or unusual items
- Include relevant details like restart counts, status, and resource usage

Always be concise but thorough. Use markdown formatting.`;

// ---------------------------------------------------------------------------
// Call external LLM
// ---------------------------------------------------------------------------
async function callLLM(userMessage, clusterContext, opts = {}) {
  const provider = opts.provider || LLM_PROVIDER;
  const apiUrl = opts.apiUrl || LLM_API_URL;
  const apiKey = opts.apiKey || LLM_API_KEY;
  const model = opts.model || LLM_MODEL;

  const contextStr = JSON.stringify(clusterContext, null, 2);
  const userContent = `${userMessage}\n\n--- Live Cluster Data ---\n${contextStr}`;

  if (provider === "openai") {
    const resp = await fetch(`${apiUrl || "https://api.openai.com"}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "gpt-4",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      }),
    });
    const data = await resp.json();
    if (data.error) return `LLM Error: ${data.error.message || JSON.stringify(data.error)}`;
    return data.choices?.[0]?.message?.content || "No response from LLM.";
  }

  if (provider === "anthropic") {
    const resp = await fetch(`${apiUrl || "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-20250514",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        max_tokens: 2000,
      }),
    });
    const data = await resp.json();
    if (data.error) return `LLM Error: ${data.error.message || JSON.stringify(data.error)}`;
    return data.content?.[0]?.text || "No response from LLM.";
  }

  if (provider === "ollama") {
    const resp = await fetch(`${apiUrl || "http://localhost:11434"}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || "llama3",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        stream: false,
      }),
    });
    const data = await resp.json();
    return data.message?.content || "No response from Ollama.";
  }

  // Fallback: built-in analysis (no external LLM)
  return builtInAnalysis(userMessage, clusterContext);
}

// ---------------------------------------------------------------------------
// Built-in analysis (when no LLM is configured)
// ---------------------------------------------------------------------------
function builtInAnalysis(userMessage, ctx) {
  const lower = userMessage.toLowerCase();
  const parts = [];
  const filter = ctx.queryFilter; // Specific issue type the user asked about

  // -------------------------------------------------------------------------
  // Root cause analysis — explain WHY the pod is failing
  // -------------------------------------------------------------------------
  function analyzeRootCause(p) {
    const c0 = p.containers[0];
    const state = c0?.state;
    const events = p.events || [];
    const lines = [];

    if (state === "ImagePullBackOff" || state === "ErrImagePull") {
      lines.push(`**Image:** \`${p.images?.[0] || "unknown"}\``);
      const pullEvt = events.find((e) => e.reason === "Failed" && e.message?.toLowerCase().includes("pull"));
      if (pullEvt) {
        lines.push(`**Error:** ${pullEvt.message.substring(0, 200)}`);
      } else {
        lines.push("**Cause:** Image cannot be pulled — check image name, tag, registry auth, or network connectivity.");
      }
      lines.push("**Likely fix:** Correct the image reference in the deployment, or create/update the imagePullSecret.");
    } else if (state === "CrashLoopBackOff") {
      lines.push(`**Restarts:** ${c0.restarts} times`);
      if (c0.exitCode !== undefined && c0.exitCode !== null) {
        const exitMsg = c0.exitCode === 1 ? "application error" : c0.exitCode === 137 ? "killed (OOM or signal)" : c0.exitCode === 139 ? "segfault" : c0.exitCode === 143 ? "terminated gracefully" : `exit code ${c0.exitCode}`;
        lines.push(`**Last exit:** ${exitMsg} (code ${c0.exitCode})`);
      }
      if (c0.lastReason) lines.push(`**Last termination:** ${c0.lastReason}`);
      const backoffEvt = events.find((e) => e.reason === "BackOff");
      if (backoffEvt) lines.push(`**Event:** ${backoffEvt.message?.substring(0, 150)}`);
      lines.push("**Likely fix:** Check container logs for the crash reason, fix app code/config, then restart.");
    } else if (state === "OOMKilled") {
      const lim = p.resourceLimits?.[0];
      if (lim?.memLimit) {
        lines.push(`**Memory limit:** ${lim.memLimit}${lim.memRequest ? ` (request: ${lim.memRequest})` : ""}`);
      }
      lines.push("**Cause:** Container exceeded its memory limit and was killed by the kernel.");
      lines.push("**Likely fix:** Increase memory limits or investigate memory leaks in the application.");
    } else if (state === "CreateContainerConfigError") {
      const cfgEvt = events.find((e) => e.reason === "Failed" && e.message?.includes("configmap"));
      const secEvt = events.find((e) => e.reason === "Failed" && e.message?.includes("secret"));
      if (cfgEvt) lines.push(`**Error:** Missing ConfigMap — ${cfgEvt.message.substring(0, 150)}`);
      else if (secEvt) lines.push(`**Error:** Missing Secret — ${secEvt.message.substring(0, 150)}`);
      else lines.push("**Cause:** Container config error — a referenced ConfigMap, Secret, or volume may not exist.");
    } else {
      if (events.length > 0) {
        lines.push(`**Event:** ${events[0].message?.substring(0, 200)}`);
      }
      lines.push(`**State:** ${state}`);
    }
    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Render a single pod: issue card + analysis + fix commands + apply button
  // -------------------------------------------------------------------------
  function renderPodWithFix(p, fixType) {
    const detail = p.containers
      .map((c) => `${c.name}: ${c.state}${c.restarts ? ` (${c.restarts} restarts)` : ""}`)
      .join(", ");
    parts.push(`@@POD_ISSUE|${p.name}|${p.namespace}|${detail}@@`);

    // Root cause analysis
    const analysis = analyzeRootCause(p);
    if (analysis) parts.push(analysis);

    // Fix commands + Apply button specific to THIS pod
    const n = p.name;
    const ns = p.namespace;
    if (fixType === "CrashLoopBackOff") {
      parts.push("```" + `# Fix: ${n}\noc logs ${n} -n ${ns} --previous\noc describe pod ${n} -n ${ns}\noc delete pod ${n} -n ${ns}` + "```");
      parts.push(`@@APPLY_BTN|delete_pod|${n}|${ns}|Restart Pod@@`);
    } else if (fixType === "ImagePullBackOff") {
      parts.push("```" + `# Fix: ${n}\noc get pod ${n} -n ${ns} -o jsonpath='{.spec.containers[*].image}'\noc describe pod ${n} -n ${ns} | grep -A10 Events` + "```");
      parts.push(`@@APPLY_BTN|delete_pod|${n}|${ns}|Restart Pod@@`);
    } else if (fixType === "OOMKilled") {
      parts.push("```" + `# Fix: ${n}\noc get pod ${n} -n ${ns} -o jsonpath='{.spec.containers[*].resources}'` + "```");
      parts.push(`@@APPLY_BTN|delete_pod|${n}|${ns}|Restart Pod@@`);
    } else {
      parts.push("```" + `# Diagnose: ${n}\noc describe pod ${n} -n ${ns}\noc logs ${n} -n ${ns}` + "```");
      parts.push(`@@APPLY_BTN|delete_pod|${n}|${ns}|Restart Pod@@`);
    }
  }

  // Helper: render a group heading then each pod with its own fix
  function renderPodGroup(label, severity, pods, fixType) {
    if (pods.length === 0) return;
    parts.push(`\n${severity} **${label}** (${pods.length} pod${pods.length > 1 ? "s" : ""})`);
    pods.forEach((p) => renderPodWithFix(p, fixType));
  }

  // -------------------------------------------------------------------------
  // SPECIFIC QUERY: user asked about a particular issue type
  // -------------------------------------------------------------------------
  if (filter && ctx.problemPods) {
    const filterMap = {
      CrashLoopBackOff:          (p) => p.containers.some((c) => c.state === "CrashLoopBackOff"),
      ImagePullBackOff:          (p) => p.containers.some((c) => c.state === "ImagePullBackOff" || c.state === "ErrImagePull"),
      OOMKilled:                 (p) => p.containers.some((c) => c.state === "OOMKilled"),
      CreateContainerConfigError:(p) => p.containers.some((c) => c.state === "CreateContainerConfigError"),
      Failed:                    (p) => p.phase === "Failed",
      Pending:                   (p) => p.phase === "Pending",
      NotReady:                  (p) => p.containers.some((c) => !c.ready),
    };
    const matchFn = filterMap[filter] || (() => false);
    const matched = ctx.problemPods.filter(matchFn);

    parts.push(`### ${filter} Pods`);

    if (matched.length === 0) {
      parts.push(`[OK] **No ${filter} pods found.** Your cluster has no pods in this state.`);
      // Show what IS found instead
      if (ctx.problemPods.length > 0) {
        const states = {};
        ctx.problemPods.forEach((p) =>
          p.containers.forEach((c) => { states[c.state] = (states[c.state] || 0) + 1; })
        );
        parts.push(`\nHowever, there are **${ctx.problemPods.length}** pods with other issues:`);
        Object.entries(states).forEach(([state, count]) => {
          parts.push(`  - **${state}**: ${count}`);
        });
      }
    } else {
      parts.push(`@@SUMMARY|red:${matched.length} ${filter}@@`);

      if (filter === "CrashLoopBackOff") {
        renderPodGroup("CrashLoopBackOff", "[CRITICAL]", matched, "CrashLoopBackOff");
      } else if (filter === "ImagePullBackOff") {
        renderPodGroup("ImagePullBackOff / ErrImagePull", "[CRITICAL]", matched, "ImagePullBackOff");
      } else if (filter === "OOMKilled") {
        renderPodGroup("OOMKilled", "[CRITICAL]", matched, "OOMKilled");
      } else {
        renderPodGroup(filter, "[WARNING]", matched, "other");
      }
    }
    return parts.join("\n");
  }

  // -------------------------------------------------------------------------
  // INTENT-DRIVEN RESPONSE — only show what the user asked for
  // -------------------------------------------------------------------------
  const intents = ctx.intents || [];

  // --- NAMESPACE-SPECIFIC: always takes priority when user mentions a namespace ---
  if (intents.includes("namespace_specific") && ctx.namespacePods) {
    const ns = ctx.targetNamespace;
    const allNsPods = ctx.namespacePods;
    const phaseCount = {};
    allNsPods.forEach((p) => { phaseCount[p.phase] = (phaseCount[p.phase] || 0) + 1; });
    const running = phaseCount["Running"] || 0;
    const succeeded = phaseCount["Succeeded"] || 0;
    const failed = phaseCount["Failed"] || 0;
    const pending = phaseCount["Pending"] || 0;

    // If user is asking about counts/summary in this namespace
    if (intents.includes("pod_summary")) {
      parts.push(`### Pods in \`${ns}\``);
      parts.push(`**Total:** ${allNsPods.length} pods`);
      const summaryParts = [`green:${running} Running`];
      if (succeeded > 0) summaryParts.push(`green:${succeeded} Completed`);
      if (failed > 0) summaryParts.push(`red:${failed} Failed`);
      if (pending > 0) summaryParts.push(`amber:${pending} Pending`);
      parts.push(`@@SUMMARY|${summaryParts.join("|")}@@`);
      parts.push(`  - **Running:** ${running}`);
      parts.push(`  - **Completed/Succeeded:** ${succeeded}`);
      if (failed > 0) parts.push(`  - **Failed:** ${failed}`);
      if (pending > 0) parts.push(`  - **Pending:** ${pending}`);
      Object.entries(phaseCount).forEach(([phase, count]) => {
        if (!["Running", "Succeeded", "Failed", "Pending"].includes(phase)) {
          parts.push(`  - **${phase}:** ${count}`);
        }
      });
      // Show issue pods briefly
      const issuePods = allNsPods.filter((p) => p.phase !== "Running" && p.phase !== "Succeeded" && p.restarts >= 5);
      if (issuePods.length > 0) {
        parts.push(`\n**${issuePods.length} pod(s) may need attention:**`);
        issuePods.forEach((p) => {
          const containerInfo = p.containers.map((c) => c.state).join(", ");
          parts.push(`  - **${p.name}** — ${p.phase} — [${containerInfo}]`);
        });
      }
      return parts.join("\n");
    }

    // If user is asking about pod issues in this namespace
    if (intents.includes("pod_issues")) {
      const issuePods = allNsPods.filter((p) =>
        p.phase === "Failed" || p.phase === "Unknown" ||
        p.containers.some((c) => c.state !== "Running" && c.state !== "Completed")
      );
      parts.push(`### Pod Issues in \`${ns}\``);
      if (issuePods.length === 0) {
        parts.push(`[OK] **No pod issues in \`${ns}\`.** All ${allNsPods.length} pods are healthy.`);
      } else {
        parts.push(`**${issuePods.length}** pod(s) with issues out of ${allNsPods.length} total:`);
        issuePods.forEach((p) => {
          const containerInfo = p.containers.map((c) => c.state).join(", ");
          parts.push(`@@POD_ISSUE|${p.name}|${ns}|Phase: ${p.phase} — Restarts: ${p.restarts} — [${containerInfo}]@@`);
        });
      }
      return parts.join("\n");
    }

    // Default: show general namespace overview
    parts.push(`### Pods in \`${ns}\` (${allNsPods.length})`);
    const summaryParts = [`green:${running} Running`];
    if (succeeded > 0) summaryParts.push(`green:${succeeded} Completed`);
    if (failed > 0) summaryParts.push(`red:${failed} Failed`);
    if (pending > 0) summaryParts.push(`amber:${pending} Pending`);
    parts.push(`@@SUMMARY|${summaryParts.join("|")}@@`);

    allNsPods.forEach((p) => {
      const isOk = p.phase === "Running" && p.restarts < 5;
      if (!isOk) {
        const containerInfo = p.containers.map((c) => c.state).join(", ");
        parts.push(`@@POD_ISSUE|${p.name}|${ns}|Phase: ${p.phase} — Restarts: ${p.restarts} — [${containerInfo}]@@`);
      } else {
        parts.push(`  - [OK] **${p.name}** — ${p.phase} — restarts: ${p.restarts}`);
      }
    });

    if (ctx.namespaceDeployments && ctx.namespaceDeployments.length > 0) {
      parts.push(`\n### Deployments in \`${ns}\``);
      ctx.namespaceDeployments.forEach((d) => {
        const icon = d.ready === d.replicas ? "[OK]" : "[CRITICAL]";
        parts.push(`  - ${icon} **${d.name}** — ${d.ready}/${d.replicas} ready`);
      });
    }

    return parts.join("\n");
  }

  // --- Pod Summary (how many running, completed, etc.) ---
  if (intents.includes("pod_summary") && !filter) {
    parts.push(`### Pod Summary`);
    if (ctx.totalPods) {
      parts.push(`**Total pods:** ${ctx.totalPods}`);
      if (ctx.podsByPhase) {
        const running = ctx.podsByPhase["Running"] || 0;
        const succeeded = ctx.podsByPhase["Succeeded"] || 0;
        const failed = (ctx.podsByPhase["Failed"] || 0) + (ctx.podsByPhase["Unknown"] || 0);
        const pending = ctx.podsByPhase["Pending"] || 0;
        const summaryParts = [`green:${running} Running`];
        if (succeeded > 0) summaryParts.push(`green:${succeeded} Completed`);
        if (failed > 0) summaryParts.push(`red:${failed} Failed`);
        if (pending > 0) summaryParts.push(`amber:${pending} Pending`);
        parts.push(`@@SUMMARY|${summaryParts.join("|")}@@`);
        parts.push(`  - **Running:** ${running}`);
        parts.push(`  - **Completed/Succeeded:** ${succeeded}`);
        if (failed > 0) parts.push(`  - **Failed:** ${failed}`);
        if (pending > 0) parts.push(`  - **Pending:** ${pending}`);
        // Show any other phases
        Object.entries(ctx.podsByPhase).forEach(([phase, count]) => {
          if (!["Running", "Succeeded", "Failed", "Unknown", "Pending"].includes(phase)) {
            parts.push(`  - **${phase}:** ${count}`);
          }
        });
      }
    } else {
      parts.push(`Unable to fetch pod data.`);
    }

    // Only mention issues briefly if there are any, don't list them all
    if (ctx.problemPods && ctx.problemPods.length > 0) {
      const states = {};
      ctx.problemPods.forEach((p) => p.containers.forEach((c) => { states[c.state] = (states[c.state] || 0) + 1; }));
      parts.push(`\n**${ctx.problemPods.length} pod(s) with issues:**`);
      Object.entries(states).forEach(([state, count]) => {
        parts.push(`  - ${count} ${state}`);
      });
      parts.push(`\nAsk about a specific issue type for details (e.g. "show CrashLoopBackOff pods").`);
    }
    return parts.join("\n");
  }

  // --- Pod Issues (when user asks about failed/problem pods without a specific filter) ---
  if (intents.includes("pod_issues") && !filter) {
    if (ctx.problemPods && ctx.problemPods.length > 0) {
      const crashPods = ctx.problemPods.filter((p) => p.containers.some((c) => c.state === "CrashLoopBackOff"));
      const oomPods = ctx.problemPods.filter((p) => p.containers.some((c) => c.state === "OOMKilled"));
      const imgPods = ctx.problemPods.filter((p) => p.containers.some((c) => c.state === "ImagePullBackOff" || c.state === "ErrImagePull"));
      const otherPods = ctx.problemPods.filter((p) =>
        !crashPods.includes(p) && !oomPods.includes(p) && !imgPods.includes(p)
      );

      parts.push(`### Failed Pods — ${ctx.problemPods.length} Issues Found`);
      const summaryParts = [];
      if (crashPods.length > 0) summaryParts.push(`red:${crashPods.length} CrashLoop`);
      if (oomPods.length > 0)   summaryParts.push(`amber:${oomPods.length} OOMKilled`);
      if (imgPods.length > 0)   summaryParts.push(`red:${imgPods.length} ImagePull`);
      if (otherPods.length > 0) summaryParts.push(`amber:${otherPods.length} Other`);
      if (summaryParts.length > 0) parts.push(`@@SUMMARY|${summaryParts.join("|")}@@`);

      renderPodGroup("CrashLoopBackOff", "[CRITICAL]", crashPods, "CrashLoopBackOff");
      renderPodGroup("OOMKilled", "[WARNING]", oomPods, "OOMKilled");
      renderPodGroup("ImagePullBackOff", "[CRITICAL]", imgPods, "ImagePullBackOff");
      renderPodGroup("Other Issues", "[WARNING]", otherPods, "other");
    } else {
      parts.push(`### Pod Status`);
      parts.push(`[OK] **No pod issues detected.** All pods are running normally.`);
    }
    return parts.join("\n");
  }

  // --- Nodes ---
  if (intents.includes("nodes") && !intents.includes("cluster_health") && ctx.nodes) {
    const ready = ctx.nodes.filter((n) => n.ready).length;
    const notReady = ctx.nodes.filter((n) => !n.ready);
    parts.push(`### Node Status`);
    parts.push(`@@SUMMARY|green:${ready} Ready${notReady.length > 0 ? `|red:${notReady.length} NotReady` : ""}@@`);
    ctx.nodes.forEach((n) => {
      const status = n.ready ? "[OK]" : "[CRITICAL]";
      parts.push(`  - ${status} **${n.name}** (${n.roles.join(", ")}) — CPU: ${n.cpu}, Mem: ${n.memory}`);
    });
    if (notReady.length > 0) {
      parts.push(`\n[CRITICAL] **${notReady.length} node(s) are NotReady:**`);
      parts.push("```" + `oc describe node ${notReady[0].name}\noc get node ${notReady[0].name} -o yaml` + "```");
    }
    return parts.join("\n");
  }

  // --- Cluster Health / Overview ---
  if (intents.includes("cluster_health")) {
    if (ctx.clusterVersion) {
      parts.push(`### Cluster Overview`);
      parts.push(`**OpenShift** ${ctx.clusterVersion} (${ctx.channel || "unknown channel"})`);
    }

    if (ctx.nodes) {
      const ready = ctx.nodes.filter((n) => n.ready).length;
      const notReady = ctx.nodes.filter((n) => !n.ready);
      parts.push(`\n### Node Status`);
      parts.push(`@@SUMMARY|green:${ready} Ready${notReady.length > 0 ? `|red:${notReady.length} NotReady` : ""}@@`);
      ctx.nodes.forEach((n) => {
        const status = n.ready ? "[OK]" : "[CRITICAL]";
        parts.push(`  - ${status} **${n.name}** (${n.roles.join(", ")}) — CPU: ${n.cpu}, Mem: ${n.memory}`);
      });
    }

    if (ctx.operators) {
      const degraded = ctx.operators.filter((o) => o.degraded === "True");
      parts.push(`\n### Cluster Operators`);
      if (degraded.length > 0) {
        parts.push(`[CRITICAL] **${degraded.length} degraded operator(s):**`);
        degraded.forEach((o) => parts.push(`@@POD_ISSUE|${o.name}|cluster-operator|Status: Degraded@@`));
      } else {
        parts.push(`[OK] All **${ctx.operators.length}** operators are available and healthy.`);
      }
    }

    if (ctx.problemPods && ctx.problemPods.length > 0) {
      const states = {};
      ctx.problemPods.forEach((p) => p.containers.forEach((c) => { states[c.state] = (states[c.state] || 0) + 1; }));
      parts.push(`\n### Pod Issues — ${ctx.problemPods.length} problem pods`);
      Object.entries(states).forEach(([state, count]) => {
        parts.push(`  - **${state}:** ${count}`);
      });
    } else {
      parts.push(`\n[OK] No pod issues detected.`);
    }

    return parts.join("\n");
  }

  // --- Namespaces ---
  if (intents.includes("namespaces") && ctx.namespaces) {
    parts.push(`### User Namespaces (${ctx.namespaces.length})`);
    ctx.namespaces.forEach((ns) => {
      const icon = ns.status === "Active" ? "[OK]" : "[WARNING]";
      parts.push(`  - ${icon} **${ns.name}** — ${ns.status}`);
    });
    return parts.join("\n");
  }

  // (namespace-specific queries are handled above by namespace_specific intent)

  // --- Deployments ---
  if (intents.includes("deployments") && ctx.deployments) {
    parts.push(`### Deployments (${ctx.deployments.length})`);
    ctx.deployments.forEach((d) => {
      const icon = d.ready === d.replicas ? "[OK]" : "[CRITICAL]";
      parts.push(`  - ${icon} **${d.name}** (${d.namespace}) — ${d.ready}/${d.replicas} ready`);
    });
    return parts.join("\n");
  }

  // --- Events ---
  if (intents.includes("events") && ctx.warningEvents && ctx.warningEvents.length > 0) {
    parts.push(`### Recent Warning Events`);
    ctx.warningEvents.slice(0, 10).forEach((e) => {
      const severity = (e.reason === "BackOff" || e.reason === "Failed" || e.reason === "OOMKilling")
        ? "[CRITICAL]" : "[WARNING]";
      parts.push(`  - ${severity} **${e.reason}** — ${e.object} in \`${e.namespace}\`: ${e.message?.substring(0, 100)}${e.count > 1 ? ` (x${e.count})` : ""}`);
    });
    return parts.join("\n");
  }

  // --- Operators ---
  if (intents.includes("operators") && ctx.operators) {
    const degraded = ctx.operators.filter((o) => o.degraded === "True");
    parts.push(`### Cluster Operators`);
    if (degraded.length > 0) {
      parts.push(`[CRITICAL] **${degraded.length} degraded operator(s):**`);
      degraded.forEach((o) => parts.push(`@@POD_ISSUE|${o.name}|cluster-operator|Status: Degraded@@`));
      parts.push(`\n**Diagnose:**`);
      parts.push("```" + `oc describe clusteroperator ${degraded[0].name}\noc get clusteroperator ${degraded[0].name} -o yaml` + "```");
    } else {
      parts.push(`[OK] All **${ctx.operators.length}** operators are available and healthy.`);
    }
    return parts.join("\n");
  }

  // --- Services / Routes ---
  if (ctx.services) {
    parts.push(`### Services in \`${ctx.targetNamespace}\``);
    ctx.services.forEach((s) => parts.push(`  - **${s.name}** (${s.type}) — ${s.clusterIP} — ${(s.ports || []).join(", ")}`));
  }
  if (ctx.routes) {
    parts.push(`\n### Routes in \`${ctx.targetNamespace}\``);
    ctx.routes.forEach((r) => parts.push(`  - **${r.name}** — https://${r.host} -> ${r.service}`));
  }
  if (ctx.services || ctx.routes) {
    return parts.join("\n");
  }

  // --- Fallback: help ---
  parts.push(`### MCP AI Assistant`);
  parts.push(`\nI can perform operations on your OpenShift cluster. Try asking:`);
  parts.push(`\n**Pods:**`);
  parts.push(`  - "List pods in namespace trident"`);
  parts.push(`  - "Describe pod my-pod in namespace default"`);
  parts.push(`  - "Show logs for my-pod in namespace default"`);
  parts.push(`  - "Top pods in namespace monitoring" (resource usage)`);
  parts.push(`  - "Delete pod crashed-pod in namespace default"`);
  parts.push(`  - "Run pod test-pod image nginx:latest in namespace default"`);
  parts.push(`  - "Show CrashLoopBackOff pods" / "Show pod issues"`);
  parts.push(`\n**Resources:**`);
  parts.push(`  - "List deployments in namespace my-app"`);
  parts.push(`  - "List services in namespace default"`);
  parts.push(`  - "List configmaps in namespace trident"`);
  parts.push(`  - "List routes in namespace openshift-console"`);
  parts.push(`  - "List events in namespace my-app"`);
  parts.push(`  - "List pvcs" / "List secrets in namespace X"`);
  parts.push(`\n**Cluster:**`);
  parts.push(`  - "List nodes" / "List namespaces" / "List projects"`);
  parts.push(`  - "Check cluster health" / "Show cluster operators"`);
  parts.push(`  - "How many pods are running?"`);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// POST /api/chat handler
// ---------------------------------------------------------------------------
export async function handleChatAPI(req, res) {
  const startedAt = Date.now();
  let conversationId = null;
  let userMessage = null;
  let intentsForLog = null;
  let cacheHit = false;
  let activeProvider = LLM_PROVIDER;

  try {
    const body = await readBody(req);
    userMessage = body.message;
    conversationId = body.conversationId || body.chatId || null;

    if (!userMessage) {
      json(res, 400, { error: "Missing 'message' field" });
      return;
    }

    // Override LLM settings from request (for UI provider selector)
    const llmOpts = {};
    if (body.provider) llmOpts.provider = body.provider;
    if (body.apiKey) llmOpts.apiKey = body.apiKey;
    if (body.apiUrl) llmOpts.apiUrl = body.apiUrl;
    if (body.model) llmOpts.model = body.model;

    activeProvider = llmOpts.provider || LLM_PROVIDER;

    // ---- NLU: parse the message once, with conversation memory for
    // follow-up resolution ("show its logs", "delete it", "same in prod").
    const memory = await getMemory(conversationId);
    const parsed = nluParse(userMessage, memory);
    intentsForLog = [parsed.intent, parsed.resource, parsed.scope]
      .filter(Boolean);

    // Persist user message (best effort, no-op if DB not configured)
    if (conversationId) {
      histAddMessage(conversationId, {
        role: "user",
        content: userMessage,
        provider: activeProvider,
      }).catch(() => {});
    }

    // ---- Redis cache lookup ----
    // Mutating intents (delete / update / exec / run) always bypass the
    // cache so they hit the live cluster.
    const isMutating = ["delete", "update", "exec", "run", "create"].includes(parsed.intent);
    const cacheKey = cacheKeyForChat(userMessage, activeProvider);

    if (!isMutating) {
      const cached = await cacheGet(cacheKey);
      if (cached && cached.reply) {
        cacheHit = true;
        if (conversationId) {
          histAddMessage(conversationId, {
            role: "assistant",
            content: cached.reply,
            provider: cached.provider,
          }).catch(() => {});
        }
        histLogQuery({
          conversationId,
          query: userMessage,
          intents: cached.contextKeys || null,
          cacheHit: true,
          durationMs: Date.now() - startedAt,
        }).catch(() => {});
        return json(res, 200, {
          reply: cached.reply,
          provider: cached.provider,
          contextKeys: cached.contextKeys || [],
          cached: true,
          conversationId,
        });
      }
    }

    // Adapt the parsed NLU result to the legacy command shape used by the
    // direct/list handlers below.
    const cmd = nluToCommand(parsed);

    // Help intent gets a curated cheat-sheet, no cluster call.
    if (parsed.intent === "help") {
      const reply = buildHelpMessage();
      const provider = "built-in";
      const payload = { reply, provider, contextKeys: ["help"] };
      cacheSet(cacheKey, payload, CHAT_CACHE_TTL).catch(() => {});
      if (conversationId) {
        histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
      }
      return json(res, 200, { ...payload, cached: false, conversationId });
    }

    // ---- Text-based approval shortcuts: "confirm <id>" / "cancel <id>" ----
    const approvalCmd = userMessage
      .trim()
      .match(/^(confirm|approve|cancel|reject)\s+(act_[a-z0-9]+)\s*$/i);
    if (approvalCmd) {
      const verb = approvalCmd[1].toLowerCase();
      const actId = approvalCmd[2];
      let reply;
      if (verb === "confirm" || verb === "approve") {
        const r = await confirmAction(actId);
        if (r.error) {
          reply = `### Action error\n[CRITICAL] ${r.error}`;
        } else {
          reply = `### Action confirmed\n**${r.action.summary}** — status: \`${r.action.status}\`` +
            (r.action.servicenowCrNumber ? `\nServiceNow CR: **${r.action.servicenowCrNumber}**` : "");
          if (r.action.status === "approved") {
            const exec = await executeAction(actId);
            if (exec.action?.status === "executed") {
              reply += `\n\n[OK] ${exec.action.result?.message || "Executed."}`;
            } else if (exec.error) {
              reply += `\n\n[CRITICAL] Execute failed: ${exec.error}`;
            }
          }
        }
      } else {
        const r = await cancelAction(actId);
        reply = r.error
          ? `### Action error\n[CRITICAL] ${r.error}`
          : `### Action cancelled\n${r.action.summary}`;
      }
      const provider = "built-in";
      const payload = { reply, provider, contextKeys: ["actionWorkflow", verb] };
      if (conversationId) {
        histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
      }
      return json(res, 200, { ...payload, cached: false, conversationId });
    }

    // ---- Approval gate: mutating intents are queued as pending_actions ----
    const actionIntent = actionFromParse(parsed);
    if (actionIntent) {
      // Require a namespace for namespaced resources — prompt the user
      // rather than silently queueing a half-specified action.
      if (!actionIntent.namespace) {
        const reply = [
          `### ${actionIntent.action} ${actionIntent.resourceType}`,
          `[WARNING] Please specify the namespace.`,
          ``,
          `**Example:** \`${actionIntent.action} ${actionIntent.resourceType} ${actionIntent.resourceName} in namespace my-ns\``,
        ].join("\n");
        if (conversationId) {
          histAddMessage(conversationId, { role: "assistant", content: reply, provider: "built-in" }).catch(() => {});
        }
        return json(res, 200, {
          reply,
          provider: "built-in",
          contextKeys: ["actionWorkflow", "missingNamespace"],
          cached: false,
          conversationId,
        });
      }
      try {
        const act = await createPendingAction({
          conversationId,
          action: actionIntent.action,
          resourceType: actionIntent.resourceType,
          resourceName: actionIntent.resourceName,
          namespace: actionIntent.namespace,
          options: actionIntent.options,
          requestedBy: "dashboard-user",
        });
        const reply = renderPendingMessage(act);
        const provider = "built-in";
        const payload = {
          reply,
          provider,
          contextKeys: ["actionWorkflow", "pending"],
          pendingAction: act,
        };
        if (conversationId) {
          histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
        }
        updateMemory(conversationId, memoryPatchFromParse(parsed)).catch(() => {});
        return json(res, 200, { ...payload, cached: false, conversationId });
      } catch (err) {
        console.error("[chat-api] action workflow error:", err);
        // Fall through to default handlers on error so the user still gets a reply.
      }
    }

    // Try direct command handler first (for specific CRUD operations)
    // This handles: logs, top, delete, run, exec, update
    const directResult = await handleDirectCommand(userMessage, cmd);
    if (directResult) {
      const provider = activeProvider === "none" ? "built-in" : activeProvider;
      const payload = {
        reply: directResult,
        provider,
        contextKeys: ["directCommand", parsed.intent, parsed.resource].filter(Boolean),
      };
      if (!isMutating) {
        cacheSet(cacheKey, payload, CHAT_CACHE_TTL).catch(() => {});
      }
      if (conversationId) {
        histAddMessage(conversationId, {
          role: "assistant",
          content: directResult,
          provider,
        }).catch(() => {});
      }
      // Update conversation memory so follow-ups can resolve "it" / "its".
      updateMemory(conversationId, memoryPatchFromParse(parsed)).catch(() => {});
      return json(res, 200, { ...payload, cached: false, conversationId });
    }

    // Try list command handler (for "list/show/get X" queries)
    const listResult = await handleListCommand(userMessage, cmd);
    if (listResult) {
      const provider = activeProvider === "none" ? "built-in" : activeProvider;
      const payload = {
        reply: listResult,
        provider,
        contextKeys: ["listCommand", parsed.resource, parsed.scope].filter(Boolean),
      };
      cacheSet(cacheKey, payload, CHAT_CACHE_TTL).catch(() => {});
      if (conversationId) {
        histAddMessage(conversationId, {
          role: "assistant",
          content: listResult,
          provider,
        }).catch(() => {});
      }
      updateMemory(conversationId, memoryPatchFromParse(parsed)).catch(() => {});
      return json(res, 200, { ...payload, cached: false, conversationId });
    }

    // 1. Gather cluster context for analysis queries (cached separately)
    const ctxKey = `ctx:${cacheKeyForChat(userMessage, "ctx")}`;
    let context = await cacheGet(ctxKey);
    if (!context) {
      context = await gatherClusterContext(userMessage);
      cacheSet(ctxKey, context, CONTEXT_CACHE_TTL).catch(() => {});
    }
    intentsForLog = Array.isArray(context?.intents) ? context.intents : Object.keys(context || {});

    // 2. Call LLM (or built-in analysis)
    const reply = await callLLM(userMessage, context, llmOpts);

    const payload = {
      reply,
      provider: activeProvider,
      contextKeys: Object.keys(context || {}),
    };
    cacheSet(cacheKey, payload, CHAT_CACHE_TTL).catch(() => {});
    if (conversationId) {
      histAddMessage(conversationId, {
        role: "assistant",
        content: reply,
        provider: activeProvider,
      }).catch(() => {});
    }

    // 3. Return response
    json(res, 200, { ...payload, cached: false, conversationId });
  } catch (err) {
    console.error("Chat API error:", err);
    json(res, 500, { error: err.message });
  } finally {
    histLogQuery({
      conversationId,
      query: userMessage,
      intents: intentsForLog,
      cacheHit,
      durationMs: Date.now() - startedAt,
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// POST /api/execute — apply fixes directly on the cluster
// Supports: delete_pod, restart_deployment, scale_deployment
// ---------------------------------------------------------------------------
export async function handleExecuteAPI(req, res) {
  let action, pod, namespace, deployment, conversationId;
  let success = false;
  let resultPayload = null;
  try {
    const body = await readBody(req);
    ({ action, pod, namespace, deployment } = body);
    const { replicas } = body;
    conversationId = body.conversationId || body.chatId || null;

    if (!action || !namespace) {
      return json(res, 400, { success: false, error: "Missing action or namespace" });
    }

    console.log(`Execute API: action=${action} pod=${pod} ns=${namespace} dep=${deployment}`);

    if (action === "delete_pod") {
      if (!pod) return json(res, 400, { success: false, error: "Missing pod name" });
      await ocpDelete(`/api/v1/namespaces/${namespace}/pods/${pod}`);
      success = true;
      resultPayload = { message: `Pod '${pod}' deleted in '${namespace}'. The owning controller will recreate it.` };
      return json(res, 200, {
        success: true,
        message: resultPayload.message,
      });
    }

    if (action === "restart_deployment") {
      const dep = deployment || pod;
      if (!dep) return json(res, 400, { success: false, error: "Missing deployment name" });
      await ocpPatch(
        `/apis/apps/v1/namespaces/${namespace}/deployments/${dep}`,
        {
          spec: {
            template: {
              metadata: {
                annotations: {
                  "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
                },
              },
            },
          },
        }
      );
      success = true;
      resultPayload = { message: `Deployment '${dep}' restarted in '${namespace}'. New pods will be rolled out.` };
      return json(res, 200, { success: true, message: resultPayload.message });
    }

    if (action === "scale_deployment") {
      const dep = deployment || pod;
      const rep = parseInt(replicas, 10);
      if (!dep || isNaN(rep)) return json(res, 400, { success: false, error: "Missing deployment or replicas" });
      await ocpPatch(
        `/apis/apps/v1/namespaces/${namespace}/deployments/${dep}`,
        { spec: { replicas: rep } }
      );
      success = true;
      resultPayload = { message: `Deployment '${dep}' scaled to ${rep} replicas in '${namespace}'.` };
      return json(res, 200, { success: true, message: resultPayload.message });
    }

    json(res, 400, { success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("Execute API error:", err);
    resultPayload = { error: err.message };
    json(res, 500, { success: false, error: err.message });
  } finally {
    if (action) {
      histLogExecutedAction({
        conversationId,
        action,
        target: pod || deployment || null,
        namespace,
        success,
        result: resultPayload,
      }).catch(() => {});
    }
  }
}
