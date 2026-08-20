/**
 * TCS Agentic AI — UC-07: Document-Driven Application Deployment
 * Generates: TCS-Agentic-AI-UC07-Doc-Driven-Deployment.pptx (beside this script)
 *
 * Run: node usecases/uc-07-doc-driven-deployment/generate-ppt.cjs
 */
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "TCS-Agentic-AI-UC07-Doc-Driven-Deployment.pptx");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const pptx = new PptxGenJS();
pptx.author = "TCS Agentic AI Platform";
pptx.title = "TCS Agentic AI — Document-Driven Application Deployment · UC-07";
pptx.subject = "UC-07 — a versioned requirement document becomes a verified, governed application on OpenShift";
pptx.company = "Tata Consultancy Services";
pptx.layout = "LAYOUT_WIDE";

// Same palette as the UC-05/UC-06 decks so the three read as one family.
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

function head(s, kicker, title, sub) {
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.9, fill: { color: C.darkNavy } });
  s.addText(kicker, { x: 0.45, y: 0.12, w: 5, h: 0.25, fontSize: 10, color: C.valCyan, bold: true, charSpacing: 1.5, fontFace: F });
  s.addText(title, { x: 0.45, y: 0.34, w: 9.6, h: 0.45, fontSize: 22, color: C.white, bold: true, fontFace: F });
  s.addText("UC-07", { x: 11.62, y: 0.2, w: 1.35, h: 0.34, fontSize: 13, color: C.white, bold: true, align: "center", fontFace: F,
    fill: { color: C.tcsBlue }, rectRadius: 0.05 });
  s.addText("TCS Agentic AI", { x: 11.12, y: 0.56, w: 1.85, h: 0.22, fontSize: 7.5, color: "94A3B8", align: "center", fontFace: F });
  if (sub) s.addText(sub, { x: 0.45, y: 1.0, w: 12.4, h: 0.3, fontSize: 12, color: C.textMed, fontFace: F });
}

function box(s, { x, y, w, h, fill, line, text, sub, tColor, fs = 12, bold = true }) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: line, width: 1.25 }, rectRadius: 0.08 });
  s.addText(text, { x, y: sub ? y + 0.08 : y, w, h: sub ? h * 0.55 : h, fontSize: fs, bold, color: tColor || C.navy, align: "center", valign: "middle", fontFace: F });
  if (sub) s.addText(sub, { x, y: y + h * 0.5, w, h: h * 0.44, fontSize: 9, color: C.textMed, align: "center", valign: "middle", fontFace: F });
}
function arrow(s, x, y, w = 0.3) {
  s.addText("▶", { x, y, w, h: 0.3, fontSize: 12, color: C.slate, align: "center", valign: "middle", fontFace: F });
}
function table(s, rows, opts = {}) {
  s.addTable(rows, {
    x: opts.x ?? 0.45, y: opts.y ?? 1.45, w: opts.w ?? 12.4, colW: opts.colW,
    border: { type: "solid", color: "CBD5E1", pt: 0.5 },
    fontSize: opts.fontSize ?? 10.5, fontFace: F, valign: "middle", autoPage: false,
  });
}
function hdr(cells) {
  return cells.map((t) => ({ text: t, options: { bold: true, color: C.white, fill: { color: C.navy }, fontSize: 10.5 } }));
}
function footNote(s, text, color) {
  s.addText(text, { x: 0.45, y: 6.5, w: 12.4, h: 0.4, fontSize: 12.5, bold: true, color: color || C.autoGreen, align: "center", fontFace: F });
}

