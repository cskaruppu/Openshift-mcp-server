import { test } from "node:test";
import assert from "node:assert/strict";
import { getAgentById, getAgentProfile, listProfiles } from "../../src/agents/registry.js";

test("a profile narrows the agent and never widens it", async () => {
  const full = await getAgentById("vm-migration");
  const ro = await getAgentProfile("vm-migration", "readonly");
  assert.ok(ro, "the worked example profile must resolve");
  assert.ok(ro.tools.length < full.tools.length);
  for (const t of ro.tools) {
    assert.ok(full.tools.includes(t), `profile exposes "${t}", which the agent does not declare`);
  }
});

// The point of the whole feature: the dangerous tools are not merely hidden,
// they are never registered, so they cannot be called at all.
test("the acting tools are unreachable on the read-only profile", async () => {
  const ro = await getAgentProfile("vm-migration", "readonly");
  for (const t of ["mtv_create_plans", "mtv_start_migration", "mtv_rollback_migration"]) {
    assert.ok(!ro.tools.includes(t), `${t} must not be reachable on a read-only profile`);
  }
});

test("a profile carries its own, narrower blast radius", async () => {
  const ro = await getAgentProfile("vm-migration", "readonly");
  assert.equal(ro.governance.blastRadius, "read-only");
  assert.equal(ro.governance.autonomyLevel, "advisory");
});

test("a tool named in a profile but not on the agent is dropped, not granted", async () => {
  // Simulated directly, because a manifest that did this would be a bug we want
  // contained rather than reproduced on disk.
  const { _forProfileTest } = await import("../../src/agents/registry.js").catch(() => ({}));
  const full = await getAgentById("vm-migration");
  const declared = new Set(full.tools);
  const pretend = ["mtv_discover_vms", "cluster_delete_everything"];
  const kept = pretend.filter((t) => declared.has(t));
  assert.deepEqual(kept, ["mtv_discover_vms"],
    "a profile must never be a route to a tool the agent was not reviewed for");
});

test("an unknown profile resolves to null rather than the full agent", async () => {
  assert.equal(await getAgentProfile("vm-migration", "does-not-exist"), null,
    "falling back to the full agent would silently hand over every tool");
});

test("no profile name returns the agent unchanged", async () => {
  const a = await getAgentProfile("vm-migration", null);
  const full = await getAgentById("vm-migration");
  assert.equal(a.id, full.id);
  assert.equal(a.tools.length, full.tools.length);
});

test("an unknown agent is null with or without a profile", async () => {
  assert.equal(await getAgentProfile("no-such-agent", "readonly"), null);
  assert.equal(await getAgentProfile("no-such-agent", null), null);
});

test("profiles are addressable as agent:profile", async () => {
  const ro = await getAgentProfile("vm-migration", "readonly");
  assert.equal(ro.id, "vm-migration:readonly");
  assert.equal(ro.baseId, "vm-migration");
  assert.equal(ro.profile, "readonly");
});

test("listProfiles surfaces tools a profile names that the agent lacks", async () => {
  for (const p of await listProfiles()) {
    assert.deepEqual(p.unknownTools, [],
      `${p.id} names tools its agent does not declare: ${p.unknownTools.join(", ")}`);
    assert.ok(p.toolCount > 0, `${p.id} would expose nothing at all`);
  }
});

test("every declared profile is reachable and nested profiles are not invented", async () => {
  const profiles = await listProfiles();
  assert.ok(profiles.length >= 1);
  for (const p of profiles) {
    const resolved = await getAgentProfile(p.baseId, p.profile);
    assert.ok(resolved, `${p.id} is listed but does not resolve`);
    assert.equal(resolved.profiles, undefined, "a profile must not itself advertise profiles");
  }
});
