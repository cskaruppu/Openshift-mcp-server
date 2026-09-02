/**
 * TCS Agentic AI — UC-10: VMware → OpenShift Virtualization migration
 * Generates: TCS-Agentic-AI-UC10-VM-Migration.pptx (beside this script)
 *
 * Run: node usecases/uc-10-vm-migration/generate-ppt.cjs
 */
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "TCS-Agentic-AI-UC10-VM-Migration.pptx");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const pptx = new PptxGenJS();
pptx.author = "TCS Agentic AI Platform";
pptx.title = "TCS Agentic AI — VMware to OpenShift Virtualization Migration · UC-10";
pptx.subject = "UC-10 — assess, govern and migrate a VMware estate onto OpenShift Virtualization";
pptx.company = "Tata Consultancy Services";
pptx.layout = "LAYOUT_WIDE";

// Same palette as the UC-05/06/07 decks so the family reads as one.
const C = {
  darkNavy: "0F172A", navy: "1E293B", tcsBlue: "2563EB", lBlue: "DBEAFE", pBlue: "EFF6FF",
  aiPurple: "7C3AED", lPurple: "EDE9FE",
  autoGreen: "059669", lGreen: "D1FAE5",
  userAmber: "D97706", lAmber: "FEF3C7",
  valCyan: "0891B2", lCyan: "CFFAFE",
  secRed: "B91C1C", lRed: "FEE2E2",
  orange: "EA580C", lOrange: "FFEDD5",
  slate: "64748B", lSlate: "F1F5F9",
  white: "FFFFFF", textMed: "475569",
};
const F = "Inter";

function head(s, kicker, title, sub) {
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.9, fill: { color: C.darkNavy } });
  s.addText(kicker, { x: 0.45, y: 0.12, w: 5, h: 0.25, fontSize: 10, color: C.valCyan, bold: true, charSpacing: 1.5, fontFace: F });
  s.addText(title, { x: 0.45, y: 0.34, w: 9.6, h: 0.45, fontSize: 22, color: C.white, bold: true, fontFace: F });
  s.addText("UC-10", { x: 11.62, y: 0.2, w: 1.35, h: 0.34, fontSize: 13, color: C.white, bold: true, align: "center", fontFace: F,
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
  s.addText("TCS AGENTIC AI   ·   USE CASE 10", { x: 0.8, y: 1.62, w: 8, h: 0.3, fontSize: 13, color: C.valCyan, bold: true, charSpacing: 3, fontFace: F });
  s.addText("VMware → OpenShift Virtualization", { x: 0.8, y: 1.98, w: 11.9, h: 0.85, fontSize: 37, color: C.white, bold: true, fontFace: F });
  s.addText("VM Migration Agent  ·  assess against the target, govern the change, measure the move",
    { x: 0.8, y: 3.5, w: 11.6, h: 0.4, fontSize: 15.5, color: "94A3B8", fontFace: F });
  s.addText("“Every other tool reads the source. This one runs inside the destination.”",
    { x: 0.8, y: 4.05, w: 11.6, h: 0.4, fontSize: 15, color: C.lAmber, italic: true, fontFace: F });

  const stats = [
    { v: "4", l: "Steps, four decisions" }, { v: "15", l: "Source-side checks" },
    { v: "3", l: "Red Hat support tiers" }, { v: "0", l: "Source VMs deleted" }, { v: "230", l: "Unit tests pinning it" },
  ];
  stats.forEach((st, i) => {
    const x = 0.8 + i * 2.42;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 4.85, w: 2.2, h: 1.15, fill: { color: C.navy }, line: { color: "334155", width: 1 }, rectRadius: 0.06 });
    s.addText(st.v, { x, y: 4.97, w: 2.2, h: 0.5, fontSize: 26, bold: true, color: C.valCyan, align: "center", fontFace: F });
    s.addText(st.l, { x, y: 5.47, w: 2.2, h: 0.3, fontSize: 9, color: "94A3B8", align: "center", fontFace: F });
  });
  s.addText("TCS Agentic AI for Hybrid Infrastructure  ·  Virtualization Operations  ·  Tata Consultancy Services",
    { x: 0.8, y: 6.45, w: 11.6, h: 0.3, fontSize: 11, color: "64748B", fontFace: F });
}

