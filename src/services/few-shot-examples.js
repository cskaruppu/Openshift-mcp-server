/**
 * Few-Shot Examples for LLM System Prompt Anchoring.
 *
 * Provides per-intent golden input/output pairs that are embedded in the
 * system prompt to anchor LLM response format and quality.  Each example
 * demonstrates the ideal structure, detail level, and command style for a
 * given intent category.
 *
 * Usage:
 *   import { getFewShotExamples } from './few-shot-examples.js';
 *   const block = getFewShotExamples(["pod_issues", "metrics"], "openshift");
 *   // → formatted markdown string with 1-2 reference examples
 */

// ---------------------------------------------------------------------------
// Platform-aware CLI prefix
// ---------------------------------------------------------------------------

const CLI_PREFIX = {
  openshift: "oc",
  eks: "kubectl",
  aks: "kubectl",
  gke: "kubectl",
  k8s: "kubectl",
};

function cli(platform) {
  return CLI_PREFIX[platform] || "kubectl";
}

// ---------------------------------------------------------------------------
// Example bank — keyed by intent category
// ---------------------------------------------------------------------------

/**
 * Each entry contains:
 *   title    — short label for the example
 *   intents  — which intent strings this example covers
 *   priority — higher = selected first when multiple intents match
 *   build(platform) — returns { user, assistant } strings
 */
