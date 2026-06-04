/**
 * Cluster-aware API client.
 *
 * Mirrors the backend contract used by the legacy dashboard:
 *   - Appends `?cluster=<id>` for any non-local cluster.
 *   - Sends the `X-Cluster-Context` header so the backend can cross-check it
 *     against the query param (defense-in-depth against context spoofing).
 *
 * The `signal` is supplied by TanStack Query, which aborts it automatically
 * when the query key changes (i.e. on cluster switch) — so requests for the
 * previous cluster are cancelled the moment the user switches.
 */

const API_BASE = ""; // same-origin; backend serves the app

export function clusterUrl(path, cluster) {
  const url = API_BASE + path;
  if (!cluster || cluster === "local") return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}cluster=${encodeURIComponent(cluster)}`;
}

export async function apiGet(path, { cluster, signal } = {}) {
  const res = await fetch(clusterUrl(path, cluster), {
    signal,
    headers: {
      "X-Cluster-Context": cluster || "local",
      Accept: "application/json",
    },
  });
  if (res.status === 401) {
    const err = new Error("Authentication required");
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ": " + body.slice(0, 200) : ""}`);
  }
  return res.json();
}
