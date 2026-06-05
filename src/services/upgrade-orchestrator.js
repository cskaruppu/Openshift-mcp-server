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
import { runPreflightChecks, formatPreflightReport, validateUpgradeVersion } from "../tools/upgrade-preflight.js";
import { trackCR, getCR, updateCRStatus, syncCRFromServiceNow } from "./cr-tracker.js";
import { getRecord, updateRecord } from "../utils/servicenow-client.js";

/**
 * Run `fn` in the correct cluster context. If cluster is "local" or falsy,
 * run directly. Otherwise, route all ocpGet/ocpFetch calls through the
 * agent bridge for that cluster.
 */
function withClusterContext(cluster, fn) {
  if (!cluster || cluster === "local") return fn();
  if (!hasActiveChannel(cluster)) {
    throw new Error(`Agent for cluster "${cluster}" is not connected. Ensure it shows Active in AI Hub.`);
  }
  return withRemoteClusterBridge(cluster, fn);
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
  [UPGRADE_STATES.PRE_ASSESSED]:         [UPGRADE_STATES.COMPONENT_ANALYZED, UPGRADE_STATES.REMEDIATION_PROPOSED, UPGRADE_STATES.CR_SUBMITTED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.COMPONENT_ANALYZED]:   [UPGRADE_STATES.REMEDIATION_PROPOSED, UPGRADE_STATES.CR_SUBMITTED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.REMEDIATION_PROPOSED]: [UPGRADE_STATES.REMEDIATED, UPGRADE_STATES.CR_SUBMITTED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.REMEDIATED]:           [UPGRADE_STATES.CR_SUBMITTED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.CR_SUBMITTED]:         [UPGRADE_STATES.CR_APPROVED, UPGRADE_STATES.CANCELLED, UPGRADE_STATES.FAILED],
  [UPGRADE_STATES.CR_APPROVED]:          [UPGRADE_STATES.DRY_RUN_PASSED, UPGRADE_STATES.EXECUTING, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.DRY_RUN_PASSED]:       [UPGRADE_STATES.EXECUTING, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.EXECUTING]:            [UPGRADE_STATES.MONITORING, UPGRADE_STATES.FAILED, UPGRADE_STATES.CANCELLED],
  [UPGRADE_STATES.MONITORING]:           [UPGRADE_STATES.COMPLETED, UPGRADE_STATES.FAILED],
  [UPGRADE_STATES.COMPLETED]:            [],
  [UPGRADE_STATES.FAILED]:               [UPGRADE_STATES.IDLE],
  [UPGRADE_STATES.CANCELLED]:            [UPGRADE_STATES.IDLE],
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

  // Cancel any existing active session for this conversation + cluster
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

  // Sort by severity: critical → warning → info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  fixes.sort((a, b) => (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99));

  const plan = {
    timestamp: new Date().toISOString(),
    totalFixes: fixes.length,
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
      `Node Topology: ${report.nodeTopology?.masters || 0} masters, ${report.nodeTopology?.workers || 0} workers`,
    ].join("\n"),
    type: "normal",
    priority: riskLevel === "high" ? "2" : riskLevel === "moderate" ? "3" : "4",
    risk: riskLevel,
    justification: `22-point pre-upgrade assessment completed. Status: ${report.overallStatus || "N/A"}. ${failCount} blocking issues, ${warnCount} warnings.`,
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

  const port = process.env.PORT || 3001;
  const result = await fetch(`http://localhost:${port}/api/upgrade/dryrun`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: session.targetVersion,
      channel: session.channel,
    }),
  }).then(r => r.json());

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
  const cv = await withClusterContext(session.cluster, () =>
    ocpGet("/apis/config.openshift.io/v1/clusterversions/version"));
  const currentVer = cv?.status?.desired?.version || "";
  const availableUpdates = cv?.status?.availableUpdates || [];
  const channel = cv?.spec?.channel || "";
  const validation = validateUpgradeVersion(currentVer, session.targetVersion, availableUpdates, channel);

  if (!validation.valid) {
    await updateSession(sessionId, { errorMessage: `Pre-execution validation failed: ${validation.reason}` });
    return { session: await getSession(sessionId), success: false, error: validation.reason };
  }

  // Patch ClusterVersion
  await withClusterContext(session.cluster, () =>
    ocpFetch("/apis/config.openshift.io/v1/clusterversions/version", {
      method: "PATCH",
      headers: { "Content-Type": "application/merge-patch+json" },
      body: JSON.stringify({ spec: { desiredUpdate: { version: session.targetVersion } } }),
    }));

  const updated = await transition(sessionId, UPGRADE_STATES.EXECUTING);
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

  const desiredVersion = cv?.status?.desired?.version || "";
  const currentHistory = (cv?.status?.history || []).find(h => h.version === desiredVersion);

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
  const progressing = conditions.Progressing;

  if (currentHistory?.state === "Completed") {
    phase = "complete";
    progress = 100;
  } else if (conditions.Failing?.status === "True" || conditions.Degraded?.status === "True") {
    phase = "failed";
  } else if (progressing?.status === "True") {
    const totalOps = opItems.length || 1;
    const doneOps = totalOps - updatingCount;
    progress = Math.min(95, Math.round((doneOps / totalOps) * 90) + 5);
    phase = progress < 20 ? "preparing" : progress < 80 ? "updating" : "completing";
  } else if (conditions.Available?.status === "True") {
    phase = "complete";
    progress = 100;
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

  const monitorData = {
    timestamp: new Date().toISOString(),
    phase,
    progress,
    version: desiredVersion,
    message: progressing?.message || "",
    operators: { updating: updatingCount, degraded: degradedCount, available: availableCount, total: opItems.length },
    operatorDetails: operatorDetails.slice(0, 10),
    nodes: nodeStatus,
  };

  // Append to monitoring history
  const existingData = session.monitoringData || { snapshots: [] };
  existingData.snapshots.push(monitorData);
  if (existingData.snapshots.length > 100) {
    existingData.snapshots = existingData.snapshots.slice(-100);
  }

  // Transition on terminal states
  if (phase === "complete") {
    await transition(sessionId, UPGRADE_STATES.MONITORING, { monitoringData: existingData });
    // Wait for operator stabilization then auto-complete
    const allStable = degradedCount === 0 && updatingCount === 0;
    if (allStable) {
      await transition(sessionId, UPGRADE_STATES.COMPLETED, { monitoringData: existingData });
    }
  } else if (phase === "failed") {
    await transition(sessionId, UPGRADE_STATES.FAILED, {
      monitoringData: existingData,
      errorMessage: progressing?.message || "Upgrade failed",
    });
  } else {
    await updateSession(sessionId, { monitoringData: existingData });
  }

  return { session: await getSession(sessionId), ...monitorData };
}

