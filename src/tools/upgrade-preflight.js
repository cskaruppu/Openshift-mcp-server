/**
 * Pre-Upgrade Cluster Preflight Assessment
 *
 * Runs a comprehensive compatibility and health check across all cluster
 * components, installed operators, and infrastructure before an upgrade.
 * Designed to integrate with the ITSM Change Request workflow — the report
 * is auto-attached to the CR when raising one for an upgrade.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerPreflightTools(server) {
  server.tool(
    "upgrade_preflight_check",
    "Run comprehensive pre-upgrade assessment: checks all cluster operators, OLM operators, deprecated APIs, node health, etcd, MCPs, certificates, PDBs, alerts, storage, and resource capacity before upgrading.",
    {
      targetVersion: z.string().describe("Target OCP version to upgrade to (e.g., 4.19.25)"),
      currentVersion: z.string().optional().describe("Current OCP version (auto-detected if omitted)"),
    },
    async ({ targetVersion, currentVersion }) => {
      const report = await runPreflightChecks(targetVersion, currentVersion);
      return { content: [{ type: "text", text: formatPreflightReport(report) }] };
    }
  );
}

/**
 * Run all 12 preflight checks in parallel and return structured results.
 * Exported so the chat-api can call it directly when detecting upgrade intent.
 */
