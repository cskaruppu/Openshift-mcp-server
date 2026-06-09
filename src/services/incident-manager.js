import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

const RING_MAX = 200;
const DEFAULT_RETENTION_DAYS = 90;
const VALID_SEVERITIES = new Set(["sev1", "sev2", "sev3", "sev4"]);
const VALID_STATUSES = new Set([
  "declared",
  "triaging",
  "investigating",
  "mitigating",
  "resolved",
  "postmortem",
  "closed",
]);
const STATUS_TRANSITIONS = {
  declared: new Set(["triaging", "investigating", "mitigating", "resolved", "closed"]),
  triaging: new Set(["investigating", "mitigating", "resolved", "closed"]),
  investigating: new Set(["triaging", "mitigating", "resolved", "closed"]),
  mitigating: new Set(["investigating", "resolved", "closed"]),
  resolved: new Set(["postmortem", "closed", "investigating"]),
  postmortem: new Set(["closed", "resolved"]),
  closed: new Set([]),
};
const PATCH_FIELDS = {
  title: "title",
  description: "description",
  severity: "severity",
  status: "status",
  assignee: "assignee",
  affectedNamespaces: "affected_namespaces",
  affectedServices: "affected_services",
  linkedAlerts: "linked_alerts",
  linkedRcaId: "linked_rca_id",
  rootCause: "root_cause",
  resolutionNote: "resolution_note",
  postmortem: "postmortem",
};

