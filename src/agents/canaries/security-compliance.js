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
 *   · AN UNSCANNED CLUSTER SCORING 100%. This one was a live defect, found
 *     while writing this file: the scanner reports failures, so an empty
 *     finding list meant either "nothing is wrong" or "nobody looked", and the
 *     evaluator read both as the first. Every framework scored a perfect A on a
 *     cluster that had never been scanned. It is fixed, and the case below is
 *     what stops it coming back — which is exactly what a canary is for.
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
      // The baseline must be a scan that RAN and found nothing — an empty
      // finding list on its own is now correctly "unscanned" and carries no
      // score to compare against.
      const clean = evaluateFramework(fw, [], { scanned: true });
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
    id: "an-unscanned-cluster-has-no-compliance-score",
    kind: "pure",
    title: "A cluster that was never scanned scores nothing, not 100%",
    why: "This was a real defect. The CIS scanner reports failures, so an empty finding list cannot be told apart from a cluster nobody scanned — and the evaluator read it as 'no failures, therefore compliant'. Every framework returned 100% and grade A before the first scan finished, or on a cluster the scanner could not read. Nothing threw. That number is the one a customer screenshots for an assessor, which makes it the most dangerous wrong answer in this agent.",
    run: async () => {
      const unscanned = getFrameworkList().map((f) => evaluateFramework(f.id, [], { scanned: false }));
      const inferred = evaluateFramework("pci-dss", []);          // caller said nothing
      const reallyClean = evaluateFramework("pci-dss", [], { scanned: true });
      return {
        scores: unscanned.map((r) => r.score),
        grades: [...new Set(unscanned.map((r) => r.grade))],
        anyScored: unscanned.some((r) => typeof r.score === "number"),
        inferredScore: inferred.score,
        // The distinction that makes the fix correct rather than merely safe:
        // a scan that truly ran and found nothing wrong still earns its 100.
        scannedCleanScore: reallyClean.score,
        __evidence: { read: 0, expected: 1, confidence: "high", concluded: true, unread: ["no CIS scan result"] },
      };
    },
    expect: [
      { path: "anyScored", assert: "equals", value: false, note: "Not 100. Not 0. No number at all." },
      { path: "grades", assert: "equals", value: ["—"] },
      { path: "inferredScore", assert: "equals", value: null, note: "With no signal from the caller, 'cannot tell' must not resolve to compliant." },
      { path: "scannedCleanScore", assert: "equals", value: 100, note: "A scan that ran and found nothing wrong still earns its score — otherwise the fix would just be a different lie." },
    ],
  },

  {
    id: "a-cluster-that-could-not-be-read-scores-nothing",
    kind: "pure",
    title: "A scan that ran but read nothing scores nothing, not 100%",
    why: "The deeper half of the same defect, and the one that actually happens in production: the scan runs on schedule, the API is unreachable or RBAC is missing, every check reports WARN 'unable to retrieve', and there are no failures — so every framework scored a perfect A for a cluster nobody could read. A scan completing is not the same as a scan seeing anything.",
    run: async () => {
      // The shape the scanner really produces when it cannot reach the cluster:
      // one marker finding per category, every other control simply absent.
      const unreachable = [
        { id: "CIS-5.2.0", category: "pod-security", status: "WARN", unreadable: true },
        { id: "CIS-5.3.1", category: "network-security", status: "WARN", unreadable: true },
        { id: "CIS-5.1.1", category: "rbac-secrets", status: "WARN", unreadable: true },
        { id: "CIS-5.5.0", category: "image-security", status: "WARN", unreadable: true },
      ];
      const all = evaluateFramework && getFrameworkList().map((f) => evaluateFramework(f.id, unreachable, { scanned: true }));
      // A partial read must still score what it did read.
      const partial = evaluateFramework("soc2", [
        { id: "CIS-5.2.0", category: "pod-security", status: "WARN", unreadable: true },
        { id: "CIS-5.3.2", category: "network-security", status: "FAIL" },
      ]);
      return {
        anyScored: all.some((r) => typeof r.score === "number"),
        grades: [...new Set(all.map((r) => r.grade))],
        allNotEvaluated: all.every((r) => r.notEvaluatedControls === r.totalControls),
        partialScored: typeof partial.score === "number",
        partialNamesTheGap: /could not be read/.test(partial.note || ""),
        __evidence: { read: 0, expected: 4, confidence: "high", concluded: true, unread: ["every CIS category failed to read"] },
      };
    },
    expect: [
      { path: "anyScored", assert: "equals", value: false, note: "No framework may carry a number when nothing was read." },
      { path: "grades", assert: "equals", value: ["—"] },
      { path: "allNotEvaluated", assert: "equals", value: true,
        note: "An unreadable category takes every one of its controls with it, not just the one that reported the error." },
      { path: "partialScored", assert: "equals", value: true,
        note: "A partial read is still worth scoring — refusing to score anything would be a different kind of useless." },
      { path: "partialNamesTheGap", assert: "equals", value: true },
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