// ── 1. TITLE ────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  s.background = { color: C.darkNavy };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 3.32, w: 13.33, h: 0.045, fill: { color: C.tcsBlue } });
  s.addText("TCS AGENTIC AI   ·   USE CASE 07", { x: 0.8, y: 1.62, w: 8, h: 0.3, fontSize: 13, color: C.valCyan, bold: true, charSpacing: 3, fontFace: F });
  s.addText("Document-Driven Application Deployment", { x: 0.8, y: 1.98, w: 11.9, h: 0.85, fontSize: 37, color: C.white, bold: true, fontFace: F });
  s.addText("App Deployment Agent  ·  Git-versioned requirement in, verified application out",
    { x: 0.8, y: 3.5, w: 11.6, h: 0.4, fontSize: 15.5, color: "94A3B8", fontFace: F });
  s.addText("“Upload a document. Open a working application.”",
    { x: 0.8, y: 4.05, w: 11.6, h: 0.4, fontSize: 15, color: C.lAmber, italic: true, fontFace: F });

  const stats = [
    { v: "64", l: "Manifests from one doc" }, { v: "0", l: "Lines of YAML by hand" },
    { v: "4", l: "Verification levels" }, { v: "3", l: "Human touches" }, { v: "93", l: "Unit tests pinning it" },
  ];
  stats.forEach((st, i) => {
    const x = 0.8 + i * 2.42;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 4.85, w: 2.2, h: 1.15, fill: { color: C.navy }, line: { color: "334155", width: 1 }, rectRadius: 0.06 });
    s.addText(st.v, { x, y: 4.97, w: 2.2, h: 0.5, fontSize: 26, bold: true, color: C.valCyan, align: "center", fontFace: F });
    s.addText(st.l, { x, y: 5.47, w: 2.2, h: 0.3, fontSize: 9, color: "94A3B8", align: "center", fontFace: F });
  });
  s.addText("TCS Agentic AI for Hybrid Infrastructure  ·  Container & Kubernetes Operations  ·  Tata Consultancy Services",
    { x: 0.8, y: 6.45, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", fontFace: F });
}

// ── 2. THE PROBLEM ──────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "THE PROBLEM", "The distance between a requirement and a working application");
  const items = [
    { t: "YAML is authored by hand", d: "A three-tier app is ~2,000 lines. Every team writes them again, differently, under deadline.", c: C.secRed, bg: C.lRed },
    { t: "Security varies by engineer", d: "NetworkPolicies, probes, quotas — present when someone remembered, absent when they didn't.", c: C.orange, bg: C.lOrange },
    { t: "\"Deployed\" ≠ \"works\"", d: "Pods go green while the frontend can't reach the API. Nobody probes the URL until a user does.", c: C.userAmber, bg: C.lAmber },
    { t: "The requirement dies in a ticket", d: "What was asked for, and why, is unrecoverable six months later.", c: C.aiPurple, bg: C.lPurple },
    { t: "No provenance", d: "\"Who deployed this, from what?\" is archaeology across terminals and tickets.", c: C.tcsBlue, bg: C.lBlue },
    { t: "Re-deploys drift", d: "Re-applying by hand updates some things, misses others, and reports none of it.", c: C.slate, bg: C.lSlate },
  ];
  items.forEach((it, i) => {
    const x = 0.45 + (i % 3) * 4.18, y = 1.55 + Math.floor(i / 3) * 2.35;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.95, h: 2.05, fill: { color: it.bg }, line: { color: it.c, width: 1.25 }, rectRadius: 0.08 });
    s.addText(it.t, { x: x + 0.2, y: y + 0.18, w: 3.55, h: 0.4, fontSize: 13.5, bold: true, color: it.c, fontFace: F });
    s.addText(it.d, { x: x + 0.2, y: y + 0.62, w: 3.55, h: 1.25, fontSize: 10.5, color: C.navy, fontFace: F, valign: "top" });
  });
  footNote(s, "UC-07 makes the requirement document itself the deployment — reviewed like code, executed deterministically, verified to the URL.");
}

// ── 3. ACTOR MODEL ──────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "ACTOR MODEL", "The AI is the operator. Determinism is the contract.");
  const acts = [
    { i: "🤖", n: "AI", c: C.aiPurple, bg: C.lPurple, w: "Architects free-prose requirements. Investigates red verification levels.",
      d: "Also drives the same pipeline conversationally through 15 MCP agents / 177 tools — callable by any external framework. It never touches a structured document's lane." },
    { i: "⚙️", n: "AUTOMATIC", c: C.tcsBlue, bg: C.lBlue, w: "Everything that must be repeatable: extract, generate, apply, govern, verify.",
      d: "A structured document produces byte-identical YAML on every run — no model in the loop. Truth about the cluster is measured, never generated." },
    { i: "👤", n: "HUMAN", c: C.userAmber, bg: C.lAmber, w: "Reviews the YAML. Clicks Deploy. Approves a proposed fix.",
      d: "The irreversible decisions stay human. The platform narrows them; it does not take them." },
    { i: "✅", n: "VERIFIED", c: C.autoGreen, bg: C.lGreen, w: "An outcome proven against the live cluster.",
      d: "Rollout complete, workloads stable, Services wired, and the platform itself browsing to the application's URL." },
  ];
  acts.forEach((a, i) => {
    const x = 0.45 + (i % 2) * 6.3, y = 1.55 + Math.floor(i / 2) * 2.5;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 6.05, h: 2.25, fill: { color: a.bg }, line: { color: a.c, width: 1.5 }, rectRadius: 0.08 });
    s.addText(`${a.i}  ${a.n}`, { x: x + 0.25, y: y + 0.15, w: 5.5, h: 0.4, fontSize: 15, bold: true, color: a.c, fontFace: F });
    s.addText(a.w, { x: x + 0.25, y: y + 0.58, w: 5.55, h: 0.55, fontSize: 11.5, bold: true, color: C.navy, fontFace: F, valign: "top" });
    s.addText(a.d, { x: x + 0.25, y: y + 1.18, w: 5.55, h: 1.0, fontSize: 10, color: C.textMed, fontFace: F, valign: "top" });
  });
  footNote(s, "Generation may be creative. Verification never is.", C.aiPurple);
}

