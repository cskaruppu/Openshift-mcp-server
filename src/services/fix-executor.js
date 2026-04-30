/**
 * Fix Executor — safely runs AI-suggested kubectl/oc commands against the
 * cluster via the Kubernetes API server (no shell, no kubectl binary needed).
 *
 * Supports:
 *   - Read-only: get, describe, logs, top, events
 *   - Write: delete pod, rollout restart, scale, patch, annotate, label
 *
 * Server-side dry-run is implemented via the native K8s API `?dryRun=All`
 * query parameter for write ops; read ops are inherently safe.
 *
 * Destructive ops on cluster-scoped resources (delete namespace, delete crd,
 * delete node) are blocked unconditionally to avoid catastrophic mistakes.
 */

import { ocpGet, ocpDelete, ocpPatch, ocpPost, ocpFetch, canI } from "../utils/openshift-client.js";

const BLOCKED_PATTERNS = [
  /\bdelete\s+(?:namespace|ns|crd|customresourcedefinition|node|nodes|clusterrole|clusterrolebinding|persistentvolume|pv)\b/i,
  /\b(?:cordon|drain|uncordon)\b/i,
  /\bedit\b/i,
  /\bexec\b.*\brm\b/i,
  /\bdelete\s+all\b/i,
];

const READ_ONLY_VERBS = new Set(["get", "describe", "logs", "top", "events", "explain", "config", "version", "cluster-info"]);

const RESOURCE_ALIASES = {
  po: "pods", pod: "pods", pods: "pods",
  deploy: "deployments", deployment: "deployments", deployments: "deployments",
  svc: "services", service: "services", services: "services",
  ns: "namespaces", namespace: "namespaces", namespaces: "namespaces",
  no: "nodes", node: "nodes", nodes: "nodes",
  cm: "configmaps", configmap: "configmaps", configmaps: "configmaps",
  secret: "secrets", secrets: "secrets",
  rs: "replicasets", replicaset: "replicasets", replicasets: "replicasets",
  ds: "daemonsets", daemonset: "daemonsets", daemonsets: "daemonsets",
  sts: "statefulsets", statefulset: "statefulsets", statefulsets: "statefulsets",
  job: "jobs", jobs: "jobs",
  cj: "cronjobs", cronjob: "cronjobs", cronjobs: "cronjobs",
  ev: "events", event: "events", events: "events",
  pvc: "persistentvolumeclaims", persistentvolumeclaim: "persistentvolumeclaims",
  ing: "ingresses", ingress: "ingresses", ingresses: "ingresses",
  clusterversion: "clusterversions", clusterversions: "clusterversions",
  co: "clusteroperators", clusteroperator: "clusteroperators", clusteroperators: "clusteroperators",
  machine: "machines", machines: "machines",
  machineset: "machinesets", machinesets: "machinesets",
  route: "routes", routes: "routes",
};

const RESOURCE_API_PATHS = {
  pods: { group: "", version: "v1" },
  services: { group: "", version: "v1" },
  configmaps: { group: "", version: "v1" },
  secrets: { group: "", version: "v1" },
  namespaces: { group: "", version: "v1" },
  nodes: { group: "", version: "v1" },
  events: { group: "", version: "v1" },
  persistentvolumeclaims: { group: "", version: "v1" },
  deployments: { group: "apps", version: "v1" },
  replicasets: { group: "apps", version: "v1" },
  daemonsets: { group: "apps", version: "v1" },
  statefulsets: { group: "apps", version: "v1" },
  jobs: { group: "batch", version: "v1" },
  cronjobs: { group: "batch", version: "v1" },
  ingresses: { group: "networking.k8s.io", version: "v1" },
  clusterversions: { group: "config.openshift.io", version: "v1" },
  clusteroperators: { group: "config.openshift.io", version: "v1" },
  machines: { group: "machine.openshift.io", version: "v1beta1" },
  machinesets: { group: "machine.openshift.io", version: "v1beta1" },
  routes: { group: "route.openshift.io", version: "v1" },
};

