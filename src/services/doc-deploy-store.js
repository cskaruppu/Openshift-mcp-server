/**
 * Persistent record of Automation Hub deployments.
 *
 * A deployment that exists only in a process Map evaporates on pod restart —
 * and with it the rollback ledger and the audit trail. This mirrors the
 * vm-request-store pattern: Postgres when available, in-memory otherwise,
 * write-through on every state change.
 */

import { query, isEnabled as dbEnabled } from "../utils/db.js";

const _mem = new Map();
let _tableReady = null;

async function initTable() {
  if (_tableReady !== null) return _tableReady;
  try {
    if (!(await dbEnabled())) return (_tableReady = false);
    await query(`
      CREATE TABLE IF NOT EXISTS doc_deployments (
        id TEXT PRIMARY KEY,
        cluster TEXT NOT NULL DEFAULT 'local',
        namespace TEXT,
        app_name TEXT,
        status TEXT NOT NULL,
        change_request_number TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        data JSONB
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS doc_deployments_ns_idx ON doc_deployments (namespace)`).catch(() => {});
    _tableReady = true;
  } catch (e) {
    console.error("[doc-deploy] table init failed, using memory only:", e.message);
    _tableReady = false;
  }
  return _tableReady;
}

async function persist(rec) {
  _mem.set(rec.id, rec);
  if (_mem.size > 200) _mem.delete(_mem.keys().next().value);
  if (!(await initTable())) return;
  try {
    await query(
      `INSERT INTO doc_deployments (id, cluster, namespace, app_name, status, change_request_number, created_at, updated_at, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         change_request_number = EXCLUDED.change_request_number,
         updated_at = NOW(),
         data = EXCLUDED.data`,
      [rec.id, rec.cluster || "local", rec.namespace || null, rec.appName || null,
       rec.status, rec.changeRequestNumber || null, rec.createdAt || new Date().toISOString(),
       JSON.stringify(rec)]
    );
  } catch (e) {
    console.error("[doc-deploy] persist failed:", e.message);
  }
}

function rowToRec(row) {
  const data = typeof row.data === "string" ? JSON.parse(row.data) : (row.data || {});
  return { ...data, id: row.id, status: row.status, changeRequestNumber: row.change_request_number || data.changeRequestNumber || null };
}

export async function recordDeployment(rec) {
  rec.createdAt = rec.createdAt || new Date().toISOString();
  await persist(rec);
  return rec;
}

export async function updateDeployment(id, patch) {
  const rec = (await getDeploymentRecord(id)) || { id };
  Object.assign(rec, patch);
  await persist(rec);
  return rec;
}

export async function getDeploymentRecord(id) {
  if (_mem.has(id)) return _mem.get(id);
  if (!(await initTable())) return null;
  try {
    const r = await query(`SELECT * FROM doc_deployments WHERE id = $1`, [id]);
    if (r?.rows?.length) {
      const rec = rowToRec(r.rows[0]);
      _mem.set(id, rec);
      return rec;
    }
  } catch {}
  return null;
}

export async function listDeploymentRecords({ cluster, limit = 30 } = {}) {
  if (await initTable()) {
    try {
      const r = cluster
        ? await query(`SELECT * FROM doc_deployments WHERE cluster = $1 ORDER BY updated_at DESC LIMIT $2`, [cluster, limit])
        : await query(`SELECT * FROM doc_deployments ORDER BY updated_at DESC LIMIT $1`, [limit]);
      if (r?.rows) return r.rows.map(rowToRec);
    } catch {}
  }
  return [..._mem.values()]
    .filter((d) => !cluster || (d.cluster || "local") === cluster)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, limit);
}
