/**
 * Guardrails & Safety Service (Pillar 7).
 *
 * Classifies oc/kubectl commands into 4 risk levels:
 *   - safe         → read-only operations (get, describe, logs, top, etc.)
 *   - caution      → mutating but reversible (patch, scale, label, annotate)
 *   - destructive  → mutating and hard to reverse (delete, drain, cordon)
 *   - blocked      → never allowed regardless of approval (rm -rf, etc.)
 *
 * Also enforces protected-namespace rules (openshift-*, kube-system) and
 * provides remediation suggestions for blocked commands.
 */

// ---------------------------------------------------------------------------
// Classification patterns
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS = [
  { pattern: /\brm\s+-rf?\s*\/?\s*$|\brm\s+-rf\s+\/\b/, reason: "Shell rm -rf is never allowed" },
  { pattern: /:\s*\(\s*\)\s*\{/, reason: "Fork bomb pattern detected" },
  { pattern: /\bmkfs\b|\bdd\s+if=|>\s*\/dev\/sda/, reason: "Filesystem destruction is never allowed" },
  { pattern: /\bcurl\b.*\|\s*(?:sh|bash)\b/, reason: "Piping curl to shell is never allowed" },
  { pattern: /\bwget\b.*\|\s*(?:sh|bash)\b/, reason: "Piping wget to shell is never allowed" },
];

const DESTRUCTIVE_PATTERNS = [
  { pattern: /\bdelete\s+(?:namespace|ns|project)\s+\S/i, severity: "critical", reason: "Deletes a namespace and all its resources" },
  { pattern: /\bdelete\s+(?:node|nodes|machine|machines|machineset)\s+\S/i, severity: "critical", reason: "Affects cluster capacity" },
  { pattern: /\bdelete\s+(?:crd|customresourcedefinition)\b/i, severity: "critical", reason: "Removes a CRD (deletes all custom resources of that type)" },
  { pattern: /\bdelete\s+(?:pv|persistentvolume)\b/i, severity: "critical", reason: "Deletes persistent storage" },
  { pattern: /\bdelete\s+(?:clusterrole|clusterrolebinding|rolebinding)\b/i, severity: "high", reason: "Removes RBAC permissions" },
  { pattern: /\b(?:drain|cordon|uncordon)\s+\S/i, severity: "high", reason: "Affects scheduling on a node" },
  { pattern: /\bdelete\s+all\b/i, severity: "critical", reason: "Bulk delete — extremely dangerous" },
  { pattern: /\bdelete\s+(?:deployment|deploy|sts|statefulset|ds|daemonset)\s+\S/i, severity: "medium", reason: "Removes a workload" },
  { pattern: /\bscale\s+.*--replicas=0\b/i, severity: "medium", reason: "Scales workload to zero (effective shutdown)" },
  { pattern: /\bedit\b/i, severity: "medium", reason: "Interactive edit not supported in non-TTY context" },
];

const CAUTION_PATTERNS = [
  { pattern: /\bpatch\b/i, reason: "Modifies resource spec" },
  { pattern: /\bapply\b/i, reason: "Creates or updates resources" },
  { pattern: /\breplace\b/i, reason: "Replaces a resource definition" },
  { pattern: /\bscale\b/i, reason: "Changes replica count" },
  { pattern: /\bset\s+(?:image|env|resources|serviceaccount)\b/i, reason: "Modifies running workloads" },
  { pattern: /\brollout\s+(?:restart|undo)\b/i, reason: "Restarts or rolls back a workload" },
  { pattern: /\blabel\b|\bannotate\b/i, reason: "Modifies metadata" },
  { pattern: /\bcreate\b/i, reason: "Creates new resources" },
  { pattern: /\bautoscale\b/i, reason: "Configures auto-scaling" },
];

const READ_ONLY_VERBS = new Set([
  "get", "describe", "logs", "top", "events", "explain", "config",
  "version", "cluster-info", "status", "whoami", "api-resources",
  "api-versions", "adm",
]);

// Protected namespaces — mutating operations require extra warning
const PROTECTED_NAMESPACES = [
  "openshift-apiserver", "openshift-authentication", "openshift-config",
  "openshift-controller-manager", "openshift-etcd", "openshift-kube-apiserver",
  "openshift-kube-controller-manager", "openshift-kube-scheduler",
  "openshift-machine-api", "openshift-network-operator", "openshift-operator-lifecycle-manager",
  "openshift-sdn", "openshift-ovn-kubernetes",
  "kube-system", "kube-public", "kube-node-lease",
  "default",
];

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

/**
 * Classify a command's risk level.
 * @returns {object} { level: 'safe'|'caution'|'destructive'|'blocked',
 *                     severity?: 'low'|'medium'|'high'|'critical',
 *                     reason: string,
 *                     namespace?: string,
 *                     protectedNs?: boolean,
 *                     requiresApproval: boolean,
 *                     allowedAfterApproval: boolean }
 */
export function classifyCommand(command) {
  const cmd = String(command || "").trim();

  if (!cmd) {
    return { level: "blocked", reason: "Empty command", requiresApproval: false, allowedAfterApproval: false };
  }

  // Blocked first — never run these
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return { level: "blocked", reason, requiresApproval: false, allowedAfterApproval: false };
    }
  }

  // Only oc/kubectl commands are allowed at all
  const firstToken = cmd.split(/\s+/)[0];
  if (firstToken !== "oc" && firstToken !== "kubectl") {
    return {
      level: "blocked",
      reason: `Only 'oc' and 'kubectl' commands are allowed (got: '${firstToken}')`,
      requiresApproval: false,
      allowedAfterApproval: false,
    };
  }

  // Extract namespace (best-effort)
  const namespace = _extractNamespace(cmd);
  const protectedNs = namespace ? PROTECTED_NAMESPACES.includes(namespace) || namespace.startsWith("openshift-") : false;

  // Destructive
  for (const { pattern, severity, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        level: "destructive",
        severity,
        reason,
        namespace,
        protectedNs,
        requiresApproval: true,
        allowedAfterApproval: severity !== "critical" || !protectedNs,
      };
    }
  }

  // Caution
  for (const { pattern, reason } of CAUTION_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        level: "caution",
        severity: protectedNs ? "high" : "low",
        reason: protectedNs ? `${reason} in protected namespace ${namespace}` : reason,
        namespace,
        protectedNs,
        requiresApproval: protectedNs,
        allowedAfterApproval: true,
      };
    }
  }

  // Extract verb to classify as safe
  const tokens = cmd.split(/\s+/).filter((t) => !t.startsWith("-"));
  const verb = tokens[1];
  if (verb && READ_ONLY_VERBS.has(verb.split("=")[0])) {
    return {
      level: "safe",
      reason: "Read-only operation",
      namespace,
      protectedNs,
      requiresApproval: false,
      allowedAfterApproval: true,
    };
  }

  // Unknown verb — treat as caution by default
  return {
    level: "caution",
    severity: "medium",
    reason: "Unrecognized command — treated as cautious",
    namespace,
    protectedNs,
    requiresApproval: protectedNs,
    allowedAfterApproval: true,
  };
}

