import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recordTrace, getTraceStats, generateTraceId } from "../../src/services/query-tracer.js";

const UI = readFileSync("console/src/views/AuditView.jsx", "utf8");

// ══ Percentiles ══════════════════════════════════════════════════════════
// A mean hides the tail, and the tail is what people complain about.
test("p50 and p95 describe the spread a mean conceals", async () => {
  for (const [q, d] of [["a", 100], ["b", 120], ["c", 140], ["d", 9000]]) {
    await recordTrace({ traceId: generateTraceId(), queryText: q, totalDurationMs: d, spans: [] });
  }
  const s = await getTraceStats({ days: 1 });
  assert.ok(s.p50_duration_ms < 1000, `p50 ${s.p50_duration_ms} should reflect the typical query`);
  assert.ok(s.p95_duration_ms >= 9000, `p95 ${s.p95_duration_ms} should surface the slow one`);
  assert.ok(s.avg_duration_ms > s.p50_duration_ms,
    "the mean is dragged up by the outlier — which is the reason for showing percentiles");
});

test("an error rate is null with no queries, never 0%", async () => {
  const s = await getTraceStats({ days: 0 });
  assert.ok(s.error_rate === null || typeof s.error_rate === "number");
  if (s.total_queries === 0) assert.equal(s.error_rate, null, "no queries is not a perfect record");
});

test("the memory path returns the same fields as the database path", async () => {
  const s = await getTraceStats({ days: 1 });
  for (const k of ["total_queries", "avg_duration_ms", "p50_duration_ms", "p95_duration_ms", "failed_queries", "error_rate"]) {
    assert.ok(k in s, `missing ${k} — the console would read two different shapes`);
  }
});

// ══ Three views, not one scroll ══════════════════════════════════════════
test("the three analyses are views, each gated on its own", () => {
  for (const v of ["executions", "conversation", "agent"]) {
    assert.ok(UI.includes(`tracesView === "${v}"`), `${v} is not gated — it would render in every view`);
  }
  assert.match(UI, /className="aud-subtabs"/);
});

test("switching view or filter resets paging", () => {
  assert.match(UI, /useEffect\(\(\) => \{ setTracePage\(1\); \}, \[tracesView, traceAgentFilter\]\)/,
    "'showing 50' carried into a filter with three results reads as broken");
});

// The list was traces.map() over everything fetched — roughly 3,000px of cards.
test("the trace list is paged rather than rendered whole", () => {
  assert.match(UI, /traces\.slice\(0, tracePage \* TRACES_PER_PAGE\)/);
  assert.match(UI, /const TRACES_PER_PAGE = \d+/);
  assert.doesNotMatch(UI, /\{traces\.map\(\(t, ti\) => \{/, "an uncapped map is what buried the other two views");
});

test("durations read as durations, and unknown reads as unknown", () => {
  assert.match(UI, /function ms\(v\)/);
  assert.match(UI, /if \(v == null\) return "\\u2014"/, "a missing duration must not render as 0ms");
});
