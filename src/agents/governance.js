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

/**
 * Where an agent is in its working life.
 *
 * A new hire does not get production access on the first morning, and a new
 * agent should not either. `experimental` is probation: reachable by its owner,
 * kept out of general circulation, and promoted only when somebody reviews it.
 *
 * GRANDFATHERING IS DELIBERATE. An agent whose manifest says nothing is `active`,
 * NOT `experimental`. The sixteen that exist today are in production and were
 * written before this field did; reading their silence as "on probation" would
 * take a working fleet out of circulation on deploy. Probation applies to agents
 * created from here on, which is the only place it can do any good anyway.
 */
export const LIFECYCLE = ["experimental", "active", "deprecated", "retired"];
export const DEFAULT_LIFECYCLE = "active";

/** How long is too long to sit on probation. */
const PROBATION_DAYS = 90;

const DAY = 86400000;

/**
 * Certification is a claim with a date on it. One without is not a claim.
 *
 * Resolved the same way ownership is: DECLARED in the manifest beats an
 * APPROVED PROMOTION beats nothing. A promotion approved through a change
 * request cannot write the manifest — the manifest lives in git and a file
 * written into a running pod disagrees with the repository — so the approval is
 * held in its own store and merged here. One precedence rule, used twice; two
 * different ones in the same panel is how people stop trusting either.
 */
function certification(g, now, approved = null) {
  if (!g.certifiedAt && approved?.certifiedAt) {
    g = { ...g, certifiedAt: approved.certifiedAt, recertifyBy: approved.recertifyBy, certifiedBy: approved.approvedBy };
  }
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
export function agentPosture(manifest = {}, observed = null, now = Date.now(), ownership = null) {
  const g = manifest.governance || {};
  const declaredTools = new Set(manifest.tools || []);
  const declaredEgress = new Set(g.egress || []);

  const trustTier = TRUST_TIERS.includes(g.trustTier) ? g.trustTier : null;
  const blastRadius = BLAST_RADII.includes(g.blastRadius) ? g.blastRadius : null;
  const autonomy = AUTONOMY_LEVELS.includes(g.autonomyLevel) ? g.autonomyLevel : null;
  const cert = certification(g, now, ownership?.promotion || null);

  // Silence means active — see LIFECYCLE. An unrecognised value is not trusted
  // into circulation either, so it reads as experimental rather than as active.
  const declaredLifecycle = g.lifecycle
    ? (LIFECYCLE.includes(g.lifecycle) ? g.lifecycle : "experimental")
    : DEFAULT_LIFECYCLE;
  // An approved promotion moves the agent off probation at read time, the same
  // way a claim gives it an owner — the durable answer is still the manifest.
  const promo = ownership?.promotion || null;
  const lifecycle = declaredLifecycle === "experimental" && promo?.state === "approved"
    ? "active" : declaredLifecycle;
  const sinceMs = g.lifecycleSince ? Date.parse(g.lifecycleSince) : NaN;
  const daysInState = Number.isFinite(sinceMs) ? Math.floor((now - sinceMs) / DAY) : null;

  // ── Who owns it ──────────────────────────────────────────────────────
  // A manifest declaration wins: it went through review and lives in git. A
  // claim is a person pressing Claim in the console, which is a real act of
  // acceptance and is recorded with who and when — but it is held in a database
  // rather than in the reviewed artefact, so it ranks second and the console
  // says so.
  //
  // A SUGGESTION IS NOT AN OWNER and is never promoted to one here. It is
  // carried alongside so the console can offer it for one-click acceptance. An
  // agent with a suggestion and no acceptance is still unowned, because the
  // suggested person has not agreed to anything.
  const claim = ownership?.claim || null;
  const owner = g.owner || claim?.owner || null;
  const ownerSource = g.owner ? "manifest" : claim ? "claimed" : null;
  const suggestion = owner ? null : (ownership?.suggestion || null);

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
  // A deprecated agent that is still being called is the dangerous half of
  // offboarding: the notice went out and somebody is still depending on it.
  if (lifecycle === "deprecated") {
    findings.push({
      code: "deprecated", severity: "warning",
      message: g.sunsetOn
        ? `Deprecated, due to be retired on ${g.sunsetOn}. Anything still calling it needs to move.`
        : "Deprecated, with no retirement date set. A deprecation nobody has to act on does not end.",
    });
  }
  if (lifecycle === "retired") {
    findings.push({ code: "retired", severity: "warning", message: "Retired. It should no longer be reachable." });
  }
  // Probation that never ends is not probation — it is a permanent exception
  // wearing a temporary name, and it is exactly how "experimental" becomes a
  // production dependency nobody reviewed.
  if (declaredLifecycle === "experimental" && lifecycle === "experimental"
      && daysInState != null && daysInState > PROBATION_DAYS) {
    findings.push({
      code: "stale-probation", severity: "warning",
      message: `Experimental for ${daysInState} days. Promote it or retire it — anything this old is being used.`,
    });
  }

  // Undeclared is its own finding, never silence. A suggestion changes the
  // wording — there is something to accept — but not the verdict: nobody has
  // accepted it yet, and that is what "unowned" means.
  if (!owner) {
    findings.push({
      code: "no-owner", severity: "serious",
      message: suggestion
        ? `No owner has accepted this agent. ${suggestion.owner} is suggested, from ${suggestion.from}.`
        : "No owner is declared. Nobody is accountable for what this agent does.",
    });
  }
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
    lifecycle, declaredLifecycle,
    lifecycleSource: lifecycle !== declaredLifecycle ? "promoted" : "manifest",
    lifecycleSince: g.lifecycleSince || null, daysInLifecycle: daysInState,
    sunsetOn: g.sunsetOn || null,
    // Probation means out of general circulation, whatever the manifest says.
    // An agent nobody has reviewed must not be picked up by default.
    selectable: lifecycle === "experimental" || lifecycle === "retired" ? false : manifest.selectable !== false,
    // What a promotion would need before it could be approved.
    promotable: lifecycle === "experimental",
    promotion: ownership?.promotion || null,
    owner, ownerSource,
    // Present only when nobody has accepted the agent. The console renders it
    // as an offer with its provenance, never as the owner.
    ownerSuggestion: suggestion,
    claim: claim ? { by: claim.claimedBy, at: claim.claimedAt, source: claim.source } : null,
    trustTier, blastRadius, autonomy,
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
