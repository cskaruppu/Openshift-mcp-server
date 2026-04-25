import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerACMTools(server) {
  // ---------- List Managed Clusters (ACM) ----------
  server.tool(
    "list_managed_clusters",
    "List all clusters managed by Red Hat Advanced Cluster Management (ACM)",
    {},
    async () => {
      try {
        const data = await ocpGet(
          "/apis/cluster.open-cluster-management.io/v1/managedclusters"
        );
        const clusters = (data.items || []).map((c) => {
          const conditions = (c.status?.conditions || []).reduce(
            (acc, cond) => {
              acc[cond.type] = {
                status: cond.status,
                message: cond.message,
              };
              return acc;
            },
            {}
          );

          return {
            name: c.metadata.name,
            labels: c.metadata.labels,
            hubAccepted: c.spec?.hubAcceptsClient,
            available:
              conditions.ManagedClusterConditionAvailable?.status === "True",
            joined:
              conditions.ManagedClusterJoined?.status === "True",
            conditions,
            kubernetesVersion:
              c.status?.version?.kubernetes,
            allocatable: c.status?.allocatable,
            capacity: c.status?.capacity,
          };
        });

        return {
          content: [
            { type: "text", text: JSON.stringify(clusters, null, 2) },
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

  // ---------- Get Managed Cluster Details ----------
  server.tool(
    "get_managed_cluster_details",
    "Get detailed information about a specific ACM managed cluster",
    {
      clusterName: z.string().describe("Name of the managed cluster"),
    },
    async ({ clusterName }) => {
      try {
        const cluster = await ocpGet(
          `/apis/cluster.open-cluster-management.io/v1/managedclusters/${clusterName}`
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: cluster.metadata.name,
                  labels: cluster.metadata.labels,
                  conditions: cluster.status?.conditions,
                  version: cluster.status?.version,
                  capacity: cluster.status?.capacity,
                  allocatable: cluster.status?.allocatable,
                  clusterClaims: cluster.status?.clusterClaims?.map(
                    (cc) => ({ name: cc.name, value: cc.value })
                  ),
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

  // ---------- List Policies (ACM Governance) ----------
  server.tool(
    "list_acm_policies",
    "List governance policies across managed clusters (ACM)",
    {
      namespace: z
        .string()
        .optional()
        .default("open-cluster-management")
        .describe("Namespace where policies are defined"),
    },
    async ({ namespace }) => {
      try {
        const data = await ocpGet(
          `/apis/policy.open-cluster-management.io/v1/namespaces/${namespace}/policies`
        );
        const policies = (data.items || []).map((p) => ({
          name: p.metadata.name,
          namespace: p.metadata.namespace,
          remediationAction: p.spec?.remediationAction,
          disabled: p.spec?.disabled,
          complianceState:
            p.status?.compliant || "unknown",
          clusterStatus: p.status?.status?.map((s) => ({
            cluster: s.clustername,
            compliant: s.compliant || "unknown",
          })),
        }));

        return {
          content: [
            { type: "text", text: JSON.stringify(policies, null, 2) },
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

  // ---------- Multi-Cluster Search ----------
  server.tool(
    "search_across_clusters",
    "Search for resources across all ACM managed clusters using the search API",
    {
      kind: z
        .string()
        .describe("Resource kind to search: Pod, Deployment, Node, etc."),
      namespace: z.string().optional().describe("Filter by namespace"),
      name: z.string().optional().describe("Filter by resource name (partial match)"),
      status: z.string().optional().describe("Filter by status"),
    },
    async ({ kind, namespace, name, status }) => {
      try {
        // ACM Search API query
        let filters = [`kind:${kind}`];
        if (namespace) filters.push(`namespace:${namespace}`);
        if (name) filters.push(`name:${name}`);
        if (status) filters.push(`status:${status}`);

        // ACM search uses the search-api route
        const searchQuery = {
          operationName: "searchResult",
          variables: {
            input: [{ filters: filters.map((f) => {
              const [property, ...vals] = f.split(":");
              return { property, values: [vals.join(":")] };
            }) }],
          },
          query:
            "query searchResult($input: [SearchInput]) { searchResult: search(input: $input) { items count } }",
        };

        // Try the search API endpoint
        const searchRoute = await ocpGet(
          "/apis/route.openshift.io/v1/namespaces/open-cluster-management/routes/search-api"
        ).catch(() => null);

        if (searchRoute?.spec?.host) {
          const searchUrl = `https://${searchRoute.spec.host}/searchapi/graphql`;
          const resp = await fetch(searchUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.OPENSHIFT_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(searchQuery),
          });
          const result = await resp.json();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result.data?.searchResult || [], null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  message:
                    "ACM Search API route not found. Ensure ACM is installed and search is enabled.",
                  filters,
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
