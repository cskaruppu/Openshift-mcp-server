import { test } from "node:test";
import assert from "node:assert/strict";
import { runSourceChecks, coverageNote, flag } from "../../src/services/source-readiness.js";

const find = (r, id) => r.findings.find((f) => f.id === id);
const unchecked = (r, id) => r.unchecked.some((u) => u.id === id);

// The property that makes this trustworthy: silence is never a pass.

test("a fact the inventory never reported is unchecked, not clean", () => {
  const r = runSourceChecks({ name: "vm", disks: [] });
  assert.equal(find(r, "snapshots"), undefined, "no snapshot finding");
  assert.ok(unchecked(r, "snapshots"), "but it must be recorded as UNCHECKED, not passed");
  assert.ok(unchecked(r, "tpm"));
  assert.ok(unchecked(r, "devices"));
  assert.ok(r.coverage.ran < r.coverage.total);
});

test("a reported-false fact counts as a check that ran and passed", () => {
  const r = runSourceChecks({ name: "vm", disks: [], hasSnapshot: false, tpmEnabled: false });
  assert.equal(find(r, "snapshots"), undefined);
  assert.ok(!unchecked(r, "snapshots"), "false is an answer; null is not");
  assert.ok(!unchecked(r, "tpm"));
});

test("flag() distinguishes false from unknown", () => {
  assert.equal(flag(true), true);
  assert.equal(flag(false), false);
  assert.equal(flag(undefined, null), null);
  assert.equal(flag(null, false), false);
  assert.equal(flag("true"), true);
});

// ── Blocking checks ────────────────────────────────────────────────────────

test("independent disks block, because snapshots cannot see them", () => {
  const r = runSourceChecks({ disks: [{ name: "disk1", mode: "independent_persistent" }] });
  const f = find(r, "independentDisk");
  assert.equal(f.blocks, true);
  assert.match(f.action, /dependent mode/);
});

test("RDMs, shared disks, FT and templates all block", () => {
  assert.equal(find(runSourceChecks({ disks: [{ name: "d", rdm: true }] }), "rdm").blocks, true);
  assert.equal(find(runSourceChecks({ disks: [{ name: "d", shared: true }] }), "sharedDisk").blocks, true);
  assert.equal(find(runSourceChecks({ disks: [], faultToleranceEnabled: true }), "faultTolerance").blocks, true);
  assert.equal(find(runSourceChecks({ disks: [], isTemplate: true }), "template").blocks, true);
});

test("a disconnected source VM blocks, since its inventory is stale", () => {
  assert.equal(find(runSourceChecks({ disks: [], connectionState: "disconnected" }), "connection").blocks, true);
  assert.equal(find(runSourceChecks({ disks: [], connectionState: "connected" }), "connection"), undefined);
});

// ── Non-blocking, but the ones that ruin a cutover ─────────────────────────

test("snapshots are named as the hard rule they are, not as slower transfers", () => {
  const f = find(runSourceChecks({ disks: [], hasSnapshot: true }), "snapshots");
  // A cold migration still works — it just copies the chain — so this does not
  // block outright. Warm is impossible, and that is stated as a rule rather
  // than as advice, because MTV enforces it whatever the report says.
  assert.equal(f.blocks, false);
  assert.equal(f.blocksWarm, true);
  assert.equal(f.required, true);
  assert.match(f.title, /warm migration is not possible/i);
  assert.match(f.detail, /VMHasSnapshots/);
  assert.match(f.action, /Manage Snapshots|Consolidation/);
});

test("a vTPM names the cluster setting it depends on", () => {
  const f = find(runSourceChecks({ disks: [], tpmEnabled: true }), "tpm");
  assert.equal(f.required, true);
  assert.match(f.detail, /vmStateStorageClass/, "the operator needs the setting's name, not 'configure TPM'");
  assert.match(f.detail, /Windows 11/);
});

test("passthrough hardware is weighted above a sound card", () => {
  const serious = find(runSourceChecks({ disks: [], devices: [{ kind: "VirtualPCIPassthrough" }] }), "devices");
  assert.equal(serious.severity, "warning");
  assert.equal(serious.required, true);

  const cosmetic = find(runSourceChecks({ disks: [], devices: [{ kind: "VirtualSoundCard" }] }), "devices");
  assert.equal(cosmetic.severity, "info");
  assert.equal(cosmetic.required, false);

  // No recognised device is a pass, not a finding.
  assert.equal(find(runSourceChecks({ disks: [], devices: [{ kind: "VirtualDisk" }] }), "devices"), undefined);
});

