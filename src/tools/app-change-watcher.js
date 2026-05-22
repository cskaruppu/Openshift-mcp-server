import { z } from "zod";
import { ocpGet, ocpPatch } from "../utils/openshift-client.js";

const _watchedNamespaces = new Set(
  (process.env.WATCHED_APP_NAMESPACES || "").split(",").map(s => s.trim()).filter(Boolean)
);
const _baselines = new Map();
const _changeLog = [];
const MAX_CHANGES = 200;

export function getWatchedNamespaces() { return [..._watchedNamespaces]; }
export function getBaselines() { return Object.fromEntries(_baselines); }
export function getChangeLog() { return _changeLog.slice(); }

function workloadKey(ns, kind, name) { return `${ns}/${kind}/${name}`; }

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
    snapshotTime: new Date().toISOString(),
  };
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
          const entry = {
            id: `chg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            namespace: ns,
            kind: w.kind,
            name: w.metadata.name,
            timestamp: new Date().toISOString(),
            changes: diffs,
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

export function registerAppChangeWatcherTools(server) {
  server.tool(
    "app_watch_namespaces",
    "Add or list namespaces being watched for application code/config changes at the pod level",
    {
      action: z.enum(["add", "remove", "list"]).describe("Action to perform"),
      namespaces: z.array(z.string()).optional().describe("Namespace(s) to add/remove"),
    },
    async ({ action, namespaces }) => {
      if (action === "list") {
        const list = [..._watchedNamespaces];
        return { content: [{ type: "text", text: list.length > 0 ? `Watched namespaces (${list.length}):\n${list.map(n => `  - ${n}`).join("\n")}` : "No namespaces are being watched. Use action 'add' to start monitoring." }] };
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
        return { content: [{ type: "text", text: "No namespaces being watched. Use app_watch_namespaces to add namespaces first." }] };
      }
      const changes = await scanForChanges();
      if (changes.length === 0) {
        return { content: [{ type: "text", text: `No changes detected across ${_watchedNamespaces.size} watched namespace(s) since last scan.\nBaselines tracked: ${_baselines.size} workload(s)` }] };
      }
      const lines = [`### Application Changes Detected\n`, `${changes.length} workload(s) changed across watched namespaces:\n`];
      for (const c of changes) {
        lines.push(`**${c.kind}/${c.name}** (${c.namespace}) — ${c.severity.toUpperCase()}`);
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
      lines.push("| Time | Namespace | Kind | Name | Severity | Changes |");
      lines.push("|------|-----------|------|------|----------|---------|");
      for (const e of entries) {
        const changes = e.changes.map(c => c.field).join(", ");
        lines.push(`| ${e.timestamp.slice(0, 19)} | ${e.namespace} | ${e.kind} | ${e.name} | ${e.severity.toUpperCase()} | ${changes} |`);
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
}
