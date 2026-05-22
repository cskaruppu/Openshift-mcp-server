import { z } from "zod";
import { ocpGet, ocpPatch } from "../utils/openshift-client.js";

const _watchedNamespaces = new Set(
  (process.env.WATCHED_APP_NAMESPACES || "").split(",").map(s => s.trim()).filter(Boolean)
);
const _baselines = new Map();
const _changeLog = [];
const MAX_CHANGES = 500;

const _gitopsDriftCache = new Map();
const _changeTimeline = [];
const MAX_TIMELINE = 1000;

const SYSTEM_NS_PREFIXES = ["openshift-", "openshift", "kube-", "kube", "default"];
const SYSTEM_NS_EXACT = new Set([
  "default", "openshift", "kube-system", "kube-public", "kube-node-lease",
  "openshift-infra", "openshift-node", "openshift-config",
  "istio-system", "knative-serving", "knative-eventing",
  "cert-manager", "ingress-nginx", "metallb-system",
  "local-path-storage", "cattle-system", "fleet-system",
]);
const ARGO_API = "apis/argoproj.io/v1alpha1";
const GITOPS_NS = process.env.ARGOCD_NAMESPACE || "openshift-gitops";

export function getWatchedNamespaces() { return [..._watchedNamespaces]; }
export function getBaselines() { return Object.fromEntries(_baselines); }
export function getChangeLog() { return _changeLog.slice(); }
export function getChangeTimeline() { return _changeTimeline.slice(); }
export function getGitOpsDrift() { return Object.fromEntries(_gitopsDriftCache); }

export function addNamespaces(nsList) {
  for (const ns of nsList) _watchedNamespaces.add(ns);
}
export function removeNamespaces(nsList) {
  for (const ns of nsList) {
    _watchedNamespaces.delete(ns);
    for (const [key] of _baselines) {
      if (key.startsWith(ns + "/")) _baselines.delete(key);
    }
  }
}
export async function initNamespaceBaselines(nsList) {
  for (const ns of nsList) {
    try {
      const workloads = await fetchWorkloads(ns);
      for (const w of workloads) {
        const key = workloadKey(ns, w.kind, w.metadata.name);
        _baselines.set(key, extractSpec(w));
      }
    } catch {}
  }
}

export function acknowledgeChange(changeId) {
  const entry = _changeLog.find(e => e.id === changeId);
  if (!entry) return { found: false };
  entry.acknowledged = true;
  return { found: true, id: changeId, action: "acknowledged" };
}

export async function dismissChange(changeId) {
  const entry = _changeLog.find(e => e.id === changeId);
  if (!entry) return { found: false };
  const kindPath = entry.kind === "Deployment" ? "deployments" : entry.kind === "StatefulSet" ? "statefulsets" : "daemonsets";
  const apiPath = `/apis/apps/v1/namespaces/${entry.namespace}/${kindPath}/${entry.name}`;

  const baselineSpec = entry.baseline;
  const patch = { spec: { template: { spec: { containers: [] } } } };

  if (baselineSpec.replicas !== undefined && entry.changes.some(c => c.field === "replicas")) {
    patch.spec.replicas = baselineSpec.replicas;
  }
  for (const bc of baselineSpec.containers) {
    const container = { name: bc.name, image: bc.image };
    if (bc.env && bc.env.length > 0) {
      container.env = bc.env.map(e => {
        if (e.from) return { name: e.name, valueFrom: JSON.parse(e.from) };
        return { name: e.name, value: e.value };
      });
    }
    if (bc.resources) container.resources = bc.resources;
    patch.spec.template.spec.containers.push(container);
  }

  await ocpPatch(apiPath, patch, "application/strategic-merge-patch+json");
  const key = workloadKey(entry.namespace, entry.kind, entry.name);
  _baselines.set(key, baselineSpec);
  entry.acknowledged = true;
  return { found: true, id: changeId, action: "dismissed", rolledBack: true };
}

