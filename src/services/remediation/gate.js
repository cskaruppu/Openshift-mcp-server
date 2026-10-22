// Pre-deploy gate: scan the replacement image BEFORE it is approved or
// deployed, and hold the change if it does not actually improve things.
//
// The scan runs as a short-lived Trivy Job in the platform's own namespace —
// the same scanner the cluster already trusts, against the exact candidate
// tag — with no privileges, a deadline, and automatic clean-up. For a change
// that goes through GitHub / GitLab, the customer's CI checks on the PR / MR
// are a second, independent gate; both must pass.
//
//   REMEDIATION_TRIVY_IMAGE           scanner image (default below)
//   REMEDIATION_TRIVY_DB_REPOSITORY   vulnerability DB mirror for air-gapped clusters
//   REMEDIATION_TRIVY_REGISTRY_SECRET Secret with TRIVY_USERNAME / TRIVY_PASSWORD for private registries
//   REMEDIATION_GATE_NAMESPACE        where the Job runs (default: the platform namespace)

import { ocpFetch, ocpPost, ocpDelete } from "../../utils/openshift-client.js";

export const DEFAULT_TRIVY_IMAGE = "docker.io/aquasec/trivy:0.57.1";
const gateNs = () => process.env.REMEDIATION_GATE_NAMESPACE || process.env.MCP_NAMESPACE || process.env.NAMESPACE || "openshift-mcp";

export function gateJobSpec(jobName, image, { recordId } = {}) {
  const env = [{ name: "TRIVY_NO_PROGRESS", value: "true" }, { name: "TRIVY_CACHE_DIR", value: "/tmp/trivy" }];
  if (process.env.REMEDIATION_TRIVY_DB_REPOSITORY) env.push({ name: "TRIVY_DB_REPOSITORY", value: process.env.REMEDIATION_TRIVY_DB_REPOSITORY });
  const container = {
    name: "trivy",
    image: process.env.REMEDIATION_TRIVY_IMAGE || DEFAULT_TRIVY_IMAGE,
    args: ["image", "--quiet", "--format", "json", "--scanners", "vuln", "--severity", "CRITICAL,HIGH,MEDIUM", "--timeout", "12m", image],
    env,
    resources: { requests: { cpu: "200m", memory: "512Mi" }, limits: { cpu: "1", memory: "2Gi" } },
    securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } },
    volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
  };
  if (process.env.REMEDIATION_TRIVY_REGISTRY_SECRET) container.envFrom = [{ secretRef: { name: process.env.REMEDIATION_TRIVY_REGISTRY_SECRET } }];
  return {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name: jobName, namespace: gateNs(), labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai", "app.kubernetes.io/component": "remediation-gate", ...(recordId ? { "tcs.com/remediation": recordId } : {}) } },
    spec: {
      backoffLimit: 0, activeDeadlineSeconds: 900, ttlSecondsAfterFinished: 900,
      template: {
        metadata: { labels: { "app.kubernetes.io/component": "remediation-gate" } },
        spec: { restartPolicy: "Never", automountServiceAccountToken: false, containers: [container], volumes: [{ name: "tmp", emptyDir: {} }] },
      },
    },
  };
}

/** Start the scan. Returns { job, namespace, startedAt }. */
export async function startGateScan(image, { recordId }) {
  const job = `tcs-gate-${String(recordId).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(-20)}-${Date.now().toString(36)}`.slice(0, 60);
  await ocpPost(`/apis/batch/v1/namespaces/${gateNs()}/jobs`, gateJobSpec(job, image, { recordId }));
  return { job, namespace: gateNs(), startedAt: new Date().toISOString() };
}

/** Poll the scan. Returns { done:false } or { done:true, ok, report?|error }. */
export async function pollGateScan({ job, namespace }) {
  const j = await ocpFetch(`/apis/batch/v1/namespaces/${namespace}/jobs/${job}`);
  const st = j.status || {};
  if (!st.succeeded && !st.failed) return { done: false };
  let log = "";
  try {
    const pods = await ocpFetch(`/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(`job-name=${job}`)}`);
    const pod = (pods.items || [])[0];
    if (pod) log = await ocpFetch(`/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}/log?container=trivy`, { headers: { Accept: "text/plain" } });
  } catch { /* fall through */ }
  ocpDelete(`/apis/batch/v1/namespaces/${namespace}/jobs/${job}?propagationPolicy=Background`).catch(() => {});
  if (st.failed) return { done: true, ok: false, error: `Scan job failed${log ? `: ${String(log).trim().split("\n").slice(-3).join(" ").slice(0, 300)}` : ""}` };
  try { return { done: true, ok: true, report: summarizeTrivy(JSON.parse(String(log).slice(String(log).indexOf("{")))) }; }
  catch { return { done: true, ok: false, error: "Scanner output could not be read" }; }
}

/** Trivy JSON → { critical, high, medium, vulns:[{id, severity, package, fixed}] } */
export function summarizeTrivy(doc) {
  const vulns = [];
  const seen = new Set();
  for (const r of (doc.Results || [])) {
    for (const v of (r.Vulnerabilities || [])) {
      const key = `${v.VulnerabilityID}::${v.PkgName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      vulns.push({ id: v.VulnerabilityID, severity: String(v.Severity || "").toLowerCase(), package: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion || null });
    }
  }
  const n = (s) => vulns.filter((v) => v.severity === s).length;
  return { critical: n("critical"), high: n("high"), medium: n("medium"), total: vulns.length, vulns: vulns.slice(0, 400), artifact: doc.ArtifactName || null, scannedAt: new Date().toISOString() };
}

/**
 * The gate policy. A replacement image passes only if it
 *   1. removes the CVEs this change was raised to fix (those with a published fix),
 *   2. carries no CVE from CISA's KEV catalog, and
 *   3. has no more Critical findings than the image it replaces.
 * More High findings is a warning, not a block — the reviewer decides.
 */
export function evaluateGate(report, { targetCves = [], current = {}, kev = new Set() }) {
  const ids = new Set(report.vulns.map((v) => String(v.id).toUpperCase()));
  const stillPresent = targetCves.filter((c) => c.fixed && ids.has(String(c.id).toUpperCase())).map((c) => c.id);
  const kevPresent = [...ids].filter((id) => kev.has(id));
  const reasons = [], warnings = [];
  if (stillPresent.length) reasons.push(`Still contains ${stillPresent.length} CVE(s) this change should fix: ${stillPresent.slice(0, 6).join(", ")}`);
  if (kevPresent.length) reasons.push(`Contains CISA KEV CVE(s): ${kevPresent.slice(0, 6).join(", ")}`);
  if ((current.critical ?? Infinity) < report.critical) reasons.push(`More Critical findings than today (${report.critical} vs ${current.critical})`);
  if ((current.high ?? Infinity) < report.high) warnings.push(`More High findings than today (${report.high} vs ${current.high})`);
  const fixed = targetCves.filter((c) => c.fixed && !ids.has(String(c.id).toUpperCase())).map((c) => c.id);
  return { pass: reasons.length === 0, reasons, warnings, fixed, stillPresent, kevPresent, counts: { critical: report.critical, high: report.high, medium: report.medium } };
}
