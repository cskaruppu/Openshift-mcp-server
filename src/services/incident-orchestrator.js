/**
 * Autonomous Incident Orchestrator — Phase 2.
 *
 * Takes a detection from incident-detector.js (Phase 1) and drives it through
 * the full ITIL incident lifecycle with exactly ONE human gate:
 *
 *   DETECTED → TRIAGED (RCA) → INC_RAISED (ServiceNow) → FIX_PROPOSED
 *            → DRY_RUN_PASSED → ⏸ AWAITING_APPROVAL ⏸
 *            → APPROVED → REMEDIATING → VERIFYING → RESOLVED → CLOSED
 *
 * Everything before the gate is autonomous. Everything after the gate is
 * autonomous. The operator's only job is to approve (or reject) the fix — which
 * is exactly the "end-to-end automation except approval to fix" requirement.
 *
 * When no safe automated remediation exists for a signal (node NotReady, a
 * degraded cluster operator, an unbound PVC), the session goes to ESCALATED with
 * the RCA and the ticket already raised — it never guesses at a fix.
 *
 * Safety model:
 *   - Promotion is HUMAN-INITIATED by default. Scheduled/unattended promotion
 *     requires INCIDENT_AUTO_ACT=true (default off) — the interlock from Phase 1.
 *   - Every remediation is classified by guardrails, dry-run against the real API
 *     server first, and only then applied.
 *   - Protected namespaces are refused.
 *   - Verification failure marks the session ROLLED_BACK/FAILED and escalates
 *     rather than reporting success.
 *   - Every transition is written to the audit log.
 */

import { ocpGet } from "../utils/openshift-client.js";
import { runRCA } from "../tools/rca-engine.js";
import { executeFixCommand } from "./fix-executor.js";
import { classifyCommand } from "./guardrails.js";
import { logAuditEvent } from "./audit-log.js";
import { createIncident, resolveIncident, updateRecord } from "../utils/servicenow-client.js";
import { isServiceNowEnabled } from "./action-workflow.js";
import { query, isEnabled as dbEnabled } from "../utils/db.js";
import { flags } from "./feature-flags.js";
import { AUTO_REMEDIABLE_RULES } from "./incident-detector.js";

export const INCIDENT_STATES = {
  DETECTED: "detected",
  TRIAGED: "triaged",
  INC_RAISED: "inc_raised",
  FIX_PROPOSED: "fix_proposed",
  DRY_RUN_PASSED: "dry_run_passed",
  AWAITING_APPROVAL: "awaiting_approval",
  APPROVED: "approved",
  REMEDIATING: "remediating",
  VERIFYING: "verifying",
  RESOLVED: "resolved",
  CLOSED: "closed",
  REJECTED: "rejected",
  ESCALATED: "escalated",
  ROLLED_BACK: "rolled_back",
  FAILED: "failed",
};
const S = INCIDENT_STATES;

// RESOLVED appears on the pre-remediation states too: a condition can clear on
// its own before anyone approves a fix (self-healing), and leaving those tickets
// open forever is exactly the manual toil this system exists to remove.
const TRANSITIONS = {
  [S.DETECTED]:          [S.TRIAGED, S.RESOLVED, S.FAILED],
  [S.TRIAGED]:           [S.INC_RAISED, S.FIX_PROPOSED, S.ESCALATED, S.RESOLVED, S.FAILED],
  [S.INC_RAISED]:        [S.FIX_PROPOSED, S.ESCALATED, S.RESOLVED, S.FAILED],
  [S.FIX_PROPOSED]:      [S.DRY_RUN_PASSED, S.ESCALATED, S.RESOLVED, S.FAILED],
  [S.DRY_RUN_PASSED]:    [S.AWAITING_APPROVAL, S.ESCALATED, S.RESOLVED, S.FAILED],
  [S.AWAITING_APPROVAL]: [S.APPROVED, S.REJECTED, S.ESCALATED, S.RESOLVED],
  [S.APPROVED]:          [S.REMEDIATING, S.FAILED],
  [S.REMEDIATING]:       [S.VERIFYING, S.ROLLED_BACK, S.FAILED],
  [S.VERIFYING]:         [S.RESOLVED, S.ROLLED_BACK, S.FAILED],
  [S.RESOLVED]:          [S.CLOSED],
  [S.REJECTED]:          [S.CLOSED],
  [S.ESCALATED]:         [S.AWAITING_APPROVAL, S.RESOLVED, S.CLOSED],
  [S.ROLLED_BACK]:       [S.ESCALATED, S.CLOSED],
  [S.FAILED]:            [S.ESCALATED, S.CLOSED],
  [S.CLOSED]:            [],
};

const TERMINAL = new Set([S.CLOSED]);
const MAX_ACTIVE_SESSIONS = parseInt(process.env.INCIDENT_MAX_ACTIVE || "25", 10);

