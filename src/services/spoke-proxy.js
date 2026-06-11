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
import { Resolver as DnsResolver } from "node:dns";
import { lookup as defaultLookup } from "node:dns";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { setLLMDefaults, setLLMProxy, setLLMRelay } from "./llm.js";

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

// ---------------------------------------------------------------------------
// Custom DNS for spoke hostname resolution.
// Hub cluster CoreDNS returns NXDOMAIN for spoke Route hostnames because they
// live in a different DNS zone. SPOKE_DNS_SERVER points to a DNS server that
// can resolve those external hostnames (e.g. *.apps.ocp.caaslab.local).
// Cluster-internal names (.svc.cluster.local) still go through default DNS.
// ---------------------------------------------------------------------------
const _spokeDnsServer = process.env.SPOKE_DNS_SERVER || "";
let _spokeResolver = null;

if (_spokeDnsServer) {
  _spokeResolver = new DnsResolver();
  _spokeResolver.setServers([_spokeDnsServer]);
  console.log(`[federation] Custom DNS resolver configured: ${_spokeDnsServer}`);
}

function customLookup(hostname, opts, cb) {
  if (!_spokeResolver || hostname.endsWith(".svc.cluster.local") || hostname === "localhost") {
    return defaultLookup(hostname, opts, cb);
  }
  _spokeResolver.resolve4(hostname, (err, addresses) => {
    if (!err && addresses.length > 0) {
      // Node 20+ (autoSelectFamily) calls lookup with opts.all=true and
      // requires an array of {address, family} — a bare string triggers
      // ERR_INVALID_IP_ADDRESS on every connection to a hostname spoke URL.
      if (opts && opts.all) {
        return cb(null, addresses.map((address) => ({ address, family: 4 })));
      }
      return cb(null, addresses[0], 4);
    }
    defaultLookup(hostname, opts, cb);
  });
}

const _connectOpts = {};
if (_skipTLS) _connectOpts.rejectUnauthorized = false;
if (_spokeResolver) _connectOpts.lookup = customLookup;

const _fedDispatcher =
  (_skipTLS || _spokeResolver)
    ? new Agent({ connect: _connectOpts })
    : undefined;

if (_skipTLS) {
  console.log("[federation] TLS verification disabled for hub/spoke calls (HUB_TLS_SKIP_VERIFY=true)");
}

/** fetch() wrapper that applies the federation dispatcher (TLS skip + custom DNS). */
export function fedFetch(url, opts = {}) {
  if (_fedDispatcher) opts.dispatcher = _fedDispatcher;
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
export async function proxyToSpoke(clusterName, req, res, url, opts = {}) {
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
      // 60s: dashboard scan endpoints (image vulns, optimization, CIS) run live
      // scans on the spoke; across two clusters 30s was too tight and produced
      // blank widgets. Light endpoints still return fast — no downside.
      signal: AbortSignal.timeout(60000),
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
    const isTimeout = err && (err.name === "TimeoutError" || err.name === "AbortError");
    const status = isTimeout ? 504 : 502;
    console.error(`[spoke-proxy] Proxy to ${clusterName} (${spokeUrl}) ${isTimeout ? "timed out" : "failed"} for ${url.pathname}: ${fetchErrorDetail(err)}`);
    if (opts.allowFallback && !res.headersSent) {
      return false;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: isTimeout
        ? `Spoke cluster "${clusterName}" timed out serving ${url.pathname}`
        : `Spoke cluster "${clusterName}" is unreachable`,
      spokeUrl,
      path: url.pathname,
      detail: fetchErrorDetail(err),
    }));
    return true;
  }
}

/**
 * Proxy a chat SSE stream from hub to a spoke MCP server.
 * Unlike proxyToSpoke() which buffers the full response, this pipes the
 * SSE event stream in real time so the dashboard sees live token deltas.
 *
 * The spoke runs the same image + same chat-api code, so responses are
 * identical to what you'd get querying the spoke directly.
 *
 * @param {string} clusterName - spoke cluster name
 * @param {object} chatBody    - parsed POST body from the client
 * @param {object} req         - original HTTP request (for auth headers)
 * @param {object} res         - HTTP response to stream SSE back to
 * @param {string} [path]      - API path to proxy (default: /api/chat)
 * @returns {boolean} true if handled, false if no spoke found
 */
