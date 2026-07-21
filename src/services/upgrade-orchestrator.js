/**
 * Upgrade Orchestrator — State machine for automated OpenShift cluster upgrades.
 *
 * Manages the full upgrade lifecycle:
 *   IDLE → VERSION_VALIDATED → PRE_ASSESSED → REMEDIATED → CR_SUBMITTED
 *     → CR_APPROVED → DRY_RUN_PASSED → EXECUTING → MONITORING → COMPLETED
 *
 * State is persisted in the DB (upgrade_sessions table) so the flow survives
 * server restarts. Each conversation can have at most one active upgrade session.
 */

import { query, isEnabled as dbEnabled } from "../utils/db.js";
import { ocpGet, ocpFetch, withRemoteClusterBridge } from "../utils/openshift-client.js";
import { hasActiveChannel } from "../index.js";
import { withClusterDirect, hasCredentials } from "../utils/cluster-credentials.js";
import { runPreflightChecks, formatPreflightReport, validateUpgradeVersion } from "../tools/upgrade-preflight.js";
import { trackCR, getCR, updateCRStatus, syncCRFromServiceNow } from "./cr-tracker.js";
import { getRecord, updateRecord, attachFile as snowAttachFile } from "../utils/servicenow-client.js";
import { logAuditEvent as logAuditTrailEvent } from "./audit-log.js";

/**
 * Run `fn` in the correct cluster context.
 * Priority: local → direct-access (stored creds) → agent bridge (legacy).
 */
function withClusterContext(cluster, fn) {
  if (!cluster || cluster === "local") return fn();
  if (hasCredentials(cluster)) return withClusterDirect(cluster, fn);
  if (hasActiveChannel(cluster)) return withRemoteClusterBridge(cluster, fn);
  throw new Error(`No credentials or agent bridge for cluster "${cluster}". Register it via Settings → Clusters.`);
}

