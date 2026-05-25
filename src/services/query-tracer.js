import { randomBytes } from "node:crypto";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

const RING_MAX = 500;
const DEFAULT_RETENTION_DAYS = 90;

const _ring = [];
let _schemaReady = false;
let _purgeTimer = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS query_traces (
  id SERIAL PRIMARY KEY,
  trace_id VARCHAR(64) NOT NULL UNIQUE,
  conversation_id VARCHAR(128),
  query_text TEXT NOT NULL,
  provider VARCHAR(64),
  total_duration_ms INTEGER,
  agent_count INTEGER DEFAULT 0,
  tool_count INTEGER DEFAULT 0,
  status VARCHAR(16) DEFAULT 'success',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS query_trace_spans (
  id SERIAL PRIMARY KEY,
  trace_id VARCHAR(64) NOT NULL REFERENCES query_traces(trace_id) ON DELETE CASCADE,
  span_order INTEGER NOT NULL,
  agent_id VARCHAR(128),
  agent_name VARCHAR(128) NOT NULL,
  agent_icon VARCHAR(32),
  agent_color VARCHAR(16),
  category VARCHAR(64),
  tools_called TEXT[],
  status VARCHAR(16) DEFAULT 'active',
  duration_ms INTEGER,
  resources_touched JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qt_created ON query_traces(created_at);
CREATE INDEX IF NOT EXISTS idx_qt_conv ON query_traces(conversation_id);
CREATE INDEX IF NOT EXISTS idx_qts_trace ON query_trace_spans(trace_id);
`;

async function ensureSchema() {
  if (_schemaReady) return;
  if (!(await dbEnabled())) return;
  try {
    await dbQuery(SCHEMA_SQL);
    _schemaReady = true;
  } catch (err) {
    console.error("[query-tracer] schema bootstrap failed:", err.message);
  }
}

export function generateTraceId() {
  return "trace-" + randomBytes(16).toString("hex");
}

export async function initQueryTracer() {
  await ensureSchema();

  if (_purgeTimer) clearInterval(_purgeTimer);
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  _purgeTimer = setInterval(() => {
    purgeOldTraces(DEFAULT_RETENTION_DAYS).catch((err) =>
      console.error("[query-tracer] auto-purge failed:", err.message)
    );
  }, ONE_DAY_MS);
  _purgeTimer.unref?.();
}

export async function recordTrace({ traceId, conversationId, queryText, provider, totalDurationMs, status, spans }) {
  if (!traceId || !queryText) {
    throw new Error("recordTrace requires 'traceId' and 'queryText'");
  }

  const safeSpans = spans || [];
  const allTools = safeSpans.flatMap((s) => s.toolsCalled || []);

  const row = {
    trace_id: traceId,
    conversation_id: conversationId || null,
    query_text: queryText,
    provider: provider || null,
    total_duration_ms: totalDurationMs ?? null,
    agent_count: safeSpans.length,
    tool_count: allTools.length,
    status: status || "success",
    created_at: new Date().toISOString(),
  };

  if (await dbEnabled()) {
    await ensureSchema();
    await dbQuery(
      `INSERT INTO query_traces (trace_id, conversation_id, query_text, provider, total_duration_ms, agent_count, tool_count, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.trace_id, row.conversation_id, row.query_text, row.provider,
       row.total_duration_ms, row.agent_count, row.tool_count, row.status, row.created_at]
    );

    for (let i = 0; i < safeSpans.length; i++) {
      const s = safeSpans[i];
      await dbQuery(
        `INSERT INTO query_trace_spans (trace_id, span_order, agent_id, agent_name, agent_icon, agent_color, category, tools_called, status, duration_ms, resources_touched, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [traceId, i, s.agentId || null, s.agentName, s.icon || null, s.color || null,
         s.category || null, s.toolsCalled || [], s.status || "active",
         s.durationMs ?? null, s.resourcesTouched ? JSON.stringify(s.resourcesTouched) : null,
         row.created_at]
      );
    }

    return traceId;
  }

  const entry = { ...row, spans: safeSpans.map((s, i) => ({ span_order: i, ...s })) };
  _ring.push(entry);
  if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX);
  return traceId;
}

export async function getTrace(traceId) {
  if (await dbEnabled()) {
    await ensureSchema();
    const traceRes = await dbQuery(
      `SELECT * FROM query_traces WHERE trace_id = $1`,
      [traceId]
    );
    const trace = traceRes?.rows?.[0];
    if (!trace) return null;

    const spanRes = await dbQuery(
      `SELECT * FROM query_trace_spans WHERE trace_id = $1 ORDER BY span_order`,
      [traceId]
    );
    trace.spans = spanRes?.rows ?? [];
    return trace;
  }

  return _ring.find((t) => t.trace_id === traceId) || null;
}

export async function getTraces(filters = {}) {
  const { limit = 50, offset = 0, conversationId, agentId, fromDate, toDate } = filters;

  if (await dbEnabled()) {
    await ensureSchema();
    const conditions = [];
    const params = [];
    let idx = 1;

    if (conversationId) { conditions.push(`t.conversation_id = $${idx++}`); params.push(conversationId); }
    if (fromDate) { conditions.push(`t.created_at >= $${idx++}`); params.push(fromDate); }
    if (toDate) { conditions.push(`t.created_at <= $${idx++}`); params.push(toDate); }
    if (agentId) {
      conditions.push(`EXISTS (SELECT 1 FROM query_trace_spans s WHERE s.trace_id = t.trace_id AND s.agent_id = $${idx++})`);
      params.push(agentId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRes = await dbQuery(`SELECT COUNT(*) AS total FROM query_traces t ${where}`, params);
    const total = parseInt(countRes?.rows?.[0]?.total ?? "0", 10);

    const dataParams = [...params, limit, offset];
    const dataRes = await dbQuery(
      `SELECT t.* FROM query_traces t ${where} ORDER BY t.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      dataParams
    );
    const traces = dataRes?.rows ?? [];

    if (traces.length > 0) {
      const traceIds = traces.map((t) => t.trace_id);
      const spanRes = await dbQuery(
        `SELECT * FROM query_trace_spans WHERE trace_id = ANY($1) ORDER BY trace_id, span_order`,
        [traceIds]
      );
      const spansByTrace = {};
      for (const span of spanRes?.rows ?? []) {
        if (!spansByTrace[span.trace_id]) spansByTrace[span.trace_id] = [];
        spansByTrace[span.trace_id].push(span);
      }
      for (const t of traces) {
        t.spans = spansByTrace[t.trace_id] || [];
      }
    }

    return { traces, total };
  }

  let filtered = _ring;
  if (conversationId) filtered = filtered.filter((t) => t.conversation_id === conversationId);
  if (agentId) filtered = filtered.filter((t) => t.spans?.some((s) => s.agentId === agentId));
  if (fromDate) filtered = filtered.filter((t) => new Date(t.created_at) >= new Date(fromDate));
  if (toDate) filtered = filtered.filter((t) => new Date(t.created_at) <= new Date(toDate));

  const total = filtered.length;
  const traces = filtered.slice().reverse().slice(offset, offset + limit);
  return { traces, total };
}

