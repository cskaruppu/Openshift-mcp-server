/**
 * OpenShift Service Mesh (OSSM) / Kiali toolset — service mesh topology,
 * Istio config management, metrics, traces, and workload logs.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";

const KIALI_URL =
  process.env.KIALI_URL ||
  "https://kiali.istio-system.svc:20001";

let _tk = null;
async function getToken() {
  if (_tk) return _tk;
  if (process.env.OPENSHIFT_TOKEN) return (_tk = process.env.OPENSHIFT_TOKEN);
  try {
    _tk = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
  } catch {
    _tk = null;
  }
  return _tk;
}

async function kialiFetch(path) {
  const tk = await getToken();
  const resp = await fetch(`${KIALI_URL}${path}`, {
    headers: {
      ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Kiali API ${resp.status}: ${body.slice(0, 500)}`);
  }
  return resp.json();
}

const NOT_INSTALLED_MSG =
  "OpenShift Service Mesh (OSSM) or Kiali does not appear to be installed.\n\n" +
  "Set KIALI_URL environment variable if Kiali is at a non-default location.\n" +
  "Default: https://kiali.istio-system.svc:20001";

export function registerOSSMTools(server) {
  server.tool(
    "ossm_mesh_graph",
    "Get service mesh topology graph showing namespaces, health, and traffic flow",
    {
      namespace: z.string().optional().describe("Single namespace for graph"),
      namespaces: z.string().optional().describe("Comma-separated namespace list"),
      graphType: z.enum(["versionedApp", "app", "service", "workload"]).optional()
        .describe("Graph type (default: versionedApp)"),
      rateInterval: z.string().optional().describe("Rate interval for metrics, e.g. '5m', '1h'"),
    },
    async ({ namespace, namespaces, graphType, rateInterval }) => {
      try {
        const ns = namespaces || namespace;
        if (!ns) {
          return { content: [{ type: "text", text: "Please specify at least one namespace." }] };
        }
        const params = new URLSearchParams();
        params.set("namespaces", ns);
        if (graphType) params.set("graphType", graphType);
        if (rateInterval) params.set("rateInterval", rateInterval);

        const data = await kialiFetch(`/api/namespaces/graph?${params.toString()}`);

        const nodes = data.elements?.nodes || [];
        const edges = data.elements?.edges || [];

        const lines = [`### Service Mesh Graph\n`];
        lines.push(`**Namespaces:** ${ns}`);
        lines.push(`**Nodes:** ${nodes.length} | **Edges:** ${edges.length}\n`);

        if (nodes.length > 0) {
          lines.push("| Type | Name | Namespace | Health |");
          lines.push("|---|---|---|---|");
          for (const n of nodes.slice(0, 50)) {
            const d = n.data || {};
            const nodeType = d.nodeType || "unknown";
            const name = d.workload || d.service || d.app || d.id || "?";
            const ns = d.namespace || "-";
            const health = d.healthData ? "available" : "-";
            lines.push(`| ${nodeType} | ${name} | ${ns} | ${health} |`);
          }
        }

        if (edges.length > 0) {
          lines.push("\n**Traffic Edges:**");
          lines.push("| Source | Target | Rate | Protocol |");
          lines.push("|---|---|---|---|");
          for (const e of edges.slice(0, 30)) {
            const d = e.data || {};
            const traffic = d.traffic || {};
            const protocol = Object.keys(traffic)[0] || "-";
            const rate = traffic[protocol]?.rates?.http || traffic[protocol]?.rates?.grpc || "-";
            lines.push(`| ${d.source || "?"} | ${d.target || "?"} | ${rate} | ${protocol} |`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOTFOUND")) {
          return { content: [{ type: "text", text: NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "ossm_istio_config_read",
    "List or get Istio configuration objects (VirtualService, DestinationRule, Gateway, etc.)",
    {
      action: z.enum(["list", "get"]).describe("Action: list all or get a specific object"),
      kind: z.string().optional().describe("Istio object kind, e.g. VirtualService, DestinationRule, Gateway"),
      namespace: z.string().optional().describe("Object namespace"),
      name: z.string().optional().describe("Object name (required for 'get' action)"),
    },
    async ({ action, kind, namespace, name }) => {
      try {
        if (action === "get") {
          if (!namespace || !name || !kind) {
            return { content: [{ type: "text", text: "For 'get', namespace, kind, and name are required." }] };
          }
          const data = await kialiFetch(
            `/api/namespaces/${namespace}/istio/${kind.toLowerCase()}/${name}`
          );
          return { content: [{ type: "text", text: `### ${kind}: \`${name}\` in \`${namespace}\`\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` }] };
        }

        let path = "/api/istio/config";
        const params = new URLSearchParams();
        if (namespace) path = `/api/namespaces/${namespace}/istio`;
        if (kind) params.set("objects", kind.toLowerCase());
        const qs = params.toString();
        if (qs) path += `?${qs}`;

        const data = await kialiFetch(path);

        const items = [];
        if (Array.isArray(data)) {
          for (const d of data) items.push(...(d.items || []));
        } else if (data.items) {
          items.push(...data.items);
        } else {
          const keys = Object.keys(data).filter(k => Array.isArray(data[k]));
          for (const k of keys) items.push(...data[k]);
        }

        if (items.length === 0) {
          return { content: [{ type: "text", text: `No Istio configuration objects found.` }] };
        }

        const lines = [`### Istio Configuration${namespace ? ` in \`${namespace}\`` : ""}\n`];
        lines.push("| Kind | Name | Namespace | Created |");
        lines.push("|---|---|---|---|");
        for (const item of items.slice(0, 50)) {
          const meta = item.metadata || {};
          lines.push(`| ${item.kind || "?"} | ${meta.name || "?"} | ${meta.namespace || "-"} | ${meta.creationTimestamp || "-"} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOTFOUND")) {
          return { content: [{ type: "text", text: NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "ossm_istio_config_write",
    "Create, patch, or delete Istio configuration objects",
    {
      action: z.enum(["create", "patch", "delete"]).describe("Action to perform"),
      kind: z.string().describe("Istio object kind, e.g. VirtualService"),
      namespace: z.string().describe("Object namespace"),
      name: z.string().optional().describe("Object name (required for patch/delete)"),
      jsonData: z.string().optional().describe("JSON data for create/patch operations"),
    },
    async ({ action, kind, namespace, name, jsonData }) => {
      try {
        const tk = await getToken();

        if (action === "delete") {
          if (!name) return { content: [{ type: "text", text: "Name is required for delete." }] };
          const resp = await fetch(
            `${KIALI_URL}/api/namespaces/${namespace}/istio/${kind.toLowerCase()}/${name}`,
            {
              method: "DELETE",
              headers: { ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
            }
          );
          if (!resp.ok) throw new Error(`Delete failed: ${resp.status}`);
          return { content: [{ type: "text", text: `Deleted ${kind} \`${name}\` from \`${namespace}\`.` }] };
        }

        if (!jsonData) return { content: [{ type: "text", text: "jsonData is required for create/patch." }] };

        if (action === "create") {
          const resp = await fetch(
            `${KIALI_URL}/api/namespaces/${namespace}/istio/${kind.toLowerCase()}`,
            {
              method: "POST",
              headers: {
                ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
                "Content-Type": "application/json",
              },
              body: jsonData,
            }
          );
          if (!resp.ok) throw new Error(`Create failed: ${resp.status} ${await resp.text()}`);
          const data = await resp.json();
          return { content: [{ type: "text", text: `Created ${kind} \`${data.metadata?.name}\` in \`${namespace}\`.` }] };
        }

        if (action === "patch") {
          if (!name) return { content: [{ type: "text", text: "Name is required for patch." }] };
          const resp = await fetch(
            `${KIALI_URL}/api/namespaces/${namespace}/istio/${kind.toLowerCase()}/${name}`,
            {
              method: "PATCH",
              headers: {
                ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
                "Content-Type": "application/json",
              },
              body: jsonData,
            }
          );
          if (!resp.ok) throw new Error(`Patch failed: ${resp.status} ${await resp.text()}`);
          return { content: [{ type: "text", text: `Patched ${kind} \`${name}\` in \`${namespace}\`.` }] };
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "ossm_get_resource_details",
    "Get details or list services/workloads within the service mesh",
    {
      resourceType: z.enum(["service", "workload"]).describe("Resource type"),
      resourceName: z.string().optional().describe("Resource name (omit to list all)"),
      namespaces: z.string().optional().describe("Comma-separated namespace list"),
    },
    async ({ resourceType, resourceName, namespaces }) => {
      try {
        if (resourceName && namespaces) {
          const ns = namespaces.split(",")[0].trim();
          const plural = resourceType === "service" ? "services" : "workloads";
          const data = await kialiFetch(`/api/namespaces/${ns}/${plural}/${resourceName}`);

          const lines = [`### ${resourceType}: \`${resourceName}\` in \`${ns}\`\n`];
          if (data.health) {
            lines.push(`**Health:** ${JSON.stringify(data.health.requests || {})}`);
          }
          if (data.istioSidecar !== undefined) {
            lines.push(`**Istio Sidecar:** ${data.istioSidecar ? "Yes" : "No"}`);
          }
          lines.push(`\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 3000)}\n\`\`\``);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        const nsList = namespaces ? namespaces.split(",") : [];
        if (nsList.length === 0) {
          return { content: [{ type: "text", text: "Please specify at least one namespace." }] };
        }

        const allItems = [];
        const plural = resourceType === "service" ? "services" : "workloads";
        for (const ns of nsList) {
          const data = await kialiFetch(`/api/namespaces/${ns.trim()}/${plural}`);
          const items = Array.isArray(data) ? data : (data.items || data[plural] || []);
          for (const item of items) allItems.push({ ...item, _ns: ns.trim() });
        }

        if (allItems.length === 0) {
          return { content: [{ type: "text", text: `No ${plural} found in the specified namespaces.` }] };
        }

        const lines = [`### Mesh ${plural}\n`];
        lines.push("| Name | Namespace | Sidecar | Health |");
        lines.push("|---|---|---|---|");
        for (const item of allItems.slice(0, 50)) {
          const name = item.name || item.metadata?.name || "?";
          const ns = item.namespace || item._ns || "-";
          const sidecar = item.istioSidecar ? "Yes" : "No";
          lines.push(`| ${name} | ${ns} | ${sidecar} | - |`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOTFOUND")) {
          return { content: [{ type: "text", text: NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "ossm_get_metrics",
    "Get metrics for services or workloads within the service mesh",
    {
      namespace: z.string().describe("Target namespace"),
      resourceType: z.enum(["service", "workload"]).describe("Resource type"),
      resourceName: z.string().describe("Resource name"),
      direction: z.enum(["inbound", "outbound"]).optional().describe("Traffic direction"),
      rateInterval: z.string().optional().describe("Rate interval, e.g. '5m'"),
      step: z.string().optional().describe("Step between data points, e.g. '15s'"),
    },
    async ({ namespace, resourceType, resourceName, direction, rateInterval, step }) => {
      try {
        const plural = resourceType === "service" ? "services" : "workloads";
        const params = new URLSearchParams();
        if (direction) params.set("direction", direction);
        if (rateInterval) params.set("rateInterval", rateInterval);
        if (step) params.set("step", step);
        params.set("avg", "true");

        const qs = params.toString();
        const data = await kialiFetch(
          `/api/namespaces/${namespace}/${plural}/${resourceName}/metrics${qs ? `?${qs}` : ""}`
        );

        const lines = [`### Metrics: \`${resourceName}\` (${resourceType}) in \`${namespace}\`\n`];

        const metrics = data.metrics || data;
        if (typeof metrics === "object") {
          for (const [key, value] of Object.entries(metrics)) {
            if (Array.isArray(value?.matrix) || Array.isArray(value)) {
              const series = value.matrix || value;
              lines.push(`**${key}:** ${series.length} series`);
              for (const s of series.slice(0, 3)) {
                const labels = s.metric ? Object.entries(s.metric).map(([k, v]) => `${k}=${v}`).join(", ") : "";
                const values = s.values || [];
                if (values.length > 0) {
                  const last = values[values.length - 1];
                  lines.push(`  - ${labels || "(aggregate)"}: latest=${last[1]} (${values.length} points)`);
                }
              }
            }
          }
        }

        if (lines.length <= 1) {
          lines.push("No metric data available for this resource.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOTFOUND")) {
          return { content: [{ type: "text", text: NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "ossm_get_traces",
    "Get distributed traces for a resource or detailed info by trace ID",
    {
      traceId: z.string().optional().describe("Specific trace ID for detailed info"),
      namespace: z.string().optional().describe("Resource namespace"),
      resourceType: z.enum(["app", "service", "workload"]).optional().describe("Resource type"),
      resourceName: z.string().optional().describe("Resource name"),
      limit: z.number().optional().default(20).describe("Maximum traces to return"),
    },
    async ({ traceId, namespace, resourceType, resourceName, limit }) => {
      try {
        if (traceId) {
          const data = await kialiFetch(`/api/traces/${traceId}`);
          return {
            content: [{
              type: "text",
              text: `### Trace: \`${traceId}\`\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 5000)}\n\`\`\``,
            }],
          };
        }

        if (!namespace || !resourceName) {
          return { content: [{ type: "text", text: "Provide either traceId, or namespace + resourceName." }] };
        }

        const plural = resourceType === "workload" ? "workloads" : resourceType === "app" ? "apps" : "services";
        const params = new URLSearchParams();
        params.set("limit", String(limit));

        const data = await kialiFetch(
          `/api/namespaces/${namespace}/${plural}/${resourceName}/traces?${params.toString()}`
        );

        const traces = data.data || data.traces || [];
        if (traces.length === 0) {
          return { content: [{ type: "text", text: "No traces found for this resource." }] };
        }

        const lines = [`### Traces for \`${resourceName}\` in \`${namespace}\`\n`];
        lines.push("| Trace ID | Spans | Duration | Start Time |");
        lines.push("|---|---|---|---|");
        for (const t of traces.slice(0, limit)) {
          const tid = t.traceID || "?";
          const spans = (t.spans || []).length;
          const dur = t.duration ? `${(t.duration / 1000).toFixed(1)}ms` : "-";
          const startTime = t.startTime ? new Date(t.startTime / 1000).toISOString() : "-";
          lines.push(`| ${tid.slice(0, 16)}... | ${spans} | ${dur} | ${startTime} |`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOTFOUND")) {
          return { content: [{ type: "text", text: NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "ossm_workload_logs",
    "Get logs for a workload's pods in the service mesh, auto-detecting containers",
    {
      namespace: z.string().describe("Workload namespace"),
      workload: z.string().describe("Workload name"),
      container: z.string().optional().describe("Container name (auto-detected if not specified)"),
      since: z.string().optional().describe("Time duration, e.g. '1h', '30m'"),
      tail: z.number().optional().default(100).describe("Lines from end of log"),
    },
    async ({ namespace, workload, container, since, tail }) => {
      try {
        const params = new URLSearchParams();
        if (container) params.set("container", container);
        if (since) params.set("sinceTime", since);
        params.set("tailLines", String(tail));

        const data = await kialiFetch(
          `/api/namespaces/${namespace}/workloads/${workload}/logs?${params.toString()}`
        );

        if (typeof data === "string") {
          return { content: [{ type: "text", text: `### Logs: \`${workload}\`\n\n\`\`\`\n${data.slice(0, 10000)}\n\`\`\`` }] };
        }

        const entries = data.entries || data.logs || [];
        if (entries.length === 0) {
          return { content: [{ type: "text", text: `No logs found for workload \`${workload}\`.` }] };
        }

        const logText = entries
          .map(e => typeof e === "string" ? e : e.message || JSON.stringify(e))
          .join("\n");

        return {
          content: [{
            type: "text",
            text: `### Logs: \`${workload}\` in \`${namespace}\`\n\n\`\`\`\n${logText.slice(0, 10000)}\n\`\`\``,
          }],
        };
      } catch (err) {
        if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOTFOUND")) {
          return { content: [{ type: "text", text: NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