const _ring = [];
let _ringSeq = 0;
let _schemaReady = false;
let _purgeTimer = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS incidents (
  id SERIAL PRIMARY KEY,
  incident_id VARCHAR(32) NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  severity VARCHAR(8) DEFAULT 'sev3',
  status VARCHAR(24) DEFAULT 'declared',
  assignee VARCHAR(253),
  affected_namespaces TEXT[],
  affected_services TEXT[],
  linked_alerts TEXT[],
  linked_rca_id VARCHAR(64),
  timeline JSONB DEFAULT '[]'::jsonb,
  root_cause TEXT,
  resolution_note TEXT,
  postmortem TEXT,
  cluster TEXT NOT NULL DEFAULT 'local',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_cluster ON incidents(cluster, created_at DESC);
`;

async function ensureSchema() {
  if (_schemaReady) return;
  if (!(await dbEnabled())) return;
  try {
    await dbQuery(SCHEMA_SQL);
    await dbQuery(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS cluster TEXT NOT NULL DEFAULT 'local'`).catch(() => {});
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_incidents_cluster ON incidents(cluster, created_at DESC)`).catch(() => {});
    _schemaReady = true;
  } catch (err) {
    console.error("[incident-manager] schema bootstrap failed:", err.message);
  }
}

export async function initIncidentManager() {
  await ensureSchema();

  if (_purgeTimer) clearInterval(_purgeTimer);
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  _purgeTimer = setInterval(() => {
    purgeOldIncidents(DEFAULT_RETENTION_DAYS).catch((err) =>
      console.error("[incident-manager] auto-purge failed:", err.message)
    );
  }, ONE_DAY_MS);
  _purgeTimer.unref?.();
}

async function nextIncidentId() {
  const year = new Date().getUTCFullYear();
  const prefix = `INC-${year}-`;

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `SELECT incident_id FROM incidents WHERE incident_id LIKE $1 ORDER BY incident_id DESC LIMIT 1`,
      [`${prefix}%`]
    );
    const last = res?.rows?.[0]?.incident_id;
    let seq = 1;
    if (last) {
      const parsed = parseInt(last.slice(prefix.length), 10);
      if (Number.isFinite(parsed)) seq = parsed + 1;
    }
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  let maxSeq = 0;
  for (const inc of _ring) {
    if (inc.incident_id?.startsWith(prefix)) {
      const parsed = parseInt(inc.incident_id.slice(prefix.length), 10);
      if (Number.isFinite(parsed) && parsed > maxSeq) maxSeq = parsed;
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}

export async function declareIncident(input = {}) {
  const {
    title,
    description = null,
    severity = "sev3",
    affectedNamespaces = [],
    affectedServices = [],
    linkedAlerts = [],
    declaredBy = null,
    cluster = "local",
  } = input;

  if (!title) throw new Error("incident requires 'title'");
  if (!VALID_SEVERITIES.has(severity)) throw new Error(`invalid severity: ${severity}`);

  const now = new Date().toISOString();
  const incidentId = await nextIncidentId();
  const timeline = [
    {
      ts: now,
      actor: declaredBy || "system",
      action: "declared",
      note: `Incident declared with severity ${severity}`,
    },
  ];

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `INSERT INTO incidents (incident_id, title, description, severity, status, affected_namespaces, affected_services, linked_alerts, timeline, cluster, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'declared', $5, $6, $7, $8::jsonb, $9, $10, $10)
       RETURNING *`,
      [
        incidentId,
        title,
        description,
        severity,
        affectedNamespaces,
        affectedServices,
        linkedAlerts,
        JSON.stringify(timeline),
        cluster || "local",
        now,
      ]
    );
    return res?.rows?.[0] ?? null;
  }

  const entry = {
    id: ++_ringSeq,
    incident_id: incidentId,
    title,
    description,
    severity,
    status: "declared",
    assignee: null,
    affected_namespaces: affectedNamespaces,
    affected_services: affectedServices,
    linked_alerts: linkedAlerts,
    linked_rca_id: null,
    timeline,
    root_cause: null,
    resolution_note: null,
    postmortem: null,
    cluster: cluster || "local",
    created_at: now,
    updated_at: now,
    resolved_at: null,
  };
  _ring.push(entry);
  if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX);
  return entry;
}

function validateTransition(from, to) {
  if (from === to) return;
  if (!VALID_STATUSES.has(to)) throw new Error(`invalid status: ${to}`);
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new Error(`invalid status transition: ${from} -> ${to}`);
  }
}

export async function updateIncident(incidentId, patch = {}, actor = "system") {
  if (!incidentId) throw new Error("incidentId required");

  const current = await getIncident(incidentId);
  if (!current) throw new Error(`incident not found: ${incidentId}`);

  const setCols = [];
  const params = [];
  const changes = {};
  let idx = 1;

  for (const [key, col] of Object.entries(PATCH_FIELDS)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (key === "severity" && value != null && !VALID_SEVERITIES.has(value)) {
      throw new Error(`invalid severity: ${value}`);
    }
    if (key === "status" && value != null) {
      validateTransition(current.status, value);
    }
    setCols.push(`${col} = $${idx++}`);
    params.push(value);
    changes[key] = value;
  }

  if (setCols.length === 0) return current;

  const now = new Date().toISOString();
  const timelineEvent = {
    ts: now,
    actor: actor || "system",
    action: "updated",
    note: `Updated fields: ${Object.keys(changes).join(", ")}`,
  };

  if (await dbEnabled()) {
    await ensureSchema();
    setCols.push(`updated_at = $${idx++}`);
    params.push(now);
    if ("status" in changes && changes.status === "resolved" && !current.resolved_at) {
      setCols.push(`resolved_at = $${idx++}`);
      params.push(now);
    }
    setCols.push(`timeline = timeline || $${idx++}::jsonb`);
    params.push(JSON.stringify([timelineEvent]));
    params.push(incidentId);
    const res = await dbQuery(
      `UPDATE incidents SET ${setCols.join(", ")} WHERE incident_id = $${idx} RETURNING *`,
      params
    );
    return res?.rows?.[0] ?? null;
  }

  const entry = _ring.find((e) => e.incident_id === incidentId);
  if (!entry) return null;
  for (const [key, col] of Object.entries(PATCH_FIELDS)) {
    if (key in patch) entry[col] = patch[key];
  }
  entry.updated_at = now;
  if ("status" in changes && changes.status === "resolved" && !entry.resolved_at) {
    entry.resolved_at = now;
  }
  entry.timeline = [...(entry.timeline || []), timelineEvent];
  return entry;
}

export async function addTimelineEvent(incidentId, { actor, action, note } = {}) {
  if (!incidentId) throw new Error("incidentId required");
  if (!action) throw new Error("timeline event requires 'action'");

  const event = {
    ts: new Date().toISOString(),
    actor: actor || "system",
    action,
    note: note || null,
  };

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `UPDATE incidents SET timeline = timeline || $1::jsonb, updated_at = NOW() WHERE incident_id = $2 RETURNING *`,
      [JSON.stringify([event]), incidentId]
    );
    return res?.rows?.[0] ?? null;
  }

  const entry = _ring.find((e) => e.incident_id === incidentId);
  if (!entry) return null;
  entry.timeline = [...(entry.timeline || []), event];
  entry.updated_at = event.ts;
  return entry;
}

export async function getIncident(incidentId) {
  if (!incidentId) return null;

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `SELECT * FROM incidents WHERE incident_id = $1 LIMIT 1`,
      [incidentId]
    );
    return res?.rows?.[0] ?? null;
  }

  return _ring.find((e) => e.incident_id === incidentId) ?? null;
}

export async function listIncidents(filters = {}) {
  const { status, severity, assignee, fromDate, toDate, cluster, limit = 50, offset = 0 } = filters;

  if (await dbEnabled()) {
    await ensureSchema();
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (severity) { conditions.push(`severity = $${idx++}`); params.push(severity); }
    if (assignee) { conditions.push(`assignee = $${idx++}`); params.push(assignee); }
    if (fromDate) { conditions.push(`created_at >= $${idx++}`); params.push(fromDate); }
    if (toDate) { conditions.push(`created_at <= $${idx++}`); params.push(toDate); }
    if (cluster && cluster !== "all") { conditions.push(`cluster = $${idx++}`); params.push(cluster); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRes = await dbQuery(`SELECT COUNT(*) AS total FROM incidents ${where}`, params);
    const total = parseInt(countRes?.rows?.[0]?.total ?? "0", 10);

    const dataParams = [...params, limit, offset];
    const dataRes = await dbQuery(
      `SELECT * FROM incidents ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      dataParams
    );

    return { incidents: dataRes?.rows ?? [], total };
  }

  let filtered = _ring;
  if (status) filtered = filtered.filter((e) => e.status === status);
  if (severity) filtered = filtered.filter((e) => e.severity === severity);
  if (assignee) filtered = filtered.filter((e) => e.assignee === assignee);
  if (fromDate) filtered = filtered.filter((e) => new Date(e.created_at) >= new Date(fromDate));
  if (toDate) filtered = filtered.filter((e) => new Date(e.created_at) <= new Date(toDate));
  if (cluster && cluster !== "all") filtered = filtered.filter((e) => (e.cluster || "local") === cluster);

  const total = filtered.length;
  const incidents = filtered.slice().reverse().slice(offset, offset + limit);
  return { incidents, total };
}

