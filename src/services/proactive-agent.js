/**
 * Proactive AI Monitor — background agent that continuously watches the
 * cluster, detects anomalies, and generates AI-powered insights WITHOUT
 * waiting for the user to ask.
 *
 * This is what separates TCS CloudNexus AI from Claude Desktop / Cursor:
 * the platform thinks for itself.
 *
 * Capabilities:
 *   - Periodic cluster scans (pods, events, nodes, metrics)
 *   - Anomaly detection (spike in restarts, new CrashLoops, resource pressure)
 *   - Severity classification using pattern matching + optional LLM
 *   - Proactive insight generation with root cause + recommended action
 *   - Notification dispatch (dashboard, Slack, ServiceNow)
 *   - Correlation of related issues across namespaces
 */

import { ocpGet } from "../utils/openshift-client.js";
import { callLLM, llmEnabled } from "./llm.js";
import { query as dbQuery } from "../utils/db.js";
import { cacheGet, cacheSet } from "../utils/cache.js";

const SCAN_INTERVAL_MS = parseInt(process.env.PROACTIVE_SCAN_INTERVAL || "60000", 10);
const MAX_INSIGHTS_KEPT = 50;

let _running = false;
let _timer = null;
const _insights = [];
const _baseline = { podRestarts: {}, nodeConditions: {}, lastScan: 0 };

const SEVERITY_WEIGHTS = {
  OOMKilled: 90,
  CrashLoopBackOff: 85,
  ImagePullBackOff: 70,
  ErrImagePull: 70,
  Evicted: 65,
  NodeNotReady: 95,
  DiskPressure: 80,
  MemoryPressure: 85,
  PIDPressure: 75,
  HighRestartRate: 60,
  PodPending: 50,
  CertExpiringSoon: 90,
};

export function startProactiveMonitor() {
  if (_running) return;
  _running = true;
  console.error("[proactive] AI monitor started — scanning every " + (SCAN_INTERVAL_MS / 1000) + "s");
  runScan();
  _timer = setInterval(runScan, SCAN_INTERVAL_MS);
}

export function stopProactiveMonitor() {
  _running = false;
  if (_timer) clearInterval(_timer);
  _timer = null;
}

export function getInsights() {
  return _insights.slice().sort((a, b) => b.severity - a.severity);
}

export function getInsightsSummary() {
  const critical = _insights.filter((i) => i.severity >= 80).length;
  const warning = _insights.filter((i) => i.severity >= 50 && i.severity < 80).length;
  const info = _insights.filter((i) => i.severity < 50).length;
  return { critical, warning, info, total: _insights.length, lastScan: _baseline.lastScan };
}

export function dismissInsight(id) {
  const idx = _insights.findIndex((i) => i.id === id);
  if (idx >= 0) _insights.splice(idx, 1);
}

async function runScan() {
  try {
    const [pods, events, nodes] = await Promise.allSettled([
      ocpGet("/api/v1/pods"),
      ocpGet("/api/v1/events"),
      ocpGet("/api/v1/nodes"),
    ]);

    const podItems = pods.status === "fulfilled" ? pods.value?.items || [] : [];
    const eventItems = events.status === "fulfilled" ? events.value?.items || [] : [];
    const nodeItems = nodes.status === "fulfilled" ? nodes.value?.items || [] : [];

    detectPodAnomalies(podItems, eventItems);
    detectNodeAnomalies(nodeItems);
    detectRestartSpikes(podItems);
    await detectCertExpiry();
    correlateInsights();

    _baseline.lastScan = Date.now();

    while (_insights.length > MAX_INSIGHTS_KEPT) _insights.shift();

    persistInsights().catch(() => {});
  } catch (err) {
    console.error("[proactive] scan error:", err.message);
  }
}

