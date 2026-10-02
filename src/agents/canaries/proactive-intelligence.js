/**
 * Canary cases for the Proactive Intelligence Agent.
 *
 * What these are protecting: the translation from a sentence somebody typed
 * into an automation rule that will fire on a live cluster. This agent writes
 * rules from natural language, so the failures are at the edges of the parse:
 *
 *   · a condition nobody asked for being added, so the rule fires on the wrong
 *     thing at 3am
 *   · a namespace filter being dropped, so a rule written for staging fires on
 *     production
 *   · an unparseable sentence producing a rule anyway, rather than nothing
 *
 * A parser that extracts MORE from a sentence looks more capable. Every one of
 * these makes it more capable and more wrong.
 */

import { parseRule, evaluateRules } from "../../services/automation-rules.js";

export default [
  {
    id: "the-namespace-filter-survives-the-parse",
    kind: "pure",
    title: "A rule written for one namespace keeps that namespace",
    why: "A rule that loses its namespace filter becomes cluster-wide. Something written to restart pods in staging then restarts them in production, and nothing about the rule's text says it will.",
    run: async () => {
      const a = parseRule("when a pod has a crashloop in staging namespace restart the deployment");
      const b = parseRule("on oomkill in production namespace send a slack alert");
      return { staging: a.namespaceFilter, production: b.namespaceFilter };
    },
    expect: [
      { path: "staging", assert: "equals", value: "staging" },
      { path: "production", assert: "equals", value: "production" },
    ],
  },

  {
    id: "conditions-are-recognised-not-invented",
    kind: "pure",
    title: "A named failure condition is recognised, and nothing else is added",
    why: "Each condition is a trigger. Adding one the sentence did not ask for means the rule fires on an event nobody intended — and the first anyone knows is an action taken on a cluster at 3am.",
    run: async () => {
      const r = parseRule("when a pod hits oomkill send a slack alert");
      return { conditions: r.conditions, count: r.conditions.length, actions: r.actions.map((a) => a.type) };
    },
    expect: [
      { path: "conditions", assert: "contains", value: "OOMKilled" },
      { path: "count", assert: "equals", value: 1, note: "Exactly the one condition named. Not two." },
      { path: "actions", assert: "contains", value: "slack" },
    ],
  },

  {
    id: "an-unparseable-sentence-produces-nothing",
    kind: "pure",
    title: "A sentence with no condition and no action yields an empty rule",
    why: "A rule with no conditions either never fires or fires on everything, and both are worse than refusing. The parse must come back empty so the caller can say it did not understand.",
    run: async () => {
      const r = parseRule("please make the cluster better somehow");
      return { conditions: r.conditions.length, actions: r.actions.length, ns: r.namespaceFilter };
    },
    expect: [
      { path: "conditions", assert: "equals", value: 0 },
      { path: "actions", assert: "equals", value: 0 },
      { path: "ns", assert: "equals", value: null },
    ],
  },

  {
    id: "no-insights-fire-no-rules",
    kind: "pure",
    title: "With nothing observed, no rule fires",
    why: "An empty insight list means nothing was seen — possibly because nothing is wrong, possibly because the collector is down. Either way, firing an automation on no evidence is the worst available outcome: the agent acts on a cluster because it could not read it.",
    run: async () => {
      const fired = evaluateRules([]);
      return { fired, count: Array.isArray(fired) ? fired.length : -1,
        __evidence: { read: 0, expected: 0, confidence: "low", concluded: false } };
    },
    expect: [
      { path: "count", assert: "equals", value: 0 },
    ],
  },

  {
    id: "each-known-condition-still-parses",
    kind: "pure",
    title: "Every condition the parser claims to know is still recognised",
    why: "A regex quietly dropping out of the table means a whole class of event stops triggering any rule. Nothing errors — the automation simply never fires, which is indistinguishable from a quiet cluster.",
    run: async () => {
      const phrases = {
        OOMKilled: "alert on oomkill",
        CrashLoopBackOff: "alert on crashloop",
        ImagePullBackOff: "alert on imagepull failure",
        NodeNotReady: "alert when a node is not ready",
        DiskPressure: "alert on disk pressure",
        CertExpiringSoon: "alert when a cert expires soon",
      };
      const missed = Object.entries(phrases)
        .filter(([type, text]) => !parseRule(text).conditions.includes(type))
        .map(([type]) => type);
      return { missed, recognised: Object.keys(phrases).length - missed.length };
    },
    expect: [
      { path: "missed", assert: "equals", value: [] },
      { path: "recognised", assert: "atLeast", value: 6 },
    ],
  },
];
