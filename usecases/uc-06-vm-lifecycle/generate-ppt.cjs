/**
 * TCS Agentic AI — UC-06: Governed VM Provisioning & Lifecycle
 * Generates: TCS-Agentic-AI-UC06-VM-Lifecycle.pptx (beside this script)
 *
 * Run: node usecases/uc-06-vm-lifecycle/generate-ppt.cjs
 */
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "TCS-Agentic-AI-UC06-VM-Lifecycle.pptx");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const pptx = new PptxGenJS();
pptx.author = "TCS Agentic AI Platform";
pptx.title = "TCS Agentic AI — Governed VM Provisioning & Lifecycle · UC-06";
pptx.subject = "UC-06 — governed VM provisioning and day-2 ownership for OpenShift Virtualization";
pptx.company = "Tata Consultancy Services";
pptx.layout = "LAYOUT_WIDE";

// Same palette as the UC-05 deck so the two read as one family.
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
  s.addText("UC-06", { x: 11.62, y: 0.2, w: 1.35, h: 0.34, fontSize: 13, color: C.white, bold: true, align: "center", fontFace: F,
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
  s.addText("TCS AGENTIC AI   ·   USE CASE 06", { x: 0.8, y: 1.62, w: 8, h: 0.3, fontSize: 13, color: C.valCyan, bold: true, charSpacing: 3, fontFace: F });
  s.addText("Governed VM Provisioning & Lifecycle", { x: 0.8, y: 1.98, w: 11.6, h: 0.85, fontSize: 38, color: C.white, bold: true, fontFace: F });
  s.addText("OpenShift Virtualization  ·  human-initiated, agent-executed",
    { x: 0.8, y: 3.5, w: 11.6, h: 0.4, fontSize: 15.5, color: "94A3B8", fontFace: F });
  s.addText("“The console creates a VM. It does not remember why.”",
    { x: 0.8, y: 4.05, w: 11.6, h: 0.4, fontSize: 15, color: C.lAmber, italic: true, fontFace: F });

  const stats = [
    { v: "1", l: "Human decision" }, { v: "22", l: "Automatic steps" },
    { v: "1", l: "AI step — intent only" }, { v: "6", l: "Provenance fields" }, { v: "0", l: "Autonomous paths" },
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
  head(s, "THE PROBLEM", "Provisioning is solved. Owning the result is not.");
  const items = [
    { t: "Quota checked after the fact", d: "The request is approved, then fails — or succeeds and quietly starves something else.", c: C.secRed, bg: C.lRed },
    { t: "Sizing is guesswork", d: "Copy the last request. Nobody sees the gap between what was asked for and what exists.", c: C.orange, bg: C.lOrange },
    { t: "Nobody records WHY", d: "The rationale for 8 vCPU dies with the ticket that requested it.", c: C.userAmber, bg: C.lAmber },
    { t: "\"Expires on\" is decorative", d: "Every request form has the field. Almost no platform ever acts on it.", c: C.aiPurple, bg: C.lPurple },
    { t: "No owner of record", d: "Six months on, nobody knows whose VM it is or whether it can go.", c: C.tcsBlue, bg: C.lBlue },
    { t: "Right-sizing never happens", d: "A machine at 12 % memory since build day stays that way until an audit.", c: C.slate, bg: C.lSlate },
  ];
  items.forEach((it, i) => {
    const x = 0.45 + (i % 3) * 4.18, y = 1.55 + Math.floor(i / 3) * 2.35;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.95, h: 2.05, fill: { color: it.bg }, line: { color: it.c, width: 1.25 }, rectRadius: 0.08 });
    s.addText(it.t, { x: x + 0.2, y: y + 0.18, w: 3.55, h: 0.4, fontSize: 13.5, bold: true, color: it.c, fontFace: F });
    s.addText(it.d, { x: x + 0.2, y: y + 0.62, w: 3.55, h: 1.25, fontSize: 10.5, color: C.navy, fontFace: F, valign: "top" });
  });
  footNote(s, "OpenShift Virtualization builds the VM in ninety seconds. UC-06 is everything either side of that moment.");
}

