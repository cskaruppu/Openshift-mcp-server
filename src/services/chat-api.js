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

import {
  ocpGet,
  ocpDelete,
  ocpPatch,
  ocpPost,
  ocpFetch,
  runWithTrace,
  renderTraceMarkdown,
} from "../utils/openshift-client.js";
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
import { callLLM, callLLMStream, llmEnabled } from "./llm.js";
import { runAgent } from "./agent-loop.js";
import { maybeEnhance as nluEnhanceWithLLM } from "./nlu-llm.js";
import { summarizeIfNeeded } from "./summarizer.js";
import { suggestPlaybook, renderPlaybookMarkdown } from "./playbooks.js";
import { findResource } from "./resource-index.js";
import { incCounter, observeHistogram } from "./metrics.js";
import { enforce as enforceRateLimit } from "./rate-limit.js";

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
  else if (p.intent === "start") operation = "start";
  else if (p.intent === "stop") operation = "stop";
  else if (p.intent === "upgrade") operation = "upgrade";
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
    "**KubeVirt — Virtual Machines**",
    "  - `list vms in <ns>` / `list virtual machines`",
    "  - `describe vm <name> in <ns>`",
    "  - `start vm <name> in <ns>` / `stop vm <name> in <ns>`",
    "  - `list vmis in <ns>` (running VM instances)",
    "",
    "**Tekton — Pipelines & Tasks**",
    "  - `list pipelines in <ns>` / `list pipelineruns in <ns>`",
    "  - `list tasks in <ns>` / `list taskruns in <ns>`",
    "  - `describe pipeline <name> in <ns>`",
    "  - `start pipeline <name> in <ns>`",
    "",
    "**Cluster scoped**",
    "  - `list nodes` / `list namespaces` / `list projects`",
    "  - `list clusteroperators` / `list pvs` / `list machines`",
    "  - `is the cluster healthy?`",
    "  - `upgrade cluster` / `show cluster version`",
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
  virtualmachine:        { api: "/apis/kubevirt.io/v1", resource: "virtualmachines", namespaced: true },
  virtualmachines:       { api: "/apis/kubevirt.io/v1", resource: "virtualmachines", namespaced: true },
  vm:                    { api: "/apis/kubevirt.io/v1", resource: "virtualmachines", namespaced: true },
  vms:                   { api: "/apis/kubevirt.io/v1", resource: "virtualmachines", namespaced: true },
  virtualmachineinstance:  { api: "/apis/kubevirt.io/v1", resource: "virtualmachineinstances", namespaced: true },
  virtualmachineinstances: { api: "/apis/kubevirt.io/v1", resource: "virtualmachineinstances", namespaced: true },
  vmi:                   { api: "/apis/kubevirt.io/v1", resource: "virtualmachineinstances", namespaced: true },
  vmis:                  { api: "/apis/kubevirt.io/v1", resource: "virtualmachineinstances", namespaced: true },
  pipeline:              { api: "/apis/tekton.dev/v1", resource: "pipelines", namespaced: true },
  pipelines:             { api: "/apis/tekton.dev/v1", resource: "pipelines", namespaced: true },
  pipelinerun:           { api: "/apis/tekton.dev/v1", resource: "pipelineruns", namespaced: true },
  pipelineruns:          { api: "/apis/tekton.dev/v1", resource: "pipelineruns", namespaced: true },
  task:                  { api: "/apis/tekton.dev/v1", resource: "tasks", namespaced: true },
  tasks:                 { api: "/apis/tekton.dev/v1", resource: "tasks", namespaced: true },
  taskrun:               { api: "/apis/tekton.dev/v1", resource: "taskruns", namespaced: true },
  taskruns:              { api: "/apis/tekton.dev/v1", resource: "taskruns", namespaced: true },
  clusterversion:        { api: "/apis/config.openshift.io/v1", resource: "clusterversions", namespaced: false },
  clusterversions:       { api: "/apis/config.openshift.io/v1", resource: "clusterversions", namespaced: false },
  machine:               { api: "/apis/machine.openshift.io/v1beta1", resource: "machines", namespaced: true },
  machines:              { api: "/apis/machine.openshift.io/v1beta1", resource: "machines", namespaced: true },
  machineset:            { api: "/apis/machine.openshift.io/v1beta1", resource: "machinesets", namespaced: true },
  machinesets:           { api: "/apis/machine.openshift.io/v1beta1", resource: "machinesets", namespaced: true },
  helmrelease:           { api: "/apis/helm.openshift.io/v1beta1", resource: "helmchartrepositories", namespaced: false },
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

  // -----------------------------------------------------------------------
  // START — start a VM (KubeVirt) or pipeline (Tekton)
  // -----------------------------------------------------------------------
  if (cmd.operation === "start") {
    if (cmd.resourceType === "virtualmachine" || cmd.resourceType === "vm") {
      if (!cmd.resourceName || !cmd.namespace) {
        parts.push(`### Start VM`);
        parts.push(`[WARNING] Please specify both VM name and namespace.`);
        parts.push(`\n**Example:** "start vm my-vm in namespace my-ns"`);
        return parts.join("\n");
      }
      try {
        await ocpPatch(
          `/apis/kubevirt.io/v1/namespaces/${cmd.namespace}/virtualmachines/${cmd.resourceName}`,
          { spec: { running: true } }
        );
        parts.push(`### VM Started`);
        parts.push(`[OK] Virtual machine \`${cmd.resourceName}\` started in \`${cmd.namespace}\`.`);
        parts.push(`\n**Check status:**`);
        parts.push("```" + `oc get vmi ${cmd.resourceName} -n ${cmd.namespace}` + "```");
      } catch (err) {
        parts.push(`### Start VM Failed`);
        parts.push(`[CRITICAL] Failed to start VM \`${cmd.resourceName}\`: ${err.message}`);
      }
      return parts.join("\n");
    }
    if (cmd.resourceType === "pipeline") {
      if (!cmd.resourceName || !cmd.namespace) {
        parts.push(`### Start Pipeline`);
        parts.push(`[WARNING] Please specify both pipeline name and namespace.`);
        parts.push(`\n**Example:** "start pipeline build-and-deploy in namespace cicd"`);
        return parts.join("\n");
      }
      try {
        const pipelineRun = {
          apiVersion: "tekton.dev/v1",
          kind: "PipelineRun",
          metadata: {
            generateName: `${cmd.resourceName}-run-`,
            namespace: cmd.namespace,
          },
          spec: {
            pipelineRef: { name: cmd.resourceName },
          },
        };
        const result = await ocpPost(
          `/apis/tekton.dev/v1/namespaces/${cmd.namespace}/pipelineruns`,
          pipelineRun
        );
        const prName = result?.metadata?.name || `${cmd.resourceName}-run-*`;
        parts.push(`### Pipeline Started`);
        parts.push(`[OK] PipelineRun \`${prName}\` created in \`${cmd.namespace}\` from pipeline \`${cmd.resourceName}\`.`);
        parts.push(`\n**Check status:**`);
        parts.push("```" + `oc get pipelinerun ${prName} -n ${cmd.namespace}\ntkn pipelinerun logs ${prName} -n ${cmd.namespace}` + "```");
      } catch (err) {
        parts.push(`### Start Pipeline Failed`);
        parts.push(`[CRITICAL] Failed to start pipeline \`${cmd.resourceName}\`: ${err.message}`);
      }
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // STOP — stop a VM (KubeVirt)
  // -----------------------------------------------------------------------
  if (cmd.operation === "stop") {
    if (cmd.resourceType === "virtualmachine" || cmd.resourceType === "vm") {
      if (!cmd.resourceName || !cmd.namespace) {
        parts.push(`### Stop VM`);
        parts.push(`[WARNING] Please specify both VM name and namespace.`);
        parts.push(`\n**Example:** "stop vm my-vm in namespace my-ns"`);
        return parts.join("\n");
      }
      try {
        await ocpPatch(
          `/apis/kubevirt.io/v1/namespaces/${cmd.namespace}/virtualmachines/${cmd.resourceName}`,
          { spec: { running: false } }
        );
        parts.push(`### VM Stopped`);
        parts.push(`[OK] Virtual machine \`${cmd.resourceName}\` stopped in \`${cmd.namespace}\`.`);
      } catch (err) {
        parts.push(`### Stop VM Failed`);
        parts.push(`[CRITICAL] Failed to stop VM \`${cmd.resourceName}\`: ${err.message}`);
      }
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // UPGRADE — show cluster version and available updates
  // -----------------------------------------------------------------------
  if (cmd.operation === "upgrade") {
    if (cmd.resourceType === "clusterversion") {
      try {
        const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
        const currentVersion = cv.status?.desired?.version || "unknown";
        const channel = cv.spec?.channel || "unknown";
        const conditions = cv.status?.conditions || [];
        const available = conditions.find(c => c.type === "Available");
        const progressing = conditions.find(c => c.type === "Progressing");
        const updates = cv.status?.availableUpdates || [];

        parts.push(`### Cluster Version & Upgrade Status`);
        parts.push(`**Current version:** ${currentVersion}`);
        parts.push(`**Channel:** ${channel}`);
        if (available) {
          const icon = available.status === "True" ? "[OK]" : "[CRITICAL]";
          parts.push(`${icon} **Available:** ${available.message || available.reason || available.status}`);
        }
        if (progressing) {
          const icon = progressing.status === "True" ? "[WARNING]" : "[OK]";
          parts.push(`${icon} **Progressing:** ${progressing.message || progressing.reason || progressing.status}`);
        }

        if (updates.length > 0) {
          parts.push(`\n**Available updates (${updates.length}):**`);
          updates.slice(0, 10).forEach(u => {
            parts.push(`  - **${u.version}**${u.image ? ` — \`${u.image.substring(0, 80)}...\`` : ""}`);
          });
          parts.push(`\n**To upgrade:**`);
          parts.push("```" + `oc adm upgrade --to=${updates[0].version}` + "```");
        } else {
          parts.push(`\n[OK] Cluster is up to date. No upgrades available in channel \`${channel}\`.`);
        }
      } catch (err) {
        parts.push(`### Cluster Upgrade Error`);
        parts.push(`[CRITICAL] Failed to check cluster version: ${err.message}`);
      }
      return parts.join("\n");
    }
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
    } else if (["virtualmachine", "vm", "vms", "virtualmachines"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((v) => {
        const ready = v.status?.ready;
        const printable = v.status?.printableStatus || (ready ? "Running" : "Stopped");
        const icon = ready ? "[OK]" : "[WARNING]";
        const cpu = v.spec?.template?.spec?.domain?.cpu?.cores || "?";
        const mem = v.spec?.template?.spec?.domain?.resources?.requests?.memory || "?";
        parts.push(`  - ${icon} **${v.metadata.name}** (${v.metadata.namespace}) — ${printable} — CPU: ${cpu}, Mem: ${mem}`);
      });
    } else if (["virtualmachineinstance", "vmi", "vmis"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((v) => {
        const phase = v.status?.phase || "Unknown";
        const icon = phase === "Running" ? "[OK]" : "[WARNING]";
        const node = v.status?.nodeName || "unassigned";
        const ip = (v.status?.interfaces || [])[0]?.ipAddress || "none";
        parts.push(`  - ${icon} **${v.metadata.name}** (${v.metadata.namespace}) — ${phase} — Node: ${node} — IP: ${ip}`);
      });
    } else if (["pipeline", "pipelines"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((p) => {
        const taskCount = p.spec?.tasks?.length || 0;
        parts.push(`  - **${p.metadata.name}** (${p.metadata.namespace}) — ${taskCount} task(s)`);
      });
    } else if (["pipelinerun", "pipelineruns"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((p) => {
        const succeeded = (p.status?.conditions || []).find(c => c.type === "Succeeded");
        const status = succeeded ? (succeeded.status === "True" ? "Succeeded" : succeeded.status === "False" ? "Failed" : "Running") : "Pending";
        const icon = status === "Succeeded" ? "[OK]" : status === "Failed" ? "[CRITICAL]" : "[WARNING]";
        const pipeline = p.spec?.pipelineRef?.name || "inline";
        const start = p.status?.startTime ? new Date(p.status.startTime).toLocaleString() : "?";
        parts.push(`  - ${icon} **${p.metadata.name}** (${p.metadata.namespace}) — ${status} — pipeline: ${pipeline} — started: ${start}`);
      });
    } else if (["task", "tasks"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((t) => {
        const stepCount = t.spec?.steps?.length || 0;
        parts.push(`  - **${t.metadata.name}** (${t.metadata.namespace}) — ${stepCount} step(s)`);
      });
    } else if (["taskrun", "taskruns"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((t) => {
        const succeeded = (t.status?.conditions || []).find(c => c.type === "Succeeded");
        const status = succeeded ? (succeeded.status === "True" ? "Succeeded" : succeeded.status === "False" ? "Failed" : "Running") : "Pending";
        const icon = status === "Succeeded" ? "[OK]" : status === "Failed" ? "[CRITICAL]" : "[WARNING]";
        const taskName = t.spec?.taskRef?.name || "inline";
        parts.push(`  - ${icon} **${t.metadata.name}** (${t.metadata.namespace}) — ${status} — task: ${taskName}`);
      });
    } else if (["clusterversion", "clusterversions"].includes(cmd.resourceType)) {
      items.forEach((cv) => {
        const version = cv.status?.desired?.version || "?";
        const channel = cv.spec?.channel || "?";
        const updates = cv.status?.availableUpdates?.length || 0;
        const progressing = (cv.status?.conditions || []).find(c => c.type === "Progressing");
        const icon = progressing?.status === "True" ? "[WARNING]" : "[OK]";
        parts.push(`  - ${icon} **${cv.metadata.name}** — v${version} — channel: ${channel} — ${updates} update(s) available`);
      });
    } else if (["machine", "machines"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((m) => {
        const phase = m.status?.phase || "Unknown";
        const icon = phase === "Running" ? "[OK]" : "[WARNING]";
        const nodeRef = m.status?.nodeRef?.name || "unassigned";
        const instanceType = m.spec?.providerSpec?.value?.instanceType || m.spec?.providerSpec?.value?.vmSize || "?";
        parts.push(`  - ${icon} **${m.metadata.name}** (${m.metadata.namespace}) — ${phase} — node: ${nodeRef} — type: ${instanceType}`);
      });
    } else if (["machineset", "machinesets"].includes(cmd.resourceType)) {
      items.slice(0, 30).forEach((ms) => {
        const desired = ms.spec?.replicas ?? 0;
        const ready = ms.status?.readyReplicas ?? 0;
        const icon = ready === desired ? "[OK]" : "[WARNING]";
        parts.push(`  - ${icon} **${ms.metadata.name}** (${ms.metadata.namespace}) — ${ready}/${desired} ready`);
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

  // Intent: virtual machines (KubeVirt)
  if (lower.match(/\bvms?\b|\bvirtual\s*machines?\b|\bvmi\b|\bkubevirt/)) {
    context.intents.push("virtualmachines");
  }

  // Intent: pipelines / tekton
  if (lower.match(/\bpipeline|\btekton|\btaskrun|\bpipelinerun/)) {
    context.intents.push("pipelines");
  }

  // Intent: cluster upgrade / version
  if (lower.match(/\bupgrade|\bcluster\s*version|\bclusterversion/)) {
    context.intents.push("cluster_upgrade");
  }

  // Intent: machines / machinesets
  if (lower.match(/\bmachineset|\bmachine\b/) && !lower.match(/virtual/)) {
    context.intents.push("machines");
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
        // Find problem pods — only truly broken ones. Explicitly exclude
        // Succeeded Job pods (phase=Succeeded, terminated.reason=Completed,
        // exitCode=0) which are a normal terminal state, not a problem.
        context.problemPods = allPods
          .filter((p) => {
            const phase = p.status?.phase;
            if (phase === "Succeeded") return false;
            if (phase === "Failed" || phase === "Unknown") return true;
            return (p.status?.containerStatuses || []).some((c) => {
              const waitingReason = c.state?.waiting?.reason;
              const terminatedReason = c.state?.terminated?.reason;
              const terminatedExit = c.state?.terminated?.exitCode;
              if (
                waitingReason === "CrashLoopBackOff" ||
                waitingReason === "ImagePullBackOff" ||
                waitingReason === "ErrImagePull" ||
                waitingReason === "CreateContainerConfigError" ||
                waitingReason === "RunContainerError" ||
                terminatedReason === "OOMKilled"
              ) return true;
              // Terminated with non-zero exit — real failure.
              if (terminatedReason === "Error" && terminatedExit && terminatedExit !== 0) return true;
              // Catch-all: not ready, not running, and not a clean Completed.
              if (c.ready || c.state?.running) return false;
              if (terminatedReason === "Completed" && (terminatedExit ?? 0) === 0) return false;
              // Containers that are just starting (no state yet) shouldn't
              // count as problems — ignore until they get a waiting state.
              if (!c.state || Object.keys(c.state).length === 0) return false;
              return true;
            });
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
              .filter((c) => {
                if (c.ready || c.state?.running) return false;
                const tr = c.state?.terminated?.reason;
                const te = c.state?.terminated?.exitCode;
                if (tr === "Completed" && (te ?? 0) === 0) return false;
                return true;
              })
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

  // Virtual machines (KubeVirt)
  if (context.intents.includes("virtualmachines")) {
    const vmNs = nsMatch ? nsMatch[1] : null;
    const vmPath = vmNs
      ? `/apis/kubevirt.io/v1/namespaces/${vmNs}/virtualmachines`
      : "/apis/kubevirt.io/v1/virtualmachines";
    tasks.push(
      ocpGet(vmPath).then((d) => {
        context.virtualmachines = (d.items || []).map((v) => ({
          name: v.metadata.name,
          namespace: v.metadata.namespace,
          ready: v.status?.ready,
          status: v.status?.printableStatus || (v.status?.ready ? "Running" : "Stopped"),
          cpu: v.spec?.template?.spec?.domain?.cpu?.cores,
          memory: v.spec?.template?.spec?.domain?.resources?.requests?.memory,
        }));
      }).catch(() => {})
    );
  }

  // Pipelines (Tekton)
  if (context.intents.includes("pipelines")) {
    const plNs = nsMatch ? nsMatch[1] : null;
    const plPath = plNs
      ? `/apis/tekton.dev/v1/namespaces/${plNs}/pipelines`
      : "/apis/tekton.dev/v1/pipelines";
    tasks.push(
      ocpGet(plPath).then((d) => {
        context.pipelines = (d.items || []).map((p) => ({
          name: p.metadata.name,
          namespace: p.metadata.namespace,
          tasks: p.spec?.tasks?.length || 0,
        }));
      }).catch(() => {})
    );
    const prPath = plNs
      ? `/apis/tekton.dev/v1/namespaces/${plNs}/pipelineruns`
      : "/apis/tekton.dev/v1/pipelineruns";
    tasks.push(
      ocpGet(prPath).then((d) => {
        context.pipelineruns = (d.items || []).slice(0, 20).map((p) => {
          const cond = (p.status?.conditions || []).find(c => c.type === "Succeeded");
          return {
            name: p.metadata.name,
            namespace: p.metadata.namespace,
            pipeline: p.spec?.pipelineRef?.name,
            status: cond ? (cond.status === "True" ? "Succeeded" : cond.status === "False" ? "Failed" : "Running") : "Pending",
            startTime: p.status?.startTime,
          };
        });
      }).catch(() => {})
    );
  }

  // Cluster upgrade
  if (context.intents.includes("cluster_upgrade")) {
    tasks.push(
      ocpGet("/apis/config.openshift.io/v1/clusterversions/version").then((cv) => {
        context.clusterUpgrade = {
          currentVersion: cv.status?.desired?.version,
          channel: cv.spec?.channel,
          availableUpdates: (cv.status?.availableUpdates || []).map(u => u.version),
          conditions: (cv.status?.conditions || []).map(c => ({
            type: c.type, status: c.status, message: c.message,
          })),
        };
      }).catch(() => {})
    );
  }

  // Machines / MachinesSets
  if (context.intents.includes("machines")) {
    tasks.push(
      ocpGet("/apis/machine.openshift.io/v1beta1/machines").then((d) => {
        context.machines = (d.items || []).map((m) => ({
          name: m.metadata.name,
          namespace: m.metadata.namespace,
          phase: m.status?.phase,
          node: m.status?.nodeRef?.name,
        }));
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

    // Correlate pod state + events + node conditions into likelyCause entries
    context.correlations = correlateRootCauses(context);
  }

  return context;
}

// ---------------------------------------------------------------------------
// Root-cause correlator — joins pod state, events, owners, node conditions
// into ranked "likely cause" entries. The built-in analyzer uses these to
// render the "Likely cause" block; the agent loop can also read them.
// ---------------------------------------------------------------------------
function correlateRootCauses(ctx) {
  const out = [];
  for (const pod of ctx.problemPods || []) {
    const states = pod.containers.map((c) => c.state).filter(Boolean);
    let cause = null;
    let evidence = [];
    if (states.includes("CrashLoopBackOff")) {
      cause = "CrashLoopBackOff";
      const c = pod.containers.find((x) => x.state === "CrashLoopBackOff");
      if (c?.exitCode != null) evidence.push(`exitCode=${c.exitCode}`);
      if (c?.lastReason) evidence.push(`lastReason=${c.lastReason}`);
      const ev = (pod.events || []).find((e) => /BackOff|Failed/.test(e.reason));
      if (ev) evidence.push(`event: ${(ev.message || "").slice(0, 120)}`);
    } else if (states.includes("ImagePullBackOff") || states.includes("ErrImagePull")) {
      cause = "ImagePullBackOff";
      if (pod.images?.[0]) evidence.push(`image=${pod.images[0]}`);
      const ev = (pod.events || []).find((e) => /pull|image/i.test(e.message || ""));
      if (ev) evidence.push(`event: ${(ev.message || "").slice(0, 120)}`);
    } else if (states.includes("OOMKilled")) {
      cause = "OOMKilled";
      const lim = pod.resourceLimits?.[0];
      if (lim?.memLimit) evidence.push(`memLimit=${lim.memLimit}`);
      if (lim?.memRequest) evidence.push(`memRequest=${lim.memRequest}`);
    } else if (states.includes("CreateContainerConfigError")) {
      cause = "CreateContainerConfigError";
      const ev = (pod.events || []).find((e) => /configmap|secret/i.test(e.message || ""));
      if (ev) evidence.push((ev.message || "").slice(0, 160));
    } else if (pod.phase === "Pending") {
      cause = "Pending";
      const ev = (pod.events || []).find((e) => /Failed|FailedScheduling|Insufficient/.test(e.reason));
      if (ev) evidence.push(`event: ${(ev.message || "").slice(0, 140)}`);
      // Check node conditions
      const nodeIssues = (ctx.nodes || [])
        .filter((n) => !n.ready)
        .map((n) => n.name);
      if (nodeIssues.length > 0) evidence.push(`notReadyNodes=${nodeIssues.join(",")}`);
    } else if (pod.phase === "Failed") {
      cause = "Failed";
      if (pod.events?.[0]) evidence.push((pod.events[0].message || "").slice(0, 140));
    } else {
      cause = "Unknown";
      evidence.push(`state=${states.join("|")}`);
    }
    out.push({
      pod: pod.name,
      namespace: pod.namespace,
      likelyCause: cause,
      evidence,
      ownerKind: pod.ownerKind,
      ownerName: pod.ownerName,
      node: pod.node,
    });
  }
  return out;
}

/** Render the correlations block as markdown. */
function renderCorrelationsMarkdown(correlations) {
  if (!correlations || correlations.length === 0) return "";
  const lines = [`\n### Root cause correlations`];
  for (const c of correlations.slice(0, 10)) {
    lines.push(
      `  - **${c.pod}** (${c.namespace}) — **${c.likelyCause}**` +
        (c.evidence?.length ? `\n    - ${c.evidence.join("\n    - ")}` : "")
    );
  }
  return lines.join("\n");
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
// Call external LLM — thin wrapper around the centralized llm.js module
// that keeps the built-in analysis fallback when no provider is configured.
// ---------------------------------------------------------------------------
async function callLLMWithContext(userMessage, clusterContext, opts = {}) {
  const provider = opts.provider || LLM_PROVIDER;
  if (!provider || provider === "none") {
    return builtInAnalysis(userMessage, clusterContext);
  }
  const contextStr = JSON.stringify(clusterContext, null, 2);
  const userContent = `${userMessage}\n\n--- Live Cluster Data ---\n${contextStr}`;
  try {
    const r = await callLLM({
      messages: [{ role: "user", content: userContent }],
      system: SYSTEM_PROMPT,
      maxTokens: 2000,
      temperature: 0.3,
      provider: opts.provider,
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      model: opts.model,
    });
    return r.text || builtInAnalysis(userMessage, clusterContext);
  } catch (err) {
    return `LLM Error: ${err.message}\n\n---\n\n${builtInAnalysis(userMessage, clusterContext)}`;
  }
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

  // --- Virtual Machines ---
  if (intents.includes("virtualmachines") && ctx.virtualmachines) {
    parts.push(`### Virtual Machines (${ctx.virtualmachines.length})`);
    if (ctx.virtualmachines.length === 0) {
      parts.push(`No virtual machines found. Ensure KubeVirt is installed.`);
    } else {
      ctx.virtualmachines.forEach((v) => {
        const icon = v.ready ? "[OK]" : "[WARNING]";
        parts.push(`  - ${icon} **${v.name}** (${v.namespace}) — ${v.status} — CPU: ${v.cpu || "?"}, Mem: ${v.memory || "?"}`);
      });
    }
    return parts.join("\n");
  }

  // --- Pipelines / Tekton ---
  if (intents.includes("pipelines") && (ctx.pipelines || ctx.pipelineruns)) {
    if (ctx.pipelines) {
      parts.push(`### Pipelines (${ctx.pipelines.length})`);
      ctx.pipelines.forEach((p) => {
        parts.push(`  - **${p.name}** (${p.namespace}) — ${p.tasks} task(s)`);
      });
    }
    if (ctx.pipelineruns && ctx.pipelineruns.length > 0) {
      parts.push(`\n### Recent PipelineRuns (${ctx.pipelineruns.length})`);
      ctx.pipelineruns.forEach((p) => {
        const icon = p.status === "Succeeded" ? "[OK]" : p.status === "Failed" ? "[CRITICAL]" : "[WARNING]";
        parts.push(`  - ${icon} **${p.name}** (${p.namespace}) — ${p.status} — pipeline: ${p.pipeline || "inline"}`);
      });
    }
    return parts.join("\n");
  }

  // --- Cluster Upgrade ---
  if (intents.includes("cluster_upgrade") && ctx.clusterUpgrade) {
    const cu = ctx.clusterUpgrade;
    parts.push(`### Cluster Upgrade Status`);
    parts.push(`**Current version:** ${cu.currentVersion || "?"}`);
    parts.push(`**Channel:** ${cu.channel || "?"}`);
    cu.conditions?.forEach((c) => {
      const icon = c.type === "Available" && c.status === "True" ? "[OK]" :
                   c.type === "Progressing" && c.status === "True" ? "[WARNING]" : "[OK]";
      parts.push(`  - ${icon} **${c.type}:** ${c.message || c.status}`);
    });
    if (cu.availableUpdates?.length > 0) {
      parts.push(`\n**Available updates:** ${cu.availableUpdates.join(", ")}`);
      parts.push("```" + `oc adm upgrade --to=${cu.availableUpdates[0]}` + "```");
    } else {
      parts.push(`\n[OK] Cluster is up to date.`);
    }
    return parts.join("\n");
  }

  // --- Machines ---
  if (intents.includes("machines") && ctx.machines) {
    parts.push(`### Machines (${ctx.machines.length})`);
    ctx.machines.forEach((m) => {
      const icon = m.phase === "Running" ? "[OK]" : "[WARNING]";
      parts.push(`  - ${icon} **${m.name}** (${m.namespace}) — ${m.phase || "?"} — node: ${m.node || "unassigned"}`);
    });
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
  parts.push(`\n**Virtual Machines (KubeVirt):**`);
  parts.push(`  - "List VMs in namespace my-ns"`);
  parts.push(`  - "Start VM my-vm in namespace my-ns" / "Stop VM my-vm in namespace my-ns"`);
  parts.push(`\n**Pipelines (Tekton):**`);
  parts.push(`  - "List pipelines in namespace cicd"`);
  parts.push(`  - "List pipelineruns in namespace cicd"`);
  parts.push(`  - "Start pipeline build-app in namespace cicd"`);
  parts.push(`\n**Cluster:**`);
  parts.push(`  - "List nodes" / "List namespaces" / "List projects"`);
  parts.push(`  - "Check cluster health" / "Show cluster operators"`);
  parts.push(`  - "Upgrade cluster" / "Show cluster version"`);
  parts.push(`  - "How many pods are running?"`);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Slash command fast-path — returns { reply, contextKeys } or null
// ---------------------------------------------------------------------------
async function maybeHandleSlashCommand(userMessage, conversationId) {
  const text = String(userMessage || "").trim();
  if (!text.startsWith("/")) return null;
  const [cmdRaw, ...rest] = text.slice(1).split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(" ").trim();

  if (cmd === "help") {
    return { reply: buildHelpMessage(), contextKeys: ["slash", "help"] };
  }
  if (cmd === "health") {
    try {
      const { getLatestHealthReport, runHealthCheckNow } = await import("./scheduler.js");
      const latest = (await getLatestHealthReport()) || (await runHealthCheckNow());
      const r = latest?.report || latest || {};
      const lines = [
        "### Cluster health",
        `  - Nodes ready: ${r.nodesReady ?? "?"} / ${r.nodesTotal ?? "?"}`,
        `  - Problem pods: ${r.problemPods ?? "?"}`,
        `  - Degraded operators: ${r.degradedOperators ?? "?"}`,
        `  - Checked at: ${r.checkedAt || new Date().toISOString()}`,
      ];
      return { reply: lines.join("\n"), contextKeys: ["slash", "health"] };
    } catch (e) {
      return { reply: `[ERROR] Health report unavailable: ${e.message}`, contextKeys: ["slash", "health"] };
    }
  }
  if (cmd === "audit") {
    try {
      const { query: dbq } = await import("../utils/db.js");
      const n = Math.min(parseInt(arg, 10) || 10, 50);
      const r = await dbq(
        "SELECT action, target, namespace, success, created_at FROM executed_actions ORDER BY id DESC LIMIT $1",
        [n]
      );
      const rows = r?.rows || [];
      if (rows.length === 0) return { reply: "### Audit trail\nNo executed actions recorded.", contextKeys: ["slash", "audit"] };
      const lines = ["### Audit trail (last " + rows.length + ")"];
      for (const row of rows) {
        const icon = row.success ? "[OK]" : "[FAIL]";
        lines.push(`  - ${icon} **${row.action}** ${row.target || ""} ${row.namespace ? `(${row.namespace})` : ""} — ${row.created_at}`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "audit"] };
    } catch (e) {
      return { reply: `[ERROR] Audit trail unavailable: ${e.message}`, contextKeys: ["slash", "audit"] };
    }
  }
  if (cmd === "alerts") {
    try {
      const { listFiringAlerts } = await import("./alertmanager.js");
      const alerts = await listFiringAlerts();
      if (!alerts || alerts.length === 0) return { reply: "### Alerts\n[OK] No firing alerts.", contextKeys: ["slash", "alerts"] };
      const lines = [`### Firing alerts (${alerts.length})`];
      for (const a of alerts.slice(0, 20)) {
        const name = a.labels?.alertname || "unknown";
        const sev = a.labels?.severity || "info";
        lines.push(`  - **${name}** (${sev}) — ${a.annotations?.summary || a.annotations?.description || ""}`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "alerts"] };
    } catch (e) {
      return { reply: `[ERROR] Alertmanager unreachable: ${e.message}`, contextKeys: ["slash", "alerts"] };
    }
  }
  if (cmd === "metrics") {
    const { renderMetrics } = await import("./metrics.js");
    return { reply: "```\n" + renderMetrics().slice(0, 3000) + "\n```", contextKeys: ["slash", "metrics"] };
  }

  // --- Security audit ---
  if (cmd === "security") {
    try {
      const ns = arg || undefined;
      const pods = await ocpGet("/api/v1/pods");
      const items = (pods.items || []).filter(
        (p) => !p.metadata.namespace?.startsWith("openshift-") && !p.metadata.namespace?.startsWith("kube-")
      ).filter((p) => !ns || p.metadata.namespace === ns);

      const privilegedList = [];
      const runAsRootList = [];
      const noLimitsList = [];
      const latestTagList = [];
      const hostNetList = [];

      for (const p of items) {
        const pName = p.metadata.name;
        const pNs = p.metadata.namespace;
        if (p.spec?.hostNetwork) hostNetList.push({ pod: pName, namespace: pNs });
        for (const c of (p.spec?.containers || [])) {
          const sc = c.securityContext || {};
          const ref = `${pNs}/${pName}/${c.name}`;
          if (sc.privileged) privilegedList.push(ref);
          if (sc.runAsUser === 0 || (!sc.runAsNonRoot && !p.spec?.securityContext?.runAsNonRoot)) runAsRootList.push(ref);
          if (!c.resources?.limits?.cpu && !c.resources?.limits?.memory) noLimitsList.push(ref);
          const img = c.image || "";
          if (img.endsWith(":latest") || !img.includes(":")) latestTagList.push({ ref, image: img });
        }
      }

      const nsList = [...new Set(items.map((p) => p.metadata.namespace))];
      let uncoveredNs = [];
      for (const n of nsList) {
        try {
          const np = await ocpGet(`/apis/networking.k8s.io/v1/namespaces/${n}/networkpolicies`);
          if (!np.items || np.items.length === 0) uncoveredNs.push(n);
        } catch { uncoveredNs.push(n); }
      }

      let score = 100;
      if (privilegedList.length > 0) score -= Math.min(25, privilegedList.length * 5);
      if (runAsRootList.length > 0) score -= Math.min(15, runAsRootList.length * 2);
      if (noLimitsList.length > 0) score -= Math.min(15, Math.ceil(noLimitsList.length / 2));
      if (latestTagList.length > 0) score -= Math.min(10, latestTagList.length);
      if (hostNetList.length > 0) score -= Math.min(10, hostNetList.length * 3);
      if (uncoveredNs.length > 0) score -= Math.min(15, uncoveredNs.length * 3);
      score = Math.max(0, Math.round(score));
      const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

      const showMax = 10;
      const trunc = (arr) => arr.length > showMax ? arr.slice(0, showMax).join(", ") + ` … and ${arr.length - showMax} more` : arr.join(", ");

      const lines = [
        `### Security & Compliance Audit`,
        ``,
        `@@SCORE|${score}|Security Posture@@`,
        `@@GRADE|${grade}|Compliance Grade@@`,
        ``,
        `**Scanned:** ${items.length} pods across ${nsList.length} namespaces`,
        ``,
      ];

      // --- Finding: Privileged containers ---
      if (privilegedList.length > 0) {
        lines.push(`---`);
        lines.push(`### [CRITICAL] ${privilegedList.length} Privileged Container(s)`);
        lines.push(``);
        lines.push(`| Namespace | Pod | Container |`);
        lines.push(`|-----------|-----|-----------|`);
        for (const ref of privilegedList.slice(0, showMax)) {
          const [ns2, pod, ctr] = ref.split("/");
          lines.push(`| ${ns2} | ${pod} | ${ctr} |`);
        }
        if (privilegedList.length > showMax) lines.push(`| … | *${privilegedList.length - showMax} more* | |`);
        lines.push(``);
        lines.push(`**Why it matters:** Privileged containers have unrestricted host access — a compromised container can take over the entire node.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Set \`securityContext.privileged: false\` in the container spec`);
        lines.push(`  2. Use \`allowPrivilegeEscalation: false\` and drop all capabilities`);
        lines.push(`  3. If host access is needed, use specific capabilities instead (e.g. \`NET_ADMIN\`)`);
        lines.push(`  4. Apply an SCC/PSA policy: \`oc adm policy add-scc-to-user restricted -z <sa> -n <ns>\``);
        lines.push(``);
      }

      // --- Finding: hostNetwork ---
      if (hostNetList.length > 0) {
        lines.push(`---`);
        lines.push(`### [CRITICAL] ${hostNetList.length} Pod(s) Using hostNetwork`);
        lines.push(``);
        lines.push(`| Namespace | Pod |`);
        lines.push(`|-----------|-----|`);
        for (const h of hostNetList.slice(0, showMax)) {
          lines.push(`| ${h.namespace} | ${h.pod} |`);
        }
        if (hostNetList.length > showMax) lines.push(`| … | *${hostNetList.length - showMax} more* |`);
        lines.push(``);
        lines.push(`**Why it matters:** hostNetwork pods share the node's network stack, exposing node-level services and bypassing NetworkPolicies.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Remove \`hostNetwork: true\` from the pod spec`);
        lines.push(`  2. Use Kubernetes Services or Ingress/Routes to expose pods instead`);
        lines.push(`  3. If host networking is required (e.g. CNI plugins), isolate in a dedicated namespace with strict RBAC`);
        lines.push(``);
      }

      // --- Finding: Run as root ---
      if (runAsRootList.length > 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${runAsRootList.length} Container(s) May Run as Root`);
        lines.push(``);
        lines.push(`| Namespace | Pod | Container |`);
        lines.push(`|-----------|-----|-----------|`);
        for (const ref of runAsRootList.slice(0, showMax)) {
          const [ns2, pod, ctr] = ref.split("/");
          lines.push(`| ${ns2} | ${pod} | ${ctr} |`);
        }
        if (runAsRootList.length > showMax) lines.push(`| … | *${runAsRootList.length - showMax} more* | |`);
        lines.push(``);
        lines.push(`**Why it matters:** Root containers can modify the host filesystem and escalate privileges if a breakout occurs.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Set \`securityContext.runAsNonRoot: true\` at the pod or container level`);
        lines.push(`  2. Specify a non-root \`runAsUser\` (e.g. \`runAsUser: 1000\`)`);
        lines.push(`  3. Rebuild images to run as non-root: \`USER 1000\` in Dockerfile`);
        lines.push(`  4. Enforce via Pod Security Admission: label namespace with \`pod-security.kubernetes.io/enforce: restricted\``);
        lines.push(``);
      }

      // --- Finding: No resource limits ---
      if (noLimitsList.length > 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${noLimitsList.length} Container(s) Without Resource Limits`);
        lines.push(``);
        lines.push(`| Namespace | Pod | Container |`);
        lines.push(`|-----------|-----|-----------|`);
        for (const ref of noLimitsList.slice(0, showMax)) {
          const [ns2, pod, ctr] = ref.split("/");
          lines.push(`| ${ns2} | ${pod} | ${ctr} |`);
        }
        if (noLimitsList.length > showMax) lines.push(`| … | *${noLimitsList.length - showMax} more* | |`);
        lines.push(``);
        lines.push(`**Why it matters:** Without limits, a single container can starve other workloads and cause node instability.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Add \`resources.limits.cpu\` and \`resources.limits.memory\` to every container`);
        lines.push(`  2. Set matching \`resources.requests\` for guaranteed QoS class`);
        lines.push(`  3. Apply a \`LimitRange\` to the namespace to enforce defaults:`);
        lines.push(`     \`oc create limitrange default-limits --default-cpu=500m --default-memory=256Mi -n <ns>\``);
        lines.push(``);
      }

      // --- Finding: :latest / untagged images ---
      if (latestTagList.length > 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${latestTagList.length} Image(s) Using :latest or Untagged`);
        lines.push(``);
        lines.push(`| Namespace | Pod | Container | Image |`);
        lines.push(`|-----------|-----|-----------|-------|`);
        for (const { ref, image } of latestTagList.slice(0, showMax)) {
          const [ns2, pod, ctr] = ref.split("/");
          lines.push(`| ${ns2} | ${pod} | ${ctr} | \`${image}\` |`);
        }
        if (latestTagList.length > showMax) lines.push(`| … | *${latestTagList.length - showMax} more* | | |`);
        lines.push(``);
        lines.push(`**Why it matters:** \`:latest\` tags make deployments non-reproducible and can pull untested or vulnerable versions.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Pin images to immutable tags or SHA digests (e.g. \`nginx:1.25.3\` or \`nginx@sha256:abc…\`)`);
        lines.push(`  2. Set \`imagePullPolicy: IfNotPresent\` (not \`Always\`) when using fixed tags`);
        lines.push(`  3. Use an image policy admission controller to block \`:latest\` tags cluster-wide`);
        lines.push(``);
      }

      // --- Finding: Missing NetworkPolicies ---
      if (uncoveredNs.length > 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${uncoveredNs.length} Namespace(s) Without NetworkPolicy`);
        lines.push(``);
        lines.push(`| Namespace |`);
        lines.push(`|-----------|`);
        for (const n of uncoveredNs.slice(0, showMax)) {
          lines.push(`| ${n} |`);
        }
        if (uncoveredNs.length > showMax) lines.push(`| … *${uncoveredNs.length - showMax} more* |`);
        lines.push(``);
        lines.push(`**Why it matters:** Without NetworkPolicies, all pods can communicate freely — a compromised pod can reach any service in the cluster.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Apply a default-deny ingress policy to each namespace:`);
        lines.push("     ```yaml");
        lines.push(`     apiVersion: networking.k8s.io/v1`);
        lines.push(`     kind: NetworkPolicy`);
        lines.push(`     metadata:`);
        lines.push(`       name: default-deny-ingress`);
        lines.push(`     spec:`);
        lines.push(`       podSelector: {}`);
        lines.push(`       policyTypes: [Ingress]`);
        lines.push("     ```");
        lines.push(`  2. Then add allow rules for legitimate traffic patterns`);
        lines.push(`  3. Test connectivity after applying: \`oc exec <pod> -- curl <target-svc>\``);
        lines.push(``);
      }

      // --- Summary ---
      lines.push(`---`);
      lines.push(``);
      if (score >= 90) lines.push(`@@SUMMARY@@\n**Security posture is strong.** No critical issues found. Continue monitoring to maintain compliance.\n@@/SUMMARY@@`);
      else if (score >= 70) lines.push(`@@SUMMARY@@\n**Some improvements recommended.** Address the warnings above to strengthen your security posture. Start with the highest-severity items.\n@@/SUMMARY@@`);
      else {
        lines.push(`@@SUMMARY@@`);
        lines.push(`**Significant security risks detected.** Prioritize remediation in this order:`);
        if (privilegedList.length > 0) lines.push(`  1. Remove privileged mode from ${privilegedList.length} container(s)`);
        if (hostNetList.length > 0) lines.push(`  ${privilegedList.length > 0 ? "2" : "1"}. Eliminate hostNetwork from ${hostNetList.length} pod(s)`);
        const nextNum = (privilegedList.length > 0 ? 1 : 0) + (hostNetList.length > 0 ? 1 : 0) + 1;
        if (runAsRootList.length > 0) lines.push(`  ${nextNum}. Enforce non-root for ${runAsRootList.length} container(s)`);
        if (noLimitsList.length > 0) lines.push(`  ${nextNum + (runAsRootList.length > 0 ? 1 : 0)}. Add resource limits to ${noLimitsList.length} container(s)`);
        if (uncoveredNs.length > 0) lines.push(`  ${nextNum + (runAsRootList.length > 0 ? 1 : 0) + (noLimitsList.length > 0 ? 1 : 0)}. Apply NetworkPolicies to ${uncoveredNs.length} namespace(s)`);
        lines.push(`@@/SUMMARY@@`);
      }

      return { reply: lines.join("\n"), contextKeys: ["slash", "security"] };
    } catch (e) {
      return { reply: `[ERROR] Security audit failed: ${e.message}`, contextKeys: ["slash", "security"] };
    }
  }

  // --- GitOps status ---
  if (cmd === "gitops") {
    try {
      const gitopsNs = arg || "openshift-gitops";
      const data = await ocpGet(`/apis/argoproj.io/v1alpha1/namespaces/${gitopsNs}/applications`);
      const apps = data.items || [];
      if (apps.length === 0) {
        return { reply: "### GitOps Applications\n[INFO] No ArgoCD applications found in namespace `" + gitopsNs + "`.\n\n**Remediation:**\n  1. Install the OpenShift GitOps Operator from OperatorHub\n  2. Create an ArgoCD instance: `oc apply -f argocd.yaml -n " + gitopsNs + "`\n  3. Add applications: `argocd app create <name> --repo <url> --path <path> --dest-server https://kubernetes.default.svc`", contextKeys: ["slash", "gitops"] };
      }
      const synced = apps.filter((a) => a.status?.sync?.status === "Synced").length;
      const outOfSync = apps.filter((a) => a.status?.sync?.status === "OutOfSync").length;
      const healthy = apps.filter((a) => a.status?.health?.status === "Healthy").length;
      const degraded = apps.filter((a) => a.status?.health?.status === "Degraded").length;
      const unknown = apps.filter((a) => !["Synced", "OutOfSync"].includes(a.status?.sync?.status || "")).length;

      const lines = [
        `### GitOps Sync & Health Report`,
        ``,
        `@@SUMMARY|green:${synced} Synced|amber:${outOfSync} OutOfSync|red:${degraded} Degraded@@`,
        ``,
        `| Application | Sync | Health | Target Revision | Repository |`,
        `|---|---|---|---|---|`,
      ];
      for (const a of apps.slice(0, 25)) {
        const name = a.metadata.name;
        const sync = a.status?.sync?.status || "Unknown";
        const health = a.status?.health?.status || "Unknown";
        const repo = a.spec?.source?.repoURL || a.spec?.sources?.[0]?.repoURL || "-";
        const rev = a.spec?.source?.targetRevision || a.spec?.sources?.[0]?.targetRevision || "HEAD";
        const syncTag = sync === "Synced" ? "[OK]" : "[WARNING]";
        const healthTag = health === "Healthy" ? "[OK]" : health === "Degraded" ? "[CRITICAL]" : "[INFO]";
        lines.push(`| ${name} | ${syncTag} ${sync} | ${healthTag} ${health} | ${rev} | ${repo} |`);
      }

      // Out-of-sync details
      const oosApps = apps.filter((a) => a.status?.sync?.status === "OutOfSync");
      if (oosApps.length > 0) {
        lines.push(``);
        lines.push(`---`);
        lines.push(`### [WARNING] ${oosApps.length} Application(s) Out of Sync`);
        lines.push(``);
        for (const a of oosApps.slice(0, 10)) {
          const name = a.metadata.name;
          const revision = a.status?.sync?.revision || "unknown";
          lines.push(`  - **${name}** — live revision: \`${revision.slice(0, 8)}\``);
        }
        lines.push(``);
        lines.push(`**Why it matters:** Out-of-sync apps have drifted from Git — the live cluster no longer matches your declared state.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Review diffs: \`argocd app diff <app-name>\``);
        lines.push(`  2. Sync manually: \`argocd app sync <app-name>\` or click Sync in ArgoCD UI`);
        lines.push(`  3. Enable auto-sync to prevent drift: \`argocd app set <app-name> --sync-policy automated\``);
        lines.push(`  4. If intentional, annotate: \`argocd app set <app-name> --sync-option Prune=false\``);
        lines.push(``);
      }

      // Degraded app details
      const degApps = apps.filter((a) => a.status?.health?.status === "Degraded");
      if (degApps.length > 0) {
        lines.push(`---`);
        lines.push(`### [CRITICAL] ${degApps.length} Application(s) Degraded`);
        lines.push(``);
        for (const a of degApps.slice(0, 10)) {
          const name = a.metadata.name;
          const msg = a.status?.conditions?.find((c) => c.type === "SyncError")?.message || "Check application resources";
          lines.push(`  - **${name}** — ${msg.slice(0, 120)}`);
        }
        lines.push(``);
        lines.push(`**Why it matters:** Degraded apps have resources in a failed state — services may be down or misconfigured.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Check app status: \`argocd app get <app-name>\``);
        lines.push(`  2. View resource events: \`oc describe <resource-type> <resource-name> -n <ns>\``);
        lines.push(`  3. Check pod logs for crashes: \`oc logs <pod-name> -n <ns>\``);
        lines.push(`  4. Force re-sync: \`argocd app sync <app-name> --force\``);
        lines.push(``);
      }

      // Summary
      lines.push(`---`);
      if (outOfSync === 0 && degraded === 0) {
        lines.push(`@@SUMMARY@@\n**All ${apps.length} applications are synced and healthy.** GitOps posture is excellent.\n@@/SUMMARY@@`);
      } else {
        lines.push(`@@SUMMARY@@`);
        lines.push(`**${synced}/${apps.length} applications are in sync.** Action needed:`);
        if (outOfSync > 0) lines.push(`  - Sync ${outOfSync} out-of-sync app(s)`);
        if (degraded > 0) lines.push(`  - Investigate ${degraded} degraded app(s)`);
        lines.push(`@@/SUMMARY@@`);
      }

      return { reply: lines.join("\n"), contextKeys: ["slash", "gitops"] };
    } catch {
      return { reply: "### GitOps Applications\n[INFO] ArgoCD / OpenShift GitOps not detected or not accessible.\n\n**Remediation:**\n  1. Install the OpenShift GitOps Operator: `oc apply -f gitops-subscription.yaml`\n  2. Wait for operator to be ready: `oc get csv -n openshift-operators`\n  3. Create an ArgoCD instance in namespace `openshift-gitops`", contextKeys: ["slash", "gitops"] };
    }
  }

  // --- DR / Backups ---
  if (cmd === "dr" || cmd === "backups") {
    const veleroNs = arg || "openshift-adp";
    try {
      const [backups, schedules, locations] = await Promise.all([
        ocpGet(`/apis/velero.io/v1/namespaces/${veleroNs}/backups`).catch(() => ({ items: [] })),
        ocpGet(`/apis/velero.io/v1/namespaces/${veleroNs}/schedules`).catch(() => ({ items: [] })),
        ocpGet(`/apis/velero.io/v1/namespaces/${veleroNs}/backupstoragelocations`).catch(() => ({ items: [] })),
      ]);
      const bkpItems = backups.items || [];
      const completed = bkpItems.filter((b) => b.status?.phase === "Completed");
      const failed = bkpItems.filter((b) => ["Failed", "PartiallyFailed"].includes(b.status?.phase));
      const inProgress = bkpItems.filter((b) => b.status?.phase === "InProgress");
      const schItems = schedules.items || [];
      const locItems = locations.items || [];
      const availLocs = locItems.filter((l) => l.status?.phase === "Available");
      const unavailLocs = locItems.filter((l) => l.status?.phase !== "Available");

      completed.sort((a, b) => (b.status?.completionTimestamp || "").localeCompare(a.status?.completionTimestamp || ""));
      const lastGood = completed[0];
      let lastAge = null;
      if (lastGood?.status?.completionTimestamp) {
        lastAge = Math.floor((Date.now() - new Date(lastGood.status.completionTimestamp).getTime()) / 86400000);
      }

      let score = 100;
      if (locItems.length === 0) score -= 30;
      else if (availLocs.length === 0) score -= 25;
      if (schItems.length === 0) score -= 25;
      else if (schItems.every((s) => s.spec?.paused)) score -= 20;
      if (completed.length === 0) score -= 25;
      else if (lastAge != null && lastAge > 7) score -= 15;
      if (failed.length > 0) score -= Math.min(15, failed.length * 5);
      score = Math.max(0, Math.round(score));
      const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

      const lines = [
        `### Disaster Recovery Assessment`,
        ``,
        `@@SCORE|${score}|DR Readiness@@`,
        `@@GRADE|${grade}|DR Grade@@`,
        ``,
        `| Metric | Value |`,
        `|---|---|`,
        `| Total backups | ${bkpItems.length} |`,
        `| Completed | ${completed.length} |`,
        `| Failed | ${failed.length} |`,
        `| In progress | ${inProgress.length} |`,
        `| Schedules | ${schItems.length} (${schItems.filter((s) => !s.spec?.paused).length} active) |`,
        `| Storage locations | ${locItems.length} (${availLocs.length} available) |`,
        `| Last successful backup | ${lastGood ? lastGood.metadata.name + (lastAge != null ? ` (${lastAge}d ago)` : "") : "None"} |`,
        ``,
      ];

      // Failed backups detail
      if (failed.length > 0) {
        lines.push(`---`);
        lines.push(`### [CRITICAL] ${failed.length} Failed Backup(s)`);
        lines.push(``);
        lines.push(`| Backup Name | Phase | Started | Errors |`);
        lines.push(`|---|---|---|---|`);
        for (const b of failed.slice(0, 10)) {
          const started = b.status?.startTimestamp ? new Date(b.status.startTimestamp).toLocaleString() : "-";
          const errs = b.status?.errors || 0;
          lines.push(`| ${b.metadata.name} | ${b.status?.phase} | ${started} | ${errs} |`);
        }
        lines.push(``);
        lines.push(`**Why it matters:** Failed backups mean your data is not protected — you cannot restore from a failed backup.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Check backup logs: \`velero backup logs <backup-name> -n ${veleroNs}\``);
        lines.push(`  2. Verify storage location is accessible: \`velero backup-location get -n ${veleroNs}\``);
        lines.push(`  3. Check for resource errors: \`velero backup describe <backup-name> --details -n ${veleroNs}\``);
        lines.push(`  4. Common fixes: update cloud credentials, increase timeout, exclude problematic resources`);
        lines.push(``);
      }

      // Unavailable storage locations
      if (unavailLocs.length > 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${unavailLocs.length} Unavailable Storage Location(s)`);
        lines.push(``);
        lines.push(`| Location | Phase | Provider |`);
        lines.push(`|---|---|---|`);
        for (const l of unavailLocs) {
          lines.push(`| ${l.metadata.name} | ${l.status?.phase || "Unknown"} | ${l.spec?.provider || "-"} |`);
        }
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Verify cloud credentials: \`oc get secret cloud-credentials -n ${veleroNs} -o yaml\``);
        lines.push(`  2. Check bucket accessibility from the cluster network`);
        lines.push(`  3. Restart Velero: \`oc rollout restart deployment/velero -n ${veleroNs}\``);
        lines.push(``);
      }

      // Paused schedules
      const pausedSch = schItems.filter((s) => s.spec?.paused);
      if (pausedSch.length > 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${pausedSch.length} Paused Schedule(s)`);
        lines.push(``);
        for (const s of pausedSch) {
          lines.push(`  - **${s.metadata.name}** — cron: \`${s.spec?.schedule || "?"}\``);
        }
        lines.push(``);
        lines.push(`**Remediation:** Unpause: \`velero schedule set <schedule-name> --paused=false -n ${veleroNs}\``);
        lines.push(``);
      }

      // No schedules
      if (schItems.length === 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] No Backup Schedules Configured`);
        lines.push(``);
        lines.push(`**Why it matters:** Without scheduled backups, you rely on manual backups which are easily forgotten.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Create a daily schedule:`);
        lines.push("     ```");
        lines.push(`     velero schedule create daily-backup --schedule="0 2 * * *" --ttl 168h -n ${veleroNs}`);
        lines.push("     ```");
        lines.push(`  2. For namespace-specific backups: add \`--include-namespaces <ns1>,<ns2>\``);
        lines.push(``);
      }

      // Stale backups
      if (lastAge != null && lastAge > 7) {
        lines.push(`---`);
        lines.push(`### [WARNING] Last Successful Backup is ${lastAge} Day(s) Old`);
        lines.push(``);
        lines.push(`**Why it matters:** Stale backups mean a restore would lose ${lastAge} days of data.`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Trigger an immediate backup: \`velero backup create manual-$(date +%Y%m%d) -n ${veleroNs}\``);
        lines.push(`  2. Verify schedules are running: \`velero schedule get -n ${veleroNs}\``);
        lines.push(``);
      }

      // Recent backups table
      if (completed.length > 0) {
        lines.push(`---`);
        lines.push(`### Recent Successful Backups`);
        lines.push(``);
        lines.push(`| Backup | Completed | Items Backed Up | TTL |`);
        lines.push(`|---|---|---|---|`);
        for (const b of completed.slice(0, 5)) {
          const ts = b.status?.completionTimestamp ? new Date(b.status.completionTimestamp).toLocaleString() : "-";
          const itemCount = b.status?.progress?.itemsBackedUp || "?";
          const ttl = b.spec?.ttl || "default";
          lines.push(`| ${b.metadata.name} | ${ts} | ${itemCount} | ${ttl} |`);
        }
        lines.push(``);
      }

      // Summary
      lines.push(`---`);
      if (score >= 90) {
        lines.push(`@@SUMMARY@@\n**DR posture is strong.** Backups are current, schedules are active, and storage is healthy.\n@@/SUMMARY@@`);
      } else if (score >= 70) {
        lines.push(`@@SUMMARY@@\n**DR posture needs improvement.** Review the warnings above and address the highest-priority items first.\n@@/SUMMARY@@`);
      } else {
        lines.push(`@@SUMMARY@@`);
        lines.push(`**DR readiness is critically low.** Prioritize:`);
        if (locItems.length === 0) lines.push(`  1. Configure a backup storage location`);
        else if (availLocs.length === 0) lines.push(`  1. Fix unavailable storage locations`);
        if (schItems.length === 0) lines.push(`  2. Create backup schedules`);
        if (failed.length > 0) lines.push(`  3. Investigate ${failed.length} failed backup(s)`);
        if (completed.length === 0) lines.push(`  4. Run a successful backup immediately`);
        lines.push(`@@/SUMMARY@@`);
      }

      return { reply: lines.join("\n"), contextKeys: ["slash", "dr"] };
    } catch {
      return { reply: "### Disaster Recovery\n[WARNING] Velero / OADP not installed or not accessible.\n\n**Remediation:**\n  1. Install the OADP Operator from OperatorHub\n  2. Create a DataProtectionApplication CR:\n     ```\n     oc create -f dpa.yaml -n openshift-adp\n     ```\n  3. Configure a BackupStorageLocation with your cloud credentials\n  4. Create your first backup: `velero backup create initial-backup -n openshift-adp`", contextKeys: ["slash", "dr"] };
    }
  }

  // --- Recommendations ---
  if (cmd === "recommendations") {
    try {
      const [pods, metrics, nodes] = await Promise.all([
        ocpGet("/api/v1/pods"),
        ocpGet("/apis/metrics.k8s.io/v1beta1/pods").catch(() => ({ items: [] })),
        ocpGet("/api/v1/nodes"),
      ]);
      const pCpu = (s) => { if (!s) return 0; if (typeof s === "number") return s; if (s.endsWith("n")) return parseInt(s)/1e9; if (s.endsWith("u")) return parseInt(s)/1e6; if (s.endsWith("m")) return parseInt(s)/1e3; return parseFloat(s)||0; };
      const pMem = (s) => { if (!s) return 0; if (typeof s === "number") return s; if (s.endsWith("Ki")) return parseInt(s)*1024; if (s.endsWith("Mi")) return parseInt(s)*1048576; if (s.endsWith("Gi")) return parseInt(s)*1073741824; return parseInt(s)||0; };
      const fmtCpu = (v) => v < 0.01 ? Math.round(v * 1000) + "m" : v.toFixed(2);
      const fmtMem = (v) => v > 1073741824 ? (v / 1073741824).toFixed(1) + "Gi" : (v / 1048576).toFixed(0) + "Mi";

      const userPods = (pods.items || []).filter((p) => p.status?.phase === "Running" && !p.metadata.namespace?.startsWith("openshift-") && !p.metadata.namespace?.startsWith("kube-"));
      const metricsMap = {};
      for (const m of (metrics.items || [])) {
        let cpu = 0, mem = 0;
        for (const c of (m.containers || [])) { cpu += pCpu(c.usage?.cpu); mem += pMem(c.usage?.memory); }
        metricsMap[`${m.metadata.namespace}/${m.metadata.name}`] = { cpu, mem };
      }

      let over = 0, under = 0, noLim = 0;
      const overList = [], underList = [], noLimList = [];
      for (const p of userPods) {
        const key = `${p.metadata.namespace}/${p.metadata.name}`;
        const usage = metricsMap[key];
        let reqCpu = 0, reqMem = 0, haslim = false;
        for (const c of (p.spec?.containers || [])) {
          reqCpu += pCpu(c.resources?.requests?.cpu);
          reqMem += pMem(c.resources?.requests?.memory);
          if (c.resources?.limits?.cpu || c.resources?.limits?.memory) haslim = true;
        }
        if (!haslim) { noLim++; noLimList.push({ ns: p.metadata.namespace, pod: p.metadata.name }); continue; }
        if (!usage) continue;
        if (reqCpu > 0 && usage.cpu < reqCpu * 0.1 && reqCpu >= 0.1) {
          over++;
          overList.push({ ns: p.metadata.namespace, pod: p.metadata.name, reqCpu, usageCpu: usage.cpu, reqMem, usageMem: usage.mem });
        }
        if (reqCpu > 0 && usage.cpu > reqCpu * 1.5) {
          under++;
          underList.push({ ns: p.metadata.namespace, pod: p.metadata.name, reqCpu, usageCpu: usage.cpu, reqMem, usageMem: usage.mem });
        }
      }

      const nodeItems = nodes.items || [];
      let totalAllocCpu = 0, totalAllocMem = 0, totalReqCpu = 0, totalReqMem = 0;
      for (const n of nodeItems) { totalAllocCpu += pCpu(n.status?.allocatable?.cpu); totalAllocMem += pMem(n.status?.allocatable?.memory); }
      for (const p of (pods.items || []).filter((p) => p.status?.phase === "Running")) {
        for (const c of (p.spec?.containers || [])) { totalReqCpu += pCpu(c.resources?.requests?.cpu); totalReqMem += pMem(c.resources?.requests?.memory); }
      }
      const cpuH = totalAllocCpu > 0 ? Math.round(((totalAllocCpu - totalReqCpu) / totalAllocCpu) * 100) : 0;
      const memH = totalAllocMem > 0 ? Math.round(((totalAllocMem - totalReqMem) / totalAllocMem) * 100) : 0;

      const restartPods = (pods.items || []).filter((p) => (p.status?.containerStatuses || []).some((c) => c.restartCount > 5))
        .map((p) => ({ ns: p.metadata.namespace, pod: p.metadata.name, restarts: Math.max(...(p.status?.containerStatuses || []).map((c) => c.restartCount || 0)) }))
        .sort((a, b) => b.restarts - a.restarts);

      const lines = [
        `### Cluster Optimization Report`,
        ``,
        `@@SUMMARY|amber:${over} Over-provisioned|red:${under} Under-provisioned|green:${userPods.length - over - under - noLim} Well-sized@@`,
        ``,
        `| Metric | Value |`,
        `|---|---|`,
        `| User pods analyzed | ${userPods.length} |`,
        `| Over-provisioned | ${over} |`,
        `| Under-provisioned | ${under} |`,
        `| Missing resource limits | ${noLim} |`,
        `| CPU headroom | ${cpuH}% (${fmtCpu(totalAllocCpu - totalReqCpu)} free of ${fmtCpu(totalAllocCpu)}) |`,
        `| Memory headroom | ${memH}% (${fmtMem(totalAllocMem - totalReqMem)} free of ${fmtMem(totalAllocMem)}) |`,
        `| Pods with high restarts | ${restartPods.length} |`,
        ``,
      ];

      // Over-provisioned detail
      if (overList.length > 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${over} Over-Provisioned Pod(s)`);
        lines.push(``);
        lines.push(`These pods are using less than 10% of their requested CPU — you are paying for unused resources.`);
        lines.push(``);
        lines.push(`| Namespace | Pod | CPU Request | CPU Usage | Utilization |`);
        lines.push(`|---|---|---|---|---|`);
        for (const o of overList.slice(0, 10)) {
          const util = o.reqCpu > 0 ? Math.round((o.usageCpu / o.reqCpu) * 100) : 0;
          lines.push(`| ${o.ns} | ${o.pod} | ${fmtCpu(o.reqCpu)} | ${fmtCpu(o.usageCpu)} | ${util}% |`);
        }
        if (overList.length > 10) lines.push(`| … | *${overList.length - 10} more* | | | |`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Right-size CPU requests to match actual usage (add 20% buffer)`);
        lines.push(`  2. Use VPA (Vertical Pod Autoscaler) for automatic right-sizing:`);
        lines.push(`     \`oc apply -f vpa.yaml\` with \`updateMode: Auto\``);
        lines.push(`  3. For batch workloads, consider switching to Jobs instead of long-running pods`);
        lines.push(``);
      }

      // Under-provisioned detail
      if (underList.length > 0) {
        lines.push(`---`);
        lines.push(`### [CRITICAL] ${under} Under-Provisioned Pod(s)`);
        lines.push(``);
        lines.push(`These pods are using more than 150% of their CPU request — they may be throttled or evicted.`);
        lines.push(``);
        lines.push(`| Namespace | Pod | CPU Request | CPU Usage | Utilization |`);
        lines.push(`|---|---|---|---|---|`);
        for (const u of underList.slice(0, 10)) {
          const util = u.reqCpu > 0 ? Math.round((u.usageCpu / u.reqCpu) * 100) : 0;
          lines.push(`| ${u.ns} | ${u.pod} | ${fmtCpu(u.reqCpu)} | ${fmtCpu(u.usageCpu)} | ${util}% |`);
        }
        if (underList.length > 10) lines.push(`| … | *${underList.length - 10} more* | | | |`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Increase CPU requests to at least match current usage`);
        lines.push(`  2. Set up HPA (Horizontal Pod Autoscaler) for scaling:`);
        lines.push(`     \`oc autoscale deployment/<name> --min=2 --max=10 --cpu-percent=70\``);
        lines.push(`  3. Check if CPU limits are causing throttling — consider increasing or removing limits`);
        lines.push(``);
      }

      // No limits detail
      if (noLimList.length > 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${noLim} Pod(s) Without Resource Limits`);
        lines.push(``);
        lines.push(`| Namespace | Pod |`);
        lines.push(`|---|---|`);
        for (const n of noLimList.slice(0, 10)) {
          lines.push(`| ${n.ns} | ${n.pod} |`);
        }
        if (noLimList.length > 10) lines.push(`| … | *${noLimList.length - 10} more* |`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Add resource limits and requests to all containers`);
        lines.push(`  2. Apply a LimitRange for namespace defaults:`);
        lines.push(`     \`oc create limitrange default --default-cpu=500m --default-memory=256Mi -n <ns>\``);
        lines.push(``);
      }

      // High restart pods
      if (restartPods.length > 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${restartPods.length} Pod(s) With Excessive Restarts`);
        lines.push(``);
        lines.push(`| Namespace | Pod | Restarts |`);
        lines.push(`|---|---|---|`);
        for (const r of restartPods.slice(0, 10)) {
          lines.push(`| ${r.ns} | ${r.pod} | ${r.restarts} |`);
        }
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Check logs: \`oc logs <pod-name> -n <ns> --previous\``);
        lines.push(`  2. Check events: \`oc describe pod <pod-name> -n <ns>\``);
        lines.push(`  3. Common causes: OOMKilled (increase memory limits), CrashLoopBackOff (fix application code/config)`);
        lines.push(``);
      }

      // Cluster capacity warnings
      if (cpuH < 15 || memH < 15) {
        lines.push(`---`);
        lines.push(`### [CRITICAL] Cluster Capacity Warning`);
        lines.push(``);
        if (cpuH < 15) lines.push(`  - CPU headroom is very low at **${cpuH}%** — only ${fmtCpu(totalAllocCpu - totalReqCpu)} cores free`);
        if (memH < 15) lines.push(`  - Memory headroom is very low at **${memH}%** — only ${fmtMem(totalAllocMem - totalReqMem)} free`);
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Right-size over-provisioned workloads to free up resources`);
        lines.push(`  2. Add worker nodes: \`oc get machinesets -n openshift-machine-api\` then scale up`);
        lines.push(`  3. Enable cluster autoscaler for automatic node scaling`);
        lines.push(``);
      } else if (cpuH < 30 || memH < 30) {
        lines.push(`---`);
        if (cpuH < 30) lines.push(`[WARNING] CPU headroom is getting tight at ${cpuH}%.`);
        if (memH < 30) lines.push(`[WARNING] Memory headroom is getting tight at ${memH}%.`);
        lines.push(``);
      }

      // Summary
      lines.push(`---`);
      if (cpuH >= 30 && memH >= 30 && over === 0 && under === 0 && noLim === 0 && restartPods.length === 0) {
        lines.push(`@@SUMMARY@@\n**Cluster resources are well-balanced.** No optimization needed at this time.\n@@/SUMMARY@@`);
      } else {
        lines.push(`@@SUMMARY@@`);
        lines.push(`**Optimization opportunities identified:**`);
        if (over > 0) lines.push(`  - Right-size ${over} over-provisioned pod(s) to reclaim wasted CPU/memory`);
        if (under > 0) lines.push(`  - Increase resources for ${under} under-provisioned pod(s) to prevent throttling`);
        if (noLim > 0) lines.push(`  - Add resource limits to ${noLim} pod(s)`);
        if (restartPods.length > 0) lines.push(`  - Investigate ${restartPods.length} pod(s) with excessive restarts`);
        if (cpuH < 30) lines.push(`  - Plan capacity expansion — CPU headroom is ${cpuH}%`);
        lines.push(`@@/SUMMARY@@`);
      }

      return { reply: lines.join("\n"), contextKeys: ["slash", "recommendations"] };
    } catch (e) {
      return { reply: `[ERROR] Optimization report failed: ${e.message}`, contextKeys: ["slash", "recommendations"] };
    }
  }

  // --- Quick resource listing shortcuts ---
  if (cmd === "pods") {
    const ns = arg || null;
    try {
      const path = ns ? `/api/v1/namespaces/${ns}/pods` : "/api/v1/pods";
      const data = await ocpGet(path);
      const items = (data.items || []).filter((p) => !ns ? (!p.metadata.namespace.startsWith("openshift-") && !p.metadata.namespace.startsWith("kube-")) : true);
      const running = items.filter((p) => p.status?.phase === "Running").length;
      const failed = items.filter((p) => ["Failed", "Unknown"].includes(p.status?.phase)).length;
      const pending = items.filter((p) => p.status?.phase === "Pending").length;
      const succeeded = items.filter((p) => p.status?.phase === "Succeeded").length;

      const lines = [
        `### Pod Summary${ns ? ` (${ns})` : ""}`,
        ``,
        `@@SUMMARY|green:${running} Running|amber:${pending} Pending|red:${failed} Failed@@`,
        ``,
        `**Total:** ${items.length} pods`,
        ``,
      ];

      // Problem pods: CrashLoop, high restarts, ImagePull errors
      const crashLoop = items.filter((p) => (p.status?.containerStatuses || []).some((c) => c.state?.waiting?.reason === "CrashLoopBackOff"));
      const imgPull = items.filter((p) => (p.status?.containerStatuses || []).some((c) => ["ImagePullBackOff", "ErrImagePull"].includes(c.state?.waiting?.reason)));
      const highRestart = items.filter((p) => (p.status?.containerStatuses || []).some((c) => c.restartCount > 5))
        .sort((a, b) => Math.max(...(b.status?.containerStatuses || []).map((c) => c.restartCount || 0)) - Math.max(...(a.status?.containerStatuses || []).map((c) => c.restartCount || 0)));

      if (crashLoop.length > 0) {
        lines.push(`---`);
        lines.push(`### [CRITICAL] ${crashLoop.length} Pod(s) in CrashLoopBackOff`);
        lines.push(``);
        lines.push(`| Namespace | Pod | Container | Restarts |`);
        lines.push(`|---|---|---|---|`);
        for (const p of crashLoop.slice(0, 10)) {
          const cs = (p.status?.containerStatuses || []).filter((c) => c.state?.waiting?.reason === "CrashLoopBackOff");
          for (const c of cs) {
            lines.push(`| ${p.metadata.namespace} | ${p.metadata.name} | ${c.name} | ${c.restartCount} |`);
          }
        }
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Check logs: \`oc logs <pod> -c <container> -n <ns> --previous\``);
        lines.push(`  2. Check events: \`oc describe pod <pod> -n <ns>\``);
        lines.push(`  3. Common causes: missing config/secrets, wrong command, OOMKilled, startup probe failure`);
        lines.push(``);
      }

      if (imgPull.length > 0) {
        lines.push(`---`);
        lines.push(`### [CRITICAL] ${imgPull.length} Pod(s) With Image Pull Errors`);
        lines.push(``);
        lines.push(`| Namespace | Pod | Image |`);
        lines.push(`|---|---|---|`);
        for (const p of imgPull.slice(0, 10)) {
          const cs = (p.status?.containerStatuses || []).filter((c) => ["ImagePullBackOff", "ErrImagePull"].includes(c.state?.waiting?.reason));
          for (const c of cs) {
            lines.push(`| ${p.metadata.namespace} | ${p.metadata.name} | \`${c.image}\` |`);
          }
        }
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Verify the image exists: \`podman pull <image>\``);
        lines.push(`  2. Check pull secret: \`oc get secret -n <ns> | grep pull\``);
        lines.push(`  3. For private registries: \`oc create secret docker-registry <name> --docker-server=<url> --docker-username=<user> --docker-password=<pw>\``);
        lines.push(``);
      }

      if (pending.length > 0) {
        const pendingPods = items.filter((p) => p.status?.phase === "Pending");
        lines.push(`---`);
        lines.push(`### [WARNING] ${pending} Pending Pod(s)`);
        lines.push(``);
        lines.push(`| Namespace | Pod | Reason |`);
        lines.push(`|---|---|---|`);
        for (const p of pendingPods.slice(0, 10)) {
          const cond = (p.status?.conditions || []).find((c) => c.status === "False");
          const reason = cond?.reason || (p.status?.containerStatuses || []).find((c) => c.state?.waiting)?.state?.waiting?.reason || "Scheduling";
          lines.push(`| ${p.metadata.namespace} | ${p.metadata.name} | ${reason} |`);
        }
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Check events: \`oc describe pod <pod> -n <ns>\``);
        lines.push(`  2. Common causes: insufficient resources, node selectors, taints/tolerations, PVC binding`);
        lines.push(`  3. Check cluster capacity: \`oc adm top nodes\``);
        lines.push(``);
      }

      if (highRestart.length > 0 && crashLoop.length === 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${highRestart.length} Pod(s) With High Restarts`);
        lines.push(``);
        lines.push(`| Namespace | Pod | Max Restarts |`);
        lines.push(`|---|---|---|`);
        for (const p of highRestart.slice(0, 10)) {
          const maxR = Math.max(...(p.status?.containerStatuses || []).map((c) => c.restartCount || 0));
          lines.push(`| ${p.metadata.namespace} | ${p.metadata.name} | ${maxR} |`);
        }
        lines.push(``);
        lines.push(`**Remediation:** Check logs with \`--previous\` flag to see why containers are restarting.`);
        lines.push(``);
      }

      if (crashLoop.length === 0 && imgPull.length === 0 && pending === 0 && highRestart.length === 0) {
        lines.push(`[OK] All pods are healthy — no issues detected.`);
      }

      return { reply: lines.join("\n"), contextKeys: ["slash", "pods"] };
    } catch (e) {
      return { reply: `[ERROR] ${e.message}`, contextKeys: ["slash", "pods"] };
    }
  }

  if (cmd === "nodes") {
    try {
      const [nodeData, nodeMetrics] = await Promise.all([
        ocpGet("/api/v1/nodes"),
        ocpGet("/apis/metrics.k8s.io/v1beta1/nodes").catch(() => ({ items: [] })),
      ]);
      const items = nodeData.items || [];
      const metricsMap = {};
      for (const m of (nodeMetrics.items || [])) {
        metricsMap[m.metadata.name] = m.usage || {};
      }

      const pCpu = (s) => { if (!s) return 0; if (typeof s === "number") return s; if (s.endsWith("n")) return parseInt(s)/1e9; if (s.endsWith("u")) return parseInt(s)/1e6; if (s.endsWith("m")) return parseInt(s)/1e3; return parseFloat(s)||0; };
      const pMem = (s) => { if (!s) return 0; if (typeof s === "number") return s; if (s.endsWith("Ki")) return parseInt(s)*1024; if (s.endsWith("Mi")) return parseInt(s)*1048576; if (s.endsWith("Gi")) return parseInt(s)*1073741824; return parseInt(s)||0; };
      const fmtMem = (v) => v > 1073741824 ? (v / 1073741824).toFixed(1) + "Gi" : (v / 1048576).toFixed(0) + "Mi";

      const readyCount = items.filter((n) => (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True")).length;
      const notReady = items.filter((n) => !(n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True"));

      const lines = [
        `### Cluster Nodes (${items.length})`,
        ``,
        `@@SUMMARY|green:${readyCount} Ready|red:${notReady.length} NotReady@@`,
        ``,
        `| Node | Roles | Status | CPU (capacity) | Memory (capacity) | CPU Usage | Memory Usage |`,
        `|---|---|---|---|---|---|---|`,
      ];
      for (const n of items) {
        const roles = Object.keys(n.metadata.labels || {}).filter((l) => l.startsWith("node-role.kubernetes.io/")).map((l) => l.split("/")[1]).join(", ") || "worker";
        const ready = (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True");
        const usage = metricsMap[n.metadata.name];
        const cpuCap = n.status?.capacity?.cpu || "?";
        const memCap = n.status?.capacity?.memory || "?";
        let cpuUse = "-", memUse = "-";
        if (usage) {
          const cpuPct = pCpu(cpuCap) > 0 ? Math.round((pCpu(usage.cpu) / pCpu(cpuCap)) * 100) : 0;
          const memPct = pMem(memCap) > 0 ? Math.round((pMem(usage.memory) / pMem(memCap)) * 100) : 0;
          cpuUse = `${cpuPct}%`;
          memUse = `${memPct}%`;
        }
        lines.push(`| ${n.metadata.name} | ${roles} | ${ready ? "[OK] Ready" : "[CRITICAL] NotReady"} | ${cpuCap} | ${fmtMem(pMem(memCap))} | ${cpuUse} | ${memUse} |`);
      }

      if (notReady.length > 0) {
        lines.push(``);
        lines.push(`---`);
        lines.push(`### [CRITICAL] ${notReady.length} Node(s) Not Ready`);
        lines.push(``);
        for (const n of notReady) {
          const conds = (n.status?.conditions || []).filter((c) => c.status === "True" && c.type !== "Ready");
          const reasons = conds.map((c) => `${c.type}: ${c.message || c.reason || ""}`).join("; ") || "Unknown";
          lines.push(`  - **${n.metadata.name}** — ${reasons.slice(0, 150)}`);
        }
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Check node conditions: \`oc describe node <node-name>\``);
        lines.push(`  2. Check kubelet: \`oc debug node/<node-name> -- chroot /host systemctl status kubelet\``);
        lines.push(`  3. Check disk/memory pressure in node conditions above`);
        lines.push(`  4. If unrecoverable, cordon and drain: \`oc adm cordon <node> && oc adm drain <node> --ignore-daemonsets\``);
        lines.push(``);
      }

      // Node pressure warnings
      const pressure = items.filter((n) => (n.status?.conditions || []).some((c) => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True"));
      if (pressure.length > 0) {
        lines.push(`---`);
        lines.push(`### [WARNING] ${pressure.length} Node(s) Under Pressure`);
        lines.push(``);
        for (const n of pressure) {
          const prConds = (n.status?.conditions || []).filter((c) => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True");
          lines.push(`  - **${n.metadata.name}** — ${prConds.map((c) => c.type).join(", ")}`);
        }
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  - MemoryPressure: evict non-critical pods, add nodes, or increase node memory`);
        lines.push(`  - DiskPressure: clean up images/containers: \`oc debug node/<node> -- chroot /host crictl rmi --prune\``);
        lines.push(`  - PIDPressure: check for PID-leaking workloads, increase pid.max`);
        lines.push(``);
      }

      return { reply: lines.join("\n"), contextKeys: ["slash", "nodes"] };
    } catch (e) {
      return { reply: `[ERROR] ${e.message}`, contextKeys: ["slash", "nodes"] };
    }
  }

  if (cmd === "deployments") {
    const ns = arg || null;
    try {
      const path = ns ? `/apis/apps/v1/namespaces/${ns}/deployments` : "/apis/apps/v1/deployments";
      const data = await ocpGet(path);
      const items = (data.items || []).filter((d) => !ns ? (!d.metadata.namespace.startsWith("openshift-") && !d.metadata.namespace.startsWith("kube-")) : true);

      const healthy = items.filter((d) => (d.status?.readyReplicas || 0) === (d.spec?.replicas || 0) && (d.spec?.replicas || 0) > 0);
      const degraded = items.filter((d) => (d.status?.readyReplicas || 0) < (d.spec?.replicas || 0) && (d.spec?.replicas || 0) > 0);
      const zeroScale = items.filter((d) => (d.spec?.replicas || 0) === 0);

      const lines = [
        `### Deployments${ns ? ` (${ns})` : ""} — ${items.length}`,
        ``,
        `@@SUMMARY|green:${healthy.length} Healthy|red:${degraded.length} Degraded|amber:${zeroScale.length} Scaled to 0@@`,
        ``,
        `| Name | Namespace | Ready | Available | Image |`,
        `|---|---|---|---|---|`,
      ];
      for (const d of items.slice(0, 30)) {
        const ready = `${d.status?.readyReplicas || 0}/${d.spec?.replicas || 0}`;
        const avail = d.status?.availableReplicas || 0;
        const img = d.spec?.template?.spec?.containers?.[0]?.image || "-";
        const shortImg = img.length > 50 ? "…" + img.slice(-45) : img;
        const isDegraded = (d.status?.readyReplicas || 0) < (d.spec?.replicas || 0) && (d.spec?.replicas || 0) > 0;
        lines.push(`| ${isDegraded ? "**" + d.metadata.name + "**" : d.metadata.name} | ${d.metadata.namespace} | ${isDegraded ? "[WARNING] " : ""}${ready} | ${avail} | \`${shortImg}\` |`);
      }
      if (items.length > 30) lines.push(`\n*...and ${items.length - 30} more*`);

      if (degraded.length > 0) {
        lines.push(``);
        lines.push(`---`);
        lines.push(`### [WARNING] ${degraded.length} Degraded Deployment(s)`);
        lines.push(``);
        for (const d of degraded.slice(0, 10)) {
          const readyR = d.status?.readyReplicas || 0;
          const desired = d.spec?.replicas || 0;
          const conds = (d.status?.conditions || []).filter((c) => c.status === "False");
          const reason = conds.length > 0 ? conds[0].reason + ": " + (conds[0].message || "").slice(0, 80) : "Pods not ready";
          lines.push(`  - **${d.metadata.namespace}/${d.metadata.name}** — ${readyR}/${desired} ready — ${reason}`);
        }
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Check pod status: \`oc get pods -l app=<deployment-name> -n <ns>\``);
        lines.push(`  2. Check events: \`oc describe deployment <name> -n <ns>\``);
        lines.push(`  3. Rollback if a recent change caused it: \`oc rollout undo deployment/<name> -n <ns>\``);
        lines.push(`  4. Scale issues: \`oc scale deployment/<name> --replicas=<N> -n <ns>\``);
        lines.push(``);
      }

      return { reply: lines.join("\n"), contextKeys: ["slash", "deployments"] };
    } catch (e) {
      return { reply: `[ERROR] ${e.message}`, contextKeys: ["slash", "deployments"] };
    }
  }

  if (cmd === "events") {
    const ns = arg || null;
    try {
      const path = ns ? `/api/v1/namespaces/${ns}/events` : "/api/v1/events";
      const data = await ocpGet(path);
      const warnings = (data.items || []).filter((e) => e.type === "Warning")
        .filter((e) => !ns ? (!e.metadata.namespace?.startsWith("openshift-") && !e.metadata.namespace?.startsWith("kube-")) : true)
        .sort((a, b) => new Date(b.lastTimestamp || b.metadata.creationTimestamp) - new Date(a.lastTimestamp || a.metadata.creationTimestamp));

      if (warnings.length === 0) return { reply: `### Events${ns ? ` (${ns})` : ""}\n[OK] No warning events found. Your cluster is running clean.`, contextKeys: ["slash", "events"] };

      // Group by reason
      const byReason = {};
      for (const e of warnings) {
        const r = e.reason || "Unknown";
        if (!byReason[r]) byReason[r] = [];
        byReason[r].push(e);
      }

      const lines = [
        `### Warning Events${ns ? ` (${ns})` : ""}`,
        ``,
        `**${warnings.length} warning event(s)** grouped by reason:`,
        ``,
      ];

      const reasonEntries = Object.entries(byReason).sort((a, b) => b[1].length - a[1].length);

      for (const [reason, events] of reasonEntries.slice(0, 8)) {
        lines.push(`---`);
        lines.push(`### ${reason} (${events.length} occurrence${events.length > 1 ? "s" : ""})`);
        lines.push(``);
        lines.push(`| Namespace | Resource | Message | Count |`);
        lines.push(`|---|---|---|---|`);
        for (const e of events.slice(0, 5)) {
          const kind = e.involvedObject?.kind || "?";
          const name = e.involvedObject?.name || "?";
          const msg = (e.message || "").slice(0, 80).replace(/\|/g, "/");
          lines.push(`| ${e.metadata.namespace || "-"} | ${kind}/${name} | ${msg} | ${e.count || 1} |`);
        }
        if (events.length > 5) lines.push(`| … | *${events.length - 5} more* | | |`);
        lines.push(``);

        // Contextual remediation per reason
        const r = reason.toLowerCase();
        if (r.includes("backoff") || r.includes("crashloop")) {
          lines.push(`**Remediation:** Check container logs: \`oc logs <pod> -n <ns> --previous\` — look for application errors, missing configs, or OOMKilled.`);
        } else if (r.includes("imagepull") || r.includes("errimagepull")) {
          lines.push(`**Remediation:** Verify image exists and pull secret is configured: \`oc get secret -n <ns> | grep pull\``);
        } else if (r.includes("failedschedul")) {
          lines.push(`**Remediation:** Check node resources (\`oc adm top nodes\`), node selectors, taints/tolerations, and PVC availability.`);
        } else if (r.includes("unhealthy") || r.includes("probe")) {
          lines.push(`**Remediation:** Review liveness/readiness probe configuration — increase \`initialDelaySeconds\` or \`timeoutSeconds\` if the app starts slowly.`);
        } else if (r.includes("evict")) {
          lines.push(`**Remediation:** Node is under resource pressure. Check disk/memory usage: \`oc debug node/<node-name> -- df -h\``);
        } else if (r.includes("oom") || r.includes("killed")) {
          lines.push(`**Remediation:** Increase container memory limits in the deployment spec. Current limits are too low for the workload.`);
        } else if (r.includes("failedcreate") || r.includes("failedmount")) {
          lines.push(`**Remediation:** Check PVC/ConfigMap/Secret references exist: \`oc describe pod <pod> -n <ns>\``);
        }
        lines.push(``);
      }

      if (reasonEntries.length > 8) {
        lines.push(`*...and ${reasonEntries.length - 8} more event reason(s)*`);
        lines.push(``);
      }

      return { reply: lines.join("\n"), contextKeys: ["slash", "events"] };
    } catch (e) {
      return { reply: `[ERROR] ${e.message}`, contextKeys: ["slash", "events"] };
    }
  }

  if (cmd === "pipelines") {
    const ns = arg || null;
    try {
      const pipePath = ns ? `/apis/tekton.dev/v1/namespaces/${ns}/pipelines` : "/apis/tekton.dev/v1/pipelines";
      const runPath = ns ? `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns` : "/apis/tekton.dev/v1/pipelineruns";
      const [pipeData, runData] = await Promise.all([
        ocpGet(pipePath),
        ocpGet(runPath).catch(() => ({ items: [] })),
      ]);
      const items = pipeData.items || [];
      const runs = (runData.items || []).sort((a, b) => (b.status?.startTime || "").localeCompare(a.status?.startTime || ""));

      if (items.length === 0) return { reply: `### Tekton Pipelines${ns ? ` (${ns})` : ""}\n[INFO] No pipelines found.\n\n**Getting started:**\n  1. Create a pipeline: \`oc apply -f pipeline.yaml -n <ns>\`\n  2. Run it: \`tkn pipeline start <name> -n <ns>\``, contextKeys: ["slash", "pipelines"] };

      const lines = [
        `### Tekton Pipelines${ns ? ` (${ns})` : ""} — ${items.length}`,
        ``,
        `| Pipeline | Namespace | Tasks | Last Run | Status |`,
        `|---|---|---|---|---|`,
      ];
      for (const p of items.slice(0, 30)) {
        const lastRun = runs.find((r) => r.spec?.pipelineRef?.name === p.metadata.name && r.metadata.namespace === p.metadata.namespace);
        const lastStatus = lastRun ? (lastRun.status?.conditions?.[0]?.reason || lastRun.status?.conditions?.[0]?.status || "?") : "Never";
        const statusTag = lastStatus === "Succeeded" ? "[OK]" : lastStatus === "Failed" ? "[CRITICAL]" : lastStatus === "Running" ? "[INFO]" : "";
        lines.push(`| ${p.metadata.name} | ${p.metadata.namespace} | ${p.spec?.tasks?.length || 0} | ${lastRun ? new Date(lastRun.status?.startTime || lastRun.metadata.creationTimestamp).toLocaleString() : "-"} | ${statusTag} ${lastStatus} |`);
      }

      // Failed runs
      const failedRuns = runs.filter((r) => r.status?.conditions?.[0]?.reason === "Failed");
      if (failedRuns.length > 0) {
        lines.push(``);
        lines.push(`---`);
        lines.push(`### [WARNING] ${failedRuns.length} Failed PipelineRun(s)`);
        lines.push(``);
        lines.push(`| PipelineRun | Pipeline | Namespace | Started | Error |`);
        lines.push(`|---|---|---|---|---|`);
        for (const r of failedRuns.slice(0, 10)) {
          const pipeName = r.spec?.pipelineRef?.name || "-";
          const started = r.status?.startTime ? new Date(r.status.startTime).toLocaleString() : "-";
          const errMsg = (r.status?.conditions?.[0]?.message || "").slice(0, 60).replace(/\|/g, "/");
          lines.push(`| ${r.metadata.name} | ${pipeName} | ${r.metadata.namespace} | ${started} | ${errMsg} |`);
        }
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. View run details: \`tkn pipelinerun describe <run-name> -n <ns>\``);
        lines.push(`  2. Check task logs: \`tkn pipelinerun logs <run-name> -n <ns>\``);
        lines.push(`  3. Common causes: Git clone auth failure, image build errors, test failures`);
        lines.push(`  4. Re-run: \`tkn pipeline start <pipeline-name> -n <ns> --use-param-defaults\``);
        lines.push(``);
      }

      // Running pipelines
      const runningRuns = runs.filter((r) => r.status?.conditions?.[0]?.reason === "Running");
      if (runningRuns.length > 0) {
        lines.push(`---`);
        lines.push(`### [INFO] ${runningRuns.length} Currently Running`);
        lines.push(``);
        for (const r of runningRuns.slice(0, 5)) {
          lines.push(`  - **${r.metadata.name}** (${r.spec?.pipelineRef?.name || "?"}) in \`${r.metadata.namespace}\` — started ${r.status?.startTime ? new Date(r.status.startTime).toLocaleString() : "?"}`);
        }
        lines.push(``);
      }

      return { reply: lines.join("\n"), contextKeys: ["slash", "pipelines"] };
    } catch {
      return { reply: "### Tekton Pipelines\n[INFO] Tekton not installed or not accessible.\n\n**To install:**\n  1. Install the OpenShift Pipelines Operator from OperatorHub\n  2. Verify: `oc get pods -n openshift-pipelines`", contextKeys: ["slash", "pipelines"] };
    }
  }

  if (cmd === "vms") {
    const ns = arg || null;
    try {
      const vmPath = ns ? `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines` : "/apis/kubevirt.io/v1/virtualmachines";
      const vmiPath = ns ? `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachineinstances` : "/apis/kubevirt.io/v1/virtualmachineinstances";
      const [vmData, vmiData] = await Promise.all([
        ocpGet(vmPath),
        ocpGet(vmiPath).catch(() => ({ items: [] })),
      ]);
      const items = vmData.items || [];
      const vmis = vmiData.items || [];
      const vmiMap = {};
      for (const v of vmis) { vmiMap[`${v.metadata.namespace}/${v.metadata.name}`] = v; }

      if (items.length === 0) return { reply: `### Virtual Machines${ns ? ` (${ns})` : ""}\n[INFO] No VMs found.\n\n**Getting started:**\n  1. Create a VM from template: \`oc process <template> | oc apply -f -\`\n  2. Or use the OpenShift Console > Virtualization > Create VM`, contextKeys: ["slash", "vms"] };

      const runningVMs = items.filter((v) => v.status?.ready);
      const stoppedVMs = items.filter((v) => !v.status?.ready && !v.spec?.running);
      const failedVMs = items.filter((v) => v.spec?.running && !v.status?.ready);

      const lines = [
        `### Virtual Machines${ns ? ` (${ns})` : ""} — ${items.length}`,
        ``,
        `@@SUMMARY|green:${runningVMs.length} Running|amber:${stoppedVMs.length} Stopped|red:${failedVMs.length} Failed@@`,
        ``,
        `| VM | Namespace | Status | CPU | Memory | OS | IP |`,
        `|---|---|---|---|---|---|---|`,
      ];
      for (const v of items.slice(0, 30)) {
        const running = v.status?.ready;
        const statusTag = running ? "[OK] Running" : v.spec?.running ? "[CRITICAL] Not Ready" : "[INFO] Stopped";
        const cpu = v.spec?.template?.spec?.domain?.cpu?.cores || "?";
        const mem = v.spec?.template?.spec?.domain?.resources?.requests?.memory || "?";
        const vmiKey = `${v.metadata.namespace}/${v.metadata.name}`;
        const vmi = vmiMap[vmiKey];
        const os = v.metadata.labels?.["vm.kubevirt.io/os"] || v.spec?.template?.metadata?.labels?.["vm.kubevirt.io/os"] || "-";
        const ip = vmi?.status?.interfaces?.[0]?.ipAddress || "-";
        lines.push(`| ${v.metadata.name} | ${v.metadata.namespace} | ${statusTag} | ${cpu} | ${mem} | ${os} | ${ip} |`);
      }

      if (failedVMs.length > 0) {
        lines.push(``);
        lines.push(`---`);
        lines.push(`### [CRITICAL] ${failedVMs.length} VM(s) Expected Running But Not Ready`);
        lines.push(``);
        for (const v of failedVMs.slice(0, 10)) {
          const vmiKey = `${v.metadata.namespace}/${v.metadata.name}`;
          const vmi = vmiMap[vmiKey];
          const conds = vmi?.status?.conditions || v.status?.conditions || [];
          const errCond = conds.find((c) => c.status === "False");
          const reason = errCond ? `${errCond.type}: ${errCond.message || errCond.reason || ""}`.slice(0, 100) : "Check VMI status";
          lines.push(`  - **${v.metadata.namespace}/${v.metadata.name}** — ${reason}`);
        }
        lines.push(``);
        lines.push(`**Remediation:**`);
        lines.push(`  1. Check VMI status: \`oc get vmi <vm-name> -n <ns> -o yaml\``);
        lines.push(`  2. Check virt-launcher pod: \`oc logs virt-launcher-<vm-name>-xxxxx -n <ns>\``);
        lines.push(`  3. Restart VM: \`virtctl restart <vm-name> -n <ns>\``);
        lines.push(`  4. Common causes: insufficient node resources, storage issues, network config`);
        lines.push(``);
      }

      if (stoppedVMs.length > 0) {
        lines.push(`---`);
        lines.push(`### [INFO] ${stoppedVMs.length} Stopped VM(s)`);
        lines.push(``);
        for (const v of stoppedVMs.slice(0, 5)) {
          lines.push(`  - **${v.metadata.namespace}/${v.metadata.name}** — Start with: \`virtctl start ${v.metadata.name} -n ${v.metadata.namespace}\``);
        }
        if (stoppedVMs.length > 5) lines.push(`  - *...and ${stoppedVMs.length - 5} more*`);
        lines.push(``);
      }

      return { reply: lines.join("\n"), contextKeys: ["slash", "vms"] };
    } catch {
      return { reply: "### Virtual Machines\n[INFO] KubeVirt / OpenShift Virtualization not installed or not accessible.\n\n**To install:**\n  1. Install the OpenShift Virtualization Operator from OperatorHub\n  2. Create a HyperConverged CR: `oc apply -f hyperconverged.yaml`\n  3. Verify: `oc get pods -n openshift-cnv`", contextKeys: ["slash", "vms"] };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// SSE helper — writes Server-Sent Events to the response stream
// ---------------------------------------------------------------------------
function sseStart(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": ping\n\n");
}
function sseSend(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch {}
}
function sseEnd(res) {
  try {
    res.write("data: [DONE]\n\n");
    res.end();
  } catch {}
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

  // Rate limit (token bucket per-IP; returns true if limited)
  if (enforceRateLimit(req, res)) {
    incCounter("mcp_chat_requests_total", { status: "rate_limited" });
    return;
  }
  incCounter("mcp_chat_requests_total", { status: "accepted" });

  try {
    const body = await readBody(req);
    userMessage = body.message;
    conversationId = body.conversationId || body.chatId || null;

    if (!userMessage) {
      json(res, 400, { error: "Missing 'message' field" });
      return;
    }

    // Slash commands — fast-path for dashboard shortcuts
    const slashReply = await maybeHandleSlashCommand(userMessage, conversationId);
    if (slashReply) {
      if (conversationId) {
        histAddMessage(conversationId, {
          role: "assistant",
          content: slashReply.reply,
          provider: "built-in",
        }).catch(() => {});
      }
      return json(res, 200, {
        reply: slashReply.reply,
        provider: "built-in",
        contextKeys: slashReply.contextKeys || ["slash"],
        cached: false,
        conversationId,
      });
    }

    // Streaming path (SSE) — detected by Accept header or body.stream=true
    const wantsStream =
      body.stream === true ||
      (req.headers.accept || "").includes("text/event-stream");

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
    const isMutating = ["delete", "update", "exec", "run", "create", "start", "stop", "upgrade"].includes(parsed.intent);
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
            if (exec.followUp) {
              reply += `\n\n${exec.followUp}`;
            } else if (exec.action?.status === "executed") {
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
      // Cluster-scoped resources (namespace, project) don't need a namespace.
      const clusterScopedTypes = new Set(["namespace", "project"]);
      if (!actionIntent.namespace && !clusterScopedTypes.has(actionIntent.resourceType)) {
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
        // Resource not found / RBAC denied — return a clear error to the user
        // instead of falling through to the generic analysis path.
        if (/Resource not found|RBAC denied/i.test(err.message)) {
          const reply = `### Cannot ${actionIntent.action} ${actionIntent.resourceType}\n\n[WARNING] ${err.message}`;
          if (conversationId) {
            histAddMessage(conversationId, { role: "assistant", content: reply, provider: "built-in" }).catch(() => {});
          }
          return json(res, 200, {
            reply,
            provider: "built-in",
            contextKeys: ["actionWorkflow", "validationError"],
            cached: false,
            conversationId,
          });
        }
        // Other errors — fall through to default handlers so the user still gets a reply.
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

    // ---- Streaming SSE path ----
    if (wantsStream && llmEnabled(llmOpts)) {
      sseStart(res);
      try {
        const { result: sseTraced, trace: sseTrace } = await runWithTrace(async () => {
          let context = await gatherClusterContext(userMessage);
          const contextStr = JSON.stringify(context, null, 2);
          const userContent = `${userMessage}\n\n--- Live Cluster Data ---\n${contextStr}`;
          let fullText = "";
          await callLLMStream({
            messages: [{ role: "user", content: userContent }],
            system: SYSTEM_PROMPT,
            maxTokens: 2000,
            temperature: 0.3,
            ...llmOpts,
            onDelta: (chunk) => {
              fullText += chunk;
              sseSend(res, { delta: chunk });
            },
          });
          return { context, fullText };
        });
        const { context, fullText } = sseTraced;
        // Append extra blocks as final events
        const correlationsBlock = renderCorrelationsMarkdown(context?.correlations || []);
        if (correlationsBlock) sseSend(res, { delta: "\n" + correlationsBlock });
        const topCause = context?.correlations?.[0];
        if (topCause?.likelyCause) {
          const pb = suggestPlaybook(topCause.likelyCause, { pod: topCause.pod, namespace: topCause.namespace });
          if (pb) sseSend(res, { delta: "\n" + renderPlaybookMarkdown(pb) });
        }
        const traceMd = renderTraceMarkdown(sseTrace);
        if (traceMd) sseSend(res, { delta: "\n" + traceMd });
        sseSend(res, { done: true, provider: activeProvider, conversationId });
        sseEnd(res);
        if (conversationId) {
          histAddMessage(conversationId, { role: "assistant", content: sseTraced.fullText, provider: activeProvider }).catch(() => {});
        }
        observeHistogram("mcp_chat_latency_seconds", { provider: activeProvider }, (Date.now() - startedAt) / 1000);
      } catch (sseErr) {
        sseSend(res, { error: sseErr.message });
        sseEnd(res);
      }
      return;
    }

    // 1. Gather cluster context + call LLM inside a trace scope so that every
    //    ocpFetch made during this request is captured for explainability.
    const { result: traced, trace } = await runWithTrace(async () => {
      const ctxKey = `ctx:${cacheKeyForChat(userMessage, "ctx")}`;
      let context = await cacheGet(ctxKey);
      if (!context) {
        context = await gatherClusterContext(userMessage);
        cacheSet(ctxKey, context, CONTEXT_CACHE_TTL).catch(() => {});
      }

      // Optional: route "diagnose" / "why" / "what's wrong" queries through
      // the agent loop when an LLM is configured.
      const wantsDiagnose =
        llmEnabled(llmOpts) &&
        /\b(diagnose|root\s*cause|why\s+is|what'?s\s+wrong|troubleshoot)\b/i.test(userMessage);
      let replyText;
      if (wantsDiagnose) {
        try {
          const agentRes = await runAgent({
            userMessage,
            contextHint: {
              problemPods: (context.problemPods || []).slice(0, 5),
              correlations: context.correlations || [],
            },
            llmOpts,
          });
          replyText = agentRes?.text || (await callLLMWithContext(userMessage, context, llmOpts));
        } catch (e) {
          console.warn("[chat-api] agent loop failed, falling back:", e.message);
          replyText = await callLLMWithContext(userMessage, context, llmOpts);
        }
      } else {
        replyText = await callLLMWithContext(userMessage, context, llmOpts);
      }
      return { context, replyText };
    });
    let { context, replyText: reply } = traced;
    intentsForLog = Array.isArray(context?.intents) ? context.intents : Object.keys(context || {});

    // Append root-cause correlations + playbook + trace for explainability.
    const correlationsBlock = renderCorrelationsMarkdown(context?.correlations || []);
    if (correlationsBlock) reply += "\n" + correlationsBlock;

    const topCause = context?.correlations?.[0];
    if (topCause?.likelyCause) {
      const pb = suggestPlaybook(topCause.likelyCause, {
        pod: topCause.pod,
        namespace: topCause.namespace,
      });
      if (pb) reply += "\n" + renderPlaybookMarkdown(pb);
    }

    const traceMd = renderTraceMarkdown(trace);
    if (traceMd) reply += "\n" + traceMd;

    const payload = {
      reply,
      provider: activeProvider,
      contextKeys: Object.keys(context || {}),
      correlations: context?.correlations || [],
      trace: trace.slice(0, 20),
    };
    cacheSet(cacheKey, payload, CHAT_CACHE_TTL).catch(() => {});
    if (conversationId) {
      histAddMessage(conversationId, {
        role: "assistant",
        content: reply,
        provider: activeProvider,
      }).catch(() => {});
    }

    observeHistogram("mcp_chat_latency_seconds", { provider: activeProvider }, (Date.now() - startedAt) / 1000);

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
