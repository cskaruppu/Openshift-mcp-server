/**
 * TCS Agentic AI — UC-10: VMware → OpenShift Virtualization migration
 * Generates: TCS-Agentic-AI-UC10-VM-Migration.xlsx (beside this script)
 *
 * Run: node usecases/uc-10-vm-migration/generate-excel.cjs
 */
const ExcelJS = require("exceljs");
// The workflow is defined once, in workflow.cjs, and read by both this
// workbook and the deck. They each used to carry their own copy, which is how
// they drifted four stages behind the product.
const WF = require("./workflow.cjs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "TCS-Agentic-AI-UC10-VM-Migration.xlsx");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const wb = new ExcelJS.Workbook();
wb.creator = "TCS Agentic AI Platform";
wb.created = new Date();
wb.title = "TCS Agentic AI — VMware to OpenShift Virtualization Migration · UC-10";
wb.company = "Tata Consultancy Services";
wb.subject = "UC-10 — assess, govern and migrate a VMware estate onto OpenShift Virtualization";

const C = {
  darkNavy: "0F172A", navy: "1E293B", tcsBlue: "2563EB", lightBlue: "DBEAFE", paleBlue: "EFF6FF",
  aiPurple: "7C3AED", lightPurple: "EDE9FE",
  autoGreen: "059669", lightGreen: "D1FAE5", darkGreen: "065F46",
  userAmber: "D97706", lightAmber: "FEF3C7", darkAmber: "92400E",
  valCyan: "0891B2", lightCyan: "CFFAFE",
  secRed: "DC2626", lightRed: "FEE2E2", darkRed: "991B1B",
  orange: "EA580C", lightOrange: "FFEDD5",
  white: "FFFFFF", bgLight: "F8FAFC", border: "CBD5E1",
  textDark: "1E293B", textMed: "475569", slate: "64748B", lightSlate: "F1F5F9",
};

const thin = { style: "thin", color: { argb: "FF" + C.border } };
const bd = { top: thin, bottom: thin, left: thin, right: thin };
const F = "Calibri";
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb: "FF" + argb } });

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
      const isObj = v && typeof v === "object" && !Array.isArray(v);
      cell.value = isObj ? v.t : v;
      cell.font = { name: F, size: 10, bold: isObj ? !!v.b : (i === 0 && opts.boldFirst !== false),
        color: { argb: "FF" + (isObj && v.c ? v.c : C.textDark) } };
      cell.fill = fill(isObj && v.bg ? v.bg : (ri % 2 === 0 ? C.white : C.bgLight));
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
const AI = { t: "🤖 AI", b: true, c: "5B21B6", bg: C.lightPurple };
const AU = { t: "⚙️ AUTOMATIC", b: true, c: "1E40AF", bg: C.lightBlue };
const MA = { t: "👤 MANUAL", b: true, c: C.darkAmber, bg: C.lightAmber };
const EX = { t: "🔗 EXTERNAL", b: true, c: "0E7490", bg: "CFFAFE" };
const ACTOR = { [WF.AU]: AU, [WF.AI]: AI, [WF.MA]: MA, [WF.EX]: EX };
const OK = { t: "✅ VERIFIED", b: true, c: C.darkGreen, bg: C.lightGreen };
const RM = { t: "🔶 ROADMAP", b: true, c: C.darkAmber, bg: C.lightAmber };

// ═══ 1. OVERVIEW ════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("1. Overview", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 30 }, { width: 95 }];
  let r = banner(ws, "VM Migration Assurance — VMware to OpenShift Virtualization",
    "Every other assessment tool reads the source. This agent runs inside the destination — so it can answer whether a VM will actually run when it lands.", 2);
  r = headerRow(ws, r, ["Attribute", "Detail"]);
  r = dataRows(ws, r, [
    ["Use case ID", "UC-10"],
    ["Full name", "TCS Agentic AI — VMware to OpenShift Virtualization Migration (VM Migration Agent)"],
    ["Product family", "TCS Agentic AI for Hybrid Infrastructure · Virtualization Operations"],
    ["Platform", "OpenShift Virtualization (KubeVirt) + Migration Toolkit for Virtualization (Forklift)"],
    ["Tagline", "Assess against the target. Govern the change. Measure the move."],
    ["Description", "A vCenter estate is discovered read-only, assessed against Red Hat's certified guest list AND the target cluster's real node capacity, grouped into waves that MTV will accept, governed through a ServiceNow change record held on the Plan itself, and migrated with a measured ETA while bytes move — with a rollback that never touches the source."],
    ["Trigger", "HUMAN-INITIATED: choose a source provider and discover."],
    ["Prerequisite", "MTV/Forklift installed, provider connected, storage and network maps defined."],
    ["Human touchpoints", "Three: validate the report, choose the wave, approve the change. Migrate stays a human click."],
    ["Sources supported", "vSphere (primary) · oVirt · OpenStack · OVA, through MTV providers"],
    ["Demo time", "6–8 min for the assessment, plus transfer time for a live migration"],
  ], { height: 32 });
  note(ws, r, 2, "A KubeVirt VM is a pod — it must fit on ONE node. A 64 GiB guest does not run on 32 GiB workers, and nothing else in the migration toolchain catches that before the outage is spent.", C.lightRed, C.darkRed);
}

