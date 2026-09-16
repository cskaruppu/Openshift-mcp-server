import { test } from "node:test";
import assert from "node:assert/strict";
import { withAgentContext, setCurrentAgent, currentAgent, asAgent } from "../../src/services/agent-context.js";
import { costPerOutcome } from "../../src/services/migration-history.js";

// ══ Ambient attribution ═══════════════════════════════════════════════════
test("outside any context there is no agent, and nothing throws", () => {
  assert.deepEqual(currentAgent(), { agentId: null, agentVersion: null });
  assert.equal(setCurrentAgent("x"), false, "setting an agent outside a context is a no-op, not an error");
});

test("the agent survives awaits, which is the whole point", async () => {
  await withAgentContext(async () => {
    setCurrentAgent("vm-migration");
    await new Promise((r) => setTimeout(r, 5));
    await Promise.resolve();
    assert.equal(currentAgent().agentId, "vm-migration",
      "a model call three awaits deep must still know which agent caused it");
  });
});

// The failure this design has to rule out: one request's spend landing on
// another request's agent.
test("concurrent contexts cannot see each other", async () => {
  const seen = [];
  await Promise.all([
    withAgentContext(async () => {
      setCurrentAgent("agent-a");
      await new Promise((r) => setTimeout(r, 12));
      seen.push(["a", currentAgent().agentId]);
    }),
    withAgentContext(async () => {
      setCurrentAgent("agent-b");
      await new Promise((r) => setTimeout(r, 2));
      seen.push(["b", currentAgent().agentId]);
    }),
  ]);
  assert.deepEqual(seen.sort(), [["a", "agent-a"], ["b", "agent-b"]]);
});

test("a fresh context starts empty rather than inheriting", async () => {
  await withAgentContext(async () => {
    setCurrentAgent("outer");
    await withAgentContext(async () => {
      assert.equal(currentAgent().agentId, null, "a new request must not inherit the last one's agent");
    });
    assert.equal(currentAgent().agentId, "outer");
  });
});

test("asAgent restores what was in scope, even when the work throws", async () => {
  await withAgentContext(async () => {
    setCurrentAgent("outer");
    await assert.rejects(() => asAgent("inner", async () => { throw new Error("boom"); }));
    assert.equal(currentAgent().agentId, "outer", "a failure must not leave the wrong agent in scope");
  });
});

test("an empty agent id is refused rather than recorded as blank", async () => {
  await withAgentContext(async () => {
    setCurrentAgent("real");
    setCurrentAgent("");
    setCurrentAgent(null);
    assert.equal(currentAgent().agentId, "real");
  });
});

// ══ Cost per outcome ══════════════════════════════════════════════════════
test("cost per VM is derived when both halves were measured", () => {
  const u = costPerOutcome({ vmCount: 4, ai: { costUsd: 1.52, totalTokens: 184000 } });
  assert.equal(u.perVm, "$0.38");
  assert.equal(u.tokensPerVm, 46000);
  assert.equal(u.partial, false);
});

// The rule: unmeasured is not free.
test("a migration with no recorded cost reports nothing, not zero", () => {
  assert.equal(costPerOutcome({ vmCount: 4, ai: null }), null);
  assert.equal(costPerOutcome({ vmCount: 4, ai: { calls: 3 } }), null,
    "AI was consulted but cost was never captured — that is unmeasured, not $0.00");
});

test("a zero or missing VM count yields nothing rather than dividing by it", () => {
  assert.equal(costPerOutcome({ vmCount: 0, ai: { costUsd: 1 } }), null);
  assert.equal(costPerOutcome({ ai: { costUsd: 1 } }), null);
});

test("a partial token count is flagged so the figure reads as a floor", () => {
  const u = costPerOutcome({ vmCount: 2, ai: { costUsd: 1, totalTokens: 1000, tokensPartial: true } });
  assert.equal(u.partial, true);
});

test("sub-cent costs keep enough precision to be worth printing", () => {
  const u = costPerOutcome({ vmCount: 100, ai: { costUsd: 0.12 } });
  assert.equal(u.perVm, "$0.0012", "$0.00 per VM would read as free");
});

test("tokens per VM is absent when tokens were not recorded", () => {
  const u = costPerOutcome({ vmCount: 2, ai: { costUsd: 1 } });
  assert.equal(u.tokensPerVm, null);
  assert.equal(u.perVm, "$0.50");
});
