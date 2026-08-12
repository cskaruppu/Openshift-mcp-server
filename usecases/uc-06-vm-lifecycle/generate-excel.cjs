/**
 * TCS Agentic AI — UC-06: Governed VM Provisioning & Lifecycle
 * Generates: TCS-Agentic-AI-UC06-VM-Lifecycle.xlsx (beside this script)
 *
 * Run: node usecases/uc-06-vm-lifecycle/generate-excel.cjs
 */
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "TCS-Agentic-AI-UC06-VM-Lifecycle.xlsx");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const wb = new ExcelJS.Workbook();
wb.creator = "TCS Agentic AI Platform";
wb.created = new Date();
wb.title = "TCS Agentic AI — Governed VM Provisioning & Lifecycle · UC-06";
wb.company = "Tata Consultancy Services";
wb.subject = "UC-06 — governed VM provisioning and day-2 ownership for OpenShift Virtualization";

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

// ═══ 1. OVERVIEW ════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("1. Overview", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 30 }, { width: 95 }];
  let r = banner(ws, "TCS Agentic AI — Governed VM Provisioning & Lifecycle  ·  UC-06",
    "One sentence in. A governed, owned, accountable virtual machine out — and an agent that remembers why it built it.", 2);
  r = headerRow(ws, r, ["Attribute", "Detail"]);
  r = dataRows(ws, r, [
    ["Use case ID", "UC-06"],
    ["Full name", "TCS Agentic AI — Governed VM Provisioning & Lifecycle"],
    ["Product family", "TCS Agentic AI for Hybrid Infrastructure · Container & Kubernetes Operations"],
    ["Platform", "OpenShift Virtualization (KubeVirt) + CDI"],
    ["Tagline", "The console creates a VM. It does not remember why."],
    ["Category", "Governed provisioning / ITSM / FinOps"],
    ["Trigger", "HUMAN-INITIATED. There is deliberately no autonomous path — provisioning consumes quota, addresses, licences and money."],
    ["Human touchpoints", "Two: correct the pre-filled request, then approve it once (console or ServiceNow CAB)."],
    ["AI involvement", "ONE step — extracting intent from free text. The AI never chooses the image, the manifest or the command, and may never produce an SSH key."],
    ["Automatic steps", "22"],
    ["Contrast with UC-05", "UC-05 is agent-initiated and closes its own tickets. UC-06 is never autonomous. Keeping that boundary explicit is what lets UC-05's autonomy stay credible."],
    ["Differentiators", "1) Sizing reconciliation with the delta stated  2) Provenance written onto the VM  3) Expiry enforced, not recorded  4) Right-sizing that cites the original change request"],
  ], { height: 40 });
  note(ws, r, 2, "Provisioning is a transaction. Ownership is a lifecycle — and the second is where the operational cost actually sits.", C.lightGreen, C.darkGreen);
}

// ═══ 2. ACTOR MODEL ═════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("2. Actor Model", { properties: { tabColor: { argb: "FF" + C.aiPurple } } });
  ws.columns = [{ width: 18 }, { width: 42 }, { width: 65 }];
  let r = banner(ws, "Who does what — and what the AI is deliberately not allowed to do",
    "The AI explains. Deterministic code acts. A person decides.", 3);
  r = headerRow(ws, r, ["Actor", "What it means", "Where it is used"]);
  r = dataRows(ws, r, [
    [AI, "LLM reasoning over free text", "Intent extraction ONLY — turning a sentence into a typed request"],
    [AU, "Deterministic code — no AI, no human", "Catalogue discovery, template reconciliation, pre-flight, manifest build, dry-run, apply, ledger, access guidance, expiry sweep, right-sizing, health detection"],
    [MA, "Requires a person", "Correcting the request · APPROVING it (console or ServiceNow change board)"],
  ], { height: 52, boldFirst: false });
  r = note(ws, r, 3, "The AI never chooses the manifest, the image or the command. Everything it produces is a value in a typed struct the operator sees and can correct before anything is created.", C.lightPurple, "5B21B6");
  note(ws, r, 3, "CREDENTIAL BOUNDARY: the deterministic extractor wins on the SSH key field unconditionally. A language model inventing a credential is a failure mode with no acceptable version.", C.lightRed, C.darkRed);
}

