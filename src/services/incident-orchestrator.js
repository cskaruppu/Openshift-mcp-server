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

import { ocpGet, ocpFetch } from "../utils/openshift-client.js";
import { runRCA } from "../tools/rca-engine.js";
import { classifyJSON, llmEnabled } from "./llm.js";
import { fenceUntrusted, UNTRUSTED_GUARD } from "./untrusted.js";
import { findMatchingErrors } from "./error-knowledge.js";
import { executeFixCommand } from "./fix-executor.js";
import { classifyCommand } from "./guardrails.js";
import { logAuditEvent } from "./audit-log.js";
import { createIncident, resolveIncident, updateRecord, findOpenIncidentByCorrelation, getIncidentState } from "../utils/servicenow-client.js";
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
  // Authoritative fallback: the name may still be a ReplicaSet (e.g. the hash
  // heuristic didn't apply). Read the ReplicaSet and follow its ownerReference
  // to the real Deployment instead of guessing at the string.
  try {
    const rs = await ocpGet(`/apis/apps/v1/namespaces/${ns}/replicasets/${encodeURIComponent(name)}`);
    const owner = (rs?.metadata?.ownerReferences || []).find((o) => o.kind === "Deployment");
    if (owner?.name) {
      const dep = await ocpGet(`/apis/apps/v1/namespaces/${ns}/deployments/${encodeURIComponent(owner.name)}`);
      if (dep?.metadata?.name) {
        return { plural: "deployments", api: "/apis/apps/v1", kind: "Deployment", obj: dep, resolvedFrom: `replicaset/${name}` };
      }
    }
  } catch { /* not a ReplicaSet either */ }
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
    const wname = wl.obj.metadata.name;   // resolved name (may differ from `owner`)
    return {
      action: "rollout_restart",
      command: `oc rollout restart ${wl.plural.slice(0, -1)}/${wname} -n ${ns}`,
      risk: "low",
      reversible: true,
      rationale: `Rolling restart of ${wl.kind} ${wname} recreates its pods. Reversible and the standard first response for ${d.signal}.`
        + (wl.resolvedFrom ? ` (resolved from ${wl.resolvedFrom})` : ""),
      verify: { kind: wl.plural, namespace: ns, name: wname },
    };
  }

  // OOMKilled: never "just restart" — raise the memory limit (doubling, which is
  // the conventional first step) so the container stops being killed.
  if (d.rule === "oomKilled") {
    if (!ns || !owner) return null;
    const wl = await findWorkload(ns, owner);
    if (!wl) return null;
    const wname = wl.obj.metadata.name;   // resolved name (may differ from `owner`)
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
      command: `oc set resources ${wl.plural.slice(0, -1)}/${wname} -n ${ns} --containers=${c.name} --limits=memory=${newMi}Mi`,
      risk: "medium",
      reversible: true,
      rationale: `Container "${c.name}" was OOMKilled at a ${curMi}Mi limit. Doubling to ${newMi}Mi stops the kill; profile the workload if it keeps growing (possible leak).`,
      verify: { kind: wl.plural, namespace: ns, name: wname },
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

/** Bound best-effort enrichment so a slow provider can't stall the poller. */
function withSoftTimeout(promise, ms, fallback = null) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const ERROR_HINTS = [
  { re: /\b(OutOfMemoryError|OOM|Cannot allocate memory|memory allocation failed)\b/i, category: "Memory Exhaustion" },
  { re: /\b(ECONNREFUSED|connection refused|dial tcp.*refused)\b/i, category: "Connection Refused" },
  { re: /\b(ENOTFOUND|no such host|could not resolve|Name or service not known)\b/i, category: "DNS Resolution" },
  { re: /\b(permission denied|EACCES|403 Forbidden|Access denied)\b/i, category: "Permission Denied" },
  { re: /\b(no space left|disk full|ENOSPC)\b/i, category: "Disk Full" },
  { re: /\b(panic:|FATAL|fatal error|segmentation fault|core dumped)\b/i, category: "Application Crash" },
  { re: /\b(readiness probe failed|liveness probe failed|startup probe failed)\b/i, category: "Health Check Failure" },
  { re: /\b(deadline exceeded|context deadline|timed out)\b/i, category: "Timeout" },
  { re: /\b(NullPointerException|TypeError|AttributeError|KeyError|IndexError)\b/i, category: "Application Error" },
  { re: /\b(SSL|TLS|certificate|x509|handshake failure)\b/i, category: "TLS/Certificate" },
  { re: /\b(quota exceeded|resource quota|LimitRange)\b/i, category: "Resource Quota" },
];

/**
 * Collect the hard evidence an RCA needs: pod spec/status, container logs (the
 * previous instance too, since a crash-looped container's useful output is in
 * the terminated one), the object's own events, and resource limits.
 */
async function gatherEvidence(namespace, podName) {
  const out = { pod: null, containers: [], logLines: [], events: [], limits: [], restarts: 0, exitCodes: [] };
  if (!namespace || !podName) return out;
  let pod;
  try { pod = await ocpGet(`/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(podName)}`); }
  catch { return out; }
  out.pod = {
    name: pod.metadata?.name, phase: pod.status?.phase, node: pod.spec?.nodeName,
    startTime: pod.status?.startTime,
  };
  for (const cs of pod.status?.containerStatuses || []) {
    out.restarts += cs.restartCount || 0;
    const term = cs.lastState?.terminated || cs.state?.terminated;
    if (term) out.exitCodes.push({ container: cs.name, code: term.exitCode, reason: term.reason, at: term.finishedAt });
    out.containers.push({
      name: cs.name, ready: cs.ready, restarts: cs.restartCount || 0,
      state: cs.state?.waiting?.reason || cs.state?.terminated?.reason || (cs.state?.running ? "Running" : "Unknown"),
    });
  }
  for (const c of pod.spec?.containers || []) {
    out.limits.push({ container: c.name, limits: c.resources?.limits || {}, requests: c.resources?.requests || {} });
  }
  // Logs — current and, when the container has restarted, the previous instance.
  const wantPrev = (pod.status?.containerStatuses || []).some((cs) => cs.lastState?.terminated);
  for (const c of (pod.spec?.containers || []).slice(0, 2)) {
    for (const prev of wantPrev ? [true, false] : [false]) {
      try {
        const raw = await ocpFetch(
          `/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(podName)}/log?container=${encodeURIComponent(c.name)}&tailLines=60&timestamps=true${prev ? "&previous=true" : ""}`,
          { headers: { Accept: "text/plain" } }
        ).catch(() => "");
        const text = typeof raw === "string" ? raw : "";
        if (!text) continue;
        for (const line of text.split("\n")) {
          if (/\b(error|exception|fatal|panic|fail|warn|critical|killed)\b/i.test(line) && line.trim()) {
            out.logLines.push(`${prev ? "[previous] " : ""}${c.name}: ${line.trim().slice(0, 220)}`);
            if (out.logLines.length >= 15) break;
          }
        }
      } catch { /* logs optional */ }
      if (out.logLines.length >= 15) break;
    }
  }
  try {
    const ev = await ocpGet(`/api/v1/namespaces/${namespace}/events?fieldSelector=involvedObject.name=${encodeURIComponent(podName)}&limit=30`);
    out.events = (ev.items || [])
      .filter((e) => e.type === "Warning")
      .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0))
      .slice(0, 8)
      .map((e) => ({ reason: e.reason, message: (e.message || "").slice(0, 200), at: e.lastTimestamp }));
  } catch { /* events optional */ }
  return out;
}

