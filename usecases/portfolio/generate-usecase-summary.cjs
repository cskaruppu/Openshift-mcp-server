/**
 * TCS Agentic AI — Use Case Summary (one slide per use case)
 * Generates: TCS-Agentic-AI-Use-Case-Summary.pptx (beside this script)
 *
 * Purpose: a single file to share with the team. Every use case gets exactly
 * one slide carrying its name, a short description, and its workflow drawn as
 * an actor-coloured flow. No detail beyond that — this is the map, not the
 * territory; each use case's own deck holds the depth.
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
pptx.subject = "One slide per use case: name, description and workflow";
pptx.company = "Tata Consultancy Services";
pptx.layout = "LAYOUT_WIDE";

// Same palette as every UC deck, so this reads as the family's cover sheet.
const C = {
  darkNavy: "0F172A", navy: "1E293B", tcsBlue: "2563EB", lBlue: "DBEAFE", pBlue: "EFF6FF",
  aiPurple: "7C3AED", lPurple: "EDE9FE",
  autoGreen: "059669", lGreen: "D1FAE5",
  userAmber: "D97706", lAmber: "FEF3C7",
  valCyan: "0891B2", lCyan: "CFFAFE",
  secRed: "DC2626", lRed: "FEE2E2",
  slate: "64748B", lSlate: "F1F5F9",
  white: "FFFFFF", textMed: "475569",
};
const F = "Inter";

// Actor styling — one legend for the whole deck.
const ACT = {
  ai:    { fill: C.lPurple, line: C.aiPurple, text: "5B21B6" },
  auto:  { fill: C.lBlue,   line: C.tcsBlue,  text: "1E40AF" },
  human: { fill: C.lAmber,  line: C.userAmber, text: "92400E" },
  done:  { fill: C.lGreen,  line: C.autoGreen, text: "065F46" },
};

/**
 * One use-case slide: header band, description, workflow row(s), footer legend.
 * `flow` is an array of { t: label, s: sub, a: actor } — laid out automatically
 * across one or two rows with arrows between.
 */
function useCaseSlide({ id, name, tagline, description, flow, note, noteColor }) {
  const s = pptx.addSlide();

  // Header band
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 1.15, fill: { color: C.darkNavy } });
  s.addText(id, { x: 0.45, y: 0.2, w: 1.3, h: 0.34, fontSize: 13, bold: true, color: C.white,
    align: "center", fontFace: F, fill: { color: C.tcsBlue }, rectRadius: 0.05 });
  s.addText(name, { x: 1.9, y: 0.16, w: 11, h: 0.44, fontSize: 23, bold: true, color: C.white, fontFace: F });
  s.addText(tagline, { x: 1.9, y: 0.63, w: 11, h: 0.32, fontSize: 11.5, italic: true, color: C.valCyan, fontFace: F });

  // Description
  s.addText(description, { x: 0.45, y: 1.4, w: 12.45, h: 1.15, fontSize: 13, color: C.navy,
    fontFace: F, valign: "top", lineSpacingMultiple: 1.25 });

  // Workflow — split into rows of at most 5 steps
  const perRow = flow.length > 5 ? Math.ceil(flow.length / 2) : flow.length;
  const rows = [];
  for (let i = 0; i < flow.length; i += perRow) rows.push(flow.slice(i, i + perRow));

  s.addText("WORKFLOW", { x: 0.45, y: 2.72, w: 3, h: 0.25, fontSize: 9.5, bold: true,
    color: C.slate, charSpacing: 1.5, fontFace: F });

  const AR = 0.34;                                   // arrow gutter
  // A single row would leave the lower third of the slide empty, so taller
  // nodes placed further down; two rows stay compact and stacked.
  const single = rows.length === 1;
  const H = single ? 1.5 : 1.0;                      // node height
  const topY = single ? 3.45 : 3.05;
  const rowGap = 1.45;
  rows.forEach((row, ri) => {
    const n = row.length;
    const avail = 12.45 - (n - 1) * AR;
    const w = avail / n;
    const y = topY + ri * rowGap;
    row.forEach((step, i) => {
      const x = 0.45 + i * (w + AR);
      const a = ACT[step.a] || ACT.auto;
      s.addShape(pptx.ShapeType.roundRect, { x, y, w, h: H,
        fill: { color: a.fill }, line: { color: a.line, width: 1.5 }, rectRadius: 0.07 });
      s.addText(step.t, { x: x + 0.08, y: y + H * 0.11, w: w - 0.16, h: H * 0.38, fontSize: single ? 12 : 11,
        bold: true, color: a.text, align: "center", valign: "middle", fontFace: F });
      if (step.s) s.addText(step.s, { x: x + 0.08, y: y + H * 0.5, w: w - 0.16, h: H * 0.42, fontSize: 9,
        color: C.textMed, align: "center", valign: "top", fontFace: F });
      if (i < n - 1) s.addText("▶", { x: x + w, y: y + H / 2 - 0.15, w: AR, h: 0.3,
        fontSize: 12, color: C.slate, align: "center", valign: "middle", fontFace: F });
    });
    // Wrap arrow between rows
    if (ri < rows.length - 1) {
      s.addText("▼", { x: 0.45, y: y + H + 0.02, w: (avail / n), h: 0.28, fontSize: 11,
        color: C.slate, align: "center", fontFace: F });
    }
  });

  // Footer: legend + optional note
  const legendY = 6.62;
  const legend = [
    { t: "AI", a: "ai" }, { t: "Automatic", a: "auto" },
    { t: "Human", a: "human" }, { t: "Verified", a: "done" },
  ];
  legend.forEach((l, i) => {
    const x = 0.45 + i * 1.25;
    const a = ACT[l.a];
    s.addShape(pptx.ShapeType.roundRect, { x, y: legendY, w: 0.2, h: 0.2,
      fill: { color: a.fill }, line: { color: a.line, width: 1 }, rectRadius: 0.03 });
    s.addText(l.t, { x: x + 0.24, y: legendY - 0.03, w: 0.95, h: 0.26, fontSize: 8.5,
      color: C.textMed, fontFace: F, valign: "middle" });
  });
  if (note) {
    s.addText(note, { x: 5.6, y: legendY - 0.06, w: 7.3, h: 0.32, fontSize: 10.5, bold: true,
      color: noteColor || C.autoGreen, align: "right", fontFace: F, valign: "middle" });
  }
}

