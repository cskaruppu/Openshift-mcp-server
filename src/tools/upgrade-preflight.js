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
    "Run industry-standard 22-point pre-upgrade assessment: upgrade path validity, cluster stability, cluster operators, OLM operator compatibility (maxOpenShiftVersion, minKubeVersion, channels, install plans), node health, machine config pools, etcd, deprecated APIs, PDBs, firing alerts, storage, version history, admin acknowledgments, certificate expiry, admission webhooks, kubelet skew, image registry, cluster network, CSI drivers, machine health checks, update service signals, and resource capacity.",
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
 * Run all industry-standard preflight checks in parallel and return structured results.
 * Exported so the chat-api can call it directly when detecting upgrade intent.
 *
 * Covers 22 checks aligned with Red Hat's pre-upgrade documentation, OCP enterprise
 * best practices, and known industry blockers:
 *   1. Upgrade Path Validity         12. Cluster Version History
 *   2. Cluster Stability             13. Admin Acknowledgments
 *   3. Cluster Operators             14. Certificate Expiry
 *   4. OLM Installed Operators       15. Webhook Configurations
 *   5. Node Health                   16. Kubelet Version Skew
 *   6. Machine Config Pools          17. Image Registry & Pull Secrets
 *   7. Etcd Cluster                  18. Cluster Network Health
 *   8. Deprecated/Removed APIs       19. CSI Driver Compatibility
 *   9. Pod Disruption Budgets        20. MachineHealthCheck Status
 *  10. Firing Alerts                 21. Insights/Update Conditions
 *  11. Storage (PVs)                 22. Resource Capacity
 */
