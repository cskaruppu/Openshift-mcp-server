import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateAllFrameworks } from "../../src/tools/compliance-frameworks.js";

const FAILS = [
  { id: "5.1.1", status: "FAIL", title: "Cluster-admin overused" },
  { id: "5.2.2", status: "FAIL", title: "Privileged containers" },
  { id: "5.3.2", status: "FAIL", title: "No network policies" },
];

/* The bug: the card read fw.compliant / fw.nonCompliant / fw.name while the
   evaluator returns compliantControls / nonCompliantControls / frameworkName.
   Every one was undefined, so `|| 0` rendered "0 compliant, 0 partial, 0
   non-compliant" on a card whose own rows showed real statuses — those read
   fw.controls[].status, which did match. */

test("the header counts equal the statuses of the rows beneath them", () => {
  for (const fw of evaluateAllFrameworks(FAILS)) {
    const rows = fw.controls.reduce((a, c) => { a[c.status] = (a[c.status] || 0) + 1; return a; }, {});
    assert.equal(fw.compliantControls, rows.compliant || 0, `${fw.frameworkName} compliant`);
    assert.equal(fw.partialControls, rows.partial || 0, `${fw.frameworkName} partial`);
    assert.equal(fw.nonCompliantControls, rows["non-compliant"] || 0, `${fw.frameworkName} non-compliant`);
  }
});

test("every framework carries a name and a description", () => {
  for (const fw of evaluateAllFrameworks(FAILS)) {
    assert.ok(fw.frameworkName, "a card with no name renders a blank line");
    assert.ok(fw.frameworkDescription, `${fw.frameworkId} has no description`);
  }
});

// The mapping is the join between the two names. If a field is added to the
// evaluator and not mapped, it silently renders as undefined — which is exactly
// how this shipped.
test("the view maps every field it reads off a framework", () => {
  const UI = readFileSync("console/src/views/AuditView.jsx", "utf8");
  const mapped = UI.slice(UI.indexOf("const frameworks = useMemo"));
  const block = mapped.slice(0, mapped.indexOf("})), [fwSummary]);"));
  for (const key of ["id:", "name:", "description:", "compliant:", "partial:", "nonCompliant:"]) {
    assert.ok(block.includes(key), `the mapping is missing ${key}`);
  }
  // And it must not go back to reading the server names directly.
  assert.match(block, /r\.frameworkName/);
  assert.match(block, /r\.compliantControls/);
  assert.match(block, /r\.nonCompliantControls/);
});

test("a framework with no failures reports fully compliant, not zero", () => {
  const clean = evaluateAllFrameworks([]);
  for (const fw of clean) {
    const evaluated = fw.controls.filter((c) => c.status !== "not-evaluated").length;
    assert.equal(fw.compliantControls, evaluated,
      `${fw.frameworkName}: no failures must read as compliant, not as nothing counted`);
  }
});
