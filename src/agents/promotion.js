/**
 * Promoting an agent out of probation — as a change request.
 *
 * An agent leaving `experimental` for `active` is the moment it becomes
 * something other people depend on. That is a decision with a named approver,
 * not a toggle, and this platform already runs exactly that workflow for
 * migrations: raise a change, attach the evidence, wait for a human, act on the
 * outcome. Promotion reuses it rather than inventing a second, weaker one.
 *
 * The evidence is the agent's own scorecard. "Promote this agent" is a request
 * that has to justify itself, and the ten checks are the justification — which
 * is also why the scorecard was worth building before this.
 *
 * WHAT THIS DOES NOT DO IS EDIT THE MANIFEST. The manifest is in git, reviewed
 * and versioned; a promotion that rewrote a file inside a running pod would
 * exist on one replica and disagree with the repository, which is the drift the
 * governance view exists to report. So an approved promotion is recorded here
 * and merged into posture at read time, exactly as a claimed owner is. The
 * durable answer is still to land `governance.lifecycle: "active"` in git, and
 * the console says so.
 */

import { query, isEnabled as dbEnabled } from "../utils/db.js";

const _mem = new Map();          // agentId -> record
let _tableReady = null;

/** A promotion certifies for a year unless somebody says otherwise. */
const CERT_DAYS = parseInt(process.env.AGENT_CERT_DAYS || "365", 10);

async function initTable() {
  if (_tableReady !== null) return _tableReady;
  try {
    if (!(await dbEnabled())) return (_tableReady = false);
    await query(`
      CREATE TABLE IF NOT EXISTS agent_promotion (
        agent_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approval_id TEXT,
        change_request TEXT,
        approved_by TEXT,
        decided_at TIMESTAMPTZ,
        certified_at TIMESTAMPTZ,
        recertify_by TIMESTAMPTZ,
        evidence JSONB,
        reason TEXT
      )
    `);
    _tableReady = true;
  } catch {
    _tableReady = false;
  }
  return _tableReady;
}

async function save(rec) {
  _mem.set(rec.agentId, rec);
  try {
    if (await initTable()) {
      await query(
        `INSERT INTO agent_promotion
           (agent_id, state, requested_by, requested_at, approval_id, change_request,
            approved_by, decided_at, certified_at, recertify_by, evidence, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         ON CONFLICT (agent_id) DO UPDATE SET
           state = EXCLUDED.state, requested_by = EXCLUDED.requested_by,
           requested_at = EXCLUDED.requested_at, approval_id = EXCLUDED.approval_id,
           change_request = EXCLUDED.change_request, approved_by = EXCLUDED.approved_by,
           decided_at = EXCLUDED.decided_at, certified_at = EXCLUDED.certified_at,
           recertify_by = EXCLUDED.recertify_by, evidence = EXCLUDED.evidence,
           reason = EXCLUDED.reason`,
        [rec.agentId, rec.state, rec.requestedBy, rec.requestedAt, rec.approvalId,
         rec.changeRequest, rec.approvedBy, rec.decidedAt, rec.certifiedAt,
         rec.recertifyBy, JSON.stringify(rec.evidence || null), rec.reason],
      );
      return { durable: true };
    }
  } catch { /* the memory copy still answers */ }
  return { durable: false };
}

/**
 * Ask for an agent to be promoted.
 *
 * Refused when the scorecard says it is not ready. A promotion is a statement
 * that other teams may now depend on this agent, and an agent with no owner or
 * no declared blast radius cannot honestly carry that — approving it would make
 * the change request a rubber stamp, which is worse than having no workflow at
 * all because it produces an audit trail that looks like diligence.
 */