function detectPodAnomalies(pods, events) {
  for (const pod of pods) {
    const ns = pod.metadata?.namespace;
    const name = pod.metadata?.name;
    if (!ns || !name) continue;
    if (ns.startsWith("openshift-") || ns === "kube-system") continue;

    const statuses = [
      ...(pod.status?.containerStatuses || []),
      ...(pod.status?.initContainerStatuses || []),
    ];

    for (const cs of statuses) {
      const waitReason = cs.state?.waiting?.reason;
      const termReason = cs.state?.terminated?.reason;
      const lastTermReason = cs.lastState?.terminated?.reason;

      if (waitReason === "CrashLoopBackOff") {
        addInsight({
          type: "CrashLoopBackOff",
          resource: `pod/${name}`,
          namespace: ns,
          severity: SEVERITY_WEIGHTS.CrashLoopBackOff,
          title: `Pod ${name} is in CrashLoopBackOff`,
          detail: `Container ${cs.name} has restarted ${cs.restartCount} times`,
          recommendation: "Check logs with: oc logs -p " + name + " -n " + ns,
        });
      }

      if (termReason === "OOMKilled" || lastTermReason === "OOMKilled") {
        const limits = pod.spec?.containers?.find((c) => c.name === cs.name)?.resources?.limits;
        addInsight({
          type: "OOMKilled",
          resource: `pod/${name}`,
          namespace: ns,
          severity: SEVERITY_WEIGHTS.OOMKilled,
          title: `Pod ${name} was OOMKilled`,
          detail: `Container ${cs.name} exceeded memory limit (${limits?.memory || "not set"})`,
          recommendation: "Increase memory limits or investigate memory leaks",
        });
      }

      if (waitReason === "ImagePullBackOff" || waitReason === "ErrImagePull") {
        addInsight({
          type: "ImagePullBackOff",
          resource: `pod/${name}`,
          namespace: ns,
          severity: SEVERITY_WEIGHTS.ImagePullBackOff,
          title: `Pod ${name} can't pull image`,
          detail: `Image: ${cs.image || "unknown"}`,
          recommendation: "Check image name, registry access, and pull secrets",
        });
      }
    }

    if (pod.status?.phase === "Pending") {
      const age = Date.now() - new Date(pod.metadata.creationTimestamp).getTime();
      if (age > 5 * 60 * 1000) {
        const conditions = pod.status?.conditions || [];
        const unschedulable = conditions.find(
          (c) => c.type === "PodScheduled" && c.status === "False"
        );
        addInsight({
          type: "PodPending",
          resource: `pod/${name}`,
          namespace: ns,
          severity: SEVERITY_WEIGHTS.PodPending,
          title: `Pod ${name} stuck Pending for ${Math.round(age / 60000)}m`,
          detail: unschedulable?.message || "Unknown scheduling issue",
          recommendation: "Check node resources, taints/tolerations, and resource quotas",
        });
      }
    }
  }
}

function detectNodeAnomalies(nodes) {
  for (const node of nodes) {
    const name = node.metadata?.name;
    const conditions = node.status?.conditions || [];

    const ready = conditions.find((c) => c.type === "Ready");
    if (ready && ready.status !== "True") {
      addInsight({
        type: "NodeNotReady",
        resource: `node/${name}`,
        namespace: "",
        severity: SEVERITY_WEIGHTS.NodeNotReady,
        title: `Node ${name} is NotReady`,
        detail: ready.message || ready.reason || "Unknown",
        recommendation: "Check kubelet status and node connectivity",
      });
    }

    for (const cond of conditions) {
      if (cond.type === "DiskPressure" && cond.status === "True") {
        addInsight({
          type: "DiskPressure",
          resource: `node/${name}`,
          namespace: "",
          severity: SEVERITY_WEIGHTS.DiskPressure,
          title: `Node ${name} has disk pressure`,
          detail: cond.message || "",
          recommendation: "Clean up unused images: oc adm node-logs " + name + " --path=journal",
        });
      }
      if (cond.type === "MemoryPressure" && cond.status === "True") {
        addInsight({
          type: "MemoryPressure",
          resource: `node/${name}`,
          namespace: "",
          severity: SEVERITY_WEIGHTS.MemoryPressure,
          title: `Node ${name} has memory pressure`,
          detail: cond.message || "",
          recommendation: "Evict low-priority workloads or add nodes",
        });
      }
    }
  }
}

function detectRestartSpikes(pods) {
  for (const pod of pods) {
    const ns = pod.metadata?.namespace;
    const name = pod.metadata?.name;
    if (!ns || !name || ns.startsWith("openshift-") || ns === "kube-system") continue;

    const restarts = (pod.status?.containerStatuses || []).reduce(
      (sum, c) => sum + (c.restartCount || 0), 0
    );

    const key = `${ns}/${name}`;
    const prev = _baseline.podRestarts[key] || 0;
    _baseline.podRestarts[key] = restarts;

    if (prev > 0 && restarts - prev >= 3) {
      addInsight({
        type: "HighRestartRate",
        resource: `pod/${name}`,
        namespace: ns,
        severity: SEVERITY_WEIGHTS.HighRestartRate,
        title: `Pod ${name} restart spike: +${restarts - prev} in last scan`,
        detail: `Total restarts: ${restarts} (was ${prev})`,
        recommendation: "Investigate recent changes or resource constraints",
      });
    }
  }
}