// ═══ 2. ACTOR MODEL ═════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("2. Actor Model", { properties: { tabColor: { argb: "FF" + C.aiPurple } } });
  ws.columns = [{ width: 20 }, { width: 46 }, { width: 62 }];
  let r = banner(ws, "Actor model — the model advises, code decides", null, 3);
  r = headerRow(ws, r, ["Actor", "What it owns", "Why this actor"]);
  r = dataRows(ws, r, [
    [AI, "Warm or cold per VM, with a reason. Wave sequencing and risk advice.", "The judgement call: downtime traded against transfer complexity, weighed against what the machine does and when the window is. That is reasoning, not a rule. It never sees a manifest."],
    [AU, "Support verdicts. 15 source checks. Target capacity. Estimates. Grouping. Drift.", "Anything claiming \"this is true of your estate or your cluster\" is measured and unit-tested. A model would paraphrase a Red Hat support statement into something subtly different."],
    [MA, "Validates the report. Chooses the wave. Approves the change. Clicks Migrate.", "The two irreversible acts stay human. The agent narrows the decision; it does not take it."],
  ], { height: 62 });
  r = note(ws, r, 3, "clampAdvice() downgrades a warm recommendation for a VM without changed block tracking before it can reach a plan. powerPlan() overrules a model that claims a cold migration stays online. Physics wins.", C.lightPurple, "5B21B6");
}

// ═══ 3. WORKFLOW BY ACTOR ═══════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("3. Workflow by Actor", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 7 }, { width: 20 }, { width: 34 }, { width: 17 }, { width: 74 }, { width: 26 }];
  let r = banner(ws, `Every step, end to end — ${WF.ratioLine()}`,
    "Nine stages. If a row says deterministic, no model was involved in producing it. Discovery is read-only, strategy is chosen after the evidence, and every irreversible act is manual.", 6);
  r = headerRow(ws, r, ["#", "Stage", "Step", "Actor", "What happens", "Where it lives"]);
  r = dataRows(ws, r, WF.STEPS.map(([id, stage, step, actor, what, where]) => {
    const st = WF.STAGES.find((x) => x.id === stage);
    return [id, `${st.id}. ${st.name}${st.route === "warm" ? " (warm)" : ""}`, step, ACTOR[actor], what, where];
  }), { height: 32 });
  note(ws, r, 6, "The ratio is the argument, not an apology: a model where judgement is genuinely required, measurement everywhere a fact exists, and a person on both irreversible acts — starting a migration, and deleting the source.", C.lightPurple, "5B21B6");
}

// ═══ 3a. THE TWO JOURNEYS ═══════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("3a. Warm vs Cold", { properties: { tabColor: { argb: "FF" + C.orange } } });
  ws.columns = [{ width: 6 }, { width: 24 }, { width: 58 }, { width: 58 }];
  let r = banner(ws, "Warm and cold are different journeys, not one journey with a flag",
    "A cold migration powers the guest off at the START and the whole transfer is the outage. A warm one keeps it serving users and spends the outage at the very end, at the cutover. Drawn as one pipeline, a cold plan promises a cutover step it will never have.", 4);
  r = headerRow(ws, r, ["#", "Stage", "COLD — guest is off throughout", "WARM — guest serves users until cutover"]);
  r = dataRows(ws, r, [
    ["1", "Plan created", "Validated by MTV. Nothing has moved.", "Validated by MTV. Nothing has moved."],
    ["2", "Change approved", "Window covers the WHOLE copy — the transfer is the outage.", "Window covers the CUTOVER ONLY — the copy is not an outage."],
    ["3", "Copy", "Guest powered off first, then every byte copies. Users are down for all of it.", "Disks copy while the guest keeps serving users. MTV re-snapshots hourly to track changes."],
    ["4", "Cutover", "— no such step —", "THE OUTAGE. Guest shuts down, final changed blocks copy, VM starts on OpenShift."],
    ["5", "Verified", "Running, disks present, source confirmed off.", "Running, disks present, source confirmed off."],
    ["6", "Source retired", "Second change request, after the soak.", "Second change request, after the soak."],
  ], { height: 34 });
  r += 1;
  r = headerRow(ws, r, ["", "What differs", "Cold", "Warm"]);
  r = dataRows(ws, r, [
    ["", "Service impact", "The entire transfer — hours for a large VM.", "Minutes. Only the cutover."],
    ["", "Requires", "Nothing beyond a validated plan.", "Changed block tracking (CBT), powered on, and NO pre-existing snapshots."],
    ["", "Pre-existing snapshot", "Allowed. Copies the chain, so it is slower.", "BLOCKS IT. Forklift will not stack its tracking snapshot on an existing chain."],
    ["", "Change window proposed", "24h lead — the source has not been touched, so notice is free.", "Same day. Every hour of waiting spends one of the VM's 28 changed-block snapshots and grows the delta."],
    ["", "The way back", "Power the source VM on again. It was never deleted.", "Before cutover the source is still running. After it, power it on again."],
  ], { height: 32 });
  note(ws, r, 4, "The snapshot rule is the one that surprises people: taking a snapshot 'to be safe' before a warm migration is precisely what makes the warm migration impossible.", C.lightAmber, C.darkAmber);
}

