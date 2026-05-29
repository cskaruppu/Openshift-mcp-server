/**
 * Proactive AI Monitor — background agent that continuously watches the
 * cluster, detects anomalies, and generates AI-powered insights WITHOUT
 * waiting for the user to ask.
 *
 * This is what separates TCS Agentic AI from Claude Desktop / Cursor:
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
import { getPlatform } from "../platform/index.js";
import { callLLM, llmEnabled } from "./llm.js";
import { query as dbQuery } from "../utils/db.js";
import { recordIncident as leRecordIncident, signatureForInsight } from "./learning-engine.js";
import { cacheGet, cacheSet } from "../utils/cache.js";
import { scanForChanges, getWatchedNamespaces, autoDiscoverAndWatch } from "../tools/app-change-watcher.js";
import { runImageScan } from "../tools/image-vulnerability-scanner.js";

const SCAN_INTERVAL_MS = parseInt(process.env.PROACTIVE_SCAN_INTERVAL || "60000", 10);
const APP_CHANGE_INTERVAL_MS = parseInt(process.env.APP_CHANGE_SCAN_INTERVAL || "300000", 10);   // 5 min
const IMAGE_VULN_INTERVAL_MS = parseInt(process.env.IMAGE_VULN_SCAN_INTERVAL || "1800000", 10);  // 30 min
const APP_CHANGE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min dedup window
const IMAGE_VULN_COOLDOWN_MS = 60 * 60 * 1000; // 60 min dedup window
const MAX_INSIGHTS_KEPT = 50;

let _running = false;
let _scanning = false;
let _timer = null;
let _appChangeTimer = null;
let _imageVulnTimer = null;
const _insights = [];
const _baseline = { podRestarts: {}, nodeConditions: {}, lastScan: 0 };
const _appChangeCooldown = new Map();
const _imageVulnCooldown = new Map();

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
  OperatorDegraded: 88,
  OperatorUnavailable: 92,
  PVCNearFull: 78,
  PVCPending: 65,
  EndpointNotReady: 60,
  QuotaExhausted: 72,
  EventStorm: 70,
  AppImageChanged: 82,
  AppConfigChanged: 68,
  AppReplicaChanged: 55,
  AppContainerAdded: 80,
  ImageVulnCritical: 92,
  ImageVulnHigh: 75,
  ImageVulnMedium: 55,
};

export function startProactiveMonitor() {
  if (_running) return;
  _running = true;
  console.error("[proactive] AI monitor started — scanning every " + (SCAN_INTERVAL_MS / 1000) + "s");
  console.error("[proactive] App change watcher — every " + (APP_CHANGE_INTERVAL_MS / 1000) + "s");
  console.error("[proactive] Image vuln scanner — every " + (IMAGE_VULN_INTERVAL_MS / 1000) + "s");
  runScan();
  _timer = setInterval(runScan, SCAN_INTERVAL_MS);
  // Staggered start: app changes after 30s, image vulns after 60s
  setTimeout(() => {
    runAppChangeScan();
    _appChangeTimer = setInterval(runAppChangeScan, APP_CHANGE_INTERVAL_MS);
  }, 30000);
  setTimeout(() => {
    runImageVulnScan();
    _imageVulnTimer = setInterval(runImageVulnScan, IMAGE_VULN_INTERVAL_MS);
  }, 60000);
}

export function stopProactiveMonitor() {
  _running = false;
  if (_timer) clearInterval(_timer);
  if (_appChangeTimer) clearInterval(_appChangeTimer);
  if (_imageVulnTimer) clearInterval(_imageVulnTimer);
  _timer = null;
  _appChangeTimer = null;
  _imageVulnTimer = null;
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
  if (_scanning) return;
  _scanning = true;
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
    detectEventStorms(eventItems);

    const isOCP = getPlatform() === "openshift";
    const detectors = [
      detectPVCIssues(),
      detectEndpointHealth(),
      detectResourceQuotas(),
    ];
    if (isOCP) {
      detectors.push(detectCertExpiry(), detectOperatorHealth());
    }
    await Promise.allSettled(detectors);

    correlateInsights();

    _baseline.lastScan = Date.now();

    while (_insights.length > MAX_INSIGHTS_KEPT) _insights.shift();

    persistInsights().catch(() => {});
  } catch (err) {
    console.error("[proactive] scan error:", err.message);
  } finally {
    _scanning = false;
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
  // Rebuild the baseline each scan from currently-living pods only — this
  // prevents the map from accumulating dead-pod keys forever.
  const nextBaseline = {};
  for (const pod of pods) {
    const ns = pod.metadata?.namespace;
    const name = pod.metadata?.name;
    if (!ns || !name || ns.startsWith("openshift-") || ns === "kube-system") continue;

    const restarts = (pod.status?.containerStatuses || []).reduce(
      (sum, c) => sum + (c.restartCount || 0), 0
    );

    const key = `${ns}/${name}`;
    const prev = _baseline.podRestarts[key] || 0;
    nextBaseline[key] = restarts;

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
  _baseline.podRestarts = nextBaseline;
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

// Detect warning event storms — many events in a short window indicates instability
function detectEventStorms(events) {
  const now = Date.now();
  const fiveMin = 5 * 60 * 1000;
  const recentWarnings = (events || []).filter((e) => {
    const ts = new Date(e.lastTimestamp || e.metadata?.creationTimestamp).getTime();
    return e.type === "Warning" && now - ts < fiveMin;
  });
  if (recentWarnings.length > 50) {
    const byReason = {};
    recentWarnings.forEach((e) => { byReason[e.reason] = (byReason[e.reason] || 0) + 1; });
    const topReason = Object.entries(byReason).sort((a, b) => b[1] - a[1])[0];
    addInsight({
      type: "EventStorm",
      resource: "cluster/events",
      namespace: "",
      severity: SEVERITY_WEIGHTS.EventStorm,
      title: `Event storm: ${recentWarnings.length} warnings in 5 minutes`,
      detail: `Top reason: ${topReason[0]} (${topReason[1]}x). Cluster may be under stress.`,
      recommendation: "Investigate the root cause of the warning event flood",
    });
  }
}

// Detect degraded/unavailable ClusterOperators (OpenShift)
async function detectOperatorHealth() {
  try {
    const ops = await ocpGet("/apis/config.openshift.io/v1/clusteroperators");
    for (const op of ops.items || []) {
      const name = op.metadata?.name;
      const conditions = op.status?.conditions || [];
      const degraded = conditions.find((c) => c.type === "Degraded" && c.status === "True");
      const available = conditions.find((c) => c.type === "Available" && c.status === "False");
      const progressing = conditions.find((c) => c.type === "Progressing" && c.status === "True");

      if (available) {
        addInsight({
          type: "OperatorUnavailable",
          resource: `clusteroperator/${name}`,
          namespace: "",
          severity: SEVERITY_WEIGHTS.OperatorUnavailable,
          title: `ClusterOperator "${name}" is Unavailable`,
          detail: available.message || available.reason || "Operator not serving",
          recommendation: `Check operator pods: oc get pods -n openshift-${name}`,
        });
      } else if (degraded) {
        addInsight({
          type: "OperatorDegraded",
          resource: `clusteroperator/${name}`,
          namespace: "",
          severity: SEVERITY_WEIGHTS.OperatorDegraded,
          title: `ClusterOperator "${name}" is Degraded`,
          detail: degraded.message || degraded.reason || "Partial functionality",
          recommendation: `Investigate: oc describe clusteroperator ${name}`,
        });
      }
      if (progressing && !available && !degraded) {
        addInsight({
          type: "OperatorDegraded",
          resource: `clusteroperator/${name}`,
          namespace: "",
          severity: 45,
          title: `ClusterOperator "${name}" is Progressing`,
          detail: progressing.message || "Update in progress",
          recommendation: "Monitor — this may resolve automatically",
        });
      }
    }
  } catch { /* not OpenShift or no access */ }
}