// ── 3. WHO DOES WHAT ────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "ACTOR MODEL", "Who does what — and what the AI is deliberately not allowed to do");
  const acts = [
    { i: "🤖", n: "AI", c: C.aiPurple, bg: C.lPurple, w: "Turns one sentence into a typed request. That is all.",
      d: "Never chooses the image, the manifest or the command. Never produces an SSH key — a model inventing a credential has no acceptable version." },
    { i: "⚙️", n: "AUTOMATIC", c: C.tcsBlue, bg: C.lBlue, w: "Deterministic code — no AI, no human.",
      d: "Catalogue discovery, template reconciliation, pre-flight, manifest build, dry-run, apply, ledger, expiry sweep, right-sizing." },
    { i: "👤", n: "MANUAL", c: C.userAmber, bg: C.lAmber, w: "Correct the request, then approve it.",
      d: "In the console, or via a ServiceNow change board. There is no third path and no autonomous path." },
  ];
  acts.forEach((a, i) => {
    const x = 0.45 + i * 4.18;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 1.5, w: 3.95, h: 3.5, fill: { color: a.bg }, line: { color: a.c, width: 1.5 }, rectRadius: 0.1 });
    s.addText(a.i, { x, y: 1.68, w: 3.95, h: 0.6, fontSize: 30, align: "center", fontFace: F });
    s.addText(a.n, { x, y: 2.32, w: 3.95, h: 0.4, fontSize: 16, bold: true, color: a.c, align: "center", fontFace: F });
    s.addText(a.w, { x: x + 0.22, y: 2.78, w: 3.5, h: 0.6, fontSize: 11.5, bold: true, color: C.navy, align: "center", fontFace: F });
    s.addText(a.d, { x: x + 0.22, y: 3.4, w: 3.5, h: 1.45, fontSize: 10, color: C.textMed, align: "center", valign: "top", fontFace: F });
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 5.25, w: 12.4, h: 1.05, fill: { color: C.lGreen }, line: { color: C.autoGreen, width: 1.5 }, rectRadius: 0.08 });
  s.addText("UC-05 is agent-initiated — nothing triggers it, which is its whole point.\nUC-06 is never autonomous: provisioning consumes quota, addresses, licences and money, so a person always decides.",
    { x: 0.7, y: 5.4, w: 11.9, h: 0.8, fontSize: 12.5, bold: true, color: "065F46", align: "center", fontFace: F });
}

// ── 4. MASTER WORKFLOW ──────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "END-TO-END WORKFLOW", "Colour-coded by actor", "Blue = deterministic · Purple = the one AI step · Amber = the human");

  s.addText("CAPTURE", { x: 0.45, y: 1.42, w: 3.9, h: 0.25, fontSize: 9.5, bold: true, color: C.slate, charSpacing: 1.2, fontFace: F });
  box(s, { x: 0.45, y: 1.7, w: 1.85, h: 0.78, fill: C.lAmber, line: C.userAmber, text: "👤 One sentence", sub: "in chat", fs: 10.5 });
  arrow(s, 2.32, 1.95);
  box(s, { x: 2.66, y: 1.7, w: 1.7, h: 0.78, fill: C.lPurple, line: C.aiPurple, text: "🤖 Extract intent", sub: "typed VMRequest", fs: 10.5 });

  s.addText("RECONCILE & PRE-FLIGHT", { x: 4.62, y: 1.42, w: 4.5, h: 0.25, fontSize: 9.5, bold: true, color: C.slate, charSpacing: 1.2, fontFace: F });
  arrow(s, 4.38, 1.95);
  box(s, { x: 4.62, y: 1.7, w: 1.85, h: 0.78, fill: C.lBlue, line: C.tcsBlue, text: "⚙️ Reconcile size", sub: "delta stated", fs: 10.5 });
  arrow(s, 6.49, 1.95);
  box(s, { x: 6.73, y: 1.7, w: 2.35, h: 0.78, fill: C.lBlue, line: C.tcsBlue, text: "⚙️ Pre-flight, live cluster", sub: "quota · name · image · NAD · key", fs: 10.5 });
  arrow(s, 9.1, 1.95);
  box(s, { x: 9.34, y: 1.7, w: 1.7, h: 0.78, fill: C.lBlue, line: C.tcsBlue, text: "⚙️ Dry-run", sub: "nothing created", fs: 10.5 });

  // The gate
  s.addShape(pptx.ShapeType.roundRect, { x: 11.2, y: 1.62, w: 1.65, h: 0.94, fill: { color: C.userAmber }, line: { color: "92400E", width: 2 }, rectRadius: 0.08 });
  s.addText("👤 APPROVE", { x: 11.2, y: 1.72, w: 1.65, h: 0.4, fontSize: 11.5, bold: true, color: C.white, align: "center", fontFace: F });
  s.addText("the only gate", { x: 11.2, y: 2.1, w: 1.65, h: 0.34, fontSize: 8.5, color: "FEF3C7", align: "center", fontFace: F });

  // Two approval paths
  s.addText("TWO PATHS TO THAT ONE GATE", { x: 0.45, y: 2.78, w: 6, h: 0.25, fontSize: 9.5, bold: true, color: C.slate, charSpacing: 1.2, fontFace: F });
  box(s, { x: 0.45, y: 3.06, w: 6.05, h: 0.72, fill: C.lAmber, line: C.userAmber, text: "👤 Approve in the console", sub: "fast path — platform team owns the decision", fs: 11 });
  box(s, { x: 6.8, y: 3.06, w: 6.05, h: 0.72, fill: C.lAmber, line: C.userAmber, text: "👤 Approve as a ServiceNow change", sub: "change-controlled estate — the CAB is the authority", fs: 11 });

  s.addText("PROVISION", { x: 0.45, y: 4.02, w: 5, h: 0.25, fontSize: 9.5, bold: true, color: C.slate, charSpacing: 1.2, fontFace: F });
  const steps = [
    ["⚙️ Re-check pre-flight", "the cluster moved on"],
    ["⚙️ Apply manifest", "DataVolume + cloud-init"],
    ["⚙️ Ledger the change", "inverse = decommission"],
    ["⚙️ Return access", "virtctl ssh · console · IP"],
  ];
  steps.forEach((st, i) => {
    const x = 0.45 + i * 3.2;
    box(s, { x, y: 4.3, w: 2.95, h: 0.78, fill: C.lBlue, line: C.tcsBlue, text: st[0], sub: st[1], fs: 10.5 });
    if (i < 3) arrow(s, x + 2.97, 4.55);
  });

  s.addText("OWNERSHIP — the part nobody else does", { x: 0.45, y: 5.32, w: 8, h: 0.25, fontSize: 9.5, bold: true, color: C.slate, charSpacing: 1.2, fontFace: F });
  const own = [
    ["⚙️ Provenance on the VM", "owner · cost centre · CR · expiry"],
    ["⚙️ Right-size later", "cites the original request"],
    ["⚙️ Enforce the expiry", "decommission change request"],
    ["⚙️ Health detection", "feeds UC-05's pipeline"],
  ];
  own.forEach((st, i) => {
    const x = 0.45 + i * 3.2;
    box(s, { x, y: 5.6, w: 2.95, h: 0.78, fill: C.lGreen, line: C.autoGreen, text: st[0], sub: st[1], fs: 10.5 });
  });
}

