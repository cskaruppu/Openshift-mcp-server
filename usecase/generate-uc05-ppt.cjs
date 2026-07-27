/**
 * TCS Agentic AI — UC-05: Zero-Touch Incident Command
 * Generates: usecase/TCS_Agentic_AI_UC05_Zero_Touch_Incident_Command.pptx
 *
 * Run: node usecase/generate-uc05-ppt.cjs
 */
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "TCS_Agentic_AI_UC05_Zero_Touch_Incident_Command.pptx");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const pptx = new PptxGenJS();
pptx.author = "TCS Agentic AI Platform";
pptx.title = "TCS Agentic AI — UC-05: Zero-Touch Incident Command";
pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5

// Palette aligned with the master deck
const C = {
  darkNavy: "0F172A", navy: "1E293B", tcsBlue: "2563EB", lBlue: "DBEAFE", pBlue: "EFF6FF",
  aiPurple: "7C3AED", lPurple: "EDE9FE",
  autoGreen: "059669", lGreen: "D1FAE5",
  userAmber: "D97706", lAmber: "FEF3C7",
  valCyan: "0891B2", lCyan: "CFFAFE",
  secRed: "DC2626", lRed: "FEE2E2",
  orange: "EA580C", lOrange: "FFEDD5",
  slate: "64748B", lSlate: "F1F5F9",
  white: "FFFFFF", textMed: "475569",
};

const F = "Inter";

/** Standard slide header. */
function head(s, kicker, title, sub) {
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.9, fill: { color: C.darkNavy } });
  s.addText(kicker, { x: 0.45, y: 0.12, w: 4, h: 0.25, fontSize: 10, color: C.valCyan, bold: true, charSpacing: 1.5, fontFace: F });
  s.addText(title, { x: 0.45, y: 0.34, w: 9.6, h: 0.45, fontSize: 22, color: C.white, bold: true, fontFace: F });
  s.addText("UC-05", { x: 11.9, y: 0.28, w: 1.1, h: 0.36, fontSize: 13, color: C.white, bold: true, align: "center", fontFace: F,
    fill: { color: C.tcsBlue }, rectRadius: 0.05 });
  if (sub) s.addText(sub, { x: 0.45, y: 1.0, w: 12.4, h: 0.3, fontSize: 12, color: C.textMed, fontFace: F });
}

function box(s, { x, y, w, h, fill, line, text, sub, tColor, fs = 12, bold = true }) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: line, width: 1.25 }, rectRadius: 0.08 });
  s.addText(text, { x, y: sub ? y + 0.1 : y, w, h: sub ? h * 0.55 : h, fontSize: fs, bold, color: tColor || C.navy, align: "center", valign: "middle", fontFace: F });
  if (sub) s.addText(sub, { x, y: y + h * 0.5, w, h: h * 0.42, fontSize: 9, color: C.textMed, align: "center", valign: "middle", fontFace: F });
}

function arrow(s, x, y, w = 0.32) {
  s.addText("▶", { x, y, w, h: 0.3, fontSize: 12, color: C.slate, align: "center", valign: "middle", fontFace: F });
}

function table(s, rows, opts = {}) {
  s.addTable(rows, {
    x: opts.x ?? 0.45, y: opts.y ?? 1.45, w: opts.w ?? 12.4,
    colW: opts.colW,
    border: { type: "solid", color: "CBD5E1", pt: 0.5 },
    fontSize: opts.fontSize ?? 10.5, fontFace: F, valign: "middle",
    autoPage: false,
  });
}
function hdr(cells) {
  return cells.map((t) => ({ text: t, options: { bold: true, color: C.white, fill: { color: C.navy }, fontSize: 10.5 } }));
}

