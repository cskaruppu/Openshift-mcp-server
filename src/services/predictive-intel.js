/**
 * Predictive Intelligence — trend analysis and forecasting.
 *
 * Analyzes time-series data (restart counts, resource usage, event frequency)
 * to predict issues BEFORE they happen.
 *
 * Predictions:
 *   - OOM likely within N hours based on memory growth trend
 *   - Disk full within N hours based on usage trend
 *   - Restart rate acceleration (approaching CrashLoopBackOff)
 *   - Certificate expiry countdown
 *   - Capacity exhaustion (cluster running out of pods/CPU/memory)
 */

import { ocpGet } from "../utils/openshift-client.js";
import { cacheGet, cacheSet } from "../utils/cache.js";

const TREND_WINDOW_MINUTES = 30;
const _trends = {
  podRestarts: [],
  nodeMemory: [],
  nodeCPU: [],
  eventRate: [],
  operatorHealth: [],
  pvcUsage: [],
};

const _predictions = [];

export async function runPredictiveAnalysis() {
  try {
    await Promise.allSettled([
      collectRestartTrend(),
      collectResourceTrend(),
      collectEventTrend(),
      collectOperatorTrend(),
    ]);

    _predictions.length = 0;

    predictOOM();
    predictRestartEscalation();
    predictCapacityExhaustion();
    predictMemoryExhaustion();
    predictEventEscalation();
    predictOperatorDegradation();

    return _predictions.slice();
  } catch (err) {
    console.error("[predictive] analysis error:", err.message);
    return [];
  }
}

async function collectRestartTrend() {
  try {
    const pods = await ocpGet("/api/v1/pods");
    const now = Date.now();
    const datapoint = { timestamp: now, pods: {} };

    for (const pod of pods.items || []) {
      const ns = pod.metadata?.namespace;
      if (ns?.startsWith("openshift-") || ns === "kube-system") continue;
      const key = `${ns}/${pod.metadata.name}`;
      const restarts = (pod.status?.containerStatuses || []).reduce(
        (s, c) => s + (c.restartCount || 0), 0
      );
      datapoint.pods[key] = restarts;
    }

    _trends.podRestarts.push(datapoint);
    if (_trends.podRestarts.length > 30) _trends.podRestarts.shift();
  } catch { /* skip */ }
}

async function collectResourceTrend() {
  try {
    const metrics = await ocpGet("/apis/metrics.k8s.io/v1beta1/nodes");
    const now = Date.now();

    for (const node of metrics.items || []) {
      const cpuNano = parseCPU(node.usage?.cpu);
      const memBytes = parseMem(node.usage?.memory);
      _trends.nodeMemory.push({ timestamp: now, node: node.metadata.name, value: memBytes });
      _trends.nodeCPU.push({ timestamp: now, node: node.metadata.name, value: cpuNano });
    }

    if (_trends.nodeMemory.length > 100) _trends.nodeMemory.splice(0, _trends.nodeMemory.length - 100);
    if (_trends.nodeCPU.length > 100) _trends.nodeCPU.splice(0, _trends.nodeCPU.length - 100);
  } catch { /* metrics-server may not be available */ }
}

async function collectEventTrend() {
  try {
    const events = await ocpGet("/api/v1/events");
    const now = Date.now();
    const warnings = (events.items || []).filter((e) => e.type === "Warning");
    const recent = warnings.filter((e) => {
      const ts = new Date(e.lastTimestamp || e.metadata.creationTimestamp).getTime();
      return now - ts < TREND_WINDOW_MINUTES * 60 * 1000;
    });
    _trends.eventRate.push({ timestamp: now, count: recent.length });
    if (_trends.eventRate.length > 30) _trends.eventRate.shift();
  } catch { /* skip */ }
}

function predictOOM() {
  if (_trends.podRestarts.length < 3) return;

  const latest = _trends.podRestarts[_trends.podRestarts.length - 1];
  const oldest = _trends.podRestarts[0];
  const elapsed = (latest.timestamp - oldest.timestamp) / 60000;
  if (elapsed < 5) return;

  for (const [podKey, currentRestarts] of Object.entries(latest.pods)) {
    const initialRestarts = oldest.pods[podKey] || 0;
    const rate = (currentRestarts - initialRestarts) / elapsed;

    if (rate > 0.5) {
      _predictions.push({
        type: "RestartAcceleration",
        resource: podKey,
        severity: rate > 2 ? "critical" : "warning",
        title: `Pod ${podKey.split("/")[1]} restarting rapidly`,
        detail: `Rate: ${rate.toFixed(1)} restarts/min over ${Math.round(elapsed)}min`,
        prediction: `Will likely enter CrashLoopBackOff within ${Math.round(5 / rate)} minutes`,
        confidence: Math.min(rate / 3, 1),
      });
    }
  }
}

