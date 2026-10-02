/**
 * Framework scoring, and the ambiguity it used to resolve the wrong way.
 *
 * The CIS scanner reports FAILURES — a check that ran and passed produces no
 * finding — so an empty finding list means either "the scan ran and nothing is
 * wrong" or "no scan has ever run". Those are opposite facts arriving
 * identically, and the evaluator used to read both as the first: every control
 * absent from an empty failure list counted as compliant, so every framework
 * scored 100% with grade A.
 *
 * A customer opening the Audit tab before the first scan finished, or on a
 * cluster the scanner could not read, was shown perfect SOC 2, PCI-DSS and
 * HIPAA compliance. Nothing threw. Nothing was logged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFramework, evaluateAllFrameworks, getFrameworkList,
} from "../../src/tools/compliance-frameworks.js";

const FAIL = (id) => ({ id, status: "FAIL" });
const FRAMEWORKS = getFrameworkList().map((f) => f.id);

// ── The bug ───────────────────────────────────────────────────────────────

test("no scan means no score — not 100%", () => {
  for (const id of FRAMEWORKS) {
    const r = evaluateFramework(id, [], { scanned: false });
    assert.equal(r.score, null, `${id} scored ${r.score} having never been scanned`);
    assert.equal(r.grade, "—", `${id} graded ${r.grade}`);
    assert.equal(r.scanned, false);
    assert.equal(r.compliantControls, 0, `${id} counted controls compliant with nothing to read`);
  }
});

test("no scan means no score — not 0 either", () => {
  // Zero is a score. It says "this cluster fails everything", which is a claim
  // about the cluster. Null says nothing was measured.
  const r = evaluateFramework("pci-dss", [], { scanned: false });
  assert.notEqual(r.score, 0);
  assert.equal(r.score, null);
});

test("every control is reported as not-evaluated when nothing was read", () => {
  const r = evaluateFramework("soc2", [], { scanned: false });
  assert.ok(r.controls.length > 0);
  for (const c of r.controls) assert.equal(c.status, "not-evaluated");
  assert.equal(r.notEvaluatedControls, r.totalControls);
});

test("the result says plainly that it is not a compliance score", () => {
  const r = evaluateFramework("hipaa", [], { scanned: false });
  assert.match(r.note, /not a compliance score/i);
});

test("an empty finding list with no caller signal is treated as unscanned", () => {
  // The honest default: "cannot tell" must never resolve to 100%.
  const r = evaluateFramework("pci-dss", []);
  assert.equal(r.scanned, false);
  assert.equal(r.score, null);
});

test("a non-array findings value is unscanned, not an empty pass", () => {
  for (const bad of [null, undefined, "oops", 42, {}]) {
    const r = evaluateFramework("pci-dss", bad);
    assert.equal(r.score, null, `findings=${JSON.stringify(bad)} scored ${r.score}`);
  }
});

// ── What must still work ─────────────────────────────────────────────────

test("a scan that ran and found nothing wrong DOES score 100", () => {
  // The distinction is the whole point: this is a real, earned 100.
  const r = evaluateFramework("pci-dss", [], { scanned: true, scanTime: "2026-10-02T00:00:00Z" });
  assert.equal(r.scanned, true);
  assert.equal(r.score, 100);
  assert.equal(r.grade, "A");
  assert.equal(r.scanTime, "2026-10-02T00:00:00Z");
});

test("failures still pull the score down", () => {
  const clean = evaluateFramework("pci-dss", [], { scanned: true });
  const referenced = [...new Set(clean.controls.flatMap((c) => c.cisChecks || []))];
  const dirty = evaluateFramework("pci-dss", referenced.map(FAIL));
  assert.ok(dirty.score < clean.score, `clean ${clean.score} vs dirty ${dirty.score}`);
  assert.equal(dirty.scanned, true, "findings present implies a scan ran");
});

test("findings present means a scan ran, without the caller having to say so", () => {
  const r = evaluateFramework("soc2", [FAIL("CIS-5.2.1")]);
  assert.equal(r.scanned, true);
  assert.equal(typeof r.score, "number");
});

test("an unknown framework still returns null", () => {
  assert.equal(evaluateFramework("not-a-framework", [FAIL("CIS-5.2.1")]), null);
  assert.equal(evaluateFramework("not-a-framework", [], { scanned: false }), null);
});

// ── The denominator ──────────────────────────────────────────────────────

test("the score covers the controls that could be evaluated, and says how many could not", () => {
  const r = evaluateFramework("pci-dss", [FAIL("CIS-5.2.1")]);
  assert.equal(r.evaluatedControls + r.notEvaluatedControls, r.totalControls);
  if (r.notEvaluatedControls > 0) {
    assert.match(r.note, /were not evaluated/);
  }
  // Whatever the split, the counted buckets must add up to what was evaluated.
  assert.equal(
    r.compliantControls + r.partialControls + r.nonCompliantControls,
    r.evaluatedControls
  );
});

test("a control with no CIS check mapped is never counted as compliant", () => {
  for (const id of FRAMEWORKS) {
    const r = evaluateFramework(id, [FAIL("CIS-5.2.1")]);
    for (const c of r.controls) {
      if ((c.cisChecks || []).length === 0) {
        assert.equal(c.status, "not-evaluated", `${id}/${c.controlId}`);
      }
    }
  }
});

// ── The deeper half: a scan that RAN but could read nothing ──────────────
//
// The first fix stopped an unscanned cluster scoring 100. This is the case that
// actually happens in production: the scan runs on schedule, the API is
// unreachable or RBAC is missing, and every check reports WARN "unable to
// retrieve". No FAILs, so every framework scored a perfect A on a cluster
// nobody could read. It is the same bug one layer down.

/** What the scanner really produces when it cannot reach the cluster. */
const UNREACHABLE = [
  { id: "CIS-5.2.0", category: "pod-security", status: "WARN", unreadable: true },
  { id: "CIS-5.3.1", category: "network-security", status: "WARN", unreadable: true },
  { id: "CIS-5.1.1", category: "rbac-secrets", status: "WARN", unreadable: true },
  { id: "CIS-5.5.0", category: "image-security", status: "WARN", unreadable: true },
];