/** Ask the LLM for a deep, grounded diagnosis. Returns null when unavailable. */
async function aiDiagnose(d, ev, deterministic) {
  if (!llmEnabled()) return null;
  const logExcerpt = ev.logLines.length ? ev.logLines.slice(0, 12).join("\n") : "(no error lines found in logs)";
  const eventText = ev.events.length ? ev.events.map((e) => `${e.reason}: ${e.message}`).join("\n") : "(no warning events)";
  const limits = ev.limits.map((l) => `${l.container}: limits=${JSON.stringify(l.limits)} requests=${JSON.stringify(l.requests)}`).join("; ") || "(none set)";

  // Logs and events are attacker-influencable content — fence them so the model
  // treats them as data, never as instructions.
  const prompt = `${UNTRUSTED_GUARD}

Analyze this OpenShift/Kubernetes incident and respond with ONLY a JSON object.

DETECTION
  signal: ${d.signal}
  threshold rule: ${d.rule} (${d.thresholdStandard || "custom"})
  sustained for: ${d.dwellMinutes ?? "?"} minutes
  scope: ${d.namespace ? `namespace ${d.namespace}` : "cluster"} / ${d.target || d.node || "unknown"}
  correlated symptoms: ${d.symptomCount ?? 1} (${d.correlation || "single"})
  recurrence: seen ${d.occurrences ?? 1} time(s)

POD STATE
  phase: ${ev.pod?.phase || "unknown"} · node: ${ev.pod?.node || "unknown"} · total restarts: ${ev.restarts}
  containers: ${JSON.stringify(ev.containers)}
  termination: ${JSON.stringify(ev.exitCodes)}
  resources: ${limits}

DETERMINISTIC FINDING
  ${deterministic.rootCause}${deterministic.recommendation ? ` — ${deterministic.recommendation}` : ""}

${fenceUntrusted("CONTAINER_LOGS", logExcerpt)}

${fenceUntrusted("KUBERNETES_EVENTS", eventText)}

Respond with EXACTLY this JSON shape:
{
  "rootCause": "one precise sentence naming the actual cause, citing the evidence",
  "category": "one of: Memory Exhaustion, Memory Leak, Configuration Error, Dependency Failure, Permission Issue, Resource Exhaustion, Application Bug, Health Check Failure, Image Issue, Network Issue, Storage Issue, Infrastructure Failure, Unknown",
  "analysis": "3-5 sentences explaining what is happening and WHY, referencing specific log lines or exit codes",
  "contributingFactors": ["factor 1", "factor 2"],
  "impact": "one sentence on user/service impact",
  "whyChain": ["why 1 (symptom)", "why 2", "why 3 (root)"],
  "investigationSteps": ["step to confirm", "next step"],
  "preventiveActions": ["action to stop recurrence"],
  "confidence": "high | medium | low"
}`;

  try {
    const r = await classifyJSON({
      prompt,
      system: "You are a senior OpenShift/Kubernetes SRE writing a blameless root-cause analysis. Be specific and cite evidence — never invent log lines or metrics that were not provided. If the evidence is thin, say so and set confidence low. Output JSON only.",
      maxTokens: 900,
    });
    if (!r || !r.rootCause) return null;
    return r;
  } catch { return null; }
}

