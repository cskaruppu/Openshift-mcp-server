/**
 * Incident Timeline Reconstruction
 *
 * Correlates events, deployments, node conditions, and alerts into a
 * chronological timeline for root-cause analysis. No competitor offers
 * AI-powered cross-signal correlation like this.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";
import { listFiringAlerts } from "../services/alertmanager.js";

export function registerTimelineTools(server) {
  server.tool(
    "incident_timeline",
    "Reconstruct a chronological incident timeline correlating events, deployments, node conditions, and alerts for a resource or namespace",
    {
      namespace: z.string().describe("Namespace to investigate"),
      resource: z.string().optional().describe("Specific resource name (e.g., pod/my-app-xyz)"),
      minutes: z.number().optional().default(60).describe("How far back to look (minutes)"),
    },
    async ({ namespace, resource, minutes }) => {
      const cutoff = new Date(Date.now() - minutes * 60000);
      const timeline = [];

      const [eventsResp, deploymentsResp, rsResp, nodesResp, alertsResp] =
        await Promise.allSettled([
          ocpGet(`/api/v1/namespaces/${namespace}/events`),
          ocpGet(`/apis/apps/v1/namespaces/${namespace}/deployments`),
          ocpGet(`/apis/apps/v1/namespaces/${namespace}/replicasets`),
          ocpGet("/api/v1/nodes"),
          listFiringAlerts().catch(() => []),
        ]);

      // Events
      const events = eventsResp.status === "fulfilled" ? (eventsResp.value.items || []) : [];
      for (const e of events) {
        const ts = new Date(e.lastTimestamp || e.metadata.creationTimestamp);
        if (ts < cutoff) continue;
        if (resource && !`${(e.involvedObject.kind || "").toLowerCase()}/${e.involvedObject.name}`.includes(resource.replace(/^[^/]+\//, ""))) continue;
        const reason = (e.reason || "").toLowerCase();
        let severity = "info";
        if (e.type === "Warning") severity = "warning";
        if (reason.includes("backoff") || reason.includes("oomkill") || reason.includes("failed") || reason.includes("unhealthy")) severity = "critical";
        timeline.push({
          time: ts.toISOString(),
          source: "event",
          severity,
          kind: e.involvedObject.kind,
          name: e.involvedObject.name,
          reason: e.reason,
          message: (e.message || "").substring(0, 200),
          count: e.count || 1,
        });
      }

      // Deployment rollouts
      const deployments = deploymentsResp.status === "fulfilled" ? (deploymentsResp.value.items || []) : [];
      const replicasets = rsResp.status === "fulfilled" ? (rsResp.value.items || []) : [];
      for (const d of deployments) {
        const owned = replicasets.filter(
          (rs) => (rs.metadata.ownerReferences || []).some((o) => o.name === d.metadata.name)
        );
        for (const rs of owned) {
          const ts = new Date(rs.metadata.creationTimestamp);
          if (ts < cutoff) continue;
          const rev = rs.metadata.annotations?.["deployment.kubernetes.io/revision"] || "?";
          const image = rs.spec?.template?.spec?.containers?.[0]?.image || "unknown";
          timeline.push({
            time: ts.toISOString(),
            source: "rollout",
            severity: "info",
            kind: "Deployment",
            name: d.metadata.name,
            reason: `Rollout revision ${rev}`,
            message: `Image: ${image}, Replicas: ${rs.spec?.replicas || 0}`,
            count: 1,
          });
        }
      }

      // Node conditions
      const nodes = nodesResp.status === "fulfilled" ? (nodesResp.value.items || []) : [];
      for (const n of nodes) {
        for (const c of n.status?.conditions || []) {
          if (c.status !== "True") continue;
          if (c.type === "Ready") continue;
          const ts = new Date(c.lastTransitionTime);
          if (ts < cutoff) continue;
          timeline.push({
            time: ts.toISOString(),
            source: "node",
            severity: "warning",
            kind: "Node",
            name: n.metadata.name,
            reason: c.type,
            message: c.message || `Node condition ${c.type} is True`,
            count: 1,
          });
        }
      }

      // Alertmanager alerts
      const alerts = alertsResp.status === "fulfilled" ? (alertsResp.value || []) : [];
      for (const a of alerts) {
        if (a.namespace && a.namespace !== namespace) continue;
        const ts = new Date(a.startsAt);
        if (ts < cutoff) continue;
        timeline.push({
          time: ts.toISOString(),
          source: "alert",
          severity: a.severity || "warning",
          kind: "Alert",
          name: a.name,
          reason: a.name,
          message: a.summary || a.description || "",
          count: 1,
        });
      }

      // Sort chronologically
      timeline.sort((a, b) => new Date(a.time) - new Date(b.time));

      if (timeline.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No events found in namespace ${namespace} in the last ${minutes} minutes.`,
          }],
        };
      }

      const lines = [
        `### Incident Timeline — ${namespace}${resource ? ` / ${resource}` : ""} (last ${minutes}m)`,
        "",
        `${timeline.length} events correlated from ${new Set(timeline.map((t) => t.source)).size} sources`,
        "",
      ];

      for (const t of timeline) {
        const ts = t.time.slice(11, 19);
        const icon = t.severity === "critical" ? "[CRIT]" : t.severity === "warning" ? "[WARN]" : "[INFO]";
        const src = `[${t.source}]`;
        lines.push(`${ts} ${icon} ${src} ${t.kind}/${t.name} — ${t.reason}`);
        if (t.message) lines.push(`         ${t.message}`);
        if (t.count > 1) lines.push(`         (occurred ${t.count} times)`);
      }

      // Add correlation summary
      const criticals = timeline.filter((t) => t.severity === "critical");
      const rollouts = timeline.filter((t) => t.source === "rollout");
      const nodeIssues = timeline.filter((t) => t.source === "node");

      if (criticals.length > 0 || rollouts.length > 0 || nodeIssues.length > 0) {
        lines.push("", "---", "### Correlation Summary");
        if (rollouts.length > 0 && criticals.length > 0) {
          const firstRollout = rollouts[0];
          const firstCrit = criticals[0];
          if (new Date(firstRollout.time) <= new Date(firstCrit.time)) {
            lines.push(`- Deployment rollout at ${firstRollout.time.slice(11, 19)} preceded critical event at ${firstCrit.time.slice(11, 19)} — likely root cause`);
          }
        }
        if (nodeIssues.length > 0) {
          lines.push(`- ${nodeIssues.length} node condition(s) detected: ${[...new Set(nodeIssues.map((n) => n.reason))].join(", ")}`);
        }
        lines.push(`- ${criticals.length} critical, ${timeline.filter((t) => t.severity === "warning").length} warning, ${timeline.filter((t) => t.severity === "info").length} info events`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
