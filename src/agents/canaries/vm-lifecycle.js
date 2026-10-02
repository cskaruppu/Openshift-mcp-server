/**
 * Canary cases for the VM Lifecycle Agent.
 *
 * What these are protecting: what actually gets provisioned when somebody types
 * a sentence. One regression here already happened in this product and is the
 * reason several of these exist: a sizing tie-break fell to alphabetical order
 * and quietly chose `cx1.medium` — a dedicated-CPU instance type that carries
 * `dedicatedCPUPlacement`, which adds a `cpumanager=true` node selector, which
 * left the VM Pending with FailedScheduling on a cluster with no such node.
 *
 * The user saw "the VM will not start". Nothing threw. Nothing in the trace
 * said the agent had chosen an instance type nobody asked for.
 */

import {
  normalizeVMRequest, missingFields, reconcileSizing, parseMemToMi,
} from "../../services/vm-provisioning.js";

/** A catalogue shaped like a real cluster's: general-purpose and dedicated-CPU. */
const TYPES = [
  { name: "cx1.medium", cpu: 2, memory: "4Gi" },
  { name: "o1.small", cpu: 2, memory: "4Gi" },
  { name: "u1.medium", cpu: 2, memory: "8Gi" },
  { name: "u1.large", cpu: 4, memory: "16Gi" },
];

export default [
  {
    id: "an-explicitly-named-instance-type-is-honoured",
    kind: "pure",
    title: "Naming an instance type gets that instance type",
    why: "The fix for the cx1 incident was letting somebody name the type. If a named type is ever silently replaced by a 'better fit', the escape hatch from the sizing heuristic is gone and the original defect is back with no way around it.",
    run: async () => {
      const r = reconcileSizing({ instanceType: "o1.small", cpuCores: 2, memoryMi: 4096 }, TYPES);
      return { verdict: r.verdict, chosen: r.chosen?.name, message: r.message };
    },
    expect: [
      { path: "verdict", assert: "equals", value: "explicit" },
      { path: "chosen", assert: "equals", value: "o1.small" },
    ],
  },

  {
    id: "an-unknown-instance-type-is-refused-not-substituted",
    kind: "pure",
    title: "An instance type that does not exist is refused, not quietly swapped",
    why: "Substituting a different type for one the user named is how somebody gets a VM they did not ask for. Refusing is the only safe answer, because the agent cannot know whether the name was a typo or a type that should exist.",
    run: async () => {
      const r = reconcileSizing({ instanceType: "o1.enormous", cpuCores: 2, memoryMi: 4096 }, TYPES);
      return { verdict: r.verdict, chosen: r.chosen, message: r.message };
    },
    expect: [
      { path: "verdict", assert: "equals", value: "unknown" },
      { path: "chosen", assert: "equals", value: null, note: "No substitute. Not the nearest. Nothing." },
      { path: "message", assert: "matches", value: "was not found on this cluster" },
    ],
  },

  {
    id: "sizing-picks-the-smallest-type-that-fits",
    kind: "pure",
    title: "Automatic sizing picks the smallest type that meets both CPU and memory",
    why: "The tie-break is where the cx1 defect lived. Sorting by size rather than by name is what keeps a dedicated-CPU type from being chosen for a workload that asked for nothing of the kind.",
    run: async () => {
      const r = reconcileSizing({ cpuCores: 2, memoryMi: 8192 }, TYPES);
      const fitsBoth = r.chosen ? r.chosen.cpu >= 2 && parseMemToMi(r.chosen.memory) >= 8192 : false;
      return { chosen: r.chosen?.name, fitsBoth, cpu: r.chosen?.cpu };
    },
    expect: [
      { path: "fitsBoth", assert: "equals", value: true },
      { path: "chosen", assert: "equals", value: "u1.medium", note: "u1.medium is the smallest type meeting 2 vCPU AND 8Gi; u1.large would be over-provisioning." },
    ],
  },

  {
    id: "a-request-larger-than-the-catalogue-is-escalated",
    kind: "pure",
    title: "A request nothing in the catalogue can meet is escalated, not rounded down",
    why: "Silently giving somebody the biggest available type when they asked for more is the failure that is only discovered under load. It has to come back as 'this needs an exception'.",
    run: async () => {
      const r = reconcileSizing({ cpuCores: 64, memoryMi: 999999 }, TYPES);
      return { verdict: r.verdict, chosen: r.chosen, biggest: r.biggest?.name, message: r.message };
    },
    expect: [
      { path: "verdict", assert: "equals", value: "exceeds-catalogue" },
      { path: "chosen", assert: "equals", value: null },
      { path: "message", assert: "matches", value: "explicit size and an exception" },
    ],
  },

  {
    id: "a-request-missing-its-essentials-says-which",
    kind: "pure",
    title: "An incomplete request names every field it is missing",
    why: "A provisioning request that proceeds on defaults it invented produces a VM nobody specified. Naming the gaps is what turns a refusal into something the user can act on in one go rather than four.",
    run: async () => {
      const missing = missingFields(normalizeVMRequest({}));
      return { missing, count: missing.length };
    },
    expect: [
      { path: "count", assert: "atLeast", value: 3 },
      { path: "missing", assert: "contains", value: "name" },
      { path: "missing", assert: "contains", value: "sizing" },
    ],
  },

  {
    id: "an-empty-catalogue-sizes-explicitly-rather-than-failing",
    kind: "pure",
    title: "With no instance types on the cluster, the VM is sized explicitly",
    why: "A cluster with no instance types is normal, not an error. Refusing to provision there would block a legitimate request; the right answer is an explicit size and a sentence saying so.",
    run: async () => {
      const r = reconcileSizing({ cpuCores: 2, memoryMi: 4096 }, []);
      return { verdict: r.verdict, message: r.message };
    },
    expect: [
      { path: "verdict", assert: "equals", value: "none-available" },
      { path: "message", assert: "matches", value: "sized explicitly" },
    ],
  },
];
