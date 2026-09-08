import test from "node:test";
import assert from "node:assert/strict";
import { verifyVM, rollUp, verifySummary, migrationJourney } from "../../src/services/migration-verify.js";

const promised = { name: "app-01", cpu: 4, memGiB: 16, disks: 2, diskGiB: 120, ips: ["10.4.2.11"] };
const running = { name: "app-01", phase: "running", node: "worker-2", ips: ["10.4.2.11"] };
const target = { cpu: 4, memGiB: 16, disks: 2 };
const find = (r, id) => r.checks.find((c) => c.id === id);

test("a clean migration passes every check", () => {
  const r = verifyVM(promised, running, target, true);
  assert.equal(r.verdict, "passed");
  assert.equal(r.counts.fail, 0);
  assert.equal(r.counts.unchecked, 0);
  assert.equal(find(r, "source-off").state, "pass");
  assert.equal(find(r, "address").state, "pass");
});

test("the source still running is the failure that matters, and it is never inferred", () => {
  // Both machines up: same identity, same address, two sets of storage.
  const both = verifyVM(promised, running, target, false);
  assert.equal(both.verdict, "failed");
  const c = find(both, "source-off");
  assert.equal(c.state, "fail");
  assert.match(c.detail, /still powered ON/);
  assert.match(c.action, /Power the source off/);

  // The rule that makes this worth believing: an unreachable source platform
  // is reported as unchecked, NEVER as "powered off". Silence must not read as
  // a clean bill of health.
  const unknown = verifyVM(promised, running, target, null);
  assert.equal(find(unknown, "source-off").state, "unchecked");
  assert.equal(unknown.verdict, "incomplete", "an unrun check cannot produce a pass");
  assert.equal(unknown.coverage.ran, unknown.coverage.total - 1);

  // And the summary says so in words, rather than quietly rounding up.
  const s = verifySummary([unknown]);
  assert.match(s.headline, /could not run/);
  assert.notEqual(s.verdict, "passed");
});

test("a VM that did not boot fails; a VM with no address is a warning, not a pass", () => {
  const dead = verifyVM(promised, { name: "app-01", phase: "failed", status: "CrashLoopBackOff" }, target, true);
  assert.equal(find(dead, "running").state, "fail");
  assert.equal(dead.verdict, "failed");

  const missing = verifyVM(promised, null, null, true);
  assert.equal(find(missing, "running").state, "fail");
  assert.match(find(missing, "running").detail, /No VirtualMachine/);

  // Booted, but nothing is reporting an address — usually a missing guest
  // agent, which is also why nothing else about the guest can be confirmed.
  const noIp = verifyVM(promised, { ...running, ips: [] }, target, true);
  assert.equal(find(noIp, "address").state, "warn");
  assert.match(find(noIp, "address").action, /qemu-guest-agent/);
  assert.equal(noIp.verdict, "passed-with-warnings");
});

test("a changed address is a warning with the consequence spelled out", () => {
  const moved = verifyVM(promised, { ...running, ips: ["10.9.9.9"] }, target, true);
  const c = find(moved, "address");
  assert.equal(c.state, "warn");
  assert.match(c.detail, /10\.9\.9\.9.*10\.4\.2\.11/);
  assert.match(c.action, /DNS|firewall/);
});

test("a missing disk fails — a missing filesystem inside the guest is not cosmetic", () => {
  const lost = verifyVM(promised, running, { ...target, disks: 1 }, true);
  const c = find(lost, "disks");
  assert.equal(c.state, "fail");
  assert.match(c.action, /storage map/);

  // Nothing recorded to compare against is unchecked, not a pass.
  assert.equal(find(verifyVM({ name: "x" }, running, target, true), "disks").state, "unchecked");
});

test("the fleet headline leads with split brain when there is one", () => {
  const ok = verifyVM(promised, running, target, true);
  const bad = verifyVM({ ...promised, name: "db-01" }, { ...running, name: "db-01" }, target, false);
  const s = verifySummary([ok, bad]);
  assert.equal(s.verdict, "failed");
  assert.deepEqual(s.splitBrain, ["db-01"]);
  assert.match(s.headline, /running on BOTH platforms/);

  const clean = verifySummary([ok]);
  assert.equal(clean.verdict, "passed");
  assert.match(clean.headline, /source VMs are powered off and still exist/);
});

test("rollUp never lets an unrun check produce a pass", () => {
  assert.equal(rollUp([{ state: "pass" }, { state: "pass" }]).verdict, "passed");
  assert.equal(rollUp([{ state: "pass" }, { state: "warn" }]).verdict, "passed-with-warnings");
  assert.equal(rollUp([{ state: "pass" }, { state: "unchecked" }]).verdict, "incomplete");
  // A failure outranks everything, including an incomplete run.
  assert.equal(rollUp([{ state: "unchecked" }, { state: "fail" }]).verdict, "failed");
});