// ── 5. EFFORT SPLIT ─────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "EFFORT SPLIT", "Twenty-two automatic steps. One AI step. Two human touches.");
  s.addChart(pptx.ChartType.doughnut, [{
    name: "Effort", labels: ["⚙️ Automatic", "👤 Manual", "🤖 AI"], values: [22, 2, 1],
  }], {
    x: 0.6, y: 1.6, w: 5.6, h: 4.5, holeSize: 52, showLegend: true, legendPos: "b", legendFontSize: 11,
    chartColors: [C.tcsBlue, C.userAmber, C.aiPurple], dataBorder: { pt: 2, color: C.white },
    showValue: true, dataLabelFontSize: 12, dataLabelColor: C.white, dataLabelFontBold: true,
  });
  const rows = [
    hdr(["Actor", "Steps", "What it covers"]),
    [{ text: "⚙️ Automatic" }, { text: "22" }, { text: "Catalogue, reconciliation, pre-flight, dry-run, apply, ledger, access, expiry, right-sizing" }],
    [{ text: "👤 Manual" }, { text: "2" }, { text: "Correct the pre-filled request · approve it once" }],
    [{ text: "🤖 AI" }, { text: "1" }, { text: "Extract intent from free text into a typed struct" }],
  ];
  table(s, rows, { x: 6.6, y: 1.9, w: 6.25, colW: [1.6, 0.75, 3.9], fontSize: 10 });
  s.addShape(pptx.ShapeType.roundRect, { x: 6.6, y: 4.0, w: 6.25, h: 2.1, fill: { color: C.lAmber }, line: { color: C.userAmber, width: 1.5 }, rectRadius: 0.08 });
  s.addText("The second human touch is optional", { x: 6.85, y: 4.15, w: 5.75, h: 0.35, fontSize: 13, bold: true, color: "92400E", fontFace: F });
  s.addText("A pre-filled card that already passes pre-flight often needs no correction at all. In practice the operator reads the reconciliation line, checks the quota bar, and approves.\n\nIn a change-controlled estate that approval moves to the CAB — the platform then waits, re-checks, and provisions unattended.",
    { x: 6.85, y: 4.55, w: 5.75, h: 1.45, fontSize: 10.5, color: C.navy, valign: "top", fontFace: F });
}

