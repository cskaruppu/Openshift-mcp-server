/**
 * Canary cases for the Security & Compliance Agent.
 *
 * What these are protecting: the mapping from raw CIS findings to the framework
 * language an auditor speaks — SOC 2, PCI-DSS, HIPAA, NIST 800-53, ISO 27001.
 * A customer shows these scores to an assessor, so the regressions that matter
 * are the ones that make the score look BETTER than the cluster is:
 *
 *   · a failed CIS check no longer pulling its framework control down
 *   · a control with no CIS check behind it counted as compliant rather than
 *     as not-evaluated
 *   · an unknown framework id answering with something rather than nothing
 *
 * NOT asserted here, deliberately: what `evaluateFramework` does with an EMPTY
 * findings list. It currently returns 100% compliant, which cannot distinguish
 * "the scan ran and everything passed" from "the scan never ran". That is a
 * real gap, reported separately — a canary that asserted the current behaviour
 * would cement it, and one that asserted the correct behaviour would be red on
 * the day it shipped. Neither is what a canary is for.
 */

import { evaluateFramework, getFrameworkList } from "../../tools/compliance-frameworks.js";

const FAIL = (id) => ({ id, status: "FAIL" });

export default [
  {
    id: "every-framework-is-still-mapped",
    kind: "pure",
    title: "All five frameworks are present and carry controls",
    why: "A framework that silently loses its control map evaluates against nothing and scores 100%. An auditor is shown that number.",
    run: async () => {
      const list = getFrameworkList();
      return {
        ids: list.map((f) => f.id),
        emptyFrameworks: list.filter((f) => !f.controlCount).map((f) => f.id),
        count: list.length,
      };
    },
    expect: [
      { path: "count", assert: "atLeast", value: 5 },
      { path: "ids", assert: "contains", value: "pci-dss" },
      { path: "ids", assert: "contains", value: "nist-800-53" },
      { path: "emptyFrameworks", assert: "equals", value: [], note: "A framework with no controls scores a perfect result against nothing." },
    ],
  },

  {
    id: "a-failed-cis-check-pulls-its-control-down",
    kind: "pure",
    title: "A failing CIS check is reflected in the framework control it maps to",
    why: "This is the whole mechanism. If the mapping breaks, the cluster's real failures stop reaching the compliance score and the customer presents a clean report for a cluster that is not.",
    run: async () => {
      const fw = getFrameworkList()[0].id;
      const clean = evaluateFramework(fw, []);
      // Fail every CIS check this framework's controls reference.
      const referenced = [...new Set(clean.controls.flatMap((c) => c.cisChecks || []))];
      const dirty = evaluateFramework(fw, referenced.map(FAIL));
      return {
        framework: fw,
        referencedChecks: referenced.length,
        cleanScore: clean.score,
        dirtyScore: dirty.score,
        dropped: clean.score - dirty.score,
        dirtyNonCompliant: dirty.nonCompliantControls,
        __evidence: { read: referenced.length, expected: referenced.length, confidence: "high", concluded: true },
      };
    },
    expect: [
      { path: "referencedChecks", assert: "atLeast", value: 1 },
      { path: "dropped", assert: "atLeast", value: 1, note: "Failing every mapped check must lower the score. If it does not, the mapping is dead." },
      { path: "dirtyNonCompliant", assert: "atLeast", value: 1 },
    ],
  },

  {
    id: "a-control-with-no-checks-is-not-evaluated",
    kind: "pure",
    title: "A control with nothing mapped to it reports not-evaluated, not compliant",
    why: "A control nobody checked is not a control that passed. Counting it as compliant is how a framework score drifts upward as controls are added faster than the checks behind them.",
    run: async () => {
      const statuses = new Set();
      for (const f of getFrameworkList()) {
        const ev = evaluateFramework(f.id, []);
        for (const c of ev.controls) if ((c.cisChecks || []).length === 0) statuses.add(c.status);
      }
      return { statusesForUnmappedControls: [...statuses] };
    },
    expect: [
      { path: "statusesForUnmappedControls", assert: "excludes", value: "compliant",
        note: "An unmapped control must never read as compliant." },
    ],
  },

  {
    id: "an-unknown-framework-returns-nothing",
    kind: "pure",
    title: "An unknown framework id returns null rather than an empty pass",
    why: "A typo in a framework id must not produce a scoreable result. Returning an empty-but-valid object would render as a framework with no failures.",
    run: async () => {
      return { unknown: evaluateFramework("not-a-framework", [FAIL("CIS-5.2.1")]) };
    },
    expect: [
      { path: "unknown", assert: "equals", value: null },
    ],
  },
];
