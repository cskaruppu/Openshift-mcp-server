import { test } from "node:test";
import assert from "node:assert/strict";
import { agentPosture, fleetPosture } from "../../src/agents/governance.js";
import { parseCodeowners, codeownersMatch, ownersFor, suggestOwner } from "../../src/agents/owner-hints.js";
import { claimOwner, releaseOwner, getOwnership, _clearMemory } from "../../src/services/agent-ownership.js";

const NOW = Date.parse("2026-09-15T00:00:00Z");
const bare = { id: "vm-migration", name: "VM Migration Agent", tools: ["t1"] };

// ══ The rule the whole feature turns on ═══════════════════════════════════
test("a suggestion is NOT an owner — the agent stays unowned", () => {
  const p = agentPosture(bare, null, NOW, {
    suggestion: { owner: "s.menon", from: "CODEOWNERS (.github/CODEOWNERS)", confidence: "high" },
  });
  assert.equal(p.owner, null, "a suggested name must never be promoted to owner");
  assert.equal(p.ownerSource, null);
  assert.equal(p.verdict, "unreviewed");
  assert.ok(p.findings.some((f) => f.code === "no-owner"));
  assert.equal(p.ownerSuggestion.owner, "s.menon", "but it is carried, so it can be offered");
});

test("a suggestion changes the wording, never the count", () => {
  const withHint = agentPosture(bare, null, NOW, { suggestion: { owner: "x", from: "git history" } });
  const without = agentPosture(bare, null, NOW);
  assert.match(withHint.findings[0].message, /suggested/);
  assert.equal(
    fleetPosture([withHint]).unowned,
    fleetPosture([without]).unowned,
    "a suggested agent is still an unowned agent",
  );
});

// ══ Precedence ════════════════════════════════════════════════════════════
test("a claim makes the agent owned and says it was claimed", () => {
  const p = agentPosture(bare, null, NOW, {
    claim: { owner: "s.menon", claimedBy: "s.menon", claimedAt: "2026-09-14T10:00:00Z", source: "self" },
  });
  assert.equal(p.owner, "s.menon");
  assert.equal(p.ownerSource, "claimed");
  assert.equal(p.claim.by, "s.menon");
  assert.ok(!p.findings.some((f) => f.code === "no-owner"));
});

test("a manifest declaration outranks a claim", () => {
  const declared = { ...bare, governance: { owner: "a.fernandes" } };
  const p = agentPosture(declared, null, NOW, { claim: { owner: "someone.else", claimedBy: "someone.else" } });
  assert.equal(p.owner, "a.fernandes");
  assert.equal(p.ownerSource, "manifest");
});

test("once owned, no suggestion is offered", () => {
  const p = agentPosture(bare, null, NOW, {
    claim: { owner: "s.menon", claimedBy: "s.menon" },
    suggestion: { owner: "someone.else", from: "git history" },
  });
  assert.equal(p.ownerSuggestion, null, "offering an alternative to an accepted owner is noise");
});

test("an owner alone does not make an agent governed", () => {
  const p = agentPosture(bare, null, NOW, { claim: { owner: "s.menon", claimedBy: "s.menon" } });
  assert.equal(p.verdict, "unreviewed", "blast radius, trust and autonomy are still undeclared");
});

// ══ CODEOWNERS parsing ════════════════════════════════════════════════════
test("comments and blank lines are ignored", () => {
  const r = parseCodeowners("# a comment\n\n  \n/src/ @team  # trailing\n");
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].owners, ["@team"]);
});

test("the LAST matching rule wins, as GitHub does it", () => {
  const rules = parseCodeowners("* @everyone\nsrc/agents/manifests/ @platform-team\n");
  assert.deepEqual(
    ownersFor(rules, "src/agents/manifests/vm-migration.json"),
    ["@platform-team"],
    "first-match-wins would attribute every agent to the catch-all rule",
  );
});

test("a catch-all still applies when nothing more specific matches", () => {
  const rules = parseCodeowners("* @everyone\n");
  assert.deepEqual(ownersFor(rules, "src/agents/manifests/x.json"), ["@everyone"]);
});

test("patterns match directories, globs and exact paths", () => {
  assert.ok(codeownersMatch("/src/agents/", "src/agents/manifests/a.json"));
  assert.ok(codeownersMatch("src/agents/manifests/*.json", "src/agents/manifests/a.json"));
  assert.ok(codeownersMatch("src/agents/manifests/a.json", "src/agents/manifests/a.json"));
  assert.ok(!codeownersMatch("src/tools/", "src/agents/manifests/a.json"));
  assert.ok(!codeownersMatch("src/agents/manifests/*.json", "src/agents/manifests/sub/a.json"),
    "a single star must not cross a directory boundary");
});

test("no CODEOWNERS and no git history yields no suggestion, not a bad one", async () => {
  const s = await suggestOwner("definitely-not-an-agent-xyz");
  if (s) assert.equal(s.confidence, "low", "any answer for an unknown agent must be low confidence");
});

test("an empty agent id is refused", async () => {
  assert.equal(await suggestOwner(""), null);
});

// ══ The store ═════════════════════════════════════════════════════════════
test("claiming, reading back, and releasing", async () => {
  _clearMemory();
  const r = await claimOwner("vm-migration", { owner: "s.menon", actor: "s.menon", source: "self" });
  assert.equal(r.ok, true);
  assert.equal(r.owner, "s.menon");
  assert.equal(r.claimedBy, "s.menon");
  assert.ok(r.warning, "with no database it must say the claim is not durable");

  const all = await getOwnership();
  assert.equal(all.get("vm-migration").owner, "s.menon");

  await releaseOwner("vm-migration");
  assert.equal((await getOwnership()).has("vm-migration"), false, "people change teams");
});

test("who claimed is recorded separately from who owns", async () => {
  _clearMemory();
  const r = await claimOwner("vm-migration", { owner: "k.balan", actor: "p.raghavan", source: "assigned" });
  assert.equal(r.owner, "k.balan");
  assert.equal(r.claimedBy, "p.raghavan", "a lead assigning an agent must stay visible as the actor");
});

test("an empty owner name is refused rather than stored", async () => {
  _clearMemory();
  assert.equal((await claimOwner("vm-migration", { owner: "   " })).ok, false);
  assert.equal((await claimOwner("", { owner: "x" })).ok, false);
  assert.equal((await getOwnership()).size, 0);
});

// The rule that is easy to get wrong: a pattern containing a slash is anchored
// to the repo root; one without matches at any depth.
test("an unanchored pattern matches at any depth, an anchored one does not", () => {
  assert.ok(codeownersMatch("*.json", "src/agents/manifests/a.json"), "*.json covers the whole repo");
  assert.ok(codeownersMatch("*", "a/b/c/d.json"), "a bare star is a catch-all");
  assert.ok(codeownersMatch("docs/*", "docs/a.md"));
  assert.ok(!codeownersMatch("docs/*", "docs/sub/a.md"), "a pattern with a slash is anchored and does not recurse");
});

// On this repository every manifest's last git author is an automation
// address. An unfiltered suggestion would offer to make a bot accountable for
// all sixteen agents — a name nobody can be held to, one click from looking
// like a reviewed answer.
test("a bot or noreply author is never offered as an owner", async () => {
  const { readdir } = await import("node:fs/promises");
  const ids = (await readdir("src/agents/manifests"))
    .filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  for (const id of ids) {
    const s = await suggestOwner(id);
    if (!s) continue;
    assert.doesNotMatch(s.owner, /noreply|\[bot\]|github-actions|dependabot/i,
      `${id} would have suggested "${s.owner}", which is not a person`);
  }
});