// ═══ 3. WORKFLOW ════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("3. Workflow", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 6 }, { width: 40 }, { width: 18 }, { width: 62 }];
  let r = banner(ws, "End-to-end workflow — every step, with its actor",
    "22 automatic · 1 AI · 2 human", 4);
  r = headerRow(ws, r, ["#", "Step", "Actor", "Notes"]);
  r = dataRows(ws, r, [
    [1, "Request stated in plain language", MA, "In chat, or directly on the card"],
    [2, "Intent extracted into a typed VMRequest", AI, "LLM plus a deterministic fallback; heuristics win on conflict"],
    [3, "SSH key extraction", AU, "NEVER the AI — a model must not synthesise a credential"],
    [4, "Discover this cluster's catalogue", AU, "DataSources, instance types, preferences, storage classes"],
    [5, "Reconcile size to a golden template", AU, "States the delta: '+2 vCPU and +12Gi more than requested'"],
    [6, "Namespace exists, not platform-owned", AU, "kube-*, openshift-*, default refused outright"],
    [7, "Name collision check — every VM in a batch", AU, "A partial batch failure is worse than none at all"],
    [8, "Golden image present and Ready", AU, "Not-Ready warns: the VM would sit importing for a long time"],
    [9, "Storage class and NetworkAttachmentDefinition exist", AU, "A missing NAD means a VM with no network"],
    [10, "Quota headroom, per ResourceQuota", AU, "Exceeding blocks; ≥85% warns before you commit"],
    [11, "SSH key present", AU, "BLOCKING — a VM nobody can log in to is not provisioning"],
    [12, "Missing owner / expiry", AU, "Warns, does not block. Sprawl starts here"],
    [13, "Operator corrects the card", MA, "Pre-filled, editable, shows quota impact and the reconciliation line"],
    [14, "Server-side dry-run", AU, "?dryRun=All — the API server validates, nothing is created"],
    [15, "APPROVAL", MA, "THE ONLY GATE. Console, or a ServiceNow change board"],
    [16, "Change request raised", AU, "Implementation and backout plans filled in from the same names"],
    [17, "Poll the CAB decision", AU, "Off unless VM_APPROVAL_RECONCILE=true; never runs in spoke mode"],
    [18, "Re-run pre-flight AFTER approval", AU, "An approval can sit for days; the cluster moves on"],
    [19, "Apply the manifest", AU, "Persistent DataVolume, cloud-init, instance type, NAD"],
    [20, "Ledger the change", AU, "Inverse = decommission, so removal is a first-class revert"],
    [21, "Return access commands", AU, "virtctl ssh · console · direct IP once the VMI reports one"],
    [22, "Expiry sweep", AU, "Past its date → decommission change request"],
    [23, "Right-sizing", AU, "Cites the original request id"],
    [24, "Health detection", AU, "vmNotReady, vmGuestDiskFull → UC-05's incident pipeline"],
  ], { height: 30, boldFirst: false });
  note(ws, r, 4, "Steps 15 is the only place a person is required. Everything before it is preparation; everything after it is execution.", C.lightAmber, C.darkAmber);
}

// ═══ 4. PHASE 1 — WHAT MAKES A VM REAL ══════════════════════════════════════
{
  const ws = wb.addWorksheet("4. Real VM Bar", { properties: { tabColor: { argb: "FF" + C.secRed } } });
  ws.columns = [{ width: 20 }, { width: 55 }, { width: 60 }];
  let r = banner(ws, "Phase 1 — what separates a provisioned VM from a demo",
    "The unglamorous half that has to be right before anything else matters", 3);
  r = headerRow(ws, r, ["", "Before", "UC-06"]);
  r = dataRows(ws, r, [
    ["Root disk", { t: "containerDisk / emptyDisk — WIPED on every restart", c: C.darkRed, bg: C.lightRed }, { t: "dataVolumeTemplate → a real PVC that survives", c: C.darkGreen, bg: C.lightGreen }],
    ["Access", { t: "no cloud-init — the VM boots and nobody can log in", c: C.darkRed, bg: C.lightRed }, { t: "user, SSH key, hostname injected; password login disabled", c: C.darkGreen, bg: C.lightGreen }],
    ["Sizing", { t: "raw cpu / memory numbers", c: C.darkRed, bg: C.lightRed }, { t: "VirtualMachineClusterInstancetype + Preference", c: C.darkGreen, bg: C.lightGreen }],
    ["Network", { t: "pod network, masquerade only", c: C.darkRed, bg: C.lightRed }, { t: "NetworkAttachmentDefinition for bridge / VLAN", c: C.darkGreen, bg: C.lightGreen }],
    ["Lifecycle", { t: "bare running: false", c: C.darkRed, bg: C.lightRed }, { t: "runStrategy", c: C.darkGreen, bg: C.lightGreen }],
    ["Safety", { t: "direct POST to the API", c: C.darkRed, bg: C.lightRed }, { t: "server-side dry-run, then an approval gate", c: C.darkGreen, bg: C.lightGreen }],
    ["Memory of it", { t: "none", c: C.darkRed, bg: C.lightRed }, { t: "owner · cost centre · environment · request id · expiry · rationale", c: C.darkGreen, bg: C.lightGreen }],
  ], { height: 34 });
  note(ws, r, 3, "A VM whose disk is wiped on restart and that nobody can SSH into is not provisioning. It is a demo. Phase 1 was making the word honest.", C.lightRed, C.darkRed);
}