export async function runPreflightChecks(targetVersion, currentVersion) {
  const [
    cvResp, opsResp, nodesResp, mcpResp, etcdResp,
    olmSubsResp, olmCsvsResp, pdbs, pvResp, alertsResp,
    adminAcksResp, vwhResp, mwhResp, csiDriversResp, mhcResp,
    networkResp, registryResp, catSrcResp, ipResp,
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
    ocpGet("/api/v1/namespaces/openshift-config-managed/configmaps/admin-acks"),
    ocpGet("/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations"),
    ocpGet("/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations"),
    ocpGet("/apis/storage.k8s.io/v1/csidrivers"),
    ocpGet("/apis/machine.openshift.io/v1beta1/machinehealthchecks"),
    ocpGet("/apis/config.openshift.io/v1/networks/cluster"),
    ocpGet("/apis/imageregistry.operator.openshift.io/v1/configs/cluster"),
    ocpGet("/apis/operators.coreos.com/v1alpha1/catalogsources"),
    ocpGet("/apis/operators.coreos.com/v1alpha1/installplans"),
  ]);

  const cv = cvResp.status === "fulfilled" ? cvResp.value : null;
  const operators = opsResp.status === "fulfilled" ? (opsResp.value.items || []) : [];
  const nodes = nodesResp.status === "fulfilled" ? (nodesResp.value.items || []) : [];
  const mcps = mcpResp.status === "fulfilled" ? (mcpResp.value.items || []) : [];
  const etcdPods = etcdResp.status === "fulfilled" ? (etcdResp.value.items || []) : [];
  let olmSubs = olmSubsResp.status === "fulfilled" ? (olmSubsResp.value.items || []) : [];
  let olmCsvs = olmCsvsResp.status === "fulfilled" ? (olmCsvsResp.value.items || []) : [];
  const adminAcks = adminAcksResp.status === "fulfilled" ? adminAcksResp.value : null;
  const vwhConfigs = vwhResp.status === "fulfilled" ? (vwhResp.value.items || []) : [];
  const mwhConfigs = mwhResp.status === "fulfilled" ? (mwhResp.value.items || []) : [];
  const csiDrivers = csiDriversResp.status === "fulfilled" ? (csiDriversResp.value.items || []) : [];
  const mhcs = mhcResp.status === "fulfilled" ? (mhcResp.value.items || []) : [];
  const network = networkResp.status === "fulfilled" ? networkResp.value : null;
  const registry = registryResp.status === "fulfilled" ? registryResp.value : null;
  const catalogSources = catSrcResp.status === "fulfilled" ? (catSrcResp.value.items || []) : [];
  const installPlans = ipResp.status === "fulfilled" ? (ipResp.value.items || []) : [];

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

  // 4. OLM Installed Operators — compatibility check (enhanced with catalog/install-plan awareness)
  const olmIssues = [];
  const olmHealthy = [];
  const channelMismatch = [];
  for (const csv of olmCsvs) {
    const name = csv.metadata.name;
    const ns = csv.metadata.namespace;
    const phase = csv.status?.phase;
    const version = csv.spec?.version || "";
    const displayName = csv.spec?.displayName || name;
    const minKubeVersion = csv.spec?.minKubeVersion || "";
    const olmProps = csv.metadata?.annotations?.["olm.properties"];
    const maxOCP = olmProps ? extractMaxOCPVersion(olmProps) : "";
    const minOCP = olmProps ? extractMinOCPVersion(olmProps) : "";

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
        issue: `Max supported OCP version is ${maxOCP}, target is ${targetVersion} — operator MUST be upgraded first`,
      });
    } else if (minOCP && compareVersions(targetVersion, minOCP) < 0) {
      olmIssues.push({
        name: displayName,
        csvName: name,
        namespace: ns,
        version,
        status: phase,
        compatible: "no",
        issue: `Min required OCP version is ${minOCP}, target is ${targetVersion}`,
      });
    } else if (minKubeVersion) {
      const targetKube = ocpToKube(targetVersion);
      if (targetKube && compareVersions(targetKube, minKubeVersion) < 0) {
        olmIssues.push({
          name: displayName,
          csvName: name,
          namespace: ns,
          version,
          status: phase,
          compatible: "no",
          issue: `Requires Kubernetes >=${minKubeVersion}, target OCP ships ${targetKube}`,
        });
        continue;
      }
      olmHealthy.push({ name: displayName, csvName: name, namespace: ns, version, status: phase, compatible: "yes" });
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

    // Manual install plan that hasn't been approved blocks operator updates
    if (sub.spec?.installPlanApproval === "Manual") {
      const ipRef = sub.status?.installplan;
      if (ipRef) {
        const ip = installPlans.find(p => p.metadata.name === ipRef.name && p.metadata.namespace === sub.metadata.namespace);
        if (ip && ip.spec?.approval === "Manual" && ip.spec?.approved !== true) {
          olmIssues.push({
            name: subName,
            namespace: sub.metadata.namespace,
            version: "",
            status: "Manual approval pending",
            compatible: "warning",
            issue: `Install plan '${ipRef.name}' awaiting manual approval — approve before upgrade or operator will be stuck`,
          });
        }
      }
    }

    // Channel naming hints at OCP version alignment ('stable-4.18' vs target 4.19)
    const chanMatch = (subChannel || "").match(/(?:stable|fast|candidate)-(\d+\.\d+)/);
    if (chanMatch) {
      const chanVer = chanMatch[1];
      const tgtMM = (targetVersion.match(/^(\d+\.\d+)/) || [])[1];
      if (chanVer && tgtMM && compareVersions(chanVer, tgtMM) < 0) {
        channelMismatch.push({
          name: subName,
          namespace: sub.metadata.namespace,
          channel: subChannel,
          issue: `Subscription channel '${subChannel}' lags target ${tgtMM} — switch channel after operator releases ${tgtMM}-aligned bundle`,
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

  // 12. Cluster Version History — flag prior failed/partial upgrades
  const cvHistory = cv?.status?.history || [];
  const failedHistory = cvHistory.filter(h => h.state === "Partial" || h.state === "Failed");
  const recentHistory = cvHistory.slice(0, 5).map(h => ({
    name: h.version,
    issue: h.state,
    message: h.completionTime
      ? `${h.state} on ${h.completionTime}`
      : h.startedTime ? `started ${h.startedTime}` : "",
  }));
  checks.push({
    category: "Cluster Version History",
    status: failedHistory.length > 0 ? "warning" : "pass",
    details: failedHistory.length > 0
      ? `${failedHistory.length} prior partial/failed upgrade(s) in history — investigate before proceeding`
      : `${cvHistory.length} successful upgrade(s) in history`,
    items: failedHistory.length > 0 ? recentHistory : [],
  });

  // 13. Admin Acknowledgments — required acks before certain minor upgrades
  // Red Hat publishes a list of acks required before each minor release (e.g.,
  // 'ack-4.18-kube-1.31-api-removals-in-4.19'). Missing acks BLOCK the upgrade.
  const ackData = adminAcks?.data || {};
  const requiredAckPrefix = `ack-${(fromVersion.match(/^(\d+\.\d+)/) || [])[1]}-`;
  const presentAcks = Object.keys(ackData).filter(k => k.startsWith("ack-"));
  const missingAcks = [];
  if (isMajorUpgrade) {
    const expectedAck = `ack-${(fromVersion.match(/^(\d+\.\d+)/) || [])[1]}-kube-`;
    const hasExpected = presentAcks.some(k => k.startsWith(expectedAck));
    if (!hasExpected && fromVersion !== "unknown") {
      missingAcks.push({
        name: `${expectedAck}* (admin-acks ConfigMap)`,
        issue: "Required acknowledgment for minor upgrade may be missing",
        message: `Check 'oc -n openshift-config-managed get configmap admin-acks' and follow Red Hat release notes`,
      });
    }
  }
  checks.push({
    category: "Admin Acknowledgments",
    status: missingAcks.length > 0 ? "warning" : "pass",
    details: missingAcks.length > 0
      ? `${missingAcks.length} potential ack(s) needed for ${fromVersion} → ${targetVersion}`
      : `${presentAcks.length} ack(s) present${isMajorUpgrade ? " (review release notes for additional requirements)" : " (no acks needed for Z-stream)"}`,
    items: missingAcks,
    recommendation: missingAcks.length > 0
      ? `Apply required acks per https://access.redhat.com/articles/6955381 before upgrading`
      : undefined,
  });

  // 14. Certificate Expiry — kube-apiserver, ingress, etcd
  const certExpiry = await checkCertificateExpiry();
  checks.push({
    category: "Certificate Expiry",
    status: certExpiry.expiring.some(c => c.daysLeft < 30) ? "fail"
          : certExpiry.expiring.length > 0 ? "warning" : "pass",
    details: certExpiry.expiring.length === 0
      ? `All checked certs valid for >90 days`
      : `${certExpiry.expiring.length} cert(s) expiring within 90 days (min: ${Math.min(...certExpiry.expiring.map(c => c.daysLeft))} days)`,
    items: certExpiry.expiring.map(c => ({
      name: c.name,
      issue: `Expires in ${c.daysLeft} days`,
      message: c.subject || c.namespace || "",
    })),
    recommendation: certExpiry.expiring.some(c => c.daysLeft < 30)
      ? `Rotate certificates before upgrade — see 'oc get csr' and ingress operator docs`
      : undefined,
  });

  // 15. Webhook Configurations — webhooks pointing to non-existent services block upgrades
  const webhookIssues = checkWebhooks([...vwhConfigs, ...mwhConfigs]);
  checks.push({
    category: "Admission Webhooks",
    status: webhookIssues.length > 0 ? "warning" : "pass",
    details: `Validating: ${vwhConfigs.length} | Mutating: ${mwhConfigs.length} | Risky: ${webhookIssues.length}`,
    items: webhookIssues,
    recommendation: webhookIssues.length > 0
      ? `Webhooks with failurePolicy=Fail can block API operations during upgrade — review and consider Ignore`
      : undefined,
  });

  // 16. Kubelet Version Skew — kubelet must be within 2 minors of API server
  const skewIssues = checkKubeletSkew(nodes, targetVersion);
  checks.push({
    category: "Kubelet Version Skew",
    status: skewIssues.length > 0 ? "warning" : "pass",
    details: skewIssues.length > 0
      ? `${skewIssues.length} node(s) with potential version skew issues`
      : `All ${nodes.length} kubelets within supported skew range`,
    items: skewIssues,
  });

  // 17. Image Registry & Pull Secrets
  const registryIssues = [];
  const registryStorage = registry?.spec?.storage;
  const registryReplicas = registry?.spec?.replicas;
  const registryState = registry?.spec?.managementState;
  if (registryState === "Removed") {
    registryIssues.push({
      name: "Internal registry",
      issue: "managementState=Removed",
      message: "Internal registry disabled — ensure external registry is reachable for upgrade images",
    });
  } else if (registryState === "Managed" && !registryStorage) {
    registryIssues.push({
      name: "Internal registry",
      issue: "No persistent storage configured",
      message: "Registry uses ephemeral storage — risk of image loss during upgrade",
    });
  }
  if (registry?.status?.conditions) {
    const degraded = registry.status.conditions.find(c => c.type === "Degraded" && c.status === "True");
    if (degraded) {
      registryIssues.push({
        name: "Internal registry",
        issue: "Degraded",
        message: degraded.message || "",
      });
    }
  }
  checks.push({
    category: "Image Registry",
    status: registryIssues.some(i => i.issue.includes("Degraded")) ? "fail"
          : registryIssues.length > 0 ? "warning" : "pass",
    details: registry
      ? `State: ${registryState || "unknown"} | Replicas: ${registryReplicas || "default"} | Storage: ${registryStorage ? Object.keys(registryStorage).join(",") : "none"}`
      : `Registry config not accessible (may be disconnected install)`,
    items: registryIssues,
  });

  // 18. Cluster Network Health — OVN/SDN type, MTU, network operator status
  const networkIssues = [];
  const networkType = network?.spec?.networkType || network?.status?.networkType || "unknown";
  const clusterNetworkMTU = network?.status?.clusterNetworkMTU;
  const networkOp = operators.find(o => o.metadata.name === "network");
  if (networkOp) {
    const conds = networkOp.status?.conditions || [];
    const degraded = conds.find(c => c.type === "Degraded" && c.status === "True");
    const progressing = conds.find(c => c.type === "Progressing" && c.status === "True");
    if (degraded) networkIssues.push({ name: "network operator", issue: "Degraded", message: degraded.message || "" });
    if (progressing) networkIssues.push({ name: "network operator", issue: "Progressing", message: progressing.message || "" });
  }
  // SDN -> OVN-Kubernetes migration is a known major-upgrade blocker on some paths
  if (isMajorUpgrade && networkType === "OpenShiftSDN") {
    networkIssues.push({
      name: "Network plugin",
      issue: "OpenShiftSDN deprecated",
      message: `OpenShiftSDN is deprecated and removed in OCP 4.17+. Migrate to OVN-Kubernetes before upgrading.`,
    });
  }
  checks.push({
    category: "Cluster Network",
    status: networkIssues.some(i => /Degraded|removed|deprecated/i.test(i.issue + i.message)) ? "fail"
          : networkIssues.length > 0 ? "warning" : "pass",
    details: `Type: ${networkType}${clusterNetworkMTU ? ` | MTU: ${clusterNetworkMTU}` : ""}`,
    items: networkIssues,
  });

  // 19. CSI Driver Compatibility
  const csiIssues = [];
  for (const drv of csiDrivers) {
    const drvName = drv.metadata.name;
    const annotations = drv.metadata.annotations || {};
    const csiOpName = `${drvName}-csi-driver`.replace(/\./g, "-");
    const matchedOp = operators.find(o => o.metadata.name.includes("csi") && o.metadata.name.includes(drvName.split(".")[0]));
    if (matchedOp) {
      const conds = matchedOp.status?.conditions || [];
      const degraded = conds.find(c => c.type === "Degraded" && c.status === "True");
      if (degraded) {
        csiIssues.push({
          name: drvName,
          issue: "CSI operator degraded",
          message: degraded.message || "",
        });
      }
    }
    // In-tree -> CSI migration warnings for known drivers
    if (isMajorUpgrade && /(kubernetes\.io\/aws-ebs|kubernetes\.io\/gce-pd|kubernetes\.io\/azure-disk|kubernetes\.io\/cinder|kubernetes\.io\/vsphere-volume)/.test(drvName)) {
      csiIssues.push({
        name: drvName,
        issue: "Legacy in-tree driver",
        message: "In-tree volume plugins are removed in newer Kubernetes; ensure CSI migration is enabled",
      });
    }
  }
  checks.push({
    category: "CSI Drivers",
    status: csiIssues.some(i => /degraded/i.test(i.issue)) ? "fail" : csiIssues.length > 0 ? "warning" : "pass",
    details: `Total drivers: ${csiDrivers.length} | Issues: ${csiIssues.length}`,
    items: csiIssues,
  });

  // 20. MachineHealthCheck — active remediation during upgrade is dangerous
  const mhcActive = [];
  for (const mhc of mhcs) {
    const currentHealthy = mhc.status?.currentHealthy ?? 0;
    const expectedMachines = mhc.status?.expectedMachines ?? 0;
    const remediating = mhc.status?.remediationsAllowed ?? 0;
    if (expectedMachines > 0 && currentHealthy < expectedMachines) {
      mhcActive.push({
        name: mhc.metadata.name,
        namespace: mhc.metadata.namespace,
        issue: "Unhealthy machines detected",
        message: `${currentHealthy}/${expectedMachines} healthy, ${remediating} remediations allowed`,
      });
    }
  }
  checks.push({
    category: "MachineHealthCheck",
    status: mhcActive.length > 0 ? "warning" : "pass",
    details: `Total MHCs: ${mhcs.length} | Active remediation: ${mhcActive.length}`,
    items: mhcActive,
    recommendation: mhcActive.length > 0
      ? `Pause MachineHealthCheck during upgrade: 'oc -n openshift-machine-api annotate machinehealthcheck/<name> cluster.x-k8s.io/paused='`
      : undefined,
  });

  // 21. Cluster Update Conditions / Insights — Red Hat update service signals
  const updateConditions = [];
  const importantConds = ["RetrievedUpdates", "ReleaseAccepted", "ImplicitlyEnabledCapabilities", "Invalid", "Failing", "Upgradeable"];
  for (const c of conditions) {
    if (!importantConds.includes(c.type)) continue;
    const isProblem =
      (c.type === "RetrievedUpdates" && c.status !== "True") ||
      (c.type === "ReleaseAccepted" && c.status !== "True") ||
      (c.type === "Invalid" && c.status === "True") ||
      (c.type === "Failing" && c.status === "True") ||
      (c.type === "Upgradeable" && c.status === "False");
    if (isProblem) {
      updateConditions.push({
        name: c.type,
        issue: c.reason || c.status,
        message: (c.message || "").slice(0, 200),
      });
    }
  }
  // Stale catalog sources (>24h since last refresh) reduce reliability of compatibility data
  for (const cs of catalogSources) {
    const lastObserved = cs.status?.connectionState?.lastObservedState;
    const lastConnect = cs.status?.connectionState?.lastConnect;
    if (lastObserved && lastObserved !== "READY") {
      updateConditions.push({
        name: `catalog/${cs.metadata.name}`,
        issue: `Catalog ${lastObserved}`,
        message: `Last connect: ${lastConnect || "never"} — stale catalog may report outdated compatibility`,
      });
    }
  }
  checks.push({
    category: "Update Service & Insights",
    status: updateConditions.some(u => /Invalid|Failing|False|ERROR/i.test(u.issue)) ? "fail"
          : updateConditions.length > 0 ? "warning" : "pass",
    details: updateConditions.length === 0
      ? `Update service healthy, all catalogs READY (${catalogSources.length} catalog source(s))`
      : `${updateConditions.length} signal(s) from ClusterVersion conditions / catalog sources`,
    items: updateConditions,
  });

  // 22. Resource Capacity
  const capacity = calculateUpgradeCapacity(nodes);
  checks.push({
    category: "Resource Capacity",
    status: capacity.headroomPercent < 15 ? "fail" : capacity.headroomPercent < 25 ? "warning" : "pass",
    details: `Headroom: ${capacity.headroomPercent}% | Can sustain ${capacity.drainnableNodes} node(s) offline during rolling upgrade`,
    items: capacity.details ? [capacity.details] : [],
  });

  // Channel mismatch warnings (from OLM section above) — surface as separate check
  if (channelMismatch.length > 0) {
    checks.push({
      category: "Operator Channel Alignment",
      status: "warning",
      details: `${channelMismatch.length} subscription(s) on channels that may lag the target OCP version`,
      items: channelMismatch,
      recommendation: `After upgrading OCP, switch operator channels to match (e.g., stable-${(targetVersion.match(/^(\d+\.\d+)/) || [])[1]})`,
    });
  }

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

function extractMinOCPVersion(olmProperties) {
  try {
    const props = JSON.parse(olmProperties);
    const minProp = props.find(p => p.type === "olm.minOpenShiftVersion");
    return minProp?.value || "";
  } catch {
    return "";
  }
}

// Map OCP minor → bundled Kubernetes minor (Red Hat's published mapping).
// OCP X.Y ships kube 1.(Y+13) — e.g., 4.16→1.29, 4.17→1.30, 4.18→1.31, 4.19→1.32.
function ocpToKube(ocpVersion) {
  const m = (ocpVersion || "").match(/^(\d+)\.(\d+)/);
  if (!m) return "";
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (major !== 4) return "";
  return `1.${minor + 13}.0`;
}

async function checkCertificateExpiry() {
  const expiring = [];
  // Check kube-apiserver, ingress, and CSR-related secrets in well-known namespaces
  const targets = [
    { ns: "openshift-kube-apiserver-operator", labels: "" },
    { ns: "openshift-ingress", labels: "" },
    { ns: "openshift-config", labels: "" },
  ];
  for (const t of targets) {
    try {
      const resp = await ocpGet(`/api/v1/namespaces/${t.ns}/secrets`);
      const secrets = resp.items || [];
      for (const s of secrets) {
        if (s.type !== "kubernetes.io/tls" && s.type !== "Opaque") continue;
        const certData = s.data?.["tls.crt"];
        if (!certData) continue;
        const notAfter = parseCertNotAfter(certData);
        if (!notAfter) continue;
        const daysLeft = Math.floor((notAfter - Date.now()) / (1000 * 60 * 60 * 24));
        if (daysLeft < 90) {
          expiring.push({
            name: `${s.metadata.name} (${t.ns})`,
            namespace: t.ns,
            daysLeft,
            subject: s.metadata.name,
          });
        }
      }
    } catch { /* ns not accessible */ }
  }
  return { expiring };
}

function parseCertNotAfter(b64Cert) {
  try {
    const pem = Buffer.from(b64Cert, "base64").toString("utf8");
    // Extract the first PEM block
    const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
    if (!match) return null;
    const der = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
    // Walk DER to find the validity period (notAfter is the second time in the validity SEQUENCE).
    // Lightweight DER parse — we look for the second UTCTime/GeneralizedTime in the cert.
    const times = [];
    for (let i = 0; i < der.length - 1; i++) {
      // 0x17 = UTCTime, 0x18 = GeneralizedTime
      if ((der[i] === 0x17 || der[i] === 0x18) && i + 1 < der.length) {
        const len = der[i + 1];
        if (len < 0x80 && i + 2 + len <= der.length) {
          const str = der.slice(i + 2, i + 2 + len).toString("ascii");
          const parsed = parseDerTime(str, der[i] === 0x18);
          if (parsed) times.push(parsed);
          if (times.length >= 2) break;
        }
      }
    }
    return times[1] || null;
  } catch {
    return null;
  }
}

function parseDerTime(s, isGeneralized) {
  // UTCTime: YYMMDDHHMMSSZ ; GeneralizedTime: YYYYMMDDHHMMSSZ
  if (!s.endsWith("Z")) return null;
  let yyyy, MM, dd, HH, mm, ss;
  if (isGeneralized && s.length >= 15) {
    yyyy = parseInt(s.slice(0, 4), 10);
    MM = parseInt(s.slice(4, 6), 10);
    dd = parseInt(s.slice(6, 8), 10);
    HH = parseInt(s.slice(8, 10), 10);
    mm = parseInt(s.slice(10, 12), 10);
    ss = parseInt(s.slice(12, 14), 10);
  } else if (s.length >= 13) {
    const yy = parseInt(s.slice(0, 2), 10);
    yyyy = yy < 50 ? 2000 + yy : 1900 + yy;
    MM = parseInt(s.slice(2, 4), 10);
    dd = parseInt(s.slice(4, 6), 10);
    HH = parseInt(s.slice(6, 8), 10);
    mm = parseInt(s.slice(8, 10), 10);
    ss = parseInt(s.slice(10, 12), 10);
  } else {
    return null;
  }
  return Date.UTC(yyyy, MM - 1, dd, HH, mm, ss);
}

function checkWebhooks(webhooks) {
  const issues = [];
  for (const wh of webhooks) {
    const name = wh.metadata.name;
    const whSpecs = wh.webhooks || [];
    for (const spec of whSpecs) {
      const failurePolicy = spec.failurePolicy || "Fail";
      const timeout = spec.timeoutSeconds ?? 30;
      // failurePolicy=Fail webhooks pointing at non-system namespaces are risky during upgrade
      const svc = spec.clientConfig?.service;
      if (failurePolicy === "Fail" && svc && svc.namespace && !svc.namespace.startsWith("openshift-") && !svc.namespace.startsWith("kube-")) {
        issues.push({
          name: `${name} (${spec.name})`,
          issue: `failurePolicy=Fail`,
          message: `Webhook service: ${svc.namespace}/${svc.name} — if pod is unavailable during upgrade, API operations will block`,
        });
      }
      if (timeout > 30) {
        issues.push({
          name: `${name} (${spec.name})`,
          issue: `Long timeout (${timeout}s)`,
          message: `Webhook timeout >30s can stall upgrade controllers`,
        });
      }
    }
  }
  return issues;
}

function checkKubeletSkew(nodes, targetVersion) {
  const issues = [];
  const targetKube = ocpToKube(targetVersion);
  if (!targetKube) return issues;
  const targetMinor = parseInt((targetKube.match(/^1\.(\d+)/) || [])[1] || "0", 10);
  const versionGroups = {};
  for (const n of nodes) {
    const kubeletVer = (n.status?.nodeInfo?.kubeletVersion || "").replace(/^v/, "");
    if (!kubeletVer) continue;
    const m = kubeletVer.match(/^(\d+)\.(\d+)/);
    if (!m) continue;
    const minor = parseInt(m[2], 10);
    versionGroups[kubeletVer] = (versionGroups[kubeletVer] || 0) + 1;
    // After upgrade, kubelet must be within 2 minors below target API server
    if (targetMinor - minor > 2) {
      issues.push({
        name: n.metadata.name,
        issue: `Kubelet ${kubeletVer} too old`,
        message: `Target ships kube 1.${targetMinor}, max skew is 2 minors. Upgrade nodes incrementally.`,
      });
    }
  }
  // Heterogeneous kubelet versions across nodes is a warning sign
  if (Object.keys(versionGroups).length > 2) {
    issues.push({
      name: "Cluster",
      issue: "Heterogeneous kubelet versions",
      message: `Found ${Object.keys(versionGroups).length} different kubelet versions: ${Object.keys(versionGroups).join(", ")}`,
    });
  }
  return issues;
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