// ── Step 11: Post-Assessment ────────────────────────────────────────────────

export async function stepPostAssessment(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  // Re-run preflight checks against the (now current) target version to verify health
  let postReport = null;
  try {
    const cv = await withClusterContext(session.cluster, () =>
      ocpGet("/apis/config.openshift.io/v1/clusterversions/version"));
    const newCurrent = cv?.status?.desired?.version || session.targetVersion;
    const availableUpdates = cv?.status?.availableUpdates || [];
    const nextTarget = availableUpdates.length > 0 ? availableUpdates[0].version : newCurrent;
    postReport = await withClusterContext(session.cluster, () =>
      runPreflightChecks(nextTarget, newCurrent));
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

  const postAssessment = {
    timestamp: new Date().toISOString(),
    report: postReport,
    comparison,
    fromVersion: session.fromVersion,
    toVersion: session.targetVersion,
    duration: session.monitoringData?.snapshots?.length
      ? `${Math.round((Date.now() - new Date(session.monitoringData.snapshots[0].timestamp).getTime()) / 60000)} minutes`
      : "unknown",
  };

  await updateSession(sessionId, { postAssessment });

  // Update ServiceNow CR with outcome
  if (session.crSysId) {
    try {
      await updateRecord("change_request", session.crSysId, {
        state: "3",
        close_code: "successful",
        close_notes: `Upgrade ${session.fromVersion} → ${session.targetVersion} completed successfully. Duration: ${postAssessment.duration}. Post-assessment: ${comparison.resolved.length} issues resolved, ${comparison.newIssues.length} new issues, ${comparison.persistent.length} persistent.`,
      });
    } catch { /* ServiceNow update failed — non-critical */ }
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

  const statusColor = report.overallStatus === "READY" ? "#22c55e"
    : report.overallStatus === "READY_WITH_WARNINGS" ? "#f59e0b" : "#ef4444";

  const checkRows = checks.map(c => {
    const icon = c.status === "pass" ? "✅" : c.status === "warning" ? "⚠️" : "❌";
    const color = c.status === "pass" ? "#22c55e" : c.status === "warning" ? "#f59e0b" : "#ef4444";
    const items = (c.items || []).map(i =>
      `<li style="margin:2px 0;font-size:12px">${i.name}: ${i.issue}${i.message ? ` — ${i.message}` : ""}</li>`
    ).join("");
    return `<tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${icon}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600">${c.category}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:${color}">${c.status.toUpperCase()}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-size:13px">${c.details}${items ? `<ul style="margin:4px 0;padding-left:20px">${items}</ul>` : ""}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Pre-Upgrade Assessment — ${session.fromVersion} → ${session.targetVersion}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:20px;background:#f9fafb;color:#111827}
.header{background:#1e293b;color:white;padding:24px;border-radius:8px;margin-bottom:20px}
.summary{display:flex;gap:16px;margin:16px 0}
.stat{background:white;border-radius:8px;padding:16px;flex:1;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.stat h3{margin:0;font-size:24px}.stat p{margin:4px 0 0;font-size:12px;color:#6b7280}
table{width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
th{background:#f3f4f6;padding:10px;text-align:left;font-size:13px;border-bottom:2px solid #e5e7eb}</style></head>
<body>
<div class="header">
  <h1 style="margin:0;font-size:22px">OpenShift Pre-Upgrade Assessment Report</h1>
  <p style="margin:8px 0 0;opacity:.8">${session.fromVersion} → ${session.targetVersion} | ${report.channel || ""} | Generated: ${new Date().toISOString()}</p>
  <div style="margin-top:12px;display:inline-block;padding:6px 16px;border-radius:20px;background:${statusColor};font-weight:700;font-size:14px">${report.overallStatus || "UNKNOWN"}</div>
</div>
<div class="summary">
  <div class="stat"><h3 style="color:#22c55e">${pass}</h3><p>Passed</p></div>
  <div class="stat"><h3 style="color:#f59e0b">${warn}</h3><p>Warnings</p></div>
  <div class="stat"><h3 style="color:#ef4444">${fail}</h3><p>Failed</p></div>
  <div class="stat"><h3>${checks.length}</h3><p>Total Checks</p></div>
</div>
<table>
  <thead><tr><th width="40"></th><th>Category</th><th width="100">Status</th><th>Details</th></tr></thead>
  <tbody>${checkRows}</tbody>
</table>
<div style="margin-top:20px;padding:16px;background:white;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1)">
  <h3 style="margin:0 0 8px">Cluster Topology</h3>
  <p style="margin:0;font-size:13px">Masters: ${report.nodeTopology?.masters || "N/A"} | Workers: ${report.nodeTopology?.workers || "N/A"} | Infra: ${report.nodeTopology?.infra || 0} | Total: ${report.nodeTopology?.total || "N/A"}</p>
  <p style="margin:4px 0 0;font-size:13px">Estimated Duration: ${report.versionDelta?.estimatedDuration || "N/A"}</p>
</div>
</body></html>`;
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