// ── 6. WHAT MAKES A VM REAL ─────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "PHASE 1 — THE UNGLAMOROUS HALF", "What separates a provisioned VM from a demo");
  const rows = [
    hdr(["", "Before", "UC-06"]),
    [{ text: "Root disk", options: { bold: true } }, { text: "containerDisk / emptyDisk — wiped on every restart", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "dataVolumeTemplate → a real PVC that survives", options: { color: "065F46", fill: { color: C.lGreen } } }],
    [{ text: "Access", options: { bold: true } }, { text: "no cloud-init — the VM boots and nobody can log in", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "user, SSH key, hostname; password login disabled", options: { color: "065F46", fill: { color: C.lGreen } } }],
    [{ text: "Sizing", options: { bold: true } }, { text: "raw cpu / memory numbers", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "ClusterInstancetype + Preference — golden sizes", options: { color: "065F46", fill: { color: C.lGreen } } }],
    [{ text: "Network", options: { bold: true } }, { text: "pod network, masquerade only", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "NetworkAttachmentDefinition for bridge / VLAN", options: { color: "065F46", fill: { color: C.lGreen } } }],
    [{ text: "Safety", options: { bold: true } }, { text: "direct POST to the API", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "server-side dry-run, then an approval gate", options: { color: "065F46", fill: { color: C.lGreen } } }],
    [{ text: "Memory of it", options: { bold: true } }, { text: "none", options: { color: "991B1B", fill: { color: C.lRed } } }, { text: "owner · cost centre · request id · expiry · rationale", options: { color: "065F46", fill: { color: C.lGreen } } }],
  ];
  table(s, rows, { y: 1.6, colW: [2.1, 4.9, 5.4], fontSize: 10.5 });
  footNote(s, "A VM whose disk is wiped on restart and that nobody can SSH into is not provisioning. It is a demo.", C.secRed);
}

// ── 7. SIZING RECONCILIATION ────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "THE DIFFERENTIATOR", "Sizing reconciliation — the compromise, stated");
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 1.5, w: 12.4, h: 1.0, fill: { color: C.lAmber }, line: { color: C.userAmber, width: 1.5 }, rectRadius: 0.08 });
  s.addText("“You asked for 6 vCPU and 20Gi. The nearest standard size is u1.large (8 vCPU / 32Gi) — that is +2 vCPU and +12Gi more than requested.”",
    { x: 0.7, y: 1.62, w: 11.9, h: 0.76, fontSize: 15, bold: true, italic: true, color: "92400E", align: "center", valign: "middle", fontFace: F });

  const cards = [
    { t: "exact", d: "The request matches a standard size precisely. Said so, rather than left implied.", c: C.autoGreen, bg: C.lGreen },
    { t: "rounded-up", d: "Nearest standard that meets or exceeds both dimensions — with the delta named in vCPU and GiB.", c: C.tcsBlue, bg: C.lBlue },
    { t: "exceeds-catalogue", d: "Nothing on this cluster is large enough. Needs an explicit size and an exception, not a silent downgrade.", c: C.orange, bg: C.lOrange },
    { t: "none-available", d: "No instance types exist here, so the VM is sized explicitly and the fact is stated.", c: C.slate, bg: C.lSlate },
  ];
  cards.forEach((cd, i) => {
    const x = 0.45 + i * 3.14;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 2.8, w: 2.95, h: 2.2, fill: { color: cd.bg }, line: { color: cd.c, width: 1.25 }, rectRadius: 0.08 });
    s.addText(cd.t, { x: x + 0.15, y: 2.95, w: 2.65, h: 0.4, fontSize: 13, bold: true, color: cd.c, align: "center", fontFace: F });
    s.addText(cd.d, { x: x + 0.18, y: 3.4, w: 2.6, h: 1.45, fontSize: 10, color: C.navy, align: "center", valign: "top", fontFace: F });
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 5.3, w: 12.4, h: 1.0, fill: { color: C.pBlue }, line: { color: C.tcsBlue, width: 1.25 }, rectRadius: 0.08 });
  s.addText("A web form takes what you type. It cannot tell you what the compromise is — and the compromise is exactly what platform teams argue about.",
    { x: 0.7, y: 5.45, w: 11.9, h: 0.7, fontSize: 13, bold: true, color: "1E40AF", align: "center", valign: "middle", fontFace: F });
}

