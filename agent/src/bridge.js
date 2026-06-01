/**
 * Bidirectional MCP Tool Bridge.
 *
 * Opens an SSE connection to the hub, receives tool invocation requests,
 * executes them against the local K8s API, and POSTs results back.
 *
 * Zero npm dependencies — uses native http/https modules only.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { executeTool, TOOLS } from "./tools.js";
import { runReconcile } from "./rbac-reconciler.js";
import { rolloutRestart } from "./deployer.js";

const SKIP_TLS = process.env.HUB_TLS_SKIP_VERIFY === "true";

// Reconnect timing
const INITIAL_RECONNECT_MS = 5000;
const MAX_RECONNECT_MS = 60000;

let _reconnectDelay = INITIAL_RECONNECT_MS;
let _connected = false;
let _currentReq = null;
let _hubUrl = null;
let _clusterName = null;
let _platform = process.env.CLUSTER_PLATFORM || "k8s";

function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`${ts} [${level.toUpperCase()}] [bridge]`, ...args);
}

/**
 * Pick the right request function based on URL protocol.
 */
function pickRequest(parsedUrl) {
  return parsedUrl.protocol === "https:" ? httpsRequest : httpRequest;
}

/**
 * Send a JSON POST to the hub. Returns a promise that resolves when
 * the response is fully consumed.
 */
function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqFn = pickRequest(parsed);

    const payload = JSON.stringify(body);

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      rejectUnauthorized: !SKIP_TLS,
    };

    const req = reqFn(opts, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const status = res.statusCode;
        if (status >= 200 && status < 300) {
          resolve({ status, body: Buffer.concat(chunks).toString() });
        } else {
          reject(new Error(`POST ${url} returned ${status}: ${Buffer.concat(chunks).toString()}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("POST request timed out"));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Register the tool catalogue with the hub on first connection.
 */
async function registerTools(hubUrl, clusterName) {
  const url = `${hubUrl}/api/agent/channel/register-tools`;
  try {
    await postJSON(url, { clusterName, tools: TOOLS });
    log("info", "Tool catalog registered with hub");
  } catch (err) {
    log("error", `Failed to register tool catalog: ${err.message}`);
  }
}

/**
 * Handle a single tool invocation request from the hub.
 */
async function handleToolRequest(hubUrl, clusterName, event) {
  const { requestId, tool, args } = event;
  log("info", `Tool request: ${tool} (requestId=${requestId})`);

  const result = await executeTool(tool, args);

  if (result.success) {
    log("info", `Tool ${tool} completed successfully`);
  } else {
    log("error", `Tool ${tool} failed: ${result.error}`);
  }

  // POST the result back to the hub
  const responseUrl = `${hubUrl}/api/agent/tool-response`;
  try {
    await postJSON(responseUrl, { requestId, clusterName, result });
  } catch (err) {
    log("error", `Failed to POST tool response for requestId=${requestId}: ${err.message}`);
  }
}

/**
 * Parse an SSE stream.  Accumulates lines; on a blank line, emits the
 * concatenated data fields as a single event string.
 *
 * Returns a transform-like function: feed it chunks, it calls `onEvent`
 * for each complete SSE event.
 */
function createSSEParser(onEvent) {
  let buffer = "";
  let dataLines = [];

  return function feed(chunk) {
    buffer += chunk;
    const lines = buffer.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      } else if (line.trim() === "" && dataLines.length > 0) {
        // End of an event
        const payload = dataLines.join("\n");
        dataLines = [];
        onEvent(payload);
      }
      // Ignore lines starting with ":" (SSE comments / keep-alives),
      // "id:", "event:", "retry:", etc. for simplicity.
    }
  };
}

/**
 * Open the SSE connection and start listening for tool requests.
 */
function connectSSE(hubUrl, clusterName) {
  const sseUrl = `${hubUrl}/api/agent/channel?cluster=${encodeURIComponent(clusterName)}`;
  const parsed = new URL(sseUrl);
  const reqFn = pickRequest(parsed);

  const opts = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
    rejectUnauthorized: !SKIP_TLS,
  };

  log("info", `Connecting to SSE channel: ${sseUrl}`);

  const req = reqFn(opts, (res) => {
    if (res.statusCode !== 200) {
      log("error", `SSE connection returned status ${res.statusCode}`);
      res.resume(); // drain
      scheduleReconnect(hubUrl, clusterName);
      return;
    }

    _connected = true;
    _reconnectDelay = INITIAL_RECONNECT_MS;
    log("info", "SSE channel connected");

    // Register tool catalog on successful connection
    registerTools(hubUrl, clusterName);

    res.setEncoding("utf8");

    const feedSSE = createSSEParser((payload) => {
      // Try to parse the JSON payload
      let event;
      try {
        event = JSON.parse(payload);
      } catch (err) {
        log("debug", `Ignoring non-JSON SSE event: ${payload.substring(0, 100)}`);
        return;
      }

      if (event.type === "rbac_update") {
        log("info", "Received RBAC sync event from hub — reconciling...");
        runReconcile(_hubUrl, _clusterName, _platform).catch((err) => {
          log("error", `RBAC reconcile failed: ${err.message}`);
        });
      } else if (event.type === "rollout_restart") {
        log("info", "Received rollout restart event from hub — restarting deployment...");
        rolloutRestart().catch((err) => {
          log("error", `Rollout restart failed: ${err.message}`);
        });
      } else if (event.requestId && event.tool) {
        // Fire-and-forget — do not block the SSE stream
        handleToolRequest(hubUrl, clusterName, event).catch((err) => {
          log("error", `Unhandled error handling tool request: ${err.message}`);
        });
      }
    });

    res.on("data", feedSSE);

    res.on("end", () => {
      log("info", "SSE connection closed by server");
      _connected = false;
      scheduleReconnect(hubUrl, clusterName);
    });

    res.on("error", (err) => {
      log("error", `SSE stream error: ${err.message}`);
      _connected = false;
      scheduleReconnect(hubUrl, clusterName);
    });
  });

  req.on("error", (err) => {
    log("error", `SSE connection error: ${err.message}`);
    _connected = false;
    scheduleReconnect(hubUrl, clusterName);
  });

  // No timeout on SSE — it is a long-lived connection
  req.end();
  _currentReq = req;
}

/**
 * Schedule a reconnection with exponential backoff.
 */
function scheduleReconnect(hubUrl, clusterName) {
  log("info", `Reconnecting in ${_reconnectDelay / 1000}s...`);
  setTimeout(() => {
    connectSSE(hubUrl, clusterName);
  }, _reconnectDelay);

  // Exponential backoff capped at MAX_RECONNECT_MS
  _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_MS);
}

/**
 * Start the bidirectional bridge.
 * Call this once from the agent entrypoint after successful registration.
 *
 * @param {string} hubUrl      - Base URL of the hub (e.g. https://hub.example.com)
 * @param {string} clusterName - Name of this cluster
 */
export function startBridge(hubUrl, clusterName) {
  if (!hubUrl) {
    log("info", "No HUB_SERVER_URL configured — bridge disabled");
    return;
  }
  _hubUrl = hubUrl;
  _clusterName = clusterName;
  log("info", `Starting MCP tool bridge for cluster "${clusterName}"`);
  connectSSE(hubUrl, clusterName);
}

/**
 * Return current bridge status (for the /status health endpoint).
 */
export function getBridgeStatus() {
  return {
    connected: _connected,
    reconnectDelay: _reconnectDelay,
  };
}
