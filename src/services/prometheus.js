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
 * Candidate Thanos endpoints for the cluster in context, best first.
 *
 * The in-cluster Service name is tried FIRST, always. A pod frequently cannot
 * resolve its own cluster's *.apps wildcard — cluster DNS forwards it to a
 * resolver that has no record for it — so assuming a "remote" cluster context
 * means "use the Route" was wrong: the server may well be running inside the
 * very cluster being queried. The Route is the fallback for genuinely remote
 * clusters, and whichever answers first is cached.
 */
async function candidateTargets() {
  const remote = activeClusterContext();
  const token = remote?.token || (await getLocalToken());
  const out = [{ url: DEFAULT_URL, token, why: "in-cluster service" }];

  if (remote?.apiUrl) {
    let host = null;
    try {
      const r = await ocpGet("/apis/route.openshift.io/v1/namespaces/openshift-monitoring/routes/thanos-querier");
      host = r?.spec?.host || null;
    } catch { /* fall through to the derived form */ }
    if (!host) {
      const m = /^https?:\/\/api\.([^:/]+)/i.exec(remote.apiUrl);
      if (m) host = `thanos-querier-openshift-monitoring.apps.${m[1]}`;
    }
    if (host) out.push({ url: `https://${host}`, token, why: "cluster route" });
  }
  return out;
}

async function resolveTarget(explicitUrl) {
  const remote = activeClusterContext();
  if (explicitUrl) return [{ url: explicitUrl, token: remote?.token || (await getLocalToken()), why: "configured" }];
  const key = remote?.apiUrl || "__local__";
  const cached = _routeCache.get(key);
  if (cached) return [cached];
  return await candidateTargets();
}

/** Remember whichever endpoint actually answered, so we stop probing. */
function rememberWorking(target) {
  const remote = activeClusterContext();
  _routeCache.set(remote?.apiUrl || "__local__", target);
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
    ENOTFOUND: /\.svc(:|$)/.test(host)
      ? `Cannot resolve ${host}. That in-cluster name only works from inside the target cluster — this server is elsewhere, so it needs the cluster's Route (which requires read access to routes in openshift-monitoring) or an explicit PROMETHEUS_URL.`
      : `Cannot resolve ${host}. A pod usually cannot resolve its own cluster's *.apps wildcard, because cluster DNS forwards it to a resolver that has no record for it. If this server runs inside the target cluster, the in-cluster service name is the right endpoint; otherwise add a DNS record or set PROMETHEUS_URL.`,
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
  const targets = await resolveTarget(url);
  const agent = await getAgent();
  let resp, base, tk, lastErr = null;

  // Try each candidate in order. A DNS failure on one is not a verdict on the
  // cluster — it usually just means we guessed the wrong door.
  for (const cand of targets) {
    const ep = `${cand.url}/api/v1/query?query=${encodeURIComponent(query)}`;
    try {
      resp = await undiciFetch(ep, {
        headers: cand.token ? { Authorization: `Bearer ${cand.token}` } : {},
        dispatcher: agent,
      });
      base = cand.url; tk = cand.token;
      rememberWorking(cand);
      break;
    } catch (e) {
      lastErr = explain(e, ep);
      lastErr.message = `${lastErr.message} [tried the ${cand.why}]`;
    }
  }
  if (!resp) throw lastErr || new Error("No reachable metrics endpoint for this cluster.");
  const endpoint = `${base}/api/v1/query?query=${encodeURIComponent(query)}`;
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
  const targets = await resolveTarget(null);
  const agent = await getAgent();
  const qs = `query=${encodeURIComponent(query)}&start=${startTs}&end=${endTs}&step=${step}`;
  let resp, endpoint, lastErr = null;
  for (const cand of targets) {
    endpoint = `${cand.url}/api/v1/query_range?${qs}`;
    try {
      resp = await undiciFetch(endpoint, {
        headers: cand.token ? { Authorization: `Bearer ${cand.token}` } : {},
        dispatcher: agent,
      });
      rememberWorking(cand);
      break;
    } catch (e) { lastErr = explain(e, endpoint); }
  }
  if (!resp) throw lastErr || new Error("No reachable metrics endpoint for this cluster.");
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