// ── 8. PRE-FLIGHT ───────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "PRE-FLIGHT", "Everything checked before anyone is asked to approve");
  const rows = [
    hdr(["Check", "Blocks?", "Why it matters"]),
    [{ text: "Namespace exists and is not platform-owned" }, { text: "BLOCK", options: { color: "991B1B", bold: true } }, { text: "kube-*, openshift-* and default are refused outright" }],
    [{ text: "Name free — for every VM in the batch" }, { text: "BLOCK", options: { color: "991B1B", bold: true } }, { text: "A partial batch failure is worse than none at all" }],
    [{ text: "Golden image present" }, { text: "BLOCK", options: { color: "991B1B", bold: true } }, { text: "Without it the DataVolume never populates" }],
    [{ text: "Golden image Ready" }, { text: "warn", options: { color: "92400E", bold: true } }, { text: "The VM would sit importing for a long time" }],
    [{ text: "Storage class exists" }, { text: "BLOCK", options: { color: "991B1B", bold: true } }, { text: "The PVC would stay Pending forever" }],
    [{ text: "NetworkAttachmentDefinition exists" }, { text: "BLOCK", options: { color: "991B1B", bold: true } }, { text: "The VM would come up with no network" }],
    [{ text: "SSH key supplied" }, { text: "BLOCK", options: { color: "991B1B", bold: true } }, { text: "A VM nobody can log in to is not provisioning" }],
    [{ text: "Quota headroom, per ResourceQuota" }, { text: "BLOCK / warn", options: { color: "991B1B", bold: true } }, { text: "Exceeding blocks; ≥ 85 % warns before you commit" }],
    [{ text: "Owner recorded" }, { text: "warn", options: { color: "92400E", bold: true } }, { text: "Nobody to contact when it needs attention" }],
    [{ text: "Expiry date set" }, { text: "warn", options: { color: "92400E", bold: true } }, { text: "VMs without one are how sprawl starts" }],
  ];
  table(s, rows, { y: 1.55, colW: [4.6, 1.9, 5.9], fontSize: 10 });
  footNote(s, "Pre-flight runs BEFORE submission — and AGAIN after approval, because an approval can sit for days while the cluster moves on.");
}

// ── 9. APPROVAL STATE MACHINE ───────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "APPROVAL", "A submitted request outlives the browser — so it is durable state");
  const states = [
    { n: "draft", d: "captured, editable", c: C.slate, bg: C.lSlate },
    { n: "submitted", d: "CR raised · waiting", c: C.tcsBlue, bg: C.lBlue },
    { n: "approved", d: "CAB said yes", c: C.userAmber, bg: C.lAmber },
    { n: "provisioning", d: "applying now", c: C.aiPurple, bg: C.lPurple },
    { n: "provisioned", d: "created + ledgered", c: C.autoGreen, bg: C.lGreen },
  ];
  states.forEach((st, i) => {
    const x = 0.45 + i * 2.6;
    box(s, { x, y: 1.75, w: 2.35, h: 0.95, fill: st.bg, line: st.c, text: st.n, sub: st.d, fs: 12, tColor: st.c });
    if (i < 4) arrow(s, x + 2.38, 2.1);
  });
  const terms = [
    { n: "rejected", d: "CAB refused — nothing created", c: C.secRed, bg: C.lRed },
    { n: "cancelled", d: "requester withdrew it", c: C.slate, bg: C.lSlate },
    { n: "failed", d: "apply failed, or pre-flight no longer passes", c: C.secRed, bg: C.lRed },
  ];
  s.addText("TERMINAL STATES", { x: 0.45, y: 3.0, w: 5, h: 0.25, fontSize: 9.5, bold: true, color: C.slate, charSpacing: 1.2, fontFace: F });
  terms.forEach((st, i) => {
    const x = 0.45 + i * 4.18;
    box(s, { x, y: 3.28, w: 3.95, h: 0.85, fill: st.bg, line: st.c, text: st.n, sub: st.d, fs: 12, tColor: st.c });
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 4.42, w: 12.4, h: 1.85, fill: { color: C.pBlue }, line: { color: C.tcsBlue, width: 1.5 }, rectRadius: 0.08 });
  s.addText("The detail that matters", { x: 0.72, y: 4.56, w: 11.9, h: 0.35, fontSize: 14, bold: true, color: "1E40AF", fontFace: F });
  s.addText("Pre-flight runs BEFORE submission — there is no point asking a change board to approve something that cannot succeed.\n\nIt runs AGAIN after approval. An approval can sit for days and the cluster moves on: the name may now be taken, the quota consumed. If it no longer passes, the request FAILS WITH THE REASON rather than provisioning something different from what was approved.",
    { x: 0.72, y: 4.95, w: 11.9, h: 1.2, fontSize: 11.5, color: C.navy, valign: "top", fontFace: F });
}