// ── COVER ───────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  s.background = { color: C.darkNavy };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 3.15, w: 13.33, h: 0.045, fill: { color: C.tcsBlue } });
  s.addText("TCS AGENTIC AI FOR HYBRID INFRASTRUCTURE", { x: 0.8, y: 1.55, w: 11.6, h: 0.32,
    fontSize: 13, color: C.valCyan, bold: true, charSpacing: 3, fontFace: F });
  s.addText("Use Case Summary", { x: 0.8, y: 1.92, w: 11.6, h: 0.85, fontSize: 40, color: C.white, bold: true, fontFace: F });
  s.addText("Container & Kubernetes Operations  ·  one slide per use case: what it is, and how it works",
    { x: 0.8, y: 3.35, w: 11.6, h: 0.4, fontSize: 15.5, color: "94A3B8", fontFace: F });

  const stats = [
    { v: "9", l: "Use cases" }, { v: "15", l: "MCP agents" },
    { v: "177", l: "Tools" }, { v: "4", l: "Actor types" },
  ];
  stats.forEach((st, i) => {
    const x = 0.8 + i * 3.0;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 4.25, w: 2.75, h: 1.15,
      fill: { color: C.navy }, line: { color: "334155", width: 1 }, rectRadius: 0.06 });
    s.addText(st.v, { x, y: 4.37, w: 2.75, h: 0.5, fontSize: 26, bold: true, color: C.valCyan, align: "center", fontFace: F });
    s.addText(st.l, { x, y: 4.87, w: 2.75, h: 0.3, fontSize: 9.5, color: "94A3B8", align: "center", fontFace: F });
  });

  s.addText("Colour code used on every slide:   AI reasons   ·   Automatic repeats exactly   ·   Human decides   ·   Verified is proven against the cluster",
    { x: 0.8, y: 5.75, w: 11.6, h: 0.35, fontSize: 11.5, color: "CBD5E1", fontFace: F });
  s.addText("Each use case has its own full deck, workbook and specification — this file is the map.",
    { x: 0.8, y: 6.15, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", italic: true, fontFace: F });
  s.addText("Tata Consultancy Services", { x: 0.8, y: 6.72, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", fontFace: F });
}

// ── UC-01 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-01",
  name: "AI-Powered Pod Troubleshooting",
  tagline: "Ask in plain language; get a diagnosis backed by live cluster evidence",
  description:
    "An engineer asks “why is my pod crashing?” in natural language. The agent gathers real evidence from the cluster — pod status, container logs, events, resource limits and exit codes — and returns a root cause with the supporting data attached, instead of a list of commands to run. The entry point for everything else in the portfolio: the same conversational surface leads to remediation, provisioning and governance.",
  flow: [
    { t: "Natural-language question", s: "AI Chat", a: "human" },
    { t: "Intent understood", s: "which workload, which namespace", a: "ai" },
    { t: "Evidence gathered", s: "logs · events · limits · exit codes", a: "auto" },
    { t: "Root cause explained", s: "with the evidence shown", a: "ai" },
    { t: "Next action offered", s: "fix · escalate · investigate", a: "human" },
  ],
  note: "Conversational entry point to the whole platform",
  noteColor: C.tcsBlue,
});

// ── UC-02 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-02",
  name: "End-to-End Cluster Upgrade Automation",
  tagline: "Pre-assessment through post-verification, with ITSM in the loop",
  description:
    "OpenShift cluster upgrades orchestrated end to end: the agent runs a pre-assessment against the live cluster, raises the change record, executes the upgrade with real-time observability, and verifies the result afterwards — rather than a human tracking a long-running operation across consoles and spreadsheets.",
  flow: [
    { t: "Pre-assessment", s: "operators · PDBs · capacity · deprecated APIs", a: "auto" },
    { t: "Risk report", s: "what will block, and why", a: "ai" },
    { t: "Change record", s: "raised with plans attached", a: "auto" },
    { t: "APPROVAL", s: "the gate", a: "human" },
    { t: "Upgrade executed", s: "live progress per node", a: "auto" },
    { t: "Post-verification", s: "cluster + workload health", a: "done" },
  ],
  note: "Long-running operation, continuously narrated",
  noteColor: C.tcsBlue,
});

