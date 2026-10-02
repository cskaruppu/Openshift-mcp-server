/**
 * Canary cases for the ITSM & Change Management Agent.
 *
 * What these are protecting: the gate between "the model suggested something"
 * and "a change is made to the estate". This agent turns a parsed intent into
 * an action that will carry a change record, and the allow-list is the whole
 * control:
 *
 *   · an action type nobody sanctioned becoming executable
 *   · a resource type outside the list becoming deletable
 *   · an incomplete parse producing an action anyway, so a change is raised
 *     against a resource nobody named
 *
 * None of these throws. A widened allow-list reads as a more capable agent.
 */

import { actionFromParse } from "../../services/action-workflow.js";

export default [
  {
    id: "an-incomplete-parse-produces-no-action",
    kind: "pure",
    title: "A parse missing its resource or name yields no action at all",
    why: "An action with no named resource becomes a change request against nothing, or worse, against a default. The refusal must happen here, before a change record exists, because a raised change is a thing somebody then approves.",
    run: async () => {
      return {
        noResource: actionFromParse({ intent: "delete", resource: null, name: "api" }),
        noName: actionFromParse({ intent: "delete", resource: "pod", name: null }),
        nothing: actionFromParse(null),
        noIntent: actionFromParse({ resource: "pod", name: "api" }),
      };
    },
    expect: [
      { path: "noResource", assert: "equals", value: null },
      { path: "noName", assert: "equals", value: null },
      { path: "nothing", assert: "equals", value: null },
      { path: "noIntent", assert: "equals", value: null },
    ],
  },

  {
    id: "the-allow-list-still-refuses-what-is-not-on-it",
    kind: "pure",
    title: "An action on a resource type outside the allow-list is refused",
    why: "The allow-list is the only thing standing between a parsed sentence and the API server. If it ever widens by accident — a new resource type added to a parser but not reviewed here — this agent gains the ability to change something nobody sanctioned.",
    run: async () => {
      const refused = [
        { intent: "delete", resource: "node", name: "worker-1" },
        { intent: "delete", resource: "persistentvolume", name: "pv-1" },
        { intent: "delete", resource: "clusterrolebinding", name: "admin" },
        { intent: "patch", resource: "node", name: "worker-1", options: { patchBody: "{}" } },
        { intent: "scale", resource: "daemonset", name: "ds-1" },
      ].map((p) => ({ p, a: actionFromParse(p) }));
      return {
        allRefused: refused.every((r) => r.a === null),
        leaked: refused.filter((r) => r.a).map((r) => `${r.p.intent}:${r.p.resource}`),
      };
    },
    expect: [
      { path: "allRefused", assert: "equals", value: true },
      { path: "leaked", assert: "equals", value: [], note: "Anything listed here became executable without review." },
    ],
  },

  {
    id: "restarting-a-pod-is-a-delete-and-says-so",
    kind: "pure",
    title: "'Restart this pod' resolves to a delete, not a no-op",
    why: "A pod has no restart verb — the controller recreates it after a delete. If this ever resolves to something else, 'restart the pod' either does nothing (and somebody waits for a recovery that never comes) or does something unexpected under a label that says restart.",
    run: async () => {
      const a = actionFromParse({ intent: "restart", resource: "pod", name: "api-7f", namespace: "shop" });
      return { action: a?.action, resourceType: a?.resourceType, name: a?.resourceName };
    },
    expect: [
      { path: "action", assert: "equals", value: "delete" },
      { path: "resourceType", assert: "equals", value: "pod" },
      { path: "name", assert: "equals", value: "api-7f" },
    ],
  },

  {
    id: "a-replica-count-becomes-a-scale-not-a-restart",
    kind: "pure",
    title: "An update carrying a replica count is a scale",
    why: "If a scale is classified as a restart, the replica count is dropped and the workload is bounced instead of resized — the change record then describes something that did not happen, which is the one thing a change record must never do.",
    run: async () => {
      const scale = actionFromParse({ intent: "update", resource: "deployment", name: "api", namespace: "shop", options: { replicas: 5 } });
      const restart = actionFromParse({ intent: "update", resource: "deployment", name: "api", namespace: "shop", options: {} });
      return { scaleAction: scale?.action, replicas: scale?.options?.replicas, restartAction: restart?.action };
    },
    expect: [
      { path: "scaleAction", assert: "equals", value: "scale" },
      { path: "replicas", assert: "equals", value: 5, note: "The number must survive — a scale that loses its target is a bounce." },
      { path: "restartAction", assert: "equals", value: "restart" },
    ],
  },

  {
    id: "the-namespace-travels-with-the-action",
    kind: "pure",
    title: "The namespace is carried through to the action",
    why: "An action that loses its namespace runs wherever the client happens to be pointing. For a delete, that is the difference between removing a pod in staging and removing one in production.",
    run: async () => {
      const a = actionFromParse({ intent: "delete", resource: "pod", name: "api-7f", namespace: "staging" });
      return { namespace: a?.namespace, action: a?.action };
    },
    expect: [
      { path: "namespace", assert: "equals", value: "staging" },
      { path: "action", assert: "equals", value: "delete" },
    ],
  },
];