// ── 10. PROVENANCE ──────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "PROVENANCE", "Six values written onto the VM — and why they matter later");
  const rows = [
    hdr(["Label / annotation", "Purpose"]),
    [{ text: "app.kubernetes.io/managed-by", options: { bold: true } }, { text: "The agent claims ONLY what it built. Hand-made VMs are never touched." }],
    [{ text: "tcs.ai/owner" }, { text: "Who to contact when it needs attention" }],
    [{ text: "tcs.ai/cost-centre" }, { text: "Chargeback and showback" }],
    [{ text: "tcs.ai/environment" }, { text: "dev / test / prod — drives the change risk rating" }],
    [{ text: "tcs.ai/request-id" }, { text: "The change request this VM came from" }],
    [{ text: "tcs.ai/expires-on" }, { text: "The decommission date — made enforceable, not decorative" }],
    [{ text: "tcs.ai/sizing-rationale" }, { text: "WHY this size. Read back when right-sizing months later." }],
  ];
  table(s, rows, { y: 1.6, colW: [4.4, 8.0], fontSize: 11 });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 5.35, w: 12.4, h: 0.95, fill: { color: C.lGreen }, line: { color: C.autoGreen, width: 1.5 }, rectRadius: 0.08 });
  s.addText("Without provenance a platform can provision.  With it, a platform can be accountable.",
    { x: 0.7, y: 5.5, w: 11.9, h: 0.65, fontSize: 15, bold: true, color: "065F46", align: "center", valign: "middle", fontFace: F });
}

// ── 11. THE LOOP CLOSING ────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "OWNERSHIP", "The claim a competitor cannot copy");
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 1.5, w: 12.4, h: 1.35, fill: { color: C.darkNavy }, line: { color: C.valCyan, width: 1.5 }, rectRadius: 0.08 });
  s.addText("“This VM was provisioned under CHG0041022 on 12 March, sized u1.large.\nSince then, memory has been at 94 % of 32Gi over eleven days. Recommend increasing it to u1.xlarge.”",
    { x: 0.75, y: 1.65, w: 11.8, h: 1.05, fontSize: 15, bold: true, italic: true, color: C.lCyan, align: "center", valign: "middle", fontFace: F });
  s.addText("— unprompted, weeks later, with the change request already prepared",
    { x: 0.45, y: 2.92, w: 12.4, h: 0.3, fontSize: 11, color: C.slate, align: "center", fontFace: F });

  const three = [
    { t: "Right-size", d: "Observed usage against the size we chose. Only running VMs, only after a sustain window — and absent metrics mean “cannot judge”, never “idle”.", c: C.tcsBlue, bg: C.lBlue },
    { t: "Enforce expiry", d: "Past its recorded date → a decommission change request with the backout plan filled in. Every form has this field; almost nobody acts on it.", c: C.userAmber, bg: C.lAmber },
    { t: "Detect health", d: "VM set to run but not Ready · guest filesystem filling up. Flows into UC-05's existing incident pipeline rather than a parallel one.", c: C.autoGreen, bg: C.lGreen },
  ];
  three.forEach((c3, i) => {
    const x = 0.45 + i * 4.18;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 3.35, w: 3.95, h: 2.3, fill: { color: c3.bg }, line: { color: c3.c, width: 1.25 }, rectRadius: 0.08 });
    s.addText(c3.t, { x: x + 0.18, y: 3.5, w: 3.6, h: 0.4, fontSize: 14, bold: true, color: c3.c, fontFace: F });
    s.addText(c3.d, { x: x + 0.18, y: 3.95, w: 3.6, h: 1.55, fontSize: 10.5, color: C.navy, valign: "top", fontFace: F });
  });
  footNote(s, "Only an agent that provisioned the VM AND operates the estate can write that sentence.");
}

// ── 12. MANUAL VS UC-06 ─────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "BEFORE / AFTER", "Manual provisioning versus UC-06");
  const rows = [
    hdr(["Step", "Manual today", "UC-06"]),
    [{ text: "Capture the request" }, { text: "Ticket, email, spreadsheet" }, { text: "One sentence" }],
    [{ text: "Check quota" }, { text: "Rarely, and after the fact" }, { text: "Before approval, per ResourceQuota" }],
    [{ text: "Choose a size" }, { text: "Guesswork, or copy the last one" }, { text: "Reconciled to a standard, delta shown" }],
    [{ text: "Validate" }, { text: "Find out when it fails" }, { text: "Server-side dry-run" }],
    [{ text: "Change record" }, { text: "Written by hand" }, { text: "Raised automatically with a backout plan" }],
    [{ text: "Record the owner" }, { text: "A wiki page that rots" }, { text: "On the object itself" }],
    [{ text: "Expiry" }, { text: "A field nobody reads" }, { text: "Enforced, with a decommission CR" }],
    [{ text: "Right-size later" }, { text: "Never happens" }, { text: "Unprompted, citing the original request" }],
    [{ text: "Decommission" }, { text: "Whenever someone notices" }, { text: "A change request on the expiry date" }],
  ];
  table(s, rows, { y: 1.55, colW: [2.9, 4.6, 4.9], fontSize: 10 });
  footNote(s, "Provisioning is a transaction. Ownership is a lifecycle — and the second is where the operational cost actually sits.");
}

