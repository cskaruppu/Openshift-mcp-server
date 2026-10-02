/**
 * The sweep: run every detector, decide what it means, and tell somebody.
 *
 * Until now the governance lens was a page. Everything it knows, it knew only
 * while somebody was looking at it — which means an agent could start answering
 * wrongly on a Friday evening and nothing would say so until a human happened
 * to open a tab. A detector nobody is watching is not a detector.
 *
 * So this runs on a timer and does four things:
 *
 *   1. Runs every canary — the only check that can see a WRONG answer.
 *   2. Reads the health signals behind the three detectors that used to be
 *      declared and never evaluated: egress, delegation depth, token budget.
 *   3. Scores evidence density and latency against each agent's own history.
 *   4. Raises an incident when something crosses from "worth knowing" to
 *      "somebody has to look at this", and resolves it when it clears.
 *
 * TWO THINGS IT IS CAREFUL ABOUT.
 *
 * DEDUPLICATION. The sweep runs every few hours; a fault that persists must not
 * produce an incident every time. One open incident per agent per fault, keyed
 * and remembered, updated rather than re-raised.
 *
 * NOT ACTING ON ITS OWN. It applies automatic quarantine only to agents whose
 * manifest opted in (`governance.autoQuarantine: true`). For everything else it
 * records a RECOMMENDATION with its evidence and leaves the decision to a
 * person. An agent that takes itself out of production on a false positive at
 * 3am is a worse outage than the one it was guarding against, and a brand new
 * detector is exactly where false positives live.
 */

import { runAllCanaries, failingSince, canaryCoverage } from "./canary-store.js";
import { evidenceProfile, latencyVerdict, budgetVerdict } from "./health-signals.js";
import { quarantineRecommendation, quarantineAgent, getQuarantine, isQuarantined } from "./quarantine.js";
import { invalidateGatekeeper } from "./gatekeeper.js";

const DEFAULT_INTERVAL_MS = Number(process.env.AGENT_HEALTH_SWEEP_MS || 4 * 60 * 60 * 1000);
let _timer = null;
let _last = null;
/** agentId|code -> { incidentId, raisedAt } — so a persistent fault raises once. */
const _open = new Map();

/** What severity a finding deserves as an incident, or null for "do not raise". */
function incidentSeverity(finding) {
  if (finding.severity === "critical") return "sev2";
  if (finding.severity === "serious") return "sev3";
  return null;   // warnings stay on the panel; an incident for every warning is noise
}

async function raise(agentId, code, title, description, severity) {
  const key = `${agentId}|${code}`;
  if (_open.has(key)) return _open.get(key);        // already raised, not again
  try {
    const { declareIncident } = await import("../services/incident-manager.js");
    const inc = await declareIncident({
      title, description, severity,
      affectedServices: [agentId],
      declaredBy: "agent-health-sweep",
    });
    const rec = { incidentId: inc?.incident_id || inc?.incidentId || null, raisedAt: new Date().toISOString() };
    _open.set(key, rec);
    return rec;
  } catch (e) {
    console.error(`[agent-health] could not raise incident for ${key}: ${e.message}`);
    return null;
  }
}

async function clear(agentId, code, note) {
  const key = `${agentId}|${code}`;
  const rec = _open.get(key);
  if (!rec?.incidentId) { _open.delete(key); return; }
  try {
    const { resolveIncident } = await import("../services/incident-manager.js");
    await resolveIncident(rec.incidentId, { actor: "agent-health-sweep", resolutionNote: note });
  } catch (e) {
    console.error(`[agent-health] could not resolve ${rec.incidentId}: ${e.message}`);
  }
  _open.delete(key);
}

/**
 * Assess one agent from everything measured about it.
 * Pure apart from the canary history lookup, so the shape is easy to test.
 */
