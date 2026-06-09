/**
 * Incident RAG — past-incident retrieval for the AI response pipeline.
 *
 * Retrieves similar past incidents from an on-disk knowledge base to give
 * the LLM institutional memory. When the AI (or a human) resolves an issue,
 * the resolution is recorded. When a similar issue recurs, the module finds
 * matching history and formats it as context for the prompt.
 *
 * Storage: in-memory ring buffer (max 500 entries) persisted to
 * `data/incident-history.json` relative to the project root. Writes are
 * asynchronous (write-through cache); reads are always from memory.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RING_MAX = 500;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const HISTORY_PATH = join(DATA_DIR, "incident-history.json");

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
let _ring = [];
let _loaded = false;
let _flushPending = false;

// ---------------------------------------------------------------------------
// Best-practice fallback notes for common error patterns
// ---------------------------------------------------------------------------
const BEST_PRACTICES = {
  OOMKilled: {
    summary: "Container exceeded its memory limit and was killed by the kernel OOM-killer.",
    tips: [
      "Check current memory requests/limits — the limit may be too low for the workload.",
      "Profile the application for memory leaks (heap dumps, connection pool sizing).",
      "Recent deploys that increased memory usage are a common trigger.",
      "Consider raising the memory limit as a short-term fix while investigating the root cause.",
    ],
  },
  CrashLoopBackOff: {
    summary: "Container repeatedly starts and crashes. Kubernetes is backing off restarts.",
    tips: [
      "Check the exit code: 1 = application error, 137 = OOM/SIGKILL, 139 = segfault, 143 = SIGTERM.",
      "Inspect container logs for the crash reason (oc logs / kubectl logs).",
      "Verify environment variables, config maps, and secrets are present and correct.",
      "Check liveness/readiness probe configuration — probes that fire too early cause loops.",
    ],
  },
  ImagePullBackOff: {
    summary: "Kubernetes cannot pull the container image.",
    tips: [
      "Verify the image name and tag are correct.",
      "Check pull secrets — the registry may require authentication.",
      "Confirm network connectivity to the registry from the cluster nodes.",
      "The image tag may not exist or may have been deleted (common with 'latest').",
    ],
  },
  ErrImagePull: {
    summary: "Initial image pull failed. Will transition to ImagePullBackOff if unresolved.",
    tips: [
      "Same investigation steps as ImagePullBackOff.",
      "Check if the registry is experiencing an outage.",
    ],
  },
  CreateContainerConfigError: {
    summary: "Container cannot start because of a configuration problem.",
    tips: [
      "Verify that referenced ConfigMaps and Secrets exist in the namespace.",
      "Check volume mounts — the referenced PVC or volume may not exist.",
      "Look for typos in environment variable references.",
    ],
  },
  Evicted: {
    summary: "Pod was evicted, typically due to node resource pressure.",
    tips: [
      "Check node conditions for DiskPressure, MemoryPressure, or PIDPressure.",
      "Review pod resource requests — they may need to be right-sized.",
      "Consider adding PodDisruptionBudgets if evictions are disruptive.",
    ],
  },
  NodeNotReady: {
    summary: "A node has stopped reporting Ready status.",
    tips: [
      "Check kubelet logs on the affected node.",
      "Verify network connectivity between the node and the API server.",
      "Look for resource exhaustion (disk, memory, PIDs) on the node.",
    ],
  },
};

// ---------------------------------------------------------------------------
// Disk I/O — load & flush
// ---------------------------------------------------------------------------
async function loadFromDisk() {
  if (_loaded) return;
  try {
    const { loadState } = await import("../utils/state-store.js");
    const parsed = await loadState("incident_rag_history", HISTORY_PATH);
    if (Array.isArray(parsed)) {
      _ring = parsed.slice(-RING_MAX);
    }
  } catch {
    // Nothing stored or corrupt — start fresh
    _ring = [];
  }
  _loaded = true;
}

async function flushToDisk() {
  if (_flushPending) return;
  _flushPending = true;
  try {
    const { saveState } = await import("../utils/state-store.js");
    await saveState("incident_rag_history", _ring, HISTORY_PATH);
  } catch (err) {
    console.error("[incident-rag] flush failed:", err.message);
  } finally {
    _flushPending = false;
  }
}

async function ensureLoaded() {
  if (!_loaded) await loadFromDisk();
}

// ---------------------------------------------------------------------------
// Similarity scoring
// ---------------------------------------------------------------------------
function extractDeploymentPrefix(podPattern) {
  if (!podPattern) return "";
  // Strip trailing hash suffixes common in k8s pod names
  // e.g. "payment-service-5f7b9c4d6-x2k9m" → "payment-service"
  return podPattern.replace(/-[a-f0-9]{6,10}(-[a-z0-9]{5})?$/, "")
    .replace(/-[0-9]+-[a-z0-9]+$/, "");
}

function computeSimilarityScore(signature, candidate) {
  let score = 0;

  // Exact reason match: +10
  if (signature.reason && candidate.symptom?.reason &&
      signature.reason === candidate.symptom.reason) {
    score += 10;
  }

  // Same namespace: +5
  if (signature.namespace && candidate.symptom?.namespace &&
      signature.namespace === candidate.symptom.namespace) {
    score += 5;
  }

  // Similar pod name pattern (same deployment prefix): +5
  const sigPrefix = extractDeploymentPrefix(signature.podPattern);
  const candPrefix = extractDeploymentPrefix(candidate.symptom?.podPattern);
  if (sigPrefix && candPrefix && sigPrefix === candPrefix) {
    score += 5;
  }

  // Same exit code: +3
  if (signature.exitCode != null && candidate.symptom?.exitCode != null &&
      signature.exitCode === candidate.symptom.exitCode) {
    score += 3;
  }

  // Recency bonus: +1 per day less than 30 days ago
  if (candidate.resolvedAt) {
    const ageMs = Date.now() - new Date(candidate.resolvedAt).getTime();
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    if (ageDays < 30) {
      score += 30 - ageDays;
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Find similar past incidents using the scoring algorithm.
 *
 * @param {object} signature - { reason, podPattern, namespace, exitCode }
 * @param {number} [limit=5] - Maximum results to return
 * @returns {Promise<Array<{ incident: object, score: number }>>}
 */
