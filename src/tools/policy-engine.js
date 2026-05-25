import { randomUUID } from "node:crypto";
import { ocpGet } from "../utils/openshift-client.js";
import { query as dbQuery } from "../utils/db.js";

const DB_KEY = "custom_policies";

const VALID_RULE_TYPES = new Set([
  "required-labels",
  "forbidden-image-registries",
  "required-resource-limits",
  "required-probes",
  "max-replicas",
  "custom-rego",
]);

const VALID_SEVERITIES = new Set(["critical", "warning", "info"]);

const SYSTEM_NS_PREFIXES = ["openshift-", "kube-"];
const SYSTEM_NS_EXACT = new Set(["default", "kube-system", "kube-public", "kube-node-lease"]);

function isSystemNamespace(ns) {
  if (SYSTEM_NS_EXACT.has(ns)) return true;
  return SYSTEM_NS_PREFIXES.some((prefix) => ns.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------
const _policies = new Map();

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
async function persist() {
  try {
    const data = Array.from(_policies.values());
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [DB_KEY, JSON.stringify(data)]
    );
  } catch {
    // Best-effort persistence — the in-memory store remains authoritative
  }
}

/**
 * Load persisted policies from PostgreSQL into memory.
 * Safe to call multiple times; subsequent calls re-sync from DB.
 * @returns {Promise<number>} Number of policies loaded.
 */
export async function loadPolicies() {
  try {
    const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [DB_KEY]);
    if (result?.rows?.length > 0) {
      const stored = result.rows[0].value;
      const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
      if (Array.isArray(parsed)) {
        _policies.clear();
        for (const p of parsed) {
          if (p.id) _policies.set(p.id, p);
        }
      }
    }
  } catch {
    // Non-critical — start with whatever is already in memory
  }
  return _policies.size;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Return all custom policies.
 * @returns {object[]} Array of policy definitions.
 */
export function getPolicies() {
  return Array.from(_policies.values());
}

/**
 * Return a single policy by ID.
 * @param {string} id - Policy UUID.
 * @returns {object|undefined} The policy, or undefined if not found.
 */
export function getPolicy(id) {
  return _policies.get(id);
}

/**
 * Create a new custom policy and persist it.
 * @param {object} policyDef - Partial policy definition (name, description, ruleType, config, etc.).
 * @returns {Promise<object>} The fully-formed policy object.
 */
export async function createPolicy(policyDef) {
  const { name, ruleType } = policyDef;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Policy name is required");
  }
  if (!ruleType || !VALID_RULE_TYPES.has(ruleType)) {
    throw new Error(`Invalid ruleType '${ruleType}'. Must be one of: ${[...VALID_RULE_TYPES].join(", ")}`);
  }

  const severity = policyDef.severity || "warning";
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(`Invalid severity '${severity}'. Must be one of: ${[...VALID_SEVERITIES].join(", ")}`);
  }

  const now = new Date().toISOString();
  const policy = {
    id: randomUUID(),
    name: name.trim(),
    description: policyDef.description || "",
    enabled: policyDef.enabled !== false,
    severity,
    category: policyDef.category || "pod-security",
    ruleType,
    config: policyDef.config || {},
    namespaces: Array.isArray(policyDef.namespaces) ? policyDef.namespaces : ["*"],
    createdAt: now,
    updatedAt: now,
  };

  _policies.set(policy.id, policy);
  await persist();
  return policy;
}

/**
 * Update an existing policy and persist changes.
 * @param {string} id - Policy UUID.
 * @param {object} updates - Fields to update.
 * @returns {Promise<object>} The updated policy object.
 */
export async function updatePolicy(id, updates) {
  const existing = _policies.get(id);
  if (!existing) {
    throw new Error(`Policy '${id}' not found`);
  }

  if (updates.ruleType !== undefined && !VALID_RULE_TYPES.has(updates.ruleType)) {
    throw new Error(`Invalid ruleType '${updates.ruleType}'`);
  }
  if (updates.severity !== undefined && !VALID_SEVERITIES.has(updates.severity)) {
    throw new Error(`Invalid severity '${updates.severity}'`);
  }

  const immutableKeys = new Set(["id", "createdAt"]);
  for (const [key, value] of Object.entries(updates)) {
    if (immutableKeys.has(key)) continue;
    existing[key] = value;
  }
  existing.updatedAt = new Date().toISOString();

  _policies.set(id, existing);
  await persist();
  return existing;
}

