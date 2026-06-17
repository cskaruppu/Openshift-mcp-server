/**
 * Cluster Credentials — direct-access pattern.
 *
 * Stores OCP API URLs + service account tokens in the DB so the control plane
 * can call any cluster's API directly. Replaces the bridge/spoke proxy pattern
 * for cluster-to-cluster communication.
 *
 * Credentials are cached in memory for fast lookup and refreshed from DB
 * on every write or at startup.
 */

import { query, isEnabled as dbEnabled } from "./db.js";
import { withRemoteCluster } from "./openshift-client.js";

const _cache = new Map();

export async function loadAll() {
  if (!(await dbEnabled())) return;
  try {
    const res = await query("SELECT cluster_name, api_url, token, platform, display_name FROM cluster_credentials");
    if (!res?.rows) return;
    _cache.clear();
    for (const row of res.rows) {
      _cache.set(row.cluster_name.toLowerCase(), {
        clusterName: row.cluster_name,
        apiUrl: row.api_url.replace(/\/+$/, ""),
        token: row.token,
        platform: row.platform || "openshift",
        displayName: row.display_name || row.cluster_name,
      });
    }
    console.log(`[cluster-creds] Loaded ${_cache.size} cluster credential(s) from DB`);
  } catch (err) {
    console.warn("[cluster-creds] Failed to load:", err.message);
  }
}

export async function upsert(clusterName, apiUrl, token, platform = "openshift", displayName = "") {
  const cleanUrl = apiUrl.replace(/\/+$/, "");
  _cache.set(clusterName.toLowerCase(), {
    clusterName,
    apiUrl: cleanUrl,
    token,
    platform,
    displayName: displayName || clusterName,
  });
  if (!(await dbEnabled())) return null;
  const res = await query(
    `INSERT INTO cluster_credentials (cluster_name, api_url, token, platform, display_name, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (cluster_name) DO UPDATE
       SET api_url = $2, token = $3, platform = $4, display_name = $5, updated_at = NOW()
     RETURNING *`,
    [clusterName, cleanUrl, token, platform, displayName || clusterName]
  );
  return res?.rows?.[0] || null;
}

export async function remove(clusterName) {
  _cache.delete(clusterName.toLowerCase());
  if (!(await dbEnabled())) return false;
  const res = await query("DELETE FROM cluster_credentials WHERE cluster_name = $1", [clusterName]);
  return res?.rowCount > 0;
}

export async function list() {
  if (_cache.size === 0) await loadAll();
  return Array.from(_cache.values()).map(({ clusterName, apiUrl, platform, displayName }) => ({
    clusterName,
    apiUrl,
    platform,
    displayName,
  }));
}

export function getCredentials(clusterName) {
  if (!clusterName) return null;
  return _cache.get(clusterName.toLowerCase()) || null;
}

export function hasCredentials(clusterName) {
  if (!clusterName) return false;
  return _cache.has(clusterName.toLowerCase());
}

/**
 * Run `fn` with all ocpGet/ocpFetch calls routed to the given cluster
 * using stored credentials. Returns fn's result.
 * Throws if no credentials found for the cluster.
 */
export function withClusterDirect(clusterName, fn) {
  if (!clusterName || clusterName === "local") return fn();
  const creds = getCredentials(clusterName);
  if (!creds) {
    throw new Error(`No credentials stored for cluster "${clusterName}". Register it via Settings → Clusters.`);
  }
  return withRemoteCluster(creds.apiUrl, creds.token, fn);
}
