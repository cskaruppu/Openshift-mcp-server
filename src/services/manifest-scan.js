/**
 * Shift-left (pre-deploy) scanning for the App Deployment Agent.
 *
 * Evaluates GENERATED manifests — before they ever touch a cluster — against:
 *   1. CIS Kubernetes Benchmark / Pod Security Standards "restricted" (static).
 *   2. Container image hygiene (tag/digest/registry/base-image supply-chain).
 *
 * Both operate purely on the manifest YAML/objects, so they work with no
 * cluster dependency. Image findings can optionally be enriched with real CVE
 * counts from a cluster's Trivy Operator reports when the same image is already
 * scanned there.
 */

import { ocpGet } from "../utils/openshift-client.js";

// ── Extract the pod spec from any workload kind ───────────────────────────
function podSpecOf(m) {
  const kind = (m.kind || "").toLowerCase();
  if (kind === "pod") return m.spec || null;
  if (kind === "cronjob") return m.spec?.jobTemplate?.spec?.template?.spec || null;
  if (["deployment", "statefulset", "daemonset", "replicaset", "job", "replicationcontroller"].includes(kind)) {
    return m.spec?.template?.spec || null;
  }
  return null;
}

function containersOf(podSpec) {
  return [...(podSpec?.containers || []), ...(podSpec?.initContainers || [])];
}

export function extractImages(manifests) {
  const images = new Set();
  for (const m of manifests) {
    const ps = podSpecOf(m);
    if (!ps) continue;
    for (const c of containersOf(ps)) if (c.image) images.add(c.image);
  }
  return [...images];
}

// ── CIS / Pod Security "restricted" — static evaluation ───────────────────
export function cisCheckManifests(manifests) {
  const workloads = [];
  for (const m of manifests) {
    const ps = podSpecOf(m);
    if (ps) workloads.push({ name: `${m.kind}/${m.metadata?.name || "?"}`, podSpec: ps });
  }
  const kinds = new Set(manifests.map((m) => (m.kind || "").toLowerCase()));

  const controls = [];
  const add = (id, title, severity, offenders, note) => {
    const status = offenders.length === 0 ? "PASS" : "FAIL";
    controls.push({ id, title, severity, status, offenders: offenders.slice(0, 12), note: note || null });
  };
  // Container-level predicate → list of "workload:container" offenders.
  const failContainers = (pred) => {
    const bad = [];
    for (const w of workloads) {
      const ps = w.podSpec;
      for (const c of containersOf(ps)) if (pred(c, ps)) bad.push(`${w.name}:${c.name || "?"}`);
    }
    return bad;
  };
  const failPods = (pred) => workloads.filter((w) => pred(w.podSpec)).map((w) => w.name);

  // If there are no workloads, CIS pod checks are not applicable.
  if (workloads.length === 0) {
    return {
      applicable: false,
      controls: [],
      summary: { total: 0, passed: 0, failed: 0, critical: 0, warning: 0, info: 0, grade: "—" },
      note: "No Deployment/StatefulSet/Pod workloads found in the manifests.",
    };
  }

  const secCtx = (c, ps) => c.securityContext || {};
  const podCtx = (ps) => ps.securityContext || {};

  add("CIS-5.2.1", "Containers must not run privileged", "critical",
    failContainers((c) => secCtx(c).privileged === true));

  add("CIS-5.2.6", "Containers must run as non-root (runAsNonRoot: true)", "critical",
    failContainers((c, ps) => !(secCtx(c).runAsNonRoot === true || podCtx(ps).runAsNonRoot === true)));

  add("CIS-5.2.5", "Disallow privilege escalation (allowPrivilegeEscalation: false)", "warning",
    failContainers((c) => secCtx(c).allowPrivilegeEscalation !== false));

  add("CIS-5.2.8", "Drop ALL Linux capabilities", "warning",
    failContainers((c) => !(secCtx(c).capabilities?.drop || []).map(String).map((s) => s.toUpperCase()).includes("ALL")));

  add("CIS-5.2.9", "seccompProfile must be RuntimeDefault", "warning",
    failContainers((c, ps) => (secCtx(c).seccompProfile?.type || podCtx(ps).seccompProfile?.type) !== "RuntimeDefault"));

  add("CIS-5.2.4", "Set CPU/memory requests and limits", "warning",
    failContainers((c) => !(c.resources?.limits?.cpu && c.resources?.limits?.memory)));

  add("CIS-5.2.7", "No host namespaces (hostNetwork/hostPID/hostIPC)", "warning",
    failPods((ps) => ps.hostNetwork === true || ps.hostPID === true || ps.hostIPC === true));

  add("CIS-5.1.6", "Do not use the default ServiceAccount", "warning",
    failPods((ps) => !ps.serviceAccountName || ps.serviceAccountName === "default"));

  add("CIS-5.3.2", "Namespace has a NetworkPolicy", "warning",
    kinds.has("networkpolicy") ? [] : ["<none in manifest set>"],
    "Include at least one NetworkPolicy (ideally default-deny) for the namespace.");

  // Secret hygiene: flag plaintext credential-looking env values.
  const credRe = /(pass|password|secret|token|apikey|api_key)/i;
  const plaintextCreds = failContainers((c) =>
    (c.env || []).some((e) => credRe.test(e.name || "") && typeof e.value === "string" && e.value.length > 0 && !e.valueFrom));
  add("CIS-5.4.1", "Credentials sourced from Secrets, not plaintext env", "warning", plaintextCreds,
    "Reference credentials via valueFrom.secretKeyRef / envFrom, never inline env values.");

  const passed = controls.filter((c) => c.status === "PASS").length;
  const failed = controls.length - passed;
  const failedBySev = (s) => controls.filter((c) => c.status === "FAIL" && c.severity === s).length;
  const critical = failedBySev("critical"), warning = failedBySev("warning"), info = failedBySev("info");
  const grade = failed === 0 ? "A" : critical ? "F" : warning >= 3 ? "C" : "B";

  return {
    applicable: true,
    controls,
    summary: { total: controls.length, passed, failed, critical, warning, info, grade },
  };
}

