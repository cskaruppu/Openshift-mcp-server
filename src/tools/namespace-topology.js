/**
 * Namespace workload topology.
 *
 * Builds a component-level, health-aware topology for ONE namespace:
 *   Route → Service → Workload (Deployment/StatefulSet/DaemonSet) → Pods
 *
 * Unlike the network topology (which is endpoint/policy centric), this view is
 * about "what is running and is anything broken between the pieces" — so it
 * surfaces cross-component problems (a Route pointing at a missing Service, a
 * Service with no ready endpoints, a workload that isn't fully rolled out, a
 * pod stuck in CrashLoopBackOff/ImagePullBackOff/OOMKilled).
 */

import { ocpGet } from "../utils/openshift-client.js";

const BAD_WAITING = /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|InvalidImageName|CreateContainerConfigError|CreateContainerError|RunContainerError/;

// labelsMatch: is `selector` (a plain map) satisfied by `labels`?
function labelsMatch(selector, labels) {
  if (!selector || Object.keys(selector).length === 0) return false;
  const l = labels || {};
  return Object.entries(selector).every(([k, v]) => l[k] === v);
}

function podHealth(pod) {
  const phase = pod.status?.phase;
  const cs = pod.status?.containerStatuses || [];
  const reasons = [];
  let maxRestarts = 0, ready = true;
  for (const c of cs) {
    maxRestarts = Math.max(maxRestarts, c.restartCount || 0);
    const wr = c.state?.waiting?.reason;
    if (wr && BAD_WAITING.test(wr)) reasons.push(wr);
    if (c.lastState?.terminated?.reason === "OOMKilled") reasons.push("OOMKilled");
    if (c.ready === false) ready = false;
  }
  if (phase === "Failed") reasons.push("PodFailed");
  if (phase === "Pending" && (pod.status?.conditions || []).some((c) => c.type === "PodScheduled" && c.status === "False")) reasons.push("Unschedulable");
  const status = reasons.length ? "error" : (phase === "Running" && ready ? "healthy" : phase === "Succeeded" ? "healthy" : "warning");
  return { name: pod.metadata?.name, phase, ready, status, restarts: maxRestarts, reasons: [...new Set(reasons)] };
}

