import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseUsage, estimateCost, modelPricing } from "../../src/services/llm.js";

test("usage is read from where providers actually put it", () => {
  // THE BUG THIS EXISTS FOR: providers return { text, toolCalls, raw: data }
  // and usage lives inside `raw`. Both readers looked for `result.usage` at the
  // top level, so every token count was null from the day it was added — the
  // console showed "2 calls" with nothing beside it and looked like a provider
  // problem. It was a shape mismatch one level up.
  const openaiBody = { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 } };
  assert.deepEqual(normaliseUsage(openaiBody), { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 });

  // Reading only the OpenAI shape would have fixed this for some deployments
  // and left it silently broken for others — the worse outcome, because it
  // would then LOOK fixed. Anthropic uses different names and sends no total.
  assert.deepEqual(normaliseUsage({ usage: { input_tokens: 1200, output_tokens: 300 } }),
    { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 });

  // A provider that reports nothing yields nulls, never zeros. "0 tokens" is a
  // claim; "not reported" is the truth.
  for (const empty of [{}, null, undefined, { usage: {} }, { usage: null }]) {
    assert.deepEqual(normaliseUsage(empty), { promptTokens: null, completionTokens: null, totalTokens: null });
  }

  // A total missing but the parts present is computed rather than dropped.
  assert.equal(normaliseUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }).totalTokens, 15);
  // And a partial report stays partial rather than being completed by guesswork.
  assert.equal(normaliseUsage({ usage: { prompt_tokens: 10 } }).totalTokens, null);
});

test("cost is priced per model, and an unpriced model reports nothing", () => {
  const c = estimateCost("gpt-4o-mini", 1_000_000, 1_000_000);
  assert.equal(c.usd, 0.75, "0.15 in + 0.60 out per million");
  assert.equal(c.currency, "USD");

  // Matched on a substring, so a deployment name carrying a date or a suffix
  // still prices correctly.
  assert.equal(estimateCost("gpt-4o-mini-2024-07-18", 1_000_000, 0).usd, 0.15);
  assert.equal(estimateCost("claude-sonnet-4-5", 1_000_000, 0).usd, 3);

  // An unknown model returns NULL, not zero. Quietly pricing an unlisted model
  // at nothing is how a spend report ends up wrong in the reassuring direction.
  assert.equal(estimateCost("some-local-llama", 1000, 1000), null);
  assert.equal(estimateCost(null, 1000, 1000), null);
  // Unreported tokens cannot be priced either.
  assert.equal(estimateCost("gpt-4o-mini", null, 300), null);

  // Prices move, so they are configuration.
  assert.equal(estimateCost("x-model", 1_000_000, 0, { "x-model": { in: 9, out: 1 } }).usd, 9);
  assert.ok(Object.keys(modelPricing()).length > 0);
});

test("a partly-reported token sum is a floor, not a total", async () => {
  const { aiProvenance } = await import("../../src/services/vm-migration.js");

  // Every call reported: the sum is a total, and it is priced.
  const all = aiProvenance([
    { ok: true, touchpoint: "advice", provider: "openai", model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: { usd: 0.0001 }, durationMs: 10 },
    { ok: true, touchpoint: "fleet", provider: "openai", model: "gpt-4o-mini", promptTokens: 200, completionTokens: 60, totalTokens: 260, cost: { usd: 0.0002 }, durationMs: 12 },
  ]);
  assert.equal(all.calls, 2);
  assert.equal(all.totalTokens, 410);
  assert.equal(all.tokensReported, true);
  assert.equal(all.tokensPartial, false);
  assert.equal(all.costUsd, 0.0003);

  // One call reported and one did not: the sum is a FLOOR. The console says
  // "at least", because silently summing partial data is how a cost figure
  // stops being worth quoting.
  const partial = aiProvenance([
    { ok: true, touchpoint: "advice", model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: { usd: 0.0001 } },
    { ok: true, touchpoint: "fleet", model: "gpt-4o-mini", promptTokens: null, completionTokens: null, totalTokens: null },
  ]);
  assert.equal(partial.totalTokens, 150);
  assert.equal(partial.tokensReported, false, "not every call reported");
  assert.equal(partial.tokensPartial, true, "so the figure is a floor");

  // Nothing reported at all: null rather than zero, and no cost invented.
  const none = aiProvenance([{ ok: true, touchpoint: "advice", model: "m" }]);
  assert.equal(none.totalTokens, null);
  assert.equal(none.costUsd, null);
  assert.equal(none.tokensPartial, false);

  // No model consulted is its own state, not a zero-token call.
  const never = aiProvenance([]);
  assert.equal(never.consulted, false);
  assert.equal(never.calls, 0);
  assert.equal(never.tokensReported, false);
});