const EXAMPLE_BANK = [
  // (a) diagnose / pod_issues
  {
    title: "Pod Crash Root-Cause Analysis",
    intents: ["diagnose", "pod_issues", "specific_pod"],
    priority: 100,
    build: (platform) => ({
      user: "Why is pod payment-service-abc in namespace checkout crashing?",
      assistant: `### Root Cause Analysis: \`payment-service-abc\` (namespace: checkout)

**Status:** CrashLoopBackOff (12 restarts in the last hour)

**Root Cause:** OOMKilled — the container exceeded its memory limit.

**Evidence:**
- Last termination reason: \`OOMKilled\` (exit code 137)
- Container memory limit: \`256Mi\`
- Peak memory usage before kill: \`254Mi\` (99.2% of limit)
- Logs show a memory leak in the payment reconciliation loop:
  \`\`\`
  WARN  heap usage 241Mi — approaching 256Mi ceiling
  FATAL OutOfMemoryError: Java heap space
  \`\`\`

**Remediation:**
1. Increase the memory limit as an immediate fix:
   \`\`\`
   ${cli(platform)} -n checkout set resources deployment/payment-service --limits=memory=512Mi
   \`\`\`
2. Investigate the memory leak in the reconciliation loop for a permanent fix.
3. Consider adding a \`-XX:MaxRAMPercentage=75.0\` JVM flag if this is a Java service.`,
    }),
  },

  // (b) list / pod_summary
  {
    title: "Pod Listing with Status Table",
    intents: ["list", "pod_summary"],
    priority: 90,
    build: (platform) => ({
      user: "List all pods in namespace production",
      assistant: `### Pods in namespace \`production\`

| Name | Status | Restarts | Age | Node |
|------|--------|----------|-----|------|
| api-gateway-7f8d4b6c9-x2k4m | Running | 0 | 3d | worker-1 |
| cart-service-5c9b8f7d2-hj9t1 | Running | 2 | 1d | worker-2 |
| order-processor-6a4e3c8b1-qw5r | CrashLoopBackOff | 14 | 5h | worker-1 |
| redis-cache-0 | Running | 0 | 7d | worker-3 |

**Summary:** 4 pods total — 3 Running, 1 CrashLoopBackOff

> \`order-processor\` is crash-looping. Run \`${cli(platform)} -n production logs order-processor-6a4e3c8b1-qw5r --previous\` to inspect the last crash.`,
    }),
  },

  // (c) metrics
  {
    title: "Resource Usage Analysis",
    intents: ["metrics"],
    priority: 85,
    build: (platform) => ({
      user: "Which pods are using the most CPU?",
      assistant: `### Top CPU Consumers (cluster-wide)

| Rank | Pod | Namespace | CPU Usage | CPU Limit | % of Limit | Memory Usage |
|------|-----|-----------|-----------|-----------|------------|--------------|
| 1 | ml-training-job-8x4a | data-science | 3.8 cores | 4 cores | 95.0% | 12.1Gi |
| 2 | elasticsearch-data-0 | logging | 2.4 cores | 3 cores | 80.0% | 8.6Gi |
| 3 | kafka-broker-1 | messaging | 1.9 cores | 2 cores | 95.0% | 4.2Gi |
| 4 | api-gateway-7f8d4 | production | 1.2 cores | 2 cores | 60.0% | 1.1Gi |
| 5 | prometheus-0 | monitoring | 0.9 cores | 1 core | 90.0% | 3.8Gi |

**Highlights:**
- **ml-training-job-8x4a** and **kafka-broker-1** are both above 90% of their CPU limits — at risk of throttling.
- Consider scaling out the Kafka brokers or increasing the CPU limit.
- Use \`${cli(platform)} top pods -A --sort-by=cpu\` for a live snapshot.`,
    }),
  },

  // (d) security
  {
    title: "Namespace Security Audit",
    intents: ["security"],
    priority: 80,
    build: (platform) => {
      const sccNote = platform === "openshift"
        ? "\n- **[Medium]** 2 pods use the `anyuid` SCC — restrict to `restricted` SCC where possible."
        : "";
      return {
        user: "Run a security audit on namespace frontend",
        assistant: `### Security Audit: namespace \`frontend\`

#### Critical
- **Containers running as root:** \`admin-panel-6b8c2\` runs as UID 0. Set \`runAsNonRoot: true\` in the pod security context.
- **Missing network policies:** No NetworkPolicy objects found — all ingress/egress traffic is unrestricted.

#### High
- **Privileged containers:** \`debug-tools-9f3a1\` has \`privileged: true\`. Remove unless absolutely necessary.
- **Secrets mounted as environment variables:** \`api-server-4d7e\` exposes DB credentials via env vars instead of volume mounts.

#### Medium
- **No resource limits:** 3 of 8 pods have no CPU/memory limits set — risk of noisy-neighbor issues.
- **Image pull policy:** 4 pods use \`imagePullPolicy: IfNotPresent\` with \`:latest\` tag — may run stale images.${sccNote}

#### Remediation Priority
1. Add \`runAsNonRoot: true\` and drop \`privileged\` flag (Critical/High).
2. Create a default-deny NetworkPolicy and whitelist required traffic.
3. Switch secret delivery from env vars to projected volumes.
4. Set resource limits on all workloads.`,
      };
    },
  },

  // (e) upgrade / cluster_upgrade
  {
    title: "Cluster Upgrade Preflight Assessment",
    intents: ["upgrade", "cluster_upgrade"],
    priority: 75,
    build: (platform) => {
      if (platform === "openshift") {
        return {
          user: "Can I upgrade to 4.15?",
          assistant: `### Upgrade Preflight: OpenShift 4.14.8 -> 4.15

#### Preflight Checklist

| Check | Status | Detail |
|-------|--------|--------|
| Upgrade path valid | PASS | 4.14.8 -> 4.15.2 is a supported path |
| ClusterOperators healthy | PASS | All 32 operators Available, not Degraded |
| Nodes ready | WARN | 1 of 12 nodes in \`NotReady\` (worker-7) |
| Etcd health | PASS | All 3 members healthy, DB size 142MB |
| API deprecations | WARN | 2 APIs removed in 4.15: \`flowcontrol.apiserver.k8s.io/v1beta2\` used by 1 FlowSchema |
| PodDisruptionBudgets | PASS | All PDBs allow at least 1 disruption |
| Cluster storage | PASS | All PVs bound, no pending claims |
| Certificate expiry | PASS | Nearest cert expiry in 47 days |

#### Blockers
- **worker-7** is \`NotReady\` — investigate with \`oc describe node worker-7\` before proceeding.
- **Deprecated APIs** — migrate \`flowcontrol.apiserver.k8s.io/v1beta2\` to \`v1\` before upgrade.

#### Recommendation
Resolve the 2 warnings above, then proceed with: \`oc adm upgrade --to=4.15.2\``,
        };
      }
      const cliBin = cli(platform);
      const versionLabel = platform === "eks" ? "1.29" : platform === "aks" ? "1.29" : platform === "gke" ? "1.29" : "1.29";
      const upgradeCmd = platform === "eks"
        ? "eksctl upgrade cluster --name=my-cluster --version=1.29"
        : `${cliBin} upgrade apply --target=${versionLabel}`;
      return {
        user: `Can I upgrade to ${versionLabel}?`,
        assistant: `### Upgrade Preflight: Kubernetes -> ${versionLabel}

#### Preflight Checklist

| Check | Status | Detail |
|-------|--------|--------|
| Upgrade path valid | PASS | Current version supports upgrade to ${versionLabel} |
| Nodes ready | PASS | All 8 nodes Ready |
| API deprecations | WARN | \`autoscaling/v2beta1\` removed in ${versionLabel} — used by 2 HPAs |
| PodDisruptionBudgets | PASS | All PDBs allow at least 1 disruption |
| Add-ons compatible | PASS | CoreDNS, kube-proxy compatible |

#### Blockers
- **Deprecated APIs** — migrate \`autoscaling/v2beta1\` to \`autoscaling/v2\` before upgrade.

#### Recommendation
Resolve the API deprecation, then run: \`${upgradeCmd}\``,
      };
    },
  },

  // (f) capacity
  {
    title: "Cluster Capacity Analysis",
    intents: ["capacity"],
    priority: 70,
    build: (platform) => ({
      user: "What's my cluster capacity?",
      assistant: `### Cluster Capacity Overview

| Node | Role | CPU (used/total) | CPU % | Memory (used/total) | Mem % | Pods (used/max) |
|------|------|------------------|-------|---------------------|-------|-----------------|
| worker-1 | worker | 6.2 / 8 cores | 77% | 12.4 / 16Gi | 78% | 38 / 110 |
| worker-2 | worker | 3.1 / 8 cores | 39% | 8.2 / 16Gi | 51% | 22 / 110 |
| worker-3 | worker | 7.5 / 8 cores | 94% | 14.9 / 16Gi | 93% | 45 / 110 |
| master-1 | control-plane | 1.8 / 4 cores | 45% | 5.6 / 8Gi | 70% | 28 / 110 |

**Cluster Totals:** 18.6 / 28 cores (66%), 41.1 / 56Gi (73%)

**Alerts:**
- **worker-3** is at 94% CPU and 93% memory — near saturation. Schedule no new workloads here.
- Overall cluster has ~9 cores and ~15Gi headroom for new workloads.

**Recommendation:** Add a worker node or redistribute pods from worker-3 using \`${cli(platform)} cordon worker-3\` followed by \`${cli(platform)} drain worker-3 --ignore-daemonsets --delete-emptydir-data\`.`,
    }),
  },

  // (g) gitops
  {
    title: "ArgoCD Application Status",
    intents: ["gitops"],
    priority: 65,
    build: (platform) => ({
      user: "Show ArgoCD app status",
      assistant: `### ArgoCD Application Status

| Application | Project | Sync Status | Health | Last Sync | Repo |
|-------------|---------|-------------|--------|-----------|------|
| frontend-app | default | Synced | Healthy | 12m ago | github.com/org/frontend |
| backend-api | default | OutOfSync | Healthy | 3h ago | github.com/org/backend |
| payment-svc | payments | Synced | Degraded | 45m ago | github.com/org/payments |
| monitoring | infra | Synced | Healthy | 1d ago | github.com/org/infra |

**Issues:**
- **backend-api** is \`OutOfSync\` — 2 resources differ from Git (ConfigMap \`api-config\`, Deployment replicas).
  Sync with: \`argocd app sync backend-api\`
- **payment-svc** is \`Degraded\` — the app is synced but 1 pod is unhealthy.
  Check pod health: \`${cli(platform)} -n payments get pods -l app=payment-svc\``,
    }),
  },

  // (h) triage
  {
    title: "Failing Pod Triage",
    intents: ["triage"],
    priority: 85,
    build: (platform) => ({
      user: "Triage failing pods",
      assistant: `### Failing Pod Triage

#### Priority 1 — CrashLoopBackOff (immediate attention)
| Pod | Namespace | Restarts | Last Reason | Since |
|-----|-----------|----------|-------------|-------|
| order-processor-6a4e | checkout | 23 | OOMKilled | 2h |
| payment-worker-8b3c | payments | 15 | Error (exit 1) | 1h |

#### Priority 2 — ImagePullBackOff
| Pod | Namespace | Image | Error |
|-----|-----------|-------|-------|
| new-feature-deploy-f2a1 | staging | registry.io/app:v2.1.0 | unauthorized: authentication required |

#### Priority 3 — Pending (unschedulable)
| Pod | Namespace | Reason | Detail |
|-----|-----------|--------|--------|
| ml-batch-job-9c8d | data-science | Insufficient cpu | Requests 4 cores, max available node has 1.5 free |

**Summary:** 4 failing pods across 4 namespaces.

**Recommended Actions:**
1. Increase memory limit for \`order-processor\`: \`${cli(platform)} -n checkout set resources deployment/order-processor --limits=memory=512Mi\`
2. Check application logs for \`payment-worker\`: \`${cli(platform)} -n payments logs payment-worker-8b3c --previous\`
3. Fix image pull credentials for \`staging\` namespace.
4. Free up CPU or scale the cluster to schedule \`ml-batch-job\`.`,
    }),
  },

  // (i) rightsize / optimize
  {
    title: "Resource Right-Sizing Recommendations",
    intents: ["rightsize", "optimize"],
    priority: 75,
    build: (platform) => ({
      user: "Which pods are overprovisioned?",
      assistant: `### Right-Sizing Recommendations

| Pod | Namespace | Resource | Current Request | Current Limit | P95 Usage | Recommended Request | Recommended Limit | Savings |
|-----|-----------|----------|-----------------|---------------|-----------|---------------------|--------------------|---------|
| web-frontend-5d8a | production | CPU | 1 core | 2 cores | 120m | 200m | 500m | 75% |
| web-frontend-5d8a | production | Memory | 1Gi | 2Gi | 280Mi | 350Mi | 700Mi | 65% |
| cache-warmer-3f2b | production | CPU | 500m | 1 core | 45m | 100m | 250m | 80% |
| batch-reporter-7e1c | analytics | Memory | 4Gi | 8Gi | 1.2Gi | 1.5Gi | 3Gi | 63% |

**Estimated Cluster Savings:** 2.7 cores CPU, 6.5Gi memory (recoverable for other workloads)

**How to apply (example for web-frontend):**
\`\`\`
${cli(platform)} -n production set resources deployment/web-frontend \\
  --requests=cpu=200m,memory=350Mi \\
  --limits=cpu=500m,memory=700Mi
\`\`\`

> Recommendations are based on 7-day P95 usage data. Review during peak-traffic windows before applying.`,
    }),
  },

  // (j) alerts
  {
    title: "Active Alert Analysis",
    intents: ["alerts"],
    priority: 70,
    build: (platform) => ({
      user: "What alerts are firing?",
      assistant: `### Firing Alerts

#### Critical (1)
| Alert | Namespace | Since | Summary |
|-------|-----------|-------|---------|
| KubePodCrashLooping | checkout | 2h ago | Pod \`order-processor\` has restarted 23 times |

#### Warning (3)
| Alert | Namespace | Since | Summary |
|-------|-----------|-------|---------|
| KubeMemoryOvercommit | — | 45m ago | Cluster memory overcommit ratio is 1.4 (threshold: 1.2) |
| CPUThrottlingHigh | payments | 1h ago | 67% throttling on \`payment-worker\` |
| KubePersistentVolumeFillingUp | logging | 3h ago | PVC \`elasticsearch-data\` is 89% full, predicted full in 2d |

#### Info (1)
| Alert | Namespace | Since | Summary |
|-------|-----------|-------|---------|
| KubeVersionMismatch | — | 12h ago | Node kubelet versions differ (1.28.3 vs 1.28.5) |

**Recommended Actions:**
1. **KubePodCrashLooping:** Check pod logs: \`${cli(platform)} -n checkout logs order-processor --previous\`
2. **KubeMemoryOvercommit:** Review resource requests or add a worker node.
3. **CPUThrottlingHigh:** Increase CPU limit for \`payment-worker\` or optimize hot paths.
4. **PV filling up:** Expand the PVC or configure log rotation for Elasticsearch.`,
    }),
  },
];