export async function requestPromotion(agentId, { posture, scorecard, actor = "operator", reason = null } = {}) {
  if (!agentId) return { ok: false, error: "No agent id given." };
  if (!posture) return { ok: false, error: `No posture available for "${agentId}".` };

  if (posture.lifecycle !== "experimental") {
    return { ok: false, error: `${agentId} is ${posture.lifecycle}, not on probation — there is nothing to promote.` };
  }

  // The bar: accountable, and honest about what it can do.
  const blockers = [];
  if (!posture.owner) blockers.push("Nobody has accepted accountability for it.");
  if (!posture.blastRadius) blockers.push("Its blast radius is undeclared, so nobody can say what approving it permits.");
  if (!posture.trustTier) blockers.push("Its trust tier is undeclared.");
  if (!posture.autonomy) blockers.push("Its autonomy level is undeclared.");
  const critical = (posture.findings || []).filter((f) => f.severity === "critical");
  for (const f of critical) blockers.push(f.message);

  if (blockers.length) {
    return { ok: false, error: blockers[0], blockers, notReady: true };
  }

  const existing = await getPromotion(agentId);
  if (existing && existing.state === "pending") {
    return { ok: true, alreadyRequested: true, promotion: existing, message: `${existing.changeRequest || existing.approvalId} is already awaiting a decision.` };
  }

  const rec = {
    agentId,
    state: "pending",
    requestedBy: actor,
    requestedAt: new Date().toISOString(),
    approvalId: null, changeRequest: null, approvedBy: null, decidedAt: null,
    certifiedAt: null, recertifyBy: null,
    // The scorecard AT THE MOMENT OF ASKING. Kept rather than recomputed later:
    // an approver decided on what they were shown, and a record that silently
    // re-scores would misrepresent what they agreed to.
    evidence: scorecard ? {
      score: scorecard.score, grade: scorecard.grade,
      coverage: scorecard.coverage, confidence: scorecard.confidence,
      failing: (scorecard.checks || []).filter((c) => c.state === "fail").map((c) => c.label),
      tools: posture.toolCount, blastRadius: posture.blastRadius, owner: posture.owner,
    } : null,
    reason,
  };

  // Best-effort through the existing approval chain. A promotion that cannot
  // reach ServiceNow is still recorded as pending here rather than being lost —
  // the request was made, and pretending otherwise would hide it from the
  // person who made it.
  try {
    const { requestApproval } = await import("../services/approval-chains.js");
    const a = await requestApproval({
      kind: "agent-promotion",
      summary: `Promote agent ${agentId} from experimental to active`,
      requestedBy: actor,
      metadata: { agentId, evidence: rec.evidence, reason },
    });
    if (a?.id) rec.approvalId = a.id;
    if (a?.changeRequest || a?.number) rec.changeRequest = a.changeRequest || a.number;
  } catch (e) {
    rec.note = `The approval chain could not be reached (${e.message}); the request is recorded here.`;
  }

  const { durable } = await save(rec);
  return {
    ok: true, promotion: rec, durable,
    message: rec.changeRequest
      ? `${rec.changeRequest} raised. ${agentId} stays on probation until it is approved.`
      : `Promotion requested for ${agentId}. It stays on probation until somebody approves it.`,
  };
}

/**
 * Record a decision.
 *
 * Approval certifies the agent and moves it to active AT READ TIME; rejection
 * leaves it exactly where it was, on probation, which is the safe direction.
 */
export async function decidePromotion(agentId, { decision, approver = "operator", comment = null } = {}) {
  const rec = await getPromotion(agentId);
  if (!rec) return { ok: false, error: `No promotion request for "${agentId}".` };
  if (rec.state !== "pending") return { ok: false, error: `That request was already ${rec.state}.` };
  if (!["approved", "rejected"].includes(decision)) return { ok: false, error: `Unknown decision "${decision}".` };

  // The approver must not be the requester. A promotion signed off by the
  // person who asked for it is not an approval, and the whole point of routing
  // this through a change request is that somebody else looked.
  if (decision === "approved" && approver === rec.requestedBy) {
    return { ok: false, error: "A promotion cannot be approved by the person who requested it." };
  }

  const now = new Date();
  rec.state = decision;
  rec.approvedBy = approver;
  rec.decidedAt = now.toISOString();
  rec.reason = comment || rec.reason;
  if (decision === "approved") {
    rec.certifiedAt = now.toISOString();
    rec.recertifyBy = new Date(now.getTime() + CERT_DAYS * 86400000).toISOString();
  }

  const { durable } = await save(rec);
  return {
    ok: true, promotion: rec, durable,
    message: decision === "approved"
      ? `${agentId} is promoted and certified until ${rec.recertifyBy.slice(0, 10)}. Land governance.lifecycle "active" in its manifest to make it permanent.`
      : `${agentId} stays on probation.`,
  };
}

export async function getPromotion(agentId) {
  if (!agentId) return null;
  try {
    if (await initTable()) {
      const r = await query(`SELECT * FROM agent_promotion WHERE agent_id = $1`, [agentId]);
      const row = r?.rows?.[0];
      if (row) return rowToRec(row);
    }
  } catch { /* memory answer below */ }
  return _mem.get(agentId) || null;
}

/** Every promotion, keyed by agent. */
export async function getPromotions() {
  try {
    if (await initTable()) {
      const r = await query(`SELECT * FROM agent_promotion`);
      if (r) {
        const out = new Map();
        for (const row of r.rows || []) out.set(row.agent_id, rowToRec(row));
        for (const [k, v] of _mem) if (!out.has(k)) out.set(k, v);
        return out;
      }
    }
  } catch { /* memory answer below */ }
  return new Map(_mem);
}

function rowToRec(row) {
  return {
    agentId: row.agent_id, state: row.state,
    requestedBy: row.requested_by, requestedAt: row.requested_at,
    approvalId: row.approval_id, changeRequest: row.change_request,
    approvedBy: row.approved_by, decidedAt: row.decided_at,
    certifiedAt: row.certified_at, recertifyBy: row.recertify_by,
    evidence: typeof row.evidence === "string" ? JSON.parse(row.evidence) : row.evidence,
    reason: row.reason,
  };
}

/**
 * The lifecycle an agent is actually in, once an approved promotion is taken
 * into account. Pure, so posture can use it without another database read.
 */
export function effectiveLifecycle(declared, promotion) {
  if (declared === "experimental" && promotion?.state === "approved") return "active";
  return declared;
}

export function _clearMemory() { _mem.clear(); _tableReady = null; }
