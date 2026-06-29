import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

const RING_MAX = 1000;
const DEFAULT_RETENTION_DAYS = 90;
const VALID_EVENT_TYPES = new Set([
  "compliance_scan",
  "policy_violation",
  "change_detected",
  "action_taken",
  "slo_breach",
  "notification_sent",
  "login",
  "role_change",
  "config_change",
]);
const VALID_SEVERITIES = new Set(["info", "warn", "error", "critical"]);

const _ring = [];
let _schemaReady = false;
let _purgeTimer = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_trail (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  severity VARCHAR(16) DEFAULT 'info',
  title TEXT NOT NULL,
  details JSONB,
  namespace VARCHAR(253),
  username VARCHAR(253),
  source VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_trail_type ON audit_trail(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_trail_created ON audit_trail(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_trail_ns ON audit_trail(namespace);
`;

async function ensureSchema() {
  if (_schemaReady) return;
  if (!(await dbEnabled())) return;
  try {
    await dbQuery(SCHEMA_SQL);
    _schemaReady = true;
  } catch (err) {
    console.error("[audit-log] schema bootstrap failed:", err.message);
  }
}

export async function initAuditLog() {
  await ensureSchema();

  if (_purgeTimer) clearInterval(_purgeTimer);
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  _purgeTimer = setInterval(() => {
    purgeOldEvents(DEFAULT_RETENTION_DAYS).catch((err) =>
      console.error("[audit-log] auto-purge failed:", err.message)
    );
  }, ONE_DAY_MS);
  _purgeTimer.unref?.();
}

export async function logAuditEvent(event) {
  const type = event.type;
  const severity = event.severity || "info";
  const title = event.title;

  if (!type || !title) {
    throw new Error("audit event requires 'type' and 'title'");
  }
  if (!VALID_EVENT_TYPES.has(type)) {
    throw new Error(`invalid audit event type: ${type}`);
  }
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(`invalid severity: ${severity}`);
  }

  const row = {
    event_type: type,
    severity,
    title,
    details: event.details || null,
    namespace: event.namespace || null,
    username: event.username || null,
    source: event.source || null,
    created_at: new Date().toISOString(),
  };

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `INSERT INTO audit_trail (event_type, severity, title, details, namespace, username, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [row.event_type, row.severity, row.title, row.details ? JSON.stringify(row.details) : null,
       row.namespace, row.username, row.source, row.created_at]
    );
    return res?.rows?.[0]?.id ?? null;
  }

  const entry = { id: _ring.length + 1, ...row };
  _ring.push(entry);
  if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX);
  return entry.id;
}

export async function queryAuditLog(filters = {}) {
  const { type, severity, namespace, username, from, to, limit = 100, offset = 0 } = filters;

  if (await dbEnabled()) {
    await ensureSchema();
    const conditions = [];
    const params = [];
    let idx = 1;

    if (type) { conditions.push(`event_type = $${idx++}`); params.push(type); }
    if (severity) { conditions.push(`severity = $${idx++}`); params.push(severity); }
    if (namespace) { conditions.push(`namespace = $${idx++}`); params.push(namespace); }
    if (username) { conditions.push(`username = $${idx++}`); params.push(username); }
    if (from) { conditions.push(`created_at >= $${idx++}`); params.push(from); }
    if (to) { conditions.push(`created_at <= $${idx++}`); params.push(to); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRes = await dbQuery(`SELECT COUNT(*) AS total FROM audit_trail ${where}`, params);
    const total = parseInt(countRes?.rows?.[0]?.total ?? "0", 10);

    const dataParams = [...params, limit, offset];
    const dataRes = await dbQuery(
      `SELECT * FROM audit_trail ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      dataParams
    );

    return { events: dataRes?.rows ?? [], total };
  }

  let filtered = _ring;
  if (type) filtered = filtered.filter((e) => e.event_type === type);
  if (severity) filtered = filtered.filter((e) => e.severity === severity);
  if (namespace) filtered = filtered.filter((e) => e.namespace === namespace);
  if (username) filtered = filtered.filter((e) => e.username === username);
  if (from) filtered = filtered.filter((e) => new Date(e.created_at) >= new Date(from));
  if (to) filtered = filtered.filter((e) => new Date(e.created_at) <= new Date(to));

  const total = filtered.length;
  const events = filtered.slice().reverse().slice(offset, offset + limit);
  return { events, total };
}

export async function getAuditStats(days = 30) {
  if (await dbEnabled()) {
    await ensureSchema();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [byType, bySeverity, byNamespace] = await Promise.all([
      dbQuery(
        `SELECT event_type, COUNT(*)::int AS count FROM audit_trail WHERE created_at >= $1 GROUP BY event_type ORDER BY count DESC`,
        [cutoff]
      ),
      dbQuery(
        `SELECT severity, COUNT(*)::int AS count FROM audit_trail WHERE created_at >= $1 GROUP BY severity ORDER BY count DESC`,
        [cutoff]
      ),
      dbQuery(
        `SELECT namespace, COUNT(*)::int AS count FROM audit_trail WHERE created_at >= $1 AND namespace IS NOT NULL GROUP BY namespace ORDER BY count DESC`,
        [cutoff]
      ),
    ]);

    const sevRows = bySeverity?.rows ?? [];
    const sevCount = (name) => sevRows.find((s) => s.severity === name)?.count || 0;
    return {
      byType: byType?.rows ?? [],
      bySeverity: sevRows,
      byNamespace: byNamespace?.rows ?? [],
      total: sevRows.reduce((a, s) => a + (s.count || 0), 0),
      critical: sevCount("critical"),
      warnings: sevCount("warn") + sevCount("warning"),
      info: sevCount("info"),
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

  const bySeverity = countBy(recent, "severity");
  const sevCount = (name) => bySeverity.find((s) => s.severity === name)?.count || 0;
  return {
    byType: countBy(recent, "event_type"),
    bySeverity,
    byNamespace: countBy(recent, "namespace"),
    total: recent.length,
    critical: sevCount("critical"),
    warnings: sevCount("warn") + sevCount("warning"),
    info: sevCount("info"),
  };
}

export async function purgeOldEvents(retentionDays = DEFAULT_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `DELETE FROM audit_trail WHERE created_at < $1`,
      [cutoff.toISOString()]
    );
    const deleted = res?.rowCount ?? 0;
    if (deleted > 0) {
      console.log(`[audit-log] purged ${deleted} events older than ${retentionDays} days`);
    }
    return deleted;
  }

  const before = _ring.length;
  let i = 0;
  while (i < _ring.length && new Date(_ring[i].created_at) < cutoff) i++;
  if (i > 0) _ring.splice(0, i);
  const deleted = before - _ring.length;
  if (deleted > 0) {
    console.log(`[audit-log] purged ${deleted} in-memory events older than ${retentionDays} days`);
  }
  return deleted;
}

export async function exportAuditLog(filters = {}, format = "json") {
  const { events } = await queryAuditLog({ ...filters, limit: 100000, offset: 0 });

  if (format === "csv") {
    const columns = ["id", "event_type", "severity", "title", "details", "namespace", "username", "source", "created_at"];
    const escapeCSV = (val) => {
      if (val == null) return "";
      const str = typeof val === "object" ? JSON.stringify(val) : String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    const header = columns.join(",");
    const rows = events.map((e) => columns.map((c) => escapeCSV(e[c])).join(","));
    return [header, ...rows].join("\n");
  }

  return events;
}
