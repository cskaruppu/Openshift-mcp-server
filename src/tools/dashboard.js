import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerDashboardTools(server) {
  // ---------- Dashboard Summary ----------
  server.tool(
    "get_dashboard_summary",
    "Get a comprehensive cluster summary suitable for the MCP AI Assistant dashboard — nodes, pods, deployments, health, alerts",
    {},
    async () => {
      try {
        const [nodes, namespaces, clusterVersion, operators] =
          await Promise.all([
            ocpGet("/api/v1/nodes"),
            ocpGet("/api/v1/namespaces"),
            ocpGet(
              "/apis/config.openshift.io/v1/clusterversions/version"
            ).catch(() => null),
            ocpGet(
              "/apis/config.openshift.io/v1/clusteroperators"
            ).catch(() => null),
          ]);

        // Node summary
        const nodeList = nodes.items || [];
        const readyNodes = nodeList.filter((n) =>
          (n.status?.conditions || []).some(
            (c) => c.type === "Ready" && c.status === "True"
          )
        );

        // Aggregate capacity
        let totalCPU = 0;
        let totalMemGB = 0;
        for (const n of nodeList) {
          totalCPU += parseInt(n.status?.capacity?.cpu || "0");
          const mem = n.status?.capacity?.memory || "0";
          totalMemGB +=
            parseInt(mem) / (mem.endsWith("Ki") ? 1048576 : 1073741824);
        }

        // Operators
        const opItems = operators?.items || [];
        const degradedOps = opItems.filter((op) =>
          (op.status?.conditions || []).some(
            (c) => c.type === "Degraded" && c.status === "True"
          )
        );

        const nsList = namespaces.items || [];
        const userNamespaces = nsList.filter(
          (ns) =>
            !ns.metadata.name.startsWith("openshift-") &&
            !ns.metadata.name.startsWith("kube-") &&
            ns.metadata.name !== "default" &&
            ns.metadata.name !== "openshift"
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  cluster: {
                    version:
                      clusterVersion?.status?.desired?.version || "unknown",
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
                    totalCPU: `${totalCPU} cores`,
                    totalMemory: `${Math.round(totalMemGB)} Gi`,
                  },
                  namespaces: {
                    total: nsList.length,
                    user: userNamespaces.length,
                  },
                  operators: {
                    total: opItems.length,
                    degraded: degradedOps.length,
                    degradedNames: degradedOps.map(
                      (o) => o.metadata.name
                    ),
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
