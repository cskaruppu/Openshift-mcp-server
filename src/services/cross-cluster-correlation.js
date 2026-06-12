/**
 * Cross-Cluster Anomaly Correlation
 *
 * Detects patterns that span multiple clusters — something no single-cluster
 * tool can do. Uses temporal proximity, symptom similarity, and causal chain
 * analysis to surface correlated incidents.
 *
 * Example: "CrashLoopBackOff on cluster-01 started at 10:02, same image
 * failed on cluster-02 at 10:04 — likely a bad image push."
 */

import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";
import { loadAllClusterSnapshots } from "../utils/db.js";
import { callLLM, llmEnabled } from "./llm.js";
import { getInsights } from "./proactive-agent.js";
import { getAllSpokes } from "./spoke-proxy.js";

const CORRELATION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const CORRELATION_CACHE_TTL = 60_000;

let _lastCorrelation = null;
let _lastCorrelationTime = 0;

/**
 * Collect alerts and events from all clusters (snapshots + live insights).
 */
async function gatherMultiClusterSignals() {
  const signals = [];

  // 1. Cluster snapshots — every cluster's latest report
  let snapshots = [];
  try { snapshots = await loadAllClusterSnapshots() || []; } catch { /* no DB */ }

  for (const snap of snapshots) {
    const cluster = snap.cluster || "local";
    const report = typeof snap.report === "string" ? JSON.parse(snap.report) : (snap.report || {});
    const reportedAt = snap.reported_at || snap.updated_at;

    // Extract pod issues
    const pods = report.pods || {};
    if (pods.failed > 0 || pods.pending > 0) {
      signals.push({
        cluster, type: "pod-health", severity: pods.failed > 5 ? "critical" : "warning",
        summary: `${pods.failed} failed, ${pods.pending} pending pods`,
        detail: { failed: pods.failed, pending: pods.pending, total: pods.total },
        timestamp: reportedAt,
      });
    }

    // Extract operator degradation
    const ops = report.clusterOperators || {};
    if (ops.degraded > 0) {
      const degradedOps = (ops.items || []).filter(o => o.degraded || o.status === "degraded");
      signals.push({
        cluster, type: "operator-degraded", severity: "critical",
        summary: `${ops.degraded} degraded operator(s): ${degradedOps.map(o => o.name).join(", ")}`,
        detail: { operators: degradedOps.map(o => o.name) },
        timestamp: reportedAt,
      });
    }

    // Extract node issues
    const nodes = report.nodes || {};
    const notReady = (nodes.items || []).filter(n => !n.ready);
    if (notReady.length > 0) {
      signals.push({
        cluster, type: "node-not-ready", severity: "critical",
        summary: `${notReady.length} node(s) not ready: ${notReady.map(n => n.name).join(", ")}`,
        detail: { nodes: notReady.map(n => n.name) },
        timestamp: reportedAt,
      });
    }

    // Extract recent events (warnings)
    const events = report.events?.recent || [];
    for (const evt of events) {
      if (evt.reason === "Normal") continue;
      signals.push({
        cluster, type: `event:${evt.reason || "Unknown"}`, severity: "warning",
        summary: `${evt.reason}: ${(evt.message || "").slice(0, 150)}`,
        detail: { reason: evt.reason, namespace: evt.namespace, count: evt.count },
        timestamp: evt.lastSeen || reportedAt,
      });
    }
  }

  // 2. Live proactive insights (local cluster)
  const insights = getInsights();
  for (const ins of insights) {
    signals.push({
      cluster: ins.cluster || "local",
      type: ins.type || ins.reason || "unknown",
      severity: ins.severity >= 80 ? "critical" : ins.severity >= 50 ? "warning" : "info",
      summary: ins.title || ins.message || "",
      detail: { namespace: ins.namespace, resource: ins.resource, reason: ins.reason },
      timestamp: ins.detectedAt || new Date().toISOString(),
    });
  }

  // 3. Recent incidents from DB
  if (await dbEnabled()) {
    try {
      const res = await dbQuery(
        `SELECT cluster, issue_type, issue_signature, resource_name, namespace,
                severity, context, occurred_at, last_seen_at
         FROM incident_history
         WHERE last_seen_at > NOW() - INTERVAL '1 hour'
         ORDER BY last_seen_at DESC
         LIMIT 200`
      );
      for (const row of (res?.rows || [])) {
        signals.push({
          cluster: row.cluster_name || row.cluster || "local",
          type: row.issue_type || "incident",
          severity: row.severity >= 80 ? "critical" : row.severity >= 50 ? "warning" : "info",
          summary: `${row.issue_type}: ${row.resource_name || ""} in ${row.namespace || "*"}`,
          detail: { signature: row.issue_signature, namespace: row.namespace, resource: row.resource_name },
          timestamp: row.last_seen_at || row.occurred_at,
        });
      }
    } catch { /* DB unavailable */ }
  }

  return signals;
}

/**
 * Find correlated signals across clusters.
 * Two signals correlate when they share a symptom pattern AND occur within the time window.
 */
