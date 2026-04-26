/**
 * SCC (SecurityContextConstraints) Policy Advisor — OpenShift-only
 *
 * Explains which SCC applies to a pod and why, identifies over-privileged
 * workloads, and recommends least-privilege SCC assignments.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

const SCC_PRIVILEGE_ORDER = [
  "restricted", "restricted-v2", "nonroot", "nonroot-v2",
  "hostmount-anyuid", "anyuid", "hostnetwork", "hostaccess",
  "node-exporter", "privileged",
];

export function registerSCCAdvisorTools(server) {
  server.tool(
    "scc_explain",
    "Explain which SCC is assigned to a pod and why. Shows the SCC chain, matching criteria, and whether the pod is over-privileged.",
    {
      namespace: z.string().describe("Pod namespace"),
      podName: z.string().describe("Pod name"),
    },
    async ({ namespace, podName }) => {
      const pod = await ocpGet(`/api/v1/namespaces/${namespace}/pods/${podName}`);
      const assignedSCC = pod.metadata?.annotations?.["openshift.io/scc"] || "unknown";

      const sccs = await ocpGet("/apis/security.openshift.io/v1/securitycontextconstraints");
      const sccObj = (sccs.items || []).find((s) => s.metadata.name === assignedSCC);

      const sa = pod.spec?.serviceAccountName || "default";
      const containers = pod.spec?.containers || [];

      const podRequirements = {
        runAsRoot: containers.some((c) => c.securityContext?.runAsUser === 0),
        privileged: containers.some((c) => c.securityContext?.privileged),
        hostNetwork: !!pod.spec?.hostNetwork,
        hostPID: !!pod.spec?.hostPID,
        hostIPC: !!pod.spec?.hostIPC,
        readOnlyRootFS: containers.every((c) => c.securityContext?.readOnlyRootFilesystem),
        capabilities: [...new Set(containers.flatMap((c) => c.securityContext?.capabilities?.add || []))],
        dropsAll: containers.every((c) => (c.securityContext?.capabilities?.drop || []).some((d) => d === "ALL" || d === "all")),
        volumes: [...new Set((pod.spec?.volumes || []).map((v) => Object.keys(v).find((k) => k !== "name") || "unknown"))],
      };

      // Find the least-privilege SCC that would work
      let leastPriv = null;
      for (const sccName of SCC_PRIVILEGE_ORDER) {
        const scc = (sccs.items || []).find((s) => s.metadata.name === sccName);
        if (!scc) continue;
        if (wouldSCCWork(scc, podRequirements)) {
          leastPriv = sccName;
          break;
        }
      }

      const overPrivileged = leastPriv && assignedSCC !== leastPriv && SCC_PRIVILEGE_ORDER.indexOf(assignedSCC) > SCC_PRIVILEGE_ORDER.indexOf(leastPriv);

      const lines = [
        `### SCC Analysis — ${namespace}/${podName}`,
        "",
        `| Property | Value |`,
        `|----------|-------|`,
        `| Assigned SCC | **${assignedSCC}** |`,
        `| ServiceAccount | ${sa} |`,
        `| Runs as root | ${podRequirements.runAsRoot ? "Yes" : "No"} |`,
        `| Privileged | ${podRequirements.privileged ? "Yes" : "No"} |`,
        `| Host network | ${podRequirements.hostNetwork ? "Yes" : "No"} |`,
        `| Read-only rootfs | ${podRequirements.readOnlyRootFS ? "Yes" : "No"} |`,
        `| Drops ALL caps | ${podRequirements.dropsAll ? "Yes" : "No"} |`,
        `| Added capabilities | ${podRequirements.capabilities.length > 0 ? podRequirements.capabilities.join(", ") : "None"} |`,
        "",
      ];

      if (sccObj) {
        lines.push("#### SCC Details");
        lines.push(`- allowPrivilegedContainer: ${sccObj.allowPrivilegedContainer}`);
        lines.push(`- runAsUser: ${sccObj.runAsUser?.type || "RunAsAny"}`);
        lines.push(`- readOnlyRootFilesystem: ${sccObj.readOnlyRootFilesystem || false}`);
        lines.push(`- requiredDropCapabilities: ${(sccObj.requiredDropCapabilities || []).join(", ") || "none"}`);
        lines.push("");
      }

      if (overPrivileged) {
        lines.push(`#### Recommendation`);
        lines.push(`This pod is **over-privileged**. It uses SCC \`${assignedSCC}\` but only needs \`${leastPriv}\`.`);
        lines.push("");
        lines.push("To apply least-privilege:");
        lines.push("```");
        lines.push(`oc adm policy remove-scc-from-user ${assignedSCC} -z ${sa} -n ${namespace}`);
        lines.push(`oc adm policy add-scc-to-user ${leastPriv} -z ${sa} -n ${namespace}`);
        lines.push("```");
      } else if (leastPriv) {
        lines.push(`Assigned SCC \`${assignedSCC}\` is appropriate for this pod's requirements.`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "scc_audit",
    "Audit all pods in a namespace for SCC assignments and identify over-privileged workloads",
    {
      namespace: z.string().optional().describe("Namespace to audit (omit for cluster-wide)"),
    },
    async ({ namespace }) => {
      const podsResp = namespace
        ? await ocpGet(`/api/v1/namespaces/${namespace}/pods`)
        : await ocpGet("/api/v1/pods");

      const pods = (podsResp.items || []).filter(
        (p) => p.status?.phase === "Running" && !p.metadata.namespace?.startsWith("openshift-") && p.metadata.namespace !== "kube-system"
      );

      const sccCounts = {};
      const privilegedPods = [];
      const anyuidPods = [];

      for (const p of pods) {
        const scc = p.metadata?.annotations?.["openshift.io/scc"] || "unknown";
        sccCounts[scc] = (sccCounts[scc] || 0) + 1;

        if (scc === "privileged") {
          privilegedPods.push(`${p.metadata.namespace}/${p.metadata.name}`);
        } else if (scc === "anyuid") {
          anyuidPods.push(`${p.metadata.namespace}/${p.metadata.name}`);
        }
      }

      const lines = [
        `### SCC Audit${namespace ? ` — ${namespace}` : " — Cluster-wide"}`,
        "",
        `Total running pods analyzed: ${pods.length}`,
        "",
        "#### SCC Distribution",
        ...Object.entries(sccCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([scc, count]) => {
            const risk = scc === "privileged" ? " [HIGH RISK]" : scc === "anyuid" ? " [MEDIUM RISK]" : "";
            return `- **${scc}**: ${count} pod(s)${risk}`;
          }),
        "",
      ];

      if (privilegedPods.length > 0) {
        lines.push("#### Privileged Pods (HIGH RISK)");
        lines.push("These pods have full host access:");
        for (const p of privilegedPods.slice(0, 20)) lines.push(`- ${p}`);
        if (privilegedPods.length > 20) lines.push(`- ... and ${privilegedPods.length - 20} more`);
        lines.push("");
      }

      if (anyuidPods.length > 0) {
        lines.push("#### anyuid Pods (review needed)");
        lines.push("These pods run as any UID — verify they actually need it:");
        for (const p of anyuidPods.slice(0, 15)) lines.push(`- ${p}`);
        if (anyuidPods.length > 15) lines.push(`- ... and ${anyuidPods.length - 15} more`);
        lines.push("");
      }

      const score = Math.max(0, 100 - privilegedPods.length * 10 - anyuidPods.length * 3);
      lines.push(`#### SCC Security Score: ${score}/100`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

function wouldSCCWork(scc, req) {
  if (req.privileged && !scc.allowPrivilegedContainer) return false;
  if (req.hostNetwork && !scc.allowHostNetwork) return false;
  if (req.hostPID && !scc.allowHostPID) return false;
  if (req.runAsRoot && scc.runAsUser?.type === "MustRunAsNonRoot") return false;
  return true;
}
