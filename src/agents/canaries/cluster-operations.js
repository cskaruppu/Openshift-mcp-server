/**
 * Canary cases for the Cluster Operations Agent.
 *
 * AN HONEST NOTE ON WHAT THESE CAN CHECK.
 *
 * This agent's logic lives inside its MCP tool handlers, interleaved with the
 * API calls — there is no pure scorer to import. Rather than refactor four
 * working handlers to make them testable, these cases call the real cluster and
 * assert the invariants on what comes back. They need a reachable cluster;
 * without one they SKIP, and a skip is reported as a skip, never as a pass. In
 * a disconnected environment this agent reads as unverified, which is true.
 *
 * What they protect: the reading of node health. A node whose Ready condition
 * is missing, Unknown, or False must never be counted as Ready — that is the
 * number capacity planning and every "is the cluster healthy" answer rests on,
 * and an over-count looks like a healthier cluster.
 */

import { ocpGet } from "../../utils/openshift-client.js";

export default [
  {
    id: "node-readiness-comes-from-the-condition-not-the-absence-of-one",
    kind: "read-only",
    title: "A node is Ready only when its Ready condition says True",
    why: "A node with no Ready condition, or one reporting Unknown, is a node the control plane has lost contact with — the single most important thing to notice. Counting it as Ready inflates every capacity and health figure, and the cluster looks fine right up until pods will not schedule.",
    run: async () => {
      const d = await ocpGet("/api/v1/nodes");
      const nodes = d.items || [];
      const readiness = nodes.map((n) => {
        const ready = (n.status?.conditions || []).find((c) => c.type === "Ready");
        return { name: n.metadata?.name, status: ready?.status ?? null };
      });
      return {
        total: nodes.length,
        // Anything not explicitly "True" must be counted as not ready.
        ready: readiness.filter((r) => r.status === "True").length,
        notReady: readiness.filter((r) => r.status !== "True").length,
        missingCondition: readiness.filter((r) => r.status === null).map((r) => r.name),
        countsAddUp: readiness.filter((r) => r.status === "True").length
          + readiness.filter((r) => r.status !== "True").length === nodes.length,
        __evidence: { read: nodes.length, expected: nodes.length, confidence: "high", concluded: true },
      };
    },
    expect: [
      { path: "total", assert: "atLeast", value: 1, note: "A cluster with no nodes means the read failed, not that the cluster is empty." },
      { path: "countsAddUp", assert: "equals", value: true,
        note: "Every node lands in exactly one bucket. A node that is in neither has been dropped from the count." },
    ],
  },

  {
    id: "the-cluster-version-is-readable-and-named",
    kind: "read-only",
    title: "The cluster reports a real version",
    why: "Half the agent's answers — upgrade paths, operator compatibility, support status — hang off the cluster version. An empty or placeholder version means every one of those answers was computed against nothing.",
    run: async () => {
      const d = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
      const desired = d.status?.desired?.version || null;
      return {
        version: desired,
        looksLikeAVersion: /^\d+\.\d+\.\d+/.test(desired || ""),
        hasHistory: Array.isArray(d.status?.history) && d.status.history.length > 0,
      };
    },
    expect: [
      { path: "looksLikeAVersion", assert: "equals", value: true },
      { path: "hasHistory", assert: "equals", value: true },
    ],
  },

  {
    id: "degraded-operators-are-visible-not-smoothed-over",
    kind: "read-only",
    title: "Cluster operator conditions are read as reported",
    why: "A ClusterOperator that is Degraded or not Available is how OpenShift says a core component is broken. If this agent ever reports the count of operators without their conditions, the one thing that matters about them is gone.",
    run: async () => {
      const d = await ocpGet("/apis/config.openshift.io/v1/clusteroperators");
      const ops = d.items || [];
      const cond = (o, t) => (o.status?.conditions || []).find((c) => c.type === t)?.status;
      return {
        total: ops.length,
        available: ops.filter((o) => cond(o, "Available") === "True").length,
        degraded: ops.filter((o) => cond(o, "Degraded") === "True").length,
        allHaveConditions: ops.every((o) => (o.status?.conditions || []).length > 0),
        __evidence: { read: ops.length, expected: ops.length, confidence: "high", concluded: true },
      };
    },
    expect: [
      { path: "total", assert: "atLeast", value: 1 },
      { path: "allHaveConditions", assert: "equals", value: true,
        note: "An operator with no conditions is one whose status was not read — not one that is healthy." },
    ],
  },
];