// ── 13. SAFETY MODEL ────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "SAFETY", "What stops this doing something you did not ask for");
  const rows = [
    hdr(["Control", "Behaviour"]),
    [{ text: "Never autonomous", options: { bold: true } }, { text: "No auto-promote path exists anywhere in the design" }],
    [{ text: "Protected namespaces" }, { text: "kube-*, openshift-*, default refused outright" }],
    [{ text: "Batch cap" }, { text: "Ten VMs per request" }],
    [{ text: "Blocking pre-flight" }, { text: "Missing image, taken name, exceeded quota, absent NAD, no SSH key" }],
    [{ text: "Server-side dry-run" }, { text: "Every path, before any apply" }],
    [{ text: "Re-check after approval" }, { text: "Refuses to provision something different from what was approved" }],
    [{ text: "Change ledger" }, { text: "Every creation reversible; the inverse is the decommission command" }],
    [{ text: "AI boundary" }, { text: "Extracts intent only — never picks the image, manifest or command" }],
    [{ text: "Credential boundary", options: { bold: true } }, { text: "The AI may not produce an SSH key under any circumstance" }],
  ];
  table(s, rows, { y: 1.6, colW: [3.6, 8.8], fontSize: 10.5 });
  footNote(s, "The AI explains. Deterministic code acts. A person decides. Same contract as UC-05.");
}

// ── 14. BUSINESS VALUE ──────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "BUSINESS VALUE", "Where the return actually comes from");
  const rows = [
    hdr(["", "Manual", "UC-06"]),
    [{ text: "Request → running VM" }, { text: "Hours to days (ticket queue)" }, { text: "One approval" }],
    [{ text: "Requests with wrong sizing" }, { text: "Common — no reconciliation step" }, { text: "Delta shown before approval" }],
    [{ text: "VMs with a recorded owner" }, { text: "Patchy" }, { text: "Every one" }],
    [{ text: "VMs with an enforced expiry" }, { text: "Effectively none" }, { text: "Every one that sets a date" }],
    [{ text: "Right-sizing reviews" }, { text: "Ad hoc, usually never" }, { text: "Continuous" }],
    [{ text: "Reclaimed capacity" }, { text: "Whenever someone audits" }, { text: "On the expiry date" }],
  ];
  table(s, rows, { y: 1.6, colW: [4.0, 4.2, 4.2], fontSize: 11 });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 4.9, w: 12.4, h: 1.35, fill: { color: C.lAmber }, line: { color: C.userAmber, width: 1.5 }, rectRadius: 0.08 });
  s.addText("VM sprawl is a real budget line", { x: 0.72, y: 5.02, w: 11.9, h: 0.35, fontSize: 14, bold: true, color: "92400E", fontFace: F });
  s.addText("Every request form ever written has an “expires on” field, and almost no platform acts on it. UC-06 is the first part of this platform that does — it raises the decommission change request itself, with the backout plan already filled in.",
    { x: 0.72, y: 5.4, w: 11.9, h: 0.75, fontSize: 11.5, color: C.navy, valign: "top", fontFace: F });
}

// ── 15. DEMO SCRIPT ─────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "DEMO", "Four minutes, end to end");
  const rows = [
    hdr(["Time", "Show", "Say"]),
    [{ text: "0:00" }, { text: "Chat" }, { text: "“Provision a RHEL 9 VM called sap-app-01 in namespace sap, 8 vCPU, 32GB, 200GB, production, expires 2026-12-31, and here is my SSH key.”" }],
    [{ text: "0:30" }, { text: "The card appears" }, { text: "“Nothing has been created. This is what it understood — and here is what a form cannot tell you.”" }],
    [{ text: "1:00" }, { text: "Reconciliation line" }, { text: "“You asked for 8 and 32. The nearest standard is an exact match. Had it not been, it would say by how much.”" }],
    [{ text: "1:20" }, { text: "Quota bar" }, { text: "“This takes the namespace to 78 % of quota. That is a decision, not a number.”" }],
    [{ text: "1:50" }, { text: "Dry-run" }, { text: "“Validated against the live API server. Still nothing created.”" }],
    [{ text: "2:10" }, { text: "Submit for approval" }, { text: "“In a change-controlled estate the CAB is the authority, not a button in my console.”" }],
    [{ text: "2:40" }, { text: "ServiceNow → approve" }, { text: "“One human decision.”" }],
    [{ text: "3:00" }, { text: "VM + access panel" }, { text: "“Provisioned — and here is how to get into it, rather than making you hunt for the IP.”" }],
    [{ text: "3:20" }, { text: "Labels on the VM" }, { text: "“Owner, cost centre, change request, expiry, and why it was sized this way.”" }],
    [{ text: "3:40" }, { text: "Lifecycle report" }, { text: "“Which is what lets it come back weeks later and tell you the VM it built is undersized.”" }],
  ];
  table(s, rows, { y: 1.5, colW: [0.9, 2.6, 8.9], fontSize: 9.5 });
}