// ── 4. MASTER WORKFLOW ──────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "MASTER WORKFLOW", "Document → manifests → deploy → proof, colour-coded by actor");

  // Row 1 — from document to reviewed manifests
  box(s, { x: 0.45, y: 1.7, w: 2.0, h: 0.85, fill: C.lAmber, line: C.userAmber, text: "📄 Requirement doc", sub: "Git · upload · .docx", fs: 10.5 });
  arrow(s, 2.5, 1.97);
  box(s, { x: 2.85, y: 1.7, w: 2.25, h: 0.85, fill: C.lBlue, line: C.tcsBlue, text: "Deterministic extract", sub: "tables → typed intent", fs: 10.5 });
  box(s, { x: 2.85, y: 2.72, w: 2.25, h: 0.62, fill: C.lPurple, line: C.aiPurple, text: "🤖 LLM lane (prose)", fs: 9.5 });
  arrow(s, 5.15, 1.97);
  box(s, { x: 5.5, y: 1.7, w: 2.3, h: 0.85, fill: C.lBlue, line: C.tcsBlue, text: "Generate 64 manifests", sub: "zero-trust · secrets · probes", fs: 10.5 });
  arrow(s, 7.85, 1.97);
  box(s, { x: 8.2, y: 1.7, w: 2.1, h: 0.85, fill: C.lAmber, line: C.userAmber, text: "👤 Review YAML", sub: "editable, resettable", fs: 10.5 });
  arrow(s, 10.35, 1.97);
  box(s, { x: 10.7, y: 1.7, w: 2.15, h: 0.85, fill: C.lCyan, line: C.valCyan, text: "CIS + CVE scan", sub: "shift-left, pre-deploy", fs: 10.5 });

  // Row 2 — the gate and execution
  box(s, { x: 0.45, y: 3.6, w: 2.3, h: 0.85, fill: C.lBlue, line: C.tcsBlue, text: "Server-side dry-run", sub: "full admission, nothing created", fs: 10.5 });
  arrow(s, 2.8, 3.87);
  box(s, { x: 3.15, y: 3.6, w: 1.9, h: 0.85, fill: C.lAmber, line: C.userAmber, text: "👤 DEPLOY", sub: "the gate", fs: 11 });
  arrow(s, 5.1, 3.87);
  box(s, { x: 5.45, y: 3.6, w: 2.5, h: 0.85, fill: C.lBlue, line: C.tcsBlue, text: "Server-side apply", sub: "created / configured / unchanged", fs: 10.5 });
  arrow(s, 8.0, 3.87);
  box(s, { x: 8.35, y: 3.6, w: 2.2, h: 0.85, fill: C.lBlue, line: C.tcsBlue, text: "Record + SNOW CR", sub: "cites the Git source", fs: 10.5 });
  arrow(s, 10.6, 3.87);
  box(s, { x: 10.95, y: 3.6, w: 1.9, h: 0.85, fill: C.lBlue, line: C.tcsBlue, text: "Pod watch", sub: "live table", fs: 10.5 });

  // Row 3 — the pyramid to the URL
  box(s, { x: 0.45, y: 5.5, w: 7.2, h: 0.85, fill: C.lGreen, line: C.autoGreen, tColor: "065F46",
    text: "Verification pyramid — rollout ▸ stability ▸ wiring ▸ URL probe", sub: "runs by itself when pods are ready", fs: 11.5 });
  arrow(s, 7.7, 5.77);
  box(s, { x: 8.05, y: 5.5, w: 2.4, h: 0.85, fill: C.lGreen, line: C.autoGreen, tColor: "065F46", text: "🟢 Open application", sub: "a human clicks the URL", fs: 11 });
  box(s, { x: 10.65, y: 5.5, w: 2.2, h: 0.85, fill: C.lPurple, line: C.aiPurple, text: "🤖 red? → RCA agent", sub: "UC-05 machinery", fs: 10 });
}

