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

// ── live ETA: measured during the transfer, not guessed before it ───────────
const GiB = 1073741824;
const series = (points) => points.map(([minutes, gib, totalGiB]) => ({
  at: Date.parse("2026-01-01T00:00:00Z") + minutes * 60000,
  bytes: gib * GiB, total: totalGiB * GiB,
}));

test("no ETA is offered from a single reading — there is nothing to measure yet", async () => {
  const { liveEta } = await import("../../src/services/vm-migration.js");
  const r = liveEta(series([[0, 0, 100]]));
  assert.equal(r.state, "measuring");
  assert.equal(r.etaMinutes, null, "an ETA from one sample would be invented");
});

test("a steady transfer yields an ETA close to the arithmetic truth", async () => {
  const { liveEta } = await import("../../src/services/vm-migration.js");
  // 10 GiB per minute, 100 GiB total: at 30 GiB done, 70 remain → ~7 minutes.
  const r = liveEta(series([[0, 0, 100], [1, 10, 100], [2, 20, 100], [3, 30, 100]]));
  assert.equal(r.state, "transferring");
  assert.equal(r.percent, 30);
  assert.ok(Math.abs(r.etaMinutes.likely - 7) <= 1, `expected ~7 minutes, got ${r.etaMinutes.likely}`);
  assert.ok(r.mbps > 150 && r.mbps < 180, `10 GiB/min ≈ 170 MiB/s, got ${r.mbps}`);
});

test("a transfer that SLOWS reports a longer ETA — the window is rolling, not cumulative", async () => {
  const { liveEta } = await import("../../src/services/vm-migration.js");
  // Fast for 3 minutes, then a tenth of the speed for the next 3.
  const fast = series([[0, 0, 200], [1, 20, 200], [2, 40, 200], [3, 60, 200]]);
  const thenSlow = [...fast, ...series([[4, 62, 200], [5, 64, 200], [6, 66, 200]])];
  const a = liveEta(fast, { windowSize: 3 });
  const b = liveEta(thenSlow, { windowSize: 3 });
  assert.ok(b.etaMinutes.likely > a.etaMinutes.likely * 3,
    `a slowdown must lengthen the ETA (was ${a.etaMinutes.likely}, now ${b.etaMinutes.likely})`);
  assert.ok(b.mbps < a.mbps, "and the reported rate must drop");
});

test("a stall is reported as stalled, never as an ever-growing ETA", async () => {
  const { liveEta } = await import("../../src/services/vm-migration.js");
  const r = liveEta(series([[0, 40, 100], [2, 40, 100], [4, 40, 100], [6, 40, 100]]));
  assert.equal(r.state, "stalled");
  assert.equal(r.mbps, 0);
  assert.equal(r.etaMinutes, null, "an ETA for a stalled transfer is a lie");
  assert.match(r.basis, /No data has moved/);
  assert.match(r.basis, /transfer pod/, "must say where to look");
});

test("confidence widens the range early and tightens it as the transfer runs", async () => {
  const { liveEta } = await import("../../src/services/vm-migration.js");
  const pts = (n) => series(Array.from({ length: n }, (_, i) => [i, i * 2, 500]));
  const early = liveEta(pts(3)), mid = liveEta(pts(10)), late = liveEta(pts(25));
  assert.equal(early.confidence, "low");
  assert.equal(mid.confidence, "medium");
  assert.equal(late.confidence, "high");
  const spread = (r) => r.etaMinutes.high - r.etaMinutes.low;
  assert.ok(spread(early) > spread(late), "an early estimate must not look precise");
  assert.match(early.basis, /sharpen/, "and must say it will improve");
});

test("a finished transfer reports complete rather than a residual ETA", async () => {
  const { liveEta } = await import("../../src/services/vm-migration.js");
  const r = liveEta(series([[0, 50, 100], [1, 100, 100]]));
  assert.equal(r.state, "complete");
  assert.equal(r.percent, 100);
  assert.equal(r.etaMinutes.likely, 0);
});

