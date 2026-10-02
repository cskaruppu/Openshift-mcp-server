/**
 * Loading canary definitions, running them, and keeping the last result.
 *
 * Separated from canary.js so the scoring stays pure and testable and only this
 * file touches the filesystem, the clock and the database.
 *
 * The history matters as much as the latest run. "Failing since Tuesday" and
 * "failed once an hour ago" are different problems, and a store that keeps only
 * the current state cannot tell them apart.
 */

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { query, isEnabled as dbEnabled } from "../utils/db.js";
import { runAgentCanary, canaryFleet } from "./canary.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANARY_DIR = join(HERE, "canaries");

const _mem = new Map();        // agentId -> last run
const _history = new Map();    // agentId -> [{ranAt, verdict, failed, ran}]
const HISTORY_MAX = 50;
let _tableReady = null;
let _cases = null;

async function initTable() {
  if (_tableReady !== null) return _tableReady;
  try {
    if (!(await dbEnabled())) return (_tableReady = false);
    await query(`
      CREATE TABLE IF NOT EXISTS agent_canary_runs (
        id SERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        passed INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        skipped INTEGER DEFAULT 0,
        errored INTEGER DEFAULT 0,
        duration_ms INTEGER,
        headline TEXT,
        detail JSONB,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS agent_canary_agent_idx ON agent_canary_runs (agent_id, ran_at DESC)`).catch(() => {});
    _tableReady = true;
  } catch (e) {
    console.error("[canary] table init failed, using memory only:", e.message);
    _tableReady = false;
  }
  return _tableReady;
}

/**
 * Load every canary definition from src/agents/canaries/.
 *
 * A file that fails to import is reported, not swallowed: a canary that cannot
 * load is a detector that is off, and silently having no detector is the state
 * this whole feature exists to avoid.
 */
export async function loadCanaries({ reload = false } = {}) {
  if (_cases && !reload) return _cases;
  const byAgent = new Map();
  const errors = [];
  let files = [];
  try {
    files = (await readdir(CANARY_DIR)).filter((f) => f.endsWith(".js"));
  } catch {
    _cases = { byAgent, errors: [], loaded: 0 };
    return _cases;
  }
  for (const f of files) {
    const agentId = f.replace(/\.js$/, "");
    try {
      const mod = await import(pathToFileURL(join(CANARY_DIR, f)).href);
      const cases = mod.default;
      if (!Array.isArray(cases) || cases.length === 0) {
        errors.push(`${f}: exports no cases`);
        continue;
      }
      byAgent.set(agentId, cases);
    } catch (e) {
      errors.push(`${f}: ${e.message}`);
    }
  }
  _cases = { byAgent, errors, loaded: byAgent.size };
  return _cases;
}

/** Is a cluster reachable, and is a model configured? Both decide what can run. */
async function buildContext() {
  let clusterReachable = false;
  try {
    const { ocpGet } = await import("../utils/openshift-client.js");
    await ocpGet("/version");
    clusterReachable = true;
  } catch { /* no cluster — read-only cases skip, and say so */ }
  const provider = process.env.LLM_PROVIDER || "";
  return { clusterReachable, llmConfigured: Boolean(provider && provider !== "none") };
}

async function persist(run) {
  _mem.set(run.agentId, run);
  const h = _history.get(run.agentId) || [];
  h.unshift({ ranAt: run.ranAt, verdict: run.verdict, failed: run.failed, ran: run.ran });
  _history.set(run.agentId, h.slice(0, HISTORY_MAX));
  if (!(await initTable())) return;
  try {
    await query(
      `INSERT INTO agent_canary_runs (agent_id, verdict, passed, failed, skipped, errored, duration_ms, headline, detail, ran_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [run.agentId, run.verdict, run.passed, run.failed, run.skipped, run.errored,
       run.durationMs ?? null, run.headline, JSON.stringify({ cases: run.cases, topFailure: run.topFailure }), run.ranAt]
    );
  } catch (e) {
    console.error("[canary] persist failed:", e.message);
  }
}

/** Run the canary for one agent. Returns null when that agent has no cases. */
export async function runCanaryFor(agentId, ctx = null) {
  const { byAgent } = await loadCanaries();
  const cases = byAgent.get(agentId);
  if (!cases) return null;
  const run = await runAgentCanary(agentId, cases, ctx || (await buildContext()));
  await persist(run);
  return run;
}

/** Run every canary there is. One shared context, so the cluster is probed once. */
export async function runAllCanaries() {
  const { byAgent, errors } = await loadCanaries();
  const ctx = await buildContext();
  const runs = [];
  for (const [agentId, cases] of byAgent) {
    const run = await runAgentCanary(agentId, cases, ctx);
    await persist(run);
    runs.push(run);
  }
  return { runs, fleet: canaryFleet(runs), context: ctx, loadErrors: errors };
}

/** The most recent run per agent, without running anything. */
export async function getLastRuns() {
  const out = new Map(_mem);
  if (await initTable()) {
    try {
      const r = await query(
        `SELECT DISTINCT ON (agent_id) agent_id, verdict, passed, failed, skipped, errored, duration_ms, headline, detail, ran_at
           FROM agent_canary_runs ORDER BY agent_id, ran_at DESC`
      );
      for (const row of r?.rows || []) {
        if (out.has(row.agent_id)) continue;   // memory is fresher
        const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : (row.detail || {});
        out.set(row.agent_id, {
          agentId: row.agent_id, verdict: row.verdict,
          passed: row.passed, failed: row.failed, skipped: row.skipped, errored: row.errored,
          ran: (row.passed || 0) + (row.failed || 0) + (row.errored || 0),
          durationMs: row.duration_ms, headline: row.headline,
          ranAt: row.ran_at instanceof Date ? row.ran_at.toISOString() : row.ran_at,
          cases: detail.cases || [], topFailure: detail.topFailure || null,
        });
      }
    } catch { /* memory only */ }
  }
  return out;
}

/**
 * How long has this agent been failing?
 *
 * "Failing since Tuesday" and "failed once, an hour ago" need different
 * responses, and only the history can tell them apart.
 */
export async function failingSince(agentId) {
  let rows = (_history.get(agentId) || []).map((h) => ({ verdict: h.verdict, ranAt: h.ranAt }));
  if (await initTable()) {
    try {
      const r = await query(
        `SELECT verdict, ran_at FROM agent_canary_runs WHERE agent_id = $1 ORDER BY ran_at DESC LIMIT 50`, [agentId]);
      if (r?.rows?.length) {
        rows = r.rows.map((x) => ({ verdict: x.verdict, ranAt: x.ran_at instanceof Date ? x.ran_at.toISOString() : x.ran_at }));
      }
    } catch { /* memory only */ }
  }
  if (!rows.length || rows[0].verdict !== "fail") return null;
  let since = rows[0].ranAt, runs = 0;
  for (const r of rows) {
    if (r.verdict !== "fail") break;
    since = r.ranAt; runs++;
  }
  return { since, consecutiveFailures: runs };
}

/** Which agents have a canary at all — the gap that matters most. */
export async function canaryCoverage(agentIds = []) {
  const { byAgent, errors } = await loadCanaries();
  const covered = agentIds.filter((id) => byAgent.has(id));
  const uncovered = agentIds.filter((id) => !byAgent.has(id));
  return {
    agents: agentIds.length,
    covered: covered.length,
    uncovered,
    loadErrors: errors,
    note: uncovered.length
      ? `${uncovered.length} agent(s) have no canary: nothing checks whether their answers are still right. Only ${covered.length} do.`
      : "Every agent has a canary.",
  };
}
