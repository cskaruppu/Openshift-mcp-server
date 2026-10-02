/**
 * Does the malfunction detection actually detect anything?
 *
 * Every case here drives a detector into the state it exists to catch, because
 * a detector that has never been observed to fire is indistinguishable from one
 * that cannot. The specific failure each one guards against is named in the
 * test title, in the words somebody would use at 2am.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evidenceDensity, evidenceProfile, latencyVerdict, delegationVerdict, budgetVerdict,
} from "../../src/agents/health-signals.js";
import { runAgentCanary, runCase, validateCase, pluck, canaryFleet } from "../../src/agents/canary.js";
import { quarantineRecommendation } from "../../src/agents/quarantine.js";
import { assessAgent } from "../../src/agents/health-sweep.js";

// ── Evidence density: the signature failure ───────────────────────────────

test("an agent that concluded having read nothing is critical, not healthy", () => {
  // "Assessed 400 machines, found no blockers" — because vCenter returned
  // empty. The call did not throw, so the error rate is still 0%.
  const d = evidenceDensity({ read: 0, expected: 400, confidence: "medium", concluded: true,
    unread: ["every guest credential was rejected"] });
  assert.equal(d.state, "unsupported");
  assert.equal(d.severity, "critical");
  assert.match(d.detail, /did not throw/);
  assert.match(d.headline, /read nothing/);
});

test("high confidence over a third of the estate is flagged", () => {
  const d = evidenceDensity({ read: 3, expected: 10, confidence: "high", concluded: true });
  assert.equal(d.state, "unsupported");
  assert.equal(d.coverage, 0.3);
  assert.match(d.detail, /Confidence is capped by what was read/);
});

test("thin coverage is a warning, not a failure", () => {
  const d = evidenceDensity({ read: 4, expected: 10, confidence: "low", concluded: true });
  assert.equal(d.state, "thin");
  assert.equal(d.severity, "warning");
});

test("full coverage with matching confidence is sound", () => {
  const d = evidenceDensity({ read: 10, expected: 10, confidence: "medium", concluded: true });
  assert.equal(d.state, "sound");
  assert.equal(d.severity, null);
});

test("an agent that read nothing AND refused to conclude is behaving correctly", () => {
  // Refusing to answer on no evidence is the right behaviour and must not be
  // scored as the failure it is the opposite of.
  const d = evidenceDensity({ read: 0, expected: 5, confidence: "none", concluded: false });
  assert.notEqual(d.severity, "critical");
});

test("an empty estate is reported as empty, not as clean — unless it claimed a verdict", () => {
  const honest = evidenceDensity({ read: 0, expected: 0, confidence: "low", concluded: true });
  assert.equal(honest.state, "nothing-to-read");
  assert.equal(honest.severity, null);
  const dishonest = evidenceDensity({ read: 0, expected: 0, confidence: "high", concluded: true });
  assert.equal(dishonest.severity, "serious");
  assert.match(dishonest.detail, /not derived from anything/);
});

test("an uninstrumented operation is uninstrumented, never healthy", () => {
  const d = evidenceDensity(null);
  assert.equal(d.state, "uninstrumented");
  assert.equal(d.severity, null);
  assert.match(d.detail, /not the same as healthy/);
  assert.notEqual(d.state, "sound");
});

test("a quarter of operations answering on nothing makes the agent unsupported", () => {
  const rows = [
    ...Array.from({ length: 3 }, () => ({ read: 0, expected: 10, confidence: "medium", concluded: true })),
    ...Array.from({ length: 7 }, () => ({ read: 10, expected: 10, confidence: "medium", concluded: true })),
  ];
  const p = evidenceProfile(rows);
  assert.equal(p.state, "unsupported");
  assert.equal(p.unsupported, 3);
  assert.equal(p.unsupportedRate, 30);
});

test("a profile over uninstrumented rows says so rather than reporting health", () => {
  const p = evidenceProfile([{}, {}, {}]);
  assert.equal(p.instrumented, false);
  assert.equal(p.state, "uninstrumented");
});

// ── Latency: against itself, not a fixed number ───────────────────────────

test("an agent three times slower than its own baseline is caught", () => {
  const v = latencyVerdict({ recentMs: 9000, baselineMs: 3000, recentSamples: 20, baselineSamples: 50 });
  assert.equal(v.state, "severe-regression");
  assert.equal(v.severity, "serious");
  assert.match(v.headline, /3× slower/);
});

test("a sudden speed-up is suspicious, not celebrated", () => {
  // The usual cause is that less work is being done — a dependency returning
  // empty, a cache standing in for a read.
  const v = latencyVerdict({ recentMs: 200, baselineMs: 3000, recentSamples: 20, baselineSamples: 50 });
  assert.equal(v.state, "suspiciously-fast");
  assert.equal(v.severity, "warning");
  assert.match(v.detail, /less work was done/);
});

test("two slow calls are not a trend", () => {
  const v = latencyVerdict({ recentMs: 9000, baselineMs: 3000, recentSamples: 2, baselineSamples: 50 });
  assert.equal(v.state, "insufficient-data");
  assert.equal(v.severity, null);
  assert.match(v.detail, /not enough data rather than as no regression/);
});

test("no timing data is unknown, not steady", () => {
  const v = latencyVerdict({ recentSamples: 10, baselineSamples: 10 });
  assert.equal(v.state, "unknown");
  assert.notEqual(v.state, "steady");
});

test("normal variation is steady", () => {
  const v = latencyVerdict({ recentMs: 3200, baselineMs: 3000, recentSamples: 20, baselineSamples: 50 });
  assert.equal(v.state, "steady");
  assert.equal(v.severity, null);
});

// ── Delegation: declared since forever, enforced for the first time ───────

test("a delegation cycle is critical whatever the declared maximum", () => {
  const v = delegationVerdict(["a", "b", "a"], 10);
  assert.equal(v.state, "cycle");
  assert.equal(v.severity, "critical");
  assert.match(v.detail, /does not terminate on its own/);
});

test("a chain past its declared maximum is refused", () => {
  const v = delegationVerdict(["a", "b", "c", "d"], 2);
  assert.equal(v.state, "exceeded");
  assert.equal(v.severity, "critical");
  assert.match(v.headline, /past its declared maximum of 2/);
});

test("an undeclared maximum is reported as undeclared, not as permission", () => {
  const v = delegationVerdict(["a", "b", "c"], null);
  assert.equal(v.state, "undeclared");
  assert.equal(v.severity, null);
  assert.match(v.detail, /Declare governance.maxDelegationDepth/);
});

// ── Budget: declared since forever, enforced for the first time ───────────

test("a breached budget blocks only when the manifest asked for a block", () => {
  const blocking = budgetVerdict(1_200_000, 1_000_000, "block");
  assert.equal(blocking.state, "breached");
  assert.equal(blocking.severity, "critical");
  assert.equal(blocking.action, "block");

  const warning = budgetVerdict(1_200_000, 1_000_000, "warn");
  assert.equal(warning.state, "breached");
  assert.equal(warning.severity, "serious");
  assert.equal(warning.action, "warn");
  assert.match(warning.detail, /still running/);
});

test("an unrecognised breach action is treated as warn-only, never as enforcing", () => {
  const v = budgetVerdict(2e6, 1e6, "shout-loudly");
  assert.equal(v.action, "warn");
});

test("unattributed spend is unmeasured, not within budget", () => {
  const v = budgetVerdict(null, 1_000_000, "block");
  assert.equal(v.state, "unmeasured");
  assert.match(v.detail, /not as within budget/);
  assert.notEqual(v.state, "within-budget");
});

test("approaching the budget warns before it breaches", () => {
  const v = budgetVerdict(850_000, 1_000_000, "block");
  assert.equal(v.state, "approaching");
  assert.equal(v.severity, "warning");
});

// ── Canary: the only thing that can see a wrong answer ────────────────────

const okCase = (over = {}) => ({
  id: "c1", kind: "pure", title: "t", why: "because this invariant matters and here is the reason",
  run: async () => ({ grade: "A", items: ["x", "y"] }),
  expect: [{ path: "grade", assert: "equals", value: "A" }],
  ...over,
});

test("a case whose invariant broke fails and says what changed", async () => {
  const r = await runCase(okCase({ run: async () => ({ grade: "F" }) }), {});
  assert.equal(r.state, "fail");
  assert.match(r.reason, /expected "A", got "F"/);
});

test("a case that throws is an error, not a pass and not a skip", async () => {
  const r = await runCase(okCase({ run: async () => { throw new Error("vCenter unreachable"); } }), {});
  assert.equal(r.state, "error");
  assert.match(r.reason, /vCenter unreachable/);
});

test("a case needing a cluster SKIPS when there is none, and a skip is not a pass", async () => {
  const r = await runCase(okCase({ kind: "read-only" }), { clusterReachable: false });
  assert.equal(r.state, "skip");
  assert.match(r.reason, /not a pass/);
});

test("a case needing a model SKIPS when none is configured", async () => {
  const r = await runCase(okCase({ kind: "llm" }), { llmConfigured: false });
  assert.equal(r.state, "skip");
  assert.match(r.reason, /model drift cannot be detected/);
});

test("a run made entirely of skips is inconclusive, never a pass", async () => {
  const r = await runAgentCanary("x", [okCase({ kind: "read-only" }), okCase({ id: "c2", kind: "llm" })],
    { clusterReachable: false, llmConfigured: false });
  assert.equal(r.verdict, "inconclusive");
  assert.notEqual(r.verdict, "pass");
  assert.match(r.headline, /unverified, not verified/);
});

test("a canary that would mutate something is refused before it runs", () => {
  const errs = validateCase(okCase({ mutates: true }), "a");
  assert.ok(errs.some((e) => /may never mutate/.test(e)));
});

test("a case with no stated reason is refused, because nobody could interpret its failure", () => {
  const errs = validateCase(okCase({ why: undefined }), "a");
  assert.ok(errs.some((e) => /why its invariant matters/.test(e)));
});

test("an invalid canary is reported as invalid, not quietly skipped", async () => {
  const r = await runAgentCanary("a", [okCase({ kind: "writes-things" })], {});
  assert.equal(r.verdict, "invalid");
  assert.match(r.headline, /not valid/);
});

test("assertions cover the shapes an invariant is written in", async () => {
  const c = okCase({
    run: async () => ({ n: 7, list: ["alpha", "beta"], text: "grade A overall", missing: null }),
    expect: [
      { path: "n", assert: "atLeast", value: 5 },
      { path: "n", assert: "atMost", value: 10 },
      { path: "list", assert: "contains", value: "alpha" },
      { path: "list", assert: "excludes", value: "gamma" },
      { path: "text", assert: "matches", value: "grade [A-F]" },
      { path: "n", assert: "oneOf", value: [6, 7, 8] },
      { path: "list[1]", assert: "equals", value: "beta" },
      { path: "n", assert: "isSet" },
    ],
  });
  const r = await runCase(c, {});
  assert.equal(r.state, "pass", r.reason || "");
});

test("pluck reaches into nested results without throwing", () => {
  const o = { a: { b: [{ c: 1 }] } };
  assert.equal(pluck(o, "a.b[0].c"), 1);
  assert.equal(pluck(o, "a.nope.deep"), undefined);
  assert.equal(pluck(o, "a.b[9].c"), undefined);
});

test("the fleet roll-up says plainly when nothing is checked at all", () => {
  assert.match(canaryFleet([]).headline, /Nothing here is checking whether any answer is right/);
});

// ── The real canaries ─────────────────────────────────────────────────────

test("every shipped canary definition is valid and its cases hold", async () => {
  const { loadCanaries } = await import("../../src/agents/canary-store.js");
  const { byAgent, errors } = await loadCanaries({ reload: true });
  assert.deepEqual(errors, [], "a canary that cannot load is a detector that is off");
  assert.ok(byAgent.size >= 3, `expected canaries for several agents, got ${byAgent.size}`);
  for (const [agentId, cases] of byAgent) {
    const r = await runAgentCanary(agentId, cases, { clusterReachable: false, llmConfigured: false });
    assert.notEqual(r.verdict, "invalid", `${agentId}: ${r.headline}`);
    assert.notEqual(r.verdict, "fail", `${agentId}: ${r.headline}`);
  }
});

test("every agent in the registry has a canary", async () => {
  // Locked in deliberately. An agent added without one is an agent whose
  // answers nothing checks, and the gap is invisible precisely because every
  // other check still passes for it. Adding a file to src/agents/canaries/
  // named for the agent is the fix; this test is the reminder.
  const { getAgents } = await import("../../src/agents/registry.js");
  const { canaryCoverage } = await import("../../src/agents/canary-store.js");
  const agents = await getAgents();
  const cov = await canaryCoverage(agents.map((a) => a.id));
  assert.deepEqual(cov.uncovered, [], cov.note);
  assert.equal(cov.covered, cov.agents);
});

test("every canary case states a kind that cannot change anything", async () => {
  const { loadCanaries } = await import("../../src/agents/canary-store.js");
  const { byAgent } = await loadCanaries({ reload: true });
  for (const [agentId, cases] of byAgent) {
    for (const c of cases) {
      assert.ok(["pure", "read-only", "llm"].includes(c.kind), `${agentId}/${c.id}: kind "${c.kind}"`);
      assert.notEqual(c.mutates, true, `${agentId}/${c.id} declares that it mutates`);
      assert.ok(c.why && c.why.length > 40,
        `${agentId}/${c.id}: a failure nobody can interpret gets muted, so every case must say why it matters`);
    }
  }
});

// ── Quarantine: recommended automatically, applied by a person ────────────

test("one red canary run watches; two consecutive recommend quarantine", () => {
  const canary = { verdict: "fail", headline: "x", topFailure: { title: "t", reason: "r" } };
  const once = quarantineRecommendation({ canary, failing: { consecutiveFailures: 1, since: "t0" } });
  assert.equal(once.recommend, false);
  assert.match(once.detail, /a second consecutive failure would recommend quarantine/i);

  const twice = quarantineRecommendation({ canary, failing: { consecutiveFailures: 2, since: "t0" } });
  assert.equal(twice.recommend, true);
  assert.equal(twice.reason, "canary-failed");
});

test("an agent calling an undeclared tool is recommended for quarantine at once", () => {
  const r = quarantineRecommendation({
    posture: { findings: [{ code: "undeclared-tools", severity: "critical", message: "Called delete_everything — not declared." }] },
  });
  assert.equal(r.recommend, true);
  assert.equal(r.reason, "undeclared-tools");
  assert.equal(r.severity, "critical");
});

test("a breached budget recommends quarantine only when the manifest asked for a block", () => {
  const block = quarantineRecommendation({ budget: budgetVerdict(2e6, 1e6, "block") });
  assert.equal(block.recommend, true);
  const warn = quarantineRecommendation({ budget: budgetVerdict(2e6, 1e6, "warn") });
  assert.equal(warn.recommend, false);
});

test("a healthy agent is not recommended for anything", () => {
  const r = quarantineRecommendation({ canary: { verdict: "pass" }, evidence: { state: "sound" } });
  assert.equal(r.recommend, false);
  assert.equal(r.reason, null);
});

// ── The assessment that ties them together ───────────────────────────────

const manifest = (over = {}) => ({ id: "test-agent", name: "Test Agent", governance: { egress: ["vcenter"] }, ...over });

test("an agent with no canary is reported as unchecked, not as healthy", async () => {
  const a = await assessAgent({ manifest: manifest(), posture: null, canary: null, signals: {} });
  assert.equal(a.state, "watch");
  assert.ok(a.findings.some((f) => f.code === "no-canary"));
  assert.notEqual(a.state, "healthy");
});

test("a failing canary makes the agent malfunctioning", async () => {
  const a = await assessAgent({
    manifest: manifest(),
    canary: { verdict: "fail", headline: "2 of 5 cases no longer hold", ranAt: "t",
      topFailure: { title: "unread machines are candidates", reason: "expected 0, got 12", why: "it inflates the candidate rate" } },
    signals: {},
  });
  assert.equal(a.state, "malfunctioning");
  const f = a.findings.find((x) => x.code === "canary-failed");
  assert.equal(f.severity, "critical");
  assert.match(f.detail, /Why this matters/);
});

test("egress to a host the manifest never declared is critical", async () => {
  const a = await assessAgent({
    manifest: manifest({ governance: { egress: ["vcenter.lab.local"] } }),
    canary: { verdict: "pass", headline: "ok", ranAt: "t" },
    signals: { egress: ["vcenter.lab.local", "evil.example.com"], evidence: [] },
  });
  const f = a.findings.find((x) => x.code === "undeclared-egress");
  assert.ok(f, "this finding has existed since governance.js was written and could never fire before");
  assert.equal(f.severity, "critical");
  assert.match(f.message, /evil.example.com/);
  assert.equal(a.state, "malfunctioning");
  assert.equal(a.recommendation.recommend, true);
});

test("declared egress does not fire the detector", async () => {
  const a = await assessAgent({
    manifest: manifest({ governance: { egress: ["vcenter.lab.local"] } }),
    canary: { verdict: "pass", headline: "ok", ranAt: "t" },
    signals: { egress: ["vcenter.lab.local"], evidence: [] },
  });
  assert.ok(!a.findings.some((x) => x.code === "undeclared-egress"));
});

test("unrecorded egress is not treated as 'contacted nothing'", async () => {
  const a = await assessAgent({
    manifest: manifest(), canary: { verdict: "pass", headline: "ok", ranAt: "t" },
    signals: { egress: null, evidence: [] },
  });
  assert.deepEqual(a.egress.observed, null);
  assert.deepEqual(a.egress.undeclared, []);
});

test("an agent answering repeatedly on nothing is malfunctioning even with a green canary", async () => {
  const a = await assessAgent({
    manifest: manifest(),
    canary: { verdict: "pass", headline: "5 cases hold", ranAt: "t" },
    signals: { evidence: Array.from({ length: 8 }, () => ({ read: 0, expected: 50, confidence: "medium", concluded: true })) },
  });
  assert.equal(a.state, "malfunctioning");
  assert.ok(a.findings.some((f) => f.code === "evidence-unsupported"));
  assert.equal(a.recommendation.recommend, true);
  assert.equal(a.recommendation.reason, "evidence-unsupported");
});

test("a fully healthy agent reads as healthy with no findings", async () => {
  const a = await assessAgent({
    manifest: manifest({ governance: { egress: ["vcenter"] } }),
    canary: { verdict: "pass", headline: "5 case(s) hold.", ranAt: "t" },
    signals: {
      egress: ["vcenter"],
      evidence: Array.from({ length: 5 }, () => ({ read: 10, expected: 10, confidence: "medium", concluded: true })),
      recent: { samples: 20, avgMs: 1000 }, baseline: { samples: 40, avgMs: 980 },
    },
  });
  assert.equal(a.state, "healthy");
  assert.deepEqual(a.findings, []);
  assert.match(a.headline, /Answering correctly/);
});
