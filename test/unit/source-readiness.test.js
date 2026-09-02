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

test("snapshots are flagged as required work, and warm migration is called out", () => {
  const cold = find(runSourceChecks({ disks: [], hasSnapshot: true }), "snapshots");
  assert.equal(cold.blocks, false);
  assert.equal(cold.required, true);
  assert.match(cold.action, /Consolidate/);
  const warm = find(runSourceChecks({ disks: [], hasSnapshot: true, warmEligible: true }), "snapshots");
  assert.match(warm.detail, /another snapshot on top/);
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