export function getWorkloadsByNamespace() {
  const byNs = {};
  for (const [key, spec] of _baselines) {
    const parts = key.split("/");
    const ns = parts[0];
    const kind = parts[1];
    const name = parts[2];
    if (!byNs[ns]) byNs[ns] = [];
    byNs[ns].push({
      kind,
      name,
      replicas: spec.replicas,
      containers: spec.containers.map(c => ({ name: c.name, image: c.image })),
      snapshotTime: spec.snapshotTime,
    });
  }
  return byNs;
}

function workloadKey(ns, kind, name) { return `${ns}/${kind}/${name}`; }

export async function discoverAppNamespaces() {
  try {
    const data = await ocpGet("/api/v1/namespaces");
    const namespaces = (data.items || [])
      .map(ns => ns.metadata.name)
      .filter(name =>
        !SYSTEM_NS_EXACT.has(name) &&
        !SYSTEM_NS_PREFIXES.some(prefix => name.startsWith(prefix))
      );

    const BATCH_SIZE = 20;
    const allResults = [];
    for (let i = 0; i < namespaces.length; i += BATCH_SIZE) {
      const batch = namespaces.slice(i, i + BATCH_SIZE);
      const checks = await Promise.allSettled(
        batch.map(async ns => {
          const [deps, sts, ds, rs, pods] = await Promise.allSettled([
            ocpGet(`/apis/apps/v1/namespaces/${ns}/deployments`),
            ocpGet(`/apis/apps/v1/namespaces/${ns}/statefulsets`),
            ocpGet(`/apis/apps/v1/namespaces/${ns}/daemonsets`),
            ocpGet(`/apis/apps/v1/namespaces/${ns}/replicasets`),
            ocpGet(`/api/v1/namespaces/${ns}/pods`),
          ]);
          const depCount = deps.status === "fulfilled" ? (deps.value.items || []).length : 0;
          const stsCount = sts.status === "fulfilled" ? (sts.value.items || []).length : 0;
          const dsCount = ds.status === "fulfilled" ? (ds.value.items || []).length : 0;
          const rsCount = rs.status === "fulfilled" ? (rs.value.items || []).length : 0;
          const podCount = pods.status === "fulfilled" ? (pods.value.items || []).length : 0;
          const count = depCount + stsCount + dsCount + rsCount + podCount;
          return { ns, count, breakdown: { deployments: depCount, statefulsets: stsCount, daemonsets: dsCount, replicasets: rsCount, pods: podCount } };
        })
      );
      for (const c of checks) {
        if (c.status === "fulfilled") {
          allResults.push(c.value);
        }
      }
    }
    return allResults.sort((a, b) => b.count - a.count);
  } catch (e) {
    console.warn("[app-watcher] Auto-discovery error:", e.message);
    return [];
  }
}

export async function autoDiscoverAndWatch() {
  const discovered = await discoverAppNamespaces();
  let added = 0;
  for (const { ns } of discovered) {
    if (!_watchedNamespaces.has(ns)) {
      _watchedNamespaces.add(ns);
      added++;
      try {
        const workloads = await fetchWorkloads(ns);
        for (const w of workloads) {
          const key = workloadKey(ns, w.kind, w.metadata.name);
          _baselines.set(key, extractSpec(w));
        }
      } catch {}
    }
  }
  return { discovered: discovered.length, added, total: _watchedNamespaces.size, namespaces: discovered };
}

