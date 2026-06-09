import { z } from "zod";
import { ocpGet, ocpPatch } from "../utils/openshift-client.js";

const DEFAULT_NS = "openshift-gitops";
const ARGO_API = "apis/argoproj.io/v1alpha1";

export function registerGitOpsTools(server) {
  // ---------- List ArgoCD Applications ----------
  server.tool(
    "gitops_list_applications",
    "List all ArgoCD / OpenShift GitOps applications with sync and health status",
    {
      namespace: z
        .string()
        .optional()
        .default(DEFAULT_NS)
        .describe("Namespace where ArgoCD applications live (default: openshift-gitops)"),
      project: z
        .string()
        .optional()
        .describe("Filter by ArgoCD AppProject name"),
    },
    async ({ namespace, project }) => {
      try {
        const path = `/${ARGO_API}/namespaces/${namespace}/applications`;
        const data = await ocpGet(path);
        let apps = data.items || [];

        if (project) {
          apps = apps.filter(
            (a) => a.spec?.project === project
          );
        }

        const summary = apps.map((a) => ({
          name: a.metadata.name,
          namespace: a.metadata.namespace,
          syncStatus: a.status?.sync?.status || "Unknown",
          healthStatus: a.status?.health?.status || "Unknown",
          sourceRepo: a.spec?.source?.repoURL || a.spec?.sources?.[0]?.repoURL || "N/A",
          targetNamespace: a.spec?.destination?.namespace || "N/A",
          lastSynced: a.status?.operationState?.finishedAt || "Never",
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

  // ---------- Get ArgoCD Application Details ----------
  server.tool(
    "gitops_get_application",
    "Get detailed status of an ArgoCD application including sync, health, source, managed resources, conditions, and operation state",
    {
      name: z.string().describe("Name of the ArgoCD application"),
      namespace: z
        .string()
        .optional()
        .default(DEFAULT_NS)
        .describe("Namespace of the ArgoCD application (default: openshift-gitops)"),
    },
    async ({ name, namespace }) => {
      try {
        const path = `/${ARGO_API}/namespaces/${namespace}/applications/${name}`;
        const app = await ocpGet(path);

        const source = app.spec?.source
          ? {
              repoURL: app.spec.source.repoURL,
              path: app.spec.source.path || "N/A",
              targetRevision: app.spec.source.targetRevision || "HEAD",
              chart: app.spec.source.chart || undefined,
            }
          : app.spec?.sources?.map((s) => ({
              repoURL: s.repoURL,
              path: s.path || "N/A",
              targetRevision: s.targetRevision || "HEAD",
              chart: s.chart || undefined,
            })) || "N/A";

        const resources = (app.status?.resources || []).map((r) => ({
          group: r.group || "",
          kind: r.kind,
          namespace: r.namespace || "",
          name: r.name,
          syncStatus: r.status || "Unknown",
          health: r.health?.status || "Unknown",
        }));

        const detail = {
          name: app.metadata.name,
          namespace: app.metadata.namespace,
          project: app.spec?.project || "default",
          syncStatus: app.status?.sync?.status || "Unknown",
          syncRevision: app.status?.sync?.revision || "N/A",
          healthStatus: app.status?.health?.status || "Unknown",
          healthMessage: app.status?.health?.message || "",
          source,
          destination: {
            server: app.spec?.destination?.server || "N/A",
            namespace: app.spec?.destination?.namespace || "N/A",
          },
          resources,
          conditions: app.status?.conditions || [],
          operationState: app.status?.operationState
            ? {
                phase: app.status.operationState.phase,
                message: app.status.operationState.message || "",
                startedAt: app.status.operationState.startedAt || "N/A",
                finishedAt: app.status.operationState.finishedAt || "N/A",
                syncRevision:
                  app.status.operationState.syncResult?.revision || "N/A",
              }
            : null,
        };

        return {
          content: [
            { type: "text", text: JSON.stringify(detail, null, 2) },
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

  // ---------- Sync ArgoCD Application ----------
  server.tool(
    "gitops_sync_application",
    "Trigger a sync operation for an ArgoCD application to reconcile it with the desired state in Git",
    {
      name: z.string().describe("Name of the ArgoCD application to sync"),
      namespace: z
        .string()
        .optional()
        .default(DEFAULT_NS)
        .describe("Namespace of the ArgoCD application (default: openshift-gitops)"),
      revision: z
        .string()
        .optional()
        .describe("Git revision (SHA, tag, or branch) to sync to; omit for HEAD"),
      prune: z
        .boolean()
        .optional()
        .default(false)
        .describe("Remove resources not defined in Git"),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("Preview the sync without making changes"),
    },
    async ({ name, namespace, revision, prune, dryRun }) => {
      try {
        const syncPayload = {
          operation: {
            initiatedBy: { username: "agentic-ai-server" },
            sync: {
              ...(revision ? { revision } : {}),
              prune: prune || false,
              dryRun: dryRun || false,
            },
          },
        };

        const path = `/${ARGO_API}/namespaces/${namespace}/applications/${name}`;
        const result = await ocpPatch(path, syncPayload);

        const opState = result.status?.operationState;
        const response = {
          action: "sync_triggered",
          application: name,
          namespace,
          revision: revision || "HEAD",
          prune,
          dryRun,
          operationPhase: opState?.phase || "Pending",
          message: opState?.message || "Sync operation initiated",
          syncStatus: result.status?.sync?.status || "Unknown",
        };

        return {
          content: [
            { type: "text", text: JSON.stringify(response, null, 2) },
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

  // ---------- Show Application Diff (Out-of-Sync Resources) ----------
  server.tool(
    "gitops_app_diff",
    "Show resources that are out of sync in an ArgoCD application — what differs between the live state and Git",
    {
      name: z.string().describe("Name of the ArgoCD application"),
      namespace: z
        .string()
        .optional()
        .default(DEFAULT_NS)
        .describe("Namespace of the ArgoCD application (default: openshift-gitops)"),
    },
    async ({ name, namespace }) => {
      try {
        const path = `/${ARGO_API}/namespaces/${namespace}/applications/${name}`;
        const app = await ocpGet(path);

        const allResources = app.status?.resources || [];
        const outOfSync = allResources.filter(
          (r) => r.status === "OutOfSync"
        );

        const syncStatus = app.status?.sync?.status || "Unknown";
        const syncRevision = app.status?.sync?.revision || "N/A";

        const diff = {
          application: name,
          namespace,
          overallSyncStatus: syncStatus,
          currentRevision: syncRevision,
          totalResources: allResources.length,
          outOfSyncCount: outOfSync.length,
          outOfSyncResources: outOfSync.map((r) => ({
            group: r.group || "core",
            kind: r.kind,
            name: r.name,
            namespace: r.namespace || "",
            syncStatus: r.status,
            healthStatus: r.health?.status || "Unknown",
            healthMessage: r.health?.message || "",
            requiresPruning: r.requiresPruning || false,
          })),
          syncedResources: allResources
            .filter((r) => r.status === "Synced")
            .map((r) => ({
              group: r.group || "core",
              kind: r.kind,
              name: r.name,
              namespace: r.namespace || "",
              healthStatus: r.health?.status || "Unknown",
            })),
        };

        return {
          content: [
            { type: "text", text: JSON.stringify(diff, null, 2) },
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

  // ---------- List ArgoCD AppProjects ----------
  server.tool(
    "gitops_list_appprojects",
    "List ArgoCD AppProjects with their allowed source repos, destinations, and roles",
    {
      namespace: z
        .string()
        .optional()
        .default(DEFAULT_NS)
        .describe("Namespace where AppProjects are defined (default: openshift-gitops)"),
    },
    async ({ namespace }) => {
      try {
        const path = `/${ARGO_API}/namespaces/${namespace}/appprojects`;
        const data = await ocpGet(path);
        const projects = data.items || [];

        const summary = projects.map((p) => ({
          name: p.metadata.name,
          namespace: p.metadata.namespace,
          description: p.spec?.description || "",
          sourceRepos: p.spec?.sourceRepos || [],
          destinations: (p.spec?.destinations || []).map((d) => ({
            server: d.server || "*",
            namespace: d.namespace || "*",
            name: d.name || "",
          })),
          roles: (p.spec?.roles || []).map((r) => ({
            name: r.name,
            description: r.description || "",
            policies: r.policies || [],
          })),
          clusterResourceWhitelist: p.spec?.clusterResourceWhitelist || [],
          namespaceResourceBlacklist: p.spec?.namespaceResourceBlacklist || [],
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

  // ---------- Rollback ArgoCD Application ----------
  server.tool(
    "gitops_application_rollback",
    "Rollback an ArgoCD application to a specific Git revision (SHA or tag) by updating targetRevision and triggering a sync",
    {
      name: z.string().describe("Name of the ArgoCD application to rollback"),
      namespace: z
        .string()
        .optional()
        .default(DEFAULT_NS)
        .describe("Namespace of the ArgoCD application (default: openshift-gitops)"),
      revision: z
        .string()
        .describe("Git revision to rollback to (commit SHA, tag, or branch)"),
    },
    async ({ name, namespace, revision }) => {
      try {
        const appPath = `/${ARGO_API}/namespaces/${namespace}/applications/${name}`;

        // First, update the targetRevision in the application spec
        const revisionPatch = {
          spec: {
            source: {
              targetRevision: revision,
            },
          },
        };
        await ocpPatch(appPath, revisionPatch);

        // Then trigger a sync at the new revision
        const syncPatch = {
          operation: {
            initiatedBy: { username: "agentic-ai-server", automated: false },
            sync: {
              revision,
              prune: false,
            },
          },
        };
        const result = await ocpPatch(appPath, syncPatch);

        const opState = result.status?.operationState;
        const response = {
          action: "rollback_initiated",
          application: name,
          namespace,
          targetRevision: revision,
          operationPhase: opState?.phase || "Pending",
          message: opState?.message || `Rollback to revision ${revision} initiated`,
          syncStatus: result.status?.sync?.status || "Unknown",
          healthStatus: result.status?.health?.status || "Unknown",
        };

        return {
          content: [
            { type: "text", text: JSON.stringify(response, null, 2) },
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
