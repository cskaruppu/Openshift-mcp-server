/**
 * Golden-set canaries — asking an agent a question whose answer is known.
 *
 * This is the only detector in the system that can see a WRONG answer.
 * Everything else — error rate, reconciliation, posture, scorecard — watches
 * whether the agent ran. None of them watches whether it was right. So an agent
 * whose prompt drifted, whose model was swapped underneath it, or whose
 * dependency started returning empty, keeps scoring A while quietly handing the
 * customer rubbish.
 *
 * A canary is a fixed input and an expectation that must stay true. It runs on
 * a schedule, and when it stops being true something changed that nobody
 * intended.
 *
 * FOUR RULES.
 *
 * 1. A CANARY NEVER MUTATES ANYTHING. Cases declare a kind, and only three are
 *    allowed: `pure` (a function over a fixture — no cluster, no network),
 *    `read-only` (needs a reachable cluster, reads and does not write), and
 *    `llm` (costs a model call). Anything that would change the estate is
 *    rejected when the case is loaded, not when it runs. A health check that
 *    can break production is not a health check.
 *
 * 2. A SKIPPED CASE IS REPORTED AS SKIPPED. No cluster, no model provider, no
 *    fixture — the case reports `skip` with the reason, and a run made entirely
 *    of skips is NOT a pass. This is the same rule the migration verification
 *    and the deploy gate follow, for the same reason.
 *
 * 3. EXPECTATIONS ARE INVARIANTS, NOT TRANSCRIPTS. "The generated manifests
 *    score grade A against our own gate" survives a reworded description;
 *    "output equals this 4KB blob" fails on the first harmless edit and gets
 *    switched off within a week. A canary everyone ignores detects nothing.
 *
 * 4. A FAILURE SAYS WHAT CHANGED. Expected, actual, and the case's own note
 *    about why the invariant matters — so the person reading it at 2am knows
 *    whether they are looking at a regression or at a canary that needs
 *    updating.
 */

import { evidenceDensity } from "./health-signals.js";

/** The kinds a case may declare. Anything else is refused. */
export const CANARY_KINDS = new Set(["pure", "read-only", "llm"]);

// ── Assertions ────────────────────────────────────────────────────────────
//
// Small, named, and deliberately few. A canary file is read by whoever is
// deciding at 2am whether to roll back, so the vocabulary stays small enough
// to hold in the head.

const ASSERTIONS = {
  /** Deep-equality on a value plucked from the result. */
  equals: (actual, expected) => ({
    ok: JSON.stringify(actual) === JSON.stringify(expected),
    actualText: JSON.stringify(actual), expectedText: JSON.stringify(expected),
  }),
  /** Numeric comparison: the value must be at least this. */
  atLeast: (actual, expected) => ({
    ok: Number(actual) >= Number(expected),
    actualText: String(actual), expectedText: `>= ${expected}`,
  }),
  atMost: (actual, expected) => ({
    ok: Number(actual) <= Number(expected),
    actualText: String(actual), expectedText: `<= ${expected}`,
  }),
  /** The value, stringified, must match this regular expression. */
  matches: (actual, expected) => ({
    ok: new RegExp(expected).test(typeof actual === "string" ? actual : JSON.stringify(actual)),
    actualText: typeof actual === "string" ? actual.slice(0, 200) : JSON.stringify(actual)?.slice(0, 200),
    expectedText: `/${expected}/`,
  }),
  /** An array (or string) must contain this. */
  contains: (actual, expected) => ({
    ok: Array.isArray(actual)
      ? actual.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).includes(
          typeof expected === "string" ? expected : JSON.stringify(expected))
      : typeof actual === "string" ? actual.includes(String(expected)) : false,
    actualText: Array.isArray(actual) ? actual.slice(0, 8).join(", ") : String(actual).slice(0, 200),
    expectedText: `contains ${expected}`,
  }),
  /** An array (or string) must NOT contain this — the refusal cases. */
  excludes: (actual, expected) => {
    const r = ASSERTIONS.contains(actual, expected);
    return { ok: !r.ok, actualText: r.actualText, expectedText: `does not contain ${expected}` };
  },
  /** One of a fixed set. */
  oneOf: (actual, expected) => ({
    ok: Array.isArray(expected) && expected.some((e) => JSON.stringify(e) === JSON.stringify(actual)),
    actualText: JSON.stringify(actual), expectedText: `one of ${JSON.stringify(expected)}`,
  }),
  /** Present and not null — for "it answered at all". */
  isSet: (actual) => ({
    ok: actual !== undefined && actual !== null && actual !== "",
    actualText: JSON.stringify(actual), expectedText: "a value",
  }),
};

export const ASSERTION_NAMES = Object.keys(ASSERTIONS);

/** Pluck `a.b[0].c` out of a result. Returns undefined rather than throwing. */
export function pluck(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur == null) return undefined;
    const m = /^(.*?)\[(\d+)\]$/.exec(part);
    if (m) {
      cur = m[1] ? cur[m[1]] : cur;
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(m[2])];
    } else {
      cur = cur[part];
    }
  }
  return cur;
}

/**
 * Validate a case before it is ever run.
 *
 * Rule 1 lives here: a case that could change something is refused at load,
 * not caught at runtime.
 */