// Storm protection: hard ceiling on tickets raised per rolling hour. Without
// this, one bad deploy or a node loss can open dozens of incidents in a minute.
// Read at call time so the Settings panel can change it without a restart.
const maxTicketsPerHour = () => parseInt(process.env.INCIDENT_MAX_TICKETS_PER_HOUR || "10", 10);
const _ticketTimes = [];
function ticketBudgetAvailable() {
  const cutoff = Date.now() - 3600_000;
  while (_ticketTimes.length && _ticketTimes[0] < cutoff) _ticketTimes.shift();
  return _ticketTimes.length < maxTicketsPerHour();
}
function recordTicket() { _ticketTimes.push(Date.now()); }
export function ticketBudgetStatus() {
  const cutoff = Date.now() - 3600_000;
  while (_ticketTimes.length && _ticketTimes[0] < cutoff) _ticketTimes.shift();
  const limit = maxTicketsPerHour();
  return { usedLastHour: _ticketTimes.length, limit, available: _ticketTimes.length < limit };
}

// ITIL priority is derived from the Impact × Urgency matrix, not from severity
// directly. ServiceNow computes `priority` itself from these two fields, so we
// set them correctly and let the instance's matrix apply.
//   1-1 → P1 Critical | 2-1 → P2 High | 2-3 → P4 Low | 3-3 → P5 Planning
const ITIL_MATRIX = {
  "SEV-1": { impact: "1", urgency: "1", label: "P1 Critical" },
  "SEV-2": { impact: "2", urgency: "1", label: "P2 High" },
  "SEV-3": { impact: "2", urgency: "3", label: "P4 Low" },
  "SEV-4": { impact: "3", urgency: "3", label: "P5 Planning" },
  "SEV-5": { impact: "3", urgency: "3", label: "P5 Planning" },
};

const PROTECTED_NS = [
  /^openshift-/, /^kube-system$/, /^kube-public$/, /^kube-node-lease$/, /^default$/,
];

// ---------------------------------------------------------------------------
// Session store — in-memory, with best-effort DB persistence so a session
// waiting for approval survives a pod restart.
// ---------------------------------------------------------------------------
const _sessions = new Map();
let _tableReady = null;

