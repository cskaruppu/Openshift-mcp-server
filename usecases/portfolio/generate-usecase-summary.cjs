/**
 * TCS Agentic AI — Use Case Summary (one slide per use case)
 * Generates: TCS-Agentic-AI-Use-Case-Summary.pptx (beside this script)
 *
 * One file for the team. Each slide carries the use case name, a short
 * description, and its MASTER WORKFLOW — reproduced from that use case's own
 * deck (the "Master Workflow" slide), not a simplified redraw: the same bands,
 * the same gate, the same outcome lanes, the same actor colours.
 *
 * Run: node usecases/portfolio/generate-usecase-summary.cjs
 */
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "TCS-Agentic-AI-Use-Case-Summary.pptx");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const pptx = new PptxGenJS();
pptx.author = "TCS Agentic AI Platform";
pptx.title = "TCS Agentic AI — Use Case Summary";
pptx.subject = "One slide per use case: name, description and master workflow";
pptx.company = "Tata Consultancy Services";
pptx.layout = "LAYOUT_WIDE";

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

// Actor palette — identical to every use-case deck.
const ACT = {
  ai:    { fill: C.lPurple, line: C.aiPurple, text: "5B21B6" },
  auto:  { fill: C.lBlue,   line: C.tcsBlue,  text: "1E40AF" },
  human: { fill: C.lAmber,  line: C.userAmber, text: "92400E" },
  done:  { fill: C.lGreen,  line: C.autoGreen, text: "065F46" },
  warn:  { fill: C.lOrange, line: C.orange,   text: "9A3412" },
  bad:   { fill: C.lRed,    line: C.secRed,   text: "991B1B" },
};

const LEFT = 0.45, FULL = 12.45;
const TOP = 2.62, BOTTOM = 6.5;      // vertical budget for the workflow
const LABEL_H = 0.19, GAP = 0.13, ARROW = 0.3;

/** Natural height of a band before scaling. */
function bandNatural(b) {
  if (b.gate) return 0.6;
  if (b.lanes) return (b.label ? LABEL_H : 0) + 0.46;
  return (b.label ? LABEL_H : 0) + 0.82;
}

/**
 * Draw a master workflow from a band list. Bands are:
 *   { label?, steps: [{ t, s, a }] }   a row of actor-coloured nodes + arrows
 *   { gate: "text" }                   the full-width human gate bar
 *   { label?, lanes: [{ t, a }] }      outcome lanes, no arrows
 * Box heights scale down together if the bands would overflow the budget.
 */
function drawWorkflow(s, bands) {
  const avail = BOTTOM - TOP;
  const natural = bands.reduce((n, b) => n + bandNatural(b), 0) + GAP * (bands.length - 1);
  const boxTotal = bands.reduce((n, b) => n + (b.gate ? 0.6 : b.lanes ? 0.46 : 0.82), 0);
  // Absorb any overflow from the box heights only — labels and gaps stay legible.
  const k = natural <= avail ? 1 : Math.max(0.72, (boxTotal - (natural - avail)) / boxTotal);

  let y = TOP;
  for (const b of bands) {
    if (b.label) {
      s.addText(b.label, { x: LEFT, y, w: 8, h: LABEL_H, fontSize: 9, bold: true,
        color: C.slate, charSpacing: 1.2, fontFace: F });
      y += LABEL_H;
    }

    if (b.gate) {
      const h = 0.6 * k;
      s.addShape(pptx.ShapeType.roundRect, { x: LEFT + 2.4, y, w: FULL - 4.8, h,
        fill: { color: C.userAmber }, line: { color: "92400E", width: 2 }, rectRadius: 0.07 });
      s.addText(b.gate, { x: LEFT + 2.4, y, w: FULL - 4.8, h, fontSize: 12, bold: true,
        color: C.white, align: "center", valign: "middle", fontFace: F });
      y += h + GAP;
      continue;
    }

    if (b.lanes) {
      const h = 0.46 * k;
      const n = b.lanes.length;
      const w = (FULL - (n - 1) * 0.16) / n;
      b.lanes.forEach((l, i) => {
        const a = ACT[l.a] || ACT.auto;
        const x = LEFT + i * (w + 0.16);
        s.addShape(pptx.ShapeType.roundRect, { x, y, w, h,
          fill: { color: a.fill }, line: { color: a.line, width: 1 }, rectRadius: 0.05 });
        s.addText(l.t, { x: x + 0.06, y, w: w - 0.12, h, fontSize: 9.5, bold: true,
          color: a.text, align: "center", valign: "middle", fontFace: F });
      });
      y += h + GAP;
      continue;
    }

    const h = 0.82 * k;
    const n = b.steps.length;
    const w = (FULL - (n - 1) * ARROW) / n;
    b.steps.forEach((st, i) => {
      const x = LEFT + i * (w + ARROW);
      const a = ACT[st.a] || ACT.auto;
      s.addShape(pptx.ShapeType.roundRect, { x, y, w, h,
        fill: { color: a.fill }, line: { color: a.line, width: 1.5 }, rectRadius: 0.07 });
      s.addText(st.t, { x: x + 0.06, y: y + h * 0.09, w: w - 0.12, h: h * 0.42, fontSize: 10.5,
        bold: true, color: a.text, align: "center", valign: "middle", fontFace: F });
      if (st.s) s.addText(st.s, { x: x + 0.06, y: y + h * 0.5, w: w - 0.12, h: h * 0.44,
        fontSize: 8.5, color: C.textMed, align: "center", valign: "top", fontFace: F });
      if (i < n - 1) s.addText("▶", { x: x + w, y: y + h / 2 - 0.14, w: ARROW, h: 0.28,
        fontSize: 11, color: C.slate, align: "center", valign: "middle", fontFace: F });
    });
    y += h + GAP;
  }
}

