/**
 * Platform Layer — Main Entry Point
 *
 * This is the ONLY file that needs to be imported by the existing
 * codebase to enable multi-platform support. It provides:
 *
 *   1. Platform auto-detection
 *   2. Skill registry initialization
 *   3. Orchestrator agent access
 *   4. Platform-aware API routing
 *   5. NLU supplements for platform-specific terms
 *   6. Dashboard metadata (platform badge, skill manifest)
 *
 * IMPORTANT: Importing this module does NOT change any existing behavior.
 * The existing OpenShift code path runs exactly as before. This module
 * only activates when explicitly called.
 *
 * Integration:
 *   import { initPlatform, getPlatformInfo } from './platform/index.js';
 *   await initPlatform(ocpGet);  // call once at startup
 */

export { PLATFORM, PLATFORM_LABELS, PLATFORM_FAMILY } from "./detect.js";
export { getPlatform, getPlatformMeta, getPlatformLabel, getPlatformFamily, isOpenShiftFamily } from "./detect.js";
export { registerOcpClient, platformGet, platformPost, platformPatch, platformDelete, getApiGet, useOpenShiftHandlers, getCommandPrefix, adaptCommand } from "./router.js";
export { loadClusterConfig, getClusterConfig } from "./k8s-client.js";
export {
  SKILL_CATEGORIES,
  getSkill,
  findSkillsByIntent,
  findSkillsByCategory,
  findSkillsByPlatform,
  findSkillsByKeyword,
  findBestSkill,
  getAllSkills,
  getSkillCount,
  getCategories,
  getSkillManifest,
} from "./skill-registry.js";
export { initialize as initOrchestrator, executeSkill, executeMultipleSkills, assessProductionReadiness, getAvailableSkills, isInitialized } from "./orchestrator.js";
export { getNLUSupplements, getNLUStopWords } from "./nlu-supplements.js";

import { registerOcpClient } from "./router.js";
import { initialize as initOrchestrator, getPlatformInfo as getOrchestratorInfo } from "./orchestrator.js";
import { getApiGet } from "./router.js";

/**
 * Initialize the entire platform layer.
 * Call once at server startup AFTER the OpenShift client is available.
 *
 * @param {object} ocpClientFns - Existing OpenShift client functions
 * @param {Function} ocpClientFns.ocpGet
 * @param {Function} ocpClientFns.ocpPost
 * @param {Function} ocpClientFns.ocpPatch
 * @param {Function} ocpClientFns.ocpDelete
 * @param {Function} ocpClientFns.ocpFetch
 */
async function initPlatform(ocpClientFns) {
  // Register existing OCP client so the router can delegate
  registerOcpClient(ocpClientFns);

  // Get the appropriate API getter for the detected platform
  const apiGet = getApiGet();

  // Initialize orchestrator (detects platform + registers skills)
  const result = await initOrchestrator(apiGet);

  console.log(`[Platform] Initialization complete:`);
  console.log(`  Platform: ${result.meta.label || result.platform}`);
  console.log(`  Skills:   ${result.skillCount}`);
  console.log(`  Source:   ${result.meta.source}`);

  return result;
}

/**
 * Get platform info for the dashboard API endpoint.
 */
function getPlatformInfo() {
  return getOrchestratorInfo();
}

export { initPlatform, getPlatformInfo };
