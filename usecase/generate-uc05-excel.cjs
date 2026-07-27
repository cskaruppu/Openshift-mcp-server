/**
 * TCS Agentic AI — UC-05: Zero-Touch Incident Command
 * Generates: usecase/TCS_Agentic_AI_UC05_Zero_Touch_Incident_Command.xlsx
 *
 * Run: node usecase/generate-uc05-excel.cjs
 */
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "TCS_Agentic_AI_UC05_Zero_Touch_Incident_Command.xlsx");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const wb = new ExcelJS.Workbook();
wb.creator = "TCS Agentic AI Platform";
wb.created = new Date();
wb.title = "TCS Agentic AI — Zero-Touch Incident Command (ZTIC) · UC-05";
wb.company = "Tata Consultancy Services";
wb.subject = "ZTIC — autonomous incident lifecycle for OpenShift";

const C = {
  darkNavy: "0F172A", navy: "1E293B", tcsBlue: "2563EB", lightBlue: "DBEAFE", paleBlue: "EFF6FF",
  aiPurple: "7C3AED", lightPurple: "EDE9FE",
  autoGreen: "059669", lightGreen: "D1FAE5", darkGreen: "065F46",
  userAmber: "D97706", lightAmber: "FEF3C7", darkAmber: "92400E",
  valCyan: "0891B2", lightCyan: "CFFAFE",
  secRed: "DC2626", lightRed: "FEE2E2",
  orange: "EA580C", lightOrange: "FFEDD5",
  white: "FFFFFF", bgLight: "F8FAFC", border: "CBD5E1",
  textDark: "1E293B", textMed: "475569", slate: "64748B", lightSlate: "F1F5F9",
};

const thin = { style: "thin", color: { argb: "FF" + C.border } };
const bd = { top: thin, bottom: thin, left: thin, right: thin };
const F = "Calibri";

function fill(argb) { return { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + argb } }; }

/** Title banner + optional subtitle. Returns the next free row. */
function banner(ws, title, subtitle, span) {
  ws.mergeCells(1, 1, 1, span);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: F, size: 16, bold: true, color: { argb: "FF" + C.white } };
  t.fill = fill(C.darkNavy);
  t.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(1).height = 32;

  if (subtitle) {
    ws.mergeCells(2, 1, 2, span);
    const s = ws.getCell(2, 1);
    s.value = subtitle;
    s.font = { name: F, size: 10.5, italic: true, color: { argb: "FF" + C.textMed } };
    s.fill = fill(C.paleBlue);
    s.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: true };
    ws.getRow(2).height = 26;
    return 4;
  }
  return 3;
}

function headerRow(ws, rowIdx, cells) {
  const r = ws.getRow(rowIdx);
  cells.forEach((c, i) => {
    const cell = r.getCell(i + 1);
    cell.value = c;
    cell.font = { name: F, size: 10.5, bold: true, color: { argb: "FF" + C.white } };
    cell.fill = fill(C.navy);
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: 1 };
    cell.border = bd;
  });
  r.height = 26;
  return rowIdx + 1;
}

function dataRows(ws, startRow, rows, opts = {}) {
  let r = startRow;
  rows.forEach((row, ri) => {
    const xr = ws.getRow(r);
    row.forEach((v, i) => {
      const cell = xr.getCell(i + 1);
      cell.value = v;
      cell.font = { name: F, size: 10, bold: i === 0 && opts.boldFirst !== false, color: { argb: "FF" + C.textDark } };
      cell.fill = fill(ri % 2 === 0 ? C.white : C.bgLight);
      cell.alignment = { vertical: "top", horizontal: "left", wrapText: true, indent: 1 };
      cell.border = bd;
    });
    xr.height = opts.height || 30;
    r++;
  });
  return r;
}

function note(ws, rowIdx, span, text, bg, fg) {
  ws.mergeCells(rowIdx, 1, rowIdx, span);
  const c = ws.getCell(rowIdx, 1);
  c.value = text;
  c.font = { name: F, size: 10.5, bold: true, color: { argb: "FF" + fg } };
  c.fill = fill(bg);
  c.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: 1 };
  c.border = bd;
  ws.getRow(rowIdx).height = 34;
  return rowIdx + 2;
}

// ═══════════════════════════════ 1. OVERVIEW
{
  const ws = wb.addWorksheet("1. Overview", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 30 }, { width: 95 }];
  let r = banner(ws, "TCS Agentic AI — Zero-Touch Incident Command  (ZTIC)  ·  UC-05",
    "Self-detecting · Self-documenting · Self-closing · Self-reverting incident lifecycle for OpenShift", 2);

  r = headerRow(ws, r, ["Attribute", "Detail"]);
  r = dataRows(ws, r, [
    ["Use case ID", "UC-05"],
    ["Full name", "TCS Agentic AI — Zero-Touch Incident Command"],
    ["Short name (use in demos)", "ZTIC"],
    ["Product family", "TCS Agentic AI for OpenShift · Tata Consultancy Services"],
    ["Tagline", "Nobody opens the ticket. Nobody writes the RCA. Nobody closes it."],
    ["Category", "Autonomous ITSM / AIOps"],
    ["Human touchpoints", "Exactly ONE — approving the fix"],
    ["Trigger", "None. Continuous threshold evaluation against the live cluster."],
    ["Platform", "TCS Agentic AI for OpenShift"],
    ["Relationship to UC-01", "UC-01 answers when a human asks. UC-05 has no human trigger at all, closes its own tickets with an audit-grade RCA, and keeps a change ledger so every fix can be reverted."],
  ], { height: 34 });

  r++;
  r = headerRow(ws, r, ["Demo description (short)", ""]);
  ws.mergeCells(r, 1, r, 2);
  const d = ws.getCell(r, 1);
  d.value =
    "Today an SRE notices a problem, opens a ServiceNow incident, investigates, writes the root-cause analysis by hand, applies a fix, then goes back and closes the ticket. Most of that effort is administration, not engineering — and the ticket-closing step alone consumes hours of skilled time every week.\n\n" +
    "UC-05 removes every one of those steps except the decision to apply the fix.\n\n" +
    "The platform continuously evaluates industry-standard thresholds against the live cluster. When a breach is sustained past its dwell time, it correlates the symptoms into a single incident, gathers real evidence (container logs — including the previous terminated instance — events, resource limits, exit codes), asks the AI for a grounded root-cause analysis, raises a properly classified ServiceNow incident into the admin queue, plans a safe remediation, and dry-runs it against the live API server.\n\n" +
    "Then it stops and waits for one human click.\n\n" +
    "On approval it applies the fix, verifies the workload actually recovered, ATTACHES the RCA as HTML and PDF, links and closes duplicate tickets, closes the incident with the full RCA in the close notes, and RECORDS the change with a precomputed inverse so it can be reverted. If the condition clears on its own first, the incident closes itself and says so. If verification fails, it escalates and deliberately leaves the ticket open rather than reporting a false success.";
  d.font = { name: F, size: 10.5, color: { argb: "FF" + C.textDark } };
  d.fill = fill(C.white);
  d.alignment = { vertical: "top", horizontal: "left", wrapText: true, indent: 1 };
  d.border = bd;
  ws.getRow(r).height = 210;
  r += 2;

  note(ws, r, 2,
    "What makes it unique: this is not alerting and not a chatbot. Other automation stops at “alert raised” — UC-05 also writes the RCA and closes the ticket, which is the part every other tool leaves on the human.",
    C.lightGreen, C.darkGreen);
}