test("multiple networks warn about network map coverage, one does not", () => {
  const two = find(runSourceChecks({ disks: [], nics: [{ network: "prod" }, { network: "dmz" }] }), "nics");
  assert.equal(two.required, true);
  assert.match(two.detail, /prod, dmz/);
  // Two NICs on the SAME port group need only one map entry.
  assert.equal(find(runSourceChecks({ disks: [], nics: [{ network: "prod" }, { network: "prod" }] }), "nics"), undefined);
});

test("VMware Tools not running explains what is lost, not just its state", () => {
  const f = find(runSourceChecks({ disks: [], toolsStatus: "toolsNotRunning" }), "tools");
  assert.match(f.detail, /no IP addresses/);
  assert.equal(find(runSourceChecks({ disks: [], toolsStatus: "toolsOk" }), "tools"), undefined);
});

test("a fully clean VM produces no findings but still reports its coverage", () => {
  const r = runSourceChecks({
    disks: [{ name: "d", capacityGiB: 40 }], hasSnapshot: false, isTemplate: false,
    faultToleranceEnabled: false, connectionState: "connected", toolsStatus: "toolsOk",
    tpmEnabled: false, secureBoot: false, firmware: "bios", devices: [], nics: [{ network: "prod" }],
    cpuAffinity: [], cpuHotAddEnabled: false, memoryHotAddEnabled: false,
  });
  assert.equal(r.findings.length, 0);
  assert.equal(r.coverage.ran, r.coverage.total, "everything was answered");
  assert.match(coverageNote(r.coverage, r.unchecked), /All \d+ source checks ran/);
});

test("the coverage note names what could not be checked", () => {
  const r = runSourceChecks({ disks: [] });
  const note = coverageNote(r.coverage, r.unchecked);
  assert.match(note, /source checks ran/);
  assert.match(note, /Not reported by the inventory/);
});

test("'toolsNotRunning' is not read as running", () => {
  // The trap: vSphere's value for a stopped agent contains the word "running".
  for (const v of ["toolsNotRunning", "guestToolsNotRunning", "toolsNotInstalled"]) {
    const f = find(runSourceChecks({ disks: [], toolsStatus: v }), "tools");
    assert.ok(f, `${v} must be flagged`);
    assert.equal(f.severity, "warning");
  }
  for (const v of ["toolsOk", "guestToolsRunning", "running"]) {
    assert.equal(find(runSourceChecks({ disks: [], toolsStatus: v }), "tools"), undefined, `${v} is healthy`);
  }
  // Out of date is a real state, and it is not the same as stopped.
  const old = find(runSourceChecks({ disks: [], toolsStatus: "toolsOld" }), "tools");
  assert.equal(old.severity, "info");
  assert.match(old.title, /out of date/);
});

test("report strings agree in number — these end up in a change record", () => {
  const one = find(runSourceChecks({ disks: [{ name: "disk-2", rdm: true }] }), "rdm");
  assert.match(one.title, /^1 raw device mapping$/);
  assert.match(one.detail, /disk-2 maps directly/);

  const two = find(runSourceChecks({ disks: [{ name: "a", rdm: true }, { name: "b", rdm: true }] }), "rdm");
  assert.match(two.title, /^2 raw device mappings$/);
  assert.match(two.detail, /a, b map directly/);

  const ind = find(runSourceChecks({ disks: [{ name: "d", mode: "independent_persistent" }] }), "independentDisk");
  assert.match(ind.detail, /d is excluded/);
});

