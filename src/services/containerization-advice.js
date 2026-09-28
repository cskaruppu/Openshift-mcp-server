// ---------------------------------------------------------------------------
// What the model is allowed to do here
// ---------------------------------------------------------------------------
/**
 * The model explains. It does not decide, and it is never a source of fact.
 *
 * This matters more here than anywhere else in the product, because the
 * question being asked — "is this OS supported on OpenShift Virtualization" —
 * is exactly the kind a language model answers fluently and wrongly. Its
 * training data has a vintage nobody can see, Red Hat revises the certified
 * list with each minor release, and a confident wrong answer about a support
 * level does not stay in a chat window: it goes into a business case, and from
 * there into a contract.
 *
 * So the division is enforced by construction, not by asking nicely:
 *
 *   FACTS  come from the matrix (dated, sourced), the cluster (versions, the
 *          boot sources Red Hat actually ships) and the process list. They are
 *          computed before the model is called and passed to it as data.
 *   MODEL  gets those facts fenced as untrusted input and is asked only to
 *          correlate, prioritise and explain. Every field it returns is prose.
 *          It returns no level, no verdict, no version and no count.
 *
 * If the model is unavailable the caller gets null and loses nothing but the
 * narrative — every number on the screen was computed without it.
 */

import { classifyJSON, llmEnabled } from "./llm.js";
import { fenceUntrusted, UNTRUSTED_GUARD } from "./untrusted.js";

const SYSTEM = `You advise a platform team assessing whether virtual machines should become containers on OpenShift.

You are given FACTS that were computed from a live cluster and a dated support matrix. Your job is to correlate and explain them.

ABSOLUTE RULES:
- NEVER state whether an operating system is supported, certified or end-of-life. That comes from the dated matrix you were given, and your training data is of unknown vintage. If asked in the facts, repeat what the matrix says and attribute it.
- NEVER invent a version number, a count, a date or a product name that is not in the facts.
- NEVER contradict a verdict in the facts. If you think one looks wrong, say what additional evidence would settle it.
- If the facts are thin, say what is missing rather than filling it in.

Output ONLY a JSON object:
{
  "headline": "one sentence a platform lead would repeat in a meeting",
  "themes": [{"title": "...", "detail": "...", "machines": "which ones, from the facts"}],
  "sequence": ["what to do first", "then", "then"],
  "risks": [{"risk": "...", "why": "..."}],
  "confirm": ["what a human should verify before this goes in a document"]
}
Keep every string under 300 characters. Three to five themes. Prefer naming a specific machine or count from the facts over generalities.
${UNTRUSTED_GUARD}`;

/**
 * Reduce the assessment to the facts worth spending tokens on.
 *
 * Deliberately small: a fleet of 2000 machines does not fit and does not need
 * to. The model needs the shape of the estate, not its contents — and a
 * digest also means no machine name, address or command line beyond what is
 * already in a finding leaves the cluster.
 */
export function digestForAdvice({ fleet = null, posture = null } = {}) {
  const d = {};
  if (fleet) {
    d.estate = {
      distinctMachines: fleet.distinct ?? fleet.machines?.length ?? null,
      observations: fleet.observations ?? null,
      candidates: fleet.funnel?.candidates ?? null,
      candidatePctOfEstate: fleet.funnel?.candidatePctOfEstate ?? null,
      candidatePctOfAssessed: fleet.funnel?.candidatePctOfAssessed ?? null,
      notAssessed: fleet.funnel?.notAssessed ?? null,
    };
    d.topReasons = (fleet.portfolio?.topBlockers || []).slice(0, 8)
      .map((b) => ({ reason: b.title, machines: b.count, blocks: b.blocks, examples: (b.machines || []).slice(0, 5) }));
    d.runtimes = (fleet.portfolio?.byRuntime || []).slice(0, 8);
    d.clusterDisagreements = (fleet.conflicts || []).length;
    d.dependencies = fleet.dependencies?.supplied
      ? { supplied: true, crossings: (fleet.dependencies.crossings || []).length }
      : { supplied: false };
  }
  if (posture) {
    d.operatingSystems = (posture.distributions || []).slice(0, 12).map((r) => ({
      distro: r.distro, machines: r.count,
      matrixSays: r.level, tier: r.tierLabel || r.tier || null,
      clusterShipsImage: Boolean(r.image), corroboration: r.status,
    }));
    d.matrix = {
      asOf: posture.matrix?.asOf || null,
      ageDays: posture.matrix?.age?.days ?? null,
      freshness: posture.matrix?.age?.stale || null,
      source: posture.matrix?.url || null,
    };
    d.cluster = { openshift: posture.cluster?.openshift || null, virtualization: posture.cluster?.virtualization || null };
    d.machinesWithNoReportedOs = posture.unreported ?? null;
  }
  return d;
}

/**
 * Narrative over facts. Returns null when no model is configured.
 *
 * Every returned object carries `advisory: true` and the digest it was given,
 * so a reader can check the narrative against the numbers it claims to
 * describe — which is the only way advice like this is worth having.
 */
export async function adviseOnAssessment({ fleet = null, posture = null } = {}) {
  if (!llmEnabled()) {
    return {
      advisory: true, available: false, advice: null,
      reason: "No model is configured, so no narrative was generated. Every figure in this assessment was computed without one.",
    };
  }
  const facts = digestForAdvice({ fleet, posture });
  if (!Object.keys(facts).length) {
    return { advisory: true, available: false, advice: null, reason: "There is nothing assessed to advise on yet." };
  }

  try {
    const advice = await classifyJSON({
      system: SYSTEM,
      prompt: `Correlate and explain these facts:\n\n${fenceUntrusted("ASSESSMENT_FACTS", JSON.stringify(facts))}`,
    });
    if (!advice || typeof advice !== "object") {
      return { advisory: true, available: false, advice: null, reason: "The model did not return usable advice. The assessment is unaffected." };
    }
    return {
      advisory: true, available: true, advice: sanitise(advice), facts,
      caveat: "Narrative only. Every number, verdict and support level on this page was computed from the cluster and the dated matrix, not from the model.",
    };
  } catch (e) {
    return { advisory: true, available: false, advice: null, reason: `The model could not be reached: ${e.message}. The assessment is unaffected.` };
  }
}

/**
 * Trim the model's output to the shape the console renders.
 *
 * Length-capped rather than trusted: a model that returns three paragraphs
 * where a sentence was asked for turns a panel into a wall, and the prompt
 * asking nicely is not a guarantee.
 */
function sanitise(a) {
  const str = (v, n = 300) => (typeof v === "string" ? v.slice(0, n) : null);
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  return {
    headline: str(a.headline),
    themes: arr(a.themes, 6).map((t) => ({ title: str(t?.title, 120), detail: str(t?.detail), machines: str(t?.machines, 160) })).filter((t) => t.title),
    sequence: arr(a.sequence, 8).map((s) => str(s)).filter(Boolean),
    risks: arr(a.risks, 6).map((r) => ({ risk: str(r?.risk, 160), why: str(r?.why) })).filter((r) => r.risk),
    confirm: arr(a.confirm, 8).map((s) => str(s)).filter(Boolean),
  };
}
