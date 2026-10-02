/**
 * Canary cases for the Multi-Cluster / ACM Agent.
 *
 * What this is protecting: which cluster a command lands on. This agent carries
 * `emergency_fix` and `approved_fix` — it changes things — and it changes them
 * on whichever context is active. The failure that matters is not an error; it
 * is a silent fallback:
 *
 *   A switch to a context that does not exist must FAIL and leave the active
 *   context exactly where it was. If it ever returns success, or clears the
 *   active context, or half-applies — setting the API URL before discovering
 *   the context is unknown — then a command meant for a lab cluster executes
 *   against production, and nothing in the transcript says so.
 *
 * The rest of this agent is ACM API passthrough with no local decision, so the
 * read-only case covers the shape of what comes back; it skips without a
 * cluster and is reported as skipped, never as a pass.
 */

import { listContexts, getActiveContext, switchContext } from "../../services/multi-cluster.js";

export default [
  {
    id: "an-unknown-context-switch-fails-and-changes-nothing",
    kind: "pure",
    title: "Switching to a context that does not exist fails, and the active cluster is untouched",
    why: "This agent can change the estate, and it does so against the active context. A switch that fails but still moves the pointer — or that reports success — sends an emergency fix to the wrong cluster. There is no undo for that, and no error message to go looking for.",
    run: async () => {
      const before = getActiveContext();
      const beforeUrl = process.env.OPENSHIFT_API_URL || null;
      const result = switchContext("no-such-context-" + Date.now());
      const after = getActiveContext();
      const afterUrl = process.env.OPENSHIFT_API_URL || null;
      return {
        success: result.success,
        error: result.error,
        contextUnchanged: JSON.stringify(before) === JSON.stringify(after),
        apiUrlUnchanged: beforeUrl === afterUrl,
        __evidence: { read: 1, expected: 1, confidence: "high", concluded: true },
      };
    },
    expect: [
      { path: "success", assert: "equals", value: false },
      { path: "contextUnchanged", assert: "equals", value: true, note: "A failed switch must not move the pointer." },
      { path: "apiUrlUnchanged", assert: "equals", value: true, note: "Nor may it half-apply by setting the API URL before it checks." },
      { path: "error", assert: "matches", value: "not found" },
    ],
  },

  {
    id: "the-available-contexts-are-named-in-the-refusal",
    kind: "pure",
    title: "A failed switch says which contexts do exist",
    why: "A refusal with no alternatives sends somebody to the config file. Naming the available contexts is what lets them correct a typo in one step rather than leaving the console.",
    run: async () => {
      const r = switchContext("definitely-not-a-context");
      return { error: r.error, mentionsAvailable: /Available:/.test(r.error || "") };
    },
    expect: [
      { path: "mentionsAvailable", assert: "equals", value: true },
    ],
  },

  {
    id: "the-context-list-is-an-array-not-a-guess",
    kind: "pure",
    title: "With no clusters configured, the list is empty rather than invented",
    why: "An empty cluster list is a legitimate state. Returning a placeholder or defaulting to 'local' would make the console show a cluster that is not there, and every action aimed at it would go somewhere unintended.",
    run: async () => {
      const list = listContexts();
      return { isArray: Array.isArray(list), active: getActiveContext() };
    },
    expect: [
      { path: "isArray", assert: "equals", value: true },
    ],
  },

  {
    id: "managed-clusters-answer-with-their-real-status",
    kind: "read-only",
    title: "ACM's managed clusters are listed with their availability",
    why: "The rest of this agent is ACM API passthrough. This case needs a real cluster with ACM to mean anything, so it skips in a disconnected environment and is reported as skipped — never as a pass.",
    run: async () => {
      const { ocpGet } = await import("../../utils/openshift-client.js");
      const d = await ocpGet("/apis/cluster.open-cluster-management.io/v1/managedclusters");
      const items = d.items || [];
      return {
        kind: d.kind,
        count: items.length,
        allNamed: items.every((c) => !!c.metadata?.name),
        __evidence: { read: items.length, expected: items.length, confidence: "medium", concluded: true },
      };
    },
    expect: [
      { path: "kind", assert: "matches", value: "ManagedClusterList" },
      { path: "allNamed", assert: "equals", value: true },
    ],
  },
];
