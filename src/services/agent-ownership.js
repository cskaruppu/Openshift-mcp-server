/**
 * Who has accepted accountability for an agent.
 *
 * There are two honest ways to become an agent's owner, and this module exists
 * because only one of them is a code change:
 *
 *   1. DECLARED — a `governance.owner` in the manifest, reviewed and merged
 *      like any other change. Durable, versioned, and the one to prefer.
 *   2. CLAIMED — a person pressed Claim in the console. Recorded here with who
 *      claimed it and when, so the acceptance is evidence rather than a string.
 *
 * A manifest declaration always wins. This store is the fast path, not a way
 * around review — someone who claims an agent today should still land the
 * declaration in git, and the console says so.
 *
 * What this store will NOT do is infer an owner. A name pulled out of git
 * history belongs to somebody who has never agreed to anything, and the first
 * time an owner matters is an incident review — where "the system decided you
 * own this" is precisely the wrong conversation to be having. Suggestions live
 * in owner-hints.js and stay suggestions until a person accepts one.
 */

import { query, isEnabled as dbEnabled } from "../utils/db.js";

const _mem = new Map();        // agentId -> record, when there is no database
let _tableReady = null;

async function initTable() {
  if (_tableReady !== null) return _tableReady;
  try {
    if (!(await dbEnabled())) return (_tableReady = false);
    await query(`
      CREATE TABLE IF NOT EXISTS agent_ownership (
        agent_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        claimed_by TEXT NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- Where the accepted name came from: a suggestion the person took, or
        -- one they typed. Kept because "accepted the CODEOWNERS entry" and
        -- "typed a colleague's name in" are different acts.
        source TEXT,
        note TEXT
      )
    `);
    _tableReady = true;
  } catch {
    _tableReady = false;
  }
  return _tableReady;
}

/**
 * Accept accountability for an agent.
 *
 * `owner` is who is accountable; `actor` is who pressed the button. They are
 * usually the same person and occasionally are not — a team lead assigning an
 * agent to someone is a legitimate act, and one worth being able to see later.
 */
export async function claimOwner(agentId, { owner, actor = "operator", source = "typed", note = null } = {}) {
  if (!agentId) return { ok: false, error: "No agent id given." };
  const name = String(owner || "").trim();
  if (!name) return { ok: false, error: "An owner name is required." };
  if (name.length > 200) return { ok: false, error: "That owner name is too long." };

  const rec = { agentId, owner: name, claimedBy: actor, claimedAt: new Date().toISOString(), source, note };
  _mem.set(agentId, rec);

  try {
    if (await initTable()) {
      const r = await query(
        `INSERT INTO agent_ownership (agent_id, owner, claimed_by, claimed_at, source, note)
              VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (agent_id) DO UPDATE
            SET owner = EXCLUDED.owner, claimed_by = EXCLUDED.claimed_by,
                claimed_at = EXCLUDED.claimed_at, source = EXCLUDED.source, note = EXCLUDED.note`,
        [agentId, rec.owner, rec.claimedBy, rec.claimedAt, rec.source, rec.note],
      );
      // db.js returns null on failure rather than throwing.
      if (!r) return { ok: true, ...rec, durable: false, warning: "The claim is held in memory only — it will not survive a restart." };
      return { ok: true, ...rec, durable: true };
    }
  } catch { /* fall through to the memory answer */ }

  return { ok: true, ...rec, durable: false, warning: "No database is configured, so this claim is held in memory and is lost when the pod restarts. Declare the owner in the manifest to make it permanent." };
}

/** Give an agent back. Deliberately possible: people change teams. */
export async function releaseOwner(agentId) {
  if (!agentId) return { ok: false, error: "No agent id given." };
  const had = _mem.delete(agentId);
  try {
    if (await initTable()) {
      const r = await query(`DELETE FROM agent_ownership WHERE agent_id = $1`, [agentId]);
      if (r) return { ok: true, agentId, released: r.rowCount > 0 || had };
    }
  } catch { /* memory answer below */ }
  return { ok: true, agentId, released: had };
}

/** Every claim, as a Map keyed by agent id. */
export async function getOwnership() {
  try {
    if (await initTable()) {
      const r = await query(`SELECT agent_id, owner, claimed_by, claimed_at, source, note FROM agent_ownership`);
      if (r) {
        const out = new Map();
        for (const row of r.rows || []) {
          out.set(row.agent_id, {
            agentId: row.agent_id, owner: row.owner, claimedBy: row.claimed_by,
            claimedAt: row.claimed_at, source: row.source, note: row.note,
          });
        }
        // The memory mirror is a fallback, not a second source of truth. Rows
        // the database does not have are still worth returning — they were
        // claimed in this process and the console has already shown them.
        for (const [k, v] of _mem) if (!out.has(k)) out.set(k, v);
        return out;
      }
    }
  } catch { /* memory answer below */ }
  return new Map(_mem);
}

export function _clearMemory() { _mem.clear(); }
