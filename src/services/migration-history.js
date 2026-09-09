/**
 * Migration History — what was migrated, when, how it went, kept after the
 * Plan that did it is gone.
 *
 * The gap this closes: until now the Forklift Plan WAS the record, and the
 * console read history straight off the cluster. That works only while the
 * Plan exists, and a migration's history is most at risk exactly when it
 * reaches a terminal state — a rollback deletes the Plan, decommission
 * workflows delete Plans, namespaces get cleaned up, clusters get rebuilt. The
 * moment you most need to know what happened is the moment the evidence goes.
 *
 * DELIBERATELY NOT A SECOND SYSTEM OF RECORD. ServiceNow holds the compliance
 * record — the approval trail, the attached migration document, the close
 * notes with the verification results — under whatever retention the
 * organisation's records policy sets. This is the OPERATIONAL record: what ran
 * here, when, how fast, and how it ended, kept for a working period and
 * pointing at the change request for the rest.
 *
 * Three properties that make it trustworthy:
 *
 *   WRITTEN ONCE, AT THE END. Not updated stage by stage. A row that is
 *   appended to as a migration progresses leaves a partial row behind whenever
 *   a pod restarts mid-copy, and partial rows are worse than absent ones. The
 *   stage timestamps already live on the Plan and its status, so the whole
 *   timeline is read at the terminal event and written in one go.
 *
 *   APPEND-ONLY. There is no update path. History a writer can edit is not
 *   history. Rows leave only by ageing out, and that is the only DELETE.
 *
 *   ONE ROW PER RUN, KEYED BY A GENERATED ID. Not by plan name: plan names
 *   carry a date, so two attempts on the same day would collide. Re-migrating
 *   a machine that was rolled back leaves both attempts visible, which is
 *   exactly the story someone needs a year later.
 *
 * Mirrors change-ledger.js on purpose — same Postgres-with-memory-fallback
 * shape, same retention-in-days control — so it behaves the way the ledger
 * already does in this deployment and introduces no new operational concept.
 */

import { query, isEnabled as dbEnabled } from "../utils/db.js";

/** Longer than the change ledger's 90 days: a migration is a rarer, higher
 *  value event, and "when did we last move this VM, and how did it go?" is
 *  asked long after a config patch has stopped mattering. */
const RETENTION_DAYS = parseInt(process.env.MIGRATION_HISTORY_RETENTION_DAYS || "365", 10);

/** In-memory mirror so history works without Postgres — lost on pod restart,
 *  which is the documented caveat the change ledger carries too. */
const _mem = [];
const MEM_MAX = 200;
let _tableReady = null;

async function initTable() {
  if (_tableReady !== null) return _tableReady;
  try {
    if (!(await dbEnabled())) return (_tableReady = false);
    await query(`
      CREATE TABLE IF NOT EXISTS migration_history (
        id TEXT PRIMARY KEY,
        cluster TEXT NOT NULL DEFAULT 'local',
        plan_name TEXT NOT NULL,
        finished_at TIMESTAMPTZ DEFAULT NOW(),
        outcome TEXT,
        strategy TEXT,
        vm_count INTEGER,
        total_gib NUMERIC,
        change_request TEXT,
        data JSONB
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS migration_history_finished_idx ON migration_history (finished_at DESC)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS migration_history_plan_idx ON migration_history (plan_name)`).catch(() => {});
    _tableReady = true;
  } catch {
    _tableReady = false;
  }
  return _tableReady;
}