function useCaseSlide({ id, name, tagline, description, bands, note, noteColor }) {
  const s = pptx.addSlide();

  // Header: the product name always leads, then the use case name.
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 1.16, fill: { color: C.darkNavy } });
  s.addText("TCS AGENTIC AI", { x: LEFT, y: 0.13, w: 5, h: 0.24, fontSize: 10, bold: true,
    color: C.valCyan, charSpacing: 2.2, fontFace: F });
  s.addText(name, { x: LEFT, y: 0.36, w: 10.6, h: 0.44, fontSize: 23, bold: true, color: C.white, fontFace: F });
  s.addText(tagline, { x: LEFT, y: 0.82, w: 10.6, h: 0.28, fontSize: 10.5, italic: true, color: "94A3B8", fontFace: F });
  s.addText(id, { x: 11.55, y: 0.34, w: 1.35, h: 0.4, fontSize: 15, bold: true, color: C.white,
    align: "center", valign: "middle", fontFace: F, fill: { color: C.tcsBlue }, rectRadius: 0.05 });

  // Description — labelled, so it reads as the use case definition
  s.addText("USE CASE DESCRIPTION", { x: LEFT, y: 1.3, w: 4, h: 0.2, fontSize: 8.5,
    bold: true, color: C.slate, charSpacing: 1.4, fontFace: F });
  s.addText(description, { x: LEFT, y: 1.52, w: FULL, h: 1.0, fontSize: 12, color: C.navy,
    fontFace: F, valign: "top", lineSpacingMultiple: 1.2 });

  s.addText("END-TO-END WORKFLOW", { x: LEFT, y: 2.38, w: 4, h: 0.22, fontSize: 8.5,
    bold: true, color: C.tcsBlue, charSpacing: 1.4, fontFace: F });

  drawWorkflow(s, bands);

  const ly = 6.66;
  [{ t: "AI", a: "ai" }, { t: "Automatic", a: "auto" }, { t: "Human", a: "human" }, { t: "Verified", a: "done" }]
    .forEach((l, i) => {
      const x = LEFT + i * 1.25, a = ACT[l.a];
      s.addShape(pptx.ShapeType.roundRect, { x, y: ly, w: 0.19, h: 0.19,
        fill: { color: a.fill }, line: { color: a.line, width: 1 }, rectRadius: 0.03 });
      s.addText(l.t, { x: x + 0.23, y: ly - 0.04, w: 0.95, h: 0.26, fontSize: 8.5,
        color: C.textMed, fontFace: F, valign: "middle" });
    });
  if (note) s.addText(note, { x: 5.6, y: ly - 0.07, w: 7.3, h: 0.32, fontSize: 10.5, bold: true,
    color: noteColor || C.autoGreen, align: "right", fontFace: F, valign: "middle" });
}

