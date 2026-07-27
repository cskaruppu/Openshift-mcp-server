/**
 * Change Ledger — every cluster mutation this platform performed, with an undo.
 *
 * The design decision that makes revert possible: the inverse operation is
 * computed and stored AT APPLY TIME, not at revert time. Once memory has been
 * patched from 389Mi to 778Mi the old value is gone from the live object, so it
 * can only be restored if it was captured beforehand.
 *
 * Revert strategy is deliberately an INVERSE PATCH rather than `oc rollout undo`
 * by default. `rollout undo` restores the entire prior pod template, which would
 * also discard any unrelated change someone made since — an inverse patch undoes
 * exactly what we did and nothing else. Native rollout undo remains available
 * (the executor supports it) for cases where no before-value was captured.
 *
 * A revert is itself recorded as a change (`revertOf`), so the ledger stays a
 * complete chain and a revert can itself be reverted.
 */

import { query, isEnabled as dbEnabled } from "../utils/db.js";

const RETENTION_DAYS = parseInt(process.env.CHANGE_LEDGER_RETENTION_DAYS || "90", 10);

// In-memory mirror so the ledger works without Postgres (with a documented
// caveat: it is then lost on pod restart, like the session store).
const _mem = [];
let _tableReady = null;

async function initTable() {
  if (_tableReady !== null) return _tableReady;
  try {
    if (!(await dbEnabled())) return (_tableReady = false);
    await query(`
      CREATE TABLE IF NOT EXISTS change_ledger (
        id TEXT PRIMARY KEY,
        cluster TEXT NOT NULL DEFAULT 'local',
        applied_at TIMESTAMPTZ DEFAULT NOW(),
        namespace TEXT,
        resource_kind TEXT,
        resource_name TEXT,
        action TEXT,
        revertable BOOLEAN DEFAULT FALSE,
        reverted_at TIMESTAMPTZ,
        revert_of TEXT,
        session_id TEXT,
        incident_number TEXT,
        data JSONB
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS change_ledger_applied_idx ON change_ledger (applied_at DESC)`).catch(() => {});
    _tableReady = true;
  } catch {
    _tableReady = false;
  }
  return _tableReady;
}

function genId() {
  return `chg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Derive the inverse command for a remediation, plus whether it is revertable.
 * Called at plan/apply time while the prior value is still known.
 * @returns {{revertable:boolean, revertReason:string|null, revertCommand:string|null,
 *            beforeValue:object|null, afterValue:object|null, nativeUndo:string|null}}
 */
export function computeRevert(remediation, ctx = {}) {
  const { namespace, target, workloadKind = "deployment", specBefore } = ctx;
  // Native undo is possible for any Deployment we can name — offer it even when
  // an exact inverse is unavailable, rather than telling the operator to use it
  // and then recording nothing.
  const nativeUndoCmd = (namespace && target && workloadKind === "deployment")
    ? `oc rollout undo ${workloadKind}/${target} -n ${namespace}`
    : null;
  const none = (reason) => ({
    revertable: false, revertReason: reason, revertCommand: null,
    beforeValue: null, afterValue: null, nativeUndo: nativeUndoCmd,
  });
  if (!remediation?.action) return none("No action recorded.");

  switch (remediation.action) {
    case "rollout_restart":
      // Nothing to undo: the spec was never modified, only pods recreated.
      return {
        revertable: false,
        revertReason: "A rolling restart changes no configuration — there is nothing to revert. The pods were simply recreated.",
        revertCommand: null, beforeValue: null, afterValue: null,
        // Deliberately no native undo either: rolling back the pod template would
        // undo whatever legitimate change preceded the restart, not the restart.
        nativeUndo: null,
      };

    case "increase_memory": {
      const container = remediation.container;
      const after = remediation.afterMemory;     // e.g. "778Mi"
      // Prefer what the planner captured; fall back to the spec read immediately
      // before the mutation. Two independent sources means an older or replanned
      // session still gets a precise inverse.
      const before = remediation.beforeMemory
        || (container ? specBefore?.containers?.[container]?.limits?.memory : null);
      if (!before || !container || !namespace || !target) {
        return none(
          "The previous memory limit could not be determined, so an exact inverse cannot be built. " +
          "A native rollout undo is offered instead — it restores the entire previous pod template."
        );
      }
      return {
        revertable: true,
        revertReason: null,
        revertCommand: `oc set resources ${workloadKind}/${target} -n ${namespace} --containers=${container} --limits=memory=${before}`,
        beforeValue: { [`containers.${container}.limits.memory`]: before },
        afterValue: { [`containers.${container}.limits.memory`]: after },
        nativeUndo: nativeUndoCmd,
      };
    }

    case "expand_pvc":
      return {
        revertable: false,
        revertReason: "Kubernetes cannot shrink a PersistentVolumeClaim. Expansion is one-way — to reduce capacity you must migrate the data to a smaller volume.",
        revertCommand: null,
        beforeValue: remediation.beforeStorage ? { "spec.resources.requests.storage": remediation.beforeStorage } : null,
        afterValue: remediation.afterStorage ? { "spec.resources.requests.storage": remediation.afterStorage } : null,
        nativeUndo: null,
      };

    default:
      return none(`No inverse is defined for action "${remediation.action}".`);
  }
}

/**
 * Record an applied change. Never throws — losing a ledger entry must not fail
 * a remediation that already succeeded.
 * @returns {Promise<object|null>} the stored record
 */
export async function recordChange(entry) {
  const rec = {
    id: genId(),
    cluster: entry.cluster || "local",
    appliedAt: entry.appliedAt || new Date().toISOString(),
    namespace: entry.namespace || null,
    resourceKind: entry.resourceKind || null,
    resourceName: entry.resourceName || null,
    container: entry.container || null,
    action: entry.action || null,
    command: entry.command || null,
    risk: entry.risk || null,
    beforeValue: entry.beforeValue || null,
    afterValue: entry.afterValue || null,
    revertable: !!entry.revertable,
    revertReason: entry.revertReason || null,
    revertCommand: entry.revertCommand || null,
    nativeUndo: entry.nativeUndo || null,
    gitopsManaged: entry.gitopsManaged ?? null,
    sessionId: entry.sessionId || null,
    signature: entry.signature || null,
    incidentNumber: entry.incidentNumber || null,
    approvedBy: entry.approvedBy || null,
    dryRunOutput: entry.dryRunOutput || null,
    applyOutput: entry.applyOutput || null,
    verification: entry.verification || null,
    beforeSnapshot: entry.beforeSnapshot || null,
    afterSnapshot: entry.afterSnapshot || null,
    revertOf: entry.revertOf || null,
    revertedAt: null,
    revertedBy: null,
    revertedByChangeId: null,
  };
  _mem.unshift(rec);
  if (_mem.length > 500) _mem.length = 500;
  try {
    if (await initTable()) {
      await query(
        `INSERT INTO change_ledger
           (id, cluster, applied_at, namespace, resource_kind, resource_name, action,
            revertable, revert_of, session_id, incident_number, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [rec.id, rec.cluster, rec.appliedAt, rec.namespace, rec.resourceKind, rec.resourceName,
         rec.action, rec.revertable, rec.revertOf, rec.sessionId, rec.incidentNumber, JSON.stringify(rec)]
      );
    }
  } catch { /* in-memory copy still serves the UI */ }
  return rec;
}

