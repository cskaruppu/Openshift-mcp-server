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

const ENRICHABLE = new Set(["deployments", "statefulsets", "daemonsets"]);

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

// Parse a Kubernetes storage quantity ("20Gi", "500Mi", "1Ti", "1000000000")
// into bytes. Returns NaN when unparseable.
function _parseStorage(q) {
  if (q == null) return NaN;
  const s = String(q).trim();
  const m = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/.exec(s);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = m[2] || "";
  const mul = {
    "": 1,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
    K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  }[unit];
  return n * mul;
}

// Preflight a PVC patch that changes requested storage: confirm it's an
// expansion (K8s can't shrink) and that the StorageClass permits it. Returns
// { error } to block, or {} to proceed. Lookup failures never block (best
// effort) — the API server's own dry-run remains the final authority.
async function _pvcExpansionPreflight(namespace, name, patchBody) {
  const requested = patchBody?.spec?.resources?.requests?.storage;
  if (requested == null) return {}; // not a resize — nothing to check
  const reqBytes = _parseStorage(requested);
  if (Number.isNaN(reqBytes)) return { error: `Invalid storage size '${requested}'. Use a quantity like 20Gi.` };
  let pvc;
  try {
    pvc = await ocpGet(`/api/v1/namespaces/${namespace}/persistentvolumeclaims/${name}`);
  } catch {
    return {}; // can't read it — let the API server decide
  }
  const current = pvc?.status?.capacity?.storage || pvc?.spec?.resources?.requests?.storage;
  const curBytes = _parseStorage(current);
  if (!Number.isNaN(curBytes) && reqBytes <= curBytes) {
    return { error: `Cannot resize PVC '${name}' to ${requested}: it is not larger than the current size (${current}). Kubernetes only supports EXPANDING a PVC, never shrinking.` };
  }
  const scName = pvc?.spec?.storageClassName;
  if (scName) {
    try {
      const sc = await ocpGet(`/apis/storage.k8s.io/v1/storageclasses/${scName}`);
      if (sc && sc.allowVolumeExpansion !== true) {
        return { error: `StorageClass '${scName}' does not allow volume expansion (allowVolumeExpansion is not true), so PVC '${name}' cannot be resized. Migrate the data to a larger PVC on an expandable StorageClass instead.` };
      }
    } catch { /* SC not readable — proceed and let the API server validate */ }
  }
  return {};
}

