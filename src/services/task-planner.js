/**
 * Task Planner (Pillar 4).
 *
 * Decomposes a complex goal into a sequence of executable steps, tracks
 * progress, and auto-generates rollback commands.
 *
 * Plans are stored in-memory (keyed by planId) and optionally persisted
 * to PostgreSQL kv_store for cross-restart visibility.
 *
 * Plan lifecycle:
 *   draft → approved → executing → (completed | failed | rolled_back)
 *
 * Each step has:
 *   - id, title, description, command (or action), dependsOn[], status,
 *     dryRunCmd, rollbackCmd, output, error
 */

import { query, isEnabled } from "../utils/db.js";

const PLAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  user_id TEXT,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  steps JSONB NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id, created_at DESC);
`;

let _schemaEnsured = false;
async function ensurePlanSchema() {
  if (_schemaEnsured) return;
  if (!(await isEnabled())) return;
  try {
    await query(PLAN_SCHEMA);
    _schemaEnsured = true;
  } catch (err) {
    console.error("[planner] schema init failed:", err.message);
  }
}

// In-memory plan cache for fast access
const _plans = new Map();

function genPlanId() {
  return "plan_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Plan templates — well-known goals get a canonical step decomposition
// ---------------------------------------------------------------------------

/**
 * Create a plan from a high-level goal. Returns a Plan object.
 * Supports built-in templates for common goals. For unknown goals, returns
 * a single-step "ad-hoc" plan that the LLM can elaborate.
 */
export function createPlan(goal, context = {}) {
  const goalLower = String(goal || "").toLowerCase().trim();
  let template = null;

  if (/migrate.*namespace|move.*namespace/.test(goalLower)) {
    template = templateNamespaceMigration(context);
  } else if (/upgrade|update\s+cluster|update\s+openshift/.test(goalLower)) {
    template = templateClusterUpgrade(context);
  } else if (/right[- ]?size|optimize.*resource/.test(goalLower)) {
    template = templateRightsize(context);
  } else if (/backup|disaster|dr\s+test/.test(goalLower)) {
    template = templateBackup(context);
  } else if (/audit.*security|security\s+audit|cis/.test(goalLower)) {
    template = templateSecurityAudit(context);
  } else if (/scale\s+(?:up|down|out)/.test(goalLower)) {
    template = templateScaleWorkload(context);
  } else {
    template = templateGeneric(goal, context);
  }

  const plan = {
    id: genPlanId(),
    goal,
    userId: context.userId || null,
    conversationId: context.conversationId || null,
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    template: template.name,
    steps: template.steps.map((s, i) => ({
      id: "step_" + i,
      status: "pending",
      ...s,
    })),
    metadata: context.metadata || {},
  };
  _plans.set(plan.id, plan);
  persistPlan(plan).catch(() => {});
  return plan;
}

function templateNamespaceMigration(ctx) {
  const fromNs = ctx.fromNamespace || "<from-ns>";
  const toNs = ctx.toNamespace || "<to-ns>";
  return {
    name: "namespace_migration",
    steps: [
      {
        title: "Verify target namespace exists",
        description: `Confirm namespace ${toNs} exists or create it`,
        command: `oc get namespace ${toNs} || oc create namespace ${toNs}`,
        dryRunCmd: `oc get namespace ${toNs}`,
        rollbackCmd: null,
        critical: true,
      },
      {
        title: "Inventory source namespace",
        description: `List all resources in ${fromNs} that will be migrated`,
        command: `oc get all,configmaps,secrets,pvc,routes -n ${fromNs}`,
        dryRunCmd: `oc get all,configmaps,secrets,pvc,routes -n ${fromNs}`,
        rollbackCmd: null,
        critical: false,
      },
      {
        title: "Copy ConfigMaps and Secrets",
        description: `Export and re-create configmaps/secrets in ${toNs}`,
        command: `oc get configmaps,secrets -n ${fromNs} -o yaml | sed 's/namespace: ${fromNs}/namespace: ${toNs}/' | oc apply -n ${toNs} -f -`,
        dryRunCmd: `oc get configmaps,secrets -n ${fromNs} -o yaml | sed 's/namespace: ${fromNs}/namespace: ${toNs}/' | oc apply --dry-run=client -n ${toNs} -f -`,
        rollbackCmd: `oc delete configmaps,secrets -n ${toNs} --all`,
        critical: true,
      },
      {
        title: "Copy Deployments and StatefulSets",
        description: `Migrate workload definitions to ${toNs}`,
        command: `oc get deployments,statefulsets -n ${fromNs} -o yaml | sed 's/namespace: ${fromNs}/namespace: ${toNs}/' | oc apply -n ${toNs} -f -`,
        dryRunCmd: `oc get deployments,statefulsets -n ${fromNs} -o yaml | sed 's/namespace: ${fromNs}/namespace: ${toNs}/' | oc apply --dry-run=client -n ${toNs} -f -`,
        rollbackCmd: `oc delete deployments,statefulsets -n ${toNs} --all`,
        critical: true,
      },
      {
        title: "Verify workloads are healthy",
        description: `Wait for all pods to reach Running state in ${toNs}`,
        command: `oc get pods -n ${toNs} -w --timeout=300s`,
        dryRunCmd: `oc get pods -n ${toNs}`,
        rollbackCmd: null,
        critical: true,
      },
      {
        title: "Cutover services and routes",
        description: `Switch traffic to ${toNs} services`,
        command: `oc get routes,services -n ${fromNs} -o yaml | sed 's/namespace: ${fromNs}/namespace: ${toNs}/' | oc apply -n ${toNs} -f -`,
        dryRunCmd: `oc get routes,services -n ${fromNs} -o yaml | sed 's/namespace: ${fromNs}/namespace: ${toNs}/' | oc apply --dry-run=client -n ${toNs} -f -`,
        rollbackCmd: `oc delete routes,services -n ${toNs} --all`,
        critical: true,
      },
      {
        title: "Decommission source namespace (manual approval)",
        description: `After validation, delete ${fromNs} to complete migration`,
        command: `oc delete namespace ${fromNs}`,
        dryRunCmd: `oc get namespace ${fromNs}`,
        rollbackCmd: null,
        critical: true,
        requiresExplicitApproval: true,
      },
    ],
  };
}

function templateClusterUpgrade(ctx) {
  const targetVersion = ctx.targetVersion || "<target-version>";
  return {
    name: "cluster_upgrade",
    steps: [
      {
        title: "Run upgrade preflight checks",
        description: "Verify cluster is healthy and ready for upgrade",
        command: `oc adm upgrade --include-not-recommended`,
        dryRunCmd: `oc adm upgrade --include-not-recommended`,
        rollbackCmd: null,
        critical: true,
      },
      {
        title: "Backup etcd",
        description: "Create etcd backup before upgrade",
        command: `oc debug node/<master-node> -- chroot /host /usr/local/bin/cluster-backup.sh /home/core/backup`,
        dryRunCmd: null,
        rollbackCmd: null,
        critical: true,
        requiresExplicitApproval: true,
      },
      {
        title: "Pause cluster autoscaler",
        description: "Prevent autoscaling during upgrade",
        command: `oc scale --replicas=0 deployment/cluster-autoscaler-operator -n openshift-cluster-autoscaler-operator`,
        dryRunCmd: `oc get deployment/cluster-autoscaler-operator -n openshift-cluster-autoscaler-operator`,
        rollbackCmd: `oc scale --replicas=1 deployment/cluster-autoscaler-operator -n openshift-cluster-autoscaler-operator`,
        critical: false,
      },
      {
        title: "Initiate cluster upgrade",
        description: `Upgrade to ${targetVersion}`,
        command: `oc adm upgrade --to=${targetVersion}`,
        dryRunCmd: null,
        rollbackCmd: null,
        critical: true,
        requiresExplicitApproval: true,
      },
      {
        title: "Monitor upgrade progress",
        description: "Wait for all ClusterOperators to be available",
        command: `oc get clusteroperators`,
        dryRunCmd: `oc get clusteroperators`,
        rollbackCmd: null,
        critical: true,
      },
      {
        title: "Resume cluster autoscaler",
        description: "Re-enable autoscaling after upgrade",
        command: `oc scale --replicas=1 deployment/cluster-autoscaler-operator -n openshift-cluster-autoscaler-operator`,
        dryRunCmd: `oc get deployment/cluster-autoscaler-operator -n openshift-cluster-autoscaler-operator`,
        rollbackCmd: null,
        critical: false,
      },
    ],
  };
}

function templateRightsize(ctx) {
  return {
    name: "rightsize",
    steps: [
      {
        title: "Analyze current resource usage",
        description: "Run optimization scan to identify over/under-provisioned workloads",
        command: "/recommendations",
        dryRunCmd: "/recommendations",
        rollbackCmd: null,
        critical: false,
      },
      {
        title: "Review proposed changes",
        description: "Examine the right-sized values before applying",
        command: null,
        dryRunCmd: null,
        rollbackCmd: null,
        critical: false,
        manual: true,
      },
      {
        title: "Apply right-sizing patches",
        description: "Update deployments with new resource requests/limits",
        command: "<generated from recommendations>",
        dryRunCmd: "<generated dry-run from recommendations>",
        rollbackCmd: "<original values from snapshot>",
        critical: true,
        requiresExplicitApproval: true,
      },
      {
        title: "Verify workload stability",
        description: "Monitor pods for the next 15 minutes for any restarts or issues",
        command: `oc get pods --all-namespaces | grep -v Running`,
        dryRunCmd: `oc get pods --all-namespaces | grep -v Running`,
        rollbackCmd: null,
        critical: true,
      },
    ],
  };
}

function templateBackup(ctx) {
  const ns = ctx.namespace || "openshift-adp";
  return {
    name: "backup",
    steps: [
      {
        title: "Verify Velero/OADP installation",
        description: "Confirm backup operator is running",
        command: `oc get pods -n ${ns}`,
        dryRunCmd: `oc get pods -n ${ns}`,
        rollbackCmd: null,
        critical: true,
      },
      {
        title: "List existing backups",
        description: "Show current backup state",
        command: `oc get backups -n ${ns}`,
        dryRunCmd: `oc get backups -n ${ns}`,
        rollbackCmd: null,
        critical: false,
      },
      {
        title: "Create on-demand backup",
        description: "Trigger a new full cluster backup",
        command: `velero backup create on-demand-$(date +%Y%m%d-%H%M%S) -n ${ns}`,
        dryRunCmd: null,
        rollbackCmd: null,
        critical: true,
        requiresExplicitApproval: true,
      },
      {
        title: "Monitor backup completion",
        description: "Wait for backup phase=Completed",
        command: `oc get backup -n ${ns} -w`,
        dryRunCmd: `oc get backup -n ${ns}`,
        rollbackCmd: null,
        critical: true,
      },
    ],
  };
}

function templateSecurityAudit(ctx) {
  return {
    name: "security_audit",
    steps: [
      { title: "Run /security command", description: "Full cluster security scan", command: "/security", dryRunCmd: "/security", rollbackCmd: null, critical: false },
      { title: "Review privileged pods", description: "List pods with privileged: true", command: "oc get pods --all-namespaces -o json | jq '.items[] | select(.spec.containers[].securityContext.privileged==true) | {ns: .metadata.namespace, name: .metadata.name}'", dryRunCmd: null, rollbackCmd: null, critical: false },
      { title: "Check NetworkPolicy coverage", description: "Identify namespaces missing NetworkPolicies", command: "oc get networkpolicies --all-namespaces", dryRunCmd: "oc get networkpolicies --all-namespaces", rollbackCmd: null, critical: false },
      { title: "Apply remediations", description: "Address findings from the security report", command: "<generated from security findings>", dryRunCmd: null, rollbackCmd: null, critical: true, requiresExplicitApproval: true, manual: true },
    ],
  };
}

function templateScaleWorkload(ctx) {
  const dep = ctx.deployment || "<deployment>";
  const ns = ctx.namespace || "<namespace>";
  const replicas = ctx.replicas || "<n>";
  return {
    name: "scale_workload",
    steps: [
      { title: "Check current replicas", description: "Confirm current state before scaling", command: `oc get deployment ${dep} -n ${ns}`, dryRunCmd: `oc get deployment ${dep} -n ${ns}`, rollbackCmd: null, critical: false },
      { title: "Verify resource quota allows scaling", description: "Check namespace quota", command: `oc get resourcequota -n ${ns}`, dryRunCmd: `oc get resourcequota -n ${ns}`, rollbackCmd: null, critical: true },
      { title: "Scale deployment", description: `Set replicas to ${replicas}`, command: `oc scale deployment ${dep} -n ${ns} --replicas=${replicas}`, dryRunCmd: `oc scale deployment ${dep} -n ${ns} --replicas=${replicas} --dry-run=client`, rollbackCmd: `oc scale deployment ${dep} -n ${ns} --replicas=<previous>`, critical: true },
      { title: "Verify rollout completion", description: "Wait for all pods Ready", command: `oc rollout status deployment ${dep} -n ${ns}`, dryRunCmd: null, rollbackCmd: null, critical: true },
    ],
  };
}

function templateGeneric(goal, ctx) {
  return {
    name: "generic",
    steps: [
      { title: "Plan the approach", description: `Decompose the goal: ${goal}`, command: null, dryRunCmd: null, rollbackCmd: null, critical: false, manual: true },
      { title: "Execute first action", description: "Define and run the first concrete step", command: null, dryRunCmd: null, rollbackCmd: null, critical: false, manual: true },
      { title: "Verify result", description: "Confirm intended outcome", command: null, dryRunCmd: null, rollbackCmd: null, critical: false, manual: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// Plan operations
// ---------------------------------------------------------------------------

export function getPlan(planId) {
  return _plans.get(planId) || null;
}

export function listPlans({ userId, status, limit = 20 } = {}) {
  return Array.from(_plans.values())
    .filter((p) => (!userId || p.userId === userId) && (!status || p.status === status))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, limit);
}

export async function approvePlan(planId) {
  const plan = _plans.get(planId);
  if (!plan) return null;
  plan.status = "approved";
  plan.updatedAt = new Date().toISOString();
  persistPlan(plan).catch(() => {});
  return plan;
}

export async function markStepStatus(planId, stepId, status, result = {}) {
  const plan = _plans.get(planId);
  if (!plan) return null;
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) return null;
  step.status = status; // pending | running | completed | failed | skipped
  if (result.output != null) step.output = String(result.output).slice(0, 2000);
  if (result.error != null) step.error = String(result.error).slice(0, 2000);
  if (result.exitCode != null) step.exitCode = result.exitCode;
  step.updatedAt = new Date().toISOString();
  plan.updatedAt = new Date().toISOString();

  // Auto-update plan status
  const allDone = plan.steps.every((s) => s.status === "completed" || s.status === "skipped");
  const anyFailed = plan.steps.some((s) => s.status === "failed");
  if (allDone && !anyFailed) plan.status = "completed";
  else if (anyFailed) plan.status = "failed";
  else if (plan.steps.some((s) => s.status === "running")) plan.status = "executing";

  persistPlan(plan).catch(() => {});
  return plan;
}

export async function rollbackPlan(planId) {
  const plan = _plans.get(planId);
  if (!plan) return null;
  const rollbackSteps = [];
  // Walk steps in REVERSE order, running rollback commands for completed steps
  for (let i = plan.steps.length - 1; i >= 0; i--) {
    const step = plan.steps[i];
    if (step.status === "completed" && step.rollbackCmd) {
      rollbackSteps.push({
        stepId: step.id,
        title: `Rollback: ${step.title}`,
        command: step.rollbackCmd,
      });
    }
  }
  plan.status = "rolled_back";
  plan.rollbackInitiatedAt = new Date().toISOString();
  plan.updatedAt = new Date().toISOString();
  persistPlan(plan).catch(() => {});
  return { plan, rollbackSteps };
}

async function persistPlan(plan) {
  await ensurePlanSchema();
  if (!(await isEnabled())) return;
  try {
    await query(
      `INSERT INTO plans (id, goal, user_id, conversation_id, status, steps, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         steps = EXCLUDED.steps,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [plan.id, plan.goal, plan.userId, plan.conversationId, plan.status,
       JSON.stringify(plan.steps), plan.metadata ? JSON.stringify(plan.metadata) : null]
    );
  } catch (err) {
    // silent
  }
}

/**
 * Render a plan as a markdown @@PLAN tag for the chat UI to display.
 */
export function renderPlanTag(plan) {
  const data = {
    id: plan.id,
    goal: plan.goal,
    template: plan.template,
    status: plan.status,
    steps: plan.steps.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      status: s.status,
      command: s.command,
      critical: s.critical,
      requiresExplicitApproval: s.requiresExplicitApproval,
      hasRollback: !!s.rollbackCmd,
    })),
  };
  return "@@PLAN|" + JSON.stringify(data).replace(/@@/g, "@ @") + "@@";
}
