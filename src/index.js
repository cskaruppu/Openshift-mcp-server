#!/usr/bin/env node

/**
 * OpenShift MCP Server
 * Model Context Protocol server for OpenShift Container Platform management
 * with ACM, Ansible Automation Platform, and ServiceNow integration.
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { gzipSync } from "node:zlib";

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
import { registerAppChangeWatcherTools, scanForChanges, getChangeLog, getWatchedNamespaces, getBaselines, discoverAppNamespaces, autoDiscoverAndWatch, scanGitOpsDrift, getChangeTimeline, getTimelineStats, addNamespaces, removeNamespaces, initNamespaceBaselines, acknowledgeChange, agreeChange, dismissChange, getWorkloadsByNamespace, initTrackedNamespaces } from "./tools/app-change-watcher.js";
import { registerImageVulnScannerTools, runImageScan, getScanResults, getScanHistory, getComplianceCache, getImageAgeCache } from "./tools/image-vulnerability-scanner.js";
import { authMiddleware, registerAuthRoutes, handleTokenLogin, getAuthMode } from "./services/auth.js";
import { handleDashboardAPI, handleLLMSettingsGet, handleLLMSettingsPost, handleLLMSettingsTest, handleServiceNowSettingsGet, handleServiceNowSettingsPost, handleServiceNowSettingsTest, handleUpgradeAnalyze, handleUpgradeStart, handleUpgradeStatus, handleUpgradeDryRun, handleUpgradeChannel, handleCRStatusCheck, restoreServiceNowSettings } from "./services/dashboard-api.js";
import { handleChatAPI, handleExecuteAPI, handleChatCompareAPI, handleChatInvestigateAPI, handleChatRunbookAPI, handleFeedbackAPI, handleFeedbackStatsAPI, handleRiskAnalysisAPI, trackSubmittedCR } from "./services/chat-api.js";
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
  isHistoryEnabled,
} from "./services/chat-history.js";
import { initDb, query as dbQuery, isEnabled as dbEnabled } from "./utils/db.js";
import { initCache, isEnabled as cacheReady } from "./utils/cache.js";
import { handleMetricsRequest } from "./services/metrics.js";
import { enforce as enforceRateLimit } from "./services/rate-limit.js";
import { startHealthCheckTask, getLatestHealthReport } from "./services/scheduler.js";
import { listFiringAlerts } from "./services/alertmanager.js";
import { initSafety, getSafetyMode } from "./services/safety.js";
import { redactIfEnabled } from "./services/redaction.js";
import { loadKubeconfig, registerMultiClusterTools } from "./services/multi-cluster.js";
import { handleAgentRoutes as handleAgentRegistryRoutes, loadAgents } from "./agents/registry.js";
import { handleAgentMcpRoutes } from "./agents/mcp-router.js";
import { loadConfig } from "./utils/config.js";
import { validateCommand, getAccessLevel, isToolAllowed } from "./security/command-validator.js";
import { initComponents, isToolRegistrationEnabled, getComponentCatalog, getComponentSummary } from "./security/component-registry.js";
import { initTelemetry, shutdownTelemetry, startSpan, traceChatRequest, traceToolCall, getTelemetryStatus } from "./utils/telemetry-otel.js";
import { ocpGet, setRemoteCluster, clearRemoteCluster } from "./utils/openshift-client.js";
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

const silencedAlerts = new Map();

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
    }
  } catch (err) {
    console.warn("[hub] Failed to load clusters from DB:", err.message);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function withClusterContext(url, handler) {
  const clusterName = url.searchParams.get("cluster");
  if (clusterName && clusterName !== "local") {
    const agent = _connectedAgents.get(clusterName);
    if (!agent || !agent.apiUrl) {
      throw Object.assign(new Error(`Unknown cluster: ${clusterName}`), { status: 404 });
    }
    setRemoteCluster(agent.apiUrl, agent.token);
    try {
      return await handler();
    } finally {
      clearRemoteCluster();
    }
  }
  return handler();
}

function esc(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

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

  // /api/chats/search?q=term
  if (url.pathname === "/api/chats/search" && req.method === "GET") {
    const q = url.searchParams.get("q") || "";
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const results = await searchChats(q, limit);
    return sendJson(res, 200, { results });
  }

  // /api/chats
  if (url.pathname === "/api/chats") {
    if (req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "100", 10);
      const chats = await listChats(limit);
      return sendJson(res, 200, { chats });
    }
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const chat = await createChat({ id: body.id, title: body.title });
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
      const crs = await getPendingCRs();
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
      const crs = await listCRs({ status, limit });
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

  // Restore registered clusters from DB
  await loadClustersFromDB();

  // Restore ServiceNow settings from DB/file into process.env
  try {
    await restoreServiceNowSettings();
  } catch (e) { console.warn("[startup] ServiceNow settings restore:", e.message); }

  // Restore silenced alerts from DB
  try {
    const rows = await dbQuery("SELECT name, namespace, silenced_at, expires_at FROM silenced_alerts WHERE expires_at > NOW()");
    for (const r of (rows?.rows || [])) {
      silencedAlerts.set(`${r.name}|${r.namespace}`, {
        name: r.name, namespace: r.namespace,
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
      const resp = await fetch(`${agent.apiUrl}/api/v1/namespaces?limit=1`, {
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
      if (!agent.apiUrl) continue;
      // Skip agent-sourced clusters that report in regularly
      if (agent.source === "agent" && agent.lastReportTime) {
        const elapsed = (Date.now() - new Date(agent.lastReportTime).getTime()) / 1000;
        if (elapsed < 300) continue; // Agent reported recently, trust it
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

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

    // Health check endpoint for K8s probes
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
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
      const body = await readBody(req);
      const parsed = JSON.parse(body);
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
      const [predictions] = await Promise.allSettled([runPredictiveAnalysis()]);
      return sendJson(res, 200, {
        proactive: getInsightsSummary(),
        insights: getInsights().slice(0, 10),
        predictions: predictions.status === "fulfilled" ? predictions.value : [],
        knowledgeBase: kbGetStats(),
        automationRules: listRules().length,
        monitoring: isMonitorRunning(),
      });
    }

    // -----------------------------------------------------------------------
    // Cluster info — lightweight version/node summary for the global selector
    // -----------------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/cluster-info") {
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
        return sendJson(res, 200, info);
      } catch (err) {
        return sendJson(res, err.status || 200, err.status ? { error: err.message } : { version: "unknown", nodeCount: 0, readyNodes: 0, error: err.message });
      }
    }

    // -----------------------------------------------------------------------
    // Cluster Registration — add K8s clusters via dashboard (direct API)
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/hub/clusters" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { name, platform, apiUrl, token } = body;
      if (!name) return sendJson(res, 400, { error: "Cluster name is required" });
      if (!apiUrl) return sendJson(res, 400, { error: "API server URL is required" });

      let testResult = null;
      try {
        const testResp = await fetch(`${apiUrl}/api/v1/namespaces?limit=1`, {
          headers: {
            Authorization: token ? `Bearer ${token}` : undefined,
            Accept: "application/json",
          },
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

      _connectedAgents.set(name, {
        clusterName: name,
        platform: platform || "k8s",
        apiUrl,
        token: token || null,
        registeredAt: new Date().toISOString(),
        lastReport: null,
        lastReportTime: null,
        status: testResult?.ok ? "live" : "registered",
        connectionTest: testResult,
        source: "dashboard",
      });

      saveClustersToDB().catch(() => {});
      console.error(`[hub] Cluster registered: ${name} (${platform}) — test: ${testResult?.ok ? "OK" : "failed"}`);
      return sendJson(res, 200, {
        ok: true,
        cluster: { name, platform, status: testResult?.ok ? "live" : "registered" },
        connectionTest: testResult,
      });
    }

    if (url.pathname === "/api/hub/clusters" && req.method === "GET") {
      const clusters = [];
      for (const [, agent] of _connectedAgents) {
        // Determine real status from multiple signals
        const agentReportElapsed = agent.lastReportTime
          ? (Date.now() - new Date(agent.lastReportTime).getTime()) / 1000
          : null;
        const healthCheckElapsed = agent.lastHealthCheck
          ? (Date.now() - new Date(agent.lastHealthCheck).getTime()) / 1000
          : null;

        let status;
        if (agentReportElapsed !== null && agentReportElapsed < 300) {
          status = "live"; // Agent reported recently — trust it
        } else if (agent.lastHealthResult) {
          // Use most recent health probe result
          if (agent.lastHealthResult.reachable && !agent.lastHealthResult.authError) {
            status = "live";
          } else if (agent.lastHealthResult.reachable && agent.lastHealthResult.authError) {
            status = "auth-error";
          } else {
            status = "unreachable";
          }
        } else if (agent.connectionTest) {
          // Fall back to initial connection test
          status = agent.connectionTest.ok ? "registered" : "error";
        } else {
          status = "registered";
        }

        clusters.push({
          name: agent.clusterName,
          platform: agent.platform,
          apiUrl: agent.apiUrl,
          hasToken: !!agent.token,
          status,
          registeredAt: agent.registeredAt,
          lastReportTime: agent.lastReportTime,
          lastHealthCheck: agent.lastHealthCheck || null,
          lastHealthResult: agent.lastHealthResult || null,
          source: agent.source || "agent",
          summary: agent.lastReport ? {
            nodes: `${agent.lastReport.nodes?.ready || 0}/${agent.lastReport.nodes?.total || 0}`,
            pods: agent.lastReport.pods?.total || 0,
            issues: agent.lastReport.pods?.issues?.length || 0,
            warnings: agent.lastReport.events?.warnings || 0,
          } : null,
        });
      }
      return sendJson(res, 200, { clusters });
    }

    // On-demand cluster health check
    if (url.pathname.match(/^\/api\/hub\/clusters\/[^/]+\/health$/) && req.method === "GET") {
      const name = decodeURIComponent(url.pathname.split("/api/hub/clusters/")[1].replace("/health", ""));
      const agent = _connectedAgents.get(name);
      if (!agent) return sendJson(res, 404, { error: "Cluster not found" });
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
      saveClustersToDB().catch(() => {});
      return sendJson(res, 200, { name, status: agent.status, healthCheck: result, checkedAt: agent.lastHealthCheck });
    }

    if (url.pathname.startsWith("/api/hub/clusters/") && req.method === "DELETE") {
      const name = decodeURIComponent(url.pathname.split("/api/hub/clusters/")[1]);
      _connectedAgents.delete(name);
      saveClustersToDB().catch(() => {});
      return sendJson(res, 200, { ok: true, deleted: name });
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
    // Agent API — receives reports from remote TCS agents on clusters
    // -----------------------------------------------------------------------
    if (url.pathname === "/api/agent/register" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { clusterName, platform, agentVersion, capabilities } = body;
      if (!clusterName) return sendJson(res, 400, { error: "clusterName required" });
      _connectedAgents.set(clusterName, {
        clusterName, platform, agentVersion, capabilities,
        registeredAt: new Date().toISOString(),
        lastReport: null, status: "registered",
      });
      saveClustersToDB().catch(() => {});
      console.error(`[agent] Registered: ${clusterName} (${platform}) agent v${agentVersion}`);
      return sendJson(res, 200, { ok: true, message: `Agent "${clusterName}" registered` });
    }

    if (url.pathname === "/api/agent/report" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { clusterName, platform, report } = body;
      if (!clusterName || !report) return sendJson(res, 400, { error: "clusterName and report required" });
      const agent = _connectedAgents.get(clusterName) || { clusterName, platform };
      agent.lastReport = report;
      agent.lastReportTime = new Date().toISOString();
      agent.status = "live";
      _connectedAgents.set(clusterName, agent);
      saveClustersToDB().catch(() => {});
      const issues = report.pods?.issues?.length || 0;
      if (issues > 0) {
        console.error(`[agent] ${clusterName}: ${issues} issues detected`);
      }
      return sendJson(res, 200, { ok: true, received: clusterName });
    }

    if (url.pathname === "/api/agent/status" && req.method === "GET") {
      const agents = [];
      for (const [, agent] of _connectedAgents) {
        const elapsed = agent.lastReportTime
          ? (Date.now() - new Date(agent.lastReportTime).getTime()) / 1000
          : null;
        agents.push({
          ...agent,
          token: undefined,
          hasToken: !!agent.token,
          status: elapsed !== null && elapsed < 300 ? "live" : elapsed !== null ? "stale" : "registered",
          lastReport: undefined,
          summary: agent.lastReport ? {
            nodes: `${agent.lastReport.nodes?.ready || 0}/${agent.lastReport.nodes?.total || 0}`,
            pods: agent.lastReport.pods?.total || 0,
            issues: agent.lastReport.pods?.issues?.length || 0,
            warnings: agent.lastReport.events?.warnings || 0,
          } : null,
        });
      }
      return sendJson(res, 200, { agents });
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
      await handleChatAPI(req, res);
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

          sendEvent("cluster-state", {
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
          });
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
        const [executed, pending, queries, queryStats] = await Promise.all([
          dbQuery(
            "SELECT id, action, target, namespace, success, created_at FROM executed_actions ORDER BY id DESC LIMIT $1",
            [limit]
          ),
          dbQuery(
            "SELECT id, action, resource_type, resource_name, namespace, status, created_at FROM pending_actions ORDER BY created_at DESC LIMIT $1",
            [limit]
          ),
          dbQuery(
            "SELECT id, query, intents, cache_hit, duration_ms, created_at FROM query_log ORDER BY created_at DESC LIMIT $1",
            [limit]
          ),
          dbQuery(
            `SELECT
              COUNT(*)::int AS total_queries,
              COUNT(*) FILTER (WHERE cache_hit)::int AS cache_hits,
              ROUND(AVG(duration_ms))::int AS avg_duration_ms
            FROM query_log`
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
      const auditStart = Date.now();
      let preflight = null;
      let command = "";
      let dryRun = false;
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
        return sendJson(res, 200, { ...result, classification: preflight?.classification });
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
        return sendJson(res, 500, { success: false, stderr: e.message });
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
              targetVersion: upgradeInfo?.targetVersion || preflightReport?.targetVersion || "",
              fromVersion: upgradeInfo?.fromVersion || preflightReport?.fromVersion || "",
              preflightReport,
            });
          }
        }

        // Persist CR to tracking table
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
          });
        } catch (e) {}

        // Record in audit trail
        if (await dbEnabled()) {
          dbQuery(
            `INSERT INTO executed_actions (action, target, namespace, success, result)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              type === "change_request" ? "create_change_request" : "create_incident",
              number,
              "servicenow",
              true,
              JSON.stringify({ ticketId: number, sysId, title: fields.title || "" }),
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
        const cluster = url.searchParams.get("cluster") || null;
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
      try {
        const [promAlerts, eventsResp] = await withClusterContext(url, () => Promise.allSettled([
          listFiringAlerts(),
          ocpGet("/api/v1/events"),
        ]));

        const unified = [];

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

        // Mark silenced alerts
        const now = Date.now();
        for (const a of unified) {
          const key = `${a.name}|${a.namespace}`;
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

        return sendJson(res, 200, { alerts: unified, summary });
      } catch (err) {
        return sendJson(res, 200, { alerts: [], summary: { critical: 0, warning: 0, info: 0 }, error: err.message });
      }
    }

    // POST /api/alerts/silence — silence an alert (stored in-memory + optionally DB)
    if (req.method === "POST" && url.pathname === "/api/alerts/silence") {
      try {
        const body = await readJsonBody(req);
        const { name, namespace, duration } = body;
        if (!name) return sendJson(res, 400, { error: "Missing alert name" });
        const durationMs = (duration || 60) * 60 * 1000;
        const entry = { name, namespace: namespace || "", silencedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + durationMs).toISOString(), duration: duration || 60 };
        silencedAlerts.set(`${name}|${namespace || ""}`, entry);
        try {
          await dbQuery("INSERT INTO silenced_alerts (name, namespace, silenced_at, expires_at) VALUES ($1, $2, $3, $4)", [name, namespace || "", entry.silencedAt, entry.expiresAt]);
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
        const { name, namespace } = body;
        silencedAlerts.delete(`${name}|${namespace || ""}`);
        try {
          await dbQuery("DELETE FROM silenced_alerts WHERE name = $1 AND namespace = $2", [name, namespace || ""]);
        } catch { /* DB optional */ }
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /api/alerts/silences — list active silences
    if (req.method === "GET" && url.pathname === "/api/alerts/silences") {
      const now = Date.now();
      const active = [];
      for (const [key, s] of silencedAlerts) {
        if (new Date(s.expiresAt).getTime() > now) active.push(s);
        else silencedAlerts.delete(key);
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
        const events = await withClusterContext(url, () => ocpGet("/api/v1/events")).catch(() => ({ items: [] }));
        for (const e of (events.items || [])) {
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
        try {
          const raw = await readFile(NOTIF_PATH, "utf8");
          return sendJson(res, 200, JSON.parse(raw));
        } catch {
          return sendJson(res, 200, { webhookUrl: "", channel: "", enabled: false, severities: ["critical"] });
        }
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
          await writeFile(NOTIF_PATH, JSON.stringify(cfg, null, 2));
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
        let cfg;
        try {
          cfg = JSON.parse(await readFile(NOTIF_PATH, "utf8"));
        } catch {
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
      try {
        const cv = await withClusterContext(url, () => ocpGet("/apis/config.openshift.io/v1/clusterversions/version"));
        const current = cv?.status?.desired?.version || cv?.status?.history?.[0]?.version || "";
        const channel = cv?.spec?.channel || "";
        const available = (cv?.status?.availableUpdates || []).map(u => u.version);
        json(res, 200, { current, channel, available });
      } catch (err) {
        json(res, 200, { current: "", channel: "", available: [], error: err.message });
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
      try {
        const ns = url.searchParams.get("namespace") || undefined;
        let namespaces = getWatchedNamespaces();

        let discoveredNamespaces = null;
        try {
          discoveredNamespaces = await discoverAppNamespaces();
        } catch {};

        const changes = await scanForChanges();
        const log = getChangeLog();
        namespaces = getWatchedNamespaces();
        const filtered = ns ? log.filter(e => e.namespace === ns) : log;
        const totalChanges = filtered.length;
        const critical = filtered.filter(e => e.severity === "critical").length;
        const warning = filtered.filter(e => e.severity === "warning").length;
        const info = filtered.filter(e => e.severity === "info").length;
        const baselines = Object.keys(getBaselines()).length;

        const timelineStats = getTimelineStats();

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

        sendJson(res, 200, {
          watchedNamespaces: namespaces,
          trackedWorkloads: baselines,
          newChanges: changes.length,
          totalChanges, critical, warning, info,
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
            changes: e.changes.map(c => ({ field: c.field, old: c.old, new: c.new, severity: c.severity })),
          })),
        });
      } catch (err) {
        sendJson(res, 200, { watchedNamespaces: [], trackedWorkloads: 0, newChanges: 0, totalChanges: 0, critical: 0, warning: 0, info: 0, recentChanges: [], error: err.message });
      }
      return;
    }

    // ── App Change Watcher — Auto-discover + Watch ──────────────────
    if (req.method === "POST" && url.pathname === "/api/dashboard/app-changes/discover") {
      try {
        const result = await autoDiscoverAndWatch();
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
      try {
        const body = await readJsonBody(req);
        const action = body.action;
        const nsList = body.namespaces || [];
        if (action === "add" && nsList.length > 0) {
          await addNamespaces(nsList);
          sendJson(res, 200, {
            watchedNamespaces: getWatchedNamespaces(),
            trackedWorkloads: Object.keys(getBaselines()).length,
            baselineStatus: "initializing",
          });
          initNamespaceBaselines(nsList).catch(e =>
            console.warn("[app-watcher] Background baseline init error:", e.message)
          );
        } else if (action === "remove" && nsList.length > 0) {
          await removeNamespaces(nsList);
          sendJson(res, 200, {
            watchedNamespaces: getWatchedNamespaces(),
            trackedWorkloads: Object.keys(getBaselines()).length,
          });
        } else {
          sendJson(res, 200, {
            watchedNamespaces: getWatchedNamespaces(),
            trackedWorkloads: Object.keys(getBaselines()).length,
          });
        }
      } catch (err) {
        sendJson(res, 200, { error: err.message });
      }
      return;
    }

    // ── App Change Watcher — Change actions (agree/dismiss/ack) ────
    if (req.method === "POST" && url.pathname === "/api/dashboard/app-changes/action") {
      try {
        const body = await readJsonBody(req);
        const { changeId, action } = body;
        let result;
        if (action === "dismiss") {
          result = await dismissChange(changeId);
        } else if (action === "agree") {
          result = agreeChange(changeId);
        } else if (action === "acknowledge") {
          result = acknowledgeChange(changeId);
        } else {
          result = { found: false, error: "Unknown action. Use: agree, dismiss, acknowledge" };
        }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 200, { found: false, error: err.message });
      }
      return;
    }

    // ── App Change Watcher — Workload listing ──────────────────────
    if (req.method === "GET" && url.pathname === "/api/dashboard/app-changes/workloads") {
      try {
        const byNs = getWorkloadsByNamespace();
        sendJson(res, 200, {
          namespaces: Object.entries(byNs).map(([ns, wl]) => ({
            namespace: ns,
            workloads: wl,
            count: wl.length,
          })).sort((a, b) => b.count - a.count),
          total: Object.values(byNs).reduce((s, wl) => s + wl.length, 0),
        });
      } catch (err) {
        sendJson(res, 200, { namespaces: [], total: 0, error: err.message });
      }
      return;
    }

    // ── Image Vulnerability Scanner API ──────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/dashboard/image-vulns") {
      try {
        const ns = url.searchParams.get("namespace") || undefined;
        const scan = await runImageScan(ns);
        const riskScore = Math.max(0, 100 - scan.critical * 15 - scan.high * 8 - scan.medium * 3 - scan.low * 1);
        const grade = riskScore >= 90 ? "A" : riskScore >= 80 ? "B" : riskScore >= 70 ? "C" : riskScore >= 60 ? "D" : "F";
        sendJson(res, 200, {
          scannerType: scan.scannerType,
          timestamp: scan.timestamp,
          scope: scan.namespace,
          totalImages: scan.totalImages,
          totalVulns: scan.totalVulns,
          critical: scan.critical,
          high: scan.high,
          medium: scan.medium,
          low: scan.low,
          fixable: scan.fixable,
          maxCVSS: scan.maxCVSS || 0,
          riskScore, grade,
          compliance: scan.compliance || { avgScore: 0, signed: 0, sbom: 0, pinned: 0, trusted: 0, total: 0 },
          ageSummary: scan.ageSummary || { fresh: 0, aging: 0, stale: 0, current: 0, unknown: 0 },
          topImages: scan.results.slice(0, 15).map(r => ({
            image: r.image.length > 60 ? "..." + r.image.slice(-57) : r.image,
            fullImage: r.image,
            namespace: r.namespace,
            critical: r.critical, high: r.high, medium: r.medium, low: r.low,
            fixable: r.fixable, total: r.totalVulns,
            maxCVSS: r.maxCVSS || 0,
            age: r.age || null,
            pods: r.pods ? r.pods.slice(0, 5).map(p => ({ pod: p.pod, namespace: p.namespace, container: p.container })) : [],
            complianceBadges: r.compliance?.badges || [],
            complianceScore: r.compliance?.score || 0,
            complianceIssues: r.compliance?.issues || [],
            vulnerabilities: (r.vulnerabilities || []).slice(0, 20).map(v => ({
              id: v.id, severity: v.severity, package: v.package || "", version: v.version || "",
              fix: v.fixedBy, cvss: v.cvss || 0, link: v.link || null,
              description: (v.description || "").slice(0, 150),
            })),
          })),
          history: getScanHistory().slice(0, 5),
        });
      } catch (err) {
        sendJson(res, 200, { scannerType: "unknown", totalImages: 0, totalVulns: 0, critical: 0, high: 0, medium: 0, low: 0, fixable: 0, maxCVSS: 0, riskScore: 0, grade: "?", topImages: [], history: [], compliance: { avgScore: 0, signed: 0, sbom: 0, pinned: 0, trusted: 0, total: 0 }, ageSummary: { fresh: 0, aging: 0, stale: 0, current: 0, unknown: 0 }, error: err.message });
      }
      return;
    }

    // Dashboard REST API — /api/...
    if (url.pathname.startsWith("/api/")) {
      await withClusterContext(url, () => handleDashboardAPI(url.pathname, req, res));
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

    // Serve dashboard HTML — fallback for any non-API, non-MCP route
    if (req.method === "GET") {
      const DASHBOARD_DIR = process.env.DASHBOARD_DIR || resolve(process.cwd(), "dashboard");
      const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
      const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".svg"]);
      const filePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");

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
        try {
          const full = resolve(DASHBOARD_DIR, "index.html");
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
    console.error(`[server] Unhandled error on ${req.method} ${req.url}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
   }
  });

  // Warm-load the Agent Registry so /.well-known/agent.json is fast on first hit.
  loadAgents().then((list) => {
    console.error(`  Agent Registry:   ${list.length} agents loaded`);
  }).catch(() => {});

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.error(`TCS Agentic AI — Enterprise Intelligence Platform`);
    console.error(`  Server running on http://0.0.0.0:${PORT}`);
    console.error(`  MCP SSE (full):   GET  /sse`);
    console.error(`  MCP Message:      POST /message?sessionId=<id>`);
    console.error(`  Per-agent MCP:    GET  /mcp/<agent-id>/sse`);
    console.error(`  Agent discovery:  GET  /.well-known/agent.json`);
    console.error(`  Agent registry:   GET  /api/agents`);
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

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err.message);
  console.error(err.stack);
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