// ═══ 5. SIZING RECONCILIATION ═══════════════════════════════════════════════
{
  const ws = wb.addWorksheet("5. Sizing Reconciliation", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 24 }, { width: 105 }];
  let r = banner(ws, "Sizing reconciliation — the compromise, stated",
    "A web form takes what you type. It cannot tell you what the compromise is.", 2);
  r = headerRow(ws, r, ["Verdict", "Meaning"]);
  r = dataRows(ws, r, [
    [{ t: "exact", b: true, c: C.darkGreen, bg: C.lightGreen }, "The request matches a standard size precisely — said so, rather than left implied"],
    [{ t: "rounded-up", b: true, c: "1E40AF", bg: C.lightBlue }, "Nearest standard that meets or exceeds BOTH dimensions, with the delta named in vCPU and GiB"],
    [{ t: "exceeds-catalogue", b: true, c: "9A3412", bg: C.lightOrange }, "Nothing on this cluster is large enough. Needs an explicit size and an exception, not a silent downgrade"],
    [{ t: "none-available", b: true, c: C.textMed, bg: C.lightSlate }, "No instance types exist here, so the VM is sized explicitly — and the fact is stated"],
    [{ t: "explicit", b: true, c: C.textMed, bg: C.lightSlate }, "The requester named an instance type outright; it is used as given"],
  ], { height: 34, boldFirst: false });
  r = note(ws, r, 2, "\"You asked for 6 vCPU and 20Gi. The nearest standard size is u1.large (8 vCPU / 32Gi) — that is +2 vCPU and +12Gi more than requested.\"", C.lightAmber, C.darkAmber);
  note(ws, r, 2, "Platform teams argue about exactly this. Making the compromise visible is the thing a form cannot do.", C.paleBlue, "1E40AF");
}

// ═══ 6. PRE-FLIGHT ══════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("6. Pre-flight", { properties: { tabColor: { argb: "FF" + C.orange } } });
  ws.columns = [{ width: 45 }, { width: 16 }, { width: 68 }];
  let r = banner(ws, "Pre-flight — everything checked before anyone is asked to approve", null, 3);
  r = headerRow(ws, r, ["Check", "Blocks?", "Why it matters"]);
  const B = { t: "BLOCK", b: true, c: C.darkRed, bg: C.lightRed };
  const W = { t: "warn", b: true, c: C.darkAmber, bg: C.lightAmber };
  r = dataRows(ws, r, [
    ["Namespace exists", B, "Nothing can be created in a namespace that is not there"],
    ["Namespace is not platform-owned", B, "kube-*, openshift-*, default and openshift are refused outright"],
    ["Name free — for every VM in the batch", B, "A partial batch failure is worse than none at all"],
    ["Golden image DataSource present", B, "Without it the DataVolume never populates"],
    ["Golden image reports Ready", W, "The VM would sit importing for a long time"],
    ["Storage class exists", B, "The PVC would stay Pending forever"],
    ["NetworkAttachmentDefinition exists", B, "The VM would come up with no network at all"],
    ["SSH key supplied", B, "A VM nobody can log in to is not provisioning"],
    ["Quota headroom, per ResourceQuota", B, "Exceeding blocks outright; ≥85% warns before you commit"],
    ["Owner recorded", W, "Nobody to contact when the VM needs attention"],
    ["Expiry date set", W, "VMs without one are how sprawl starts"],
    ["Expiry date is valid and in the future", W, "An unparseable or past date is not enforceable"],
  ], { height: 30, boldFirst: false });
  note(ws, r, 3, "Pre-flight runs BEFORE submission — there is no point asking a change board to approve something that cannot succeed. It runs AGAIN after approval.", C.lightBlue, "1E40AF");
}