// ── COVER ───────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  s.background = { color: C.darkNavy };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 3.15, w: 13.33, h: 0.045, fill: { color: C.tcsBlue } });
  s.addText("TCS AGENTIC AI FOR HYBRID INFRASTRUCTURE", { x: 0.8, y: 1.55, w: 11.6, h: 0.32,
    fontSize: 13, color: C.valCyan, bold: true, charSpacing: 3, fontFace: F });
  s.addText("Use Case Summary", { x: 0.8, y: 1.92, w: 11.6, h: 0.85, fontSize: 40, color: C.white, bold: true, fontFace: F });
  s.addText("Container & Kubernetes Operations  ·  one slide per use case: name, description, and its master workflow",
    { x: 0.8, y: 3.35, w: 11.6, h: 0.4, fontSize: 15, color: "94A3B8", fontFace: F });
  const stats = [{ v: "9", l: "Use cases" }, { v: "15", l: "MCP agents" }, { v: "177", l: "Tools" }, { v: "4", l: "Actor types" }];
  stats.forEach((st, i) => {
    const x = 0.8 + i * 3.0;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 4.25, w: 2.75, h: 1.15,
      fill: { color: C.navy }, line: { color: "334155", width: 1 }, rectRadius: 0.06 });
    s.addText(st.v, { x, y: 4.37, w: 2.75, h: 0.5, fontSize: 26, bold: true, color: C.valCyan, align: "center", fontFace: F });
    s.addText(st.l, { x, y: 4.87, w: 2.75, h: 0.3, fontSize: 9.5, color: "94A3B8", align: "center", fontFace: F });
  });
  s.addText("Each workflow below is the same Master Workflow that appears in that use case's own deck.",
    { x: 0.8, y: 5.75, w: 11.6, h: 0.35, fontSize: 11.5, color: "CBD5E1", fontFace: F });
  s.addText("Colour code:  purple reasons  ·  blue repeats exactly  ·  amber decides  ·  green is proven against the cluster",
    { x: 0.8, y: 6.12, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", italic: true, fontFace: F });
  s.addText("Tata Consultancy Services", { x: 0.8, y: 6.72, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", fontFace: F });
}

// ── UC-01 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-01", name: "Container Troubleshooting Agent",
  tagline: "AI-powered pod troubleshooting — ask in plain language, get a diagnosis backed by live cluster evidence",
  description:
    "An engineer asks “why is my pod crashing?” in natural language. The agent gathers real evidence from the cluster — pod status, container logs, events, resource limits and exit codes — and returns a root cause with the supporting data attached, instead of a list of commands to run. This is the conversational surface every other use case is reached through.",
  bands: [
    { label: "ASK", steps: [
      { t: "👤 Question in chat", s: "plain language", a: "human" },
      { t: "🤖 Intent understood", s: "which workload, which namespace", a: "ai" },
      { t: "⚙️ Cluster queried", s: "parallel API calls", a: "auto" },
    ] },
    { label: "DIAGNOSE", steps: [
      { t: "⚙️ Evidence gathered", s: "logs · events · limits · exit codes", a: "auto" },
      { t: "🤖 Root cause", s: "explained with the evidence shown", a: "ai" },
      { t: "⚙️ Severity assessed", s: "impact and blast radius", a: "auto" },
    ] },
    { label: "ACT", lanes: [
      { t: "👤 Apply a proposed fix", a: "human" },
      { t: "👤 Escalate with the evidence attached", a: "human" },
      { t: "⚙️ Keep investigating — ask a follow-up", a: "auto" },
    ] },
  ],
  note: "Conversational entry point to the whole platform", noteColor: C.tcsBlue,
});

// ── UC-02 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-02", name: "Cluster Upgrade Agent",
  tagline: "End-to-end cluster upgrade automation — pre-assessment through post-verification, with ITSM in the loop",
  description:
    "OpenShift cluster upgrades orchestrated end to end: a pre-assessment against the live cluster, the change record raised automatically, execution with real-time observability, and verification afterwards — instead of a human tracking a long-running operation across consoles and spreadsheets.",
  bands: [
    { label: "ASSESS", steps: [
      { t: "⚙️ Pre-assessment", s: "operators · PDBs · capacity", a: "auto" },
      { t: "⚙️ Deprecated APIs", s: "what breaks at the target version", a: "auto" },
      { t: "🤖 Risk report", s: "what will block, and why", a: "ai" },
      { t: "⚙️ Change record", s: "plans attached", a: "auto" },
    ] },
    { gate: "👤  APPROVE THE UPGRADE WINDOW — THE HUMAN GATE  👤" },
    { label: "EXECUTE & VERIFY", steps: [
      { t: "⚙️ Upgrade executed", s: "live progress per node", a: "auto" },
      { t: "⚙️ Continuously narrated", s: "no black box", a: "auto" },
      { t: "✅ Post-verification", s: "cluster + workload health", a: "done" },
      { t: "⚙️ Change closed", s: "outcome recorded", a: "auto" },
    ] },
  ],
  note: "A long-running operation, continuously narrated", noteColor: C.tcsBlue,
});

