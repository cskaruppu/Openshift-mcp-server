import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planGroups, planNameFor, buildPlanManifest, buildMigrationManifest,
  rollbackPlan, normaliseInventoryVM,
} from "../../src/services/vm-migration.js";

const vm = (name, over = {}) => ({ id: `vm-${name}`, name, warmEligible: true, ...over });
const sel = (name, over = {}) => ({
  vm: vm(name, over.vm),
  strategy: "cold", sourceProvider: "vcenter-01",
  storageMap: "vmware-to-ocs", networkMap: "vmware-to-pod", targetNamespace: "prod-apps",
  // Spread last so an explicit null overrides the default rather than being
  // swallowed by it — the whole point of the missing-field test.
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "vm")),
});

// ── grouping: MTV forces this, so it must be exactly right ──────────────────

test("VMs sharing every plan-level field become ONE plan", () => {
  const { groups, errors } = planGroups([sel("a"), sel("b"), sel("c")]);
  assert.deepEqual(errors, []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].totalVMs, 3);
  assert.deepEqual(groups[0].vms.map((v) => v.name), ["a", "b", "c"]);
});

test("warm and cold cannot share a plan — Plan.spec.warm is plan-level", () => {
  const { groups } = planGroups([
    sel("a", { strategy: "warm" }), sel("b", { strategy: "cold" }),
    sel("c", { strategy: "warm" }),
  ]);
  assert.equal(groups.length, 2);
  const warm = groups.find((g) => g.warm), cold = groups.find((g) => !g.warm);
  assert.deepEqual(warm.vms.map((v) => v.name), ["a", "c"]);
  assert.deepEqual(cold.vms.map((v) => v.name), ["b"]);
});

test("each plan-level field forces a separate plan", () => {
  for (const field of ["sourceProvider", "storageMap", "networkMap", "targetNamespace"]) {
    const { groups } = planGroups([sel("a"), sel("b", { [field]: "different" })]);
    assert.equal(groups.length, 2, `${field} must split the selection`);
  }
});

test("a VM that cannot migrate warm is rejected with the reason, not silently made cold", () => {
  const { groups, errors } = planGroups([
    sel("ok", { strategy: "warm" }),
    sel("nocbt", { strategy: "warm", vm: { warmEligible: false, warmBlockedReason: "Changed block tracking is not enabled" } }),
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /nocbt/);
  assert.match(errors[0].message, /block tracking/i);
  // The eligible one still plans; the ineligible one is not quietly downgraded.
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].vms.map((v) => v.name), ["ok"]);
});

test("a missing map or namespace is reported per VM rather than producing a broken plan", () => {
  const { errors } = planGroups([sel("a", { storageMap: null, targetNamespace: null })]);
  assert.ok(errors.some((e) => /storageMap/.test(e.message)));
  assert.ok(errors.some((e) => /targetNamespace/.test(e.message)));
});

test("plan names are DNS-safe, deterministic and unique per group", () => {
  const { groups } = planGroups([sel("a", { strategy: "warm" }), sel("b", { strategy: "cold" })]);
  for (const g of groups) {
    assert.match(g.planName, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/, `${g.planName} must be DNS-safe`);
    assert.ok(g.planName.length <= 53);
  }
  assert.notEqual(groups[0].planName, groups[1].planName);
  // Same group shape always names the same way.
  assert.equal(planNameFor({ strategy: "cold", targetNamespace: "prod-apps" }, 0),
               planNameFor({ strategy: "cold", targetNamespace: "prod-apps" }, 0));
});

// ── manifests ───────────────────────────────────────────────────────────────

test("the Plan manifest carries warm at plan level and every VM in the list", () => {
  const { groups } = planGroups([sel("a", { strategy: "warm" }), sel("b", { strategy: "warm" })]);
  const m = buildPlanManifest(groups[0], { targetProvider: "host" });
  assert.equal(m.kind, "Plan");
  assert.equal(m.spec.warm, true);
  assert.equal(m.spec.vms.length, 2);
  assert.equal(m.spec.targetNamespace, "prod-apps");
  assert.equal(m.spec.map.storage.name, "vmware-to-ocs");
  assert.equal(m.spec.provider.destination.name, "host");
});