// ═══ 7. APPROVAL STATE MACHINE ══════════════════════════════════════════════
{
  const ws = wb.addWorksheet("7. Approval States", { properties: { tabColor: { argb: "FF" + C.userAmber } } });
  ws.columns = [{ width: 18 }, { width: 20 }, { width: 90 }];
  let r = banner(ws, "Approval — a submitted request outlives the browser, so it is durable state",
    "vm_requests table, with an in-memory mirror for the no-database case", 3);
  r = headerRow(ws, r, ["State", "Terminal?", "Meaning"]);
  r = dataRows(ws, r, [
    [{ t: "draft", b: true, c: C.textMed, bg: C.lightSlate }, "no", "Captured and editable. Nothing raised, nothing created."],
    [{ t: "submitted", b: true, c: "1E40AF", bg: C.lightBlue }, "no", "Change request raised; awaiting the CAB. Nothing created."],
    [{ t: "approved", b: true, c: C.darkAmber, bg: C.lightAmber }, "no", "The board said yes. Pre-flight is about to be re-checked."],
    [{ t: "provisioning", b: true, c: "5B21B6", bg: C.lightPurple }, "no", "Applying now."],
    [{ t: "provisioned", b: true, c: C.darkGreen, bg: C.lightGreen }, "YES", "Created and ledgered. Access commands returned."],
    [{ t: "rejected", b: true, c: C.darkRed, bg: C.lightRed }, "YES", "The board refused. Nothing was created."],
    [{ t: "cancelled", b: true, c: C.textMed, bg: C.lightSlate }, "YES", "The requester withdrew it."],
    [{ t: "failed", b: true, c: C.darkRed, bg: C.lightRed }, "YES", "Apply failed — OR pre-flight no longer passes, so it refuses to provision something different from what was approved."],
  ], { height: 34, boldFirst: false });
  r = note(ws, r, 3, "The reconciler is OFF unless VM_APPROVAL_RECONCILE=true, and never runs in spoke mode: a hub that is not the system of record for provisioning should not act on approvals.", C.lightAmber, C.darkAmber);
  note(ws, r, 3, "This is still human-approved. The human simply approves in ServiceNow rather than in the console — which is what a change-controlled estate requires, because the CAB is the authority and a platform-side button does not satisfy audit.", C.paleBlue, "1E40AF");
}

// ═══ 8. PROVENANCE ══════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("8. Provenance", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 38 }, { width: 14 }, { width: 76 }];
  let r = banner(ws, "Provenance — six values written onto the VM at creation",
    "Cheap to write, and the enabling mechanism for every day-2 capability", 3);
  r = headerRow(ws, r, ["Label / annotation", "Kind", "Purpose"]);
  r = dataRows(ws, r, [
    ["app.kubernetes.io/managed-by", "label", "Set to tcs-agentic-ai. THE AGENT CLAIMS ONLY WHAT IT BUILT — hand-made VMs are never touched."],
    ["tcs.ai/owner", "both", "Who to contact when the VM needs attention"],
    ["tcs.ai/cost-centre", "label", "Chargeback and showback"],
    ["tcs.ai/environment", "label", "dev / test / prod — drives the change risk rating"],
    ["tcs.ai/request-id", "annotation", "The change request this VM came from"],
    ["tcs.ai/expires-on", "annotation", "The decommission date — made enforceable rather than decorative"],
    ["tcs.ai/sizing-rationale", "annotation", "WHY this size was chosen. Read back when right-sizing months later."],
    ["tcs.ai/provisioned-at", "annotation", "When, for age-based judgements"],
  ], { height: 32 });
  note(ws, r, 3, "Without provenance a platform can provision. With it, a platform can be accountable.", C.lightGreen, C.darkGreen);
}

