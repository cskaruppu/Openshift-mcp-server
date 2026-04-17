/**
 * Multi-cluster context switching — manage multiple kubeconfig contexts
 * and switch the active cluster connection at runtime.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

let _contexts = [];
let _activeContext = null;
let _kubeconfigPath = null;

function defaultKubeconfigPath() {
  return process.env.KUBECONFIG || join(homedir(), ".kube", "config");
}

export async function loadKubeconfig(path) {
  _kubeconfigPath = path || defaultKubeconfigPath();

  if (!existsSync(_kubeconfigPath)) {
    _contexts = [];
    _activeContext = null;
    return { contexts: [], activeContext: null };
  }

  try {
    const raw = await readFile(_kubeconfigPath, "utf8");
    const config = parseKubeconfig(raw);
    _contexts = config.contexts || [];
    _activeContext = config.currentContext || null;
    return { contexts: _contexts, activeContext: _activeContext };
  } catch (err) {
    console.error(`[multi-cluster] Failed to load kubeconfig: ${err.message}`);
    return { contexts: [], activeContext: null };
  }
}

function parseKubeconfig(raw) {
  const lines = raw.split("\n");
  const config = { contexts: [], clusters: [], currentContext: null };
  let inContexts = false;
  let inClusters = false;
  let currentItem = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    if (trimmed.startsWith("current-context:")) {
      config.currentContext = trimmed.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "");
      continue;
    }

    if (trimmed === "contexts:") { inContexts = true; inClusters = false; continue; }
    if (trimmed === "clusters:") { inClusters = true; inContexts = false; continue; }
    if (trimmed === "users:" || trimmed === "preferences:") { inContexts = false; inClusters = false; continue; }

    if (inContexts) {
      if (trimmed.startsWith("- name:")) {
        if (currentItem) config.contexts.push(currentItem);
        currentItem = { name: trimmed.replace("- name:", "").trim().replace(/^["']|["']$/g, ""), cluster: null, namespace: null, user: null };
      } else if (currentItem) {
        const kv = trimmed.trim();
        if (kv.startsWith("cluster:")) currentItem.cluster = kv.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "");
        if (kv.startsWith("namespace:")) currentItem.namespace = kv.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "");
        if (kv.startsWith("user:")) currentItem.user = kv.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "");
      }
    }

    if (inClusters) {
      if (trimmed.startsWith("- name:")) {
        const clusterName = trimmed.replace("- name:", "").trim().replace(/^["']|["']$/g, "");
        config.clusters.push({ name: clusterName, server: null });
      } else if (config.clusters.length > 0) {
        const kv = trimmed.trim();
        if (kv.startsWith("server:")) {
          config.clusters[config.clusters.length - 1].server = kv.split("server:").slice(1).join("server:").trim().replace(/^["']|["']$/g, "");
        }
      }
    }
  }
  if (currentItem && inContexts) config.contexts.push(currentItem);

  for (const ctx of config.contexts) {
    const cl = config.clusters.find(c => c.name === ctx.cluster);
    if (cl) ctx.server = cl.server;
  }

  return config;
}

export function listContexts() {
  return _contexts.map(ctx => ({
    name: ctx.name,
    cluster: ctx.cluster,
    namespace: ctx.namespace || "default",
    server: ctx.server || null,
    active: ctx.name === _activeContext,
  }));
}

export function getActiveContext() {
  if (!_activeContext) return null;
  const ctx = _contexts.find(c => c.name === _activeContext);
  if (!ctx) return { name: _activeContext };
  return {
    name: ctx.name,
    cluster: ctx.cluster,
    namespace: ctx.namespace || "default",
    server: ctx.server || null,
  };
}

export function switchContext(contextName) {
  const ctx = _contexts.find(c => c.name === contextName);
  if (!ctx) {
    return { success: false, error: `Context '${contextName}' not found. Available: ${_contexts.map(c => c.name).join(", ")}` };
  }
  const previous = _activeContext;
  _activeContext = contextName;

  if (ctx.server) {
    process.env.OPENSHIFT_API_URL = ctx.server;
  }

  return {
    success: true,
    previous,
    current: contextName,
    server: ctx.server || null,
    namespace: ctx.namespace || "default",
  };
}

export function registerMultiClusterTools(server) {

  server.tool(
    "cluster_list_contexts",
    "List all available kubeconfig contexts",
    {},
    async () => {
      if (_contexts.length === 0) {
        await loadKubeconfig();
      }
      const contexts = listContexts();
      if (contexts.length === 0) {
        return { content: [{ type: "text", text: "No kubeconfig contexts found. Set KUBECONFIG or ensure ~/.kube/config exists." }] };
      }
      const lines = ["### Available Cluster Contexts\n", "| Name | Cluster | Namespace | Server | Active |", "|---|---|---|---|---|"];
      for (const c of contexts) {
        lines.push(`| ${c.name} | ${c.cluster || "-"} | ${c.namespace} | ${c.server || "-"} | ${c.active ? "[ACTIVE]" : ""} |`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "cluster_get_active_context",
    "Show the currently active cluster context",
    {},
    async () => {
      if (_contexts.length === 0) await loadKubeconfig();
      const ctx = getActiveContext();
      if (!ctx) {
        return { content: [{ type: "text", text: "No active context set." }] };
      }
      return {
        content: [{
          type: "text",
          text: `### Active Context: \`${ctx.name}\`\n\n**Cluster:** ${ctx.cluster || "-"}\n**Namespace:** ${ctx.namespace}\n**Server:** ${ctx.server || "-"}`,
        }],
      };
    }
  );

  server.tool(
    "cluster_switch_context",
    "Switch to a different cluster context",
    { contextName: z.string() },
    async ({ contextName }) => {
      if (_contexts.length === 0) await loadKubeconfig();
      const result = switchContext(contextName);
      if (!result.success) {
        return { content: [{ type: "text", text: `Failed to switch context: ${result.error}` }] };
      }
      return {
        content: [{
          type: "text",
          text: `### Context Switched\n\n**From:** \`${result.previous || "(none)"}\`\n**To:** \`${result.current}\`\n**Server:** ${result.server || "-"}\n**Default Namespace:** ${result.namespace}`,
        }],
      };
    }
  );
}
