import { query, isEnabled as dbEnabled } from "../utils/db.js";
import { getRecord, cancelChangeRequest } from "../utils/servicenow-client.js";

const PENDING_STATUSES = ["submitted", "approved", "scheduled"];
const COMPLETED_STATUSES = ["executed", "cancelled", "rejected", "failed"];

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    sysId: row.sys_id,
    conversationId: row.conversation_id,
    status: row.status,
    title: row.title,
    targetVersion: row.target_version,
    fromVersion: row.from_version,
    channel: row.channel,
    upgradeType: row.upgrade_type,
    scheduledDate: row.scheduled_date,
    preflightReport: row.preflight_report,
    metadata: row.metadata,
    cluster: row.cluster || "local",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function trackCR({
  ticketId,
  sysId,
  conversationId,
  title,
  targetVersion,
  fromVersion,
  channel,
  upgradeType,
  scheduledDate,
  preflightReport,
  metadata,
  cluster,
}) {
  if (!(await dbEnabled())) return null;

  const result = await query(
    `INSERT INTO change_requests (id, ticket_id, sys_id, conversation_id, status, title, target_version, from_version, channel, upgrade_type, scheduled_date, preflight_report, metadata, cluster)
     VALUES ($1, $1, $2, $3, 'submitted', $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       sys_id = COALESCE(EXCLUDED.sys_id, change_requests.sys_id),
       conversation_id = COALESCE(EXCLUDED.conversation_id, change_requests.conversation_id),
       title = COALESCE(EXCLUDED.title, change_requests.title),
       target_version = COALESCE(EXCLUDED.target_version, change_requests.target_version),
       from_version = COALESCE(EXCLUDED.from_version, change_requests.from_version),
       channel = COALESCE(EXCLUDED.channel, change_requests.channel),
       upgrade_type = COALESCE(EXCLUDED.upgrade_type, change_requests.upgrade_type),
       scheduled_date = COALESCE(EXCLUDED.scheduled_date, change_requests.scheduled_date),
       preflight_report = COALESCE(EXCLUDED.preflight_report, change_requests.preflight_report),
       metadata = COALESCE(EXCLUDED.metadata, change_requests.metadata),
       cluster = COALESCE(EXCLUDED.cluster, change_requests.cluster),
       updated_at = NOW()
     RETURNING *`,
    [
      ticketId,
      sysId || null,
      conversationId || null,
      title || null,
      targetVersion || null,
      fromVersion || null,
      channel || null,
      upgradeType || null,
      scheduledDate || null,
      preflightReport ? JSON.stringify(preflightReport) : null,
      metadata ? JSON.stringify(metadata) : null,
      cluster || "local",
    ]
  );

  return result?.rows?.[0] ? mapRow(result.rows[0]) : null;
}

export async function getCR(ticketId) {
  if (!(await dbEnabled())) return null;

  const result = await query(
    `SELECT * FROM change_requests WHERE ticket_id = $1 OR id = $1 LIMIT 1`,
    [ticketId]
  );

  return result?.rows?.[0] ? mapRow(result.rows[0]) : null;
}