// ═══ 9. OWNERSHIP / DAY-2 ═══════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("9. Ownership", { properties: { tabColor: { argb: "FF" + C.valCyan } } });
  ws.columns = [{ width: 24 }, { width: 34 }, { width: 70 }];
  let r = banner(ws, "Ownership — the loop closing",
    "The claim a competitor cannot copy without first building UC-05", 3);
  r = headerRow(ws, r, ["Capability", "Trigger", "Outcome"]);
  r = dataRows(ws, r, [
    ["Right-size UP", "Memory ≥ 85% sustained for ≥ 7 days", "Change request recommending the next standard size, citing the ORIGINAL request id and the reason it was sized as it was"],
    ["Right-size DOWN", "Memory ≤ 25% and CPU ≤ 10%", "Change request recommending a smaller size — the same citation"],
    ["Enforce expiry", "Past tcs.ai/expires-on", "Decommission change request with the backout plan filled in, and the quota it releases named"],
    ["Warn before expiry", "Within 14 days of the date", "Surfaced to the owner to extend or confirm"],
    ["Detect not-Ready", "runStrategy says run, VM is not Ready for ≥ 10 min", "Flows into UC-05's incident pipeline — 30 min grace for disk import first"],
    ["Detect guest disk filling", "Guest filesystem < 10% free", "Same pipeline. Requires the qemu-guest-agent"],
    ["Access guidance", "On demand", "virtctl ssh / console / direct IP, with the cloud-init user read back from the VM itself"],
  ], { height: 40 });
  r = note(ws, r, 3, "\"This VM was provisioned under CHG0041022 on 12 March, sized u1.large. Since then, memory has been at 94% of 32Gi over eleven days. Recommend increasing it to u1.xlarge.\"", C.lightCyan, "155E75");
  note(ws, r, 3, "GUARDS: only running VMs are judged, only after a sustain window, and absent metrics mean \"cannot judge\", never \"idle\". A recommendation that fires on a spike trains people to ignore recommendations.", C.lightBlue, "1E40AF");
}

// ═══ 10. SAFETY ═════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("10. Safety", { properties: { tabColor: { argb: "FF" + C.secRed } } });
  ws.columns = [{ width: 32 }, { width: 96 }];
  let r = banner(ws, "Safety model — what stops this doing something you did not ask for", null, 2);
  r = headerRow(ws, r, ["Control", "Behaviour"]);
  r = dataRows(ws, r, [
    ["Never autonomous", "No auto-promote path exists anywhere in the design. Deliberate contrast with UC-05."],
    ["Protected namespaces", "kube-*, openshift-*, default and openshift are refused outright"],
    ["Batch cap", "Ten VMs per request"],
    ["Blocking pre-flight", "Missing image, taken name, exceeded quota, absent NAD, no SSH key"],
    ["Server-side dry-run", "Every path, before any apply"],
    ["Re-check after approval", "Refuses to provision something different from what was approved"],
    ["Change ledger", "Every creation reversible; the inverse is the decommission command"],
    ["AI boundary", "Extracts intent only — never picks the image, manifest or command"],
    ["Credential boundary", "The AI may not produce an SSH key under any circumstance"],
    ["Rate limits", "Provision 4 burst / 0.05 per sec; submit 6 burst / 0.1 per sec"],
  ], { height: 32 });
  note(ws, r, 2, "The AI explains. Deterministic code acts. A person decides. Same contract as UC-05.", C.lightPurple, "5B21B6");
}

