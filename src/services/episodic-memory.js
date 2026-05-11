/**
 * Episodic Memory — long-term incident & resolution history.
 *
 * Captures incidents detected by the cluster (CrashLoopBackOff, OOMKilled,
 * NodeNotReady, OperatorDegraded, AlertFiring) along with how they were
 * resolved. Used by the agent for "have we seen this before?" recall.
 *
 * Storage: PostgreSQL `incidents` table. Falls back to in-memory ring buffer
 * when DB is disabled (capped at 500 incidents).
 */

import { query, isEnabled } from "../utils/db.js";

const MEMORY_LIMIT = 500;
const _ring = []; // in-memory fallback

// ---------------------------------------------------------------------------
// Schema bootstrap — idempotent
// ---------------------------------------------------------------------------
let _schemaReady = false;
async function ensureSchema() {
  if (_schemaReady) return;
  if (!(await isEnabled())) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS incidents (
        id SERIAL PRIMARY KEY,
        conversation_id TEXT,
        severity TEXT,
        resource_kind TEXT,
        resource_name TEXT,
        namespace TEXT,
        cluster TEXT,
        symptom TEXT,
        signature TEXT,
        diagnosis TEXT,
        resolution TEXT,
        resolution_command TEXT,
        resolved_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_signature ON incidents(signature);
      CREATE INDEX IF NOT EXISTS idx_incidents_kind_name ON incidents(resource_kind, resource_name);
      CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents(created_at DESC);
    `);
    _schemaReady = true;
  } catch (err) {
    console.error("[episodic-memory] schema bootstrap failed:", err.message);
  }
}

/**
 * Record a new incident. Returns the new row id (or null when DB disabled).
 *
 * @param {object} inc - { severity, resourceKind, resourceName, namespace,
 *                         cluster, symptom, diagnosis, signature?, metadata? }
 */
export async function recordIncident(inc) {
  const row = {
    conversation_id: inc.conversationId || null,
    severity: inc.severity || "medium",
    resource_kind: inc.resourceKind || null,
    resource_name: inc.resourceName || null,
    namespace: inc.namespace || null,
    cluster: inc.cluster || null,
    symptom: inc.symptom || null,
    signature: inc.signature || computeSignature(inc),
    diagnosis: inc.diagnosis || null,
    resolution: null,
    resolution_command: null,
    resolved_at: null,
    metadata: inc.metadata || {},
    created_at: new Date().toISOString(),
  };

  if (!(await isEnabled())) {
    _ring.push({ id: _ring.length + 1, ...row });
    if (_ring.length > MEMORY_LIMIT) _ring.shift();
    return _ring[_ring.length - 1].id;
  }

  await ensureSchema();
  try {
    const r = await query(
      `INSERT INTO incidents (conversation_id, severity, resource_kind, resource_name, namespace, cluster, symptom, signature, diagnosis, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [row.conversation_id, row.severity, row.resource_kind, row.resource_name, row.namespace, row.cluster, row.symptom, row.signature, row.diagnosis, JSON.stringify(row.metadata)]
    );
    return r?.rows?.[0]?.id || null;
  } catch (err) {
    console.error("[episodic-memory] recordIncident failed:", err.message);
    return null;
  }
}

/** Mark an incident resolved with the resolution that worked. */
export async function resolveIncident(id, { resolution, resolutionCommand } = {}) {
  if (!(await isEnabled())) {
    const row = _ring.find((r) => r.id === id);
    if (row) { row.resolution = resolution; row.resolution_command = resolutionCommand; row.resolved_at = new Date().toISOString(); }
    return;
  }
  await ensureSchema();
  try {
    await query(
      `UPDATE incidents SET resolution = $2, resolution_command = $3, resolved_at = NOW() WHERE id = $1`,
      [id, resolution || null, resolutionCommand || null]
    );
  } catch (err) {
    console.error("[episodic-memory] resolveIncident failed:", err.message);
  }
}

/** List recent incidents — optionally filter by resource/severity. */
export async function listIncidents({ limit = 20, severity, kind, namespace } = {}) {
  if (!(await isEnabled())) {
    let out = _ring.slice(-limit).reverse();
    if (severity) out = out.filter((r) => r.severity === severity);
    if (kind) out = out.filter((r) => r.resource_kind === kind);
    if (namespace) out = out.filter((r) => r.namespace === namespace);
    return out;
  }
  await ensureSchema();
  try {
    const cond = [];
    const args = [];
    if (severity) { args.push(severity); cond.push(`severity = $${args.length}`); }
    if (kind)     { args.push(kind);     cond.push(`resource_kind = $${args.length}`); }
    if (namespace){ args.push(namespace); cond.push(`namespace = $${args.length}`); }
    args.push(limit);
    const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
    const r = await query(
      `SELECT id, conversation_id, severity, resource_kind, resource_name, namespace, cluster, symptom, signature, diagnosis, resolution, resolution_command, resolved_at, metadata, created_at
       FROM incidents ${where} ORDER BY id DESC LIMIT $${args.length}`,
      args
    );
    return r?.rows || [];
  } catch (err) {
    console.error("[episodic-memory] listIncidents failed:", err.message);
    return [];
  }
}

/**
 * "Have we seen this before?" — find similar past incidents by signature.
 * Returns the resolutions that worked, ranked by recency.
 */
export async function findSimilarIncidents(inc, { limit = 5 } = {}) {
  const signature = inc.signature || computeSignature(inc);
  if (!(await isEnabled())) {
    return _ring.filter((r) => r.signature === signature && r.resolution).slice(-limit).reverse();
  }
  await ensureSchema();
  try {
    const r = await query(
      `SELECT * FROM incidents WHERE signature = $1 AND resolution IS NOT NULL ORDER BY id DESC LIMIT $2`,
      [signature, limit]
    );
    return r?.rows || [];
  } catch (err) {
    return [];
  }
}

/** Compute a stable signature for an incident — used for similarity match. */
function computeSignature(inc) {
  const kind = (inc.resourceKind || "").toLowerCase();
  const symptom = (inc.symptom || "").toLowerCase()
    // normalize varying details (timestamps, numbers, ip addresses)
    .replace(/\b\d{4}-\d{2}-\d{2}t?\d*[:.]?\d*[:.]?\d*z?\b/g, "<ts>")
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return `${kind}::${symptom}`;
}

export { computeSignature };