export async function listCRs({ status, limit = 50, cluster } = {}) {
  if (!(await dbEnabled())) return [];

  const conditions = [];
  const params = [];
  let idx = 1;

  if (Array.isArray(status) && status.length > 0) {
    conditions.push(`status = ANY($${idx++})`); params.push(status);
  } else if (typeof status === "string" && status) {
    conditions.push(`status = $${idx++}`); params.push(status);
  }
  if (cluster && cluster !== "all") {
    conditions.push(`cluster = $${idx++}`); params.push(cluster);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const result = await query(
    `SELECT * FROM change_requests ${where} ORDER BY updated_at DESC LIMIT $${idx}`,
    params
  );

  return (result?.rows || []).map(mapRow);
}

export async function getPendingCRs({ cluster } = {}) {
  if (!(await dbEnabled())) return [];

  if (cluster && cluster !== "all") {
    const result = await query(
      `SELECT * FROM change_requests WHERE status = ANY($1) AND cluster = $2 ORDER BY created_at DESC`,
      [PENDING_STATUSES, cluster]
    );
    return (result?.rows || []).map(mapRow);
  }

  const result = await query(
    `SELECT * FROM change_requests WHERE status = ANY($1) ORDER BY created_at DESC`,
    [PENDING_STATUSES]
  );

  return (result?.rows || []).map(mapRow);
}

export async function updateCRStatus(ticketId, status, { metadata = {}, scheduledDate } = {}) {
  if (!(await dbEnabled())) return false;

  const sets = ["status = $1", "metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb", "updated_at = NOW()"];
  const params = [status, JSON.stringify(metadata), ticketId];

  if (scheduledDate !== undefined) {
    params.push(scheduledDate);
    sets.push("scheduled_date = $" + params.length);
  }

  const result = await query(
    `UPDATE change_requests SET ${sets.join(", ")} WHERE ticket_id = $3 OR id = $3`,
    params
  );

  return (result?.rowCount || 0) > 0;
}

function mapSnowStateToStatus(snowRecord, currentStatus) {
  const approval = (snowRecord.approval || "").toLowerCase();
  const state = String(snowRecord.state || "");

  if (approval === "approved" || state === "-1" || state === "-2") {
    return "approved";
  }
  if (approval === "rejected" || state === "4") {
    return "rejected";
  }
  if (state === "3") {
    return "executed";
  }

  return currentStatus;
}

export async function syncCRFromServiceNow(ticketId) {
  if (!(await dbEnabled())) return null;

  const cr = await getCR(ticketId);
  if (!cr || !cr.sysId) return null;

  if (!process.env.SERVICENOW_INSTANCE) return null;

  let snowRecord;
  try {
    const response = await getRecord("change_request", cr.sysId);
    snowRecord = response?.result;
  } catch (err) {
    const status = err?.status || err?.statusCode;
    if (status === 404 || (err?.message && /404|not found/i.test(err.message))) {
      await updateCRStatus(ticketId, "cancelled", { metadata: { cancelReason: "Deleted from ServiceNow" } });
      return { cr: { ...cr, status: "cancelled" }, changed: true, snowState: { state: "deleted", approval: "" } };
    }
    return null;
  }

  if (!snowRecord) {
    await updateCRStatus(ticketId, "cancelled", { metadata: { cancelReason: "Not found in ServiceNow" } });
    return { cr: { ...cr, status: "cancelled" }, changed: true, snowState: { state: "deleted", approval: "" } };
  }

  const newStatus = mapSnowStateToStatus(snowRecord, cr.status);
  const changed = newStatus !== cr.status;

  if (changed) {
    await updateCRStatus(ticketId, newStatus);
  }

  return {
    cr: changed ? { ...cr, status: newStatus } : cr,
    changed,
    snowState: {
      state: snowRecord.state,
      approval: snowRecord.approval,
    },
  };
}

export async function syncAllPendingCRs() {
  const pending = await getPendingCRs();
  const results = [];

  for (const cr of pending) {
    const oldStatus = cr.status;
    const syncResult = await syncCRFromServiceNow(cr.ticketId);

    results.push({
      ticketId: cr.ticketId,
      oldStatus,
      newStatus: syncResult?.cr?.status || oldStatus,
      changed: syncResult?.changed || false,
    });
  }

  return results;
}

export async function dismissCR(ticketId) {
  if (!(await dbEnabled())) return { ok: false };

  const cr = await getCR(ticketId);
  if (!cr || !PENDING_STATUSES.includes(cr.status)) return { ok: false };

  const result = await query(
    `UPDATE change_requests SET status = 'cancelled', updated_at = NOW()
     WHERE (ticket_id = $1 OR id = $1) AND status = ANY($2)`,
    [ticketId, PENDING_STATUSES]
  );
  const localOk = (result?.rowCount || 0) > 0;

  let snowCancelled = false;
  let snowError = null;
  if (localOk && cr.sysId && process.env.SERVICENOW_INSTANCE) {
    try {
      await cancelChangeRequest(cr.sysId, {
        reason: `Dismissed by user from AI Hub (${ticketId})`,
      });
      snowCancelled = true;
    } catch (err) {
      snowError = err.message;
      console.error(`[cr-tracker] ServiceNow cancel failed for ${ticketId}:`, err.message);
    }
  }

  return { ok: localOk, snowCancelled, snowError };
}

export async function deleteCR(ticketId) {
  if (!(await dbEnabled())) return false;
  const result = await query(
    `DELETE FROM change_requests WHERE ticket_id = $1 OR id = $1`,
    [ticketId]
  );
  return (result?.rowCount || 0) > 0;
}

export async function cleanupOldCRs(daysOld = 90) {
  if (!(await dbEnabled())) return 0;

  const result = await query(
    `DELETE FROM change_requests
     WHERE status = ANY($1)
       AND updated_at < NOW() - make_interval(days => $2)`,
    [COMPLETED_STATUSES, daysOld]
  );

  return result?.rowCount || 0;
}

export async function backfillFromAuditTrail() {
  if (!(await dbEnabled())) return { imported: 0, skipped: 0 };

  const created = await query(
    `SELECT target, result, created_at
       FROM executed_actions
      WHERE action = 'create_change_request'
      ORDER BY created_at DESC`
  );

  const approved = await query(
    `SELECT target, created_at
       FROM executed_actions
      WHERE action IN ('cr_approved', 'cr_rejected')`
  );

  const statusMap = new Map();
  for (const row of approved?.rows || []) {
    statusMap.set(row.target, row.action === "cr_approved" ? "approved" : "rejected");
  }

  let imported = 0;
  let skipped = 0;

  for (const row of created?.rows || []) {
    const ticketId = row.target;
    if (!ticketId) { skipped++; continue; }

    const existing = await query(
      `SELECT id FROM change_requests WHERE ticket_id = $1 OR id = $1 LIMIT 1`,
      [ticketId]
    );
    if (existing?.rows?.length) { skipped++; continue; }

    const meta = row.result || {};
    const status = statusMap.get(ticketId) || "submitted";

    await query(
      `INSERT INTO change_requests (id, ticket_id, sys_id, status, title, created_at, updated_at)
       VALUES ($1, $1, $2, $3, $4, $5, NOW())`,
      [ticketId, meta.sysId || null, status, meta.title || meta.shortDescription || "", row.created_at]
    );
    imported++;
  }

  return { imported, skipped };
}
