/**
 * Hub Reporter — sends scan results back to the KubeNexus AI hub server.
 */

const HUB_URL = process.env.HUB_SERVER_URL || "http://localhost:3000";
const CLUSTER_NAME = process.env.CLUSTER_NAME || "unknown";
const CLUSTER_PLATFORM = process.env.CLUSTER_PLATFORM || "k8s";
const REPORT_TIMEOUT_MS = 15000;

let _registered = false;
let _lastReportStatus = null;

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
      console.log(`[reporter] Registered with hub: ${HUB_URL}`);
    } else {
      console.error(`[reporter] Registration failed: ${resp.status}`);
    }
  } catch (err) {
    console.error(`[reporter] Cannot reach hub ${HUB_URL}: ${err.message}`);
  }
}

export async function sendReport(scanData) {
  const payload = {
    clusterName: CLUSTER_NAME,
    platform: CLUSTER_PLATFORM,
    agentVersion: "1.0.0",
    report: scanData,
  };

  try {
    const resp = await fetch(`${HUB_URL}/api/agent/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    _lastReportStatus = resp.ok ? "ok" : `error:${resp.status}`;
    if (!resp.ok) {
      console.error(`[reporter] Report failed: ${resp.status}`);
    }
  } catch (err) {
    _lastReportStatus = `error:${err.message}`;
    console.error(`[reporter] Report send error: ${err.message}`);
  }
}

export function getReporterStatus() {
  return {
    hubUrl: HUB_URL,
    clusterName: CLUSTER_NAME,
    platform: CLUSTER_PLATFORM,
    registered: _registered,
    lastReportStatus: _lastReportStatus,
  };
}
