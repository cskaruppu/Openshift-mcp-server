import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerNodeTools(server) {
  // ---------- List Nodes ----------
  server.tool(
    "list_nodes",
    "List all OpenShift cluster nodes with status, roles, and resource capacity",
    {},
    async () => {
      try {
        const data = await ocpGet("/api/v1/nodes");
        const nodes = (data.items || []).map((node) => {
          const conditions = (node.status?.conditions || []).reduce(
            (acc, c) => {
              acc[c.type] = { status: c.status, message: c.message };
              return acc;
            },
            {}
          );
          const labels = node.metadata.labels || {};
          return {
            name: node.metadata.name,
            roles: Object.keys(labels)
              .filter((l) => l.startsWith("node-role.kubernetes.io/"))
              .map((l) => l.replace("node-role.kubernetes.io/", "")),
            status: conditions.Ready?.status === "True" ? "Ready" : "NotReady",
            kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
            osImage: node.status?.nodeInfo?.osImage,
            containerRuntime: node.status?.nodeInfo?.containerRuntimeVersion,
            architecture: node.status?.nodeInfo?.architecture,
            capacity: {
              cpu: node.status?.capacity?.cpu,
              memory: node.status?.capacity?.memory,
              pods: node.status?.capacity?.pods,
            },
            conditions,
            taints: node.spec?.taints || [],
          };
        });

        return {
          content: [
            { type: "text", text: JSON.stringify(nodes, null, 2) },
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

  // ---------- Get Node Details ----------
  server.tool(
    "get_node_details",
    "Get detailed information about a specific node including conditions, addresses, and resource usage",
    {
      nodeName: z.string().describe("Name of the node to inspect"),
    },
    async ({ nodeName }) => {
      try {
        const node = await ocpGet(`/api/v1/nodes/${nodeName}`);
        const pods = await ocpGet(
          `/api/v1/pods?fieldSelector=spec.nodeName=${nodeName}`
        );

        const podSummary = (pods.items || []).map((p) => ({
          name: p.metadata.name,
          namespace: p.metadata.namespace,
          phase: p.status?.phase,
          restarts:
            p.status?.containerStatuses?.reduce(
              (sum, cs) => sum + (cs.restartCount || 0),
              0
            ) || 0,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: node.metadata.name,
                  labels: node.metadata.labels,
                  annotations: node.metadata.annotations,
                  conditions: node.status?.conditions,
                  addresses: node.status?.addresses,
                  nodeInfo: node.status?.nodeInfo,
                  capacity: node.status?.capacity,
                  allocatable: node.status?.allocatable,
                  taints: node.spec?.taints || [],
                  podsOnNode: podSummary.length,
                  pods: podSummary,
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
