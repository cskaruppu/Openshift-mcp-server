/**
 * UC-10 — the canonical workflow, in one place.
 *
 * The deck and the workbook each used to carry their own copy of this, which is
 * why they drifted: four stages ending at "migrate or roll back", written
 * before the cutover, verification, decommission and history stages existed.
 * Both now read this file, so they cannot disagree with each other again — and
 * a change to the product is one edit here rather than two that someone has to
 * remember to keep in step.
 *
 * ACTORS
 *   AU  Deterministic — code, from data. No model involved in producing it.
 *   AI  A language model was asked. Two touchpoints, both advisory, both
 *       clamped by rules before anyone sees the answer.
 *   MA  A person. Every irreversible act is here on purpose.
 *   EX  External — MTV, ServiceNow or the VMware team acting on our request.
 *
 * ROUTE
 *   both | warm | cold — warm and cold are genuinely different journeys, not
 *   one journey with a flag. A cold migration powers the guest off at the START
 *   and the whole transfer is the outage; a warm one keeps it serving users and
 *   spends the outage at the very end, at the cutover.
 */

const AU = "Deterministic", AI = "AI-assisted", MA = "Manual", EX = "External";

const STAGES = [
  { id: 1, name: "Discover",        route: "both", blurb: "Read-only. Nothing is written to the source platform." },
  { id: 2, name: "Analyse support", route: "both", blurb: "Every VM assessed. The report is the decision record." },
  { id: 3, name: "Select & strategy", route: "both", blurb: "The wave is chosen after the evidence, never before it." },
  { id: 4, name: "Plan & change",   route: "both", blurb: "Plans validate; the change request carries the document." },
  { id: 5, name: "Transfer",        route: "both", blurb: "Measured live, judged against what was approved." },
  { id: 6, name: "Cutover",         route: "warm", blurb: "WARM ONLY. The outage. Scheduled inside the approved window." },
  { id: 7, name: "Verify",          route: "both", blurb: "Migrated is not working. Five checks decide which." },
  { id: 8, name: "Retire the source", route: "both", blurb: "The only irreversible step, behind a soak and a second change." },
  { id: 9, name: "Roll back",       route: "both", blurb: "Available at every stage until the source is deleted." },
];