// ───────────────────────────────────────────── 1. TITLE
{
  const s = pptx.addSlide();
  s.background = { color: C.darkNavy };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 3.05, w: 13.33, h: 0.045, fill: { color: C.tcsBlue } });
  s.addText("USE CASE 05", { x: 0.8, y: 1.75, w: 6, h: 0.3, fontSize: 13, color: C.valCyan, bold: true, charSpacing: 3, fontFace: F });
  s.addText("Zero-Touch Incident Command", { x: 0.8, y: 2.1, w: 11.6, h: 0.85, fontSize: 42, color: C.white, bold: true, fontFace: F });
  s.addText("Self-detecting · Self-documenting · Self-closing incident lifecycle for OpenShift",
    { x: 0.8, y: 3.25, w: 11.6, h: 0.4, fontSize: 16, color: "94A3B8", fontFace: F });
  s.addText("“Nobody opens the ticket.  Nobody writes the RCA.  Nobody closes it.”",
    { x: 0.8, y: 3.85, w: 11.6, h: 0.4, fontSize: 15, color: C.lAmber, italic: true, fontFace: F });

  const stats = [
    { v: "1", l: "Human touchpoint" }, { v: "0", l: "Human triggers" },
    { v: "12", l: "Standard thresholds" }, { v: "15", l: "Lifecycle states" }, { v: "9", l: "RCA sections" },
  ];
  stats.forEach((st, i) => {
    const x = 0.8 + i * 2.42;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 4.7, w: 2.2, h: 1.15, fill: { color: C.navy }, line: { color: "334155", width: 1 }, rectRadius: 0.06 });
    s.addText(st.v, { x, y: 4.82, w: 2.2, h: 0.5, fontSize: 26, bold: true, color: C.valCyan, align: "center", fontFace: F });
    s.addText(st.l, { x, y: 5.32, w: 2.2, h: 0.3, fontSize: 9.5, color: "94A3B8", align: "center", fontFace: F });
  });
  s.addText("TCS Agentic AI for OpenShift  ·  Autonomous ITSM / AIOps", { x: 0.8, y: 6.35, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", fontFace: F });
}

// ───────────────────────────────────────────── 2. THE PROBLEM
{
  const s = pptx.addSlide();
  head(s, "THE PROBLEM", "Most incident effort is administration, not engineering");
  const items = [
    { t: "Humans are the trigger", d: "Nothing happens until an SRE notices. Detection latency is human latency.", c: C.secRed, bg: C.lRed },
    { t: "RCAs are hand-written", d: "20–60 minutes of typing per incident — and quality varies by who was on call.", c: C.orange, bg: C.lOrange },
    { t: "Closing the ticket is toil", d: "Pure administration. Teams spend hours a week closing tickets nobody disputes.", c: C.userAmber, bg: C.lAmber },
    { t: "Self-resolved = stale tickets", d: "Conditions that fix themselves still need a human to notice and close.", c: C.aiPurple, bg: C.lPurple },
    { t: "Duplicates everywhere", d: "One node failure becomes twenty tickets. Correlation is manual.", c: C.tcsBlue, bg: C.lBlue },
    { t: "Audit gaps", d: "Evidence rarely captured consistently; auditors find holes.", c: C.slate, bg: C.lSlate },
  ];
  items.forEach((it, i) => {
    const x = 0.45 + (i % 3) * 4.18, y = 1.55 + Math.floor(i / 3) * 2.35;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.95, h: 2.05, fill: { color: it.bg }, line: { color: it.c, width: 1.25 }, rectRadius: 0.08 });
    s.addText(it.t, { x: x + 0.2, y: y + 0.18, w: 3.55, h: 0.4, fontSize: 13.5, bold: true, color: it.c, fontFace: F });
    s.addText(it.d, { x: x + 0.2, y: y + 0.62, w: 3.55, h: 1.25, fontSize: 10.5, color: C.navy, fontFace: F, valign: "top" });
  });
  s.addText("UC-01 answers when a human asks.  UC-05 has no human trigger at all — and closes its own tickets.",
    { x: 0.45, y: 6.45, w: 12.4, h: 0.4, fontSize: 12.5, bold: true, color: C.autoGreen, align: "center", fontFace: F });
}

