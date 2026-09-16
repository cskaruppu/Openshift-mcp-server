import { test } from "node:test";
import assert from "node:assert/strict";
import { agentPosture, LIFECYCLE, DEFAULT_LIFECYCLE } from "../../src/agents/governance.js";
import { requestPromotion, decidePromotion, getPromotion, effectiveLifecycle, _clearMemory } from "../../src/agents/promotion.js";
import { getAgents } from "../../src/agents/registry.js";
import { buildManifest } from "../../src/agents/scaffold.js";

const NOW = Date.parse("2026-09-16T00:00:00Z");
const declared = (over = {}) => ({
  id: "probe", name: "Probe", tools: ["a"],
  governance: { owner: "s.menon", trustTier: "first-party", blastRadius: "read-only",
    autonomyLevel: "advisory", ...over },
});

// ══ Grandfathering — the thing that must not break production ══════════════
test("an agent that says nothing about lifecycle is active, not on probation", () => {
  const p = agentPosture({ id: "old", tools: ["a"] }, null, NOW);
  assert.equal(p.lifecycle, "active");
  assert.equal(DEFAULT_LIFECYCLE, "active");
  assert.equal(p.selectable, true, "silence must not take a working agent out of circulation");
});

test("none of the sixteen shipped agents is pushed onto probation", async () => {
  for (const a of await getAgents()) {
    const p = agentPosture(a, null, NOW);
    assert.notEqual(p.lifecycle, "experimental",
      `${a.id} would have been taken out of circulation by this change`);
    assert.equal(p.selectable, a.selectable !== false);
  }
});

test("an unrecognised lifecycle is treated as probation, not as active", () => {
  const p = agentPosture(declared({ lifecycle: "ready-ish" }), null, NOW);
  assert.equal(p.lifecycle, "experimental", "an unknown value must not be trusted into circulation");
});

// ══ Probation ═════════════════════════════════════════════════════════════
test("an experimental agent is out of general circulation", () => {
  const p = agentPosture(declared({ lifecycle: "experimental" }), null, NOW);
  assert.equal(p.selectable, false);
  assert.equal(p.promotable, true);
});

test("a new agent from the scaffold starts on probation and unselectable", () => {
  const m = buildManifest({ id: "fresh", name: "Fresh", description: "d", tools: ["a"] });
  assert.equal(m.governance.lifecycle, "experimental");
  assert.ok(m.governance.lifecycleSince, "probation needs a start date or it cannot go stale");
  assert.equal(m.selectable, false);
});

test("probation that never ends is flagged", () => {
  const p = agentPosture(declared({ lifecycle: "experimental", lifecycleSince: "2026-01-01" }), null, NOW);
  assert.ok(p.findings.some((f) => f.code === "stale-probation"),
    "an agent experimental for most of a year is a production dependency nobody reviewed");
});

test("deprecated without a sunset date is called out", () => {
  const p = agentPosture(declared({ lifecycle: "deprecated" }), null, NOW);
  const f = p.findings.find((x) => x.code === "deprecated");
  assert.match(f.message, /no retirement date/);
});

// ══ Promotion ═════════════════════════════════════════════════════════════
const readyPosture = () => agentPosture(declared({ lifecycle: "experimental" }), null, NOW);

test("an agent that is not on probation cannot be promoted", async () => {
  _clearMemory();
  const r = await requestPromotion("probe", { posture: agentPosture(declared(), null, NOW), actor: "a" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not on probation/);
});

test("an unowned or undeclared agent is refused, and told why", async () => {
  _clearMemory();
  const bare = agentPosture({ id: "probe", tools: ["a"], governance: { lifecycle: "experimental" } }, null, NOW);
  const r = await requestPromotion("probe", { posture: bare, actor: "a" });
  assert.equal(r.ok, false);
  assert.equal(r.notReady, true);
  assert.ok(r.blockers.length >= 3, "owner, blast radius, trust and autonomy are all missing");
  assert.match(r.blockers[0], /accountability/);
});

test("a critical finding blocks promotion outright", async () => {
  _clearMemory();
  const drifting = agentPosture(declared({ lifecycle: "experimental" }),
    { tools: ["never_declared"] }, NOW);
  const r = await requestPromotion("probe", { posture: drifting, actor: "a" });
  assert.equal(r.ok, false);
  assert.match(r.error, /never_declared/);
});

test("a promotion cannot be approved by the person who asked for it", async () => {
  _clearMemory();
  await requestPromotion("probe", { posture: readyPosture(), actor: "s.menon" });
  const self = await decidePromotion("probe", { decision: "approved", approver: "s.menon" });
  assert.equal(self.ok, false);
  assert.match(self.error, /cannot be approved by the person who requested/);
});

test("an approved promotion moves the agent off probation and certifies it", async () => {
  _clearMemory();
  await requestPromotion("probe", { posture: readyPosture(), actor: "s.menon" });
  const d = await decidePromotion("probe", { decision: "approved", approver: "p.raghavan" });
  assert.equal(d.ok, true);

  const p = agentPosture(declared({ lifecycle: "experimental" }), null, NOW, { promotion: await getPromotion("probe") });
  assert.equal(p.lifecycle, "active");
  assert.equal(p.lifecycleSource, "promoted", "the manifest still says experimental, and the panel must say so");
  assert.equal(p.declaredLifecycle, "experimental");
  assert.equal(p.selectable, true);
  assert.equal(p.certification.state, "current");
});

test("a rejected promotion leaves the agent exactly where it was", async () => {
  _clearMemory();
  await requestPromotion("probe", { posture: readyPosture(), actor: "s.menon" });
  await decidePromotion("probe", { decision: "rejected", approver: "p.raghavan" });
  const p = agentPosture(declared({ lifecycle: "experimental" }), null, NOW, { promotion: await getPromotion("probe") });
  assert.equal(p.lifecycle, "experimental", "rejection must fail safe, toward less access");
  assert.equal(p.selectable, false);
});

test("the evidence is frozen at the moment of asking", async () => {
  _clearMemory();
  const card = { score: 71, grade: "C", coverage: { ran: 7, total: 10 }, confidence: "partial", checks: [] };
  await requestPromotion("probe", { posture: readyPosture(), scorecard: card, actor: "s.menon" });
  const rec = await getPromotion("probe");
  assert.equal(rec.evidence.score, 71);
  assert.equal(rec.evidence.grade, "C");
});

test("asking twice does not raise a second request", async () => {
  _clearMemory();
  await requestPromotion("probe", { posture: readyPosture(), actor: "s.menon" });
  const again = await requestPromotion("probe", { posture: readyPosture(), actor: "s.menon" });
  assert.equal(again.alreadyRequested, true);
});

test("effectiveLifecycle only ever promotes on an approval", () => {
  assert.equal(effectiveLifecycle("experimental", { state: "approved" }), "active");
  assert.equal(effectiveLifecycle("experimental", { state: "pending" }), "experimental");
  assert.equal(effectiveLifecycle("experimental", null), "experimental");
  assert.equal(effectiveLifecycle("deprecated", { state: "approved" }), "deprecated",
    "an approval must not resurrect a deprecated agent");
});

test("every lifecycle value the posture can emit is a known one", () => {
  for (const l of [...LIFECYCLE, undefined, "nonsense"]) {
    const p = agentPosture(declared(l ? { lifecycle: l } : {}), null, NOW);
    assert.ok(LIFECYCLE.includes(p.lifecycle), `emitted "${p.lifecycle}" for input "${l}"`);
  }
});
