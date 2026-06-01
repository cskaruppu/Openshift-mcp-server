/**
 * TCS Agentic AI — Kubernetes Cluster Agent
 *
 * Lightweight agent that runs inside a target Kubernetes cluster,
 * scans for health/issues, and reports back to the TCS Agentic AI Hub.
 *
 * Environment variables:
 *   HUB_SERVER_URL      - TCS Agentic AI hub URL (default: http://localhost:3000)
 *   CLUSTER_NAME         - Name of this cluster (default: unknown)
 *   CLUSTER_PLATFORM     - openshift | rancher | eks | aks | gke | k8s
 *   SCAN_INTERVAL        - Seconds between scans (default: 60)
 *   HUB_TLS_SKIP_VERIFY  - Skip TLS verification for hub connection (default: false)
 *   LOG_LEVEL            - info | debug | error (default: info)
 *   PORT                 - Health endpoint port (default: 8080)
 *   NODE_EXTRA_CA_CERTS  - Path to CA bundle for TLS (auto-set if not provided)
 */

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { scanCluster, clearTokenCache } from "./scanner.js";
import { registerWithHub, sendReport, getReporterStatus } from "./reporter.js";
import { startBridge, getBridgeStatus } from "./bridge.js";
import { runReconcile, getReconcileStatus } from "./rbac-reconciler.js";

// Allow skipping TLS verification for hub connections (self-signed/internal CA)
if (process.env.HUB_TLS_SKIP_VERIFY === "true" && process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// Auto-configure TLS CA from in-cluster service account if not already set
if (!process.env.NODE_EXTRA_CA_CERTS) {
  const saCA = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
  if (existsSync(saCA)) {
    process.env.NODE_EXTRA_CA_CERTS = saCA;
  }
}

const PORT = parseInt(process.env.PORT || "8080", 10);
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL || "60", 10) * 1000;
const PLATFORM = process.env.CLUSTER_PLATFORM || "k8s";
const CLUSTER_NAME = process.env.CLUSTER_NAME || "unknown";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

let _lastScan = null;
let _lastScanTime = null;
let _scanCount = 0;
let _errorCount = 0;
let _ready = false;
let _timer = null;

function log(level, ...args) {
  if (level === "debug" && LOG_LEVEL !== "debug") return;
  const ts = new Date().toISOString();
  console.log(`${ts} [${level.toUpperCase()}]`, ...args);
}

async function runScan() {
  const start = Date.now();
  try {
    log("info", `Scanning cluster "${CLUSTER_NAME}" (${PLATFORM})...`);
    _lastScan = await scanCluster(PLATFORM);
    _lastScanTime = new Date().toISOString();
    _scanCount++;
    const elapsed = Date.now() - start;
    const issues = _lastScan.pods?.issues?.length || 0;
    log("info", `Scan complete in ${elapsed}ms — ${_lastScan.nodes.total} nodes, ${_lastScan.pods.total} pods, ${issues} issues, ${_lastScan.events.warnings} warnings`);

    await sendReport(_lastScan);
  } catch (err) {
    _errorCount++;
    log("error", `Scan failed: ${err.message}`);
    clearTokenCache();
  }
}

function buildStatusResponse() {
  const reporter = getReporterStatus();
  const bridge = getBridgeStatus();
  const rbac = getReconcileStatus();
  return {
    agent: "tcs-agentic-ai-agent",
    version: "1.1.0",
    cluster: CLUSTER_NAME,
    platform: PLATFORM,
    uptime: Math.floor(process.uptime()),
    scanCount: _scanCount,
    errorCount: _errorCount,
    lastScanTime: _lastScanTime,
    hub: reporter,
    bridge,
    rbacReconcile: rbac,
    summary: _lastScan
      ? {
          nodes: `${_lastScan.nodes.ready}/${_lastScan.nodes.total} ready`,
          pods: `${_lastScan.pods.running} running, ${_lastScan.pods.failed} failed, ${_lastScan.pods.pending} pending`,
          issues: _lastScan.pods.issues.length,
          warnings: _lastScan.events.warnings,
          namespaces: _lastScan.namespaces,
          openshiftVersion: _lastScan.openshiftVersion || undefined,
        }
      : null,
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: Math.floor(process.uptime()) }));
    return;
  }

  if (url.pathname === "/readyz") {
    if (_ready) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ready", scanCount: _scanCount }));
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not ready" }));
    }
    return;
  }

  if (url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildStatusResponse(), null, 2));
    return;
  }

  if (url.pathname === "/scan" && req.method === "GET") {
    if (_lastScan) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ scan: _lastScan, scannedAt: _lastScanTime }));
    } else {
      res.writeHead(204);
      res.end();
    }
    return;
  }

  if (url.pathname === "/scan" && req.method === "POST") {
    runScan().then(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ triggered: true, scanCount: _scanCount }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

async function start() {
  log("info", "===========================================");
  log("info", "  TCS Agentic AI — Cluster Agent v1.1.0");
  log("info", "===========================================");
  log("info", `Cluster:   ${CLUSTER_NAME}`);
  log("info", `Platform:  ${PLATFORM}`);
  log("info", `Scan interval: ${SCAN_INTERVAL / 1000}s`);
  log("info", `Hub URL:   ${process.env.HUB_SERVER_URL || "(not set)"}`);
  log("info", `TLS skip:  ${process.env.HUB_TLS_SKIP_VERIFY === "true" ? "yes (self-signed certs accepted)" : "no (strict verification)"}`);

  await registerWithHub();

  // Start the bidirectional MCP tool bridge (runs in parallel with scans)
  startBridge(process.env.HUB_SERVER_URL, CLUSTER_NAME);

  await runScan();
  _ready = true;

  _timer = setInterval(runScan, SCAN_INTERVAL);

  server.listen(PORT, "0.0.0.0", () => {
    log("info", `Health endpoints on :${PORT} — /healthz /readyz /status /scan`);
  });
}

process.on("SIGTERM", () => {
  log("info", "SIGTERM received, shutting down...");
  clearInterval(_timer);
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  log("info", "SIGINT received, shutting down...");
  clearInterval(_timer);
  server.close(() => process.exit(0));
});

start().catch((err) => {
  log("error", `Fatal: ${err.message}`);
  process.exit(1);
});
