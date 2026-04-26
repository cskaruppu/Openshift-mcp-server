/**
 * OpenShift Upgrade Path Advisor
 *
 * Checks current version, available upgrade paths, operator compatibility,
 * and node readiness before an OpenShift cluster upgrade.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerUpgradeAdvisorTools(server) {
  server.tool(
    "upgrade_readiness",
    "Assess cluster readiness for an OpenShift upgrade: checks version, available paths, operator health, node status, and etcd health",
    {
      targetVersion: z.string().optional().describe("Target OCP version (e.g., 4.15.12). Omit to show available upgrade paths."),
    },
    async ({ targetVersion }) => {
      const [cvResp, nodesResp, opsResp, mcsResp, etcdResp] = await Promise.allSettled([
        ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
        ocpGet("/api/v1/nodes"),
        ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
        ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools"),
        ocpGet("/api/v1/namespaces/openshift-etcd/pods"),
      ]);

      const cv = cvResp.status === "fulfilled" ? cvResp.value : null;
      const nodes = nodesResp.status === "fulfilled" ? (nodesResp.value.items || []) : [];
      const operators = opsResp.status === "fulfilled" ? (opsResp.value.items || []) : [];
      const mcps = mcsResp.status === "fulfilled" ? (mcsResp.value.items || []) : [];
      const etcdPods = etcdResp.status === "fulfilled" ? (etcdResp.value.items || []) : [];

      const currentVersion = cv?.status?.desired?.version || "unknown";
      const channel = cv?.spec?.channel || "unknown";
      const availableUpdates = cv?.status?.availableUpdates || [];
      const conditions = cv?.status?.conditions || [];

      const blockers = [];
      const warnings = [];
      const ready = [];

      // 1. Check current upgrade progress
      const progressing = conditions.find((c) => c.type === "Progressing");
      if (progressing?.status === "True") {
        blockers.push(`Cluster is currently upgrading: ${progressing.message}`);
      } else {
        ready.push("No upgrade in progress");
      }

      // 2. Check degraded operators
      const degradedOps = operators.filter((o) =>
        (o.status?.conditions || []).some((c) => c.type === "Degraded" && c.status === "True")
      );
      if (degradedOps.length > 0) {
        blockers.push(`${degradedOps.length} degraded operator(s): ${degradedOps.map((o) => o.metadata.name).join(", ")}`);
      } else {
        ready.push(`All ${operators.length} operators healthy`);
      }

      // 3. Check node readiness
      const notReadyNodes = nodes.filter((n) =>
        !(n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True")
      );
      if (notReadyNodes.length > 0) {
        blockers.push(`${notReadyNodes.length} node(s) not ready: ${notReadyNodes.map((n) => n.metadata.name).join(", ")}`);
      } else {
        ready.push(`All ${nodes.length} nodes ready`);
      }

      // 4. Check MachineConfigPool status
      for (const mcp of mcps) {
        const updating = (mcp.status?.conditions || []).find((c) => c.type === "Updating" && c.status === "True");
        const degraded = (mcp.status?.conditions || []).find((c) => c.type === "Degraded" && c.status === "True");
        if (updating) warnings.push(`MachineConfigPool '${mcp.metadata.name}' is still updating`);
        if (degraded) blockers.push(`MachineConfigPool '${mcp.metadata.name}' is degraded: ${degraded.message || ""}`);
      }
      if (mcps.length > 0 && blockers.length === 0 && !warnings.some((w) => w.includes("MachineConfigPool"))) {
        ready.push(`${mcps.length} MachineConfigPool(s) synced`);
      }

      // 5. Check etcd health
      const etcdRunning = etcdPods.filter((p) => p.status?.phase === "Running");
      const etcdTotal = etcdPods.length;
      if (etcdTotal > 0 && etcdRunning.length < etcdTotal) {
        blockers.push(`etcd: ${etcdRunning.length}/${etcdTotal} pods running`);
      } else if (etcdTotal > 0) {
        ready.push(`etcd healthy: ${etcdRunning.length}/${etcdTotal} pods`);
      }

      // 6. Check if target is available
      let targetAvailable = false;
      if (targetVersion) {
        targetAvailable = availableUpdates.some((u) => u.version === targetVersion);
        if (!targetAvailable) {
          const forceable = availableUpdates.some((u) => u.version === targetVersion && u.force);
          if (forceable) warnings.push(`Version ${targetVersion} available but marked as force-only`);
          else blockers.push(`Version ${targetVersion} is not in the available upgrade list for channel '${channel}'`);
        } else {
          ready.push(`Target ${targetVersion} is available in channel '${channel}'`);
        }
      }

      // Build report
      const overallReady = blockers.length === 0;
      const lines = [
        "### Upgrade Readiness Report",
        "",
        `| Property | Value |`,
        `|----------|-------|`,
        `| Current version | ${currentVersion} |`,
        `| Channel | ${channel} |`,
        `| Available upgrades | ${availableUpdates.length} |`,
        targetVersion ? `| Target version | ${targetVersion} |` : null,
        `| **Overall** | **${overallReady ? "READY" : "NOT READY"}** |`,
        "",
      ].filter(Boolean);

      if (blockers.length > 0) {
        lines.push("#### Blockers (must fix before upgrade)");
        for (const b of blockers) lines.push(`- ${b}`);
        lines.push("");
      }

      if (warnings.length > 0) {
        lines.push("#### Warnings");
        for (const w of warnings) lines.push(`- ${w}`);
        lines.push("");
      }

      if (ready.length > 0) {
        lines.push("#### Passed Checks");
        for (const r of ready) lines.push(`- ${r}`);
        lines.push("");
      }

      if (availableUpdates.length > 0 && !targetVersion) {
        lines.push("#### Available Upgrade Paths");
        const sorted = [...availableUpdates].sort((a, b) => (b.version || "").localeCompare(a.version || ""));
        for (const u of sorted.slice(0, 10)) {
          lines.push(`- ${u.version}${u.force ? " (force)" : ""}`);
        }
        if (sorted.length > 10) lines.push(`- ... and ${sorted.length - 10} more`);
        lines.push("");
      }

      if (overallReady && targetVersion) {
        lines.push("#### Upgrade Command");
        lines.push("```");
        lines.push(`oc adm upgrade --to=${targetVersion}`);
        lines.push("```");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "certificate_check",
    "Check cluster certificate expiry dates and warn about certificates expiring soon",
    {
      warnDays: z.number().optional().default(30).describe("Warn if certificate expires within this many days"),
    },
    async ({ warnDays }) => {
      const routes = await ocpGet("/apis/route.openshift.io/v1/routes").catch(() => ({ items: [] }));
      const secrets = await ocpGet("/api/v1/secrets?fieldSelector=type=kubernetes.io/tls").catch(() => ({ items: [] }));

      const warnings = [];
      const ok = [];
      const now = Date.now();
      const threshold = warnDays * 24 * 3600 * 1000;

      // Check route certificates
      for (const route of routes.items || []) {
        const cert = route.spec?.tls?.certificate;
        if (!cert) continue;
        try {
          const match = cert.match(/Not After\s*:\s*(.+)/);
          if (match) {
            const expires = new Date(match[1]);
            const daysLeft = Math.floor((expires.getTime() - now) / 86400000);
            if (daysLeft < 0) {
              warnings.push({ name: `route/${route.metadata.namespace}/${route.metadata.name}`, daysLeft, severity: "critical" });
            } else if (daysLeft < warnDays) {
              warnings.push({ name: `route/${route.metadata.namespace}/${route.metadata.name}`, daysLeft, severity: "warning" });
            }
          }
        } catch { /* skip unparseable certs */ }
      }

      // Check TLS secrets with annotation
      for (const s of secrets.items || []) {
        const ns = s.metadata.namespace;
        if (ns?.startsWith("openshift-") || ns === "kube-system") continue;
        const created = new Date(s.metadata.creationTimestamp);
        const age = now - created.getTime();
        if (age > 365 * 86400000) {
          warnings.push({
            name: `secret/${ns}/${s.metadata.name}`,
            daysLeft: -Math.floor(age / 86400000) + 365,
            severity: "warning",
          });
        } else {
          ok.push(`secret/${ns}/${s.metadata.name}`);
        }
      }

      const lines = ["### Certificate Check", ""];
      if (warnings.length === 0) {
        lines.push(`All checked certificates are valid (threshold: ${warnDays} days).`);
      } else {
        lines.push(`${warnings.length} certificate(s) need attention:`, "");
        for (const w of warnings.sort((a, b) => a.daysLeft - b.daysLeft)) {
          const icon = w.severity === "critical" ? "[EXPIRED]" : "[WARNING]";
          lines.push(`- ${icon} **${w.name}**: ${w.daysLeft > 0 ? `expires in ${w.daysLeft} days` : "EXPIRED"}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
