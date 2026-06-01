/**
 * Deployer — handles rollout-restart of the agent's own Deployment.
 *
 * Triggered manually from the hub dashboard when the user has pushed
 * a new container image and wants remote agents to pick it up.
 *
 * Works by patching the Deployment's pod template annotation with a
 * timestamp, which triggers a rolling update — the same mechanism
 * as `kubectl rollout restart`.
 */

import { readFile } from "node:fs/promises";

const DEPLOYMENT_NAME = "tcs-agentic-ai";
const API_URL = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
  : process.env.API_SERVER_URL || "https://kubernetes.default.svc";

let _token = null;
let _namespace = null;

async function loadToken() {
  if (_token) return _token;
  try {
    _token = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
  } catch {
    _token = process.env.BEARER_TOKEN || null;
  }
  return _token;
}

async function loadNamespace() {
  if (_namespace) return _namespace;
  try {
    _namespace = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8")).trim();
  } catch {
    _namespace = process.env.NAMESPACE || "tcs-agentic-ai";
  }
  return _namespace;
}

function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`${ts} [${level.toUpperCase()}] [deployer]`, ...args);
}

/**
 * Trigger a rolling restart of this agent's Deployment by patching
 * the pod template's restart annotation.
 */
export async function rolloutRestart() {
  const tk = await loadToken();
  const ns = await loadNamespace();
  const path = `/apis/apps/v1/namespaces/${ns}/deployments/${DEPLOYMENT_NAME}`;

  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            "tcs-agentic-ai/restartedAt": new Date().toISOString(),
          },
        },
      },
    },
  };

  log("info", `Patching Deployment ${ns}/${DEPLOYMENT_NAME} for rollout restart...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${API_URL}${path}`, {
      method: "PATCH",
      signal: controller.signal,
      headers: {
        Authorization: tk ? `Bearer ${tk}` : undefined,
        "Content-Type": "application/strategic-merge-patch+json",
        Accept: "application/json",
      },
      body: JSON.stringify(patch),
    });

    if (resp.ok) {
      log("info", `Rollout restart triggered for ${ns}/${DEPLOYMENT_NAME}`);
      return { ok: true, deployment: DEPLOYMENT_NAME, namespace: ns };
    } else {
      const body = await resp.json().catch(() => ({}));
      log("error", `Rollout restart failed: ${resp.status} ${body.message || ""}`);
      return { ok: false, status: resp.status, message: body.message || resp.statusText };
    }
  } finally {
    clearTimeout(timer);
  }
}
