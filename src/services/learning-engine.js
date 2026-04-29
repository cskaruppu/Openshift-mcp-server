/**
 * Learning Engine — gives KubeNexus AI institutional memory.
 *
 * Two main capabilities:
 *
 *  1. Continuous Learning Loop
 *     Records every detected incident with a stable signature, every fix
 *     attempted, and whether it succeeded. The team's history of "what
 *     worked when" becomes context for future AI suggestions.
 *
 *  2. Cross-Cluster Time-Travel Correlation
 *     Same signature seen on a different cluster, or seen previously,
 *     surfaces the prior fix. Lets a fresh investigation start from
 *     "we've seen this before — here's what your team did".
 *
 * Storage: PostgreSQL (primary) + in-memory fallback (best-effort).
 *
 * Stability: signatures are deterministic so the same problem always
 * matches its own history regardless of pod hash suffix or timestamp.
 */

import { query as dbQuery } from "../utils/db.js";

const _memIncidents = [];
const MAX_MEM = 1000;

let _dbReady = false;

// ---------------------------------------------------------------------------
// Initialization — creates the tables on first start
// ---------------------------------------------------------------------------
export async function initLearningEngine() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS incident_history (
        id BIGSERIAL PRIMARY KEY,
        cluster_name TEXT,
        namespace TEXT,
        resource_type TEXT,
        resource_name TEXT,
        issue_signature TEXT NOT NULL,
        issue_type TEXT,
        severity INT,
        context JSONB,
        status TEXT NOT NULL DEFAULT 'open',
        resolution_command TEXT,
        resolution_summary TEXT,
        resolution_success BOOLEAN,
        resolution_user TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        seen_count INT NOT NULL DEFAULT 1
      )
    `);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_inc_signature ON incident_history (issue_signature)`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_inc_cluster ON incident_history (cluster_name)`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_inc_occurred ON incident_history (occurred_at DESC)`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_inc_status ON incident_history (status)`);

    // Hydrate in-memory cache from recent incidents
    const r = await dbQuery(
      "SELECT * FROM incident_history ORDER BY last_seen_at DESC LIMIT $1",
      [MAX_MEM]
    );
    if (r?.rows) {
      _memIncidents.length = 0;
      _memIncidents.push(...r.rows);
    }
    _dbReady = true;
    console.error(`[learning-engine] Loaded ${_memIncidents.length} incidents from history`);
  } catch (err) {
    console.warn("[learning-engine] DB not available, using in-memory only:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Signature builder — deterministic, ignores instance-level noise
// ---------------------------------------------------------------------------

/**
 * Strip pod hash suffixes so deployments match across pod restarts.
 *   "payment-svc-67d57b6455-zlgwh" -> "payment-svc"
 *   "user-6cb45b77db-g4bs5"        -> "user"
 *   "release-monitor-58d8d957c5-lfvzk" -> "release-monitor"
 */
function stripPodHash(name) {
  if (!name) return name;
  // Remove ReplicaSet hash + pod hash: -<5–10 alnum>-<5 alnum>
  return name.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/, "")
             .replace(/-[a-z0-9]{8,16}$/, "");
}

/**
 * Build a stable signature from an issue.
 *
 *   buildSignature({ type: "CrashLoopBackOff", resource: "user-6cb45b77db-g4bs5",
 *                    namespace: "sock-shop", reason: "OOMKilled" })
 *   => "CrashLoopBackOff:OOMKilled:sock-shop/user"
 */
export function buildSignature({ type, resource, namespace, reason, image }) {
  const parts = [type || "Unknown"];
  if (reason) parts.push(reason);
  const stripped = stripPodHash(resource || "");
  if (stripped || namespace) parts.push(`${namespace || "*"}/${stripped || "*"}`);
  if (image) {
    const cleanImage = image.split(":")[0].split("/").pop();
    if (cleanImage) parts.push(`img=${cleanImage}`);
  }
  return parts.join(":");
}

// ---------------------------------------------------------------------------
// Incident recording — called from proactive agent on detection
// ---------------------------------------------------------------------------

/**
 * Record a detected incident. If the same signature already exists in an
 * 'open' state for this cluster, increment its seen_count and update
 * last_seen_at instead of creating a duplicate.
 *
 * @param {object} args
 * @param {string} args.cluster - cluster name (use "local" if unset)
 * @param {string} args.namespace
 * @param {string} args.resourceType - "pod", "node", "operator", etc.
 * @param {string} args.resourceName
 * @param {string} args.signature - precomputed or built via buildSignature()
 * @param {string} args.issueType - "CrashLoopBackOff", "NodeNotReady", etc.
 * @param {number} args.severity - 0–100
 * @param {object} args.context - optional structured context (events, etc.)
 */
export async function recordIncident(args) {
  const {
    cluster = "local",
    namespace = "",
    resourceType = "",
    resourceName = "",
    signature,
    issueType = "Unknown",
    severity = 50,
    context = null,
  } = args || {};

  if (!signature) return null;

  const now = new Date().toISOString();

  // Look for an existing open incident with this signature on this cluster
  let existing = null;
  try {
    if (_dbReady) {
      const r = await dbQuery(
        `SELECT * FROM incident_history
         WHERE issue_signature = $1 AND cluster_name = $2 AND status = 'open'
         ORDER BY occurred_at DESC LIMIT 1`,
        [signature, cluster]
      );
      existing = r?.rows?.[0] || null;
    }
  } catch { /* swallow */ }

  if (!existing) {
    existing = _memIncidents.find(
      (i) => i.issue_signature === signature && i.cluster_name === cluster && i.status === "open"
    );
  }

  if (existing) {
    // Update existing: bump seen_count and last_seen_at
    try {
      if (_dbReady) {
        await dbQuery(
          `UPDATE incident_history
           SET last_seen_at = NOW(), seen_count = seen_count + 1
           WHERE id = $1`,
          [existing.id]
        );
      }
    } catch { /* swallow */ }
    existing.last_seen_at = now;
    existing.seen_count = (existing.seen_count || 1) + 1;
    return existing;
  }

  // Insert new incident
  const newRec = {
    cluster_name: cluster,
    namespace,
    resource_type: resourceType,
    resource_name: resourceName,
    issue_signature: signature,
    issue_type: issueType,
    severity,
    context: context ? JSON.stringify(context).slice(0, 50000) : null,
    status: "open",
    occurred_at: now,
    last_seen_at: now,
    seen_count: 1,
  };

  try {
    if (_dbReady) {
      const r = await dbQuery(
        `INSERT INTO incident_history
         (cluster_name, namespace, resource_type, resource_name, issue_signature,
          issue_type, severity, context, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         RETURNING id`,
        [
          newRec.cluster_name, newRec.namespace, newRec.resource_type,
          newRec.resource_name, newRec.issue_signature, newRec.issue_type,
          newRec.severity, newRec.context, newRec.status,
        ]
      );
      newRec.id = r?.rows?.[0]?.id;
    }
  } catch (err) {
    console.warn("[learning-engine] recordIncident DB write failed:", err.message);
  }

  _memIncidents.unshift(newRec);
  if (_memIncidents.length > MAX_MEM) _memIncidents.pop();
  return newRec;
}

// ---------------------------------------------------------------------------
// Resolution recording — called when a fix command runs successfully
// ---------------------------------------------------------------------------

/**
 * Record the outcome of a fix that targeted a specific resource.
 * Tries to match an open incident by signature OR by resource+namespace,
 * then marks it resolved/failed.
 *
 * @param {object} args
 * @param {string} args.cluster
 * @param {string} args.namespace
 * @param {string} args.resourceName
 * @param {string} [args.signature] - explicit signature if known
 * @param {string} args.command - the kubectl/oc command that ran
 * @param {string} [args.summary] - short human-readable description
 * @param {boolean} args.success - did the fix succeed
 * @param {string} [args.user] - user/conversation identifier
 */
export async function recordResolution(args) {
  const {
    cluster = "local",
    namespace = "",
    resourceName = "",
    signature = null,
    command = "",
    summary = "",
    success = true,
    user = "",
  } = args || {};

  const now = new Date().toISOString();
  const targetStatus = success ? "resolved" : "fix-failed";
  const stripped = stripPodHash(resourceName);

  // Find the most relevant open incident
  let match = null;
  try {
    if (_dbReady) {
      let r;
      if (signature) {
        r = await dbQuery(
          `SELECT * FROM incident_history
           WHERE issue_signature = $1 AND cluster_name = $2 AND status = 'open'
           ORDER BY occurred_at DESC LIMIT 1`,
          [signature, cluster]
        );
      } else if (resourceName) {
        // Match by resource name pattern (deployment-name covers pods)
        r = await dbQuery(
          `SELECT * FROM incident_history
           WHERE cluster_name = $1 AND namespace = $2
             AND (resource_name = $3 OR resource_name LIKE $4)
             AND status = 'open'
           ORDER BY occurred_at DESC LIMIT 1`,
          [cluster, namespace, resourceName, `${stripped}%`]
        );
      }
      match = r?.rows?.[0] || null;
    }
  } catch { /* swallow */ }

  if (!match) {
    match = _memIncidents.find((i) => {
      if (i.cluster_name !== cluster || i.status !== "open") return false;
      if (signature && i.issue_signature === signature) return true;
      if (resourceName && i.namespace === namespace &&
          (i.resource_name === resourceName || stripPodHash(i.resource_name) === stripped)) {
        return true;
      }
      return false;
    });
  }

  if (!match) {
    // No matching open incident — record a "freestanding" resolution so
    // the team playbook still learns from this fix.
    return await recordFreestandingResolution({
      cluster, namespace, resourceName, command, summary, success, user,
    });
  }

  try {
    if (_dbReady) {
      await dbQuery(
        `UPDATE incident_history
         SET status = $1, resolution_command = $2, resolution_summary = $3,
             resolution_success = $4, resolution_user = $5, resolved_at = NOW()
         WHERE id = $6`,
        [targetStatus, command, summary || null, success, user || null, match.id]
      );
    }
  } catch (err) {
    console.warn("[learning-engine] recordResolution DB update failed:", err.message);
  }

  match.status = targetStatus;
  match.resolution_command = command;
  match.resolution_summary = summary;
  match.resolution_success = success;
  match.resolution_user = user;
  match.resolved_at = now;

  return match;
}

async function recordFreestandingResolution({
  cluster, namespace, resourceName, command, summary, success, user,
}) {
  const signature = buildSignature({ type: "ManualFix", resource: resourceName, namespace });
  const now = new Date().toISOString();
  const rec = {
    cluster_name: cluster,
    namespace,
    resource_type: "",
    resource_name: resourceName,
    issue_signature: signature,
    issue_type: "ManualFix",
    severity: 0,
    context: null,
    status: success ? "resolved" : "fix-failed",
    resolution_command: command,
    resolution_summary: summary,
    resolution_success: success,
    resolution_user: user,
    occurred_at: now,
    last_seen_at: now,
    resolved_at: now,
    seen_count: 1,
  };
  try {
    if (_dbReady) {
      const r = await dbQuery(
        `INSERT INTO incident_history
         (cluster_name, namespace, resource_name, issue_signature, issue_type,
          status, resolution_command, resolution_summary, resolution_success,
          resolution_user, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         RETURNING id`,
        [
          cluster, namespace, resourceName, signature, "ManualFix",
          rec.status, command, summary || null, success, user || null,
        ]
      );
      rec.id = r?.rows?.[0]?.id;
    }
  } catch { /* swallow */ }
  _memIncidents.unshift(rec);
  if (_memIncidents.length > MAX_MEM) _memIncidents.pop();
  return rec;
}

// ---------------------------------------------------------------------------
// Lookup — find similar past resolved incidents
// ---------------------------------------------------------------------------

/**
 * Find historical incidents matching a signature, cross-cluster + back-in-time.
 *
 * @param {string} signature
 * @param {object} opts
 * @param {string} [opts.cluster] - prefer same cluster matches
 * @param {number} [opts.sinceDays=90]
 * @param {number} [opts.limit=5]
 * @returns {Promise<Array>}
 */
export async function findSimilarIncidents(signature, opts = {}) {
  const { cluster = null, sinceDays = 90, limit = 5 } = opts;
  const sinceCutoff = new Date(Date.now() - sinceDays * 86400000).toISOString();

  let rows = [];
  try {
    if (_dbReady) {
      const r = await dbQuery(
        `SELECT * FROM incident_history
         WHERE issue_signature = $1 AND occurred_at > $2
         ORDER BY
           CASE WHEN status = 'resolved' THEN 0 ELSE 1 END,
           CASE WHEN cluster_name = $3 THEN 0 ELSE 1 END,
           occurred_at DESC
         LIMIT $4`,
        [signature, sinceCutoff, cluster || "", limit]
      );
      rows = r?.rows || [];
    }
  } catch { /* swallow */ }

  if (rows.length === 0) {
    rows = _memIncidents
      .filter((i) => i.issue_signature === signature)
      .sort((a, b) => {
        if (a.status === "resolved" && b.status !== "resolved") return -1;
        if (b.status === "resolved" && a.status !== "resolved") return 1;
        if (cluster && a.cluster_name === cluster && b.cluster_name !== cluster) return -1;
        if (cluster && b.cluster_name === cluster && a.cluster_name !== cluster) return 1;
        return new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
      })
      .slice(0, limit);
  }
  return rows;
}

/**
 * Top patterns — most-resolved-issues team playbook view.
 */
export async function getTeamPlaybook({ limit = 20, sinceDays = 90 } = {}) {
  const sinceCutoff = new Date(Date.now() - sinceDays * 86400000).toISOString();
  try {
    if (_dbReady) {
      const r = await dbQuery(
        `SELECT issue_signature, issue_type,
                COUNT(*) AS occurrences,
                COUNT(*) FILTER (WHERE status = 'resolved') AS resolved_count,
                COUNT(*) FILTER (WHERE resolution_success = true) AS successful_fixes,
                MAX(resolved_at) AS last_resolved,
                MAX(resolution_command) AS sample_command,
                COUNT(DISTINCT cluster_name) AS clusters_affected
         FROM incident_history
         WHERE occurred_at > $1
         GROUP BY issue_signature, issue_type
         HAVING COUNT(*) FILTER (WHERE status = 'resolved') > 0
         ORDER BY resolved_count DESC, occurrences DESC
         LIMIT $2`,
        [sinceCutoff, limit]
      );
      return r?.rows || [];
    }
  } catch { /* swallow */ }
  // In-memory fallback
  const groups = new Map();
  for (const i of _memIncidents) {
    if (!i.issue_signature) continue;
    const key = i.issue_signature;
    const g = groups.get(key) || {
      issue_signature: key,
      issue_type: i.issue_type,
      occurrences: 0, resolved_count: 0, successful_fixes: 0,
      last_resolved: null, sample_command: null, clusters: new Set(),
    };
    g.occurrences++;
    if (i.status === "resolved") g.resolved_count++;
    if (i.resolution_success) g.successful_fixes++;
    if (i.resolved_at && (!g.last_resolved || i.resolved_at > g.last_resolved)) {
      g.last_resolved = i.resolved_at;
      g.sample_command = i.resolution_command;
    }
    g.clusters.add(i.cluster_name);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.resolved_count > 0)
    .map((g) => ({ ...g, clusters_affected: g.clusters.size }))
    .sort((a, b) => b.resolved_count - a.resolved_count || b.occurrences - a.occurrences)
    .slice(0, limit);
}

/**
 * Get raw incident counts/stats for a quick health badge.
 */
export async function getIncidentStats({ cluster = null, sinceDays = 30 } = {}) {
  const sinceCutoff = new Date(Date.now() - sinceDays * 86400000).toISOString();
  try {
    if (_dbReady) {
      const r = await dbQuery(
        `SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'open') AS open_count,
            COUNT(*) FILTER (WHERE status = 'resolved') AS resolved_count,
            COUNT(*) FILTER (WHERE status = 'fix-failed') AS failed_count,
            COUNT(DISTINCT issue_signature) AS unique_patterns,
            COUNT(DISTINCT cluster_name) AS clusters_affected
         FROM incident_history
         WHERE occurred_at > $1
           AND ($2::text IS NULL OR cluster_name = $2)`,
        [sinceCutoff, cluster]
      );
      return r?.rows?.[0] || {};
    }
  } catch { /* swallow */ }
  return {
    total: _memIncidents.length,
    open_count: _memIncidents.filter((i) => i.status === "open").length,
    resolved_count: _memIncidents.filter((i) => i.status === "resolved").length,
    failed_count: _memIncidents.filter((i) => i.status === "fix-failed").length,
    unique_patterns: new Set(_memIncidents.map((i) => i.issue_signature)).size,
    clusters_affected: new Set(_memIncidents.map((i) => i.cluster_name)).size,
  };
}

// ---------------------------------------------------------------------------
// LLM context builder — pre-format past incidents for injection
// ---------------------------------------------------------------------------

/**
 * Build a markdown block summarizing past resolutions for an LLM prompt.
 * Designed to be injected into security/recommendations/investigation prompts.
 */
export function buildLearningContext(incidents, { currentCluster = null } = {}) {
  if (!incidents || incidents.length === 0) return "";

  const lines = ["", "--- Team Playbook: Similar Past Incidents ---"];
  const resolved = incidents.filter((i) => i.status === "resolved");
  if (resolved.length > 0) {
    lines.push(`Your team has resolved this exact pattern ${resolved.length} time(s) before:`);
    for (let i = 0; i < Math.min(resolved.length, 3); i++) {
      const r = resolved[i];
      const when = r.resolved_at ? new Date(r.resolved_at).toISOString().slice(0, 10) : "previously";
      const where = r.cluster_name && r.cluster_name !== currentCluster
        ? ` on cluster '${r.cluster_name}'`
        : "";
      lines.push(`  ${i + 1}. ${when}${where}, namespace '${r.namespace}': ${r.resolution_summary || "applied a fix"}`);
      if (r.resolution_command) {
        const cmd = String(r.resolution_command).slice(0, 200);
        lines.push(`     Command: ${cmd}`);
      }
    }
    lines.push("");
    lines.push("STRONG RECOMMENDATION: prefer the team's proven approach unless the situation differs materially.");
  } else {
    const open = incidents.filter((i) => i.status === "open");
    if (open.length > 0) {
      lines.push(`This pattern has been seen ${open.length} time(s) before but never resolved — proceed with extra caution and document the fix.`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stable signatures for proactive-agent insight types
// ---------------------------------------------------------------------------

/**
 * Convert a proactive-agent insight into a stable signature.
 * Insights have shape: { id, type, resource, namespace, severity, ... }
 */
export function signatureForInsight(insight) {
  if (!insight) return null;
  // Resource is e.g. "pod/user-6cb45b77db-g4bs5" — split into kind + name
  const [kind, ...rest] = (insight.resource || "").split("/");
  const rname = rest.join("/");
  return buildSignature({
    type: insight.type,
    resource: rname,
    namespace: insight.namespace,
    reason: insight.reason || extractReasonFromDetail(insight.detail),
  });
}

function extractReasonFromDetail(detail) {
  if (!detail) return null;
  const m = String(detail).match(/(OOMKilled|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|Evicted|ContainerCreating|NodeNotReady|DiskPressure|MemoryPressure)/);
  return m ? m[1] : null;
}
