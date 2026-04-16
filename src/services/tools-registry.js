/**
 * Tools registry for the agent reasoning loop.
 *
 * Each tool is a read-only operation the LLM can request. Mutating actions
 * (restart/delete/scale) still go through the approval workflow, never
 * through the agent loop — keeps the user in control.
 */

import { ocpGet, ocpFetch } from "../utils/openshift-client.js";

const MAX_ITEMS = 40;

export const TOOLS = [
  // -------------------------------------------------------------------------
  {
    name: "list_pods",
    description: "List pods in a namespace (or all namespaces). Returns name, phase, restarts, and container states.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace; omit or 'all' for cluster-wide" },
        label_selector: { type: "string", description: "Optional label selector, e.g. 'app=web'" },
      },
      required: [],
    },
    handler: async ({ namespace, label_selector }) => {
      const ns = namespace && namespace !== "all" ? namespace : null;
      const path = ns ? `/api/v1/namespaces/${ns}/pods` : "/api/v1/pods";
      const q = label_selector ? `?labelSelector=${encodeURIComponent(label_selector)}` : "";
      const data = await ocpGet(path + q);
      return (data.items || []).slice(0, MAX_ITEMS).map((p) => ({
        name: p.metadata.name,
        namespace: p.metadata.namespace,
        phase: p.status?.phase,
        node: p.spec?.nodeName,
        restarts: (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0),
        containers: (p.status?.containerStatuses || []).map((c) => ({
          name: c.name,
          ready: c.ready,
          state: Object.keys(c.state || {})[0],
          reason:
            c.state?.waiting?.reason ||
            c.state?.terminated?.reason ||
            null,
        })),
      }));
    },
  },
  // -------------------------------------------------------------------------
  {
    name: "get_pod",
    description: "Get detailed status for a single pod including container state, resource limits, and node.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        name: { type: "string" },
      },
      required: ["namespace", "name"],
    },
    handler: async ({ namespace, name }) => {
      const p = await ocpGet(`/api/v1/namespaces/${namespace}/pods/${name}`);
      return {
        name: p.metadata?.name,
        namespace: p.metadata?.namespace,
        phase: p.status?.phase,
        node: p.spec?.nodeName,
        startTime: p.status?.startTime,
        containers: (p.status?.containerStatuses || []).map((c) => ({
          name: c.name,
          image: c.image,
          ready: c.ready,
          restarts: c.restartCount,
          state: c.state,
          lastState: c.lastState,
        })),
        spec: (p.spec?.containers || []).map((c) => ({
          name: c.name,
          image: c.image,
          resources: c.resources,
        })),
        ownerRef: p.metadata?.ownerReferences?.[0] || null,
      };
    },
  },
  // -------------------------------------------------------------------------
  {
    name: "get_pod_logs",
    description: "Fetch the last N lines of logs for a pod. Tail defaults to 100.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        name: { type: "string" },
        container: { type: "string", description: "Optional container name" },
        tail: { type: "integer", description: "Lines to tail (default 100, max 500)" },
        previous: { type: "boolean", description: "Fetch logs from previous crash" },
      },
      required: ["namespace", "name"],
    },
    handler: async ({ namespace, name, container, tail, previous }) => {
      const t = Math.min(tail || 100, 500);
      const qs = new URLSearchParams();
      qs.set("tailLines", String(t));
      if (container) qs.set("container", container);
      if (previous) qs.set("previous", "true");
      const path = `/api/v1/namespaces/${namespace}/pods/${name}/log?${qs.toString()}`;
      const text = await ocpFetch(path, { headers: { Accept: "text/plain" } });
      const s = typeof text === "string" ? text : String(text);
      return { logs: s.slice(-10000) };
    },
  },
  // -------------------------------------------------------------------------
  {
    name: "get_events_for_resource",
    description: "Return recent Warning events for a specific resource (pod, deployment, node, etc).",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        kind: { type: "string" },
        name: { type: "string" },
      },
      required: ["kind", "name"],
    },
    handler: async ({ namespace, kind, name }) => {
      const path = namespace
        ? `/api/v1/namespaces/${namespace}/events`
        : "/api/v1/events";
      const fs = encodeURIComponent(
        `involvedObject.kind=${kind},involvedObject.name=${name}`
      );
      const data = await ocpGet(`${path}?fieldSelector=${fs}`);
      return (data.items || [])
        .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0))
        .slice(0, 15)
        .map((e) => ({
          reason: e.reason,
          type: e.type,
          count: e.count,
          lastTimestamp: e.lastTimestamp,
          message: (e.message || "").substring(0, 300),
        }));
    },
  },
  // -------------------------------------------------------------------------
  {
    name: "describe_resource",
    description: "Get raw JSON describe output for any namespaced resource (deployment, service, configmap, etc). Use kind in plural lowercase.",
    input_schema: {
      type: "object",
      properties: {
        api: { type: "string", description: "API path prefix, e.g. /api/v1 or /apis/apps/v1" },
        namespace: { type: "string" },
        resource: { type: "string", description: "Resource plural, e.g. deployments, services" },
        name: { type: "string" },
      },
      required: ["api", "resource", "name"],
    },
    handler: async ({ api, namespace, resource, name }) => {
      const path = namespace
        ? `${api}/namespaces/${namespace}/${resource}/${name}`
        : `${api}/${resource}/${name}`;
      const d = await ocpGet(path);
      // Trim overly large fields
      if (d.metadata?.managedFields) delete d.metadata.managedFields;
      return d;
    },
  },
  // -------------------------------------------------------------------------
  {
    name: "list_nodes",
    description: "List all cluster nodes with ready status and resource capacity.",
    input_schema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const d = await ocpGet("/api/v1/nodes");
      return (d.items || []).map((n) => ({
        name: n.metadata.name,
        ready: (n.status?.conditions || []).some(
          (c) => c.type === "Ready" && c.status === "True"
        ),
        conditions: (n.status?.conditions || [])
          .filter((c) => c.status !== "False" || c.type === "Ready")
          .map((c) => ({ type: c.type, status: c.status, reason: c.reason })),
        cpu: n.status?.capacity?.cpu,
        memory: n.status?.capacity?.memory,
        pods: n.status?.capacity?.pods,
      }));
    },
  },
  // -------------------------------------------------------------------------
  {
    name: "list_deployments",
    description: "List deployments in a namespace (or all). Returns replica counts.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
      },
      required: [],
    },
    handler: async ({ namespace }) => {
      const path = namespace
        ? `/apis/apps/v1/namespaces/${namespace}/deployments`
        : "/apis/apps/v1/deployments";
      const d = await ocpGet(path);
      return (d.items || []).slice(0, MAX_ITEMS).map((x) => ({
        name: x.metadata.name,
        namespace: x.metadata.namespace,
        desired: x.spec?.replicas ?? 0,
        ready: x.status?.readyReplicas ?? 0,
        available: x.status?.availableReplicas ?? 0,
        image: x.spec?.template?.spec?.containers?.[0]?.image,
      }));
    },
  },
  // -------------------------------------------------------------------------
  {
    name: "top_pods",
    description: "Get pod resource usage from metrics-server. Returns CPU/memory for each pod.",
    input_schema: {
      type: "object",
      properties: { namespace: { type: "string" } },
      required: [],
    },
    handler: async ({ namespace }) => {
      const path = namespace
        ? `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`
        : "/apis/metrics.k8s.io/v1beta1/pods";
      const d = await ocpGet(path);
      return (d.items || []).slice(0, MAX_ITEMS).map((p) => ({
        name: p.metadata.name,
        namespace: p.metadata.namespace,
        containers: (p.containers || []).map((c) => ({
          name: c.name,
          cpu: c.usage?.cpu,
          memory: c.usage?.memory,
        })),
      }));
    },
  },
  // -------------------------------------------------------------------------
  {
    name: "query_metrics",
    description: "Run a PromQL query against the in-cluster Prometheus/Thanos. Use for CPU, memory, pod restarts, etc.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A PromQL expression" },
      },
      required: ["query"],
    },
    handler: async ({ query }) => {
      const { promQuery } = await import("./prometheus.js");
      return promQuery(query);
    },
  },
];

/**
 * Dispatch a tool call by name. Returns {ok,result} or {ok:false,error}.
 */
export async function dispatchTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  try {
    const started = Date.now();
    const result = await tool.handler(args || {});
    return { ok: true, result, durationMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
