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

import { gzipSync } from "node:zlib";
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
  enterRemoteClusterBridge,
  withRemoteClusterBridge,
} from "../utils/openshift-client.js";
import { getConnectedAgents, getAgentCachedResponse, invokeAgentTool, hasActiveChannel } from "../index.js";
import { cacheGet, cacheSet, isEnabled as cacheEnabled } from "../utils/cache.js";
import {
  addMessage as histAddMessage,
  logQuery as histLogQuery,
  logExecutedAction as histLogExecutedAction,
  isHistoryEnabled,
} from "./chat-history.js";
import { parse as nluParse, describeParse } from "./nlu.js";
import { getPendingCRs } from "./cr-tracker.js";
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
import { createIncident as createServiceNowIncident, resolveIncident as snowResolveIncident } from "../utils/servicenow-client.js";
import { notifyAll } from "./integrations.js";
import { callLLM, callLLMStream, llmEnabled } from "./llm.js";
import { resolveLLMOpts } from "./dashboard-api.js";
import { diagnosePod } from "./pod-doctor.js";
import { runAgent } from "./agent-loop.js";
import { runOrchestrator } from "./mcp-orchestrator.js";
import { getConnectionCount } from "./mcp-hub.js";
import { getAgentsByTool, getAgents } from "../agents/registry.js";
import { findSimilar as kbFindSimilar, buildKBContext, recordResolution } from "./knowledge-base.js";
import {
  buildSignature as leBuildSignature,
  findSimilarIncidents as leFindSimilarIncidents,
  buildLearningContext as leBuildLearningContext,
  getTeamPlaybook as leGetTeamPlaybook,
  getIncidentStats as leGetIncidentStats,
} from "./learning-engine.js";
import { maybeEnhance as nluEnhanceWithLLM } from "./nlu-llm.js";
import { getPlatform } from "../platform/index.js";
import { summarizeIfNeeded } from "./summarizer.js";
import { suggestPlaybook, renderPlaybookMarkdown } from "./playbooks.js";
import { findResource } from "./resource-index.js";
import { fetchPodStatus } from "./fix-executor.js";
import { incCounter, observeHistogram } from "./metrics.js";
import { enforce as enforceRateLimit } from "./rate-limit.js";
import { runPreflightChecks, formatPreflightReport, checkCertificateExpiry, validateUpgradeVersion } from "../tools/upgrade-preflight.js";
import { generateTraceId, recordTrace } from "./query-tracer.js";
import { compressContext, buildDiagnosticBrief, buildTieredContext } from "./context-optimizer.js";
import { getFewShotExamples } from "./few-shot-examples.js";
import { tryShortcut } from "./intent-shortcuts.js";
import { lookupError, findMatchingErrors, getErrorsForReason } from "./error-knowledge.js";
import { buildIncidentContext, recordIncidentResolution } from "./incident-rag.js";
import { buildPlatformPromptSection, getPlatformCommands } from "../platform/intent-router.js";

// Build agent trace: maps tools used in a chat response back to their owning agents.
async function buildAgentTrace(toolsUsed, contextKeys, durationMs) {
  if (!toolsUsed || toolsUsed.length === 0) {
    const allAgents = await getAgents().catch(() => []);
    const relevant = inferAgentsFromContext(allAgents, contextKeys || []);
    return relevant.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      icon: a.icon,
      color: a.color,
      category: a.category,
      toolsCalled: [],
      status: "consulted",
    }));
  }
  const agentMap = new Map();
  for (const toolName of toolsUsed) {
    const agents = await getAgentsByTool(toolName).catch(() => []);
    for (const a of agents) {
      if (!agentMap.has(a.id)) {
        agentMap.set(a.id, {
          agentId: a.id,
          agentName: a.name,
          icon: a.icon,
          color: a.color,
          category: a.category,
          toolsCalled: [],
          status: "active",
        });
      }
      agentMap.get(a.id).toolsCalled.push(toolName);
    }
  }
  return Array.from(agentMap.values());
}

function inferAgentsFromContext(agents, contextKeys) {
  const keyStr = contextKeys.join(" ").toLowerCase();
  const hints = {
    "diagnostics-healing": /pod|crash|error|event|diagnos|health/,
    "cluster-operations": /node|cluster|version|health|capacity/,
    "upgrade-lifecycle": /upgrade|preflight|channel|version/,
    "workload-management": /deploy|replica|scale|workload|hpa/,
    "networking-mesh": /network|service|route|ingress|mesh/,
    "security-compliance": /security|rbac|scc|policy|compliance/,
    "observability": /metric|alert|prometheus|monitor|log/,
    "itsm-change-management": /servicenow|change|incident|cr|itsm/,
    "cicd-gitops": /git|argocd|pipeline|tekton|cicd/,
    "multi-cluster-acm": /acm|multi.?cluster|hub|managed/,
    "infrastructure-virtualization": /vm|kubevirt|virtual|storage/,
    "proactive-intelligence": /proactive|recommend|intelligence|forecast/,
  };
  return agents.filter((a) => {
    const re = hints[a.id];
    return re && re.test(keyStr);
  });
}

// In-memory cache: conversationId → most recent preflight report.
// Allows "raise a CR with above precheck details" to retrieve the report
// even though it was generated in a previous chat turn.
const _preflightCache = new Map();
const PREFLIGHT_CACHE_MAX = 200;

// Defense-in-depth: cap heavy arrays before JSON serialization. With the
// current 1Gi pod limit these caps shouldn't trigger for typical clusters,
// but they protect against pathological cases (e.g., 200+ operators).
function lightPreflightReport(report) {
  if (!report) return report;
  const light = { ...report };
  if (light.allClusterOperators) {
    light.allClusterOperators = light.allClusterOperators.slice(0, 100);
  }
  if (light.allOLMOperators) {
    light.allOLMOperators = light.allOLMOperators.slice(0, 100);
  }
  if (light.nodeTopology?.nodeDetails) {
    light.nodeTopology = { ...light.nodeTopology, nodeDetails: light.nodeTopology.nodeDetails.slice(0, 50) };
  }
  if (light.versionDelta?.apiRemovals) {
    light.versionDelta = { ...light.versionDelta, apiRemovals: light.versionDelta.apiRemovals.slice(0, 50) };
  }
  if (light.checks) {
    light.checks = light.checks.map(c => ({
      ...c,
      items: c.items ? c.items.slice(0, 50) : c.items,
    }));
  }
  return light;
}

const PREFLIGHT_TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_MS) || 90000;

async function runPreflightWithTimeout(targetVer, currentVer) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Preflight check timed out after ${PREFLIGHT_TIMEOUT_MS / 1000}s`)), PREFLIGHT_TIMEOUT_MS)
  );
  return Promise.race([
    runPreflightChecks(targetVer, currentVer),
    timeout,
  ]);
}

function cachePreflightReport(conversationId, report) {
  if (!conversationId || !report) return;
  _preflightCache.set(conversationId, { report, ts: Date.now() });
  if (_preflightCache.size > PREFLIGHT_CACHE_MAX) {
    const oldest = [..._preflightCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _preflightCache.delete(oldest[0]);
  }
}
function getCachedPreflightReport(conversationId) {
  if (!conversationId) return null;
  const entry = _preflightCache.get(conversationId);
  if (!entry) return null;
  if (Date.now() - entry.ts > 30 * 60 * 1000) { _preflightCache.delete(conversationId); return null; }
  return entry.report;
}

// Track submitted upgrade CRs per conversation+cluster for approval monitoring.
const _submittedCRs = new Map();
export function trackSubmittedCR(conversationId, crInfo) {
  if (!conversationId || !crInfo) return;
  const key = `${conversationId}:${crInfo.cluster || "local"}`;
  _submittedCRs.set(key, { ...crInfo, ts: Date.now() });
}
function getTrackedCR(conversationId, cluster) {
  if (!conversationId) return null;
  const key = `${conversationId}:${cluster || "local"}`;
  const entry = _submittedCRs.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > 24 * 60 * 60 * 1000) { _submittedCRs.delete(key); return null; }
  return entry;
}

// Resilient CR resolution for chat. The in-memory map is fast but volatile
// (lost on restart, or never populated if conversationId wasn't passed at
// submit time). Fall back to the persistent CR tracker so "check CR status"
// works reliably and can also resolve an explicit CHG number from the message.
async function resolveTrackedCR(conversationId, cluster, userMessage) {
  const mem = getTrackedCR(conversationId, cluster);
  if (mem && mem.sysId) return mem;
  try {
    const { getCR, listCRs } = await import("./cr-tracker.js");
    const explicit = (userMessage.match(/CHG\d{7}/i) || [])[0] || (userMessage.match(/CR-[A-Z0-9]+/i) || [])[0];
    if (explicit) {
      const cr = await getCR(explicit);
      if (cr) return cr;
    }
    const crs = await listCRs({ limit: 25 });
    const pick =
      crs.find((c) => c.conversationId === conversationId && (c.targetVersion || c.upgradeType)) ||
      crs.find((c) => c.conversationId === conversationId) ||
      crs.find((c) => c.targetVersion || c.upgradeType) ||
      crs[0];
    if (pick) return pick;
  } catch { /* persistent tracker optional */ }
  return mem || null;
}

// Map an NLU intent to the legacy "operation" string used by the response
// handlers below, plus a few normalizations.
// Common English words the NLU sometimes mistakes for resource/namespace names
// when the user pastes a tool description ("a specific pod in the specified
// namespace"). Reject them so we don't fire bogus 404 lookups.
const NLU_BAD_NAMES = new Set([
  // Pronouns & determiners
  "specific", "specified", "all", "some", "any", "each", "every",
  "the", "this", "that", "those", "these", "an", "a",
  "which", "what", "where", "when", "how", "why", "who",
  "here", "there", "now", "then", "your", "their", "our", "my", "its",
  "current", "given", "selected", "chosen", "available",
  // Status words (also valid as filters, not names)
  "running", "pending", "failed", "completed", "terminating", "evicted",
  "healthy", "unhealthy", "degraded", "ready", "notready",
  // Adjectives that describe metrics/state (never resource names)
  "high", "low", "heavy", "light", "idle", "busy", "slow", "fast",
  "big", "small", "large", "huge", "tiny", "biggest", "smallest",
  "most", "least", "highest", "lowest", "maximum", "minimum",
  "top", "bottom", "best", "worst", "more", "less", "fewer",
  "old", "new", "oldest", "newest", "recent", "latest", "first", "last",
  "total", "overall", "average", "mean", "median",
  "critical", "warning", "info", "normal", "abnormal",
  "excessive", "insufficient", "saturated", "overloaded", "underutilized",
  // Common nouns that aren't resource names
  "name", "names", "value", "values", "status", "state", "phase",
  "usage", "consumption", "utilization", "resource", "resources",
  "expiry", "expiring", "expired", "expiration", "renewal", "validity",
  "readiness", "assessment", "forecast", "capacity", "paths", "history",
  "restarts", "restart", "count", "available", "unavailable", "ready",
  "healthy", "unhealthy", "degraded", "failing", "failed", "issues",
  "cpu", "memory", "mem", "ram", "disk", "storage", "network",
  "cluster", "clusters", "overview", "summary", "report", "detail", "details",
  // Prepositions & conjunctions
  "in", "on", "at", "to", "for", "from", "with", "without", "by",
  "and", "or", "not", "but", "of", "about", "above", "below",
  // Verbs that might get captured as names
  "show", "list", "get", "find", "check", "see", "display", "view",
  "using", "consuming", "utilizing", "running", "having", "taking",
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
  // Tier 1 new verbs — map to operation strings used by directives below
  else if (p.intent === "drain") operation = "drain";
  else if (p.intent === "cordon") operation = "cordon";
  else if (p.intent === "uncordon") operation = "uncordon";
  else if (p.intent === "taint") operation = "taint";
  else if (p.intent === "untaint") operation = "untaint";
  else if (p.intent === "label") operation = "label";
  else if (p.intent === "annotate") operation = "annotate";
  else if (p.intent === "evict") operation = "evict";
  else if (p.intent === "rollback") operation = "rollback";
  else if (p.intent === "rollout") operation = "rollout";
  else if (p.intent === "rbac") operation = "rbac";
  else if (p.intent === "approve") operation = "approve";
  else if (p.intent === "export") operation = "export";
  else if (p.intent === "compare") operation = "compare";
  else if (p.intent === "snapshot") operation = "snapshot";
  else if (p.intent === "resize") operation = "resize";
  // Sprint C: conversational AI intents
  else if (p.intent === "bulk") operation = "bulk";
  else if (p.intent === "changes") operation = "changes";
  else if (p.intent === "forecast") operation = "forecast";
  else if (p.intent === "kb") operation = "kb";
  else if (p.intent === "provision") operation = "provision";
  // Tier 5-8: expanded MCP intents
  else if (p.intent === "alerts") operation = "alerts";
  else if (p.intent === "gitops") operation = "gitops";
  else if (p.intent === "imagescan") operation = "imagescan";
  else if (p.intent === "backup") operation = "backup";
  else if (p.intent === "mustgather") operation = "mustgather";
  else if (p.intent === "fleet") operation = "fleet";
  else if (p.intent === "compliance") operation = "compliance";
  else if (p.intent === "automation") operation = "automation";
  else if (p.intent === "optimize") operation = "optimize";
  else if (p.intent === "network") operation = "network";
  else if (p.intent === "identity") operation = "identity";
  else if (p.intent === "certlife") operation = "certlife";
  // Tier 9-12: global industry standard intents
  else if (p.intent === "slo") operation = "slo";
  else if (p.intent === "saturation") operation = "saturation";
  else if (p.intent === "incident") operation = "incident";
  else if (p.intent === "postmortem") operation = "postmortem";
  else if (p.intent === "impact") operation = "impact";
  else if (p.intent === "deprecated") operation = "deprecated";
  else if (p.intent === "webhook") operation = "webhook";
  else if (p.intent === "supplychain") operation = "supplychain";
  else if (p.intent === "imagestale") operation = "imagestale";
  else if (p.intent === "hardening") operation = "hardening";
  else if (p.intent === "podsecurity") operation = "podsecurity";
  else if (p.intent === "capacity") operation = "capacity";
  else if (p.intent === "mcpdrift") operation = "mcpdrift";
  else if (p.intent === "pdb") operation = "pdb";
  else if (p.intent === "topology") operation = "topology";
  else if (p.intent === "probes") operation = "probes";
  else if (p.intent === "hpa") operation = "hpa";
  else if (p.intent === "orphaned") operation = "orphaned";
  else if (p.intent === "governance") operation = "governance";
  else if (p.intent === "incident_response") operation = "incident_response";
  else if (p.intent === "cluster_briefing") operation = "cluster_briefing";
  else if (p.intent === "diagnose") operation = "diagnose";
  // Superlative queries about cpu/memory should use the "top" handler which
  // fetches real metrics from metrics.k8s.io and sorts.  The NLU may classify
  // "which pod uses the most CPU" as intent:"list" (because of "which"), but
  // the right handler is "top".  Also clear the resource name since superlative
  // queries want all pods sorted, not a specific pod by name.
  const adv = p.advFilters || {};
  if (adv.superlative && (adv.superlative.metric === "cpu" || adv.superlative.metric === "memory")) {
    const rt = p.resource;
    if (!rt || rt === "pod" || rt === "pods" || rt === "node" || rt === "nodes") {
      operation = "top";
      p.name = null;
    }
  }

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
    raw: p.raw,
    advFilters: p.advFilters || null,
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

function _formatAge(date) {
  const ms = Date.now() - date.getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}

// ---------------------------------------------------------------------------
// Cache config — TTL in seconds for cached chat replies / cluster context
// ---------------------------------------------------------------------------
const CHAT_CACHE_TTL = parseInt(process.env.CHAT_CACHE_TTL || "300", 10);
const CONTEXT_CACHE_TTL = parseInt(process.env.CONTEXT_CACHE_TTL || "120", 10);

// Pre-computed cluster digest — per-cluster, refreshed by agent reports.
// Keyed by cluster name to prevent cross-cluster data bleed.
const _clusterDigests = new Map();

export function updateClusterDigest(info) {
  const key = info.cluster || "local";
  _clusterDigests.set(key, {
    version: info.version,
    channel: info.channel,
    platform: info.platform || "kubernetes",
    nodeCount: info.nodeCount,
    readyNodes: info.readyNodes,
    ts: Date.now(),
  });
}

function getClusterDigest(cluster) {
  const key = cluster || "local";
  const d = _clusterDigests.get(key);
  if (!d || (Date.now() - d.ts > 60000)) return null;
  return d;
}

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
    "**OpenShift-native slash commands** (Tier 1)",
    "  - `/builds [ns]` — BuildConfigs & Build status",
    "  - `/imagestreams [ns]` — ImageStream inventory",
    "  - `/operators [ns]` — Subscriptions, InstallPlans, CSVs (OLM)",
    "  - `/machineconfigs` — MachineConfig & MachineConfigPool health",
    "  - `/scc` — SecurityContextConstraints inventory",
    "  - `/rbac [ns]` — Roles, RoleBindings, cluster-admin audit",
    "  - `/quotas [ns]` — ResourceQuotas, LimitRanges, PDBs",
    "  - `/certs` — Pending CertificateSigningRequests",
    "",
    "**Advanced slash commands** (Tier 2-3)",
    "  - `/export <resource> [ns] as yaml|json|csv` — dump resources in any format",
    "  - `/mesh` — Istio / OpenShift Service Mesh resources",
    "  - `/egress` — EgressIPs and Egress NetworkPolicies",
    "  - `/oauth` — OAuth clients, users, groups",
    "  - `/etcd` — etcd cluster health and member status",
    "  - `/plan <goal>` — decompose complex tasks into executable steps",
    "",
    "**Ecosystem operators** (Sprint B)",
    "  - `/compliance` — Compliance Operator (CIS, NIST, PCI scans)",
    "  - `/promrules` — PrometheusRule / ServiceMonitor inventory",
    "  - `/logging` — ClusterLogForwarder / LokiStack",
    "  - `/odf` — OpenShift Data Foundation / Ceph cluster health",
    "  - `/acm` — Advanced Cluster Management fleet",
    "  - `/hypershift` — Hosted Control Planes & NodePools",
    "  - `/baremetal` — BareMetalHosts & Assisted Installer",
    "  - `/performance` — PerformanceProfile & Tuned",
    "  - `/ai` — OpenShift AI (DataScienceCluster, Notebooks, KServe)",
    "  - `/metallb` — MetalLB IPAddressPool & BGPPeers",
    "  - `/webhooks` — Admission webhook controllers",
    "  - `/argocd` — ArgoCD Applications detailed view",
    "",
    "**Agentic AI features** (Sprint C+D)",
    "  - `/bulk <action>` — bulk cleanup (delete evicted, restart crashing)",
    "  - `/changes [duration]` — change timeline (recent events + audit)",
    "  - `/forecast` — capacity prediction & saturation runway",
    "  - `/kb <query>` — knowledge base / runbook search",
    "  - `/provision namespace X for team Y` — self-service onboarding",
    "  - `/incidents` — episodic memory of past incidents",
    "  - `/suggestions` — proactive recommendations ('I noticed X')",
    "  - `/approvals` — pending approval chain decisions",
    "  - `/reflect` — verify outcomes of recent actions",
    "",
    "**Advanced phrases I now understand** (Tier 2)",
    "  - `which pod uses the most CPU?` / `largest PVC` / `oldest pod`",
    "  - `pods stuck in Terminating` / `pods pending for more than 1 hour`",
    "  - `find pods without limits` / `deployments without PDB`",
    "  - `drain node X` / `cordon node X` / `taint node X`",
    "  - `rollback deployment X` / `rollout status of X`",
    "  - `who has cluster-admin?` / `permissions for user X`",
    "  - `compare namespace dev and prod`",
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

  // ---- Tier 1: OpenShift-native builds & images ----
  buildconfig:           { api: "/apis/build.openshift.io/v1", resource: "buildconfigs", namespaced: true },
  buildconfigs:          { api: "/apis/build.openshift.io/v1", resource: "buildconfigs", namespaced: true },
  bc:                    { api: "/apis/build.openshift.io/v1", resource: "buildconfigs", namespaced: true },
  build:                 { api: "/apis/build.openshift.io/v1", resource: "builds", namespaced: true },
  builds:                { api: "/apis/build.openshift.io/v1", resource: "builds", namespaced: true },
  imagestream:           { api: "/apis/image.openshift.io/v1", resource: "imagestreams", namespaced: true },
  imagestreams:          { api: "/apis/image.openshift.io/v1", resource: "imagestreams", namespaced: true },
  is:                    { api: "/apis/image.openshift.io/v1", resource: "imagestreams", namespaced: true },
  imagestreamtag:        { api: "/apis/image.openshift.io/v1", resource: "imagestreamtags", namespaced: true },
  imagestreamtags:       { api: "/apis/image.openshift.io/v1", resource: "imagestreamtags", namespaced: true },
  istag:                 { api: "/apis/image.openshift.io/v1", resource: "imagestreamtags", namespaced: true },
  deploymentconfig:      { api: "/apis/apps.openshift.io/v1", resource: "deploymentconfigs", namespaced: true },
  deploymentconfigs:     { api: "/apis/apps.openshift.io/v1", resource: "deploymentconfigs", namespaced: true },
  dc:                    { api: "/apis/apps.openshift.io/v1", resource: "deploymentconfigs", namespaced: true },

  // ---- Tier 1: OLM (operator lifecycle) ----
  subscription:          { api: "/apis/operators.coreos.com/v1alpha1", resource: "subscriptions", namespaced: true },
  subscriptions:         { api: "/apis/operators.coreos.com/v1alpha1", resource: "subscriptions", namespaced: true },
  subs:                  { api: "/apis/operators.coreos.com/v1alpha1", resource: "subscriptions", namespaced: true },
  installplan:           { api: "/apis/operators.coreos.com/v1alpha1", resource: "installplans", namespaced: true },
  installplans:          { api: "/apis/operators.coreos.com/v1alpha1", resource: "installplans", namespaced: true },
  ip:                    { api: "/apis/operators.coreos.com/v1alpha1", resource: "installplans", namespaced: true },
  operatorgroup:         { api: "/apis/operators.coreos.com/v1", resource: "operatorgroups", namespaced: true },
  operatorgroups:        { api: "/apis/operators.coreos.com/v1", resource: "operatorgroups", namespaced: true },
  og:                    { api: "/apis/operators.coreos.com/v1", resource: "operatorgroups", namespaced: true },
  clusterserviceversion: { api: "/apis/operators.coreos.com/v1alpha1", resource: "clusterserviceversions", namespaced: true },
  clusterserviceversions:{ api: "/apis/operators.coreos.com/v1alpha1", resource: "clusterserviceversions", namespaced: true },
  csv:                   { api: "/apis/operators.coreos.com/v1alpha1", resource: "clusterserviceversions", namespaced: true },
  csvs:                  { api: "/apis/operators.coreos.com/v1alpha1", resource: "clusterserviceversions", namespaced: true },

  // ---- Tier 1: MachineConfig ----
  machineconfig:         { api: "/apis/machineconfiguration.openshift.io/v1", resource: "machineconfigs", namespaced: false },
  machineconfigs:        { api: "/apis/machineconfiguration.openshift.io/v1", resource: "machineconfigs", namespaced: false },
  mc:                    { api: "/apis/machineconfiguration.openshift.io/v1", resource: "machineconfigs", namespaced: false },
  machineconfigpool:     { api: "/apis/machineconfiguration.openshift.io/v1", resource: "machineconfigpools", namespaced: false },
  machineconfigpools:    { api: "/apis/machineconfiguration.openshift.io/v1", resource: "machineconfigpools", namespaced: false },
  mcp:                   { api: "/apis/machineconfiguration.openshift.io/v1", resource: "machineconfigpools", namespaced: false },
  machinehealthcheck:    { api: "/apis/machine.openshift.io/v1beta1", resource: "machinehealthchecks", namespaced: true },
  machinehealthchecks:   { api: "/apis/machine.openshift.io/v1beta1", resource: "machinehealthchecks", namespaced: true },
  mhc:                   { api: "/apis/machine.openshift.io/v1beta1", resource: "machinehealthchecks", namespaced: true },

  // ---- Tier 1: Security ----
  scc:                   { api: "/apis/security.openshift.io/v1", resource: "securitycontextconstraints", namespaced: false },
  sccs:                  { api: "/apis/security.openshift.io/v1", resource: "securitycontextconstraints", namespaced: false },
  securitycontextconstraint:  { api: "/apis/security.openshift.io/v1", resource: "securitycontextconstraints", namespaced: false },
  securitycontextconstraints: { api: "/apis/security.openshift.io/v1", resource: "securitycontextconstraints", namespaced: false },

  // ---- Tier 1: RBAC ----
  role:                  { api: "/apis/rbac.authorization.k8s.io/v1", resource: "roles", namespaced: true },
  roles:                 { api: "/apis/rbac.authorization.k8s.io/v1", resource: "roles", namespaced: true },
  rolebinding:           { api: "/apis/rbac.authorization.k8s.io/v1", resource: "rolebindings", namespaced: true },
  rolebindings:          { api: "/apis/rbac.authorization.k8s.io/v1", resource: "rolebindings", namespaced: true },
  clusterrole:           { api: "/apis/rbac.authorization.k8s.io/v1", resource: "clusterroles", namespaced: false },
  clusterroles:          { api: "/apis/rbac.authorization.k8s.io/v1", resource: "clusterroles", namespaced: false },
  clusterrolebinding:    { api: "/apis/rbac.authorization.k8s.io/v1", resource: "clusterrolebindings", namespaced: false },
  clusterrolebindings:   { api: "/apis/rbac.authorization.k8s.io/v1", resource: "clusterrolebindings", namespaced: false },
  user:                  { api: "/apis/user.openshift.io/v1", resource: "users", namespaced: false },
  users:                 { api: "/apis/user.openshift.io/v1", resource: "users", namespaced: false },
  group:                 { api: "/apis/user.openshift.io/v1", resource: "groups", namespaced: false },
  groups:                { api: "/apis/user.openshift.io/v1", resource: "groups", namespaced: false },
  identity:              { api: "/apis/user.openshift.io/v1", resource: "identities", namespaced: false },
  identities:            { api: "/apis/user.openshift.io/v1", resource: "identities", namespaced: false },

  // ---- Tier 1: Quota / governance ----
  resourcequota:         { api: "/api/v1", resource: "resourcequotas", namespaced: true },
  resourcequotas:        { api: "/api/v1", resource: "resourcequotas", namespaced: true },
  quota:                 { api: "/api/v1", resource: "resourcequotas", namespaced: true },
  quotas:                { api: "/api/v1", resource: "resourcequotas", namespaced: true },
  clusterresourcequota:  { api: "/apis/quota.openshift.io/v1", resource: "clusterresourcequotas", namespaced: false },
  clusterresourcequotas: { api: "/apis/quota.openshift.io/v1", resource: "clusterresourcequotas", namespaced: false },
  crq:                   { api: "/apis/quota.openshift.io/v1", resource: "clusterresourcequotas", namespaced: false },
  limitrange:            { api: "/api/v1", resource: "limitranges", namespaced: true },
  limitranges:           { api: "/api/v1", resource: "limitranges", namespaced: true },
  poddisruptionbudget:   { api: "/apis/policy/v1", resource: "poddisruptionbudgets", namespaced: true },
  poddisruptionbudgets:  { api: "/apis/policy/v1", resource: "poddisruptionbudgets", namespaced: true },
  pdb:                   { api: "/apis/policy/v1", resource: "poddisruptionbudgets", namespaced: true },
  pdbs:                  { api: "/apis/policy/v1", resource: "poddisruptionbudgets", namespaced: true },

  // ---- Tier 1: CRDs / certificates / priority ----
  customresourcedefinition:  { api: "/apis/apiextensions.k8s.io/v1", resource: "customresourcedefinitions", namespaced: false },
  customresourcedefinitions: { api: "/apis/apiextensions.k8s.io/v1", resource: "customresourcedefinitions", namespaced: false },
  crd:                       { api: "/apis/apiextensions.k8s.io/v1", resource: "customresourcedefinitions", namespaced: false },
  crds:                      { api: "/apis/apiextensions.k8s.io/v1", resource: "customresourcedefinitions", namespaced: false },
  certificatesigningrequest:  { api: "/apis/certificates.k8s.io/v1", resource: "certificatesigningrequests", namespaced: false },
  certificatesigningrequests: { api: "/apis/certificates.k8s.io/v1", resource: "certificatesigningrequests", namespaced: false },
  csr:                       { api: "/apis/certificates.k8s.io/v1", resource: "certificatesigningrequests", namespaced: false },
  csrs:                      { api: "/apis/certificates.k8s.io/v1", resource: "certificatesigningrequests", namespaced: false },
  priorityclass:             { api: "/apis/scheduling.k8s.io/v1", resource: "priorityclasses", namespaced: false },
  priorityclasses:           { api: "/apis/scheduling.k8s.io/v1", resource: "priorityclasses", namespaced: false },

  // ---- Tier 2: Snapshots / CSI ----
  volumesnapshot:        { api: "/apis/snapshot.storage.k8s.io/v1", resource: "volumesnapshots", namespaced: true },
  volumesnapshots:       { api: "/apis/snapshot.storage.k8s.io/v1", resource: "volumesnapshots", namespaced: true },
  volumesnapshotclass:   { api: "/apis/snapshot.storage.k8s.io/v1", resource: "volumesnapshotclasses", namespaced: false },
  volumesnapshotclasses: { api: "/apis/snapshot.storage.k8s.io/v1", resource: "volumesnapshotclasses", namespaced: false },
  csidriver:             { api: "/apis/storage.k8s.io/v1", resource: "csidrivers", namespaced: false },
  csidrivers:            { api: "/apis/storage.k8s.io/v1", resource: "csidrivers", namespaced: false },

  // ---- Tier 3: Service mesh / networking ----
  virtualservice:        { api: "/apis/networking.istio.io/v1beta1", resource: "virtualservices", namespaced: true },
  virtualservices:       { api: "/apis/networking.istio.io/v1beta1", resource: "virtualservices", namespaced: true },
  destinationrule:       { api: "/apis/networking.istio.io/v1beta1", resource: "destinationrules", namespaced: true },
  destinationrules:      { api: "/apis/networking.istio.io/v1beta1", resource: "destinationrules", namespaced: true },
  gateway:               { api: "/apis/networking.istio.io/v1beta1", resource: "gateways", namespaced: true },
  gateways:              { api: "/apis/networking.istio.io/v1beta1", resource: "gateways", namespaced: true },
  egressip:              { api: "/apis/k8s.ovn.org/v1", resource: "egressips", namespaced: false },
  egressips:             { api: "/apis/k8s.ovn.org/v1", resource: "egressips", namespaced: false },
  egressnetworkpolicy:   { api: "/apis/network.openshift.io/v1", resource: "egressnetworkpolicies", namespaced: true },
  egressnetworkpolicies: { api: "/apis/network.openshift.io/v1", resource: "egressnetworkpolicies", namespaced: true },
  networkattachmentdefinition: { api: "/apis/k8s.cni.cncf.io/v1", resource: "network-attachment-definitions", namespaced: true },
  nad:                          { api: "/apis/k8s.cni.cncf.io/v1", resource: "network-attachment-definitions", namespaced: true },

  // ---- Tier 3: OAuth ----
  oauthclient:           { api: "/apis/oauth.openshift.io/v1", resource: "oauthclients", namespaced: false },
  oauthclients:          { api: "/apis/oauth.openshift.io/v1", resource: "oauthclients", namespaced: false },

  // ---- HPA / storage / network policy (top-level coverage) ----
  hpa:                   { api: "/apis/autoscaling/v2", resource: "horizontalpodautoscalers", namespaced: true },
  horizontalpodautoscaler:  { api: "/apis/autoscaling/v2", resource: "horizontalpodautoscalers", namespaced: true },
  horizontalpodautoscalers: { api: "/apis/autoscaling/v2", resource: "horizontalpodautoscalers", namespaced: true },
  storageclass:          { api: "/apis/storage.k8s.io/v1", resource: "storageclasses", namespaced: false },
  storageclasses:        { api: "/apis/storage.k8s.io/v1", resource: "storageclasses", namespaced: false },
  sc:                    { api: "/apis/storage.k8s.io/v1", resource: "storageclasses", namespaced: false },
  networkpolicy:         { api: "/apis/networking.k8s.io/v1", resource: "networkpolicies", namespaced: true },
  networkpolicies:       { api: "/apis/networking.k8s.io/v1", resource: "networkpolicies", namespaced: true },
  netpol:                { api: "/apis/networking.k8s.io/v1", resource: "networkpolicies", namespaced: true },

  // ---- Sprint B: Compliance Operator ----
  compliancesuite:       { api: "/apis/compliance.openshift.io/v1alpha1", resource: "compliancesuites", namespaced: true },
  compliancesuites:      { api: "/apis/compliance.openshift.io/v1alpha1", resource: "compliancesuites", namespaced: true },
  compliancescan:        { api: "/apis/compliance.openshift.io/v1alpha1", resource: "compliancescans", namespaced: true },
  compliancescans:       { api: "/apis/compliance.openshift.io/v1alpha1", resource: "compliancescans", namespaced: true },
  complianceprofile:     { api: "/apis/compliance.openshift.io/v1alpha1", resource: "profiles", namespaced: true },
  profilebundle:         { api: "/apis/compliance.openshift.io/v1alpha1", resource: "profilebundles", namespaced: true },
  compliancecheckresult: { api: "/apis/compliance.openshift.io/v1alpha1", resource: "compliancecheckresults", namespaced: true },
  fileintegrity:         { api: "/apis/fileintegrity.openshift.io/v1alpha1", resource: "fileintegrities", namespaced: true },
  fileintegrities:       { api: "/apis/fileintegrity.openshift.io/v1alpha1", resource: "fileintegrities", namespaced: true },

  // ---- Sprint B: Cert-Manager ----
  certificate:           { api: "/apis/cert-manager.io/v1", resource: "certificates", namespaced: true },
  certificates:          { api: "/apis/cert-manager.io/v1", resource: "certificates", namespaced: true },
  certificaterequest:    { api: "/apis/cert-manager.io/v1", resource: "certificaterequests", namespaced: true },
  certificaterequests:   { api: "/apis/cert-manager.io/v1", resource: "certificaterequests", namespaced: true },
  issuer:                { api: "/apis/cert-manager.io/v1", resource: "issuers", namespaced: true },
  issuers:               { api: "/apis/cert-manager.io/v1", resource: "issuers", namespaced: true },
  clusterissuer:         { api: "/apis/cert-manager.io/v1", resource: "clusterissuers", namespaced: false },
  clusterissuers:        { api: "/apis/cert-manager.io/v1", resource: "clusterissuers", namespaced: false },

  // ---- Sprint B: External Secrets / Sealed Secrets / Vault ----
  externalsecret:        { api: "/apis/external-secrets.io/v1beta1", resource: "externalsecrets", namespaced: true },
  externalsecrets:       { api: "/apis/external-secrets.io/v1beta1", resource: "externalsecrets", namespaced: true },
  secretstore:           { api: "/apis/external-secrets.io/v1beta1", resource: "secretstores", namespaced: true },
  secretstores:          { api: "/apis/external-secrets.io/v1beta1", resource: "secretstores", namespaced: true },
  clustersecretstore:    { api: "/apis/external-secrets.io/v1beta1", resource: "clustersecretstores", namespaced: false },
  clustersecretstores:   { api: "/apis/external-secrets.io/v1beta1", resource: "clustersecretstores", namespaced: false },
  sealedsecret:          { api: "/apis/bitnami.com/v1alpha1", resource: "sealedsecrets", namespaced: true },
  sealedsecrets:         { api: "/apis/bitnami.com/v1alpha1", resource: "sealedsecrets", namespaced: true },
  vaultauth:             { api: "/apis/secrets.hashicorp.com/v1beta1", resource: "vaultauths", namespaced: true },
  vaultstaticsecret:     { api: "/apis/secrets.hashicorp.com/v1beta1", resource: "vaultstaticsecrets", namespaced: true },

  // ---- Sprint B: Policy engines ----
  constrainttemplate:    { api: "/apis/templates.gatekeeper.sh/v1", resource: "constrainttemplates", namespaced: false },
  constrainttemplates:   { api: "/apis/templates.gatekeeper.sh/v1", resource: "constrainttemplates", namespaced: false },
  policyreport:          { api: "/apis/wgpolicyk8s.io/v1alpha2", resource: "policyreports", namespaced: true },
  policyreports:         { api: "/apis/wgpolicyk8s.io/v1alpha2", resource: "policyreports", namespaced: true },
  clusterpolicyreport:   { api: "/apis/wgpolicyk8s.io/v1alpha2", resource: "clusterpolicyreports", namespaced: false },
  clusterpolicyreports:  { api: "/apis/wgpolicyk8s.io/v1alpha2", resource: "clusterpolicyreports", namespaced: false },
  kyvernopolicy:         { api: "/apis/kyverno.io/v1", resource: "policies", namespaced: true },
  clusterpolicy:         { api: "/apis/kyverno.io/v1", resource: "clusterpolicies", namespaced: false },
  clusterpolicies:       { api: "/apis/kyverno.io/v1", resource: "clusterpolicies", namespaced: false },

  // ---- Sprint B: Observability — Prometheus Operator ----
  prometheusrule:        { api: "/apis/monitoring.coreos.com/v1", resource: "prometheusrules", namespaced: true },
  prometheusrules:       { api: "/apis/monitoring.coreos.com/v1", resource: "prometheusrules", namespaced: true },
  alertrule:             { api: "/apis/monitoring.coreos.com/v1", resource: "prometheusrules", namespaced: true },
  alertrules:            { api: "/apis/monitoring.coreos.com/v1", resource: "prometheusrules", namespaced: true },
  servicemonitor:        { api: "/apis/monitoring.coreos.com/v1", resource: "servicemonitors", namespaced: true },
  servicemonitors:       { api: "/apis/monitoring.coreos.com/v1", resource: "servicemonitors", namespaced: true },
  podmonitor:            { api: "/apis/monitoring.coreos.com/v1", resource: "podmonitors", namespaced: true },
  podmonitors:           { api: "/apis/monitoring.coreos.com/v1", resource: "podmonitors", namespaced: true },
  alertmanagerconfig:    { api: "/apis/monitoring.coreos.com/v1beta1", resource: "alertmanagerconfigs", namespaced: true },
  alertmanagerconfigs:   { api: "/apis/monitoring.coreos.com/v1beta1", resource: "alertmanagerconfigs", namespaced: true },
  prometheus:            { api: "/apis/monitoring.coreos.com/v1", resource: "prometheuses", namespaced: true },
  alertmanager:          { api: "/apis/monitoring.coreos.com/v1", resource: "alertmanagers", namespaced: true },
  thanosruler:           { api: "/apis/monitoring.coreos.com/v1", resource: "thanosrulers", namespaced: true },

  // ---- Sprint B: Logging ----
  clusterlogforwarder:   { api: "/apis/logging.openshift.io/v1", resource: "clusterlogforwarders", namespaced: true },
  clusterlogforwarders:  { api: "/apis/logging.openshift.io/v1", resource: "clusterlogforwarders", namespaced: true },
  clusterlogging:        { api: "/apis/logging.openshift.io/v1", resource: "clusterloggings", namespaced: true },
  clusterloggings:       { api: "/apis/logging.openshift.io/v1", resource: "clusterloggings", namespaced: true },
  lokistack:             { api: "/apis/loki.grafana.com/v1", resource: "lokistacks", namespaced: true },
  lokistacks:            { api: "/apis/loki.grafana.com/v1", resource: "lokistacks", namespaced: true },

  // ---- Sprint B: Tracing ----
  jaeger:                { api: "/apis/jaegertracing.io/v1", resource: "jaegers", namespaced: true },
  jaegers:               { api: "/apis/jaegertracing.io/v1", resource: "jaegers", namespaced: true },
  tempo:                 { api: "/apis/tempo.grafana.com/v1alpha1", resource: "tempostacks", namespaced: true },
  tempostack:            { api: "/apis/tempo.grafana.com/v1alpha1", resource: "tempostacks", namespaced: true },

  // ---- Sprint B: Storage — ODF / Ceph / Velero ----
  cephcluster:           { api: "/apis/ceph.rook.io/v1", resource: "cephclusters", namespaced: true },
  cephclusters:          { api: "/apis/ceph.rook.io/v1", resource: "cephclusters", namespaced: true },
  cephblockpool:         { api: "/apis/ceph.rook.io/v1", resource: "cephblockpools", namespaced: true },
  cephblockpools:        { api: "/apis/ceph.rook.io/v1", resource: "cephblockpools", namespaced: true },
  cephfilesystem:        { api: "/apis/ceph.rook.io/v1", resource: "cephfilesystems", namespaced: true },
  cephfilesystems:       { api: "/apis/ceph.rook.io/v1", resource: "cephfilesystems", namespaced: true },
  cephobjectstore:       { api: "/apis/ceph.rook.io/v1", resource: "cephobjectstores", namespaced: true },
  storagecluster:        { api: "/apis/ocs.openshift.io/v1", resource: "storageclusters", namespaced: true },
  storageclusters:       { api: "/apis/ocs.openshift.io/v1", resource: "storageclusters", namespaced: true },
  noobaa:                { api: "/apis/noobaa.io/v1alpha1", resource: "noobaas", namespaced: true },
  noobaas:               { api: "/apis/noobaa.io/v1alpha1", resource: "noobaas", namespaced: true },
  objectbucket:          { api: "/apis/objectbucket.io/v1alpha1", resource: "objectbuckets", namespaced: false },
  // Velero
  backup:                { api: "/apis/velero.io/v1", resource: "backups", namespaced: true },
  backups:               { api: "/apis/velero.io/v1", resource: "backups", namespaced: true },
  restore:               { api: "/apis/velero.io/v1", resource: "restores", namespaced: true },
  restores:              { api: "/apis/velero.io/v1", resource: "restores", namespaced: true },
  schedule:              { api: "/apis/velero.io/v1", resource: "schedules", namespaced: true },
  schedules:             { api: "/apis/velero.io/v1", resource: "schedules", namespaced: true },
  backupstoragelocation: { api: "/apis/velero.io/v1", resource: "backupstoragelocations", namespaced: true },
  bsl:                   { api: "/apis/velero.io/v1", resource: "backupstoragelocations", namespaced: true },
  volumesnapshotlocation:{ api: "/apis/velero.io/v1", resource: "volumesnapshotlocations", namespaced: true },
  vsl:                   { api: "/apis/velero.io/v1", resource: "volumesnapshotlocations", namespaced: true },
  podvolumebackup:       { api: "/apis/velero.io/v1", resource: "podvolumebackups", namespaced: true },

  // ---- Sprint B: Multi-cluster — ACM / Hive / HyperShift ----
  managedcluster:        { api: "/apis/cluster.open-cluster-management.io/v1", resource: "managedclusters", namespaced: false },
  managedclusters:       { api: "/apis/cluster.open-cluster-management.io/v1", resource: "managedclusters", namespaced: false },
  managedclusteraddon:   { api: "/apis/addon.open-cluster-management.io/v1alpha1", resource: "managedclusteraddons", namespaced: true },
  policy:                { api: "/apis/policy.open-cluster-management.io/v1", resource: "policies", namespaced: true },
  policies:              { api: "/apis/policy.open-cluster-management.io/v1", resource: "policies", namespaced: true },
  placementrule:         { api: "/apis/apps.open-cluster-management.io/v1", resource: "placementrules", namespaced: true },
  placement:             { api: "/apis/cluster.open-cluster-management.io/v1beta1", resource: "placements", namespaced: true },
  manifestwork:          { api: "/apis/work.open-cluster-management.io/v1", resource: "manifestworks", namespaced: true },
  gitopscluster:         { api: "/apis/apps.open-cluster-management.io/v1beta1", resource: "gitopsclusters", namespaced: true },
  clusterdeployment:     { api: "/apis/hive.openshift.io/v1", resource: "clusterdeployments", namespaced: true },
  clusterdeployments:    { api: "/apis/hive.openshift.io/v1", resource: "clusterdeployments", namespaced: true },
  clusterpool:           { api: "/apis/hive.openshift.io/v1", resource: "clusterpools", namespaced: true },
  clusterpools:          { api: "/apis/hive.openshift.io/v1", resource: "clusterpools", namespaced: true },
  clusterclaim:          { api: "/apis/hive.openshift.io/v1", resource: "clusterclaims", namespaced: true },
  clusterimageset:       { api: "/apis/hive.openshift.io/v1", resource: "clusterimagesets", namespaced: false },
  hostedcluster:         { api: "/apis/hypershift.openshift.io/v1beta1", resource: "hostedclusters", namespaced: true },
  hostedclusters:        { api: "/apis/hypershift.openshift.io/v1beta1", resource: "hostedclusters", namespaced: true },
  nodepool:              { api: "/apis/hypershift.openshift.io/v1beta1", resource: "nodepools", namespaced: true },
  nodepools:             { api: "/apis/hypershift.openshift.io/v1beta1", resource: "nodepools", namespaced: true },

  // ---- Sprint B: Bare-metal & Assisted Installer ----
  baremetalhost:         { api: "/apis/metal3.io/v1alpha1", resource: "baremetalhosts", namespaced: true },
  baremetalhosts:        { api: "/apis/metal3.io/v1alpha1", resource: "baremetalhosts", namespaced: true },
  bmh:                   { api: "/apis/metal3.io/v1alpha1", resource: "baremetalhosts", namespaced: true },
  hostfirmwaresettings:  { api: "/apis/metal3.io/v1alpha1", resource: "hostfirmwaresettings", namespaced: true },
  infraenv:              { api: "/apis/agent-install.openshift.io/v1beta1", resource: "infraenvs", namespaced: true },
  infraenvs:             { api: "/apis/agent-install.openshift.io/v1beta1", resource: "infraenvs", namespaced: true },
  agent:                 { api: "/apis/agent-install.openshift.io/v1beta1", resource: "agents", namespaced: true },
  agents:                { api: "/apis/agent-install.openshift.io/v1beta1", resource: "agents", namespaced: true },
  agentclusterinstall:   { api: "/apis/extensions.hive.openshift.io/v1beta1", resource: "agentclusterinstalls", namespaced: true },

  // ---- Sprint B: Performance / Tuning ----
  performanceprofile:    { api: "/apis/performance.openshift.io/v2", resource: "performanceprofiles", namespaced: false },
  performanceprofiles:   { api: "/apis/performance.openshift.io/v2", resource: "performanceprofiles", namespaced: false },
  tuned:                 { api: "/apis/tuned.openshift.io/v1", resource: "tuneds", namespaced: true },
  tuneds:                { api: "/apis/tuned.openshift.io/v1", resource: "tuneds", namespaced: true },
  nodefeaturediscovery:  { api: "/apis/nfd.openshift.io/v1", resource: "nodefeaturediscoveries", namespaced: true },
  nfd:                   { api: "/apis/nfd.openshift.io/v1", resource: "nodefeaturediscoveries", namespaced: true },

  // ---- Sprint B: OpenShift AI / RHODS ----
  datasciencecluster:    { api: "/apis/datasciencecluster.opendatahub.io/v1", resource: "datascienceclusters", namespaced: false },
  datascienceclusters:   { api: "/apis/datasciencecluster.opendatahub.io/v1", resource: "datascienceclusters", namespaced: false },
  dsc:                   { api: "/apis/datasciencecluster.opendatahub.io/v1", resource: "datascienceclusters", namespaced: false },
  notebook:              { api: "/apis/kubeflow.org/v1", resource: "notebooks", namespaced: true },
  notebooks:             { api: "/apis/kubeflow.org/v1", resource: "notebooks", namespaced: true },
  inferenceservice:      { api: "/apis/serving.kserve.io/v1beta1", resource: "inferenceservices", namespaced: true },
  inferenceservices:     { api: "/apis/serving.kserve.io/v1beta1", resource: "inferenceservices", namespaced: true },
  isvc:                  { api: "/apis/serving.kserve.io/v1beta1", resource: "inferenceservices", namespaced: true },
  servingruntime:        { api: "/apis/serving.kserve.io/v1alpha1", resource: "servingruntimes", namespaced: true },

  // ---- Sprint B: SR-IOV / MetalLB / OVN advanced ----
  sriovnetwork:          { api: "/apis/sriovnetwork.openshift.io/v1", resource: "sriovnetworks", namespaced: true },
  sriovnetworknodepolicy:{ api: "/apis/sriovnetwork.openshift.io/v1", resource: "sriovnetworknodepolicies", namespaced: true },
  bgppeer:               { api: "/apis/metallb.io/v1beta2", resource: "bgppeers", namespaced: true },
  ipaddresspool:         { api: "/apis/metallb.io/v1beta1", resource: "ipaddresspools", namespaced: true },
  l2advertisement:       { api: "/apis/metallb.io/v1beta1", resource: "l2advertisements", namespaced: true },
  bgpadvertisement:      { api: "/apis/metallb.io/v1beta1", resource: "bgpadvertisements", namespaced: true },
  adminnetworkpolicy:    { api: "/apis/policy.networking.k8s.io/v1alpha1", resource: "adminnetworkpolicies", namespaced: false },
  baselineadminnetworkpolicy: { api: "/apis/policy.networking.k8s.io/v1alpha1", resource: "baselineadminnetworkpolicies", namespaced: false },
  flowcollector:         { api: "/apis/flows.netobserv.io/v1beta2", resource: "flowcollectors", namespaced: false },
  ingresscontroller:     { api: "/apis/operator.openshift.io/v1", resource: "ingresscontrollers", namespaced: true },
  ingresscontrollers:    { api: "/apis/operator.openshift.io/v1", resource: "ingresscontrollers", namespaced: true },

  // ---- Sprint B: Tekton Advanced (Triggers) ----
  eventlistener:         { api: "/apis/triggers.tekton.dev/v1beta1", resource: "eventlisteners", namespaced: true },
  triggerbinding:        { api: "/apis/triggers.tekton.dev/v1beta1", resource: "triggerbindings", namespaced: true },
  triggertemplate:       { api: "/apis/triggers.tekton.dev/v1beta1", resource: "triggertemplates", namespaced: true },
  trigger:               { api: "/apis/triggers.tekton.dev/v1beta1", resource: "triggers", namespaced: true },

  // ---- Sprint B: Admission / API governance ----
  mutatingwebhookconfiguration:  { api: "/apis/admissionregistration.k8s.io/v1", resource: "mutatingwebhookconfigurations", namespaced: false },
  validatingwebhookconfiguration:{ api: "/apis/admissionregistration.k8s.io/v1", resource: "validatingwebhookconfigurations", namespaced: false },
  apiservice:            { api: "/apis/apiregistration.k8s.io/v1", resource: "apiservices", namespaced: false },
  apirequestcount:       { api: "/apis/apiserver.openshift.io/v1", resource: "apirequestcounts", namespaced: false },
  flowschema:            { api: "/apis/flowcontrol.apiserver.k8s.io/v1", resource: "flowschemas", namespaced: false },
  prioritylevelconfiguration: { api: "/apis/flowcontrol.apiserver.k8s.io/v1", resource: "prioritylevelconfigurations", namespaced: false },

  // ---- Sprint B: ArgoCD / GitOps ----
  application:           { api: "/apis/argoproj.io/v1alpha1", resource: "applications", namespaced: true },
  applications:          { api: "/apis/argoproj.io/v1alpha1", resource: "applications", namespaced: true },
  appproject:            { api: "/apis/argoproj.io/v1alpha1", resource: "appprojects", namespaced: true },
  appprojects:           { api: "/apis/argoproj.io/v1alpha1", resource: "appprojects", namespaced: true },
  applicationset:        { api: "/apis/argoproj.io/v1alpha1", resource: "applicationsets", namespaced: true },
  appset:                { api: "/apis/argoproj.io/v1alpha1", resource: "applicationsets", namespaced: true },

  // ---- Sprint B: OpenShift Templates / Catalog ----
  template:              { api: "/apis/template.openshift.io/v1", resource: "templates", namespaced: true },
  templates:             { api: "/apis/template.openshift.io/v1", resource: "templates", namespaced: true },
  catalogsource:         { api: "/apis/operators.coreos.com/v1alpha1", resource: "catalogsources", namespaced: true },
  catalogsources:        { api: "/apis/operators.coreos.com/v1alpha1", resource: "catalogsources", namespaced: true },
  packagemanifest:       { api: "/apis/packages.operators.coreos.com/v1", resource: "packagemanifests", namespaced: true },
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
  const body = JSON.stringify(data);
  const acceptGzip = (res._req_accept_encoding || "").includes("gzip");
  if (acceptGzip && body.length > 1024) {
    const gz = gzipSync(body, { level: 1 });
    res.writeHead(status, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Vary": "Accept-Encoding" });
    res.end(gz);
  } else {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  }
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

/**
 * Format OCP API errors for chat display.
 * Turns raw 403/404 JSON blobs into human-readable messages with fix guidance.
 */
function formatApiError(err, resourceType) {
  const msg = err.message || String(err);
  if (msg.includes("OCP API 403") || msg.includes("Forbidden")) {
    const resLabel = resourceType || "resource";
    const apiGroupMatch = msg.match(/"([a-z0-9.-]+)" at the cluster/);
    const groupMatch = msg.match(/"group":"([^"]+)"/);
    const apiGroup = apiGroupMatch?.[1] || groupMatch?.[1] || "";
    const groupHint = apiGroup ? ` (\`${apiGroup}\`)` : "";
    return `[WARNING] **Permission Denied** — The MCP server service account does not have access to \`${resLabel}\`${groupHint}.\n\n` +
      `**To fix**, apply the updated RBAC manifest:\n` +
      `SEC_FIX_CMD:::oc apply -f k8s/serviceaccount.yaml\n\n` +
      `Or grant access manually:\n` +
      `SEC_FIX_CMD:::oc adm policy add-cluster-role-to-user mcp-server-reader system:serviceaccount:openshift-mcp:mcp-server`;
  }
  if (msg.includes("OCP API 404") || msg.includes("the server doesn't have a resource type")) {
    const resLabel = resourceType || "resource";
    return `[WARNING] **Resource Not Found** — \`${resLabel}\` API is not available on this cluster. The corresponding operator or CRD may not be installed.`;
  }
  return `[CRITICAL] ${msg}`;
}

// ---------------------------------------------------------------------------
// Smart disambiguation — detect ambiguous queries and generate clarification
// cards with clickable options (similar to ChatGPT / Copilot / Google Assistant).
// Returns null when the query is clear enough, or a @@CLARIFY token otherwise.
// ---------------------------------------------------------------------------
const AMBIGUITY_PATTERNS = [
  {
    test: (msg, p) => /\b(?:upgrade|update)\b/i.test(msg) && p.resource === "clusterversion" && p.confidence <= 0.8 && !/\bpre-?(?:check|flight)|assessment|readiness|status|available|history|to\s+v?\d+\.\d+/i.test(msg),
    question: "What would you like to do with the cluster upgrade?",
    context: "I detected an upgrade-related request. Let me help you with the right action.",
    options: [
      { icon: "\u{1F4CA}", label: "Show upgrade status", desc: "Current version, channel, and available updates", query: "show cluster version upgrade status" },
      { icon: "\u{1F50D}", label: "Run pre-upgrade assessment", desc: "Check cluster readiness before upgrading", query: "precheck upgrade" },
      { icon: "\u{2B06}", label: "Show available upgrade paths", desc: "List all versions you can upgrade to", query: "list available cluster version updates" },
      { icon: "\u{1F6E0}", label: "Start an upgrade", desc: "Initiate the cluster upgrade process", query: "upgrade cluster version" },
    ],
  },
  {
    test: (msg, p) => /^\s*pods?\s*$/i.test(msg.trim()),
    question: "What would you like to know about pods?",
    context: "Your query is quite broad. Here are the most common actions:",
    options: [
      { icon: "\u{1F4CB}", label: "List all pods", desc: "Show pods across all namespaces", query: "list pods in all namespaces" },
      { icon: "\u{26A0}", label: "Show problem pods", desc: "Pods with CrashLoopBackOff, OOMKill, or errors", query: "show pods with issues" },
      { icon: "\u{1F4CA}", label: "Pod resource usage", desc: "CPU and memory consumption by pod", query: "show top pods" },
      { icon: "\u{1F50E}", label: "Find a specific pod", desc: "Search by name or namespace", query: "list pods in namespace " },
    ],
  },
  {
    test: (msg, p) => /^\s*(?:deployment|deploy)s?\s*$/i.test(msg.trim()),
    question: "What would you like to know about deployments?",
    context: "Multiple actions are available for deployments:",
    options: [
      { icon: "\u{1F4CB}", label: "List deployments", desc: "Show all deployments across namespaces", query: "list deployments in all namespaces" },
      { icon: "\u{26A0}", label: "Show unhealthy deployments", desc: "Deployments with unavailable replicas", query: "show deployments with issues" },
      { icon: "\u{1F4CA}", label: "Deployment resource usage", desc: "CPU/memory for deployment pods", query: "top pods" },
    ],
  },
  {
    test: (msg, p) => /^\s*(?:node|nodes)\s*$/i.test(msg.trim()),
    question: "What would you like to know about nodes?",
    context: "Several node operations are available:",
    options: [
      { icon: "\u{1F4CB}", label: "List all nodes", desc: "Show node status, roles, and versions", query: "list nodes" },
      { icon: "\u{1F4CA}", label: "Node resource usage", desc: "CPU and memory allocation per node", query: "top nodes" },
      { icon: "\u{26A0}", label: "Check node health", desc: "Show nodes with NotReady or pressure conditions", query: "show nodes with issues" },
    ],
  },
  {
    test: (msg, p) => /^\s*(?:cluster|openshift)\s*$/i.test(msg.trim()),
    question: "What would you like to know about the cluster?",
    context: "I can help with various cluster operations:",
    options: [
      { icon: "\u{2764}", label: "Cluster health check", desc: "Overall health, operators, nodes, and alerts", query: "check cluster health" },
      { icon: "\u{2B06}", label: "Upgrade status", desc: "Current version and available updates", query: "show cluster version" },
      { icon: "\u{1F512}", label: "Security scan", desc: "Run a security assessment", query: "/security" },
      { icon: "\u{1F4CA}", label: "Resource optimization", desc: "Check resource utilization and waste", query: "/optimize" },
    ],
  },
  {
    test: (msg, p) => {
      if (p.intent === "unknown" || !p.resource || !p.name || p.namespace) return false;
      if (!/\b(describe|get|detail|info|inspect|explain)\b/i.test(msg)) return false;
      if (/(all|every|across)\s*(namespace|ns)/i.test(msg)) return false;
      const ri = RESOURCE_MAP[p.resource];
      if (ri && !ri.namespaced) return false;
      return true;
    },
    question: `Which namespace is "${msg => msg}" in?`,
    dynamicQuestion: (msg, p) => `I found a request for ${p.resource} "${p.name}", but which namespace?`,
    context: "I need the namespace to look up this specific resource.",
    options: [
      { icon: "\u{1F50E}", label: "Search all namespaces", desc: "I'll look across the entire cluster", dynamicQuery: (msg, p) => `describe ${p.resource} ${p.name} in all namespaces` },
      { icon: "\u{1F4DD}", label: "Let me specify", desc: "Type the namespace name", dynamicQuery: (msg, p) => `describe ${p.resource} ${p.name} in namespace ` },
    ],
  },
  {
    test: (msg, p) => p.resource === "deployment" && p.name && p.confidence < 0.7 && !/(list|show|get|describe|logs|scale|restart|delete|top)/i.test(msg),
    dynamicQuestion: (msg, p) => `What would you like to do with deployment "${p.name}"?`,
    context: "I found a deployment name but need to know what action you want.",
    options: [
      { icon: "\u{1F50D}", label: "Describe it", desc: "Show details, replicas, and status", dynamicQuery: (msg, p) => `describe deployment ${p.name} in all namespaces` },
      { icon: "\u{1F4C4}", label: "Show logs", desc: "View logs from this deployment's pods", dynamicQuery: (msg, p) => `show logs for deployment ${p.name}` },
      { icon: "\u{1F504}", label: "Restart it", desc: "Rolling restart of all pods", dynamicQuery: (msg, p) => `restart deployment ${p.name}` },
      { icon: "\u{1F4CA}", label: "Resource usage", desc: "CPU and memory consumption", dynamicQuery: (msg, p) => `top pods for deployment ${p.name}` },
    ],
  },
  {
    test: (msg, p) => p.resource && p.confidence >= 0.4 && p.confidence < 0.6 && msg.trim().split(/\s+/).length <= 3 && !p.name,
    dynamicQuestion: (msg, p) => `What would you like to do with ${p.resource}s?`,
    context: "Your query could mean several things. Please pick the most relevant:",
    options: [
      { icon: "\u{1F4CB}", label: "List all", desc: "Show a table of all instances", dynamicQuery: (msg, p) => `list ${p.resource}s in all namespaces` },
      { icon: "\u{26A0}", label: "Show issues", desc: "Filter to problem instances only", dynamicQuery: (msg, p) => `show ${p.resource}s with issues` },
      { icon: "\u{1F4CA}", label: "Resource usage", desc: "CPU and memory metrics", dynamicQuery: (msg, p) => `top ${p.resource}s` },
    ],
  },
  {
    test: (msg, p) => p.confidence <= 0.4 && p.intent === "unknown" && msg.trim().split(/\s+/).length <= 3,
    question: "I'm not sure what you're looking for. Can you help me understand?",
    context: "Your query is short and I want to make sure I give you the right answer.",
    options: [
      { icon: "\u{2764}", label: "Check cluster health", desc: "Overall cluster status and issues", query: "check cluster health" },
      { icon: "\u{1F4CB}", label: "List resources", desc: "Show pods, deployments, services, etc.", query: "list pods" },
      { icon: "\u{1F6A8}", label: "Show current issues", desc: "Pods with errors, alerts, and events", query: "show pods with issues" },
      { icon: "\u{2753}", label: "Show available commands", desc: "See what I can do", query: "help" },
    ],
  },
];

function detectAmbiguity(userMessage, parsed, memory = {}) {
  const lower = userMessage.toLowerCase().trim();
  if (lower.length > 120) return null;
  if (/^(help|\/\w)/.test(lower)) return null;
  if (parsed.intent === "diagnose") return null; // diagnose handled by handleListCommand, skip ambiguity
  if (memory.resource && memory.name && parsed.resource === memory.resource) return null;

  for (const pattern of AMBIGUITY_PATTERNS) {
    if (pattern.test(userMessage, parsed)) {
      const question = pattern.dynamicQuestion
        ? pattern.dynamicQuestion(userMessage, parsed)
        : pattern.question;
      const context = pattern.context;
      const options = (pattern.options || []).map(opt => ({
        icon: opt.icon,
        label: opt.label,
        desc: opt.desc || "",
        query: opt.dynamicQuery ? opt.dynamicQuery(userMessage, parsed) : opt.query,
      }));
      const token = JSON.stringify({ question, context, options }).replace(/@@/g, "@ @");
      return `@@CLARIFY|${token}@@`;
    }
  }
  return null;
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
  // Certificate expiry queries — route to LLM which has certificate_expiry
  // intent handling, instead of trying to list cert-manager CRD resources.
  // -----------------------------------------------------------------------
  if (cmd.resourceType === "certificate" &&
      /\b(expir|renew|rotat|check|valid|tls)\b/i.test(lower)) {
    return null;
  }

  // -----------------------------------------------------------------------
  // CLUSTER STATUS / HEALTH — "cluster status", "cluster health", "cluster overview"
  // Per OpenShift docs: cluster status = version + operators + nodes + pods + events
  // -----------------------------------------------------------------------
  if ((cmd.resourceType === "cluster" || (!cmd.resourceType && /\bcluster\b/.test(lower))) &&
      (cmd.scope === "health" || /\bhealth\b|\bstatus\b|\bcheck\b|\boverview\b/.test(lower)) &&
      cmd.operation !== "incident_response" && cmd.operation !== "cluster_briefing") {
    try {
      const [clvData, opsData, nodesData, podsData, eventsData, infra, mcsData] = await Promise.all([
        ocpGet("/apis/config.openshift.io/v1/clusterversions/version").catch(() => null),
        ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => ({ items: [] })),
        ocpGet("/api/v1/nodes").catch(() => ({ items: [] })),
        ocpGet("/api/v1/pods").catch(() => ({ items: [] })),
        ocpGet("/api/v1/events?fieldSelector=type=Warning&limit=40").catch(() => ({ items: [] })),
        ocpGet("/apis/config.openshift.io/v1/infrastructures/cluster").catch(() => null),
        ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools").catch(() => ({ items: [] })),
      ]);
      const parts = [];

      // --- Cluster Identity ---
      parts.push(`### Cluster Status Overview`);
      parts.push("");
      if (clvData) {
        const ver = clvData.status?.desired?.version || "unknown";
        const channel = clvData.spec?.channel || "unknown";
        const clusterID = clvData.spec?.clusterID || "—";
        const conditions = clvData.status?.conditions || [];
        const available = conditions.find(c => c.type === "Available");
        const progressing = conditions.find(c => c.type === "Progressing");
        const degraded = conditions.find(c => c.type === "Degraded");
        const platformType = infra?.status?.platformStatus?.type || infra?.status?.platform || "—";
        const apiURL = infra?.status?.apiServerURL || "—";

        parts.push(`| Property | Value |`);
        parts.push(`| --- | --- |`);
        parts.push(`| **OpenShift Version** | ${ver} |`);
        parts.push(`| **Channel** | ${channel} |`);
        parts.push(`| **Platform** | ${platformType} |`);
        parts.push(`| **Cluster ID** | \`${clusterID}\` |`);
        parts.push(`| **API Server** | ${apiURL} |`);
        parts.push(`| **Available** | ${available?.status === "True" ? "[OK] Yes" : "[CRITICAL] No — " + (available?.message || "").slice(0, 100)} |`);
        if (degraded?.status === "True") {
          parts.push(`| **Degraded** | [CRITICAL] Yes — ${(degraded.message || "").slice(0, 100)} |`);
        } else {
          parts.push(`| **Degraded** | [OK] No |`);
        }
        if (progressing?.status === "True") {
          parts.push(`| **Upgrade In Progress** | ⚠ ${(progressing.message || "").slice(0, 100)} |`);
        }
        parts.push("");
      }

      // --- Cluster Operators ---
      const opItems = opsData.items || [];
      const degradedOps = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
      const unavailOps = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Available" && c.status === "False"));
      const progressOps = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Progressing" && c.status === "True"));
      const healthyOps = opItems.length - degradedOps.length - unavailOps.filter(o => !degradedOps.find(d => d.metadata.name === o.metadata.name)).length;
      parts.push(`**Cluster Operators:** ${opItems.length} total | ${healthyOps} healthy | ${degradedOps.length} degraded | ${unavailOps.length} unavailable | ${progressOps.length} progressing`);
      if (degradedOps.length > 0) {
        parts.push("");
        parts.push(`| Operator | Status | Message |`);
        parts.push(`| --- | --- | --- |`);
        degradedOps.forEach(o => {
          const msg = (o.status?.conditions || []).find(c => c.type === "Degraded")?.message || "";
          parts.push(`| \`${o.metadata.name}\` | [CRITICAL] Degraded | ${msg.slice(0, 100)} |`);
        });
        unavailOps.filter(o => !degradedOps.find(d => d.metadata.name === o.metadata.name)).forEach(o => {
          parts.push(`| \`${o.metadata.name}\` | [WARNING] Unavailable | — |`);
        });
      }
      parts.push("");

      // --- Nodes Summary ---
      const nodeItems = nodesData.items || [];
      const readyNodes = nodeItems.filter(n => (n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True"));
      const notReadyNodes = nodeItems.filter(n => !(n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True"));
      const controlPlane = nodeItems.filter(n => Object.keys(n.metadata?.labels || {}).some(l => l.includes("master") || l.includes("control-plane")));
      const workers = nodeItems.filter(n => !Object.keys(n.metadata?.labels || {}).some(l => l.includes("master") || l.includes("control-plane")));
      const pressureNodes = nodeItems.filter(n => (n.status?.conditions || []).some(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True"));
      parts.push(`**Nodes:** ${nodeItems.length} total | ${readyNodes.length} ready | ${notReadyNodes.length} not-ready | ${controlPlane.length} control-plane | ${workers.length} worker`);
      if (notReadyNodes.length > 0) {
        notReadyNodes.forEach(n => parts.push(`  ⛔ \`${n.metadata.name}\` — NotReady`));
      }
      if (pressureNodes.length > 0) {
        pressureNodes.forEach(n => {
          const pTypes = (n.status?.conditions || []).filter(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True").map(c => c.type);
          parts.push(`  ⚠ \`${n.metadata.name}\` — ${pTypes.join(", ")}`);
        });
      }
      parts.push("");

      // --- Pods Summary ---
      const allPods = podsData.items || [];
      const podsByPhase = {};
      allPods.forEach(p => { const ph = p.status?.phase || "Unknown"; podsByPhase[ph] = (podsByPhase[ph] || 0) + 1; });
      const crashPods = allPods.filter(p => (p.status?.containerStatuses || []).some(c => c.state?.waiting?.reason === "CrashLoopBackOff"));
      const oomPods = allPods.filter(p => (p.status?.containerStatuses || []).some(c => c.lastState?.terminated?.reason === "OOMKilled"));
      const imgPods = allPods.filter(p => (p.status?.containerStatuses || []).some(c => c.state?.waiting?.reason === "ImagePullBackOff" || c.state?.waiting?.reason === "ErrImagePull"));
      parts.push(`**Pods:** ${allPods.length} total | ${podsByPhase["Running"] || 0} running | ${podsByPhase["Succeeded"] || 0} completed | ${podsByPhase["Pending"] || 0} pending | ${podsByPhase["Failed"] || 0} failed`);
      if (crashPods.length > 0) parts.push(`  ⛔ ${crashPods.length} pod(s) in CrashLoopBackOff`);
      if (oomPods.length > 0) parts.push(`  ⛔ ${oomPods.length} pod(s) OOMKilled`);
      if (imgPods.length > 0) parts.push(`  ⚠ ${imgPods.length} pod(s) ImagePullBackOff`);
      parts.push("");

      // --- MachineConfigPools ---
      const mcpItems = mcsData.items || [];
      if (mcpItems.length > 0) {
        const degradedMcps = mcpItems.filter(m => (m.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
        const updatingMcps = mcpItems.filter(m => (m.status?.conditions || []).some(c => c.type === "Updating" && c.status === "True"));
        parts.push(`**MachineConfigPools:** ${mcpItems.length} total | ${degradedMcps.length} degraded | ${updatingMcps.length} updating`);
        degradedMcps.forEach(m => parts.push(`  ⛔ \`${m.metadata.name}\` — Degraded`));
        updatingMcps.forEach(m => {
          const pending = (m.status?.machineCount || 0) - (m.status?.updatedMachineCount || 0);
          parts.push(`  ⚠ \`${m.metadata.name}\` — Updating (${pending} machine(s) pending)`);
        });
        parts.push("");
      }

      // --- Warning Events ---
      const evtItems = eventsData.items || [];
      if (evtItems.length > 0) {
        const evtReasons = {};
        evtItems.forEach(e => { evtReasons[e.reason] = (evtReasons[e.reason] || 0) + (e.count || 1); });
        const topReasons = Object.entries(evtReasons).sort((a, b) => b[1] - a[1]).slice(0, 8);
        parts.push(`**Warning Events:** ${evtItems.length} recent`);
        topReasons.forEach(([reason, count]) => parts.push(`  - ${reason}: ${count}`));
        parts.push("");
      }

      // --- Commands ---
      parts.push("**Investigate further:**");
      parts.push(`@@SEC_FIX_CMD|oc get clusterversion@@`);
      parts.push(`@@SEC_FIX_CMD|oc get clusteroperators@@`);
      parts.push(`@@SEC_FIX_CMD|oc get nodes -o wide@@`);
      parts.push(`@@SEC_FIX_CMD|oc get pods --all-namespaces --field-selector=status.phase!=Running,status.phase!=Succeeded@@`);
      if (degradedOps.length > 0) {
        parts.push(`@@SEC_FIX_CMD|oc describe clusteroperator ${degradedOps[0].metadata.name}@@`);
      }
      parts.push(`@@SEC_FIX_CMD|oc get events --all-namespaces --sort-by=.lastTimestamp@@`);
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      return `### Cluster Status\n[WARNING] Could not fetch cluster data: ${e.message}`;
    }
  }

  // -----------------------------------------------------------------------
  // NODE HEALTH — "node health", "show node status", "check nodes"
  // -----------------------------------------------------------------------
  if (cmd.resourceType === "node" && (cmd.scope === "health" || /\bhealth\b|\bstatus\b|\bcheck\b|\boverview\b|\btroubleshoot\b|\bdiagnos/.test(lower))) {
    try {
      const [nodesData, nodeMetrics, eventsData] = await Promise.all([
        ocpGet("/api/v1/nodes"),
        ocpGet("/apis/metrics.k8s.io/v1beta1/nodes").catch(() => ({ items: [] })),
        ocpGet("/api/v1/events?fieldSelector=involvedObject.kind=Node,type=Warning&limit=30").catch(() => ({ items: [] })),
      ]);
      const nodeItems = nodesData.items || [];
      const metricMap = {};
      (nodeMetrics.items || []).forEach(m => { metricMap[m.metadata.name] = m; });

      const parts = [];
      parts.push(`### Node Health Overview`);
      parts.push("");

      const ready = nodeItems.filter(n => (n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True"));
      const notReady = nodeItems.filter(n => !(n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True"));
      parts.push(`Your cluster has **${nodeItems.length} node(s)**: ${ready.length} Ready, ${notReady.length} NotReady`);
      parts.push("");

      parts.push(`| Status | Node | Roles | Age | CPU (used/capacity) | Memory (used/capacity) | Conditions |`);
      parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
      nodeItems.forEach(n => {
        const name = n.metadata.name;
        const conditions = n.status?.conditions || [];
        const readyCond = conditions.find(c => c.type === "Ready");
        const isReady = readyCond?.status === "True";
        const icon = isReady ? "[OK]" : "[CRITICAL]";
        const roles = Object.keys(n.metadata.labels || {})
          .filter(l => l.startsWith("node-role.kubernetes.io/"))
          .map(l => l.split("/")[1]).join(", ") || "worker";
        const created = n.metadata.creationTimestamp;
        const age = created ? _formatAge(new Date(created)) : "—";
        const cpuCap = n.status?.capacity?.cpu || "—";
        const memCap = n.status?.capacity?.memory || "—";
        const metric = metricMap[name];
        const cpuUsed = metric ? fmtCpu(metric.usage?.cpu) : "—";
        const memUsed = metric ? fmtMem(metric.usage?.memory) : "—";
        const memCapFmt = memCap !== "—" ? fmtMem(memCap) : "—";
        const problemConds = conditions.filter(c => c.type !== "Ready" && c.status === "True").map(c => c.type);
        const condStr = problemConds.length > 0 ? problemConds.join(", ") : "Healthy";
        parts.push(`| ${icon} | \`${name}\` | ${roles} | ${age} | ${cpuUsed} / ${cpuCap} | ${memUsed} / ${memCapFmt} | ${condStr} |`);
      });
      parts.push("");

      // Summary stats
      parts.push(`- **Total nodes:** ${nodeItems.length}`);
      parts.push(`- **Ready nodes:** ${ready.length}`);
      parts.push(`- **NotReady nodes:** ${notReady.length}`);

      // Problem nodes detail
      const pressureNodes = nodeItems.filter(n => (n.status?.conditions || []).some(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True"));
      if (notReady.length > 0 || pressureNodes.length > 0) {
        parts.push("");
        parts.push(`**Issues Detected:**`);
        notReady.forEach(n => {
          const msg = (n.status?.conditions || []).find(c => c.type === "Ready")?.message || "";
          parts.push(`  ⛔ \`${n.metadata.name}\` — NotReady: ${msg.slice(0, 150)}`);
        });
        pressureNodes.forEach(n => {
          const pTypes = (n.status?.conditions || []).filter(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True").map(c => c.type);
          parts.push(`  ⚠ \`${n.metadata.name}\` — ${pTypes.join(", ")}`);
        });
      }

      // Recent node events
      const nodeEvents = eventsData.items || [];
      if (nodeEvents.length > 0) {
        parts.push("");
        parts.push(`**Recent Node Events (${nodeEvents.length}):**`);
        nodeEvents.slice(0, 8).forEach(e => {
          parts.push(`  - **${e.reason}** on \`${e.involvedObject?.name || "?"}\`: ${(e.message || "").slice(0, 100)} (×${e.count || 1})`);
        });
      }

      // Troubleshoot commands
      parts.push("");
      parts.push("**Investigate further:**");
      parts.push(`@@SEC_FIX_CMD|oc get nodes -o wide@@`);
      parts.push(`@@SEC_FIX_CMD|oc adm top nodes@@`);
      if (notReady.length > 0) {
        parts.push(`@@SEC_FIX_CMD|oc describe node ${notReady[0].metadata.name}@@`);
      } else if (nodeItems.length > 0) {
        parts.push(`@@SEC_FIX_CMD|oc describe node ${nodeItems[0].metadata.name}@@`);
      }
      parts.push(`@@SEC_FIX_CMD|oc get events --field-selector involvedObject.kind=Node --sort-by=.lastTimestamp@@`);
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      return `### Node Health\n[WARNING] Could not fetch node data: ${e.message}`;
    }
  }

  // -----------------------------------------------------------------------
  // CLUSTER VERSION HISTORY — "cluster version history", "upgrade history",
  // "rollout history previous upgrades", "previous upgrades", "past upgrades"
  // -----------------------------------------------------------------------
  const VERSION_HISTORY_PAT = /\b(?:(?:cluster|upgrade|version|rollout)\s+history|previous\s+(?:upgrades?|versions?)|past\s+(?:upgrades?|versions?)|upgrade\s+(?:log|timeline)|version\s+(?:log|timeline)|show.*(?:upgrade|version)\s+history)\b/i;
  if (VERSION_HISTORY_PAT.test(lower) || (cmd.resourceType === "clusterversion" && /\bhistory\b/i.test(lower))) {
    try {
      const cvResp = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
      const currentVersion = cvResp.status?.desired?.version || "unknown";
      const channel = cvResp.spec?.channel || "unknown";
      const history = cvResp.status?.history || [];
      const conditions = cvResp.status?.conditions || [];
      const parts = [];
      parts.push(`### OpenShift Cluster Version History`);
      parts.push(``);
      parts.push(`Your cluster is currently running **OpenShift ${currentVersion}** on the \`${channel}\` channel.`);
      parts.push(``);
      parts.push(`**Current Cluster Version Status**`);
      parts.push(`| Condition Type | Status | Message |`);
      parts.push(`|---|---|---|`);
      for (const c of conditions) {
        parts.push(`| ${c.type} | ${c.status} | ${c.message || c.reason || "—"} |`);
      }
      parts.push(``);
      if (history.length > 0) {
        parts.push(`**Version History** (${history.length} entries):`);
        parts.push(`| Version | State | Started | Completed |`);
        parts.push(`|---------|-------|---------|-----------|`);
        for (const h of history) {
          const started = h.startedTime ? new Date(h.startedTime).toLocaleString() : "—";
          const completed = h.completionTime ? new Date(h.completionTime).toLocaleString() : "—";
          parts.push(`| \`${h.version}\` | ${h.state} | ${started} | ${completed} |`);
        }
        parts.push(``);
      }
      const updates = cvResp.status?.availableUpdates || [];
      if (updates.length > 0) {
        const sorted = [...updates].sort((a, b) => (b.version || "").localeCompare(a.version || ""));
        parts.push(`**Available Upgrades** (${updates.length} versions):`);
        for (const u of sorted.slice(0, 10)) {
          parts.push(`- \`${u.version}\``);
        }
        if (sorted.length > 10) parts.push(`- ... and ${sorted.length - 10} more`);
        parts.push(``);
      }
      parts.push(`**Next Steps:**`);
      parts.push(`- Run a pre-upgrade assessment: \`precheck upgrade\``);
      parts.push(`- Compare upgrade paths: \`compare upgrade versions\``);
      if (updates.length > 0) {
        const latest = [...updates].sort((a, b) => (b.version || "").localeCompare(a.version || ""))[0];
        parts.push(`- Start upgrade: \`upgrade to ${latest.version}\``);
      }
      return parts.join("\n");
    } catch (err) {
      return `### Cluster Version History\n\n${formatApiError(err, "clusterversion")}`;
    }
  }

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
  // Many operations build their own API paths and don't need resInfo from RESOURCE_MAP.
  const OP_NO_RESOURCE_REQUIRED = new Set([
    "rbac", "compare", "upgrade",
    "cordon", "uncordon", "drain", "taint", "untaint",
    "rollback", "rollout", "approve",
    "diagnose", "mustgather",
    "alerts", "gitops", "imagescan", "backup", "fleet",
    "compliance", "automation", "optimize", "network", "identity", "certlife",
    "slo", "saturation", "incident", "postmortem", "impact",
    "deprecated", "webhook", "supplychain", "imagestale", "hardening",
    "podsecurity", "capacity", "mcpdrift", "pdb", "topology",
    "probes", "hpa", "orphaned", "governance", "incident_response", "cluster_briefing",
  ]);
  if (!cmd.operation) return null;
  if (!cmd.resourceType && !OP_NO_RESOURCE_REQUIRED.has(cmd.operation)) return null;
  if (cmd.operation === "list" || cmd.operation === "get") return null;

  const resInfo = cmd.resourceType ? RESOURCE_MAP[cmd.resourceType] : null;
  if (!resInfo && !OP_NO_RESOURCE_REQUIRED.has(cmd.operation)) return null;

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
    const englishWordRe = /^(specific|specified|all|some|any|each|every|the|this|that|those|these|a|an|which|what|where|when|how|why|who|here|there|now|then|high|low|heavy|idle|busy|most|least|highest|lowest|big|small|large|top|total|overall|cpu|memory|mem|ram|usage|show|list|get|find|check|using|consuming|my|your|its|current|more|less)$/i;
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
        const nSup = cmd.advFilters?.superlative;
        const nSortMetric = nSup?.metric || "cpu";
        const nSortDir = nSup?.op === "min" ? "asc" : "desc";
        const nodeMetrics = items.map(n => ({
          node: n,
          cpuRaw: parseCpuNano(n.usage?.cpu),
          memRaw: parseMemBytes(n.usage?.memory),
          cpu: fmtCpu(n.usage?.cpu),
          mem: fmtMem(n.usage?.memory),
        }));
        if (nSortMetric === "memory") {
          nodeMetrics.sort((a, b) => nSortDir === "desc" ? b.memRaw - a.memRaw : a.memRaw - b.memRaw);
        } else {
          nodeMetrics.sort((a, b) => nSortDir === "desc" ? b.cpuRaw - a.cpuRaw : a.cpuRaw - b.cpuRaw);
        }
        parts.push(`### Node Resource Usage — sorted by ${nSortMetric === "memory" ? "Memory" : "CPU"}`);
        parts.push(`| # | Node | CPU | Memory |`);
        parts.push(`| --- | --- | --- | --- |`);
        nodeMetrics.forEach(({ node: n, cpu, mem }, idx) => {
          parts.push(`| ${idx + 1} | **${n.metadata.name}** | ${cpu} | ${mem} |`);
        });
      } else {
        const label = cmd.namespace ? `in \`${cmd.namespace}\`` : "(all namespaces)";
        const sup = cmd.advFilters?.superlative;
        const sortMetric = sup?.metric || "cpu";
        const sortDir = sup?.op === "min" ? "asc" : "desc";
        const sortLabel = sortMetric === "memory" ? "Memory" : "CPU";
        parts.push(`### Pod Resource Usage — sorted by ${sortLabel} ${label}`);
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
        if (sortMetric === "memory") {
          podMetrics.sort((a, b) => sortDir === "desc" ? b.totalMem - a.totalMem : a.totalMem - b.totalMem);
        } else {
          podMetrics.sort((a, b) => sortDir === "desc" ? b.totalCpu - a.totalCpu : a.totalCpu - b.totalCpu);
        }
        parts.push(`| # | Pod | Namespace | CPU | Memory | Containers |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        podMetrics.forEach(({ pod: p, containers, totalCpuFmt, totalMemFmt }, idx) => {
          const cCount = containers.length;
          const cDetail = cCount > 1 ? `${cCount} containers` : containers[0]?.name || "1";
          parts.push(`| ${idx + 1} | \`${p.metadata.name}\` | ${p.metadata.namespace} | ${totalCpuFmt} | ${totalMemFmt} | ${cDetail} |`);
        });
        if (items.length > 30) parts.push(`\n@@VIEW_MORE|podmetrics|${cmd.namespace || '_all'}|30|${items.length}@@`);
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
      parts.push(formatApiError(err, cmd.resourceType));
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

        const curParts = currentVersion.split(".").map(Number);

        if (requestedVersion) {
          // User asked for a specific version — provide targeted response
          const matchedUpdate = sorted.find(u => u.version === requestedVersion);
          const tgtParts = requestedVersion.split(".").map(Number);
          const isZStream = curParts[0] === tgtParts[0] && curParts[1] === tgtParts[1];
          const upgradeType = isZStream ? "Z-stream (patch)" : "Minor version";

          // Check if requested version is a downgrade
          const isDowngrade = (tgtParts[0] < curParts[0]) ||
            (tgtParts[0] === curParts[0] && tgtParts[1] < curParts[1]) ||
            (tgtParts[0] === curParts[0] && tgtParts[1] === curParts[1] && tgtParts[2] <= curParts[2]);
          const isSameVersion = requestedVersion === currentVersion;

          if (isSameVersion) {
            parts.push(`### Upgrade Not Required`);
            parts.push(`**Current version:** ${currentVersion}`);
            parts.push(`**Requested version:** ${requestedVersion}`);
            parts.push("");
            parts.push(`[WARNING] Your cluster is **already running version ${currentVersion}**. No upgrade is needed.`);
            parts.push("");
            if (sorted.length > 0) {
              parts.push(`**Available upgrades from ${currentVersion}:**`);
              sorted.slice(0, 8).forEach(u => parts.push(`  - **${u.version}**`));
              parts.push("");
              parts.push(`To upgrade, try: \`upgrade to ${sorted[0].version}\``);
            }
            return parts.join("\n");
          }

          if (isDowngrade) {
            parts.push(`### Downgrade Not Supported`);
            parts.push(`**Current version:** ${currentVersion}`);
            parts.push(`**Requested version:** ${requestedVersion}`);
            parts.push("");
            parts.push(`[CRITICAL] **Version ${requestedVersion} is lower than your current version ${currentVersion}.** OpenShift does not support downgrading clusters.`);
            parts.push("");
            if (sorted.length > 0) {
              parts.push(`**Available upgrades from ${currentVersion}:**`);
              sorted.slice(0, 8).forEach(u => parts.push(`  - **${u.version}**`));
              parts.push("");
              parts.push(`**Recommendation:** Upgrade to **${sorted[0].version}** (latest available).`);
              parts.push(`> Ask me: *"upgrade to ${sorted[0].version}"*`);
            }
            return parts.join("\n");
          }

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
            parts.push(`[CRITICAL] **Version ${requestedVersion} is NOT available** for upgrade from ${currentVersion} in channel \`${channel}\`.`);
            parts.push("");
            parts.push(`This version is not listed in the available updates for your cluster. This could mean:`);
            parts.push(`  - The version does not exist in the \`${channel}\` channel`);
            parts.push(`  - The version may be in a different channel (e.g., \`fast-4.x\` or \`candidate-4.x\`)`);
            parts.push(`  - The upgrade path from ${currentVersion} to ${requestedVersion} is not supported`);
            parts.push("");
            if (sorted.length > 0) {
              parts.push(`**Available versions you can upgrade to (${sorted.length} total):**`);
              sorted.forEach(u => {
                parts.push(`  - **${u.version}**`);
              });
              parts.push("");
              parts.push(`**Recommendation:** Upgrade to **${sorted[0].version}** (latest available patch).`);
              parts.push(`> Ask me: *"upgrade to ${sorted[0].version}"*`);
            } else {
              parts.push(`No available updates found in channel \`${channel}\`. Your cluster may already be at the latest version.`);
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

  // -----------------------------------------------------------------------
  // Tier 1: NODE LIFECYCLE — drain / cordon / uncordon / taint
  // -----------------------------------------------------------------------
  if (cmd.operation === "cordon" || cmd.operation === "uncordon") {
    const target = cmd.resourceName;
    if (!target) {
      const label = cmd.operation === "cordon" ? "Cordon" : "Uncordon";
      parts.push(`### ${label} Node`);
      parts.push(`[WARNING] Please specify a node name.`);
      parts.push(``);
      try {
        const nodesData = await ocpGet("/api/v1/nodes");
        const nodes = (nodesData.items || []);
        if (nodes.length > 0) {
          parts.push(`**Available Nodes:**`);
          parts.push(`| Node | Roles | Status | Schedulable |`);
          parts.push(`| --- | --- | --- | --- |`);
          for (const n of nodes) {
            const roles = Object.keys(n.metadata?.labels || {})
              .filter(l => l.startsWith("node-role.kubernetes.io/"))
              .map(l => l.replace("node-role.kubernetes.io/", ""))
              .join(", ") || "worker";
            const ready = (n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True");
            const unschedulable = n.spec?.unschedulable ? "No" : "Yes";
            parts.push(`| \`${n.metadata.name}\` | ${roles} | ${ready ? "[OK] Ready" : "[WARNING] NotReady"} | ${unschedulable} |`);
          }
          parts.push(``);
        }
      } catch {}
      parts.push(`**Example:** \`${cmd.operation} node <node-name>\``);
      return parts.join("\n");
    }
    const unschedulable = cmd.operation === "cordon";
    try {
      await ocpPatch(`/api/v1/nodes/${target}`, { spec: { unschedulable } });
      parts.push(`### Node ${cmd.operation === "cordon" ? "Cordoned" : "Uncordoned"}`);
      parts.push(`[OK] Node \`${target}\` is now \`spec.unschedulable=${unschedulable}\`.`);
      parts.push(``);
      parts.push(`**Verify:** \`oc get node ${target}\``);
      parts.push(``);
      parts.push(`@@SEC_FIX_CMD|oc adm ${cmd.operation} ${target}@@`);
    } catch (err) {
      parts.push(`### ${cmd.operation === "cordon" ? "Cordon" : "Uncordon"} Failed`);
      parts.push(formatApiError(err, "nodes"));
    }
    return parts.join("\n");
  }

  if (cmd.operation === "drain") {
    const target = cmd.resourceName;
    if (!target) {
      parts.push(`### Drain Node`);
      parts.push(`[WARNING] Please specify a node name.`);
      parts.push(``);
      try {
        const nodesData = await ocpGet("/api/v1/nodes");
        const nodes = (nodesData.items || []);
        if (nodes.length > 0) {
          parts.push(`**Available Nodes:**`);
          for (const n of nodes) {
            const roles = Object.keys(n.metadata?.labels || {})
              .filter(l => l.startsWith("node-role.kubernetes.io/"))
              .map(l => l.replace("node-role.kubernetes.io/", ""))
              .join(", ") || "worker";
            parts.push(`- \`${n.metadata.name}\` (${roles})`);
          }
          parts.push(``);
        }
      } catch {}
      parts.push(`**Example:** \`drain node <node-name>\``);
      return parts.join("\n");
    }
    parts.push(`### Drain Node \`${target}\``);
    parts.push(``);
    parts.push(`[INFO] Drain is a multi-step operation. Recommended sequence:`);
    parts.push(``);
    parts.push(`  1. Cordon (mark unschedulable):`);
    parts.push(`@@SEC_FIX_CMD|oc adm cordon ${target}@@`);
    parts.push(`  2. Drain (evict pods):`);
    parts.push(`@@SEC_FIX_CMD|oc adm drain ${target} --ignore-daemonsets --delete-emptydir-data --force --grace-period=120@@`);
    parts.push(``);
    parts.push(`**Caution:** Drain blocks until all evictable pods are removed. Workloads must have PodDisruptionBudgets and multiple replicas to drain safely.`);
    parts.push(``);
    parts.push(`Check PDB coverage first: \`/quotas\``);
    return parts.join("\n");
  }

  if (cmd.operation === "taint" || cmd.operation === "untaint") {
    const target = cmd.resourceName;
    if (!target) {
      parts.push(`### ${cmd.operation === "taint" ? "Taint" : "Untaint"} Node`);
      parts.push(`[WARNING] Please specify a node name.`);
      return parts.join("\n");
    }
    parts.push(`### ${cmd.operation === "taint" ? "Taint" : "Untaint"} Node \`${target}\``);
    parts.push(``);
    parts.push(`[INFO] Taints control which pods can be scheduled to this node.`);
    parts.push(``);
    parts.push(`**Apply taint (NoSchedule):**`);
    parts.push(`@@SEC_FIX_CMD|oc adm taint nodes ${target} key=value:NoSchedule@@`);
    parts.push(``);
    parts.push(`**Remove taint:**`);
    parts.push(`@@SEC_FIX_CMD|oc adm taint nodes ${target} key-@@`);
    parts.push(``);
    parts.push(`**View current taints:** \`oc describe node ${target} | grep Taints\``);
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Tier 1: ROLLBACK / ROLLOUT — deployment lifecycle
  // -----------------------------------------------------------------------
  if (cmd.operation === "rollback") {
    const resource = cmd.resourceType || "deployment";
    const name = cmd.resourceName;
    const ns = cmd.namespace;
    if (!name || !ns) {
      parts.push(`### Rollback ${resource}`);
      parts.push(`[WARNING] Please specify both name and namespace.`);
      parts.push(`\n**Example:** \`rollback deployment my-app in production\``);
      return parts.join("\n");
    }
    parts.push(`### Rollback \`${resource}/${name}\` in \`${ns}\``);
    parts.push(``);
    if (resource === "deploymentconfig" || resource === "dc") {
      parts.push(`**Rollback last DeploymentConfig:**`);
      parts.push(`@@SEC_FIX_CMD|oc rollback dc/${name} -n ${ns}@@`);
    } else {
      parts.push(`**View revision history:**`);
      parts.push(`@@SEC_FIX_CMD|oc rollout history ${resource}/${name} -n ${ns}@@`);
      parts.push(``);
      parts.push(`**Rollback to previous revision:**`);
      parts.push(`@@SEC_FIX_CMD|oc rollout undo ${resource}/${name} -n ${ns}@@`);
      parts.push(``);
      parts.push(`**Rollback to specific revision (e.g., 3):**`);
      parts.push(`@@SEC_FIX_CMD|oc rollout undo ${resource}/${name} -n ${ns} --to-revision=3@@`);
    }
    parts.push(``);
    parts.push(`**Verify after rollback:**`);
    parts.push(`@@SEC_FIX_CMD|oc rollout status ${resource}/${name} -n ${ns}@@`);
    return parts.join("\n");
  }

  if (cmd.operation === "rollout") {
    // If resourceType is clusterversion or the message is about cluster/upgrade
    // history, redirect to the cluster version history handler instead.
    if (cmd.resourceType === "clusterversion" || /\b(cluster|upgrade|version)\s*(version|history|rollout|update)/i.test(lower)) {
      try {
        const cvResp = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
        const currentVersion = cvResp.status?.desired?.version || "unknown";
        const channel = cvResp.spec?.channel || "unknown";
        const history = cvResp.status?.history || [];
        const conditions = cvResp.status?.conditions || [];
        parts.push(`### Cluster Version Rollout History`);
        parts.push(``);
        parts.push(`| Property | Value |`);
        parts.push(`|----------|-------|`);
        parts.push(`| Current Version | \`${currentVersion}\` |`);
        parts.push(`| Channel | \`${channel}\` |`);
        parts.push(``);
        if (history.length > 0) {
          parts.push(`**Upgrade History** (${history.length} entries):`);
          parts.push(`| Version | State | Started | Completed |`);
          parts.push(`|---------|-------|---------|-----------|`);
          for (const h of history) {
            const started = h.startedTime ? new Date(h.startedTime).toLocaleString() : "—";
            const completed = h.completionTime ? new Date(h.completionTime).toLocaleString() : "—";
            parts.push(`| \`${h.version}\` | ${h.state} | ${started} | ${completed} |`);
          }
          parts.push(``);
        }
        if (conditions.length > 0) {
          parts.push(`**Current Conditions:**`);
          for (const c of conditions) {
            parts.push(`- **${c.type}**: ${c.status} — ${c.message || c.reason || ""}`);
          }
          parts.push(``);
        }
        const updates = cvResp.status?.availableUpdates || [];
        if (updates.length > 0) {
          const latest = [...updates].sort((a, b) => (b.version || "").localeCompare(a.version || ""))[0];
          parts.push(`**Next Steps:**`);
          parts.push(`- Latest available upgrade: \`${latest.version}\``);
          parts.push(`- Run pre-upgrade check: \`precheck upgrade to ${latest.version}\``);
          parts.push(`- Start upgrade: \`upgrade to ${latest.version}\``);
        }
        return parts.join("\n");
      } catch (err) {
        parts.push(`### Cluster Version History`);
        parts.push(formatApiError(err, "clusterversion"));
        return parts.join("\n");
      }
    }

    const resource = cmd.resourceType || "deployment";
    const name = cmd.resourceName;
    const ns = cmd.namespace;
    if (!name) {
      parts.push(`### Rollout Status`);
      parts.push(`[WARNING] Please specify a ${resource} name.`);
      parts.push(`\n**Example:** "rollout status my-deployment in namespace my-ns"`);
      return parts.join("\n");
    }
    if (!ns) {
      parts.push(`### Rollout Status`);
      parts.push(`[WARNING] Please specify the namespace.`);
      parts.push(`\n**Example:** "rollout status ${name} in namespace my-ns"`);
      return parts.join("\n");
    }
    try {
      const path = `/apis/apps/v1/namespaces/${ns}/deployments/${name}`;
      const d = await ocpGet(path);
      const desired = d.spec?.replicas ?? "?";
      const available = d.status?.availableReplicas ?? 0;
      const ready = d.status?.readyReplicas ?? 0;
      const updated = d.status?.updatedReplicas ?? 0;
      const conds = d.status?.conditions || [];
      parts.push(`### Rollout Status — \`${name}\` in \`${ns}\``);
      parts.push(``);
      parts.push(`| Metric | Value |`);
      parts.push(`|---|---|`);
      parts.push(`| Desired | ${desired} |`);
      parts.push(`| Ready | ${ready} |`);
      parts.push(`| Available | ${available} |`);
      parts.push(`| Updated | ${updated} |`);
      parts.push(`| Generation | ${d.metadata?.generation || "-"} / Observed ${d.status?.observedGeneration || "-"} |`);
      parts.push(``);
      for (const c of conds) {
        parts.push(`- **${c.type}**: ${c.status} — ${c.message || c.reason || ""}`);
      }
      parts.push(``);
      parts.push(`**Continue watching:**`);
      parts.push(`@@SEC_FIX_CMD|oc rollout status ${resource}/${name} -n ${ns} --watch@@`);
    } catch (err) {
      parts.push(`### Rollout Status Failed`);
      parts.push(formatApiError(err, cmd.resourceType || "deployment"));
    }
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Tier 1: APPROVE — CSR / InstallPlan approval
  // -----------------------------------------------------------------------
  if (cmd.operation === "approve") {
    const r = cmd.resourceType;
    const n = cmd.resourceName;
    if (!n) {
      parts.push(`### Approve`);
      parts.push(`[WARNING] Please specify a resource name (CSR or InstallPlan).`);
      parts.push(`\n**Examples:** \`approve csr csr-abc123\`, \`approve installplan install-xxx in operators\``);
      return parts.join("\n");
    }
    if (r === "csr" || r === "certificatesigningrequest") {
      parts.push(`### Approve CSR \`${n}\``);
      parts.push(``);
      parts.push(`@@SEC_FIX_CMD|oc adm certificate approve ${n}@@`);
      return parts.join("\n");
    }
    if (r === "installplan" || r === "ip") {
      const ns = cmd.namespace || "openshift-operators";
      parts.push(`### Approve InstallPlan \`${n}\` in \`${ns}\``);
      parts.push(``);
      parts.push(`@@SEC_FIX_CMD|oc patch installplan ${n} -n ${ns} --type=merge -p '{"spec":{"approved":true}}'@@`);
      return parts.join("\n");
    }
    parts.push(`### Approve`);
    parts.push(`[INFO] Approve action is supported for CSRs and InstallPlans only.`);
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Tier 1: RBAC — "who has X access?", "permissions for user Y"
  // -----------------------------------------------------------------------
  if (cmd.operation === "rbac") {
    try {
      const lower = message.toLowerCase();
      const crbData = await ocpGet("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings");
      const crbs = crbData.items || [];

      // Detect if user is asking about a specific role
      let roleFilter = null;
      if (lower.match(/cluster[- ]?admin/)) roleFilter = "cluster-admin";
      else if (lower.match(/\badmin\b/) && !lower.match(/cluster/)) roleFilter = "admin";
      else if (lower.match(/\bedit\b/)) roleFilter = "edit";
      else if (lower.match(/\bview\b/)) roleFilter = "view";

      // Detect if user is asking about a specific user/service account
      const userMatch = lower.match(/(?:user|for|about)\s+["']?([a-z0-9][-a-z0-9:._@]*)["']?/);
      const specificUser = userMatch?.[1];

      // Key cluster-wide roles to show
      const importantRoles = roleFilter
        ? [roleFilter]
        : ["cluster-admin", "admin", "edit", "view", "self-provisioner"];

      const bindings = [];
      for (const crb of crbs) {
        const role = crb.roleRef?.name || "";
        const subjects = crb.subjects || [];
        if (subjects.length === 0) continue;

        const matchesRole = importantRoles.some(r => role === r || role.includes(r));
        const matchesUser = specificUser
          ? subjects.some(s => (s.name || "").toLowerCase().includes(specificUser))
          : false;

        if (matchesRole || matchesUser) {
          for (const s of subjects) {
            if (specificUser && !(s.name || "").toLowerCase().includes(specificUser)) continue;
            bindings.push({
              role,
              binding: crb.metadata.name,
              subjectKind: s.kind,
              subjectName: s.name,
              subjectNamespace: s.namespace || "—",
            });
          }
        }
      }

      // Also fetch namespace-scoped RoleBindings if a namespace is specified
      let nsBindings = [];
      if (cmd.namespace) {
        try {
          const rbData = await ocpGet(`/apis/rbac.authorization.k8s.io/v1/namespaces/${cmd.namespace}/rolebindings`);
          for (const rb of (rbData.items || [])) {
            const role = rb.roleRef?.name || "";
            for (const s of (rb.subjects || [])) {
              if (specificUser && !(s.name || "").toLowerCase().includes(specificUser)) continue;
              nsBindings.push({
                role,
                binding: rb.metadata.name,
                subjectKind: s.kind,
                subjectName: s.name,
                subjectNamespace: s.namespace || "—",
              });
            }
          }
        } catch {}
      }

      // Fetch OpenShift Users & Groups for enrichment
      let users = [], groups = [];
      try {
        const uData = await ocpGet("/apis/user.openshift.io/v1/users");
        users = (uData.items || []).map(u => ({
          name: u.metadata.name,
          fullName: u.fullName || "",
          identities: (u.identities || []).join(", "),
        }));
        if (specificUser) {
          users = users.filter(u => u.name.toLowerCase().includes(specificUser));
        }
      } catch {}
      try {
        const gData = await ocpGet("/apis/user.openshift.io/v1/groups");
        groups = (gData.items || []).map(g => ({
          name: g.metadata.name,
          members: (g.users || []),
        }));
        if (specificUser) {
          groups = groups.filter(g => g.members.some(m => m.toLowerCase().includes(specificUser)));
        }
      } catch {}

      // Build response
      const label = specificUser ? ` for \`${specificUser}\`` : "";
      parts.push(`### Cluster RBAC Access${label}`);
      parts.push(``);

      // Cluster-admin summary
      const clusterAdmins = bindings.filter(b => b.role === "cluster-admin");
      if (!roleFilter || roleFilter === "cluster-admin") {
        parts.push(`**Cluster Admins** (${clusterAdmins.length} bindings):`);
        parts.push(`| Type | Name | Namespace | Binding |`);
        parts.push(`| --- | --- | --- | --- |`);
        if (clusterAdmins.length === 0) {
          parts.push(`| — | No cluster-admin bindings found | — | — |`);
        } else {
          for (const b of clusterAdmins.slice(0, 30)) {
            parts.push(`| ${b.subjectKind} | \`${b.subjectName}\` | ${b.subjectNamespace} | ${b.binding} |`);
          }
        }
        parts.push(``);
      }

      // Other key roles
      const otherBindings = bindings.filter(b => b.role !== "cluster-admin");
      if (otherBindings.length > 0) {
        parts.push(`**Other Key Roles** (${otherBindings.length} bindings):`);
        parts.push(`| Role | Type | Name | Namespace |`);
        parts.push(`| --- | --- | --- | --- |`);
        for (const b of otherBindings.slice(0, 30)) {
          parts.push(`| ${b.role} | ${b.subjectKind} | \`${b.subjectName}\` | ${b.subjectNamespace} |`);
        }
        parts.push(``);
      }

      // Namespace-scoped bindings
      if (nsBindings.length > 0) {
        parts.push(`**Namespace \`${cmd.namespace}\` Bindings** (${nsBindings.length}):`);
        parts.push(`| Role | Type | Name |`);
        parts.push(`| --- | --- | --- |`);
        for (const b of nsBindings.slice(0, 20)) {
          parts.push(`| ${b.role} | ${b.subjectKind} | \`${b.subjectName}\` |`);
        }
        parts.push(``);
      }

      // OpenShift Users
      if (users.length > 0) {
        parts.push(`**OpenShift Users** (${users.length}):`);
        parts.push(`| User | Full Name | Identity Provider |`);
        parts.push(`| --- | --- | --- |`);
        for (const u of users.slice(0, 20)) {
          parts.push(`| \`${u.name}\` | ${u.fullName || "—"} | ${u.identities || "—"} |`);
        }
        parts.push(``);
      }

      // Groups
      if (groups.length > 0) {
        parts.push(`**Groups** (${groups.length}):`);
        parts.push(`| Group | Members |`);
        parts.push(`| --- | --- |`);
        for (const g of groups.slice(0, 15)) {
          const memberList = g.members.length <= 5
            ? g.members.map(m => `\`${m}\``).join(", ")
            : g.members.slice(0, 5).map(m => `\`${m}\``).join(", ") + ` +${g.members.length - 5} more`;
          parts.push(`| **${g.name}** | ${memberList || "—"} |`);
        }
        parts.push(``);
      }

      // Summary counts
      const totalSubjects = new Set(bindings.map(b => `${b.subjectKind}:${b.subjectName}`));
      parts.push(`**Summary:** ${totalSubjects.size} unique principals across ${bindings.length} cluster-level bindings` +
        (users.length ? `, ${users.length} OpenShift users` : "") +
        (groups.length ? `, ${groups.length} groups` : ""));

    } catch (err) {
      parts.push(`### RBAC Query`);
      parts.push(formatApiError(err, "clusterrolebindings"));
    }
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Tier 2: RESIZE — PVC expansion
  // -----------------------------------------------------------------------
  if (cmd.operation === "resize") {
    const resource = cmd.resourceType || "pvc";
    const name = cmd.resourceName;
    const ns = cmd.namespace;
    if (!name || !ns) {
      parts.push(`### Resize PVC`);
      parts.push(`[WARNING] Please specify PVC name and namespace.`);
      parts.push(`\n**Example:** \`resize pvc data-pvc to 50Gi in app-ns\``);
      return parts.join("\n");
    }
    const sizeMatch = /\b(\d+)\s*(gi|mi|ti)\b/i.exec(cmd.raw || "");
    const newSize = sizeMatch ? `${sizeMatch[1]}${sizeMatch[2][0].toUpperCase()}${sizeMatch[2][1]}` : "50Gi";
    parts.push(`### Resize PVC \`${name}\` in \`${ns}\` → ${newSize}`);
    parts.push(``);
    parts.push(`**Pre-flight:** The StorageClass must have \`allowVolumeExpansion: true\`. Verify:`);
    parts.push(`@@SEC_FIX_CMD|oc get sc $(oc get pvc ${name} -n ${ns} -o jsonpath='{.spec.storageClassName}') -o jsonpath='{.allowVolumeExpansion}'@@`);
    parts.push(``);
    parts.push(`**Apply expansion:**`);
    parts.push(`@@SEC_FIX_CMD|oc patch pvc ${name} -n ${ns} --type=merge -p '{"spec":{"resources":{"requests":{"storage":"${newSize}"}}}}'@@`);
    parts.push(``);
    parts.push(`**Verify:**`);
    parts.push(`@@SEC_FIX_CMD|oc describe pvc ${name} -n ${ns}@@`);
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Tier 2: SNAPSHOT — VolumeSnapshot creation
  // -----------------------------------------------------------------------
  if (cmd.operation === "snapshot") {
    const name = cmd.resourceName;
    const ns = cmd.namespace;
    if (!name || !ns) {
      parts.push(`### Create Snapshot`);
      parts.push(`[WARNING] Please specify PVC name and namespace.`);
      parts.push(`\n**Example:** \`snapshot pvc data-pvc in app-ns\``);
      return parts.join("\n");
    }
    const snapName = `${name}-snap-${Date.now().toString(36)}`;
    parts.push(`### Create VolumeSnapshot from PVC \`${name}\` in \`${ns}\``);
    parts.push(``);
    parts.push(`**Snapshot YAML:**`);
    parts.push("```yaml");
    parts.push(`apiVersion: snapshot.storage.k8s.io/v1`);
    parts.push(`kind: VolumeSnapshot`);
    parts.push(`metadata:`);
    parts.push(`  name: ${snapName}`);
    parts.push(`  namespace: ${ns}`);
    parts.push(`spec:`);
    parts.push(`  source:`);
    parts.push(`    persistentVolumeClaimName: ${name}`);
    parts.push("```");
    parts.push(``);
    parts.push(`**Apply (note: requires a VolumeSnapshotClass and CSI driver with snapshot support):**`);
    parts.push(`@@SEC_FIX_CMD|cat <<'EOF' | oc apply -f -
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: ${snapName}
  namespace: ${ns}
spec:
  source:
    persistentVolumeClaimName: ${name}
EOF@@`);
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Tier 2: COMPARE — cross-namespace diff
  // -----------------------------------------------------------------------
  if (cmd.operation === "compare" && cmd.advFilters?.compare) {
    const { a, b } = cmd.advFilters.compare;
    parts.push(`### Compare Namespaces: \`${a}\` vs \`${b}\``);
    parts.push(``);
    try {
      const [podsA, podsB, depsA, depsB] = await Promise.all([
        ocpGet(`/api/v1/namespaces/${a}/pods`).catch(() => ({ items: [] })),
        ocpGet(`/api/v1/namespaces/${b}/pods`).catch(() => ({ items: [] })),
        ocpGet(`/apis/apps/v1/namespaces/${a}/deployments`).catch(() => ({ items: [] })),
        ocpGet(`/apis/apps/v1/namespaces/${b}/deployments`).catch(() => ({ items: [] })),
      ]);
      parts.push(`| Metric | ${a} | ${b} |`);
      parts.push(`|---|---|---|`);
      parts.push(`| Pods | ${podsA.items?.length || 0} | ${podsB.items?.length || 0} |`);
      parts.push(`| Deployments | ${depsA.items?.length || 0} | ${depsB.items?.length || 0} |`);
      const dNamesA = new Set((depsA.items || []).map((d) => d.metadata?.name));
      const dNamesB = new Set((depsB.items || []).map((d) => d.metadata?.name));
      const onlyA = [...dNamesA].filter((n) => !dNamesB.has(n));
      const onlyB = [...dNamesB].filter((n) => !dNamesA.has(n));
      const both = [...dNamesA].filter((n) => dNamesB.has(n));
      parts.push(``);
      parts.push(`**Deployments only in \`${a}\` (${onlyA.length}):** ${onlyA.slice(0, 10).join(", ") || "-"}`);
      parts.push(`**Deployments only in \`${b}\` (${onlyB.length}):** ${onlyB.slice(0, 10).join(", ") || "-"}`);
      parts.push(`**Common (${both.length}):** ${both.slice(0, 10).join(", ") || "-"}`);
    } catch (err) {
      parts.push(`[ERROR] Compare failed: ${err.message}`);
    }
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Tier 5: ALERTS — query AlertManager / Prometheus alerts
  // -----------------------------------------------------------------------
  if (cmd.operation === "alerts") {
    try {
      const [alertsResp, rulesResp] = await Promise.all([
        ocpGet("/api/v1/namespaces/openshift-monitoring/services/alertmanager-main:web/proxy/api/v2/alerts").catch(() => null),
        ocpGet("/api/v1/namespaces/openshift-monitoring/services/prometheus-k8s:web/proxy/api/v1/rules?type=alert").catch(() => null),
      ]);
      const alerts = Array.isArray(alertsResp) ? alertsResp : (alertsResp?.data || []);
      const firing = alerts.filter(a => a.status?.state === "active" || a.status?.state === "firing");
      const silenced = alerts.filter(a => a.status?.state === "suppressed" || a.status?.silencedBy?.length > 0);
      parts.push(`### Cluster Alerts`);
      parts.push(`**Firing:** ${firing.length} | **Silenced:** ${silenced.length} | **Total:** ${alerts.length}`);
      parts.push("");
      if (firing.length > 0) {
        parts.push(`| Severity | Alert | Namespace | State | Since |`);
        parts.push(`| --- | --- | --- | --- | --- |`);
        firing.slice(0, 30).forEach(a => {
          const labels = a.labels || {};
          const sev = labels.severity || "unknown";
          const icon = sev === "critical" ? "[CRITICAL]" : sev === "warning" ? "[WARNING]" : "[INFO]";
          const since = a.startsAt ? new Date(a.startsAt).toLocaleString() : "—";
          parts.push(`| ${icon} | **${labels.alertname || "?"}** | ${labels.namespace || "—"} | ${a.status?.state || "?"} | ${since} |`);
        });
      } else {
        parts.push(`[OK] No firing alerts. Cluster alerting is healthy.`);
      }
      if (silenced.length > 0) {
        parts.push("");
        parts.push(`**Silenced alerts (${silenced.length}):** ${silenced.slice(0, 5).map(a => a.labels?.alertname).filter(Boolean).join(", ")}${silenced.length > 5 ? "…" : ""}`);
      }
      const rules = rulesResp?.data?.groups || [];
      const totalRules = rules.reduce((s, g) => s + (g.rules || []).length, 0);
      if (totalRules > 0) parts.push(`\n**Alert rules configured:** ${totalRules} across ${rules.length} groups`);
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Alerts`);
      parts.push(`[WARNING] Could not query AlertManager. Monitoring stack may not be accessible.`);
      parts.push(`Error: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 5: GITOPS — ArgoCD / OpenShift GitOps application status
  // -----------------------------------------------------------------------
  if (cmd.operation === "gitops") {
    try {
      const [apps, appsets] = await Promise.all([
        ocpGet("/apis/argoproj.io/v1alpha1/applications").catch(() => ({ items: [] })),
        ocpGet("/apis/argoproj.io/v1alpha1/applicationsets").catch(() => ({ items: [] })),
      ]);
      const appItems = apps.items || [];
      parts.push(`### GitOps Application Status`);
      parts.push(`**Total applications:** ${appItems.length} | **ApplicationSets:** ${(appsets.items || []).length}`);
      parts.push("");
      if (appItems.length === 0) {
        parts.push(`[WARNING] No ArgoCD/GitOps applications found. OpenShift GitOps operator may not be installed.`);
      } else {
        const synced = appItems.filter(a => a.status?.sync?.status === "Synced");
        const outOfSync = appItems.filter(a => a.status?.sync?.status === "OutOfSync");
        const degraded = appItems.filter(a => a.status?.health?.status === "Degraded");
        const unknown = appItems.filter(a => !a.status?.sync?.status);
        parts.push(`**Sync Status:** [OK] Synced: ${synced.length} | [WARNING] OutOfSync: ${outOfSync.length} | Unknown: ${unknown.length}`);
        parts.push(`**Health:** Healthy: ${appItems.filter(a => a.status?.health?.status === "Healthy").length} | [CRITICAL] Degraded: ${degraded.length}`);
        parts.push("");
        parts.push(`| Status | Application | Namespace | Sync | Health | Repo |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        appItems.forEach(a => {
          const syncStatus = a.status?.sync?.status || "Unknown";
          const healthStatus = a.status?.health?.status || "Unknown";
          const icon = syncStatus === "Synced" && healthStatus === "Healthy" ? "[OK]" : syncStatus === "OutOfSync" ? "[WARNING]" : "[CRITICAL]";
          const repo = (a.spec?.source?.repoURL || "—").replace(/https?:\/\//, "").substring(0, 40);
          parts.push(`| ${icon} | **${a.metadata.name}** | ${a.metadata.namespace || "—"} | ${syncStatus} | ${healthStatus} | ${repo} |`);
        });
        if (outOfSync.length > 0) {
          parts.push("");
          parts.push(`**Recommendation:** ${outOfSync.length} app(s) are out of sync. Review drift and sync manually or enable auto-sync.`);
        }
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### GitOps Status`);
      parts.push(`[WARNING] Could not query ArgoCD applications. GitOps operator may not be installed.`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 5: IMAGE SCAN — vulnerability / CVE reporting
  // -----------------------------------------------------------------------
  if (cmd.operation === "imagescan") {
    try {
      const [vulnReports, imgStreams] = await Promise.all([
        ocpGet("/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports").catch(() =>
          ocpGet("/apis/quay.redhat.com/v1/imagevulnerabilities").catch(() => ({ items: [] }))
        ),
        ocpGet("/apis/image.openshift.io/v1/imagestreams").catch(() => ({ items: [] })),
      ]);
      const vulns = vulnReports.items || [];
      parts.push(`### Image Vulnerability Report`);
      if (vulns.length > 0) {
        let critCount = 0, highCount = 0, medCount = 0, lowCount = 0;
        vulns.forEach(v => {
          const summary = v.report?.summary || {};
          critCount += summary.criticalCount || 0;
          highCount += summary.highCount || 0;
          medCount += summary.mediumCount || 0;
          lowCount += summary.lowCount || 0;
        });
        parts.push(`**Scanned images:** ${vulns.length}`);
        parts.push(`**Vulnerabilities:** [CRITICAL] Critical: ${critCount} | [WARNING] High: ${highCount} | Medium: ${medCount} | Low: ${lowCount}`);
        parts.push("");
        parts.push(`| Image | Namespace | Critical | High | Medium | Low |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        vulns.slice(0, 20).forEach(v => {
          const s = v.report?.summary || {};
          const name = v.metadata?.name || "—";
          const ns = v.metadata?.namespace || "—";
          const icon = (s.criticalCount || 0) > 0 ? "[CRITICAL]" : (s.highCount || 0) > 0 ? "[WARNING]" : "[OK]";
          parts.push(`| ${icon} ${name.substring(0, 40)} | ${ns} | ${s.criticalCount || 0} | ${s.highCount || 0} | ${s.mediumCount || 0} | ${s.lowCount || 0} |`);
        });
      } else {
        parts.push(`**Image streams found:** ${(imgStreams.items || []).length}`);
        parts.push(`[WARNING] No vulnerability reports found. Image scanning operator (Trivy, Clair, or Quay) may not be installed.`);
        parts.push(`\n**To enable image scanning:**`);
        parts.push(`  - Install the ACS (Stackrox) or Trivy operator`);
        parts.push(`  - Or use Quay with built-in Clair scanning`);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Image Scanning`);
      parts.push(`[WARNING] Could not query vulnerability reports: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 5: BACKUP — Velero / etcd backup status
  // -----------------------------------------------------------------------
  if (cmd.operation === "backup") {
    try {
      const [veleroBackups, veleroSchedules, etcdPods] = await Promise.all([
        ocpGet("/apis/velero.io/v1/backups").catch(() => ({ items: [] })),
        ocpGet("/apis/velero.io/v1/schedules").catch(() => ({ items: [] })),
        ocpGet("/api/v1/namespaces/openshift-etcd/pods?labelSelector=app=etcd").catch(() => ({ items: [] })),
      ]);
      const backups = veleroBackups.items || [];
      const schedules = veleroSchedules.items || [];
      const etcdPodItems = etcdPods.items || [];
      parts.push(`### Backup & Disaster Recovery Status`);
      parts.push("");
      parts.push(`**etcd Status:**`);
      if (etcdPodItems.length > 0) {
        const healthy = etcdPodItems.filter(p => p.status?.phase === "Running");
        parts.push(`  [${healthy.length === etcdPodItems.length ? "OK" : "WARNING"}] ${healthy.length}/${etcdPodItems.length} etcd pods running`);
      } else {
        parts.push(`  [WARNING] Could not query etcd pods`);
      }
      parts.push("");
      if (backups.length > 0 || schedules.length > 0) {
        parts.push(`**Velero Backup Status:**`);
        parts.push(`  Backups: ${backups.length} | Schedules: ${schedules.length}`);
        parts.push("");
        if (backups.length > 0) {
          const sorted = [...backups].sort((a, b) => new Date(b.status?.completionTimestamp || 0) - new Date(a.status?.completionTimestamp || 0));
          parts.push(`| Status | Backup | Phase | Started | Completed | Items |`);
          parts.push(`| --- | --- | --- | --- | --- | --- |`);
          sorted.slice(0, 15).forEach(b => {
            const phase = b.status?.phase || "Unknown";
            const icon = phase === "Completed" ? "[OK]" : phase === "Failed" ? "[CRITICAL]" : "[WARNING]";
            const started = b.status?.startTimestamp ? new Date(b.status.startTimestamp).toLocaleString() : "—";
            const completed = b.status?.completionTimestamp ? new Date(b.status.completionTimestamp).toLocaleString() : "—";
            const items = b.status?.progress?.totalItems || "—";
            parts.push(`| ${icon} | **${b.metadata.name}** | ${phase} | ${started} | ${completed} | ${items} |`);
          });
        }
        if (schedules.length > 0) {
          parts.push("");
          parts.push(`**Scheduled Backups:**`);
          schedules.forEach(s => {
            const lastBackup = s.status?.lastBackup ? new Date(s.status.lastBackup).toLocaleString() : "never";
            parts.push(`  - **${s.metadata.name}**: \`${s.spec?.schedule || "—"}\` (last: ${lastBackup})`);
          });
        }
      } else {
        parts.push(`[WARNING] **Velero is not installed.** No backup operator found.`);
        parts.push(`\n**Recommendation:** Install Velero or OADP (OpenShift API for Data Protection) for cluster backups.`);
        parts.push(`  - For etcd backup: \`etcd snapshot save\``);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Backup Status`);
      parts.push(`[WARNING] Could not query backup resources: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 5: MUST-GATHER — live cluster diagnostics (fetched from API)
  // -----------------------------------------------------------------------
  if (cmd.operation === "mustgather") {
    try {
      const [nodesData, clvData, opsData, eventsData, podsData, csrsData, mcsData] = await Promise.all([
        ocpGet("/api/v1/nodes").catch(() => ({ items: [] })),
        ocpGet("/apis/config.openshift.io/v1/clusterversions/version").catch(() => null),
        ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => ({ items: [] })),
        ocpGet("/api/v1/events?fieldSelector=type=Warning&limit=50").catch(() => ({ items: [] })),
        ocpGet("/api/v1/pods?fieldSelector=status.phase!=Running,status.phase!=Succeeded&limit=100").catch(() => ({ items: [] })),
        ocpGet("/apis/certificates.k8s.io/v1/certificatesigningrequests").catch(() => ({ items: [] })),
        ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools").catch(() => ({ items: [] })),
      ]);

      parts.push(`### Cluster Diagnostics Report`);
      parts.push("");

      // Cluster version
      if (clvData) {
        const ver = clvData.status?.desired?.version || "unknown";
        const channel = clvData.spec?.channel || "unknown";
        const progressing = (clvData.status?.conditions || []).find(c => c.type === "Progressing");
        parts.push(`**Cluster Version:** ${ver} (channel: ${channel})`);
        if (progressing && progressing.status === "True") parts.push(`  ⚠ Upgrade in progress: ${progressing.message || ""}`);
        parts.push("");
      }

      // Node health
      const nodeItems = nodesData.items || [];
      const notReady = nodeItems.filter(n => !(n.status?.conditions || []).find(c => c.type === "Ready" && c.status === "True"));
      const pressureNodes = nodeItems.filter(n => (n.status?.conditions || []).some(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True"));
      parts.push(`**Nodes:** ${nodeItems.length} total, ${nodeItems.length - notReady.length} ready, ${notReady.length} not-ready`);
      notReady.forEach(n => parts.push(`  ⛔ \`${n.metadata.name}\` — NotReady`));
      pressureNodes.forEach(n => {
        const pTypes = (n.status?.conditions || []).filter(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True").map(c => c.type);
        parts.push(`  ⚠ \`${n.metadata.name}\` — ${pTypes.join(", ")}`);
      });
      parts.push("");

      // Degraded operators
      const opItems = opsData.items || [];
      const degradedOps = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
      const unavailOps = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Available" && c.status === "False"));
      parts.push(`**Cluster Operators:** ${opItems.length} total, ${degradedOps.length} degraded, ${unavailOps.length} unavailable`);
      degradedOps.forEach(o => {
        const msg = (o.status?.conditions || []).find(c => c.type === "Degraded")?.message || "";
        parts.push(`  ⛔ \`${o.metadata.name}\` — Degraded: ${msg.slice(0, 120)}`);
      });
      unavailOps.forEach(o => {
        if (!degradedOps.find(d => d.metadata.name === o.metadata.name)) {
          parts.push(`  ⚠ \`${o.metadata.name}\` — Unavailable`);
        }
      });
      parts.push("");

      // Problem pods
      const podItems = (podsData.items || []).filter(p => p.status?.phase !== "Succeeded");
      const crashPods = podItems.filter(p => (p.status?.containerStatuses || []).some(c => c.state?.waiting?.reason === "CrashLoopBackOff"));
      const oomPods = podItems.filter(p => (p.status?.containerStatuses || []).some(c => c.lastState?.terminated?.reason === "OOMKilled"));
      const imgPods = podItems.filter(p => (p.status?.containerStatuses || []).some(c => c.state?.waiting?.reason === "ImagePullBackOff" || c.state?.waiting?.reason === "ErrImagePull"));
      const pendingPods = podItems.filter(p => p.status?.phase === "Pending");
      parts.push(`**Problem Pods:** ${podItems.length} non-running`);
      if (crashPods.length) parts.push(`  ⛔ ${crashPods.length} in CrashLoopBackOff`);
      if (oomPods.length) parts.push(`  ⛔ ${oomPods.length} OOMKilled`);
      if (imgPods.length) parts.push(`  ⚠ ${imgPods.length} ImagePullBackOff`);
      if (pendingPods.length) parts.push(`  ⚠ ${pendingPods.length} Pending`);
      if (crashPods.length > 0) {
        parts.push("");
        parts.push("**CrashLoopBackOff Pods:**");
        crashPods.slice(0, 10).forEach(p => {
          const restarts = (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
          parts.push(`  - \`${p.metadata.name}\` in \`${p.metadata.namespace}\` (${restarts} restarts)`);
        });
      }
      parts.push("");

      // Warning events summary
      const evtItems = eventsData.items || [];
      const evtReasons = {};
      evtItems.forEach(e => { evtReasons[e.reason] = (evtReasons[e.reason] || 0) + (e.count || 1); });
      const topReasons = Object.entries(evtReasons).sort((a, b) => b[1] - a[1]).slice(0, 8);
      parts.push(`**Warning Events:** ${evtItems.length} recent`);
      topReasons.forEach(([reason, count]) => parts.push(`  - ${reason}: ${count} occurrences`));
      parts.push("");

      // MachineConfigPool status
      const mcpItems = mcsData.items || [];
      if (mcpItems.length > 0) {
        const degradedMcps = mcpItems.filter(m => (m.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
        const updatingMcps = mcpItems.filter(m => (m.status?.conditions || []).some(c => c.type === "Updating" && c.status === "True"));
        parts.push(`**MachineConfigPools:** ${mcpItems.length} total`);
        degradedMcps.forEach(m => parts.push(`  ⛔ \`${m.metadata.name}\` — Degraded`));
        updatingMcps.forEach(m => parts.push(`  ⚠ \`${m.metadata.name}\` — Updating (${m.status?.machineCount - (m.status?.updatedMachineCount || 0)} machines pending)`));
        parts.push("");
      }

      // Pending CSRs
      const pendingCsrs = (csrsData.items || []).filter(c => !(c.status?.conditions || []).some(co => co.type === "Approved"));
      if (pendingCsrs.length > 0) {
        parts.push(`**Pending CSRs:** ${pendingCsrs.length}`);
        pendingCsrs.slice(0, 5).forEach(c => parts.push(`  - \`${c.metadata.name}\` (${c.spec?.signerName || "unknown signer"})`));
        parts.push("");
      }

      // Troubleshooting commands
      parts.push("**Investigate further:**");
      parts.push(`@@SEC_FIX_CMD|oc get nodes -o wide@@`);
      parts.push(`@@SEC_FIX_CMD|oc get clusteroperators@@`);
      parts.push(`@@SEC_FIX_CMD|oc get events --all-namespaces --sort-by=.lastTimestamp@@`);
      if (notReady.length > 0) {
        parts.push(`@@SEC_FIX_CMD|oc describe node ${notReady[0].metadata.name}@@`);
      }
      if (degradedOps.length > 0) {
        parts.push(`@@SEC_FIX_CMD|oc describe clusteroperator ${degradedOps[0].metadata.name}@@`);
      }
      if (crashPods.length > 0) {
        parts.push(`@@SEC_FIX_CMD|oc logs ${crashPods[0].metadata.name} -n ${crashPods[0].metadata.namespace} --tail=50@@`);
      }
    } catch (e) {
      parts.push(`### Diagnostics Collection`);
      parts.push(`[WARNING] Could not gather cluster diagnostics: ${e.message}`);
    }
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Tier 6: FLEET — multi-cluster / ACM managed clusters
  // -----------------------------------------------------------------------
  if (cmd.operation === "fleet") {
    try {
      const [clusters, policies, placements] = await Promise.all([
        ocpGet("/apis/cluster.open-cluster-management.io/v1/managedclusters").catch(() => ({ items: [] })),
        ocpGet("/apis/policy.open-cluster-management.io/v1/policies").catch(() => ({ items: [] })),
        ocpGet("/apis/cluster.open-cluster-management.io/v1beta1/placements").catch(() => ({ items: [] })),
      ]);
      const clusterItems = clusters.items || [];
      const policyItems = policies.items || [];
      parts.push(`### Multi-Cluster Fleet Status (ACM)`);
      parts.push("");
      if (clusterItems.length === 0) {
        parts.push(`[WARNING] No managed clusters found. ACM (Advanced Cluster Management) may not be installed.`);
        parts.push(`\n**To enable multi-cluster management:**`);
        parts.push(`  - Install the ACM operator from OperatorHub`);
        parts.push(`  - Import or create managed clusters`);
      } else {
        const online = clusterItems.filter(c => {
          const conds = c.status?.conditions || [];
          return conds.some(cd => cd.type === "ManagedClusterConditionAvailable" && cd.status === "True");
        });
        parts.push(`**Managed Clusters:** ${clusterItems.length} total | [OK] Online: ${online.length} | [CRITICAL] Offline: ${clusterItems.length - online.length}`);
        parts.push("");
        parts.push(`| Status | Cluster | Version | Hub | Joined |`);
        parts.push(`| --- | --- | --- | --- | --- |`);
        clusterItems.forEach(c => {
          const available = c.status?.conditions?.find(cd => cd.type === "ManagedClusterConditionAvailable");
          const icon = available?.status === "True" ? "[OK]" : "[CRITICAL]";
          const version = c.status?.version?.kubernetes || c.metadata.labels?.openshiftVersion || "—";
          const isHub = c.metadata.labels?.["local-cluster"] === "true" ? "Hub" : "Spoke";
          const joined = c.metadata.creationTimestamp ? new Date(c.metadata.creationTimestamp).toLocaleDateString() : "—";
          parts.push(`| ${icon} | **${c.metadata.name}** | ${version} | ${isHub} | ${joined} |`);
        });
        if (policyItems.length > 0) {
          const compliant = policyItems.filter(p => p.status?.compliant === "Compliant");
          const nonCompliant = policyItems.filter(p => p.status?.compliant === "NonCompliant");
          parts.push("");
          parts.push(`**Governance Policies:** ${policyItems.length} total | [OK] Compliant: ${compliant.length} | [CRITICAL] NonCompliant: ${nonCompliant.length}`);
          if (nonCompliant.length > 0) {
            nonCompliant.slice(0, 5).forEach(p => {
              parts.push(`  - [CRITICAL] **${p.metadata.name}** (${p.metadata.namespace})`);
            });
          }
        }
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Fleet Status`);
      parts.push(`[WARNING] Could not query ACM resources: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 6: COMPLIANCE — policy violations / governance
  // -----------------------------------------------------------------------
  if (cmd.operation === "compliance") {
    try {
      const [compSuites, compScans, acmPolicies] = await Promise.all([
        ocpGet("/apis/compliance.openshift.io/v1alpha1/compliancesuites").catch(() => ({ items: [] })),
        ocpGet("/apis/compliance.openshift.io/v1alpha1/compliancescans").catch(() => ({ items: [] })),
        ocpGet("/apis/policy.open-cluster-management.io/v1/policies").catch(() => ({ items: [] })),
      ]);
      const suites = compSuites.items || [];
      const scans = compScans.items || [];
      const policies = acmPolicies.items || [];
      parts.push(`### Compliance & Governance Status`);
      parts.push("");
      if (suites.length > 0 || scans.length > 0) {
        parts.push(`**Compliance Operator:**`);
        parts.push(`  Suites: ${suites.length} | Scans: ${scans.length}`);
        parts.push("");
        if (suites.length > 0) {
          parts.push(`| Status | Suite | Profile | Phase | Result |`);
          parts.push(`| --- | --- | --- | --- | --- |`);
          suites.forEach(s => {
            const phase = s.status?.phase || "Unknown";
            const result = s.status?.result || "—";
            const icon = result === "COMPLIANT" ? "[OK]" : result === "NON-COMPLIANT" ? "[CRITICAL]" : "[WARNING]";
            parts.push(`| ${icon} | **${s.metadata.name}** | ${s.spec?.profileBundleName || "—"} | ${phase} | ${result} |`);
          });
        }
      }
      if (policies.length > 0) {
        parts.push("");
        parts.push(`**ACM Governance Policies:**`);
        const compliant = policies.filter(p => p.status?.compliant === "Compliant");
        const nonComp = policies.filter(p => p.status?.compliant === "NonCompliant");
        parts.push(`  [OK] Compliant: ${compliant.length} | [CRITICAL] NonCompliant: ${nonComp.length} | Total: ${policies.length}`);
        if (nonComp.length > 0) {
          parts.push("");
          nonComp.slice(0, 10).forEach(p => {
            parts.push(`  - [CRITICAL] **${p.metadata.name}** in ${p.metadata.namespace}`);
          });
        }
      }
      if (suites.length === 0 && scans.length === 0 && policies.length === 0) {
        parts.push(`[WARNING] No compliance data found. Install the Compliance Operator or ACM Governance.`);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Compliance`);
      parts.push(`[WARNING] Could not query compliance data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 6: AUTOMATION — Ansible / ServiceNow integration status
  // -----------------------------------------------------------------------
  if (cmd.operation === "automation") {
    try {
      const [ansibleJobs, aap] = await Promise.all([
        ocpGet("/apis/tower.ansible.com/v1alpha1/ansiblejobs").catch(() =>
          ocpGet("/apis/batch/v1/jobs?labelSelector=ansible").catch(() => ({ items: [] }))
        ),
        ocpGet("/apis/automationcontroller.ansible.com/v1beta1/automationcontrollers").catch(() => ({ items: [] })),
      ]);
      const jobs = ansibleJobs.items || [];
      const controllers = aap.items || [];
      parts.push(`### Automation & ITSM Status`);
      parts.push("");
      if (controllers.length > 0) {
        parts.push(`**Ansible Automation Platform:**`);
        controllers.forEach(c => {
          const status = c.status?.conditions?.find(cd => cd.type === "Running");
          const icon = status?.status === "True" ? "[OK]" : "[WARNING]";
          parts.push(`  ${icon} **${c.metadata.name}** in ${c.metadata.namespace}`);
        });
        parts.push("");
      }
      if (jobs.length > 0) {
        const succeeded = jobs.filter(j => j.status?.ansibleJobResult?.status === "successful" || j.status?.succeeded > 0);
        const failed = jobs.filter(j => j.status?.ansibleJobResult?.status === "failed" || j.status?.failed > 0);
        parts.push(`**Ansible Jobs:** ${jobs.length} total | [OK] Succeeded: ${succeeded.length} | [CRITICAL] Failed: ${failed.length}`);
        parts.push("");
        const recent = [...jobs].sort((a, b) => new Date(b.metadata.creationTimestamp || 0) - new Date(a.metadata.creationTimestamp || 0));
        parts.push(`| Status | Job | Namespace | Result | Created |`);
        parts.push(`| --- | --- | --- | --- | --- |`);
        recent.slice(0, 10).forEach(j => {
          const result = j.status?.ansibleJobResult?.status || j.status?.conditions?.[0]?.type || "—";
          const icon = result === "successful" || j.status?.succeeded > 0 ? "[OK]" : "[CRITICAL]";
          parts.push(`| ${icon} | **${j.metadata.name}** | ${j.metadata.namespace} | ${result} | ${new Date(j.metadata.creationTimestamp).toLocaleString()} |`);
        });
      } else if (controllers.length === 0) {
        parts.push(`[WARNING] No Ansible Automation Platform or automation jobs found.`);
        parts.push(`\n**To enable automation:** Install the AAP operator from OperatorHub.`);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Automation Status`);
      parts.push(`[WARNING] Could not query automation resources: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 7: OPTIMIZE — right-sizing / resource optimization
  // -----------------------------------------------------------------------
  if (cmd.operation === "optimize") {
    try {
      const [pods, metrics] = await Promise.all([
        ocpGet("/api/v1/pods?fieldSelector=status.phase=Running").catch(() => ({ items: [] })),
        ocpGet("/apis/metrics.k8s.io/v1beta1/pods").catch(() => ({ items: [] })),
      ]);
      const podItems = pods.items || [];
      const metricItems = metrics.items || [];
      const metricMap = {};
      metricItems.forEach(m => {
        const key = m.metadata.namespace + "/" + m.metadata.name;
        const totalCpu = (m.containers || []).reduce((s, c) => s + parseCpuNano(c.usage?.cpu), 0);
        const totalMem = (m.containers || []).reduce((s, c) => s + parseMemBytes(c.usage?.memory), 0);
        metricMap[key] = { cpu: totalCpu, mem: totalMem };
      });
      const noLimits = [];
      const noRequests = [];
      const overprovisioned = [];
      podItems.forEach(p => {
        const key = p.metadata.namespace + "/" + p.metadata.name;
        const actual = metricMap[key];
        (p.spec?.containers || []).forEach(c => {
          const limCpu = c.resources?.limits?.cpu;
          const reqCpu = c.resources?.requests?.cpu;
          const limMem = c.resources?.limits?.memory;
          const reqMem = c.resources?.requests?.memory;
          if (!limCpu && !limMem) noLimits.push(p);
          if (!reqCpu && !reqMem) noRequests.push(p);
          if (actual && limCpu) {
            const limNano = parseCpuNano(limCpu);
            if (limNano > 0 && actual.cpu < limNano * 0.1) {
              overprovisioned.push({ pod: p, usage: actual.cpu, limit: limNano });
            }
          }
        });
      });
      parts.push(`### Resource Optimization Analysis`);
      parts.push(`**Total running pods:** ${podItems.length} | **With metrics:** ${metricItems.length}`);
      parts.push("");
      parts.push(`**Findings:**`);
      parts.push(`  - [${noLimits.length > 0 ? "WARNING" : "OK"}] **Pods without resource limits:** ${noLimits.length}`);
      parts.push(`  - [${noRequests.length > 0 ? "WARNING" : "OK"}] **Pods without resource requests:** ${noRequests.length}`);
      parts.push(`  - [${overprovisioned.length > 0 ? "WARNING" : "OK"}] **Overprovisioned pods** (using <10% of CPU limit): ${overprovisioned.length}`);
      parts.push("");
      if (overprovisioned.length > 0) {
        parts.push(`**Top overprovisioned pods (right-sizing candidates):**`);
        parts.push(`| Pod | Namespace | CPU Usage | CPU Limit | Utilization |`);
        parts.push(`| --- | --- | --- | --- | --- |`);
        overprovisioned.sort((a, b) => (a.usage / a.limit) - (b.usage / b.limit));
        overprovisioned.slice(0, 15).forEach(o => {
          const pct = ((o.usage / o.limit) * 100).toFixed(1);
          parts.push(`| **${o.pod.metadata.name}** | ${o.pod.metadata.namespace} | ${fmtCpu(String(o.usage) + "n")} | ${fmtCpu(String(o.limit) + "n")} | ${pct}% |`);
        });
        parts.push("");
        parts.push(`**Recommendation:** Review the overprovisioned pods above and adjust their CPU/memory limits to match actual usage patterns.`);
      }
      if (noLimits.length > 0) {
        parts.push("");
        const grouped = {};
        noLimits.forEach(p => { const ns = p.metadata.namespace; grouped[ns] = (grouped[ns] || 0) + 1; });
        parts.push(`**Pods without limits by namespace:**`);
        Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([ns, cnt]) => {
          parts.push(`  - **${ns}**: ${cnt} pods`);
        });
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Resource Optimization`);
      parts.push(`[WARNING] Could not analyze resource usage: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 7: NETWORK — network diagnostics, DNS, egress, connectivity
  // -----------------------------------------------------------------------
  if (cmd.operation === "network") {
    try {
      const [netPolicies, egressIPs, services, routes, ingressCtrl] = await Promise.all([
        ocpGet("/apis/networking.k8s.io/v1/networkpolicies").catch(() => ({ items: [] })),
        ocpGet("/apis/k8s.ovn.org/v1/egressips").catch(() => ({ items: [] })),
        ocpGet("/api/v1/services").catch(() => ({ items: [] })),
        ocpGet("/apis/route.openshift.io/v1/routes").catch(() => ({ items: [] })),
        ocpGet("/apis/operator.openshift.io/v1/ingresscontrollers").catch(() =>
          ocpGet("/apis/operator.openshift.io/v1/namespaces/openshift-ingress-operator/ingresscontrollers").catch(() => ({ items: [] }))
        ),
      ]);
      parts.push(`### Network Diagnostics`);
      parts.push("");
      parts.push(`**Overview:**`);
      parts.push(`  - Network Policies: ${(netPolicies.items || []).length}`);
      parts.push(`  - Egress IPs: ${(egressIPs.items || []).length}`);
      parts.push(`  - Services: ${(services.items || []).length}`);
      parts.push(`  - Routes: ${(routes.items || []).length}`);
      parts.push("");
      const controllers = ingressCtrl.items || [];
      if (controllers.length > 0) {
        parts.push(`**Ingress Controllers:**`);
        controllers.forEach(ic => {
          const avail = ic.status?.conditions?.find(c => c.type === "Available");
          const icon = avail?.status === "True" ? "[OK]" : "[CRITICAL]";
          parts.push(`  ${icon} **${ic.metadata.name}** — replicas: ${ic.status?.availableReplicas || 0}/${ic.spec?.replicas || "auto"}`);
        });
        parts.push("");
      }
      const nsByPolicy = {};
      (netPolicies.items || []).forEach(np => {
        const ns = np.metadata.namespace;
        nsByPolicy[ns] = (nsByPolicy[ns] || 0) + 1;
      });
      const nsWithPolicy = Object.keys(nsByPolicy).length;
      const svcItems = services.items || [];
      const svcNoEndpoints = svcItems.filter(s => s.spec?.type === "ClusterIP" && s.spec?.selector && Object.keys(s.spec.selector).length > 0);
      parts.push(`**Network Policy Coverage:**`);
      parts.push(`  ${nsWithPolicy} namespace(s) have network policies | ${Object.entries(nsByPolicy).reduce((s, [, v]) => s + v, 0)} total policies`);
      if (nsWithPolicy > 0) {
        Object.entries(nsByPolicy).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([ns, cnt]) => {
          parts.push(`  - **${ns}**: ${cnt} policies`);
        });
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Network Diagnostics`);
      parts.push(`[WARNING] Could not query network resources: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 8: IDENTITY — OAuth / LDAP / token / access management
  // -----------------------------------------------------------------------
  if (cmd.operation === "identity") {
    try {
      const [oauthConfig, oauthClients, users, groups, identities] = await Promise.all([
        ocpGet("/apis/config.openshift.io/v1/oauths/cluster").catch(() => null),
        ocpGet("/apis/oauth.openshift.io/v1/oauthclients").catch(() => ({ items: [] })),
        ocpGet("/apis/user.openshift.io/v1/users").catch(() => ({ items: [] })),
        ocpGet("/apis/user.openshift.io/v1/groups").catch(() => ({ items: [] })),
        ocpGet("/apis/user.openshift.io/v1/identities").catch(() => ({ items: [] })),
      ]);
      parts.push(`### Identity & Access Management`);
      parts.push("");
      if (oauthConfig) {
        const providers = oauthConfig.spec?.identityProviders || [];
        parts.push(`**Identity Providers (${providers.length}):**`);
        if (providers.length > 0) {
          providers.forEach(p => {
            const type = p.type || Object.keys(p).find(k => k !== "name" && k !== "mappingMethod" && k !== "type") || "unknown";
            parts.push(`  - [OK] **${p.name}** — type: ${type}, mapping: ${p.mappingMethod || "claim"}`);
          });
        } else {
          parts.push(`  [WARNING] No identity providers configured — only kubeadmin can log in`);
        }
        parts.push("");
      }
      parts.push(`**Users:** ${(users.items || []).length} | **Groups:** ${(groups.items || []).length} | **Identities:** ${(identities.items || []).length}`);
      parts.push(`**OAuth Clients:** ${(oauthClients.items || []).length}`);
      parts.push("");
      const grpItems = groups.items || [];
      if (grpItems.length > 0) {
        parts.push(`**Groups:**`);
        grpItems.slice(0, 10).forEach(g => {
          const members = g.users || [];
          parts.push(`  - **${g.metadata.name}**: ${members.length} member(s)`);
        });
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Identity & Access`);
      parts.push(`[WARNING] Could not query identity resources: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 8: CERTLIFE — certificate lifecycle, rotation, mTLS
  // -----------------------------------------------------------------------
  if (cmd.operation === "certlife") {
    if (llmAvailable) return null;
    parts.push(`### Certificate Lifecycle Management`);
    parts.push("");
    parts.push(`**Check certificate expiry:**`);
    parts.push(`> Ask me: *"/cert-check"*`);
    parts.push("");
    parts.push(`**Rotate certificates manually:**`);
    parts.push(`@@SEC_FIX_CMD|oc get csr -o wide@@`);
    parts.push("");
    parts.push(`**Approve pending CSRs:**`);
    parts.push(`@@SEC_FIX_CMD|oc get csr -o go-template='{{range .items}}{{if not .status}}{{.metadata.name}} {{end}}{{end}}' | xargs oc adm certificate approve@@`);
    parts.push("");
    parts.push(`**Check CA bundle:**`);
    parts.push(`@@SEC_FIX_CMD|oc get configmap kube-root-ca.crt -n openshift-config -o yaml@@`);
    parts.push("");
    parts.push(`**Cert-Manager certificates (if installed):**`);
    parts.push(`@@SEC_FIX_CMD|oc get certificates --all-namespaces@@`);
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Tier 9: SLO — SLO/SLI/error-budget tracking
  // -----------------------------------------------------------------------
  if (cmd.operation === "slo") {
    try {
      const [prometheusRules, serviceMonitors, podMonitors] = await Promise.all([
        ocpGet("/apis/monitoring.coreos.com/v1/prometheusrules").catch(() => ({ items: [] })),
        ocpGet("/apis/monitoring.coreos.com/v1/servicemonitors").catch(() => ({ items: [] })),
        ocpGet("/apis/monitoring.coreos.com/v1/podmonitors").catch(() => ({ items: [] })),
      ]);
      const rules = prometheusRules.items || [];
      const sloRules = rules.filter(r => {
        const yaml = JSON.stringify(r.spec || {}).toLowerCase();
        return yaml.includes("slo") || yaml.includes("error_budget") || yaml.includes("burn_rate") || yaml.includes("availability");
      });
      parts.push(`### SLO / SLI / Error Budget Status`);
      parts.push("");
      parts.push(`**PrometheusRules:** ${rules.length} total | **SLO-related rules:** ${sloRules.length}`);
      parts.push(`**ServiceMonitors:** ${(serviceMonitors.items || []).length} | **PodMonitors:** ${(podMonitors.items || []).length}`);
      parts.push("");
      if (sloRules.length > 0) {
        parts.push(`| Rule | Namespace | Groups | SLO Indicators |`);
        parts.push(`| --- | --- | --- | --- |`);
        sloRules.slice(0, 15).forEach(r => {
          const groups = (r.spec?.groups || []).length;
          const indicators = (r.spec?.groups || []).flatMap(g => g.rules || []).filter(rl => {
            const expr = (rl.expr || "").toLowerCase();
            return expr.includes("slo") || expr.includes("error_budget") || expr.includes("burn_rate");
          }).length;
          parts.push(`| \`${r.metadata.name}\` | ${r.metadata.namespace} | ${groups} | ${indicators} |`);
        });
      } else {
        parts.push(`[WARNING] No SLO-specific PrometheusRules found. Consider implementing SLO alerting with burn-rate windows.`);
        parts.push("");
        parts.push(`**Recommended setup:**`);
        parts.push(`- Use Sloth or pyrra for SLO definition generation`);
        parts.push(`- Define availability SLOs (99.9%, 99.95%) per service`);
        parts.push(`- Configure multi-window burn-rate alerts (5m, 30m, 1h, 6h)`);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### SLO / SLI Status`);
      parts.push(`[WARNING] Could not query SLO resources: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 9: SATURATION — resource pressure, throttling, saturation signals
  // -----------------------------------------------------------------------
  if (cmd.operation === "saturation") {
    try {
      const [nodeMetrics, nodes, pods] = await Promise.all([
        ocpGet("/apis/metrics.k8s.io/v1beta1/nodes").catch(() => ({ items: [] })),
        ocpGet("/api/v1/nodes"),
        ocpGet("/api/v1/pods?fieldSelector=status.phase=Running&limit=500"),
      ]);
      const nodeItems = nodes.items || [];
      const metricItems = nodeMetrics.items || [];
      parts.push(`### Resource Saturation & Pressure Analysis`);
      parts.push("");
      parts.push(`| Node | CPU Allocatable | CPU Used | CPU % | Memory Allocatable | Memory Used | Mem % | Pressure |`);
      parts.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
      nodeItems.forEach(n => {
        const metric = metricItems.find(m => m.metadata.name === n.metadata.name);
        const cpuAlloc = parseCpuNano(n.status?.allocatable?.cpu || "0");
        const memAlloc = parseMemBytes(n.status?.allocatable?.memory || "0");
        const cpuUsed = metric ? parseCpuNano(metric.usage?.cpu || "0") : 0;
        const memUsed = metric ? parseMemBytes(metric.usage?.memory || "0") : 0;
        const cpuPct = cpuAlloc > 0 ? ((cpuUsed / cpuAlloc) * 100).toFixed(1) : "?";
        const memPct = memAlloc > 0 ? ((memUsed / memAlloc) * 100).toFixed(1) : "?";
        const conditions = (n.status?.conditions || []);
        const pressures = conditions.filter(c => c.status === "True" && c.type !== "Ready").map(c => c.type);
        const pressureStr = pressures.length > 0 ? pressures.join(", ") : "None";
        const cpuIcon = parseFloat(cpuPct) > 80 ? "[CRITICAL]" : parseFloat(cpuPct) > 60 ? "[WARNING]" : "[OK]";
        const memIcon = parseFloat(memPct) > 85 ? "[CRITICAL]" : parseFloat(memPct) > 70 ? "[WARNING]" : "[OK]";
        parts.push(`| \`${n.metadata.name}\` | ${fmtCpu(n.status?.allocatable?.cpu)} | ${fmtCpu(metric?.usage?.cpu || "0")} | ${cpuIcon} ${cpuPct}% | ${fmtMem(n.status?.allocatable?.memory)} | ${fmtMem(metric?.usage?.memory || "0")} | ${memIcon} ${memPct}% | ${pressureStr} |`);
      });
      parts.push("");
      const throttledPods = (pods.items || []).filter(p => {
        const statuses = p.status?.containerStatuses || [];
        return statuses.some(cs => (cs.restartCount || 0) > 5);
      });
      if (throttledPods.length > 0) {
        parts.push(`**High-restart pods (possible throttling):** ${throttledPods.length}`);
        throttledPods.slice(0, 10).forEach(p => {
          const maxRestarts = Math.max(...(p.status?.containerStatuses || []).map(cs => cs.restartCount || 0));
          parts.push(`  - \`${p.metadata.name}\` (${p.metadata.namespace}) — ${maxRestarts} restarts`);
        });
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Resource Saturation`);
      parts.push(`[WARNING] Could not query saturation data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 9: INCIDENT — active incident detection from cluster signals
  // -----------------------------------------------------------------------
  if (cmd.operation === "incident") {
    try {
      const [events, nodes, pods] = await Promise.all([
        ocpGet("/api/v1/events?fieldSelector=type=Warning&limit=200"),
        ocpGet("/api/v1/nodes"),
        ocpGet("/api/v1/pods?limit=500"),
      ]);
      const warningEvents = (events.items || []).sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));
      const notReadyNodes = (nodes.items || []).filter(n => {
        const ready = (n.status?.conditions || []).find(c => c.type === "Ready");
        return !ready || ready.status !== "True";
      });
      const crashPods = (pods.items || []).filter(p => {
        const statuses = p.status?.containerStatuses || [];
        return statuses.some(cs => cs.state?.waiting?.reason === "CrashLoopBackOff");
      });
      const pendingPods = (pods.items || []).filter(p => p.status?.phase === "Pending");
      parts.push(`### Active Incident Summary`);
      parts.push("");
      const severity = (notReadyNodes.length > 0 || crashPods.length > 10) ? "[CRITICAL]" : (crashPods.length > 0 || pendingPods.length > 5) ? "[WARNING]" : "[OK]";
      parts.push(`**Cluster Severity:** ${severity}`);
      parts.push("");
      parts.push(`| Signal | Count | Status |`);
      parts.push(`| --- | --- | --- |`);
      parts.push(`| NotReady Nodes | ${notReadyNodes.length} | ${notReadyNodes.length > 0 ? "[CRITICAL]" : "[OK]"} |`);
      parts.push(`| CrashLoopBackOff Pods | ${crashPods.length} | ${crashPods.length > 0 ? "[WARNING]" : "[OK]"} |`);
      parts.push(`| Pending Pods | ${pendingPods.length} | ${pendingPods.length > 5 ? "[WARNING]" : "[OK]"} |`);
      parts.push(`| Warning Events (recent) | ${warningEvents.length} | ${warningEvents.length > 50 ? "[WARNING]" : "[OK]"} |`);
      parts.push("");
      if (notReadyNodes.length > 0) {
        parts.push(`**NotReady Nodes:**`);
        notReadyNodes.forEach(n => parts.push(`  - [CRITICAL] \`${n.metadata.name}\``));
        parts.push("");
      }
      if (crashPods.length > 0) {
        parts.push(`**CrashLoopBackOff Pods:**`);
        crashPods.slice(0, 10).forEach(p => parts.push(`  - [WARNING] \`${p.metadata.name}\` (${p.metadata.namespace})`));
        parts.push("");
      }
      if (warningEvents.length > 0) {
        parts.push(`**Top Warning Events:**`);
        const grouped = {};
        warningEvents.forEach(e => {
          const key = e.reason || "Unknown";
          grouped[key] = (grouped[key] || 0) + 1;
        });
        Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([reason, count]) => {
          parts.push(`  - **${reason}**: ${count} occurrences`);
        });
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Incident Summary`);
      parts.push(`[WARNING] Could not gather incident data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // INCIDENT RESPONSE — full orchestrated triage pipeline
  // Chat → Diagnose → Fix → Ticket → Notify
  // -----------------------------------------------------------------------
  if (cmd.operation === "incident_response") {
    try {
      const targetNs = cmd.namespace || null;
      const targetName = cmd.resourceName || null;
      const cli = "oc";

      // Phase 1: Parallel data collection
      const alertmanagerPaths = [
        "/api/v1/namespaces/openshift-monitoring/services/alertmanager-main:web/proxy/api/v2/alerts",
        "/api/v1/namespaces/monitoring/services/alertmanager-main:web/proxy/api/v2/alerts",
      ];
      const fetchAlerts = async () => {
        for (const p of alertmanagerPaths) {
          try { const r = await ocpGet(p); if (Array.isArray(r)) return r; } catch {}
        }
        return [];
      };
      const [events, nodes, nodeMetrics, pods, deploys, alertsData, pvcs, podMetricsData] = await Promise.all([
        ocpGet(`/api/v1/${targetNs ? `namespaces/${targetNs}/` : ""}events?fieldSelector=type=Warning&limit=300`).catch(() => ({ items: [] })),
        ocpGet("/api/v1/nodes").catch(() => ({ items: [] })),
        ocpGet("/apis/metrics.k8s.io/v1beta1/nodes").catch(() => ({ items: [] })),
        ocpGet(`/api/v1/${targetNs ? `namespaces/${targetNs}/` : ""}pods?limit=500`).catch(() => ({ items: [] })),
        ocpGet(`/apis/apps/v1/${targetNs ? `namespaces/${targetNs}/` : ""}deployments`).catch(() => ({ items: [] })),
        fetchAlerts(),
        ocpGet(`/api/v1/${targetNs ? `namespaces/${targetNs}/` : ""}persistentvolumeclaims`).catch(() => ({ items: [] })),
        ocpGet(`/apis/metrics.k8s.io/v1beta1/${targetNs ? `namespaces/${targetNs}/` : ""}pods`).catch(() => ({ items: [] })),
      ]);

      const podItems = pods.items || [];
      const nodeItems = nodes.items || [];
      const deployItems = deploys.items || [];
      const pvcItems = pvcs.items || [];
      const warningEvents = (events.items || []).sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));
      const firingAlerts = Array.isArray(alertsData) ? alertsData.filter(a => a.status?.state === "active") : [];

      // Phase 2: Classify problem signals
      const crashPods = podItems.filter(p => (p.status?.containerStatuses || []).some(cs => cs.state?.waiting?.reason === "CrashLoopBackOff"));
      const oomPods = podItems.filter(p => (p.status?.containerStatuses || []).some(cs => cs.state?.terminated?.reason === "OOMKilled" || cs.lastState?.terminated?.reason === "OOMKilled"));
      const imagePullPods = podItems.filter(p => (p.status?.containerStatuses || []).some(cs => cs.state?.waiting?.reason === "ImagePullBackOff" || cs.state?.waiting?.reason === "ErrImagePull"));
      const pendingPods = podItems.filter(p => p.status?.phase === "Pending");
      const failedPods = podItems.filter(p => p.status?.phase === "Failed");
      const highRestartPods = podItems.filter(p => (p.status?.containerStatuses || []).some(cs => (cs.restartCount || 0) >= 10));
      const notReadyNodes = nodeItems.filter(n => !(n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True"));
      const pressureNodes = nodeItems.filter(n => (n.status?.conditions || []).some(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True"));
      const unavailDeploys = deployItems.filter(d => (d.status?.unavailableReplicas || 0) > 0);
      const zeroDeploys = deployItems.filter(d => (d.status?.readyReplicas || 0) === 0 && (d.spec?.replicas || 0) > 0);
      const boundlessPVCs = pvcItems.filter(p => p.status?.phase !== "Bound");

      // Phase 3: Compute severity
      const nsCriticals = crashPods.length + zeroDeploys.length + oomPods.length;
      const nsWarnings = pendingPods.length + imagePullPods.length + unavailDeploys.length + highRestartPods.length + boundlessPVCs.length;
      const criticals = targetNs ? nsCriticals : nsCriticals + notReadyNodes.length;
      const warnings = targetNs ? nsWarnings : nsWarnings + pressureNodes.length;
      const severity = criticals >= 3 ? "SEV-1" : criticals >= 1 ? "SEV-2" : warnings >= 3 ? "SEV-3" : warnings >= 1 ? "SEV-4" : "SEV-5";
      const severityLabel = { "SEV-1": "[CRITICAL] SEV-1 — Major Outage", "SEV-2": "[CRITICAL] SEV-2 — Significant Impact", "SEV-3": "[WARNING] SEV-3 — Moderate Impact", "SEV-4": "[WARNING] SEV-4 — Low Impact", "SEV-5": "[OK] SEV-5 — No Issues Detected" }[severity];

      // Phase 4: Root cause analysis
      const rootCauses = [];
      if (notReadyNodes.length) rootCauses.push({ signal: "Node Failure", detail: `${notReadyNodes.length} NotReady node(s): ${notReadyNodes.map(n => n.metadata.name).join(", ")}` });
      if (pressureNodes.length) rootCauses.push({ signal: "Resource Pressure", detail: `${pressureNodes.length} node(s) under pressure` });
      if (oomPods.length) rootCauses.push({ signal: "OOMKilled", detail: `${oomPods.length} pod(s): ${oomPods.slice(0, 3).map(p => `${p.metadata.namespace}/${p.metadata.name}`).join(", ")}` });
      if (crashPods.length) rootCauses.push({ signal: "CrashLoopBackOff", detail: `${crashPods.length} pod(s): ${crashPods.slice(0, 3).map(p => `${p.metadata.namespace}/${p.metadata.name}`).join(", ")}` });
      if (imagePullPods.length) rootCauses.push({ signal: "ImagePullBackOff", detail: `${imagePullPods.length} pod(s)` });
      if (zeroDeploys.length) rootCauses.push({ signal: "Zero-Ready Deployments", detail: `${zeroDeploys.length}: ${zeroDeploys.slice(0, 3).map(d => `${d.metadata.namespace}/${d.metadata.name}`).join(", ")}` });
      if (unavailDeploys.length) rootCauses.push({ signal: "Partially Unavailable", detail: `${unavailDeploys.length} deployment(s)` });
      if (pendingPods.length) rootCauses.push({ signal: "Scheduling Failures", detail: `${pendingPods.length} Pending pod(s)` });
      if (boundlessPVCs.length) rootCauses.push({ signal: "Unbound PVCs", detail: `${boundlessPVCs.length} PVC(s) not bound` });
      if (highRestartPods.length) rootCauses.push({ signal: "High Restart Count", detail: `${highRestartPods.length} pod(s) with ≥10 restarts` });

      // Phase 5: Blast radius
      const affectedNs = new Set([
        ...crashPods.map(p => p.metadata.namespace),
        ...oomPods.map(p => p.metadata.namespace),
        ...zeroDeploys.map(d => d.metadata.namespace),
        ...failedPods.map(p => p.metadata.namespace),
      ]);

      // Phase 6: Event fingerprint
      const topEvents = warningEvents.slice(0, 10);

      // Phase 7: Node utilization
      const nodeMetricItems = nodeMetrics.items || [];

      // Phase 8: Build triage report
      const scope = targetNs ? `namespace \`${targetNs}\`` : "cluster-wide";
      parts.push(`### Incident Response Report — ${severity}`);
      parts.push("");
      parts.push(`**Severity:** ${severityLabel}`);
      parts.push(`**Scope:** ${scope}${targetName ? ` (target: \`${targetName}\`)` : ""}`);
      parts.push(`**Affected Namespaces:** ${affectedNs.size > 0 ? [...affectedNs].map(n => `\`${n}\``).join(", ") : "none"}`);
      parts.push(`**Blast Radius:** ${affectedNs.size} namespace(s), ${criticals + warnings} signal(s)`);
      parts.push("");

      if (rootCauses.length > 0) {
        parts.push(`**Root Cause Analysis**`);
        parts.push("");
        parts.push(`| Signal | Detail |`);
        parts.push(`| --- | --- |`);
        rootCauses.forEach(r => parts.push(`| ${r.signal} | ${r.detail} |`));
        parts.push("");
      }

      if (topEvents.length > 0) {
        parts.push(`**Recent Warning Events** (top ${topEvents.length})`);
        parts.push("");
        topEvents.forEach(e => {
          const age = e.lastTimestamp ? `${Math.round((Date.now() - new Date(e.lastTimestamp)) / 60000)}m ago` : "?";
          parts.push(`  - **${e.reason}** on \`${e.involvedObject?.name || "?"}\` (${e.involvedObject?.namespace || "?"}): ${(e.message || "").slice(0, 120)} — ${age}`);
        });
        parts.push("");
      }

      if (firingAlerts.length > 0) {
        parts.push(`**Firing Alerts** (${firingAlerts.length})`);
        parts.push("");
        firingAlerts.slice(0, 10).forEach(a => {
          const name = a.labels?.alertname || "unknown";
          const ns = a.labels?.namespace || "";
          parts.push(`  - **${name}** ${ns ? `(${ns})` : ""}`);
        });
        parts.push("");
      }

      // Metrics-based memory sizing for recommendations
      const podMetricsItems = (podMetricsData.items || []);
      const podMetricsMap = new Map();
      for (const pm of podMetricsItems) {
        podMetricsMap.set(`${pm.metadata.namespace}/${pm.metadata.name}`, pm);
      }

      function smartMemoryLimit(pod, containerName) {
        const spec = (pod.spec?.containers || []).find(c => c.name === containerName);
        const currentLimit = spec?.resources?.limits?.memory || "";
        const currentLimitBytes = parseMemBytes(currentLimit);
        const pm = podMetricsMap.get(`${pod.metadata.namespace}/${pod.metadata.name}`);
        const actualUsage = (pm?.containers || []).find(c => c.name === containerName);
        const actualBytes = actualUsage ? parseMemBytes(actualUsage.usage?.memory) : 0;
        const baseBytes = actualBytes > 0 ? actualBytes : currentLimitBytes;
        if (baseBytes === 0) return { limit: "512Mi", basis: "default (no metrics available)" };
        const recommended = Math.ceil((baseBytes * 1.5) / (1024 * 1024));
        const rounded = recommended <= 128 ? 128
          : recommended <= 256 ? 256
          : recommended <= 512 ? 512
          : recommended <= 1024 ? 1024
          : Math.ceil(recommended / 256) * 256;
        const limitStr = rounded >= 1024 ? `${(rounded / 1024).toFixed(0)}Gi` : `${rounded}Mi`;
        if (actualBytes > 0) {
          const usageMi = Math.round(actualBytes / (1024 * 1024));
          return { limit: limitStr, basis: `actual usage ${usageMi}Mi + 50% headroom` };
        }
        const prevMi = Math.round(currentLimitBytes / (1024 * 1024));
        return { limit: limitStr, basis: `previous limit ${prevMi || "?"}Mi × 1.5` };
      }

      // Phase 9: Recommended Actions
      parts.push(`**Recommended Actions**`);
      parts.push("");
      let actionNum = 1;
      if (oomPods.length > 0) {
        const p0 = oomPods[0];
        const oomCs = (p0.status?.containerStatuses || []).find(cs =>
          cs.state?.terminated?.reason === "OOMKilled" || cs.lastState?.terminated?.reason === "OOMKilled"
        );
        const container = oomCs?.name || (p0.spec?.containers || [])[0]?.name || "main";
        const ownerDeploy = (p0.metadata?.ownerReferences || []).find(o => o.kind === "ReplicaSet");
        const deployName = ownerDeploy ? ownerDeploy.name.replace(/-[a-f0-9]+$/, "") : null;
        if (deployName) {
          const { limit, basis } = smartMemoryLimit(p0, container);
          parts.push(`${actionNum++}. Fix OOMKilled Pods — set memory to **${limit}** (${basis})`);
          parts.push("");
          parts.push(`@@SEC_FIX_CMD|${cli} set resources deployment/${deployName} -n ${p0.metadata.namespace} -c ${container} --limits=memory=${limit}@@`);
          parts.push("");
        }
      }
      if (crashPods.length > 0) {
        const p0 = crashPods[0];
        const ownerDeploy = (p0.metadata?.ownerReferences || []).find(o => o.kind === "ReplicaSet");
        const deployName = ownerDeploy ? ownerDeploy.name.replace(/-[a-f0-9]+$/, "") : null;
        if (deployName) {
          parts.push(`${actionNum++}. Restart CrashLooping Deployment`);
          parts.push("");
          parts.push(`@@SEC_FIX_CMD|${cli} rollout restart deployment/${deployName} -n ${p0.metadata.namespace}@@`);
          parts.push("");
        }
      }
      if (zeroDeploys.length > 0) {
        const d0 = zeroDeploys[0];
        parts.push(`${actionNum++}. Restart Zero-Ready Deployment`);
        parts.push("");
        parts.push(`@@SEC_FIX_CMD|${cli} rollout restart deployment/${d0.metadata.name} -n ${d0.metadata.namespace}@@`);
        parts.push("");
      }

      // Phase 10: Escalation table
      parts.push(`**Escalation**`);
      parts.push("");
      parts.push(`| Step | Action | Status |`);
      parts.push(`| --- | --- | --- |`);

      // Phase 11: ServiceNow ticket — auto-create for SEV-1/SEV-2
      let snowTicket = null;
      if ((severity === "SEV-1" || severity === "SEV-2") && isServiceNowEnabled()) {
        const rcSummary = rootCauses.map(r => `${r.signal}: ${r.detail}`).join("; ");
        const fixSummary = oomPods.length > 0 ? "Increase memory limits based on actual usage metrics"
          : crashPods.length > 0 ? "Restart affected deployments"
          : zeroDeploys.length > 0 ? "Scale up zero-ready deployments" : "Investigate and remediate";
        try {
          snowTicket = await createServiceNowIncident({
            shortDescription: `[${severity}] ${rootCauses[0]?.signal || "Cluster Issue"} — ${targetNs || "cluster-wide"} — Auto-generated by TCS Agentic AI`,
            description: [
              `Severity: ${severity}`,
              `Scope: ${scope}`,
              `Affected Namespaces: ${[...affectedNs].join(", ") || "none"}`,
              ``,
              `ROOT CAUSE ANALYSIS:`,
              ...rootCauses.map(r => `  - ${r.signal}: ${r.detail}`),
              ``,
              `BLAST RADIUS: ${affectedNs.size} namespace(s), ${criticals} critical + ${warnings} warning signal(s)`,
              ``,
              `RECOMMENDED FIX: ${fixSummary}`,
              ``,
              `Auto-generated by TCS Agentic AI incident response pipeline.`,
            ].join("\n"),
            urgency: severity === "SEV-1" ? "1" : "2",
            impact: severity === "SEV-1" ? "1" : "2",
          });
          const incNumber = snowTicket?.result?.number || "created";
          parts.push(`| ServiceNow Incident | Auto-created | **${incNumber}** — ${severity} |`);
        } catch (snowErr) {
          snowTicket = { error: snowErr.message };
          parts.push(`| ServiceNow Incident | Failed | ${snowErr.message.slice(0, 100)} |`);
        }
      } else if (severity === "SEV-1" || severity === "SEV-2") {
        parts.push(`| ServiceNow Incident | Skipped | ServiceNow not configured (set SERVICENOW_INSTANCE) |`);
      } else {
        parts.push(`| ServiceNow Incident | Skipped | Auto-ticket only for SEV-1/SEV-2 (current: ${severity}) |`);
      }

      // Phase 12: Notifications
      if (severity === "SEV-1" || severity === "SEV-2" || severity === "SEV-3") {
        try {
          await notifyAll({
            title: `[${severity}] Incident Response — ${targetNs || "cluster-wide"}`,
            text: rootCauses.map(r => `${r.signal}: ${r.detail}`).join("\n"),
            severity: severity === "SEV-1" ? "critical" : severity === "SEV-2" ? "high" : "warning",
            namespace: targetNs || undefined,
            cluster: "local",
          });
          parts.push(`| Team Notification | Sent | Slack/Teams/PagerDuty alert dispatched |`);
        } catch {
          parts.push(`| Team Notification | Failed | Notification dispatch error |`);
        }
      } else {
        parts.push(`| Team Notification | Skipped | Auto-notify only for SEV-1/SEV-2/SEV-3 |`);
      }
      parts.push("");

      // Phase 13: Fix proposals with metrics-based sizing
      const fixProposals = [];
      crashPods.slice(0, 3).forEach(p => {
        const ownerDeploy = (p.metadata?.ownerReferences || []).find(o => o.kind === "ReplicaSet");
        const deployName = ownerDeploy ? ownerDeploy.name.replace(/-[a-f0-9]+$/, "") : null;
        if (deployName) {
          fixProposals.push({
            title: `Restart deployment ${deployName}`,
            action: "restart_deployment", resource: deployName, namespace: p.metadata.namespace,
            resourceType: "deployment",
            command: `${cli} rollout restart deployment/${deployName} -n ${p.metadata.namespace}`,
            risk: "low",
            description: `Restart ${deployName} to recover from CrashLoopBackOff`,
          });
        }
      });
      oomPods.slice(0, 3).forEach(p => {
        const oomCs = (p.status?.containerStatuses || []).find(cs =>
          cs.state?.terminated?.reason === "OOMKilled" || cs.lastState?.terminated?.reason === "OOMKilled"
        );
        const containerName = oomCs?.name || (p.spec?.containers || [])[0]?.name || "main";
        const ownerDeploy = (p.metadata?.ownerReferences || []).find(o => o.kind === "ReplicaSet");
        const deployName = ownerDeploy ? ownerDeploy.name.replace(/-[a-f0-9]+$/, "") : p.metadata.name;
        const { limit, basis } = smartMemoryLimit(p, containerName);
        fixProposals.push({
          title: `Increase memory for ${deployName} → ${limit}`,
          action: "set_resources", resource: deployName, namespace: p.metadata.namespace,
          resourceType: "deployment",
          command: `${cli} set resources deployment/${deployName} -n ${p.metadata.namespace} -c ${containerName} --limits=memory=${limit}`,
          risk: "low",
          description: `Set memory limit to ${limit} (${basis})`,
        });
      });
      zeroDeploys.slice(0, 3).forEach(d => {
        fixProposals.push({
          title: `Restart deployment ${d.metadata.name}`,
          action: "restart_deployment", resource: d.metadata.name, namespace: d.metadata.namespace,
          resourceType: "deployment",
          command: `${cli} rollout restart deployment/${d.metadata.name} -n ${d.metadata.namespace}`,
          risk: "low",
          description: `Restart ${d.metadata.name} (0/${d.spec?.replicas || 0} replicas ready)`,
        });
      });

      // Phase 14: Automation Status summary
      parts.push(`### Automation Status`);
      parts.push("");
      parts.push(`| Action | Status | Detail |`);
      parts.push(`| --- | --- | --- |`);
      parts.push(`| Diagnose | [DONE] | ${rootCauses.length} root cause(s) identified |`);
      if (snowTicket && !snowTicket.error) {
        parts.push(`| ServiceNow Ticket | [DONE] | **${snowTicket.result?.number || "created"}** — auto-raised for ${severity} |`);
      } else if (snowTicket?.error) {
        parts.push(`| ServiceNow Ticket | [SKIP] | ServiceNow error: ${snowTicket.error.slice(0, 80)} |`);
      } else if (severity === "SEV-1" || severity === "SEV-2") {
        parts.push(`| ServiceNow Ticket | [SKIP] | ServiceNow not configured (set SERVICENOW_INSTANCE) |`);
      } else {
        parts.push(`| ServiceNow Ticket | [SKIP] | Auto-ticket only for SEV-1/SEV-2 |`);
      }
      if (severity === "SEV-1" || severity === "SEV-2" || severity === "SEV-3") {
        parts.push(`| Team Notification | [SENT] | Slack/Teams/PagerDuty alert dispatched |`);
      } else {
        parts.push(`| Team Notification | [SKIP] | Auto-notify only for SEV-1/SEV-2/SEV-3 |`);
      }
      parts.push(`| Fix Proposals | [READY] | ${fixProposals.length} one-click fix(es) available below |`);
      parts.push("");

      // Phase 15: FIX_PROPOSAL card with incident context for auto-close
      if (fixProposals.length > 0) {
        const diagPayload = {
          podName: "incident_response",
          namespace: targetNs || "cluster-wide",
          severity: severity === "SEV-1" || severity === "SEV-2" ? "critical" : "warning",
          diagnosis: `${severity} — ${rootCauses.map(r => r.signal).join(", ")}`,
          rootCause: rootCauses[0]?.signal || "multiple",
          evidence: rootCauses.map(r => r.detail),
          fixes: fixProposals,
          incidentSysId: snowTicket && !snowTicket.error ? snowTicket.result?.sys_id || null : null,
          incidentNumber: snowTicket && !snowTicket.error ? snowTicket.result?.number || null : null,
        };
        const fixJson = JSON.stringify(diagPayload).replace(/@@/g, "@ @");
        parts.push(`@@FIX_PROPOSAL|${fixJson}@@`);
      }

      return parts.join("\n");
    } catch (e) {
      console.error(`[chat] incident_response pipeline error: ${e.message}`);
      parts.push(`### Incident Response`);
      parts.push(`[WARNING] Pipeline error: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 9: POSTMORTEM — post-incident analysis and timeline
  // -----------------------------------------------------------------------
  if (cmd.operation === "postmortem") {
    try {
      const [events, pods] = await Promise.all([
        ocpGet("/api/v1/events?limit=500"),
        ocpGet("/api/v1/pods?limit=500"),
      ]);
      const allEvents = (events.items || []).sort((a, b) => new Date(a.lastTimestamp || 0) - new Date(b.lastTimestamp || 0));
      const warningEvents = allEvents.filter(e => e.type === "Warning");
      parts.push(`### Post-Incident Analysis / Postmortem Data`);
      parts.push("");
      parts.push(`**Total Events:** ${allEvents.length} | **Warning Events:** ${warningEvents.length}`);
      parts.push("");
      if (warningEvents.length > 0) {
        parts.push(`**Event Timeline (chronological):**`);
        parts.push(`| Time | Type | Reason | Object | Message |`);
        parts.push(`| --- | --- | --- | --- | --- |`);
        warningEvents.slice(-20).forEach(e => {
          const time = e.lastTimestamp ? new Date(e.lastTimestamp).toISOString().replace("T", " ").slice(0, 19) : "—";
          const obj = `${e.involvedObject?.kind || "?"}/${e.involvedObject?.name || "?"}`;
          const msg = (e.message || "").substring(0, 80).replace(/\|/g, "/");
          parts.push(`| ${time} | ${e.type} | ${e.reason} | ${obj} | ${msg} |`);
        });
        parts.push("");
      }
      const failedPods = (pods.items || []).filter(p => p.status?.phase === "Failed" || (p.status?.containerStatuses || []).some(cs => cs.state?.terminated?.exitCode !== 0 && cs.state?.terminated));
      if (failedPods.length > 0) {
        parts.push(`**Failed/Terminated Pods:** ${failedPods.length}`);
        failedPods.slice(0, 10).forEach(p => {
          const reason = (p.status?.containerStatuses || []).map(cs => cs.state?.terminated?.reason || cs.state?.waiting?.reason).filter(Boolean).join(", ") || p.status?.phase;
          parts.push(`  - \`${p.metadata.name}\` (${p.metadata.namespace}) — ${reason}`);
        });
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Postmortem Data`);
      parts.push(`[WARNING] Could not gather postmortem data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 9: IMPACT — blast radius / impact analysis
  // -----------------------------------------------------------------------
  if (cmd.operation === "impact") {
    try {
      const [pods, services, deploys, events] = await Promise.all([
        ocpGet("/api/v1/pods?limit=500"),
        ocpGet("/api/v1/services?limit=500"),
        ocpGet("/apis/apps/v1/deployments?limit=500"),
        ocpGet("/api/v1/events?fieldSelector=type=Warning&limit=200"),
      ]);
      const crashPods = (pods.items || []).filter(p => (p.status?.containerStatuses || []).some(cs => cs.state?.waiting?.reason === "CrashLoopBackOff" || cs.state?.waiting?.reason === "ImagePullBackOff"));
      const affectedNs = [...new Set(crashPods.map(p => p.metadata.namespace))];
      const affectedDeploys = (deploys.items || []).filter(d => {
        const unavail = (d.status?.unavailableReplicas || 0);
        return unavail > 0;
      });
      parts.push(`### Blast Radius / Impact Analysis`);
      parts.push("");
      parts.push(`| Metric | Count |`);
      parts.push(`| --- | --- |`);
      parts.push(`| Affected Pods (CrashLoop/ImagePull) | ${crashPods.length} |`);
      parts.push(`| Affected Namespaces | ${affectedNs.length} |`);
      parts.push(`| Degraded Deployments | ${affectedDeploys.length} |`);
      parts.push(`| Warning Events | ${(events.items || []).length} |`);
      parts.push("");
      if (affectedNs.length > 0) {
        parts.push(`**Affected Namespaces:** ${affectedNs.join(", ")}`);
        parts.push("");
      }
      if (affectedDeploys.length > 0) {
        parts.push(`**Degraded Deployments:**`);
        affectedDeploys.slice(0, 10).forEach(d => {
          parts.push(`  - [WARNING] \`${d.metadata.name}\` (${d.metadata.namespace}) — ${d.status?.unavailableReplicas} unavailable / ${d.spec?.replicas} desired`);
        });
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Impact Analysis`);
      parts.push(`[WARNING] Could not gather impact data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 9: DEPRECATED — deprecated API usage detection
  // -----------------------------------------------------------------------
  if (cmd.operation === "deprecated") {
    try {
      const [events, apiResources] = await Promise.all([
        ocpGet("/api/v1/events?limit=500"),
        ocpGet("/apis").catch(() => ({ groups: [] })),
      ]);
      const deprecationEvents = (events.items || []).filter(e => {
        const msg = (e.message || "").toLowerCase();
        return msg.includes("deprecated") || msg.includes("removed") || e.reason === "DeprecatedAPIVersion";
      });
      parts.push(`### Deprecated API Usage Detection`);
      parts.push("");
      if (deprecationEvents.length > 0) {
        parts.push(`[WARNING] **${deprecationEvents.length} deprecation events found:**`);
        parts.push("");
        parts.push(`| Time | Reason | Object | Message |`);
        parts.push(`| --- | --- | --- | --- |`);
        deprecationEvents.slice(0, 20).forEach(e => {
          const time = e.lastTimestamp ? new Date(e.lastTimestamp).toISOString().slice(0, 19) : "—";
          const obj = `${e.involvedObject?.kind || "?"}/${e.involvedObject?.name || "?"}`;
          const msg = (e.message || "").substring(0, 100).replace(/\|/g, "/");
          parts.push(`| ${time} | ${e.reason} | ${obj} | ${msg} |`);
        });
      } else {
        parts.push(`[OK] No deprecation warning events found in recent cluster events.`);
      }
      parts.push("");
      parts.push(`**Check for deprecated API usage:**`);
      parts.push(`@@SEC_FIX_CMD|oc get apirequestcounts -o jsonpath='{range .items[?(@.status.removedInRelease!="")]}{.metadata.name}{" removed in "}{.status.removedInRelease}{"\\n"}{end}'@@`);
      parts.push("");
      parts.push(`**Audit deprecated API requests:**`);
      parts.push(`@@SEC_FIX_CMD|oc get apirequestcounts -o wide@@`);
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Deprecated API Detection`);
      parts.push(`[WARNING] Could not query deprecation data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 9: WEBHOOK — admission webhook analysis
  // -----------------------------------------------------------------------
  if (cmd.operation === "webhook") {
    try {
      const [validating, mutating] = await Promise.all([
        ocpGet("/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations"),
        ocpGet("/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations"),
      ]);
      const vItems = validating.items || [];
      const mItems = mutating.items || [];
      parts.push(`### Admission Webhooks`);
      parts.push("");
      parts.push(`**Validating Webhooks:** ${vItems.length} | **Mutating Webhooks:** ${mItems.length}`);
      parts.push("");
      if (vItems.length > 0) {
        parts.push(`**Validating Webhook Configurations:**`);
        parts.push(`| Name | Webhooks | Failure Policy |`);
        parts.push(`| --- | --- | --- |`);
        vItems.forEach(v => {
          const wh = v.webhooks || [];
          const policies = [...new Set(wh.map(w => w.failurePolicy || "Fail"))].join(", ");
          parts.push(`| \`${v.metadata.name}\` | ${wh.length} | ${policies} |`);
        });
        parts.push("");
      }
      if (mItems.length > 0) {
        parts.push(`**Mutating Webhook Configurations:**`);
        parts.push(`| Name | Webhooks | Failure Policy |`);
        parts.push(`| --- | --- | --- |`);
        mItems.forEach(m => {
          const wh = m.webhooks || [];
          const policies = [...new Set(wh.map(w => w.failurePolicy || "Fail"))].join(", ");
          parts.push(`| \`${m.metadata.name}\` | ${wh.length} | ${policies} |`);
        });
      }
      const failClosed = [...vItems, ...mItems].filter(c => (c.webhooks || []).some(w => w.failurePolicy === "Fail"));
      if (failClosed.length > 0) {
        parts.push("");
        parts.push(`[WARNING] **${failClosed.length} webhook(s) with failurePolicy=Fail** — could block cluster operations if webhook service is down`);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Admission Webhooks`);
      parts.push(`[WARNING] Could not query webhook data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 10: SUPPLYCHAIN — supply chain security (SBOM, signing, provenance)
  // -----------------------------------------------------------------------
  if (cmd.operation === "supplychain") {
    try {
      const [pods, imageSignPolicies, clusterImagePolicies] = await Promise.all([
        ocpGet("/api/v1/pods?limit=300"),
        ocpGet("/apis/image.openshift.io/v1/imagesignatures").catch(() => ({ items: [] })),
        ocpGet("/apis/config.openshift.io/v1/images/cluster").catch(() => null),
      ]);
      const allImages = new Set();
      (pods.items || []).forEach(p => {
        (p.spec?.containers || []).forEach(c => allImages.add(c.image));
        (p.spec?.initContainers || []).forEach(c => allImages.add(c.image));
      });
      const unsigned = [...allImages].filter(img => !img.includes("@sha256:"));
      parts.push(`### Supply Chain Security Assessment`);
      parts.push("");
      parts.push(`**Total Unique Images:** ${allImages.size}`);
      parts.push(`**Images without digest (tag-only):** ${unsigned.length > 0 ? `[WARNING] ${unsigned.length}` : `[OK] 0`}`);
      parts.push("");
      if (unsigned.length > 0) {
        parts.push(`**Tag-only images (no provenance guarantee):**`);
        unsigned.slice(0, 15).forEach(img => parts.push(`  - [WARNING] \`${img}\``));
        parts.push("");
      }
      if (clusterImagePolicies) {
        const registrySources = clusterImagePolicies.spec?.registrySources || {};
        if (registrySources.allowedRegistries?.length > 0) {
          parts.push(`**Allowed Registries:** ${registrySources.allowedRegistries.join(", ")}`);
        }
        if (registrySources.blockedRegistries?.length > 0) {
          parts.push(`**Blocked Registries:** ${registrySources.blockedRegistries.join(", ")}`);
        }
      }
      parts.push("");
      parts.push(`**Verify image signatures:**`);
      parts.push(`@@SEC_FIX_CMD|oc get imagesignatures --all-namespaces 2>/dev/null || echo "No image signatures found"@@`);
      parts.push("");
      parts.push(`**Check cosign verification:**`);
      parts.push(`@@SEC_FIX_CMD|oc get clusterimagepolicies.policy.sigstore.dev 2>/dev/null || echo "No Sigstore policies found"@@`);
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Supply Chain Security`);
      parts.push(`[WARNING] Could not query supply chain data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 10: IMAGESTALE — stale/outdated image detection
  // -----------------------------------------------------------------------
  if (cmd.operation === "imagestale") {
    try {
      const pods = await ocpGet("/api/v1/pods?limit=500");
      const imageMap = {};
      (pods.items || []).forEach(p => {
        (p.spec?.containers || []).forEach(c => {
          const img = c.image || "";
          if (!imageMap[img]) imageMap[img] = { namespaces: new Set(), count: 0 };
          imageMap[img].namespaces.add(p.metadata.namespace);
          imageMap[img].count++;
        });
      });
      const tagPattern = /:([a-zA-Z0-9._-]+)$/;
      const staleIndicators = ["latest", "dev", "test", "debug", "snapshot", "nightly"];
      parts.push(`### Stale / Outdated Image Detection`);
      parts.push("");
      parts.push(`**Total Unique Images:** ${Object.keys(imageMap).length}`);
      parts.push("");
      const staleImages = Object.entries(imageMap).filter(([img]) => {
        const match = img.match(tagPattern);
        return match && staleIndicators.some(s => match[1].toLowerCase().includes(s));
      });
      const noTagImages = Object.entries(imageMap).filter(([img]) => !img.includes(":") || img.endsWith(":latest"));
      if (staleImages.length > 0 || noTagImages.length > 0) {
        parts.push(`[WARNING] **Potentially stale images:**`);
        parts.push(`| Image | Tag | Pods | Namespaces |`);
        parts.push(`| --- | --- | --- | --- |`);
        [...staleImages, ...noTagImages].slice(0, 20).forEach(([img, data]) => {
          const match = img.match(tagPattern);
          const tag = match ? match[1] : "latest (implicit)";
          const nsList = [...data.namespaces].slice(0, 3).join(", ");
          parts.push(`| \`${img.substring(0, 80)}\` | ${tag} | ${data.count} | ${nsList} |`);
        });
      } else {
        parts.push(`[OK] No obviously stale images detected. All images use versioned tags.`);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Stale Image Detection`);
      parts.push(`[WARNING] Could not query image data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 10: HARDENING — CIS benchmark / cluster hardening assessment
  // -----------------------------------------------------------------------
  if (cmd.operation === "hardening") {
    try {
      const [sccs, complianceScans, namespaces, networkPolicies] = await Promise.all([
        ocpGet("/apis/security.openshift.io/v1/securitycontextconstraints"),
        ocpGet("/apis/compliance.openshift.io/v1alpha1/compliancescans").catch(() => ({ items: [] })),
        ocpGet("/api/v1/namespaces"),
        ocpGet("/apis/networking.k8s.io/v1/networkpolicies").catch(() => ({ items: [] })),
      ]);
      const sccItems = sccs.items || [];
      const scanItems = complianceScans.items || [];
      const nsItems = (namespaces.items || []).filter(n => !n.metadata.name.startsWith("openshift-") && !n.metadata.name.startsWith("kube-") && n.metadata.name !== "default");
      const npNs = new Set((networkPolicies.items || []).map(np => np.metadata.namespace));
      const nsWithoutNP = nsItems.filter(n => !npNs.has(n.metadata.name));
      parts.push(`### Cluster Hardening Assessment`);
      parts.push("");
      parts.push(`| Check | Status | Details |`);
      parts.push(`| --- | --- | --- |`);
      const privilegedSCC = sccItems.filter(s => s.allowPrivilegedContainer);
      parts.push(`| SCCs (Total) | ${sccItems.length} | ${privilegedSCC.length} allow privileged containers |`);
      parts.push(`| Compliance Scans | ${scanItems.length > 0 ? "[OK]" : "[WARNING]"} | ${scanItems.length} scan(s) configured |`);
      parts.push(`| NetworkPolicy Coverage | ${nsWithoutNP.length === 0 ? "[OK]" : "[WARNING]"} | ${nsWithoutNP.length} user namespace(s) without NetworkPolicy |`);
      parts.push("");
      if (nsWithoutNP.length > 0) {
        parts.push(`**Namespaces without NetworkPolicy:**`);
        nsWithoutNP.slice(0, 10).forEach(n => parts.push(`  - [WARNING] \`${n.metadata.name}\``));
        parts.push("");
      }
      if (scanItems.length > 0) {
        parts.push(`**Compliance Scans:**`);
        scanItems.forEach(s => {
          const status = s.status?.phase || "Unknown";
          const icon = status === "DONE" ? "[OK]" : "[WARNING]";
          parts.push(`  - ${icon} \`${s.metadata.name}\` — ${status} (${s.spec?.profile || "?"})`);
        });
      } else {
        parts.push(`**Run CIS benchmark scan:**`);
        parts.push(`@@SEC_FIX_CMD|oc get compliancescans --all-namespaces 2>/dev/null || echo "Compliance Operator not installed — install via OperatorHub"@@`);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Cluster Hardening`);
      parts.push(`[WARNING] Could not query hardening data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 10: PODSECURITY — Pod Security Admission / Standards
  // -----------------------------------------------------------------------
  if (cmd.operation === "podsecurity") {
    try {
      const namespaces = await ocpGet("/api/v1/namespaces");
      const nsItems = (namespaces.items || []).filter(n => !n.metadata.name.startsWith("openshift-") && !n.metadata.name.startsWith("kube-") && n.metadata.name !== "default");
      parts.push(`### Pod Security Admission (PSA) Status`);
      parts.push("");
      parts.push(`| Namespace | Enforce | Audit | Warn |`);
      parts.push(`| --- | --- | --- | --- |`);
      let noLabels = 0;
      nsItems.forEach(n => {
        const labels = n.metadata.labels || {};
        const enforce = labels["pod-security.kubernetes.io/enforce"] || "—";
        const audit = labels["pod-security.kubernetes.io/audit"] || "—";
        const warn = labels["pod-security.kubernetes.io/warn"] || "—";
        if (enforce === "—" && audit === "—" && warn === "—") {
          noLabels++;
        } else {
          parts.push(`| \`${n.metadata.name}\` | ${enforce} | ${audit} | ${warn} |`);
        }
      });
      if (noLabels > 0) {
        parts.push("");
        parts.push(`[WARNING] **${noLabels} user namespace(s) have no PSA labels** — running with default (privileged) security`);
      }
      parts.push("");
      parts.push(`**Apply restricted PSA to a namespace:**`);
      parts.push(`@@SEC_FIX_CMD|oc label namespace <NAMESPACE> pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted --overwrite@@`);
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Pod Security Admission`);
      parts.push(`[WARNING] Could not query PSA data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 11: CAPACITY — capacity planning / runway / headroom
  // -----------------------------------------------------------------------
  if (cmd.operation === "capacity") {
    try {
      const [nodes, nodeMetrics, pods] = await Promise.all([
        ocpGet("/api/v1/nodes"),
        ocpGet("/apis/metrics.k8s.io/v1beta1/nodes").catch(() => ({ items: [] })),
        ocpGet("/api/v1/pods?fieldSelector=status.phase=Running&limit=1000"),
      ]);
      const nodeItems = nodes.items || [];
      const metricItems = nodeMetrics.items || [];
      let totalCpuAlloc = 0, totalMemAlloc = 0, totalCpuUsed = 0, totalMemUsed = 0;
      let totalCpuReq = 0, totalMemReq = 0;
      nodeItems.forEach(n => {
        const cpuA = parseCpuNano(n.status?.allocatable?.cpu || "0");
        const memA = parseMemBytes(n.status?.allocatable?.memory || "0");
        totalCpuAlloc += cpuA;
        totalMemAlloc += memA;
        const metric = metricItems.find(m => m.metadata.name === n.metadata.name);
        if (metric) {
          totalCpuUsed += parseCpuNano(metric.usage?.cpu || "0");
          totalMemUsed += parseMemBytes(metric.usage?.memory || "0");
        }
      });
      (pods.items || []).forEach(p => {
        (p.spec?.containers || []).forEach(c => {
          totalCpuReq += parseCpuNano(c.resources?.requests?.cpu || "0");
          totalMemReq += parseMemBytes(c.resources?.requests?.memory || "0");
        });
      });
      const cpuUsedPct = totalCpuAlloc > 0 ? ((totalCpuUsed / totalCpuAlloc) * 100).toFixed(1) : "?";
      const memUsedPct = totalMemAlloc > 0 ? ((totalMemUsed / totalMemAlloc) * 100).toFixed(1) : "?";
      const cpuReqPct = totalCpuAlloc > 0 ? ((totalCpuReq / totalCpuAlloc) * 100).toFixed(1) : "?";
      const memReqPct = totalMemAlloc > 0 ? ((totalMemReq / totalMemAlloc) * 100).toFixed(1) : "?";
      parts.push(`### Capacity Planning & Headroom Analysis`);
      parts.push("");
      parts.push(`**Cluster:** ${nodeItems.length} nodes`);
      parts.push("");
      parts.push(`| Resource | Allocatable | Requested | Used | Req % | Used % | Headroom |`);
      parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
      parts.push(`| CPU | ${fmtCpu(String(totalCpuAlloc) + "n")} | ${fmtCpu(String(totalCpuReq) + "n")} | ${fmtCpu(String(totalCpuUsed) + "n")} | ${cpuReqPct}% | ${cpuUsedPct}% | ${(100 - parseFloat(cpuReqPct)).toFixed(1)}% |`);
      parts.push(`| Memory | ${fmtMem(String(Math.round(totalMemAlloc / 1024)) + "Ki")} | ${fmtMem(String(Math.round(totalMemReq / 1024)) + "Ki")} | ${fmtMem(String(Math.round(totalMemUsed / 1024)) + "Ki")} | ${memReqPct}% | ${memUsedPct}% | ${(100 - parseFloat(memReqPct)).toFixed(1)}% |`);
      parts.push("");
      const cpuFree = parseFloat(cpuReqPct);
      const memFree = parseFloat(memReqPct);
      if (cpuFree > 80 || memFree > 80) {
        parts.push(`[CRITICAL] **Cluster is running hot!** Consider adding nodes or right-sizing workloads.`);
      } else if (cpuFree > 60 || memFree > 60) {
        parts.push(`[WARNING] **Moderate utilization** — monitor trends for capacity exhaustion.`);
      } else {
        parts.push(`[OK] **Healthy headroom** — cluster has sufficient capacity for growth.`);
      }
      parts.push("");
      parts.push(`**Pods Running:** ${(pods.items || []).length}`);
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Capacity Planning`);
      parts.push(`[WARNING] Could not gather capacity data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 11: MCPDRIFT — MachineConfigPool drift / rendering issues
  // -----------------------------------------------------------------------
  if (cmd.operation === "mcpdrift") {
    try {
      const [mcps, mcs] = await Promise.all([
        ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools"),
        ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigs").catch(() => ({ items: [] })),
      ]);
      const mcpItems = mcps.items || [];
      parts.push(`### MachineConfigPool Drift & Rendering Status`);
      parts.push("");
      parts.push(`| Pool | Ready | Updated | Degraded | Machine Count | Current Config |`);
      parts.push(`| --- | --- | --- | --- | --- | --- |`);
      mcpItems.forEach(p => {
        const conds = p.status?.conditions || [];
        const updated = conds.find(c => c.type === "Updated")?.status === "True" ? "[OK]" : "[WARNING]";
        const degraded = conds.find(c => c.type === "Degraded")?.status === "True" ? "[CRITICAL]" : "[OK]";
        const ready = conds.find(c => c.type === "RenderDegraded")?.status === "True" ? "[CRITICAL]" : "[OK]";
        const count = p.status?.machineCount || 0;
        const current = p.status?.configuration?.name || "—";
        parts.push(`| \`${p.metadata.name}\` | ${ready} | ${updated} | ${degraded} | ${count} | \`${current}\` |`);
      });
      parts.push("");
      const degradedPools = mcpItems.filter(p => (p.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
      if (degradedPools.length > 0) {
        parts.push(`[CRITICAL] **Degraded Pools:**`);
        degradedPools.forEach(p => {
          const degradedCond = (p.status?.conditions || []).find(c => c.type === "Degraded");
          parts.push(`  - \`${p.metadata.name}\`: ${degradedCond?.message || "Unknown reason"}`);
        });
      }
      parts.push("");
      parts.push(`**Total MachineConfigs:** ${(mcs.items || []).length}`);
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### MachineConfigPool Status`);
      parts.push(`[WARNING] Could not query MCP data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 12: PDB — PodDisruptionBudget analysis
  // -----------------------------------------------------------------------
  if (cmd.operation === "pdb") {
    try {
      const pdbs = await ocpGet("/apis/policy/v1/poddisruptionbudgets");
      const pdbItems = pdbs.items || [];
      parts.push(`### PodDisruptionBudget (PDB) Analysis`);
      parts.push("");
      if (pdbItems.length > 0) {
        parts.push(`| PDB | Namespace | Min Available | Max Unavailable | Current Healthy | Disruptions Allowed |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        pdbItems.forEach(p => {
          const minAvail = p.spec?.minAvailable ?? "—";
          const maxUnavail = p.spec?.maxUnavailable ?? "—";
          const healthy = p.status?.currentHealthy ?? "?";
          const allowed = p.status?.disruptionsAllowed ?? "?";
          const icon = allowed === 0 ? "[CRITICAL]" : "[OK]";
          parts.push(`| ${icon} \`${p.metadata.name}\` | ${p.metadata.namespace} | ${minAvail} | ${maxUnavail} | ${healthy} | ${allowed} |`);
        });
        const blocked = pdbItems.filter(p => p.status?.disruptionsAllowed === 0);
        if (blocked.length > 0) {
          parts.push("");
          parts.push(`[CRITICAL] **${blocked.length} PDB(s) blocking disruptions** — these will prevent node drains and upgrades`);
        }
      } else {
        parts.push(`[WARNING] No PodDisruptionBudgets found. Consider adding PDBs for critical workloads.`);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### PDB Analysis`);
      parts.push(`[WARNING] Could not query PDB data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 12: TOPOLOGY — affinity / topology spread / scheduling
  // -----------------------------------------------------------------------
  if (cmd.operation === "topology") {
    try {
      const [pods, nodes] = await Promise.all([
        ocpGet("/api/v1/pods?fieldSelector=status.phase=Running&limit=500"),
        ocpGet("/api/v1/nodes"),
      ]);
      const podItems = pods.items || [];
      const nodeItems = nodes.items || [];
      const podsWithAffinity = podItems.filter(p => p.spec?.affinity);
      const podsWithSpread = podItems.filter(p => p.spec?.topologySpreadConstraints?.length > 0);
      const nodesZones = {};
      nodeItems.forEach(n => {
        const zone = n.metadata.labels?.["topology.kubernetes.io/zone"] || n.metadata.labels?.["failure-domain.beta.kubernetes.io/zone"] || "unknown";
        nodesZones[zone] = (nodesZones[zone] || 0) + 1;
      });
      parts.push(`### Topology & Scheduling Analysis`);
      parts.push("");
      parts.push(`**Nodes:** ${nodeItems.length} | **Zones:** ${Object.keys(nodesZones).length}`);
      parts.push("");
      parts.push(`| Zone | Nodes |`);
      parts.push(`| --- | --- |`);
      Object.entries(nodesZones).forEach(([zone, count]) => {
        parts.push(`| ${zone} | ${count} |`);
      });
      parts.push("");
      parts.push(`**Scheduling Constraints:**`);
      parts.push(`  - Pods with affinity rules: ${podsWithAffinity.length}`);
      parts.push(`  - Pods with topology spread constraints: ${podsWithSpread.length}`);
      parts.push(`  - Pods without any scheduling constraints: ${podItems.length - podsWithAffinity.length - podsWithSpread.length}`);
      if (Object.keys(nodesZones).length < 2) {
        parts.push("");
        parts.push(`[WARNING] Only ${Object.keys(nodesZones).length} zone(s) detected — consider multi-zone deployment for HA`);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Topology Analysis`);
      parts.push(`[WARNING] Could not query topology data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 12: PROBES — liveness/readiness/startup probe analysis
  // -----------------------------------------------------------------------
  if (cmd.operation === "probes") {
    try {
      const pods = await ocpGet("/api/v1/pods?fieldSelector=status.phase=Running&limit=500");
      const podItems = pods.items || [];
      let noLiveness = 0, noReadiness = 0, noStartup = 0, total = 0;
      const missingProbes = [];
      podItems.forEach(p => {
        if (p.metadata.namespace?.startsWith("openshift-") || p.metadata.namespace?.startsWith("kube-")) return;
        (p.spec?.containers || []).forEach(c => {
          total++;
          const missing = [];
          if (!c.livenessProbe) { noLiveness++; missing.push("liveness"); }
          if (!c.readinessProbe) { noReadiness++; missing.push("readiness"); }
          if (!c.startupProbe) { noStartup++; missing.push("startup"); }
          if (missing.length > 0) {
            missingProbes.push({ pod: p.metadata.name, ns: p.metadata.namespace, container: c.name, missing });
          }
        });
      });
      parts.push(`### Health Probe Analysis (User Workloads)`);
      parts.push("");
      parts.push(`**Total Containers:** ${total}`);
      parts.push("");
      parts.push(`| Probe Type | Missing | Coverage |`);
      parts.push(`| --- | --- | --- |`);
      parts.push(`| Liveness | ${noLiveness > 0 ? `[WARNING] ${noLiveness}` : `[OK] 0`} | ${total > 0 ? ((1 - noLiveness / total) * 100).toFixed(0) : 0}% |`);
      parts.push(`| Readiness | ${noReadiness > 0 ? `[WARNING] ${noReadiness}` : `[OK] 0`} | ${total > 0 ? ((1 - noReadiness / total) * 100).toFixed(0) : 0}% |`);
      parts.push(`| Startup | ${noStartup} | ${total > 0 ? ((1 - noStartup / total) * 100).toFixed(0) : 0}% |`);
      if (missingProbes.length > 0) {
        parts.push("");
        parts.push(`**Containers missing probes:**`);
        missingProbes.slice(0, 15).forEach(m => {
          parts.push(`  - [WARNING] \`${m.pod}\` / \`${m.container}\` (${m.ns}) — missing: ${m.missing.join(", ")}`);
        });
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Probe Analysis`);
      parts.push(`[WARNING] Could not query probe data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 12: HPA — HorizontalPodAutoscaler status
  // -----------------------------------------------------------------------
  if (cmd.operation === "hpa") {
    try {
      const hpas = await ocpGet("/apis/autoscaling/v2/horizontalpodautoscalers").catch(() =>
        ocpGet("/apis/autoscaling/v1/horizontalpodautoscalers")
      );
      const hpaItems = hpas.items || [];
      parts.push(`### HorizontalPodAutoscaler (HPA) Status`);
      parts.push("");
      if (hpaItems.length > 0) {
        parts.push(`| HPA | Namespace | Target | Min | Max | Current | Desired |`);
        parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
        hpaItems.forEach(h => {
          const target = h.spec?.scaleTargetRef?.name || "?";
          const min = h.spec?.minReplicas ?? "?";
          const max = h.spec?.maxReplicas ?? "?";
          const current = h.status?.currentReplicas ?? "?";
          const desired = h.status?.desiredReplicas ?? "?";
          const icon = current === max ? "[WARNING]" : "[OK]";
          parts.push(`| ${icon} \`${h.metadata.name}\` | ${h.metadata.namespace} | ${target} | ${min} | ${max} | ${current} | ${desired} |`);
        });
        const maxedOut = hpaItems.filter(h => h.status?.currentReplicas >= h.spec?.maxReplicas);
        if (maxedOut.length > 0) {
          parts.push("");
          parts.push(`[WARNING] **${maxedOut.length} HPA(s) at maximum replicas** — may need higher maxReplicas or resource optimization`);
        }
      } else {
        parts.push(`[WARNING] No HPAs found. Consider adding autoscaling for variable workloads.`);
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### HPA Status`);
      parts.push(`[WARNING] Could not query HPA data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 12: ORPHANED — orphaned/dangling/unused resources
  // -----------------------------------------------------------------------
  if (cmd.operation === "orphaned") {
    try {
      const [cms, secrets, pvcs, services, pods] = await Promise.all([
        ocpGet("/api/v1/configmaps?limit=500"),
        ocpGet("/api/v1/secrets?limit=500"),
        ocpGet("/api/v1/persistentvolumeclaims"),
        ocpGet("/api/v1/services?limit=500"),
        ocpGet("/api/v1/pods?limit=500"),
      ]);
      const runningPodSpecs = (pods.items || []).map(p => JSON.stringify(p.spec || {}));
      const unusedCMs = (cms.items || []).filter(cm => {
        if (cm.metadata.namespace?.startsWith("openshift-") || cm.metadata.namespace?.startsWith("kube-")) return false;
        if (cm.metadata.name === "kube-root-ca.crt") return false;
        return !runningPodSpecs.some(spec => spec.includes(cm.metadata.name));
      });
      const unusedSecrets = (secrets.items || []).filter(s => {
        if (s.metadata.namespace?.startsWith("openshift-") || s.metadata.namespace?.startsWith("kube-")) return false;
        if (s.type === "kubernetes.io/service-account-token") return false;
        return !runningPodSpecs.some(spec => spec.includes(s.metadata.name));
      });
      const unboundPVCs = (pvcs.items || []).filter(p => p.status?.phase !== "Bound");
      const noEndpointSvcs = (services.items || []).filter(svc => {
        if (svc.metadata.namespace?.startsWith("openshift-") || svc.metadata.namespace?.startsWith("kube-")) return false;
        if (svc.spec?.type === "ExternalName") return false;
        return !svc.spec?.selector || Object.keys(svc.spec.selector).length === 0;
      });
      parts.push(`### Orphaned / Unused Resource Detection`);
      parts.push("");
      parts.push(`| Resource Type | Potentially Unused | Status |`);
      parts.push(`| --- | --- | --- |`);
      parts.push(`| ConfigMaps (unreferenced) | ${unusedCMs.length} | ${unusedCMs.length > 10 ? "[WARNING]" : "[OK]"} |`);
      parts.push(`| Secrets (unreferenced) | ${unusedSecrets.length} | ${unusedSecrets.length > 10 ? "[WARNING]" : "[OK]"} |`);
      parts.push(`| PVCs (unbound) | ${unboundPVCs.length} | ${unboundPVCs.length > 0 ? "[WARNING]" : "[OK]"} |`);
      parts.push(`| Services (no selector) | ${noEndpointSvcs.length} | ${noEndpointSvcs.length > 0 ? "[WARNING]" : "[OK]"} |`);
      if (unboundPVCs.length > 0) {
        parts.push("");
        parts.push(`**Unbound PVCs:**`);
        unboundPVCs.slice(0, 10).forEach(p => parts.push(`  - [WARNING] \`${p.metadata.name}\` (${p.metadata.namespace}) — ${p.status?.phase}`));
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Orphaned Resources`);
      parts.push(`[WARNING] Could not detect orphaned resources: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // Tier 12: GOVERNANCE — tenant governance / resource quotas / limit ranges
  // -----------------------------------------------------------------------
  if (cmd.operation === "governance") {
    try {
      const [quotas, limitRanges, namespaces] = await Promise.all([
        ocpGet("/api/v1/resourcequotas"),
        ocpGet("/api/v1/limitranges"),
        ocpGet("/api/v1/namespaces"),
      ]);
      const quotaItems = quotas.items || [];
      const lrItems = limitRanges.items || [];
      const nsItems = (namespaces.items || []).filter(n => !n.metadata.name.startsWith("openshift-") && !n.metadata.name.startsWith("kube-") && n.metadata.name !== "default");
      const nsWithQuota = new Set(quotaItems.map(q => q.metadata.namespace));
      const nsWithLR = new Set(lrItems.map(l => l.metadata.namespace));
      const nsWithoutQuota = nsItems.filter(n => !nsWithQuota.has(n.metadata.name));
      parts.push(`### Tenant Governance & Resource Quotas`);
      parts.push("");
      parts.push(`**User Namespaces:** ${nsItems.length} | **With Quotas:** ${nsWithQuota.size} | **With LimitRanges:** ${nsWithLR.size}`);
      parts.push("");
      parts.push(`| Check | Status | Details |`);
      parts.push(`| --- | --- | --- |`);
      parts.push(`| ResourceQuota Coverage | ${nsWithoutQuota.length === 0 ? "[OK]" : "[WARNING]"} | ${nsWithoutQuota.length} namespace(s) without quota |`);
      parts.push(`| LimitRange Coverage | ${nsItems.length - nsWithLR.size === 0 ? "[OK]" : "[WARNING]"} | ${nsItems.length - nsWithLR.size} namespace(s) without LimitRange |`);
      if (quotaItems.length > 0) {
        parts.push("");
        parts.push(`**ResourceQuotas:**`);
        parts.push(`| Namespace | Quota | CPU Limit | Memory Limit | Used CPU | Used Memory |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        quotaItems.slice(0, 15).forEach(q => {
          const hard = q.status?.hard || {};
          const used = q.status?.used || {};
          parts.push(`| ${q.metadata.namespace} | \`${q.metadata.name}\` | ${hard["limits.cpu"] || "—"} | ${hard["limits.memory"] || "—"} | ${used["limits.cpu"] || "—"} | ${used["limits.memory"] || "—"} |`);
        });
      }
      if (nsWithoutQuota.length > 0) {
        parts.push("");
        parts.push(`**Namespaces without ResourceQuota:**`);
        nsWithoutQuota.slice(0, 10).forEach(n => parts.push(`  - [WARNING] \`${n.metadata.name}\``));
      }
      return parts.join("\n");
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Governance`);
      parts.push(`[WARNING] Could not query governance data: ${e.message}`);
      return parts.join("\n");
    }
  }

  // -----------------------------------------------------------------------
  // DIAGNOSE — cluster-level and node-level troubleshooting
  // Skip when user asks about a specific pod or deployment — those are better
  // handled by gatherClusterContext + LLM (or builtInAnalysis) which fetches
  // pod details, events, logs, and metrics for the named resource.
  // -----------------------------------------------------------------------
  if (cmd.operation === "diagnose") {
    const diagLower = (cmd.raw || message || "").toLowerCase();

    // Detect if user is asking about a specific pod or deployment
    const hasPodName = cmd.resourceName && (cmd.resourceType === "pod" || !cmd.resourceType);
    const podPatternMatch = diagLower.match(/\b([a-z][-a-z0-9]*(?:-[a-z0-9]{4,10}){1,2})\b/);
    const hasSpecificPod = hasPodName || (cmd.resourceType === "pod" && cmd.resourceName) || podPatternMatch;
    const hasSpecificDeployment = cmd.resourceType === "deployment" && cmd.resourceName;

    // If query targets a specific pod or deployment, let gatherClusterContext
    // handle it — return null so the LLM/built-in path can do pod-specific diagnosis.
    if (hasSpecificPod || hasSpecificDeployment) {
      return null;
    }

    const isNodeFocused = cmd.resourceType === "node" || /\bnode\b|\bnodes\b|\bworker\b|\bmaster\b|\bcontrol.?plane\b/.test(diagLower);
    const isClusterFocused = !isNodeFocused || /\bcluster\b/.test(diagLower);

    try {
      if (isNodeFocused) {
        // --- Node-level troubleshooting ---
        const [nodesData, nodeMetrics, eventsData] = await Promise.all([
          ocpGet("/api/v1/nodes"),
          ocpGet("/apis/metrics.k8s.io/v1beta1/nodes").catch(() => ({ items: [] })),
          ocpGet("/api/v1/events?fieldSelector=involvedObject.kind=Node,type=Warning&limit=50").catch(() => ({ items: [] })),
        ]);
        const nodeItems = nodesData.items || [];
        const metricItems = nodeMetrics.items || [];
        const metricMap = {};
        metricItems.forEach(m => { metricMap[m.metadata.name] = m; });

        // If user specified a node name, focus on it
        const targetNode = cmd.resourceName ? nodeItems.find(n => n.metadata.name.includes(cmd.resourceName)) : null;

        parts.push(`### Node Troubleshooting Report`);
        parts.push("");
        parts.push(`| Node | Status | Role | CPU Used | CPU Capacity | Memory Used | Memory Capacity | Conditions |`);
        parts.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);

        const displayNodes = targetNode ? [targetNode] : nodeItems;
        displayNodes.forEach(n => {
          const name = n.metadata.name;
          const conditions = n.status?.conditions || [];
          const ready = conditions.find(c => c.type === "Ready");
          const status = ready?.status === "True" ? "[OK]" : "[CRITICAL]";
          const roles = Object.keys(n.metadata.labels || {}).filter(l => l.startsWith("node-role.kubernetes.io/")).map(l => l.split("/")[1]).join(", ") || "worker";
          const cpuCap = n.status?.capacity?.cpu || "—";
          const memCap = n.status?.capacity?.memory || "—";
          const metric = metricMap[name];
          const cpuUsed = metric ? fmtCpu(metric.usage?.cpu) : "—";
          const memUsed = metric ? fmtMem(metric.usage?.memory) : "—";
          const problemConditions = conditions.filter(c => c.type !== "Ready" && c.status === "True").map(c => c.type);
          const condStr = problemConditions.length > 0 ? problemConditions.join(", ") : "healthy";
          parts.push(`| \`${name}\` | ${status} | ${roles} | ${cpuUsed} | ${cpuCap} | ${memUsed} | ${memCap} | ${condStr} |`);
        });

        // Problem nodes detail
        const problemNodes = nodeItems.filter(n => {
          const conds = n.status?.conditions || [];
          return !conds.find(c => c.type === "Ready" && c.status === "True") ||
            conds.some(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True");
        });
        if (problemNodes.length > 0) {
          parts.push("");
          parts.push(`**Problem Nodes (${problemNodes.length}):**`);
          problemNodes.forEach(n => {
            const conds = n.status?.conditions || [];
            const readyCond = conds.find(c => c.type === "Ready");
            const issues = [];
            if (readyCond?.status !== "True") issues.push(`NotReady: ${readyCond?.message || "unknown"}`);
            conds.filter(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True").forEach(c => issues.push(`${c.type}: ${c.message || ""}`));
            parts.push(`  ⛔ **\`${n.metadata.name}\`**`);
            issues.forEach(i => parts.push(`    - ${i.slice(0, 150)}`));
          });
        }

        // Node events
        const nodeEvents = eventsData.items || [];
        if (nodeEvents.length > 0) {
          parts.push("");
          parts.push(`**Recent Node Warning Events:**`);
          const shown = targetNode ? nodeEvents.filter(e => (e.involvedObject?.name || "") === targetNode.metadata.name).slice(0, 10) : nodeEvents.slice(0, 10);
          shown.forEach(e => {
            parts.push(`  - **${e.reason}** on \`${e.involvedObject?.name || "?"}\`: ${(e.message || "").slice(0, 120)} (×${e.count || 1})`);
          });
        }

        // Troubleshoot commands
        parts.push("");
        parts.push("**Investigate further:**");
        parts.push(`@@SEC_FIX_CMD|oc get nodes -o wide@@`);
        parts.push(`@@SEC_FIX_CMD|oc adm top nodes@@`);
        if (targetNode) {
          parts.push(`@@SEC_FIX_CMD|oc describe node ${targetNode.metadata.name}@@`);
          parts.push(`@@SEC_FIX_CMD|oc adm top node ${targetNode.metadata.name}@@`);
          parts.push(`@@SEC_FIX_CMD|oc get pods --all-namespaces --field-selector=spec.nodeName=${targetNode.metadata.name}@@`);
        } else if (problemNodes.length > 0) {
          parts.push(`@@SEC_FIX_CMD|oc describe node ${problemNodes[0].metadata.name}@@`);
          parts.push(`@@SEC_FIX_CMD|oc get events --field-selector involvedObject.kind=Node --sort-by=.lastTimestamp@@`);
        }
        return parts.join("\n");
      }

      if (isClusterFocused) {
        // --- Cluster-level troubleshooting ---
        const [nodesData, clvData, opsData, eventsData, podsData, mcsData, pvcsData] = await Promise.all([
          ocpGet("/api/v1/nodes"),
          ocpGet("/apis/config.openshift.io/v1/clusterversions/version").catch(() => null),
          ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => ({ items: [] })),
          ocpGet("/api/v1/events?fieldSelector=type=Warning&limit=80").catch(() => ({ items: [] })),
          ocpGet("/api/v1/pods?fieldSelector=status.phase!=Running,status.phase!=Succeeded&limit=100").catch(() => ({ items: [] })),
          ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools").catch(() => ({ items: [] })),
          ocpGet("/api/v1/persistentvolumeclaims").catch(() => ({ items: [] })),
        ]);

        parts.push(`### Cluster Troubleshooting Report`);
        parts.push("");

        // Cluster version & upgrade status
        if (clvData) {
          const ver = clvData.status?.desired?.version || "unknown";
          const channel = clvData.spec?.channel || "unknown";
          const conditions = clvData.status?.conditions || [];
          const progressing = conditions.find(c => c.type === "Progressing");
          const degraded = conditions.find(c => c.type === "Degraded");
          const avail = conditions.find(c => c.type === "Available");
          parts.push(`**Cluster Version:** ${ver} | Channel: ${channel}`);
          parts.push(`  - Available: ${avail?.status === "True" ? "[OK]" : "[WARNING] " + (avail?.message || "").slice(0, 100)}`);
          if (degraded?.status === "True") parts.push(`  - ⛔ Degraded: ${(degraded.message || "").slice(0, 120)}`);
          if (progressing?.status === "True") parts.push(`  - ⚠ Upgrading: ${(progressing.message || "").slice(0, 120)}`);
          parts.push("");
        }

        // Nodes summary
        const nodeItems = nodesData.items || [];
        const notReady = nodeItems.filter(n => !(n.status?.conditions || []).find(c => c.type === "Ready" && c.status === "True"));
        const pressure = nodeItems.filter(n => (n.status?.conditions || []).some(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True"));
        parts.push(`**Nodes:** ${nodeItems.length} total | ${nodeItems.length - notReady.length} ready | ${notReady.length} not-ready | ${pressure.length} under pressure`);
        notReady.forEach(n => parts.push(`  ⛔ \`${n.metadata.name}\` — NotReady`));
        pressure.forEach(n => {
          const pTypes = (n.status?.conditions || []).filter(c => ["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True").map(c => c.type);
          parts.push(`  ⚠ \`${n.metadata.name}\` — ${pTypes.join(", ")}`);
        });
        parts.push("");

        // Operators
        const opItems = opsData.items || [];
        const degradedOps = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
        const unavailOps = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Available" && c.status === "False"));
        const progressOps = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Progressing" && c.status === "True"));
        parts.push(`**Cluster Operators:** ${opItems.length} total | ${degradedOps.length} degraded | ${unavailOps.length} unavailable | ${progressOps.length} progressing`);
        degradedOps.forEach(o => {
          const msg = (o.status?.conditions || []).find(c => c.type === "Degraded")?.message || "";
          parts.push(`  ⛔ \`${o.metadata.name}\` — Degraded: ${msg.slice(0, 120)}`);
        });
        unavailOps.filter(o => !degradedOps.find(d => d.metadata.name === o.metadata.name)).forEach(o => {
          parts.push(`  ⚠ \`${o.metadata.name}\` — Unavailable`);
        });
        parts.push("");

        // Problem pods grouped by issue
        const podItems = (podsData.items || []).filter(p => p.status?.phase !== "Succeeded");
        const crashPods = podItems.filter(p => (p.status?.containerStatuses || []).some(c => c.state?.waiting?.reason === "CrashLoopBackOff"));
        const oomPods = podItems.filter(p => (p.status?.containerStatuses || []).some(c => c.lastState?.terminated?.reason === "OOMKilled"));
        const imgPods = podItems.filter(p => (p.status?.containerStatuses || []).some(c => c.state?.waiting?.reason === "ImagePullBackOff" || c.state?.waiting?.reason === "ErrImagePull"));
        const pendingPods = podItems.filter(p => p.status?.phase === "Pending");
        parts.push(`**Problem Pods:** ${podItems.length} non-running`);
        parts.push(`| Issue | Count | Top Affected |`);
        parts.push(`| --- | --- | --- |`);
        if (crashPods.length) parts.push(`| ⛔ CrashLoopBackOff | ${crashPods.length} | ${crashPods.slice(0, 3).map(p => `\`${p.metadata.namespace}/${p.metadata.name}\``).join(", ")} |`);
        if (oomPods.length) parts.push(`| ⛔ OOMKilled | ${oomPods.length} | ${oomPods.slice(0, 3).map(p => `\`${p.metadata.namespace}/${p.metadata.name}\``).join(", ")} |`);
        if (imgPods.length) parts.push(`| ⚠ ImagePullBackOff | ${imgPods.length} | ${imgPods.slice(0, 3).map(p => `\`${p.metadata.namespace}/${p.metadata.name}\``).join(", ")} |`);
        if (pendingPods.length) parts.push(`| ⚠ Pending | ${pendingPods.length} | ${pendingPods.slice(0, 3).map(p => `\`${p.metadata.namespace}/${p.metadata.name}\``).join(", ")} |`);
        parts.push("");

        // PVC issues
        const pvcItems = pvcsData.items || [];
        const pendingPvcs = pvcItems.filter(p => p.status?.phase === "Pending");
        const lostPvcs = pvcItems.filter(p => p.status?.phase === "Lost");
        if (pendingPvcs.length > 0 || lostPvcs.length > 0) {
          parts.push(`**Storage Issues:**`);
          if (pendingPvcs.length) parts.push(`  ⚠ ${pendingPvcs.length} PVC(s) Pending: ${pendingPvcs.slice(0, 3).map(p => `\`${p.metadata.namespace}/${p.metadata.name}\``).join(", ")}`);
          if (lostPvcs.length) parts.push(`  ⛔ ${lostPvcs.length} PVC(s) Lost: ${lostPvcs.slice(0, 3).map(p => `\`${p.metadata.namespace}/${p.metadata.name}\``).join(", ")}`);
          parts.push("");
        }

        // MachineConfigPool
        const mcpItems = mcsData.items || [];
        const degradedMcps = mcpItems.filter(m => (m.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
        if (mcpItems.length > 0) {
          parts.push(`**MachineConfigPools:** ${mcpItems.length}`);
          degradedMcps.forEach(m => parts.push(`  ⛔ \`${m.metadata.name}\` — Degraded`));
          if (degradedMcps.length === 0) parts.push(`  All pools healthy`);
          parts.push("");
        }

        // Event storm detection
        const evtItems = eventsData.items || [];
        const evtReasons = {};
        evtItems.forEach(e => { evtReasons[e.reason] = (evtReasons[e.reason] || 0) + (e.count || 1); });
        const topReasons = Object.entries(evtReasons).sort((a, b) => b[1] - a[1]).slice(0, 10);
        parts.push(`**Warning Event Summary:** ${evtItems.length} events`);
        parts.push(`| Reason | Count |`);
        parts.push(`| --- | --- |`);
        topReasons.forEach(([reason, count]) => parts.push(`| ${reason} | ${count} |`));
        parts.push("");

        // Troubleshoot commands
        parts.push("**Investigate further:**");
        parts.push(`@@SEC_FIX_CMD|oc get clusterversion@@`);
        parts.push(`@@SEC_FIX_CMD|oc get clusteroperators@@`);
        parts.push(`@@SEC_FIX_CMD|oc get nodes -o wide@@`);
        parts.push(`@@SEC_FIX_CMD|oc get events --all-namespaces --sort-by=.lastTimestamp@@`);
        if (degradedOps.length > 0) {
          parts.push(`@@SEC_FIX_CMD|oc describe clusteroperator ${degradedOps[0].metadata.name}@@`);
        }
        if (notReady.length > 0) {
          parts.push(`@@SEC_FIX_CMD|oc describe node ${notReady[0].metadata.name}@@`);
        }
        if (crashPods.length > 0) {
          parts.push(`@@SEC_FIX_CMD|oc logs ${crashPods[0].metadata.name} -n ${crashPods[0].metadata.namespace} --tail=50@@`);
          parts.push(`@@SEC_FIX_CMD|oc describe pod ${crashPods[0].metadata.name} -n ${crashPods[0].metadata.namespace}@@`);
        }
        return parts.join("\n");
      }
    } catch (e) {
      if (llmAvailable) return null;
      parts.push(`### Troubleshooting Report`);
      parts.push(`[WARNING] Could not gather diagnostics: ${e.message}`);
      return parts.join("\n");
    }
  }

  return null; // Not a recognized direct command
}

// ---------------------------------------------------------------------------
// View-more pagination — returns the next page of a resource listing
// ---------------------------------------------------------------------------
function formatResourceRows(resourceType, items) {
  const parts = [];
  if (resourceType === "podmetrics") {
    parts.push(`| Pod | Namespace | CPU | Memory | Containers |`);
    parts.push(`| --- | --- | --- | --- | --- |`);
    const podMetrics = items.map((p) => {
      const containers = (p.containers || []).map((c) => ({
        name: c.name,
        cpuRaw: parseCpuNano(c.usage?.cpu),
        memRaw: parseMemBytes(c.usage?.memory),
      }));
      const totalCpu = containers.reduce((s, c) => s + c.cpuRaw, 0);
      const totalMem = containers.reduce((s, c) => s + c.memRaw, 0);
      return { pod: p, containers, totalCpu, totalMem, totalCpuFmt: fmtCpu(String(totalCpu) + "n"), totalMemFmt: fmtMem(String(Math.round(totalMem / 1024)) + "Ki") };
    });
    podMetrics.sort((a, b) => b.totalCpu - a.totalCpu);
    podMetrics.forEach(({ pod: p, containers, totalCpuFmt, totalMemFmt }) => {
      const cCount = containers.length;
      const cDetail = cCount > 1 ? `${cCount} containers` : containers[0]?.name || "1";
      parts.push(`| \`${p.metadata.name}\` | ${p.metadata.namespace} | ${totalCpuFmt} | ${totalMemFmt} | ${cDetail} |`);
    });
  } else if (resourceType === "event" || resourceType === "events") {
    parts.push(`| Type | Reason | Resource | Namespace | Message | Count | Last Seen |`);
    parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
    items.forEach((e) => {
      const icon = e.type === "Warning" ? "[WARNING]" : "[OK]";
      const age = e.lastTimestamp ? new Date(e.lastTimestamp).toLocaleString() : "—";
      const msg = (e.message || "").substring(0, 80).replace(/\|/g, "/");
      parts.push(`| ${icon} | **${e.reason}** | ${e.involvedObject?.kind || "?"}/${e.involvedObject?.name || "?"} | ${e.metadata?.namespace || "—"} | ${msg} | ${e.count > 1 ? `x${e.count}` : "1"} | ${age} |`);
    });
  } else if (resourceType === "pod" || resourceType === "pods") {
    parts.push(`| Status | Pod | Namespace | Phase | Restarts |`);
    parts.push(`| --- | --- | --- | --- | --- |`);
    items.forEach((p) => {
      const phase = p.status?.phase || "Unknown";
      const restarts = (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
      const icon = phase === "Running" ? "[OK]" : phase === "Succeeded" ? "[OK]" : "[CRITICAL]";
      parts.push(`| ${icon} | \`${p.metadata.name}\` | ${p.metadata.namespace} | ${phase} | ${restarts} |`);
    });
  } else if (["deployment", "deployments", "deploy"].includes(resourceType)) {
    parts.push(`| Status | Deployment | Namespace | Ready |`);
    parts.push(`| --- | --- | --- | --- |`);
    items.forEach((d) => {
      const ready = d.status?.readyReplicas ?? 0;
      const desired = d.spec?.replicas ?? 0;
      const icon = ready === desired ? "[OK]" : "[CRITICAL]";
      parts.push(`| ${icon} | **${d.metadata.name}** | ${d.metadata.namespace} | ${ready}/${desired} |`);
    });
  } else if (["service", "services", "svc"].includes(resourceType)) {
    parts.push(`| Service | Namespace | Type | Cluster IP | Ports |`);
    parts.push(`| --- | --- | --- | --- | --- |`);
    items.forEach((s) => {
      const ports = (s.spec?.ports || []).map((p) => `${p.port}/${p.protocol}`).join(", ");
      parts.push(`| **${s.metadata.name}** | ${s.metadata.namespace} | ${s.spec?.type} | ${s.spec?.clusterIP} | ${ports} |`);
    });
  } else if (["route", "routes"].includes(resourceType)) {
    parts.push(`| Route | Namespace | Host | Target |`);
    parts.push(`| --- | --- | --- | --- |`);
    items.forEach((r) => {
      parts.push(`| **${r.metadata.name}** | ${r.metadata.namespace} | ${r.spec?.host || "?"} | ${r.spec?.to?.name || "?"} |`);
    });
  } else if (["configmap", "configmaps", "cm"].includes(resourceType)) {
    parts.push(`| ConfigMap | Namespace | Keys |`);
    parts.push(`| --- | --- | --- |`);
    items.forEach((c) => {
      const keys = Object.keys(c.data || {}).length;
      parts.push(`| **${c.metadata.name}** | ${c.metadata.namespace} | ${keys} |`);
    });
  } else if (["secret", "secrets"].includes(resourceType)) {
    parts.push(`| Secret | Namespace | Type | Keys |`);
    parts.push(`| --- | --- | --- | --- |`);
    items.forEach((s) => {
      const keys = Object.keys(s.data || {}).length;
      parts.push(`| **${s.metadata.name}** | ${s.metadata.namespace} | ${s.type} | ${keys} |`);
    });
  } else if (["pvc", "pvcs", "persistentvolumeclaim"].includes(resourceType)) {
    parts.push(`| Status | PVC | Namespace | Phase | Storage | Class |`);
    parts.push(`| --- | --- | --- | --- | --- | --- |`);
    items.forEach((p) => {
      const icon = p.status?.phase === "Bound" ? "[OK]" : "[WARNING]";
      parts.push(`| ${icon} | **${p.metadata.name}** | ${p.metadata.namespace} | ${p.status?.phase} | ${p.spec?.resources?.requests?.storage || "?"} | ${p.spec?.storageClassName || "default"} |`);
    });
  } else if (["virtualmachine", "vm", "vms", "virtualmachines"].includes(resourceType)) {
    parts.push(`| Status | VM | Namespace | State | CPU | Memory |`);
    parts.push(`| --- | --- | --- | --- | --- | --- |`);
    items.forEach((v) => {
      const ready = v.status?.ready;
      const printable = v.status?.printableStatus || (ready ? "Running" : "Stopped");
      const icon = ready ? "[OK]" : "[WARNING]";
      const cpu = v.spec?.template?.spec?.domain?.cpu?.cores || "?";
      const mem = v.spec?.template?.spec?.domain?.resources?.requests?.memory || "?";
      parts.push(`| ${icon} | **${v.metadata.name}** | ${v.metadata.namespace} | ${printable} | ${cpu} | ${mem} |`);
    });
  } else if (["virtualmachineinstance", "vmi", "vmis"].includes(resourceType)) {
    parts.push(`| Status | VMI | Namespace | Phase | Node | IP |`);
    parts.push(`| --- | --- | --- | --- | --- | --- |`);
    items.forEach((v) => {
      const phase = v.status?.phase || "Unknown";
      const icon = phase === "Running" ? "[OK]" : "[WARNING]";
      const node = v.status?.nodeName || "unassigned";
      const ip = (v.status?.interfaces || [])[0]?.ipAddress || "none";
      parts.push(`| ${icon} | **${v.metadata.name}** | ${v.metadata.namespace} | ${phase} | ${node} | ${ip} |`);
    });
  } else if (["pipeline", "pipelines"].includes(resourceType)) {
    parts.push(`| Pipeline | Namespace | Tasks |`);
    parts.push(`| --- | --- | --- |`);
    items.forEach((p) => {
      const taskCount = p.spec?.tasks?.length || 0;
      parts.push(`| **${p.metadata.name}** | ${p.metadata.namespace} | ${taskCount} |`);
    });
  } else if (["pipelinerun", "pipelineruns"].includes(resourceType)) {
    parts.push(`| Status | PipelineRun | Namespace | Result | Pipeline | Started |`);
    parts.push(`| --- | --- | --- | --- | --- | --- |`);
    items.forEach((p) => {
      const succeeded = (p.status?.conditions || []).find(c => c.type === "Succeeded");
      const status = succeeded ? (succeeded.status === "True" ? "Succeeded" : succeeded.status === "False" ? "Failed" : "Running") : "Pending";
      const icon = status === "Succeeded" ? "[OK]" : status === "Failed" ? "[CRITICAL]" : "[WARNING]";
      const pipeline = p.spec?.pipelineRef?.name || "inline";
      const start = p.status?.startTime ? new Date(p.status.startTime).toLocaleString() : "?";
      parts.push(`| ${icon} | **${p.metadata.name}** | ${p.metadata.namespace} | ${status} | ${pipeline} | ${start} |`);
    });
  } else if (["task", "tasks"].includes(resourceType)) {
    parts.push(`| Task | Namespace | Steps |`);
    parts.push(`| --- | --- | --- |`);
    items.forEach((t) => {
      const stepCount = t.spec?.steps?.length || 0;
      parts.push(`| **${t.metadata.name}** | ${t.metadata.namespace} | ${stepCount} |`);
    });
  } else if (["taskrun", "taskruns"].includes(resourceType)) {
    parts.push(`| Status | TaskRun | Namespace | Result | Task |`);
    parts.push(`| --- | --- | --- | --- | --- |`);
    items.forEach((t) => {
      const succeeded = (t.status?.conditions || []).find(c => c.type === "Succeeded");
      const status = succeeded ? (succeeded.status === "True" ? "Succeeded" : succeeded.status === "False" ? "Failed" : "Running") : "Pending";
      const icon = status === "Succeeded" ? "[OK]" : status === "Failed" ? "[CRITICAL]" : "[WARNING]";
      const taskName = t.spec?.taskRef?.name || "inline";
      parts.push(`| ${icon} | **${t.metadata.name}** | ${t.metadata.namespace} | ${status} | ${taskName} |`);
    });
  } else if (["machine", "machines"].includes(resourceType)) {
    parts.push(`| Status | Machine | Namespace | Phase | Node | Type |`);
    parts.push(`| --- | --- | --- | --- | --- | --- |`);
    items.forEach((m) => {
      const phase = m.status?.phase || "Unknown";
      const icon = phase === "Running" ? "[OK]" : "[WARNING]";
      const nodeRef = m.status?.nodeRef?.name || "unassigned";
      const instanceType = m.spec?.providerSpec?.value?.instanceType || m.spec?.providerSpec?.value?.vmSize || "?";
      parts.push(`| ${icon} | **${m.metadata.name}** | ${m.metadata.namespace} | ${phase} | ${nodeRef} | ${instanceType} |`);
    });
  } else if (["machineset", "machinesets"].includes(resourceType)) {
    parts.push(`| Status | MachineSet | Namespace | Ready |`);
    parts.push(`| --- | --- | --- | --- |`);
    items.forEach((ms) => {
      const desired = ms.spec?.replicas ?? 0;
      const ready = ms.status?.readyReplicas ?? 0;
      const icon = ready === desired ? "[OK]" : "[WARNING]";
      parts.push(`| ${icon} | **${ms.metadata.name}** | ${ms.metadata.namespace} | ${ready}/${desired} |`);
    });
  } else {
    parts.push(`| Name | Namespace |`);
    parts.push(`| --- | --- |`);
    items.forEach((item) => {
      const ns = item.metadata?.namespace || "—";
      parts.push(`| **${item.metadata?.name}** | ${ns} |`);
    });
  }
  return parts;
}

async function handleViewMore(resourceType, namespace, offset, limit) {
  const isPodMetrics = resourceType === "podmetrics";
  const lookupType = isPodMetrics ? "pod" : resourceType;
  const resInfo = RESOURCE_MAP[lookupType];
  if (!resInfo) return `### Error\n[WARNING] Unknown resource type: \`${resourceType}\``;

  try {
    const ns = namespace === "_all" ? null : namespace;
    let data, allItems;
    if (isPodMetrics) {
      const metricsPath = ns
        ? `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods`
        : `/apis/metrics.k8s.io/v1beta1/pods`;
      data = await ocpGet(metricsPath);
      allItems = data.items || [];
    } else {
      const path = (resInfo.namespaced && ns)
        ? `${resInfo.api}/namespaces/${ns}/${resInfo.resource}`
        : `${resInfo.api}/${resInfo.resource}`;
      data = await ocpGet(path);
      allItems = data.items || [];
    }
    if (resourceType === "event" || resourceType === "events") {
      allItems.sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));
    }
    const total = allItems.length;

    if (offset >= total) {
      return `### ${resInfo.resource}\nNo more items to show (${total} total).`;
    }

    const pageItems = allItems.slice(offset, offset + limit);
    const end = Math.min(offset + limit, total);
    const label = ns ? `in \`${ns}\`` : "(all namespaces)";
    const parts = [`### ${resInfo.resource} ${label} — showing ${offset + 1}–${end} of ${total}`];

    parts.push(...formatResourceRows(resourceType, pageItems));

    const remaining = total - end;
    if (remaining > 0) {
      parts.push(`\n@@VIEW_MORE|${resourceType}|${namespace}|${end}|${total}@@`);
    }

    return parts.join("\n");
  } catch (err) {
    return `### ${resInfo.resource}\n${formatApiError(err, resInfo.resource)}`;
  }
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
  // Exception: cluster-scoped resources (nodes, PVs) are handled directly
  // because the built-in handler returns accurate live data while the LLM
  // may hallucinate status fields it can't observe.
  if (llmAvailable && cmd.operation === "get" && cmd.resourceName) {
    const ri = RESOURCE_MAP[cmd.resourceType];
    if (!ri || ri.namespaced) return null;
  }
  // Issue/health questions go through the intent-driven analysis path
  // (gatherClusterContext) — but only when there's no explicit list verb,
  // so "list crashloopbackoff pods" still returns a focused list.
  if (cmd.filter && !["list", "get"].includes(cmd.operation)) return null;
  // Diagnostic / analytical questions should go to the LLM, not be
  // handled as a simple resource listing.
  if (lower.match(/\bwhy\b|\bhealth\b|\bdiagnos|\bwhat.*wrong\b|\boverview\b|\btroubleshoot|\banalyz|\banalyse|\binvestigat|\bdebug|\breason|\bcause|\bexplain\b|\bpending\s+state|\broot\s+cause/)) return null;

  const resInfo = RESOURCE_MAP[cmd.resourceType];
  if (!resInfo) return null;

  // Validate namespace exists before querying — prevents misleading
  // "0 results" when the user misspells or uses a non-existent namespace.
  if (cmd.namespace && resInfo.namespaced) {
    try {
      await ocpGet(`/api/v1/namespaces/${cmd.namespace}`);
    } catch (nsErr) {
      const status = nsErr?.statusCode || nsErr?.status || 0;
      if (status === 404 || (nsErr.message && nsErr.message.includes("not found"))) {
        const parts = [`### Namespace Not Found`];
        parts.push(`[WARNING] Namespace \`${cmd.namespace}\` does not exist on this cluster.`);
        parts.push("");
        try {
          const allNs = await ocpGet("/api/v1/namespaces");
          const nsNames = (allNs.items || []).map(n => n.metadata.name).sort();
          const similar = nsNames.filter(n => n.includes(cmd.namespace.replace(/s$/, "")) || cmd.namespace.includes(n.replace(/-/g, "")));
          if (similar.length > 0 && similar.length <= 5) {
            parts.push(`**Did you mean:** ${similar.map(n => `\`${n}\``).join(", ")}?`);
            parts.push("");
          }
          parts.push(`**Available namespaces (${nsNames.length}):** ${nsNames.slice(0, 20).map(n => `\`${n}\``).join(", ")}${nsNames.length > 20 ? "…" : ""}`);
        } catch (_) {
          parts.push(`Verify namespace name and try again.`);
        }
        return parts.join("\n");
      }
    }
  }

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
      return `### Projects\n${formatApiError(err, "projects")}`;
    }
  }

  // Special handling for events — show with severity
  if (cmd.resourceType === "event") {
    try {
      const path = cmd.namespace
        ? `/api/v1/namespaces/${cmd.namespace}/events`
        : "/api/v1/events";
      const data = await ocpGet(path);
      const allEvents = (data.items || [])
        .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));
      const items = allEvents.slice(0, 25);
      const label = cmd.namespace ? `in \`${cmd.namespace}\`` : "(all namespaces)";
      const parts = [`### Events ${label} (showing ${items.length} of ${allEvents.length})`];
      parts.push(`| Type | Reason | Resource | Namespace | Message | Count | Last Seen |`);
      parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
      items.forEach((e) => {
        const icon = e.type === "Warning" ? "[WARNING]" : "[OK]";
        const age = e.lastTimestamp ? new Date(e.lastTimestamp).toLocaleString() : "—";
        const msg = (e.message || "").substring(0, 80).replace(/\|/g, "/");
        parts.push(`| ${icon} | **${e.reason}** | ${e.involvedObject.kind}/${e.involvedObject.name} | ${e.metadata.namespace} | ${msg} | ${e.count > 1 ? `x${e.count}` : "1"} | ${age} |`);
      });
      if (allEvents.length > 25) {
        parts.push(`\n@@VIEW_MORE|event|${cmd.namespace || '_all'}|25|${allEvents.length}@@`);
      }
      return parts.join("\n");
    } catch (err) {
      return `### Events\n${formatApiError(err, "events")}`;
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

    // Advanced filter: missingFeature — "pods without limits", "pods without probes"
    const adv = cmd.advFilters || {};
    let advFilterLabel = "";
    if (adv.missingFeature && (cmd.resourceType === "pod" || cmd.resourceType === "pods")) {
      const feat = adv.missingFeature;
      if (feat === "limits") {
        items = items.filter(p => {
          const containers = p.spec?.containers || [];
          return containers.some(c => !c.resources?.limits || (!c.resources.limits.cpu && !c.resources.limits.memory));
        });
        advFilterLabel = " **without resource limits**";
      } else if (feat === "requests") {
        items = items.filter(p => {
          const containers = p.spec?.containers || [];
          return containers.some(c => !c.resources?.requests || (!c.resources.requests.cpu && !c.resources.requests.memory));
        });
        advFilterLabel = " **without resource requests**";
      } else if (feat === "probes") {
        items = items.filter(p => {
          const containers = p.spec?.containers || [];
          return containers.some(c => !c.livenessProbe && !c.readinessProbe);
        });
        advFilterLabel = " **without liveness/readiness probes**";
      }
    }
    if (adv.missingFeature && (cmd.resourceType === "deployment" || cmd.resourceType === "deployments")) {
      const feat = adv.missingFeature;
      if (feat === "pdb") {
        advFilterLabel = " **without PodDisruptionBudget**";
      } else if (feat === "networkpolicy") {
        advFilterLabel = " **without NetworkPolicy**";
      }
    }

    // Advanced filter: statusFilter — "pods in Terminating", "stuck pods"
    if (adv.statusFilter && (cmd.resourceType === "pod" || cmd.resourceType === "pods")) {
      const sf = adv.statusFilter;
      items = items.filter(p => {
        const phase = p.status?.phase || "";
        const deleting = !!p.metadata?.deletionTimestamp;
        if (sf === "Terminating") return deleting;
        if (sf === "ContainerCreating") return (p.status?.containerStatuses || []).some(c => c.state?.waiting?.reason === "ContainerCreating");
        if (sf === "Init") return (p.status?.initContainerStatuses || []).some(c => c.state?.waiting || c.state?.terminated);
        if (sf === "Completed") return phase === "Succeeded";
        if (sf === "Unknown") return phase === "Unknown";
        return phase === sf;
      });
      advFilterLabel = advFilterLabel || ` in **${adv.statusFilter}** state`;
    }

    // Advanced filter: zeroReplicas — "deployments with 0 replicas"
    if (adv.zeroReplicas && (cmd.resourceType === "deployment" || cmd.resourceType === "deployments")) {
      items = items.filter(d => (d.spec?.replicas ?? 1) === 0);
      advFilterLabel = " **scaled to zero**";
    }

    // Advanced filter: superlative — "pod with most restarts", "oldest pod", etc.
    // CPU/memory superlatives are handled by the "top" handler, but restarts and
    // age can be resolved from the pod status without metrics API.
    if (adv.superlative && (cmd.resourceType === "pod" || cmd.resourceType === "pods")) {
      const sup = adv.superlative;
      if (sup.metric === "restarts") {
        items.sort((a, b) => {
          const rA = (a.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
          const rB = (b.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
          return sup.op === "max" ? rB - rA : rA - rB;
        });
        advFilterLabel = sup.op === "max" ? " **with most restarts**" : " **with fewest restarts**";
      } else if (sup.metric === "age") {
        items.sort((a, b) => {
          const tA = new Date(a.metadata?.creationTimestamp || 0).getTime();
          const tB = new Date(b.metadata?.creationTimestamp || 0).getTime();
          return sup.op === "max" ? tA - tB : tB - tA;
        });
        advFilterLabel = sup.op === "max" ? " **oldest first**" : " **newest first**";
      } else if (sup.metric === "cpu" || sup.metric === "memory") {
        // Shouldn't reach here (nluToCommand redirects to "top"), but as safety
        // net, fetch metrics and sort inline.
        try {
          const mPath = cmd.namespace
            ? `/apis/metrics.k8s.io/v1beta1/namespaces/${cmd.namespace}/pods`
            : `/apis/metrics.k8s.io/v1beta1/pods`;
          const mData = await ocpGet(mPath);
          const mItems = mData.items || [];
          const mMap = {};
          for (const m of mItems) {
            const total = (m.containers || []).reduce((s, c) => {
              return s + (sup.metric === "cpu" ? parseCpuNano(c.usage?.cpu) : parseMemBytes(c.usage?.memory));
            }, 0);
            mMap[m.metadata.namespace + "/" + m.metadata.name] = total;
          }
          items.sort((a, b) => {
            const vA = mMap[a.metadata.namespace + "/" + a.metadata.name] || 0;
            const vB = mMap[b.metadata.namespace + "/" + b.metadata.name] || 0;
            return sup.op === "max" ? vB - vA : vA - vB;
          });
          // Return a proper metrics table instead of the generic pod table
          const metricLabel = sup.metric === "cpu" ? "CPU" : "Memory";
          const dirLabel = sup.op === "max" ? "highest" : "lowest";
          const topN = items.slice(0, 20);
          const parts = [`### Pods by ${metricLabel} usage — ${dirLabel} first ${cmd.namespace ? `in \`${cmd.namespace}\`` : "(all namespaces)"} (${items.length} total)`];
          parts.push(`| # | Pod | Namespace | ${metricLabel} | Phase |`);
          parts.push(`| --- | --- | --- | --- | --- |`);
          topN.forEach((p, i) => {
            const key = p.metadata.namespace + "/" + p.metadata.name;
            const val = mMap[key] || 0;
            const fmt = sup.metric === "cpu" ? fmtCpu(String(val) + "n") : fmtMem(String(Math.round(val / 1024)) + "Ki");
            parts.push(`| ${i + 1} | \`${p.metadata.name}\` | ${p.metadata.namespace} | **${fmt}** | ${p.status?.phase || "Unknown"} |`);
          });
          return parts.join("\n");
        } catch (_e) {
          advFilterLabel = ` **by ${sup.metric}** (metrics unavailable — showing all)`;
        }
      }
    }

    const label = cmd.namespace ? `in \`${cmd.namespace}\`` : "(all namespaces)";
    const filterLabel = (cmd.filter ? ` matching **${cmd.filter}**` : "") + advFilterLabel;

    // ---- Count-scope: user asked "how many", return a single line ----
    // For deployments with "replica"/"count" queries, show a proper replica summary table
    if (cmd.scope === "count") {
      if (["deployment", "deployments", "deploy"].includes(cmd.resourceType)) {
        const parts = [`### Replica Count ${label} (${items.length} deployments)`];
        parts.push(`| Status | Deployment | Namespace | Ready | Desired | Available |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        let totalReady = 0, totalDesired = 0;
        const displayItems = items.slice(0, 30);
        for (const d of displayItems) {
          const ready = d.status?.readyReplicas ?? 0;
          const desired = d.spec?.replicas ?? 0;
          const available = d.status?.availableReplicas ?? 0;
          totalReady += ready;
          totalDesired += desired;
          const icon = ready === desired ? "[OK]" : ready === 0 ? "[CRITICAL]" : "[WARNING]";
          parts.push(`| ${icon} | **${d.metadata.name}** | ${d.metadata.namespace} | ${ready} | ${desired} | ${available} |`);
        }
        if (items.length > 30) {
          parts.push(`\n@@VIEW_MORE|deployment|${cmd.namespace || '_all'}|30|${items.length}@@`);
        }
        parts.push(``);
        parts.push(`**Total: ${totalReady}/${totalDesired} replicas ready across ${items.length} deployments**`);
        return parts.join("\n");
      }
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

    const displayLimit = (cmd.resourceType === "pod" || cmd.resourceType === "pods") ? 40 : 30;
    if (items.length > displayLimit) {
      parts.push(`\n@@VIEW_MORE|${cmd.resourceType}|${cmd.namespace || '_all'}|${displayLimit}|${items.length}@@`);
    }

    return parts.join("\n");
  } catch (err) {
    return `### ${resInfo.resource}\n${formatApiError(err, resInfo.resource)}`;
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
  // Exclude CR status/tracking/execution queries from ITSM form creation
  if (/\b(?:check|status|track|monitor|poll|approved|rejected|proceed|execute|start|run)\b/i.test(lower) &&
      /\b(?:cr|change\s*request|CHG)\b/i.test(lower)) {
    return null;
  }
  // Strip namespace/resource names (hyphenated compound words like
  // "snow-incident-resolution") so they don't false-positive on ITSM keywords.
  const stripped = lower.replace(/[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*/g, "___");
  for (const [type, pat] of Object.entries(ITSM_PATTERNS)) {
    if (pat.test(message)) return type;
  }
  if (/\b(?:change\s*request|CR)\b/i.test(stripped) && /\b(?:with|for|about|regarding|cluster|upgrade|deployment|service)\b/i.test(stripped)) {
    return "change_request";
  }
  if (/\b(?:incident)\b/i.test(stripped) && /\b(?:with|for|about|regarding|alert|down|issue|failure|outage)\b/i.test(stripped)) {
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

function buildITSMForm(type, message, ctx, preflightReport = null) {
  const now = new Date();
  const planned = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const fmtDate = (d) => d.toISOString().slice(0, 16).replace("T", " ");
  const c = ctx.cluster;
  const r = ctx.recent;

  // If a preflightReport was passed, this IS an upgrade CR regardless of message keywords.
  // Also match: "upgrade", "precheck", "pre-check", "above" (referencing prior precheck).
  const isUpgrade = !!preflightReport || /upgrade|pre-?check|above\s+(?:pre|check|assessment)/i.test(message);
  const userVersionMatch = message.match(/(\d+\.\d+\.\d+)/);
  const targetVersion = userVersionMatch ? userVersionMatch[1]
    : preflightReport?.targetVersion
    || (c.availableUpdates?.length ? c.availableUpdates[0] : "");

  if (type === "change_request") {
    let title = "OpenShift Change";
    let description = [];
    let risk = "moderate";
    let changeType = "normal";
    let rollback = "";
    let validation = "";
    let impact = "[Describe potential impact]";
    let justification = "";

    if (isUpgrade) {
      const pf = preflightReport;
      const fromVer = pf?.fromVersion || c.version || "current";
      const toVer = pf?.targetVersion || targetVersion || "target";
      const upgradeType = pf?.upgradeType || (fromVer !== toVer ? "Upgrade" : "");
      const overallStatus = pf?.overallStatus || "";
      const vd = pf?.versionDelta || {};
      const nt = pf?.nodeTopology || {};
      const fromMinor = (fromVer.match(/^\d+\.(\d+)/) || [])[1] || "";
      const toMinor = (toVer.match(/^\d+\.(\d+)/) || [])[1] || "";

      title = `OpenShift Cluster Upgrade: ${fromVer} → ${toVer}`;

      // --- DESCRIPTION: Version comparison + cluster environment ---
      description = [
        `═══════════════════════════════════════════════`,
        `OPENSHIFT CLUSTER UPGRADE — CHANGE DESCRIPTION`,
        `═══════════════════════════════════════════════`,
        ``,
        `1. VERSION COMPARISON`,
        `───────────────────────────────────────────────`,
        `Current Version       : ${fromVer}`,
        `Target Version        : ${toVer}`,
        `Upgrade Type          : ${upgradeType}`,
        `Kubernetes Version    : ${vd.kubeFrom || "N/A"} → ${vd.kubeTo || "N/A"}${vd.kubeSkew ? ` (${vd.kubeSkew} minor version${vd.kubeSkew > 1 ? "s" : ""})` : ""}`,
        `CRI-O Runtime         : ${vd.criO || "matches Kubernetes version"}`,
        `RHEL Base             : ${vd.rhelBase || "RHEL CoreOS"}`,
        `Update Channel        : ${c.channel || "N/A"}`,
        ``,
      ];

      // Feature highlights between versions
      const features = vd.featureHighlights || [];
      if (features.length > 0) {
        description.push(`2. WHAT'S NEW IN ${toVer}`);
        description.push(`───────────────────────────────────────────────`);
        for (const feat of features) {
          description.push(`  • ${feat}`);
        }
        description.push(``);
      }

      // API changes
      const apiRemovals = vd.apiRemovals || {};
      if (apiRemovals.removed?.length > 0 || apiRemovals.deprecated?.length > 0) {
        description.push(`3. API CHANGES`);
        description.push(`───────────────────────────────────────────────`);
        if (apiRemovals.removed?.length > 0) {
          description.push(`  REMOVED APIs (must migrate before upgrade):`);
          for (const api of apiRemovals.removed) {
            description.push(`    ✗ ${api.api} [${api.kinds?.join(", ")}] → use ${api.replacement}`);
          }
        }
        if (apiRemovals.deprecated?.length > 0) {
          description.push(`  DEPRECATED APIs (plan migration):`);
          for (const api of apiRemovals.deprecated.slice(0, 8)) {
            description.push(`    ⚠ ${api.name} → ${api.replacement || "check docs"}`);
          }
        }
        description.push(``);
      }

      // Cluster environment
      description.push(`4. CLUSTER ENVIRONMENT`);
      description.push(`───────────────────────────────────────────────`);
      description.push(`Platform              : ${c.platform || "N/A"}`);
      description.push(`Cluster ID            : ${c.clusterID || "N/A"}`);
      description.push(`API Server            : ${c.apiURL || "N/A"}`);
      const masterCount = nt.masters || 0;
      const workerCount = nt.workers || 0;
      const infraCount = nt.infra || 0;
      description.push(`Nodes                 : ${nt.total || c.nodeCount || "N/A"} total (${masterCount} control-plane, ${workerCount} worker${infraCount ? `, ${infraCount} infra` : ""})`);
      description.push(`Estimated Duration    : ${vd.estimatedDuration || "~1-2 hours (varies by cluster size)"}`);
      description.push(``);

      // Pre-upgrade assessment summary
      if (pf && pf.checks) {
        description.push(`5. PRE-UPGRADE ASSESSMENT: ${overallStatus}`);
        description.push(`───────────────────────────────────────────────`);
        description.push(`Total Checks          : ${pf.summary?.total || 0}`);
        description.push(`Passed                : ${pf.summary?.pass || 0}`);
        description.push(`Warnings              : ${pf.summary?.warning || 0}`);
        description.push(`Failed                : ${pf.summary?.fail || 0}`);
        description.push(``);

        const failures = pf.checks.filter(ch => ch.status === "fail");
        const warnings = pf.checks.filter(ch => ch.status === "warning");
        if (failures.length > 0) {
          description.push(`  BLOCKERS (must resolve before upgrade):`);
          for (const f of failures) {
            description.push(`    [FAIL] ${f.category}: ${f.details}`);
            if (f.recommendation) description.push(`           → ${f.recommendation}`);
          }
          description.push(``);
        }
        if (warnings.length > 0) {
          description.push(`  WARNINGS (review before proceeding):`);
          for (const w of warnings) {
            description.push(`    [WARN] ${w.category}: ${w.details}`);
            if (w.recommendation) description.push(`           → ${w.recommendation}`);
          }
          description.push(``);
        }

        const passedChecks = pf.checks.filter(ch => ch.status === "pass");
        if (passedChecks.length > 0) {
          description.push(`  PASSED CHECKS:`);
          for (const p of passedChecks) {
            description.push(`    [PASS] ${p.category}: ${p.details}`);
          }
          description.push(``);
        }
      }

      // Operator status
      description.push(`6. OPERATOR STATUS`);
      description.push(`───────────────────────────────────────────────`);
      description.push(`Cluster Operators     : ${pf?.operators?.clusterOperators || 0}`);
      const unhealthyOps = (pf?.allClusterOperators || []).filter(o => o.degraded || !o.available);
      if (unhealthyOps.length > 0) {
        for (const op of unhealthyOps) {
          description.push(`  ✗ ${op.name}: ${op.degraded ? "DEGRADED" : "Unavailable"} (${op.version || "N/A"})`);
        }
      } else {
        description.push(`  ✓ All cluster operators healthy and available`);
      }
      description.push(`OLM Operators         : ${pf?.operators?.olmOperators || 0}`);
      const olmIssues = (pf?.allOLMOperators || []).filter(o => o.compatible !== "yes" || o.issue);
      if (olmIssues.length > 0) {
        for (const op of olmIssues.slice(0, 10)) {
          description.push(`  ✗ ${op.name} (${op.version || "N/A"}): ${op.issue || op.status || "review compatibility"}`);
        }
      } else if (pf?.operators?.olmOperators > 0) {
        description.push(`  ✓ All OLM operators compatible with ${toVer}`);
      }
      description.push(``);

      // Node topology details
      if (nt.nodeDetails?.length > 0) {
        description.push(`7. NODE TOPOLOGY`);
        description.push(`───────────────────────────────────────────────`);
        for (const nd of nt.nodeDetails) {
          const readyStr = nd.ready ? "Ready" : "NOT READY";
          description.push(`  ${nd.name} [${nd.role}] — kubelet: ${nd.kubeletVersion || "N/A"}, ${readyStr}`);
        }
        description.push(``);
      }

      // Reference links
      description.push(`8. REFERENCES`);
      description.push(`───────────────────────────────────────────────`);
      if (vd.releaseNotesURL) description.push(`Release Notes         : ${vd.releaseNotesURL}`);
      if (vd.errataURL) description.push(`Errata / Advisories   : ${vd.errataURL}`);
      description.push(`Red Hat Support       : https://access.redhat.com/support/cases`);
      description.push(`OCP Life Cycle        : https://access.redhat.com/support/policy/updates/openshift`);

      // --- RISK ---
      risk = pf?.overallStatus === "NOT_READY" ? "high"
           : pf?.overallStatus === "READY_WITH_WARNINGS" ? "high"
           : "moderate";

      // --- JUSTIFICATION ---
      justification = [
        `Business Requirement: Maintain OpenShift cluster on supported, secure version.`,
        `Security: OpenShift ${toVer} includes critical security patches (CVEs), bug fixes, and platform improvements.`,
        upgradeType.includes("Patch") ? `This is a Z-stream (patch) update within the ${c.channel || "stable"} channel — low risk, recommended by Red Hat for all production clusters.` : `This is a minor version upgrade (${fromVer.match(/^\d+\.\d+/)?.[0]} → ${toVer.match(/^\d+\.\d+/)?.[0]}) — includes new features, Kubernetes ${vd.kubeFrom || ""} → ${vd.kubeTo || ""} update, and security fixes.`,
        `Compliance: Running unsupported versions may violate organizational security policies and SLAs.`,
        pf ? `Pre-Upgrade Assessment: ${overallStatus} — ${pf.summary?.pass || 0} passed, ${pf.summary?.warning || 0} warnings, ${pf.summary?.fail || 0} failures out of ${pf.summary?.total || 0} industry-standard checks.` : "",
      ].filter(Boolean).join("\n");

      // --- IMPACT ---
      impact = [
        `SCOPE OF IMPACT:`,
        `• Control Plane: ${masterCount || 3} master nodes will be upgraded sequentially (auto-managed by CVO)`,
        `• Worker Nodes: ${workerCount || "N/A"} worker nodes will be cordoned, drained, upgraded, and uncordoned one at a time via MachineConfigPool`,
        infraCount ? `• Infrastructure Nodes: ${infraCount} infra nodes will follow same rolling process` : "",
        `• Kubernetes API: Brief API unavailability during control plane rollover (~2-5 min per master)`,
        `• Workloads: Pods on drained nodes will be rescheduled; applications with PodDisruptionBudgets will experience graceful disruption`,
        `• Estimated Total Duration: ${vd.estimatedDuration || "~1-2 hours"}`,
        ``,
        `RISK MITIGATION:`,
        `• Rolling upgrade strategy ensures cluster remains operational throughout`,
        `• Workloads with ≥2 replicas and proper anti-affinity will have zero downtime`,
        `• PodDisruptionBudgets enforced during node drain`,
        pf?.summary?.fail > 0 ? `\nWARNING: ${pf.summary.fail} preflight check(s) FAILED — these MUST be resolved before proceeding.` : "",
      ].filter(Boolean).join("\n");

      // --- ROLLBACK / BACKOUT PLAN ---
      rollback = [
        `BACKOUT PLAN — OpenShift ${toVer} → ${fromVer}`,
        `═══════════════════════════════════════════════`,
        ``,
        `IMPORTANT: OpenShift minor version upgrades (e.g., 4.18 → 4.19) are`,
        `ONE-WAY and cannot be rolled back. Only Z-stream (patch) updates`,
        `within the same minor version can be reverted.`,
        ``,
        `PRE-UPGRADE SAFEGUARDS:`,
        `  1. Verify etcd backup exists: oc get etcdbackup -n openshift-etcd`,
        `  2. Confirm cluster backup: oc adm must-gather`,
        `  3. Document current state: oc get co; oc get nodes; oc get mcp`,
        ``,
        upgradeType.includes("Patch") ? [
          `Z-STREAM ROLLBACK PROCEDURE:`,
          `  1. oc adm upgrade --to=${fromVer}`,
          `  2. Monitor: oc adm upgrade (wait for Available=True)`,
          `  3. Verify: oc get co | grep -v 'True.*False.*False'`,
          `  4. Check nodes: oc get nodes -o wide`,
          `  5. Validate MCP: oc get mcp`,
        ].join("\n") : [
          `MINOR VERSION — DISASTER RECOVERY ONLY:`,
          `  1. Restore cluster from etcd backup snapshot`,
          `  2. Follow Red Hat KCS: https://access.redhat.com/solutions/5599961`,
          `  3. Restore procedure requires full cluster outage`,
          `  4. Contact Red Hat Support for assisted recovery`,
        ].join("\n"),
        ``,
        `ESCALATION PATH:`,
        `  1. L1: Cluster admin monitors oc adm upgrade for 30 min`,
        `  2. L2: If operators degraded >15 min, engage platform team`,
        `  3. L3: If cluster unrecoverable, initiate etcd restore + Red Hat Support case`,
      ].join("\n");

      // --- IMPLEMENTATION PLAN ---
      const implementationPlan = [
        `IMPLEMENTATION PLAN — OpenShift ${fromVer} → ${toVer}`,
        `═══════════════════════════════════════════════`,
        ``,
        `PRE-IMPLEMENTATION (T-60 min):`,
        `  □ Verify pre-upgrade assessment: ${pf?.summary?.total || 22} checks passed`,
        `  □ Confirm etcd backup: oc get etcdbackup -n openshift-etcd`,
        `  □ Run must-gather: oc adm must-gather --dest-dir=/tmp/pre-upgrade-${fromVer}`,
        `  □ Verify all ClusterOperators healthy: oc get co`,
        `  □ Verify all nodes Ready: oc get nodes`,
        `  □ Verify MachineConfigPools not updating: oc get mcp`,
        `  □ Notify stakeholders per communication plan`,
        `  □ Verify PDB compliance for critical workloads`,
        ``,
        `IMPLEMENTATION (T-0):`,
        `  1. Set maintenance channel (if needed):`,
        `     oc adm upgrade channel ${c.channel || "stable-" + toMinor}`,
        `  2. Initiate cluster upgrade:`,
        `     oc adm upgrade --to=${toVer}`,
        `  3. Monitor control plane upgrade:`,
        `     watch "oc get co; oc adm upgrade"`,
        `  4. Verify control plane completion:`,
        `     oc get co | grep -v 'True.*False.*False'`,
        `  5. Monitor worker node rolling update:`,
        `     watch "oc get nodes; oc get mcp"`,
        `  6. Wait for all MachineConfigPools to complete:`,
        `     oc wait mcp --all --for=condition=Updated --timeout=90m`,
        ``,
        `POST-IMPLEMENTATION:`,
        `  □ Verify cluster version: oc adm upgrade`,
        `  □ Verify all operators: oc get co`,
        `  □ Verify all nodes: oc get nodes -o wide`,
        `  □ Run smoke tests on critical applications`,
        `  □ Check for new alerts: oc get alerts (Prometheus)`,
        `  □ Update CMDB / asset inventory with new version`,
        `  □ Close maintenance window notification`,
      ].join("\n");

      // --- VALIDATION / TEST PLAN ---
      validation = [
        `TESTING & VALIDATION PLAN`,
        `═══════════════════════════════════════════════`,
        ``,
        `AUTOMATED CHECKS (run immediately after upgrade):`,
        `  1. oc adm upgrade — confirm desired version is ${toVer}`,
        `  2. oc get co — all operators: Available=True, Degraded=False, Progressing=False`,
        `  3. oc get nodes -o wide — all nodes Ready, version updated to ${vd.kubeTo || toVer}`,
        `  4. oc get mcp — all pools: Updated=True, Degraded=False, MachineCount=ReadyMachineCount`,
        `  5. oc get pods -A | grep -Ev 'Running|Completed' — no CrashLoopBackOff or unexpected states`,
        `  6. oc get csr — no pending certificate signing requests`,
        ``,
        `APPLICATION VALIDATION:`,
        `  7. Verify critical application endpoints respond (HTTP 200)`,
        `  8. Run application-specific smoke tests / health checks`,
        `  9. Confirm ingress routes / TLS certificates functioning`,
        `  10. Validate persistent volume claims are bound and accessible`,
        ``,
        `MONITORING VALIDATION:`,
        `  11. Check Prometheus / Alertmanager for new critical alerts`,
        `  12. Verify monitoring stack is scraping all targets`,
        `  13. Confirm log aggregation pipeline is operational`,
        ``,
        `OPERATOR VALIDATION:`,
        `  14. oc get csv -A — all ClusterServiceVersions in Succeeded phase`,
        `  15. Verify operator-managed CRDs are accessible`,
        `  16. Check operator logs for errors: oc logs -n openshift-operator-lifecycle-manager`,
        ``,
        `SIGN-OFF CRITERIA:`,
        `  • All ${pf?.summary?.total || 22} automated checks pass`,
        `  • No new critical/warning alerts within 30 min post-upgrade`,
        `  • Application health checks pass`,
        `  • Change Advisory Board (CAB) notified of successful completion`,
      ].join("\n");

      // --- COMMUNICATION PLAN (work notes) ---
      const communicationPlan = [
        `COMMUNICATION PLAN:`,
        `Pre-Change   : Notify all application teams 48h before maintenance window`,
        `During Change: Post status updates every 30 min to #platform-ops channel`,
        `Post-Change  : Send completion notice with validation results`,
        `Failure      : Immediately notify incident commander; initiate backout plan`,
      ].join("\n");

      // Store implementation plan + communication plan for the form
      changeType = "normal";

      return {
        type: "change_request",
        fields: {
          title: { label: "Change Request Title", value: title },
          justification: { label: "Business Justification", value: justification },
          changeType: { label: "Change Type", value: changeType, options: ["standard", "normal", "emergency"] },
          priority: { label: "Priority", value: risk === "high" ? "2" : "3", options: ["1 - Critical", "2 - High", "3 - Moderate", "4 - Low"] },
          risk: { label: "Risk Level", value: risk, options: ["low", "moderate", "high"] },
          plannedDate: { label: "Planned Implementation Date/Time", value: fmtDate(planned) },
          assignmentGroup: { label: "Assignment Group", value: "" },
          description: { label: "Change Description", value: description.join("\n") },
          implementationPlan: { label: "Implementation Plan", value: implementationPlan },
          impact: { label: "Impact Assessment", value: impact },
          rollback: { label: "Backout / Rollback Plan", value: rollback },
          validation: { label: "Testing / Validation Plan", value: validation },
          communicationPlan: { label: "Communication Plan", value: communicationPlan },
        },
        servicenowEnabled: isServiceNowEnabled(),
      };
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
          `Namespace: ${r.namespace || "[specify]"}`,
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
        justification: { label: "Business Justification", value: justification },
        changeType: { label: "Change Type", value: changeType, options: ["standard", "normal", "emergency"] },
        priority: { label: "Priority", value: risk === "high" ? "2" : "3", options: ["1 - Critical", "2 - High", "3 - Moderate", "4 - Low"] },
        risk: { label: "Risk Level", value: risk, options: ["low", "moderate", "high"] },
        plannedDate: { label: "Planned Implementation Date/Time", value: fmtDate(planned) },
        assignmentGroup: { label: "Assignment Group", value: "" },
        description: { label: "Change Description", value: description.join("\n") },
        impact: { label: "Impact Assessment", value: impact },
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
// Resolve remote cluster context from agent cache for chat use
// ---------------------------------------------------------------------------
function resolveRemoteClusterContext(body) {
  if (!body?.cluster || body.cluster === "local") return null;
  const cachedSummary = getAgentCachedResponse(body.cluster, "/api/cluster/summary", { skipFreshnessCheck: true });
  if (!cachedSummary) return null;
  return {
    clusterName: body.cluster,
    summary: cachedSummary,
    nodes: getAgentCachedResponse(body.cluster, "/api/nodes", { skipFreshnessCheck: true }) || [],
    podIssues: getAgentCachedResponse(body.cluster, "/api/pods/issues", { skipFreshnessCheck: true }) || [],
    alerts: getAgentCachedResponse(body.cluster, "/api/alerts", { skipFreshnessCheck: true }) || { alerts: [], summary: {} },
    operators: getAgentCachedResponse(body.cluster, "/api/cluster/operators", { skipFreshnessCheck: true }) || [],
    namespaces: getAgentCachedResponse(body.cluster, "/api/namespaces", { skipFreshnessCheck: true }) || [],
    // Advanced feature data (present when agent reports it; null otherwise)
    security: getAgentCachedResponse(body.cluster, "/api/dashboard/security", { skipFreshnessCheck: true }),
    gitops: getAgentCachedResponse(body.cluster, "/api/dashboard/gitops", { skipFreshnessCheck: true }),
    dr: getAgentCachedResponse(body.cluster, "/api/dashboard/dr", { skipFreshnessCheck: true }),
    optimization: getAgentCachedResponse(body.cluster, "/api/dashboard/optimization", { skipFreshnessCheck: true }),
    imageVulns: getAgentCachedResponse(body.cluster, "/api/dashboard/image-vulns", { skipFreshnessCheck: true }),
    workloads: getAgentCachedResponse(body.cluster, "/api/dashboard/workloads", { skipFreshnessCheck: true }),
    source: "agent-cache",
  };
}

// ---------------------------------------------------------------------------
// Build chat context from cached agent data (for remote clusters)
// ---------------------------------------------------------------------------
function buildContextFromAgentCache(cache, userMessage) {
  const ctx = {};
  const s = cache.summary;
  if (s) {
    ctx.clusterVersion = {
      version: s.cluster?.version || "unknown",
      desired: s.cluster?.version || "unknown",
      channel: s.cluster?.channel || "",
    };
    ctx.clusterHealth = s.cluster?.health || "unknown";
    ctx.platform = s.platform || "kubernetes";
    ctx.isOpenShift = s.isOpenShift || false;
    ctx.totalNodes = s.nodes?.total || 0;
    ctx.readyNodes = s.nodes?.ready || 0;
    ctx.totalCPU = s.nodes?.totalCPU || 0;
    ctx.totalMemGi = s.nodes?.totalMemGi || 0;
    ctx.totalNamespaces = s.namespaces?.total || 0;
    ctx.userNamespaces = s.namespaces?.user || 0;
    ctx.operatorCount = s.operators?.total || 0;
    ctx.degradedOperators = s.operators?.degraded || 0;
    ctx.degradedNames = s.operators?.degradedNames || [];
  }
  ctx.nodes = (cache.nodes || []).map(n => ({
    name: n.name, roles: n.roles, ready: n.ready,
    cpu: n.cpu, memory: n.memory, kubeletVersion: n.kubeletVersion,
    osImage: n.osImage,
  }));
  ctx.problemPods = (cache.podIssues || []).map(p => ({
    name: p.name, namespace: p.namespace, node: p.node,
    phase: p.phase, issues: p.issues, ownerKind: p.ownerKind, ownerName: p.ownerName,
  }));
  ctx.operators = (cache.operators || []).map(o => ({
    name: o.name, health: o.health, version: o.version, message: o.message,
  }));
  const alerts = cache.alerts;
  ctx.recentWarnings = (alerts?.alerts || []).slice(0, 30).map(a => ({
    reason: a.name, message: a.summary, namespace: a.namespace,
    resource: a.resource, count: a.count,
  }));
  const nodeMetrics = getAgentCachedResponse(cache.clusterName, "/api/node-metrics", { skipFreshnessCheck: true }) || [];
  if (nodeMetrics.length > 0) {
    ctx.nodeMetrics = nodeMetrics.map(m => ({
      name: m.name, cpuUsage: m.cpuUsage, cpu: m.cpu, cpuPercent: m.cpuPercent,
      memoryUsage: m.memoryUsage, memory: m.memory, memoryPercent: m.memoryPercent,
    }));
  }
  const nsList = cache.namespaces || [];
  if (nsList.length > 0) {
    ctx.namespaces = nsList.map(n => ({
      name: n.name, status: n.status, podCount: n.podCount,
      running: n.running, failed: n.failed, pending: n.pending, health: n.health,
    }));
    ctx.totalPods = nsList.reduce((s, n) => s + (n.podCount || 0), 0);
  }
  ctx._remoteCluster = cache.clusterName;
  ctx._source = "agent-cache";
  return ctx;
}

// ---------------------------------------------------------------------------
// Handle chat queries for remote clusters using cached agent data.
//
// When the user has selected a remote (spoke) cluster, ocpGet() still hits
// the local hub cluster — so we answer from the cached agent snapshot instead.
// Returns a formatted markdown string for recognized query types, or null
// to fall through to the LLM path (which will receive the cached context via
// buildContextFromAgentCache).
// ---------------------------------------------------------------------------
function handleRemoteCacheQuery(message, parsed, remoteCtx, opts = {}) {
  if (!remoteCtx) return null;

  const lower = message.toLowerCase();
  const summary = remoteCtx.summary || {};
  const isOpenShift = summary.isOpenShift || false;
  const platform = summary.platform || (isOpenShift ? "OpenShift" : "Kubernetes");

  // Cluster identity header — prepended to every response
  const healthEmoji = (summary.cluster?.health || "").toLowerCase() === "healthy" ? "[OK]" : "[WARNING]";
  const header = `> ${healthEmoji} **${remoteCtx.clusterName}** | ${platform} ${summary.cluster?.version || ""} | ${(summary.nodes?.ready || 0)}/${(summary.nodes?.total || 0)} nodes\n`;

  // Helper: build the version label appropriate for the platform
  const versionLabel = isOpenShift ? "OpenShift Version" : "Kubernetes Version";
  const clusterVersion = summary.cluster?.version || "unknown";
  const clusterHealth = summary.cluster?.health || "unknown";
  const channel = summary.cluster?.channel || "—";

  // ---------------------------------------------------------------------------
  // (a) Cluster status / health / overview
  // ---------------------------------------------------------------------------
  if (/\bcluster\b/.test(lower) && /\bstatus\b|\bhealth\b|\boverview\b|\bcheck\b/.test(lower)) {
    const parts = [header];
    parts.push(`### Cluster Status Overview`);
    parts.push("");

    // Identity table
    parts.push(`| Property | Value |`);
    parts.push(`| --- | --- |`);
    parts.push(`| **${versionLabel}** | ${clusterVersion} |`);
    parts.push(`| **Channel** | ${channel} |`);
    parts.push(`| **Platform** | ${platform} |`);
    parts.push(`| **Health** | ${clusterHealth === "healthy" ? "[OK] Healthy" : clusterHealth === "warning" || clusterHealth === "degraded" ? `[WARNING] ${clusterHealth.charAt(0).toUpperCase() + clusterHealth.slice(1)}` : `[CRITICAL] ${clusterHealth.charAt(0).toUpperCase() + clusterHealth.slice(1)}`} |`);
    parts.push("");

    // Node summary
    const nodes = summary.nodes || {};
    const notReady = (nodes.total || 0) - (nodes.ready || 0);
    parts.push(`**Nodes:** ${nodes.total || 0} total | ${nodes.ready || 0} ready | ${notReady} not-ready | ${nodes.totalCPU || 0} CPU | ${nodes.totalMemGi || 0} Gi memory`);

    // Flag not-ready nodes from the node list
    const notReadyNodes = (remoteCtx.nodes || []).filter(n => !n.ready);
    if (notReadyNodes.length > 0) {
      notReadyNodes.forEach(n => parts.push(`  [CRITICAL] \`${n.name}\` — NotReady`));
    }

    // Pressure conditions
    const pressureNodes = (remoteCtx.nodes || []).filter(n =>
      n.memoryPressure || n.diskPressure || n.pidPressure
    );
    if (pressureNodes.length > 0) {
      pressureNodes.forEach(n => {
        const pTypes = [];
        if (n.memoryPressure) pTypes.push("MemoryPressure");
        if (n.diskPressure) pTypes.push("DiskPressure");
        if (n.pidPressure) pTypes.push("PIDPressure");
        parts.push(`  [WARNING] \`${n.name}\` — ${pTypes.join(", ")}`);
      });
    }
    parts.push("");

    // Operators / workloads summary
    const ops = summary.operators || {};
    if (isOpenShift) {
      parts.push(`**Operators:** ${ops.total || 0} total | ${ops.healthy || 0} healthy | ${ops.degraded || 0} degraded`);
      if (ops.degraded > 0 && ops.degradedNames?.length > 0) {
        ops.degradedNames.forEach(name =>
          parts.push(`  [CRITICAL] \`${name}\` — Degraded`)
        );
      }
    } else {
      parts.push(`**Workloads:** ${ops.total || 0} total | ${ops.healthy || 0} healthy | ${ops.degraded || 0} unhealthy`);
    }
    parts.push("");

    // Namespaces
    const ns = summary.namespaces || {};
    const nsLabel = isOpenShift ? "Projects" : "Namespaces";
    parts.push(`**${nsLabel}:** ${ns.total || 0} total | ${ns.user || 0} user | ${ns.system || 0} system`);
    parts.push("");

    // Problem pods
    const podIssues = remoteCtx.podIssues || [];
    if (podIssues.length > 0) {
      parts.push(`**Problem Pods:** ${podIssues.length}`);
      const byReason = {};
      podIssues.forEach(p => {
        (p.issues || []).forEach(i => {
          const reason = i.reason || p.phase || "Unknown";
          byReason[reason] = (byReason[reason] || 0) + 1;
        });
      });
      Object.entries(byReason).sort((a, b) => b[1] - a[1]).forEach(([reason, count]) => {
        parts.push(`  - ${reason}: ${count}`);
      });
      parts.push("");
    }

    // Warning events / alerts
    const alerts = remoteCtx.alerts || {};
    const alertList = alerts.alerts || [];
    if (alertList.length > 0) {
      const warnCount = alerts.summary?.warning || 0;
      const critCount = alerts.summary?.critical || 0;
      parts.push(`**Alerts:** ${alertList.length} active | ${critCount} critical | ${warnCount} warning`);
      alertList.slice(0, 8).forEach(a => {
        const sev = a.severity === "critical" ? "[CRITICAL]" : "[WARNING]";
        parts.push(`  - ${sev} **${a.name}**: ${a.summary || "—"} (x${a.count || 1})`);
      });
      parts.push("");
    }

    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (b) Node health / list / status
  // ---------------------------------------------------------------------------
  if (/\bnode/.test(lower) && /\bhealth\b|\bstatus\b|\blist\b|\bshow\b|\bcheck\b/.test(lower)) {
    const nodeList = remoteCtx.nodes || [];
    const parts = [header];
    parts.push(`### Node Health Overview`);
    parts.push("");

    const readyCount = nodeList.filter(n => n.ready).length;
    const notReadyCount = nodeList.length - readyCount;
    parts.push(`Your cluster has **${nodeList.length} node(s)**: ${readyCount} Ready, ${notReadyCount} NotReady`);
    parts.push("");

    parts.push(`| Status | Node | Roles | CPU | Memory | Kubelet | OS | Conditions |`);
    parts.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
    nodeList.forEach(n => {
      const icon = n.ready ? "[OK]" : "[CRITICAL]";
      const roles = n.roles || "worker";
      const cpu = n.cpu || "—";
      const memory = n.memory || "—";
      const kubelet = n.kubeletVersion || "—";
      const os = n.osImage || "—";
      const problemConds = [];
      if (!n.ready) problemConds.push("NotReady");
      if (n.memoryPressure) problemConds.push("MemoryPressure");
      if (n.diskPressure) problemConds.push("DiskPressure");
      if (n.pidPressure) problemConds.push("PIDPressure");
      const condStr = problemConds.length > 0 ? problemConds.join(", ") : "Healthy";
      parts.push(`| ${icon} | \`${n.name}\` | ${roles} | ${cpu} | ${memory} | ${kubelet} | ${os} | ${condStr} |`);
    });
    parts.push("");

    // Summary stats
    parts.push(`- **Total nodes:** ${nodeList.length}`);
    parts.push(`- **Ready nodes:** ${readyCount}`);
    parts.push(`- **NotReady nodes:** ${notReadyCount}`);

    // Flag problem nodes
    const problemNodes = nodeList.filter(n =>
      !n.ready || n.memoryPressure || n.diskPressure || n.pidPressure
    );
    if (problemNodes.length > 0) {
      parts.push("");
      parts.push(`**Issues Detected:**`);
      problemNodes.forEach(n => {
        if (!n.ready) {
          parts.push(`  [CRITICAL] \`${n.name}\` — NotReady`);
        }
        const pTypes = [];
        if (n.memoryPressure) pTypes.push("MemoryPressure");
        if (n.diskPressure) pTypes.push("DiskPressure");
        if (n.pidPressure) pTypes.push("PIDPressure");
        if (pTypes.length > 0) {
          parts.push(`  [WARNING] \`${n.name}\` — ${pTypes.join(", ")}`);
        }
      });
    }

    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (c) Pod issues / problem pods / crash / failing / "what's wrong"
  // ---------------------------------------------------------------------------
  if ((/\bpod/.test(lower) && /\bissue|\bproblem|\bcrash|\bfail|\berror/.test(lower)) ||
      /\bwhat.?s\s+wrong\b|\bwhat\s+is\s+wrong\b/.test(lower)) {
    const podIssues = remoteCtx.podIssues || [];
    const parts = [header];

    if (podIssues.length === 0) {
      parts.push(`### Pod Issues`);
      parts.push("");
      parts.push(`No problem pods detected on this cluster.`);
      return parts.join("\n");
    }

    parts.push(`### Problem Pods (${podIssues.length})`);
    parts.push("");

    // Group by issue reason
    const byReason = {};
    podIssues.forEach(p => {
      const reasons = (p.issues || []).map(i => i.reason).filter(Boolean);
      const key = reasons.length > 0 ? reasons[0] : (p.phase || "Unknown");
      if (!byReason[key]) byReason[key] = [];
      byReason[key].push(p);
    });

    for (const [reason, pods] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
      parts.push(`#### ${reason} (${pods.length})`);
      parts.push(`| Status | Pod | Namespace | Node | Phase | Restarts | Message |`);
      parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
      pods.forEach(p => {
        const issue = (p.issues || [])[0] || {};
        const restarts = issue.restarts ?? 0;
        const msg = (issue.message || "").slice(0, 80).replace(/\|/g, "/");
        const owner = p.ownerKind ? `${p.ownerKind}/${p.ownerName}` : "—";
        parts.push(`| [CRITICAL] | \`${p.name}\` | ${p.namespace} | ${p.node || "—"} | ${p.phase || "—"} | ${restarts} | ${msg || "—"} |`);
      });
      parts.push("");
    }

    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (d) List namespaces / projects
  // ---------------------------------------------------------------------------
  if (/\bnamespace|\bproject/.test(lower) && /\blist\b|\bshow\b|\bhow\s+many|\bcount/.test(lower)) {
    const ns = summary.namespaces || {};
    const nsLabel = isOpenShift ? "Projects" : "Namespaces";
    const nsList = remoteCtx.namespaces || [];
    const parts = [header];
    parts.push(`### ${nsLabel} (${ns.total || nsList.length})`);
    parts.push("");
    parts.push(`**Summary:** ${ns.total || nsList.length} total | ${ns.user || 0} user | ${ns.system || 0} system`);
    parts.push("");

    if (nsList.length > 0) {
      const userNs = nsList.filter(n => !n.name?.startsWith("kube-") && !n.name?.startsWith("openshift-") && n.name !== "default");
      const sysNs = nsList.filter(n => n.name?.startsWith("kube-") || n.name?.startsWith("openshift-") || n.name === "default");

      if (userNs.length > 0) {
        parts.push(`#### User ${nsLabel} (${userNs.length})`);
        parts.push(`| Status | ${nsLabel.slice(0, -1)} | Pods | Running | Failed | Health |`);
        parts.push(`| --- | --- | --- | --- | --- | --- |`);
        userNs.forEach(n => {
          const icon = n.health === "critical" ? "[CRITICAL]" : (n.health === "pending" ? "[WARNING]" : "[OK]");
          parts.push(`| ${icon} | \`${n.name}\` | ${n.podCount || 0} | ${n.running || 0} | ${n.failed || 0} | ${n.health || "idle"} |`);
        });
        parts.push("");
      }

      if (sysNs.length > 0) {
        parts.push(`<details><summary>System ${nsLabel.toLowerCase()} (${sysNs.length})</summary>\n`);
        parts.push(`| ${nsLabel.slice(0, -1)} | Pods | Status |`);
        parts.push(`| --- | --- | --- |`);
        sysNs.forEach(n => {
          parts.push(`| \`${n.name}\` | ${n.podCount || 0} | ${n.status || "Active"} |`);
        });
        parts.push(`\n</details>`);
      }
    } else {
      parts.push(`> Individual ${nsLabel.toLowerCase()} listing is not available from the agent cache.`);
    }

    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (e) List operators (OpenShift only)
  // ---------------------------------------------------------------------------
  if (/\boperator/.test(lower) && /\blist\b|\bshow\b|\bstatus\b|\bhealth\b/.test(lower)) {
    const opsList = remoteCtx.operators || [];
    const parts = [header];

    if (!isOpenShift) {
      parts.push(`### Operators`);
      parts.push("");
      parts.push(`This cluster is not running OpenShift — operator listing is not available.`);
      return parts.join("\n");
    }

    parts.push(`### Cluster Operators (${opsList.length})`);
    parts.push("");

    if (opsList.length === 0) {
      parts.push(`No operator data available in the agent cache.`);
      return parts.join("\n");
    }

    // Show degraded / unavailable operators first
    const degraded = opsList.filter(o => o.health === "Degraded" || o.degraded);
    const unavailable = opsList.filter(o => o.available === false && !o.degraded);
    const progressing = opsList.filter(o => o.progressing);
    const healthy = opsList.filter(o =>
      o.health !== "Degraded" && !o.degraded && o.available !== false
    );

    parts.push(`**Summary:** ${opsList.length} total | ${healthy.length} healthy | ${degraded.length} degraded | ${unavailable.length} unavailable | ${progressing.length} progressing`);
    parts.push("");

    parts.push(`| Status | Operator | Version | Health | Message |`);
    parts.push(`| --- | --- | --- | --- | --- |`);

    // Degraded operators first
    degraded.forEach(o => {
      const msg = (o.message || "").slice(0, 80).replace(/\|/g, "/");
      parts.push(`| [CRITICAL] | \`${o.name}\` | ${o.version || "—"} | Degraded | ${msg || "—"} |`);
    });

    // Unavailable operators next
    unavailable.forEach(o => {
      const msg = (o.message || "").slice(0, 80).replace(/\|/g, "/");
      parts.push(`| [WARNING] | \`${o.name}\` | ${o.version || "—"} | Unavailable | ${msg || "—"} |`);
    });

    // Progressing operators
    progressing.filter(o => !o.degraded && o.available !== false).forEach(o => {
      const msg = (o.message || "").slice(0, 80).replace(/\|/g, "/");
      parts.push(`| [WARNING] | \`${o.name}\` | ${o.version || "—"} | Progressing | ${msg || "—"} |`);
    });

    // Healthy operators
    healthy.filter(o => !o.progressing).forEach(o => {
      parts.push(`| [OK] | \`${o.name}\` | ${o.version || "—"} | Healthy | — |`);
    });

    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (f) Events / warnings / alerts
  // ---------------------------------------------------------------------------
  if (/\bevent|\bwarning|\balert/.test(lower)) {
    const alerts = remoteCtx.alerts || {};
    const alertList = alerts.alerts || [];
    const parts = [header];

    if (alertList.length === 0) {
      parts.push(`### Alerts & Warnings`);
      parts.push("");
      parts.push(`No active alerts or warnings on this cluster.`);
      return parts.join("\n");
    }

    const warnCount = alerts.summary?.warning || 0;
    const critCount = alerts.summary?.critical || 0;
    parts.push(`### Alerts & Warnings (${alertList.length} active | ${critCount} critical | ${warnCount} warning)`);
    parts.push("");

    parts.push(`| Severity | Alert | Namespace | Resource | Summary | Count |`);
    parts.push(`| --- | --- | --- | --- | --- | --- |`);
    alertList.forEach(a => {
      const icon = a.severity === "critical" ? "[CRITICAL]" : "[WARNING]";
      const msg = (a.summary || "").slice(0, 80).replace(/\|/g, "/");
      parts.push(`| ${icon} | **${a.name}** | ${a.namespace || "—"} | ${a.resource || "—"} | ${msg || "—"} | x${a.count || 1} |`);
    });

    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (g) Node metrics / CPU / memory / resource usage / "top nodes"
  // ---------------------------------------------------------------------------
  if ((/\bnode/.test(lower) && /\bcpu\b|\bmemory\b|\bresource\b|\busage\b|\butiliz|\btop\b|\bmetric/.test(lower)) ||
      (/\btop\b/.test(lower) && /\bnode/.test(lower)) ||
      (/\bresource\b/.test(lower) && /\busage\b|\butiliz/.test(lower))) {
    const nodeMetrics = getAgentCachedResponse(remoteCtx.clusterName, "/api/node-metrics", { skipFreshnessCheck: true }) || [];
    const nodeList = remoteCtx.nodes || [];
    const parts = [header];
    parts.push(`### Node Resource Utilization`);
    parts.push("");

    if (nodeMetrics.length > 0) {
      parts.push(`| Node | CPU Usage | CPU Capacity | CPU % | Memory Usage | Memory Capacity | Memory % |`);
      parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
      nodeMetrics.forEach(m => {
        const cpuPct = m.cpuPercent != null ? m.cpuPercent + "%" : "—";
        const memPct = m.memoryPercent != null ? m.memoryPercent + "%" : "—";
        const icon = (m.cpuPercent > 85 || m.memoryPercent > 85) ? "[WARNING]" : "[OK]";
        parts.push(`| ${icon} \`${m.name}\` | ${m.cpuUsage || "—"} | ${m.cpu || "—"} | ${cpuPct} | ${m.memoryUsage || "—"} | ${m.memory || "—"} | ${memPct} |`);
      });
      parts.push("");
      const avgCpu = nodeMetrics.filter(m => m.cpuPercent != null).reduce((s, m) => s + m.cpuPercent, 0) / (nodeMetrics.filter(m => m.cpuPercent != null).length || 1);
      const avgMem = nodeMetrics.filter(m => m.memoryPercent != null).reduce((s, m) => s + m.memoryPercent, 0) / (nodeMetrics.filter(m => m.memoryPercent != null).length || 1);
      parts.push(`**Cluster Average:** CPU ${avgCpu.toFixed(1)}% | Memory ${avgMem.toFixed(1)}%`);
      const hotNodes = nodeMetrics.filter(m => m.cpuPercent > 80 || m.memoryPercent > 80);
      if (hotNodes.length > 0) {
        parts.push("");
        parts.push(`**High Utilization Nodes:**`);
        hotNodes.forEach(m => {
          if (m.cpuPercent > 80) parts.push(`  [WARNING] \`${m.name}\` — CPU at ${m.cpuPercent}%`);
          if (m.memoryPercent > 80) parts.push(`  [WARNING] \`${m.name}\` — Memory at ${m.memoryPercent}%`);
        });
      }
    } else if (nodeList.length > 0) {
      parts.push(`| Node | Roles | CPU Capacity | Memory Capacity | Status |`);
      parts.push(`| --- | --- | --- | --- | --- |`);
      nodeList.forEach(n => {
        parts.push(`| \`${n.name}\` | ${n.roles || "worker"} | ${n.cpu || "—"} | ${n.memory || "—"} | ${n.ready ? "Ready" : "NotReady"} |`);
      });
      parts.push("");
      parts.push(`> Detailed metrics (usage percentages) are not available in the agent cache. Capacity values shown.`);
    } else {
      parts.push(`No node metrics available for this cluster.`);
    }
    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (h) Version / upgrade / precheck / update / channel info
  // ---------------------------------------------------------------------------
  if (/\bversion\b|\bupgrade\b|\bupdate\b|\bchannel\b|\bprecheck\b|\bpre-check\b|\bpre.?flight\b|\bupgrad/.test(lower)) {
    const isUpgradeQuery = /\bupgrade\b|\bupdate\b|\bprecheck\b|\bpre-check\b|\bpre.?flight\b/.test(lower);
    const parts = [header];
    parts.push(isUpgradeQuery ? `### Upgrade Readiness — ${remoteCtx.clusterName}` : `### Cluster Version`);
    parts.push("");
    parts.push(`| Property | Value |`);
    parts.push(`| --- | --- |`);
    parts.push(`| **${versionLabel}** | ${clusterVersion} |`);
    parts.push(`| **Channel** | ${channel} |`);
    parts.push(`| **Platform** | ${platform} |`);
    parts.push(`| **Health** | ${clusterHealth === "healthy" ? "[OK] Healthy" : clusterHealth === "degraded" ? "[WARNING] Degraded" : "[CRITICAL] " + clusterHealth} |`);
    parts.push("");

    const nodeList = remoteCtx.nodes || [];
    if (nodeList.length > 0) {
      const kubeletVersions = [...new Set(nodeList.map(n => n.kubeletVersion).filter(Boolean))];
      parts.push(`**Kubelet Versions:** ${kubeletVersions.join(", ") || "—"}`);
      if (kubeletVersions.length > 1) {
        parts.push(`  [WARNING] Mixed kubelet versions detected across nodes`);
      }
      parts.push("");
    }

    if (isUpgradeQuery) {
      const ops = summary.operators || {};
      const nodes = summary.nodes || {};
      const podIssues = remoteCtx.podIssues || [];
      const alerts = remoteCtx.alerts || {};
      const alertList = alerts.alerts || [];
      let readyForUpgrade = true;
      parts.push(`#### Pre-flight Checks`);
      parts.push("");
      if (clusterHealth !== "healthy") {
        readyForUpgrade = false;
        parts.push(`[CRITICAL] Cluster health is **${clusterHealth}** — resolve before upgrading`);
      } else {
        parts.push(`[OK] Cluster health is **Healthy**`);
      }
      if ((nodes.ready || 0) < (nodes.total || 0)) {
        readyForUpgrade = false;
        parts.push(`[CRITICAL] ${(nodes.total || 0) - (nodes.ready || 0)} node(s) not ready — all nodes must be Ready before upgrade`);
      } else {
        parts.push(`[OK] All ${nodes.total || 0} nodes are Ready`);
      }
      if (isOpenShift && (ops.degraded || 0) > 0) {
        readyForUpgrade = false;
        parts.push(`[CRITICAL] ${ops.degraded} operator(s) degraded: ${ops.degradedNames?.join(", ") || "unknown"}`);
      } else if (isOpenShift) {
        parts.push(`[OK] All ${ops.total || 0} cluster operators are Available`);
      }
      if (podIssues.length > 5) {
        readyForUpgrade = false;
        parts.push(`[WARNING] ${podIssues.length} problem pods detected — review before upgrade`);
      } else if (podIssues.length > 0) {
        parts.push(`[WARNING] ${podIssues.length} problem pod(s) — minor, may not block upgrade`);
      } else {
        parts.push(`[OK] No problem pods`);
      }
      const nodeMetrics = getAgentCachedResponse(remoteCtx.clusterName, "/api/node-metrics", { skipFreshnessCheck: true }) || [];
      if (nodeMetrics.length > 0) {
        const highMem = nodeMetrics.filter(m => m.memoryPercent > 85);
        const highCpu = nodeMetrics.filter(m => m.cpuPercent > 85);
        if (highMem.length > 0 || highCpu.length > 0) {
          parts.push(`[WARNING] Resource pressure — ${highCpu.length} node(s) CPU >85%, ${highMem.length} node(s) memory >85%`);
        } else {
          parts.push(`[OK] Resource utilization within safe upgrade range`);
        }
      }
      if (alertList.filter(a => a.severity === "critical").length > 0) {
        readyForUpgrade = false;
        parts.push(`[CRITICAL] ${alertList.filter(a => a.severity === "critical").length} critical alert(s) active`);
      }
      parts.push("");
      parts.push(`**Overall:** ${readyForUpgrade ? "[OK] Cluster appears **ready for upgrade**" : "[WARNING] Cluster has issues that should be resolved before upgrading"}`);
      parts.push("");
      parts.push(`> This assessment is based on cached agent data. For the most accurate pre-upgrade validation, run the upgrade pre-check directly on the cluster.`);
    }
    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (i) Pod summary / workload overview / pod count / "how many pods"
  // ---------------------------------------------------------------------------
  if ((/\bpod/.test(lower) && /\blist\b|\bshow\b|\bcount\b|\bsummary\b|\bhow\s+many|\btotal\b/.test(lower)) ||
      (/\bworkload/.test(lower) && /\boverview\b|\bsummary\b|\bstatus\b|\bshow\b/.test(lower))) {
    const nsList = remoteCtx.namespaces || [];
    const podIssues = remoteCtx.podIssues || [];
    const parts = [header];
    parts.push(`### Pod & Workload Summary`);
    parts.push("");
    const totalPods = nsList.reduce((s, n) => s + (n.podCount || 0), 0);
    const totalRunning = nsList.reduce((s, n) => s + (n.running || 0), 0);
    const totalFailed = nsList.reduce((s, n) => s + (n.failed || 0), 0);
    const totalPending = nsList.reduce((s, n) => s + (n.pending || 0), 0);
    parts.push(`| Metric | Count |`);
    parts.push(`| --- | --- |`);
    parts.push(`| **Total Pods** | ${totalPods} |`);
    parts.push(`| **Running** | ${totalRunning} |`);
    parts.push(`| **Pending** | ${totalPending} |`);
    parts.push(`| **Failed** | ${totalFailed} |`);
    parts.push(`| **Problem Pods** | ${podIssues.length} |`);
    parts.push("");
    const activeNs = nsList.filter(n => (n.podCount || 0) > 0 && !n.name?.startsWith("kube-") && !n.name?.startsWith("openshift-") && n.name !== "default");
    if (activeNs.length > 0) {
      parts.push(`**Top Namespaces by Pod Count:**`);
      parts.push(`| Namespace | Pods | Running | Failed | Pending | Health |`);
      parts.push(`| --- | --- | --- | --- | --- | --- |`);
      activeNs.sort((a, b) => (b.podCount || 0) - (a.podCount || 0)).slice(0, 15).forEach(n => {
        const icon = n.health === "critical" ? "[CRITICAL]" : n.health === "pending" ? "[WARNING]" : "[OK]";
        parts.push(`| \`${n.name}\` | ${n.podCount || 0} | ${n.running || 0} | ${n.failed || 0} | ${n.pending || 0} | ${icon} ${n.health || "idle"} |`);
      });
    }
    if (podIssues.length > 0) {
      parts.push("");
      parts.push(`**Problem Pods:** ${podIssues.length} — use "show pod issues" for details`);
    }
    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (j) Diagnostics / troubleshoot / "what's happening" / summary
  // ---------------------------------------------------------------------------
  if (/\bdiag|\btroubleshoot|\bsummar|\bwhat.?s\s+happening|\boverview\b/.test(lower)) {
    const parts = [header];
    parts.push(`### Cluster Diagnostics Summary`);
    parts.push("");
    const nodes = summary.nodes || {};
    const ops = summary.operators || {};
    const podIssues = remoteCtx.podIssues || [];
    const alerts = remoteCtx.alerts || {};
    const alertList = alerts.alerts || [];
    let findings = 0;
    parts.push(`#### Health Check Results`);
    parts.push("");
    if ((nodes.ready || 0) < (nodes.total || 0)) {
      findings++;
      parts.push(`[CRITICAL] **${(nodes.total || 0) - (nodes.ready || 0)} node(s) not ready** — ${nodes.ready || 0}/${nodes.total || 0} nodes operational`);
    } else {
      parts.push(`[OK] All ${nodes.total || 0} nodes are ready`);
    }
    if (isOpenShift) {
      if ((ops.degraded || 0) > 0) {
        findings++;
        parts.push(`[CRITICAL] **${ops.degraded} operator(s) degraded** — ${ops.degradedNames?.join(", ") || "unknown"}`);
      } else {
        parts.push(`[OK] All ${ops.total || 0} operators healthy`);
      }
    }
    if (podIssues.length > 0) {
      findings++;
      const reasons = {};
      podIssues.forEach(p => (p.issues || []).forEach(i => { reasons[i.reason || "Unknown"] = (reasons[i.reason || "Unknown"] || 0) + 1; }));
      parts.push(`[WARNING] **${podIssues.length} problem pod(s)** — ${Object.entries(reasons).map(([r, c]) => r + ": " + c).join(", ")}`);
    } else {
      parts.push(`[OK] No problem pods detected`);
    }
    if (alertList.length > 0) {
      findings++;
      const critAlerts = alertList.filter(a => a.severity === "critical").length;
      parts.push(`[WARNING] **${alertList.length} active alert(s)** — ${critAlerts} critical`);
    } else {
      parts.push(`[OK] No active alerts`);
    }
    const nodeMetrics = getAgentCachedResponse(remoteCtx.clusterName, "/api/node-metrics", { skipFreshnessCheck: true }) || [];
    if (nodeMetrics.length > 0) {
      const highCpu = nodeMetrics.filter(m => m.cpuPercent > 80);
      const highMem = nodeMetrics.filter(m => m.memoryPercent > 80);
      if (highCpu.length > 0 || highMem.length > 0) {
        findings++;
        parts.push(`[WARNING] **Resource pressure** — ${highCpu.length} node(s) CPU >80%, ${highMem.length} node(s) memory >80%`);
      } else {
        parts.push(`[OK] Resource utilization within normal range`);
      }
    }
    parts.push("");
    parts.push(`**Overall Assessment:** ${findings === 0 ? "[OK] Cluster is healthy — no issues detected" : `[WARNING] ${findings} issue(s) require attention`}`);
    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (k) Security / compliance posture
  // ---------------------------------------------------------------------------
  if (/\bsecurity\b|\bcompliance\b|\bcis\b|\bhardening\b|\bprivileged\b|\bvulnerab/.test(lower)) {
    const sec = remoteCtx.security;
    const iv = remoteCtx.imageVulns;
    const parts = [header];
    parts.push(`### Security Posture`);
    parts.push("");
    if (sec && sec.available !== false) {
      parts.push(`**Security Score:** ${sec.score}/100 (Grade ${sec.grade})`);
      parts.push("");
      parts.push(`| Check | Count |`);
      parts.push(`| --- | --- |`);
      parts.push(`| Workload pods analyzed | ${sec.podCount || 0} |`);
      (sec.findings || []).forEach(f => {
        const icon = f.severity === "critical" ? "[CRITICAL]" : f.severity === "warning" ? "[WARNING]" : "[INFO]";
        parts.push(`| ${icon} ${f.msg} | — |`);
      });
      parts.push("");
    } else {
      parts.push(`> Security scan data is not available from this cluster's agent yet.`);
      parts.push("");
    }
    if (iv && iv.installed) {
      parts.push(`**Image Vulnerabilities** (scanner: ${iv.scannerType}):`);
      parts.push(`  ${iv.critical} critical | ${iv.high} high | ${iv.medium} medium | ${iv.low} low across ${iv.totalImages} images`);
    } else {
      parts.push(`**Image Vulnerabilities:** No scanner (Trivy/Quay) detected on this cluster.`);
    }
    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (l) GitOps / ArgoCD
  // ---------------------------------------------------------------------------
  if (/\bgitops\b|\bargo\b|\bargocd\b|\bsync\b.*\bapp|\bapplication.*\bsync/.test(lower)) {
    const g = remoteCtx.gitops;
    const parts = [header];
    parts.push(`### GitOps Status`);
    parts.push("");
    if (!g || g.available === false || g.unavailable) {
      parts.push(`> ArgoCD / OpenShift GitOps is not installed on this cluster.`);
      return parts.join("\n");
    }
    parts.push(`**Applications:** ${g.total} total | ${g.synced} synced | ${g.outOfSync} out-of-sync | ${g.healthy} healthy | ${g.degraded} degraded`);
    parts.push("");
    if ((g.apps || []).length > 0) {
      parts.push(`| Application | Sync | Health | Repo |`);
      parts.push(`| --- | --- | --- | --- |`);
      g.apps.forEach(a => {
        const syncIcon = a.sync === "Synced" ? "[OK]" : "[WARNING]";
        parts.push(`| \`${a.name}\` | ${syncIcon} ${a.sync} | ${a.health} | ${(a.repo || "—").replace(/\|/g, "/")} |`);
      });
    }
    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (m) Disaster Recovery / backups / Velero
  // ---------------------------------------------------------------------------
  if (/\bbackup\b|\bvelero\b|\bdisaster\b|\brecovery\b|\bdr\b|\boadp\b|\brestore\b/.test(lower)) {
    const dr = remoteCtx.dr;
    const parts = [header];
    parts.push(`### Disaster Recovery`);
    parts.push("");
    if (!dr || dr.available === false || !dr.installed) {
      parts.push(`> Velero / OADP backup tooling is not installed on this cluster.`);
      return parts.join("\n");
    }
    parts.push(`**DR Readiness:** ${dr.score}/100 (Grade ${dr.grade})`);
    parts.push("");
    parts.push(`| Metric | Value |`);
    parts.push(`| --- | --- |`);
    parts.push(`| Total backups | ${dr.backups} |`);
    parts.push(`| Completed | ${dr.completed} |`);
    parts.push(`| Failed | ${dr.failed} |`);
    parts.push(`| Schedules | ${dr.schedules} |`);
    parts.push(`| Last backup | ${dr.lastBackupAge != null ? dr.lastBackupAge + " day(s) ago" : "Never"} |`);
    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (n) Workloads / deployments / services
  // ---------------------------------------------------------------------------
  if (/\bdeployment\b|\bworkload\b|\bservice\b|\bstatefulset\b|\bdaemonset\b|\bingress\b|\broute\b/.test(lower) &&
      /\blist\b|\bshow\b|\bhow\s+many|\bcount\b|\ball\b/.test(lower)) {
    const w = remoteCtx.workloads;
    const parts = [header];
    parts.push(`### Workloads`);
    parts.push("");
    if (!w || w.available === false) {
      parts.push(`> Workload inventory is not available from this cluster's agent yet.`);
      return parts.join("\n");
    }
    parts.push(`| Type | Count |`);
    parts.push(`| --- | --- |`);
    parts.push(`| Deployments | ${w.deployments || 0} |`);
    parts.push(`| StatefulSets | ${w.statefulsets || 0} |`);
    parts.push(`| DaemonSets | ${w.daemonsets || 0} |`);
    parts.push(`| Services | ${w.services || 0} |`);
    parts.push(`| Ingresses | ${w.ingresses || 0} |`);
    if (w.routes) parts.push(`| Routes | ${w.routes} |`);
    parts.push("");
    const notReady = (w.items || []).filter(d => d.ready < d.desired);
    if (notReady.length > 0) {
      parts.push(`**Deployments not fully available (${notReady.length}):**`);
      parts.push(`| Deployment | Namespace | Ready |`);
      parts.push(`| --- | --- | --- |`);
      notReady.slice(0, 15).forEach(d => parts.push(`| \`${d.name}\` | ${d.namespace} | ${d.ready}/${d.desired} |`));
    } else if ((w.items || []).length > 0) {
      parts.push(`[OK] All deployments are fully available.`);
    }
    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (o) Optimization / cost / resource waste
  // ---------------------------------------------------------------------------
  if (/\boptimi|\bcost\b|\bwaste\b|\bright.?siz|\befficien|\bover.?provision|\bunder.?provision|\breclaim/.test(lower)) {
    const opt = remoteCtx.optimization;
    const parts = [header];
    parts.push(`### Resource Optimization`);
    parts.push("");
    if (!opt || opt.available === false) {
      parts.push(`> Optimization data is not available from this cluster's agent yet (metrics-server may be missing).`);
      return parts.join("\n");
    }
    parts.push(`**Efficiency Score:** ${opt.efficiencyScore}/100 (Grade ${opt.grade})`);
    parts.push("");
    parts.push(`| Metric | Value |`);
    parts.push(`| --- | --- |`);
    parts.push(`| Workloads analyzed | ${opt.totalPods} |`);
    parts.push(`| Over-provisioned | ${opt.overProvisioned} |`);
    parts.push(`| Under-provisioned | ${opt.underProvisioned} |`);
    parts.push(`| Without limits | ${opt.noLimits} |`);
    parts.push(`| Reclaimable CPU | ${opt.reclaimCpu}m |`);
    parts.push(`| Reclaimable memory | ${opt.reclaimMemGi}Gi |`);
    parts.push(`| CPU headroom | ${opt.cpuHeadroom}% |`);
    parts.push(`| Memory headroom | ${opt.memHeadroom}% |`);
    parts.push("");
    if ((opt.topProblems || []).length > 0) {
      parts.push(`**Top offenders:**`);
      parts.push(`| Pod | Namespace | Type | Detail |`);
      parts.push(`| --- | --- | --- | --- |`);
      opt.topProblems.slice(0, 10).forEach(p => parts.push(`| \`${p.name}\` | ${p.ns} | ${p.type} | ${p.detail || "—"} |`));
    }
    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // (p) Unrecognized query — if an LLM is active, let it handle the query
  //     with cached context.  Otherwise, return a cluster overview so the
  //     user doesn't get an unhelpful "I don't understand" response.
  // ---------------------------------------------------------------------------
  if (opts.llmAvailable) return null;

  const parts = [header];
  parts.push(`### Cluster: ${remoteCtx.clusterName}`);
  parts.push("");

  // Quick status
  const _fNodes = summary.nodes || {};
  const _fOps = summary.operators || {};
  const _fNs = summary.namespaces || {};
  const _fNsLabel = isOpenShift ? "projects" : "namespaces";
  const _fHealthIcon = clusterHealth === "healthy" ? "Healthy" : clusterHealth === "warning" || clusterHealth === "degraded" ? "Warning" : "Critical";

  parts.push(`| Property | Value |`);
  parts.push(`| --- | --- |`);
  parts.push(`| **Platform** | ${platform} |`);
  parts.push(`| **${versionLabel}** | ${clusterVersion} |`);
  parts.push(`| **Health** | ${_fHealthIcon} |`);
  parts.push(`| **Nodes** | ${_fNodes.ready || 0}/${_fNodes.total || 0} ready |`);
  if (isOpenShift) parts.push(`| **Operators** | ${_fOps.healthy || 0}/${_fOps.total || 0} healthy |`);
  parts.push(`| **${isOpenShift ? "Projects" : "Namespaces"}** | ${_fNs.total || 0} (${_fNs.user || 0} user, ${_fNs.system || 0} system) |`);
  parts.push("");

  // Pod issues
  const _fPodIssues = remoteCtx.podIssues || [];
  if (_fPodIssues.length > 0) {
    parts.push(`**Pod Issues:** ${_fPodIssues.length} problem pod(s) detected`);
  } else {
    parts.push(`**Pod Issues:** None — all pods healthy`);
  }
  parts.push("");

  parts.push(`You can ask me about this cluster. Try:`);
  parts.push(`- \`check cluster health\` — full status overview`);
  parts.push(`- \`show nodes\` — node health details`);
  parts.push(`- \`show node metrics\` — CPU & memory utilization`);
  parts.push(`- \`show pods\` — workload overview by namespace`);
  parts.push(`- \`list namespaces\` — ${_fNsLabel} and pod counts`);
  parts.push(`- \`show pod issues\` — problem pods`);
  if (isOpenShift) parts.push(`- \`show operators\` — operator status`);
  parts.push(`- \`show events\` — alerts and warnings`);
  parts.push(`- \`security posture\` — compliance & vulnerabilities`);
  parts.push(`- \`gitops status\` — ArgoCD application sync`);
  parts.push(`- \`backup status\` — disaster recovery readiness`);
  parts.push(`- \`optimization\` — resource waste & right-sizing`);
  parts.push(`- \`list deployments\` — workload inventory`);
  parts.push(`- \`diagnostics\` — full cluster health check`);
  parts.push(`- \`upgrade precheck\` — pre-flight readiness`);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Live remote-cluster query via the agent SSE bridge.
//
// When the user selects a remote cluster that has an ACTIVE bridge channel,
// we can run real-time K8s queries on it — same data the hub gets for itself.
// This gives feature parity for namespace-specific pod listings, deployments,
// replica counts, services, logs, etc. — without needing the LLM.
//
// Returns a formatted markdown string, or null to fall through to the
// cache-based handler / LLM path.
// ---------------------------------------------------------------------------
async function handleRemoteLiveQuery(message, parsed, remoteCtx) {
  if (!remoteCtx) return null;
  const cluster = remoteCtx.clusterName;
  // Only use the live path when the agent bridge is connected.
  if (!hasActiveChannel || !hasActiveChannel(cluster)) return null;

  const lower = message.toLowerCase();
  const summary = remoteCtx.summary || {};
  const isOpenShift = summary.isOpenShift || false;
  const platform = summary.platform || (isOpenShift ? "OpenShift" : "Kubernetes");
  const healthEmoji = (summary.cluster?.health || "").toLowerCase() === "healthy" ? "[OK]" : "[WARNING]";
  const header = `> ${healthEmoji} **${cluster}** | ${platform} ${summary.cluster?.version || ""} | live\n`;

  // Extract namespace: explicit parsed field, or "in/under/from/namespace X" patterns
  let ns = parsed?.namespace || null;
  if (!ns) {
    const m = lower.match(/(?:\bin\b|\bunder\b|\bfrom\b|\bns\b|\bnamespace\b|\bproject\b)\s+["'`]?([a-z0-9][-a-z0-9.]{0,61}[a-z0-9])["'`]?/);
    if (m) ns = m[1];
  }
  // Guard: don't treat common words as a namespace
  if (ns && /^(the|all|this|cluster|status|health|each|every|any)$/.test(ns)) ns = null;

  // Map a resource keyword in the message to an agent list_resources kind.
  const RESOURCE_KEYWORDS = [
    { re: /\bpods?\b/, kind: "pods", label: "Pods" },
    { re: /\bdeployments?\b|\bdeploys?\b/, kind: "deployments", label: "Deployments" },
    { re: /\bstatefulsets?\b|\bsts\b/, kind: "statefulsets", label: "StatefulSets" },
    { re: /\bdaemonsets?\b|\bds\b/, kind: "daemonsets", label: "DaemonSets" },
    { re: /\breplicasets?\b|\brs\b/, kind: "replicasets", label: "ReplicaSets" },
    { re: /\bservices?\b|\bsvc\b/, kind: "services", label: "Services" },
    { re: /\bingress(?:es)?\b/, kind: "ingresses", label: "Ingresses" },
    { re: /\broutes?\b/, kind: "routes", label: "Routes" },
    { re: /\bconfigmaps?\b|\bcm\b/, kind: "configmaps", label: "ConfigMaps" },
    { re: /\bpvcs?\b|\bpersistentvolumeclaims?\b/, kind: "persistentvolumeclaims", label: "PVCs" },
    { re: /\bjobs?\b/, kind: "jobs", label: "Jobs" },
    { re: /\bcronjobs?\b/, kind: "cronjobs", label: "CronJobs" },
    { re: /\bsecrets?\b/, kind: "secrets", label: "Secrets" },
    { re: /\bserviceaccounts?\b|\bsa\b/, kind: "serviceaccounts", label: "ServiceAccounts" },
  ];

  const isListIntent = /\blist\b|\bshow\b|\bget\b|\bhow\s+many\b|\bcount\b|\ball\b|\brunning\b|\bdisplay\b|\bwhat\b/.test(lower)
    || parsed?.intent === "list" || parsed?.operation === "list";

  // ---- Pod logs (live only) ----
  if (/\blogs?\b/.test(lower) && parsed?.name) {
    try {
      const r = await invokeAgentTool(cluster, "get_logs", { name: parsed.name, namespace: ns || "default", tail: 100 }, 15000);
      if (r?.success && r.data?.logs != null) {
        const logs = String(r.data.logs).slice(-6000);
        return `${header}\n### Logs: \`${parsed.name}\`${ns ? " (" + ns + ")" : ""}\n\n\`\`\`\n${logs || "(no output)"}\n\`\`\``;
      }
    } catch { /* fall through */ }
  }

  // ---- Pods (namespace-specific or named) ----
  if (/\bpods?\b/.test(lower) && (isListIntent || ns || parsed?.name)) {
    try {
      const r = await invokeAgentTool(cluster, "get_pods", ns ? { namespace: ns } : {}, 15000);
      if (r?.success && r.data) {
        const d = r.data;
        const parts = [header];
        parts.push(`### Pods${ns ? " in `" + ns + "`" : " (cluster-wide)"}`);
        parts.push("");
        parts.push(`| Metric | Count |`);
        parts.push(`| --- | --- |`);
        parts.push(`| **Total** | ${d.total || 0} |`);
        parts.push(`| **Running** | ${d.running || 0} |`);
        parts.push(`| **Pending** | ${d.pending || 0} |`);
        parts.push(`| **Failed** | ${d.failed || 0} |`);
        parts.push("");
        const probs = d.items || [];
        if (probs.length > 0) {
          parts.push(`**Non-running / problem pods (${probs.length}):**`);
          parts.push(`| Pod | Phase | Restarts | Node | State |`);
          parts.push(`| --- | --- | --- | --- | --- |`);
          probs.slice(0, 25).forEach(p => {
            const st = (p.containers || []).map(c => c.state).filter(s => s && s !== "Running").join(", ") || p.phase;
            parts.push(`| \`${p.name}\` | ${p.phase || "—"} | ${p.restarts || 0} | ${p.node || "—"} | ${st || "—"} |`);
          });
        } else {
          parts.push(`[OK] All ${d.running || 0} pod(s)${ns ? " in this namespace" : ""} are Running.`);
        }
        return parts.join("\n");
      }
    } catch { /* fall through */ }
  }

  // ---- Generic resource listing (deployments, services, replicas, etc.) ----
  const kindMatch = RESOURCE_KEYWORDS.find(k => k.re.test(lower) && k.kind !== "pods");
  if (kindMatch && (isListIntent || ns)) {
    try {
      const r = await invokeAgentTool(cluster, "list_resources", ns ? { kind: kindMatch.kind, namespace: ns } : { kind: kindMatch.kind }, 15000);
      if (r?.success && Array.isArray(r.data)) {
        const items = r.data;
        const parts = [header];
        parts.push(`### ${kindMatch.label}${ns ? " in `" + ns + "`" : " (cluster-wide)"} — ${items.length} total`);
        parts.push("");
        if (items.length === 0) {
          parts.push(`No ${kindMatch.label.toLowerCase()} found${ns ? " in namespace `" + ns + "`" : ""}.`);
          return parts.join("\n");
        }
        // For deployments/statefulsets, fetch replica detail via describe for the first few
        if (kindMatch.kind === "deployments" || kindMatch.kind === "statefulsets") {
          parts.push(`| Name | Namespace | Replicas (ready/desired) |`);
          parts.push(`| --- | --- | --- |`);
          const top = items.slice(0, 25);
          const details = await Promise.all(top.map(it =>
            invokeAgentTool(cluster, "describe_resource", { kind: kindMatch.kind, name: it.name, namespace: it.namespace }, 10000)
              .then(dr => ({ it, dr })).catch(() => ({ it, dr: null }))
          ));
          details.forEach(({ it, dr }) => {
            const spec = dr?.success ? dr.data : null;
            const desired = spec?.spec?.replicas ?? "—";
            const ready = spec?.status?.readyReplicas ?? 0;
            const icon = (spec && ready >= (spec.spec?.replicas || 0)) ? "[OK]" : "[WARNING]";
            parts.push(`| \`${it.name}\` | ${it.namespace || "—"} | ${icon} ${ready}/${desired} |`);
          });
        } else {
          parts.push(`| Name | Namespace | Age |`);
          parts.push(`| --- | --- | --- |`);
          items.slice(0, 40).forEach(it => {
            const age = it.created ? _ageFromTimestamp(it.created) : "—";
            parts.push(`| \`${it.name}\` | ${it.namespace || "—"} | ${age} |`);
          });
          if (items.length > 40) parts.push(`\n_…and ${items.length - 40} more._`);
        }
        return parts.join("\n");
      }
    } catch { /* fall through */ }
  }

  // ---- Describe a specific named resource (replicas, details) ----
  if (parsed?.name && parsed?.resource) {
    const kindEntry = RESOURCE_KEYWORDS.find(k => k.re.test(parsed.resource.toLowerCase()));
    if (kindEntry) {
      try {
        const r = await invokeAgentTool(cluster, "describe_resource", { kind: kindEntry.kind, name: parsed.name, namespace: ns || undefined }, 12000);
        if (r?.success && r.data) {
          const obj = r.data;
          const parts = [header];
          parts.push(`### ${kindEntry.label.replace(/s$/, "")}: \`${parsed.name}\``);
          parts.push("");
          parts.push(`| Field | Value |`);
          parts.push(`| --- | --- |`);
          parts.push(`| Namespace | ${obj.metadata?.namespace || "—"} |`);
          if (obj.spec?.replicas != null) {
            parts.push(`| Desired replicas | ${obj.spec.replicas} |`);
            parts.push(`| Ready replicas | ${obj.status?.readyReplicas || 0} |`);
            parts.push(`| Available replicas | ${obj.status?.availableReplicas || 0} |`);
          }
          if (obj.status?.phase) parts.push(`| Phase | ${obj.status.phase} |`);
          parts.push(`| Created | ${obj.metadata?.creationTimestamp ? _ageFromTimestamp(obj.metadata.creationTimestamp) : "—"} |`);
          return parts.join("\n");
        }
      } catch { /* fall through */ }
    }
  }

  return null;
}

function _ageFromTimestamp(ts) {
  const age = (Date.now() - new Date(ts).getTime()) / 1000;
  if (age < 60) return Math.floor(age) + "s";
  if (age < 3600) return Math.floor(age / 60) + "m";
  if (age < 86400) return Math.floor(age / 3600) + "h";
  return Math.floor(age / 86400) + "d";
}

// ---------------------------------------------------------------------------
// Live remote-cluster MUTATIONS via the agent bridge.
//
// Maps scale / restart / delete / cordon intents to the agent's write tools.
// Writes are double-gated: the agent must have ALLOW_REMOTE_ACTIONS=true AND
// the scoped write RBAC. If not, the agent returns a clear error which we
// surface with remediation guidance. Every executed action is audit-logged.
//
// Returns formatted markdown, or null to fall through.
// ---------------------------------------------------------------------------
async function handleRemoteMutation(message, parsed, remoteCtx, opts = {}) {
  if (!remoteCtx) return null;
  const cluster = remoteCtx.clusterName;
  if (!hasActiveChannel || !hasActiveChannel(cluster)) return null;

  const lower = message.toLowerCase();
  const summary = remoteCtx.summary || {};
  const platform = summary.platform || (summary.isOpenShift ? "OpenShift" : "Kubernetes");
  const header = `> [ACTION] **${cluster}** | ${platform} ${summary.cluster?.version || ""} | live\n`;

  // Namespace extraction (shared with read path semantics)
  let ns = parsed?.namespace || null;
  if (!ns) {
    const m = lower.match(/(?:\bin\b|\bunder\b|\bfrom\b|\bns\b|\bnamespace\b|\bproject\b)\s+["'`]?([a-z0-9][-a-z0-9.]{0,61}[a-z0-9])["'`]?/);
    if (m) ns = m[1];
  }
  if (ns && /^(the|all|this|cluster|status|health)$/.test(ns)) ns = null;

  // Resource name — prefer parsed, else a dns-like token
  const name = parsed?.name || (message.match(/\b([a-z][-a-z0-9]*(?:-[a-z0-9]{3,12}){0,2})\b/i) || [])[1] || null;

  const kindWord = /\bstatefulset|\bsts\b/.test(lower) ? "statefulset"
    : /\bdaemonset|\bds\b/.test(lower) ? "daemonset" : "deployment";

  const auditLog = (action, detail) => {
    console.error(`[audit] remote-action cluster=${cluster} user=${opts.userId || "?"} action=${action} ${detail}`);
  };

  const notEnabledMsg = (errText) => {
    const parts = [header];
    parts.push(`### Remote Action Blocked`);
    parts.push("");
    parts.push(`[WARNING] ${errText || "Remote actions are disabled on this cluster."}`);
    parts.push("");
    parts.push(`To enable write actions on **${cluster}**:`);
    parts.push(`1. In **AI Hub → cluster card → Edit/Connect**, turn on **Allow remote actions**, OR regenerate the agent YAML with actions enabled.`);
    parts.push(`2. Re-apply the YAML (adds scoped write RBAC + \`ALLOW_REMOTE_ACTIONS=true\`).`);
    parts.push(`3. Click **Sync RBAC** then **Redeploy Agent** on the cluster card.`);
    return parts.join("\n");
  };

  const runTool = async (tool, args, successFmt) => {
    try {
      const r = await invokeAgentTool(cluster, tool, args, 20000);
      if (r?.success) {
        auditLog(tool, JSON.stringify(args));
        return `${header}\n${successFmt(r.data)}`;
      }
      if (/disabled|forbidden|403/i.test(r?.error || "")) return notEnabledMsg(r.error);
      return `${header}\n### Action Failed\n\n[CRITICAL] ${r?.error || "Unknown error"}`;
    } catch (err) {
      if (/disabled|forbidden|403/i.test(err.message)) return notEnabledMsg(err.message);
      return `${header}\n### Action Failed\n\n[CRITICAL] ${err.message}`;
    }
  };

  // ---- CLUSTER UPGRADE (OpenShift) — change-controlled, confirmation-gated ----
  if (/\bupgrade\b/.test(lower) && !/\bprecheck|pre-?check|pre-?flight|assessment|readiness|status\b/.test(lower)) {
    if (!summary.isOpenShift) {
      return `${header}\n### Cluster Upgrade\n\n> Chat-driven cluster upgrades are supported for OpenShift clusters only.`;
    }
    const vMatch = lower.match(/\bto\s+v?(\d+\.\d+\.\d+)/) || lower.match(/\bv?(\d+\.\d+\.\d+)\b/);
    const version = vMatch ? vMatch[1] : null;
    if (!version) {
      return `${header}\n### Cluster Upgrade\n\n[WARNING] Specify a target version.\n\n**Workflow (same as hub):**\n1. \`precheck upgrade to <version>\` — 22-point assessment\n2. \`raise change request for upgrade to <version>\` — ITSM CR\n3. \`upgrade ${cluster} to <version> --confirm\` — execute`;
    }
    const confirmed = /--confirm|\bconfirm\b|\bproceed\b|\bapprove\b/.test(lower);
    const force = /\bforce\b/.test(lower);
    if (!confirmed) {
      return [
        header,
        `### Confirm Cluster Upgrade — ${cluster} → ${version}`,
        ``,
        `[WARNING] This is a **production-impacting** change. Follow the change-controlled workflow:`,
        ``,
        `1. **Preflight:** \`precheck upgrade to ${version}\` — run the 22-point readiness assessment`,
        `2. **Change Request:** \`raise change request for upgrade to ${version}\` — creates the ServiceNow CR with the preflight report attached`,
        `3. **Execute:** repeat this command with confirmation:`,
        `   > \`upgrade ${cluster} to ${version} --confirm\``,
        ``,
        `The upgrade runs via the agent (ClusterVersion desiredUpdate) and requires remote actions to be enabled on this cluster.`,
      ].join("\n");
    }
    return runTool("upgrade_cluster", { version, force }, (d) =>
      `### Upgrade Initiated\n\n[OK] **${cluster}** is upgrading to **${d.version}**.${d.image ? `\n\nRelease image: \`${d.image}\`` : ""}\n\nMonitor progress with \`cluster upgrade status\` or \`oc get clusterversion\`.`);
  }

  // ---- SCALE ----
  const scaleMatch = lower.match(/\bscale\b/) && (lower.match(/\bto\s+(\d+)\b/) || lower.match(/\breplicas?\s*=?\s*(\d+)\b/) || lower.match(/\b(\d+)\s+replicas?\b/));
  if (lower.match(/\bscale\b/) && scaleMatch) {
    const replicas = parseInt(scaleMatch[1], 10);
    if (!name || !ns) return `${header}\n### Scale Workload\n\n[WARNING] Specify name and namespace.\n\n**Example:** \`scale deployment my-app to 3 in my-ns\``;
    return runTool("scale_workload", { kind: kindWord, name, namespace: ns, replicas }, (d) =>
      `### Workload Scaled\n\n[OK] \`${d.name}\` (${d.kind}) in \`${d.namespace}\` scaled to **${d.replicas}** replica(s).`);
  }

  // ---- RESTART (rollout restart) ----
  if (/\brestart\b|\broll(?:ing)?\s*restart\b|\bredeploy\b/.test(lower) && /\bdeployment|\bstatefulset|\bdaemonset|\bworkload\b/.test(lower)) {
    if (!name || !ns) return `${header}\n### Restart Workload\n\n[WARNING] Specify name and namespace.\n\n**Example:** \`restart deployment my-app in my-ns\``;
    return runTool("restart_workload", { kind: kindWord, name, namespace: ns }, (d) =>
      `### Rollout Restart Triggered\n\n[OK] \`${d.name}\` (${d.kind}) in \`${d.namespace}\` is rolling out a restart.`);
  }

  // ---- DELETE POD ----
  if (/\b(delete|remove|kill|restart)\b/.test(lower) && /\bpod\b/.test(lower)) {
    if (!name || !ns) return `${header}\n### Delete Pod\n\n[WARNING] Specify pod name and namespace.\n\n**Example:** \`delete pod my-pod-abc123 in my-ns\``;
    return runTool("delete_pod", { name, namespace: ns }, (d) =>
      `### Pod Deleted\n\n[OK] Pod \`${d.name}\` in \`${d.namespace}\` deleted. Its controller will recreate it if managed.`);
  }

  // ---- CORDON / UNCORDON ----
  if (/\bcordon\b/.test(lower) && /\bnode\b/.test(lower)) {
    const uncordon = /\buncordon\b/.test(lower);
    const nodeName = parsed?.name || (message.match(/\bnode\s+["'`]?([a-z0-9][-a-z0-9.]+)["'`]?/i) || [])[1] || name;
    if (!nodeName) return `${header}\n### ${uncordon ? "Uncordon" : "Cordon"} Node\n\n[WARNING] Specify a node name.`;
    return runTool("cordon_node", { name: nodeName, uncordon }, (d) =>
      `### Node ${uncordon ? "Uncordoned" : "Cordoned"}\n\n[OK] Node \`${d.name}\` ${uncordon ? "is schedulable again" : "marked unschedulable"}.`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Gather cluster context based on user query
// ---------------------------------------------------------------------------
async function gatherClusterContext(userMessage, nluParsed = null, remoteCache = null) {
  // If remote cluster context is provided via agent cache, build a context
  // from it instead of calling ocpGet (which only reaches the local cluster).
  if (remoteCache) {
    return buildContextFromAgentCache(remoteCache, userMessage);
  }
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

  // Intent: nodes — only when user is asking about nodes/workers/control-plane,
  // not when "master" appears as part of a resource name (e.g. "queue-master")
  if (lower.match(/\bnode\b|\bnodes\b|control.?plane/) ||
      (lower.match(/\bworker\b/) && !context.targetResourceName?.includes("worker")) ||
      (lower.match(/\bmaster\b/) && !context.targetResourceName?.includes("master") && !lower.match(/[a-z0-9]-master/))) {
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

  // Intent: resource metrics / CPU / memory usage
  if (lower.match(/\bcpu\b|\bmemory\b|\bmem\b|\bram\b|\busage\b|\bmetrics?\b|\btop\b|\bresource\s+usage|\bhigh\s+(cpu|mem|resource)|\b(cpu|mem).*high\b|\bconsumption/)) {
    context.intents.push("metrics");
  }

  // Intent: deployments
  if (lower.match(/deploy|scale|replica|rollout|redeploy/)) {
    context.intents.push("deployments");
  }

  // Intent: events / alerts
  if (lower.match(/event|alert|warn/)) {
    context.intents.push("events");
  }

  // Intent: RBAC / access / permissions
  if (lower.match(/\brbac\b|\baccess\b|\bpermission|\bwho\s+(has|can|is)\b|\bwho-can\b|\brole\s*bind|\bcluster.?admin/)) {
    context.intents.push("rbac");
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

  // Intent: certificate expiry / TLS / CSR
  if (lower.match(/\bcertif|\btls\b|\bcsr\b|\bexpir.*cert|cert.*expir|\brotate.*cert|cert.*rotat|\bcert.*renew|renew.*cert/)) {
    context.intents.push("certificate_expiry");
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
  if (lower.match(/diagnos|troubleshoot|debug|investig|analyz|analyse|check|why/)) {
    if (context.intents.includes("specific_pod")) {
      // User wants to analyse a specific pod — add pod_issues to fetch
      // supporting data but NOT cluster_health (which floods the context
      // with unrelated pods and confuses the LLM).
      if (!context.intents.includes("pod_issues")) {
        context.intents.push("pod_issues");
      }
    } else if (context.targetResourceType === "deployment" && context.targetResourceName) {
      // User asks about a specific deployment (e.g. "why deployment X is 0/0")
      // — focused deployment data is already gathered separately, fetch nodes
      // for scheduling context but skip full cluster_health to avoid noise.
      if (!context.intents.includes("nodes")) {
        context.intents.push("nodes");
      }
    } else if (context.intents.includes("certificate_expiry") || context.intents.includes("cluster_upgrade")) {
      // Infrastructure-specific questions — don't flood with cluster_health
      // data; the specific intent handler already fetches targeted data.
    } else if (!context.intents.includes("pod_issues") && !context.intents.includes("nodes")) {
      context.intents.push("cluster_health");
    }
  }

  // Intent: alerts / alertmanager / prometheus
  if (lower.match(/\balert|\bfiring|\bsilence|\bprometheus|\balertmanager/)) {
    context.intents.push("alerts");
  }

  // Intent: GitOps / ArgoCD / sync / drift
  if (lower.match(/\bgitops|\bargocd|\bargo\b|\bsync\b|\bdrift\b|\bout.of.sync|\breconcil/)) {
    context.intents.push("gitops");
  }

  // Intent: image scanning / CVE / vulnerability
  if (lower.match(/\bcve|\bvulnerab|\bimage.scan|\bscan.*image|\btrivy|\bclair|\bstackrox|\bacs\b/)) {
    context.intents.push("imagescan");
  }

  // Intent: backup / DR / velero / etcd backup
  if (lower.match(/\bbackup|\bvelero|\brestore|\bdisaster.recov|\betcd.backup|\boadp\b/)) {
    context.intents.push("backup");
  }

  // Intent: must-gather / diagnostics / sosreport
  if (lower.match(/\bmust.gather|\bsosreport|\bdiagnostic.collect|\bcollect.diagnostic|\bgather.diagnostic|\bcluster.diagnostic|\bdiagnostic.report/)) {
    context.intents.push("mustgather");
  }

  // Intent: fleet / multi-cluster / ACM
  if (lower.match(/\bfleet|\bmanaged.cluster|\bacm\b|\badvanced.cluster|\bmulti.cluster/)) {
    context.intents.push("fleet");
  }

  // Intent: compliance / governance / policy violations
  if (lower.match(/\bcomplian|\bgovernance|\bpolicy.violat|\bnon.compliant|\baudit.log/)) {
    context.intents.push("compliance");
  }

  // Intent: automation / ansible / playbook / ServiceNow
  if (lower.match(/\bansible|\bplaybook|\bautomation|\bservicenow|\bjob.template|\baap\b/)) {
    context.intents.push("automation");
  }

  // Intent: right-sizing / optimization / overprovisioned
  if (lower.match(/\bright.siz|\boptimiz|\boverprovision|\bunderutiliz|\bidle.workload|\bwasted?\b|\bresource.efficien/)) {
    context.intents.push("optimize");
  }

  // Intent: network diagnostics / egress / DNS / connectivity
  if (lower.match(/\begress|\bdns\b|\blatency|\bthroughput|\bbottleneck|\bconnectiv|\bnetwork.diag|\bovn\b|\bsdn\b/)) {
    context.intents.push("network");
  }

  // Intent: identity / OAuth / LDAP / token
  if (lower.match(/\boauth|\bldap\b|\bidentity.provider|\btoken.expir|\bwho.has.access/)) {
    context.intents.push("identity");
  }

  // Intent: cert lifecycle / rotation / mTLS
  if (lower.match(/\brotate.*cert|\bcert.*rotat|\bmtls\b|\bcert.*renew|\bca.trust|\bcert.lifecycle/)) {
    context.intents.push("certlife");
  }

  // Intent: SLO / SLI / error budget
  if (lower.match(/\bslo\b|\bsli\b|\bsla\b|\berror.budget|\bburn.rate|\bavailability.target|\bservice.level/)) {
    context.intents.push("slo");
  }

  // Intent: resource saturation / pressure / throttling
  if (lower.match(/\bsaturation|\bpressure|\bthrottl|\bbottleneck|\bresource.exhaust|\bpacking/)) {
    context.intents.push("saturation");
  }

  // Intent: incident / active incidents
  // Strip hyphenated compound words (namespace names like "snow-incident-resolution")
  // so they don't false-positive on ITSM keywords.
  const lowerStripped = lower.replace(/[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*/g, "___");
  if (lowerStripped.match(/\bincident|\boutage|\bsev.?[12]\b|\bseverity|\bactive.incident|\bdowntime/)) {
    context.intents.push("incident");
  }

  // Intent: postmortem / post-incident / timeline
  if (lower.match(/\bpostmortem|\bpost.mortem|\btimeline|\broot.cause.analys|\bincident.review/)) {
    context.intents.push("postmortem");
  }

  // Intent: blast radius / impact analysis
  if (lower.match(/\bblast.radius|\bimpact.analys|\baffected|\bimpact.assess|\bfailure.domain/)) {
    context.intents.push("impact");
  }

  // Intent: deprecated APIs / API lifecycle
  if (lower.match(/\bdeprecat|\bapi.?request.?count|\bremoved.?api|\bapi.lifecycle|\bapi.compat/)) {
    context.intents.push("deprecated");
  }

  // Intent: admission webhooks
  if (lower.match(/\bwebhook|\badmission|\bvalidat.*webhook|\bmutat.*webhook/)) {
    context.intents.push("webhook");
  }

  // Intent: supply chain security / SBOM / signing
  if (lower.match(/\bsbom|\bprovenance|\bcosign|\bsigstore|\bsupply.chain|\bimage.sign|\bunsigned/)) {
    context.intents.push("supplychain");
  }

  // Intent: stale/outdated images
  if (lower.match(/\bstale.image|\boutdated.image|\bimage.age|\bold.image|\bimage.fresh/)) {
    context.intents.push("imagestale");
  }

  // Intent: CIS benchmarks / hardening
  if (lower.match(/\bcis.bench|\bhardening|\bsecurity.bench|\bkube.bench|\bcompliance.scan|\bstig\b/)) {
    context.intents.push("hardening");
  }

  // Intent: pod security admission / PSA / pod security standards
  if (lower.match(/\bpsa\b|\bpod.security.admis|\bpod.security.stand|\brestricted.profile|\bbaseline.profile/)) {
    context.intents.push("podsecurity");
  }

  // Intent: capacity planning / runway / headroom
  if (lower.match(/\bcapacity.plan|\brunway|\bheadroom|\bexhaustion|\bpacking.dens|\bcapacity.forecast/)) {
    context.intents.push("capacity");
  }

  // Intent: MachineConfigPool drift / rendering
  if (lower.match(/\bmachineconfig.?pool|\bmcp.drift|\bmc.render|\bmachine.config.drift/)) {
    context.intents.push("mcpdrift");
  }

  // Intent: PDB / disruption budget / eviction
  if (lower.match(/\bpdb\b|\bpod.disruption|\bdisruption.budget|\beviction|\bdrain.block/)) {
    context.intents.push("pdb");
  }

  // Intent: topology / affinity / spread constraints
  if (lower.match(/\btopology.spread|\baffinity|\banti.affinity|\bzone.spread|\bscheduling.constraint|\bpod.spread/)) {
    context.intents.push("topology");
  }

  // Intent: probes / liveness / readiness / startup
  if (lower.match(/\bhealth.probe|\bliveness.probe|\breadiness.probe|\bstartup.probe|\bprobe.config|\bmissing.probe/)) {
    context.intents.push("probes");
  }

  // Intent: HPA / autoscaler
  if (lower.match(/\bhpa\b|\bhorizontal.pod.auto|\bautoscal|\bscale.up|\bscale.down|\bscaling.policy/)) {
    context.intents.push("hpa");
  }

  // Intent: orphaned / dangling / unused resources
  if (lower.match(/\borphan|\bdangling|\bunused.resource|\bunused.secret|\bunused.config|\bstale.resource|\bcleanup.resource/)) {
    context.intents.push("orphaned");
  }

  // Intent: governance / tenancy / quotas / chargeback
  if (lower.match(/\btenant|\bchargeback|\bresource.quota|\blimit.range|\bnamespace.governance|\bmulti.tenant/)) {
    context.intents.push("governance");
  }

  // --- Multi-platform lifecycle intents ---

  // Intent: cluster provisioning / node pool management
  if (lower.match(/\bcreate.cluster|\bdestroy.cluster|\bprovision.cluster|\bnode.?pool|\bnodegroup|\badd.node|\bresize.node|\bscale.node/)) {
    context.intents.push("cluster_lifecycle");
  }

  // Intent: add-on / extension management
  if (lower.match(/\baddon|\badd-on|\bextension|\bplugin|\beks.addon|\baks.extension|\bgke.addon|\binstall.addon|\bremove.addon|\bupgrade.addon/)) {
    context.intents.push("addon_management");
  }

  // Intent: deployment strategies (canary, blue-green, rollout)
  if (lower.match(/\bcanary|\bblue.green|\brolling.update|\brollout.status|\brollout.pause|\brollout.resume|\bprogressive/)) {
    context.intents.push("deploy_strategy");
  }

  // Intent: service exposure / ingress / load balancer
  if (lower.match(/\bexpose|\bload.?balancer|\bexternal.access|\bpublic.endpoint|\balb\b|\bnlb\b|\bazure.lb|\bgateway.api/)) {
    context.intents.push("expose_service");
  }

  // Intent: identity / service account security (cross-platform)
  if (lower.match(/\birsa\b|\bworkload.identity|\bpod.identity|\bmanaged.identity|\bgcp.sa|\biam.role|\bservice.?account.?secur/)) {
    context.intents.push("sa_security");
  }

  // Intent: node autoscaling (cross-platform)
  if (lower.match(/\bkarpenter|\bcluster.?autoscal|\bnode.?autoscal|\bmachine.?autoscal|\bscale.to.zero|\bspot.instance|\bpreemptible/)) {
    context.intents.push("node_autoscale");
  }

  // Intent: cloud-native monitoring
  if (lower.match(/\bcloudwatch|\bazure.monitor|\bcloud.operations|\bcontainer.insights|\bcloud.logging|\bcloud.monitoring|\bstack.?driver/)) {
    context.intents.push("cloud_monitoring");
  }

  // Intent: cloud-native image scanning
  if (lower.match(/\becr.scan|\bacr.scan|\bartifact.analysis|\bdefender.for.container|\bguardduty|\bbinary.auth/)) {
    context.intents.push("cloud_imagescan");
  }

  // Intent: cloud secret management
  if (lower.match(/\bsecrets?.manager|\bkey.vault|\bsecret.manager|\bexternal.secret|\bsealed.secret|\bvault\b/)) {
    context.intents.push("secret_management");
  }

  // Intent: storage configuration (cross-platform)
  if (lower.match(/\bebs.csi|\bazure.disk|\bazure.file|\bgce.pd|\bodf\b|\bocs\b|\bstorage.config|\bcsi.driver/)) {
    context.intents.push("storage_config");
  }

  // Intent: cost optimization / FinOps
  if (lower.match(/\bcost|\bfinops|\bspend|\bbudget|\bchargeback|\bshowback|\bcost.alloc|\bsaving/)) {
    context.intents.push("cost_optimization");
  }

  // Intent: VPA / vertical autoscaling
  if (lower.match(/\bvpa\b|\bvertical.pod.auto|\bvertical.autoscal|\bvpa.recommend/)) {
    context.intents.push("vpa");
  }

  // Intent: service mesh / tracing
  if (lower.match(/\bservice.mesh|\bistio|\benvoy|\bsidecar|\bmtls|\btrace.request|\bjaeger|\btempo|\bkiali/)) {
    context.intents.push("service_mesh");
  }

  // Intent: incident isolation / containment
  if (lower.match(/\bisolate|\bcontain.incident|\bquarantine|\bcordon.namespace|\bnetwork.isolat|\bfence/)) {
    context.intents.push("incident_response");
  }

  // If no intent detected, default to a help response
  if (context.intents.length === 0) {
    context.intents.push("help");
  }

  // -------------------------------------------------------------------------
  // Fetch ONLY the data needed for detected intents.
  // Use pre-computed cluster digest for basic info (version, node count)
  // to avoid redundant API calls on every chat message.
  // -------------------------------------------------------------------------

  // Only reached for local cluster (remote clusters return early via buildContextFromAgentCache)
  const digest = getClusterDigest("local");
  if (digest) {
    context.clusterVersion = digest.version;
    context.channel = digest.channel;
    context.nodeCount = digest.nodeCount;
    context.readyNodes = digest.readyNodes;
    context.platform = digest.platform;
  } else {
    tasks.push(
      ocpGet("/apis/config.openshift.io/v1/clusterversions/version")
        .then((d) => {
          context.clusterVersion = d.status?.desired?.version;
          context.channel = d.spec?.channel;
          updateClusterDigest({ cluster: "local", version: context.clusterVersion, channel: context.channel, platform: "openshift" });
        })
        .catch(() => {
          tasks.push(
            ocpGet("/version")
              .then((d) => { context.clusterVersion = d.gitVersion; context.platform = "kubernetes"; })
              .catch(() => {})
          );
        })
    );
  }

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
          conditions: (n.status?.conditions || []).filter((c) => c.type !== "Ready" && c.status === "True").map((c) => c.type),
          cpu: n.status?.capacity?.cpu,
          memory: n.status?.capacity?.memory,
        }));
        updateClusterDigest({
          cluster: "local",
          nodeCount: context.nodes.length,
          readyNodes: context.nodes.filter((n) => n.ready).length,
        });
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

  // Specific pod — fetch details, events, logs, and metrics in parallel
  if (context.intents.includes("specific_pod") && context.targetPodName) {
    const podName = context.targetPodName;
    const wantsLogs = /\b(log|logs|tail|describe|why|diagnose|debug|investigate|fail|error|crash|wrong|issue|problem|inspect|details?)\b/i.test(userMessage);
    tasks.push(
      (async () => {
        // Single pod lookup using fieldSelector instead of fetching ALL pods
        let pod = null;
        let ns = null;
        try {
          const d = await ocpGet(`/api/v1/pods?fieldSelector=metadata.name=${podName}`);
          pod = (d.items || [])[0];
        } catch {
          // Fallback: some clusters don't support name field selector on pods
          try {
            const d = await ocpGet("/api/v1/pods");
            pod = (d.items || []).find((p) => p.metadata.name === podName);
          } catch { return; }
        }
        if (!pod) return;
        ns = pod.metadata.namespace;
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
        // Parallel: events + logs + metrics for the found pod
        const subTasks = [];
        subTasks.push(
          ocpGet(`/api/v1/namespaces/${ns}/events?fieldSelector=involvedObject.name=${podName}`).then((ev) => {
            context.targetPodEvents = (ev.items || [])
              .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0))
              .slice(0, 20)
              .map((e) => ({
                type: e.type, reason: e.reason, message: e.message, count: e.count, lastSeen: e.lastTimestamp,
              }));
          }).catch(() => {})
        );
        if (wantsLogs) {
          subTasks.push(
            (async () => {
              try {
                const txt = await fetchPodLogs(ns, podName, 80);
                context.targetPodLogs = String(txt || "").slice(0, 6000);
              } catch (err) {
                context.targetPodLogsError = err.message;
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
            })()
          );
        }
        subTasks.push(
          ocpGet(`/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods/${podName}`).then((m) => {
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
        await Promise.all(subTasks);
      })()
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
          containers: (dep.spec?.template?.spec?.containers || []).map((c) => ({
            name: c.name,
            image: c.image,
            resources: { requests: c.resources?.requests || {}, limits: c.resources?.limits || {} },
          })),
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
          containers: (dep.spec?.template?.spec?.containers || []).map((c) => ({
            name: c.name,
            resources: { requests: c.resources?.requests || {}, limits: c.resources?.limits || {} },
          })),
        }));
      }).catch(() => {})
    );
  }

  // Focused deployment — when user asks about a specific deployment by name
  if (context.targetResourceType === "deployment" && context.targetResourceName) {
    const depName = context.targetResourceName;
    tasks.push(
      (async () => {
        let dep = null;
        try {
          const d = await ocpGet("/apis/apps/v1/deployments");
          dep = (d.items || []).find((item) =>
            item.metadata.name === depName || item.metadata.name.includes(depName)
          );
        } catch { return; }
        if (!dep) return;
        const ns = dep.metadata.namespace;
        const containers = (dep.spec?.template?.spec?.containers || []).map((c) => ({
          name: c.name,
          image: c.image,
          resources: {
            requests: c.resources?.requests || {},
            limits: c.resources?.limits || {},
          },
          ports: (c.ports || []).map((p) => ({ name: p.name, containerPort: p.containerPort, protocol: p.protocol })),
          env: (c.env || []).length,
          volumeMounts: (c.volumeMounts || []).length,
        }));
        context.targetDeployment = {
          name: dep.metadata.name,
          namespace: ns,
          replicas: dep.spec?.replicas,
          readyReplicas: dep.status?.readyReplicas || 0,
          availableReplicas: dep.status?.availableReplicas || 0,
          unavailableReplicas: dep.status?.unavailableReplicas || 0,
          updatedReplicas: dep.status?.updatedReplicas || 0,
          strategy: dep.spec?.strategy?.type,
          containers,
          image: containers[0]?.image,
          conditions: (dep.status?.conditions || []).map((c) => ({
            type: c.type, status: c.status, reason: c.reason, message: c.message,
          })),
          selector: dep.spec?.selector?.matchLabels,
        };
        const subTasks = [];
        // Fetch events for this deployment
        subTasks.push(
          ocpGet(`/api/v1/namespaces/${ns}/events?fieldSelector=involvedObject.name=${dep.metadata.name}`).then((ev) => {
            context.targetDeploymentEvents = (ev.items || [])
              .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0))
              .slice(0, 15)
              .map((e) => ({
                type: e.type, reason: e.reason, message: e.message, count: e.count, lastSeen: e.lastTimestamp,
              }));
          }).catch(() => {})
        );
        // Fetch pods belonging to this deployment (by label selector)
        const labelSelector = Object.entries(dep.spec?.selector?.matchLabels || {})
          .map(([k, v]) => `${k}=${v}`).join(",");
        if (labelSelector) {
          subTasks.push(
            ocpGet(`/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(labelSelector)}`).then((pd) => {
              context.targetDeploymentPods = (pd.items || []).map((p) => ({
                name: p.metadata.name,
                phase: p.status?.phase,
                node: p.spec?.nodeName,
                containers: (p.status?.containerStatuses || []).map((c) => ({
                  name: c.name, ready: c.ready, restarts: c.restartCount,
                  state: c.state?.waiting?.reason || c.state?.terminated?.reason || (c.state?.running ? "Running" : "Unknown"),
                })),
                conditions: (p.status?.conditions || []).filter((c) => c.status !== "True").map((c) => ({
                  type: c.type, reason: c.reason, message: c.message,
                })),
              }));
            }).catch(() => {})
          );
        }
        // Fetch ReplicaSets for this deployment
        subTasks.push(
          ocpGet(`/apis/apps/v1/namespaces/${ns}/replicasets`).then((rs) => {
            context.targetDeploymentReplicaSets = (rs.items || [])
              .filter((r) => (r.metadata?.ownerReferences || []).some((o) => o.name === dep.metadata.name && o.kind === "Deployment"))
              .map((r) => ({
                name: r.metadata.name,
                replicas: r.spec?.replicas,
                ready: r.status?.readyReplicas || 0,
                available: r.status?.availableReplicas || 0,
              }));
          }).catch(() => {})
        );
        await Promise.all(subTasks);
      })()
    );
  }

  // Pod/Node metrics (CPU/memory usage) — fetched when user asks about resources
  if (context.intents.includes("metrics")) {
    const metricsNs = context.targetNamespaceFromMemory || (nsMatch ? nsMatch[1] : null);
    const podMetricsPath = metricsNs
      ? `/apis/metrics.k8s.io/v1beta1/namespaces/${metricsNs}/pods`
      : `/apis/metrics.k8s.io/v1beta1/pods`;
    tasks.push(
      ocpGet(podMetricsPath).then((d) => {
        const pods = (d.items || []).map((p) => {
          const containers = (p.containers || []).map((c) => ({
            name: c.name,
            cpu: c.usage?.cpu,
            memory: c.usage?.memory,
          }));
          const totalCpuNano = containers.reduce((s, c) => s + parseCpuNano(c.cpu), 0);
          const totalMemBytes = containers.reduce((s, c) => s + parseMemBytes(c.memory), 0);
          return {
            pod: p.metadata.name,
            namespace: p.metadata.namespace,
            cpu: fmtCpu(String(totalCpuNano) + "n"),
            memory: fmtMem(String(Math.round(totalMemBytes / 1024)) + "Ki"),
            cpuNano: totalCpuNano,
            memBytes: totalMemBytes,
          };
        });
        pods.sort((a, b) => b.cpuNano - a.cpuNano);
        context.podMetrics = pods.slice(0, 30);
        context.podMetricsTotal = pods.length;
        context.podMetricsNamespace = metricsNs || "all";
      }).catch(() => {})
    );
    tasks.push(
      ocpGet("/apis/metrics.k8s.io/v1beta1/nodes").then((d) => {
        context.nodeMetrics = (d.items || []).map((n) => ({
          node: n.metadata.name,
          cpu: fmtCpu(n.usage?.cpu),
          memory: fmtMem(n.usage?.memory),
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

  // RBAC / Access — who has access, permissions
  if (context.intents.includes("rbac")) {
    tasks.push(
      ocpGet("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings").then((d) => {
        const crbs = d.items || [];
        const keyRoles = ["cluster-admin", "admin", "edit", "view", "self-provisioner"];
        context.rbacBindings = [];
        for (const crb of crbs) {
          const role = crb.roleRef?.name || "";
          if (!keyRoles.some(r => role === r || role.includes(r))) continue;
          for (const s of (crb.subjects || [])) {
            context.rbacBindings.push({ role, kind: s.kind, name: s.name, ns: s.namespace || "" });
          }
        }
      }).catch(() => {})
    );
    tasks.push(
      ocpGet("/apis/user.openshift.io/v1/users").then((d) => {
        context.ocpUsers = (d.items || []).map(u => ({
          name: u.metadata.name,
          fullName: u.fullName || "",
          identities: (u.identities || []),
        }));
      }).catch(() => { context.ocpUsers = []; })
    );
    tasks.push(
      ocpGet("/apis/user.openshift.io/v1/groups").then((d) => {
        context.ocpGroups = (d.items || []).map(g => ({
          name: g.metadata.name,
          members: g.users || [],
        }));
      }).catch(() => { context.ocpGroups = []; })
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
    tasks.push(
      getPendingCRs().then((crs) => {
        if (crs && crs.length > 0) {
          context.pendingChangeRequests = crs.map(cr => ({
            ticketId: cr.ticketId, status: cr.status, title: cr.title,
            targetVersion: cr.targetVersion, fromVersion: cr.fromVersion,
            scheduledDate: cr.scheduledDate, createdAt: cr.createdAt,
          }));
        }
      }).catch(() => {})
    );
  }

  // Also inject pending CRs when user explicitly mentions change requests
  if (/\b(change.?request|CHG\d|CR\s*status|pending.?cr|approved.?cr)\b/i.test(lower) && !context.intents.includes("cluster_upgrade")) {
    tasks.push(
      getPendingCRs().then((crs) => {
        if (crs && crs.length > 0) {
          context.pendingChangeRequests = crs.map(cr => ({
            ticketId: cr.ticketId, status: cr.status, title: cr.title,
            targetVersion: cr.targetVersion, fromVersion: cr.fromVersion,
            scheduledDate: cr.scheduledDate, createdAt: cr.createdAt,
          }));
        }
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

  // Certificate expiry — fetch actual certificate data from cluster secrets
  if (context.intents.includes("certificate_expiry")) {
    tasks.push(
      checkCertificateExpiry().then((result) => {
        context.certificateExpiry = result.expiring || [];
      }).catch(() => { context.certificateExpiry = []; })
    );
    // Also fetch pending CSRs
    tasks.push(
      ocpGet("/apis/certificates.k8s.io/v1/certificatesigningrequests").then((d) => {
        const csrs = (d.items || []);
        context.pendingCSRs = csrs.filter((c) => {
          const approved = (c.status?.conditions || []).some((cond) => cond.type === "Approved");
          return !approved;
        }).map((c) => ({
          name: c.metadata.name,
          requestor: c.spec?.username,
          created: c.metadata.creationTimestamp,
          signerName: c.spec?.signerName,
        }));
      }).catch(() => { context.pendingCSRs = []; })
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

/**
 * Filter correlations to only include entries relevant to the user's question.
 * When the user asks about a specific deployment or pod, cluster-wide problem
 * pods (e.g. mlflow-server CrashLoopBackOff) are irrelevant noise.
 */
function filterRelevantCorrelations(correlations, ctx) {
  if (!correlations || correlations.length === 0) return [];

  const targetNs = ctx.targetDeployment?.namespace ||
                   ctx.targetPod?.namespace ||
                   ctx._focusPod?.namespace ||
                   ctx.targetNamespaceFromMemory;
  const targetName = ctx.targetDeployment?.name ||
                     ctx.targetResourceName ||
                     ctx.targetPodName;

  return correlations.filter((c) => {
    // Keep correlations in the same namespace as the target
    if (targetNs && c.namespace === targetNs) return true;
    // Keep correlations whose pod name contains the target resource name
    if (targetName && c.pod?.includes(targetName)) return true;
    // Keep correlations whose owner matches the target deployment
    if (targetName && c.ownerName?.includes(targetName)) return true;
    return false;
  });
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
// ---------------------------------------------------------------------------
// System prompt: lean base (~40% smaller) + intent-specific supplements.
// The base is ALWAYS sent (and cached by Anthropic/Azure). Supplements are
// appended only when the query matches a specific intent, reducing input
// tokens by ~2K on average → faster first-token latency.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_BASE = `You are TCS Agentic AI — an expert OpenShift/Kubernetes SRE AI Assistant embedded in an MCP server with LIVE access to the user's cluster.

IMPORTANT: You are given REAL-TIME cluster data as JSON context from the user's actual cluster. Always reference actual pod names, namespaces, events, and metrics from the context.

## Capabilities:
- Read access to pods, deployments, nodes, events, routes, operators, VMs, and more
- Container resource limits, restart counts, OOMKill history, and events
- Node capacity, pod scheduling, cluster version
- Remediation via MCP tools (emergency_fix, restart_pod, scale_deployment)

## OpenShift-specific:
- Use \`oc\` commands (not \`kubectl\`) in all examples
- Reference Routes, DeploymentConfigs, BuildConfigs, ImageStreams, SCCs, Projects
- For SCC issues: \`oc adm policy\` commands
- For operator issues: check ClusterOperator status conditions
- For upgrade issues: MachineConfigPool status and ClusterVersion

## CRITICAL RULE — NEVER tell users to run commands to get information:
- You have LIVE cluster data in the context below. ALWAYS analyze it directly.
- NEVER say "run this command to check" or "use oc top pods" — YOU must provide the answer from the data you have.
- NEVER say "I do not see direct metrics" — if metrics data is in your context, analyze it; if not, say what you CAN tell from the pod/node status data you have.
- If the user asks about CPU/memory usage and you have pod resource requests/limits in context, analyze THOSE. Show requests vs limits, identify pods close to limits.
- Only include \`oc\` commands as REMEDIATION steps (to fix a problem), never as diagnostic steps.

## Response style:
- Be specific to THIS cluster's data — never generic advice when you have real data
- Start with a clear diagnosis, then remediation steps
- Use markdown: headers, code blocks, tables
- Keep responses focused and actionable
- Include \`oc\` commands only for FIXES and remediation — never for "go check this yourself"
- If risky (upgrade, delete, scale down), warn about impact and suggest precheck/dry-run
- Never show raw image SHA hashes or internal registry URLs
- Never dump raw technical data without analysis — summarize, compare, recommend

## Conversation continuity:
- Use conversation history for follow-up questions
- Carry forward namespace/cluster context from prior turns
- "show its logs", "restart it", "fix it" → refer to previous resource
- If intent is ambiguous, ask a brief clarifying question with 2-4 numbered options

## Grounding Rules (STRICT):
- Every claim MUST reference a specific resource name, namespace, and metric value from the provided data
- If the data doesn't contain enough information to answer, say so explicitly — never fabricate
- When mentioning pod counts, cross-check against the actual problemPods array length
- When mentioning node conditions, verify against the actual node data
- Never invent resource names, namespaces, or metric values not present in context
- If auto-diagnosis is present, use it as ground truth — do not contradict it
- Quote exact values: memory limits, CPU requests, restart counts, exit codes`;

const PROMPT_SUPPLEMENT_DIAGNOSE = `

## Diagnosis guidance:
1. **Identify the specific pod/container** from the context — use exact name
2. **Check "_autoDiagnosis" first** — use its rootCause, diagnosis, evidence, fixes, logSnippet
3. **OOMKilled**: Compare memory limits vs requests. Quote the exact limit. Explain WHY more memory is needed.
4. **CrashLoopBackOff**: Quote exit code and meaning. Quote the specific error line from logs.
5. **Never tell the user to "check" or "run" commands** — you have the data, analyze directly
6. **Always end with a concrete fix** — fix cards are auto-appended
7. **Assess blast radius** — will the fix affect other services?
8. **Production changes** — mention ServiceNow change request flow

## Deployment issues (0/0, unavailable replicas):
- Focus on "Target Deployment" if present in context
- Common causes: spec.replicas=0, no ReplicaSet, failed rollout, quota exceeded, scheduling failures
- Only mention NotReady nodes if context SHOWS NotReady nodes
- Quote specific conditions, events, pod states — never fabricate

## Specific pod/resource focus:
- "_focusPod"/"targetPod" → your ENTIRE response must be about THAT pod only
- "_focusPodLogs" → quote relevant lines when diagnosing
- "_focusPodLogsPrevious" → use for OOMKill/CrashLoop diagnosis
- Structure: 1) Root cause headline 2) Evidence 3) Brief explanation. Fixes auto-appended.
- NEVER list generic reasons — you have actual data, give SPECIFIC diagnosis`;

const PROMPT_SUPPLEMENT_LIST = `

## When listing resources:
- Use markdown tables for structured data
- Highlight unhealthy items with warning indicators
- Include restart counts, age, resource usage, owner references
- Group by namespace when showing cross-namespace data`;

const PROMPT_SUPPLEMENT_CERTS = `

## Certificate expiry:
- Report EXACT certificates and days-remaining from cluster context
- Never give generic textbook explanation when actual cert data is available
- Fix commands: \`oc get csr\` for pending CSRs, \`oc adm certificate approve <csr>\`
- Note: OpenShift auto-rotates most certs via cert-manager operators`;

const PROMPT_SUPPLEMENT_METRICS = `

## Resource usage / metrics queries:
- The context includes LIVE pod metrics (CPU and memory) from metrics.k8s.io API
- Present the data in a markdown TABLE sorted by the requested metric
- Include columns: Pod Name, Namespace, CPU, Memory
- Highlight the TOP consumers — the user is asking about HIGH usage, show them which pods are using the most
- NEVER say "I do not see metrics" or "run oc top" — the metrics ARE in your context as podMetrics/nodeMetrics
- If the user asks about "high cpu", show pods sorted by CPU descending with the highest ones first
- Compare actual usage against resource requests/limits if available`;

const PROMPT_SUPPLEMENT_ALERTS = `

## Alerts / Monitoring queries:
- Present firing alerts in a TABLE with severity, name, namespace, and duration
- Group by severity (critical first, then warning, then info)
- For silenced alerts, mention they exist but don't list unless asked
- Suggest remediation steps for common alerts (KubePodCrashLooping, KubeMemoryOvercommit, etc.)
- Never say "check Prometheus" — analyze the alert data directly`;

const PROMPT_SUPPLEMENT_GITOPS = `

## GitOps / ArgoCD queries:
- Present applications in a TABLE with sync status, health, and repo info
- Highlight OutOfSync and Degraded applications prominently
- For drift questions, explain what resources have drifted and why
- Suggest sync or remediation actions for out-of-sync apps`;

const PROMPT_SUPPLEMENT_BACKUP = `

## Backup / DR queries:
- Report etcd health alongside Velero backup status
- Highlight any failed or partial backups with timestamps
- Show backup schedules and last successful backup time
- For DR readiness, assess etcd health + backup recency + replica count`;

const PROMPT_SUPPLEMENT_FLEET = `

## Multi-cluster / Fleet queries:
- Present managed clusters in a TABLE with status, version, and role
- Highlight offline or unavailable clusters prominently
- Show policy compliance across the fleet
- Group by hub vs spoke clusters`;

const PROMPT_SUPPLEMENT_OPTIMIZE = `

## Resource Optimization queries:
- Focus on overprovisioned pods (using <10% of limits) and pods without limits
- Present findings as actionable right-sizing recommendations
- Group by namespace for better visibility
- NEVER mention dollar amounts or cost savings — focus on resource efficiency and cluster capacity`;

const PROMPT_SUPPLEMENT_NETWORK = `

## Network Diagnostics queries:
- Report on ingress controller health, network policies, and egress configuration
- For connectivity issues, check service endpoints and network policies
- Highlight namespaces without network policies as security gaps`;

const PROMPT_SUPPLEMENT_SLO = `

## SLO / SLI / Error Budget queries:
- Present SLO compliance data in tables with availability targets vs actual
- Explain burn-rate windows (5m, 30m, 1h, 6h) if relevant
- Recommend SLO tooling (Sloth, Pyrra) if no SLOs are defined
- Never tell users to "check Grafana" — analyze the data directly`;

const PROMPT_SUPPLEMENT_INCIDENT = `

## Incident / Postmortem queries:
- Present a clear incident timeline with severity indicators
- Quantify the blast radius: affected pods, namespaces, services
- Group signals by severity (CRITICAL > WARNING > INFO)
- For postmortems, present events chronologically and identify root cause patterns`;

const PROMPT_SUPPLEMENT_SECURITY = `

## Supply Chain / Hardening / Security queries:
- Present findings in severity order with actionable remediation
- Highlight unsigned images, missing PSA labels, permissive SCCs
- For CIS benchmarks, show pass/fail/skip counts
- Never expose sensitive data (tokens, keys) in responses`;

const PROMPT_SUPPLEMENT_ALLOCATION = `

## Resource Allocation queries (requests, limits, quotas):
- Show CPU and memory requests AND limits for every container in the deployment/pod
- Format as a clear table: Container | CPU Request | CPU Limit | Memory Request | Memory Limit
- If requests or limits are MISSING, explicitly flag it as a best-practice violation
- Compare requests vs limits ratio — limits should typically be 1.5-2x of requests for CPU
- If ResourceQuota exists in the namespace, show usage vs quota
- Highlight containers with no resource limits (unbounded — can cause node pressure)
- For "allocated resources" queries, this means the spec-level requests/limits, NOT live usage
- When showing multiple deployments, include a total/summary row`;

const PROMPT_SUPPLEMENT_CAPACITY = `

## Capacity / Topology / Scheduling queries:
- Present resource headroom as percentages with clear thresholds
- Show CPU and memory separately — they often have different pressure points
- For topology, include zone distribution and scheduling constraints
- NEVER mention dollar amounts — focus on resource efficiency and operational risk`;

const PROMPT_SUPPLEMENT_WORKLOAD = `

## Workload Resilience / Day-2 Ops queries:
- Report PDB, HPA, probe coverage as percentages
- Highlight workloads that could block node drains or upgrades
- For orphaned resources, filter out system namespaces
- Present findings as actionable cleanup recommendations`;

const PROMPT_SUPPLEMENT_MULTIPLATFORM = `

## Multi-Platform Awareness:
- Detect the active platform (OpenShift/EKS/AKS/GKE/K8s) from context and tailor commands accordingly
- OpenShift: oc, Routes, SCCs, BuildConfigs, MachineConfig, ClusterVersion
- EKS: kubectl/eksctl, ALB Ingress, IRSA, Karpenter, EKS add-ons, VPC CNI
- AKS: kubectl/az, Azure LB, Workload Identity, Node pools, Azure Policy
- GKE: kubectl/gcloud, Gateway API, Workload Identity Federation, Autopilot constraints
- Vanilla K8s: kubectl, Ingress, Pod Security Standards, Cluster Autoscaler
- When showing remediation commands, use the correct CLI for the detected platform
- Cross-platform concepts: map OpenShift Routes → Ingress, SCCs → PSS, MachineSet → node pools`;

const PROMPT_SUPPLEMENT_DEPLOY_STRATEGY = `

## Deployment Strategy Guidance:
- For canary: recommend Flagger or Argo Rollouts with traffic splitting percentages
- For blue-green: show how to use service selector swaps or Argo Rollouts
- Always recommend rollback plan before proceeding
- Show rollout status monitoring commands
- For progressive delivery, mention metric-based promotion gates`;

const PROMPT_SUPPLEMENT_COST = `

## Cost Optimization / FinOps:
- Focus on resource efficiency, not dollar amounts
- Identify overprovisioned pods (using <10% of limits)
- Highlight pods without resource requests/limits
- Recommend right-sizing based on actual usage patterns
- Mention spot/preemptible instances for fault-tolerant workloads
- Show namespace-level resource consumption breakdowns`;

const PROMPT_SUPPLEMENT_AMBIGUITY = `

## Missing information / ambiguity:
- NEVER respond with "[WARNING] Please specify the namespace" — check conversation history
- If you cannot resolve a resource, list most likely candidates from live data
- For version/upgrade info: group logically, highlight recommended path, explain trade-offs
- Prioritize answering the EXACT question. "upgrade to 4.19.23" → respond about 4.19.23 specifically
- When lacking context, say what you DO know, state your assumption, ask if different`;

function buildSystemPrompt(userMessage, context) {
  const platform = getPlatform();
  const isOCP = platform === "openshift";
  const cli = isOCP ? "oc" : "kubectl";

  let prompt = SYSTEM_PROMPT_BASE;
  const lower = (userMessage || "").toLowerCase();

  if (/diagnos|crash|oom|error|fail|wrong|troubleshoot|restart|not\s*ready|why\b|root\s*cause|fix\b|issue|problem/i.test(lower) ||
      context?._autoDiagnosis || context?._focusPod || context?.targetPod) {
    prompt += PROMPT_SUPPLEMENT_DIAGNOSE;
  }

  if (/list|show|get|describe|all\s|how\s+many|count|overview|status|health/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_LIST;
  }

  if (/\bcpu\b|\bmemory\b|\bmem\b|\bram\b|\busage\b|\bmetrics?\b|\btop\b|\bhigh\b|\bresource\s+usage|\bconsumption/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_METRICS;
  }

  if (/\ballocat|\brequest.*limit|\blimit.*request|\bresource\s*(request|limit|quota)|\bquota|\bright.siz/i.test(lower) ||
      context?.nluResult?.scope === "allocation") {
    prompt += PROMPT_SUPPLEMENT_ALLOCATION;
  }

  if (/cert|certificate|expir|tls|csr/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_CERTS;
  }

  if (/upgrade|version|compare|ambig/i.test(lower) || context?.intents?.includes("knowledge")) {
    prompt += PROMPT_SUPPLEMENT_AMBIGUITY;
  }

  if (/\balert|\bfiring|\bsilence|\bprometheus|\balertmanager/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_ALERTS;
  }

  if (/\bgitops|\bargocd|\bargo\b|\bsync\b|\bdrift\b|\breconcil/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_GITOPS;
  }

  if (/\bbackup|\bvelero|\brestore|\bdisaster.recov|\betcd.backup/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_BACKUP;
  }

  if (/\bfleet|\bmanaged.cluster|\bacm\b|\bmulti.cluster/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_FLEET;
  }

  if (/\bright.siz|\boptimiz|\boverprovision|\bunderutiliz|\bidle|\bwasted?\b/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_OPTIMIZE;
  }

  if (/\begress|\bdns\b|\blatency|\bnetwork.diag|\bconnectiv/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_NETWORK;
  }

  if (/\bslo\b|\bsli\b|\bsla\b|\berror.budget|\bburn.rate|\bservice.level/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_SLO;
  }

  if (/\bincident|\bpostmortem|\btimeline|\bblast.radius|\bimpact/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_INCIDENT;
  }

  if (/\bsbom|\bprovenance|\bhardening|\bcis.bench|\bpsa\b|\bpod.security|\bsupply.chain|\bunsigned/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_SECURITY;
  }

  if (/\bcapacity|\brunway|\bheadroom|\btopology|\bzone|\baffinity|\bschedul/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_CAPACITY;
  }

  if (/\bpdb\b|\bdisruption|\bhpa\b|\bautoscal|\bprobe|\bliveness|\breadiness|\borphan|\bunused|\bgovernance|\btenant|\bquota/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_WORKLOAD;
  }

  if (/\bcanary|\bblue.green|\brolling|\bprogressive|\bdeploy.*strat/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_DEPLOY_STRATEGY;
  }

  if (/\bcost|\bfinops|\bspend|\bbudget|\bchargeback|\bshowback/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_COST;
  }

  if (!isOCP || /\beks\b|\baks\b|\bgke\b|\bkubernetes\b|\bk8s\b|\bmulti.*platform|\bcross.*platform/i.test(lower)) {
    prompt += PROMPT_SUPPLEMENT_MULTIPLATFORM;
  }

  if (!isOCP) {
    prompt = prompt.replace(/Use `oc` commands \(not `kubectl`\) in all examples/g,
      `Use \`${cli}\` commands in all examples. This is a ${platform.toUpperCase()} cluster.`);
    prompt = prompt.replace(/Reference Routes, DeploymentConfigs, BuildConfigs, ImageStreams, SCCs, Projects/g,
      'Reference platform-specific resources (Ingress, HPA, etc.)');
  }

  if (context?._remoteCluster) {
    const rp = context.platform || platform;
    const rcli = (rp === "openshift") ? "oc" : "kubectl";
    prompt += `\n\n## ACTIVE CLUSTER CONTEXT
You are answering about the REMOTE cluster **"${context._remoteCluster}"** (platform: ${rp}).
- The cluster data below comes from an agent cache snapshot, not live API calls.
- Use \`${rcli}\` commands in examples for this cluster.
- Always identify the cluster by name in your response header.
- If the cached data doesn't contain enough detail for the question, say so clearly rather than guessing.`;
  }

  // Cross-platform guidance — injects platform-specific CLI, resources, and best practices
  const intents = context?.intents || [];
  try {
    const platformSection = buildPlatformPromptSection(platform, intents);
    if (platformSection) prompt += "\n\n" + platformSection;
  } catch { /* platform router optional */ }

  // Few-shot examples — anchors LLM output format for known intent patterns
  try {
    const examples = getFewShotExamples(intents, platform);
    if (examples) prompt += "\n\n" + examples;
  } catch { /* few-shot optional */ }

  // Error knowledge — inject known error patterns when diagnosing
  if (context?._autoDiagnosis || context?._focusPod || context?.targetPod) {
    try {
      const pod = context._focusPod || context.targetPod;
      const reason = pod?.containers?.[0]?.state || pod?.phase || context?._autoDiagnosis?.rootCause;
      if (reason) {
        const errors = getErrorsForReason(reason);
        if (errors && errors.length > 0) {
          const knowledgeLines = errors.slice(0, 3).map(e =>
            `- **${e.pattern}**: ${e.rootCause} → ${e.remediation[0] || "investigate"}`
          );
          prompt += `\n\n## Known Error Patterns\n${knowledgeLines.join("\n")}`;
        }
      }
    } catch { /* error knowledge optional */ }
  }

  return prompt;
}

const SYSTEM_PROMPT = SYSTEM_PROMPT_BASE;

// ---------------------------------------------------------------------------
// Pillar 1 + 3: Augment the system prompt with NLU-detected context
// (persona, constraints, goal hint) AND persistent user memory
// (preferences, learned facts). Both pillars share this injection point.
// Controlled by PILLAR_1_INJECT_CONTEXT and PILLAR_3_AUTO_MEMORY env vars.
// ---------------------------------------------------------------------------
async function augmentSystemPrompt(basePrompt, { parsed, userId, conversationId } = {}) {
  try {
    const ff = await import("./feature-flags.js");
    const additions = [];

    // Pillar 1: persona / constraints / goals from NLU
    if (parsed && ff.flags.pillar1InjectContext()) {
      const p1 = [];
      if (parsed.personaHint) {
        const tone = {
          security: "Tailor responses for a security engineer — emphasize CVEs, RBAC, compliance, and remediation severity.",
          developer: "Tailor responses for a developer — focus on deployment, config, and application-level concerns.",
          manager: "Tailor responses for a manager — provide high-level summaries, status, and timelines (no dollar amounts).",
          sre: "Tailor responses for an SRE — focus on reliability, capacity, latency, and incident response.",
        }[parsed.personaHint];
        if (tone) p1.push(`PERSONA: ${tone}`);
      }
      if (parsed.constraints) {
        const c = parsed.constraints;
        const constraintLines = [];
        if (c.urgency === "critical") constraintLines.push("URGENT request — prioritize speed and direct answers; skip preamble.");
        else if (c.urgency === "low") constraintLines.push("Non-urgent — thorough analysis welcomed.");
        if (c.environment === "production") constraintLines.push("PRODUCTION environment — be conservative, prefer dry-run, recommend approval workflows.");
        if (c.changeFreeze) constraintLines.push("CHANGE FREEZE active — do NOT recommend immediate mutating operations; suggest scheduling for after freeze.");
        if (c.maintenanceWindow) constraintLines.push("Operating within maintenance window — disruptive changes acceptable.");
        if (c.requiresApproval) constraintLines.push("User indicated this requires approval — guide them toward ServiceNow CR creation.");
        if (c.preferDryRun) constraintLines.push("User prefers dry-run/preview before applying changes.");
        if (constraintLines.length) p1.push("CONSTRAINTS:\n" + constraintLines.map((l) => "  - " + l).join("\n"));
      }
      if (parsed.goalHint) {
        p1.push(`GOAL HINT: This appears to be a multi-step ${parsed.goalHint} goal. If the user wants a structured plan, suggest the \`/plan ${parsed.goalHint}\` slash command.`);
      }
      if (p1.length) additions.push("## Request Context (Pillar 1)\n" + p1.join("\n\n"));
    }

    // Pillar 3: persistent user memory
    if (userId && ff.flags.pillar3AutoMemory()) {
      try {
        const mem = await import("./persistent-memory.js");
        const ctxString = await mem.buildUserContextString(userId);
        if (ctxString && ctxString.trim()) {
          additions.push("## User Profile (Pillar 3)\n" + ctxString.trim());
        }
      } catch { /* memory unavailable */ }
    }

    // Incident RAG — inject past incident intelligence for diagnostic queries
    if (parsed && /diagnos|list|get|pod_issues|specific_pod|triage/.test(parsed.intent || "")) {
      try {
        const reason = parsed.filter || "";
        const podPattern = parsed.name?.replace(/-[a-z0-9]{8,10}(-[a-z0-9]{5})?$/, "") || "";
        const ns = parsed.namespace || "";
        const incidentCtx = await buildIncidentContext(
          { reason, podPattern, namespace: ns, exitCode: null },
          ns, getPlatform()
        );
        if (incidentCtx) additions.push(incidentCtx);
      } catch { /* incident RAG optional */ }
    }

    if (additions.length === 0) return basePrompt;
    return basePrompt + "\n\n---\n\n" + additions.join("\n\n");
  } catch {
    return basePrompt;
  }
}

// ---------------------------------------------------------------------------
// Post-response grounding check — verify numbers, namespaces, and node
// conditions mentioned by the LLM against the actual cluster context.
// ---------------------------------------------------------------------------
function groundingCheck(reply, ctx) {
  const warnings = [];
  if (!reply || !ctx) return { verified: true, warnings };

  // --- Check numeric claims like "5 pods crashing" against actual counts ---
  const countPattern = /(\d+)\s+pods?\s+(?:crash|fail|error|restart|pending|not\s*ready|crashloop)/gi;
  let m;
  while ((m = countPattern.exec(reply)) !== null) {
    const claimedCount = parseInt(m[1], 10);
    const actualProblemCount = Array.isArray(ctx.problemPods) ? ctx.problemPods.length : 0;
    if (claimedCount > 0 && actualProblemCount > 0 && Math.abs(claimedCount - actualProblemCount) > 1) {
      warnings.push(`Response mentions ${claimedCount} problem pods but context has ${actualProblemCount}`);
    }
  }

  // --- Check namespace names mentioned in the response ---
  const nsPattern = /(?:namespace|ns|project)\s+`?([a-z0-9][-a-z0-9]+)`?/gi;
  const ctxNamespaces = new Set();
  if (Array.isArray(ctx.namespaces)) ctx.namespaces.forEach((n) => ctxNamespaces.add(typeof n === "string" ? n : n.name || ""));
  if (ctx.targetNamespaceFromMemory) ctxNamespaces.add(ctx.targetNamespaceFromMemory);
  if (Array.isArray(ctx.problemPods)) ctx.problemPods.forEach((p) => { if (p.namespace) ctxNamespaces.add(p.namespace); });
  if (Array.isArray(ctx.allPods)) ctx.allPods.forEach((p) => { if (p.namespace) ctxNamespaces.add(p.namespace); });

  if (ctxNamespaces.size > 0) {
    while ((m = nsPattern.exec(reply)) !== null) {
      const ns = m[1];
      // Skip well-known system namespaces that are always present
      if (/^(default|kube-system|openshift|openshift-.+)$/.test(ns)) continue;
      if (!ctxNamespaces.has(ns)) {
        warnings.push(`Namespace "${ns}" mentioned but not found in cluster context`);
      }
    }
  }

  // --- Check node condition claims (e.g. "node X has MemoryPressure") ---
  const nodeCondPattern = /(?:node|worker|master)\s+`?([a-z0-9][-a-z0-9.]+)`?\s+(?:has|shows?|reports?|is\s+in|experiencing)\s+`?(MemoryPressure|DiskPressure|PIDPressure|NotReady|NetworkUnavailable)`?/gi;
  const nodeMap = new Map();
  if (Array.isArray(ctx.nodes)) {
    ctx.nodes.forEach((n) => {
      const name = n.name || n.metadata?.name || "";
      const conditions = new Set();
      if (Array.isArray(n.conditions)) {
        n.conditions.forEach((c) => {
          if (c.status === "True" || (c.type === "Ready" && c.status === "False")) {
            conditions.add(c.type);
          }
        });
      }
      if (n.status === "NotReady" || n.ready === false) conditions.add("NotReady");
      if (n.ready === true) conditions.add("Ready");
      if (name) nodeMap.set(name, conditions);
    });
  }

  while ((m = nodeCondPattern.exec(reply)) !== null) {
    const nodeName = m[1];
    const condition = m[2];
    if (nodeMap.has(nodeName)) {
      const actualConds = nodeMap.get(nodeName);
      if (!actualConds.has(condition)) {
        warnings.push(`Node "${nodeName}" claimed to have ${condition} but context shows otherwise`);
      }
    } else if (nodeMap.size > 0) {
      warnings.push(`Node "${nodeName}" mentioned but not found in cluster context`);
    }
  }

  return { verified: warnings.length === 0, warnings };
}

// ---------------------------------------------------------------------------
// Post-response resource-name validation — check that pod/resource names in
// the LLM reply actually exist in the cluster context.
// ---------------------------------------------------------------------------
const GENERIC_POD_NAMES = new Set([
  "pod-name", "example-pod", "my-app", "my-pod", "test-pod", "some-pod",
  "your-pod", "pod-xyz", "app-name", "my-deployment", "your-deployment",
  "example-app", "sample-app", "demo-app", "your-app", "my-service",
]);

function validateResponse(reply, clusterContext) {
  if (!reply || !clusterContext) return reply;

  // Build the set of known resource names from context
  const knownNames = new Set();

  const addNames = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      const name = typeof item === "string" ? item : (item.name || item.metadata?.name || "");
      if (name) knownNames.add(name);
    });
  };

  addNames(clusterContext.problemPods);
  addNames(clusterContext.allPods);
  addNames(clusterContext.nodes);
  addNames(clusterContext.deployments);
  addNames(clusterContext.namespaces);
  addNames(clusterContext.operators);
  if (clusterContext.targetPodName) knownNames.add(clusterContext.targetPodName);
  if (clusterContext.targetPod?.name) knownNames.add(clusterContext.targetPod.name);
  if (clusterContext.targetPod?.metadata?.name) knownNames.add(clusterContext.targetPod.metadata.name);
  if (clusterContext.targetResourceName) knownNames.add(clusterContext.targetResourceName);
  if (clusterContext.targetDeployment?.name) knownNames.add(clusterContext.targetDeployment.name);
  addNames(clusterContext.targetDeploymentPods);
  addNames(clusterContext.targetDeploymentReplicaSets);
  addNames(clusterContext.certificateExpiry);
  addNames(clusterContext.pendingCSRs);

  // Extract pod-like names from the reply
  const podPattern = /\b([a-z][-a-z0-9]*(?:-[a-z0-9]{4,10}){1,2})\b/g;
  const unrecognized = [];
  let match;
  const seen = new Set();

  while ((match = podPattern.exec(reply)) !== null) {
    const candidate = match[1];
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    // Skip generic/example names
    if (GENERIC_POD_NAMES.has(candidate)) continue;
    // Skip very short matches or common non-pod patterns
    if (candidate.length < 6) continue;
    // Skip if it's in the known names
    if (knownNames.has(candidate)) continue;
    // Skip if it's a substring-match of a known name (partial matches)
    let partialMatch = false;
    for (const known of knownNames) {
      if (known.includes(candidate) || candidate.includes(known)) {
        partialMatch = true;
        break;
      }
    }
    if (partialMatch) continue;
    unrecognized.push(candidate);
  }

  // Run the full grounding check (numbers, node conditions, namespaces)
  const grounding = groundingCheck(reply, clusterContext);

  // Only flag when there are 3+ unrecognized pod-like names (to avoid false positives)
  const needsDisclaimer = unrecognized.length >= 3 || !grounding.verified;

  if (needsDisclaimer) {
    const disclaimer = `\n\n> ⚠️ **Grounding notice:** Some resource names in this response could not be verified against live cluster data. Always verify with \`oc get\` before acting.`;
    return reply + disclaimer;
  }

  return reply;
}

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
  const recent = history.slice(-limit);

  if (recent.length <= 6) {
    return recent.map((h) => ({
      role: h.role === "ai" ? "assistant" : "user",
      content: h.text || "",
    }));
  }

  // Summarize older messages into a compact context block so the LLM
  // retains awareness of earlier conversation without consuming full tokens.
  const older = recent.slice(0, -6);
  const latest = recent.slice(-6);

  const summaryParts = [];
  for (const h of older) {
    const text = (h.text || "").substring(0, 300);
    // Extract key entities
    const pods =
      text.match(/\b[a-z][-a-z0-9]*(?:-[a-z0-9]{4,10}){1,2}\b/g) || [];
    const namespaces =
      text.match(/(?:namespace|ns|project)\s+(\S+)/gi) || [];
    const actions =
      text.match(
        /(?:restart|scale|delete|upgrade|rollout|patch|create|apply)\b/gi
      ) || [];
    const role = h.role === "ai" ? "Assistant" : "User";
    const brief = text.replace(/\n+/g, " ").substring(0, 150);
    summaryParts.push(
      `[${role}]: ${brief}` +
        (pods.length
          ? " | Pods: " + [...new Set(pods)].slice(0, 3).join(", ")
          : "") +
        (actions.length
          ? " | Actions: " + [...new Set(actions)].join(", ")
          : "")
    );
  }

  const summaryMsg = {
    role: "system",
    content: `[Conversation summary - earlier messages condensed]\n${summaryParts.join("\n")}`,
  };

  const latestMsgs = latest.map((h) => ({
    role: h.role === "ai" ? "assistant" : "user",
    content: h.text || "",
  }));

  return [summaryMsg, ...latestMsgs];
}

// ---------------------------------------------------------------------------
// Compact delta summary for follow-up messages — only includes actionable
// data (problems, focused resources) to reduce token usage on continuations.
// ---------------------------------------------------------------------------
function summarizeContextDelta(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const parts = [];
  if (ctx.clusterVersion) {
    const ver = typeof ctx.clusterVersion === "object" ? (ctx.clusterVersion.desired || ctx.clusterVersion.version) : ctx.clusterVersion;
    parts.push(`Cluster: ${ver}`);
  }
  if (ctx.nodeCount) parts.push(`Nodes: ${ctx.readyNodes || "?"}/${ctx.nodeCount} ready`);
  if (Array.isArray(ctx.problemPods) && ctx.problemPods.length > 0) {
    parts.push(`Problem pods: ${ctx.problemPods.length} — ${ctx.problemPods.slice(0, 5).map((p) => `${p.name}(${p.reason || p.state})`).join(", ")}`);
  }
  if (ctx.targetPod) parts.push(`Focus: ${ctx.targetPod.name} in ${ctx.targetPod.namespace}`);
  if (ctx._focusPodLogs) parts.push(`Logs (last 200 lines): ${ctx._focusPodLogs.slice(-2000)}`);
  if (Array.isArray(ctx.correlations) && ctx.correlations.length > 0) {
    parts.push(`Root causes: ${ctx.correlations.slice(0, 5).map((c) => `${c.pod}: ${c.likelyCause}`).join("; ")}`);
  }
  if (ctx._autoDiagnosis) {
    const d = ctx._autoDiagnosis;
    parts.push(`Auto-diagnosis: ${d.rootCause || "unknown"} — ${d.fixSuggestion || ""}`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Summarize raw cluster context into concise bullet-point text to reduce
// token usage when sending to the LLM.
// ---------------------------------------------------------------------------
function summarizeContext(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const sections = [];

  if (ctx._remoteCluster) {
    sections.push(`## Active Cluster: ${ctx._remoteCluster} (${ctx.platform || "kubernetes"}, source: ${ctx._source || "agent-cache"})`);
  }

  // --- Cluster version ---
  if (ctx.clusterVersion) {
    const cv = ctx.clusterVersion;
    const ver = cv.desired || cv.version || "unknown";
    const platformLabel = ctx.isOpenShift === false ? "Kubernetes" : "OpenShift";
    const channel = cv.channel || "";
    sections.push(`## Cluster\n- ${platformLabel} ${ver}${channel ? `, channel ${channel}` : ""}`);
  }

  // --- Nodes ---
  if (Array.isArray(ctx.nodes) && ctx.nodes.length > 0) {
    const isReady = (n) => n.ready === true || n.status === "Ready" || n.conditions?.some?.((c) => c.type === "Ready" && c.status === "True");
    const readyCount = ctx.nodes.filter(isReady).length;
    const notReady = ctx.nodes.filter((n) => !isReady(n));
    let nodeLine = `${ctx.nodes.length} nodes (${readyCount} Ready`;
    if (notReady.length > 0) {
      const details = notReady
        .slice(0, 3)
        .map((n) => {
          const pressures = (n.conditions || [])
            .filter((c) => c.type !== "Ready" && c.status === "True")
            .map((c) => c.type);
          return `${n.name || "unknown"}${pressures.length ? " " + pressures.join(",") : ""}`;
        })
        .join("; ");
      nodeLine += `, ${notReady.length} NotReady: ${details}`;
    }
    nodeLine += ")";
    sections.push(`## Nodes\n- ${nodeLine}`);
  }

  // --- Problem pods ---
  if (Array.isArray(ctx.problemPods) && ctx.problemPods.length > 0) {
    const grouped = {};
    for (const p of ctx.problemPods) {
      const state = p.reason || p.state || p.status || "Unknown";
      if (!grouped[state]) grouped[state] = [];
      grouped[state].push(p);
    }
    const lines = [`${ctx.problemPods.length} problem pod(s):`];
    for (const [state, pods] of Object.entries(grouped)) {
      const podBriefs = pods.slice(0, 5).map((p) => {
        const parts = [p.name || "?"];
        if (p.namespace) parts[0] += ` (${p.namespace}`;
        const exitCode = p.exitCode ?? p.containers?.[0]?.exitCode;
        if (exitCode !== undefined && exitCode !== null) parts[0] += `, exitCode=${exitCode}`;
        const reason = p.lastTerminatedReason || p.containers?.[0]?.lastTerminatedReason;
        if (reason) parts[0] += `, ${reason}`;
        if (p.namespace) parts[0] += ")";
        if (p.restartCount !== undefined) parts.push(`restarts=${p.restartCount}`);
        return parts.join(", ");
      });
      lines.push(`  - **${state}**: ${podBriefs.join("; ")}${pods.length > 5 ? ` (+${pods.length - 5} more)` : ""}`);
    }
    sections.push(`## Problem Pods\n${lines.join("\n")}`);
  }

  // --- Operators ---
  if (Array.isArray(ctx.operators) && ctx.operators.length > 0) {
    const degraded = ctx.operators.filter(
      (o) => o.degraded === true || o.available === false || o.status === "Degraded"
    );
    let opLine = `${ctx.operators.length} operators`;
    if (degraded.length > 0) {
      const names = degraded.slice(0, 5).map((o) => o.name || "unknown").join(", ");
      opLine += ` (${degraded.length} degraded: ${names})`;
    } else {
      opLine += " (all available)";
    }
    sections.push(`## Operators\n- ${opLine}`);
  }

  // --- Certificate Expiry ---
  if (Array.isArray(ctx.certificateExpiry) && ctx.certificateExpiry.length > 0) {
    const lines = [`${ctx.certificateExpiry.length} certificate(s) expiring within 90 days:`];
    const sorted = [...ctx.certificateExpiry].sort((a, b) => a.daysLeft - b.daysLeft);
    for (const cert of sorted) {
      const urgency = cert.daysLeft <= 7 ? "CRITICAL" : cert.daysLeft <= 30 ? "WARNING" : "INFO";
      lines.push(`  - **${cert.name}** — expires in **${cert.daysLeft} days** [${urgency}]`);
    }
    sections.push(`## Certificate Expiry\n${lines.join("\n")}`);
  } else if (ctx.intents?.includes("certificate_expiry")) {
    sections.push(`## Certificate Expiry\n- No certificates expiring within 90 days (all healthy)`);
  }
  if (Array.isArray(ctx.pendingCSRs) && ctx.pendingCSRs.length > 0) {
    const lines = [`${ctx.pendingCSRs.length} pending CSR(s):`];
    for (const csr of ctx.pendingCSRs.slice(0, 10)) {
      lines.push(`  - **${csr.name}** — requestor: ${csr.requestor || "unknown"}, signer: ${csr.signerName || "?"}, created: ${csr.created || "?"}`);
    }
    sections.push(`## Pending CSRs\n${lines.join("\n")}`);
  }

  // --- Focused deployment (when user asks about a specific deployment) ---
  if (ctx.targetDeployment) {
    const dep = ctx.targetDeployment;
    const lines = [
      `**${dep.name}** in namespace \`${dep.namespace}\``,
      `- Desired replicas: ${dep.replicas}`,
      `- Ready: ${dep.readyReplicas}, Available: ${dep.availableReplicas}, Unavailable: ${dep.unavailableReplicas || 0}`,
      `- Strategy: ${dep.strategy || "unknown"}`,
      `- Image: \`${dep.image || "unknown"}\``,
    ];
    if (Array.isArray(dep.conditions) && dep.conditions.length > 0) {
      lines.push("- Conditions:");
      for (const c of dep.conditions) {
        lines.push(`  - ${c.type}: ${c.status}${c.reason ? ` (${c.reason})` : ""}${c.message ? ` — ${c.message}` : ""}`);
      }
    }
    if (Array.isArray(ctx.targetDeploymentPods)) {
      if (ctx.targetDeploymentPods.length === 0) {
        lines.push("- **No pods found** for this deployment");
      } else {
        lines.push(`- Pods (${ctx.targetDeploymentPods.length}):`);
        for (const p of ctx.targetDeploymentPods.slice(0, 10)) {
          const containers = p.containers?.map((c) => `${c.name}:${c.state}${c.restarts ? `(${c.restarts} restarts)` : ""}`).join(", ") || "?";
          const failConds = (p.conditions || []).map((c) => `${c.type}:${c.reason || c.message || ""}`).join(", ");
          lines.push(`  - ${p.name}: phase=${p.phase || "?"}, containers=[${containers}]${failConds ? `, issues=[${failConds}]` : ""}`);
        }
      }
    }
    if (Array.isArray(ctx.targetDeploymentReplicaSets) && ctx.targetDeploymentReplicaSets.length > 0) {
      lines.push("- ReplicaSets:");
      for (const rs of ctx.targetDeploymentReplicaSets) {
        lines.push(`  - ${rs.name}: ${rs.ready}/${rs.replicas} ready`);
      }
    }
    if (Array.isArray(ctx.targetDeploymentEvents) && ctx.targetDeploymentEvents.length > 0) {
      lines.push("- Recent events:");
      for (const e of ctx.targetDeploymentEvents.slice(0, 8)) {
        lines.push(`  - [${e.type}] ${e.reason}: ${(e.message || "").substring(0, 150)}`);
      }
    }
    sections.push(`## Target Deployment\n${lines.join("\n")}`);
  }

  // --- Focus pod (keep as structured JSON for detailed diagnosis) ---
  if (ctx._focusPod) {
    const focus = {
      _focusPod: ctx._focusPod,
    };
    if (ctx._focusPodLogs) focus._focusPodLogs = ctx._focusPodLogs;
    if (ctx._focusPodLogsPrevious) focus._focusPodLogsPrevious = ctx._focusPodLogsPrevious;
    if (ctx._focusPodLogsError) focus._focusPodLogsError = ctx._focusPodLogsError;
    if (ctx._focusPodEvents) focus._focusPodEvents = ctx._focusPodEvents;
    if (ctx._focusPodMetrics) focus._focusPodMetrics = ctx._focusPodMetrics;
    sections.push(`## Focus Pod (detailed)\n\`\`\`json\n${JSON.stringify(focus, null, 2)}\n\`\`\``);
  }

  // --- Correlations ---
  if (Array.isArray(ctx.correlations) && ctx.correlations.length > 0) {
    const lines = ctx.correlations.slice(0, 10).map((c) => {
      let line = `- **${c.pod || "unknown"}** (${c.namespace || "?"}) — ${c.likelyCause || "unknown cause"}`;
      if (Array.isArray(c.evidence) && c.evidence.length > 0) {
        line += ": " + c.evidence.slice(0, 3).join("; ");
      }
      return line;
    });
    sections.push(`## Correlations\n${lines.join("\n")}`);
  }

  // --- Events (last 5 relevant) ---
  if (Array.isArray(ctx.events) && ctx.events.length > 0) {
    const relevant = ctx.events
      .filter((e) => e.type === "Warning" || e.reason === "BackOff" || e.reason === "OOMKilling" || e.reason === "Failed" || e.reason === "Unhealthy" || e.reason === "FailedScheduling")
      .slice(0, 5);
    const evts = (relevant.length > 0 ? relevant : ctx.events.slice(0, 5)).map((e) => {
      return `- [${e.type || "?"}] ${e.reason || "?"}: ${(e.message || "").substring(0, 120)}${e.namespace ? " (" + e.namespace + ")" : ""}`;
    });
    sections.push(`## Events (recent)\n${evts.join("\n")}`);
  }

  // --- Deployments ---
  if (Array.isArray(ctx.deployments) && ctx.deployments.length > 0) {
    const unhealthy = ctx.deployments.filter(
      (d) => d.availableReplicas < d.replicas || d.unavailableReplicas > 0
    );
    if (unhealthy.length > 0) {
      const lines = unhealthy.slice(0, 5).map(
        (d) => `- ${d.name} (${d.namespace || "?"}): ${d.availableReplicas || 0}/${d.replicas || "?"} ready`
      );
      sections.push(`## Deployments (unhealthy)\n${lines.join("\n")}`);
    } else {
      sections.push(`## Deployments\n- ${ctx.deployments.length} deployment(s), all healthy`);
    }
  }

  // --- RBAC / Access ---
  if (Array.isArray(ctx.rbacBindings) && ctx.rbacBindings.length > 0) {
    const byRole = {};
    for (const b of ctx.rbacBindings) {
      if (!byRole[b.role]) byRole[b.role] = [];
      byRole[b.role].push(`${b.kind}/${b.name}${b.ns ? " (" + b.ns + ")" : ""}`);
    }
    const lines = [];
    for (const [role, subjects] of Object.entries(byRole)) {
      lines.push(`- **${role}**: ${subjects.slice(0, 10).join(", ")}${subjects.length > 10 ? ` (+${subjects.length - 10} more)` : ""}`);
    }
    sections.push(`## RBAC Bindings\n${lines.join("\n")}`);
  }
  if (Array.isArray(ctx.ocpUsers) && ctx.ocpUsers.length > 0) {
    const userLines = ctx.ocpUsers.slice(0, 15).map(u => `- ${u.name}${u.fullName ? ` (${u.fullName})` : ""}${u.identities?.length ? ` — ${u.identities.join(", ")}` : ""}`);
    sections.push(`## OpenShift Users (${ctx.ocpUsers.length})\n${userLines.join("\n")}`);
  }
  if (Array.isArray(ctx.ocpGroups) && ctx.ocpGroups.length > 0) {
    const groupLines = ctx.ocpGroups.slice(0, 10).map(g => `- **${g.name}**: ${g.members?.slice(0, 5).join(", ") || "empty"}${g.members?.length > 5 ? ` (+${g.members.length - 5})` : ""}`);
    sections.push(`## OpenShift Groups (${ctx.ocpGroups.length})\n${groupLines.join("\n")}`);
  }

  // --- Any remaining top-level keys that might carry useful data ---
  const summarizedKeys = new Set([
    "clusterVersion", "nodes", "problemPods", "operators",
    "_focusPod", "_focusPodLogs", "_focusPodLogsPrevious",
    "_focusPodLogsError", "_focusPodEvents", "_focusPodMetrics",
    "correlations", "events", "deployments",
    "targetPod", "targetPodName", "targetPodLogs",
    "targetPodLogsPrevious", "targetPodLogsError",
    "targetPodEvents", "targetPodMetrics", "queryFilter",
    "targetDeployment", "targetDeploymentPods",
    "targetDeploymentReplicaSets", "targetDeploymentEvents",
    "targetResourceName", "targetResourceType",
    "certificateExpiry", "pendingCSRs",
    "rbacBindings", "ocpUsers", "ocpGroups",
  ]);
  const remaining = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (!summarizedKeys.has(key) && value !== null && value !== undefined) {
      remaining[key] = value;
    }
  }
  if (Object.keys(remaining).length > 0) {
    // Include remaining data as compact JSON so nothing is lost
    const compactJson = JSON.stringify(remaining);
    // Only include if reasonably sized
    if (compactJson.length < 3000) {
      sections.push(`## Additional Data\n\`\`\`json\n${compactJson}\n\`\`\``);
    } else {
      // Truncate to keep token budget manageable
      sections.push(`## Additional Data (truncated)\n\`\`\`json\n${compactJson.substring(0, 3000)}...\n\`\`\``);
    }
  }

  const MAX_CONTEXT_CHARS = 12000;
  let result = sections.join("\n\n");
  if (result.length > MAX_CONTEXT_CHARS) {
    result = result.slice(0, MAX_CONTEXT_CHARS) + "\n\n[Context truncated to fit token budget]";
  }
  return result;
}

async function callLLMWithContext(userMessage, clusterContext, opts = {}) {
  const provider = opts.provider || LLM_PROVIDER;
  if (!provider || provider === "none") {
    return builtInAnalysis(userMessage, clusterContext);
  }

  // When a specific resource is the target, filter out unrelated cluster-wide
  // data so the LLM focuses on the relevant resource.
  const ctx = { ...clusterContext };

  // For deployment-specific queries: remove unrelated problem pods and correlations
  if (ctx.targetDeployment) {
    const depNs = ctx.targetDeployment.namespace;
    const depName = ctx.targetDeployment.name;
    if (Array.isArray(ctx.problemPods)) {
      ctx.problemPods = ctx.problemPods.filter(
        (p) => p.namespace === depNs && (p.ownerName?.includes(depName) || p.name?.includes(depName))
      );
    }
    if (Array.isArray(ctx.correlations)) {
      ctx.correlations = ctx.correlations.filter(
        (c) => c.namespace === depNs && (c.ownerName?.includes(depName) || c.pod?.includes(depName))
      );
    }
  }

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
    // Also filter correlations to the target pod's namespace only
    if (Array.isArray(ctx.correlations) && ctx.targetPod) {
      ctx.correlations = ctx.correlations.filter(
        (c) => c.namespace === ctx.targetPod.namespace
      );
    }
    // Merge focused data first so it appears at the top of the JSON
    Object.assign(focused, ctx);
    Object.assign(ctx, focused);
  }

  // Run Pod Doctor auto-diagnosis when we have a focused pod
  if (ctx.targetPod || ctx._focusPod) {
    const pod = ctx._focusPod || ctx.targetPod;
    const autoFix = diagnosePod(pod, {
      events: ctx._focusPodEvents || ctx.targetPodEvents || [],
      logs: ctx._focusPodLogs || ctx.targetPodLogs || "",
      logsPrevious: ctx._focusPodLogsPrevious || ctx.targetPodLogsPrevious || "",
      metrics: ctx._focusPodMetrics || ctx.targetPodMetrics || null,
    });
    ctx._autoDiagnosis = autoFix;
  }

  // Apply context optimizations
  try { Object.assign(ctx, compressContext(ctx)); } catch { /* optimizer optional */ }
  if (ctx._focusPod || ctx.targetPod) {
    try {
      ctx._diagnosticBrief = buildDiagnosticBrief(
        ctx._focusPod || ctx.targetPod,
        ctx._focusPodEvents || ctx.targetPodEvents || [],
        ctx._focusPodLogs || ctx.targetPodLogs || "",
        ctx._autoDiagnosis
      );
    } catch { /* brief optional */ }
  }

  let contextStr;
  try {
    const primaryIntent = (ctx.intents || [])[0] || "cluster_health";
    contextStr = buildTieredContext(ctx, primaryIntent);
  } catch {
    contextStr = summarizeContext(ctx);
  }
  if (ctx._diagnosticBrief) {
    contextStr += `\n\n## Diagnostic Brief\n${JSON.stringify(ctx._diagnosticBrief, null, 2)}`;
  }
  const userContent = `${userMessage}\n\n--- Live Cluster Data ---\n${contextStr}`;

  // Build messages array, optionally including conversation history
  const priorMessages = historyToMessages(opts.history);
  const messages = [
    ...priorMessages,
    { role: "user", content: userContent },
  ];

  try {
    const basePrompt = buildSystemPrompt(userMessage, opts.context);
    const augmentedSystem = await augmentSystemPrompt(basePrompt, {
      parsed: opts.parsed || null,
      userId: opts.userId || null,
      conversationId: opts.conversationId || null,
    });
    const r = await callLLM({
      messages,
      system: augmentedSystem,
      maxTokens: 2000,
      temperature: 0.15,
      provider: opts.provider,
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      azureDeployment: opts.azureDeployment,
      azureApiVersion: opts.azureApiVersion,
    });
    let reply = validateResponse(r.text, clusterContext) || builtInAnalysis(userMessage, clusterContext);
    reply = appendFixProposals(reply, ctx);
    return reply;
  } catch (err) {
    let reply = `LLM Error: ${err.message}\n\n---\n\n${builtInAnalysis(userMessage, clusterContext)}`;
    reply = appendFixProposals(reply, clusterContext);
    return reply;
  }
}

function appendFixProposals(reply, ctx) {
  const diag = ctx?._autoDiagnosis;
  if (!diag || !diag.fixes || diag.fixes.length === 0) return reply;
  const fixJson = JSON.stringify(diag).replace(/@@/g, "@ @");
  return reply + `\n\n@@FIX_PROPOSAL|${fixJson}@@`;
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
  if (intents.includes("specific_pod") && !ctx.targetPod && ctx.targetPodName) {
    parts.push(`### Pod Not Found: \`${ctx.targetPodName}\``);
    parts.push(`[WARNING] Could not find pod **${ctx.targetPodName}** in the cluster.`);
    parts.push(`The pod may have been deleted, evicted, or the name may be incorrect.`);
    parts.push(`\n#### Suggestions`);
    parts.push(`  - Check if the pod still exists: \`oc get pod ${ctx.targetPodName} --all-namespaces\``);
    parts.push(`  - List pods in the expected namespace: \`oc get pods -n <namespace>\``);
    parts.push(`  - Check recent events: \`oc get events --all-namespaces --sort-by=.lastTimestamp | grep ${ctx.targetPodName}\``);
    return parts.join("\n");
  }
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
  // --- Certificate Expiry ---
  if (intents.includes("certificate_expiry")) {
    if (Array.isArray(ctx.certificateExpiry) && ctx.certificateExpiry.length > 0) {
      const sorted = [...ctx.certificateExpiry].sort((a, b) => a.daysLeft - b.daysLeft);
      const critical = sorted.filter((c) => c.daysLeft <= 7);
      const warning = sorted.filter((c) => c.daysLeft > 7 && c.daysLeft <= 30);
      const info = sorted.filter((c) => c.daysLeft > 30);
      parts.push(`### Certificate Expiry — ${sorted.length} certificate(s) expiring`);
      if (critical.length > 0) {
        parts.push(`\n**[CRITICAL] ${critical.length} certificate(s) expiring within 7 days:**`);
        critical.forEach((c) => parts.push(`  - **${c.name}** — expires in **${c.daysLeft} days**`));
      }
      if (warning.length > 0) {
        parts.push(`\n**[WARNING] ${warning.length} certificate(s) expiring within 30 days:**`);
        warning.forEach((c) => parts.push(`  - **${c.name}** — expires in **${c.daysLeft} days**`));
      }
      if (info.length > 0) {
        parts.push(`\n${info.length} certificate(s) expiring within 90 days:`);
        info.forEach((c) => parts.push(`  - **${c.name}** — expires in **${c.daysLeft} days**`));
      }
      parts.push(`\n#### What to do`);
      parts.push(`1. Check pending CSRs: \`oc get csr\``);
      parts.push(`2. Approve pending CSRs: \`oc adm certificate approve <csr-name>\``);
      parts.push(`3. OpenShift auto-rotates most certificates. If certs are not rotating, check:`);
      parts.push(`   - \`oc get co kube-apiserver -o yaml\` — look for cert rotation conditions`);
      parts.push(`   - \`oc get co ingress -o yaml\` — check ingress operator status`);
      parts.push(`4. For custom certificates, manually renew before expiry`);
      if (critical.length > 0) {
        parts.push(`\n> **Immediate action required** — certificates expiring in ≤7 days will cause API server or ingress failures if not renewed.`);
      }
    } else {
      parts.push(`### Certificate Expiry`);
      parts.push(`All certificates are healthy — no certificates expiring within 90 days.`);
      parts.push(`\nTo check manually: \`oc get csr\``);
    }
    if (Array.isArray(ctx.pendingCSRs) && ctx.pendingCSRs.length > 0) {
      parts.push(`\n### Pending Certificate Signing Requests (${ctx.pendingCSRs.length})`);
      ctx.pendingCSRs.slice(0, 10).forEach((csr) => {
        parts.push(`  - **${csr.name}** — requestor: ${csr.requestor || "unknown"}, signer: ${csr.signerName || "?"}`);
      });
      parts.push(`\nApprove with: \`oc adm certificate approve <csr-name>\``);
    }
    return parts.join("\n");
  }

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
2. Wrap each executable command in @@SEC_FIX_CMD|<command>@@ tags so the UI can render Dry Run / Run buttons. Place these on their OWN LINE as plain text — NEVER wrap them inside code fences or backtick blocks.
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
- Use @@SEC_FIX_CMD|<exact oc/kubectl command>@@ for executable commands — place on own line as plain text, NEVER inside code fences
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

const OPTIMIZATION_REMEDIATION_PROMPT = `You are a senior Kubernetes/OpenShift FinOps and SRE performance architect. You provide production-grade optimization recommendations aligned with industry frameworks (Gartner FinOps, CNCF Best Practices, CIS Kubernetes Benchmark, Google SRE Workbook).

Analyze the cluster optimization findings below and provide DEEP, ACTIONABLE remediation with executable commands.

CRITICAL REQUIREMENTS:
1. For EACH finding, provide EXACT oc/kubectl commands targeting the REAL resource names from the findings.
2. Wrap each executable command in @@SEC_FIX_CMD|<command>@@ tags so the UI can render Dry Run / Run buttons. Place these on their OWN LINE as plain text — NEVER wrap them inside markdown code fences or backtick blocks.
3. Prioritize by severity — CRITICAL findings first (under-provisioned, capacity warnings).
4. Quantify impact in resource units (cores, GiB) — do NOT include dollar amounts or cost estimates.
5. Reference industry benchmarks and compliance standards where applicable.

FOR OVER-PROVISIONED PODS:
- Calculate a right-sized CPU request: P95 actual usage + 25% buffer, rounded to nearest 50m (Gartner right-sizing methodology)
- Calculate a right-sized memory request: peak usage + 20% buffer, rounded to nearest 32Mi
- Provide oc patch commands for each pod's owning Deployment/StatefulSet
- Quantify reclaim potential in cores and GiB for each pod
- Suggest VPA (Vertical Pod Autoscaler) with updateMode: "Auto" for namespaces with 5+ over-provisioned pods
- Recommend Resource Quota enforcement at namespace level

FOR UNDER-PROVISIONED PODS:
- Calculate proper CPU request: current P99 usage + 30% buffer (accounts for traffic spikes)
- Set limits to 2x requests (burstable QoS) unless workload is latency-sensitive (then Guaranteed QoS)
- Provide oc patch commands to increase CPU/memory requests AND limits
- Add HPA with target CPU utilization 70% (CNCF recommended) for horizontally scalable workloads
- Warn about OOMKill risk with specific memory utilization ratios
- Reference: Kubernetes QoS classes and eviction thresholds

FOR PODS WITHOUT RESOURCE LIMITS:
- This violates CIS Kubernetes Benchmark 5.4.1 (Ensure that each container has resource limits set)
- Provide oc patch commands with industry-standard defaults based on workload type:
  - Web apps: cpu 500m/1000m, memory 256Mi/512Mi
  - Workers: cpu 250m/500m, memory 128Mi/256Mi
  - Databases: cpu 1000m/2000m, memory 1Gi/2Gi
- Create LimitRange objects enforcing namespace-wide defaults
- Create ResourceQuota to prevent namespace resource sprawl
- Include compliance assessment: what % of pods are non-compliant vs CIS target (100%)

FOR ORPHANED PVCs AND STORAGE WASTE:
- Identify PVCs that are bound but unmounted for extended periods
- Provide oc delete pvc commands with safety verification steps
- Quantify storage reclaim in GiB
- Suggest implementing a storage reclaim policy (Delete vs Retain tradeoffs)
- Recommend adding labels/annotations for ownership tracking
- Check for Released PVs that can be cleaned up
- Suggest StorageClass configurations with reclaimPolicy: Delete for non-critical data

FOR HIGH-RESTART PODS:
- Provide oc logs --previous commands to check last crash logs
- Check exit codes: 137 = OOMKilled (increase memory), 1 = app error, 143 = SIGTERM
- For OOMKilled: increase memory limit by 50% and set request = 80% of limit
- For CrashLoopBackOff: check liveness probe timing (increase initialDelaySeconds)
- Provide oc describe pod to identify event patterns
- Suggest PodDisruptionBudget if restarts affect availability

FOR CLUSTER CAPACITY:
- Assess node utilization distribution (check for hot nodes)
- Suggest scaling MachineSets with specific replica counts based on headroom deficit
- Calculate how many nodes needed to reach 25% headroom target
- Recommend ClusterAutoscaler with min/max bounds
- Consider spot/preemptible nodes for fault-tolerant workloads
- Reference: Google SRE "target 50% utilization for headroom during incidents"

ADVANCED RECOMMENDATIONS:
- Suggest namespace-level cost allocation using labels and showback reports
- Recommend implementing PodPriority and PriorityClasses for workload tiering
- Consider node affinity rules to bin-pack non-critical workloads
- Suggest Goldilocks or Kubecost for continuous right-sizing visibility

FORMAT:
- Use markdown headers (###) for each section
- Use numbered steps within each section
- Use @@SEC_FIX_CMD|<exact command>@@ for executable commands — place these on their OWN LINE as plain text, NEVER inside code fences or backtick blocks
- Add brief explanation before each command
- Include verification commands after fixes (e.g., oc get pod -w to watch rollout)
- End with a "Quick Wins" summary table: action | effort | resource impact

IMPORTANT: Generate REAL commands with ACTUAL resource names from the findings. Do NOT use placeholders like <pod-name>. Do NOT include dollar amounts or cost estimates — express impact in resource units (cores, GiB, pod count) only.`;

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
- Efficiency Score: ${clusterStats.effScore || "N/A"}/100 (Grade: ${clusterStats.grade || "N/A"})
- Reclaimable CPU: ${clusterStats.reclaimCores || 0} cores
- Reclaimable Memory: ${clusterStats.reclaimMemGi || 0} GiB
- Orphaned Storage: ${clusterStats.orphanedGi || 0} GiB

${findingsSummary}${learningContext}

Provide deep, production-grade optimization recommendations with executable oc/kubectl commands for each finding. Use the real resource names listed above. Calculate right-sized values based on actual usage data. Quantify impact in resource units (cores, GiB) only — do NOT include dollar amounts or cost estimates. Reference industry standards (CIS, FinOps, SRE) where applicable. End with a Quick Wins summary table.`;

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
      case "orphaned-pvcs":
        for (const it of f.items.slice(0, 8)) {
          lines.push(`  - Delete orphaned PVC \`${it.name}\` in \`${it.ns}\` (${it.size}, unused for ${it.ageDays}+ days):`);
          lines.push(`    @@SEC_FIX_CMD|oc delete pvc ${it.name} -n ${it.ns}@@`);
        }
        if (f.total > 8) lines.push(`  - … and ${f.total - 8} more orphaned PVCs`);
        lines.push(`  - Verify no workloads reference these PVCs before deleting:`);
        lines.push(`    @@SEC_FIX_CMD|oc get pods --all-namespaces -o json | grep -l "persistentVolumeClaim"@@`);
        lines.push(`  - Consider setting a StorageClass reclaim policy to Delete for automatic cleanup`);
        break;
    }
    lines.push(``);
  }
}

// ---------------------------------------------------------------------------
// View-more handler for /recommendations tables
// ---------------------------------------------------------------------------
async function handleViewMoreRecommendation(findingType, offset, limit) {
  const pCpu = (s) => { if (!s) return 0; if (typeof s === "number") return s; if (s.endsWith("n")) return parseInt(s)/1e9; if (s.endsWith("u")) return parseInt(s)/1e6; if (s.endsWith("m")) return parseInt(s)/1e3; return parseFloat(s)||0; };
  const pMem = (s) => { if (!s) return 0; if (typeof s === "number") return s; if (s.endsWith("Ki")) return parseInt(s)*1024; if (s.endsWith("Mi")) return parseInt(s)*1048576; if (s.endsWith("Gi")) return parseInt(s)*1073741824; return parseInt(s)||0; };
  const fmtCpu = (v) => v < 0.01 ? Math.round(v * 1000) + "m" : v.toFixed(2);
  const fmtMem = (v) => v > 1073741824 ? (v / 1073741824).toFixed(1) + "Gi" : (v / 1048576).toFixed(0) + "Mi";

  try {
    const [pods, metrics, pvcs] = await Promise.all([
      ocpGet("/api/v1/pods"),
      ocpGet("/apis/metrics.k8s.io/v1beta1/pods").catch(() => ({ items: [] })),
      ocpGet("/api/v1/persistentvolumeclaims").catch(() => ({ items: [] })),
    ]);

    const userPods = (pods.items || []).filter((p) => p.status?.phase === "Running" && !p.metadata.namespace?.startsWith("openshift-") && !p.metadata.namespace?.startsWith("kube-"));
    const metricsMap = {};
    for (const m of (metrics.items || [])) {
      let cpu = 0, mem = 0;
      for (const c of (m.containers || [])) { cpu += pCpu(c.usage?.cpu); mem += pMem(c.usage?.memory); }
      metricsMap[`${m.metadata.namespace}/${m.metadata.name}`] = { cpu, mem };
    }

    let allItems = [];
    let headers = "";
    let headerSep = "";

    if (findingType === "over-provisioned") {
      for (const p of userPods) {
        const key = `${p.metadata.namespace}/${p.metadata.name}`;
        const usage = metricsMap[key];
        let reqCpu = 0, haslim = false;
        for (const c of (p.spec?.containers || [])) { reqCpu += pCpu(c.resources?.requests?.cpu); if (c.resources?.limits?.cpu || c.resources?.limits?.memory) haslim = true; }
        if (!haslim || !usage || reqCpu <= 0) continue;
        if (usage.cpu < reqCpu * 0.1 && reqCpu >= 0.1) {
          allItems.push({ ns: p.metadata.namespace, pod: p.metadata.name, reqCpu: fmtCpu(reqCpu), usageCpu: fmtCpu(usage.cpu), util: Math.round((usage.cpu / reqCpu) * 100) });
        }
      }
      headers = "| Namespace | Pod | CPU Request | CPU Usage | Utilization |";
      headerSep = "|---|---|---|---|---|";
    } else if (findingType === "under-provisioned") {
      for (const p of userPods) {
        const key = `${p.metadata.namespace}/${p.metadata.name}`;
        const usage = metricsMap[key];
        let reqCpu = 0, haslim = false;
        for (const c of (p.spec?.containers || [])) { reqCpu += pCpu(c.resources?.requests?.cpu); if (c.resources?.limits?.cpu || c.resources?.limits?.memory) haslim = true; }
        if (!haslim || !usage || reqCpu <= 0) continue;
        if (usage.cpu > reqCpu * 1.5) {
          allItems.push({ ns: p.metadata.namespace, pod: p.metadata.name, reqCpu: fmtCpu(reqCpu), usageCpu: fmtCpu(usage.cpu), util: Math.round((usage.cpu / reqCpu) * 100) });
        }
      }
      headers = "| Namespace | Pod | CPU Request | CPU Usage | Utilization |";
      headerSep = "|---|---|---|---|---|";
    } else if (findingType === "no-limits") {
      for (const p of userPods) {
        let haslim = false;
        for (const c of (p.spec?.containers || [])) { if (c.resources?.limits?.cpu || c.resources?.limits?.memory) haslim = true; }
        if (!haslim) allItems.push({ ns: p.metadata.namespace, pod: p.metadata.name });
      }
      headers = "| Namespace | Pod |";
      headerSep = "|---|---|";
    } else if (findingType === "high-restarts") {
      allItems = (pods.items || []).filter((p) => (p.status?.containerStatuses || []).some((c) => c.restartCount > 5))
        .map((p) => ({ ns: p.metadata.namespace, pod: p.metadata.name, restarts: Math.max(...(p.status?.containerStatuses || []).map((c) => c.restartCount || 0)) }))
        .sort((a, b) => b.restarts - a.restarts);
      headers = "| Namespace | Pod | Restarts |";
      headerSep = "|---|---|---|";
    } else if (findingType === "orphaned-pvcs") {
      const usedPvcs = new Set();
      for (const p of (pods.items || [])) {
        for (const v of (p.spec?.volumes || [])) {
          if (v.persistentVolumeClaim?.claimName) usedPvcs.add(`${p.metadata.namespace}/${v.persistentVolumeClaim.claimName}`);
        }
      }
      for (const pvc of (pvcs.items || [])) {
        const phase = pvc.status?.phase;
        const key = `${pvc.metadata.namespace}/${pvc.metadata.name}`;
        if (phase === "Bound" && !usedPvcs.has(key)) {
          const capBytes = pMem(pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || "0");
          const ageDays = pvc.metadata?.creationTimestamp ? Math.round((Date.now() - new Date(pvc.metadata.creationTimestamp).getTime()) / 86400000) : 0;
          allItems.push({ ns: pvc.metadata.namespace, name: pvc.metadata.name, size: pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || "?", sc: pvc.spec?.storageClassName || "default", ageDays });
        }
      }
      headers = "| Namespace | PVC Name | Size | Storage Class | Age (days) |";
      headerSep = "|---|---|---|---|---|";
    } else {
      return `### Error\nUnknown recommendation type: \`${findingType}\``;
    }

    const total = allItems.length;
    if (offset >= total) return `### ${findingType}\nNo more items to show (${total} total).`;

    const pageItems = allItems.slice(offset, offset + limit);
    const end = Math.min(offset + limit, total);
    const label = findingType.replace(/-/g, " ");
    const parts = [`### ${label} — showing ${offset + 1}–${end} of ${total}`, "", headers, headerSep];

    for (const it of pageItems) {
      if (findingType === "over-provisioned" || findingType === "under-provisioned") {
        parts.push(`| ${it.ns} | ${it.pod} | ${it.reqCpu} | ${it.usageCpu} | ${it.util}% |`);
      } else if (findingType === "no-limits") {
        parts.push(`| ${it.ns} | ${it.pod} |`);
      } else if (findingType === "high-restarts") {
        parts.push(`| ${it.ns} | ${it.pod} | ${it.restarts} |`);
      } else if (findingType === "orphaned-pvcs") {
        parts.push(`| ${it.ns} | ${it.name} | ${it.size} | ${it.sc} | ${it.ageDays} |`);
      }
    }

    if (end < total) {
      parts.push(`\n@@VIEW_MORE_REC|${findingType}|${end}|${total}@@`);
    }

    return parts.join("\n");
  } catch (err) {
    return `### Error\n[CRITICAL] Failed to load recommendation data: ${err.message}`;
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

  // --- Right-size: emit interactive apply cards from real optimization data ---
  if (cmd === "rightsize" || cmd === "right-size") {
    try {
      const { handleDashboardAPI } = await import("./dashboard-api.js");
      // Capture the optimization JSON without an HTTP round-trip — reuses the
      // exact same analysis the dashboard uses (no logic duplication).
      let captured = null;
      const fakeRes = { writeHead() {}, setHeader() {}, end(b) { captured = b; } };
      await handleDashboardAPI("/api/dashboard/optimization", { method: "GET" }, fakeRes);
      const data = captured ? JSON.parse(captured) : {};
      const problems = (data.topProblems || []).filter((p) => p.type === "over" || p.type === "under");
      if (problems.length === 0) {
        return { reply: "### Right-sizing\n[OK] No workloads need right-sizing — requests are well matched to actual usage.", contextKeys: ["slash", "rightsize"] };
      }
      const lines = [
        "### Right-sizing recommendations",
        "",
        `I analyzed running workloads and found **${problems.length}** that should be right-sized. Each card shows the current vs recommended requests — dry-run first, then apply through the guardrailed execution path.`,
        "",
      ];
      for (const p of problems.slice(0, 8)) {
        lines.push("@@RIGHTSIZE|" + JSON.stringify(p) + "@@");
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "rightsize"] };
    } catch (e) {
      return { reply: `[ERROR] Right-sizing analysis unavailable: ${e.message}`, contextKeys: ["slash", "rightsize"] };
    }
  }

  // --- Triage: emit interactive fix cards for failing pods ---
  if (cmd === "triage") {
    try {
      const { handleDashboardAPI } = await import("./dashboard-api.js");
      let captured = null;
      const fakeRes = { writeHead() {}, setHeader() {}, end(b) { captured = b; } };
      await handleDashboardAPI("/api/pods/issues", { method: "GET" }, fakeRes);
      const pods = captured ? JSON.parse(captured) : [];
      const parseMi = (s) => {
        if (!s) return 0;
        const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(Gi|Mi|G|M|Ki|K)?$/i);
        if (!m) return 0;
        const n = parseFloat(m[1]); const u = (m[2] || "Mi").toLowerCase();
        if (u === "gi" || u === "g") return Math.round(n * 1024);
        if (u === "ki" || u === "k") return Math.round(n / 1024);
        return Math.round(n);
      };
      const cards = [];
      for (const p of pods) {
        const wl = p.workload; // {kind,name} | null
        for (const it of (p.issues || [])) {
          const reason = String(it.reason || "");
          let fixKind = null, memNew = null;
          if (/OOMKilled/i.test(reason)) {
            fixKind = "memory";
            const cur = parseMi(it.memLimit) || parseMi(it.memReq) || 256;
            memNew = Math.max(128, cur * 2);
          } else if (/CrashLoopBackOff/i.test(reason) || /restarts/i.test(reason)) {
            fixKind = "restart";
          } else if (/ImagePullBackOff|ErrImagePull/i.test(reason)) {
            fixKind = "investigate";
          } else continue;
          cards.push({
            pod: p.name, ns: p.namespace, workload: wl, container: it.container,
            reason, restarts: it.restarts, fixKind,
            memLimit: it.memLimit || "", memNew, image: it.image || "",
          });
        }
      }
      if (cards.length === 0) {
        return { reply: "### Pod triage\n[OK] No failing pods — nothing to triage.", contextKeys: ["slash", "triage"] };
      }
      const lines = [
        "### Pod failure triage",
        "",
        `Found **${cards.length}** failing container${cards.length === 1 ? "" : "s"}. Each card proposes a remediation — dry-run, then apply and verify through the guardrailed path.`,
        "",
      ];
      for (const c of cards.slice(0, 10)) lines.push("@@TRIAGE|" + JSON.stringify(c) + "@@");
      return { reply: lines.join("\n"), contextKeys: ["slash", "triage"] };
    } catch (e) {
      return { reply: `[ERROR] Triage unavailable: ${e.message}`, contextKeys: ["slash", "triage"] };
    }
  }

  // --- Plan: decompose a goal into executable steps (Pillar 4) ---
  if (cmd === "plan") {
    const goal = rest.join(" ").trim();
    if (!goal) {
      return {
        reply: "## Task Planner\n\nUse `/plan <goal>` to decompose a complex task into executable steps.\n\n**Examples:**\n- `/plan migrate namespace dev to prod`\n- `/plan upgrade cluster to 4.16`\n- `/plan right-size workloads`\n- `/plan backup all critical apps`\n- `/plan security audit`\n- `/plan scale deployment my-app to 5`\n\nThe planner will generate a step-by-step plan with dry-run commands, rollback steps, and approval gates for critical actions.",
        contextKeys: ["slash", "plan"],
      };
    }
    try {
      const planner = await import("./task-planner.js");
      const plan = planner.createPlan(goal, { conversationId });
      const tag = planner.renderPlanTag(plan);
      return {
        reply: `## Task Plan: ${goal}\n\nGenerated a ${plan.steps.length}-step plan. Review each step below — you can Dry Run safe operations to preview, then Execute or Mark Done as you progress.\n\n${tag}\n\nTip: Click **Approve Plan** to mark it as approved. Use **Rollback** if anything goes wrong — completed steps with rollback commands will be reverted in reverse order.`,
        contextKeys: ["slash", "plan"],
      };
    } catch (e) {
      return { reply: `[ERROR] Plan creation failed: ${e.message}`, contextKeys: ["slash", "plan"] };
    }
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
      const [pods, metrics, nodes, pvcs, pvs] = await Promise.all([
        ocpGet("/api/v1/pods"),
        ocpGet("/apis/metrics.k8s.io/v1beta1/pods").catch(() => ({ items: [] })),
        ocpGet("/api/v1/nodes"),
        ocpGet("/api/v1/persistentvolumeclaims").catch(() => ({ items: [] })),
        ocpGet("/api/v1/persistentvolumes").catch(() => ({ items: [] })),
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
      let wastedCpu = 0, wastedMem = 0;
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
          wastedCpu += reqCpu - usage.cpu;
          wastedMem += Math.max(0, reqMem - usage.mem);
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

      // ── PVC & Storage Analysis ──
      const pvcItems = pvcs.items || [];
      const pvItems = pvs.items || [];
      const usedPvcs = new Set();
      for (const p of (pods.items || [])) {
        for (const v of (p.spec?.volumes || [])) {
          if (v.persistentVolumeClaim?.claimName) usedPvcs.add(`${p.metadata.namespace}/${v.persistentVolumeClaim.claimName}`);
        }
      }
      let pvcBound = 0, pvcOrphaned = 0, totalPvcGi = 0, orphanedGi = 0;
      const orphanedPvcs = [], lowUtilPvcs = [];
      for (const pvc of pvcItems) {
        const phase = pvc.status?.phase;
        if (phase === "Bound") pvcBound++;
        const capBytes = pMem(pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || "0");
        const capGi = capBytes / (1024 * 1024 * 1024);
        totalPvcGi += capGi;
        const key = `${pvc.metadata.namespace}/${pvc.metadata.name}`;
        const isOrphaned = phase === "Bound" && !usedPvcs.has(key);
        if (isOrphaned) {
          pvcOrphaned++;
          orphanedGi += capGi;
          const ageDays = pvc.metadata?.creationTimestamp ? Math.round((Date.now() - new Date(pvc.metadata.creationTimestamp).getTime()) / 86400000) : 0;
          orphanedPvcs.push({ name: pvc.metadata.name, ns: pvc.metadata.namespace, size: pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || "?", sizeGi: Math.round(capGi * 10) / 10, sc: pvc.spec?.storageClassName || "default", ageDays });
        }
      }

      // ── Efficiency Score (industry-standard weighted) ──
      const sizingScore = userPods.length > 0 ? Math.max(0, 100 - ((over + under) / userPods.length) * 100) : 100;
      const limitsScore = userPods.length > 0 ? Math.max(0, 100 - (noLim / userPods.length) * 100) : 100;
      const headroomScore = Math.min(100, ((cpuH + memH) / 2) * 2.5);
      const pvcScore = pvcItems.length > 0 ? Math.max(0, 100 - (pvcOrphaned / pvcItems.length) * 100) : 100;
      const effScore = Math.round((sizingScore * 0.35) + (limitsScore * 0.25) + (headroomScore * 0.20) + (pvcScore * 0.20));
      const grade = effScore >= 90 ? "A" : effScore >= 80 ? "B" : effScore >= 70 ? "C" : effScore >= 60 ? "D" : "F";

      // ── Reclaim potential ──
      const reclaimCores = Math.round(wastedCpu * 10) / 10;
      const reclaimMemGi = Math.round((wastedMem / (1024 * 1024 * 1024)) * 10) / 10;

      const recProvider = llmOpts.provider || LLM_PROVIDER;
      const hasLLM = recProvider && recProvider !== "none";

      const lines = [
        `## Cluster Resource Optimization Report`,
        ``,
        `@@SUMMARY|${grade === "A" || grade === "B" ? "green" : grade === "C" ? "amber" : "red"}:${grade} Efficiency (${effScore}/100)|amber:${over} Over-provisioned|${under > 0 ? "red" : "green"}:${under} Under-provisioned|${noLim > 0 ? "amber" : "green"}:${noLim} No Limits@@`,
        ``,
        `### Efficiency Scorecard`,
        ``,
        `| Category | Score | Weight | Industry Benchmark | Status |`,
        `|---|---|---|---|---|`,
        `| Pod Right-Sizing | ${Math.round(sizingScore)}/100 | 35% | >85 (Gartner) | ${sizingScore >= 85 ? "Pass" : sizingScore >= 70 ? "Needs Work" : "**Failing**"} |`,
        `| Resource Limits Coverage | ${Math.round(limitsScore)}/100 | 25% | 100% required (CIS) | ${limitsScore >= 95 ? "Pass" : limitsScore >= 80 ? "Needs Work" : "**Failing**"} |`,
        `| Cluster Headroom | ${Math.round(headroomScore)}/100 | 20% | 20-40% (SRE best practice) | ${cpuH >= 20 && memH >= 20 ? "Pass" : cpuH >= 10 && memH >= 10 ? "Needs Work" : "**Failing**"} |`,
        `| Storage Efficiency | ${Math.round(pvcScore)}/100 | 20% | <5% orphaned (FinOps) | ${pvcScore >= 95 ? "Pass" : pvcScore >= 80 ? "Needs Work" : "**Failing**"} |`,
        `| **Overall Grade** | **${effScore}/100 (${grade})** | | **>80 target** | ${effScore >= 80 ? "**Healthy**" : effScore >= 60 ? "**Needs Improvement**" : "**Critical**"} |`,
        ``,
        `### Cluster Resources`,
        ``,
        `| Metric | Current | Benchmark | Assessment |`,
        `|---|---|---|---|`,
        `| User pods analyzed | ${userPods.length} | — | — |`,
        `| Over-provisioned (<10% CPU util) | ${over} | 0 | ${over === 0 ? "Optimal" : over < 10 ? "Acceptable" : "**Wasting resources**"} |`,
        `| Under-provisioned (>150% CPU util) | ${under} | 0 | ${under === 0 ? "Optimal" : "**Throttling risk**"} |`,
        `| Missing resource limits | ${noLim} | 0 (CIS 5.4.1) | ${noLim === 0 ? "Compliant" : "**Non-compliant**"} |`,
        `| CPU headroom | ${cpuH}% (${fmtCpu(totalAllocCpu - totalReqCpu)} free) | 20-40% | ${cpuH >= 20 && cpuH <= 40 ? "Optimal" : cpuH > 40 ? "Over-provisioned infra" : cpuH >= 10 ? "Tight" : "**Critical**"} |`,
        `| Memory headroom | ${memH}% (${fmtMem(totalAllocMem - totalReqMem)} free) | 20-40% | ${memH >= 20 && memH <= 40 ? "Optimal" : memH > 40 ? "Over-provisioned infra" : memH >= 10 ? "Tight" : "**Critical**"} |`,
        `| High-restart pods (>5) | ${restartPods.length} | 0 | ${restartPods.length === 0 ? "Stable" : "**Investigate**"} |`,
        ``,
      ];

      // ── Reclaim Potential Section ──
      if (reclaimCores > 0 || reclaimMemGi > 0 || orphanedGi > 0) {
        lines.push(`### Reclaim Potential`);
        lines.push(``);
        lines.push(`| Resource | Reclaimable | Impact |`);
        lines.push(`|---|---|---|`);
        if (reclaimCores > 0) lines.push(`| CPU | ${reclaimCores} cores | Free capacity for new workloads |`);
        if (reclaimMemGi > 0) lines.push(`| Memory | ${reclaimMemGi} GiB | Reduce memory pressure & OOMKill risk |`);
        if (orphanedGi > 0) lines.push(`| Storage (orphaned PVCs) | ${Math.round(orphanedGi * 10) / 10} GiB | Recover wasted storage capacity |`);
        lines.push(``);
      }

      // ── PVC & Storage Section ──
      if (pvcItems.length > 0) {
        lines.push(`### Storage & PVC Analysis`);
        lines.push(``);
        lines.push(`| Metric | Value |`);
        lines.push(`|---|---|`);
        lines.push(`| Total PVCs | ${pvcItems.length} (${Math.round(totalPvcGi * 10) / 10} GiB allocated) |`);
        lines.push(`| Bound | ${pvcBound} |`);
        lines.push(`| Orphaned (bound but unmounted) | ${pvcOrphaned} (${Math.round(orphanedGi * 10) / 10} GiB wasted) |`);
        lines.push(`| PV Available/Released | ${pvItems.filter(p => p.status?.phase === "Available").length} / ${pvItems.filter(p => p.status?.phase === "Released").length} |`);
        lines.push(``);

        if (orphanedPvcs.length > 0) {
          lines.push(`---`);
          lines.push(`### [WARNING] ${pvcOrphaned} Orphaned PVC(s) — ${Math.round(orphanedGi * 10) / 10} GiB Reclaimable`);
          lines.push(``);
          lines.push(`These PVCs are bound but not mounted by any running pod. They consume storage but serve no workload.`);
          lines.push(``);
          lines.push(`| Namespace | PVC Name | Size | Storage Class | Age (days) |`);
          lines.push(`|---|---|---|---|---|`);
          for (const p of orphanedPvcs.slice(0, 15)) lines.push(`| ${p.ns} | ${p.name} | ${p.size} | ${p.sc} | ${p.ageDays} |`);
          if (orphanedPvcs.length > 15) lines.push(`\n@@VIEW_MORE_REC|orphaned-pvcs|15|${orphanedPvcs.length}@@`);
          lines.push(``);
        }
      }

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
          description: "Pods without resource limits violate CIS Benchmark 5.4.1 and can consume unbounded resources, causing noisy-neighbor issues.",
          items: noLimList.slice(0, 10).map((n) => ({ ns: n.ns, pod: n.pod })),
          total: noLimList.length,
        });
      }
      if (orphanedPvcs.length > 0) {
        recFindings.push({
          severity: "WARNING", type: "orphaned-pvcs",
          title: `${pvcOrphaned} Orphaned PVC(s) (${Math.round(orphanedGi * 10) / 10} GiB)`,
          description: `These PVCs are bound but unmounted by any pod — consuming ${Math.round(orphanedGi * 10) / 10} GiB of storage with no active workload.`,
          items: orphanedPvcs.slice(0, 10).map((p) => ({ ns: p.ns, name: p.name, size: p.size, sc: p.sc, ageDays: p.ageDays })),
          total: orphanedPvcs.length,
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
      const REC_TABLE_LIMIT = 10;
      for (const f of recFindings) {
        if (f.type === "orphaned-pvcs") continue; // Already rendered above
        lines.push(`---`);
        lines.push(`### [${f.severity}] ${f.title}`);
        lines.push(``);
        lines.push(f.description);
        lines.push(``);
        if (f.type === "over-provisioned" || f.type === "under-provisioned") {
          lines.push(`| Namespace | Pod | CPU Request | CPU Usage | Utilization |`);
          lines.push(`|---|---|---|---|---|`);
          for (const it of f.items) lines.push(`| ${it.ns} | ${it.pod} | ${it.reqCpu} | ${it.usageCpu} | ${it.util}% |`);
          if (f.total > REC_TABLE_LIMIT) lines.push(`\n@@VIEW_MORE_REC|${f.type}|${REC_TABLE_LIMIT}|${f.total}@@`);
        } else if (f.type === "no-limits") {
          lines.push(`| Namespace | Pod |`);
          lines.push(`|---|---|`);
          for (const it of f.items) lines.push(`| ${it.ns} | ${it.pod} |`);
          if (f.total > REC_TABLE_LIMIT) lines.push(`\n@@VIEW_MORE_REC|${f.type}|${REC_TABLE_LIMIT}|${f.total}@@`);
        } else if (f.type === "high-restarts") {
          lines.push(`| Namespace | Pod | Restarts |`);
          lines.push(`|---|---|---|`);
          for (const it of f.items) lines.push(`| ${it.ns} | ${it.pod} | ${it.restarts} |`);
          if (f.total > REC_TABLE_LIMIT) lines.push(`\n@@VIEW_MORE_REC|${f.type}|${REC_TABLE_LIMIT}|${f.total}@@`);
        } else if (f.type === "capacity") {
          if (f.cpuH < 15) lines.push(`  - CPU headroom is very low at **${f.cpuH}%** — industry minimum is 20%`);
          if (f.memH < 15) lines.push(`  - Memory headroom is very low at **${f.memH}%** — risk of OOMKill under load`);
        }
        lines.push(``);
      }

      // AI-powered recommendations (Azure OpenAI / any LLM)
      if (hasLLM && recFindings.length > 0) {
        try {
          const aiRec = await generateOptimizationRemediation(recFindings, { cpuH, memH, totalPods: userPods.length, effScore, grade, reclaimCores, reclaimMemGi, orphanedGi }, llmOpts);
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
        if (cpuH < 30) lines.push(`[WARNING] CPU headroom is getting tight at ${cpuH}% — plan capacity expansion when reaching 20%.`);
        if (memH < 30) lines.push(`[WARNING] Memory headroom is getting tight at ${memH}% — consider right-sizing workloads or adding nodes.`);
        lines.push(``);
      }

      // Summary
      lines.push(`---`);
      if (cpuH >= 30 && memH >= 30 && over === 0 && under === 0 && noLim === 0 && restartPods.length === 0 && pvcOrphaned === 0) {
        lines.push(`**Cluster resources are well-balanced.** No optimization needed at this time.`);
      } else {
        lines.push(`### Action Plan (Priority Order)`);
        lines.push(``);
        let priority = 1;
        if (under > 0) { lines.push(`${priority}. **[CRITICAL]** Increase resources for ${under} under-provisioned pod(s) to prevent throttling and OOMKill`); priority++; }
        if (cpuH < 20 || memH < 20) { lines.push(`${priority}. **[CRITICAL]** Address cluster capacity — headroom below safe threshold (CPU: ${cpuH}%, Memory: ${memH}%)`); priority++; }
        if (over > 0) { lines.push(`${priority}. **[HIGH]** Right-size ${over} over-provisioned pod(s) to reclaim ${reclaimCores} cores / ${reclaimMemGi} GiB`); priority++; }
        if (orphanedPvcs.length > 0) { lines.push(`${priority}. **[HIGH]** Clean up ${pvcOrphaned} orphaned PVC(s) to reclaim ${Math.round(orphanedGi * 10) / 10} GiB storage`); priority++; }
        if (noLim > 0) { lines.push(`${priority}. **[MEDIUM]** Add resource limits to ${noLim} pod(s) — required for CIS compliance and cluster stability`); priority++; }
        if (restartPods.length > 0) { lines.push(`${priority}. **[MEDIUM]** Investigate ${restartPods.length} pod(s) with excessive restarts`); priority++; }
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

  // ---- Tier 1: /builds — OpenShift Build / BuildConfig status ----
  if (cmd === "builds" || cmd === "buildconfigs") {
    const ns = arg || null;
    try {
      const bcPath = ns ? `/apis/build.openshift.io/v1/namespaces/${ns}/buildconfigs` : "/apis/build.openshift.io/v1/buildconfigs";
      const bPath  = ns ? `/apis/build.openshift.io/v1/namespaces/${ns}/builds`       : "/apis/build.openshift.io/v1/builds";
      const [bcData, bData] = await Promise.all([
        ocpGet(bcPath).catch(() => ({ items: [] })),
        ocpGet(bPath).catch(() => ({ items: [] })),
      ]);
      const bcs = bcData.items || [];
      const builds = bData.items || [];
      if (bcs.length === 0 && builds.length === 0) {
        return { reply: "### OpenShift Builds\n[INFO] No BuildConfigs or Builds found. (OpenShift Build API may not be installed.)", contextKeys: ["slash", "builds"] };
      }
      const failing = builds.filter((b) => ["Failed", "Error", "Cancelled"].includes(b.status?.phase));
      const running = builds.filter((b) => ["Running", "Pending", "New"].includes(b.status?.phase));
      const lines = [
        `### OpenShift Builds${ns ? ` (${ns})` : ""}`,
        ``,
        `@@SUMMARY|green:${builds.length - failing.length - running.length} Complete|amber:${running.length} Active|red:${failing.length} Failed@@`,
        ``,
        `**BuildConfigs:** ${bcs.length} | **Recent Builds:** ${builds.length}`,
        ``,
        `| Build | Namespace | Phase | Strategy | Duration |`,
        `|---|---|---|---|---|`,
      ];
      for (const b of builds.slice(0, 25)) {
        const phase = b.status?.phase || "Unknown";
        const strat = b.spec?.strategy?.type || "?";
        const start = b.status?.startTimestamp;
        const end   = b.status?.completionTimestamp;
        const dur = start && end ? Math.round((new Date(end) - new Date(start))/1000) + "s" : (start ? "running" : "-");
        lines.push(`| ${b.metadata.name} | ${b.metadata.namespace} | ${phase} | ${strat} | ${dur} |`);
      }
      if (failing.length > 0) {
        lines.push(``, `### Recent failures`, ``);
        for (const b of failing.slice(0, 8)) {
          const reason = b.status?.message || b.status?.reason || "Unknown";
          lines.push(`  - **${b.metadata.namespace}/${b.metadata.name}** — ${reason}`);
        }
        lines.push(``, `**Diagnose:** \`oc logs build/<name> -n <ns>\``);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "builds"] };
    } catch (e) {
      return { reply: `[ERROR] /builds: ${e.message}`, contextKeys: ["slash", "builds"] };
    }
  }

  // ---- Tier 1: /imagestreams — OpenShift ImageStream inventory ----
  if (cmd === "imagestreams" || cmd === "images") {
    const ns = arg || null;
    try {
      const isPath = ns ? `/apis/image.openshift.io/v1/namespaces/${ns}/imagestreams` : "/apis/image.openshift.io/v1/imagestreams";
      const data = await ocpGet(isPath);
      const items = data.items || [];
      if (items.length === 0) return { reply: "### ImageStreams\n[INFO] No ImageStreams found.", contextKeys: ["slash", "imagestreams"] };
      const lines = [
        `### ImageStreams${ns ? ` (${ns})` : ""} — ${items.length}`, ``,
        `| ImageStream | Namespace | Tags | Latest |`,
        `|---|---|---|---|`,
      ];
      for (const is of items.slice(0, 30)) {
        const tags = is.status?.tags || [];
        const tagNames = tags.map((t) => t.tag).slice(0, 3).join(", ");
        const latest = tags[0]?.items?.[0]?.created || "-";
        lines.push(`| ${is.metadata.name} | ${is.metadata.namespace} | ${tags.length} (${tagNames}) | ${latest} |`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "imagestreams"] };
    } catch (e) {
      return { reply: `[ERROR] /imagestreams: ${e.message}`, contextKeys: ["slash", "imagestreams"] };
    }
  }

  // ---- Tier 1: /operators — Operator subscriptions, install plans, CSVs ----
  if (cmd === "operators" || cmd === "subs" || cmd === "subscriptions") {
    const ns = arg || null;
    try {
      const subPath = ns ? `/apis/operators.coreos.com/v1alpha1/namespaces/${ns}/subscriptions` : "/apis/operators.coreos.com/v1alpha1/subscriptions";
      const ipPath  = ns ? `/apis/operators.coreos.com/v1alpha1/namespaces/${ns}/installplans` : "/apis/operators.coreos.com/v1alpha1/installplans";
      const csvPath = ns ? `/apis/operators.coreos.com/v1alpha1/namespaces/${ns}/clusterserviceversions` : "/apis/operators.coreos.com/v1alpha1/clusterserviceversions";
      const [subsData, ipsData, csvsData] = await Promise.all([
        ocpGet(subPath).catch(() => ({ items: [] })),
        ocpGet(ipPath).catch(() => ({ items: [] })),
        ocpGet(csvPath).catch(() => ({ items: [] })),
      ]);
      const subs = subsData.items || [];
      const ips = ipsData.items || [];
      const csvs = csvsData.items || [];
      const failingCsvs = csvs.filter((c) => c.status?.phase !== "Succeeded");
      const pendingIps = ips.filter((p) => p.spec?.approval === "Manual" && !p.spec?.approved);

      const lines = [
        `### Operator Lifecycle Manager${ns ? ` (${ns})` : ""}`,
        ``,
        `@@SUMMARY|green:${csvs.length - failingCsvs.length} Healthy|amber:${pendingIps.length} Pending Approval|red:${failingCsvs.length} Degraded@@`,
        ``,
        `**Subscriptions:** ${subs.length} | **InstallPlans:** ${ips.length} | **CSVs:** ${csvs.length}`,
        ``,
      ];

      if (subs.length > 0) {
        lines.push(`#### Subscriptions`, ``, `| Subscription | Namespace | Channel | Current CSV | State |`, `|---|---|---|---|---|`);
        for (const s of subs.slice(0, 30)) {
          const state = s.status?.state || "?";
          lines.push(`| ${s.metadata.name} | ${s.metadata.namespace} | ${s.spec?.channel || "-"} | ${s.status?.currentCSV || "-"} | ${state} |`);
        }
        lines.push(``);
      }

      if (pendingIps.length > 0) {
        lines.push(`#### Pending Manual Approval (InstallPlans)`, ``);
        for (const p of pendingIps.slice(0, 10)) {
          lines.push(`  - **${p.metadata.namespace}/${p.metadata.name}** — \`oc patch installplan ${p.metadata.name} -n ${p.metadata.namespace} --type=merge -p '{"spec":{"approved":true}}'\``);
        }
        lines.push(``);
      }

      if (failingCsvs.length > 0) {
        lines.push(`#### Degraded Operators (CSV)`, ``);
        for (const c of failingCsvs.slice(0, 10)) {
          lines.push(`  - **${c.metadata.namespace}/${c.metadata.name}** — Phase: ${c.status?.phase || "?"}, Reason: ${c.status?.reason || "-"}`);
        }
      }

      if (subs.length === 0 && ips.length === 0 && csvs.length === 0) {
        return { reply: "### Operators\n[INFO] OLM (Operator Lifecycle Manager) not available on this cluster.", contextKeys: ["slash", "operators"] };
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "operators"] };
    } catch (e) {
      return { reply: `[ERROR] /operators: ${e.message}`, contextKeys: ["slash", "operators"] };
    }
  }

  // ---- Tier 1: /machineconfigs — MachineConfig and MCP status ----
  if (cmd === "machineconfigs" || cmd === "mcp" || cmd === "mc") {
    try {
      const [mcData, mcpData] = await Promise.all([
        ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigs").catch(() => ({ items: [] })),
        ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools").catch(() => ({ items: [] })),
      ]);
      const mcs = mcData.items || [];
      const mcps = mcpData.items || [];
      if (mcs.length === 0 && mcps.length === 0) {
        return { reply: "### MachineConfigs\n[INFO] machineconfiguration.openshift.io API not available.", contextKeys: ["slash", "machineconfigs"] };
      }
      const degraded = mcps.filter((p) => {
        const conds = p.status?.conditions || [];
        return conds.some((c) => (c.type === "Degraded" || c.type === "NodeDegraded" || c.type === "RenderDegraded") && c.status === "True");
      });
      const updating = mcps.filter((p) => (p.status?.conditions || []).some((c) => c.type === "Updating" && c.status === "True"));
      const lines = [
        `### MachineConfig Pools`,
        ``,
        `@@SUMMARY|green:${mcps.length - degraded.length - updating.length} Healthy|amber:${updating.length} Updating|red:${degraded.length} Degraded@@`,
        ``,
        `| Pool | Machines (Ready/Total) | Updated | Degraded | Source MCs |`,
        `|---|---|---|---|---|`,
      ];
      for (const p of mcps) {
        const ready = p.status?.readyMachineCount ?? 0;
        const total = p.status?.machineCount ?? 0;
        const upd = p.status?.updatedMachineCount ?? 0;
        const deg = p.status?.degradedMachineCount ?? 0;
        const srcCount = (p.status?.configuration?.source || []).length;
        lines.push(`| ${p.metadata.name} | ${ready}/${total} | ${upd}/${total} | ${deg} | ${srcCount} |`);
      }
      if (degraded.length > 0) {
        lines.push(``, `### Degraded Pools`, ``);
        for (const p of degraded) {
          const cond = (p.status?.conditions || []).find((c) => c.status === "True" && /Degraded/.test(c.type));
          lines.push(`  - **${p.metadata.name}** — ${cond?.reason || "?"}: ${cond?.message || ""}`);
        }
      }
      lines.push(``, `**Total MachineConfigs:** ${mcs.length} (use \`oc get mc\` for full list)`);
      return { reply: lines.join("\n"), contextKeys: ["slash", "machineconfigs"] };
    } catch (e) {
      return { reply: `[ERROR] /machineconfigs: ${e.message}`, contextKeys: ["slash", "machineconfigs"] };
    }
  }

  // ---- Tier 1: /scc — SecurityContextConstraints inventory ----
  if (cmd === "scc" || cmd === "sccs") {
    try {
      const data = await ocpGet("/apis/security.openshift.io/v1/securitycontextconstraints");
      const items = data.items || [];
      if (items.length === 0) return { reply: "### SCCs\n[INFO] No SecurityContextConstraints found.", contextKeys: ["slash", "scc"] };
      const lines = [
        `### Security Context Constraints — ${items.length}`, ``,
        `| SCC | Priority | AllowPrivileged | AllowHostNet | RunAsUser | Users / Groups |`,
        `|---|---|---|---|---|---|`,
      ];
      for (const s of items) {
        const users = (s.users || []).slice(0, 2).join(", ");
        const groups = (s.groups || []).slice(0, 2).join(", ");
        const combined = [users, groups].filter(Boolean).join(" / ") || "-";
        lines.push(`| ${s.metadata.name} | ${s.priority ?? "-"} | ${s.allowPrivilegedContainer ? "YES" : "no"} | ${s.allowHostNetwork ? "YES" : "no"} | ${s.runAsUser?.type || "-"} | ${combined} |`);
      }
      lines.push(``, `**Note:** SCCs control which Pod security contexts are allowed. Pods are assigned the SCC matching their requested permissions.`);
      return { reply: lines.join("\n"), contextKeys: ["slash", "scc"] };
    } catch (e) {
      return { reply: `[ERROR] /scc: ${e.message}`, contextKeys: ["slash", "scc"] };
    }
  }

  // ---- Tier 1: /rbac — Role/RoleBinding/ClusterRoleBinding audit ----
  if (cmd === "rbac" || cmd === "roles" || cmd === "rolebindings") {
    const ns = arg || null;
    try {
      const [crbData, rbData, crData] = await Promise.all([
        ocpGet("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings").catch(() => ({ items: [] })),
        ocpGet(ns ? `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings` : "/apis/rbac.authorization.k8s.io/v1/rolebindings").catch(() => ({ items: [] })),
        ocpGet("/apis/rbac.authorization.k8s.io/v1/clusterroles").catch(() => ({ items: [] })),
      ]);
      const crbs = crbData.items || [];
      const rbs = rbData.items || [];
      const crs = crData.items || [];

      // Find cluster-admins
      const clusterAdmins = crbs.filter((b) => b.roleRef?.name === "cluster-admin");
      const adminSubjects = [];
      for (const b of clusterAdmins) {
        for (const s of (b.subjects || [])) {
          adminSubjects.push(`${s.kind}/${s.name}${s.namespace ? ` (${s.namespace})` : ""}`);
        }
      }
      const lines = [
        `### RBAC Audit${ns ? ` (${ns})` : ""}`, ``,
        `**ClusterRoles:** ${crs.length} | **ClusterRoleBindings:** ${crbs.length} | **RoleBindings${ns ? " in " + ns : ""}:** ${rbs.length}`,
        ``,
        `#### Cluster-Admin Grants (${adminSubjects.length})`, ``,
      ];
      if (adminSubjects.length === 0) lines.push("  - *none found*");
      else for (const a of adminSubjects.slice(0, 30)) lines.push(`  - ${a}`);

      if (rbs.length > 0) {
        lines.push(``, `#### RoleBindings`, ``, `| Name | Namespace | RoleRef | Subjects |`, `|---|---|---|---|`);
        for (const rb of rbs.slice(0, 30)) {
          const subj = (rb.subjects || []).map((s) => `${s.kind}/${s.name}`).slice(0, 3).join(", ");
          lines.push(`| ${rb.metadata.name} | ${rb.metadata.namespace} | ${rb.roleRef?.kind}/${rb.roleRef?.name} | ${subj || "-"} |`);
        }
      }
      lines.push(``, `**Tip:** Use \`oc adm policy who-can <verb> <resource>\` to audit specific permissions.`);
      return { reply: lines.join("\n"), contextKeys: ["slash", "rbac"] };
    } catch (e) {
      return { reply: `[ERROR] /rbac: ${e.message}`, contextKeys: ["slash", "rbac"] };
    }
  }

  // ---- Tier 1: /quotas — ResourceQuota / LimitRange / PDB visibility ----
  if (cmd === "quotas" || cmd === "quota" || cmd === "limits") {
    const ns = arg || null;
    try {
      const rqPath = ns ? `/api/v1/namespaces/${ns}/resourcequotas` : "/api/v1/resourcequotas";
      const lrPath = ns ? `/api/v1/namespaces/${ns}/limitranges` : "/api/v1/limitranges";
      const pdbPath = ns ? `/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets` : "/apis/policy/v1/poddisruptionbudgets";
      const [rqData, lrData, pdbData] = await Promise.all([
        ocpGet(rqPath).catch(() => ({ items: [] })),
        ocpGet(lrPath).catch(() => ({ items: [] })),
        ocpGet(pdbPath).catch(() => ({ items: [] })),
      ]);
      const rqs = rqData.items || [];
      const lrs = lrData.items || [];
      const pdbs = pdbData.items || [];
      const lines = [`### Quotas & Governance${ns ? ` (${ns})` : ""}`, ``];

      lines.push(`**ResourceQuotas:** ${rqs.length} | **LimitRanges:** ${lrs.length} | **PodDisruptionBudgets:** ${pdbs.length}`, ``);

      if (rqs.length > 0) {
        lines.push(`#### ResourceQuotas`, ``, `| Namespace | Quota | Used / Hard |`, `|---|---|---|`);
        for (const rq of rqs.slice(0, 30)) {
          const hard = rq.status?.hard || {};
          const used = rq.status?.used || {};
          const summary = Object.keys(hard).slice(0, 3).map((k) => `${k}: ${used[k] || 0}/${hard[k]}`).join("; ") || "-";
          lines.push(`| ${rq.metadata.namespace} | ${rq.metadata.name} | ${summary} |`);
        }
        lines.push(``);
      }

      if (pdbs.length > 0) {
        lines.push(`#### PodDisruptionBudgets`, ``, `| Namespace | PDB | Allowed Disruptions | Healthy / Desired |`, `|---|---|---|---|`);
        for (const p of pdbs.slice(0, 20)) {
          const allowed = p.status?.disruptionsAllowed ?? "-";
          const healthy = p.status?.currentHealthy ?? "-";
          const desired = p.status?.desiredHealthy ?? "-";
          lines.push(`| ${p.metadata.namespace} | ${p.metadata.name} | ${allowed} | ${healthy}/${desired} |`);
        }
      }

      if (rqs.length === 0 && lrs.length === 0 && pdbs.length === 0) {
        lines.push(`[INFO] No quotas, limit ranges, or PDBs found${ns ? ` in namespace ${ns}` : ""}.`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "quotas"] };
    } catch (e) {
      return { reply: `[ERROR] /quotas: ${e.message}`, contextKeys: ["slash", "quotas"] };
    }
  }

  // ---- Tier 1: /certs — CSRs and certificate lifecycle ----
  if (cmd === "certs" || cmd === "csr" || cmd === "csrs" || cmd === "certificates") {
    try {
      const data = await ocpGet("/apis/certificates.k8s.io/v1/certificatesigningrequests");
      const items = data.items || [];
      const pending = items.filter((c) => !(c.status?.conditions || []).some((cd) => cd.type === "Approved" || cd.type === "Denied"));
      const approved = items.filter((c) => (c.status?.conditions || []).some((cd) => cd.type === "Approved" && cd.status === "True"));
      const denied = items.filter((c) => (c.status?.conditions || []).some((cd) => cd.type === "Denied" && cd.status === "True"));
      const lines = [
        `### Certificate Signing Requests`, ``,
        `@@SUMMARY|green:${approved.length} Approved|amber:${pending.length} Pending|red:${denied.length} Denied@@`, ``,
      ];
      if (pending.length > 0) {
        lines.push(`#### Pending CSRs (need approval)`, ``);
        for (const c of pending.slice(0, 20)) {
          lines.push(`  - **${c.metadata.name}** — Signer: \`${c.spec?.signerName || "?"}\``);
          lines.push(`    Approve: \`oc adm certificate approve ${c.metadata.name}\``);
        }
        lines.push(``);
      }
      if (pending.length === 0 && items.length > 0) lines.push(`[OK] All CSRs are processed.`);
      if (items.length === 0) lines.push(`[INFO] No CSRs found.`);
      return { reply: lines.join("\n"), contextKeys: ["slash", "certs"] };
    } catch (e) {
      return { reply: `[ERROR] /certs: ${e.message}`, contextKeys: ["slash", "certs"] };
    }
  }

  // ---- Tier 3: /etcd — etcd cluster health and member status ----
  if (cmd === "etcd") {
    try {
      const etcdPods = await ocpGet("/api/v1/namespaces/openshift-etcd/pods?labelSelector=app=etcd").catch(() => ({ items: [] }));
      const etcd = await ocpGet("/apis/operator.openshift.io/v1/etcds/cluster").catch(() => null);
      const items = etcdPods.items || [];
      const ready = items.filter((p) => (p.status?.containerStatuses || []).every((c) => c.ready));
      const lines = [
        `### etcd Cluster Health`, ``,
        `@@SUMMARY|green:${ready.length} Healthy Members|amber:${items.length - ready.length} Not Ready|red:${etcd?.status?.conditions?.find((c) => c.type === "Degraded" && c.status === "True") ? 1 : 0} Degraded@@`, ``,
      ];
      if (items.length === 0) {
        lines.push(`[INFO] etcd pods not directly accessible. Use \`oc rsh -n openshift-etcd <etcd-pod> etcdctl endpoint health\` for member status.`);
      } else {
        lines.push(`| Pod | Node | Ready | Restarts | Age |`, `|---|---|---|---|---|`);
        for (const p of items) {
          const cs = p.status?.containerStatuses || [];
          const r = cs.filter((c) => c.ready).length;
          const rs = cs.reduce((a, c) => a + (c.restartCount || 0), 0);
          const age = p.status?.startTime || "-";
          lines.push(`| ${p.metadata.name} | ${p.spec?.nodeName || "-"} | ${r}/${cs.length} | ${rs} | ${age} |`);
        }
      }
      const degraded = (etcd?.status?.conditions || []).filter((c) => c.status === "True" && /Degraded/.test(c.type));
      if (degraded.length > 0) {
        lines.push(``, `### Operator Conditions`, ``);
        for (const c of degraded) lines.push(`  - **${c.type}**: ${c.message || c.reason}`);
      }
      lines.push(``, `**Backups:** Check \`/dr\` for etcd snapshot status (CR: EtcdBackup).`);
      return { reply: lines.join("\n"), contextKeys: ["slash", "etcd"] };
    } catch (e) {
      return { reply: `[ERROR] /etcd: ${e.message}`, contextKeys: ["slash", "etcd"] };
    }
  }

  // ---- Tier 3: /mesh — Service Mesh (Istio/OSSM) virtual services ----
  if (cmd === "mesh" || cmd === "servicemesh") {
    try {
      const [vsData, drData, gwData] = await Promise.all([
        ocpGet("/apis/networking.istio.io/v1beta1/virtualservices").catch(() => ({ items: [] })),
        ocpGet("/apis/networking.istio.io/v1beta1/destinationrules").catch(() => ({ items: [] })),
        ocpGet("/apis/networking.istio.io/v1beta1/gateways").catch(() => ({ items: [] })),
      ]);
      const vs = vsData.items || [];
      const dr = drData.items || [];
      const gw = gwData.items || [];
      if (vs.length === 0 && dr.length === 0 && gw.length === 0) {
        return { reply: "### Service Mesh\n[INFO] No Istio / OpenShift Service Mesh resources found. Mesh may not be installed.", contextKeys: ["slash", "mesh"] };
      }
      const lines = [
        `### Service Mesh (Istio/OSSM)`, ``,
        `**VirtualServices:** ${vs.length} | **DestinationRules:** ${dr.length} | **Gateways:** ${gw.length}`, ``,
      ];
      if (vs.length > 0) {
        lines.push(`#### VirtualServices`, ``, `| Name | Namespace | Hosts | Gateways |`, `|---|---|---|---|`);
        for (const v of vs.slice(0, 20)) {
          lines.push(`| ${v.metadata.name} | ${v.metadata.namespace} | ${(v.spec?.hosts || []).join(",")} | ${(v.spec?.gateways || []).join(",")} |`);
        }
        lines.push(``);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "mesh"] };
    } catch (e) {
      return { reply: `[ERROR] /mesh: ${e.message}`, contextKeys: ["slash", "mesh"] };
    }
  }

  // ---- Tier 3: /egress — EgressIPs and Egress NetworkPolicies ----
  if (cmd === "egress" || cmd === "egressip" || cmd === "egressips") {
    try {
      const [eipData, enpData] = await Promise.all([
        ocpGet("/apis/k8s.ovn.org/v1/egressips").catch(() => ({ items: [] })),
        ocpGet("/apis/network.openshift.io/v1/egressnetworkpolicies").catch(() => ({ items: [] })),
      ]);
      const eips = eipData.items || [];
      const enps = enpData.items || [];
      if (eips.length === 0 && enps.length === 0) {
        return { reply: "### Egress\n[INFO] No EgressIPs or EgressNetworkPolicies found.", contextKeys: ["slash", "egress"] };
      }
      const lines = [`### Egress Configuration`, ``, `**EgressIPs:** ${eips.length} | **EgressNetworkPolicies:** ${enps.length}`, ``];
      if (eips.length > 0) {
        lines.push(`#### EgressIPs`, ``, `| Name | IPs | NamespaceSelector |`, `|---|---|---|`);
        for (const e of eips.slice(0, 20)) {
          lines.push(`| ${e.metadata.name} | ${(e.spec?.egressIPs || []).join(",")} | ${JSON.stringify(e.spec?.namespaceSelector || {})} |`);
        }
        lines.push(``);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "egress"] };
    } catch (e) {
      return { reply: `[ERROR] /egress: ${e.message}`, contextKeys: ["slash", "egress"] };
    }
  }

  // ---- Tier 3: /oauth — OAuth clients and login audit ----
  if (cmd === "oauth" || cmd === "logins") {
    try {
      const data = await ocpGet("/apis/oauth.openshift.io/v1/oauthclients").catch(() => ({ items: [] }));
      const users = await ocpGet("/apis/user.openshift.io/v1/users").catch(() => ({ items: [] }));
      const groups = await ocpGet("/apis/user.openshift.io/v1/groups").catch(() => ({ items: [] }));
      const lines = [
        `### OAuth & Identity`, ``,
        `**OAuth Clients:** ${(data.items || []).length} | **Users:** ${(users.items || []).length} | **Groups:** ${(groups.items || []).length}`, ``,
      ];
      if ((data.items || []).length > 0) {
        lines.push(`#### OAuth Clients`, ``, `| Client | Grant Method | Redirect URIs |`, `|---|---|---|`);
        for (const c of (data.items || []).slice(0, 20)) {
          lines.push(`| ${c.metadata.name} | ${c.grantMethod || "-"} | ${(c.redirectURIs || []).slice(0, 2).join(", ")} |`);
        }
        lines.push(``);
      }
      if ((users.items || []).length > 0) {
        lines.push(`#### Users (top 10 by groups)`, ``);
        const top = (users.items || []).sort((a, b) => (b.groups?.length || 0) - (a.groups?.length || 0)).slice(0, 10);
        for (const u of top) lines.push(`  - **${u.metadata.name}** — groups: ${(u.groups || []).join(", ") || "(none)"}`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "oauth"] };
    } catch (e) {
      return { reply: `[ERROR] /oauth: ${e.message}`, contextKeys: ["slash", "oauth"] };
    }
  }

  // ---- Sprint B: /compliance — Compliance Operator scan results ----
  if (cmd === "compliance" || cmd === "scans") {
    try {
      const [suites, scans, results] = await Promise.all([
        ocpGet("/apis/compliance.openshift.io/v1alpha1/compliancesuites").catch(() => ({ items: [] })),
        ocpGet("/apis/compliance.openshift.io/v1alpha1/compliancescans").catch(() => ({ items: [] })),
        ocpGet("/apis/compliance.openshift.io/v1alpha1/compliancecheckresults").catch(() => ({ items: [] })),
      ]);
      const allSuites = suites.items || [];
      const allScans = scans.items || [];
      const allResults = results.items || [];
      if (allSuites.length === 0 && allScans.length === 0) {
        return { reply: "### Compliance\n[INFO] Compliance Operator not installed. Install from OperatorHub to scan against CIS, NIST, PCI-DSS, HIPAA profiles.", contextKeys: ["slash", "compliance"] };
      }
      const failed = allResults.filter((r) => r.status === "FAIL");
      const passed = allResults.filter((r) => r.status === "PASS");
      const manual = allResults.filter((r) => r.status === "MANUAL");
      const lines = [
        `### Compliance & Audit Scans`, ``,
        `@@SUMMARY|green:${passed.length} Passed|amber:${manual.length} Manual Review|red:${failed.length} Failed@@`, ``,
        `**Suites:** ${allSuites.length} | **Scans:** ${allScans.length} | **Check Results:** ${allResults.length}`, ``,
      ];
      if (allSuites.length > 0) {
        lines.push(`#### Compliance Suites`, ``, `| Suite | Phase | Result |`, `|---|---|---|`);
        for (const s of allSuites.slice(0, 10)) {
          lines.push(`| ${s.metadata.name} | ${s.status?.phase || "-"} | ${s.status?.result || "-"} |`);
        }
        lines.push(``);
      }
      if (failed.length > 0) {
        lines.push(`#### Top Failing Checks (${failed.length})`, ``);
        for (const r of failed.slice(0, 15)) {
          const sev = r.severity || "medium";
          lines.push(`  - **[${sev.toUpperCase()}]** ${r.metadata.name} — ${r.description?.slice(0, 120) || "-"}`);
        }
      }
      lines.push(``, `**Remediate:** \`oc apply -f <ComplianceRemediation>\` or run \`/plan remediate compliance\` for AI-assisted fixes.`);
      return { reply: lines.join("\n"), contextKeys: ["slash", "compliance"] };
    } catch (e) {
      return { reply: `[ERROR] /compliance: ${e.message}`, contextKeys: ["slash", "compliance"] };
    }
  }

  // ---- Sprint B: /promrules — PrometheusRule / ServiceMonitor ----
  if (cmd === "promrules" || cmd === "alertrules" || cmd === "promo") {
    const ns = arg || null;
    try {
      const [rulesData, smData] = await Promise.all([
        ocpGet(ns ? `/apis/monitoring.coreos.com/v1/namespaces/${ns}/prometheusrules` : "/apis/monitoring.coreos.com/v1/prometheusrules").catch(() => ({ items: [] })),
        ocpGet(ns ? `/apis/monitoring.coreos.com/v1/namespaces/${ns}/servicemonitors` : "/apis/monitoring.coreos.com/v1/servicemonitors").catch(() => ({ items: [] })),
      ]);
      const rules = rulesData.items || [];
      const sms = smData.items || [];
      if (rules.length === 0 && sms.length === 0) {
        return { reply: "### Monitoring Rules\n[INFO] No PrometheusRules or ServiceMonitors found. Prometheus Operator may not be installed.", contextKeys: ["slash", "promrules"] };
      }
      const allAlerts = [];
      for (const r of rules) {
        for (const grp of (r.spec?.groups || [])) {
          for (const rule of (grp.rules || [])) {
            if (rule.alert) allAlerts.push({ name: rule.alert, expr: rule.expr, severity: rule.labels?.severity || "info", ns: r.metadata.namespace, file: r.metadata.name });
          }
        }
      }
      const lines = [
        `### Prometheus Operator Rules${ns ? ` (${ns})` : ""}`, ``,
        `**PrometheusRules:** ${rules.length} | **ServiceMonitors:** ${sms.length} | **Alert Rules:** ${allAlerts.length}`, ``,
      ];
      if (allAlerts.length > 0) {
        lines.push(`#### Top Alert Rules`, ``, `| Alert | Severity | Namespace | Source |`, `|---|---|---|---|`);
        for (const a of allAlerts.slice(0, 25)) {
          lines.push(`| ${a.name} | ${a.severity} | ${a.ns} | ${a.file} |`);
        }
        lines.push(``);
      }
      if (sms.length > 0) {
        lines.push(`#### Service Monitors (${sms.length}) — top 10`, ``, `| Name | Namespace | Endpoints |`, `|---|---|---|`);
        for (const s of sms.slice(0, 10)) {
          lines.push(`| ${s.metadata.name} | ${s.metadata.namespace} | ${(s.spec?.endpoints || []).length} |`);
        }
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "promrules"] };
    } catch (e) {
      return { reply: `[ERROR] /promrules: ${e.message}`, contextKeys: ["slash", "promrules"] };
    }
  }

  // ---- Sprint B: /logging — ClusterLogForwarder + LokiStack ----
  if (cmd === "logging" || cmd === "logs-config") {
    try {
      const [lfData, clData, lokiData] = await Promise.all([
        ocpGet("/apis/logging.openshift.io/v1/clusterlogforwarders").catch(() => ({ items: [] })),
        ocpGet("/apis/logging.openshift.io/v1/clusterloggings").catch(() => ({ items: [] })),
        ocpGet("/apis/loki.grafana.com/v1/lokistacks").catch(() => ({ items: [] })),
      ]);
      const lfs = lfData.items || [];
      const cls = clData.items || [];
      const lokis = lokiData.items || [];
      if (lfs.length === 0 && cls.length === 0 && lokis.length === 0) {
        return { reply: "### Logging Stack\n[INFO] No OpenShift Logging operators detected. Install ClusterLogging / Loki Operators.", contextKeys: ["slash", "logging"] };
      }
      const lines = [`### Logging Stack`, ``, `**ClusterLogging:** ${cls.length} | **ClusterLogForwarders:** ${lfs.length} | **LokiStacks:** ${lokis.length}`, ``];
      for (const cl of cls) {
        const phase = cl.status?.conditions?.find((c) => c.type === "Ready")?.status === "True" ? "Ready" : "Degraded";
        lines.push(`- **ClusterLogging** \`${cl.metadata.name}\` — ${phase} — Collection: ${cl.spec?.collection?.type || "-"}, LogStore: ${cl.spec?.logStore?.type || "-"}`);
      }
      for (const lf of lfs) {
        const inputs = (lf.spec?.inputs || []).length;
        const outputs = (lf.spec?.outputs || []).length;
        const pipelines = (lf.spec?.pipelines || []).length;
        lines.push(`- **LogForwarder** \`${lf.metadata.namespace}/${lf.metadata.name}\` — ${inputs} inputs, ${outputs} outputs, ${pipelines} pipelines`);
      }
      for (const l of lokis) {
        lines.push(`- **LokiStack** \`${l.metadata.namespace}/${l.metadata.name}\` — Size: ${l.spec?.size || "-"}`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "logging"] };
    } catch (e) {
      return { reply: `[ERROR] /logging: ${e.message}`, contextKeys: ["slash", "logging"] };
    }
  }

  // ---- Sprint B: /odf — OpenShift Data Foundation / Ceph ----
  if (cmd === "odf" || cmd === "ceph" || cmd === "storage-ops") {
    try {
      const [scData, cephData, noobaaData] = await Promise.all([
        ocpGet("/apis/ocs.openshift.io/v1/storageclusters").catch(() => ({ items: [] })),
        ocpGet("/apis/ceph.rook.io/v1/cephclusters").catch(() => ({ items: [] })),
        ocpGet("/apis/noobaa.io/v1alpha1/noobaas").catch(() => ({ items: [] })),
      ]);
      const scs = scData.items || [];
      const cephs = cephData.items || [];
      const noobaas = noobaaData.items || [];
      if (scs.length === 0 && cephs.length === 0) {
        return { reply: "### ODF / Ceph\n[INFO] OpenShift Data Foundation not installed.", contextKeys: ["slash", "odf"] };
      }
      const lines = [`### OpenShift Data Foundation (Ceph)`, ``];
      for (const sc of scs) {
        lines.push(`#### StorageCluster \`${sc.metadata.name}\``);
        lines.push(`- Phase: ${sc.status?.phase || "?"}`);
        lines.push(`- StorageDeviceSets: ${(sc.spec?.storageDeviceSets || []).length}`);
      }
      for (const c of cephs) {
        const cs = c.status?.ceph || {};
        lines.push(``, `#### CephCluster \`${c.metadata.name}\``);
        lines.push(`- Health: ${cs.health || "?"}`);
        lines.push(`- Capacity used: ${cs.capacity?.bytesUsed ? Math.round(cs.capacity.bytesUsed / (1024**3)) + " GiB" : "-"} / ${cs.capacity?.bytesTotal ? Math.round(cs.capacity.bytesTotal / (1024**3)) + " GiB" : "-"}`);
        lines.push(`- Mons: ${c.status?.message || "-"}`);
      }
      for (const nb of noobaas) {
        lines.push(``, `#### NooBaa \`${nb.metadata.namespace}/${nb.metadata.name}\` — Phase: ${nb.status?.phase || "-"}`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "odf"] };
    } catch (e) {
      return { reply: `[ERROR] /odf: ${e.message}`, contextKeys: ["slash", "odf"] };
    }
  }

  // ---- Sprint B: /acm — Advanced Cluster Management ----
  if (cmd === "acm" || cmd === "managedclusters" || cmd === "fleet") {
    try {
      const [mcData, polData] = await Promise.all([
        ocpGet("/apis/cluster.open-cluster-management.io/v1/managedclusters").catch(() => ({ items: [] })),
        ocpGet("/apis/policy.open-cluster-management.io/v1/policies").catch(() => ({ items: [] })),
      ]);
      const clusters = mcData.items || [];
      const policies = polData.items || [];
      if (clusters.length === 0) {
        return { reply: "### ACM Fleet\n[INFO] No managed clusters found. ACM hub may not be installed here.", contextKeys: ["slash", "acm"] };
      }
      const available = clusters.filter((c) => (c.status?.conditions || []).some((cd) => cd.type === "ManagedClusterConditionAvailable" && cd.status === "True"));
      const compliant = policies.filter((p) => p.status?.compliant === "Compliant");
      const nonCompliant = policies.filter((p) => p.status?.compliant === "NonCompliant");
      const lines = [
        `### ACM Fleet Overview`, ``,
        `@@SUMMARY|green:${available.length} Available Clusters|amber:${compliant.length} Compliant Policies|red:${nonCompliant.length} Non-Compliant@@`, ``,
        `**Managed Clusters:** ${clusters.length} | **Policies:** ${policies.length}`, ``,
        `#### Clusters`, ``, `| Name | Available | Version | Hub Accepted |`, `|---|---|---|---|`,
      ];
      for (const c of clusters.slice(0, 30)) {
        const avail = (c.status?.conditions || []).find((cd) => cd.type === "ManagedClusterConditionAvailable");
        const ver = c.status?.version?.kubernetes || "-";
        const accepted = (c.status?.conditions || []).find((cd) => cd.type === "HubAcceptedManagedCluster")?.status === "True" ? "yes" : "no";
        lines.push(`| ${c.metadata.name} | ${avail?.status || "?"} | ${ver} | ${accepted} |`);
      }
      if (nonCompliant.length > 0) {
        lines.push(``, `#### Non-Compliant Policies`, ``);
        for (const p of nonCompliant.slice(0, 10)) {
          lines.push(`  - **${p.metadata.namespace}/${p.metadata.name}** — ${p.status?.compliant}`);
        }
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "acm"] };
    } catch (e) {
      return { reply: `[ERROR] /acm: ${e.message}`, contextKeys: ["slash", "acm"] };
    }
  }

  // ---- Sprint B: /hypershift — Hosted Control Planes ----
  if (cmd === "hypershift" || cmd === "hcp" || cmd === "hostedclusters") {
    try {
      const [hcData, npData] = await Promise.all([
        ocpGet("/apis/hypershift.openshift.io/v1beta1/hostedclusters").catch(() => ({ items: [] })),
        ocpGet("/apis/hypershift.openshift.io/v1beta1/nodepools").catch(() => ({ items: [] })),
      ]);
      const hcs = hcData.items || [];
      const nps = npData.items || [];
      if (hcs.length === 0) {
        return { reply: "### HyperShift\n[INFO] No HostedClusters found. HyperShift operator may not be installed.", contextKeys: ["slash", "hypershift"] };
      }
      const lines = [
        `### HyperShift — Hosted Control Planes`, ``,
        `**HostedClusters:** ${hcs.length} | **NodePools:** ${nps.length}`, ``,
        `| HostedCluster | Namespace | Version | Available |`,
        `|---|---|---|---|`,
      ];
      for (const h of hcs) {
        const avail = (h.status?.conditions || []).find((c) => c.type === "Available")?.status || "?";
        lines.push(`| ${h.metadata.name} | ${h.metadata.namespace} | ${h.spec?.release?.image?.split(":").pop() || "-"} | ${avail} |`);
      }
      if (nps.length > 0) {
        lines.push(``, `#### NodePools`, ``, `| NodePool | Cluster | Replicas | Version |`, `|---|---|---|---|`);
        for (const n of nps.slice(0, 20)) {
          lines.push(`| ${n.metadata.name} | ${n.spec?.clusterName} | ${n.status?.replicas || 0}/${n.spec?.replicas || 0} | ${n.spec?.release?.image?.split(":").pop() || "-"} |`);
        }
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "hypershift"] };
    } catch (e) {
      return { reply: `[ERROR] /hypershift: ${e.message}`, contextKeys: ["slash", "hypershift"] };
    }
  }

  // ---- Sprint B: /baremetal — Bare-Metal hosts & Assisted Installer ----
  if (cmd === "baremetal" || cmd === "bmh" || cmd === "bm") {
    try {
      const [bmData, agData, ieData] = await Promise.all([
        ocpGet("/apis/metal3.io/v1alpha1/baremetalhosts").catch(() => ({ items: [] })),
        ocpGet("/apis/agent-install.openshift.io/v1beta1/agents").catch(() => ({ items: [] })),
        ocpGet("/apis/agent-install.openshift.io/v1beta1/infraenvs").catch(() => ({ items: [] })),
      ]);
      const bmhs = bmData.items || [];
      const agents = agData.items || [];
      const infraEnvs = ieData.items || [];
      if (bmhs.length === 0 && agents.length === 0) {
        return { reply: "### Bare-Metal\n[INFO] No BareMetalHosts or Assisted Installer agents found.", contextKeys: ["slash", "baremetal"] };
      }
      const lines = [
        `### Bare-Metal Hosts`, ``,
        `**BMHs:** ${bmhs.length} | **Agents:** ${agents.length} | **InfraEnvs:** ${infraEnvs.length}`, ``,
        `| BMH | Namespace | State | Online | Hardware Profile |`, `|---|---|---|---|---|`,
      ];
      for (const b of bmhs.slice(0, 30)) {
        lines.push(`| ${b.metadata.name} | ${b.metadata.namespace} | ${b.status?.provisioning?.state || "-"} | ${b.status?.poweredOn ? "yes" : "no"} | ${b.spec?.hardwareProfile || "-"} |`);
      }
      if (agents.length > 0) {
        lines.push(``, `#### Assisted Installer Agents`, ``, `| Agent | Cluster | Approved | Stage |`, `|---|---|---|---|`);
        for (const a of agents.slice(0, 20)) {
          lines.push(`| ${a.metadata.name} | ${a.spec?.clusterDeploymentName?.name || "-"} | ${a.spec?.approved ? "yes" : "no"} | ${a.status?.progress?.currentStage || "-"} |`);
        }
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "baremetal"] };
    } catch (e) {
      return { reply: `[ERROR] /baremetal: ${e.message}`, contextKeys: ["slash", "baremetal"] };
    }
  }

  // ---- Sprint B: /performance — PerformanceProfile / Tuned ----
  if (cmd === "performance" || cmd === "perf" || cmd === "tuning") {
    try {
      const [ppData, tunedData] = await Promise.all([
        ocpGet("/apis/performance.openshift.io/v2/performanceprofiles").catch(() => ({ items: [] })),
        ocpGet("/apis/tuned.openshift.io/v1/tuneds").catch(() => ({ items: [] })),
      ]);
      const pps = ppData.items || [];
      const tuneds = tunedData.items || [];
      if (pps.length === 0 && tuneds.length === 0) {
        return { reply: "### Performance Tuning\n[INFO] No PerformanceProfiles or Tuneds found.", contextKeys: ["slash", "performance"] };
      }
      const lines = [`### Performance Tuning`, ``, `**PerformanceProfiles:** ${pps.length} | **Tuneds:** ${tuneds.length}`, ``];
      for (const p of pps) {
        const isolatedCpu = p.spec?.cpu?.isolated || "-";
        const reservedCpu = p.spec?.cpu?.reserved || "-";
        const hp = (p.spec?.hugepages?.pages || []).map((h) => `${h.count}x${h.size}`).join(", ") || "-";
        lines.push(`- **PerformanceProfile** \`${p.metadata.name}\` — Isolated CPU: \`${isolatedCpu}\`, Reserved: \`${reservedCpu}\`, HugePages: ${hp}`);
      }
      if (tuneds.length > 0) {
        lines.push(``, `#### Tuneds (showing first 10)`);
        for (const t of tuneds.slice(0, 10)) {
          lines.push(`  - **${t.metadata.name}** — Profiles: ${(t.spec?.profile || []).map((p) => p.name).join(", ") || "-"}`);
        }
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "performance"] };
    } catch (e) {
      return { reply: `[ERROR] /performance: ${e.message}`, contextKeys: ["slash", "performance"] };
    }
  }

  // ---- Sprint B: /ai — OpenShift AI / RHODS resources ----
  if (cmd === "ai" || cmd === "rhods" || cmd === "ml" || cmd === "datascience") {
    try {
      const [dscData, nbData, isvcData] = await Promise.all([
        ocpGet("/apis/datasciencecluster.opendatahub.io/v1/datascienceclusters").catch(() => ({ items: [] })),
        ocpGet("/apis/kubeflow.org/v1/notebooks").catch(() => ({ items: [] })),
        ocpGet("/apis/serving.kserve.io/v1beta1/inferenceservices").catch(() => ({ items: [] })),
      ]);
      const dscs = dscData.items || [];
      const notebooks = nbData.items || [];
      const isvcs = isvcData.items || [];
      if (dscs.length === 0 && notebooks.length === 0 && isvcs.length === 0) {
        return { reply: "### OpenShift AI / RHODS\n[INFO] OpenShift AI / RHODS not installed. Install from OperatorHub for Notebooks, Pipelines, KServe model serving.", contextKeys: ["slash", "ai"] };
      }
      const lines = [
        `### OpenShift AI / RHODS`, ``,
        `**DataScienceClusters:** ${dscs.length} | **Notebooks:** ${notebooks.length} | **InferenceServices:** ${isvcs.length}`, ``,
      ];
      for (const d of dscs) lines.push(`- **DSC** \`${d.metadata.name}\` — Phase: ${d.status?.phase || "-"}`);
      if (notebooks.length > 0) {
        lines.push(``, `#### Notebooks`, ``, `| Notebook | Namespace | Image |`, `|---|---|---|`);
        for (const n of notebooks.slice(0, 20)) {
          const img = n.spec?.template?.spec?.containers?.[0]?.image?.split("/").pop() || "-";
          lines.push(`| ${n.metadata.name} | ${n.metadata.namespace} | ${img} |`);
        }
      }
      if (isvcs.length > 0) {
        lines.push(``, `#### Inference Services`, ``, `| Service | Namespace | URL | Ready |`, `|---|---|---|---|`);
        for (const s of isvcs.slice(0, 20)) {
          const ready = (s.status?.conditions || []).find((c) => c.type === "Ready")?.status || "?";
          lines.push(`| ${s.metadata.name} | ${s.metadata.namespace} | ${s.status?.url || "-"} | ${ready} |`);
        }
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "ai"] };
    } catch (e) {
      return { reply: `[ERROR] /ai: ${e.message}`, contextKeys: ["slash", "ai"] };
    }
  }

  // ---- Sprint B: /metallb — MetalLB / load-balancer config ----
  if (cmd === "metallb" || cmd === "lb") {
    try {
      const [poolData, peerData] = await Promise.all([
        ocpGet("/apis/metallb.io/v1beta1/ipaddresspools").catch(() => ({ items: [] })),
        ocpGet("/apis/metallb.io/v1beta2/bgppeers").catch(() => ({ items: [] })),
      ]);
      const pools = poolData.items || [];
      const peers = peerData.items || [];
      if (pools.length === 0 && peers.length === 0) {
        return { reply: "### MetalLB\n[INFO] No MetalLB resources found.", contextKeys: ["slash", "metallb"] };
      }
      const lines = [`### MetalLB Configuration`, ``, `**IPAddressPools:** ${pools.length} | **BGPPeers:** ${peers.length}`, ``];
      if (pools.length > 0) {
        lines.push(`#### IP Address Pools`, ``, `| Pool | Namespace | Addresses |`, `|---|---|---|`);
        for (const p of pools) lines.push(`| ${p.metadata.name} | ${p.metadata.namespace} | ${(p.spec?.addresses || []).join(", ")} |`);
        lines.push(``);
      }
      if (peers.length > 0) {
        lines.push(`#### BGP Peers`, ``, `| Peer | Namespace | ASN | Address |`, `|---|---|---|---|`);
        for (const p of peers) lines.push(`| ${p.metadata.name} | ${p.metadata.namespace} | ${p.spec?.peerASN || "-"} | ${p.spec?.peerAddress || "-"} |`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "metallb"] };
    } catch (e) {
      return { reply: `[ERROR] /metallb: ${e.message}`, contextKeys: ["slash", "metallb"] };
    }
  }

  // ---- Sprint B: /webhooks — admission controllers ----
  if (cmd === "webhooks" || cmd === "admission") {
    try {
      const [mwData, vwData] = await Promise.all([
        ocpGet("/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations").catch(() => ({ items: [] })),
        ocpGet("/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations").catch(() => ({ items: [] })),
      ]);
      const mws = mwData.items || [];
      const vws = vwData.items || [];
      const lines = [
        `### Admission Webhooks`, ``,
        `**Mutating:** ${mws.length} | **Validating:** ${vws.length}`, ``,
        `| Type | Name | Webhooks | Failure Policy |`, `|---|---|---|---|`,
      ];
      for (const m of mws.slice(0, 30)) {
        const fp = (m.webhooks || [])[0]?.failurePolicy || "-";
        lines.push(`| Mutating | ${m.metadata.name} | ${(m.webhooks || []).length} | ${fp} |`);
      }
      for (const v of vws.slice(0, 30)) {
        const fp = (v.webhooks || [])[0]?.failurePolicy || "-";
        lines.push(`| Validating | ${v.metadata.name} | ${(v.webhooks || []).length} | ${fp} |`);
      }
      lines.push(``, `**Caution:** A misconfigured admission webhook can block all writes to the API server.`);
      return { reply: lines.join("\n"), contextKeys: ["slash", "webhooks"] };
    } catch (e) {
      return { reply: `[ERROR] /webhooks: ${e.message}`, contextKeys: ["slash", "webhooks"] };
    }
  }

  // ---- Sprint B: /argocd — ArgoCD Applications detailed ----
  if (cmd === "argocd" || cmd === "apps" || cmd === "argo") {
    const ns = arg || null;
    try {
      const appData = await ocpGet(ns ? `/apis/argoproj.io/v1alpha1/namespaces/${ns}/applications` : "/apis/argoproj.io/v1alpha1/applications").catch(() => ({ items: [] }));
      const apps = appData.items || [];
      if (apps.length === 0) {
        return { reply: "### ArgoCD Applications\n[INFO] No Applications found. ArgoCD / OpenShift GitOps may not be installed.", contextKeys: ["slash", "argocd"] };
      }
      const synced = apps.filter((a) => a.status?.sync?.status === "Synced");
      const oos = apps.filter((a) => a.status?.sync?.status === "OutOfSync");
      const healthy = apps.filter((a) => a.status?.health?.status === "Healthy");
      const degraded = apps.filter((a) => a.status?.health?.status === "Degraded");
      const lines = [
        `### ArgoCD Applications${ns ? ` (${ns})` : ""}`, ``,
        `@@SUMMARY|green:${synced.length} Synced|amber:${oos.length} Out-of-Sync|red:${degraded.length} Degraded@@`, ``,
        `**Apps:** ${apps.length} | **Synced:** ${synced.length} | **Healthy:** ${healthy.length}`, ``,
        `| App | Namespace | Sync | Health | Repo |`, `|---|---|---|---|---|`,
      ];
      for (const a of apps.slice(0, 30)) {
        const sync = a.status?.sync?.status || "-";
        const health = a.status?.health?.status || "-";
        const repo = a.spec?.source?.repoURL?.split("/").slice(-2).join("/") || "-";
        lines.push(`| ${a.metadata.name} | ${a.metadata.namespace} | ${sync} | ${health} | ${repo} |`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "argocd"] };
    } catch (e) {
      return { reply: `[ERROR] /argocd: ${e.message}`, contextKeys: ["slash", "argocd"] };
    }
  }

  // ---- Sprint C: /bulk — bulk operations across many resources ----
  if (cmd === "bulk" || cmd === "cleanup") {
    if (!arg) {
      return {
        reply: "### Bulk Operations\n\nUse `/bulk <action>` to perform safe, AI-assisted bulk changes.\n\n**Examples:**\n- `/bulk delete evicted pods` — clean up all evicted pods cluster-wide\n- `/bulk delete completed pods` — clean up completed jobs/pods\n- `/bulk delete terminating pods` — force-delete pods stuck in Terminating\n- `/bulk restart crashing pods` — restart all CrashLoopBackOff pods\n- `/bulk delete failed jobs` — clean up failed Job objects\n- `/bulk delete orphaned pvs` — find PVs without matching PVCs",
        contextKeys: ["slash", "bulk"],
      };
    }
    try {
      const action = arg.toLowerCase();
      if (/\bevicted\b/.test(action)) {
        const data = await ocpGet("/api/v1/pods?fieldSelector=status.phase=Failed");
        const evicted = (data.items || []).filter((p) => p.status?.reason === "Evicted");
        if (evicted.length === 0) return { reply: "### Bulk Cleanup\n[OK] No Evicted pods found.", contextKeys: ["slash", "bulk"] };
        const lines = [`### Bulk Cleanup — ${evicted.length} Evicted Pod(s)`, ``];
        lines.push(`| Namespace | Pod | Node |`, `|---|---|---|`);
        for (const p of evicted.slice(0, 50)) {
          lines.push(`| ${p.metadata.namespace} | ${p.metadata.name} | ${p.spec?.nodeName || "-"} |`);
        }
        lines.push(``, `**Delete all Evicted pods (executes ${evicted.length} delete operations):**`);
        lines.push(`@@SEC_FIX_CMD|oc get pods -A --field-selector=status.phase=Failed -o json | jq -r '.items[] | select(.status.reason=="Evicted") | "oc delete pod " + .metadata.name + " -n " + .metadata.namespace' | sh@@`);
        return { reply: lines.join("\n"), contextKeys: ["slash", "bulk"] };
      }
      if (/\bcompleted\b/.test(action)) {
        const data = await ocpGet("/api/v1/pods?fieldSelector=status.phase=Succeeded");
        const items = data.items || [];
        const lines = [`### Bulk Cleanup — ${items.length} Completed Pod(s)`, ``];
        if (items.length === 0) return { reply: "### Bulk Cleanup\n[OK] No Completed pods found.", contextKeys: ["slash", "bulk"] };
        lines.push(`**Delete all completed pods:**`);
        lines.push(`@@SEC_FIX_CMD|oc delete pods --field-selector=status.phase=Succeeded -A@@`);
        return { reply: lines.join("\n"), contextKeys: ["slash", "bulk"] };
      }
      if (/\bterminating\b/.test(action)) {
        const pods = await ocpGet("/api/v1/pods");
        const terminating = (pods.items || []).filter((p) => p.metadata?.deletionTimestamp);
        const lines = [`### Bulk Cleanup — ${terminating.length} Terminating Pod(s)`, ``];
        for (const p of terminating.slice(0, 30)) {
          lines.push(`  - **${p.metadata.namespace}/${p.metadata.name}** — Deletion started: ${p.metadata.deletionTimestamp}`);
        }
        lines.push(``, `**Force-delete all stuck-in-Terminating pods (use with caution):**`);
        lines.push(`@@SEC_FIX_CMD|oc get pods -A -o json | jq -r '.items[] | select(.metadata.deletionTimestamp != null) | "oc delete pod " + .metadata.name + " -n " + .metadata.namespace + " --grace-period=0 --force"' | sh@@`);
        return { reply: lines.join("\n"), contextKeys: ["slash", "bulk"] };
      }
      if (/\bcrash/.test(action) || /\brestart\b/.test(action)) {
        const data = await ocpGet("/api/v1/pods");
        const crashing = (data.items || []).filter((p) => (p.status?.containerStatuses || []).some((c) => c.state?.waiting?.reason === "CrashLoopBackOff"));
        const lines = [`### Bulk Restart — ${crashing.length} CrashLoopBackOff Pod(s)`, ``];
        if (crashing.length === 0) return { reply: "### Bulk Restart\n[OK] No CrashLoopBackOff pods.", contextKeys: ["slash", "bulk"] };
        for (const p of crashing.slice(0, 30)) lines.push(`  - ${p.metadata.namespace}/${p.metadata.name}`);
        lines.push(``, `**Force-recreate all crashing pods (deployments will respawn them with fresh state):**`);
        lines.push(`@@SEC_FIX_CMD|oc get pods -A -o json | jq -r '.items[] | select(.status.containerStatuses[]?.state.waiting.reason=="CrashLoopBackOff") | "oc delete pod " + .metadata.name + " -n " + .metadata.namespace' | sh@@`);
        return { reply: lines.join("\n"), contextKeys: ["slash", "bulk"] };
      }
      if (/\bfailed\b/.test(action) && /\bjob/.test(action)) {
        const data = await ocpGet("/apis/batch/v1/jobs");
        const failed = (data.items || []).filter((j) => (j.status?.conditions || []).some((c) => c.type === "Failed" && c.status === "True"));
        const lines = [`### Bulk Cleanup — ${failed.length} Failed Job(s)`, ``];
        if (failed.length === 0) return { reply: "### Bulk Cleanup\n[OK] No failed Jobs.", contextKeys: ["slash", "bulk"] };
        for (const j of failed.slice(0, 30)) lines.push(`  - ${j.metadata.namespace}/${j.metadata.name}`);
        lines.push(``, `**Delete all failed jobs:**`);
        lines.push(`@@SEC_FIX_CMD|oc get jobs -A -o json | jq -r '.items[] | select(.status.conditions[]? | select(.type=="Failed" and .status=="True")) | "oc delete job " + .metadata.name + " -n " + .metadata.namespace' | sh@@`);
        return { reply: lines.join("\n"), contextKeys: ["slash", "bulk"] };
      }
      if (/\borphan/.test(action) && /\bpv\b/.test(action)) {
        const [pvData, pvcData] = await Promise.all([ocpGet("/api/v1/persistentvolumes"), ocpGet("/api/v1/persistentvolumeclaims")]);
        const claimedRefs = new Set((pvcData.items || []).map((c) => `${c.metadata.namespace}/${c.metadata.name}`));
        const orphans = (pvData.items || []).filter((pv) => {
          const ref = pv.spec?.claimRef;
          if (!ref) return pv.status?.phase === "Released" || pv.status?.phase === "Available";
          return !claimedRefs.has(`${ref.namespace}/${ref.name}`);
        });
        const lines = [`### Bulk Cleanup — ${orphans.length} Orphaned PV(s)`, ``];
        if (orphans.length === 0) return { reply: "### Bulk Cleanup\n[OK] No orphaned PVs.", contextKeys: ["slash", "bulk"] };
        for (const pv of orphans.slice(0, 30)) lines.push(`  - **${pv.metadata.name}** — Phase: ${pv.status?.phase}, Capacity: ${pv.spec?.capacity?.storage || "-"}`);
        lines.push(``, `**Caution:** Verify each PV before deleting. Some may have ReclaimPolicy=Retain holding important data.`);
        return { reply: lines.join("\n"), contextKeys: ["slash", "bulk"] };
      }
      return { reply: `[INFO] Unknown bulk action: '${arg}'. See \`/bulk\` for examples.`, contextKeys: ["slash", "bulk"] };
    } catch (e) {
      return { reply: `[ERROR] /bulk: ${e.message}`, contextKeys: ["slash", "bulk"] };
    }
  }

  // ---- Sprint C: /changes — change timeline (recent events + audit) ----
  if (cmd === "changes" || cmd === "timeline" || cmd === "whatchanged") {
    try {
      const since = arg ? parseDuration(arg) : 60 * 60 * 1000;
      const sinceISO = new Date(Date.now() - since).toISOString();
      const [eventsData, auditRows] = await Promise.all([
        ocpGet("/api/v1/events?limit=500").catch(() => ({ items: [] })),
        (async () => {
          try {
            const { query: dbq, isEnabled } = await import("../utils/db.js");
            if (!(await isEnabled())) return [];
            const r = await dbq("SELECT action, target, namespace, success, created_at FROM executed_actions WHERE created_at >= $1 ORDER BY id DESC LIMIT 100", [sinceISO]);
            return r?.rows || [];
          } catch { return []; }
        })(),
      ]);
      const events = (eventsData.items || []).filter((e) => new Date(e.lastTimestamp || e.eventTime || 0) >= new Date(sinceISO));
      const lines = [
        `### Change Timeline (since ${new Date(sinceISO).toLocaleString()})`, ``,
        `@@SUMMARY|amber:${events.length} Cluster Events|green:${auditRows.length} Executed Actions@@`, ``,
      ];
      if (auditRows.length > 0) {
        lines.push(`#### Executed Actions`, ``, `| Time | Action | Target | Namespace | Result |`, `|---|---|---|---|---|`);
        for (const r of auditRows.slice(0, 30)) {
          const t = new Date(r.created_at).toLocaleTimeString();
          lines.push(`| ${t} | ${r.action} | ${r.target || "-"} | ${r.namespace || "-"} | ${r.success ? "OK" : "FAIL"} |`);
        }
        lines.push(``);
      }
      const grouped = {};
      for (const e of events) {
        const k = `${e.reason}::${e.involvedObject?.kind || "?"}`;
        (grouped[k] = grouped[k] || []).push(e);
      }
      const sortedReasons = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length).slice(0, 12);
      if (sortedReasons.length > 0) {
        lines.push(`#### Top Cluster Events`, ``, `| Reason | Kind | Count | Latest Example |`, `|---|---|---|---|`);
        for (const [k, evs] of sortedReasons) {
          const [reason, kind] = k.split("::");
          const latest = evs[evs.length - 1];
          lines.push(`| ${reason} | ${kind} | ${evs.length} | ${latest.involvedObject?.namespace || ""}/${latest.involvedObject?.name || ""} |`);
        }
      }
      lines.push(``, `**Filter by namespace:** \`/changes <duration> <namespace>\``);
      lines.push(`**Duration formats:** \`5m\`, \`1h\`, \`24h\`, \`7d\``);
      return { reply: lines.join("\n"), contextKeys: ["slash", "changes"] };
    } catch (e) {
      return { reply: `[ERROR] /changes: ${e.message}`, contextKeys: ["slash", "changes"] };
    }
  }

  // ---- Sprint C: /forecast — capacity prediction ----
  if (cmd === "forecast" || cmd === "predict" || cmd === "capacity") {
    try {
      const nodesData = await ocpGet("/api/v1/nodes");
      const podsData = await ocpGet("/api/v1/pods");
      const nodes = nodesData.items || [];
      const pods = podsData.items || [];
      let totalCpuM = 0, totalMemBytes = 0, requestedCpuM = 0, requestedMemBytes = 0;
      for (const n of nodes) {
        totalCpuM += parseCpuToMillicores(n.status?.allocatable?.cpu || "0");
        totalMemBytes += parseMemToBytes(n.status?.allocatable?.memory || "0");
      }
      for (const p of pods) {
        for (const c of (p.spec?.containers || [])) {
          requestedCpuM += parseCpuToMillicores(c.resources?.requests?.cpu || "0");
          requestedMemBytes += parseMemToBytes(c.resources?.requests?.memory || "0");
        }
      }
      const cpuPct = totalCpuM > 0 ? Math.round((requestedCpuM / totalCpuM) * 100) : 0;
      const memPct = totalMemBytes > 0 ? Math.round((requestedMemBytes / totalMemBytes) * 100) : 0;
      // Simple linear extrapolation — assumes current growth rate from pod count growth
      const podCount = pods.length;
      const growthPodsPerWeek = Math.max(5, Math.round(podCount * 0.05));
      const cpuPerPodM = podCount > 0 ? Math.round(requestedCpuM / podCount) : 0;
      const memPerPodM = podCount > 0 ? Math.round(requestedMemBytes / podCount / (1024 * 1024)) : 0;
      const weeksToCpuExhaust = cpuPerPodM > 0 ? Math.max(0, Math.floor((totalCpuM - requestedCpuM) / (cpuPerPodM * growthPodsPerWeek))) : 999;
      const weeksToMemExhaust = memPerPodM > 0 ? Math.max(0, Math.floor((totalMemBytes / (1024 * 1024) - requestedMemBytes / (1024 * 1024)) / (memPerPodM * growthPodsPerWeek))) : 999;
      const lines = [
        `### Capacity Forecast`, ``,
        `@@KPI|${cpuPct}%|CPU Requested@@`,
        `@@KPI|${memPct}%|Memory Requested@@`,
        `@@KPI|${Math.min(weeksToCpuExhaust, weeksToMemExhaust)}w|Weeks Until Saturation@@`, ``,
        `**Current state:**`,
        `  - Total Nodes: ${nodes.length}`,
        `  - Total Pods: ${podCount}`,
        `  - CPU: ${Math.round(requestedCpuM/1000)} / ${Math.round(totalCpuM/1000)} cores requested (${cpuPct}%)`,
        `  - Memory: ${Math.round(requestedMemBytes/(1024**3))} / ${Math.round(totalMemBytes/(1024**3))} GiB requested (${memPct}%)`, ``,
        `**Forecast (linear, ${growthPodsPerWeek} pods/week growth assumption):**`,
        `  - CPU exhaustion: ~${weeksToCpuExhaust} weeks`,
        `  - Memory exhaustion: ~${weeksToMemExhaust} weeks`, ``,
        `**Recommendation:**`,
      ];
      if (Math.min(weeksToCpuExhaust, weeksToMemExhaust) < 4) {
        lines.push(`  - [CRITICAL] Add capacity within ${Math.min(weeksToCpuExhaust, weeksToMemExhaust)} weeks. Scale MachineSets or add nodes now.`);
      } else if (Math.min(weeksToCpuExhaust, weeksToMemExhaust) < 12) {
        lines.push(`  - [WARN] Plan capacity expansion within ${Math.min(weeksToCpuExhaust, weeksToMemExhaust)} weeks. Order hardware or budget cloud capacity.`);
      } else {
        lines.push(`  - [OK] Sufficient runway. Re-run forecast monthly to track trend.`);
      }
      lines.push(``, `**Note:** This forecast uses linear extrapolation from current resource requests. For more accurate predictions, integrate Prometheus history with \`/kb capacity planning\`.`);
      return { reply: lines.join("\n"), contextKeys: ["slash", "forecast"] };
    } catch (e) {
      return { reply: `[ERROR] /forecast: ${e.message}`, contextKeys: ["slash", "forecast"] };
    }
  }

  // ---- Sprint C: /kb — knowledge base / runbook lookup ----
  if (cmd === "kb" || cmd === "knowledge" || cmd === "runbook" || cmd === "kcs") {
    if (!arg) {
      return {
        reply: "### Knowledge Base\n\nUse `/kb <query>` to search internal runbooks, Red Hat KCS articles, and team playbooks.\n\n**Examples:**\n- `/kb ImagePullBackOff`\n- `/kb etcd recovery`\n- `/kb operator stuck pending`\n- `/kb network policy debugging`\n\nLearned from past resolutions in your cluster and seeded with Red Hat KCS references.",
        contextKeys: ["slash", "kb"],
      };
    }
    try {
      const { kbFindSimilar } = await import("./knowledge.js").catch(() => ({}));
      if (!kbFindSimilar) {
        return { reply: `### Knowledge Base Lookup: \`${arg}\`\n\n[INFO] Internal KB module unavailable. Search Red Hat Knowledge Centered Service:\n\nhttps://access.redhat.com/search/?q=${encodeURIComponent(arg)}+OpenShift`, contextKeys: ["slash", "kb"] };
      }
      const matches = await kbFindSimilar({ symptoms: arg, limit: 5 });
      if (!matches || matches.length === 0) {
        return { reply: `### Knowledge Base Lookup: \`${arg}\`\n\n[INFO] No matching entries in internal KB. Try Red Hat KCS: https://access.redhat.com/search/?q=${encodeURIComponent(arg)}+OpenShift`, contextKeys: ["slash", "kb"] };
      }
      const lines = [`### Knowledge Base Matches: \`${arg}\``, ``];
      for (const m of matches) {
        lines.push(`#### ${m.title || m.kind || "Match"} (relevance ${Math.round((m.score || 0) * 100)}%)`);
        lines.push(m.summary || m.resolution || "-");
        lines.push(``);
        if (m.runbookUrl) lines.push(`Runbook: ${m.runbookUrl}`);
        lines.push(``);
      }
      lines.push(`**Tip:** Run \`/playbook\` to see learned patterns from past resolutions.`);
      return { reply: lines.join("\n"), contextKeys: ["slash", "kb"] };
    } catch (e) {
      return { reply: `[ERROR] /kb: ${e.message}`, contextKeys: ["slash", "kb"] };
    }
  }

  // ---- Sprint C: /provision — self-service workflow (namespace + quotas + RBAC) ----
  if (cmd === "provision" || cmd === "onboard") {
    if (!arg) {
      return {
        reply: "### Self-Service Provisioning\n\nUse `/provision namespace <name> for team <team>` to bootstrap a new namespace with quotas, limit ranges, RBAC, and NetworkPolicy.\n\n**Examples:**\n- `/provision namespace payments-dev for team payments`\n- `/provision app my-app in payments-dev`\n- `/provision quota 8cpu 16Gi for payments-dev`",
        contextKeys: ["slash", "provision"],
      };
    }
    try {
      // Parse "namespace X for team Y"
      const nsMatch = arg.match(/namespace\s+(\S+)(?:\s+for\s+team\s+(\S+))?/i);
      if (nsMatch) {
        const ns = nsMatch[1];
        const team = nsMatch[2] || ns;
        const yamlBlock = `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}
  labels:
    team: ${team}
    managed-by: tcs-agentic-ai
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ${ns}-quota
  namespace: ${ns}
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    persistentvolumeclaims: "10"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: ${ns}-limits
  namespace: ${ns}
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${ns}-default-deny
  namespace: ${ns}
spec:
  podSelector: {}
  policyTypes: ["Ingress","Egress"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${ns}-team-admin
  namespace: ${ns}
subjects:
- kind: Group
  name: ${team}
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: admin
  apiGroup: rbac.authorization.k8s.io`;
        return {
          reply: `### Provision Namespace: \`${ns}\` for team \`${team}\`\n\nThe following bundle creates a namespace with quotas, limit ranges, default-deny NetworkPolicy, and team RoleBinding:\n\n\`\`\`yaml\n${yamlBlock}\n\`\`\`\n\n**Apply:**\n@@SEC_FIX_CMD|cat <<'EOF' | oc apply -f -\n${yamlBlock}\nEOF@@\n\n**Tip:** Customize the quota values before applying for your team's workload size.`,
          contextKeys: ["slash", "provision"],
        };
      }
      return { reply: "### Provision\n[INFO] Unrecognized provision request. Try `/provision namespace <name> for team <team>`.", contextKeys: ["slash", "provision"] };
    } catch (e) {
      return { reply: `[ERROR] /provision: ${e.message}`, contextKeys: ["slash", "provision"] };
    }
  }

  // ---- Sprint D: /incidents — episodic memory of past incidents ----
  if (cmd === "incidents" || cmd === "history") {
    try {
      const { listIncidents } = await import("./episodic-memory.js");
      const limit = Math.min(parseInt(arg, 10) || 20, 100);
      const incidents = await listIncidents({ limit });
      if (incidents.length === 0) {
        return { reply: "### Incident History\n[INFO] No incidents recorded yet. Incidents are auto-captured when CrashLoopBackOff, OOMKilled, or other anomalies are detected.", contextKeys: ["slash", "incidents"] };
      }
      const lines = [`### Incident History (last ${incidents.length})`, ``, `| Time | Severity | Resource | Symptom | Resolution |`, `|---|---|---|---|---|`];
      for (const i of incidents) {
        const t = new Date(i.created_at).toLocaleString();
        const r = i.resource_kind && i.resource_name ? `${i.resource_kind}/${i.resource_name}` : "-";
        const res = i.resolution ? i.resolution.slice(0, 50) : (i.resolved_at ? "resolved" : "open");
        lines.push(`| ${t} | ${i.severity || "-"} | ${r} | ${(i.symptom || "").slice(0, 40)} | ${res} |`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "incidents"] };
    } catch (e) {
      return { reply: `[ERROR] /incidents: ${e.message}`, contextKeys: ["slash", "incidents"] };
    }
  }

  // ---- Sprint D: /suggestions — proactive recommendations ----
  if (cmd === "suggestions" || cmd === "suggest" || cmd === "proactive") {
    try {
      const { generateSuggestions } = await import("./proactive-agent.js");
      const sugg = await generateSuggestions();
      if (!sugg || sugg.length === 0) {
        return { reply: "### Proactive Suggestions\n[OK] No proactive suggestions at this time. Your cluster looks healthy.", contextKeys: ["slash", "suggestions"] };
      }
      const lines = [`### Proactive Suggestions (${sugg.length})`, ``];
      for (const s of sugg) {
        const sev = s.severity === "critical" ? "[CRITICAL]" : s.severity === "high" ? "[HIGH]" : s.severity === "medium" ? "[MEDIUM]" : "[INFO]";
        lines.push(`#### ${sev} ${s.title}`);
        lines.push(s.detail);
        if (s.action) {
          lines.push(``, `**Suggested action:**`);
          lines.push(`@@SEC_FIX_CMD|${s.action}@@`);
        }
        lines.push(``);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "suggestions"] };
    } catch (e) {
      return { reply: `[ERROR] /suggestions: ${e.message}`, contextKeys: ["slash", "suggestions"] };
    }
  }

  // ---- Sprint D: /approvals — approval chain status ----
  if (cmd === "approvals" || cmd === "pending-approvals") {
    try {
      const { listPendingApprovals } = await import("./approval-chains.js");
      const pending = await listPendingApprovals();
      if (!pending || pending.length === 0) {
        return { reply: "### Approvals\n[OK] No pending approvals.", contextKeys: ["slash", "approvals"] };
      }
      const lines = [`### Pending Approvals (${pending.length})`, ``, `| ID | Action | Requested By | Approver | Status |`, `|---|---|---|---|---|`];
      for (const p of pending) {
        lines.push(`| ${p.id} | ${p.action} | ${p.requested_by || "-"} | ${p.approver_role || "any"} | ${p.status} |`);
      }
      lines.push(``, `**Approve:** \`oc patch chatapproval <id> --type=merge -p '{"status":"approved"}'\` or use the dashboard.`);
      return { reply: lines.join("\n"), contextKeys: ["slash", "approvals"] };
    } catch (e) {
      return { reply: `[ERROR] /approvals: ${e.message}`, contextKeys: ["slash", "approvals"] };
    }
  }

  // ---- Sprint D: /reflect — verify outcomes of recent actions ----
  if (cmd === "reflect" || cmd === "verify") {
    try {
      const { runReflectionCheck } = await import("./reflection.js");
      const report = await runReflectionCheck({ lookbackMinutes: parseInt(arg, 10) || 60 });
      if (!report || report.checked === 0) {
        return { reply: "### Reflection\n[OK] No recent actions to verify.", contextKeys: ["slash", "reflect"] };
      }
      const lines = [
        `### Action Reflection (last ${report.lookbackMinutes}m)`, ``,
        `@@SUMMARY|green:${report.confirmed} Confirmed|amber:${report.unknown} Unknown|red:${report.regressed} Regressed@@`, ``,
      ];
      for (const item of report.items.slice(0, 20)) {
        const icon = item.status === "confirmed" ? "[OK]" : item.status === "regressed" ? "[FAIL]" : "[?]";
        lines.push(`  - ${icon} **${item.action}** on \`${item.target}\` — ${item.verdict}`);
      }
      return { reply: lines.join("\n"), contextKeys: ["slash", "reflect"] };
    } catch (e) {
      return { reply: `[ERROR] /reflect: ${e.message}`, contextKeys: ["slash", "reflect"] };
    }
  }

  // ---- Tier 2: /export — dump resources in YAML/JSON/CSV ----
  if (cmd === "export") {
    if (!arg) {
      return { reply: "### Export\n\nUse `/export <resource> [namespace] [as yaml|json|csv]` to export resources.\n\n**Examples:**\n- `/export deployments my-ns as yaml`\n- `/export pods as csv`\n- `/export configmaps my-ns`", contextKeys: ["slash", "export"] };
    }
    try {
      const tokens = arg.split(/\s+/);
      const resource = tokens[0];
      let format = "yaml";
      let ns = null;
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i].toLowerCase();
        if (t === "as" && tokens[i + 1]) { format = tokens[i + 1].toLowerCase(); i++; }
        else if (t === "yaml" || t === "json" || t === "csv") format = t;
        else if (!ns) ns = tokens[i];
      }
      const apiPath = await resolveResourcePath(resource, ns);
      if (!apiPath) return { reply: `[ERROR] Unknown resource: ${resource}`, contextKeys: ["slash", "export"] };
      const data = await ocpGet(apiPath);
      const items = data.items || [data];
      let body;
      if (format === "json") body = JSON.stringify(items, null, 2);
      else if (format === "csv") body = toCSV(items);
      else body = toYAML(items);
      const truncated = body.length > 12000;
      const out = truncated ? body.slice(0, 12000) + "\n\n... [truncated — full export was " + body.length + " bytes]" : body;
      return { reply: `### Export: ${resource}${ns ? ` (${ns})` : ""} as ${format}\n\n\`\`\`${format === "csv" ? "" : format}\n${out}\n\`\`\``, contextKeys: ["slash", "export"] };
    } catch (e) {
      return { reply: `[ERROR] /export: ${e.message}`, contextKeys: ["slash", "export"] };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers for /export — resolve resource to API path, render YAML/CSV
// ---------------------------------------------------------------------------
async function resolveResourcePath(resource, ns) {
  const r = (resource || "").toLowerCase();
  const map = {
    pod: ns ? `/api/v1/namespaces/${ns}/pods` : "/api/v1/pods",
    pods: ns ? `/api/v1/namespaces/${ns}/pods` : "/api/v1/pods",
    deployment: ns ? `/apis/apps/v1/namespaces/${ns}/deployments` : "/apis/apps/v1/deployments",
    deployments: ns ? `/apis/apps/v1/namespaces/${ns}/deployments` : "/apis/apps/v1/deployments",
    service: ns ? `/api/v1/namespaces/${ns}/services` : "/api/v1/services",
    services: ns ? `/api/v1/namespaces/${ns}/services` : "/api/v1/services",
    configmap: ns ? `/api/v1/namespaces/${ns}/configmaps` : "/api/v1/configmaps",
    configmaps: ns ? `/api/v1/namespaces/${ns}/configmaps` : "/api/v1/configmaps",
    secret: ns ? `/api/v1/namespaces/${ns}/secrets` : "/api/v1/secrets",
    secrets: ns ? `/api/v1/namespaces/${ns}/secrets` : "/api/v1/secrets",
    route: ns ? `/apis/route.openshift.io/v1/namespaces/${ns}/routes` : "/apis/route.openshift.io/v1/routes",
    routes: ns ? `/apis/route.openshift.io/v1/namespaces/${ns}/routes` : "/apis/route.openshift.io/v1/routes",
    pvc: ns ? `/api/v1/namespaces/${ns}/persistentvolumeclaims` : "/api/v1/persistentvolumeclaims",
    pvcs: ns ? `/api/v1/namespaces/${ns}/persistentvolumeclaims` : "/api/v1/persistentvolumeclaims",
    namespace: "/api/v1/namespaces",
    namespaces: "/api/v1/namespaces",
    node: "/api/v1/nodes",
    nodes: "/api/v1/nodes",
  };
  return map[r] || null;
}

function toYAML(items) {
  const lines = [];
  for (const it of items) {
    lines.push("---");
    lines.push(yamlStringify(it, 0));
  }
  return lines.join("\n");
}

function yamlStringify(obj, indent) {
  const pad = "  ".repeat(indent);
  const out = [];
  if (obj == null) return `${pad}null`;
  if (typeof obj === "string") return JSON.stringify(obj);
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    for (const it of obj) {
      if (typeof it === "object" && it !== null) {
        out.push(`${pad}-`);
        out.push(yamlStringify(it, indent + 1));
      } else {
        out.push(`${pad}- ${yamlStringify(it, 0)}`);
      }
    }
    return out.join("\n");
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (typeof v === "object" && v !== null && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
        out.push(`${pad}${k}:`);
        out.push(yamlStringify(v, indent + 1));
      } else {
        out.push(`${pad}${k}: ${yamlStringify(v, 0)}`);
      }
    }
    return out.join("\n");
  }
  return String(obj);
}

function toCSV(items) {
  if (!items || items.length === 0) return "";
  const rows = [];
  rows.push(["name", "namespace", "kind", "creationTimestamp", "phase/status", "resourceVersion"].join(","));
  for (const it of items) {
    const phase = it.status?.phase || it.status?.conditions?.find((c) => c.type === "Ready")?.status || "-";
    rows.push([
      csvEscape(it.metadata?.name),
      csvEscape(it.metadata?.namespace),
      csvEscape(it.kind),
      csvEscape(it.metadata?.creationTimestamp),
      csvEscape(phase),
      csvEscape(it.metadata?.resourceVersion),
    ].join(","));
  }
  return rows.join("\n");
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------------------------------------------------------------------------
// Sprint C helpers — duration parsing, CPU/memory conversion
// ---------------------------------------------------------------------------
function parseDuration(s) {
  const m = String(s || "").match(/^(\d+)\s*(s|m|h|d|w)?$/i);
  if (!m) return 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "m").toLowerCase();
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60_000;
  if (unit === "h") return n * 3_600_000;
  if (unit === "d") return n * 86_400_000;
  if (unit === "w") return n * 7 * 86_400_000;
  return n * 60_000;
}

function parseCpuToMillicores(v) {
  if (!v) return 0;
  const s = String(v);
  if (s.endsWith("m")) return parseInt(s.slice(0, -1), 10) || 0;
  if (s.endsWith("n")) return Math.round((parseInt(s.slice(0, -1), 10) || 0) / 1_000_000);
  const num = parseFloat(s);
  return isNaN(num) ? 0 : Math.round(num * 1000);
}

function parseMemToBytes(v) {
  if (!v) return 0;
  const s = String(v).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMGTPE]?i?)$/);
  if (!m) {
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }
  const n = parseFloat(m[1]);
  const unit = m[2];
  const multipliers = { "": 1, K: 1000, Ki: 1024, M: 1e6, Mi: 1024 ** 2, G: 1e9, Gi: 1024 ** 3, T: 1e12, Ti: 1024 ** 4, P: 1e15, Pi: 1024 ** 5, E: 1e18, Ei: 1024 ** 6 };
  return Math.round(n * (multipliers[unit] || 1));
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

// ===========================================================================
// FLEET AI — "ask across all clusters" (single pane of glass, fleet view)
//
// Aggregates a compact snapshot of every connected cluster (hub + agents)
// and answers fleet-wide questions: upgrades available, health overview,
// version inventory, problem pods, security posture, capacity. Falls back
// to the LLM with the aggregated fleet context for free-form questions.
// ===========================================================================

function _fleetClusterFromReport(name, platform, report, status, agentVersion) {
  const isOCP = !!(report?.openshiftVersion) || platform === "openshift";
  const nodes = report?.nodes || {};
  const pods = report?.pods || {};
  const ops = report?.clusterOperators || {};
  const sec = report?.security || null;
  return {
    name,
    platform: platform || (isOCP ? "openshift" : "k8s"),
    isOpenShift: isOCP,
    version: report?.openshiftVersion || report?.kubernetesVersion || "unknown",
    health: (report?.clusterHealth?.status || "unknown").toLowerCase(),
    nodesTotal: nodes.total || 0,
    nodesReady: nodes.ready || 0,
    podsTotal: pods.total || 0,
    podsFailed: pods.failed || 0,
    podsPending: pods.pending || 0,
    podIssues: (pods.issues || []).length,
    operatorsTotal: ops.total || 0,
    operatorsDegraded: ops.degraded || 0,
    namespaces: report?.namespaces?.total || 0,
    cpu: report?.resourceSummary?.totalCPU || 0,
    memGi: report?.resourceSummary?.totalMemoryGi || 0,
    securityScore: sec && sec.available !== false ? sec.score : null,
    securityGrade: sec && sec.available !== false ? sec.grade : null,
    status: status || "unknown",
    role: "spoke",
    availableUpdates: null, // filled live on demand for upgrade queries
  };
}

/** Build a compact snapshot of the whole fleet (hub + all agents). */
async function buildFleetSnapshot() {
  const clusters = [];

  // --- Hub (local) ---
  try {
    let hub = { name: "hub", platform: "openshift", role: "hub", status: "active",
      isOpenShift: true, version: "unknown", health: "unknown",
      nodesTotal: 0, nodesReady: 0, podsTotal: 0, podsFailed: 0, podsPending: 0,
      podIssues: 0, operatorsTotal: 0, operatorsDegraded: 0, namespaces: 0,
      cpu: 0, memGi: 0, securityScore: null, securityGrade: null, availableUpdates: null };
    const [cvR, verR, nodesR] = await Promise.allSettled([
      ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
      ocpGet("/version"),
      ocpGet("/api/v1/nodes"),
    ]);
    if (cvR.status === "fulfilled" && cvR.value) {
      hub.isOpenShift = true;
      hub.version = cvR.value.status?.desired?.version || "unknown";
      hub.channel = cvR.value.spec?.channel || "";
      hub.availableUpdates = (cvR.value.status?.availableUpdates || []).map(u => u.version);
      const conds = cvR.value.status?.conditions || [];
      const failing = conds.find(c => c.type === "Failing" && c.status === "True");
      hub.health = failing ? "degraded" : "healthy";
    } else if (verR.status === "fulfilled" && verR.value) {
      hub.isOpenShift = false; hub.platform = "k8s";
      hub.version = (verR.value.gitVersion || "").replace(/^v/, "") || "unknown";
      hub.health = "healthy";
    }
    if (nodesR.status === "fulfilled" && nodesR.value) {
      const items = nodesR.value.items || [];
      hub.nodesTotal = items.length;
      hub.nodesReady = items.filter(n => (n.status?.conditions || []).find(c => c.type === "Ready")?.status === "True").length;
      if (hub.nodesReady < hub.nodesTotal && hub.health === "healthy") hub.health = "warning";
    }
    clusters.push(hub);
  } catch { /* hub summary best-effort */ }

  // --- Agents (remote spokes) ---
  try {
    const agents = getConnectedAgents();
    for (const [, a] of agents) {
      if (a.source === "dashboard" && !a.lastReport) continue;
      const elapsed = a.lastReportTime ? (Date.now() - new Date(a.lastReportTime).getTime()) / 1000 : null;
      const status = elapsed !== null && elapsed < 300 ? "active" : elapsed !== null ? "stale" : "registered";
      clusters.push(_fleetClusterFromReport(a.clusterName, a.platform, a.lastReport, status, a.agentVersion));
    }
  } catch { /* ignore */ }

  return clusters;
}

/** Fetch availableUpdates live for OpenShift clusters (hub + bridged agents). */
async function enrichFleetUpgrades(snapshot) {
  await Promise.allSettled(snapshot.map(async (c) => {
    if (!c.isOpenShift || Array.isArray(c.availableUpdates)) return;
    if (c.role === "hub") return; // already done in snapshot
    if (!hasActiveChannel(c.name)) { c.availableUpdates = null; return; }
    try {
      const cv = await withRemoteClusterBridge(c.name, () =>
        ocpGet("/apis/config.openshift.io/v1/clusterversions/version"));
      c.availableUpdates = (cv.status?.availableUpdates || []).map(u => u.version);
      c.channel = cv.spec?.channel || c.channel;
    } catch { c.availableUpdates = null; }
  }));
}

function _latestVersion(versions) {
  if (!versions || !versions.length) return null;
  return [...versions].sort((a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); }
    return 0;
  })[0];
}

function _healthIcon(h) {
  return h === "healthy" ? "[OK]" : h === "warning" ? "[WARNING]" : (h === "degraded" || h === "critical") ? "[CRITICAL]" : "[—]";
}

/** Rule-based fleet answers. Returns markdown or null to fall through to LLM. */
async function handleFleetQuery(message, snapshot) {
  const lower = (message || "").toLowerCase();
  const total = snapshot.length;
  const hdr = `> **Fleet** · ${total} cluster${total === 1 ? "" : "s"} · ${snapshot.filter(c => c.status === "active").length} active\n`;

  // --- Upgrades available across the fleet ---
  if (/\bupgrade|\bupdate(s)?\b|\bnew version|\bout.?of.?date|\bpatch\b/.test(lower)) {
    await enrichFleetUpgrades(snapshot);
    const parts = [hdr, `### Upgrade Availability Across the Fleet`, ""];
    parts.push(`| Cluster | Platform | Current | Latest available | Status |`);
    parts.push(`| --- | --- | --- | --- | --- |`);
    let upgradable = 0;
    snapshot.forEach(c => {
      if (!c.isOpenShift) {
        parts.push(`| \`${c.name}\` | ${c.platform.toUpperCase()} | ${c.version} | — | n/a (non-OCP) |`);
        return;
      }
      if (!Array.isArray(c.availableUpdates)) {
        parts.push(`| \`${c.name}\` | OCP | ${c.version} | ? | ${c.role === "hub" ? "—" : "agent offline"} |`);
        return;
      }
      const latest = _latestVersion(c.availableUpdates);
      if (latest && latest !== c.version) {
        upgradable++;
        parts.push(`| \`${c.name}\` | OCP | ${c.version} | **${latest}** (${c.availableUpdates.length}) | [WARNING] upgrade available |`);
      } else {
        parts.push(`| \`${c.name}\` | OCP | ${c.version} | — | [OK] up to date |`);
      }
    });
    parts.push("");
    parts.push(upgradable > 0
      ? `**${upgradable} cluster(s) have upgrades available.** Select a cluster from the Fleet view, then ask *"precheck upgrade to <version>"* to run the assessment.`
      : `[OK] All OpenShift clusters are up to date.`);
    return parts.join("\n");
  }

  // --- Health / status / overview ---
  if (/\bhealth|\bstatus|\boverview|\bsummary|\bhow.+(?:cluster|fleet)|\bwhich.+(?:unhealthy|degraded|down|problem)/.test(lower)) {
    const parts = [hdr, `### Fleet Health Overview`, ""];
    parts.push(`| Cluster | Role | Platform | Version | Health | Nodes | Pod issues |`);
    parts.push(`| --- | --- | --- | --- | --- | --- | --- |`);
    snapshot.forEach(c => {
      parts.push(`| \`${c.name}\` | ${c.role} | ${c.platform.toUpperCase()} | ${c.version} | ${_healthIcon(c.health)} ${c.health} | ${c.nodesReady}/${c.nodesTotal} | ${c.podIssues} |`);
    });
    const unhealthy = snapshot.filter(c => c.health === "degraded" || c.health === "critical" || c.health === "warning");
    const offline = snapshot.filter(c => c.status === "stale" || c.status === "registered");
    parts.push("");
    parts.push(`**Summary:** ${snapshot.filter(c => c.health === "healthy").length}/${total} healthy` +
      (unhealthy.length ? ` · ${unhealthy.length} need attention (${unhealthy.map(c => c.name).join(", ")})` : "") +
      (offline.length ? ` · ${offline.length} agent(s) not reporting (${offline.map(c => c.name).join(", ")})` : ""));
    return parts.join("\n");
  }

  // --- Problem pods / critical issues across fleet ---
  if (/\b(pod|workload).*(issue|problem|fail|crash|error)|\bcritical\b|\bproblem|\bfailing\b/.test(lower)) {
    const parts = [hdr, `### Problem Pods Across the Fleet`, ""];
    const withIssues = snapshot.filter(c => c.podIssues > 0 || c.podsFailed > 0);
    if (withIssues.length === 0) { parts.push(`[OK] No problem pods detected across any cluster.`); return parts.join("\n"); }
    parts.push(`| Cluster | Problem pods | Failed | Pending |`);
    parts.push(`| --- | --- | --- | --- |`);
    withIssues.sort((a, b) => b.podIssues - a.podIssues).forEach(c => {
      parts.push(`| \`${c.name}\` | ${c.podIssues} | ${c.podsFailed} | ${c.podsPending} |`);
    });
    const totalIssues = snapshot.reduce((s, c) => s + c.podIssues, 0);
    parts.push("");
    parts.push(`**${totalIssues} problem pod(s)** across ${withIssues.length} cluster(s). Open a cluster and ask *"show pod issues"* for details.`);
    return parts.join("\n");
  }

  // --- Security posture across fleet ---
  if (/\bsecurity|\bcompliance|\bvulnerab|\bcis\b|\bposture|\bhardening/.test(lower)) {
    const parts = [hdr, `### Security Posture Across the Fleet`, ""];
    const scored = snapshot.filter(c => c.securityScore != null);
    if (scored.length === 0) { parts.push(`> No security scan data reported yet. Agents collect this on their next scan.`); return parts.join("\n"); }
    parts.push(`| Cluster | Score | Grade |`);
    parts.push(`| --- | --- | --- |`);
    scored.sort((a, b) => a.securityScore - b.securityScore).forEach(c => {
      parts.push(`| \`${c.name}\` | ${c.securityScore}/100 | ${c.securityGrade} |`);
    });
    const avg = Math.round(scored.reduce((s, c) => s + c.securityScore, 0) / scored.length);
    parts.push("");
    parts.push(`**Fleet average:** ${avg}/100. Weakest: \`${scored[0].name}\` (${scored[0].securityScore}).`);
    return parts.join("\n");
  }

  // --- Inventory / versions / capacity ---
  if (/\binventory|\blist.+cluster|\ball.+cluster|\bversion|\bwhat.+cluster|\bcapacity|\bnodes?\b|\bcpu|\bmemory/.test(lower)) {
    const parts = [hdr, `### Fleet Inventory`, ""];
    parts.push(`| Cluster | Role | Platform | Version | Nodes | CPU | Mem (Gi) | Namespaces |`);
    parts.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
    snapshot.forEach(c => {
      parts.push(`| \`${c.name}\` | ${c.role} | ${c.platform.toUpperCase()} | ${c.version} | ${c.nodesReady}/${c.nodesTotal} | ${c.cpu} | ${c.memGi} | ${c.namespaces} |`);
    });
    const totNodes = snapshot.reduce((s, c) => s + c.nodesTotal, 0);
    const totCpu = Math.round(snapshot.reduce((s, c) => s + c.cpu, 0));
    const totMem = Math.round(snapshot.reduce((s, c) => s + c.memGi, 0));
    parts.push("");
    parts.push(`**Fleet totals:** ${total} clusters · ${totNodes} nodes · ${totCpu} CPU cores · ${totMem} Gi memory.`);
    return parts.join("\n");
  }

  return null; // fall through to LLM
}

function _fleetContextString(snapshot) {
  const lines = ["FLEET SNAPSHOT (all connected clusters):"];
  snapshot.forEach(c => {
    lines.push(`- ${c.name} [${c.role}] platform=${c.platform} version=${c.version} health=${c.health} ` +
      `nodes=${c.nodesReady}/${c.nodesTotal} podIssues=${c.podIssues} failedPods=${c.podsFailed} ` +
      `operatorsDegraded=${c.operatorsDegraded} namespaces=${c.namespaces} ` +
      `security=${c.securityScore != null ? c.securityScore + "/100(" + c.securityGrade + ")" : "n/a"} status=${c.status}`);
  });
  return lines.join("\n");
}

/** POST /api/fleet/chat — fleet-wide AI across all clusters. */
export async function handleFleetChatAPI(req, res) {
  try {
    const body = await readBody(req);
    const message = body.message;
    if (!message) return json(res, 400, { error: "Missing 'message' field" });

    const snapshot = await buildFleetSnapshot();
    if (snapshot.length === 0) {
      return json(res, 200, { reply: "No clusters are connected yet. Add clusters from the AI Hub to use fleet-wide queries.", provider: "built-in", scope: "fleet" });
    }

    // Rule-based fleet answer first.
    let reply = await handleFleetQuery(message, snapshot);
    let provider = "built-in";

    // LLM fallback with aggregated fleet context.
    if (!reply) {
      const llmOpts = {};
      if (body.provider) llmOpts.provider = body.provider;
      if (body.apiKey) llmOpts.apiKey = body.apiKey;
      if (body.apiUrl) llmOpts.apiUrl = body.apiUrl;
      if (body.model) llmOpts.model = body.model;
      if (body.azureDeployment) llmOpts.azureDeployment = body.azureDeployment;
      if (body.azureApiVersion) llmOpts.azureApiVersion = body.azureApiVersion;
      await resolveLLMOpts(llmOpts);
      const active = (llmOpts.provider || LLM_PROVIDER) && (llmOpts.provider || LLM_PROVIDER) !== "none";
      if (active) {
        try {
          const sys = "You are a multi-cluster SRE assistant. You are given a snapshot of ALL clusters in a fleet. " +
            "Answer the user's question using ONLY this fleet data. Be concise, use markdown tables when comparing clusters, " +
            "and call out which specific clusters are affected. Do not invent clusters or metrics not present in the data.";
          const r = await callLLM({
            messages: [{ role: "user", content: `${message}\n\n--- ${_fleetContextString(snapshot)}` }],
            system: sys, maxTokens: 1500, temperature: 0.15, ...llmOpts,
          });
          reply = r?.text || null;
          provider = llmOpts.provider || LLM_PROVIDER;
        } catch (e) {
          reply = null;
        }
      }
      // Built-in fallback: a fleet overview.
      if (!reply) {
        reply = await handleFleetQuery("fleet health overview", snapshot);
        provider = "built-in";
      }
    }

    return json(res, 200, { reply, provider, scope: "fleet", clusterCount: snapshot.length });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
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
  let _traceContextKeys = [];
  let _traceToolsUsed = [];
  let _traceStatus = "success";

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

    // Remote cluster override — use cached agent data for context
    const _remoteClusterContext = resolveRemoteClusterContext(body);

    // When a remote cluster with a LIVE bridge is selected, route every
    // ocpGet() in this request through the agent bridge. This makes the
    // existing preflight / upgrade-validation / CR logic operate on the
    // remote cluster unchanged (industry-standard agent-pull pattern).
    const _remoteBridgeActive = !!(_remoteClusterContext && hasActiveChannel(_remoteClusterContext.clusterName));
    if (_remoteBridgeActive) {
      enterRemoteClusterBridge(_remoteClusterContext.clusterName);
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
    // The dashboard caches a MASKED api key from GET /api/settings/llm and
    // echoes it back here. Resolve the real key (and any omitted provider
    // config) from server-side storage so the LLM works for EVERY cluster,
    // not just whichever one happened to have a full key cached client-side.
    await resolveLLMOpts(llmOpts);

    // ---- View-more pagination handler ----
    const viewMoreMatch = userMessage.match(/^__viewmore__\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)$/);
    if (viewMoreMatch) {
      const vmReply = await handleViewMore(viewMoreMatch[1], viewMoreMatch[2], parseInt(viewMoreMatch[3], 10), parseInt(viewMoreMatch[4], 10));
      const provider = "built-in";
      if (conversationId) {
        histAddMessage(conversationId, { role: "assistant", content: vmReply, provider }).catch(() => {});
      }
      const wantsStreamVM = body.stream === true || (req.headers.accept || "").includes("text/event-stream");
      if (wantsStreamVM) {
        sseStart(res);
        sseSend(res, { stage: "querying" });
        sseSend(res, { delta: vmReply });
        sseSend(res, { done: true, provider, conversationId });
        sseEnd(res);
        return;
      }
      return json(res, 200, { reply: vmReply, provider, contextKeys: ["viewMore"], cached: false, conversationId });
    }

    // ---- View-more pagination for /recommendations tables ----
    const viewMoreRecMatch = userMessage.match(/^__viewmore_rec__\s+(\S+)\s+(\d+)\s+(\d+)$/);
    if (viewMoreRecMatch) {
      const vmrReply = await handleViewMoreRecommendation(viewMoreRecMatch[1], parseInt(viewMoreRecMatch[2], 10), parseInt(viewMoreRecMatch[3], 10));
      const provider = "built-in";
      if (conversationId) {
        histAddMessage(conversationId, { role: "assistant", content: vmrReply, provider }).catch(() => {});
      }
      const wantsStreamVMR = body.stream === true || (req.headers.accept || "").includes("text/event-stream");
      if (wantsStreamVMR) {
        sseStart(res);
        sseSend(res, { stage: "querying" });
        sseSend(res, { delta: vmrReply });
        sseSend(res, { done: true, provider, conversationId });
        sseEnd(res);
        return;
      }
      return json(res, 200, { reply: vmrReply, provider, contextKeys: ["viewMore"], cached: false, conversationId });
    }

    const slashReply = await maybeHandleSlashCommand(userMessage, conversationId, llmOpts);
    if (slashReply) {
      const slashProvider = slashReply.provider || "built-in";
      let finalReply = slashReply.reply;
      if (conversationId) {
        histAddMessage(conversationId, {
          role: "assistant",
          content: finalReply,
          provider: slashProvider,
        }).catch(() => {});
      }
      // Support SSE streaming for slash commands — the UI may request streaming
      const wantsStreamSlash = body.stream === true || (req.headers.accept || "").includes("text/event-stream");
      if (wantsStreamSlash) {
        sseStart(res);
        sseSend(res, { stage: "querying" });
        sseSend(res, { delta: finalReply });
        sseSend(res, { done: true, provider: slashProvider, conversationId });
        sseEnd(res);
        return;
      }
      return json(res, 200, {
        reply: finalReply,
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
    const llmActive = activeProvider && activeProvider !== "none";

    // ---- NLU: parse the message once, with conversation memory for
    // follow-up resolution ("show its logs", "delete it", "same in prod").
    const memory = await getMemory(conversationId).catch(() => null);
    let parsed = nluParse(userMessage, memory);
    if (parsed.confidence < 0.45 && typeof nluEnhanceWithLLM === 'function') {
      try { parsed = await nluEnhanceWithLLM(parsed, userMessage, llmOpts || {}); } catch(e) {}
    }
    intentsForLog = [parsed.intent, parsed.resource, parsed.scope]
      .filter(Boolean);

    // Pillar 1 + 3: Inject parsed NLU + user identity for context augmentation
    llmOpts.parsed = parsed;
    llmOpts.userId = body.userId || req.headers["x-user-id"] || null;
    llmOpts.conversationId = conversationId;

    // Pillar 2: Build reasoning trace from the parse result. Persisted at
    // end of request so the UI can show the chain-of-thought.
    let reasoningTrace = null;
    if (body.reasoning !== false && body.reasoning !== "off") {
      try {
        const r = await import("./reasoning.js");
        reasoningTrace = r.traceFromNluParse(parsed, userMessage, conversationId);
      } catch { /* silent */ }
    }

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
    // Mutating intents and intents with dedicated direct-handlers always
    // bypass the cache so they hit the live cluster and return real data.
    const CACHE_BYPASS_INTENTS = new Set([
      "delete", "update", "exec", "run", "create", "start", "stop", "upgrade",
      "rbac", "rollout", "rollback", "drain", "cordon", "uncordon",
      "taint", "untaint", "approve", "compare", "export", "snapshot", "resize",
      "label", "annotate", "evict",
      "diagnose", "mustgather",
      "slo", "saturation", "incident", "postmortem", "impact",
      "deprecated", "webhook", "supplychain", "imagestale", "hardening",
      "podsecurity", "capacity", "mcpdrift", "pdb", "topology",
      "probes", "hpa", "orphaned", "governance",
      "alerts", "gitops", "imagescan", "backup", "fleet",
      "compliance", "automation", "optimize", "network", "identity", "certlife",
      "cluster_lifecycle", "addon_management", "deploy_strategy",
      "expose_service", "sa_security", "node_autoscale",
      "cloud_monitoring", "cloud_imagescan", "secret_management",
      "storage_config", "cost_optimization", "vpa", "service_mesh",
      "incident_response",
    ]);
    const isHealthScope = parsed.scope === "health" || /\bhealth\b|\bstatus\b|\bdiagnos|\btroubleshoot/.test(userMessage.toLowerCase());
    const isMutating = CACHE_BYPASS_INTENTS.has(parsed.intent) || isHealthScope;
    const activeClusterForCache = _remoteClusterContext?.clusterName || body.cluster || "local";
    const cacheKey = `${activeClusterForCache}:${cacheKeyForChat(userMessage, activeProvider)}`;

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

    // ---- Intent Shortcut: bypass LLM for simple list/count queries ----
    // For queries that are pure data formatting (list pods, count nodes, etc.),
    // gather context and format directly without calling the LLM.
    if (!_remoteClusterContext && parsed.intent === "list" && !llmActive) {
      try {
        const shortcutCtx = await gatherClusterContext(userMessage, parsed, null);
        const shortcut = tryShortcut(parsed, shortcutCtx, getPlatform());
        if (shortcut.handled) {
          const provider = "built-in";
          const payload = { reply: shortcut.reply, provider, contextKeys: [parsed.intent, parsed.resource].filter(Boolean) };
          cacheSet(cacheKey, payload, CHAT_CACHE_TTL).catch(() => {});
          if (conversationId) {
            histAddMessage(conversationId, { role: "assistant", content: shortcut.reply, provider }).catch(() => {});
          }
          if (wantsStream) {
            sseStart(res);
            sseSend(res, { stage: "querying" });
            sseSend(res, { delta: shortcut.reply });
            sseSend(res, { done: true, provider, conversationId });
            sseEnd(res);
            return;
          }
          return json(res, 200, { ...payload, cached: false, conversationId });
        }
      } catch { /* shortcut failed, continue to normal path */ }
    }

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
      const clusterScopedTypes = new Set(["namespace", "project", "node", "nodes", "pv", "pvs", "persistentvolume", "clusteroperator", "clusterrole", "clusterrolebinding"]);
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

    // ---- Greeting handler: professional welcome with live cluster context ----
    const GREETING_PAT = /^\s*(hi|hello|hey|howdy|greetings|good\s*(morning|afternoon|evening|day)|yo|sup|what'?s\s*up|hola|bonjour)\s*[.!?]*\s*$/i;
    if (GREETING_PAT.test(userMessage)) {
      let clusterVersion = "unknown";
      let clusterChannel = "";
      let nodeCount = 0;
      let readyNodes = 0;
      let operatorCount = 0;
      let degradedCount = 0;
      let healthStatus = "Unknown";
      let clusterLabel = "";
      let platformLabel = "OpenShift";

      if (_remoteClusterContext) {
        const rs = _remoteClusterContext.summary || {};
        clusterVersion = rs.cluster?.version || "unknown";
        clusterChannel = rs.cluster?.channel || "";
        nodeCount = rs.nodes?.total || 0;
        readyNodes = rs.nodes?.ready || 0;
        operatorCount = rs.operators?.total || 0;
        degradedCount = rs.operators?.degraded || 0;
        healthStatus = degradedCount > 0 ? "Degraded" : readyNodes < nodeCount ? "Warning" : "Healthy";
        clusterLabel = _remoteClusterContext.clusterName || "";
        if (rs.platform) {
          const p = rs.platform.toLowerCase();
          if (p === "eks") platformLabel = "EKS";
          else if (p === "aks") platformLabel = "AKS";
          else if (p === "gke") platformLabel = "GKE";
          else if (p === "rancher") platformLabel = "Rancher";
          else if (p === "openshift") platformLabel = "OpenShift";
          else platformLabel = rs.platform;
        }
      } else {
        try {
          const [cvRes, nodesRes, opsRes, k8sVerRes] = await Promise.allSettled([
            ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
            ocpGet("/api/v1/nodes"),
            ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
            ocpGet("/version"),
          ]);
          const isOCP = cvRes.status === "fulfilled" && cvRes.value?.status?.desired?.version;
          if (isOCP) {
            clusterVersion = cvRes.value.status.desired.version;
            clusterChannel = cvRes.value.spec?.channel || "";
            platformLabel = "OpenShift";
          } else if (k8sVerRes.status === "fulfilled") {
            clusterVersion = k8sVerRes.value?.gitVersion || "unknown";
            platformLabel = "Kubernetes";
          }
          if (nodesRes.status === "fulfilled") {
            const items = nodesRes.value.items || [];
            nodeCount = items.length;
            readyNodes = items.filter(n =>
              (n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True")
            ).length;
          }
          if (isOCP && opsRes.status === "fulfilled") {
            const items = opsRes.value.items || [];
            operatorCount = items.length;
            degradedCount = items.filter(o =>
              (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True")
            ).length;
          }
          healthStatus = degradedCount > 0 ? "Degraded" : readyNodes < nodeCount ? "Warning" : "Healthy";
        } catch { /* best effort */ }
      }

      const healthIcon = healthStatus === "Healthy" ? "[OK]" : healthStatus === "Degraded" ? "[CRITICAL]" : "[WARNING]";
      const connectedLine = clusterLabel
        ? `You are connected to **${clusterLabel}** (${platformLabel} ${clusterVersion})${clusterChannel ? ` (${clusterChannel})` : ""}.`
        : `You are connected to **${platformLabel} ${clusterVersion}**${clusterChannel ? ` (${clusterChannel})` : ""}.`;

      const isOCPGreeting = platformLabel === "OpenShift";
      const opsRow = operatorCount > 0
        ? `| Cluster Operators | ${operatorCount - degradedCount}/${operatorCount} Available${degradedCount > 0 ? ` (${degradedCount} degraded)` : ""} |`
        : null;
      const reply = [
        `### Welcome to TCS Agentic AI`,
        ``,
        connectedLine,
        ``,
        `| Property | Status |`,
        `| --- | --- |`,
        `| Cluster Health | ${healthIcon} **${healthStatus}** |`,
        `| Nodes | ${readyNodes}/${nodeCount} Ready |`,
        ...(opsRow ? [opsRow] : []),
        ``,
        `I can help you manage, troubleshoot, and monitor your cluster. Here are some things you can try:`,
        ``,
        `**Quick actions:**`,
        `  - \`check cluster health\` — overall cluster status and issues`,
        `  - \`show pods with issues\` — pods in error states`,
        `  - \`list deployments\` — all deployments across namespaces`,
        `  - \`show node metrics\` — CPU and memory utilization`,
        ``,
        `**Diagnostics:**`,
        `  - \`why is pod <name> failing?\` — deep diagnosis with root cause`,
        `  - \`show events in <namespace>\` — recent cluster events`,
        `  - \`diagnostics\` — full health check across all components`,
        ``,
        `**Operations:**`,
        `  - \`/security\` — security & compliance audit`,
        ...(isOCPGreeting ? [`  - \`/operators\` — operator lifecycle status`] : []),
        `  - \`/recommendations\` — optimization suggestions`,
        `  - \`upgrade precheck\` — pre-flight readiness check`,
        ``,
        `Type \`help\` to see the full list of supported commands.`,
      ].join("\n");

      const provider = "built-in";
      if (conversationId) {
        histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
      }
      if (wantsStream) {
        sseStart(res);
        sseSend(res, { stage: "querying" });
        sseSend(res, { delta: reply });
        sseSend(res, { done: true, provider, conversationId });
        sseEnd(res);
        return;
      }
      return json(res, 200, { reply, provider, contextKeys: ["greeting"], cached: false, conversationId });
    }

    // ---- Smart disambiguation: ask clarifying question when intent is ambiguous ----
    // Only triggers for short/vague queries with low NLU confidence and no
    // conversation history that would resolve the ambiguity.
    const hasHistory = Array.isArray(llmOpts.history) && llmOpts.history.length > 0;
    // Skip ambiguity detection for remote clusters — let handleRemoteCacheQuery
    // decide how to respond (it provides a cluster overview for short queries).
    if (!hasHistory && !_remoteClusterContext) {
      const clarifyToken = detectAmbiguity(userMessage, parsed, memory);
      if (clarifyToken) {
        const reply = clarifyToken;
        const provider = "built-in";
        if (conversationId) {
          histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
        }
        if (wantsStream) {
          sseStart(res);
          sseSend(res, { stage: "querying" });
          sseSend(res, { delta: reply });
          sseSend(res, { done: true, provider, conversationId });
          sseEnd(res);
          return;
        }
        return json(res, 200, { reply, provider, contextKeys: ["clarify", parsed.intent], cached: false, conversationId });
      }
    }

    // ---- Confidence-based routing ----
    // Very low confidence with no conversation history — ask for clarification
    // rather than risk a poor answer.  Skip for remote clusters.
    const confidence = parsed.confidence || 0;
    if (confidence < 0.3 && !hasHistory && !_remoteClusterContext) {
      const reply = `I'm not sure I understood your question correctly. Could you rephrase or provide more details?\n\nFor example, you can ask:\n- "Show pods with issues in namespace X"\n- "Check cluster health"\n- "Diagnose pod my-pod-xyz"\n- "List deployments in production"`;
      const provider = "built-in";
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
      return json(res, 200, { reply, provider, contextKeys: ["lowConfidence"], cached: false, conversationId });
    }

    // High confidence with a clear built-in intent and no LLM configured —
    // route directly to builtInAnalysis without the overhead of LLM context
    // preparation.  This fast-path covers pod_issues, cluster_health, nodes, etc.
    const FAST_BUILT_IN_INTENTS = new Set(["list", "get", "describe", "diagnose", "health"]);
    const FAST_BUILT_IN_RESOURCES = new Set(["pod", "node", "deployment", "cluster", "namespace", "service"]);
    if (
      confidence > 0.8 &&
      FAST_BUILT_IN_INTENTS.has(parsed.intent) &&
      FAST_BUILT_IN_RESOURCES.has(parsed.resource) &&
      !llmEnabled(llmOpts)
    ) {
      try {
        const fastCtx = await gatherClusterContext(userMessage, parsed, _remoteClusterContext);
        const reply = builtInAnalysis(userMessage, fastCtx);
        const provider = "built-in";
        if (conversationId) {
          histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
        }
        updateMemory(conversationId, memoryPatchFromParse(parsed)).catch(() => {});
        if (wantsStream) {
          sseStart(res);
          sseSend(res, { stage: "querying" });
          sseSend(res, { stage: "generating" });
          sseSend(res, { delta: reply });
          sseSend(res, { done: true, provider, conversationId });
          sseEnd(res);
          return;
        }
        return json(res, 200, {
          reply,
          provider,
          contextKeys: Object.keys(fastCtx || {}),
          cached: false,
          conversationId,
        });
      } catch (e) {
        console.warn("[chat-api] fast built-in path failed, falling through:", e.message);
        // Fall through to normal handling
      }
    }

    // ---- ITSM: detect "raise change request" / "create incident" ----
    const itsmType = await detectITSMIntent(userMessage);
    if (itsmType) {
      const label = itsmType === "change_request" ? "Change Request" : "Incident";

      // Auto-run preflight assessment for upgrade-related Change Requests
      // and pass the report INTO the CR form fields so they're pre-populated.
      let preflightSection = "";
      let preflightReport = null;
      const isUpgradeRelated = /upgrade|pre-?(?:check|flight)|above\s+(?:pre|check|assessment|details|report)|previous\s+(?:pre|check|assessment)|with\s+(?:above|precheck|pre-?check)/i.test(userMessage);

      // Run ITSM context gather and preflight IN PARALLEL — they're independent.
      // This saves ~20-30s compared to running them sequentially.
      let itsmCtx;
      // For remote upgrade CRs, require a live bridge so the preflight (which
      // gets auto-attached to the CR) runs against the correct cluster.
      if (itsmType === "change_request" && isUpgradeRelated && _remoteClusterContext && !_remoteBridgeActive) {
        const m = `### Change Request Blocked\n\n[WARNING] The agent on **${_remoteClusterContext.clusterName}** is offline, so the mandatory pre-upgrade assessment cannot be attached to the change request.\n\nBring the agent **Active** in AI Hub, then raise the CR again.`;
        if (conversationId) histAddMessage(conversationId, { role: "assistant", content: m, provider: "built-in" }).catch(() => {});
        if (wantsStream) { sseStart(res); sseSend(res, { delta: m }); sseSend(res, { done: true, provider: "built-in", conversationId }); sseEnd(res); return; }
        return json(res, 200, { reply: m, provider: "built-in", contextKeys: ["cr", "bridge_offline"], cached: false, conversationId });
      }
      if (itsmType === "change_request" && isUpgradeRelated) {
        const versionMatch = userMessage.match(/(\d+\.\d+\.\d+)/g);
        let targetVer = "";
        let currentVer = "";
        if (versionMatch && versionMatch.length >= 2) {
          currentVer = versionMatch[0];
          targetVer = versionMatch[1];
        } else if (versionMatch && versionMatch.length === 1) {
          targetVer = versionMatch[0];
        }

        // --- Upgrade version validation (Red Hat prerequisite enforcement) ---
        // Fetch cluster version + available updates to validate before creating a CR.
        if (targetVer) {
          try {
            const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
            const clusterCurrentVer = cv?.status?.desired?.version || cv?.status?.history?.[0]?.version || "";
            const clusterChannel = cv?.spec?.channel || "";
            const clusterUpdates = cv?.status?.availableUpdates || [];
            if (!currentVer) currentVer = clusterCurrentVer;

            const validation = validateUpgradeVersion(currentVer, targetVer, clusterUpdates, clusterChannel);
            if (!validation.valid) {
              // Build a rejection response with available upgrade paths
              const lines = [];
              lines.push(`### Upgrade Validation Failed`);
              lines.push("");
              lines.push(`**Current version:** ${currentVer}`);
              lines.push(`**Requested version:** ${targetVer}`);
              lines.push(`**Channel:** ${clusterChannel}`);
              lines.push("");
              lines.push(`[${validation.severity === "error" ? "CRITICAL" : "WARNING"}] ${validation.reason}`);
              lines.push("");
              if (validation.recommendation) {
                lines.push(`**Recommendation:** ${validation.recommendation}`);
                lines.push("");
              }
              if (validation.suggestedPath?.length) {
                lines.push(`**Required upgrade path:**`);
                lines.push(`\`${currentVer}\` → ${validation.suggestedPath.map(s => `\`${s}.z (latest)\``).join(" → ")}`);
                lines.push("");
                lines.push(`> Complete each minor version upgrade sequentially. Ask me: *"upgrade to ${validation.suggestedPath[0]}"* to start.`);
                lines.push("");
              }
              if (validation.availableVersions && Object.keys(validation.availableVersions).length > 0) {
                lines.push(`**Available upgrades from ${currentVer}:**`);
                for (const [minor, versions] of Object.entries(validation.availableVersions).sort().reverse()) {
                  lines.push(`  **${minor}.x:** ${versions.slice(0, 6).join(", ")}${versions.length > 6 ? ` (+${versions.length - 6} more)` : ""}`);
                }
                lines.push("");
                const allVers = Object.values(validation.availableVersions).flat();
                if (allVers.length > 0) {
                  lines.push(`> Ask me: *"raise change request for upgrade to ${allVers[0]}"* to create a valid CR.`);
                }
              }
              const reply = lines.join("\n");
              const provider = "built-in";
              if (conversationId) histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
              if (wantsStream) {
                sseStart(res);
                sseSend(res, { stage: "querying" });
                sseSend(res, { stage: "generating" });
                sseSend(res, { delta: reply });
                sseSend(res, { done: true, provider, conversationId });
                sseEnd(res);
                return;
              }
              return json(res, 200, { reply, provider, contextKeys: ["upgrade", "validation_failed"], cached: false, conversationId });
            }
          } catch (err) {
            console.warn("[chat-api] upgrade validation fetch failed, proceeding:", err.message);
          }
        }

        const [itsmResult, preflightResult] = await Promise.allSettled([
          gatherITSMContext(userMessage),
          targetVer
            ? runPreflightWithTimeout(targetVer, currentVer || undefined)
            : Promise.resolve(null),
        ]);

        itsmCtx = itsmResult.status === "fulfilled" ? itsmResult.value : {};
        if (preflightResult.status === "fulfilled" && preflightResult.value) {
          preflightReport = preflightResult.value;
          cachePreflightReport(conversationId, preflightReport);
          const reportToken = `@@PREFLIGHT_REPORT|${JSON.stringify(lightPreflightReport(preflightReport)).replace(/@@/g, "@ @")}@@`;
          preflightSection = `${reportToken}\n\n---\n\n`;
        } else if (preflightResult.status === "rejected") {
          console.error("[chat-api] preflight in ITSM path failed:", preflightResult.reason?.message || preflightResult.reason);
        }

        // If no target version was found from user input, try from cluster context
        if (!targetVer && !preflightReport && itsmCtx.cluster?.availableUpdates?.length) {
          targetVer = itsmCtx.cluster.availableUpdates[0];
          try {
            preflightReport = await runPreflightWithTimeout(targetVer);
            cachePreflightReport(conversationId, preflightReport);
            const reportToken = `@@PREFLIGHT_REPORT|${JSON.stringify(lightPreflightReport(preflightReport)).replace(/@@/g, "@ @")}@@`;
            preflightSection = `${reportToken}\n\n---\n\n`;
          } catch (err) {
            console.error("[chat-api] preflight fallback failed:", err.message);
          }
        }

        // Fall back to cached preflight from earlier in this conversation
        if (!preflightReport) {
          preflightReport = getCachedPreflightReport(conversationId);
        }
      } else {
        itsmCtx = await gatherITSMContext(userMessage);
      }

      const form = buildITSMForm(itsmType, userMessage, itsmCtx, preflightReport);
      if (preflightReport) {
        form._preflightReport = preflightReport;
        form._upgradeInfo = {
          targetVersion: preflightReport.targetVersion || "",
          fromVersion: preflightReport.fromVersion || "",
          conversationId: conversationId || "",
        };
      }
      const formToken = `@@ITSM_FORM|${JSON.stringify(form).replace(/@@/g, "@ @")}@@`;

      const reply = `${preflightSection}### ${label} Form\n\nI've auto-populated the ${label.toLowerCase()} form based on the current cluster context${preflightReport ? " and the 22-point pre-upgrade assessment" : ""}. Review and edit the fields below, then submit.\n\n${formToken}`;
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

    // ---- CR status check / upgrade execution: "check CR status", "is CR approved",
    //      "proceed with upgrade", "execute upgrade", "start the upgrade" ----
    const CR_STATUS_PAT = /\b(?:(?:check|status|track|monitor|poll)\s+(?:cr|change\s*request|ticket|CHG)|(?:cr|change\s*request|CHG)\s+(?:status|approved|rejected|state)|(?:is|has)\s+(?:the\s+)?(?:cr|change\s*request|ticket)\s+(?:been\s+)?(?:approved|rejected)|(?:proceed|execute|start|run|initiate|trigger)\s+(?:(?:the|with)\s+)?(?:(?:the|cluster)\s+)?(?:upgrade|cluster\s+upgrade)|(?:upgrade|go\s+ahead)\s+(?:the\s+)?cluster|CHG\d{7})\b/i;
    if (CR_STATUS_PAT.test(userMessage)) {
      const trackedCR = await resolveTrackedCR(conversationId, body.cluster, userMessage);
      const crNumberMatch = userMessage.match(/CHG\d{7}/i);

      // If user is asking about CR status (not explicitly asking to execute)
      const wantsExec = /(?:proceed|execute|start|run|initiate|trigger|go\s+ahead)\s+(?:(?:the|with)\s+)?(?:(?:the|cluster)\s+)?(?:upgrade|cluster)/i.test(userMessage);
      // True only when the user explicitly references a change request — so a
      // generic "upgrade the cluster" still falls through to the preflight path.
      const mentionsCR = /\b(?:cr|change\s*request|ticket)\b|CHG\d{7}/i.test(userMessage);

      if (trackedCR && trackedCR.sysId) {
        try {
          const statusResp = await fetch(`http://localhost:${process.env.PORT || 3001}/api/itsm/cr-status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sysId: trackedCR.sysId, ticketId: trackedCR.ticketId }),
          }).then(r => r.json()).catch(() => null);

          if (statusResp) {
            const pfr = getCachedPreflightReport(conversationId) || trackedCR.preflightReport;
            const vd = pfr?.versionDelta || {};

            if (statusResp.status === "approved" || wantsExec) {
              // Re-validate before execution — cluster state may have changed since CR creation
              const crTargetVer = trackedCR.targetVersion || pfr?.targetVersion || "";
              const crFromVer = trackedCR.fromVersion || pfr?.fromVersion || "";
              if (crTargetVer) {
                try {
                  const cvNow = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
                  const nowVer = cvNow?.status?.desired?.version || crFromVer;
                  const nowUpdates = cvNow?.status?.availableUpdates || [];
                  const nowChannel = cvNow?.spec?.channel || "";
                  const recheck = validateUpgradeVersion(nowVer, crTargetVer, nowUpdates, nowChannel);
                  if (!recheck.valid) {
                    const vLines = [`### Upgrade Blocked at Execution`, "", `Change Request **${statusResp.ticketId || trackedCR.ticketId}** was approved, but the upgrade cannot proceed:`, "", `[${recheck.severity === "error" ? "CRITICAL" : "WARNING"}] ${recheck.reason}`];
                    if (recheck.recommendation) vLines.push("", `**Recommendation:** ${recheck.recommendation}`);
                    const vReply = vLines.join("\n");
                    const provider = "built-in";
                    if (conversationId) histAddMessage(conversationId, { role: "assistant", content: vReply, provider }).catch(() => {});
                    if (wantsStream) {
                      sseStart(res); sseSend(res, { stage: "querying" }); sseSend(res, { delta: vReply });
                      sseSend(res, { done: true, provider, conversationId }); sseEnd(res); return;
                    }
                    return json(res, 200, { reply: vReply, provider, contextKeys: ["upgrade", "validation_failed"], cached: false, conversationId });
                  }
                } catch { /* validation fetch failed — proceed with caution */ }
              }

              const execData = {
                ticketId: statusResp.ticketId || trackedCR.ticketId,
                sysId: trackedCR.sysId,
                targetVersion: trackedCR.targetVersion || pfr?.targetVersion || "",
                fromVersion: trackedCR.fromVersion || pfr?.fromVersion || "",
                upgradeType: pfr?.upgradeType || "",
                channel: pfr?.channel || "",
                preflightStatus: pfr?.overallStatus || "UNKNOWN",
                nodeCount: pfr?.nodeTopology?.total || 0,
                estimatedDuration: vd.estimatedDuration || "",
              };
              const execToken = `@@UPGRADE_EXECUTE|${JSON.stringify(execData).replace(/@@/g, "@ @")}@@`;

              let statusMsg = statusResp.status === "approved"
                ? `Change Request **${statusResp.ticketId}** has been **approved** in ServiceNow (State: ${statusResp.stateLabel}).`
                : `Change Request **${statusResp.ticketId}** is currently in **${statusResp.stateLabel}** state (approval: ${statusResp.approval}).`;

              if (statusResp.status === "approved" || wantsExec) {
                statusMsg += `\n\nYou can now proceed with the cluster upgrade. Choose an option below:`;
              }

              const reply = `${statusMsg}\n\n${execToken}`;
              const provider = "built-in";
              if (conversationId) histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
              if (wantsStream) {
                sseStart(res);
                sseSend(res, { stage: "querying" });
                sseSend(res, { stage: "generating" });
                sseSend(res, { delta: reply });
                sseSend(res, { done: true, provider, conversationId });
                sseEnd(res);
                return;
              }
              return json(res, 200, { reply, provider, contextKeys: ["upgrade", "execute"], cached: false, conversationId });
            } else {
              // CR not yet approved — show status
              const reply = `Change Request **${statusResp.ticketId}** is currently in **${statusResp.stateLabel}** state (approval: ${statusResp.approval}).\n\nI'll continue monitoring. Ask me again or say "proceed with upgrade" once it's approved.`;
              const provider = "built-in";
              if (conversationId) histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
              if (wantsStream) {
                sseStart(res);
                sseSend(res, { stage: "querying" });
                sseSend(res, { delta: reply });
                sseSend(res, { done: true, provider, conversationId });
                sseEnd(res);
                return;
              }
              return json(res, 200, { reply, provider, contextKeys: ["itsm", "cr-status"], cached: false, conversationId });
            }
          }
        } catch { /* fall through to LLM */ }
      } else if (wantsExec) {
        // User wants to execute but we have no tracked CR — build exec card from cluster state
        try {
          const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
          const currentVer = cv?.status?.desired?.version || "";
          const clusterUpdates = cv?.status?.availableUpdates || [];
          const available = clusterUpdates.map(u => u.version);
          const versionMatch = userMessage.match(/(\d+\.\d+\.\d+)/);
          const targetVer = versionMatch ? versionMatch[1] : (available.length > 0 ? available[0] : "");
          const pfr = getCachedPreflightReport(conversationId);

          if (targetVer) {
            // Validate before allowing execution
            const execValidation = validateUpgradeVersion(currentVer, targetVer, clusterUpdates, cv?.spec?.channel || "");
            if (!execValidation.valid) {
              const vLines = [`### Upgrade Blocked`, "", `[${execValidation.severity === "error" ? "CRITICAL" : "WARNING"}] ${execValidation.reason}`];
              if (execValidation.recommendation) vLines.push("", `**Recommendation:** ${execValidation.recommendation}`);
              if (execValidation.suggestedPath?.length) {
                vLines.push("", `**Required path:** \`${currentVer}\` → ${execValidation.suggestedPath.map(s => `\`${s}.z\``).join(" → ")}`);
              }
              if (execValidation.availableVersions && Object.keys(execValidation.availableVersions).length > 0) {
                vLines.push("", `**Available versions:**`);
                for (const [minor, versions] of Object.entries(execValidation.availableVersions).sort().reverse()) {
                  vLines.push(`  **${minor}.x:** ${versions.slice(0, 5).join(", ")}`);
                }
              }
              const vReply = vLines.join("\n");
              const provider = "built-in";
              if (conversationId) histAddMessage(conversationId, { role: "assistant", content: vReply, provider }).catch(() => {});
              if (wantsStream) {
                sseStart(res); sseSend(res, { stage: "querying" }); sseSend(res, { delta: vReply });
                sseSend(res, { done: true, provider, conversationId }); sseEnd(res); return;
              }
              return json(res, 200, { reply: vReply, provider, contextKeys: ["upgrade", "validation_failed"], cached: false, conversationId });
            }

            const execData = {
              ticketId: crNumberMatch ? crNumberMatch[0] : "Direct",
              sysId: "",
              targetVersion: targetVer,
              fromVersion: currentVer,
              upgradeType: pfr?.upgradeType || "",
              channel: cv?.spec?.channel || "",
              preflightStatus: pfr?.overallStatus || "UNKNOWN",
              nodeCount: pfr?.nodeTopology?.total || 0,
              estimatedDuration: pfr?.versionDelta?.estimatedDuration || "",
            };
            const execToken = `@@UPGRADE_EXECUTE|${JSON.stringify(execData).replace(/@@/g, "@ @")}@@`;
            const reply = `Ready to upgrade cluster from **${currentVer}** to **${targetVer}**. Choose an option below:\n\n${execToken}`;
            const provider = "built-in";
            if (conversationId) histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
            if (wantsStream) {
              sseStart(res);
              sseSend(res, { stage: "querying" });
              sseSend(res, { delta: reply });
              sseSend(res, { done: true, provider, conversationId });
              sseEnd(res);
              return;
            }
            return json(res, 200, { reply, provider, contextKeys: ["upgrade", "execute"], cached: false, conversationId });
          }
        } catch { /* fall through */ }
      }

      // Explicit CR status query that we couldn't resolve — return a clear
      // message instead of falling through to a generic resource lookup, which
      // would mis-read "CR" as a pod name ("Pod Not Found: cr").
      if (!wantsExec && mentionsCR) {
        let reply;
        if (trackedCR && !trackedCR.sysId) {
          reply = `### Change Request ${trackedCR.ticketId}\n\nThis change request was saved locally (ServiceNow is not connected), so there is no approval workflow to poll.\n\nYou can proceed with the upgrade when ready — say **"proceed with upgrade${trackedCR.targetVersion ? ` to ${trackedCR.targetVersion}` : ""}"**.`;
        } else {
          reply = `### No Change Request Found\n\nI don't have a change request tracked for this conversation yet.\n\n- Raise one first — ask me to **"raise a change request for the upgrade"**, or\n- Tell me the CR number directly, e.g. **"check CHG0030045"**.`;
        }
        const provider = "built-in";
        if (conversationId) histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
        if (wantsStream) {
          sseStart(res); sseSend(res, { stage: "querying" }); sseSend(res, { delta: reply });
          sseSend(res, { done: true, provider, conversationId }); sseEnd(res); return;
        }
        return json(res, 200, { reply, provider, contextKeys: ["itsm", "cr-status", "unresolved"], cached: false, conversationId });
      }
    }

    // ---- Automated upgrade flow: "automate upgrade", "automated upgrade", "upgrade automation" ----
    const AUTO_UPGRADE_PAT = /\b(?:automat(?:e|ed|ic)\s+(?:(?:cluster\s+)?upgrade|the\s+upgrade)|upgrade\s+automat(?:ion|e|ed)|full\s+upgrade\s+(?:flow|process|workflow)|start\s+upgrade\s+(?:flow|automation|process|workflow)|begin\s+(?:automated|full)\s+upgrade|orchestrat(?:e|ed)\s+(?:the\s+)?upgrade)\b/i;
    if (AUTO_UPGRADE_PAT.test(userMessage)) {
      try {
        const { createSession, getActiveSession, stepValidateVersion, stepPreAssessment, stepComponentAnalysis, stepBuildRemediationPlan, formatSessionSummary, buildUpgradeProgressToken } = await import("./upgrade-orchestrator.js");

        // Check for existing active session on this cluster
        const activeCluster = _remoteClusterContext?.clusterName || body.cluster || "local";
        let session = await getActiveSession(conversationId, activeCluster);

        if (!session) {
          // Parse target version from message
          const versionMatch = userMessage.match(/(\d+\.\d+\.\d+)/g);
          let targetVer = "";
          let fromVer = "";
          if (versionMatch && versionMatch.length >= 2) {
            fromVer = versionMatch[0];
            targetVer = versionMatch[1];
          } else if (versionMatch && versionMatch.length === 1) {
            targetVer = versionMatch[0];
          }

          // Auto-detect versions if not specified — route through bridge for remote clusters
          const clusterOcpGet = activeCluster && activeCluster !== "local"
            ? (path) => withRemoteClusterBridge(activeCluster, () => ocpGet(path))
            : ocpGet;

          if (!targetVer) {
            try {
              const cv = await clusterOcpGet("/apis/config.openshift.io/v1/clusterversions/version");
              fromVer = cv?.status?.desired?.version || "";
              const updates = cv?.status?.availableUpdates || [];
              if (updates.length > 0) {
                const sorted = [...updates].sort((a, b) => {
                  const pa = (a.version || "").split(".").map(Number);
                  const pb = (b.version || "").split(".").map(Number);
                  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); }
                  return 0;
                });
                targetVer = sorted[0].version;
              }
            } catch { /* ignore */ }
          }

          if (!targetVer) {
            const reply = `### Automated Upgrade\n\nI couldn't detect an available target version. Please specify the version you want to upgrade to, e.g.:\n\n> "Automate upgrade to 4.19.28"`;
            const provider = "built-in";
            if (conversationId) histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
            if (wantsStream) { sseStart(res); sseSend(res, { delta: reply }); sseSend(res, { done: true, provider, conversationId }); sseEnd(res); return; }
            return json(res, 200, { reply, provider, contextKeys: ["upgrade", "orchestrator"], cached: false, conversationId });
          }

          // If no fromVer, fetch it from the target cluster
          if (!fromVer) {
            try {
              const cv = await clusterOcpGet("/apis/config.openshift.io/v1/clusterversions/version");
              fromVer = cv?.status?.desired?.version || "";
            } catch { /* ignore */ }
          }

          session = await createSession(conversationId, {
            fromVersion: fromVer,
            targetVersion: targetVer,
            channel: "",
            cluster: activeCluster,
          });
        }

        if (session) {
          // Auto-run version validation as the first step
          const validation = await stepValidateVersion(session.id);
          let latestSession = validation.session;

          let statusText = "";
          if (validation.valid) {
            statusText = `### Automated Upgrade Initiated\n\n**${latestSession.fromVersion} → ${latestSession.targetVersion}** (${latestSession.upgradeType || "patch"})\n\n`;
            statusText += `✅ Version validation passed.\n\n`;
            if (validation.result.channelChangeNeeded) {
              statusText += `⚠️ Channel switch required: ${validation.result.channel} → ${validation.result.suggestedChannel}\n\n`;
            }
            if (validation.result.adminAcksNeeded?.length) {
              statusText += `⚠️ ${validation.result.adminAcksNeeded.length} admin acknowledgment(s) required for this minor upgrade.\n\n`;
            }
            if (validation.result.isEUSToEUS) {
              statusText += `📋 ${validation.result.eusNote}\n\n`;
            }

            // Auto-run diagnostic steps: pre-assessment → component analysis → remediation plan
            const autoSteps = [
              { name: "Pre-Assessment (22 checks)", fn: () => stepPreAssessment(latestSession.id) },
              { name: "Component Analysis", fn: () => stepComponentAnalysis(latestSession.id) },
              { name: "Remediation Plan", fn: () => stepBuildRemediationPlan(latestSession.id) },
            ];

            if (wantsStream) {
              sseStart(res);
              sseSend(res, { stage: "querying" });
              sseSend(res, { stage: "generating" });
              sseSend(res, { delta: statusText });
            }

            for (const step of autoSteps) {
              try {
                if (wantsStream) sseSend(res, { delta: `Running ${step.name}...\n` });
                const stepResult = await step.fn();
                latestSession = stepResult.session || latestSession;
                statusText += `✅ ${step.name} completed.\n\n`;
                if (wantsStream) sseSend(res, { delta: `✅ ${step.name} completed.\n\n` });
              } catch (err) {
                statusText += `⚠️ ${step.name} failed: ${err.message}\n\n`;
                if (wantsStream) sseSend(res, { delta: `⚠️ ${step.name} failed: ${err.message}\n\n` });
                break;
              }
            }

            statusText += `AI has completed the assessment. Review the results below and proceed with the remaining steps when ready.\n\n`;
            if (wantsStream) sseSend(res, { delta: `AI has completed the assessment. Review the results below and proceed with the remaining steps when ready.\n\n` });
          } else {
            statusText = `### Upgrade Validation Failed\n\n${validation.result.validation.reason}\n\n`;
            if (validation.result.validation.recommendation) {
              statusText += `**Recommendation:** ${validation.result.validation.recommendation}\n\n`;
            }
            if (wantsStream) {
              sseStart(res);
              sseSend(res, { stage: "querying" });
              sseSend(res, { stage: "generating" });
              sseSend(res, { delta: statusText });
            }
          }

          const progressToken = `@@UPGRADE_PROGRESS|${JSON.stringify(buildUpgradeProgressToken(latestSession)).replace(/@@/g, "@ @")}@@`;
          const reply = statusText + progressToken;
          const provider = "built-in";
          if (conversationId) histAddMessage(conversationId, { role: "assistant", content: reply, provider }).catch(() => {});
          if (wantsStream) {
            sseSend(res, { delta: progressToken }); sseSend(res, { done: true, provider, conversationId }); sseEnd(res); return;
          }
          return json(res, 200, { reply, provider, contextKeys: ["upgrade", "orchestrator"], cached: false, conversationId });
        }
      } catch (err) {
        console.warn("[chat-api] upgrade orchestrator failed:", err.message);
        // Fall through to normal upgrade handling
      }
    }

    // ---- Upgrade preflight: "precheck upgrade", "cluster upgrade precheck", etc. ----
    const UPGRADE_PREFLIGHT_PAT = /\b(?:pre-?(?:check|flight|upgrade)|upgrade.*(?:pre-?check|assessment|readiness|compatible|compatibility)|check.*(?:before|prior).*upgrade|upgrade\s+cluster.*(?:from|to)\s+\d+\.\d+|cluster\s+(?:upgrade\s+)?pre-?check)\b/i;
    if (UPGRADE_PREFLIGHT_PAT.test(userMessage)) {
      // Remote cluster guards: preflight is OpenShift-only and needs a live bridge.
      if (_remoteClusterContext) {
        if (!_remoteBridgeActive) {
          const m = `### Preflight Unavailable\n\n[WARNING] The agent on **${_remoteClusterContext.clusterName}** is not connected via the live bridge, so a real-time pre-upgrade assessment cannot run.\n\nEnsure the cluster shows **Active** in AI Hub, then retry.`;
          if (conversationId) histAddMessage(conversationId, { role: "assistant", content: m, provider: "built-in" }).catch(() => {});
          if (wantsStream) { sseStart(res); sseSend(res, { delta: m }); sseSend(res, { done: true, provider: "built-in", conversationId }); sseEnd(res); return; }
          return json(res, 200, { reply: m, provider: "built-in", contextKeys: ["preflight", "bridge_offline"], cached: false, conversationId });
        }
        if (!_remoteClusterContext.summary?.isOpenShift) {
          const m = `### Preflight Not Applicable\n\n> **${_remoteClusterContext.clusterName}** is not an OpenShift cluster. The 22-point pre-upgrade assessment applies to OpenShift Container Platform only.`;
          if (conversationId) histAddMessage(conversationId, { role: "assistant", content: m, provider: "built-in" }).catch(() => {});
          if (wantsStream) { sseStart(res); sseSend(res, { delta: m }); sseSend(res, { done: true, provider: "built-in", conversationId }); sseEnd(res); return; }
          return json(res, 200, { reply: m, provider: "built-in", contextKeys: ["preflight", "not_openshift"], cached: false, conversationId });
        }
      }
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
          // Validate upgrade version before running full preflight
          try {
            const cvForValidation = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
            const clusterCur = cvForValidation?.status?.desired?.version || currentVer || "";
            const clusterCh = cvForValidation?.spec?.channel || "";
            const clusterUpd = cvForValidation?.status?.availableUpdates || [];
            if (!currentVer) currentVer = clusterCur;

            const vResult = validateUpgradeVersion(clusterCur, targetVer, clusterUpd, clusterCh);
            if (!vResult.valid) {
              const lines = [];
              lines.push(`### Upgrade Validation Failed`);
              lines.push("");
              lines.push(`**Current version:** ${clusterCur}`);
              lines.push(`**Requested version:** ${targetVer}`);
              lines.push(`**Channel:** ${clusterCh}`);
              lines.push("");
              lines.push(`[${vResult.severity === "error" ? "CRITICAL" : "WARNING"}] ${vResult.reason}`);
              if (vResult.recommendation) { lines.push(""); lines.push(`**Recommendation:** ${vResult.recommendation}`); }
              if (vResult.suggestedPath?.length) {
                lines.push("");
                lines.push(`**Required upgrade path:**`);
                lines.push(`\`${clusterCur}\` → ${vResult.suggestedPath.map(s => `\`${s}.z (latest)\``).join(" → ")}`);
                lines.push("");
                lines.push(`> Ask me: *"precheck upgrade to ${vResult.suggestedPath[0]}"* for the first step.`);
              }
              if (vResult.availableVersions && Object.keys(vResult.availableVersions).length > 0) {
                lines.push("");
                lines.push(`**Available upgrades from ${clusterCur}:**`);
                for (const [minor, versions] of Object.entries(vResult.availableVersions).sort().reverse()) {
                  lines.push(`  **${minor}.x:** ${versions.slice(0, 6).join(", ")}${versions.length > 6 ? ` (+${versions.length - 6} more)` : ""}`);
                }
              }
              const vReply = lines.join("\n");
              const provider = "built-in";
              if (conversationId) histAddMessage(conversationId, { role: "assistant", content: vReply, provider }).catch(() => {});
              if (wantsStream) {
                sseStart(res); sseSend(res, { stage: "querying" }); sseSend(res, { stage: "generating" });
                sseSend(res, { delta: vReply }); sseSend(res, { done: true, provider, conversationId }); sseEnd(res);
                return;
              }
              return json(res, 200, { reply: vReply, provider, contextKeys: ["upgrade", "validation_failed"], cached: false, conversationId });
            }
          } catch (valErr) {
            console.warn("[chat-api] preflight validation fetch failed, proceeding:", valErr.message);
          }

          const preflightReport = await runPreflightWithTimeout(targetVer, currentVer || undefined);
          cachePreflightReport(conversationId, preflightReport);
          const reportToken = `@@PREFLIGHT_REPORT|${JSON.stringify(lightPreflightReport(preflightReport)).replace(/@@/g, "@ @")}@@`;
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
      } catch (preflightErr) {
        console.error("[chat-api] preflight check failed:", preflightErr?.message || preflightErr);
        // Fall through to other handlers
      }
    }

    // ---- Remote cluster: answer from cached agent data ----
    // When the user has selected a remote (spoke) cluster, ocpGet() still
    // hits the local hub — so we intercept recognized query types here and
    // answer from the agent cache snapshot.  Unrecognized queries (null)
    // fall through to the LLM path which receives the cached context via
    // buildContextFromAgentCache.
    if (_remoteClusterContext) {
      // (0) Mutating actions (scale/restart/delete/cordon) take priority and
      //     run live via the agent bridge — double-gated by RBAC + opt-in.
      // (1) Cache-based handler — fast, no network round-trip.
      // (2) LIVE agent bridge for real-time reads (feature parity with hub).
      let remoteCacheReply = null;
      if (isMutating || /\bscale\b|\brestart\b|\bredeploy\b|\bcordon\b|\bupgrade\b|\b(delete|remove|kill)\b/.test(userMessage.toLowerCase())) {
        try {
          remoteCacheReply = await handleRemoteMutation(userMessage, parsed, _remoteClusterContext, { userId: llmOpts.userId });
        } catch (mutErr) {
          console.error(`[chat] Remote mutation failed for ${_remoteClusterContext.clusterName}: ${mutErr.message}`);
        }
      }
      if (!remoteCacheReply) {
        remoteCacheReply = handleRemoteCacheQuery(userMessage, parsed, _remoteClusterContext, { llmAvailable: llmActive });
      }
      if (!remoteCacheReply) {
        try {
          remoteCacheReply = await handleRemoteLiveQuery(userMessage, parsed, _remoteClusterContext);
        } catch (liveErr) {
          console.error(`[chat] Remote live query failed for ${_remoteClusterContext.clusterName}: ${liveErr.message}`);
        }
      }
      if (remoteCacheReply) {
        const provider = llmActive ? activeProvider : "built-in";
        const payload = {
          reply: remoteCacheReply,
          provider,
          contextKeys: ["remoteCache", parsed.intent, parsed.resource].filter(Boolean),
        };
        if (!isMutating) {
          cacheSet(cacheKey, payload, CHAT_CACHE_TTL).catch(() => {});
        }
        if (conversationId) {
          histAddMessage(conversationId, {
            role: "assistant",
            content: remoteCacheReply,
            provider,
          }).catch(() => {});
        }
        updateMemory(conversationId, memoryPatchFromParse(parsed)).catch(() => {});
        if (wantsStream) {
          sseStart(res);
          sseSend(res, { stage: "querying" });
          sseSend(res, { stage: "generating" });
          sseSend(res, { delta: remoteCacheReply });
          sseSend(res, { done: true, provider, conversationId });
          sseEnd(res);
          return;
        }
        return json(res, 200, { ...payload, cached: false, conversationId });
      }
    }

    // Rule-based handlers — for LOCAL cluster, or remote clusters with an
    // active agent bridge (ocpGet() is routed through the bridge so data
    // is fetched from the correct cluster).
    if (!_remoteClusterContext || _remoteBridgeActive) {
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

      // ---- Specific pod early check: if user asks about a named pod, verify
      // it exists BEFORE entering the expensive LLM path. If the pod is not
      // found, return a clear built-in response immediately. ----
      const podNameFromParse = parsed?.name && parsed?.resource === "pod" ? parsed.name : null;
      const podNameFromRegex = !podNameFromParse ? (userMessage.match(/\b([a-z][-a-z0-9]*(?:-[a-z0-9]{4,10}){1,2})\b/i) || [])[1] : null;
      const earlyPodName = podNameFromParse || podNameFromRegex;
      if (earlyPodName && /\b(why|diagnos|troubleshoot|restart|crash|fail|error|wrong|issue|problem|check|analyse|analyze|investig)/i.test(userMessage.toLowerCase())) {
        try {
          const podLookup = await ocpGet(`/api/v1/pods?fieldSelector=metadata.name=${earlyPodName}`);
          const foundPod = (podLookup.items || [])[0];
          if (!foundPod) {
            const lines = [];
            lines.push(`### Pod Not Found: \`${earlyPodName}\``);
            lines.push(`[WARNING] Could not find pod **${earlyPodName}** in the cluster.`);
            lines.push(`The pod may have been deleted, evicted, or the name may be incorrect.`);
            lines.push(``);
            lines.push(`#### Suggestions`);
            lines.push(`  - Check if the pod still exists: \`oc get pod ${earlyPodName} --all-namespaces\``);
            lines.push(`  - List pods in the expected namespace: \`oc get pods -n <namespace>\``);
            lines.push(`  - Check recent events: \`oc get events --all-namespaces --sort-by=.lastTimestamp | grep ${earlyPodName}\``);
            const earlyReply = lines.join("\n");
            const provider = activeProvider || "built-in";
            if (conversationId) histAddMessage(conversationId, { role: "assistant", content: earlyReply, provider }).catch(() => {});
            if (wantsStream) {
              sseStart(res);
              sseSend(res, { stage: "querying" });
              sseSend(res, { stage: "generating" });
              sseSend(res, { delta: earlyReply });
              sseSend(res, { done: true, provider, conversationId });
              sseEnd(res);
              return;
            }
            return json(res, 200, { reply: earlyReply, provider, contextKeys: ["specific_pod", "not_found"], cached: false, conversationId });
          }
        } catch {
          // Pod lookup failed — fall through to normal LLM path
        }
      }
    } // end !_remoteClusterContext

    // ---- Streaming SSE path ----
    if (wantsStream && llmEnabled(llmOpts)) {
      sseStart(res);
      // Periodic heartbeat keeps proxies/HAProxy from buffering the connection
      // and lets the client know the server is still working during the long
      // gatherClusterContext + LLM call.
      const heartbeat = setInterval(() => sseHeartbeat(res), 2000);
      try {
        sseSend(res, { stage: "querying", toolProgress: "Fetching cluster data..." });
        const { result: sseTraced, trace: sseTrace } = await runWithTrace(async () => {
          let context = await gatherClusterContext(userMessage, parsed, _remoteClusterContext);
          // Filter unrelated cluster-wide data for deployment-specific queries
          if (context.targetDeployment) {
            const depNs = context.targetDeployment.namespace;
            const depName = context.targetDeployment.name;
            if (Array.isArray(context.problemPods)) {
              context.problemPods = context.problemPods.filter(
                (p) => p.namespace === depNs && (p.ownerName?.includes(depName) || p.name?.includes(depName))
              );
            }
            if (Array.isArray(context.correlations)) {
              context.correlations = context.correlations.filter(
                (c) => c.namespace === depNs && (c.ownerName?.includes(depName) || c.pod?.includes(depName))
              );
            }
          }
          sseSend(res, { stage: "analyzing", toolProgress: "Analyzing " + (context.problemPods?.length || 0) + " problem pods, " + (context.nodes?.length || 0) + " nodes..." });
          sseSend(res, { stage: "generating", toolProgress: "Generating response with " + activeProvider + "..." });
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
            if (Array.isArray(context.correlations) && context.targetPod) {
              context.correlations = context.correlations.filter(
                (c) => c.namespace === context.targetPod.namespace
              );
            }
            Object.assign(focused, context);
            Object.assign(context, focused);
          }
          // Run Pod Doctor auto-diagnosis for focused pods
          if (context.targetPod || context._focusPod) {
            const pod = context._focusPod || context.targetPod;
            sseSend(res, { stage: "analyzing", toolProgress: "Diagnosing root cause for " + pod.name + "..." });
            const autoFix = diagnosePod(pod, {
              events: context._focusPodEvents || context.targetPodEvents || [],
              logs: context._focusPodLogs || context.targetPodLogs || "",
              logsPrevious: context._focusPodLogsPrevious || context.targetPodLogsPrevious || "",
              metrics: context._focusPodMetrics || context.targetPodMetrics || null,
            });
            context._autoDiagnosis = autoFix;
          }
          // Compress context: strip metadata, deduplicate events, cap arrays
          try { Object.assign(context, compressContext(context)); } catch { /* optimizer optional */ }
          // Build diagnostic brief for focused pods
          if (context._focusPod || context.targetPod) {
            try {
              const pod = context._focusPod || context.targetPod;
              context._diagnosticBrief = buildDiagnosticBrief(
                pod,
                context._focusPodEvents || context.targetPodEvents || [],
                context._focusPodLogs || context.targetPodLogs || "",
                context._autoDiagnosis
              );
            } catch { /* diagnostic brief optional */ }
          }
          // Inject error knowledge matches from logs/events
          if (context._focusPodLogs || context.targetPodLogs) {
            try {
              const logs = (context._focusPodLogs || context.targetPodLogs || "").split("\n");
              const events = (context._focusPodEvents || context.targetPodEvents || [])
                .map(e => `${e.reason}: ${e.message || ""}`);
              const matches = findMatchingErrors(logs, events);
              if (matches.length > 0) {
                context._errorKnowledge = matches.slice(0, 5);
              }
            } catch { /* error matching optional */ }
          }
          const priorMessages = historyToMessages(llmOpts.history);
          const isFollowUp = priorMessages.length > 0;
          // Use tiered context for better signal-to-noise ratio
          let contextStr;
          try {
            const primaryIntent = (context.intents || [])[0] || "cluster_health";
            contextStr = buildTieredContext(context, primaryIntent);
          } catch {
            contextStr = summarizeContext(context);
          }
          // Append diagnostic brief and error knowledge if available
          if (context._diagnosticBrief) {
            contextStr += `\n\n## Diagnostic Brief\n${JSON.stringify(context._diagnosticBrief, null, 2)}`;
          }
          if (context._errorKnowledge && context._errorKnowledge.length > 0) {
            contextStr += `\n\n## Known Error Matches\n${context._errorKnowledge.map(e =>
              `- **${e.entry.pattern}** (${e.entry.severity}): ${e.entry.rootCause}\n  Fix: ${e.entry.remediation[0] || "investigate"}`
            ).join("\n")}`;
          }
          const userContent = isFollowUp && contextStr.length > 800
            ? `${userMessage}\n\n--- Updated Cluster Data (changes only) ---\n${summarizeContextDelta(context)}`
            : `${userMessage}\n\n--- Live Cluster Data ---\n${contextStr}`;
          const streamBasePrompt = buildSystemPrompt(userMessage, context);
          const augmentedSystem = await augmentSystemPrompt(streamBasePrompt, {
            parsed, userId: body.userId || null, conversationId,
          });
          let fullText = "";
          await callLLMStream({
            messages: [...priorMessages, { role: "user", content: userContent }],
            system: augmentedSystem,
            maxTokens: 2000,
            temperature: 0.15,
            ...llmOpts,
            onDelta: (chunk) => {
              fullText += chunk;
              sseSend(res, { delta: chunk });
            },
          });
          return { context, fullText };
        });
        const { context, fullText } = sseTraced;
        // Post-stream grounding validation — append disclaimer if needed
        const validatedFull = validateResponse(fullText, context);
        if (validatedFull && validatedFull.length > fullText.length) {
          const groundingDisclaimer = validatedFull.slice(fullText.length);
          sseSend(res, { delta: groundingDisclaimer });
        }
        // Only append correlations/playbooks when they're relevant to the question.
        // Skip for: (a) deployment/pod-specific queries where correlations are about
        // unrelated cluster-wide problem pods, and (b) infrastructure queries
        // (certificates, upgrades, operators, capacity) where pod CrashLoopBackOff
        // correlations are completely irrelevant noise.
        const INFRA_INTENTS = new Set(["certificate_expiry", "cluster_upgrade", "operators", "machines", "namespaces", "services"]);
        const isInfraQuery = context?.intents?.some(i => INFRA_INTENTS.has(i)) &&
          !context?.intents?.some(i => i === "pod_issues" || i === "specific_pod");
        const hasSpecificTarget = context?.targetDeployment || context?.targetPod || context?._focusPod;
        const relevantCorrelations = (hasSpecificTarget || isInfraQuery)
          ? (hasSpecificTarget ? filterRelevantCorrelations(context?.correlations || [], context) : [])
          : (context?.correlations || []);
        const correlationsBlock = renderCorrelationsMarkdown(relevantCorrelations);
        if (correlationsBlock) sseSend(res, { delta: "\n" + correlationsBlock });
        const topCause = relevantCorrelations?.[0];
        if (topCause?.likelyCause) {
          const pb = suggestPlaybook(topCause.likelyCause, { pod: topCause.pod, namespace: topCause.namespace });
          if (pb) sseSend(res, { delta: "\n" + renderPlaybookMarkdown(pb) });
        }
        // Append interactive fix proposals from Pod Doctor diagnosis
        const fixBlock = appendFixProposals("", context);
        if (fixBlock) sseSend(res, { delta: fixBlock });
        const traceMd = renderTraceMarkdown(sseTrace);
        if (traceMd) sseSend(res, { delta: "\n" + traceMd });
        sseSend(res, { done: true, provider: activeProvider, conversationId });
        sseEnd(res);
        if (conversationId) {
          const savedText = sseTraced.fullText + (fixBlock || "");
          histAddMessage(conversationId, { role: "assistant", content: savedText, provider: activeProvider }).catch(() => {});
        }
        updateMemory(conversationId, memoryPatchFromParse(parsed)).catch(() => {});
        observeHistogram("mcp_chat_latency_seconds", { provider: activeProvider }, (Date.now() - startedAt) / 1000);
      } catch (sseErr) {
        const isNet = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network error|fetch failed/i.test(sseErr.message);
        if (isNet) {
          sseSend(res, { delta: `### LLM Service Unavailable\n\nThe AI analysis service is currently unreachable. Try direct queries like \`list pods\`, \`node status\`, \`cluster status\` which work without LLM.\n\nCheck your LLM provider configuration or set \`LLM_PROVIDER=none\` to use built-in analysis.` });
          sseSend(res, { done: true, provider: "built-in", error: "llm_unreachable" });
        } else {
          sseSend(res, { error: sseErr.message });
        }
        sseEnd(res);
      } finally {
        clearInterval(heartbeat);
      }
      return;
    }

    // Gather cluster context + call LLM inside a trace scope so that every
    // ocpFetch made during this request is captured for explainability.
    const { result: traced, trace } = await runWithTrace(async () => {
      // Skip expensive cluster API calls for pure knowledge/explanation queries
      // that don't need live cluster data. This saves 3-8s per query.
      const KNOWLEDGE_INTENTS = /\b(explain|what\s+is|what\s+are|how\s+does|how\s+do|how\s+to|define|difference\s+between|compare|tutorial|example|best\s+practice|when\s+to\s+use|why\s+use)\b/i;
      const needsClusterData = !KNOWLEDGE_INTENTS.test(userMessage) ||
        /\b(show|list|get|describe|check|status|health|my\s+cluster|this\s+cluster|our\s+cluster)\b/i.test(userMessage);

      const activeCluster = _remoteClusterContext?.clusterName || body.cluster || "local";
      const ctxKey = `ctx:${activeCluster}:${cacheKeyForChat(userMessage, "ctx")}`;
      let context;
      if (!needsClusterData) {
        context = { intents: ["knowledge"], _skippedClusterContext: true };
      } else {
        context = await cacheGet(ctxKey);
        if (!context) {
          context = await gatherClusterContext(userMessage, parsed, _remoteClusterContext);
          cacheSet(ctxKey, context, CONTEXT_CACHE_TTL).catch(() => {});
        }
      }

      // Route through orchestrator when external MCP servers are connected,
      // or through agent loop for diagnose-type queries.
      const hubActive = getConnectionCount() > 0;
      const wantsDiagnose =
        llmEnabled(llmOpts) &&
        /\b(diagnose|root\s*cause|why\b|what'?s\s+wrong|troubleshoot)\b/i.test(userMessage);
      let replyText;
      let toolsUsed = [];

      const hintPods = context.targetPodName
        ? (context.problemPods || []).filter((p) => p.name === context.targetPodName)
        : (context.problemPods || []).slice(0, 5);

      if (hubActive && llmEnabled(llmOpts)) {
        try {
          let kbContext = "";
          try {
            const kbMatches = await kbFindSimilar({
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
      // Label knowledge-only responses that skipped cluster data
      if (context._skippedClusterContext && replyText) {
        replyText += "\n\n> *This is general knowledge and has not been verified against your cluster.*";
      }
      return { context, replyText, toolsUsed };
    });
    let { context, replyText: reply, toolsUsed = [] } = traced;
    // Post-response grounding validation for non-streaming path
    reply = validateResponse(reply, context);
    intentsForLog = Array.isArray(context?.intents) ? context.intents : Object.keys(context || {});

    // Only append correlations/playbooks when relevant to the question asked.
    // Skip for infrastructure queries where pod failure correlations are noise.
    const INFRA_INTENTS_NS = new Set(["certificate_expiry", "cluster_upgrade", "operators", "machines", "namespaces", "services"]);
    const isInfraQueryNS = context?.intents?.some(i => INFRA_INTENTS_NS.has(i)) &&
      !context?.intents?.some(i => i === "pod_issues" || i === "specific_pod");
    const hasSpecificTarget = context?.targetDeployment || context?.targetPod || context?._focusPod;
    const relevantCorrelations = (hasSpecificTarget || isInfraQueryNS)
      ? (hasSpecificTarget ? filterRelevantCorrelations(context?.correlations || [], context) : [])
      : (context?.correlations || []);
    const correlationsBlock = renderCorrelationsMarkdown(relevantCorrelations);
    if (correlationsBlock) reply += "\n" + correlationsBlock;

    const topCause = relevantCorrelations?.[0];
    if (topCause?.likelyCause) {
      const pb = suggestPlaybook(topCause.likelyCause, {
        pod: topCause.pod,
        namespace: topCause.namespace,
      });
      if (pb) reply += "\n" + renderPlaybookMarkdown(pb);
    }

    const traceMd = renderTraceMarkdown(trace);
    if (traceMd) reply += "\n" + traceMd;

    const agentTrace = await buildAgentTrace(
      toolsUsed || [],
      Object.keys(context || {}),
      Date.now() - startedAt,
    ).catch(() => []);

    _traceToolsUsed = toolsUsed || [];
    _traceContextKeys = Object.keys(context || {});

    const payload = {
      reply,
      provider: activeProvider,
      contextKeys: Object.keys(context || {}),
      correlations: context?.correlations || [],
      trace: trace.slice(0, 20),
      toolsUsed: toolsUsed || [],
      agentTrace,
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
    console.error("Chat API error:", err?.stack || err);
    const isNetworkError = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network error|fetch failed/i.test(err.message);
    if (isNetworkError) {
      const fallbackReply = `### LLM Service Unavailable\n\nThe AI analysis service is currently unreachable. Your query **"${userMessage}"** requires LLM processing but the configured provider could not be contacted.\n\n**What you can try:**\n- Use direct queries like \`list pods\`, \`node status\`, \`cluster status\` (these work without LLM)\n- Check your LLM provider configuration (\`LLM_PROVIDER\`, \`LLM_API_URL\`, \`LLM_API_KEY\`)\n- Verify network connectivity from the pod to the LLM endpoint\n- Set \`LLM_PROVIDER=none\` to use built-in analysis`;
      json(res, 200, { reply: fallbackReply, provider: "built-in", error: "llm_unreachable", conversationId });
    } else {
      json(res, 500, { error: `${err.message} [at ${(err.stack || "").split("\n")[1]?.trim() || "unknown"}]` });
    }
    _traceStatus = "error";
  } finally {
    clearRemoteCluster();
    histLogQuery({
      conversationId,
      query: userMessage,
      intents: intentsForLog,
      cacheHit,
      durationMs: Date.now() - startedAt,
    }).catch(() => {});

    if (userMessage) {
      const ctxKeys = _traceContextKeys.length > 0
        ? _traceContextKeys
        : (Array.isArray(intentsForLog) ? intentsForLog : []).filter(Boolean);
      buildAgentTrace(_traceToolsUsed, ctxKeys, Date.now() - startedAt)
        .catch(() => [])
        .then((agentTrace) => {
          const traceId = generateTraceId();
          return recordTrace({
            traceId,
            conversationId,
            queryText: userMessage,
            provider: activeProvider,
            totalDurationMs: Date.now() - startedAt,
            status: _traceStatus,
            spans: (agentTrace || []).map((a) => ({
              agentId: a.agentId,
              agentName: a.agentName,
              icon: a.icon,
              color: a.color,
              category: a.category,
              toolsCalled: a.toolsCalled || [],
              status: a.status || "active",
            })),
          });
        })
        .catch((err) => console.warn("[chat-api] trace recording failed:", err.message));
    }
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

    // Remote cluster — use cached agent data
    const _remoteCtx = resolveRemoteClusterContext(body);

    // Gather cluster context once, shared across all providers
    const context = await gatherClusterContext(message, null, _remoteCtx);
    const contextStr = summarizeContext(context);
    const userContent = `${message}\n\n--- Live Cluster Data ---\n${contextStr}`;

    // Resolve real API keys for any masked/empty keys the UI echoed back.
    await Promise.all(providers.map((p) => resolveLLMOpts(p)));

    // Send to all providers in parallel
    const promises = providers.map(async (prov) => {
      const provStart = Date.now();
      try {
        const r = await callLLM({
          messages: [{ role: "user", content: userContent }],
          system: buildSystemPrompt(message, context),
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

    const toolsUsed = [];
    const contextKeys = context ? Object.keys(context) : [];
    const traceId = generateTraceId();
    const agentTrace = await buildAgentTrace(toolsUsed, contextKeys, Date.now() - startedAt).catch(() => []);
    recordTrace({
      traceId,
      conversationId,
      queryText: message,
      provider: results.map(r => r.provider).join(","),
      totalDurationMs: Date.now() - startedAt,
      status: "success",
      spans: agentTrace.map((a) => ({
        agentId: a.agentId,
        agentName: a.agentName,
        icon: a.icon,
        color: a.color,
        category: a.category,
        toolsCalled: a.toolsCalled || [],
        status: a.status || "active",
      })),
    }).catch((err) => console.warn("[chat-api] trace recording failed:", err.message));

    return json(res, 200, {
      results,
      conversationId: conversationId || null,
      traceId,
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

    // Remote cluster — use cached agent data
    const _remoteCtx = resolveRemoteClusterContext(body);

    const llmOpts = {};
    if (provider) llmOpts.provider = provider;
    if (apiKey) llmOpts.apiKey = apiKey;
    if (apiUrl) llmOpts.apiUrl = apiUrl;
    if (model) llmOpts.model = model;
    if (body.azureDeployment) llmOpts.azureDeployment = body.azureDeployment;
    if (body.azureApiVersion) llmOpts.azureApiVersion = body.azureApiVersion;
    await resolveLLMOpts(llmOpts);

    // Build context hint from cluster
    let contextHint = null;
    try {
      const ctx = await gatherClusterContext(message, null, _remoteCtx);
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

    const traceId = generateTraceId();
    const agentTrace = await buildAgentTrace(toolsUsed, contextKeys, Date.now() - startedAt).catch(() => []);
    recordTrace({
      traceId,
      conversationId,
      queryText: message,
      provider: provider || LLM_PROVIDER,
      totalDurationMs: Date.now() - startedAt,
      status: "success",
      spans: agentTrace.map((a) => ({
        agentId: a.agentId,
        agentName: a.agentName,
        icon: a.icon,
        color: a.color,
        category: a.category,
        toolsCalled: a.toolsCalled || [],
        status: a.status || "active",
      })),
    }).catch((err) => console.warn("[chat-api] trace recording failed:", err.message));

    return json(res, 200, {
      reply: agentResult.text || "",
      provider: provider || LLM_PROVIDER,
      steps: stepsCollected,
      toolsUsed,
      durationMs: Date.now() - startedAt,
      contextKeys,
      conversationId: conversationId || null,
      traceId,
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
    if (body.azureDeployment) llmOpts.azureDeployment = body.azureDeployment;
    if (body.azureApiVersion) llmOpts.azureApiVersion = body.azureApiVersion;
    await resolveLLMOpts(llmOpts);

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

async function gatherDeployContext(namespace, depName, resourceType = "deployments") {
  try {
    const apiBase = `/apis/apps/v1/namespaces/${namespace}`;
    const apiPath = resourceType === "statefulsets" ? `${apiBase}/statefulsets/${depName}`
      : resourceType === "daemonsets" ? `${apiBase}/daemonsets/${depName}`
      : `${apiBase}/deployments/${depName}`;
    const dep = await ocpGet(apiPath);
    const selector = dep?.spec?.selector?.matchLabels || {};
    const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",");
    if (!labelSelector) return null;
    const specContainers = (dep?.spec?.template?.spec?.containers || []).map(c => ({
      name: c.name, limits: c.resources?.limits || {}, requests: c.resources?.requests || {},
    }));
    const pods = await fetchPodStatus(namespace, labelSelector);
    return { resourceSpec: specContainers, replicas: dep?.spec?.replicas,
      readyReplicas: dep?.status?.readyReplicas ?? 0, namespace, labelSelector, pods };
  } catch { return null; }
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
      let ownerDep = null;
      try {
        const podObj = await ocpGet(`/api/v1/namespaces/${namespace}/pods/${pod}`);
        const rsOwner = (podObj?.metadata?.ownerReferences || []).find(o => o.kind === "ReplicaSet");
        if (rsOwner) {
          const rs = await ocpGet(`/apis/apps/v1/namespaces/${namespace}/replicasets/${rsOwner.name}`);
          const depOwner = (rs?.metadata?.ownerReferences || []).find(o => o.kind === "Deployment");
          if (depOwner) ownerDep = { name: depOwner.name, type: "deployments" };
        }
        if (!ownerDep) {
          const ssOwner = (podObj?.metadata?.ownerReferences || []).find(o => o.kind === "StatefulSet");
          if (ssOwner) ownerDep = { name: ssOwner.name, type: "statefulsets" };
          const dsOwner = (podObj?.metadata?.ownerReferences || []).find(o => o.kind === "DaemonSet");
          if (!ownerDep && dsOwner) ownerDep = { name: dsOwner.name, type: "daemonsets" };
        }
      } catch { /* best effort */ }
      await ocpDelete(`/api/v1/namespaces/${namespace}/pods/${pod}`);
      success = true;
      resultPayload = { message: `Pod '${pod}' deleted in '${namespace}'. The owning controller will recreate it.` };
      let context = null;
      if (ownerDep) {
        context = await gatherDeployContext(namespace, ownerDep.name, ownerDep.type);
      }
      return json(res, 200, { success: true, message: resultPayload.message, context });
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
      const context = await gatherDeployContext(namespace, dep);
      resultPayload = { message: `Deployment '${dep}' restarted in '${namespace}'. New pods will be rolled out.` };
      return json(res, 200, { success: true, message: resultPayload.message, context });
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
      const context = await gatherDeployContext(namespace, dep);
      resultPayload = { message: `Deployment '${dep}' scaled to ${rep} replicas in '${namespace}'.` };
      return json(res, 200, { success: true, message: resultPayload.message, context });
    }

    if (action === "set_resources") {
      const dep = deployment || pod;
      const patchBody = body.patchBody || body.options?.patchBody;
      const resourceType = body.resourceType || "deployments";
      if (!dep) return json(res, 400, { success: false, error: "Missing deployment/resource name" });
      if (!patchBody) return json(res, 400, { success: false, error: "Missing patch body" });
      let patch;
      try { patch = typeof patchBody === "string" ? JSON.parse(patchBody) : patchBody; }
      catch { return json(res, 400, { success: false, error: "Invalid JSON in patch body" }); }
      const apiBase = `/apis/apps/v1/namespaces/${namespace}`;
      const apiPath = resourceType === "statefulsets" ? `${apiBase}/statefulsets/${dep}`
        : resourceType === "daemonsets" ? `${apiBase}/daemonsets/${dep}`
        : `${apiBase}/deployments/${dep}`;
      let preContext = null;
      try {
        const current = await ocpGet(apiPath);
        const c = current?.spec?.template?.spec?.containers?.[0];
        if (c) preContext = { container: c.name, currentLimits: c.resources?.limits || {}, currentRequests: c.resources?.requests || {} };
      } catch { /* best effort */ }
      await ocpPatch(apiPath, patch);
      success = true;
      const context = await gatherDeployContext(namespace, dep, resourceType);
      resultPayload = { message: `Resource limits updated for '${dep}' in '${namespace}'. Pods will be rolled out with new limits.` };
      return json(res, 200, { success: true, message: resultPayload.message, preContext, context });
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
      const context = await gatherDeployContext(namespace, dep);
      resultPayload = { message: `Deployment '${dep}' patched in '${namespace}'.` };
      return json(res, 200, { success: true, message: resultPayload.message, context });
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

// ---------------------------------------------------------------------------
// POST /api/chat/feedback — structured feedback with positive/negative rating
// ---------------------------------------------------------------------------
export async function handleFeedbackAPI(req, res) {
  try {
    const body = await readBody(req);
    const { conversationId, messageIndex, rating, comment } = body;

    if (!rating || !['positive', 'negative'].includes(rating)) {
      return json(res, 400, { error: "Rating must be 'positive' or 'negative'" });
    }

    // Store feedback in DB (best-effort)
    try {
      const { query: dbq } = await import("../utils/db.js");
      await dbq(`
        CREATE TABLE IF NOT EXISTS chat_feedback (
          id SERIAL PRIMARY KEY,
          conversation_id TEXT,
          message_index INTEGER,
          rating TEXT NOT NULL,
          comment TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await dbq(
        `INSERT INTO chat_feedback (conversation_id, message_index, rating, comment) VALUES ($1, $2, $3, $4)`,
        [conversationId || null, messageIndex || 0, rating, comment || null]
      );
    } catch {
      // DB optional — feedback still counted via metrics
    }

    // Track metrics
    incCounter("mcp_chat_feedback_total", { rating });

    json(res, 200, { success: true });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/chat/feedback/stats — aggregate feedback statistics
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /api/risk-analysis — LLM-powered deep risk analysis (hybrid layer)
// ---------------------------------------------------------------------------
export async function handleRiskAnalysisAPI(req, res) {
  try {
    const body = await readBody(req);
    const llmOpts = body.llmOpts || {};
    const provider = llmOpts.provider || LLM_PROVIDER;

    if (!provider || provider === "none") {
      return json(res, 200, { findings: [], error: "No LLM provider configured. Configure a provider in Settings to enable AI deep analysis." });
    }

    const clusterData = {};
    const tasks = [];

    tasks.push(
      ocpGet("/api/v1/pods?limit=500").then(r => {
        clusterData.allPods = (r?.items || []).map(p => ({
          name: p.metadata?.name,
          namespace: p.metadata?.namespace,
          phase: p.status?.phase,
          restarts: (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0),
          containers: (p.status?.containerStatuses || []).map(c => ({
            name: c.name,
            ready: c.ready,
            state: Object.keys(c.state || {})[0] || "unknown",
            reason: c.state?.waiting?.reason || c.state?.terminated?.reason || null,
            restarts: c.restartCount || 0,
          })),
          age: p.metadata?.creationTimestamp,
          node: p.spec?.nodeName,
          ownerKind: (p.metadata?.ownerReferences || [])[0]?.kind,
          ownerName: (p.metadata?.ownerReferences || [])[0]?.name,
        }));
      }).catch(() => { clusterData.allPods = []; })
    );

    tasks.push(
      ocpGet("/api/v1/nodes").then(r => {
        clusterData.nodes = (r?.items || []).map(n => {
          const conds = {};
          (n.status?.conditions || []).forEach(c => { conds[c.type] = c.status; });
          return {
            name: n.metadata?.name,
            ready: conds.Ready === "True",
            memoryPressure: conds.MemoryPressure === "True",
            diskPressure: conds.DiskPressure === "True",
            pidPressure: conds.PIDPressure === "True",
            cpu: n.status?.allocatable?.cpu,
            memory: n.status?.allocatable?.memory,
            pods: n.status?.allocatable?.pods,
            roles: Object.keys(n.metadata?.labels || {}).filter(l => l.startsWith("node-role.kubernetes.io/")).map(l => l.split("/")[1]),
            kubeletVersion: n.status?.nodeInfo?.kubeletVersion,
          };
        });
      }).catch(() => { clusterData.nodes = []; })
    );

    tasks.push(
      ocpGet("/api/v1/events?limit=200&fieldSelector=type!=Normal").then(r => {
        clusterData.warningEvents = (r?.items || []).slice(-100).map(e => ({
          reason: e.reason,
          message: (e.message || "").substring(0, 200),
          namespace: e.metadata?.namespace,
          involvedObject: e.involvedObject?.kind + "/" + e.involvedObject?.name,
          count: e.count || 1,
          lastSeen: e.lastTimestamp || e.eventTime,
        }));
      }).catch(() => { clusterData.warningEvents = []; })
    );

    tasks.push(
      ocpGet("/apis/apps/v1/deployments?limit=200").then(r => {
        clusterData.deployments = (r?.items || []).map(d => ({
          name: d.metadata?.name,
          namespace: d.metadata?.namespace,
          replicas: d.spec?.replicas,
          readyReplicas: d.status?.readyReplicas || 0,
          updatedReplicas: d.status?.updatedReplicas || 0,
          unavailableReplicas: d.status?.unavailableReplicas || 0,
          conditions: (d.status?.conditions || []).map(c => ({ type: c.type, status: c.status, reason: c.reason })),
        }));
      }).catch(() => { clusterData.deployments = []; })
    );

    await Promise.all(tasks);

    const problemSummary = {
      totalPods: clusterData.allPods.length,
      crashingPods: clusterData.allPods.filter(p => p.containers.some(c => c.reason === "CrashLoopBackOff")).length,
      oomPods: clusterData.allPods.filter(p => p.containers.some(c => c.reason === "OOMKilled")).length,
      pendingPods: clusterData.allPods.filter(p => p.phase === "Pending").length,
      failedPods: clusterData.allPods.filter(p => p.phase === "Failed").length,
      highRestartPods: clusterData.allPods.filter(p => p.restarts > 10).length,
      unhealthyNodes: clusterData.nodes.filter(n => !n.ready).length,
      totalNodes: clusterData.nodes.length,
      degradedDeployments: clusterData.deployments.filter(d => d.unavailableReplicas > 0 || d.readyReplicas < d.replicas).length,
    };

    const prompt = `You are a Kubernetes/OpenShift SRE risk analyst. Analyze the cluster state below and identify risks that go BEYOND simple status checks. Focus on:

1. **Correlated failures** — multiple pods/deployments failing in the same namespace or node (blast radius)
2. **Cascade risks** — a failing component that could take down dependent services
3. **Capacity trends** — nodes approaching resource limits, scheduling pressure
4. **Single points of failure** — deployments with replicas=1 that are unhealthy
5. **Stale deployments** — deployments with unavailable replicas for extended periods
6. **Security signals** — unusual restart patterns, privilege escalation indicators
7. **Namespace health** — namespaces with disproportionate issues

CLUSTER STATE:
${JSON.stringify(problemSummary, null, 1)}

PROBLEM PODS (first 30):
${JSON.stringify(clusterData.allPods.filter(p => p.phase !== "Running" || p.restarts > 5 || p.containers.some(c => !c.ready)).slice(0, 30), null, 1)}

NODES:
${JSON.stringify(clusterData.nodes, null, 1)}

WARNING EVENTS (last 50):
${JSON.stringify((clusterData.warningEvents || []).slice(0, 50), null, 1)}

DEGRADED DEPLOYMENTS:
${JSON.stringify(clusterData.deployments.filter(d => d.unavailableReplicas > 0 || d.readyReplicas < d.replicas).slice(0, 20), null, 1)}

Respond ONLY with a JSON array of risk findings. Each finding must have:
- "severity": "critical" | "warning" | "info"
- "title": short title (max 80 chars)
- "evidence": specific data points from the cluster state that support this finding
- "impact": what could go wrong if this is not addressed
- "action": specific recommended action
- "confidence": number 70-99 (your confidence in this finding)
- "confidenceReason": why you are confident (cite specific data)
- "category": "correlation" | "cascade" | "capacity" | "spof" | "stale" | "security" | "namespace_health" | "pattern"

Return ONLY the JSON array, no markdown, no explanation. If no additional risks found, return [].`;

    const r = await callLLM({
      messages: [{ role: "user", content: prompt }],
      system: "You are a precise Kubernetes risk analyst. Output only valid JSON arrays. Never include markdown code fences or explanation text.",
      maxTokens: 2000,
      temperature: 0.2,
      provider: llmOpts.provider,
      apiUrl: llmOpts.apiUrl,
      apiKey: llmOpts.apiKey,
      model: llmOpts.model,
      azureDeployment: llmOpts.azureDeployment,
      azureApiVersion: llmOpts.azureApiVersion,
    });

    let findings = [];
    try {
      let text = (r.text || "").trim();
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) text = jsonMatch[0];
      findings = JSON.parse(text);
      if (!Array.isArray(findings)) findings = [];
      findings = findings.filter(f => f.severity && f.title && f.evidence).map(f => ({
        severity: ["critical", "warning", "info"].includes(f.severity) ? f.severity : "info",
        title: String(f.title).substring(0, 100),
        evidence: String(f.evidence).substring(0, 500),
        impact: String(f.impact || "").substring(0, 500),
        action: String(f.action || "").substring(0, 300),
        confidence: Math.min(99, Math.max(70, parseInt(f.confidence) || 85)),
        confidenceReason: String(f.confidenceReason || "LLM pattern analysis").substring(0, 200),
        category: f.category || "pattern",
        llm: true,
      }));
    } catch {
      return json(res, 200, { findings: [], error: "Failed to parse LLM response" });
    }

    json(res, 200, { findings, provider: r.provider || provider });
  } catch (err) {
    console.error("Risk analysis error:", err);
    json(res, 500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/chat/feedback/stats — aggregate feedback statistics
// ---------------------------------------------------------------------------
export async function handleFeedbackStatsAPI(req, res) {
  try {
    let stats = { total: 0, positive: 0, negative: 0, recentNegative: [] };
    try {
      const { query: dbq } = await import("../utils/db.js");
      const rows = await dbq(`SELECT rating, COUNT(*) as count FROM chat_feedback GROUP BY rating`);
      if (rows?.rows) {
        for (const r of rows.rows) {
          stats[r.rating] = parseInt(r.count);
          stats.total += parseInt(r.count);
        }
      }
      const recent = await dbq(`SELECT * FROM chat_feedback WHERE rating = 'negative' ORDER BY created_at DESC LIMIT 10`);
      stats.recentNegative = recent?.rows || [];
    } catch {
      // DB not available — return zeroed stats
    }
    json(res, 200, stats);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/ai/image-vuln-analysis — AI analysis of image vulnerabilities
// ---------------------------------------------------------------------------
export async function handleImageVulnAnalysisAPI(req, res) {
  try {
    const body = await readBody(req);
    const llmOpts = body.llmOpts || {};
    const provider = llmOpts.provider || LLM_PROVIDER;

    if (!provider || provider === "none") {
      return json(res, 200, { findings: [], error: "No LLM provider configured. Configure a provider in Settings to enable AI vulnerability analysis." });
    }

    let vulnData = null;
    try {
      const { scanAllNamespaceImages } = await import("../tools/image-vulnerability-scanner.js");
      vulnData = await scanAllNamespaceImages();
    } catch { /* scanner not available */ }

    if (!vulnData || !vulnData.topImages || vulnData.topImages.length === 0) {
      return json(res, 200, { findings: [], error: "No image vulnerability data available. Run a scan first." });
    }

    const vulnSummary = {
      totalImages: vulnData.totalImages, totalVulns: vulnData.totalVulns,
      critical: vulnData.critical, high: vulnData.high, medium: vulnData.medium, low: vulnData.low,
      fixable: vulnData.fixable, maxCVSS: vulnData.maxCVSS, riskScore: vulnData.riskScore,
      grade: vulnData.grade, compliance: vulnData.compliance, ageSummary: vulnData.ageSummary,
    };

    const topCVEs = [];
    for (const img of (vulnData.topImages || []).slice(0, 8)) {
      for (const v of (img.vulnerabilities || []).slice(0, 5)) {
        topCVEs.push({ image: img.image, namespace: img.namespace, cve: v.id, severity: v.severity, cvss: v.cvss, package: v.package, version: v.version, fix: v.fix || v.fixedBy || null, description: (v.description || "").substring(0, 150) });
      }
    }

    const prompt = `You are a container security expert specializing in Kubernetes image vulnerability analysis. Analyze the vulnerability scan results below using industry-standard security frameworks.

VULNERABILITY SUMMARY:
${JSON.stringify(vulnSummary, null, 1)}

TOP CVEs (${topCVEs.length} most critical):
${JSON.stringify(topCVEs.slice(0, 30), null, 1)}

TOP VULNERABLE IMAGES:
${JSON.stringify((vulnData.topImages || []).slice(0, 8).map(i => ({ image: i.image, namespace: i.namespace, critical: i.critical, high: i.high, medium: i.medium, low: i.low, maxCVSS: i.maxCVSS, totalVulns: (i.vulnerabilities || []).length })), null, 1)}

Analyze against these industry frameworks:
1. **NIST NVD Risk Assessment** — Known exploits, EPSS probability, CISA KEV
2. **Supply Chain Risk** — Base image freshness, unsigned images, missing SBOMs. Stale images: ${vulnData.ageSummary?.stale || 0}
3. **Compound Vulnerability Chains** — Multiple CVEs in same image enabling privilege escalation or RCE
4. **Compliance Gaps** — CIS 5.5.1 (no :latest), 5.5.2 (digest pinning), SOC2/PCI-DSS signing. Signed: ${vulnData.compliance?.signed || 0}/${vulnData.compliance?.total || 0}
5. **Blast Radius** — Vulnerable images in critical namespaces
6. **Remediation Priority** — Biggest risk reduction, quick wins vs major rebuilds
7. **Image Hygiene** — Fixable but unpatched vulnerabilities, outdated base images

Respond ONLY with a JSON array of findings. Each:
- "severity": "critical" | "warning" | "info"
- "title": max 80 chars
- "category": "exploit_risk" | "supply_chain" | "compound_vuln" | "compliance" | "blast_radius" | "remediation" | "hygiene"
- "evidence": specific CVEs, images, data
- "impact": security impact
- "action": remediation steps with image names/CVE IDs
- "confidence": 70-99
- "framework": security framework (NIST, CIS, PCI-DSS, OWASP)

Return ONLY the JSON array.`;

    const r = await callLLM({
      messages: [{ role: "user", content: prompt }],
      system: "You are a precise container security analyst. Reference specific CVE IDs, image names, and industry frameworks. Output only valid JSON arrays. No markdown fences.",
      maxTokens: 3000, temperature: 0.15,
      provider: llmOpts.provider, apiUrl: llmOpts.apiUrl, apiKey: llmOpts.apiKey,
      model: llmOpts.model, azureDeployment: llmOpts.azureDeployment, azureApiVersion: llmOpts.azureApiVersion,
    });

    let findings = [];
    try {
      let text = (r.text || "").trim();
      const fm = text.match(/\[[\s\S]*\]/);
      if (fm) text = fm[0];
      findings = JSON.parse(text);
      if (!Array.isArray(findings)) findings = [];
      findings = findings.filter(f => f.severity && f.title).map(f => ({
        severity: ["critical", "warning", "info"].includes(f.severity) ? f.severity : "info",
        title: String(f.title).substring(0, 100), category: f.category || "hygiene",
        evidence: String(f.evidence || "").substring(0, 500), impact: String(f.impact || "").substring(0, 500),
        action: String(f.action || "").substring(0, 400), confidence: Math.min(99, Math.max(70, parseInt(f.confidence) || 85)),
        framework: String(f.framework || "").substring(0, 50), llm: true,
      }));
    } catch { return json(res, 200, { findings: [], error: "Failed to parse LLM response" }); }

    json(res, 200, { findings, provider: r.provider || provider });
  } catch (err) {
    console.error("Image vuln AI analysis error:", err);
    json(res, 500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/ai/optimization-analysis — AI resource optimization with trends
// ---------------------------------------------------------------------------
export async function handleOptimizationAnalysisAPI(req, res) {
  try {
    const body = await readBody(req);
    const llmOpts = body.llmOpts || {};
    const provider = llmOpts.provider || LLM_PROVIDER;

    if (!provider || provider === "none") {
      return json(res, 200, { findings: [], error: "No LLM provider configured. Configure a provider in Settings to enable AI optimization analysis." });
    }

    const clusterData = {};
    const tasks = [];

    tasks.push(ocpGet("/api/v1/pods?limit=500").then(r => {
      clusterData.pods = (r?.items || []).map(p => {
        const containers = p.spec?.containers || [];
        const statuses = p.status?.containerStatuses || [];
        return { name: p.metadata?.name, ns: p.metadata?.namespace, phase: p.status?.phase,
          restarts: statuses.reduce((s, c) => s + (c.restartCount || 0), 0), age: p.metadata?.creationTimestamp,
          requests: containers.map(c => ({ cpu: c.resources?.requests?.cpu, mem: c.resources?.requests?.memory, limCpu: c.resources?.limits?.cpu, limMem: c.resources?.limits?.memory })),
        };
      });
    }).catch(() => { clusterData.pods = []; }));

    tasks.push(ocpGet("/apis/metrics.k8s.io/v1beta1/pods").then(r => {
      clusterData.podMetrics = (r?.items || []).map(m => ({
        name: m.metadata?.name, ns: m.metadata?.namespace,
        containers: (m.containers || []).map(c => ({ cpu: c.usage?.cpu, mem: c.usage?.memory })),
      }));
    }).catch(() => { clusterData.podMetrics = []; }));

    tasks.push(ocpGet("/api/v1/nodes").then(r => {
      clusterData.nodes = (r?.items || []).map(n => ({
        name: n.metadata?.name, allocCpu: n.status?.allocatable?.cpu, allocMem: n.status?.allocatable?.memory,
        roles: Object.keys(n.metadata?.labels || {}).filter(l => l.startsWith("node-role.kubernetes.io/")).map(l => l.split("/")[1]),
      }));
    }).catch(() => { clusterData.nodes = []; }));

    tasks.push(ocpGet("/apis/metrics.k8s.io/v1beta1/nodes").then(r => {
      clusterData.nodeMetrics = (r?.items || []).map(m => ({ name: m.metadata?.name, cpu: m.usage?.cpu, mem: m.usage?.memory }));
    }).catch(() => { clusterData.nodeMetrics = []; }));

    tasks.push(ocpGet("/api/v1/persistentvolumeclaims?limit=200").then(r => {
      clusterData.pvcs = (r?.items || []).map(p => ({ name: p.metadata?.name, ns: p.metadata?.namespace, size: p.spec?.resources?.requests?.storage, phase: p.status?.phase, storageClass: p.spec?.storageClassName, age: p.metadata?.creationTimestamp }));
    }).catch(() => { clusterData.pvcs = []; }));

    let trendData = {};
    try { const { getTrends } = await import("./predictive-intel.js"); trendData = getTrends(); } catch {}

    let historicalFixes = [];
    try {
      const { findSimilarIncidents } = await import("./learning-engine.js");
      const matches = await findSimilarIncidents("optimization:resource-waste", { sinceDays: 365, limit: 5 });
      historicalFixes = (matches || []).map(m => ({ type: m.issue_type, resource: m.resource_name, ns: m.namespace, resolution: m.resolution_summary, success: m.resolution_success, date: m.resolved_at || m.occurred_at }));
    } catch {}

    await Promise.all(tasks);

    const metricsMap = new Map();
    for (const m of (clusterData.podMetrics || [])) metricsMap.set(`${m.ns}/${m.name}`, m);

    const systemNs = /^(openshift-|kube-|default$)/;
    const utilizationAnalysis = [];
    for (const p of clusterData.pods) {
      if (systemNs.test(p.ns) || p.phase !== "Running") continue;
      const m = metricsMap.get(`${p.ns}/${p.name}`);
      if (!m?.containers?.[0] || !p.requests?.[0]?.cpu) continue;
      const cpuReqM = _parseCpuM(p.requests[0].cpu);
      const cpuUseM = _parseCpuM(m.containers[0].cpu);
      if (cpuReqM <= 0) continue;
      const util = Math.round((cpuUseM / cpuReqM) * 100);
      if (util < 15 || util > 130) {
        utilizationAnalysis.push({ pod: p.name, ns: p.ns, cpuReq: cpuReqM, cpuUse: cpuUseM, util, memReq: p.requests[0].mem, memUse: m.containers[0].mem, type: util < 15 ? "over" : "under", age: p.age, restarts: p.restarts });
      }
    }
    utilizationAnalysis.sort((a, b) => Math.abs(b.util - 100) - Math.abs(a.util - 100));

    const prompt = `You are a FinOps and Kubernetes resource optimization expert. Analyze this cluster's resource utilization and provide strategic recommendations.

CLUSTER: ${clusterData.nodes.length} nodes, ${clusterData.pods.length} pods, ${clusterData.pvcs.length} PVCs

NODE RESOURCES & USAGE:
${JSON.stringify(clusterData.nodes.map(n => { const nm = (clusterData.nodeMetrics || []).find(m => m.name === n.name); return { ...n, currentCpu: nm?.cpu, currentMem: nm?.mem }; }).slice(0, 10), null, 1)}

TOP INEFFICIENCIES (${utilizationAnalysis.length} pods):
${JSON.stringify(utilizationAnalysis.slice(0, 20), null, 1)}

TREND DATA: ${JSON.stringify(trendData, null, 1)}
HISTORICAL FIXES (past year): ${JSON.stringify(historicalFixes, null, 1)}

Analyze:
1. **Long-Term Trends** — Workloads consistently over/under-provisioned based on pod age & restarts
2. **Capacity Planning** — Node utilization forecast, scaling needs, decommission candidates
3. **Right-Sizing Strategy** — VPA vs manual vs HPA per workload type
4. **Cost Optimization** — Monthly waste estimate, top 3 savings opportunities
5. **Namespace Quotas** — ResourceQuota/LimitRange based on actual usage
6. **Storage** — PVC utilization, orphaned storage
7. **Quick Wins vs Strategic** — "this week" vs "next quarter" changes
8. **Benchmarks** — Compare against Gartner FinOps (>85%), CIS (100% limits), Google SRE (20-40% headroom)

JSON array of findings. Each:
- "severity": "critical" | "warning" | "info"
- "title": max 80 chars
- "category": "waste_detection" | "capacity_planning" | "right_sizing" | "cost_optimization" | "namespace_quota" | "storage" | "quick_win" | "strategic" | "benchmark"
- "evidence": specific pod names, utilization %, data
- "impact": quantified (e.g., "~200m CPU monthly waste")
- "action": kubectl/oc commands or VPA/HPA configs
- "confidence": 70-99
- "timeframe": "immediate" | "this_week" | "this_month" | "next_quarter"
- "savings": resource savings estimate (optional)

Return ONLY the JSON array.`;

    const r = await callLLM({
      messages: [{ role: "user", content: prompt }],
      system: "Precise FinOps/K8s optimization analyst. Reference specific pod names, namespaces, utilization numbers. Align with Gartner FinOps, CNCF, Google SRE. Output only valid JSON arrays.",
      maxTokens: 3000, temperature: 0.15,
      provider: llmOpts.provider, apiUrl: llmOpts.apiUrl, apiKey: llmOpts.apiKey,
      model: llmOpts.model, azureDeployment: llmOpts.azureDeployment, azureApiVersion: llmOpts.azureApiVersion,
    });

    let findings = [];
    try {
      let text = (r.text || "").trim();
      const fm = text.match(/\[[\s\S]*\]/);
      if (fm) text = fm[0];
      findings = JSON.parse(text);
      if (!Array.isArray(findings)) findings = [];
      findings = findings.filter(f => f.severity && f.title).map(f => ({
        severity: ["critical", "warning", "info"].includes(f.severity) ? f.severity : "info",
        title: String(f.title).substring(0, 100), category: f.category || "right_sizing",
        evidence: String(f.evidence || "").substring(0, 500), impact: String(f.impact || "").substring(0, 500),
        action: String(f.action || "").substring(0, 500), confidence: Math.min(99, Math.max(70, parseInt(f.confidence) || 85)),
        timeframe: f.timeframe || "this_month", savings: String(f.savings || "").substring(0, 100), llm: true,
      }));
    } catch { return json(res, 200, { findings: [], error: "Failed to parse LLM response" }); }

    json(res, 200, { findings, provider: r.provider || provider });
  } catch (err) {
    console.error("Optimization AI analysis error:", err);
    json(res, 500, { error: err.message });
  }
}

function _parseCpuM(cpu) {
  if (!cpu) return 0;
  const s = String(cpu);
  if (s.endsWith("n")) return parseInt(s) / 1_000_000;
  if (s.endsWith("u")) return parseInt(s) / 1_000;
  if (s.endsWith("m")) return parseInt(s);
  return parseFloat(s) * 1000;
}