// ── UC-03 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-03", name: "Proactive Intelligence Agent",
  tagline: "Predictive intelligence & anomaly detection — forecast the failure before it becomes an incident",
  description:
    "Trend analysis over rolling metric windows forecasts infrastructure failures before they occur — capacity exhaustion, memory growth, certificate expiry, node pressure. The agent surfaces what is about to break and how long there is to act, converting reactive firefighting into scheduled maintenance.",
  bands: [
    { label: "OBSERVE", steps: [
      { t: "⚙️ Continuous scan", s: "rolling windows, whole fleet", a: "auto" },
      { t: "⚙️ Trend analysis", s: "growth rates · thresholds", a: "auto" },
      { t: "⚙️ Anomaly detection", s: "deviation from the norm", a: "auto" },
    ] },
    { label: "PREDICT", steps: [
      { t: "🤖 Prediction formed", s: "what fails, and when", a: "ai" },
      { t: "🤖 Risk prioritised", s: "impact × time-to-impact", a: "ai" },
      { t: "⚙️ Recommendation", s: "the action that prevents it", a: "auto" },
    ] },
    { label: "OUTCOMES", lanes: [
      { t: "👤 Act now — capacity added before exhaustion", a: "human" },
      { t: "👤 Schedule it into the next maintenance window", a: "human" },
      { t: "⚙️ Watch — re-forecast on the next cycle", a: "auto" },
    ] },
  ],
  note: "Reactive firefighting → scheduled maintenance", noteColor: C.aiPurple,
});

// ── UC-04 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-04", name: "Security & Compliance Agent",
  tagline: "Security & compliance governance — continuous posture assessment, not a quarterly audit",
  description:
    "Continuous security posture across the fleet: CIS benchmark evaluation, image vulnerability scanning, RBAC audit and policy enforcement — run continuously and reported per namespace, so compliance is a live number rather than a point-in-time report that ages the moment it is produced.",
  bands: [
    { label: "DISCOVER & SCAN", steps: [
      { t: "⚙️ Discovery", s: "workloads · images · roles", a: "auto" },
      { t: "⚙️ CIS benchmark", s: "control-by-control evaluation", a: "auto" },
      { t: "⚙️ Image CVE scan", s: "critical · high · fixable", a: "auto" },
      { t: "⚙️ RBAC audit", s: "over-privilege, orphaned bindings", a: "auto" },
    ] },
    { label: "EXPLAIN & DECIDE", steps: [
      { t: "🤖 Findings explained", s: "why it matters, what to change", a: "ai" },
      { t: "⚙️ Policy enforcement", s: "admission and guardrails", a: "auto" },
      { t: "👤 Remediation approved", s: "the operator decides", a: "human" },
      { t: "✅ Posture re-verified", s: "the number moves", a: "done" },
    ] },
  ],
  note: "Compliance as a live number", noteColor: C.secRed,
});

// ── UC-05 — from the UC-05 deck's Master Flow slide ─────────────────────────
useCaseSlide({
  id: "UC-05", name: "Container RCA Agent",
  tagline: "Zero-Touch Incident Command — self-detecting · self-documenting · self-closing · self-reverting",
  description:
    "The only agent-initiated use case: nothing triggers it, which is its entire point. It detects against industry-standard thresholds with dwell time, correlates N signals into one incident, determines root cause from real evidence, raises the ticket, and — after one human decision — applies, verifies, documents and closes it.",
  bands: [
    { steps: [
      { t: "⚙️ Detect", s: "12 thresholds + dwell", a: "auto" },
      { t: "⚙️ Correlate", s: "N signals → 1 incident", a: "auto" },
      { t: "🤖 AI RCA", s: "evidence → narrative", a: "ai" },
      { t: "⚙️ Raise INC", s: "reuse if already open", a: "auto" },
      { t: "⚙️ Plan fix", s: "deterministic + guardrails", a: "auto" },
      { t: "⚙️ Dry-run", s: "live API, ?dryRun=All", a: "auto" },
    ] },
    { gate: "👤  APPROVE OR REJECT — THE ONLY HUMAN GATE  👤" },
    { steps: [
      { t: "⚙️ Apply", s: "snapshot first", a: "auto" },
      { t: "⚙️ Verify", s: "rollout completion, not readiness", a: "auto" },
      { t: "⚙️ Attach RCA", s: "HTML + PDF", a: "auto" },
      { t: "⚙️ Close + ledger", s: "inverse stored for revert", a: "auto" },
    ] },
    { lanes: [
      { t: "⚙️ Self-healed → auto-closed", a: "done" },
      { t: "👤 No safe fix → escalated, RCA ready", a: "warn" },
      { t: "👤 Not verified → rolled back, ticket OPEN", a: "bad" },
    ] },
  ],
  note: "Everything either side of the gate is autonomous", noteColor: C.aiPurple,
});

