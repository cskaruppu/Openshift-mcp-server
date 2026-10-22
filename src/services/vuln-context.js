// Runtime context for image findings: is the image running, is it reachable
// from outside the cluster, does it run with elevated privilege?
//
// A CVE in an image nobody runs is inventory; the same CVE behind a public
// Route in a privileged pod is an incident waiting to happen. Enterprise
// scanners rank on exactly this, and all of it is in the Kubernetes API: the
// running pods, the Services that select them, and the Routes / Ingresses /
// load balancers in front of those Services. Read-only, four list calls.

import { ocpGet } from "../utils/openshift-client.js";
import { parseImageRef } from "./image-verify.js";

const ELEVATED_SCC = new Set(["privileged", "hostnetwork", "hostnetwork-v2", "hostaccess", "hostmount-anyuid", "node-exporter"]);
const ROOT_SCC = new Set(["anyuid", "hostmount-anyuid", "privileged"]);

const repoKey = (ref) => { const p = parseImageRef(ref); return p ? `${p.registry}/${p.repo}` : String(ref || ""); };
const digestOf = (ref) => { const m = String(ref || "").match(/sha256:[a-f0-9]{64}/); return m ? m[0] : null; };
const tagOf = (ref) => parseImageRef(ref)?.tag || null;

const selects = (selector, labels) => {
  const keys = Object.keys(selector || {});
  return keys.length > 0 && keys.every(k => (labels || {})[k] === selector[k]);
};

/**
 * Build the context once per scan.
 *   ctx.available        false when pods could not be listed (no permission)
 *   ctx.lookup(image)    → { running, pods, namespaces, exposure[], privileged, root }
 */
export async function collectRuntimeContext({ get = ocpGet } = {}) {
  let pods;
  try { pods = (await get("/api/v1/pods?fieldSelector=status.phase%3DRunning")).items || []; }
  catch { return { available: false, lookup: () => null }; }

  const [svcs, routes, ings] = await Promise.all([
    get("/api/v1/services").then(r => r.items || []).catch(() => []),
    get("/apis/route.openshift.io/v1/routes").then(r => r.items || []).catch(() => []),
    get("/apis/networking.k8s.io/v1/ingresses").then(r => r.items || []).catch(() => []),
  ]);

  // Service (ns/name) → ways in from outside the cluster.
  const ingressBySvc = new Map();
  const addIn = (ns, svc, e) => { const k = `${ns}/${svc}`; if (!ingressBySvc.has(k)) ingressBySvc.set(k, []); ingressBySvc.get(k).push(e); };
  for (const r of routes) {
    const to = r.spec?.to?.name;
    if (to) addIn(r.metadata.namespace, to, { kind: "Route", name: r.metadata.name, host: r.spec?.host || null, tls: !!r.spec?.tls });
    for (const alt of (r.spec?.alternateBackends || [])) if (alt.name) addIn(r.metadata.namespace, alt.name, { kind: "Route", name: r.metadata.name, host: r.spec?.host || null, tls: !!r.spec?.tls });
  }
  for (const ing of ings) {
    const ns = ing.metadata.namespace;
    const def = ing.spec?.defaultBackend?.service?.name;
    if (def) addIn(ns, def, { kind: "Ingress", name: ing.metadata.name, host: null, tls: (ing.spec?.tls || []).length > 0 });
    for (const rule of (ing.spec?.rules || [])) {
      for (const p of (rule.http?.paths || [])) {
        const s = p.backend?.service?.name;
        if (s) addIn(ns, s, { kind: "Ingress", name: ing.metadata.name, host: rule.host || null, tls: (ing.spec?.tls || []).length > 0 });
      }
    }
  }
  for (const s of svcs) {
    const t = s.spec?.type;
    if (t === "LoadBalancer" || t === "NodePort") addIn(s.metadata.namespace, s.metadata.name, { kind: t, name: s.metadata.name, host: s.status?.loadBalancer?.ingress?.[0]?.hostname || s.status?.loadBalancer?.ingress?.[0]?.ip || null, tls: false });
  }
  const svcsByNs = new Map();
  for (const s of svcs) {
    if (!s.spec?.selector) continue;
    const ns = s.metadata.namespace;
    if (!svcsByNs.has(ns)) svcsByNs.set(ns, []);
    svcsByNs.get(ns).push(s);
  }

  // repo → running containers of that repo, with what each one exposes.
  const byRepo = new Map();
  for (const p of pods) {
    const ns = p.metadata.namespace;
    const labels = p.metadata.labels || {};
    const scc = (p.metadata.annotations || {})["openshift.io/scc"] || "";
    const podSc = p.spec?.securityContext || {};
    const exposure = [];
    for (const s of (svcsByNs.get(ns) || [])) {
      if (!selects(s.spec.selector, labels)) continue;
      for (const e of (ingressBySvc.get(`${ns}/${s.metadata.name}`) || [])) exposure.push({ ...e, service: s.metadata.name, namespace: ns });
    }
    const statuses = new Map((p.status?.containerStatuses || []).map(cs => [cs.name, cs]));
    for (const c of (p.spec?.containers || [])) {
      const sc = c.securityContext || {};
      const runAsUser = sc.runAsUser ?? podSc.runAsUser;
      const entry = {
        pod: p.metadata.name, namespace: ns, container: c.name, node: p.spec?.nodeName || null,
        owner: (p.metadata.ownerReferences || [])[0] ? { kind: p.metadata.ownerReferences[0].kind, name: p.metadata.ownerReferences[0].name } : null,
        tag: tagOf(c.image), digest: digestOf(statuses.get(c.name)?.imageID) || digestOf(c.image),
        privileged: sc.privileged === true || !!p.spec?.hostNetwork || ELEVATED_SCC.has(scc),
        root: runAsUser === 0 || ROOT_SCC.has(scc),
        scc: scc || null,
        exposure,
      };
      const k = repoKey(c.image);
      if (!byRepo.has(k)) byRepo.set(k, []);
      byRepo.get(k).push(entry);
    }
  }

  const lookup = (image) => {
    const candidates = byRepo.get(repoKey(image)) || [];
    const d = digestOf(image), t = tagOf(image);
    // A digest is exact. Without one, the tag has to agree — a different tag of
    // the same repository is a different image.
    const hits = candidates.filter(e => (d && e.digest) ? e.digest === d : e.tag === t);
    const exposure = [];
    const seenExp = new Set();
    for (const h of hits) for (const e of h.exposure) {
      const key = `${e.kind}/${e.namespace}/${e.name}`;
      if (!seenExp.has(key)) { seenExp.add(key); exposure.push(e); }
    }
    return {
      running: hits.length > 0,
      podCount: new Set(hits.map(h => `${h.namespace}/${h.pod}`)).size,
      pods: hits.slice(0, 10).map(({ exposure: _e, ...rest }) => rest),
      namespaces: [...new Set(hits.map(h => h.namespace))],
      exposure: exposure.slice(0, 10),
      privileged: hits.some(h => h.privileged),
      root: hits.some(h => h.root),
    };
  };

  return { available: true, runningPods: pods.length, lookup };
}
