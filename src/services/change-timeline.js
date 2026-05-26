import { randomBytes } from "node:crypto";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

const RING_MAX = 500;
const DEFAULT_RETENTION_DAYS = 30;
const VALID_SOURCES = new Set([
  "deployment",
  "configmap",
  "scaling",
  "alert",
  "k8s_event",
  "gitops",
  "audit_action",
]);
const VALID_SEVERITIES = new Set(["info", "warn", "error", "critical"]);

const _ring = [];
let _schemaReady = false;
let _purgeTimer = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS change_timeline_events (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL UNIQUE,
  source VARCHAR(32) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  namespace VARCHAR(253),
  resource_kind VARCHAR(64),
  resource_name VARCHAR(253),
  title TEXT NOT NULL,
  details JSONB,
  severity VARCHAR(16) DEFAULT 'info',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ctl_created ON change_timeline_events(created_at);
CREATE INDEX IF NOT EXISTS idx_ctl_namespace ON change_timeline_events(namespace);
CREATE INDEX IF NOT EXISTS idx_ctl_source ON change_timeline_events(source);
`;

async function ensureSchema() {
  if (_schemaReady) return;
  if (!(await dbEnabled())) return;
  try {
    await dbQuery(SCHEMA_SQL);
    _schemaReady = true;
  } catch (err) {
    console.error("[change-timeline] schema bootstrap failed:", err.message);
  }
}

function generateEventId() {
  return `evt-${randomBytes(8).toString("hex")}`;
}

export async function initChangeTimeline() {
  await ensureSchema();

  if (_purgeTimer) clearInterval(_purgeTimer);
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  _purgeTimer = setInterval(() => {
    purgeOldEvents(DEFAULT_RETENTION_DAYS).catch((err) =>
      console.error("[change-timeline] auto-purge failed:", err.message)
    );
  }, ONE_DAY_MS);
  _purgeTimer.unref?.();
}

export async function recordChangeEvent(event = {}) {
  const {
    source,
    eventType,
    namespace,
    resourceKind,
    resourceName,
    title,
    details,
    severity = "info",
  } = event;

  if (!source || !eventType || !title) {
    throw new Error("change event requires 'source', 'eventType', and 'title'");
  }
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`invalid change event source: ${source}`);
  }
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(`invalid severity: ${severity}`);
  }

  const row = {
    event_id: generateEventId(),
    source,
    event_type: eventType,
    namespace: namespace || null,
    resource_kind: resourceKind || null,
    resource_name: resourceName || null,
    title,
    details: details || null,
    severity,
    created_at: new Date().toISOString(),
  };

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `INSERT INTO change_timeline_events
         (event_id, source, event_type, namespace, resource_kind, resource_name, title, details, severity, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        row.event_id,
        row.source,
        row.event_type,
        row.namespace,
        row.resource_kind,
        row.resource_name,
        row.title,
        row.details ? JSON.stringify(row.details) : null,
        row.severity,
        row.created_at,
      ]
    );
    return res?.rows?.[0] ?? null;
  }

  const entry = { id: _ring.length + 1, ...row };
  _ring.push(entry);
  if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX);
  return entry;
}

