/**
 * Autonomous Incident Detection — Phase 1: THRESHOLD EVALUATOR + CORRELATION,
 * running in SHADOW MODE.
 *
 * This is the *detector* half of the autonomous incident loop. It answers
 * "which incidents would we have opened, without anyone asking?" — the trigger
 * that UC-01 lacks today (UC-01 only fires when a human types a question).
 *
 * SHADOW MODE IS A HARD GUARANTEE OF THIS MODULE:
 *   - It only READS cluster state (ocpGet) and Alertmanager.
 *   - It NEVER creates a ServiceNow ticket, never notifies, never remediates,
 *     never mutates anything.
 *   - Each detection carries `wouldRaiseTicket` / `wouldBeAutoRemediable` so the
 *     operator can see what the automation *would* have done, and tune
 *     thresholds against real traffic before granting it autonomy.
 * Promoting a detection into a real incident (RCA + INC + fix proposal) is a
 * later phase and deliberately lives outside this file.
 *
 * Thresholds default to the values encoded in the kubernetes-mixin /
 * kube-prometheus alerting rules that ship with OpenShift — i.e. the global
 * industry standard — rather than numbers invented here. Every one is
 * overridable via INCIDENT_THRESHOLDS (JSON) so a customer can own them.
 */

import { ocpGet } from "../utils/openshift-client.js";

// ---------------------------------------------------------------------------
// Threshold policy
// ---------------------------------------------------------------------------
// `dwellMinutes` is the sustain time before a breach becomes an incident — the
// direct equivalent of a Prometheus rule's `for:` clause. It is what prevents a
// transient blip (or a normal rolling deploy) from opening a ticket.
export const DEFAULT_THRESHOLDS = {
  crashLoop:        { enabled: true, dwellMinutes: 15, minRestarts: 3, severity: "SEV-2", standard: "KubePodCrashLooping" },
  oomKilled:        { enabled: true, dwellMinutes: 0,  windowMinutes: 30, severity: "SEV-2", standard: "container OOMKilled" },
  imagePull:        { enabled: true, dwellMinutes: 10, severity: "SEV-3", standard: "KubeContainerWaiting" },
  podNotReady:      { enabled: true, dwellMinutes: 15, severity: "SEV-3", standard: "KubePodNotReady" },
  podPending:       { enabled: true, dwellMinutes: 15, severity: "SEV-3", standard: "KubePodNotScheduled" },
  zeroReady:        { enabled: true, dwellMinutes: 5,  severity: "SEV-1", standard: "KubeDeploymentReplicasMismatch (0 ready)" },
  replicaMismatch:  { enabled: true, dwellMinutes: 15, severity: "SEV-3", standard: "KubeDeploymentReplicasMismatch" },
  nodeNotReady:     { enabled: true, dwellMinutes: 5,  severity: "SEV-1", standard: "KubeNodeNotReady" },
  nodePressure:     { enabled: true, dwellMinutes: 10, severity: "SEV-3", standard: "KubeNodeMemory/DiskPressure" },
  operatorDegraded: { enabled: true, dwellMinutes: 10, severity: "SEV-2", standard: "ClusterOperatorDegraded" },
  pvcPending:       { enabled: true, dwellMinutes: 15, severity: "SEV-3", standard: "KubePersistentVolumeClaimPending" },
  pvcFilling:       { enabled: true, freePctBelow: 10, severity: "SEV-2", standard: "KubePersistentVolumeFillingUp" },
};

// Namespaces whose noise should never open an incident on its own. Platform
// namespaces are still covered by operatorDegraded / node rules.
const NOISE_NAMESPACES = [/^openshift-marketplace$/, /^openshift-operator-lifecycle-manager$/];

// Rules for which a safe, deterministic remediation exists (rolling restart,
// memory bump, PVC expand). Shared with the orchestrator so the badge shown in
// shadow mode and the action actually planned later can never diverge.
// Infrastructure signals (node/operator/PVC-pending/image-pull) are deliberately
// absent — they escalate to a human instead of being guessed at.
export const AUTO_REMEDIABLE_RULES = new Set([
  "crashLoop", "podNotReady", "zeroReady", "replicaMismatch", "oomKilled", "pvcFilling",
]);