// ── 5. EFFORT SPLIT ─────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "EFFORT SPLIT", "Fourteen automatic steps. Two AI. Three human touches.");
  s.addChart(pptx.ChartType.doughnut, [{
    name: "Effort", labels: ["⚙️ Automatic", "👤 Manual", "🤖 AI"], values: [14, 3, 2],
  }], {
    x: 0.6, y: 1.6, w: 5.6, h: 4.5, holeSize: 52, showLegend: true, legendPos: "b", legendFontSize: 11,
    chartColors: [C.tcsBlue, C.userAmber, C.aiPurple], dataBorder: { pt: 2, color: C.white },
    showValue: true, dataLabelFontSize: 12, dataLabelColor: C.white, dataLabelFontBold: true,
  });
  const rows = [
    hdr(["Actor", "Steps", "What it covers"]),
    [{ text: "⚙️ Automatic" }, { text: "14" }, { text: "Extraction, generation, scans, dry-run, apply, records, governance, pod watch, all four verification levels" }],
    [{ text: "👤 Manual" }, { text: "3" }, { text: "Review the YAML · click Deploy · click the verified URL" }],
    [{ text: "🤖 AI" }, { text: "2" }, { text: "Architect free-prose requirements · investigate a red verification level" }],
  ];
  table(s, rows, { x: 6.6, y: 1.9, w: 6.25, colW: [1.6, 0.75, 3.9], fontSize: 10 });
  s.addShape(pptx.ShapeType.roundRect, { x: 6.6, y: 4.0, w: 6.25, h: 2.1, fill: { color: C.lPurple }, line: { color: C.aiPurple, width: 1.5 }, rectRadius: 0.08 });
  s.addText("Why the AI count is deliberately low", { x: 6.85, y: 4.15, w: 5.75, h: 0.35, fontSize: 13, bold: true, color: "5B21B6", fontFace: F });
  s.addText("A structured document must produce byte-identical manifests on every run — an audit requirement no generative step can meet. So the AI works the edges: turning prose into structure before the pipeline, and reasoning over evidence after it. The middle is deterministic on purpose.",
    { x: 6.85, y: 4.55, w: 5.75, h: 1.45, fontSize: 10.5, color: C.navy, valign: "top", fontFace: F });
}

// ── 6. WHERE THE AI IS ──────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "THE HONEST MAP", "Where the agentic AI actually is — stage by stage");
  const rows = [
    hdr(["Stage", "Actor", "Why this actor"]),
    [{ text: "Free-prose requirement → manifests" }, { text: "🤖 AI", options: { bold: true, color: "5B21B6", fill: { color: C.lPurple } } }, { text: "No tables to parse — the LLM acts as platform architect under a CIS/PSS-restricted prompt contract" }],
    [{ text: "Structured document → manifests" }, { text: "⚙️ AUTO", options: { bold: true, color: "1E40AF", fill: { color: C.lBlue } } }, { text: "The tables ARE a contract; a model would paraphrase. Same commit → same YAML" }],
    [{ text: "Conversational ops (AI Chat / MCP)" }, { text: "🤖 AI", options: { bold: true, color: "5B21B6", fill: { color: C.lPurple } } }, { text: "Same pipeline, natural language — 15 agents · 177 tools, open to any framework" }],
    [{ text: "Shift-left security verdicts" }, { text: "⚙️ AUTO", options: { bold: true, color: "1E40AF", fill: { color: C.lBlue } } }, { text: "CIS + CVE scans are deterministic; the AI explains findings on request" }],
    [{ text: "Change governance (ServiceNow)" }, { text: "⚙️ AUTO", options: { bold: true, color: "1E40AF", fill: { color: C.lBlue } } }, { text: "CR authored from the deploy itself — implementation, backout, test plans" }],
    [{ text: "Verification pyramid" }, { text: "⚙️ AUTO", options: { bold: true, color: "1E40AF", fill: { color: C.lBlue } } }, { text: "Truth about the cluster is measured, never inferred" }],
    [{ text: "Failure investigation" }, { text: "🤖 AI", options: { bold: true, color: "5B21B6", fill: { color: C.lPurple } } }, { text: "A red level hands logs, events and probes to the RCA agent — it reasons, a human approves" }],
    [{ text: "The irreversible clicks" }, { text: "👤 HUMAN", options: { bold: true, color: "92400E", fill: { color: C.lAmber } } }, { text: "Deploy and fix-approval are decisions, not steps" }],
  ];
  table(s, rows, { y: 1.55, colW: [3.6, 1.5, 7.3], fontSize: 10 });
}