// ── 2. THE PROBLEM ──────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "THE PROBLEM", "A migration that copies every byte correctly can still be a failure");
  const items = [
    { t: "It lands and never starts", d: "A KubeVirt VM is a pod — it must fit on ONE node. A 64 GiB guest on 32 GiB workers copies perfectly, then sits Pending. After the outage.", c: C.secRed, bg: C.lRed },
    { t: "\"Supported\" is three answers", d: "Red Hat certified, supported by SUSE, or merely known to run. Flatten them and you discover the difference during a Sev-1.", c: C.orange, bg: C.lOrange },
    { t: "Reservations vanish", d: "A tuned database with reserved memory lands as an ordinary Burstable pod. Nothing warns you; the ticket arrives three weeks later.", c: C.userAmber, bg: C.lAmber },
    { t: "Half a system moves", d: "MTV has no concept of an application. Migrate the web tier now and the database next month — both succeed, the system is broken between them.", c: C.aiPurple, bg: C.lPurple },
    { t: "The estimate is a vendor number", d: "\"How long is the outage?\" answered from a datasheet rather than from this cluster's own storage and network.", c: C.tcsBlue, bg: C.lBlue },
    { t: "The assessment goes stale", d: "Someone enables CBT, someone upgrades a guest, four VMs appear. The report the board approved quietly stops being true.", c: C.slate, bg: C.lSlate },
  ];
  items.forEach((it, i) => {
    const x = 0.45 + (i % 3) * 4.18, y = 1.55 + Math.floor(i / 3) * 2.35;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.95, h: 2.05, fill: { color: it.bg }, line: { color: it.c, width: 1.25 }, rectRadius: 0.08 });
    s.addText(it.t, { x: x + 0.2, y: y + 0.18, w: 3.55, h: 0.4, fontSize: 13.5, bold: true, color: it.c, fontFace: F });
    s.addText(it.d, { x: x + 0.2, y: y + 0.62, w: 3.55, h: 1.25, fontSize: 10.5, color: C.navy, fontFace: F, valign: "top" });
  });
  footNote(s, "UC-10 assesses against the destination, not just the source — and refuses to call an unrun check a pass.");
}

// ── 3. MASTER WORKFLOW ──────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "MASTER WORKFLOW", "Four steps, because they are four decisions",
    "Discovery is read-only. Strategy is chosen last — picking warm or cold before you know a VM is supported is a decision made in the dark.");
  const steps = [
    { n: "1", t: "DISCOVER", d: "Read-only inventory\nOS · IPs · vCPU · RAM · disks", c: C.tcsBlue, bg: C.lBlue },
    { n: "2", t: "ANALYSE", d: "Every VM assessed\nmatrix · checks · capacity · drift", c: C.aiPurple, bg: C.lPurple },
    { n: "3", t: "SELECT", d: "Choose the wave\n+ warm or cold per machine", c: C.userAmber, bg: C.lAmber },
    { n: "4", t: "MIGRATE", d: "Estimate · plan · approve\ntransfer · verify · roll back", c: C.autoGreen, bg: C.lGreen },
  ];
  steps.forEach((st, i) => {
    const x = 0.5 + i * 3.25;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 1.75, w: 2.9, h: 1.7, fill: { color: st.bg }, line: { color: st.c, width: 2 }, rectRadius: 0.08 });
    s.addText(st.n, { x: x + 0.12, y: 1.85, w: 0.45, h: 0.35, fontSize: 15, bold: true, color: C.white, align: "center", fontFace: F, fill: { color: st.c }, rectRadius: 0.5 });
    s.addText(st.t, { x, y: 2.28, w: 2.9, h: 0.35, fontSize: 15, bold: true, color: st.c, align: "center", fontFace: F });
    s.addText(st.d, { x: x + 0.15, y: 2.62, w: 2.6, h: 0.72, fontSize: 10, color: C.navy, align: "center", fontFace: F });
    if (i < 3) arrow(s, x + 2.95, 2.45);
  });

  const gates = [
    ["🔵 Read-only", "Nothing is written to vCenter. Ever."],
    ["🔵 Assess ALL", "Not the ones you already picked — that is the decision the report is for."],
    ["🟣 AI advises", "Warm or cold per VM, with a reason. clampAdvice() overrules physics violations."],
    ["🟡 CAB approves", "The gate lives on the Plan. startMigration re-reads it: an enabled button is not authorisation."],
  ];
  gates.forEach((g, i) => {
    const x = 0.5 + i * 3.25;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 3.75, w: 2.9, h: 1.5, fill: { color: C.pBlue }, line: { color: "CBD5E1", width: 1 }, rectRadius: 0.06 });
    s.addText(g[0], { x: x + 0.12, y: 3.85, w: 2.66, h: 0.3, fontSize: 11, bold: true, color: C.navy, fontFace: F });
    s.addText(g[1], { x: x + 0.12, y: 4.15, w: 2.66, h: 1.0, fontSize: 9.5, color: C.textMed, fontFace: F, valign: "top" });
  });
  footNote(s, "Nothing moves until a Plan is created, validated, and a change request is approved — and the source VM is never deleted.");
}