/**
 * Delete a policy by ID and persist the change.
 * @param {string} id - Policy UUID.
 * @returns {Promise<boolean>} True if the policy existed and was deleted.
 */
export async function deletePolicy(id) {
  const existed = _policies.delete(id);
  if (existed) await persist();
  return existed;
}

// ---------------------------------------------------------------------------
// Finding builder (compatible with compliance-scanner format)
// ---------------------------------------------------------------------------
function finding({ id, category, title, severity, status, namespace, resource, description, remediation }) {
  return {
    id,
    category,
    title,
    severity,
    status,
    namespace: namespace || "",
    resource: resource || "",
    description,
    remediation,
  };
}

// ---------------------------------------------------------------------------
// Namespace matching
// ---------------------------------------------------------------------------
function policyMatchesNamespace(policy, ns) {
  if (policy.namespaces.includes("*")) return true;
  return policy.namespaces.includes(ns);
}

// ---------------------------------------------------------------------------
// Built-in rule evaluators
// ---------------------------------------------------------------------------

async function fetchPodsForEvaluation() {
  const data = await ocpGet("/api/v1/pods");
  return (data.items || []).filter(
    (p) => !isSystemNamespace(p.metadata.namespace) && p.status?.phase === "Running"
  );
}

async function fetchDeploymentsForEvaluation() {
  const data = await ocpGet("/apis/apps/v1/deployments");
  return (data.items || []).filter(
    (d) => !isSystemNamespace(d.metadata.namespace)
  );
}

function evaluateRequiredLabels(policy, pods) {
  const findings = [];
  const requiredLabels = policy.config?.labels || [];
  if (requiredLabels.length === 0) return findings;

  for (const pod of pods) {
    const ns = pod.metadata.namespace;
    if (!policyMatchesNamespace(policy, ns)) continue;

    const podLabels = pod.metadata.labels || {};
    const missing = requiredLabels.filter((l) => !(l in podLabels));
    if (missing.length > 0) {
      findings.push(
        finding({
          id: `policy-${policy.id}`,
          category: policy.category,
          title: `Missing required labels: ${missing.join(", ")}`,
          severity: policy.severity,
          status: "FAIL",
          namespace: ns,
          resource: pod.metadata.name,
          description: `Pod '${pod.metadata.name}' is missing required label(s): ${missing.join(", ")}. Policy: ${policy.name}.`,
          remediation: `Add the missing labels (${missing.join(", ")}) to the pod template metadata.`,
        })
      );
    }
  }
  return findings;
}

function evaluateForbiddenImageRegistries(policy, pods) {
  const findings = [];
  const forbidden = policy.config?.registries || [];
  if (forbidden.length === 0) return findings;

  for (const pod of pods) {
    const ns = pod.metadata.namespace;
    if (!policyMatchesNamespace(policy, ns)) continue;

    const containers = [...(pod.spec?.containers || []), ...(pod.spec?.initContainers || [])];
    for (const c of containers) {
      const image = c.image || "";
      const matchedRegistry = forbidden.find((reg) => image.startsWith(reg + "/") || image.startsWith(reg));
      if (matchedRegistry) {
        findings.push(
          finding({
            id: `policy-${policy.id}`,
            category: policy.category,
            title: `Forbidden image registry: ${matchedRegistry}`,
            severity: policy.severity,
            status: "FAIL",
            namespace: ns,
            resource: `${pod.metadata.name}/${c.name}`,
            description: `Container '${c.name}' in pod '${pod.metadata.name}' uses image '${image}' from forbidden registry '${matchedRegistry}'. Policy: ${policy.name}.`,
            remediation: `Use an image from an approved registry instead of '${matchedRegistry}'.`,
          })
        );
      }
    }
  }
  return findings;
}