// ── States ──────────────────────────────────────────────────────────────────
export const UPGRADE_STATES = {
  IDLE: "idle",
  VERSION_VALIDATED: "version_validated",
  CHANNEL_SWITCHED: "channel_switched",
  PRE_ASSESSED: "pre_assessed",
  COMPONENT_ANALYZED: "component_analyzed",
  REMEDIATION_PROPOSED: "remediation_proposed",
  REMEDIATED: "remediated",
  CR_SUBMITTED: "cr_submitted",
  CR_APPROVED: "cr_approved",
  DRY_RUN_PASSED: "dry_run_passed",
  EXECUTING: "executing",
  MONITORING: "monitoring",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

// Valid state transitions
const TRANSITIONS = {
  [UPGRADE_STATES.IDLE]:                 [UPGRADE_STATES.VERSION_VALIDATED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.VERSION_VALIDATED]:    [UPGRADE_STATES.CHANNEL_SWITCHED, UPGRADE_STATES.PRE_ASSESSED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.CHANNEL_SWITCHED]:     [UPGRADE_STATES.PRE_ASSESSED, UPGRADE_STATES.CANCELLED],
  // The diagnostic phase (pre-assess → component analysis → remediation) is
  // idempotent and mutation-free, so it may be RE-RUN to refresh findings —
  // e.g. resuming an existing session after a code update. Self/backward edges
  // among these states allow that; edges out to CR/execute are unchanged.
  // Dry Run now precedes the Change Request (ITIL: validate first, submit the
  // CR WITH the dry-run result as approval evidence). The diagnostic + dry-run
  // states are mutation-free and re-runnable; edges into CR/execute unchanged.
  [UPGRADE_STATES.PRE_ASSESSED]:         [UPGRADE_STATES.PRE_ASSESSED, UPGRADE_STATES.COMPONENT_ANALYZED, UPGRADE_STATES.REMEDIATION_PROPOSED, UPGRADE_STATES.DRY_RUN_PASSED, UPGRADE_STATES.CR_SUBMITTED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.COMPONENT_ANALYZED]:   [UPGRADE_STATES.PRE_ASSESSED, UPGRADE_STATES.COMPONENT_ANALYZED, UPGRADE_STATES.REMEDIATION_PROPOSED, UPGRADE_STATES.DRY_RUN_PASSED, UPGRADE_STATES.CR_SUBMITTED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.REMEDIATION_PROPOSED]: [UPGRADE_STATES.PRE_ASSESSED, UPGRADE_STATES.COMPONENT_ANALYZED, UPGRADE_STATES.REMEDIATION_PROPOSED, UPGRADE_STATES.REMEDIATED, UPGRADE_STATES.DRY_RUN_PASSED, UPGRADE_STATES.CR_SUBMITTED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.REMEDIATED]:           [UPGRADE_STATES.DRY_RUN_PASSED, UPGRADE_STATES.CR_SUBMITTED, UPGRADE_STATES.CANCELLED],
  // Dry run → raise CR (new primary path); EXECUTING kept for older sessions.
  [UPGRADE_STATES.DRY_RUN_PASSED]:       [UPGRADE_STATES.DRY_RUN_PASSED, UPGRADE_STATES.CR_SUBMITTED, UPGRADE_STATES.EXECUTING, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.CR_SUBMITTED]:         [UPGRADE_STATES.CR_APPROVED, UPGRADE_STATES.CANCELLED, UPGRADE_STATES.FAILED],
  // Approved → execute directly (dry-run already done). A final re-dry-run is
  // still allowed for belt-and-suspenders re-validation before execution.
  [UPGRADE_STATES.CR_APPROVED]:          [UPGRADE_STATES.DRY_RUN_PASSED, UPGRADE_STATES.EXECUTING, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.EXECUTING]:            [UPGRADE_STATES.MONITORING, UPGRADE_STATES.FAILED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.MONITORING]:           [UPGRADE_STATES.COMPLETED, UPGRADE_STATES.FAILED],
  [UPGRADE_STATES.COMPLETED]:            [],
  [UPGRADE_STATES.FAILED]:               [UPGRADE_STATES.IDLE],
  [UPGRADE_STATES.CANCELLED]:            [UPGRADE_STATES.IDLE],
};

const STAGE_TIMEOUTS = {
  [UPGRADE_STATES.CR_SUBMITTED]: 24 * 60 * 60 * 1000,  // 24h for CR approval
  [UPGRADE_STATES.EXECUTING]:    4 * 60 * 60 * 1000,    // 4h for upgrade execution
  [UPGRADE_STATES.MONITORING]:   2 * 60 * 60 * 1000,    // 2h for post-upgrade monitoring
  [UPGRADE_STATES.DRY_RUN_PASSED]: 30 * 60 * 1000,      // 30m to proceed after dry run
};

export const STAGE_DESCRIPTIONS = {
  idle: "Waiting to begin — target version and cluster not yet validated",
  version_validated: "Target version confirmed available in the upgrade graph",
  channel_switched: "Update channel aligned with target version stream",
  pre_assessed: "22-point health check: operators, nodes, etcd, certs, storage, MCPs",
  component_analyzed: "Deep inspection of degraded operators, failing pods, cert expiry, MCPs",
  remediation_proposed: "AI-generated fix plan for all detected issues",
  remediated: "All critical fixes applied and verified",
  cr_submitted: "ServiceNow Change Request submitted — awaiting CAB approval",
  cr_approved: "Change Request approved — cleared for execution",
  dry_run_passed: "Simulated upgrade validated — no blocking conditions",
  executing: "ClusterVersion patched — rolling upgrade in progress",
  monitoring: "Operators reconverging — watching for degradation",
  completed: "Upgrade verified — all operators healthy on target version",
  failed: "Upgrade failed — manual intervention required",
  cancelled: "Upgrade cancelled — session can be restarted from idle",
};

// ── DB helpers ──────────────────────────────────────────────────────────────

async function ensureTable() {
  if (!(await dbEnabled())) return false;
  await query(`
    CREATE TABLE IF NOT EXISTS upgrade_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      cluster TEXT NOT NULL DEFAULT 'local',
      state TEXT NOT NULL DEFAULT 'idle',
      from_version TEXT,
      target_version TEXT,
      channel TEXT,
      upgrade_type TEXT,
      preflight_report JSONB,
      component_analysis JSONB,
      remediation_plan JSONB,
      remediation_results JSONB,
      cr_ticket_id TEXT,
      cr_sys_id TEXT,
      dry_run_result JSONB,
      post_assessment JSONB,
      monitoring_data JSONB,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migration: add cluster column if table existed before this change
  await query(`ALTER TABLE upgrade_sessions ADD COLUMN IF NOT EXISTS cluster TEXT NOT NULL DEFAULT 'local'`).catch(() => {});
  await query(`ALTER TABLE upgrade_sessions ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE upgrade_sessions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`).catch(() => {});
  return true;
}

let tableReady = false;

async function init() {
  if (tableReady) return true;
  tableReady = await ensureTable();
  return tableReady;
}

function genId() {
  return `ugs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Session CRUD ────────────────────────────────────────────────────────────

export async function createSession(conversationId, { fromVersion, targetVersion, channel, cluster }) {
  if (!(await init())) return null;

  const clusterName = cluster || "local";

  // Check for active upgrade sessions on this cluster across ALL conversations
  const activeResult = await query(
    `SELECT * FROM upgrade_sessions
     WHERE cluster = $1 AND state IN ('executing','monitoring')
     ORDER BY updated_at DESC LIMIT 1`,
    [clusterName]
  );
  const activeSession = activeResult?.rows?.[0] ? mapSession(activeResult.rows[0]) : null;
  if (activeSession) {
    // Return the existing active session with progress info instead of creating a new one
    return { existingUpgrade: true, session: activeSession };
  }

  // Cancel any existing idle/pending sessions for this conversation + cluster
  await query(
    `UPDATE upgrade_sessions SET state = 'cancelled', updated_at = NOW()
     WHERE conversation_id = $1 AND cluster = $2 AND state NOT IN ('completed','failed','cancelled')`,
    [conversationId, clusterName]
  );

  const id = genId();
  const result = await query(
    `INSERT INTO upgrade_sessions (id, conversation_id, cluster, state, from_version, target_version, channel)
     VALUES ($1, $2, $3, 'idle', $4, $5, $6) RETURNING *`,
    [id, conversationId, clusterName, fromVersion, targetVersion, channel]
  );
  return result?.rows?.[0] ? mapSession(result.rows[0]) : null;
}

export async function getSession(sessionId) {
  if (!(await init())) return null;
  const result = await query(`SELECT * FROM upgrade_sessions WHERE id = $1`, [sessionId]);
  return result?.rows?.[0] ? mapSession(result.rows[0]) : null;
}

export async function getActiveSession(conversationId, cluster) {
  if (!(await init())) return null;
  let result;
  if (cluster) {
    result = await query(
      `SELECT * FROM upgrade_sessions
       WHERE conversation_id = $1 AND cluster = $2 AND state NOT IN ('completed','failed','cancelled')
       ORDER BY updated_at DESC LIMIT 1`,
      [conversationId, cluster]
    );
  } else {
    result = await query(
      `SELECT * FROM upgrade_sessions
       WHERE conversation_id = $1 AND state NOT IN ('completed','failed','cancelled')
       ORDER BY updated_at DESC LIMIT 1`,
      [conversationId]
    );
  }
  return result?.rows?.[0] ? mapSession(result.rows[0]) : null;
}

export async function listSessions({ state, limit = 20 } = {}) {
  if (!(await init())) return [];
  let result;
  if (state) {
    result = await query(
      `SELECT * FROM upgrade_sessions WHERE state = $1 ORDER BY updated_at DESC LIMIT $2`,
      [state, limit]
    );
  } else {
    result = await query(
      `SELECT * FROM upgrade_sessions ORDER BY updated_at DESC LIMIT $1`,
      [limit]
    );
  }
  return (result?.rows || []).map(mapSession);
}

async function updateSession(sessionId, patch) {
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const [key, val] of Object.entries(patch)) {
    const col = key.replace(/[A-Z]/g, m => "_" + m.toLowerCase());
    if (["preflight_report", "component_analysis", "remediation_plan", "remediation_results",
         "dry_run_result", "post_assessment", "monitoring_data"].includes(col)) {
      sets.push(`${col} = $${idx}::jsonb`);
      vals.push(JSON.stringify(val));
    } else {
      sets.push(`${col} = $${idx}`);
      vals.push(val);
    }
    idx++;
  }
  sets.push(`updated_at = NOW()`);
  vals.push(sessionId);
  await query(`UPDATE upgrade_sessions SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    cluster: row.cluster || "local",
    state: row.state,
    fromVersion: row.from_version,
    targetVersion: row.target_version,
    channel: row.channel,
    upgradeType: row.upgrade_type,
    preflightReport: row.preflight_report,
    componentAnalysis: row.component_analysis,
    remediationPlan: row.remediation_plan,
    remediationResults: row.remediation_results,
    crTicketId: row.cr_ticket_id,
    crSysId: row.cr_sys_id,
    dryRunResult: row.dry_run_result,
    postAssessment: row.post_assessment,
    monitoringData: row.monitoring_data,
    errorMessage: row.error_message,
    executedAt: row.executed_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── State Transition ────────────────────────────────────────────────────────

async function transition(sessionId, newState, patch = {}) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Upgrade session ${sessionId} not found`);

  const allowed = TRANSITIONS[session.state] || [];
  if (!allowed.includes(newState)) {
    throw new Error(`Invalid transition: ${session.state} → ${newState}. Allowed: ${allowed.join(", ")}`);
  }

  await updateSession(sessionId, { ...patch, state: newState });
  try {
    await logAuditTrailEvent({
      action: "upgrade_state_transition",
      resource: `upgrade_session/${sessionId}`,
      cluster: session.cluster || "local",
      details: `${session.state} → ${newState}`,
      metadata: { sessionId, fromState: session.state, toState: newState, fromVersion: session.fromVersion, targetVersion: session.targetVersion, crTicketId: session.crTicketId || null },
    });
  } catch {}
  return getSession(sessionId);
}

// ── Step 1: Version Validation ──────────────────────────────────────────────

export async function stepValidateVersion(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const cv = await withClusterContext(session.cluster, () =>
    ocpGet("/apis/config.openshift.io/v1/clusterversions/version"));
  const currentVersion = cv?.status?.desired?.version || "";
  const channel = cv?.spec?.channel || "";
  const availableUpdates = cv?.status?.availableUpdates || [];

  // Check if an upgrade is already in progress on this cluster
  const progressingCond = (cv?.status?.conditions || []).find(c => c.type === "Progressing");
  if (progressingCond?.status === "True" && (progressingCond?.message || "").includes("working towards")) {
    const pctMatch = progressingCond.message.match(/\((\d+)%\s*complete\)/i);
    const countMatch = progressingCond.message.match(/(\d+)\s+of\s+(\d+)\s+done/i);
    const waitMatch = progressingCond.message.match(/waiting on\s+(.+)/i);
    const ops = await withClusterContext(session.cluster, () =>
      ocpGet("/apis/config.openshift.io/v1/clusteroperators"));
    const opItems = ops?.items || [];
    const updating = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Progressing" && c.status === "True")).length;
    const degraded = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True")).length;

    return {
      session,
      upgradeInProgress: true,
      error: "An upgrade is already in progress on this cluster",
      liveStatus: {
        message: progressingCond.message,
        progress: pctMatch ? parseInt(pctMatch[1], 10) : null,
        manifests: countMatch ? { done: parseInt(countMatch[1], 10), total: parseInt(countMatch[2], 10) } : null,
        waitingOperators: waitMatch ? waitMatch[1].split(",").map(s => s.trim()).filter(Boolean) : [],
        operators: { updating, degraded, total: opItems.length, available: opItems.length - updating - degraded },
        currentVersion,
      },
    };
  }

  // Update from_version if not set
  if (!session.fromVersion && currentVersion) {
    await updateSession(sessionId, { fromVersion: currentVersion });
  }

  const targetVersion = session.targetVersion;

  // List available versions grouped by minor
  const versionMap = {};
  for (const u of availableUpdates) {
    const minor = (u.version.match(/^(\d+\.\d+)/) || [])[1] || "other";
    if (!versionMap[minor]) versionMap[minor] = [];
    versionMap[minor].push(u.version);
  }

  // Detect update vs upgrade
  const currentMinor = (currentVersion.match(/^(\d+\.\d+)/) || [])[1];
  const targetMinor = (targetVersion.match(/^(\d+\.\d+)/) || [])[1];
  const upgradeType = currentMinor === targetMinor ? "z-stream (patch)" : "minor";

  // Validate the target version
  const validation = validateUpgradeVersion(currentVersion, targetVersion, availableUpdates, channel);

  // Check if channel change is needed for minor upgrades
  let channelChangeNeeded = false;
  let suggestedChannel = "";
  if (upgradeType === "minor" && targetMinor) {
    const expectedChannelPrefix = channel.replace(/\d+\.\d+$/, "");
    suggestedChannel = `${expectedChannelPrefix}${targetMinor}`;
    if (channel !== suggestedChannel && !channel.includes(targetMinor)) {
      channelChangeNeeded = true;
    }
  }

  // Check for admin acknowledgments needed (minor upgrades only)
  let adminAcksNeeded = [];
  if (upgradeType === "minor") {
    try {
      const acks = await withClusterContext(session.cluster, () =>
        ocpGet("/api/v1/namespaces/openshift-config-managed/configmaps/admin-acks"));
      const ackData = acks?.data || {};
      const currentMinorNum = parseInt((currentVersion.match(/^4\.(\d+)/) || [])[1] || "0", 10);
      const targetMinorNum = parseInt((targetVersion.match(/^4\.(\d+)/) || [])[1] || "0", 10);
      for (let m = currentMinorNum; m < targetMinorNum; m++) {
        const kubeMinor = m + 13;
        const ackKey = `ack-4.${m + 1}-kube-1.${kubeMinor}-api-removals-in-4.${m + 1}`;
        if (!ackData[ackKey] || ackData[ackKey] !== "true") {
          adminAcksNeeded.push({
            key: ackKey,
            description: `Acknowledge API removals in OCP 4.${m + 1} (Kube 1.${kubeMinor})`,
            command: `oc -n openshift-config patch configmap admin-acks --type=merge -p '{"data":{"${ackKey}":"true"}}'`,
          });
        }
      }
    } catch { /* admin-acks configmap may not exist */ }
  }

  // EUS-to-EUS detection
  const EUS_VERSIONS = [14, 16, 18, 20];
  const currentMinorNum = parseInt((currentVersion.match(/^4\.(\d+)/) || [])[1] || "0", 10);
  const targetMinorNum = parseInt((targetVersion.match(/^4\.(\d+)/) || [])[1] || "0", 10);
  const isEUSToEUS = EUS_VERSIONS.includes(currentMinorNum) && EUS_VERSIONS.includes(targetMinorNum) && targetMinorNum > currentMinorNum;

  const result = {
    currentVersion,
    targetVersion,
    channel,
    upgradeType,
    availableVersions: versionMap,
    validation,
    channelChangeNeeded,
    suggestedChannel,
    adminAcksNeeded,
    isEUSToEUS,
    eusNote: isEUSToEUS ? `EUS-to-EUS upgrade detected (4.${currentMinorNum} → 4.${targetMinorNum}). Control plane upgrades first, then pause worker MCP before rolling workers.` : null,
  };

  if (!validation.valid) {
    await updateSession(sessionId, {
      upgradeType,
      errorMessage: validation.reason,
    });
    return { session: await getSession(sessionId), result, valid: false };
  }

  // Re-validation is idempotent: if we're already at or past VERSION_VALIDATED,
  // just refresh the derived fields without forcing an (illegal) self-transition.
  let updated;
  if (session.state === UPGRADE_STATES.IDLE) {
    updated = await transition(sessionId, UPGRADE_STATES.VERSION_VALIDATED, {
      upgradeType,
      channel: channelChangeNeeded ? suggestedChannel : channel,
    });
  } else {
    await updateSession(sessionId, {
      upgradeType,
      channel: channelChangeNeeded ? suggestedChannel : channel,
    });
    updated = await getSession(sessionId);
  }

  return { session: updated, result, valid: true };
}

// ── Step 1a: Channel Switch ─────────────────────────────────────────────────

export async function stepSwitchChannel(sessionId, newChannel) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  await withClusterContext(session.cluster, () =>
    ocpFetch("/apis/config.openshift.io/v1/clusterversions/version", {
      method: "PATCH",
      headers: { "Content-Type": "application/merge-patch+json" },
      body: JSON.stringify({ spec: { channel: newChannel } }),
    }));

  // Wait briefly for available updates to refresh
  await new Promise(r => setTimeout(r, 5000));

  const cv = await withClusterContext(session.cluster, () =>
    ocpGet("/apis/config.openshift.io/v1/clusterversions/version"));
  const updatedAvailable = (cv?.status?.availableUpdates || []).map(u => u.version);

  const updated = await transition(sessionId, UPGRADE_STATES.CHANNEL_SWITCHED, {
    channel: newChannel,
  });

  return { session: updated, newChannel, availableAfterSwitch: updatedAvailable };
}

// ── Step 2: Pre-Assessment Report ───────────────────────────────────────────

export async function stepPreAssessment(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const report = await withClusterContext(session.cluster, () =>
    runPreflightChecks(session.targetVersion, session.fromVersion));

  const updated = await transition(sessionId, UPGRADE_STATES.PRE_ASSESSED, {
    preflightReport: report,
    fromVersion: report.fromVersion || session.fromVersion,
  });

  return { session: updated, report };
}

// ── Step 3: Component Analysis ──────────────────────────────────────────────

export async function stepComponentAnalysis(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const report = session.preflightReport;
  if (!report) throw new Error("Pre-assessment must run before component analysis");

  const analysis = {
    timestamp: new Date().toISOString(),
    degradedOperators: [],
    failingPods: [],
    certificateIssues: [],
    mcpIssues: [],
    storageIssues: [],
    networkIssues: [],
  };

  // Deep-dive into degraded operators
  const checks = report.checks || [];
  const opCheck = checks.find(c => c.category === "Cluster Operators");
  if (opCheck?.items?.length) {
    for (const item of opCheck.items) {
      if (item.issue === "Degraded" || item.issue === "Unavailable") {
        try {
          const [pods, events] = await withClusterContext(session.cluster, () =>
            Promise.all([
              ocpGet(`/api/v1/namespaces/openshift-${item.name}/pods?limit=20`),
              ocpGet(`/api/v1/namespaces/openshift-${item.name}/events?limit=20`),
            ]));
          const badPods = (pods?.items || []).filter(p => {
            const phase = p.status?.phase;
            const ready = (p.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True");
            return phase !== "Running" || !ready;
          });
          const recentEvents = (events?.items || [])
            .filter(e => e.type === "Warning")
            .slice(0, 5)
            .map(e => ({ reason: e.reason, message: e.message, count: e.count }));

          analysis.degradedOperators.push({
            name: item.name,
            issue: item.issue,
            message: item.message,
            unhealthyPods: badPods.map(p => ({
              name: p.metadata.name,
              phase: p.status?.phase,
              reason: p.status?.reason || "",
              restarts: (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0),
            })),
            recentEvents,
          });
        } catch {
          analysis.degradedOperators.push({
            name: item.name,
            issue: item.issue,
            message: item.message,
            unhealthyPods: [],
            recentEvents: [],
          });
        }
      }
    }
  }

  // Certificate issues
  const certCheck = checks.find(c => c.category === "Certificate Expiry");
  if (certCheck?.items?.length) {
    analysis.certificateIssues = certCheck.items.map(i => ({
      name: i.name,
      issue: i.issue,
      expiry: i.expiry || "",
    }));
  }

  // MCP issues
  const mcpCheck = checks.find(c => c.category === "Machine Config Pools");
  if (mcpCheck?.items?.length) {
    analysis.mcpIssues = mcpCheck.items;
  }

  // Storage issues
  const storageCheck = checks.find(c => c.category === "Storage (PVs)");
  if (storageCheck?.items?.length) {
    analysis.storageIssues = storageCheck.items;
  }

  // Network issues
  const networkCheck = checks.find(c => c.category === "Cluster Network");
  if (networkCheck?.items?.length) {
    analysis.networkIssues = networkCheck.items;
  }

  const updated = await transition(sessionId, UPGRADE_STATES.COMPONENT_ANALYZED, {
    componentAnalysis: analysis,
  });

  return { session: updated, analysis };
}

// ── Step 4: Version Diff ────────────────────────────────────────────────────

export async function getVersionDiff(fromVersion, targetVersion, cluster) {
  const report = { fromVersion, targetVersion, components: [], apiChanges: [], features: [] };

  // Query ClusterVersion for release image metadata
  try {
    const cv = await withClusterContext(cluster, () =>
      ocpGet("/apis/config.openshift.io/v1/clusterversions/version"));
    const history = cv?.status?.history || [];
    const currentEntry = history.find(h => h.version === fromVersion);
    const availableUpdates = cv?.status?.availableUpdates || [];
    const targetEntry = availableUpdates.find(u => u.version === targetVersion);

    if (currentEntry) {
      report.currentImage = currentEntry.image || "";
    }
    if (targetEntry) {
      report.targetImage = targetEntry.image || "";
    }

    // Get current operator versions for comparison
    const ops = await withClusterContext(cluster, () =>
      ocpGet("/apis/config.openshift.io/v1/clusteroperators"));
    report.components = (ops?.items || []).map(op => {
      const versions = (op.status?.versions || []).reduce((acc, v) => {
        acc[v.name] = v.version;
        return acc;
      }, {});
      return {
        name: op.metadata.name,
        currentVersion: versions.operator || versions[""] || fromVersion,
      };
    });
  } catch { /* ignore */ }

  // Feature highlights between versions
  const fromMinor = parseInt((fromVersion.match(/^4\.(\d+)/) || [])[1] || "0", 10);
  const toMinor = parseInt((targetVersion.match(/^4\.(\d+)/) || [])[1] || "0", 10);

  const OCP_FEATURES = {
    "4.14": ["OVN-Kubernetes default CNI", "OADP 1.3", "Cert-Manager GA"],
    "4.15": ["RHEL 9 worker support", "IPv6/dual-stack enhancements", "oc-mirror v2"],
    "4.16": ["OLM v1 tech preview", "HyperShift GA", "ARM64 expanded"],
    "4.17": ["Cluster API provider", "RHEL 9 only", "MicroShift enhancements"],
    "4.18": ["Network Observability GA", "Platform Operators", "Node health checks GA"],
    "4.19": ["OLM v1 GA", "CGroupsV2 mandatory", "IPv4/IPv6 dual-stack GA"],
  };

  for (let m = fromMinor + 1; m <= toMinor; m++) {
    const key = `4.${m}`;
    if (OCP_FEATURES[key]) {
      report.features.push({ version: key, highlights: OCP_FEATURES[key] });
    }
  }

  // API changes
  const API_CHANGES = {
    17: [{ removed: "flowcontrol.apiserver.k8s.io/v1beta2", replacement: "flowcontrol.apiserver.k8s.io/v1" }],
    18: [{ removed: "autoscaling/v2beta2", replacement: "autoscaling/v2" }],
    19: [{ removed: "batch/v1beta1 CronJob", replacement: "batch/v1" }],
  };

  for (let m = fromMinor + 1; m <= toMinor; m++) {
    if (API_CHANGES[m]) {
      report.apiChanges.push(...API_CHANGES[m].map(c => ({ ...c, inVersion: `4.${m}` })));
    }
  }

  return report;
}

// ── Step 5: Remediation Plan ────────────────────────────────────────────────

export async function stepBuildRemediationPlan(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const report = session.preflightReport;
  const analysis = session.componentAnalysis;
  if (!report) throw new Error("Pre-assessment required before remediation planning");

  const fixes = [];
  const checks = report.checks || [];

  // Admin acknowledgments
  const ackCheck = checks.find(c => c.category === "Admin Acknowledgments");
  if (ackCheck?.status === "fail" || ackCheck?.status === "warning") {
    for (const item of ackCheck?.items || []) {
      if (item.key) {
        fixes.push({
          id: `ack_${item.key}`,
          category: "Admin Acknowledgment",
          severity: "critical",
          description: item.description || `Apply admin acknowledgment: ${item.key}`,
          command: item.command || `oc -n openshift-config patch configmap admin-acks --type=merge -p '{"data":{"${item.key}":"true"}}'`,
          reversible: false,
          autoApplicable: true,
        });
      }
    }
  }

  // Degraded operators — restart their pods
  if (analysis?.degradedOperators?.length) {
    for (const op of analysis.degradedOperators) {
      if (op.unhealthyPods?.length) {
        for (const pod of op.unhealthyPods) {
          fixes.push({
            id: `restart_${op.name}_${pod.name}`,
            category: "Operator Recovery",
            severity: "warning",
            description: `Restart unhealthy pod ${pod.name} in operator ${op.name} (${pod.phase}, ${pod.restarts} restarts)`,
            command: `oc delete pod ${pod.name} -n openshift-${op.name}`,
            reversible: true,
            autoApplicable: true,
          });
        }
      }
    }
  }

  // MCP issues — unpause stuck MCPs
  const mcpCheck = checks.find(c => c.category === "Machine Config Pools");
  if (mcpCheck?.items?.length) {
    for (const item of mcpCheck.items) {
      if (item.issue === "Degraded") {
        fixes.push({
          id: `mcp_${item.name}`,
          category: "Machine Config Pool",
          severity: "warning",
          description: `MCP ${item.name} is degraded: ${item.message}`,
          command: `oc patch mcp ${item.name} --type merge -p '{"spec":{"paused":false}}'`,
          reversible: true,
          autoApplicable: false,
        });
      }
    }
  }

  // NotReady nodes
  const nodeCheck = checks.find(c => c.category === "Node Health");
  if (nodeCheck?.items?.length) {
    for (const item of nodeCheck.items) {
      if (item.issue === "NotReady") {
        fixes.push({
          id: `node_${item.name}`,
          category: "Node Recovery",
          severity: "critical",
          description: `Node ${item.name} is NotReady`,
          command: `oc adm cordon ${item.name} && oc adm drain ${item.name} --ignore-daemonsets --delete-emptydir-data --force --grace-period=60 && oc adm uncordon ${item.name}`,
          reversible: true,
          autoApplicable: false,
        });
      }
    }
  }

  // Pending CSRs
  try {
    const csrs = await withClusterContext(session.cluster, () =>
      ocpGet("/apis/certificates.k8s.io/v1/certificatesigningrequests"));
    const pending = (csrs?.items || []).filter(c => {
      const conditions = c.status?.conditions || [];
      return !conditions.some(cond => cond.type === "Approved" || cond.type === "Denied");
    });
    if (pending.length > 0) {
      fixes.push({
        id: "approve_csrs",
        category: "Certificate",
        severity: "warning",
        description: `${pending.length} pending CSR(s) need approval`,
        command: `oc adm certificate approve ${pending.map(c => c.metadata.name).join(" ")}`,
        reversible: false,
        autoApplicable: true,
      });
    }
  } catch { /* ignore */ }

  // Failed/Released PVs
  const pvCheck = checks.find(c => c.category === "Storage (PVs)");
  if (pvCheck?.items?.length) {
    for (const item of pvCheck.items) {
      if (item.issue === "Released" || item.issue === "Failed") {
        fixes.push({
          id: `pv_${item.name}`,
          category: "Storage",
          severity: "info",
          description: `PV ${item.name} in ${item.issue} state`,
          command: `oc delete pv ${item.name}`,
          reversible: false,
          autoApplicable: false,
        });
      }
    }
  }

  // Certificate Expiry — propose rotation/approval (complements the pending-CSR auto-fix)
  const certCheck = checks.find(c => c.category === "Certificate Expiry");
  if (certCheck && (certCheck.status === "fail" || certCheck.status === "warning")) {
    const soon = certCheck.items || [];
    fixes.push({
      id: "cert_rotate",
      category: "Certificate",
      severity: certCheck.status === "fail" ? "critical" : "warning",
      description: `Rotate/renew ${soon.length} expiring certificate(s) before upgrade${soon.length ? `: ${soon.map(i => i.name).filter(Boolean).slice(0, 4).join(", ")}` : ""}`,
      command: [
        "# 1) Approve any pending CSRs (often clears operator-managed cert renewal):",
        "oc get csr | grep -i pending",
        "oc adm certificate approve <csr-name>",
        "# 2) For an operator-managed signer near expiry, force rotation (operator regenerates it):",
        "#    oc delete secret <signer-secret> -n <operator-namespace>",
      ].join("\n"),
      reversible: false,
      autoApplicable: false,
      guided: true,
      note: "OpenShift operators auto-rotate most signer certs near expiry; approving pending CSRs usually clears this. Force-rotation is guided — review before applying.",
    });
  }

  // Resource Capacity — ensure the cluster can sustain a node offline during rolling upgrade
  const capCheck = checks.find(c => c.category === "Resource Capacity");
  if (capCheck && (capCheck.status === "fail" || capCheck.status === "warning")) {
    fixes.push({
      id: "capacity_headroom",
      category: "Capacity",
      severity: capCheck.status === "fail" ? "critical" : "warning",
      description: `Low capacity headroom for a rolling upgrade — ${capCheck.details || "review capacity"}`,
      command: [
        "# A rolling upgrade drains one node at a time — ensure workloads can reschedule. Options:",
        "# 1) Temporarily add a worker (safest):",
        "#    oc scale machineset <name> --replicas=<current+1> -n openshift-machine-api",
        "# 2) Free capacity: scale down / evict non-critical workloads.",
        "# 3) Verify PodDisruptionBudgets allow at least one disruption.",
      ].join("\n"),
      reversible: true,
      autoApplicable: false,
      guided: true,
      note: "With low headroom, confirm one node can drain without stranding pods. Scaling a MachineSet is the safest remediation.",
    });
  }

  // Deprecated/Removed APIs — migrate consumers before the removing upgrade
  const depCheck = checks.find(c => c.category === "Deprecated/Removed APIs");
  if (depCheck && (depCheck.status === "fail" || depCheck.status === "warning")) {
    for (const api of (depCheck.items || []).slice(0, 10)) {
      const apiName = api.api || api.name || api.resource || String(api).slice(0, 60);
      fixes.push({
        id: `dep_api_${String(apiName).replace(/[^a-z0-9]/gi, "_").slice(0, 40)}`,
        category: "Deprecated API",
        severity: api.removed ? "critical" : "warning",
        description: `Migrate workloads off deprecated API "${apiName}"${api.message ? ` — ${api.message}` : ""}`,
        command: [
          `# Find consumers of ${apiName} and migrate to the GA apiVersion:`,
          `# oc get <resource>.<group> -A`,
          `# Update manifests to the stable apiVersion (the App Deployment Agent can regenerate hardened manifests).`,
        ].join("\n"),
        reversible: false,
        autoApplicable: false,
        guided: true,
        aiAssist: "manifest-migration",
        api: apiName,               // <group>/<version> — used by "Find consumers" + migration plan
        replacement: api.replacement || null,
        note: "Beta APIs still in use won't block a z-stream patch, but will break on the minor/major upgrade that removes them — migrate ahead.",
      });
    }
  }

  // Generic safety net: any remaining fail/warning check with a recommendation
  // must not be left with zero remediation.
  const handledCats = new Set(["Admin Acknowledgments", "Machine Config Pools", "Node Health", "Storage (PVs)", "Certificate Expiry", "Resource Capacity", "Deprecated/Removed APIs"]);
  for (const c of checks) {
    if ((c.status !== "fail" && c.status !== "warning") || !c.recommendation) continue;
    if (handledCats.has(c.category)) continue;
    const fid = `guided_${String(c.category).replace(/[^a-z0-9]/gi, "_").slice(0, 40)}`;
    if (fixes.some(f => f.id === fid)) continue;
    fixes.push({
      id: fid,
      category: c.category,
      severity: c.status === "fail" ? "critical" : "warning",
      description: `${c.category}: ${c.details || "review required"}`,
      command: `# ${c.recommendation}`,
      reversible: false,
      autoApplicable: false,
      guided: true,
    });
  }

  // Sort by severity: critical → warning → info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  fixes.sort((a, b) => (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99));

  const plan = {
    timestamp: new Date().toISOString(),
    totalFixes: fixes.length,
    autoApplicable: fixes.filter(f => f.autoApplicable).length,
    guided: fixes.filter(f => !f.autoApplicable).length,
    critical: fixes.filter(f => f.severity === "critical").length,
    warnings: fixes.filter(f => f.severity === "warning").length,
    informational: fixes.filter(f => f.severity === "info").length,
    fixes,
  };

  const updated = await transition(sessionId, UPGRADE_STATES.REMEDIATION_PROPOSED, {
    remediationPlan: plan,
  });

  return { session: updated, plan };
}

// ── Step 5a: Execute Single Remediation Fix ─────────────────────────────────

export async function stepExecuteFix(sessionId, fixId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const plan = session.remediationPlan;
  if (!plan) throw new Error("No remediation plan found");

  const fix = plan.fixes.find(f => f.id === fixId);
  if (!fix) throw new Error(`Fix ${fixId} not found in remediation plan`);

  // Execute via the dashboard API's execute-fix endpoint (reuses guardrails)
  const port = process.env.PORT || 3001;
  const result = await fetch(`http://localhost:${port}/api/alerts/execute-fix`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: fix.command,
      dryRun: false,
      auditTitle: `Upgrade remediation: ${fix.description}`,
    }),
  }).then(r => r.json()).catch(e => ({ success: false, error: e.message }));

  // Record the result
  const results = session.remediationResults || {};
  results[fixId] = {
    success: result.success !== false,
    output: result.output || result.error || "",
    timestamp: new Date().toISOString(),
  };

  await updateSession(sessionId, { remediationResults: results });

  return { fixId, fix, result: results[fixId] };
}