function findCorrelations(signals) {
  const correlations = [];
  const used = new Set();

  // Normalize type for matching
  const normalize = (type) => (type || "").toLowerCase().replace(/^event:/, "");

  for (let i = 0; i < signals.length; i++) {
    if (used.has(i)) continue;
    const group = [signals[i]];
    const iType = normalize(signals[i].type);
    const iTime = new Date(signals[i].timestamp).getTime();

    for (let j = i + 1; j < signals.length; j++) {
      if (used.has(j)) continue;
      if (signals[j].cluster === signals[i].cluster) continue; // same cluster = not cross-cluster

      const jType = normalize(signals[j].type);
      const jTime = new Date(signals[j].timestamp).getTime();
      const timeDelta = Math.abs(iTime - jTime);

      // Correlation criteria
      let score = 0;
      if (iType === jType) score += 50;
      else if (iType.includes(jType) || jType.includes(iType)) score += 30;

      // Same operator degraded
      const iOps = signals[i].detail?.operators || [];
      const jOps = signals[j].detail?.operators || [];
      const sharedOps = iOps.filter(o => jOps.includes(o));
      if (sharedOps.length > 0) score += 40;

      // Same namespace affected
      if (signals[i].detail?.namespace && signals[i].detail.namespace === signals[j].detail?.namespace) score += 20;

      // Temporal proximity bonus
      if (timeDelta < CORRELATION_WINDOW_MS) score += 30;
      else if (timeDelta < 30 * 60 * 1000) score += 10;

      if (score >= 50) {
        group.push(signals[j]);
        used.add(j);
      }
    }

    if (group.length >= 2) {
      used.add(i);
      const clusters = [...new Set(group.map(s => s.cluster))];
      const types = [...new Set(group.map(s => normalize(s.type)))];
      const maxSeverity = group.some(s => s.severity === "critical") ? "critical" : "warning";
      const earliest = group.reduce((a, b) => new Date(a.timestamp) < new Date(b.timestamp) ? a : b);
      const latest = group.reduce((a, b) => new Date(a.timestamp) > new Date(b.timestamp) ? a : b);
      const spreadMs = new Date(latest.timestamp).getTime() - new Date(earliest.timestamp).getTime();

      correlations.push({
        id: `corr-${Date.now()}-${correlations.length}`,
        clusters,
        clusterCount: clusters.length,
        types,
        severity: maxSeverity,
        signalCount: group.length,
        signals: group,
        spreadMinutes: Math.round(spreadMs / 60000),
        firstSeen: earliest.timestamp,
        lastSeen: latest.timestamp,
        summary: buildCorrelationSummary(group, clusters, types, spreadMs),
      });
    }
  }

  return correlations.sort((a, b) => {
    const sevOrder = { critical: 0, warning: 1, info: 2 };
    return (sevOrder[a.severity] || 2) - (sevOrder[b.severity] || 2) || b.signalCount - a.signalCount;
  });
}

function buildCorrelationSummary(signals, clusters, types, spreadMs) {
  const clusterList = clusters.join(", ");
  const typeList = types.join(", ");
  const timeStr = spreadMs < 60000 ? "simultaneously" : `within ${Math.round(spreadMs / 60000)} minutes`;
  return `${typeList} detected on ${clusters.length} clusters (${clusterList}) ${timeStr} — likely shared root cause`;
}

/**
 * Use LLM to analyze a correlation and suggest root cause.
 */
async function analyzeCorrelation(correlation) {
  if (!llmEnabled()) return { rootCause: null, recommendation: null };

  const signalSummary = correlation.signals.map(s =>
    `- [${s.cluster}] ${s.type}: ${s.summary} (${s.timestamp})`
  ).join("\n");

  const prompt = `You are an expert Site Reliability Engineer analyzing a multi-cluster incident.

The following anomalies were detected across ${correlation.clusterCount} OpenShift clusters within a ${correlation.spreadMinutes}-minute window:

${signalSummary}

This pattern suggests a correlated incident — these are NOT independent failures.

Analyze:
1. What is the most likely shared root cause?
2. What is the blast radius?
3. What immediate action should the operations team take?
4. What is the likely causal chain (which event triggered the others)?

Be specific and actionable. Keep response under 200 words.`;

  try {
    const reply = await callLLM(prompt, { maxTokens: 500, temperature: 0.3 });
    return { analysis: reply };
  } catch (err) {
    return { analysis: null, error: err.message };
  }
}

/**
 * Main entry point — run cross-cluster correlation analysis.
 * Returns cached result if called within TTL.
 */
export async function runCorrelationAnalysis(opts = {}) {
  const now = Date.now();
  if (!opts.force && _lastCorrelation && (now - _lastCorrelationTime) < CORRELATION_CACHE_TTL) {
    return _lastCorrelation;
  }

  const signals = await gatherMultiClusterSignals();
  const correlations = findCorrelations(signals);

  const result = {
    timestamp: new Date().toISOString(),
    totalSignals: signals.length,
    clustersCovered: [...new Set(signals.map(s => s.cluster))],
    correlations,
    correlationCount: correlations.length,
    criticalCount: correlations.filter(c => c.severity === "critical").length,
    warningCount: correlations.filter(c => c.severity === "warning").length,
  };

  _lastCorrelation = result;
  _lastCorrelationTime = now;
  return result;
}

/**
 * Analyze a specific correlation with LLM — on-demand (user clicks "Investigate").
 */
export async function investigateCorrelation(correlationId) {
  if (!_lastCorrelation) await runCorrelationAnalysis({ force: true });
  const corr = (_lastCorrelation?.correlations || []).find(c => c.id === correlationId);
  if (!corr) return { error: "Correlation not found" };
  const analysis = await analyzeCorrelation(corr);
  corr.analysis = analysis.analysis;
  return { correlation: corr, analysis };
}

/**
 * Get signals summary per cluster (for the overview card).
 */
export async function getClusterSignalSummary() {
  const signals = await gatherMultiClusterSignals();
  const byCluster = {};
  for (const s of signals) {
    if (!byCluster[s.cluster]) byCluster[s.cluster] = { critical: 0, warning: 0, info: 0, total: 0 };
    byCluster[s.cluster][s.severity] = (byCluster[s.cluster][s.severity] || 0) + 1;
    byCluster[s.cluster].total++;
  }
  return byCluster;
}