// ── 4. THE CHECK NOBODY ELSE MAKES ──────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "THE DIFFERENTIATOR", "A KubeVirt VM is a pod. It must fit on ONE node.");
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 1.5, w: 12.4, h: 1.35, fill: { color: C.lRed }, line: { color: C.secRed, width: 2 }, rectRadius: 0.08 });
  s.addText("A 64 GiB guest does not run on 32 GiB workers — however much RAM the cluster has in total.",
    { x: 0.7, y: 1.62, w: 11.9, h: 0.42, fontSize: 16, bold: true, color: C.secRed, fontFace: F });
  s.addText("MTV validates the plan. Copies every byte correctly. Creates the VirtualMachine. It sits Pending forever — after the outage has already been spent. Nothing else in the migration toolchain catches this, because catching it needs both sides at once.",
    { x: 0.7, y: 2.06, w: 11.9, h: 0.7, fontSize: 12, color: C.navy, fontFace: F, valign: "top" });

  table(s, [
    hdr(["What the agent counts", "Why"]),
    ["Only nodes that are Ready, uncordoned, AND labelled kubevirt.io/schedulable=true", "A node without virt-handler has RAM the cluster can use and a VM cannot. Counting it inflates headroom no VM can reach."],
    ["Pod REQUESTS, not live utilisation", "A node at 20% usage and 95% requested has no room. Quoting the 20% costs someone an outage."],
    ["CPU overcommitted 10:1, memory not, plus virt-launcher overhead", "OpenShift Virtualization's real defaults — and the panel prints the assumption rather than hiding it."],
    ["\"Can never schedule\" kept apart from \"no room today\"", "One needs hardware. The other needs a window. Only the first is worth blocking a plan over."],
  ], { y: 3.05, colW: [5.4, 7.0], fontSize: 11 });
  footNote(s, "Every assessment tool on the market reads the source. This agent runs inside the destination.");
}

// ── 5. THE ASSESSMENT ───────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "PRE-MIGRATION REPORT", "Five assessments, one page, one exportable document");
  const dims = [
    { t: "Guest OS support", d: "Red Hat's certified list, read 2026-09-02. Three tiers: certified · vendor supported · known to run. Windows Server 2012 R2 is not \"caveats\" — it is not certified.", c: C.tcsBlue, bg: C.lBlue },
    { t: "15 source-side checks", d: "Snapshots · independent disks · RDM · shared disks · Fault Tolerance · vTPM · Secure Boot · passthrough devices · NIC coverage · VMware Tools. Each with its own fix.", c: C.autoGreen, bg: C.lGreen },
    { t: "Target capacity", d: "Will the wave fit, and will each machine schedule? Blocks a VM larger than every node in the cluster.", c: C.secRed, bg: C.lRed },
    { t: "Resource guarantees", d: "52 vCPU assigned becomes 5.2 cores requested. Reservations, limits, shares and latency sensitivity do not survive the move.", c: C.userAmber, bg: C.lAmber },
    { t: "Drift", d: "What improved, regressed, arrived or left since the last assessment. Enabling CBT reads as an improvement even when the level is unchanged.", c: C.aiPurple, bg: C.lPurple },
    { t: "Evidence pack", d: "Report ID, timestamp, source, target, matrix version. Printable HTML for the change board; CSV register for the engineers.", c: C.valCyan, bg: C.lCyan },
  ];
  dims.forEach((it, i) => {
    const x = 0.45 + (i % 3) * 4.18, y = 1.55 + Math.floor(i / 3) * 2.35;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.95, h: 2.05, fill: { color: it.bg }, line: { color: it.c, width: 1.25 }, rectRadius: 0.08 });
    s.addText(it.t, { x: x + 0.2, y: y + 0.18, w: 3.55, h: 0.4, fontSize: 13.5, bold: true, color: it.c, fontFace: F });
    s.addText(it.d, { x: x + 0.2, y: y + 0.62, w: 3.55, h: 1.3, fontSize: 10, color: C.navy, fontFace: F, valign: "top" });
  });
  footNote(s, "A check with no data is reported as unchecked — never as a pass. \"15 of 15 source checks ran\" is on every machine.", C.tcsBlue);
}

