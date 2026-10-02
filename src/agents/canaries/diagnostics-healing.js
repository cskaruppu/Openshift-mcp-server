/**
 * Canary cases for the Diagnostics & Healing Agent.
 *
 * What these are protecting: the sentence an engineer reads at 2am and acts on.
 * A pod doctor that mis-diagnoses sends somebody to restart a pod when the
 * problem is a memory limit, and the pod comes straight back.
 *
 * The regressions worth catching are the quiet ones: an OOMKill read as a
 * generic crash loop (so nobody raises the limit), an image pull failure read
 * as a crash (so nobody checks the pull secret), and — worst — a pod with no
 * container status reported as healthy rather than as unreadable.
 */

import { diagnosePod } from "../../services/pod-doctor.js";

const pod = (containers, over = {}) => ({
  name: "api-7f4b", namespace: "shop", phase: "Running",
  ownerKind: "Deployment", ownerName: "api", containers, ...over,
});

export default [
  {
    id: "oom-is-named-as-oom",
    kind: "pure",
    title: "A container killed by the OOM killer is diagnosed as OOMKilled",
    why: "An OOMKill and a crash loop look identical from the outside — restarts going up. Only the OOM diagnosis sends somebody to the memory limit; the generic one sends them to restart the pod, and it comes straight back. This is the single most common production diagnosis this agent makes.",
    run: async () => {
      const r = diagnosePod(pod([{ name: "api", restarts: 5, state: "CrashLoopBackOff", ready: false,
        lastState: { reason: "OOMKilled", exitCode: 137 } }]));
      return { severity: r.severity, rootCause: r.rootCause, diagnosis: r.diagnosis, fixes: r.fixes.length,
        __evidence: { read: 1, expected: 1, confidence: "medium", concluded: true } };
    },
    expect: [
      { path: "rootCause", assert: "equals", value: "OOMKilled" },
      { path: "severity", assert: "equals", value: "critical" },
      { path: "diagnosis", assert: "matches", value: "OOM Killer" },
      { path: "fixes", assert: "atLeast", value: 1, note: "A diagnosis with no suggested fix is a sentence, not help." },
    ],
  },

  {
    id: "image-pull-failure-is-not-a-crash",
    kind: "pure",
    title: "A pod that cannot pull its image is diagnosed as a pull failure",
    why: "An image that will not pull is a registry, tag or pull-secret problem. Diagnosing it as a crash sends somebody into the application logs of a container that never started.",
    run: async () => {
      const r = diagnosePod(pod([{ name: "c", restarts: 0, state: "ImagePullBackOff", ready: false, reason: "ImagePullBackOff" }],
        { phase: "Pending" }));
      return { severity: r.severity, rootCause: r.rootCause, diagnosis: r.diagnosis };
    },
    expect: [
      { path: "rootCause", assert: "equals", value: "ImagePullFailure" },
      { path: "severity", assert: "equals", value: "critical" },
      { path: "rootCause", assert: "excludes", value: "OOMKilled" },
    ],
  },

  {
    id: "no-container-status-is-not-healthy",
    kind: "pure",
    title: "A pod whose container status could not be read is reported as unread",
    why: "The house rule, in the place an engineer trusts most. A pod with no container status must say so — reporting it as healthy means the one pod nobody could read is the one that looks fine.",
    run: async () => {
      const r = diagnosePod(pod([]));
      return { diagnosis: r.diagnosis, rootCause: r.rootCause,
        __evidence: { read: 0, expected: 1, confidence: "low", concluded: false } };
    },
    expect: [
      { path: "diagnosis", assert: "matches", value: "No container status available" },
      { path: "diagnosis", assert: "excludes", value: "healthy" },
    ],
  },

  {
    id: "a-healthy-pod-is-called-healthy",
    kind: "pure",
    title: "A running, ready pod with no restarts is diagnosed as healthy",
    why: "A doctor that finds a problem in everything is ignored within a week. This is the case that keeps the other three meaningful.",
    run: async () => {
      const r = diagnosePod(pod([{ name: "web", restarts: 0, state: "running", ready: true }]));
      return { severity: r.severity, diagnosis: r.diagnosis, rootCause: r.rootCause };
    },
    expect: [
      { path: "severity", assert: "equals", value: "info" },
      { path: "diagnosis", assert: "matches", value: "healthy" },
      { path: "rootCause", assert: "equals", value: null },
    ],
  },

  {
    id: "a-restarting-pod-with-no-signal-says-so",
    kind: "pure",
    title: "Restarts with no crash signal are reported as unexplained, not invented",
    why: "When the evidence does not identify a cause, saying 'no clear crash signal in the available data' is correct. Inventing the most likely cause is how an engineer spends an hour on the wrong thing.",
    run: async () => {
      const r = diagnosePod(pod([{ name: "api", restarts: 7, state: "waiting", ready: false }]));
      return { rootCause: r.rootCause, diagnosis: r.diagnosis };
    },
    expect: [
      { path: "rootCause", assert: "equals", value: "unknown" },
      { path: "diagnosis", assert: "matches", value: "no clear crash signal" },
    ],
  },
];