async function buildRCA(d) {
  // 1. Deterministic base — always available, never blocks.
  const pod = d.affected?.find((a) => a.pod)?.pod || null;
  let base = {
    rootCause: d.signal,
    severity: null,
    recommendation: RCA_HINTS[d.rule] || `Investigate ${d.signal} on ${d.target || d.node || "the cluster"}.`,
    causalChain: [],
    source: "threshold-detection",
  };
  if (pod && d.namespace) {
    try {
      const r = await runRCA(d.namespace, pod);
      if (r && r.rootCause && r.rootCause !== "InvestigationError") {
        base = {
          rootCause: r.rootCause,
          severity: r.severity || null,
          recommendation: r.recommendation || null,
          causalChain: Array.isArray(r.causalChain) ? r.causalChain.slice(0, 8) : [],
          source: "rca-engine",
        };
      }
    } catch { /* keep the threshold-derived base */ }
  }

  // 2. Hard evidence (logs, events, limits, exit codes).
  const ev = pod ? await withSoftTimeout(gatherEvidence(d.namespace, pod), 20_000, null) : null;
  const evidenceBundle = ev || { logLines: [], events: [], limits: [], containers: [], exitCodes: [], restarts: 0, pod: null };

  // 3. Knowledge-base matches over the real logs/events.
  let kbMatches = [];
  try {
    kbMatches = findMatchingErrors(evidenceBundle.logLines, evidenceBundle.events)
      .slice(0, 4)
      .map((m) => ({ rootCause: m.entry?.rootCause, remediation: (m.entry?.remediation || [])[0], matched: m.matchedText, source: m.source }));
  } catch { /* optional */ }

  // Cheap deterministic categorisation as a fallback for the AI's category.
  const logText = evidenceBundle.logLines.join("\n");
  const patternCategory = (ERROR_HINTS.find((h) => h.re.test(logText)) || {}).category || null;

  // 4. AI deep analysis — bounded, and the RCA is complete without it.
  const ai = await withSoftTimeout(aiDiagnose(d, evidenceBundle, base), 35_000, null);

  return {
    ...base,
    // AI narrative wins for the headline when present, deterministic stays as evidence.
    rootCause: ai?.rootCause || base.rootCause,
    deterministicRootCause: base.rootCause,
    category: ai?.category || patternCategory || null,
    analysis: ai?.analysis || null,
    contributingFactors: ai?.contributingFactors || [],
    impact: ai?.impact || null,
    whyChain: ai?.whyChain || (base.causalChain || []).map((c) => c.cause || c.evidence).filter(Boolean),
    investigationSteps: ai?.investigationSteps || [],
    preventiveActions: ai?.preventiveActions || [],
    confidence: ai?.confidence || (evidenceBundle.logLines.length ? "medium" : "low"),
    aiAnalysed: !!ai,
    aiUnavailableReason: ai ? null : (llmEnabled() ? "AI analysis timed out or returned no result — deterministic RCA shown" : "No LLM provider configured — deterministic RCA shown"),
    evidence: d.evidence || [],
    logLines: evidenceBundle.logLines,
    events: evidenceBundle.events,
    limits: evidenceBundle.limits,
    exitCodes: evidenceBundle.exitCodes,
    restarts: evidenceBundle.restarts,
    kbMatches,
    source: ai ? "ai+rca-engine" : base.source,
  };
}