// ── 6. ACTOR MODEL ──────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "ACTOR MODEL", "The model advises. Code decides.");
  const acts = [
    { i: "🤖", n: "AI", c: C.aiPurple, bg: C.lPurple, w: "Warm or cold per VM, with a reason. Wave sequencing and risk.",
      d: "The judgement call — downtime traded against transfer complexity, weighed against what the machine does and when the window is. It never sees a manifest." },
    { i: "⚙", n: "Deterministic", c: C.tcsBlue, bg: C.lBlue, w: "Support verdicts. Source checks. Capacity. Estimates. Grouping.",
      d: "Anything that claims \"this is true of your estate or your cluster\" is measured and unit-tested. A model would paraphrase a support statement." },
    { i: "👤", n: "Human", c: C.userAmber, bg: C.lAmber, w: "Validates the report. Chooses the wave. Approves the change.",
      d: "Two irreversible acts — CAB approval and Migrate — stay human. The agent narrows the decision; it does not take it." },
  ];
  acts.forEach((a, i) => {
    const x = 0.45 + i * 4.18;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 1.5, w: 3.95, h: 4.2, fill: { color: a.bg }, line: { color: a.c, width: 2 }, rectRadius: 0.1 });
    s.addText(`${a.i}  ${a.n}`, { x: x + 0.2, y: 1.65, w: 3.55, h: 0.45, fontSize: 17, bold: true, color: a.c, fontFace: F });
    s.addText(a.w, { x: x + 0.2, y: 2.15, w: 3.55, h: 0.9, fontSize: 12, bold: true, color: C.navy, fontFace: F, valign: "top" });
    s.addText(a.d, { x: x + 0.2, y: 3.1, w: 3.55, h: 2.4, fontSize: 10.5, color: C.textMed, fontFace: F, valign: "top" });
  });
  footNote(s, "A warm recommendation for a VM without changed block tracking is downgraded before it can reach a plan. Physics wins.", C.aiPurple);
}

// ── 7. VS MTV ALONE ─────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "DIFFERENTIATION", "MTV is the transfer engine. This is everything around it.");
  table(s, [
    hdr(["Capability", "MTV alone", "External assessment tools", "UC-10"]),
    ["Guest OS vs Red Hat's certified list, with tier", "—", "Partial", "✅ Three tiers, dated, linked"],
    ["Will the VM SCHEDULE on the target?", "—", "Cannot see the target", "✅ Blocks it at assessment"],
    ["Reservations lost on migration", "—", "—", "✅ Named per VM"],
    ["What to change, per machine", "Concerns, no fixes", "Generic", "✅ \"Upgrade to Server 2022\", \"enable CBT\""],
    ["Transfer time", "—", "Vendor figures", "✅ This cluster's history, then live bytes"],
    ["Evidence pack for the CAB", "—", "✅", "✅ Report ID + matrix version"],
    ["Drift since the last assessment", "—", "Rare", "✅ Improved / regressed / added / gone"],
    ["Move-together groups", "—", "Agent-based mapping", "✅ Agentless, evidence shown"],
    ["Approval gate before data moves", "—", "—", "✅ Held on the Plan itself"],
  ], { y: 1.5, colW: [4.3, 2.4, 2.7, 3.0], fontSize: 10 });
  footNote(s, "None of this replaces MTV. All of it is missing without the agent.");
}

