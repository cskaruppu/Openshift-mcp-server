import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseUsage } from "../../src/services/llm.js";

/* The bug this guards: streaming returned no `raw`, so normaliseUsage() got
   undefined and every streamed call recorded NULL tokens — which is nearly all
   of them, because the chat UI streams. The fleet total was then the handful of
   background non-streaming calls, and read as ~7 tokens per call. */

test("no raw at all yields nulls, not zeros", () => {
  const u = normaliseUsage(undefined);
  assert.deepEqual(u, { promptTokens: null, completionTokens: null, totalTokens: null });
  assert.notEqual(u.totalTokens, 0, "zero would read as 'this call was free'");
});

test("the OpenAI/Azure streamed usage chunk is understood", () => {
  // What stream_options:{include_usage:true} emits on the final chunk, wrapped
  // by the streaming path as { usage }.
  const u = normaliseUsage({ usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 } });
  assert.equal(u.promptTokens, 1200);
  assert.equal(u.completionTokens, 340);
  assert.equal(u.totalTokens, 1540);
});

test("a provider that omits total_tokens still gets one", () => {
  const u = normaliseUsage({ usage: { prompt_tokens: 100, completion_tokens: 25 } });
  assert.equal(u.totalTokens, 125);
});

test("Anthropic's merged stream usage is understood and totalled", () => {
  // input_tokens arrive on message_start, output_tokens on message_delta; the
  // streaming path merges both before handing them over.
  const u = normaliseUsage({ usage: { input_tokens: 900, output_tokens: 210 } });
  assert.equal(u.promptTokens, 900);
  assert.equal(u.completionTokens, 210);
  assert.equal(u.totalTokens, 1110, "Anthropic sends no total, so it is computed");
});

test("half an Anthropic stream does not silently become a whole call", () => {
  // message_start only — output not yet seen.
  const u = normaliseUsage({ usage: { input_tokens: 900 } });
  assert.equal(u.promptTokens, 900);
  assert.equal(u.completionTokens, null);
  assert.equal(u.totalTokens, null, "an incomplete pair must not be totalled as if complete");
});

test("Ollama counts mapped to the OpenAI shape are understood", () => {
  const u = normaliseUsage({ usage: { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 } });
  assert.equal(u.totalTokens, 80);
});

test("an unrecognised usage shape reports nothing rather than guessing", () => {
  const u = normaliseUsage({ usage: { tokens_consumed: 500 } });
  assert.deepEqual(u, { promptTokens: null, completionTokens: null, totalTokens: null });
});
