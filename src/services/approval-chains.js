/**
 * Approval Chains — multi-stage approval workflow for high-risk operations.
 *
 * Wraps destructive/production actions with approval gates. Each approval
 * request records:
 *   - The proposed action and command
 *   - Requester (userId or session)
 *   - Required approver role(s) and minimum count
 *   - Current status: pending | approved | rejected | expired
 *   - Audit trail of who approved/rejected and when
 *
 * Storage: PostgreSQL `chat_approvals` table. Falls back to in-memory when
 * DB is disabled.
 */

import { query, isEnabled } from "../utils/db.js";

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const _mem = new Map();

let _schemaReady = false;
async function ensureSchema() {
  if (_schemaReady) return;
  if (!(await isEnabled())) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS chat_approvals (
        id SERIAL PRIMARY KEY,
        conversation_id TEXT,
        action TEXT NOT NULL,
        command TEXT,
        target TEXT,
        namespace TEXT,
        requested_by TEXT,
        approver_role TEXT,
        required_approvals INTEGER DEFAULT 1,
        approvals JSONB DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        decided_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON chat_approvals(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_conversation ON chat_approvals(conversation_id);
    `);
    _schemaReady = true;
  } catch (err) {
    console.error("[approval-chains] schema bootstrap failed:", err.message);
  }
}

/**
 * Submit a new approval request. Returns the approval id.
 *
 * @param {object} req - { conversationId, action, command, target, namespace,
 *                         requestedBy, approverRole, requiredApprovals, reason }
 */
export async function requestApproval(req) {
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  if (!(await isEnabled())) {
    const id = "mem-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    _mem.set(id, {
      id, conversation_id: req.conversationId, action: req.action, command: req.command || null,
      target: req.target || null, namespace: req.namespace || null,
      requested_by: req.requestedBy || null, approver_role: req.approverRole || "sre",
      required_approvals: req.requiredApprovals || 1, approvals: [], status: "pending",
      reason: req.reason || null, metadata: req.metadata || {},
      created_at: new Date().toISOString(), expires_at: expiresAt.toISOString(),
    });
    return id;
  }
  await ensureSchema();
  try {
    const r = await query(
      `INSERT INTO chat_approvals (conversation_id, action, command, target, namespace, requested_by, approver_role, required_approvals, reason, metadata, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        req.conversationId || null, req.action, req.command || null, req.target || null,
        req.namespace || null, req.requestedBy || null, req.approverRole || "sre",
        req.requiredApprovals || 1, req.reason || null, JSON.stringify(req.metadata || {}),
        expiresAt.toISOString(),
      ]
    );
    return String(r?.rows?.[0]?.id || "");
  } catch (err) {
    console.error("[approval-chains] requestApproval failed:", err.message);
    return null;
  }
}

/** Approver decision — "approve" or "reject". Returns the updated request. */
export async function decideApproval(id, { decision, approverUserId, comment } = {}) {
  if (!["approve", "reject"].includes(decision)) throw new Error("decision must be 'approve' or 'reject'");
  if (!(await isEnabled())) {
    const rec = _mem.get(id);
    if (!rec) return null;
    rec.approvals = rec.approvals || [];
    rec.approvals.push({ approverUserId, decision, comment, at: new Date().toISOString() });
    if (decision === "reject") { rec.status = "rejected"; rec.decided_at = new Date().toISOString(); }
    else if (rec.approvals.filter((a) => a.decision === "approve").length >= rec.required_approvals) {
      rec.status = "approved"; rec.decided_at = new Date().toISOString();
    }
    return rec;
  }
  await ensureSchema();
  try {
    const cur = await query(`SELECT * FROM chat_approvals WHERE id = $1`, [id]);
    const rec = cur?.rows?.[0];
    if (!rec) return null;
    const approvals = Array.isArray(rec.approvals) ? rec.approvals : (rec.approvals ? JSON.parse(rec.approvals) : []);
    approvals.push({ approverUserId, decision, comment, at: new Date().toISOString() });
    let newStatus = rec.status;
    let decidedAt = null;
    if (decision === "reject") { newStatus = "rejected"; decidedAt = new Date().toISOString(); }
    else if (approvals.filter((a) => a.decision === "approve").length >= rec.required_approvals) {
      newStatus = "approved"; decidedAt = new Date().toISOString();
    }
    await query(
      `UPDATE chat_approvals SET approvals = $2, status = $3, decided_at = $4 WHERE id = $1`,
      [id, JSON.stringify(approvals), newStatus, decidedAt]
    );
    return { ...rec, approvals, status: newStatus, decided_at: decidedAt };
  } catch (err) {
    console.error("[approval-chains] decideApproval failed:", err.message);
    return null;
  }
}

/** Check if an approval is currently approved (auth-ready to execute). */
export async function isApprovalApproved(id) {
  if (!id) return false;
  if (!(await isEnabled())) {
    const rec = _mem.get(id);
    return rec?.status === "approved";
  }
  try {
    const r = await query(`SELECT status FROM chat_approvals WHERE id = $1`, [id]);
    return r?.rows?.[0]?.status === "approved";
  } catch { return false; }
}

/** List pending approvals (UI dashboard). */
export async function listPendingApprovals({ limit = 50 } = {}) {
  if (!(await isEnabled())) {
    const out = [];
    for (const [, rec] of _mem) if (rec.status === "pending") out.push(rec);
    return out.slice(0, limit);
  }
  await ensureSchema();
  try {
    const r = await query(
      `SELECT id, conversation_id, action, command, target, namespace, requested_by, approver_role, required_approvals, status, reason, created_at, expires_at
       FROM chat_approvals WHERE status = 'pending' AND expires_at > NOW() ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    return r?.rows || [];
  } catch (err) {
    return [];
  }
}

/** Get a single approval by id. */
export async function getApproval(id) {
  if (!id) return null;
  if (!(await isEnabled())) return _mem.get(id) || null;
  try {
    const r = await query(`SELECT * FROM chat_approvals WHERE id = $1`, [id]);
    return r?.rows?.[0] || null;
  } catch { return null; }
}

/** Reaper — mark expired pending approvals. Safe to call periodically. */
export async function expireStaleApprovals() {
  if (!(await isEnabled())) return 0;
  try {
    const r = await query(
      `UPDATE chat_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW() RETURNING id`
    );
    return r?.rows?.length || 0;
  } catch { return 0; }
}
