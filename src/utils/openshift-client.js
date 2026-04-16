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
// Auth
// ---------------------------------------------------------------------------
let _cachedToken = null;
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
export async function ocpFetch(path, options = {}) {
  const tk = await token();
  const url = `${OPENSHIFT_API_URL}${path}`;
  const method = (options.method || "GET").toUpperCase();
  const startedAt = Date.now();
  const acceptsText = options.headers && options.headers.Accept === "text/plain";
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${tk}`,
      Accept: acceptsText ? "text/plain" : "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const durationMs = Date.now() - startedAt;
  const trace = getTrace();
  if (trace) {
    trace.push({ method, path, status: resp.status, durationMs });
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OCP API ${resp.status}: ${body}`);
  }
  if (acceptsText) return resp.text();
  return resp.json();
}

/** Shorthand GET */
export async function ocpGet(path) {
  return ocpFetch(path);
}

/** Shorthand PATCH (strategic merge) */
export async function ocpPatch(path, body) {
  return ocpFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/strategic-merge-patch+json" },
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

export function getApiUrl() {
  return OPENSHIFT_API_URL;
}
