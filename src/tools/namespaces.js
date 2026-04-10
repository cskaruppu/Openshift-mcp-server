import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerNamespaceTools(server) {
  // ---------- List Namespaces / Projects ----------
  server.tool(
    "list_namespaces",
    "List all namespaces/projects in the OpenShift cluster with status and labels",
    {
      showSystem: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include system namespaces (openshift-*, kube-*)"),
    },
    async ({ showSystem }) => {
      try {
        const data = await ocpGet("/api/v1/namespaces");
        let namespaces = data.items || [];

        if (!showSystem) {
          namespaces = namespaces.filter((ns) => {
            const name = ns.metadata.name;
            return (
              !name.startsWith("openshift-") &&
              !name.startsWith("kube-") &&
              name !== "default" &&
              name !== "openshift"
            );
          });
        }

        const summary = namespaces.map((ns) => ({
          name: ns.metadata.name,
          status: ns.status?.phase,
          labels: ns.metadata.labels,
          annotations: ns.metadata.annotations
            ? {
                description:
                  ns.metadata.annotations["openshift.io/description"] || "",
                displayName:
                  ns.metadata.annotations["openshift.io/display-name"] || "",
              }
            : {},
          createdAt: ns.metadata.creationTimestamp,
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

  // ---------- Get Namespace Details ----------
  server.tool(
    "get_namespace_details",
    "Get detailed information about a namespace including resource quotas, limit ranges, and workloads summary",
    {
      namespace: z.string().describe("Namespace to inspect"),
    },
    async ({ namespace }) => {
      try {
        const [ns, quotas, limits, pods, deployments, services] =
          await Promise.all([
            ocpGet(`/api/v1/namespaces/${namespace}`),
            ocpGet(`/api/v1/namespaces/${namespace}/resourcequotas`),
            ocpGet(`/api/v1/namespaces/${namespace}/limitranges`),
            ocpGet(`/api/v1/namespaces/${namespace}/pods`),
            ocpGet(
              `/apis/apps/v1/namespaces/${namespace}/deployments`
            ),
            ocpGet(`/api/v1/namespaces/${namespace}/services`),
          ]);

        const podPhases = {};
        (pods.items || []).forEach((p) => {
          const phase = p.status?.phase || "Unknown";
          podPhases[phase] = (podPhases[phase] || 0) + 1;
        });

        const depSummary = (deployments.items || []).map((d) => ({
          name: d.metadata.name,
          replicas: d.spec?.replicas,
          readyReplicas: d.status?.readyReplicas || 0,
          updatedReplicas: d.status?.updatedReplicas || 0,
          availableReplicas: d.status?.availableReplicas || 0,
        }));

        const svcSummary = (services.items || []).map((s) => ({
          name: s.metadata.name,
          type: s.spec?.type,
          clusterIP: s.spec?.clusterIP,
          ports: s.spec?.ports,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: ns.metadata.name,
                  status: ns.status?.phase,
                  labels: ns.metadata.labels,
                  resourceQuotas: (quotas.items || []).map((q) => ({
                    name: q.metadata.name,
                    hard: q.status?.hard,
                    used: q.status?.used,
                  })),
                  limitRanges: (limits.items || []).map((l) => ({
                    name: l.metadata.name,
                    limits: l.spec?.limits,
                  })),
                  podSummary: podPhases,
                  totalPods: pods.items?.length || 0,
                  deployments: depSummary,
                  services: svcSummary,
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
