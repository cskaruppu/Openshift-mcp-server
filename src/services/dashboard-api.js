/**
 * Dashboard REST API — called directly by the HTML dashboard via fetch().
 * These endpoints query the OpenShift API and return JSON.
 */

import { ocpGet } from "../utils/openshift-client.js";

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseCpu(s) {
  if (!s) return 0;
  if (typeof s === "number") return s;
  if (s.endsWith("n")) return parseInt(s) / 1e9;
  if (s.endsWith("u")) return parseInt(s) / 1e6;
  if (s.endsWith("m")) return parseInt(s) / 1e3;
  return parseFloat(s) || 0;
}

function parseMem(s) {
  if (!s) return 0;
  if (typeof s === "number") return s;
  if (s.endsWith("Ki")) return parseInt(s) * 1024;
  if (s.endsWith("Mi")) return parseInt(s) * 1024 * 1024;
  if (s.endsWith("Gi")) return parseInt(s) * 1024 * 1024 * 1024;
  if (s.endsWith("Ti")) return parseInt(s) * 1024 * 1024 * 1024 * 1024;
  return parseInt(s) || 0;
}

export async function handleDashboardAPI(pathname, req, res) {
  try {
    switch (pathname) {
      // ---- Cluster summary (top metrics) ----
      case "/api/cluster/summary": {
        const [clusterVersion, operators, nodes, namespaces] =
          await Promise.all([
            ocpGet("/apis/config.openshift.io/v1/clusterversions/version").catch(() => null),
            ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => null),
            ocpGet("/api/v1/nodes"),
            ocpGet("/api/v1/namespaces"),
          ]);

        const nodeList = nodes.items || [];
        const readyNodes = nodeList.filter((n) =>
          (n.status?.conditions || []).some(
            (c) => c.type === "Ready" && c.status === "True"
          )
        );

        let totalCPU = 0;
        let totalMemBytes = 0;
        for (const n of nodeList) {
          totalCPU += parseInt(n.status?.capacity?.cpu || "0", 10);
          const mem = n.status?.capacity?.memory || "0";
          if (mem.endsWith("Ki"))
            totalMemBytes += parseInt(mem) * 1024;
          else if (mem.endsWith("Mi"))
            totalMemBytes += parseInt(mem) * 1024 * 1024;
          else if (mem.endsWith("Gi"))
            totalMemBytes += parseInt(mem) * 1024 * 1024 * 1024;
          else totalMemBytes += parseInt(mem) || 0;
        }
        const totalMemGi = Math.round(totalMemBytes / (1024 * 1024 * 1024));

        const opItems = operators?.items || [];
        const degradedOps = opItems.filter((op) =>
          (op.status?.conditions || []).some(
            (c) => c.type === "Degraded" && c.status === "True"
          )
        );

        const nsList = namespaces.items || [];
        const userNS = nsList.filter(
          (ns) =>
            !ns.metadata.name.startsWith("openshift-") &&
            !ns.metadata.name.startsWith("kube-") &&
            ns.metadata.name !== "default" &&
            ns.metadata.name !== "openshift"
        );

        json(res, 200, {
          cluster: {
            version: clusterVersion?.status?.desired?.version || "unknown",
            channel: clusterVersion?.spec?.channel || "unknown",
            health:
              degradedOps.length > 0
                ? "degraded"
                : readyNodes.length < nodeList.length
                  ? "warning"
                  : "healthy",
          },
          nodes: {
            total: nodeList.length,
            ready: readyNodes.length,
            totalCPU,
            totalMemGi,
          },
          namespaces: {
            total: nsList.length,
            user: userNS.length,
            system: nsList.length - userNS.length,
          },
          operators: {
            total: opItems.length,
            healthy: opItems.length - degradedOps.length,
            degraded: degradedOps.length,
            degradedNames: degradedOps.map((o) => o.metadata.name),
          },
        });
        break;
      }

      // ---- Node list ----
      case "/api/nodes": {
        const nodes = await ocpGet("/api/v1/nodes");
        const result = await Promise.all(
          (nodes.items || []).map(async (node) => {
            const name = node.metadata.name;
            const conditions = (node.status?.conditions || []).reduce(
              (acc, c) => { acc[c.type] = c.status; return acc; }, {}
            );
            const roles = Object.keys(node.metadata.labels || {})
              .filter((l) => l.startsWith("node-role.kubernetes.io/"))
              .map((l) => l.replace("node-role.kubernetes.io/", ""));

            // Count pods on this node
            let podCount = 0;
            try {
              const pods = await ocpGet(
                `/api/v1/pods?fieldSelector=spec.nodeName=${name},status.phase=Running`
              );
              podCount = pods.items?.length || 0;
            } catch { /* ignore */ }

            return {
              name,
              roles,
              ready: conditions.Ready === "True",
              cpu: node.status?.capacity?.cpu || "0",
              memory: node.status?.capacity?.memory || "0",
              pods: podCount,
              kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
              osImage: node.status?.nodeInfo?.osImage,
            };
          })
        );
        json(res, 200, result);
        break;
      }

      // ---- Warning events (alerts) ----
      case "/api/alerts": {
        const events = await ocpGet("/api/v1/events");
        const warnings = (events.items || [])
          .filter((e) => e.type === "Warning")
          .sort(
            (a, b) =>
              new Date(b.lastTimestamp || b.metadata.creationTimestamp) -
              new Date(a.lastTimestamp || a.metadata.creationTimestamp)
          )
          .slice(0, 30);

        const alerts = warnings.map((e) => {
          let severity = "warning";
          const reason = (e.reason || "").toLowerCase();
          if (
            reason.includes("backoff") ||
            reason.includes("oomkill") ||
            reason.includes("failed") ||
            reason.includes("unhealthy")
          )
            severity = "critical";

          return {
            severity,
            resource: `${(e.involvedObject.kind || "").toLowerCase()}/${e.involvedObject.name}`,
            namespace: e.metadata.namespace,
            reason: e.reason,
            message: e.message,
            count: e.count,
            lastSeen: e.lastTimestamp || e.metadata.creationTimestamp,
          };
        });

        json(res, 200, alerts);
        break;
      }

      // ---- Pods with issues ----
      case "/api/pods/issues": {
        const pods = await ocpGet("/api/v1/pods");
        const issues = (pods.items || [])
          .filter((p) => {
            const phase = p.status?.phase;
            if (phase === "Failed" || phase === "Unknown") return true;
            return (p.status?.containerStatuses || []).some(
              (c) =>
                c.state?.waiting?.reason === "CrashLoopBackOff" ||
                c.state?.waiting?.reason === "ImagePullBackOff" ||
                c.state?.waiting?.reason === "ErrImagePull" ||
                c.lastState?.terminated?.reason === "OOMKilled" ||
                c.restartCount > 10
            );
          })
          .map((p) => {
            const cs = p.status?.containerStatuses || [];
            const problems = cs
              .filter(
                (c) =>
                  c.state?.waiting ||
                  c.lastState?.terminated?.reason === "OOMKilled" ||
                  c.restartCount > 10
              )
              .map((c) => ({
                container: c.name,
                reason:
                  c.state?.waiting?.reason ||
                  c.lastState?.terminated?.reason ||
                  `${c.restartCount} restarts`,
                restarts: c.restartCount,
              }));
            return {
              name: p.metadata.name,
              namespace: p.metadata.namespace,
              phase: p.status?.phase,
              node: p.spec?.nodeName,
              issues: problems,
            };
          });

        json(res, 200, issues);
        break;
      }

      // ---- Namespaces with workload counts ----
      case "/api/namespaces": {
        const namespaces = await ocpGet("/api/v1/namespaces");
        const nsList = (namespaces.items || [])
          .filter(
            (ns) =>
              !ns.metadata.name.startsWith("openshift-") &&
              !ns.metadata.name.startsWith("kube-") &&
              ns.metadata.name !== "default" &&
              ns.metadata.name !== "openshift"
          )
          .map((ns) => ({
            name: ns.metadata.name,
            status: ns.status?.phase,
            created: ns.metadata.creationTimestamp,
          }));

        json(res, 200, nsList);
        break;
      }

      // ---- ACM managed clusters ----
      case "/api/acm/clusters": {
        try {
          const data = await ocpGet(
            "/apis/cluster.open-cluster-management.io/v1/managedclusters"
          );
          const clusters = (data.items || []).map((c) => {
            const conditions = (c.status?.conditions || []).reduce(
              (acc, cond) => { acc[cond.type] = cond.status; return acc; }, {}
            );
            return {
              name: c.metadata.name,
              available:
                conditions.ManagedClusterConditionAvailable === "True",
              kubernetesVersion: c.status?.version?.kubernetes,
              capacity: c.status?.capacity,
              allocatable: c.status?.allocatable,
            };
          });
          json(res, 200, clusters);
        } catch {
          json(res, 200, []);
        }
        break;
      }

      // ---- Security posture widget ----
      case "/api/dashboard/security": {
        const findings = [];
        let score = 100;
        try {
          const pods = await ocpGet("/api/v1/pods");
          const items = (pods.items || []).filter(
            (p) => !p.metadata.namespace?.startsWith("openshift-") && !p.metadata.namespace?.startsWith("kube-")
          );
          const privilegedList = [];
          const runAsRootList = [];
          const noLimitsList = [];
          const latestTagList = [];
          const hostNetList = [];
          for (const p of items) {
            const pName = p.metadata.name;
            const pNs = p.metadata.namespace;
            if (p.spec?.hostNetwork) hostNetList.push({ namespace: pNs, pod: pName });
            for (const c of (p.spec?.containers || [])) {
              const sc = c.securityContext || {};
              const entry = { namespace: pNs, pod: pName, container: c.name };
              if (sc.privileged) privilegedList.push(entry);
              if (sc.runAsUser === 0 || (!sc.runAsNonRoot && !p.spec?.securityContext?.runAsNonRoot)) runAsRootList.push(entry);
              if (!c.resources?.limits?.cpu && !c.resources?.limits?.memory) noLimitsList.push(entry);
              const img = c.image || "";
              if (img.endsWith(":latest") || !img.includes(":")) latestTagList.push({ ...entry, image: img });
            }
          }
          if (privilegedList.length > 0) {
            score -= Math.min(25, privilegedList.length * 5);
            findings.push({ severity: "critical", msg: `${privilegedList.length} privileged container(s)`, affected: privilegedList.slice(0, 5),
              fix: "Set securityContext.privileged: false and drop all capabilities" });
          }
          if (hostNetList.length > 0) {
            score -= Math.min(10, hostNetList.length * 3);
            findings.push({ severity: "critical", msg: `${hostNetList.length} pod(s) using hostNetwork`, affected: hostNetList.slice(0, 5),
              fix: "Remove hostNetwork: true and use Services/Routes instead" });
          }
          if (runAsRootList.length > 0) {
            score -= Math.min(15, runAsRootList.length * 2);
            findings.push({ severity: "high", msg: `${runAsRootList.length} container(s) may run as root`, affected: runAsRootList.slice(0, 5),
              fix: "Set runAsNonRoot: true and specify runAsUser: 1000" });
          }
          if (noLimitsList.length > 0) {
            score -= Math.min(15, Math.ceil(noLimitsList.length / 2));
            findings.push({ severity: "warning", msg: `${noLimitsList.length} container(s) without resource limits`, affected: noLimitsList.slice(0, 5),
              fix: "Add resources.limits.cpu and resources.limits.memory to each container" });
          }
          if (latestTagList.length > 0) {
            score -= Math.min(10, latestTagList.length);
            findings.push({ severity: "warning", msg: `${latestTagList.length} image(s) using :latest or untagged`, affected: latestTagList.slice(0, 5),
              fix: "Pin images to specific tags or SHA digests" });
          }

          const nsList = items.map((p) => p.metadata.namespace).filter((v, i, a) => a.indexOf(v) === i);
          const uncoveredNsList = [];
          for (const ns of nsList) {
            try {
              const np = await ocpGet(`/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`);
              if (!np.items || np.items.length === 0) uncoveredNsList.push(ns);
            } catch { uncoveredNsList.push(ns); }
          }
          if (uncoveredNsList.length > 0) {
            score -= Math.min(15, uncoveredNsList.length * 3);
            findings.push({ severity: "high", msg: `${uncoveredNsList.length} namespace(s) without NetworkPolicy`,
              affected: uncoveredNsList.slice(0, 5).map((n) => ({ namespace: n })),
              fix: "Apply a default-deny NetworkPolicy to each namespace" });
          }

          score = Math.max(0, Math.round(score));
          const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
          json(res, 200, { score, grade, findings, podCount: items.length, namespaceCount: nsList.length });
        } catch (err) {
          json(res, 200, { score: 0, grade: "?", findings: [{ severity: "info", msg: "Could not compute: " + err.message }], podCount: 0, namespaceCount: 0 });
        }
        break;
      }

      // ---- GitOps sync status widget ----
      case "/api/dashboard/gitops": {
        try {
          const ns = "openshift-gitops";
          const data = await ocpGet(`/apis/argoproj.io/v1alpha1/namespaces/${ns}/applications`);
          const apps = (data.items || []).map((a) => ({
            name: a.metadata.name,
            sync: a.status?.sync?.status || "Unknown",
            health: a.status?.health?.status || "Unknown",
            repo: a.spec?.source?.repoURL || a.spec?.sources?.[0]?.repoURL || "",
          }));
          const synced = apps.filter((a) => a.sync === "Synced").length;
          const outOfSync = apps.filter((a) => a.sync === "OutOfSync").length;
          const degraded = apps.filter((a) => a.health === "Degraded").length;
          const healthy = apps.filter((a) => a.health === "Healthy").length;
          json(res, 200, { total: apps.length, synced, outOfSync, degraded, healthy, apps: apps.slice(0, 10) });
        } catch {
          json(res, 200, { total: 0, synced: 0, outOfSync: 0, degraded: 0, healthy: 0, apps: [], unavailable: true });
        }
        break;
      }

      // ---- DR readiness widget ----
      case "/api/dashboard/dr": {
        const veleroNs = "openshift-adp";
        try {
          const [backups, schedules, locations] = await Promise.all([
            ocpGet(`/apis/velero.io/v1/namespaces/${veleroNs}/backups`).catch(() => ({ items: [] })),
            ocpGet(`/apis/velero.io/v1/namespaces/${veleroNs}/schedules`).catch(() => ({ items: [] })),
            ocpGet(`/apis/velero.io/v1/namespaces/${veleroNs}/backupstoragelocations`).catch(() => ({ items: [] })),
          ]);
          const bkpItems = backups.items || [];
          const completed = bkpItems.filter((b) => b.status?.phase === "Completed");
          const failed = bkpItems.filter((b) => ["Failed", "PartiallyFailed"].includes(b.status?.phase));
          const schItems = schedules.items || [];
          const activeSchedules = schItems.filter((s) => !s.spec?.paused);
          const locItems = locations.items || [];
          const availLocs = locItems.filter((l) => l.status?.phase === "Available");

          completed.sort((a, b) => (b.status?.completionTimestamp || "").localeCompare(a.status?.completionTimestamp || ""));
          const lastGood = completed[0];
          let lastBackupAge = null;
          if (lastGood?.status?.completionTimestamp) {
            lastBackupAge = Math.floor((Date.now() - new Date(lastGood.status.completionTimestamp).getTime()) / 86400000);
          }

          let score = 100;
          if (locItems.length === 0) score -= 30;
          else if (availLocs.length === 0) score -= 25;
          if (schItems.length === 0) score -= 25;
          else if (activeSchedules.length === 0) score -= 20;
          if (completed.length === 0) score -= 25;
          else if (lastBackupAge != null && lastBackupAge > 7) score -= 15;
          if (failed.length > 0) score -= Math.min(15, failed.length * 5);
          score = Math.max(0, Math.round(score));
          const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

          json(res, 200, {
            installed: true, score, grade,
            backups: bkpItems.length, completed: completed.length, failed: failed.length,
            schedules: schItems.length, activeSchedules: activeSchedules.length,
            storageLocations: locItems.length, availableLocations: availLocs.length,
            lastBackup: lastGood?.metadata?.name || null, lastBackupAge,
          });
        } catch {
          json(res, 200, { installed: false, score: 0, grade: "?", backups: 0, completed: 0, failed: 0, schedules: 0, activeSchedules: 0, storageLocations: 0, availableLocations: 0, lastBackup: null, lastBackupAge: null });
        }
        break;
      }

      // ---- Resource optimization widget ----
      case "/api/dashboard/optimization": {
        try {
          const [pods, metricsData, nodes] = await Promise.all([
            ocpGet("/api/v1/pods"),
            ocpGet("/apis/metrics.k8s.io/v1beta1/pods").catch(() => ({ items: [] })),
            ocpGet("/api/v1/nodes"),
          ]);
          const podItems = (pods.items || []).filter(
            (p) => p.status?.phase === "Running" && !p.metadata.namespace?.startsWith("openshift-") && !p.metadata.namespace?.startsWith("kube-")
          );

          const metricsMap = {};
          for (const m of (metricsData.items || [])) {
            const key = `${m.metadata.namespace}/${m.metadata.name}`;
            let cpu = 0, mem = 0;
            for (const c of (m.containers || [])) {
              cpu += parseCpu(c.usage?.cpu);
              mem += parseMem(c.usage?.memory);
            }
            metricsMap[key] = { cpu, mem };
          }

          let overProvisioned = 0, underProvisioned = 0, noLimits = 0;
          const topProblems = [];
          for (const p of podItems) {
            const key = `${p.metadata.namespace}/${p.metadata.name}`;
            const usage = metricsMap[key];
            let reqCpu = 0, reqMem = 0, haslim = false;
            for (const c of (p.spec?.containers || [])) {
              reqCpu += parseCpu(c.resources?.requests?.cpu);
              reqMem += parseMem(c.resources?.requests?.memory);
              if (c.resources?.limits?.cpu || c.resources?.limits?.memory) haslim = true;
            }
            if (!haslim) { noLimits++; continue; }
            if (!usage) continue;
            if (reqCpu > 0 && usage.cpu < reqCpu * 0.1 && reqCpu >= 0.1) {
              overProvisioned++;
              topProblems.push({ name: p.metadata.name, ns: p.metadata.namespace, type: "over", detail: `CPU: using ${(usage.cpu * 1000).toFixed(0)}m, requested ${(reqCpu * 1000).toFixed(0)}m` });
            }
            if (reqCpu > 0 && usage.cpu > reqCpu * 1.5) {
              underProvisioned++;
              topProblems.push({ name: p.metadata.name, ns: p.metadata.namespace, type: "under", detail: `CPU: using ${(usage.cpu * 1000).toFixed(0)}m, requested ${(reqCpu * 1000).toFixed(0)}m` });
            }
          }

          const nodeItems = nodes.items || [];
          let totalAllocCpu = 0, totalAllocMem = 0, totalReqCpu = 0, totalReqMem = 0;
          for (const n of nodeItems) {
            totalAllocCpu += parseCpu(n.status?.allocatable?.cpu);
            totalAllocMem += parseMem(n.status?.allocatable?.memory);
          }
          for (const p of (pods.items || []).filter((p) => p.status?.phase === "Running")) {
            for (const c of (p.spec?.containers || [])) {
              totalReqCpu += parseCpu(c.resources?.requests?.cpu);
              totalReqMem += parseMem(c.resources?.requests?.memory);
            }
          }
          const cpuHeadroom = totalAllocCpu > 0 ? Math.round(((totalAllocCpu - totalReqCpu) / totalAllocCpu) * 100) : 0;
          const memHeadroom = totalAllocMem > 0 ? Math.round(((totalAllocMem - totalReqMem) / totalAllocMem) * 100) : 0;

          json(res, 200, {
            overProvisioned, underProvisioned, noLimits,
            cpuHeadroom, memHeadroom,
            totalPods: podItems.length,
            topProblems: topProblems.slice(0, 5),
          });
        } catch (err) {
          json(res, 200, { overProvisioned: 0, underProvisioned: 0, noLimits: 0, cpuHeadroom: 0, memHeadroom: 0, totalPods: 0, topProblems: [], error: err.message });
        }
        break;
      }

      default:
        json(res, 404, { error: "Unknown API endpoint" });
    }
  } catch (err) {
    console.error(`Dashboard API error [${pathname}]:`, err.message);
    json(res, 500, { error: err.message });
  }
}
