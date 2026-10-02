/**
 * Detecting an agent that is malfunctioning while reporting success.
 *
 * Every detector that existed before this file keys off one of two things: a
 * call threw, or a manifest field was never declared. Both are worth having and
 * neither sees the failure that actually costs you a customer:
 *
 *   "Workload Modernization assessed 400 machines and found no blockers"
 *   — because vCenter returned an empty list.
 *
 * That call did not throw. `query-tracer.js` records it as `status: "success"`,
 * the error rate stays at 0%, and every governance check passes. The agent is
 * malfunctioning and everything about it looks healthy.
 *
 * Two signals here catch that class, and both are pure functions so they can be
 * tested against the cases that matter rather than observed in production:
 *
 *   evidenceDensity()  — how much did it READ, against how confident it SOUNDED
 *   latencyVerdict()   — is it slower than ITSELF, not than an arbitrary number
 *
 * The rule both obey, and the one this codebase keeps everywhere: an operation
 * that reported nothing is reported as UNINSTRUMENTED. Never as healthy. A
 * detector that answers "fine" when it was given no data is worse than no
 * detector, because somebody will trust it.
 */

// ── Evidence density ──────────────────────────────────────────────────────

/**
 * How confident an answer sounded. Ordered, because the comparison that matters
 * is "did the confidence outrun the evidence".
 */
const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };

/**
 * Score one operation's evidence against its confidence.
 *
 * @param {object} e
 * @param {number} e.read        facts actually read (machines inspected, pods
 *                               listed, files parsed — whatever the agent counts)
 * @param {number} e.expected    facts it set out to read. read/expected is
 *                               coverage; expected 0 with read 0 means there was
 *                               genuinely nothing to look at, which is different
 *                               from failing to look.
 * @param {string} e.confidence  "low" | "medium" | "high" — what the agent told
 *                               the user
 * @param {string[]} e.unread    why things could not be read, if it knows
 * @param {boolean} e.concluded  did it reach a verdict the user would act on?
 *                               An agent that answered "I could not tell you" on
 *                               no evidence is behaving correctly.
 *
 * @returns {{state, severity, coverage, headline, detail}}
 *   state: "uninstrumented" | "sound" | "thin" | "unsupported" | "nothing-to-read"
 */
export function evidenceDensity(e) {
  if (!e || (e.read == null && e.expected == null && !e.confidence)) {
    return {
      state: "uninstrumented", severity: null, coverage: null,
      headline: "This operation did not report what it read.",
      detail: "Evidence density is unknown for this agent — it is not instrumented, which is not the same as healthy. Pass `evidence` to traceAgentOperation() to turn this detector on.",
    };
  }

  const read = Number.isFinite(e.read) ? e.read : null;
  const expected = Number.isFinite(e.expected) ? e.expected : null;
  const conf = String(e.confidence || "").toLowerCase();
  const rank = CONFIDENCE_RANK[conf] || null;
  const concluded = e.concluded !== false;
  const coverage = expected > 0 && read != null ? Math.round((read / expected) * 100) / 100 : null;
  const unread = Array.isArray(e.unread) ? e.unread : [];

  // Nothing was there to read. An empty estate is a legitimate answer and must
  // not be scored as a failure to look — but it is only legitimate when the
  // agent did not then claim to have found something.
  if (expected === 0 && (read === 0 || read == null)) {
    return {
      state: "nothing-to-read", severity: concluded && rank === 3 ? "serious" : null, coverage: null,
      headline: concluded && rank === 3
        ? "Reported high confidence with nothing to read."
        : "There was nothing to read, and it said so.",
      detail: concluded && rank === 3
        ? "The operation had no inputs at all and still returned a high-confidence conclusion. Whatever that conclusion is, it was not derived from anything."
        : "No inputs were available for this operation. Reported as empty rather than as clean.",
    };
  }

  // The signature failure: a verdict the user would act on, built on nothing.
  if (concluded && read === 0) {
    return {
      state: "unsupported", severity: "critical", coverage: 0,
      headline: `Reached a conclusion having read nothing${expected ? ` of ${expected} expected input(s)` : ""}.`,
      detail: `Every input failed or returned empty${unread.length ? ` (${unread.slice(0, 3).join("; ")})` : ""}, and the agent answered anyway. This is the failure mode an error rate cannot see: the call did not throw, so it is recorded as a success. Treat the answer as unreliable and find out why the reads returned nothing.`,
    };
  }

  // Confidence that outran coverage. High confidence over a third of the
  // estate is a claim about the estate that was not earned.
  if (coverage != null && rank === 3 && coverage < 0.5) {
    return {
      state: "unsupported", severity: "serious", coverage,
      headline: `High confidence over ${Math.round(coverage * 100)}% coverage.`,
      detail: `Read ${read} of ${expected} expected input(s) and still reported high confidence${unread.length ? `. Unread: ${unread.slice(0, 3).join("; ")}` : "."} Confidence is capped by what was read; this answer is not.`,
    };
  }

  if (coverage != null && coverage < 0.5) {
    return {
      state: "thin", severity: "warning", coverage,
      headline: `Answered over ${Math.round(coverage * 100)}% coverage.`,
      detail: `Read ${read} of ${expected} expected input(s)${unread.length ? ` (${unread.slice(0, 3).join("; ")})` : ""}. The answer may be right, but it is based on less than half the estate — say so wherever it is shown.`,
    };
  }

  return {
    state: "sound", severity: null, coverage,
    headline: coverage != null
      ? `Read ${read} of ${expected} input(s)${rank ? `, reported ${conf} confidence` : ""}.`
      : `Read ${read} input(s)${rank ? `, reported ${conf} confidence` : ""}.`,
    detail: null,
  };
}

