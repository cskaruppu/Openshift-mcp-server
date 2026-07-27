#!/usr/bin/env node

/**
 * TCS Agentic AI Server
 * Model Context Protocol server for OpenShift Container Platform management
 * with ACM, Ansible Automation Platform, and ServiceNow integration.
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { execFile } from "node:child_process";
import { gzipSync } from "node:zlib";
import yaml from "js-yaml";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { registerClusterTools } from "./tools/cluster.js";
import { registerNodeTools } from "./tools/nodes.js";
import { registerPodTools } from "./tools/pods.js";
import { registerNamespaceTools } from "./tools/namespaces.js";
import { registerDiagnosticTools } from "./tools/diagnostics.js";
import { registerServiceNowTools } from "./tools/servicenow.js";
import { registerAnsibleTools } from "./tools/ansible.js";
import { registerEmergencyTools } from "./tools/emergency.js";
import { registerACMTools } from "./tools/acm.js";
import { registerDashboardTools } from "./tools/dashboard.js";
import { registerWorkloadTools } from "./tools/workloads.js";
import { registerHelmTools } from "./tools/helm.js";
import { registerTektonTools } from "./tools/tekton.js";
import { registerKubeVirtTools } from "./tools/kubevirt.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerGenericTools } from "./tools/generic.js";
import { registerMustGatherTools } from "./tools/mustgather.js";
import { registerMetricsTopTools } from "./tools/metrics-top.js";
import { registerPrometheusTools } from "./tools/prometheus-query.js";
import { registerOSSMTools } from "./tools/ossm.js";
import { registerGitOpsTools } from "./tools/gitops.js";
import { registerSecurityTools } from "./tools/security.js";
import { registerRecommendationTools } from "./tools/recommendations.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerVeleroTools } from "./tools/velero.js";
import { registerComplianceTools } from "./tools/compliance.js";
import { registerDriftTools } from "./tools/drift.js";
import { registerImpactTools } from "./tools/impact.js";
import { registerOperatorDiagTools } from "./tools/operator-diag.js";
import { registerPolicyGenTools } from "./tools/policy-gen.js";
import { registerSCCAdvisorTools } from "./tools/scc-advisor.js";
import { registerTimelineTools } from "./tools/timeline.js";
import { registerUpgradeAdvisorTools } from "./tools/upgrade-advisor.js";
import { registerBenchmarkTools } from "./tools/benchmarks.js";
import { registerProvisioningTools } from "./tools/provisioning.js";
import { registerPreflightTools } from "./tools/upgrade-preflight.js";
import { registerAppChangeWatcherTools, scanForChanges, getChangeLog, getWatchedNamespaces, getBaselines, discoverAppNamespaces, autoDiscoverAndWatch, scanGitOpsDrift, getChangeTimeline, getTimelineStats, addNamespaces, removeNamespaces, initNamespaceBaselines, acknowledgeChange, agreeChange, dismissChange, getWorkloadsByNamespace, getTrackedWorkloadCount, rehydrateTrackedNamespaces, initTrackedNamespaces, getChangeHistory, getLastScanTime, getLastChangeTime, getHealthStreak, analyzeChangeImpact, bulkAction, getWorkloadTimeline, scanConfigChanges, scoreNamespaceRecommendations, generateRiskExplanation, detectChangeCorrelations } from "./tools/app-change-watcher.js";
import { registerImageVulnScannerTools, runImageScan, getScanResults, getScanHistory, getComplianceCache, getImageAgeCache, detectScanSources } from "./tools/image-vulnerability-scanner.js";
import { authMiddleware, registerAuthRoutes, handleTokenLogin, handleUserManagement, getAuthMode, loadUserRoles, getUserRole, setUserRole, getAllUserRoles, checkPermission, getRoles, getUserNamespaces, canAccessNamespace, filterByNamespace, createUser, listUsers, changePassword } from "./services/auth.js";
import { runRCA, runNamespaceRCA, getActiveInvestigations, getRCAHistory } from "./tools/rca-engine.js";
import { getNetworkTopology, getClusterTopology, getExposedServices, getUnprotectedNamespaces } from "./tools/network-topology.js";
import { getNamespaceTopology } from "./tools/namespace-topology.js";
import { captureSnapshot as captureCapacitySnapshot, getCapacityForecast, getNamespaceForecasts, getCapacityHistory } from "./tools/capacity-forecast.js";
import { runComplianceScan, getComplianceResults, getComplianceScore, getComplianceHistory } from "./tools/compliance-scanner.js";
import { defineSLO, getSLOStatus, getAllSLOs, deleteSLO, calculateErrorBudget, loadSLOs, setPrometheusUrl, getPrometheusStatus } from "./tools/slo-tracker.js";
import { loadPolicies, getPolicies, getPolicy, createPolicy, updatePolicy, deletePolicy, evaluatePolicies, getClusterPolicies } from "./tools/policy-engine.js";
import { loadChannels, getChannels, createChannel, updateChannel, deleteChannel, testChannel, notify, getNotificationHistory } from "./services/notifications.js";
import { initAuditLog, logAuditEvent as logAuditTrailEvent, queryAuditLog, getAuditStats, exportAuditLog } from "./services/audit-log.js";
import { loadState, saveState } from "./utils/state-store.js";
import { generateAgentYAML } from "./utils/generate-agent-yaml.js";
import { recordIncidentResolution } from "./services/incident-rag.js";
import { initQueryTracer, getTraces, getTrace, getAgentAnalytics, getTraceStats } from "./services/query-tracer.js";
import { initIncidentManager, declareIncident, updateIncident, addTimelineEvent, getIncident, listIncidents, getIncidentStats as getLifecycleIncidentStats, resolveIncident, closeIncident } from "./services/incident-manager.js";
import { initChangeTimeline, recordChangeEvent, getTimeline as getChangeTimelineUnified, correlateAroundTime, getTimelineStats as getChangeTimelineStats } from "./services/change-timeline.js";
import { FRAMEWORKS, getFrameworkList, getFramework, evaluateFramework, evaluateAllFrameworks } from "./tools/compliance-frameworks.js";
import { handleSlackSlashCommand, handleSlackInteraction, handleTeamsAction, verifySlackSignature } from "./services/chatops.js";
import { parseDocx, parseMarkdownText } from "./services/doc-parser.js";
import { extractAIS, validateAIS, calculateConfidence } from "./services/ais-extractor.js";
import { generateManifests, renderYaml, renderSingleYaml } from "./services/manifest-generator.js";
import { createDeployment, executeDeployment, rollbackDeployment, getDeployment, listDeployments } from "./services/deployment-orchestrator.js";
import { registerDeployFromDocTools } from "./tools/deploy-from-doc.js";
import { handleDashboardAPI, handleLLMSettingsGet, handleLLMSettingsPost, handleLLMSettingsTest, handleServiceNowSettingsGet, handleServiceNowSettingsPost, handleServiceNowSettingsTest, handleUpgradeAnalyze, handleUpgradeStart, handleUpgradeStatus, handleUpgradeDryRun, handleUpgradeChannel, handleCRStatusCheck, restoreServiceNowSettings, handleUpgradeOrchestrator, hydrateLLMDefaults, getActiveLLMConfig } from "./services/dashboard-api.js";
import { callLLM } from "./services/llm.js";
import { generatePreAssessmentReport, generatePostAssessmentReport, generateReportHTML } from "./services/upgrade-report.js";
import { handleChatAPI, handleExecuteAPI, handleChatCompareAPI, handleChatInvestigateAPI, handleChatRunbookAPI, handleFeedbackAPI, handleFeedbackStatsAPI, handleRiskAnalysisAPI, handleImageVulnAnalysisAPI, handleImageRemediationAPI, handleImageRemediateAPI, handleOptimizationAnalysisAPI, handleComplianceImpactAPI, handleGenerateManifestAPI, compileSOPPlan, handleSOPExecuteAPI, handleSOPRollbackAPI, trackSubmittedCR, handleFleetChatAPI, updateClusterDigest } from "./services/chat-api.js";
import { cisCheckManifests, scanManifestImages } from "./services/manifest-scan.js";
import { handleIncidentCorrelationAPI, handleTopologyExplainAPI, handleImageAnalysisAPI, handleApiMigrationAPI } from "./services/chat-api.js";
import { getDeprecatedAPIConsumers } from "./tools/api-consumers.js";
import { getGpuOverview } from "./tools/gpu-metrics.js";
import { remember as fleetRemember, recall as fleetRecall, memoryStats as fleetMemoryStats } from "./services/fleet-memory.js";
import {
  listActions,
  getAction,
  confirmAction,
  cancelAction,
  executeAction,
  refreshFromServiceNow,
  isServiceNowEnabled,
} from "./services/action-workflow.js";
import {
  createChangeRequest as snowCreateCR,
  createIncident as snowCreateIncident,
  attachFile as snowAttachFile,
  resolveIncident as snowResolveIncident,
  updateRecord as snowUpdateRecord,
  queryRecords as snowQueryRecords,
  resolveCallerSysId as snowResolveCallerSysId,
} from "./utils/servicenow-client.js";
import {
  listChats,
  getChat,
  createChat,
  deleteChat,
  updateTitle,
  updateStarred,
  updateLocked,
  isLocked,
  searchChats,
  updateMessage,
  replaceMessageContent,
  addMessage,
  replaceAllMessages,
  isHistoryEnabled,
} from "./services/chat-history.js";
import { initDb, query as dbQuery, isEnabled as dbEnabled, saveClusterSnapshot, loadClusterSnapshot, loadAllClusterSnapshots, deleteClusterSnapshot } from "./utils/db.js";
import { loadAll as loadClusterCreds, upsert as clusterCredsUpsert, remove as clusterCredsRemove, list as clusterCredsList, hasCredentials } from "./utils/cluster-credentials.js";
import { initCache, isEnabled as cacheReady } from "./utils/cache.js";
import { handleMetricsRequest } from "./services/metrics.js";
import { enforce as enforceRateLimit } from "./services/rate-limit.js";
import { startHealthCheckTask, getLatestHealthReport } from "./services/scheduler.js";
import { listFiringAlerts } from "./services/alertmanager.js";
import { initSafety, getSafetyMode } from "./services/safety.js";
import { redactIfEnabled } from "./services/redaction.js";
import { loadKubeconfig, registerMultiClusterTools } from "./services/multi-cluster.js";
import { handleAgentRoutes as handleAgentRegistryRoutes, loadAgents } from "./agents/registry.js";
import { handleAgentChannel, handleToolRegistration, handleToolResponse, invokeAgentTool, hasActiveChannel, getChannelStatus, pushEventToAgent, broadcastEvent } from "./services/agent-bridge.js";
import { handleAgentMcpRoutes } from "./agents/mcp-router.js";
import { loadConfig } from "./utils/config.js";
import { validateCommand, getAccessLevel, isToolAllowed } from "./security/command-validator.js";
import { initComponents, isToolRegistrationEnabled, getComponentCatalog, getComponentSummary } from "./security/component-registry.js";
import { initTelemetry, shutdownTelemetry, startSpan, traceChatRequest, traceToolCall, getTelemetryStatus } from "./utils/telemetry-otel.js";
import { ocpGet, ocpPost, ocpPatch, ocpDelete, ocpFetch, withRemoteCluster, setRemoteCluster, clearRemoteCluster, setBridgeInvoker, enterRemoteClusterBridge, enterRemoteClusterDirect } from "./utils/openshift-client.js";
import { initPlatform, getPlatform } from "./platform/index.js";
import {
  connectServer as hubConnect,
  disconnectServer as hubDisconnect,
  reconnectServer as hubReconnect,
  listServers as hubListServers,
  getAllTools as hubGetAllTools,
  getToolCount as hubGetToolCount,
  loadAndReconnect as hubLoadAndReconnect,
  callTool as hubCallTool,
} from "./services/mcp-hub.js";
import { runOrchestrator } from "./services/mcp-orchestrator.js";
import {
  startProactiveMonitor,
  getInsights,
  getInsightsSummary,
  dismissInsight,
  analyzeInsight,
  analyzeAlert,
  isMonitorRunning,
} from "./services/proactive-agent.js";
import { executeFixCommand, fetchPodStatus } from "./services/fix-executor.js";
import {
  initKnowledgeBase,
  recordResolution,
  findSimilar as kbFindSimilar,
  rateResolution,
  getStats as kbGetStats,
  getAllEntries as kbGetAll,
  buildKBContext,
} from "./services/knowledge-base.js";
import {
  initLearningEngine,
  recordIncident as leRecordIncident,
  recordResolution as leRecordResolution,
  findSimilarIncidents,
  getTeamPlaybook,
  getIncidentStats,
  buildLearningContext,
  buildSignature as leBuildSignature,
  signatureForInsight,
} from "./services/learning-engine.js";
import {
  initAutomationRules,
  createRule,
  listRules,
  toggleRule,
  deleteRule,
  evaluateRules,
  executeRuleActions,
} from "./services/automation-rules.js";
import {
  runPredictiveAnalysis,
  getPredictions,
  getTrends,
} from "./services/predictive-intel.js";
import {
  runCorrelationAnalysis as runCorrelation,
  investigateCorrelation as investigateCorrelationById,
  getClusterSignalSummary as getSignalSummary,
} from "./services/cross-cluster-correlation.js";
import { trackCR, getCR, listCRs, getPendingCRs, updateCRStatus, syncCRFromServiceNow, syncAllPendingCRs, cleanupOldCRs, backfillFromAuditTrail, dismissCR, deleteCR } from "./services/cr-tracker.js";
import {
  getMetricsSummary,
  getTimeSeries,
  getTopIntents,
  getProviderBreakdown,
  getErrorBreakdown,
  getRecentEvents,
} from "./services/telemetry.js";
import {
  classifyCommand,
  preflightCheck,
  issueConfirmationToken,
  logAuditEvent,
  getAuditLog,
  getAuditSummary,
} from "./services/guardrails.js";
import {
  getUserPreferences,
  setUserPreferences,
  recordUserFact,
  getUserFacts,
  addTeamKnowledge,
  searchTeamKnowledge,
  getUserIdFromRequest,
} from "./services/persistent-memory.js";
import {
  createPlan,
  getPlan,
  listPlans,
  approvePlan,
  markStepStatus,
  rollbackPlan,
  renderPlanTag,
} from "./services/task-planner.js";
import {
  getIntegrationsConfig,
  setIntegrationsConfig,
  redactConfig,
  testConnection,
  notifyAll,
  queryPrometheus,
} from "./services/integrations.js";
import { getRecentTraces } from "./services/reasoning.js";
import { flags as featureFlags, snapshot as flagSnapshot } from "./services/feature-flags.js";

const silencedAlerts = new Map(); // key: "cluster|name|namespace"
let _liveState = null; // Local cluster only — never served for remote cluster requests
const _parseJobs = new Map();

function createMcpServer() {
  const server = new McpServer({
    name: "tcs-agentic-ai",
    version: "1.0.0",
    description:
      "TCS Agentic AI — Enterprise Intelligence Platform with MCP Hub, multi-server orchestration, diagnostics, ITSM integration, and automated remediation.",
  });

  initComponents();

  const toolGroups = [
    ["registerClusterTools",        registerClusterTools],
    ["registerNodeTools",           registerNodeTools],
    ["registerPodTools",            registerPodTools],
    ["registerNamespaceTools",      registerNamespaceTools],
    ["registerDiagnosticTools",     registerDiagnosticTools],
    ["registerServiceNowTools",     registerServiceNowTools],
    ["registerAnsibleTools",        registerAnsibleTools],
    ["registerEmergencyTools",      registerEmergencyTools],
    ["registerACMTools",            registerACMTools],
    ["registerDashboardTools",      registerDashboardTools],
    ["registerWorkloadTools",       registerWorkloadTools],
    ["registerHelmTools",           registerHelmTools],
    ["registerTektonTools",         registerTektonTools],
    ["registerKubeVirtTools",       registerKubeVirtTools],
    ["registerNetworkTools",        registerNetworkTools],
    ["registerGenericTools",        registerGenericTools],
    ["registerMustGatherTools",     registerMustGatherTools],
    ["registerMetricsTopTools",     registerMetricsTopTools],
    ["registerPrometheusTools",     registerPrometheusTools],
    ["registerOSSMTools",           registerOSSMTools],
    ["registerGitOpsTools",         registerGitOpsTools],
    ["registerSecurityTools",       registerSecurityTools],
    ["registerRecommendationTools", registerRecommendationTools],
    ["registerNotificationTools",   registerNotificationTools],
    ["registerVeleroTools",         registerVeleroTools],
    ["registerComplianceTools",     registerComplianceTools],
    ["registerDriftTools",          registerDriftTools],
    ["registerImpactTools",         registerImpactTools],
    ["registerOperatorDiagTools",   registerOperatorDiagTools],
    ["registerPolicyGenTools",      registerPolicyGenTools],
    ["registerSCCAdvisorTools",     registerSCCAdvisorTools],
    ["registerTimelineTools",       registerTimelineTools],
    ["registerUpgradeAdvisorTools", registerUpgradeAdvisorTools],
    ["registerBenchmarkTools",      registerBenchmarkTools],
    ["registerProvisioningTools",   registerProvisioningTools],
    ["registerPreflightTools",      registerPreflightTools],
    ["registerAppChangeWatcherTools", registerAppChangeWatcherTools],
    ["registerImageVulnScannerTools", registerImageVulnScannerTools],
    ["registerDeployFromDocTools",    registerDeployFromDocTools],
  ];

  let registered = 0;
  let skipped = 0;
  for (const [name, fn] of toolGroups) {
    if (isToolRegistrationEnabled(name)) {
      fn(server);
      registered++;
    } else {
      skipped++;
    }
  }

  // Multi-cluster is always registered (not component-gated)
  registerMultiClusterTools(server);

  if (skipped > 0) {
    console.log(`[components] registered ${registered} tool groups, skipped ${skipped} (disabled)`);
  }

  return server;
}

// ---------------------------------------------------------------------------
// stdio transport — for local CLI / Claude Desktop usage
// ---------------------------------------------------------------------------
async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenShift MCP Server running on stdio");
}

// ---------------------------------------------------------------------------
// SSE transport — for running inside a Kubernetes pod
// Each client GET /sse opens a session; messages arrive via POST /message.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// /api/chats — persistent chat history backed by PostgreSQL.
// Returns 503 if the DB is not configured; the dashboard then falls back to
// browser localStorage.
// ---------------------------------------------------------------------------
const _connectedAgents = new Map();

/** Export a getter so other modules (e.g. chat-api) can look up agents. */
export function getConnectedAgents() {
  return _connectedAgents;
}

// Re-export bridge functions so other modules (e.g. chat-api) can invoke agent tools
export { invokeAgentTool, hasActiveChannel } from "./services/agent-bridge.js";

// Hub/Spoke federation — proxy API calls to spoke MCP servers for identical results
import { registerSpoke, unregisterSpoke, hasSpoke, proxyToSpoke, proxyChatToSpoke, getSpokeStatus, updateSpokeHeartbeat, getAllSpokes, startSpokeMode, fedFetch } from "./services/spoke-proxy.js";
export { hasSpoke, getSpokeStatus, proxyChatToSpoke };

const MCP_MODE = (process.env.MCP_MODE || "hub").toLowerCase(); // hub | spoke | control | standalone

// Name under which the management cluster's own MCP server registers
// (deployed like any other cluster via ./deploy/mcp/deploy.sh — the ACM
// "local-cluster" pattern). Requests with ?cluster=local are routed to it
// through the same spoke pipeline as every other cluster when registered.
const HUB_AGENT_CLUSTER = process.env.HUB_AGENT_CLUSTER || "hub-cluster";

// MCP server version — used for drift detection across clusters
const _MCP_PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")).version; }
  catch { return "1.0.0"; }
})();
const _MCP_BUILD_HASH = process.env.BUILD_HASH || createHash("sha256").update(String(process.pid) + process.cwd()).digest("hex").slice(0, 8);
const _MCP_STARTED_AT = new Date().toISOString();
const MCP_VERSION = `${_MCP_PKG_VERSION}+${_MCP_BUILD_HASH}`;

// Wire ocpGet() bridge routing → remote agent api_get tool. This lets the
// existing preflight/upgrade/CR logic run against remote clusters unchanged.
setBridgeInvoker(async (cluster, path, opts = {}) => {
  const r = await invokeAgentTool(cluster, "api_get", { path, asText: !!opts.asText }, 15000);
  if (!r || !r.success) {
    throw new Error(r?.error || `Bridge api_get failed for ${path}`);
  }
  return r.data;
});

async function detectCLI() {
  for (const cmd of ["oc", "kubectl"]) {
    try { await runExec("which", [cmd]); return cmd; }
    catch { /* try next */ }
  }
  throw new Error("Neither oc nor kubectl found");
}

function runExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve((stdout || "").trim());
    });
  });
}

/**
 * Find an existing cluster entry by name (case-insensitive) or API URL.
 * Returns the Map key if found, null otherwise.
 */
function findClusterKey(name, apiUrl) {
  if (_connectedAgents.has(name)) return name;
  const nameLower = (name || "").toLowerCase();
  for (const [key, agent] of _connectedAgents) {
    if (key.toLowerCase() === nameLower) return key;
    if ((agent.clusterName || "").toLowerCase() === nameLower) return key;
    if (apiUrl && agent.apiUrl && agent.apiUrl === apiUrl) return key;
  }
  return null;
}

/** Persist the connected-agents map to the kv_store table. */
async function saveClustersToDB() {
  if (!(await dbEnabled())) return;
  try {
    const obj = Object.fromEntries(_connectedAgents);
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      ["connected_clusters", JSON.stringify(obj)]
    );
  } catch (err) {
    console.warn("[hub] Failed to persist clusters to DB:", err.message);
  }
}

/** Load previously registered clusters from the kv_store table on startup. */
async function loadClustersFromDB() {
  if (!(await dbEnabled())) return;
  try {
    const result = await dbQuery(
      "SELECT value FROM kv_store WHERE key = $1",
      ["connected_clusters"]
    );
    if (result?.rows?.length) {
      const obj = typeof result.rows[0].value === "string"
        ? JSON.parse(result.rows[0].value)
        : result.rows[0].value;
      for (const [name, agent] of Object.entries(obj)) {
        if (!_connectedAgents.has(name)) {
          _connectedAgents.set(name, agent);
        }
      }
      if (_connectedAgents.size > 0) {
        console.log(`[startup] Restored ${_connectedAgents.size} cluster registrations from DB`);
      }

      // Rebuild the in-memory spoke registry (_spokes) from the persisted
      // cluster data. _spokes lives only in memory and is otherwise wiped on
      // every hub restart/redeploy — which silently drops the LIVE hub->spoke
      // proxy and makes dashboards fall back to the stale agent-cache path
      // ("... not available from this agent"). Restoring it here keeps spoke
      // clusters fully live across hub restarts without waiting for the spoke
      // to re-register on its next heartbeat.
      let restoredSpokes = 0;
      for (const [name, agent] of _connectedAgents) {
        if (agent && agent.source === "spoke" && agent.spokeUrl && !hasSpoke(name)) {
          registerSpoke(name, agent.spokeUrl, {
            platform: agent.platform,
            version: agent.version,
          });
          restoredSpokes++;
        }
      }
      if (restoredSpokes > 0) {
        console.log(`[startup] Restored ${restoredSpokes} spoke proxy registration(s) from DB`);
      }
    }
  } catch (err) {
    console.warn("[hub] Failed to load clusters from DB:", err.message);
  }
}

/**
 * Probe every spoke restored from the DB and remove entries whose pod is
 * not actually running.  Runs once at startup so stale registrations from
 * a previous deployment don't show as ghost cluster cards.
 */
async function pruneUnreachableSpokes() {
  const toRemove = [];
  for (const [name, agent] of _connectedAgents) {
    if (!agent?.spokeUrl) continue;
    try {
      const resp = await fedFetch(`${agent.spokeUrl}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) toRemove.push(name);
    } catch {
      toRemove.push(name);
    }
  }
  for (const name of toRemove) {
    _connectedAgents.delete(name);
    unregisterSpoke(name);
    if (CLUSTER_STORE_ENABLED) deleteClusterSnapshot(name).catch(() => {});
    console.log(`[startup] Pruned unreachable cluster "${name}" — spoke pod not running`);
  }
  if (toRemove.length > 0) {
    saveClustersToDB().catch(() => {});
  }
}

/**
 * Persist the local (hub-cluster) MCP agent registration. Unlike remote
 * clusters it never enters _connectedAgents (no separate card), so without
 * this a control-plane restart silently dropped it and the picker showed
 * "agent not deployed" until the agent's next heartbeat re-registered it.
 */
async function saveHubAgentSpoke(info) {
  if (!(await dbEnabled())) return;
  try {
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      ["hub_agent_spoke", JSON.stringify({ ...info, registeredAt: new Date().toISOString() })]
    );
  } catch (err) {
    console.warn("[hub] Failed to persist local MCP agent registration:", err.message);
  }
}

/** Restore the local MCP agent registration on startup (probe before trusting). */
async function restoreHubAgentSpoke() {
  if (!(await dbEnabled()) || hasSpoke(HUB_AGENT_CLUSTER)) return;
  try {
    const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", ["hub_agent_spoke"]);
    if (!result?.rows?.length) return;
    const info = typeof result.rows[0].value === "string"
      ? JSON.parse(result.rows[0].value)
      : result.rows[0].value;
    if (!info?.spokeUrl) return;
    try {
      const resp = await fedFetch(`${info.spokeUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        registerSpoke(HUB_AGENT_CLUSTER, info.spokeUrl, { platform: info.platform });
        console.log(`[startup] Restored local MCP agent registration: ${info.spokeUrl}`);
      } else {
        console.warn(`[startup] Local MCP agent at ${info.spokeUrl} returned ${resp.status} — waiting for its heartbeat`);
      }
    } catch (err) {
      console.warn(`[startup] Local MCP agent at ${info.spokeUrl} unreachable — waiting for its heartbeat`);
    }
  } catch (err) {
    console.warn("[hub] Failed to restore local MCP agent registration:", err.message);
  }
}

/**
 * Fetch cluster summary from a spoke MCP server (version, nodes, pods)
 * and populate _connectedAgents so the dashboard card shows real data.
 */
async function fetchSpokeSummary(clusterName, spokeUrl) {
  try {
    const resp = await fedFetch(`${spokeUrl}/api/cluster/summary`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return;
    const data = await resp.json();

    const agent = _connectedAgents.get(clusterName);
    if (!agent) return;

    const isOCP = !!data.isOpenShift;
    agent.lastReport = {
      openshiftVersion: isOCP ? (data.cluster?.version || "") : "",
      kubernetesVersion: data.cluster?.kubernetesVersion || data.cluster?.version || "",
      clusterHealth: { status: data.cluster?.health || "healthy" },
      nodes: { ready: data.nodes?.ready || 0, total: data.nodes?.total || 0 },
      pods: { running: data.pods?.running || 0, total: data.pods?.total || 0 },
      clusterOperators: data.operators || {},
      namespaces: data.namespaces || { total: 0 },
      resourceSummary: {
        totalCPU: data.nodes?.totalCPU || 0,
        totalMemoryGi: data.nodes?.totalMemGi || 0,
      },
    };
    agent.platform = data.platform || agent.platform;
    _connectedAgents.set(clusterName, agent);
    saveClustersToDB().catch(() => {});
    console.log(`[hub] Fetched summary from spoke "${clusterName}": ${agent.lastReport.nodes.ready} nodes, ${agent.lastReport.pods.running} pods`);
  } catch (err) {
    console.warn(`[hub] Could not fetch summary from spoke "${clusterName}": ${err.message}`);
  }
}

/**
 * Build the desired ClusterRole rules for a given platform.
 * This is the single source of truth for agent RBAC — the agent
 * fetches this and patches its own ClusterRole to match.
 */
function buildDesiredRBACRules(platform, withActions = false) {
  const rules = [
    { apiGroups: [""], resources: ["pods", "pods/log", "nodes", "services", "events", "namespaces", "configmaps", "persistentvolumeclaims", "endpoints", "replicationcontrollers", "serviceaccounts", "resourcequotas", "limitranges"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["apps"], resources: ["deployments", "statefulsets", "daemonsets", "replicasets"], verbs: ["get", "list", "watch"] },
    // Self-redeploy — agent patches its own Deployment for rollout restart
    { apiGroups: ["apps"], resources: ["deployments"], resourceNames: ["tcs-agentic-ai"], verbs: ["patch"] },
    { apiGroups: ["batch"], resources: ["jobs", "cronjobs"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["networking.k8s.io"], resources: ["ingresses", "networkpolicies"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["metrics.k8s.io"], resources: ["pods", "nodes"], verbs: ["get", "list"] },
    { apiGroups: ["storage.k8s.io"], resources: ["storageclasses", "volumeattachments"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["autoscaling"], resources: ["horizontalpodautoscalers"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["policy"], resources: ["poddisruptionbudgets"], verbs: ["get", "list", "watch"] },
    // RBAC audit + self-update for the agent's own ClusterRole
    { apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles", "clusterrolebindings", "roles", "rolebindings"], verbs: ["get", "list"] },
    { apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"], resourceNames: ["tcs-agentic-ai-role"], verbs: ["update", "patch"] },
    // GitOps — ArgoCD
    { apiGroups: ["argoproj.io"], resources: ["applications", "applicationsets"], verbs: ["get", "list"] },
    // DR — Velero/OADP
    { apiGroups: ["velero.io"], resources: ["backups", "schedules", "backupstoragelocations"], verbs: ["get", "list"] },
    // Image Vulnerabilities — Trivy
    { apiGroups: ["aquasecurity.github.io"], resources: ["vulnerabilityreports", "configauditreports"], verbs: ["get", "list"] },
  ];

  if (platform === "openshift") {
    rules.push(
      { apiGroups: ["route.openshift.io"], resources: ["routes"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["apps.openshift.io"], resources: ["deploymentconfigs"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["project.openshift.io"], resources: ["projects"], verbs: ["get", "list"] },
      { apiGroups: ["config.openshift.io"], resources: ["clusterversions", "clusteroperators", "infrastructures"], verbs: ["get", "list"] },
      { apiGroups: ["machine.openshift.io"], resources: ["machines", "machinesets"], verbs: ["get", "list"] },
      { apiGroups: ["security.openshift.io"], resources: ["securitycontextconstraints"], verbs: ["get", "list"] },
      { apiGroups: ["secscan.quay.redhat.com"], resources: ["imagemanifestvulns"], verbs: ["get", "list"] },
    );
  }
  if (platform === "rancher") {
    rules.push(
      { apiGroups: ["management.cattle.io"], resources: ["clusters", "nodes"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["fleet.cattle.io"], resources: ["bundles", "gitrepos"], verbs: ["get", "list"] },
    );
  }
  if (platform === "eks") {
    rules.push({ apiGroups: ["eks.amazonaws.com"], resources: ["*"], verbs: ["get", "list"] });
  }
  if (platform === "gke") {
    rules.push({ apiGroups: ["cloud.google.com"], resources: ["*"], verbs: ["get", "list"] });
  }

  // Opt-in remote actions — scoped write verbs for scale/restart/delete/cordon.
  // Only added when the user explicitly enables actions for this cluster.
  if (withActions) {
    rules.push(
      // Scale & rollout-restart deployments/statefulsets/daemonsets
      { apiGroups: ["apps"], resources: ["deployments", "statefulsets", "daemonsets"], verbs: ["update", "patch"] },
      { apiGroups: ["apps"], resources: ["deployments/scale", "statefulsets/scale"], verbs: ["update", "patch"] },
      // Delete (restart) pods
      { apiGroups: [""], resources: ["pods"], verbs: ["delete"] },
      // Cordon / uncordon nodes
      { apiGroups: [""], resources: ["nodes"], verbs: ["patch", "update"] },
    );
    // OpenShift cluster upgrade — patch ClusterVersion desiredUpdate
    if (platform === "openshift") {
      rules.push({ apiGroups: ["config.openshift.io"], resources: ["clusterversions"], verbs: ["patch", "update"] });
    }
  }

  return rules;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Cluster Isolation Policy — validate that a cluster name is known before
// accepting it in any API request. Returns the resolved key or "local".
// Rejects unknown/arbitrary cluster names to prevent enumeration and spoofing.
// ---------------------------------------------------------------------------
function validateClusterParam(nameOrBody, url) {
  const raw = (typeof nameOrBody === "string" ? nameOrBody : null)
    || (nameOrBody?.cluster)
    || (url?.searchParams?.get("cluster"))
    || "local";
  if (!raw || raw === "local") return "local";
  const resolved = findClusterKey(raw);
  if (!resolved) return null;
  return resolved;
}

function rejectUnknownCluster(res, name) {
  sendJson(res, 404, { error: "Cluster not found" });
}

async function withClusterContext(url, handler) {
  const clusterName = url.searchParams.get("cluster");
  if (clusterName && clusterName !== "local") {
    // Try live agent bridge first (real-time data)
    if (hasActiveChannel(clusterName)) {
      const toolResult = await tryAgentBridgeTool(url.pathname, clusterName);
      if (toolResult !== null) return toolResult;
    }
    // Direct-access via stored credentials (Rancher/ArgoCD pattern)
    const { hasCredentials: _hasCreds, withClusterDirect: _withDirect } = await import("./utils/cluster-credentials.js");
    if (_hasCreds(clusterName)) {
      try {
        return await _withDirect(clusterName, handler);
      } catch (err) {
        console.error(`[hub] Direct-access to ${clusterName} failed (${err.message}), falling back to cached data`);
        return null;
      }
    }
    // Fall back to agent's stored apiUrl/token from _connectedAgents
    const resolvedKey = findClusterKey(clusterName) || clusterName;
    const agent = _connectedAgents.get(resolvedKey);
    if (!agent) {
      throw Object.assign(new Error("Cluster not found"), { status: 404 });
    }
    if (agent.apiUrl && agent.token) {
      try {
        return await withRemoteCluster(agent.apiUrl, agent.token, handler);
      } catch (proxyErr) {
        console.error(`[hub] Proxy to ${clusterName} failed (${proxyErr.message}), falling back to cached agent data`);
        return null;
      }
    }
    return null;
  }
  return handler();
}

// ── Async fix-verification jobs ──────────────────────────────────────────
// Production pattern: /api/alerts/execute-fix applies the fix and returns
// immediately (202) with a verifyJobId; the pod-watch → incident close →
// after-metrics run in the BACKGROUND and are stored here; the UI polls
// /api/alerts/fix-status?jobId=… for progress. Keeps long remediations off
// the request path so a slow rollout never trips a route/proxy timeout.
const _verifyJobs = new Map();
const VERIFY_JOB_TTL_MS = 15 * 60 * 1000;
function setVerifyJob(id, patch) {
  const prev = _verifyJobs.get(id) || {};
  _verifyJobs.set(id, { ...prev, ...patch, updatedAt: Date.now() });
  if (_verifyJobs.size > 300) {
    const now = Date.now();
    for (const [k, v] of _verifyJobs) if (now - (v.updatedAt || 0) > VERIFY_JOB_TTL_MS) _verifyJobs.delete(k);
  }
}

/**
 * Try to invoke a tool on a remote agent via the SSE bridge.
 * Maps API endpoint paths to agent tool names.
 * Returns the tool result data on success, or null to fall through to proxy/cache.
 */
async function tryAgentBridgeTool(pathname, clusterName) {
  const toolMap = {
    "/api/cluster/summary": "get_cluster_summary",
    "/api/nodes": "get_nodes",
    "/api/node-metrics": "get_metrics",
    "/api/pods/issues": "get_pod_issues",
    "/api/namespaces": "get_namespaces",
    "/api/cluster/operators": "get_operators",
  };
  const toolName = toolMap[pathname];
  if (!toolName) return null;
  try {
    const result = await invokeAgentTool(clusterName, toolName, {}, 12000);
    if (result && result.success) return result.data;
    return null;
  } catch {
    return null; // Fall through to cache/proxy
  }
}

const AGENT_CACHE_MAX_AGE_SEC = 300; // 5 minutes

// Phase 1: per-cluster snapshot store. When enabled, agent reports are
// persisted to PostgreSQL (one row per cluster) and hydrated on startup so the
// dashboard has warm data immediately and survives hub restarts.
// Feature-flag reversible: set CLUSTER_STORE_ENABLED=false to disable instantly.
const CLUSTER_STORE_ENABLED = process.env.CLUSTER_STORE_ENABLED !== "false";

// Fleet-wide image vulnerability aggregation. OFF by default → the Image
// Vulnerability panel behaves exactly as today (single cluster). When ON, the
// hub merges its own scan with the per-cluster image-vuln snapshots already
// reported by connected spokes (reusing the agent cache — no new cross-cluster
// scan calls), tags every finding by cluster, dedupes, and returns a `fleet`
// summary. Purely additive + reversible: set FLEET_SCAN_ENABLED=false to revert.
const FLEET_SCAN_ENABLED = process.env.FLEET_SCAN_ENABLED === "true";
const HUB_CLUSTER_NAME = process.env.HUB_CLUSTER_NAME || "hub";

// Data-plane endpoints: require a running MCP agent pod. In MCP_MODE=control
// these must NOT be served in-process — only via the spoke proxy.
const DATA_PLANE_ENDPOINTS = new Set([
  "/api/cluster/summary", "/api/cluster/info", "/api/nodes", "/api/node-metrics",
  "/api/namespaces", "/api/pods/issues", "/api/cluster/operators", "/api/alerts",
  "/api/dashboard/security", "/api/dashboard/gitops", "/api/dashboard/dr",
  "/api/dashboard/optimization", "/api/dashboard/image-vulns",
]);

const _localDashCache = new Map();
const LOCAL_CACHE_TTL_MS = 30000;
const LOCAL_CACHEABLE = new Set([
  "/api/cluster/summary", "/api/nodes", "/api/node-metrics", "/api/namespaces",
  "/api/pods/issues", "/api/cluster/operators", "/api/alerts",
  "/api/dashboard/security", "/api/dashboard/gitops", "/api/dashboard/dr",
  "/api/dashboard/optimization", "/api/dashboard/image-vulns",
]);
function getLocalCache(path) {
  const entry = _localDashCache.get(path);
  if (!entry) return null;
  if (Date.now() - entry.ts > LOCAL_CACHE_TTL_MS) { _localDashCache.delete(path); return null; }
  return entry.data;
}
function setLocalCache(path, data) {
  if (LOCAL_CACHEABLE.has(path)) _localDashCache.set(path, { data, ts: Date.now() });
}

/**
 * Return cached agent data for a given cluster and endpoint.
 * @param {string} clusterName - The cluster name from ?cluster= param
 * @param {string} endpointPath - The API endpoint path (e.g. "/api/nodes")
 * @param {object} [opts] - Options
 * @param {boolean} [opts.skipFreshnessCheck] - If true, serve data even if stale (used as fallback after proxy failure)
 */
export function getAgentCachedResponse(clusterName, endpointPath, opts = {}) {
  const resolvedKey = findClusterKey(clusterName) || clusterName;
  const agent = _connectedAgents.get(resolvedKey);
  if (!agent?.lastReport) return null;

  // Check freshness — only serve cache if report is within max age (unless skipped for fallback)
  if (!opts.skipFreshnessCheck) {
    if (agent.lastReportTime) {
      const elapsed = (Date.now() - new Date(agent.lastReportTime).getTime()) / 1000;
      if (elapsed > AGENT_CACHE_MAX_AGE_SEC) return null;
    } else {
      return null;
    }
  }

  const report = agent.lastReport;
  const stale = agent.lastReportTime
    ? ((Date.now() - new Date(agent.lastReportTime).getTime()) / 1000 > AGENT_CACHE_MAX_AGE_SEC)
    : true;
  const meta = { source: "agent-cache", lastReportTime: agent.lastReportTime, clusterName: agent.clusterName, ...(stale ? { stale: true } : {}) };

  const isOpenShift = (agent.platform || "").toLowerCase() === "openshift";
  switch (endpointPath) {
    case "/api/cluster-info": {
      const _ciDeg = report.clusterOperators?.degraded || 0;
      const _ciTot = report.nodes?.total || 0;
      const _ciRdy = report.nodes?.ready || 0;
      const _ciHealth = _ciDeg > 0 ? "degraded" : (_ciRdy < _ciTot ? "warning" : "healthy");
      return {
        version: report.openshiftVersion || report.kubernetesVersion || "unknown",
        kubernetesVersion: report.kubernetesVersion || null,
        platform: agent.platform || "kubernetes",
        isOpenShift,
        nodeCount: _ciTot,
        readyNodes: _ciRdy,
        health: _ciHealth,
        ...meta,
      };
    }

    case "/api/cluster/summary": {
      // Recompute health from operators+nodes (authoritative hub formula)
      const _degOps = report.clusterOperators?.degraded || 0;
      const _totalN = report.nodes?.total || 0;
      const _readyN = report.nodes?.ready || 0;
      const _health = _degOps > 0 ? "degraded" : (_readyN < _totalN ? "warning" : "healthy");
      return {
        platform: agent.platform || "kubernetes",
        isOpenShift,
        cluster: {
          version: report.openshiftVersion || report.kubernetesVersion || "unknown",
          kubernetesVersion: report.kubernetesVersion || null,
          health: _health,
          channel: isOpenShift ? "stable-" + (report.openshiftVersion || "").split(".").slice(0, 2).join(".") : "",
        },
        nodes: {
          total: report.nodes?.total || 0,
          ready: report.nodes?.ready || 0,
          totalCPU: report.resourceSummary?.totalCPU || 0,
          totalMemGi: report.resourceSummary?.totalMemoryGi || 0,
        },
        pods: {
          total: report.pods?.total || 0,
          running: report.pods?.running || 0,
          failed: report.pods?.failed || 0,
          pending: report.pods?.pending || 0,
        },
        namespaces: {
          total: report.namespaces?.total || 0,
          user: report.namespaces?.user || 0,
          system: report.namespaces?.system || 0,
        },
        operators: {
          total: report.clusterOperators?.total || 0,
          healthy: report.clusterOperators?.healthy || 0,
          degraded: report.clusterOperators?.degraded || 0,
          degradedNames: (report.clusterOperators?.items || []).filter(o => o.degraded).map(o => o.name),
        },
        ...meta,
      };
    }

    case "/api/nodes":
      return (report.nodes?.items || []).map(n => ({
        name: n.name,
        roles: Array.isArray(n.roles) ? n.roles : (n.roles ? [n.roles] : []),
        ready: n.ready,
        cpu: n.capacity?.cpu || String(n.cpu || "0"),
        memory: n.capacity?.memory || (n.memory ? Math.round(n.memory) + "Gi" : "0"),
        pods: 0,
        maxPods: n.maxPods || 110,
        kubeletVersion: n.kubeletVersion || "",
        osImage: n.os || n.osImage || "",
        memoryPressure: n.memoryPressure || false,
        diskPressure: n.diskPressure || false,
        pidPressure: n.pidPressure || false,
      }));

    case "/api/node-metrics":
      if (!report.metrics?.nodes) return [];
      return report.metrics.nodes.map(n => ({
        name: n.name,
        cpuUsage: n.cpuUsage || n.cpu || "0",
        cpuPercent: n.cpuPercent || 0,
        memoryUsage: n.memoryUsage || n.memory || "0",
        memoryPercent: n.memoryPercent || 0,
      }));

    case "/api/pods/issues":
      return (report.pods?.issues || []).map(i => ({
        name: i.pod || i.name,
        namespace: i.namespace,
        node: i.node || "",
        phase: i.phase || "Failed",
        podAgeHours: i.podAge || 0,
        ownerKind: i.ownerKind || "",
        ownerName: i.ownerName || "",
        issues: [{ container: i.container, reason: i.type || i.reason, restarts: i.restarts || 0, message: i.message }],
      }));

    case "/api/namespaces": {
      const podsByNs = report.pods?.byNamespace || {};
      return (report.namespaces?.items || []).map(ns => {
        const nsName = ns.name;
        const nsPods = podsByNs[nsName] || {};
        const podCount = ns.podCount || nsPods.total || 0;
        const running = ns.running || nsPods.running || 0;
        const failed = ns.failed || nsPods.failed || 0;
        const pending = ns.pending || nsPods.pending || 0;
        let health = ns.health || "idle";
        if (!ns.health && podCount > 0) {
          if (failed > 0) health = "critical";
          else if (pending > 0) health = "pending";
          else health = "healthy";
        }
        return {
          name: nsName,
          status: ns.status || "Active",
          created: ns.created || "",
          podCount,
          running,
          failed,
          pending,
          health,
        };
      });
    }

    case "/api/cluster/operators":
      return (report.clusterOperators?.items || []).map(o => ({
        name: o.name,
        version: o.version || "",
        available: o.available !== false,
        degraded: o.degraded || false,
        progressing: o.progressing || false,
        health: o.degraded ? "degraded" : (o.available !== false ? (o.progressing ? "progressing" : "available") : "unavailable"),
        message: o.message || "",
      }));

    case "/api/alerts":
      return {
        alerts: (report.events?.recent || []).map(e => ({
          source: "events",
          name: e.reason,
          severity: "warning",
          namespace: e.namespace,
          resource: e.object,
          summary: e.message,
          since: e.lastSeen,
          count: e.count || 1,
        })),
        summary: { warning: report.events?.warnings || 0, critical: 0, info: 0 },
        ...meta,
      };

    case "/api/diag":
      return {
        clusterName: agent.clusterName || resolvedKey,
        platform: agent.platform,
        status: agent.status,
        nodeCount: report.nodes?.total,
        health: (() => { const d = report.clusterOperators?.degraded || 0; const t = report.nodes?.total || 0; const r = report.nodes?.ready || 0; return d > 0 ? "Degraded" : (r < t ? "Warning" : "Healthy"); })(),
        apiServerHealthy: true,
        summary: {
          nodes: report.nodes?.total || 0,
          pods: report.pods?.total || 0,
          issues: report.pods?.issues?.length || 0,
          warnings: report.events?.warnings || 0,
        },
        ...meta,
      };

    case "/api/dashboard/security": {
      const sec = report.security;
      if (!sec || sec.available === false) {
        return { source: "agent-cache", available: false, message: "Security scan not available from this agent" };
      }
      const grade = sec.score >= 90 ? "A" : sec.score >= 80 ? "B" : sec.score >= 70 ? "C" : sec.score >= 60 ? "D" : "F";
      const sevMap = { high: "critical", medium: "warning", low: "info" };
      const summary = {
        "pod-security": { fail: (sec.privilegedPods || 0) + (sec.runAsRootPods || 0), critical: sec.privilegedPods || 0, warning: sec.runAsRootPods || 0, pass: 0 },
        "network-security": { fail: sec.hostNetworkPods || 0, critical: sec.hostNetworkPods || 0, warning: 0, pass: 0 },
        "rbac-secrets": { fail: sec.clusterAdminBindings > 1 ? sec.clusterAdminBindings - 1 : 0, critical: 0, warning: sec.clusterAdminBindings > 1 ? sec.clusterAdminBindings - 1 : 0, pass: 0 },
        "image-security": { fail: report.imageVulns?.critical || 0, critical: report.imageVulns?.critical || 0, warning: report.imageVulns?.high || 0, pass: 0 },
      };
      return {
        score: sec.score, grade, scanTime: report.timestamp,
        findings: (sec.findings || []).slice(0, 5).map(f => ({ severity: sevMap[f.severity] || "info", msg: f.title })),
        summary,
        totals: { pass: 0, fail: (sec.findings || []).length, warning: 0 },
        podCount: sec.totalWorkloadPods || 0,
        namespaceCount: Object.keys(summary).length,
        ...meta,
      };
    }

    case "/api/dashboard/gitops": {
      const g = report.gitops;
      if (!g) return { source: "agent-cache", available: false, message: "GitOps data not available from this agent" };
      if (!g.installed) return { total: 0, synced: 0, outOfSync: 0, degraded: 0, healthy: 0, apps: [], unavailable: true, ...meta };
      return {
        total: g.totalApps || 0, synced: g.synced || 0, outOfSync: g.outOfSync || 0,
        degraded: g.degraded || 0, healthy: g.healthy || 0,
        apps: (g.apps || []).slice(0, 10).map(a => ({ name: a.name, sync: a.sync, health: a.health, repo: a.repo })),
        ...meta,
      };
    }

    case "/api/dashboard/dr": {
      const dr = report.dr;
      if (!dr) return { source: "agent-cache", available: false, message: "DR data not available from this agent" };
      if (!dr.installed) return { installed: false, score: 0, grade: "?", backups: 0, completed: 0, failed: 0, schedules: 0, activeSchedules: 0, storageLocations: 0, availableLocations: 0, lastBackup: null, lastBackupAge: null, ...meta };
      let lastBackupAge = null;
      if (dr.lastBackup) lastBackupAge = Math.floor((Date.now() - new Date(dr.lastBackup).getTime()) / 86400000);
      let score = 100;
      if (dr.schedules === 0) score -= 25;
      if (dr.completed === 0) score -= 25;
      else if (lastBackupAge != null && lastBackupAge > 7) score -= 15;
      if (dr.failed > 0) score -= Math.min(15, dr.failed * 5);
      score = Math.max(0, Math.round(score));
      const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
      return {
        installed: true, score, grade,
        backups: dr.totalBackups || 0, completed: dr.completed || 0, failed: dr.failed || 0,
        schedules: dr.schedules || 0, activeSchedules: dr.schedules || 0,
        storageLocations: dr.schedules > 0 ? 1 : 0, availableLocations: dr.schedules > 0 ? 1 : 0,
        lastBackup: dr.lastBackup || null, lastBackupAge,
        ...meta,
      };
    }

    case "/api/dashboard/optimization": {
      const opt = report.optimization;
      if (!opt || opt.available === false) {
        return { source: "agent-cache", available: false, message: "Optimization data not available from this agent" };
      }
      return {
        efficiencyScore: opt.efficiencyScore || 0,
        grade: opt.grade || "?",
        totalPods: opt.totalPods || 0,
        overProvisioned: opt.overProvisioned || 0,
        underProvisioned: opt.underProvisioned || 0,
        noLimits: opt.podsNoLimits || 0,
        noRequests: opt.podsNoRequests || 0,
        reclaimCpu: Math.round((opt.wastedCPUcores || 0) * 1000),
        reclaimMemGi: Math.round((opt.wastedMemGi || 0) * 10) / 10,
        reclaimStorageGi: 0,
        cpuHeadroom: opt.cpuHeadroom || 0,
        memHeadroom: opt.memHeadroom || 0,
        metricsAvailable: opt.metricsAvailable !== false,
        topProblems: opt.offenders || [],
        pvc: { total: 0, bound: 0, pending: 0, lost: 0, orphaned: 0, totalCapacityGi: 0, usedStorageGi: 0, allocatedUnusedGi: 0, orphanedStorageGi: 0, orphanedList: [], pvcDetails: [] },
        ...meta,
      };
    }

    case "/api/dashboard/image-vulns": {
      const iv = report.imageVulns;
      if (!iv) return { source: "agent-cache", available: false, message: "Image scan not available from this agent" };
      if (!iv.installed) {
        return { installed: false, unavailable: true, scannerType: null, riskScore: 100, grade: "A", totalImages: 0, totalVulns: 0, critical: 0, high: 0, medium: 0, low: 0, fixable: 0, maxCVSS: 0, topImages: [], compliance: {}, ageSummary: {}, ...meta };
      }
      const totalVulns = (iv.critical || 0) + (iv.high || 0) + (iv.medium || 0) + (iv.low || 0);
      // Risk score: start at 100, deduct heavily for critical/high
      let riskScore = 100 - Math.min(60, (iv.critical || 0) * 10) - Math.min(30, (iv.high || 0) * 3) - Math.min(10, (iv.medium || 0));
      riskScore = Math.max(0, riskScore);
      const grade = riskScore >= 90 ? "A" : riskScore >= 80 ? "B" : riskScore >= 70 ? "C" : riskScore >= 60 ? "D" : "F";
      return {
        installed: true, scannerType: iv.scanner,
        riskScore, grade, timestamp: report.timestamp,
        totalImages: iv.totalImages || 0, totalVulns,
        critical: iv.critical || 0, high: iv.high || 0, medium: iv.medium || 0, low: iv.low || 0,
        fixable: 0, maxCVSS: iv.critical > 0 ? 9.8 : iv.high > 0 ? 7.5 : iv.medium > 0 ? 5.0 : 0,
        topImages: (iv.images || []).slice(0, 20).map(im => ({ image: im.image, critical: im.critical || 0, high: im.high || 0, medium: im.medium || 0, cves: [] })),
        compliance: {}, ageSummary: {},
        ...meta,
      };
    }

    case "/api/dashboard/rbac": {
      const rbac = report.rbac;
      if (!rbac || rbac.available === false) {
        return { source: "agent-cache", available: false, message: "RBAC data not available from this agent" };
      }
      return {
        clusterRoleBindings: rbac.clusterRoleBindings || 0,
        clusterRoles: rbac.clusterRoles || 0,
        serviceAccounts: rbac.serviceAccounts || 0,
        clusterAdmins: rbac.clusterAdmins || [],
        ...meta,
      };
    }

    case "/api/workloads":
    case "/api/dashboard/workloads": {
      const w = report.workloads;
      if (!w) return { source: "agent-cache", available: false, message: "Workload data not available from this agent" };
      return {
        deployments: w.deployments || 0, statefulsets: w.statefulsets || 0,
        daemonsets: w.daemonsets || 0, services: w.services || 0,
        ingresses: w.ingresses || 0, routes: w.routes || 0,
        items: w.items || [],
        ...meta,
      };
    }

    default:
      return null;
  }
}

function esc(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function extractFromKubeconfig(raw) {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t.includes("apiVersion") || !(t.includes("clusters:") || t.includes("kind: Config"))) return null;

  let server = null, token = null;
  const lines = t.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!server && /^server:\s*.+/.test(s)) {
      server = s.replace(/^server:\s*/, "").replace(/^["']|["']$/g, "").trim();
    }
    if (!token && /^token:\s*.+/.test(s)) {
      token = s.replace(/^token:\s*/, "").replace(/^["']|["']$/g, "").trim();
    }
  }
  if (!server && !token) return null;
  return { server, token };
}

function isBlockedUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (host === "0.0.0.0" || host.startsWith("169.254.") || host === "metadata.google.internal") return true;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host) && !process.env.ALLOW_PRIVATE_CLUSTER_IPS) return true;
    return false;
  } catch { return true; }
}

// TLS-tolerant fetch for cluster-facing connections (handles self-signed certs)
async function clusterFetch(url, opts = {}) {
  const { signal, headers = {} } = opts;
  const u = new URL(url);
  if (u.protocol === "https:") {
    const { default: https } = await import("node:https");
    return new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers,
        rejectUnauthorized: false,
        timeout: 10000,
      };
      const req = https.request(reqOpts, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            text: () => Promise.resolve(body),
            json: () => Promise.resolve(JSON.parse(body)),
          });
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      if (signal) signal.addEventListener("abort", () => { req.destroy(); reject(new Error("aborted")); }, { once: true });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }
  return fetch(url, opts);
}

function generatePreflightHTML(report, ticketNumber, fields) {
  const checks = report.checks || [];
  const ts = report.timestamp ? new Date(report.timestamp).toLocaleString() : new Date().toLocaleString();
  const fromVer = report.fromVersion || "N/A";
  const toVer = report.targetVersion || "N/A";
  const status = report.overallStatus || "UNKNOWN";
  const statusColor = status === "READY" ? "#22c55e" : status === "READY_WITH_WARNINGS" ? "#f59e0b" : "#ef4444";
  const vd = report.versionDelta || {};
  const nt = report.nodeTopology || {};

  const tdS = 'style="padding:8px 12px;border-bottom:1px solid #e5e7eb"';
  const tdSm = 'style="padding:6px 10px;border-bottom:1px solid #e5e7eb"';

  const checkRows = checks.map(c => {
    const sc = c.status === "pass" ? "#22c55e" : c.status === "warning" ? "#f59e0b" : "#ef4444";
    const icon = c.status === "pass" ? "&#x2705;" : c.status === "warning" ? "&#x26A0;&#xFE0F;" : "&#x274C;";
    return `<tr><td ${tdS}><span style="color:${sc}">${icon}</span></td><td ${tdS}><b>${esc(c.category)}</b></td><td ${tdS}>${esc(c.details)}</td><td ${tdS} style="font-size:12px;color:#6b7280">${esc(c.recommendation || "")}</td></tr>`;
  }).join("");

  const clusterOpsRows = (report.allClusterOperators || []).map(o => {
    const avail = o.available ? '<span style="color:#22c55e">&#x2705; Yes</span>' : '<span style="color:#ef4444">&#x274C; NO</span>';
    const deg = o.degraded ? '<span style="color:#ef4444">&#x274C; YES</span>' : '<span style="color:#22c55e">No</span>';
    return `<tr><td ${tdSm}>${esc(o.name)}</td><td ${tdSm}>${esc(o.version || "-")}</td><td ${tdSm}>${avail}</td><td ${tdSm}>${deg}</td></tr>`;
  }).join("");

  const olmOpsRows = (report.allOLMOperators || []).map(o => {
    const compat = o.compatible === "yes" ? '<span style="color:#22c55e">&#x2705;</span>' : o.compatible === "no" ? '<span style="color:#ef4444">&#x274C;</span>' : '<span style="color:#f59e0b">&#x2753;</span>';
    return `<tr><td ${tdSm}>${esc(o.name)}</td><td ${tdSm}>${esc(o.version || "-")}</td><td ${tdSm}>${esc(o.namespace || "-")}</td><td ${tdSm}>${esc(o.channel || o.source || "-")}</td><td ${tdSm}>${esc(o.status || "-")}</td><td ${tdSm}>${compat}</td></tr>`;
  }).join("");

  // Operator upgrade impact — operators that need action before/after upgrade
  const opsNeedingAction = (report.allOLMOperators || []).filter(o => o.compatible !== "yes");
  const degradedClusterOps = (report.allClusterOperators || []).filter(o => o.degraded || !o.available);
  const upgradeImpactRows = [
    ...degradedClusterOps.map(o => `<tr><td ${tdSm}><strong>${esc(o.name)}</strong></td><td ${tdSm}>Cluster Operator</td><td ${tdSm}>${esc(o.version || "-")}</td><td ${tdSm} style="color:#ef4444;font-weight:600">${o.degraded ? "Degraded" : "Unavailable"}</td><td ${tdSm} style="color:#ef4444">Must resolve before upgrade</td></tr>`),
    ...opsNeedingAction.map(o => {
      const iColor = o.compatible === "no" ? "#ef4444" : "#f59e0b";
      const action = o.compatible === "no" ? "Must upgrade operator first" : "Verify compatibility";
      return `<tr><td ${tdSm}><strong>${esc(o.name)}</strong></td><td ${tdSm}>OLM Operator</td><td ${tdSm}>${esc(o.version || "-")}</td><td ${tdSm} style="color:${iColor};font-weight:600">${esc(o.issue || (o.compatible === "no" ? "Incompatible" : "Unknown"))}</td><td ${tdSm} style="color:${iColor}">${action}</td></tr>`;
    }),
  ].join("");

  // Node topology table
  const nodeRows = (nt.nodeDetails || []).map(n => {
    const readyColor = n.ready ? "#22c55e" : "#ef4444";
    return `<tr><td ${tdSm}>${esc(n.name)}</td><td ${tdSm}>${esc(n.role)}</td><td ${tdSm}>${esc(n.kubeletVersion || "-")}</td><td ${tdSm}>${esc(n.osImage || "-")}</td><td ${tdSm}><span style="color:${readyColor};font-weight:600">${n.ready ? "Ready" : "NOT READY"}</span></td></tr>`;
  }).join("");

  // Feature highlights
  const featuresHTML = (vd.featureHighlights || []).map(fg => {
    const items = (fg.features || []).map(f => `<li>${esc(f)}</li>`).join("");
    return `<div style="margin-bottom:12px"><strong style="color:#1e40af">OCP ${esc(fg.version)}</strong><ul style="margin:4px 0 0 0;padding-left:20px">${items}</ul></div>`;
  }).join("");

  // API changes
  const apiRemovals = vd.apiRemovals || {};
  let apiHTML = "";
  if (apiRemovals.removed?.length > 0 || apiRemovals.deprecated?.length > 0) {
    apiHTML = `<h2>&#x1F6A8; API Changes Between Versions</h2>`;
    if (apiRemovals.removed?.length > 0) {
      apiHTML += `<h3 style="color:#ef4444;font-size:14px">Removed APIs (must migrate)</h3><table><tr><th>API Group/Version</th><th>Affected Kinds</th><th>Replacement</th></tr>`;
      apiHTML += apiRemovals.removed.map(a => `<tr><td ${tdSm} style="color:#ef4444;font-weight:600">${esc(a.api)}</td><td ${tdSm}>${esc((a.kinds || []).join(", "))}</td><td ${tdSm}>${esc(a.replacement)}</td></tr>`).join("");
      apiHTML += `</table>`;
    }
    if (apiRemovals.deprecated?.length > 0) {
      apiHTML += `<h3 style="color:#f59e0b;font-size:14px">Deprecated APIs (plan migration)</h3><table><tr><th>API</th><th>Issue</th><th>Replacement</th></tr>`;
      apiHTML += apiRemovals.deprecated.slice(0, 15).map(a => `<tr><td ${tdSm}>${esc(a.name)}</td><td ${tdSm}>${esc(a.issue || "")}</td><td ${tdSm}>${esc(a.replacement || "check docs")}</td></tr>`).join("");
      apiHTML += `</table>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pre-Upgrade Assessment Report — ${esc(ticketNumber)} — OCP ${esc(fromVer)} → ${esc(toVer)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 32px; color: #1f2937; background: #fff; line-height: 1.5; }
  h1 { font-size: 24px; margin-bottom: 4px; color: #111827; }
  h2 { font-size: 17px; margin-top: 32px; margin-bottom: 10px; border-bottom: 2px solid #2563eb; padding-bottom: 6px; color: #1e40af; }
  h3 { font-size: 14px; margin-top: 16px; margin-bottom: 6px; }
  .header-bar { background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%); color: #fff; padding: 24px 32px; border-radius: 12px; margin-bottom: 24px; }
  .header-bar h1 { color: #fff; margin: 0 0 8px; font-size: 22px; }
  .header-bar .meta { color: rgba(255,255,255,.8); font-size: 12px; margin: 0; }
  .meta a { color: inherit; }
  .status-badge { display: inline-block; padding: 5px 16px; border-radius: 20px; font-weight: 700; font-size: 13px; color: #fff; }
  .version-grid { display: grid; grid-template-columns: 1fr 60px 1fr; gap: 0; margin: 20px 0; align-items: center; }
  .ver-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px; text-align: center; }
  .ver-card .ver-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; margin-bottom: 6px; }
  .ver-card .ver-num { font-size: 26px; font-weight: 800; color: #111827; }
  .ver-card .ver-sub { font-size: 11px; color: #6b7280; margin-top: 4px; }
  .ver-arrow { text-align: center; font-size: 28px; color: #2563eb; font-weight: 700; }
  .summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 16px 0; }
  .summary-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 10px; text-align: center; }
  .summary-card .num { font-size: 26px; font-weight: 700; }
  .summary-card .lbl { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: .5px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 16px; }
  th { text-align: left; padding: 8px 12px; background: #f0f4ff; border-bottom: 2px solid #c7d2fe; font-size: 11px; text-transform: uppercase; letter-spacing: .3px; color: #374151; }
  td { vertical-align: top; }
  .plan-section { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px; margin: 14px 0; }
  .plan-section h3 { margin-top: 0; color: #1e40af; font-size: 14px; }
  .plan-section pre { white-space: pre-wrap; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; line-height: 1.6; margin: 0; color: #374151; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 12px 0; }
  .info-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
  .info-card .info-label { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #6b7280; margin-bottom: 4px; }
  .info-card .info-value { font-size: 14px; font-weight: 600; color: #111827; }
  .footer { margin-top: 40px; padding-top: 14px; border-top: 2px solid #e5e7eb; font-size: 11px; color: #9ca3af; text-align: center; }
  @media print { body { padding: 12px; } .header-bar { break-inside: avoid; } table { page-break-inside: auto; } tr { page-break-inside: avoid; } }
</style>
</head>
<body>

<div class="header-bar">
  <h1>&#x1F6E1; OpenShift Cluster Pre-Upgrade Assessment Report</h1>
  <div class="meta">
    Change Request: <strong>${esc(ticketNumber)}</strong> &nbsp;&bull;&nbsp;
    Generated: ${esc(ts)} &nbsp;&bull;&nbsp;
    Cluster ID: ${esc(report.clusterID || "N/A")} &nbsp;&bull;&nbsp;
    Channel: ${esc(report.channel || "N/A")}
  </div>
</div>

<!-- ═══ VERSION COMPARISON ═══ -->
<h2>&#x1F504; Version Comparison</h2>
<div class="version-grid">
  <div class="ver-card">
    <div class="ver-label">Current Version</div>
    <div class="ver-num">${esc(fromVer)}</div>
    <div class="ver-sub">Kubernetes ${esc(vd.kubeFrom || "N/A")}</div>
  </div>
  <div class="ver-arrow">&rarr;</div>
  <div class="ver-card" style="border-color:#2563eb">
    <div class="ver-label" style="color:#2563eb">Target Version</div>
    <div class="ver-num" style="color:#2563eb">${esc(toVer)}</div>
    <div class="ver-sub">Kubernetes ${esc(vd.kubeTo || "N/A")}</div>
  </div>
</div>

<table style="margin:20px 0">
  <tr><th style="width:30%">Component</th><th style="width:30%">Present Version</th><th style="width:10%;text-align:center">&#x2192;</th><th style="width:30%">Requested Version</th></tr>
  <tr><td ${tdS}><strong>OpenShift Container Platform</strong></td><td ${tdS}>${esc(fromVer)}</td><td ${tdS} style="text-align:center;color:#2563eb;font-size:16px">&#x2192;</td><td ${tdS} style="font-weight:700;color:#2563eb">${esc(toVer)}</td></tr>
  <tr><td ${tdS}><strong>Kubernetes</strong></td><td ${tdS}>${esc(vd.kubeFrom || "N/A")}</td><td ${tdS} style="text-align:center;color:#2563eb;font-size:16px">&#x2192;</td><td ${tdS} style="font-weight:700">${esc(vd.kubeTo || "N/A")}</td></tr>
  <tr><td ${tdS}><strong>CRI-O Runtime</strong></td><td ${tdS}>${esc(vd.kubeFrom || "N/A")}</td><td ${tdS} style="text-align:center;color:#2563eb;font-size:16px">&#x2192;</td><td ${tdS} style="font-weight:700">${esc(vd.criO || "N/A")}</td></tr>
  <tr><td ${tdS}><strong>RHEL Base OS</strong></td><td ${tdS} colspan="3">${esc(vd.rhelBase || "RHEL CoreOS")}</td></tr>
  <tr><td ${tdS}><strong>Upgrade Type</strong></td><td ${tdS} colspan="3">${esc(report.upgradeType || "N/A")}</td></tr>
  <tr><td ${tdS}><strong>Update Channel</strong></td><td ${tdS} colspan="3">${esc(report.channel || "N/A")}</td></tr>
  <tr><td ${tdS}><strong>Cluster Nodes</strong></td><td ${tdS} colspan="3">${nt.total || 0} total (${nt.masters || 0} control-plane, ${nt.workers || 0} worker${nt.infra ? ", " + nt.infra + " infra" : ""})</td></tr>
  <tr><td ${tdS}><strong>Estimated Duration</strong></td><td ${tdS} colspan="3">${esc(vd.estimatedDuration || "~1-2 hours")}</td></tr>
  <tr><td ${tdS}><strong>Kubernetes Version Skew</strong></td><td ${tdS} colspan="3">${vd.kubeSkew || 0} minor version${(vd.kubeSkew || 0) !== 1 ? "s" : ""}</td></tr>
  <tr><td ${tdS} style="font-weight:700">Overall Readiness</td><td ${tdS} colspan="3"><span class="status-badge" style="background:${statusColor}">${esc(status)}</span></td></tr>
</table>

${upgradeImpactRows ? `<!-- ═══ UPGRADE IMPACT ═══ -->
<h2>&#x26A0;&#xFE0F; Operators Requiring Action (${degradedClusterOps.length + opsNeedingAction.length})</h2>
<table>
  <tr><th>Operator</th><th>Type</th><th>Current Version</th><th>Issue</th><th>Required Action</th></tr>
  ${upgradeImpactRows}
</table>` : ""}

<!-- ═══ WHAT'S NEW ═══ -->
${featuresHTML ? `<h2>&#x2728; What's New Between Versions</h2>${featuresHTML}` : ""}

${apiHTML}

<!-- ═══ ASSESSMENT SUMMARY ═══ -->
<h2>&#x1F4CB; Pre-Upgrade Assessment (${checks.length} Checks)</h2>
<div class="summary-grid">
  <div class="summary-card"><div class="num" style="color:#22c55e">${report.summary?.pass || 0}</div><div class="lbl">Passed</div></div>
  <div class="summary-card"><div class="num" style="color:#f59e0b">${report.summary?.warning || 0}</div><div class="lbl">Warnings</div></div>
  <div class="summary-card"><div class="num" style="color:#ef4444">${report.summary?.fail || 0}</div><div class="lbl">Failed</div></div>
  <div class="summary-card"><div class="num">${report.summary?.total || checks.length}</div><div class="lbl">Total</div></div>
  <div class="summary-card"><div class="num" style="color:${statusColor}">${status === "READY" ? "GO" : status === "READY_WITH_WARNINGS" ? "WARN" : "NO-GO"}</div><div class="lbl">Decision</div></div>
</div>

<table>
  <tr><th style="width:40px">Status</th><th style="width:180px">Category</th><th>Details</th><th style="width:240px">Recommendation</th></tr>
  ${checkRows}
</table>

<!-- ═══ CLUSTER OPERATORS ═══ -->
<h2>&#x2699; Cluster Operators (${(report.allClusterOperators || []).length})</h2>
<table>
  <tr><th>Operator</th><th>Version</th><th>Available</th><th>Degraded</th></tr>
  ${clusterOpsRows}
</table>

<!-- ═══ OLM OPERATORS ═══ -->
<h2>&#x1F4E6; Installed Operators — OLM (${(report.allOLMOperators || []).length})</h2>
${olmOpsRows ? `<table>
  <tr><th>Operator</th><th>Version</th><th>Namespace</th><th>Channel</th><th>Status</th><th>Compatible</th></tr>
  ${olmOpsRows}
</table>` : '<p style="color:#6b7280;font-style:italic">No OLM-managed operators detected.</p>'}

<!-- ═══ NODE TOPOLOGY ═══ -->
<h2>&#x1F5A5; Node Topology (${nt.total || "N/A"} nodes)</h2>
<div class="info-grid">
  <div class="info-card"><div class="info-label">Control Plane</div><div class="info-value">${nt.masters || 0} nodes</div></div>
  <div class="info-card"><div class="info-label">Worker</div><div class="info-value">${nt.workers || 0} nodes</div></div>
  ${nt.infra ? `<div class="info-card"><div class="info-label">Infrastructure</div><div class="info-value">${nt.infra} nodes</div></div>` : ""}
  <div class="info-card"><div class="info-label">Total</div><div class="info-value">${nt.total || 0} nodes</div></div>
</div>
${nodeRows ? `<table>
  <tr><th>Node Name</th><th>Role</th><th>Kubelet Version</th><th>OS Image</th><th>Status</th></tr>
  ${nodeRows}
</table>` : ""}

<!-- ═══ IMPLEMENTATION PLAN ═══ -->
${fields?.implementationPlan ? `<h2>&#x1F4DD; Implementation Plan</h2>
<div class="plan-section"><pre>${esc(fields.implementationPlan)}</pre></div>` : ""}

<!-- ═══ IMPACT ASSESSMENT ═══ -->
${fields?.impact ? `<h2>&#x1F4A5; Impact Assessment</h2>
<div class="plan-section"><pre>${esc(fields.impact)}</pre></div>` : ""}

<!-- ═══ BACKOUT PLAN ═══ -->
${fields?.rollback ? `<h2>&#x21A9; Backout / Rollback Plan</h2>
<div class="plan-section"><pre>${esc(fields.rollback)}</pre></div>` : ""}

<!-- ═══ TESTING PLAN ═══ -->
${fields?.validation ? `<h2>&#x1F9EA; Testing / Validation Plan</h2>
<div class="plan-section"><pre>${esc(fields.validation)}</pre></div>` : ""}

<!-- ═══ BUSINESS JUSTIFICATION ═══ -->
${fields?.justification ? `<h2>&#x1F4BC; Business Justification</h2>
<div class="plan-section"><pre>${esc(fields.justification)}</pre></div>` : ""}

<!-- ═══ REFERENCES ═══ -->
<h2>&#x1F517; References</h2>
<div class="info-grid">
  ${vd.releaseNotesURL ? `<div class="info-card"><div class="info-label">Release Notes</div><div class="info-value" style="font-size:12px;word-break:break-all"><a href="${esc(vd.releaseNotesURL)}" style="color:#2563eb">${esc(vd.releaseNotesURL)}</a></div></div>` : ""}
  ${vd.errataURL ? `<div class="info-card"><div class="info-label">Errata / Advisories</div><div class="info-value" style="font-size:12px;word-break:break-all"><a href="${esc(vd.errataURL)}" style="color:#2563eb">${esc(vd.errataURL)}</a></div></div>` : ""}
  <div class="info-card"><div class="info-label">OCP Life Cycle Policy</div><div class="info-value" style="font-size:12px"><a href="https://access.redhat.com/support/policy/updates/openshift" style="color:#2563eb">Red Hat OpenShift Life Cycle</a></div></div>
  <div class="info-card"><div class="info-label">Support</div><div class="info-value" style="font-size:12px"><a href="https://access.redhat.com/support/cases" style="color:#2563eb">Red Hat Support Cases</a></div></div>
</div>

<div class="footer">
  Generated by <strong>TCS Agentic AI</strong> &mdash; Enterprise Intelligence Platform &mdash; ${esc(ts)}<br>
  This report was auto-generated from a live ${checks.length}-point cluster assessment and attached to ServiceNow ${esc(ticketNumber)}.
</div>
</body>
</html>`;
}

/**
 * Parse a kubectl/oc command to extract namespace, resource name, and a
 * short summary. Used by the learning loop to associate fixes with incidents.
 */
function parseCommandTarget(command) {
  const out = { namespace: "", name: "", verb: "", resource: "", summary: "" };
  if (!command) return out;
  const tokens = String(command).trim().split(/\s+/);
  // Skip cli word
  if (tokens[0] === "kubectl" || tokens[0] === "oc") tokens.shift();
  out.verb = tokens[0] || "";
  // -n / --namespace
  for (let i = 1; i < tokens.length - 1; i++) {
    if (tokens[i] === "-n" || tokens[i] === "--namespace") {
      out.namespace = tokens[i + 1];
    }
  }
  // Resource + name = first 1-2 positional after verb
  if (out.verb === "rollout") {
    out.resource = tokens[2] || "";
    out.name = tokens[3] || "";
  } else if (out.verb === "patch" || out.verb === "delete" || out.verb === "scale" || out.verb === "describe" || out.verb === "logs") {
    out.resource = tokens[1] || (out.verb === "logs" ? "pod" : "");
    out.name = (out.verb === "logs") ? (tokens[1] || "") : (tokens[2] || "");
  }
  out.summary = `${out.verb} ${out.resource ? out.resource + "/" : ""}${out.name || ""}`.trim();
  return out;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB for file uploads

async function readRawBody(req, maxBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); return reject(new Error("Upload too large")); }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  if (!boundaryMatch) throw new Error("No multipart boundary found");
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const sep = Buffer.from("--" + boundary);
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf(sep, start);
    if (idx === -1) break;
    if (start > 0) {
      const chunk = buffer.slice(start, idx);
      const headerEnd = chunk.indexOf("\r\n\r\n");
      if (headerEnd > 0) {
        const headerStr = chunk.slice(0, headerEnd).toString();
        const body = chunk.slice(headerEnd + 4, chunk.length - 2);
        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const fileMatch = headerStr.match(/filename="([^"]+)"/);
        parts.push({ name: nameMatch?.[1], filename: fileMatch?.[1], data: body, headers: headerStr });
      }
    }
    start = idx + sep.length + 2;
    if (buffer.slice(idx + sep.length, idx + sep.length + 2).toString() === "--") break;
  }
  return parts;
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error("Request body too large"));
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function handleChatHistoryAPI(url, req, res) {
  if (!(await isHistoryEnabled())) {
    return sendJson(res, 503, {
      error: "Chat history is not enabled. Set DATABASE_URL to persist conversations.",
      enabled: false,
    });
  }

  // /api/chats/search?q=term&cluster=<name>
  if (url.pathname === "/api/chats/search" && req.method === "GET") {
    const q = url.searchParams.get("q") || "";
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const rawCluster = url.searchParams.get("cluster") || null;
    const cluster = rawCluster ? (validateClusterParam(rawCluster) || rawCluster) : null;
    const results = await searchChats(q, limit, cluster);
    return sendJson(res, 200, { results });
  }

  // /api/chats?cluster=<name>  (cluster scopes the list; "all" or omitted = all clusters)
  if (url.pathname === "/api/chats") {
    if (req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "100", 10);
      const rawCluster = url.searchParams.get("cluster") || null;
      const cluster = rawCluster ? (validateClusterParam(rawCluster) || rawCluster) : null;
      const chats = await listChats(limit, cluster);
      return sendJson(res, 200, { chats });
    }
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const validatedCluster = validateClusterParam(body.cluster) || "local";
        const chat = await createChat({ id: body.id, title: body.title, cluster: validatedCluster });
        return sendJson(res, 201, chat);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  // /api/chats/:id
  const m = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (req.method === "GET") {
      const chat = await getChat(id);
      if (!chat) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, chat);
    }
    if (req.method === "DELETE") {
      const force = url.searchParams.get("force") === "true";
      const locked = await isLocked(id);
      if (locked && !force) {
        return sendJson(res, 423, {
          error: "Chat is locked. Pass ?force=true to delete a locked chat.",
          locked: true,
        });
      }
      const ok = await deleteChat(id);
      return sendJson(res, ok ? 200 : 404, { success: ok });
    }
    if (req.method === "PATCH") {
      try {
        const body = await readJsonBody(req);
        if (body.title) {
          const ok = await updateTitle(id, body.title);
          return sendJson(res, ok ? 200 : 404, { success: ok });
        }
        if (typeof body.starred === "boolean") {
          const ok = await updateStarred(id, body.starred);
          return sendJson(res, ok ? 200 : 404, { success: ok, starred: body.starred });
        }
        if (typeof body.locked === "boolean") {
          const ok = await updateLocked(id, body.locked);
          return sendJson(res, ok ? 200 : 404, { success: ok, locked: body.locked });
        }
        return sendJson(res, 400, { error: "No fields to update" });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  // /api/chats/:id/messages  (add a new message to a conversation)
  const ma = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (ma) {
    const chatId = decodeURIComponent(ma[1]);
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        if (Array.isArray(body.messages)) {
          const ok = await replaceAllMessages(chatId, body.messages, body.cluster);
          return sendJson(res, ok ? 200 : 400, { success: ok });
        }
        if (!body.role || !body.content) return sendJson(res, 400, { error: "role and content required" });
        const result = await addMessage(chatId, {
          role: body.role,
          content: body.content,
          html: body.html || null,
          provider: body.provider || null,
        });
        return sendJson(res, result ? 201 : 400, result || { error: "Failed to add message" });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  // /api/chats/:id/messages/replace  (search & replace by content substring)
  const mr = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/replace$/);
  if (mr) {
    const chatId = decodeURIComponent(mr[1]);
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        if (!body.search || !body.content) return sendJson(res, 400, { error: "search and content required" });
        const ok = await replaceMessageContent(chatId, body.search, body.content);
        return sendJson(res, ok ? 200 : 404, { success: ok });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  // /api/chats/:id/messages/:msgId
  const mm = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/(\d+)$/);
  if (mm) {
    const chatId = decodeURIComponent(mm[1]);
    const msgId = Number(mm[2]);
    if (req.method === "PATCH") {
      try {
        const body = await readJsonBody(req);
        if (!body.content) return sendJson(res, 400, { error: "content required" });
        const ok = await updateMessage(chatId, msgId, { content: body.content, html: body.html });
        return sendJson(res, ok ? 200 : 404, { success: ok });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  return sendJson(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------------------
// /api/cr — CR tracking API (backed by cr-tracker service)
// ---------------------------------------------------------------------------
async function handleCRTrackingAPI(url, req, res) {
  // POST /api/cr/backfill — import historical CRs from executed_actions
  if (url.pathname === "/api/cr/backfill" && req.method === "POST") {
    try {
      const result = await backfillFromAuditTrail();
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // POST /api/cr/sync-all — sync all pending CRs from ServiceNow
  if (url.pathname === "/api/cr/sync-all" && req.method === "POST") {
    try {
      const results = await syncAllPendingCRs();
      return sendJson(res, 200, { results });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // GET /api/cr/pending — list CRs with pending status
  if (url.pathname === "/api/cr/pending" && req.method === "GET") {
    try {
      const crCluster = url.searchParams.get("cluster") || undefined;
      const crs = await getPendingCRs({ cluster: crCluster });
      return sendJson(res, 200, { crs });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // POST /api/cr/:ticketId/sync — sync a single CR from ServiceNow
  const syncMatch = url.pathname.match(/^\/api\/cr\/([^/]+)\/sync$/);
  if (syncMatch && req.method === "POST") {
    try {
      const ticketId = decodeURIComponent(syncMatch[1]);
      const result = await syncCRFromServiceNow(ticketId);
      return sendJson(res, 200, { result });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // GET /api/cr/:ticketId — get a single CR
  const idMatch = url.pathname.match(/^\/api\/cr\/([^/]+)$/);
  if (idMatch && req.method === "GET") {
    try {
      const ticketId = decodeURIComponent(idMatch[1]);
      const cr = await getCR(ticketId);
      if (!cr) return sendJson(res, 404, { error: "CR not found" });
      return sendJson(res, 200, { cr });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // DELETE /api/cr/:ticketId — dismiss/remove a CR
  if (idMatch && req.method === "DELETE") {
    try {
      const ticketId = decodeURIComponent(idMatch[1]);
      const permanent = url.searchParams.get("permanent") === "true";
      if (permanent) {
        const ok = await deleteCR(ticketId);
        return sendJson(res, ok ? 200 : 404, { success: ok });
      }
      const result = await dismissCR(ticketId);
      return sendJson(res, result.ok ? 200 : 404, {
        success: result.ok,
        snowCancelled: result.snowCancelled || false,
        snowError: result.snowError || null,
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // PATCH /api/cr/:ticketId — update CR status
  if (idMatch && req.method === "PATCH") {
    try {
      const ticketId = decodeURIComponent(idMatch[1]);
      const body = await readJsonBody(req);
      await updateCRStatus(ticketId, body.status, {
        metadata: body.metadata || {},
        scheduledDate: body.scheduledDate || undefined,
      });
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // GET /api/cr — list CRs with optional filters
  if (url.pathname === "/api/cr" && req.method === "GET") {
    try {
      const status = url.searchParams.get("status") || undefined;
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const crCluster = url.searchParams.get("cluster") || undefined;
      const crs = await listCRs({ status, limit, cluster: crCluster });
      return sendJson(res, 200, { crs });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  return sendJson(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------------------
// /api/actions — approval workflow for mutating operations.
// The chat handler queues pending actions; this API exposes them so the
// dashboard can list / confirm / cancel / execute.
// ---------------------------------------------------------------------------
async function handleActionsAPI(url, req, res) {
  // GET /api/actions?conversationId=...
  if (url.pathname === "/api/actions" && req.method === "GET") {
    const conversationId = url.searchParams.get("conversationId") || null;
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const actions = await listActions(conversationId, limit);
    return sendJson(res, 200, {
      actions,
      serviceNowEnabled: isServiceNowEnabled(),
    });
  }

  // /api/actions/:id[/<op>]
  const m = url.pathname.match(/^\/api\/actions\/([^/]+)(?:\/([a-z]+))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const op = m[2] || null;

    if (!op && req.method === "GET") {
      const act = await getAction(id);
      if (!act) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, { action: act });
    }

    if (op === "confirm" && req.method === "POST") {
      const r = await confirmAction(id);
      if (r.error) return sendJson(res, 400, r);
      // If auto-approved (SNOW disabled), execute right away so the user gets
      // a single round-trip confirm -> executed.
      if (r.action?.status === "approved") {
        const exec = await executeAction(id);
        return sendJson(res, 200, exec);
      }
      return sendJson(res, 200, r);
    }

    if (op === "cancel" && req.method === "POST") {
      const r = await cancelAction(id);
      if (r.error) return sendJson(res, 400, r);
      return sendJson(res, 200, r);
    }

    if (op === "execute" && req.method === "POST") {
      const r = await executeAction(id);
      if (r.error) return sendJson(res, 400, r);
      return sendJson(res, 200, r);
    }

    if (op === "refresh" && req.method === "POST") {
      const r = await refreshFromServiceNow(id);
      if (r.error) return sendJson(res, 400, r);
      return sendJson(res, 200, r);
    }

    return sendJson(res, 405, { error: "Method not allowed" });
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function startSSE() {
  const PORT = parseInt(process.env.MCP_SERVER_PORT, 10) || 3000;

  // Load configuration, safety flags, and multi-cluster context
  try { loadConfig(); } catch (e) { console.warn("[startup] config load:", e.message); }
  initSafety();
  initTelemetry();
  console.log(`[startup] access level: ${getAccessLevel()}`);
  console.log(`[startup] ${getComponentSummary()}`);
  try { await loadKubeconfig(); } catch (e) { console.warn("[startup] kubeconfig:", e.message); }

  // Initialize optional persistence layers (graceful fallback if not configured)
  await Promise.all([initDb(), initCache()]);

  // Detect Kubernetes platform (OpenShift, EKS, AKS, GKE, vanilla K8s)
  try { await initPlatform({ ocpGet, ocpPost, ocpPatch, ocpDelete, ocpFetch }); console.error("[platform] Detected:", getPlatform()); } catch(e) { console.error("[platform] Detection failed, defaulting to kubernetes"); }

  // Pre-populate cluster digest for faster first chat response
  try {
    const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version").catch(() => null);
    const nodes = await ocpGet("/api/v1/nodes").catch(() => null);
    const ver = cv?.status?.desired?.version || (await ocpGet("/version").catch(() => ({}))).gitVersion;
    updateClusterDigest({
      cluster: "local",
      version: ver,
      channel: cv?.spec?.channel,
      platform: getPlatform() || "kubernetes",
      nodeCount: nodes?.items?.length,
      readyNodes: nodes?.items?.filter((n) => (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True")).length,
    });
    console.error("[startup] Cluster digest pre-populated");
  } catch (e) { console.error("[startup] Cluster digest pre-populate skipped:", e.message); }

  // Initialize MCP Hub — load saved server configs and auto-reconnect
  try {
    await hubLoadAndReconnect();
    console.log(`[startup] MCP Hub initialized — ${hubGetToolCount()} tools available`);
  } catch (err) {
    console.warn("[startup] MCP Hub init:", err.message);
  }

  // Restore tracked namespaces from ConfigMap / DB before starting monitors
  try {
    await initTrackedNamespaces();
    const ns = getWatchedNamespaces();
    if (ns.length > 0) console.log(`[startup] Restored ${ns.length} tracked namespace(s)`);
  } catch (err) {
    console.warn("[startup] Tracked namespace restore:", err.message);
  }

  // Initialize RBAC, SLO definitions, and capacity tracking
  try {
    await loadUserRoles();
    await loadSLOs();
    await loadPolicies();
    await loadChannels();
    await initAuditLog();
    await initQueryTracer();
    await initIncidentManager();
    await initChangeTimeline();
    captureCapacitySnapshot().catch(() => {});
    setInterval(() => captureCapacitySnapshot().catch(() => {}), 3600000);
    setTimeout(() => {
      runComplianceScan().then(() => console.log("[compliance] Initial CIS scan complete")).catch(() => {});
    }, 15000);
    setInterval(() => runComplianceScan().catch(() => {}), 900000);
    console.log("[startup] RBAC, SLOs, policies, notifications, audit loaded; capacity (hourly), compliance (15m)");
  } catch (err) {
    console.warn("[startup] RBAC/SLO/Capacity init:", err.message);
  }

  // Initialize AI Intelligence features
  try {
    await initKnowledgeBase();
    await initLearningEngine();
    await initAutomationRules();
    startProactiveMonitor();
    console.log("[startup] AI Intelligence: proactive monitor, knowledge base, learning engine, automation rules — active");
  } catch (err) {
    console.warn("[startup] AI Intelligence init:", err.message);
  }

  // Restore registered clusters from DB, then prune any whose spoke pod is
  // no longer reachable (prevents ghost cards after a fresh management-bundle
  // deploy where the MCP agent hasn't been deployed yet).
  await loadClustersFromDB();
  await loadClusterCreds();
  await pruneUnreachableSpokes();
  // Restore this cluster's own MCP agent registration (probed before trust) —
  // otherwise a control-plane restart drops it until the agent's next heartbeat.
  await restoreHubAgentSpoke();

  // Phase 1: hydrate per-cluster snapshots so the dashboard has warm data
  // immediately after a hub restart (no waiting for the next agent report).
  if (CLUSTER_STORE_ENABLED) {
    try {
      const snapshots = await loadAllClusterSnapshots();
      let hydrated = 0;
      for (const snap of snapshots) {
        const key = findClusterKey(snap.cluster) || snap.cluster;
        const agent = _connectedAgents.get(key);
        if (!agent) continue; // skip snapshots for pruned/unregistered clusters
        // Only hydrate if we don't already have a fresher in-memory report.
        if (!agent.lastReport || !agent.lastReportTime ||
            new Date(snap.reportedAt).getTime() > new Date(agent.lastReportTime).getTime()) {
          agent.lastReport = snap.report;
          agent.lastReportTime = snap.reportedAt;
          if (!agent.platform) agent.platform = snap.platform;
          _connectedAgents.set(key, agent);
          hydrated++;
        }
      }
      if (hydrated > 0) console.log(`[startup] Hydrated ${hydrated} cluster snapshot(s) from store`);
    } catch (e) {
      console.warn("[startup] snapshot hydration failed:", e.message);
    }
  }

  // Restore ServiceNow settings from DB/file into process.env
  try {
    await restoreServiceNowSettings();
  } catch (e) { console.warn("[startup] ServiceNow settings restore:", e.message); }

  // Restore incident-automation policy (autonomous on/off, ServiceNow queue,
  // chronic window, severity floor, rate limit) so operator changes made in the
  // UI survive a pod restart without touching the Deployment.
  try {
    const { restoreIncidentSettings } = await import("./services/incident-settings.js");
    await restoreIncidentSettings();
  } catch (e) { console.warn("[startup] incident settings restore:", e.message); }

  // Hydrate LLM runtime defaults from the settings store so background LLM
  // calls (upgrade analysis, proactive insights) use the same provider config
  // as chat — not stale env defaults (azure + localhost = ECONNREFUSED).
  try {
    await hydrateLLMDefaults();
  } catch (e) { console.warn("[startup] LLM defaults hydration:", e.message); }

  // Restore silenced alerts from DB
  try {
    const rows = await dbQuery("SELECT name, namespace, cluster, silenced_at, expires_at FROM silenced_alerts WHERE expires_at > NOW()");
    for (const r of (rows?.rows || [])) {
      const cl = r.cluster || "local";
      silencedAlerts.set(`${cl}|${r.name}|${r.namespace}`, {
        name: r.name, namespace: r.namespace, cluster: cl,
        silencedAt: r.silenced_at, expiresAt: r.expires_at,
      });
    }
    if (silencedAlerts.size > 0) console.log(`[startup] restored ${silencedAlerts.size} silenced alerts`);
  } catch { /* DB optional */ }

  // Start background scheduled tasks (health checks, etc.)
  try {
    startHealthCheckTask();
  } catch (err) {
    console.warn("[startup] health-check scheduler failed:", err.message);
  }

  // Periodic cluster connectivity probe — checks all registered clusters every 60s
  async function probeClusterHealth(agent) {
    if (!agent.apiUrl) return { reachable: false, error: "No API URL" };
    try {
      const resp = await clusterFetch(`${agent.apiUrl}/api/v1/namespaces?limit=1`, {
        headers: {
          ...(agent.token ? { Authorization: `Bearer ${agent.token}` } : {}),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        return { reachable: true, status: resp.status, latencyMs: 0 };
      }
      const errText = await resp.text().catch(() => "");
      if (resp.status === 401 || resp.status === 403) {
        return { reachable: true, authError: true, status: resp.status, message: errText.slice(0, 200) };
      }
      return { reachable: false, status: resp.status, message: errText.slice(0, 200) };
    } catch (err) {
      return { reachable: false, error: err.message };
    }
  }

  async function runClusterHealthProbes() {
    for (const [name, agent] of _connectedAgents) {
      // Spoke-registered clusters: probe via spokeUrl and refresh summary
      if (agent.source === "spoke" && agent.spokeUrl) {
        try {
          const resp = await fedFetch(`${agent.spokeUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
          agent.lastHealthCheck = new Date().toISOString();
          if (resp.ok) {
            agent.status = "live";
            agent.lastReportTime = new Date().toISOString();
            fetchSpokeSummary(name, agent.spokeUrl).catch(() => {});
          } else {
            agent.status = "unreachable";
          }
        } catch {
          agent.status = "unreachable";
        }
        _connectedAgents.set(name, agent);
        continue;
      }

      if (!agent.apiUrl) continue;
      // Skip clusters where the agent reported recently — trust the agent
      if (agent.lastReportTime) {
        const elapsed = (Date.now() - new Date(agent.lastReportTime).getTime()) / 1000;
        if (elapsed < 300) {
          agent.status = "live";
          _connectedAgents.set(name, agent);
          continue;
        }
      }
      try {
        const result = await probeClusterHealth(agent);
        agent.lastHealthCheck = new Date().toISOString();
        agent.lastHealthResult = result;
        if (result.reachable && !result.authError) {
          agent.status = "live";
        } else if (result.reachable && result.authError) {
          agent.status = "auth-error";
        } else {
          agent.status = "unreachable";
        }
        _connectedAgents.set(name, agent);
      } catch { /* ignore probe errors */ }
    }
    saveClustersToDB().catch(() => {});
  }

  // Run probes on startup after a brief delay, then every 60s
  setTimeout(() => runClusterHealthProbes().catch(() => {}), 5000);
  setInterval(() => runClusterHealthProbes().catch(() => {}), 60000);

  // Mode + state logging — verify at a glance whether this MCP server is the
  // stateful management plane (owns PostgreSQL/Redis) or a stateless cluster
  // agent (no DB, queries only its own cluster live).
  const _hasDB = !!(process.env.DATABASE_URL || process.env.PGUSER);
  const _hasRedis = !!process.env.REDIS_URL;
  const _stateMode = _hasDB ? "STATEFUL (owns PostgreSQL)" : "STATELESS (no database)";
  console.log(`[startup] MCP_MODE=${MCP_MODE} | ${_stateMode}${_hasRedis ? " | Redis cache" : ""}`);
  if (MCP_MODE === "control") {
    // Control plane: management routes + persistence + federation routing.
    // This cluster's data plane should be the MCP server pod deployed via
    // ./deploy/mcp/deploy.sh with --cluster-name "hub-cluster". Warn (don't
    // fail) when it hasn't registered — legacy in-process handling still works.
    setTimeout(() => {
      if (!hasSpoke(HUB_AGENT_CLUSTER)) {
        console.warn(`[startup] Control mode: local MCP server "${HUB_AGENT_CLUSTER}" not registered yet — run ./deploy/mcp/deploy.sh --cluster-name ${HUB_AGENT_CLUSTER} on this cluster; queries fall back to in-process handling until it connects`);
      } else {
        console.log(`[startup] Control mode: local MCP server "${HUB_AGENT_CLUSTER}" registered — this cluster's data plane fully delegated`);
      }
    }, 60000);
  }
  if (MCP_MODE === "spoke") {
    const hubUrl = process.env.HUB_URL || process.env.HUB_SERVER_URL;
    const clusterName = process.env.CLUSTER_NAME || "unknown";
    const platform = process.env.CLUSTER_PLATFORM || "k8s";
    const deployName = process.env.DEPLOYMENT_NAME || "agentic-ai-agent";
    const ns = process.env.MCP_NAMESPACE || "openshift-mcp";
    const internalUrl = `http://${deployName}.${ns}.svc.cluster.local:${PORT}`;

    (async () => {
      let spokeUrl = process.env.SPOKE_EXTERNAL_URL || "";
      // Auto-detect Route URL for OpenShift (hub can't resolve cross-cluster .svc.cluster.local)
      if (!spokeUrl || spokeUrl.includes(".svc.cluster.local")) {
        try {
          const { ocpFetch } = await import("./utils/openshift-client.js");
          const route = await ocpFetch(`/apis/route.openshift.io/v1/namespaces/${ns}/routes/${deployName}`);
          if (route?.spec?.host) {
            const tls = route.spec.tls ? "https" : "http";
            spokeUrl = `${tls}://${route.spec.host}`;
            console.log(`[spoke] Auto-detected Route URL: ${spokeUrl}`);
          }
        } catch {
          // Not OpenShift or Route not found — use fallback
        }
      }
      if (!spokeUrl) spokeUrl = internalUrl;

      if (hubUrl) {
        console.log(`[spoke] Registering with hub: ${hubUrl} as "${clusterName}" (${spokeUrl})`);
        startSpokeMode(hubUrl, clusterName, spokeUrl, platform).catch((e) =>
          console.error(`[spoke] Registration failed: ${e.message}`)
        );
      } else {
        console.warn("[spoke] HUB_URL not set — running in standalone mode (no federation)");
      }
    })();
  }

  // Track active transports so each SSE session gets its own MCP server
  // instance (the SDK ties one transport to one server).
  const sessions = new Map();

  const httpServer = createServer(async (req, res) => {
   try {
    // Stash accept-encoding so downstream json() helpers can gzip responses
    res._req_accept_encoding = req.headers["accept-encoding"] || "";

    // CORS headers for browser-based clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Cluster-Context, X-User-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Auth routes (login, callback, logout, status)
    if (url.pathname.startsWith("/api/auth/")) {
      const handled = registerAuthRoutes(req, res, url);
      if (handled) return;
      // POST /api/auth/token — needs body parsing
      if (req.method === "POST" && url.pathname === "/api/auth/token") {
        const body = await readJsonBody(req);
        await handleTokenLogin(body, res);
        return;
      }
    }

    // Auth middleware — protect non-public routes
    const authOk = await authMiddleware(req, res, url);
    if (!authOk) return;

    // Cluster isolation: cross-check X-Cluster-Context header against query param.
    // If both are present and disagree, reject the request to prevent spoofing.
    const headerCluster = req.headers["x-cluster-context"];
    const queryCluster = url.searchParams.get("cluster");
    if (headerCluster && queryCluster && headerCluster !== "local" && queryCluster !== "local") {
      const resolvedHeader = findClusterKey(headerCluster);
      const resolvedQuery = findClusterKey(queryCluster);
      if (resolvedHeader && resolvedQuery && resolvedHeader !== resolvedQuery) {
        console.warn(`[security] Cluster context mismatch: header=${headerCluster} query=${queryCluster}`);
        return sendJson(res, 400, { error: "Cluster context mismatch" });
      }
    }

    // ── Universal cluster routing ─────────────────────────────────────────
    // When a request targets a remote cluster via ?cluster=<name>, route it:
    //   1. Spoke proxy (preferred) — same MCP server image, identical results
    //   2. Agent bridge (fallback) — lightweight agent, may produce different results
    //
    // Hub-local paths (records stored in hub PostgreSQL) are NEVER proxied —
    // the cluster param is used for DB filtering, not for routing.
    //
    // The hub cluster is "just another cluster": its own MCP server pod
    // (deployed via ./deploy/mcp/deploy.sh, registered as HUB_AGENT_CLUSTER)
    // serves explicit ?cluster=local data-plane requests through the SAME
    // spoke pipeline as every other cluster — identical code path, identical
    // answers. If not deployed/registered, falls back to in-process (legacy).
    let _reqCluster = queryCluster || headerCluster;
    if (_reqCluster === "local" && MCP_MODE !== "spoke" && hasSpoke(HUB_AGENT_CLUSTER)) {
      _reqCluster = HUB_AGENT_CLUSTER;
    }
    if (_reqCluster && _reqCluster !== "local") {
      const p = url.pathname;
      const isHubLocal =
        p.startsWith("/api/chats") ||
        p === "/api/chat/feedback" || p === "/api/chat/feedback/stats" ||
        p === "/api/audit" ||
        p.startsWith("/api/audit-log") || p.startsWith("/api/audit-trail") ||
        p.startsWith("/api/cr") ||
        p.startsWith("/api/incidents") ||
        p.startsWith("/api/change-timeline") ||
        p.startsWith("/api/actions") ||
        p.startsWith("/api/intelligence") ||
        p.startsWith("/api/agent") ||
        p.startsWith("/api/spoke") ||
        p.startsWith("/api/hub") ||
        p.startsWith("/api/auth");

      // Spoke proxy: forward live-data API requests to the spoke's MCP server.
      // For hub-cluster: if the proxy fails (DNS/network), fall through to
      // local in-process handling instead of returning a 502 to the dashboard.
      if (!isHubLocal && hasSpoke(_reqCluster) && p.startsWith("/api/")) {
        const isHubProxy = _reqCluster === HUB_AGENT_CLUSTER || _reqCluster.toLowerCase() === HUB_AGENT_CLUSTER.toLowerCase();
        const proxied = await proxyToSpoke(_reqCluster, req, res, url, { allowFallback: isHubProxy });
        if (proxied) return;
      }
      // Direct-access: route OCP calls using stored credentials
      const { hasCredentials: _hasCreds2, getCredentials: _getCreds2 } = await import("./utils/cluster-credentials.js");
      if (!isHubLocal && _hasCreds2(_reqCluster)) {
        const _c = _getCreds2(_reqCluster);
        enterRemoteClusterDirect(_c.apiUrl, _c.token);
      }
      // Fallback: agent bridge (legacy lightweight agents)
      else if (!isHubLocal && hasActiveChannel(_reqCluster)) {
        enterRemoteClusterBridge(_reqCluster);
      }
    }

    // User management routes (after auth middleware)
    if (url.pathname.startsWith("/api/auth/users") || url.pathname === "/api/auth/change-password" || url.pathname === "/api/auth/password-policy") {
      const body = (req.method === "POST" || req.method === "PUT") ? await readJsonBody(req) : {};
      await handleUserManagement(req, body, res, url);
      return;
    }

    // Health check endpoint for K8s probes
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          mcpVersion: MCP_VERSION,
          buildHash: _MCP_BUILD_HASH,
          startedAt: _MCP_STARTED_AT,
          db: await isHistoryEnabled(),
          cache: await cacheReady(),
        })
      );
      return;
    }

    // Agent Registry & A2A discovery (additive — works with any framework).
    // Routes: /.well-known/agent.json, /api/agents, /api/agents/:id, /api/agents/:id/tools
    if (
      url.pathname === "/.well-known/agent.json" ||
      url.pathname === "/api/agents" ||
      url.pathname.startsWith("/api/agents/")
    ) {
      const handled = await handleAgentRegistryRoutes(req, res, url);
      if (handled) return;
    }

    // OpenAPI 3.1 spec — serves the standards-compliant API description.
    if (req.method === "GET" && (url.pathname === "/openapi.yaml" || url.pathname === "/openapi.json")) {
      try {
        const specPath = resolve(process.cwd(), "adapters/rest-api/openapi.yaml");
        const data = await readFile(specPath);
        const ct = url.pathname.endsWith(".json") ? "application/json" : "application/yaml";
        res.writeHead(200, { "Content-Type": ct, "Cache-Control": "public, max-age=300" });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "OpenAPI spec not found" }));
        return;
      }
    }

    // Per-agent MCP endpoints — /mcp/<agent-id>/sse and /mcp/<agent-id>/message
    if (url.pathname.startsWith("/mcp/")) {
      const handled = await handleAgentMcpRoutes(req, res, url);
      if (handled) return;
    }

    // Diagnostic endpoint — checks K8s API connectivity, token, auth mode
    if (req.method === "GET" && url.pathname === "/api/diag") {
      const _diagCluster = url.searchParams.get("cluster");
      if (_diagCluster && _diagCluster !== "local") {
        const cached = getAgentCachedResponse(_diagCluster, "/api/diag");
        if (cached) return sendJson(res, 200, cached);
      }
      const diag = {
        authMode: getAuthMode(),
        k8sHost: process.env.KUBERNETES_SERVICE_HOST || "(not set)",
        k8sPort: process.env.KUBERNETES_SERVICE_PORT || "(not set)",
        openshiftApiUrl: process.env.OPENSHIFT_API_URL || `https://${process.env.KUBERNETES_SERVICE_HOST || "?"}:${process.env.KUBERNETES_SERVICE_PORT || "?"}`,
        tokenAvailable: false,
        k8sApiReachable: false,
        k8sApiError: null,
        k8sApiLatencyMs: null,
        nodeCount: null,
        db: await isHistoryEnabled(),
        cache: await cacheReady(),
      };
      try {
        const { readFile: rf } = await import("node:fs/promises");
        const tk = await rf("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").catch(() => null);
        diag.tokenAvailable = !!tk;
        if (!tk && process.env.OPENSHIFT_TOKEN) diag.tokenAvailable = true;
      } catch { diag.tokenAvailable = false; }
      try {
        const start = Date.now();
        const resp = await ocpGet("/api/v1/nodes");
        diag.k8sApiLatencyMs = Date.now() - start;
        diag.k8sApiReachable = true;
        diag.nodeCount = (resp.items || []).length;
      } catch (e) {
        diag.k8sApiReachable = false;
        diag.k8sApiError = e.message;
      }
      // External DNS resolution check
      diag.externalDns = { tested: false };
      try {
        const { resolve4 } = await import("node:dns/promises");
        const host = url.searchParams.get("dnsTest") || "documentquery.openai.azure.com";
        diag.externalDns.host = host;
        const start = Date.now();
        const addrs = await resolve4(host);
        diag.externalDns.resolved = true;
        diag.externalDns.addresses = addrs;
        diag.externalDns.latencyMs = Date.now() - start;
        diag.externalDns.tested = true;
      } catch (dnsErr) {
        diag.externalDns.resolved = false;
        diag.externalDns.error = dnsErr.code || dnsErr.message;
        diag.externalDns.tested = true;
      }
      diag.proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "(not set)";
      // TCP+TLS connectivity test to Azure endpoint
      diag.externalHttps = { tested: false };
      const testHost = url.searchParams.get("dnsTest") || "documentquery.openai.azure.com";
      try {
        const { connect } = await import("node:tls");
        await new Promise((resolve) => {
          const start = Date.now();
          let connected = false;
          const sock = connect(443, testHost, { servername: testHost, rejectUnauthorized: false, timeout: 8000 }, () => {
            connected = true;
            diag.externalHttps = { tested: true, connected: true, latencyMs: Date.now() - start, host: testHost, tlsVersion: sock.getProtocol?.() || "unknown" };
            sock.end();
            resolve();
          });
          sock.on("error", (e) => { if (!connected) { diag.externalHttps = { tested: true, connected: false, host: testHost, error: e.code || e.message }; resolve(); } });
          sock.on("timeout", () => { if (!connected) { diag.externalHttps = { tested: true, connected: false, host: testHost, error: "TIMEOUT (8s)" }; sock.destroy(); resolve(); } });
        });
      } catch (tlsErr) {
        diag.externalHttps = { tested: true, connected: false, host: testHost, error: tlsErr.code || tlsErr.message };
      }
      // Actual HTTP request test
      diag.externalHttp = { tested: false };
      try {
        const https = await import("node:https");
        const httpResult = await new Promise((resolve) => {
          const start = Date.now();
          const req = https.get(`https://${testHost}/`, { rejectUnauthorized: false, timeout: 10000 }, (res) => {
            resolve({ tested: true, connected: true, statusCode: res.statusCode, latencyMs: Date.now() - start, host: testHost });
            res.resume();
          });
          req.on("error", (e) => resolve({ tested: true, connected: false, host: testHost, error: e.code || e.message }));
          req.on("timeout", () => { req.destroy(); resolve({ tested: true, connected: false, host: testHost, error: "TIMEOUT (10s)" }); });
        });
        diag.externalHttp = httpResult;
      } catch (httpErr) {
        diag.externalHttp = { tested: true, connected: false, host: testHost, error: httpErr.code || httpErr.message };
      }
      diag.nodeTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED || "(not set)";
      sendJson(res, 200, diag);
      return;
    }

    // ── Security & Governance APIs ────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/access-level") {
      sendJson(res, 200, { accessLevel: getAccessLevel() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/validate-command") {
      const parsed = await readJsonBody(req);
      const result = validateCommand(parsed.command, {
        accessLevel: parsed.accessLevel,
        allowedNamespaces: parsed.allowedNamespaces,
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/components") {
      sendJson(res, 200, getComponentCatalog());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/telemetry-status") {
      sendJson(res, 200, getTelemetryStatus());
      return;
    }

    // -----------------------------------------------------------------------
    // MCP Hub API — manage external MCP server connections
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/hub/servers" && req.method === "GET") {
      return sendJson(res, 200, { servers: hubListServers() });
    }
    if (url.pathname === "/api/hub/servers" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const result = await hubConnect(body);
        return sendJson(res, 201, { server: result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (url.pathname === "/api/hub/tools" && req.method === "GET") {
      const tools = hubGetAllTools();
      return sendJson(res, 200, { tools, count: tools.length });
    }
    // /api/hub/servers/:id/disconnect
    {
      const hubM = url.pathname.match(/^\/api\/hub\/servers\/([^/]+)\/disconnect$/);
      if (hubM && req.method === "POST") {
        try {
          const result = await hubDisconnect(decodeURIComponent(hubM[1]));
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }
    // /api/hub/servers/:id/reconnect
    {
      const hubM = url.pathname.match(/^\/api\/hub\/servers\/([^/]+)\/reconnect$/);
      if (hubM && req.method === "POST") {
        try {
          const result = await hubReconnect(decodeURIComponent(hubM[1]));
          return sendJson(res, 200, { server: result });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }
    // DELETE /api/hub/servers/:id
    {
      const hubM = url.pathname.match(/^\/api\/hub\/servers\/([^/]+)$/);
      if (hubM && req.method === "DELETE") {
        try {
          const result = await hubDisconnect(decodeURIComponent(hubM[1]));
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }
    // POST /api/hub/tools/call — call any tool through the hub
    if (url.pathname === "/api/hub/tools/call" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const { tool, arguments: args } = body;
        if (!tool) return sendJson(res, 400, { error: "Missing tool name" });
        const result = await hubCallTool(tool, args || {});
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
    // POST /api/hub/orchestrate — run the full orchestrator (LLM + tool calls)
    if (url.pathname === "/api/hub/orchestrate" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const { message, llmOpts, serverFilter, conversationHistory } = body;
        if (!message) return sendJson(res, 400, { error: "Missing message" });
        const result = await runOrchestrator({
          userMessage: message,
          llmOpts: llmOpts || {},
          serverFilter: serverFilter || null,
          conversationHistory: conversationHistory || null,
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
    // GET /api/hub/status — hub summary
    if (url.pathname === "/api/hub/status" && req.method === "GET") {
      const servers = hubListServers();
      return sendJson(res, 200, {
        totalServers: servers.length,
        totalTools: hubGetToolCount(),
        servers: servers.map((s) => ({ id: s.id, name: s.name, status: s.status, toolCount: s.toolCount })),
      });
    }

    // -----------------------------------------------------------------------
    // AI Intelligence APIs — Proactive Monitor, Knowledge Base, Automation, Predictions
    // -----------------------------------------------------------------------

    // Proactive AI insights
    if (url.pathname === "/api/intelligence/insights" && req.method === "GET") {
      return sendJson(res, 200, { insights: getInsights(), summary: getInsightsSummary(), monitoring: isMonitorRunning() });
    }
    if (url.pathname === "/api/intelligence/insights/dismiss" && req.method === "POST") {
      const body = await readJsonBody(req);
      dismissInsight(body.id);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/api/intelligence/insights/analyze" && req.method === "POST") {
      const body = await readJsonBody(req);
      const result = await analyzeInsight(body.id, body.llmOpts || {});
      return sendJson(res, 200, result || { error: "Not found" });
    }
    // Queue an insight's recommended remediation for operator review. We record
    // it to the immutable audit trail rather than executing a raw command blind,
    // then dismiss the insight from the active list (it has been actioned).
    if (url.pathname === "/api/intelligence/insights/fix" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.command) return sendJson(res, 400, { error: "command required" });
      try {
        await logAuditTrailEvent({
          type: "action_taken",
          severity: "info",
          title: "Remediation queued from AI insight",
          details: { insightId: body.id || null, command: body.command },
          username: (req.user && req.user.name) || "dashboard",
          source: "intelligence",
        });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
      if (body.id) { try { dismissInsight(body.id); } catch { /* best effort */ } }
      return sendJson(res, 200, { ok: true, queued: true });
    }

    // Knowledge Base
    if (url.pathname === "/api/intelligence/kb" && req.method === "GET") {
      return sendJson(res, 200, { entries: kbGetAll(50), stats: kbGetStats() });
    }
    if (url.pathname === "/api/intelligence/kb/search" && req.method === "POST") {
      const body = await readJsonBody(req);
      const matches = await kbFindSimilar(body);
      return sendJson(res, 200, { matches, context: buildKBContext(matches) });
    }
    if (url.pathname === "/api/intelligence/kb/record" && req.method === "POST") {
      const body = await readJsonBody(req);
      const entry = await recordResolution(body);
      return sendJson(res, 201, { entry });
    }
    if (url.pathname === "/api/intelligence/kb/rate" && req.method === "POST") {
      const body = await readJsonBody(req);
      await rateResolution(body.id, body.delta || 1);
      return sendJson(res, 200, { ok: true });
    }

    // Automation Rules
    if (url.pathname === "/api/intelligence/rules" && req.method === "GET") {
      return sendJson(res, 200, { rules: listRules() });
    }
    if (url.pathname === "/api/intelligence/rules" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.description) return sendJson(res, 400, { error: "Missing rule description" });
      const result = await createRule(body.description, body.name);
      if (result.error) return sendJson(res, 400, result);
      return sendJson(res, 201, result);
    }
    {
      const ruleM = url.pathname.match(/^\/api\/intelligence\/rules\/(\d+)$/);
      if (ruleM && req.method === "DELETE") {
        await deleteRule(parseInt(ruleM[1]));
        return sendJson(res, 200, { ok: true });
      }
      if (ruleM && req.method === "PATCH") {
        const body = await readJsonBody(req);
        if (body.enabled !== undefined) await toggleRule(parseInt(ruleM[1]), body.enabled);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (url.pathname === "/api/intelligence/rules/evaluate" && req.method === "POST") {
      const insights = getInsights();
      const triggered = evaluateRules(insights);
      const results = await executeRuleActions(triggered);
      return sendJson(res, 200, { triggered: triggered.length, results });
    }

    // Predictive Intelligence
    if (url.pathname === "/api/intelligence/predictions" && req.method === "GET") {
      return sendJson(res, 200, { predictions: getPredictions(), trends: getTrends() });
    }
    if (url.pathname === "/api/intelligence/predictions/run" && req.method === "POST") {
      const predictions = await runPredictiveAnalysis();
      return sendJson(res, 200, { predictions, trends: getTrends() });
    }

    // Combined intelligence dashboard
    if (url.pathname === "/api/intelligence/dashboard" && req.method === "GET") {
      const [predictions, correlationResult] = await Promise.allSettled([
        runPredictiveAnalysis(),
        runCorrelation(),
      ]);
      return sendJson(res, 200, {
        proactive: getInsightsSummary(),
        insights: getInsights().slice(0, 10),
        predictions: predictions.status === "fulfilled" ? predictions.value : [],
        knowledgeBase: kbGetStats(),
        automationRules: listRules().length,
        monitoring: isMonitorRunning(),
        crossCluster: correlationResult.status === "fulfilled" ? correlationResult.value : null,
      });
    }

    // Incident automation settings — runtime-configurable policy (no redeploy).
    if (url.pathname === "/api/intelligence/incident-settings" && req.method === "GET") {
      try {
        const { loadIncidentSettings, DEFAULTS } = await import("./services/incident-settings.js");
        const s = await loadIncidentSettings();
        return sendJson(res, 200, { settings: s, defaults: DEFAULTS });
      } catch (err) { return sendJson(res, 200, { error: err.message }); }
    }
    if (url.pathname === "/api/intelligence/incident-settings" && req.method === "POST") {
      if (enforceRateLimit(req, res, { burst: 10, refillPerSec: 0.2 })) return;
      try {
        const body = await readJsonBody(req);
        const { saveIncidentSettings, verifyAssignmentGroup } = await import("./services/incident-settings.js");
        const saved = await saveIncidentSettings(body || {});
        // Best-effort: tell the operator if the queue name doesn't resolve, so a
        // typo doesn't silently leave every incident unassigned.
        const groupCheck = await verifyAssignmentGroup(saved.assignmentGroup);
        try {
          // NOTE: logAuditTrailEvent is the audit-log.js writer ({type,title,…});
          // the bare `logAuditEvent` in this file is the guardrails one with a
          // completely different shape.
          await logAuditTrailEvent({
            type: "config_change", severity: "info",
            title: `Incident automation settings updated (autoAct=${saved.autoAct})`,
            details: JSON.stringify(saved), source: "incident-settings",
          });
        } catch {}
        return sendJson(res, 200, { settings: saved, groupCheck });
      } catch (err) { return sendJson(res, 400, { error: err.message }); }
    }

    // Autonomous incident detection — Phase 1, SHADOW MODE.
    // Evaluates industry-standard thresholds against live cluster state and
    // returns the incidents that WOULD be opened. Strictly read-only: no
    // ServiceNow ticket, no notification, no remediation.
    if (url.pathname === "/api/intelligence/detected-incidents" && req.method === "GET") {
      if (!featureFlags.incidentAutoDetect()) {
        return sendJson(res, 200, {
          disabled: true, shadowMode: true, incidents: [],
          notice: "Incident auto-detection is disabled (INCIDENT_AUTO_DETECT=false).",
        });
      }
      try {
        const { detectIncidents } = await import("./services/incident-detector.js");
        const out = await withClusterContext(url, async () => detectIncidents());
        if (out === null) {
          return sendJson(res, 200, { shadowMode: true, incidents: [], error: "Selected cluster is not reachable." });
        }
        return sendJson(res, 200, { ...out, autoActEnabled: featureFlags.incidentAutoAct() });
      } catch (err) {
        return sendJson(res, 200, { shadowMode: true, incidents: [], error: err.message });
      }
    }

    // ── Autonomous incident sessions (Phase 2) ────────────────────────────
    // Managed lifecycle: promote a detection → RCA → ServiceNow INC → fix →
    // dry-run → AWAITING_APPROVAL → (human click) → apply → verify → close.
    if (url.pathname === "/api/intelligence/incident-sessions" && req.method === "GET") {
      try {
        const { listSessions, ticketBudgetStatus } = await import("./services/incident-orchestrator.js");
        const sessions = await listSessions({
          cluster: url.searchParams.get("cluster") || undefined,
          state: url.searchParams.get("state") || undefined,
        });
        return sendJson(res, 200, {
          sessions,
          awaitingApproval: sessions.filter((s) => s.state === "awaiting_approval").length,
          selfHealed: sessions.filter((s) => s.selfHealed).length,
          autoActEnabled: featureFlags.incidentAutoAct(),
          ticketBudget: ticketBudgetStatus(),
        });
      } catch (err) { return sendJson(res, 200, { sessions: [], error: err.message }); }
    }

    // Promote a detection into a managed incident. Human-initiated.
    if (url.pathname === "/api/intelligence/incident-sessions/promote" && req.method === "POST") {
      if (enforceRateLimit(req, res, { burst: 6, refillPerSec: 0.1 })) return;
      try {
        const body = await readJsonBody(req);
        if (!body?.detection?.signature) return sendJson(res, 400, { error: "detection (with signature) is required" });
        const { promoteDetection } = await import("./services/incident-orchestrator.js");
        const cluster = url.searchParams.get("cluster") || body.cluster || "local";
        const session = await withClusterContext(url, async () => promoteDetection(body.detection, {
          cluster, actor: body.actor || "operator", unattended: false,
        }));
        if (session === null) return sendJson(res, 200, { error: "Selected cluster is not reachable." });
        return sendJson(res, 200, { session });
      } catch (err) { return sendJson(res, 400, { error: err.message }); }
    }

    // The single human gate — plus explicit dry-run and re-plan actions so the
    // operator can preview the fix before applying it.
    const apprMatch = url.pathname.match(/^\/api\/intelligence\/incident-sessions\/([\w-]+)\/(approve|reject|dry-run|replan)$/);
    if (apprMatch && req.method === "POST") {
      if (enforceRateLimit(req, res, { burst: 12, refillPerSec: 0.3 })) return;
      try {
        const body = await readJsonBody(req).catch(() => ({}));
        const orch = await import("./services/incident-orchestrator.js");
        const actor = body.actor || "operator";
        const id = apprMatch[1];
        const session = await withClusterContext(url, async () => {
          switch (apprMatch[2]) {
            case "approve":  return orch.approveSession(id, { actor });
            case "reject":   return orch.rejectSession(id, { actor, reason: body.reason || "Rejected by operator" });
            case "dry-run":  return orch.dryRunSession(id);
            case "replan":   return orch.replanSession(id);
            default:         throw new Error("Unsupported action");
          }
        });
        if (session === null) return sendJson(res, 200, { error: "Selected cluster is not reachable." });
        return sendJson(res, 200, { session });
      } catch (err) { return sendJson(res, 400, { error: err.message }); }
    }

    // RCA document (plain text) for a session — download / attach.
    const rcaMatch = url.pathname.match(/^\/api\/intelligence\/incident-sessions\/([\w-]+)\/rca$/);
    if (rcaMatch && req.method === "GET") {
      try {
        const { getSessionRCA } = await import("./services/incident-orchestrator.js");
        const doc = await getSessionRCA(rcaMatch[1]);
        if (!doc) return sendJson(res, 404, { error: "Session not found" });
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(doc);
      } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    if (url.pathname === "/api/intelligence/correlations" && req.method === "GET") {
      const force = url.searchParams.get("force") === "true";
      const result = await runCorrelation({ force });
      return sendJson(res, 200, result);
    }

    if (url.pathname === "/api/intelligence/correlations/investigate" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body?.correlationId) return sendJson(res, 400, { error: "correlationId required" });
      const result = await investigateCorrelationById(body.correlationId);
      return sendJson(res, 200, result);
    }

    if (url.pathname === "/api/intelligence/correlations/signals" && req.method === "GET") {
      const summary = await getSignalSummary();
      return sendJson(res, 200, summary);
    }

    // -----------------------------------------------------------------------
    // Cluster info — lightweight version/node summary for the global selector
    // -----------------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/cluster-info") {
      const cluster = url.searchParams.get("cluster");
      if (cluster && cluster !== "local") {
        const cached = getAgentCachedResponse(cluster, "/api/cluster-info");
        if (cached) return sendJson(res, 200, cached);
      }
      try {
        const info = await withClusterContext(url, async () => {
          const [cv, nodes] = await Promise.allSettled([
            ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
            ocpGet("/api/v1/nodes"),
          ]);
          const version = cv.status === "fulfilled"
            ? (cv.value?.status?.desired?.version || cv.value?.status?.history?.[0]?.version || "unknown")
            : "unknown";
          const nodeList = nodes.status === "fulfilled" ? (nodes.value?.items || []) : [];
          const readyNodes = nodeList.filter(n =>
            (n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True"));
          return { version, nodeCount: nodeList.length, readyNodes: readyNodes.length, platform: "openshift" };
        });
        if (info === null) {
          const cached = getAgentCachedResponse(cluster, "/api/cluster-info", { skipFreshnessCheck: true });
          if (cached) return sendJson(res, 200, cached);
          return sendJson(res, 200, { version: "unknown", nodeCount: 0, readyNodes: 0, source: "agent-cache", available: false, message: "No cached data available" });
        }
        return sendJson(res, 200, info);
      } catch (err) {
        const cached = cluster ? getAgentCachedResponse(cluster, "/api/cluster-info", { skipFreshnessCheck: true }) : null;
        if (cached) return sendJson(res, 200, cached);
        return sendJson(res, err.status || 200, err.status ? { error: err.message } : { version: "unknown", nodeCount: 0, readyNodes: 0, error: err.message });
      }
    }

    // -----------------------------------------------------------------------
    // MCP Version — used by dashboard to detect image drift across clusters
    // -----------------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/cluster/version") {
      const agents = [];
      for (const [, agent] of _connectedAgents) {
        agents.push({
          clusterName: agent.clusterName,
          mcpVersion: agent.mcpVersion || null,
          buildHash: agent.buildHash || null,
          startedAt: agent.mcpStartedAt || null,
        });
      }
      return sendJson(res, 200, {
        hub: { mcpVersion: MCP_VERSION, buildHash: _MCP_BUILD_HASH, startedAt: _MCP_STARTED_AT },
        agents,
      });
    }

    // -----------------------------------------------------------------------
    // Hub Health Check — active probe of the local cluster's API + operators
    // -----------------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/cluster/health-check") {
      try {
        const checks = {};
        const cli = await detectCLI().catch(() => null);
        if (cli) {
          const nodeResult = await runExec(cli, ["get", "nodes", "-o", "json", "--request-timeout=10s"]).catch(() => null);
          if (nodeResult) {
            const parsed = JSON.parse(nodeResult);
            const nodes = parsed.items || [];
            const ready = nodes.filter(n => (n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True")).length;
            checks.nodes = { total: nodes.length, ready };
          }
          if (process.env.PLATFORM === "openshift" || process.env.IS_OPENSHIFT === "true") {
            const opResult = await runExec(cli, ["get", "clusteroperators", "-o", "json", "--request-timeout=10s"]).catch(() => null);
            if (opResult) {
              const parsed = JSON.parse(opResult);
              const ops = parsed.items || [];
              const degraded = ops.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
              checks.operators = { total: ops.length, healthy: ops.length - degraded.length, degraded: degraded.length, degradedNames: degraded.map(o => o.metadata?.name) };
            }
          }
        }
        checks.apiServer = { reachable: true };
        checks.checkedAt = new Date().toISOString();
        const overall = (checks.operators?.degraded > 0) ? "degraded" : (checks.nodes && checks.nodes.ready < checks.nodes.total) ? "warning" : "healthy";
        return sendJson(res, 200, { ok: true, health: overall, checks, message: `Hub health: ${overall}` });
      } catch (err) {
        return sendJson(res, 200, { ok: false, health: "unknown", error: err.message, message: "Health check failed: " + err.message });
      }
    }

    // -----------------------------------------------------------------------
    // Hub RBAC Sync — re-apply ClusterRole for the local agent
    // -----------------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/cluster/rbac-sync") {
      try {
        const cli = await detectCLI().catch(() => null);
        if (!cli) return sendJson(res, 200, { ok: false, message: "CLI not available — cannot sync RBAC" });
        const ns = process.env.NAMESPACE || process.env.MCP_NAMESPACE || (process.env.PLATFORM === "openshift" ? "openshift-mcp" : "tcs-agentic-system");
        const result = await runExec(cli, ["auth", "reconcile", "-f", "-", "--remove-extra-subjects=false"], { stdin: "" }).catch(() => null);
        return sendJson(res, 200, { ok: true, message: `RBAC sync completed for ${ns}`, output: result });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message, message: "RBAC sync failed: " + err.message });
      }
    }

    // -----------------------------------------------------------------------
    // Redeploy — trigger rollout restart on local or remote cluster
    // -----------------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/cluster/redeploy") {
      const ns = process.env.NAMESPACE || process.env.MCP_NAMESPACE || (process.env.PLATFORM === "openshift" ? "openshift-mcp" : "tcs-agentic-system");
      const deployName = process.env.DEPLOYMENT_NAME || (MCP_MODE === "spoke" ? "agentic-ai-agent" : "agentic-ai-control-plane");
      try {
        const cli = await detectCLI();
        const restarted = [];
        // Restart primary deployment
        await runExec(cli, ["rollout", "restart", `deployment/${deployName}`, "-n", ns]);
        restarted.push(deployName);
        // Also restart the agent pod in the same namespace (if separate)
        if (deployName !== "agentic-ai-agent") {
          await runExec(cli, ["rollout", "restart", "deployment/agentic-ai-agent", "-n", ns]).catch(() => {});
          restarted.push("agentic-ai-agent");
        }
        // Also restart tcs-agentic-ai deployment (YAML generator name)
        if (deployName !== "tcs-agentic-ai") {
          const tcsNs = process.env.PLATFORM === "openshift" ? "openshift-tcs-agentic" : "tcs-agentic-system";
          await runExec(cli, ["rollout", "restart", "deployment/tcs-agentic-ai", "-n", tcsNs]).catch(() => {});
        }
        return sendJson(res, 200, { ok: true, message: `Rollout restart triggered for ${restarted.join(", ")} in ${ns}` });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message, message: "Redeploy failed: " + err.message });
      }
    }

    // -----------------------------------------------------------------------
    // Cluster Registration — add K8s clusters via dashboard (direct API)
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/hub/clusters" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { name, platform } = body;
      let { apiUrl, token } = body;
      if (!name) return sendJson(res, 400, { error: "Cluster name is required" });

      // Check for existing entry to merge (avoid duplicates on re-register)
      const existingKey = findClusterKey(name, apiUrl);
      if (existingKey && existingKey !== name) {
        _connectedAgents.delete(existingKey);
        console.error(`[hub] Removing duplicate entry "${existingKey}" — merging into "${name}"`);
      }

      // Detect kubeconfig YAML pasted as token and extract server + token
      let kubeconfigDetected = false;
      let rawKubeconfig = null;
      if (token) {
        const kc = extractFromKubeconfig(token);
        if (kc) {
          kubeconfigDetected = true;
          rawKubeconfig = token;
          if (kc.server && !apiUrl) apiUrl = kc.server;
          if (kc.token) token = kc.token;
          else token = null;
          console.error(`[hub] Kubeconfig detected — extracted server: ${kc.server || "none"}, token: ${kc.token ? "yes" : "no"}, clientCert: ${kc.hasClientCert ? "yes" : "no"}`);
        }
      }

      const spokeMode = body.spokeMode || false;
      if (!apiUrl && !spokeMode) return sendJson(res, 400, { error: "API server URL is required" });
      if (apiUrl && isBlockedUrl(apiUrl)) return sendJson(res, 400, { error: "API URL targets a blocked address range" });

      // For credential storage: prefer extracted bearer token, fall back to raw kubeconfig
      const credToken = token || rawKubeconfig || null;

      let testResult = null;
      if (apiUrl && !spokeMode) {
        try {
          const headers = { Accept: "application/json" };
          if (token) headers.Authorization = `Bearer ${token}`;
          const testResp = await clusterFetch(`${apiUrl}/api/v1/namespaces?limit=1`, {
            headers,
            signal: AbortSignal.timeout(10000),
          });
          if (testResp.ok) {
            const data = await testResp.json();
            testResult = { ok: true, namespaces: (data.items || []).length };
          } else {
            const errText = await testResp.text().catch(() => "");
            testResult = { ok: false, status: testResp.status, message: errText.slice(0, 200) };
          }
        } catch (err) {
          testResult = { ok: false, message: err.message };
        }
      } else if (spokeMode) {
        testResult = { ok: true, mode: "spoke", message: "Spoke mode — agent will connect to hub" };
      }

      _connectedAgents.set(name, {
        clusterName: name,
        platform: platform || "k8s",
        apiUrl,
        token: credToken,
        kubeconfig: rawKubeconfig || null,
        registeredAt: new Date().toISOString(),
        lastReport: null,
        lastReportTime: null,
        status: testResult?.ok ? "live" : "registered",
        connectionTest: testResult,
        source: "dashboard",
      });

      saveClustersToDB().catch(() => {});
      if (credToken && apiUrl) {
        clusterCredsUpsert(name, apiUrl, credToken, platform || "openshift", name).catch(err =>
          console.warn(`[hub] Failed to save cluster credentials: ${err.message}`));
      }
      console.error(`[hub] Cluster registered: ${name} (${platform}) — test: ${testResult?.ok ? "OK" : "skipped/failed"}${kubeconfigDetected ? " (kubeconfig parsed)" : ""}`);
      return sendJson(res, 200, {
        ok: true,
        cluster: { name, platform, status: testResult?.ok ? "live" : "registered" },
        connectionTest: testResult,
        kubeconfigDetected,
      });
    }

    if (url.pathname === "/api/hub/clusters" && req.method === "GET") {
      // Heartbeat protocol v1 thresholds (seconds)
      const HB_STALE_THRESHOLD = 90;
      const HB_UNREACHABLE_THRESHOLD = 300;

      const clusters = [];
      for (const [, agent] of _connectedAgents) {
        // Determine real status from multiple signals (report + heartbeat + bridge)
        const agentReportElapsed = agent.lastReportTime
          ? (Date.now() - new Date(agent.lastReportTime).getTime()) / 1000
          : null;
        const heartbeatElapsed = agent.lastHeartbeat
          ? (Date.now() - new Date(agent.lastHeartbeat).getTime()) / 1000
          : null;

        let status;
        const hasBridge = hasActiveChannel(agent.clusterName);
        const hasReport = agentReportElapsed !== null;
        const hasHeartbeat = heartbeatElapsed !== null;
        const reportFresh = hasReport && agentReportElapsed < 300;
        const reportStale = hasReport && agentReportElapsed >= 300 && agentReportElapsed < 900;
        const heartbeatFresh = hasHeartbeat && heartbeatElapsed < HB_STALE_THRESHOLD;
        const heartbeatStale = hasHeartbeat && heartbeatElapsed >= HB_STALE_THRESHOLD && heartbeatElapsed < HB_UNREACHABLE_THRESHOLD;
        const heartbeatDead = hasHeartbeat && heartbeatElapsed >= HB_UNREACHABLE_THRESHOLD;

        if ((reportFresh || heartbeatFresh) && hasBridge) {
          status = "active";
        } else if (reportFresh && !hasBridge) {
          status = "reporting";
        } else if (hasBridge && !hasReport && heartbeatFresh) {
          status = "connected";
        } else if (hasBridge && !hasReport) {
          status = "connected";
        } else if (heartbeatDead && !reportFresh) {
          status = "unreachable";
        } else if (heartbeatStale || reportStale) {
          status = "stale";
        } else if (agent.lastHealthResult) {
          if (agent.lastHealthResult.reachable && !agent.lastHealthResult.authError) {
            status = "active";
          } else if (agent.lastHealthResult.reachable && agent.lastHealthResult.authError) {
            status = "auth-error";
          } else {
            status = "unreachable";
          }
        } else if (agent.connectionTest) {
          status = agent.connectionTest.ok ? "waiting" : "error";
        } else if (agent.source === "dashboard" && !hasReport) {
          status = "pending";
        } else if (agent.source === "agent" && !hasReport) {
          status = "waiting";
        } else {
          status = "waiting";
        }

        clusters.push({
          name: agent.clusterName,
          platform: agent.platform,
          apiUrl: agent.apiUrl,
          hasToken: !!agent.token,
          agentVersion: agent.agentVersion || null,
          agentType: agent.agentType || null,
          actionsEnabled: agent.actionsEnabled === true,
          status,
          bridgeConnected: hasActiveChannel(agent.clusterName),
          registeredAt: agent.registeredAt,
          lastReportTime: agent.lastReportTime,
          lastHeartbeat: agent.lastHeartbeat || null,
          heartbeatSeq: agent.heartbeatSeq || 0,
          agentUptime: agent.agentUptime || null,
          agentMemMB: agent.agentMemMB || null,
          agentHealthy: agent.agentHealthy !== false,
          lastHealthCheck: agent.lastHealthCheck || null,
          lastHealthResult: agent.lastHealthResult || null,
          source: agent.source || "agent",
          summary: agent.lastReport ? (() => {
            const _r = agent.lastReport;
            const _d = _r.clusterOperators?.degraded || 0;
            const _t = _r.nodes?.total || 0;
            const _rd = _r.nodes?.ready || 0;
            const _h = _d > 0 ? "degraded" : (_rd < _t ? "warning" : "healthy");
            return {
              version: _r.openshiftVersion || _r.kubernetesVersion || "",
              health: _h,
              nodes: `${_rd}/${_t}`,
              pods: _r.pods?.total || 0,
              issues: _r.pods?.issues?.length || 0,
              warnings: _r.events?.warnings || 0,
            };
          })() : null,
        });
      }
      return sendJson(res, 200, { clusters });
    }

    // On-demand cluster health check
    if (url.pathname.match(/^\/api\/hub\/clusters\/[^/]+\/health$/) && req.method === "GET") {
      const name = decodeURIComponent(url.pathname.split("/api/hub/clusters/")[1].replace("/health", ""));
      const resolvedKey = findClusterKey(name) || name;
      const agent = _connectedAgents.get(resolvedKey);
      if (!agent) return sendJson(res, 404, { error: "Cluster not found" });

      // If agent reported recently, trust it — don't override with a token-based probe
      const agentReportAge = agent.lastReportTime
        ? (Date.now() - new Date(agent.lastReportTime).getTime()) / 1000
        : null;
      if (agentReportAge !== null && agentReportAge < 300) {
        agent.status = "live";
        agent.lastHealthCheck = new Date().toISOString();
        agent.lastHealthResult = { reachable: true, agentReported: true, agentReportAge: Math.round(agentReportAge) };
        _connectedAgents.set(resolvedKey, agent);
        saveClustersToDB().catch(() => {});
        return sendJson(res, 200, { name: resolvedKey, status: "live", healthCheck: agent.lastHealthResult, checkedAt: agent.lastHealthCheck });
      }

      const result = await probeClusterHealth(agent);
      agent.lastHealthCheck = new Date().toISOString();
      agent.lastHealthResult = result;
      if (result.reachable && !result.authError) {
        agent.status = "live";
      } else if (result.reachable && result.authError) {
        agent.status = "auth-error";
        result.hint = "The stored bearer token has expired. Use a long-lived service account token, or re-register with a fresh token.";
      } else {
        agent.status = "unreachable";
      }
      _connectedAgents.set(resolvedKey, agent);
      saveClustersToDB().catch(() => {});
      return sendJson(res, 200, { name: resolvedKey, status: agent.status, healthCheck: result, checkedAt: agent.lastHealthCheck });
    }

    if (url.pathname.startsWith("/api/hub/clusters/") && req.method === "DELETE") {
      const name = decodeURIComponent(url.pathname.split("/api/hub/clusters/")[1]);
      const resolvedKey = findClusterKey(name) || name;
      _connectedAgents.delete(resolvedKey);
      saveClustersToDB().catch(() => {});
      if (CLUSTER_STORE_ENABLED) deleteClusterSnapshot(resolvedKey).catch(() => {});
      return sendJson(res, 200, { ok: true, deleted: resolvedKey });
    }

    // -----------------------------------------------------------------------
    // AI Hub Performance / Monitoring (Pillar 6)
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/hub/performance" && req.method === "GET") {
      const hours = Math.min(168, Math.max(1, parseInt(url.searchParams.get("hours") || "24", 10)));
      const [summary, series, intents, providers, errors, recent] = await Promise.all([
        getMetricsSummary(hours).catch(() => null),
        getTimeSeries(hours).catch(() => []),
        getTopIntents(hours, 8).catch(() => []),
        getProviderBreakdown(hours).catch(() => []),
        getErrorBreakdown(hours).catch(() => []),
        getRecentEvents(15).catch(() => []),
      ]);
      return sendJson(res, 200, {
        windowHours: hours,
        summary,
        timeSeries: series,
        topIntents: intents,
        providers,
        errors,
        recentEvents: recent,
      });
    }

    // -----------------------------------------------------------------------
    // Cluster Credentials — direct-access pattern (industry-standard Rancher/ArgoCD style)
    // Control plane stores cluster API URLs + SA tokens and calls OCP APIs directly.
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/clusters/register" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { clusterName, apiUrl, token, platform, displayName } = body || {};
      if (!clusterName || !apiUrl || !token) return sendJson(res, 400, { error: "clusterName, apiUrl, and token are required" });
      try {
        const row = await clusterCredsUpsert(clusterName, apiUrl, token, platform || "openshift", displayName || "");
        if (!row) return sendJson(res, 503, { error: "Database unavailable" });
        console.log(`[cluster-creds] Registered: ${clusterName} → ${apiUrl}`);
        return sendJson(res, 200, { ok: true, cluster: { clusterName, apiUrl, platform: platform || "openshift", displayName: displayName || clusterName } });
      } catch (err) {
        console.error(`[cluster-creds] Register error: ${err.message}`);
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (url.pathname === "/api/clusters/list" && req.method === "GET") {
      try {
        const clusters = await clusterCredsList();
        return sendJson(res, 200, { clusters });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (url.pathname === "/api/clusters/test" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { clusterName, apiUrl, token } = body || {};
      if (!apiUrl || !token) return sendJson(res, 400, { error: "apiUrl and token required" });
      try {
        const { withRemoteCluster } = await import("./utils/openshift-client.js");
        const cv = await withRemoteCluster(apiUrl.replace(/\/+$/, ""), token, () =>
          import("./utils/openshift-client.js").then(m => m.ocpGet("/apis/config.openshift.io/v1/clusterversions/version"))
        );
        const ver = cv?.status?.desired?.version || "unknown";
        return sendJson(res, 200, { ok: true, version: ver, message: `Connected to ${clusterName || "cluster"} (OCP ${ver})` });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message, message: `Connection failed: ${err.message}` });
      }
    }

    if (url.pathname.match(/^\/api\/clusters\/[^/]+$/) && req.method === "DELETE") {
      const name = decodeURIComponent(url.pathname.split("/").pop());
      const removed = await clusterCredsRemove(name);
      return sendJson(res, 200, { ok: removed, message: removed ? `Cluster "${name}" removed` : `Cluster "${name}" not found` });
    }

    // -----------------------------------------------------------------------
    // Spoke API — Hub/Spoke federation (same MCP server image on every cluster)
    // Spokes register their URL; hub proxies API calls to them for identical results.
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/spoke/register" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { clusterName, spokeUrl, platform, version } = body;
      if (!clusterName || !spokeUrl) return sendJson(res, 400, { error: "clusterName and spokeUrl required" });
      const entry = registerSpoke(clusterName, spokeUrl, { platform, version });
      // "hub-cluster" is the management cluster's own MCP server (the ACM
      // local-cluster pattern) — it must NOT appear as a separate cluster
      // card (the picker already shows the hub).
      if (clusterName === HUB_AGENT_CLUSTER || clusterName.toLowerCase() === HUB_AGENT_CLUSTER.toLowerCase()) {
        console.log(`[spoke] Local MCP server registered: ${spokeUrl} — this cluster's data plane now served by the spoke pipeline`);
        saveHubAgentSpoke({ spokeUrl, platform }).catch(() => {});
        const localLlmCfg = await getActiveLLMConfig().catch(() => null);
        const regHubProto = req.headers["x-forwarded-proto"] || "https";
        const regHubHost = req.headers.host || "";
        if (localLlmCfg && regHubHost) localLlmCfg.relayUrl = `${regHubProto}://${regHubHost}/api/llm/relay`;
        return sendJson(res, 200, { ok: true, message: `Local MCP server "${clusterName}" registered`, hubVersion: "1.2.0", llmConfig: localLlmCfg });
      }
      // Also register in _connectedAgents so the cluster picker sees it
      const existingKey = findClusterKey(clusterName);
      const existing = existingKey ? _connectedAgents.get(existingKey) : null;
      const now = new Date().toISOString();
      _connectedAgents.set(existingKey || clusterName, {
        ...(existing || {}),
        clusterName: existingKey || clusterName,
        platform: platform || "k8s",
        agentVersion: version || "1.2.0",
        agentType: "spoke-mcp",
        capabilities: ["full-mcp", "scan", "events", "metrics", "ai-reasoning", "actions"],
        actionsEnabled: true,
        registeredAt: entry.registeredAt,
        status: "live",
        source: "spoke",
        spokeUrl: entry.spokeUrl,
        lastHeartbeat: now,
        lastReportTime: now,
      });
      saveClustersToDB().catch(() => {});

      // Fetch summary from spoke so dashboard shows version/nodes/pods immediately
      fetchSpokeSummary(existingKey || clusterName, entry.spokeUrl).catch(() => {});

      const regLlmCfg = await getActiveLLMConfig().catch(() => null);
      const regProto = req.headers["x-forwarded-proto"] || "https";
      const regHost = req.headers.host || "";
      if (regLlmCfg && regHost) regLlmCfg.relayUrl = `${regProto}://${regHost}/api/llm/relay`;
      const _regDbReady = await dbEnabled();
      return sendJson(res, 200, { ok: true, message: `Spoke "${clusterName}" registered`, hubVersion: "1.2.0", llmConfig: regLlmCfg, dbRelay: _regDbReady });
    }

    if (url.pathname === "/api/spoke/heartbeat" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { clusterName, spokeUrl: hbSpokeUrl, platform: hbPlatform, ts, uptime, memMB, healthy, mcpVersion, buildHash, startedAt: spokeStartedAt } = body;
      if (!clusterName) return sendJson(res, 400, { error: "clusterName required" });
      // Self-healing: re-register the spoke if the registry was lost (e.g.
      // control-plane restart) — the heartbeat carries everything needed.
      if (hbSpokeUrl && !hasSpoke(clusterName)) {
        registerSpoke(clusterName, hbSpokeUrl, { platform: hbPlatform });
        console.log(`[spoke] Re-registered from heartbeat: ${clusterName} (${hbSpokeUrl})`);
        if (clusterName === HUB_AGENT_CLUSTER || clusterName.toLowerCase() === HUB_AGENT_CLUSTER.toLowerCase()) {
          saveHubAgentSpoke({ spokeUrl: hbSpokeUrl, platform: hbPlatform }).catch(() => {});
        }
      }
      updateSpokeHeartbeat(clusterName, { healthy, uptime, memMB });
      const key = findClusterKey(clusterName) || clusterName;
      const isHub = clusterName === HUB_AGENT_CLUSTER || clusterName.toLowerCase() === HUB_AGENT_CLUSTER.toLowerCase();
      let agent = _connectedAgents.get(key);
      if (!agent && !isHub) {
        const now = new Date().toISOString();
        agent = {
          clusterName: key,
          platform: hbPlatform || "k8s",
          agentType: "spoke-mcp",
          capabilities: ["full-mcp", "scan", "events", "metrics", "ai-reasoning", "actions"],
          actionsEnabled: true,
          registeredAt: now,
          status: "live",
          source: "spoke",
          spokeUrl: hbSpokeUrl,
          lastHeartbeat: now,
          lastReportTime: now,
        };
        _connectedAgents.set(key, agent);
        saveClustersToDB().catch(() => {});
        fetchSpokeSummary(key, hbSpokeUrl).catch(() => {});
        console.log(`[spoke] Restored _connectedAgents entry from heartbeat: ${key}`);
      }
      if (agent) {
        const now = new Date().toISOString();
        agent.lastHeartbeat = now;
        agent.lastReportTime = now;
        agent.agentHealthy = healthy !== false;
        agent.status = "live";
        if (mcpVersion) agent.mcpVersion = mcpVersion;
        if (buildHash) agent.buildHash = buildHash;
        if (spokeStartedAt) agent.mcpStartedAt = spokeStartedAt;
        _connectedAgents.set(key, agent);
      }
      const hbLlmCfg = await getActiveLLMConfig().catch(() => null);
      const hubProto = req.headers["x-forwarded-proto"] || "https";
      const hubHost = req.headers.host || "";
      if (hbLlmCfg && hubHost) {
        hbLlmCfg.relayUrl = `${hubProto}://${hubHost}/api/llm/relay`;
      }
      const _hbDbReady = await dbEnabled();
      return sendJson(res, 200, { ok: true, hubVersion: MCP_VERSION, llmConfig: hbLlmCfg, dbRelay: _hbDbReady });
    }

    // LLM relay — spoke pods route LLM calls through the hub so they don't
    // need direct network egress to Azure/OpenAI.
    if (url.pathname === "/api/llm/relay" && req.method === "POST") {
      const body = await readJsonBody(req);
      console.log(`[llm-relay] Request received: provider=${body?.provider || "?"}, messages=${body?.messages?.length ?? 0}`);
      if (!body || !body.messages) return sendJson(res, 400, { error: "messages required" });
      try {
        const result = await callLLM({
          messages: body.messages,
          provider: body.provider,
          apiUrl: body.apiUrl,
          apiKey: body.apiKey,
          model: body.model,
          maxTokens: body.maxTokens || 2000,
          temperature: body.temperature ?? 0.3,
          system: body.system || null,
          tools: body.tools || null,
          azureDeployment: body.azureDeployment,
          azureApiVersion: body.azureApiVersion,
        });
        return sendJson(res, 200, result);
      } catch (err) {
        console.error(`[llm-relay] Error: ${err.message}`);
        return sendJson(res, 502, { error: err.message });
      }
    }

    // DB relay — spokes route all DB queries through hub (no credentials leave hub).
    // Only hub (MCP_MODE !== spoke) serves this; prevents relay loops.
    if (url.pathname === "/api/db/query" && req.method === "POST") {
      if (MCP_MODE === "spoke") return sendJson(res, 403, { error: "relay not available on spoke" });
      const body = await readJsonBody(req);
      if (!body || !body.text) return sendJson(res, 400, { error: "text required" });
      try {
        const result = await dbQuery(body.text, body.params || []);
        if (!result) return sendJson(res, 503, { error: "database unavailable" });
        return sendJson(res, 200, { rows: result.rows, rowCount: result.rowCount });
      } catch (err) {
        console.error(`[db-relay] Query error: ${err.message}`);
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (url.pathname === "/api/spoke/status" && req.method === "GET") {
      return sendJson(res, 200, { spokes: getSpokeStatus() });
    }

    if (url.pathname === "/api/spoke/join-token" && req.method === "GET") {
      return sendJson(res, 200, { token: process.env.MCP_API_TOKEN || "" });
    }

    if (url.pathname === "/api/spoke/join-config" && req.method === "GET") {
      const platform = url.searchParams.get("platform") || "openshift";
      const clusterName = url.searchParams.get("clusterName") || "<cluster-name>";
      const hubToken = process.env.MCP_API_TOKEN || "";
      const hubHost = req.headers.host || "hub.example.com";
      const hubProto = req.headers["x-forwarded-proto"] || "https";
      const hubUrl = `${hubProto}://${hubHost}`;
      const image = process.env.MCP_IMAGE || "quay.io/karuppucs/openshift-mcp-server:latest";
      const spokeNs = platform === "openshift" ? "openshift-mcp" : "tcs-agentic-system";

      const command = [
        "./deploy/mcp/deploy.sh",
        `--hub-url ${hubUrl}`,
        `--hub-token ${hubToken || "<hub-token>"}`,
        `--cluster-name ${clusterName}`,
        `--platform ${platform}`,
        ...(platform === "openshift" ? ["--tls-skip"] : []),
      ].join(" \\\n  ");

      const yaml = `# TCS Agentic AI — MCP server deployment for ${clusterName} (${platform})
# Apply on the target cluster: kubectl apply -f mcp-server-join.yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: ${spokeNs}
  labels:
    app.kubernetes.io/name: agentic-ai-agent
    app.kubernetes.io/part-of: tcs-agentic-ai
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: agentic-ai-agent
  namespace: ${spokeNs}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: agentic-ai-agent-reader
rules:
  - apiGroups: [""]
    resources: [nodes, pods, pods/log, services, namespaces, events, resourcequotas,
                limitranges, configmaps, secrets, serviceaccounts, persistentvolumeclaims,
                persistentvolumes, endpoints, replicationcontrollers]
    verbs: [get, list, watch]
  - apiGroups: [apps]
    resources: [deployments, statefulsets, daemonsets, replicasets]
    verbs: [get, list, watch]
  - apiGroups: [batch]
    resources: [jobs, cronjobs]
    verbs: [get, list, watch]
  - apiGroups: [networking.k8s.io]
    resources: [networkpolicies, ingresses]
    verbs: [get, list, watch]
  - apiGroups: [rbac.authorization.k8s.io]
    resources: [roles, rolebindings, clusterroles, clusterrolebindings]
    verbs: [get, list, watch]
  - apiGroups: [storage.k8s.io]
    resources: [storageclasses, volumeattachments]
    verbs: [get, list, watch]
  - apiGroups: [autoscaling]
    resources: [horizontalpodautoscalers]
    verbs: [get, list, watch]
  - apiGroups: [policy]
    resources: [poddisruptionbudgets, podsecuritypolicies]
    verbs: [get, list, watch]
  - apiGroups: [metrics.k8s.io]
    resources: [nodes, pods]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: agentic-ai-agent-reader-binding
subjects:
  - kind: ServiceAccount
    name: agentic-ai-agent
    namespace: ${spokeNs}
roleRef:
  kind: ClusterRole
  name: agentic-ai-agent-reader
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: agentic-ai-agent-config
  namespace: ${spokeNs}
data:
  MCP_MODE: "spoke"
  MCP_TRANSPORT: "sse"
  MCP_SERVER_PORT: "3000"
  LOG_LEVEL: "info"
  HUB_URL: "${hubUrl}"
  CLUSTER_NAME: "${clusterName}"
  CLUSTER_PLATFORM: "${platform}"
  HUB_TLS_SKIP_VERIFY: "${platform === "openshift" ? "true" : "false"}"
  AUTH_MODE: "none"
  EMERGENCY_AUTO_FIX: "false"
  ALLOW_PRIVATE_CLUSTER_IPS: "true"
  DEPLOYMENT_NAME: "agentic-ai-agent"
  MCP_NAMESPACE: "${spokeNs}"
---
apiVersion: v1
kind: Secret
metadata:
  name: agentic-ai-agent-secrets
  namespace: ${spokeNs}
type: Opaque
stringData:
  MCP_API_TOKEN: ""
  HUB_API_TOKEN: "${hubToken}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agentic-ai-agent
  namespace: ${spokeNs}
  labels:
    app.kubernetes.io/name: agentic-ai-agent
    app.kubernetes.io/part-of: tcs-agentic-ai
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: agentic-ai-agent
  template:
    metadata:
      labels:
        app.kubernetes.io/name: agentic-ai-agent
    spec:
      serviceAccountName: agentic-ai-agent
      containers:
        - name: agentic-ai-agent
          image: ${image}
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef:
                name: agentic-ai-agent-config
            - secretRef:
                name: agentic-ai-agent-secrets
          env:
            - name: NODE_EXTRA_CA_CERTS
              value: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
            - name: NODE_OPTIONS
              value: "--max-old-space-size=768"
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "1"
          readinessProbe:
            httpGet:
              path: /readyz
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 15
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 15
            periodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: agentic-ai-agent
  namespace: ${spokeNs}
spec:
  selector:
    app.kubernetes.io/name: agentic-ai-agent
  ports:
    - port: 3000
      targetPort: 3000
      name: http`;

      return sendJson(res, 200, {
        hubUrl,
        hubTokenSet: !!hubToken,
        platform,
        clusterName,
        namespace: spokeNs,
        image,
        command,
        yaml,
      });
    }

    if (url.pathname.match(/^\/api\/spoke\/[^/]+$/) && req.method === "DELETE") {
      const spokeName = decodeURIComponent(url.pathname.split("/").pop());
      unregisterSpoke(spokeName);
      if (spokeName === HUB_AGENT_CLUSTER || spokeName.toLowerCase() === HUB_AGENT_CLUSTER.toLowerCase()) {
        dbQuery("DELETE FROM kv_store WHERE key = $1", ["hub_agent_spoke"]).catch(() => {});
      }
      return sendJson(res, 200, { ok: true, message: `Spoke "${spokeName}" removed` });
    }

    // -----------------------------------------------------------------------
    // Agent API — receives reports from remote TCS agents on clusters
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/agent/register" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { clusterName, platform, agentVersion, agentType, capabilities, apiUrl: agentApiUrl, actionsEnabled } = body;
      if (!clusterName) return sendJson(res, 400, { error: "clusterName required" });

      // Merge with existing entry: match by exact name, case-insensitive name, or API URL
      const existingKey = findClusterKey(clusterName, agentApiUrl);
      const existing = existingKey ? _connectedAgents.get(existingKey) : null;

      const entry = {
        ...(existing || {}),
        clusterName: existing?.clusterName || clusterName,
        platform: platform || existing?.platform,
        agentVersion,
        agentType: agentType || "standard",
        capabilities,
        actionsEnabled: actionsEnabled === true,
        registeredAt: existing?.registeredAt || new Date().toISOString(),
        lastReport: existing?.lastReport || null,
        status: "registered",
        source: existing?.source === "dashboard" ? "dashboard" : "agent",
        apiUrl: existing?.apiUrl || agentApiUrl || null,
        token: existing?.token || null,
      };

      // Remove old key if name changed (case mismatch)
      if (existingKey && existingKey !== entry.clusterName) {
        _connectedAgents.delete(existingKey);
      }
      _connectedAgents.set(entry.clusterName, entry);
      saveClustersToDB().catch(() => {});
      console.error(`[agent] Registered: ${entry.clusterName} (${platform}) agent v${agentVersion}${existingKey ? " (merged with " + existingKey + ")" : ""}`);

      const HUB_AGENT_VERSION = "1.2.0";
      return sendJson(res, 200, { ok: true, message: `Agent "${entry.clusterName}" registered`, hubVersion: HUB_AGENT_VERSION });
    }

    // Heartbeat protocol v1 — lightweight 30 s ping from agents
    // Thresholds: <90 s = healthy, 90-300 s = stale, >300 s = unreachable
    if (url.pathname === "/api/agent/heartbeat" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { clusterName, seq, ts, uptime, memMB, healthy, lastReportAge, mcpVersion, buildHash, startedAt: agentStartedAt } = body;
      if (!clusterName) return sendJson(res, 400, { error: "clusterName required" });
      const key = findClusterKey(clusterName) || clusterName;
      const agent = _connectedAgents.get(key);
      if (agent) {
        agent.lastHeartbeat = new Date().toISOString();
        agent.heartbeatSeq = seq || 0;
        agent.agentUptime = uptime;
        agent.agentMemMB = memMB;
        agent.agentHealthy = healthy !== false;
        agent.lastReportAge = lastReportAge;
        if (mcpVersion) agent.mcpVersion = mcpVersion;
        if (buildHash) agent.buildHash = buildHash;
        if (agentStartedAt) agent.mcpStartedAt = agentStartedAt;
        _connectedAgents.set(key, agent);
      }
      return sendJson(res, 200, { ok: true, hubVersion: MCP_VERSION });
    }

    if (url.pathname === "/api/agent/report" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { clusterName, platform, report } = body;
      if (!clusterName || !report) return sendJson(res, 400, { error: "clusterName and report required" });

      // Find existing entry by name (case-insensitive) to avoid duplicates
      const existingKey = findClusterKey(clusterName);
      const key = existingKey || clusterName;
      const agent = _connectedAgents.get(key) || { clusterName: key, platform };

      agent.lastReport = report;
      agent.lastReportTime = new Date().toISOString();
      agent.status = "live";
      if (!agent.source) agent.source = "agent";

      // Re-compute health on hub side using operators+nodes formula
      // to override any stale agent-side health calculation
      if (report.clusterHealth) {
        const degradedOps = report.clusterOperators?.degraded || 0;
        const totalN = report.nodes?.total || 0;
        const readyN = report.nodes?.ready || 0;
        if (degradedOps > 0) report.clusterHealth.status = "Degraded";
        else if (readyN < totalN) report.clusterHealth.status = "Warning";
        else report.clusterHealth.status = "Healthy";
      }

      // Clean up duplicate if agent reports under a different case
      if (existingKey && existingKey !== clusterName && !_connectedAgents.has(existingKey)) {
        // no-op, already using correct key
      }
      _connectedAgents.set(key, agent);
      saveClustersToDB().catch(() => {});
      // Phase 1: persist this cluster's snapshot to the per-cluster store.
      if (CLUSTER_STORE_ENABLED) {
        saveClusterSnapshot(key, platform || "kubernetes", report).catch((e) =>
          console.warn(`[store] snapshot save failed for ${key}:`, e.message)
        );
      }
      try {
        updateClusterDigest({
          cluster: key,
          version: report.clusterHealth?.version || report.version,
          platform: platform || "kubernetes",
          nodeCount: report.nodes?.total,
          readyNodes: report.nodes?.ready,
        });
      } catch {}
      const issues = report.pods?.issues?.length || 0;
      if (issues > 0) {
        console.error(`[agent] ${key}: ${issues} issues detected`);
      }
      return sendJson(res, 200, { ok: true, received: key });
    }

    // Phase 1: store observability — confirm the per-cluster snapshot store is
    // active and report how many clusters have persisted snapshots.
    if (url.pathname === "/api/hub/store/status" && req.method === "GET") {
      if (!CLUSTER_STORE_ENABLED) {
        return sendJson(res, 200, { enabled: false, mode: "in-memory", message: "Cluster snapshot store is disabled (CLUSTER_STORE_ENABLED=false)" });
      }
      try {
        const snapshots = await loadAllClusterSnapshots();
        return sendJson(res, 200, {
          enabled: true,
          mode: "postgres",
          dbConnected: await dbEnabled(),
          clusterCount: snapshots.length,
          clusters: snapshots.map((s) => ({
            cluster: s.cluster,
            platform: s.platform,
            reportedAt: s.reportedAt,
            ageSec: Math.round((Date.now() - new Date(s.reportedAt).getTime()) / 1000),
          })),
        });
      } catch (e) {
        return sendJson(res, 200, { enabled: true, mode: "postgres", dbConnected: false, error: e.message });
      }
    }

    if (url.pathname === "/api/agent/status" && req.method === "GET") {
      const agents = [];
      for (const [key, agent] of _connectedAgents) {
        const elapsed = agent.lastReportTime
          ? (Date.now() - new Date(agent.lastReportTime).getTime()) / 1000
          : null;
        agents.push({
          ...agent,
          name: key,
          token: undefined,
          hasToken: !!agent.token,
          mcpVersion: agent.mcpVersion || null,
          buildHash: agent.buildHash || null,
          mcpStartedAt: agent.mcpStartedAt || null,
          outdated: agent.mcpVersion ? agent.mcpVersion !== MCP_VERSION : null,
          status: elapsed !== null && elapsed < 300 ? "live" : elapsed !== null ? "stale" : "registered",
          lastReport: undefined,
          summary: agent.lastReport ? (() => {
            const _rpt = agent.lastReport;
            const _degOps = _rpt.clusterOperators?.degraded || 0;
            const _totN = _rpt.nodes?.total || 0;
            const _rdyN = _rpt.nodes?.ready || 0;
            const _hlth = _degOps > 0 ? "degraded" : (_rdyN < _totN ? "warning" : "healthy");
            const _evts = _rpt.events?.recent || [];
            const _critAlerts = _evts.filter(e => e.reason === "BackOff" || e.reason === "Failed" || e.reason === "Unhealthy" || e.reason === "OOMKilling").length + (_degOps > 0 ? _degOps : 0);
            const _warnAlerts = _evts.filter(e => e.reason !== "Normal" && e.reason !== "BackOff" && e.reason !== "Failed" && e.reason !== "Unhealthy" && e.reason !== "OOMKilling").length;
            const _connType = hasCredentials(agent.clusterName) ? "direct" : hasActiveChannel(agent.clusterName) ? "agent" : "spoke";
            return {
              version: _rpt.openshiftVersion || _rpt.kubernetesVersion || "",
              health: _hlth,
              nodes: `${_rdyN}/${_totN}`,
              pods: { running: _rpt.pods?.running || 0, total: _rpt.pods?.total || 0 },
              issues: _rpt.pods?.issues?.length || 0,
              warnings: _rpt.events?.warnings || 0,
              operators: { total: _rpt.clusterOperators?.total || 0, healthy: _rpt.clusterOperators?.healthy || 0, degraded: _degOps },
              alerts: { critical: _critAlerts, warning: _warnAlerts },
              cpu: _rpt.resourceSummary?.cpuPercent || null,
              memory: _rpt.resourceSummary?.memoryPercent || null,
              connectionType: _connType,
            };
          })() : null,
        });
      }
      // hubAgentDeployed: whether this cluster's own MCP agent pod is running.
      // The picker hides the hub card (like any other cluster) until it registers.
      return sendJson(res, 200, { agents, hubVersion: MCP_VERSION, hubAgentDeployed: hasSpoke(HUB_AGENT_CLUSTER) });
    }

    if (url.pathname.startsWith("/api/agent/scan/") && req.method === "GET") {
      const name = decodeURIComponent(url.pathname.split("/api/agent/scan/")[1]);
      const agent = _connectedAgents.get(name);
      if (!agent) return sendJson(res, 404, { error: "Agent not found" });
      return sendJson(res, 200, {
        clusterName: agent.clusterName,
        platform: agent.platform,
        lastReportTime: agent.lastReportTime,
        report: agent.lastReport,
      });
    }

    // -----------------------------------------------------------------------
    // Agent Bridge — bidirectional SSE channel for real-time tool invocation
    // -----------------------------------------------------------------------

    // Agent SSE channel — bidirectional bridge
    if (url.pathname === "/api/agent/channel" && req.method === "GET") {
      const clusterName = url.searchParams.get("cluster");
      if (!clusterName) return sendJson(res, 400, { error: "cluster parameter required" });
      handleAgentChannel(req, res, clusterName);
      return; // SSE — don't end response
    }

    // Agent registers its available tools
    if (url.pathname === "/api/agent/channel/register-tools" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { clusterName, tools } = body;
      if (!clusterName) return sendJson(res, 400, { error: "clusterName required" });
      handleToolRegistration(clusterName, tools || {});
      return sendJson(res, 200, { ok: true });
    }

    // Agent sends tool execution result
    if (url.pathname === "/api/agent/tool-response" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { requestId, clusterName, result } = body;
      if (!requestId) return sendJson(res, 400, { error: "requestId required" });
      const handled = handleToolResponse(requestId, clusterName, result);
      return sendJson(res, 200, { ok: handled });
    }

    // Get bridge channel status
    if (url.pathname === "/api/agent/channels" && req.method === "GET") {
      return sendJson(res, 200, { channels: getChannelStatus() });
    }

    // RBAC manifest — returns desired ClusterRole rules for a platform.
    // Honors the cluster's actions opt-in (or ?actions=true) to include
    // scoped write verbs for remote scale/restart/delete/cordon.
    if (url.pathname === "/api/agent/rbac-manifest" && req.method === "GET") {
      const platform = url.searchParams.get("platform") || "k8s";
      const clusterParam = url.searchParams.get("cluster");
      const agent = clusterParam ? _connectedAgents.get(findClusterKey(clusterParam) || clusterParam) : null;
      const withActions = url.searchParams.get("actions") === "true" || agent?.actionsEnabled === true;
      return sendJson(res, 200, { version: "1.2.0", actions: withActions, rules: buildDesiredRBACRules(platform, withActions) });
    }

    // Agent YAML download — returns the full deployment manifest for a registered cluster.
    // Usage: curl -O <hub>/api/agent/yaml/<clusterName>
    {
      const yamlMatch = url.pathname.match(/^\/api\/agent\/yaml\/([^/]+)$/);
      if (yamlMatch && req.method === "GET") {
        const rawName = decodeURIComponent(yamlMatch[1]);
        const clusterName = findClusterKey(rawName) || rawName;
        const agent = _connectedAgents.get(clusterName);
        const proto = req.headers["x-forwarded-proto"] || "https";
        const hubUrl = process.env.HUB_EXTERNAL_URL || process.env.HUB_SERVER_URL || `${proto}://${req.headers.host}`;
        const platform = url.searchParams.get("platform") || agent?.platform || "openshift";
        const hubToken = process.env.MCP_API_TOKEN || "";
        const yaml = generateAgentYAML(platform, agent?.clusterName || clusterName, agent?.apiUrl || "", !!agent?.actionsEnabled, hubUrl, hubToken);
        res.writeHead(200, {
          "Content-Type": "application/x-yaml",
          "Content-Disposition": `attachment; filename=agentic-ai-agent-${platform}.yaml`,
        });
        return res.end(yaml);
      }
    }

    // Agent YAML command helper — returns JSON with curl, kubectl/oc apply, and the full YAML.
    // Usage: curl <hub>/api/agent/yaml-cmd/<clusterName>
    {
      const yamlCmdMatch = url.pathname.match(/^\/api\/agent\/yaml-cmd\/([^/]+)$/);
      if (yamlCmdMatch && req.method === "GET") {
        const rawName = decodeURIComponent(yamlCmdMatch[1]);
        const clusterName = findClusterKey(rawName) || rawName;
        const agent = _connectedAgents.get(clusterName);
        const proto = req.headers["x-forwarded-proto"] || "https";
        const hubUrl = process.env.HUB_EXTERNAL_URL || process.env.HUB_SERVER_URL || `${proto}://${req.headers.host}`;
        const platform = url.searchParams.get("platform") || agent?.platform || "openshift";
        const cli = platform === "openshift" ? "oc" : "kubectl";
        const hubToken = process.env.MCP_API_TOKEN || "";
        const yaml = generateAgentYAML(platform, agent?.clusterName || clusterName, agent?.apiUrl || "", !!agent?.actionsEnabled, hubUrl, hubToken);
        const encodedName = encodeURIComponent(clusterName);
        return sendJson(res, 200, {
          curl: `curl -sL ${hubUrl}/api/agent/yaml/${encodedName} | ${cli} apply -f -`,
          apply: `${cli} apply -f agentic-ai-agent-${platform}.yaml`,
          yaml,
        });
      }
    }

    // Sync RBAC — push RBAC update to a specific agent or all agents (manual trigger)
    if (url.pathname === "/api/agent/push-rbac-update" && req.method === "POST") {
      const body = await readJsonBody(req);
      const target = body.clusterName;
      const event = { type: "rbac_update", version: "1.2.0", triggeredAt: new Date().toISOString() };
      if (target) {
        const sent = pushEventToAgent(target, event);
        return sendJson(res, 200, { ok: sent, target, message: sent ? "RBAC sync pushed" : "Agent not connected via SSE" });
      }
      const count = broadcastEvent(event);
      return sendJson(res, 200, { ok: true, agentsNotified: count });
    }

    // Redeploy — trigger rolling restart of agent deployment (after image rebuild)
    if (url.pathname === "/api/agent/rollout-restart" && req.method === "POST") {
      const body = await readJsonBody(req);
      const target = body.clusterName;
      const event = { type: "rollout_restart", triggeredAt: new Date().toISOString() };
      if (target) {
        const sent = pushEventToAgent(target, event);
        return sendJson(res, 200, { ok: sent, target, message: sent ? "Rollout restart triggered" : "Agent not connected via SSE" });
      }
      const count = broadcastEvent(event);
      return sendJson(res, 200, { ok: true, agentsNotified: count });
    }

    // -----------------------------------------------------------------------
    // Per-cluster agent management (kebab menu actions on cluster cards)
    // These resolve the cluster name from the URL path and wrap existing
    // bridge/registry primitives so the dashboard can act on a single agent.
    // -----------------------------------------------------------------------
    {
      const perAgentMatch = url.pathname.match(/^\/api\/agent\/([^/]+)\/(status|health-check|reconnect|rbac-sync|redeploy)$/);
      if (perAgentMatch) {
        const rawName = decodeURIComponent(perAgentMatch[1]);
        const action = perAgentMatch[2];
        const clusterName = findClusterKey(rawName) || rawName;
        const agent = _connectedAgents.get(clusterName);

        // Status Check — return the agent's last report summary + connection state
        if (action === "status" && req.method === "GET") {
          if (!agent) return sendJson(res, 404, { error: `Agent "${rawName}" not found` });
          const elapsed = agent.lastReportTime
            ? (Date.now() - new Date(agent.lastReportTime).getTime()) / 1000
            : null;
          const channels = getChannelStatus();
          return sendJson(res, 200, {
            clusterName: agent.clusterName,
            platform: agent.platform,
            agentVersion: agent.agentVersion || null,
            mcpVersion: agent.mcpVersion || null,
            buildHash: agent.buildHash || null,
            mcpStartedAt: agent.mcpStartedAt || null,
            hubVersion: MCP_VERSION,
            outdated: agent.mcpVersion ? agent.mcpVersion !== MCP_VERSION : null,
            status: elapsed !== null && elapsed < 300 ? "live" : elapsed !== null ? "stale" : "registered",
            registeredAt: agent.registeredAt || null,
            lastReportTime: agent.lastReportTime || null,
            lastHeartbeat: agent.lastHeartbeat || null,
            lastReportAgeSec: elapsed !== null ? Math.round(elapsed) : null,
            bridgeConnected: !!channels[clusterName],
            actionsEnabled: !!agent.actionsEnabled,
            summary: agent.lastReport ? {
              version: agent.lastReport.openshiftVersion || agent.lastReport.kubernetesVersion || "",
              health: agent.lastReport.clusterHealth?.status || "",
              nodes: `${agent.lastReport.nodes?.ready || 0}/${agent.lastReport.nodes?.total || 0}`,
              pods: agent.lastReport.pods?.total || 0,
              issues: agent.lastReport.pods?.issues?.length || 0,
              warnings: agent.lastReport.events?.warnings || 0,
            } : null,
          });
        }

        // Verify Health — 3-tier: spoke proxy → SSE bridge → direct API
        if (action === "health-check" && req.method === "POST") {
          if (!agent) return sendJson(res, 404, { error: `Agent "${rawName}" not found` });

          // 1. Try spoke proxy
          const spokeUrl = getSpokeUrl(clusterName);
          if (spokeUrl) {
            try {
              const proxyRes = await fedFetch(`${spokeUrl}/api/cluster/health-check`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(30000),
              });
              const data = await proxyRes.json().catch(() => ({}));
              agent.lastHealthCheck = new Date().toISOString();
              agent.lastHealthResult = data;
              return sendJson(res, 200, { ...data, ok: data.ok !== false, target: clusterName, proxiedTo: spokeUrl });
            } catch (err) {
              // Fall through
            }
          }

          // 2. Try SSE agent bridge
          try {
            const result = await invokeAgentTool(clusterName, "health_check", {});
            agent.lastHealthCheck = new Date().toISOString();
            agent.lastHealthResult = result;
            return sendJson(res, 200, { ok: true, target: clusterName, message: "Health check complete", result });
          } catch (e) {
            // Fall through to direct API
          }

          // 3. Try direct API (read nodes + operators)
          const _hasCreds = hasCredentials(clusterName) || (agent.apiUrl && agent.token);
          if (_hasCreds) {
            try {
              const { withClusterDirect, upsert: _credsUpsert } = await import("./utils/cluster-credentials.js");
              const { withRemoteCluster, ocpFetch } = await import("./utils/openshift-client.js");
              if (!hasCredentials(clusterName) && agent.apiUrl && agent.token) {
                await _credsUpsert(clusterName, agent.apiUrl, agent.token, agent.platform || "openshift", clusterName);
              }
              const checks = await withClusterDirect(clusterName, async () => {
                const result = {};
                const nodesRes = await ocpFetch("/api/v1/nodes").catch(() => null);
                if (nodesRes?.ok) {
                  const parsed = await nodesRes.json().catch(() => ({}));
                  const nodes = parsed.items || [];
                  const ready = nodes.filter(n => (n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True")).length;
                  result.nodes = { total: nodes.length, ready };
                }
                const opsRes = await ocpFetch("/apis/config.openshift.io/v1/clusteroperators").catch(() => null);
                if (opsRes?.ok) {
                  const parsed = await opsRes.json().catch(() => ({}));
                  const ops = parsed.items || [];
                  const degraded = ops.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
                  result.operators = { total: ops.length, healthy: ops.length - degraded.length, degraded: degraded.length, degradedNames: degraded.map(o => o.metadata?.name) };
                }
                result.apiServer = { reachable: true };
                return result;
              });
              const overall = (checks.operators?.degraded > 0) ? "degraded" : (checks.nodes && checks.nodes.ready < checks.nodes.total) ? "warning" : "healthy";
              agent.lastHealthCheck = new Date().toISOString();
              agent.lastHealthResult = checks;
              return sendJson(res, 200, { ok: true, target: clusterName, health: overall, checks, message: `Health via direct API: ${overall}`, via: "direct-api" });
            } catch (err) {
              // Fall through to cached report
            }
          }

          // 4. Fall back to last cached report
          if (agent.lastReport) {
            const lr = agent.lastReport;
            const health = lr.clusterHealth?.status || "unknown";
            return sendJson(res, 200, {
              ok: true,
              target: clusterName,
              health,
              via: "cached-report",
              message: `Using cached agent report (${agent.lastReportTime ? new Date(agent.lastReportTime).toLocaleString() : "unknown time"})`,
              checks: {
                nodes: lr.nodes || {},
                operators: lr.operators || {},
                pods: lr.pods || {},
                cachedAt: agent.lastReportTime,
              },
            });
          }

          return sendJson(res, 200, { ok: false, target: clusterName, message: "No spoke, SSE bridge, direct API credentials, or cached data available. Deploy the agent YAML on the target cluster to enable health checks." });
        }

        // Reconnect — 3-tier: SSE signal → spoke proxy restart → direct API pod restart
        if (action === "reconnect" && req.method === "POST") {
          // 1. Try SSE signal
          const event = { type: "reconnect", triggeredAt: new Date().toISOString() };
          const sent = pushEventToAgent(clusterName, event);
          if (sent) return sendJson(res, 200, { ok: true, target: clusterName, message: "Reconnect signal sent — agent will re-establish its connection" });

          // 2. Try spoke proxy restart (triggers agent pod restart which forces reconnect)
          const spokeUrl = getSpokeUrl(clusterName);
          if (spokeUrl) {
            try {
              const proxyRes = await fedFetch(`${spokeUrl}/api/cluster/redeploy`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(30000),
              });
              const data = await proxyRes.json().catch(() => ({}));
              if (proxyRes.ok) return sendJson(res, 200, { ok: true, target: clusterName, message: "Agent pod restarted via spoke — will reconnect within 60 seconds", proxiedTo: spokeUrl });
            } catch (err) {
              // Fall through
            }
          }

          // 3. Try direct API to restart agent pod
          const _hasReconnCreds = hasCredentials(clusterName) || (agent?.apiUrl && agent?.token);
          if (_hasReconnCreds) {
            try {
              const { withClusterDirect, upsert: _credsUpsert2 } = await import("./utils/cluster-credentials.js");
              const { ocpFetch } = await import("./utils/openshift-client.js");
              if (!hasCredentials(clusterName) && agent?.apiUrl && agent?.token) {
                await _credsUpsert2(clusterName, agent.apiUrl, agent.token, agent.platform || "openshift", clusterName);
              }
              await withClusterDirect(clusterName, async () => {
                const nsRes = await ocpFetch("/api/v1/namespaces").catch(() => null);
                const nsList = nsRes ? (await nsRes.json().catch(() => ({}))).items || [] : [];
                const agentNs = nsList.find(n => n.metadata?.name === "tcs-agentic-system" || n.metadata?.name === "openshift-tcs-agentic");
                const ns = agentNs?.metadata?.name || "tcs-agentic-system";
                const patch = JSON.stringify({ spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } });
                const patchRes = await ocpFetch(`/apis/apps/v1/namespaces/${ns}/deployments/tcs-agentic-ai`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/strategic-merge-patch+json" },
                  body: patch,
                });
                if (!patchRes.ok) throw new Error(`Patch failed: ${patchRes.status}`);
              });
              return sendJson(res, 200, { ok: true, target: clusterName, message: "Agent pod restarted via direct API — will reconnect within 60 seconds", via: "direct-api" });
            } catch (err) {
              // Fall through to guidance
            }
          }

          return sendJson(res, 200, {
            ok: false,
            target: clusterName,
            message: "Agent is not connected via SSE and no spoke or direct API credentials are available to restart it. Ensure the agent pod is deployed and running on the target cluster.",
            guidance: [
              "1. Verify agent pod is running: kubectl get pods -n tcs-agentic-system",
              "2. Check agent logs: kubectl logs -n tcs-agentic-system deploy/tcs-agentic-ai",
              "3. If not deployed, use 'Connect a Cluster' to get the deployment YAML",
            ],
          });
        }

        // Sync RBAC — push an RBAC update event to this agent
        if (action === "rbac-sync" && req.method === "POST") {
          const event = { type: "rbac_update", version: "1.2.0", triggeredAt: new Date().toISOString() };
          const sent = pushEventToAgent(clusterName, event);
          return sendJson(res, 200, { ok: sent, target: clusterName, message: sent ? "RBAC sync pushed" : "Agent not connected via SSE" });
        }

        // Redeploy — proxy rollout restart to spoke, SSE bridge, or direct API
        if (action === "redeploy" && req.method === "POST") {
          // 1. Try spoke proxy
          const spokeUrl = getSpokeUrl(clusterName);
          if (spokeUrl) {
            try {
              const proxyRes = await fedFetch(`${spokeUrl}/api/cluster/redeploy`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(30000),
              });
              const data = await proxyRes.json().catch(() => ({}));
              return sendJson(res, proxyRes.ok ? 200 : 502, { ...data, target: clusterName, proxiedTo: spokeUrl });
            } catch (err) {
              // Fall through to SSE/direct
            }
          }
          // 2. Try SSE agent bridge
          const event = { type: "rollout_restart", triggeredAt: new Date().toISOString() };
          const sent = pushEventToAgent(clusterName, event);
          if (sent) return sendJson(res, 200, { ok: true, target: clusterName, message: "Redeploy signal sent via agent bridge" });
          // 3. Try direct API access (Kubernetes PATCH to restart deployment)
          const _hasDeployCreds = hasCredentials(clusterName) || (agent?.apiUrl && agent?.token);
          if (_hasDeployCreds) {
            try {
              const { withClusterDirect, upsert: _credsUpsert3 } = await import("./utils/cluster-credentials.js");
              const { ocpFetch } = await import("./utils/openshift-client.js");
              if (!hasCredentials(clusterName) && agent?.apiUrl && agent?.token) {
                await _credsUpsert3(clusterName, agent.apiUrl, agent.token, agent.platform || "openshift", clusterName);
              }
              const result = await withClusterDirect(clusterName, async () => {
                const nsRes = await ocpFetch("/api/v1/namespaces").catch(() => null);
                const nsList = nsRes ? (await nsRes.json().catch(() => ({}))).items || [] : [];
                const agentNs = nsList.find(n => n.metadata?.name === "tcs-agentic-system" || n.metadata?.name === "openshift-tcs-agentic");
                const ns = agentNs?.metadata?.name || "tcs-agentic-system";
                const patch = JSON.stringify({ spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } });
                const patchRes = await ocpFetch(`/apis/apps/v1/namespaces/${ns}/deployments/tcs-agentic-ai`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/strategic-merge-patch+json" },
                  body: patch,
                });
                if (!patchRes.ok) throw new Error(`Patch failed: ${patchRes.status}`);
                return { ok: true, namespace: ns };
              });
              return sendJson(res, 200, { ok: true, target: clusterName, message: `Rollout restart triggered via direct API on ${result.namespace}` });
            } catch (err) {
              // Fall through to failure message
            }
          }
          return sendJson(res, 200, { ok: false, target: clusterName, message: "No spoke, agent bridge, or direct API credentials — cannot redeploy remotely" });
        }
      }

      // Remove Cluster — DELETE /api/agent/:name — drop from all registries
      const delMatch = url.pathname.match(/^\/api\/agent\/([^/]+)$/);
      if (delMatch && req.method === "DELETE") {
        const rawName = decodeURIComponent(delMatch[1]);
        const clusterName = findClusterKey(rawName) || rawName;
        const existed = _connectedAgents.delete(clusterName);
        try { pushEventToAgent(clusterName, { type: "deregister", triggeredAt: new Date().toISOString() }); } catch { /* best effort */ }
        // Clean up spoke registry
        try { unregisterSpoke(clusterName); } catch { /* best effort */ }
        // Clean up stored credentials (direct-access)
        try { await clusterCredsRemove(clusterName); } catch { /* best effort */ }
        // Clean up cluster snapshot from DB
        if (CLUSTER_STORE_ENABLED) {
          try { await deleteClusterSnapshot(clusterName); } catch { /* best effort */ }
        }
        return sendJson(res, existed ? 200 : 404, {
          ok: existed,
          target: clusterName,
          message: existed ? `Cluster "${clusterName}" removed from all registries` : `Cluster "${rawName}" not found`,
        });
      }
    }

    // LLM Settings API
    if (url.pathname === "/api/settings/llm" && req.method === "GET") {
      await handleLLMSettingsGet(req, res);
      return;
    }
    if (url.pathname === "/api/settings/llm" && req.method === "POST") {
      await handleLLMSettingsPost(req, res);
      return;
    }
    if (url.pathname === "/api/settings/llm/test" && req.method === "POST") {
      await handleLLMSettingsTest(req, res);
      return;
    }

    // ServiceNow settings — /api/settings/servicenow
    if (url.pathname === "/api/settings/servicenow" && req.method === "GET") {
      await handleServiceNowSettingsGet(req, res);
      return;
    }
    if (url.pathname === "/api/settings/servicenow" && req.method === "POST") {
      await handleServiceNowSettingsPost(req, res);
      return;
    }
    if (url.pathname === "/api/settings/servicenow/test" && req.method === "POST") {
      await handleServiceNowSettingsTest(req, res);
      return;
    }

    // LLM Chat API — /api/chat (POST)
    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (enforceRateLimit(req, res, { burst: 20, refillPerSec: 0.5 })) return;
      await handleChatAPI(req, res);
      return;
    }

    // Vision — analyze an uploaded/pasted screenshot (pod list, events, logs)
    // Wrapped in cluster context so live reconciliation targets the right cluster.
    if (req.method === "POST" && url.pathname === "/api/chat/analyze-image") {
      if (enforceRateLimit(req, res, { burst: 6, refillPerSec: 0.15 })) return;
      try { await withClusterContext(url, async () => { await handleImageAnalysisAPI(req, res); }); }
      catch (e) { if (!res.headersSent) sendJson(res, 500, { error: e.message }); }
      if (!res.headersSent) sendJson(res, 200, { error: "Image analysis unavailable." });
      return;
    }

    // Fleet AI — ask across ALL clusters (POST /api/fleet/chat)
    if (req.method === "POST" && url.pathname === "/api/fleet/chat") {
      if (enforceRateLimit(req, res, { burst: 10, refillPerSec: 0.3 })) return;
      await handleFleetChatAPI(req, res);
      return;
    }

    // Multi-LLM comparison — /api/chat/compare (POST)
    if (req.method === "POST" && url.pathname === "/api/chat/compare") {
      await handleChatCompareAPI(req, res);
      return;
    }

    // Deep investigation — /api/chat/investigate (POST)
    if (req.method === "POST" && url.pathname === "/api/chat/investigate") {
      await handleChatInvestigateAPI(req, res);
      return;
    }

    // AI Runbooks — /api/chat/runbook (POST)
    if (req.method === "POST" && url.pathname === "/api/chat/runbook") {
      await handleChatRunbookAPI(req, res);
      return;
    }

    // Chat feedback — /api/chat/feedback (POST) & /api/chat/feedback/stats (GET)
    if (req.method === "POST" && url.pathname === "/api/chat/feedback") {
      await handleFeedbackAPI(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/chat/feedback/stats") {
      await handleFeedbackStatsAPI(req, res);
      return;
    }

    // Execute fix API — /api/execute (POST) — rate-limited
    if (req.method === "POST" && url.pathname === "/api/execute") {
      if (enforceRateLimit(req, res, { burst: 10, refillPerSec: 0.2 })) return;
      await handleExecuteAPI(req, res);
      return;
    }

    // LLM risk analysis — /api/risk-analysis (POST)
    if (req.method === "POST" && url.pathname === "/api/risk-analysis") {
      if (enforceRateLimit(req, res, { burst: 5, refillPerSec: 0.1 })) return;
      await handleRiskAnalysisAPI(req, res);
      return;
    }

    // AI image vulnerability analysis — /api/ai/image-vuln-analysis (POST)
    if (req.method === "POST" && url.pathname === "/api/ai/image-vuln-analysis") {
      if (enforceRateLimit(req, res, { burst: 5, refillPerSec: 0.1 })) return;
      try { await withClusterContext(url, async () => { await handleImageVulnAnalysisAPI(req, res); }); }
      catch (e) { if (!res.headersSent) sendJson(res, 500, { findings: [], error: e.message }); }
      // Guarantee a JSON body even if withClusterContext skipped the handler
      // (e.g. selected cluster has no live bridge) — never leave the client
      // parsing an empty response ("Unexpected end of JSON input").
      if (!res.headersSent) sendJson(res, 200, { findings: [], error: "AI analysis unavailable for the selected cluster context." });
      return;
    }

    // ── Automation Hub · SOP Agent — extract text from an uploaded doc ──
    // Accepts a requirement document (.docx / .txt / .md / .yaml / .json) and
    // returns its plain text so the SOP Agent can generate manifests from it.
    if (req.method === "POST" && url.pathname === "/api/automation/extract-doc") {
      if (enforceRateLimit(req, res, { burst: 6, refillPerSec: 0.2 })) return;
      try {
        const ct = req.headers["content-type"] || "";
        if (!ct.includes("multipart/form-data")) { sendJson(res, 400, { error: "Upload a file (multipart/form-data)." }); return; }
        const raw = await readRawBody(req);
        const parts = parseMultipart(raw, ct);
        const filePart = parts.find((p) => p.filename);
        if (!filePart) { sendJson(res, 400, { error: "No file uploaded." }); return; }
        const name = (filePart.filename || "").toLowerCase();
        let text = "";
        if (name.endsWith(".docx")) {
          const parsed = await parseDocx(filePart.data);
          text = (parsed.sections || []).map((s) => `${s.heading || ""}\n${s.text || s.content || ""}`).join("\n") || parsed.text || "";
        } else if (name.endsWith(".pdf")) {
          try {
            // Import the lib path directly — pdf-parse's index.js has a debug
            // harness that throws under ESM.
            const pdf = (await import("pdf-parse/lib/pdf-parse.js")).default;
            const data = await pdf(filePart.data);
            text = data?.text || "";
          } catch (e) { sendJson(res, 200, { error: "Could not read the PDF: " + e.message + ". Try a text-based PDF, .docx, or paste the text." }); return; }
        } else if (name.endsWith(".doc")) {
          sendJson(res, 200, { error: "Legacy .doc isn't supported — save as .docx or .pdf, or paste the text." });
          return;
        } else {
          text = filePart.data.toString("utf8");
        }
        text = (text || "").trim().slice(0, 14000);
        if (!text) { sendJson(res, 200, { error: "Could not read any text from that file." }); return; }
        sendJson(res, 200, { text, filename: filePart.filename, chars: text.length });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Automation Hub · SOP Agent — generate manifests from a requirement ──
    if (req.method === "POST" && url.pathname === "/api/automation/generate-manifest") {
      if (enforceRateLimit(req, res, { burst: 5, refillPerSec: 0.1 })) return;
      try { await handleGenerateManifestAPI(req, res); }
      catch (e) { if (!res.headersSent) sendJson(res, 500, { error: e.message }); }
      if (!res.headersSent) sendJson(res, 200, { error: "Manifest generation unavailable." });
      return;
    }

    // ── Automation Hub · SOP Agent — deploy manifests to a chosen cluster ──
    if (req.method === "POST" && url.pathname === "/api/automation/deploy") {
      if (enforceRateLimit(req, res, { burst: 5, refillPerSec: 0.1 })) return;
      try {
        const body = await readJsonBody(req);
        // Prefer edited YAML if the user tweaked it in the UI; fall back to the
        // structured manifest objects from generation.
        let manifests = Array.isArray(body.manifests) ? body.manifests : [];
        if (typeof body.yaml === "string" && body.yaml.trim()) {
          try {
            manifests = yaml.loadAll(body.yaml).filter((d) => d && typeof d === "object" && d.kind);
          } catch (e) { sendJson(res, 200, { error: "The edited YAML could not be parsed: " + e.message }); return; }
        }
        const dryRun = body.dryRun !== false;
        const nsDefault = body.namespace || "";
        if (manifests.length === 0) { sendJson(res, 200, { error: "No manifests to deploy." }); return; }
        // Namespaced resource → REST collection path.
        const kindPath = (kind, ns) => ({
          deployment: `/apis/apps/v1/namespaces/${ns}/deployments`,
          statefulset: `/apis/apps/v1/namespaces/${ns}/statefulsets`,
          daemonset: `/apis/apps/v1/namespaces/${ns}/daemonsets`,
          service: `/api/v1/namespaces/${ns}/services`,
          route: `/apis/route.openshift.io/v1/namespaces/${ns}/routes`,
          ingress: `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`,
          configmap: `/api/v1/namespaces/${ns}/configmaps`,
          secret: `/api/v1/namespaces/${ns}/secrets`,
          persistentvolumeclaim: `/api/v1/namespaces/${ns}/persistentvolumeclaims`,
          serviceaccount: `/api/v1/namespaces/${ns}/serviceaccounts`,
          horizontalpodautoscaler: `/apis/autoscaling/v2/namespaces/${ns}/horizontalpodautoscalers`,
          role: `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles`,
          rolebinding: `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`,
          networkpolicy: `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`,
          resourcequota: `/api/v1/namespaces/${ns}/resourcequotas`,
          limitrange: `/api/v1/namespaces/${ns}/limitranges`,
          servicemonitor: `/apis/monitoring.coreos.com/v1/namespaces/${ns}/servicemonitors`,
          poddisruptionbudget: `/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets`,
          cronjob: `/apis/batch/v1/namespaces/${ns}/cronjobs`,
          job: `/apis/batch/v1/namespaces/${ns}/jobs`,
        }[(kind || "").toLowerCase()] || null);
        // Canonical apiVersion per kind — must match the REST path we POST to,
        // or the API server rejects the object (e.g. an LLM emitting
        // autoscaling/v2beta2 HPA against the /apis/autoscaling/v2 path).
        const kindApiVersion = (kind) => ({
          namespace: "v1", service: "v1", configmap: "v1", secret: "v1",
          persistentvolumeclaim: "v1", serviceaccount: "v1", resourcequota: "v1", limitrange: "v1",
          deployment: "apps/v1", statefulset: "apps/v1", daemonset: "apps/v1",
          route: "route.openshift.io/v1", ingress: "networking.k8s.io/v1", networkpolicy: "networking.k8s.io/v1",
          horizontalpodautoscaler: "autoscaling/v2",
          role: "rbac.authorization.k8s.io/v1", rolebinding: "rbac.authorization.k8s.io/v1",
          servicemonitor: "monitoring.coreos.com/v1", poddisruptionbudget: "policy/v1",
          cronjob: "batch/v1", job: "batch/v1",
        }[(kind || "").toLowerCase()] || null);
        // Apply in a dependency-safe order: namespace → policy/rbac/config → workloads → exposure.
        const applyRank = (kind) => ({
          namespace: 0,
          resourcequota: 1, limitrange: 1, networkpolicy: 1,
          serviceaccount: 2, role: 3, rolebinding: 4,
          secret: 2, configmap: 2, persistentvolumeclaim: 2,
          deployment: 6, statefulset: 6, daemonset: 6, cronjob: 6, job: 6,
          service: 5, route: 7, ingress: 7, horizontalpodautoscaler: 7,
          servicemonitor: 7, poddisruptionbudget: 7,
        }[(kind || "").toLowerCase()] ?? 5);
        const ordered = manifests
          .map((m, i) => ({ m, i }))
          .sort((a, b) => applyRank(a.m.kind) - applyRank(b.m.kind) || a.i - b.i)
          .map((x) => x.m);
        const result = await withClusterContext(url, async () => {
          const applied = [], failed = [];
          const nss = [...new Set(manifests.map(m => (m.kind || "").toLowerCase() === "namespace" ? m.metadata?.name : (m.metadata?.namespace || nsDefault)).filter(Boolean))];
          // Ensure target namespaces exist (real apply only). An explicit
          // Namespace manifest in the set is applied below with its full labels.
          if (!dryRun) for (const ns of nss) {
            try { await ocpPost(`/api/v1/namespaces`, { apiVersion: "v1", kind: "Namespace", metadata: { name: ns } }); } catch { /* exists */ }
          }
          for (const m of ordered) {
            const kind = (m.kind || "").toLowerCase();
            const q = dryRun ? "?dryRun=All" : "";
            // Namespace is cluster-scoped — apply directly, no namespace segment.
            if (kind === "namespace") {
              try { await ocpPost(`/api/v1/namespaces${q}`, m); applied.push(`Namespace/${m.metadata?.name}`); }
              catch (e) {
                if (!dryRun && m.metadata?.name) {
                  try { await ocpPatch(`/api/v1/namespaces/${m.metadata.name}`, m, "application/merge-patch+json"); applied.push(`Namespace/${m.metadata.name} (updated)`); }
                  catch (e2) { failed.push({ kind: m.kind, name: m.metadata?.name, error: e2.message || e.message }); }
                } else failed.push({ kind: m.kind, name: m.metadata?.name, error: e.message });
              }
              continue;
            }
            const ns = (m.metadata && (m.metadata.namespace || nsDefault)) || nsDefault;
            if (m.metadata) m.metadata.namespace = ns;
            const path = kindPath(m.kind, ns);
            if (!path) { failed.push({ kind: m.kind, name: m.metadata?.name, error: "unsupported kind" }); continue; }
            // Force the apiVersion to match the path we're posting to.
            const canonical = kindApiVersion(m.kind);
            if (canonical) m.apiVersion = canonical;
            try { await ocpPost(path + q, m); applied.push(`${m.kind}/${m.metadata?.name}`); }
            catch (e) {
              if (!dryRun && m.metadata?.name) {
                try { await ocpPatch(`${path}/${m.metadata.name}`, m, "application/merge-patch+json"); applied.push(`${m.kind}/${m.metadata.name} (updated)`); }
                // A 404 on the update fallback means the object never existed —
                // the CREATE error is the real story, so surface that one.
                catch (e2) { failed.push({ kind: m.kind, name: m.metadata?.name, error: /404|NotFound/i.test(e2.message || "") ? (e.message || e2.message) : (e2.message || e.message) }); }
              } else failed.push({ kind: m.kind, name: m.metadata?.name, error: e.message });
            }
          }
          return { dryRun, applied, failed, namespaces: nss };
        });
        if (result === null) { sendJson(res, 200, { error: "Selected cluster is not reachable for deployment." }); return; }
        sendJson(res, 200, result);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── App Deployment Agent · shift-left CIS check on GENERATED manifests ──
    // Static Pod Security / CIS evaluation of the manifest YAML before deploy.
    // No cluster needed — inspects the manifests themselves.
    if (req.method === "POST" && url.pathname === "/api/automation/cis-check") {
      if (enforceRateLimit(req, res, { burst: 8, refillPerSec: 0.2 })) return;
      try {
        const body = await readJsonBody(req);
        let manifests = Array.isArray(body.manifests) ? body.manifests : [];
        if (typeof body.yaml === "string" && body.yaml.trim()) {
          try { manifests = yaml.loadAll(body.yaml).filter((d) => d && typeof d === "object" && d.kind); }
          catch (e) { sendJson(res, 200, { error: "YAML could not be parsed: " + e.message }); return; }
        }
        if (manifests.length === 0) { sendJson(res, 200, { error: "No manifests to check." }); return; }
        sendJson(res, 200, cisCheckManifests(manifests));
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── App Deployment Agent · shift-left image scan on GENERATED manifests ──
    // Image hygiene on every referenced image, optionally enriched with real
    // CVE counts from the selected cluster's Trivy Operator reports.
    if (req.method === "POST" && url.pathname === "/api/automation/image-scan") {
      if (enforceRateLimit(req, res, { burst: 8, refillPerSec: 0.2 })) return;
      try {
        const body = await readJsonBody(req);
        let manifests = Array.isArray(body.manifests) ? body.manifests : [];
        if (typeof body.yaml === "string" && body.yaml.trim()) {
          try { manifests = yaml.loadAll(body.yaml).filter((d) => d && typeof d === "object" && d.kind); }
          catch (e) { sendJson(res, 200, { error: "YAML could not be parsed: " + e.message }); return; }
        }
        if (manifests.length === 0) { sendJson(res, 200, { error: "No manifests to scan." }); return; }
        // Enrich against the chosen cluster's Trivy reports when reachable;
        // fall back to hygiene-only if the cluster context isn't available.
        let out = await withClusterContext(url, async () => scanManifestImages(manifests, { enrich: true }));
        if (out === null) out = await scanManifestImages(manifests, { enrich: false });
        sendJson(res, 200, out);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── App Deployment Agent · live pod status (terminal-style watch) ──
    // kubectl-like rows (NAME READY STATUS RESTARTS AGE) for the deployed
    // namespace + workload rollout + route URLs. Polled by the console after
    // a real deploy so the user watches the app come up without any CLI.
    if (req.method === "GET" && url.pathname === "/api/automation/app-status") {
      try {
        const ns = url.searchParams.get("namespace");
        if (!ns) { sendJson(res, 200, { error: "namespace query param is required" }); return; }
        const out = await withClusterContext(url, async () => {
          const safe = async (p) => { try { return await ocpGet(p); } catch { return { items: [] }; } };
          const [pods, deps, stss, dss, routes] = await Promise.all([
            safe(`/api/v1/namespaces/${ns}/pods`),
            safe(`/apis/apps/v1/namespaces/${ns}/deployments`),
            safe(`/apis/apps/v1/namespaces/${ns}/statefulsets`),
            safe(`/apis/apps/v1/namespaces/${ns}/daemonsets`),
            safe(`/apis/route.openshift.io/v1/namespaces/${ns}/routes`),
          ]);
          const age = (ts) => {
            if (!ts) return "—";
            const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
            if (s < 60) return s + "s";
            if (s < 3600) return Math.floor(s / 60) + "m";
            if (s < 86400) return Math.floor(s / 3600) + "h";
            return Math.floor(s / 86400) + "d";
          };
          const podRows = (pods.items || []).map((p) => {
            const spec = p.spec || {}, st = p.status || {};
            const cs = st.containerStatuses || [];
            const ics = st.initContainerStatuses || [];
            const total = (spec.containers || []).length;
            const readyN = cs.filter((c) => c.ready).length;
            const restarts = [...cs, ...ics].reduce((s, c) => s + (c.restartCount || 0), 0);
            // kubectl-style STATUS: Terminating > Init:* > waiting reason > Completed > terminated error > phase
            let status = st.phase || "Unknown";
            if (p.metadata?.deletionTimestamp) status = "Terminating";
            else {
              const initTotal = (spec.initContainers || []).length;
              const initDone = ics.filter((c) => c.state?.terminated?.exitCode === 0).length;
              const initWait = ics.find((c) => c.state?.waiting?.reason && c.state.waiting.reason !== "PodInitializing");
              if (initTotal > 0 && initDone < initTotal) status = initWait ? `Init:${initWait.state.waiting.reason}` : `Init:${initDone}/${initTotal}`;
              else {
                const w = cs.find((c) => c.state?.waiting?.reason);
                if (w) status = w.state.waiting.reason;
                else if (st.phase === "Succeeded") status = "Completed";
                else {
                  const t = cs.find((c) => c.state?.terminated?.reason && c.state.terminated.exitCode !== 0);
                  if (t) status = t.state.terminated.reason;
                }
              }
            }
            return { name: p.metadata?.name || "?", ready: `${readyN}/${total}`, status, restarts, age: age(p.metadata?.creationTimestamp) };
          }).sort((a, b) => a.name.localeCompare(b.name));
          const wl = [];
          for (const d of (deps.items || [])) wl.push({ kind: "deployment", name: d.metadata?.name, ready: d.status?.readyReplicas || 0, desired: d.spec?.replicas ?? 0 });
          for (const s2 of (stss.items || [])) wl.push({ kind: "statefulset", name: s2.metadata?.name, ready: s2.status?.readyReplicas || 0, desired: s2.spec?.replicas ?? 0 });
          for (const d of (dss.items || [])) wl.push({ kind: "daemonset", name: d.metadata?.name, ready: d.status?.numberReady || 0, desired: d.status?.desiredNumberScheduled ?? 0 });
          const BAD = /BackOff|Err|Error|Failed|OOM|Invalid|CreateContainer|Unschedulable/;
          const active = podRows.filter((r) => r.status !== "Completed" && r.status !== "Terminating");
          const fullyReady = (r) => { const [a, b] = r.ready.split("/").map(Number); return a === b && b > 0; };
          const allReady = wl.length > 0
            && wl.every((w) => w.ready >= w.desired)
            && active.length > 0
            && active.every((r) => r.status === "Running" && fullyReady(r))
            && !active.some((r) => BAD.test(r.status));
          return {
            namespace: ns, timestamp: new Date().toISOString(),
            pods: podRows, workloads: wl,
            routes: (routes.items || []).map((r) => ({ name: r.metadata?.name, host: r.spec?.host, tls: !!r.spec?.tls })),
            allReady,
            failing: active.filter((r) => BAD.test(r.status)).length,
          };
        });
        if (out === null) { sendJson(res, 200, { error: "Selected cluster is not reachable." }); return; }
        sendJson(res, 200, out);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Automation Hub · ServiceNow Agent — list platform incidents ──
    if (req.method === "GET" && url.pathname === "/api/servicenow/incidents") {
      try {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "25", 10), 100);
        // scope=platform (default) → only incidents THIS platform raised (caller
        // is the integration user). scope=all → every open incident.
        const scope = (url.searchParams.get("scope") || "platform").toLowerCase();
        let incidents = [], source = "servicenow", note = null, scopeApplied = scope;
        try {
          // OPEN only: active AND not Resolved(6)/Closed(7)/Cancelled(8).
          let query = "active=true^stateNOT IN6,7,8";
          if (scope === "platform") {
            let callerSysId = "";
            try { callerSysId = await snowResolveCallerSysId(); } catch { callerSysId = ""; }
            if (callerSysId) query += `^caller_id=${callerSysId}`;
            else scopeApplied = "all"; // couldn't resolve integration user → fall back
          }
          query += "^ORDERBYDESCsys_created_on";
          const recsRaw = await snowQueryRecords("incident", query, limit);
          // ServiceNow Table API returns { result: [...] }; be tolerant of either shape.
          const recs = Array.isArray(recsRaw) ? recsRaw : (recsRaw?.result || []);
          const STATE_LABEL = { "1": "New", "2": "In Progress", "3": "On Hold", "6": "Resolved", "7": "Closed", "8": "Cancelled" };
          const grab = (r, s) => { const m = `${r.short_description || ""} ${r.description || ""} ${r.work_notes || ""} ${r.comments || ""}`.match(s); return m ? m[1].trim() : null; };
          // Deterministic dedup fingerprint: normalized summary (digits/uuids
          // stripped) + namespace + resource. Same fingerprint ⇒ same issue.
          const fp = (r, ns, resource) => {
            const s = String(r.short_description || "").toLowerCase()
              .replace(/[0-9a-f]{6,}/g, "#").replace(/\d+/g, "#").replace(/[^a-z#]+/g, " ").trim();
            return `${s}|${ns || ""}|${resource || ""}`;
          };
          incidents = recs.map(r => {
            const ns = grab(r, /namespace[:\s]+([a-z0-9-]+)/i);
            const resource = grab(r, /(?:pod|deployment|workload)[:\s]+([a-z0-9.\/-]+)/i);
            return {
              sysId: r.sys_id, number: r.number,
              shortDescription: r.short_description || "(no summary)",
              description: (r.description || "").slice(0, 600),
              severity: r.severity || r.urgency || r.priority || "—",
              state: r.state, stateLabel: STATE_LABEL[String(r.state)] || `state ${r.state}`,
              createdOn: r.sys_created_on || r.opened_at,
              cluster: grab(r, /cluster[:\s]+([a-zA-Z0-9._-]+)/i) || grab(r, /"?cluster"?\s*[:=]\s*"?([a-zA-Z0-9._-]+)/i),
              namespace: ns,
              resource,
              fingerprint: fp(r, ns, resource),
            };
          });
        } catch (e) { source = "unavailable"; note = e.message; }
        // Deterministic duplicate grouping (server-side hint; AI does the deep pass).
        const seen = new Map();
        for (const inc of incidents) {
          if (!seen.has(inc.fingerprint)) { seen.set(inc.fingerprint, inc.number); inc.duplicateOf = null; }
          else inc.duplicateOf = seen.get(inc.fingerprint);
        }
        const uniqueCount = seen.size;
        sendJson(res, 200, { source, count: incidents.length, uniqueCount, scope: scopeApplied, openOnly: true, incidents, note });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Automation Hub · ServiceNow Agent — AI correlation, dedup & triage ──
    if (req.method === "POST" && url.pathname === "/api/servicenow/incidents/analyze") {
      if (enforceRateLimit(req, res, { burst: 4, refillPerSec: 0.1 })) return;
      try { await handleIncidentCorrelationAPI(req, res); }
      catch (e) { if (!res.headersSent) sendJson(res, 500, { error: e.message }); }
      if (!res.headersSent) sendJson(res, 200, { error: "Correlation unavailable." });
      return;
    }

    // ── Automation Hub · ServiceNow Agent — one-click fix + close incident ──
    // Safe, universal remediation: rolling-restart the affected workload on its
    // cluster, then close the incident in ServiceNow. Dry-run by default.
    if (req.method === "POST" && url.pathname === "/api/servicenow/incidents/fix") {
      if (enforceRateLimit(req, res, { burst: 5, refillPerSec: 0.1 })) return;
      try {
        const body = await readJsonBody(req);
        const { sysId, namespace, resource, closeNotes } = body;
        const dryRun = body.dryRun !== false;
        // closeOnly: the issue was validated as already resolved — close the
        // incident(s) in ServiceNow WITHOUT touching the cluster.
        const closeOnly = body.closeOnly === true;
        const podName = String(resource || "").split("/")[0];
        let result;
        if (closeOnly) {
          const action = `Close only — no cluster change (validated ${resource || "workload"} already healthy)`;
          if (dryRun) { sendJson(res, 200, { dryRun: true, closeOnly: true, action, namespace }); return; }
          result = { dryRun: false, closeOnly: true, action, namespace };
        } else {
        if (!namespace || !resource) { sendJson(res, 200, { error: "This incident has no namespace/workload to fix automatically — resolve it manually." }); return; }
        result = await withClusterContext(url, async () => {
          let workloadName = null, kind = "deployment";
          try {
            const pod = await ocpGet(`/api/v1/namespaces/${namespace}/pods/${podName}`);
            const refs = pod.metadata?.ownerReferences || [];
            const rsRef = refs.find(o => o.kind === "ReplicaSet");
            if (rsRef) {
              const rs = await ocpGet(`/apis/apps/v1/namespaces/${namespace}/replicasets/${rsRef.name}`);
              const depRef = (rs.metadata?.ownerReferences || []).find(o => o.kind === "Deployment");
              if (depRef) { workloadName = depRef.name; kind = "deployment"; }
            }
            if (!workloadName) {
              const other = refs.find(o => ["StatefulSet", "DaemonSet"].includes(o.kind));
              if (other) { workloadName = other.name; kind = other.kind.toLowerCase(); }
            }
          } catch (e) { return { error: `Could not resolve the workload for pod ${podName}: ${e.message}` }; }
          if (!workloadName) return { error: `Could not find the owning workload for pod ${podName} — fix manually.` };
          const plural = kind === "statefulset" ? "statefulsets" : kind === "daemonset" ? "daemonsets" : "deployments";
          const path = `/apis/apps/v1/namespaces/${namespace}/${plural}/${workloadName}`;
          const action = `Rolling restart ${kind}/${workloadName} in namespace ${namespace}`;
          if (dryRun) return { dryRun: true, action, workload: `${kind}/${workloadName}`, namespace };
          const patch = { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } };
          await ocpPatch(path, patch, "application/strategic-merge-patch+json");
          return { dryRun: false, action, workload: `${kind}/${workloadName}`, namespace };
        });
        }
        if (result === null) { sendJson(res, 200, { error: "Incident's cluster is not reachable." }); return; }
        if (result.error) { sendJson(res, 200, { error: result.error }); return; }
        let incidentClosed = null;
        // Optionally close correlated duplicates/dependents that this same fix
        // resolves — passed as [{ sysId, number }] from the correlation view.
        const alsoClose = Array.isArray(body.alsoClose) ? body.alsoClose.slice(0, 25) : [];
        const closedRelated = [];
        if (result.dryRun === false && sysId) {
          const noteBase = result.closeOnly
            ? `Closed by TCS Agentic AI — validated already healthy, no change required`
            : `Resolved by TCS Agentic AI — ${result.action}`;
          try {
            const c = await snowResolveIncident(sysId, { closeNotes: closeNotes || noteBase, resolution: null });
            incidentClosed = { success: c?.closed === true, detailsSaved: c?.detailsSaved === true, closeError: c?.closeError || null };
          } catch (e) { incidentClosed = { success: false, error: e.message }; }
          for (const dup of alsoClose) {
            const dupSysId = dup?.sysId; if (!dupSysId || dupSysId === sysId) continue;
            try {
              const c = await snowResolveIncident(dupSysId, { closeNotes: `Resolved by TCS Agentic AI — duplicate/correlated with ${body.primaryNumber || "primary incident"}; fixed via: ${result.action}`, resolution: null });
              closedRelated.push({ number: dup.number || dupSysId, closed: c?.closed === true, detailsSaved: c?.detailsSaved === true });
            } catch (e) { closedRelated.push({ number: dup.number || dupSysId, closed: false, error: e.message }); }
          }
        }
        // Fleet memory: applied fixes become retrievable experience for future RCA.
        if (result.dryRun === false) fleetRemember({
          kind: "incident-fix",
          cluster: url.searchParams.get("cluster") || "local",
          namespace, workload: result.workload || null,
          symptom: (body.symptom || `ServiceNow incident ${body.primaryNumber || sysId || ""}`).slice(0, 300),
          action: result.action,
          outcome: result.closeOnly ? "closed-no-change-needed" : "fix-applied",
        });
        sendJson(res, 200, { ...result, incidentClosed, closedRelated });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Automation Hub · ServiceNow Agent — LIVE pre-flight validation ──
    // Before applying any change, check the CURRENT state of the affected
    // workload on the chosen cluster. An incident may still be open in
    // ServiceNow while the problem has already been resolved. Returns whether
    // the issue is still present and whether to fix or just close.
    if (req.method === "POST" && url.pathname === "/api/servicenow/incidents/validate") {
      if (enforceRateLimit(req, res, { burst: 8, refillPerSec: 0.2 })) return;
      try {
        const body = await readJsonBody(req);
        const { namespace, resource } = body;
        if (!namespace || !resource) { sendJson(res, 200, { error: "No namespace/workload on this incident to validate." }); return; }
        const podName = String(resource).split("/")[0];
        const BAD = /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|InvalidImageName|CreateContainer|RunContainer|CreateContainerConfigError/;
        const evalPods = (pods) => {
          const bad = [];
          let anyUnready = false, maxRestarts = 0, readyRunning = 0;
          for (const p of pods) {
            const phase = p.status?.phase;
            const cs = p.status?.containerStatuses || [];
            for (const c of cs) {
              maxRestarts = Math.max(maxRestarts, c.restartCount || 0);
              const wr = c.state?.waiting?.reason;
              if (wr && BAD.test(wr)) bad.push(wr);
              if (c.ready === false && phase === "Running") anyUnready = true;
              if (c.lastState?.terminated?.reason === "OOMKilled") bad.push("OOMKilled");
            }
            if (phase === "Failed") bad.push("PodFailed");
            if (phase === "Pending" && (p.status?.conditions || []).some(c => c.type === "PodScheduled" && c.status === "False")) bad.push("Unschedulable");
            if (phase === "Running" && cs.length > 0 && cs.every(c => c.ready)) readyRunning++;
          }
          return { badReasons: [...new Set(bad)], anyUnready, maxRestarts, readyRunning, total: pods.length };
        };
        const out = await withClusterContext(url, async () => {
          let pods = [], mode = "exact";
          try {
            const pod = await ocpGet(`/api/v1/namespaces/${namespace}/pods/${podName}`);
            pods = [pod];
          } catch {
            // Exact pod is gone (replaced/deleted) — inspect current siblings.
            mode = "siblings";
            const seg = podName.split("-");
            const prefix = seg.length >= 3 ? seg.slice(0, -2).join("-") : seg.slice(0, -1).join("-");
            try {
              const list = await ocpGet(`/api/v1/namespaces/${namespace}/pods`);
              pods = (list.items || []).filter(p => (p.metadata?.name || "").startsWith(prefix ? prefix + "-" : podName));
            } catch { pods = []; }
          }
          if (pods.length === 0) {
            return { state: "gone", stillAffected: false, recommendation: "close",
              evidence: [`No pods matching "${podName}" are running in ${namespace}.`, "The workload was replaced or removed — there is nothing to restart."],
              summary: "The affected pod no longer exists and no replacement is failing. The problem appears already resolved — safe to close without any change.", checkedPods: 0 };
          }
          const e = evalPods(pods);
          const stillAffected = e.badReasons.length > 0 || e.anyUnready;
          const evidence = [];
          evidence.push(`${e.readyRunning}/${e.total} pod(s) Running & Ready${mode === "siblings" ? " (original pod was replaced)" : ""}.`);
          if (e.maxRestarts > 0) evidence.push(`Max restart count: ${e.maxRestarts}.`);
          if (e.badReasons.length) evidence.push(`Active failure signals: ${e.badReasons.join(", ")}.`);
          return {
            state: stillAffected ? "unhealthy" : (e.maxRestarts > 5 ? "recovered" : "healthy"),
            stillAffected,
            recommendation: stillAffected ? "fix" : "close",
            evidence,
            summary: stillAffected
              ? `The workload is STILL failing (${e.badReasons.join(", ") || "not ready"}). Applying the fix is recommended.`
              : `The workload is currently healthy (${e.readyRunning}/${e.total} ready)${e.maxRestarts > 5 ? " and has stabilised after earlier restarts" : ""}. The incident looks already resolved — you can close it without changes.`,
            checkedPods: e.total,
          };
        });
        if (out === null) { sendJson(res, 200, { error: "The selected cluster is not reachable for validation." }); return; }
        sendJson(res, 200, { namespace, resource, ...out });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // Agentic AI impact analysis for a CIS control — /api/compliance/impact-analysis (POST)
    if (req.method === "POST" && url.pathname === "/api/compliance/impact-analysis") {
      if (enforceRateLimit(req, res, { burst: 6, refillPerSec: 0.15 })) return;
      try { await withClusterContext(url, async () => { await handleComplianceImpactAPI(req, res); }); }
      catch (e) { if (!res.headersSent) sendJson(res, 500, { error: e.message }); }
      if (!res.headersSent) sendJson(res, 200, { error: "Impact analysis unavailable for the selected cluster context." });
      return;
    }

    // AI per-image remediation — /api/ai/image-remediation (POST)
    if (req.method === "POST" && url.pathname === "/api/ai/image-remediation") {
      if (enforceRateLimit(req, res, { burst: 8, refillPerSec: 0.2 })) return;
      try { await withClusterContext(url, async () => { await handleImageRemediationAPI(req, res); }); }
      catch (e) { if (!res.headersSent) sendJson(res, 500, { error: e.message }); }
      if (!res.headersSent) sendJson(res, 200, { error: "Remediation unavailable for the selected cluster context." });
      return;
    }

    // End-to-end image remediation (dry-run / apply + ServiceNow CR) — POST
    if (req.method === "POST" && url.pathname === "/api/security/remediate-image") {
      if (enforceRateLimit(req, res, { burst: 6, refillPerSec: 0.15 })) return;
      try { await withClusterContext(url, async () => { await handleImageRemediateAPI(req, res); }); }
      catch (e) { if (!res.headersSent) sendJson(res, 500, { error: e.message }); }
      if (!res.headersSent) sendJson(res, 200, { error: "Remediation unavailable for the selected cluster context." });
      return;
    }

    // AI resource optimization analysis — /api/ai/optimization-analysis (POST)
    if (req.method === "POST" && url.pathname === "/api/ai/optimization-analysis") {
      if (enforceRateLimit(req, res, { burst: 5, refillPerSec: 0.1 })) return;
      try { await withClusterContext(url, async () => { await handleOptimizationAnalysisAPI(req, res); }); }
      catch (e) { if (!res.headersSent) sendJson(res, 500, { error: e.message }); }
      if (!res.headersSent) sendJson(res, 200, { findings: [], error: "Optimization analysis unavailable for the selected cluster context." });
      return;
    }

    // SSE live cluster stream — /api/live-stream (GET)
    if (req.method === "GET" && url.pathname === "/api/live-stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("data: {\"type\":\"connected\"}\n\n");

      let closed = false;
      req.on("close", () => { closed = true; });

      const sendEvent = (type, payload) => {
        if (closed) return;
        try { res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`); } catch { closed = true; }
      };

      const gather = async () => {
        if (closed) return;
        try {
          const [podsResp, nodesResp, eventsResp, opsResp] = await Promise.all([
            ocpGet("/api/v1/pods").catch(() => ({ items: [] })),
            ocpGet("/api/v1/nodes").catch(() => ({ items: [] })),
            ocpGet("/api/v1/events?limit=100&fieldSelector=type!=Normal").catch(() => ({ items: [] })),
            ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => ({ items: [] })),
          ]);

          // Problem pods
          const problemPods = (podsResp.items || []).filter(p => {
            const phase = p.status?.phase;
            if (phase === "Failed" || phase === "Pending") return true;
            return (p.status?.containerStatuses || []).some(c =>
              c.state?.waiting?.reason === "CrashLoopBackOff" ||
              c.state?.waiting?.reason === "OOMKilled" ||
              c.state?.waiting?.reason === "ImagePullBackOff" ||
              c.state?.waiting?.reason === "ErrImagePull" ||
              c.state?.terminated?.reason === "OOMKilled" ||
              (c.restartCount || 0) > 10
            );
          }).slice(0, 50).map(p => ({
            name: p.metadata?.name,
            namespace: p.metadata?.namespace,
            phase: p.status?.phase,
            node: p.spec?.nodeName,
            containers: (p.status?.containerStatuses || []).map(c => ({
              name: c.name, ready: c.ready, restarts: c.restartCount || 0,
              state: Object.keys(c.state || {})[0] || "unknown",
              reason: c.state?.waiting?.reason || c.state?.terminated?.reason || null,
            })),
          }));

          // Nodes
          const nodes = (nodesResp.items || []).map(n => {
            const conds = {};
            (n.status?.conditions || []).forEach(c => { conds[c.type] = c.status; });
            return {
              name: n.metadata?.name,
              ready: conds.Ready === "True",
              memoryPressure: conds.MemoryPressure === "True",
              diskPressure: conds.DiskPressure === "True",
              pidPressure: conds.PIDPressure === "True",
              cpu: n.status?.capacity?.cpu,
              memory: n.status?.capacity?.memory,
            };
          });

          // Recent warning events
          const events = (eventsResp.items || []).slice(-30).map(e => ({
            reason: e.reason,
            message: (e.message || "").substring(0, 150),
            namespace: e.metadata?.namespace,
            object: (e.involvedObject?.kind || "") + "/" + (e.involvedObject?.name || ""),
            count: e.count || 1,
            lastSeen: e.lastTimestamp || e.eventTime,
          }));

          // Operators
          const operators = (opsResp.items || []).map(op => {
            const conds = (op.status?.conditions || []).reduce((a, c) => { a[c.type] = { status: c.status, message: c.message || "" }; return a; }, {});
            return {
              name: op.metadata?.name,
              degraded: conds.Degraded?.status === "True",
              available: conds.Available?.status === "True",
              progressing: conds.Progressing?.status === "True",
              message: conds.Degraded?.status === "True" ? (conds.Degraded.message || "").substring(0, 150) : "",
            };
          });

          const totalPods = (podsResp.items || []).length;
          const runningPods = (podsResp.items || []).filter(p => p.status?.phase === "Running").length;

          const clusterStatePayload = {
            ts: Date.now(),
            summary: {
              totalPods, runningPods, problemPods: problemPods.length,
              totalNodes: nodes.length, readyNodes: nodes.filter(n => n.ready).length,
              degradedOps: operators.filter(o => o.degraded).length,
              totalOps: operators.length,
              warningEvents: events.length,
            },
            problemPods,
            nodes,
            events,
            operators: operators.filter(o => o.degraded || o.progressing || !o.available),
          };
          _liveState = clusterStatePayload;
          sendEvent("cluster-state", clusterStatePayload);
        } catch (err) {
          sendEvent("error", { message: err.message });
        }
      };

      await gather();
      const interval = setInterval(gather, 15000);
      req.on("close", () => clearInterval(interval));
      return;
    }

    // CR tracking — /api/cr
    if (url.pathname === "/api/cr" || url.pathname.startsWith("/api/cr/")) {
      await handleCRTrackingAPI(url, req, res);
      return;
    }

    // Persistent chat history — /api/chats (DB-backed if Postgres configured)
    if (url.pathname === "/api/chats" || url.pathname.startsWith("/api/chats/")) {
      await handleChatHistoryAPI(url, req, res);
      return;
    }

    // Action approval workflow — /api/actions
    if (url.pathname === "/api/actions" || url.pathname.startsWith("/api/actions/")) {
      await handleActionsAPI(url, req, res);
      return;
    }

    // Prometheus metrics endpoint
    if (req.method === "GET" && url.pathname === "/metrics") {
      handleMetricsRequest(res);
      return;
    }

    // POST /api/feedback — thumbs up/down on assistant messages
    if (req.method === "POST" && url.pathname === "/api/feedback") {
      try {
        const body = await readJsonBody(req);
        const { conversationId, messageId, rating, comment } = body;
        if (rating == null) return sendJson(res, 400, { error: "Missing rating" });
        const r = await dbQuery(
          "INSERT INTO message_feedback (conversation_id, message_id, rating, comment) VALUES ($1, $2, $3, $4) RETURNING id",
          [conversationId || null, messageId || null, rating, comment || null]
        );
        return sendJson(res, 201, { id: r?.rows?.[0]?.id || null });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /api/audit — executed + pending actions + query analytics
    if (req.method === "GET" && url.pathname === "/api/audit") {
      try {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
        const auditCluster = url.searchParams.get("cluster") || null;
        const filterCluster = auditCluster && auditCluster !== "all";
        const cWhere = filterCluster ? " WHERE cluster = $2" : "";
        const cParams = filterCluster ? [limit, auditCluster] : [limit];
        const [executed, pending, queries, queryStats] = await Promise.all([
          dbQuery(
            `SELECT id, action, target, namespace, success, cluster, created_at FROM executed_actions${cWhere} ORDER BY id DESC LIMIT $1`,
            cParams
          ),
          dbQuery(
            "SELECT id, action, resource_type, resource_name, namespace, status, created_at FROM pending_actions ORDER BY created_at DESC LIMIT $1",
            [limit]
          ),
          dbQuery(
            `SELECT id, query, intents, cache_hit, duration_ms, cluster, created_at FROM query_log${cWhere} ORDER BY created_at DESC LIMIT $1`,
            cParams
          ),
          dbQuery(
            filterCluster
              ? `SELECT COUNT(*)::int AS total_queries, COUNT(*) FILTER (WHERE cache_hit)::int AS cache_hits, ROUND(AVG(duration_ms))::int AS avg_duration_ms FROM query_log WHERE cluster = $1`
              : `SELECT COUNT(*)::int AS total_queries, COUNT(*) FILTER (WHERE cache_hit)::int AS cache_hits, ROUND(AVG(duration_ms))::int AS avg_duration_ms FROM query_log`,
            filterCluster ? [auditCluster] : []
          ),
        ]);
        const stats = queryStats?.rows?.[0] || {};
        return sendJson(res, 200, {
          executed: executed?.rows || [],
          pending: pending?.rows || [],
          queries: queries?.rows || [],
          queryStats: {
            totalQueries: stats.total_queries || 0,
            cacheHits: stats.cache_hits || 0,
            avgDurationMs: stats.avg_duration_ms || 0,
          },
        });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /api/health-report — latest scheduled health check
    if (req.method === "GET" && url.pathname === "/api/health-report") {
      try {
        const report = await getLatestHealthReport();
        return sendJson(res, 200, { report: report || null });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /api/alerts/analyze — AI investigates a specific alert
    if (req.method === "POST" && url.pathname === "/api/alerts/analyze") {
      try {
        const body = await readJsonBody(req);
        const result = await analyzeAlert(body.alert || {}, body.llmOpts || {});
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // POST /api/guardrails/classify — get risk classification for a command
    if (req.method === "POST" && url.pathname === "/api/guardrails/classify") {
      try {
        const body = await readJsonBody(req);
        const classification = classifyCommand(body.command || "");
        return sendJson(res, 200, { classification });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // POST /api/guardrails/confirm — issue a confirmation token for destructive ops
    if (req.method === "POST" && url.pathname === "/api/guardrails/confirm") {
      try {
        const body = await readJsonBody(req);
        const command = body.command || "";
        if (!command) return sendJson(res, 400, { error: "command required" });
        const classification = classifyCommand(command);
        if (classification.level === "blocked") {
          return sendJson(res, 403, { error: "Command is permanently blocked", classification });
        }
        const token = issueConfirmationToken(command, body.userId || null);
        return sendJson(res, 200, { token, classification, expiresIn: 300 });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // -----------------------------------------------------------------------
    // Persistent Memory & User Preferences (Pillar 3)
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/user/preferences" && req.method === "GET") {
      const userId = getUserIdFromRequest(req) || url.searchParams.get("userId") || "default";
      const prefs = await getUserPreferences(userId);
      return sendJson(res, 200, { userId, preferences: prefs });
    }
    if (url.pathname === "/api/user/preferences" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const userId = getUserIdFromRequest(req) || body.userId || "default";
        await setUserPreferences(userId, body.preferences || body);
        const prefs = await getUserPreferences(userId);
        return sendJson(res, 200, { userId, preferences: prefs });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    if (url.pathname === "/api/user/facts" && req.method === "GET") {
      const userId = getUserIdFromRequest(req) || url.searchParams.get("userId") || "default";
      const factType = url.searchParams.get("type") || null;
      const facts = await getUserFacts(userId, factType, 20);
      return sendJson(res, 200, { userId, facts });
    }
    if (url.pathname === "/api/team/knowledge" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const entry = await addTeamKnowledge({
          topic: body.topic,
          content: body.content,
          tags: body.tags,
          contributedBy: getUserIdFromRequest(req) || body.contributedBy,
        });
        return sendJson(res, entry ? 201 : 500, entry || { error: "Failed to add" });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    if (url.pathname === "/api/team/knowledge" && req.method === "GET") {
      const search = url.searchParams.get("search") || "";
      const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "10", 10));
      const results = await searchTeamKnowledge(search, limit);
      return sendJson(res, 200, { results });
    }

    // -----------------------------------------------------------------------
    // Task Planner (Pillar 4)
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/plans" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        if (!body.goal) return sendJson(res, 400, { error: "goal required" });
        const plan = createPlan(body.goal, {
          userId: getUserIdFromRequest(req) || body.userId,
          conversationId: body.conversationId,
          ...body.context,
        });
        return sendJson(res, 201, { plan, planTag: renderPlanTag(plan) });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    if (url.pathname === "/api/plans" && req.method === "GET") {
      const userId = getUserIdFromRequest(req) || url.searchParams.get("userId");
      const status = url.searchParams.get("status");
      const plans = listPlans({ userId, status, limit: 30 });
      return sendJson(res, 200, { plans });
    }
    if (url.pathname.startsWith("/api/plans/") && req.method === "GET") {
      const planId = url.pathname.split("/")[3];
      const plan = getPlan(planId);
      if (!plan) return sendJson(res, 404, { error: "Plan not found" });
      return sendJson(res, 200, { plan, planTag: renderPlanTag(plan) });
    }
    if (url.pathname.match(/^\/api\/plans\/[^/]+\/approve$/) && req.method === "POST") {
      const planId = url.pathname.split("/")[3];
      const plan = await approvePlan(planId);
      if (!plan) return sendJson(res, 404, { error: "Plan not found" });
      return sendJson(res, 200, { plan });
    }
    if (url.pathname.match(/^\/api\/plans\/[^/]+\/rollback$/) && req.method === "POST") {
      const planId = url.pathname.split("/")[3];
      const result = await rollbackPlan(planId);
      if (!result) return sendJson(res, 404, { error: "Plan not found" });
      return sendJson(res, 200, result);
    }
    if (url.pathname.match(/^\/api\/plans\/[^/]+\/steps\/[^/]+$/) && req.method === "PATCH") {
      try {
        const parts = url.pathname.split("/");
        const planId = parts[3];
        const stepId = parts[5];
        const body = await readJsonBody(req);
        const plan = await markStepStatus(planId, stepId, body.status, {
          output: body.output, error: body.error, exitCode: body.exitCode,
        });
        if (!plan) return sendJson(res, 404, { error: "Plan or step not found" });
        return sendJson(res, 200, { plan });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // -----------------------------------------------------------------------
    // Integrations (Pillar 5) — Slack, Teams, PagerDuty, Webhook, Prometheus
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/integrations" && req.method === "GET") {
      const cfg = await getIntegrationsConfig();
      return sendJson(res, 200, { config: redactConfig(cfg) });
    }
    if (url.pathname === "/api/integrations" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const updated = await setIntegrationsConfig(body || {});
        return sendJson(res, 200, { config: redactConfig(updated) });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    if (url.pathname.match(/^\/api\/integrations\/test\/[^/]+$/) && req.method === "POST") {
      const type = url.pathname.split("/").pop();
      const result = await testConnection(type);
      return sendJson(res, 200, { type, result });
    }
    if (url.pathname === "/api/integrations/notify" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const results = await notifyAll(body);
        return sendJson(res, 200, { results });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    if (url.pathname === "/api/integrations/prometheus" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const result = await queryPrometheus(body.query, body);
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // -----------------------------------------------------------------------
    // Feature Flags — runtime state of each pillar
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/feature-flags" && req.method === "GET") {
      return sendJson(res, 200, { flags: flagSnapshot() });
    }

    // -----------------------------------------------------------------------
    // Reasoning Traces (Pillar 2)
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/reasoning/traces" && req.method === "GET") {
      const conversationId = url.searchParams.get("conversationId") || undefined;
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      const traces = await getRecentTraces({ conversationId, limit });
      return sendJson(res, 200, { traces });
    }

    // GET /api/audit-log — paginated audit history for Pillar 7 audit viewer
    if (req.method === "GET" && url.pathname === "/api/audit-log") {
      try {
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const riskLevel = url.searchParams.get("riskLevel") || undefined;
        const userId = url.searchParams.get("userId") || undefined;
        const hours = url.searchParams.get("hours") ? parseInt(url.searchParams.get("hours"), 10) : undefined;
        const [entries, summary] = await Promise.all([
          getAuditLog({ limit, riskLevel, userId, hours }),
          getAuditSummary(hours || 24),
        ]);
        return sendJson(res, 200, { entries, summary });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // POST /api/alerts/execute-fix — runs a kubectl/oc command (dry-run or real)
    if (req.method === "POST" && url.pathname === "/api/alerts/execute-fix") {
      if (enforceRateLimit(req, res, { burst: 5, refillPerSec: 0.1 })) return;
      const auditStart = Date.now();
      let preflight = null;
      let command = "";
      let dryRun = false;
      let earlyResponded = false;   // true once we send the async 202 response
      let verifyJobId = null;
      try {
        const body = await readJsonBody(req);
        command = body.command || "";
        dryRun = !!body.dryRun;

        // Pillar 7: Guardrails preflight check (only if enabled)
        if (featureFlags.pillar7Guardrails()) {
          preflight = preflightCheck(command, {
            dryRun,
            confirmationToken: body.confirmationToken || null,
            userId: body.userId || null,
          });

          if (!preflight.allow) {
            // Audit the blocked attempt
            if (featureFlags.pillar7AuditLog()) {
              logAuditEvent({
                userId: body.userId || null,
                conversationId: body.conversationId || null,
                command,
                dryRun,
                classification: preflight.classification,
                allowed: false,
                blockReason: preflight.reason,
                durationMs: Date.now() - auditStart,
                ipAddress: req.socket?.remoteAddress || null,
              }).catch(() => {});
            }
            return sendJson(res, 403, {
              success: false,
              blocked: true,
              classification: preflight.classification,
              reason: preflight.reason,
              suggestion: preflight.suggestion,
              needsConfirmation: !!preflight.needsConfirmation,
              stderr: preflight.reason,
            });
          }
        }

        // Capture before-metrics for non-dry-run fixes
        let beforeMetrics = null;
        if (!dryRun && body.captureMetrics) {
          try {
            const meta = parseCommandTarget(command);
            const ns = meta.namespace || body.namespace || "";
            const resName = meta.name || body.resourceName || "";
            if (ns && resName) {
              const kindMatch = command.match(/\b(deployment|statefulset|daemonset|replicaset)\/([^\s]+)/i);
              const resKind = kindMatch?.[1]?.toLowerCase() || "deployment";
              const plural = resKind + "s";
              // Read deployment spec directly (bypass cache for accurate before-state)
              let specLimits = {};
              let specRequests = {};
              try {
                const wlBefore = await ocpFetch(`/apis/apps/v1/namespaces/${ns}/${plural}/${resName}`);
                specLimits = (wlBefore.spec?.template?.spec?.containers || [])[0]?.resources?.limits || {};
                specRequests = (wlBefore.spec?.template?.spec?.containers || [])[0]?.resources?.requests || {};
              } catch {}
              let podItems = [];
              try {
                const wlBefore = await ocpGet(`/apis/apps/v1/namespaces/${ns}/${plural}/${resName}`);
                const matchLabels = wlBefore.spec?.selector?.matchLabels || {};
                const labelParts = Object.entries(matchLabels).map(([k, v]) => `${k}=${v}`);
                if (labelParts.length > 0) {
                  const podData = await ocpGet(`/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(labelParts.join(","))}&limit=10`);
                  podItems = podData.items || [];
                }
              } catch {}
              if (podItems.length === 0) {
                try {
                  const podData = await ocpGet(`/api/v1/namespaces/${ns}/pods?limit=50`);
                  podItems = (podData.items || []).filter(p => p.metadata?.name?.startsWith(resName + "-"));
                } catch {}
              }
              const pm = await ocpGet(`/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods`).catch(() => ({ items: [] }));
              const pod = podItems[0];
              if (pod) {
                const cs = (pod.status?.containerStatuses || [])[0];
                const pmMatch = (pm.items || []).find(m => m.metadata?.name === pod.metadata?.name);
                const memUsage = pmMatch?.containers?.[0]?.usage?.memory || null;
                const cpuUsage = pmMatch?.containers?.[0]?.usage?.cpu || null;
                beforeMetrics = {
                  podName: pod.metadata?.name || "—",
                  containerName: (pod.status?.containerStatuses || [])[0]?.name || (pod.spec?.containers || [])[0]?.name || "—",
                  memoryLimit: specLimits.memory || "—",
                  memoryRequest: specRequests.memory || "—",
                  memoryUsage: memUsage || "—",
                  cpuLimit: specLimits.cpu || "—",
                  cpuRequest: specRequests.cpu || "—",
                  cpuUsage: cpuUsage || "—",
                  restarts: cs?.restartCount ?? 0,
                  status: pod.status?.phase || "Unknown",
                  ready: cs?.ready ?? false,
                  containerState: cs?.state?.running ? "Running" : cs?.state?.waiting?.reason || cs?.state?.terminated?.reason || "Unknown",
                  timestamp: new Date().toISOString(),
                };
              }
            }
          } catch {}
        }

        const result = await executeFixCommand(command, { dryRun });

        // Audit the executed command (only if enabled)
        if (featureFlags.pillar7AuditLog()) {
          logAuditEvent({
            userId: body.userId || null,
            conversationId: body.conversationId || null,
            command,
            dryRun,
            classification: preflight?.classification,
            allowed: true,
            success: !!result.success,
            exitCode: result.exitCode,
            stdoutPreview: result.stdout,
            stderrPreview: result.stderr,
            durationMs: Date.now() - auditStart,
            clusterName: body.cluster || process.env.CLUSTER_NAME || null,
            ipAddress: req.socket?.remoteAddress || null,
          }).catch(() => {});
        }

        // Learning loop: record this fix outcome so future similar issues can
        // surface the team's proven approach. Skip dry-runs (no real change).
        if (!dryRun && command) {
          const meta = parseCommandTarget(command);
          leRecordResolution({
            cluster: process.env.CLUSTER_NAME || body.cluster || "local",
            namespace: meta.namespace || body.namespace || "",
            resourceName: meta.name || body.resourceName || "",
            signature: body.signature || null,
            command,
            summary: body.summary || meta.summary || "",
            success: !!result.success,
            user: body.user || body.conversationId || "",
          }).catch(() => {});
        }

        // Governance: record governed AI remediations (right-size / triage) to
        // the persistent audit trail so they surface in Audit → Audit Trail.
        // Cards opt in via `auditTitle`; dry-runs and read-only verifies are
        // never logged here.
        if (!dryRun && body.auditTitle) {
          logAuditTrailEvent({
            type: "action_taken",
            severity: result.success === false ? "warning" : "info",
            title: String(body.auditTitle).slice(0, 160),
            details: {
              command,
              success: result.success !== false,
              classification: preflight?.classification || null,
            },
            namespace: body.namespace || null,
            username: body.userId || body.user || "dashboard",
            source: "ai-remediation",
          }).catch(() => {});
          // Record to incident RAG for future retrieval
          recordIncidentResolution({
            symptom: {
              reason: body.reason || body.auditTitle?.match(/OOM|Crash|ImagePull|triage|rightsize/i)?.[0] || "remediation",
              podPattern: body.podName || command?.match(/(?:deployment|sts|ds)\/([^\s]+)/)?.[1] || "",
              namespace: body.namespace || "",
              exitCode: body.exitCode ?? null,
            },
            rootCause: body.auditTitle || command || "",
            resolution: command || "",
            outcome: result.success !== false ? "success" : "failed",
            resolvedAt: new Date().toISOString(),
            resolvedBy: "ai-remediation",
            timeToResolveMs: Date.now() - auditStart,
          }).catch(() => {});
        }
        // Production-grade async: for a real (non-dry-run) fix tied to an
        // incident, respond IMMEDIATELY (202) and run the pod-watch → verify →
        // auto-close → after-metrics in the background. The UI polls
        // /api/alerts/fix-status. This keeps the (possibly 60–90s) rollout off
        // the HTTP request path so it never trips a route/proxy timeout.
        if (!dryRun && result.success !== false && body.incidentSysId) {
          verifyJobId = "vfy-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
          setVerifyJob(verifyJobId, {
            status: "verifying", phase: "watching_pod",
            beforeMetrics, output: result.stdout || result.output || "",
            classification: preflight?.classification || null,
            incidentNumber: body.incidentNumber || null,
            appliedAt: new Date().toISOString(),
          });
          sendJson(res, 202, {
            success: true, applied: true, verifying: true, verifyJobId,
            beforeMetrics, output: result.stdout || result.output || "",
            classification: preflight?.classification || null,
          });
          earlyResponded = true;
        }

        // Post-fix validation & auto-close ServiceNow incident
        let validation = null;
        let incidentClosed = null;
        if (!dryRun && result.success !== false && body.incidentSysId) {
          try {
            const meta = parseCommandTarget(command);
            let ns = meta.namespace || body.namespace || "";
            let resourceKind = "";
            let resourceName = "";
            const kindNameMatch = command.match(/\b(deployment|statefulset|daemonset|replicaset)\/([^\s]+)/i);
            if (kindNameMatch) {
              resourceKind = kindNameMatch[1].toLowerCase();
              resourceName = kindNameMatch[2];
            } else {
              resourceKind = meta.resource || "";
              resourceName = meta.name || "";
            }
            if (!ns) { const nsMatch = command.match(/-n\s+(\S+)/); if (nsMatch) ns = nsMatch[1]; }
            if (ns && resourceName && /^(deployment|statefulset|daemonset)$/i.test(resourceKind)) {
              const rolloutStart = Date.now();
              const maxWait = 60_000;
              const pollInterval = 3_000;
              let stable = false;
              let lastCheck = null;
              const plural = resourceKind.toLowerCase() + "s";
              while (Date.now() - rolloutStart < maxWait) {
                await new Promise(r => setTimeout(r, pollInterval));
                try {
                  const wl = await ocpGet(`/apis/apps/v1/namespaces/${ns}/${plural}/${resourceName}`);
                  const desired = wl.spec?.replicas || 1;
                  const ready = wl.status?.readyReplicas || 0;
                  const updated = wl.status?.updatedReplicas || 0;
                  const unavail = wl.status?.unavailableReplicas || 0;
                  lastCheck = { desired, ready, updated, unavailable: unavail };
                  if (ready >= desired && updated >= desired && unavail === 0) { stable = true; break; }
                } catch { break; }
              }
              let podHealth = [];
              const desiredReplicas = lastCheck?.desired || 1;
              // Poll the actual pods until they are Running & Ready (not just a
              // single snapshot). This makes allPodsHealthy — and therefore the
              // incident close — a confirmed "pod is up" signal, not a race.
              const _phStart = Date.now();
              const _phMaxWait = 45_000;
              const capturePods = async () => {
                const wlSpec = await ocpFetch(`/apis/apps/v1/namespaces/${ns}/${plural}/${resourceName}`).catch(() => null);
                const matchLabels = wlSpec?.spec?.selector?.matchLabels || {};
                const selectorStr = Object.entries(matchLabels).map(([k, v]) => `${k}=${v}`).join(",");
                const labelQuery = selectorStr || `app=${resourceName}`;
                const podData = await ocpFetch(`/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(labelQuery)}&limit=50`);
                const activePods = (podData.items || [])
                  .filter(p => !p.metadata?.deletionTimestamp)
                  .sort((a, b) => new Date(b.metadata?.creationTimestamp || 0) - new Date(a.metadata?.creationTimestamp || 0))
                  .slice(0, desiredReplicas);
                return activePods.map(p => ({
                  name: p.metadata.name,
                  phase: p.status?.phase,
                  ready: (p.status?.containerStatuses || []).length > 0 && (p.status?.containerStatuses || []).every(c => c.ready),
                  restarts: Math.max(0, ...(p.status?.containerStatuses || []).map(c => c.restartCount || 0)),
                }));
              };
              while (true) {
                try { podHealth = await capturePods(); } catch {}
                const healthyNow = podHealth.length >= Math.min(desiredReplicas, 1) && podHealth.every(p => p.phase === "Running" && p.ready);
                if (healthyNow || Date.now() - _phStart >= _phMaxWait) break;
                await new Promise(r => setTimeout(r, 3000));
              }
              // Healthy requires the expected pod(s) to actually be Running &
              // Ready — an empty pod list is NOT vacuously healthy for a rollout.
              const allPodsHealthy = podHealth.length >= Math.min(desiredReplicas, 1) && podHealth.every(p => p.phase === "Running" && p.ready);
              validation = { stable, rolloutDurationMs: Date.now() - rolloutStart, ...lastCheck, pods: podHealth, allPodsHealthy, passed: stable && allPodsHealthy };
            } else {
              validation = { passed: true, note: "Non-rollout fix — command succeeded" };
            }
            if (validation.passed) {
              try {
                const rolloutStatus = validation.stable
                  ? `Stable — ${validation.ready || 0}/${validation.desired || 0} replicas ready`
                  : validation.note || "triggered";
                const evidence = [];
                if (body.incidentDiagnosis) evidence.push(body.incidentDiagnosis);
                if (body.incidentEvidence) {
                  (Array.isArray(body.incidentEvidence) ? body.incidentEvidence : [body.incidentEvidence]).forEach(e => evidence.push(e));
                }
                if (validation.pods?.length) {
                  evidence.push(`Post-fix: ${validation.pods.filter(p => p.ready).length}/${validation.pods.length} pods healthy`);
                }
                const resolutionObj = {
                  incidentNumber: body.incidentNumber || "",
                  severity: body.incidentSeverity || "N/A",
                  podName: body.podName || resourceName || "N/A",
                  namespace: ns || "N/A",
                  deploymentName: resourceKind ? `${resourceKind}/${resourceName}` : resourceName || "N/A",
                  cluster: body.cluster || process.env.CLUSTER_NAME || "local",
                  rootCause: body.incidentRootCause || body.incidentDiagnosis || "See diagnosis",
                  evidence,
                  logErrors: Array.isArray(body.logErrors) ? body.logErrors : [],
                  errorLines: Array.isArray(body.errorLines) ? body.errorLines : [],
                  fixTitle: body.fixTitle || body.auditTitle || command.split(/\s/).slice(0, 4).join(" "),
                  fixCommand: command,
                  fixResult: result.stdout ? result.stdout.slice(0, 500) : "success",
                  fixRisk: body.fixRisk || preflight?.classification?.level || "low",
                  rolloutStatus,
                  timeline: Array.isArray(body.incidentTimeline) ? body.incidentTimeline : [],
                };
                const snowResult = await snowResolveIncident(body.incidentSysId, {
                  closeCode: "Solved (Permanently)",
                  closeNotes: `Auto-resolved by TCS Agentic AI. Fix: ${command}. Validation: passed. ${validation.pods?.length ? `${validation.pods.filter(p => p.ready).length}/${validation.pods.length} pods healthy.` : ""}`,
                  resolution: resolutionObj,
                });
                // snowResolveIncident no longer throws on close-only failure — it
                // returns { closed, detailsSaved, closeError }. Details are always
                // saved to ServiceNow; the close is best-effort.
                incidentClosed = {
                  success: snowResult?.closed === true,
                  detailsSaved: snowResult?.detailsSaved === true,
                  incidentNumber: body.incidentNumber || null,
                  state: snowResult?.closed ? "Resolved" : "Updated (close pending)",
                  closeError: snowResult?.closeError || null,
                };
              } catch (snowErr) {
                incidentClosed = { success: false, detailsSaved: false, error: snowErr.message };
              }
            } else {
              incidentClosed = { success: false, reason: "Validation failed — incident remains open for manual review" };
            }
          } catch (valErr) {
            validation = { passed: false, error: valErr.message };
            incidentClosed = { success: false, reason: `Validation error: ${valErr.message}` };
          }
        }
        // Capture after-metrics for comparison — but first WATCH the workload
        // until its rolling update completes (new pod Running & Ready), so the
        // Before/After reflects the healthy pod, never a mid-rollout snapshot.
        let afterMetrics = null;
        let afterPodReady = false;
        if (!dryRun && beforeMetrics && validation) {
          try {
            const _m = parseCommandTarget(command);
            const _ns = _m.namespace || body.namespace || "";
            const _name = _m.name || body.resourceName || "";
            const _km = command.match(/\b(deployment|statefulset|daemonset|replicaset)\/([^\s]+)/i);
            const _plural = (_km?.[1]?.toLowerCase() || "deployment") + "s";
            if (_ns && _name) {
              const _start = Date.now();
              const _maxWait = 60_000;   // watch up to 60s for the pod to be Ready
              // brief initial pause so the rollout actually begins
              await new Promise(r => setTimeout(r, 2000));
              while (Date.now() - _start < _maxWait) {
                try {
                  const _wl = await ocpFetch(`/apis/apps/v1/namespaces/${_ns}/${_plural}/${_name}`);
                  const _des = _wl.spec?.replicas ?? 1;
                  const _ready = _wl.status?.readyReplicas ?? 0;
                  const _updated = _wl.status?.updatedReplicas ?? 0;
                  const _unavail = _wl.status?.unavailableReplicas ?? 0;
                  if (_ready >= _des && _updated >= _des && _unavail === 0) { afterPodReady = true; break; }
                } catch {}
                await new Promise(r => setTimeout(r, 3000));
              }
            } else {
              await new Promise(r => setTimeout(r, 5000));
            }
          } catch { await new Promise(r => setTimeout(r, 5000)); }
          try {
            const meta = parseCommandTarget(command);
            const aNs = meta.namespace || body.namespace || "";
            const aResName = meta.name || body.resourceName || "";
            if (aNs && aResName) {
              const kindMatch = command.match(/\b(deployment|statefulset|daemonset|replicaset)\/([^\s]+)/i);
              const resKind = kindMatch?.[1]?.toLowerCase() || "deployment";
              const plural = resKind + "s";
              // Bypass cache — read the updated Deployment spec directly
              let specLimits = {};
              let specRequests = {};
              let afterPodItems = [];
              let afterDesired = 1;
              try {
                const wlAfter = await ocpFetch(`/apis/apps/v1/namespaces/${aNs}/${plural}/${aResName}`);
                afterDesired = wlAfter?.spec?.replicas || 1;
                specLimits = (wlAfter.spec?.template?.spec?.containers || [])[0]?.resources?.limits || {};
                specRequests = (wlAfter.spec?.template?.spec?.containers || [])[0]?.resources?.requests || {};
                const matchLabels = wlAfter.spec?.selector?.matchLabels || {};
                const labelParts = Object.entries(matchLabels).map(([k, v]) => `${k}=${v}`);
                if (labelParts.length > 0) {
                  const podData = await ocpFetch(`/api/v1/namespaces/${aNs}/pods?labelSelector=${encodeURIComponent(labelParts.join(","))}&limit=10`);
                  afterPodItems = podData.items || [];
                }
              } catch {}
              if (afterPodItems.length === 0) {
                try {
                  const podData = await ocpFetch(`/api/v1/namespaces/${aNs}/pods?limit=50`);
                  afterPodItems = (podData.items || []).filter(p => p.metadata?.name?.startsWith(aResName + "-"));
                } catch {}
              }
              // Filter out terminating pods, keep only the newest N matching desired replicas
              afterPodItems = afterPodItems
                .filter(p => !p.metadata?.deletionTimestamp)
                .sort((a, b) => new Date(b.metadata?.creationTimestamp || 0) - new Date(a.metadata?.creationTimestamp || 0))
                .slice(0, afterDesired);
              const allPods = afterPodItems;
              const runningPods = allPods.filter(p =>
                p.status?.phase === "Running" && (p.status?.containerStatuses || []).some(c => c.ready)
              );
              const pm = await ocpFetch(`/apis/metrics.k8s.io/v1beta1/namespaces/${aNs}/pods`).catch(() => ({ items: [] }));
              const pod = runningPods[0] || allPods[0];
              if (pod) {
                const cs = (pod.status?.containerStatuses || [])[0];
                const pmMatch = (pm.items || []).find(m => m.metadata?.name === pod.metadata?.name);
                const podPhase = pod.status?.phase || "Unknown";
                const podState = cs?.state?.running ? "Running"
                  : cs?.state?.waiting?.reason || cs?.state?.terminated?.reason || "Pending";
                afterMetrics = {
                  podName: pod.metadata?.name || "—",
                  containerName: cs?.name || (pod.spec?.containers || [])[0]?.name || "—",
                  memoryLimit: specLimits.memory || "—",
                  memoryRequest: specRequests.memory || "—",
                  memoryUsage: pmMatch?.containers?.[0]?.usage?.memory || "pending",
                  cpuLimit: specLimits.cpu || "—",
                  cpuRequest: specRequests.cpu || "—",
                  cpuUsage: pmMatch?.containers?.[0]?.usage?.cpu || "pending",
                  restarts: cs?.restartCount ?? 0,
                  status: podPhase,
                  ready: cs?.ready ?? false,
                  containerState: podState,
                  podCount: `${runningPods.filter(p => (p.status?.containerStatuses || []).every(c => c.ready)).length}/${allPods.length}`,
                  timestamp: new Date().toISOString(),
                };
              } else {
                afterMetrics = {
                  podName: "pending",
                  containerName: "—",
                  memoryLimit: specLimits.memory || "—",
                  memoryRequest: specRequests.memory || "—",
                  memoryUsage: "pending",
                  cpuLimit: specLimits.cpu || "—",
                  cpuRequest: specRequests.cpu || "—",
                  cpuUsage: "pending",
                  restarts: 0,
                  status: "Rolling out",
                  ready: false,
                  containerState: "ContainerCreating",
                  podCount: "0/?",
                  timestamp: new Date().toISOString(),
                };
              }
            }
          } catch {}
        }
        // Post before/after comparison (with fresh after-metrics) as a follow-up
        // work note. Decoupled from close success — as long as the incident exists
        // and details were saved, the comparison + timeline are recorded in
        // ServiceNow even if the state-close transition failed.
        if (body.incidentSysId && (incidentClosed?.detailsSaved || incidentClosed?.success)) {
          const beforeAfterNotes = [];
          if (beforeMetrics || afterMetrics) {
            beforeAfterNotes.push(`── POST-FIX VERIFICATION (live) ─────`);
            if (beforeMetrics?.podName) beforeAfterNotes.push(`  Pod: ${beforeMetrics.podName} → ${afterMetrics?.podName || "pending"}`);
            if (beforeMetrics?.containerName) beforeAfterNotes.push(`  Container: ${beforeMetrics.containerName}`);
            const fields = ["status", "containerState", "ready", "restarts", "memoryLimit", "memoryRequest", "memoryUsage", "cpuLimit", "cpuUsage"];
            const labels = { status: "Pod Phase", containerState: "Container State", ready: "Ready", restarts: "Restarts", memoryLimit: "Memory Limit", memoryRequest: "Memory Request", memoryUsage: "Memory Usage", cpuLimit: "CPU Limit", cpuUsage: "CPU Usage" };
            for (const f of fields) {
              const bv = beforeMetrics?.[f] ?? "—";
              const av = afterMetrics?.[f] ?? "—";
              if (bv === "—" && av === "—") continue;
              beforeAfterNotes.push(`  ${labels[f]}: ${bv} → ${av}`);
            }
            if (afterMetrics?.podCount) beforeAfterNotes.push(`  Healthy Pods: ${afterMetrics.podCount}`);
          }
          if (beforeAfterNotes.length > 0) {
            beforeAfterNotes.push(`\n  Total Resolution Time: ${((Date.now() - auditStart) / 1000).toFixed(1)}s`);
            beforeAfterNotes.push(`  Incident Status: ${incidentClosed?.success ? "Resolved ✓" : "Details saved — close pending manual review"}`);
            snowUpdateRecord("incident", body.incidentSysId, { work_notes: beforeAfterNotes.join("\n") }).catch(() => {});
          }
        }
        const resolutionTimeline = {
          fixAppliedAt: beforeMetrics?.timestamp || new Date().toISOString(),
          validationAt: afterMetrics?.timestamp || new Date().toISOString(),
          resolvedAt: incidentClosed?.success ? new Date().toISOString() : null,
          totalDurationMs: Date.now() - auditStart,
        };
        // Async path: response already sent — store the final result for polling.
        if (earlyResponded) {
          setVerifyJob(verifyJobId, {
            status: incidentClosed?.success ? "resolved" : (validation && validation.passed === false ? "failed" : "applied"),
            phase: "done",
            validation, incidentClosed, afterMetrics, resolutionTimeline,
            classification: preflight?.classification,
          });
          return;
        }
        return sendJson(res, 200, { ...result, classification: preflight?.classification, validation, incidentClosed, beforeMetrics, afterMetrics, resolutionTimeline });
      } catch (e) {
        if (featureFlags.pillar7AuditLog()) logAuditEvent({
          command,
          dryRun,
          classification: preflight?.classification,
          allowed: true,
          success: false,
          stderrPreview: e.message,
          durationMs: Date.now() - auditStart,
        }).catch(() => {});
        // Async path: response already sent — record the failure for polling.
        if (earlyResponded) {
          setVerifyJob(verifyJobId, { status: "failed", phase: "error", error: e.message });
          return;
        }
        return sendJson(res, 500, { success: false, stderr: e.message });
      }
    }

    // GET /api/alerts/fix-status?jobId=… — poll async fix-verification result
    if (req.method === "GET" && url.pathname === "/api/alerts/fix-status") {
      const jobId = url.searchParams.get("jobId");
      const job = jobId ? _verifyJobs.get(jobId) : null;
      if (!job) { sendJson(res, 404, { error: "job not found", status: "unknown" }); return; }
      sendJson(res, 200, job);
      return;
    }

    // POST /api/demo/setup-incident — deploy a deliberately broken pod for demo
    if (req.method === "POST" && url.pathname === "/api/demo/setup-incident") {
      try {
        const body = await readJsonBody(req);
        const ns = body.namespace || "demo-incident";
        const appName = body.appName || "demo-oom-app";
        const memLimit = body.memoryLimit || "32Mi";
        // Create namespace if needed
        await ocpGet(`/api/v1/namespaces/${ns}`).catch(async () => {
          await ocpPost("/api/v1/namespaces", { apiVersion: "v1", kind: "Namespace", metadata: { name: ns } });
        });
        // Deploy a pod that will OOMKill (stress with low memory limit)
        const deployment = {
          apiVersion: "apps/v1", kind: "Deployment",
          metadata: { name: appName, namespace: ns, labels: { app: appName, "demo-type": "incident-response" } },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: appName } },
            template: {
              metadata: { labels: { app: appName } },
              spec: { containers: [{
                name: appName,
                image: "registry.access.redhat.com/ubi8/ubi-minimal:latest",
                command: ["sh", "-c", "echo 'Demo app starting — will exceed memory limit'; while true; do head -c 5M /dev/urandom >> /tmp/memfill 2>/dev/null; sleep 1; done"],
                resources: { limits: { memory: memLimit, cpu: "100m" }, requests: { memory: memLimit, cpu: "50m" } },
              }] },
            },
          },
        };
        // Delete existing deployment if any
        try { await ocpDelete(`/apis/apps/v1/namespaces/${ns}/deployments/${appName}`); } catch {}
        await new Promise(r => setTimeout(r, 1000));
        await ocpPost(`/apis/apps/v1/namespaces/${ns}/deployments`, deployment);
        return sendJson(res, 200, {
          success: true,
          message: `Demo deployment "${appName}" created in namespace "${ns}" with ${memLimit} memory limit. It will OOMKill within 30-60 seconds.`,
          hint: `Ask: "why is my pod ${appName} in namespace ${ns} crashing?"`,
          namespace: ns, appName, memoryLimit: memLimit,
        });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    // POST /api/demo/cleanup — remove demo incident pods
    if (req.method === "POST" && url.pathname === "/api/demo/cleanup") {
      try {
        const body = await readJsonBody(req);
        const ns = body.namespace || "demo-incident";
        await ocpDelete(`/api/v1/namespaces/${ns}`).catch(() => {});
        return sendJson(res, 200, { success: true, message: `Demo namespace "${ns}" deleted.` });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e.message });
      }
    }

    // GET /api/pod-status — refresh pod status + metrics for a label selector
    if (req.method === "GET" && url.pathname === "/api/pod-status") {
      try {
        const namespace = url.searchParams.get("namespace");
        const labelSelector = url.searchParams.get("labelSelector");
        if (!namespace || !labelSelector) {
          return sendJson(res, 400, { error: "namespace and labelSelector required" });
        }
        const pods = await fetchPodStatus(namespace, labelSelector);
        return sendJson(res, 200, { pods });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // POST /api/itsm/submit — submit a change request or incident
    if (req.method === "POST" && url.pathname === "/api/itsm/submit") {
      try {
        const body = await readJsonBody(req);
        const { type, fields, preflightReport, upgradeInfo, conversationId: submitConvId } = body;
        if (!type || !fields) {
          return sendJson(res, 400, { error: "Missing type or fields" });
        }

        if (!isServiceNowEnabled()) {
          const ticketId = type === "change_request"
            ? `CR-${Date.now().toString(36).toUpperCase()}`
            : `INC-${Date.now().toString(36).toUpperCase()}`;
          if (dbEnabled()) {
            try {
              await dbQuery(
                `INSERT INTO itsm_tickets (ticket_id, type, title, fields, status, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [ticketId, type, fields.title || "", JSON.stringify(fields), "saved_locally"]
              );
            } catch { /* table may not exist yet */ }
          }
          return sendJson(res, 200, {
            success: true,
            ticketId,
            status: "saved_locally",
            message: `${type === "change_request" ? "Change Request" : "Incident"} saved locally as ${ticketId}. Configure ServiceNow credentials in Settings to submit directly.`,
          });
        }

        // Submit to ServiceNow
        let result;
        const plannedDate = fields.plannedDate || "";
        const endDate = plannedDate ? new Date(new Date(plannedDate).getTime() + 4 * 3600000).toISOString().slice(0, 16).replace("T", " ") : "";
        if (type === "change_request") {
          result = await snowCreateCR({
            shortDescription: fields.title || "",
            description: fields.description || "",
            type: fields.changeType || "normal",
            priority: (fields.priority || "3").charAt(0),
            risk: fields.risk || "moderate",
            impact: (fields.priority || "3").charAt(0),
            assignmentGroup: fields.assignmentGroup || "",
            justification: fields.justification || "",
            implementationPlan: fields.implementationPlan || "",
            backoutPlan: fields.rollback || "",
            testPlan: fields.validation || "",
            startDate: plannedDate,
            endDate,
            workNotes: [
              fields.impact || "",
              fields.communicationPlan || "",
            ].filter(Boolean).join("\n\n"),
          });
        } else {
          result = await snowCreateIncident({
            shortDescription: fields.title || "",
            description: [
              fields.description || "",
              fields.workaround ? `\nWorkaround: ${fields.workaround}` : "",
            ].filter(Boolean).join("\n"),
            urgency: (fields.urgency || "2").charAt(0),
            impact: (fields.impact || "2").charAt(0),
            category: fields.category || "Infrastructure",
            assignmentGroup: fields.assignmentGroup || "",
          });
        }

        const record = result?.result || result;
        const number = record?.number || record?.sys_id || "N/A";
        const sysId = record?.sys_id || "";

        // Attach HTML pre-assessment report if a preflight report is present
        let attachmentId = "";
        if (preflightReport && sysId && type === "change_request") {
          try {
            const htmlReport = generatePreflightHTML(preflightReport, number, fields);
            const buf = Buffer.from(htmlReport, "utf-8");
            const attResult = await snowAttachFile(
              "change_request", sysId,
              `Pre-Assessment_Report_${number}.html`,
              "text/html",
              buf,
            );
            attachmentId = attResult?.result?.sys_id || "";
            console.log(`[itsm] Attached pre-assessment HTML report to ${number}`);
          } catch (attErr) {
            console.warn(`[itsm] Failed to attach report to ${number}: ${attErr.message}`);
          }
        }

        // Track the CR for approval monitoring in chat
        if (sysId && type === "change_request" && (upgradeInfo || preflightReport)) {
          const convId = submitConvId || upgradeInfo?.conversationId || "";
          if (convId) {
            trackSubmittedCR(convId, {
              ticketId: number,
              sysId,
              cluster: validateClusterParam(body.cluster || url.searchParams.get("cluster") || "local") || "local",
              targetVersion: upgradeInfo?.targetVersion || preflightReport?.targetVersion || "",
              fromVersion: upgradeInfo?.fromVersion || preflightReport?.fromVersion || "",
              preflightReport,
            });
          }
        }

        // Persist CR to tracking table
        const _snCluster = validateClusterParam(body.cluster || url.searchParams.get("cluster") || "local") || "local";
        try {
          await trackCR({
            ticketId: number,
            sysId: sysId || null,
            conversationId: submitConvId || upgradeInfo?.conversationId || null,
            title: fields.short_description || fields.title || '',
            targetVersion: upgradeInfo?.targetVersion || '',
            fromVersion: upgradeInfo?.fromVersion || '',
            channel: upgradeInfo?.channel || '',
            upgradeType: upgradeInfo?.upgradeType || '',
            scheduledDate: fields.planned_start_date || fields.start_date || null,
            preflightReport: preflightReport || null,
            cluster: _snCluster,
          });
        } catch (e) {}

        // Record in audit trail
        if (await dbEnabled()) {
          dbQuery(
            `INSERT INTO executed_actions (action, target, namespace, success, result, cluster)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              type === "change_request" ? "create_change_request" : "create_incident",
              number,
              "servicenow",
              true,
              JSON.stringify({ ticketId: number, sysId, title: fields.title || "" }),
              _snCluster,
            ]
          ).catch(() => {});
        }

        return sendJson(res, 200, {
          success: true,
          ticketId: number,
          sysId,
          attachmentId,
          status: "submitted",
          message: `${type === "change_request" ? "Change Request" : "Incident"} ${number} created in ServiceNow.`,
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // POST /api/servicenow/resolve-incident — close an incident after successful fix
    if (req.method === "POST" && url.pathname === "/api/servicenow/resolve-incident") {
      try {
        const body = await readJsonBody(req);
        const { sysId, closeNotes, workNotes, resolution } = body;
        if (!sysId) return sendJson(res, 400, { error: "sysId required" });
        const result = await snowResolveIncident(sysId, {
          closeNotes: closeNotes || "Resolved by TCS Agentic AI — fix applied and validated",
          workNotes: workNotes || "",
          resolution: resolution || null,
        });
        // snowResolveIncident returns { closed, detailsSaved, closeError }. Details
        // are always saved; close is best-effort. Report both so the UI can show
        // "Resolved" vs "Details saved — close pending" without a hard error.
        return sendJson(res, 200, {
          success: result?.closed === true,
          detailsSaved: result?.detailsSaved === true,
          closeError: result?.closeError || null,
          result: result?.result || result,
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // GET /api/intelligence/playbook — top patterns from team history
    if (req.method === "GET" && url.pathname === "/api/intelligence/playbook") {
      try {
        const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 20, 100);
        const sinceDays = Math.min(parseInt(url.searchParams.get("sinceDays"), 10) || 90, 365);
        const playbook = await getTeamPlaybook({ limit, sinceDays });
        const stats = await getIncidentStats({ sinceDays });
        return sendJson(res, 200, { playbook, stats, sinceDays });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // GET /api/intelligence/similar?signature=X — find historical incidents matching signature
    if (req.method === "GET" && url.pathname === "/api/intelligence/similar") {
      try {
        const signature = url.searchParams.get("signature") || "";
        const rawCluster = url.searchParams.get("cluster") || null;
        const cluster = rawCluster ? (validateClusterParam(rawCluster) || rawCluster) : null;
        const sinceDays = Math.min(parseInt(url.searchParams.get("sinceDays"), 10) || 90, 365);
        const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 5, 50);
        if (!signature) return sendJson(res, 400, { error: "signature is required" });
        const matches = await findSimilarIncidents(signature, { cluster, sinceDays, limit });
        return sendJson(res, 200, { matches, signature, sinceDays });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // GET /api/alerts — unified: Alertmanager + K8s warning events
    if (req.method === "GET" && url.pathname === "/api/alerts") {
      const _ac = url.searchParams.get("cluster");
      if (_ac && _ac !== "local") {
        const cached = getAgentCachedResponse(_ac, "/api/alerts");
        if (cached) return sendJson(res, 200, cached);
      }
      if (!_ac || _ac === "local") {
        const lc = getLocalCache("/api/alerts");
        if (lc) return sendJson(res, 200, lc);
      }
      try {
        const clusterResult = await withClusterContext(url, () => Promise.allSettled([
          listFiringAlerts(),
          ocpGet("/api/v1/events"),
        ]));

        // Remote cluster returned null — no live data, try stale cache
        if (clusterResult === null) {
          const stale = getAgentCachedResponse(_ac, "/api/alerts", { skipFreshnessCheck: true });
          if (stale) return sendJson(res, 200, stale);
          return sendJson(res, 503, { error: "Remote cluster is not reachable", alerts: [], summary: { critical: 0, warning: 0, info: 0 } });
        }

        const [promAlerts, eventsResp] = clusterResult;
        const unified = [];
        const scopeCluster = (_ac && _ac !== "local") ? _ac : "local";

        // Alertmanager (Prometheus) alerts
        const amAlerts = promAlerts.status === "fulfilled" ? promAlerts.value || [] : [];
        for (const a of amAlerts) {
          unified.push({
            source: "alertmanager",
            name: a.name,
            severity: a.severity || "warning",
            namespace: a.namespace || "",
            resource: a.pod ? `pod/${a.pod}` : "",
            summary: a.summary || a.description || "",
            since: a.startsAt || "",
            count: 1,
            labels: a.labels || {},
          });
        }

        // Kubernetes warning events
        const evItems = eventsResp.status === "fulfilled" ? (eventsResp.value?.items || []) : [];
        const warnings = evItems
          .filter((e) => e.type === "Warning")
          .sort((a, b) =>
            new Date(b.lastTimestamp || b.metadata.creationTimestamp) -
            new Date(a.lastTimestamp || a.metadata.creationTimestamp)
          )
          .slice(0, 50);
        for (const e of warnings) {
          const reason = (e.reason || "").toLowerCase();
          let severity = "warning";
          if (reason.includes("backoff") || reason.includes("oomkill") || reason.includes("failed") || reason.includes("unhealthy"))
            severity = "critical";
          unified.push({
            source: "events",
            name: e.reason || "Event",
            severity,
            namespace: e.metadata.namespace || "",
            resource: `${(e.involvedObject.kind || "").toLowerCase()}/${e.involvedObject.name}`,
            summary: (e.message || "").substring(0, 200),
            since: e.lastTimestamp || e.metadata.creationTimestamp,
            count: e.count || 1,
            labels: {},
          });
        }

        // Sort by severity (critical first), then by time
        const sevOrder = { critical: 0, warning: 1, info: 2 };
        unified.sort((a, b) => (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2) || new Date(b.since) - new Date(a.since));

        // Mark silenced alerts — scoped to the requesting cluster
        const now = Date.now();
        for (const a of unified) {
          const key = `${scopeCluster}|${a.name}|${a.namespace}`;
          const silence = silencedAlerts.get(key);
          if (silence && new Date(silence.expiresAt).getTime() > now) {
            a.silenced = true;
            a.silenceExpiresAt = silence.expiresAt;
          }
        }

        const summary = { critical: 0, warning: 0, info: 0 };
        for (const a of unified) {
          if (!a.silenced) summary[a.severity] = (summary[a.severity] || 0) + 1;
        }

        const _alertResult = { alerts: unified, summary };
        if (!_ac || _ac === "local") setLocalCache("/api/alerts", _alertResult);
        return sendJson(res, 200, _alertResult);
      } catch (err) {
        if (_ac && _ac !== "local") {
          const cached = getAgentCachedResponse(_ac, "/api/alerts", { skipFreshnessCheck: true });
          if (cached) return sendJson(res, 200, cached);
        }
        return sendJson(res, 200, { alerts: [], summary: { critical: 0, warning: 0, info: 0 }, error: err.message });
      }
    }

    // POST /api/alerts/silence — silence an alert (stored in-memory + optionally DB)
    if (req.method === "POST" && url.pathname === "/api/alerts/silence") {
      try {
        const body = await readJsonBody(req);
        const { name, namespace, duration, cluster } = body;
        if (!name) return sendJson(res, 400, { error: "Missing alert name" });
        const cl = validateClusterParam(cluster || url.searchParams.get("cluster") || "local");
        if (cl === null) return rejectUnknownCluster(res);
        const durationMs = (duration || 60) * 60 * 1000;
        const entry = { name, namespace: namespace || "", cluster: cl, silencedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + durationMs).toISOString(), duration: duration || 60 };
        silencedAlerts.set(`${cl}|${name}|${namespace || ""}`, entry);
        try {
          await dbQuery("INSERT INTO silenced_alerts (name, namespace, cluster, silenced_at, expires_at) VALUES ($1, $2, $3, $4, $5)", [name, namespace || "", cl, entry.silencedAt, entry.expiresAt]);
        } catch { /* DB optional */ }
        return sendJson(res, 200, { ok: true, silence: entry });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // DELETE /api/alerts/silence — unsilence an alert
    if (req.method === "DELETE" && url.pathname === "/api/alerts/silence") {
      try {
        const body = await readJsonBody(req);
        const { name, namespace, cluster } = body;
        const cl = validateClusterParam(cluster || url.searchParams.get("cluster") || "local");
        if (cl === null) return rejectUnknownCluster(res);
        silencedAlerts.delete(`${cl}|${name}|${namespace || ""}`);
        try {
          await dbQuery("DELETE FROM silenced_alerts WHERE name = $1 AND namespace = $2 AND cluster = $3", [name, namespace || "", cl]);
        } catch { /* DB optional */ }
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /api/alerts/silences — list active silences (scoped to requested cluster)
    if (req.method === "GET" && url.pathname === "/api/alerts/silences") {
      const cl = validateClusterParam(null, url) || "local";
      const now = Date.now();
      const active = [];
      for (const [key, s] of silencedAlerts) {
        if (new Date(s.expiresAt).getTime() <= now) { silencedAlerts.delete(key); continue; }
        if ((s.cluster || "local") === cl) active.push(s);
      }
      return sendJson(res, 200, { silences: active });
    }

    // GET /api/alerts/history — alert count trend over last 24h (hourly buckets)
    if (req.method === "GET" && url.pathname === "/api/alerts/history") {
      try {
        const now = Date.now();
        const buckets = [];
        for (let i = 23; i >= 0; i--) {
          buckets.push({ hour: new Date(now - i * 3600000).toISOString().slice(11, 13) + ":00", critical: 0, warning: 0, info: 0 });
        }
        const eventsResult = await withClusterContext(url, () => ocpGet("/api/v1/events")).catch(() => null);
        if (eventsResult === null) return sendJson(res, 200, { buckets: [], error: "Remote cluster not reachable" });
        for (const e of (eventsResult?.items || [])) {
          if (e.type !== "Warning") continue;
          const ts = new Date(e.lastTimestamp || e.metadata.creationTimestamp).getTime();
          const age = now - ts;
          if (age > 24 * 3600000 || age < 0) continue;
          const bucketIdx = 23 - Math.floor(age / 3600000);
          if (bucketIdx < 0 || bucketIdx > 23) continue;
          const reason = (e.reason || "").toLowerCase();
          const sev = (reason.includes("backoff") || reason.includes("oomkill") || reason.includes("failed") || reason.includes("unhealthy")) ? "critical" : "warning";
          buckets[bucketIdx][sev] += (e.count || 1);
        }
        return sendJson(res, 200, { buckets });
      } catch (err) {
        return sendJson(res, 200, { buckets: [], error: err.message });
      }
    }

    // GET/POST /api/settings/notifications — notification webhook config
    if (url.pathname === "/api/settings/notifications") {
      const NOTIF_PATH = process.env.NOTIF_SETTINGS_PATH || "/data/mcp-notification-settings.json";
      if (req.method === "GET") {
        const cfg = await loadState("notification_settings", NOTIF_PATH).catch(() => null);
        return sendJson(res, 200, cfg || { webhookUrl: "", channel: "", enabled: false, severities: ["critical"] });
      }
      if (req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          const cfg = {
            webhookUrl: body.webhookUrl || "",
            channel: body.channel || "",
            enabled: !!body.enabled,
            severities: Array.isArray(body.severities) ? body.severities : ["critical"],
          };
          await saveState("notification_settings", cfg, NOTIF_PATH);
          return sendJson(res, 200, { ok: true, config: cfg });
        } catch (err) {
          return sendJson(res, 500, { error: err.message });
        }
      }
    }

    // POST /api/settings/notifications/test — test webhook delivery
    if (req.method === "POST" && url.pathname === "/api/settings/notifications/test") {
      try {
        const NOTIF_PATH = process.env.NOTIF_SETTINGS_PATH || "/data/mcp-notification-settings.json";
        const cfg = await loadState("notification_settings", NOTIF_PATH).catch(() => null);
        if (!cfg) {
          return sendJson(res, 400, { error: "No notification settings configured" });
        }
        if (!cfg.webhookUrl) return sendJson(res, 400, { error: "No webhook URL configured" });
        const payload = {
          text: "OpenShift MCP Alert Test: This is a test notification from your MCP AI Assistant.",
          channel: cfg.channel || undefined,
        };
        const resp = await fetch(cfg.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) return sendJson(res, 502, { error: `Webhook returned ${resp.status}` });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /stats — server runtime stats
    if (req.method === "GET" && url.pathname === "/stats") {
      return sendJson(res, 200, {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        sessions: sessions.size,
        safetyMode: getSafetyMode(),
      });
    }

    // Upgrade workflow — /api/upgrade/*
    if (req.method === "GET" && url.pathname === "/api/cluster/version") {
      const _cvCluster = url.searchParams.get("cluster");
      if (_cvCluster && _cvCluster !== "local") {
        const cached = getAgentCachedResponse(_cvCluster, "/api/cluster-info");
        if (cached) return sendJson(res, 200, { current: cached.version || "", channel: "", available: [], source: "agent-cache" });
      }
      try {
        const cv = await withClusterContext(url, () => ocpGet("/apis/config.openshift.io/v1/clusterversions/version"));
        if (cv === null) {
          if (_cvCluster) {
            const cached = getAgentCachedResponse(_cvCluster, "/api/cluster-info", { skipFreshnessCheck: true });
            if (cached) return sendJson(res, 200, { current: cached.version || "", channel: "", available: [], source: "agent-cache" });
          }
          return sendJson(res, 503, { error: "Remote cluster is not reachable", current: "", channel: "", available: [] });
        }
        const current = cv?.status?.desired?.version || cv?.status?.history?.[0]?.version || "";
        const channel = cv?.spec?.channel || "";
        const available = (cv?.status?.availableUpdates || []).map(u => u.version);
        sendJson(res, 200, { current, channel, available });
      } catch (err) {
        if (_cvCluster && _cvCluster !== "local") {
          const cached = getAgentCachedResponse(_cvCluster, "/api/cluster-info", { skipFreshnessCheck: true });
          if (cached) return sendJson(res, 200, { current: cached.version || "", channel: "", available: [], source: "agent-cache" });
        }
        sendJson(res, 200, { current: "", channel: "", available: [], error: err.message });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/upgrade/analyze") {
      await handleUpgradeAnalyze(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/upgrade/start") {
      await handleUpgradeStart(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/upgrade/status") {
      handleUpgradeStatus(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/upgrade/dryrun") {
      await handleUpgradeDryRun(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/upgrade/channel") {
      await handleUpgradeChannel(req, res);
      return;
    }

    // Upgrade report download (DOCX)
    if (req.method === "GET" && url.pathname === "/api/upgrade/report") {
      try {
        const sessionId = url.searchParams.get("session");
        const type = url.searchParams.get("type") || "pre"; // "pre" or "post"
        const format = (url.searchParams.get("format") || "pdf").toLowerCase(); // "pdf" | "html"
        const { getSession } = await import("./services/upgrade-orchestrator.js");
        const session = await getSession(sessionId);
        if (!session) return sendJson(res, 404, { error: "Upgrade session not found" });

        if (format === "html") {
          const html = generateReportHTML(session, type);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
          res.end(html);
          return;
        }
        const buffer = type === "post"
          ? await generatePostAssessmentReport(session)
          : await generatePreAssessmentReport(session);

        const filename = `TCS-Agentic-AI-${type === "post" ? "Post" : "Pre"}-Assessment-${session.cluster}-${session.targetVersion}-${Date.now()}.pdf`;
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": buffer.length,
        });
        res.end(buffer);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // Upgrade milestone notifications (polled by frontend)
    if (req.method === "GET" && url.pathname === "/api/upgrade/notifications") {
      try {
        const { listSessions, stepCheckCRStatus } = await import("./services/upgrade-orchestrator.js");
        const clusterName = url.searchParams.get("cluster") || "local";
        const allSessions = await listSessions({ limit: 50 });
        const sessions = allSessions.filter(s =>
          s.cluster === clusterName && !["completed", "failed", "cancelled", "idle"].includes(s.state)
        );
        const notifications = [];
        for (const s of sessions) {
          // If CR is submitted and has a ServiceNow sysId, auto-check approval
          if (s.state === "cr_submitted" && s.crSysId) {
            try {
              const crResult = await stepCheckCRStatus(s.id);
              notifications.push({
                sessionId: s.id,
                state: crResult.session?.state || s.state,
                fromVersion: s.fromVersion,
                targetVersion: s.targetVersion,
                crTicketId: s.crTicketId || null,
                crStatus: crResult.status || null,
                crApproval: crResult.approval || null,
              });
              continue;
            } catch {}
          }
          const lastSnapshot = s.monitoringSnapshots?.slice(-1)[0];
          notifications.push({
            sessionId: s.id,
            state: s.state,
            fromVersion: s.fromVersion,
            targetVersion: s.targetVersion,
            crTicketId: s.crTicketId || null,
            crStatus: s.crStatus || null,
            progress: lastSnapshot || null,
            preflightStatus: s.preflightReport?.overall || null,
            hasPreReport: !!s.preflightReport,
            hasPostReport: !!s.postAssessment,
          });
        }
        sendJson(res, 200, { notifications, state: sessions[0]?.state, sessionState: sessions[0]?.state });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // Upgrade history — completed/failed/cancelled sessions
    if (req.method === "GET" && url.pathname === "/api/upgrade/history") {
      try {
        const { getUpgradeHistory } = await import("./services/upgrade-orchestrator.js");
        const clusterName = url.searchParams.get("cluster") || null;
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const history = await getUpgradeHistory({ cluster: clusterName, limit });
        sendJson(res, 200, { history });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // Cancel an active upgrade session
    if (req.method === "POST" && url.pathname === "/api/upgrade/cancel") {
      try {
        const body = await readJsonBody(req);
        const { cancelSession } = await import("./services/upgrade-orchestrator.js");
        const session = await cancelSession(body.sessionId, body.reason || "Cancelled by user");
        sendJson(res, 200, { session, message: "Upgrade cancelled" });
      } catch (err) { sendJson(res, 400, { error: err.message }); }
      return;
    }

    // Deprecated-API consumers — who still calls this API (from APIRequestCount)
    if (req.method === "GET" && url.pathname === "/api/upgrade/api-consumers") {
      try {
        const api = url.searchParams.get("api");
        if (!api) { sendJson(res, 200, { error: "api query param (group/version) is required" }); return; }
        const out = await withClusterContext(url, async () => getDeprecatedAPIConsumers(api));
        if (out === null) { sendJson(res, 200, { error: "Selected cluster is not reachable." }); return; }
        sendJson(res, 200, out);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // GPU fleet overview — DCGM-sourced inventory / utilization / health.
    // Graceful { available:false } when the GPU Operator/DCGM isn't present.
    if (req.method === "GET" && url.pathname === "/api/dashboard/gpu") {
      try {
        const out = await withClusterContext(url, async () => getGpuOverview());
        if (out === null) { sendJson(res, 200, { available: false, reason: "cluster-unreachable", message: "Selected cluster is not reachable." }); return; }
        sendJson(res, 200, out);
      } catch (err) { sendJson(res, 200, { available: false, reason: "error", message: err.message }); }
      return;
    }

    // AI migration plan for a deprecated API (grounded in its live consumers)
    if (req.method === "POST" && url.pathname === "/api/upgrade/api-migration") {
      if (enforceRateLimit(req, res, { burst: 6, refillPerSec: 0.15 })) return;
      try { await handleApiMigrationAPI(req, res); }
      catch (e) { if (!res.headersSent) sendJson(res, 500, { error: e.message }); }
      if (!res.headersSent) sendJson(res, 200, { error: "Migration plan unavailable." });
      return;
    }

    // Upgrade Orchestrator API — /api/upgrade/orchestrator/<action>
    const orchMatch = url.pathname.match(/^\/api\/upgrade\/orchestrator\/(\w[\w-]*)$/);
    if (orchMatch) {
      await handleUpgradeOrchestrator(req, res, orchMatch[1]);
      return;
    }

    // ServiceNow CR status check
    if (req.method === "POST" && url.pathname === "/api/itsm/cr-status") {
      // Buffer the body so we can read it and still pass it to the handler
      const rawBody = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
      const parsedBody = JSON.parse(rawBody.toString());
      const { ticketId: crTicketId } = parsedBody;
      // Create a wrapper so handleCRStatusCheck can still read the body
      const fakeReq = Object.create(req);
      fakeReq._body = rawBody;
      fakeReq.on = function (evt, cb) {
        if (evt === "data") { cb(rawBody); return this; }
        if (evt === "end") { cb(); return this; }
        return req.on(evt, cb);
      };
      await handleCRStatusCheck(fakeReq, res);
      // Sync CR status to tracking DB
      try {
        if (crTicketId) {
          await syncCRFromServiceNow(crTicketId);
        }
      } catch (e) {}
      return;
    }

    // ── App Change Watcher API ─────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/dashboard/app-changes") {
      const clusterName = url.searchParams.get("cluster") || "local";
      try {
        const handler = async () => {
          const ns = url.searchParams.get("namespace") || undefined;
          const namespaces = getWatchedNamespaces(clusterName);

          let discoveredNamespaces = null;
          try { discoveredNamespaces = await discoverAppNamespaces(); } catch {}

          // Scope every change record to the currently-tracked namespaces, so
          // the widget only ever shows changes for namespaces the user tracks
          // (and a removed namespace's changes disappear immediately).
          const watchedSet = new Set(namespaces);
          const log = getChangeLog(clusterName).filter(e => watchedSet.has(e.namespace));
          const filtered = ns ? log.filter(e => e.namespace === ns) : log;
          const totalChanges = filtered.length;
          const critical = filtered.filter(e => e.severity === "critical").length;
          const warning = filtered.filter(e => e.severity === "warning").length;
          const info = filtered.filter(e => e.severity === "info").length;
          const baselines = getTrackedWorkloadCount(clusterName);

          const timelineStats = getTimelineStats(clusterName);

          const changeTypeBreakdown = {};
          for (const e of filtered) {
            const t = e.changeType || "other";
            changeTypeBreakdown[t] = (changeTypeBreakdown[t] || 0) + 1;
          }

          let gitopsDrift = null;
          try {
            const driftResults = await scanGitOpsDrift();
            if (driftResults.length > 0) {
              const synced = driftResults.filter(d => !d.isDrifted).length;
              const drifted = driftResults.filter(d => d.isDrifted).length;
              const unhealthy = driftResults.filter(d => !d.isHealthy).length;
              gitopsDrift = {
                argoInstalled: true,
                totalApps: driftResults.length,
                synced, drifted, unhealthy,
                apps: driftResults.slice(0, 20).map(d => ({
                  name: d.appName,
                  targetNamespace: d.targetNamespace,
                  syncStatus: d.syncStatus,
                  healthStatus: d.healthStatus,
                  isDrifted: d.isDrifted,
                  isHealthy: d.isHealthy,
                  driftSeverity: d.driftSeverity,
                  outOfSyncCount: d.outOfSyncResources.length,
                  outOfSyncResources: d.outOfSyncResources.slice(0, 5),
                  lastSynced: d.lastSynced,
                })),
              };
            }
          } catch {}

          const history = getChangeHistory(clusterName).filter(e => watchedSet.has(e.namespace));

          let nsRecommendations = null;
          if (discoveredNamespaces) {
            try {
              nsRecommendations = scoreNamespaceRecommendations(
                discoveredNamespaces, log, Object.keys(getBaselines(clusterName))
              );
            } catch {}
          }

          let correlations = {};
          try { correlations = detectChangeCorrelations(log); } catch {}

          const namespaceHealth = {};
          for (const nsItem of namespaces) {
            try {
              const [deps, sts, pods] = await Promise.allSettled([
                ocpGet(`/apis/apps/v1/namespaces/${nsItem}/deployments`),
                ocpGet(`/apis/apps/v1/namespaces/${nsItem}/statefulsets`),
                ocpGet(`/api/v1/namespaces/${nsItem}/pods`),
              ]);
              const depCount = deps.status === "fulfilled" ? (deps.value.items || []).length : 0;
              const stsCount = sts.status === "fulfilled" ? (sts.value.items || []).length : 0;
              const podList = pods.status === "fulfilled" ? (pods.value.items || []) : [];
              const podCount = podList.length;
              const runningPods = podList.filter(p => p.status?.phase === "Running").length;
              const nsChanges = filtered.filter(e => e.namespace === nsItem);
              const nsCrit = nsChanges.filter(e => e.riskLevel === "critical" || e.riskLevel === "high").length;
              namespaceHealth[nsItem] = { deployments: depCount, statefulsets: stsCount, pods: podCount, runningPods, changes: nsChanges.length, highRiskChanges: nsCrit };
            } catch {
              namespaceHealth[nsItem] = { deployments: 0, statefulsets: 0, pods: 0, runningPods: 0, changes: 0, highRiskChanges: 0 };
            }
          }

          return {
            watchedNamespaces: namespaces,
            trackedWorkloads: baselines,
            newChanges: filtered.filter(e => !e.acknowledged).length,
            totalChanges, critical, warning, info,
            lastScanTime: getLastScanTime(clusterName),
            lastChangeTime: getLastChangeTime(clusterName),
            healthStreakMs: getHealthStreak(clusterName),
            discoveredNamespaces: discoveredNamespaces ? discoveredNamespaces.map(d => ({ namespace: d.ns, workloads: d.count, breakdown: d.breakdown || {} })) : null,
            changeTypeBreakdown,
            timelineStats,
            gitopsDrift,
            recentChanges: filtered.filter(e => !e.acknowledged).slice(0, 30).map(e => ({
              id: e.id, namespace: e.namespace, kind: e.kind, name: e.name,
              severity: e.severity, timestamp: e.timestamp,
              changeType: e.changeType || "other",
              followUp: e.followUp || false,
              followUpCount: e.followUpCount || 0,
              riskScore: e.riskScore || 0,
              riskLevel: e.riskLevel || "low",
              changedBy: e.changedBy || null,
              changeFreezeViolation: e.changeFreezeViolation || false,
              correlatedEvents: (e.correlatedEvents || []).slice(0, 5),
              aiExplanation: generateRiskExplanation(e),
              correlatedWith: correlations[e.id] || [],
              changes: e.changes.map(c => ({ field: c.field, old: c.old, new: c.new, severity: c.severity })),
              rollbackPreview: e.baseline ? {
                replicas: e.baseline.replicas,
                containers: (e.baseline.containers || []).map(c => ({ name: c.name, image: c.image, ports: c.ports })),
              } : null,
              blastRadius: e.currentSpec?.replicas || null,
            })),
            changeHistory: history.slice(0, 50),
            namespaceHealth,
            nsRecommendations,
            correlations,
          };
        };

        // The tracked-namespace list is managed on the HUB (via POST
        // /namespaces), so it is always hub-authoritative — never let a spoke's
        // cached snapshot (which has its own, usually empty, list) mask the
        // user's selection. We overlay the hub list onto every response.
        let authoritativeNs = getWatchedNamespaces(clusterName);
        // Self-heal: if memory is empty but a list was persisted (startup load
        // may have run before the API client was ready), reload it now.
        if ((!authoritativeNs || authoritativeNs.length === 0) && (clusterName === "local")) {
          try { authoritativeNs = await rehydrateTrackedNamespaces("local"); } catch {}
        }
        const authoritativeCount = getTrackedWorkloadCount(clusterName);
        const result = await withClusterContext(url, handler);
        if (result === null) {
          const cached = getAgentCachedResponse(clusterName, "/api/dashboard/app-changes", { skipFreshnessCheck: true });
          if (cached) return sendJson(res, 200, { ...cached, watchedNamespaces: authoritativeNs, trackedWorkloads: authoritativeCount });
          return sendJson(res, 200, { watchedNamespaces: authoritativeNs, trackedWorkloads: authoritativeCount, newChanges: 0, totalChanges: 0, critical: 0, warning: 0, info: 0, recentChanges: [], discoveredNamespaces: null, changeHistory: [] });
        }
        // Even on the happy path, guarantee the tracked list reflects the hub.
        if (result && typeof result === "object" && (!result.watchedNamespaces || result.watchedNamespaces.length === 0) && authoritativeNs.length > 0) {
          result.watchedNamespaces = authoritativeNs;
          result.trackedWorkloads = authoritativeCount;
        }
        sendJson(res, 200, result);
      } catch (err) {
        console.error("[app-changes] GET handler error:", err.message);
        sendJson(res, 200, { watchedNamespaces: getWatchedNamespaces(clusterName), trackedWorkloads: 0, newChanges: 0, totalChanges: 0, critical: 0, warning: 0, info: 0, recentChanges: [], error: err.message });
      }
      return;
    }

    // ── App Change Watcher — Auto-discover + Watch ──────────────────
    if (req.method === "POST" && url.pathname === "/api/dashboard/app-changes/discover") {
      const _acCluster = url.searchParams.get("cluster") || "local";
      try {
        const result = await withClusterContext(url, () => autoDiscoverAndWatch(_acCluster));
        if (result === null) return sendJson(res, 200, { discovered: 0, added: 0, total: 0, namespaces: [] });
        sendJson(res, 200, {
          discovered: result.discovered,
          added: result.added,
          total: result.total,
          namespaces: result.namespaces.map(d => ({ namespace: d.ns, workloads: d.count })),
        });
      } catch (err) {
        sendJson(res, 200, { discovered: 0, added: 0, total: 0, namespaces: [], error: err.message });
      }
      return;
    }

    // ── App Change Watcher — Namespace management ─────────────────
    if (req.method === "POST" && url.pathname === "/api/dashboard/app-changes/namespaces") {
      const _acCluster = url.searchParams.get("cluster") || "local";
      try {
        const body = await readJsonBody(req);
        const action = body.action;
        const nsList = body.namespaces || [];
        if (action === "add" && nsList.length > 0) {
          await addNamespaces(nsList, _acCluster);
          console.log(`[app-changes] Added namespaces for cluster "${_acCluster}":`, nsList);
          initNamespaceBaselines(nsList, _acCluster).catch(e =>
            console.warn("[app-watcher] Background baseline init error:", e.message)
          );
          sendJson(res, 200, {
            watchedNamespaces: getWatchedNamespaces(_acCluster),
            trackedWorkloads: getTrackedWorkloadCount(_acCluster),
            baselineStatus: "initializing",
          });
        } else if (action === "remove" && nsList.length > 0) {
          await removeNamespaces(nsList, _acCluster);
          console.log(`[app-changes] Removed namespaces for cluster "${_acCluster}":`, nsList);
          sendJson(res, 200, {
            watchedNamespaces: getWatchedNamespaces(_acCluster),
            trackedWorkloads: getTrackedWorkloadCount(_acCluster),
          });
        } else {
          sendJson(res, 200, {
            watchedNamespaces: getWatchedNamespaces(_acCluster),
            trackedWorkloads: getTrackedWorkloadCount(_acCluster),
          });
        }
      } catch (err) {
        console.error("[app-changes] Namespace management error:", err.message);
        sendJson(res, 200, { watchedNamespaces: getWatchedNamespaces(_acCluster), error: err.message });
      }
      return;
    }

    // ── App Change Watcher — Force scan now ────────────────────────
    if (req.method === "POST" && url.pathname === "/api/dashboard/app-changes/scan") {
      const _acCluster = url.searchParams.get("cluster") || "local";
      try {
        const [workloadChanges, configChanges] = await Promise.allSettled([
          scanForChanges(_acCluster),
          scanConfigChanges(_acCluster),
        ]);
        const wc = workloadChanges.status === "fulfilled" ? workloadChanges.value : [];
        const cc = configChanges.status === "fulfilled" ? configChanges.value : [];
        const log = getChangeLog(_acCluster).filter(e => !e.acknowledged);
        sendJson(res, 200, {
          scanned: true,
          newChanges: wc.length + cc.length,
          pendingChanges: log.length,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        sendJson(res, 200, { scanned: false, newChanges: 0, pendingChanges: 0, error: err.message });
      }
      return;
    }

    // ── App Change Watcher — Reset baselines ─────────────────────
    if (req.method === "POST" && url.pathname === "/api/dashboard/app-changes/reset-baselines") {
      const _acCluster = url.searchParams.get("cluster") || "local";
      try {
        const result = await withClusterContext(url, async () => {
          const ns = getWatchedNamespaces(_acCluster);
          await initNamespaceBaselines(ns, _acCluster);
          return {
            reset: true,
            namespaces: ns.length,
            baselines: Object.keys(getBaselines(_acCluster)).length,
          };
        });
        sendJson(res, 200, result || { reset: false });
      } catch (err) {
        sendJson(res, 200, { reset: false, error: err.message });
      }
      return;
    }

    // ── App Change Watcher — Change actions (agree/dismiss/ack) ────
    if (req.method === "POST" && url.pathname === "/api/dashboard/app-changes/action") {
      const _acCluster = url.searchParams.get("cluster") || "local";
      try {
        const body = await readJsonBody(req);
        const { changeId, action } = body;
        if (!changeId || !action) {
          sendJson(res, 400, { found: false, error: "Missing changeId or action" });
          return;
        }
        let result;
        if (action === "agree") {
          result = await agreeChange(changeId, _acCluster);
        } else if (action === "acknowledge") {
          result = await acknowledgeChange(changeId, _acCluster);
        } else if (action === "dismiss") {
          result = await dismissChange(changeId, _acCluster);
        } else {
          result = { found: false, error: "Unknown action. Use: agree, dismiss, acknowledge" };
        }
        if (!result || !result.found) {
          sendJson(res, 404, result || { found: false, error: "Change not found" });
        } else if (result.error) {
          sendJson(res, 500, result);
        } else {
          sendJson(res, 200, result);
        }
      } catch (err) {
        console.error(`[app-changes] action error:`, err.message);
        sendJson(res, 500, { found: false, error: err.message });
      }
      return;
    }

    // ── App Change Watcher — AI impact analysis ────────────────────
    if (req.method === "POST" && url.pathname === "/api/dashboard/app-changes/analyze") {
      const _acCluster = url.searchParams.get("cluster") || "local";
      try {
        const body = await readJsonBody(req);
        const { changeId } = body;
        if (!changeId) { sendJson(res, 400, { error: "Missing changeId" }); return; }
        const result = await analyzeChangeImpact(changeId, _acCluster);
        sendJson(res, result.error ? 500 : 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // ── App Change Watcher — Bulk actions ──────────────────────────
    if (req.method === "POST" && url.pathname === "/api/dashboard/app-changes/bulk-action") {
      const _acCluster = url.searchParams.get("cluster") || "local";
      try {
        const body = await readJsonBody(req);
        const { action, filter } = body;
        if (!action) { sendJson(res, 400, { error: "Missing action" }); return; }
        const result = await withClusterContext(url, async () => {
          return await bulkAction(action, filter || {}, _acCluster);
        });
        sendJson(res, result?.error ? 500 : 200, result || { error: "Agent offline" });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // ── App Change Watcher — Workload timeline ─────────────────────
    if (req.method === "GET" && url.pathname === "/api/dashboard/app-changes/timeline") {
      const _acCluster = url.searchParams.get("cluster") || "local";
      const ns = url.searchParams.get("namespace");
      const kind = url.searchParams.get("kind");
      const name = url.searchParams.get("name");
      if (!ns || !kind || !name) { sendJson(res, 400, { error: "Missing namespace, kind, or name" }); return; }
      const result = getWorkloadTimeline(ns, kind, name, _acCluster);
      sendJson(res, 200, result);
      return;
    }

    // ── App Change Watcher — Workload listing ──────────────────────
    if (req.method === "GET" && url.pathname === "/api/dashboard/app-changes/workloads") {
      const _acCluster = url.searchParams.get("cluster") || "local";
      try {
        const result = await withClusterContext(url, async () => {
          const byNs = getWorkloadsByNamespace(_acCluster);
          return {
            namespaces: Object.entries(byNs).map(([ns, wl]) => ({
              namespace: ns,
              workloads: wl,
              count: wl.length,
            })).sort((a, b) => b.count - a.count),
            total: Object.values(byNs).reduce((s, wl) => s + wl.length, 0),
          };
        });
        sendJson(res, 200, result || { namespaces: [], total: 0, error: "Agent offline" });
      } catch (err) {
        sendJson(res, 200, { namespaces: [], total: 0, error: err.message });
      }
      return;
    }

    // ── Image Vulnerability Scanner API ──────────────────────────────
    // Merge the hub's own image-vuln scan with connected spokes' cached
    // snapshots into one fleet-wide view. Additive; only used when
    // FLEET_SCAN_ENABLED. Reuses the agent cache — no new remote scan calls.
    const buildFleetImageVulns = (localData) => {
      const clusters = [];
      const seen = new Set();
      const merged = [];
      const addFrom = (clusterName, d) => {
        if (!d || d.available === false) return;
        let c = 0, h = 0, m = 0, l = 0, imgs = 0;
        for (const img of (d.topImages || [])) {
          const key = `${clusterName}::${img.fullImage || img.image}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push({ ...img, cluster: clusterName });
          c += img.critical || 0; h += img.high || 0; m += img.medium || 0; l += img.low || 0; imgs++;
        }
        clusters.push({
          cluster: clusterName, images: imgs,
          critical: c, high: h, medium: m, low: l,
          grade: d.grade || "?", scannerType: d.scannerType || "unknown",
        });
      };
      addFrom(HUB_CLUSTER_NAME, localData);
      for (const [name] of _connectedAgents) {
        const cached = getAgentCachedResponse(name, "/api/dashboard/image-vulns", { skipFreshnessCheck: true });
        if (cached) addFrom(name, cached);
      }
      merged.sort((a, b) => (b.critical * 100 + b.high * 10 + b.medium) - (a.critical * 100 + a.high * 10 + a.medium));
      const t = merged.reduce((s, i) => ({
        critical: s.critical + (i.critical || 0), high: s.high + (i.high || 0),
        medium: s.medium + (i.medium || 0), low: s.low + (i.low || 0),
        fixable: s.fixable + (i.fixable || 0), total: s.total + (i.total || 0),
      }), { critical: 0, high: 0, medium: 0, low: 0, fixable: 0, total: 0 });
      return {
        ...localData,
        fleet: { enabled: true, totalClusters: clusters.length, clusters },
        totalImages: merged.length,
        totalVulns: t.total, critical: t.critical, high: t.high, medium: t.medium, low: t.low, fixable: t.fixable,
        topImages: merged.slice(0, 30),
      };
    };

    if (req.method === "GET" && url.pathname === "/api/dashboard/image-vulns") {
      const _ivHandler = async () => {
        const ns = url.searchParams.get("namespace") || undefined;
        const scan = await runImageScan(ns);
        // Integration status of every scanner engine (for the Scan Sources panel)
        let sources = [];
        try {
          sources = await detectScanSources();
          for (const s of sources) s.active = (s.id === scan.scannerType);
        } catch { sources = []; }
        const riskScore = Math.max(0, 100 - scan.critical * 15 - scan.high * 8 - scan.medium * 3 - scan.low * 1);
        const grade = riskScore >= 90 ? "A" : riskScore >= 80 ? "B" : riskScore >= 70 ? "C" : riskScore >= 60 ? "D" : "F";

        // CISA KEV (Known Exploited Vulnerabilities) — representative subset of
        // real CVE IDs from the CISA catalog. A scanned CVE that matches is
        // flagged as actively exploited (industry-standard prioritization).
        const KEV_SET = new Set([
          "CVE-2021-44228", "CVE-2021-45046", "CVE-2022-22965", "CVE-2022-1388",
          "CVE-2021-4034", "CVE-2014-0160", "CVE-2017-5638", "CVE-2018-7600",
          "CVE-2019-0708", "CVE-2020-1472", "CVE-2021-26855", "CVE-2022-30190",
          "CVE-2023-23397", "CVE-2023-34362", "CVE-2023-4863", "CVE-2024-3094",
          "CVE-2021-22205", "CVE-2022-0847", "CVE-2021-3156", "CVE-2016-5195",
        ]);
        const isExploitable = (v) => KEV_SET.has((v.id || "").toUpperCase()) || (v.cvss || 0) >= 9.0;

        // Count actively-exploitable findings across all scanned images
        let exploitableCount = 0;
        for (const r of scan.results) {
          for (const v of (r.vulnerabilities || [])) if (isExploitable(v)) exploitableCount++;
        }

        // One-line, human-readable reason behind the grade — the "why"
        const comp = scan.compliance || {};
        const reasonParts = [];
        if (scan.critical > 0) reasonParts.push(`${scan.critical} Critical`);
        if (scan.high > 0) reasonParts.push(`${scan.high} High`);
        if (exploitableCount > 0) reasonParts.push(`${exploitableCount} actively exploited`);
        if ((comp.signed || 0) === 0 && (comp.total || 0) > 0) reasonParts.push(`0/${comp.total} signed`);
        if ((scan.maxCVSS || 0) > 0) reasonParts.push(`max CVSS ${(scan.maxCVSS).toFixed(1)}`);
        const scoreReason = reasonParts.length ? reasonParts.join(" · ") : "No significant findings";

        // Recommended remediation per image — the dominant fix action
        const recommendFix = (r) => {
          const fixables = (r.vulnerabilities || []).filter(v => v.fixedBy);
          if (fixables.length === 0) return null;
          // Prefer a concrete package upgrade if present
          const pkgFix = fixables.find(v => v.package && /^\d|\bv?\d+\./.test(String(v.fixedBy || "")));
          if (pkgFix) return `Upgrade ${pkgFix.package} → ${pkgFix.fixedBy} (fixes ${fixables.length} of ${r.totalVulns})`;
          return `${fixables[0].fixedBy} — resolves ${fixables.length} of ${r.totalVulns} findings`;
        };

        return {
          scannerType: scan.scannerType,
          sources,
          coverage: scan.coverage || null,
          timestamp: scan.timestamp,
          scope: scan.namespace,
          totalImages: scan.totalImages,
          totalVulns: scan.totalVulns,
          critical: scan.critical,
          high: scan.high,
          medium: scan.medium,
          low: scan.low,
          fixable: scan.fixable,
          exploitable: exploitableCount,
          maxCVSS: scan.maxCVSS || 0,
          riskScore, grade, scoreReason,
          compliance: scan.compliance || { avgScore: 0, signed: 0, sbom: 0, pinned: 0, trusted: 0, total: 0 },
          ageSummary: scan.ageSummary || { fresh: 0, aging: 0, stale: 0, current: 0, unknown: 0 },
          topImages: scan.results.slice(0, 30).map(r => ({
            image: r.image.length > 60 ? "..." + r.image.slice(-57) : r.image,
            fullImage: r.image,
            namespace: r.namespace,
            source: r.source || null,
            critical: r.critical, high: r.high, medium: r.medium, low: r.low,
            fixable: r.fixable, total: r.totalVulns,
            maxCVSS: r.maxCVSS || 0,
            exploitable: (r.vulnerabilities || []).filter(isExploitable).length,
            recommendedFix: recommendFix(r),
            age: r.age || null,
            pods: r.pods ? r.pods.slice(0, 5).map(p => ({ pod: p.pod, namespace: p.namespace, container: p.container })) : [],
            complianceBadges: r.compliance?.badges || [],
            complianceScore: r.compliance?.score || 0,
            complianceIssues: r.compliance?.issues || [],
            vulnerabilities: (r.vulnerabilities || []).slice(0, 20).map(v => ({
              id: v.id, severity: v.severity, package: v.package || "", version: v.version || "",
              fix: v.fixedBy, cvss: v.cvss || 0, link: v.link || null,
              exploitable: isExploitable(v), kev: KEV_SET.has((v.id || "").toUpperCase()),
              description: (v.description || "").slice(0, 150),
            })),
          })),
          history: getScanHistory().slice(0, 5),
        };
      };
      try {
        const data = await withClusterContext(url, _ivHandler);
        if (data === null) {
          const _ivCluster = url.searchParams.get("cluster");
          const cached = getAgentCachedResponse(_ivCluster, "/api/dashboard/image-vulns", { skipFreshnessCheck: true });
          if (cached) return sendJson(res, 200, cached);
          return sendJson(res, 200, { available: false, source: "agent-cache", message: "Not installed on this cluster" });
        }
        // Fleet mode: only for the aggregate (no specific cluster requested).
        // OFF by default → single-cluster response is byte-identical to today.
        if (FLEET_SCAN_ENABLED && !url.searchParams.get("cluster") && data && data.available !== false) {
          return sendJson(res, 200, buildFleetImageVulns(data));
        }
        sendJson(res, 200, data);
      } catch (err) {
        sendJson(res, 200, { scannerType: "unknown", totalImages: 0, totalVulns: 0, critical: 0, high: 0, medium: 0, low: 0, fixable: 0, maxCVSS: 0, riskScore: 0, grade: "?", topImages: [], history: [], compliance: { avgScore: 0, signed: 0, sbom: 0, pinned: 0, trusted: 0, total: 0 }, ageSummary: { fresh: 0, aging: 0, stale: 0, current: 0, unknown: 0 }, error: err.message });
      }
      return;
    }

    // ── RCA API ──────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/rca/history") {
      sendJson(res, 200, { history: getRCAHistory(), active: getActiveInvestigations().length });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/rca/investigate") {
      try {
        const body = await readJsonBody(req);
        let { namespace, pod } = body;
        if (!namespace && !pod) { sendJson(res, 400, { error: "namespace or pod required" }); return; }
        // Run in the selected cluster's context so RCA targets the right cluster.
        const result = await withClusterContext(url, async () => {
          // If only a pod name was given, locate which namespace it lives in —
          // so "investigate pod X" diagnoses THAT pod, not the whole cluster.
          if (pod && !namespace) {
            let located = null;
            try {
              const byName = await ocpGet(`/api/v1/pods?fieldSelector=metadata.name=${encodeURIComponent(pod)}&limit=5`);
              located = (byName.items || [])[0] || null;
            } catch { /* fall through to broad scan */ }
            if (!located) {
              try {
                const all = await ocpGet(`/api/v1/pods?limit=2000`);
                located = (all.items || []).find((p) => p.metadata?.name === pod)
                  || (all.items || []).find((p) => (p.metadata?.name || "").startsWith(pod)) || null;
              } catch { /* ignore */ }
            }
            if (!located) {
              const stem = pod.split("-").slice(0, -2).join("-") || pod;
              return { error: `Pod "${pod}" was not found in any namespace on this cluster. It may have been replaced — try: oc get pods -A | grep ${stem}` };
            }
            namespace = located.metadata.namespace;
            pod = located.metadata.name;
          }
          return pod ? await runRCA(namespace, pod) : await runNamespaceRCA(namespace);
        });
        if (result === null) { sendJson(res, 200, { error: "Selected cluster is not reachable for RCA." }); return; }
        sendJson(res, 200, result);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Compliance API ──────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/compliance/results") {
      const results = getComplianceResults();
      sendJson(res, 200, results || { score: null, message: "No scan run yet. Trigger a scan first." });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/compliance/history") {
      sendJson(res, 200, { history: getComplianceHistory() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/compliance/scan") {
      try {
        const body = await readJsonBody(req);
        const results = await runComplianceScan(body || {});
        sendJson(res, 200, results);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // Post-deploy CIS verification scoped to ONE namespace. Runs the full CIS
    // scanner on the (selected) cluster and returns only the findings for the
    // requested namespace — the "closed-loop" security check for the App
    // Deployment Agent right after it deploys.
    if (req.method === "POST" && url.pathname === "/api/compliance/scan-namespace") {
      if (enforceRateLimit(req, res, { burst: 4, refillPerSec: 0.1 })) return;
      try {
        const body = await readJsonBody(req);
        const ns = String(body.namespace || "").trim();
        if (!ns) { sendJson(res, 200, { error: "namespace is required" }); return; }
        const scan = await withClusterContext(url, async () => runComplianceScan({}));
        if (scan === null) { sendJson(res, 200, { error: "Selected cluster is not reachable for scanning." }); return; }
        const nsFindings = (scan.findings || []).filter((f) => f.namespace === ns);
        const issues = nsFindings.filter((f) => f.status && f.status !== "PASS");
        // CIS scanner taxonomy is critical / warning / info.
        const sev = { critical: 0, warning: 0, info: 0 };
        for (const f of issues) { const s = String(f.severity || "").toLowerCase(); if (s in sev) sev[s]++; }
        const failedControls = [...new Set(issues.map((f) => f.id))];
        const clean = issues.length === 0;
        const grade = clean ? "A" : sev.critical ? "F" : sev.warning ? "C" : "B";
        sendJson(res, 200, {
          namespace: ns,
          scannedAt: scan.scanTime || scan.timestamp || null,
          clean,
          grade,
          issueCount: issues.length,
          severity: sev,
          failedControls,
          findings: issues.slice(0, 40).map((f) => ({
            id: f.id, title: f.title, severity: f.severity, status: f.status,
            resource: f.resource, remediation: f.remediation,
          })),
        });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // CIS remediation — every control returns a guided plan (dry-run) with the
    // exact fix (manifest/command). Controls with a SAFE, namespace-scoped fix
    // (type "auto") can also be applied one-click → re-scan → audit-log.
    // Behavior-changing controls are "guided": copy the fix, review, apply.
    // No ServiceNow CR anywhere in this flow.
    if (req.method === "POST" && url.pathname === "/api/compliance/remediate") {
      if (enforceRateLimit(req, res, { burst: 4, refillPerSec: 0.1 })) return;
      try {
        const body = await readJsonBody(req);
        const controlId = body.controlId || "";
        const dryRun = body.dryRun !== false;
        const latest = getComplianceResults();
        const findings = (latest?.findings || []).filter(f => f.id === controlId);
        const namespaces = [...new Set(findings.filter(f => f.namespace).map(f => f.namespace))];
        const ns0 = namespaces[0] || "<namespace>";
        const limitRange = (ns) => ({ apiVersion: "v1", kind: "LimitRange", metadata: { name: "mcp-default-limits", namespace: ns, labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" } }, spec: { limits: [{ type: "Container", default: { cpu: "500m", memory: "512Mi" }, defaultRequest: { cpu: "100m", memory: "128Mi" } }] } });
        const baselineNetpol = (ns) => ({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "mcp-baseline-deny", namespace: ns, labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" } }, spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [{ from: [{ podSelector: {} }] }], egress: [{ to: [{ namespaceSelector: {} }] }, { ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] }] } });

        const REM = {
          "CIS-5.2.4": { type: "auto", title: "Apply default resource limits (LimitRange)",
            steps: ["Apply a LimitRange with default container cpu/memory limits & requests to each affected namespace.", "New/restarted pods inherit the defaults; roll deployments to apply to running pods."],
            manifest: () => namespaces.length ? limitRange(ns0) : null,
            apply: async () => { const applied = [], failed = []; for (const ns of namespaces) { const lr = limitRange(ns); try { await ocpPost(`/api/v1/namespaces/${ns}/limitranges`, lr); applied.push(ns); } catch { try { await ocpPatch(`/api/v1/namespaces/${ns}/limitranges/mcp-default-limits`, { spec: lr.spec }, "application/merge-patch+json"); applied.push(ns); } catch (e2) { failed.push({ namespace: ns, error: e2.message }); } } } return { appliedCount: applied.length, applied, failed }; } },
          "CIS-5.3.1": { type: "guided", title: "Add a baseline NetworkPolicy per namespace",
            steps: ["Create a default-deny NetworkPolicy that still allows same-namespace traffic and DNS.", "⚠ Review app connectivity — this changes network behavior before applying."],
            manifest: () => namespaces.length ? baselineNetpol(ns0) : null },
          "CIS-5.3.3": { type: "guided", title: "Use a dedicated ServiceAccount (not 'default')",
            steps: ["Create a dedicated ServiceAccount and bind it to the workload."],
            command: () => `oc create sa app-sa -n ${ns0}\noc set serviceaccount deployment/<name> app-sa -n ${ns0}` },
          "CIS-5.2.3": { type: "guided", title: "Remove hostNetwork",
            steps: ["Set spec.template.spec.hostNetwork: false and roll the workload.", "Use a Service/Route for access instead of the host network."],
            command: () => `oc patch deployment/<name> -n ${ns0} --type=merge \\\n  -p '{"spec":{"template":{"spec":{"hostNetwork":false}}}}'` },
          "CIS-5.2.1": { type: "guided", title: "Drop privileged securityContext",
            steps: ["Set securityContext.privileged: false and remove unneeded capabilities."],
            command: () => `oc patch deployment/<name> -n ${ns0} --type=json \\\n  -p '[{"op":"replace","path":"/spec/template/spec/containers/0/securityContext/privileged","value":false}]'` },
          "CIS-5.2.2": { type: "guided", title: "Remove hostPID / hostIPC",
            steps: ["Set spec.template.spec.hostPID: false and hostIPC: false, then roll the workload."],
            command: () => `oc patch deployment/<name> -n ${ns0} --type=merge \\\n  -p '{"spec":{"template":{"spec":{"hostPID":false,"hostIPC":false}}}}'` },
          "CIS-5.2.5": { type: "guided", title: "Add a readiness probe",
            steps: ["Add a readinessProbe to the container spec matching your app's health endpoint."],
            manifest: () => ({ readinessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 5, periodSeconds: 10 } }) },
          "CIS-5.5.1": { type: "guided", title: "Pin image to a specific tag/digest",
            steps: ["Replace ':latest' with a specific version tag, or pin to an immutable @sha256 digest."],
            command: () => `# find the running digest, then pin it:\noc get pod <pod> -n ${ns0} -o jsonpath='{.status.containerStatuses[0].imageID}'\noc set image deployment/<name> <container>=<repo>@sha256:<digest> -n ${ns0}` },
          "CIS-5.5.2": { type: "guided", title: "Use an approved registry",
            steps: ["Mirror the image into your approved/internal registry and update the workload image reference."],
            command: () => `oc set image deployment/<name> <container>=<approved-registry>/<repo>:<tag> -n ${ns0}` },
          "CIS-5.4.1": { type: "guided", title: "Mount secrets as files, not env vars",
            steps: ["Mount the Secret as a volume instead of exposing it via env — reduces exposure in process listings/logs."],
            command: () => `# add a secret volume + volumeMount to the workload, remove the secretKeyRef env entries` },
          "CIS-5.3.2": { type: "guided", title: "Avoid direct LoadBalancer exposure",
            steps: ["Expose the service via an Ingress/Route behind the cluster ingress instead of a LoadBalancer, or restrict source ranges."],
            command: () => `oc expose service <svc> -n ${ns0}   # create a Route instead of type=LoadBalancer` },
          "CIS-5.1.1": { type: "guided", title: "Restrict cluster-admin usage",
            steps: ["Replace broad cluster-admin bindings with least-privilege roles scoped to what the subject needs."],
            command: () => `oc get clusterrolebindings -o wide | grep cluster-admin   # review and tighten` },
        };

        const rem = REM[controlId];
        if (!rem) {
          sendJson(res, 200, { controlId, type: "guided", title: "Remediation guidance", steps: findings[0]?.remediation ? [findings[0].remediation] : ["Refer to the CIS benchmark guidance for this control."], affectedCount: findings.length, namespaces, applicable: false });
          return;
        }
        if (dryRun) {
          sendJson(res, 200, {
            dryRun: true, controlId, type: rem.type, title: rem.title,
            steps: rem.steps || [], command: rem.command ? rem.command() : null, manifest: rem.manifest ? rem.manifest() : null,
            affectedCount: findings.length, namespaces,
            resources: findings.slice(0, 50).map(f => ({ namespace: f.namespace, resource: f.resource })),
            applicable: rem.type === "auto",
            note: rem.type === "auto" ? "Safe, namespace-scoped change — one-click Apply available." : "Behavior-changing — copy the fix, review, and apply it yourself. No blind apply.",
          });
          return;
        }
        // Apply — only for safe "auto" controls
        if (rem.type !== "auto" || !rem.apply) {
          sendJson(res, 200, { applied: false, manual: true, controlId, message: "This control uses guided remediation — copy and apply the provided fix after review." });
          return;
        }
        const result = await rem.apply();
        if (featureFlags.pillar7AuditLog()) logAuditEvent({ command: `compliance-remediate ${controlId}`, dryRun: false, classification: "compliance-remediation", allowed: true, success: (result.failed || []).length === 0, durationMs: 0 }).catch(() => {});
        let rescan = null;
        try { const r = await runComplianceScan(); rescan = { score: r.score, grade: r.grade, totals: r.totals }; } catch {}
        sendJson(res, 200, { dryRun: false, controlId, ...result, rescan, note: "Applied. New/restarted pods comply immediately; roll affected deployments to apply to running pods now." });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Network Topology API ────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/network/topology") {
      try {
        const ns = url.searchParams.get("namespace");
        const result = ns ? await getNetworkTopology(ns) : await getClusterTopology();
        sendJson(res, 200, result);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // Per-namespace WORKLOAD topology (Route → Service → Workload → Pods) with
    // component health and cross-component error detection. Powers the
    // click-through topology popup from the Namespace Heatmap.
    if (req.method === "GET" && url.pathname === "/api/topology/namespace") {
      try {
        const ns = url.searchParams.get("namespace");
        if (!ns) { sendJson(res, 200, { error: "namespace query param is required" }); return; }
        const expand = url.searchParams.get("expand") === "1";
        const result = await withClusterContext(url, async () => getNamespaceTopology(ns, { expand }));
        if (result === null) { sendJson(res, 200, { error: "Selected cluster is not reachable." }); return; }
        sendJson(res, 200, result);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // AI root-cause narration for a namespace topology (Explain / highlight).
    if (req.method === "POST" && url.pathname === "/api/topology/explain") {
      if (enforceRateLimit(req, res, { burst: 6, refillPerSec: 0.15 })) return;
      try { await handleTopologyExplainAPI(req, res); }
      catch (e) { if (!res.headersSent) sendJson(res, 500, { error: e.message }); }
      if (!res.headersSent) sendJson(res, 200, { error: "Explain unavailable." });
      return;
    }

    // Fix-from-node: rolling-restart a workload directly from the topology.
    if (req.method === "POST" && url.pathname === "/api/topology/remediate") {
      if (enforceRateLimit(req, res, { burst: 5, refillPerSec: 0.1 })) return;
      try {
        const body = await readJsonBody(req);
        const ns = body.namespace, name = body.name;
        const kind = String(body.kind || "").toLowerCase();
        const dryRun = body.dryRun !== false;
        const plural = kind === "statefulset" ? "statefulsets" : kind === "daemonset" ? "daemonsets" : kind === "deployment" ? "deployments" : null;
        if (!ns || !name || !plural) { sendJson(res, 200, { error: "Fix supports Deployment/StatefulSet/DaemonSet nodes only." }); return; }
        const out = await withClusterContext(url, async () => {
          const path = `/apis/apps/v1/namespaces/${ns}/${plural}/${name}`;
          let desired = 0, ready = 0;
          try {
            const w = await ocpGet(path);
            desired = kind === "daemonset" ? (w.status?.desiredNumberScheduled ?? 0) : (w.spec?.replicas ?? 0);
            ready = kind === "daemonset" ? (w.status?.numberReady ?? 0) : (w.status?.readyReplicas ?? 0);
          } catch (e) { return { error: `Could not read ${kind}/${name}: ${e.message}` }; }
          const healthy = desired > 0 && ready >= desired;
          const action = `Rolling restart ${kind}/${name} in ${ns}`;
          if (dryRun) return { dryRun: true, action, kind, name, namespace: ns, ready, desired, healthy };
          const patch = { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } };
          await ocpPatch(path, patch, "application/strategic-merge-patch+json");
          return { dryRun: false, action, kind, name, namespace: ns, ready, desired, healthy };
        });
        if (out === null) { sendJson(res, 200, { error: "Selected cluster is not reachable." }); return; }
        if (out.error) { sendJson(res, 200, { error: out.error }); return; }
        if (out.dryRun === false && featureFlags.pillar7AuditLog()) logAuditEvent({ command: `topology-restart ${out.kind}/${out.name}`, dryRun: false, classification: "topology-remediation", allowed: true, success: true, durationMs: 0 }).catch(() => {});
        if (out.dryRun === false) fleetRemember({
          kind: "topology-fix",
          cluster: url.searchParams.get("cluster") || "local",
          namespace: out.namespace, workload: `${out.kind}/${out.name}`,
          symptom: (body.symptom || `${out.kind}/${out.name} unhealthy (${out.ready}/${out.desired} ready)`).slice(0, 300),
          action: out.action,
          outcome: "fix-applied",
        });
        sendJson(res, 200, out);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Fleet memory — stats & similarity recall (debug/UI surface) ──
    if (req.method === "GET" && url.pathname === "/api/memory/stats") {
      sendJson(res, 200, fleetMemoryStats());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/memory/recall") {
      const q = url.searchParams.get("q") || "";
      sendJson(res, 200, { query: q, hits: q ? fleetRecall(q, 5) : [] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/network/exposed") {
      try { sendJson(res, 200, { services: await getExposedServices() }); }
      catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/network/unprotected") {
      try { sendJson(res, 200, { namespaces: await getUnprotectedNamespaces() }); }
      catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Capacity Forecast API ───────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/capacity/forecast") {
      try { sendJson(res, 200, await getCapacityForecast()); }
      catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/capacity/history") {
      sendJson(res, 200, { snapshots: getCapacityHistory() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/capacity/snapshot") {
      try { const snap = await captureCapacitySnapshot(); sendJson(res, 200, { ok: true, snapshot: snap }); }
      catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── SLO Tracker API ─────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/slo/status") {
      try { sendJson(res, 200, { slos: await getSLOStatus() }); }
      catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/slo/list") {
      sendJson(res, 200, { slos: getAllSLOs() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/slo/define") {
      try {
        const body = await readJsonBody(req);
        const slo = await defineSLO(body);
        sendJson(res, 200, slo);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/slo/delete") {
      try {
        const body = await readJsonBody(req);
        await deleteSLO(body.id);
        sendJson(res, 200, { ok: true });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── RBAC API (namespace-scoped) ────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/rbac/roles") {
      sendJson(res, 200, { roles: getRoles(), userRoles: getAllUserRoles() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/rbac/assign") {
      try {
        const body = await readJsonBody(req);
        const ok = await setUserRole(body.username, body.role, body.namespaces);
        sendJson(res, ok ? 200 : 400, ok ? { ok: true } : { error: "Invalid role" });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Policy Engine API ───────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/policies") {
      sendJson(res, 200, { policies: getPolicies() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/policies") {
      try {
        const body = await readJsonBody(req);
        const policy = await createPolicy(body);
        logAuditTrailEvent({ type: "config_change", severity: "info", title: `Policy created: ${policy.name}`, details: { policyId: policy.id }, username: req.user?.name }).catch(() => {});
        sendJson(res, 201, policy);
      } catch (err) { sendJson(res, 400, { error: err.message }); }
      return;
    }
    {
      const policyMatch = url.pathname.match(/^\/api\/policies\/([^/]+)$/);
      if (policyMatch && req.method === "GET") {
        const p = getPolicy(decodeURIComponent(policyMatch[1]));
        if (p) sendJson(res, 200, p); else sendJson(res, 404, { error: "Policy not found" });
        return;
      }
      if (policyMatch && req.method === "PUT") {
        try {
          const body = await readJsonBody(req);
          const p = await updatePolicy(decodeURIComponent(policyMatch[1]), body);
          sendJson(res, 200, p);
        } catch (err) { sendJson(res, 400, { error: err.message }); }
        return;
      }
      if (policyMatch && req.method === "DELETE") {
        try {
          await deletePolicy(decodeURIComponent(policyMatch[1]));
          sendJson(res, 200, { ok: true });
        } catch (err) { sendJson(res, 400, { error: err.message }); }
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/policies/evaluate") {
      try {
        const body = await readJsonBody(req);
        const findings = await evaluatePolicies(body || {});
        sendJson(res, 200, { findings, count: findings.length });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/policies/cluster") {
      try {
        const policies = await getClusterPolicies();
        sendJson(res, 200, policies);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Notification Channels API ───────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/notifications/channels") {
      sendJson(res, 200, { channels: getChannels() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/notifications/channels") {
      try {
        const body = await readJsonBody(req);
        const ch = await createChannel(body);
        logAuditTrailEvent({ type: "config_change", severity: "info", title: `Notification channel created: ${ch.name}`, details: { channelId: ch.id, type: ch.type }, username: req.user?.name }).catch(() => {});
        sendJson(res, 201, ch);
      } catch (err) { sendJson(res, 400, { error: err.message }); }
      return;
    }
    {
      const chMatch = url.pathname.match(/^\/api\/notifications\/channels\/([^/]+)$/);
      if (chMatch && req.method === "PUT") {
        try {
          const body = await readJsonBody(req);
          const ch = await updateChannel(decodeURIComponent(chMatch[1]), body);
          sendJson(res, 200, ch);
        } catch (err) { sendJson(res, 400, { error: err.message }); }
        return;
      }
      if (chMatch && req.method === "DELETE") {
        try {
          await deleteChannel(decodeURIComponent(chMatch[1]));
          sendJson(res, 200, { ok: true });
        } catch (err) { sendJson(res, 400, { error: err.message }); }
        return;
      }
      const testMatch = url.pathname.match(/^\/api\/notifications\/channels\/([^/]+)\/test$/);
      if (testMatch && req.method === "POST") {
        try {
          const result = await testChannel(decodeURIComponent(testMatch[1]));
          sendJson(res, 200, result);
        } catch (err) { sendJson(res, 400, { error: err.message }); }
        return;
      }
    }
    if (req.method === "GET" && url.pathname === "/api/notifications/history") {
      sendJson(res, 200, { history: getNotificationHistory() });
      return;
    }

    // ── Audit Trail API ─────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/audit-trail") {
      try {
        const filters = {
          type: url.searchParams.get("type") || undefined,
          severity: url.searchParams.get("severity") || undefined,
          namespace: url.searchParams.get("namespace") || undefined,
          username: url.searchParams.get("username") || undefined,
          from: url.searchParams.get("from") || undefined,
          to: url.searchParams.get("to") || undefined,
          limit: parseInt(url.searchParams.get("limit") || "100", 10),
          offset: parseInt(url.searchParams.get("offset") || "0", 10),
        };
        const result = await queryAuditLog(filters);
        sendJson(res, 200, result);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/audit-trail/stats") {
      try {
        const days = parseInt(url.searchParams.get("days") || "30", 10);
        const stats = await getAuditStats(days);
        sendJson(res, 200, stats);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/audit-trail/export") {
      try {
        const filters = {
          type: url.searchParams.get("type") || undefined,
          from: url.searchParams.get("from") || undefined,
          to: url.searchParams.get("to") || undefined,
        };
        const format = url.searchParams.get("format") || "json";
        const data = await exportAuditLog(filters, format);
        if (format === "csv") {
          res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=audit-trail.csv" });
          res.end(data);
        } else {
          sendJson(res, 200, typeof data === "string" ? JSON.parse(data) : data);
        }
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Query Traces API ───────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/traces") {
      try {
        const filters = {
          limit: parseInt(url.searchParams.get("limit") || "50", 10),
          offset: parseInt(url.searchParams.get("offset") || "0", 10),
          conversationId: url.searchParams.get("conversationId") || undefined,
          agentId: url.searchParams.get("agentId") || undefined,
          fromDate: url.searchParams.get("from") || undefined,
          toDate: url.searchParams.get("to") || undefined,
        };
        const result = await getTraces(filters);
        sendJson(res, 200, result);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/traces/") && !url.pathname.includes("/stats") && !url.pathname.includes("/analytics")) {
      try {
        const traceId = decodeURIComponent(url.pathname.split("/api/traces/")[1]);
        const trace = await getTrace(traceId);
        if (!trace) return sendJson(res, 404, { error: "Trace not found" });
        sendJson(res, 200, trace);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/traces/stats") {
      try {
        const days = parseInt(url.searchParams.get("days") || "30", 10);
        const stats = await getTraceStats({ days });
        sendJson(res, 200, stats);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/traces/analytics") {
      try {
        const days = parseInt(url.searchParams.get("days") || "30", 10);
        const analytics = await getAgentAnalytics({ days });
        sendJson(res, 200, analytics);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Incident Lifecycle Manager API ──────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/incidents") {
      try {
        const filters = {
          status: url.searchParams.get("status") || undefined,
          severity: url.searchParams.get("severity") || undefined,
          assignee: url.searchParams.get("assignee") || undefined,
          cluster: url.searchParams.get("cluster") || undefined,
          limit: parseInt(url.searchParams.get("limit") || "50", 10),
          offset: parseInt(url.searchParams.get("offset") || "0", 10),
        };
        const result = await listIncidents(filters);
        sendJson(res, 200, result);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/incidents/stats") {
      try {
        const days = parseInt(url.searchParams.get("days") || "30", 10);
        const incCluster = url.searchParams.get("cluster") || undefined;
        sendJson(res, 200, await getLifecycleIncidentStats({ days, cluster: incCluster }));
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/incidents") {
      try {
        const body = await readJsonBody(req);
        const incident = await declareIncident({
          title: body.title,
          description: body.description,
          severity: body.severity || "sev3",
          affectedNamespaces: body.affectedNamespaces || [],
          affectedServices: body.affectedServices || [],
          linkedAlerts: body.linkedAlerts || [],
          declaredBy: body.declaredBy || "dashboard",
          cluster: body.cluster || url.searchParams.get("cluster") || "local",
        });
        sendJson(res, 201, incident);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    const incMatch = url.pathname.match(/^\/api\/incidents\/(INC-[^/]+)$/);
    if (incMatch && req.method === "GET") {
      try {
        const incident = await getIncident(incMatch[1]);
        if (!incident) return sendJson(res, 404, { error: "Not found" });
        sendJson(res, 200, incident);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (incMatch && req.method === "PATCH") {
      try {
        const body = await readJsonBody(req);
        const actor = body.actor || "dashboard";
        const patch = { ...body };
        delete patch.actor;
        const updated = await updateIncident(incMatch[1], patch, actor);
        sendJson(res, 200, updated);
      } catch (err) { sendJson(res, 400, { error: err.message }); }
      return;
    }
    const incResolveMatch = url.pathname.match(/^\/api\/incidents\/(INC-[^/]+)\/resolve$/);
    if (incResolveMatch && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const updated = await resolveIncident(incResolveMatch[1], {
          actor: body.actor || "dashboard",
          resolutionNote: body.resolutionNote,
          rootCause: body.rootCause,
        });
        sendJson(res, 200, updated);
      } catch (err) { sendJson(res, 400, { error: err.message }); }
      return;
    }
    const incCloseMatch = url.pathname.match(/^\/api\/incidents\/(INC-[^/]+)\/close$/);
    if (incCloseMatch && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const updated = await closeIncident(incCloseMatch[1], {
          actor: body.actor || "dashboard",
          postmortem: body.postmortem,
        });
        sendJson(res, 200, updated);
      } catch (err) { sendJson(res, 400, { error: err.message }); }
      return;
    }
    const incTimelineMatch = url.pathname.match(/^\/api\/incidents\/(INC-[^/]+)\/timeline$/);
    if (incTimelineMatch && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const updated = await addTimelineEvent(incTimelineMatch[1], {
          actor: body.actor || "dashboard",
          action: body.action || "note",
          note: body.note || "",
        });
        sendJson(res, 200, updated);
      } catch (err) { sendJson(res, 400, { error: err.message }); }
      return;
    }

    // ── Change Timeline API ─────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/change-timeline") {
      try {
        const filters = {
          namespace: url.searchParams.get("namespace") || undefined,
          sources: url.searchParams.get("sources") ? url.searchParams.get("sources").split(",") : undefined,
          severity: url.searchParams.get("severity") || undefined,
          fromDate: url.searchParams.get("from") || undefined,
          toDate: url.searchParams.get("to") || undefined,
          limit: parseInt(url.searchParams.get("limit") || "100", 10),
          offset: parseInt(url.searchParams.get("offset") || "0", 10),
        };
        const result = await getChangeTimelineUnified(filters);
        sendJson(res, 200, result);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/change-timeline/correlate") {
      try {
        const ts = url.searchParams.get("ts") || new Date().toISOString();
        const windowMinutes = parseInt(url.searchParams.get("windowMin") || "15", 10);
        const result = await correlateAroundTime({ timestamp: ts, windowMinutes });
        sendJson(res, 200, result);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/change-timeline/stats") {
      try {
        const days = parseInt(url.searchParams.get("days") || "7", 10);
        sendJson(res, 200, await getChangeTimelineStats({ days }));
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Compliance Framework Profiles API ───────────────────────────
    if (req.method === "GET" && url.pathname === "/api/compliance/frameworks") {
      try {
        sendJson(res, 200, { frameworks: getFrameworkList() });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    const fwMatch = url.pathname.match(/^\/api\/compliance\/frameworks\/([^/]+)$/);
    if (fwMatch && req.method === "GET") {
      try {
        const fw = getFramework(fwMatch[1]);
        if (!fw) return sendJson(res, 404, { error: "Framework not found" });
        const cisResults = getComplianceResults();
        const cisFindings = cisResults?.findings || [];
        const evaluation = evaluateFramework(fwMatch[1], cisFindings);
        sendJson(res, 200, { framework: fw, evaluation });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/compliance/frameworks-summary") {
      try {
        const cisResults = getComplianceResults();
        const cisFindings = cisResults?.findings || [];
        sendJson(res, 200, { results: evaluateAllFrameworks(cisFindings) });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── ChatOps API (inbound Slack/Teams) ──────────────────────────
    if (req.method === "POST" && url.pathname === "/api/chatops/slack/command") {
      try {
        const bodyText = await new Promise((resolve, reject) => {
          let data = ""; req.on("data", (c) => data += c); req.on("end", () => resolve(data)); req.on("error", reject);
        });
        const sig = req.headers["x-slack-signature"];
        const ts = req.headers["x-slack-request-timestamp"];
        if (process.env.SLACK_SIGNING_SECRET && !verifySlackSignature(bodyText, sig, ts, process.env.SLACK_SIGNING_SECRET)) {
          return sendJson(res, 401, { error: "Invalid signature" });
        }
        const params = new URLSearchParams(bodyText);
        const parsedBody = Object.fromEntries(params.entries());
        const reply = await handleSlackSlashCommand(parsedBody);
        sendJson(res, 200, reply);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chatops/slack/interactive") {
      try {
        const bodyText = await new Promise((resolve, reject) => {
          let data = ""; req.on("data", (c) => data += c); req.on("end", () => resolve(data)); req.on("error", reject);
        });
        const sig = req.headers["x-slack-signature"];
        const ts = req.headers["x-slack-request-timestamp"];
        if (process.env.SLACK_SIGNING_SECRET && !verifySlackSignature(bodyText, sig, ts, process.env.SLACK_SIGNING_SECRET)) {
          return sendJson(res, 401, { error: "Invalid signature" });
        }
        const params = new URLSearchParams(bodyText);
        const payload = JSON.parse(params.get("payload") || "{}");
        const reply = await handleSlackInteraction(payload);
        sendJson(res, 200, reply);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chatops/teams/action") {
      try {
        const body = await readJsonBody(req);
        const reply = await handleTeamsAction(body);
        sendJson(res, 200, reply);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Prometheus SLO Config API ───────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/prometheus/status") {
      try {
        const status = await getPrometheusStatus();
        sendJson(res, 200, status);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/prometheus/configure") {
      try {
        const body = await readJsonBody(req);
        const url2 = await setPrometheusUrl(body.url);
        sendJson(res, 200, { ok: true, url: url2 });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Document-Driven Deployment API ──────────────────────────────
    // Async parse jobs — avoids HAProxy route timeout on long LLM calls
    if (req.method === "POST" && url.pathname === "/api/deploy/upload") {
      try {
        const ct = req.headers["content-type"] || "";
        let docBuffer, format, providerOpts = {};
        if (ct.includes("multipart/form-data")) {
          const raw = await readRawBody(req);
          const parts = parseMultipart(raw, ct);
          const filePart = parts.find((p) => p.filename);
          if (!filePart) { sendJson(res, 400, { error: "No file uploaded" }); return; }
          docBuffer = filePart.data;
          format = filePart.filename.endsWith(".docx") ? "docx" : "text";
          const optsPart = parts.find((p) => p.name === "providerOpts");
          if (optsPart) { try { providerOpts = JSON.parse(optsPart.data.toString()); } catch {} }
        } else {
          const body = await readJsonBody(req);
          providerOpts = body.providerOpts || {};
          if (body.document) {
            if (body.format === "docx") {
              docBuffer = Buffer.from(body.document, "base64");
              format = "docx";
            } else {
              docBuffer = body.document;
              format = "text";
            }
          } else {
            sendJson(res, 400, { error: "No document provided" });
            return;
          }
        }
        // Parse doc immediately (fast), then queue LLM extraction async
        const parsed = format === "docx" ? await parseDocx(docBuffer) : parseMarkdownText(String(docBuffer));
        const parseId = "parse-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        _parseJobs.set(parseId, { status: "extracting", sectionCount: parsed.sections.length });
        // Return immediately so the HTTP connection isn't held through the LLM call
        sendJson(res, 202, { parseId, status: "extracting", sectionCount: parsed.sections.length });
        console.log("[deploy] Parse job", parseId, "started, provider:", providerOpts.provider, "sections:", parsed.sections.length);
        // Run LLM extraction in background
        extractAIS(parsed, providerOpts)
          .then(({ intent, missingFields, confidence }) => {
            console.log("[deploy] Parse job", parseId, "completed, confidence:", confidence, "missing:", missingFields.length);
            _parseJobs.set(parseId, { status: "done", intent, missingFields, confidence, sectionCount: parsed.sections.length });
          })
          .catch((err) => {
            console.error("[deploy] Parse job", parseId, "FAILED:", err.message);
            _parseJobs.set(parseId, { status: "error", error: err.message });
          });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // SOP Runner (Phase A) — compile an SOP doc/text into a preview plan
    if (req.method === "POST" && url.pathname === "/api/sop/compile") {
      if (enforceRateLimit(req, res, { burst: 6, refillPerSec: 0.2 })) return;
      try {
        const ct = req.headers["content-type"] || "";
        let sopText = "", llmOpts = {};
        if (ct.includes("multipart/form-data")) {
          const raw = await readRawBody(req);
          const parts = parseMultipart(raw, ct);
          const filePart = parts.find((p) => p.filename);
          if (filePart) {
            const parsed = filePart.filename.endsWith(".docx")
              ? await parseDocx(filePart.data)
              : parseMarkdownText(filePart.data.toString());
            sopText = (parsed.sections || []).map(s => `${s.heading || ""}\n${s.text || s.content || ""}`).join("\n") || parsed.text || filePart.data.toString();
          }
          const optsPart = parts.find((p) => p.name === "llmOpts");
          if (optsPart) { try { llmOpts = JSON.parse(optsPart.data.toString()); } catch {} }
        } else {
          const body = await readJsonBody(req);
          sopText = body.text || body.document || "";
          llmOpts = body.llmOpts || {};
        }
        if (!sopText.trim()) { sendJson(res, 400, { error: "No SOP text or file provided" }); return; }
        const plan = await compileSOPPlan(sopText, llmOpts);
        sendJson(res, 200, plan);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // SOP Runner (Phase B) — execute a compiled plan (dry-run or apply)
    if (req.method === "POST" && url.pathname === "/api/sop/execute") {
      if (enforceRateLimit(req, res, { burst: 4, refillPerSec: 0.1 })) return;
      await withClusterContext(url, async () => { await handleSOPExecuteAPI(req, res); });
      return;
    }
    // SOP Runner — roll back resources created by a prior execution
    if (req.method === "POST" && url.pathname === "/api/sop/rollback") {
      if (enforceRateLimit(req, res, { burst: 4, refillPerSec: 0.1 })) return;
      await withClusterContext(url, async () => { await handleSOPRollbackAPI(req, res); });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/deploy/parse-status") {
      const parseId = url.searchParams.get("id");
      if (!parseId) { sendJson(res, 400, { error: "id parameter required" }); return; }
      const job = _parseJobs.get(parseId);
      if (!job) { sendJson(res, 404, { error: "Parse job not found" }); return; }
      sendJson(res, 200, { parseId, ...job });
      if (job.status === "done" || job.status === "error") {
        setTimeout(() => _parseJobs.delete(parseId), 300_000);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/deploy/preview") {
      try {
        const body = await readJsonBody(req);
        if (!body.intent) { sendJson(res, 400, { error: "intent (AIS) is required" }); return; }
        const { manifests, summary } = generateManifests(body.intent);
        const yamlStr = renderYaml(manifests);
        const perTier = manifests.map((m) => ({ kind: m.kind, name: m.name, yaml: renderSingleYaml(m) }));
        sendJson(res, 200, { summary, manifests: perTier, fullYaml: yamlStr });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/deploy/apply") {
      try {
        const body = await readJsonBody(req);
        if (!body.intent) { sendJson(res, 400, { error: "intent (AIS) is required" }); return; }
        const { manifests } = generateManifests(body.intent);
        const deployId = createDeployment(body.intent, manifests);
        sendJson(res, 202, { deployId, status: "accepted", message: "Deployment queued" });
        executeDeployment(deployId).catch((err) => console.error("[deploy] execution failed:", err.message));
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/deploy/status") {
      const deployId = url.searchParams.get("id");
      if (!deployId) { sendJson(res, 400, { error: "id parameter required" }); return; }
      const dep = getDeployment(deployId);
      if (!dep) { sendJson(res, 404, { error: "Deployment not found" }); return; }
      sendJson(res, 200, dep);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/deploy/rollback") {
      try {
        const body = await readJsonBody(req);
        if (!body.deployId) { sendJson(res, 400, { error: "deployId required" }); return; }
        const result = await rollbackDeployment(body.deployId);
        sendJson(res, 200, result);
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/deploy/list") {
      sendJson(res, 200, { deployments: listDeployments().slice(0, 20) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/deploy/chat-action") {
      try {
        const body = await readJsonBody(req);
        const { action, parseId, field, value, tierName, corrections } = body;
        const job = parseId ? _parseJobs.get(parseId) : null;

        if (action === "show-yaml" && job?.intent) {
          const { manifests, summary } = generateManifests(job.intent);
          const yamlStr = renderYaml(manifests);
          const perManifest = manifests.map((m) => ({ kind: m.kind, name: m.name, yaml: renderSingleYaml(m) }));
          sendJson(res, 200, { action: "show-yaml", yaml: yamlStr, manifests: perManifest, summary });
          return;
        }

        if (action === "update-field" && job?.intent) {
          if (tierName) {
            const tier = job.intent.tiers?.find((t) => t.name === tierName);
            if (tier && field) {
              if (field === "replicas.min") { tier.replicas = tier.replicas || {}; tier.replicas.min = parseInt(value, 10) || 1; }
              else if (field === "replicas.max") { tier.replicas = tier.replicas || {}; tier.replicas.max = parseInt(value, 10) || 1; }
              else if (field === "image") tier.image = value;
              else if (field === "port") tier.port = parseInt(value, 10);
              else if (field === "role") tier.role = value;
              else if (field.startsWith("resources.")) { tier.resources = tier.resources || {}; tier.resources[field.split(".")[1]] = value; }
              else if (field.startsWith("storage.")) { tier.storage = tier.storage || {}; tier.storage[field.split(".")[1]] = value; }
              else tier[field] = value;
            }
          } else {
            if (field === "appName") job.intent.appName = value;
            else if (field === "namespace") job.intent.namespace = value;
            else if (field === "targetPlatform") job.intent.targetPlatform = value;
            else if (field === "environment") job.intent.environment = value;
          }
          const missingFields = validateAIS(job.intent);
          const confidence = calculateConfidence(job.intent, missingFields);
          job.missingFields = missingFields;
          job.confidence = confidence;
          _parseJobs.set(parseId, job);
          sendJson(res, 200, { action: "updated", intent: job.intent, missingFields, confidence });
          return;
        }

        if (action === "deploy" && job?.intent) {
          const { manifests } = generateManifests(job.intent);
          const deployId = createDeployment(job.intent, manifests);
          sendJson(res, 202, { action: "deploying", deployId, status: "accepted" });
          executeDeployment(deployId).catch((err) => console.error("[deploy] execution failed:", err.message));
          return;
        }

        if (action === "get-intent" && job?.intent) {
          sendJson(res, 200, { intent: job.intent, missingFields: job.missingFields, confidence: job.confidence });
          return;
        }

        sendJson(res, 400, { error: "Invalid action or no active parse job" });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/deploy/re-analyze") {
      try {
        const body = await readJsonBody(req);
        const { parseId, corrections, providerOpts: pOpts } = body;
        const job = parseId ? _parseJobs.get(parseId) : null;
        if (!job || !job.intent) { sendJson(res, 400, { error: "No active parse job" }); return; }

        // Apply corrections to the intent
        if (corrections && typeof corrections === "object") {
          for (const [key, val] of Object.entries(corrections)) {
            if (key === "tiers" && Array.isArray(val)) {
              // Merge tier corrections
              for (const tc of val) {
                const existing = job.intent.tiers?.find((t) => t.name === tc.name);
                if (existing) Object.assign(existing, tc);
              }
            } else {
              job.intent[key] = val;
            }
          }
        }

        const missingFields = validateAIS(job.intent);
        const confidence = calculateConfidence(job.intent, missingFields);
        job.missingFields = missingFields;
        job.confidence = confidence;
        _parseJobs.set(parseId, job);
        sendJson(res, 200, { intent: job.intent, missingFields, confidence });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Export API ──────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/export/report") {
      try {
        const type = url.searchParams.get("type") || "summary";
        const exportCluster = url.searchParams.get("cluster");
        if (exportCluster && exportCluster !== "local") {
          const cached = getAgentCachedResponse(exportCluster, "/api/cluster/summary", { skipFreshnessCheck: true });
          return sendJson(res, 200, { cluster: exportCluster, clusterHealth: cached?.summary || {}, source: "agent-cache" });
        }
        const report = {};
        if (type === "summary" || type === "all") {
          report.clusterHealth = _liveState?.summary || {};
          report.appChanges = { watchedNamespaces: getWatchedNamespaces().length, pendingChanges: getChangeLog().filter(e => !e.acknowledged).length };
          report.changeHistory = getChangeHistory().slice(0, 50);
        }
        if (type === "compliance" || type === "all") {
          report.compliance = getComplianceResults();
        }
        if (type === "vulnerabilities" || type === "all") {
          report.vulnerabilities = getScanHistory().slice(0, 10);
        }
        if (type === "capacity" || type === "all") {
          try { report.capacity = await getCapacityForecast(); } catch {}
        }
        if (type === "slo" || type === "all") {
          try { report.slo = await getSLOStatus(); } catch {}
        }
        report.generatedAt = new Date().toISOString();
        report.reportType = type;
        const format = url.searchParams.get("format") || "json";
        if (format === "csv") {
          const csvLines = ["Section,Key,Value"];
          const flatten = (obj, prefix) => {
            for (const [k, v] of Object.entries(obj || {})) {
              if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, `${prefix}.${k}`);
              else csvLines.push(`"${prefix}","${k}","${Array.isArray(v) ? v.length + ' items' : v}"`);
            }
          };
          flatten(report, "report");
          res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename=mcp-report-${type}-${Date.now()}.csv` });
          res.end(csvLines.join("\n"));
        } else {
          sendJson(res, 200, report);
        }
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    // ── Docs download ──────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/docs/download") {
      try {
        const docName = url.searchParams.get("doc") || "hld-lld";
        const docMap = {
          "hld-lld": "TCS-Agentic-AI-HLD-LLD-Design.docx",
          "network-arch": "TCS-Agentic-AI-Multi-Cluster-Network-Architecture.docx",
          "product-overview": "TCS-Agentic-AI-Product-Overview.docx",
          "customer-benefits": "TCS-Agentic-AI-Customer-Benefits.docx",
          "mcp-comparison": "TCS-Agentic-AI-vs-Official-MCP-Comparison.docx",
        };
        const fileName = docMap[docName];
        if (!fileName) { sendJson(res, 404, { error: "Unknown document: " + docName, available: Object.keys(docMap) }); return; }
        const filePath = resolve("docs", fileName);
        const fileData = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Content-Length": fileData.length,
        });
        res.end(fileData);
      } catch (err) {
        if (err.code === "ENOENT") sendJson(res, 404, { error: "Document not generated yet. Run: node docs/gen-hld-lld-doc.js" });
        else sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/docs/list") {
      const docs = [
        { id: "hld-lld", title: "HLD & LLD Architecture Design", description: "Complete high-level and low-level design with architecture diagrams" },
        { id: "network-arch", title: "Multi-Cluster Network Architecture", description: "Network connectivity, firewall rules, DNS, and TLS requirements" },
        { id: "product-overview", title: "Product Overview", description: "TCS Agentic AI product capabilities and features" },
        { id: "customer-benefits", title: "Customer Benefits", description: "Business value and ROI analysis" },
        { id: "mcp-comparison", title: "MCP Comparison", description: "TCS Agentic AI vs Official MCP feature comparison" },
      ];
      sendJson(res, 200, { docs });
      return;
    }

    // Dashboard REST API — /api/...
    if (url.pathname.startsWith("/api/")) {
      const _cl = url.searchParams.get("cluster");

      // In control mode, data-plane endpoints for the local cluster require
      // the hub-cluster MCP agent to be running. Without it, return 503 so the
      // dashboard shows "Deploy Agent" instead of stale/in-process data.
      if (MCP_MODE === "control" && (!_cl || _cl === "local") && DATA_PLANE_ENDPOINTS.has(url.pathname) && !hasSpoke(HUB_AGENT_CLUSTER)) {
        return sendJson(res, 503, { agentRequired: true, message: "MCP agent not deployed — run deploy/mcp/deploy.sh with --cluster-name hub-cluster" });
      }

      if (_cl && _cl !== "local") {
        const cached = getAgentCachedResponse(_cl, url.pathname);
        if (cached) { sendJson(res, 200, cached); return; }
      }
      const _isLocalCacheable = (!_cl || _cl === "local") && LOCAL_CACHEABLE.has(url.pathname);
      if (_isLocalCacheable) {
        const lc = getLocalCache(url.pathname);
        if (lc) { sendJson(res, 200, lc); return; }
      }
      try {
        const _cachePath = _isLocalCacheable ? url.pathname : null;
        const _proxyRes = _cachePath ? Object.create(res, {
          writeHead: { value: function(code, ...a) { this._code = code; return res.writeHead(code, ...a); } },
          end: { value: function(data) { if ((!this._code || this._code === 200) && data) { try { setLocalCache(_cachePath, JSON.parse(data)); } catch {} } return res.end(data); } },
        }) : res;
        const result = await withClusterContext(url, () => handleDashboardAPI(url.pathname, req, _proxyRes));
        if (result === null && _cl) {
          const cached = getAgentCachedResponse(_cl, url.pathname, { skipFreshnessCheck: true });
          if (cached) { sendJson(res, 200, cached); return; }
          if (!res.headersSent) sendJson(res, 503, { error: "Remote cluster data is not available. The agent may not be reporting or the cluster is unreachable.", source: "none" });
          return;
        }
      } catch (err) {
        if (_cl && _cl !== "local") {
          const cached = getAgentCachedResponse(_cl, url.pathname, { skipFreshnessCheck: true });
          if (cached) { sendJson(res, 200, cached); return; }
        }
        if (!res.headersSent) sendJson(res, _cl ? 503 : 500, { error: _cl ? "Remote cluster request failed" : err.message });
      }
      return;
    }

    // SSE stream — new session
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/message", res);
      const server = createMcpServer();

      sessions.set(transport.sessionId, { server, transport });
      res.on("close", () => {
        sessions.delete(transport.sessionId);
      });

      await server.connect(transport);
      return;
    }

    // Message endpoint — route to the correct session
    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId");
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or expired session" }));
        return;
      }
      await session.transport.handlePostMessage(req, res);
      return;
    }

    // Dashboard is now a separate pod (nginx + React). The MCP server is API-only.
    // If dashboard files still exist in the image (backward compat), serve them.
    // In spoke mode, return a JSON pointer to the hub dashboard.
    if (req.method === "GET" && MCP_MODE === "spoke") {
      const hubUrl = process.env.HUB_URL || process.env.HUB_SERVER_URL;
      if (hubUrl && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/sse") && !url.pathname.startsWith("/message") && !url.pathname.startsWith("/mcp/") && url.pathname !== "/healthz" && url.pathname !== "/readyz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ mode: "spoke", hubUrl, message: "This is a spoke MCP server. Access the dashboard at the hub." }));
        return;
      }
    }
    if (req.method === "GET" && (MCP_MODE === "hub" || MCP_MODE === "control") && !url.pathname.startsWith("/api/")) {
      // In the separated architecture, dashboard is served by nginx.
      // If someone hits the MCP server directly (not through nginx), return API info.
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          service: "TCS Agentic AI — MCP Server",
          mode: MCP_MODE,
          version: "1.2.0",
          message: "This is the API server. Access the dashboard via the tcs-dashboard service/route.",
          endpoints: { health: "/healthz", spokeStatus: "/api/spoke/status", agentStatus: "/api/agent/status" },
        }));
        return;
      }
    }
    // Backward compatibility: serve dashboard files if they exist in the image
    if (req.method === "GET") {
      const DASHBOARD_DIR = process.env.DASHBOARD_DIR || resolve(process.cwd(), "dashboard");
      const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
      const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".svg"]);
      // React app at / — legacy app moved to /old-app.
      // React SPA assets live under dashboard/app/ and are served for all non-API routes.
      let filePath;
      if (url.pathname === "/old-app" || url.pathname === "/old-app/") filePath = "index.html";
      else if (url.pathname.startsWith("/old-app/")) filePath = url.pathname.replace(/^\/old-app\//, "");
      else if (url.pathname === "/" || url.pathname === "/index.html") filePath = "app/index.html";
      else if (url.pathname.startsWith("/assets/")) filePath = "app" + url.pathname;
      else filePath = url.pathname.replace(/^\//, "");

      if (!startSSE._gzCache) startSSE._gzCache = new Map();
      const gzCache = startSSE._gzCache;

      try {
        const full = resolve(DASHBOARD_DIR, filePath);
        if (!full.startsWith(DASHBOARD_DIR)) throw new Error("forbidden");
        const data = await readFile(full);
        const ext = extname(full);
        const ct = MIME[ext] || "application/octet-stream";
        const acceptGzip = (req.headers["accept-encoding"] || "").includes("gzip");

        if (acceptGzip && COMPRESSIBLE.has(ext)) {
          let cached = gzCache.get(full);
          if (!cached || cached.srcLen !== data.length) {
            const gz = gzipSync(data, { level: 6 });
            cached = { gz, srcLen: data.length, etag: '"' + createHash("md5").update(gz).digest("hex") + '"' };
            gzCache.set(full, cached);
          }
          if (req.headers["if-none-match"] === cached.etag) {
            res.writeHead(304); res.end(); return;
          }
          res.writeHead(200, {
            "Content-Type": ct,
            "Content-Encoding": "gzip",
            "Cache-Control": ext === ".html" ? "no-cache, must-revalidate" : "public, max-age=86400",
            "Vary": "Accept-Encoding",
            "ETag": cached.etag,
          });
          res.end(cached.gz);
        } else {
          res.writeHead(200, {
            "Content-Type": ct,
            "Cache-Control": ext === ".html" ? "no-cache, must-revalidate" : "public, max-age=86400",
          });
          res.end(data);
        }
        return;
      } catch {
        // SPA fallback: serve the React app entry for any unknown route
        try {
          const spaPath = url.pathname.startsWith("/old-app") ? "index.html" : "app/index.html";
          const full = resolve(DASHBOARD_DIR, spaPath);
          const data = await readFile(full);
          const acceptGzip = (req.headers["accept-encoding"] || "").includes("gzip");
          if (acceptGzip) {
            let cached = gzCache.get(full);
            if (!cached || cached.srcLen !== data.length) {
              const gz = gzipSync(data, { level: 6 });
              cached = { gz, srcLen: data.length, etag: '"' + createHash("md5").update(gz).digest("hex") + '"' };
              gzCache.set(full, cached);
            }
            if (req.headers["if-none-match"] === cached.etag) {
              res.writeHead(304); res.end(); return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "gzip", "Cache-Control": "no-cache, must-revalidate", "Vary": "Accept-Encoding", "ETag": cached.etag });
            res.end(cached.gz);
          } else {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" });
            res.end(data);
          }
          return;
        } catch { /* fall through to 404 */ }
      }
    }

    // Fallback
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
   } catch (err) {
    console.error(`[server] Unhandled error on ${req.method} ${req.url}:`, err?.stack || err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `${err.message} [at ${(err.stack || "").split("\n")[1]?.trim() || "unknown"}]` }));
    }
   }
  });

  // Warm-load the Agent Registry so /.well-known/agent.json is fast on first hit.
  loadAgents().then((list) => {
    console.error(`  Agent Registry:   ${list.length} agents loaded`);
  }).catch(() => {});

  _httpServer = httpServer;
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.error(`TCS Agentic AI — MCP Gateway · Control Plane`);
    console.error(`  Server running on http://0.0.0.0:${PORT}`);
    console.error(`  MCP Gateway:      GET  /sse (tool routing to all clusters)`);
    console.error(`  MCP Message:      POST /message?sessionId=<id>`);
    console.error(`  Per-agent MCP:    GET  /mcp/<agent-id>/sse`);
    console.error(`  Agent discovery:  GET  /.well-known/agent.json`);
    console.error(`  Agent registry:   GET  /api/agents`);
    console.error(`  Agent heartbeat:  POST /api/agent/heartbeat`);
    console.error(`  OpenAPI spec:     GET  /openapi.yaml`);
    console.error(`  MCP Hub:          GET  /api/hub/servers`);
    console.error(`  Hub Tools:        GET  /api/hub/tools`);
    console.error(`  Orchestrator:     POST /api/hub/orchestrate`);
    console.error(`  Health check:     GET  /healthz`);
  });

  // Backfill historical CRs from executed_actions audit trail (one-time on startup)
  setTimeout(async () => {
    try {
      const r = await backfillFromAuditTrail();
      if (r && r.imported > 0) console.log(`[cr-backfill] Imported ${r.imported} historical CR(s) (${r.skipped} already tracked)`);
    } catch (e) {}
  }, 5000);

  // Background CR status sync — every 4 hours
  setInterval(async () => {
    try {
      const results = await syncAllPendingCRs();
      if (results && results.some(r => r.changed)) {
        console.log("[cr-sync] Updated:", results.filter(r => r.changed).map(r => r.ticketId + "→" + r.newStatus).join(", "));
      }
    } catch (e) {}
  }, 4 * 60 * 60 * 1000);

  // Daily cleanup of old CRs (90+ days)
  setInterval(async () => {
    try { await cleanupOldCRs(90); } catch (e) {}
  }, 24 * 60 * 60 * 1000);

  // Background upgrade session poller — checks CR status and upgrade progress
  const UPGRADE_POLL_INTERVAL = 60_000; // 60 seconds

  async function pollUpgradeSessions() {
    try {
      const { listSessions, stepCheckCRStatus, stepCheckUpgradeProgress, checkStageTimeouts } = await import("./services/upgrade-orchestrator.js");
      const timedOut = await checkStageTimeouts();
      if (timedOut.length > 0) {
        console.log(`[upgrade-poller] ${timedOut.length} session(s) timed out:`, timedOut.map(t => `${t.sessionId}@${t.state}`).join(", "));
      }
      const sessions = listSessions();
      for (const s of sessions) {
        try {
          if (s.state === "CR_SUBMITTED" && s.crTicketId) {
            const result = await stepCheckCRStatus(s.id);
            if (result?.status === "approved") {
              console.log(`[upgrade-poller] CR ${s.crTicketId} approved for ${s.cluster}`);
            }
          }
          if (s.state === "EXECUTING" || s.state === "MONITORING") {
            await stepCheckUpgradeProgress(s.id);
          }
        } catch (err) {
          console.error(`[upgrade-poller] Session ${s.id}: ${err.message}`);
        }
      }
    } catch {}
  }

  _upgradePollTimer = setInterval(pollUpgradeSessions, UPGRADE_POLL_INTERVAL);

  // ── Autonomous incident loop ────────────────────────────────────────────
  // Runs the threshold detector on a schedule and (a) closes incidents whose
  // condition self-resolved, (b) opens incidents for eligible new breaches when
  // INCIDENT_AUTO_ACT is enabled. Detection is always safe/read-only; only the
  // promotion half is gated. This is what makes the flow need no human trigger.
  const INCIDENT_POLL_INTERVAL = parseInt(process.env.INCIDENT_POLL_INTERVAL_MS || "120000", 10);

  async function pollIncidentDetections() {
    if (!featureFlags.incidentAutoDetect()) return;
    try {
      const { detectIncidents } = await import("./services/incident-detector.js");
      const { reconcileSelfHealed, autoPromoteDetections } = await import("./services/incident-orchestrator.js");
      const result = await detectIncidents();

      // 1. Self-heal first, so a condition that cleared never gets re-opened.
      const healed = await reconcileSelfHealed(result.activeSignatures || []);
      if (healed.length) {
        console.log(`[incident-loop] self-healed & closed: ${healed.map(h => h.incidentNumber || h.id).join(", ")}`);
      }

      // 2. Open incidents for eligible breaches (no-op unless AUTO_ACT is on).
      const promo = await autoPromoteDetections(result.incidents || [], { cluster: "local" });
      if (promo.enabled && promo.promoted.length) {
        console.log(`[incident-loop] auto-raised: ${promo.promoted.map(p => `${p.incidentNumber || p.sessionId}(${p.state})`).join(", ")}`);
      }
    } catch (e) {
      console.error(`[incident-loop] ${e.message}`);
    }
  }

  setInterval(pollIncidentDetections, INCIDENT_POLL_INTERVAL);

  // Reload config on SIGHUP (e.g. after ConfigMap update)
  process.on("SIGHUP", () => {
    console.error("[SIGHUP] Reloading configuration...");
    try { loadConfig(); } catch (e) { console.error("[SIGHUP] config reload failed:", e.message); }
    initSafety();
  });
}

// ---------------------------------------------------------------------------
// Entry point — choose transport based on MCP_TRANSPORT env var
// Default: "sse" when KUBERNETES_SERVICE_HOST is set, otherwise "stdio"
// ---------------------------------------------------------------------------
const mode =
  process.env.MCP_TRANSPORT ||
  (process.env.KUBERNETES_SERVICE_HOST ? "sse" : "stdio");

let _httpServer = null;
let _upgradePollTimer = null;
function gracefulShutdown(signal) {
  console.error(`[${signal}] Shutting down gracefully...`);
  if (_upgradePollTimer) clearInterval(_upgradePollTimer);
  if (_httpServer) _httpServer.close(() => console.error("[shutdown] HTTP server closed"));
  setTimeout(() => { console.error("[shutdown] Forcing exit"); process.exit(0); }, 10_000);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error) console.error(reason.stack);
});

if (mode === "sse") {
  startSSE().catch((err) => {
    console.error("Fatal error starting MCP server (SSE):", err);
    process.exit(1);
  });
} else {
  startStdio().catch((err) => {
    console.error("Fatal error starting MCP server (stdio):", err);
    process.exit(1);
  });
}
