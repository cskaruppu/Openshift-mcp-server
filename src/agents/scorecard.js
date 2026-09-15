/**
 * One number per agent, and the specific reasons it is not higher.
 *
 * Sixteen agents fit in a table. Sixty do not, and the question stops being
 * "what is the posture of this agent" and becomes "which of these sixty should
 * I look at first". A scorecard answers that, and a ranked worklist is the only
 * form of governance that survives scale — a table of pills is read once.
 *
 * THREE RULES, and they are the same ones the rest of this codebase holds.
 *
 * 1. A CHECK THAT COULD NOT RUN IS NOT A PASS. It scores nothing and is
 *    excluded from the denominator, and `coverage` says how much of the
 *    scorecard was actually measurable. A score of 100% over four of nine
 *    checks is not a healthy agent; it is an unexamined one, and the grade
 *    says so.
 *
 * 2. EVERY FAILED CHECK NAMES ITS FIX. A score with no next action is a
 *    number to argue with rather than work from.
 *
 * 3. WEIGHTS ENCODE CONSEQUENCE, NOT EFFORT. Having an accountable owner
 *    matters more than having usage examples, and the weights say so, so the
 *    ranking pushes people toward what actually reduces risk.
 *
 * Everything here is pure: posture in, scorecard out.
 */

/**
 * The checks, heaviest first.
 *
 * Each returns "pass" | "fail" | "unknown", plus the sentence to show when it
 * is not a pass. `unknown` is for a check that could not be evaluated — not for
 * one that evaluated to "no".
 */
export const CHECKS = [
  {
    id: "owner", weight: 5, label: "Has an accountable owner",
    run: (a) => (a.owner ? "pass" : "fail"),
    fix: "Nobody is accountable for what this agent does. Claim it, or declare governance.owner in its manifest.",
  },
  {
    id: "blast-radius", weight: 5, label: "Declares what it can do to the estate",
    run: (a) => (a.blastRadius ? "pass" : "fail"),
    fix: "Blast radius is undeclared, so nothing can tell whether this agent reads, changes or destroys. Declare governance.blastRadius.",
  },
  {
    id: "tools-served", weight: 4, label: "Its tools actually exist",
    // null means the probe could not run. An agent with no tools at all is a
    // different failure and is caught by the "does anything" check below.
    run: (a) => (a.missingTools == null ? "unknown" : a.missingTools.length ? "fail" : "pass"),
    fix: (a) => `Declares ${a.missingTools.length} tool(s) that are not served over MCP (${a.missingTools.slice(0, 3).join(", ")}${a.missingTools.length > 3 ? "…" : ""}). A client connecting to this agent gets an empty tool list and no error.`,
  },
  {
    id: "reconciled", weight: 4, label: "Behaves inside its declaration",
    run: (a) => (a.reconciled == null ? "unknown" : a.reconciled ? "pass" : "fail"),
    fix: "Called a tool or reached a host it never declared. Either the manifest has drifted from the code, or the agent is doing something nobody sanctioned.",
  },
  {
    id: "trust", weight: 3, label: "Declares a trust tier",
    run: (a) => (a.trustTier ? "pass" : "fail"),
    fix: "Trust tier is undeclared. Declare governance.trustTier so first-party and external agents are not governed identically.",
  },
  {
    id: "autonomy", weight: 3, label: "Declares how far it may act alone",
    run: (a) => (a.autonomy ? "pass" : "fail"),
    fix: "Autonomy is undeclared. Declare governance.autonomyLevel — advisory, propose-and-wait, or act-within-policy.",
  },
  {
    id: "certified", weight: 3, label: "Certification is current",
    run: (a) => {
      const s = a.certification?.state;
      if (s === "current") return "pass";
      if (s === "expiring") return "pass";       // still valid; the lens warns separately
      return "fail";                              // never, expired, or no expiry set
    },
    fix: (a) => (a.certification?.state === "expired"
      ? "Certification has lapsed. Re-certify and set governance.recertifyBy."
      : a.certification?.state === "no-expiry"
        ? "Certified with no expiry date. Certification that never expires is not certification — set governance.recertifyBy."
        : "Never certified. Review the agent and set governance.certifiedAt and recertifyBy."),
  },
  {
    id: "in-use", weight: 2, label: "Has been used recently",
    run: (a) => {
      if (a.lastUsed == null) return "unknown";   // no trace data at all
      const days = (Date.now() - Date.parse(a.lastUsed)) / 86400000;
      return Number.isFinite(days) && days <= 90 ? "pass" : "fail";
    },
    fix: "Not invoked in over 90 days. An agent nobody calls is surface with no benefit — retire it, or find out why it is unused.",
  },
  {
    id: "reliable", weight: 2, label: "Runs without erroring",
    run: (a) => (a.errorRate == null ? "unknown" : a.errorRate <= 5 ? "pass" : "fail"),
    fix: (a) => `${a.errorRate}% of invocations failed. Anything above 5% is a defect, not noise.`,
  },
  {
    id: "documented", weight: 1, label: "Shows someone how to use it",
    run: (a) => (a.hasExamples ? "pass" : "fail"),
    fix: "No usage example. A catalog entry without one gets read and not adopted — add `examples` to the manifest.",
  },
];