// ── 8. GOVERNANCE ───────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "GOVERNANCE", "The gate lives in the cluster, not in the browser");
  const flow = [
    { t: "Create Plan", d: "MTV validates.\nNothing moves.", c: C.tcsBlue, bg: C.lBlue },
    { t: "Raise change", d: "This plan's own footprint,\ntransfer time and downtime.", c: C.aiPurple, bg: C.lPurple },
    { t: "CAB decides", d: "Approved · rejected\n· cancelled", c: C.userAmber, bg: C.lAmber },
    { t: "Migrate", d: "Gate re-read server-side\non every call.", c: C.autoGreen, bg: C.lGreen },
  ];
  flow.forEach((f, i) => {
    const x = 0.5 + i * 3.25;
    box(s, { x, y: 1.6, w: 2.9, h: 1.35, fill: f.bg, line: f.c, text: f.t, sub: f.d, tColor: f.c, fs: 14 });
    if (i < 3) arrow(s, x + 2.95, 2.15);
  });
  table(s, [
    hdr(["Control", "How"]),
    ["Durable across restarts and operators", "Approval is written as annotations ON the Forklift Plan. Refresh the console, restart the pod, come back tomorrow — the gate is where you left it, and visible in `oc get plan -o yaml`."],
    ["An enabled button is not authorisation", "startMigration re-reads the gate from the cluster on every call, whatever the browser believed."],
    ["Silence is never approval", "readMigrationApproval() is pure and unit-tested. A rejection wins over any state that would otherwise read as approved."],
    ["Per-plan accuracy", "A wave that splits into two cold plans does not put the combined figure on both change requests."],
    ["Rollback", "Deletes only what the migration created. The source VMs are never deleted and can be powered back on."],
  ], { y: 3.25, colW: [3.7, 8.7], fontSize: 10.5 });
  footNote(s, "MIGRATION_REQUIRE_APPROVAL=false exists, is named, and is off by default.", C.orange);
}

// ── 9. BUSINESS VALUE ───────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "BUSINESS VALUE", "What changes for a migration programme");
  table(s, [
    hdr(["Metric", "Manual baseline", "With UC-10"]),
    ["Assess 100 VMs", "Days of spreadsheet work, once", "Minutes, repeatable, exported"],
    ["\"Will it run when it lands?\"", "Discovered after the outage", "Answered before the wave"],
    ["Post-migration performance surprises", "A ticket three weeks later", "Named per VM at assessment"],
    ["\"Why was this moved unsupported?\"", "Archaeology", "Report ID, matrix version, tier, operator"],
    ["Outage estimate", "A vendor number", "This cluster's throughput, then live bytes"],
    ["Assessment freshness", "Stale in weeks, silently", "Drift report on every run"],
    ["Half-migrated systems", "Found in production", "Warned before the wave is committed"],
  ], { y: 1.6, colW: [4.4, 4.0, 4.0], fontSize: 11 });
  footNote(s, "The expensive part of a migration is not the transfer. It is everything nobody checked.");
}

// ── 10. STATUS ──────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide();
  head(s, "STATUS", "What is live, and what is roadmap");
  table(s, [
    hdr(["Capability", "Status"]),
    ["Discovery incl. vSphere guestId decoding (the srvNext trap)", "✅ Live · unit-tested against 13 real guest ids"],
    ["Support matrix vs Red Hat article 4234591, three tiers", "✅ Live · read 2026-09-02"],
    ["15 source-side checks, unchecked ≠ pass", "✅ Live · unit-tested both directions"],
    ["Target capacity and single-node fit", "✅ Live · \"never\" separated from \"not today\""],
    ["Resource fidelity, move-together groups, drift", "✅ Live · unit-tested"],
    ["Evidence pack (HTML + CSV, injection-safe)", "✅ Live"],
    ["Plan grouping incl. Windows/Linux split", "✅ Live"],
    ["ServiceNow change gate held on the Plan", "✅ Live in the lab"],
    ["Live measured ETA with stall detection · rollback", "✅ Live"],
    ["Wave scheduling against blackout windows", "🔶 Roadmap"],
    ["RCA agent on a stalled transfer", "🔶 Machinery exists (UC-05); auto-wiring is roadmap"],
  ], { y: 1.5, colW: [7.6, 4.8], fontSize: 10.5 });
  footNote(s, "230 unit tests pin the deterministic half. The AI half is clamped by it.");
}

pptx.writeFile({ fileName: OUT }).then(() => console.log("✅ " + OUT));