export async function getAgentAnalytics(opts = {}) {
  const { days = 30 } = opts;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `SELECT
         s.agent_id,
         s.agent_name,
         COUNT(*)::int AS invocation_count,
         ROUND(AVG(s.duration_ms))::int AS avg_duration_ms,
         ROUND(100.0 * COUNT(*) FILTER (WHERE s.status = 'error') / NULLIF(COUNT(*), 0), 2) AS error_rate,
         array_agg(DISTINCT tool) AS most_common_tools,
         MAX(s.created_at) AS last_used
       FROM query_trace_spans s,
            LATERAL unnest(COALESCE(s.tools_called, ARRAY[]::text[])) AS tool
       WHERE s.created_at >= $1
       GROUP BY s.agent_id, s.agent_name
       ORDER BY invocation_count DESC`,
      [cutoff]
    );

    // Agents with no tools_called won't appear above; fetch them separately
    const noToolRes = await dbQuery(
      `SELECT
         s.agent_id,
         s.agent_name,
         COUNT(*)::int AS invocation_count,
         ROUND(AVG(s.duration_ms))::int AS avg_duration_ms,
         ROUND(100.0 * COUNT(*) FILTER (WHERE s.status = 'error') / NULLIF(COUNT(*), 0), 2) AS error_rate,
         ARRAY[]::text[] AS most_common_tools,
         MAX(s.created_at) AS last_used
       FROM query_trace_spans s
       WHERE s.created_at >= $1 AND (s.tools_called IS NULL OR array_length(s.tools_called, 1) IS NULL)
       GROUP BY s.agent_id, s.agent_name
       ORDER BY invocation_count DESC`,
      [cutoff]
    );

    const merged = new Map();
    for (const row of [...(res?.rows ?? []), ...(noToolRes?.rows ?? [])]) {
      const key = row.agent_id || row.agent_name;
      if (!merged.has(key)) {
        merged.set(key, row);
      } else {
        const existing = merged.get(key);
        existing.invocation_count += row.invocation_count;
        if (new Date(row.last_used) > new Date(existing.last_used)) {
          existing.last_used = row.last_used;
        }
      }
    }

    return { agents: Array.from(merged.values()) };
  }

  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const recent = _ring.filter((t) => new Date(t.created_at) >= cutoffDate);
  const agentMap = {};

  for (const trace of recent) {
    for (const span of trace.spans || []) {
      const key = span.agentId || span.agentName;
      if (!agentMap[key]) {
        agentMap[key] = {
          agent_id: span.agentId,
          agent_name: span.agentName,
          invocation_count: 0,
          total_duration_ms: 0,
          error_count: 0,
          tools: {},
          last_used: trace.created_at,
        };
      }
      const a = agentMap[key];
      a.invocation_count++;
      if (span.durationMs) a.total_duration_ms += span.durationMs;
      if (span.status === "error") a.error_count++;
      for (const tool of span.toolsCalled || []) {
        a.tools[tool] = (a.tools[tool] || 0) + 1;
      }
      if (new Date(trace.created_at) > new Date(a.last_used)) {
        a.last_used = trace.created_at;
      }
    }
  }

  const agents = Object.values(agentMap).map((a) => ({
    agent_id: a.agent_id,
    agent_name: a.agent_name,
    invocation_count: a.invocation_count,
    avg_duration_ms: a.invocation_count > 0 ? Math.round(a.total_duration_ms / a.invocation_count) : null,
    error_rate: a.invocation_count > 0 ? Math.round((10000 * a.error_count) / a.invocation_count) / 100 : 0,
    most_common_tools: Object.entries(a.tools).sort((x, y) => y[1] - x[1]).map(([t]) => t),
    last_used: a.last_used,
  })).sort((a, b) => b.invocation_count - a.invocation_count);

  return { agents };
}