const BANDS = [
  { min: 90, grade: "A", meaning: "Governed and in good order." },
  { min: 75, grade: "B", meaning: "Sound, with gaps worth closing." },
  { min: 55, grade: "C", meaning: "Usable, but under-governed." },
  { min: 30, grade: "D", meaning: "Largely undeclared." },
  { min: 0,  grade: "E", meaning: "Nothing is known about this agent." },
];

/**
 * Score one agent.
 *
 * @param {object} a  a flattened view: owner, blastRadius, trustTier, autonomy,
 *                    certification, reconciled, missingTools, lastUsed,
 *                    errorRate, hasExamples
 */
export function scoreAgent(a = {}) {
  const checks = [];
  let earned = 0, possible = 0, unknown = 0;

  for (const c of CHECKS) {
    const state = c.run(a);
    if (state === "unknown") {
      unknown++;
      checks.push({ id: c.id, label: c.label, state, weight: c.weight,
        detail: "This could not be checked, so it counts neither for nor against." });
      continue;
    }
    possible += c.weight;
    if (state === "pass") earned += c.weight;
    checks.push({
      id: c.id, label: c.label, state, weight: c.weight,
      detail: state === "fail" ? (typeof c.fix === "function" ? c.fix(a) : c.fix) : null,
    });
  }

  // Scored over what could be measured, never over the full set — an agent
  // whose checks mostly could not run must not be flattered by the ones that
  // did. `coverage` is published beside the score so the two are read together.
  const score = possible ? Math.round((earned / possible) * 100) : 0;
  const band = BANDS.find((b) => score >= b.min) || BANDS.at(-1);
  const total = CHECKS.length;
  const ran = total - unknown;

  return {
    score: possible ? score : null,
    grade: possible ? band.grade : null,
    meaning: possible ? band.meaning : "Nothing could be measured for this agent.",
    earned, possible,
    coverage: { ran, total, unknown },
    // Confidence is about the scorecard, not the agent. A high score over half
    // the checks is a weaker claim than the same score over all of them, and
    // collapsing the two into one number is how a dashboard starts lying.
    confidence: ran === total ? "full" : ran >= total * 0.7 ? "partial" : "low",
    checks,
    // The heaviest failure, which is the one sentence worth putting on a row.
    topFix: checks.filter((c) => c.state === "fail")
      .sort((x, y) => y.weight - x.weight)[0]?.detail || null,
  };
}

/** The fleet view: distribution, the worst offenders, and what to fix first. */
export function scoreFleet(scored = []) {
  const withScore = scored.filter((s) => s.score != null);
  const dist = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const s of withScore) if (s.grade) dist[s.grade]++;

  // Which single fix would lift the most agents. At scale this matters more
  // than any individual score: it turns a list of sixty problems into one job.
  const byCheck = new Map();
  for (const s of scored) {
    for (const c of s.checks || []) {
      if (c.state !== "fail") continue;
      const e = byCheck.get(c.id) || { id: c.id, label: c.label, weight: c.weight, agents: 0 };
      e.agents++;
      byCheck.set(c.id, e);
    }
  }
  const biggestWin = [...byCheck.values()]
    .sort((a, b) => (b.agents * b.weight) - (a.agents * a.weight))[0] || null;

  const average = withScore.length
    ? Math.round(withScore.reduce((t, s) => t + s.score, 0) / withScore.length)
    : null;

  return {
    agents: scored.length,
    scored: withScore.length,
    average,
    distribution: dist,
    lowConfidence: scored.filter((s) => s.confidence === "low").length,
    biggestWin,
    headline: !withScore.length
      ? "No agent could be scored."
      : biggestWin
        ? `Fleet health ${average}%. ${biggestWin.agents} agent(s) fail the same check: ${biggestWin.label.toLowerCase()}.`
        : `Fleet health ${average}%. Every agent passes every check that could be run.`,
  };
}
