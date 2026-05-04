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
  setRemoteCluster,
  clearRemoteCluster,
} from "../utils/openshift-client.js";
import { getConnectedAgents } from "../index.js";
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
import { runOrchestrator } from "./mcp-orchestrator.js";
import { getConnectionCount } from "./mcp-hub.js";
import { findSimilar as kbFindSimilar, buildKBContext, recordResolution } from "./knowledge-base.js";
import {
  buildSignature as leBuildSignature,
  findSimilarIncidents as leFindSimilarIncidents,
  buildLearningContext as leBuildLearningContext,
  getTeamPlaybook as leGetTeamPlaybook,
  getIncidentStats as leGetIncidentStats,
} from "./learning-engine.js";
import { maybeEnhance as nluEnhanceWithLLM } from "./nlu-llm.js";
import { summarizeIfNeeded } from "./summarizer.js";
import { suggestPlaybook, renderPlaybookMarkdown } from "./playbooks.js";
import { findResource } from "./resource-index.js";
import { incCounter, observeHistogram } from "./metrics.js";
import { enforce as enforceRateLimit } from "./rate-limit.js";
import { runPreflightChecks, formatPreflightReport } from "../tools/upgrade-preflight.js";

// Map an NLU intent to the legacy "operation" string used by the response
// handlers below, plus a few normalizations.
// Common English words the NLU sometimes mistakes for resource/namespace names
// when the user pastes a tool description ("a specific pod in the specified
// namespace"). Reject them so we don't fire bogus 404 lookups.
const NLU_BAD_NAMES = new Set([
  "specific", "specified", "all", "some", "any", "each", "every",
  "the", "this", "that", "those", "these", "an",
  "which", "what", "where", "when", "how", "why", "who",
  "here", "there", "now", "then", "your", "their", "our",
  "current", "given", "selected", "chosen", "available",
  "running", "pending", "failed", "completed",
  "name", "names", "value", "values",
]);
function _sanitizeNluName(name) {
  if (!name) return null;
  return NLU_BAD_NAMES.has(String(name).toLowerCase()) ? null : name;
}

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
    resourceName: _sanitizeNluName(p.name),
    namespace: _sanitizeNluName(p.namespace),
    filter: p.filter,
    allNs: p.allNs,
    scope: p.scope,
    options: p.options,
    confidence: p.confidence,
    intent: p.intent,
  };
}

// ---------------------------------------------------------------------------
// Kubernetes resource quantity helpers — convert raw metrics API values
// (nanocores, Ki) to human-readable format (millicores, Mi/Gi).
// ---------------------------------------------------------------------------
function parseCpuNano(v) {
  if (!v) return 0;
  const s = String(v);
  if (s.endsWith("n")) return parseInt(s, 10);
  if (s.endsWith("u")) return parseInt(s, 10) * 1000;
  if (s.endsWith("m")) return parseInt(s, 10) * 1_000_000;
  return parseFloat(s) * 1_000_000_000;
}
function fmtCpu(v) {
  const nano = parseCpuNano(v);
  if (nano === 0) return "0m";
  const milli = nano / 1_000_000;
  if (milli >= 1000) return (milli / 1000).toFixed(1) + " cores";
  if (milli >= 1) return Math.round(milli) + "m";
  return "<1m";
}
function parseMemBytes(v) {
  if (!v) return 0;
  const s = String(v);
  if (s.endsWith("Ki")) return parseInt(s, 10) * 1024;
  if (s.endsWith("Mi")) return parseInt(s, 10) * 1024 * 1024;
  if (s.endsWith("Gi")) return parseInt(s, 10) * 1024 * 1024 * 1024;
  if (s.endsWith("Ti")) return parseInt(s, 10) * 1024 * 1024 * 1024 * 1024;
  if (s.endsWith("k") || s.endsWith("K")) return parseInt(s, 10) * 1000;
  if (s.endsWith("M")) return parseInt(s, 10) * 1_000_000;
  if (s.endsWith("G")) return parseInt(s, 10) * 1_000_000_000;
  return parseFloat(s);
}
function fmtMem(v) {
  const bytes = parseMemBytes(v);
  if (bytes === 0) return "0Mi";
  const mi = bytes / (1024 * 1024);
  if (mi >= 1024) return (mi / 1024).toFixed(1) + "Gi";
  if (mi >= 1) return Math.round(mi) + "Mi";
  return "<1Mi";
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
    "**Slash commands**",
    "  - `/security` — full security & compliance audit with AI remediation",
    "  - `/recommendations` — cluster optimization report (right-sizing, capacity)",
    "  - `/health` — cluster health snapshot",
    "  - `/dr` — disaster recovery readiness assessment",
    "  - `/gitops` — ArgoCD applications status",
    "  - `/playbook` — your team's learned patterns from past resolutions",
    "  - `/audit` — recent executed actions audit trail",
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
  const path = `/api/v1/namespaces/${namespace}/pods/${podName}/log?tailLines=${tailLines}`;
  try {
    return await ocpFetch(path, { headers: { Accept: "text/plain" } });
  } catch (err) {
    if (err.message && err.message.includes("406")) {
      return await ocpFetch(path, { headers: { Accept: "*/*" } });
    }
    throw err;
  }
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
async function handleDirectCommand(message, preParsed, opts = {}) {
  const cmd = preParsed || parseCommand(message);
  const lower = message.toLowerCase().trim();
  // When an LLM is available, return null on "missing required field" cases
  // so the chat falls through to the LLM with full conversation context —
  // the LLM can resolve ambiguity from the prior turns.
  const llmAvailable = !!opts.llmAvailable;

  // -----------------------------------------------------------------------
  // UPGRADE COMPARISON — "difference between current and upgrade version"
  // Handles natural-language queries about version differences, available
  // upgrades, and what changes between versions.
  // -----------------------------------------------------------------------
  const UPGRADE_COMPARE_PAT = /\b(?:differ(?:ence|ent)|compare|comparison|what(?:'?s)?\s+(?:new|changed)|between.*(?:current|upgrade|version)|upgrade.*(?:version|available|path|option)|available.*upgrade|what.*upgrade|which.*version|next.*version|latest.*version|can\s+(?:i|we)\s+upgrade)\b/i;
  if (UPGRADE_COMPARE_PAT.test(lower) && /\b(?:upgrade|version|cluster|upgrad)\b/i.test(lower)) {
    try {
      const [cvResp, opsResp, nodesResp] = await Promise.allSettled([
        ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
        ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
        ocpGet("/api/v1/nodes"),
      ]);

      const cv = cvResp.status === "fulfilled" ? cvResp.value : null;
      if (!cv) throw new Error("Cannot read ClusterVersion");

      const currentVersion = cv.status?.desired?.version || "unknown";
      const channel = cv.spec?.channel || "unknown";
      const clusterID = cv.spec?.clusterID || "";
      const conditions = cv.status?.conditions || [];
      const updates = cv.status?.availableUpdates || [];
      const history = cv.status?.history || [];
      const progressing = conditions.find(c => c.type === "Progressing");
      const operators = opsResp.status === "fulfilled" ? (opsResp.value.items || []) : [];
      const nodes = nodesResp.status === "fulfilled" ? (nodesResp.value.items || []) : [];
      const degradedOps = operators.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));

      const parts = [];
      parts.push(`### Cluster Upgrade Analysis`);
      parts.push(``);
      parts.push(`| Property | Value |`);
      parts.push(`|----------|-------|`);
      parts.push(`| Current Version | \`${currentVersion}\` |`);
      parts.push(`| Update Channel | \`${channel}\` |`);
      parts.push(`| Cluster ID | \`${clusterID || "N/A"}\` |`);
      parts.push(`| Nodes | ${nodes.length} |`);
      parts.push(`| Cluster Operators | ${operators.length} (${degradedOps.length} degraded) |`);
      if (progressing?.status === "True") {
        parts.push(`| Upgrade Status | **In Progress** — ${progressing.message || ""} |`);
      } else {
        parts.push(`| Upgrade Status | Idle |`);
      }
      parts.push(``);

      if (updates.length > 0) {
        const sorted = [...updates].sort((a, b) => (b.version || "").localeCompare(a.version || ""));
        const latestMinor = {};
        for (const u of sorted) {
          const [, maj, min] = (u.version || "").match(/^(\d+)\.(\d+)/) || [];
          const key = `${maj}.${min}`;
          if (!latestMinor[key]) latestMinor[key] = u;
        }

        parts.push(`### Available Upgrade Paths (${updates.length} versions)`);
        parts.push(``);

        // Group by minor version
        const minorGroups = {};
        for (const u of sorted) {
          const [, maj, min] = (u.version || "").match(/^(\d+)\.(\d+)/) || [];
          const key = `${maj}.${min}`;
          if (!minorGroups[key]) minorGroups[key] = [];
          minorGroups[key].push(u);
        }

        for (const [minor, versions] of Object.entries(minorGroups)) {
          const isSameMinor = currentVersion.startsWith(minor + ".");
          const upgradeType = isSameMinor ? "Z-stream (patch)" : "Minor version upgrade";
          parts.push(`#### ${minor}.x — ${upgradeType}`);
          parts.push(`| Version | Type | Vs Current (${currentVersion}) |`);
          parts.push(`|---------|------|------|`);
          for (const v of versions.slice(0, 8)) {
            const [, , , curPatch] = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0];
            const [, , , vPatch] = (v.version || "").match(/^(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0];
            const diff = isSameMinor ? `+${Number(vPatch) - Number(curPatch)} patches` : "Minor upgrade";
            parts.push(`| \`${v.version}\` | ${upgradeType} | ${diff} |`);
          }
          if (versions.length > 8) parts.push(`| ... | | +${versions.length - 8} more |`);
          parts.push(``);
        }

        // Recommendation
        const recommended = sorted[0];
        const recSameMinor = recommended.version.startsWith(currentVersion.replace(/\.\d+$/, "."));
        parts.push(`### Recommendation`);
        parts.push(``);
        if (recSameMinor) {
          parts.push(`The latest available **patch upgrade** is \`${recommended.version}\`. Patch upgrades include security fixes, bug fixes, and minor enhancements within the same minor release.`);
        } else {
          const sameMinorUpdates = sorted.filter(u => u.version.startsWith(currentVersion.replace(/\.\d+$/, ".")));
          if (sameMinorUpdates.length > 0) {
            parts.push(`- **Patch upgrade** (recommended): \`${sameMinorUpdates[0].version}\` — same minor, lower risk`);
            parts.push(`- **Minor upgrade** (available): \`${recommended.version}\` — new features, higher risk`);
          } else {
            parts.push(`The next available upgrade is \`${recommended.version}\` (minor version change).`);
          }
        }
        parts.push(``);

        if (degradedOps.length > 0) {
          parts.push(`> **Warning:** ${degradedOps.length} operator(s) are degraded: ${degradedOps.map(o => o.metadata.name).join(", ")}. Resolve before upgrading.`);
          parts.push(``);
        }

        parts.push(`### Upgrade Commands`);
        parts.push(`\`\`\`sh`);
        parts.push(`# Check available upgrades`);
        parts.push(`oc adm upgrade`);
        parts.push(``);
        parts.push(`# Upgrade to a specific version`);
        parts.push(`oc adm upgrade --to=${recommended.version}`);
        parts.push(``);
        parts.push(`# Run pre-upgrade assessment first`);
        parts.push(`# Ask me: "precheck upgrade to ${recommended.version}"`);
        parts.push(`\`\`\``);

        // Recent upgrade history
        if (history.length > 1) {
          parts.push(``);
          parts.push(`### Recent Upgrade History`);
          parts.push(`| Version | State | Completed |`);
          parts.push(`|---------|-------|-----------|`);
          for (const h of history.slice(0, 5)) {
            parts.push(`| \`${h.version}\` | ${h.state} | ${h.completionTime ? new Date(h.completionTime).toLocaleString() : "—"} |`);
          }
        }
      } else {
        parts.push(`### No Available Upgrades`);
        parts.push(`Your cluster (\`${currentVersion}\`) is up to date on channel \`${channel}\`.`);
        parts.push(``);
        parts.push(`To check other channels:`);
        parts.push(`\`\`\`sh`);
        parts.push(`oc adm upgrade channel stable-4.20`);
        parts.push(`oc adm upgrade`);
        parts.push(`\`\`\``);
      }

      return parts.join("\n");
    } catch (err) {
      return `### Cluster Upgrade Analysis\n\n[CRITICAL] Failed to fetch cluster version data: ${err.message}`;
    }
  }

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
    // Auto-discover namespace when pod name is given but namespace isn't.
    // This handles the common flow: user lists pods in a namespace → clicks
    // a pod name → asks for logs without repeating the namespace.
    if (cmd.resourceName && !cmd.namespace) {
      try {
        const allPods = await ocpGet(`/api/v1/pods?fieldSelector=metadata.name=${encodeURIComponent(cmd.resourceName)}`);
        const found = (allPods.items || []);
        if (found.length === 1) {
          cmd.namespace = found[0].metadata.namespace;
        } else if (found.length > 1) {
          const nsList = found.map(p => `\`${p.metadata.namespace}\``).join(", ");
          parts.push(`### Pod Logs`);
          parts.push(`[WARNING] Pod \`${cmd.resourceName}\` exists in multiple namespaces: ${nsList}`);
          parts.push(`\nPlease specify: "show logs for ${cmd.resourceName} in namespace <ns>"`);
          return parts.join("\n");
        }
      } catch { /* field-selector not supported on all clusters — fall through */ }
    }
    if (!cmd.resourceName) {
      if (llmAvailable) return null;
      parts.push(`### Pod Logs`);
      parts.push(`[WARNING] Please specify the pod name.`);
      parts.push(`\n**Example:** "show logs for my-pod in namespace my-ns"`);
      return parts.join("\n");
    }
    if (!cmd.namespace) {
      parts.push(`### Pod Logs`);
      parts.push(`[WARNING] Could not determine the namespace for \`${cmd.resourceName}\`.`);
      parts.push(`\nPlease specify: "show logs for ${cmd.resourceName} in namespace <ns>"`);
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
      if (llmAvailable) return null;
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
    // Reject common English words that the parser sometimes mistakes for resource
    // names ("specific", "specified", "all", etc.) — these come from the user
    // pasting a tool description like "top gets metrics for a specific pod".
    const englishWordRe = /^(specific|specified|all|some|any|each|every|the|this|that|those|these|a|an|which|what|where|when|how|why|who|here|there|now|then)$/i;
    if (cmd.resourceName && englishWordRe.test(cmd.resourceName)) {
      if (llmAvailable) return null;
      parts.push(`### Top — Resource Usage`);
      parts.push(`[WARNING] I couldn't tell which pod or namespace you meant.`);
      parts.push(`\n**Example:** \`top pods\`, \`top pod my-pod in namespace my-ns\`, or \`top nodes\``);
      return parts.join("\n");
    }
    if (cmd.namespace && englishWordRe.test(cmd.namespace)) {
      if (llmAvailable) return null;
      parts.push(`### Top — Resource Usage`);
      parts.push(`[WARNING] I couldn't tell which namespace you meant.`);
      parts.push(`\n**Example:** \`top pods in default\` or \`top nodes\``);
      return parts.join("\n");
    }

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
        parts.push(`| Node | CPU | Memory |`);
        parts.push(`| --- | --- | --- |`);
        items.forEach((n) => {
          const cpu = fmtCpu(n.usage?.cpu);
          const mem = fmtMem(n.usage?.memory);
          parts.push(`| **${n.metadata.name}** | ${cpu} | ${mem} |`);
        });
      } else {
        const label = cmd.namespace ? `in \`${cmd.namespace}\`` : "(all namespaces)";
        parts.push(`### Pod Resource Usage ${label}`);
        // Compute totals per pod for sorting
        const podMetrics = items.slice(0, 30).map((p) => {
          const containers = (p.containers || []).map((c) => ({
            name: c.name,
            cpu: fmtCpu(c.usage?.cpu),
            mem: fmtMem(c.usage?.memory),
            cpuRaw: parseCpuNano(c.usage?.cpu),
            memRaw: parseMemBytes(c.usage?.memory),
          }));
          const totalCpu = containers.reduce((s, c) => s + c.cpuRaw, 0);
          const totalMem = containers.reduce((s, c) => s + c.memRaw, 0);
          return { pod: p, containers, totalCpu, totalMem, totalCpuFmt: fmtCpu(String(totalCpu) + "n"), totalMemFmt: fmtMem(String(Math.round(totalMem / 1024)) + "Ki") };
        });
        podMetrics.sort((a, b) => b.totalCpu - a.totalCpu);
        parts.push(`| Pod | Namespace | CPU | Memory | Containers |`);
        parts.push(`| --- | --- | --- | --- | --- |`);
        podMetrics.forEach(({ pod: p, containers, totalCpuFmt, totalMemFmt }) => {
          const cCount = containers.length;
          const cDetail = cCount > 1 ? `${cCount} containers` : containers[0]?.name || "1";
          parts.push(`| \`${p.metadata.name}\` | ${p.metadata.namespace} | ${totalCpuFmt} | ${totalMemFmt} | ${cDetail} |`);
        });
        if (items.length > 30) parts.push(`\n... and ${items.length - 30} more pods`);
      }
    } catch (err) {
      // 404 NotFound usually means the parser misidentified a word as the pod
      // or namespace name. When an LLM is available, let it handle the query
      // instead of returning a misleading error.
      const is404 = /OCP API 404|NotFound|not found/i.test(err.message);
      if (is404 && llmAvailable) return null;
      if (is404) {
        parts.push(`### Top — Resource Usage`);
        parts.push(`[WARNING] Pod${cmd.resourceName ? ` \`${cmd.resourceName}\`` : ""}${cmd.namespace ? ` in namespace \`${cmd.namespace}\`` : ""} not found.`);
        parts.push(`\n**Example:** \`top pods\`, \`top pod my-pod in namespace my-ns\`, or \`top nodes\``);
      } else {
        parts.push(`### Metrics Error`);
        parts.push(`[WARNING] ${err.message}`);
        parts.push(`\nMetrics server may not be installed. Install with:`);
        parts.push("```" + `oc apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml` + "```");
      }
    }
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // DELETE — delete a resource
  // -----------------------------------------------------------------------
  if (cmd.operation === "delete") {
    if (!cmd.resourceName) {
      if (llmAvailable) return null;
      parts.push(`### Delete ${cmd.resourceType}`);
      parts.push(`[WARNING] Please specify the resource name to delete.`);
      parts.push(`\n**Example:** "delete pod my-pod in namespace my-ns"`);
      return parts.join("\n");
    }
    if (resInfo.namespaced && !cmd.namespace) {
      if (llmAvailable) return null;
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
    // Auto-discover namespace when resource name is given but namespace isn't
    if (resInfo.namespaced && !cmd.namespace && cmd.resourceName) {
      try {
        const apiPath = `${resInfo.api}/${resInfo.resource}?fieldSelector=metadata.name=${encodeURIComponent(cmd.resourceName)}`;
        const search = await ocpGet(apiPath);
        const found = (search.items || []);
        if (found.length === 1) {
          cmd.namespace = found[0].metadata.namespace;
        } else if (found.length > 1) {
          const nsList = found.map(r => `\`${r.metadata.namespace}\``).join(", ");
          parts.push(`### ${cmd.resourceType}: \`${cmd.resourceName}\``);
          parts.push(`Found in multiple namespaces: ${nsList}`);
          parts.push(`\nPlease specify: "describe ${cmd.resourceType} ${cmd.resourceName} in namespace <ns>"`);
          return parts.join("\n");
        }
      } catch { /* field-selector not supported — fall through */ }
    }
    if (resInfo.namespaced && !cmd.namespace) {
      parts.push(`### ${cmd.resourceType}: \`${cmd.resourceName}\``);
      parts.push(`[WARNING] Could not determine the namespace for \`${cmd.resourceName}\`.`);
      parts.push(`\nPlease specify: "describe ${cmd.resourceType} ${cmd.resourceName} in namespace <ns>"`);
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
      if (llmAvailable) return null;
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
      // If user is asking for a precheck/preflight, return null so the
      // dedicated preflight handler (earlier in the main flow) handles it.
      if (/\bpre-?(?:check|flight|upgrade)|assessment|readiness|compatib/i.test(lower)) {
        return null;
      }

      try {
        const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
        const currentVersion = cv.status?.desired?.version || "unknown";
        const channel = cv.spec?.channel || "unknown";
        const conditions = cv.status?.conditions || [];
        const available = conditions.find(c => c.type === "Available");
        const progressing = conditions.find(c => c.type === "Progressing");
        const updates = cv.status?.availableUpdates || [];

        // Extract target version from user message ("upgrade to 4.19.23")
        const targetMatch = lower.match(/(?:to|version)\s+v?(\d+\.\d+\.\d+)/);
        const requestedVersion = targetMatch ? targetMatch[1] : null;

        // Sort updates descending
        const sorted = [...updates].sort((a, b) => {
          const pa = (a.version || "").split(".").map(Number);
          const pb = (b.version || "").split(".").map(Number);
          for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); }
          return 0;
        });

        if (requestedVersion) {
          // User asked for a specific version — provide targeted response
          const matchedUpdate = sorted.find(u => u.version === requestedVersion);
          const curParts = currentVersion.split(".").map(Number);
          const tgtParts = requestedVersion.split(".").map(Number);
          const isZStream = curParts[0] === tgtParts[0] && curParts[1] === tgtParts[1];
          const upgradeType = isZStream ? "Z-stream (patch)" : "Minor version";

          parts.push(`### Upgrade Analysis: ${currentVersion} → ${requestedVersion}`);
          parts.push(`**Current version:** ${currentVersion}`);
          parts.push(`**Target version:** ${requestedVersion}`);
          parts.push(`**Channel:** ${channel}`);
          parts.push(`**Upgrade type:** ${upgradeType}`);
          parts.push("");

          if (matchedUpdate) {
            parts.push(`[OK] **Version ${requestedVersion} is available** in the current channel.`);
            parts.push("");

            // Check how many versions between current and target
            const versionsSkipped = sorted.filter(u => {
              const up = u.version.split(".").map(Number);
              return up[0] === curParts[0] && up[1] === curParts[1] && up[2] > curParts[2] && up[2] < tgtParts[2];
            });
            if (versionsSkipped.length > 0) {
              parts.push(`> Note: This skips ${versionsSkipped.length} intermediate version(s): ${versionsSkipped.map(v => v.version).join(", ")}. OpenShift supports direct Z-stream upgrades within a channel.`);
              parts.push("");
            }

            // Show latest available for comparison
            if (sorted.length > 0 && sorted[0].version !== requestedVersion) {
              parts.push(`> Latest available: **${sorted[0].version}**. You requested ${requestedVersion}.`);
              parts.push("");
            }

            parts.push(`**To upgrade:**`);
            parts.push("```" + `oc adm upgrade --to=${requestedVersion}` + "```");
            parts.push("");
            parts.push(`**Recommended:** Run a pre-upgrade assessment first:`);
            parts.push(`> Ask me: *"precheck upgrade to ${requestedVersion}"*`);
          } else {
            parts.push(`[CRITICAL] **Version ${requestedVersion} is NOT available** in channel \`${channel}\`.`);
            parts.push("");
            if (sorted.length > 0) {
              parts.push(`Available versions:`);
              sorted.slice(0, 5).forEach(u => {
                parts.push(`  - **${u.version}**`);
              });
              parts.push("");
              parts.push(`Did you mean **${sorted[0].version}** (latest) or check if ${requestedVersion} is in a different channel?`);
            }
          }
        } else {
          // No specific version requested — show overview with analysis
          parts.push(`### Cluster Upgrade Status`);
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

          if (sorted.length > 0) {
            const latest = sorted[0];
            const latestParts = latest.version.split(".").map(Number);
            const isMinor = curParts[0] !== latestParts[0] || curParts[1] !== latestParts[1];

            parts.push("");
            parts.push(`**Available updates (${sorted.length}):**`);

            // Group by minor version
            const groups = {};
            sorted.forEach(u => {
              const mm = u.version.split(".").slice(0, 2).join(".");
              if (!groups[mm]) groups[mm] = [];
              groups[mm].push(u);
            });

            Object.keys(groups).sort().reverse().forEach(mm => {
              const vers = groups[mm];
              parts.push(`  **${mm}.x:** ${vers.map(v => v.version).join(", ")}`);
            });

            parts.push("");
            parts.push(`**Recommendation:** Upgrade to **${latest.version}** (latest ${isMinor ? "minor" : "patch"}).`);
            parts.push("```" + `oc adm upgrade --to=${latest.version}` + "```");
            parts.push("");
            parts.push(`Run a pre-upgrade assessment first:`);
            parts.push(`> Ask me: *"precheck upgrade to ${latest.version}"*`);
          } else {
            parts.push(`\n[OK] Cluster is up to date. No upgrades available in channel \`${channel}\`.`);
          }
        }
      } catch (err) {
        parts.push(`### Cluster Upgrade Error`);
        parts.push(`[CRITICAL] Failed to fetch cluster version data: ${err.message}`);
      }
      return parts.join("\n");
    }
  }

  return null; // Not a recognized direct command
}