// ── UC-03 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-03",
  name: "Predictive Intelligence & Anomaly Detection",
  tagline: "Forecast the failure before it becomes an incident",
  description:
    "Trend analysis over rolling metric windows to forecast infrastructure failures before they occur — capacity exhaustion, memory growth, certificate expiry, node pressure. The agent surfaces what is about to break and how long there is to act, converting reactive firefighting into scheduled maintenance.",
  flow: [
    { t: "Continuous metric scan", s: "rolling windows across the fleet", a: "auto" },
    { t: "Trend analysis", s: "growth rates · thresholds · seasonality", a: "auto" },
    { t: "Prediction formed", s: "what fails, and when", a: "ai" },
    { t: "Risk prioritised", s: "impact × time-to-impact", a: "ai" },
    { t: "Recommendation", s: "act now, or schedule", a: "human" },
  ],
  note: "Reactive firefighting → scheduled maintenance",
  noteColor: C.aiPurple,
});

// ── UC-04 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-04",
  name: "Security & Compliance Governance",
  tagline: "Continuous posture assessment, not a quarterly audit",
  description:
    "Continuous security posture assessment across the fleet: CIS benchmark evaluation, image vulnerability scanning, RBAC audit and policy enforcement — run continuously and reported per namespace, so compliance is a live number rather than a point-in-time report that ages the moment it is produced.",
  flow: [
    { t: "Discovery", s: "workloads · images · roles · policies", a: "auto" },
    { t: "CIS + CVE scanning", s: "benchmark and vulnerability evaluation", a: "auto" },
    { t: "RBAC audit", s: "over-privilege and orphaned bindings", a: "auto" },
    { t: "Findings explained", s: "why it matters, what to change", a: "ai" },
    { t: "Remediation approved", s: "operator decides", a: "human" },
    { t: "Posture re-verified", s: "the number moves", a: "done" },
  ],
  note: "Compliance as a live number",
  noteColor: C.secRed,
});

// ── UC-05 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-05",
  name: "RCA Agent — Zero-Touch Incident Command",
  tagline: "Self-detecting · self-documenting · self-closing · self-reverting",
  description:
    "The only agent-initiated use case. It scans every two minutes against industry-standard thresholds, merges related signals into one incident, gathers real evidence and determines root cause, classifies against the ITIL priority matrix, raises and later closes the ServiceNow ticket — and verifies the fix actually held before declaring success. A person is required at exactly one point: approving the fix.",
  flow: [
    { t: "Continuous detection", s: "every 2 min · sustained breaches only", a: "auto" },
    { t: "Signals correlated", s: "one incident, not three tickets", a: "auto" },
    { t: "Root cause", s: "from logs, events, limits, exit codes", a: "ai" },
    { t: "Ticket raised", s: "ITIL priority · correct queue", a: "auto" },
    { t: "APPROVE THE FIX", s: "the only human step", a: "human" },
    { t: "Applied + verified", s: "rollout proven, ticket closed", a: "done" },
  ],
  note: "Agent-initiated · one human decision",
  noteColor: C.aiPurple,
});

