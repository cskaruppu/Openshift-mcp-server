/**
 * Change Impact Prediction
 *
 * Before applying destructive operations, predicts consequences:
 * node capacity impact, quota usage, PDB violations, dependency effects.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerImpactTools(server) {
  server.tool(
    "predict_impact",
    "Predict the impact of a cluster change before executing it: resource pressure, quota usage, PDB violations, and dependency effects",
    {
      action: z.enum(["scale", "delete_pod", "drain_node", "cordon_node", "rollback"]).describe("Type of change"),
      resource: z.string().describe("Resource name (e.g., deployment/nginx)"),
      namespace: z.string().describe("Namespace"),
      replicas: z.number().optional().describe("Target replicas (for scale action)"),
      nodeName: z.string().optional().describe("Node name (for drain/cordon)"),
    },
    async ({ action, resource, namespace, replicas, nodeName }) => {
      const risks = [];
      const safe = [];
      const impacts = [];

      if (action === "scale") {
        const [kind, name] = resource.includes("/") ? resource.split("/") : ["deployment", resource];
        const deploy = await ocpGet(`/apis/apps/v1/namespaces/${namespace}/${kind}s/${name}`).catch(() => null);
        if (!deploy) return { content: [{ type: "text", text: `Resource ${resource} not found in ${namespace}` }] };

        const currentReplicas = deploy.spec?.replicas || 1;
        const targetReplicas = replicas ?? currentReplicas;
        const delta = targetReplicas - currentReplicas;

        if (delta === 0) {
          safe.push("No change — already at target replica count");
        }

        // Check resource requirements per pod
        const container = deploy.spec?.template?.spec?.containers?.[0] || {};
        const reqCpu = parseCpu(container.resources?.requests?.cpu) || 0.1;
        const reqMem = parseMem(container.resources?.requests?.memory) || 128 * 1024 * 1024;
        const additionalCpu = reqCpu * Math.abs(delta);
        const additionalMem = reqMem * Math.abs(delta);

        if (delta > 0) {
          impacts.push(`Additional resources needed: ${fmtCpu(additionalCpu)} CPU, ${fmtMem(additionalMem)} memory`);

          // Check node capacity
          const [nodesResp, metricsResp] = await Promise.allSettled([
            ocpGet("/api/v1/nodes"),
            ocpGet("/apis/metrics.k8s.io/v1beta1/nodes").catch(() => ({ items: [] })),
          ]);

          const nodes = nodesResp.status === "fulfilled" ? (nodesResp.value.items || []) : [];
          const metrics = metricsResp.status === "fulfilled" ? (metricsResp.value.items || []) : [];
          const metricsMap = {};
          for (const m of metrics) metricsMap[m.metadata.name] = m;

          for (const node of nodes) {
            const allocCpu = parseCpu(node.status?.allocatable?.cpu);
            const m = metricsMap[node.metadata.name];
            if (m) {
              const usedCpu = parseCpu(m.usage?.cpu);
              const utilization = (usedCpu / allocCpu) * 100;
              const projected = ((usedCpu + additionalCpu) / allocCpu) * 100;
              if (projected > 90) {
                risks.push(`Node ${node.metadata.name}: CPU projected ${Math.round(projected)}% (currently ${Math.round(utilization)}%)`);
              } else if (projected > 75) {
                impacts.push(`Node ${node.metadata.name}: CPU will increase to ~${Math.round(projected)}%`);
              }
            }
          }

          // Check quota
          const quotas = await ocpGet(`/api/v1/namespaces/${namespace}/resourcequotas`).catch(() => ({ items: [] }));
          for (const q of quotas.items || []) {
            const podLimit = parseInt(q.spec?.hard?.pods || "0");
            const podUsed = parseInt(q.status?.used?.pods || "0");
            if (podLimit > 0 && podUsed + delta > podLimit) {
              risks.push(`Quota '${q.metadata.name}': pods ${podUsed}+${delta} exceeds limit of ${podLimit}`);
            }
          }
        }

        if (delta < 0 && targetReplicas === 0) {
          risks.push("Scaling to 0 replicas will cause service outage");
          const svcs = await ocpGet(`/api/v1/namespaces/${namespace}/services`).catch(() => ({ items: [] }));
          const matchLabels = deploy.spec?.selector?.matchLabels || {};
          for (const svc of svcs.items || []) {
            const selects = Object.entries(svc.spec?.selector || {}).every(([k, v]) => matchLabels[k] === v);
            if (selects) risks.push(`Service '${svc.metadata.name}' will lose all backends`);
          }
        }

        // Check PDB
        const pdbs = await ocpGet(`/apis/policy/v1/namespaces/${namespace}/poddisruptionbudgets`).catch(() => ({ items: [] }));
        for (const pdb of pdbs.items || []) {
          const sel = pdb.spec?.selector?.matchLabels || {};
          const matchLabels = deploy.spec?.selector?.matchLabels || {};
          const matches = Object.entries(sel).every(([k, v]) => matchLabels[k] === v);
          if (matches && delta < 0) {
            const minAvail = pdb.spec?.minAvailable;
            if (minAvail && targetReplicas < parseInt(minAvail)) {
              risks.push(`PDB '${pdb.metadata.name}' requires minAvailable=${minAvail} but target is ${targetReplicas}`);
            }
          }
        }

        if (delta > 0 && risks.length === 0) safe.push("Sufficient cluster capacity for scale-up");
      }

      if (action === "drain_node" || action === "cordon_node") {
        const node = nodeName || resource;
        const pods = await ocpGet(`/api/v1/pods?fieldSelector=spec.nodeName=${node}`).catch(() => ({ items: [] }));
        const userPods = (pods.items || []).filter((p) => !p.metadata.namespace?.startsWith("openshift-") && p.metadata.namespace !== "kube-system");

        impacts.push(`${userPods.length} user pods on node ${node} will be affected`);

        if (action === "drain_node") {
          const stateful = userPods.filter((p) => (p.spec?.volumes || []).some((v) => v.persistentVolumeClaim));
          if (stateful.length > 0) risks.push(`${stateful.length} pod(s) have PVCs — data migration may be needed`);

          const noPDB = userPods.filter((p) => {
            const labels = p.metadata?.labels || {};
            return Object.keys(labels).length > 0;
          });
          impacts.push(`${noPDB.length} pod(s) may be disrupted during drain`);
        }

        const readyNodes = (await ocpGet("/api/v1/nodes").catch(() => ({ items: [] }))).items?.filter((n) =>
          n.metadata.name !== node && (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True")
        ) || [];
        if (readyNodes.length === 0) risks.push("No other ready nodes available — pods cannot be rescheduled");
        else safe.push(`${readyNodes.length} other ready node(s) available for rescheduling`);
      }

      if (action === "delete_pod") {
        const [kind, name] = resource.includes("/") ? resource.split("/") : ["pod", resource];
        const pod = await ocpGet(`/api/v1/namespaces/${namespace}/pods/${name}`).catch(() => null);
        if (pod) {
          const owner = (pod.metadata?.ownerReferences || [])[0];
          if (owner) safe.push(`Pod managed by ${owner.kind}/${owner.name} — will be recreated`);
          else risks.push("Pod has no owner — deletion is permanent, it will NOT be recreated");
        }
      }

      // Build report
      const overallRisk = risks.length > 0 ? "HIGH" : impacts.length > 0 ? "MEDIUM" : "LOW";
      const lines = [
        `### Impact Prediction: ${action} ${resource}`,
        "",
        `| Property | Value |`,
        `|----------|-------|`,
        `| Action | ${action} |`,
        `| Resource | ${resource} |`,
        `| Namespace | ${namespace} |`,
        replicas !== undefined ? `| Target replicas | ${replicas} |` : null,
        `| **Risk level** | **${overallRisk}** |`,
        "",
      ].filter(Boolean);

      if (risks.length > 0) {
        lines.push("#### Risks");
        for (const r of risks) lines.push(`- ${r}`);
        lines.push("");
      }
      if (impacts.length > 0) {
        lines.push("#### Impacts");
        for (const i of impacts) lines.push(`- ${i}`);
        lines.push("");
      }
      if (safe.length > 0) {
        lines.push("#### Safe");
        for (const s of safe) lines.push(`- ${s}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

function parseCpu(str) {
  if (!str) return 0;
  if (typeof str === "number") return str;
  str = String(str);
  if (str.endsWith("m")) return parseInt(str) / 1000;
  if (str.endsWith("n")) return parseInt(str) / 1e9;
  return parseFloat(str) || 0;
}

function parseMem(str) {
  if (!str) return 0;
  str = String(str);
  if (str.endsWith("Ki")) return parseInt(str) * 1024;
  if (str.endsWith("Mi")) return parseInt(str) * 1024 * 1024;
  if (str.endsWith("Gi")) return parseInt(str) * 1024 * 1024 * 1024;
  return parseInt(str) || 0;
}

function fmtCpu(cores) { return cores >= 1 ? `${cores.toFixed(1)} cores` : `${Math.round(cores * 1000)}m`; }
function fmtMem(bytes) { return bytes >= 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}Gi` : `${Math.round(bytes / (1024 * 1024))}Mi`; }