// ═══ 11. BUSINESS VALUE ═════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("11. Business Value", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 34 }, { width: 44 }, { width: 50 }];
  let r = banner(ws, "Business value — where the return actually comes from", null, 3);
  r = headerRow(ws, r, ["", "Manual", "UC-06"]);
  r = dataRows(ws, r, [
    ["Request → running VM", { t: "Hours to days (ticket queue)", c: C.darkRed, bg: C.lightRed }, { t: "One approval", c: C.darkGreen, bg: C.lightGreen }],
    ["Requests with wrong sizing", { t: "Common — no reconciliation step", c: C.darkRed, bg: C.lightRed }, { t: "Delta shown before approval", c: C.darkGreen, bg: C.lightGreen }],
    ["VMs with a recorded owner", { t: "Patchy", c: C.darkRed, bg: C.lightRed }, { t: "Every one", c: C.darkGreen, bg: C.lightGreen }],
    ["VMs with an enforced expiry", { t: "Effectively none", c: C.darkRed, bg: C.lightRed }, { t: "Every one that sets a date", c: C.darkGreen, bg: C.lightGreen }],
    ["Right-sizing reviews", { t: "Ad hoc, usually never", c: C.darkRed, bg: C.lightRed }, { t: "Continuous", c: C.darkGreen, bg: C.lightGreen }],
    ["Reclaimed capacity", { t: "Whenever someone audits", c: C.darkRed, bg: C.lightRed }, { t: "On the expiry date", c: C.darkGreen, bg: C.lightGreen }],
    ["Audit evidence", { t: "Reconstructed after the fact", c: C.darkRed, bg: C.lightRed }, { t: "Change record + ledger entry per VM", c: C.darkGreen, bg: C.lightGreen }],
  ], { height: 32 });
  note(ws, r, 3, "VM sprawl is a real budget line. Every request form ever written has an \"expires on\" field, and almost no platform acts on it. UC-06 is the first part of this platform that does.", C.lightAmber, C.darkAmber);
}

// ═══ 12. DEMO SCRIPT ════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("12. Demo Script", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 9 }, { width: 26 }, { width: 95 }];
  let r = banner(ws, "Demo script — four minutes, end to end", null, 3);
  r = headerRow(ws, r, ["Time", "Show", "Say"]);
  r = dataRows(ws, r, [
    ["0:00", "Chat", "\"Provision a RHEL 9 VM called sap-app-01 in namespace sap, 8 vCPU, 32GB RAM, 200GB disk, production, expires 2026-12-31, and here is my SSH key.\""],
    ["0:30", "The card appears", "\"Nothing has been created. This is what it understood — and here is what a form cannot tell you.\""],
    ["1:00", "Reconciliation line", "\"You asked for 8 and 32. The nearest standard size is an exact match. Had it not been, it would say by how much.\""],
    ["1:20", "Quota bar", "\"This takes the namespace to 78% of quota. That is a decision, not a number.\""],
    ["1:50", "Dry-run", "\"Validated against the live API server. Still nothing created.\""],
    ["2:10", "Submit for approval", "\"The change request is raised. In a change-controlled estate the CAB is the authority, not a button in my console.\""],
    ["2:40", "ServiceNow → approve", "\"One human decision.\""],
    ["3:00", "VM + access panel", "\"Provisioned — and here is how to get into it, rather than making you hunt for the IP.\""],
    ["3:20", "Labels on the VM", "\"Owner, cost centre, change request, expiry, and why it was sized this way. Written onto the object.\""],
    ["3:40", "Lifecycle report", "\"Which is what lets it come back weeks later and tell you the VM it built is undersized — citing the request it was built under.\""],
  ], { height: 40, boldFirst: false });
  note(ws, r, 3, "Do not claim the CAB loop has run against a live ServiceNow instance until it has. See the Verification sheet.", C.lightRed, C.darkRed);
}

// ═══ 13. CONFIGURATION ══════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("13. Configuration", { properties: { tabColor: { argb: "FF" + C.slate } } });
  ws.columns = [{ width: 34 }, { width: 38 }, { width: 62 }];
  let r = banner(ws, "Configuration — every threshold is owned by the customer", null, 3);
  r = headerRow(ws, r, ["Variable", "Default", "Purpose"]);
  r = dataRows(ws, r, [
    ["VM_IMAGE_NAMESPACE", "openshift-virtualization-os-images", "Where golden image DataSources live"],
    ["VM_APPROVAL_RECONCILE", "false", "Poll ServiceNow for CAB approval and provision on transition"],
    ["VM_APPROVAL_INTERVAL_SEC", "300", "How often to poll"],
    ["VM_MEM_HIGH_PCT", "85", "Right-size UP above this, sustained"],
    ["VM_MEM_LOW_PCT", "25", "Right-size DOWN below this"],
    ["VM_CPU_HIGH_PCT", "80", "CPU equivalent, up"],
    ["VM_CPU_LOW_PCT", "10", "CPU equivalent, down"],
    ["VM_SUSTAIN_DAYS", "7", "Minimum VM age and sustain window before any judgement"],
    ["VM_EXPIRY_WARN_DAYS", "14", "Warn this far ahead of the expiry date"],
  ], { height: 28 });
  note(ws, r, 3, "Defaults are deliberately conservative. A right-sizing recommendation that fires on a spike trains people to ignore recommendations.", C.lightBlue, "1E40AF");
}

