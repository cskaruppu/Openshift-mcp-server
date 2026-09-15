import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { traceAgentOperation, getAgentAnalytics, generateTraceId } from "../../src/services/query-tracer.js";

/* Agent Traces and the Governance lens are two views of one set of agents. A
   span carrying an id the registry does not know appears in the first and
   nowhere in the second, and two views of the same thing that disagree make
   both untrustworthy. This pins the route table to the manifests. */
test("every agent id in HUB_AGENT_ROUTES exists in the registry", async () => {
  const src = await readFile("src/index.js", "utf8");
  const block = src.match(/const HUB_AGENT_ROUTES = \[([\s\S]*?)\n\];/);
  assert.ok(block, "HUB_AGENT_ROUTES must still be a findable literal");

  const ids = [...block[1].matchAll(/\[\s*"[^"]+",\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, `expected the route table to be populated, saw ${ids.length}`);

  const files = (await readdir("src/agents/manifests")).filter((f) => f.endsWith(".json"));
  const known = new Set(await Promise.all(files.map(async (f) =>
    JSON.parse(await readFile(`src/agents/manifests/${f}`, "utf8")).id)));

  for (const id of ids) {
    assert.ok(known.has(id), `route table names "${id}", which has no manifest`);
  }
});

test("longer route prefixes are listed before any prefix of them", async () => {
  const src = await readFile("src/index.js", "utf8");
  const block = src.match(/const HUB_AGENT_ROUTES = \[([\s\S]*?)\n\];/)[1];
  const prefixes = [...block.matchAll(/\[\s*"([^"]+)"/g)].map((m) => m[1]);
  for (let i = 0; i < prefixes.length; i++) {
    for (let j = i + 1; j < prefixes.length; j++) {
      assert.ok(!prefixes[i].startsWith(prefixes[j]),
        `"${prefixes[j]}" would swallow "${prefixes[i]}" — put the longer one first`);
    }
  }
});

// ── The helper itself ────────────────────────────────────────────────────
test("an agent operation becomes one span the analytics can see", async () => {
  const id = `vm-migration-${Math.random().toString(36).slice(2, 7)}`;
  await traceAgentOperation({
    agentId: id, agentName: "VM Migration Agent", category: "Lifecycle",
    operation: "migrate wave-3", toolsCalled: ["vm-migration:migrate"],
    durationMs: 1200, status: "success", cluster: "local",
  });
  const an = await getAgentAnalytics({ days: 1 });
  const row = (an.agents || []).find((a) => a.agent_id === id);
  assert.ok(row, "the operation must show up in agent analytics");
  assert.equal(row.invocation_count, 1);
});

test("a failed operation is still recorded — it is the one most worth having", async () => {
  const id = `failing-${Math.random().toString(36).slice(2, 7)}`;
  await traceAgentOperation({
    agentId: id, agentName: "X", operation: "rollback wave-9",
    toolsCalled: ["x:rollback"], status: "error", durationMs: 40,
  });
  const an = await getAgentAnalytics({ days: 1 });
  const row = (an.agents || []).find((a) => a.agent_id === id);
  assert.ok(row, "an error span must be recorded, not dropped");
  assert.equal(row.error_rate, 100);
});

test("an operation with no agent id is refused rather than recorded as unknown", async () => {
  assert.equal(await traceAgentOperation({ operation: "something" }), null);
  assert.equal(await traceAgentOperation({ agentId: "a" }), null);
});

test("tokens are reported as unmeasured, never as zero", async () => {
  const an = await getAgentAnalytics({ days: 1 });
  assert.equal(an.tokensAttributed, false, "no database here, so nothing is attributed");
  for (const a of an.agents || []) {
    assert.equal(a.total_tokens, null, "a spanned agent with no LLM record must read null, not 0");
  }
});