// ── 7. ZERO-TRUST GENERATION ────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "SECURITY BY GENERATION", "One contract, both directions — the matrix the document declares is the network the app gets");
  const rows = [
    hdr(["Control", "What is generated"]),
    [{ text: "Zero-trust matrix", options: { bold: true } }, { text: "default-deny BOTH directions. Every allowed row → an ingress rule on the target AND an egress rule on the caller. The boutique's 19-row matrix becomes 33 policies" }],
    [{ text: "DNS precondition", options: { bold: true } }, { text: "Egress to openshift-dns granted to all pods — deny-all without it fails identically to no network at all" }],
    [{ text: "Secrets", options: { bold: true } }, { text: "Random credentials generated at manifest time — never in the document, the chat, or Git" }],
    [{ text: "Probes", options: { bold: true } }, { text: "Kubelet-native gRPC probes for distroless services; argv exec (no shell assumed); http and tcp as declared" }],
    [{ text: "Images", options: { bold: true } }, { text: "Restricted-SCC compatible — arbitrary UID, non-root. CIS + CVE scanned before deploy" }],
    [{ text: "Blast radius", options: { bold: true } }, { text: "Rollback deletes ONLY what the deploy created; updated resources and pre-existing namespaces are never touched" }],
  ];
  table(s, rows, { y: 1.55, colW: [2.8, 9.6], fontSize: 10.5 });
  footNote(s, "The denied paths are listed in the document too — and the samples include the command that proves a denied path actually times out.", C.secRed);
}

// ── 8. VERIFICATION PYRAMID ─────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "THE VERIFICATION PYRAMID", "\"Done\" means a human can use it — four levels, each stronger than the last");
  const levels = [
    { n: "4 · USER CAN ACCESS", d: "The platform HTTP-probes every Route from outside the pods — the acceptance test, executed", w: 5.4, c: C.autoGreen, bg: C.lGreen },
    { n: "3 · SERVICES WIRED", d: "Every selector-bearing Service has ready endpoints — catches the label mismatch behind \"Route says 503\"", w: 7.2, c: C.valCyan, bg: C.lCyan },
    { n: "2 · WORKLOADS STABLE", d: "No crash loops, no accumulating restarts", w: 9.0, c: C.tcsBlue, bg: C.lBlue },
    { n: "1 · ROLLOUT COMPLETE", d: "kubectl rollout status semantics — THIS generation, not old-pods-still-Ready", w: 10.8, c: C.navy, bg: C.lSlate },
  ];
  levels.forEach((l, i) => {
    const y = 1.6 + i * 1.06;
    const x = (13.33 - l.w) / 2;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: l.w, h: 0.92, fill: { color: l.bg }, line: { color: l.c, width: 1.5 }, rectRadius: 0.06 });
    s.addText(l.n, { x: x + 0.25, y: y + 0.08, w: l.w - 0.5, h: 0.35, fontSize: 12.5, bold: true, color: l.c === C.navy ? C.navy : l.c, fontFace: F });
    s.addText(l.d, { x: x + 0.25, y: y + 0.42, w: l.w - 0.5, h: 0.45, fontSize: 10, color: C.textMed, fontFace: F, valign: "top" });
  });
  s.addText("Runs by itself the moment the pod watch goes green — and ends at an “Open application” button with a live status dot.",
    { x: 0.45, y: 6.0, w: 12.4, h: 0.3, fontSize: 11.5, color: C.textMed, align: "center", fontFace: F });
  footNote(s, "Sample 03 fails on purpose. A green result means something because red is possible.", C.secRed);
}

// ── 9. DOCS-AS-CODE ─────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "DOCS-AS-CODE", "Version control is the front door");
  const steps = [
    { t: "1 · Document lives in Git", d: "PR-reviewed, versioned, diffable — .md or .docx", c: C.tcsBlue, bg: C.lBlue },
    { t: "2 · \"Load from Git\"", d: "Paste the GitHub link — blob URLs rewritten to raw; .docx converted with tables intact; one-shot token for private repos", c: C.tcsBlue, bg: C.lBlue },
    { t: "3 · Deterministic generate", d: "Same commit → same 64 manifests, byte for byte", c: C.tcsBlue, bg: C.lBlue },
    { t: "4 · Provenance travels", d: "The deploy record and the ServiceNow CR cite the source URL — audit walks from a running pod back to the document version", c: C.autoGreen, bg: C.lGreen },
    { t: "5 · Re-deploy = re-fetch", d: "Server-side apply updates only what changed, and says so: created / configured / unchanged", c: C.autoGreen, bg: C.lGreen },
  ];
  steps.forEach((st, i) => {
    const y = 1.5 + i * 0.98;
    s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y, w: 7.4, h: 0.85, fill: { color: st.bg }, line: { color: st.c, width: 1.25 }, rectRadius: 0.07 });
    s.addText(st.t, { x: 0.7, y: y + 0.07, w: 6.9, h: 0.32, fontSize: 12, bold: true, color: st.c, fontFace: F });
    s.addText(st.d, { x: 0.7, y: y + 0.4, w: 6.9, h: 0.42, fontSize: 9.5, color: C.navy, fontFace: F, valign: "top" });
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 8.15, y: 1.5, w: 4.7, h: 4.85, fill: { color: C.lSlate }, line: { color: C.slate, width: 1.25 }, rectRadius: 0.08 });
  s.addText("Roadmap, in order of value", { x: 8.4, y: 1.68, w: 4.2, h: 0.35, fontSize: 13, bold: true, color: C.navy, fontFace: F });
  s.addText([
    { text: "Webhook auto-deploy — a merged PR on the document deploys to dev", options: { bullet: true, breakLine: true } },
    { text: "Environment promotion — the same document, dev → staging → prod cluster targets", options: { bullet: true, breakLine: true } },
    { text: "GitOps hand-off — commit the generated YAML for Argo CD to sync instead of applying directly", options: { bullet: true } },
  ], { x: 8.4, y: 2.15, w: 4.25, h: 3.9, fontSize: 11, color: C.textMed, fontFace: F, paraSpaceAfter: 10, valign: "top" });
}

