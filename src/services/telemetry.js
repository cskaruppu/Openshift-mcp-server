/**
 * Telemetry & AI Observability Service (Pillar 6).
 *
 * Captures: LLM call latency/tokens/errors, action outcomes, query intents.
 * Aggregates: per-hour/day rollups for the AI Hub Performance dashboard.
 *
 * All writes are best-effort; failures never affect the main request path.
 */

import { query, isEnabled } from "../utils/db.js";

const TELEMETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  conversation_id TEXT,
  duration_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  success BOOLEAN,
  error_class TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_type_created ON telemetry_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS action_outcomes (
  id BIGSERIAL PRIMARY KEY,
  action_id TEXT,
  conversation_id TEXT,
  command TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  success BOOLEAN,
  exit_code INTEGER,
  duration_ms INTEGER,
  user_id TEXT,
  cluster_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_action_outcomes_created ON action_outcomes(created_at DESC);
`;

let _schemaEnsured = false;

async function ensureTelemetrySchema() {
  if (_schemaEnsured) return;
  if (!(await isEnabled())) return;
  try {
    await query(TELEMETRY_SCHEMA);
    _schemaEnsured = true;
  } catch (err) {
    console.error("[telemetry] schema init failed:", err.message);
  }
}

// In-memory ring buffer for last 200 events — used when DB is disabled and
// also for fast recent-event display without re-querying the DB.
const _ringBuffer = [];
const RING_MAX = 200;
function ringPush(event) {
  _ringBuffer.push({ ...event, ts: Date.now() });
  if (_ringBuffer.length > RING_MAX) _ringBuffer.shift();
}

/**
 * Record an LLM call. Call this AFTER the LLM responds (or fails).
 * @param {object} params
 * @param {string} params.provider - "azure", "openai", "ollama", etc.
 * @param {string} [params.model]
 * @param {string} [params.conversationId]
 * @param {number} params.durationMs
 * @param {boolean} params.success
 * @param {object} [params.usage] - { prompt_tokens, completion_tokens, total_tokens }
 * @param {string} [params.errorClass] - "timeout", "rate_limit", "auth", "network", "other"
 * @param {object} [params.metadata]
 */
export async function recordLLMCall({
  provider,
  model,
  conversationId,
  durationMs,
  success,
  usage,
  errorClass,
  metadata,
}) {
  const event = {
    event_type: "llm_call",
    provider: provider || null,
    model: model || null,
    conversation_id: conversationId || null,
    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
    success: success == null ? null : Boolean(success),
    error_class: errorClass || null,
    metadata: metadata || null,
  };
  ringPush(event);
  await ensureTelemetrySchema();
  try {
    await query(
      `INSERT INTO telemetry_events
       (event_type, provider, model, conversation_id, duration_ms,
        prompt_tokens, completion_tokens, total_tokens, success, error_class, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        event.event_type, event.provider, event.model, event.conversation_id,
        event.duration_ms, event.prompt_tokens, event.completion_tokens,
        event.total_tokens, event.success, event.error_class,
        event.metadata ? JSON.stringify(event.metadata) : null,
      ]
    );
  } catch (err) {
    // best effort
  }
}

/**
 * Record an executed action (Dry Run or Run). Used by Pillar 7 audit log too.
 */
