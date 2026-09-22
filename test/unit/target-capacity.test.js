import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCpuMillis, parseMemBytes, vmDemand, summariseNodes, nodeFit, capacityVerdict,
  packWave, nodeLossRehearsal, DEFAULTS,
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

// ── Placement ──────────────────────────────────────────────────────────────

test("the wave is packed as a set, so a machine is never measured against a node another machine already took", () => {
  // Two 64 GiB nodes, 128 GiB in total. Three 40 GiB machines need 121 GiB —
  // which the totals say fits. Only two of them can actually be placed.
  const c = cap([node("w1", 32000, 64), node("w2", 32000, 64)]);
  const vms = ["a", "b", "d"].map((name) => ({ name, cpuCount: 4, memoryGiB: 40, diskGiB: 10 }));

  const p = packWave(vms, c);
  assert.equal(p.placedCount, 2);
  assert.equal(p.unplacedCount, 1);
  assert.equal(p.fits, false);
  assert.equal(p.unplaced[0].blockedBy, "wave", "a node had room before the wave started");
  assert.match(p.unplaced[0].reason, /The wave blocks this machine, not the cluster/);
  assert.equal(p.unplaced[0].ahead, 2, "two machines went ahead of it");
});

test("total headroom that cannot be reached is reported as fragmented, not as a pass", () => {
  const c = cap([node("w1", 32000, 64), node("w2", 32000, 64)]);
  const vms = ["a", "b", "d"].map((name) => ({ name, cpuCount: 4, memoryGiB: 40, diskGiB: 10 }));
  const v = capacityVerdict(vms, c);
  // 121 GiB of 128 is 95% — under the old arithmetic this was merely "tight".
  assert.equal(v.verdict, "fragmented");
  assert.match(v.headline, /pieces too small/);
  assert.equal(v.placement.unplacedCount, 1);
});

test("placement names the node and what is left on it", () => {
  const c = cap([node("w1", 32000, 64)]);
  const p = packWave([{ name: "vm", cpuCount: 4, memoryGiB: 16 }], c);
  const [first] = p.placed;
  assert.equal(first.node, "w1");
  assert.ok(first.spareMemGiB > 47 && first.spareMemGiB < 48, "64 GiB less 16 GiB and overhead");
  assert.equal(first.tight, false);
  assert.equal(p.nodes[0].vmCount, 1);
  assert.equal(p.nodes[0].pctMem, 25);
});

test("the three reasons a machine does not land are kept apart, because the fixes differ", () => {
  const tooBig = packWave([{ name: "huge", cpuCount: 2, memoryGiB: 200 }], cap([node("w1", 32000, 64)]));
  assert.equal(tooBig.unplaced[0].blockedBy, "hardware");
  assert.equal(tooBig.unplaced[0].permanent, true);

  const full = packWave([{ name: "vm", cpuCount: 2, memoryGiB: 32 }], cap([node("w1", 32000, 64, 0, 60)]));
  assert.equal(full.unplaced[0].blockedBy, "cluster", "no node had room even before the wave");
  assert.equal(full.unplaced[0].permanent, false);
  assert.match(full.unplaced[0].reason, /Scale the cluster or free capacity/);
});

test("packing is deterministic, so the same wave on the same cluster always plans the same", () => {
  const c = cap([node("w1", 32000, 64), node("w2", 32000, 64)]);
  const vms = Array.from({ length: 9 }, (_, i) => ({ name: `vm${i}`, cpuCount: 2, memoryGiB: 8 + (i % 3) * 4 }));
  const a = packWave(vms, c), b = packWave(vms, c);
  assert.deepEqual(a.placed.map((p) => [p.name, p.node]), b.placed.map((p) => [p.name, p.node]));
  assert.ok(a.heuristic.includes("first-fit-decreasing"), "the rule is stated, not implied");
});