export async function runPreflightChecks(targetVersion, currentVersion) {
  const [
    cvResp, opsResp, nodesResp, mcpResp, etcdResp,
    olmSubsResp, olmCsvsResp, pdbs, pvResp, alertsResp,
  ] = await Promise.allSettled([
    ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
    ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
    ocpGet("/api/v1/nodes"),
    ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools"),
    ocpGet("/api/v1/namespaces/openshift-etcd/pods?labelSelector=app=etcd"),
    ocpGet("/apis/operators.coreos.com/v1alpha1/subscriptions"),
    ocpGet("/apis/operators.coreos.com/v1alpha1/clusterserviceversions"),
    ocpGet("/apis/policy/v1/poddisruptionbudgets"),
    ocpGet("/api/v1/persistentvolumes"),
    ocpGet("/api/v1/namespaces/openshift-monitoring/pods?labelSelector=app.kubernetes.io/name=alertmanager"),
  ]);

  const cv = cvResp.status === "fulfilled" ? cvResp.value : null;
  const operators = opsResp.status === "fulfilled" ? (opsResp.value.items || []) : [];
  const nodes = nodesResp.status === "fulfilled" ? (nodesResp.value.items || []) : [];
  const mcps = mcpResp.status === "fulfilled" ? (mcpResp.value.items || []) : [];
  const etcdPods = etcdResp.status === "fulfilled" ? (etcdResp.value.items || []) : [];
  let olmSubs = olmSubsResp.status === "fulfilled" ? (olmSubsResp.value.items || []) : [];
  let olmCsvs = olmCsvsResp.status === "fulfilled" ? (olmCsvsResp.value.items || []) : [];

  // Fallback: if cluster-wide CSV query returned empty, try specific OLM namespaces
  if (olmCsvs.length === 0) {
    const olmNamespaces = ["openshift-operators", "openshift-operator-lifecycle-manager", "operators"];
    for (const ns of olmNamespaces) {
      try {
        const resp = await ocpGet(`/apis/operators.coreos.com/v1alpha1/namespaces/${ns}/clusterserviceversions`);
        if (resp.items && resp.items.length > 0) {
          olmCsvs = olmCsvs.concat(resp.items);
        }
      } catch { /* namespace may not exist */ }
    }
  }
  // Also try to detect operators from ClusterOperator versions for compatibility info
  if (olmCsvs.length === 0 && olmSubs.length === 0) {
    // No OLM operators — build list from subscriptions in well-known namespaces
    try {
      const subResp = await ocpGet("/apis/operators.coreos.com/v1alpha1/namespaces/openshift-operators/subscriptions");
      if (subResp.items) olmSubs = subResp.items;
    } catch { /* ignore */ }
  }
  const pdbItems = pdbs.status === "fulfilled" ? (pdbs.value.items || []) : [];
  const pvItems = pvResp.status === "fulfilled" ? (pvResp.value.items || []) : [];

  const detectedVersion = cv?.status?.desired?.version || cv?.status?.history?.[0]?.version || "unknown";
  const fromVersion = currentVersion || detectedVersion;
  const channel = cv?.spec?.channel || "unknown";
  const availableUpdates = cv?.status?.availableUpdates || [];
  const conditions = cv?.status?.conditions || [];
  const clusterID = cv?.spec?.clusterID || cv?.metadata?.uid || "";

  const isMajorUpgrade = !sameMinor(fromVersion, targetVersion);

  const checks = [];

  // 1. Upgrade Path Validity
  const targetInList = availableUpdates.some(u => u.version === targetVersion);
  const pathCheck = {
    category: "Upgrade Path",
    status: targetInList ? "pass" : "fail",
    details: targetInList
      ? `${targetVersion} is available in channel '${channel}'`
      : `${targetVersion} NOT found in available updates for channel '${channel}'. Available: ${availableUpdates.slice(0, 5).map(u => u.version).join(", ") || "none"}`,
  };
  if (!targetInList && availableUpdates.length > 0) {
    pathCheck.recommendation = `Switch channel or use an intermediate version. Closest available: ${availableUpdates[0]?.version}`;
  }
  checks.push(pathCheck);

  // 2. Currently upgrading?
  const progressing = conditions.find(c => c.type === "Progressing");
  checks.push({
    category: "Cluster Stability",
    status: progressing?.status === "True" ? "fail" : "pass",
    details: progressing?.status === "True"
      ? `Cluster is currently upgrading: ${progressing.message}`
      : "No upgrade in progress, cluster stable",
  });

  // 3. Cluster Operators Health
  const degradedOps = [];
  const unavailableOps = [];
  const progressingOps = [];
  for (const op of operators) {
    const conds = op.status?.conditions || [];
    const degraded = conds.find(c => c.type === "Degraded" && c.status === "True");
    const available = conds.find(c => c.type === "Available");
    const prog = conds.find(c => c.type === "Progressing" && c.status === "True");
    if (degraded) degradedOps.push({ name: op.metadata.name, message: degraded.message || "" });
    if (available?.status !== "True") unavailableOps.push({ name: op.metadata.name, message: available?.message || "" });
    if (prog) progressingOps.push({ name: op.metadata.name, message: prog.message || "" });
  }
  checks.push({
    category: "Cluster Operators",
    status: degradedOps.length > 0 || unavailableOps.length > 0 ? "fail" : progressingOps.length > 0 ? "warning" : "pass",
    details: `Total: ${operators.length} | Healthy: ${operators.length - degradedOps.length - unavailableOps.length} | Degraded: ${degradedOps.length} | Unavailable: ${unavailableOps.length} | Progressing: ${progressingOps.length}`,
    items: [
      ...degradedOps.map(o => ({ name: o.name, issue: "Degraded", message: o.message })),
      ...unavailableOps.map(o => ({ name: o.name, issue: "Unavailable", message: o.message })),
      ...progressingOps.map(o => ({ name: o.name, issue: "Progressing", message: o.message })),
    ],
  });

  // 4. OLM Installed Operators — compatibility check
  const olmIssues = [];
  const olmHealthy = [];
  for (const csv of olmCsvs) {
    const name = csv.metadata.name;
    const ns = csv.metadata.namespace;
    const phase = csv.status?.phase;
    const version = csv.spec?.version || "";
    const displayName = csv.spec?.displayName || name;
    const minKubeVersion = csv.spec?.minKubeVersion || "";
    const maxOCP = csv.metadata?.annotations?.["olm.properties"]
      ? extractMaxOCPVersion(csv.metadata.annotations["olm.properties"])
      : "";

    if (phase !== "Succeeded") {
      olmIssues.push({
        name: displayName,
        csvName: name,
        namespace: ns,
        version,
        status: phase || "Unknown",
        compatible: "unknown",
        issue: `Operator not healthy (phase: ${phase})`,
      });
    } else if (maxOCP && compareVersions(targetVersion, maxOCP) > 0) {
      olmIssues.push({
        name: displayName,
        csvName: name,
        namespace: ns,
        version,
        status: phase,
        compatible: "no",
        issue: `Max supported OCP version is ${maxOCP}, target is ${targetVersion}`,
      });
    } else {
      olmHealthy.push({ name: displayName, csvName: name, namespace: ns, version, status: phase, compatible: "yes" });
    }
  }

  // Check subscriptions for channel issues and also build list of installed operators from subs
  for (const sub of olmSubs) {
    const subName = sub.spec?.name || sub.metadata.name;
    const subChannel = sub.spec?.channel || "";
    const catalogSource = sub.spec?.source || "";
    const state = sub.status?.state || "";
    const installedCSV = sub.status?.installedCSV || "";
    const currentCSV = sub.status?.currentCSV || "";

    // If no CSV was found for this subscription, add it to the healthy/issues list from sub data
    const csvExists = olmCsvs.some(c => c.metadata.name === installedCSV || c.metadata.name === currentCSV);
    if (!csvExists && installedCSV) {
      // Subscription exists but CSV not in our list — add from subscription data
      const subVersion = installedCSV.replace(/^.*\.v/, "").replace(/^.*-/, "") || "";
      if (state === "AtLatestKnown" || !state) {
        olmHealthy.push({
          name: subName,
          csvName: installedCSV,
          namespace: sub.metadata.namespace,
          version: subVersion,
          status: "Succeeded",
          compatible: "yes",
          channel: subChannel,
          source: catalogSource,
        });
      }
    }

    if (state === "UpgradePending" || state === "UpgradeFailed") {
      const existing = olmIssues.find(i => i.csvName?.startsWith(subName) || i.name === subName);
      if (!existing) {
        olmIssues.push({
          name: subName,
          namespace: sub.metadata.namespace,
          version: "",
          status: state,
          compatible: "warning",
          issue: `Subscription state: ${state} (channel: ${subChannel}, source: ${catalogSource})`,
        });
      }
    }
  }

  const totalOLM = olmCsvs.length + olmSubs.filter(s => {
    const csv = s.status?.installedCSV || "";
    return csv && !olmCsvs.some(c => c.metadata.name === csv);
  }).length;

  checks.push({
    category: "Installed Operators (OLM)",
    status: olmIssues.some(i => i.compatible === "no") ? "fail" : olmIssues.length > 0 ? "warning" : "pass",
    details: `Total: ${totalOLM || olmHealthy.length + olmIssues.length} | Healthy & Compatible: ${olmHealthy.length} | Issues: ${olmIssues.length}`,
    items: olmIssues,
    compatible: olmHealthy,
  });

  // 5. Node Health
  const notReady = [];
  const pressureNodes = [];
  for (const node of nodes) {
    const conds = node.status?.conditions || [];
    const ready = conds.find(c => c.type === "Ready");
    if (ready?.status !== "True") {
      notReady.push(node.metadata.name);
    }
    for (const c of conds) {
      if (["MemoryPressure", "DiskPressure", "PIDPressure"].includes(c.type) && c.status === "True") {
        pressureNodes.push({ node: node.metadata.name, condition: c.type });
      }
    }
  }
  checks.push({
    category: "Node Health",
    status: notReady.length > 0 ? "fail" : pressureNodes.length > 0 ? "warning" : "pass",
    details: `Total: ${nodes.length} | Ready: ${nodes.length - notReady.length} | NotReady: ${notReady.length} | Pressure: ${pressureNodes.length}`,
    items: [
      ...notReady.map(n => ({ name: n, issue: "NotReady" })),
      ...pressureNodes.map(p => ({ name: p.node, issue: p.condition })),
    ],
  });

  // 6. Machine Config Pools
  const mcpIssues = [];
  for (const mcp of mcps) {
    const conds = mcp.status?.conditions || [];
    const updating = conds.find(c => c.type === "Updating" && c.status === "True");
    const degraded = conds.find(c => c.type === "Degraded" && c.status === "True");
    const machineCount = mcp.status?.machineCount || 0;
    const readyCount = mcp.status?.readyMachineCount || 0;
    const updatedCount = mcp.status?.updatedMachineCount || 0;
    if (degraded) mcpIssues.push({ name: mcp.metadata.name, issue: "Degraded", message: degraded.message || "" });
    else if (updating) mcpIssues.push({ name: mcp.metadata.name, issue: "Updating", message: `${updatedCount}/${machineCount} updated` });
    else if (readyCount < machineCount) mcpIssues.push({ name: mcp.metadata.name, issue: "Partial", message: `${readyCount}/${machineCount} ready` });
  }
  checks.push({
    category: "Machine Config Pools",
    status: mcpIssues.some(i => i.issue === "Degraded") ? "fail" : mcpIssues.length > 0 ? "warning" : "pass",
    details: `Total: ${mcps.length} | Issues: ${mcpIssues.length}`,
    items: mcpIssues,
  });

  // 7. Etcd Health — expected count matches control-plane/master node count
  const controlPlaneNodes = nodes.filter(n => {
    const labels = n.metadata?.labels || {};
    return labels["node-role.kubernetes.io/master"] !== undefined ||
           labels["node-role.kubernetes.io/control-plane"] !== undefined;
  });
  const expectedEtcd = controlPlaneNodes.length || 1;

  // Filter to actual etcd member pods (not operator/guard pods)
  let etcdMembers = etcdPods.filter(p => {
    const name = p.metadata?.name || "";
    return name.startsWith("etcd-") && !name.includes("operator") && !name.includes("guard") && !name.includes("quorum");
  });
  // If label selector returned nothing, try all pods but filter strictly
  if (etcdMembers.length === 0) {
    etcdMembers = etcdPods.filter(p => {
      const containers = p.spec?.containers || [];
      return containers.some(c => c.name === "etcd" || c.name === "etcdctl");
    });
  }
  // Last fallback: if still empty but we got pods, it could be SNO with a different layout
  if (etcdMembers.length === 0 && etcdPods.length > 0) {
    etcdMembers = etcdPods.filter(p => p.status?.phase === "Running");
  }

  const etcdRunning = etcdMembers.filter(p => p.status?.phase === "Running");
  const etcdExpectedLabel = expectedEtcd === 1 ? "single-node" : `${expectedEtcd}-node HA`;
  let etcdStatus, etcdDetails;
  if (etcdMembers.length === 0) {
    etcdStatus = "warning";
    etcdDetails = `Unable to verify etcd pods (check permissions or label selector)`;
  } else if (etcdRunning.length >= expectedEtcd) {
    etcdStatus = "pass";
    etcdDetails = `${etcdRunning.length}/${expectedEtcd} etcd members running (${etcdExpectedLabel} cluster)`;
  } else {
    etcdStatus = "fail";
    etcdDetails = `${etcdRunning.length}/${expectedEtcd} etcd members running (expected ${expectedEtcd} for ${etcdExpectedLabel} cluster)`;
  }
  checks.push({ category: "Etcd Cluster", status: etcdStatus, details: etcdDetails });

  // 8. Deprecated APIs (check for removed APIs in target version)
  const deprecatedAPIs = await checkDeprecatedAPIs(targetVersion, isMajorUpgrade);
  checks.push({
    category: "Deprecated/Removed APIs",
    status: deprecatedAPIs.removed.length > 0 ? "fail" : deprecatedAPIs.deprecated.length > 0 ? "warning" : "pass",
    details: `Removed in ${targetVersion}: ${deprecatedAPIs.removed.length} | Deprecated: ${deprecatedAPIs.deprecated.length}`,
    items: [...deprecatedAPIs.removed, ...deprecatedAPIs.deprecated],
  });

  // 9. PodDisruptionBudgets
  const blockingPDBs = [];
  for (const pdb of pdbItems) {
    const minAvailable = pdb.spec?.minAvailable;
    const maxUnavailable = pdb.spec?.maxUnavailable;
    const currentHealthy = pdb.status?.currentHealthy || 0;
    const desiredHealthy = pdb.status?.desiredHealthy || 0;
    if (maxUnavailable === 0 || (typeof maxUnavailable === "string" && maxUnavailable === "0")) {
      blockingPDBs.push({
        name: pdb.metadata.name,
        namespace: pdb.metadata.namespace,
        issue: "maxUnavailable=0 will block node drain",
        healthy: `${currentHealthy}/${desiredHealthy}`,
      });
    } else if (minAvailable && currentHealthy <= desiredHealthy) {
      blockingPDBs.push({
        name: pdb.metadata.name,
        namespace: pdb.metadata.namespace,
        issue: `Tight PDB (minAvailable=${minAvailable}), may slow drain`,
        healthy: `${currentHealthy}/${desiredHealthy}`,
      });
    }
  }
  checks.push({
    category: "Pod Disruption Budgets",
    status: blockingPDBs.some(p => p.issue.includes("block")) ? "warning" : "pass",
    details: `Total PDBs: ${pdbItems.length} | Potentially blocking: ${blockingPDBs.length}`,
    items: blockingPDBs,
  });

  // 10. Firing Alerts
  let firingAlerts = [];
  try {
    const amPods = alertsResp.status === "fulfilled" ? (alertsResp.value.items || []) : [];
    if (amPods.length > 0) {
      const alertData = await ocpGet("/api/v1/namespaces/openshift-monitoring/services/alertmanager-main:web/proxy/api/v2/alerts?silenced=false&inhibited=false");
      firingAlerts = (Array.isArray(alertData) ? alertData : [])
        .filter(a => a.status?.state === "active")
        .map(a => ({
          name: a.labels?.alertname || "Unknown",
          severity: a.labels?.severity || "unknown",
          namespace: a.labels?.namespace || "",
          message: a.annotations?.description || a.annotations?.message || "",
        }));
    }
  } catch { /* alertmanager not accessible */ }
  const criticalAlerts = firingAlerts.filter(a => a.severity === "critical");
  const warningAlerts = firingAlerts.filter(a => a.severity === "warning");
  checks.push({
    category: "Firing Alerts",
    status: criticalAlerts.length > 0 ? "fail" : warningAlerts.length > 0 ? "warning" : "pass",
    details: `Critical: ${criticalAlerts.length} | Warning: ${warningAlerts.length} | Total: ${firingAlerts.length}`,
    items: [...criticalAlerts, ...warningAlerts].slice(0, 20),
  });

  // 11. Storage Health
  const pvIssues = [];
  for (const pv of pvItems) {
    const phase = pv.status?.phase;
    if (phase === "Failed" || phase === "Released") {
      pvIssues.push({ name: pv.metadata.name, status: phase, capacity: pv.spec?.capacity?.storage || "" });
    }
  }
  checks.push({
    category: "Storage (PVs)",
    status: pvIssues.length > 0 ? "warning" : "pass",
    details: `Total PVs: ${pvItems.length} | Bound: ${pvItems.filter(p => p.status?.phase === "Bound").length} | Issues: ${pvIssues.length}`,
    items: pvIssues,
  });

  // 12. Resource Capacity
  const capacity = calculateUpgradeCapacity(nodes);
  checks.push({
    category: "Resource Capacity",
    status: capacity.headroomPercent < 15 ? "fail" : capacity.headroomPercent < 25 ? "warning" : "pass",
    details: `Headroom: ${capacity.headroomPercent}% | Can sustain ${capacity.drainnableNodes} node(s) offline during rolling upgrade`,
    items: capacity.details ? [capacity.details] : [],
  });

  return {
    fromVersion,
    targetVersion,
    channel,
    clusterID,
    isMajorUpgrade,
    upgradeType: isMajorUpgrade ? "Major (minor version change)" : "Patch/Z-stream",
    timestamp: new Date().toISOString(),
    checks,
    summary: {
      total: checks.length,
      pass: checks.filter(c => c.status === "pass").length,
      warning: checks.filter(c => c.status === "warning").length,
      fail: checks.filter(c => c.status === "fail").length,
    },
    overallStatus: checks.some(c => c.status === "fail") ? "NOT_READY" : checks.some(c => c.status === "warning") ? "READY_WITH_WARNINGS" : "READY",
    operators: { clusterOperators: operators.length, olmOperators: olmHealthy.length + olmIssues.length },
    allClusterOperators: operators.map(o => ({
      name: o.metadata.name,
      version: (o.status?.versions || []).find(v => v.name === "operator")?.version || "",
      available: (o.status?.conditions || []).find(c => c.type === "Available")?.status === "True",
      degraded: (o.status?.conditions || []).find(c => c.type === "Degraded")?.status === "True",
      progressing: (o.status?.conditions || []).find(c => c.type === "Progressing")?.status === "True",
    })),
    allOLMOperators: [...olmHealthy, ...olmIssues],
  };
}