// ───────────────────────────────────────────── 3. MASTER FLOW
{
  const s = pptx.addSlide();
  head(s, "WORKFLOW", "End-to-end flow — one human gate", "Detection is continuous and read-only; only the approval step involves a person.");

  const row1 = [
    { t: "Detect", d: "12 thresholds\n+ dwell time", f: C.lBlue, l: C.tcsBlue },
    { t: "Correlate", d: "N symptoms\n→ 1 incident", f: C.lBlue, l: C.tcsBlue },
    { t: "Triage", d: "evidence +\nAI RCA", f: C.lPurple, l: C.aiPurple },
    { t: "Raise INC", d: "ITIL priority\nadmin queue", f: C.lGreen, l: C.autoGreen },
    { t: "Plan fix", d: "deterministic\n+ guardrails", f: C.lPurple, l: C.aiPurple },
    { t: "Dry-run", d: "live API\n?dryRun=All", f: C.lCyan, l: C.valCyan },
  ];
  row1.forEach((b, i) => {
    const x = 0.45 + i * 2.09;
    box(s, { x, y: 1.75, w: 1.78, h: 1.0, fill: b.f, line: b.l, text: b.t, sub: b.d, fs: 12 });
    if (i < row1.length - 1) arrow(s, x + 1.79, 2.12, 0.28);
  });

  // Gate
  s.addShape(pptx.ShapeType.roundRect, { x: 3.6, y: 3.1, w: 6.1, h: 0.85, fill: { color: C.lAmber }, line: { color: C.userAmber, width: 2.5 }, rectRadius: 0.08 });
  s.addText("◀  AWAITING APPROVAL — THE ONLY HUMAN GATE  ▶", { x: 3.6, y: 3.1, w: 6.1, h: 0.85, fontSize: 14, bold: true, color: "92400E", align: "center", valign: "middle", fontFace: F });

  const row2 = [
    { t: "Apply", d: "execute fix", f: C.lGreen, l: C.autoGreen },
    { t: "Verify", d: "poll workload\nhealth", f: C.lCyan, l: C.valCyan },
    { t: "Resolve", d: "evidence\ncaptured", f: C.lGreen, l: C.autoGreen },
    { t: "Close + RCA", d: "ServiceNow\nclose notes", f: C.lGreen, l: C.autoGreen },
  ];
  row2.forEach((b, i) => {
    const x = 2.5 + i * 2.2;
    box(s, { x, y: 4.3, w: 1.9, h: 1.0, fill: b.f, line: b.l, text: b.t, sub: b.d, fs: 12 });
    if (i < row2.length - 1) arrow(s, x + 1.91, 4.67, 0.28);
  });

  // Exception lanes
  const lanes = [
    { t: "Self-healed → auto-closed", c: C.autoGreen, bg: C.lGreen },
    { t: "No safe fix → escalated (ticket ready)", c: C.orange, bg: C.lOrange },
    { t: "Not verified → rolled back, ticket stays OPEN", c: C.secRed, bg: C.lRed },
  ];
  lanes.forEach((l, i) => {
    const x = 0.45 + i * 4.18;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 5.6, w: 3.95, h: 0.55, fill: { color: l.bg }, line: { color: l.c, width: 1 }, rectRadius: 0.06 });
    s.addText(l.t, { x, y: 5.6, w: 3.95, h: 0.55, fontSize: 10.5, bold: true, color: l.c, align: "center", valign: "middle", fontFace: F });
  });
  s.addText("Everything before the gate is autonomous. Everything after the gate is autonomous.",
    { x: 0.45, y: 6.4, w: 12.4, h: 0.35, fontSize: 12, bold: true, color: C.navy, align: "center", fontFace: F });
}

