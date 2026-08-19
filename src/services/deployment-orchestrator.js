/**
 * Deployment Orchestrator — applies manifests in order, waits for the rollout
 * to complete, runs the verification pyramid, and auto-rollbacks on failure.
 *
 * Apply goes through server-side apply (deploy-verifier), so a re-deploy of a
 * changed document UPDATES the running resources instead of treating a 409 as
 * success and validating the old spec. Deployment records write through to
 * Postgres (doc-deploy-store) so history and the rollback ledger survive a
 * pod restart.
 */

import { ocpPost, ocpGet, ocpFetch } from "../utils/openshift-client.js";
import { recordChangeEvent } from "./change-timeline.js";
import { applyResource, rolloutStatus, verifyNamespace, kindPath } from "./deploy-verifier.js";
import { recordDeployment, updateDeployment, getDeploymentRecord, listDeploymentRecords } from "./doc-deploy-store.js";

const _deployments = new Map();
let _deployIdCounter = 1;

// Fire-and-forget write-through; the in-memory Map stays the source of truth
// within one process lifetime.
function persistDep(dep) {
  recordDeployment({
    id: dep.id, namespace: dep.ais?.namespace, appName: dep.ais?.appName,
    status: dep.status, orchestrated: true,
    applied: dep.createdResources, steps: dep.steps, error: dep.error,
    createdAt: dep.startedAt || undefined,
  }).catch(() => {});
}

/**
 * Start a deployment from generated manifests.
 * Returns a deployment ID for tracking.
 */
export function createDeployment(ais, manifests) {
  const id = `deploy-${Date.now()}-${_deployIdCounter++}`;
  const deployment = {
    id,
    ais,
    manifests,
    status: "pending",
    steps: [],
    startedAt: null,
    completedAt: null,
    error: null,
    createdResources: [],
  };
  _deployments.set(id, deployment);
  if (_deployments.size > 50) {
    const oldest = [..._deployments.keys()][0];
    _deployments.delete(oldest);
  }
  persistDep(deployment);
  return id;
}

/**
 * Execute a deployment step by step.
 */
export async function executeDeployment(deployId) {
  const dep = _deployments.get(deployId);
  if (!dep) throw new Error("Deployment not found: " + deployId);

  dep.status = "running";
  dep.startedAt = new Date().toISOString();

  const ns = dep.ais.namespace;
  const orderedManifests = orderManifests(dep.manifests, dep.ais);

  try {
    for (const manifest of orderedManifests) {
      const step = {
        kind: manifest.kind,
        name: manifest.name,
        status: "applying",
        startedAt: new Date().toISOString(),
        message: "",
      };
      dep.steps.push(step);

      try {
        const { action } = await applyManifest(manifest, ns);
        // The action matters at rollback time: only resources this deployment
        // CREATED may be deleted. Updated ones existed before us.
        dep.createdResources.push({ kind: manifest.kind, name: manifest.name, namespace: ns, action });
        step.status = "applied";
        step.message = `${manifest.kind}/${manifest.name} ${action}`;

        if (manifest.kind === "Deployment") {
          step.status = "waiting";
          step.message = "Waiting for pods to become Ready...";
          await waitForDeploymentReady(manifest.name, ns, 180);
          step.status = "ready";
          step.message = `${manifest.name}: all pods Ready`;
        }

        if (manifest.kind === "Job") {
          step.status = "waiting";
          step.message = "Waiting for job to complete...";
          await waitForJobComplete(manifest.name, ns, 120);
          step.status = "completed";
          step.message = `${manifest.name}: job completed`;
        }

        step.completedAt = new Date().toISOString();
      } catch (err) {
        step.status = "failed";
        step.message = err.message;
        step.completedAt = new Date().toISOString();
        throw err;
      }
    }

    dep.status = "validating";
    const valResults = await runValidation(dep.ais, ns);
    dep.steps.push({
      kind: "Validation",
      name: "post-deploy-checks",
      status: valResults.passed ? "passed" : "failed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      message: valResults.summary,
      details: valResults.results,
    });

    if (!valResults.passed) {
      throw new Error("Post-deployment validation failed: " + valResults.summary);
    }

    dep.status = "completed";
    dep.completedAt = new Date().toISOString();
    persistDep(dep);

    recordChangeEvent({
      source: "deployment",
      eventType: "doc_deploy_success",
      namespace: ns,
      resourceKind: "Application",
      resourceName: dep.ais.appName,
      title: `Document-driven deploy: ${dep.ais.appName} (${dep.ais.tiers.length} tiers)`,
      details: { deployId, tiers: dep.ais.tiers.map((t) => t.name), duration: Date.now() - new Date(dep.startedAt).getTime() },
      severity: "info",
    }).catch(() => {});

    return dep;
  } catch (err) {
    dep.status = "failed";
    dep.error = err.message;
    dep.completedAt = new Date().toISOString();
    persistDep(dep);

    recordChangeEvent({
      source: "deployment",
      eventType: "doc_deploy_failed",
      namespace: ns,
      resourceKind: "Application",
      resourceName: dep.ais.appName,
      title: `Deploy FAILED: ${dep.ais.appName} — ${err.message}`,
      details: { deployId, error: err.message },
      severity: "critical",
    }).catch(() => {});

    return dep;
  }
}