// ── 16. CONFIGURATION & STATUS ──────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "CONFIGURATION & STATUS", "Every threshold is owned by the customer");
  const rows = [
    hdr(["Variable", "Default", "Purpose"]),
    [{ text: "VM_IMAGE_NAMESPACE" }, { text: "openshift-virtualization-os-images" }, { text: "Where golden image DataSources live" }],
    [{ text: "VM_APPROVAL_RECONCILE" }, { text: "false" }, { text: "Poll ServiceNow for CAB approval" }],
    [{ text: "VM_APPROVAL_INTERVAL_SEC" }, { text: "300" }, { text: "Poll interval" }],
    [{ text: "VM_MEM_HIGH_PCT / LOW_PCT" }, { text: "85 / 25" }, { text: "Right-size up / down thresholds" }],
    [{ text: "VM_CPU_HIGH_PCT / LOW_PCT" }, { text: "80 / 10" }, { text: "CPU equivalents" }],
    [{ text: "VM_SUSTAIN_DAYS" }, { text: "7" }, { text: "Minimum age and sustain window before judging" }],
    [{ text: "VM_EXPIRY_WARN_DAYS" }, { text: "14" }, { text: "Warn before expiry" }],
  ];
  table(s, rows, { y: 1.55, colW: [3.7, 3.3, 5.4], fontSize: 10 });

  s.addText("VERIFICATION STATUS", { x: 0.45, y: 4.55, w: 5, h: 0.25, fontSize: 9.5, bold: true, color: C.slate, charSpacing: 1.2, fontFace: F });
  const st = [
    { t: "Extraction, reconciliation, manifest shape", v: "15 automated tests", ok: true },
    { t: "Root disk always a DataVolume", v: "asserted in test", ok: true },
    { t: "Routes + chat card end to end", v: "verified live", ok: true },
    { t: "ServiceNow CAB approval loop", v: "not yet run against a live instance", ok: false },
    { t: "Right-sizing on real usage history", v: "awaiting a sustained workload", ok: false },
  ];
  st.forEach((r, i) => {
    const y = 4.85 + i * 0.36;
    s.addText(r.ok ? "✓" : "○", { x: 0.5, y, w: 0.3, h: 0.3, fontSize: 12, bold: true, color: r.ok ? C.autoGreen : C.userAmber, fontFace: F });
    s.addText(r.t, { x: 0.85, y, w: 6.2, h: 0.3, fontSize: 10.5, color: C.navy, valign: "middle", fontFace: F });
    s.addText(r.v, { x: 7.1, y, w: 5.7, h: 0.3, fontSize: 10.5, color: r.ok ? C.autoGreen : C.userAmber, valign: "middle", fontFace: F });
  });
}

// ── 17. CLOSING ─────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  s.background = { color: C.darkNavy };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 2.55, w: 13.33, h: 0.045, fill: { color: C.tcsBlue } });
  s.addText("UC-06  ·  GOVERNED VM PROVISIONING & LIFECYCLE", { x: 0.8, y: 1.5, w: 11.6, h: 0.3, fontSize: 12, color: C.valCyan, bold: true, charSpacing: 2.5, fontFace: F });
  s.addText("Provisioning is a transaction.\nOwnership is a lifecycle.", { x: 0.8, y: 1.9, w: 11.6, h: 1.4, fontSize: 34, color: C.white, bold: true, fontFace: F });
  s.addText("The console creates a VM. It does not remember why.", { x: 0.8, y: 3.35, w: 11.6, h: 0.4, fontSize: 15, color: C.lAmber, italic: true, fontFace: F });
  const pts = [
    "One sentence in — reconciled, pre-flighted and dry-run before anyone approves",
    "One human decision, in the console or at the change board",
    "Provenance written onto the machine: owner, cost centre, change request, expiry, rationale",
    "Weeks later the agent reads it back — right-sizes what it built, reclaims what expired",
  ];
  pts.forEach((p, i) => {
    s.addText("▸", { x: 0.85, y: 4.05 + i * 0.46, w: 0.3, h: 0.35, fontSize: 14, color: C.valCyan, bold: true, fontFace: F });
    s.addText(p, { x: 1.2, y: 4.05 + i * 0.46, w: 11.2, h: 0.35, fontSize: 13, color: "CBD5E1", valign: "middle", fontFace: F });
  });
  s.addText("TCS Agentic AI for Hybrid Infrastructure  ·  Tata Consultancy Services", { x: 0.8, y: 6.5, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", fontFace: F });
}

pptx.writeFile({ fileName: OUT }).then(() => {
  console.log("PPTX written:", OUT);
});
