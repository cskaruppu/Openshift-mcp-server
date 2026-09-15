/**
 * Agent governance posture — what an agent is permitted to do, who is
 * accountable for it, and whether that has ever been reviewed.
 *
 * The registry answers "how do I call this agent". This answers "what is it
 * allowed to do, and is it behaving". Same object, different audience: the
 * first is for integrators, the second for owners, security and audit.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: an undeclared field is reported as
 * undeclared. Not defaulted to something reassuring, not inferred from the
 * agent's name, not left blank so it reads as fine. An agent with no owner and
 * no certification is `unreviewed`, which is a posture, not an absence — and it
 * is the posture nearly every agent starts in. A registry whose first render
 * shows sixteen green ticks it has not earned is worse than no registry, in the
 * same way a migration verification that passes unread checks is worse than
 * none. A check with no data is not a pass.
 *
 * Everything here is pure. Manifest in, posture out.
 */

/** Trust tiers, widest blast radius of consequence last. */
export const TRUST_TIERS = ["first-party", "partner", "external"];

/** What the agent can do to the estate, in ascending order of consequence. */
export const BLAST_RADII = ["read-only", "mutating", "irreversible"];

/** How far it may act without a person. */
export const AUTONOMY_LEVELS = ["advisory", "propose-and-wait", "act-within-policy"];

const DAY = 86400000;

/** Certification is a claim with a date on it. One without is not a claim. */
function certification(g, now) {
  const at = g.certifiedAt ? Date.parse(g.certifiedAt) : NaN;
  if (!Number.isFinite(at)) {
    return { state: "never", certifiedAt: null, certifiedBy: g.certifiedBy || null, expiresInDays: null };
  }
  const by = g.recertifyBy ? Date.parse(g.recertifyBy) : NaN;
  if (!Number.isFinite(by)) {
    // Certified once, with no expiry. Said plainly rather than treated as
    // permanent — certification that never expires is not certification.
    return { state: "no-expiry", certifiedAt: g.certifiedAt, certifiedBy: g.certifiedBy || null, expiresInDays: null };
  }
  const days = Math.ceil((by - now) / DAY);
  return {
    state: days < 0 ? "expired" : days <= 30 ? "expiring" : "current",
    certifiedAt: g.certifiedAt, certifiedBy: g.certifiedBy || null, expiresInDays: days,
  };
}

/**
 * One agent's posture.
 *
 * @param {object} manifest    the agent manifest
 * @param {object} observed    what telemetry saw — { tools:[], egress:[], calledBy:[] }
 * @param {number} now         epoch ms, injected so this stays pure and testable
 */
