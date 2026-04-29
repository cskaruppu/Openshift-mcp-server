/**
 * OpenShift / Kubernetes API client utility.
 * Uses the native fetch API (Node 18+) to talk to the cluster API server.
 *
 * Trace support: callers can push a `trace` array into AsyncLocalStorage via
 * `runWithTrace()`. Every ocpFetch() call records an entry the response
 * handler can render as a "How I gathered this" block.
 */

import { readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";

const OPENSHIFT_API_URL =
  process.env.OPENSHIFT_API_URL ||
  `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;

// ---------------------------------------------------------------------------
// Per-request trace (explainability + audit)
// ---------------------------------------------------------------------------
const traceStore = new AsyncLocalStorage();

/** Run `fn` with a fresh trace array so ocpFetch() entries are collected. */
export async function runWithTrace(fn) {
  const trace = [];
  return await traceStore.run(trace, async () => {
    const result = await fn();
    return { result, trace };
  });
}

/** Get the current trace array (or null if no trace context is active). */
export function getTrace() {
  return traceStore.getStore() || null;
}

/** Convert a trace entry into an equivalent `oc` command for display. */
export function traceToOcCommand(entry) {
  const m = entry.method || "GET";
  const path = entry.path || "";
  // Parse /api/v1/namespaces/X/pods[/Y][?query]
  const [cleanPath, query = ""] = path.split("?");
  const parts = cleanPath.split("/").filter(Boolean);
  let ns = null;
  const nsIdx = parts.indexOf("namespaces");
  if (nsIdx >= 0 && parts[nsIdx + 1]) ns = parts[nsIdx + 1];
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  let resource = null;
  let name = null;
  // Known resource words
  const knownRes = new Set([
    "pods","deployments","services","configmaps","secrets","serviceaccounts",
    "events","statefulsets","daemonsets","replicasets","jobs","cronjobs",
    "persistentvolumeclaims","persistentvolumes","ingresses","routes","nodes",
    "namespaces","projects","clusteroperators","clusterversions","endpoints",
  ]);
  if (knownRes.has(last)) {
    resource = last;
  } else if (knownRes.has(secondLast)) {
    resource = secondLast;
    name = last;
  }
  const qs = new URLSearchParams(query);
  const label = qs.get("labelSelector");
  const field = qs.get("fieldSelector");
  let cmd;
  if (m === "GET") {
    cmd = `oc get ${resource || "<resource>"}${name ? " " + name : ""}${ns ? " -n " + ns : ""}`;
    if (label) cmd += ` -l ${label}`;
    if (field) cmd += ` --field-selector=${field}`;
  } else if (m === "DELETE") {
    cmd = `oc delete ${resource || "<resource>"} ${name || "<name>"}${ns ? " -n " + ns : ""}`;
  } else if (m === "PATCH") {
    cmd = `oc patch ${resource || "<resource>"} ${name || "<name>"}${ns ? " -n " + ns : ""} --type=strategic -p '<patch>'`;
  } else if (m === "POST") {
    cmd = `oc create -f - # ${resource || ""}`;
  } else {
    cmd = `${m} ${path}`;
  }
  return {
    cmd,
    status: entry.status,
    durationMs: entry.durationMs,
    resource,
    name,
    namespace: ns,
  };
}