// ═══ 3b. AI EXPLAINED ═══════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("3b. AI Explained", { properties: { tabColor: { argb: "FF" + C.aiPurple } } });
  ws.columns = [{ width: 30 }, { width: 90 }];
  let r = banner(ws, "How the AI works — the model advises, code decides, a human approves",
    "Two touchpoints in 32 steps. Everything below describes what the code actually does, not an intention.", 2);

  r = headerRow(ws, r, ["Aspect", "Detail"]);
  r = dataRows(ws, r, [
    ["Why only two steps", "Support verdicts, source checks, capacity, estimates and grouping are FACTS — about Red Hat's list, about this VM, about this cluster. A model would paraphrase a support statement into something subtly different, and a generated capacity figure is worthless. They must also be identical on every run, because a change board approves them."],
    ["Touchpoint 1 — input", "Per VM, and only what the decision needs: name, poweredOn, diskGiB, diskCount, guestOS, cpu, memoryMB, changeTrackingEnabled. Capped at 40 VMs. No IP addresses, no MACs, no folder paths, no credentials."],
    ["Touchpoint 1 — contract", "A system prompt defining warm and cold in operational terms (warm needs changed block tracking; cold is a consistent point-in-time copy), demanding JSON only, and stating: 'Never invent a VM that was not listed.'"],
    ["Determinism", "classifyJSON at temperature 0. The same fleet gets the same advice. A malformed response returns null rather than throwing."],
    ["Touchpoint 1 — output", "Per VM: strategy (warm|cold), a one-sentence reason, and a risk band."],
    ["Guardrail — invented VMs", "A name we did not send is dropped. The model cannot add a machine to the wave."],
    ["Guardrail — physics", "warm for a VM without changed block tracking is forced to cold, flagged '(corrected)' in the console, and the reason replaced with the real blocker."],
    ["Guardrail — downtime", "The power outcome is NOT taken from the model. powerPlan() computes it from the strategy and the machine's current power state."],
    ["Guardrail — enums and length", "risk outside low/medium/high becomes medium; the reason is truncated to 220 characters."],
    ["Guardrail — coverage", "VMs the model skipped are filled in from the deterministic heuristic, so no machine is left without advice."],
    ["Touchpoint 2 — input", "An already-computed analysis digest, containing NO VM names at all: totals, byLevel, totalDiskGiB, warmEligible, and per-family distribution counts."],
    ["Touchpoint 2 — contract", "'You are given an ALREADY COMPUTED analysis. Do not re-classify support levels and do not contradict them. Add at most 3 suggestions about SEQUENCING and RISK.'"],
    ["Touchpoint 2 — guardrail", "The deterministic findings are produced first and always returned. The model's suggestions are appended, capped at three, severity validated against an enum, text truncated, each tagged 'AI' in the console. It cannot delete a finding, reorder one, or change a verdict."],
    ["Prompt injection", "Guest OS strings, VM names and MTV messages come from outside this system. Every prompt fences untrusted content between explicit markers, strips marker-lookalikes so the fence cannot be closed early, and carries a standing rule that fenced text is DATA and never instructions."],
    ["Blast radius", "The model has NO TOOLS. It cannot call the cluster, read a secret, or write a manifest. It receives text and returns text; every side effect is performed by deterministic code after the clamp."],
    ["With no LLM configured", "Nothing stops working. heuristicAdvice() and fleetRemediation() run alone and the console badge reads 'rule-based' instead of 'AI' rather than pretending. The same fallback catches a timeout, a malformed response or a provider outage, and shows the note 'AI advice unavailable: …' rather than swallowing it."],
    ["The honesty test", "Turn the model off and see whether the product still tells the truth. Here it does — it gives less nuanced advice, and says so."],
  ], { height: 56 });
  note(ws, r, 2, "Nothing the model produces reaches a Plan, a change request or the cluster without passing through a deterministic clamp and, for anything irreversible, a person.", C.lightPurple, "5B21B6");
}

// ═══ 4. DIFFERENTIATION ═════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("4. vs MTV alone", { properties: { tabColor: { argb: "FF" + C.secRed } } });
  ws.columns = [{ width: 44 }, { width: 24 }, { width: 26 }, { width: 40 }];
  let r = banner(ws, "MTV is the transfer engine. This is everything around it.",
    "None of this replaces MTV. All of it is missing without the agent.", 4);
  r = headerRow(ws, r, ["Capability", "MTV alone", "External assessment tools", "UC-10"]);
  r = dataRows(ws, r, [
    ["Guest OS vs Red Hat's certified list, with tier", "—", "Partial", "✅ Three tiers, dated, linked to the source"],
    ["Will the VM SCHEDULE on the target?", "—", "Cannot see the target", "✅ Blocked at assessment time"],
    ["Reservations and guarantees lost on migration", "—", "—", "✅ Named per VM, with what to set"],
    ["What to change, per machine", "Concerns, no fixes", "Generic guidance", "✅ \"Upgrade to Server 2022\", \"enable CBT\""],
    ["Transfer time estimate", "—", "Vendor figures", "✅ This cluster's history, then live bytes"],
    ["Evidence pack for a change board", "—", "✅", "✅ Report ID + matrix version + operator"],
    ["Drift since the last assessment", "—", "Rare", "✅ Improved / regressed / added / gone"],
    ["Move-together groups", "—", "Agent-based mapping", "✅ Agentless inference, evidence shown"],
    ["Approval gate before data moves", "—", "—", "✅ Held on the Plan, re-read server-side"],
    ["Windows and Linux in separate waves", "—", "—", "✅ OS is a plan-grouping dimension"],
    ["The wave costed with AND without VDDK", "—", "—", "✅ Both shown, configured path marked"],
  ], { height: 30 });
  note(ws, r, 4, "The unique angle: every tool in this market reads the SOURCE. This agent runs inside the DESTINATION, so it knows both sides at once.", C.lightRed, C.darkRed);
}