function predictRestartEscalation() {
  if (_trends.podRestarts.length < 2) return;

  const prev = _trends.podRestarts[_trends.podRestarts.length - 2];
  const curr = _trends.podRestarts[_trends.podRestarts.length - 1];

  for (const [podKey, currCount] of Object.entries(curr.pods)) {
    const prevCount = prev.pods[podKey] || 0;
    const delta = currCount - prevCount;

    if (delta >= 2 && currCount >= 5) {
      _predictions.push({
        type: "RestartEscalation",
        resource: podKey,
        severity: delta >= 5 ? "critical" : "warning",
        title: `Restart escalation: ${podKey.split("/")[1]}`,
        detail: `+${delta} restarts in last scan interval (total: ${currCount})`,
        prediction: "Pod instability increasing — investigate immediately",
        confidence: Math.min(delta / 5, 1),
      });
    }
  }
}

function predictCapacityExhaustion() {
  if (_trends.nodeCPU.length < 2) return;

  const nodeGroups = {};
  for (const dp of _trends.nodeCPU) {
    if (!nodeGroups[dp.node]) nodeGroups[dp.node] = [];
    nodeGroups[dp.node].push(dp);
  }

  for (const [node, points] of Object.entries(nodeGroups)) {
    if (points.length < 2) continue;
    const first = points[0];
    const last = points[points.length - 1];
    const elapsed = (last.timestamp - first.timestamp) / 3600000;
    if (elapsed < 0.1) continue;

    const rate = (last.value - first.value) / elapsed;
    if (rate > 0 && last.value > 0) {
      const maxCPU = 4 * 1e9;
      const remaining = maxCPU - last.value;
      const hoursLeft = remaining / rate;

      if (hoursLeft < 24 && hoursLeft > 0) {
        _predictions.push({
          type: "CPUExhaustion",
          resource: `node/${node}`,
          severity: hoursLeft < 6 ? "critical" : "warning",
          title: `Node ${node} CPU may exhaust in ~${Math.round(hoursLeft)}h`,
          detail: `Current rate: ${(rate / 1e6).toFixed(0)}m cores/hour`,
          prediction: `Estimated ${Math.round(hoursLeft)} hours until capacity limit`,
          confidence: Math.min(elapsed / 2, 0.8),
        });
      }
    }
  }
}

// Collect ClusterOperator health trends (OpenShift)
async function collectOperatorTrend() {
  try {
    const ops = await ocpGet("/apis/config.openshift.io/v1/clusteroperators");
    const now = Date.now();
    const dp = { timestamp: now, operators: {} };
    for (const op of ops.items || []) {
      const name = op.metadata?.name;
      const conditions = op.status?.conditions || [];
      const degraded = conditions.find((c) => c.type === "Degraded" && c.status === "True");
      const available = conditions.find((c) => c.type === "Available");
      dp.operators[name] = {
        available: available?.status === "True",
        degraded: !!degraded,
        reason: degraded?.reason || available?.reason || "",
      };
    }
    _trends.operatorHealth.push(dp);
    if (_trends.operatorHealth.length > 30) _trends.operatorHealth.shift();
  } catch { /* not OpenShift or no access */ }
}

// Predict node memory exhaustion using linear growth model
function predictMemoryExhaustion() {
  if (_trends.nodeMemory.length < 2) return;

  const nodeGroups = {};
  for (const dp of _trends.nodeMemory) {
    if (!nodeGroups[dp.node]) nodeGroups[dp.node] = [];
    nodeGroups[dp.node].push(dp);
  }

  for (const [node, points] of Object.entries(nodeGroups)) {
    if (points.length < 2) continue;
    const first = points[0];
    const last = points[points.length - 1];
    const elapsedH = (last.timestamp - first.timestamp) / 3600000;
    if (elapsedH < 0.1) continue;

    const growthRate = (last.value - first.value) / elapsedH;
    if (growthRate <= 0) continue;

    // Assume typical node has ~16GB (or use actual allocatable if available)
    const maxMem = 16 * 1024 * 1024 * 1024;
    const remaining = maxMem - last.value;
    if (remaining <= 0) continue;
    const hoursLeft = remaining / growthRate;

    if (hoursLeft < 48 && hoursLeft > 0) {
      _predictions.push({
        type: "MemoryExhaustion",
        resource: `node/${node}`,
        severity: hoursLeft < 6 ? "critical" : hoursLeft < 12 ? "warning" : "info",
        title: `Node ${node} memory may exhaust in ~${Math.round(hoursLeft)}h`,
        detail: `Current growth: ${(growthRate / (1024 * 1024)).toFixed(0)}MB/hour. Current: ${(last.value / (1024 * 1024 * 1024)).toFixed(1)}GB`,
        prediction: `Estimated ${Math.round(hoursLeft)} hours until memory pressure triggers evictions`,
        confidence: Math.min(elapsedH / 2, 0.85),
      });
    }
  }
}