// ── UC-06 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-06",
  name: "Governed VM Provisioning & Lifecycle",
  tagline: "One sentence in. A governed, owned, accountable virtual machine out",
  description:
    "A VM request stated in plain language in AI Chat, reconciled against the golden templates this cluster actually offers and checked against live quota — before anyone is asked to approve it. On approval the VM is provisioned with full provenance written onto the object: owner, cost centre, expiry, and why it was sized that way. Weeks later the agent reads that provenance back to right-size or reclaim it.",
  flow: [
    { t: "Request in chat", s: "one plain-language sentence", a: "human" },
    { t: "Intent extracted", s: "typed request — never the SSH key", a: "ai" },
    { t: "Reconciled + pre-flight", s: "golden size · quota · image · network", a: "auto" },
    { t: "APPROVAL", s: "console or ServiceNow CAB", a: "human" },
    { t: "Provisioned", s: "persistent disk · cloud-init · provenance", a: "done" },
    { t: "Owned", s: "expiry sweep · right-sizing", a: "auto" },
  ],
  note: "Never autonomous — by construction",
  noteColor: C.userAmber,
});

// ── UC-07 ───────────────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-07",
  name: "Document-Driven Application Deployment",
  tagline: "The requirement document IS the deployment",
  description:
    "A requirement document — Word or Markdown, uploaded or pulled straight from Git — becomes a complete, security-hardened, zero-trust application. Structured documents generate deterministically: the same commit produces the same manifests every time. The flow does not stop at “pods are green”: four verification levels run automatically and end at a URL a person can click.",
  flow: [
    { t: "Template filled", s: "guided placeholders · Word or Markdown", a: "human" },
    { t: "Generate", s: "deterministic · 64 manifests", a: "auto" },
    { t: "Scan + dry-run", s: "CIS · CVE · full admission", a: "auto" },
    { t: "DEPLOY", s: "the gate", a: "human" },
    { t: "Applied + governed", s: "SSA · record · change request", a: "auto" },
    { t: "Verified to a URL", s: "rollout · stability · wiring · access", a: "done" },
  ],
  note: "Generation may be creative — verification never is",
  noteColor: C.autoGreen,
});

// ── DRIFT DETECTION ─────────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-08",
  name: "Configuration Drift Detection & One-Click Rollback",
  tagline: "Know what changed, in words — and put it back",
  description:
    "Continuous watch over cluster configuration. When live state diverges from the recorded baseline, the agent explains the difference in plain language rather than as a raw diff, surfaces the decision, and offers a one-click rollback — then verifies the rollback landed and records the whole episode for audit.",
  flow: [
    { t: "Continuous watch", s: "live state vs baseline", a: "auto" },
    { t: "Drift detected", s: "what moved, and when", a: "auto" },
    { t: "Explained in words", s: "natural-language diff", a: "ai" },
    { t: "Decision surface", s: "keep it, or roll it back", a: "human" },
    { t: "Rolled back", s: "one click", a: "auto" },
    { t: "Verified + recorded", s: "proven, then audited", a: "done" },
  ],
  note: "Every episode leaves an audit trail",
  noteColor: C.valCyan,
});

// ── INCIDENT RESPONSE ───────────────────────────────────────────────────────
useCaseSlide({
  id: "UC-09",
  name: "End-to-End Incident Response",
  tagline: "“Why is my pod crashing?” → diagnosis, ticket, and a dry-run fix",
  description:
    "A natural-language question triggers the full incident pipeline: the agent recognises the error pattern, diagnoses root cause from parallel cluster queries, assesses severity, creates the ServiceNow incident, and proposes a targeted fix — presented as a card with a dry-run result attached, so the operator approves an action whose effect is already known.",
  flow: [
    { t: "Question asked", s: "plain language, in chat", a: "human" },
    { t: "Context gathered", s: "parallel cluster queries", a: "auto" },
    { t: "Diagnosis + severity", s: "pattern recognised, impact assessed", a: "ai" },
    { t: "Incident created", s: "ServiceNow, auto-populated", a: "auto" },
    { t: "Fix proposed", s: "card with dry-run result", a: "ai" },
    { t: "Operator approves", s: "effect already known", a: "human" },
  ],
  note: "Question in, governed action out",
  noteColor: C.aiPurple,
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