test("a scan that ran but read nothing scores nothing", () => {
  for (const r of evaluateAllFrameworks(UNREACHABLE, { scanned: true })) {
    assert.equal(r.score, null, `${r.frameworkId} scored ${r.score} on a cluster it could not read`);
    assert.equal(r.grade, "—");
    assert.equal(r.compliantControls, 0);
    assert.equal(r.notEvaluatedControls, r.totalControls);
  }
});

test("an unreadable category takes all of its checks with it, not just the one it reported", () => {
  // The scanner emits ONE marker finding per failed category. Every other
  // control in that category is simply absent from the findings — and absent is
  // exactly what used to count as a pass.
  const r = evaluateFramework("soc2", [{ id: "CIS-5.2.0", category: "pod-security", status: "WARN", unreadable: true }]);
  const podControls = r.controls.filter((c) => (c.cisChecks || []).some((id) => id.startsWith("CIS-5.2.")));
  assert.ok(podControls.length > 0, "soc2 must map some pod-security checks");
  for (const c of podControls) {
    assert.ok(c.unreadCount > 0, `${c.controlId} credited an unread pod-security check as passed`);
  }
});

test("a partial read scores what was read and names what was not", () => {
  const r = evaluateFramework("soc2", [
    { id: "CIS-5.2.0", category: "pod-security", status: "WARN", unreadable: true },
    { id: "CIS-5.3.2", category: "network-security", status: "FAIL" },
  ]);
  assert.equal(typeof r.score, "number", "a partial read is still worth scoring");
  assert.ok(r.notEvaluatedControls > 0);
  assert.match(r.note, /could not be read on this cluster/);
  assert.equal(r.compliantControls + r.partialControls + r.nonCompliantControls, r.evaluatedControls);
});

test("the note tells apart an unread check from an unmapped control", () => {
  // Different problems, different fixes: one is connectivity, the other is a
  // gap in the catalogue. Saying the wrong one sends somebody to the wrong file.
  const unread = evaluateFramework("soc2", [
    { id: "CIS-5.2.0", category: "pod-security", status: "WARN", unreadable: true },
    { id: "CIS-5.3.2", category: "network-security", status: "FAIL" },
  ]);
  assert.match(unread.note, /could not be read/);
  assert.doesNotMatch(unread.note, /no CIS check is mapped/);
});

test("a readable cluster with real failures is unaffected by any of this", () => {
  const r = evaluateFramework("soc2", [
    { id: "CIS-5.2.1", category: "pod-security", status: "FAIL" },
    { id: "CIS-5.3.2", category: "network-security", status: "FAIL" },
  ]);
  assert.equal(typeof r.score, "number");
  assert.ok(r.score < 100);
  assert.equal(r.notEvaluatedControls, 0);
  assert.equal(r.note, null);
});

// ── The whole set ────────────────────────────────────────────────────────

test("evaluateAllFrameworks carries the scanned signal to every framework", () => {
  const unscanned = evaluateAllFrameworks([], { scanned: false });
  assert.equal(unscanned.length, FRAMEWORKS.length);
  for (const r of unscanned) {
    assert.equal(r.score, null, `${r.frameworkId} scored ${r.score}`);
    assert.equal(r.scanned, false);
  }
  const scanned = evaluateAllFrameworks([], { scanned: true });
  for (const r of scanned) assert.equal(r.score, 100);
});

// ── The scanner's own score ──────────────────────────────────────────────

test("the CIS control catalogue maps every control to a category", async () => {
  // The framework evaluator asks this question for every check a control
  // references. A control that maps to nothing is one that can never be
  // detected as unread, and would silently go back to counting as a pass.
  const { categoryForControl } = await import("../../src/tools/compliance-scanner.js");
  const CONTROLS = [
    "CIS-5.1.1", "CIS-5.2.1", "CIS-5.2.2", "CIS-5.2.3", "CIS-5.2.4", "CIS-5.2.5",
    "CIS-5.3.1", "CIS-5.3.2", "CIS-5.3.3", "CIS-5.4.1", "CIS-5.5.1", "CIS-5.5.2",
  ];
  for (const id of CONTROLS) {
    assert.ok(categoryForControl(id), `${id} maps to no category`);
  }
  assert.equal(categoryForControl("not-a-control"), null);
  assert.equal(categoryForControl(null), null);
});