function tokenize(cmd) {
  // Simple shell tokenizer — handles quoted strings
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) { quote = null; tokens.push(current); current = ""; }
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === " " || c === "\t" || c === "\n") {
      if (current) { tokens.push(current); current = ""; }
    } else {
      current += c;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseFlags(tokens) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq !== -1) flags[t.slice(2, eq)] = t.slice(eq + 1);
      else if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        flags[t.slice(2)] = tokens[++i];
      } else {
        flags[t.slice(2)] = true;
      }
    } else if (t.startsWith("-") && t.length === 2) {
      const key = { n: "namespace", l: "selector", o: "output", f: "filename", c: "container", w: "watch", p: "patch" }[t[1]];
      if (key && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        flags[key] = tokens[++i];
      } else {
        flags[t.slice(1)] = true;
      }
    } else {
      positional.push(t);
    }
  }
  return { flags, positional };
}

function buildPath(resource, namespace, name) {
  const info = RESOURCE_API_PATHS[resource];
  if (!info) return null;
  const base = info.group === "" ? `/api/${info.version}` : `/apis/${info.group}/${info.version}`;
  const CLUSTER_SCOPED = new Set(["nodes", "namespaces", "persistentvolumes", "clusterversions", "clusteroperators"]);
  if (CLUSTER_SCOPED.has(resource)) {
    return name ? `${base}/${resource}/${name}` : `${base}/${resource}`;
  }
  if (!namespace) return null;
  return name ? `${base}/namespaces/${namespace}/${resource}/${name}` : `${base}/namespaces/${namespace}/${resource}`;
}

function summarizeListResponse(resp, limit = 20) {
  if (!resp || !resp.items) return JSON.stringify(resp, null, 2).slice(0, 4000);
  const lines = [`Found ${resp.items.length} item(s):`];
  resp.items.slice(0, limit).forEach((it) => {
    const meta = it.metadata || {};
    const status = it.status || {};
    const phase = status.phase || (status.conditions && status.conditions[0]?.type) || "";
    lines.push(`  - ${meta.name}${meta.namespace ? " (" + meta.namespace + ")" : ""}${phase ? " [" + phase + "]" : ""}`);
  });
  if (resp.items.length > limit) lines.push(`  ... and ${resp.items.length - limit} more`);
  return lines.join("\n");
}

function summarizeSingleResponse(resp) {
  if (!resp || !resp.metadata) return JSON.stringify(resp, null, 2).slice(0, 4000);
  const meta = resp.metadata;
  const status = resp.status || {};
  const lines = [
    `Name:       ${meta.name}`,
    meta.namespace ? `Namespace:  ${meta.namespace}` : "",
    `Kind:       ${resp.kind || ""}`,
    meta.creationTimestamp ? `Created:    ${meta.creationTimestamp}` : "",
  ].filter(Boolean);
  if (status.phase) lines.push(`Phase:      ${status.phase}`);
  if (status.conditions) {
    lines.push("Conditions:");
    status.conditions.slice(0, 5).forEach((c) => {
      lines.push(`  - ${c.type}: ${c.status}${c.reason ? " (" + c.reason + ")" : ""}${c.message ? " — " + c.message : ""}`);
    });
  }
  if (resp.kind === "Pod" && status.containerStatuses) {
    lines.push("Containers:");
    status.containerStatuses.forEach((c) => {
      const state = Object.keys(c.state || {})[0] || "unknown";
      lines.push(`  - ${c.name}: ${state}, ready=${c.ready}, restarts=${c.restartCount}`);
    });
  }
  return lines.join("\n");
}

/**
 * Execute a kubectl/oc command against the cluster.
 *
 * @param {string} command - the raw command string
 * @param {object} opts
 * @param {boolean} opts.dryRun - if true, write ops use ?dryRun=All
 * @returns {Promise<object>} { success, stdout, stderr, command, dryRun, durationMs }
 */
