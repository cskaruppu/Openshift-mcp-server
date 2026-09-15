import { test } from "node:test";
import assert from "node:assert/strict";
import { agentPosture, fleetPosture } from "../../src/agents/governance.js";

const NOW = Date.parse("2026-09-15T00:00:00Z");
const full = (over = {}) => ({
  id: "a1", name: "Agent One", tools: ["t1", "t2"],
  governance: {
    owner: "S. Menon", trustTier: "first-party", blastRadius: "mutating",
    autonomyLevel: "propose-and-wait",
    certifiedAt: "2026-08-01T00:00:00Z", recertifyBy: "2027-08-01T00:00:00Z",
    ...over,
  },
});

// ── The rule the whole module exists to hold ─────────────────────────────
test("an agent that declares nothing is unreviewed, never governed", () => {
  const p = agentPosture({ id: "bare", tools: ["x"] }, null, NOW);
  assert.equal(p.verdict, "unreviewed");
  assert.notEqual(p.verdict, "governed");
  assert.equal(p.owner, null);
  assert.match(p.next, /No owner is declared/);
});

test("missing fields are null, never a reassuring default", () => {
  const p = agentPosture({ id: "bare" }, null, NOW);
  for (const k of ["owner", "trustTier", "blastRadius", "autonomy"]) {
    assert.equal(p[k], null, `${k} must be null, not defaulted`);
  }
  assert.equal(p.certification.state, "never");
});

test("a bogus enum value is rejected rather than trusted", () => {
  const p = agentPosture(full({ blastRadius: "mostly-harmless", trustTier: "probably-fine" }), null, NOW);
  assert.equal(p.blastRadius, null);
  assert.equal(p.trustTier, null);
  assert.equal(p.verdict, "unreviewed");
});

test("declaring everything and certifying currently yields governed", () => {
  const p = agentPosture(full(), null, NOW);
  assert.equal(p.verdict, "governed");
  assert.equal(p.findings.length, 0);
  assert.equal(p.certification.state, "current");
});

// ── Observed vs declared ─────────────────────────────────────────────────
test("a tool called but never declared is critical, and names the tool", () => {
  const p = agentPosture(full(), { tools: ["t1", "cluster_node_list"] }, NOW);
  assert.equal(p.verdict, "action-required");
  assert.equal(p.findings[0].code, "undeclared-tools");
  assert.deepEqual(p.observed.undeclaredTools, ["cluster_node_list"]);
  assert.equal(p.reconciled, false);
});

test("undeclared egress outranks an undeclared tool", () => {
  const p = agentPosture(full(), { tools: ["nope"], egress: ["api.vendor.io"] }, NOW);
  assert.equal(p.findings[0].code, "undeclared-egress");
});

test("nothing observed leaves reconciled null — not true", () => {
  const p = agentPosture(full(), null, NOW);
  assert.equal(p.reconciled, null, "unobserved must not read as clean");
});

test("behaving inside the declaration reconciles", () => {
  const p = agentPosture(full(), { tools: ["t1"], egress: [] }, NOW);
  assert.equal(p.reconciled, true);
  assert.equal(p.verdict, "governed");
});

// ── The combination worth refusing ───────────────────────────────────────
test("an external agent that mutates the estate is critical", () => {
  const p = agentPosture(full({ trustTier: "external", blastRadius: "irreversible" }), null, NOW);
  assert.equal(p.verdict, "action-required");
  assert.ok(p.findings.some((f) => f.code === "external-mutating"));
});

test("an external read-only agent is not flagged for being external alone", () => {
  const p = agentPosture(full({ trustTier: "external", blastRadius: "read-only" }), null, NOW);
  assert.ok(!p.findings.some((f) => f.code === "external-mutating"));
});

// ── Certification is a claim with a date ─────────────────────────────────
test("certification without an expiry is not treated as permanent", () => {
  const p = agentPosture(full({ recertifyBy: null }), null, NOW);
  assert.equal(p.certification.state, "no-expiry");
  assert.notEqual(p.verdict, "governed");
});

test("a lapsed certification is serious and counts the days", () => {
  const p = agentPosture(full({ recertifyBy: "2026-09-01T00:00:00Z" }), null, NOW);
  assert.equal(p.certification.state, "expired");
  assert.ok(p.findings.some((f) => f.code === "certification-expired"));
});

test("expiring within 30 days warns before it lapses", () => {
  const p = agentPosture(full({ recertifyBy: "2026-09-25T00:00:00Z" }), null, NOW);
  assert.equal(p.certification.state, "expiring");
  assert.equal(p.certification.expiresInDays, 10);
  assert.equal(p.verdict, "attention");
});

// ── Fleet ────────────────────────────────────────────────────────────────
test("a fleet nobody has reviewed says so plainly", () => {
  const f = fleetPosture([agentPosture({ id: "a" }, null, NOW), agentPosture({ id: "b" }, null, NOW)]);
  assert.equal(f.byVerdict.unreviewed, 2);
  assert.equal(f.unowned, 2);
  assert.equal(f.certified, 0);
  assert.match(f.headline, /No agent has been reviewed yet/);
});

test("the headline leads with the worst true thing", () => {
  const f = fleetPosture([
    agentPosture(full(), { tools: ["rogue"] }, NOW),
    agentPosture(full({ owner: "X" }), null, NOW),
  ]);
  assert.equal(f.byVerdict["action-required"], 1);
  assert.match(f.headline, /outside what they declared/);
});

test("counts never credit an unreviewed agent as certified", () => {
  const f = fleetPosture([agentPosture({ id: "a" }, null, NOW)]);
  assert.equal(f.certified, 0, "never-certified must not count toward certified");
});