test("warm and cold are different journeys, not one journey with a flag", () => {
  const gate = { required: true, approved: true, number: "CHG1", state: "approved" };

  const cold = migrationJourney({ found: true, warm: false, gate, executing: true });
  const warm = migrationJourney({ found: true, warm: true, gate, executing: true });

  // Only a warm plan has a cutover step; only a cold one powers off up front.
  assert.ok(!cold.steps.some((s) => s.key === "cutover"), "a cold plan never has a cutover to wait for");
  assert.ok(warm.steps.some((s) => s.key === "cutover"));
  assert.match(cold.steps.find((s) => s.key === "transfer").detail, /powered off first/);
  assert.match(warm.steps.find((s) => s.key === "precopy").detail, /keeps serving users/);

  // Position comes off the plan, so a browser refresh cannot advance it.
  assert.equal(migrationJourney({ found: true, warm: true, gate: { required: true, approved: false } }).at, 1);
  assert.equal(migrationJourney({ found: true, warm: true, gate }).at, 2);

  // Paused at the cutover: the whole point is that it is waiting on a person.
  const waiting = migrationJourney({ found: true, warm: true, gate, executing: true, cutover: { awaitingCutover: true } });
  assert.equal(waiting.steps[waiting.at].key, "cutover");
  assert.match(waiting.next, /Schedule the cutover/);

  // Verification advances the pipeline to its last step, but does not finish
  // it — see the decommission test below for why that step exists.
  const done = migrationJourney({ found: true, warm: true, gate, succeeded: true, verification: { verdict: "passed" } });
  assert.equal(done.at, done.steps.length - 1);

  const broke = migrationJourney({ found: true, warm: false, gate, failed: true });
  assert.match(broke.next, /roll back/);
});

test("decommission is refused until the migration is verified, and the soak is counted out", async () => {
  const { decommissionReadiness } = await import("../../src/services/vm-migration.js");
  const done = { succeeded: true };
  const ok = { verdict: "passed", counts: { unchecked: 0 }, headline: "fine" };
  const day = 86400000;
  const now = Date.parse("2026-09-20T00:00:00Z");
  const since = "2026-09-01T00:00:00Z";                 // 19 days ago

  // Nothing has been replaced yet.
  const early = decommissionReadiness({ status: { succeeded: false }, verification: ok, since, now });
  assert.equal(early.ready, false);
  assert.equal(early.blockers[0].code, "not-migrated");

  // Migrated but never verified.
  assert.equal(decommissionReadiness({ status: done, since, now }).blockers[0].code, "not-verified");

  // The one that matters: an INCOMPLETE verification blocks deletion. The
  // check that usually could not run is "is the source powered off", and
  // deleting on the strength of that is how the wrong machine goes.
  const partial = decommissionReadiness({
    status: done, since, now, verification: { verdict: "incomplete", counts: { unchecked: 1 } },
  });
  assert.equal(partial.ready, false);
  assert.equal(partial.blockers[0].code, "verification-incomplete");

  // Both platforms running is its own blocker, named.
  const split = decommissionReadiness({
    status: done, since, now,
    verification: { verdict: "failed", counts: {}, headline: "x", splitBrain: ["db-01"] },
  });
  assert.ok(split.blockers.some((b) => b.code === "split-brain"));

  // Verified, but not soaked: not ready, and it says how long is left rather
  // than only refusing.
  const soaking = decommissionReadiness({ status: done, verification: ok, since: new Date(now - 2 * day).toISOString(), now, days: 7 });
  assert.equal(soaking.ready, false);
  assert.equal(soaking.blockers.length, 0, "soaking is not a blocker — it is a wait");
  assert.equal(soaking.soak.remainingDays, 5);
  assert.match(soaking.soak.note, /this is the way back/);

  // Verified and soaked.
  const go = decommissionReadiness({ status: done, verification: ok, since, now, days: 7 });
  assert.equal(go.ready, true);
  assert.match(go.next, /last step/);

  // No soak configured is a deliberate setting, not a missing one.
  assert.equal(decommissionReadiness({ status: done, verification: ok, since: null, now, days: 0 }).ready, true);
  // An unknown completion time cannot satisfy a soak that is required.
  assert.equal(decommissionReadiness({ status: done, verification: ok, since: null, now, days: 7 }).ready, false);
});

test("the journey ends at the decommission, not at the migration", async () => {
  const { migrationJourney } = await import("../../src/services/migration-verify.js");
  const gate = { required: true, approved: true, number: "CHG1", state: "approved" };
  const base = { found: true, warm: true, gate, succeeded: true, verification: { verdict: "passed" } };

  const verified = migrationJourney(base);
  assert.equal(verified.steps[verified.at].key, "decommission", "verified lands ON the decommission step");
  assert.match(verified.next, /Raise the decommission request/);

  // Only a carried-out decommission finishes it: a migration stays reversible
  // while the source VMs exist, and the stepper should not declare victory.
  const retired = migrationJourney({ ...base, decommission: { state: "approved" } });
  assert.equal(retired.at, retired.steps.length);
  assert.match(retired.next, /source VMs have been retired/);

  // Both routes end the same way.
  assert.equal(migrationJourney({ ...base, warm: false }).steps.at(-1).key, "decommission");
});