// ── UC-06 — from the UC-06 deck's Master Workflow slide ─────────────────────
useCaseSlide({
  id: "UC-06", name: "VM Lifecycle Agent",
  tagline: "Governed VM provisioning & lifecycle — one sentence in, a governed, owned, accountable machine out",
  description:
    "A VM request stated in plain language, reconciled against the golden templates this cluster actually offers and checked against live quota — before anyone is asked to approve it. On approval the VM is provisioned with full provenance written onto the object, and weeks later the agent reads that provenance back to right-size or reclaim it.",
  bands: [
    { label: "CAPTURE  ·  RECONCILE  ·  PRE-FLIGHT", steps: [
      { t: "👤 One sentence", s: "in chat", a: "human" },
      { t: "🤖 Extract intent", s: "typed VMRequest — never the SSH key", a: "ai" },
      { t: "⚙️ Reconcile size", s: "the delta, stated", a: "auto" },
      { t: "⚙️ Pre-flight, live", s: "quota · name · image · NAD · key", a: "auto" },
      { t: "⚙️ Dry-run", s: "nothing created", a: "auto" },
    ] },
    { gate: "👤  APPROVE — CONSOLE, OR A SERVICENOW CHANGE BOARD  👤" },
    { label: "PROVISION", steps: [
      { t: "⚙️ Re-check pre-flight", s: "the cluster moved on", a: "auto" },
      { t: "⚙️ Apply manifest", s: "DataVolume + cloud-init", a: "auto" },
      { t: "⚙️ Ledger the change", s: "inverse = decommission", a: "auto" },
      { t: "⚙️ Return access", s: "virtctl ssh · console · IP", a: "auto" },
    ] },
    { label: "OWNERSHIP — the part nobody else does", lanes: [
      { t: "✅ Provenance on the VM", a: "done" },
      { t: "✅ Right-size later, citing the request", a: "done" },
      { t: "✅ Enforce the expiry", a: "done" },
      { t: "✅ Health → UC-05's pipeline", a: "done" },
    ] },
  ],
  note: "Never autonomous — by construction", noteColor: C.userAmber,
});

// ── UC-07 — from the UC-07 deck's Master Workflow slide ─────────────────────
useCaseSlide({
  id: "UC-07", name: "App Deployment Agent",
  tagline: "Document-driven application deployment — the requirement document IS the deployment",
  description:
    "A requirement document — Word or Markdown, uploaded or pulled straight from Git — becomes a complete, security-hardened, zero-trust application. Structured documents generate deterministically: the same commit produces the same manifests every time. The flow does not stop at “pods are green”.",
  bands: [
    { label: "DOCUMENT  →  REVIEWED CODE", steps: [
      { t: "👤 Requirement doc", s: "template · Git · .docx", a: "human" },
      { t: "⚙️ Deterministic extract", s: "tables → typed intent", a: "auto" },
      { t: "🤖 LLM lane (prose)", s: "when there are no tables", a: "ai" },
      { t: "⚙️ Generate manifests", s: "zero-trust · secrets · probes", a: "auto" },
      { t: "👤 Review + scans", s: "editable YAML · CIS · CVE", a: "human" },
    ] },
    { gate: "👤  DEPLOY — THE GATE  ·  server-side dry-run passes first  👤" },
    { label: "APPLY & GOVERN", steps: [
      { t: "⚙️ Server-side apply", s: "created / configured / unchanged", a: "auto" },
      { t: "⚙️ Record + change request", s: "cites the source document", a: "auto" },
      { t: "⚙️ Live pod watch", s: "until everything is Ready", a: "auto" },
    ] },
    { label: "VERIFICATION PYRAMID — ends at a URL", lanes: [
      { t: "✅ 1 Rollout complete", a: "done" },
      { t: "✅ 2 Workloads stable", a: "done" },
      { t: "✅ 3 Services wired", a: "done" },
      { t: "✅ 4 User can access — Open application", a: "done" },
    ] },
  ],
  note: "Generation may be creative — verification never is", noteColor: C.autoGreen,
});

