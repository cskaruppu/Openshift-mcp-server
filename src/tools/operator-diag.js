/**
 * Operator Lifecycle Manager Diagnostics (OpenShift-specific)
 *
 * Diagnoses OLM subscription failures, InstallPlan issues, CSV phase
 * problems, and CatalogSource health. Only relevant on OpenShift.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerOperatorDiagTools(server) {
  server.tool(
    "operator_health",
    "Check health of all installed operators: CSV phase, subscription status, InstallPlan approval, and CatalogSource availability",
    {
      namespace: z.string().optional().describe("Namespace to check (default: all namespaces)"),
    },
    async ({ namespace }) => {
      const nsPath = namespace ? `/namespaces/${namespace}` : "";

      const [subsResp, csvsResp, ipsResp, catsResp] = await Promise.allSettled([
        ocpGet(`/apis/operators.coreos.com/v1alpha1${nsPath}/subscriptions`),
        ocpGet(`/apis/operators.coreos.com/v1alpha1${nsPath}/clusterserviceversions`),
        ocpGet(`/apis/operators.coreos.com/v1alpha1${nsPath}/installplans`),
        ocpGet("/apis/operators.coreos.com/v1alpha1/catalogsources"),
      ]);

      const subs = subsResp.status === "fulfilled" ? (subsResp.value.items || []) : [];
      const csvs = csvsResp.status === "fulfilled" ? (csvsResp.value.items || []) : [];
      const ips = ipsResp.status === "fulfilled" ? (ipsResp.value.items || []) : [];
      const cats = catsResp.status === "fulfilled" ? (catsResp.value.items || []) : [];

      const issues = [];
      const healthy = [];

      // Check subscriptions
      for (const sub of subs) {
        const name = sub.metadata.name;
        const ns = sub.metadata.namespace;
        const state = sub.status?.state || "Unknown";
        const csv = sub.status?.currentCSV || "none";
        const installPlanRef = sub.status?.installPlanRef?.name;

        if (state !== "AtLatestKnown") {
          const conditions = sub.status?.conditions || [];
          const failedCond = conditions.find((c) => c.type === "ResolutionFailed" || c.status === "True");
          issues.push({
            type: "subscription",
            name: `${ns}/${name}`,
            severity: "warning",
            detail: `State: ${state}, CSV: ${csv}`,
            reason: failedCond?.message || "Subscription not at latest",
            fix: `oc describe subscription ${name} -n ${ns}`,
          });
        } else {
          healthy.push(`${ns}/${name} (${csv})`);
        }

        // Check if InstallPlan needs manual approval
        if (installPlanRef) {
          const ip = ips.find((p) => p.metadata.name === installPlanRef && p.metadata.namespace === ns);
          if (ip && !ip.spec?.approved && ip.status?.phase === "RequiresApproval") {
            issues.push({
              type: "installplan",
              name: `${ns}/${installPlanRef}`,
              severity: "warning",
              detail: `Pending approval for ${name}`,
              reason: `InstallPlan requires manual approval`,
              fix: `oc patch installplan ${installPlanRef} -n ${ns} --type merge -p '{"spec":{"approved":true}}'`,
            });
          }
        }
      }

      // Check CSVs
      for (const csv of csvs) {
        const phase = csv.status?.phase || "Unknown";
        if (phase !== "Succeeded") {
          const reason = csv.status?.reason || "";
          const message = csv.status?.message || "";
          issues.push({
            type: "csv",
            name: `${csv.metadata.namespace}/${csv.metadata.name}`,
            severity: phase === "Failed" ? "critical" : "warning",
            detail: `Phase: ${phase}`,
            reason: `${reason}: ${message}`.substring(0, 200),
            fix: phase === "Failed"
              ? `oc delete csv ${csv.metadata.name} -n ${csv.metadata.namespace} && oc delete subscription <sub-name> -n ${csv.metadata.namespace}`
              : `oc describe csv ${csv.metadata.name} -n ${csv.metadata.namespace}`,
          });
        }
      }

      // Check CatalogSources
      for (const cat of cats) {
        const state = cat.status?.connectionState?.lastObservedState || "Unknown";
        if (state !== "READY") {
          issues.push({
            type: "catalogsource",
            name: `${cat.metadata.namespace}/${cat.metadata.name}`,
            severity: "critical",
            detail: `Connection state: ${state}`,
            reason: cat.status?.connectionState?.lastConnect
              ? `Last connected: ${cat.status.connectionState.lastConnect}`
              : "CatalogSource not reachable",
            fix: `oc describe catalogsource ${cat.metadata.name} -n ${cat.metadata.namespace}`,
          });
        }
      }

      const lines = [
        `### Operator Health Report${namespace ? ` — ${namespace}` : ""}`,
        "",
        `Healthy: ${healthy.length} | Issues: ${issues.length}`,
        "",
      ];

      if (issues.length > 0) {
        const criticals = issues.filter((i) => i.severity === "critical");
        const warnings = issues.filter((i) => i.severity === "warning");

        if (criticals.length > 0) {
          lines.push("#### Critical Issues");
          for (const i of criticals) {
            lines.push(`- **[${i.type.toUpperCase()}] ${i.name}**`);
            lines.push(`  ${i.detail}`);
            lines.push(`  Reason: ${i.reason}`);
            lines.push(`  Fix: \`${i.fix}\``);
          }
          lines.push("");
        }

        if (warnings.length > 0) {
          lines.push("#### Warnings");
          for (const w of warnings) {
            lines.push(`- **[${w.type.toUpperCase()}] ${w.name}**`);
            lines.push(`  ${w.detail}`);
            lines.push(`  Reason: ${w.reason}`);
            lines.push(`  Fix: \`${w.fix}\``);
          }
          lines.push("");
        }
      } else {
        lines.push("All operators are healthy.");
      }

      if (healthy.length > 0) {
        lines.push("", "#### Healthy Operators");
        lines.push(healthy.map((h) => `- ${h}`).join("\n"));
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "operator_upgrade_check",
    "Check which operators have pending upgrades and their approval strategy",
    {},
    async () => {
      const [subs, ips] = await Promise.all([
        ocpGet("/apis/operators.coreos.com/v1alpha1/subscriptions").catch(() => ({ items: [] })),
        ocpGet("/apis/operators.coreos.com/v1alpha1/installplans").catch(() => ({ items: [] })),
      ]);

      const pendingUpgrades = [];
      const autoApproval = [];
      const manualApproval = [];

      for (const sub of subs.items || []) {
        const approval = sub.spec?.installPlanApproval || "Automatic";
        const currentCSV = sub.status?.currentCSV || "";
        const installedCSV = sub.status?.installedCSV || "";

        if (approval === "Automatic") autoApproval.push(`${sub.metadata.namespace}/${sub.metadata.name}`);
        else manualApproval.push(`${sub.metadata.namespace}/${sub.metadata.name}`);

        if (currentCSV !== installedCSV && currentCSV) {
          pendingUpgrades.push({
            name: sub.metadata.name,
            namespace: sub.metadata.namespace,
            from: installedCSV,
            to: currentCSV,
            approval,
          });
        }
      }

      const pendingIPs = (ips.items || []).filter((ip) => !ip.spec?.approved && ip.status?.phase === "RequiresApproval");

      const lines = [
        "### Operator Upgrade Status",
        "",
        `Auto-approval: ${autoApproval.length} | Manual-approval: ${manualApproval.length}`,
        `Pending upgrades: ${pendingUpgrades.length} | Pending InstallPlans: ${pendingIPs.length}`,
        "",
      ];

      if (pendingUpgrades.length > 0) {
        lines.push("#### Pending Upgrades");
        for (const u of pendingUpgrades) {
          lines.push(`- **${u.namespace}/${u.name}**: ${u.from || "unknown"} → ${u.to}`);
          lines.push(`  Approval: ${u.approval}`);
          if (u.approval === "Manual") {
            lines.push(`  Approve: \`oc patch subscription ${u.name} -n ${u.namespace} --type merge -p '{"spec":{"startingCSV":"${u.to}"}}'\``);
          }
        }
        lines.push("");
      }

      if (pendingIPs.length > 0) {
        lines.push("#### InstallPlans Awaiting Approval");
        for (const ip of pendingIPs) {
          lines.push(`- ${ip.metadata.namespace}/${ip.metadata.name}`);
          lines.push(`  CSVs: ${(ip.spec?.clusterServiceVersionNames || []).join(", ")}`);
          lines.push(`  Approve: \`oc patch installplan ${ip.metadata.name} -n ${ip.metadata.namespace} --type merge -p '{"spec":{"approved":true}}'\``);
        }
      }

      if (pendingUpgrades.length === 0 && pendingIPs.length === 0) {
        lines.push("All operators are up to date.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
