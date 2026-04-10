import { z } from "zod";
import { ocpGet, ocpPatch, ocpPost, ocpDelete } from "../utils/openshift-client.js";

export function registerWorkloadTools(server) {
  // ---------- List Deployments ----------
  server.tool(
    "list_deployments",
    "List all deployments in a namespace or cluster-wide with replica status",
    {
      namespace: z.string().optional().describe("Namespace (omit for all)"),
    },
    async ({ namespace }) => {
      try {
        const path = namespace
          ? `/apis/apps/v1/namespaces/${namespace}/deployments`
          : "/apis/apps/v1/deployments";
        const data = await ocpGet(path);
        const deps = (data.items || []).map((d) => ({
          name: d.metadata.name,
          namespace: d.metadata.namespace,
          replicas: d.spec?.replicas || 0,
          readyReplicas: d.status?.readyReplicas || 0,
          availableReplicas: d.status?.availableReplicas || 0,
          updatedReplicas: d.status?.updatedReplicas || 0,
          image: d.spec?.template?.spec?.containers?.[0]?.image,
          strategy: d.spec?.strategy?.type,
          createdAt: d.metadata.creationTimestamp,
        }));
        return { content: [{ type: "text", text: JSON.stringify(deps, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- List StatefulSets ----------
  server.tool(
    "list_statefulsets",
    "List all StatefulSets in a namespace or cluster-wide",
    {
      namespace: z.string().optional().describe("Namespace (omit for all)"),
    },
    async ({ namespace }) => {
      try {
        const path = namespace
          ? `/apis/apps/v1/namespaces/${namespace}/statefulsets`
          : "/apis/apps/v1/statefulsets";
        const data = await ocpGet(path);
        const sets = (data.items || []).map((s) => ({
          name: s.metadata.name,
          namespace: s.metadata.namespace,
          replicas: s.spec?.replicas || 0,
          readyReplicas: s.status?.readyReplicas || 0,
          image: s.spec?.template?.spec?.containers?.[0]?.image,
          createdAt: s.metadata.creationTimestamp,
        }));
        return { content: [{ type: "text", text: JSON.stringify(sets, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- List DaemonSets ----------
  server.tool(
    "list_daemonsets",
    "List all DaemonSets in a namespace or cluster-wide",
    {
      namespace: z.string().optional().describe("Namespace (omit for all)"),
    },
    async ({ namespace }) => {
      try {
        const path = namespace
          ? `/apis/apps/v1/namespaces/${namespace}/daemonsets`
          : "/apis/apps/v1/daemonsets";
        const data = await ocpGet(path);
        const sets = (data.items || []).map((d) => ({
          name: d.metadata.name,
          namespace: d.metadata.namespace,
          desired: d.status?.desiredNumberScheduled || 0,
          ready: d.status?.numberReady || 0,
          available: d.status?.numberAvailable || 0,
          image: d.spec?.template?.spec?.containers?.[0]?.image,
        }));
        return { content: [{ type: "text", text: JSON.stringify(sets, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Scale Deployment ----------
  server.tool(
    "scale_deployment",
    "Scale a deployment to a specified number of replicas",
    {
      namespace: z.string().describe("Namespace of the deployment"),
      deploymentName: z.string().describe("Name of the deployment"),
      replicas: z.number().describe("Desired replica count"),
      reason: z.string().describe("Reason for scaling"),
    },
    async ({ namespace, deploymentName, replicas, reason }) => {
      try {
        await ocpPatch(
          `/apis/apps/v1/namespaces/${namespace}/deployments/${deploymentName}`,
          { spec: { replicas } }
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "scaled",
              deployment: deploymentName,
              namespace,
              replicas,
              reason,
              message: `Deployment ${deploymentName} scaled to ${replicas} replicas.`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Restart Deployment (rolling restart) ----------
  server.tool(
    "restart_deployment",
    "Perform a rolling restart of a deployment by updating the restart annotation",
    {
      namespace: z.string().describe("Namespace of the deployment"),
      deploymentName: z.string().describe("Name of the deployment"),
      reason: z.string().describe("Reason for restart"),
    },
    async ({ namespace, deploymentName, reason }) => {
      try {
        await ocpPatch(
          `/apis/apps/v1/namespaces/${namespace}/deployments/${deploymentName}`,
          {
            spec: {
              template: {
                metadata: {
                  annotations: {
                    "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
                  },
                },
              },
            },
          }
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "restarted",
              deployment: deploymentName,
              namespace,
              reason,
              message: `Rolling restart triggered for deployment ${deploymentName}.`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- List Services ----------
  server.tool(
    "list_services",
    "List all services in a namespace or cluster-wide",
    {
      namespace: z.string().optional().describe("Namespace (omit for all)"),
    },
    async ({ namespace }) => {
      try {
        const path = namespace
          ? `/api/v1/namespaces/${namespace}/services`
          : "/api/v1/services";
        const data = await ocpGet(path);
        const svcs = (data.items || []).map((s) => ({
          name: s.metadata.name,
          namespace: s.metadata.namespace,
          type: s.spec?.type,
          clusterIP: s.spec?.clusterIP,
          ports: s.spec?.ports?.map((p) => `${p.port}/${p.protocol}`),
          selector: s.spec?.selector,
        }));
        return { content: [{ type: "text", text: JSON.stringify(svcs, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- List Routes ----------
  server.tool(
    "list_routes",
    "List all OpenShift routes in a namespace or cluster-wide",
    {
      namespace: z.string().optional().describe("Namespace (omit for all)"),
    },
    async ({ namespace }) => {
      try {
        const path = namespace
          ? `/apis/route.openshift.io/v1/namespaces/${namespace}/routes`
          : "/apis/route.openshift.io/v1/routes";
        const data = await ocpGet(path);
        const routes = (data.items || []).map((r) => ({
          name: r.metadata.name,
          namespace: r.metadata.namespace,
          host: r.spec?.host,
          path: r.spec?.path || "/",
          service: r.spec?.to?.name,
          tls: r.spec?.tls ? r.spec.tls.termination : "none",
        }));
        return { content: [{ type: "text", text: JSON.stringify(routes, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- List PVCs ----------
  server.tool(
    "list_pvcs",
    "List PersistentVolumeClaims in a namespace or cluster-wide",
    {
      namespace: z.string().optional().describe("Namespace (omit for all)"),
    },
    async ({ namespace }) => {
      try {
        const path = namespace
          ? `/api/v1/namespaces/${namespace}/persistentvolumeclaims`
          : "/api/v1/persistentvolumeclaims";
        const data = await ocpGet(path);
        const pvcs = (data.items || []).map((p) => ({
          name: p.metadata.name,
          namespace: p.metadata.namespace,
          status: p.status?.phase,
          capacity: p.status?.capacity?.storage,
          accessModes: p.status?.accessModes,
          storageClass: p.spec?.storageClassName,
        }));
        return { content: [{ type: "text", text: JSON.stringify(pvcs, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- List ConfigMaps ----------
  server.tool(
    "list_configmaps",
    "List ConfigMaps in a namespace",
    {
      namespace: z.string().describe("Namespace"),
    },
    async ({ namespace }) => {
      try {
        const data = await ocpGet(`/api/v1/namespaces/${namespace}/configmaps`);
        const cms = (data.items || []).map((c) => ({
          name: c.metadata.name,
          namespace: c.metadata.namespace,
          dataKeys: Object.keys(c.data || {}),
          createdAt: c.metadata.creationTimestamp,
        }));
        return { content: [{ type: "text", text: JSON.stringify(cms, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- List Secrets (names only, no data) ----------
  server.tool(
    "list_secrets",
    "List Secrets in a namespace (names and types only — no sensitive data exposed)",
    {
      namespace: z.string().describe("Namespace"),
    },
    async ({ namespace }) => {
      try {
        const data = await ocpGet(`/api/v1/namespaces/${namespace}/secrets`);
        const secrets = (data.items || []).map((s) => ({
          name: s.metadata.name,
          namespace: s.metadata.namespace,
          type: s.type,
          dataKeys: Object.keys(s.data || {}),
          createdAt: s.metadata.creationTimestamp,
        }));
        return { content: [{ type: "text", text: JSON.stringify(secrets, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