export async function assessAgent({ manifest, posture, canary, signals, days = 7 }) {
  const g = manifest?.governance || {};
  const id = manifest?.id;

  const evidence = evidenceProfile(signals?.evidence || []);
  const latency = latencyVerdict({
    recentMs: signals?.recent?.avgMs,
    baselineMs: signals?.baseline?.avgMs,
    recentSamples: signals?.recent?.samples || 0,
    baselineSamples: signals?.baseline?.samples || 0,
  });
  const budget = budgetVerdict(
    signals?.tokensThisMonth ?? null,
    Number.isFinite(g.budgetTokensPerMonth) ? g.budgetTokensPerMonth : null,
    g.budgetAction || null
  );
  const failing = canary?.verdict === "fail" ? await failingSince(id) : null;

  const findings = [];
  if (canary?.verdict === "fail") {
    findings.push({
      code: "canary-failed", severity: "critical",
      message: canary.headline,
      detail: canary.topFailure
        ? `${canary.topFailure.title}: ${canary.topFailure.reason}. Why this matters: ${canary.topFailure.why}`
        : null,
      since: failing?.since || null, consecutive: failing?.consecutiveFailures || 1,
    });
  } else if (canary?.verdict === "inconclusive") {
    findings.push({
      code: "canary-inconclusive", severity: "warning",
      message: canary.headline,
      detail: "Every case was skipped, so this agent's correctness is unverified rather than verified. A skip is not a pass.",
    });
  } else if (!canary) {
    findings.push({
      code: "no-canary", severity: "warning",
      message: "This agent has no canary.",
      detail: "Nothing checks whether its answers are still right. Error rate and governance only see whether it ran.",
    });
  }

  if (evidence.state === "unsupported") {
    findings.push({ code: "evidence-unsupported", severity: "critical", message: evidence.headline,
      detail: "These calls did not throw, so the error rate is unaffected and every other check passes. Treat the answers as unreliable until the reads are fixed." });
  } else if (evidence.state === "degraded" || evidence.state === "thin") {
    findings.push({ code: "evidence-thin", severity: "warning", message: evidence.headline, detail: null });
  }

  if (latency.severity) {
    findings.push({ code: "latency-" + latency.state, severity: latency.severity, message: latency.headline, detail: latency.detail });
  }
  if (budget.severity) {
    findings.push({ code: "budget-" + budget.state, severity: budget.severity, message: budget.headline, detail: budget.detail });
  }

  // Egress the manifest never declared. This finding has existed in
  // governance.js since it was written and has never had data behind it.
  const declaredEgress = new Set(g.egress || []);
  const observedEgress = signals?.egress || null;
  const undeclaredEgress = observedEgress
    ? observedEgress.filter((h) => ![...declaredEgress].some((d) => h === d || h.includes(d) || d.includes(h)))
    : [];
  if (undeclaredEgress.length) {
    findings.push({
      code: "undeclared-egress", severity: "critical",
      message: `Sent traffic to ${undeclaredEgress.join(", ")}, which ${id} never declared.`,
      detail: "Either the manifest has drifted from what the agent does, or the agent is reaching somewhere nobody sanctioned.",
    });
  }

  const recommendation = quarantineRecommendation({
    canary, posture,
    evidence, budget, failing,
    // The posture's own findings matter here too — undeclared tools come from it.
    ...(undeclaredEgress.length ? { posture: { ...posture, findings: [
      { code: "undeclared-egress", severity: "critical", message: `Sent traffic to ${undeclaredEgress.join(", ")}, which ${id} never declared.` },
      ...(posture?.findings || []),
    ] } } : {}),
  });

  const worst = findings.find((f) => f.severity === "critical") || findings.find((f) => f.severity === "serious") || null;
  return {
    agentId: id,
    state: worst ? (worst.severity === "critical" ? "malfunctioning" : "degraded")
      : findings.length ? "watch" : "healthy",
    findings,
    canary: canary ? { verdict: canary.verdict, headline: canary.headline, ranAt: canary.ranAt, failing } : null,
    evidence, latency, budget,
    egress: { declared: [...declaredEgress], observed: observedEgress, undeclared: undeclaredEgress },
    recommendation,
    headline: worst ? worst.message
      : findings.length ? findings[0].message
      : "Answering correctly, within its declaration, on the evidence it reads.",
  };
}

/**
 * One sweep over the whole fleet.
 *
 * @param {object} o
 * @param {boolean} o.act  apply automatic quarantine and raise incidents.
 *                         False gives a dry run — the same assessment with
 *                         nothing changed, which is what the console's
 *                         "run now" button uses before anybody commits.
 */
