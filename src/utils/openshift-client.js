/**
 * OpenShift / Kubernetes API client utility.
 * Uses the native fetch API (Node 18+) to talk to the cluster API server.
 */

import { readFile } from "node:fs/promises";

const OPENSHIFT_API_URL =
  process.env.OPENSHIFT_API_URL ||
  `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;

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
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${tk}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
    // Allow self-signed certs inside the cluster
    ...(process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
      ? {}
      : {}),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OCP API ${resp.status}: ${body}`);
  }
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

export function getApiUrl() {
  return OPENSHIFT_API_URL;
}