function genId() {
  return `mig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The stage timeline, read from the Plan and its status. Pure.
 *
 * Every timestamp here already exists somewhere — the Plan's creation, the
 * approval annotation, the pipeline steps, the migration's cutover stamp. None
 * of it is accumulated by this process, so nothing is lost to a restart and
 * nothing has to be written incrementally.
 *
 * A stage that never happened is null, not a guess. "Cutover: —" on a cold
 * migration is correct; inventing one would not be.
 */
export function stagesFrom(plan = {}, status = {}, extra = {}) {
  const ann = plan.metadata?.annotations || {};
  const steps = (status.vms || []).flatMap((v) => v.steps || []);
  const stepDone = (re) => steps.filter((s) => re.test(String(s.name || "")) && s.completedAt)
    .map((s) => s.completedAt).sort().at(-1) || null;
  const first = (arr) => arr.filter(Boolean).sort()[0] || null;

  return {
    created: plan.metadata?.creationTimestamp || null,
    // The approval check writes the moment it read "approved" back onto the
    // plan, so this is when we KNEW, which is the honest thing to record.
    approved: ann["tcs.agentic-ai/change-request-state"] === "approved"
      ? ann["tcs.agentic-ai/change-request-checked-at"] || null : null,
    transferStarted: first((status.vms || []).map((v) => v.started)),
    precopyDone: stepDone(/disk\s*transfer|copydisks/i),
    cutover: extra.cutover || stepDone(/cutover/i),
    finished: first((status.vms || []).map((v) => v.completed)) || null,
    verified: extra.verifiedAt || null,
    closed: ann["tcs.agentic-ai/change-request-closed"] || null,
  };
}

/**
 * Write one migration's history. Called once, at a terminal event.
 *
 * Returns the record so the caller can show it; failure to persist is not
 * allowed to fail the migration that succeeded.
 */
export async function recordMigration(entry = {}) {
  const rec = {
    id: genId(),
    cluster: entry.cluster || "local",
    planName: entry.planName || null,
    finishedAt: entry.finishedAt || new Date().toISOString(),
    // migrated | rolled-back | cancelled | failed
    outcome: entry.outcome || "unknown",
    strategy: entry.strategy || null,
    vmNames: entry.vmNames || [],
    vmCount: entry.vmCount ?? (entry.vmNames || []).length,
    totalGiB: entry.totalGiB ?? null,
    targetNamespace: entry.targetNamespace || null,
    sourceProvider: entry.sourceProvider || null,
    changeRequest: entry.changeRequest || null,
    changeRequestUrl: entry.changeRequestUrl || null,
    window: entry.window || null,
    approvedBy: entry.approvedBy || null,
    stages: entry.stages || null,
    // What was promised against what happened — the pair worth keeping, because
    // next time's estimate is only as good as last time's measurement.
    estimatedMinutes: entry.estimatedMinutes ?? null,
    actualMinutes: entry.actualMinutes ?? null,
    measuredMbps: entry.measuredMbps ?? null,
    verification: entry.verification || null,
    // What the model cost THIS migration. Recorded here because the analysis
    // that produced it lives in a browser session that ends, while the question
    // "what did the September wave cost us?" is asked long afterwards.
    ai: entry.ai || null,
    note: entry.note || null,
    recordedBy: entry.actor || "agent",
  };

  _mem.unshift(rec);
  if (_mem.length > MEM_MAX) _mem.length = MEM_MAX;

  try {
    if (await initTable()) {
      await query(
        `INSERT INTO migration_history
           (id, cluster, plan_name, finished_at, outcome, strategy, vm_count, total_gib, change_request, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [rec.id, rec.cluster, rec.planName, rec.finishedAt, rec.outcome, rec.strategy,
         rec.vmCount, rec.totalGiB, rec.changeRequest, JSON.stringify(rec)],
      );
    }
  } catch { /* the in-memory copy still serves the console */ }
  return rec;
}

/** Past migrations, newest first. Reads the database when there is one. */
export async function listMigrations({ limit = 50, cluster = null, planName = null } = {}) {
  const lim = Math.min(500, Math.max(1, limit));
  try {
    if (await initTable()) {
      const where = [], params = [];
      if (cluster) { params.push(cluster); where.push(`cluster = $${params.length}`); }
      if (planName) { params.push(planName); where.push(`plan_name = $${params.length}`); }
      params.push(lim);
      const r = await query(
        `SELECT data FROM migration_history
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY finished_at DESC LIMIT $${params.length}`,
        params,
      );
      return {
        durable: true, retentionDays: RETENTION_DAYS,
        migrations: (r.rows || []).map((row) => (typeof row.data === "string" ? JSON.parse(row.data) : row.data)),
      };
    }
  } catch { /* fall through to memory */ }

  // Sorted the same way the database sorts it. The memory mirror is filled in
  // insertion order, which is usually chronological and occasionally not — a
  // rollback archived late, or a backfill. Two code paths that answer "what
  // happened here" in different orders is a bug waiting for the day they
  // disagree in front of someone.
  const rows = _mem
    .filter((m) => (!cluster || m.cluster === cluster) && (!planName || m.planName === planName))
    .slice()
    .sort((a, b) => String(b.finishedAt || "").localeCompare(String(a.finishedAt || "")))
    .slice(0, lim);
  return {
    durable: false, retentionDays: RETENTION_DAYS, migrations: rows,
    // Said plainly rather than left for someone to discover after a restart.
    note: "No database is configured, so this history is held in memory and is lost when the pod restarts. The change requests in ServiceNow remain the durable record.",
  };
}

/** Housekeeping — drop entries past the retention window. The only DELETE. */
export async function pruneHistory() {
  try {
    if (await initTable()) {
      const r = await query(
        `DELETE FROM migration_history WHERE finished_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`,
      );
      return { pruned: r?.rowCount ?? 0, retentionDays: RETENTION_DAYS };
    }
  } catch { /* ignore */ }
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const before = _mem.length;
  for (let i = _mem.length - 1; i >= 0; i--) {
    if (Date.parse(_mem[i].finishedAt) < cutoff) _mem.splice(i, 1);
  }
  return { pruned: before - _mem.length, retentionDays: RETENTION_DAYS, durable: false };
}

/** Test seam — the in-memory mirror, so the fallback path can be asserted. */
export function _memoryRows() { return _mem; }
export function _clearMemory() { _mem.length = 0; }
