import { z } from "zod";
import { ocpGet, ocpFetch } from "../utils/openshift-client.js";

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

  // ---------- Node Logs ----------
  server.tool(
    "nodes_log",
    "Get logs from a Kubernetes node (kubelet, kube-proxy, or other system service logs)",
    {
      name: z.string().describe("Node name"),
      query: z.string().describe("Service or log file to retrieve, e.g. 'kubelet', 'kube-proxy', 'crio', 'dmesg'"),
      tailLines: z.number().optional().default(200).describe("Number of lines from end of log"),
    },
    async ({ name, query, tailLines }) => {
      try {
        const path = `/api/v1/nodes/${name}/proxy/logs/${query}`;
        const logs = await ocpFetch(path, { headers: { Accept: "text/plain" } });
        const text = typeof logs === "string" ? logs : JSON.stringify(logs);
        const lines = text.split("\n");
        const tail = lines.slice(-tailLines).join("\n");

        return {
          content: [{
            type: "text",
            text: `### Node Logs: \`${name}\` — ${query} (last ${tailLines} lines)\n\n\`\`\`\n${tail || "(no logs)"}\n\`\`\``,
          }],
        };
      } catch (err) {
        if (err.message.includes("403") || err.message.includes("Forbidden")) {
          return {
            content: [{
              type: "text",
              text: `Access denied to node logs on \`${name}\`. The service account needs the \`nodes/proxy\` permission.\n\n**Equivalent command:**\n\`\`\`\noc adm node-logs ${name} --path=${query}\n\`\`\``,
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Node Stats Summary ----------
  server.tool(
    "nodes_stats_summary",
    "Get detailed resource usage statistics from a node via kubelet's Summary API",
    {
      name: z.string().describe("Node name"),
    },
    async ({ name }) => {
      try {
        const stats = await ocpGet(`/api/v1/nodes/${name}/proxy/stats/summary`);

        const nodeStats = stats.node || {};
        const lines = [`### Node Stats Summary: \`${name}\`\n`];

        if (nodeStats.cpu) {
          lines.push(`**CPU:** ${(nodeStats.cpu.usageNanoCores / 1e6).toFixed(0)}m used`);
        }
        if (nodeStats.memory) {
          const memUsedMi = Math.round((nodeStats.memory.workingSetBytes || 0) / (1024 * 1024));
          const memAvailMi = Math.round((nodeStats.memory.availableBytes || 0) / (1024 * 1024));
          lines.push(`**Memory:** ${memUsedMi}Mi working set, ${memAvailMi}Mi available`);
        }
        if (nodeStats.fs) {
          const fsUsedGi = ((nodeStats.fs.usedBytes || 0) / (1024 * 1024 * 1024)).toFixed(1);
          const fsCapGi = ((nodeStats.fs.capacityBytes || 0) / (1024 * 1024 * 1024)).toFixed(1);
          lines.push(`**Filesystem:** ${fsUsedGi}Gi / ${fsCapGi}Gi`);
        }
        if (nodeStats.runtime?.imageFs) {
          const imgUsed = ((nodeStats.runtime.imageFs.usedBytes || 0) / (1024 * 1024 * 1024)).toFixed(1);
          lines.push(`**Image FS:** ${imgUsed}Gi used`);
        }

        const pods = stats.pods || [];
        if (pods.length > 0) {
          lines.push(`\n**Pods on node:** ${pods.length}`);
          const topCpu = pods
            .filter(p => p.cpu?.usageNanoCores)
            .sort((a, b) => (b.cpu.usageNanoCores || 0) - (a.cpu.usageNanoCores || 0))
            .slice(0, 10);
          if (topCpu.length > 0) {
            lines.push("\n**Top Pods by CPU:**");
            lines.push("| Pod | Namespace | CPU | Memory |");
            lines.push("|---|---|---|---|");
            for (const p of topCpu) {
              const cpu = `${Math.round((p.cpu?.usageNanoCores || 0) / 1e6)}m`;
              const mem = `${Math.round((p.memory?.workingSetBytes || 0) / (1024 * 1024))}Mi`;
              lines.push(`| ${p.podRef?.name || "?"} | ${p.podRef?.namespace || "?"} | ${cpu} | ${mem} |`);
            }
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err.message.includes("403") || err.message.includes("Forbidden")) {
          return {
            content: [{
              type: "text",
              text: `Access denied to stats on \`${name}\`. The service account needs the \`nodes/proxy\` permission.`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
