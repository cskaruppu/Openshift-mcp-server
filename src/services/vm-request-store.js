/**
 * VM request store + ServiceNow approval reconciler — UC-06 phase 4.
 *
 * Moves the approval gate OUT of the console and into ServiceNow, which is what
 * a change-controlled environment actually requires: the CAB is the authority,
 * and a platform-side approve button does not satisfy audit.
 *
 * That inversion needs durable state, because a submitted request now outlives
 * the browser session and the pod:
 *
 *   draft ──submit──▶ submitted ──CAB approves──▶ approved ──▶ provisioning
 *                          │                                        │
 *                          ├── CAB rejects ──▶ rejected             ├──▶ provisioned
 *                          └── CR cancelled ─▶ cancelled            └──▶ failed
 *
 * The reconciler polls ServiceNow for approval state and provisions on
 * transition. This is still human-approved — the human just approves in
 * ServiceNow rather than here. There is no path where a VM appears without a
 * person having said yes somewhere.
 */

import { randomUUID } from "node:crypto";
import { query, isEnabled as dbEnabled } from "../utils/db.js";
import { normalizeVMRequest, provisionVMRequest, preflightVMRequest, raiseProvisioningCR } from "./vm-provisioning.js";

export const STATES = Object.freeze({
  DRAFT: "draft",
  // The request has been validated against the live API server and nothing was
  // created. From here the details are frozen: a change board must approve the
  // same thing that was validated, not a later edit of it.
  DRY_RUN_PASSED: "dry_run_passed",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  PROVISIONING: "provisioning",
  PROVISIONED: "provisioned",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  FAILED: "failed",
});
const TERMINAL = new Set([STATES.PROVISIONED, STATES.REJECTED, STATES.CANCELLED, STATES.FAILED]);

const nowIso = () => new Date().toISOString();

/**
 * Stable fingerprint of the fields that change what gets built. If any of them
 * differ from what passed dry-run, the validation no longer describes this
 * request and the gate must be re-earned.
 */
export function fingerprintRequest(req = {}) {
  const r = normalizeVMRequest(req);
  return JSON.stringify([
    r.name, r.namespace, r.createNamespace, r.count, r.sourceDataSource, r.sourceDataSourceNamespace,
    r.instanceType, r.preference, r.cpuCores, r.memoryMi, r.diskSizeGi, r.storageClass,
    r.networkAttachmentDefinition, r.sshKey, r.username, r.owner, r.costCentre,
    r.environment, r.expiresOn, r.runStrategy,
  ]);
}

// In-memory mirror so the flow works without Postgres — with the documented
// caveat that pending requests are then lost on pod restart.
const _mem = new Map();
let _tableReady = null;

async function initTable() {
  if (_tableReady !== null) return _tableReady;
  try {
    if (!(await dbEnabled())) return (_tableReady = false);
    await query(`
      CREATE TABLE IF NOT EXISTS vm_requests (
        id TEXT PRIMARY KEY,
        cluster TEXT NOT NULL DEFAULT 'local',
        state TEXT NOT NULL,
        namespace TEXT,
        vm_name TEXT,
        requested_by TEXT,
        change_request_number TEXT,
        change_request_sys_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        data JSONB
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS vm_requests_state_idx ON vm_requests (state)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS vm_requests_cr_idx ON vm_requests (change_request_number)`).catch(() => {});
    _tableReady = true;
  } catch (e) {
    console.error("[vm-requests] table init failed, using memory only:", e.message);
    _tableReady = false;
  }
  return _tableReady;
}

async function persist(rec) {
  _mem.set(rec.id, rec);
  if (!(await initTable())) return;
  try {
    await query(
      `INSERT INTO vm_requests (id, cluster, state, namespace, vm_name, requested_by,
         change_request_number, change_request_sys_id, created_at, updated_at, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET state=$3, change_request_number=$7,
         change_request_sys_id=$8, updated_at=$10, data=$11`,
      [rec.id, rec.cluster, rec.state, rec.request?.namespace || null, rec.request?.name || null,
       rec.requestedBy || null, rec.changeRequest?.number || null, rec.changeRequest?.sys_id || null,
       rec.createdAt, rec.updatedAt, JSON.stringify(rec)]
    );
  } catch (e) { console.error("[vm-requests] persist failed:", e.message); }
}

async function hydrate() {
  if (_mem.size || !(await initTable())) return;
  try {
    const r = await query(
      `SELECT data FROM vm_requests WHERE state NOT IN ('provisioned','rejected','cancelled','failed')
       ORDER BY created_at DESC LIMIT 500`);
    for (const row of r.rows || []) {
      const rec = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      if (rec?.id) _mem.set(rec.id, rec);
    }
  } catch { /* memory-only */ }
}