// ---------------------------------------------------------------------------
// Intent-to-example matching
// ---------------------------------------------------------------------------

/**
 * Intent priority order — intents listed first take precedence when selecting
 * examples.  This drives which example is picked when a user's query matches
 * multiple intent categories.
 */
const INTENT_PRIORITY = [
  "diagnose", "pod_issues", "specific_pod",
  "triage",
  "list", "pod_summary",
  "metrics",
  "security",
  "upgrade", "cluster_upgrade",
  "capacity",
  "gitops",
  "rightsize", "optimize",
  "alerts",
];

/**
 * Returns a formatted string of 1-2 few-shot examples matching the detected
 * intents, suitable for embedding in an LLM system prompt.
 *
 * @param {string[]} intents  — array of intent strings, e.g. ["pod_issues", "specific_pod"]
 * @param {string}   platform — one of "openshift", "eks", "aks", "gke", "k8s"
 * @returns {string} formatted markdown block, or empty string if no match
 */
export function getFewShotExamples(intents, platform = "openshift") {
  if (!intents || intents.length === 0) return "";

  const normalizedPlatform = (platform || "openshift").toLowerCase();
  const intentSet = new Set(intents.map((i) => i.toLowerCase()));

  // Score each example by how well it matches the provided intents,
  // weighted by intent priority position.
  const scored = [];
  for (const example of EXAMPLE_BANK) {
    let bestScore = -1;
    for (const exIntent of example.intents) {
      if (intentSet.has(exIntent)) {
        const priorityIdx = INTENT_PRIORITY.indexOf(exIntent);
        // Lower index = higher priority; convert to a score
        const priorityScore = priorityIdx >= 0
          ? (INTENT_PRIORITY.length - priorityIdx) * 10
          : 1;
        const score = example.priority + priorityScore;
        if (score > bestScore) bestScore = score;
      }
    }
    if (bestScore > 0) {
      scored.push({ example, score: bestScore });
    }
  }

  if (scored.length === 0) return "";

  // Sort descending by score, take top 2
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, 2);

  // Deduplicate — if both point to the same example bank entry, keep only one
  const seen = new Set();
  const unique = [];
  for (const s of selected) {
    if (!seen.has(s.example.title)) {
      seen.add(s.example.title);
      unique.push(s);
    }
  }

  // Build formatted output
  const blocks = unique.map(({ example }) => {
    const { user, assistant } = example.build(normalizedPlatform);
    return `### Example: ${example.title}\n**User:** ${user}\n**Assistant:** ${assistant}`;
  });

  return `## Reference Examples\n\n${blocks.join("\n\n---\n\n")}`;
}
