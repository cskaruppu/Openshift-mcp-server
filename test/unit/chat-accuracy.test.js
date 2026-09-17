import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normaliseStopReason } from "../../src/services/llm.js";

/* Why the model stopped was recorded nowhere, so a truncated answer — which
   reads as a WRONG answer, because it stops mid-command — was invisible. */

test("truncation is detected across every provider's vocabulary", () => {
  assert.equal(normaliseStopReason({ choices: [{ finish_reason: "length" }] }).truncated, true, "OpenAI/Azure");
  assert.equal(normaliseStopReason({ stop_reason: "max_tokens" }).truncated, true, "Anthropic");
  assert.equal(normaliseStopReason({ finish_reason: "length" }).truncated, true, "Ollama, mapped");
});

test("a complete answer is not reported as truncated", () => {
  assert.equal(normaliseStopReason({ choices: [{ finish_reason: "stop" }] }).truncated, false);
  assert.equal(normaliseStopReason({ stop_reason: "end_turn" }).truncated, false);
  assert.equal(normaliseStopReason({ choices: [{ finish_reason: "tool_calls" }] }).truncated, false,
    "stopping to call a tool is the loop working, not a cut-off answer");
});

// The rule this codebase holds everywhere: unknown is not a pass.
test("an unrecorded stop reason is null, never 'complete'", () => {
  const u = normaliseStopReason(null);
  assert.equal(u.reason, null);
  assert.equal(u.truncated, null, "no record is not evidence the answer was whole");
  assert.notEqual(u.truncated, false);
});

test("a content filter is reported as itself, not as truncation", () => {
  const f = normaliseStopReason({ choices: [{ finish_reason: "content_filter" }] });
  assert.equal(f.filtered, true);
  assert.equal(f.truncated, false);
});

// ── The reply the user actually sees ─────────────────────────────────────
const SRC = readFileSync("src/services/chat-api.js", "utf8");

test("the evidence line reaches the STREAMING path, which is the one in use", () => {
  // The console reads SSE. Improving only the non-streaming path would be
  // invisible to every real user.
  const tail = SRC.slice(SRC.indexOf("const traceMd = renderTraceMarkdown"));
  assert.match(tail, /evidenceLine\(_toolsUsed, _streamReadAt\)/,
    "the streaming path must append the evidence line");
  assert.match(tail, /_streamTruncated/,
    "the streaming path must report a cut-off answer");
});

test("tool provenance is shown, not buried in an HTML comment", () => {
  assert.match(SRC, /function evidenceLine/);
  assert.match(SRC, /Read from \$\{tools/, "the tools must appear in visible text");
  // The machine-readable marker stays for the console, but is no longer the
  // only place the information exists.
  assert.match(SRC, /<!--tools:/);
});

test("a fallback answer is labelled as one rather than served as the assistant's", () => {
  assert.match(SRC, /function markDegraded/);
  assert.match(SRC, /could not reach the model/);
  // Every builtInAnalysis fallback in the reply path goes through it.
  const fallbacks = [...SRC.matchAll(/\|\| *builtInAnalysis\(/g)];
  assert.equal(fallbacks.length, 0,
    "a bare `|| builtInAnalysis(...)` serves a static read as though the model answered");
});

test("the chat token ceiling is configurable and above the old 2000", () => {
  const m = SRC.match(/CHAT_MAX_TOKENS = parseInt\(process\.env\.CHAT_MAX_TOKENS \|\| "(\d+)"/);
  assert.ok(m, "the ceiling must be configurable per deployment");
  assert.ok(Number(m[1]) >= 4000, `ceiling is ${m[1]}; an SRE answer with a manifest needs more than 2000`);
});

test("hitting the iteration ceiling is said out loud", () => {
  assert.match(SRC, /Investigation stopped after \$\{MAX_TOOL_ITERATIONS\} rounds/,
    "running out of rounds means the investigation was cut short, not that it concluded");
});