export async function getIncidentStats({ days = 30, cluster } = {}) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  if (await dbEnabled()) {
    await ensureSchema();
    const cutoffIso = cutoff.toISOString();
    const weekIso = weekAgo.toISOString();
    const cFilter = cluster && cluster !== "all";
    const cWhere = cFilter ? " AND cluster = $2" : "";
    const cParams = cFilter ? [cutoffIso, cluster] : [cutoffIso];
    const cOpenParams = cFilter ? [cluster] : [];
    const cOpenWhere = cFilter ? " AND cluster = $1" : "";
    const weekParams = cFilter ? [weekIso, cluster] : [weekIso];

    const [totalRes, openRes, bySev, byStat, mttrRes, weekRes] = await Promise.all([
      dbQuery(`SELECT COUNT(*)::int AS count FROM incidents WHERE created_at >= $1${cWhere}`, cParams),
      dbQuery(
        `SELECT COUNT(*)::int AS count FROM incidents WHERE status NOT IN ('resolved','closed')${cOpenWhere}`,
        cOpenParams
      ),
      dbQuery(
        `SELECT severity, COUNT(*)::int AS count FROM incidents WHERE created_at >= $1${cWhere} GROUP BY severity ORDER BY count DESC`,
        cParams
      ),
      dbQuery(
        `SELECT status, COUNT(*)::int AS count FROM incidents WHERE created_at >= $1${cWhere} GROUP BY status ORDER BY count DESC`,
        cParams
      ),
      dbQuery(
        `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60.0) AS mttr
         FROM incidents WHERE resolved_at IS NOT NULL AND created_at >= $1${cWhere}`,
        cParams
      ),
      dbQuery(`SELECT COUNT(*)::int AS count FROM incidents WHERE created_at >= $1${cWhere}`, weekParams),
    ]);

    const mttrRaw = mttrRes?.rows?.[0]?.mttr;
    return {
      total: totalRes?.rows?.[0]?.count ?? 0,
      open: openRes?.rows?.[0]?.count ?? 0,
      bySeverity: bySev?.rows ?? [],
      byStatus: byStat?.rows ?? [],
      avgMTTR: mttrRaw != null ? Math.round(parseFloat(mttrRaw) * 100) / 100 : null,
      incidentsThisWeek: weekRes?.rows?.[0]?.count ?? 0,
    };
  }

  let base = _ring;
  if (cluster && cluster !== "all") base = base.filter((e) => (e.cluster || "local") === cluster);
  const recent = base.filter((e) => new Date(e.created_at) >= cutoff);
  const open = base.filter((e) => e.status !== "resolved" && e.status !== "closed");
  const week = base.filter((e) => new Date(e.created_at) >= weekAgo);

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

  const resolved = recent.filter((e) => e.resolved_at);
  let avgMTTR = null;
  if (resolved.length > 0) {
    const totalMins = resolved.reduce(
      (sum, e) => sum + (new Date(e.resolved_at) - new Date(e.created_at)) / 60000,
      0
    );
    avgMTTR = Math.round((totalMins / resolved.length) * 100) / 100;
  }

  return {
    total: recent.length,
    open: open.length,
    bySeverity: countBy(recent, "severity"),
    byStatus: countBy(recent, "status"),
    avgMTTR,
    incidentsThisWeek: week.length,
  };
}