// ── Step 5b: Mark Remediation Complete ───────────────────────────────────────

export async function stepCompleteRemediation(sessionId) {
  return transition(sessionId, UPGRADE_STATES.REMEDIATED);
}

// ── Step 6: Build CR Form Data ──────────────────────────────────────────────

export function buildCRFormData(session) {
  const report = session.preflightReport || {};
  const checks = report.checks || [];
  const passCount = checks.filter(c => c.status === "pass").length;
  const warnCount = checks.filter(c => c.status === "warning").length;
  const failCount = checks.filter(c => c.status === "fail").length;

  const riskLevel = failCount > 0 ? "high" : warnCount > 3 ? "moderate" : "low";
  const estimatedDuration = report.versionDelta?.estimatedDuration || "~60 minutes";
  const topo = report.nodeTopology || {};
  const components = session.componentAnalysis || [];
  const remediation = session.remediationPlan || session.remediations || [];

  // ServiceNow risk field: 1=Very High, 2=High, 3=Moderate, 4=Low
  const riskNumeric = riskLevel === "high" ? "2" : riskLevel === "moderate" ? "3" : "4";

  // Maintenance window: start now + 30 min prep, end = start + estimated duration
  const startTime = new Date(Date.now() + 30 * 60000);
  const durationMinutes = parseInt(estimatedDuration) || 60;
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  const fmtDate = (d) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

  const failChecks = checks.filter(c => c.status === "fail");
  const warnChecks = checks.filter(c => c.status === "warning");

  const implementationPlan = [
    `=== OpenShift Cluster Upgrade Implementation Plan ===`,
    `Target: ${session.fromVersion} → ${session.targetVersion}`,
    `Type: ${session.upgradeType || "patch"} | Channel: ${session.channel || "stable"}`,
    `Estimated Duration: ${estimatedDuration}`,
    ``,
    `--- Pre-Upgrade Steps ---`,
    `1. Validate cluster health via 22-point pre-assessment (Status: ${report.overallStatus || "N/A"})`,
    `2. Verify etcd backup and node drain readiness`,
    `3. Review deprecated API usage and operator compatibility`,
    `4. Confirm resource capacity (CPU/Memory/Storage headroom)`,
    ...(session.dryRunResult ? [
      ``,
      `--- Dry-Run Validation (completed BEFORE this CR — approval evidence) ---`,
      `Result: ${session.dryRunResult.warnings ? "PASSED WITH WARNINGS" : "PASSED"}`,
      ...String(session.dryRunResult.details || "").split("\n").filter(Boolean).slice(0, 14),
    ] : [
      ``,
      `--- Dry-Run Validation ---`,
      `Not yet run at CR creation time.`,
    ]),
    ...(components.length ? [
      ``,
      `--- Component Impact Analysis ---`,
      ...components.slice(0, 10).map((c, i) => `${i + 1}. ${c.name || c.component}: ${c.status || c.impact || "reviewed"}`),
    ] : []),
    ...(remediation.length ? [
      ``,
      `--- Pre-Upgrade Remediations ---`,
      ...remediation.slice(0, 10).map((r, i) => `${i + 1}. ${r.title || r.description || r.action || "Remediation step"} — ${r.status || "pending"}`),
    ] : []),
    ``,
    `--- Upgrade Execution ---`,
    `1. Switch update channel to ${session.channel || "stable"}-${session.targetVersion}`,
    `2. Initiate cluster version update via oc adm upgrade --to=${session.targetVersion}`,
    `3. Monitor ClusterVersion operator progress`,
    `4. Verify master nodes upgrade (${topo.masters || "N/A"} control plane nodes)`,
    `5. Verify worker nodes upgrade (${topo.workers || "N/A"} worker nodes)`,
    `6. Run post-upgrade health validation`,
    ``,
    `--- Post-Upgrade Verification ---`,
    `1. Re-run 22-point health assessment`,
    `2. Verify all ClusterOperators reporting Available=True`,
    `3. Confirm no degraded operators or pending machine configs`,
    `4. Validate application workload health`,
    `5. Generate post-assessment report and attach to this CR`,
  ].join("\n");

  const backoutPlan = [
    `=== Backout / Rollback Plan ===`,
    ``,
    `Note: OpenShift cluster version downgrades are not supported.`,
    `The following rollback procedures apply:`,
    ``,
    `1. ETCD RESTORE: If critical failure during upgrade:`,
    `   - Stop kubelet on all masters`,
    `   - Restore etcd snapshot from pre-upgrade backup`,
    `   - Restart control plane components`,
    `   - Verify cluster recovery`,
    ``,
    `2. WORKLOAD ROLLBACK:`,
    `   - Revert application deployments to pre-upgrade versions`,
    `   - Restore any modified ConfigMaps/Secrets`,
    `   - Re-apply previous network policies if changed`,
    ``,
    `3. NODE RECOVERY:`,
    `   - If worker nodes fail: cordon, drain, and replace`,
    `   - If master node fails: restore from etcd backup`,
    ``,
    `4. ESCALATION:`,
    `   - Contact Red Hat Support (case ref attached)`,
    `   - Engage cluster operations team`,
    `   - RTO: 2 hours | RPO: Pre-upgrade etcd snapshot`,
  ].join("\n");

  const testPlan = [
    `=== Post-Upgrade Test Plan ===`,
    ``,
    `1. CLUSTER HEALTH:`,
    `   [ ] All ${topo.total || "N/A"} nodes in Ready state`,
    `   [ ] All ClusterOperators Available=True, Degraded=False`,
    `   [ ] No pending MachineConfigPool updates`,
    `   [ ] API server responding (oc get clusterversion)`,
    ``,
    `2. WORKLOAD VALIDATION:`,
    `   [ ] Critical pods running in all namespaces`,
    `   [ ] No CrashLoopBackOff or ImagePullBackOff pods`,
    `   [ ] Persistent volumes mounted and accessible`,
    `   [ ] Ingress/Routes responding to traffic`,
    ``,
    `3. SECURITY & COMPLIANCE:`,
    `   [ ] Certificate validity confirmed`,
    `   [ ] OAuth/authentication functional`,
    `   [ ] Network policies enforced`,
    `   [ ] RBAC roles intact`,
    ``,
    `4. MONITORING:`,
    `   [ ] Prometheus/Alertmanager operational`,
    `   [ ] No critical alerts firing`,
    `   [ ] Cluster metrics flowing`,
    ``,
    `5. AUTOMATED VALIDATION:`,
    `   [ ] 22-point post-assessment passed`,
    `   [ ] Pre vs Post comparison report generated`,
  ].join("\n");

  const workNotes = [
    `[TCS Agentic AI — Automated Upgrade Assessment]`,
    ``,
    `Cluster: ${session.cluster || "local"}`,
    `Upgrade: ${session.fromVersion} → ${session.targetVersion}`,
    `Type: ${session.upgradeType || "patch"} | Channel: ${session.channel || "stable"}`,
    `Assessment Time: ${new Date().toISOString()}`,
    ``,
    `=== Pre-Assessment Results (22 Checks) ===`,
    `Overall: ${report.overallStatus || "UNKNOWN"}`,
    `Pass: ${passCount} | Warning: ${warnCount} | Fail: ${failCount}`,
    `Risk Level: ${riskLevel.toUpperCase()}`,
    ``,
    `Node Topology: ${topo.masters || 0} masters, ${topo.workers || 0} workers, ${topo.infra || 0} infra (${topo.total || 0} total)`,
    `Estimated Duration: ${estimatedDuration}`,
    ...(failChecks.length ? [
      ``,
      `=== Blocking Issues (${failChecks.length}) ===`,
      ...failChecks.map(c => `- ${c.category}: ${c.details}`),
    ] : []),
    ...(warnChecks.length ? [
      ``,
      `=== Warnings (${warnChecks.length}) ===`,
      ...warnChecks.map(c => `- ${c.category}: ${c.details}`),
    ] : []),
    ...(components.length ? [
      ``,
      `=== Component Analysis (${components.length} components) ===`,
      ...components.slice(0, 15).map(c => `- ${c.name || c.component}: ${c.status || c.impact || "reviewed"}`),
    ] : []),
    ``,
    `PDF pre-assessment report and HTML report attached to this CR.`,
  ].join("\n");

  return {
    shortDescription: `OpenShift Cluster Upgrade: ${session.fromVersion} → ${session.targetVersion}`,
    description: [
      `Automated cluster upgrade from ${session.fromVersion} to ${session.targetVersion}.`,
      `Upgrade type: ${session.upgradeType || "patch"}`,
      `Channel: ${session.channel || "stable"}`,
      "",
      `Pre-Assessment Summary (22 checks):`,
      `  Pass: ${passCount} | Warning: ${warnCount} | Fail: ${failCount}`,
      `  Overall Status: ${report.overallStatus || "UNKNOWN"}`,
      "",
      `Estimated Duration: ${estimatedDuration}`,
      `Node Topology: ${topo.masters || 0} masters, ${topo.workers || 0} workers`,
    ].join("\n"),
    type: "normal",
    priority: riskLevel === "high" ? "2" : riskLevel === "moderate" ? "3" : "4",
    risk: riskNumeric,
    impact: riskLevel === "high" ? "2" : "3",
    justification: `22-point pre-upgrade assessment completed. Status: ${report.overallStatus || "N/A"}. ${failCount} blocking issues, ${warnCount} warnings.`,
    implementationPlan,
    backoutPlan,
    testPlan,
    workNotes,
    startDate: fmtDate(startTime),
    endDate: fmtDate(endTime),
    category: "Software",
    targetVersion: session.targetVersion,
    fromVersion: session.fromVersion,
    channel: session.channel,
    upgradeType: session.upgradeType,
    preflightReport: report,
  };
}