/** Mark a change as reverted, pointing at the revert's own ledger entry. */
export async function markReverted(id, { by, revertChangeId }) {
  const at = new Date().toISOString();
  const hit = _mem.find((c) => c.id === id);
  if (hit) { hit.revertedAt = at; hit.revertedBy = by || null; hit.revertedByChangeId = revertChangeId || null; }
  try {
    if (await initTable()) {
      await query(
        `UPDATE change_ledger
            SET reverted_at = $2,
                data = jsonb_set(jsonb_set(jsonb_set(data,'{revertedAt}',to_jsonb($2::text)),
                                 '{revertedBy}', to_jsonb($3::text)),
                                 '{revertedByChangeId}', to_jsonb($4::text))
          WHERE id = $1`,
        [id, at, by || "", revertChangeId || ""]
      );
    }
  } catch { /* memory copy already updated */ }
  return hit || null;
}

export async function getChange(id) {
  const hit = _mem.find((c) => c.id === id);
  if (hit) return hit;
  try {
    if (await initTable()) {
      const r = await query(`SELECT data FROM change_ledger WHERE id = $1`, [id]);
      return r?.rows?.[0]?.data || null;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * List changes, newest first. Hydrates from the DB when the in-memory mirror is
 * cold (e.g. after a pod restart).
 */
export async function listChanges({ cluster, limit = 100, sessionId } = {}) {
  let rows = _mem;
  if (_mem.length === 0) {
    try {
      if (await initTable()) {
        const r = await query(
          `SELECT data FROM change_ledger WHERE applied_at > NOW() - INTERVAL '${RETENTION_DAYS} days'
            ORDER BY applied_at DESC LIMIT $1`, [Math.min(500, limit * 3)]
        );
        rows = (r?.rows || []).map((x) => x.data).filter(Boolean);
        for (const x of rows.slice().reverse()) if (!_mem.find((m) => m.id === x.id)) _mem.unshift(x);
      }
    } catch { /* ignore */ }
  }
  let out = rows;
  if (cluster) out = out.filter((c) => c.cluster === cluster);
  if (sessionId) out = out.filter((c) => c.sessionId === sessionId);
  return out.slice(0, limit);
}

/** Aggregate counts for the History header. */
export async function changeStats(opts = {}) {
  const all = await listChanges({ ...opts, limit: 500 });
  return {
    total: all.length,
    revertable: all.filter((c) => c.revertable && !c.revertedAt).length,
    reverted: all.filter((c) => c.revertedAt).length,
    irreversible: all.filter((c) => !c.revertable && !c.revertOf).length,
  };
}

/** Housekeeping — drop entries past the retention window. */
export async function pruneLedger() {
  try {
    if (await initTable()) {
      await query(`DELETE FROM change_ledger WHERE applied_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`);
    }
  } catch { /* ignore */ }
}
