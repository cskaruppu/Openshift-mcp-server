import { createHash } from "node:crypto";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

const RING_MAX = 1000;

/**
 * How long the trail is kept.
 *
 * Was hardcoded at 90 days, which is below what most regulated clients need —
 * SOX and PCI DSS commonly expect a year, with ninety days immediately
 * available. "Ninety days, hardcoded" is an audit finding by itself, so this is
 * configurable and the console states the number rather than leaving somebody
 * to read the source to find it.
 */
const DEFAULT_RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS || "365", 10);

export function auditRetentionDays() { return DEFAULT_RETENTION_DAYS; }
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
-- Tamper evidence. Each row carries a hash of its own content plus the hash of
-- the row before it, so the trail is a chain: editing or deleting any row
-- breaks every hash after it, and that break is detectable without a backup to
-- compare against. This is the difference between "we have logs" and "we can
-- show the logs were not edited", which is the question a regulated review
-- actually asks. Added after the table shipped, so existing rows simply have
-- no hash and are reported as unverifiable rather than as tampered with.
ALTER TABLE audit_trail ADD COLUMN IF NOT EXISTS entry_hash CHAR(64);
ALTER TABLE audit_trail ADD COLUMN IF NOT EXISTS prev_hash CHAR(64);
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
    const prevHash = await tailHash();
    const entryHash = hashEntry(row, prevHash);
    const res = await dbQuery(
      `INSERT INTO audit_trail (event_type, severity, title, details, namespace, username, source, created_at, entry_hash, prev_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [row.event_type, row.severity, row.title, row.details ? JSON.stringify(row.details) : null,
       row.namespace, row.username, row.source, row.created_at, entryHash, prevHash]
    );
    // Only advance the chain once the row is actually in.
    if (res?.rows?.[0]?.id != null) _lastHash = entryHash;
    return res?.rows?.[0]?.id ?? null;
  }

  const entry = { id: _ring.length + 1, ...row };
  _ring.push(entry);
  if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX);
  return entry.id;
}

/**
 * The hash of one entry, over the fields that make it what it is.
 *
 * Deliberately excludes the row id — a serial assigned by the database is not
 * part of the event, and including it would make the chain unverifiable after
 * any restore that renumbered rows.
 */
function hashEntry(row, prevHash) {
  return createHash("sha256").update(JSON.stringify([
    prevHash || "",
    row.event_type, row.severity, row.title,
    row.details ? JSON.stringify(row.details) : null,
    row.namespace, row.username, row.source, row.created_at,
  ])).digest("hex");
}

/** The last hash written, so the next entry can chain onto it. */
let _lastHash = null;

async function tailHash() {
  if (_lastHash) return _lastHash;
  try {
    const r = await dbQuery(`SELECT entry_hash FROM audit_trail ORDER BY id DESC LIMIT 1`);
    _lastHash = r?.rows?.[0]?.entry_hash || null;
  } catch { _lastHash = null; }
  return _lastHash;
}

/**
 * Walk the chain and report the first place it breaks.
 *
 * Returns `verified: false` with the offending id, or `verified: null` when
 * there is nothing to check — an empty trail is not a verified one, and rows
 * written before the chain existed are reported as UNVERIFIABLE rather than as
 * tampered with. Saying "tampered" about a row that simply predates the feature
 * is how a security control loses its audience.
 */
export async function verifyAuditChain({ limit = 5000 } = {}) {
  if (!(await dbEnabled())) {
    return { verified: null, reason: "No database is configured, so the trail is held in memory and cannot be verified." };
  }
  await ensureSchema();
  const r = await dbQuery(
    `SELECT id, event_type, severity, title, details, namespace, username, source, created_at,
            entry_hash, prev_hash
       FROM audit_trail ORDER BY id ASC LIMIT $1`, [limit],
  );
  const rows = r?.rows || [];
  if (!rows.length) return { verified: null, checked: 0, reason: "The trail is empty." };

  let prev = null, checked = 0, unchained = 0;
  for (const row of rows) {
    if (!row.entry_hash) { unchained++; prev = null; continue; }
    const expected = hashEntry({
      event_type: row.event_type, severity: row.severity, title: row.title,
      details: typeof row.details === "string" ? JSON.parse(row.details) : row.details,
      namespace: row.namespace, username: row.username, source: row.source,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    }, row.prev_hash);
    if (expected !== row.entry_hash) {
      return {
        verified: false, checked, brokenAt: row.id, at: row.created_at,
        reason: `Entry ${row.id} does not match its recorded hash. Everything after it is unverifiable.`,
      };
    }
    if (prev && row.prev_hash !== prev) {
      return {
        verified: false, checked, brokenAt: row.id, at: row.created_at,
        reason: `Entry ${row.id} does not follow the entry before it — a row between them was removed.`,
      };
    }
    prev = row.entry_hash;
    checked++;
  }
  return {
    verified: true, checked, unchained,
    reason: unchained
      ? `${checked} entries verified. ${unchained} predate tamper-evidence and cannot be checked.`
      : `${checked} entries verified — the chain is intact.`,
  };
}

/**
 * The trail in OCSF shape, for a SIEM that has never heard of this product.
 *
 * Open Cybersecurity Schema Framework is what AWS, Splunk and CrowdStrike
 * converged on, and it is the difference between an export somebody has to
 * write a parser for and one their platform already understands. An audit
 * trail that only lives inside this console is not one a security team will
 * accept as the system of record.
 *
 * Mapped, not invented: every field here comes from a column that already
 * exists. Where OCSF wants something this trail does not record, the field is
 * left out rather than filled with a plausible default.
 */
const OCSF_SEVERITY = { info: 1, warn: 3, error: 4, critical: 5 };

/** OCSF class 3001 — Account Change, 6003 — API Activity, 2001 — Finding. */
const OCSF_CLASS = {
  login: { class_uid: 3002, class_name: "Authentication", category_uid: 3, category_name: "Identity & Access Management" },
  role_change: { class_uid: 3001, class_name: "Account Change", category_uid: 3, category_name: "Identity & Access Management" },
  compliance_scan: { class_uid: 2003, class_name: "Compliance Finding", category_uid: 2, category_name: "Findings" },
  policy_violation: { class_uid: 2003, class_name: "Compliance Finding", category_uid: 2, category_name: "Findings" },
  action_taken: { class_uid: 6003, class_name: "API Activity", category_uid: 6, category_name: "Application Activity" },
  config_change: { class_uid: 6003, class_name: "API Activity", category_uid: 6, category_name: "Application Activity" },
  change_detected: { class_uid: 6003, class_name: "API Activity", category_uid: 6, category_name: "Application Activity" },
  slo_breach: { class_uid: 2004, class_name: "Detection Finding", category_uid: 2, category_name: "Findings" },
  notification_sent: { class_uid: 6003, class_name: "API Activity", category_uid: 6, category_name: "Application Activity" },
};

export function toOcsf(entry) {
  const cls = OCSF_CLASS[entry.event_type] || OCSF_CLASS.action_taken;
  const when = entry.created_at instanceof Date ? entry.created_at : new Date(entry.created_at);
  const out = {
    ...cls,
    type_uid: cls.class_uid * 100,
    activity_id: 0,
    // OCSF wants epoch milliseconds; `time_dt` carries the ISO form beside it.
    time: when.getTime(),
    time_dt: when.toISOString(),
    severity_id: OCSF_SEVERITY[entry.severity] ?? 1,
    severity: entry.severity || "info",
    message: entry.title,
    metadata: {
      version: "1.1.0",
      product: { name: "TCS Agentic AI for Hybrid Infrastructure", vendor_name: "TCS" },
      // Carried so a SIEM can prove the row it holds is the row that was
      // written. Absent on rows that predate tamper-evidence.
      ...(entry.entry_hash ? { log_provider: "audit_trail", uid: entry.entry_hash } : {}),
    },
    unmapped: {},
  };
  if (entry.username) out.actor = { user: { name: entry.username } };
  if (entry.namespace) out.resources = [{ type: "Namespace", name: entry.namespace }];
  if (entry.source) out.unmapped.source = entry.source;
  if (entry.details) out.unmapped.details = entry.details;
  if (entry.id != null) out.unmapped.record_id = entry.id;
  if (!Object.keys(out.unmapped).length) delete out.unmapped;
  return out;
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