// ═══ 5. SUPPORT MATRIX ══════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("5. Support Matrix", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 34 }, { width: 20 }, { width: 30 }, { width: 56 }];
  let r = banner(ws, "Guest OS support — Red Hat's three tiers",
    "From access.redhat.com/articles/4234591, read 2 September 2026. Confirm against the list for YOUR OpenShift version before committing to a wave.", 4);
  r = headerRow(ws, r, ["Guest OS", "Verdict", "Tier", "Note"]);
  const OKG = { t: "✅ SUPPORTED", b: true, c: C.darkGreen, bg: C.lightGreen };
  const CAV = { t: "⚠️ CAVEATS", b: true, c: C.darkAmber, bg: C.lightAmber };
  const NO = { t: "❌ UNSUPPORTED", b: true, c: C.darkRed, bg: C.lightRed };
  r = dataRows(ws, r, [
    ["Windows Server 2025 / 2022 / 2019 / 2016", OKG, "Red Hat certified", "Certified guests. Windows still needs VirtIO drivers — there is no in-box VirtIO storage driver."],
    ["Windows 11", OKG, "Red Hat certified", "Requires EFI and a vTPM on the target, which needs vmStateStorageClass configured on the cluster."],
    ["Windows 10", OKG, "Red Hat certified", "Certified."],
    ["Windows Server 2012 R2 and earlier", NO, "Known to run — not certified", "Red Hat's own wording. It boots; nobody certifies it. Past Microsoft end of extended support."],
    ["Windows 7 / 8 / XP", NO, "Known to run — not certified", "End of life."],
    ["RHEL 10 / 9 / 8", OKG, "Red Hat certified", "Certified."],
    ["RHEL 7", OKG, "Red Hat certified", "Certified, but past end of maintenance — an Extended Life Cycle Support subscription is needed to stay patched."],
    ["RHEL 6", NO, "Deprecated by Red Hat", "Deprecated at 4.13 and listed for migration support only: it can be moved, not run supported."],
    ["CentOS 7 · CentOS Stream 8", NO, "Deprecated by Red Hat", "Deprecated at 4.18 — end-of-life products. Convert in place with convert2rhel, or plan a move to RHEL 9."],
    ["Oracle Linux 8 / 9", CAV, "Supported by the OS vendor", "Supported by Oracle, not by Red Hat. Confirm your entitlement covers running it here."],
    ["SLES 15 SP5+ · SLES 16", CAV, "Supported by the OS vendor", "Supported by SUSE rather than Red Hat."],
    ["Ubuntu LTS 18.04 – 25.04", CAV, "Supported by the OS vendor", "Canonical supports these; Red Hat does not."],
    ["Rocky · AlmaLinux · Debian · Fedora · CentOS Stream 9+", CAV, "Not on Red Hat's certified list", "Community support only. Not a verdict on the distribution — a fact about the list."],
  ], { height: 34 });
  note(ws, r, 4, "Flattening three tiers into supported/unsupported loses the distinction that decides a support call. The console shows the tier wherever it shows the verdict.", C.lightGreen, C.darkGreen);
}

// ═══ 6. SOURCE CHECKS ═══════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("6. Source Checks", { properties: { tabColor: { argb: "FF" + C.orange } } });
  ws.columns = [{ width: 30 }, { width: 16 }, { width: 46 }, { width: 52 }];
  let r = banner(ws, "15 source-side checks — what MTV misses, and what it never explains",
    "The rule that makes this trustworthy: a check with no data is NOT a pass. Where the inventory reports nothing, the check is recorded as unchecked and the VM shows \"12 of 15 source checks ran\".", 4);
  r = headerRow(ws, r, ["Check", "Effect", "Why it matters", "What to do"]);
  const BLK = { t: "⛔ BLOCKS", b: true, c: C.darkRed, bg: C.lightRed };
  const WRN = { t: "⚠️ WARNS", b: true, c: C.darkAmber, bg: C.lightAmber };
  const INF = { t: "ℹ️ NOTES", b: true, c: "1E40AF", bg: C.lightBlue };
  r = dataRows(ws, r, [
    ["VM template", BLK, "Templates have no running state and are not migrated by a Plan.", "Convert to a VM in vCenter, or exclude it."],
    ["Fault Tolerance enabled", BLK, "An FT pair shares live state; there is no equivalent, and the VM cannot be snapshotted for transfer.", "Turn FT off. Rebuild availability with replicas on the target."],
    ["Source host disconnected", BLK, "vCenter cannot reach the host, so the inventory is stale and the disks cannot be read.", "Restore the connection and re-run discovery."],
    ["Independent-mode disks", BLK, "Excluded from snapshots by design, so the transfer has nothing consistent to copy from.", "Change to dependent mode (VM powered off), then re-discover."],
    ["Raw device mappings (RDM)", BLK, "Map directly to a LUN rather than a VMDK — there is no virtual disk to copy.", "Present the LUN as a PV and attach after migration, or convert to VMDK."],
    ["Shared disks", BLK, "Shared with another VM, typically a guest cluster. Copying one side produces an inconsistent target.", "Migrate the cluster as a unit, or rebuild it on the target."],
    ["Snapshots present", WRN, "The transfer copies the chain, not a flat disk — slower and more likely to fail. Warm migration adds another on top.", "Consolidate in vCenter before the wave. Usually the quickest win in the assessment."],
    ["VMware Tools not running", WRN, "No IP addresses reported, no clean guest shutdown for a cold migration, far less to verify after cutover.", "Start or install VMware Tools and re-discover."],
    ["Virtual TPM attached", WRN, "KubeVirt stores TPM state in a PV, which needs vmStateStorageClass on the cluster. Without it a Windows 11 guest will not boot.", "Confirm vmStateStorageClass is configured before migrating."],
    ["Secure Boot enabled", WRN, "The target VM must be created with EFI and SMM or it will not boot with Secure Boot on.", "Verify EFI + SMM before first boot, or accept it disabled."],
    ["Passthrough / SR-IOV / GPU devices", WRN, "Bound to specific source hardware. The VM migrates and then fails to start, or loses the function it depends on.", "Remove the device and plan the equivalent, or exclude the VM."],
    ["NICs across several port groups", WRN, "Every source network needs its own network-map entry. A missing one fails plan validation, after you have committed to a wave.", "Confirm the network map covers all of them before creating the plan."],
    ["EFI firmware", INF, "MTV sets EFI on the target; a firmware mismatch produces a VM that will not start.", "Check it boots to its own bootloader, not the EFI shell."],
    ["CPU / NUMA affinity pinned", INF, "KubeVirt does not carry pinning over; it has its own dedicated-CPU placement, configured differently.", "If pinned for latency, plan dedicated CPU placement on the target."],
    ["CPU or memory hot-add", INF, "KubeVirt resizes by changing the spec and restarting.", "No action before migrating. Expect a restart for future resizes."],
  ], { height: 42 });
  note(ws, r, 4, "Two bugs this found in our own code: \"toolsNotRunning\" contains the word \"running\" and passed a naive match; and blocked machines were still being offered a migration method.", C.lightOrange, "9A3412");
}