/**
 * Rollback a deployment — delete all created resources in reverse order.
 */
export async function rollbackDeployment(deployId) {
  const dep = _deployments.get(deployId);
  if (!dep) throw new Error("Deployment not found: " + deployId);

  dep.status = "rolling_back";
  const errors = [];

  // Only what this deployment CREATED may be deleted. A resource we merely
  // updated existed before us, and deleting it would take out someone else's
  // workload in the name of "rollback".
  const created = dep.createdResources.filter((r) => !r.action || r.action === "created");
  const updatedCount = dep.createdResources.length - created.length;
  if (updatedCount > 0) {
    dep.steps.push({
      kind: "Rollback", name: "pre-existing-resources", status: "skipped",
      message: `${updatedCount} resource(s) existed before this deployment and were left in place`,
      completedAt: new Date().toISOString(),
    });
  }

  const reversed = [...created].reverse();
  for (const res of reversed) {
    if (res.kind === "Namespace") continue; // handled last, below
    try {
      const path = getDeletePath(res.kind, res.name, res.namespace);
      if (path) {
        await ocpFetch(path, { method: "DELETE" });
        dep.steps.push({
          kind: "Rollback",
          name: res.name,
          status: "deleted",
          message: `Deleted ${res.kind}/${res.name}`,
          completedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      errors.push(`Failed to delete ${res.kind}/${res.name}: ${err.message}`);
    }
  }

  // The namespace goes only if WE created it. Deleting a pre-existing
  // namespace would destroy every unrelated workload inside it.
  const nsCreated = created.some((r) => r.kind === "Namespace" && r.name === dep.ais.namespace);
  if (nsCreated) {
    try {
      await ocpFetch(`/api/v1/namespaces/${dep.ais.namespace}`, { method: "DELETE" });
      dep.steps.push({
        kind: "Rollback",
        name: dep.ais.namespace,
        status: "deleted",
        message: `Deleted namespace ${dep.ais.namespace}`,
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      errors.push(`Namespace delete: ${err.message}`);
    }
  } else {
    dep.steps.push({
      kind: "Rollback", name: dep.ais.namespace, status: "skipped",
      message: `Namespace ${dep.ais.namespace} pre-existed this deployment — left in place`,
      completedAt: new Date().toISOString(),
    });
  }

  dep.status = errors.length > 0 ? "rollback_partial" : "rolled_back";
  dep.completedAt = new Date().toISOString();
  persistDep(dep);

  recordChangeEvent({
    source: "deployment",
    eventType: "doc_deploy_rollback",
    namespace: dep.ais.namespace,
    resourceKind: "Application",
    resourceName: dep.ais.appName,
    title: `Rollback: ${dep.ais.appName}`,
    details: { deployId, errors },
    severity: "warning",
  }).catch(() => {});

  return dep;
}

export function getDeployment(id) {
  return _deployments.get(id) || null;
}

/**
 * Like getDeployment, but falls back to the persistent record when the
 * process has restarted since the deploy ran. The record carries steps,
 * applied resources and final status — enough for status and audit.
 */
export async function getDeploymentAnywhere(id) {
  return _deployments.get(id) || (await getDeploymentRecord(id).catch(() => null));
}

export function listDeployments() {
  return [..._deployments.values()].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
}

/** History across restarts: persistent records, merged with the live Map. */
export async function listDeploymentsAnywhere(limit = 20) {
  const live = listDeployments();
  const stored = await listDeploymentRecords({ limit }).catch(() => []);
  const seen = new Set(live.map((d) => d.id));
  return [...live, ...stored.filter((d) => !seen.has(d.id))].slice(0, limit);
}

function orderManifests(manifests, ais) {
  const kindOrder = ["Namespace", "Secret", "ConfigMap", "PersistentVolumeClaim", "Deployment", "Job", "Service", "Route", "Ingress", "HorizontalPodAutoscaler", "NetworkPolicy"];

  const deployOrder = ais.deployOrder || [];
  return [...manifests].sort((a, b) => {
    const aIdx = kindOrder.indexOf(a.kind);
    const bIdx = kindOrder.indexOf(b.kind);
    if (aIdx !== bIdx) return aIdx - bIdx;
    if (a.kind === "Deployment" || a.kind === "Service") {
      const aOrder = deployOrder.indexOf(a.name);
      const bOrder = deployOrder.indexOf(b.name);
      if (aOrder !== -1 && bOrder !== -1) return aOrder - bOrder;
    }
    return 0;
  });
}

async function applyManifest(manifest, ns) {
  const json = manifest.json;
  const kind = json.kind;

  // Server-side apply: creates or updates, and never mistakes "it already
  // existed with the OLD spec" for success the way POST-then-swallow-409 did.
  const path = kind === "Namespace" ? "/api/v1/namespaces" : kindPath(kind, ns);
  if (!path) throw new Error(`Unknown resource kind: ${kind}`);
  return applyResource(path, json);
}

async function waitForDeploymentReady(name, ns, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      // Uncached read — ocpGet's 5s cache would replay a pre-rollout status.
      const dep = await ocpFetch(`/apis/apps/v1/namespaces/${ns}/deployments/${name}`);
      // Rollout completion, not readiness: on a re-deploy the OLD pods are
      // still Ready, so a readiness check passes before anything happened.
      last = rolloutStatus(dep);
      if (last.ok) return;
    } catch {
      // Ignore transient errors while polling
    }
    await sleep(3000);
  }
  throw new Error(`Deployment ${name} rollout did not complete within ${timeoutSec}s${last ? ` — ${last.summary}` : ""}`);
}

async function waitForJobComplete(name, ns, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const job = await ocpGet(`/apis/batch/v1/namespaces/${ns}/jobs/${name}`);
      if (job.status?.succeeded >= 1) return;
      if (job.status?.failed >= (job.spec?.backoffLimit || 3)) {
        throw new Error(`Job ${name} exceeded backoff limit`);
      }
    } catch (err) {
      if (err.message.includes("exceeded backoff")) throw err;
    }
    await sleep(5000);
  }
  throw new Error(`Job ${name} did not complete within ${timeoutSec}s`);
}

async function runValidation(ais, ns) {
  // The verification pyramid: rollout completion → workload stability →
  // Service/endpoint wiring → an HTTP probe of every Route. "Pods Ready" is a
  // claim about containers; these levels are claims about the application.
  const v = await verifyNamespace(ns);
  const results = v.levels.flatMap((l) =>
    l.checks.map((c) => ({ test: `[${l.title}] ${c.name}: ${c.detail}`, passed: c.passed }))
  );
  const failedLevels = v.levels.filter((l) => !l.passed).map((l) => l.title);
  return {
    passed: v.passed,
    results,
    access: v.access,
    summary: v.passed
      ? `All ${v.levels.length} verification levels passed${v.access.length ? ` — application reachable at ${v.access.map((a) => a.url).join(", ")}` : ""}`
      : `Failed at: ${failedLevels.join(", ")}`,
  };
}

function getDeletePath(kind, name, ns) {
  const paths = {
    Deployment: `/apis/apps/v1/namespaces/${ns}/deployments/${name}`,
    Service: `/api/v1/namespaces/${ns}/services/${name}`,
    Route: `/apis/route.openshift.io/v1/namespaces/${ns}/routes/${name}`,
    Ingress: `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${name}`,
    Job: `/apis/batch/v1/namespaces/${ns}/jobs/${name}`,
    PersistentVolumeClaim: `/api/v1/namespaces/${ns}/persistentvolumeclaims/${name}`,
    ConfigMap: `/api/v1/namespaces/${ns}/configmaps/${name}`,
    Secret: `/api/v1/namespaces/${ns}/secrets/${name}`,
    NetworkPolicy: `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/${name}`,
    HorizontalPodAutoscaler: `/apis/autoscaling/v2/namespaces/${ns}/horizontalpodautoscalers/${name}`,
  };
  return paths[kind] || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