/** Wrap prose to a width so the document stays readable in ServiceNow. */
function wrap(text, width = 92) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) { if (cur) lines.push(cur); cur = w; }
    else cur = (cur ? cur + " " : "") + w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
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
  const r = s.rca || {};
  L.push(`4. ROOT CAUSE`);
  L.push(`   ${r.rootCause || "Under investigation"}`);
  if (r.category) L.push(`   Category   : ${r.category}`);
  L.push(`   Determined by: ${r.aiAnalysed ? "AI analysis grounded in live logs, events and pod state" : "deterministic rules"}`
    + `${r.confidence ? ` · confidence ${r.confidence}` : ""}`);
  if (!r.aiAnalysed && r.aiUnavailableReason) L.push(`   Note       : ${r.aiUnavailableReason}`);
  if (r.deterministicRootCause && r.deterministicRootCause !== r.rootCause) {
    L.push(`   Rule-based signal: ${r.deterministicRootCause}`);
  }

  if (r.analysis) {
    L.push("");
    L.push(`4.1 DETAILED AI ANALYSIS`);
    wrap(r.analysis, 92).forEach((line) => L.push(`   ${line}`));
  }
  if (r.impact) {
    L.push("");
    L.push(`4.2 IMPACT ASSESSMENT`);
    wrap(r.impact, 92).forEach((line) => L.push(`   ${line}`));
  }
  const why = (r.whyChain && r.whyChain.length) ? r.whyChain
    : (r.causalChain || []).map((c) => c.cause || c.evidence).filter(Boolean);
  if (why.length) {
    L.push("");
    L.push(`4.3 CAUSAL CHAIN (5-WHYS)`);
    why.forEach((w, i) => L.push(`   ${i === 0 ? "Symptom" : i === why.length - 1 ? "Root   " : `Why ${i}  `} : ${w}`));
  }
  if (r.contributingFactors?.length) {
    L.push("");
    L.push(`4.4 CONTRIBUTING FACTORS`);
    r.contributingFactors.forEach((f) => L.push(`   • ${f}`));
  }
  if (r.recommendation) {
    L.push("");
    L.push(`4.5 RECOMMENDATION`);
    wrap(r.recommendation, 92).forEach((line) => L.push(`   ${line}`));
  }

  L.push("");
  L.push(`5. EVIDENCE`);
  L.push(`   5.1 Threshold observations`);
  (r.evidence || []).slice(0, 8).forEach((e) => L.push(`       • ${e}`));
  if (r.restarts) L.push(`       • total container restarts: ${r.restarts}`);
  if (r.exitCodes?.length) {
    r.exitCodes.forEach((x) => L.push(`       • container "${x.container}" terminated: ${x.reason || "?"} (exit ${x.code ?? "?"})${x.at ? ` at ${x.at}` : ""}`));
  }
  if (r.limits?.length) {
    L.push(`   5.2 Resource configuration`);
    r.limits.forEach((l) => L.push(`       • ${l.container}: limits=${JSON.stringify(l.limits)} requests=${JSON.stringify(l.requests)}`));
  }
  if (r.logLines?.length) {
    L.push(`   5.3 Log evidence (${r.logLines.length} error line(s) captured)`);
    r.logLines.slice(0, 12).forEach((l) => L.push(`       | ${l}`));
  } else {
    L.push(`   5.3 Log evidence: none captured (container may not have produced error output)`);
  }
  if (r.events?.length) {
    L.push(`   5.4 Kubernetes warning events`);
    r.events.forEach((e) => L.push(`       • [${e.reason}] ${e.message}`));
  }
  if (r.kbMatches?.length) {
    L.push(`   5.5 Known-error knowledge base matches`);
    r.kbMatches.forEach((m) => L.push(`       • ${m.rootCause || "match"}${m.matched ? ` (matched "${String(m.matched).slice(0, 60)}")` : ""}${m.remediation ? ` → ${m.remediation}` : ""}`));
  }
  if (r.investigationSteps?.length) {
    L.push("");
    L.push(`5.6 FURTHER INVESTIGATION (if this recurs)`);
    r.investigationSteps.forEach((st, i) => L.push(`   ${i + 1}. ${st}`));
  }
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
  // AI-proposed preventive actions lead, since they're grounded in this
  // incident's actual evidence rather than the signal type alone.
  for (const a of (s.rca?.preventiveActions || []).slice(0, 4)) out.push(a);
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