// ═══ 7. TARGET CAPACITY ═════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("7. Target Capacity", { properties: { tabColor: { argb: "FF" + C.secRed } } });
  ws.columns = [{ width: 40 }, { width: 82 }];
  let r = banner(ws, "\"Will it fit?\" — the assessment only the destination can make",
    "A KubeVirt VM is a pod, so it must fit on ONE node. MTV validates the plan, copies every byte, creates the VirtualMachine — and it sits Pending forever, after the outage has been spent.", 2);
  r = headerRow(ws, r, ["Rule", "Why"]);
  r = dataRows(ws, r, [
    ["Only Ready, uncordoned, kubevirt.io/schedulable=true nodes count", "A node without a healthy virt-handler has CPU and RAM the cluster can use and a VM cannot. Counting it inflates headroom no VM can reach."],
    ["Headroom is pod REQUESTS, not live utilisation", "A node at 20% usage and 95% requested has no room. Quoting the 20% would cost someone an outage."],
    ["CPU overcommitted 10:1, memory not overcommitted", "OpenShift Virtualization's real defaults. Memory is the constraint that actually bites; CPU is deliberately oversubscribed."],
    ["Plus virt-launcher overhead per VM", "The pod requests more than the guest's configured memory."],
    ["\"Can never schedule\" ≠ \"no room today\"", "One needs bigger hardware, the other needs a maintenance window or a scale-out. Only the first is worth blocking a plan over."],
    ["Every assumption is printed on the panel", "A capacity number without its assumptions is a guess wearing a suit."],
  ], { height: 40 });
  note(ws, r, 2, "Example from the lab: a 64 GiB VM against 48 GiB workers — blocked at assessment. MTV would have copied 200 GiB first.", C.lightRed, C.darkRed);
}

// ═══ 7b. VDDK ══════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("7b. VDDK", { properties: { tabColor: { argb: "FF" + C.secRed } } });
  ws.columns = [{ width: 34 }, { width: 86 }];
  let r = banner(ws, "The VDDK choice — shown as a number, not a documentation link",
    "MTV can migrate from vSphere with or without the VMware VDDK init image. Red Hat's guidance is unambiguous: create one.", 2);
  r = headerRow(ws, r, ["Point", "Detail"]);
  r = dataRows(ws, r, [
    ["Why it matters", "A VDDK image accelerates the transfer AND reduces the risk of a plan failing. Red Hat recommends it for every vSphere migration."],
    ["The hard stop", "A VM backed by VMware vSAN will NOT migrate without VDDK at all. Where VDDK is absent this stops being a speed question and becomes a blocker."],
    ["Detection", "spec.settings.vddkInitImage on the Forklift Provider — read from a list the readiness check already fetches, so detecting it costs nothing."],
    ["What the panel shows", "The same wave costed WITH and WITHOUT VDDK, with the configured path marked. Where it is not configured: \"Configuring the VDDK image would take this from 34 min to 10 min.\""],
    ["Why two numbers", "\"Configure VDDK\" as advice is ignored. \"34 minutes becomes 10, and anything on vSAN will not migrate at all\" is a decision."],
    ["The ratio is an assumption", "Red Hat's own wording is \"using MTV without VDDK is not recommended and could result in significantly lower migration speeds\" — with NO throughput figure published. The panel quotes that and labels the 3x default (MTV_VDDK_SPEEDUP) as this product's assumption, rather than implying a number Red Hat never gave."],
    ["Which half was measured", "Whatever rate is in hand — measured, or the conservative default — describes the configuration IN FORCE: the WITH figure when VDDK is configured, the WITHOUT figure when it is not. The other side is derived, and the panel says which is which."],
    ["Unknown is not false", "A provider that could not be read reports configured: null — \"we do not know\" — rather than \"not configured\", which would be a claim."],
    ["Corrected during build", "The assumption that warm migration requires VDDK was WRONG: Red Hat ties warm migration to changed block tracking. Checked against the documentation before it reached the product rather than after it reached a customer."],
  ], { height: 46 });
  note(ws, r, 2, "Sources: Red Hat, Installing and using the Migration Toolkit for Virtualization; Migrating virtual machines from VMware vSphere.", C.lightRed, C.darkRed);
}

// ═══ 8. RESOURCE GUARANTEES ═════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("8. Resource Guarantees", { properties: { tabColor: { argb: "FF" + C.userAmber } } });
  ws.columns = [{ width: 22 }, { width: 46 }, { width: 54 }];
  let r = banner(ws, "What a VM is promised, before and after",
    "A migration that copies every byte correctly can still land a workload that runs slower, because the two platforms mean different things by \"4 vCPU and 16 GB\".", 3);
  r = headerRow(ws, r, ["Resource", "On VMware", "On OpenShift Virtualization"]);
  r = dataRows(ws, r, [
    ["CPU", "Assigned vCPUs, optionally with a reservation, a limit and shares.", "Requests the vCPU count divided by the cluster's cpuAllocationRatio — 10 by default. A 4 vCPU guest requests 400m. The guest still SEES 4 CPUs; only the scheduler's view changes, which is why nothing inside the VM reveals it."],
    ["Memory", "Assigned, optionally reserved in full (\"reserve all guest memory\").", "Requested in full plus virt-launcher overhead, so it IS reserved at schedule time — but with no limit set the pod is Burstable, and Burstable is what gets evicted under node pressure."],
    ["Reservations, limits, shares", "Set per VM, and often the reason a tuned database performs.", "Not carried across by MTV at all. Gone."],
    ["Latency sensitivity, CPU affinity", "Pinned for latency-critical workloads.", "Not carried across. KubeVirt has dedicatedCpuPlacement, configured differently and requiring CPU Manager on the node."],
  ], { height: 66 });
  r = note(ws, r, 3, "The report states this per VM and for the wave: \"52 vCPU assigned on VMware becomes 5.2 cores requested here — the guests still see 52, but the scheduler does not.\"", C.lightAmber, C.darkAmber);
  r = note(ws, r, 3, "VMs holding a guarantee today are named with the evidence, and told what to set to get it back: dedicatedCpuPlacement, matching CPU/memory limits, CPU Manager enabled on the target nodes.", C.lightBlue, "1E40AF");
}