test("a cost figure can explain itself, and says when it is the wrong number", async () => {
  const { estimateCost } = await import("../../src/services/llm.js");

  // The arithmetic, in the form someone reads back in a budget conversation.
  const c = estimateCost("gpt-4o-mini", 1200, 300);
  assert.match(c.basis, /1,200 prompt tokens x \$0\.15\/M/);
  assert.match(c.basis, /300 completion tokens x \$0\.6\/M/);
  assert.equal(c.rateIn, 0.15);
  assert.equal(c.rateOut, 0.60);
  assert.equal(c.matchedFrom, "gpt-4o-mini", "which name was priced, not just which rate");

  // The caveat that makes the number honest. Most organisations do not pay
  // list price, and a figure that implies they do is wrong in a direction
  // nobody checks.
  assert.equal(c.source, "list-price");
  assert.ok(c.asOf, "rates carry the date they were last checked");
  assert.match(c.caveat, /enterprise agreement|committed-use|provisioned-throughput/);
  assert.match(c.caveat, /MODEL_PRICING/, "and how to make it exact");

  // With a configured rate card the label changes, because now it IS their
  // number rather than a published one.
  process.env.MODEL_PRICING = JSON.stringify({ "our-model": { in: 1, out: 2 } });
  process.env.MODEL_PRICING_AS_OF = "2026-04-01";
  try {
    const own = estimateCost("our-model-v2", 1_000_000, 1_000_000);
    assert.equal(own.usd, 3);
    assert.equal(own.source, "configured");
    assert.equal(own.asOf, "2026-04-01");
    assert.match(own.caveat, /your configured rates/);
    assert.ok(!/list price/.test(own.caveat), "a configured rate is not labelled list price");
  } finally {
    delete process.env.MODEL_PRICING;
    delete process.env.MODEL_PRICING_AS_OF;
  }
});

test("the fleet roll-up carries the working, and flags an unpriced call", async () => {
  const { aiProvenance } = await import("../../src/services/vm-migration.js");
  const priced = (t, m) => ({
    ok: true, touchpoint: t, model: m, promptTokens: 100, completionTokens: 50, totalTokens: 150,
    cost: { usd: 0.0001, model: m, basis: `${t} basis`, source: "list-price", asOf: "2026-09-01", caveat: "list price caveat" },
  });

  const both = aiProvenance([priced("advice", "gpt-4o-mini"), priced("fleet", "gpt-4o-mini")]);
  assert.equal(both.costBasis.lines.length, 2, "one line per call");
  assert.match(both.costBasis.lines[0], /advice: advice basis/);
  assert.equal(both.costBasis.unpriced, 0);
  assert.equal(both.costBasis.source, "list-price");

  // A wave that used two models shows both, rather than one blended rate that
  // matches neither.
  const mixed = aiProvenance([priced("advice", "gpt-4o-mini"), priced("fleet", "gpt-4o")]);
  assert.deepEqual(mixed.costBasis.models.sort(), ["gpt-4o", "gpt-4o-mini"]);

  // A model absent from the rate card leaves the total a FLOOR, and says so.
  const partial = aiProvenance([
    priced("advice", "gpt-4o-mini"),
    { ok: true, touchpoint: "fleet", model: "prod-deployment-01", promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  ]);
  assert.equal(partial.costBasis.unpriced, 1);
  assert.equal(partial.costUsd, 0.0001, "only what could actually be priced");

  // Nothing priceable at all is null, never zero.
  const none = aiProvenance([{ ok: true, touchpoint: "advice", model: "prod-deployment-01", totalTokens: 150 }]);
  assert.equal(none.costUsd, null);
  assert.equal(none.costBasis, null);
});