test("progressSnapshot sums bytes across every VM and step in the plan", async () => {
  const { progressSnapshot } = await import("../../src/services/vm-migration.js");
  const s = progressSnapshot({ vms: [
    { name: "a", phase: "CopyingDisks", steps: [{ progress: { completed: 10, total: 100 } }, { progress: { completed: 5, total: 50 } }] },
    { name: "b", phase: "Completed", steps: [{ progress: { completed: 40, total: 40 } }] },
  ] });
  assert.equal(s.bytes, 55);
  assert.equal(s.total, 190);
  assert.equal(s.activeVMs, 1, "a completed VM is not still active");
});

// ── Fleet analysis: the numbers behind the analysis page ────────────────────
// Every one of these is a claim shown to an operator deciding a migration wave,
// so each is asserted rather than eyeballed in the console.

test("classifyGuestOS reads family, distribution and version from a vCenter string", async () => {
  const { classifyGuestOS } = await import("../../src/services/vm-migration.js");
  const win = classifyGuestOS("Microsoft Windows Server 2019 (64-bit)");
  assert.equal(win.family, "windows");
  assert.equal(win.distro, "Windows Server 2019");
  assert.equal(win.level, "supported");

  const rhel = classifyGuestOS("Red Hat Enterprise Linux 9 (64-bit)");
  assert.equal(rhel.family, "linux");
  assert.equal(rhel.level, "supported");

  const centos = classifyGuestOS("CentOS 7 (64-bit)");
  assert.equal(centos.family, "linux");
  assert.equal(centos.level, "caveats", "a community rebuild is not a certified guest");

  const old = classifyGuestOS("Microsoft Windows Server 2008 R2 (64-bit)");
  assert.equal(old.level, "unsupported");
});

test("an unidentified guest is 'unknown', never optimistically 'supported'", async () => {
  const { classifyGuestOS } = await import("../../src/services/vm-migration.js");
  for (const v of ["", null, undefined, "   "]) {
    const os = classifyGuestOS(v);
    assert.equal(os.family, "unknown", `"${v}" must not be guessed`);
    assert.equal(os.level, "unknown");
  }
});

test("fleet level takes the WORSE of the guest matrix and MTV's own verdict", async () => {
  const { analyseFleet } = await import("../../src/services/vm-migration.js");
  const a = analyseFleet([
    // Certified guest, but MTV says it will fail — blocked wins.
    { name: "shared", guestOS: "Red Hat Enterprise Linux 9 (64-bit)", diskGiB: 10,
      concerns: [{ category: "Critical", label: "Shared disk detected" }] },
    // No concerns at all, but the guest is not certified — unsupported wins.
    { name: "legacy", guestOS: "Microsoft Windows Server 2003 (32-bit)", diskGiB: 10, concerns: [] },
    { name: "clean", guestOS: "Red Hat Enterprise Linux 9 (64-bit)", diskGiB: 10, concerns: [] },
  ]);
  const level = (n) => a.rows.find((r) => r.name === n).level;
  assert.equal(level("shared"), "unsupported", "a certified guest does not rescue a blocker");
  assert.equal(level("legacy"), "unsupported", "no concerns does not make an EOL guest supported");
  assert.equal(level("clean"), "supported");
  assert.equal(a.byLevel.unsupported, 2);
});

test("a mis-cased MTV concern category still blocks", async () => {
  const { assessSupportability } = await import("../../src/services/vm-migration.js");
  const r = assessSupportability({ name: "x", concerns: [{ category: "Critical", label: "Shared disk" }] });
  assert.equal(r.blockers.length, 1, "\"Critical\" must not be filed as a note");
  assert.equal(r.supported, false);
});

test("families and distributions roll up so the bar and its rows always agree", async () => {
  const { analyseFleet } = await import("../../src/services/vm-migration.js");
  const vm = (name, guestOS, diskGiB) => ({ name, guestOS, diskGiB, concerns: [] });
  const a = analyseFleet([
    vm("w1", "Microsoft Windows Server 2019 (64-bit)", 100),
    vm("w2", "Microsoft Windows Server 2019 (64-bit)", 200),
    vm("w3", "Microsoft Windows Server 2016 (64-bit)", 50),
    vm("l1", "Red Hat Enterprise Linux 9 (64-bit)", 400),
  ]);
  const win = a.families.find((f) => f.family === "windows");
  assert.equal(win.total, 3);
  assert.equal(win.diskGiB, 350);
  assert.equal(win.distros.reduce((n, d) => n + d.total, 0), win.total,
    "distribution rows must sum to the family bar");
  assert.equal(win.distros[0].distro, "Windows Server 2019", "biggest distribution first");
  assert.equal(a.totalDiskGiB, 750);
  assert.equal(a.families.reduce((n, f) => n + f.total, 0), a.total);
});

