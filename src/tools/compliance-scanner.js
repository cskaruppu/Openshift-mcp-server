/**
 * CIS Kubernetes Benchmark Compliance Scanner
 *
 * Scans the cluster against CIS-style benchmark controls covering pod security,
 * network security, RBAC & secrets, and image security. Produces structured
 * findings with severity, remediation guidance, and a numeric compliance score.
 *
 * Results are kept in module state with history (last 50 scans) so callers can
 * track posture changes over time.
 */

import { ocpGet } from "../utils/openshift-client.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let _latestResults = null;
const _scanHistory = [];
const MAX_HISTORY = 50;

// Configurable approved registries — can be overridden via options
const DEFAULT_APPROVED_REGISTRIES = [
  "registry.redhat.io",
  "registry.access.redhat.com",
  "quay.io/redhat",
  "quay.io/openshift",
  "image-registry.openshift-image-registry.svc",
];

// Namespaces to skip when scanning (system namespaces)
const SYSTEM_NS_PREFIXES = ["openshift-", "kube-"];
const SYSTEM_NS_EXACT = new Set(["default", "kube-system", "kube-public", "kube-node-lease"]);

function isSystemNamespace(ns) {
  if (SYSTEM_NS_EXACT.has(ns)) return true;
  return SYSTEM_NS_PREFIXES.some((prefix) => ns.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Helper: create a finding object
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
// Pod Security checks (category: "pod-security")
// ---------------------------------------------------------------------------
async function checkPodSecurity() {
  const findings = [];

  let pods;
  try {
    const data = await ocpGet("/api/v1/pods");
    pods = (data.items || []).filter(
      (p) => !isSystemNamespace(p.metadata.namespace) && p.status?.phase === "Running"
    );
  } catch (err) {
    findings.push(
      finding({
        id: "CIS-5.2.0",
        category: "pod-security",
        title: "Pod security scan failed",
        severity: "warning",
        status: "WARN",
        description: `Unable to retrieve pods: ${err.message}`,
        remediation: "Verify API connectivity and RBAC permissions for listing pods.",
      })
    );
    return findings;
  }

  for (const pod of pods) {
    const ns = pod.metadata.namespace;
    const podName = pod.metadata.name;
    const podSc = pod.spec?.securityContext || {};
    const containers = [...(pod.spec?.containers || []), ...(pod.spec?.initContainers || [])];

    // --- CIS-5.2.1: Containers must not run as root ---
    for (const c of containers) {
      const csc = c.securityContext || {};
      const runAsNonRoot = csc.runAsNonRoot ?? podSc.runAsNonRoot;
      const runAsUser = csc.runAsUser ?? podSc.runAsUser;

      if (runAsUser === 0) {
        findings.push(
          finding({
            id: "CIS-5.2.1",
            category: "pod-security",
            title: "Container runs as root (UID 0)",
            severity: "critical",
            status: "FAIL",
            namespace: ns,
            resource: `${podName}/${c.name}`,
            description: `Container '${c.name}' in pod '${podName}' explicitly runs as root (runAsUser: 0).`,
            remediation:
              "Set securityContext.runAsNonRoot: true and securityContext.runAsUser to a non-zero UID in the pod or container spec.",
          })
        );
      } else if (runAsNonRoot !== true) {
        findings.push(
          finding({
            id: "CIS-5.2.1",
            category: "pod-security",
            title: "Container does not enforce non-root execution",
            severity: "warning",
            status: "FAIL",
            namespace: ns,
            resource: `${podName}/${c.name}`,
            description: `Container '${c.name}' in pod '${podName}' does not set runAsNonRoot: true. It may run as root.`,
            remediation:
              "Add securityContext.runAsNonRoot: true to the pod or container security context.",
          })
        );
      }
    }

    // --- CIS-5.2.2: Privileged containers ---
    for (const c of containers) {
      if (c.securityContext?.privileged === true) {
        findings.push(
          finding({
            id: "CIS-5.2.2",
            category: "pod-security",
            title: "Privileged container detected",
            severity: "critical",
            status: "FAIL",
            namespace: ns,
            resource: `${podName}/${c.name}`,
            description: `Container '${c.name}' in pod '${podName}' runs in privileged mode, granting full host access.`,
            remediation:
              "Remove securityContext.privileged: true. Use specific capabilities instead, or apply a restricted SCC/PSA profile.",
          })
        );
      }
    }

    // --- CIS-5.2.3: hostNetwork / hostPID / hostIPC ---
    if (pod.spec?.hostNetwork) {
      findings.push(
        finding({
          id: "CIS-5.2.3",
          category: "pod-security",
          title: "Pod uses hostNetwork",
          severity: "critical",
          status: "FAIL",
          namespace: ns,
          resource: podName,
          description: `Pod '${podName}' uses hostNetwork: true, sharing the host's network namespace.`,
          remediation: "Remove hostNetwork: true unless absolutely required. Use Services and Ingress for network access.",
        })
      );
    }
    if (pod.spec?.hostPID) {
      findings.push(
        finding({
          id: "CIS-5.2.3",
          category: "pod-security",
          title: "Pod uses hostPID",
          severity: "critical",
          status: "FAIL",
          namespace: ns,
          resource: podName,
          description: `Pod '${podName}' uses hostPID: true, allowing visibility of all host processes.`,
          remediation: "Remove hostPID: true from the pod spec.",
        })
      );
    }
    if (pod.spec?.hostIPC) {
      findings.push(
        finding({
          id: "CIS-5.2.3",
          category: "pod-security",
          title: "Pod uses hostIPC",
          severity: "warning",
          status: "FAIL",
          namespace: ns,
          resource: podName,
          description: `Pod '${podName}' uses hostIPC: true, sharing host inter-process communication namespace.`,
          remediation: "Remove hostIPC: true from the pod spec.",
        })
      );
    }

    // --- CIS-5.2.4: Containers without resource limits ---
    for (const c of containers) {
      const limits = c.resources?.limits || {};
      if (!limits.memory || !limits.cpu) {
        const missing = [];
        if (!limits.cpu) missing.push("cpu");
        if (!limits.memory) missing.push("memory");
        findings.push(
          finding({
            id: "CIS-5.2.4",
            category: "pod-security",
            title: "Container missing resource limits",
            severity: "warning",
            status: "FAIL",
            namespace: ns,
            resource: `${podName}/${c.name}`,
            description: `Container '${c.name}' in pod '${podName}' is missing ${missing.join(" and ")} limits. Without limits, a single container can starve the node.`,
            remediation:
              "Set resources.limits.cpu and resources.limits.memory in the container spec, or apply a LimitRange to the namespace.",
          })
        );
      }
    }

    // --- CIS-5.2.5: Containers without readiness probes ---
    // Only check non-init containers (init containers don't need readiness probes)
    for (const c of pod.spec?.containers || []) {
      if (!c.readinessProbe) {
        findings.push(
          finding({
            id: "CIS-5.2.5",
            category: "pod-security",
            title: "Container missing readiness probe",
            severity: "info",
            status: "FAIL",
            namespace: ns,
            resource: `${podName}/${c.name}`,
            description: `Container '${c.name}' in pod '${podName}' has no readiness probe. Traffic may be sent to unready containers.`,
            remediation:
              "Add a readinessProbe (httpGet, tcpSocket, or exec) to the container spec to ensure traffic is only sent when the container is ready.",
          })
        );
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Network Security checks (category: "network-security")
// ---------------------------------------------------------------------------
async function checkNetworkSecurity() {
  const findings = [];

  // --- CIS-5.3.1: Namespaces without NetworkPolicies ---
  try {
    const [nsData, npData] = await Promise.all([
      ocpGet("/api/v1/namespaces"),
      ocpGet("/apis/networking.k8s.io/v1/networkpolicies"),
    ]);

    const userNamespaces = (nsData.items || []).filter(
      (n) => !isSystemNamespace(n.metadata.name)
    );
    const coveredNamespaces = new Set(
      (npData.items || []).map((np) => np.metadata.namespace)
    );

    for (const ns of userNamespaces) {
      if (!coveredNamespaces.has(ns.metadata.name)) {
        findings.push(
          finding({
            id: "CIS-5.3.1",
            category: "network-security",
            title: "Namespace has no NetworkPolicy",
            severity: "warning",
            status: "FAIL",
            namespace: ns.metadata.name,
            resource: `namespace/${ns.metadata.name}`,
            description: `Namespace '${ns.metadata.name}' has no NetworkPolicy defined. All ingress and egress traffic is unrestricted.`,
            remediation:
              "Create a default-deny NetworkPolicy: oc apply -f default-deny-netpol.yaml -n " +
              ns.metadata.name,
          })
        );
      }
    }
  } catch (err) {
    findings.push(
      finding({
        id: "CIS-5.3.1",
        category: "network-security",
        title: "NetworkPolicy scan failed",
        severity: "warning",
        status: "WARN",
        description: `Unable to check NetworkPolicies: ${err.message}`,
        remediation: "Verify API connectivity and RBAC permissions for listing namespaces and networkpolicies.",
      })
    );
  }

  // --- CIS-5.3.2: Services exposed via LoadBalancer or NodePort ---
  try {
    const svcData = await ocpGet("/api/v1/services");
    const services = (svcData.items || []).filter(
      (s) => !isSystemNamespace(s.metadata.namespace)
    );

    for (const svc of services) {
      const svcType = svc.spec?.type;
      if (svcType === "LoadBalancer") {
        findings.push(
          finding({
            id: "CIS-5.3.2",
            category: "network-security",
            title: "Service exposed via LoadBalancer",
            severity: "warning",
            status: "FAIL",
            namespace: svc.metadata.namespace,
            resource: `service/${svc.metadata.name}`,
            description: `Service '${svc.metadata.name}' in namespace '${svc.metadata.namespace}' is exposed via LoadBalancer, making it directly accessible from outside the cluster.`,
            remediation:
              "Consider using ClusterIP with an Ingress/Route instead of LoadBalancer for finer-grained access control and TLS termination.",
          })
        );
      } else if (svcType === "NodePort") {
        findings.push(
          finding({
            id: "CIS-5.3.2",
            category: "network-security",
            title: "Service exposed via NodePort",
            severity: "warning",
            status: "FAIL",
            namespace: svc.metadata.namespace,
            resource: `service/${svc.metadata.name}`,
            description: `Service '${svc.metadata.name}' in namespace '${svc.metadata.namespace}' is exposed via NodePort, opening a port on every cluster node.`,
            remediation:
              "Use ClusterIP with Ingress/Route instead of NodePort. If NodePort is required, restrict access via firewall rules.",
          })
        );
      }
    }
  } catch (err) {
    findings.push(
      finding({
        id: "CIS-5.3.2",
        category: "network-security",
        title: "Service exposure scan failed",
        severity: "warning",
        status: "WARN",
        description: `Unable to check services: ${err.message}`,
        remediation: "Verify API connectivity and RBAC permissions for listing services.",
      })
    );
  }

  // --- CIS-5.3.3: Pods using default service account ---
  try {
    const podData = await ocpGet("/api/v1/pods");
    const pods = (podData.items || []).filter(
      (p) => !isSystemNamespace(p.metadata.namespace) && p.status?.phase === "Running"
    );

    for (const pod of pods) {
      const sa = pod.spec?.serviceAccountName || pod.spec?.serviceAccount || "default";
      if (sa === "default") {
        findings.push(
          finding({
            id: "CIS-5.3.3",
            category: "network-security",
            title: "Pod uses default service account",
            severity: "warning",
            status: "FAIL",
            namespace: pod.metadata.namespace,
            resource: `pod/${pod.metadata.name}`,
            description: `Pod '${pod.metadata.name}' in namespace '${pod.metadata.namespace}' uses the default service account. The default SA may have broader permissions than necessary.`,
            remediation:
              "Create a dedicated service account with minimal RBAC permissions and set spec.serviceAccountName in the pod spec.",
          })
        );
      }
    }
  } catch (err) {
    findings.push(
      finding({
        id: "CIS-5.3.3",
        category: "network-security",
        title: "Default service account scan failed",
        severity: "warning",
        status: "WARN",
        description: `Unable to check pods for default service accounts: ${err.message}`,
        remediation: "Verify API connectivity and RBAC permissions for listing pods.",
      })
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// RBAC & Secrets checks (category: "rbac-secrets")
// ---------------------------------------------------------------------------
async function checkRBACAndSecrets() {
  const findings = [];

  // --- CIS-5.1.1: Cluster-admin role bindings ---
  try {
    const crbData = await ocpGet("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings");
    const clusterAdminBindings = (crbData.items || []).filter(
      (crb) => crb.roleRef?.name === "cluster-admin"
    );

    // Filter to non-system bindings for the warning
    const nonSystemAdminBindings = clusterAdminBindings.filter((crb) => {
      const subjects = crb.subjects || [];
      return subjects.some((s) => {
        // System SAs in openshift-* or kube-* namespaces are expected
        if (s.kind === "ServiceAccount" && s.namespace && isSystemNamespace(s.namespace)) {
          return false;
        }
        return true;
      });
    });

    // Warn if there are more than 3 non-system cluster-admin bindings
    const CLUSTER_ADMIN_THRESHOLD = 3;
    if (nonSystemAdminBindings.length > CLUSTER_ADMIN_THRESHOLD) {
      const bindingNames = nonSystemAdminBindings
        .slice(0, 10)
        .map((crb) => crb.metadata.name)
        .join(", ");
      findings.push(
        finding({
          id: "CIS-5.1.1",
          category: "rbac-secrets",
          title: "Excessive cluster-admin role bindings",
          severity: "critical",
          status: "FAIL",
          resource: `clusterrolebindings (${nonSystemAdminBindings.length} non-system)`,
          description: `Found ${nonSystemAdminBindings.length} non-system cluster-admin bindings (threshold: ${CLUSTER_ADMIN_THRESHOLD}): ${bindingNames}. Excessive cluster-admin access violates least-privilege principles.`,
          remediation:
            "Review and remove unnecessary cluster-admin bindings: oc delete clusterrolebinding <name>. Use scoped roles with only the required permissions.",
        })
      );
    } else if (nonSystemAdminBindings.length > 0) {
      const bindingNames = nonSystemAdminBindings.map((crb) => crb.metadata.name).join(", ");
      findings.push(
        finding({
          id: "CIS-5.1.1",
          category: "rbac-secrets",
          title: "Cluster-admin role bindings present",
          severity: "info",
          status: "PASS",
          resource: `clusterrolebindings (${nonSystemAdminBindings.length} non-system)`,
          description: `Found ${nonSystemAdminBindings.length} non-system cluster-admin binding(s) within threshold: ${bindingNames}.`,
          remediation: "Periodically review cluster-admin bindings to ensure they are still required.",
        })
      );
    }
  } catch (err) {
    findings.push(
      finding({
        id: "CIS-5.1.1",
        category: "rbac-secrets",
        title: "Cluster-admin binding scan failed",
        severity: "warning",
        status: "WARN",
        description: `Unable to check cluster role bindings: ${err.message}`,
        remediation: "Verify API connectivity and RBAC permissions for listing clusterrolebindings.",
      })
    );
  }

  // --- CIS-5.4.1: Secrets mounted as environment variables ---
  try {
    const podData = await ocpGet("/api/v1/pods");
    const pods = (podData.items || []).filter(
      (p) => !isSystemNamespace(p.metadata.namespace) && p.status?.phase === "Running"
    );

    for (const pod of pods) {
      const ns = pod.metadata.namespace;
      const podName = pod.metadata.name;
      const containers = [...(pod.spec?.containers || []), ...(pod.spec?.initContainers || [])];

      for (const c of containers) {
        const envSecrets = [];

        // Check individual env vars referencing secrets
        for (const env of c.env || []) {
          if (env.valueFrom?.secretKeyRef) {
            envSecrets.push(
              `${env.name} (from secret '${env.valueFrom.secretKeyRef.name}')`
            );
          }
        }

        // Check envFrom referencing secrets
        for (const src of c.envFrom || []) {
          if (src.secretRef) {
            envSecrets.push(`envFrom secret '${src.secretRef.name}'`);
          }
        }

        if (envSecrets.length > 0) {
          findings.push(
            finding({
              id: "CIS-5.4.1",
              category: "rbac-secrets",
              title: "Secret mounted as environment variable",
              severity: "warning",
              status: "FAIL",
              namespace: ns,
              resource: `${podName}/${c.name}`,
              description: `Container '${c.name}' in pod '${podName}' mounts ${envSecrets.length} secret(s) as environment variable(s): ${envSecrets.slice(0, 3).join("; ")}${envSecrets.length > 3 ? ` (+${envSecrets.length - 3} more)` : ""}. Environment variables are less secure than volume mounts as they may appear in logs, error reports, or /proc.`,
              remediation:
                "Mount secrets as volumes instead of environment variables. Use spec.volumes[].secret and spec.containers[].volumeMounts[] to project secrets as files.",
            })
          );
        }
      }
    }
  } catch (err) {
    findings.push(
      finding({
        id: "CIS-5.4.1",
        category: "rbac-secrets",
        title: "Secret env var scan failed",
        severity: "warning",
        status: "WARN",
        description: `Unable to check secrets in environment variables: ${err.message}`,
        remediation: "Verify API connectivity and RBAC permissions for listing pods.",
      })
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Image Security checks (category: "image-security")
// ---------------------------------------------------------------------------
async function checkImageSecurity(options = {}) {
  const findings = [];
  const approvedRegistries = options.approvedRegistries || DEFAULT_APPROVED_REGISTRIES;

  try {
    const podData = await ocpGet("/api/v1/pods");
    const pods = (podData.items || []).filter(
      (p) => !isSystemNamespace(p.metadata.namespace) && p.status?.phase === "Running"
    );

    // Track images already checked to avoid duplicate findings per image
    const checkedImages = new Map();

    for (const pod of pods) {
      const ns = pod.metadata.namespace;
      const podName = pod.metadata.name;
      const containers = [...(pod.spec?.containers || []), ...(pod.spec?.initContainers || [])];

      for (const c of containers) {
        const image = c.image || "";
        if (!image) continue;

        // Build a unique key per image+namespace to avoid flooding findings
        const imageKey = `${ns}/${image}`;
        if (checkedImages.has(imageKey)) continue;
        checkedImages.set(imageKey, true);

        // --- CIS-5.5.1: Containers using :latest tag ---
        const usesLatest =
          image.endsWith(":latest") ||
          (!image.includes(":") && !image.includes("@sha256:"));
        if (usesLatest) {
          findings.push(
            finding({
              id: "CIS-5.5.1",
              category: "image-security",
              title: "Container uses :latest or untagged image",
              severity: "warning",
              status: "FAIL",
              namespace: ns,
              resource: `${podName}/${c.name}`,
              description: `Container '${c.name}' in pod '${podName}' uses image '${image}' with the :latest tag or no tag. This makes deployments non-reproducible and complicates rollback.`,
              remediation:
                "Pin the image to a specific version tag or SHA256 digest. Example: image: registry.example.com/app:v1.2.3",
            })
          );
        }

        // --- CIS-5.5.2: Containers pulling from non-approved registries ---
        const isApproved = approvedRegistries.some((registry) =>
          image.startsWith(registry)
        );
        if (!isApproved) {
          // Determine if this is a short Docker Hub name (no domain)
          const hasSlash = image.includes("/");
          const firstPart = image.split("/")[0];
          const hasDomain = hasSlash && (firstPart.includes(".") || firstPart.includes(":"));
          const isShortName = !hasSlash || !hasDomain;

          const severity = isShortName ? "critical" : "warning";
          const desc = isShortName
            ? `Container '${c.name}' in pod '${podName}' uses short image name '${image}' which resolves to Docker Hub. Docker Hub images carry supply-chain risk and are subject to rate limits.`
            : `Container '${c.name}' in pod '${podName}' uses image '${image}' from an unapproved registry. Approved registries: ${approvedRegistries.join(", ")}.`;

          findings.push(
            finding({
              id: "CIS-5.5.2",
              category: "image-security",
              title: "Image from non-approved registry",
              severity,
              status: "FAIL",
              namespace: ns,
              resource: `${podName}/${c.name}`,
              description: desc,
              remediation:
                "Pull images from an approved registry, or add the registry to the approved list. Use fully qualified image references with a domain name.",
            })
          );
        }
      }
    }
  } catch (err) {
    findings.push(
      finding({
        id: "CIS-5.5.0",
        category: "image-security",
        title: "Image security scan failed",
        severity: "warning",
        status: "WARN",
        description: `Unable to check image security: ${err.message}`,
        remediation: "Verify API connectivity and RBAC permissions for listing pods.",
      })
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Score calculation — penalty model (consistent with dashboard security widget)
// ---------------------------------------------------------------------------
function calculateScore(allFindings) {
  const fails = allFindings.filter((f) => f.status === "FAIL");
  if (fails.length === 0) return 100;

  const checkCounts = {};
  for (const f of fails) {
    checkCounts[f.id] = (checkCounts[f.id] || 0) + 1;
  }

  let score = 100;

  // Pod Security (max -40)
  score -= Math.min(15, (checkCounts["CIS-5.2.1"] || 0) * 0.3);
  score -= Math.min(12, (checkCounts["CIS-5.2.2"] || 0) * 4);
  score -= Math.min(8, (checkCounts["CIS-5.2.3"] || 0) * 2);
  score -= Math.min(10, Math.ceil((checkCounts["CIS-5.2.4"] || 0) / 20));
  score -= Math.min(5, Math.ceil((checkCounts["CIS-5.2.5"] || 0) / 30));

  // Network Security (max -20)
  score -= Math.min(10, (checkCounts["CIS-5.3.1"] || 0) * 2);
  score -= Math.min(5, checkCounts["CIS-5.3.2"] || 0);
  score -= Math.min(5, Math.ceil((checkCounts["CIS-5.3.3"] || 0) / 15));

  // RBAC & Secrets (max -15)
  score -= Math.min(8, (checkCounts["CIS-5.1.1"] || 0) * 4);
  score -= Math.min(7, Math.ceil((checkCounts["CIS-5.4.1"] || 0) / 15));

  // Image Security (max -15)
  score -= Math.min(7, Math.ceil((checkCounts["CIS-5.5.1"] || 0) / 3));
  score -= Math.min(8, checkCounts["CIS-5.5.2"] || 0);

  return Math.max(0, Math.round(score));
}

function calculateGrade(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Category summary
// ---------------------------------------------------------------------------
function buildCategorySummary(allFindings) {
  const categories = {};

  for (const f of allFindings) {
    if (!categories[f.category]) {
      categories[f.category] = { total: 0, pass: 0, fail: 0, warn: 0, critical: 0, warning: 0, info: 0 };
    }
    const cat = categories[f.category];
    cat.total++;
    if (f.status === "PASS") cat.pass++;
    else if (f.status === "FAIL") cat.fail++;
    else if (f.status === "WARN") cat.warn++;

    if (f.severity === "critical") cat.critical++;
    else if (f.severity === "warning") cat.warning++;
    else if (f.severity === "info") cat.info++;
  }

  return categories;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Run a full CIS Kubernetes Benchmark compliance scan.
 *
 * @param {Object} [options]
 * @param {string[]} [options.approvedRegistries] - Override approved image registries.
 * @returns {Promise<Object>} Scan results with findings, score, and category summary.
 */
export async function runComplianceScan(options = {}) {
  const scanTime = new Date().toISOString();

  // Run all category checks in parallel for speed
  const [podSecFindings, netSecFindings, rbacFindings, imageFindings] = await Promise.all([
    checkPodSecurity(),
    checkNetworkSecurity(),
    checkRBACAndSecrets(),
    checkImageSecurity(options),
  ]);

  const allFindings = [
    ...podSecFindings,
    ...netSecFindings,
    ...rbacFindings,
    ...imageFindings,
  ];

  const score = calculateScore(allFindings);
  const grade = calculateGrade(score);
  const summary = buildCategorySummary(allFindings);

  const results = {
    scanTime,
    score,
    grade,
    findings: allFindings,
    summary,
    totals: {
      total: allFindings.length,
      pass: allFindings.filter((f) => f.status === "PASS").length,
      fail: allFindings.filter((f) => f.status === "FAIL").length,
      warn: allFindings.filter((f) => f.status === "WARN").length,
      critical: allFindings.filter((f) => f.severity === "critical").length,
      warning: allFindings.filter((f) => f.severity === "warning").length,
      info: allFindings.filter((f) => f.severity === "info").length,
    },
  };

  // Store latest results
  _latestResults = results;

  // Append to history, keeping only the last MAX_HISTORY entries
  _scanHistory.unshift({
    scanTime,
    score,
    totals: { ...results.totals },
  });
  if (_scanHistory.length > MAX_HISTORY) {
    _scanHistory.length = MAX_HISTORY;
  }

  return results;
}

/**
 * Get the latest compliance scan results.
 *
 * @returns {Object|null} Latest scan results including findings array, score,
 *   scanTime, and summary by category. Returns null if no scan has been run.
 */
export function getComplianceResults() {
  return _latestResults;
}

/**
 * Get the numeric compliance score from the latest scan.
 *
 * @returns {number|null} Compliance score (0-100), or null if no scan has been run.
 */
export function getComplianceScore() {
  if (!_latestResults) return null;
  return _latestResults.score;
}

/**
 * Get historical compliance scores with timestamps.
 *
 * @returns {Array<{scanTime: string, score: number, totals: Object}>}
 *   Array of historical scan results, most recent first. Maximum 50 entries.
 */
export function getComplianceHistory() {
  return _scanHistory.slice();
}
