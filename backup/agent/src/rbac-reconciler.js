/**
 * RBAC Reconciler — self-updates the agent's ClusterRole when the hub
 * pushes new rules via the SSE bridge or during registration.
 *
 * Pattern: Agent fetches the desired ClusterRole rules from the hub,
 * compares with the current ClusterRole in-cluster, and patches if different.
 * This is the same self-modification pattern used by Kubernetes operators.
 */

import { readFile } from "node:fs/promises";

const CLUSTER_ROLE_NAME = "tcs-agentic-ai-role";
const API_URL = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
  : process.env.API_SERVER_URL || "https://kubernetes.default.svc";

let _token = null;

async function loadToken() {
  if (_token) return _token;
  try {
    _token = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
  } catch {
    _token = process.env.BEARER_TOKEN || null;
  }
  return _token;
}

function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`${ts} [${level.toUpperCase()}] [rbac-reconciler]`, ...args);
}

async function k8sRequest(method, path, body) {
  const tk = await loadToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const opts = {
      method,
      signal: controller.signal,
      headers: {
        Authorization: tk ? `Bearer ${tk}` : undefined,
        Accept: "application/json",
      },
    };
    if (body) {
      opts.headers["Content-Type"] = method === "PATCH"
        ? "application/strategic-merge-patch+json"
        : "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${API_URL}${path}`, opts);
    const data = await resp.json().catch(() => null);
    return { ok: resp.ok, status: resp.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function rulesEqual(current, desired) {
  return JSON.stringify(current) === JSON.stringify(desired);
}

/**
 * Fetch the desired RBAC rules from the hub server.
 */
async function fetchDesiredRules(hubUrl, clusterName, platform) {
  try {
    const actions = process.env.ALLOW_REMOTE_ACTIONS === "true" ? "&actions=true" : "";
    const resp = await fetch(
      `${hubUrl}/api/agent/rbac-manifest?cluster=${encodeURIComponent(clusterName)}&platform=${encodeURIComponent(platform)}${actions}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!resp.ok) {
      log("warn", `Hub returned ${resp.status} for RBAC manifest`);
      return null;
    }
    const data = await resp.json();
    return data.rules || null;
  } catch (err) {
    log("error", `Failed to fetch RBAC manifest from hub: ${err.message}`);
    return null;
  }
}

/**
 * Read the current ClusterRole from the in-cluster API.
 */
async function getCurrentClusterRole() {
  const resp = await k8sRequest("GET", `/apis/rbac.authorization.k8s.io/v1/clusterroles/${CLUSTER_ROLE_NAME}`);
  if (!resp.ok) {
    log("warn", `Cannot read ClusterRole ${CLUSTER_ROLE_NAME}: ${resp.status}`);
    return null;
  }
  return resp.data;
}

/**
 * Patch the ClusterRole with new rules.
 */
async function patchClusterRole(rules) {
  const resp = await k8sRequest("PATCH", `/apis/rbac.authorization.k8s.io/v1/clusterroles/${CLUSTER_ROLE_NAME}`, {
    rules,
  });
  return resp;
}

/**
 * Reconcile: compare current rules with desired, patch if different.
 */
export async function reconcileRBAC(hubUrl, clusterName, platform) {
  if (!hubUrl) {
    log("debug", "No hub URL — skipping RBAC reconciliation");
    return { action: "skipped", reason: "no-hub-url" };
  }

  log("info", "Checking RBAC rules with hub...");

  const desiredRules = await fetchDesiredRules(hubUrl, clusterName, platform);
  if (!desiredRules) {
    return { action: "skipped", reason: "no-desired-rules" };
  }

  const currentRole = await getCurrentClusterRole();
  if (!currentRole) {
    return { action: "skipped", reason: "cannot-read-clusterrole" };
  }

  const currentRules = currentRole.rules || [];

  if (rulesEqual(currentRules, desiredRules)) {
    log("info", "RBAC rules are up to date — no changes needed");
    return { action: "no-change", ruleCount: currentRules.length };
  }

  log("info", `RBAC drift detected: current=${currentRules.length} rules, desired=${desiredRules.length} rules. Patching...`);

  const result = await patchClusterRole(desiredRules);
  if (result.ok) {
    log("info", `ClusterRole "${CLUSTER_ROLE_NAME}" updated successfully (${desiredRules.length} rules)`);
    return { action: "updated", ruleCount: desiredRules.length };
  } else {
    log("error", `Failed to patch ClusterRole: ${result.status} ${JSON.stringify(result.data)}`);
    return { action: "error", status: result.status, message: result.data?.message || "unknown" };
  }
}

let _reconcileStatus = null;

export function getReconcileStatus() {
  return _reconcileStatus;
}

/**
 * Run reconciliation and store result. Called on startup and on SSE events.
 */
export async function runReconcile(hubUrl, clusterName, platform) {
  try {
    _reconcileStatus = await reconcileRBAC(hubUrl, clusterName, platform);
  } catch (err) {
    log("error", `Reconciliation failed: ${err.message}`);
    _reconcileStatus = { action: "error", message: err.message };
  }
  return _reconcileStatus;
}