// ───────────────────────────────────────────── 4. MANUAL vs ZERO-TOUCH
{
  const s = pptx.addSlide();
  head(s, "BEFORE / AFTER", "Six human touchpoints become one");
  const manual = ["SRE notices", "Open ticket", "Investigate", "Write RCA by hand", "Apply fix", "Verify", "Close ticket"];
  const auto = ["Auto-detected", "Auto-ticketed", "AI RCA", "APPROVE ✋", "Auto-applied", "Auto-verified", "Auto-closed + RCA"];

  s.addText("MANUAL TODAY", { x: 0.45, y: 1.5, w: 6, h: 0.3, fontSize: 13, bold: true, color: C.secRed, fontFace: F });
  manual.forEach((m, i) => {
    const y = 1.9 + i * 0.68;
    box(s, { x: 0.45, y, w: 5.6, h: 0.55, fill: (i === 3 || i === 6) ? C.lRed : "F8FAFC", line: (i === 3 || i === 6) ? C.secRed : "CBD5E1", text: `${i + 1}. ${m}`, fs: 11.5, bold: (i === 3 || i === 6) });
  });

  s.addText("UC-05 ZERO-TOUCH", { x: 7.28, y: 1.5, w: 6, h: 0.3, fontSize: 13, bold: true, color: C.autoGreen, fontFace: F });
  auto.forEach((m, i) => {
    const y = 1.9 + i * 0.68;
    const gate = i === 3;
    box(s, { x: 7.28, y, w: 5.6, h: 0.55, fill: gate ? C.lAmber : C.lGreen, line: gate ? C.userAmber : C.autoGreen, text: `${i + 1}. ${m}`, fs: 11.5, bold: gate, tColor: gate ? "92400E" : C.navy });
  });
  s.addText("Only step 4 needs a person", { x: 7.28, y: 6.65, w: 5.6, h: 0.3, fontSize: 11.5, bold: true, color: C.userAmber, align: "center", fontFace: F });
}

// ───────────────────────────────────────────── 5. THRESHOLDS
{
  const s = pptx.addSlide();
  head(s, "DETECTION", "Industry-standard thresholds", "Defaults come from kubernetes-mixin / kube-prometheus — the rules OpenShift already ships. Dwell time = the `for:` clause.");
  const rows = [hdr(["Rule", "Dwell", "Severity", "Industry standard"])];
  [
    ["crashLoop", "15m", "SEV-2", "KubePodCrashLooping"],
    ["oomKilled", "on event (30m window)", "SEV-2", "container OOMKilled"],
    ["zeroReady", "5m", "SEV-1", "KubeDeploymentReplicasMismatch (0 ready)"],
    ["replicaMismatch", "15m", "SEV-3", "KubeDeploymentReplicasMismatch"],
    ["podNotReady", "15m", "SEV-3", "KubePodNotReady"],
    ["podPending", "15m", "SEV-3", "KubePodNotScheduled"],
    ["imagePull", "10m", "SEV-3", "KubeContainerWaiting"],
    ["nodeNotReady", "5m", "SEV-1", "KubeNodeNotReady"],
    ["nodePressure", "10m", "SEV-3", "KubeNodeMemory/DiskPressure"],
    ["operatorDegraded", "10m", "SEV-2", "ClusterOperatorDegraded"],
    ["pvcPending", "15m", "SEV-3", "KubePersistentVolumeClaimPending"],
    ["pvcFilling", "<10% free", "SEV-2", "KubePersistentVolumeFillingUp"],
  ].forEach((r) => rows.push(r.map((t, i) => ({ text: t, options: { fontSize: 10, bold: i === 0, fill: { color: "FFFFFF" } } }))));
  table(s, rows, { y: 1.75, colW: [2.6, 2.4, 1.6, 5.8], fontSize: 10 });
}