function transition(rec, state, patch = {}) {
  rec.history = rec.history || [];
  rec.history.push({ at: nowIso(), from: rec.state, to: state, ...(patch.note ? { note: patch.note } : {}) });
  Object.assign(rec, patch, { state, updatedAt: nowIso() });
  delete rec.note;
  return rec;
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------
/**
 * Raise the change request and park the VM request until the CAB decides.
 * Pre-flight runs BEFORE submission — there is no point asking a change board
 * to approve something that cannot succeed.
 */
/**
 * Record a dry-run that passed. This is what opens the approval gate, so the
 * fingerprint of exactly what was validated is stored alongside it.
 * Re-running against the same VM reuses the record rather than accumulating
 * one per click.
 */
export async function recordDryRunPassed(rawRequest, dryRun, { actor = "operator", cluster = "local" } = {}) {
  await hydrate();
  const request = normalizeVMRequest(rawRequest);
  const existing = await findActiveRequest({ cluster, namespace: request.namespace, name: request.name });

  // Only a record that has not yet been submitted may be re-stamped. Once a
  // change board holds it, a fresh dry-run must not silently move the goalposts.
  const rec = (existing && [STATES.DRAFT, STATES.DRY_RUN_PASSED].includes(existing.state))
    ? existing
    : { id: randomUUID(), cluster, state: STATES.DRAFT, requestedBy: actor, createdAt: nowIso(), history: [] };

  rec.request = request;
  rec.fingerprint = fingerprintRequest(request);
  rec.dryRun = { ok: true, at: nowIso(), terminal: dryRun?.terminal || null };
  transition(rec, STATES.DRY_RUN_PASSED, { note: "Dry-run passed against the live API server — nothing was created." });
  await persist(rec);
  return { ok: true, requestId: rec.id, state: rec.state, fingerprint: rec.fingerprint };
}

/** The most recent request for this VM that has not reached a terminal state. */
export async function findActiveRequest({ cluster = "local", namespace, name } = {}) {
  await hydrate();
  if (!namespace || !name) return null;
  return [..._mem.values()]
    .filter((r) => (r.cluster || "local") === cluster
      && r.request?.namespace === namespace && r.request?.name === name
      && !TERMINAL.has(r.state))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0] || null;
}

/**
 * Reopen a locked request for editing. Deliberately allowed only before a
 * change board holds it — after submission the way back is to cancel the
 * change request, not to quietly edit underneath it.
 */
export async function unlockRequest(id, { actor = "operator" } = {}) {
  await hydrate();
  const rec = _mem.get(id);
  if (!rec) return { ok: false, error: "Request not found." };
  if (rec.state !== STATES.DRY_RUN_PASSED) {
    return { ok: false, error: `A request in "${rec.state}" cannot be edited. Cancel the change request first.` };
  }
  transition(rec, STATES.DRAFT, { note: `Reopened for editing by ${actor} — the dry-run no longer applies.` });
  rec.dryRun = null; rec.fingerprint = null;
  await persist(rec);
  return { ok: true, requestId: rec.id, state: rec.state };
}

export async function submitForApproval(rawRequest, { requestedBy = "operator", cluster = "local", requestId = null } = {}) {
  await hydrate();
  const request = normalizeVMRequest(rawRequest);

  // The gate: only a request whose dry-run passed, for exactly these details,
  // may be put in front of a change board.
  const prior = requestId ? _mem.get(requestId) : await findActiveRequest({ cluster, namespace: request.namespace, name: request.name });
  if (!prior || prior.state !== STATES.DRY_RUN_PASSED) {
    return { ok: false, error: "Dry-run must pass before a change request can be raised.", state: prior?.state || null };
  }
  if (prior.fingerprint && prior.fingerprint !== fingerprintRequest(request)) {
    return { ok: false, error: "The request changed after the dry-run. Run the dry-run again before submitting.", state: prior.state };
  }

  const preflight = await preflightVMRequest(request);
  if (!preflight.ok) {
    return { ok: false, error: "Pre-flight failed — not submitted.", blocking: preflight.blocking };
  }

  const rec = prior;
  rec.request = request;
  rec.preflight = preflight;
  rec.requestedBy = requestedBy;

  let cr;
  try {
    cr = await raiseProvisioningCR(request, preflight);
  } catch (e) {
    transition(rec, STATES.FAILED, { error: `Could not raise the change request: ${e.message}` });
    await persist(rec);
    return { ok: false, error: rec.error, requestId: rec.id };
  }

  transition(rec, STATES.SUBMITTED, {
    changeRequest: { number: cr?.number || cr?.result?.number || null, sys_id: cr?.sys_id || cr?.result?.sys_id || null, raw: cr },
    note: `Submitted as ${cr?.number || "a change request"} — awaiting approval in ServiceNow.`,
  });
  // Stamp the CR onto the request so the provisioned VM carries it as provenance.
  if (rec.changeRequest.number) rec.request.requestId = rec.changeRequest.number;
  await persist(rec);
  return { ok: true, requestId: rec.id, state: rec.state, changeRequest: rec.changeRequest, warnings: preflight.warnings };
}

export async function getRequest(id) { await hydrate(); return _mem.get(id) || null; }

export async function listRequests({ state = null, limit = 100 } = {}) {
  await hydrate();
  let all = [..._mem.values()];
  if (state) all = all.filter((r) => r.state === state);
  return all.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, limit);
}