// ═══ 9. GOVERNANCE ══════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("9. Governance", { properties: { tabColor: { argb: "FF" + C.aiPurple } } });
  ws.columns = [{ width: 34 }, { width: 86 }];
  let r = banner(ws, "The gate lives in the cluster, not in the browser", null, 2);
  r = headerRow(ws, r, ["Control", "How"]);
  r = dataRows(ws, r, [
    ["Change record per Plan", "Quotes THAT plan's own footprint, transfer time and downtime — not the wave's. A wave splitting into two cold plans does not put the combined figure on both."],
    ["Approval stored on the Plan", "Annotations on the Forklift Plan. Refresh the console, restart the pod, come back tomorrow as a different operator — the gate is where you left it, and visible in `oc get plan -o yaml`."],
    ["Re-read on every call", "startMigration reads the gate from the cluster whatever the browser believed. An enabled button is not authorisation."],
    ["Silence is never approval", "readMigrationApproval() is pure and unit-tested. A rejection wins over any state that would otherwise read as approved."],
    ["Deliberate override", "MIGRATION_REQUIRE_APPROVAL=false. Named, documented, and off by default."],
    ["Rollback", "Deletes only what the migration created. Source VMs are never deleted and can be powered back on in vCenter."],
    ["Assessment provenance", "Every report carries a quotable ID (ASM-20260902-7C4E11), a timestamp, the source, the target cluster, the matrix version and the operator."],
    ["Windows and Linux never share a plan", "Different preparation, different verification, usually different teams. A plan mixing them could not be handed to either."],
  ], { height: 40 });
  note(ws, r, 2, "The evidence pack is generated as plain strings — no runtime library dependency — so an export that works in development cannot fail in the container.", C.lightPurple, "5B21B6");
}

// ═══ 9a. CUTOVER ════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("9a. Cutover", { properties: { tabColor: { argb: "FF" + C.orange } } });
  ws.columns = [{ width: 30 }, { width: 100 }];
  let r = banner(ws, "The cutover — the outage, scheduled into the window that was approved",
    "A warm migration stops after the precopy ON PURPOSE. The disks are copied, the guest is still serving users, and nothing more happens until someone says it may go down. Every other tool puts a Cutover button here and lets you press it whenever; that is how a production VM goes down at 3pm on a Tuesday.", 2);
  r = headerRow(ws, r, ["", "How it works"]);
  r = dataRows(ws, r, [
    ["What 'paused' means", "MTV has finished the full copy and is re-snapshotting hourly to keep it current. The plan reads CopyingPaused. This is success, not a stall — a console that calls it 'transfer stalled' sends someone to debug a healthy transfer pod."],
    ["What the gate is", "The cutover is the outage, so it is gated on the change request rather than on a button being present."],
    ["Not approved", "Refused, naming the change request and its state."],
    ["Approved, in window", "'Power off & cut over now' is enabled."],
    ["Approved, before it", "'Schedule for <window start>' — stamps spec.cutover on the Migration so MTV performs it with nobody present."],
    ["Approved, a chosen time", "A picker clamped to the approved window. The server re-checks BOTH ends and the clock, whatever the console offered."],
    ["Window expired", "Refused, pointing at the change board."],
    ["Window unknown", "Reported as unknown, never as open. A gate that fails open is not a gate."],
    ["If the board moves it", "The stamped cutover follows. Otherwise it fires at the old time — outside the window they approved, on a decision taken before they changed it."],
    ["The cost of waiting", "A warm precopy spends ONE changed-block snapshot per hour, and a VM supports 28. Waiting a day spends most of the budget on nothing and grows the delta the cutover has to copy — lengthening the very outage the window was sized for."],
    ["What happens at cutover", "The guest is shut down on VMware, the final changed blocks are copied, and the VM is started on OpenShift Virtualization."],
  ], { height: 34 });
  note(ws, r, 2, "Scheduling is what stops someone having to sit up until midnight. One human decision, then it runs unattended — and the window is still enforced.", C.lightAmber, C.darkAmber);
}

// ═══ 9b. POST-MIGRATION VERIFICATION ════════════════════════════════════════
{
  const ws = wb.addWorksheet("9b. Verification", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 32 }, { width: 62 }, { width: 46 }];
  let r = banner(ws, "'Succeeded' on a Plan describes the transfer, not the machine",
    "MTV reports success when it has finished copying and created the target VM. The questions a person actually has afterwards are different ones — and one of them costs real money if the answer is wrong.", 3);
  r = headerRow(ws, r, ["Check", "What it asks", "If it fails"]);
  r = dataRows(ws, r, [
    ["VM is running", "Is it up, and on which node?", "Usually firmware, Secure Boot or a missing driver. Read its events."],
    ["SOURCE VM IS POWERED OFF", "The one that costs money. Two copies of one identity on one network, each writing to storage the other cannot see.", "Power the source off NOW, before anyone uses the migrated copy. Whichever machine loses is the one somebody was using."],
    ["Kept its IP address", "Did the address survive, compared with what the Plan recorded?", "DNS, firewall rules, application config and monitoring all need updating."],
    ["All disks present", "Against the disk count recorded at plan creation.", "The storage map missed a datastore. A missing disk is a missing filesystem inside the guest."],
    ["CPU and memory match", "Did the shape survive the copy?", "Resize to match, unless the difference was deliberate."],
  ], { height: 36 });
  r += 1;
  r = headerRow(ws, r, ["Rule", "Why", ""]);
  r = dataRows(ws, r, [
    ["A check with no data is not a pass", "If the source platform cannot be reached, it says 'not confirmed' and the verdict drops to INCOMPLETE. It never reports 'source is powered off' because it failed to look.", ""],
    ["Compared against the PLAN", "Not against the source read back later — by then it may be powered off, changed or decommissioned. The promise travels with the plan that made it.", ""],
    ["Closure is on evidence", "A passing verdict closes the change request with the check results. Failed or incomplete closes nothing — that is the point of having a verdict.", ""],
  ], { height: 34 });
  note(ws, r, 3, "Verdicts: passed · passed-with-warnings · incomplete (a check could not run) · failed. Only the first two close a change request or permit decommissioning.", C.lightGreen, "065F46");
}