export async function executeFixCommand(command, { dryRun = false } = {}) {
  const startTime = Date.now();
  const result = { success: false, stdout: "", stderr: "", command, dryRun, durationMs: 0 };

  try {
    if (!command || typeof command !== "string") {
      result.stderr = "Empty command";
      return result;
    }

    // Block dangerous patterns unconditionally
    for (const pat of BLOCKED_PATTERNS) {
      if (pat.test(command)) {
        result.stderr = `Blocked: this command pattern is not allowed for safety (${pat})`;
        return result;
      }
    }

    const tokens = tokenize(command.trim());
    if (tokens.length === 0) { result.stderr = "Empty command"; return result; }

    // First token must be kubectl or oc
    const cli = tokens.shift();
    if (cli !== "kubectl" && cli !== "oc") {
      result.stderr = `Unsupported CLI '${cli}'. Only 'kubectl' and 'oc' are supported.`;
      return result;
    }

    const verb = tokens.shift();
    if (!verb) { result.stderr = "Missing verb"; return result; }

    const { flags, positional } = parseFlags(tokens);
    const namespace = flags.namespace || flags.n || "";

    // ===== Read-only verbs =====
    if (verb === "get" || verb === "describe") {
      const rawResource = positional[0];
      if (!rawResource) { result.stderr = `Usage: ${cli} ${verb} <resource> [name] -n <ns>`; return result; }
      const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
      const name = positional[1] || "";
      const path = buildPath(resource, namespace, name);
      if (!path) { result.stderr = `Cannot resolve resource '${resource}'${namespace ? "" : " (namespace required)"}`; return result; }
      const resp = await ocpGet(path);
      result.success = true;
      result.stdout = name ? summarizeSingleResponse(resp) : summarizeListResponse(resp);
      return result;
    }

    if (verb === "logs") {
      const podName = positional[0];
      if (!podName) { result.stderr = `Usage: ${cli} logs <pod> -n <ns>`; return result; }
      if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
      const tail = flags.tail || "200";
      const previous = flags.previous ? "true" : "false";
      const container = flags.container || flags.c || "";
      let path = `/api/v1/namespaces/${namespace}/pods/${podName}/log?tailLines=${tail}&previous=${previous}`;
      if (container) path += `&container=${encodeURIComponent(container)}`;
      let resp;
      try {
        resp = await ocpFetch(path, { headers: { Accept: "text/plain" } });
      } catch (e) {
        if (e.message && e.message.includes("406")) {
          resp = await ocpFetch(path, { headers: { Accept: "*/*" } });
        } else {
          throw e;
        }
      }
      result.success = true;
      result.stdout = typeof resp === "string" ? resp.slice(0, 8000) : JSON.stringify(resp).slice(0, 8000);
      return result;
    }

    if (verb === "top") {
      const subj = positional[0]; // "pod" or "node"
      const target = positional[1] || "";
      if (subj === "pod" || subj === "pods") {
        if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
        const path = target
          ? `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${target}`
          : `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`;
        const resp = await ocpGet(path);
        if (resp.items) {
          result.stdout = "POD                              CPU       MEMORY\n" +
            resp.items.map((p) => {
              const cpu = (p.containers || []).reduce((sum, c) => sum + (c.usage?.cpu || "0"), "");
              const mem = (p.containers || []).reduce((sum, c) => sum + (c.usage?.memory || "0"), "");
              return `${(p.metadata?.name || "").padEnd(32)} ${cpu.padEnd(10)} ${mem}`;
            }).join("\n");
        } else {
          result.stdout = JSON.stringify(resp, null, 2);
        }
        result.success = true;
        return result;
      }
      if (subj === "node" || subj === "nodes") {
        const path = target ? `/apis/metrics.k8s.io/v1beta1/nodes/${target}` : `/apis/metrics.k8s.io/v1beta1/nodes`;
        const resp = await ocpGet(path);
        result.success = true;
        result.stdout = JSON.stringify(resp.items || resp, null, 2).slice(0, 4000);
        return result;
      }
      result.stderr = `Unsupported top subject: ${subj}`;
      return result;
    }

    if (verb === "events") {
      const path = namespace ? `/api/v1/namespaces/${namespace}/events` : "/api/v1/events";
      const resp = await ocpGet(path);
      const items = (resp.items || []).slice(-30).reverse();
      result.success = true;
      result.stdout = items.map((e) => `${(e.lastTimestamp || e.eventTime || "").slice(11, 19)} ${e.type.padEnd(8)} ${e.reason.padEnd(24)} ${e.involvedObject?.name || ""}: ${e.message}`).join("\n") || "No events";
      return result;
    }

    // ===== Write verbs =====
    const dryRunParam = dryRun ? "?dryRun=All" : "";

    if (verb === "delete") {
      const rawResource = positional[0];
      const name = positional[1];
      if (!rawResource || !name) { result.stderr = `Usage: ${cli} delete <resource> <name> -n <ns>`; return result; }
      const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
      // Only allow deleting namespaced workload resources
      const allowedDelete = ["pods", "jobs", "replicasets"];
      if (!allowedDelete.includes(resource)) {
        result.stderr = `Delete not allowed for resource '${resource}'. Allowed: ${allowedDelete.join(", ")}`;
        return result;
      }
      if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
      const path = buildPath(resource, namespace, name) + dryRunParam;
      if (dryRun) {
        // K8s DELETE doesn't accept dryRun in path the same way — use the deleteOptions body
        const resp = await ocpDelete(buildPath(resource, namespace, name) + "?dryRun=All");
        result.success = true;
        result.stdout = `[DRY RUN] Would delete ${resource}/${name} in ${namespace}\n` + summarizeSingleResponse(resp);
      } else {
        await ocpDelete(buildPath(resource, namespace, name));
        result.success = true;
        result.stdout = `${resource}/${name} deleted from ${namespace}`;
      }
      return result;
    }

    if (verb === "scale") {
      const rawResource = positional[0];
      const name = positional[1];
      const replicas = parseInt(flags.replicas, 10);
      if (!rawResource || !name || isNaN(replicas)) {
        result.stderr = `Usage: ${cli} scale <resource> <name> --replicas=N -n <ns>`;
        return result;
      }
      const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
      if (!["deployments", "statefulsets", "replicasets"].includes(resource)) {
        result.stderr = `Scale not supported for ${resource}`;
        return result;
      }
      if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
      const path = buildPath(resource, namespace, name) + dryRunParam;
      const resp = await ocpPatch(path, { spec: { replicas } });
      result.success = true;
      result.stdout = (dryRun ? "[DRY RUN] Would scale " : "Scaled ") + `${resource}/${name} to ${replicas} replicas in ${namespace}`;
      return result;
    }

    if (verb === "rollout") {
      const subVerb = positional[0];
      const rawResource = positional[1];
      const name = positional[2];
      if (subVerb !== "restart") {
        result.stderr = `Only 'rollout restart' is supported`;
        return result;
      }
      if (!rawResource || !name) { result.stderr = `Usage: ${cli} rollout restart <resource> <name> -n <ns>`; return result; }
      const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
      if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
      const path = buildPath(resource, namespace, name) + dryRunParam;
      await ocpPatch(path, {
        spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } },
      });
      result.success = true;
      result.stdout = (dryRun ? "[DRY RUN] Would restart " : "Restarted ") + `${resource}/${name} in ${namespace}`;
      return result;
    }

    if (verb === "patch") {
      const rawResource = positional[0];
      const name = positional[1];
      if (!rawResource || !name) {
        result.stderr = `Usage: ${cli} patch <resource> <name> -p '<json>' [--type=merge|strategic|json] -n <ns>`;
        return result;
      }
      const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
      const allowedPatch = ["deployments", "daemonsets", "statefulsets", "services", "configmaps", "pods", "ingresses", "cronjobs", "jobs"];
      if (!allowedPatch.includes(resource)) {
        result.stderr = `Patch not allowed for resource '${resource}'. Allowed: ${allowedPatch.join(", ")}`;
        return result;
      }
      if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
      const patchStr = flags.patch || flags.p;
      if (!patchStr) {
        result.stderr = "Missing patch body. Use -p '<json>' or --patch='<json>'";
        return result;
      }
      let patchBody;
      try { patchBody = JSON.parse(patchStr); } catch {
        result.stderr = `Invalid JSON in patch body: ${patchStr.slice(0, 200)}`;
        return result;
      }
      const patchType = (flags.type || "strategic").toLowerCase();
      const contentType = patchType === "json"
        ? "application/json-patch+json"
        : patchType === "merge"
          ? "application/merge-patch+json"
          : "application/strategic-merge-patch+json";
      const path = buildPath(resource, namespace, name) + dryRunParam;
      const resp = await ocpPatch(path, patchBody, contentType);
      result.success = true;
      result.stdout = (dryRun ? "[DRY RUN] Would patch " : "Patched ") +
        `${resource}/${name} in ${namespace}` +
        (resp?.metadata?.resourceVersion ? ` (rv: ${resp.metadata.resourceVersion})` : "");
      return result;
    }

    if (verb === "annotate" || verb === "label") {
      result.stderr = `'${verb}' execution requires structured input — use the chat interface for this command.`;
      return result;
    }

    if (verb === "apply" || verb === "create" || verb === "edit" || verb === "exec" || verb === "port-forward") {
      result.stderr = `'${verb}' is not supported via this fix runner. Run it manually or use AI chat to construct the resource.`;
      return result;
    }

    result.stderr = `Unsupported verb: ${verb}`;
    return result;
  } catch (err) {
    result.stderr = `Execution error: ${err.message}`;
    return result;
  } finally {
    result.durationMs = Date.now() - startTime;
  }
}