/** Merge operator overrides (env JSON) over the standard defaults. */
export function getThresholds() {
  let over = {};
  try {
    if (process.env.INCIDENT_THRESHOLDS) over = JSON.parse(process.env.INCIDENT_THRESHOLDS);
  } catch { /* malformed override → standards only */ }
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) out[k] = { ...v, ...(over[k] || {}) };
  return out;
}

// ---------------------------------------------------------------------------
// Suppression / recurrence memory (per-process; Phase 2 moves this to the DB
// alongside incident_history so it survives restarts and spans the fleet).
// ---------------------------------------------------------------------------
const _seen = new Map(); // signature -> { firstSeen, lastSeen, occurrences }

// These are read at CALL time, not import time, so changing them from the
// Settings panel takes effect on the very next scan without a pod restart.

// A signature seen again while it was never absent is the SAME ongoing episode.
// It only counts as a genuine recurrence if the condition CLEARED (went missing
// from a scan for longer than this gap) and then came back. Without this, a
// 60-second poll would report "60× recurring" after an hour of one flat outage.
const recurrenceGapMinutes = () => parseInt(process.env.INCIDENT_RECURRENCE_GAP_MINUTES || "20", 10);

// A condition that was ALREADY broken for longer than this when we first saw it
// is chronic, not a new incident. Paging someone at 2am for something that has
// been failing for ten days is how automated ITSM loses credibility — chronic
// items are surfaced as Problem-record candidates instead.
const chronicHours = () => parseInt(process.env.INCIDENT_CHRONIC_HOURS || "24", 10);

// Only these severities are eligible for UNATTENDED ticket creation. Everything
// else is still detected and can be promoted by hand.
const autoSeverityFloor = () => (process.env.INCIDENT_AUTO_SEVERITY_FLOOR || "SEV-2").toUpperCase();