export async function resolveIncident(incidentId, { actor, resolutionNote, rootCause } = {}) {
  if (!incidentId) throw new Error("incidentId required");

  const current = await getIncident(incidentId);
  if (!current) throw new Error(`incident not found: ${incidentId}`);
  validateTransition(current.status, "resolved");

  const now = new Date().toISOString();
  const event = {
    ts: now,
    actor: actor || "system",
    action: "resolved",
    note: resolutionNote || "Incident resolved",
  };

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `UPDATE incidents
       SET status = 'resolved',
           resolved_at = $1,
           updated_at = $1,
           resolution_note = COALESCE($2, resolution_note),
           root_cause = COALESCE($3, root_cause),
           timeline = timeline || $4::jsonb
       WHERE incident_id = $5
       RETURNING *`,
      [now, resolutionNote ?? null, rootCause ?? null, JSON.stringify([event]), incidentId]
    );
    return res?.rows?.[0] ?? null;
  }

  const entry = _ring.find((e) => e.incident_id === incidentId);
  if (!entry) return null;
  entry.status = "resolved";
  entry.resolved_at = now;
  entry.updated_at = now;
  if (resolutionNote != null) entry.resolution_note = resolutionNote;
  if (rootCause != null) entry.root_cause = rootCause;
  entry.timeline = [...(entry.timeline || []), event];
  return entry;
}

export async function closeIncident(incidentId, { actor, postmortem } = {}) {
  if (!incidentId) throw new Error("incidentId required");

  const current = await getIncident(incidentId);
  if (!current) throw new Error(`incident not found: ${incidentId}`);
  validateTransition(current.status, "closed");

  const now = new Date().toISOString();
  const event = {
    ts: now,
    actor: actor || "system",
    action: "closed",
    note: postmortem ? "Incident closed with post-mortem" : "Incident closed",
  };

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `UPDATE incidents
       SET status = 'closed',
           updated_at = $1,
           postmortem = COALESCE($2, postmortem),
           timeline = timeline || $3::jsonb
       WHERE incident_id = $4
       RETURNING *`,
      [now, postmortem ?? null, JSON.stringify([event]), incidentId]
    );
    return res?.rows?.[0] ?? null;
  }

  const entry = _ring.find((e) => e.incident_id === incidentId);
  if (!entry) return null;
  entry.status = "closed";
  entry.updated_at = now;
  if (postmortem != null) entry.postmortem = postmortem;
  entry.timeline = [...(entry.timeline || []), event];
  return entry;
}

export async function purgeOldIncidents(retentionDays = DEFAULT_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  if (await dbEnabled()) {
    await ensureSchema();
    const res = await dbQuery(
      `DELETE FROM incidents WHERE status = 'closed' AND updated_at < $1`,
      [cutoff.toISOString()]
    );
    const deleted = res?.rowCount ?? 0;
    if (deleted > 0) {
      console.log(`[incident-manager] purged ${deleted} closed incidents older than ${retentionDays} days`);
    }
    return deleted;
  }

  const before = _ring.length;
  for (let i = _ring.length - 1; i >= 0; i--) {
    const inc = _ring[i];
    if (inc.status === "closed" && new Date(inc.updated_at) < cutoff) {
      _ring.splice(i, 1);
    }
  }
  const deleted = before - _ring.length;
  if (deleted > 0) {
    console.log(`[incident-manager] purged ${deleted} in-memory closed incidents older than ${retentionDays} days`);
  }
  return deleted;
}