/**
 * Roll evidence density up over many operations of one agent.
 *
 * The fleet question is not "was this call thin" but "does this agent keep
 * answering on nothing", which is a rate, not an event.
 */
export function evidenceProfile(rows = []) {
  const scored = rows.map((r) => ({ row: r, d: evidenceDensity(r) }));
  const instrumented = scored.filter((s) => s.d.state !== "uninstrumented");
  if (instrumented.length === 0) {
    return {
      instrumented: false, operations: rows.length,
      unsupported: 0, thin: 0, sound: 0,
      state: "uninstrumented",
      headline: rows.length
        ? `None of ${rows.length} operation(s) reported what they read.`
        : "No operations recorded.",
    };
  }
  const n = instrumented.length;
  const unsupported = instrumented.filter((s) => s.d.state === "unsupported").length;
  const thin = instrumented.filter((s) => s.d.state === "thin").length;
  const sound = instrumented.filter((s) => s.d.state === "sound").length;
  const rate = unsupported / n;
  const state = unsupported === 0 && thin === 0 ? "sound"
    : rate >= 0.25 ? "unsupported"
    : unsupported > 0 ? "degraded"
    : "thin";
  return {
    instrumented: true,
    operations: rows.length,
    measured: n,
    unsupported, thin, sound,
    unsupportedRate: Math.round(rate * 1000) / 10,
    state,
    headline: unsupported
      ? `${unsupported} of ${n} measured operation(s) reached a conclusion on little or no evidence.`
      : thin
        ? `${thin} of ${n} measured operation(s) answered over thin coverage.`
        : `All ${n} measured operation(s) answered from the evidence they read.`,
  };
}

// ── Latency regression ────────────────────────────────────────────────────

/**
 * Is an agent slower than it used to be?
 *
 * Against ITSELF, not against a fixed threshold. A fixed number is wrong for
 * every agent at once: 8 seconds is a hang for a tool that lists pods and fast
 * for one that inspects 400 guests. The agent's own recent past is the only
 * baseline that means anything.
 *
 * @param {object} p
 * @param {number} p.recentMs      mean duration over the recent window
 * @param {number} p.baselineMs    mean duration over the preceding window
 * @param {number} p.recentSamples invocations in the recent window
 * @param {number} p.baselineSamples invocations in the baseline window
 * @param {number} [p.minSamples]  below this, say so instead of guessing
 */