export async function getNamespaceTopology(namespace) {
  const ns = namespace;
  const safe = async (p) => { try { return await ocpGet(p); } catch { return { items: [] }; } };

  const [deps, stss, dss, pods, svcs, routes, cms, secrets, pvcs, sas, rss, iss, rbs, nps] = await Promise.all([
    safe(`/apis/apps/v1/namespaces/${ns}/deployments`),
    safe(`/apis/apps/v1/namespaces/${ns}/statefulsets`),
    safe(`/apis/apps/v1/namespaces/${ns}/daemonsets`),
    safe(`/api/v1/namespaces/${ns}/pods`),
    safe(`/api/v1/namespaces/${ns}/services`),
    safe(`/apis/route.openshift.io/v1/namespaces/${ns}/routes`),
    safe(`/api/v1/namespaces/${ns}/configmaps`),
    safe(`/api/v1/namespaces/${ns}/secrets`),
    safe(`/api/v1/namespaces/${ns}/persistentvolumeclaims`),
    safe(`/api/v1/namespaces/${ns}/serviceaccounts`),
    safe(`/apis/apps/v1/namespaces/${ns}/replicasets`),
    safe(`/apis/image.openshift.io/v1/namespaces/${ns}/imagestreams`),
    safe(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`),
    safe(`/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`),
  ]);

  const podList = (pods.items || []).map((p) => ({
    labels: p.metadata?.labels || {},
    health: podHealth(p),
  }));

  // Build workload nodes with attached pods (matched by selector labels).
  const workloadFrom = (item, kind) => {
    const sel = item.spec?.selector?.matchLabels || {};
    const tmplLabels = item.spec?.template?.metadata?.labels || sel;
    const myPods = podList.filter((p) => labelsMatch(sel, p.labels));
    let desired, ready;
    if (kind === "DaemonSet") {
      desired = item.status?.desiredNumberScheduled ?? 0;
      ready = item.status?.numberReady ?? 0;
    } else {
      desired = item.spec?.replicas ?? 0;
      ready = item.status?.readyReplicas ?? 0;
    }
    const problemPods = myPods.map((p) => p.health).filter((h) => h.status !== "healthy");
    const reasons = [...new Set(problemPods.flatMap((h) => h.reasons))];
    let status = "healthy";
    if (desired > 0 && ready === 0) status = "error";
    else if (reasons.length) status = "error";
    else if (ready < desired) status = "warning";
    else if (desired === 0) status = "idle";
    return {
      id: `${kind}/${item.metadata?.name}`,
      kind, name: item.metadata?.name,
      selector: tmplLabels,
      desired, ready, status, reasons,
      pods: myPods.map((p) => p.health).slice(0, 12),
      podCount: myPods.length,
    };
  };

  const workloads = [
    ...(deps.items || []).map((d) => workloadFrom(d, "Deployment")),
    ...(stss.items || []).map((s) => workloadFrom(s, "StatefulSet")),
    ...(dss.items || []).map((d) => workloadFrom(d, "DaemonSet")),
  ];

  // Services with readiness of their endpoints (matching Ready pods).
  const services = (svcs.items || [])
    .filter((s) => s.spec?.type !== "ExternalName")
    .map((s) => {
      const sel = s.spec?.selector || {};
      const matched = podList.filter((p) => labelsMatch(sel, p.labels));
      const readyEndpoints = matched.filter((p) => p.health.status === "healthy").length;
      const target = workloads.find((w) => Object.keys(sel).length && labelsMatch(sel, w.selector));
      let status = "healthy";
      if (Object.keys(sel).length === 0) status = "idle"; // headless/manual endpoints
      else if (matched.length === 0) status = "error";
      else if (readyEndpoints === 0) status = "error";
      else if (readyEndpoints < matched.length) status = "warning";
      return {
        id: `Service/${s.metadata?.name}`,
        kind: "Service", name: s.metadata?.name,
        selector: sel, clusterIP: s.spec?.clusterIP, type: s.spec?.type,
        matchedPods: matched.length, readyEndpoints, status,
        workloadId: target?.id || null,
      };
    });
  const svcByName = Object.fromEntries(services.map((s) => [s.name, s]));

  // Routes → Service.
  const routeNodes = (routes.items || []).map((r) => {
    const toName = r.spec?.to?.name;
    const svc = toName ? svcByName[toName] : null;
    return {
      id: `Route/${r.metadata?.name}`,
      kind: "Route", name: r.metadata?.name,
      host: r.spec?.host, toService: toName,
      tls: !!r.spec?.tls, status: svc ? svc.status : "error",
      missingService: toName && !svc ? toName : null,
      serviceId: svc?.id || null,
    };
  });

  // ---- Cross-component issues ----
  const issues = [];
  for (const r of routeNodes) {
    if (r.missingService) issues.push({ level: "error", component: r.id, message: `Route "${r.name}" points to missing Service "${r.missingService}".` });
  }
  for (const s of services) {
    if (s.status === "error" && Object.keys(s.selector).length) {
      issues.push({ level: "error", component: s.id, message: s.matchedPods === 0 ? `Service "${s.name}" selects no pods (broken selector or no workload).` : `Service "${s.name}" has no ready endpoints (${s.readyEndpoints}/${s.matchedPods} ready).` });
    } else if (s.status === "warning") {
      issues.push({ level: "warning", component: s.id, message: `Service "${s.name}" partially ready (${s.readyEndpoints}/${s.matchedPods} endpoints).` });
    }
  }
  for (const w of workloads) {
    if (w.status === "error") issues.push({ level: "error", component: w.id, message: `${w.kind} "${w.name}" unhealthy — ${w.ready}/${w.desired} ready${w.reasons.length ? " · " + w.reasons.join(", ") : ""}.` });
    else if (w.status === "warning") issues.push({ level: "warning", component: w.id, message: `${w.kind} "${w.name}" rolling out — ${w.ready}/${w.desired} ready.` });
  }

  // ---- Build flow chains (Route → Service → Workload) ----
  const usedServiceIds = new Set();
  const usedWorkloadIds = new Set();
  const chains = [];
  for (const r of routeNodes) {
    const svc = r.serviceId ? services.find((s) => s.id === r.serviceId) : null;
    const wl = svc?.workloadId ? workloads.find((w) => w.id === svc.workloadId) : null;
    if (svc) usedServiceIds.add(svc.id);
    if (wl) usedWorkloadIds.add(wl.id);
    chains.push({ route: r, service: svc || null, workload: wl || null });
  }
  // Internal services (no route) → Service → Workload
  for (const s of services) {
    if (usedServiceIds.has(s.id)) continue;
    const wl = s.workloadId ? workloads.find((w) => w.id === s.workloadId) : null;
    if (wl) usedWorkloadIds.add(wl.id);
    usedServiceIds.add(s.id);
    chains.push({ route: null, service: s, workload: wl || null });
  }
  // Standalone workloads (no service in front)
  const standalone = workloads.filter((w) => !usedWorkloadIds.has(w.id));

  // ---- ACM-style hierarchical graph: Namespace → resources → RS → Pod ----
  const worst = (arr) => arr.includes("error") ? "error" : arr.includes("warning") ? "warning" : arr.some((s) => s === "healthy") ? "healthy" : "idle";
  const gNodes = [], gEdges = [];
  const nsStatus = worst([...workloads.map((w) => w.status), ...services.map((s) => s.status), ...routeNodes.map((r) => r.status)]);
  gNodes.push({ id: "ns", kind: "Namespace", name: ns, status: nsStatus });
  const addKind = (kind, count, status, parent = "ns", idSuffix = "") => {
    if (!count) return null;
    const id = `kind/${kind}${idSuffix}`;
    gNodes.push({ id, kind, name: kind, count, status });
    gEdges.push({ source: parent, target: id });
    return id;
  };
  const podsFor = (list) => podList.filter((p) => list.some((w) => labelsMatch(w.selector, p.labels)));

  // Deployment → ReplicaSet → Pod
  const depW = workloads.filter((w) => w.kind === "Deployment");
  if (depW.length) {
    const dId = addKind("Deployment", depW.length, worst(depW.map((w) => w.status)));
    const activeRs = (rss.items || []).filter((r) => (r.status?.replicas || 0) > 0);
    const rsId = `${dId}/rs`;
    gNodes.push({ id: rsId, kind: "ReplicaSet", name: "ReplicaSet", count: activeRs.length || depW.length, status: worst(depW.map((w) => w.status)) });
    gEdges.push({ source: dId, target: rsId });
    const dp = podsFor(depW);
    const pId = `${rsId}/pod`;
    gNodes.push({ id: pId, kind: "Pod", name: "Pod", count: dp.length, status: worst(dp.map((p) => p.health.status)) });
    gEdges.push({ source: rsId, target: pId });
  }
  // StatefulSet → Pod, DaemonSet → Pod
  for (const [k, list] of [["StatefulSet", workloads.filter((w) => w.kind === "StatefulSet")], ["DaemonSet", workloads.filter((w) => w.kind === "DaemonSet")]]) {
    if (!list.length) continue;
    const id = addKind(k, list.length, worst(list.map((w) => w.status)));
    const p = podsFor(list);
    const pid = `${id}/pod`;
    gNodes.push({ id: pid, kind: "Pod", name: "Pod", count: p.length, status: worst(p.map((x) => x.health.status)) });
    gEdges.push({ source: id, target: pid });
  }
  // Leaf resource kinds (collapsed with a count badge, ACM-style)
  addKind("Service", services.length, worst(services.map((s) => s.status)));
  addKind("Route", routeNodes.length, worst(routeNodes.map((r) => r.status)));
  const pvcItems = pvcs.items || [];
  addKind("PVC", pvcItems.length, worst(pvcItems.map((p) => p.status?.phase === "Bound" ? "healthy" : p.status?.phase === "Lost" ? "error" : "warning")));
  addKind("ConfigMap", (cms.items || []).length, "healthy");
  addKind("Secret", (secrets.items || []).length, "healthy");
  addKind("ServiceAccount", (sas.items || []).length, "healthy");
  addKind("ImageStream", (iss.items || []).length, "healthy");
  addKind("RoleBinding", (rbs.items || []).length, "healthy");
  addKind("NetworkPolicy", (nps.items || []).length, "healthy");

  const summary = {
    workloads: workloads.length,
    healthy: workloads.filter((w) => w.status === "healthy").length,
    warning: workloads.filter((w) => w.status === "warning").length,
    error: workloads.filter((w) => w.status === "error").length,
    idle: workloads.filter((w) => w.status === "idle").length,
    services: services.length,
    routes: routeNodes.length,
    pods: podList.length,
    runningPods: podList.filter((p) => p.health.status === "healthy").length,
  };

  return { namespace: ns, summary, chains, standalone, issues, graph: { nodes: gNodes, edges: gEdges }, ok: issues.filter((i) => i.level === "error").length === 0 };
}