export function validateCase(c, agentId) {
  const errs = [];
  if (!c || typeof c !== "object") return ["case is not an object"];
  if (!c.id) errs.push("case has no id");
  if (!CANARY_KINDS.has(c.kind)) errs.push(`kind must be one of ${[...CANARY_KINDS].join(", ")} (got ${JSON.stringify(c.kind)})`);
  if (typeof c.run !== "function") errs.push("case has no run() function");
  if (!Array.isArray(c.expect) || c.expect.length === 0) errs.push("case declares no expectations");
  for (const e of c.expect || []) {
    if (!ASSERTIONS[e?.assert]) errs.push(`unknown assertion ${JSON.stringify(e?.assert)} — use one of ${ASSERTION_NAMES.join(", ")}`);
  }
  if (c.mutates === true) errs.push("a canary may never mutate anything");
  if (!c.why) errs.push("case does not say why its invariant matters — a failure nobody can interpret gets muted");
  return errs.map((e) => `${agentId}/${c.id || "?"}: ${e}`);
}

/**
 * Run one case.
 *
 * `ctx` carries what the case may need and what it may not have:
 *   { clusterReachable: boolean, llmConfigured: boolean }
 * A case whose prerequisite is absent SKIPS with that reason. It never passes.
 */
export async function runCase(c, ctx = {}) {
  const started = Date.now();
  const base = { id: c.id, kind: c.kind, title: c.title || c.id, why: c.why };

  if (c.kind === "read-only" && !ctx.clusterReachable) {
    return { ...base, state: "skip", durationMs: 0, reason: "No cluster is reachable, so this case could not run. A skipped case is not a pass." };
  }
  if (c.kind === "llm" && !ctx.llmConfigured) {
    return { ...base, state: "skip", durationMs: 0, reason: "No LLM provider is configured, so model drift cannot be detected. A skipped case is not a pass." };
  }

  let result;
  try {
    result = await c.run(ctx);
  } catch (err) {
    return { ...base, state: "error", durationMs: Date.now() - started,
      reason: `The case threw before anything could be asserted: ${err.message}`,
      checks: [] };
  }

  const checks = [];
  for (const e of c.expect) {
    const actual = pluck(result, e.path);
    const { ok, actualText, expectedText } = ASSERTIONS[e.assert](actual, e.value);
    checks.push({
      path: e.path || "(result)", assert: e.assert,
      ok, expected: expectedText, actual: actualText,
      note: e.note || null,
    });
  }
  const failed = checks.filter((k) => !k.ok);
  return {
    ...base,
    state: failed.length ? "fail" : "pass",
    durationMs: Date.now() - started,
    checks,
    reason: failed.length
      ? `${failed.length} expectation(s) no longer hold: ${failed.map((k) => `${k.path} expected ${k.expected}, got ${k.actual}`).join("; ")}`
      : null,
    // A case may also report what it read, so the same operation feeds the
    // evidence-density detector rather than needing its own instrumentation.
    evidence: result?.__evidence ? evidenceDensity(result.__evidence) : null,
  };
}

/**
 * Run every case for one agent.
 *
 * The verdict is deliberately blunt, because this is the signal a human acts on:
 *   fail         — at least one invariant broke. Something changed.
 *   pass         — every case that could run, ran and held.
 *   inconclusive — nothing could run. NOT a pass, and it says so.
 */
export async function runAgentCanary(agentId, cases, ctx = {}) {
  const invalid = cases.flatMap((c) => validateCase(c, agentId));
  if (invalid.length) {
    return {
      agentId, verdict: "invalid", ranAt: new Date().toISOString(),
      cases: [], passed: 0, failed: 0, skipped: 0, errored: 0,
      headline: `Canary definition is not valid: ${invalid[0]}`,
      invalid,
    };
  }

  const results = [];
  for (const c of cases) results.push(await runCase(c, ctx));

  const passed = results.filter((r) => r.state === "pass").length;
  const failed = results.filter((r) => r.state === "fail").length;
  const errored = results.filter((r) => r.state === "error").length;
  const skipped = results.filter((r) => r.state === "skip").length;
  const ran = passed + failed + errored;

  const verdict = failed || errored ? "fail" : ran === 0 ? "inconclusive" : "pass";
  const headline =
    verdict === "fail"
      ? `${failed + errored} of ${ran} case(s) that ran no longer hold — ${results.find((r) => r.state === "fail" || r.state === "error")?.title}.`
      : verdict === "inconclusive"
        ? `No case could run (${skipped} skipped). This agent's correctness is unverified, not verified.`
        : `${passed} case(s) hold${skipped ? `, ${skipped} skipped` : ""}.`;

  return {
    agentId, verdict, ranAt: new Date().toISOString(),
    cases: results, passed, failed, errored, skipped, ran,
    durationMs: results.reduce((t, r) => t + (r.durationMs || 0), 0),
    headline,
    // The first thing to look at, which is never a skip.
    topFailure: results.find((r) => r.state === "fail" || r.state === "error") || null,
  };
}

/** Fleet roll-up, shaped for the governance lens's stat row. */
export function canaryFleet(runs = []) {
  const failing = runs.filter((r) => r.verdict === "fail");
  const inconclusive = runs.filter((r) => r.verdict === "inconclusive");
  const passing = runs.filter((r) => r.verdict === "pass");
  const invalid = runs.filter((r) => r.verdict === "invalid");
  return {
    agents: runs.length,
    passing: passing.length,
    failing: failing.length,
    inconclusive: inconclusive.length,
    invalid: invalid.length,
    // Agents with no canary at all are the real gap and are counted by the
    // caller, which is the only thing that knows the full agent list.
    headline: failing.length
      ? `${failing.length} agent(s) are answering differently than they used to: ${failing.slice(0, 3).map((r) => r.agentId).join(", ")}.`
      : inconclusive.length
        ? `No agent is failing, but ${inconclusive.length} could not be checked at all.`
        : runs.length
          ? `All ${passing.length} agent(s) with a canary still answer correctly.`
          : "No agent has a canary. Nothing here is checking whether any answer is right.",
  };
}
