// ---------------------------------------------------------------------------
// Post-migration verification
// ---------------------------------------------------------------------------
/**
 * "Migrated" is not "working", and "Succeeded" on a Plan is not either.
 *
 * MTV reports success when it has finished copying and created the target VM.
 * That is a statement about the transfer, not about the machine. The questions
 * a person actually has afterwards are different ones: did the guest boot, did
 * it keep its address, did every disk come across, and — the one that costs
 * real money — is the source definitely switched off.
 *
 * Two rules carried over from the assessment side, for the same reason:
 *
 *   A CHECK WITH NO DATA IS NOT A PASS. If the source platform cannot be
 *   reached, this says so and counts the check as unrun. It never reports
 *   "source is powered off" because it failed to look.
 *
 *   The plan carries what it promised. Every comparison is against the source
 *   footprint recorded on the Plan at creation, not against the source read
 *   back later — which may by then be powered off, changed, or decommissioned.
 *
 * Everything here is pure.
 */

/** A check that could not run. Distinct from one that ran and passed. */
const unrun = (id, label, why) => ({ id, label, state: "unchecked", why });

const pass = (id, label, detail) => ({ id, label, state: "pass", detail });
const fail = (id, label, detail, action, severity = "critical") =>
  ({ id, label, state: "fail", detail, action, severity });
const warn = (id, label, detail, action) => ({ id, label, state: "warn", detail, action, severity: "warning" });

const gib = (n) => (n == null ? "?" : `${Math.round(n)} GiB`);

/**
 * Every post-migration check for one VM.
 *
 * @param {object} promised  what the Plan recorded about the source
 * @param {object} actual    vmRuntimeStatus() output for the target VM
 * @param {object} target    the target VirtualMachine spec facts, or null
 * @param {boolean|null} sourceOff  true/false, or NULL when the source could
 *                                  not be read — which is not "false"
 */
