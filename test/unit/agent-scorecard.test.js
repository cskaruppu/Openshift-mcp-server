import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAgent, scoreFleet, CHECKS } from "../../src/agents/scorecard.js";

const perfect = {
  owner: "s.menon", blastRadius: "read-only", trustTier: "first-party", autonomy: "advisory",
  certification: { state: "current" }, reconciled: true, missingTools: [],
  lastUsed: new Date().toISOString(), errorRate: 0, hasExamples: true,
};

test("an agent passing everything scores 100 with full confidence", () => {
  const s = scoreAgent(perfect);
  assert.equal(s.score, 100);
  assert.equal(s.grade, "A");
  assert.equal(s.confidence, "full");
  assert.equal(s.coverage.unknown, 0);
  assert.equal(s.topFix, null);
});

// ══ The rule the whole module turns on ════════════════════════════════════
test("a check that could not run scores nothing and is out of the denominator", () => {
  const s = scoreAgent({ ...perfect, reconciled: null, lastUsed: null, errorRate: null, missingTools: null });
  assert.equal(s.score, 100, "the checks that ran all passed");
  assert.equal(s.coverage.unknown, 4);
  assert.equal(s.coverage.ran, CHECKS.length - 4);
  assert.notEqual(s.confidence, "full", "a score over part of the checks is a weaker claim and must say so");
});

test("unknown is never counted as a pass", () => {
  const all = scoreAgent({});                       // nothing known at all
  const unknowns = all.checks.filter((c) => c.state === "unknown");
  assert.ok(unknowns.length > 0);
  for (const c of unknowns) {
    assert.notEqual(c.state, "pass");
    assert.match(c.detail, /could not be checked/);
  }
});

test("an agent where almost nothing could be checked reports low confidence", () => {
  const s = scoreAgent({
    owner: "x", blastRadius: "read-only",
    certification: { state: "never" },
    reconciled: null, lastUsed: null, errorRate: null, missingTools: null,
  });
  assert.ok(["low", "partial"].includes(s.confidence));
  assert.ok(s.coverage.unknown >= 4);
});

// ══ Grading and fixes ═════════════════════════════════════════════════════
test("an agent that works but declares nothing is D, not E", () => {
  // It runs, behaves inside its declaration and its tools exist — so it is
  // under-governed rather than unknown, and the grade distinguishes the two.
  const s = scoreAgent({ certification: { state: "never" }, missingTools: [], reconciled: true,
    lastUsed: new Date().toISOString(), errorRate: 0 });
  assert.equal(s.grade, "D");
  assert.equal(s.score, 38);
  assert.match(s.topFix, /Nobody is accountable/, "the heaviest failure is the one worth showing");
});

test("an agent with nothing known and nothing working grades E", () => {
  const s = scoreAgent({ certification: { state: "never" }, missingTools: ["a"], reconciled: false,
    lastUsed: "2020-01-01T00:00:00Z", errorRate: 90, hasExamples: false });
  assert.equal(s.grade, "E");
  assert.equal(s.score, 0);
});

test("every failing check carries a fix, not just a label", () => {
  const s = scoreAgent({ certification: { state: "never" }, missingTools: ["a", "b"], reconciled: false,
    lastUsed: "2020-01-01T00:00:00Z", errorRate: 40, hasExamples: false });
  for (const c of s.checks.filter((x) => x.state === "fail")) {
    assert.ok(c.detail && c.detail.length > 20, `${c.id} fails with no usable fix text`);
  }
});

test("certification with no expiry is not treated as certified", () => {
  const s = scoreAgent({ ...perfect, certification: { state: "no-expiry" } });
  const c = s.checks.find((x) => x.id === "certified");
  assert.equal(c.state, "fail");
  assert.match(c.detail, /never expires is not certification/);
});

test("declaring tools that are not served fails, and names them", () => {
  const s = scoreAgent({ ...perfect, missingTools: ["mtv_start_migration", "mtv_plan_status"] });
  const c = s.checks.find((x) => x.id === "tools-served");
  assert.equal(c.state, "fail");
  assert.match(c.detail, /mtv_start_migration/);
  assert.match(c.detail, /empty tool list/);
});

test("an unused agent is flagged, a recently used one is not", () => {
  const old = scoreAgent({ ...perfect, lastUsed: "2020-01-01T00:00:00Z" });
  assert.equal(old.checks.find((c) => c.id === "in-use").state, "fail");
  assert.equal(scoreAgent(perfect).checks.find((c) => c.id === "in-use").state, "pass");
});

test("weights encode consequence — owner outranks examples", () => {
  const owner = CHECKS.find((c) => c.id === "owner").weight;
  const docs = CHECKS.find((c) => c.id === "documented").weight;
  assert.ok(owner > docs, "an unowned agent is a bigger problem than an undocumented one");
});

// ══ Fleet ═════════════════════════════════════════════════════════════════
test("the fleet view names the one fix that lifts the most agents", () => {
  const unowned = { certification: { state: "current" }, missingTools: [], reconciled: true,
    blastRadius: "read-only", trustTier: "first-party", autonomy: "advisory",
    lastUsed: new Date().toISOString(), errorRate: 0, hasExamples: true };
  const f = scoreFleet([scoreAgent(unowned), scoreAgent(unowned), scoreAgent(perfect)]);
  assert.equal(f.biggestWin.id, "owner");
  assert.equal(f.biggestWin.agents, 2);
  assert.match(f.headline, /accountable owner/);
});

test("an empty fleet says so rather than reporting zero health", () => {
  const f = scoreFleet([]);
  assert.equal(f.average, null);
  assert.match(f.headline, /No agent could be scored/);
});

test("a fleet passing everything says so without inventing a fix", () => {
  const f = scoreFleet([scoreAgent(perfect), scoreAgent(perfect)]);
  assert.equal(f.average, 100);
  assert.equal(f.biggestWin, null);
  assert.match(f.headline, /passes every check/);
});
