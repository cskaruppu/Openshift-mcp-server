/**
 * Metrics-server top toolset — CPU/memory usage for pods and nodes
 * via the metrics.k8s.io API.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

function formatCpu(nanoStr) {
  if (!nanoStr) return "0m";
  if (nanoStr.endsWith("n")) {
    const nano = parseInt(nanoStr, 10);
    return `${Math.round(nano / 1e6)}m`;
  }
  if (nanoStr.endsWith("m")) return nanoStr;
  return `${Math.round(parseFloat(nanoStr) * 1000)}m`;
}

function formatMemory(kiStr) {
  if (!kiStr) return "0Mi";
  if (kiStr.endsWith("Ki")) {
    const ki = parseInt(kiStr, 10);
    return `${Math.round(ki / 1024)}Mi`;
  }
  if (kiStr.endsWith("Mi")) return kiStr;
  if (kiStr.endsWith("Gi")) return kiStr;
  return `${Math.round(parseInt(kiStr, 10) / (1024 * 1024))}Mi`;
}

export function registerMetricsTopTools(server) {
  server.tool(
    "pods_top",
    "List resource consumption (CPU and memory) for Kubernetes Pods via metrics-server",
    {
      namespace: z.string().optional().describe("Namespace (omit for all namespaces)"),
      name: z.string().optional().describe("Specific pod name"),
      labelSelector: z.string().optional().describe("Filter pods by label selector"),
    },
    async ({ namespace, name, labelSelector }) => {
      try {
        let path;
        if (name && namespace) {
          path = `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${name}`;
        } else if (namespace) {
          path = `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`;
        } else {
          path = "/apis/metrics.k8s.io/v1beta1/pods";
        }
        if (labelSelector) path += `${path.includes("?") ? "&" : "?"}labelSelector=${encodeURIComponent(labelSelector)}`;

        const data = await ocpGet(path);

        const items = data.items || (data.metadata ? [data] : []);
        if (items.length === 0) {
          return { content: [{ type: "text", text: "No pod metrics found. Ensure metrics-server is installed." }] };
        }

        const rows = items.map(m => {
          const containers = (m.containers || []);
          const totalCpu = containers.reduce((s, c) => {
            const raw = c.usage?.cpu || "0";
            if (raw.endsWith("n")) return s + parseInt(raw, 10);
            if (raw.endsWith("m")) return s + parseInt(raw, 10) * 1e6;
            return s + parseFloat(raw) * 1e9;
          }, 0);
          const totalMem = containers.reduce((s, c) => {
            const raw = c.usage?.memory || "0";
            if (raw.endsWith("Ki")) return s + parseInt(raw, 10);
            if (raw.endsWith("Mi")) return s + parseInt(raw, 10) * 1024;
            if (raw.endsWith("Gi")) return s + parseInt(raw, 10) * 1024 * 1024;
            return s + parseInt(raw, 10) / 1024;
          }, 0);
          return {
            name: m.metadata.name,
            namespace: m.metadata.namespace,
            cpu: `${Math.round(totalCpu / 1e6)}m`,
            memory: `${Math.round(totalMem / 1024)}Mi`,
            containers: containers.length,
          };
        });

        rows.sort((a, b) => parseInt(b.cpu) - parseInt(a.cpu));

        const lines = [
          "### Pod Resource Usage\n",
          "| Pod | Namespace | CPU | Memory | Containers |",
          "|---|---|---|---|---|",
        ];
        for (const r of rows.slice(0, 100)) {
          lines.push(`| ${r.name} | ${r.namespace} | ${r.cpu} | ${r.memory} | ${r.containers} |`);
        }
        if (rows.length > 100) lines.push(`\n_Showing 100 of ${rows.length} pods._`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err.message.includes("404")) {
          return { content: [{ type: "text", text: "Metrics API not available. Ensure metrics-server or OpenShift monitoring is installed.\n\nInstall: `oc apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`" }] };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "nodes_top",
    "List resource consumption (CPU and memory) for Kubernetes Nodes via metrics-server",
    {
      name: z.string().optional().describe("Specific node name"),
      labelSelector: z.string().optional().describe("Filter nodes by label selector"),
    },
    async ({ name, labelSelector }) => {
      try {
        let metricsPath = name
          ? `/apis/metrics.k8s.io/v1beta1/nodes/${name}`
          : "/apis/metrics.k8s.io/v1beta1/nodes";
        if (labelSelector) metricsPath += `?labelSelector=${encodeURIComponent(labelSelector)}`;

        const [metricsData, nodesData] = await Promise.all([
          ocpGet(metricsPath),
          ocpGet(name ? `/api/v1/nodes/${name}` : "/api/v1/nodes"),
        ]);

        const metricsItems = metricsData.items || (metricsData.metadata ? [metricsData] : []);
        const nodeItems = nodesData.items || (nodesData.metadata ? [nodesData] : []);

        if (metricsItems.length === 0) {
          return { content: [{ type: "text", text: "No node metrics found." }] };
        }

        const capacityMap = {};
        for (const n of nodeItems) {
          const alloc = n.status?.allocatable || n.status?.capacity || {};
          capacityMap[n.metadata.name] = {
            cpu: alloc.cpu,
            memory: alloc.memory,
          };
        }

        const lines = [
          "### Node Resource Usage\n",
          "| Node | CPU Used | CPU Capacity | CPU % | Memory Used | Memory Capacity | Memory % |",
          "|---|---|---|---|---|---|---|",
        ];

        for (const m of metricsItems) {
          const nodeName = m.metadata.name;
          const cpuUsed = m.usage?.cpu || "0";
          const memUsed = m.usage?.memory || "0";
          const cap = capacityMap[nodeName] || {};

          let cpuUsedMilli = 0;
          if (cpuUsed.endsWith("n")) cpuUsedMilli = parseInt(cpuUsed, 10) / 1e6;
          else if (cpuUsed.endsWith("m")) cpuUsedMilli = parseInt(cpuUsed, 10);
          else cpuUsedMilli = parseFloat(cpuUsed) * 1000;

          let cpuCapMilli = 0;
          if (cap.cpu) {
            if (cap.cpu.endsWith("m")) cpuCapMilli = parseInt(cap.cpu, 10);
            else cpuCapMilli = parseFloat(cap.cpu) * 1000;
          }

          let memUsedKi = 0;
          if (memUsed.endsWith("Ki")) memUsedKi = parseInt(memUsed, 10);
          else if (memUsed.endsWith("Mi")) memUsedKi = parseInt(memUsed, 10) * 1024;
          else if (memUsed.endsWith("Gi")) memUsedKi = parseInt(memUsed, 10) * 1024 * 1024;

          let memCapKi = 0;
          if (cap.memory) {
            if (cap.memory.endsWith("Ki")) memCapKi = parseInt(cap.memory, 10);
            else if (cap.memory.endsWith("Mi")) memCapKi = parseInt(cap.memory, 10) * 1024;
            else if (cap.memory.endsWith("Gi")) memCapKi = parseInt(cap.memory, 10) * 1024 * 1024;
          }

          const cpuPct = cpuCapMilli > 0 ? Math.round((cpuUsedMilli / cpuCapMilli) * 100) : 0;
          const memPct = memCapKi > 0 ? Math.round((memUsedKi / memCapKi) * 100) : 0;

          const cpuWarn = cpuPct >= 90 ? " [WARN]" : "";
          const memWarn = memPct >= 90 ? " [WARN]" : "";

          lines.push(
            `| ${nodeName} | ${Math.round(cpuUsedMilli)}m | ${Math.round(cpuCapMilli)}m | ${cpuPct}%${cpuWarn} | ${Math.round(memUsedKi / 1024)}Mi | ${Math.round(memCapKi / 1024)}Mi | ${memPct}%${memWarn} |`
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err.message.includes("404")) {
          return { content: [{ type: "text", text: "Metrics API not available. Ensure metrics-server or OpenShift monitoring is installed." }] };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