export async function recordActionOutcome({
  actionId,
  conversationId,
  command,
  dryRun,
  success,
  exitCode,
  durationMs,
  userId,
  clusterName,
}) {
  const event = {
    actionId: actionId || null,
    conversationId: conversationId || null,
    command: command || "",
    dryRun: Boolean(dryRun),
    success: success == null ? null : Boolean(success),
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    userId: userId || null,
    clusterName: clusterName || null,
  };
  ringPush({ event_type: "action", ...event });
  await ensureTelemetrySchema();
  try {
    await query(
      `INSERT INTO action_outcomes
       (action_id, conversation_id, command, dry_run, success, exit_code, duration_ms, user_id, cluster_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [event.actionId, event.conversationId, event.command, event.dryRun,
       event.success, event.exitCode, event.durationMs, event.userId, event.clusterName]
    );
  } catch (err) {
    // best effort
  }
}

/**
 * Wrap an async function so its latency + outcome are auto-recorded.
 *   const result = await measure({ provider, model, conversationId },
 *                                () => callLLMRaw(...));
 */
export async function measureLLM(opts, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    const usage = result?.usage || result?.response?.usage || null;
    await recordLLMCall({
      ...opts,
      durationMs: Date.now() - t0,
      success: true,
      usage,
    });
    return result;
  } catch (err) {
    const errorClass = classifyError(err);
    await recordLLMCall({
      ...opts,
      durationMs: Date.now() - t0,
      success: false,
      errorClass,
      metadata: { message: String(err?.message || err).slice(0, 200) },
    });
    throw err;
  }
}

function classifyError(err) {
  const msg = String(err?.message || err).toLowerCase();
  if (msg.includes("timeout") || msg.includes("etimedout")) return "timeout";
  if (msg.includes("rate") || msg.includes("429")) return "rate_limit";
  if (msg.includes("auth") || msg.includes("401") || msg.includes("403")) return "auth";
  if (msg.includes("network") || msg.includes("econnref") || msg.includes("enotfound")) return "network";
  if (msg.includes("500") || msg.includes("502") || msg.includes("503")) return "server";
  return "other";
}

// ---------------------------------------------------------------------------
// Aggregation queries — power the AI Hub Performance dashboard
// ---------------------------------------------------------------------------

/** Returns headline metrics for the last N hours (default 24). */
export async function getMetricsSummary(hours = 24) {
  await ensureTelemetrySchema();
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // Use DB if enabled, else fall back to ring buffer
  if (!(await isEnabled())) {
    return computeFromRingBuffer(hours);
  }

  try {
    const [llmRes, actionRes, queryRes] = await Promise.all([
      query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE success = true) AS ok,
           COUNT(*) FILTER (WHERE success = false) AS err,
           ROUND(AVG(duration_ms))::int AS avg_ms,
           PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms,
           PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS p99_ms,
           COALESCE(SUM(total_tokens),0)::bigint AS tokens
         FROM telemetry_events
         WHERE event_type = 'llm_call' AND created_at >= $1`,
        [since]
      ),
      query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE success = true) AS ok,
           COUNT(*) FILTER (WHERE success = false) AS err,
           COUNT(*) FILTER (WHERE dry_run = true) AS dry_runs
         FROM action_outcomes WHERE created_at >= $1`,
        [since]
      ),
      query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE cache_hit = true) AS cache_hits,
           ROUND(AVG(duration_ms))::int AS avg_ms
         FROM query_log WHERE created_at >= $1`,
        [since]
      ),
    ]);

    const llm = llmRes?.rows?.[0] || {};
    const act = actionRes?.rows?.[0] || {};
    const q = queryRes?.rows?.[0] || {};

    const llmTotal = Number(llm.total || 0);
    const llmErrors = Number(llm.err || 0);
    const errorRate = llmTotal > 0 ? (llmErrors / llmTotal) * 100 : 0;
    const qTotal = Number(q.total || 0);
    const cacheHits = Number(q.cache_hits || 0);
    const cacheHitRate = qTotal > 0 ? (cacheHits / qTotal) * 100 : 0;

    return {
      windowHours: hours,
      llm: {
        total: llmTotal,
        success: Number(llm.ok || 0),
        errors: llmErrors,
        errorRatePct: Math.round(errorRate * 10) / 10,
        avgMs: Number(llm.avg_ms || 0),
        p95Ms: Number(llm.p95_ms || 0),
        p99Ms: Number(llm.p99_ms || 0),
        totalTokens: Number(llm.tokens || 0),
      },
      actions: {
        total: Number(act.total || 0),
        success: Number(act.ok || 0),
        errors: Number(act.err || 0),
        dryRuns: Number(act.dry_runs || 0),
      },
      queries: {
        total: qTotal,
        cacheHits,
        cacheHitRatePct: Math.round(cacheHitRate * 10) / 10,
        avgMs: Number(q.avg_ms || 0),
      },
    };
  } catch (err) {
    console.error("[telemetry] summary query failed:", err.message);
    return computeFromRingBuffer(hours);
  }
}

function computeFromRingBuffer(hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const recent = _ringBuffer.filter((e) => e.ts >= cutoff);
  const llmEvents = recent.filter((e) => e.event_type === "llm_call");
  const actionEvents = recent.filter((e) => e.event_type === "action");

  const llmDurations = llmEvents.map((e) => e.duration_ms).filter((d) => d != null).sort((a, b) => a - b);
  const p = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0;
  const llmErrors = llmEvents.filter((e) => e.success === false).length;

  return {
    windowHours: hours,
    llm: {
      total: llmEvents.length,
      success: llmEvents.filter((e) => e.success === true).length,
      errors: llmErrors,
      errorRatePct: llmEvents.length ? Math.round((llmErrors / llmEvents.length) * 1000) / 10 : 0,
      avgMs: llmDurations.length ? Math.round(llmDurations.reduce((s, x) => s + x, 0) / llmDurations.length) : 0,
      p95Ms: p(llmDurations, 0.95),
      p99Ms: p(llmDurations, 0.99),
      totalTokens: llmEvents.reduce((s, e) => s + (e.total_tokens || 0), 0),
    },
    actions: {
      total: actionEvents.length,
      success: actionEvents.filter((e) => e.success === true).length,
      errors: actionEvents.filter((e) => e.success === false).length,
      dryRuns: actionEvents.filter((e) => e.dryRun === true).length,
    },
    queries: { total: 0, cacheHits: 0, cacheHitRatePct: 0, avgMs: 0 },
    source: "ring_buffer",
  };
}