export function agentPosture(manifest = {}, observed = null, now = Date.now()) {
  const g = manifest.governance || {};
  const declaredTools = new Set(manifest.tools || []);
  const declaredEgress = new Set(g.egress || []);

  const trustTier = TRUST_TIERS.includes(g.trustTier) ? g.trustTier : null;
  const blastRadius = BLAST_RADII.includes(g.blastRadius) ? g.blastRadius : null;
  const autonomy = AUTONOMY_LEVELS.includes(g.autonomyLevel) ? g.autonomyLevel : null;
  const owner = g.owner || null;
  const cert = certification(g, now);

  // ── Findings ─────────────────────────────────────────────────────────
  // Ordered by consequence. The first one is what the row reports, because a
  // row that lists five concerns communicates none of them.
  const findings = [];

  // Observed-but-not-declared is the highest-signal thing this module can
  // say. It is either a manifest that has drifted from the code or an agent
  // doing something nobody sanctioned, and NOTHING HERE CAN TELL YOU WHICH.
  // So it is reported as a divergence and escalated to a person — never
  // auto-resolved by widening the manifest to match what was observed, which
  // would turn the alarm into a rubber stamp.
  const undeclaredTools = (observed?.tools || []).filter((t) => !declaredTools.has(t));
  const undeclaredEgress = (observed?.egress || []).filter((d) => !declaredEgress.has(d));

  if (undeclaredEgress.length) {
    findings.push({
      code: "undeclared-egress", severity: "critical",
      message: `Sent traffic to ${undeclaredEgress.join(", ")}, which ${manifest.id} never declared.`,
      detail: undeclaredEgress,
    });
  }
  if (undeclaredTools.length) {
    findings.push({
      code: "undeclared-tools", severity: "critical",
      message: `Called ${undeclaredTools.join(", ")} — not declared in its manifest.`,
      detail: undeclaredTools,
    });
  }
  // An external agent acting on the estate is the combination worth refusing.
  if (trustTier === "external" && blastRadius && blastRadius !== "read-only") {
    findings.push({
      code: "external-mutating", severity: "critical",
      message: `External agent declared as ${blastRadius}. An agent outside your supply chain should not change the estate.`,
    });
  }
  if (cert.state === "expired") {
    findings.push({ code: "certification-expired", severity: "serious", message: `Certification lapsed ${Math.abs(cert.expiresInDays)} day(s) ago.` });
  }
  // Undeclared is its own finding, never silence.
  if (!owner) findings.push({ code: "no-owner", severity: "serious", message: "No owner is declared. Nobody is accountable for what this agent does." });
  if (!blastRadius) findings.push({ code: "no-blast-radius", severity: "serious", message: "Blast radius is not declared, so what this agent can do to the estate is unknown." });
  if (!trustTier) findings.push({ code: "no-trust-tier", severity: "warning", message: "Trust tier is not declared." });
  if (!autonomy) findings.push({ code: "no-autonomy", severity: "warning", message: "Autonomy level is not declared." });
  if (cert.state === "never") findings.push({ code: "never-certified", severity: "warning", message: "This agent has never been certified." });
  else if (cert.state === "expiring") findings.push({ code: "certification-expiring", severity: "warning", message: `Recertify within ${cert.expiresInDays} day(s).` });
  else if (cert.state === "no-expiry") findings.push({ code: "certification-no-expiry", severity: "warning", message: "Certified with no expiry date set." });

  // ── Verdict ──────────────────────────────────────────────────────────
  // Four states, and "unreviewed" sits between good and bad rather than being
  // folded into either. It means we do not know, and we say so.
  const worst = findings.length ? findings[0].severity : null;
  const declaredEverything = owner && trustTier && blastRadius && autonomy;

  let verdict;
  if (worst === "critical") verdict = "action-required";
  else if (!declaredEverything || cert.state === "never") verdict = "unreviewed";
  else if (worst === "serious" || worst === "warning") verdict = "attention";
  else verdict = "governed";

  return {
    id: manifest.id || null,
    name: manifest.name || manifest.id || null,
    category: manifest.category || null,
    toolCount: (manifest.tools || []).length,
    owner, trustTier, blastRadius, autonomy,
    certification: cert,
    budget: {
      tokensPerMonth: Number.isFinite(g.budgetTokensPerMonth) ? g.budgetTokensPerMonth : null,
      onBreach: g.budgetAction || null,
    },
    declared: {
      tools: manifest.tools || [],
      egress: g.egress || [],
      dependsOn: g.dependsOn || manifest.requires || [],
      maxDelegationDepth: Number.isFinite(g.maxDelegationDepth) ? g.maxDelegationDepth : null,
    },
    observed: observed ? {
      tools: observed.tools || [], egress: observed.egress || [], calledBy: observed.calledBy || [],
      undeclaredTools, undeclaredEgress,
    } : null,
    // Null, not false. Nothing was observed, so nothing is claimed either way.
    reconciled: observed ? undeclaredTools.length === 0 && undeclaredEgress.length === 0 : null,
    findings, verdict,
    next: findings.length ? findings[0].message
      : "Declared, certified and behaving within its declaration.",
  };
}

/** Fleet posture — the counts the panel's stat row shows. */
export function fleetPosture(postures = []) {
  const count = (p) => postures.filter(p).length;
  const byVerdict = {
    "action-required": count((p) => p.verdict === "action-required"),
    attention: count((p) => p.verdict === "attention"),
    unreviewed: count((p) => p.verdict === "unreviewed"),
    governed: count((p) => p.verdict === "governed"),
  };
  return {
    agents: postures.length,
    byVerdict,
    external: count((p) => p.trustTier === "external"),
    irreversible: count((p) => p.blastRadius === "irreversible"),
    unowned: count((p) => !p.owner),
    certified: count((p) => ["current", "expiring"].includes(p.certification?.state)),
    expiringSoon: count((p) => p.certification?.state === "expiring"),
    needsAttention: byVerdict["action-required"] + byVerdict.attention,
    // The sentence to put above the table. It leads with the worst true thing.
    headline: byVerdict["action-required"]
      ? `${byVerdict["action-required"]} agent(s) are behaving outside what they declared.`
      : byVerdict.unreviewed === postures.length && postures.length
        ? `No agent has been reviewed yet. Declaring an owner and a blast radius is the first step.`
        : byVerdict.unreviewed
          ? `${byVerdict.unreviewed} of ${postures.length} agents have never been reviewed.`
          : `All ${postures.length} agents are declared, certified and within their declarations.`,
  };
}