// ── UC-08 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-08", name: "Configuration Drift Agent",
  tagline: "Configuration drift detection & one-click rollback — know what changed, in words, and put it back",
  description:
    "Continuous watch over cluster configuration. When live state diverges from the recorded baseline, the agent explains the difference in plain language rather than as a raw diff, surfaces the decision, and offers a one-click rollback — then verifies the rollback landed and records the episode for audit.",
  bands: [
    { label: "WATCH & DETECT", steps: [
      { t: "⚙️ Continuous watch", s: "live state vs baseline", a: "auto" },
      { t: "⚙️ Drift detected", s: "what moved, and when", a: "auto" },
      { t: "🤖 Natural-language diff", s: "explained, not dumped", a: "ai" },
    ] },
    { gate: "👤  DECISION SURFACE — KEEP IT, OR ROLL IT BACK  👤" },
    { label: "ROLL BACK & PROVE", steps: [
      { t: "⚙️ One-click rollback", s: "baseline restored", a: "auto" },
      { t: "✅ Live verification", s: "the rollback actually landed", a: "done" },
      { t: "⚙️ Audit recording", s: "the whole episode, kept", a: "auto" },
    ] },
  ],
  note: "Every episode leaves an audit trail", noteColor: C.valCyan,
});

// ── UC-09 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-09", name: "Incident Response Agent",
  tagline: "End-to-end incident response — “why is my pod crashing?” to diagnosis, ticket and a dry-run fix",
  description:
    "A natural-language question triggers the full incident pipeline: the agent recognises the error pattern, diagnoses root cause from parallel cluster queries, assesses severity, creates the ServiceNow incident, and proposes a targeted fix — presented with a dry-run result attached, so the operator approves an action whose effect is already known.",
  bands: [
    { label: "QUESTION → DIAGNOSIS", steps: [
      { t: "👤 Question asked", s: "plain language, in chat", a: "human" },
      { t: "⚙️ Context gathered", s: "parallel cluster queries", a: "auto" },
      { t: "🤖 Pod doctor diagnosis", s: "error pattern recognised", a: "ai" },
      { t: "🤖 Severity assessed", s: "impact and urgency", a: "ai" },
    ] },
    { label: "TICKET & PROPOSAL", steps: [
      { t: "⚙️ ServiceNow INC created", s: "auto-populated from evidence", a: "auto" },
      { t: "⚙️ Smart fix proposed", s: "targeted, not generic", a: "auto" },
      { t: "⚙️ Dry-run validation", s: "effect known before approval", a: "auto" },
      { t: "👤 Fix card — approve", s: "in AI Chat", a: "human" },
    ] },
  ],
  note: "Question in, governed action out", noteColor: C.aiPurple,
});

// ── CLOSING ─────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  s.background = { color: C.darkNavy };
  s.addText("One platform. One conversational surface. Nine use cases.",
    { x: 0.8, y: 2.15, w: 11.7, h: 0.7, fontSize: 30, color: C.white, bold: true, fontFace: F });
  s.addText("Every use case shares the same agents, the same governance, and the same rule: the AI reasons and explains — but anything claiming to be true of your cluster is measured, not generated.",
    { x: 0.8, y: 3.05, w: 11.7, h: 0.9, fontSize: 15, color: "94A3B8", fontFace: F, lineSpacingMultiple: 1.3 });
  s.addText("Each use case has its own deck, workbook and specification in usecases/ — this file is the map.",
    { x: 0.8, y: 4.15, w: 11.7, h: 0.4, fontSize: 13, color: C.valCyan, italic: true, fontFace: F });
  s.addText("TCS Agentic AI for Hybrid Infrastructure  ·  Container & Kubernetes Operations  ·  Tata Consultancy Services",
    { x: 0.8, y: 6.6, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", fontFace: F });
}

pptx.writeFile({ fileName: OUT }).then(() => console.log(`Wrote ${OUT}`));