test("an unreadable or VM-incapable cluster is not silently packed", () => {
  assert.equal(packWave([{ name: "a", cpuCount: 1, memoryGiB: 1 }], null).available, false);
  assert.equal(packWave([{ name: "a", cpuCount: 1, memoryGiB: 1 }], { available: false }).available, false);
  const noVirt = cap([node("w", 8000, 16, 0, 0, { virtSchedulable: false })]);
  assert.equal(packWave([{ name: "a", cpuCount: 1, memoryGiB: 1 }], noVirt).available, false);
});

// ── Node loss ──────────────────────────────────────────────────────────────

test("losing a node mid-wave is rehearsed, and stranded machines are counted from the re-pack", () => {
  const c = cap([node("w1", 32000, 64), node("w2", 32000, 64)]);
  const vms = ["a", "b", "d"].map((name) => ({ name, cpuCount: 4, memoryGiB: 30, diskGiB: 10 }));
  const r = nodeLossRehearsal(vms, c);
  assert.equal(r.available, true);
  assert.equal(r.nodes.length, 2);
  // Both nodes carry machines that have nowhere else to go once one is gone.
  for (const row of r.nodes) assert.ok(row.stranded > 0, `${row.node} strands machines`);
  assert.ok(r.worst, "the worst case is named");
  assert.match(r.headline, /do not drain it while this wave runs/);
});

test("a wave with room to spare absorbs any single node loss, and says so", () => {
  const c = cap([node("w1", 32000, 64), node("w2", 32000, 64), node("w3", 32000, 64)]);
  const r = nodeLossRehearsal([{ name: "a", cpuCount: 2, memoryGiB: 8 }], c);
  assert.equal(r.worst, null);
  assert.match(r.headline, /still has somewhere to go/);
  assert.ok(r.nodes.every((n) => n.absorbs));
});

test("one node is not a failure domain, and pretending otherwise would be the lie", () => {
  const r = nodeLossRehearsal([{ name: "a", cpuCount: 2, memoryGiB: 8 }], cap([node("w1", 32000, 64)]));
  assert.equal(r.singleNode, true);
  assert.match(r.note, /nothing to fail over to/);
});

test("wave order changes how many machines land, and the panel is told so", () => {
  // One node with 246 GiB free — the shape of a single-node cluster. Packed
  // largest-first it takes the big machines; smallest-first it takes more of
  // them. Both are valid answers to different questions.
  const c = cap([node("only", 64000, 502.29, 0, 256.39)]);
  const sizes = [64, 32, 32, 32, 32, 16, 16, 16, 12, 8, 4];
  const vms = sizes.map((memoryGiB, i) => ({ name: `vm${i}`, cpuCount: 4, memoryGiB }));

  const big = packWave(vms, c);
  const small = packWave(vms, c, { order: "smallest-first" });
  assert.equal(big.order, "largest-first");
  assert.equal(big.placedCount, 8);
  assert.equal(small.placedCount, 10, "smallest-first places more machines in the same space");

  // And largest-first must say so rather than reporting 8 as the answer.
  assert.ok(big.alternative, "the better order is surfaced, not buried");
  assert.equal(big.alternative.order, "smallest-first");
  assert.equal(big.alternative.gain, 2);
  assert.match(big.alternative.note, /Neither is more correct/);
});

test("a wave that fully places is not offered an alternative order", () => {
  const c = cap([node("w1", 32000, 64), node("w2", 32000, 64)]);
  const p = packWave([{ name: "a", cpuCount: 2, memoryGiB: 8 }], c);
  assert.equal(p.fits, true);
  assert.equal(p.alternative, null, "there is nothing to improve on");
});

test("one virtualization node is reported as having nothing to fail over to", () => {
  const r = nodeLossRehearsal([{ name: "a", cpuCount: 2, memoryGiB: 8 }], cap([node("only", 32000, 64)]));
  assert.equal(r.available, true);
  assert.equal(r.singleNode, true);
  assert.deepEqual(r.nodes, [], "no rows — which is why the console must not key off row count");
  assert.match(r.note, /nothing to fail over to/);
});