function tokenize(cmd) {
  // Strip shell line-continuation (backslash + newline)
  cmd = cmd.replace(/\\\s*\n/g, " ");
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
    } else if (c === "\\" && i + 1 < cmd.length && (cmd[i + 1] === " " || cmd[i + 1] === "\n")) {
      // Lone backslash before whitespace — skip it (line continuation)
      continue;
    } else {
      current += c;
    }
  }
  if (current && current !== "\\") tokens.push(current);
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
    } else if (t.startsWith("-") && !t.startsWith("--") && t.length > 2 && t[2] === "=") {
      const key = { n: "namespace", l: "selector", o: "output", f: "filename", c: "container", w: "watch", p: "patch" }[t[1]];
      flags[key || t[1]] = t.slice(3);
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

/**
 * Resolve resource type + name from positional args, supporting both formats:
 *   - "deployment/myapp"  (single token, slash-separated)
 *   - "deployment myapp"  (two tokens)
 * Returns { resource, name } where `resource` is the raw type (un-aliased).
 */
function resolveResourceTarget(positional, startIdx = 0) {
  const first = positional[startIdx];
  if (!first) return { resource: null, name: null };
  const slashIdx = first.indexOf("/");
  if (slashIdx > 0) {
    return { resource: first.slice(0, slashIdx), name: first.slice(slashIdx + 1) };
  }
  return { resource: first, name: positional[startIdx + 1] || null };
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

export async function fetchPodStatus(namespace, labelSelector) {
  const podsResp = await ocpGet(`/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`);
  const pods = (podsResp?.items || []).slice(0, 20);
  let metrics = [];
  try {
    const mr = await ocpGet(`/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`);
    metrics = mr?.items || [];
  } catch { /* metrics API may not be available */ }
  return pods.map(p => {
    const meta = p.metadata || {};
    const st = p.status || {};
    const cs = st.containerStatuses || [];
    const pm = metrics.find(m => m.metadata?.name === meta.name);
    return {
      name: meta.name,
      phase: st.phase || "Unknown",
      ready: cs.length > 0 && cs.every(c => c.ready),
      restarts: cs.reduce((s, c) => s + (c.restartCount || 0), 0),
      cpu: pm ? (pm.containers || []).map(c => c.usage?.cpu || "0").join(" + ") : "n/a",
      memory: pm ? (pm.containers || []).map(c => c.usage?.memory || "0").join(" + ") : "n/a",
    };
  });
}

async function gatherPodContext(resource, namespace, name) {
  try {
    const dep = await ocpGet(buildPath(resource, namespace, name));
    const selector = dep?.spec?.selector?.matchLabels || {};
    const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",");
    if (!labelSelector) return null;
    const specContainers = (dep?.spec?.template?.spec?.containers || []).map(c => ({
      name: c.name,
      limits: c.resources?.limits || {},
      requests: c.resources?.requests || {},
    }));
    const pods = await fetchPodStatus(namespace, labelSelector);
    return {
      resourceSpec: specContainers,
      replicas: dep?.spec?.replicas,
      readyReplicas: dep?.status?.readyReplicas ?? 0,
      namespace,
      labelSelector,
      pods,
    };
  } catch { return null; }
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

    // Extract flags that appear before the verb (e.g. oc -n my-ns get pods)
    const preFlags = {};
    while (tokens.length > 0 && tokens[0].startsWith("-")) {
      const t = tokens.shift();
      if (t.startsWith("--")) {
        const eq = t.indexOf("=");
        if (eq !== -1) {
          const key = t.slice(2, eq);
          preFlags[key] = t.slice(eq + 1);
        } else if (tokens.length > 0 && !tokens[0].startsWith("-")) {
          preFlags[t.slice(2)] = tokens.shift();
        } else {
          preFlags[t.slice(2)] = true;
        }
      } else if (t.length === 2) {
        const key = { n: "namespace", l: "selector", o: "output", f: "filename", c: "container" }[t[1]];
        if (key && tokens.length > 0 && !tokens[0].startsWith("-")) {
          preFlags[key] = tokens.shift();
        } else {
          preFlags[t.slice(1)] = true;
        }
      }
    }

    const verb = tokens.shift();
    if (!verb) { result.stderr = "Missing verb"; return result; }

    const { flags: postFlags, positional } = parseFlags(tokens);
    // Merge pre-verb flags into post-verb flags (post-verb wins on conflict)
    const flags = Object.assign({}, preFlags, postFlags);
    const namespace = flags.namespace || flags.n || "";

    // ===== Read-only verbs =====
    if (verb === "get" || verb === "describe") {
      const { resource: rawResource, name: tgtName } = resolveResourceTarget(positional);
      if (!rawResource) { result.stderr = `Usage: ${cli} ${verb} <resource>[/name] [name] -n <ns>`; return result; }
      const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
      const name = tgtName || "";
      const path = buildPath(resource, namespace, name);
      if (!path) { result.stderr = `Cannot resolve resource '${resource}'${namespace ? "" : " (namespace required)"}`; return result; }
      const resp = await ocpGet(path);
      result.success = true;
      result.stdout = name ? summarizeSingleResponse(resp) : summarizeListResponse(resp);
      return result;
    }

    if (verb === "logs") {
      // Allow "oc logs pod/foo" or "oc logs pods/foo" as well as "oc logs foo"
      let podName = positional[0];
      if (podName && podName.includes("/")) {
        const parts = podName.split("/");
        podName = parts[parts.length - 1];
      }
      if (!podName) { result.stderr = `Usage: ${cli} logs <pod>[/name] -n <ns>`; return result; }
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

    // ===== oc adm subcommands =====
    // "oc adm" is a prefix for many subcommands. Re-route known ones to
    // their native handlers; for the rest, return a helpful message.
    if (verb === "adm") {
      const subVerb = positional.shift();
      if (!subVerb) { result.stderr = "Missing adm subcommand"; return result; }

      // oc adm top → reuse the existing "top" handler
      if (subVerb === "top") {
        const subj = positional[0];
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
          if (resp.items) {
            result.stdout = "NODE                             CPU       MEMORY\n" +
              resp.items.map((n) => {
                return `${(n.metadata?.name || "").padEnd(32)} ${(n.usage?.cpu || "0").padEnd(10)} ${n.usage?.memory || "0"}`;
              }).join("\n");
          } else if (resp.metadata?.name) {
            result.stdout = `${resp.metadata.name}: CPU=${resp.usage?.cpu || "?"}, Memory=${resp.usage?.memory || "?"}`;
          } else {
            result.stdout = JSON.stringify(resp, null, 2).slice(0, 4000);
          }
          result.success = true;
          return result;
        }
        result.stderr = `Usage: oc adm top <node|pod> [name] [-n namespace]`;
        return result;
      }

      // oc adm upgrade
      if (subVerb === "upgrade") {
        const targetVersion = flags.to;
        const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
        const currentVersion = cv.status?.desired?.version || "unknown";
        const channel = cv.spec?.channel || "unknown";
        const updates = cv.status?.availableUpdates || [];
        const conditions = cv.status?.conditions || [];
        const progressing = conditions.find(c => c.type === "Progressing");

        if (!targetVersion) {
          const lines = [`Cluster version is ${currentVersion}`, `Channel: ${channel}`];
          if (progressing?.status === "True") {
            lines.push(`Upgrade in progress: ${progressing.message}`);
          }
          if (updates.length > 0) {
            lines.push(`\nAvailable updates:`);
            updates.slice(0, 15).forEach(u => lines.push(`  ${u.version}`));
          } else {
            lines.push(`No updates available in channel ${channel}`);
          }
          result.success = true;
          result.stdout = lines.join("\n");
          return result;
        }

        if (dryRun) {
          const available = updates.some(u => u.version === targetVersion);
          result.success = true;
          result.stdout = `[DRY RUN] Would upgrade cluster from ${currentVersion} to ${targetVersion}\n` +
            `Channel: ${channel}\n` +
            `Target available: ${available ? "YES" : "NO — version not in available updates"}\n` +
            (progressing?.status === "True" ? `WARNING: Upgrade already in progress\n` : "");
          return result;
        }

        const body = { spec: { desiredUpdate: { version: targetVersion } } };
        await ocpPatch("/apis/config.openshift.io/v1/clusterversions/version", body);
        result.success = true;
        result.stdout = `Upgrade initiated: ${currentVersion} → ${targetVersion}\nMonitor with: oc get clusterversion`;
        return result;
      }

      // oc adm node-logs → read-only, fetch node logs
      if (subVerb === "node-logs") {
        const nodeName = positional[0];
        if (!nodeName) { result.stderr = "Usage: oc adm node-logs <node-name> [--path=kubelet]"; return result; }
        const logPath = flags.path || "kubelet";
        try {
          const resp = await ocpFetch(`/api/v1/nodes/${nodeName}/proxy/logs/${logPath}`, { headers: { Accept: "text/plain" } });
          const text = typeof resp === "string" ? resp : JSON.stringify(resp);
          const lines = text.split("\n");
          result.success = true;
          result.stdout = lines.slice(-200).join("\n") || "(no logs)";
        } catch (e) {
          result.stderr = `Failed to get node logs: ${e.message}. The service account may need nodes/proxy permission.`;
        }
        return result;
      }

      // oc adm inspect, must-gather, release info → informational, not executable here
      if (["inspect", "must-gather", "release", "policy", "groups", "prune", "certificate"].includes(subVerb)) {
        result.stderr = `'oc adm ${subVerb}' requires direct CLI access. Run it in your terminal:\n  oc adm ${subVerb} ${positional.join(" ")}`;
        return result;
      }

      // oc adm cordon/drain/uncordon/taint → blocked by safety
      if (["cordon", "uncordon", "drain", "taint"].includes(subVerb)) {
        result.stderr = `'oc adm ${subVerb}' is blocked for safety. Run it manually after review.`;
        return result;
      }

      result.stderr = `'oc adm ${subVerb}' is not supported via this runner. Run it directly:\n  oc adm ${subVerb} ${positional.join(" ")} ${Object.entries(flags).map(([k, v]) => v === true ? "--" + k : "--" + k + "=" + v).join(" ")}`.trim();
      return result;
    }

    // ===== Write verbs =====
    const dryRunParam = dryRun ? "?dryRun=All" : "";

    if (verb === "delete") {
      const { resource: rawResource, name } = resolveResourceTarget(positional);
      if (!rawResource || !name) { result.stderr = `Usage: ${cli} delete <resource>[/name] [name] -n <ns>`; return result; }
      const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
      // Only allow deleting namespaced workload resources + PVCs. PV/PVC on the
      // cluster-scoped side (persistentvolumes) stays blocked by BLOCKED_PATTERNS.
      const allowedDelete = ["pods", "jobs", "replicasets", "persistentvolumeclaims"];
      if (!allowedDelete.includes(resource)) {
        result.stderr = `Delete not allowed for resource '${resource}'. Allowed: ${allowedDelete.join(", ")}`;
        return result;
      }
      if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
      // Data-loss guard: refuse to delete a PVC that is still mounted by a pod.
      // (K8s pvc-protection would otherwise leave it stuck Terminating.)
      if (resource === "persistentvolumeclaims" && !dryRun) {
        try {
          const pods = await ocpGet(`/api/v1/namespaces/${namespace}/pods`);
          const consumers = (pods.items || [])
            .filter(p => (p.spec?.volumes || []).some(v => v.persistentVolumeClaim?.claimName === name))
            .map(p => p.metadata.name);
          if (consumers.length) {
            result.stderr = `PVC '${name}' is still mounted by ${consumers.length} pod(s): ${consumers.slice(0, 5).join(", ")}${consumers.length > 5 ? "…" : ""}. Scale down or delete these workloads first to avoid data loss.`;
            return result;
          }
        } catch { /* best effort — fall through to the delete */ }
      }
      let ownerDep = null;
      if (resource === "pods" && !dryRun) {
        try {
          const podObj = await ocpGet(buildPath(resource, namespace, name));
          const rsOwner = (podObj?.metadata?.ownerReferences || []).find(o => o.kind === "ReplicaSet");
          if (rsOwner) {
            const rs = await ocpGet(buildPath("replicasets", namespace, rsOwner.name));
            const depOwner = (rs?.metadata?.ownerReferences || []).find(o => o.kind === "Deployment");
            if (depOwner) ownerDep = { name: depOwner.name, type: "deployments" };
          }
          if (!ownerDep) {
            const ssOwner = (podObj?.metadata?.ownerReferences || []).find(o => o.kind === "StatefulSet");
            if (ssOwner) ownerDep = { name: ssOwner.name, type: "statefulsets" };
            const dsOwner = (podObj?.metadata?.ownerReferences || []).find(o => o.kind === "DaemonSet");
            if (!ownerDep && dsOwner) ownerDep = { name: dsOwner.name, type: "daemonsets" };
          }
        } catch { /* best effort */ }
      }
      if (dryRun) {
        const resp = await ocpDelete(buildPath(resource, namespace, name) + "?dryRun=All");
        result.success = true;
        result.stdout = `[DRY RUN] Would delete ${resource}/${name} in ${namespace}\n` + summarizeSingleResponse(resp);
      } else {
        await ocpDelete(buildPath(resource, namespace, name));
        result.success = true;
        result.stdout = `${resource}/${name} deleted from ${namespace}`;
        if (ownerDep) {
          try { result.context = await gatherPodContext(ownerDep.type, namespace, ownerDep.name); } catch { /* best effort */ }
        }
      }
      return result;
    }

    if (verb === "scale") {
      const { resource: rawResource, name } = resolveResourceTarget(positional);
      const replicas = parseInt(flags.replicas, 10);
      if (!rawResource || !name || isNaN(replicas)) {
        result.stderr = `Usage: ${cli} scale <resource>[/name] [name] --replicas=N -n <ns>`;
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
      if (ENRICHABLE.has(resource)) try { result.context = await gatherPodContext(resource, namespace, name); } catch { /* best effort */ }
      return result;
    }

    if (verb === "rollout") {
      const subVerb = positional[0];
      if (!["restart", "undo", "history"].includes(subVerb)) {
        result.stderr = `Only 'rollout restart', 'rollout undo' and 'rollout history' are supported`;
        return result;
      }

      // ── rollout history / undo ──
      // kubectl implements these over ReplicaSet revisions rather than a single
      // API call: each ReplicaSet owned by the Deployment carries a
      // deployment.kubernetes.io/revision annotation and a full pod template.
      // Undo = patch the Deployment's template back to the chosen revision's.
      if (subVerb === "undo" || subVerb === "history") {
        const t = resolveResourceTarget(positional, 1);
        const res2 = RESOURCE_ALIASES[(t.resource || "").toLowerCase()] || (t.resource || "").toLowerCase();
        if (!t.name) { result.stderr = `Usage: ${cli} rollout ${subVerb} deployment/<name> -n <ns> [--to-revision=N]`; return result; }
        if (res2 !== "deployments") { result.stderr = `'rollout ${subVerb}' is only supported for deployments (got '${res2}')`; return result; }
        if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }

        let dep;
        try { dep = await ocpGet(buildPath("deployments", namespace, t.name)); }
        catch (e) { result.stderr = `Deployment ${t.name} not found in ${namespace}: ${e.message}`; return result; }
        const curRev = parseInt(dep?.metadata?.annotations?.["deployment.kubernetes.io/revision"] || "0", 10);

        // Only ReplicaSets actually owned by this Deployment are candidates.
        let rsList = [];
        try {
          const all = await ocpGet(`/apis/apps/v1/namespaces/${namespace}/replicasets?limit=200`);
          rsList = (all.items || []).filter((rs) =>
            (rs.metadata?.ownerReferences || []).some((o) => o.kind === "Deployment" && o.name === dep.metadata.name));
        } catch { /* fall through to the empty check */ }
        const revs = rsList
          .map((rs) => ({ rev: parseInt(rs.metadata?.annotations?.["deployment.kubernetes.io/revision"] || "0", 10), rs }))
          .filter((x) => x.rev > 0)
          .sort((a, b) => b.rev - a.rev);

        if (subVerb === "history") {
          result.success = true;
          result.stdout = revs.length
            ? [`deployment.apps/${t.name}`, "REVISION  REPLICASET", ...revs.map((x) => `${String(x.rev).padEnd(9)} ${x.rs.metadata.name}${x.rev === curRev ? "  (current)" : ""}`)].join("\n")
            : `No revision history retained for deployment/${t.name}.`;
          return result;
        }

        const want = flags["to-revision"] ? parseInt(flags["to-revision"], 10) : null;
        const target = want ? revs.find((x) => x.rev === want) : revs.find((x) => x.rev !== curRev);
        if (!target) {
          result.stderr = want
            ? `Revision ${want} is not retained for deployment/${t.name} (available: ${revs.map((x) => x.rev).join(", ") || "none"}).`
            : `No previous revision retained for deployment/${t.name} — revisionHistoryLimit has aged it out, so a native undo is not possible.`;
          return result;
        }
        const tpl = target.rs.spec?.template;
        if (!tpl) { result.stderr = `Revision ${target.rev} has no pod template to restore.`; return result; }
        // Drop the template hash — it is derived by the controller, not settable.
        const cleanTpl = JSON.parse(JSON.stringify(tpl));
        if (cleanTpl.metadata?.labels) delete cleanTpl.metadata.labels["pod-template-hash"];

        const undoPath = buildPath("deployments", namespace, t.name) + dryRunParam;
        await ocpPatch(undoPath, { spec: { template: cleanTpl } });
        result.success = true;
        result.stdout = (dryRun ? "[DRY RUN] Would roll back " : "Rolled back ") +
          `deployment/${t.name} in ${namespace} to revision ${target.rev} (from ${curRev || "?"})`;
        try { result.context = await gatherPodContext("deployments", namespace, t.name); } catch { /* best effort */ }
        return result;
      }

      const { resource: rawResource, name } = resolveResourceTarget(positional, 1);
      if (!rawResource || !name) { result.stderr = `Usage: ${cli} rollout restart <resource>[/name] [name] -n <ns>`; return result; }
      const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
      if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
      const path = buildPath(resource, namespace, name) + dryRunParam;
      await ocpPatch(path, {
        spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } },
      });
      result.success = true;
      result.stdout = (dryRun ? "[DRY RUN] Would restart " : "Restarted ") + `${resource}/${name} in ${namespace}`;
      if (ENRICHABLE.has(resource)) try { result.context = await gatherPodContext(resource, namespace, name); } catch { /* best effort */ }
      return result;
    }

    if (verb === "patch") {
      const { resource: rawResource, name } = resolveResourceTarget(positional);
      if (!rawResource || !name) {
        result.stderr = `Usage: ${cli} patch <resource>[/name] [name] -p '<json>' [--type=merge|strategic|json] -n <ns>`;
        return result;
      }
      const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
      const allowedPatch = ["deployments", "daemonsets", "statefulsets", "services", "configmaps", "pods", "ingresses", "cronjobs", "jobs", "persistentvolumeclaims"];
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
      // PVC expansion preflight: a PVC patch is (almost always) a resize. Verify
      // the StorageClass allows expansion and the new size is strictly larger —
      // K8s cannot shrink a PVC, and expansion silently no-ops without
      // allowVolumeExpansion. Best-effort: lookup failures don't block.
      if (resource === "persistentvolumeclaims") {
        const pf = await _pvcExpansionPreflight(namespace, name, patchBody);
        if (pf.error) { result.stderr = pf.error; return result; }
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
      if (ENRICHABLE.has(resource)) try { result.context = await gatherPodContext(resource, namespace, name); } catch { /* best effort */ }
      return result;
    }

    if (verb === "set") {
      const subVerb = positional.shift();
      if (subVerb === "resources") {
        // oc set resources deployment/loadgenerator --containers=main --requests=memory=512Mi --limits=memory=1Gi -n ns
        const target = positional[0];
        if (!target) { result.stderr = `Usage: ${cli} set resources <resource>/<name> --containers=<c> --requests=<r> --limits=<l> -n <ns>`; return result; }
        if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
        const slashIdx = target.indexOf("/");
        if (slashIdx === -1) { result.stderr = `Resource must be in format <type>/<name>, got '${target}'`; return result; }
        const rawResource = target.slice(0, slashIdx);
        const resName = target.slice(slashIdx + 1);
        const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
        if (!["deployments", "daemonsets", "statefulsets"].includes(resource)) {
          result.stderr = `set resources not supported for '${resource}'. Use deployments, daemonsets, or statefulsets.`;
          return result;
        }
        const containerName = flags.containers || flags.container || "";
        const reqStr = flags.requests || "";
        const limStr = flags.limits || "";
        const resources = {};
        if (reqStr) {
          resources.requests = {};
          reqStr.split(",").forEach(function(kv) { const [k, v] = kv.split("="); if (k && v) resources.requests[k] = v; });
        }
        if (limStr) {
          resources.limits = {};
          limStr.split(",").forEach(function(kv) { const [k, v] = kv.split("="); if (k && v) resources.limits[k] = v; });
        }
        // Build a strategic-merge-patch targeting the named container
        const current = await ocpGet(buildPath(resource, namespace, resName));
        const containers = current?.spec?.template?.spec?.containers || [];
        const targetContainer = containerName
          ? containers.find(c => c.name === containerName)
          : containers[0];
        if (!targetContainer) {
          result.stderr = containerName
            ? `Container '${containerName}' not found in ${resource}/${resName}`
            : `No containers found in ${resource}/${resName}`;
          return result;
        }
        result.preContext = {
          container: targetContainer.name,
          currentLimits: targetContainer.resources?.limits || {},
          currentRequests: targetContainer.resources?.requests || {},
        };
        const patchBody = {
          spec: {
            template: {
              spec: {
                containers: [{
                  name: targetContainer.name,
                  resources: resources,
                }],
              },
            },
          },
        };
        const path = buildPath(resource, namespace, resName) + dryRunParam;
        const resp = await ocpPatch(path, patchBody, "application/strategic-merge-patch+json");
        const desc = [];
        if (resources.requests) desc.push("requests=" + Object.entries(resources.requests).map(([k, v]) => k + ":" + v).join(","));
        if (resources.limits) desc.push("limits=" + Object.entries(resources.limits).map(([k, v]) => k + ":" + v).join(","));
        result.success = true;
        result.stdout = (dryRun ? "[DRY RUN] Would set " : "Set ") +
          `resources on ${resource}/${resName} container '${targetContainer.name}' in ${namespace}\n` +
          desc.join(", ") +
          (resp?.metadata?.resourceVersion ? `\n(rv: ${resp.metadata.resourceVersion})` : "");
        try { result.context = await gatherPodContext(resource, namespace, resName); } catch { /* best effort */ }
        return result;
      }

      if (subVerb === "image") {
        // oc set image deployment/name container=image:tag -n ns
        const target = positional[0];
        const imageSpec = positional[1];
        if (!target || !imageSpec) { result.stderr = `Usage: ${cli} set image <resource>/<name> <container>=<image> -n <ns>`; return result; }
        if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
        const slashIdx = target.indexOf("/");
        if (slashIdx === -1) { result.stderr = `Resource must be in format <type>/<name>`; return result; }
        const rawResource = target.slice(0, slashIdx);
        const resName = target.slice(slashIdx + 1);
        const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
        const eqIdx = imageSpec.indexOf("=");
        if (eqIdx === -1) { result.stderr = `Image spec must be <container>=<image:tag>`; return result; }
        const cName = imageSpec.slice(0, eqIdx);
        const cImage = imageSpec.slice(eqIdx + 1);
        const patchBody = {
          spec: { template: { spec: { containers: [{ name: cName, image: cImage }] } } },
        };
        const path = buildPath(resource, namespace, resName) + dryRunParam;
        await ocpPatch(path, patchBody, "application/strategic-merge-patch+json");
        result.success = true;
        result.stdout = (dryRun ? "[DRY RUN] Would set " : "Set ") + `image on ${resource}/${resName}: ${cName}=${cImage} in ${namespace}`;
        if (ENRICHABLE.has(resource)) try { result.context = await gatherPodContext(resource, namespace, resName); } catch { /* best effort */ }
        return result;
      }

      if (subVerb === "env") {
        // oc set env deployment/name KEY=VALUE -n ns
        const target = positional[0];
        if (!target) { result.stderr = `Usage: ${cli} set env <resource>/<name> KEY=VALUE... -n <ns>`; return result; }
        if (!namespace) { result.stderr = "Namespace required (-n <ns>)"; return result; }
        const slashIdx = target.indexOf("/");
        if (slashIdx === -1) { result.stderr = `Resource must be in format <type>/<name>`; return result; }
        const rawResource = target.slice(0, slashIdx);
        const resName = target.slice(slashIdx + 1);
        const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
        const envPairs = positional.slice(1).filter(p => p.includes("="));
        if (envPairs.length === 0) { result.stderr = "No env vars specified. Use KEY=VALUE format."; return result; }
        const current = await ocpGet(buildPath(resource, namespace, resName));
        const ctn = flags.containers || flags.container || (current?.spec?.template?.spec?.containers?.[0]?.name) || "";
        if (!ctn) { result.stderr = "Could not determine container name"; return result; }
        const existingEnv = (current?.spec?.template?.spec?.containers?.find(c => c.name === ctn)?.env) || [];
        const newEnv = [...existingEnv];
        envPairs.forEach(pair => {
          const [k, ...rest] = pair.split("=");
          const v = rest.join("=");
          const idx = newEnv.findIndex(e => e.name === k);
          if (idx !== -1) newEnv[idx] = { name: k, value: v };
          else newEnv.push({ name: k, value: v });
        });
        const patchBody = { spec: { template: { spec: { containers: [{ name: ctn, env: newEnv }] } } } };
        const path = buildPath(resource, namespace, resName) + dryRunParam;
        await ocpPatch(path, patchBody, "application/strategic-merge-patch+json");
        result.success = true;
        result.stdout = (dryRun ? "[DRY RUN] Would set " : "Set ") + `env on ${resource}/${resName}: ${envPairs.join(", ")} in ${namespace}`;
        if (ENRICHABLE.has(resource)) try { result.context = await gatherPodContext(resource, namespace, resName); } catch { /* best effort */ }
        return result;
      }

      result.stderr = `'set ${subVerb || ""}' is not supported. Supported: set resources, set image, set env`;
      return result;
    }

    if (verb === "annotate" || verb === "label") {
      const { resource: rawResource, name } = resolveResourceTarget(positional);
      if (!rawResource || !name) { result.stderr = `Usage: ${cli} ${verb} <resource>[/name] [name] key=value... -n <ns>`; return result; }
      const resource = RESOURCE_ALIASES[rawResource.toLowerCase()] || rawResource.toLowerCase();
      if (!namespace && !["nodes", "namespaces", "clusterversions", "clusteroperators"].includes(resource)) {
        result.stderr = "Namespace required (-n <ns>)";
        return result;
      }
      // kvPairs are everything after resource+name. If slash format used, they start at idx 1; else at idx 2.
      const kvStart = positional[0].includes("/") ? 1 : 2;
      const kvPairs = positional.slice(kvStart).filter(p => p.includes("=") || p.endsWith("-"));
      if (kvPairs.length === 0) { result.stderr = `No ${verb}s specified. Use key=value or key- to remove.`; return result; }
      const patchData = {};
      const field = verb === "label" ? "labels" : "annotations";
      kvPairs.forEach(kv => {
        if (kv.endsWith("-")) {
          patchData[kv.slice(0, -1)] = null;
        } else {
          const [k, ...rest] = kv.split("=");
          patchData[k] = rest.join("=");
        }
      });
      const patchBody = { metadata: { [field]: patchData } };
      const path = buildPath(resource, namespace, name) + dryRunParam;
      await ocpPatch(path, patchBody, "application/merge-patch+json");
      result.success = true;
      result.stdout = (dryRun ? "[DRY RUN] Would " : "") + `${verb} ${resource}/${name}: ${kvPairs.join(", ")}`;
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