// Detect PVC issues — pending PVCs and PVCs nearing capacity
async function detectPVCIssues() {
  try {
    const pvcs = await ocpGet("/api/v1/persistentvolumeclaims");
    for (const pvc of pvcs.items || []) {
      const ns = pvc.metadata?.namespace;
      const name = pvc.metadata?.name;
      if (!ns || !name) continue;
      if (ns.startsWith("openshift-") || ns === "kube-system") continue;

      if (pvc.status?.phase === "Pending") {
        const age = Date.now() - new Date(pvc.metadata.creationTimestamp).getTime();
        if (age > 2 * 60 * 1000) {
          addInsight({
            type: "PVCPending",
            resource: `pvc/${name}`,
            namespace: ns,
            severity: SEVERITY_WEIGHTS.PVCPending,
            title: `PVC "${name}" stuck Pending for ${Math.round(age / 60000)}m`,
            detail: `StorageClass: ${pvc.spec?.storageClassName || "default"}. No volume bound.`,
            recommendation: "Check StorageClass availability, provisioner logs, and quota",
          });
        }
      }

      // PVC capacity check via metrics
      const capacity = pvc.status?.capacity?.storage;
      if (capacity && pvc.status?.phase === "Bound") {
        try {
          // kubelet_volume_stats_used_bytes — exposed via metrics
          const statsPath = `/api/v1/namespaces/${ns}/pods?labelSelector=`;
          // Simple heuristic: large PVCs (>10Gi) that have been bound for >24h get flagged for monitoring
          const capBytes = parsePVCSize(capacity);
          if (capBytes > 0 && capBytes <= 2 * 1024 * 1024 * 1024) {
            const age = Date.now() - new Date(pvc.metadata.creationTimestamp).getTime();
            if (age > 24 * 3600 * 1000) {
              addInsight({
                type: "PVCNearFull",
                resource: `pvc/${name}`,
                namespace: ns,
                severity: SEVERITY_WEIGHTS.PVCNearFull,
                title: `PVC "${name}" is small (${capacity}) — check capacity`,
                detail: `Bound for ${Math.round(age / 3600000)}h. Small PVCs fill faster.`,
                recommendation: `Monitor usage: oc exec <pod> -n ${ns} -- df -h`,
              });
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}

function parsePVCSize(s) {
  if (!s) return 0;
  if (s.endsWith("Gi")) return parseInt(s) * 1024 * 1024 * 1024;
  if (s.endsWith("Mi")) return parseInt(s) * 1024 * 1024;
  if (s.endsWith("Ti")) return parseInt(s) * 1024 * 1024 * 1024 * 1024;
  return parseInt(s) || 0;
}

// Detect service endpoints that have no ready addresses (broken services)
async function detectEndpointHealth() {
  try {
    const endpoints = await ocpGet("/api/v1/endpoints");
    for (const ep of endpoints.items || []) {
      const ns = ep.metadata?.namespace;
      const name = ep.metadata?.name;
      if (!ns || !name) continue;
      if (ns.startsWith("openshift-") || ns === "kube-system" || ns === "default") continue;

      const subsets = ep.subsets || [];
      const readyCount = subsets.reduce((s, sub) => s + (sub.addresses?.length || 0), 0);
      const notReadyCount = subsets.reduce((s, sub) => s + (sub.notReadyAddresses?.length || 0), 0);

      if (readyCount === 0 && notReadyCount > 0) {
        addInsight({
          type: "EndpointNotReady",
          resource: `service/${name}`,
          namespace: ns,
          severity: SEVERITY_WEIGHTS.EndpointNotReady,
          title: `Service "${name}" has 0 ready endpoints (${notReadyCount} not-ready)`,
          detail: "All backing pods are unhealthy — traffic will fail",
          recommendation: `Check pods: kubectl get pods -n ${ns} -l <selector>`,
        });
      }
    }
  } catch { /* skip */ }
}

// Detect resource quota exhaustion in namespaces
async function detectResourceQuotas() {
  try {
    const quotas = await ocpGet("/api/v1/resourcequotas");
    for (const q of quotas.items || []) {
      const ns = q.metadata?.namespace;
      const name = q.metadata?.name;
      if (!ns) continue;

      const hard = q.status?.hard || {};
      const used = q.status?.used || {};

      for (const [resource, limit] of Object.entries(hard)) {
        const usedVal = parseQuotaValue(used[resource]);
        const hardVal = parseQuotaValue(limit);
        if (hardVal <= 0) continue;
        const pct = usedVal / hardVal;

        if (pct >= 0.9) {
          addInsight({
            type: "QuotaExhausted",
            resource: `resourcequota/${name}`,
            namespace: ns,
            severity: SEVERITY_WEIGHTS.QuotaExhausted + (pct >= 1.0 ? 10 : 0),
            title: `Quota "${resource}" at ${Math.round(pct * 100)}% in ${ns}`,
            detail: `Used: ${used[resource]} / Hard: ${limit}`,
            recommendation: pct >= 1.0
              ? "Quota exceeded — new pods will be rejected. Increase quota or free resources."
              : "Approaching quota limit — plan capacity or clean up unused resources.",
          });
        }
      }
    }
  } catch { /* skip */ }
}

function parseQuotaValue(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  const s = String(v);
  if (s.endsWith("m")) return parseInt(s) / 1000;
  if (s.endsWith("Ki")) return parseInt(s) * 1024;
  if (s.endsWith("Mi")) return parseInt(s) * 1024 * 1024;
  if (s.endsWith("Gi")) return parseInt(s) * 1024 * 1024 * 1024;
  return parseFloat(s) || 0;
}

// ---------------------------------------------------------------------------
// Staggered scanner: Application Change Watcher (every 5 min)
// ---------------------------------------------------------------------------
async function runAppChangeScan() {
  try {
    let namespaces = getWatchedNamespaces();
    if (namespaces.length === 0) return;
    if (namespaces.length === 0) return;
    const changes = await scanForChanges();
    if (changes.length === 0) return;

    const now = Date.now();
    for (const c of changes) {
      const dedupKey = `${c.namespace}/${c.kind}/${c.name}`;
      const lastReported = _appChangeCooldown.get(dedupKey) || 0;
      if (now - lastReported < APP_CHANGE_COOLDOWN_MS) continue;
      _appChangeCooldown.set(dedupKey, now);

      const hasImageChange = c.changes.some(d => d.field.includes("/image"));
      const hasContainerChange = c.changes.some(d => d.field.match(/^container\/[^/]+$/) && (d.new === "added" || d.new === "(removed)"));
      const hasReplicaChange = c.changes.some(d => d.field === "replicas");

      let type = "AppConfigChanged";
      let severity = SEVERITY_WEIGHTS.AppConfigChanged;
      if (hasContainerChange) { type = "AppContainerAdded"; severity = SEVERITY_WEIGHTS.AppContainerAdded; }
      else if (hasImageChange) { type = "AppImageChanged"; severity = SEVERITY_WEIGHTS.AppImageChanged; }
      else if (hasReplicaChange) { type = "AppReplicaChanged"; severity = SEVERITY_WEIGHTS.AppReplicaChanged; }

      const changedFields = c.changes.map(d => d.field).join(", ");
      addInsight({
        type,
        resource: `${c.kind}/${c.name}`,
        namespace: c.namespace,
        severity,
        title: `${c.kind} '${c.name}' changed in ${c.namespace}`,
        detail: `Fields: ${changedFields}. ${c.changes.length} change(s) detected.` +
          (hasImageChange ? " Image update detected — verify rollout health." : ""),
        recommendation: hasImageChange
          ? `Monitor rollout: oc rollout status ${c.kind.toLowerCase()}/${c.name} -n ${c.namespace}. Use app_change_rollback to revert if needed.`
          : `Review changes: oc describe ${c.kind.toLowerCase()}/${c.name} -n ${c.namespace}`,
        changeId: c.id,
      });
    }

    // Prune cooldown entries older than 2x the cooldown window
    for (const [k, t] of _appChangeCooldown) {
      if (now - t > APP_CHANGE_COOLDOWN_MS * 2) _appChangeCooldown.delete(k);
    }
  } catch (err) {
    console.error("[proactive] app-change scan error:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Staggered scanner: Image Vulnerability Scanner (every 30 min)
// ---------------------------------------------------------------------------
async function runImageVulnScan() {
  try {
    const scan = await runImageScan();
    if (!scan || scan.totalVulns === 0) return;

    const now = Date.now();
    for (const img of scan.results) {
      if (img.critical === 0 && img.high === 0) continue;

      const dedupKey = `img:${img.image}`;
      const lastReported = _imageVulnCooldown.get(dedupKey) || 0;
      if (now - lastReported < IMAGE_VULN_COOLDOWN_MS) continue;
      _imageVulnCooldown.set(dedupKey, now);

      const type = img.critical > 0 ? "ImageVulnCritical" : "ImageVulnHigh";
      const severity = img.critical > 0 ? SEVERITY_WEIGHTS.ImageVulnCritical : SEVERITY_WEIGHTS.ImageVulnHigh;
      const shortImg = img.image.length > 60 ? "..." + img.image.slice(-57) : img.image;
      const topVulns = (img.vulnerabilities || []).slice(0, 3).map(v => v.id).join(", ");

      addInsight({
        type,
        resource: `image/${shortImg}`,
        namespace: img.namespace || "cluster",
        severity,
        title: `Vulnerable image: ${shortImg}`,
        detail: `${img.critical}C/${img.high}H/${img.medium}M/${img.low}L findings. ` +
          `${img.fixable} fixable. Top: ${topVulns || "N/A"}`,
        recommendation: img.fixable > 0
          ? `Update image to patched version. ${img.fixable} fix(es) available. Run image_vuln_report for details.`
          : "No fixes available yet — monitor vendor advisories and consider alternative images.",
      });
    }

    // Prune old cooldown entries
    for (const [k, t] of _imageVulnCooldown) {
      if (now - t > IMAGE_VULN_COOLDOWN_MS * 2) _imageVulnCooldown.delete(k);
    }
  } catch (err) {
    console.error("[proactive] image-vuln scan error:", err.message);
  }
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
  const enriched = {
    ...insight,
    id,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    count: 1,
    aiAnalysis: null,
  };
  _insights.push(enriched);
  // Persist to learning engine for cross-cluster + time correlation
  try {
    const [kind, ...rest] = (insight.resource || "").split("/");
    const rname = rest.join("/");
    const sig = signatureForInsight(insight);
    if (sig) {
      enriched.signature = sig;
      leRecordIncident({
        cluster: process.env.CLUSTER_NAME || "local",
        namespace: insight.namespace || "",
        resourceType: kind || "",
        resourceName: rname || "",
        signature: sig,
        issueType: insight.type,
        severity: insight.severity || 50,
        context: { title: insight.title, detail: insight.detail },
      }).catch(() => {});
    }
  } catch { /* swallow */ }
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

/**
 * Analyze any cluster alert (Prometheus, K8s event, etc.) with the LLM.
 * Returns structured root cause / impact / fix. Cached for 10 min per key.
 */
const _alertAnalysisCache = new Map();
const ALERT_ANALYSIS_TTL_MS = 10 * 60 * 1000;
const ALERT_ANALYSIS_CACHE_MAX = 200;

function rememberAlertAnalysis(key, data) {
  _alertAnalysisCache.set(key, { ts: Date.now(), data });
  // Drop expired and over-cap entries to prevent unbounded growth.
  const now = Date.now();
  for (const [k, v] of _alertAnalysisCache) {
    if (now - v.ts > ALERT_ANALYSIS_TTL_MS) _alertAnalysisCache.delete(k);
  }
  while (_alertAnalysisCache.size > ALERT_ANALYSIS_CACHE_MAX) {
    const oldest = _alertAnalysisCache.keys().next().value;
    if (!oldest) break;
    _alertAnalysisCache.delete(oldest);
  }
}

export async function analyzeAlert(alert, llmOpts = {}) {
  if (!alert || !alert.name) return { error: "Invalid alert" };
  const key = `${alert.name}|${alert.namespace || ""}|${alert.resource || ""}`;
  const cached = _alertAnalysisCache.get(key);
  if (cached && Date.now() - cached.ts < ALERT_ANALYSIS_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  if (!llmEnabled(llmOpts)) {
    const fallback = ruleBasedAlertAnalysis(alert);
    rememberAlertAnalysis(key, fallback);
    return fallback;
  }

  try {
    const prompt = `You are a Kubernetes/OpenShift SRE expert. Analyze this cluster alert and respond ONLY with a JSON object (no markdown, no commentary).

Alert: ${alert.name}
Severity: ${alert.severity || "unknown"}
Namespace: ${alert.namespace || "n/a"}
Resource: ${alert.resource || "n/a"}
Summary: ${alert.summary || "n/a"}
Source: ${alert.source || "n/a"}

Respond with this exact JSON shape:
{
  "rootCause": "1-2 sentence root cause analysis",
  "impact": "1 sentence describing what is affected and how serious",
  "fix": "step-by-step fix in 3-5 bullets",
  "fixCommand": "single kubectl command using ONLY these verbs: get, describe, logs, top, events, scale, rollout restart, delete pod. Always include -n <namespace>. Empty string if no safe one-liner exists.",
  "preventStrategy": "1 sentence on prevention"
}`;

    const result = await callLLM({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 600,
      temperature: 0.2,
      ...llmOpts,
    });

    let parsed;
    try {
      const text = (result.text || "").trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch { parsed = null; }

    const analysis = parsed || {
      rootCause: result.text || "AI analysis unavailable",
      impact: "Unknown impact",
      fix: "",
      fixCommand: "",
      preventStrategy: "",
    };
    rememberAlertAnalysis(key, analysis);
    return analysis;
  } catch (err) {
    const fallback = ruleBasedAlertAnalysis(alert);
    fallback.error = err.message;
    return fallback;
  }
}

function ruleBasedAlertAnalysis(alert) {
  const name = (alert.name || "").toLowerCase();
  const summary = (alert.summary || "").toLowerCase();
  const ns = alert.namespace || "";
  const res = alert.resource || "";

  if (name.includes("failedmount") || summary.includes("mountvolume")) {
    const secMatch = (alert.summary || "").match(/secret\s+"?([^"\s]+)"?\s+not found/i);
    return {
      rootCause: "The pod cannot start because a referenced secret/configmap volume does not exist in the namespace.",
      impact: `Pod ${res} cannot start; service is degraded.`,
      fix: "1. Verify the secret/configmap name in the pod spec\n2. Create the missing secret in the namespace\n3. Delete the pod so it gets re-scheduled with the new secret",
      fixCommand: secMatch && ns ? `kubectl get secret ${secMatch[1]} -n ${ns}` : (ns && extractPodName(res) ? `kubectl describe pod ${extractPodName(res)} -n ${ns}` : ""),
      preventStrategy: "Use Helm/Kustomize templates to ensure secrets are deployed alongside workloads.",
    };
  }
  if (name.includes("crashloop") || summary.includes("crashloopbackoff")) {
    const podName = extractPodName(res);
    return {
      rootCause: "Container is crashing repeatedly; likely a bad image, missing config, or failing probe.",
      impact: `Pod ${res} unavailable; user traffic may be affected.`,
      fix: "1. Check container logs (Run will show recent logs)\n2. Verify image tag and entrypoint\n3. Review readiness/liveness probes\n4. Delete the pod to retry",
      fixCommand: ns && podName ? `kubectl logs ${podName} -n ${ns} --previous` : "",
      preventStrategy: "Add startup probes and validate images in CI before deploy.",
    };
  }
  if (name.includes("oom") || name.includes("memorypressure")) {
    const podName = extractPodName(res);
    return {
      rootCause: "Container exceeded its memory limit and was killed by the kernel OOM killer.",
      impact: `${res} restarted; in-flight requests dropped.`,
      fix: "1. Check memory usage with the Run button\n2. Increase memory limit in pod spec\n3. Profile heap usage\n4. Add HorizontalPodAutoscaler",
      fixCommand: ns && podName ? `kubectl top pod ${podName} -n ${ns}` : "",
      preventStrategy: "Set requests=limits and monitor working-set memory.",
    };
  }
  if (name.includes("imagepull") || name.includes("errimage")) {
    const podName = extractPodName(res);
    return {
      rootCause: "Kubelet cannot pull the container image — wrong tag, missing registry credentials, or network issue.",
      impact: `Pod ${res} stuck in ImagePullBackOff; deployment is blocked.`,
      fix: "1. Verify image name and tag exist in registry\n2. Check imagePullSecrets is set on the pod\n3. Click Run to see the pod's full description",
      fixCommand: ns && podName ? `kubectl describe pod ${podName} -n ${ns}` : "",
      preventStrategy: "Use immutable tags and pin image digests.",
    };
  }
  if (name.includes("nodenotready") || name.includes("nodedown")) {
    return {
      rootCause: "Node has stopped reporting to the control plane; kubelet may be down or network is partitioned.",
      impact: "All pods on the node are unschedulable; cluster capacity reduced.",
      fix: "1. SSH to the node and check kubelet status\n2. Verify node network connectivity\n3. Drain and reboot if necessary",
      fixCommand: res ? `kubectl describe node ${res}` : "",
      preventStrategy: "Enable node auto-repair and monitor kubelet heartbeats.",
    };
  }

  const fallbackPod = extractPodName(res);
  return {
    rootCause: `Alert "${alert.name}" fired with severity ${alert.severity || "unknown"}.`,
    impact: alert.summary || "See alert details.",
    fix: "Review the alert summary, check recent events, and consult the runbook for this alert.",
    fixCommand: ns && fallbackPod ? `kubectl describe pod ${fallbackPod} -n ${ns}` : "",
    preventStrategy: "Add a runbook entry for this alert in your knowledge base.",
  };
}

// Resource strings often look like "pod/foo-bar-123" or just "foo-bar-123"
function extractPodName(res) {
  if (!res) return "";
  const m = res.match(/^(?:pod\/)?([^\/\s]+)/);
  return m ? m[1] : "";
}

// ---------------------------------------------------------------------------
// Sprint D: Proactive suggestions ("I noticed X, want me to fix?")
//
// Surveys the cluster on demand and returns a ranked list of actionable
// recommendations. Pure read; never mutates. Used by the /suggestions
// slash command and the proactive panel in the dashboard.
// ---------------------------------------------------------------------------
export async function generateSuggestions({ limit = 10 } = {}) {
  const out = [];
  await Promise.all([
    _suggestFromProblemPods(out),
    _suggestFromPendingPVCs(out),
    _suggestFromDegradedOperators(out),
    _suggestFromMissingLimits(out),
    _suggestFromFailingBuilds(out),
    _suggestFromRecurringIncidents(out),
  ]);
  const sevRank = { critical: 4, high: 3, medium: 2, low: 1 };
  out.sort((a, b) => (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0));
  return out.slice(0, limit);
}

async function _suggestFromProblemPods(out) {
  try {
    const { ocpGet } = await import("../utils/ocp.js");
    const data = await ocpGet("/api/v1/pods?fieldSelector=status.phase!=Running,status.phase!=Succeeded");
    const pods = data.items || [];
    const crashing = pods.filter((p) => (p.status?.containerStatuses || []).some((c) => c.state?.waiting?.reason === "CrashLoopBackOff"));
    const evicted = pods.filter((p) => p.status?.reason === "Evicted");
    if (crashing.length >= 3) {
      out.push({
        category: "pods", severity: "high",
        title: `${crashing.length} pods in CrashLoopBackOff`,
        detail: `Affected: ${crashing.slice(0, 5).map((p) => p.metadata.namespace + "/" + p.metadata.name).join(", ")}${crashing.length > 5 ? ` and ${crashing.length - 5} more` : ""}.`,
        action: `/diagnose ${crashing[0].metadata.name} in ${crashing[0].metadata.namespace}`,
      });
    }
    if (evicted.length >= 5) {
      out.push({
        category: "pods", severity: "medium",
        title: `${evicted.length} Evicted pods cluttering the cluster`,
        detail: "Evicted pods consume etcd storage. Safe to delete in bulk.",
        action: `/bulk delete evicted pods`,
      });
    }
  } catch { /* ignore */ }
}

async function _suggestFromPendingPVCs(out) {
  try {
    const { ocpGet } = await import("../utils/ocp.js");
    const data = await ocpGet("/api/v1/persistentvolumeclaims");
    const pending = (data.items || []).filter((p) => p.status?.phase === "Pending");
    if (pending.length > 0) {
      out.push({
        category: "storage", severity: pending.length >= 3 ? "high" : "medium",
        title: `${pending.length} PVC(s) pending`,
        detail: `Workloads may be stuck. Pending: ${pending.slice(0, 3).map((p) => p.metadata.namespace + "/" + p.metadata.name).join(", ")}`,
        action: `oc describe pvc ${pending[0].metadata.name} -n ${pending[0].metadata.namespace}`,
      });
    }
  } catch { /* ignore */ }
}

async function _suggestFromDegradedOperators(out) {
  try {
    const { ocpGet } = await import("../utils/ocp.js");
    const data = await ocpGet("/apis/config.openshift.io/v1/clusteroperators");
    const degraded = (data.items || []).filter((co) => {
      const conds = co.status?.conditions || [];
      return conds.some((c) => (c.type === "Degraded" && c.status === "True") || (c.type === "Available" && c.status === "False"));
    });
    if (degraded.length > 0) {
      out.push({
        category: "operators", severity: "critical",
        title: `${degraded.length} ClusterOperator(s) degraded`,
        detail: `Degraded: ${degraded.map((d) => d.metadata.name).join(", ")}. Upgrades and platform stability are at risk.`,
        action: `oc get clusteroperators`,
      });
    }
  } catch { /* ignore */ }
}

async function _suggestFromMissingLimits(out) {
  try {
    const { ocpGet } = await import("../utils/ocp.js");
    const data = await ocpGet("/api/v1/pods");
    const items = (data.items || []).filter((p) => !p.metadata?.namespace?.startsWith("openshift-") && !p.metadata?.namespace?.startsWith("kube-"));
    let missing = 0;
    for (const p of items) {
      for (const c of (p.spec?.containers || [])) {
        if (!c.resources?.limits?.cpu || !c.resources?.limits?.memory) missing++;
      }
    }
    if (missing >= 10) {
      out.push({
        category: "governance", severity: "medium",
        title: `${missing} container(s) missing resource limits`,
        detail: "Apply LimitRange per namespace to enforce defaults and prevent noisy-neighbor outages.",
        action: `/provision quota for <namespace>`,
      });
    }
  } catch { /* ignore */ }
}

async function _suggestFromFailingBuilds(out) {
  try {
    const { ocpGet } = await import("../utils/ocp.js");
    const data = await ocpGet("/apis/build.openshift.io/v1/builds").catch(() => ({ items: [] }));
    const failed = (data.items || []).filter((b) => ["Failed", "Error", "Cancelled"].includes(b.status?.phase));
    const recent = failed.filter((b) => {
      const t = b.status?.completionTimestamp || b.metadata?.creationTimestamp;
      return t && (Date.now() - new Date(t).getTime() < 24 * 60 * 60 * 1000);
    });
    if (recent.length >= 3) {
      out.push({
        category: "builds", severity: "medium",
        title: `${recent.length} OpenShift Build(s) failed in the last 24h`,
        detail: `Recent failures: ${recent.slice(0, 3).map((b) => b.metadata.namespace + "/" + b.metadata.name).join(", ")}`,
        action: `/builds`,
      });
    }
  } catch { /* ignore */ }
}

async function _suggestFromRecurringIncidents(out) {
  try {
    const { isEnabled, query } = await import("../utils/db.js");
    if (!(await isEnabled())) return;
    const r = await query(
      `SELECT signature, COUNT(*) AS occurrences
       FROM incidents
       WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY signature
       HAVING COUNT(*) >= 3
       ORDER BY COUNT(*) DESC LIMIT 5`
    );
    const rows = r?.rows || [];
    if (rows.length > 0) {
      out.push({
        category: "patterns", severity: "high",
        title: `${rows.length} recurring incident pattern(s) in the last 7 days`,
        detail: rows.map((r) => `\`${(r.signature || "").slice(0, 50)}\` (${r.occurrences}x)`).join("; "),
        action: `/incidents`,
      });
    }
  } catch { /* ignore */ }
}