function extractSpec(resource) {
  const spec = resource.spec?.template?.spec || {};
  const containers = (spec.containers || []).map(c => ({
    name: c.name,
    image: c.image,
    env: (c.env || []).map(e => ({ name: e.name, value: e.value, from: e.valueFrom ? JSON.stringify(e.valueFrom) : undefined })),
    resources: c.resources,
    ports: c.ports,
    command: c.command,
    args: c.args,
  }));
  const configMapRefs = new Set();
  const secretRefs = new Set();
  for (const c of spec.containers || []) {
    for (const ef of c.envFrom || []) {
      if (ef.configMapRef?.name) configMapRefs.add(ef.configMapRef.name);
      if (ef.secretRef?.name) secretRefs.add(ef.secretRef.name);
    }
    for (const e of c.env || []) {
      if (e.valueFrom?.configMapKeyRef?.name) configMapRefs.add(e.valueFrom.configMapKeyRef.name);
      if (e.valueFrom?.secretKeyRef?.name) secretRefs.add(e.valueFrom.secretKeyRef.name);
    }
  }
  for (const v of spec.volumes || []) {
    if (v.configMap?.name) configMapRefs.add(v.configMap.name);
    if (v.secret?.secretName) secretRefs.add(v.secret.secretName);
  }
  return {
    replicas: resource.spec?.replicas,
    containers,
    configMaps: [...configMapRefs].sort(),
    secrets: [...secretRefs].sort(),
    serviceAccountName: spec.serviceAccountName,
    generation: resource.metadata?.generation,
    resourceVersion: resource.metadata?.resourceVersion,
    labels: resource.metadata?.labels || {},
    annotations: resource.metadata?.annotations || {},
    snapshotTime: new Date().toISOString(),
  };
}

function classifyChangeType(changes) {
  const fields = changes.map(c => c.field);
  if (fields.some(f => f.includes("/image"))) return "image-update";
  if (fields.some(f => f.includes("/env/"))) return "config-change";
  if (fields.some(f => f === "replicas")) return "scale";
  if (fields.some(f => f.includes("configMapRef") || f.includes("secretRef"))) return "config-change";
  if (fields.some(f => f.includes("/resources"))) return "resource-tune";
  if (fields.some(f => f.includes("container/") && (f.includes("added") || f.includes("removed")))) return "container-change";
  return "other";
}

function diffSpecs(baseline, current, kind, name, ns) {
  const changes = [];
  if (baseline.replicas !== current.replicas) {
    changes.push({ field: "replicas", old: baseline.replicas, new: current.replicas, severity: "warning" });
  }
  const bContainers = new Map(baseline.containers.map(c => [c.name, c]));
  for (const cc of current.containers) {
    const bc = bContainers.get(cc.name);
    if (!bc) { changes.push({ field: `container/${cc.name}`, old: "(none)", new: "added", severity: "critical" }); continue; }
    if (bc.image !== cc.image) {
      changes.push({ field: `container/${cc.name}/image`, old: bc.image, new: cc.image, severity: "critical" });
    }
    const bcEnvMap = new Map((bc.env || []).map(e => [e.name, e.value || e.from]));
    for (const e of cc.env || []) {
      const bVal = bcEnvMap.get(e.name);
      const cVal = e.value || e.from;
      if (bVal === undefined) { changes.push({ field: `container/${cc.name}/env/${e.name}`, old: "(none)", new: cVal, severity: "warning" }); }
      else if (bVal !== cVal) { changes.push({ field: `container/${cc.name}/env/${e.name}`, old: bVal, new: cVal, severity: "warning" }); }
    }
    const bcResStr = JSON.stringify(bc.resources || {});
    const ccResStr = JSON.stringify(cc.resources || {});
    if (bcResStr !== ccResStr) { changes.push({ field: `container/${cc.name}/resources`, old: bcResStr, new: ccResStr, severity: "info" }); }
  }
  for (const bc of baseline.containers) {
    if (!current.containers.find(c => c.name === bc.name)) {
      changes.push({ field: `container/${bc.name}`, old: bc.name, new: "(removed)", severity: "critical" });
    }
  }
  const addedCMs = current.configMaps.filter(c => !baseline.configMaps.includes(c));
  const removedCMs = baseline.configMaps.filter(c => !current.configMaps.includes(c));
  for (const c of addedCMs) changes.push({ field: "configMapRef", old: "(none)", new: c, severity: "warning" });
  for (const c of removedCMs) changes.push({ field: "configMapRef", old: c, new: "(removed)", severity: "warning" });
  if (baseline.serviceAccountName !== current.serviceAccountName) {
    changes.push({ field: "serviceAccountName", old: baseline.serviceAccountName, new: current.serviceAccountName, severity: "warning" });
  }
  return changes;
}