/** Hourly time-series for the last N hours — for sparklines/charts. */
export async function getTimeSeries(hours = 24) {
  await ensureTelemetrySchema();
  if (!(await isEnabled())) return [];
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  try {
    const res = await query(
      `SELECT
         date_trunc('hour', created_at) AS bucket,
         COUNT(*) AS calls,
         ROUND(AVG(duration_ms))::int AS avg_ms,
         COUNT(*) FILTER (WHERE success = false) AS errors,
         COALESCE(SUM(total_tokens),0)::bigint AS tokens
       FROM telemetry_events
       WHERE event_type = 'llm_call' AND created_at >= $1
       GROUP BY bucket
       ORDER BY bucket ASC`,
      [since]
    );
    return (res?.rows || []).map((r) => ({
      bucket: r.bucket,
      calls: Number(r.calls),
      avgMs: Number(r.avg_ms || 0),
      errors: Number(r.errors),
      tokens: Number(r.tokens),
    }));
  } catch (err) {
    console.error("[telemetry] timeseries query failed:", err.message);
    return [];
  }
}

/** Top intents / queries with latency stats. */
export async function getTopIntents(hours = 24, limit = 10) {
  if (!(await isEnabled())) return [];
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  try {
    const res = await query(
      `SELECT
         unnest(intents) AS intent,
         COUNT(*) AS count,
         ROUND(AVG(duration_ms))::int AS avg_ms
       FROM query_log
       WHERE created_at >= $1 AND intents IS NOT NULL
       GROUP BY intent
       ORDER BY count DESC
       LIMIT $2`,
      [since, limit]
    );
    return (res?.rows || []).map((r) => ({
      intent: r.intent,
      count: Number(r.count),
      avgMs: Number(r.avg_ms || 0),
    }));
  } catch (err) {
    return [];
  }
}

/** Provider breakdown — calls, error rate, avg latency per provider. */
export async function getProviderBreakdown(hours = 24) {
  await ensureTelemetrySchema();
  if (!(await isEnabled())) return [];
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  try {
    const res = await query(
      `SELECT
         provider,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE success = false) AS errors,
         ROUND(AVG(duration_ms))::int AS avg_ms,
         COALESCE(SUM(total_tokens),0)::bigint AS tokens
       FROM telemetry_events
       WHERE event_type = 'llm_call' AND created_at >= $1 AND provider IS NOT NULL
       GROUP BY provider
       ORDER BY total DESC`,
      [since]
    );
    return (res?.rows || []).map((r) => ({
      provider: r.provider,
      total: Number(r.total),
      errors: Number(r.errors),
      errorRatePct: Number(r.total) > 0 ? Math.round((Number(r.errors) / Number(r.total)) * 1000) / 10 : 0,
      avgMs: Number(r.avg_ms || 0),
      tokens: Number(r.tokens),
    }));
  } catch (err) {
    return [];
  }
}

/** Error breakdown — by error class. */
export async function getErrorBreakdown(hours = 24) {
  await ensureTelemetrySchema();
  if (!(await isEnabled())) return [];
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  try {
    const res = await query(
      `SELECT error_class, COUNT(*) AS count
       FROM telemetry_events
       WHERE event_type = 'llm_call' AND created_at >= $1 AND success = false AND error_class IS NOT NULL
       GROUP BY error_class ORDER BY count DESC`,
      [since]
    );
    return (res?.rows || []).map((r) => ({
      errorClass: r.error_class,
      count: Number(r.count),
    }));
  } catch (err) {
    return [];
  }
}

/** Recent events for the activity feed. */
export async function getRecentEvents(limit = 20) {
  await ensureTelemetrySchema();
  if (!(await isEnabled())) {
    return _ringBuffer.slice(-limit).reverse();
  }
  try {
    const res = await query(
      `SELECT event_type, provider, model, duration_ms, success, error_class, created_at
       FROM telemetry_events
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res?.rows || [];
  } catch (err) {
    return [];
  }
}
