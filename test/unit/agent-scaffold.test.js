import { test } from "node:test";
import assert from "node:assert/strict";
import { scaffoldAgent, validateScaffold, buildManifest } from "../../src/agents/scaffold.js";

const served = new Set(["list_nodes", "get_node_details", "get_cluster_events"]);
const base = {
  id: "node-hygiene", name: "Node Hygiene Agent",
  description: "Finds and reports nodes needing attention.",
  category: "Operations", tools: ["list_nodes", "get_node_details"],
};
const governed = {
  ...base,
  governance: { owner: "s.menon", trustTier: "first-party", blastRadius: "read-only", autonomyLevel: "advisory" },
  examples: [{ title: "Unhealthy nodes", prompt: "which nodes are not ready?" }],
};

// ══ The point of the feature ══════════════════════════════════════════════
test("declaring governance at creation is worth a whole grade band", () => {
  const bare = scaffoldAgent(base, { servedTools: served });
  const good = scaffoldAgent(governed, { servedTools: served });
  assert.ok(good.preview.score > bare.preview.score + 30,
    `governed ${good.preview.score}% vs bare ${bare.preview.score}% — the gap is the argument for asking up front`);
  assert.equal(good.preview.grade, "B");
});

test("a brand new agent is not penalised for having no history", () => {
  const s = scaffoldAgent(governed, { servedTools: served });
  const unknown = s.preview.checks.filter((c) => c.state === "unknown").map((c) => c.id);
  assert.deepEqual(unknown.sort(), ["in-use", "reconciled", "reliable"],
    "it has never run, so it has not had the chance to misbehave — unknown, not failed");
});

// ══ Validation ════════════════════════════════════════════════════════════
test("a duplicate id is an error, not a warning", () => {
  const v = validateScaffold(base, { existingIds: ["node-hygiene"] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.field === "id" && /already exists/.test(e.message)));
});

// The check that would have caught the 24 phantom tools before they shipped.
test("declaring a tool the server does not serve is blocked", () => {
  const v = validateScaffold({ ...base, tools: ["list_nodes", "mtv_start_migration"] }, { servedTools: served });
  assert.equal(v.ok, false);
  const e = v.errors.find((x) => x.field === "tools");
  assert.match(e.message, /mtv_start_migration/);
  assert.match(e.message, /empty tool list/);
});

test("with no served-tool list, tool names are not second-guessed", () => {
  const v = validateScaffold(base, { servedTools: null });
  assert.equal(v.ok, true, "unable to check is not the same as failed");
});

test("missing governance warns but never blocks", () => {
  const v = validateScaffold(base, { servedTools: served });
  assert.equal(v.ok, true, "someone who cannot yet say who owns it must still be able to create it");
  assert.ok(v.warnings.some((w) => w.field === "governance.owner"));
  assert.ok(v.warnings.some((w) => w.field === "governance.blastRadius"));
});

test("an invalid enum is an error, because it would be silently ignored later", () => {
  const v = validateScaffold({ ...governed, governance: { ...governed.governance, blastRadius: "mostly-harmless" } },
    { servedTools: served });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.field === "governance.blastRadius"));
});

test("an unusable id is rejected with the rule stated", () => {
  for (const id of ["Node_Hygiene", "9lives", "x", "has spaces"]) {
    const v = validateScaffold({ ...base, id }, {});
    assert.equal(v.ok, false, `"${id}" should not be accepted`);
  }
});

test("an agent with no tools exposes nothing and is refused", () => {
  const v = validateScaffold({ ...base, tools: [] }, { servedTools: served });
  assert.ok(v.errors.some((e) => e.field === "tools"));
});

// ══ The manifest ══════════════════════════════════════════════════════════
test("the governance block carries only what was answered, plus lifecycle", () => {
  const m = buildManifest({ ...base, governance: { owner: "s.menon" } });
  assert.deepEqual(Object.keys(m.governance), ["owner", "lifecycle", "lifecycleSince"],
    "an unanswered field stays out — a block full of nulls reads as declared-and-empty");
});

// Lifecycle is the one field a new agent must state rather than leave to the
// default, because silence means `active` for the agents that predate the
// field. A new agent inheriting that would be active on day one, which is
// exactly what probation exists to prevent.
test("lifecycle is always written, even when nothing else is answered", () => {
  const m = buildManifest(base);
  assert.equal(m.governance.lifecycle, "experimental");
  assert.ok(m.governance.lifecycleSince);
  assert.deepEqual(Object.keys(m.governance), ["lifecycle", "lifecycleSince"],
    "still nothing invented beyond the two that must be explicit");
});

test("the manifest matches the shape the existing sixteen use", () => {
  const m = buildManifest(governed);
  for (const k of ["id", "name", "version", "description", "category", "tools", "protocols", "mcpEndpoint"]) {
    assert.ok(k in m, `missing ${k}`);
  }
  assert.equal(m.mcpEndpoint, "/mcp/node-hygiene");
  assert.deepEqual(m.tools, ["list_nodes", "get_node_details"]);
});

test("duplicate tools are collapsed rather than written twice", () => {
  const m = buildManifest({ ...base, tools: ["list_nodes", "list_nodes"] });
  assert.deepEqual(m.tools, ["list_nodes"]);
});

test("it hands back a file and a path, and says it wrote nothing", () => {
  const s = scaffoldAgent(governed, { servedTools: served });
  assert.equal(s.path, "src/agents/manifests/node-hygiene.json");
  assert.deepEqual(JSON.parse(s.file), s.manifest, "the file must parse back to the manifest");
  assert.match(s.next, /not written by the platform/);
});