// ── 10. REFERENCE APP ───────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "REFERENCE APPLICATION", "Online Boutique — a real e-commerce shop, from one document");
  const stats = [
    { v: "11", l: "gRPC microservices" }, { v: "5", l: "Languages" }, { v: "64", l: "Manifests generated" },
    { v: "19", l: "Matrix rows" }, { v: "33", l: "Network policies" }, { v: "1", l: "Document" },
  ];
  stats.forEach((st, i) => {
    const x = 0.45 + i * 2.16;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 1.55, w: 1.95, h: 1.15, fill: { color: C.pBlue }, line: { color: C.tcsBlue, width: 1.25 }, rectRadius: 0.07 });
    s.addText(st.v, { x, y: 1.65, w: 1.95, h: 0.5, fontSize: 24, bold: true, color: C.tcsBlue, align: "center", fontFace: F });
    s.addText(st.l, { x, y: 2.18, w: 1.95, h: 0.4, fontSize: 9, color: C.textMed, align: "center", fontFace: F });
  });
  s.addText("One placed order crosses:", { x: 0.45, y: 3.05, w: 12.4, h: 0.3, fontSize: 12.5, bold: true, color: C.navy, fontFace: F });
  const chain = ["frontend", "checkout", "catalog · shipping · payment · email · currency", "cart", "Redis"];
  let cx = 0.45;
  const widths = [1.7, 1.7, 5.0, 1.4, 1.4];
  chain.forEach((t, i) => {
    box(s, { x: cx, y: 3.45, w: widths[i], h: 0.7, fill: i === chain.length - 1 ? C.lRed : C.lBlue, line: i === chain.length - 1 ? C.secRed : C.tcsBlue, text: t, fs: 10.5 });
    cx += widths[i];
    if (i < chain.length - 1) { arrow(s, cx + 0.02, 3.65, 0.26); cx += 0.3; }
  });
  s.addText("— every hop crossing a network policy the document declared. Synthetic shoppers (Locust) keep the store busy from the moment it is up.",
    { x: 0.45, y: 4.3, w: 12.4, h: 0.35, fontSize: 11, color: C.textMed, fontFace: F });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 4.85, w: 12.4, h: 1.35, fill: { color: C.lGreen }, line: { color: C.autoGreen, width: 1.5 }, rectRadius: 0.08 });
  s.addText("Why this exact app", { x: 0.7, y: 5.0, w: 11.9, h: 0.3, fontSize: 12.5, bold: true, color: "065F46", fontFace: F });
  s.addText("Its images run as non-root under arbitrary UIDs — it deploys on OpenShift's restricted SCC with zero security grants. The other famous demo shops (Sock Shop, robot-shop) do not.",
    { x: 0.7, y: 5.35, w: 11.9, h: 0.7, fontSize: 11, color: C.navy, fontFace: F, valign: "top" });
}