test("pre-existing snapshots rule out warm migration, and are caught before the plan exists", async () => {
  const { normaliseInventoryVM } = await import("../../src/services/vm-migration.js");
  const base = { name: "redhat2", powerState: "poweredOn", changeTrackingEnabled: true };

  // CBT on and powered on is not enough. Forklift refuses to stack its own
  // tracking snapshot on an existing chain, so this VM can never go warm —
  // and finding that out from MTV after the plan is created is exactly the
  // failure this assessment exists to prevent.
  const snapped = normaliseInventoryVM({ ...base, snapshot: { id: "snapshot-42" } });
  assert.equal(snapped.hasSnapshot, true);
  assert.equal(snapped.warmEligible, false);
  assert.match(snapped.warmBlockedReason, /pre-existing snapshots/i);
  assert.match(snapped.warmBlockedReason, /Consolidate or delete|migrate cold/i);

  // Without one, warm is on the table as before.
  const clean = normaliseInventoryVM({ ...base, snapshot: null });
  assert.equal(clean.hasSnapshot, false);
  assert.equal(clean.warmEligible, true);
  assert.equal(clean.warmBlockedReason, null);

  // An inventory that says nothing about snapshots leaves warm available and
  // reports the check as unrun — it does not guess in either direction.
  const quiet = normaliseInventoryVM({ ...base });
  assert.equal(quiet.hasSnapshot, null);
  assert.equal(quiet.warmEligible, true);

  // Forklift's own array form.
  assert.equal(normaliseInventoryVM({ ...base, snapshot: [{ id: "s1" }] }).warmEligible, false);
  assert.equal(normaliseInventoryVM({ ...base, snapshot: [] }).warmEligible, true);

  // The readiness finding names the rule rather than describing it as slowness.
  const { runSourceChecks } = await import("../../src/services/source-readiness.js");
  const f = runSourceChecks({ hasSnapshot: true }).findings.find((x) => x.id === "snapshots");
  assert.equal(f.blocksWarm, true);
  assert.equal(f.blocks, false, "a cold migration still works");
  assert.match(f.detail, /VMHasSnapshots/);
  assert.match(f.action, /Manage Snapshots|Consolidat/i);
});

test("the snapshot review shows what is known and names what is not", async () => {
  const { snapshotDetail, snapshotPolicy, normaliseInventoryVM } = await import("../../src/services/vm-migration.js");

  // Forklift's actual shape: a reference. No date, no size, no description —
  // and the age is the thing that decides whether it is safe to delete, so the
  // gap is reported rather than papered over.
  const ref = snapshotDetail({ id: "snapshot-4021", kind: "VirtualMachineSnapshot" });
  assert.equal(ref.count, 1);
  assert.equal(ref.items[0].createdAt, null);
  assert.equal(ref.datesKnown, false);
  assert.match(ref.note, /not when it was taken/);

  // When a richer object does come back, it is read rather than ignored.
  const full = snapshotDetail([
    { id: "s1", name: "before-patching", createTime: "2026-03-02T09:14:00Z", size: 21474836480 },
    { id: "s2", name: "before-upgrade", createTime: "2026-08-30T22:00:00Z" },
  ]);
  assert.equal(full.count, 2);
  assert.equal(full.datesKnown, true);
  assert.equal(full.note, null);
  assert.equal(full.items[0].sizeGiB, 20);

  assert.equal(snapshotDetail(null), null);
  assert.equal(snapshotDetail([]), null);

  // The review reaches the finding, including the "we cannot see the date" note.
  const { runSourceChecks } = await import("../../src/services/source-readiness.js");
  const f = runSourceChecks({ hasSnapshot: true, snapshotDetail: ref }).findings.find((x) => x.id === "snapshots");
  assert.match(f.title, /a pre-existing snapshot/);
  assert.match(f.detail, /snapshot-4021/);
  assert.match(f.detail, /not when it was taken/);
  assert.match(runSourceChecks({ hasSnapshot: true, snapshotDetail: full }).findings
    .find((x) => x.id === "snapshots").title, /2 pre-existing snapshots/);

  // ── Should one be TAKEN before migrating? Almost always no. ─────────────
  const clean = normaliseInventoryVM({ name: "app-01", powerState: "poweredOn", changeTrackingEnabled: true, snapshot: null });

  // Warm: not a trade-off, fatal. Offering "snapshot then proceed" here would
  // recreate the very failure the assessment now catches.
  const warm = snapshotPolicy(clean, "warm");
  assert.equal(warm.recommend, "no");
  assert.match(warm.why, /impossible/);
  assert.equal(warm.canAutomate, false, "the agent reads the source; it cannot write to it");

  // Cold: the powered-off source VM is already the restore point.
  const cold = snapshotPolicy(clean, "cold");
  assert.equal(cold.recommend, "not-needed");
  assert.match(cold.why, /never modifies or deletes the source/);
  assert.match(cold.then, /change policy requires/, "the legitimate yes case is offered, not argued with");

  // One that already has a snapshot is told to clear it first, whatever the
  // strategy — that question comes before the take-one-or-not question.
  const dirty = normaliseInventoryVM({ name: "redhat2", powerState: "poweredOn", changeTrackingEnabled: true, snapshot: { id: "s1" } });
  assert.equal(snapshotPolicy(dirty, "cold").recommend, "remove");
  assert.equal(snapshotPolicy(dirty, "warm").recommend, "remove");
});
