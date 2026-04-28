#!/usr/bin/env node

/**
 * OpenShift MCP Server
 * Model Context Protocol server for OpenShift Container Platform management
 * with ACM, Ansible Automation Platform, and ServiceNow integration.
 */

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

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
import { authMiddleware, registerAuthRoutes, handleTokenLogin, getAuthMode } from "./services/auth.js";
import { handleDashboardAPI, handleLLMSettingsGet, handleLLMSettingsPost, handleLLMSettingsTest } from "./services/dashboard-api.js";
import { handleChatAPI, handleExecuteAPI, handleChatCompareAPI, handleChatInvestigateAPI, handleChatRunbookAPI } from "./services/chat-api.js";
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
  listChats,
  getChat,
  createChat,
  deleteChat,
  updateTitle,
  isHistoryEnabled,
} from "./services/chat-history.js";
import { initDb, query as dbQuery } from "./utils/db.js";
import { initCache, isEnabled as cacheReady } from "./utils/cache.js";
import { handleMetricsRequest } from "./services/metrics.js";
import { enforce as enforceRateLimit } from "./services/rate-limit.js";
import { startHealthCheckTask, getLatestHealthReport } from "./services/scheduler.js";
import { listFiringAlerts } from "./services/alertmanager.js";
import { initSafety, getSafetyMode } from "./services/safety.js";
import { redactIfEnabled } from "./services/redaction.js";
import { loadKubeconfig, registerMultiClusterTools } from "./services/multi-cluster.js";
import { loadConfig } from "./utils/config.js";
import { ocpGet } from "./utils/openshift-client.js";
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
  isMonitorRunning,
} from "./services/proactive-agent.js";
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

const silencedAlerts = new Map();

function createMcpServer() {
  const server = new McpServer({
    name: "tcs-cloudnexus-ai",
    version: "1.0.0",
    description:
      "TCS CloudNexus AI — OpenShift Intelligence Platform with MCP Hub, multi-server orchestration, diagnostics, ITSM integration, and automated remediation.",
  });

  // Register all tool groups
  registerClusterTools(server);
  registerNodeTools(server);
  registerPodTools(server);
  registerNamespaceTools(server);
  registerDiagnosticTools(server);
  registerServiceNowTools(server);
  registerAnsibleTools(server);
  registerEmergencyTools(server);
  registerACMTools(server);
  registerDashboardTools(server);
  registerWorkloadTools(server);
  registerHelmTools(server);
  registerTektonTools(server);
  registerKubeVirtTools(server);
  registerNetworkTools(server);
  registerGenericTools(server);
  registerMustGatherTools(server);
  registerMultiClusterTools(server);
  registerMetricsTopTools(server);
  registerPrometheusTools(server);
  registerOSSMTools(server);
  registerGitOpsTools(server);
  registerSecurityTools(server);
  registerRecommendationTools(server);
  registerNotificationTools(server);
  registerVeleroTools(server);
  registerComplianceTools(server);
  registerDriftTools(server);
  registerImpactTools(server);
  registerOperatorDiagTools(server);
  registerPolicyGenTools(server);
  registerSCCAdvisorTools(server);
  registerTimelineTools(server);
  registerUpgradeAdvisorTools(server);

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

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
        return sendJson(res, 400, { error: "No fields to update" });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    return sendJson(res, 405, { error: "Method not allowed" });
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

  // Initialize AI Intelligence features
  try {
    await initKnowledgeBase();
    await initAutomationRules();
    startProactiveMonitor();
    console.log("[startup] AI Intelligence: proactive monitor, knowledge base, automation rules — active");
  } catch (err) {
    console.warn("[startup] AI Intelligence init:", err.message);
  }

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

  // Track active transports so each SSE session gets its own MCP server
  // instance (the SDK ties one transport to one server).
  const sessions = new Map();

  const httpServer = createServer(async (req, res) => {
   try {
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
      const matches = kbFindSimilar(body);
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
    // Agent API — receives reports from remote CloudNexus agents on clusters
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

    // Execute fix API — /api/execute (POST) — rate-limited
    if (req.method === "POST" && url.pathname === "/api/execute") {
      if (enforceRateLimit(req, res, { burst: 10, refillPerSec: 0.2 })) return;
      await handleExecuteAPI(req, res);
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

    // GET /api/audit — executed + pending actions log
    if (req.method === "GET" && url.pathname === "/api/audit") {
      try {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
        const executed = await dbQuery(
          "SELECT id, action, target, namespace, success, created_at FROM executed_actions ORDER BY id DESC LIMIT $1",
          [limit]
        );
        const pending = await dbQuery(
          "SELECT id, action, resource_type, resource_name, namespace, status, created_at FROM pending_actions ORDER BY created_at DESC LIMIT $1",
          [limit]
        );
        return sendJson(res, 200, {
          executed: executed?.rows || [],
          pending: pending?.rows || [],
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

    // GET /api/alerts — unified: Alertmanager + K8s warning events
    if (req.method === "GET" && url.pathname === "/api/alerts") {
      try {
        const [promAlerts, eventsResp] = await Promise.allSettled([
          listFiringAlerts(),
          ocpGet("/api/v1/events"),
        ]);

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
        const events = await ocpGet("/api/v1/events").catch(() => ({ items: [] }));
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

    // Dashboard REST API — /api/...
    if (url.pathname.startsWith("/api/")) {
      await handleDashboardAPI(url.pathname, req, res);
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
      const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
      const filePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
      try {
        const full = resolve(DASHBOARD_DIR, filePath);
        if (!full.startsWith(DASHBOARD_DIR)) throw new Error("forbidden");
        const data = await readFile(full);
        const ct = MIME[extname(full)] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": ct });
        res.end(data);
        return;
      } catch {
        // Not a static file — try index.html for SPA-style routing
        try {
          const data = await readFile(resolve(DASHBOARD_DIR, "index.html"));
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(data);
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

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.error(`TCS CloudNexus AI — OpenShift Intelligence Platform`);
    console.error(`  Server running on http://0.0.0.0:${PORT}`);
    console.error(`  MCP SSE:          GET  /sse`);
    console.error(`  MCP Message:      POST /message?sessionId=<id>`);
    console.error(`  MCP Hub:          GET  /api/hub/servers`);
    console.error(`  Hub Tools:        GET  /api/hub/tools`);
    console.error(`  Orchestrator:     POST /api/hub/orchestrate`);
    console.error(`  Health check:     GET  /healthz`);
  });

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
