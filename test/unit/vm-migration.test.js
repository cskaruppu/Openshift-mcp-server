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

// ── readiness must distinguish "may not look" from "not there" ──────────────
// From the field: MTV v2.11.7 was installed and healthy, but the agent had no
// RBAC for forklift.konveyor.io. A 403 was reported as "not installed", which
// sends someone to reinstall a working operator.
test("a 403 is an RBAC denial with a fix, never a missing install", async () => {
  const { mtvAccessVerdict } = await import("../../src/services/vm-migration.js");
  const v = mtvAccessVerdict({ status: 403, error: "OCP API 403: forbidden", namespace: "openshift-mtv" });
  assert.equal(v.code, "mtv-rbac-denied");
  assert.equal(v.rbacDenied, true);
  assert.match(v.message, /installed, but/i, "must not claim MTV is absent");
  assert.match(v.message, /openshift-mtv/);
  assert.match(v.fix, /^oc apply -f https:/, "must offer the grant command");
});

test("a 404 means the API really is not served, and offers no RBAC fix", async () => {
  const { mtvAccessVerdict } = await import("../../src/services/vm-migration.js");
  const v = mtvAccessVerdict({ status: 404, error: "OCP API 404: not found" });
  assert.equal(v.code, "mtv-not-installed");
  assert.equal(v.rbacDenied, undefined);
  assert.equal(v.fix, undefined, "reinstalling is not a one-command grant");
  assert.match(v.message, /not installed/i);
});

test("any other failure keeps the underlying error rather than guessing", async () => {
  const { mtvAccessVerdict } = await import("../../src/services/vm-migration.js");
  const v = mtvAccessVerdict({ status: 0, error: "connect ETIMEDOUT" });
  assert.equal(v.code, "mtv-not-installed");
  assert.match(v.message, /ETIMEDOUT/);
});

test("a successful read produces no verdict at all", async () => {
  const { mtvAccessVerdict } = await import("../../src/services/vm-migration.js");
  assert.equal(mtvAccessVerdict({ status: 0, error: null }), null);
  assert.equal(mtvAccessVerdict({}), null);
});

// ── the advisor's guardrail: the model advises, code decides ────────────────
test("a warm recommendation for a VM that cannot do warm is downgraded, not trusted", async () => {
  const { clampAdvice } = await import("../../src/services/vm-migration.js");
  const vms = [{ name: "db-01", warmEligible: false, warmBlockedReason: "Changed block tracking is not enabled." }];
  const [a] = clampAdvice([{ name: "db-01", strategy: "warm", reason: "Large disk, keep it up", risk: "low" }], vms);
  assert.equal(a.strategy, "cold", "physics beats the model");
  assert.equal(a.overridden, true);
  assert.match(a.reason, /block tracking/i, "the real reason replaces the model's");
});

test("the model cannot invent a VM that was never discovered", async () => {
  const { clampAdvice } = await import("../../src/services/vm-migration.js");
  const out = clampAdvice(
    [{ name: "real", strategy: "cold" }, { name: "hallucinated", strategy: "warm" }],
    [{ name: "real", warmEligible: true }],
  );
  assert.deepEqual(out.map((a) => a.name), ["real"]);
});

test("a malformed strategy or risk falls back rather than propagating", async () => {
  const { clampAdvice } = await import("../../src/services/vm-migration.js");
  const [a] = clampAdvice([{ name: "x", strategy: "WARM-ish", risk: "catastrophic" }], [{ name: "x", warmEligible: true }]);
  assert.equal(a.strategy, "cold", "anything that is not exactly \"warm\" is cold");
  assert.equal(a.risk, "medium");
});

test("heuristic advice works with no LLM and never recommends an impossible warm", async () => {
  const { heuristicAdvice } = await import("../../src/services/vm-migration.js");
  const out = heuristicAdvice([
    { name: "big", warmEligible: true, diskGiB: 400 },
    { name: "small", warmEligible: true, diskGiB: 40 },
    { name: "nocbt", warmEligible: false, diskGiB: 900, warmBlockedReason: "No CBT." },
  ]);
  assert.equal(out.find((a) => a.name === "big").strategy, "warm");
  assert.equal(out.find((a) => a.name === "small").strategy, "cold");
  const nocbt = out.find((a) => a.name === "nocbt");
  assert.equal(nocbt.strategy, "cold");
  assert.equal(nocbt.risk, "high", "a 900 GiB cold copy is a long outage");
  for (const a of out) assert.ok(a.reason && a.reason.length > 10, "every recommendation carries a reason");
});

test("advice with no LLM configured is rule-based, and covers every VM", async () => {
  const { adviseMigration } = await import("../../src/services/vm-migration.js");
  const vms = [{ name: "a", warmEligible: true, diskGiB: 300 }, { name: "b", warmEligible: false, diskGiB: 20, warmBlockedReason: "No CBT." }];
  const r = await adviseMigration(vms);
  assert.ok(["heuristic", "ai"].includes(r.source));
  assert.equal(r.advice.length, 2, "no VM is left without a recommendation");
});