export function latencyVerdict(p = {}) {
  const MIN = Number.isFinite(p.minSamples) ? p.minSamples : 5;
  const { recentMs, baselineMs, recentSamples = 0, baselineSamples = 0 } = p;

  if (!Number.isFinite(recentMs) || !Number.isFinite(baselineMs)) {
    return { state: "unknown", severity: null, ratio: null,
      headline: "No timing data to compare.",
      detail: "Latency regression needs both a recent and a baseline window. One of them is empty." };
  }
  // Two slow calls are not a trend. Saying "3x slower" off a sample of one is
  // how a health panel earns the reputation of crying wolf.
  if (recentSamples < MIN || baselineSamples < MIN) {
    return { state: "insufficient-data", severity: null, ratio: null,
      headline: `Too few invocations to compare (${recentSamples} recent, ${baselineSamples} baseline; ${MIN} needed).`,
      detail: "Reported as not enough data rather than as no regression." };
  }
  if (baselineMs <= 0) {
    return { state: "unknown", severity: null, ratio: null,
      headline: "Baseline duration is zero, so a ratio would be meaningless.", detail: null };
  }

  const ratio = Math.round((recentMs / baselineMs) * 100) / 100;
  const pct = Math.round((ratio - 1) * 100);
  const fmt = (ms) => (ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${Math.round(ms)}ms`);

  if (ratio >= 3) {
    return { state: "severe-regression", severity: "serious", ratio,
      headline: `${ratio}× slower than its own baseline (${fmt(baselineMs)} → ${fmt(recentMs)}).`,
      detail: "A change this large is usually a dependency that started timing out and retrying, not gradual drift. The calls still succeed, so nothing else reports it." };
  }
  if (ratio >= 1.5) {
    return { state: "regression", severity: "warning", ratio,
      headline: `${pct}% slower than its own baseline (${fmt(baselineMs)} → ${fmt(recentMs)}).`,
      detail: "Slower but still succeeding. Worth a look before it becomes a timeout." };
  }
  if (ratio <= 0.5) {
    // Faster is not automatically good: an agent that suddenly returns in a
    // tenth of the time is often one that stopped doing the work.
    return { state: "suspiciously-fast", severity: "warning", ratio,
      headline: `${Math.round((1 - ratio) * 100)}% faster than its own baseline (${fmt(baselineMs)} → ${fmt(recentMs)}).`,
      detail: "A large speed-up usually means less work was done — a cache standing in for a read, or a dependency returning empty. Check the evidence density for the same window before celebrating." };
  }
  return { state: "steady", severity: null, ratio,
    headline: `Within ${Math.abs(pct)}% of its own baseline (${fmt(recentMs)}).`, detail: null };
}

// ── Delegation depth ──────────────────────────────────────────────────────

/**
 * Has an agent chain gone deeper than its manifest allows, or started looping?
 *
 * `maxDelegationDepth` has been in the manifest schema and rendered in the
 * governance lens since it was written, and nothing has ever evaluated it.
 *
 * @param {string[]} chain  agent ids, outermost first
 * @param {number|null} max declared maximum, or null when undeclared
 */
export function delegationVerdict(chain = [], max = null) {
  const depth = chain.length;
  // A cycle is a defect whatever the declared maximum is: an agent calling
  // something that calls it back will exhaust the budget before it answers.
  const seen = new Set();
  let cycle = null;
  for (const id of chain) {
    if (seen.has(id)) { cycle = id; break; }
    seen.add(id);
  }
  if (cycle) {
    return { state: "cycle", severity: "critical", depth, max,
      headline: `Delegation cycle: ${cycle} appears twice in ${chain.join(" → ")}.`,
      detail: "An agent is calling something that calls it back. This does not terminate on its own; it terminates when a budget or a timeout runs out." };
  }
  if (max == null) {
    return { state: "undeclared", severity: null, depth, max: null,
      headline: `Delegated ${depth} level(s) deep; no maximum is declared.`,
      detail: "Declare governance.maxDelegationDepth so there is something to enforce." };
  }
  if (depth > max) {
    return { state: "exceeded", severity: "critical", depth, max,
      headline: `Delegated ${depth} levels deep, past its declared maximum of ${max}: ${chain.join(" → ")}.`,
      detail: "The chain was refused at this point. Either the declaration is too low for the work, or an agent is delegating further than anybody sanctioned." };
  }
  return { state: "within-limit", severity: null, depth, max,
    headline: `Delegated ${depth} of a permitted ${max} level(s).`, detail: null };
}

// ── Token budget ──────────────────────────────────────────────────────────

/**
 * Has an agent spent past its declared monthly budget?
 *
 * `budgetTokensPerMonth` and `budgetAction` have also only ever been displayed.
 *
 * @param {number|null} spent   tokens this calendar month
 * @param {number|null} budget  declared monthly budget
 * @param {string|null} onBreach "warn" | "block" — what the manifest asked for
 */
export function budgetVerdict(spent, budget, onBreach = null) {
  if (!Number.isFinite(budget) || budget <= 0) {
    return { state: "undeclared", severity: null, used: null, budget: null, action: null,
      headline: "No monthly token budget is declared.",
      detail: "Declare governance.budgetTokensPerMonth and budgetAction so runaway spend has something to hit." };
  }
  if (!Number.isFinite(spent)) {
    return { state: "unmeasured", severity: null, used: null, budget, action: null,
      headline: `Budget of ${budget.toLocaleString()} tokens is declared, but this agent's spend is not attributed.`,
      detail: "Spend cannot be compared to the budget until the agent's model calls are attributed to it. Reported as unmeasured, not as within budget." };
  }
  const used = Math.round((spent / budget) * 1000) / 10;
  // "block" is the only action that stops anything. An unrecognised or missing
  // action is reported as warn-only, never assumed to be enforcing.
  const action = onBreach === "block" ? "block" : "warn";
  if (spent >= budget) {
    return { state: "breached", severity: action === "block" ? "critical" : "serious",
      used, budget, spent, action,
      headline: `Spent ${spent.toLocaleString()} of ${budget.toLocaleString()} tokens this month (${used}%).`,
      detail: action === "block"
        ? "The manifest asks for this agent to be blocked on breach, and it is being blocked."
        : "The manifest asks only for a warning on breach, so this agent is still running. Set governance.budgetAction to \"block\" to stop it." };
  }
  if (spent >= budget * 0.8) {
    return { state: "approaching", severity: "warning", used, budget, spent, action,
      headline: `Spent ${used}% of its monthly token budget.`,
      detail: `${(budget - spent).toLocaleString()} tokens left this month. On breach this agent will be ${action === "block" ? "blocked" : "warned about only"}.` };
  }
  return { state: "within-budget", severity: null, used, budget, spent, action,
    headline: `Spent ${used}% of its monthly token budget.`, detail: null };
}
