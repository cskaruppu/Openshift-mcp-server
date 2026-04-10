/**
 * Dashboard REST API — called directly by the HTML dashboard via fetch().
 * These endpoints query the OpenShift API and return JSON.
 */

import { ocpGet } from "../utils/openshift-client.js";

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
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

      default:
        json(res, 404, { error: "Unknown API endpoint" });
    }
  } catch (err) {
    console.error(`Dashboard API error [${pathname}]:`, err.message);
    json(res, 500, { error: err.message });
  }
}