async function initTable() {
  if (_tableReady !== null) return _tableReady;
  try {
    if (!(await dbEnabled())) return (_tableReady = false);
    await query(`
      CREATE TABLE IF NOT EXISTS incident_sessions (
        id TEXT PRIMARY KEY,
        cluster TEXT NOT NULL DEFAULT 'local',
        state TEXT NOT NULL,
        signature TEXT,
        data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    _tableReady = true;
  } catch {
    _tableReady = false;
  }
  return _tableReady;
}

async function persist(session) {
  if (!(await initTable())) return;
  try {
    await query(
      `INSERT INTO incident_sessions (id, cluster, state, signature, data, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET state = $3, data = $5::jsonb, updated_at = NOW()`,
      [session.id, session.cluster, session.state, session.signature, JSON.stringify(session)]
    );
  } catch { /* durability is best-effort; the ServiceNow ticket is the system of record */ }
}

/** Rehydrate non-terminal sessions from the DB once per process. */
let _hydrated = false;
async function hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  if (!(await initTable())) return;
  try {
    const r = await query(
      `SELECT data FROM incident_sessions WHERE state <> 'closed' ORDER BY updated_at DESC LIMIT 100`
    );
    for (const row of r?.rows || []) {
      const s = row.data;
      if (s?.id && !_sessions.has(s.id)) _sessions.set(s.id, s);
    }
  } catch { /* ignore */ }
}

function genId() {
  return `inc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() { return new Date().toISOString(); }

async function transition(session, newState, patch = {}) {
  const allowed = TRANSITIONS[session.state] || [];
  if (!allowed.includes(newState)) {
    throw new Error(`Invalid transition: ${session.state} → ${newState}. Allowed: ${allowed.join(", ") || "(terminal)"}`);
  }
  const from = session.state;
  Object.assign(session, patch, { state: newState, updatedAt: nowIso() });
  session.history.push({ at: nowIso(), from, to: newState });
  await persist(session);
  try {
    // audit-log requires {type, title} with type from its allow-list.
    await logAuditEvent({
      type: "action_taken",
      severity: newState === S.FAILED || newState === S.ROLLED_BACK ? "error"
        : newState === S.ESCALATED ? "warn" : "info",
      title: `Incident ${session.id}: ${from} → ${newState}`,
      details: JSON.stringify({
        sessionId: session.id, signature: session.signature, cluster: session.cluster,
        fromState: from, toState: newState, severity: session.severity,
        incidentNumber: session.incidentNumber || null,
        command: session.remediation?.command || null,
        approvedBy: session.approvedBy || null,
      }),
      namespace: session.namespace || null,
      username: session.approvedBy || session.promotedBy || null,
      source: "incident-orchestrator",
    });
  } catch { /* audit is best-effort */ }
  return session;
}

// ---------------------------------------------------------------------------
// Remediation planning — deterministic, one safe action per signal class
// ---------------------------------------------------------------------------
const WORKLOAD_KINDS = [
  { plural: "deployments", api: "/apis/apps/v1", kind: "Deployment" },
  { plural: "statefulsets", api: "/apis/apps/v1", kind: "StatefulSet" },
  { plural: "daemonsets", api: "/apis/apps/v1", kind: "DaemonSet" },
];

async function findWorkload(ns, name) {
  for (const k of WORKLOAD_KINDS) {
    try {
      const obj = await ocpGet(`${k.api}/namespaces/${ns}/${k.plural}/${encodeURIComponent(name)}`);
      if (obj?.metadata?.name) return { ...k, obj };
    } catch { /* try next kind */ }
  }
  return null;
}

function parseMemToMi(q) {
  if (!q) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(q).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const f = { "": 1 / (1024 * 1024), Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1e3 / (1024 * 1024), M: 1e6 / (1024 * 1024), G: 1e9 / (1024 * 1024), T: 1e12 / (1024 * 1024) }[m[2] || ""];
  return Math.round(n * f);
}

/**
 * Choose a single, safe, reversible remediation for a detection.
 * Returns null when nothing safe exists → the session escalates instead.
 */
async function planRemediation(d) {
  // Single source of truth, shared with the detector's shadow-mode badge, so
  // what we promise in Phase 1 and what we plan in Phase 2 can never diverge.
  if (!AUTO_REMEDIABLE_RULES.has(d.rule)) return null;
  const ns = d.namespace;
  const owner = d.target;

  // Restart-class signals: a rolling restart is reversible and is the standard
  // first response for a crash-looping / stuck-unready workload.
  if (["crashLoop", "podNotReady", "zeroReady", "replicaMismatch"].includes(d.rule)) {
    if (!ns || !owner) return null;
    const wl = await findWorkload(ns, owner);
    if (!wl) return null;
    return {
      action: "rollout_restart",
      command: `oc rollout restart ${wl.plural.slice(0, -1)}/${owner} -n ${ns}`,
      risk: "low",
      reversible: true,
      rationale: `Rolling restart of ${wl.kind} ${owner} recreates its pods. Reversible and the standard first response for ${d.signal}.`,
      verify: { kind: wl.plural, namespace: ns, name: owner },
    };
  }

  // OOMKilled: never "just restart" — raise the memory limit (doubling, which is
  // the conventional first step) so the container stops being killed.
  if (d.rule === "oomKilled") {
    if (!ns || !owner) return null;
    const wl = await findWorkload(ns, owner);
    if (!wl) return null;
    const c = (wl.obj.spec?.template?.spec?.containers || [])[0];
    if (!c) return null;
    const curMi = parseMemToMi(c.resources?.limits?.memory);
    if (!curMi) {
      return {
        action: "manual", command: null, risk: "medium", reversible: false,
        rationale: `Container "${c.name}" has no memory limit set, so there is no safe value to double. Set an explicit limit based on observed usage before automating this.`,
        verify: null,
      };
    }
    const newMi = Math.min(curMi * 2, 65536); // cap at 64Gi
    return {
      action: "increase_memory",
      command: `oc set resources ${wl.plural.slice(0, -1)}/${owner} -n ${ns} --containers=${c.name} --limits=memory=${newMi}Mi`,
      risk: "medium",
      reversible: true,
      rationale: `Container "${c.name}" was OOMKilled at a ${curMi}Mi limit. Doubling to ${newMi}Mi stops the kill; profile the workload if it keeps growing (possible leak).`,
      verify: { kind: wl.plural, namespace: ns, name: owner },
    };
  }

  // PVC filling up: expand it (validated server-side by the executor preflight).
  if (d.rule === "pvcFilling") {
    if (!ns || !owner) return null;
    let pvc;
    try { pvc = await ocpGet(`/api/v1/namespaces/${ns}/persistentvolumeclaims/${encodeURIComponent(owner)}`); } catch { return null; }
    const cur = pvc?.status?.capacity?.storage || pvc?.spec?.resources?.requests?.storage;
    const m = /^(\d+(?:\.\d+)?)(Gi|Ti|Mi)$/.exec(String(cur || ""));
    if (!m) return null;
    const gi = m[2] === "Ti" ? parseFloat(m[1]) * 1024 : m[2] === "Mi" ? parseFloat(m[1]) / 1024 : parseFloat(m[1]);
    const target = `${Math.max(1, Math.ceil(gi * 1.5))}Gi`;
    return {
      action: "expand_pvc",
      command: `oc patch pvc ${owner} -n ${ns} --type=merge -p '{"spec":{"resources":{"requests":{"storage":"${target}"}}}}'`,
      risk: "medium",
      reversible: false, // storage cannot be shrunk back
      rationale: `Volume is nearly full at ${cur}. Expanding to ${target} (+50%) restores headroom. Expansion is one-way — Kubernetes cannot shrink a PVC.`,
      verify: { kind: "persistentvolumeclaims", namespace: ns, name: owner, expectStorage: target },
    };
  }

  // Infrastructure-class signals have no safe automated fix.
  return null;
}

// ---------------------------------------------------------------------------
// RCA
// ---------------------------------------------------------------------------
const RCA_HINTS = {
  nodeNotReady: "The kubelet on this node stopped reporting Ready. Common causes: kubelet crash, container-runtime failure, disk/memory exhaustion, or network partition from the control plane.",
  nodePressure: "The kubelet is reporting resource pressure, so it will evict pods and refuse new ones until the pressure clears.",
  operatorDegraded: "A cluster operator reports Degraded, meaning its managed component is not meeting its expected state. This usually blocks upgrades and can affect platform features.",
  pvcPending: "The PersistentVolumeClaim never bound: either no StorageClass provisioner is available, or no PersistentVolume satisfies the size/accessMode/zone request.",
  imagePull: "The container image cannot be pulled — wrong name/tag, missing or expired pull secret, or the registry is unreachable from this cluster.",
  podPending: "The scheduler could not place the pod: insufficient allocatable resources, unsatisfied node selectors/affinity, or taints without matching tolerations.",
};

async function buildRCA(d) {
  // Pod-scoped detections get the real causal-chain RCA engine.
  const pod = d.affected?.find((a) => a.pod)?.pod || null;
  if (pod && d.namespace) {
    try {
      const r = await runRCA(d.namespace, pod);
      if (r && r.rootCause && r.rootCause !== "InvestigationError") {
        return {
          rootCause: r.rootCause,
          severity: r.severity || null,
          recommendation: r.recommendation || null,
          causalChain: Array.isArray(r.causalChain) ? r.causalChain.slice(0, 8) : [],
          evidence: d.evidence || [],
          source: "rca-engine",
        };
      }
    } catch { /* fall through to deterministic RCA */ }
  }
  // Infrastructure / object-scoped detections: synthesize from the detection.
  return {
    rootCause: d.signal,
    severity: null,
    recommendation: RCA_HINTS[d.rule] || `Investigate ${d.signal} on ${d.target || d.node || "the cluster"}.`,
    causalChain: [],
    evidence: d.evidence || [],
    source: "threshold-detection",
  };
}

/** Render the RCA as an ITIL/SRE-standard document (used for close_notes). */
export function renderRCADocument(s) {
  const mins = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : null);
  const mttd = mins(s.firstSeen, s.detectedAt);
  const mtta = mins(s.detectedAt, s.approvedAt);
  const mttr = mins(s.detectedAt, s.resolvedAt);
  const L = [];
  L.push(`ROOT CAUSE ANALYSIS — ${s.incidentNumber || s.id}`);
  L.push(`Generated: ${nowIso().replace("T", " ").slice(0, 19)} by TCS Agentic AI (autonomous detection)`);
  L.push("");
  L.push(`1. SUMMARY`);
  L.push(`   Title      : ${s.title}`);
  L.push(`   Severity   : ${s.severity}`);
  L.push(`   Cluster    : ${s.cluster}`);
  L.push(`   Scope      : ${s.namespace ? `namespace ${s.namespace}` : "cluster-wide"}${s.target ? ` · ${s.target}` : ""}`);
  L.push(`   Detected by: threshold "${s.rule}" (${s.thresholdStandard || "custom"})${s.dwellMinutes != null ? ` after ${s.dwellMinutes}m sustained` : ""}`);
  L.push("");
  L.push(`2. IMPACT`);
  L.push(`   ${s.symptomCount} symptom(s) observed${s.correlation && s.correlation !== "single" ? ` and correlated as "${s.correlation}"` : ""}.`);
  if (s.occurrences > 1) L.push(`   Recurring: seen ${s.occurrences} time(s) — candidate for a Problem record.`);
  L.push("");
  L.push(`3. TIMELINE`);
  L.push(`   Condition began : ${s.firstSeen || "unknown"}`);
  L.push(`   Detected        : ${s.detectedAt}${mttd != null ? `  (MTTD ${mttd}m)` : ""}`);
  if (s.incidentRaisedAt) L.push(`   Ticket raised   : ${s.incidentRaisedAt}`);
  if (s.dryRunAt) L.push(`   Fix dry-run     : ${s.dryRunAt}`);
  if (s.approvedAt) L.push(`   Approved by     : ${s.approvedBy || "operator"} at ${s.approvedAt}${mtta != null ? `  (MTTA ${mtta}m)` : ""}`);
  if (s.remediatedAt) L.push(`   Remediated      : ${s.remediatedAt}`);
  if (s.resolvedAt) L.push(`   Resolved        : ${s.resolvedAt}${mttr != null ? `  (MTTR ${mttr}m)` : ""}`);
  L.push("");
  L.push(`4. ROOT CAUSE`);
  L.push(`   ${s.rca?.rootCause || "Under investigation"}`);
  if (s.rca?.recommendation) L.push(`   ${s.rca.recommendation}`);
  if (s.rca?.causalChain?.length) {
    L.push("");
    L.push(`   Causal chain (5-Whys):`);
    s.rca.causalChain.forEach((c, i) => L.push(`     ${i + 1}. ${c.cause || c.evidence}${c.confidence ? ` (${Math.round(c.confidence * 100)}%)` : ""}`));
  }
  L.push("");
  L.push(`5. EVIDENCE`);
  (s.rca?.evidence || []).slice(0, 8).forEach((e) => L.push(`   • ${e}`));
  L.push("");
  L.push(`6. RESOLUTION`);
  if (s.remediation?.command) {
    L.push(`   Action    : ${s.remediation.action} (risk ${s.remediation.risk}, ${s.remediation.reversible ? "reversible" : "NOT reversible"})`);
    L.push(`   Command   : ${s.remediation.command}`);
    L.push(`   Rationale : ${s.remediation.rationale}`);
    L.push(`   Approval  : ${s.approvedBy ? `approved by ${s.approvedBy}` : "n/a"}`);
    if (s.dryRunOutput) L.push(`   Dry-run   : ${String(s.dryRunOutput).slice(0, 300)}`);
    if (s.applyOutput) L.push(`   Applied   : ${String(s.applyOutput).slice(0, 300)}`);
  } else {
    L.push(`   No safe automated remediation was available; the incident was escalated for human action.`);
  }
  L.push("");
  L.push(`7. VERIFICATION`);
  L.push(`   ${s.verification?.summary || "Not verified"}`);
  L.push("");
  L.push(`8. CORRECTIVE / PREVENTIVE ACTIONS`);
  (buildCapa(s) || []).forEach((a) => L.push(`   • ${a}`));
  L.push("");
  L.push(`9. NOTES`);
  L.push(`   Blameless review. Detection, RCA, ticketing, remediation and verification were automated;`);
  L.push(`   a human approved the corrective action before it was applied.`);
  return L.join("\n");
}

function buildCapa(s) {
  const out = [];
  if (s.rule === "oomKilled") out.push("Right-size memory requests/limits from observed usage; profile for a leak if consumption keeps growing.");
  if (s.rule === "crashLoop") out.push("Add or tune readiness/liveness probes and review recent application changes.");
  if (s.rule === "pvcFilling") out.push("Add a retention/cleanup job and alert on volume growth trend, not just the 90% threshold.");
  if (s.rule === "nodeNotReady") out.push("Review node health monitoring and capacity buffer so a single node loss is absorbed.");
  if (s.rule === "operatorDegraded") out.push("Check operator prerequisites before the next upgrade window.");
  if (s.occurrences > 1) out.push(`Recurring ${s.occurrences}× — raise a Problem record for permanent fix.`);
  if (!out.length) out.push("Review threshold tuning for this signal to confirm the detection was actionable.");
  return out;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
function parseStorageGi(q) {
  const m = /^(\d+(?:\.\d+)?)(Gi|Ti|Mi)$/.exec(String(q || ""));
  if (!m) return null;
  return m[2] === "Ti" ? parseFloat(m[1]) * 1024 : m[2] === "Mi" ? parseFloat(m[1]) / 1024 : parseFloat(m[1]);
}

async function checkHealthy(v) {
  if (!v) return { ok: false, summary: "No verification target." };
  if (v.kind === "persistentvolumeclaims") {
    const pvc = await ocpGet(`/api/v1/namespaces/${v.namespace}/persistentvolumeclaims/${v.name}`);
    const cap = parseStorageGi(pvc?.status?.capacity?.storage);
    const want = parseStorageGi(v.expectStorage);
    if (cap != null && want != null && cap >= want) return { ok: true, summary: `PVC ${v.name} capacity is now ${pvc.status.capacity.storage}.` };
    const resizing = (pvc?.status?.conditions || []).some((c) => /Resiz/i.test(c.type) && c.status === "True");
    return { ok: false, summary: resizing ? `PVC ${v.name} resize in progress (may need a pod restart to complete the filesystem grow).` : `PVC ${v.name} capacity still ${pvc?.status?.capacity?.storage || "unknown"}.` };
  }
  const obj = await ocpGet(`/apis/apps/v1/namespaces/${v.namespace}/${v.kind}/${v.name}`);
  if (v.kind === "daemonsets") {
    const want = obj.status?.desiredNumberScheduled ?? 0;
    const ready = obj.status?.numberReady ?? 0;
    return { ok: want > 0 && ready >= want, summary: `DaemonSet ${v.name}: ${ready}/${want} ready.` };
  }
  const want = obj.spec?.replicas ?? 0;
  const ready = obj.status?.readyReplicas ?? 0;
  return { ok: want > 0 && ready >= want, summary: `${v.kind.slice(0, -1)} ${v.name}: ${ready}/${want} replicas ready.` };
}

const VERIFY_ATTEMPTS = parseInt(process.env.INCIDENT_VERIFY_ATTEMPTS || "12", 10);
const VERIFY_DELAY_MS = parseInt(process.env.INCIDENT_VERIFY_DELAY_MS || "10000", 10);

async function verifyRemediation(session) {
  const v = session.remediation?.verify;
  if (!v) return { ok: false, summary: "Nothing to verify for this action.", attempts: 0 };
  let last = null;
  for (let i = 1; i <= VERIFY_ATTEMPTS; i++) {
    try {
      last = await checkHealthy(v);
      if (last.ok) return { ...last, attempts: i };
    } catch (e) {
      last = { ok: false, summary: `Verification read failed: ${e.message}` };
    }
    if (i < VERIFY_ATTEMPTS) await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
  }
  return { ...(last || { ok: false, summary: "Verification timed out." }), attempts: VERIFY_ATTEMPTS, timedOut: true };
}

// ---------------------------------------------------------------------------
// Phase A (autonomous): detection → RCA → ticket → fix → dry-run → gate
// ---------------------------------------------------------------------------
/**
 * Promote a detection into a managed incident session and run everything up to
 * the approval gate. Human-initiated by default; unattended callers must pass
 * `{ unattended: true }` and are refused unless INCIDENT_AUTO_ACT is enabled.
 */
export async function promoteDetection(detection, { cluster = "local", actor = "operator", unattended = false } = {}) {
  await hydrate();
  if (!detection?.signature) throw new Error("A detection with a signature is required");
  if (unattended && !flags.incidentAutoAct()) {
    throw new Error("Unattended promotion is disabled (INCIDENT_AUTO_ACT=false). A human must promote this detection.");
  }
  if (detection.namespace && PROTECTED_NS.some((re) => re.test(detection.namespace))) {
    throw new Error(`Namespace "${detection.namespace}" is protected — incidents there must be handled manually.`);
  }

  // Idempotency: one live session per signature.
  for (const s of _sessions.values()) {
    if (s.signature === detection.signature && !TERMINAL.has(s.state)) return s;
  }
  const active = [..._sessions.values()].filter((s) => !TERMINAL.has(s.state)).length;
  if (active >= MAX_ACTIVE_SESSIONS) {
    throw new Error(`Too many active incident sessions (${active}/${MAX_ACTIVE_SESSIONS}). Close some before promoting more.`);
  }

  const session = {
    id: genId(),
    cluster,
    signature: detection.signature,
    title: detection.title,
    severity: detection.severity,
    rule: detection.rule,
    signal: detection.signal,
    thresholdStandard: detection.thresholdStandard,
    dwellMinutes: detection.dwellMinutes,
    namespace: detection.namespace || null,
    target: detection.target || null,
    node: detection.node || null,
    kind: detection.kind,
    symptomCount: detection.symptomCount,
    correlation: detection.correlation,
    occurrences: detection.occurrences || 1,
    firstSeen: detection.firstSeen || null,
    affected: detection.affected || [],
    evidence: detection.evidence || [],
    state: S.DETECTED,
    detectedAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    promotedBy: actor,
    unattended: !!unattended,
    history: [],
    rca: null,
    remediation: null,
    incidentNumber: null,
    incidentSysId: null,
    dryRunOutput: null,
    applyOutput: null,
    verification: null,
    error: null,
  };
  _sessions.set(session.id, session);
  await persist(session);

  try {
    // 1. Triage — generate the RCA.
    const rca = await buildRCA(detection);
    await transition(session, S.TRIAGED, { rca });

    // 2. Raise the ServiceNow incident with proper ITIL classification.
    const raiseWorthy = ["SEV-1", "SEV-2", "SEV-3"].includes(session.severity);
    if (raiseWorthy && isServiceNowEnabled()) {
      if (!ticketBudgetAvailable()) {
        // Storm brake: detected and triaged, but we refuse to flood the ITSM.
        await transition(session, S.INC_RAISED, {
          incidentError: `Ticket rate limit reached (${maxTicketsPerHour()}/hour). Incident tracked locally; raise manually if needed.`,
          incidentRaisedAt: nowIso(), rateLimited: true,
        });
      } else {
        try {
          const m = ITIL_MATRIX[session.severity] || ITIL_MATRIX["SEV-3"];
          const inc = await createIncident({
            shortDescription: `[${session.severity}] ${session.title} — Auto-detected by TCS Agentic AI`,
            description: renderRCADocument(session),
            urgency: m.urgency,
            impact: m.impact,
            category: "Software",
            subcategory: session.kind === "node" ? "Infrastructure" : "Application",
            // Native ServiceNow dedup key — the same condition always maps to
            // the same correlation_id, so the instance can relate/suppress too.
            correlationId: session.signature,
            correlationDisplay: `TCS Agentic AI · ${session.rule}`,
            cmdbCi: session.target || session.node || "",
          });
          const rec = inc?.result || inc;
          recordTicket();
          await transition(session, S.INC_RAISED, {
            incidentNumber: rec?.number || null,
            incidentSysId: rec?.sys_id || null,
            incidentRaisedAt: nowIso(),
            itilPriority: m.label,
          });
        } catch (e) {
          // Ticketing failure must not stop remediation planning.
          await transition(session, S.INC_RAISED, { incidentError: e.message, incidentRaisedAt: nowIso() });
        }
      }
    }

    // 3. Plan a remediation. No safe action → escalate with RCA + ticket intact.
    const plan = await planRemediation(detection);
    if (!plan || !plan.command) {
      return await transition(session, S.ESCALATED, {
        remediation: plan || null,
        escalationReason: plan?.rationale
          || `No safe automated remediation exists for ${session.signal}. RCA and ticket are ready for a human owner.`,
      });
    }

    // 4. Guardrail classification before we go anywhere near the cluster.
    const cls = classifyCommand(plan.command);
    if (cls.level === "blocked") {
      return await transition(session, S.ESCALATED, {
        remediation: plan, escalationReason: `Proposed fix was blocked by guardrails: ${cls.reason}`,
      });
    }
    await transition(session, S.FIX_PROPOSED, { remediation: { ...plan, classification: cls } });

    // 5. Dry-run against the real API server (?dryRun=All).
    const dry = await executeFixCommand(plan.command, { dryRun: true });
    if (!dry.success) {
      return await transition(session, S.ESCALATED, {
        dryRunOutput: dry.stderr || dry.stdout || "dry-run failed",
        dryRunAt: nowIso(),
        escalationReason: `Dry-run failed, so the fix was NOT applied: ${(dry.stderr || "unknown error").slice(0, 300)}`,
      });
    }
    await transition(session, S.DRY_RUN_PASSED, { dryRunOutput: dry.stdout || "dry-run OK", dryRunAt: nowIso() });

    // 6. Park at the single human gate.
    return await transition(session, S.AWAITING_APPROVAL);
  } catch (e) {
    try { await transition(session, S.FAILED, { error: e.message }); } catch { /* already terminal */ }
    return session;
  }
}

// ---------------------------------------------------------------------------
// Phase B (autonomous after one click): apply → verify → resolve → close
// ---------------------------------------------------------------------------
async function runRemediationChain(session) {
  try {
    await transition(session, S.REMEDIATING);
    const res = await executeFixCommand(session.remediation.command, { dryRun: false });
    if (!res.success) {
      await transition(session, S.FAILED, { applyOutput: res.stderr || "apply failed" });
      await transition(session, S.ESCALATED, {
        escalationReason: `Remediation failed on apply: ${(res.stderr || "unknown").slice(0, 300)}`,
      });
      await noteOnTicket(session, `Automated remediation FAILED: ${(res.stderr || "unknown").slice(0, 500)}`);
      return;
    }
    await transition(session, S.VERIFYING, { applyOutput: res.stdout || "applied", remediatedAt: nowIso() });

    const verification = await verifyRemediation(session);
    if (!verification.ok) {
      await transition(session, S.ROLLED_BACK, { verification });
      await transition(session, S.ESCALATED, {
        escalationReason: `Fix was applied but verification did not pass: ${verification.summary} — escalated instead of being reported as resolved.`,
      });
      await noteOnTicket(session, `Remediation applied but NOT verified: ${verification.summary}. Incident left open for human review.`);
      return;
    }

    await transition(session, S.RESOLVED, { verification, resolvedAt: nowIso() });

    // Close the ticket with the full RCA as close notes.
    if (session.incidentSysId && isServiceNowEnabled()) {
      try {
        await resolveIncident(session.incidentSysId, {
          closeNotes: renderRCADocument(session),
          workNotes: `Verified: ${verification.summary} (${verification.attempts} check(s))`,
          resolution: {
            incidentNumber: session.incidentNumber,
            severity: session.severity,
            podName: session.affected?.[0]?.pod || session.target,
            namespace: session.namespace,
            deploymentName: session.target,
            cluster: session.cluster,
            rootCause: session.rca?.rootCause,
            evidence: session.rca?.evidence || [],
          },
        });
        await transition(session, S.CLOSED, { closedAt: nowIso(), ticketClosed: true });
      } catch (e) {
        await transition(session, S.CLOSED, { closedAt: nowIso(), ticketClosed: false, closeError: e.message });
      }
    } else {
      await transition(session, S.CLOSED, { closedAt: nowIso(), ticketClosed: false });
    }
  } catch (e) {
    try { await transition(session, S.FAILED, { error: e.message }); } catch { /* ignore */ }
  }
}

async function noteOnTicket(session, text) {
  if (!session.incidentSysId || !isServiceNowEnabled()) return;
  try { await updateRecord("incident", session.incidentSysId, { work_notes: text }); } catch { /* best effort */ }
}

/** The single human gate: approve the proposed fix and let the rest run. */
export async function approveSession(sessionId, { actor = "operator" } = {}) {
  await hydrate();
  const session = _sessions.get(sessionId);
  if (!session) throw new Error(`Incident session ${sessionId} not found`);
  if (session.state !== S.AWAITING_APPROVAL) {
    throw new Error(`Session is ${session.state}, not awaiting approval`);
  }
  await transition(session, S.APPROVED, { approvedBy: actor, approvedAt: nowIso() });
  await noteOnTicket(session, `Fix approved by ${actor}. Applying: ${session.remediation.command}`);
  // Run apply → verify → close in the background; the UI polls the session.
  runRemediationChain(session).catch(() => {});
  return session;
}

export async function rejectSession(sessionId, { actor = "operator", reason = "Rejected by operator" } = {}) {
  await hydrate();
  const session = _sessions.get(sessionId);
  if (!session) throw new Error(`Incident session ${sessionId} not found`);
  if (session.state !== S.AWAITING_APPROVAL) {
    throw new Error(`Session is ${session.state}, not awaiting approval`);
  }
  await transition(session, S.REJECTED, { rejectedBy: actor, rejectedAt: nowIso(), rejectionReason: reason });
  await noteOnTicket(session, `Proposed fix REJECTED by ${actor}: ${reason}. Incident remains open for manual handling.`);
  return await transition(session, S.CLOSED, { closedAt: nowIso(), ticketClosed: false });
}

// ---------------------------------------------------------------------------
// Self-heal — close incidents whose condition cleared on its own
// ---------------------------------------------------------------------------
// A condition that clears before anyone acts (pod recovered, node came back,
// rollout finished) must close itself with evidence. Otherwise the queue fills
// with stale tickets that a human has to read and close by hand — the exact
// toil this system exists to eliminate.
const selfHealConfirmScans = () => parseInt(process.env.INCIDENT_SELFHEAL_SCANS || "2", 10);
const _clearedStreak = new Map(); // sessionId -> consecutive scans with no signal

/** States where the condition clearing means "it fixed itself". */
const PRE_ACTION = new Set([S.DETECTED, S.TRIAGED, S.INC_RAISED, S.FIX_PROPOSED, S.DRY_RUN_PASSED, S.AWAITING_APPROVAL, S.ESCALATED]);

/**
 * Given the signatures still firing right now, close any pre-action session
 * whose signature has been absent for SELF_HEAL_CONFIRM_SCANS consecutive scans.
 * @returns {Promise<Array>} sessions that were auto-closed
 */
export async function reconcileSelfHealed(activeSignatures = []) {
  await hydrate();
  const active = new Set(activeSignatures);
  const healed = [];
  for (const session of _sessions.values()) {
    if (!PRE_ACTION.has(session.state)) { _clearedStreak.delete(session.id); continue; }
    if (active.has(session.signature)) { _clearedStreak.delete(session.id); continue; }
    const streak = (_clearedStreak.get(session.id) || 0) + 1;
    _clearedStreak.set(session.id, streak);
    if (streak < selfHealConfirmScans()) continue; // require confirmation, avoid flapping

    _clearedStreak.delete(session.id);
    try {
      const verification = { ok: true, summary: `Condition cleared on its own — "${session.signal}" no longer detected across ${streak} consecutive scans. No remediation was applied.`, attempts: streak, selfHealed: true };
      await transition(session, S.RESOLVED, { verification, resolvedAt: nowIso(), selfHealed: true });
      if (session.incidentSysId && isServiceNowEnabled()) {
        try {
          await resolveIncident(session.incidentSysId, {
            closeCode: "Solved (Permanently)",
            closeNotes: renderRCADocument(session),
            workNotes: `Auto-closed by TCS Agentic AI: the condition self-resolved and was confirmed clear over ${streak} consecutive detection scans.`,
            resolution: {
              incidentNumber: session.incidentNumber, severity: session.severity,
              podName: session.affected?.[0]?.pod || session.target, namespace: session.namespace,
              deploymentName: session.target, cluster: session.cluster,
              rootCause: session.rca?.rootCause, evidence: session.rca?.evidence || [],
            },
          });
          await transition(session, S.CLOSED, { closedAt: nowIso(), ticketClosed: true });
        } catch (e) {
          await transition(session, S.CLOSED, { closedAt: nowIso(), ticketClosed: false, closeError: e.message });
        }
      } else {
        await transition(session, S.CLOSED, { closedAt: nowIso(), ticketClosed: false });
      }
      healed.push(session);
    } catch { /* transition refused — leave it alone */ }
  }
  return healed;
}

/**
 * Unattended sweep: promote every eligible detection into a managed incident.
 * Eligibility is decided by the detector (severity floor + chronic guard); this
 * adds the ticket-budget brake and skips anything already under management.
 * No-op unless INCIDENT_AUTO_ACT=true.
 */
export async function autoPromoteDetections(detections = [], { cluster = "local" } = {}) {
  if (!flags.incidentAutoAct()) return { enabled: false, promoted: [], skipped: detections.length };
  await hydrate();
  const managed = new Set([..._sessions.values()].filter((s) => !TERMINAL.has(s.state)).map((s) => s.signature));
  const promoted = [];
  const skipped = [];
  for (const d of detections) {
    if (!d.autoTicketEligible) { skipped.push({ signature: d.signature, why: d.autoTicketBlockedBy || "not-eligible" }); continue; }
    if (managed.has(d.signature)) { skipped.push({ signature: d.signature, why: "already-managed" }); continue; }
    if (!ticketBudgetAvailable()) { skipped.push({ signature: d.signature, why: "rate-limited" }); continue; }
    try {
      const s = await promoteDetection(d, { cluster, actor: "auto-detect", unattended: true });
      promoted.push({ signature: d.signature, sessionId: s.id, state: s.state, incidentNumber: s.incidentNumber || null });
      managed.add(d.signature);
    } catch (e) {
      skipped.push({ signature: d.signature, why: e.message });
    }
  }
  return { enabled: true, promoted, skipped };
}

export async function listSessions({ cluster, state } = {}) {
  await hydrate();
  let out = [..._sessions.values()];
  if (cluster) out = out.filter((s) => s.cluster === cluster);
  if (state) out = out.filter((s) => s.state === state);
  return out.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getIncidentSession(sessionId) {
  await hydrate();
  return _sessions.get(sessionId) || null;
}

/** RCA document for a session, for download/attachment. */
export async function getSessionRCA(sessionId) {
  const s = await getIncidentSession(sessionId);
  return s ? renderRCADocument(s) : null;
}