// ───────────────────────────────────────────── 6. NOISE CONTROL
{
  const s = pptx.addSlide();
  head(s, "WHY IT'S SAFE", "Noise control — what makes autonomy credible", "Without these, enabling auto-ticketing on a real cluster creates a storm on the first scan.");
  const rows = [hdr(["Guard", "Purpose", "Default"])];
  [
    ["Dwell time", "Ignore transient blips and normal rolling deploys", "per rule"],
    ["Correlation", "A NotReady node taking N pods with it = 1 incident, not N+1", "always on"],
    ["Chronic guard", "Already broken >24h when first seen → Problem candidate, not an Incident", "24 hours"],
    ["Severity floor", "Only this severity or worse is auto-ticketed", "SEV-2"],
    ["Rate limit", "Rolling ceiling on tickets per hour + circuit breaker", "10 / hour"],
    ["Signature dedup", "One live incident per condition; stable across rollouts", "always on"],
    ["Recurrence gap", "“Recurring” = cleared then returned, not “polled again”", "20 min"],
    ["Protected namespaces", "openshift-*, kube-*, default never auto-remediated", "always on"],
  ].forEach((r) => rows.push(r.map((t, i) => ({ text: t, options: { fontSize: 10.5, bold: i === 0, fill: { color: "FFFFFF" } } }))));
  table(s, rows, { y: 1.8, colW: [2.9, 7.1, 2.4], fontSize: 10.5 });

  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 5.75, w: 12.4, h: 1.0, fill: { color: C.lGreen }, line: { color: C.autoGreen, width: 1.5 }, rectRadius: 0.08 });
  s.addText("Measured on the live lab cluster:  26 raw symptoms  →  24 correlated detections  →  23 chronic (Problem candidates)  →  1 auto-ticket",
    { x: 0.6, y: 5.85, w: 12.1, h: 0.4, fontSize: 13, bold: true, color: "065F46", align: "center", fontFace: F });
  s.addText("The single ticket was the genuinely new failure. That is the guard set doing its job.",
    { x: 0.6, y: 6.25, w: 12.1, h: 0.35, fontSize: 11, color: "047857", align: "center", italic: true, fontFace: F });
}

// ───────────────────────────────────────────── 7. AI RCA
{
  const s = pptx.addSlide();
  head(s, "AI ROOT-CAUSE ANALYSIS", "Evidence-grounded, not a label", "Logs and events are fenced as untrusted data — prompt-injection safe.");

  const ev = ["Container logs\n(incl. previous\nterminated instance)", "Warning events\non the object", "Resource limits\n& requests", "Restart counts\n& exit codes", "Known-error KB\nmatches"];
  ev.forEach((e, i) => {
    const x = 0.45 + i * 2.51;
    box(s, { x, y: 1.8, w: 2.32, h: 0.95, fill: C.pBlue, line: C.tcsBlue, text: e, fs: 9.5, bold: false });
  });
  s.addText("▼  fed to the LLM  ▼", { x: 0.45, y: 2.85, w: 12.4, h: 0.3, fontSize: 11, bold: true, color: C.aiPurple, align: "center", fontFace: F });

  const outp = [
    ["Root cause", "One precise sentence citing the evidence"],
    ["Category + confidence", "Memory Exhaustion / App Bug / … · high|medium|low"],
    ["Detailed analysis", "3–5 sentences explaining WHY, referencing log lines"],
    ["5-Whys causal chain", "Symptom → … → Root"],
    ["Contributing factors", "What made it possible"],
    ["Impact assessment", "Who/what is affected"],
    ["Investigation steps", "How to confirm if it recurs"],
    ["Preventive actions", "CAPA to stop recurrence"],
  ];
  outp.forEach((o, i) => {
    const x = 0.45 + (i % 2) * 6.28, y = 3.25 + Math.floor(i / 2) * 0.62;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 6.1, h: 0.52, fill: { color: C.lPurple }, line: { color: C.aiPurple, width: 1 }, rectRadius: 0.05 });
    s.addText(o[0], { x: x + 0.15, y, w: 2.1, h: 0.52, fontSize: 10.5, bold: true, color: "5B21B6", valign: "middle", fontFace: F });
    s.addText(o[1], { x: x + 2.25, y, w: 3.75, h: 0.52, fontSize: 9.5, color: C.navy, valign: "middle", fontFace: F });
  });

  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 6.05, w: 12.4, h: 0.75, fill: { color: C.lAmber }, line: { color: C.userAmber, width: 1.25 }, rectRadius: 0.06 });
  s.addText("Bounded: 35s AI / 20s evidence soft timeout. If the LLM is slow or absent the RCA still renders from the deterministic engine — and says so.",
    { x: 0.6, y: 6.05, w: 12.1, h: 0.75, fontSize: 11, color: "92400E", align: "center", valign: "middle", fontFace: F });
}