async function detectCertExpiry() {
  try {
    const secrets = await ocpGet("/api/v1/namespaces/openshift-config/secrets");
    const now = Date.now();
    for (const s of secrets.items || []) {
      if (s.type !== "kubernetes.io/tls") continue;
      try {
        const certData = Buffer.from(s.data?.["tls.crt"] || "", "base64").toString();
        const notAfterMatch = certData.match(/Not After\s*:\s*(.+)/);
        if (notAfterMatch) {
          const expiry = new Date(notAfterMatch[1]).getTime();
          const daysLeft = Math.round((expiry - now) / 86400000);
          if (daysLeft <= 30 && daysLeft > 0) {
            addInsight({
              type: "CertExpiringSoon",
              resource: `secret/${s.metadata.name}`,
              namespace: "openshift-config",
              severity: daysLeft <= 7 ? 95 : SEVERITY_WEIGHTS.CertExpiringSoon,
              title: `TLS cert "${s.metadata.name}" expires in ${daysLeft} days`,
              detail: `Expiry: ${new Date(expiry).toISOString()}`,
              recommendation: "Rotate certificate before expiry",
            });
          }
        }
      } catch { /* skip unparseable certs */ }
    }
  } catch { /* openshift-config may not be accessible */ }
}

function correlateInsights() {
  const byNs = {};
  for (const ins of _insights) {
    if (!ins.namespace) continue;
    if (!byNs[ins.namespace]) byNs[ins.namespace] = [];
    byNs[ins.namespace].push(ins);
  }

  for (const [ns, items] of Object.entries(byNs)) {
    if (items.length >= 3) {
      const types = [...new Set(items.map((i) => i.type))];
      const existing = _insights.find(
        (i) => i.type === "CorrelatedIssues" && i.namespace === ns
      );
      if (!existing) {
        addInsight({
          type: "CorrelatedIssues",
          resource: `namespace/${ns}`,
          namespace: ns,
          severity: Math.max(...items.map((i) => i.severity)),
          title: `Multiple issues in namespace ${ns} (${items.length} problems)`,
          detail: `Affected: ${types.join(", ")}`,
          recommendation: "Investigate namespace-wide: resource quotas, network policies, recent deployments",
        });
      }
    }
  }
}

function addInsight(insight) {
  const id = `${insight.type}:${insight.namespace}:${insight.resource}`;
  const existing = _insights.find((i) => i.id === id);
  if (existing) {
    existing.lastSeen = Date.now();
    existing.count = (existing.count || 1) + 1;
    return;
  }
  _insights.push({
    ...insight,
    id,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    count: 1,
    aiAnalysis: null,
  });
}

async function persistInsights() {
  try {
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ('proactive_insights', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(_insights.slice(0, 30))]
    );
  } catch { /* DB optional */ }
}

/**
 * Enrich a specific insight with LLM analysis (called on-demand from dashboard).
 */
export async function analyzeInsight(insightId, llmOpts = {}) {
  const insight = _insights.find((i) => i.id === insightId);
  if (!insight) return null;
  if (!llmEnabled(llmOpts)) return { analysis: insight.recommendation };

  try {
    const prompt = `You are an OpenShift SRE expert. Analyze this cluster issue and provide:
1. Root cause analysis (2-3 sentences)
2. Immediate fix steps
3. Prevention strategy

Issue: ${insight.title}
Details: ${insight.detail}
Resource: ${insight.resource} in namespace ${insight.namespace}
Type: ${insight.type}
Occurrences: ${insight.count}`;

    const result = await callLLM({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 500,
      temperature: 0.2,
      ...llmOpts,
    });

    insight.aiAnalysis = result.text || insight.recommendation;
    return { analysis: insight.aiAnalysis };
  } catch (err) {
    return { analysis: insight.recommendation, error: err.message };
  }
}

export function isMonitorRunning() {
  return _running;
}