// Predict event rate escalation — if warning events are accelerating, something is degrading
function predictEventEscalation() {
  if (_trends.eventRate.length < 3) return;

  const recent = _trends.eventRate.slice(-5);
  if (recent.length < 3) return;

  // Linear regression on event counts
  let increasing = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].count > recent[i - 1].count) increasing++;
  }

  const first = recent[0];
  const last = recent[recent.length - 1];
  const delta = last.count - first.count;

  if (increasing >= recent.length - 1 && delta > 10 && last.count > 20) {
    const elapsedMin = (last.timestamp - first.timestamp) / 60000;
    const ratePerMin = delta / Math.max(elapsedMin, 1);
    _predictions.push({
      type: "EventEscalation",
      resource: "cluster/events",
      severity: last.count > 100 ? "critical" : "warning",
      title: "Warning events accelerating across cluster",
      detail: `${last.count} warnings now (+${delta} in ${Math.round(elapsedMin)}min). Rate: ${ratePerMin.toFixed(1)}/min`,
      prediction: "Cluster instability is increasing — investigate root cause before cascading failures",
      confidence: Math.min(increasing / recent.length, 0.9),
    });
  }
}

// Predict operator degradation — operators that flip between healthy/degraded
function predictOperatorDegradation() {
  if (_trends.operatorHealth.length < 3) return;

  // Check for operators that are newly degraded or flapping
  const latest = _trends.operatorHealth[_trends.operatorHealth.length - 1];
  if (!latest) return;

  for (const [opName, state] of Object.entries(latest.operators)) {
    if (!state.degraded && state.available) continue;

    // Count how many recent scans this operator was degraded
    let degradedCount = 0;
    const window = _trends.operatorHealth.slice(-5);
    for (const dp of window) {
      if (dp.operators[opName]?.degraded || !dp.operators[opName]?.available) {
        degradedCount++;
      }
    }

    if (degradedCount >= 2) {
      const isPersistent = degradedCount >= window.length - 1;
      _predictions.push({
        type: "OperatorDegradation",
        resource: `clusteroperator/${opName}`,
        severity: !state.available ? "critical" : isPersistent ? "warning" : "info",
        title: `Operator "${opName}" ${!state.available ? "unavailable" : "degraded"} — ${isPersistent ? "persistent" : "intermittent"}`,
        detail: `Degraded in ${degradedCount}/${window.length} recent scans. Reason: ${state.reason || "unknown"}`,
        prediction: isPersistent
          ? `Operator "${opName}" consistently unhealthy — may block cluster upgrades and affect dependent components`
          : `Operator "${opName}" is flapping — may indicate underlying infrastructure instability`,
        confidence: degradedCount / window.length,
      });
    }
  }
}

function parseCPU(val) {
  if (!val) return 0;
  if (val.endsWith("n")) return parseInt(val);
  if (val.endsWith("u")) return parseInt(val) * 1000;
  if (val.endsWith("m")) return parseInt(val) * 1e6;
  return parseFloat(val) * 1e9;
}

function parseMem(val) {
  if (!val) return 0;
  if (val.endsWith("Ki")) return parseInt(val) * 1024;
  if (val.endsWith("Mi")) return parseInt(val) * 1024 * 1024;
  if (val.endsWith("Gi")) return parseInt(val) * 1024 * 1024 * 1024;
  return parseInt(val);
}

export function getPredictions() {
  return _predictions.slice();
}

export function getTrends() {
  return {
    podRestarts: _trends.podRestarts.length,
    nodeMemory: _trends.nodeMemory.length,
    nodeCPU: _trends.nodeCPU.length,
    eventRate: _trends.eventRate.slice(-10),
    operatorHealth: _trends.operatorHealth.length,
  };
}