test("a cold plan sets warm false explicitly rather than omitting it", () => {
  const { groups } = planGroups([sel("a")]);
  assert.equal(buildPlanManifest(groups[0], { targetProvider: "host" }).spec.warm, false);
});

test("the Migration manifest references its plan, and carries cutover only when given", () => {
  assert.equal(buildMigrationManifest("p1").spec.cutover, undefined);
  const withCut = buildMigrationManifest("p1", { cutover: "2026-01-01T00:00:00Z" });
  assert.equal(withCut.spec.cutover, "2026-01-01T00:00:00Z");
  assert.equal(withCut.spec.plan.name, "p1");
});

// ── rollback: what it MEANS at each stage ───────────────────────────────────

test("rolling back a planned-but-not-started migration touches nothing", () => {
  const d = rollbackPlan({ found: true, vms: [] });
  assert.equal(d.stage, "planned");
  assert.equal(d.reversible, true);
  assert.equal(d.sourceAction, null, "nothing has happened to the source");
  assert.equal(d.warning, null);
});

test("rolling back a cold transfer requires powering the source back on", () => {
  const d = rollbackPlan({ found: true, executing: true, warm: false, vms: [{ started: "t" }] });
  assert.equal(d.stage, "transferring-cold");
  assert.match(d.sourceAction, /Power the source/i);
  assert.match(d.warning, /discarded/i);
});

test("rolling back a warm transfer needs no source action — it has not cut over", () => {
  const d = rollbackPlan({ found: true, executing: true, warm: true, vms: [{ started: "t" }] });
  assert.equal(d.stage, "transferring-warm");
  assert.match(d.sourceAction, /still running/i);
});

test("rolling back after cutover warns about data written inside the migrated VM", () => {
  const d = rollbackPlan({ found: true, succeeded: true, vms: [{ phase: "Completed" }] });
  assert.equal(d.stage, "migrated");
  assert.equal(d.reversible, true);
  assert.match(d.sourceAction, /Power the source/i);
  assert.match(d.warning, /data written INSIDE/i);
});

test("no stage ever proposes deleting the source VM", () => {
  for (const st of [
    { found: true, vms: [] },
    { found: true, executing: true, warm: false, vms: [{ started: "t" }] },
    { found: true, executing: true, warm: true, vms: [{ started: "t" }] },
    { found: true, succeeded: true, vms: [{ phase: "Completed" }] },
  ]) {
    const d = rollbackPlan(st);
    const text = JSON.stringify(d).toLowerCase();
    assert.doesNotMatch(text, /delete the source|remove the source|destroy/, "the source VM is the way back and is never deleted");
  }
});

// ── inventory normalisation ─────────────────────────────────────────────────

test("warm eligibility needs BOTH change tracking and a powered-on VM", () => {
  const on = { powerState: "poweredOn", changeTrackingEnabled: true };
  assert.equal(normaliseInventoryVM(on).warmEligible, true);

  const noCbt = normaliseInventoryVM({ powerState: "poweredOn", changeTrackingEnabled: false });
  assert.equal(noCbt.warmEligible, false);
  assert.match(noCbt.warmBlockedReason, /block tracking/i);

  const off = normaliseInventoryVM({ powerState: "poweredOff", changeTrackingEnabled: true });
  assert.equal(off.warmEligible, false);
  assert.match(off.warmBlockedReason, /powered off/i);
});

test("disk footprint is summed across disks and reported in GiB", () => {
  const v = normaliseInventoryVM({ name: "db", disks: [{ capacity: 107374182400 }, { capacity: 53687091200 }] });
  assert.equal(v.diskCount, 2);
  assert.equal(v.diskGiB, 150);
});
