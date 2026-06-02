/**
 * Hub Reporter — sends scan results and heartbeats to the TCS MCP Gateway.
 *
 * Heartbeat protocol (v1):
 *   Interval:  30 s (lightweight health ping, separate from full report)
 *   Payload:   { seq, ts, uptime, memMB, healthy, lastReportAge }
 *   Stale:     Hub marks agent stale after 90 s without heartbeat
 *   Unreachable: Hub marks unreachable after 300 s without heartbeat
 */

const HUB_URL = process.env.HUB_SERVER_URL || "http://localhost:3000";
const CLUSTER_NAME = process.env.CLUSTER_NAME || "unknown";
const CLUSTER_PLATFORM = process.env.CLUSTER_PLATFORM || "k8s";
const REPORT_TIMEOUT_MS = 15000;
const SKIP_TLS = process.env.HUB_TLS_SKIP_VERIFY === "true";
const ACTIONS_ENABLED = process.env.ALLOW_REMOTE_ACTIONS === "true";

const HEARTBEAT_INTERVAL_MS = 30000;

const BASE_CAPABILITIES = ["scan", "events", "metrics", "openshift", "security", "gitops", "dr", "optimization", "imagevulns", "rbac", "workloads", "ai-reasoning"];
const CAPABILITIES = ACTIONS_ENABLED ? [...BASE_CAPABILITIES, "actions"] : BASE_CAPABILITIES;

let _registered = false;
let _lastReportStatus = null;
let _consecutiveFailures = 0;
let _heartbeatSeq = 0;
let _heartbeatTimer = null;
let _lastReportTime = null;
let _healthy = true;

export async function registerWithHub() {
  try {
    const resp = await fetch(`${HUB_URL}/api/agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clusterName: CLUSTER_NAME,
        platform: CLUSTER_PLATFORM,
        agentVersion: "1.2.0",
        agentType: "ai-native",
        capabilities: CAPABILITIES,
        actionsEnabled: ACTIONS_ENABLED,
      }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    if (resp.ok) {
      _registered = true;
      _consecutiveFailures = 0;
      console.log(`[reporter] Registered with MCP Gateway: ${HUB_URL}`);
      startHeartbeat();
    } else {
      console.error(`[reporter] Registration failed: ${resp.status}`);
    }
  } catch (err) {
    _consecutiveFailures++;
    const hint = diagnoseFetchError(err);
    console.error(`[reporter] Cannot reach MCP Gateway ${HUB_URL}: ${err.message}${hint}`);
  }
}

export async function sendReport(scanData) {
  try {
    const resp = await fetch(`${HUB_URL}/api/agent/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clusterName: CLUSTER_NAME,
        platform: CLUSTER_PLATFORM,
        agentVersion: "1.2.0",
        agentType: "ai-native",
        report: scanData,
      }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    _lastReportStatus = resp.ok ? "ok" : `error:${resp.status}`;
    if (resp.ok) {
      _consecutiveFailures = 0;
      _lastReportTime = Date.now();
      _healthy = true;
    } else {
      console.error(`[reporter] Report failed: ${resp.status}`);
    }
  } catch (err) {
    _consecutiveFailures++;
    _lastReportStatus = `error:${err.message}`;
    if (_consecutiveFailures >= 3) _healthy = false;
    const hint = diagnoseFetchError(err);
    console.error(`[reporter] Report send error: ${err.message}${hint}`);
  }
}

function diagnoseFetchError(err) {
  const msg = err.message || "";
  if (msg.includes("CERT") || msg.includes("certificate") || msg.includes("self signed") || msg.includes("self-signed")) {
    return "\n  [hint] TLS certificate not trusted. Set HUB_TLS_SKIP_VERIFY=true in the agent ConfigMap.";
  }
  if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
    return "\n  [hint] DNS resolution failed. Verify the hub hostname is reachable from this cluster.";
  }
  if (msg.includes("ECONNREFUSED")) {
    return "\n  [hint] Connection refused. Verify the hub server is running and the port/route is correct.";
  }
  if (msg === "fetch failed" || msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
    if (_consecutiveFailures >= 3 && !SKIP_TLS && HUB_URL.startsWith("https")) {
      return "\n  [hint] Repeated HTTPS failures — likely a TLS/certificate issue. Set HUB_TLS_SKIP_VERIFY=true in the agent ConfigMap.";
    }
    return "\n  [hint] Connection failed. Check network/firewall between clusters, and verify DNS resolves the hub hostname.";
  }
  return "";
}

/** Start the lightweight heartbeat timer (30 s interval). */
function startHeartbeat() {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  sendHeartbeat();
}

export async function sendHeartbeat() {
  _heartbeatSeq++;
  const mem = process.memoryUsage();
  const payload = {
    clusterName: CLUSTER_NAME,
    seq: _heartbeatSeq,
    ts: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memMB: Math.round(mem.rss / 1048576),
    healthy: _healthy,
    lastReportAge: _lastReportTime
      ? Math.round((Date.now() - _lastReportTime) / 1000)
      : null,
  };
  try {
    await fetch(`${HUB_URL}/api/agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // best-effort, don't log noise — SSE keepalive is the fallback
  }
}

export function setHealthy(val) { _healthy = val; }
export function markReportSent() { _lastReportTime = Date.now(); }

export function getReporterStatus() {
  return {
    hubUrl: HUB_URL,
    clusterName: CLUSTER_NAME,
    platform: CLUSTER_PLATFORM,
    registered: _registered,
    lastReportStatus: _lastReportStatus,
    tlsSkipVerify: SKIP_TLS,
    consecutiveFailures: _consecutiveFailures,
    heartbeatSeq: _heartbeatSeq,
    healthy: _healthy,
  };
}
