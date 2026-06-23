import { z } from "zod";
import { ocpGet, ocpPatch, ocpPost } from "../utils/openshift-client.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { query as dbQuery } from "../utils/db.js";
import { recordChangeEvent as recordTimelineEvent } from "../services/change-timeline.js";
import { callLLM } from "../services/llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSIST_DIR = join(__dirname, "..", "..", "data");
const PERSIST_FILE = join(PERSIST_DIR, "tracked-namespaces.json");
const STATE_FILE = join(PERSIST_DIR, "watcher-state.json");

const CM_NAME = "mcp-tracked-namespaces";
const CM_KEY = "namespaces";

function getPodNamespace() {
  try { return readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8").trim(); }
  catch { return process.env.POD_NAMESPACE || process.env.MCP_NAMESPACE || "openshift-mcp"; }
}

async function loadFromConfigMap() {
  try {
    const ns = getPodNamespace();
    const cm = await ocpGet(`/api/v1/namespaces/${ns}/configmaps/${CM_NAME}`);
    const raw = (cm.data && cm.data[CM_KEY]) || "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return null; }
}

async function saveToConfigMap(nsList) {
  const ns = getPodNamespace();
  const data = { [CM_KEY]: JSON.stringify(nsList) };
  try {
    await ocpPatch(`/api/v1/namespaces/${ns}/configmaps/${CM_NAME}`, { data }, "application/merge-patch+json");
    return true;
  } catch {
    try {
      await ocpPost(`/api/v1/namespaces/${ns}/configmaps`, {
        apiVersion: "v1", kind: "ConfigMap",
        metadata: { name: CM_NAME, namespace: ns, labels: { app: "agentic-ai-server", component: "app-change-watcher" } },
        data,
      });
      return true;
    } catch (e) {
      console.warn("[app-watcher] ConfigMap save failed:", e.message);
      return false;
    }
  }
}

async function loadFromDb() {
  try {
    const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", ["tracked_namespaces"]);
    if (result && result.rows && result.rows.length > 0) {
      const val = result.rows[0].value;
      return Array.isArray(val) ? val : [];
    }
  } catch {}
  return null;
}

async function saveToDb(nsList) {
  try {
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      ["tracked_namespaces", JSON.stringify(nsList)]
    );
    return true;
  } catch { return false; }
}

function loadAllFromFile() {
  try {
    const data = JSON.parse(readFileSync(PERSIST_FILE, "utf8"));
    if (Array.isArray(data)) return { local: data };
    if (data && typeof data === "object") return data;
    return {};
  } catch { return {}; }
}

function loadFromFile() {
  const all = loadAllFromFile();
  return Array.isArray(all.local) ? all.local : [];
}

function saveToFile(nsList, cluster = "local") {
  try {
    mkdirSync(PERSIST_DIR, { recursive: true });
    let all = {};
    try { all = JSON.parse(readFileSync(PERSIST_FILE, "utf8")); } catch {}
    if (Array.isArray(all)) all = { local: all };
    all[cluster] = nsList;
    writeFileSync(PERSIST_FILE, JSON.stringify(all, null, 2));
    console.log(`[app-watcher] Saved ${nsList.length} namespaces for cluster "${cluster}" to file`);
  } catch (e) {
    console.error("[app-watcher] saveToFile failed:", e.message);
  }
}

async function persistNamespaces(cluster = "local") {
  const s = _cs(cluster);
  const nsList = [...s.watchedNamespaces];
  let saved = false;
  if (!cluster || cluster === "local") {
    saved = await saveToConfigMap(nsList) || await saveToDb(nsList);
  }
  saveToFile(nsList, cluster);
  console.log(`[app-watcher] Tracked namespaces persisted for "${cluster}":`, nsList.length, nsList);
}

function getWatcherState() {
  return {
    changeLog: _changeLog.slice(0, MAX_CHANGES),
    baselines: Object.fromEntries(_baselines),
    changeHistory: _changeHistory.slice(0, MAX_HISTORY),
    resolvedIds: [..._resolvedIds],
    dismissedKeys: Object.fromEntries(_dismissedKeys),
    lastScanTime: _lastScanTime,
    lastChangeTime: _lastChangeTime,
  };
}

async function persistWatcherState() {
  const state = getWatcherState();
  try {
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      ["watcher_state", JSON.stringify(state)]
    );
  } catch {}
  try {
    mkdirSync(PERSIST_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

async function loadWatcherState() {
  let state = null;
  try {
    const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", ["watcher_state"]);
    if (result?.rows?.length > 0) {
      state = typeof result.rows[0].value === "string" ? JSON.parse(result.rows[0].value) : result.rows[0].value;
    }
  } catch {}
  if (!state) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {}
  }
  if (!state) return;

  if (Array.isArray(state.changeLog)) {
    _changeLog.length = 0;
    for (const e of state.changeLog) _changeLog.push(e);
    console.log("[app-watcher] Restored", _changeLog.length, "pending changes");
  }
  if (state.baselines && typeof state.baselines === "object") {
    for (const [k, v] of Object.entries(state.baselines)) _baselines.set(k, v);
    console.log("[app-watcher] Restored", _baselines.size, "baselines");
  }
  if (Array.isArray(state.changeHistory)) {
    _changeHistory.length = 0;
    for (const h of state.changeHistory) _changeHistory.push(h);
  }
  if (Array.isArray(state.resolvedIds)) {
    for (const id of state.resolvedIds) _resolvedIds.add(id);
  }
  if (state.dismissedKeys && typeof state.dismissedKeys === "object") {
    for (const [k, v] of Object.entries(state.dismissedKeys)) _dismissedKeys.set(k, v);
  }
  if (state.lastScanTime) _lastScanTime = state.lastScanTime;
  if (state.lastChangeTime) _lastChangeTime = state.lastChangeTime;
}

let _persistInitDone = false;
async function ensurePersistedLoad() {
  if (_persistInitDone) return;
  _persistInitDone = true;
  const cmList = await loadFromConfigMap();
  if (cmList && cmList.length > 0) {
    for (const ns of cmList) _watchedNamespaces.add(ns);
    console.log("[app-watcher] Loaded", cmList.length, "namespaces from ConfigMap");
  } else {
    const dbList = await loadFromDb();
    if (dbList && dbList.length > 0) {
      for (const ns of dbList) _watchedNamespaces.add(ns);
      console.log("[app-watcher] Loaded", dbList.length, "namespaces from database");
    }
  }
  await loadWatcherState();
}

const _envNamespaces = (process.env.WATCHED_APP_NAMESPACES || "").split(",").map(s => s.trim()).filter(Boolean);
const _fileNamespaces = loadFromFile();
const _allFileNamespaces = loadAllFromFile();

const MAX_CHANGES = 500;
const MAX_HISTORY = 200;
const MAX_TIMELINE = 1000;

// Per-cluster state container — each cluster gets its own isolated watcher state
const _clusterStates = new Map();
function _cs(cluster = "local") {
  if (!_clusterStates.has(cluster)) {
    let initial;
    if (cluster === "local") {
      initial = [..._envNamespaces, ..._fileNamespaces];
    } else {
      const persisted = _allFileNamespaces[cluster];
      initial = Array.isArray(persisted) ? [...persisted] : [];
    }
    _clusterStates.set(cluster, {
      watchedNamespaces: new Set(initial),
      baselines: new Map(),
      changeLog: [],
      resolvedIds: new Set(),
      dismissedKeys: new Map(),
      changeHistory: [],
      lastScanTime: null,
      lastChangeTime: null,
      gitopsDriftCache: new Map(),
      changeTimeline: [],
    });
  }
  return _clusterStates.get(cluster);
}

// Legacy compat — keep references for MCP tool handlers that don't pass cluster
const _watchedNamespaces = _cs("local").watchedNamespaces;
const _baselines = _cs("local").baselines;
const _changeLog = _cs("local").changeLog;
const _resolvedIds = _cs("local").resolvedIds;
const _dismissedKeys = _cs("local").dismissedKeys;
const _changeHistory = _cs("local").changeHistory;
let _lastScanTime = null;
let _lastChangeTime = null;

const _gitopsDriftCache = _cs("local").gitopsDriftCache;
const _changeTimeline = _cs("local").changeTimeline;

const SYSTEM_NS_PREFIXES = ["openshift-", "openshift", "kube-", "kube", "default"];
const SYSTEM_NS_EXACT = new Set([
  "default", "openshift", "kube-system", "kube-public", "kube-node-lease",
  "openshift-infra", "openshift-node", "openshift-config",
  "istio-system", "knative-serving", "knative-eventing",
  "cert-manager", "ingress-nginx", "metallb-system",
  "local-path-storage", "cattle-system", "fleet-system",
]);
const RISK_WEIGHTS = {
  "image-update": 85,
  "container-change": 90,
  "config-change": 60,
  "scale": 30,
  "resource-tune": 25,
  "other": 50,
};
const RISK_SEVERITY_BOOST = { critical: 15, warning: 5, info: 0 };

const BUSINESS_HOURS = {
  start: parseInt(process.env.CHANGE_FREEZE_START || "6", 10),
  end: parseInt(process.env.CHANGE_FREEZE_END || "22", 10),
  timezone: process.env.CHANGE_FREEZE_TZ || "UTC",
};

const WEBHOOK_URL = process.env.CHANGE_WEBHOOK_URL || "";
const WEBHOOK_EVENTS = (process.env.CHANGE_WEBHOOK_EVENTS || "critical,high").split(",").map(s => s.trim());

async function sendWebhook(entry) {
  if (!WEBHOOK_URL) return;
  if (!WEBHOOK_EVENTS.includes(entry.riskLevel) && !WEBHOOK_EVENTS.includes("all")) return;
  const payload = {
    event: "change_detected",
    timestamp: entry.timestamp,
    cluster: "local",
    workload: `${entry.kind}/${entry.name}`,
    namespace: entry.namespace,
    changeType: entry.changeType,
    riskScore: entry.riskScore,
    riskLevel: entry.riskLevel,
    severity: entry.severity,
    changedBy: entry.changedBy?.user || "unknown",
    changes: entry.changes.slice(0, 5).map(c => ({ field: c.field, old: c.old, new: c.new })),
    dashboardUrl: `${process.env.DASHBOARD_URL || ""}/dashboard?change=${entry.id}`,
  };
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn("[app-watcher] Webhook failed:", err.message);
  }
}

function calculateRiskScore(changeType, severity, followUp, changeCount, context) {
  let score = RISK_WEIGHTS[changeType] || 50;
  score += RISK_SEVERITY_BOOST[severity] || 0;
  if (followUp) score = Math.min(100, score + 20);
  if (changeCount > 3) score = Math.min(100, score + 10);
  if (context) {
    if (context.kind === "Secret" && context.changedFields?.every(f => f.includes("(updated)"))) {
      score = Math.max(15, score - 40);
    }
    if (context.kind === "ConfigMap" && changeCount <= 1) {
      score = Math.max(20, score - 15);
    }
    if (context.kind === "Deployment" || context.kind === "StatefulSet") {
      score = Math.min(100, score + 5);
    }
    if (context.hasImageChange) score = Math.min(100, score + 10);
    if (context.hasReplicaChange && !context.hasImageChange && changeCount === 1) {
      score = Math.max(15, Math.min(score, 35));
    }
  }
  return Math.min(100, Math.max(0, score));
}

function getRiskLevel(score) {
  if (score >= 80) return "critical";
  if (score >= 55) return "high";
  if (score >= 35) return "medium";
  return "low";
}

export function scoreNamespaceRecommendations(discoveredNamespaces, changeLog, baselines) {
  if (!discoveredNamespaces || discoveredNamespaces.length === 0) return [];

  return discoveredNamespaces.map(ns => {
    let score = 0;
    const reasons = [];
    const workloads = ns.count || (ns.breakdown ? (ns.breakdown.deployments || 0) + (ns.breakdown.statefulsets || 0) + (ns.breakdown.daemonsets || 0) : 0);

    // High workload count = more value in tracking
    if (workloads >= 10) { score += 30; reasons.push(`High workload density — ${workloads} workloads detected`); }
    else if (workloads >= 5) { score += 20; reasons.push(`${workloads} active workloads`); }
    else if (workloads >= 1) { score += 10; reasons.push(`${workloads} workload${workloads > 1 ? 's' : ''} running`); }

    // Recent changes in changelog for this namespace
    const nsChanges = (changeLog || []).filter(e => e.namespace === ns.ns || e.namespace === ns.namespace);
    if (nsChanges.length >= 5) { score += 25; reasons.push(`High change velocity — ${nsChanges.length} recent changes`); }
    else if (nsChanges.length >= 1) { score += 15; reasons.push(`${nsChanges.length} recent change${nsChanges.length > 1 ? 's' : ''} detected`); }

    // Critical changes
    const critChanges = nsChanges.filter(e => e.severity === 'critical' || e.riskLevel === 'critical');
    if (critChanges.length > 0) { score += 20; reasons.push(`${critChanges.length} critical change${critChanges.length > 1 ? 's' : ''} — needs monitoring`); }

    // Has pods (active workloads vs dormant)
    if (ns.breakdown?.pods > 10) { score += 15; reasons.push(`${ns.breakdown.pods} running pods — customer-facing risk`); }
    else if (ns.breakdown?.pods > 0) { score += 5; }

    // Known application namespaces get a boost
    const nsName = ns.ns || ns.namespace || '';
    if (nsName.includes('prod') || nsName.includes('production')) { score += 20; reasons.push('Production namespace — critical monitoring required'); }
    if (nsName.includes('staging') || nsName.includes('stage')) { score += 10; reasons.push('Staging namespace — pre-production validation'); }

    // Penalty for system-ish namespaces
    if (nsName.startsWith('openshift-') || nsName.startsWith('kube-')) { score -= 30; }

    const recommendation = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';

    return {
      namespace: ns.ns || ns.namespace,
      workloads,
      breakdown: ns.breakdown || {},
      score: Math.max(0, Math.min(100, score)),
      recommendation,
      reasons: reasons.slice(0, 3),
      aiSummary: reasons.length > 0 ? reasons[0] : 'Low activity namespace',
    };
  }).sort((a, b) => b.score - a.score);
}

export function generateRiskExplanation(change) {
  const parts = [];
  const c = change;

  // Change type significance
  if (c.changeType === 'image-update') {
    const imgChange = (c.changes || []).find(ch => ch.field?.includes('/image'));
    if (imgChange) {
      parts.push(`Image updated${imgChange.old && imgChange.new ? ` from ${imgChange.old.split('/').pop()} to ${imgChange.new.split('/').pop()}` : ''}`);
    } else {
      parts.push('Container image changed');
    }
    parts.push('Image changes affect running workloads and may introduce breaking changes');
  } else if (c.changeType === 'config-change') {
    const fieldCount = (c.changes || []).length;
    parts.push(`${fieldCount} configuration field${fieldCount !== 1 ? 's' : ''} modified`);
    if (c.kind === 'Secret') parts.push('Secret changes may affect authentication or service connectivity');
    else if (c.kind === 'ConfigMap') parts.push('ConfigMap changes propagate to mounted pods on next restart');
  } else if (c.changeType === 'scale') {
    const scaleChange = (c.changes || []).find(ch => ch.field === 'replicas');
    if (scaleChange) {
      const from = parseInt(scaleChange.old) || 0;
      const to = parseInt(scaleChange.new) || 0;
      if (to > from) parts.push(`Scaled up from ${from} to ${to} replicas — increased capacity`);
      else if (to < from) parts.push(`Scaled down from ${from} to ${to} replicas — reduced capacity`);
      if (to === 0) parts.push('WARNING: Workload scaled to zero — service will be unavailable');
      else if (to < from && to === 1) parts.push('Single replica — no high availability');
    }
  } else if (c.changeType === 'resource-tune') {
    parts.push('Resource limits/requests modified');
    parts.push('May affect pod scheduling and quality-of-service class');
  }

  // Timing context
  if (c.changeFreezeViolation) {
    parts.push('Change made outside business hours — higher risk of unreviewed modification');
  }

  // Follow-up detection
  if (c.followUp) {
    parts.push(`Follow-up change (${c.followUpCount || 'multiple'} times) — previously dismissed change has reappeared`);
  }

  // Blast radius
  const replicas = c.currentSpec?.replicas || c.blastRadius;
  if (replicas && replicas > 5) {
    parts.push(`Affects ${replicas} pod replicas across the service`);
  }

  // Risk level summary
  const score = c.riskScore || 0;
  if (score >= 80) parts.push('RECOMMENDATION: Review immediately before agreeing — high blast radius');
  else if (score >= 55) parts.push('RECOMMENDATION: Verify change source and validate in staging');
  else if (score >= 35) parts.push('RECOMMENDATION: Acknowledge and monitor for 15 minutes');
  else parts.push('Low-risk change — safe to agree');

  return parts.join('. ') + '.';
}

export function detectChangeCorrelations(changeLog) {
  if (!changeLog || changeLog.length < 2) return {};
  const correlations = {};
  const TIME_WINDOW = 5 * 60 * 1000; // 5 minutes

  for (let i = 0; i < changeLog.length; i++) {
    const a = changeLog[i];
    if (a.acknowledged) continue;
    const related = [];

    for (let j = 0; j < changeLog.length; j++) {
      if (i === j) continue;
      const b = changeLog[j];
      if (b.acknowledged) continue;

      const timeDiff = Math.abs(new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // Time proximity correlation
      if (timeDiff <= TIME_WINDOW) {
        let reason = '';
        if (a.namespace === b.namespace) {
          reason = `Same namespace, ${Math.round(timeDiff / 1000)}s apart`;
        } else if (a.changeType === b.changeType) {
          reason = `Same change type across ${a.namespace} and ${b.namespace}`;
        } else {
          reason = `Concurrent changes within ${Math.round(timeDiff / 60000)}m window`;
        }
        related.push({ id: b.id, kind: b.kind, name: b.name, namespace: b.namespace, changeType: b.changeType, reason });
      }

      // Same changedBy correlation
      if (a.changedBy?.user && b.changedBy?.user && a.changedBy.user === b.changedBy.user && a.changedBy.user !== 'unknown') {
        const existing = related.find(r => r.id === b.id);
        if (existing) existing.reason += ` — same author (${a.changedBy.user})`;
        else related.push({ id: b.id, kind: b.kind, name: b.name, namespace: b.namespace, changeType: b.changeType, reason: `Same author: ${a.changedBy.user}` });
      }
    }

    if (related.length > 0) correlations[a.id] = related.slice(0, 5);
  }

  return correlations;
}

function isOutsideBusinessHours() {
  const now = new Date();
  const hour = now.getUTCHours();
  return hour < BUSINESS_HOURS.start || hour >= BUSINESS_HOURS.end;
}

function isWeekend() {
  const day = new Date().getUTCDay();
  return day === 0 || day === 6;
}

const SYSTEM_MANAGERS = new Set([
  "kube-controller-manager", "kube-scheduler", "kube-apiserver",
  "endpoint-controller", "endpointslice-controller",
  "deployment-controller", "replicaset-controller",
  "daemonset-controller", "statefulset-controller",
  "job-controller", "cronjob-controller",
  "node-controller", "service-controller",
  "attach-detach-controller", "namespace-controller",
  "clusterrole-aggregation-controller",
]);

function isSystemManager(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (SYSTEM_MANAGERS.has(lower)) return true;
  if (lower.startsWith("system:")) return true;
  if (lower.startsWith("openshift-")) return true;
  if (lower.includes("controller-manager")) return true;
  if (lower.includes("operator")) return true;
  return false;
}

function isKubectlTool(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.startsWith("kubectl") || lower.startsWith("oc") || lower === "openshift-web-console" || lower === "console";
}

function friendlyMethodName(manager) {
  if (!manager) return null;
  const m = manager.toLowerCase();
  if (m === "kubectl-edit" || m === "oc-edit") return "CLI edit";
  if (m === "kubectl-scale" || m === "oc-scale") return "CLI scale";
  if (m === "kubectl-rollout" || m === "oc-rollout") return "CLI rollout";
  if (m === "kubectl-set" || m === "oc-set") return "CLI set";
  if (m === "kubectl-apply" || m === "oc-apply") return "CLI apply";
  if (m === "kubectl-patch" || m === "oc-patch") return "CLI patch";
  if (m === "kubectl-create" || m === "oc-create") return "CLI create";
  if (m === "kubectl-replace" || m === "oc-replace") return "CLI replace";
  if (m === "kubectl-client-side-apply") return "CLI apply";
  if (m.startsWith("kubectl") || m.startsWith("oc")) return "CLI (" + manager + ")";
  if (m === "openshift-web-console" || m === "console") return "Web Console";
  if (m.includes("argocd") || m.includes("gitops")) return "GitOps/ArgoCD";
  if (m.includes("helm")) return "Helm";
  return manager;
}

function extractChangedBy(resource, ns, kind, name) {
  const managed = resource.metadata?.managedFields;
  const annotations = resource.metadata?.annotations || {};

  const changeCause = annotations["kubernetes.io/change-cause"] || null;

  if (!managed || managed.length === 0) {
    return { user: "unknown", method: changeCause || "unknown", time: null, tool: null };
  }

  const specEntries = managed.filter(f => {
    if (f.operation !== "Update" && f.operation !== "Apply") return false;
    const fields = JSON.stringify(f.fieldsV1 || {});
    return fields.includes('"f:spec"') || f.subresource === "scale";
  });

  const candidates = specEntries.length > 0 ? specEntries : managed.filter(f => f.operation === "Update" || f.operation === "Apply");
  const sorted = candidates.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

  const humanEntry = sorted.find(e => !isSystemManager(e.manager));
  const latest = humanEntry || sorted[0] || managed[managed.length - 1];

  const rawManager = latest.manager || "unknown";
  const method = friendlyMethodName(rawManager);

  let user = "unknown";
  if (changeCause) {
    const userMatch = changeCause.match(/(?:--as[= ]|by )(\S+)/i);
    if (userMatch) user = userMatch[1];
  }

  return {
    user,
    method,
    tool: rawManager,
    operation: latest.operation || "unknown",
    time: latest.time || null,
    apiVersion: latest.apiVersion || null,
  };
}

async function enrichChangedByWithUser(changedBy, ns, kind, name) {
  if (changedBy.user !== "unknown") return changedBy;
  try {
    const apiGroup = kind === "Deployment" ? "apps" : kind === "StatefulSet" ? "apps" : kind === "DaemonSet" ? "apps" : kind === "ReplicaSet" ? "apps" : "";
    const resource = kind.toLowerCase() + "s";
    const apiPath = apiGroup ? `apis/${apiGroup}/v1` : "api/v1";
    const auditUrl = `/apis/audit.k8s.io/v1/events?fieldSelector=objectRef.name=${name},objectRef.namespace=${ns},objectRef.resource=${resource}&limit=5`;
    const auditData = await ocpGet(auditUrl);
    if (auditData?.items?.length > 0) {
      const recent = auditData.items
        .filter(e => e.user?.username && !isSystemManager(e.user.username))
        .sort((a, b) => new Date(b.stageTimestamp || b.requestReceivedTimestamp || 0) - new Date(a.stageTimestamp || a.requestReceivedTimestamp || 0));
      if (recent.length > 0) {
        changedBy.user = recent[0].user.username;
        return changedBy;
      }
    }
  } catch {}

  try {
    const eventUrl = `/api/v1/namespaces/${ns}/events?fieldSelector=involvedObject.name=${name}&limit=20`;
    const eventData = await ocpGet(eventUrl);
    if (eventData?.items?.length > 0) {
      for (const ev of eventData.items) {
        const msg = ev.message || "";
        const annot = ev.metadata?.annotations || {};
        if (annot["openshift.io/user"]) {
          changedBy.user = annot["openshift.io/user"];
          return changedBy;
        }
        if (annot["user"]) {
          changedBy.user = annot["user"];
          return changedBy;
        }
        const userInMsg = msg.match(/by user[: ]+["']?(\S+?)["']?(?:\s|$|,)/i);
        if (userInMsg) {
          changedBy.user = userInMsg[1];
          return changedBy;
        }
      }
    }
  } catch {}

  return changedBy;
}

async function correlateWithEvents(ns, kind, name) {
  try {
    const fieldSelector = `involvedObject.name=${name},involvedObject.namespace=${ns}`;
    const data = await ocpGet(`/api/v1/namespaces/${ns}/events?fieldSelector=${encodeURIComponent(fieldSelector)}&limit=10`);
    const events = (data.items || [])
      .filter(e => {
        const age = Date.now() - new Date(e.lastTimestamp || e.metadata.creationTimestamp).getTime();
        return age < 30 * 60 * 1000;
      })
      .map(e => ({
        type: e.type,
        reason: e.reason,
        message: (e.message || "").substring(0, 120),
        count: e.count || 1,
        time: e.lastTimestamp || e.metadata.creationTimestamp,
      }));
    return events;
  } catch { return []; }
}

export function getChangeHistory(cluster) { return _cs(cluster).changeHistory.slice(); }
export function getLastScanTime(cluster) { return _cs(cluster).lastScanTime; }
export function getLastChangeTime(cluster) { return _cs(cluster).lastChangeTime; }
export function getHealthStreak(cluster) {
  const s = _cs(cluster);
  if (!s.lastChangeTime) return s.lastScanTime ? Date.now() - new Date(s.lastScanTime).getTime() : 0;
  return Date.now() - new Date(s.lastChangeTime).getTime();
}

const ARGO_API = "apis/argoproj.io/v1alpha1";
const GITOPS_NS = process.env.ARGOCD_NAMESPACE || "openshift-gitops";

export { ensurePersistedLoad as initTrackedNamespaces };
export function getWatchedNamespaces(cluster) { return [..._cs(cluster).watchedNamespaces]; }
export function getBaselines(cluster) { return Object.fromEntries(_cs(cluster).baselines); }
export function getChangeLog(cluster) {
  const s = _cs(cluster);
  const seen = new Set();
  const deduped = [];
  for (const e of s.changeLog) {
    const k = `${e.namespace}/${e.kind}/${e.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(e);
  }
  if (deduped.length < s.changeLog.length) s.changeLog.length = 0, s.changeLog.push(...deduped);
  return deduped;
}
export function getChangeTimeline(cluster) { return _cs(cluster).changeTimeline.slice(); }
export function getGitOpsDrift(cluster) { return Object.fromEntries(_cs(cluster).gitopsDriftCache); }

export async function addNamespaces(nsList, cluster) {
  const s = _cs(cluster);
  for (const ns of nsList) s.watchedNamespaces.add(ns);
  await persistNamespaces(cluster || "local");
}
export async function removeNamespaces(nsList, cluster) {
  const s = _cs(cluster);
  for (const ns of nsList) {
    s.watchedNamespaces.delete(ns);
    for (const [key] of s.baselines) {
      if (key.startsWith(ns + "/")) s.baselines.delete(key);
    }
  }
  await persistNamespaces(cluster || "local");
}
export async function initNamespaceBaselines(nsList, cluster) {
  const s = _cs(cluster);
  let newBaselines = 0;
  for (const ns of nsList) {
    try {
      const workloads = await fetchWorkloads(ns);
      for (const w of workloads) {
        const key = workloadKey(ns, w.kind, w.metadata.name);
        if (!s.baselines.has(key)) {
          s.baselines.set(key, extractSpec(w));
          newBaselines++;
        }
      }
    } catch {}
  }
  if (newBaselines > 0) persistWatcherState().catch(() => {});
}

export async function acknowledgeChange(changeId, cluster) {
  const s = _cs(cluster);
  const entry = s.changeLog.find(e => e.id === changeId);
  if (!entry) return { found: false, error: "Change not found" };
  s.resolvedIds.add(changeId);
  const key = workloadKey(entry.namespace, entry.kind, entry.name);
  if (entry.currentSpec) s.baselines.set(key, entry.currentSpec);
  recordHistory(entry, "acknowledged", cluster);
  const idx = s.changeLog.indexOf(entry);
  if (idx >= 0) s.changeLog.splice(idx, 1);
  await persistWatcherState().catch(e => console.error("[watcher] persist error:", e.message));
  return { found: true, id: changeId, action: "acknowledged", resolved: true, message: `Acknowledged ${entry.kind}/${entry.name} — cleared from queue` };
}

export async function agreeChange(changeId, cluster) {
  const s = _cs(cluster);
  const entry = s.changeLog.find(e => e.id === changeId);
  if (!entry) return { found: false, error: "Change not found" };
  s.resolvedIds.add(changeId);
  recordHistory(entry, "agreed", cluster);
  const key = workloadKey(entry.namespace, entry.kind, entry.name);
  if (entry.currentSpec) s.baselines.set(key, entry.currentSpec);
  const idx = s.changeLog.indexOf(entry);
  if (idx >= 0) s.changeLog.splice(idx, 1);
  await persistWatcherState().catch(e => console.error("[watcher] persist error:", e.message));
  return { found: true, id: changeId, action: "agreed", resolved: true, message: `Agreed to ${entry.kind}/${entry.name} — baseline updated` };
}

export async function dismissChange(changeId, cluster) {
  const s = _cs(cluster);
  const entry = s.changeLog.find(e => e.id === changeId);
  if (!entry) return { found: false, error: "Change not found" };
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

  let rolledBack = false;
  let rollbackError = null;
  try {
    await ocpPatch(apiPath, patch, "application/strategic-merge-patch+json");
    rolledBack = true;
  } catch (patchErr) {
    console.error(`[watcher] dismiss rollback failed for ${entry.kind}/${entry.name}:`, patchErr.message);
    rollbackError = patchErr.message;
  }

  const key = workloadKey(entry.namespace, entry.kind, entry.name);
  if (rolledBack) {
    s.baselines.set(key, baselineSpec);
  } else {
    if (entry.currentSpec) s.baselines.set(key, entry.currentSpec);
  }
  s.dismissedKeys.set(key, { baseline: baselineSpec, dismissedAt: Date.now(), followUpCount: 0 });
  recordHistory(entry, "dismissed", cluster);
  const idx = s.changeLog.indexOf(entry);
  if (idx >= 0) s.changeLog.splice(idx, 1);
  await persistWatcherState().catch(e => console.error("[watcher] persist error:", e.message));
  const msg = rolledBack
    ? `Rolled back ${entry.kind}/${entry.name} to baseline`
    : `Dismissed ${entry.kind}/${entry.name} — change cleared from queue`;
  return { found: true, id: changeId, action: "dismissed", rolledBack, resolved: true, message: msg };
}

export async function analyzeChangeImpact(changeId, cluster) {
  const s = _cs(cluster);
  const entry = s.changeLog.find(e => e.id === changeId);
  if (!entry) return { found: false, error: "Change not found" };

  const changesText = entry.changes.map(c => `- ${c.field}: ${c.old} → ${c.new} (${c.severity})`).join("\n");
  const eventsText = (entry.correlatedEvents || []).map(e => `- ${e.type} ${e.reason}: ${e.message || ""}`).join("\n");

  const prompt = `You are a Kubernetes operations expert. Analyze this workload change and provide a brief impact assessment.

Workload: ${entry.kind}/${entry.name} in namespace ${entry.namespace}
Risk Score: ${entry.riskScore}/100 (${entry.riskLevel})
Change Type: ${entry.changeType}
Changed By: ${entry.changedBy?.user || "unknown"} via ${entry.changedBy?.method || "unknown"}
Detected: ${entry.timestamp}

Changes:
${changesText}

${eventsText ? `Correlated Events:\n${eventsText}` : "No correlated events."}

Provide a concise analysis in this exact format:
**Impact**: [One sentence: what this change does and its blast radius]
**Risk Assessment**: [One sentence: why this risk level is appropriate or needs adjustment]
**Recommendation**: [One sentence: what the operator should do - agree, dismiss, or investigate further]
**Watch For**: [One sentence: what symptoms to monitor after this change]`;

  try {
    const result = await callLLM({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400,
      temperature: 0.3,
    });
    return {
      found: true,
      id: changeId,
      analysis: result.text || result.content || "Analysis unavailable",
      analyzedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { found: true, id: changeId, error: `AI analysis failed: ${err.message}` };
  }
}

export async function bulkAction(action, filter, cluster) {
  const s = _cs(cluster);
  const targets = s.changeLog.filter(e => {
    if (filter.namespace && e.namespace !== filter.namespace) return false;
    if (filter.changeType && e.changeType !== filter.changeType) return false;
    if (filter.maxRisk != null && e.riskScore > filter.maxRisk) return false;
    if (filter.minRisk != null && e.riskScore < filter.minRisk) return false;
    if (filter.riskLevel && e.riskLevel !== filter.riskLevel) return false;
    return true;
  });

  if (targets.length === 0) return { processed: 0, message: "No matching changes" };

  const results = [];
  for (const entry of [...targets]) {
    try {
      let r;
      if (action === "dismiss") r = await dismissChange(entry.id, cluster);
      else if (action === "agree") r = await agreeChange(entry.id, cluster);
      else if (action === "acknowledge") r = await acknowledgeChange(entry.id, cluster);
      else return { error: `Unknown action: ${action}` };
      results.push({ id: entry.id, name: `${entry.kind}/${entry.name}`, success: r.resolved || false, error: r.error });
    } catch (err) {
      results.push({ id: entry.id, name: `${entry.kind}/${entry.name}`, success: false, error: err.message });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  return {
    processed: results.length,
    succeeded,
    failed,
    results,
    message: `Bulk ${action}: ${succeeded} succeeded, ${failed} failed`,
  };
}

export function getWorkloadTimeline(namespace, kind, name, cluster) {
  const s = _cs(cluster);
  const key = workloadKey(namespace, kind, name);
  const entries = s.changeTimeline
    .filter(e => e.namespace === namespace && e.kind === kind && e.name === name)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 20);
  const historyEntries = s.changeHistory
    .filter(e => e.namespace === namespace && e.kind === kind && e.name === name)
    .slice(0, 10);
  return { workload: `${kind}/${name}`, namespace, changes: entries, resolutions: historyEntries };
}

export function getWorkloadsByNamespace(cluster) {
  const s = _cs(cluster);
  const byNs = {};
  for (const [key, spec] of s.baselines) {
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

export async function autoDiscoverAndWatch(cluster) {
  const s = _cs(cluster);
  const discovered = await discoverAppNamespaces();
  let added = 0;
  for (const { ns } of discovered) {
    if (!s.watchedNamespaces.has(ns)) {
      s.watchedNamespaces.add(ns);
      added++;
      try {
        const workloads = await fetchWorkloads(ns);
        for (const w of workloads) {
          const key = workloadKey(ns, w.kind, w.metadata.name);
          s.baselines.set(key, extractSpec(w));
        }
      } catch {}
    }
  }
  return { discovered: discovered.length, added, total: s.watchedNamespaces.size, namespaces: discovered };
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
  if (fields.some(f => f.includes("/command") || f.includes("/args"))) return "config-change";
  if (fields.some(f => f.includes("/env/"))) return "config-change";
  if (fields.some(f => f === "replicas")) return "scale";
  if (fields.some(f => f.includes("configMapRef") || f.includes("secretRef"))) return "config-change";
  if (fields.some(f => f.includes("/ports"))) return "config-change";
  if (fields.some(f => f.includes("/resources"))) return "resource-tune";
  if (fields.some(f => f.includes("container/") && (f.includes("added") || f.includes("removed")))) return "container-change";
  if (fields.some(f => f === "serviceAccountName")) return "config-change";
  return "other";
}

function formatPorts(ports) {
  if (!ports || ports.length === 0) return "";
  return ports.map(p => `${p.containerPort}/${p.protocol || "TCP"}`).join(",");
}

function diffSpecs(baseline, current, kind, name, ns) {
  const changes = [];
  if (baseline.replicas !== current.replicas) {
    changes.push({ field: "replicas", old: String(baseline.replicas), new: String(current.replicas), severity: "warning" });
  }
  const bContainers = new Map(baseline.containers.map(c => [c.name, c]));
  for (const cc of current.containers) {
    const bc = bContainers.get(cc.name);
    if (!bc) { changes.push({ field: `container/${cc.name}`, old: "(none)", new: "added", severity: "critical" }); continue; }
    if (bc.image !== cc.image) {
      changes.push({ field: `container/${cc.name}/image`, old: bc.image, new: cc.image, severity: "critical" });
    }
    const bPorts = formatPorts(bc.ports);
    const cPorts = formatPorts(cc.ports);
    if (bPorts !== cPorts) {
      changes.push({ field: `container/${cc.name}/ports`, old: bPorts || "(none)", new: cPorts || "(none)", severity: "warning" });
    }
    const bCmd = JSON.stringify(bc.command || []);
    const cCmd = JSON.stringify(cc.command || []);
    if (bCmd !== cCmd) {
      changes.push({ field: `container/${cc.name}/command`, old: bCmd, new: cCmd, severity: "critical" });
    }
    const bArgs = JSON.stringify(bc.args || []);
    const cArgs = JSON.stringify(cc.args || []);
    if (bArgs !== cArgs) {
      changes.push({ field: `container/${cc.name}/args`, old: bArgs, new: cArgs, severity: "warning" });
    }
    const bcEnvMap = new Map((bc.env || []).map(e => [e.name, e.value || e.from]));
    const ccEnvMap = new Map((cc.env || []).map(e => [e.name, e.value || e.from]));
    for (const e of cc.env || []) {
      const bVal = bcEnvMap.get(e.name);
      const cVal = e.value || e.from;
      if (bVal === undefined) { changes.push({ field: `container/${cc.name}/env/${e.name}`, old: "(none)", new: cVal, severity: "warning" }); }
      else if (bVal !== cVal) { changes.push({ field: `container/${cc.name}/env/${e.name}`, old: bVal, new: cVal, severity: "warning" }); }
    }
    for (const e of bc.env || []) {
      if (!ccEnvMap.has(e.name)) {
        changes.push({ field: `container/${cc.name}/env/${e.name}`, old: e.value || e.from, new: "(removed)", severity: "warning" });
      }
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
  const addedSecs = current.secrets.filter(c => !baseline.secrets.includes(c));
  const removedSecs = baseline.secrets.filter(c => !current.secrets.includes(c));
  for (const c of addedSecs) changes.push({ field: "secretRef", old: "(none)", new: c, severity: "critical" });
  for (const c of removedSecs) changes.push({ field: "secretRef", old: c, new: "(removed)", severity: "critical" });
  if (baseline.serviceAccountName !== current.serviceAccountName) {
    changes.push({ field: "serviceAccountName", old: baseline.serviceAccountName || "(default)", new: current.serviceAccountName || "(default)", severity: "warning" });
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

function recordChange(entry, cluster) {
  const s = _cs(cluster);
  s.changeLog.unshift(entry);
  if (s.changeLog.length > MAX_CHANGES) s.changeLog.length = MAX_CHANGES;
  s.lastChangeTime = entry.timestamp;

  const timelineEntry = {
    timestamp: entry.timestamp,
    namespace: entry.namespace,
    kind: entry.kind,
    name: entry.name,
    severity: entry.severity,
    changeType: entry.changeType,
    changeCount: entry.changes.length,
    riskScore: entry.riskScore,
    changedBy: entry.changedBy,
  };
  s.changeTimeline.push(timelineEntry);
  if (s.changeTimeline.length > MAX_TIMELINE) s.changeTimeline.splice(0, s.changeTimeline.length - MAX_TIMELINE);

  recordTimelineEvent({
    source: entry.kind === "ConfigMap" ? "configmap" : (entry.changeType === "scaling" ? "scaling" : "deployment"),
    eventType: entry.changeType || "change_detected",
    namespace: entry.namespace,
    resourceKind: entry.kind,
    resourceName: entry.name,
    title: `${entry.kind}/${entry.name}: ${entry.changes.length} change(s)`,
    details: { changes: entry.changes, riskScore: entry.riskScore, changedBy: entry.changedBy },
    severity: entry.severity || "info",
  }).catch((err) => console.warn("[app-change-watcher] timeline persist failed:", err.message));
  sendWebhook(entry);
}

function recordHistory(entry, action, cluster) {
  const s = _cs(cluster);
  s.changeHistory.unshift({
    id: entry.id,
    namespace: entry.namespace,
    kind: entry.kind,
    name: entry.name,
    timestamp: entry.timestamp,
    resolvedAt: new Date().toISOString(),
    action,
    changeType: entry.changeType,
    severity: entry.severity,
    riskScore: entry.riskScore || 0,
    changedBy: entry.changedBy || { user: "unknown" },
    changeCount: entry.changes.length,
    changeSummary: entry.changes.slice(0, 3).map(c => c.field).join(", "),
  });
  if (s.changeHistory.length > MAX_HISTORY) s.changeHistory.length = MAX_HISTORY;
}

export async function scanForChanges(cluster) {
  const s = _cs(cluster);
  const results = [];
  const namespaces = [...s.watchedNamespaces];
  if (namespaces.length === 0) return results;
  s.lastScanTime = new Date().toISOString();
  const outsideHours = isOutsideBusinessHours();
  const weekend = isWeekend();

  for (const ns of namespaces) {
    try {
      const workloads = await fetchWorkloads(ns);
      for (const w of workloads) {
        const key = workloadKey(ns, w.kind, w.metadata.name);
        const current = extractSpec(w);
        const baseline = s.baselines.get(key);
        if (!baseline) {
          s.baselines.set(key, current);
          continue;
        }
        if (baseline.generation === current.generation && baseline.resourceVersion === current.resourceVersion) continue;
        const dismissCooldown = s.dismissedKeys.get(key);
        if (dismissCooldown && (Date.now() - dismissCooldown.dismissedAt < 90000)) {
          s.baselines.set(key, current);
          continue;
        }
        const diffs = diffSpecs(baseline, current, w.kind, w.metadata.name, ns);
        if (diffs.length > 0) {
          const existingPending = s.changeLog.find(e => e.namespace === ns && e.kind === w.kind && e.name === w.metadata.name && !e.acknowledged);
          if (existingPending) {
            s.baselines.set(key, current);
            continue;
          }
          const changeType = classifyChangeType(diffs);
          const severity = diffs.some(d => d.severity === "critical") ? "critical" : diffs.some(d => d.severity === "warning") ? "warning" : "info";
          const dismissed = s.dismissedKeys.get(key);
          let followUp = false;
          let followUpCount = 0;
          if (dismissed) {
            followUp = true;
            dismissed.followUpCount++;
            followUpCount = dismissed.followUpCount;
          }
          let changedBy = extractChangedBy(w, ns, w.kind, w.metadata.name);
          try { changedBy = await enrichChangedByWithUser(changedBy, ns, w.kind, w.metadata.name); } catch {}
          const riskScore = calculateRiskScore(changeType, severity, followUp, diffs.length, {
            kind: w.kind,
            hasImageChange: diffs.some(d => d.field.includes("/image")),
            hasReplicaChange: diffs.some(d => d.field === "replicas"),
          });
          const riskLevel = getRiskLevel(riskScore);
          const changeFreezeViolation = outsideHours || weekend;
          let correlatedEvents = [];
          try { correlatedEvents = await correlateWithEvents(ns, w.kind, w.metadata.name); } catch {}

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
            severity,
            acknowledged: false,
            followUp,
            followUpCount,
            changedBy,
            riskScore,
            riskLevel,
            changeFreezeViolation,
            correlatedEvents,
          };
          recordChange(entry, cluster);
          results.push(entry);
        }
        s.baselines.set(key, current);
        if (!s.dismissedKeys.has(key) || diffs.length === 0) {
          s.dismissedKeys.delete(key);
        }
      }
    } catch (e) {
      console.warn(`[app-watcher] Error scanning namespace ${ns}:`, e.message);
    }
  }
  if (results.length > 0 && (!cluster || cluster === "local")) persistWatcherState().catch(() => {});
  return results;
}

export async function scanConfigChanges(cluster) {
  const s = _cs(cluster);
  const results = [];
  const namespaces = [...s.watchedNamespaces];
  if (namespaces.length === 0) return results;

  for (const ns of namespaces) {
    try {
      const [cms, secrets] = await Promise.allSettled([
        ocpGet(`/api/v1/namespaces/${ns}/configmaps`),
        ocpGet(`/api/v1/namespaces/${ns}/secrets`),
      ]);

      const configMaps = cms.status === "fulfilled" ? (cms.value.items || []) : [];
      for (const cm of configMaps) {
        if (cm.metadata.name.startsWith("kube-") || cm.metadata.name.startsWith("openshift-")) continue;
        const key = `${ns}/ConfigMap/${cm.metadata.name}`;
        const currentHash = JSON.stringify(cm.data || {});
        const baselineHash = s.baselines.get(key + ":hash");
        if (!baselineHash) {
          s.baselines.set(key + ":hash", currentHash);
          continue;
        }
        if (baselineHash === currentHash) continue;
        const dismissCooldown = s.dismissedKeys.get(key);
        if (dismissCooldown && (Date.now() - dismissCooldown.dismissedAt < 90000)) {
          s.baselines.set(key + ":hash", currentHash);
          continue;
        }

        const oldData = JSON.parse(baselineHash);
        const newData = cm.data || {};
        const diffs = [];
        const allKeys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
        for (const k of allKeys) {
          if (!(k in oldData)) diffs.push({ field: `data/${k}`, old: "(none)", new: "(added)", severity: "warning" });
          else if (!(k in newData)) diffs.push({ field: `data/${k}`, old: "(removed)", new: "(none)", severity: "warning" });
          else if (oldData[k] !== newData[k]) diffs.push({ field: `data/${k}`, old: oldData[k]?.substring(0, 80) || "", new: newData[k]?.substring(0, 80) || "", severity: "info" });
        }
        if (diffs.length > 0) {
          const existingCM = s.changeLog.find(e => e.namespace === ns && e.kind === "ConfigMap" && e.name === cm.metadata.name && !e.acknowledged);
          if (existingCM) { s.baselines.set(key + ":hash", currentHash); continue; }
          const riskScore = calculateRiskScore("config-change", "warning", false, diffs.length, {
            kind: "ConfigMap",
          });
          const entry = {
            id: `chg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            namespace: ns, kind: "ConfigMap", name: cm.metadata.name,
            timestamp: new Date().toISOString(), changes: diffs,
            changeType: "config-change", baseline: { hash: baselineHash },
            currentSpec: { hash: currentHash }, severity: "warning",
            acknowledged: false, followUp: false, followUpCount: 0,
            changedBy: { user: "unknown", method: "api" },
            riskScore, riskLevel: getRiskLevel(riskScore),
            changeFreezeViolation: isOutsideBusinessHours() || isWeekend(),
            correlatedEvents: [],
          };
          recordChange(entry, cluster);
          results.push(entry);
        }
        s.baselines.set(key + ":hash", currentHash);
      }

      const secretList = secrets.status === "fulfilled" ? (secrets.value.items || []) : [];
      for (const sec of secretList) {
        if (sec.type === "kubernetes.io/service-account-token") continue;
        if (sec.metadata.name.startsWith("builder-") || sec.metadata.name.startsWith("deployer-")) continue;
        if (sec.metadata.name.includes("-dockercfg-")) continue;
        if (sec.type === "kubernetes.io/dockercfg" || sec.type === "kubernetes.io/dockerconfigjson") continue;
        const key = `${ns}/Secret/${sec.metadata.name}`;
        const dataKeys = Object.keys(sec.data || {}).sort().join(",");
        const currentHash = `keys:${dataKeys}:rv:${sec.metadata.resourceVersion}`;
        const baselineHash = s.baselines.get(key + ":hash");
        if (!baselineHash) {
          s.baselines.set(key + ":hash", currentHash);
          continue;
        }
        if (baselineHash === currentHash) continue;
        const dismissCooldown = s.dismissedKeys.get(key);
        if (dismissCooldown && (Date.now() - dismissCooldown.dismissedAt < 90000)) {
          s.baselines.set(key + ":hash", currentHash);
          continue;
        }
        const oldKeys = (baselineHash.match(/keys:([^:]*)/)?.[1] || "").split(",").filter(Boolean);
        const newKeys = dataKeys.split(",").filter(Boolean);
        const diffs = [];
        for (const k of newKeys) { if (!oldKeys.includes(k)) diffs.push({ field: `data/${k}`, old: "(none)", new: "(added)", severity: "critical" }); }
        for (const k of oldKeys) { if (!newKeys.includes(k)) diffs.push({ field: `data/${k}`, old: "(removed)", new: "(none)", severity: "critical" }); }
        if (diffs.length === 0 && baselineHash !== currentHash) {
          diffs.push({ field: "data/(values)", old: "(changed)", new: "(updated)", severity: "warning" });
        }
        if (diffs.length > 0) {
          const existingSec = s.changeLog.find(e => e.namespace === ns && e.kind === "Secret" && e.name === sec.metadata.name && !e.acknowledged);
          if (existingSec) { s.baselines.set(key + ":hash", currentHash); continue; }
          const riskScore = calculateRiskScore("config-change", "critical", false, diffs.length, {
            kind: "Secret",
            changedFields: diffs.map(d => d.new),
          });
          const entry = {
            id: `chg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            namespace: ns, kind: "Secret", name: sec.metadata.name,
            timestamp: new Date().toISOString(), changes: diffs,
            changeType: "config-change", baseline: { hash: baselineHash },
            currentSpec: { hash: currentHash }, severity: "critical",
            acknowledged: false, followUp: false, followUpCount: 0,
            changedBy: { user: "unknown", method: "api" },
            riskScore, riskLevel: getRiskLevel(riskScore),
            changeFreezeViolation: isOutsideBusinessHours() || isWeekend(),
            correlatedEvents: [],
          };
          recordChange(entry, cluster);
          results.push(entry);
        }
        s.baselines.set(key + ":hash", currentHash);
      }
    } catch (e) {
      console.warn(`[app-watcher] Config scan error in ${ns}:`, e.message);
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

export function getTimelineStats(cluster) {
  const s = _cs(cluster);
  const now = Date.now();
  const h1 = new Date(now - 3600000).toISOString();
  const h6 = new Date(now - 6 * 3600000).toISOString();
  const h24 = new Date(now - 24 * 3600000).toISOString();

  const last1h = s.changeTimeline.filter(e => e.timestamp >= h1);
  const last6h = s.changeTimeline.filter(e => e.timestamp >= h6);
  const last24h = s.changeTimeline.filter(e => e.timestamp >= h24);

  const hourlyBuckets = [];
  for (let i = 23; i >= 0; i--) {
    const bucketStart = new Date(now - (i + 1) * 3600000).toISOString();
    const bucketEnd = new Date(now - i * 3600000).toISOString();
    const entries = s.changeTimeline.filter(e => e.timestamp >= bucketStart && e.timestamp < bucketEnd);
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
