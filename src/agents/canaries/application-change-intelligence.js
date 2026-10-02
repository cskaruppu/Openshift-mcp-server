/**
 * Canary cases for the Application Change Intelligence Agent.
 *
 * What these are protecting: the sentence put in front of somebody who is
 * deciding whether a change to a production namespace is fine. The failure that
 * matters is the agent getting QUIETER — a scale-to-zero described as low risk,
 * a production namespace ranked below a sandbox, a high-risk change recommended
 * for acknowledgement rather than review.
 *
 * Every one of those reads as a calmer, less noisy product.
 */

import {
  scoreNamespaceRecommendations, generateRiskExplanation,
} from "../../tools/app-change-watcher.js";

export default [
  {
    id: "production-outranks-sandbox",
    kind: "pure",
    title: "A busy production namespace is ranked above a quiet sandbox",
    why: "The ranking decides what a human looks at first. If a sandbox ever outranks production, attention goes to the namespace where nothing matters while the one serving customers scrolls off the screen.",
    run: async () => {
      const scored = scoreNamespaceRecommendations(
        [
          { ns: "sandbox", count: 1, breakdown: { deployments: 1, pods: 1 } },
          { ns: "prod-shop", count: 12, breakdown: { deployments: 8, statefulsets: 2, daemonsets: 2, pods: 40 } },
        ],
        [
          { namespace: "prod-shop", severity: "critical" },
          { namespace: "prod-shop" }, { namespace: "prod-shop" },
          { namespace: "prod-shop" }, { namespace: "prod-shop" },
        ],
        {}
      );
      const by = Object.fromEntries(scored.map((s) => [s.namespace, s.score]));
      return {
        prod: by["prod-shop"], sandbox: by["sandbox"],
        prodWins: by["prod-shop"] > by["sandbox"],
        reasonsGiven: scored.every((s) => (s.reasons || []).length > 0),
        __evidence: { read: 2, expected: 2, confidence: "medium", concluded: true },
      };
    },
    expect: [
      { path: "prodWins", assert: "equals", value: true },
      { path: "reasonsGiven", assert: "equals", value: true, note: "A score with no reason is a number to argue with." },
    ],
  },

  {
    id: "scale-to-zero-is-called-out",
    kind: "pure",
    title: "A workload scaled to zero is explicitly flagged as unavailable",
    why: "Scaling to zero takes a service down. If that stops being named in the explanation, the one change that guarantees an outage reads like any other replica tweak.",
    run: async () => {
      const text = generateRiskExplanation({
        kind: "Deployment", name: "api", namespace: "prod", changeType: "scale",
        changes: [{ field: "replicas", old: "3", new: "0" }], riskScore: 85,
      });
      return { text };
    },
    expect: [
      { path: "text", assert: "matches", value: "scaled to zero|service will be unavailable" },
      { path: "text", assert: "excludes", value: "Low-risk change" },
    ],
  },

  {
    id: "a-high-risk-change-is-sent-for-review-not-acknowledgement",
    kind: "pure",
    title: "A high risk score recommends review before agreeing",
    why: "The recommendation is the action. 'Acknowledge and monitor' on a high-blast-radius change is how a bad change gets agreed to in one click.",
    run: async () => {
      const high = generateRiskExplanation({ changeType: "image-update", riskScore: 85, changes: [] });
      const low = generateRiskExplanation({ changeType: "image-update", riskScore: 10, changes: [] });
      return { high, low };
    },
    expect: [
      { path: "high", assert: "matches", value: "Review immediately before agreeing" },
      { path: "low", assert: "matches", value: "Low-risk change" },
    ],
  },

  {
    id: "an-image-change-says-it-is-an-image-change",
    kind: "pure",
    title: "An image update names the risk that comes with it",
    why: "An image update is the most common production change and the most common cause of a regression. The explanation has to say that running workloads are affected, or it is just a diff.",
    run: async () => {
      const text = generateRiskExplanation({
        kind: "Deployment", changeType: "image-update", riskScore: 60,
        changes: [{ field: "/spec/template/spec/containers/0/image", old: "reg/app:1.0", new: "reg/app:2.0" }],
      });
      return { text };
    },
    expect: [
      { path: "text", assert: "matches", value: "Image updated|Container image changed" },
      { path: "text", assert: "matches", value: "affect running workloads" },
    ],
  },

  {
    id: "an-out-of-hours-change-is-noted",
    kind: "pure",
    title: "A change made outside business hours is called out",
    why: "A change during a freeze window is the signature of something unreviewed. It is a timing fact the explanation must carry, because nothing else in the trail records it.",
    run: async () => {
      const text = generateRiskExplanation({ changeType: "config-change", changeFreezeViolation: true, changes: [{ field: "data.x" }], riskScore: 40 });
      return { text };
    },
    expect: [
      { path: "text", assert: "matches", value: "outside business hours" },
    ],
  },
];