// ── supportability: MTV's own validation is the primary source ──────────────
test("a Critical concern from MTV blocks the VM; a Warning only cautions", async () => {
  const { assessSupportability } = await import("../../src/services/vm-migration.js");
  const blocked = assessSupportability({
    name: "rdm-01", diskGiB: 100, poweredOn: true,
    concerns: [{ category: "critical", label: "Independent disk detected", assessment: "Cannot be snapshotted." }],
  });
  assert.equal(blocked.supported, false);
  assert.equal(blocked.verdict, "blocked");
  assert.match(blocked.blockers[0].message, /Independent disk/);

  const caution = assessSupportability({
    name: "w-01", diskGiB: 100, poweredOn: true,
    concerns: [{ category: "warning", label: "Snapshot present" }],
  });
  assert.equal(caution.supported, true, "a warning must not block");
  assert.equal(caution.verdict, "caution");
});

test("a clean VM is supported, and target capacity is our own check", async () => {
  const { assessSupportability } = await import("../../src/services/vm-migration.js");
  assert.equal(assessSupportability({ name: "ok", diskGiB: 50, poweredOn: true }).verdict, "supported");

  const tooBig = assessSupportability({ name: "big", diskGiB: 900, poweredOn: true }, { targetFreeGiB: 400 });
  assert.equal(tooBig.supported, false);
  assert.match(tooBig.blockers[0].message, /900 GiB but only 400 GiB/);
  assert.equal(tooBig.blockers[0].source, "target", "MTV does not check the target — we do");
});

test("a Windows guest is noted, not blocked", async () => {
  const { assessSupportability } = await import("../../src/services/vm-migration.js");
  const r = assessSupportability({ name: "win", guestOS: "Microsoft Windows Server 2019", diskGiB: 80, poweredOn: true });
  assert.equal(r.supported, true);
  assert.match(JSON.stringify(r.notes), /virtio/i);
});

// ── estimation: measured, not quoted ────────────────────────────────────────
test("throughput is learned from completed migrations, median not mean", async () => {
  const { observedThroughput } = await import("../../src/services/vm-migration.js");
  assert.equal(observedThroughput([]).mbps, null, "no history means no measurement");

  // 100 GiB in 1000s ≈ 102 MiB/s, twice, plus one stalled outlier.
  const t = observedThroughput([
    { diskGiB: 100, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:16:40Z" },
    { diskGiB: 100, startedAt: "2026-01-02T00:00:00Z", completedAt: "2026-01-02T00:16:40Z" },
    { diskGiB: 100, startedAt: "2026-01-03T00:00:00Z", completedAt: "2026-01-03T05:00:00Z" },
  ]);
  assert.equal(t.samples, 3);
  assert.ok(t.mbps > 90 && t.mbps < 115, `median should ignore the stall, got ${t.mbps}`);
  assert.match(t.basis, /Measured from 3/);
});

test("cold transfer time IS downtime; warm downtime is only the cutover", async () => {
  const { estimateMigration } = await import("../../src/services/vm-migration.js");
  const vms = [{ name: "a", diskGiB: 500 }, { name: "b", diskGiB: 500 }];
  const cold = estimateMigration(vms, { strategy: "cold", throughputMBps: 100 });
  const warm = estimateMigration(vms, { strategy: "warm", throughputMBps: 100 });

  assert.equal(cold.downtimeMinutes.likely, cold.wallClockMinutes.likely, "cold: the whole copy is an outage");
  assert.ok(warm.downtimeMinutes.likely < warm.wallClockMinutes.likely / 4, "warm: downtime is a fraction of the transfer");
  assert.equal(cold.totalGiB, 1000);
  // A range, because a single number would be a lie.
  assert.ok(cold.wallClockMinutes.low < cold.wallClockMinutes.likely);
  assert.ok(cold.wallClockMinutes.high > cold.wallClockMinutes.likely);
});

test("more VMs in flight helps, but not linearly — storage is the bottleneck", async () => {
  const { estimateMigration } = await import("../../src/services/vm-migration.js");
  const vms = Array.from({ length: 8 }, (_, i) => ({ name: `v${i}`, diskGiB: 100 }));
  const one = estimateMigration(vms, { throughputMBps: 100, concurrency: 1 });
  const four = estimateMigration(vms, { throughputMBps: 100, concurrency: 4 });
  assert.ok(four.wallClockMinutes.likely < one.wallClockMinutes.likely, "concurrency must help");
  assert.ok(four.wallClockMinutes.likely > one.wallClockMinutes.likely / 4, "but never linearly");
});
