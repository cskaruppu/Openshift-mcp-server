/**
 * Taking a malfunctioning agent out of circulation.
 *
 * Everything else in the governance stack REPORTS. This is the only thing that
 * ACTS, which is why it is the most dangerous file here and the most carefully
 * bounded.
 *
 * THE SHAPE OF THE DECISION. Detection is automatic; removal is not. A canary
 * failure or a critical posture produces a RECOMMENDATION with its evidence,
 * and a human applies it in one click. Automatic quarantine exists but is
 * opt-in per agent (`governance.autoQuarantine: true`), because an agent that
 * takes itself out of production on a false positive at 3am is a worse outage
 * than the one it was guarding against — and the false positive is the likely
 * case for a detector in its first weeks.
 *
 * Release is ALWAYS human. Nothing here un-quarantines an agent because a later
 * run looked better; a detector that can quarantine and release on its own will
 * flap, and flapping is how an alert becomes noise. Somebody looks at it, says
 * why, and lets it back.
 *
 * Like ownership and promotion, this does not edit the manifest. The manifest
 * is in git; a file rewritten inside a running pod exists on one replica and
 * disagrees with the repository. Quarantine is held here and merged into
 * posture at read time.
 */

import { query, isEnabled as dbEnabled } from "../utils/db.js";

const _mem = new Map();        // agentId -> record
let _tableReady = null;

/** Why an agent was taken out. Each carries what evidence justified it. */
export const QUARANTINE_REASONS = Object.freeze({
  "canary-failed": "Its golden-set canary stopped holding — it is answering differently than it used to.",
  "undeclared-tools": "It called a tool its manifest never declared.",
  "undeclared-egress": "It sent traffic to a host its manifest never declared.",
  "evidence-unsupported": "It kept reaching conclusions on little or no evidence.",
  "budget-breached": "It spent past its declared monthly token budget, and its manifest asks for a block.",
  "delegation-exceeded": "It delegated deeper than its declared maximum, or entered a cycle.",
  manual: "A human took it out of circulation.",
});

async function initTable() {
  if (_tableReady !== null) return _tableReady;
  try {
    if (!(await dbEnabled())) return (_tableReady = false);
    await query(`
      CREATE TABLE IF NOT EXISTS agent_quarantine (
        agent_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT,
        evidence JSONB,
        source TEXT NOT NULL,
        quarantined_by TEXT,
        quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_by TEXT,
        released_at TIMESTAMPTZ,
        release_note TEXT
      )
    `);
    _tableReady = true;
  } catch (e) {
    console.error("[quarantine] table init failed, using memory only:", e.message);
    _tableReady = false;
  }
  return _tableReady;
}

async function save(rec) {
  _mem.set(rec.agentId, rec);
  if (!(await initTable())) return rec;
  try {
    await query(
      `INSERT INTO agent_quarantine
         (agent_id, state, reason, detail, evidence, source, quarantined_by, quarantined_at, released_by, released_at, release_note)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (agent_id) DO UPDATE SET
         state = EXCLUDED.state, reason = EXCLUDED.reason, detail = EXCLUDED.detail,
         evidence = EXCLUDED.evidence, source = EXCLUDED.source,
         quarantined_by = EXCLUDED.quarantined_by, quarantined_at = EXCLUDED.quarantined_at,
         released_by = EXCLUDED.released_by, released_at = EXCLUDED.released_at,
         release_note = EXCLUDED.release_note`,
      [rec.agentId, rec.state, rec.reason, rec.detail || null,
       JSON.stringify(rec.evidence || null), rec.source,
       rec.quarantinedBy || null, rec.quarantinedAt,
       rec.releasedBy || null, rec.releasedAt || null, rec.releaseNote || null]
    );
  } catch (e) {
    console.error("[quarantine] persist failed:", e.message);
  }
  return rec;
}

/**
 * Take an agent out of circulation.
 *
 * @param {string} agentId
 * @param {object} p
 * @param {string} p.reason   a key of QUARANTINE_REASONS
 * @param {string} p.detail   the specific sentence — what actually happened
 * @param {object} p.evidence the finding, canary case or posture that justified it
 * @param {string} p.source   "automatic" | "human"
 * @param {string} p.by       who, when a human did it
 */
export async function quarantineAgent(agentId, { reason, detail, evidence = null, source = "human", by = null } = {}) {
  if (!agentId) throw new Error("quarantineAgent requires an agentId");
  if (!QUARANTINE_REASONS[reason]) throw new Error(`unknown quarantine reason: ${reason}`);
  if (source === "human" && !by) throw new Error("a human quarantine must name who did it");
  const existing = _mem.get(agentId);
  // Already out: keep the ORIGINAL reason and time. The first thing that went
  // wrong is what somebody needs to read, not the fifth symptom of it.
  if (existing?.state === "quarantined") return existing;
  return save({
    agentId, state: "quarantined",
    reason, detail: detail || QUARANTINE_REASONS[reason],
    evidence, source,
    quarantinedBy: source === "human" ? by : null,
    quarantinedAt: new Date().toISOString(),
    releasedBy: null, releasedAt: null, releaseNote: null,
  });
}