test("every suggestion names the VMs it applies to", async () => {
  const { analyseFleet, fleetRemediation } = await import("../../src/services/vm-migration.js");
  const a = analyseFleet([
    { name: "win-1", guestOS: "Microsoft Windows Server 2019 (64-bit)", diskGiB: 10, concerns: [] },
    { name: "eol-1", guestOS: "Microsoft Windows Server 2008 R2 (64-bit)", diskGiB: 10, concerns: [] },
    { name: "blocked-1", guestOS: "Red Hat Enterprise Linux 9 (64-bit)", diskGiB: 10,
      concerns: [{ category: "Critical", label: "Shared disk detected" }] },
  ]);
  const s = fleetRemediation(a);
  assert.ok(s.length >= 3);
  for (const x of s) {
    assert.ok(x.vms.length > 0, `"${x.title}" must say which VMs it means`);
    assert.ok(x.action, `"${x.title}" must say what to do`);
    assert.ok(["good", "warning", "serious", "critical"].includes(x.severity));
  }
  assert.equal(s[0].severity, "critical", "blockers are reported first");
});

test("a clean fleet gets a clean verdict, not an empty panel", async () => {
  const { analyseFleet, fleetRemediation } = await import("../../src/services/vm-migration.js");
  const s = fleetRemediation(analyseFleet([
    { name: "ok-1", guestOS: "Red Hat Enterprise Linux 9 (64-bit)", diskGiB: 20, concerns: [] },
  ]));
  assert.equal(s.length, 1);
  assert.equal(s[0].severity, "good");
  assert.match(s[0].title, /No blockers/);
});

test("analyseFleet handles an empty selection without throwing", async () => {
  const { analyseFleet } = await import("../../src/services/vm-migration.js");
  const a = analyseFleet([]);
  assert.equal(a.total, 0);
  assert.deepEqual(a.families, []);
  assert.equal(a.totalDiskGiB, 0);
});

// ── vSphere guestId decoding ────────────────────────────────────────────────
// MTV inventory often reports only the guestId, and a guestId is not a display
// name. Reading it as one silently turns an ordinary fleet into "needs review".

test("a vSphere guestId is decoded, not read as a version string", async () => {
  const { classifyGuestOS } = await import("../../src/services/vm-migration.js");
  const cases = [
    // "srvNext" means the release AFTER the one named — this is the trap.
    ["windows2019srvNext_64Guest", "Windows Server 2022", "supported"],
    ["windows2022srvNext_64Guest", "Windows Server 2025", "supported"],
    ["windows2019srv_64Guest", "Windows Server 2019", "supported"],
    ["windows9Server64Guest", "Windows Server 2016", "supported"],
    ["windows7Server64Guest", "Windows Server 2008/2003", "unsupported"],
    ["winNetStandard64Guest", "Windows Server 2008/2003", "unsupported"],
    ["windows9_64Guest", "Windows 10", "supported"],
    ["windows11_64Guest", "Windows 11", "supported"],
    ["rhel8_64Guest", "RHEL 8", "supported"],
    ["rhel9_64Guest", "RHEL 9", "supported"],
    ["centos7_64Guest", "CentOS 7/8", "caveats"],
    ["ubuntu64Guest", "Ubuntu", "caveats"],
    ["sles15_64Guest", "SUSE Linux Enterprise", "caveats"],
  ];
  for (const [id, distro, level] of cases) {
    const os = classifyGuestOS(id);
    assert.equal(os.distro, distro, `${id} should be ${distro}`);
    assert.equal(os.level, level, `${id} should be ${level}`);
    assert.equal(os.reported, id, "the raw string vCenter gave must be kept");
  }
});

