/**
 * Deploy verifier — the production-grade core shared by the Automation Hub
 * deploy endpoint and the document-deployment orchestrator.
 *
 * Two responsibilities:
 *
 *  1. applyResource() — create-or-update via server-side apply, classified as
 *     created / configured / unchanged the way `kubectl apply` reports it.
 *     POST-then-409 semantics silently keep the old spec on re-deploys, and
 *     merge-patch cannot remove fields a new manifest dropped; SSA does both
 *     correctly and works identically under ?dryRun=All.
 *
 *  2. verifyNamespace() — the verification pyramid. "Pods Ready" is a claim
 *     about containers, not about the application the user asked for, so each
 *     level answers a stronger question than the one below it:
 *       rollout   — is THIS generation fully rolled out? (kubectl rollout status)
 *       stability — is anything crash-looping or restarting?
 *       wiring    — does every Service actually select pods? (catches the
 *                   label/selector mismatch behind most "Route says 503" cases)
 *       access    — does the Route answer over HTTP from outside the app?
 *     The access level is the user's acceptance test: the URL they can open.
 */

import { ocpFetch } from "../utils/openshift-client.js";
import { Agent } from "undici";

const FIELD_MANAGER = "tcs-automation-hub";

// ── kind routing (shared by deploy, rollback and the orchestrator) ──────────

/** REST collection path for a namespaced kind, or null when unsupported. */
export function kindPath(kind, ns) {
  return {
    deployment: `/apis/apps/v1/namespaces/${ns}/deployments`,
    statefulset: `/apis/apps/v1/namespaces/${ns}/statefulsets`,
    daemonset: `/apis/apps/v1/namespaces/${ns}/daemonsets`,
    service: `/api/v1/namespaces/${ns}/services`,
    route: `/apis/route.openshift.io/v1/namespaces/${ns}/routes`,
    ingress: `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`,
    configmap: `/api/v1/namespaces/${ns}/configmaps`,
    secret: `/api/v1/namespaces/${ns}/secrets`,
    persistentvolumeclaim: `/api/v1/namespaces/${ns}/persistentvolumeclaims`,
    serviceaccount: `/api/v1/namespaces/${ns}/serviceaccounts`,
    horizontalpodautoscaler: `/apis/autoscaling/v2/namespaces/${ns}/horizontalpodautoscalers`,
    role: `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles`,
    rolebinding: `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`,
    networkpolicy: `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`,
    resourcequota: `/api/v1/namespaces/${ns}/resourcequotas`,
    limitrange: `/api/v1/namespaces/${ns}/limitranges`,
    servicemonitor: `/apis/monitoring.coreos.com/v1/namespaces/${ns}/servicemonitors`,
    poddisruptionbudget: `/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets`,
    cronjob: `/apis/batch/v1/namespaces/${ns}/cronjobs`,
    job: `/apis/batch/v1/namespaces/${ns}/jobs`,
  }[(kind || "").toLowerCase()] || null;
}

/** Canonical apiVersion per kind — must match the REST path we apply to. */
export function kindApiVersion(kind) {
  return {
    namespace: "v1", service: "v1", configmap: "v1", secret: "v1",
    persistentvolumeclaim: "v1", serviceaccount: "v1", resourcequota: "v1", limitrange: "v1",
    deployment: "apps/v1", statefulset: "apps/v1", daemonset: "apps/v1",
    route: "route.openshift.io/v1", ingress: "networking.k8s.io/v1", networkpolicy: "networking.k8s.io/v1",
    horizontalpodautoscaler: "autoscaling/v2",
    role: "rbac.authorization.k8s.io/v1", rolebinding: "rbac.authorization.k8s.io/v1",
    servicemonitor: "monitoring.coreos.com/v1", poddisruptionbudget: "policy/v1",
    cronjob: "batch/v1", job: "batch/v1",
  }[(kind || "").toLowerCase()] || null;
}

