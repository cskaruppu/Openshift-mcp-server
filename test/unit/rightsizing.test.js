import { test } from "node:test";
import assert from "node:assert/strict";
import {
  percentile, coverageOf, rightSize, fleetRightSizing, MIN_SAMPLES, MIN_WINDOW_DAYS,
} from "../../src/services/rightsizing.js";

const vm = (name, over = {}) => ({ name, cpuCount: 16, memoryGiB: 64, ...over });
/** A flat sample set of n points, so the p95 is predictable. */
const flat = (cpu, mem, n = MIN_SAMPLES, windowDays = 30) => ({
  cpu: Array(n).fill(cpu), memory: Array(n).fill(mem), windowDays,
});

test("a percentile is nearest-rank and survives an empty set", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([3, 1, 2], 0.5), 2, "unsorted input is sorted first");
});

test("thin data is refused with the reason, not averaged into a recommendation", () => {
  assert.match(coverageOf({}).reason, /No utilisation history/);
  assert.match(coverageOf({ cpu: [1], memory: [1], windowDays: 30 }).reason, new RegExp(`below the ${MIN_SAMPLES}`));
  assert.match(coverageOf(flat(2, 8, MIN_SAMPLES, 2)).reason, new RegExp(`is not a peak over ${MIN_WINDOW_DAYS}`));
  assert.equal(coverageOf(flat(2, 8)).ok, true);
});

test("a machine with no history gets no number, and says so", () => {
  const r = rightSize(vm("web01"), null);
  assert.equal(r.verdict, "unmeasured");
  assert.equal(r.recommended, null);
  assert.match(r.reason, /No utilisation history/);
});

test("an oversized machine is sized from its p95, with headroom, to a sane vCPU step", () => {
  const r = rightSize(vm("web01"), flat(2.8, 11));
  assert.equal(r.verdict, "oversized");
  // 2.8 × 1.25 = 3.5 → 4 vCPU; 11 × 1.25 = 13.75 → 14 GiB.
  assert.deepEqual(r.recommended, { cpuCount: 4, memoryGiB: 14 });
  assert.equal(r.p95.cpuCores, 2.8);
  assert.ok(r.evidence.some((e) => /p95 CPU 2.8 of 16 vCPU over 30 days/.test(e)));
  assert.match(r.reason, /Uses 2.8 vCPU and 11 GiB at p95, against 16 and 64/);
});

test("an all-but-idle machine is sized to the floor, never to zero", () => {
  const idle = rightSize(vm("idle"), flat(0.01, 0.01));
  assert.equal(idle.verdict, "oversized");
  assert.deepEqual(idle.recommended, { cpuCount: 1, memoryGiB: 1 }, "a floor, not zero");
  // And a machine already at the floor has nothing material left to give.
  const already = rightSize({ name: "small", cpuCount: 2, memoryGiB: 2 }, flat(0.01, 0.01));
  assert.equal(already.verdict, "correct");
  assert.equal(already.recommended, null);
});

test("a machine running close to its limit is a finding, not a saving", () => {
  const r = rightSize(vm("db01"), flat(15, 60));
  assert.equal(r.verdict, "undersized");
  assert.ok(r.recommended.cpuCount >= 16, "it is never quietly shrunk");
  assert.match(r.reason, /evictable under node pressure/);
});

test("a machine somebody deliberately pinned is not resized on a graph", () => {
  for (const over of [
    { latencySensitivity: "high" },
    { cpuAffinity: [0, 1] },
    { numaNodeAffinity: [0] },
    { memoryReservationLockedToMax: true },
    { memoryReservation: 65536 },
  ]) {
    const r = rightSize(vm("rt01", over), flat(1, 4));
    assert.equal(r.verdict, "pinned", JSON.stringify(over));
    assert.equal(r.recommended, null, "pinned machines carry no recommendation");
    assert.ok(r.wouldBe, "but the saving is still visible, so the trade-off can be discussed");
    assert.match(r.reason, /Somebody chose that on purpose/);
  }
});

test("a machine already the right size is told so rather than nudged", () => {
  const r = rightSize({ name: "ok", cpuCount: 4, memoryGiB: 16 }, flat(3, 12));
  assert.equal(r.verdict, "correct");
  assert.equal(r.recommended, null);
});

test("an inventory that never reported CPU or memory produces no verdict", () => {
  const r = rightSize({ name: "mystery", cpuCount: null, memoryGiB: null }, flat(1, 1));
  assert.equal(r.verdict, "unmeasured");
  assert.match(r.reason, /did not report/);
});

test("a fleet saving is claimed only over the machines that were actually measured", () => {
  const vms = [vm("a"), vm("b"), vm("no-data"), vm("pinned", { latencySensitivity: "high" })];
  const out = fleetRightSizing(vms, { a: flat(2.8, 11), b: flat(2.8, 11), pinned: flat(1, 4) });

  assert.equal(out.counts.total, 4);
  assert.equal(out.counts.measured, 3);
  assert.equal(out.counts.unmeasured, 1);
  assert.equal(out.counts.oversized, 2);
  assert.equal(out.counts.pinned, 1);

  // 2 × 16 vCPU → 2 × 4. The pinned and unmeasured machines contribute nothing.
  assert.equal(out.saving.vcpuBefore, 32);
  assert.equal(out.saving.vcpuAfter, 8);
  assert.equal(out.saving.pctVcpu, 75);
  assert.match(out.caveat, /Unmeasured is not the same as zero/);
});

test("a fleet with no history anywhere recommends nothing and says what would fix it", () => {
  const out = fleetRightSizing([vm("a"), vm("b")], {});
  assert.equal(out.saving, null);
  assert.equal(out.coverage.pct, 0);
  assert.match(out.headline, /No utilisation history was found/);
  assert.match(out.headline, /migrate at the configured sizes/);
});

test("a change too small to be worth a reboot is not offered as a recommendation", () => {
  // 4 vCPU / 16 GiB running at p95 3 cores / 12 GiB sizes to 4 vCPU / 15 GiB.
  // One gibibyte is not a recommendation, it is noise with a number on it.
  const r = rightSize({ name: "ok", cpuCount: 4, memoryGiB: 16 }, flat(3, 12));
  assert.equal(r.verdict, "correct");
  assert.equal(r.recommended, null);
  assert.match(r.reason, /too small a change to be worth a reboot/);
});