test("guestId decoding does not fire on a real display name", async () => {
  const { expandGuestId, classifyGuestOS } = await import("../../src/services/vm-migration.js");
  assert.equal(expandGuestId("Microsoft Windows Server 2019 (64-bit)"), null);
  assert.equal(classifyGuestOS("Microsoft Windows Server 2019 (64-bit)").distro, "Windows Server 2019");
});

test("an unrecognised guestId is reported as unknown rather than guessed", async () => {
  const { classifyGuestOS } = await import("../../src/services/vm-migration.js");
  const os = classifyGuestOS("otherGuest");
  assert.equal(os.level, "unknown");
  assert.match(os.note, /not in the support matrix/);
});

// ── Power outcome ───────────────────────────────────────────────────────────
// What happens to the source machine is a consequence of the method, so it is
// computed. The model is never the authority on how much downtime there is.

test("the power outcome follows the method and the machine's current state", async () => {
  const { powerPlan } = await import("../../src/services/vm-migration.js");
  assert.equal(powerPlan({ poweredOn: true }, "warm").power, "stays-online");
  assert.equal(powerPlan({ poweredOn: true }, "cold").power, "power-off");
  // Already off wins over both — there is no downtime left to spend.
  assert.equal(powerPlan({ poweredOn: false }, "warm").power, "already-off");
  assert.equal(powerPlan({ poweredOn: false }, "cold").power, "already-off");
});

test("a model that claims a cold migration stays online is overruled", async () => {
  const { clampAdvice } = await import("../../src/services/vm-migration.js");
  const [a] = clampAdvice(
    [{ name: "vm1", strategy: "warm", power: "stays-online", reason: "keeps running", risk: "low" }],
    [{ name: "vm1", poweredOn: true, warmEligible: false, warmBlockedReason: "No CBT." }],
  );
  assert.equal(a.strategy, "cold", "warm is not possible for this VM");
  assert.equal(a.power, "power-off", "so it cannot stay online either");
  assert.equal(a.overridden, true);
});

test("an already-off VM is advised cold, since there is no uptime to protect", async () => {
  const { heuristicAdvice } = await import("../../src/services/vm-migration.js");
  const [a] = heuristicAdvice([{ name: "big", poweredOn: false, warmEligible: true, diskGiB: 900 }]);
  assert.equal(a.strategy, "cold");
  assert.equal(a.power, "already-off");
});

test("family resource totals split by support level and sum to the whole", async () => {
  const { analyseFleet } = await import("../../src/services/vm-migration.js");
  const a = analyseFleet([
    { name: "a", guestOS: "rhel9_64Guest", guestId: "rhel9_64Guest", cpuCount: 4, memoryGiB: 16, diskGiB: 100, concerns: [] },
    { name: "b", guestOS: "centos7_64Guest", guestId: "centos7_64Guest", cpuCount: 2, memoryGiB: 8, diskGiB: 50, concerns: [] },
  ]);
  const linux = a.families.find((f) => f.family === "linux");
  assert.equal(linux.levels.supported.cpu, 4);
  assert.equal(linux.levels.caveats.memoryGiB, 8);
  const sum = (m) => Object.values(linux.levels).reduce((n, b) => n + b[m], 0);
  assert.equal(sum("cpu"), linux.cpu, "level buckets must sum to the family total");
  assert.equal(sum("memoryGiB"), linux.memoryGiB);
  assert.equal(sum("diskGiB"), linux.diskGiB);
  assert.equal(a.totalCpu, 6);
});

// ── Per-VM remediation ──────────────────────────────────────────────────────
// A fleet finding tells a manager how big the problem is; this is what the
// engineer holding a ticket for one machine actually has to change.

test("an end-of-life guest is told what to upgrade TO, not just that it is old", async () => {
  const { analyseFleet } = await import("../../src/services/vm-migration.js");
  const [row] = analyseFleet([
    { name: "dc01", guestOS: "windows7Server64Guest", guestId: "windows7Server64Guest", poweredOn: true, diskGiB: 80, concerns: [] },
  ]).rows;
  const upgrade = row.actions.find((a) => /Upgrade required/.test(a.title));
  assert.ok(upgrade, "an unsupported guest must produce an upgrade action");
  assert.match(upgrade.action, /Windows Server 2022/, "naming the target is the whole point");
});

