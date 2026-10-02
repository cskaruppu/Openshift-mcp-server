/**
 * Canary cases for the VM Migration Agent.
 *
 * What these are protecting: a migration verification that passes when it
 * should not. The worst outcome this product can produce is telling somebody a
 * machine migrated cleanly when the source is still powered on — two copies of
 * the same identity on the same network, each writing to storage the other
 * cannot see, and whichever one loses is the one somebody was using.
 *
 * The regressions that would cause it are all the same shape: a check that was
 * UNRUN starting to count as a PASS. Nothing else in the system would notice,
 * because an unrun check does not throw and an inflated pass rate looks like
 * the migrations getting better.
 */

import { verifyVM, rollUp } from "../../services/migration-verify.js";
import { classifySourceQoS, targetProfile } from "../../services/resource-fidelity.js";

const RUNNING = { name: "app-01", phase: "running", node: "worker-1", ips: ["10.0.0.5"] };

export default [
  {
    id: "source-still-on-is-a-failure",
    kind: "pure",
    title: "A source VM still powered on fails verification",
    why: "Two machines with the same identity and address, both writing to storage the other cannot see, is the most expensive outcome this product can cause. If this check ever softens to a warning, a migration wave signs off clean and the data loss arrives later.",
    run: async () => {
      const r = verifyVM({ name: "app-01", ips: ["10.0.0.5"] }, RUNNING, null, /* sourceOff */ false);
      const c = r.checks.find((x) => x.id === "source-off");
      return { state: c?.state, detail: c?.detail, rollUp: rollUp(r.checks).state };
    },
    expect: [
      { path: "state", assert: "equals", value: "fail", note: "Not a warning. Not advisory." },
      { path: "detail", assert: "matches", value: "still powered ON" },
    ],
  },

  {
    id: "unread-source-is-not-a-pass",
    kind: "pure",
    title: "A source platform that could not be read is unrun, never passed",
    why: "The house rule, in the place it matters most. If an unreadable source silently counts as 'source is off', every verification against an unreachable vCenter reports a clean migration.",
    run: async () => {
      const r = verifyVM({ name: "app-01", ips: ["10.0.0.5"] }, RUNNING, null, /* sourceOff */ null);
      const c = r.checks.find((x) => x.id === "source-off");
      return { state: c?.state, detail: c?.detail };
    },
    expect: [
      { path: "state", assert: "excludes", value: "pass", note: "An unread check must never be a pass." },
      { path: "state", assert: "equals", value: "unchecked" },
    ],
  },

  {
    id: "missing-vm-fails",
    kind: "pure",
    title: "A VM that is not there fails, rather than being skipped",
    why: "A verification that quietly skips the machine it cannot find reports success for a migration that produced nothing.",
    run: async () => {
      const r = verifyVM({ name: "ghost-01" }, null, null, true);
      const c = r.checks.find((x) => x.id === "running");
      return { state: c?.state, detail: c?.detail };
    },
    expect: [
      { path: "state", assert: "equals", value: "fail" },
      { path: "detail", assert: "matches", value: "No VirtualMachine named ghost-01" },
    ],
  },

  {
    id: "guaranteed-source-is-recognised",
    kind: "pure",
    title: "A VM with its memory fully reserved is classed guaranteed, not shared",
    why: "A machine whose memory was reserved on vSphere becomes Burstable on OpenShift — evictable under pressure. If the source class is read as 'shared', that change in guarantee is never reported and the first node-pressure eviction is a surprise in production.",
    run: async () => {
      const g = classifySourceQoS({ memoryReservationLockedToMax: true, memoryMB: 16384, cpuCount: 4 });
      const unknown = classifySourceQoS({});
      const t = targetProfile({ cpuCount: 4, memoryGiB: 16 }, { cpuAllocationRatio: 4 });
      return { class: g.class, known: g.known, unknownClass: unknown.class, unknownKnown: unknown.known, targetQos: t.qos };
    },
    expect: [
      { path: "class", assert: "equals", value: "guaranteed" },
      { path: "unknownClass", assert: "equals", value: "unknown", note: "Nothing observed and nothing observable are different answers." },
      { path: "unknownKnown", assert: "equals", value: false },
      { path: "targetQos", assert: "equals", value: "Burstable", note: "A migrated VM sets no limits, so it is Burstable. If this ever reads Guaranteed the fidelity warning disappears." },
    ],
  },
];