async function fetchWorkloads(namespace) {
  const [deps, sts, ds] = await Promise.allSettled([
    ocpGet(`/apis/apps/v1/namespaces/${namespace}/deployments`),
    ocpGet(`/apis/apps/v1/namespaces/${namespace}/statefulsets`),
    ocpGet(`/apis/apps/v1/namespaces/${namespace}/daemonsets`),
  ]);
  const items = [];
  if (deps.status === "fulfilled") for (const d of deps.value.items || []) items.push({ kind: "Deployment", ...d });
  if (sts.status === "fulfilled") for (const s of sts.value.items || []) items.push({ kind: "StatefulSet", ...s });
  if (ds.status === "fulfilled") for (const d of ds.value.items || []) items.push({ kind: "DaemonSet", ...d });
  return items;
}

function recordChange(entry) {
  _changeLog.unshift(entry);
  if (_changeLog.length > MAX_CHANGES) _changeLog.length = MAX_CHANGES;

  _changeTimeline.push({
    timestamp: entry.timestamp,
    namespace: entry.namespace,
    kind: entry.kind,
    name: entry.name,
    severity: entry.severity,
    changeType: entry.changeType,
    changeCount: entry.changes.length,
  });
  if (_changeTimeline.length > MAX_TIMELINE) _changeTimeline.splice(0, _changeTimeline.length - MAX_TIMELINE);
}