test("settings to enable are named per VM, in the order they bite", async () => {
  const { analyseFleet } = await import("../../src/services/vm-migration.js");
  const [row] = analyseFleet([
    { name: "win1", guestOS: "windows2019srv_64Guest", guestId: "windows2019srv_64Guest",
      poweredOn: true, diskGiB: 700, warmEligible: false, concerns: [] },
  ]).rows;
  const titles = row.actions.map((a) => a.title).join(" | ");
  assert.match(titles, /VirtIO drivers needed/);
  assert.match(titles, /Changed block tracking is off/);
  assert.match(titles, /700 GiB cold copy/);
  assert.ok(row.actions.find((a) => /VirtIO/.test(a.title)).required, "a non-bootable disk is not optional");
});

test("a clean VM says so instead of showing an empty action list", async () => {
  const { analyseFleet } = await import("../../src/services/vm-migration.js");
  const [row] = analyseFleet([
    { name: "ok", guestOS: "rhel9_64Guest", guestId: "rhel9_64Guest", poweredOn: true, diskGiB: 40, warmEligible: true, concerns: [] },
  ]).rows;
  assert.equal(row.actions.length, 1);
  assert.equal(row.actions[0].severity, "good");
});

test("a blocked VM leads with the blocker, before any advice about the guest", async () => {
  const { analyseFleet } = await import("../../src/services/vm-migration.js");
  const [row] = analyseFleet([
    { name: "shared", guestOS: "windows7Server64Guest", guestId: "windows7Server64Guest", poweredOn: true, diskGiB: 40,
      concerns: [{ category: "Critical", label: "Shared disk detected" }] },
  ]).rows;
  assert.equal(row.actions[0].severity, "critical");
  assert.equal(row.actions[0].required, true);
});

// ── The change-request gate ─────────────────────────────────────────────────
// Getting this mapping wrong either blocks an approved migration or, far worse,
// lets an unapproved one through.

test("approval verdicts map from ServiceNow's approval and state fields", async () => {
  const { readMigrationApproval } = await import("../../src/services/vm-migration.js");
  assert.equal(readMigrationApproval({ approval: "approved" }), "approved");
  assert.equal(readMigrationApproval({ approval: "rejected" }), "rejected");
  assert.equal(readMigrationApproval({ approval: "requested" }), "submitted");
  assert.equal(readMigrationApproval({ state: "-1" }), "approved", "Implement means the CAB signed off");
  assert.equal(readMigrationApproval({ state: "4" }), "cancelled");
  assert.equal(readMigrationApproval({}), "submitted", "silence is never approval");
  // A rejection must win over any state that would otherwise read as approved.
  assert.equal(readMigrationApproval({ approval: "rejected", state: "-1" }), "rejected");
});

test("the gate is read from the plan's own annotations", async () => {
  const { approvalGate } = await import("../../src/services/vm-migration.js");
  const plan = (ann) => ({ metadata: { annotations: ann } });

  const none = approvalGate(plan({}));
  assert.equal(none.approved, false);
  assert.match(none.next, /Raise a change request/);

  const pending = approvalGate(plan({
    "tcs.agentic-ai/change-request": "CHG0042",
    "tcs.agentic-ai/change-request-state": "submitted",
  }));
  assert.equal(pending.approved, false);
  assert.match(pending.next, /CHG0042 is awaiting approval/);

  const ok = approvalGate(plan({
    "tcs.agentic-ai/change-request": "CHG0042",
    "tcs.agentic-ai/change-request-state": "approved",
  }));
  assert.equal(ok.approved, true);
  assert.equal(ok.number, "CHG0042");

  // A plan that vanished must not read as approved.
  assert.equal(approvalGate(null).approved, false);
});

// ── Per-plan footprint ──────────────────────────────────────────────────────
// A wave that splits into two cold plans must not put the wave's combined
// transfer time on both change requests. A CAB approving an outage is entitled
// to the number for the work in front of it.