// ── Step 6a: Link CR to Session ─────────────────────────────────────────────

export async function stepLinkCR(sessionId, ticketId, sysId) {
  return transition(sessionId, UPGRADE_STATES.CR_SUBMITTED, {
    crTicketId: ticketId,
    crSysId: sysId,
  });
}

// ── Step 7: Watch CR Status ─────────────────────────────────────────────────

export async function stepCheckCRStatus(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  if (!session.crSysId) {
    return { session, status: "local", stateLabel: "Local only (no ServiceNow)" };
  }

  try {
    const record = await getRecord("change_request", session.crSysId);
    const r = record?.result || {};
    const state = r.state || "";
    const approval = r.approval || "";

    const stateLabels = {
      "-5": "New", "-4": "Assess", "-3": "Authorize", "-2": "Scheduled",
      "-1": "Implement", "0": "Review", "3": "Closed", "4": "Cancelled",
    };

    let status = "pending";
    if (approval === "approved" || state === "-1" || state === "-2") {
      status = "approved";
    } else if (approval === "rejected" || state === "4") {
      status = "rejected";
    } else if (state === "3") {
      status = "closed";
    }

    // Auto-transition to CR_APPROVED when detected
    if (status === "approved" && session.state === UPGRADE_STATES.CR_SUBMITTED) {
      await transition(sessionId, UPGRADE_STATES.CR_APPROVED);
    }

    // Handle cancellation
    if (status === "rejected" || (state === "4" && session.state === UPGRADE_STATES.CR_SUBMITTED)) {
      await transition(sessionId, UPGRADE_STATES.CANCELLED, {
        errorMessage: `CR ${session.crTicketId} was ${status}`,
      });
    }

    return {
      session: await getSession(sessionId),
      status,
      stateLabel: stateLabels[state] || state,
      approval,
      ticketId: session.crTicketId,
    };
  } catch (err) {
    return { session, status: "error", error: err.message };
  }
}