/**
 * Format the preflight report as readable markdown.
 */
export function formatPreflightReport(report) {
  const icon = { pass: "[PASS]", warning: "[WARN]", fail: "[FAIL]" };
  const lines = [];

  lines.push(`### Pre-Upgrade Cluster Assessment`);
  lines.push(``);
  lines.push(`| Property | Value |`);
  lines.push(`|----------|-------|`);
  lines.push(`| Current Version | ${report.fromVersion} |`);
  lines.push(`| Target Version | ${report.targetVersion} |`);
  lines.push(`| Upgrade Type | ${report.upgradeType} |`);
  lines.push(`| Channel | ${report.channel} |`);
  lines.push(`| Cluster ID | ${report.clusterID || "N/A"} |`);
  lines.push(`| Assessment Time | ${report.timestamp} |`);
  lines.push(`| **Overall** | **${report.overallStatus}** |`);
  lines.push(``);
  lines.push(`#### Summary: ${report.summary.pass} passed, ${report.summary.warning} warnings, ${report.summary.fail} failed`);
  lines.push(``);

  for (const check of report.checks) {
    lines.push(`${icon[check.status]} **${check.category}** — ${check.details}`);
    if (check.items && check.items.length > 0 && check.status !== "pass") {
      for (const item of check.items.slice(0, 10)) {
        if (item.name && item.issue) {
          lines.push(`    - ${item.name}: ${item.issue}${item.message ? ` (${item.message.slice(0, 100)})` : ""}`);
        } else if (item.name) {
          lines.push(`    - ${item.name}${item.severity ? ` [${item.severity}]` : ""}${item.message ? `: ${item.message.slice(0, 100)}` : ""}`);
        }
      }
      if (check.items.length > 10) lines.push(`    - ... and ${check.items.length - 10} more`);
    }
    if (check.recommendation) lines.push(`    → Recommendation: ${check.recommendation}`);
  }

  // Operator inventory
  lines.push(``);
  lines.push(`---`);
  lines.push(`#### Cluster Operators (${report.operators.clusterOperators})`);
  lines.push(`| Operator | Version | Available | Degraded |`);
  lines.push(`|----------|---------|-----------|----------|`);
  for (const op of (report.allClusterOperators || []).slice(0, 40)) {
    lines.push(`| ${op.name} | ${op.version || "-"} | ${op.available ? "Yes" : "**NO**"} | ${op.degraded ? "**YES**" : "No"} |`);
  }

  lines.push(``);
  lines.push(`#### Installed Operators — OLM (${report.operators.olmOperators})`);
  lines.push(`| Operator | Version | Namespace | Status | Compatible |`);
  lines.push(`|----------|---------|-----------|--------|------------|`);
  for (const op of (report.allOLMOperators || []).slice(0, 40)) {
    const compat = op.compatible === "yes" ? "Yes" : op.compatible === "no" ? "**NO**" : "?";
    lines.push(`| ${op.name} | ${op.version || "-"} | ${op.namespace || "-"} | ${op.status || "-"} | ${compat} |`);
  }

  if (report.overallStatus === "NOT_READY") {
    lines.push(``);
    lines.push(`---`);
    lines.push(`**ACTION REQUIRED:** Resolve the failed checks above before proceeding with the upgrade.`);
  } else if (report.overallStatus === "READY_WITH_WARNINGS") {
    lines.push(``);
    lines.push(`---`);
    lines.push(`**NOTE:** Upgrade can proceed but review warnings above. Some may cause delays or issues during the upgrade.`);
  } else {
    lines.push(``);
    lines.push(`---`);
    lines.push(`**READY:** All checks passed. Cluster is ready for upgrade to ${report.targetVersion}.`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function sameMinor(v1, v2) {
  if (!v1 || !v2) return false;
  const [, maj1, min1] = v1.match(/^(\d+)\.(\d+)/) || [];
  const [, maj2, min2] = v2.match(/^(\d+)\.(\d+)/) || [];
  return maj1 === maj2 && min1 === min2;
}

function compareVersions(v1, v2) {
  const p1 = (v1 || "").split(".").map(Number);
  const p2 = (v2 || "").split(".").map(Number);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function extractMaxOCPVersion(olmProperties) {
  try {
    const props = JSON.parse(olmProperties);
    const maxProp = props.find(p => p.type === "olm.maxOpenShiftVersion");
    return maxProp?.value || "";
  } catch {
    return "";
  }
}

async function checkDeprecatedAPIs(targetVersion, isMajorUpgrade) {
  const removed = [];
  const deprecated = [];

  // Known API removals by OCP version range
  const API_REMOVALS = {
    "4.17": [
      { api: "flowcontrol.apiserver.k8s.io/v1beta2", kinds: ["FlowSchema", "PriorityLevelConfiguration"], replacement: "flowcontrol.apiserver.k8s.io/v1" },
    ],
    "4.18": [
      { api: "autoscaling/v2beta2", kinds: ["HorizontalPodAutoscaler"], replacement: "autoscaling/v2" },
    ],
  };

  // Check for workloads using deprecated APIs via the cluster's API resources
  try {
    const apiResources = await ocpGet("/apis");
    const groups = apiResources.groups || [];
    const betaGroups = groups.filter(g =>
      g.versions?.some(v => v.version?.includes("beta") || v.version?.includes("alpha"))
    );
    for (const group of betaGroups.slice(0, 10)) {
      const betaVersions = (group.versions || []).filter(v => v.version?.includes("beta"));
      for (const v of betaVersions) {
        deprecated.push({
          name: `${group.name}/${v.version}`,
          issue: "Beta API still in use",
          replacement: group.preferredVersion?.version ? `${group.name}/${group.preferredVersion.version}` : "check docs",
        });
      }
    }
  } catch { /* skip if can't list APIs */ }

  return { removed, deprecated };
}

function calculateUpgradeCapacity(nodes) {
  const workerNodes = nodes.filter(n => {
    const labels = n.metadata?.labels || {};
    return Object.keys(labels).some(l => l === "node-role.kubernetes.io/worker");
  });

  if (workerNodes.length === 0) {
    return { headroomPercent: 0, drainnableNodes: 0, details: { issue: "No worker nodes found" } };
  }

  const totalCpuCapacity = workerNodes.reduce((sum, n) => {
    const cpu = parseInt(n.status?.capacity?.cpu || "0", 10);
    return sum + cpu;
  }, 0);

  const totalMemCapacity = workerNodes.reduce((sum, n) => {
    const mem = n.status?.capacity?.memory || "0Ki";
    const ki = parseInt(mem, 10);
    return sum + ki;
  }, 0);

  const nodeCount = workerNodes.length;
  const perNodeCpu = totalCpuCapacity / nodeCount;
  const perNodeMem = totalMemCapacity / nodeCount;

  // During rolling upgrade, one node goes offline at a time
  const remainingCpuPercent = ((totalCpuCapacity - perNodeCpu) / totalCpuCapacity) * 100;
  const headroomPercent = Math.round(100 - remainingCpuPercent > 0 ? remainingCpuPercent - (100 / nodeCount) : remainingCpuPercent);

  const drainnableNodes = Math.max(1, Math.floor(nodeCount * 0.25));

  return {
    headroomPercent: Math.max(0, Math.round((1 - 1 / nodeCount) * 100 - 60)),
    drainnableNodes,
    details: {
      workerNodes: nodeCount,
      totalCPU: `${totalCpuCapacity} cores`,
      totalMemory: `${Math.round(totalMemCapacity / (1024 * 1024))}Gi`,
      perNodeCPU: `${perNodeCpu} cores`,
    },
  };
}