test("each group carries only its own VMs' storage", async () => {
  const { planGroups } = await import("../../src/services/vm-migration.js");
  const sel = (name, diskGiB, strategy, targetNamespace = "prod") => ({
    vm: { id: `id-${name}`, name, diskGiB, warmEligible: true },
    strategy, sourceProvider: "vsphere", storageMap: "sm", networkMap: "nm", targetNamespace,
  });
  const { groups } = planGroups([
    sel("a", 100, "cold"), sel("b", 250, "cold"),
    sel("c", 600, "cold", "staging"),   // different namespace → its own plan
    sel("d", 400, "warm"),
  ]);
  assert.equal(groups.length, 3);
  const gib = Object.fromEntries(groups.map((g) => [g.totalGiB, g.totalVMs]));
  assert.ok(gib[350], "the two prod cold VMs total 350 GiB, not the whole wave");
  assert.ok(gib[600], "the staging plan carries only its own 600 GiB");
  assert.ok(gib[400]);
  for (const g of groups) {
    assert.equal(g.totalGiB, g.vms.reduce((n, v) => n + v.diskGiB, 0));
  }
});

test("the plan manifest records its footprint without polluting spec.vms", async () => {
  const { planGroups, buildPlanManifest } = await import("../../src/services/vm-migration.js");
  const { groups } = planGroups([{
    vm: { id: "id-a", name: "a", diskGiB: 120 }, strategy: "cold",
    sourceProvider: "vsphere", storageMap: "sm", networkMap: "nm", targetNamespace: "prod",
  }]);
  const man = buildPlanManifest(groups[0], { targetProvider: "host" });
  assert.equal(man.metadata.annotations["tcs.agentic-ai/total-gib"], "120");
  assert.equal(man.metadata.annotations["tcs.agentic-ai/vm-count"], "1");
  // Forklift rejects unknown fields in spec.vms, so the size must not reach it.
  assert.deepEqual(man.spec.vms, [{ id: "id-a", name: "a" }]);
});

test("a plan estimates from its own annotation, and refuses to invent a size", async () => {
  const { estimatePlan } = await import("../../src/services/vm-migration.js");
  const plan = (gib, n, warm) => ({
    metadata: { annotations: { "tcs.agentic-ai/total-gib": String(gib), "tcs.agentic-ai/vm-count": String(n) } },
    spec: { warm },
  });
  const cold = await estimatePlan(plan(350, 2, false));
  assert.equal(cold.totalGiB, 350);
  assert.equal(cold.strategy, "cold");
  assert.deepEqual(cold.downtimeMinutes, cold.wallClockMinutes, "cold downtime IS the transfer");

  const warm = await estimatePlan(plan(600, 1, true));
  assert.equal(warm.strategy, "warm");
  assert.ok(warm.downtimeMinutes.likely < warm.wallClockMinutes.likely / 10,
    "warm downtime is the cutover, not the copy");

  // A bigger plan must estimate longer — the footprint has to actually be used.
  assert.ok((await estimatePlan(plan(2000, 2, false))).wallClockMinutes.likely > cold.wallClockMinutes.likely);

  // With no recorded footprint, say nothing rather than guess one.
  assert.equal(await estimatePlan({ metadata: {}, spec: {} }), null);
});

