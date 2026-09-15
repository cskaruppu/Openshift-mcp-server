/**
 * The golden path: a new agent that starts governed.
 *
 * Every agent in this registry began as `unreviewed` — no owner, no blast
 * radius, no trust tier — because the manifest format never asked. Reporting
 * that afterwards is the expensive way to fix it. Asking at creation is close
 * to free, and it is the only approach that stops the problem growing: at sixty
 * agents nobody audits their way back to a governed fleet.
 *
 * WHAT THIS DOES NOT DO IS WRITE THE FILE. The manifest belongs in git, where
 * it is reviewed and versioned, and where the registry's own history lives. A
 * file written into a running pod exists on one replica, vanishes on restart,
 * and disagrees with the repository — which is precisely the drift the
 * governance lens exists to detect. So this validates, scores, and hands back
 * the exact JSON to commit.
 *
 * Pure. No filesystem, no network.
 */

import { scoreAgent } from "./scorecard.js";
import { TRUST_TIERS, BLAST_RADII, AUTONOMY_LEVELS } from "./governance.js";

const ID_RE = /^[a-z][a-z0-9-]{1,48}[a-z0-9]$/;
const TOOL_RE = /^[a-z][a-z0-9_]{1,62}$/;
export const CATEGORIES = ["Operations", "Lifecycle", "Platform", "Governance", "Intelligence"];

/**
 * Check a proposed agent before it becomes a file.
 *
 * Errors block; warnings do not. The split matters: an id that collides is a
 * broken registry, while a missing example is only a worse catalog entry, and
 * treating them alike teaches people to click past both.
 */