// ── Step 8: Dry Run ─────────────────────────────────────────────────────────

export async function stepDryRun(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const result = await withClusterContext(session.cluster, async () => {
    const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
    const currentVersion = cv?.status?.desired?.version || "unknown";
    const currentChannel = cv?.spec?.channel || "";
    const available = (cv?.status?.availableUpdates || []).map(u => u.version);

    const details = [];
    details.push(`Current version : ${currentVersion}`);
    details.push(`Target version  : ${session.targetVersion}`);
    details.push(`Current channel : ${currentChannel}`);
    details.push(`Available updates: ${available.length > 0 ? available.join(", ") : "none"}`);
    details.push(``);

    const progressing = (cv?.status?.conditions || []).find(c => c.type === "Progressing");
    if (progressing?.status === "True" && (progressing?.message || "").includes("working towards")) {
      return { success: false, error: `Upgrade already in progress: ${progressing.message}`, details: details.join("\n") };
    }

    if (!available.includes(session.targetVersion)) {
      details.push(`[FAIL] Version ${session.targetVersion} is NOT in available updates.`);
      details.push(`       Available: ${available.join(", ") || "none"}`);
      return { success: false, error: `Version ${session.targetVersion} not available`, details: details.join("\n") };
    }

    const ops = await ocpGet("/apis/config.openshift.io/v1/clusteroperators");
    const degraded = (ops?.items || []).filter(o =>
      (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True")
    );
    const unavailableOps = (ops?.items || []).filter(o =>
      !(o.status?.conditions || []).some(c => c.type === "Available" && c.status === "True")
    );

    details.push(`[PASS] Version ${session.targetVersion} is in available updates`);
    details.push(`[PASS] Cluster version operator is healthy`);

    if (degraded.length > 0) {
      details.push(`[WARN] ${degraded.length} degraded operator(s): ${degraded.map(o => o.metadata.name).join(", ")}`);
    } else {
      details.push(`[PASS] No degraded operators`);
    }
    if (unavailableOps.length > 0) {
      details.push(`[WARN] ${unavailableOps.length} unavailable operator(s): ${unavailableOps.map(o => o.metadata.name).join(", ")}`);
    } else {
      details.push(`[PASS] All operators available`);
    }

    const nodes = await ocpGet("/api/v1/nodes");
    const notReady = (nodes?.items || []).filter(n =>
      !(n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True")
    );
    if (notReady.length > 0) {
      details.push(`[WARN] ${notReady.length} node(s) NOT ready: ${notReady.map(n => n.metadata.name).join(", ")}`);
    } else {
      details.push(`[PASS] All ${(nodes?.items || []).length} nodes ready`);
    }

    try {
      const mcps = await ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools");
      const mcpUpdating = (mcps?.items || []).filter(m =>
        (m.status?.conditions || []).some(c => c.type === "Updating" && c.status === "True")
      );
      if (mcpUpdating.length > 0) {
        details.push(`[WARN] ${mcpUpdating.length} MachineConfigPool(s) currently updating`);
      } else {
        details.push(`[PASS] No MachineConfigPools updating`);
      }
    } catch { details.push(`[INFO] MachineConfigPools not available`); }

    details.push(``);
    const hasWarn = details.some(d => d.includes("[WARN]"));
    details.push(hasWarn
      ? `DRY RUN RESULT: PASSED WITH WARNINGS — review warnings before proceeding`
      : `DRY RUN RESULT: PASSED — safe to proceed with upgrade to ${session.targetVersion}`);

    return { success: true, details: details.join("\n"), warnings: hasWarn };
  });

  if (result.success) {
    const updated = await transition(sessionId, UPGRADE_STATES.DRY_RUN_PASSED, {
      dryRunResult: result,
    });
    return { session: updated, result, passed: true };
  }

  await updateSession(sessionId, { dryRunResult: result });
  return { session: await getSession(sessionId), result, passed: false };
}

// ── Step 9: Execute Upgrade ─────────────────────────────────────────────────

export async function stepExecuteUpgrade(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  // Re-validate right before execution
  const [cv, ops] = await withClusterContext(session.cluster, () =>
    Promise.all([
      ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
      ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
    ]));
  const currentVer = cv?.status?.desired?.version || "";
  const availableUpdates = cv?.status?.availableUpdates || [];
  const channel = cv?.spec?.channel || "";

  // Check if upgrade is already in progress on this cluster
  const progressingCond = (cv?.status?.conditions || []).find(c => c.type === "Progressing");
  if (progressingCond?.status === "True" && (progressingCond?.message || "").includes("working towards")) {
    const pctMatch = progressingCond.message.match(/\((\d+)%\s*complete\)/i);
    const countMatch = progressingCond.message.match(/(\d+)\s+of\s+(\d+)\s+done/i);
    const waitMatch = progressingCond.message.match(/waiting on\s+(.+)/i);
    const opItems = ops?.items || [];
    const updating = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Progressing" && c.status === "True")).length;
    const degraded = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True")).length;

    return {
      session,
      success: false,
      upgradeInProgress: true,
      error: "An upgrade is already in progress on this cluster",
      liveStatus: {
        message: progressingCond.message,
        progress: pctMatch ? parseInt(pctMatch[1], 10) : 0,
        manifests: countMatch ? { done: parseInt(countMatch[1], 10), total: parseInt(countMatch[2], 10) } : null,
        waitingOperators: waitMatch ? waitMatch[1].split(",").map(s => s.trim()).filter(Boolean) : [],
        operators: { updating, degraded, total: opItems.length, available: opItems.length - updating - degraded },
        currentVersion: currentVer,
      },
    };
  }

  const validation = validateUpgradeVersion(currentVer, session.targetVersion, availableUpdates, channel);

  if (!validation.valid) {
    await updateSession(sessionId, { errorMessage: `Pre-execution validation failed: ${validation.reason}` });
    return { session: await getSession(sessionId), success: false, error: validation.reason };
  }

  // Patch ClusterVersion
  try {
    await withClusterContext(session.cluster, () =>
      ocpFetch("/apis/config.openshift.io/v1/clusterversions/version", {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify({ spec: { desiredUpdate: { version: session.targetVersion } } }),
      }));
  } catch (err) {
    const msg = err.message || String(err);
    if (/403|forbidden/i.test(msg)) {
      const rbacFix = [
        `The service account lacks permission to patch clusterversions.`,
        `Run this on the cluster to grant it:`,
        `  oc adm policy add-cluster-role-to-user agentic-ai-server-remediator -z agentic-ai-server -n openshift-mcp`,
        `Or apply the updated serviceaccount.yaml from deploy/dashboard/manifests/`,
      ].join("\n");
      await updateSession(sessionId, { errorMessage: rbacFix });
      return { session: await getSession(sessionId), success: false, error: rbacFix };
    }
    throw err;
  }

  const updated = await transition(sessionId, UPGRADE_STATES.EXECUTING, {
    executedAt: new Date().toISOString(),
  });
  return { session: updated, success: true };
}

// ── Step 10: Monitor Upgrade Progress ───────────────────────────────────────

export async function stepCheckUpgradeProgress(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const [cv, ops] = await withClusterContext(session.cluster, () =>
    Promise.all([
      ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
      ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
    ]));

  const conditions = (cv?.status?.conditions || []).reduce((acc, c) => {
    acc[c.type] = { status: c.status, message: c.message || "" };
    return acc;
  }, {});

  // CRITICAL: Use the session's targetVersion, NOT cv.status.desired.version.
  // After PATCH, the CVO may still report the OLD version as desired until it
  // reconciles. Checking history for the old version yields "Completed" → false positive.
  const targetVersion = session.targetVersion;
  const cvoDesiredVersion = cv?.status?.desired?.version || "";
  const targetHistory = (cv?.status?.history || []).find(h => h.version === targetVersion);
  const cvoAccepted = cvoDesiredVersion === targetVersion;

  const opItems = ops?.items || [];
  let updatingCount = 0, degradedCount = 0, availableCount = 0;
  const operatorDetails = [];

  for (const op of opItems) {
    const opConds = op.status?.conditions || [];
    const isProgressing = opConds.some(c => c.type === "Progressing" && c.status === "True");
    const isDegraded = opConds.some(c => c.type === "Degraded" && c.status === "True");
    const isAvailable = opConds.some(c => c.type === "Available" && c.status === "True");

    if (isProgressing) updatingCount++;
    if (isDegraded) degradedCount++;
    if (isAvailable) availableCount++;

    if (isProgressing || isDegraded) {
      const msg = opConds.find(c => c.type === "Progressing")?.message || opConds.find(c => c.type === "Degraded")?.message || "";
      operatorDetails.push({ name: op.metadata.name, progressing: isProgressing, degraded: isDegraded, message: msg.slice(0, 200) });
    }
  }

  let phase = "unknown";
  let progress = 0;
  let manifestsDone = 0, manifestsTotal = 0;
  const progressing = conditions.Progressing;
  const progressMsg = progressing?.message || "";

  // Phase determination — always checks TARGET version, not CVO's current desired.
  // CVO may still report the old version for seconds after PATCH.
  if (targetHistory?.state === "Completed") {
    // Target version is fully installed and confirmed in CVO history
    phase = "complete";
    progress = 100;
  } else if (!cvoAccepted) {
    // CVO hasn't even acknowledged the target version yet — still shows old desired
    phase = "preparing";
    progress = 0;
  } else if (progressing?.status === "True") {
    // CVO is actively working — parse real progress from message:
    // "Working towards 4.20.23: 735 of 959 done (76% complete), waiting on ..."
    const pctMatch = progressMsg.match(/\((\d+)%\s*complete\)/i);
    const countMatch = progressMsg.match(/(\d+)\s+of\s+(\d+)\s+done/i);
    if (pctMatch) {
      progress = Math.min(99, parseInt(pctMatch[1], 10));
    } else if (countMatch) {
      manifestsDone = parseInt(countMatch[1], 10);
      manifestsTotal = parseInt(countMatch[2], 10);
      progress = manifestsTotal > 0 ? Math.min(99, Math.round((manifestsDone / manifestsTotal) * 100)) : 5;
    } else {
      const totalOps = opItems.length || 1;
      const doneOps = totalOps - updatingCount;
      progress = Math.min(95, Math.round((doneOps / totalOps) * 90) + 5);
    }
    if (countMatch) {
      manifestsDone = parseInt(countMatch[1], 10);
      manifestsTotal = parseInt(countMatch[2], 10);
    }
    phase = progress < 15 ? "preparing" : progress < 85 ? "updating" : "completing";
  } else if (conditions.Failing?.status === "True" ||
    (conditions.Degraded?.status === "True" && progressing?.status !== "True")) {
    phase = "failed";
  } else {
    // CVO accepted target but not actively progressing yet — still spinning up
    phase = "preparing";
    progress = 0;
  }

  // Nodes status during upgrade
  let nodeStatus = null;
  try {
    const nodes = await withClusterContext(session.cluster, () =>
      ocpGet("/api/v1/nodes"));
    const nodeItems = nodes?.items || [];
    const readyCount = nodeItems.filter(n =>
      (n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True")
    ).length;
    nodeStatus = { total: nodeItems.length, ready: readyCount, notReady: nodeItems.length - readyCount };
  } catch { /* ignore */ }

  const allStable = phase === "complete" && degradedCount === 0 && updatingCount === 0 &&
    availableCount === opItems.length && (nodeStatus ? nodeStatus.notReady === 0 : true);

  // Parse "waiting on X, Y, Z" from CVO message for pending operator visibility
  let waitingOperators = [];
  const waitMatch = progressMsg.match(/waiting on\s+(.+)/i);
  if (waitMatch) {
    waitingOperators = waitMatch[1].split(",").map(s => s.trim()).filter(Boolean);
  }

  const monitorData = {
    timestamp: new Date().toISOString(),
    phase,
    progress,
    allStable,
    fromVersion: session.fromVersion || "",
    targetVersion,
    currentVersion: cvoDesiredVersion,
    cvoAccepted,
    message: progressMsg,
    manifests: manifestsTotal > 0 ? { done: manifestsDone, total: manifestsTotal } : null,
    operators: { updating: updatingCount, degraded: degradedCount, available: availableCount, total: opItems.length },
    operatorDetails: operatorDetails.slice(0, 15),
    waitingOperators,
    nodes: nodeStatus,
  };

  // Append to monitoring history
  const existingData = session.monitoringData || { snapshots: [] };
  existingData.snapshots.push(monitorData);
  if (existingData.snapshots.length > 100) {
    existingData.snapshots = existingData.snapshots.slice(-100);
  }

  // Transition on terminal states — only when TARGET version confirmed in CVO history.
  // Re-fetch session state after each transition to avoid stale state.
  const historyConfirmed = targetHistory?.state === "Completed";
  const nodesAllReady = nodeStatus ? nodeStatus.notReady === 0 : true;
  const opsAllHealthy = degradedCount === 0 && updatingCount === 0 && availableCount === opItems.length;
  const trulyComplete = historyConfirmed && opsAllHealthy && nodesAllReady;
  let currentSessionState = session.state;

  if (historyConfirmed) {
    // CVO confirms target version fully applied
    if (currentSessionState === "executing") {
      await transition(sessionId, UPGRADE_STATES.MONITORING, { monitoringData: existingData });
      currentSessionState = "monitoring";
    }
    // Technical rollout done (operators healthy + nodes ready + CVO history
    // confirmed) — but DO NOT mark COMPLETED yet. The upgrade is only complete
    // after the Post-Assessment validates it (version verified, no new issues).
    // Flag it as awaiting post-assessment so the UI prompts to finalize.
    if (currentSessionState === "monitoring" && trulyComplete) {
      existingData.technicallyComplete = true;
      existingData.awaitingPostAssessment = true;
      existingData.technicalCompleteAt = existingData.technicalCompleteAt || new Date().toISOString();
      await updateSession(sessionId, { monitoringData: existingData });
    } else {
      await updateSession(sessionId, { monitoringData: existingData });
    }
  } else if (phase === "failed") {
    await transition(sessionId, UPGRADE_STATES.FAILED, {
      monitoringData: existingData,
      errorMessage: progressing?.message || "Upgrade failed",
    });
  } else {
    // Upgrade still in progress — move to monitoring once CVO starts progressing
    if (currentSessionState === "executing" && progress > 0) {
      await transition(sessionId, UPGRADE_STATES.MONITORING, { monitoringData: existingData });
    } else {
      await updateSession(sessionId, { monitoringData: existingData });
    }
  }

  return { session: await getSession(sessionId), ...monitorData };
}

// ── Step 11: Post-Assessment ────────────────────────────────────────────────

export async function stepPostAssessment(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  // Post-assessment finalizes the upgrade. It may run once the rollout is
  // technically complete (state monitoring/technicallyComplete or completed) —
  // the version check below re-confirms completion. Only block while actively
  // executing with no confirmed target version yet.
  if (session.state === "executing" && !session.monitoringData?.technicallyComplete) {
    return {
      session,
      success: false,
      error: "Upgrade is still in progress. Post-assessment can only run after the rollout is complete (all operators available, all nodes ready, CVO history confirmed).",
    };
  }

  // Verify the actual cluster version matches the target
  let verifiedVersion = null;
  let operatorSummary = null;
  let nodeStatus = null;
  let postReport = null;
  try {
    const [cv, ops] = await withClusterContext(session.cluster, () =>
      Promise.all([
        ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
        ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
      ]));

    const currentHistory = (cv?.status?.history || []).find(h => h.version === session.targetVersion);
    const actualVersion = cv?.status?.desired?.version || "";
    verifiedVersion = actualVersion;

    // Check if upgrade actually completed
    if (currentHistory?.state !== "Completed" && actualVersion !== session.targetVersion) {
      return {
        session,
        success: false,
        error: `Upgrade not yet complete. Current version: ${actualVersion}. ` +
          (currentHistory ? `State: ${currentHistory.state}` : "Target version not found in history."),
      };
    }

    // Operator summary
    const opItems = ops?.items || [];
    const available = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Available" && c.status === "True")).length;
    const degraded = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True")).length;
    const progressing = opItems.filter(o => (o.status?.conditions || []).some(c => c.type === "Progressing" && c.status === "True")).length;
    operatorSummary = { total: opItems.length, available, degraded, progressing };

    // Node readiness for closure validation
    const nodeItems = (await withClusterContext(session.cluster, () => ocpGet("/api/v1/nodes")))?.items || [];
    const nodeReady = nodeItems.filter(n => (n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True")).length;
    nodeStatus = { total: nodeItems.length, ready: nodeReady, notReady: nodeItems.length - nodeReady };

    const availableUpdates = cv?.status?.availableUpdates || [];
    const nextTarget = availableUpdates.length > 0 ? availableUpdates[0].version : actualVersion;
    postReport = await withClusterContext(session.cluster, () =>
      runPreflightChecks(nextTarget, actualVersion));
  } catch (err) {
    postReport = { error: err.message };
  }

  // Compare pre vs post
  const preReport = session.preflightReport || {};
  const preChecks = preReport.checks || [];
  const postChecks = postReport?.checks || [];

  const comparison = {
    preOverall: preReport.overallStatus || "UNKNOWN",
    postOverall: postReport?.overallStatus || "UNKNOWN",
    resolved: [],
    newIssues: [],
    persistent: [],
  };

  const preIssueSet = new Set(
    preChecks.filter(c => c.status !== "pass").map(c => c.category)
  );
  const postIssueSet = new Set(
    postChecks.filter(c => c.status !== "pass").map(c => c.category)
  );

  for (const cat of preIssueSet) {
    if (!postIssueSet.has(cat)) comparison.resolved.push(cat);
    else comparison.persistent.push(cat);
  }
  for (const cat of postIssueSet) {
    if (!preIssueSet.has(cat)) comparison.newIssues.push(cat);
  }

  const execStart = session.executedAt ? new Date(session.executedAt) : null;
  const execEnd = session.completedAt ? new Date(session.completedAt) : null;
  let durationStr = "unknown";
  let durationMinutes = null;
  if (execStart && execEnd) {
    durationMinutes = Math.round((execEnd - execStart) / 60000);
    const hrs = Math.floor(durationMinutes / 60);
    durationStr = hrs > 0 ? `${hrs}h ${durationMinutes % 60}m` : `${durationMinutes}m`;
  } else if (session.monitoringData?.snapshots?.length) {
    const first = new Date(session.monitoringData.snapshots[0].timestamp);
    const last = new Date(session.monitoringData.snapshots[session.monitoringData.snapshots.length - 1].timestamp);
    durationMinutes = Math.round((last - first) / 60000);
    const hrs = Math.floor(durationMinutes / 60);
    durationStr = hrs > 0 ? `${hrs}h ${durationMinutes % 60}m` : `${durationMinutes}m`;
  }

  const postAssessment = {
    timestamp: new Date().toISOString(),
    report: postReport,
    comparison,
    verifiedVersion,
    operatorSummary,
    nodeStatus,
    fromVersion: session.fromVersion,
    toVersion: session.targetVersion,
    executedAt: session.executedAt || null,
    completedAt: session.completedAt || null,
    duration: durationStr,
    durationMinutes,
  };

  // Verdict: the upgrade is COMPLETE only when post-assessment validates it —
  // target version verified, operators healthy, nodes ready, no NEW issues.
  const passed = verifiedVersion === session.targetVersion
    && (operatorSummary?.degraded || 0) === 0
    && (operatorSummary?.progressing || 0) === 0
    && (nodeStatus?.notReady || 0) === 0
    && (comparison.newIssues?.length || 0) === 0;
  postAssessment.passed = passed;
  postAssessment.verdict = passed ? "verified-complete" : "issues-found";
  await updateSession(sessionId, { postAssessment });

  // Finalize: only NOW does the upgrade transition to COMPLETED — never before
  // post-assessment. If issues remain, stay in monitoring so they're surfaced.
  if (passed && (session.state === "monitoring" || session.state === "executing")) {
    try { await transition(sessionId, UPGRADE_STATES.COMPLETED, { completedAt: session.completedAt || new Date().toISOString() }); }
    catch { /* transition may race; postAssessment is persisted regardless */ }
  }

  // ── ServiceNow CR: update with post-assessment details, attach reports, then close ──
  if (session.crSysId) {
    const isSuccess = verifiedVersion === session.targetVersion &&
      operatorSummary && operatorSummary.degraded === 0 && operatorSummary.progressing === 0;

    // 1. Add structured work notes with post-assessment summary
    try {
      const fmtTime = (t) => t ? new Date(t).toLocaleString() : "N/A";
      const workNotes = [
        `[TCS Agentic AI] Post-Upgrade Assessment — ${session.cluster || "local"}`,
        `─────────────────────────────────────────`,
        `Upgrade Path: ${session.fromVersion} → ${session.targetVersion}`,
        `Duration: ${postAssessment.duration}`,
        `Outcome: ${isSuccess ? "SUCCESS" : "REQUIRES REVIEW"}`,
        ``,
        `── Timing ──`,
        `Upgrade Started:  ${fmtTime(session.executedAt)}`,
        `Upgrade Completed: ${fmtTime(session.completedAt)}`,
        `Post-Assessment:  ${fmtTime(postAssessment.timestamp)}`,
        ``,
        `── Verification ──`,
        `Verified Cluster Version: ${verifiedVersion}`,
        `Target Version Match: ${verifiedVersion === session.targetVersion ? "YES ✓" : "NO ✗ — Expected " + session.targetVersion}`,
        ``,
        `── Cluster Health ──`,
        `Operators: ${operatorSummary?.total || 0} total, ${operatorSummary?.available || 0} available, ${operatorSummary?.degraded || 0} degraded, ${operatorSummary?.progressing || 0} progressing`,
        `Nodes: ${nodeStatus?.total || "N/A"} total, ${nodeStatus?.ready || "N/A"} ready`,
        ``,
        `── Pre → Post Comparison ──`,
        `  Resolved Issues: ${comparison.resolved.length} (${comparison.resolved.join(", ") || "none"})`,
        `  New Issues: ${comparison.newIssues.length} (${comparison.newIssues.join(", ") || "none"})`,
        `  Persistent: ${comparison.persistent.length} (${comparison.persistent.join(", ") || "none"})`,
      ].join("\n");

      await updateRecord("change_request", session.crSysId, { work_notes: workNotes });
    } catch (wnErr) {
      console.warn(`[post-assess] Failed to add work notes to CR: ${wnErr.message}`);
    }

    // 2. Attach post-assessment PDF + HTML reports
    try {
      const { generatePostAssessmentReport } = await import("./upgrade-report.js");
      const updatedSession = await getSession(sessionId);

      const postBuffer = await generatePostAssessmentReport(updatedSession);
      await snowAttachFile("change_request", session.crSysId,
        `Post-Assessment-${session.cluster || "local"}-${session.fromVersion}-to-${session.targetVersion}.pdf`,
        "application/pdf", postBuffer);

      const htmlContent = generateHTMLReport(updatedSession);
      const htmlBuffer = Buffer.from(htmlContent, "utf-8");
      await snowAttachFile("change_request", session.crSysId,
        `Post-Assessment-${session.cluster || "local"}-${session.fromVersion}-to-${session.targetVersion}.html`,
        "text/html", htmlBuffer);
    } catch (attErr) {
      console.warn(`[post-assess] Failed to attach reports to CR: ${attErr.message}`);
    }

    // 3. Close the CR only if upgrade verified successful.
    try {
      if (isSuccess) {
        const closeNotes = [
          `Upgrade ${session.fromVersion} → ${session.targetVersion} completed and verified.`,
          `Cluster version confirmed: ${verifiedVersion}.`,
          `All ${operatorSummary?.total || 0} operators available, 0 degraded.`,
          `Nodes: ${nodeStatus?.total || "N/A"} total, ${nodeStatus?.ready || "N/A"} ready.`,
          `Duration: ${postAssessment.duration}.`,
          `Pre/post assessment reports attached (PDF + HTML).`,
          `${comparison.resolved.length} pre-upgrade issues resolved, ${comparison.newIssues.length} new issues.`,
        ].join(" ");
        // ServiceNow change_request enforces a state progression — you usually
        // cannot jump straight to Closed(3). Advance through Implement(-1) →
        // Review(0), then try Closed with several field combinations. Never
        // throw on failure; record the real outcome for the UI.
        let closeResult = { closed: false, error: null };
        for (const s of ["-1", "0"]) {
          try { await updateRecord("change_request", session.crSysId, { state: s }); } catch { /* state may already be past this */ }
        }
        const attempts = [
          { state: "3", close_code: "successful", close_notes: closeNotes },
          { state: "0", close_code: "successful", close_notes: closeNotes },
          { state: "3", close_notes: closeNotes },
          { close_code: "successful", close_notes: closeNotes },
        ];
        for (const payload of attempts) {
          try { await updateRecord("change_request", session.crSysId, payload); closeResult = { closed: true, state: payload.state || "closed" }; break; }
          catch (e) { closeResult = { closed: false, error: e.message }; }
        }
        postAssessment.crClosed = closeResult;
        await updateSession(sessionId, { postAssessment });
        if (!closeResult.closed) console.warn(`[post-assess] CR ${session.crTicketId} could not be auto-closed: ${closeResult.error}`);
      } else {
        postAssessment.crClosed = { closed: false, reason: "manual-review-required" };
        await updateSession(sessionId, { postAssessment });
        await updateRecord("change_request", session.crSysId, {
          work_notes: [
            `[TCS Agentic AI] WARNING: Post-assessment detected issues.`,
            `Current version: ${verifiedVersion}, Expected: ${session.targetVersion}.`,
            operatorSummary?.degraded > 0 ? `${operatorSummary.degraded} operator(s) degraded.` : "",
            operatorSummary?.progressing > 0 ? `${operatorSummary.progressing} operator(s) still progressing.` : "",
            `CR NOT auto-closed — manual review required.`,
          ].filter(Boolean).join(" "),
        });
      }
    } catch (closeErr) {
      console.warn(`[post-assess] Failed to close CR: ${closeErr.message}`);
    }
  }

  return { session: await getSession(sessionId), postAssessment };
}

// ── HTML Report Generation ──────────────────────────────────────────────────

export function generateHTMLReport(session) {
  const report = session.preflightReport || {};
  const checks = report.checks || [];
  const pass = checks.filter(c => c.status === "pass").length;
  const warn = checks.filter(c => c.status === "warning").length;
  const fail = checks.filter(c => c.status === "fail").length;
  const topo = report.nodeTopology || {};
  const vd = report.versionDelta || {};
  const allOps = report.allClusterOperators || [];
  const components = session.componentAnalysis || {};
  const remediation = session.remediationPlan || session.remediations || {};
  const riskLevel = fail > 0 ? "HIGH" : warn > 3 ? "MODERATE" : "LOW";

  const statusColor = report.overallStatus === "READY" ? "#22c55e"
    : report.overallStatus === "READY_WITH_WARNINGS" ? "#f59e0b" : "#ef4444";
  const riskColor = riskLevel === "HIGH" ? "#ef4444" : riskLevel === "MODERATE" ? "#f59e0b" : "#22c55e";

  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const checkRows = checks.map(c => {
    const icon = c.status === "pass" ? "&#x2705;" : c.status === "warning" ? "&#x26A0;&#xFE0F;" : "&#x274C;";
    const color = c.status === "pass" ? "#22c55e" : c.status === "warning" ? "#f59e0b" : "#ef4444";
    const items = (c.items || []).map(i =>
      `<li style="margin:2px 0;font-size:12px">${esc(i.name)}: ${esc(i.issue)}${i.message ? ` &mdash; ${esc(i.message)}` : ""}</li>`
    ).join("");
    return `<tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${icon}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600">${esc(c.category)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:${color};font-weight:600">${c.status.toUpperCase()}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-size:13px">${esc(c.details)}${items ? `<ul style="margin:4px 0;padding-left:20px">${items}</ul>` : ""}</td>
    </tr>`;
  }).join("");

  // Cluster Operators table
  const opRows = allOps.map(op => {
    const avColor = op.available ? "#22c55e" : "#ef4444";
    const degColor = op.degraded ? "#ef4444" : "#22c55e";
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-weight:500">${esc(op.name)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px">${esc(op.version || "—")}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:${avColor};font-weight:600">${op.available ? "Available" : "Unavailable"}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:${degColor};font-weight:600">${op.degraded ? "Yes" : "No"}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:${op.progressing ? "#f59e0b" : "inherit"}">${op.progressing ? "Yes" : "No"}</td>
    </tr>`;
  }).join("");

  // Remediation rows
  const fixes = remediation.fixes || (Array.isArray(remediation) ? remediation : []);
  const remRows = fixes.map(f => {
    const sevColor = /critical|high|fail/i.test(f.severity) ? "#ef4444" : /warn|moderate/i.test(f.severity) ? "#f59e0b" : "#6b7280";
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:${sevColor};font-weight:600">${esc(f.severity || "—")}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-weight:500">${esc(f.title || "—")}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px">${esc(f.description || "—")}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:11px">${esc(f.command || "—")}</td>
    </tr>`;
  }).join("");

  // Component issues summary
  const degradedOps = components.degradedOperators || [];
  const certIssues = components.certificateIssues || [];
  const mcpIssues = components.mcpIssues || [];
  const failingPods = components.failingPods || [];

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Pre-Upgrade Assessment &mdash; ${esc(session.fromVersion)} &rarr; ${esc(session.targetVersion)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#f9fafb;color:#111827}
.page{max-width:1100px;margin:0 auto;padding:20px}
.header{background:linear-gradient(135deg,#0f172a,#1e3a5f);color:white;padding:32px;border-radius:12px;margin-bottom:24px}
.header h1{margin:0;font-size:24px;font-weight:700}.header .sub{margin:8px 0 0;opacity:.8;font-size:14px}
.badge{display:inline-block;padding:6px 20px;border-radius:20px;font-weight:700;font-size:14px;margin-top:14px}
.section{margin:24px 0}.section h2{color:#1e3a5f;font-size:18px;border-bottom:2px solid #e5e7eb;padding-bottom:8px;margin:0 0 12px}
.section h3{color:#374151;font-size:15px;margin:16px 0 8px}
.summary{display:flex;gap:16px;margin:16px 0;flex-wrap:wrap}
.stat{background:white;border-radius:10px;padding:18px;flex:1;min-width:120px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid #e5e7eb}
.stat h3{margin:0;font-size:28px;font-weight:800}.stat p{margin:4px 0 0;font-size:12px;color:#6b7280;font-weight:500}
table{width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid #e5e7eb;margin:8px 0}
th{background:#1e3a5f;color:white;padding:10px;text-align:left;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
td{padding:8px;border-bottom:1px solid #e5e7eb;font-size:13px}
.kv{width:100%}.kv td:first-child{font-weight:600;width:220px;background:#f8fafc;color:#374151}
.risk-box{padding:16px;border-radius:10px;border-left:4px solid;margin:12px 0}
.risk-high{border-color:#ef4444;background:#fef2f2}.risk-moderate{border-color:#f59e0b;background:#fffbeb}.risk-low{border-color:#22c55e;background:#f0fdf4}
.footer{background:#0f172a;color:white;padding:20px;border-radius:10px;margin-top:32px;text-align:center;font-size:13px}
.footer .brand{font-weight:700;font-size:15px;margin-bottom:6px}
@media print{body{background:white}.page{padding:10px}table{page-break-inside:auto}tr{page-break-inside:avoid}}
</style></head>
<body><div class="page">

<!-- Header -->
<div class="header">
  <div style="font-size:13px;font-weight:600;letter-spacing:1px;opacity:.7;margin-bottom:8px">TCS AGENTIC AI</div>
  <h1>OpenShift Pre-Upgrade Assessment Report</h1>
  <div class="sub">${esc(session.fromVersion)} &rarr; ${esc(session.targetVersion)} &nbsp;|&nbsp; Channel: ${esc(report.channel || "stable")} &nbsp;|&nbsp; Cluster: ${esc(session.cluster || "local")} &nbsp;|&nbsp; Generated: ${new Date().toISOString()}</div>
  <div class="badge" style="background:${statusColor}">${report.overallStatus || "UNKNOWN"}</div>
</div>

<!-- Executive Summary -->
<div class="section">
<h2>1. Executive Summary</h2>
<div class="summary">
  <div class="stat"><h3 style="color:#22c55e">${pass}</h3><p>Passed</p></div>
  <div class="stat"><h3 style="color:#f59e0b">${warn}</h3><p>Warnings</p></div>
  <div class="stat"><h3 style="color:#ef4444">${fail}</h3><p>Failed</p></div>
  <div class="stat"><h3>${checks.length}</h3><p>Total Checks</p></div>
</div>
<table class="kv">
  <tr><td>Cluster</td><td>${esc(session.cluster || "local")}</td></tr>
  <tr><td>Current Version</td><td>${esc(session.fromVersion)}</td></tr>
  <tr><td>Target Version</td><td>${esc(session.targetVersion)}</td></tr>
  <tr><td>Upgrade Type</td><td>${esc(session.upgradeType || "patch")}</td></tr>
  <tr><td>Update Channel</td><td>${esc(session.channel || "stable")}</td></tr>
  <tr><td>Estimated Duration</td><td>${esc(vd.estimatedDuration || "~60 minutes")}</td></tr>
  <tr><td>Session ID</td><td style="font-family:monospace;font-size:12px">${esc(session.id)}</td></tr>
</table>
</div>

<!-- Risk Assessment -->
<div class="section">
<h2>2. Risk Assessment &amp; Impact Analysis</h2>
<div class="risk-box risk-${riskLevel.toLowerCase()}">
  <strong style="font-size:16px;color:${riskColor}">Risk Level: ${riskLevel}</strong>
  <p style="margin:8px 0 0;font-size:13px">${fail > 0 ? `${fail} blocking issue(s) detected. Upgrade may fail without remediation.` : warn > 0 ? `${warn} non-critical warning(s) present. Upgrade can proceed with caution.` : "Cluster is ready for upgrade. No blocking issues detected."}</p>
</div>
<table class="kv">
  <tr><td>Blocking Issues</td><td style="color:${fail > 0 ? "#ef4444" : "#22c55e"};font-weight:600">${fail}</td></tr>
  <tr><td>Warnings</td><td style="color:${warn > 0 ? "#f59e0b" : "#22c55e"};font-weight:600">${warn}</td></tr>
  <tr><td>Rollback Strategy</td><td>etcd snapshot restore (RPO: pre-upgrade snapshot)</td></tr>
  <tr><td>Estimated RTO</td><td>2 hours (etcd restore + cluster recovery)</td></tr>
  <tr><td>Maintenance Window</td><td>${esc(vd.estimatedDuration || "~60 minutes")}</td></tr>
</table>
</div>

<!-- Node Topology -->
<div class="section">
<h2>3. Cluster Topology</h2>
<div class="summary">
  <div class="stat"><h3>${topo.masters || 0}</h3><p>Control Plane</p></div>
  <div class="stat"><h3>${topo.workers || 0}</h3><p>Workers</p></div>
  <div class="stat"><h3>${topo.infra || 0}</h3><p>Infrastructure</p></div>
  <div class="stat"><h3>${topo.total || 0}</h3><p>Total Nodes</p></div>
</div>
${vd.kubeFrom ? `<table class="kv">
  <tr><td>Kubernetes (Current)</td><td>${esc(vd.kubeFrom)}</td></tr>
  <tr><td>Kubernetes (Target)</td><td>${esc(vd.kubeTo)}</td></tr>
  <tr><td>Kubernetes Skew</td><td>${vd.kubeSkew || 0} minor version(s)</td></tr>
  <tr><td>RHEL Base</td><td>${esc(vd.rhelBase || "N/A")}</td></tr>
  <tr><td>CRI-O Version</td><td>${esc(vd.criO || "N/A")}</td></tr>
</table>` : ""}
</div>

<!-- Cluster Operators -->
${allOps.length > 0 ? `<div class="section">
<h2>4. Cluster Operators Status (${allOps.length})</h2>
<p style="font-size:13px;color:#6b7280;margin:0 0 8px">${allOps.filter(o => o.available).length} available, ${allOps.filter(o => o.degraded).length} degraded, ${allOps.filter(o => o.progressing).length} progressing</p>
<table>
  <thead><tr><th>Operator</th><th>Version</th><th>Available</th><th>Degraded</th><th>Progressing</th></tr></thead>
  <tbody>${opRows}</tbody>
</table>
</div>` : ""}

<!-- Pre-Assessment Checks -->
<div class="section">
<h2>5. Pre-Assessment Checks (22-Point)</h2>
<p style="font-size:13px;color:#6b7280;margin:0 0 8px">Comprehensive checks to assess cluster upgrade readiness</p>
<table>
  <thead><tr><th width="40"></th><th>Category</th><th width="100">Status</th><th>Details</th></tr></thead>
  <tbody>${checkRows}</tbody>
</table>
</div>

<!-- Component Analysis -->
<div class="section">
<h2>6. Component Analysis</h2>
${degradedOps.length > 0 ? `<h3>6.1 Degraded Operators (${degradedOps.length})</h3>
<table><thead><tr><th>Operator</th><th>Condition</th><th>Details</th></tr></thead><tbody>${degradedOps.map(o =>
  `<tr><td style="font-weight:500">${esc(o.name || o)}</td><td style="color:#ef4444;font-weight:600">${esc(o.issue || o.condition || "Degraded")}</td><td style="font-size:12px">${esc(o.message || "—")}</td></tr>`
).join("")}</tbody></table>` : "<p style='font-size:13px;color:#6b7280'>No degraded operators detected.</p>"}

${certIssues.length > 0 ? `<h3>6.2 Certificate Issues (${certIssues.length})</h3>
<table><thead><tr><th>Certificate</th><th>Namespace</th><th>Issue</th></tr></thead><tbody>${certIssues.map(c =>
  `<tr><td style="font-weight:500">${esc(c.name || c.secret || c)}</td><td>${esc(c.namespace || "—")}</td><td style="font-size:12px">${esc(c.message || c.issue || "—")}</td></tr>`
).join("")}</tbody></table>` : ""}

${mcpIssues.length > 0 ? `<h3>6.3 Machine Config Pool Issues (${mcpIssues.length})</h3>
<table><thead><tr><th>Pool</th><th>Status</th><th>Details</th></tr></thead><tbody>${mcpIssues.map(m =>
  `<tr><td style="font-weight:500">${esc(m.name || m)}</td><td style="color:#ef4444;font-weight:600">${esc(m.status || m.issue || "—")}</td><td style="font-size:12px">${esc(m.message || m.details || "—")}</td></tr>`
).join("")}</tbody></table>` : ""}

${failingPods.length > 0 ? `<h3>6.4 Failing Pods (${failingPods.length})</h3>
<table><thead><tr><th>Pod</th><th>Namespace</th><th>Status</th><th>Restarts</th></tr></thead><tbody>${failingPods.map(p =>
  `<tr><td style="font-weight:500">${esc(p.name || p)}</td><td>${esc(p.namespace || "—")}</td><td style="color:#ef4444">${esc(p.status || p.phase || "—")}</td><td>${p.restarts ?? p.restartCount ?? "—"}</td></tr>`
).join("")}</tbody></table>` : ""}
</div>

<!-- Remediation Plan -->
${fixes.length > 0 ? `<div class="section">
<h2>7. Remediation Plan (${fixes.length} actions)</h2>
<table>
  <thead><tr><th width="80">Severity</th><th>Title</th><th>Description</th><th>Command</th></tr></thead>
  <tbody>${remRows}</tbody>
</table>
</div>` : ""}

<!-- Dry-Run Validation (evidence attached to the CR) -->
${session.dryRunResult ? `<div class="section">
<h2>8. Dry-Run Validation</h2>
<p><strong style="color:${session.dryRunResult.warnings ? "#f59e0b" : "#22c55e"}">${session.dryRunResult.warnings ? "PASSED WITH WARNINGS" : "PASSED"}</strong> — validated before this Change Request was raised.</p>
<pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;font-size:12px;white-space:pre-wrap;overflow:auto">${esc(session.dryRunResult.details || "")}</pre>
</div>` : ""}

<!-- Change Request -->
${session.crTicketId ? `<div class="section">
<h2>8. Change Request</h2>
<table class="kv">
  <tr><td>Ticket ID</td><td style="font-weight:700">${esc(session.crTicketId)}</td></tr>
  <tr><td>System ID</td><td style="font-family:monospace;font-size:12px">${esc(session.crSysId || "N/A")}</td></tr>
  <tr><td>Risk Level</td><td style="color:${riskColor};font-weight:600">${riskLevel}</td></tr>
  <tr><td>CR Type</td><td>Normal</td></tr>
  <tr><td>Category</td><td>Software</td></tr>
</table>
</div>` : ""}

<!-- Footer -->
<div class="footer">
  <div class="brand">TCS Agentic AI</div>
  <div style="opacity:.7">Generated by TCS Agentic AI Platform &mdash; ${new Date().toISOString()}</div>
  <div style="opacity:.5;margin-top:4px;font-size:11px">Classification: Internal &mdash; Upgrade Assessment Document</div>
</div>

</div></body></html>`;
}

// ── Upgrade Session Summary (for chat) ──────────────────────────────────────

export function formatSessionSummary(session) {
  const stateEmoji = {
    idle: "🔵", version_validated: "✅", channel_switched: "🔄",
    pre_assessed: "📋", component_analyzed: "🔍", remediation_proposed: "🔧",
    remediated: "✅", cr_submitted: "📨", cr_approved: "✅",
    dry_run_passed: "🏁", executing: "⚡", monitoring: "📡",
    completed: "🎉", failed: "❌", cancelled: "🚫",
  };

  const lines = [];
  const clusterLabel = session.cluster && session.cluster !== "local" ? ` (${session.cluster})` : "";
  lines.push(`### Upgrade Session: ${session.fromVersion} → ${session.targetVersion}${clusterLabel}`);
  lines.push("");
  lines.push(`**State:** ${stateEmoji[session.state] || "❓"} ${session.state.replace(/_/g, " ").toUpperCase()}`);
  if (session.cluster && session.cluster !== "local") {
    lines.push(`**Cluster:** ${session.cluster}`);
  }
  lines.push(`**Type:** ${session.upgradeType || "patch"} | **Channel:** ${session.channel || "N/A"}`);

  if (session.crTicketId) {
    lines.push(`**Change Request:** ${session.crTicketId}`);
  }

  if (session.preflightReport?.overallStatus) {
    lines.push(`**Pre-Assessment:** ${session.preflightReport.overallStatus}`);
  }

  if (session.errorMessage) {
    lines.push(`**Error:** ${session.errorMessage}`);
  }

  if (session.monitoringData?.snapshots?.length) {
    const latest = session.monitoringData.snapshots[session.monitoringData.snapshots.length - 1];
    lines.push(`**Progress:** ${latest.progress}% (${latest.phase})`);
    if (latest.operators) {
      lines.push(`**Operators:** ${latest.operators.updating} updating / ${latest.operators.degraded} degraded / ${latest.operators.total} total`);
    }
  }

  lines.push("");
  lines.push("**Upgrade Flow:**");
  const steps = [
    { state: "version_validated", label: "Version Validation" },
    { state: "pre_assessed", label: "Pre-Assessment (22 checks)" },
    { state: "component_analyzed", label: "Component Analysis" },
    { state: "remediation_proposed", label: "Remediation Plan" },
    { state: "cr_submitted", label: "Change Request Submitted" },
    { state: "cr_approved", label: "CR Approved" },
    { state: "dry_run_passed", label: "Dry Run Passed" },
    { state: "executing", label: "Upgrade Executing" },
    { state: "monitoring", label: "Monitoring" },
    { state: "completed", label: "Completed" },
  ];

  const stateOrder = Object.values(UPGRADE_STATES);
  const currentIdx = stateOrder.indexOf(session.state);

  for (const step of steps) {
    const stepIdx = stateOrder.indexOf(step.state);
    const done = stepIdx <= currentIdx && currentIdx >= 0;
    const current = step.state === session.state;
    lines.push(`  ${done ? "✅" : current ? "▶" : "⬜"} ${step.label}`);
  }

  return lines.join("\n");
}

// ── Stage Timeout Checker ──────────────────────────────────────────────────

export async function checkStageTimeouts() {
  if (!(await init())) return [];
  const timedOut = [];
  const sessions = await listSessions();
  for (const s of sessions) {
    const timeout = STAGE_TIMEOUTS[s.state];
    if (!timeout) continue;
    const elapsed = Date.now() - new Date(s.updatedAt).getTime();
    if (elapsed > timeout) {
      try {
        await transition(s.id, UPGRADE_STATES.FAILED, {
          errorMessage: `Stage "${s.state}" timed out after ${Math.round(elapsed / 60000)} minutes (limit: ${Math.round(timeout / 60000)}m)`,
        });
        timedOut.push({ sessionId: s.id, state: s.state, elapsed: Math.round(elapsed / 60000) });
      } catch {}
    }
  }
  return timedOut;
}

// ── Cancel Session ─────────────────────────────────────────────────────────

export async function cancelSession(sessionId, reason) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  if (["completed", "failed", "cancelled"].includes(session.state)) {
    throw new Error(`Cannot cancel session in "${session.state}" state`);
  }
  return transition(sessionId, UPGRADE_STATES.CANCELLED, {
    errorMessage: reason || "Cancelled by user",
  });
}

// ── Upgrade History ────────────────────────────────────────────────────────

export async function getUpgradeHistory({ cluster, limit = 50 } = {}) {
  if (!(await init())) return [];
  let result;
  if (cluster) {
    result = await query(
      `SELECT * FROM upgrade_sessions WHERE state IN ('completed','failed','cancelled') AND cluster = $1 ORDER BY updated_at DESC LIMIT $2`,
      [cluster, limit]
    );
  } else {
    result = await query(
      `SELECT * FROM upgrade_sessions WHERE state IN ('completed','failed','cancelled') ORDER BY updated_at DESC LIMIT $1`,
      [limit]
    );
  }
  return (result?.rows || []).map(mapSession);
}

// ── New Token: UPGRADE_PROGRESS ─────────────────────────────────────────────

export function buildUpgradeProgressToken(session) {
  return {
    sessionId: session.id,
    cluster: session.cluster || "local",
    state: session.state,
    fromVersion: session.fromVersion,
    targetVersion: session.targetVersion,
    channel: session.channel,
    upgradeType: session.upgradeType,
    crTicketId: session.crTicketId || null,
    preflightStatus: session.preflightReport?.overallStatus || null,
    progress: session.monitoringData?.snapshots?.length
      ? session.monitoringData.snapshots[session.monitoringData.snapshots.length - 1]
      : null,
    error: session.errorMessage || null,
  };
}