// ═══════════════════════════════ 2. WORKFLOW
{
  const ws = wb.addWorksheet("2. Workflow", { properties: { tabColor: { argb: "FF" + C.aiPurple } } });
  ws.columns = [{ width: 6 }, { width: 22 }, { width: 24 }, { width: 62 }, { width: 16 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Workflow, step by step",
    "Everything before the approval gate is autonomous. Everything after it is autonomous.", 5);

  r = headerRow(ws, r, ["#", "Phase", "State", "What happens", "Actor"]);
  r = dataRows(ws, r, [
    ["1", "Detect", "—", "Background loop (every 2 min) evaluates 12 industry-standard thresholds against pods, nodes, deployments, cluster operators, PVCs and Alertmanager.", "AI · automatic"],
    ["2", "Dwell check", "—", "A breach must be sustained past its dwell time (the Prometheus `for:` equivalent) so transient blips and normal rolling deploys never open a ticket.", "AI · automatic"],
    ["3", "Correlate", "—", "Related symptoms collapse into ONE incident — a NotReady node taking N pods with it is 1 incident with N symptoms, not N+1 tickets.", "AI · automatic"],
    ["4", "Fingerprint", "DETECTED", "Stable signature (survives rollouts) plus recurrence and chronic classification. Duplicate conditions never open a second ticket.", "AI · automatic"],
    ["5", "Eligibility", "—", "Severity floor + chronic guard + rate limit + already-managed check decide whether this may be auto-ticketed.", "AI · automatic"],
    ["6", "Triage", "TRIAGED", "Gather evidence (container logs incl. previous terminated instance, warning events, resource limits, exit codes) and run AI root-cause analysis.", "AI · automatic"],
    ["7", "Raise ticket", "INC_RAISED", "ServiceNow incident created with ITIL Impact×Urgency priority, admin assignment group, category and correlation_id for native dedup.", "AI · automatic"],
    ["8", "Plan fix", "FIX_PROPOSED", "Deterministic remediation planner selects ONE safe action for the signal class; the command is classified by guardrails.", "AI · automatic"],
    ["9", "Dry-run", "DRY_RUN_PASSED", "Fix previewed against the live API server with ?dryRun=All. Nothing is modified.", "AI · automatic"],
    ["10", "APPROVAL GATE", "AWAITING_APPROVAL", "The ONLY human step. Operator reviews the RCA and the dry-run output, then clicks Apply Fix (or Reject).", "HUMAN"],
    ["11", "Apply", "REMEDIATING", "The approved command is executed against the cluster.", "AI · automatic"],
    ["12", "Verify", "VERIFYING", "Workload health is polled until it recovers or the attempt budget is exhausted.", "AI · automatic"],
    ["13", "Resolve", "RESOLVED", "Recovery confirmed and recorded as verification evidence.", "AI · automatic"],
    ["14", "Close", "CLOSED", "ServiceNow incident closed with the full RCA in the close notes.", "AI · automatic"],
  ], { height: 42 });

  r++;
  r = headerRow(ws, r, ["#", "Exception path", "State", "Behaviour", "Actor"]);
  r = dataRows(ws, r, [
    ["E1", "Self-healed", "RESOLVED → CLOSED", "Condition clears before anyone acts. Confirmed absent over N consecutive scans, then the incident auto-resolves and the ticket closes with the RCA and a self-resolved work note.", "AI · automatic"],
    ["E2", "No safe fix", "ESCALATED", "Node NotReady, degraded operator, unbound PVC, image pull. RCA and ticket are prepared and handed to a human — the system never guesses at a fix.", "AI → human"],
    ["E3", "Verification failed", "ROLLED_BACK → ESCALATED", "The fix applied but the workload did not recover. Escalates and deliberately leaves the ticket OPEN rather than reporting a false success.", "AI → human"],
    ["E4", "Rejected", "REJECTED → CLOSED", "Operator declines. Session closes; the incident is left open for manual handling.", "HUMAN"],
    ["E5", "Chronic", "not ticketed", "Already broken longer than the chronic window when first seen — surfaced as a Problem candidate, promotable by hand.", "AI · automatic"],
    ["E6", "Rate limited", "INC_RAISED (local)", "Ticket budget for the hour is spent. Triaged and tracked locally instead of flooding the ITSM.", "AI · automatic"],
  ], { height: 46 });

  r++;
  note(ws, r, 5, "ASCII flow:  Detect → Dwell → Correlate → Fingerprint → Eligibility → Triage(AI RCA) → Raise INC → Plan fix → Dry-run → [ APPROVAL ] → Apply → Verify → Resolve → Close+RCA",
    C.lightAmber, C.darkAmber);
}

// ═══════════════════════════════ 3. STATE MACHINE
{
  const ws = wb.addWorksheet("3. State Machine", { properties: { tabColor: { argb: "FF" + C.valCyan } } });
  ws.columns = [{ width: 24 }, { width: 46 }, { width: 52 }, { width: 14 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Lifecycle state machine (15 states)", "Transitions are enforced; an invalid transition is rejected rather than silently applied.", 4);
  r = headerRow(ws, r, ["State", "Meaning", "Allowed next states", "Human?"]);
  r = dataRows(ws, r, [
    ["DETECTED", "Threshold breach promoted into a managed incident", "TRIAGED · RESOLVED (self-heal) · FAILED", "No"],
    ["TRIAGED", "Evidence gathered and AI RCA produced", "INC_RAISED · FIX_PROPOSED · ESCALATED · RESOLVED · FAILED", "No"],
    ["INC_RAISED", "ServiceNow incident created", "FIX_PROPOSED · ESCALATED · RESOLVED · FAILED", "No"],
    ["FIX_PROPOSED", "Safe remediation selected and guardrail-classified", "DRY_RUN_PASSED · ESCALATED · RESOLVED · FAILED", "No"],
    ["DRY_RUN_PASSED", "Fix previewed against the live API server", "AWAITING_APPROVAL · ESCALATED · RESOLVED · FAILED", "No"],
    ["AWAITING_APPROVAL", "THE HUMAN GATE — waiting for the operator", "APPROVED · REJECTED · ESCALATED · RESOLVED", "YES"],
    ["APPROVED", "Operator approved the fix", "REMEDIATING · FAILED", "No"],
    ["REMEDIATING", "Command executing against the cluster", "VERIFYING · ROLLED_BACK · FAILED", "No"],
    ["VERIFYING", "Polling workload health", "RESOLVED · ROLLED_BACK · FAILED", "No"],
    ["RESOLVED", "Recovery confirmed (or self-healed)", "CLOSED", "No"],
    ["CLOSED", "Ticket closed with the RCA — terminal", "—", "No"],
    ["REJECTED", "Operator declined the fix", "CLOSED", "No"],
    ["ESCALATED", "Needs a human; RCA + ticket already prepared", "AWAITING_APPROVAL (retry) · RESOLVED · CLOSED", "No"],
    ["ROLLED_BACK", "Applied but not verified — ticket stays open", "ESCALATED · CLOSED", "No"],
    ["FAILED", "Execution error", "ESCALATED · CLOSED", "No"],
  ], { height: 28 });
  r++;
  note(ws, r, 4, "Only AWAITING_APPROVAL requires a person. Every other transition is driven by the platform.", C.lightAmber, C.darkAmber);
}

// ═══════════════════════════════ 4. THRESHOLDS
{
  const ws = wb.addWorksheet("4. Thresholds", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 22 }, { width: 22 }, { width: 12 }, { width: 44 }, { width: 40 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Detection thresholds (global industry standard)",
    "Defaults come from the kubernetes-mixin / kube-prometheus rules OpenShift already ships. Dwell time is the equivalent of a Prometheus rule's `for:` clause.", 5);
  r = headerRow(ws, r, ["Rule", "Dwell / condition", "Severity", "Industry standard rule", "Why it matters"]);
  r = dataRows(ws, r, [
    ["crashLoop", "15 min · ≥3 restarts  OR  ≥3 restarts gained in a 15-min window", "SEV-2", "KubePodCrashLooping", "Dual trigger: state-only checks MISS a container that is Running at the instant of the scan. The mixin standard is rate-based for this reason."],
    ["oomKilled", "on event (30 min window)", "SEV-2", "container OOMKilled", "Memory limit exceeded; a restart alone will repeat the kill"],
    ["zeroReady", "5 min", "SEV-1", "KubeDeploymentReplicasMismatch (0 ready)", "Complete loss of a service"],
    ["replicaMismatch", "15 min", "SEV-3", "KubeDeploymentReplicasMismatch", "Reduced capacity / partial availability"],
    ["podNotReady", "15 min", "SEV-3", "KubePodNotReady", "Running but failing readiness — silent traffic loss"],
    ["podPending", "15 min", "SEV-3", "KubePodNotScheduled", "Scheduling failure: resources, affinity or taints"],
    ["imagePull", "10 min", "SEV-3", "KubeContainerWaiting", "Bad image, missing pull secret or unreachable registry"],
    ["nodeNotReady", "5 min", "SEV-1", "KubeNodeNotReady", "Node loss — usually the root of many pod symptoms"],
    ["nodePressure", "10 min", "SEV-3", "KubeNodeMemory/DiskPressure", "Kubelet will evict pods until pressure clears"],
    ["operatorDegraded", "10 min", "SEV-2", "ClusterOperatorDegraded", "Platform component unhealthy; blocks upgrades"],
    ["pvcPending", "15 min", "SEV-3", "KubePersistentVolumeClaimPending", "Storage never bound — provisioner or PV mismatch"],
    ["pvcFilling", "< 10% free", "SEV-2", "KubePersistentVolumeFillingUp", "Writes will start failing with no space left on device"],
  ], { height: 30 });
  r++;
  note(ws, r, 5, "All thresholds are overridable per customer via INCIDENT_THRESHOLDS (JSON) without a code change.", C.lightBlue, C.navy);
}

// ═══════════════════════════════ 5. NOISE CONTROL
{
  const ws = wb.addWorksheet("5. Noise Control", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 26 }, { width: 70 }, { width: 18 }, { width: 22 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Noise control: what makes autonomy credible",
    "Without these guards, enabling auto-ticketing on a real cluster creates an alert storm on the very first scan.", 4);
  r = headerRow(ws, r, ["Guard", "Purpose", "Default", "Configurable"]);
  r = dataRows(ws, r, [
    ["Dwell time", "A breach must be sustained before it counts — filters transient blips and normal rolling deploys", "per rule", "Yes (env JSON)"],
    ["Causal merge", "Every signal on one workload becomes ONE incident. Root cause chosen by precedence (OOM explains a crash loop, a crash loop explains zero-ready replicas); the rest are folded in as corroborating symptoms", "always on", "—"],
    ["Node cascade", "A NotReady node taking N pods with it becomes 1 incident with N symptoms, not N+1 tickets", "always on", "—"],
    ["Activity override", "A chronic-by-age condition that is STILL actively restarting is treated as a live incident. Static long-standing failures stay Problem candidates", "on", "Yes (UI)"],
    ["ServiceNow dedup", "Before creating, query ServiceNow for an OPEN incident with the same correlation_id and attach to it. Holds even if our own session store was lost", "always on", "—"],
    ["Escalation", "3+ recurrences raise severity one level and flag the condition for immediate attention — a returning fault is an unresolved root cause", "3 episodes", "Env"],
    ["Chronic guard", "Already broken longer than the window when first seen → Problem candidate, NOT a new Incident", "24 hours", "Yes (UI)"],
    ["Severity floor", "Only this severity or worse is eligible for unattended ticketing", "SEV-2", "Yes (UI)"],
    ["Rate limit", "Rolling ceiling on tickets per hour with a circuit breaker", "10 / hour", "Yes (UI)"],
    ["Workload signature", "The dedup key is the workload, not the rule — so it survives rollouts AND a changing mix of firing signals. No second ticket when the OOM window lapses but the crash loop continues", "always on", "—"],
    ["Recurrence gap", "“Recurring” means the condition cleared and returned — not that we polled again", "20 min", "Yes (env)"],
    ["Protected namespaces", "openshift-*, kube-system, kube-public, kube-node-lease, default are never auto-remediated", "always on", "—"],
    ["Self-heal confirmation", "Consecutive clear scans required before auto-closing, so flapping doesn't close early", "2 scans", "Yes (UI)"],
  ], { height: 38 });
  r++;
  r = note(ws, r, 4,
    "MEASURED ON THE LIVE LAB CLUSTER:  26 raw symptoms → 24 correlated detections → 23 chronic (Problem candidates) → 1 auto-ticket. The single ticket was the genuinely new failure.",
    C.lightGreen, C.darkGreen);
  note(ws, r, 4, "Without the chronic guard this cluster would have opened 24 tickets on the first scan — the difference between a demo that lands and one that doesn't.",
    C.lightAmber, C.darkAmber);
}

// ═══════════════════════════════ 6. REMEDIATION
{
  const ws = wb.addWorksheet("6. Remediation", { properties: { tabColor: { argb: "FF" + C.orange } } });
  ws.columns = [{ width: 34 }, { width: 52 }, { width: 12 }, { width: 13 }, { width: 44 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Remediation catalogue (one safe action per signal)",
    "Anything not listed escalates with the RCA and ticket already prepared. The system never guesses at a fix.", 5);
  r = headerRow(ws, r, ["Signal", "Automated action", "Risk", "Reversible", "Rationale"]);
  r = dataRows(ws, r, [
    ["CrashLoopBackOff / NotReady /\nZeroReady / ReplicaMismatch", "oc rollout restart <workload>", "low", "n/a", "Recreating the pods is the standard first response. Nothing to revert — the spec was never modified."],
    ["OOMKilled", "oc set resources --limits=memory (DOUBLED)", "medium", "YES — ledgered", "A bare restart just repeats the kill. The limit is doubled from the observed value. The prior limit is captured at apply time, so this is revertable with one click."],
    ["PVC filling up", "oc patch pvc — expand +50%", "medium", "NO", "StorageClass allowVolumeExpansion is validated first. Kubernetes cannot shrink a PVC, so this is one-way."],
    ["Node NotReady", "none — escalate", "—", "—", "Node recovery is an infrastructure decision, not a safe automated action."],
    ["Cluster operator degraded", "none — escalate", "—", "—", "Platform components require human judgement."],
    ["PVC Pending", "none — escalate", "—", "—", "Requires a provisioner or PV decision."],
    ["ImagePullBackOff", "none — escalate", "—", "—", "Needs the correct image or pull secret — cannot be inferred safely."],
  ], { height: 44 });
  r++;
  note(ws, r, 5, "Every action is guardrail-classified, dry-run against the live API server, and applied only after explicit human approval.", C.lightCyan, "155E75");
}

// ═══════════════════════════════ 7. AI RCA
{
  const ws = wb.addWorksheet("7. AI RCA", { properties: { tabColor: { argb: "FF" + C.aiPurple } } });
  ws.columns = [{ width: 30 }, { width: 92 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — AI root-cause analysis (evidence-grounded)",
    "Logs and events are attacker-influencable, so they are fenced as untrusted data — the model treats them as evidence, never as instructions.", 2);

  r = headerRow(ws, r, ["Evidence collected", "Detail"]);
  r = dataRows(ws, r, [
    ["Container logs", "Current AND the previous terminated instance — where a crash-looped container's useful output actually lives"],
    ["Warning events", "The object's own Kubernetes events, newest first"],
    ["Resource configuration", "Limits and requests per container"],
    ["Restart counts / exit codes", "Including termination reason (e.g. OOMKilled, exit 137)"],
    ["Pod state", "Phase, node placement, container states"],
    ["Known-error KB", "Pattern matches against the built-in error knowledge base, with the matched text"],
  ], { height: 30 });

  r++;
  r = headerRow(ws, r, ["AI output field", "Description"]);
  r = dataRows(ws, r, [
    ["rootCause", "One precise sentence naming the actual cause, citing the evidence"],
    ["category", "Memory Exhaustion · Application Bug · Configuration Error · Network Issue · …"],
    ["analysis", "3–5 sentences explaining WHAT is happening and WHY, referencing specific log lines or exit codes"],
    ["whyChain", "5-Whys causal chain from symptom to root"],
    ["contributingFactors", "What made the failure possible"],
    ["impact", "Who and what is affected"],
    ["investigationSteps", "How to confirm the diagnosis if it recurs"],
    ["preventiveActions", "CAPA items to stop recurrence — these lead the CAPA section"],
    ["confidence", "high / medium / low — set low when the evidence is thin"],
  ], { height: 30 });

  r++;
  note(ws, r, 2, "Bounded: 35s AI / 20s evidence soft timeouts. If the LLM is slow or not configured, the RCA still renders from the deterministic engine and states that explicitly — it never silently degrades.",
    C.lightAmber, C.darkAmber);
}

// ═══════════════════════════════ 8. RCA DOCUMENT
{
  const ws = wb.addWorksheet("8. RCA Document", { properties: { tabColor: { argb: "FF" + C.valCyan } } });
  ws.columns = [{ width: 34 }, { width: 88 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — RCA document (ITIL 4 · Google SRE · NIST SP 800-61)",
    "Written into the ServiceNow close notes on every incident and downloadable from the console.", 2);
  r = headerRow(ws, r, ["Delivery format", "Where it goes / purpose"]);
  r = dataRows(ws, r, [
    ["Plain text", "ServiceNow close_notes — the GUARANTEED record, always present even if attachments are blocked by policy"],
    ["HTML", "Attached to the incident, and served by “View RCA” in the console. Self-contained (no external CSS/fonts/images), responsive and print-ready"],
    ["PDF", "Attached to the incident for archival, e-mail and auditors who want a file rather than a link"],
  ], { height: 34 });
  r++;
  r = note(ws, r, 2, "Attachments are uploaded BEFORE the incident is closed — many ServiceNow configurations refuse attachments on closed records. Attachment is best-effort: a failure never costs the text record.", C.lightAmber, C.darkAmber);

  r = headerRow(ws, r, ["Section", "Contents"]);
  r = dataRows(ws, r, [
    ["1. Summary", "Title, severity, cluster, scope, and the threshold that detected it"],
    ["2. Impact", "Symptom count, correlation type, recurrence"],
    ["3. Timeline", "Condition began · detected · ticket raised · dry-run · approved · remediated · resolved — with computed MTTD / MTTA / MTTR"],
    ["4. Root cause", "Category, confidence, and provenance (AI vs deterministic)"],
    ["4.1 Detailed AI analysis", "3–5 sentences explaining why, citing evidence"],
    ["4.2 Impact assessment", "Service/user impact"],
    ["4.3 Causal chain", "5-Whys: symptom → … → root"],
    ["4.4 Contributing factors", "Conditions that enabled the failure"],
    ["4.5 Recommendation", "What to do about it"],
    ["5.1 Threshold observations", "What the detector saw, restarts, exit codes"],
    ["5.2 Resource configuration", "Limits and requests per container"],
    ["5.3 Log evidence", "Captured error lines, including from the previous instance"],
    ["5.4 Kubernetes events", "Warning events on the object"],
    ["5.5 Known-error matches", "KB entries matched, with the matching text and remediation"],
    ["5.6 Further investigation", "Steps if the issue recurs"],
    ["6. Resolution", "Action, command, rationale, approver, dry-run and apply output"],
    ["7. Verification", "Evidence the workload actually recovered"],
    ["8. CAPA", "Corrective and preventive actions — AI-proposed items first"],
    ["9. Notes", "Blameless review statement"],
  ], { height: 28 });
  r++;
  note(ws, r, 2, "Every incident closes with the same audit-grade document, regardless of who was on call — which is what auditors actually ask for.", C.lightGreen, C.darkGreen);
}

// ═══════════════════════════════ 9. SAFETY
{
  const ws = wb.addWorksheet("9. Safety", { properties: { tabColor: { argb: "FF" + C.secRed } } });
  ws.columns = [{ width: 30 }, { width: 78 }, { width: 20 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Safety model", "Autonomy is only acceptable if it is bounded, previewed, verified and auditable.", 3);
  r = headerRow(ws, r, ["Control", "Behaviour", "Default"]);
  r = dataRows(ws, r, [
    ["Two-flag interlock", "Detection (read-only) is separate from action. Detection can run safely with action disabled.", "detect ON / act OFF"],
    ["Shadow mode", "Shows exactly what WOULD be ticketed and remediated, raising nothing, until thresholds are trusted", "default state"],
    ["Mandatory dry-run", "Every fix is previewed against the live API server with ?dryRun=All before apply", "always"],
    ["Guardrail classification", "Commands are risk-classified; blocked commands never reach the cluster", "always"],
    ["Protected namespaces", "openshift-*, kube-*, default are refused outright", "always"],
    ["Verification gate", "If the fix cannot be verified the incident is ROLLED_BACK → ESCALATED and the ticket is left OPEN", "always"],
    ["No guessing", "Signals without a known-safe remediation escalate with the RCA rather than attempting something", "always"],
    ["Prompt-injection defense", "Logs and events are fenced with UNTRUSTED_GUARD so they are treated as data, never instructions", "always"],
    ["Bounded AI", "35s AI / 20s evidence soft timeouts; degrades to the deterministic RCA and says so", "always"],
    ["Ticket storm brake", "Rolling per-hour ceiling with a circuit breaker", "10 / hour"],
    ["Idempotency", "One live incident per signature; duplicates are refused", "always"],
    ["Full audit trail", "Every state transition is written to the audit log with actor and command", "always"],
  ], { height: 34 });
  r++;
  note(ws, r, 3, "NEVER A FALSE SUCCESS: an unverified fix escalates and leaves the ticket open. The system would rather admit uncertainty than close a ticket it cannot justify.",
    C.lightRed, "991B1B");
}

// ═══════════════════════════════ 10. BUSINESS VALUE
{
  const ws = wb.addWorksheet("10. Business Value", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 34 }, { width: 46 }, { width: 46 }, { width: 22 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Business value: where the time goes back", "The target is the administrative load, not the engineering judgement.", 4);
  r = headerRow(ws, r, ["Metric", "Manual today", "UC-05 Zero-Touch", "Effect"]);
  r = dataRows(ws, r, [
    ["Detection → ticket raised", "Minutes to hours — a human must notice first", "Seconds, with no human involved", "MTTD collapses"],
    ["RCA authoring", "20–60 min hand-written; quality varies by engineer", "Automatic, grounded in real logs and events", "Consistency + hours saved"],
    ["Ticket closure", "Manual and frequently deferred", "Automatic, with the RCA attached", "Pure toil removed"],
    ["Self-resolved conditions", "Stale tickets a human must notice and close", "Self-closing, marked self-healed", "Queue stays clean"],
    ["Duplicate tickets", "One node failure becomes many tickets", "Deduped by stable signature; correlated into one", "Less noise"],
    ["Human touchpoints", "Approximately 6 per incident", "1 — approve the fix", "~83% fewer"],
    ["Audit evidence", "Inconsistent between engineers and incidents", "Same standard RCA on every incident", "Audit-ready by default"],
    ["Escalation quality", "Handover often lacks context", "RCA and ticket already prepared before a human sees it", "Faster human resolution"],
  ], { height: 34 });
  r++;
  note(ws, r, 4, "THE DIFFERENTIATOR: other automation stops at “alert raised”. UC-05 also writes the RCA and closes the ticket — the part every other tool leaves on the human.",
    C.lightGreen, C.darkGreen);
}

// ═══════════════════════════════ 11. DEMO SCRIPT
{
  const ws = wb.addWorksheet("11. Demo Script", { properties: { tabColor: { argb: "FF" + C.userAmber } } });
  ws.columns = [{ width: 6 }, { width: 40 }, { width: 74 }, { width: 14 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Demo script", "Run in shadow mode first, then enable autonomous action for the live portion.", 4);
  r = headerRow(ws, r, ["#", "Action", "What to say", "Duration"]);
  r = dataRows(ws, r, [
    ["1", "Open AI Intelligence → Auto-Detect", "“Nobody asked for this. The platform found 24 issues on its own and correlated 26 raw symptoms into them.”", "20s"],
    ["2", "Point at CHRONIC 23 / AUTO-TICKET ELIGIBLE 1", "“It refuses to page for things that have been broken ten days. That restraint is what makes it trustworthy.”", "30s"],
    ["3", "Toggle the Actionable / Chronic filter", "“One actionable item, not 24 — the queue tells the truth instead of burying it.”", "20s"],
    ["4", "Open ⚙ Automation Settings", "“The autonomous switch, the ServiceNow queue and every threshold are configurable here — no redeploy.”", "30s"],
    ["4", "Break something live (bad image or tight memory limit)", "“Let's create a genuinely new failure — the only kind that should page.”", "30s"],
    ["5", "Wait one detection cycle (2 min)", "“No one is typing. The loop is scanning.”", "2 min"],
    ["6", "Incident appears — auto-raised", "“There's the ServiceNow number and the ITIL priority. Nobody opened this.”", "20s"],
    ["7", "Read the AI RCA on the card", "“Category, confidence, the causal chain, and real log lines from the failed container.”", "40s"],
    ["8", "Click ▷ Dry-run", "“Previewed against the live API server. Nothing has changed yet.”", "20s"],
    ["9", "Click ✅ Apply Fix", "“One click. Watch the terminal transcript and the BEFORE/AFTER container table — that is evidence, not a claim.”", "45s"],
    ["10", "Open the incident in ServiceNow", "“Full RCA in the close notes — AND the HTML and PDF reports attached to the ticket itself.”", "40s"],
    ["11", "Show History — applied changes", "“Here is every change we made, with a before → after diff and a one-click revert that dry-runs first.”", "40s"],
    ["12", "Optional: let one self-heal", "“This one fixed itself. The platform noticed and closed its own ticket.”", "30s"],
  ], { height: 38 });
  r++;
  note(ws, r, 4, "Closing line: “The only decision a human made in that entire lifecycle was whether to apply the fix — and even that is reversible.”", C.lightAmber, C.darkAmber);
}

// ═══════════════════════════════ 12. CONFIG
{
  const ws = wb.addWorksheet("12. Configuration", { properties: { tabColor: { argb: "FF" + C.slate } } });
  ws.columns = [{ width: 34 }, { width: 40 }, { width: 22 }, { width: 16 }, { width: 40 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Configuration & rollout", "Everything an operator needs to tune is editable in the UI and persisted — no pod restart.", 5);
  r = headerRow(ws, r, ["Setting", "Environment variable", "Default", "UI editable", "Notes"]);
  r = dataRows(ws, r, [
    ["Detection on/off", "INCIDENT_AUTO_DETECT", "true (read-only)", "Yes", "Safe to leave on — never mutates anything"],
    ["Autonomous action", "INCIDENT_AUTO_ACT", "false", "Yes", "The master interlock. Enable only after a shadow-mode cycle"],
    ["ServiceNow assignment group", "SERVICENOW_ASSIGNMENT_GROUP", "instance default", "Yes", "The admin queue. Verified against sys_user_group on save"],
    ["Chronic window (hours)", "INCIDENT_CHRONIC_HOURS", "24", "Yes", "Older than this when first seen → Problem candidate"],
    ["Severity floor", "INCIDENT_AUTO_SEVERITY_FLOOR", "SEV-2", "Yes", "Only this severity or worse is auto-ticketed"],
    ["Ticket rate limit", "INCIDENT_MAX_TICKETS_PER_HOUR", "10", "Yes", "Storm brake with circuit breaker"],
    ["Self-heal confirm scans", "INCIDENT_SELFHEAL_SCANS", "2", "Yes", "Consecutive clear scans before auto-closing"],
    ["Activity beats age", "INCIDENT_CHRONIC_ACTIVITY_OVERRIDE", "true", "Yes", "A still-restarting workload is live even if it is old"],
    ["Attach RCA (HTML + PDF)", "INCIDENT_ATTACH_RCA / _PDF", "true", "Yes", "Uploaded to the incident before it is closed"],
    ["Auto-close duplicates", "INCIDENT_AUTO_CLOSE_DUPLICATES", "false", "Yes", "Only ever closes tickets THIS platform raised"],
    ["Escalate after N recurrences", "INCIDENT_ESCALATE_AFTER", "3", "No", "Raises severity one level and flags the condition"],
    ["Restart-rate window", "INCIDENT_RESTART_WINDOW_MINUTES", "15", "No", "Window for the rate-based crashloop trigger"],
    ["Change-ledger retention", "CHANGE_LEDGER_RETENTION_DAYS", "90", "No", "How long applied changes stay revertable in the ledger"],
    ["Duplicate close code", "SERVICENOW_DUPLICATE_CLOSE_CODE", "Duplicate", "No", "Choice-list value varies by ServiceNow instance"],
    ["Scan interval", "INCIDENT_POLL_INTERVAL_MS", "120000 (2 min)", "No", "Background detection loop cadence"],
    ["Recurrence gap", "INCIDENT_RECURRENCE_GAP_MINUTES", "20", "No", "Absence required before a return counts as recurrence"],
    ["Threshold overrides", "INCIDENT_THRESHOLDS (JSON)", "mixin defaults", "No", "Per-customer threshold tuning"],
    ["CMDB CI reference", "SERVICENOW_SET_CMDB_CI", "false", "No", "Opt-in: an unresolvable CI reference can fail the insert"],
  ], { height: 32 });

  r++;
  r = headerRow(ws, r, ["Rollout step", "Action", "Why", "", ""]);
  r = dataRows(ws, r, [
    ["1. Shadow", "Deploy with autonomous action OFF; watch Auto-Detect for one cycle", "Confirms the chronic/eligible split matches expectations on the real cluster", "", ""],
    ["2. Tune", "Adjust chronic window, severity floor and thresholds from the Settings panel", "Thresholds are the product — tune against real traffic, not assumptions", "", ""],
    ["3. Queue", "Set the ServiceNow assignment group and save (it is verified)", "Guarantees incidents land in a human-owned queue", "", ""],
    ["4. Enable", "Turn on autonomous action", "Tickets now raise and self-close without a human", "", ""],
    ["5. Observe", "Watch the first real auto-raise and close end to end", "Validates the ServiceNow integration against the live instance", "", ""],
  ], { height: 34 });
}

// ═══════════════════════════════ 13. VERIFICATION
{
  const ws = wb.addWorksheet("13. Verification", { properties: { tabColor: { argb: "FF" + C.valCyan } } });
  ws.columns = [{ width: 44 }, { width: 74 }, { width: 18 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Verification status", "Honest separation between what has been proven and what still needs live validation.", 3);
  r = headerRow(ws, r, ["Scenario", "Expected behaviour", "Status"]);
  r = dataRows(ws, r, [
    ["Node cascade correlation", "4 crash-looping pods on a NotReady node collapse into 1 incident (6 duplicate tickets avoided)", "VERIFIED"],
    ["Causal merge", "OOMKilled + CrashLoopBackOff + ZeroReadyReplicas on one workload become 1 incident with OOM as root cause", "VERIFIED"],
    ["Signature stability", "The signature is unchanged when the OOM window lapses and only the crash loop remains — no second ticket", "VERIFIED"],
    ["Restart-rate detection", "A container that is Running at scan time but gained 4 restarts IS detected (previously missed entirely)", "VERIFIED"],
    ["Activity override", "A static 10-day failure stays chronic while a 6-day failure still restarting becomes a live incident", "VERIFIED"],
    ["Escalation", "Fires exactly on the 3rd episode with SEV-2 → SEV-1, not on the 1st or 2nd", "VERIFIED"],
    ["Duplicate asymmetry", "Our duplicate is linked and closed; the human-raised ticket is linked and work-noted but never closed", "VERIFIED"],
    ["Attachment degradation", "An attachment failure is recorded and the close still proceeds with the text RCA intact", "VERIFIED"],
    ["Ledger inverse", "Correct revertable/not-revertable verdict and inverse command for all four action classes", "VERIFIED"],
    ["Revert chain", "The revert is recorded as its own entry and links both ways to the original, with correct stats", "VERIFIED"],
    ["Native rollout undo", "Restores the prior revision with the pod-template-hash stripped; refuses aged-out revisions and non-Deployments", "VERIFIED"],
    ["PDF generation", "Renders to a valid %PDF- buffer with all ten sections", "VERIFIED"],
    ["Breadth escalation", "The same fault across 3 replicas escalates SEV-3 → SEV-2", "VERIFIED"],
    ["Sub-dwell blip", "A 2-minute crash loop does NOT fire", "VERIFIED"],
    ["Rolling deploy", "An in-progress rollout does NOT fire", "VERIFIED"],
    ["Chronic guard", "10-day-old failures excluded; a fresh 20-minute failure is the only auto-ticket", "VERIFIED"],
    ["Recurrence semantics", "4 consecutive scans of one flat outage keep occurrences at 1", "VERIFIED"],
    ["Workload name derivation", "ReplicaSet hash stripped correctly across 9 real-world names; real words preserved", "VERIFIED"],
    ["Happy path", "Reaches AWAITING_APPROVAL, then closes with the ticket resolved and RCA attached", "VERIFIED"],
    ["Dry-run ordering", "Dry-run provably precedes apply", "VERIFIED"],
    ["Failed verification", "Rolls back, escalates, and does NOT close the ticket", "VERIFIED"],
    ["No-safe-fix escalation", "Node NotReady escalates rather than guessing", "VERIFIED"],
    ["Protected namespaces", "Refused outright", "VERIFIED"],
    ["Idempotent promotion", "The same signature never opens a second incident", "VERIFIED"],
    ["Self-heal", "Requires 2 confirming clear scans, then closes with RCA", "VERIFIED"],
    ["Live settings", "Autonomous toggle and rate limit apply without a restart", "VERIFIED"],
    ["OOMKilled remediation", "Memory doubled from the real limit; applies, verifies and closes", "VERIFIED"],
    ["ServiceNow auto-raise (live)", "First real incident created in the customer instance", "PENDING LIVE"],
    ["RCA attachment upload (live)", "HTML + PDF land on the ticket in the customer instance", "PENDING LIVE"],
    ["ServiceNow auto-close (live)", "First real closure with RCA in close notes", "PENDING LIVE"],
    ["AI RCA depth (live)", "Depends on the configured LLM being reachable from the pod", "PENDING LIVE"],
  ], { height: 30 });
  r++;
  note(ws, r, 3, "Verified items were exercised with automated harnesses against synthetic clusters matching the live cluster's shape. Items marked PENDING LIVE require the customer's ServiceNow instance and LLM endpoint.",
    C.lightAmber, C.darkAmber);
}

// ═══════════════════════════════ 14. IMPLEMENTATION
{
  const ws = wb.addWorksheet("14. Implementation", { properties: { tabColor: { argb: "FF" + C.navy } } });
  ws.columns = [{ width: 44 }, { width: 52 }, { width: 52 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Implementation map", "Where each capability lives in the codebase.", 3);
  r = headerRow(ws, r, ["Component", "File", "Responsibility"]);
  r = dataRows(ws, r, [
    ["Threshold evaluator + correlation", "src/services/incident-detector.js", "Evaluates thresholds, correlates symptoms, fingerprints signatures, classifies chronic/recurring"],
    ["Lifecycle orchestrator", "src/services/incident-orchestrator.js", "State machine, evidence gathering, AI RCA, remediation planning, verification, self-heal, ticket closure"],
    ["Runtime policy", "src/services/incident-settings.js", "UI-configurable settings persisted to DB/file and applied live"],
    ["Execution engine", "src/services/fix-executor.js", "Dry-run and apply via the Kubernetes API (no shell)"],
    ["Risk classification", "src/services/guardrails.js", "Classifies commands; blocks the dangerous ones"],
    ["Known-error knowledge base", "src/services/error-knowledge.js", "Pattern library matched against real logs and events"],
    ["Deterministic RCA engine", "src/tools/rca-engine.js", "Causal-chain analysis used as the AI's grounding and fallback"],
    ["Injection defense", "src/services/untrusted.js", "Fences untrusted log/event content before it reaches the model"],
    ["ServiceNow client", "src/utils/servicenow-client.js", "Incident create/resolve/update, attachments, ITIL fields"],
    ["Audit log", "src/services/audit-log.js", "Records every state transition"],
    ["Background loop", "src/index.js (pollIncidentDetections)", "2-minute detect → self-heal → auto-promote cycle"],
    ["Console UI", "console/src/views/IntelligenceView.jsx", "Auto-Detect tab, Approval Inbox, Automation Settings"],
  ], { height: 36 });
}


// ═══════════════════════════════ 15. DEDUPLICATION
{
  const ws = wb.addWorksheet("15. Deduplication", { properties: { tabColor: { argb: "FF" + C.valCyan } } });
  ws.columns = [{ width: 6 }, { width: 26 }, { width: 74 }, { width: 24 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — One fault = one ticket",
    "Three independent layers prevent duplicates, plus deliberately asymmetric handling of tickets we did not raise.", 4);

  r = headerRow(ws, r, ["#", "Layer", "How it works", "Scope"]);
  r = dataRows(ws, r, [
    ["1", "Causal merge", "A workload that is OOMKilled AND crash-looping AND at 0/1 replicas is ONE incident. The root cause is chosen by precedence (oomKilled > imagePull > podPending > crashLoop > podNotReady > zeroReady > replicaMismatch) and the remaining signals are folded in as corroborating symptoms.", "Per workload"],
    ["2", "Workload signature", "The dedup key is the workload (wl:<namespace>:<workload>), not the rule. That keeps it stable across rollouts AND across a changing mix of firing signals — so no second ticket appears when the OOM window lapses but the crash loop continues.", "Per workload"],
    ["3", "ServiceNow correlation_id", "Before creating anything we query ServiceNow for an OPEN incident carrying the same correlation_id and ATTACH to it instead. This is authoritative: it holds even when our own session store was lost to a pod restart or an unavailable database — exactly when duplicates used to slip through.", "Cross-restart"],
  ], { height: 62 });

  r++;
  r = headerRow(ws, r, ["", "When duplicates already exist", "Behaviour", "Setting"]);
  r = dataRows(ws, r, [
    ["A", "Tickets WE raised", "Linked as children of the primary (parent_incident), then closed with close_code Duplicate pointing at the primary. The full RCA lands on the primary only — duplicating nine sections across five tickets is noise.", "autoCloseDuplicates (default OFF)"],
    ["B", "Tickets a HUMAN raised", "Linked and given a work note asking for review — but NEVER closed automatically. They may contain context a person added that we would destroy.", "Always — no setting"],
    ["C", "Backlog from before dedup", "A reconcile sweep finds every open incident this platform raised, groups them by correlation_id, designates the oldest as primary and reports the groups. GET is read-only so the operator inspects first; POST applies.", "One-click in the UI"],
  ], { height: 52 });

  r++;
  r = note(ws, r, 4,
    "RATIONALE: we clean up our own output automatically, but never close a person's ticket without permission. That asymmetry is what makes the automation safe to trust.",
    C.lightCyan, "155E75");
  note(ws, r, 4,
    "Verified call order with a stubbed ServiceNow: create primary → link ours → close ours as Duplicate → link human → work-note human → resolve primary with the RCA. The human-raised ticket is provably never closed.",
    C.lightGreen, C.darkGreen);
}

// ═══════════════════════════════ 16. ESCALATION
{
  const ws = wb.addWorksheet("16. Escalation", { properties: { tabColor: { argb: "FF" + C.secRed } } });
  ws.columns = [{ width: 30 }, { width: 78 }, { width: 22 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Escalation: repeat offenders",
    "A fault that keeps coming back is not another SEV-3; it is an unresolved root cause, which ITIL puts in Problem management.", 3);

  r = headerRow(ws, r, ["Mechanism", "Behaviour", "Default"]);
  r = dataRows(ws, r, [
    ["Recurrence definition", "An episode counts only when the condition CLEARED (absent from scans for longer than the recurrence gap) and then returned. A continuously-present condition stays occurrence #1 no matter how often we poll — otherwise a 2-minute poll would report 30x recurring after an hour of one flat outage.", "20-minute gap"],
    ["Escalation trigger", "At this many episodes the detection is flagged escalated and its severity is raised one level (e.g. SEV-2 → SEV-1), which can also lift it above the auto-ticket severity floor.", "3 episodes"],
    ["Console treatment", "A prominent Escalations block sits ABOVE the approval inbox and the detection list, showing each repeat offender with its occurrence count, the severity change, and direct Open Incident / Ask AI actions. Cards also carry an “escalated Nx” badge.", "always on"],
    ["Recommended response", "Raise a Problem record rather than closing another Incident. The RCA already carries a CAPA section, and recurrence is called out there explicitly.", "guidance"],
    ["Activity override (related)", "Separately, a condition that is chronic BY AGE but still actively restarting is reclassified as a live incident — churning is not the same as stale.", "on"],
  ], { height: 60 });

  r++;
  r = headerRow(ws, r, ["Episode", "Occurrences", "Result"]);
  r = dataRows(ws, r, [
    ["1st", "1", "SEV-2 — normal handling"],
    ["2nd", "2", "SEV-2 — normal handling"],
    ["3rd", "3", "ESCALATED → SEV-1, flagged for immediate attention"],
    ["4th+", "4+", "Remains escalated; escalation level increases with each multiple of the threshold"],
  ], { height: 26 });
  r++;
  note(ws, r, 3, "Verified: escalation triggers exactly on the 3rd episode with SEV-2 → SEV-1, and does not fire on the 1st or 2nd.", C.lightGreen, C.darkGreen);
}

// ═══════════════════════════════ 17. CHANGE LEDGER & REVERT
{
  const ws = wb.addWorksheet("17. Change Ledger", { properties: { tabColor: { argb: "FF" + C.orange } } });
  ws.columns = [{ width: 28 }, { width: 30 }, { width: 72 }];
  let r = banner(ws, "TCS Agentic AI · ZTIC — Change Ledger & Revert",
    "Every mutation the automation applied, with a precomputed inverse — surfaced as “History — applied changes” once an incident is fixed.", 3);

  r = note(ws, r, 3,
    "THE KEY DESIGN DECISION: the inverse is computed and stored AT APPLY TIME, not at revert time. Once memory has been patched from 389Mi to 778Mi the old value is gone from the live object — it can only be restored if it was captured beforehand.",
    C.lightAmber, C.darkAmber);

  r = headerRow(ws, r, ["Action", "Revertable?", "Why"]);
  r = dataRows(ws, r, [
    ["increase_memory", "YES — exact inverse patch", "The prior limit and container name are captured while the fix is planned, so the exact inverse command can be built and stored."],
    ["rollout_restart", "No — nothing to revert", "A rolling restart changes no configuration; only the pods were recreated. A revert button here would be meaningless."],
    ["expand_pvc", "No — physically impossible", "Kubernetes cannot shrink a PersistentVolumeClaim. Expansion is one-way; reducing capacity means migrating the data to a smaller volume."],
    ["(no captured value)", "Native rollout undo offered", "Falls back to `oc rollout undo`, which restores the entire prior pod template from the retained ReplicaSet revision."],
  ], { height: 44 });

  r++;
  r = headerRow(ws, r, ["Field recorded", "Purpose", "Detail"]);
  r = dataRows(ws, r, [
    ["what / where", "Identify the target", "cluster, namespace, resource kind, resource name, container"],
    ["action + command", "What ran", "The exact command that was applied"],
    ["beforeValue / afterValue", "The diff", "e.g. containers.mlflow.limits.memory: 389Mi → 778Mi — rendered as a red/green diff in the UI"],
    ["revertCommand", "The undo", "Precomputed inverse, stored at apply time"],
    ["nativeUndo", "Fallback undo", "The equivalent `oc rollout undo` command"],
    ["revertable + revertReason", "Honesty", "When it cannot be reverted, the reason is shown instead of a button that would lie"],
    ["provenance", "Audit", "sessionId, signature, incident number, who approved it, timestamps"],
    ["evidence", "Proof", "dry-run output, apply output, verification result, before/after container snapshots"],
    ["revertOf", "The chain", "Set when this entry IS a revert — so the ledger is a complete chain and a revert can itself be reverted"],
  ], { height: 32 });

  r++;
  r = headerRow(ws, r, ["Revert governance", "Behaviour", ""]);
  r = dataRows(ws, r, [
    ["Guardrail classification", "The revert command is risk-classified before anything runs; blocked commands never reach the cluster.", ""],
    ["Mandatory dry-run", "A dry-run is ALWAYS executed first, even when the caller asked to apply — an unverified revert turns one incident into two.", ""],
    ["Verification", "The same workload health check used for a fix confirms the revert actually took effect.", ""],
    ["Incident work note", "A work note is posted to the originating incident (usually already closed) so the audit trail stays followable.", ""],
    ["Protected namespaces", "openshift-*, kube-*, default are refused — revert those manually.", ""],
    ["Audit log", "Every revert is written to the audit log with the actor, command and verification outcome.", ""],
  ], { height: 34 });

  r++;
  r = note(ws, r, 3,
    "WHY NOT ALWAYS `oc rollout undo`? Undo restores the ENTIRE prior pod template and would silently discard any unrelated change someone made since. The inverse patch undoes exactly what we did and nothing else. Native undo (and `rollout history`) are both implemented and available where no before-value was captured.",
    C.lightPurple, "5B21B6");
  note(ws, r, 3,
    "Verified: inverse computation for all four action classes; the ledger records and the revert chain links both ways with correct stats; `rollout undo` restores the prior revision with the controller-managed pod-template-hash stripped, and correctly refuses aged-out revisions and non-Deployment kinds. Caveat: without PostgreSQL the ledger is in-memory and lost on pod restart.",
    C.lightGreen, C.darkGreen);
}

wb.xlsx.writeFile(OUT).then(() => console.log("✅ XLSX written:", OUT));