export async function sweepAgentHealth({ days = 7, act = true } = {}) {
  const started = Date.now();
  const { getAgents } = await import("./registry.js");
  const agents = await getAgents();

  const { runs } = await runAllCanaries();
  const canaryBy = new Map(runs.map((r) => [r.agentId, r]));

  let signalsBy = new Map();
  try {
    const { getAgentHealthSignals } = await import("../services/query-tracer.js");
    signalsBy = await getAgentHealthSignals({ days, baselineDays: 30 });
  } catch (e) {
    console.error("[agent-health] health signals unavailable:", e.message);
  }

  let tokens = new Map();
  try {
    const { getAgentTokenUsage } = await import("../services/telemetry.js");
    const now = new Date();
    const d = Math.max(1, Math.ceil((Date.now() - new Date(now.getFullYear(), now.getMonth(), 1).getTime()) / 86400000));
    const u = await getAgentTokenUsage({ days: d });
    if (u?.available) tokens = u.byAgent;
  } catch { /* unattributed — budget reports unmeasured */ }

  let postures = new Map();
  try {
    const { agentPosture } = await import("./governance.js");
    for (const a of agents) postures.set(a.id, agentPosture(a, null, Date.now(), null));
  } catch { /* posture unavailable — the canary and signals still stand */ }

  const quarantined = await getQuarantine();
  const assessments = [];
  const actions = [];

  for (const a of agents) {
    const sig = signalsBy.get(a.id) || null;
    const assessment = await assessAgent({
      manifest: a,
      posture: postures.get(a.id) || null,
      canary: canaryBy.get(a.id) || null,
      signals: sig ? { ...sig, tokensThisMonth: tokens.get(a.id)?.totalTokens ?? null }
        : { tokensThisMonth: tokens.get(a.id)?.totalTokens ?? null },
      days,
    });
    const q = quarantined.get(a.id);
    assessment.quarantine = isQuarantined(q) ? q : null;
    assessments.push(assessment);

    if (!act) continue;

    // ── Incident, for anything that crossed the line ──
    const worst = assessment.findings.find((f) => incidentSeverity(f));
    if (worst) {
      const sev = incidentSeverity(worst);
      const rec = await raise(a.id, worst.code,
        `${a.name || a.id}: ${worst.message}`,
        [worst.detail, assessment.recommendation?.recommend
          ? `Quarantine is recommended: ${assessment.recommendation.detail}`
          : null].filter(Boolean).join("\n\n") || worst.message,
        sev);
      if (rec) actions.push({ agentId: a.id, action: "incident-raised", code: worst.code, incidentId: rec.incidentId, severity: sev });
    } else {
      // Nothing critical left: close whatever this agent had open.
      for (const key of [..._open.keys()]) {
        if (!key.startsWith(`${a.id}|`)) continue;
        const code = key.split("|")[1];
        await clear(a.id, code, `The ${code} condition cleared: ${assessment.headline}`);
        actions.push({ agentId: a.id, action: "incident-resolved", code });
      }
    }

    // ── Quarantine, only where the manifest opted in ──
    if (assessment.recommendation?.recommend && !assessment.quarantine) {
      if (a.governance?.autoQuarantine === true) {
        try {
          const q2 = await quarantineAgent(a.id, {
            reason: assessment.recommendation.reason,
            detail: assessment.recommendation.detail,
            evidence: assessment.recommendation.evidence,
            source: "automatic",
          });
          invalidateGatekeeper();
          assessment.quarantine = q2;
          actions.push({ agentId: a.id, action: "quarantined", reason: assessment.recommendation.reason });
        } catch (e) {
          console.error(`[agent-health] auto-quarantine of ${a.id} failed: ${e.message}`);
        }
      } else {
        actions.push({ agentId: a.id, action: "quarantine-recommended", reason: assessment.recommendation.reason,
          note: "Not applied: this agent's manifest does not set governance.autoQuarantine. A human applies it from the governance panel." });
      }
    }
  }

  const coverage = await canaryCoverage(agents.map((a) => a.id));
  const malfunctioning = assessments.filter((x) => x.state === "malfunctioning");
  const degraded = assessments.filter((x) => x.state === "degraded");

  _last = {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    agents: assessments.length,
    malfunctioning: malfunctioning.length,
    degraded: degraded.length,
    watch: assessments.filter((x) => x.state === "watch").length,
    healthy: assessments.filter((x) => x.state === "healthy").length,
    quarantined: assessments.filter((x) => x.quarantine).length,
    recommended: assessments.filter((x) => x.recommendation?.recommend && !x.quarantine).length,
    canaryCoverage: coverage,
    actions,
    assessments,
    headline: malfunctioning.length
      ? `${malfunctioning.length} agent(s) are malfunctioning: ${malfunctioning.slice(0, 3).map((x) => x.agentId).join(", ")}.`
      : degraded.length
        ? `${degraded.length} agent(s) are degraded; none are malfunctioning.`
        : coverage.covered === 0
          ? "No agent is failing — and no agent has a canary, so nothing is checking whether any answer is right."
          : `All ${assessments.length} agent(s) are answering correctly on the checks that could run.`,
    dryRun: !act,
  };
  return _last;
}

/** The last sweep, without running one. Null until the first has run. */
export function lastSweep() {
  return _last;
}

/** Start the recurring sweep. Safe to call twice. */
export function startAgentHealthSweep({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (_timer) clearInterval(_timer);
  // A first sweep shortly after boot, not immediately: the registry, the
  // database and the cluster connection all need to settle, and a sweep that
  // runs against a half-started process reports faults that are its own.
  setTimeout(() => {
    sweepAgentHealth().catch((e) => console.error("[agent-health] first sweep failed:", e.message));
  }, 60_000).unref?.();
  _timer = setInterval(() => {
    sweepAgentHealth().catch((e) => console.error("[agent-health] sweep failed:", e.message));
  }, intervalMs);
  _timer.unref?.();
  return { intervalMs };
}

export function stopAgentHealthSweep() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