export function validateScaffold(input = {}, { existingIds = [], servedTools = null } = {}) {
  const errors = [], warnings = [];
  const id = String(input.id || "").trim();
  const name = String(input.name || "").trim();
  const tools = Array.isArray(input.tools) ? input.tools.map((t) => String(t).trim()).filter(Boolean) : [];

  if (!id) errors.push({ field: "id", message: "An id is required — it is the agent's address in every URL and every trace." });
  else if (!ID_RE.test(id)) errors.push({ field: "id", message: `"${id}" is not usable as an id. Lower-case letters, digits and hyphens, starting with a letter.` });
  else if (existingIds.includes(id)) errors.push({ field: "id", message: `"${id}" already exists. Two agents with one id would silently share traces and token attribution.` });

  if (!name) errors.push({ field: "name", message: "A display name is required." });
  if (!String(input.description || "").trim()) {
    errors.push({ field: "description", message: "A description is required. An entry nobody can understand is an entry nobody uses." });
  }
  if (input.category && !CATEGORIES.includes(input.category)) {
    warnings.push({ field: "category", message: `"${input.category}" is a new category. The five in use are ${CATEGORIES.join(", ")}.` });
  }

  if (!tools.length) {
    errors.push({ field: "tools", message: "An agent with no tools exposes nothing." });
  } else {
    const bad = tools.filter((t) => !TOOL_RE.test(t));
    if (bad.length) errors.push({ field: "tools", message: `Not usable as tool names: ${bad.join(", ")}.` });
    const dupes = tools.filter((t, i) => tools.indexOf(t) !== i);
    if (dupes.length) warnings.push({ field: "tools", message: `Listed more than once: ${[...new Set(dupes)].join(", ")}.` });
    // The check that would have caught 24 existing tools before they shipped.
    if (servedTools) {
      const missing = tools.filter((t) => !servedTools.has(t));
      if (missing.length) {
        errors.push({
          field: "tools",
          message: `Not served over MCP: ${missing.join(", ")}. Declaring a tool that does not exist gives clients an empty tool list and no error — implement it first, or leave it out.`,
        });
      }
    }
  }

  // Governance: warn, never block. Someone who cannot answer "who owns this"
  // today should still be able to create the agent — but they should see the
  // grade it will get, and be told exactly what is missing.
  const g = input.governance || {};
  if (!g.owner) warnings.push({ field: "governance.owner", message: "No owner. The agent will be created unreviewed and nobody will be accountable for it." });
  if (!g.blastRadius) warnings.push({ field: "governance.blastRadius", message: "No blast radius. Nothing will be able to tell whether this agent reads, changes or destroys." });
  else if (!BLAST_RADII.includes(g.blastRadius)) errors.push({ field: "governance.blastRadius", message: `Must be one of: ${BLAST_RADII.join(", ")}.` });
  if (g.trustTier && !TRUST_TIERS.includes(g.trustTier)) errors.push({ field: "governance.trustTier", message: `Must be one of: ${TRUST_TIERS.join(", ")}.` });
  if (g.autonomyLevel && !AUTONOMY_LEVELS.includes(g.autonomyLevel)) errors.push({ field: "governance.autonomyLevel", message: `Must be one of: ${AUTONOMY_LEVELS.join(", ")}.` });
  if (!Array.isArray(input.examples) || !input.examples.length) {
    warnings.push({ field: "examples", message: "No usage example. None of the sixteen agents has one, and it is the difference between a catalog that is read and one that is used." });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** The manifest itself, in the shape and key order the existing sixteen use. */
export function buildManifest(input = {}) {
  const id = String(input.id || "").trim();
  const g = input.governance || {};
  const tools = [...new Set((input.tools || []).map((t) => String(t).trim()).filter(Boolean))];

  const manifest = {
    id,
    name: String(input.name || "").trim(),
    version: input.version || "1.0.0",
    description: String(input.description || "").trim(),
    category: input.category || "Operations",
    icon: input.icon || "server",
    color: input.color || "#3d5afe",
    tools,
    services: input.services || [],
    capabilities: input.capabilities?.length ? input.capabilities : tools.map((t) => t.replace(/_/g, " ")),
    requires: input.requires?.length ? input.requires : ["core"],
    protocols: ["mcp", "rest"],
    selectable: input.selectable !== false,
    mcpEndpoint: `/mcp/${id}`,
    tags: input.tags || [],
  };

  // Only the keys somebody actually answered. A governance block full of nulls
  // reads as declared-and-empty rather than undeclared, which is the one thing
  // this whole feature exists to keep apart.
  const gov = {};
  if (g.owner) gov.owner = g.owner;
  if (g.trustTier) gov.trustTier = g.trustTier;
  if (g.blastRadius) gov.blastRadius = g.blastRadius;
  if (g.autonomyLevel) gov.autonomyLevel = g.autonomyLevel;
  if (g.certifiedAt) gov.certifiedAt = g.certifiedAt;
  if (g.recertifyBy) gov.recertifyBy = g.recertifyBy;
  if (Array.isArray(g.egress) && g.egress.length) gov.egress = g.egress;
  if (Object.keys(gov).length) manifest.governance = gov;

  if (input.examples?.length) manifest.examples = input.examples;

  // A read-only profile offered by default when one is possible. The narrower
  // surface is the thing people ask for after the fact, and declaring it now
  // costs a line.
  if (input.profiles && Object.keys(input.profiles).length) manifest.profiles = input.profiles;

  return manifest;
}

/**
 * Everything the console needs to show before anyone commits anything: the
 * file, where it goes, whether it is valid, and the grade it will be born with.
 */
export function scaffoldAgent(input = {}, opts = {}) {
  const validation = validateScaffold(input, opts);
  const manifest = buildManifest(input);
  const g = manifest.governance || {};

  const preview = scoreAgent({
    owner: g.owner || null,
    blastRadius: g.blastRadius || null,
    trustTier: g.trustTier || null,
    autonomy: g.autonomyLevel || null,
    certification: { state: g.certifiedAt ? (g.recertifyBy ? "current" : "no-expiry") : "never" },
    // A brand new agent has never run and has nothing observed. Both are
    // unknown, not failures — it has not had the chance to misbehave.
    reconciled: null, lastUsed: null, errorRate: null,
    missingTools: opts.servedTools
      ? manifest.tools.filter((t) => !opts.servedTools.has(t))
      : null,
    hasExamples: !!manifest.examples?.length,
  });

  return {
    ...validation,
    path: `src/agents/manifests/${manifest.id || "<id>"}.json`,
    manifest,
    file: JSON.stringify(manifest, null, 2) + "\n",
    preview,
    // Said plainly, because the natural assumption on pressing Create is that
    // something was created.
    next: "This file is not written by the platform. Commit it to the repository — the manifest is reviewed and versioned like any other change, and an agent that exists on one pod but not in git is exactly the drift the governance view reports.",
  };
}
