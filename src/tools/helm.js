import { z } from "zod";
import { ocpGet, ocpDelete } from "../utils/openshift-client.js";

export function registerHelmTools(server) {
  // ---------- List Helm Releases ----------
  server.tool(
    "helm_list",
    "List installed Helm releases by querying Helm's secret-based storage backend (secrets with label owner=helm)",
    {
      namespace: z
        .string()
        .optional()
        .describe("Namespace to list releases from (omit for all namespaces)"),
      allNamespaces: z
        .boolean()
        .optional()
        .default(false)
        .describe("List releases across all namespaces"),
    },
    async ({ namespace, allNamespaces }) => {
      try {
        let path;
        if (allNamespaces || !namespace) {
          path = "/api/v1/secrets?labelSelector=owner%3Dhelm";
        } else {
          path = `/api/v1/namespaces/${namespace}/secrets?labelSelector=owner%3Dhelm`;
        }

        const data = await ocpGet(path);
        const secrets = data.items || [];

        // Group by release name and pick the latest revision for each
        const releaseMap = new Map();
        for (const secret of secrets) {
          const labels = secret.metadata?.labels || {};
          const name = labels.name || secret.metadata?.name;
          const version = parseInt(labels.version || "0", 10);
          const status = labels.status || "unknown";

          const entry = {
            name,
            namespace: secret.metadata?.namespace,
            revision: version,
            status,
            updated: secret.metadata?.creationTimestamp,
            chart: labels.chart || "unknown",
          };

          const key = `${entry.namespace}/${name}`;
          const existing = releaseMap.get(key);
          if (!existing || existing.revision < version) {
            releaseMap.set(key, entry);
          }
        }

        const releases = Array.from(releaseMap.values()).sort((a, b) =>
          `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)
        );

        return {
          content: [
            {
              type: "text",
              text: releases.length > 0
                ? JSON.stringify(releases, null, 2)
                : "No Helm releases found.",
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

  // ---------- Install Helm Chart ----------
  server.tool(
    "helm_install",
    "Install a Helm chart into a namespace. Since Helm chart rendering requires the Helm CLI, this tool records the intent and provides the equivalent CLI command or suggests an Ansible playbook.",
    {
      releaseName: z.string().describe("Name for the Helm release"),
      chart: z.string().describe("Chart reference (e.g. bitnami/nginx, oci://registry/chart, or local path)"),
      namespace: z.string().describe("Target namespace for the release"),
      values: z
        .record(z.any())
        .optional()
        .describe("Values to override in the chart (key-value pairs)"),
      version: z
        .string()
        .optional()
        .describe("Specific chart version to install"),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, only show what would be installed without making changes"),
    },
    async ({ releaseName, chart, namespace, values, version, dryRun }) => {
      try {
        // Build the equivalent helm CLI command for the user
        let cliCommand = `helm install ${releaseName} ${chart} -n ${namespace}`;
        if (version) cliCommand += ` --version ${version}`;
        if (dryRun) cliCommand += " --dry-run";
        if (values && Object.keys(values).length > 0) {
          for (const [k, v] of Object.entries(values)) {
            cliCommand += ` --set ${k}=${v}`;
          }
        }

        const ansibleSnippet = [
          "- name: Install Helm chart",
          "  kubernetes.core.helm:",
          `    name: ${releaseName}`,
          `    chart_ref: ${chart}`,
          `    release_namespace: ${namespace}`,
          "    create_namespace: true",
        ];
        if (version) ansibleSnippet.push(`    chart_version: ${version}`);
        if (values && Object.keys(values).length > 0) {
          ansibleSnippet.push("    release_values:");
          for (const [k, v] of Object.entries(values)) {
            ansibleSnippet.push(`      ${k}: ${JSON.stringify(v)}`);
          }
        }

        const result = {
          action: "helm_install_guidance",
          releaseName,
          chart,
          namespace,
          version: version || "latest",
          dryRun,
          message:
            "Helm chart installation requires the Helm CLI to render templates and manage the release lifecycle. " +
            "This operation cannot be fully performed via the Kubernetes API alone. " +
            "Please use one of the following approaches:",
          cliCommand,
          ansiblePlaybookSnippet: ansibleSnippet.join("\n"),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Uninstall Helm Release ----------
  server.tool(
    "helm_uninstall",
    "Uninstall a Helm release by deleting its release secrets from the namespace",
    {
      releaseName: z.string().describe("Name of the Helm release to uninstall"),
      namespace: z.string().describe("Namespace of the Helm release"),
    },
    async ({ releaseName, namespace }) => {
      try {
        // Find all secrets belonging to this release
        const path = `/api/v1/namespaces/${namespace}/secrets?labelSelector=owner%3Dhelm,name%3D${encodeURIComponent(releaseName)}`;
        const data = await ocpGet(path);
        const secrets = data.items || [];

        if (secrets.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No Helm release named "${releaseName}" found in namespace "${namespace}".`,
              },
            ],
          };
        }

        // Delete each release secret
        const deleted = [];
        for (const secret of secrets) {
          const secretName = secret.metadata.name;
          await ocpDelete(`/api/v1/namespaces/${namespace}/secrets/${secretName}`);
          deleted.push(secretName);
        }

        const result = {
          action: "helm_uninstall",
          releaseName,
          namespace,
          deletedSecrets: deleted,
          message:
            `Helm release "${releaseName}" has been uninstalled. ` +
            `${deleted.length} release secret(s) deleted. ` +
            "Note: resources created by the chart (Deployments, Services, etc.) are NOT automatically removed. " +
            "Use the Helm CLI (`helm uninstall`) for a complete cleanup, or manually delete the remaining resources.",
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Helm Release Status ----------
  server.tool(
    "helm_status",
    "Get the status of a Helm release including its current revision, status, and metadata",
    {
      releaseName: z.string().describe("Name of the Helm release"),
      namespace: z.string().describe("Namespace of the Helm release"),
    },
    async ({ releaseName, namespace }) => {
      try {
        const path = `/api/v1/namespaces/${namespace}/secrets?labelSelector=owner%3Dhelm,name%3D${encodeURIComponent(releaseName)}`;
        const data = await ocpGet(path);
        const secrets = data.items || [];

        if (secrets.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No Helm release named "${releaseName}" found in namespace "${namespace}".`,
              },
            ],
          };
        }

        // Find the latest revision
        let latest = secrets[0];
        for (const secret of secrets) {
          const v = parseInt(secret.metadata?.labels?.version || "0", 10);
          const latestV = parseInt(latest.metadata?.labels?.version || "0", 10);
          if (v > latestV) latest = secret;
        }

        const labels = latest.metadata?.labels || {};

        // Attempt to decode release data for additional info
        let releaseInfo = null;
        if (latest.data?.release) {
          try {
            const decoded = Buffer.from(latest.data.release, "base64").toString("utf-8");
            // Helm stores releases as base64 -> gzip -> json; the first base64 decode
            // may yield gzipped data which we cannot easily parse without zlib.
            // We attempt a plain JSON parse as a best-effort.
            releaseInfo = JSON.parse(decoded);
          } catch {
            // Release data is likely gzipped; skip detailed parsing
          }
        }

        const status = {
          releaseName,
          namespace,
          revision: parseInt(labels.version || "0", 10),
          status: labels.status || "unknown",
          chart: labels.chart || "unknown",
          appVersion: releaseInfo?.chart?.metadata?.appVersion || "unknown",
          created: latest.metadata?.creationTimestamp,
          description: releaseInfo?.info?.description || "N/A",
          notes: releaseInfo?.info?.notes || "N/A (release data is compressed)",
          totalRevisions: secrets.length,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Helm Release History ----------
  server.tool(
    "helm_history",
    "Get the revision history of a Helm release showing all past and current versions",
    {
      releaseName: z.string().describe("Name of the Helm release"),
      namespace: z.string().describe("Namespace of the Helm release"),
    },
    async ({ releaseName, namespace }) => {
      try {
        const path = `/api/v1/namespaces/${namespace}/secrets?labelSelector=owner%3Dhelm,name%3D${encodeURIComponent(releaseName)}`;
        const data = await ocpGet(path);
        const secrets = data.items || [];

        if (secrets.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No Helm release named "${releaseName}" found in namespace "${namespace}".`,
              },
            ],
          };
        }

        // Sort by revision number ascending
        const history = secrets
          .map((secret) => {
            const labels = secret.metadata?.labels || {};
            return {
              revision: parseInt(labels.version || "0", 10),
              status: labels.status || "unknown",
              chart: labels.chart || "unknown",
              updated: secret.metadata?.creationTimestamp,
              secretName: secret.metadata?.name,
            };
          })
          .sort((a, b) => a.revision - b.revision);

        const result = {
          releaseName,
          namespace,
          totalRevisions: history.length,
          history,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
