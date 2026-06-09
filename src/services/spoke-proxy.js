/**
 * Spoke Proxy — Hub/Spoke federation for TCS Agentic AI.
 *
 * Instead of routing through the lightweight agent bridge (which produces
 * different results from local queries), the hub proxies API requests to
 * the spoke's own MCP server. Because every cluster runs the same image
 * and the same query code, results are identical.
 *
 * Spoke registration:
 *   POST /api/spoke/register  { clusterName, spokeUrl, platform, version }
 *
 * Proxy flow:
 *   1. Dashboard sends GET /api/dashboard/health?cluster=prod-east
 *   2. Hub looks up prod-east's spoke URL
 *   3. Hub fetches GET <spokeUrl>/api/dashboard/health (no cluster param)
 *   4. Returns response to dashboard — identical to local query
 */

import { Agent } from "undici";

const _spokes = new Map();

let _heartbeatCheckTimer = null;

// ---------------------------------------------------------------------------
// TLS handling for federation traffic (spoke→hub register/heartbeat and
// hub→spoke proxy). OpenShift Routes on internal/.local clusters terminate
// TLS with the router's self-signed default cert, which a fresh Node process
// does not trust. Set HUB_TLS_SKIP_VERIFY=true (spoke deploy --tls-skip) to
// disable verification for these in-cluster federation calls.
// ---------------------------------------------------------------------------
const _skipTLS =
  String(
    process.env.HUB_TLS_SKIP_VERIFY ||
    process.env.FEDERATION_TLS_SKIP_VERIFY ||
    ""
  ).toLowerCase() === "true";

const _insecureDispatcher = _skipTLS
  ? new Agent({ connect: { rejectUnauthorized: false } })
  : undefined;

if (_skipTLS) {
  console.log("[federation] TLS verification disabled for hub/spoke calls (HUB_TLS_SKIP_VERIFY=true)");
}

/** fetch() wrapper that applies the insecure dispatcher when TLS skip is enabled. */
function fedFetch(url, opts = {}) {
  if (_insecureDispatcher) opts.dispatcher = _insecureDispatcher;
  return fetch(url, opts);
}

/** Build a readable reason from a fetch error — undici hides the real cause. */
function fetchErrorDetail(err) {
  const cause = err && err.cause;
  if (cause) {
    const code = cause.code || cause.reason || cause.message;
    if (code) return `${err.message} (${code})`;
  }
  return err.message;
}

export function registerSpoke(clusterName, spokeUrl, metadata = {}) {
  const existing = findSpokeKey(clusterName);
  const key = existing || clusterName;

  const entry = {
    ...(existing ? _spokes.get(key) : {}),
    clusterName: key,
    spokeUrl: spokeUrl.replace(/\/+$/, ""),
    platform: metadata.platform || "k8s",
    version: metadata.version || "unknown",
    mcpMode: "spoke",
    registeredAt: _spokes.has(key) ? _spokes.get(key).registeredAt : new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    status: "live",
    healthy: true,
    ...metadata,
  };

  _spokes.set(key, entry);
  console.log(`[spoke-proxy] Registered spoke: ${key} → ${spokeUrl}`);
  startHealthCheck();
  return entry;
}

export function unregisterSpoke(clusterName) {
  const key = findSpokeKey(clusterName);
  if (key) {
    _spokes.delete(key);
    console.log(`[spoke-proxy] Unregistered spoke: ${key}`);
    return true;
  }
  return false;
}