export async function cancelRequest(id, { actor = "operator", reason = "Cancelled by requester" } = {}) {
  const rec = await getRequest(id);
  if (!rec) return { ok: false, error: "Request not found" };
  if (TERMINAL.has(rec.state)) return { ok: false, error: `Request is already ${rec.state}` };
  transition(rec, STATES.CANCELLED, { cancelledBy: actor, note: reason });
  await persist(rec);
  return { ok: true, state: rec.state };
}

// ---------------------------------------------------------------------------
// Reconcile against ServiceNow
// ---------------------------------------------------------------------------
/** ServiceNow change_request: approval field, and state 3=Closed 4=Cancelled. */
function readApproval(cr) {
  const approval = String(cr?.approval || "").toLowerCase();
  const state = String(cr?.state || "");
  if (approval === "approved") return "approved";
  if (approval === "rejected" || approval === "not_requested" && state === "4") return "rejected";
  if (state === "4" || /cancel/i.test(String(cr?.state_label || ""))) return "cancelled";
  return "pending";
}

/**
 * Poll every submitted request, and provision the ones the CAB approved.
 * Safe to call on a timer: state transitions are guarded, and a request that is
 * already provisioning is skipped rather than double-applied.
 */
export async function reconcileApprovals({ cluster = "local" } = {}) {
  await hydrate();
  const pending = [..._mem.values()].filter((r) => r.state === STATES.SUBMITTED);
  const out = { checked: pending.length, approved: 0, rejected: 0, provisioned: 0, failed: 0, results: [] };
  if (!pending.length) return out;

  let getRecord;
  try { ({ getRecord } = await import("../utils/servicenow-client.js")); }
  catch (e) { return { ...out, error: `ServiceNow client unavailable: ${e.message}` }; }

  for (const rec of pending) {
    const sysId = rec.changeRequest?.sys_id, number = rec.changeRequest?.number;
    if (!sysId && !number) continue;
    let cr;
    try { cr = await getRecord("change_request", sysId || number); }
    catch (e) { out.results.push({ id: rec.id, error: e.message }); continue; }
    const verdict = readApproval(cr?.result || cr);

    if (verdict === "rejected") {
      transition(rec, STATES.REJECTED, { note: `${number} was rejected in ServiceNow. Nothing was created.` });
      await persist(rec); out.rejected++;
      out.results.push({ id: rec.id, number, verdict });
      continue;
    }
    if (verdict === "cancelled") {
      transition(rec, STATES.CANCELLED, { note: `${number} was cancelled in ServiceNow.` });
      await persist(rec); out.cancelled = (out.cancelled || 0) + 1;
      out.results.push({ id: rec.id, number, verdict });
      continue;
    }
    if (verdict !== "approved") { out.results.push({ id: rec.id, number, verdict: "pending" }); continue; }

    out.approved++;
    transition(rec, STATES.APPROVED, { approvedAt: nowIso(), note: `${number} approved in ServiceNow.` });
    await persist(rec);

    // Re-check before acting. An approval can sit for days, and the cluster
    // moves on — the name may now be taken, or the quota consumed.
    const recheck = await preflightVMRequest(rec.request);
    if (!recheck.ok) {
      transition(rec, STATES.FAILED, {
        preflight: recheck,
        error: "Approved, but pre-flight no longer passes — the cluster changed since submission.",
        note: recheck.blocking.map((b) => b.message).join("; "),
      });
      await persist(rec); out.failed++;
      out.results.push({ id: rec.id, number, verdict, provisioned: false, reason: rec.error });
      continue;
    }

    transition(rec, STATES.PROVISIONING);
    await persist(rec);
    try {
      const result = await provisionVMRequest(rec.request, { actor: `servicenow:${number}`, cluster: rec.cluster || cluster });
      if (result.ok) {
        transition(rec, STATES.PROVISIONED, { result, provisionedAt: nowIso(), note: `Provisioned after ${number} was approved.` });
        out.provisioned++;
      } else {
        transition(rec, STATES.FAILED, { result, error: result.error || "Provisioning failed" });
        out.failed++;
      }
    } catch (e) {
      transition(rec, STATES.FAILED, { error: e.message });
      out.failed++;
    }
    await persist(rec);
    out.results.push({ id: rec.id, number, verdict, provisioned: rec.state === STATES.PROVISIONED });
  }
  return out;
}

/** Human-readable status for the console card, including what to do next. */
export function describeState(rec) {
  switch (rec?.state) {
    case STATES.DRAFT: return "Draft — not yet submitted.";
    case STATES.SUBMITTED: return `Awaiting approval of ${rec.changeRequest?.number || "the change request"} in ServiceNow. Nothing has been created.`;
    case STATES.APPROVED: return `${rec.changeRequest?.number} approved — provisioning is about to start.`;
    case STATES.PROVISIONING: return "Provisioning now.";
    case STATES.PROVISIONED: return `Provisioned. ${rec.result?.created?.length || 0} VM(s) created.`;
    case STATES.REJECTED: return `${rec.changeRequest?.number} was rejected. Nothing was created.`;
    case STATES.CANCELLED: return "Cancelled.";
    case STATES.FAILED: return `Failed: ${rec.error || "unknown"}`;
    default: return "Unknown.";
  }
}
