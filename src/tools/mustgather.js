/**
 * Must-Gather toolset — collect diagnostic bundles from OpenShift clusters.
 * Triggers `oc adm must-gather` style collection via API and retrieves
 * cluster-wide diagnostic snapshots.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerMustGatherTools(server) {
  server.tool(
    "mustgather_cluster_snapshot",
    "Collect a diagnostic snapshot of the cluster (lightweight must-gather)",
    { includeNodes: z.boolean().optional(), includeOperators: z.boolean().optional() },
    async ({ includeNodes = true, includeOperators = true }) => {
      try {
        const sections = ["### Cluster Diagnostic Snapshot\n"];

        const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version").catch(() => null);
        if (cv) {
          const version = cv.status?.desired?.version || "unknown";
          const channel = cv.spec?.channel || "unknown";
          const conditions = (cv.status?.conditions || [])
            .filter(c => c.status === "True")
            .map(c => `${c.type}: ${c.message || ""}`)
            .join("\n  ");
          sections.push(`**Cluster Version:** ${version} (channel: ${channel})`);
          if (conditions) sections.push(`**Conditions:**\n  ${conditions}`);
        }

        const infra = await ocpGet("/apis/config.openshift.io/v1/infrastructures/cluster").catch(() => null);
        if (infra) {
          sections.push(`**Platform:** ${infra.status?.platform || "unknown"}`);
          sections.push(`**API Server URL:** ${infra.status?.apiServerURL || "unknown"}`);
        }

        if (includeNodes) {
          const nodes = await ocpGet("/api/v1/nodes").catch(() => ({ items: [] }));
          const nodeList = (nodes.items || []).map(n => {
            const ready = (n.status?.conditions || []).find(c => c.type === "Ready");
            return {
              name: n.metadata.name,
              ready: ready?.status === "True" ? "Ready" : "NotReady",
              roles: Object.keys(n.metadata.labels || {})
                .filter(l => l.startsWith("node-role.kubernetes.io/"))
                .map(l => l.split("/")[1])
                .join(", ") || "worker",
              version: n.status?.nodeInfo?.kubeletVersion || "unknown",
            };
          });
          sections.push("\n**Nodes:**");
          sections.push("| Name | Status | Roles | Version |");
          sections.push("|---|---|---|---|");
          for (const n of nodeList) {
            sections.push(`| ${n.name} | ${n.ready} | ${n.roles} | ${n.version} |`);
          }
          const notReady = nodeList.filter(n => n.ready !== "Ready").length;
          if (notReady > 0) {
            sections.push(`\n**[WARNING] ${notReady} node(s) are NotReady.**`);
          }
        }

        if (includeOperators) {
          const cos = await ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => ({ items: [] }));
          const degraded = (cos.items || []).filter(co => {
            const deg = (co.status?.conditions || []).find(c => c.type === "Degraded");
            return deg?.status === "True";
          });
          const unavail = (cos.items || []).filter(co => {
            const avail = (co.status?.conditions || []).find(c => c.type === "Available");
            return avail?.status !== "True";
          });
          sections.push(`\n**Cluster Operators:** ${(cos.items || []).length} total`);
          if (degraded.length > 0) {
            sections.push(`**[WARNING] Degraded operators (${degraded.length}):**`);
            for (const co of degraded) {
              const msg = (co.status?.conditions || []).find(c => c.type === "Degraded")?.message || "";
              sections.push(`  - \`${co.metadata.name}\`: ${msg.slice(0, 200)}`);
            }
          }
          if (unavail.length > 0) {
            sections.push(`**[CRITICAL] Unavailable operators (${unavail.length}):**`);
            for (const co of unavail) sections.push(`  - \`${co.metadata.name}\``);
          }
          if (degraded.length === 0 && unavail.length === 0) {
            sections.push("**[OK] All operators are Available and not Degraded.**");
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error collecting snapshot: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "mustgather_namespace_dump",
    "Collect diagnostic info for a specific namespace",
    { namespace: z.string() },
    async ({ namespace }) => {
      try {
        const sections = [`### Namespace Diagnostic Dump: \`${namespace}\`\n`];

        const [pods, events, svcs, deploys, configmaps] = await Promise.all([
          ocpGet(`/api/v1/namespaces/${namespace}/pods`).catch(() => ({ items: [] })),
          ocpGet(`/api/v1/namespaces/${namespace}/events?limit=50`).catch(() => ({ items: [] })),
          ocpGet(`/api/v1/namespaces/${namespace}/services`).catch(() => ({ items: [] })),
          ocpGet(`/apis/apps/v1/namespaces/${namespace}/deployments`).catch(() => ({ items: [] })),
          ocpGet(`/api/v1/namespaces/${namespace}/configmaps`).catch(() => ({ items: [] })),
        ]);

        // Pods summary
        const podList = (pods.items || []);
        const podsByPhase = {};
        for (const p of podList) {
          const phase = p.status?.phase || "Unknown";
          podsByPhase[phase] = (podsByPhase[phase] || 0) + 1;
        }
        sections.push(`**Pods (${podList.length}):** ${Object.entries(podsByPhase).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}`);

        const unhealthy = podList.filter(p =>
          p.status?.phase !== "Running" && p.status?.phase !== "Succeeded"
        );
        if (unhealthy.length > 0) {
          sections.push("\n**Unhealthy Pods:**");
          for (const p of unhealthy.slice(0, 20)) {
            const restarts = (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
            sections.push(`  - \`${p.metadata.name}\` — ${p.status?.phase} (restarts: ${restarts})`);
          }
        }

        // Deployments
        const deployList = (deploys.items || []);
        if (deployList.length > 0) {
          sections.push(`\n**Deployments (${deployList.length}):**`);
          sections.push("| Name | Ready | Up-to-date | Available |");
          sections.push("|---|---|---|---|");
          for (const d of deployList) {
            const ready = d.status?.readyReplicas || 0;
            const desired = d.spec?.replicas || 0;
            const upToDate = d.status?.updatedReplicas || 0;
            const available = d.status?.availableReplicas || 0;
            const icon = ready === desired && ready > 0 ? "" : " [WARN]";
            sections.push(`| ${d.metadata.name} | ${ready}/${desired}${icon} | ${upToDate} | ${available} |`);
          }
        }

        // Services
        sections.push(`\n**Services:** ${(svcs.items || []).length}`);
        for (const s of (svcs.items || []).slice(0, 20)) {
          const ports = (s.spec?.ports || []).map(p => `${p.port}/${p.protocol}`).join(", ");
          sections.push(`  - \`${s.metadata.name}\` (${s.spec?.type}) — ${ports}`);
        }

        // ConfigMaps count
        sections.push(`**ConfigMaps:** ${(configmaps.items || []).length}`);

        // Recent warning events
        const warnings = (events.items || [])
          .filter(e => e.type === "Warning")
          .sort((a, b) => new Date(b.lastTimestamp || b.eventTime || 0) - new Date(a.lastTimestamp || a.eventTime || 0))
          .slice(0, 15);
        if (warnings.length > 0) {
          sections.push("\n**Recent Warning Events:**");
          for (const e of warnings) {
            const age = e.lastTimestamp || e.eventTime || "unknown";
            sections.push(`  - [${age}] \`${e.involvedObject?.name || "?"}\`: ${e.reason} — ${e.message?.slice(0, 150)}`);
          }
        } else {
          sections.push("\n**[OK] No warning events.**");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error dumping namespace: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "mustgather_etcd_health",
    "Check etcd cluster health and performance",
    {},
    async () => {
      try {
        const sections = ["### etcd Health Check\n"];

        const etcdPods = await ocpGet(
          "/api/v1/namespaces/openshift-etcd/pods?labelSelector=app=etcd"
        ).catch(() => ({ items: [] }));

        const podList = (etcdPods.items || []);
        if (podList.length === 0) {
          sections.push("**[WARNING] No etcd pods found.** This may indicate a non-standard deployment or insufficient permissions.");
          return { content: [{ type: "text", text: sections.join("\n") }] };
        }

        sections.push(`**etcd Pods (${podList.length}):**`);
        sections.push("| Name | Status | Node | Restarts |");
        sections.push("|---|---|---|---|");
        for (const p of podList) {
          const ready = (p.status?.containerStatuses || []).every(c => c.ready) ? "Ready" : "NotReady";
          const restarts = (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
          const node = p.spec?.nodeName || "-";
          sections.push(`| ${p.metadata.name} | ${ready} | ${node} | ${restarts} |`);
        }

        const etcdOperator = await ocpGet(
          "/apis/config.openshift.io/v1/clusteroperators/etcd"
        ).catch(() => null);
        if (etcdOperator) {
          const conditions = (etcdOperator.status?.conditions || []);
          const degraded = conditions.find(c => c.type === "Degraded");
          const available = conditions.find(c => c.type === "Available");
          const progressing = conditions.find(c => c.type === "Progressing");
          sections.push(`\n**Operator Status:**`);
          sections.push(`  - Available: ${available?.status || "Unknown"}`);
          sections.push(`  - Degraded: ${degraded?.status || "Unknown"}${degraded?.status === "True" ? ` — ${degraded.message}` : ""}`);
          sections.push(`  - Progressing: ${progressing?.status || "Unknown"}`);
        }

        const events = await ocpGet(
          "/api/v1/namespaces/openshift-etcd/events?fieldSelector=type=Warning"
        ).catch(() => ({ items: [] }));
        const recentEvents = (events.items || [])
          .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0))
          .slice(0, 10);
        if (recentEvents.length > 0) {
          sections.push("\n**Recent Warning Events:**");
          for (const e of recentEvents) {
            sections.push(`  - \`${e.involvedObject?.name || "?"}\`: ${e.reason} — ${(e.message || "").slice(0, 150)}`);
          }
        } else {
          sections.push("\n**[OK] No warning events in openshift-etcd namespace.**");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error checking etcd: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "mustgather_certificate_check",
    "Check for expiring certificates in the cluster",
    { thresholdDays: z.number().optional() },
    async ({ thresholdDays = 30 }) => {
      try {
        const sections = [`### Certificate Expiry Check (threshold: ${thresholdDays} days)\n`];

        const secrets = await ocpGet(
          "/api/v1/secrets?fieldSelector=type=kubernetes.io/tls&limit=100"
        ).catch(() => ({ items: [] }));

        const now = Date.now();
        const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
        const expiring = [];

        for (const s of (secrets.items || [])) {
          const annotations = s.metadata?.annotations || {};
          const expiryStr = annotations["auth.openshift.io/certificate-not-after"]
            || annotations["certificate-not-after"];
          if (expiryStr) {
            const expiryDate = new Date(expiryStr);
            const remaining = expiryDate.getTime() - now;
            if (remaining < thresholdMs) {
              expiring.push({
                name: s.metadata.name,
                namespace: s.metadata.namespace,
                expiry: expiryStr,
                daysLeft: Math.max(0, Math.floor(remaining / (24 * 60 * 60 * 1000))),
                expired: remaining <= 0,
              });
            }
          }
        }

        expiring.sort((a, b) => a.daysLeft - b.daysLeft);

        if (expiring.length === 0) {
          sections.push(`**[OK] No certificates expiring within ${thresholdDays} days.**`);
        } else {
          sections.push(`**[WARNING] ${expiring.length} certificate(s) expiring soon:**\n`);
          sections.push("| Secret | Namespace | Expiry | Days Left | Status |");
          sections.push("|---|---|---|---|---|");
          for (const c of expiring.slice(0, 30)) {
            const status = c.expired ? "[CRITICAL] EXPIRED" : c.daysLeft < 7 ? "[WARNING] Critical" : "Expiring";
            sections.push(`| ${c.name} | ${c.namespace} | ${c.expiry} | ${c.daysLeft} | ${status} |`);
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error checking certificates: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "mustgather_resource_quotas",
    "Check resource quotas and limit ranges across namespaces",
    { namespace: z.string().optional() },
    async ({ namespace }) => {
      try {
        const sections = ["### Resource Quotas & Limit Ranges\n"];

        const quotaPath = namespace
          ? `/api/v1/namespaces/${namespace}/resourcequotas`
          : "/api/v1/resourcequotas";
        const quotas = await ocpGet(quotaPath).catch(() => ({ items: [] }));

        if ((quotas.items || []).length === 0) {
          sections.push("No resource quotas found.");
        } else {
          sections.push("**Resource Quotas:**\n");
          sections.push("| Namespace | Name | Resource | Used | Hard | % |");
          sections.push("|---|---|---|---|---|---|");
          for (const q of (quotas.items || []).slice(0, 50)) {
            const hard = q.status?.hard || {};
            const used = q.status?.used || {};
            for (const [res, hardVal] of Object.entries(hard)) {
              const usedVal = used[res] || "0";
              const hardNum = parseFloat(hardVal) || 0;
              const usedNum = parseFloat(usedVal) || 0;
              const pct = hardNum > 0 ? Math.round((usedNum / hardNum) * 100) : 0;
              const warn = pct >= 90 ? " [WARN]" : "";
              sections.push(`| ${q.metadata.namespace} | ${q.metadata.name} | ${res} | ${usedVal} | ${hardVal} | ${pct}%${warn} |`);
            }
          }
        }

        const lrPath = namespace
          ? `/api/v1/namespaces/${namespace}/limitranges`
          : "/api/v1/limitranges";
        const limitRanges = await ocpGet(lrPath).catch(() => ({ items: [] }));

        if ((limitRanges.items || []).length > 0) {
          sections.push("\n**Limit Ranges:**");
          for (const lr of (limitRanges.items || []).slice(0, 20)) {
            sections.push(`\n_\`${lr.metadata.namespace}/${lr.metadata.name}\`:_`);
            for (const limit of (lr.spec?.limits || [])) {
              sections.push(`  - Type: ${limit.type} | Default: ${JSON.stringify(limit.default || {})} | Max: ${JSON.stringify(limit.max || {})}`);
            }
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error checking quotas: ${err.message}` }] };
      }
    }
  );
}