export function verifyVM(promised = {}, actual = null, target = null, sourceOff = null) {
  const checks = [];
  const name = promised.name || actual?.name || "vm";

  // ── Did it boot ────────────────────────────────────────────────────────
  if (!actual) {
    checks.push(fail("running", "VM is running",
      `No VirtualMachine named ${name} was found in the target namespace.`,
      "Check the Plan's target namespace and whether the migration actually created it."));
  } else if (actual.phase === "running") {
    checks.push(pass("running", "VM is running", `Running${actual.node ? ` on ${actual.node}` : ""}.`));
  } else {
    checks.push(fail("running", "VM is running",
      `${actual.status || actual.phase}${actual.detail ? ` — ${actual.detail}` : ""}`,
      "Start the VM, or read its events — a migrated VM that will not boot is usually firmware, Secure Boot or a missing driver."));
  }

  // ── The one that actually costs money ──────────────────────────────────
  // Both machines running means two copies of the same identity on the same
  // network, each writing to storage the other cannot see. Whichever one loses
  // is the one somebody was using.
  if (sourceOff === null) {
    checks.push(unrun("source-off", "Source VM is powered off",
      "The source platform could not be read, so this was not confirmed. It is the check worth doing by hand before anyone uses the migrated machine."));
  } else if (sourceOff) {
    checks.push(pass("source-off", "Source VM is powered off",
      "The source is off and was not deleted — it remains the way back until you decommission it."));
  } else {
    checks.push(fail("source-off", "Source VM is powered off",
      `${name} is still powered ON in the source platform while the migrated copy is running.`,
      "Power the source off now. Two machines with the same identity and address are both writing to storage the other cannot see."));
  }

  // ── Did it keep its address ────────────────────────────────────────────
  const wanted = (promised.ips || []).filter(Boolean);
  const got = (actual?.ips || []).filter(Boolean);
  if (!actual) {
    // Already reported as missing above; no second complaint.
  } else if (!got.length) {
    // No IP is also how "the guest agent is not running" presents, and the two
    // are worth separating because the fix is different.
    checks.push(warn("address", "Reports an IP address",
      "The migrated VM reports no address. Either the guest has not finished booting, the guest agent is not installed, or it did not get a lease.",
      "Install qemu-guest-agent in the guest. Until it runs, nothing here can confirm the OS actually came up."));
  } else if (!wanted.length) {
    checks.push(pass("address", "Reports an IP address",
      `${got.join(", ")} — the source address was not recorded, so there is nothing to compare it against.`));
  } else if (wanted.some((ip) => got.includes(ip))) {
    checks.push(pass("address", "Kept its IP address", `${got.join(", ")}, as on VMware.`));
  } else {
    checks.push(warn("address", "Kept its IP address",
      `Now ${got.join(", ")}; was ${wanted.join(", ")} on VMware.`,
      "Anything addressing this machine by IP — DNS, firewall rules, application config, monitoring — needs updating."));
  }

  // ── Did everything come across ─────────────────────────────────────────
  if (promised.disks == null) {
    checks.push(unrun("disks", "All disks present", "The source disk count was not recorded on the Plan."));
  } else if (!target) {
    checks.push(unrun("disks", "All disks present", "The target VM spec could not be read."));
  } else if (target.disks === promised.disks) {
    checks.push(pass("disks", "All disks present", `${target.disks} of ${promised.disks}${promised.diskGiB ? `, ${gib(promised.diskGiB)}` : ""}.`));
  } else {
    checks.push(fail("disks", "All disks present",
      `${target.disks} disk(s) on the migrated VM; the source had ${promised.disks}.`,
      "Check the storage map covered every datastore. A missing disk is a missing filesystem inside the guest."));
  }

  // ── Is it the machine that was promised ────────────────────────────────
  // Not a performance judgement — that was made in the fidelity assessment
  // before the wave. This only asks whether the shape survived the copy.
  if (!target || promised.cpu == null) {
    checks.push(unrun("shape", "CPU and memory match the source",
      target ? "The source CPU and memory were not recorded on the Plan." : "The target VM spec could not be read."));
  } else if (target.cpu === promised.cpu && (promised.memGiB == null || target.memGiB === promised.memGiB)) {
    checks.push(pass("shape", "CPU and memory match the source", `${target.cpu} vCPU, ${gib(target.memGiB)}.`));
  } else {
    checks.push(warn("shape", "CPU and memory match the source",
      `Migrated as ${target.cpu} vCPU / ${gib(target.memGiB)}; the source was ${promised.cpu} vCPU / ${gib(promised.memGiB)}.`,
      "Resize the VM to match, unless the difference was deliberate."));
  }

  return { name, checks, ...rollUp(checks) };
}

/** One verdict from many checks. Unrun checks never improve it. */
export function rollUp(checks = []) {
  const n = (s) => checks.filter((c) => c.state === s).length;
  const failed = n("fail"), warned = n("warn"), unchecked = n("unchecked"), passed = n("pass");
  const verdict = failed ? "failed" : unchecked ? "incomplete" : warned ? "passed-with-warnings" : "passed";
  return {
    verdict, counts: { pass: passed, warn: warned, fail: failed, unchecked },
    coverage: { ran: checks.length - unchecked, total: checks.length },
  };
}

/**
 * The whole fleet's verdict, and the sentence to put in front of a person.
 *
 * Deliberately does not say "migration successful": the only thing that
 * sentence can honestly describe is a machine that booted, kept its disks, and
 * whose source is off.
 */