// ───────────────────────────────────────────── 8. RCA DOCUMENT
{
  const s = pptx.addSlide();
  head(s, "DELIVERABLE", "RCA document — ITIL 4 · Google SRE · NIST SP 800-61", "Written into the ServiceNow close notes and downloadable from the console.");
  const secs = [
    ["1. Summary", "Title, severity, cluster, scope, detecting threshold"],
    ["2. Impact", "Symptoms, correlation, recurrence"],
    ["3. Timeline", "With computed MTTD / MTTA / MTTR"],
    ["4. Root cause", "Category, confidence, provenance"],
    ["   4.1–4.5", "AI analysis · impact · 5-Whys · contributing factors · recommendation"],
    ["5. Evidence", "Threshold obs · resource config · log excerpts · events · KB matches"],
    ["6. Resolution", "Action, command, rationale, approver, dry-run + apply output"],
    ["7. Verification", "Proof the workload actually recovered"],
    ["8. CAPA", "AI-proposed preventive actions first"],
    ["9. Notes", "Blameless review statement"],
  ];
  secs.forEach((sec, i) => {
    const y = 1.75 + i * 0.5;
    const alt = i % 2 === 0;
    s.addShape(pptx.ShapeType.rect, { x: 0.45, y, w: 12.4, h: 0.44, fill: { color: alt ? "F8FAFC" : "FFFFFF" }, line: { color: "E2E8F0", width: 0.5 } });
    s.addText(sec[0], { x: 0.62, y, w: 2.6, h: 0.44, fontSize: 11, bold: true, color: C.tcsBlue, valign: "middle", fontFace: F });
    s.addText(sec[1], { x: 3.3, y, w: 9.4, h: 0.44, fontSize: 10.5, color: C.navy, valign: "middle", fontFace: F });
  });
  s.addText("Every incident closes with the same audit-grade document — regardless of who was on call.",
    { x: 0.45, y: 6.85, w: 12.4, h: 0.35, fontSize: 11.5, bold: true, color: C.autoGreen, align: "center", fontFace: F });
}

// ───────────────────────────────────────────── 9. REMEDIATION + SAFETY
{
  const s = pptx.addSlide();
  head(s, "REMEDIATION & SAFETY", "One safe action per signal — everything else escalates");
  const rows = [hdr(["Signal", "Automated action", "Risk", "Reversible"])];
  [
    ["CrashLoop / NotReady / ZeroReady / ReplicaMismatch", "rollout restart", "low", "yes"],
    ["OOMKilled", "set resources --limits=memory (DOUBLED, never a bare restart)", "medium", "yes"],
    ["PVC filling up", "patch pvc expand +50% (allowVolumeExpansion validated)", "medium", "NO"],
    ["Node NotReady · Operator Degraded · PVC Pending · ImagePull", "none — escalate to a human with RCA + ticket ready", "—", "—"],
  ].forEach((r) => rows.push(r.map((t, i) => ({ text: t, options: { fontSize: 10, bold: i === 0, fill: { color: "FFFFFF" } } }))));
  table(s, rows, { y: 1.65, colW: [4.5, 5.2, 1.3, 1.4], fontSize: 10 });

  const guards = [
    ["Two-flag interlock", "Detection (read-only) separate from action"],
    ["Shadow mode", "See what WOULD happen before granting autonomy"],
    ["Mandatory dry-run", "Every fix previewed with ?dryRun=All"],
    ["Verification gate", "Unverified → rolled back, ticket left OPEN"],
    ["Injection defense", "Logs fenced as data, never instructions"],
    ["Full audit trail", "Every state transition logged"],
  ];
  guards.forEach((g, i) => {
    const x = 0.45 + (i % 3) * 4.18, y = 4.2 + Math.floor(i / 3) * 1.15;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.95, h: 1.0, fill: { color: C.lCyan }, line: { color: C.valCyan, width: 1.25 }, rectRadius: 0.07 });
    s.addText(g[0], { x: x + 0.15, y: y + 0.1, w: 3.65, h: 0.35, fontSize: 11.5, bold: true, color: "155E75", fontFace: F });
    s.addText(g[1], { x: x + 0.15, y: y + 0.45, w: 3.65, h: 0.48, fontSize: 9.5, color: C.navy, fontFace: F, valign: "top" });
  });
  s.addText("Never a false success: if the fix cannot be verified, the incident escalates and the ticket stays open.",
    { x: 0.45, y: 6.6, w: 12.4, h: 0.35, fontSize: 11.5, bold: true, color: C.secRed, align: "center", fontFace: F });
}

