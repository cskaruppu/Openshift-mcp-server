/**
 * Hub Reporter — sends scan results back to the TCS Agentic AI hub server.
 */

const HUB_URL = process.env.HUB_SERVER_URL || "http://localhost:3000";
const CLUSTER_NAME = process.env.CLUSTER_NAME || "unknown";
const CLUSTER_PLATFORM = process.env.CLUSTER_PLATFORM || "k8s";
const REPORT_TIMEOUT_MS = 15000;
const SKIP_TLS = process.env.HUB_TLS_SKIP_VERIFY === "true";

let _registered = false;
let _lastReportStatus = null;
let _consecutiveFailures = 0;

export async function registerWithHub() {
  try {
    const resp = await fetch(`${HUB_URL}/api/agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clusterName: CLUSTER_NAME,
        platform: CLUSTER_PLATFORM,
        agentVersion: "1.0.0",
        capabilities: ["scan", "events", "metrics", "openshift"],
      }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    if (resp.ok) {
      _registered = true;
      _consecutiveFailures = 0;
      console.log(`[reporter] Registered with hub: ${HUB_URL}`);
    } else {
      console.error(`[reporter] Registration failed: ${resp.status}`);
    }
  } catch (err) {
    _consecutiveFailures++;
    const hint = diagnoseFetchError(err);
    console.error(`[reporter] Cannot reach hub ${HUB_URL}: ${err.message}${hint}`);
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
        agentVersion: "1.0.0",
        report: scanData,
      }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    _lastReportStatus = resp.ok ? "ok" : `error:${resp.status}`;
    if (resp.ok) {
      _consecutiveFailures = 0;
    } else {
      console.error(`[reporter] Report failed: ${resp.status}`);
    }
  } catch (err) {
    _consecutiveFailures++;
    _lastReportStatus = `error:${err.message}`;
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

export function getReporterStatus() {
  return {
    hubUrl: HUB_URL,
    clusterName: CLUSTER_NAME,
    platform: CLUSTER_PLATFORM,
    registered: _registered,
    lastReportStatus: _lastReportStatus,
    tlsSkipVerify: SKIP_TLS,
    consecutiveFailures: _consecutiveFailures,
  };
}