export function verifySummary(vms = []) {
  const checks = vms.flatMap((v) => v.checks || []);
  const r = rollUp(checks);
  const bad = vms.filter((v) => v.verdict === "failed");
  const splitBrain = vms.filter((v) => (v.checks || []).some((c) => c.id === "source-off" && c.state === "fail"));

  let headline;
  if (splitBrain.length) {
    headline = `${splitBrain.length} machine${splitBrain.length === 1 ? " is" : "s are"} running on BOTH platforms. Power the source off before anyone uses the migrated copy.`;
  } else if (bad.length) {
    headline = `${bad.length} of ${vms.length} migrated machine${vms.length === 1 ? "" : "s"} did not pass verification.`;
  } else if (r.verdict === "incomplete") {
    headline = `${vms.length} machine${vms.length === 1 ? "" : "s"} migrated. ${r.counts.unchecked} check${r.counts.unchecked === 1 ? "" : "s"} could not run, so this is not a clean bill of health.`;
  } else if (r.verdict === "passed-with-warnings") {
    headline = `${vms.length} machine${vms.length === 1 ? "" : "s"} migrated and running, with ${r.counts.warn} thing${r.counts.warn === 1 ? "" : "s"} to follow up.`;
  } else {
    headline = `${vms.length} machine${vms.length === 1 ? "" : "s"} migrated, running, and verified. The source VMs are powered off and still exist.`;
  }
  return { ...r, headline, vms: vms.length, splitBrain: splitBrain.map((v) => v.name) };
}

/**
 * The end-to-end route, and where this plan has got to. Pure.
 *
 * Warm and cold are genuinely different journeys, not one journey with a flag:
 * a cold migration powers the guest off at the START and the outage is the
 * whole transfer, while a warm one keeps it serving users and spends the outage
 * at the very end. Showing both as the same five boxes is how someone ends up
 * expecting a cutover on a plan that never has one.
 */
export function migrationJourney(status = {}) {
  const warm = status.warm === true;
  const gate = status.gate || {};
  const approved = gate.required === false || gate.approved === true;
  const awaiting = status.cutover?.awaitingCutover === true;
  const verified = status.verification?.verdict === "passed" || status.verification?.verdict === "passed-with-warnings";

  const steps = warm
    ? [
        { key: "plan", label: "Plan created", detail: "Validated by MTV. Nothing has moved." },
        { key: "approve", label: "Change approved", detail: gate.number ? `${gate.number} — ${gate.state}` : "Raise the change request." },
        { key: "precopy", label: "Disks copy", detail: "The guest keeps serving users throughout." },
        { key: "cutover", label: "Cutover", detail: "The guest is powered off, the last changes copy, the VM starts on OpenShift. This is the only downtime." },
        { key: "verify", label: "Verified", detail: "Running, disks present, source confirmed off." },
      ]
    : [
        { key: "plan", label: "Plan created", detail: "Validated by MTV. Nothing has moved." },
        { key: "approve", label: "Change approved", detail: gate.number ? `${gate.number} — ${gate.state}` : "Raise the change request." },
        { key: "transfer", label: "Power off and copy", detail: "The guest is powered off first. The whole transfer is the outage." },
        { key: "boot", label: "Starts on OpenShift", detail: "MTV creates and starts the VM." },
        { key: "verify", label: "Verified", detail: "Running, disks present, source confirmed off." },
      ];

  // Position is read off the plan, never accumulated in the browser — a
  // refresh must not be able to move the pipeline forwards.
  let at = 0;
  if (status.found) at = 1;
  if (approved) at = 2;
  if (status.executing || status.succeeded) at = 3;
  if (warm && awaiting) at = 3;                       // paused AT the cutover step
  if (warm && status.succeeded) at = 4;
  if (!warm && status.succeeded) at = 4;
  if (verified) at = steps.length;

  const failed = status.failed || status.canceled;
  return {
    warm, steps, at, failed,
    // What a person should do next, in the words of this journey rather than
    // a generic "continue".
    next: failed ? "The plan failed or was cancelled — read the errors, then roll back or fix and re-run."
      : at >= steps.length ? "Done. Decommission the source VMs when you are satisfied."
      : warm && awaiting ? "Schedule the cutover. Everything else is finished and waiting on this."
      : steps[at]?.label ? `Next: ${steps[at].label.toLowerCase()}.` : null,
  };
}