function evaluateRequiredResourceLimits(policy, pods) {
  const findings = [];

  for (const pod of pods) {
    const ns = pod.metadata.namespace;
    if (!policyMatchesNamespace(policy, ns)) continue;

    const containers = [...(pod.spec?.containers || []), ...(pod.spec?.initContainers || [])];
    for (const c of containers) {
      const limits = c.resources?.limits || {};
      const missing = [];
      if (!limits.cpu) missing.push("cpu");
      if (!limits.memory) missing.push("memory");

      if (missing.length > 0) {
        findings.push(
          finding({
            id: `policy-${policy.id}`,
            category: policy.category,
            title: `Missing resource limits: ${missing.join(", ")}`,
            severity: policy.severity,
            status: "FAIL",
            namespace: ns,
            resource: `${pod.metadata.name}/${c.name}`,
            description: `Container '${c.name}' in pod '${pod.metadata.name}' is missing ${missing.join(" and ")} resource limits. Policy: ${policy.name}.`,
            remediation: `Set resources.limits.${missing.join(" and resources.limits.")} in the container spec.`,
          })
        );
      }
    }
  }
  return findings;
}

function evaluateRequiredProbes(policy, pods) {
  const findings = [];
  const requiredTypes = policy.config?.types || ["readiness", "liveness"];

  for (const pod of pods) {
    const ns = pod.metadata.namespace;
    if (!policyMatchesNamespace(policy, ns)) continue;

    const containers = pod.spec?.containers || [];
    for (const c of containers) {
      const missing = [];
      if (requiredTypes.includes("readiness") && !c.readinessProbe) missing.push("readinessProbe");
      if (requiredTypes.includes("liveness") && !c.livenessProbe) missing.push("livenessProbe");

      if (missing.length > 0) {
        findings.push(
          finding({
            id: `policy-${policy.id}`,
            category: policy.category,
            title: `Missing probes: ${missing.join(", ")}`,
            severity: policy.severity,
            status: "FAIL",
            namespace: ns,
            resource: `${pod.metadata.name}/${c.name}`,
            description: `Container '${c.name}' in pod '${pod.metadata.name}' is missing ${missing.join(" and ")}. Policy: ${policy.name}.`,
            remediation: `Add ${missing.join(" and ")} to the container spec for health monitoring.`,
          })
        );
      }
    }
  }
  return findings;
}

function evaluateMaxReplicas(policy, deployments) {
  const findings = [];
  const max = policy.config?.max ?? 50;

  for (const deploy of deployments) {
    const ns = deploy.metadata.namespace;
    if (!policyMatchesNamespace(policy, ns)) continue;

    const replicas = deploy.spec?.replicas ?? 1;
    if (replicas > max) {
      findings.push(
        finding({
          id: `policy-${policy.id}`,
          category: policy.category,
          title: `Replica count exceeds maximum (${replicas} > ${max})`,
          severity: policy.severity,
          status: "FAIL",
          namespace: ns,
          resource: deploy.metadata.name,
          description: `Deployment '${deploy.metadata.name}' has ${replicas} replicas, exceeding the maximum of ${max}. Policy: ${policy.name}.`,
          remediation: `Reduce the replica count to ${max} or below, or adjust the policy threshold.`,
        })
      );
    }
  }
  return findings;
}

/**
 * Evaluate simple OPA-style match conditions against pods.
 * Supports a flat list of conditions like:
 *   { "match": [{ "path": "spec.hostNetwork", "value": true }] }
 * Each condition checks a dot-separated path on the pod object.
 * This is intentionally minimal — not a full Rego VM.
 */
function evaluateCustomRego(policy, pods) {
  const findings = [];
  const conditions = policy.config?.match;
  if (!Array.isArray(conditions) || conditions.length === 0) return findings;

  for (const pod of pods) {
    const ns = pod.metadata.namespace;
    if (!policyMatchesNamespace(policy, ns)) continue;

    for (const condition of conditions) {
      const { path, value } = condition;
      if (!path) continue;

      const actual = resolvePath(pod, path);
      const violated = value === undefined ? actual !== undefined : actual === value;

      if (violated) {
        findings.push(
          finding({
            id: `policy-${policy.id}`,
            category: policy.category,
            title: `Custom rule violation: ${path}`,
            severity: policy.severity,
            status: "FAIL",
            namespace: ns,
            resource: pod.metadata.name,
            description: `Pod '${pod.metadata.name}' matched condition: ${path} = ${JSON.stringify(actual)}. Policy: ${policy.name}.`,
            remediation: condition.remediation || `Ensure ${path} does not match the forbidden value.`,
          })
        );
      }
    }
  }
  return findings;
}

