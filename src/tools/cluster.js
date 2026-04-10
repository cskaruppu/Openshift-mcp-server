import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerClusterTools(server) {
  // ---------- Get Cluster Info ----------
  server.tool(
    "get_cluster_info",
    "Get OpenShift cluster version, status, and configuration details",
    {},
    async () => {
      try {
        const [clusterVersion, infrastructure, clusterOperators] =
          await Promise.all([
            ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
            ocpGet("/apis/config.openshift.io/v1/infrastructures/cluster"),
            ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
          ]);

        const version =
          clusterVersion.status?.desired?.version || "unknown";
        const channel = clusterVersion.spec?.channel || "unknown";
        const platform =
          infrastructure.status?.platform || "unknown";
        const apiServerURL =
          infrastructure.status?.apiServerURL || "unknown";

        const operatorSummary = (clusterOperators.items || []).map((op) => {
          const conditions = (op.status?.conditions || []).reduce(
            (acc, c) => {
              acc[c.type] = c.status;
              return acc;
            },
            {}
          );
          return {
            name: op.metadata.name,
            available: conditions.Available || "Unknown",
            degraded: conditions.Degraded || "Unknown",
            progressing: conditions.Progressing || "Unknown",
          };
        });

        const degradedOps = operatorSummary.filter(
          (o) => o.degraded === "True"
        );
        const unavailableOps = operatorSummary.filter(
          (o) => o.available !== "True"
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  clusterVersion: version,
                  channel,
                  platform,
                  apiServerURL,
                  totalOperators: operatorSummary.length,
                  degradedOperators: degradedOps,
                  unavailableOperators: unavailableOps,
                  allOperators: operatorSummary,
                  updateAvailable:
                    clusterVersion.status?.availableUpdates?.length > 0,
                  availableUpdates:
                    clusterVersion.status?.availableUpdates || [],
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Get Cluster Events ----------
  server.tool(
    "get_cluster_events",
    "Get recent cluster events, optionally filtered by namespace or type (Warning/Normal)",
    {
      namespace: z
        .string()
        .optional()
        .describe("Filter events by namespace (omit for all)"),
      type: z
        .string()
        .optional()
        .describe("Filter by event type: Warning or Normal"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum number of events to return"),
    },
    async ({ namespace, type, limit }) => {
      try {
        const path = namespace
          ? `/api/v1/namespaces/${namespace}/events`
          : "/api/v1/events";
        const data = await ocpGet(path);
        let events = data.items || [];

        if (type) {
          events = events.filter(
            (e) => e.type?.toLowerCase() === type.toLowerCase()
          );
        }

        events.sort(
          (a, b) =>
            new Date(b.lastTimestamp || b.metadata.creationTimestamp) -
            new Date(a.lastTimestamp || a.metadata.creationTimestamp)
        );
        events = events.slice(0, limit);

        const summary = events.map((e) => ({
          type: e.type,
          reason: e.reason,
          message: e.message,
          namespace: e.metadata.namespace,
          involvedObject: `${e.involvedObject.kind}/${e.involvedObject.name}`,
          count: e.count,
          lastSeen: e.lastTimestamp || e.metadata.creationTimestamp,
        }));

        return {
          content: [
            { type: "text", text: JSON.stringify(summary, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Get Cluster Resource Usage ----------
  server.tool(
    "get_cluster_resource_usage",
    "Get cluster-wide resource allocation and usage summary (CPU, memory) across all nodes",
    {},
    async () => {
      try {
        const nodes = await ocpGet("/api/v1/nodes");
        const summary = (nodes.items || []).map((node) => {
          const cap = node.status?.capacity || {};
          const alloc = node.status?.allocatable || {};
          const conditions = (node.status?.conditions || []).reduce(
            (acc, c) => {
              acc[c.type] = c.status;
              return acc;
            },
            {}
          );
          return {
            name: node.metadata.name,
            roles: Object.keys(node.metadata.labels || {})
              .filter((l) => l.startsWith("node-role.kubernetes.io/"))
              .map((l) => l.replace("node-role.kubernetes.io/", "")),
            capacity: {
              cpu: cap.cpu,
              memory: cap.memory,
              pods: cap.pods,
            },
            allocatable: {
              cpu: alloc.cpu,
              memory: alloc.memory,
              pods: alloc.pods,
            },
            ready: conditions.Ready || "Unknown",
          };
        });

        return {
          content: [
            { type: "text", text: JSON.stringify(summary, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