test("a target-capacity blocker is never reported as something to fix at source", async () => {
  const { analyseFleet, fleetRemediation } = await import("../../src/services/vm-migration.js");
  const { summariseNodes } = await import("../../src/services/target-capacity.js");
  const nodes = [{
    name: "w1", ready: true, cordoned: false, virtSchedulable: true,
    cpuMillis: 16000, memGiB: 32, cpuCommittedMillis: 0, memCommittedGiB: 0,
    freeCpuMillis: 16000, freeMemGiB: 32,
  }];
  const capacity = { available: true, nodes, ...summariseNodes(nodes) };
  const a = analyseFleet([
    { name: "too-big", guestOS: "rhel9_64Guest", guestId: "rhel9_64Guest", cpuCount: 8, memoryGiB: 96, diskGiB: 100, concerns: [] },
    { name: "shared", guestOS: "rhel9_64Guest", guestId: "rhel9_64Guest", cpuCount: 2, memoryGiB: 8, diskGiB: 10,
      concerns: [{ category: "Critical", label: "Shared disk detected" }] },
  ], { capacity });

  const s = fleetRemediation(a);
  const target = s.find((x) => /will not schedule/i.test(x.title));
  const source = s.find((x) => /cannot migrate as-is/i.test(x.title));

  assert.ok(target, "a VM too big for every node needs its own finding");
  assert.deepEqual(target.vms, ["too-big"]);
  assert.match(target.action, /Add a node large enough/);
  assert.doesNotMatch(target.action, /at source/, "the fix is on the target, not the source");

  assert.ok(source, "an MTV blocker is still reported separately");
  assert.deepEqual(source.vms, ["shared"]);
  assert.match(source.action, /at source/);
});

test("Windows and Linux never share a migration plan", async () => {
  const { planGroups } = await import("../../src/services/vm-migration.js");
  const vm = (name, family, diskGiB) => ({ id: `id-${name}`, name, diskGiB, warmEligible: true, os: { family, distro: family } });
  const sel = (v, strategy = "cold") => ({
    vm: v, strategy, sourceProvider: "vsphere", storageMap: "sm", networkMap: "nm", targetNamespace: "prod",
  });

  // Identical in every dimension MTV cares about — only the OS differs.
  const { groups } = planGroups([
    sel(vm("web01", "linux", 100)), sel(vm("web02", "linux", 100)),
    sel(vm("sql01", "windows", 500)),
  ]);
  assert.equal(groups.length, 2, "the same maps, namespace and strategy still split by OS");
  const linux = groups.find((g) => g.osFamily === "linux");
  const windows = groups.find((g) => g.osFamily === "windows");
  assert.deepEqual(linux.vms.map((v) => v.name), ["web01", "web02"]);
  assert.deepEqual(windows.vms.map((v) => v.name), ["sql01"]);
  assert.equal(linux.totalGiB, 200, "each plan totals only its own machines");
  assert.equal(windows.totalGiB, 500);

  // And the name says which is which, or a wave of four looks like a mistake.
  assert.match(linux.planName, /^mig-linux-cold-prod-/);
  assert.match(windows.planName, /^mig-windows-cold-prod-/);
});

test("OS grouping stacks with the dimensions MTV already forces", async () => {
  const { planGroups } = await import("../../src/services/vm-migration.js");
  const vm = (name, family) => ({ id: `id-${name}`, name, diskGiB: 10, warmEligible: true, os: { family, distro: family } });
  const sel = (v, strategy, targetNamespace = "prod") => ({
    vm: v, strategy, sourceProvider: "vsphere", storageMap: "sm", networkMap: "nm", targetNamespace,
  });
  const { groups } = planGroups([
    sel(vm("a", "linux"), "cold"), sel(vm("b", "linux"), "warm"),
    sel(vm("c", "windows"), "cold"), sel(vm("d", "windows"), "cold", "staging"),
  ]);
  assert.equal(groups.length, 4, "OS × strategy × namespace all separate");
  assert.equal(new Set(groups.map((g) => g.planName)).size, 4, "and every plan is uniquely named");
});

test("an unidentified guest gets its own plan without a misleading name", async () => {
  const { planGroups, buildPlanManifest } = await import("../../src/services/vm-migration.js");
  const { groups } = planGroups([{
    vm: { id: "id-x", name: "mystery", diskGiB: 50, os: { family: "unknown" } }, strategy: "cold",
    sourceProvider: "vsphere", storageMap: "sm", networkMap: "nm", targetNamespace: "prod",
  }]);
  assert.equal(groups[0].osFamily, "unknown");
  assert.doesNotMatch(groups[0].planName, /unknown/, "the name must not assert a family it does not know");
  const labels = buildPlanManifest(groups[0], { targetProvider: "h" }).metadata.labels;
  assert.equal(labels["tcs.agentic-ai/os-family"], "unknown", "but the label still records it honestly");
});