function minutesSince(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

/** 14606 → "10d 3h". Raw minutes are unreadable past an hour or two. */
export function humanizeMinutes(m) {
  if (m == null || Number.isNaN(m)) return null;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/** Strip ReplicaSet/pod hash suffixes so a signature is stable across restarts. */
function stableName(name) {
  return String(name || "")
    .replace(/-[a-f0-9]{6,10}-[a-z0-9]{5}$/, "")  // deployment pod: foo-6bc756b95f-2vv7b
    .replace(/-[a-z0-9]{5}$/, "")                  // bare replicaset pod: foo-2vv7b
    .replace(/-\d+$/, "");                         // statefulset pod: foo-0
}

const SEV_RANK = { "SEV-1": 1, "SEV-2": 2, "SEV-3": 3, "SEV-4": 4, "SEV-5": 5 };
const worstSev = (a, b) => (SEV_RANK[a] <= SEV_RANK[b] ? a : b);

/** Pod's owning workload name (stable), for grouping symptoms per deployment. */
function ownerOf(pod) {
  const o = (pod.metadata?.ownerReferences || [])[0];
  if (!o) return stableName(pod.metadata?.name);
  if (o.kind === "ReplicaSet") return stableName(o.name);
  return o.name;
}

/** How long a pod has been not-Ready (the dwell signal for pod-level rules). */
function notReadyMinutes(pod) {
  const c = (pod.status?.conditions || []).find((x) => x.type === "Ready");
  if (c && c.status !== "True" && c.lastTransitionTime) return minutesSince(c.lastTransitionTime);
  return minutesSince(pod.status?.startTime || pod.metadata?.creationTimestamp);
}

function conditionAge(obj, type, wantStatus) {
  const c = (obj.status?.conditions || []).find((x) => x.type === type);
  if (!c || c.status !== wantStatus) return null;
  return minutesSince(c.lastTransitionTime);
}

async function fetchAlertmanager() {
  for (const p of [
    "/api/v1/namespaces/openshift-monitoring/services/alertmanager-main:web/proxy/api/v2/alerts",
    "/api/v1/namespaces/monitoring/services/alertmanager-main:web/proxy/api/v2/alerts",
  ]) {
    try { const r = await ocpGet(p); if (Array.isArray(r)) return r; } catch { /* try next */ }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Symptom collection — one raw finding per breached threshold
// ---------------------------------------------------------------------------
function collectPodSymptoms(pods, T, symptoms) {
  for (const pod of pods) {
    const ns = pod.metadata?.namespace || "";
    if (NOISE_NAMESPACES.some((re) => re.test(ns))) continue;
    if (pod.metadata?.deletionTimestamp) continue; // terminating — not an incident
    const name = pod.metadata.name;
    const node = pod.spec?.nodeName || null;
    const phase = pod.status?.phase;
    const statuses = pod.status?.containerStatuses || [];
    const dwell = notReadyMinutes(pod);
    const base = { namespace: ns, pod: name, node, owner: ownerOf(pod), kind: "pod" };

    // Succeeded/Completed pods are not incidents.
    if (phase === "Succeeded") continue;

    for (const cs of statuses) {
      const waitReason = cs.state?.waiting?.reason || "";
      const lastTerm = cs.lastState?.terminated;

      if (T.crashLoop.enabled && waitReason === "CrashLoopBackOff") {
        const restarts = cs.restartCount || 0;
        if (restarts >= T.crashLoop.minRestarts && (dwell ?? 0) >= T.crashLoop.dwellMinutes) {
          symptoms.push({ ...base, signal: "CrashLoopBackOff", container: cs.name, severity: T.crashLoop.severity,
            dwellMinutes: dwell, rule: "crashLoop", standard: T.crashLoop.standard,
            evidence: `container "${cs.name}" restarted ${restarts}× — CrashLoopBackOff for ${dwell}m` });
        }
      }

      if (T.oomKilled.enabled && lastTerm?.reason === "OOMKilled") {
        const ago = minutesSince(lastTerm.finishedAt);
        if (ago == null || ago <= T.oomKilled.windowMinutes) {
          symptoms.push({ ...base, signal: "OOMKilled", container: cs.name, severity: T.oomKilled.severity,
            dwellMinutes: ago, rule: "oomKilled", standard: T.oomKilled.standard,
            evidence: `container "${cs.name}" OOMKilled ${ago == null ? "recently" : `${ago}m ago`} (exit ${lastTerm.exitCode ?? "?"})` });
        }
      }

      if (T.imagePull.enabled && /^(ImagePullBackOff|ErrImagePull|InvalidImageName)$/.test(waitReason)) {
        if ((dwell ?? 0) >= T.imagePull.dwellMinutes) {
          symptoms.push({ ...base, signal: waitReason, container: cs.name, severity: T.imagePull.severity,
            dwellMinutes: dwell, rule: "imagePull", standard: T.imagePull.standard,
            evidence: `container "${cs.name}" cannot pull image for ${dwell}m — ${cs.state?.waiting?.message?.slice(0, 120) || waitReason}` });
        }
      }
    }

    if (T.podPending.enabled && phase === "Pending") {
      const sched = (pod.status?.conditions || []).find((c) => c.type === "PodScheduled");
      const pendFor = sched && sched.status !== "True" ? minutesSince(sched.lastTransitionTime) : dwell;
      if ((pendFor ?? 0) >= T.podPending.dwellMinutes) {
        symptoms.push({ ...base, signal: "Pending", severity: T.podPending.severity, dwellMinutes: pendFor,
          rule: "podPending", standard: T.podPending.standard,
          evidence: `pod unscheduled for ${pendFor}m — ${sched?.message?.slice(0, 140) || "no matching node"}` });
      }
    }

    // Catch-all: running but never becoming Ready (probe failures) — only when
    // no more specific signal already fired for this pod.
    if (T.podNotReady.enabled && phase === "Running" && (dwell ?? 0) >= T.podNotReady.dwellMinutes) {
      const ready = (pod.status?.conditions || []).find((c) => c.type === "Ready");
      const already = symptoms.some((s) => s.pod === name && s.namespace === ns);
      if (ready && ready.status !== "True" && !already) {
        symptoms.push({ ...base, signal: "NotReady", severity: T.podNotReady.severity, dwellMinutes: dwell,
          rule: "podNotReady", standard: T.podNotReady.standard,
          evidence: `running but not Ready for ${dwell}m — likely failing readiness probe` });
      }
    }
  }
}

function collectNodeSymptoms(nodes, T, symptoms) {
  for (const n of nodes) {
    const name = n.metadata?.name;
    if (T.nodeNotReady.enabled) {
      const notReadyFor = conditionAge(n, "Ready", "False") ?? conditionAge(n, "Ready", "Unknown");
      if (notReadyFor != null && notReadyFor >= T.nodeNotReady.dwellMinutes) {
        symptoms.push({ kind: "node", node: name, namespace: null, signal: "NodeNotReady",
          severity: T.nodeNotReady.severity, dwellMinutes: notReadyFor, rule: "nodeNotReady",
          standard: T.nodeNotReady.standard, evidence: `node "${name}" has been NotReady for ${notReadyFor}m` });
      }
    }
    if (T.nodePressure.enabled) {
      for (const p of ["MemoryPressure", "DiskPressure", "PIDPressure"]) {
        const age = conditionAge(n, p, "True");
        if (age != null && age >= T.nodePressure.dwellMinutes) {
          symptoms.push({ kind: "node", node: name, namespace: null, signal: p,
            severity: T.nodePressure.severity, dwellMinutes: age, rule: "nodePressure",
            standard: T.nodePressure.standard, evidence: `node "${name}" reporting ${p} for ${age}m` });
        }
      }
    }
  }
}

function collectWorkloadSymptoms(deploys, T, symptoms) {
  for (const d of deploys) {
    const ns = d.metadata?.namespace || "";
    if (NOISE_NAMESPACES.some((re) => re.test(ns))) continue;
    const name = d.metadata?.name;
    const want = d.spec?.replicas ?? 0;
    const ready = d.status?.readyReplicas ?? 0;
    if (want === 0 || ready >= want) continue;
    // Dwell from the Available condition so a healthy rolling update is ignored.
    const age = conditionAge(d, "Available", "False") ?? minutesSince(d.metadata?.creationTimestamp);
    const zero = ready === 0;
    const rule = zero ? T.zeroReady : T.replicaMismatch;
    if (!rule.enabled) continue;
    if ((age ?? 0) < rule.dwellMinutes) continue;
    symptoms.push({ kind: "workload", namespace: ns, owner: name, signal: zero ? "ZeroReadyReplicas" : "ReplicasMismatch",
      severity: rule.severity, dwellMinutes: age, rule: zero ? "zeroReady" : "replicaMismatch", standard: rule.standard,
      evidence: `deployment "${name}" has ${ready}/${want} replicas ready for ${age}m` });
  }
}

function collectOperatorSymptoms(operators, T, symptoms) {
  if (!T.operatorDegraded.enabled) return;
  for (const co of operators) {
    const age = conditionAge(co, "Degraded", "True");
    if (age != null && age >= T.operatorDegraded.dwellMinutes) {
      const c = (co.status?.conditions || []).find((x) => x.type === "Degraded");
      symptoms.push({ kind: "operator", namespace: null, owner: co.metadata?.name, signal: "ClusterOperatorDegraded",
        severity: T.operatorDegraded.severity, dwellMinutes: age, rule: "operatorDegraded",
        standard: T.operatorDegraded.standard,
        evidence: `cluster operator "${co.metadata?.name}" Degraded for ${age}m — ${(c?.message || "").slice(0, 140)}` });
    }
  }
}

function collectPvcSymptoms(pvcs, T, symptoms) {
  if (!T.pvcPending.enabled) return;
  for (const p of pvcs) {
    if (p.status?.phase !== "Pending") continue;
    const age = minutesSince(p.metadata?.creationTimestamp);
    if ((age ?? 0) < T.pvcPending.dwellMinutes) continue;
    symptoms.push({ kind: "pvc", namespace: p.metadata?.namespace, owner: p.metadata?.name, signal: "PVCPending",
      severity: T.pvcPending.severity, dwellMinutes: age, rule: "pvcPending", standard: T.pvcPending.standard,
      evidence: `PVC "${p.metadata?.name}" unbound for ${age}m (class ${p.spec?.storageClassName || "default"})` });
  }
}

async function collectPvcFillingSymptoms(T, symptoms) {
  if (!T.pvcFilling.enabled) return;
  try {
    const { promQuery } = await import("./prometheus.js");
    const rows = await promQuery(
      `(kubelet_volume_stats_available_bytes / kubelet_volume_stats_capacity_bytes) * 100 < ${T.pvcFilling.freePctBelow}`
    );
    for (const r of rows || []) {
      const ns = r.metric?.namespace, name = r.metric?.persistentvolumeclaim;
      if (!ns || !name) continue;
      const freePct = Math.round(parseFloat(r.value?.[1]));
      symptoms.push({ kind: "pvc", namespace: ns, owner: name, signal: "PVCFillingUp",
        severity: T.pvcFilling.severity, dwellMinutes: null, rule: "pvcFilling", standard: T.pvcFilling.standard,
        evidence: `PVC "${name}" only ${freePct}% free (threshold <${T.pvcFilling.freePctBelow}%)` });
    }
  } catch { /* Prometheus optional — other rules still fire */ }
}

// ---------------------------------------------------------------------------
// Correlation — collapse many symptoms into few incidents
// ---------------------------------------------------------------------------
// This is the step that separates a usable automation from an alert storm: a
// NotReady node that takes 20 pods with it must be ONE incident with 20
// symptoms, not 21 tickets.
function correlate(symptoms) {
  const incidents = [];
  const claimed = new Set();

  const nodeSymptoms = symptoms.filter((s) => s.kind === "node" && s.signal === "NodeNotReady");
  for (const ns of nodeSymptoms) {
    const children = symptoms.filter((s) => s !== ns && s.node && s.node === ns.node);
    children.forEach((c) => claimed.add(c));
    claimed.add(ns);
    incidents.push({
      primary: ns, symptoms: [ns, ...children], severity: ns.severity,
      title: `Node ${ns.node} NotReady — ${children.length} workload symptom(s) impacted`,
      rootHint: `The node has been NotReady for ${ns.dwellMinutes}m; the pod-level failures on it are almost certainly consequences, not independent faults.`,
      correlation: children.length ? "node-cascade" : "single",
    });
  }

  // Group the remaining pod symptoms per (namespace, owner, signal).
  const groups = new Map();
  for (const s of symptoms) {
    if (claimed.has(s)) continue;
    const key = `${s.rule}|${s.namespace || "-"}|${s.owner || s.node || "-"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const group of groups.values()) {
    const primary = group.reduce((a, b) => (SEV_RANK[a.severity] <= SEV_RANK[b.severity] ? a : b));
    let severity = primary.severity;
    // Breadth escalation: the same fault across many replicas is worse than one.
    if (group.length >= 3 && SEV_RANK[severity] > 1) severity = worstSev(severity, "SEV-2");
    // Cluster-scoped objects (nodes, cluster operators) have no namespace —
    // don't render a "null/" prefix for them.
    const qualify = (n) => (primary.namespace ? `${primary.namespace}/${n}` : n);
    const scope = primary.owner ? qualify(primary.owner) : (primary.node || "cluster");
    incidents.push({
      primary, symptoms: group, severity,
      title: group.length > 1
        ? `${primary.signal} — ${scope} (${group.length} instances)`
        : `${primary.signal} — ${primary.pod ? qualify(primary.pod) : scope}`,
      rootHint: null,
      correlation: group.length > 1 ? "workload-group" : "single",
    });
  }

  return incidents;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
/**
 * Evaluate every threshold against live cluster state and return the incidents
 * that WOULD be opened. Read-only. Never raises a ticket (shadow mode).
 */
export async function detectIncidents() {
  const T = getThresholds();

  const [pods, nodes, deploys, operators, pvcs, amAlerts] = await Promise.all([
    ocpGet("/api/v1/pods?limit=3000").catch(() => ({ items: [] })),
    ocpGet("/api/v1/nodes").catch(() => ({ items: [] })),
    ocpGet("/apis/apps/v1/deployments?limit=1000").catch(() => ({ items: [] })),
    ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => ({ items: [] })),
    ocpGet("/api/v1/persistentvolumeclaims?limit=1000").catch(() => ({ items: [] })),
    fetchAlertmanager(),
  ]);

  const symptoms = [];
  collectNodeSymptoms(nodes.items || [], T, symptoms);
  collectPodSymptoms(pods.items || [], T, symptoms);
  collectWorkloadSymptoms(deploys.items || [], T, symptoms);
  collectOperatorSymptoms(operators.items || [], T, symptoms);
  collectPvcSymptoms(pvcs.items || [], T, symptoms);
  await collectPvcFillingSymptoms(T, symptoms);

  const correlated = correlate(symptoms);

  // Fingerprint, apply recurrence memory, and shape the result.
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const seenThisScan = new Set();
  const out = [];
  for (const inc of correlated) {
    const p = inc.primary;
    const signature = `${p.rule}:${p.namespace || "cluster"}:${p.owner || p.node || stableName(p.pod) || "-"}`;
    seenThisScan.add(signature);
    const prev = _seen.get(signature);

    // True recurrence = the condition disappeared for longer than the gap and
    // then returned. A continuously-present condition stays occurrence #1 no
    // matter how many times we poll.
    const gap = prev ? minutesSince(prev.lastSeen) : null;
    const isNewEpisode = !prev || (gap != null && gap > recurrenceGapMinutes());
    const occurrences = isNewEpisode ? ((prev?.occurrences || 0) + 1) : (prev.occurrences || 1);
    const firstSeen = isNewEpisode
      ? new Date(now - (p.dwellMinutes || 0) * 60000).toISOString()
      : prev.firstSeen;
    _seen.set(signature, { firstSeen, lastSeen: nowIso, occurrences });

    // Chronic: already broken longer than the chronic window when first seen.
    const ageMinutes = p.dwellMinutes ?? minutesSince(firstSeen) ?? 0;
    const chronicH = chronicHours();
    const chronic = ageMinutes > chronicH * 60;

    // Ticket eligibility for UNATTENDED creation: severity floor + not chronic.
    // (Chronic items remain fully promotable by hand from the UI.)
    const meetsSeverity = SEV_RANK[inc.severity] <= (SEV_RANK[autoSeverityFloor()] || 2);
    const autoTicketEligible = meetsSeverity && !chronic;

    out.push({
      signature,
      title: inc.title,
      severity: inc.severity,
      correlation: inc.correlation,
      symptomCount: inc.symptoms.length,
      namespace: p.namespace || null,
      target: p.owner || p.pod || p.node || null,
      node: p.node || null,
      kind: p.kind,
      signal: p.signal,
      rule: p.rule,
      thresholdStandard: p.standard,
      threshold: T[p.rule] || null,
      dwellMinutes: p.dwellMinutes,
      dwellHuman: humanizeMinutes(p.dwellMinutes),
      ageHuman: humanizeMinutes(ageMinutes),
      detectedAt: nowIso,
      firstSeen,
      occurrences,
      recurring: occurrences > 1,
      chronic,
      classification: chronic ? "problem" : "incident",
      chronicReason: chronic
        ? `Already failing for ${humanizeMinutes(ageMinutes)} when first detected (chronic threshold ${chronicH}h). Treated as a Problem candidate, not a new Incident — raise it manually if you want a ticket.`
        : null,
      rootHint: inc.rootHint,
      evidence: inc.symptoms.slice(0, 8).map((s) => s.evidence),
      affected: inc.symptoms.slice(0, 20).map((s) => ({
        namespace: s.namespace, pod: s.pod || null, node: s.node || null, owner: s.owner || null, signal: s.signal,
      })),
      // Transparency: exactly what the automation would do, and why.
      wouldRaiseTicket: autoTicketEligible,
      autoTicketEligible,
      autoTicketBlockedBy: autoTicketEligible ? null : (chronic ? "chronic" : "severity-floor"),
      wouldBeAutoRemediable: AUTO_REMEDIABLE_RULES.has(p.rule),
      shadowMode: true,
    });
  }

  // Age out signatures that have fully cleared, so a later reappearance counts
  // as a real recurrence and self-heal detection can see them disappear.
  for (const [sig, rec] of _seen) {
    if (!seenThisScan.has(sig) && (minutesSince(rec.lastSeen) ?? 0) > 24 * 60) _seen.delete(sig);
  }

  out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (b.symptomCount - a.symptomCount));

  const bySeverity = out.reduce((m, i) => { m[i.severity] = (m[i.severity] || 0) + 1; return m; }, {});
  return {
    shadowMode: true,
    notice: "Shadow mode — detections only. No ServiceNow tickets were raised, no notifications sent, and nothing was remediated.",
    incidents: out,
    // Live signature set, so the poller can spot conditions that have cleared.
    activeSignatures: [...seenThisScan],
    stats: {
      detections: out.length,
      symptoms: symptoms.length,
      correlationSavings: Math.max(0, symptoms.length - out.length), // tickets avoided by correlating
      chronic: out.filter((i) => i.chronic).length,
      recurring: out.filter((i) => i.recurring).length,
      wouldRaiseTickets: out.filter((i) => i.autoTicketEligible).length,
      bySeverity,
      alertmanagerAlerts: Array.isArray(amAlerts) ? amAlerts.filter((a) => a.status?.state === "active").length : 0,
    },
    policy: {
      chronicHours: chronicHours(),
      autoSeverityFloor: autoSeverityFloor(),
      recurrenceGapMinutes: recurrenceGapMinutes(),
    },
    thresholds: T,
    generatedAt: nowIso,
  };
}