export async function getTimeline(filters = {}) {
  const {
    fromDate,
    toDate,
    namespace,
    sources,
    severity,
    limit = 100,
    offset = 0,
  } = filters;

  if (await dbEnabled()) {
    await ensureSchema();
    const conditions = [];
    const params = [];
    let idx = 1;

    if (fromDate) { conditions.push(`created_at >= $${idx++}`); params.push(fromDate); }
    if (toDate) { conditions.push(`created_at <= $${idx++}`); params.push(toDate); }
    if (namespace) { conditions.push(`namespace = $${idx++}`); params.push(namespace); }
    if (Array.isArray(sources) && sources.length > 0) {
      conditions.push(`source = ANY($${idx++})`);
      params.push(sources);
    }
    if (severity) { conditions.push(`severity = $${idx++}`); params.push(severity); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRes = await dbQuery(
      `SELECT COUNT(*) AS total FROM change_timeline_events ${where}`,
      params
    );
    const total = parseInt(countRes?.rows?.[0]?.total ?? "0", 10);

    const dataParams = [...params, limit, offset];
    const dataRes = await dbQuery(
      `SELECT * FROM change_timeline_events ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      dataParams
    );

    return { events: dataRes?.rows ?? [], total };
  }

  let filtered = _ring;
  if (fromDate) filtered = filtered.filter((e) => new Date(e.created_at) >= new Date(fromDate));
  if (toDate) filtered = filtered.filter((e) => new Date(e.created_at) <= new Date(toDate));
  if (namespace) filtered = filtered.filter((e) => e.namespace === namespace);
  if (Array.isArray(sources) && sources.length > 0) {
    const set = new Set(sources);
    filtered = filtered.filter((e) => set.has(e.source));
  }
  if (severity) filtered = filtered.filter((e) => e.severity === severity);

  const total = filtered.length;
  const events = filtered.slice().reverse().slice(offset, offset + limit);
  return { events, total };
}

export async function correlateAroundTime({ timestamp, windowMinutes = 15 } = {}) {
  if (!timestamp) {
    throw new Error("correlateAroundTime requires 'timestamp'");
  }
  const center = new Date(timestamp);
  if (Number.isNaN(center.getTime())) {
    throw new Error(`invalid timestamp: ${timestamp}`);
  }
  const windowMs = Math.max(0, Number(windowMinutes) || 0) * 60 * 1000;
  const start = new Date(center.getTime() - windowMs).toISOString();
  const end = new Date(center.getTime() + windowMs).toISOString();

  let events = [];

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `SELECT * FROM change_timeline_events
       WHERE created_at >= $1 AND created_at <= $2
       ORDER BY created_at ASC`,
      [start, end]
    );
    events = res?.rows ?? [];
  } else {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    events = _ring
      .filter((e) => {
        const t = new Date(e.created_at).getTime();
        return t >= startMs && t <= endMs;
      })
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  const bySource = {};
  for (const ev of events) {
    const key = ev.source || "unknown";
    if (!bySource[key]) bySource[key] = [];
    bySource[key].push(ev);
  }

  return {
    window: { start, end, center: center.toISOString(), windowMinutes },
    total: events.length,
    bySource,
    events,
  };
}

export async function getTimelineStats({ days = 7 } = {}) {
  if (await dbEnabled()) {
    await ensureSchema();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [totalRes, bySource, bySeverity, byHour, byNamespace] = await Promise.all([
      dbQuery(
        `SELECT COUNT(*)::int AS total FROM change_timeline_events WHERE created_at >= $1`,
        [cutoff]
      ),
      dbQuery(
        `SELECT source, COUNT(*)::int AS count FROM change_timeline_events
         WHERE created_at >= $1 GROUP BY source ORDER BY count DESC`,
        [cutoff]
      ),
      dbQuery(
        `SELECT severity, COUNT(*)::int AS count FROM change_timeline_events
         WHERE created_at >= $1 GROUP BY severity ORDER BY count DESC`,
        [cutoff]
      ),
      dbQuery(
        `SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count
         FROM change_timeline_events
         WHERE created_at >= $1
         GROUP BY hour ORDER BY count DESC LIMIT 24`,
        [cutoff]
      ),
      dbQuery(
        `SELECT namespace, COUNT(*)::int AS count FROM change_timeline_events
         WHERE created_at >= $1 AND namespace IS NOT NULL
         GROUP BY namespace ORDER BY count DESC LIMIT 20`,
        [cutoff]
      ),
    ]);

    return {
      total: totalRes?.rows?.[0]?.total ?? 0,
      bySource: bySource?.rows ?? [],
      bySeverity: bySeverity?.rows ?? [],
      busiestHours: byHour?.rows ?? [],
      busiestNamespaces: byNamespace?.rows ?? [],
    };
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const recent = _ring.filter((e) => new Date(e.created_at) >= cutoff);

  const countBy = (arr, key) => {
    const map = {};
    for (const item of arr) {
      const val = item[key];
      if (val != null) map[val] = (map[val] || 0) + 1;
    }
    return Object.entries(map)
      .map(([k, count]) => ({ [key]: k, count }))
      .sort((a, b) => b.count - a.count);
  };

  const hourMap = {};
  for (const e of recent) {
    const h = new Date(e.created_at).getHours();
    hourMap[h] = (hourMap[h] || 0) + 1;
  }
  const busiestHours = Object.entries(hourMap)
    .map(([hour, count]) => ({ hour: Number(hour), count }))
    .sort((a, b) => b.count - a.count);

  return {
    total: recent.length,
    bySource: countBy(recent, "source"),
    bySeverity: countBy(recent, "severity"),
    busiestHours,
    busiestNamespaces: countBy(recent, "namespace").slice(0, 20),
  };
}

export async function purgeOldEvents(retentionDays = DEFAULT_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `DELETE FROM change_timeline_events WHERE created_at < $1`,
      [cutoff.toISOString()]
    );
    const deleted = res?.rowCount ?? 0;
    if (deleted > 0) {
      console.log(`[change-timeline] purged ${deleted} events older than ${retentionDays} days`);
    }
    return deleted;
  }

  const before = _ring.length;
  let i = 0;
  while (i < _ring.length && new Date(_ring[i].created_at) < cutoff) i++;
  if (i > 0) _ring.splice(0, i);
  const deleted = before - _ring.length;
  if (deleted > 0) {
    console.log(`[change-timeline] purged ${deleted} in-memory events older than ${retentionDays} days`);
  }
  return deleted;
}