// ---------------------------------------------------------------------------
// List resources — handles "list/show X" queries
// ---------------------------------------------------------------------------
async function handleListCommand(message, preParsed, opts = {}) {
  const lower = message.toLowerCase().trim();
  const cmd = preParsed || parseCommand(message);
  const llmAvailable = !!opts.llmAvailable;

  // Must have a resource type and a list/get-style intent.
  if (!cmd.resourceType) return null;
  if (!["list", "get"].includes(cmd.operation)) return null;
  // When the user wants a specific resource (describe/get) and we have an
  // LLM available, return null so the LLM can gather richer context (events,
  // logs, related resources) instead of a generic list.
  if (llmAvailable && cmd.operation === "get" && cmd.resourceName) return null;
  // Issue/health questions go through the intent-driven analysis path
  // (gatherClusterContext) — but only when there's no explicit list verb,
  // so "list crashloopbackoff pods" still returns a focused list.
  if (cmd.filter && !["list", "get"].includes(cmd.operation)) return null;
  // Diagnostic / analytical questions should go to the LLM, not be
  // handled as a simple resource listing.
  if (lower.match(/\bwhy\b|\bhealth\b|\bdiagnos|\bwhat.*wrong\b|\boverview\b|\btroubleshoot|\banalyz|\banalyse|\binvestigat|\bdebug|\breason|\bcause|\bexplain\b|\bpending\s+state|\bfailing\b|\broot\s+cause/)) return null;

  const resInfo = RESOURCE_MAP[cmd.resourceType];
  if (!resInfo) return null;

  // Special handling for projects
  if (cmd.resourceType === "project") {
    try {
      const data = await ocpGet("/apis/project.openshift.io/v1/projects");
      const items = data.items || [];
      const parts = [`### OpenShift Projects (${items.length})`];
      parts.push(`| Status | Project | Display Name | Phase |`);
      parts.push(`| --- | --- | --- | --- |`);
      items.forEach((p) => {
        const displayName = p.metadata?.annotations?.["openshift.io/display-name"] || "";
        const status = p.status?.phase || "Active";
        const icon = status === "Active" ? "[OK]" : "[WARNING]";
        parts.push(`| ${icon} | **${p.metadata.name}** | ${displayName || "—"} | ${status} |`);
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
      parts.push(`| Type | Reason | Resource | Namespace | Message | Count | Last Seen |`);
      parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
      items.forEach((e) => {
        const icon = e.type === "Warning" ? "[WARNING]" : "[OK]";
        const age = e.lastTimestamp ? new Date(e.lastTimestamp).toLocaleString() : "—";
        const msg = (e.message || "").substring(0, 80).replace(/\|/g, "/");
        parts.push(`| ${icon} | **${e.reason}** | ${e.involvedObject.kind}/${e.involvedObject.name} | ${e.metadata.namespace} | ${msg} | ${e.count > 1 ? `x${e.count}` : "1"} | ${age} |`);
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

    // Resource-specific formatting — table output
    if (cmd.resourceType === "pod" || cmd.resourceType === "pods") {
      parts.push(`| Status | Pod | Namespace | Phase | Restarts |`);
      parts.push(`| --- | --- | --- | --- | --- |`);
      items.slice(0, 40).forEach((p) => {
        const phase = p.status?.phase || "Unknown";
        const restarts = (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
        const icon = phase === "Running" ? "[OK]" : phase === "Succeeded" ? "[OK]" : "[CRITICAL]";
        parts.push(`| ${icon} | \`${p.metadata.name}\` | ${p.metadata.namespace} | ${phase} | ${restarts} |`);
      });
    } else if (["deployment", "deployments", "deploy"].includes(cmd.resourceType)) {
      parts.push(`| Status | Deployment | Namespace | Ready |`);
      parts.push(`| --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((d) => {
        const ready = d.status?.readyReplicas ?? 0;
        const desired = d.spec?.replicas ?? 0;
        const icon = ready === desired ? "[OK]" : "[CRITICAL]";
        parts.push(`| ${icon} | **${d.metadata.name}** | ${d.metadata.namespace} | ${ready}/${desired} |`);
      });
    } else if (["service", "services", "svc"].includes(cmd.resourceType)) {
      parts.push(`| Service | Namespace | Type | Cluster IP | Ports |`);
      parts.push(`| --- | --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((s) => {
        const ports = (s.spec?.ports || []).map((p) => `${p.port}/${p.protocol}`).join(", ");
        parts.push(`| **${s.metadata.name}** | ${s.metadata.namespace} | ${s.spec?.type} | ${s.spec?.clusterIP} | ${ports} |`);
      });
    } else if (["node", "nodes"].includes(cmd.resourceType)) {
      parts.push(`| Status | Node | Roles | CPU | Memory |`);
      parts.push(`| --- | --- | --- | --- | --- |`);
      items.forEach((n) => {
        const ready = (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True");
        const roles = Object.keys(n.metadata?.labels || {}).filter(l => l.startsWith("node-role.kubernetes.io/")).map(l => l.split("/")[1]);
        const icon = ready ? "[OK]" : "[CRITICAL]";
        parts.push(`| ${icon} | **${n.metadata.name}** | ${roles.join(", ") || "worker"} | ${n.status?.capacity?.cpu} | ${n.status?.capacity?.memory} |`);
      });
    } else if (["namespace", "namespaces", "ns"].includes(cmd.resourceType)) {
      parts.push(`| Status | Namespace | Phase |`);
      parts.push(`| --- | --- | --- |`);
      items.forEach((ns) => {
        const icon = ns.status?.phase === "Active" ? "[OK]" : "[WARNING]";
        parts.push(`| ${icon} | **${ns.metadata.name}** | ${ns.status?.phase} |`);
      });
    } else if (["route", "routes"].includes(cmd.resourceType)) {
      parts.push(`| Route | Namespace | Host | Target |`);
      parts.push(`| --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((r) => {
        parts.push(`| **${r.metadata.name}** | ${r.metadata.namespace} | ${r.spec?.host || "?"} | ${r.spec?.to?.name || "?"} |`);
      });
    } else if (["configmap", "configmaps", "cm"].includes(cmd.resourceType)) {
      parts.push(`| ConfigMap | Namespace | Keys |`);
      parts.push(`| --- | --- | --- |`);
      items.slice(0, 30).forEach((c) => {
        const keys = Object.keys(c.data || {}).length;
        parts.push(`| **${c.metadata.name}** | ${c.metadata.namespace} | ${keys} |`);
      });
    } else if (["secret", "secrets"].includes(cmd.resourceType)) {
      parts.push(`| Secret | Namespace | Type | Keys |`);
      parts.push(`| --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((s) => {
        const keys = Object.keys(s.data || {}).length;
        parts.push(`| **${s.metadata.name}** | ${s.metadata.namespace} | ${s.type} | ${keys} |`);
      });
    } else if (["pvc", "pvcs", "persistentvolumeclaim"].includes(cmd.resourceType)) {
      parts.push(`| Status | PVC | Namespace | Phase | Storage | Class |`);
      parts.push(`| --- | --- | --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((p) => {
        const icon = p.status?.phase === "Bound" ? "[OK]" : "[WARNING]";
        parts.push(`| ${icon} | **${p.metadata.name}** | ${p.metadata.namespace} | ${p.status?.phase} | ${p.spec?.resources?.requests?.storage || "?"} | ${p.spec?.storageClassName || "default"} |`);
      });
    } else if (["virtualmachine", "vm", "vms", "virtualmachines"].includes(cmd.resourceType)) {
      parts.push(`| Status | VM | Namespace | State | CPU | Memory |`);
      parts.push(`| --- | --- | --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((v) => {
        const ready = v.status?.ready;
        const printable = v.status?.printableStatus || (ready ? "Running" : "Stopped");
        const icon = ready ? "[OK]" : "[WARNING]";
        const cpu = v.spec?.template?.spec?.domain?.cpu?.cores || "?";
        const mem = v.spec?.template?.spec?.domain?.resources?.requests?.memory || "?";
        parts.push(`| ${icon} | **${v.metadata.name}** | ${v.metadata.namespace} | ${printable} | ${cpu} | ${mem} |`);
      });
    } else if (["virtualmachineinstance", "vmi", "vmis"].includes(cmd.resourceType)) {
      parts.push(`| Status | VMI | Namespace | Phase | Node | IP |`);
      parts.push(`| --- | --- | --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((v) => {
        const phase = v.status?.phase || "Unknown";
        const icon = phase === "Running" ? "[OK]" : "[WARNING]";
        const node = v.status?.nodeName || "unassigned";
        const ip = (v.status?.interfaces || [])[0]?.ipAddress || "none";
        parts.push(`| ${icon} | **${v.metadata.name}** | ${v.metadata.namespace} | ${phase} | ${node} | ${ip} |`);
      });
    } else if (["pipeline", "pipelines"].includes(cmd.resourceType)) {
      parts.push(`| Pipeline | Namespace | Tasks |`);
      parts.push(`| --- | --- | --- |`);
      items.slice(0, 30).forEach((p) => {
        const taskCount = p.spec?.tasks?.length || 0;
        parts.push(`| **${p.metadata.name}** | ${p.metadata.namespace} | ${taskCount} |`);
      });
    } else if (["pipelinerun", "pipelineruns"].includes(cmd.resourceType)) {
      parts.push(`| Status | PipelineRun | Namespace | Result | Pipeline | Started |`);
      parts.push(`| --- | --- | --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((p) => {
        const succeeded = (p.status?.conditions || []).find(c => c.type === "Succeeded");
        const status = succeeded ? (succeeded.status === "True" ? "Succeeded" : succeeded.status === "False" ? "Failed" : "Running") : "Pending";
        const icon = status === "Succeeded" ? "[OK]" : status === "Failed" ? "[CRITICAL]" : "[WARNING]";
        const pipeline = p.spec?.pipelineRef?.name || "inline";
        const start = p.status?.startTime ? new Date(p.status.startTime).toLocaleString() : "?";
        parts.push(`| ${icon} | **${p.metadata.name}** | ${p.metadata.namespace} | ${status} | ${pipeline} | ${start} |`);
      });
    } else if (["task", "tasks"].includes(cmd.resourceType)) {
      parts.push(`| Task | Namespace | Steps |`);
      parts.push(`| --- | --- | --- |`);
      items.slice(0, 30).forEach((t) => {
        const stepCount = t.spec?.steps?.length || 0;
        parts.push(`| **${t.metadata.name}** | ${t.metadata.namespace} | ${stepCount} |`);
      });
    } else if (["taskrun", "taskruns"].includes(cmd.resourceType)) {
      parts.push(`| Status | TaskRun | Namespace | Result | Task |`);
      parts.push(`| --- | --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((t) => {
        const succeeded = (t.status?.conditions || []).find(c => c.type === "Succeeded");
        const status = succeeded ? (succeeded.status === "True" ? "Succeeded" : succeeded.status === "False" ? "Failed" : "Running") : "Pending";
        const icon = status === "Succeeded" ? "[OK]" : status === "Failed" ? "[CRITICAL]" : "[WARNING]";
        const taskName = t.spec?.taskRef?.name || "inline";
        parts.push(`| ${icon} | **${t.metadata.name}** | ${t.metadata.namespace} | ${status} | ${taskName} |`);
      });
    } else if (["clusterversion", "clusterversions"].includes(cmd.resourceType)) {
      parts.push(`| Status | Name | Version | Channel | Updates |`);
      parts.push(`| --- | --- | --- | --- | --- |`);
      items.forEach((cv) => {
        const version = cv.status?.desired?.version || "?";
        const channel = cv.spec?.channel || "?";
        const updates = cv.status?.availableUpdates?.length || 0;
        const progressing = (cv.status?.conditions || []).find(c => c.type === "Progressing");
        const icon = progressing?.status === "True" ? "[WARNING]" : "[OK]";
        parts.push(`| ${icon} | **${cv.metadata.name}** | v${version} | ${channel} | ${updates} available |`);
      });
    } else if (["machine", "machines"].includes(cmd.resourceType)) {
      parts.push(`| Status | Machine | Namespace | Phase | Node | Type |`);
      parts.push(`| --- | --- | --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((m) => {
        const phase = m.status?.phase || "Unknown";
        const icon = phase === "Running" ? "[OK]" : "[WARNING]";
        const nodeRef = m.status?.nodeRef?.name || "unassigned";
        const instanceType = m.spec?.providerSpec?.value?.instanceType || m.spec?.providerSpec?.value?.vmSize || "?";
        parts.push(`| ${icon} | **${m.metadata.name}** | ${m.metadata.namespace} | ${phase} | ${nodeRef} | ${instanceType} |`);
      });
    } else if (["machineset", "machinesets"].includes(cmd.resourceType)) {
      parts.push(`| Status | MachineSet | Namespace | Ready |`);
      parts.push(`| --- | --- | --- | --- |`);
      items.slice(0, 30).forEach((ms) => {
        const desired = ms.spec?.replicas ?? 0;
        const ready = ms.status?.readyReplicas ?? 0;
        const icon = ready === desired ? "[OK]" : "[WARNING]";
        parts.push(`| ${icon} | **${ms.metadata.name}** | ${ms.metadata.namespace} | ${ready}/${desired} |`);
      });
    } else {
      // Generic format
      parts.push(`| Name | Namespace |`);
      parts.push(`| --- | --- |`);
      items.slice(0, 30).forEach((item) => {
        const ns = item.metadata?.namespace || "—";
        parts.push(`| **${item.metadata?.name}** | ${ns} |`);
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
// ITSM — detect "raise change request / incident" intent and auto-populate
// ---------------------------------------------------------------------------
const ITSM_PATTERNS = {
  change_request: /\b(?:raise|create|open|submit|file|generate|draft|prepare)\s+(?:a\s+)?(?:change\s*request|CR|change\s*ticket|change\s*record|RFC)\b/i,
  incident: /\b(?:raise|create|open|submit|file|generate|report|log)\s+(?:a\s+|an\s+)?(?:incident|INC|incident\s*ticket|P[1-4]\s+incident|sev\s*\d\s+incident)\b/i,
};

async function detectITSMIntent(message) {
  const lower = message.toLowerCase();
  for (const [type, pat] of Object.entries(ITSM_PATTERNS)) {
    if (pat.test(message)) return type;
  }
  if (/\b(?:change\s*request|CR)\b/i.test(lower) && /\b(?:with|for|about|regarding|cluster|upgrade|deployment|service)\b/i.test(lower)) {
    return "change_request";
  }
  if (/\b(?:incident)\b/i.test(lower) && /\b(?:with|for|about|regarding|alert|down|issue|failure|outage)\b/i.test(lower)) {
    return "incident";
  }
  return null;
}

async function gatherITSMContext(message) {
  const ctx = { cluster: {}, recent: {} };
  try {
    const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
    ctx.cluster.version = cv.status?.desired?.version || cv.status?.history?.[0]?.version || "unknown";
    ctx.cluster.channel = cv.spec?.channel || "unknown";
    ctx.cluster.clusterID = cv.spec?.clusterID || cv.metadata?.uid || "";
    const available = (cv.status?.availableUpdates || []).map(u => u.version);
    ctx.cluster.availableUpdates = available.slice(0, 5);
    const conditions = (cv.status?.conditions || []);
    ctx.cluster.conditions = conditions.map(c => `${c.type}: ${c.status}`).join(", ");
  } catch { /* cluster info unavailable */ }
  try {
    const infra = await ocpGet("/apis/config.openshift.io/v1/infrastructures/cluster");
    ctx.cluster.platform = infra.status?.platform || "unknown";
    ctx.cluster.apiURL = infra.status?.apiServerURL || "";
  } catch {}
  try {
    const nodes = await ocpGet("/api/v1/nodes");
    ctx.cluster.nodeCount = (nodes.items || []).length;
    ctx.cluster.nodeNames = (nodes.items || []).slice(0, 5).map(n => n.metadata.name);
  } catch {}

  // Extract context clues from message
  const nsMatch = message.match(/(?:namespace|ns|project)\s+["']?([a-z0-9][-a-z0-9]*)["']?/i) ||
                  message.match(/\bin\s+["']?([a-z0-9][-a-z0-9]*)["']?\s*(?:namespace)?/i);
  ctx.recent.namespace = nsMatch ? nsMatch[1] : "";

  const resMatch = message.match(/\b(deployment|service|pod|route|configmap|secret|statefulset|daemonset|pvc|ingress|cronjob|job)\s+["']?([a-z0-9][-a-z0-9.]*)["']?/i);
  ctx.recent.resourceType = resMatch ? resMatch[1] : "";
  ctx.recent.resourceName = resMatch ? resMatch[2] : "";

  return ctx;
}

function buildITSMForm(type, message, ctx) {
  const now = new Date();
  const planned = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const fmtDate = (d) => d.toISOString().slice(0, 16).replace("T", " ");
  const c = ctx.cluster;
  const r = ctx.recent;

  const isUpgrade = /upgrade/i.test(message);
  const targetVersion = isUpgrade && c.availableUpdates?.length ? c.availableUpdates[0] : "";

  if (type === "change_request") {
    let title = "OpenShift Change";
    let description = [];
    let risk = "moderate";
    let changeType = "normal";
    let rollback = "";
    let validation = "";

    if (isUpgrade) {
      title = `OpenShift Cluster Upgrade: ${c.version || "current"} → ${targetVersion || "target"}`;
      description = [
        `Cluster: OpenShift ${c.version} (channel: ${c.channel})`,
        `Platform: ${c.platform || "N/A"}`,
        `Nodes: ${c.nodeCount || "N/A"}`,
        `Target Version: ${targetVersion || "[specify target]"}`,
        `Cluster ID: ${c.clusterID || "N/A"}`,
        `API Server: ${c.apiURL || "N/A"}`,
      ];
      risk = "high";
      changeType = "normal";
      rollback = "OpenShift supports rollback via: oc adm upgrade --to=<previous-version>. Monitor ClusterOperators and MachineConfigPool status. If rollback fails, restore from etcd backup.";
      validation = "1. Verify all ClusterOperators are Available (oc get co)\n2. Check node status (oc get nodes)\n3. Confirm workload health (oc get pods --all-namespaces | grep -v Running)\n4. Validate MachineConfigPool status (oc get mcp)";
    } else {
      if (r.resourceType && r.resourceName) {
        title = `OpenShift Change: ${r.resourceType} '${r.resourceName}'` + (r.namespace ? ` in ${r.namespace}` : "");
        description = [
          `Cluster: OpenShift ${c.version || "N/A"} (channel: ${c.channel || "N/A"})`,
          `Namespace: ${r.namespace || "[specify]"}`,
          `Resource: ${r.resourceType}/${r.resourceName}`,
          `Action: [create/modify/delete/scale]`,
          `Details: [Provide YAML diff or summary of the change]`,
        ];
      } else {
        title = "OpenShift Change — [describe the change]";
        description = [
          `Cluster: OpenShift ${c.version || "N/A"} (channel: ${c.channel || "N/A"})`,
          `Namespace: ${r.namespace || "[specify namespace]"}`,
          `Resource: [resource type/name]`,
          `Action: [create/modify/delete/scale]`,
          `Details: [Provide YAML diff or summary of the change]`,
        ];
      }
      rollback = "[Describe rollback steps for this change]";
      validation = "[Describe how you will verify the change is successful]";
    }

    return {
      type: "change_request",
      fields: {
        title: { label: "Change Request Title", value: title },
        justification: { label: "Business Justification", value: isUpgrade ? "Security patches and bug fixes in latest OpenShift release. Staying current with stable channel updates." : "" },
        changeType: { label: "Change Type", value: changeType, options: ["standard", "normal", "emergency"] },
        priority: { label: "Priority", value: "3", options: ["1 - Critical", "2 - High", "3 - Moderate", "4 - Low"] },
        risk: { label: "Risk Level", value: risk, options: ["low", "moderate", "high"] },
        plannedDate: { label: "Planned Implementation Date/Time", value: fmtDate(planned) },
        assignmentGroup: { label: "Assignment Group", value: "" },
        description: { label: "Change Description", value: description.join("\n") },
        impact: { label: "Impact Assessment", value: isUpgrade ? "Cluster nodes will be rebooted sequentially. Running workloads with proper PodDisruptionBudgets will experience minimal disruption." : "[Describe potential impact]" },
        rollback: { label: "Rollback Plan", value: rollback },
        validation: { label: "Testing/Validation Plan", value: validation },
      },
      servicenowEnabled: isServiceNowEnabled(),
    };
  }

  // Incident
  const alertMatch = message.match(/\b(alert|down|crash|oom|error|failure|outage|degraded|unavailable)\w*/i);
  const urgency = alertMatch && /down|crash|outage|unavailable/i.test(alertMatch[0]) ? "1" : "2";
  let incTitle = "OpenShift Incident";
  let incDesc = [];

  if (r.resourceType && r.resourceName) {
    incTitle = `${r.resourceType} '${r.resourceName}' issue` + (r.namespace ? ` in ${r.namespace}` : "");
    incDesc = [
      `Cluster: OpenShift ${c.version || "N/A"}`,
      `Namespace: ${r.namespace || "[specify]"}`,
      `Affected Resource: ${r.resourceType}/${r.resourceName}`,
      `Symptom: [describe the issue]`,
      `First Observed: ${fmtDate(now)}`,
    ];
  } else {
    incTitle = alertMatch ? `OpenShift ${alertMatch[0]} — [affected component]` : "OpenShift Incident — [describe issue]";
    incDesc = [
      `Cluster: OpenShift ${c.version || "N/A"}`,
      `Namespace: ${r.namespace || "[specify]"}`,
      `Affected Resource: [specify]`,
      `Symptom: [describe the issue]`,
      `First Observed: ${fmtDate(now)}`,
    ];
  }

  return {
    type: "incident",
    fields: {
      title: { label: "Incident Title", value: incTitle },
      urgency: { label: "Urgency", value: urgency, options: ["1 - High", "2 - Medium", "3 - Low"] },
      impact: { label: "Impact", value: "2", options: ["1 - High", "2 - Medium", "3 - Low"] },
      category: { label: "Category", value: "Infrastructure" },
      assignmentGroup: { label: "Assignment Group", value: "" },
      description: { label: "Description", value: incDesc.join("\n") },
      workaround: { label: "Workaround (if any)", value: "" },
    },
    servicenowEnabled: isServiceNowEnabled(),
  };
}

// ---------------------------------------------------------------------------
// Gather cluster context based on user query
// ---------------------------------------------------------------------------
async function gatherClusterContext(userMessage, nluParsed = null) {
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

  // Detect specific pod name — from NLU parse (which resolves pronouns
  // like "it", "its" from conversation memory) or regex fallback
  const podNameMatch = userMessage.match(/\b([a-z][-a-z0-9]*(?:-[a-z0-9]{4,10}){1,2})\b/i);
  if (nluParsed?.name && nluParsed?.resource === "pod") {
    context.targetPodName = nluParsed.name;
    context.intents.push("specific_pod");
  } else if (nluParsed?.name) {
    context.targetResourceName = nluParsed.name;
    context.targetResourceType = nluParsed.resource;
    if (nluParsed.resource === "deployment") context.intents.push("deployments");
  }
  if (!context.targetPodName && podNameMatch) {
    context.targetPodName = podNameMatch[1];
    context.intents.push("specific_pod");
  }
  // Use NLU-resolved namespace (which includes pronoun resolution from memory)
  if (nluParsed?.namespace) {
    context.targetNamespaceFromMemory = nluParsed.namespace;
  }

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
    if (context.intents.includes("specific_pod")) {
      // User wants to analyse a specific pod — add pod_issues to fetch
      // supporting data but NOT cluster_health (which floods the context
      // with unrelated pods and confuses the LLM).
      if (!context.intents.includes("pod_issues")) {
        context.intents.push("pod_issues");
      }
    } else if (!context.intents.includes("pod_issues") && !context.intents.includes("nodes")) {
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

  // Specific pod — fetch full details, events, and metrics for a named pod
  if (context.intents.includes("specific_pod") && context.targetPodName) {
    const podName = context.targetPodName;
    tasks.push(
      ocpGet("/api/v1/pods").then((d) => {
        const pod = (d.items || []).find((p) => p.metadata.name === podName);
        if (pod) {
          const ns = pod.metadata.namespace;
          context.targetPod = {
            name: pod.metadata.name,
            namespace: ns,
            phase: pod.status?.phase,
            node: pod.spec?.nodeName,
            ownerKind: pod.metadata?.ownerReferences?.[0]?.kind,
            ownerName: pod.metadata?.ownerReferences?.[0]?.name,
            startTime: pod.status?.startTime,
            images: (pod.spec?.containers || []).map((c) => c.image),
            resourceLimits: (pod.spec?.containers || []).map((c) => ({
              name: c.name,
              memRequest: c.resources?.requests?.memory,
              memLimit: c.resources?.limits?.memory,
              cpuRequest: c.resources?.requests?.cpu,
              cpuLimit: c.resources?.limits?.cpu,
            })),
            containers: (pod.status?.containerStatuses || []).map((c) => ({
              name: c.name,
              ready: c.ready,
              started: c.started,
              restarts: c.restartCount,
              state: c.state?.waiting?.reason || c.state?.terminated?.reason || (c.state?.running ? "Running" : "Unknown"),
              exitCode: c.state?.terminated?.exitCode,
              signal: c.state?.terminated?.signal,
              lastState: c.lastState?.terminated ? {
                reason: c.lastState.terminated.reason,
                exitCode: c.lastState.terminated.exitCode,
                signal: c.lastState.terminated.signal,
                finishedAt: c.lastState.terminated.finishedAt,
              } : null,
            })),
            conditions: (pod.status?.conditions || []).map((c) => ({
              type: c.type, status: c.status, reason: c.reason, message: c.message,
            })),
          };
          // Fetch events for this pod
          return ocpGet(`/api/v1/namespaces/${ns}/events?fieldSelector=involvedObject.name=${podName}`).then((ev) => {
            context.targetPodEvents = (ev.items || [])
              .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0))
              .slice(0, 20)
              .map((e) => ({
                type: e.type,
                reason: e.reason,
                message: e.message,
                count: e.count,
                lastSeen: e.lastTimestamp,
              }));
          }).catch(() => {});
        }
      }).catch(() => {})
    );
    // Also fetch logs for this pod when the user asks about logs/describe/diagnose
    const wantsLogs = /\b(log|logs|tail|describe|why|diagnose|debug|investigate|fail|error|crash|wrong|issue|problem|inspect|details?)\b/i.test(userMessage);
    if (wantsLogs) {
      tasks.push(
        ocpGet("/api/v1/pods").then(async (d) => {
          const pod = (d.items || []).find((p) => p.metadata.name === podName);
          if (!pod) return;
          const ns = pod.metadata.namespace;
          try {
            const txt = await fetchPodLogs(ns, podName, 80);
            context.targetPodLogs = String(txt || "").slice(0, 6000);
          } catch (err) {
            context.targetPodLogsError = err.message;
            // Try previous container logs if current failed
            try {
              const prevPath = `/api/v1/namespaces/${ns}/pods/${podName}/log?tailLines=80&previous=true`;
              let prevTxt;
              try {
                prevTxt = await ocpFetch(prevPath, { headers: { Accept: "text/plain" } });
              } catch (e2) {
                if (e2.message && e2.message.includes("406")) {
                  prevTxt = await ocpFetch(prevPath, { headers: { Accept: "*/*" } });
                }
              }
              if (prevTxt) context.targetPodLogsPrevious = String(prevTxt).slice(0, 6000);
            } catch { /* swallow */ }
          }
        }).catch(() => {})
      );
    }
    // Also fetch metrics for this pod if available
    tasks.push(
      ocpGet("/apis/metrics.k8s.io/v1beta1/pods").then((d) => {
        const m = (d.items || []).find((p) => p.metadata.name === podName);
        if (m) {
          context.targetPodMetrics = {
            name: m.metadata.name,
            namespace: m.metadata.namespace,
            containers: (m.containers || []).map((c) => ({
              name: c.name, cpu: c.usage?.cpu, memory: c.usage?.memory,
            })),
          };
        }
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
const SYSTEM_PROMPT = `You are an expert OpenShift/Kubernetes SRE AI Assistant embedded in an MCP (Model Context Protocol) server that has LIVE access to the user's cluster.

IMPORTANT: You are given REAL-TIME cluster data as JSON context. This is NOT hypothetical — it is live data from the user's actual cluster. Always analyze this data specifically and reference actual pod names, namespaces, events, and metrics from the context.

## Your capabilities:
- You have read access to pods, deployments, nodes, events, routes, operators, VMs, and more
- You can see container resource limits, restart counts, OOMKill history, and events
- You can see node capacity, pod scheduling, and cluster version
- The user can execute remediation via MCP tools (emergency_fix, restart_pod, scale_deployment)

## When diagnosing issues (OOMKilled, CrashLoopBackOff, etc.):
1. **Identify the specific pod/container** from the context data — use the exact name
2. **Analyze root cause** using events, container states, exit codes, restart counts, and resource limits
3. **For OOMKilled**: Compare memory limits vs requests, check if limits are too low, identify the container consuming excessive memory, and suggest appropriate limits based on the workload
4. **For CrashLoopBackOff**: Check exit codes, last terminated reason, and pod events
5. **Provide specific oc commands** to fix the issue (e.g., \`oc set resources\`, \`oc rollout restart\`, \`oc adm top pod\`)
6. **Include YAML patches** when config changes are needed
7. **Assess blast radius** — will the fix affect other services?
8. **Mention the ServiceNow change request flow** for production changes

## When listing resources:
- Use markdown tables for structured data
- Highlight unhealthy items with warning indicators
- Include restart counts, age, resource usage, and owner references
- Group by namespace when showing cross-namespace data

## OpenShift-specific knowledge:
- Use \`oc\` commands (not \`kubectl\`) in all examples
- Reference OpenShift concepts: Routes, DeploymentConfigs, BuildConfigs, ImageStreams, SCCs, Projects
- For SCC issues, suggest \`oc adm policy\` commands
- For operator issues, check ClusterOperator status conditions
- For upgrade issues, reference MachineConfigPool status and ClusterVersion

## CRITICAL — Specific pod/resource focus:
- When the cluster data contains "_focusPod" or "targetPod", the user is asking about THAT SPECIFIC pod. Your ENTIRE response must be about that pod only.
- Do NOT list other pods, do NOT give a general cluster overview, do NOT mention unrelated failing pods.
- Analyze the specific pod's container states, exit codes, restart counts, events, and metrics.
- "_focusPodLogs" contains the actual log output — quote relevant lines when asked for logs or when diagnosing.
- "_focusPodLogsPrevious" contains previous-container logs (after a crash) — use these for OOMKill / CrashLoop diagnosis.
- If the pod is healthy, say so. If it has errors, diagnose the exact root cause for that pod.

## Conversation continuity:
- You receive conversation history. Use it to understand follow-up questions.
- If the user follows up with just a resource name (e.g. "user-db-xyz logs", "describe payment-svc-abc"), find that resource in the conversation history (previous list) and the live cluster data, then answer about it.
- Carry forward namespace/cluster context from prior turns — the user does not need to repeat it.
- If the user says "show its logs", "restart it", "what namespace is it in", "explain more", "fix it" — refer to the pod/deployment/resource from the previous messages.
- Maintain context across the conversation like a human SRE colleague would.

## When required information is missing:
- NEVER respond with "[WARNING] Please specify the namespace" or similar generic templates. Instead, look at the conversation history and live cluster data — the namespace was likely in the prior turn.
- If you genuinely cannot resolve a resource, list the most likely candidates from the live data and ask which one the user means.

## Response style:
- Be specific to THIS cluster's data — never give generic advice when you have real data
- Start with a clear diagnosis, then provide remediation steps
- Use markdown formatting with headers, code blocks, and tables
- Keep responses focused and actionable
- When the user asks a follow-up about a previously discussed resource, don't re-list all resources — focus on the specific one from context`;

// ---------------------------------------------------------------------------
// Call external LLM — thin wrapper around the centralized llm.js module
// that keeps the built-in analysis fallback when no provider is configured.
// ---------------------------------------------------------------------------
/**
 * Convert a conversation history array [{role: "user"|"ai", text}, ...] into
 * the messages format expected by the LLM, limited to the last N entries.
 */
function historyToMessages(history, limit = 10) {
  if (!Array.isArray(history) || history.length === 0) return [];
  return history.slice(-limit).map((h) => ({
    role: h.role === "ai" ? "assistant" : "user",
    content: h.text || "",
  }));
}

async function callLLMWithContext(userMessage, clusterContext, opts = {}) {
  const provider = opts.provider || LLM_PROVIDER;
  if (!provider || provider === "none") {
    return builtInAnalysis(userMessage, clusterContext);
  }

  // When a specific pod is the target, restructure the context so the LLM
  // sees it first and doesn't get distracted by the broader problemPods list.
  const ctx = { ...clusterContext };
  if (ctx.targetPod) {
    // Move targetPod + events + metrics + logs to the top-level focus keys
    const focused = {
      _focusPod: ctx.targetPod,
      _focusPodLogs: ctx.targetPodLogs || null,
      _focusPodLogsPrevious: ctx.targetPodLogsPrevious || null,
      _focusPodLogsError: ctx.targetPodLogsError || null,
      _focusPodEvents: ctx.targetPodEvents || [],
      _focusPodMetrics: ctx.targetPodMetrics || null,
    };
    // Remove the broad problemPods to avoid LLM confusion — keep only
    // the target pod if it happens to be in that list.
    if (Array.isArray(ctx.problemPods)) {
      ctx.problemPods = ctx.problemPods.filter(
        (p) => p.name === ctx.targetPodName
      );
    }
    // Merge focused data first so it appears at the top of the JSON
    Object.assign(focused, ctx);
    Object.assign(ctx, focused);
  }

  const contextStr = JSON.stringify(ctx, null, 2);
  const userContent = `${userMessage}\n\n--- Live Cluster Data ---\n${contextStr}`;

  // Build messages array, optionally including conversation history
  const priorMessages = historyToMessages(opts.history);
  const messages = [
    ...priorMessages,
    { role: "user", content: userContent },
  ];

  try {
    const r = await callLLM({
      messages,
      system: SYSTEM_PROMPT,
      maxTokens: 2000,
      temperature: 0.3,
      provider: opts.provider,
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      azureDeployment: opts.azureDeployment,
      azureApiVersion: opts.azureApiVersion,
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

  // --- SPECIFIC POD: highest priority when user asks about a named pod ---
  if (intents.includes("specific_pod") && ctx.targetPod) {
    const tp = ctx.targetPod;
    parts.push(`### Pod: \`${tp.name}\` in \`${tp.namespace}\``);
    parts.push(`**Phase:** ${tp.phase} | **Node:** ${tp.node || "N/A"} | **Started:** ${tp.startTime || "N/A"}`);
    if (tp.ownerKind) parts.push(`**Owner:** ${tp.ownerKind}/${tp.ownerName}`);
    if (tp.images?.length) parts.push(`**Image(s):** ${tp.images.map((i) => `\`${i}\``).join(", ")}`);

    // Container details
    parts.push(`\n#### Containers`);
    (tp.containers || []).forEach((c) => {
      const icon = c.ready ? "[OK]" : "[CRITICAL]";
      parts.push(`  - ${icon} **${c.name}** — state: \`${c.state}\`, ready: ${c.ready}, restarts: ${c.restarts}`);
      if (c.exitCode !== undefined && c.exitCode !== null) parts.push(`    Exit code: ${c.exitCode}`);
      if (c.lastState) parts.push(`    Last termination: ${c.lastState.reason} (exit ${c.lastState.exitCode})`);
    });

    // Resource limits
    if (tp.resourceLimits?.length) {
      parts.push(`\n#### Resources`);
      tp.resourceLimits.forEach((r) => {
        parts.push(`  - **${r.name}** — mem: ${r.memRequest || "?"}/${r.memLimit || "?"}, cpu: ${r.cpuRequest || "?"}/${r.cpuLimit || "?"}`);
      });
    }

    // Events
    if (ctx.targetPodEvents?.length) {
      parts.push(`\n#### Recent Events`);
      ctx.targetPodEvents.slice(0, 10).forEach((e) => {
        const icon = e.type === "Warning" ? "[WARNING]" : "[OK]";
        parts.push(`  - ${icon} **${e.reason}**: ${(e.message || "").substring(0, 150)}${e.count > 1 ? ` (x${e.count})` : ""}`);
      });
    }

    // Metrics
    if (ctx.targetPodMetrics?.containers?.length) {
      parts.push(`\n#### Current Usage`);
      ctx.targetPodMetrics.containers.forEach((c) => {
        parts.push(`  - **${c.name}** — CPU: ${c.cpu || "?"}, Memory: ${c.memory || "?"}`);
      });
    }

    // Conditions
    const badConditions = (tp.conditions || []).filter((c) => c.status !== "True" && c.type !== "PodScheduled");
    if (badConditions.length > 0) {
      parts.push(`\n#### Failed Conditions`);
      badConditions.forEach((c) => {
        parts.push(`  - **${c.type}:** ${c.reason || c.message || c.status}`);
      });
    }

    // Quick commands
    parts.push(`\n#### Diagnostic Commands`);
    parts.push("```" + `oc describe pod ${tp.name} -n ${tp.namespace}\noc logs ${tp.name} -n ${tp.namespace}\noc get pod ${tp.name} -n ${tp.namespace} -o yaml` + "```");
    parts.push(`@@APPLY_BTN|delete_pod|${tp.name}|${tp.namespace}|Restart Pod@@`);
    return parts.join("\n");
  }

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
// Security remediation helpers
// ---------------------------------------------------------------------------

const SECURITY_REMEDIATION_PROMPT = `You are a Kubernetes and OpenShift security expert. Analyze the following security findings from a live cluster scan and provide DETAILED, SPECIFIC remediation steps.

CRITICAL REQUIREMENTS:
1. For EACH finding, provide the EXACT oc/kubectl commands to fix the specific resources listed (use real namespace, pod, deployment names from the findings).
2. Wrap each executable command in @@SEC_FIX_CMD|<command>@@ tags so the UI can render Dry Run / Run buttons.
3. Prioritize by severity — CRITICAL findings first.
4. For privileged containers: provide oc patch commands to set securityContext.privileged=false on the owning Deployment/DaemonSet/StatefulSet.
5. For run-as-root: provide oc patch commands to set runAsNonRoot=true and runAsUser=1000.
6. For missing resource limits: provide oc patch commands to add CPU/memory limits.
7. For hostNetwork: explain which workloads can safely remove it and which cannot (e.g. CNI plugins, ingress controllers).
8. For missing NetworkPolicies: provide oc apply commands with inline YAML for default-deny policies per namespace.
9. For :latest images: provide oc set image commands with pinned tags.
10. Include a "Verification" step after each remediation to confirm the fix worked.
11. Warn about any commands that could cause service disruption and recommend doing them in maintenance windows.
12. For OpenShift-specific resources, recommend appropriate SCCs (restricted, nonroot, anyuid) instead of generic Pod Security Standards.

FORMAT:
- Use markdown headers (###) for each finding section
- Use numbered steps for remediation
- Use @@SEC_FIX_CMD|<exact oc/kubectl command>@@ for executable commands
- Add brief explanation before each command
- Include verification commands after fixes

IMPORTANT: Generate REAL commands with the ACTUAL resource names from the findings. Do NOT use placeholders like <pod-name> — use the real names provided.`;

async function generateSecurityRemediation(findings, score, grade, llmOpts) {
  const findingsSummary = findings.map((f) => {
    const itemLines = f.items.map((it) => {
      const parts = [it.namespace, it.pod, it.container, it.image].filter(Boolean);
      return `    - ${parts.join(" / ")}`;
    }).join("\n");
    return `[${f.severity}] ${f.title} (type: ${f.type})\n  Why: ${f.why}\n  Affected resources:\n${itemLines}${f.total > f.items.length ? `\n    ... and ${f.total - f.items.length} more` : ""}`;
  }).join("\n\n");

  // Pull team playbook context: similar past resolutions for each finding type
  let learningContext = "";
  try {
    const sigsByFinding = findings.flatMap((f) =>
      f.items.slice(0, 2).map((it) =>
        leBuildSignature({
          type: f.type === "privileged" ? "PrivilegedContainer"
            : f.type === "runAsRoot" ? "RunAsRoot"
            : f.type === "noLimits" ? "NoResourceLimits"
            : f.type === "hostNetwork" ? "HostNetwork"
            : f.type === "noNetworkPolicy" ? "NoNetworkPolicy"
            : f.type === "latestTag" ? "LatestImageTag"
            : f.type,
          resource: it.pod || it.namespace || "",
          namespace: it.namespace,
        })
      )
    );
    const allMatches = [];
    for (const sig of sigsByFinding.slice(0, 6)) {
      const matches = await leFindSimilarIncidents(sig, { sinceDays: 90, limit: 2 });
      if (matches.length) allMatches.push(...matches);
    }
    learningContext = leBuildLearningContext(allMatches);
  } catch { /* swallow */ }

  const userPrompt = `Security scan results — Score: ${score}/100, Grade: ${grade}

${findingsSummary}${learningContext}

Provide detailed, step-by-step remediation with executable oc/kubectl commands for each finding. Use the real resource names listed above.`;

  const r = await callLLM({
    messages: [{ role: "user", content: userPrompt }],
    system: SECURITY_REMEDIATION_PROMPT,
    maxTokens: 4000,
    temperature: 0.2,
    provider: llmOpts.provider,
    apiUrl: llmOpts.apiUrl,
    apiKey: llmOpts.apiKey,
    model: llmOpts.model,
    azureDeployment: llmOpts.azureDeployment,
    azureApiVersion: llmOpts.azureApiVersion,
  });

  return r.text || null;
}

function appendBuiltInRemediation(lines, findings) {
  for (const f of findings) {
    lines.push(`**Remediation for ${f.title}:**`);
    switch (f.type) {
      case "privileged":
        for (const it of f.items.slice(0, 3)) {
          lines.push(`  - Patch the deployment owning \`${it.pod}\` in \`${it.namespace}\`:`);
          lines.push(`    @@SEC_FIX_CMD|oc patch deployment ${it.pod.replace(/-[a-z0-9]+-[a-z0-9]+$/, "")} -n ${it.namespace} -p '{"spec":{"template":{"spec":{"containers":[{"name":"${it.container}","securityContext":{"privileged":false,"allowPrivilegeEscalation":false}}]}}}}' --type=strategic@@`);
        }
        lines.push(`  - Apply restricted SCC: \`oc adm policy add-scc-to-user restricted -z default -n <ns>\``);
        break;
      case "hostNetwork":
        lines.push(`  1. Remove \`hostNetwork: true\` from the pod spec`);
        lines.push(`  2. Use Kubernetes Services or Ingress/Routes to expose pods instead`);
        lines.push(`  3. If host networking is required (e.g. CNI plugins), isolate in a dedicated namespace with strict RBAC`);
        break;
      case "runAsRoot":
        for (const it of f.items.slice(0, 3)) {
          lines.push(`  - Enforce non-root for \`${it.pod}\` in \`${it.namespace}\`:`);
          lines.push(`    @@SEC_FIX_CMD|oc patch deployment ${it.pod.replace(/-[a-z0-9]+-[a-z0-9]+$/, "")} -n ${it.namespace} -p '{"spec":{"template":{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":1000}}}}}' --type=strategic@@`);
        }
        break;
      case "noLimits":
        for (const it of f.items.slice(0, 3)) {
          lines.push(`  - Add resource limits for \`${it.container}\` in \`${it.pod}\` (\`${it.namespace}\`):`);
          lines.push(`    @@SEC_FIX_CMD|oc patch deployment ${it.pod.replace(/-[a-z0-9]+-[a-z0-9]+$/, "")} -n ${it.namespace} -p '{"spec":{"template":{"spec":{"containers":[{"name":"${it.container}","resources":{"limits":{"cpu":"500m","memory":"256Mi"},"requests":{"cpu":"100m","memory":"128Mi"}}}]}}}}' --type=strategic@@`);
        }
        lines.push(`  - Or apply a LimitRange to enforce defaults:`);
        lines.push(`    @@SEC_FIX_CMD|oc create limitrange default-limits --default-cpu=500m --default-memory=256Mi -n ${f.items[0]?.namespace || "default"}@@`);
        break;
      case "latestTag":
        lines.push(`  1. Pin images to immutable tags or SHA digests`);
        lines.push(`  2. Set \`imagePullPolicy: IfNotPresent\` when using fixed tags`);
        lines.push(`  3. Use an image policy admission controller to block \`:latest\` cluster-wide`);
        break;
      case "noNetworkPolicy":
        for (const it of f.items.slice(0, 3)) {
          lines.push(`  - Apply default-deny ingress to \`${it.namespace}\`:`);
          lines.push(`    @@SEC_FIX_CMD|oc apply -n ${it.namespace} -f - <<< '{"apiVersion":"networking.k8s.io/v1","kind":"NetworkPolicy","metadata":{"name":"default-deny-ingress","namespace":"${it.namespace}"},"spec":{"podSelector":{},"policyTypes":["Ingress"]}}'@@`);
        }
        break;
    }
    lines.push(``);
  }
}

// ---------------------------------------------------------------------------
// Optimization / recommendations remediation helpers
// ---------------------------------------------------------------------------

const OPTIMIZATION_REMEDIATION_PROMPT = `You are a Kubernetes and OpenShift performance optimization expert. Analyze the following cluster optimization findings and provide DETAILED, SPECIFIC remediation steps with executable commands.

CRITICAL REQUIREMENTS:
1. For EACH finding, provide EXACT oc/kubectl commands targeting the REAL resource names from the findings.
2. Wrap each executable command in @@SEC_FIX_CMD|<command>@@ tags so the UI can render Dry Run / Run buttons.
3. Prioritize by severity — CRITICAL findings first (under-provisioned, capacity warnings).

FOR OVER-PROVISIONED PODS:
- Calculate a right-sized CPU request: actual usage + 20-30% buffer, rounded to nearest 50m
- Calculate a right-sized memory request: actual usage + 20% buffer, rounded to nearest 32Mi
- Provide oc patch commands for each pod's owning Deployment/StatefulSet to set the new requests
- Suggest VPA (Vertical Pod Autoscaler) configuration for namespaces with many over-provisioned pods

FOR UNDER-PROVISIONED PODS:
- Calculate a proper CPU request: at least match current usage + 25% buffer
- Provide oc patch commands to increase CPU/memory requests and limits
- Suggest HPA (Horizontal Pod Autoscaler) for workloads that need scaling
- Warn about potential OOMKill risk if memory is also under-provisioned

FOR PODS WITHOUT RESOURCE LIMITS:
- Provide oc patch commands to add reasonable default limits (cpu: 500m, memory: 256Mi)
- Suggest LimitRange objects for each affected namespace
- Provide oc create limitrange commands

FOR HIGH-RESTART PODS:
- Provide oc logs --previous commands to check last crash logs
- Provide oc describe pod commands to check events and exit codes
- Suggest common fixes: increase memory limits for OOMKilled, fix liveness probes for CrashLoopBackOff

FOR CLUSTER CAPACITY:
- Suggest scaling MachineSets if available
- Provide oc get machinesets and oc scale commands
- Recommend enabling ClusterAutoscaler

FORMAT:
- Use markdown headers (###) for each section
- Use numbered steps
- Use @@SEC_FIX_CMD|<exact command>@@ for executable commands
- Add brief explanation before each command
- Include verification commands after fixes

IMPORTANT: Generate REAL commands with ACTUAL resource names from the findings. Do NOT use placeholders like <pod-name>.`;

async function generateOptimizationRemediation(findings, clusterStats, llmOpts) {
  const findingsSummary = findings.map((f) => {
    const itemLines = f.items.map((it) => {
      const parts = [it.ns, it.pod];
      if (it.reqCpu) parts.push(`reqCPU=${it.reqCpu}`, `usageCPU=${it.usageCpu}`, `util=${it.util}%`);
      if (it.reqMem) parts.push(`reqMem=${it.reqMem}`, `usageMem=${it.usageMem}`);
      if (it.restarts) parts.push(`restarts=${it.restarts}`);
      return `    - ${parts.join(" / ")}`;
    }).join("\n");
    return `[${f.severity}] ${f.title} (type: ${f.type})\n  ${f.description}\n  Affected resources:\n${itemLines}${f.total > f.items.length ? `\n    ... and ${f.total - f.items.length} more` : ""}`;
  }).join("\n\n");

  // Pull team playbook context for optimization patterns
  let learningContext = "";
  try {
    const sigs = findings.flatMap((f) =>
      f.items.slice(0, 2).map((it) =>
        leBuildSignature({
          type: f.type === "over-provisioned" ? "OverProvisioned"
            : f.type === "under-provisioned" ? "UnderProvisioned"
            : f.type === "no-limits" ? "NoResourceLimits"
            : f.type === "high-restarts" ? "HighRestartRate"
            : f.type === "capacity" ? "ClusterCapacity" : f.type,
          resource: it.pod || it.ns || "",
          namespace: it.ns,
        })
      )
    );
    const allMatches = [];
    for (const sig of sigs.slice(0, 6)) {
      const matches = await leFindSimilarIncidents(sig, { sinceDays: 90, limit: 2 });
      if (matches.length) allMatches.push(...matches);
    }
    learningContext = leBuildLearningContext(allMatches);
  } catch { /* swallow */ }

  const userPrompt = `Cluster optimization scan results:
- Total user pods: ${clusterStats.totalPods}
- CPU headroom: ${clusterStats.cpuH}%
- Memory headroom: ${clusterStats.memH}%

${findingsSummary}${learningContext}

Provide detailed optimization recommendations with executable oc/kubectl commands for each finding. Use the real resource names listed above. Calculate right-sized values based on actual usage data.`;

  const r = await callLLM({
    messages: [{ role: "user", content: userPrompt }],
    system: OPTIMIZATION_REMEDIATION_PROMPT,
    maxTokens: 4000,
    temperature: 0.2,
    provider: llmOpts.provider,
    apiUrl: llmOpts.apiUrl,
    apiKey: llmOpts.apiKey,
    model: llmOpts.model,
    azureDeployment: llmOpts.azureDeployment,
    azureApiVersion: llmOpts.azureApiVersion,
  });

  return r.text || null;
}

function appendBuiltInOptimization(lines, findings, fmtCpu, fmtMem, totalAllocCpu, totalReqCpu) {
  for (const f of findings) {
    lines.push(`**Remediation for ${f.title}:**`);
    switch (f.type) {
      case "over-provisioned":
        for (const it of f.items.slice(0, 5)) {
          const rightSizedCpu = Math.max(10, Math.ceil((it.rawUsageCpu || 0.01) * 1.3 * 1000));
          const deployName = it.pod.replace(/-[a-z0-9]+-[a-z0-9]+$/, "");
          lines.push(`  - Right-size \`${it.pod}\` in \`${it.ns}\` — current usage ${it.usageCpu}, requested ${it.reqCpu}:`);
          lines.push(`    @@SEC_FIX_CMD|oc patch deployment ${deployName} -n ${it.ns} -p '{"spec":{"template":{"spec":{"containers":[{"name":"${deployName}","resources":{"requests":{"cpu":"${rightSizedCpu}m"}}}]}}}}' --type=strategic@@`);
        }
        if (f.total > 5) lines.push(`  - … and ${f.total - 5} more pods to right-size`);
        lines.push(`  - Consider VPA for automatic right-sizing: \`oc apply -f vpa.yaml\``);
        break;
      case "under-provisioned":
        for (const it of f.items.slice(0, 5)) {
          const rightSizedCpu = Math.ceil((it.rawUsageCpu || 0.5) * 1.25 * 1000);
          const deployName = it.pod.replace(/-[a-z0-9]+-[a-z0-9]+$/, "");
          lines.push(`  - Increase resources for \`${it.pod}\` in \`${it.ns}\` — using ${it.usageCpu} but only requested ${it.reqCpu}:`);
          lines.push(`    @@SEC_FIX_CMD|oc patch deployment ${deployName} -n ${it.ns} -p '{"spec":{"template":{"spec":{"containers":[{"name":"${deployName}","resources":{"requests":{"cpu":"${rightSizedCpu}m"},"limits":{"cpu":"${rightSizedCpu * 2}m"}}}]}}}}' --type=strategic@@`);
        }
        if (f.total > 5) lines.push(`  - … and ${f.total - 5} more pods to scale up`);
        lines.push(`  - Set up HPA for auto-scaling:`);
        if (f.items[0]) {
          const d0 = f.items[0].pod.replace(/-[a-z0-9]+-[a-z0-9]+$/, "");
          lines.push(`    @@SEC_FIX_CMD|oc autoscale deployment ${d0} -n ${f.items[0].ns} --min=2 --max=10 --cpu-percent=70@@`);
        }
        break;
      case "no-limits":
        for (const it of f.items.slice(0, 3)) {
          const deployName = it.pod.replace(/-[a-z0-9]+-[a-z0-9]+$/, "");
          lines.push(`  - Add resource limits for \`${it.pod}\` in \`${it.ns}\`:`);
          lines.push(`    @@SEC_FIX_CMD|oc patch deployment ${deployName} -n ${it.ns} -p '{"spec":{"template":{"spec":{"containers":[{"name":"${deployName}","resources":{"limits":{"cpu":"500m","memory":"256Mi"},"requests":{"cpu":"100m","memory":"128Mi"}}}]}}}}' --type=strategic@@`);
        }
        // Group by namespace for LimitRange
        const nsSet = [...new Set(f.items.map((it) => it.ns))];
        for (const ns of nsSet.slice(0, 3)) {
          lines.push(`  - Apply namespace-wide defaults for \`${ns}\`:`);
          lines.push(`    @@SEC_FIX_CMD|oc create limitrange default-limits --default-cpu=500m --default-memory=256Mi --default-request-cpu=100m --default-request-memory=128Mi -n ${ns}@@`);
        }
        break;
      case "high-restarts":
        for (const it of f.items.slice(0, 5)) {
          lines.push(`  - Investigate \`${it.pod}\` in \`${it.ns}\` (${it.restarts} restarts):`);
          lines.push(`    @@SEC_FIX_CMD|oc logs ${it.pod} -n ${it.ns} --previous --tail=50@@`);
          lines.push(`    @@SEC_FIX_CMD|oc describe pod ${it.pod} -n ${it.ns}@@`);
        }
        lines.push(`  - Common causes: OOMKilled (increase memory limits), CrashLoopBackOff (fix application code/config)`);
        break;
      case "capacity":
        lines.push(`  1. Right-size over-provisioned workloads to free up resources`);
        lines.push(`  2. Check MachineSets for scale-up opportunities:`);
        lines.push(`    @@SEC_FIX_CMD|oc get machinesets -n openshift-machine-api@@`);
        lines.push(`  3. Enable cluster autoscaler for automatic node scaling`);
        break;
    }
    lines.push(``);
  }
}

// ---------------------------------------------------------------------------
// Slash command fast-path — returns { reply, contextKeys } or null
// ---------------------------------------------------------------------------
async function maybeHandleSlashCommand(userMessage, conversationId, llmOpts = {}) {
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

      const lines = [
        `### Security & Compliance Audit`,
        ``,
        `@@SCORE|${score}|Security Posture@@`,
        `@@GRADE|${grade}|Compliance Grade@@`,
        ``,
        `**Scanned:** ${items.length} pods across ${nsList.length} namespaces`,
        ``,
      ];

      // Determine if an LLM provider is available for AI-powered remediation
      const secProvider = llmOpts.provider || LLM_PROVIDER;
      const hasLLM = secProvider && secProvider !== "none";

      // Build findings data for both built-in and LLM paths
      const findings = [];

      if (privilegedList.length > 0) {
        findings.push({
          severity: "CRITICAL",
          title: `${privilegedList.length} Privileged Container(s)`,
          type: "privileged",
          items: privilegedList.slice(0, showMax).map((ref) => {
            const [ns2, pod, ctr] = ref.split("/");
            return { namespace: ns2, pod, container: ctr };
          }),
          total: privilegedList.length,
          why: "Privileged containers have unrestricted host access — a compromised container can take over the entire node.",
        });
      }
      if (hostNetList.length > 0) {
        findings.push({
          severity: "CRITICAL",
          title: `${hostNetList.length} Pod(s) Using hostNetwork`,
          type: "hostNetwork",
          items: hostNetList.slice(0, showMax).map((h) => ({ namespace: h.namespace, pod: h.pod })),
          total: hostNetList.length,
          why: "hostNetwork pods share the node's network stack, exposing node-level services and bypassing NetworkPolicies.",
        });
      }
      if (runAsRootList.length > 0) {
        findings.push({
          severity: "WARNING",
          title: `${runAsRootList.length} Container(s) May Run as Root`,
          type: "runAsRoot",
          items: runAsRootList.slice(0, showMax).map((ref) => {
            const [ns2, pod, ctr] = ref.split("/");
            return { namespace: ns2, pod, container: ctr };
          }),
          total: runAsRootList.length,
          why: "Root containers can modify the host filesystem and escalate privileges if a breakout occurs.",
        });
      }
      if (noLimitsList.length > 0) {
        findings.push({
          severity: "WARNING",
          title: `${noLimitsList.length} Container(s) Without Resource Limits`,
          type: "noLimits",
          items: noLimitsList.slice(0, showMax).map((ref) => {
            const [ns2, pod, ctr] = ref.split("/");
            return { namespace: ns2, pod, container: ctr };
          }),
          total: noLimitsList.length,
          why: "Without limits, a single container can starve other workloads and cause node instability.",
        });
      }
      if (latestTagList.length > 0) {
        findings.push({
          severity: "WARNING",
          title: `${latestTagList.length} Image(s) Using :latest or Untagged`,
          type: "latestTag",
          items: latestTagList.slice(0, showMax).map(({ ref, image }) => {
            const [ns2, pod, ctr] = ref.split("/");
            return { namespace: ns2, pod, container: ctr, image };
          }),
          total: latestTagList.length,
          why: ":latest tags make deployments non-reproducible and can pull untested or vulnerable versions.",
        });
      }
      if (uncoveredNs.length > 0) {
        findings.push({
          severity: "WARNING",
          title: `${uncoveredNs.length} Namespace(s) Without NetworkPolicy`,
          type: "noNetworkPolicy",
          items: uncoveredNs.slice(0, showMax).map((n) => ({ namespace: n })),
          total: uncoveredNs.length,
          why: "Without NetworkPolicies, all pods can communicate freely — a compromised pod can reach any service in the cluster.",
        });
      }

      // Render findings table for each finding
      for (const f of findings) {
        lines.push(`---`);
        lines.push(`### [${f.severity}] ${f.title}`);
        lines.push(``);
        if (f.type === "hostNetwork") {
          lines.push(`| Namespace | Pod |`);
          lines.push(`|-----------|-----|`);
          for (const it of f.items) lines.push(`| ${it.namespace} | ${it.pod} |`);
        } else if (f.type === "noNetworkPolicy") {
          lines.push(`| Namespace |`);
          lines.push(`|-----------|`);
          for (const it of f.items) lines.push(`| ${it.namespace} |`);
        } else if (f.type === "latestTag") {
          lines.push(`| Namespace | Pod | Container | Image |`);
          lines.push(`|-----------|-----|-----------|-------|`);
          for (const it of f.items) lines.push(`| ${it.namespace} | ${it.pod} | ${it.container} | \`${it.image}\` |`);
        } else {
          lines.push(`| Namespace | Pod | Container |`);
          lines.push(`|-----------|-----|-----------|`);
          for (const it of f.items) lines.push(`| ${it.namespace} | ${it.pod} | ${it.container} |`);
        }
        if (f.total > showMax) lines.push(`| … | *${f.total - showMax} more* | |`);
        lines.push(``);
        lines.push(`**Why it matters:** ${f.why}`);
        lines.push(``);
      }

      // --- AI-powered remediation (Azure OpenAI / any LLM) ---
      if (hasLLM && findings.length > 0) {
        try {
          const aiRemediation = await generateSecurityRemediation(findings, score, grade, llmOpts);
          if (aiRemediation) {
            lines.push(`---`);
            lines.push(``);
            lines.push(`### AI Security Remediation`);
            lines.push(`*Powered by ${secProvider === "azure" ? "Azure OpenAI" : secProvider}*`);
            lines.push(``);
            lines.push(aiRemediation);
            lines.push(``);
          }
        } catch (err) {
          console.error("[security] AI remediation failed, falling back to built-in:", err.message);
          appendBuiltInRemediation(lines, findings);
        }
      } else {
        appendBuiltInRemediation(lines, findings);
      }

      // --- Summary ---
      lines.push(`---`);
      lines.push(``);
      if (score >= 90) lines.push(`**Security posture is strong.** No critical issues found. Continue monitoring to maintain compliance.`);
      else if (score >= 70) lines.push(`**Some improvements recommended.** Address the warnings above to strengthen your security posture. Start with the highest-severity items.`);
      else {
        lines.push(`**Significant security risks detected.** Prioritize remediation in this order:`);
        let n = 1;
        if (privilegedList.length > 0) lines.push(`  ${n++}. Remove privileged mode from ${privilegedList.length} container(s)`);
        if (hostNetList.length > 0) lines.push(`  ${n++}. Eliminate hostNetwork from ${hostNetList.length} pod(s)`);
        if (runAsRootList.length > 0) lines.push(`  ${n++}. Enforce non-root for ${runAsRootList.length} container(s)`);
        if (noLimitsList.length > 0) lines.push(`  ${n++}. Add resource limits to ${noLimitsList.length} container(s)`);
        if (uncoveredNs.length > 0) lines.push(`  ${n++}. Apply NetworkPolicies to ${uncoveredNs.length} namespace(s)`);
      }

      return {
        reply: lines.join("\n"),
        provider: hasLLM ? secProvider : "built-in",
        contextKeys: ["slash", "security"],
      };
    } catch (e) {
      return { reply: `[ERROR] Security audit failed: ${e.message}`, contextKeys: ["slash", "security"] };
    }
  }

  // --- Team playbook (continuous learning loop) ---
  if (cmd === "playbook") {
    try {
      const sinceDays = Math.min(parseInt(arg, 10) || 90, 365);
      const [playbook, stats] = await Promise.all([
        leGetTeamPlaybook({ limit: 25, sinceDays }),
        leGetIncidentStats({ sinceDays }),
      ]);

      const lines = [
        `### Team Playbook — Learned Patterns`,
        ``,
        `Patterns your team has resolved over the past ${sinceDays} days. The AI uses these as context when similar issues recur.`,
        ``,
        `| Metric | Value |`,
        `|---|---|`,
        `| Total incidents | ${stats.total ?? 0} |`,
        `| Resolved | ${stats.resolved_count ?? 0} |`,
        `| Currently open | ${stats.open_count ?? 0} |`,
        `| Failed fixes | ${stats.failed_count ?? 0} |`,
        `| Unique patterns | ${stats.unique_patterns ?? 0} |`,
        `| Clusters affected | ${stats.clusters_affected ?? 0} |`,
        ``,
      ];

      if (!playbook || playbook.length === 0) {
        lines.push(`---`);
        lines.push(`[INFO] No resolved patterns yet. The playbook builds as your team fixes issues.`);
        lines.push(``);
        lines.push(`**How it works:**`);
        lines.push(`  - When the proactive agent detects an anomaly, it records an incident with a stable signature`);
        lines.push(`  - When you run a fix command (Run button), the resolution is linked to that incident`);
        lines.push(`  - When the same pattern recurs (here or on another cluster), the AI surfaces the prior fix automatically`);
      } else {
        lines.push(`---`);
        lines.push(`### Top Patterns`);
        lines.push(``);
        lines.push(`| # | Pattern | Resolved | Total Seen | Clusters | Last Fix |`);
        lines.push(`|---|---|---|---|---|---|`);
        for (let i = 0; i < playbook.length; i++) {
          const p = playbook[i];
          const last = p.last_resolved ? new Date(p.last_resolved).toISOString().slice(0, 10) : "—";
          const sig = (p.issue_signature || "").length > 60 ? p.issue_signature.slice(0, 57) + "…" : p.issue_signature;
          lines.push(`| ${i + 1} | \`${sig}\` | ${p.resolved_count} | ${p.occurrences} | ${p.clusters_affected} | ${last} |`);
        }
        lines.push(``);
        const top = playbook[0];
        if (top?.sample_command) {
          lines.push(`---`);
          lines.push(`### Sample Resolution`);
          lines.push(`Most-used pattern: \`${top.issue_signature}\``);
          lines.push(`Last applied command:`);
          lines.push(`@@SEC_FIX_CMD|${String(top.sample_command).slice(0, 500)}@@`);
        }
      }

      return {
        reply: lines.join("\n"),
        provider: "built-in",
        contextKeys: ["slash", "playbook"],
      };
    } catch (e) {
      return { reply: `[ERROR] Playbook unavailable: ${e.message}`, contextKeys: ["slash", "playbook"] };
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

      const recProvider = llmOpts.provider || LLM_PROVIDER;
      const hasLLM = recProvider && recProvider !== "none";

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

      // Build structured findings for each category
      const recFindings = [];

      if (overList.length > 0) {
        recFindings.push({
          severity: "WARNING", type: "over-provisioned",
          title: `${over} Over-Provisioned Pod(s)`,
          description: "These pods are using less than 10% of their requested CPU — you are paying for unused resources.",
          items: overList.slice(0, 10).map((o) => ({
            ns: o.ns, pod: o.pod,
            reqCpu: fmtCpu(o.reqCpu), usageCpu: fmtCpu(o.usageCpu),
            util: o.reqCpu > 0 ? Math.round((o.usageCpu / o.reqCpu) * 100) : 0,
            reqMem: fmtMem(o.reqMem), usageMem: fmtMem(o.usageMem),
            rawReqCpu: o.reqCpu, rawUsageCpu: o.usageCpu,
          })),
          total: overList.length,
        });
      }
      if (underList.length > 0) {
        recFindings.push({
          severity: "CRITICAL", type: "under-provisioned",
          title: `${under} Under-Provisioned Pod(s)`,
          description: "These pods are using more than 150% of their CPU request — they may be throttled or evicted.",
          items: underList.slice(0, 10).map((u) => ({
            ns: u.ns, pod: u.pod,
            reqCpu: fmtCpu(u.reqCpu), usageCpu: fmtCpu(u.usageCpu),
            util: u.reqCpu > 0 ? Math.round((u.usageCpu / u.reqCpu) * 100) : 0,
            rawReqCpu: u.reqCpu, rawUsageCpu: u.usageCpu,
          })),
          total: underList.length,
        });
      }
      if (noLimList.length > 0) {
        recFindings.push({
          severity: "WARNING", type: "no-limits",
          title: `${noLim} Pod(s) Without Resource Limits`,
          description: "Pods without resource limits can consume unbounded resources and starve other workloads.",
          items: noLimList.slice(0, 10).map((n) => ({ ns: n.ns, pod: n.pod })),
          total: noLimList.length,
        });
      }
      if (restartPods.length > 0) {
        recFindings.push({
          severity: "WARNING", type: "high-restarts",
          title: `${restartPods.length} Pod(s) With Excessive Restarts`,
          description: "Pods with high restart counts indicate application instability — possible OOMKill, CrashLoopBackOff, or liveness probe failures.",
          items: restartPods.slice(0, 10).map((r) => ({ ns: r.ns, pod: r.pod, restarts: r.restarts })),
          total: restartPods.length,
        });
      }
      if (cpuH < 15 || memH < 15) {
        recFindings.push({
          severity: "CRITICAL", type: "capacity",
          title: "Cluster Capacity Warning",
          description: `CPU headroom: ${cpuH}% (${fmtCpu(totalAllocCpu - totalReqCpu)} free of ${fmtCpu(totalAllocCpu)}). Memory headroom: ${memH}% (${fmtMem(totalAllocMem - totalReqMem)} free of ${fmtMem(totalAllocMem)}).`,
          items: [],
          total: 0,
          cpuH, memH,
        });
      }

      // Render data tables for each finding
      for (const f of recFindings) {
        lines.push(`---`);
        lines.push(`### [${f.severity}] ${f.title}`);
        lines.push(``);
        lines.push(f.description);
        lines.push(``);
        if (f.type === "over-provisioned" || f.type === "under-provisioned") {
          lines.push(`| Namespace | Pod | CPU Request | CPU Usage | Utilization |`);
          lines.push(`|---|---|---|---|---|`);
          for (const it of f.items) lines.push(`| ${it.ns} | ${it.pod} | ${it.reqCpu} | ${it.usageCpu} | ${it.util}% |`);
          if (f.total > 10) lines.push(`| … | *${f.total - 10} more* | | | |`);
        } else if (f.type === "no-limits") {
          lines.push(`| Namespace | Pod |`);
          lines.push(`|---|---|`);
          for (const it of f.items) lines.push(`| ${it.ns} | ${it.pod} |`);
          if (f.total > 10) lines.push(`| … | *${f.total - 10} more* |`);
        } else if (f.type === "high-restarts") {
          lines.push(`| Namespace | Pod | Restarts |`);
          lines.push(`|---|---|---|`);
          for (const it of f.items) lines.push(`| ${it.ns} | ${it.pod} | ${it.restarts} |`);
        } else if (f.type === "capacity") {
          if (f.cpuH < 15) lines.push(`  - CPU headroom is very low at **${f.cpuH}%**`);
          if (f.memH < 15) lines.push(`  - Memory headroom is very low at **${f.memH}%**`);
        }
        lines.push(``);
      }

      // AI-powered recommendations (Azure OpenAI / any LLM)
      if (hasLLM && recFindings.length > 0) {
        try {
          const aiRec = await generateOptimizationRemediation(recFindings, { cpuH, memH, totalPods: userPods.length }, llmOpts);
          if (aiRec) {
            lines.push(`---`);
            lines.push(``);
            lines.push(`### AI Optimization Recommendations`);
            lines.push(`*Powered by ${recProvider === "azure" ? "Azure OpenAI" : recProvider}*`);
            lines.push(``);
            lines.push(aiRec);
            lines.push(``);
          }
        } catch (err) {
          console.error("[recommendations] AI remediation failed, falling back to built-in:", err.message);
          appendBuiltInOptimization(lines, recFindings, fmtCpu, fmtMem, totalAllocCpu, totalReqCpu);
        }
      } else {
        appendBuiltInOptimization(lines, recFindings, fmtCpu, fmtMem, totalAllocCpu, totalReqCpu);
      }

      // Capacity headroom note (non-critical)
      if (cpuH >= 15 && memH >= 15 && (cpuH < 30 || memH < 30)) {
        lines.push(`---`);
        if (cpuH < 30) lines.push(`[WARNING] CPU headroom is getting tight at ${cpuH}%.`);
        if (memH < 30) lines.push(`[WARNING] Memory headroom is getting tight at ${memH}%.`);
        lines.push(``);
      }

      // Summary
      lines.push(`---`);
      if (cpuH >= 30 && memH >= 30 && over === 0 && under === 0 && noLim === 0 && restartPods.length === 0) {
        lines.push(`**Cluster resources are well-balanced.** No optimization needed at this time.`);
      } else {
        lines.push(`**Optimization opportunities identified:**`);
        if (over > 0) lines.push(`  - Right-size ${over} over-provisioned pod(s) to reclaim wasted CPU/memory`);
        if (under > 0) lines.push(`  - Increase resources for ${under} under-provisioned pod(s) to prevent throttling`);
        if (noLim > 0) lines.push(`  - Add resource limits to ${noLim} pod(s)`);
        if (restartPods.length > 0) lines.push(`  - Investigate ${restartPods.length} pod(s) with excessive restarts`);
        if (cpuH < 30) lines.push(`  - Plan capacity expansion — CPU headroom is ${cpuH}%`);
      }

      return {
        reply: lines.join("\n"),
        provider: hasLLM ? recProvider : "built-in",
        contextKeys: ["slash", "recommendations"],
      };
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
// SSE helper — writes Server-Sent Events to the response stream.
// Defeats proxy/HAProxy buffering by:
//  - flushHeaders() to send headers immediately
//  - setNoDelay(true) to disable Nagle's algorithm on the socket
//  - Sending a 2KB padding comment to push past HAProxy's internal buffer
//  - Periodic heartbeats during long-running operations
// ---------------------------------------------------------------------------
function sseStart(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Transfer-Encoding": "chunked",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  if (res.socket && typeof res.socket.setNoDelay === "function") {
    res.socket.setNoDelay(true);
  }
  // Send 2KB padding comment to flush past HAProxy/proxy buffer thresholds.
  // Without this, proxies often hold the response until enough bytes arrive.
  const padding = ":" + " ".repeat(2048) + "\n\n";
  res.write(padding);
  res.write(": ping\n\n");
}
function sseSend(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch {}
}
function sseHeartbeat(res) {
  try {
    res.write(": heartbeat " + Date.now() + "\n\n");
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

    // Remote cluster override — when the user selects a remote cluster in
    // the dashboard, route all ocpGet/ocpFetch calls to that cluster.
    if (body.cluster && body.cluster !== "local") {
      const agents = getConnectedAgents();
      const agent = agents.get(body.cluster);
      if (agent && agent.apiUrl && agent.token) {
        setRemoteCluster(agent.apiUrl, agent.token);
      }
    }

    // Slash commands — fast-path for dashboard shortcuts
    // Override LLM settings from request (for UI provider selector)
    const llmOpts = {};
    if (body.provider) llmOpts.provider = body.provider;
    if (body.apiKey) llmOpts.apiKey = body.apiKey;
    if (body.apiUrl) llmOpts.apiUrl = body.apiUrl;
    if (body.model) llmOpts.model = body.model;
    if (body.azureDeployment) llmOpts.azureDeployment = body.azureDeployment;
    if (body.azureApiVersion) llmOpts.azureApiVersion = body.azureApiVersion;

    const slashReply = await maybeHandleSlashCommand(userMessage, conversationId, llmOpts);
    if (slashReply) {
      const slashProvider = slashReply.provider || "built-in";
      if (conversationId) {
        histAddMessage(conversationId, {
          role: "assistant",
          content: slashReply.reply,
          provider: slashProvider,
        }).catch(() => {});
      }
      return json(res, 200, {
        reply: slashReply.reply,
        provider: slashProvider,
        contextKeys: slashReply.contextKeys || ["slash"],
        cached: false,
        conversationId,
      });
    }

    // Streaming path (SSE) — detected by Accept header or body.stream=true
    const wantsStream =
      body.stream === true ||
      (req.headers.accept || "").includes("text/event-stream");

    // Conversation history — only include when an LLM provider is active
    const requestedProvider = body.provider || LLM_PROVIDER;
    if (Array.isArray(body.history) && requestedProvider && requestedProvider !== "none") {
      llmOpts.history = body.history;
    }

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

    // Update conversation memory immediately after parsing so ALL code paths
    // (cache hits, slash commands, errors) carry context to the next turn.
    if (conversationId && (parsed.name || parsed.namespace || parsed.resource)) {
      updateMemory(conversationId, memoryPatchFromParse(parsed)).catch(() => {});
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
        if (wantsStream) {
          sseStart(res);
          sseSend(res, { stage: "querying" });
          sseSend(res, { stage: "generating" });
          sseSend(res, { delta: cached.reply });
          sseSend(res, { done: true, provider: cached.provider, conversationId });
          sseEnd(res);
          return;
        }
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
      if (wantsStream) {
        sseStart(res);
        sseSend(res, { delta: reply });
        sseSend(res, { done: true, provider, conversationId });
        sseEnd(res);
        return;
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
      if (wantsStream) {
        sseStart(res);
        sseSend(res, { delta: reply });
        sseSend(res, { done: true, provider, conversationId });
        sseEnd(res);
        return;
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
        if (wantsStream) {
          sseStart(res);
          sseSend(res, { delta: reply });
          sseSend(res, { done: true, provider: "built-in", conversationId });
          sseEnd(res);
          return;
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
        if (wantsStream) {
          sseStart(res);
          sseSend(res, { delta: reply });
          sseSend(res, { done: true, provider, conversationId, pendingAction: act });
          sseEnd(res);
          return;
        }
        return json(res, 200, { ...payload, cached: false, conversationId });
      } catch (err) {
        console.error("[chat-api] action workflow error:", err);
        if (/Resource not found|RBAC denied/i.test(err.message)) {
          const reply = `### Cannot ${actionIntent.action} ${actionIntent.resourceType}\n\n[WARNING] ${err.message}`;
          if (conversationId) {
            histAddMessage(conversationId, { role: "assistant", content: reply, provider: "built-in" }).catch(() => {});
          }
          if (wantsStream) {
            sseStart(res);
            sseSend(res, { delta: reply });
            sseSend(res, { done: true, provider: "built-in", conversationId });
            sseEnd(res);
            return;
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

    // ---- ITSM: detect "raise change request" / "create incident" ----
    const itsmType = await detectITSMIntent(userMessage);
    if (itsmType) {
      const itsmCtx = await gatherITSMContext(userMessage);
      const form = buildITSMForm(itsmType, userMessage, itsmCtx);
      const formToken = `@@ITSM_FORM|${JSON.stringify(form).replace(/@@/g, "@ @")}@@`;
      const label = itsmType === "change_request" ? "Change Request" : "Incident";

      // Auto-run preflight assessment for upgrade-related Change Requests
      // Detect upgrade context from: message text, available updates, or "above" references
      let preflightSection = "";
      const isUpgradeRelated = /upgrade/i.test(userMessage) ||
        (/\b(?:above|previous|pre-?check|assessment)\b/i.test(userMessage) && itsmCtx.cluster?.availableUpdates?.length > 0);
      if (itsmType === "change_request" && isUpgradeRelated) {
        try {
          const versionMatch = userMessage.match(/(\d+\.\d+\.\d+)/g);
          let targetVer = "";
          let currentVer = "";
          if (versionMatch && versionMatch.length >= 2) {
            currentVer = versionMatch[0];
            targetVer = versionMatch[1];
          } else if (versionMatch && versionMatch.length === 1) {
            targetVer = versionMatch[0];
          } else if (itsmCtx.cluster?.availableUpdates?.length) {
            targetVer = itsmCtx.cluster.availableUpdates[0];
          }
          if (targetVer) {
            const preflightReport = await runPreflightChecks(targetVer, currentVer || undefined);
            const reportToken = `@@PREFLIGHT_REPORT|${JSON.stringify(preflightReport).replace(/@@/g, "@ @")}@@`;
            preflightSection = `${reportToken}\n\n---\n\n`;
          }
        } catch { /* preflight failed gracefully — continue with CR form */ }
      }

      const reply = `${preflightSection}### ${label} Form\n\nI've auto-populated the ${label.toLowerCase()} form based on the current cluster context.${preflightSection ? " The pre-upgrade assessment report is shown above." : ""} Review and edit the fields below, then submit.\n\n${formToken}`;
      const provider = "built-in";
      if (conversationId) {
        histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
      }
      if (wantsStream) {
        sseStart(res);
        sseSend(res, { stage: "querying" });
        if (preflightSection) sseSend(res, { stage: "preflight_assessment" });
        sseSend(res, { stage: "generating" });
        sseSend(res, { delta: reply });
        sseSend(res, { done: true, provider, conversationId });
        sseEnd(res);
        return;
      }
      return json(res, 200, { reply, provider, contextKeys: ["itsm", itsmType, isUpgradeRelated ? "preflight" : null].filter(Boolean), cached: false, conversationId });
    }

    // ---- Upgrade preflight: "precheck upgrade", "cluster upgrade precheck", etc. ----
    const UPGRADE_PREFLIGHT_PAT = /\b(?:pre-?(?:check|flight|upgrade)|upgrade.*(?:pre-?check|assessment|readiness|compatible|compatibility)|check.*(?:before|prior).*upgrade|upgrade\s+cluster.*(?:from|to)\s+\d+\.\d+|cluster\s+(?:upgrade\s+)?pre-?check)\b/i;
    if (UPGRADE_PREFLIGHT_PAT.test(userMessage)) {
      try {
        const versionMatch = userMessage.match(/(\d+\.\d+\.\d+)/g);
        let targetVer = "";
        let currentVer = "";
        if (versionMatch && versionMatch.length >= 2) {
          currentVer = versionMatch[0];
          targetVer = versionMatch[1];
        } else if (versionMatch && versionMatch.length === 1) {
          targetVer = versionMatch[0];
        }

        // If no target version specified, auto-detect from cluster
        if (!targetVer) {
          try {
            const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
            currentVer = cv.status?.desired?.version || "";
            const updates = cv.status?.availableUpdates || [];
            if (updates.length > 0) {
              const sorted = [...updates].sort((a, b) => {
                const pa = (a.version || "").split(".").map(Number);
                const pb = (b.version || "").split(".").map(Number);
                for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); }
                return 0;
              });
              targetVer = sorted[0].version;
            }
          } catch { /* ignore — will fall through */ }
        }

        if (targetVer) {
          const preflightReport = await runPreflightChecks(targetVer, currentVer || undefined);
          const reportToken = `@@PREFLIGHT_REPORT|${JSON.stringify(preflightReport).replace(/@@/g, "@ @")}@@`;
          const reply = reportToken;
          const provider = "built-in";
          if (conversationId) {
            histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
          }
          if (wantsStream) {
            sseStart(res);
            sseSend(res, { stage: "querying" });
            sseSend(res, { stage: "preflight_assessment" });
            sseSend(res, { stage: "generating" });
            sseSend(res, { delta: reply });
            sseSend(res, { done: true, provider, conversationId });
            sseEnd(res);
            return;
          }
          return json(res, 200, { reply, provider, contextKeys: ["preflight", "upgrade"], cached: false, conversationId });
        }
      } catch { /* fall through on failure */ }
    }

    // Try direct command handler first (for specific CRUD operations)
    // This handles: logs, top, delete, run, exec, update
    const llmActive = activeProvider && activeProvider !== "none";

    // Rule-based handlers run first for straightforward commands (logs,
    // describe, list, get, etc.) — they're fast, reliable, and don't burn
    // LLM tokens. When they can handle the request, return immediately.
    // When they return null (ambiguous or unrecognized), fall through to
    // the agentic LLM path.
    const directResult = await handleDirectCommand(userMessage, cmd, { llmAvailable: llmActive });
    if (directResult) {
      const provider = llmActive ? activeProvider : "built-in";
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
      updateMemory(conversationId, memoryPatchFromParse(parsed)).catch(() => {});
      if (wantsStream) {
        sseStart(res);
        sseSend(res, { stage: "querying" });
        sseSend(res, { stage: "generating" });
        sseSend(res, { delta: directResult });
        sseSend(res, { done: true, provider, conversationId });
        sseEnd(res);
        return;
      }
      return json(res, 200, { ...payload, cached: false, conversationId });
    }

    // Try list command handler (for "list/show/get X" queries)
    const listResult = await handleListCommand(userMessage, cmd, { llmAvailable: llmActive });
    if (listResult) {
      const provider = llmActive ? activeProvider : "built-in";
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
      if (wantsStream) {
        sseStart(res);
        sseSend(res, { stage: "querying" });
        sseSend(res, { stage: "generating" });
        sseSend(res, { delta: listResult });
        sseSend(res, { done: true, provider, conversationId });
        sseEnd(res);
        return;
      }
      return json(res, 200, { ...payload, cached: false, conversationId });
    }

    // ---- Streaming SSE path ----
    if (wantsStream && llmEnabled(llmOpts)) {
      sseStart(res);
      // Periodic heartbeat keeps proxies/HAProxy from buffering the connection
      // and lets the client know the server is still working during the long
      // gatherClusterContext + LLM call.
      const heartbeat = setInterval(() => sseHeartbeat(res), 2000);
      try {
        sseSend(res, { stage: "querying" });
        const { result: sseTraced, trace: sseTrace } = await runWithTrace(async () => {
          let context = await gatherClusterContext(userMessage, parsed);
          sseSend(res, { stage: "generating" });
          if (context.targetPod) {
            const focused = {
              _focusPod: context.targetPod,
              _focusPodLogs: context.targetPodLogs || null,
              _focusPodLogsPrevious: context.targetPodLogsPrevious || null,
              _focusPodLogsError: context.targetPodLogsError || null,
              _focusPodEvents: context.targetPodEvents || [],
              _focusPodMetrics: context.targetPodMetrics || null,
            };
            if (Array.isArray(context.problemPods)) {
              context.problemPods = context.problemPods.filter(
                (p) => p.name === context.targetPodName
              );
            }
            Object.assign(focused, context);
            Object.assign(context, focused);
          }
          const contextStr = JSON.stringify(context, null, 2);
          const userContent = `${userMessage}\n\n--- Live Cluster Data ---\n${contextStr}`;
          const priorMessages = historyToMessages(llmOpts.history);
          let fullText = "";
          await callLLMStream({
            messages: [...priorMessages, { role: "user", content: userContent }],
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
        updateMemory(conversationId, memoryPatchFromParse(parsed)).catch(() => {});
        observeHistogram("mcp_chat_latency_seconds", { provider: activeProvider }, (Date.now() - startedAt) / 1000);
      } catch (sseErr) {
        sseSend(res, { error: sseErr.message });
        sseEnd(res);
      } finally {
        clearInterval(heartbeat);
      }
      return;
    }

    // Gather cluster context + call LLM inside a trace scope so that every
    // ocpFetch made during this request is captured for explainability.
    const { result: traced, trace } = await runWithTrace(async () => {
      const ctxKey = `ctx:${cacheKeyForChat(userMessage, "ctx")}`;
      let context = await cacheGet(ctxKey);
      if (!context) {
        context = await gatherClusterContext(userMessage, parsed);
        cacheSet(ctxKey, context, CONTEXT_CACHE_TTL).catch(() => {});
      }

      // Route through orchestrator when external MCP servers are connected,
      // or through agent loop for diagnose-type queries.
      const hubActive = getConnectionCount() > 0;
      const wantsDiagnose =
        llmEnabled(llmOpts) &&
        /\b(diagnose|root\s*cause|why\s+is|what'?s\s+wrong|troubleshoot)\b/i.test(userMessage);
      let replyText;
      let toolsUsed = [];

      const hintPods = context.targetPodName
        ? (context.problemPods || []).filter((p) => p.name === context.targetPodName)
        : (context.problemPods || []).slice(0, 5);

      if (hubActive && llmEnabled(llmOpts)) {
        try {
          let kbContext = "";
          try {
            const kbMatches = kbFindSimilar({
              type: parsed?.resource || "",
              symptoms: userMessage,
              namespace: parsed?.namespace || "",
              limit: 3,
            });
            kbContext = buildKBContext(kbMatches);
          } catch { /* KB optional */ }

          const orchRes = await runOrchestrator({
            userMessage: userMessage + kbContext,
            contextHint: {
              problemPods: hintPods,
              correlations: context.correlations || [],
              targetPod: context.targetPod || null,
            },
            llmOpts,
          });
          replyText = orchRes?.text || "";
          toolsUsed = (orchRes?.toolCalls || []).map((tc) => tc.name);
        } catch (e) {
          console.warn("[chat-api] orchestrator failed, falling back:", e.message);
          replyText = await callLLMWithContext(userMessage, context, llmOpts);
        }
      } else if (wantsDiagnose) {
        try {
          const agentRes = await runAgent({
            userMessage,
            contextHint: {
              problemPods: hintPods,
              correlations: context.correlations || [],
              targetPod: context.targetPod || null,
            },
            llmOpts,
          });
          replyText = agentRes?.text || (await callLLMWithContext(userMessage, context, llmOpts));
          toolsUsed = (agentRes?.toolCalls || []).map((tc) => tc.name);
        } catch (e) {
          console.warn("[chat-api] agent loop failed, falling back:", e.message);
          replyText = await callLLMWithContext(userMessage, context, llmOpts);
        }
      } else {
        replyText = await callLLMWithContext(userMessage, context, llmOpts);
      }
      return { context, replyText, toolsUsed };
    });
    let { context, replyText: reply, toolsUsed = [] } = traced;
    intentsForLog = Array.isArray(context?.intents) ? context.intents : Object.keys(context || {});

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
      toolsUsed: toolsUsed || [],
    };
    cacheSet(cacheKey, payload, CHAT_CACHE_TTL).catch(() => {});
    if (conversationId) {
      histAddMessage(conversationId, {
        role: "assistant",
        content: reply,
        provider: activeProvider,
      }).catch(() => {});
    }
    updateMemory(conversationId, memoryPatchFromParse(parsed)).catch(() => {});

    observeHistogram("mcp_chat_latency_seconds", { provider: activeProvider }, (Date.now() - startedAt) / 1000);
    json(res, 200, { ...payload, cached: false, conversationId });
  } catch (err) {
    console.error("Chat API error:", err);
    json(res, 500, { error: err.message });
  } finally {
    clearRemoteCluster();
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
// POST /api/chat/compare — Multi-LLM comparison
// Sends the same message to 2-3 providers in parallel and returns all results.
// ---------------------------------------------------------------------------
export async function handleChatCompareAPI(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const { message, providers, conversationId } = body;

    if (!message) return json(res, 400, { error: "Missing 'message' field" });
    if (!Array.isArray(providers) || providers.length < 1 || providers.length > 3) {
      return json(res, 400, { error: "Provide 1-3 providers in the 'providers' array" });
    }

    // Remote cluster override
    if (body.cluster && body.cluster !== "local") {
      const agents = getConnectedAgents();
      const agent = agents.get(body.cluster);
      if (agent && agent.apiUrl && agent.token) {
        setRemoteCluster(agent.apiUrl, agent.token);
      }
    }

    // Gather cluster context once, shared across all providers
    const context = await gatherClusterContext(message);
    const contextStr = JSON.stringify(context, null, 2);
    const userContent = `${message}\n\n--- Live Cluster Data ---\n${contextStr}`;

    // Send to all providers in parallel
    const promises = providers.map(async (prov) => {
      const provStart = Date.now();
      try {
        const r = await callLLM({
          messages: [{ role: "user", content: userContent }],
          system: SYSTEM_PROMPT,
          maxTokens: 2000,
          temperature: 0.3,
          provider: prov.provider,
          apiKey: prov.apiKey,
          apiUrl: prov.apiUrl,
          model: prov.model,
          azureDeployment: prov.azureDeployment,
          azureApiVersion: prov.azureApiVersion,
        });
        const reply = r.text || "";
        return {
          provider: prov.provider,
          model: prov.model,
          reply,
          durationMs: Date.now() - provStart,
          tokenEstimate: Math.ceil(reply.length / 4),
        };
      } catch (err) {
        return {
          provider: prov.provider,
          model: prov.model,
          reply: "",
          durationMs: Date.now() - provStart,
          tokenEstimate: 0,
          error: err.message,
        };
      }
    });

    const settled = await Promise.allSettled(promises);
    const results = settled.map((s) =>
      s.status === "fulfilled"
        ? s.value
        : { provider: "unknown", model: "", reply: "", durationMs: 0, tokenEstimate: 0, error: s.reason?.message || "Unknown error" }
    );

    return json(res, 200, {
      results,
      conversationId: conversationId || null,
    });
  } catch (err) {
    console.error("[chat-compare] error:", err);
    return json(res, 500, { error: err.message });
  } finally {
    clearRemoteCluster();
  }
}

// ---------------------------------------------------------------------------
// POST /api/chat/investigate — Deep Investigation mode using agent loop
// ---------------------------------------------------------------------------
export async function handleChatInvestigateAPI(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const { message, provider, apiKey, apiUrl, model, conversationId, history } = body;

    if (!message) return json(res, 400, { error: "Missing 'message' field" });

    // Remote cluster override
    if (body.cluster && body.cluster !== "local") {
      const agents = getConnectedAgents();
      const agent = agents.get(body.cluster);
      if (agent && agent.apiUrl && agent.token) {
        setRemoteCluster(agent.apiUrl, agent.token);
      }
    }

    const llmOpts = {};
    if (provider) llmOpts.provider = provider;
    if (apiKey) llmOpts.apiKey = apiKey;
    if (apiUrl) llmOpts.apiUrl = apiUrl;
    if (model) llmOpts.model = model;

    // Build context hint from cluster
    let contextHint = null;
    try {
      const ctx = await gatherClusterContext(message);
      contextHint = {
        problemPods: (ctx.problemPods || []).slice(0, 5),
        correlations: ctx.correlations || [],
      };
    } catch (e) {
      console.warn("[chat-investigate] context gathering failed:", e.message);
    }

    // Build initial user message with history prepended for the agent loop
    let userMsg = message;
    if (Array.isArray(history) && history.length > 0) {
      const historyContext = history.slice(-10).map((h) =>
        `${h.role === "ai" ? "Assistant" : "User"}: ${h.text}`
      ).join("\n");
      userMsg = `Previous conversation:\n${historyContext}\n\nCurrent question: ${message}`;
    }

    const stepsCollected = [];
    const useOrchestrator = getConnectionCount() > 0;
    const agentResult = useOrchestrator
      ? await runOrchestrator({
          userMessage: userMsg,
          contextHint,
          llmOpts,
          onStep: (stepInfo) => stepsCollected.push(stepInfo),
        })
      : await runAgent({
          userMessage: userMsg,
          contextHint,
          llmOpts,
          onStep: (stepInfo) => stepsCollected.push(stepInfo),
        });

    const toolsUsed = [...new Set(
      (agentResult.toolCalls || []).map((tc) => tc.name).filter(Boolean)
    )];

    // Gather context keys from the context hint
    const contextKeys = contextHint ? Object.keys(contextHint) : [];

    return json(res, 200, {
      reply: agentResult.text || "",
      provider: provider || LLM_PROVIDER,
      steps: stepsCollected,
      toolsUsed,
      durationMs: Date.now() - startedAt,
      contextKeys,
      conversationId: conversationId || null,
    });
  } catch (err) {
    console.error("[chat-investigate] error:", err);
    return json(res, 500, { error: err.message });
  } finally {
    clearRemoteCluster();
  }
}

// ---------------------------------------------------------------------------
// POST /api/chat/runbook — AI Runbooks
// Pre-defined investigation workflows combining cluster API calls + LLM analysis
// ---------------------------------------------------------------------------
const RUNBOOK_DEFINITIONS = {
  "crashloop-diagnosis": {
    name: "CrashLoop Diagnosis",
    description: "Fetch CrashLoopBackOff pods, get logs, get events, analyze",
    steps: [
      { name: "fetch-crashloop-pods", description: "Find all CrashLoopBackOff pods" },
      { name: "fetch-pod-logs", description: "Get logs from affected pods" },
      { name: "fetch-events", description: "Get warning events" },
      { name: "analyze", description: "LLM analysis of findings" },
    ],
  },
  "security-hardening": {
    name: "Security Hardening",
    description: "Security assessment with per-namespace breakdown",
    steps: [
      { name: "scan-pods", description: "Scan pods for security issues" },
      { name: "check-network-policies", description: "Check NetworkPolicy coverage" },
      { name: "analyze", description: "Security analysis and recommendations" },
    ],
  },
  "pre-upgrade-check": {
    name: "Pre-Upgrade Check",
    description: "Check cluster version, operators, node health, pending updates, certificate expiry",
    steps: [
      { name: "cluster-version", description: "Check cluster version and update availability" },
      { name: "operators", description: "Check operator status" },
      { name: "node-health", description: "Verify node health" },
      { name: "certificates", description: "Check certificate expiry" },
      { name: "analyze", description: "Upgrade readiness analysis" },
    ],
  },
  "capacity-planning": {
    name: "Capacity Planning",
    description: "Node metrics, resource usage, growth projection",
    steps: [
      { name: "node-resources", description: "Gather node resource allocation" },
      { name: "pod-metrics", description: "Gather pod resource usage" },
      { name: "analyze", description: "Capacity analysis and projections" },
    ],
  },
  "network-troubleshoot": {
    name: "Network Troubleshoot",
    description: "Check NetworkPolicies, Services, Routes, DNS",
    steps: [
      { name: "network-policies", description: "List NetworkPolicies" },
      { name: "services", description: "Check Services" },
      { name: "routes", description: "Check Routes" },
      { name: "analyze", description: "Network analysis" },
    ],
  },
};

async function executeRunbook(runbookId, namespace, llmOpts) {
  const def = RUNBOOK_DEFINITIONS[runbookId];
  if (!def) throw new Error(`Unknown runbook: ${runbookId}`);

  const steps = [];

  if (runbookId === "crashloop-diagnosis") {
    // Step 1: Fetch CrashLoopBackOff pods
    let clbPods = [];
    try {
      const nsPath = namespace ? `/api/v1/namespaces/${namespace}/pods` : "/api/v1/pods";
      const pods = await ocpGet(nsPath);
      clbPods = (pods.items || []).filter((p) =>
        (p.status?.containerStatuses || []).some(
          (c) => c.state?.waiting?.reason === "CrashLoopBackOff"
        )
      );
      steps.push({ name: "fetch-crashloop-pods", status: "completed", data: { count: clbPods.length, pods: clbPods.slice(0, 10).map((p) => `${p.metadata.namespace}/${p.metadata.name}`) } });
    } catch (err) {
      steps.push({ name: "fetch-crashloop-pods", status: "error", data: { error: err.message } });
    }

    // Step 2: Fetch logs from affected pods (first 3)
    const logsData = [];
    for (const pod of clbPods.slice(0, 3)) {
      try {
        const logs = await fetchPodLogs(pod.metadata.namespace, pod.metadata.name, 40);
        logsData.push({ pod: pod.metadata.name, ns: pod.metadata.namespace, logs: logs.substring(0, 2000) });
      } catch (err) {
        logsData.push({ pod: pod.metadata.name, ns: pod.metadata.namespace, error: err.message });
      }
    }
    steps.push({ name: "fetch-pod-logs", status: "completed", data: logsData });

    // Step 3: Fetch warning events
    let events = [];
    try {
      const nsPath = namespace ? `/api/v1/namespaces/${namespace}/events` : "/api/v1/events";
      const evtData = await ocpGet(nsPath);
      events = (evtData.items || []).filter((e) => e.type === "Warning").slice(0, 20);
      steps.push({ name: "fetch-events", status: "completed", data: { count: events.length } });
    } catch (err) {
      steps.push({ name: "fetch-events", status: "error", data: { error: err.message } });
    }

    // Step 4: LLM analysis
    const analysisPrompt = `Analyze these CrashLoopBackOff findings and provide diagnosis:\n\nAffected pods: ${JSON.stringify(steps[0].data)}\n\nPod logs: ${JSON.stringify(logsData).slice(0, 3000)}\n\nWarning events: ${JSON.stringify(events.slice(0, 10)).slice(0, 2000)}`;
    steps.push(await runAnalysisStep(analysisPrompt, llmOpts));

  } else if (runbookId === "security-hardening") {
    // Step 1: Scan pods for security issues
    try {
      const pods = await ocpGet(namespace ? `/api/v1/namespaces/${namespace}/pods` : "/api/v1/pods");
      const items = (pods.items || []).filter((p) =>
        !p.metadata.namespace?.startsWith("openshift-") && !p.metadata.namespace?.startsWith("kube-")
      );
      let privileged = 0, runAsRoot = 0, noLimits = 0, latestTag = 0;
      for (const p of items) {
        for (const c of (p.spec?.containers || [])) {
          if (c.securityContext?.privileged) privileged++;
          if (!c.securityContext?.runAsNonRoot && !p.spec?.securityContext?.runAsNonRoot) runAsRoot++;
          if (!c.resources?.limits?.cpu && !c.resources?.limits?.memory) noLimits++;
          const img = c.image || "";
          if (img.endsWith(":latest") || !img.includes(":")) latestTag++;
        }
      }
      steps.push({ name: "scan-pods", status: "completed", data: { totalPods: items.length, privileged, runAsRoot, noLimits, latestTag } });
    } catch (err) {
      steps.push({ name: "scan-pods", status: "error", data: { error: err.message } });
    }

    // Step 2: Check NetworkPolicy coverage
    try {
      const nsList = namespace
        ? [{ metadata: { name: namespace } }]
        : ((await ocpGet("/api/v1/namespaces")).items || []).filter((ns) =>
            !ns.metadata.name.startsWith("openshift-") && !ns.metadata.name.startsWith("kube-")
          );
      let covered = 0, uncovered = 0;
      for (const ns of nsList.slice(0, 20)) {
        try {
          const np = await ocpGet(`/apis/networking.k8s.io/v1/namespaces/${ns.metadata.name}/networkpolicies`);
          if (np.items && np.items.length > 0) covered++;
          else uncovered++;
        } catch { uncovered++; }
      }
      steps.push({ name: "check-network-policies", status: "completed", data: { covered, uncovered } });
    } catch (err) {
      steps.push({ name: "check-network-policies", status: "error", data: { error: err.message } });
    }

    // Step 3: LLM analysis
    const analysisPrompt = `Provide a security hardening analysis for this OpenShift cluster:\n\n${JSON.stringify(steps).slice(0, 4000)}`;
    steps.push(await runAnalysisStep(analysisPrompt, llmOpts));

  } else if (runbookId === "pre-upgrade-check") {
    // Step 1: Cluster version
    try {
      const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
      steps.push({ name: "cluster-version", status: "completed", data: {
        version: cv.status?.desired?.version,
        channel: cv.spec?.channel,
        availableUpdates: (cv.status?.availableUpdates || []).length,
        conditions: (cv.status?.conditions || []).map((c) => ({ type: c.type, status: c.status, message: c.message?.substring(0, 100) })),
      }});
    } catch (err) {
      steps.push({ name: "cluster-version", status: "error", data: { error: err.message } });
    }

    // Step 2: Operators
    try {
      const ops = await ocpGet("/apis/config.openshift.io/v1/clusteroperators");
      const items = ops.items || [];
      const degraded = items.filter((o) =>
        (o.status?.conditions || []).some((c) => c.type === "Degraded" && c.status === "True")
      );
      steps.push({ name: "operators", status: "completed", data: {
        total: items.length,
        degraded: degraded.length,
        degradedNames: degraded.map((o) => o.metadata.name),
      }});
    } catch (err) {
      steps.push({ name: "operators", status: "error", data: { error: err.message } });
    }

    // Step 3: Node health
    try {
      const nodes = await ocpGet("/api/v1/nodes");
      const items = nodes.items || [];
      const ready = items.filter((n) =>
        (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True")
      );
      steps.push({ name: "node-health", status: "completed", data: {
        total: items.length,
        ready: ready.length,
        notReady: items.length - ready.length,
      }});
    } catch (err) {
      steps.push({ name: "node-health", status: "error", data: { error: err.message } });
    }

    // Step 4: Certificate expiry (check kube-apiserver certs)
    try {
      const secrets = await ocpGet("/api/v1/namespaces/openshift-kube-apiserver/secrets");
      const certSecrets = (secrets.items || []).filter((s) =>
        s.type === "kubernetes.io/tls" || s.metadata.name.includes("cert")
      );
      steps.push({ name: "certificates", status: "completed", data: { certCount: certSecrets.length } });
    } catch (err) {
      steps.push({ name: "certificates", status: "completed", data: { certCount: 0, note: "Could not access certificate secrets" } });
    }

    // Step 5: LLM analysis
    const analysisPrompt = `Analyze this OpenShift cluster pre-upgrade readiness:\n\n${JSON.stringify(steps).slice(0, 4000)}`;
    steps.push(await runAnalysisStep(analysisPrompt, llmOpts));

  } else if (runbookId === "capacity-planning") {
    // Step 1: Node resources
    try {
      const nodes = await ocpGet("/api/v1/nodes");
      const items = nodes.items || [];
      let totalCpu = 0, totalMemBytes = 0;
      for (const n of items) {
        totalCpu += parseInt(n.status?.capacity?.cpu || "0", 10);
        const mem = n.status?.capacity?.memory || "0";
        if (mem.endsWith("Ki")) totalMemBytes += parseInt(mem) * 1024;
        else if (mem.endsWith("Mi")) totalMemBytes += parseInt(mem) * 1024 * 1024;
        else if (mem.endsWith("Gi")) totalMemBytes += parseInt(mem) * 1024 * 1024 * 1024;
      }
      steps.push({ name: "node-resources", status: "completed", data: {
        nodeCount: items.length,
        totalCpu,
        totalMemGi: Math.round(totalMemBytes / (1024 * 1024 * 1024)),
      }});
    } catch (err) {
      steps.push({ name: "node-resources", status: "error", data: { error: err.message } });
    }

    // Step 2: Pod metrics
    try {
      const metrics = await ocpGet("/apis/metrics.k8s.io/v1beta1/pods");
      const items = metrics.items || [];
      steps.push({ name: "pod-metrics", status: "completed", data: { totalPods: items.length } });
    } catch (err) {
      steps.push({ name: "pod-metrics", status: "completed", data: { totalPods: 0, note: "Metrics server unavailable" } });
    }

    // Step 3: LLM analysis
    const analysisPrompt = `Provide capacity planning analysis and growth projections:\n\n${JSON.stringify(steps).slice(0, 4000)}`;
    steps.push(await runAnalysisStep(analysisPrompt, llmOpts));

  } else if (runbookId === "network-troubleshoot") {
    const ns = namespace;

    // Step 1: Network Policies
    try {
      const path = ns
        ? `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`
        : "/apis/networking.k8s.io/v1/networkpolicies";
      const np = await ocpGet(path);
      steps.push({ name: "network-policies", status: "completed", data: {
        count: (np.items || []).length,
        policies: (np.items || []).slice(0, 10).map((p) => ({
          name: p.metadata.name,
          namespace: p.metadata.namespace,
        })),
      }});
    } catch (err) {
      steps.push({ name: "network-policies", status: "error", data: { error: err.message } });
    }

    // Step 2: Services
    try {
      const path = ns ? `/api/v1/namespaces/${ns}/services` : "/api/v1/services";
      const svc = await ocpGet(path);
      const items = (svc.items || []).filter((s) =>
        !s.metadata.namespace?.startsWith("openshift-") && !s.metadata.namespace?.startsWith("kube-")
      );
      steps.push({ name: "services", status: "completed", data: { count: items.length } });
    } catch (err) {
      steps.push({ name: "services", status: "error", data: { error: err.message } });
    }

    // Step 3: Routes
    try {
      const path = ns
        ? `/apis/route.openshift.io/v1/namespaces/${ns}/routes`
        : "/apis/route.openshift.io/v1/routes";
      const routes = await ocpGet(path);
      const items = (routes.items || []).filter((r) =>
        !r.metadata.namespace?.startsWith("openshift-") && !r.metadata.namespace?.startsWith("kube-")
      );
      steps.push({ name: "routes", status: "completed", data: {
        count: items.length,
        routes: items.slice(0, 10).map((r) => ({
          name: r.metadata.name,
          namespace: r.metadata.namespace,
          host: r.spec?.host,
        })),
      }});
    } catch (err) {
      steps.push({ name: "routes", status: "error", data: { error: err.message } });
    }

    // Step 4: LLM analysis
    const analysisPrompt = `Analyze network configuration and troubleshoot potential issues:\n\n${JSON.stringify(steps).slice(0, 4000)}`;
    steps.push(await runAnalysisStep(analysisPrompt, llmOpts));
  }

  return steps;
}

async function runAnalysisStep(prompt, llmOpts) {
  const provider = llmOpts?.provider || LLM_PROVIDER;
  if (!provider || provider === "none") {
    return { name: "analyze", status: "completed", data: { analysis: "No LLM provider configured. Raw data is available in the steps above." } };
  }
  try {
    const r = await callLLM({
      messages: [{ role: "user", content: prompt }],
      system: "You are an OpenShift SRE assistant. Analyze the provided data and give a clear, actionable summary.",
      maxTokens: 2000,
      temperature: 0.3,
      ...llmOpts,
    });
    return { name: "analyze", status: "completed", data: { analysis: r.text || "" } };
  } catch (err) {
    return { name: "analyze", status: "error", data: { error: err.message } };
  }
}

export async function handleChatRunbookAPI(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const { runbook, namespace, provider, apiKey, apiUrl, model, conversationId } = body;

    if (!runbook) return json(res, 400, { error: "Missing 'runbook' field" });
    if (!RUNBOOK_DEFINITIONS[runbook]) {
      return json(res, 400, {
        error: `Unknown runbook: ${runbook}`,
        available: Object.keys(RUNBOOK_DEFINITIONS),
      });
    }

    const llmOpts = {};
    if (provider) llmOpts.provider = provider;
    if (apiKey) llmOpts.apiKey = apiKey;
    if (apiUrl) llmOpts.apiUrl = apiUrl;
    if (model) llmOpts.model = model;

    const steps = await executeRunbook(runbook, namespace || null, llmOpts);

    // Build reply from the analysis step
    const analysisStep = steps.find((s) => s.name === "analyze");
    const reply = analysisStep?.data?.analysis || `Runbook "${runbook}" completed. See steps for raw data.`;

    return json(res, 200, {
      reply,
      runbook,
      steps,
      durationMs: Date.now() - startedAt,
      conversationId: conversationId || null,
    });
  } catch (err) {
    console.error("[chat-runbook] error:", err);
    return json(res, 500, { error: err.message });
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

    if (action === "patch_deployment" || action === "patch") {
      const dep = deployment || pod;
      const patchBody = body.patchBody || body.options?.patchBody;
      if (!dep) return json(res, 400, { success: false, error: "Missing deployment name" });
      if (!patchBody) return json(res, 400, { success: false, error: "Missing patch body" });
      let patch;
      try { patch = typeof patchBody === "string" ? JSON.parse(patchBody) : patchBody; }
      catch { return json(res, 400, { success: false, error: "Invalid JSON in patch body" }); }
      await ocpPatch(
        `/apis/apps/v1/namespaces/${namespace}/deployments/${dep}`,
        patch
      );
      success = true;
      resultPayload = { message: `Deployment '${dep}' patched in '${namespace}'.` };
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