/** Dependency-safe apply order: namespace → policy/rbac/config → workloads → exposure. */
export function applyRank(kind) {
  return {
    namespace: 0,
    resourcequota: 1, limitrange: 1, networkpolicy: 1,
    serviceaccount: 2, role: 3, rolebinding: 4,
    secret: 2, configmap: 2, persistentvolumeclaim: 2,
    deployment: 6, statefulset: 6, daemonset: 6, cronjob: 6, job: 6,
    service: 5, route: 7, ingress: 7, horizontalpodautoscaler: 7,
    servicemonitor: 7, poddisruptionbudget: 7,
  }[(kind || "").toLowerCase()] ?? 5;
}

// ── server-side apply ───────────────────────────────────────────────────────

/**
 * Create-or-update one resource with server-side apply.
 * `collectionPath` is the REST collection (…/namespaces/<ns>/deployments).
 * Returns { action: "created"|"configured"|"unchanged", object }.
 * Throws on API errors other than the initial existence probe.
 */
export async function applyResource(collectionPath, manifest, { dryRun = false } = {}) {
  const name = manifest?.metadata?.name;
  if (!name) throw new Error(`${manifest?.kind || "resource"}: metadata.name is required`);

  // Uncached read — ocpGet's 5s cache would misclassify a rapid re-deploy.
  let prior = null;
  try {
    prior = await ocpFetch(`${collectionPath}/${name}`);
  } catch (e) {
    if (!/404|NotFound/i.test(e.message || "")) throw e;
  }

  const q = `?fieldManager=${FIELD_MANAGER}&force=true` + (dryRun ? "&dryRun=All" : "");
  // Never send another manager's bookkeeping back at the server.
  const body = { ...manifest, metadata: { ...manifest.metadata } };
  delete body.metadata.managedFields;
  delete body.metadata.resourceVersion;

  const object = await ocpFetch(`${collectionPath}/${name}${q}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/apply-patch+yaml" },
    body: JSON.stringify(body),
  });

  return { action: classifyApply(prior, object, { dryRun }), object };
}

/**
 * Pure classification of an apply outcome.
 * A dry-run never bumps resourceVersion, so an existing object can only be
 * reported as "configured (dry-run)" — we know it exists, not whether it
 * would change.
 */
export function classifyApply(prior, result, { dryRun = false } = {}) {
  if (!prior) return "created";
  if (dryRun) return "configured";
  const before = prior?.metadata?.resourceVersion;
  const after = result?.metadata?.resourceVersion;
  return before && after && before === after ? "unchanged" : "configured";
}

// ── rollout semantics ───────────────────────────────────────────────────────

/**
 * Pure `kubectl rollout status` verdict for a Deployment / StatefulSet /
 * DaemonSet object. Readiness alone passes against the OLD pods for the first
 * seconds after a spec change — this requires the rollout itself to be done.
 * Returns { ok, summary }.
 */
export function rolloutStatus(obj) {
  if (!obj) return { ok: false, summary: "object not found" };
  const kind = obj.kind || "workload";
  const name = obj.metadata?.name || "?";
  const st = obj.status || {};

  const gen = obj.metadata?.generation ?? 0;
  const observed = st.observedGeneration ?? 0;
  if (observed < gen) return { ok: false, summary: `${kind}/${name}: controller has not observed the change yet (generation ${observed}/${gen})` };

  if (kind === "DaemonSet") {
    const want = st.desiredNumberScheduled ?? 0;
    const updated = st.updatedNumberScheduled ?? 0;
    const ready = st.numberReady ?? 0;
    const unavailable = st.numberUnavailable ?? 0;
    if (want === 0) return { ok: false, summary: `DaemonSet/${name}: no nodes scheduled` };
    if (updated < want) return { ok: false, summary: `DaemonSet/${name}: ${updated}/${want} nodes updated` };
    if (unavailable > 0) return { ok: false, summary: `DaemonSet/${name}: ${unavailable} node(s) unavailable` };
    if (ready < want) return { ok: false, summary: `DaemonSet/${name}: ${ready}/${want} ready` };
    return { ok: true, summary: `DaemonSet/${name}: rollout complete, ${ready}/${want} ready` };
  }

  const want = obj.spec?.replicas ?? 0;
  const updated = st.updatedReplicas ?? 0;
  const total = st.replicas ?? 0;
  const ready = st.readyReplicas ?? 0;
  const unavailable = st.unavailableReplicas ?? 0;

  if (want === 0) return { ok: true, summary: `${kind}/${name}: scaled to zero (as specified)` };
  if (updated < want) return { ok: false, summary: `${kind}/${name}: ${updated}/${want} new replicas rolled out` };
  if (total > updated) return { ok: false, summary: `${kind}/${name}: ${total - updated} old replica(s) still terminating` };
  if (unavailable > 0) return { ok: false, summary: `${kind}/${name}: ${unavailable} replica(s) unavailable` };
  if (ready < want) return { ok: false, summary: `${kind}/${name}: ${ready}/${want} replicas ready` };
  if (kind === "StatefulSet" && st.updateRevision && st.currentRevision !== st.updateRevision) {
    return { ok: false, summary: `StatefulSet/${name}: update revision not yet current` };
  }
  return { ok: true, summary: `${kind}/${name}: rollout complete, ${ready}/${want} ready on the new revision` };
}

// ── external access probe ───────────────────────────────────────────────────

/**
 * Pure verdict on a probe response. The OpenShift router answers 503 itself
 * when a Route has no live endpoints, so any 5xx means "the user cannot use
 * this yet". 2xx/3xx is a working page; 401/403/404 mean the app answered —
 * reachable, but flagged so the reader looks at it.
 */
export function probeVerdict(statusCode) {
  if (statusCode == null) return { ok: false, label: "unreachable" };
  if (statusCode >= 500) return { ok: false, label: `HTTP ${statusCode} — application not answering behind the route` };
  if (statusCode >= 400) return { ok: true, label: `HTTP ${statusCode} — reachable (app answered; may need login or a different path)` };
  return { ok: true, label: `HTTP ${statusCode} — application is serving` };
}

// Lab routers use the default self-signed wildcard cert. This probe verifies
// reachability of the endpoint we ourselves just created, not its identity, so
// skipping trust here does not weaken anything security-relevant.
const _probeDispatcher = new Agent({ connect: { rejectUnauthorized: false, timeout: 5000 } });

export async function probeUrl(target, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(target, {
      dispatcher: _probeDispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "tcs-agentic-ai-deploy-verifier" },
    });
    // Consume the body so the socket is released.
    await res.arrayBuffer().catch(() => {});
    return { statusCode: res.status, latencyMs: Date.now() - t0, ...probeVerdict(res.status) };
  } catch (e) {
    return { statusCode: null, latencyMs: Date.now() - t0, ok: false, label: "unreachable", error: e.cause?.code || e.message };
  }
}

// ── the pyramid ─────────────────────────────────────────────────────────────

const BAD_POD = /BackOff|Err|Error|Failed|OOM|Invalid|CreateContainer|Unschedulable/;

/**
 * Run the verification pyramid against a namespace.
 * Cluster-aware through the ambient AsyncLocalStorage context, like every
 * other read in this codebase.
 * Returns { passed, levels: [{id,title,passed,checks:[{name,passed,detail}]}], access }.
 */
export async function verifyNamespace(ns) {
  const safe = async (p) => { try { return await ocpFetch(p); } catch { return { items: [] }; } };
  const [deps, stss, dss, svcs, eps, routes, pods] = await Promise.all([
    safe(`/apis/apps/v1/namespaces/${ns}/deployments`),
    safe(`/apis/apps/v1/namespaces/${ns}/statefulsets`),
    safe(`/apis/apps/v1/namespaces/${ns}/daemonsets`),
    safe(`/api/v1/namespaces/${ns}/services`),
    safe(`/api/v1/namespaces/${ns}/endpoints`),
    safe(`/apis/route.openshift.io/v1/namespaces/${ns}/routes`),
    safe(`/api/v1/namespaces/${ns}/pods`),
  ]);

  const levels = [];

  // L2 — rollout completion (kubectl rollout status semantics)
  {
    const workloads = [...(deps.items || []), ...(stss.items || []), ...(dss.items || [])];
    const checks = workloads.map((w) => {
      const v = rolloutStatus(w);
      return { name: `${w.kind}/${w.metadata?.name}`, passed: v.ok, detail: v.summary };
    });
    if (checks.length === 0) checks.push({ name: "workloads", passed: false, detail: "no workloads found in namespace" });
    levels.push({ id: "rollout", title: "Rollout complete", passed: checks.every((c) => c.passed), checks });
  }

  // L3 — stability: nothing crash-looping, no accumulating restarts
  {
    const checks = [];
    const active = (pods.items || []).filter((p) => !p.metadata?.deletionTimestamp && p.status?.phase !== "Succeeded");
    const failing = [];
    let restarts = 0;
    for (const p of active) {
      const cs = p.status?.containerStatuses || [];
      restarts += cs.reduce((s, c) => s + (c.restartCount || 0), 0);
      const w = cs.find((c) => c.state?.waiting?.reason && BAD_POD.test(c.state.waiting.reason));
      if (w) failing.push(`${p.metadata?.name}: ${w.state.waiting.reason}`);
    }
    checks.push({
      name: "No failing pods",
      passed: failing.length === 0,
      detail: failing.length ? failing.slice(0, 5).join("; ") : `${active.length} pod(s), none in a failure state`,
    });
    checks.push({
      name: "Container restarts",
      passed: restarts <= 2,
      detail: restarts === 0 ? "no restarts" : `${restarts} restart(s) across the namespace${restarts > 2 ? " — investigate before calling this stable" : ""}`,
    });
    levels.push({ id: "stability", title: "Workloads stable", passed: checks.every((c) => c.passed), checks });
  }

  // L4 — wiring: every selector-bearing Service has ready endpoints.
  // This is the check that catches label/selector mismatches — the app looks
  // Ready, the Route exists, and the router still answers 503.
  {
    const epByName = new Map((eps.items || []).map((e) => [e.metadata?.name, e]));
    const checks = [];
    for (const s of svcs.items || []) {
      if (!s.spec?.selector || Object.keys(s.spec.selector).length === 0) continue;
      const ep = epByName.get(s.metadata?.name);
      const ready = (ep?.subsets || []).reduce((n, ss) => n + (ss.addresses || []).length, 0);
      checks.push({
        name: `Service/${s.metadata?.name}`,
        passed: ready > 0,
        detail: ready > 0
          ? `${ready} ready endpoint(s)`
          : "no endpoints — the Service selector does not match any ready pod (check labels)",
      });
    }
    if (checks.length === 0) checks.push({ name: "services", passed: true, detail: "no selector-bearing Services to check" });
    levels.push({ id: "wiring", title: "Services wired to pods", passed: checks.every((c) => c.passed), checks });
  }

  // L5 — access: probe every Route from outside the pods. This is the user's
  // acceptance test — the URL they will actually open.
  const access = [];
  {
    const checks = [];
    for (const r of routes.items || []) {
      const host = r.spec?.host;
      if (!host) continue;
      const scheme = r.spec?.tls ? "https" : "http";
      const target = `${scheme}://${host}`;
      const probe = await probeUrl(target);
      access.push({ name: r.metadata?.name, url: target, ...probe });
      checks.push({ name: `Route/${r.metadata?.name}`, passed: probe.ok, detail: `${target} → ${probe.label}${probe.latencyMs != null ? ` (${probe.latencyMs}ms)` : ""}` });
    }
    if (checks.length === 0) checks.push({ name: "routes", passed: true, detail: "no Routes exposed — internal application" });
    levels.push({ id: "access", title: "User can access the application", passed: checks.every((c) => c.passed), checks });
  }

  return { passed: levels.every((l) => l.passed), levels, access, verifiedAt: new Date().toISOString(), namespace: ns };
}
