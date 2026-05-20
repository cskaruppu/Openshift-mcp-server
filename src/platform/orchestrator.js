/**
 * Orchestrator Agent
 *
 * The "brain" of the multi-platform agentic system. It:
 *   1. Detects the platform at startup
 *   2. Registers platform-appropriate skills
 *   3. Routes user intents to the best skill handler
 *   4. Synthesizes results from multiple skills when needed
 *   5. Provides production-readiness assessments
 *
 * The orchestrator does NOT replace existing OpenShift handlers —
 * when platform is OpenShift, the existing chat-api.js code path
 * runs as before. The orchestrator adds a PARALLEL capability for
 * multi-platform and cross-cutting analysis.
 */

import { PLATFORM, detectPlatform, getPlatform, getPlatformMeta, getPlatformLabel, isOpenShiftFamily } from "./detect.js";
import {
  findBestSkill,
  findSkillsByIntent,
  findSkillsByCategory,
  getSkillManifest,
  getSkillCount,
  getAllSkills,
  clearRegistry,
} from "./skill-registry.js";
import { registerOpenShiftSkills } from "./providers/openshift.js";
import { registerEKSSkills } from "./providers/eks.js";
import { registerAKSSkills } from "./providers/aks.js";
import { registerGKESkills } from "./providers/gke.js";
import { registerVanillaK8sSkills } from "./providers/vanilla-k8s.js";

let _initialized = false;
let _apiGetFn = null;

/**
 * Initialize the orchestrator — detect platform and register skills.
 * @param {Function} apiGet - API getter function (ocpGet for OCP, k8sGet for others)
 */
async function initialize(apiGet) {
  _apiGetFn = apiGet;
  clearRegistry();

  const { platform, meta } = await detectPlatform(apiGet);
  console.log(`[Platform] Detected: ${meta.label || platform} (source: ${meta.source})`);

  // Register provider-specific skills
  switch (platform) {
    case PLATFORM.OPENSHIFT:
    case PLATFORM.ROSA:
    case PLATFORM.ARO:
      registerOpenShiftSkills(apiGet);
      break;
    case PLATFORM.EKS:
      registerEKSSkills(apiGet);
      break;
    case PLATFORM.AKS:
      registerAKSSkills(apiGet);
      break;
    case PLATFORM.GKE:
      registerGKESkills(apiGet);
      break;
    case PLATFORM.K8S:
    default:
      registerVanillaK8sSkills(apiGet);
      break;
  }

  _initialized = true;
  console.log(`[Platform] Registered ${getSkillCount()} skills for ${platform}`);
  return { platform, meta, skillCount: getSkillCount() };
}

/**
 * Execute a single skill by intent.
 * Returns the skill output string or null if no matching skill.
 */
async function executeSkill(intent, context = {}) {
  if (!_initialized) return null;
  const platform = getPlatform();
  const skill = findBestSkill(intent, platform);
  if (!skill) return null;

  try {
    const result = await skill.handler(context);
    return { skillId: skill.id, provider: skill.provider, result };
  } catch (err) {
    return { skillId: skill.id, provider: skill.provider, error: err.message };
  }
}

/**
 * Execute multiple skills in parallel for a multi-intent query.
 * @param {string[]} intents - Array of intent strings
 * @param {object} context - Shared context (namespace, etc.)
 * @returns {Promise<object[]>} Array of skill results
 */
async function executeMultipleSkills(intents, context = {}) {
  if (!_initialized) return [];
  const platform = getPlatform();
  const skillsToRun = [];
  const seenSkills = new Set();

  for (const intent of intents) {
    const skills = findSkillsByIntent(intent, platform);
    for (const skill of skills) {
      if (!seenSkills.has(skill.id)) {
        seenSkills.add(skill.id);
        skillsToRun.push(skill);
      }
    }
  }

  const results = await Promise.allSettled(
    skillsToRun.map(async (skill) => {
      const result = await skill.handler(context);
      return { skillId: skill.id, provider: skill.provider, category: skill.category, result };
    })
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return { skillId: skillsToRun[i].id, provider: skillsToRun[i].provider, error: r.reason?.message || "Unknown error" };
  });
}

/**
 * Production readiness assessment — runs multiple skills and synthesizes.
 */
async function assessProductionReadiness(context = {}) {
  if (!_initialized) return null;

  const checkIntents = [
    "nodes", "pod_summary", "hpa", "pdb", "probes",
    "podsecurity", "network", "governance", "capacity",
    "supplychain", "webhook",
  ];

  const results = await executeMultipleSkills(checkIntents, context);
  const parts = [`## Production Readiness Assessment`, ""];
  parts.push(`**Platform:** ${getPlatformLabel()}`);
  parts.push(`**Skills Evaluated:** ${results.length}`);
  parts.push("");

  let criticalCount = 0;
  let warningCount = 0;

  results.forEach(r => {
    if (r.error) {
      parts.push(`[WARNING] \`${r.skillId}\`: ${r.error}`);
      warningCount++;
      return;
    }
    const text = r.result || "";
    const criticals = (text.match(/\[CRITICAL\]/g) || []).length;
    const warnings = (text.match(/\[WARNING\]/g) || []).length;
    criticalCount += criticals;
    warningCount += warnings;
  });

  parts.push("");
  const score = Math.max(0, 100 - (criticalCount * 15) - (warningCount * 5));
  const grade = score >= 90 ? "[OK] A" : score >= 75 ? "[OK] B" : score >= 60 ? "[WARNING] C" : "[CRITICAL] D";
  parts.push(`### Overall Score: ${score}/100 (${grade})`);
  parts.push(`**Critical Issues:** ${criticalCount} | **Warnings:** ${warningCount}`);
  parts.push("");

  results.forEach(r => {
    if (!r.error && r.result) {
      parts.push("---");
      parts.push(r.result);
      parts.push("");
    }
  });

  return parts.join("\n");
}

/**
 * Get platform information for the dashboard.
 */
function getPlatformInfo() {
  return {
    platform: getPlatform(),
    label: getPlatformLabel(),
    meta: getPlatformMeta(),
    isOpenShift: isOpenShiftFamily(getPlatform()),
    skillCount: getSkillCount(),
    manifest: getSkillManifest(getPlatform()),
  };
}

/**
 * Get available skills for the current platform (for UI rendering).
 */
function getAvailableSkills() {
  if (!_initialized) return [];
  const platform = getPlatform();
  return getAllSkills().filter(s => s.platforms.includes("*") || s.platforms.includes(platform)).map(s => ({
    id: s.id,
    name: s.name,
    category: s.category,
    provider: s.provider,
    description: s.description,
    intents: s.intents,
  }));
}

function isInitialized() {
  return _initialized;
}

export {
  initialize,
  executeSkill,
  executeMultipleSkills,
  assessProductionReadiness,
  getPlatformInfo,
  getAvailableSkills,
  isInitialized,
};