// ───────────────────────────────────────────── 10. VALUE
{
  const s = pptx.addSlide();
  head(s, "BUSINESS VALUE", "Where the time actually goes back");
  const rows = [hdr(["Metric", "Manual today", "UC-05 Zero-Touch"])];
  [
    ["Detection → ticket raised", "Minutes to hours (a human must notice)", "Seconds — no human"],
    ["RCA authoring", "20–60 min hand-written, quality varies", "Automatic, evidence-grounded"],
    ["Ticket closure", "Manual, frequently deferred", "Automatic, with RCA attached"],
    ["Self-resolved conditions", "Stale tickets closed by hand later", "Self-closing, marked self-healed"],
    ["Duplicate tickets", "One node failure → many tickets", "Deduped by stable signature"],
    ["Human touchpoints", "≈ 6", "1 — approve the fix"],
    ["Audit evidence", "Inconsistent between engineers", "Same standard RCA every time"],
  ].forEach((r) => rows.push(r.map((t, i) => ({
    text: t, options: { fontSize: 10.5, bold: i === 0, color: i === 2 ? "065F46" : C.navy, fill: { color: i === 2 ? C.lGreen : "FFFFFF" } },
  }))));
  table(s, rows, { y: 1.7, colW: [3.6, 4.6, 4.2], fontSize: 10.5 });
  s.addText("The differentiator: other automation stops at “alert raised”. UC-05 also writes the RCA and closes the ticket.",
    { x: 0.45, y: 6.3, w: 12.4, h: 0.45, fontSize: 13, bold: true, color: C.autoGreen, align: "center", fontFace: F });
}

// ───────────────────────────────────────────── 11. DEMO SCRIPT
{
  const s = pptx.addSlide();
  head(s, "DEMO", "Five-minute walkthrough");
  const rows = [hdr(["#", "Action", "What to say"])];
  [
    ["1", "Open AI Intelligence → Auto-Detect", "“Nobody asked for this. 24 detections, 26 symptoms correlated.”"],
    ["2", "Point at CHRONIC 23 / ELIGIBLE 1", "“It refuses to page for things broken 10 days — the credibility guard.”"],
    ["3", "Open Automation Settings", "Autonomous toggle + ServiceNow queue — no redeploy needed."],
    ["4", "Break something live", "A fresh failure — the only thing that will ticket."],
    ["5", "Wait one detection cycle", "Incident appears auto-raised with ServiceNow number + ITIL priority."],
    ["6", "Read the AI RCA on the card", "Category, confidence, causal chain, real log lines."],
    ["7", "Click ▷ Dry-run", "Preview against the live API server — nothing changed yet."],
    ["8", "Click ✅ Apply Fix", "Applies → verifies → resolves → closes the ticket with the RCA."],
    ["9", "Open the ticket in ServiceNow", "Full RCA in close notes, MTTD/MTTA/MTTR, CAPA."],
    ["10", "Optional: let one self-heal", "Incident closes itself, marked self-healed."],
  ].forEach((r) => rows.push(r.map((t, i) => ({ text: t, options: { fontSize: 10, bold: i === 0, align: i === 0 ? "center" : "left", fill: { color: "FFFFFF" } } }))));
  table(s, rows, { y: 1.6, colW: [0.6, 4.4, 7.4], fontSize: 10 });
}

