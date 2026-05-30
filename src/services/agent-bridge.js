/**
 * Agent Bridge — Bidirectional SSE channel for real-time hub-to-agent communication.
 *
 * Each remote cluster agent opens an outbound SSE connection to the hub.
 * The hub sends tool invocation requests over this SSE channel.
 * The agent executes the tool (K8s API call) and POSTs the result back.
 */

import { randomUUID } from "node:crypto";

// Map of clusterName → { res (SSE response), tools (available tools), pendingRequests }
const _channels = new Map();

/**
 * Handle GET /api/agent/channel?cluster=<name> — agent opens SSE connection.
 */
export function handleAgentChannel(req, res, clusterName) {
  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Store channel
  _channels.set(clusterName, {
    res,
    tools: {},
    pendingRequests: new Map(),
    connectedAt: new Date().toISOString(),
  });

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    const ch = _channels.get(clusterName);
    if (ch) {
      // Reject all pending requests
      for (const [, pending] of ch.pendingRequests) {
        pending.reject(new Error("Agent disconnected"));
      }
    }
    _channels.delete(clusterName);
    console.error(`[agent-bridge] ${clusterName} disconnected`);
  });

  console.error(`[agent-bridge] ${clusterName} connected via SSE channel`);

  // Send initial welcome event
  res.write(`data: ${JSON.stringify({ type: "connected", message: "Channel established" })}\n\n`);
}

/**
 * Handle POST /api/agent/channel/register-tools — agent sends its tool catalog.
 */
export function handleToolRegistration(clusterName, tools) {
  const ch = _channels.get(clusterName);
  if (ch) {
    ch.tools = tools;
    console.error(`[agent-bridge] ${clusterName} registered ${Object.keys(tools).length} tools`);
  }
}

/**
 * Handle POST /api/agent/tool-response — agent sends tool execution result.
 */
export function handleToolResponse(requestId, clusterName, result) {
  const ch = _channels.get(clusterName);
  if (!ch) return false;
  const pending = ch.pendingRequests.get(requestId);
  if (!pending) return false;
  pending.resolve(result);
  ch.pendingRequests.delete(requestId);
  return true;
}

/**
 * Invoke a tool on a remote agent — returns a Promise that resolves when the
 * agent responds or rejects on timeout / disconnect.
 */
export async function invokeAgentTool(clusterName, toolName, args = {}, timeoutMs = 15000) {
  const ch = _channels.get(clusterName);
  if (!ch) throw new Error(`No active channel for cluster "${clusterName}"`);

  const requestId = randomUUID();

  // Create promise that will be resolved when agent responds
  const promise = new Promise((resolve, reject) => {
    ch.pendingRequests.set(requestId, { resolve, reject, createdAt: Date.now() });

    // Timeout
    setTimeout(() => {
      if (ch.pendingRequests.has(requestId)) {
        ch.pendingRequests.delete(requestId);
        reject(new Error(`Tool invocation timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });

  // Send tool request via SSE
  const event = { type: "tool_request", requestId, tool: toolName, args };
  ch.res.write(`data: ${JSON.stringify(event)}\n\n`);

  return promise;
}

/**
 * Check if a cluster has an active SSE channel.
 */
export function hasActiveChannel(clusterName) {
  return _channels.has(clusterName);
}

/**
 * Get channel status for all connected agents.
 */
export function getChannelStatus() {
  const status = {};
  for (const [name, ch] of _channels) {
    status[name] = {
      connected: true,
      connectedAt: ch.connectedAt,
      toolCount: Object.keys(ch.tools).length,
      tools: Object.keys(ch.tools),
      pendingRequests: ch.pendingRequests.size,
    };
  }
  return status;
}
