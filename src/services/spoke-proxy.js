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

const _spokes = new Map();

let _heartbeatCheckTimer = null;

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

    const proxyRes = await fetch(targetUrl.toString(), fetchOpts);

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
    console.error(`[spoke-proxy] Proxy to ${clusterName} (${spokeUrl}) failed: ${err.message}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: `Spoke cluster "${clusterName}" is unreachable`,
      spokeUrl,
      detail: err.message,
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

  async function register() {
    try {
      const resp = await fetch(`${hubUrl}/api/spoke/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        console.error(`[spoke] Registration failed: ${resp.status}`);
      }
    } catch (err) {
      console.error(`[spoke] Cannot reach hub ${hubUrl}: ${err.message}`);
      setTimeout(register, 10_000);
    }
  }

  async function sendHeartbeat() {
    try {
      await fetch(`${hubUrl}/api/spoke/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