export async function proxyChatToSpoke(clusterName, chatBody, req, res, path) {
  const spokeUrl = getSpokeUrl(clusterName);
  if (!spokeUrl) return false;

  const apiPath = path || req.url?.split("?")[0] || "/api/chat";
  const targetUrl = `${spokeUrl}${apiPath}`;

  // Remove the cluster field so the spoke processes it as a local query
  const spokeBody = { ...chatBody };
  delete spokeBody.cluster;

  try {
    const headers = {
      "Content-Type": "application/json",
      "Accept": req.headers.accept || "text/event-stream",
    };
    if (req.headers.authorization) {
      headers["Authorization"] = req.headers.authorization;
    }

    const proxyRes = await fedFetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(spokeBody),
      signal: AbortSignal.timeout(120_000),
    });

    const contentType = proxyRes.headers.get("content-type") || "text/event-stream";

    res.writeHead(proxyRes.status, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Proxied-From": clusterName,
      "X-Spoke-Url": spokeUrl,
    });

    // Pipe the SSE stream from the spoke directly to the client
    const reader = proxyRes.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
    } catch (streamErr) {
      // Client disconnected or spoke stream broke — best-effort
      console.warn(`[spoke-proxy] Chat stream from ${clusterName} interrupted: ${streamErr.message}`);
    }
    res.end();
    return true;
  } catch (err) {
    console.error(`[spoke-proxy] Chat proxy to ${clusterName} (${spokeUrl}) failed: ${fetchErrorDetail(err)}`);
    // Return error as SSE so the frontend can display it
    if (!res.headersSent) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
    }
    res.write(`data: ${JSON.stringify({ stage: "error" })}\n\n`);
    res.write(`data: ${JSON.stringify({ delta: `⚠ Spoke cluster "${clusterName}" is unreachable: ${fetchErrorDetail(err)}` })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, provider: "spoke-proxy", conversationId: chatBody.conversationId || null })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
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

let _lastLLMConfigHash = "";
function applyHubLLMConfig(cfg, hubUrl) {
  if (!cfg || !cfg.provider || cfg.provider === "none" || !cfg.apiKey) return;
  const hash = `${cfg.provider}|${cfg.apiUrl}|${cfg.apiKey?.slice(-4)}|${cfg.model}`;
  if (hash === _lastLLMConfigHash) return;
  _lastLLMConfigHash = hash;
  setLLMDefaults({
    provider: cfg.provider,
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    azureDeployment: cfg.azureDeployment,
    azureApiVersion: cfg.azureApiVersion,
  });
  if (cfg.proxy) setLLMProxy(cfg.proxy);
  // Build the relay URL from HUB_URL — the address that registration and
  // heartbeats already reach successfully. The hub's header-derived relayUrl
  // can have the wrong scheme (http behind an edge-terminated route), which
  // the router rejects/redirects for POSTs.
  const relay = hubUrl
    ? `${hubUrl.replace(/\/+$/, "")}/api/llm/relay`
    : cfg.relayUrl;
  if (relay) setLLMRelay(relay);
  console.log(`[spoke] LLM config received from hub: provider=${cfg.provider}, url=${cfg.apiUrl ? "✓" : "✗"}, model=${cfg.model || "(default)"}${relay ? ", relay=✓" : ""}${cfg.proxy ? ", proxy=✓" : ""}`);
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
        const regData = await resp.json().catch(() => ({}));
        console.log(`[spoke] Registered with hub: ${hubUrl}`);
        applyHubLLMConfig(regData.llmConfig, hubUrl);
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

  const _spokeVersion = (() => {
    try {
      const v = JSON.parse(readFileSync(resolvePath(process.cwd(), "package.json"), "utf8")).version;
      const h = process.env.BUILD_HASH || "";
      return v + (h ? `+${h}` : "");
    } catch { return null; }
  })();
  const _spokeStartedAt = new Date().toISOString();

  let _hbFailures = 0;
  async function sendHeartbeat() {
    try {
      const resp = await fedFetch(`${hubUrl}/api/spoke/heartbeat`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          clusterName,
          // spokeUrl/platform let the hub re-register this spoke after a
          // control-plane restart without waiting for this pod to restart.
          spokeUrl,
          platform,
          ts: new Date().toISOString(),
          uptime: Math.floor(process.uptime()),
          memMB: Math.round(process.memoryUsage().rss / 1048576),
          healthy: true,
          mcpVersion: _spokeVersion,
          buildHash: process.env.BUILD_HASH || null,
          startedAt: _spokeStartedAt,
        }),
        // Same timeout as registration — a route slow enough to fail this
        // would have failed registration too. (5s silently dropped every
        // heartbeat on slow edge routes while registration succeeded.)
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        _hbFailures++;
        console.warn(`[spoke] Heartbeat rejected by hub: HTTP ${resp.status} (${_hbFailures} consecutive)`);
      } else {
        if (_hbFailures > 0) console.log(`[spoke] Heartbeat recovered after ${_hbFailures} failure(s)`);
        _hbFailures = 0;
        const hbData = await resp.json().catch(() => ({}));
        applyHubLLMConfig(hbData.llmConfig, hubUrl);
      }
    } catch (err) {
      _hbFailures++;
      console.warn(`[spoke] Heartbeat failed: ${fetchErrorDetail(err)} (${_hbFailures} consecutive)`);
    }
  }

  function startHeartbeatLoop() {
    if (_hbTimer) return;
    _hbTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    sendHeartbeat();
  }

  await register();
}