// ── 11. HARDENED IN THE FIELD ───────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "HARDENED IN THE FIELD", "Every defect the pyramid caught became a unit test — the honesty story");
  const rows = [
    hdr(["What the field run showed", "Root cause", "Now pinned by"]),
    [{ text: "Dry-run: \"1 ok, 16 failed\" on a fresh app" }, { text: "The API server 404s namespaced resources before admission when the namespace doesn't exist yet" }, { text: "Dry-run prepares target namespaces, then validates all 64 objects" }],
    [{ text: "Deploy: 33 network policies rejected (422)" }, { text: "Fuzzy column matching read the To column as the protocol (\"proTOcol\" contains \"to\")" }, { text: "Exact-match header resolution + TCP/UDP/SCTP whitelist, asserted at both layers" }],
    [{ text: "Every gRPC pod 0/1, restart loops" }, { text: "Exec probes assumed a shell — the boutique's images are distroless" }, { text: "Kubelet-native gRPC probes; argv exec without sh" }],
    [{ text: "frontend CrashLoopBackOff" }, { text: "v0.10 requires SHOPPING_ASSISTANT_SERVICE_ADDR even when unused" }, { text: "Placeholder env in the document, with the reason recorded" }],
    [{ text: "(design review) egress deny with no allows" }, { text: "Generated deny-all blocked DNS and every tier-to-tier call" }, { text: "Matrix generates BOTH directions + DNS egress — the one-contract rule" }],
  ];
  table(s, rows, { y: 1.55, colW: [3.7, 4.6, 4.1], fontSize: 9.5 });
  footNote(s, "This slide is the proof the verification story is real: the pyramid caught its own product's bugs before a user did.", C.aiPurple);
}

// ── 12. BUSINESS VALUE ──────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "BUSINESS VALUE", "Manual baseline vs UC-07");
  const rows = [
    hdr(["Metric", "Manual baseline", "UC-07"]),
    [{ text: "Requirement → running app", options: { bold: true } }, { text: "Days — ticket, YAML authoring, review cycles", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "Minutes, from a reviewed document", options: { color: "065F46", fill: { color: C.lGreen } } }],
    [{ text: "YAML by hand", options: { bold: true } }, { text: "~2,000 lines for a three-tier app", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "0 — generated, 64 manifests", options: { color: "065F46", fill: { color: C.lGreen } } }],
    [{ text: "Security posture", options: { bold: true } }, { text: "Varies by engineer and deadline", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "Identical, generated, unit-tested", options: { color: "065F46", fill: { color: C.lGreen } } }],
    [{ text: "\"Who deployed what, from what?\"", options: { bold: true } }, { text: "Archaeology", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "Record cites Git URL · CR number · verification result", options: { color: "065F46", fill: { color: C.lGreen } } }],
    [{ text: "Definition of done", options: { bold: true } }, { text: "\"Pods are green\"", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "A probed URL and a four-level proof", options: { color: "065F46", fill: { color: C.lGreen } } }],
    [{ text: "Re-deploy after a change", options: { bold: true } }, { text: "Re-apply and hope", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "created / configured / unchanged, per object", options: { color: "065F46", fill: { color: C.lGreen } } }],
  ];
  table(s, rows, { y: 1.6, colW: [3.3, 4.4, 4.7], fontSize: 10.5 });
}

// ── 13. SAMPLE DOCUMENTS ────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "KNOWN-GOOD INPUTS", "Four sample documents — each shipped in .md and .docx, pinned by round-trip tests");
  const docs = [
    { n: "01 · hello-web", d: "One nginx tier, TLS route, probes. The pipeline smoke test.", r: "Green in ~90 seconds", c: C.autoGreen, bg: C.lGreen },
    { n: "02 · three-tier-orders", d: "Web + API + PostgreSQL 15: generated Secret, PVC, init-SQL Job as the functional DB proof, matrix with a negative control, HPA.", r: "Green in 2–4 minutes", c: C.autoGreen, bg: C.lGreen },
    { n: "03 · negative-broken-image", d: "Bad image tag — the rollout can never complete. Exists so audiences watch the pyramid fail honestly.", r: "RED at level 1, by design", c: C.secRed, bg: C.lRed },
    { n: "04 · online-boutique", d: "The e-commerce reference: 11 services + Redis + synthetic shoppers → 64 manifests from one document.", r: "Green in 3–6 minutes", c: C.autoGreen, bg: C.lGreen },
  ];
  docs.forEach((d, i) => {
    const x = 0.45 + (i % 2) * 6.3, y = 1.55 + Math.floor(i / 2) * 2.4;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 6.05, h: 2.15, fill: { color: C.white }, line: { color: d.c, width: 1.5 }, rectRadius: 0.08 });
    s.addText(d.n, { x: x + 0.25, y: y + 0.15, w: 5.5, h: 0.35, fontSize: 14, bold: true, color: d.c, fontFace: F });
    s.addText(d.d, { x: x + 0.25, y: y + 0.55, w: 5.55, h: 1.0, fontSize: 10.5, color: C.navy, fontFace: F, valign: "top" });
    s.addText(d.r, { x: x + 0.25, y: y + 1.62, w: 5.55, h: 0.35, fontSize: 11, bold: true, color: d.c, fontFace: F });
  });
  footNote(s, "docs/sample-requirements/ — copy 02 as the template for your own applications. The tables are the contract; the prose is free.");
}