export async function scanForChanges() {
  const results = [];
  const namespaces = [..._watchedNamespaces];
  if (namespaces.length === 0) return results;

  for (const ns of namespaces) {
    try {
      const workloads = await fetchWorkloads(ns);
      for (const w of workloads) {
        const key = workloadKey(ns, w.kind, w.metadata.name);
        const current = extractSpec(w);
        const baseline = _baselines.get(key);
        if (!baseline) {
          _baselines.set(key, current);
          continue;
        }
        if (baseline.generation === current.generation) continue;
        const diffs = diffSpecs(baseline, current, w.kind, w.metadata.name, ns);
        if (diffs.length > 0) {
          const changeType = classifyChangeType(diffs);
          const entry = {
            id: `chg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            namespace: ns,
            kind: w.kind,
            name: w.metadata.name,
            timestamp: new Date().toISOString(),
            changes: diffs,
            changeType,
            baseline,
            currentSpec: current,
            severity: diffs.some(d => d.severity === "critical") ? "critical" : diffs.some(d => d.severity === "warning") ? "warning" : "info",
            acknowledged: false,
          };
          recordChange(entry);
          results.push(entry);
        }
        _baselines.set(key, current);
      }
    } catch (e) {
      console.warn(`[app-watcher] Error scanning namespace ${ns}:`, e.message);
    }
  }
  return results;
}

export async function scanGitOpsDrift() {
  try {
    const data = await ocpGet(`/${ARGO_API}/namespaces/${GITOPS_NS}/applications`);
    const apps = data.items || [];
    const driftResults = [];

    for (const app of apps) {
      const name = app.metadata.name;
      const syncStatus = app.status?.sync?.status || "Unknown";
      const healthStatus = app.status?.health?.status || "Unknown";
      const targetNs = app.spec?.destination?.namespace || "N/A";
      const repoURL = app.spec?.source?.repoURL || app.spec?.sources?.[0]?.repoURL || "N/A";
      const targetRevision = app.spec?.source?.targetRevision || app.spec?.sources?.[0]?.targetRevision || "HEAD";
      const lastSynced = app.status?.operationState?.finishedAt || null;
      const reconciledAt = app.status?.reconciledAt || null;

      const outOfSyncResources = [];
      if (syncStatus === "OutOfSync" && app.status?.resources) {
        for (const r of app.status.resources) {
          if (r.status === "OutOfSync") {
            outOfSyncResources.push({
              kind: r.kind,
              name: r.name,
              namespace: r.namespace || targetNs,
              group: r.group || "",
            });
          }
        }
      }

      const conditions = (app.status?.conditions || []).map(c => ({
        type: c.type,
        message: (c.message || "").slice(0, 200),
      }));

      const driftEntry = {
        appName: name,
        namespace: app.metadata.namespace,
        targetNamespace: targetNs,
        syncStatus,
        healthStatus,
        repoURL,
        targetRevision,
        lastSynced,
        reconciledAt,
        outOfSyncResources,
        conditions,
        isDrifted: syncStatus === "OutOfSync",
        isHealthy: healthStatus === "Healthy",
        driftSeverity: syncStatus === "OutOfSync" ? (healthStatus !== "Healthy" ? "critical" : "warning") : "ok",
      };

      _gitopsDriftCache.set(name, driftEntry);
      driftResults.push(driftEntry);
    }

    return driftResults;
  } catch (e) {
    console.warn("[app-watcher] GitOps drift scan error:", e.message);
    return [];
  }
}

export function getTimelineStats() {
  const now = Date.now();
  const h1 = new Date(now - 3600000).toISOString();
  const h6 = new Date(now - 6 * 3600000).toISOString();
  const h24 = new Date(now - 24 * 3600000).toISOString();

  const last1h = _changeTimeline.filter(e => e.timestamp >= h1);
  const last6h = _changeTimeline.filter(e => e.timestamp >= h6);
  const last24h = _changeTimeline.filter(e => e.timestamp >= h24);

  const hourlyBuckets = [];
  for (let i = 23; i >= 0; i--) {
    const bucketStart = new Date(now - (i + 1) * 3600000).toISOString();
    const bucketEnd = new Date(now - i * 3600000).toISOString();
    const entries = _changeTimeline.filter(e => e.timestamp >= bucketStart && e.timestamp < bucketEnd);
    hourlyBuckets.push({
      hour: new Date(now - i * 3600000).getHours(),
      total: entries.length,
      critical: entries.filter(e => e.severity === "critical").length,
      warning: entries.filter(e => e.severity === "warning").length,
      info: entries.filter(e => e.severity === "info").length,
    });
  }

  const byType = {};
  for (const e of last24h) {
    byType[e.changeType] = (byType[e.changeType] || 0) + 1;
  }

  const byNamespace = {};
  for (const e of last24h) {
    byNamespace[e.namespace] = (byNamespace[e.namespace] || 0) + 1;
  }

  return {
    last1h: last1h.length,
    last6h: last6h.length,
    last24h: last24h.length,
    hourlyBuckets,
    byType,
    byNamespace,
    velocity: last1h.length,
  };
}

export function registerAppChangeWatcherTools(server) {
  server.tool(
    "app_watch_namespaces",
    "Add or list namespaces being watched for application code/config changes at the pod level",
    {
      action: z.enum(["add", "remove", "list", "discover"]).describe("Action to perform. 'discover' auto-finds app namespaces"),
      namespaces: z.array(z.string()).optional().describe("Namespace(s) to add/remove"),
    },
    async ({ action, namespaces }) => {
      if (action === "discover") {
        const result = await autoDiscoverAndWatch();
        const lines = [`### Auto-Discovery Results\n`, `Found **${result.discovered}** application namespace(s), added **${result.added}** new.`, `Now watching **${result.total}** namespace(s):\n`];
        for (const { ns, count } of result.namespaces) {
          const isNew = !_watchedNamespaces.has(ns) ? " (new)" : "";
          lines.push(`  - **${ns}** — ${count} deployment(s)${isNew}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
      if (action === "list") {
        const list = [..._watchedNamespaces];
        return { content: [{ type: "text", text: list.length > 0 ? `Watched namespaces (${list.length}):\n${list.map(n => `  - ${n}`).join("\n")}` : "No namespaces are being watched. Use action 'add' to start monitoring, or 'discover' to auto-find app namespaces." }] };
      }
      if (!namespaces || namespaces.length === 0) {
        return { content: [{ type: "text", text: "Please provide at least one namespace." }], isError: true };
      }
      for (const ns of namespaces) {
        if (action === "add") _watchedNamespaces.add(ns);
        else _watchedNamespaces.delete(ns);
      }
      if (action === "add") {
        for (const ns of namespaces) {
          try {
            const workloads = await fetchWorkloads(ns);
            for (const w of workloads) {
              const key = workloadKey(ns, w.kind, w.metadata.name);
              _baselines.set(key, extractSpec(w));
            }
          } catch {}
        }
      }
      return { content: [{ type: "text", text: `${action === "add" ? "Added" : "Removed"} ${namespaces.length} namespace(s). Now watching: ${[..._watchedNamespaces].join(", ") || "(none)"}` }] };
    }
  );

  server.tool(
    "app_change_scan",
    "Scan watched namespaces for application changes (image updates, config changes, env var modifications, replica changes)",
    {},
    async () => {
      if (_watchedNamespaces.size === 0) {
        const disco = await autoDiscoverAndWatch();
        if (_watchedNamespaces.size === 0) {
          return { content: [{ type: "text", text: "No namespaces being watched and auto-discovery found none. Use app_watch_namespaces to add namespaces." }] };
        }
      }
      const changes = await scanForChanges();
      if (changes.length === 0) {
        return { content: [{ type: "text", text: `No changes detected across ${_watchedNamespaces.size} watched namespace(s) since last scan.\nBaselines tracked: ${_baselines.size} workload(s)` }] };
      }
      const lines = [`### Application Changes Detected\n`, `${changes.length} workload(s) changed across watched namespaces:\n`];
      for (const c of changes) {
        lines.push(`**${c.kind}/${c.name}** (${c.namespace}) — ${c.severity.toUpperCase()} [${c.changeType}]`);
        for (const d of c.changes) {
          lines.push(`  - \`${d.field}\`: \`${d.old}\` → \`${d.new}\` [${d.severity}]`);
        }
        lines.push("");
      }
      lines.push("Use `app_change_history` to view full change log or `app_change_rollback` to revert.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "app_change_history",
    "View the history of detected application changes across watched namespaces",
    {
      namespace: z.string().optional().describe("Filter by namespace"),
      limit: z.number().optional().describe("Max entries to return (default 20)"),
    },
    async ({ namespace, limit }) => {
      let entries = _changeLog;
      if (namespace) entries = entries.filter(e => e.namespace === namespace);
      const max = limit || 20;
      entries = entries.slice(0, max);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No changes recorded yet." }] };
      }
      const lines = [`### Application Change History (${entries.length} entries)\n`];
      lines.push("| Time | Namespace | Kind | Name | Type | Severity | Changes |");
      lines.push("|------|-----------|------|------|------|----------|---------|");
      for (const e of entries) {
        const changes = e.changes.map(c => c.field).join(", ");
        lines.push(`| ${e.timestamp.slice(0, 19)} | ${e.namespace} | ${e.kind} | ${e.name} | ${e.changeType || "-"} | ${e.severity.toUpperCase()} | ${changes} |`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "app_change_rollback",
    "Rollback a workload to its previous baseline state (reverts image, env, replicas to the snapshot before the change)",
    {
      changeId: z.string().describe("Change ID from the change log (e.g. chg-...)"),
      dryRun: z.boolean().optional().describe("If true, only show what would change without applying"),
    },
    async ({ changeId, dryRun }) => {
      const entry = _changeLog.find(e => e.id === changeId);
      if (!entry) {
        return { content: [{ type: "text", text: `Change ID '${changeId}' not found. Use app_change_history to list changes.` }], isError: true };
      }
      const kindPath = entry.kind === "Deployment" ? "deployments" : entry.kind === "StatefulSet" ? "statefulsets" : "daemonsets";
      const apiPath = `/apis/apps/v1/namespaces/${entry.namespace}/${kindPath}/${entry.name}`;

      const lines = [`### Rollback: ${entry.kind}/${entry.name} in ${entry.namespace}\n`];
      lines.push("Changes to revert:");
      for (const c of entry.changes) {
        lines.push(`  - \`${c.field}\`: \`${c.new}\` → \`${c.old}\``);
      }

      if (dryRun) {
        lines.push("\n**Dry run** — no changes applied. Remove dryRun flag to execute.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      try {
        const current = await ocpGet(apiPath);
        const baselineSpec = entry.baseline;
        const patch = { spec: { template: { spec: { containers: [] } } } };

        if (baselineSpec.replicas !== undefined && entry.changes.some(c => c.field === "replicas")) {
          patch.spec.replicas = baselineSpec.replicas;
        }

        for (const bc of baselineSpec.containers) {
          const container = { name: bc.name, image: bc.image };
          if (bc.env && bc.env.length > 0) {
            container.env = bc.env.map(e => {
              if (e.from) return { name: e.name, valueFrom: JSON.parse(e.from) };
              return { name: e.name, value: e.value };
            });
          }
          if (bc.resources) container.resources = bc.resources;
          patch.spec.template.spec.containers.push(container);
        }

        await ocpPatch(apiPath, patch, "application/strategic-merge-patch+json");

        const key = workloadKey(entry.namespace, entry.kind, entry.name);
        _baselines.set(key, baselineSpec);
        entry.acknowledged = true;

        lines.push(`\n**Rollback applied successfully.** The ${entry.kind} will reconcile to the previous state.`);
        lines.push(`Use \`oc rollout status ${entry.kind.toLowerCase()}/${entry.name} -n ${entry.namespace}\` to monitor.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Rollback failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "app_gitops_drift",
    "Check ArgoCD/OpenShift GitOps applications for drift between live state and Git-desired state",
    {
      appName: z.string().optional().describe("Specific ArgoCD application name to check (omit for all)"),
    },
    async ({ appName }) => {
      const driftResults = await scanGitOpsDrift();
      if (driftResults.length === 0) {
        return { content: [{ type: "text", text: "No ArgoCD applications found, or GitOps operator not installed." }] };
      }

      let filtered = appName ? driftResults.filter(d => d.appName === appName) : driftResults;
      if (filtered.length === 0) {
        return { content: [{ type: "text", text: `ArgoCD application '${appName}' not found.` }], isError: true };
      }

      const synced = filtered.filter(d => !d.isDrifted).length;
      const drifted = filtered.filter(d => d.isDrifted).length;
      const unhealthy = filtered.filter(d => !d.isHealthy).length;

      const lines = [
        `### GitOps Drift Report\n`,
        `**${filtered.length}** application(s) — **${synced}** synced, **${drifted}** drifted, **${unhealthy}** unhealthy\n`,
      ];

      for (const d of filtered) {
        const syncIcon = d.isDrifted ? "DRIFTED" : "SYNCED";
        const healthIcon = d.isHealthy ? "Healthy" : d.healthStatus;
        lines.push(`**${d.appName}** → ${d.targetNamespace}`);
        lines.push(`  Sync: ${syncIcon} | Health: ${healthIcon} | Repo: ${d.repoURL}`);
        if (d.lastSynced) lines.push(`  Last synced: ${d.lastSynced}`);
        if (d.outOfSyncResources.length > 0) {
          lines.push(`  Out-of-sync resources:`);
          for (const r of d.outOfSyncResources.slice(0, 10)) {
            lines.push(`    - ${r.kind}/${r.name} (${r.namespace})`);
          }
        }
        if (d.conditions.length > 0) {
          for (const c of d.conditions.slice(0, 3)) {
            lines.push(`  Condition: ${c.type} — ${c.message}`);
          }
        }
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
