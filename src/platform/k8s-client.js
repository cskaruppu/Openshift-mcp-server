/**
 * Generic Kubernetes API Client
 *
 * Platform-agnostic REST client that works with any K8s distribution
 * via kubeconfig or in-cluster ServiceAccount token. Uses the same
 * undici connection pooling pattern as openshift-client.js but with
 * multi-cluster awareness.
 *
 * This does NOT replace openshift-client.js — when the detected platform
 * is OpenShift, the existing ocpGet/ocpFetch is used directly.
 */

import { readFile } from "node:fs/promises";
import { Agent, fetch as undiciFetch } from "undici";
import { execSync } from "node:child_process";

const k8sAgent = new Agent({
  connect: { rejectUnauthorized: false, timeout: 15_000 },
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  pipelining: 1,
  connections: 20,
});

const K8S_FETCH_TIMEOUT_MS = parseInt(process.env.K8S_FETCH_TIMEOUT_MS || "15000", 10);

let _clusterConfig = null;

const _getCache = new Map();
const GET_CACHE_TTL_MS = 5_000;

/**
 * Load cluster connection info from multiple sources.
 * Priority: env vars > kubeconfig > in-cluster SA token
 */
async function loadClusterConfig() {
  if (_clusterConfig) return _clusterConfig;

  // 1. Explicit env vars
  if (process.env.K8S_API_URL && process.env.K8S_TOKEN) {
    _clusterConfig = {
      apiUrl: process.env.K8S_API_URL.replace(/\/$/, ""),
      token: process.env.K8S_TOKEN,
      source: "env",
    };
    return _clusterConfig;
  }

  // 2. Kubeconfig file
  const kubeconfigPath = process.env.KUBECONFIG || `${process.env.HOME}/.kube/config`;
  try {
    const raw = await readFile(kubeconfigPath, "utf8");
    const config = parseKubeconfig(raw);
    if (config) {
      _clusterConfig = { ...config, source: "kubeconfig" };
      return _clusterConfig;
    }
  } catch {
    // No kubeconfig
  }

  // 3. In-cluster ServiceAccount
  try {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT;
    if (host && port) {
      const token = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
      _clusterConfig = {
        apiUrl: `https://${host}:${port}`,
        token,
        source: "in-cluster",
      };
      return _clusterConfig;
    }
  } catch {
    // Not in-cluster
  }

  // 4. Try kubectl/oc for current context
  try {
    const server = execSync("kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'", { encoding: "utf8" }).replace(/'/g, "").trim();
    const token = execSync("kubectl config view --minify -o jsonpath='{.users[0].user.token}'", { encoding: "utf8" }).replace(/'/g, "").trim();
    if (server) {
      _clusterConfig = {
        apiUrl: server.replace(/\/$/, ""),
        token: token || null,
        source: "kubectl",
      };
      return _clusterConfig;
    }
  } catch {
    // No kubectl
  }

  return null;
}

function parseKubeconfig(raw) {
  try {
    const lines = raw.split("\n");
    let currentContext = "";
    let clusters = {};
    let users = {};
    let contexts = {};
    let section = "";
    let currentName = "";
    let indent = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "current-context:" || trimmed.startsWith("current-context:")) {
        currentContext = trimmed.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "");
      }
    }

    // Simple YAML parser for kubeconfig — extract server + token for current context
    // For production, a proper YAML parser would be used
    const yaml = raw;
    const ctxMatch = yaml.match(new RegExp(`name:\\s*["']?${escapeRegex(currentContext)}["']?\\s*\\n\\s*context:[\\s\\S]*?cluster:\\s*([^\\n]+)`, "m"));
    const clusterName = ctxMatch ? ctxMatch[1].trim() : "";
    const userMatch = yaml.match(new RegExp(`name:\\s*["']?${escapeRegex(currentContext)}["']?\\s*\\n\\s*context:[\\s\\S]*?user:\\s*([^\\n]+)`, "m"));
    const userName = userMatch ? userMatch[1].trim() : "";

    const serverMatch = yaml.match(new RegExp(`name:\\s*["']?${escapeRegex(clusterName)}["']?\\s*\\n\\s*cluster:[\\s\\S]*?server:\\s*([^\\n]+)`, "m"));
    const server = serverMatch ? serverMatch[1].trim() : "";

    const tokenMatch = yaml.match(new RegExp(`name:\\s*["']?${escapeRegex(userName)}["']?\\s*\\n\\s*user:[\\s\\S]*?token:\\s*([^\\n]+)`, "m"));
    const token = tokenMatch ? tokenMatch[1].trim() : "";

    if (server) {
      return { apiUrl: server.replace(/\/$/, ""), token: token || null, context: currentContext };
    }
  } catch {
    // Parse error
  }
  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Make an authenticated GET/POST/PATCH/DELETE to the K8s API.
 */
async function k8sFetch(path, options = {}) {
  const config = await loadClusterConfig();
  if (!config) throw new Error("No Kubernetes cluster configuration found");

  const url = `${config.apiUrl}${path}`;
  const method = (options.method || "GET").toUpperCase();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || K8S_FETCH_TIMEOUT_MS);

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  let resp;
  try {
    resp = await undiciFetch(url, {
      ...options,
      method,
      signal: controller.signal,
      dispatcher: k8sAgent,
      headers,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`K8s API ${resp.status}: ${body.slice(0, 500)}`);
  }

  const acceptHdr = options.headers?.Accept;
  if (acceptHdr === "text/plain" || acceptHdr === "*/*") return resp.text();
  return resp.json();
}

async function k8sGet(path) {
  const now = Date.now();
  const cached = _getCache.get(path);
  if (cached && now - cached.ts < GET_CACHE_TTL_MS) return cached.data;
  const data = await k8sFetch(path);
  _getCache.set(path, { data, ts: now });
  if (_getCache.size > 200) {
    for (const [k, v] of _getCache) {
      if (now - v.ts > GET_CACHE_TTL_MS) _getCache.delete(k);
    }
  }
  return data;
}

async function k8sPost(path, body) {
  return k8sFetch(path, { method: "POST", body: JSON.stringify(body) });
}

async function k8sPatch(path, body, patchType = "strategic-merge-patch+json") {
  return k8sFetch(path, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": `application/${patchType}` },
  });
}

async function k8sDelete(path) {
  return k8sFetch(path, { method: "DELETE" });
}

function clearClusterConfig() {
  _clusterConfig = null;
}

function getClusterConfig() {
  return _clusterConfig ? { ..._clusterConfig } : null;
}

export {
  loadClusterConfig,
  clearClusterConfig,
  getClusterConfig,
  k8sFetch,
  k8sGet,
  k8sPost,
  k8sPatch,
  k8sDelete,
};
