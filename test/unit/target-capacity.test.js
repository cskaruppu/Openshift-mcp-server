import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCpuMillis, parseMemBytes, vmDemand, summariseNodes, nodeFit, capacityVerdict, DEFAULTS,
} from "../../src/services/target-capacity.js";

const node = (name, cpu, memGiB, cpuUsed = 0, memUsed = 0, over = {}) => ({
  name, ready: true, cordoned: false, virtSchedulable: true,
  cpuMillis: cpu, memGiB, cpuCommittedMillis: cpuUsed, memCommittedGiB: memUsed,
  freeCpuMillis: cpu - cpuUsed, freeMemGiB: memGiB - memUsed, ...over,
});
const cap = (nodes) => ({ available: true, nodes, ...summariseNodes(nodes) });

test("kubernetes quantities parse to millicores and bytes", () => {
  assert.equal(parseCpuMillis("2"), 2000);
  assert.equal(parseCpuMillis("1500m"), 1500);
  assert.equal(parseCpuMillis(""), 0);
  assert.equal(parseMemBytes("1Ki"), 1024);
  assert.equal(parseMemBytes("32Gi"), 32 * 1024 ** 3);
  assert.equal(parseMemBytes("1G"), 1e9, "G and Gi are not the same unit");
  assert.equal(parseMemBytes("nonsense"), 0);
});

test("a VM's request is not its spec — CPU is overcommitted, memory is not", () => {
  const d = vmDemand({ cpuCount: 4, memoryGiB: 16 });
  assert.equal(d.cpuMillis, 400, `4 vCPU at ${DEFAULTS.cpuAllocationRatio}:1 requests 400m`);
  assert.ok(d.memGiB > 16, "virt-launcher overhead is added to the guest's RAM");
  assert.ok(d.memGiB < 16.5, "and it is overhead, not a doubling");
});

test("only nodes that can actually run a VM count towards headroom", () => {
  const c = cap([
    node("w1", 16000, 32, 6000, 12),
    node("w2", 16000, 32, 0, 0, { ready: false }),
    node("w3", 16000, 32, 0, 0, { cordoned: true }),
    node("big", 64000, 256, 0, 0, { virtSchedulable: false }),
  ]);
  assert.equal(c.virtNodeCount, 1, "three of four cannot host a VM");
  assert.equal(c.totals.memGiB, 32, "the 256 GiB node must not inflate headroom");
  assert.equal(c.largestNode.name, "w1");
  assert.equal(c.excluded.length, 3);
  assert.match(c.excluded.find((e) => e.name === "big").reason, /kubevirt\.io\/schedulable/);
});

test("a VM bigger than every node can never schedule, however large the cluster", () => {
  const c = cap([node("a", 16000, 32), node("b", 16000, 32), node("c", 16000, 32), node("d", 16000, 32)]);
  const fit = nodeFit({ name: "big", cpuCount: 8, memoryGiB: 64 }, c);
  assert.equal(fit.fits, false);
  assert.equal(fit.permanent, true, "this is not a scheduling delay, it is impossible");
  assert.match(fit.reason, /must fit on one node/);
});

test("'no room today' is separated from 'will never fit'", () => {
  const c = cap([node("w1", 16000, 32, 0, 28)]);
  const fit = nodeFit({ name: "vm", cpuCount: 2, memoryGiB: 16 }, c);
  assert.equal(fit.fits, false);
  assert.equal(fit.permanent, false, "the hardware is big enough; the space is not free");
  assert.match(fit.reason, /Scale the cluster or free capacity/);
});

test("the wave verdict is driven by memory, and always states its assumptions", () => {
  const c = cap([node("w1", 32000, 64, 0, 0), node("w2", 32000, 64, 0, 0)]);
  const vms = (n, memGiB) => Array.from({ length: n }, (_, i) => ({ name: `vm${i}`, cpuCount: 2, memoryGiB: memGiB, diskGiB: 100 }));

  // 128 GiB unreserved. 4 VMs = 33 GiB (26%); 14 = 115.5 GiB (90%); 20 = 165 GiB.
  assert.equal(capacityVerdict(vms(4, 8), c).verdict, "fits");
  assert.equal(capacityVerdict(vms(14, 8), c).verdict, "tight", "past 80% is tight, not comfortable");
  assert.equal(capacityVerdict(vms(20, 8), c).verdict, "exceeds");
  assert.equal(capacityVerdict([...vms(2, 8), { name: "huge", cpuCount: 4, memoryGiB: 200 }], c).verdict, "blocked");

  const v = capacityVerdict(vms(4, 8), c);
  assert.ok(v.notes.some((n) => /overcommitted 10:1/.test(n)), "the overcommit assumption must be stated");
  assert.equal(v.demand.diskGiB, 400);
});

test("an unreadable or VM-incapable cluster says so instead of guessing", () => {
  const vms = [{ name: "a", cpuCount: 2, memoryGiB: 8 }];
  assert.equal(capacityVerdict(vms, { available: false }).verdict, "unknown");
  assert.equal(capacityVerdict(vms, cap([node("w", 8000, 16, 0, 0, { virtSchedulable: false })])).verdict, "unknown");
  assert.equal(capacityVerdict(vms, null).verdict, "unknown");
});

test("partial pod reads are reported, because headroom is then a lower bound", () => {
  const c = { ...cap([node("w1", 16000, 32, 1000, 4)]), partial: true };
  const v = capacityVerdict([{ name: "a", cpuCount: 2, memoryGiB: 8 }], c);
  assert.ok(v.notes.some((n) => /lower bound/.test(n)));
});