/**
 * Let an agent back. Always a human, always with a reason.
 *
 * No automatic path calls this. A detector that can both quarantine and release
 * will flap between them, and a panel that flaps gets ignored.
 */
export async function releaseAgent(agentId, { by, note } = {}) {
  if (!by) throw new Error("a release must name who did it");
  if (!note) throw new Error("a release must say why — an un-explained release is how the same fault comes back");
  const rec = (await getQuarantine()).get(agentId);
  if (!rec || rec.state !== "quarantined") return null;
  return save({
    ...rec, state: "released",
    releasedBy: by, releasedAt: new Date().toISOString(), releaseNote: note,
  });
}

/** Every quarantine record, keyed by agent. Includes released ones, for history. */
export async function getQuarantine() {
  const out = new Map(_mem);
  if (await initTable()) {
    try {
      const r = await query(`SELECT * FROM agent_quarantine`);
      for (const row of r?.rows || []) {
        if (out.has(row.agent_id)) continue;    // memory is fresher
        out.set(row.agent_id, {
          agentId: row.agent_id, state: row.state, reason: row.reason, detail: row.detail,
          evidence: typeof row.evidence === "string" ? JSON.parse(row.evidence) : row.evidence,
          source: row.source, quarantinedBy: row.quarantined_by,
          quarantinedAt: row.quarantined_at instanceof Date ? row.quarantined_at.toISOString() : row.quarantined_at,
          releasedBy: row.released_by,
          releasedAt: row.released_at instanceof Date ? row.released_at.toISOString() : row.released_at,
          releaseNote: row.release_note,
        });
      }
    } catch { /* memory only */ }
  }
  return out;
}

/** Is this agent currently out of circulation? */
export function isQuarantined(rec) {
  return rec?.state === "quarantined";
}

/**
 * Decide, from the evidence, whether an agent SHOULD be out of circulation.
 *
 * Pure: signals in, recommendation out. Nothing is applied here — the caller
 * decides whether to act on it, and only acts automatically when the agent's
 * manifest opted in.
 *
 * @param {object} s
 * @param {object} s.canary     the last canary run, if any
 * @param {object} s.posture    the governance posture
 * @param {object} s.evidence   evidenceProfile() for the window
 * @param {object} s.budget     budgetVerdict()
 * @param {object} s.failing    failingSince(), if the canary is failing
 */
export function quarantineRecommendation(s = {}) {
  const { canary, posture, evidence, budget, failing } = s;

  // A single red run is a signal; a run that has been red for a while is a
  // decision. One bad run quarantining an agent would make a transient
  // dependency failure look like a defect in the agent.
  if (canary?.verdict === "fail" && (failing?.consecutiveFailures || 1) >= 2) {
    return {
      recommend: true, reason: "canary-failed",
      detail: `Its canary has failed ${failing.consecutiveFailures} consecutive runs since ${failing.since}. ${canary.topFailure?.title || ""} — ${canary.topFailure?.reason || canary.headline}`.trim(),
      evidence: { canary: canary.topFailure, since: failing.since, runs: failing.consecutiveFailures },
      severity: "critical",
    };
  }
  const undeclared = (posture?.findings || []).find((f) => f.code === "undeclared-tools" || f.code === "undeclared-egress");
  if (undeclared) {
    return {
      recommend: true, reason: undeclared.code,
      detail: undeclared.message,
      evidence: { finding: undeclared },
      severity: "critical",
    };
  }
  if (budget?.state === "breached" && budget.action === "block") {
    return {
      recommend: true, reason: "budget-breached",
      detail: budget.headline + " Its manifest asks for a block on breach.",
      evidence: { budget },
      severity: "critical",
    };
  }
  // Answering on nothing, repeatedly. One thin answer is a bad day for a
  // dependency; a quarter of them is the agent.
  if (evidence?.state === "unsupported" && evidence.unsupportedRate >= 25) {
    return {
      recommend: true, reason: "evidence-unsupported",
      detail: `${evidence.unsupported} of ${evidence.measured} measured operation(s) — ${evidence.unsupportedRate}% — reached a conclusion on little or no evidence.`,
      evidence: { profile: evidence },
      severity: "serious",
    };
  }
  if (canary?.verdict === "fail") {
    return {
      recommend: false, reason: "canary-failed",
      detail: `Its canary failed once (${canary.headline}). Watching — a second consecutive failure would recommend quarantine.`,
      evidence: { canary: canary.topFailure },
      severity: "warning",
    };
  }
  return { recommend: false, reason: null, detail: null, evidence: null, severity: null };
}