const STEPS = [
  // ── 1. Discover ──────────────────────────────────────────────────────────
  ["1.1", 1, "Choose the source provider", MA, "The operator picks a registered MTV provider.", "Console"],
  ["1.2", 1, "Discover VMs", AU, "Read-only inventory call to MTV. Nothing is written to vCenter.", "discoverVMs"],
  ["1.3", 1, "Normalise each VM", AU, "IPs filtered of loopback/link-local, per-disk detail, MAC, firmware, reservation facts.", "normaliseInventoryVM"],
  ["1.4", 1, "Decode the guest id", AU, "windows2019srvNext_64Guest becomes Windows Server 2022, from a lookup table rather than a regex over the text.", "expandGuestId"],
  ["1.5", 1, "Detect the VDDK image", AU, "Reads spec.settings.vddkInitImage off the Forklift Provider — free, on a list already being fetched.", "providerVddk"],
  ["1.6", 1, "Read snapshot detail", AU, "What exists on the source, and what the inventory does NOT report — the creation date lives in vCenter, and saying so beats guessing it.", "snapshotDetail"],

  // ── 2. Analyse support ───────────────────────────────────────────────────
  ["2.1", 2, "Classify the guest OS", AU, "Matched against Red Hat's certified guest list. Three tiers: certified, vendor supported, known to run.", "classifyGuestOS"],
  ["2.2", 2, "Run 15 source checks", AU, "Snapshots, independent disks, RDM, shared disks, FT, vTPM, Secure Boot, devices, NIC coverage, VMware Tools.", "runSourceChecks"],
  ["2.3", 2, "Read target capacity", AU, "Node allocatable minus pod requests, counting only Ready, uncordoned, virt-schedulable nodes.", "readClusterCapacity"],
  ["2.4", 2, "Decide each VM's level", AU, "The worse of the guest matrix verdict and MTV's own concerns.", "analyseFleet"],
  ["2.5", 2, "Resource fidelity", AU, "vCPU assigned vs CPU requested at the cluster's overcommit ratio; reservations lost on migration.", "resourceFidelity"],
  ["2.6", 2, "Move-together groups", AU, "Inferred from subnet, name shape, vCenter folder and datastore, with the evidence kept beside the inference.", "affinityGroups"],
  ["2.7", 2, "Drift vs the last run", AU, "Pure diff against the stored baseline for this provider.", "diffAssessments"],
  ["2.8", 2, "Fleet findings", AU, "Blockers, EOL guests, VirtIO drivers, snapshots, cold-only bulk. Rules — always produced, model or not.", "fleetRemediation"],
  ["2.9", 2, "Warm or cold, per VM", AI, "THE JUDGEMENT CALL. Downtime traded against transfer complexity. One call for the whole fleet.", "adviseMigration"],
  ["2.10", 2, "Wave sequencing advice", AI, "At most 3 extra suggestions about ordering and risk. Cannot contradict the rules-based findings.", "adviseFleet"],
  ["2.11", 2, "Clamp the model's answer", AU, "Physics overrules the model before anyone sees it: invented VMs dropped, impossible warm forced cold.", "clampAdvice, powerPlan"],
  ["2.12", 2, "Snapshot policy per VM", AU, "Whether one exists, and whether to take one. Almost always no — and for warm it is fatal, not a trade-off.", "snapshotPolicy"],
  ["2.13", 2, "Account for model usage", AU, "Calls, tokens and cost, priced per model, with the arithmetic and the list-price caveat attached.", "aiProvenance, estimateCost"],
  ["2.14", 2, "Evidence pack", AU, "Report ID, timestamp, source, target cluster, matrix version, to printable HTML and a CSV register.", "assessment-report.js"],
  ["2.15", 2, "Validate the report", MA, "The operator reads it and decides whether it is true. Nothing proceeds without this.", "Console"],

  // ── 3. Select & strategy ─────────────────────────────────────────────────
  ["3.1", 3, "Choose the wave", MA, "Tick machines. Eligible ones are pre-ticked as a starting point, not a decision.", "Console"],
  ["3.2", 3, "Choose warm or cold", MA, "Pre-filled from 2.9; every value editable. Warm is only offered where it can physically work.", "Console"],
  ["3.3", 3, "Warn on split groups", AU, "Recomputed on every tick from 2.6 — 'db01 would stay on VMware'.", "splitGroups"],
  ["3.4", 3, "Target namespace and maps", MA, "Chosen from what the cluster actually has.", "Console"],

  // ── 4. Plan & change ─────────────────────────────────────────────────────
  ["4.1", 4, "Measure throughput", AU, "From migrations this cluster has already completed, not from a vendor figure.", "clusterThroughput"],
  ["4.2", 4, "Estimate transfer and downtime", AU, "Per plan, from that plan's own footprint. Stated separately, and costed both WITH and WITHOUT the VDDK image.", "estimatePlan, vddkComparison"],
  ["4.3", 4, "Group into plans", AU, "The five dimensions MTV forces, plus operating system so Windows and Linux never mix.", "planGroups"],
  ["4.4", 4, "Create the Plans", AU, "MTV validates them. Nothing moves.", "createPlans"],
  ["4.5", 4, "Size the change window", AU, "Pre-checks + work + verification + BACKOUT + contingency. Cold covers the whole copy; warm covers the cutover only.", "proposeWindow"],
  ["4.6", 4, "Choose the window", MA, "Optional. Left blank the proposal is used; a freeze period or an agreed slot is the operator's to enter.", "validateWindow"],
  ["4.7", 4, "Raise the change request", AU, "The platform authors it: implementation, backout, test plan, and the outage being approved.", "raiseMigrationCR"],
  ["4.8", 4, "Attach the migration record", AU, "An HTML document built from the Plan — every VM, how it moves, the impact, how to back out, what the model contributed.", "planReportHtml"],
  ["4.9", 4, "Approve", MA, "The CAB decides. This gate is not automatable by design.", "ServiceNow"],
  ["4.10", 4, "Check approval", AU, "Read from ServiceNow, written back onto the Plan as annotations.", "checkMigrationApproval"],
  ["4.11", 4, "Follow the window if it moves", AU, "If the board reschedules, the stamped cutover follows it — otherwise it fires outside the window they approved.", "reconcileCutoverWindow"],

  // ── 5. Transfer ──────────────────────────────────────────────────────────
  ["5.1", 5, "Start the migration", MA, "A human clicks. The server re-reads the gate from the cluster before acting.", "startMigration"],
  ["5.2", 5, "Transfer with a live rate", AU, "Megabytes moved of total, MiB/s and percent — the same figures MTV shows, in the same units.", "progressSnapshot, liveEta"],
  ["5.3", 5, "Judge estimate vs measured", AU, "The forecast against what is actually happening, while someone can still act on the difference.", "estimateVsActual"],
  ["5.4", 5, "Warn if the window no longer fits", AU, "Re-costed at the measured rate. The board is told BEFORE the window opens, once, as a work note.", "windowFit, measuredOutage"],

  // ── 6. Cutover (warm only) ───────────────────────────────────────────────
  ["6.1", 6, "Detect precopy complete", AU, "CopyingPaused is success, not a stall — the copy is done and MTV is waiting for a person.", "cutoverState"],
  ["6.2", 6, "Read the approved window", AU, "From the change record. An absent or unreadable window is reported as unknown, never as open.", "cutoverWindow"],
  ["6.3", 6, "Price the wait", AU, "A warm precopy spends one changed-block snapshot per hour and a VM holds 28. Waiting is not free.", "cbtSnapshotBudget"],
  ["6.4", 6, "Choose the cutover moment", MA, "Now, at the window opening, or a time picked inside the window. The server re-checks both ends.", "Console"],
  ["6.5", 6, "Execute the cutover", EX, "MTV shuts the guest down, copies the final changed blocks, and starts the VM on OpenShift.", "scheduleCutover"],

  // ── 7. Verify ────────────────────────────────────────────────────────────
  ["7.1", 7, "VM is running", AU, "And on which node. 'Succeeded' on a Plan describes the transfer, not the machine.", "verifyVM"],
  ["7.2", 7, "Source VM is powered off", AU, "THE ONE THAT COSTS MONEY. Two copies of one identity on one network is the failure nobody plans for.", "sourcePowerStates"],
  ["7.3", 7, "Kept its IP address", AU, "Or it did not, and DNS, firewall rules, monitoring and app config need updating.", "verifyVM"],
  ["7.4", 7, "All disks present", AU, "Against the count recorded on the Plan. A missing disk is a missing filesystem inside the guest.", "verifyVM"],
  ["7.5", 7, "CPU and memory match", AU, "Whether the shape survived the copy, compared with what the Plan promised.", "verifyVM"],
  ["7.6", 7, "Close the change request", AU, "On evidence. A verdict of failed or incomplete closes nothing — that is the point of having a verdict.", "closeMigrationCR"],
  ["7.7", 7, "Record the migration", AU, "One immutable row: the stage timeline, the change request, estimate against actual, and what the model cost.", "archiveMigration"],

  // ── 8. Retire the source ─────────────────────────────────────────────────
  ["8.1", 8, "Soak period", AU, "The migrated machines must run for a configured period first. Counted out in days, waivable, never skipped silently.", "decommissionReadiness"],
  ["8.2", 8, "Raise the decommission request", MA, "A SECOND change request. The migration was reversible; this is not, and different people approve it.", "raiseDecommissionCR"],
  ["8.3", 8, "Delete the source VMs", EX, "The VMware team carries it out. This agent has read-only access to the source and deletes nothing.", "ServiceNow / vCenter"],

  // ── 9. Roll back ─────────────────────────────────────────────────────────
  ["9.1", 9, "Roll back", MA, "Deletes only what the migration created. The source VMs are never touched.", "rollbackMigration"],
  ["9.2", 9, "Cancel the change request", AU, "With what was removed, what could not be, and the manual step remaining — before the Plan is deleted.", "cancelMigrationCR"],
  ["9.3", 9, "Record the rollback", AU, "A rolled-back run stays in the history beside the retry, because that is the story someone needs a year later.", "archiveMigration"],
];

/** Counted, never asserted — the ratio is the argument and it has to be true. */
function counts() {
  const by = {};
  for (const s of STEPS) by[s[3]] = (by[s[3]] || 0) + 1;
  return { ...by, total: STEPS.length };
}

/** The line that appears on both the deck and the workbook, computed once. */
function ratioLine() {
  const c = counts();
  return `${c.total} steps — ${c[AU]} deterministic · ${c[MA]} manual · ${c[AI]} AI-assisted · ${c[EX]} external`;
}

const stepsFor = (route) => STEPS.filter((s) => {
  const st = STAGES.find((x) => x.id === s[1]);
  return st.route === "both" || st.route === route;
});

module.exports = { AU, AI, MA, EX, STAGES, STEPS, counts, ratioLine, stepsFor };