// ═══ 9c. CHANGE REQUEST LIFECYCLE ═══════════════════════════════════════════
{
  const ws = wb.addWorksheet("9c. Change Lifecycle", { properties: { tabColor: { argb: "FF" + C.aiPurple } } });
  ws.columns = [{ width: 26 }, { width: 104 }];
  let r = banner(ws, "Raised, sized, evidenced, and closed — the agent finishes what it starts",
    "A change request nobody closes is a change process nobody trusts. The agent raises it, waits on it and acts inside its window, so finishing it is the agent's job.", 2);
  r = headerRow(ws, r, ["Stage", "What the platform does"]);
  r = dataRows(ws, r, [
    ["Sizes the window", "IMPLEMENTATION window, not the outage — they are two different fields and two different promises. Pre-checks + the work + verification + BACKOUT + contingency, floored at a 4h standard maintenance slot and scaling beyond it for a large wave."],
    ["States both numbers", "'Implementation window: 4h. Expected service impact: 7 min.' A board authorises hours in which the service is down for minutes, and saying both is what makes it an honest request rather than an alarming one."],
    ["Lets you choose", "Left blank the proposal is used. A freeze period, a month-end or an already-agreed slot is the operator's to enter — this tool knows none of them."],
    ["Authors the content", "Implementation plan, backout plan, test plan, the machines, the estimate and its basis, and what a model contributed."],
    ["Attaches the record", "An HTML document built from the PLAN — so a request raised days later from a fresh session carries the same document. A description field is a poor place for a table of machines."],
    ["Follows the window", "If the board reschedules, the stamped cutover follows it, with a work note saying so."],
    ["Warns before it opens", "If the measured rate means the work no longer fits the approved window, the board is told once, before the window opens, while it can still be changed."],
    ["Closes on success", "Verification passing closes it with the check results and the reminder that the source VMs are intact and this is still reversible."],
    ["Cancels on rollback", "With what was removed, what could not be, and the manual step remaining. A rollback is not a failed change to file away — it is a change carried out and reversed, and the next person needs the state it was left in."],
  ], { height: 38 });
  note(ws, r, 2, "The cancel happens BEFORE the Plan is deleted: the Plan is where the change request's sys_id lives, so retiring it first would strand the record open with nothing left to close it.", C.lightPurple, "5B21B6");
}

// ═══ 9d. DECOMMISSION & HISTORY ═════════════════════════════════════════════
{
  const ws = wb.addWorksheet("9d. Retire & History", { properties: { tabColor: { argb: "FF" + C.secRed } } });
  ws.columns = [{ width: 30 }, { width: 100 }];
  let r = banner(ws, "The last step is the only irreversible one — and the record outlives it",
    "Until the source VMs are deleted a migration is reversible: MTV powers them off and never removes them, so the way back is to power them on again.", 2);
  r = headerRow(ws, r, ["", "Detail"]);
  r = dataRows(ws, r, [
    ["What it does NOT do", "It deletes nothing. This agent has read-only access to the source platform — it can see a VM's power state, it cannot remove it. It raises a request and tracks it; the VMware team carries it out, which is also where the audit trail for an irreversible act belongs."],
    ["A SECOND change request", "Not an amendment to the first: the migration was reversible and this is not, they are approved by different people at different times, and a rejected decommission must not reopen a migration that succeeded."],
    ["Soak period", "MIGRATION_SOAK_DAYS, default 7. Counted out in days remaining rather than refused, and waivable — with the waiver named on the change record."],
    ["Blocked outright by", "Not migrated · not verified · verification FAILED · split brain (running on both platforms)."],
    ["Blocked by INCOMPLETE too", "The check that usually could not run is 'is the source powered off'. Deleting on the strength of that is how the wrong machine gets deleted."],
    ["", ""],
    ["History — the problem", "The Plan used to BE the record, and a migration's history is most at risk exactly when it ends: a rollback deletes the Plan, decommission workflows delete Plans, clusters get rebuilt."],
    ["History — where it lives", "Postgres, mirroring the change ledger's shape, with an in-memory fallback that says so rather than looking durable. MIGRATION_HISTORY_RETENTION_DAYS, default 365."],
    ["History — what it keeps", "The stage timeline, the change request, the estimate against the measured actual, the verification verdict, and what the model cost that run."],
    ["History — the rules", "Written ONCE at the terminal event, append-only, one row per run keyed by a generated id. A machine rolled back and migrated again shows both attempts."],
    ["Not a second system of record", "ServiceNow holds the compliance record — approval trail, attached document, close notes — under the organisation's own retention. This is the operational record, and it points at the change request for the rest."],
  ], { height: 36 });
  note(ws, r, 2, "The migration only stops being reversible when the source VMs are gone — which is why that is a separate change request, raised after a soak, and carried out by someone else.", C.lightRed, "991B1B");
}