export async function findSimilarIncidents(signature, limit = 5) {
  await ensureLoaded();

  const scored = _ring
    .filter((inc) => inc.outcome === "success" || inc.outcome === "partial")
    .map((incident) => ({
      incident,
      score: computeSimilarityScore(signature, incident),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

/**
 * Build a context string for the LLM prompt from similar past incidents.
 *
 * @param {object} symptomSignature - { reason, podPattern, namespace, exitCode }
 * @param {string} [namespace] - Current namespace (for stats)
 * @param {string} [platform] - Current platform identifier
 * @returns {Promise<string>} Markdown context string, or empty string
 */
export async function buildIncidentContext(symptomSignature, namespace, platform) {
  await ensureLoaded();

  const similar = await findSimilarIncidents(symptomSignature);
  const reason = symptomSignature?.reason || "";

  // If no similar incidents, return best-practice fallback
  if (similar.length === 0) {
    return buildBestPracticeContext(reason);
  }

  const sections = [];
  sections.push("## Past Incident Intelligence\n");

  // Individual similar incidents
  for (const { incident, score } of similar.slice(0, 3)) {
    const age = formatAge(incident.resolvedAt);
    const symptom = incident.symptom || {};

    sections.push(`### Similar Incident (${age})`);
    sections.push(
      `- **Symptom**: ${symptom.reason || "Unknown"} on ${symptom.podPattern || "unknown pods"} in ${symptom.namespace || "unknown"} namespace`
    );
    if (incident.rootCause) {
      sections.push(`- **Root Cause**: ${incident.rootCause}`);
    }
    if (incident.resolution) {
      sections.push(`- **Resolution**: ${incident.resolution}`);
    }
    sections.push(
      `- **Outcome**: ${formatOutcome(incident.outcome)}${incident.outcome === "success" ? "" : ""}`
    );
    if (incident.timeToResolveMs) {
      sections.push(`- **Time to Resolve**: ${formatDuration(incident.timeToResolveMs)}`);
    }
    sections.push("");
  }

  // Pattern analysis for the matching reason
  const reasonMatches = _ring.filter(
    (inc) => inc.symptom?.reason === reason &&
      Date.now() - new Date(inc.resolvedAt || inc.recordedAt || 0).getTime() < THIRTY_DAYS_MS
  );

  if (reasonMatches.length > 0) {
    sections.push("### Pattern Analysis");
    sections.push(
      `- This error has occurred ${reasonMatches.length} time${reasonMatches.length === 1 ? "" : "s"} in the last 30 days`
    );

    // Build fix category breakdown
    const fixCategories = categorizeResolutions(reasonMatches, reason);
    if (fixCategories.length > 0) {
      const total = fixCategories.reduce((s, c) => s + c.count, 0);
      const parts = fixCategories.map(
        (c) => `${c.label} (${Math.round((c.count / total) * 100)}%)`
      );
      sections.push(`- Most common fix: ${parts.join(", ")}`);
    }

    const resolvedWithTime = reasonMatches.filter((inc) => inc.timeToResolveMs > 0);
    if (resolvedWithTime.length > 0) {
      const avgMs =
        resolvedWithTime.reduce((s, inc) => s + inc.timeToResolveMs, 0) /
        resolvedWithTime.length;
      sections.push(`- Average resolution time: ${formatDuration(avgMs)}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Record a resolved incident for future retrieval.
 *
 * @param {object} incident - {
 *   symptom: { reason, podPattern, namespace, exitCode },
 *   rootCause: string,
 *   resolution: string,
 *   outcome: "success" | "partial" | "failed",
 *   resolvedAt: ISO timestamp,
 *   resolvedBy: "ai-remediation" | "manual",
 *   timeToResolveMs: number
 * }
 */
export async function recordIncidentResolution(incident) {
  await ensureLoaded();

  const record = {
    symptom: {
      reason: incident.symptom?.reason || null,
      podPattern: incident.symptom?.podPattern || null,
      namespace: incident.symptom?.namespace || null,
      exitCode: incident.symptom?.exitCode ?? null,
    },
    rootCause: incident.rootCause || null,
    resolution: incident.resolution || null,
    outcome: incident.outcome || "success",
    resolvedAt: incident.resolvedAt || new Date().toISOString(),
    resolvedBy: incident.resolvedBy || "manual",
    timeToResolveMs: incident.timeToResolveMs || 0,
    recordedAt: new Date().toISOString(),
  };

  _ring.push(record);

  // Enforce ring buffer max
  while (_ring.length > RING_MAX) {
    _ring.shift();
  }

  // Async flush — don't block the caller
  flushToDisk().catch((err) =>
    console.error("[incident-rag] background flush failed:", err.message)
  );

  return record;
}

/**
 * Return aggregate incident stats, optionally filtered by namespace.
 *
 * @param {string} [namespace] - Filter to a specific namespace
 * @returns {Promise<object>} Stats object
 */
export async function getIncidentStats(namespace) {
  await ensureLoaded();

  const filtered = namespace
    ? _ring.filter((inc) => inc.symptom?.namespace === namespace)
    : _ring;

  const now = Date.now();
  const last30 = filtered.filter(
    (inc) =>
      now - new Date(inc.resolvedAt || inc.recordedAt || 0).getTime() < THIRTY_DAYS_MS
  );

  // By reason
  const byReason = {};
  for (const inc of filtered) {
    const r = inc.symptom?.reason || "Unknown";
    byReason[r] = (byReason[r] || 0) + 1;
  }

  // Average resolution time (only successful ones with a time recorded)
  const withTime = filtered.filter(
    (inc) => inc.timeToResolveMs > 0 && (inc.outcome === "success" || inc.outcome === "partial")
  );
  const avgResolutionTimeMs =
    withTime.length > 0
      ? Math.round(withTime.reduce((s, inc) => s + inc.timeToResolveMs, 0) / withTime.length)
      : 0;

  // AI resolved percentage
  const aiResolved = filtered.filter((inc) => inc.resolvedBy === "ai-remediation").length;
  const aiResolvedPct =
    filtered.length > 0 ? Math.round((aiResolved / filtered.length) * 100) : 0;

  // Top recurring patterns
  const patternCounts = {};
  for (const inc of filtered) {
    const key = `${inc.symptom?.reason || "Unknown"}::${extractDeploymentPrefix(inc.symptom?.podPattern) || "unknown"}`;
    if (!patternCounts[key]) {
      patternCounts[key] = { count: 0, lastSeen: "" };
    }
    patternCounts[key].count += 1;
    const ts = inc.resolvedAt || inc.recordedAt || "";
    if (ts > patternCounts[key].lastSeen) {
      patternCounts[key].lastSeen = ts;
    }
  }

  const topRecurring = Object.entries(patternCounts)
    .map(([pattern, data]) => ({
      pattern,
      count: data.count,
      lastSeen: data.lastSeen,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    total: filtered.length,
    last30Days: last30.length,
    byReason,
    avgResolutionTimeMs,
    aiResolvedPct,
    topRecurring,
  };
}

// ---------------------------------------------------------------------------
// Helpers — formatting
// ---------------------------------------------------------------------------
function formatAge(isoTimestamp) {
  if (!isoTimestamp) return "unknown time ago";
  const ageMs = Date.now() - new Date(isoTimestamp).getTime();
  const mins = Math.floor(ageMs / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)} seconds`;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0
    ? `${hours} hour${hours === 1 ? "" : "s"} ${rem} minute${rem === 1 ? "" : "s"}`
    : `${hours} hour${hours === 1 ? "" : "s"}`;
}

function formatOutcome(outcome) {
  switch (outcome) {
    case "success":
      return "Verified successful";
    case "partial":
      return "Partially resolved";
    case "failed":
      return "Failed";
    default:
      return outcome || "Unknown";
  }
}

/**
 * Categorize resolutions for a given reason to produce a distribution like
 * "Increase memory limit (67%), Application fix (33%)".
 */
function categorizeResolutions(incidents, reason) {
  const categories = {};

  for (const inc of incidents) {
    const res = (inc.resolution || "").toLowerCase();
    let label = "Other";

    if (reason === "OOMKilled") {
      if (/memory.*(limit|request)|limit.*memory|rais.*mem|increas.*mem/i.test(res)) {
        label = "Increase memory limit";
      } else if (/leak|pool|connection|fix|patch|code/i.test(res)) {
        label = "Application fix";
      } else if (/restart|bounce|rollout/i.test(res)) {
        label = "Restart/Rollout";
      }
    } else if (reason === "CrashLoopBackOff") {
      if (/config|env|secret|configmap/i.test(res)) {
        label = "Configuration fix";
      } else if (/image|tag|version|rollback/i.test(res)) {
        label = "Image/Version fix";
      } else if (/probe|liveness|readiness|health/i.test(res)) {
        label = "Probe adjustment";
      } else if (/resource|memory|cpu|limit/i.test(res)) {
        label = "Resource adjustment";
      }
    } else if (reason === "ImagePullBackOff" || reason === "ErrImagePull") {
      if (/secret|auth|credential|pull.*secret/i.test(res)) {
        label = "Pull secret fix";
      } else if (/tag|image|name|typo/i.test(res)) {
        label = "Image reference fix";
      } else if (/network|registry|connect/i.test(res)) {
        label = "Network/Registry fix";
      }
    } else {
      // Generic categorization
      if (/config|env|secret/i.test(res)) {
        label = "Configuration fix";
      } else if (/resource|memory|cpu|limit|scale/i.test(res)) {
        label = "Resource adjustment";
      } else if (/restart|rollout|bounce/i.test(res)) {
        label = "Restart/Rollout";
      } else if (/rollback|revert/i.test(res)) {
        label = "Rollback";
      }
    }

    categories[label] = (categories[label] || 0) + 1;
  }

  return Object.entries(categories)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Build best-practice fallback context for when no similar incidents exist.
 */
function buildBestPracticeContext(reason) {
  const info = BEST_PRACTICES[reason];
  if (!info) return "";

  const lines = [
    "## Best Practice Notes\n",
    `> No similar past incidents found in the knowledge base.\n`,
    `**${reason}**: ${info.summary}\n`,
    "**Recommended investigation steps:**",
  ];

  for (const tip of info.tips) {
    lines.push(`- ${tip}`);
  }
  lines.push("");

  return lines.join("\n");
}
