/**
 * Action workflow — approval gate for mutating cluster operations.
 *
 * When the user asks to restart / delete / scale a workload the chat handler
 * does NOT execute immediately. Instead it creates a pending_action row, the
 * dashboard shows a confirmation card, and on confirm a ServiceNow Change
 * Request is raised. Once the CR is approved the action is executed.
 *
 * Lifecycle:
 *   pending_confirmation  -> user clicks Confirm -> awaiting_approval (CR raised)
 *   awaiting_approval     -> CR approved         -> approved
 *   approved              -> backend executes    -> executed | failed
 *   pending_confirmation  -> user clicks Cancel  -> cancelled
 *   awaiting_approval     -> CR rejected         -> rejected
 *
 * All state is persisted in PostgreSQL when DATABASE_URL is set, with a
 * best-effort in-memory fallback so the dashboard still works in stateless
 * mode (single-process only, not durable).
 */

import { query, isEnabled as dbEnabled } from "../utils/db.js";
import { ocpGet, ocpPatch, ocpDelete } from "../utils/openshift-client.js";
import { createChangeRequest, getRecord } from "../utils/servicenow-client.js";
import { logExecutedAction as histLogExecutedAction } from "./chat-history.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SNOW_ENABLED = Boolean(
  process.env.SERVICENOW_INSTANCE &&
  process.env.SERVICENOW_USERNAME &&
  process.env.SERVICENOW_PASSWORD
);
// When true (default), a pending action auto-progresses to "approved" as soon
// as it is confirmed, skipping the ServiceNow gate. Useful for demos and
// environments without a real ServiceNow instance. Set AUTO_APPROVE=false to
// require a real CR.
const AUTO_APPROVE = process.env.ACTION_AUTO_APPROVE !== "false" && !SNOW_ENABLED;

// Which (action, resourceType) combinations are allowed through the workflow.
const ALLOWED = new Set([
  "restart:deployment",
  "restart:daemonset",
  "restart:statefulset",
  "restart:pod",
  "delete:pod",
  "delete:deployment",
  "delete:daemonset",
  "delete:statefulset",
  "delete:job",
  "delete:replicaset",
  "scale:deployment",
  "scale:statefulset",
]);

// ---------------------------------------------------------------------------
// Storage — DB first, in-memory fallback
// ---------------------------------------------------------------------------
const memStore = new Map();