// ═══ 10. BUSINESS VALUE ═════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("10. Business Value", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 40 }, { width: 40 }, { width: 44 }];
  let r = banner(ws, "What changes for a migration programme", null, 3);
  r = headerRow(ws, r, ["Metric", "Manual baseline", "With UC-10"]);
  r = dataRows(ws, r, [
    ["Assess 100 VMs", "Days of spreadsheet work, once", "Minutes, repeatable, with an exported register"],
    ["\"Will it run when it lands?\"", "Discovered after the outage", "Answered before the wave"],
    ["Post-migration performance surprises", "A ticket three weeks later", "Named per VM at assessment"],
    ["\"Why was this moved unsupported?\"", "Archaeology", "Report ID, matrix version, tier, operator"],
    ["Outage estimate", "A vendor number", "This cluster's own throughput, then live bytes"],
    ["Assessment freshness", "Stale in weeks, silently", "Drift report on every run"],
    ["Half-migrated systems", "Found in production", "Warned before the wave is committed"],
    ["Rollback confidence", "\"Can we go back?\"", "Source VMs were never deleted"],
  ], { height: 30 });
  note(ws, r, 3, "The expensive part of a migration is not the transfer. It is everything nobody checked.", C.lightGreen, C.darkGreen);
}

// ═══ 11. DEMO SCRIPT ════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("11. Demo Script", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 10 }, { width: 34 }, { width: 80 }];
  let r = banner(ws, "Demo script — 7 minutes", null, 3);
  r = headerRow(ws, r, ["Min", "Beat", "Say"]);
  r = dataRows(ws, r, [
    ["—", "Before you start", "Press \u2921 Present in the Hub header: full screen, larger type, explanatory prose collapsed. Built for exactly this — a shared screen someone is talking over. Escape exits."],
    ["0–1", "Step 1 — Discover", "\"Read-only. Fourteen VMs, and note the Guest OS column: vCenter reports windows2019srvNext_64Guest. That is VMware's id for Server 2022 — read it literally and your whole Windows estate lands in 'needs review'.\""],
    ["1–3", "Step 2 — the report", "\"Every VM assessed, not the ones I already chose. Rings by OS family. Red Hat's three tiers. And 'Will it fit?' — this machine needs 64 GiB, the biggest node has 48. MTV would have copied 200 GiB and left it Pending.\""],
    ["3–4", "Expand a row", "\"Fifteen source checks per machine, each with its own fix. And '15 of 15 ran' — where the inventory tells us nothing, we say so rather than calling it a pass.\""],
    ["4–5", "Guarantees + export", "\"52 vCPU becomes 5.2 cores requested. The guests still see 52; the scheduler does not. Three VMs lose a reservation they have today. Then: evidence pack for the change board.\""],
    ["5–6", "Step 3 — choose the wave", "\"Pick two of the three ShopApp machines and it says db01 would stay on VMware. MTV has no idea these are one system.\""],
    ["6–7", "Step 4 — plan, CR, migrate", "\"Windows and Linux never share a plan. And here is the wave costed with and without the VDDK image — this cluster has none, so we are reading the slow column, and anything on vSAN would not migrate at all. The estimate comes from this cluster's own history. Change request raised and held on the Plan itself — Migrate stays disabled until the CAB says yes. And if it goes wrong: roll back. The source VMs were never deleted.\""],
  ], { height: 58 });
  note(ws, r, 3, "Best single moment: the blocked VM on the capacity panel. It is the failure everyone in the room has seen, explained before it happens.", C.lightBlue, "1E40AF");
}

// ═══ 12. VERIFICATION STATUS ════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("12. Verification Status", { properties: { tabColor: { argb: "FF" + C.userAmber } } });
  ws.columns = [{ width: 62 }, { width: 20 }, { width: 44 }];
  let r = banner(ws, "What is proven, and what is roadmap",
    "Stated honestly: a demo that overclaims costs more than one that admits a gap.", 3);
  r = headerRow(ws, r, ["Claim", "Status", "Evidence"]);
  r = dataRows(ws, r, [
    ["Discovery incl. vSphere guestId decoding", OK, "Unit-tested against 13 real guest ids, including the srvNext trap"],
    ["Support matrix vs Red Hat article 4234591", OK, "Read 2026-09-02; three tiers; unit-tested"],
    ["15 source-side checks, unchecked ≠ pass", OK, "Unit-tested in both directions"],
    ["Target capacity and single-node fit", OK, "Unit-tested; \"never\" separated from \"not today\""],
    ["Resource fidelity (reservations → Burstable)", OK, "Unit-tested"],
    ["Move-together groups", OK, "Unit-tested; over-populated signals dropped"],
    ["Drift against a stored baseline", OK, "Unit-tested; ConfigMap-backed"],
    ["Evidence pack (HTML + CSV, injection-safe)", OK, "Unit-tested"],
    ["Plan grouping incl. Windows/Linux split", OK, "Unit-tested"],
    ["Change-request gate held on the Plan", OK, "Verdict mapping unit-tested; live in the lab"],
    ["Live measured ETA with stall detection", OK, "Unit-tested"],
    ["Rollback — source never deleted", OK, "Decision logic unit-tested"],
    ["MTV readiness detection + RBAC guidance", OK, "Live; fixed after two field runs"],
    ["VDDK detection and the wave costed both ways", OK, "Unit-tested; the derivation is direction-aware"],
    ["Presentation mode for screen sharing", OK, "Live"],
    ["Wave scheduling against blackout windows", RM, "Roadmap"],
    ["RCA agent on a stalled transfer", RM, "Machinery exists (UC-05); auto-wiring is roadmap"],
  ], { height: 28 });
  note(ws, r, 3, "241 unit tests pin the deterministic half. The AI half is clamped by it.", C.lightGreen, C.darkGreen);
}

wb.xlsx.writeFile(OUT).then(() => console.log("✅ " + OUT));
