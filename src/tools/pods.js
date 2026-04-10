import { z } from "zod";
import { ocpGet, ocpDelete } from "../utils/openshift-client.js";

export function registerPodTools(server) {
  // ---------- List Pods ----------
  server.tool(
    "list_pods",
    "List pods in a namespace (or all namespaces) with status, restarts, and node placement",
    {
      namespace: z
        .string()
        .optional()
        .describe("Namespace to list pods from (omit for all namespaces)"),
      labelSelector: z
        .string()
        .optional()
        .describe("Label selector filter, e.g. app=nginx"),
      showAll: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include completed / succeeded pods"),
    },
    async ({ namespace, labelSelector, showAll }) => {
      try {
        let path = namespace
          ? `/api/v1/namespaces/${namespace}/pods`
          : "/api/v1/pods";
        if (labelSelector) path += `?labelSelector=${encodeURIComponent(labelSelector)}`;

        const data = await ocpGet(path);
        let pods = data.items || [];

        if (!showAll) {
          pods = pods.filter(
            (p) =>
              p.status?.phase !== "Succeeded" && p.status?.phase !== "Completed"
          );
        }

        const summary = pods.map((p) => {
          const containerStatuses = p.status?.containerStatuses || [];
          const totalRestarts = containerStatuses.reduce(
            (s, cs) => s + (cs.restartCount || 0),
            0
          );
          const readyContainers = containerStatuses.filter(
            (cs) => cs.ready
          ).length;

          return {
            name: p.metadata.name,
            namespace: p.metadata.namespace,
            phase: p.status?.phase,
            ready: `${readyContainers}/${containerStatuses.length}`,
            restarts: totalRestarts,
            node: p.spec?.nodeName,
            age: p.metadata.creationTimestamp,
            ip: p.status?.podIP,
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

  // ---------- Get Pod Details ----------
  server.tool(
    "get_pod_details",
    "Get detailed info for a specific pod including container statuses, events, resource requests, and logs summary",
    {
      namespace: z.string().describe("Namespace of the pod"),
      podName: z.string().describe("Name of the pod"),
    },
    async ({ namespace, podName }) => {
      try {
        const [pod, events] = await Promise.all([
          ocpGet(`/api/v1/namespaces/${namespace}/pods/${podName}`),
          ocpGet(
            `/api/v1/namespaces/${namespace}/events?fieldSelector=involvedObject.name=${podName}`
          ),
        ]);

        const containers = (pod.spec?.containers || []).map((c) => ({
          name: c.name,
          image: c.image,
          ports: c.ports,
          resources: c.resources,
          env: c.env?.map((e) => ({
            name: e.name,
            valueFrom: e.valueFrom ? "secret/configmap ref" : undefined,
          })),
        }));

        const containerStatuses = (pod.status?.containerStatuses || []).map(
          (cs) => ({
            name: cs.name,
            ready: cs.ready,
            restartCount: cs.restartCount,
            state: cs.state,
            lastState: cs.lastState,
          })
        );

        const podEvents = (events.items || [])
          .sort(
            (a, b) =>
              new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0)
          )
          .slice(0, 20)
          .map((e) => ({
            type: e.type,
            reason: e.reason,
            message: e.message,
            count: e.count,
            lastSeen: e.lastTimestamp,
          }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: pod.metadata.name,
                  namespace: pod.metadata.namespace,
                  phase: pod.status?.phase,
                  node: pod.spec?.nodeName,
                  serviceAccount: pod.spec?.serviceAccountName,
                  containers,
                  containerStatuses,
                  conditions: pod.status?.conditions,
                  events: podEvents,
                  volumes: pod.spec?.volumes?.map((v) => ({
                    name: v.name,
                    type: Object.keys(v).find((k) => k !== "name"),
                  })),
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

  // ---------- Get Pod Logs ----------
  server.tool(
    "get_pod_logs",
    "Retrieve logs from a pod container (last N lines)",
    {
      namespace: z.string().describe("Namespace of the pod"),
      podName: z.string().describe("Name of the pod"),
      container: z
        .string()
        .optional()
        .describe("Container name (required if multi-container pod)"),
      tailLines: z
        .number()
        .optional()
        .default(100)
        .describe("Number of recent log lines"),
      previous: z
        .boolean()
        .optional()
        .default(false)
        .describe("Get logs from previous (crashed) container instance"),
    },
    async ({ namespace, podName, container, tailLines, previous }) => {
      try {
        let path = `/api/v1/namespaces/${namespace}/pods/${podName}/log?tailLines=${tailLines}`;
        if (container) path += `&container=${container}`;
        if (previous) path += "&previous=true";

        const resp = await fetch(
          `${process.env.OPENSHIFT_API_URL || `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`}${path}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENSHIFT_TOKEN || ""}`,
            },
          }
        );
        const logs = await resp.text();

        return {
          content: [{ type: "text", text: logs || "(no logs)" }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Delete Pod (for restart) ----------
  server.tool(
    "delete_pod",
    "Delete a pod to trigger a restart (requires approval via ITSM or emergency mode)",
    {
      namespace: z.string().describe("Namespace of the pod"),
      podName: z.string().describe("Name of the pod to delete/restart"),
      reason: z.string().describe("Reason for deleting the pod"),
    },
    async ({ namespace, podName, reason }) => {
      try {
        await ocpDelete(`/api/v1/namespaces/${namespace}/pods/${podName}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  action: "pod_deleted",
                  namespace,
                  pod: podName,
                  reason,
                  message: `Pod ${podName} in namespace ${namespace} has been deleted. If managed by a controller (Deployment/StatefulSet), it will be recreated automatically.`,
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
}