function resolvePath(obj, path) {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Policy evaluation orchestrator
// ---------------------------------------------------------------------------

const RULE_EVALUATORS_POD = new Map([
  ["required-labels", evaluateRequiredLabels],
  ["forbidden-image-registries", evaluateForbiddenImageRegistries],
  ["required-resource-limits", evaluateRequiredResourceLimits],
  ["required-probes", evaluateRequiredProbes],
  ["custom-rego", evaluateCustomRego],
]);

const RULE_EVALUATORS_DEPLOYMENT = new Map([
  ["max-replicas", evaluateMaxReplicas],
]);

/**
 * Evaluate all enabled custom policies against live cluster state.
 * @param {object} [options]
 * @param {string[]} [options.namespaces] - Limit evaluation to specific namespaces.
 * @param {string[]} [options.policyIds] - Evaluate only specific policies by ID.
 * @param {string[]} [options.categories] - Filter by policy category.
 * @returns {Promise<object[]>} Array of finding objects compatible with the compliance scanner.
 */
export async function evaluatePolicies(options = {}) {
  const enabled = Array.from(_policies.values()).filter((p) => {
    if (!p.enabled) return false;
    if (options.policyIds?.length && !options.policyIds.includes(p.id)) return false;
    if (options.categories?.length && !options.categories.includes(p.category)) return false;
    return true;
  });

  if (enabled.length === 0) return [];

  const needsPods = enabled.some((p) => RULE_EVALUATORS_POD.has(p.ruleType));
  const needsDeployments = enabled.some((p) => RULE_EVALUATORS_DEPLOYMENT.has(p.ruleType));

  const [pods, deployments] = await Promise.all([
    needsPods ? fetchPodsForEvaluation() : Promise.resolve([]),
    needsDeployments ? fetchDeploymentsForEvaluation() : Promise.resolve([]),
  ]);

  let filteredPods = pods;
  let filteredDeployments = deployments;
  if (options.namespaces?.length) {
    const nsSet = new Set(options.namespaces);
    filteredPods = pods.filter((p) => nsSet.has(p.metadata.namespace));
    filteredDeployments = deployments.filter((d) => nsSet.has(d.metadata.namespace));
  }

  const allFindings = [];

  for (const policy of enabled) {
    const podEvaluator = RULE_EVALUATORS_POD.get(policy.ruleType);
    if (podEvaluator) {
      allFindings.push(...podEvaluator(policy, filteredPods));
      continue;
    }

    const deployEvaluator = RULE_EVALUATORS_DEPLOYMENT.get(policy.ruleType);
    if (deployEvaluator) {
      allFindings.push(...deployEvaluator(policy, filteredDeployments));
    }
  }

  return allFindings;
}

// ---------------------------------------------------------------------------
// Cluster policy discovery (Gatekeeper + Kyverno)
// ---------------------------------------------------------------------------

/**
 * Fetch Gatekeeper ConstraintTemplates and Kyverno ClusterPolicies from the cluster.
 * Returns whatever is available — silently handles clusters that lack these CRDs.
 * @returns {Promise<object>} `{ gatekeeper: [...], kyverno: [...] }`
 */
export async function getClusterPolicies() {
  const [gatekeeper, kyverno] = await Promise.all([
    fetchGatekeeperConstraints(),
    fetchKyvernoPolicies(),
  ]);
  return { gatekeeper, kyverno };
}

async function fetchGatekeeperConstraints() {
  try {
    const templates = await ocpGet(
      "/apis/templates.gatekeeper.sh/v1/constrainttemplates"
    );
    return (templates.items || []).map((t) => ({
      name: t.metadata.name,
      kind: "ConstraintTemplate",
      description: t.metadata.annotations?.["description"] || "",
      targets: (t.spec?.targets || []).map((tgt) => tgt.target),
      crd: t.spec?.crd?.spec?.names?.kind || "",
      createdAt: t.metadata.creationTimestamp,
    }));
  } catch {
    return [];
  }
}

async function fetchKyvernoPolicies() {
  try {
    const policies = await ocpGet(
      "/apis/kyverno.io/v1/clusterpolicies"
    );
    return (policies.items || []).map((p) => ({
      name: p.metadata.name,
      kind: "ClusterPolicy",
      background: p.spec?.background ?? true,
      validationFailureAction: p.spec?.validationFailureAction || "audit",
      rules: (p.spec?.rules || []).map((r) => ({
        name: r.name,
        match: r.match,
        validate: r.validate ? { message: r.validate.message } : undefined,
      })),
      createdAt: p.metadata.creationTimestamp,
    }));
  } catch {
    return [];
  }
}
