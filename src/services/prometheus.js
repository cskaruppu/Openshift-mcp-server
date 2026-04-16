/**
 * Prometheus / Thanos query client.
 *
 * Talks to the in-cluster Thanos Querier exposed by OpenShift's monitoring
 * stack. All queries are read-only. Used by the agent loop's `query_metrics`
 * tool and by the cost/health advisors.
 *
 * Configuration:
 *   PROMETHEUS_URL — override (default: https://thanos-querier.openshift-monitoring.svc:9091)
 *   PROMETHEUS_TOKEN — bearer token; falls back to SA token
 */

import { readFile } from "node:fs/promises";

const DEFAULT_URL =
  process.env.PROMETHEUS_URL ||
  "https://thanos-querier.openshift-monitoring.svc:9091";

let _tk = null;
async function getToken() {
  if (_tk) return _tk;
  if (process.env.PROMETHEUS_TOKEN) return (_tk = process.env.PROMETHEUS_TOKEN);
  if (process.env.OPENSHIFT_TOKEN) return (_tk = process.env.OPENSHIFT_TOKEN);
  try {
    _tk = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
  } catch {
    _tk = null;
  }
  return _tk;
}

export async function promQuery(query, { url = DEFAULT_URL } = {}) {
  const tk = await getToken();
  const endpoint = `${url}/api/v1/query?query=${encodeURIComponent(query)}`;
  const resp = await fetch(endpoint, {
    headers: tk ? { Authorization: `Bearer ${tk}` } : {},
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Prometheus ${resp.status}: ${body.substring(0, 300)}`);
  }
  const data = await resp.json();
  if (data.status !== "success") throw new Error(`Prometheus error: ${data.error || "unknown"}`);
  return (data.data?.result || []).slice(0, 200).map((r) => ({
    metric: r.metric,
    value: r.value, // [ts, value]
  }));
}

export async function promRange(query, startTs, endTs, step = "60s") {
  const tk = await getToken();
  const endpoint =
    `${DEFAULT_URL}/api/v1/query_range?` +
    `query=${encodeURIComponent(query)}` +
    `&start=${startTs}&end=${endTs}&step=${step}`;
  const resp = await fetch(endpoint, {
    headers: tk ? { Authorization: `Bearer ${tk}` } : {},
  });
  if (!resp.ok) throw new Error(`Prometheus range ${resp.status}`);
  const data = await resp.json();
  return data.data?.result || [];
}

// ---------------------------------------------------------------------------
// Curated helpers
// ---------------------------------------------------------------------------
export async function podCpu(ns, pod) {
  return promQuery(
    `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",pod="${pod}",container!=""}[5m]))`
  );
}

export async function podMemory(ns, pod) {
  return promQuery(
    `sum(container_memory_working_set_bytes{namespace="${ns}",pod="${pod}",container!=""})`
  );
}

export async function nodeCpuPct() {
  return promQuery(
    `100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`
  );
}

export async function nodeMemoryPct() {
  return promQuery(
    `(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100`
  );
}

export async function pvcUsagePct() {
  return promQuery(
    `(kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) * 100`
  );
}

export async function isPrometheusReachable() {
  try {
    await promQuery("up", {});
    return true;
  } catch {
    return false;
  }
}
