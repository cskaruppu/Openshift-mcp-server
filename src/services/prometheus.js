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
import { Agent, fetch as undiciFetch } from "undici";
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

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------
// Thanos is served on an OpenShift *service serving certificate*, which is
// signed by the service-ca operator — NOT by the kube root CA that
// NODE_EXTRA_CA_CERTS points at. Node therefore rejects it and undici reports
// the useless string "fetch failed". Trust both bundles explicitly.
//
// A remote cluster reached over its Route presents an ingress certificate this
// process has no way to know, so PROMETHEUS_INSECURE=true is offered for lab
// use. It is off by default and never silently enabled.
const CA_FILES = [
  process.env.PROMETHEUS_CA_FILE,
  "/etc/service-ca/service-ca.crt",
  "/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt",
  "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
].filter(Boolean);

let _agent = null;
async function getAgent() {
  if (_agent) return _agent;
  const ca = [];
  for (const f of CA_FILES) {
    try { ca.push(await readFile(f, "utf8")); } catch { /* not mounted here */ }
  }
  const insecure = process.env.PROMETHEUS_INSECURE === "true";
  _agent = new Agent({
    connect: {
      timeout: 15_000,
      ...(insecure ? { rejectUnauthorized: false } : {}),
      ...(ca.length && !insecure ? { ca } : {}),
    },
  });
  if (insecure) console.error("[prometheus] PROMETHEUS_INSECURE=true — TLS verification disabled for metrics queries");
  return _agent;
}

/**
 * Turn undici's opaque failures into something an operator can act on.
 * "fetch failed" is not a diagnosis.
 */
function explain(e, endpoint) {
  const code = e?.cause?.code || e?.code;
  const host = (() => { try { return new URL(endpoint).host; } catch { return endpoint; } })();
  const MAP = {
    ENOTFOUND: `DNS lookup failed for ${host}. This server cannot resolve the cluster's route domain.`,
    EAI_AGAIN: `DNS lookup timed out for ${host}.`,
    ECONNREFUSED: `Connection refused by ${host}.`,
    ECONNRESET: `Connection reset by ${host}.`,
    UND_ERR_CONNECT_TIMEOUT: `Timed out connecting to ${host} — usually egress from this cluster is blocked.`,
    CERT_HAS_EXPIRED: `The TLS certificate presented by ${host} has expired.`,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: `TLS certificate from ${host} is not trusted by this server. For an OpenShift Route on an internal domain, set PROMETHEUS_CA_FILE to that cluster's ingress CA, or PROMETHEUS_INSECURE=true in a lab.`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `${host} presents a self-signed certificate. Set PROMETHEUS_CA_FILE, or PROMETHEUS_INSECURE=true in a lab.`,
    SELF_SIGNED_CERT_IN_CHAIN: `The certificate chain from ${host} is self-signed. Set PROMETHEUS_CA_FILE, or PROMETHEUS_INSECURE=true in a lab.`,
  };
  const detail = MAP[code] || `${e?.message || "request failed"}${code ? ` (${code})` : ""} against ${host}`;
  const err = new Error(detail);
  err.code = code || null;
  err.endpoint = endpoint;
  return err;
}

export async function promQuery(query, { url = null } = {}) {
  const { url: base, token: tk } = await resolveTarget(url);
  const endpoint = `${base}/api/v1/query?query=${encodeURIComponent(query)}`;
  let resp;
  try {
    resp = await undiciFetch(endpoint, {
      headers: tk ? { Authorization: `Bearer ${tk}` } : {},
      dispatcher: await getAgent(),
    });
  } catch (e) { throw explain(e, endpoint); }
  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Metrics query rejected (HTTP ${resp.status}). The credential for this cluster needs the cluster-monitoring-view role: `
        + `oc adm policy add-cluster-role-to-user cluster-monitoring-view <user-or-sa>`);
    }
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
  let resp;
  try {
    resp = await undiciFetch(endpoint, {
      headers: tk ? { Authorization: `Bearer ${tk}` } : {},
      dispatcher: await getAgent(),
    });
  } catch (e) { throw explain(e, endpoint); }
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