/**
 * Snapshot the workload's pods in `oc get pods` shape, so the console can show
 * real before/after container status instead of just claiming success.
 * @returns {Promise<{at:string, rows:Array, header:Array}|null>}
 */
export async function captureWorkloadSnapshot(namespace, target) {
  if (!namespace) return null;
  try {
    const list = await ocpGet(`/api/v1/namespaces/${namespace}/pods?limit=200`);
    const stem = String(target || "");
    const pods = (list.items || []).filter((p) => !stem || (p.metadata?.name || "").startsWith(stem));
    const rows = pods.slice(0, 12).map((p) => {
      const cs = p.status?.containerStatuses || [];
      const ready = cs.filter((c) => c.ready).length;
      const total = cs.length || (p.spec?.containers || []).length;
      const restarts = cs.reduce((n, c) => n + (c.restartCount || 0), 0);
      const waiting = cs.find((c) => c.state?.waiting?.reason)?.state.waiting.reason;
      const start = p.status?.startTime || p.metadata?.creationTimestamp;
      const ageMin = start ? Math.max(0, Math.round((Date.now() - new Date(start).getTime()) / 60000)) : null;
      const age = ageMin == null ? "—"
        : ageMin < 60 ? `${ageMin}m`
        : ageMin < 1440 ? `${Math.floor(ageMin / 60)}h${ageMin % 60 ? `${ageMin % 60}m` : ""}`
        : `${Math.floor(ageMin / 1440)}d`;
      return {
        name: p.metadata?.name,
        ready: `${ready}/${total}`,
        status: waiting || p.status?.phase || "Unknown",
        restarts,
        age,
        healthy: total > 0 && ready === total && !waiting && p.status?.phase === "Running",
      };
    });
    return { at: nowIso(), header: ["NAME", "READY", "STATUS", "RESTARTS", "AGE"], rows };
  } catch {
    return null;
  }
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
    signals: detection.signals || [detection.signal],
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
        // Authoritative duplicate check against ServiceNow itself. If an OPEN
        // incident already carries this correlation_id we ATTACH to it instead of
        // raising a second ticket — this holds even when our own session store
        // was lost (pod restart / DB down), which is when duplicates used to slip
        // through. The rest of the flow (dry-run, apply, verify, close with RCA)
        // then runs against that existing ticket.
        let reused = null;
        try { reused = await findOpenIncidentByCorrelation(session.signature); } catch { /* ignore */ }
        if (reused?.sys_id) {
          await transition(session, S.INC_RAISED, {
            incidentNumber: reused.number || null,
            incidentSysId: reused.sys_id,
            incidentRaisedAt: nowIso(),
            reusedExistingTicket: true,
            itilPriority: (ITIL_MATRIX[session.severity] || {}).label || null,
          });
          await noteOnTicket(session,
            `Additional occurrence detected by TCS Agentic AI for the same condition (${session.signature}). ` +
            `No duplicate incident raised — this ticket remains the single record. Signals: ${(session.signals || [session.signal]).join(", ")}.`);
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
    // Snapshot container state BEFORE touching anything, so the console can show
    // a real before/after rather than asserting the fix worked.
    const before = await captureWorkloadSnapshot(session.namespace, session.target);
    await transition(session, S.REMEDIATING, { beforeSnapshot: before });

    // Terminal transcript — the operator sees exactly what ran, in CLI form.
    const term = [
      `$ ${session.remediation.command}`,
    ];
    const res = await executeFixCommand(session.remediation.command, { dryRun: false });
    term.push(res.success ? (res.stdout || "applied") : (res.stderr || "failed"));
    if (!res.success) {
      await transition(session, S.FAILED, { applyOutput: res.stderr || "apply failed", terminal: term });
      await transition(session, S.ESCALATED, {
        escalationReason: `Remediation failed on apply: ${(res.stderr || "unknown").slice(0, 300)}`,
      });
      await noteOnTicket(session, `Automated remediation FAILED: ${(res.stderr || "unknown").slice(0, 500)}`);
      return;
    }
    term.push("", `$ oc get pods -n ${session.namespace} | grep ${session.target || ""}`.trim());
    await transition(session, S.VERIFYING, { applyOutput: res.stdout || "applied", remediatedAt: nowIso(), terminal: term });

    const verification = await verifyRemediation(session);
    // Capture the resulting container state — this is the evidence, not a claim.
    const after = await captureWorkloadSnapshot(session.namespace, session.target);
    if (after?.rows?.length) {
      for (const r of after.rows) term.push(`${r.name}   ${r.ready}   ${r.status}   ${r.restarts}   ${r.age}`);
    }
    term.push("", verification.ok
      ? `# verified: ${verification.summary}`
      : `# NOT verified: ${verification.summary}`);
    if (!verification.ok) {
      await transition(session, S.ROLLED_BACK, { verification, afterSnapshot: after, terminal: term });
      await transition(session, S.ESCALATED, {
        escalationReason: `Fix was applied but verification did not pass: ${verification.summary} — escalated instead of being reported as resolved.`,
      });
      await noteOnTicket(session, `Remediation applied but NOT verified: ${verification.summary}. Incident left open for human review.`);
      return;
    }

    await transition(session, S.RESOLVED, { verification, resolvedAt: nowIso(), afterSnapshot: after, terminal: term });

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

/**
 * Re-run the dry-run on demand so the operator can see the preview immediately
 * before committing. Read-only (?dryRun=All) and does NOT change state.
 */
export async function dryRunSession(sessionId) {
  await hydrate();
  const session = _sessions.get(sessionId);
  if (!session) throw new Error(`Incident session ${sessionId} not found`);
  if (!session.remediation?.command) throw new Error("This incident has no proposed fix to dry-run");
  const res = await executeFixCommand(session.remediation.command, { dryRun: true });
  session.dryRunOutput = res.success ? (res.stdout || "dry-run OK") : (res.stderr || "dry-run failed");
  session.dryRunOk = !!res.success;
  session.dryRunAt = nowIso();
  session.updatedAt = nowIso();
  await persist(session);
  return session;
}

/**
 * Re-attempt remediation planning for an ESCALATED session. Useful when the
 * first attempt found no fix for a reason that has since changed (e.g. the
 * workload target now resolves correctly), so an already-raised ticket can
 * become actionable without waiting for a fresh detection cycle.
 */
export async function replanSession(sessionId) {
  await hydrate();
  const session = _sessions.get(sessionId);
  if (!session) throw new Error(`Incident session ${sessionId} not found`);
  if (session.state !== S.ESCALATED) throw new Error(`Session is ${session.state}; re-plan only applies to escalated incidents`);

  const detection = {
    rule: session.rule, signal: session.signal, namespace: session.namespace,
    target: session.target, node: session.node, kind: session.kind,
  };
  const plan = await planRemediation(detection);
  if (!plan || !plan.command) {
    throw new Error(plan?.rationale || `Still no safe automated remediation for ${session.signal}.`);
  }
  const cls = classifyCommand(plan.command);
  if (cls.level === "blocked") throw new Error(`Proposed fix is blocked by guardrails: ${cls.reason}`);

  const dry = await executeFixCommand(plan.command, { dryRun: true });
  if (!dry.success) throw new Error(`Dry-run failed, fix not offered: ${(dry.stderr || "unknown").slice(0, 200)}`);

  // ESCALATED → AWAITING_APPROVAL is an allowed edge.
  await transition(session, S.AWAITING_APPROVAL, {
    remediation: { ...plan, classification: cls },
    dryRunOutput: dry.stdout || "dry-run OK",
    dryRunOk: true,
    dryRunAt: nowIso(),
    escalationReason: null,
    replannedAt: nowIso(),
  });
  await noteOnTicket(session, `Re-planned: automated fix now available — ${plan.command}. Awaiting operator approval.`);
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
 * Reconcile the OTHER direction: an admin resolved or closed the ticket directly
 * in ServiceNow. Without this the local session would sit in AWAITING_APPROVAL
 * forever and the operator would be asked to approve a fix for an incident that
 * is already closed — and a later recurrence could not open a fresh ticket.
 * @returns {Promise<Array>} sessions closed because their ticket was closed
 */
export async function reconcileExternalClosures() {
  await hydrate();
  if (!isServiceNowEnabled()) return [];
  const closed = [];
  for (const session of _sessions.values()) {
    if (TERMINAL.has(session.state)) continue;
    // Only pre-action states: never abandon a session mid-apply/verify.
    if (!PRE_ACTION.has(session.state)) continue;
    if (!session.incidentSysId) continue;
    let st = null;
    try { st = await getIncidentState(session.incidentSysId); } catch { continue; }
    if (!st || !st.terminal) continue;
    try {
      await transition(session, S.RESOLVED, {
        resolvedAt: nowIso(),
        closedExternally: true,
        verification: {
          ok: true,
          summary: `Incident ${st.number || session.incidentNumber} was resolved/closed directly in ServiceNow (state ${st.state}${st.closeCode ? `, ${st.closeCode}` : ""}). Local automation stopped tracking it.`,
          attempts: 0,
        },
      });
      await transition(session, S.CLOSED, { closedAt: nowIso(), ticketClosed: true, closedBy: "servicenow" });
      closed.push(session);
    } catch { /* transition refused — leave it */ }
  }
  return closed;
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