// ═══ 14. IMPLEMENTATION MAP ═════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("14. Implementation", { properties: { tabColor: { argb: "FF" + C.navy } } });
  ws.columns = [{ width: 46 }, { width: 52 }, { width: 46 }];
  let r = banner(ws, "Implementation map — where each concern lives", null, 3);
  r = headerRow(ws, r, ["Concern", "File", "Notes"]);
  r = dataRows(ws, r, [
    ["Request struct, extraction, reconciliation, pre-flight, manifest, apply", "src/services/vm-provisioning.js", "buildVMManifest is the single source of truth, shared with the MCP tool"],
    ["Fleet, expiry sweep, right-sizing, access guidance", "src/services/vm-lifecycle.js", "Reads provenance back off the VM"],
    ["Approval state machine + ServiceNow reconciler", "src/services/vm-request-store.js", "vm_requests table with an in-memory mirror"],
    ["MCP tools", "src/tools/kubevirt.js", "10 tools, filed under the VM Lifecycle Agent"],
    ["VM Request card", "console/src/views/ChatTokens.jsx", "VM_REQUEST token — renders inside the chat conversation"],
    ["Detection rules", "src/services/incident-detector.js", "vmNotReady, vmGuestDiskFull"],
    ["Change ledger", "src/services/change-ledger.js", "Inverse of a provision is a decommission"],
    ["API routes", "src/index.js", "/api/vm/* — request, preflight, dry-run, provision, lifecycle, access, requests"],
    ["Tests", "test/unit/vm-provisioning.test.js", "15 cases: extraction, reconciliation, manifest shape"],
  ], { height: 42 });
  r = headerRow(ws, r, ["MCP tool", "Purpose", ""]);
  r = dataRows(ws, r, [
    ["kubevirt_list_templates", "What can be provisioned here — images, instance types, preferences", ""],
    ["kubevirt_create_vm", "Provision with a persistent disk and cloud-init; supports dryRun", ""],
    ["kubevirt_vm_access", "How to connect: user, IPs, guest agent state, exact commands", ""],
    ["kubevirt_lifecycle_report", "Fleet, expiry, right-sizing — read-only", ""],
    ["kubevirt_list_vms / get / start / stop / restart / list_vmis", "Day-1 lifecycle", ""],
  ], { height: 28 });
}

// ═══ 15. VERIFICATION ═══════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("15. Verification", { properties: { tabColor: { argb: "FF" + C.userAmber } } });
  ws.columns = [{ width: 52 }, { width: 16 }, { width: 74 }];
  let r = banner(ws, "Verification status — stated plainly",
    "A demo that claims more than it has verified is one question away from falling apart", 3);
  r = headerRow(ws, r, ["Area", "Status", "Evidence / caveat"]);
  const OK = { t: "VERIFIED", b: true, c: C.darkGreen, bg: C.lightGreen };
  const PEND = { t: "NOT YET", b: true, c: C.darkAmber, bg: C.lightAmber };
  r = dataRows(ws, r, [
    ["Intent extraction, reconciliation, manifest shape", OK, "15 automated tests in test/unit/vm-provisioning.test.js"],
    ["Root disk is always a DataVolume, never a containerDisk", OK, "Asserted directly in test — this was the original defect"],
    ["Pre-flight, dry-run, provision, lifecycle routes", OK, "Exercised against a running server; degrade cleanly with no cluster"],
    ["Chat card end to end", OK, "Verified for both the bare ask and a partial one"],
    ["Sizing reconciliation verdicts", OK, "exact, rounded-up, exceeds-catalogue all covered"],
    ["ServiceNow CAB approval loop", PEND, "Built and unit-verified. NOT yet run against a live ServiceNow instance."],
    ["Right-sizing against real usage history", PEND, "Logic verified. Awaiting a workload with sustained history."],
    ["Expiry enforcement on a real expired VM", PEND, "Logic verified. Awaiting a VM that has actually passed its date."],
  ], { height: 34 });
  note(ws, r, 3, "Do not present the CAB approval loop or right-sizing as demonstrated until they have run against real systems. Everything else is safe to show.", C.lightRed, C.darkRed);
}

wb.xlsx.writeFile(OUT).then(() => console.log("XLSX written:", OUT));