export function findSpokeKey(name) {
  if (!name) return null;
  if (_spokes.has(name)) return name;
  const lower = name.toLowerCase();
  for (const [key] of _spokes) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

export function hasSpoke(clusterName) {
  return !!findSpokeKey(clusterName);
}

export function getSpokeUrl(clusterName) {
  const key = findSpokeKey(clusterName);
  return key ? _spokes.get(key).spokeUrl : null;
}

export function getAllSpokes() {
  return Object.fromEntries(_spokes);
}

export function getSpokeStatus() {
  const result = [];
  for (const [key, spoke] of _spokes) {
    result.push({
      clusterName: key,
      spokeUrl: spoke.spokeUrl,
      platform: spoke.platform,
      version: spoke.version,
      status: spoke.status,
      healthy: spoke.healthy,
      registeredAt: spoke.registeredAt,
      lastHeartbeat: spoke.lastHeartbeat,
    });
  }
  return result;
}

export function updateSpokeHeartbeat(clusterName, data = {}) {
  const key = findSpokeKey(clusterName);
  if (!key) return false;
  const spoke = _spokes.get(key);
  spoke.lastHeartbeat = new Date().toISOString();
  spoke.status = "live";
  spoke.healthy = data.healthy !== false;
  if (data.version) spoke.version = data.version;
  if (data.summary) spoke.summary = data.summary;
  _spokes.set(key, spoke);
  return true;
}

/**
 * Proxy an HTTP request from the hub to a spoke MCP server.
 * Returns true if handled, false if no spoke found.
 */
export async function proxyToSpoke(clusterName, req, res, url) {
  const spokeUrl = getSpokeUrl(clusterName);
  if (!spokeUrl) return false;

  const targetUrl = new URL(url.pathname, spokeUrl);
  for (const [k, v] of url.searchParams) {
    if (k !== "cluster") targetUrl.searchParams.set(k, v);
  }

  try {
    const headers = {
      "Accept": "application/json",
      "Content-Type": req.headers["content-type"] || "application/json",
    };
    if (req.headers.authorization) {
      headers["Authorization"] = req.headers.authorization;
    }

    const fetchOpts = {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(30000),
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOpts.body = await readRequestBody(req);
    }

    const proxyRes = await fedFetch(targetUrl.toString(), fetchOpts);

    const contentType = proxyRes.headers.get("content-type") || "application/json";
    const body = await proxyRes.text();

    res.writeHead(proxyRes.status, {
      "Content-Type": contentType,
      "X-Proxied-From": clusterName,
      "X-Spoke-Url": spokeUrl,
    });
    res.end(body);
    return true;
  } catch (err) {
    console.error(`[spoke-proxy] Proxy to ${clusterName} (${spokeUrl}) failed: ${fetchErrorDetail(err)}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: `Spoke cluster "${clusterName}" is unreachable`,
      spokeUrl,
      detail: fetchErrorDetail(err),
    }));
    return true;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function startHealthCheck() {
  if (_heartbeatCheckTimer) return;
  _heartbeatCheckTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, spoke] of _spokes) {
      const age = now - new Date(spoke.lastHeartbeat).getTime();
      if (age > 300_000) {
        spoke.status = "unreachable";
        spoke.healthy = false;
      } else if (age > 90_000) {
        spoke.status = "stale";
      } else {
        spoke.status = "live";
      }
    }
  }, 30_000);
}

/**
 * Spoke startup — called when MCP_MODE=spoke.
 * Registers this instance with the hub and starts heartbeat.
 */
export async function startSpokeMode(hubUrl, clusterName, spokeUrl, platform) {
  const HEARTBEAT_MS = 30_000;
  let _registered = false;
  let _hbTimer = null;
  const hubToken = process.env.HUB_API_TOKEN || process.env.MCP_API_TOKEN || "";

  function authHeaders() {
    const h = { "Content-Type": "application/json" };
    if (hubToken) h["Authorization"] = `Bearer ${hubToken}`;
    return h;
  }

  async function register() {
    try {
      const resp = await fedFetch(`${hubUrl}/api/spoke/register`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          clusterName,
          spokeUrl,
          platform,
          version: "1.2.0",
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        _registered = true;
        console.log(`[spoke] Registered with hub: ${hubUrl}`);
        startHeartbeatLoop();
      } else {
        const bodyText = await resp.text().catch(() => "");
        console.error(`[spoke] Registration rejected by hub: HTTP ${resp.status} ${bodyText.slice(0, 200)}`);
        setTimeout(register, 10_000);
      }
    } catch (err) {
      console.error(`[spoke] Cannot reach hub ${hubUrl}: ${fetchErrorDetail(err)}`);
      if (/self.signed|self_signed|CERT|TLS|SSL/i.test(fetchErrorDetail(err))) {
        console.error("[spoke] Hint: hub uses a self-signed cert. Redeploy the spoke with --tls-skip.");
      }
      setTimeout(register, 10_000);
    }
  }

  async function sendHeartbeat() {
    try {
      await fedFetch(`${hubUrl}/api/spoke/heartbeat`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          clusterName,
          ts: new Date().toISOString(),
          uptime: Math.floor(process.uptime()),
          memMB: Math.round(process.memoryUsage().rss / 1048576),
          healthy: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // best-effort
    }
  }

  function startHeartbeatLoop() {
    if (_hbTimer) return;
    _hbTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    sendHeartbeat();
  }

  await register();
}