/** Render the trace as a markdown <details> block. */
export function renderTraceMarkdown(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return "";
  const commands = trace.map(traceToOcCommand);
  const uniq = [];
  const seen = new Set();
  for (const c of commands) {
    if (seen.has(c.cmd)) continue;
    seen.add(c.cmd);
    uniq.push(c);
  }
  const total = trace.length;
  const lines = [
    `<details><summary>How I gathered this (${total} API call${total === 1 ? "" : "s"})</summary>`,
    "",
    "```",
    ...uniq.map((c) => c.cmd),
    "```",
    "",
    "</details>",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Remote cluster override — allows routing all ocpFetch() calls to a remote
// cluster without changing hundreds of call sites.
// ---------------------------------------------------------------------------
let _remoteClusterOverride = null;

/**
 * Set a remote cluster override so subsequent ocpFetch() calls target
 * the given apiUrl/token instead of the local cluster.
 */
export function setRemoteCluster(apiUrl, token) {
  _remoteClusterOverride = { apiUrl, token };
}

/** Clear the remote cluster override, reverting to the local cluster. */
export function clearRemoteCluster() {
  _remoteClusterOverride = null;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
let _cachedToken = null;

function clearCachedToken() { _cachedToken = null; }

async function token() {
  if (_cachedToken) return _cachedToken;
  if (process.env.OPENSHIFT_TOKEN) {
    _cachedToken = process.env.OPENSHIFT_TOKEN;
    return _cachedToken;
  }
  try {
    _cachedToken = (
      await readFile(
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "utf8"
      )
    ).trim();
  } catch {
    _cachedToken = null;
  }
  return _cachedToken;
}

/**
 * Make an authenticated request to the OpenShift / K8s API.
 */
const OCP_FETCH_TIMEOUT_MS = parseInt(process.env.OCP_FETCH_TIMEOUT_MS || "15000", 10);

export async function ocpFetch(path, options = {}) {
  // When a remote cluster override is active, route to that cluster instead.
  const remote = _remoteClusterOverride;
  const baseUrl = remote ? remote.apiUrl : OPENSHIFT_API_URL;
  const tk = remote ? remote.token : await token();
  const url = `${baseUrl}${path}`;
  const method = (options.method || "GET").toUpperCase();
  const startedAt = Date.now();
  const acceptHdr = options.headers && options.headers.Accept;
  const acceptsText = acceptHdr === "text/plain" || acceptHdr === "*/*";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || OCP_FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${tk}`,
        Accept: acceptsText ? "text/plain" : "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
  const durationMs = Date.now() - startedAt;
  const trace = getTrace();
  if (trace) {
    trace.push({ method, path, status: resp.status, durationMs });
  }
  if (resp.status === 401 && !options._retried) {
    clearCachedToken();
    return ocpFetch(path, { ...options, _retried: true });
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OCP API ${resp.status}: ${body.slice(0, 500)}`);
  }
  if (acceptsText) return resp.text();
  return resp.json();
}

/** Shorthand GET */
export async function ocpGet(path) {
  return ocpFetch(path);
}

/** Shorthand PATCH (strategic merge by default) */
export async function ocpPatch(path, body, contentType = "application/strategic-merge-patch+json") {
  return ocpFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": contentType },
    body: JSON.stringify(body),
  });
}

/** Shorthand DELETE */
export async function ocpDelete(path) {
  return ocpFetch(path, { method: "DELETE" });
}

/** Shorthand POST */
export async function ocpPost(path, body) {
  return ocpFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * SelfSubjectAccessReview — ask the API server if our service account can
 * perform an action. Used for RBAC preflight before queueing mutations.
 *
 * Returns `{ allowed, reason }`. Swallows errors and returns allowed:true
 * so misconfigured RBAC paths don't block the chat.
 */
export async function canI({ verb, group = "", resource, namespace = "", name = "" }) {
  try {
    const body = {
      kind: "SelfSubjectAccessReview",
      apiVersion: "authorization.k8s.io/v1",
      spec: {
        resourceAttributes: {
          verb,
          group,
          resource,
          namespace,
          name,
        },
      },
    };
    const r = await ocpFetch("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return {
      allowed: r?.status?.allowed === true,
      reason: r?.status?.reason || "",
    };
  } catch (err) {
    // If the check itself fails, assume allowed to avoid blocking legitimate
    // operations — the real call will surface the error.
    return { allowed: true, reason: `preflight-error:${err.message}` };
  }
}

/**
 * Make an authenticated request to a remote OpenShift / K8s API.
 * Like ocpFetch but targets apiUrl instead of the local OPENSHIFT_API_URL
 * and uses the provided bearerToken instead of the local SA token.
 */
export async function remoteOcpFetch(apiUrl, bearerToken, path, options = {}) {
  const url = `${apiUrl}${path}`;
  const method = (options.method || "GET").toUpperCase();
  const startedAt = Date.now();
  const acceptHdr = options.headers && options.headers.Accept;
  const acceptsText = acceptHdr === "text/plain" || acceptHdr === "*/*";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || OCP_FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: acceptsText ? "text/plain" : "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
  const durationMs = Date.now() - startedAt;
  const trace = getTrace();
  if (trace) {
    trace.push({ method, path, status: resp.status, durationMs, remote: apiUrl });
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Remote OCP API ${resp.status}: ${body.slice(0, 500)}`);
  }
  if (acceptsText) return resp.text();
  return resp.json();
}

/** Shorthand GET against a remote cluster. */
export async function remoteOcpGet(apiUrl, bearerToken, path) {
  return remoteOcpFetch(apiUrl, bearerToken, path);
}

export function getApiUrl() {
  return OPENSHIFT_API_URL;
}
