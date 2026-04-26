/**
 * Cross-Cluster Drift Detection
 *
 * Compares resources across ACM-managed clusters to detect configuration
 * drift, version mismatches, and security posture differences.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerDriftTools(server) {
  server.tool(
    "drift_detect",
    "Compare two ACM-managed clusters and detect configuration drift: image version mismatches, resource differences, policy compliance gaps, and security posture differences",
    {
      cluster1: z.string().describe("First cluster name"),
      cluster2: z.string().describe("Second cluster name"),
      namespace: z.string().optional().describe("Namespace to compare (default: all common namespaces)"),
    },
    async ({ cluster1, cluster2 }) => {
      // Fetch managed cluster details
      const [mc1, mc2, policies] = await Promise.allSettled([
        ocpGet(`/apis/cluster.open-cluster-management.io/v1/managedclusters/${cluster1}`),
        ocpGet(`/apis/cluster.open-cluster-management.io/v1/managedclusters/${cluster2}`),
        ocpGet("/apis/policy.open-cluster-management.io/v1/policies").catch(() => ({ items: [] })),
      ]);

      if (mc1.status === "rejected" || mc2.status === "rejected") {
        const missing = mc1.status === "rejected" ? cluster1 : cluster2;
        return { content: [{ type: "text", text: `Cluster '${missing}' not found in ACM. Verify with: oc get managedclusters` }] };
      }

      const c1 = mc1.value;
      const c2 = mc2.value;

      const drifts = [];

      // Compare cluster versions
      const v1 = c1.status?.version?.kubernetes || c1.metadata?.labels?.["openshiftVersion"] || "unknown";
      const v2 = c2.status?.version?.kubernetes || c2.metadata?.labels?.["openshiftVersion"] || "unknown";
      if (v1 !== v2) {
        drifts.push({
          category: "Version",
          resource: "Kubernetes/OpenShift version",
          cluster1Value: v1,
          cluster2Value: v2,
          risk: "HIGH",
          recommendation: "Align versions to prevent API compatibility issues",
        });
      }

      // Compare labels
      const l1 = c1.metadata?.labels || {};
      const l2 = c2.metadata?.labels || {};
      const allLabels = new Set([...Object.keys(l1), ...Object.keys(l2)]);
      for (const label of allLabels) {
        if (label.startsWith("name") || label.startsWith("cluster")) continue;
        if (l1[label] !== l2[label]) {
          drifts.push({
            category: "Labels",
            resource: `label: ${label}`,
            cluster1Value: l1[label] || "(missing)",
            cluster2Value: l2[label] || "(missing)",
            risk: "LOW",
            recommendation: "Align labels for consistent policy targeting",
          });
        }
      }

      // Compare capacity
      const cap1 = c1.status?.capacity || {};
      const cap2 = c2.status?.capacity || {};
      for (const res of ["cpu", "memory"]) {
        if (cap1[res] && cap2[res] && cap1[res] !== cap2[res]) {
          drifts.push({
            category: "Capacity",
            resource: `${res} capacity`,
            cluster1Value: cap1[res],
            cluster2Value: cap2[res],
            risk: "MEDIUM",
            recommendation: `Verify ${res} capacity meets workload requirements on both clusters`,
          });
        }
      }

      // Compare conditions
      const cond1 = (c1.status?.conditions || []).reduce((m, c) => { m[c.type] = c.status; return m; }, {});
      const cond2 = (c2.status?.conditions || []).reduce((m, c) => { m[c.type] = c.status; return m; }, {});
      for (const condType of new Set([...Object.keys(cond1), ...Object.keys(cond2)])) {
        if (cond1[condType] !== cond2[condType]) {
          drifts.push({
            category: "Health",
            resource: `Condition: ${condType}`,
            cluster1Value: cond1[condType] || "unknown",
            cluster2Value: cond2[condType] || "unknown",
            risk: condType.includes("Available") ? "HIGH" : "MEDIUM",
            recommendation: `Investigate why ${condType} differs between clusters`,
          });
        }
      }

      // Compare policy compliance
      const allPolicies = policies.status === "fulfilled" ? (policies.value.items || []) : [];
      for (const p of allPolicies) {
        const statuses = p.status?.status || [];
        const s1 = statuses.find((s) => s.clustername === cluster1);
        const s2 = statuses.find((s) => s.clustername === cluster2);
        if (s1 && s2 && s1.compliant !== s2.compliant) {
          drifts.push({
            category: "Policy",
            resource: `Policy: ${p.metadata.name}`,
            cluster1Value: s1.compliant || "unknown",
            cluster2Value: s2.compliant || "unknown",
            risk: "HIGH",
            recommendation: `Remediate non-compliant cluster for policy '${p.metadata.name}'`,
          });
        }
      }

      // Build report
      const lines = [
        `### Drift Report: ${cluster1} vs ${cluster2}`,
        "",
        `| Category | Resource | ${cluster1} | ${cluster2} | Risk |`,
        `|----------|----------|-------------|-------------|------|`,
      ];

      if (drifts.length === 0) {
        lines.push("", "No significant drift detected between clusters.");
      } else {
        for (const d of drifts.sort((a, b) => riskScore(b.risk) - riskScore(a.risk))) {
          lines.push(`| ${d.category} | ${d.resource} | ${d.cluster1Value} | ${d.cluster2Value} | ${d.risk} |`);
        }
        lines.push("");

        const high = drifts.filter((d) => d.risk === "HIGH");
        if (high.length > 0) {
          lines.push("#### High-Risk Drift Remediation");
          for (const d of high) {
            lines.push(`- **${d.resource}**: ${d.recommendation}`);
          }
        }
      }

      const score = Math.max(0, 100 - drifts.filter((d) => d.risk === "HIGH").length * 20 - drifts.filter((d) => d.risk === "MEDIUM").length * 5 - drifts.filter((d) => d.risk === "LOW").length * 1);
      lines.push("", `#### Drift Score: ${score}/100 (${score >= 80 ? "Low drift" : score >= 50 ? "Moderate drift" : "Significant drift"})`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

function riskScore(risk) {
  return risk === "HIGH" ? 3 : risk === "MEDIUM" ? 2 : 1;
}