export async function getTraceStats(opts = {}) {
  const { days = 30 } = opts;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  if (await dbEnabled()) {
    await ensureSchema();
    const [overview, topAgents, busyHours] = await Promise.all([
      dbQuery(
        `SELECT
           COUNT(*)::int AS total_queries,
           ROUND(AVG(agent_count), 2) AS avg_agents_per_query,
           ROUND(AVG(total_duration_ms))::int AS avg_duration_ms
         FROM query_traces
         WHERE created_at >= $1`,
        [cutoff]
      ),
      dbQuery(
        `SELECT agent_name, COUNT(*)::int AS count
         FROM query_trace_spans
         WHERE created_at >= $1
         GROUP BY agent_name
         ORDER BY count DESC
         LIMIT 10`,
        [cutoff]
      ),
      dbQuery(
        `SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count
         FROM query_traces
         WHERE created_at >= $1
         GROUP BY hour
         ORDER BY count DESC`,
        [cutoff]
      ),
    ]);

    const stats = overview?.rows?.[0] ?? {};
    return {
      total_queries: stats.total_queries ?? 0,
      avg_agents_per_query: parseFloat(stats.avg_agents_per_query ?? 0),
      avg_duration_ms: stats.avg_duration_ms ?? 0,
      top_agents: topAgents?.rows ?? [],
      busiest_hours: busyHours?.rows ?? [],
    };
  }

  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const recent = _ring.filter((t) => new Date(t.created_at) >= cutoffDate);

  const totalQueries = recent.length;
  const totalAgents = recent.reduce((sum, t) => sum + (t.agent_count || 0), 0);
  const totalDuration = recent.reduce((sum, t) => sum + (t.total_duration_ms || 0), 0);

  const agentCounts = {};
  const hourCounts = {};

  for (const trace of recent) {
    const hour = new Date(trace.created_at).getUTCHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    for (const span of trace.spans || []) {
      agentCounts[span.agentName] = (agentCounts[span.agentName] || 0) + 1;
    }
  }

  const topAgents = Object.entries(agentCounts)
    .map(([agent_name, count]) => ({ agent_name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const busiestHours = Object.entries(hourCounts)
    .map(([hour, count]) => ({ hour: parseInt(hour, 10), count }))
    .sort((a, b) => b.count - a.count);

  return {
    total_queries: totalQueries,
    avg_agents_per_query: totalQueries > 0 ? Math.round((100 * totalAgents) / totalQueries) / 100 : 0,
    avg_duration_ms: totalQueries > 0 ? Math.round(totalDuration / totalQueries) : 0,
    top_agents: topAgents,
    busiest_hours: busiestHours,
  };
}

async function purgeOldTraces(retentionDays = DEFAULT_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `DELETE FROM query_traces WHERE created_at < $1`,
      [cutoff.toISOString()]
    );
    const deleted = res?.rowCount ?? 0;
    if (deleted > 0) {
      console.log(`[query-tracer] purged ${deleted} traces older than ${retentionDays} days`);
    }
    return deleted;
  }

  const before = _ring.length;
  let i = 0;
  while (i < _ring.length && new Date(_ring[i].created_at) < cutoff) i++;
  if (i > 0) _ring.splice(0, i);
  const deleted = before - _ring.length;
  if (deleted > 0) {
    console.log(`[query-tracer] purged ${deleted} in-memory traces older than ${retentionDays} days`);
  }
  return deleted;
}
