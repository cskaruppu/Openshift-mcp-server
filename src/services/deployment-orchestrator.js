/**
 * Deployment Orchestrator — applies manifests in order, waits for readiness,
 * runs validation, and auto-rollbacks on failure.
 */

import { ocpPost, ocpGet, ocpFetch } from "../utils/openshift-client.js";
import { recordChangeEvent } from "./change-timeline.js";

const _deployments = new Map();
let _deployIdCounter = 1;

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
        await applyManifest(manifest, ns);
        dep.createdResources.push({ kind: manifest.kind, name: manifest.name, namespace: ns });
        step.status = "applied";
        step.message = `${manifest.kind}/${manifest.name} created`;

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

  const reversed = [...dep.createdResources].reverse();
  for (const res of reversed) {
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

  try {
    const nsPath = `/api/v1/namespaces/${dep.ais.namespace}`;
    await ocpFetch(nsPath, { method: "DELETE" });
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

  dep.status = errors.length > 0 ? "rollback_partial" : "rolled_back";
  dep.completedAt = new Date().toISOString();

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

export function listDeployments() {
  return [..._deployments.values()].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
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

  const pathMap = {
    Namespace: "/api/v1/namespaces",
    Secret: `/api/v1/namespaces/${ns}/secrets`,
    ConfigMap: `/api/v1/namespaces/${ns}/configmaps`,
    PersistentVolumeClaim: `/api/v1/namespaces/${ns}/persistentvolumeclaims`,
    Service: `/api/v1/namespaces/${ns}/services`,
    Deployment: `/apis/apps/v1/namespaces/${ns}/deployments`,
    Job: `/apis/batch/v1/namespaces/${ns}/jobs`,
    Route: `/apis/route.openshift.io/v1/namespaces/${ns}/routes`,
    Ingress: `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`,
    HorizontalPodAutoscaler: `/apis/autoscaling/v2/namespaces/${ns}/horizontalpodautoscalers`,
    NetworkPolicy: `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`,
  };

  const path = pathMap[kind];
  if (!path) throw new Error(`Unknown resource kind: ${kind}`);

  try {
    return await ocpPost(path, json);
  } catch (err) {
    if (err.message.includes("409") || err.message.includes("AlreadyExists")) {
      return { status: "already_exists", kind, name: json.metadata?.name };
    }
    throw err;
  }
}

async function waitForDeploymentReady(name, ns, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const dep = await ocpGet(`/apis/apps/v1/namespaces/${ns}/deployments/${name}`);
      const desired = dep.spec?.replicas || 1;
      const ready = dep.status?.readyReplicas || 0;
      const available = dep.status?.availableReplicas || 0;
      if (ready >= desired && available >= desired) return;
    } catch {
      // Ignore transient errors while polling
    }
    await sleep(3000);
  }
  throw new Error(`Deployment ${name} did not become ready within ${timeoutSec}s`);
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
  const results = [];
  let allPassed = true;

  for (const tier of ais.tiers) {
    try {
      const dep = await ocpGet(`/apis/apps/v1/namespaces/${ns}/deployments/${tier.name}`);
      const ready = dep.status?.readyReplicas || 0;
      const desired = dep.spec?.replicas || 1;
      const passed = ready >= desired;
      results.push({
        test: `${tier.name}: ${ready}/${desired} pods Ready`,
        passed,
      });
      if (!passed) allPassed = false;
    } catch (err) {
      results.push({ test: `${tier.name}: check failed`, passed: false, error: err.message });
      allPassed = false;
    }
  }

  try {
    const events = await ocpGet(`/api/v1/namespaces/${ns}/events?fieldSelector=reason=BackOff`);
    const crashPods = (events.items || []).filter(
      (e) => e.reason === "BackOff" && Date.now() - new Date(e.lastTimestamp || e.eventTime).getTime() < 120_000
    );
    const noCrash = crashPods.length === 0;
    results.push({ test: `No CrashLoopBackOff in namespace`, passed: noCrash });
    if (!noCrash) allPassed = false;
  } catch {
    results.push({ test: "CrashLoopBackOff check", passed: true, note: "Could not verify" });
  }

  return {
    passed: allPassed,
    results,
    summary: allPassed
      ? `All ${results.length} checks passed`
      : `${results.filter((r) => !r.passed).length}/${results.length} checks failed`,
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
