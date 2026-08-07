/**
 * Prometheus / Thanos query client.
 *
 * Talks to the Thanos Querier of whichever cluster is currently in context.
 * All queries are read-only. Used by the agent loop's `query_metrics` tool,
 * the cost/health advisors, the incident detector and the GPU/VM views.
 *
 * CLUSTER AWARENESS
 * -----------------
 * The service DNS name `thanos-querier.openshift-monitoring.svc` only resolves
 * inside the cluster the server is running in. Using it unconditionally meant
 * every metric — GPU inventory, PVC fill, VM usage — was silently read from the
 * HUB while the user was looking at a spoke, so a remote cluster full of GPUs
 * reported none. Requests carrying a remote cluster context now resolve that
 * cluster's own Thanos route and authenticate with that cluster's token.
 *
 * Configuration:
 *   PROMETHEUS_URL   — override for the local cluster
 *   PROMETHEUS_TOKEN — bearer token; falls back to the pod SA token
 */

import { readFile } from "node:fs/promises";
import { activeClusterContext, ocpGet } from "../utils/openshift-client.js";

const DEFAULT_URL =
  process.env.PROMETHEUS_URL ||
  "https://thanos-querier.openshift-monitoring.svc:9091";

let _tk = null;
async function getLocalToken() {
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

// Discovered Thanos routes, keyed by the remote cluster's API URL.
const _routeCache = new Map();

/**
 * Resolve the Thanos endpoint and credential for the cluster in context.
 *
 * For a remote cluster the in-cluster service name is unreachable, so we ask
 * that cluster for its own `thanos-querier` Route — ocpGet is already
 * cluster-aware, so this reads from the right place.
 */
async function resolveTarget(explicitUrl) {
  const remote = activeClusterContext();
  if (explicitUrl) return { url: explicitUrl, token: remote?.token || (await getLocalToken()) };
  if (!remote || !remote.apiUrl) return { url: DEFAULT_URL, token: await getLocalToken() };

  const key = remote.apiUrl;
  if (_routeCache.has(key)) return { url: _routeCache.get(key), token: remote.token };

  let host = null;
  try {
    const r = await ocpGet("/apis/route.openshift.io/v1/namespaces/openshift-monitoring/routes/thanos-querier");
    host = r?.spec?.host || null;
  } catch { /* fall through to the derived guess */ }

  if (!host) {
    // Derive from the API URL: api.<base>:6443 -> thanos-querier-openshift-monitoring.apps.<base>
    const m = /^https?:\/\/api\.([^:/]+)/i.exec(remote.apiUrl);
    if (m) host = `thanos-querier-openshift-monitoring.apps.${m[1]}`;
  }
  if (!host) {
    throw new Error(
      `Cannot determine the Thanos endpoint for this cluster. The in-cluster service name is only reachable from inside the cluster. `
      + `Grant the service account read access to routes in openshift-monitoring, or set PROMETHEUS_URL.`);
  }
  const url = `https://${host}`;
  _routeCache.set(key, url);
  return { url, token: remote.token };
}

export async function promQuery(query, { url = null } = {}) {
  const { url: base, token: tk } = await resolveTarget(url);
  const endpoint = `${base}/api/v1/query?query=${encodeURIComponent(query)}`;
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
  const { url: base, token: tk } = await resolveTarget(null);
  const endpoint =
    `${base}/api/v1/query_range?` +
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