function _extractNamespace(cmd) {
  const m1 = cmd.match(/(?:^|\s)(?:-n|--namespace[=\s]+)["']?([a-z0-9][-a-z0-9]*)["']?/i);
  if (m1) return m1[1];
  return null;
}

// ---------------------------------------------------------------------------
// Confirmation token system — destructive commands need a token from a
// prior /confirm call so the user explicitly approved
// ---------------------------------------------------------------------------

const _confirmationTokens = new Map(); // token -> { command, expiresAt, userId }
const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function issueConfirmationToken(command, userId) {
  const token = "cnf_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  _confirmationTokens.set(token, {
    command,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    userId: userId || null,
  });
  // Cleanup expired
  for (const [k, v] of _confirmationTokens) {
    if (v.expiresAt < Date.now()) _confirmationTokens.delete(k);
  }
  return token;
}

export function consumeConfirmationToken(token, command) {
  if (!token) return { ok: false, reason: "Missing confirmation token" };
  const entry = _confirmationTokens.get(token);
  if (!entry) return { ok: false, reason: "Token not found or already used" };
  if (entry.expiresAt < Date.now()) {
    _confirmationTokens.delete(token);
    return { ok: false, reason: "Token expired (5 minute timeout)" };
  }
  if (entry.command !== command) {
    return { ok: false, reason: "Token does not match this command" };
  }
  _confirmationTokens.delete(token);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pre-execution check — call from /api/execute before running anything
// ---------------------------------------------------------------------------

/**
 * Decide whether to allow a command to run.
 * @param {string} command
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @param {string} [opts.confirmationToken]
 * @param {string} [opts.userId]
 * @returns {object} { allow: boolean, classification, reason?, suggestion? }
 */
export function preflightCheck(command, opts = {}) {
  const classification = classifyCommand(command);

  // Always allow safe + dry-run
  if (classification.level === "safe") {
    return { allow: true, classification };
  }
  if (opts.dryRun && classification.level !== "blocked") {
    return { allow: true, classification, note: "Dry-run — no real changes" };
  }

  // Block hard
  if (classification.level === "blocked") {
    return {
      allow: false,
      classification,
      reason: classification.reason,
      suggestion: "This command pattern is permanently disallowed.",
    };
  }

  // Destructive — require token
  if (classification.level === "destructive") {
    if (!classification.allowedAfterApproval) {
      return {
        allow: false,
        classification,
        reason: `${classification.reason} — this operation is blocked in protected namespaces`,
        suggestion: "Perform this operation directly via cluster admin tools after careful review.",
      };
    }
    const check = consumeConfirmationToken(opts.confirmationToken, command);
    if (!check.ok) {
      return {
        allow: false,
        classification,
        reason: `Destructive operation requires explicit confirmation: ${classification.reason}`,
        suggestion: check.reason,
        needsConfirmation: true,
      };
    }
    return { allow: true, classification, note: "Confirmation accepted" };
  }

  // Caution — allow but flag
  if (classification.level === "caution") {
    if (classification.requiresApproval && opts.confirmationToken) {
      const check = consumeConfirmationToken(opts.confirmationToken, command);
      if (!check.ok) {
        return {
          allow: false,
          classification,
          reason: `Caution operation in protected namespace requires confirmation`,
          suggestion: check.reason,
          needsConfirmation: true,
        };
      }
    }
    return { allow: true, classification };
  }

  return { allow: true, classification };
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

import { query, isEnabled } from "../utils/db.js";

const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  conversation_id TEXT,
  command TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  risk_level TEXT,
  classification JSONB,
  allowed BOOLEAN NOT NULL,
  block_reason TEXT,
  success BOOLEAN,
  exit_code INTEGER,
  stdout_preview TEXT,
  stderr_preview TEXT,
  duration_ms INTEGER,
  cluster_name TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_risk ON audit_log(risk_level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at DESC);
`;

let _auditSchemaEnsured = false;

async function ensureAuditSchema() {
  if (_auditSchemaEnsured) return;
  if (!(await isEnabled())) return;
  try {
    await query(AUDIT_SCHEMA);
    _auditSchemaEnsured = true;
  } catch (err) {
    console.error("[audit] schema init failed:", err.message);
  }
}

export async function logAuditEvent({
  userId,
  conversationId,
  command,
  dryRun,
  classification,
  allowed,
  blockReason,
  success,
  exitCode,
  stdoutPreview,
  stderrPreview,
  durationMs,
  clusterName,
  ipAddress,
}) {
  await ensureAuditSchema();
  try {
    await query(
      `INSERT INTO audit_log
       (user_id, conversation_id, command, dry_run, risk_level, classification,
        allowed, block_reason, success, exit_code, stdout_preview, stderr_preview,
        duration_ms, cluster_name, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        userId || null,
        conversationId || null,
        command || "",
        Boolean(dryRun),
        classification?.level || null,
        classification ? JSON.stringify(classification) : null,
        Boolean(allowed),
        blockReason || null,
        success == null ? null : Boolean(success),
        Number.isFinite(exitCode) ? exitCode : null,
        stdoutPreview ? String(stdoutPreview).slice(0, 500) : null,
        stderrPreview ? String(stderrPreview).slice(0, 500) : null,
        Number.isFinite(durationMs) ? Math.round(durationMs) : null,
        clusterName || null,
        ipAddress || null,
      ]
    );
  } catch (err) {
    console.error("[audit] log failed:", err.message);
  }
}

