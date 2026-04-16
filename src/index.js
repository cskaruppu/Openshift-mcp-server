#!/usr/bin/env node

/**
 * OpenShift MCP Server
 * Model Context Protocol server for OpenShift Container Platform management
 * with ACM, Ansible Automation Platform, and ServiceNow integration.
 */

import { createServer } from "node:http";

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
import { handleDashboardAPI } from "./services/dashboard-api.js";
import { handleChatAPI, handleExecuteAPI } from "./services/chat-api.js";
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
import { analyzeEfficiency } from "./services/cost-advisor.js";

function createMcpServer() {
  const server = new McpServer({
    name: "openshift-mcp-server",
    version: "1.0.0",
    description:
      "MCP Server for OpenShift Container Platform — cluster insights, diagnostics, ITSM integration, and automated remediation.",
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
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
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

  // Initialize optional persistence layers (graceful fallback if not configured)
  await Promise.all([initDb(), initCache()]);

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
    // CORS headers for browser-based clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

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

    // LLM Chat API — /api/chat (POST)
    if (req.method === "POST" && url.pathname === "/api/chat") {
      await handleChatAPI(req, res);
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

    // GET /api/alerts — firing alerts from Alertmanager
    if (req.method === "GET" && url.pathname === "/api/alerts") {
      try {
        const alerts = await listFiringAlerts();
        return sendJson(res, 200, { alerts: alerts || [] });
      } catch (err) {
        return sendJson(res, 200, { alerts: [], error: err.message });
      }
    }

    // GET /api/advisor — cost/efficiency analysis
    if (req.method === "GET" && url.pathname === "/api/advisor") {
      try {
        const report = await analyzeEfficiency();
        return sendJson(res, 200, report);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
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

    // Fallback
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.error(`OpenShift MCP Server running on SSE — http://0.0.0.0:${PORT}`);
    console.error(`  SSE endpoint:     GET  /sse`);
    console.error(`  Message endpoint: POST /message?sessionId=<id>`);
    console.error(`  Health check:     GET  /healthz`);
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