// ── Image hygiene — pure function of the image reference ──────────────────
export function imageHygiene(image) {
  const findings = [];
  if (image.includes(":latest") || (!image.includes(":") && !image.includes("@sha256:"))) {
    findings.push({ id: "IMG-001", severity: "high", cvss: 7.5, package: "image-tag", description: "Uses :latest or no tag — vulnerable to supply-chain drift", fixedBy: "Pin to a specific tag or digest" });
  }
  if (!image.includes("@sha256:")) {
    findings.push({ id: "IMG-002", severity: "medium", cvss: 5.3, package: "image-digest", description: "Not pinned to a digest — image content may change", fixedBy: "Pin to a SHA256 digest" });
  }
  const trusted = ["registry.redhat.io", "registry.access.redhat.com", "quay.io/redhat", "quay.io/openshift"];
  if (!trusted.some((r) => image.startsWith(r))) {
    const publicReg = ["docker.io", "ghcr.io", "gcr.io", "quay.io"];
    if (publicReg.some((r) => image.includes(r))) {
      findings.push({ id: "IMG-003", severity: "medium", cvss: 5.0, package: "image-registry", description: "From a public registry — verify provenance", fixedBy: "Use a trusted/private registry" });
    } else if (!image.includes(".") && !image.includes("/")) {
      findings.push({ id: "IMG-004", severity: "high", cvss: 8.1, package: "image-registry", description: "Short Docker Hub name — high supply-chain risk", fixedBy: "Use a fully qualified image reference" });
    }
  }
  const base = ["alpine", "ubuntu", "debian", "centos", "node", "python", "golang", "nginx", "httpd", "redis", "postgres", "mysql", "mariadb"];
  if (base.some((b) => image.includes(`/${b}:`) || image.includes(`/${b}@`) || image.startsWith(`${b}:`) || image === b)) {
    findings.push({ id: "IMG-006", severity: "medium", cvss: 4.5, package: "base-image", description: "Common base image — ensure regular rebuilds for patched CVEs", fixedBy: "Enable automated base-image rebuilds" });
  }
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return { image, findings, ...counts, total: findings.length, maxCVSS: findings.reduce((m, f) => Math.max(m, f.cvss || 0), 0) };
}

// ── Optional: enrich with real CVEs from cluster Trivy reports ────────────
// Best-effort. Lists Trivy Operator vulnerabilityreports cluster-wide and
// matches by image repository. Returns a map image→{critical,high,...}.
export async function liveCveForImages(images) {
  const out = {};
  try {
    const data = await ocpGet("/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports?limit=500");
    const norm = (s) => String(s || "").split("@")[0].replace(/:.*/, "");
    const wanted = new Map(images.map((i) => [norm(i.split("/").pop()), i]));
    for (const item of (data.items || [])) {
      const art = item.report?.artifact || {};
      const repo = norm((art.repository || "").split("/").pop());
      const match = wanted.get(repo);
      if (!match) continue;
      const s = item.report?.summary || {};
      const cur = out[match] || { critical: 0, high: 0, medium: 0, low: 0, source: "trivy-operator" };
      cur.critical += s.criticalCount || 0; cur.high += s.highCount || 0;
      cur.medium += s.mediumCount || 0; cur.low += s.lowCount || 0;
      out[match] = cur;
    }
  } catch { /* CRD absent or no access — hygiene-only */ }
  return out;
}

// ── Top-level: scan all images referenced by the manifests ────────────────
export async function scanManifestImages(manifests, { enrich = true } = {}) {
  const images = extractImages(manifests);
  if (images.length === 0) return { images: [], summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, grade: "—" }, note: "No container images referenced in the manifests." };
  const live = enrich ? await liveCveForImages(images) : {};
  const results = images.map((img) => {
    const h = imageHygiene(img);
    const cve = live[img];
    return {
      image: img.length > 70 ? "…" + img.slice(-67) : img,
      fullImage: img,
      hygiene: h.findings,
      liveCve: cve || null,
      critical: (cve?.critical || 0) + h.critical,
      high: (cve?.high || 0) + h.high,
      medium: (cve?.medium || 0) + h.medium,
      low: (cve?.low || 0) + h.low,
      maxCVSS: h.maxCVSS,
      source: cve ? "trivy-operator + hygiene" : "hygiene",
    };
  });
  const t = results.reduce((a, r) => ({ critical: a.critical + r.critical, high: a.high + r.high, medium: a.medium + r.medium, low: a.low + r.low }), { critical: 0, high: 0, medium: 0, low: 0 });
  const score = Math.max(0, 100 - t.critical * 15 - t.high * 8 - t.medium * 3 - t.low);
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  results.sort((a, b) => (b.critical * 100 + b.high * 10 + b.medium) - (a.critical * 100 + a.high * 10 + a.medium));
  return { images: results, summary: { total: results.length, ...t, grade }, enriched: Object.keys(live).length > 0 };
}