// ───────────────────────────────────────────── 12. CONFIG + STATUS
{
  const s = pptx.addSlide();
  head(s, "OPERATE", "Configuration & rollout");
  const rows = [hdr(["Setting", "Default", "Configurable in UI"])];
  [
    ["Detection on/off", "ON (read-only)", "Yes"],
    ["Autonomous action", "OFF — deliberate interlock", "Yes"],
    ["ServiceNow assignment group (admin queue)", "instance default", "Yes"],
    ["Chronic window", "24 hours", "Yes"],
    ["Severity floor", "SEV-2", "Yes"],
    ["Ticket rate limit", "10 / hour", "Yes"],
    ["Self-heal confirm scans", "2", "Yes"],
    ["Scan interval", "2 minutes", "Env"],
  ].forEach((r) => rows.push(r.map((t, i) => ({ text: t, options: { fontSize: 10.5, bold: i === 0, fill: { color: "FFFFFF" } } }))));
  table(s, rows, { y: 1.6, colW: [6.4, 3.4, 2.6], fontSize: 10.5 });

  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 5.0, w: 6.1, h: 1.75, fill: { color: C.lGreen }, line: { color: C.autoGreen, width: 1.25 }, rectRadius: 0.07 });
  s.addText("Verified by automated harness", { x: 0.62, y: 5.12, w: 5.8, h: 0.3, fontSize: 12, bold: true, color: "065F46", fontFace: F });
  s.addText("Correlation · chronic guard · recurrence semantics · name derivation · full happy path · dry-run precedes apply · failed verification escalates without closing · protected namespaces · idempotency · self-heal · live settings",
    { x: 0.62, y: 5.45, w: 5.8, h: 1.2, fontSize: 8.5, color: "047857", fontFace: F, valign: "top" });

  s.addShape(pptx.ShapeType.roundRect, { x: 6.75, y: 5.0, w: 6.1, h: 1.75, fill: { color: C.lAmber }, line: { color: C.userAmber, width: 1.25 }, rectRadius: 0.07 });
  s.addText("Requires live validation", { x: 6.92, y: 5.12, w: 5.8, h: 0.3, fontSize: 12, bold: true, color: "92400E", fontFace: F });
  s.addText("First real ServiceNow auto-raise and close against the customer instance. AI RCA depth depends on the configured LLM being reachable from the pod.\n\nRecommended: run in shadow mode for one cycle, confirm the chronic/eligible split, then enable autonomous action.",
    { x: 6.92, y: 5.45, w: 5.8, h: 1.2, fontSize: 8.5, color: "92400E", fontFace: F, valign: "top" });
}

// ───────────────────────────────────────────── 13. CLOSING
{
  const s = pptx.addSlide();
  s.background = { color: C.darkNavy };
  s.addText("UC-05  ·  Zero-Touch Incident Command", { x: 0.8, y: 2.5, w: 11.6, h: 0.7, fontSize: 34, bold: true, color: C.white, fontFace: F });
  s.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.35, w: 3.2, h: 0.04, fill: { color: C.valCyan } });
  s.addText("Nobody opens the ticket.\nNobody writes the RCA.\nNobody closes it.",
    { x: 0.8, y: 3.7, w: 11.6, h: 1.5, fontSize: 22, color: C.lAmber, lineSpacing: 34, fontFace: F });
  s.addText("The only thing a human decides is whether to apply the fix.",
    { x: 0.8, y: 5.35, w: 11.6, h: 0.4, fontSize: 15, color: "94A3B8", fontFace: F });
  s.addText("TCS Agentic AI for OpenShift", { x: 0.8, y: 6.4, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", fontFace: F });
}

pptx.writeFile({ fileName: OUT }).then(() => {
  console.log("✅ PPTX written:", OUT);
});