export async function getAuditLog({ limit = 100, riskLevel, userId, hours }) {
  await ensureAuditSchema();
  if (!(await isEnabled())) return [];
  const conditions = [];
  const params = [];
  if (riskLevel) { params.push(riskLevel); conditions.push(`risk_level = $${params.length}`); }
  if (userId) { params.push(userId); conditions.push(`user_id = $${params.length}`); }
  if (Number.isFinite(hours)) {
    params.push(new Date(Date.now() - hours * 3600 * 1000).toISOString());
    conditions.push(`created_at >= $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(Math.min(500, Math.max(1, limit)));
  try {
    const res = await query(
      `SELECT id, user_id, conversation_id, command, dry_run, risk_level,
              allowed, block_reason, success, exit_code, duration_ms,
              cluster_name, created_at
       FROM audit_log ${where} ORDER BY id DESC LIMIT $${params.length}`,
      params
    );
    return res?.rows || [];
  } catch (err) {
    console.error("[audit] query failed:", err.message);
    return [];
  }
}

export async function getAuditSummary(hours = 24) {
  await ensureAuditSchema();
  if (!(await isEnabled())) return null;
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  try {
    const res = await query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE allowed = true)::int AS allowed,
         COUNT(*) FILTER (WHERE allowed = false)::int AS blocked,
         COUNT(*) FILTER (WHERE risk_level = 'destructive')::int AS destructive,
         COUNT(*) FILTER (WHERE risk_level = 'caution')::int AS caution,
         COUNT(*) FILTER (WHERE risk_level = 'safe')::int AS safe,
         COUNT(*) FILTER (WHERE dry_run = true)::int AS dry_runs,
         COUNT(*) FILTER (WHERE success = false AND allowed = true)::int AS failed
       FROM audit_log WHERE created_at >= $1`,
      [since]
    );
    return res?.rows?.[0] || null;
  } catch (err) {
    return null;
  }
}
