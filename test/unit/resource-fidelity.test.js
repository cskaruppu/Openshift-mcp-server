import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySourceQoS, targetProfile, resourceFindings, resourceFidelity, DEFAULT_CPU_RATIO,
} from "../../src/services/resource-fidelity.js";

const find = (r, id) => r.findings.find((f) => f.id === id);

// ── What VMware promises ───────────────────────────────────────────────────

test("a full memory reservation or pinned CPU reads as guaranteed", () => {
  assert.equal(classifySourceQoS({ memoryReservationLockedToMax: true }).class, "guaranteed");
  assert.equal(classifySourceQoS({ latencySensitivity: "high" }).class, "guaranteed");
  assert.equal(classifySourceQoS({ cpuAffinity: [0, 1] }).class, "guaranteed");
  // A reservation covering the whole guest is the same promise by another name.
  assert.equal(classifySourceQoS({ memoryMB: 16384, memoryReservation: 16384 }).class, "guaranteed");
});

test("a partial reservation is not the same claim as a full one", () => {
  const p = classifySourceQoS({ memoryMB: 16384, memoryReservation: 4096 });
  assert.equal(p.class, "partial");
  assert.match(p.evidence[0], /4096 MB of memory reserved/);
  assert.doesNotMatch(p.evidence[0], /whole guest/);
  assert.equal(classifySourceQoS({ cpuReservation: 2000 }).class, "partial");
});

test("explicitly-zero reservations are 'shared'; absent ones are 'unknown'", () => {
  const shared = classifySourceQoS({
    cpuReservation: 0, memoryReservation: 0, memoryReservationLockedToMax: false,
    latencySensitivity: "normal", cpuAffinity: [],
  });
  assert.equal(shared.class, "shared");
  assert.equal(shared.known, true);

  // Nothing reported is not the same as nothing reserved.
  const silent = classifySourceQoS({ cpuCount: 4, memoryMB: 8192 });
  assert.equal(silent.class, "unknown");
  assert.equal(silent.known, false);
  assert.deepEqual(silent.evidence, []);
});

// ── What OpenShift Virtualization actually gives it ────────────────────────

test("the CPU request is the vCPU count divided by the overcommit ratio", () => {
  const t = targetProfile({ cpuCount: 4, memoryGiB: 16 });
  assert.equal(t.cpuRequestMillis, 4000 / DEFAULT_CPU_RATIO);
  assert.equal(t.vcpu, 4, "the guest still sees every vCPU it was assigned");
  assert.equal(t.qos, "Burstable", "no limits are set, so it is never Guaranteed");
  assert.ok(t.memoryRequestGiB > 16, "memory is requested in full, plus overhead");

  // A cluster configured without overcommit requests the lot.
  assert.equal(targetProfile({ cpuCount: 4 }, { cpuAllocationRatio: 1 }).cpuRequestMillis, 4000);
});

test("a guaranteed VM is told what to set, and that MTV carries nothing over", () => {
  const r = resourceFindings({ name: "db", cpuCount: 16, memoryGiB: 128, memoryReservationLockedToMax: true });
  const drop = find(r, "qosDrop");
  assert.equal(drop.required, true);
  assert.equal(drop.severity, "warning");
  assert.match(drop.detail, /does not carry reservations/);
  assert.match(drop.action, /dedicatedCpuPlacement/);
  assert.match(drop.action, /CPU Manager/, "the node-side prerequisite has to be named");
});

test("an already-shared VM is not warned about losing something it never had", () => {
  const r = resourceFindings({
    name: "web", cpuCount: 2, memoryGiB: 4,
    cpuReservation: 0, memoryReservation: 0, memoryReservationLockedToMax: false,
    latencySensitivity: "normal", cpuAffinity: [],
  });
  assert.equal(find(r, "qosDrop"), undefined);
  // The overcommit note still applies — it applies to everything.
  assert.equal(find(r, "cpuOvercommit").severity, "info");
});

test("overcommit is stated for every VM, and weighted by size", () => {
  assert.equal(resourceFindings({ cpuCount: 2 }).findings.find((f) => f.id === "cpuOvercommit").severity, "info");
  const big = resourceFindings({ cpuCount: 16 }).findings.find((f) => f.id === "cpuOvercommit");
  assert.equal(big.severity, "warning");
  assert.match(big.detail, /guest still sees 16 CPUs/);
  assert.match(big.title, /16 vCPU will request 1600m/);
});

test("ballooning on the source is reported as host pressure, not VM sizing", () => {
  const f = find(resourceFindings({ cpuCount: 2, balloonedMemory: 2048 }), "ballooning");
  assert.match(f.detail, /under memory pressure/);
  assert.match(f.action, /configured memory, not from what it is being allowed today/);
  assert.equal(find(resourceFindings({ cpuCount: 2, balloonedMemory: 0 }), "ballooning"), undefined);
});

// ── The fleet number people quote ──────────────────────────────────────────

test("the fleet roll-up contrasts assigned vCPU with requested cores", () => {
  const f = resourceFidelity([
    { name: "a", cpuCount: 16, memoryGiB: 64, memoryReservationLockedToMax: true },
    { name: "b", cpuCount: 8, memoryGiB: 32, cpuReservation: 0, memoryReservation: 0, memoryReservationLockedToMax: false, latencySensitivity: "normal", cpuAffinity: [] },
    { name: "c", cpuCount: 4, memoryGiB: 16 },
  ]);
  assert.equal(f.cpu.assignedVcpu, 28);
  assert.equal(f.cpu.requestedCores, 2.8);
  assert.deepEqual(f.byClass, { guaranteed: 1, partial: 0, shared: 1, unknown: 1 });
  assert.deepEqual(f.losing.map((l) => l.name), ["a"]);
  assert.match(f.headline, /28 vCPU assigned on VMware becomes 2\.8 cores/);
  assert.ok(f.memory.requestedGiB > f.memory.assignedGiB, "memory grows by the overhead, it does not shrink");
});

test("when nothing was reported, the CPU figures still stand and the gap is admitted", () => {
  const f = resourceFidelity([{ name: "a", cpuCount: 8, memoryGiB: 16 }]);
  assert.equal(f.byClass.unknown, 1);
  assert.match(f.note, /did not report reservations/);
  assert.match(f.note, /CPU figures above still hold/);
  assert.equal(f.cpu.requestedCores, 0.8);
});

test("an empty selection does not fabricate a headline", () => {
  const f = resourceFidelity([]);
  assert.equal(f.vms, 0);
  assert.match(f.headline, /No CPU assignment reported/);
});