// ── 14. DEMO SCRIPT ─────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "DEMO SCRIPT", "Six minutes, ending in a purchase");
  const rows = [
    hdr(["Minute", "Beat", "Say"]),
    [{ text: "0–1", options: { bold: true } }, { text: "The document in GitHub (or Word)" }, { text: "\"This is the deployment. Not YAML — a reviewed, versioned requirement document.\"" }],
    [{ text: "1–2", options: { bold: true } }, { text: "Load from Git → Generate" }, { text: "\"Deterministic: 12 tiers, 64 manifests, no AI paraphrase. Paste plain prose instead — and the LLM architects it under the same hardening contract.\"" }],
    [{ text: "2–3", options: { bold: true } }, { text: "CIS + CVE scan → Dry-run" }, { text: "\"Shift-left: the API server validated all 64 objects before anything ran.\"" }],
    [{ text: "3–5", options: { bold: true } }, { text: "Deploy → pod watch → pyramid" }, { text: "\"Server-side apply, a ServiceNow change citing the document — then the platform proves it: rollout, stability, wiring, and it browses to the shop itself.\"" }],
    [{ text: "5–6", options: { bold: true } }, { text: "Open application → place an order" }, { text: "\"One click crosses nine services and Redis, every hop through a policy this document declared. Had any level gone red — the RCA agent takes it from there.\"" }],
  ];
  table(s, rows, { y: 1.55, colW: [1.0, 3.2, 8.2], fontSize: 10.5 });
  footNote(s, "60-second encore: deploy 03-negative and watch the pyramid fail honestly.", C.userAmber);
}

// ── 15. STATUS ──────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "VERIFICATION STATUS", "What is live vs what is roadmap — stated plainly");
  const rows = [
    hdr(["Claim", "Status"]),
    [{ text: "Deterministic extraction — .md and .docx extract identically" }, { text: "✅ VERIFIED — round-trip unit tests", options: { color: "065F46", fill: { color: C.lGreen }, bold: true } }],
    [{ text: "64-manifest generation, zero-trust matrix both directions" }, { text: "✅ VERIFIED — live on the lab cluster", options: { color: "065F46", fill: { color: C.lGreen }, bold: true } }],
    [{ text: "Server-side apply · dry-run with namespace preparation" }, { text: "✅ VERIFIED — live", options: { color: "065F46", fill: { color: C.lGreen }, bold: true } }],
    [{ text: "Verification pyramid incl. URL probe" }, { text: "✅ VERIFIED — live", options: { color: "065F46", fill: { color: C.lGreen }, bold: true } }],
    [{ text: "Git fetch (blob → raw) → deterministic generate" }, { text: "✅ VERIFIED — against the GitHub branch", options: { color: "065F46", fill: { color: C.lGreen }, bold: true } }],
    [{ text: "ServiceNow change record per deploy" }, { text: "✅ VERIFIED — CHG0030065 in the lab", options: { color: "065F46", fill: { color: C.lGreen }, bold: true } }],
    [{ text: "RCA-agent auto-investigation of a red level" }, { text: "🔶 ROADMAP — UC-05 machinery exists, hand-off next", options: { color: "92400E", fill: { color: C.lAmber }, bold: true } }],
    [{ text: "Webhook auto-deploy · promotion · Argo CD hand-off" }, { text: "🔶 ROADMAP — design settled", options: { color: "92400E", fill: { color: C.lAmber }, bold: true } }],
  ];
  table(s, rows, { y: 1.55, colW: [7.6, 4.8], fontSize: 10.5 });
  footNote(s, "Deliberately honest: VERIFIED ran against a live cluster or is pinned by the 93-test suite. ROADMAP is a design, not a demo.", C.userAmber);
}

// ── 16. CLOSING ─────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  s.background = { color: C.darkNavy };
  s.addText("The requirement document IS the deployment.", { x: 0.8, y: 2.3, w: 11.7, h: 0.7, fontSize: 32, color: C.white, bold: true, fontFace: F });
  s.addText("Versioned in Git. Deterministic on the wire. Verified until a human can click the URL.",
    { x: 0.8, y: 3.15, w: 11.7, h: 0.45, fontSize: 17, color: "94A3B8", fontFace: F });
  s.addText("Generation may be creative — verification never is.",
    { x: 0.8, y: 3.85, w: 11.7, h: 0.4, fontSize: 15, color: C.lAmber, italic: true, fontFace: F });
  s.addText("TCS Agentic AI for Hybrid Infrastructure  ·  UC-07  ·  Tata Consultancy Services",
    { x: 0.8, y: 6.45, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", fontFace: F });
}

pptx.writeFile({ fileName: OUT }).then(() => {
  console.log(`Wrote ${OUT}`);
});