function newId() {
  return (
    "act_" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

function rowToAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceName: row.resource_name,
    namespace: row.namespace,
    options: row.options || {},
    status: row.status,
    servicenowCrNumber: row.servicenow_cr_number,
    servicenowSysId: row.servicenow_sys_id,
    requestedBy: row.requested_by,
    summary: row.summary,
    result: row.result || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function dbInsert(act) {
  const r = await query(
    `INSERT INTO pending_actions
       (id, conversation_id, action, resource_type, resource_name, namespace,
        options, status, requested_by, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      act.id,
      act.conversationId || null,
      act.action,
      act.resourceType,
      act.resourceName,
      act.namespace || null,
      JSON.stringify(act.options || {}),
      act.status,
      act.requestedBy || null,
      act.summary || null,
    ]
  );
  return r && r.rows[0] ? rowToAction(r.rows[0]) : null;
}

async function dbGet(id) {
  const r = await query(`SELECT * FROM pending_actions WHERE id = $1`, [id]);
  return r && r.rows[0] ? rowToAction(r.rows[0]) : null;
}

async function dbUpdate(id, patch) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return dbGet(id);
  const setParts = [];
  const params = [id];
  const keyToCol = {
    status: "status",
    servicenowCrNumber: "servicenow_cr_number",
    servicenowSysId: "servicenow_sys_id",
    result: "result",
    summary: "summary",
  };
  let i = 2;
  for (const k of keys) {
    const col = keyToCol[k];
    if (!col) continue;
    setParts.push(`${col} = $${i}`);
    const v = patch[k];
    params.push(k === "result" ? (v == null ? null : JSON.stringify(v)) : v);
    i++;
  }
  setParts.push(`updated_at = NOW()`);
  const sql = `UPDATE pending_actions SET ${setParts.join(", ")} WHERE id = $1 RETURNING *`;
  const r = await query(sql, params);
  return r && r.rows[0] ? rowToAction(r.rows[0]) : null;
}

async function dbListByConversation(conversationId, limit = 50) {
  const r = await query(
    `SELECT * FROM pending_actions
      WHERE ($1::text IS NULL OR conversation_id = $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [conversationId || null, limit]
  );
  return r ? r.rows.map(rowToAction) : [];
}

// Memory fallback helpers — used when DB is not configured.
function memInsert(act) {
  memStore.set(act.id, { ...act });
  return act;
}
function memGet(id) {
  const r = memStore.get(id);
  return r ? { ...r } : null;
}
function memUpdate(id, patch) {
  const cur = memStore.get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  memStore.set(id, next);
  return { ...next };
}
function memListByConversation(conversationId, limit = 50) {
  const all = [...memStore.values()]
    .filter((a) => !conversationId || a.conversationId === conversationId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
  return all.map((a) => ({ ...a }));
}

async function store(op, ...args) {
  const useDb = await dbEnabled();
  if (op === "insert") {
    return useDb ? (await dbInsert(args[0])) || memInsert(args[0]) : memInsert(args[0]);
  }
  if (op === "get") {
    return useDb ? (await dbGet(args[0])) || memGet(args[0]) : memGet(args[0]);
  }
  if (op === "update") {
    if (useDb) {
      const r = await dbUpdate(args[0], args[1]);
      if (r) return r;
    }
    return memUpdate(args[0], args[1]);
  }
  if (op === "list") {
    if (useDb) {
      const r = await dbListByConversation(args[0], args[1]);
      if (r && r.length > 0) return r;
    }
    return memListByConversation(args[0], args[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Intent -> action translation
// ---------------------------------------------------------------------------
/**
 * Given an NLU parse result, decide whether this maps to a pending mutating
 * action. Returns null if the intent is not mutating or unsupported.
 */
export function actionFromParse(parsed) {
  if (!parsed || !parsed.resource || !parsed.name) return null;
  let action = null;
  const opts = parsed.options || {};

  if (parsed.intent === "delete") {
    action = "delete";
  } else if (parsed.intent === "update") {
    // Scale (has replicas) vs plain restart.
    if (Number.isFinite(opts.replicas)) {
      action = "scale";
    } else {
      action = "restart";
    }
  } else if (parsed.intent === "restart") {
    action = "restart";
  }
  if (!action) return null;

  // A raw "restart pod X" means "delete pod X" — the controller recreates it.
  let resourceType = parsed.resource;
  if (action === "restart" && resourceType === "pod") {
    action = "delete";
  }

  const key = `${action}:${resourceType}`;
  if (!ALLOWED.has(key)) return null;

  return {
    action,
    resourceType,
    resourceName: parsed.name,
    namespace: parsed.namespace || null,
    options: action === "scale" ? { replicas: opts.replicas } : {},
  };
}

function humanSummary(a) {
  const label = {
    restart: "Restart",
    delete: "Delete",
    scale: "Scale",
  }[a.action] || a.action;
  const ns = a.namespace ? ` in \`${a.namespace}\`` : "";
  if (a.action === "scale") {
    return `${label} ${a.resourceType} \`${a.resourceName}\`${ns} to ${a.options?.replicas} replicas`;
  }
  return `${label} ${a.resourceType} \`${a.resourceName}\`${ns}`;
}

// ---------------------------------------------------------------------------
// Public API — lifecycle operations
// ---------------------------------------------------------------------------
/**
 * Create a new pending action in `pending_confirmation` state. The chat
 * handler calls this instead of executing a mutating command directly.
 */
export async function createPendingAction({
  conversationId,
  action,
  resourceType,
  resourceName,
  namespace,
  options,
  requestedBy,
}) {
  const key = `${action}:${resourceType}`;
  if (!ALLOWED.has(key)) {
    throw new Error(`Action not allowed: ${key}`);
  }
  const now = new Date().toISOString();
  const act = {
    id: newId(),
    conversationId: conversationId || null,
    action,
    resourceType,
    resourceName,
    namespace: namespace || null,
    options: options || {},
    status: "pending_confirmation",
    requestedBy: requestedBy || "dashboard-user",
    summary: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  act.summary = humanSummary(act);
  return store("insert", act);
}

export async function getAction(id) {
  return store("get", id);
}

export async function listActions(conversationId, limit = 50) {
  return store("list", conversationId, limit);
}

/**
 * User confirmed a pending action. Raise a ServiceNow CR (if configured)
 * and move to awaiting_approval. If SNOW is not configured and
 * ACTION_AUTO_APPROVE is true, jump straight to approved.
 */
export async function confirmAction(id) {
  const act = await getAction(id);
  if (!act) return { error: "not_found" };
  if (act.status !== "pending_confirmation") {
    return { error: `cannot confirm in status ${act.status}`, action: act };
  }

  // Build the ServiceNow CR
  let snowInfo = {};
  if (SNOW_ENABLED) {
    try {
      const shortDescription = `[OCP] ${act.summary}`;
      const description = [
        `Automated change request from OpenShift MCP dashboard.`,
        ``,
        `Action:        ${act.action}`,
        `Resource:      ${act.resourceType}/${act.resourceName}`,
        `Namespace:     ${act.namespace || "(cluster)"}`,
        `Options:       ${JSON.stringify(act.options || {})}`,
        `Requested by:  ${act.requestedBy || "unknown"}`,
        `Correlation:   ${act.id}`,
      ].join("\n");
      const resp = await createChangeRequest({
        shortDescription,
        description,
        type: "normal",
        priority: "3",
        risk: "moderate",
        justification: `User-requested ${act.action} via OpenShift AI assistant`,
      });
      const record = resp?.result || {};
      snowInfo = {
        servicenowCrNumber: record.number || null,
        servicenowSysId: record.sys_id || null,
      };
    } catch (err) {
      console.error("[action-workflow] ServiceNow CR creation failed:", err.message);
      return {
        error: `ServiceNow CR creation failed: ${err.message}`,
        action: await store("update", id, { status: "failed" }),
      };
    }
  }

  const nextStatus = AUTO_APPROVE ? "approved" : "awaiting_approval";
  const updated = await store("update", id, { ...snowInfo, status: nextStatus });
  return { action: updated };
}

export async function cancelAction(id) {
  const act = await getAction(id);
  if (!act) return { error: "not_found" };
  if (!["pending_confirmation", "awaiting_approval"].includes(act.status)) {
    return { error: `cannot cancel in status ${act.status}`, action: act };
  }
  const updated = await store("update", id, { status: "cancelled" });
  return { action: updated };
}

/**
 * Poll ServiceNow for the CR state and move the action through
 * approved / rejected if appropriate. Returns the updated action.
 */
export async function refreshFromServiceNow(id) {
  const act = await getAction(id);
  if (!act) return { error: "not_found" };
  if (act.status !== "awaiting_approval") return { action: act };
  if (!SNOW_ENABLED || !act.servicenowSysId) return { action: act };
  try {
    const resp = await getRecord("change_request", act.servicenowSysId);
    const state = resp?.result?.state || "";
    const approval = resp?.result?.approval || "";
    // ServiceNow change states: -5=new, -4=assess, -3=authorize, -2=sched,
    // -1=implement, 0=review, 3=closed, 4=cancelled. approval: approved /
    // rejected / requested.
    if (approval === "approved" || state === "-1" || state === "0") {
      const updated = await store("update", id, { status: "approved" });
      return { action: updated };
    }
    if (approval === "rejected" || state === "4") {
      const updated = await store("update", id, { status: "rejected" });
      return { action: updated };
    }
    return { action: act };
  } catch (err) {
    console.error("[action-workflow] ServiceNow poll failed:", err.message);
    return { action: act };
  }
}

/**
 * Execute an approved action against the cluster. Updates status to
 * executed / failed and records the outcome to the executed_actions log.
 */
export async function executeAction(id) {
  let act = await getAction(id);
  if (!act) return { error: "not_found" };

  // Allow execute from "approved" only. From awaiting_approval we attempt a
  // refresh first so the dashboard can "execute" as soon as the CR flips.
  if (act.status === "awaiting_approval") {
    const r = await refreshFromServiceNow(id);
    if (r.action) act = r.action;
  }
  if (act.status !== "approved") {
    return { error: `cannot execute in status ${act.status}`, action: act };
  }

  let success = false;
  let result = null;
  try {
    result = await performClusterAction(act);
    success = true;
  } catch (err) {
    result = { error: err.message };
  }

  const updated = await store("update", id, {
    status: success ? "executed" : "failed",
    result,
  });

  // Best-effort log to executed_actions for the audit trail.
  histLogExecutedAction({
    conversationId: act.conversationId,
    action: `${act.action}_${act.resourceType}`,
    target: act.resourceName,
    namespace: act.namespace,
    success,
    result,
  }).catch(() => {});

  return { action: updated };
}

// ---------------------------------------------------------------------------
// Cluster action primitives
// ---------------------------------------------------------------------------
const RESOURCE_API = {
  deployment:  { api: "/apis/apps/v1", plural: "deployments" },
  daemonset:   { api: "/apis/apps/v1", plural: "daemonsets" },
  statefulset: { api: "/apis/apps/v1", plural: "statefulsets" },
  replicaset:  { api: "/apis/apps/v1", plural: "replicasets" },
  job:         { api: "/apis/batch/v1", plural: "jobs" },
  pod:         { api: "/api/v1", plural: "pods" },
};

function pathFor(resourceType, namespace, name) {
  const info = RESOURCE_API[resourceType];
  if (!info) throw new Error(`unsupported resource: ${resourceType}`);
  if (!namespace) throw new Error(`namespace is required for ${resourceType}`);
  return `${info.api}/namespaces/${namespace}/${info.plural}/${name}`;
}

async function performClusterAction(act) {
  const base = pathFor(act.resourceType, act.namespace, act.resourceName);

  if (act.action === "delete") {
    await ocpDelete(base);
    return {
      message: `${act.resourceType} '${act.resourceName}' deleted in '${act.namespace}'.`,
    };
  }

  if (act.action === "restart") {
    // Rolling restart via the kubectl-style annotation patch. Works for
    // Deployment / DaemonSet / StatefulSet.
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: {
              "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
            },
          },
        },
      },
    };
    await ocpPatch(base, patch);
    return {
      message: `${act.resourceType} '${act.resourceName}' restarted in '${act.namespace}'.`,
    };
  }

  if (act.action === "scale") {
    const replicas = Number(act.options?.replicas);
    if (!Number.isFinite(replicas) || replicas < 0) {
      throw new Error("invalid replicas count");
    }
    await ocpPatch(base, { spec: { replicas } });
    return {
      message: `${act.resourceType} '${act.resourceName}' scaled to ${replicas} replicas in '${act.namespace}'.`,
    };
  }

  throw new Error(`unsupported action: ${act.action}`);
}

// ---------------------------------------------------------------------------
// Rendering helpers used by chat-api
// ---------------------------------------------------------------------------
/**
 * Build the assistant reply that appears when a mutating action is detected
 * and queued for confirmation. The dashboard parses the embedded
 * `<!--action:ID-->` marker to pop open the action card.
 */
export function renderPendingMessage(act) {
  const snowLine = SNOW_ENABLED
    ? "I will open a ServiceNow Change Request once you confirm. The action runs only after the CR is approved."
    : "ServiceNow is not configured in this environment, so the action will run immediately after you confirm.";
  return [
    `### Confirm action`,
    ``,
    `You asked me to **${act.summary}**.`,
    ``,
    `This is a mutating operation on the cluster, so I won't run it without your explicit OK.`,
    ``,
    snowLine,
    ``,
    `Use the **Actions** panel on the right to Confirm or Cancel, or reply here with \`confirm ${act.id}\` / \`cancel ${act.id}\`.`,
    ``,
    `<!--action:${act.id}-->`,
  ].join("\n");
}

export function isWorkflowEnabled() {
  // Always enabled — we have an in-memory fallback.
  return true;
}

export function isServiceNowEnabled() {
  return SNOW_ENABLED;
}
