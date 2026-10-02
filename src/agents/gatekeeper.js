/**
 * May this agent run, right now?
 *
 * The one place in the system that can REFUSE an agent rather than report on
 * it. Everything upstream — canary, posture, scorecard, evidence density —
 * produces a judgement; this turns a judgement into a closed door.
 *
 * Two grounds for refusal, and only two:
 *
 *   QUARANTINE — a human (or an opted-in automatic rule) took this agent out
 *                of circulation. See quarantine.js.
 *   BUDGET     — the agent has spent past the monthly token budget its own
 *                manifest declared, AND that manifest asks for a block rather
 *                than a warning. `budgetTokensPerMonth` has been in the schema
 *                and on the screen since governance was written, and until now
 *                nothing has ever read it at request time.
 *
 * WHAT IT WILL NOT DO IS REFUSE ON UNCERTAINTY. If the budget cannot be read,
 * or token spend is not attributed to this agent, the agent RUNS and the
 * unknown is reported. A gate that fails closed on missing telemetry takes the
 * product down the first time the database is slow — and the failure mode of a
 * false refusal here is a customer-visible outage, while the failure mode of a
 * false allow is one more invocation on an already-flagged agent.
 *
 * Decisions are cached briefly: this sits on the request path, and re-reading
 * two tables per call to answer "no, still fine" would be a tax on every agent
 * for the benefit of the rare one.
 */

import { getQuarantine, isQuarantined } from "./quarantine.js";
import { budgetVerdict } from "./health-signals.js";

const TTL_MS = 30_000;
let _cache = { at: 0, quarantine: null, budgets: null };

async function snapshot() {
  const now = Date.now();
  if (_cache.at && now - _cache.at < TTL_MS) return _cache;

  let quarantine = new Map();
  try { quarantine = await getQuarantine(); }
  catch { quarantine = _cache.quarantine || new Map(); }

  // Spend this calendar month, per agent. Absent means unattributed, which
  // means the budget check reports unmeasured and the agent runs.
  let spend = new Map();
  try {
    const { getAgentTokenUsage } = await import("../services/telemetry.js");
    const since = new Date();
    const days = Math.max(1, Math.ceil((Date.now() - new Date(since.getFullYear(), since.getMonth(), 1).getTime()) / 86400000));
    const usage = await getAgentTokenUsage({ days });
    if (usage?.available) spend = usage.byAgent;
  } catch { /* no telemetry — unmeasured, and the agent runs */ }

  _cache = { at: now, quarantine, budgets: spend };
  return _cache;
}

/** Drop the cache — called after a quarantine or release so the door shuts now. */
export function invalidateGatekeeper() {
  _cache = { at: 0, quarantine: _cache.quarantine, budgets: _cache.budgets };
}

/**
 * Decide whether an agent may serve this request.
 *
 * @param {string} agentId
 * @param {object} manifestGovernance  the agent's `governance` block, for the budget
 * @returns {{allowed, reason, code, detail, budget}}
 */
export async function mayRun(agentId, manifestGovernance = null) {
  if (!agentId) return { allowed: true, reason: null, code: null, detail: null, budget: null };
  const snap = await snapshot();

  const q = snap.quarantine.get(agentId);
  if (isQuarantined(q)) {
    return {
      allowed: false, code: "quarantined",
      reason: `${agentId} is quarantined.`,
      detail: `${q.detail} Taken out of circulation ${q.source === "automatic" ? "automatically" : `by ${q.quarantinedBy}`} at ${q.quarantinedAt}. A human has to release it — the governance panel has the button and will ask for a reason.`,
      budget: null,
      quarantine: q,
    };
  }

  const g = manifestGovernance || {};
  const budget = budgetVerdict(
    snap.budgets.get(agentId)?.totalTokens ?? null,
    Number.isFinite(g.budgetTokensPerMonth) ? g.budgetTokensPerMonth : null,
    g.budgetAction || null
  );
  if (budget.state === "breached" && budget.action === "block") {
    return {
      allowed: false, code: "budget-breached",
      reason: `${agentId} has spent past its monthly token budget.`,
      detail: `${budget.headline} Its manifest sets budgetAction to "block", so it is blocked until the month turns or the budget is raised in git.`,
      budget,
    };
  }

  return { allowed: true, reason: null, code: null, detail: null, budget };
}

/**
 * The HTTP shape of a refusal.
 *
 * 503 rather than 403: the agent is not forbidden to this caller, it is out of
 * service. A monitoring system reading the status code should see an
 * availability problem, because that is what this is.
 */
export function refusalResponse(decision) {
  return {
    status: 503,
    body: {
      error: decision.reason,
      detail: decision.detail,
      code: decision.code,
      agentUnavailable: true,
      ...(decision.quarantine ? {
        quarantinedAt: decision.quarantine.quarantinedAt,
        quarantineReason: decision.quarantine.reason,
      } : {}),
    },
  };
}
