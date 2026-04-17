import { z } from "zod";
import {
  ocpGet,
  ocpPost,
  ocpDelete,
  ocpPatch,
  ocpFetch,
} from "../utils/openshift-client.js";

/**
 * Naively pluralize a Kubernetes kind name to form the REST resource path.
 * Handles common patterns; not exhaustive but covers the vast majority of
 * built-in and custom resources.
 */
function pluralizeKind(kind) {
  const lower = kind.toLowerCase();

  // Irregular plurals for well-known Kubernetes kinds
  const irregulars = {
    ingress: "ingresses",
    networkpolicy: "networkpolicies",
    endpoints: "endpoints",
    endpointslice: "endpointslices",
  };
  if (irregulars[lower]) return irregulars[lower];

  // Words ending in s, x, z, ch, sh -> add "es"
  if (/(?:s|x|z|ch|sh)$/.test(lower)) return lower + "es";
  // Words ending in consonant + y -> replace y with ies
  if (/[^aeiou]y$/.test(lower)) return lower.slice(0, -1) + "ies";

  return lower + "s";
}

/**
 * Build the API base path for a given apiVersion.
 * Core group ("v1") -> /api/v1
 * Named groups ("apps/v1") -> /apis/apps/v1
 */
function apiBasePath(apiVersion) {
  if (apiVersion === "v1") return "/api/v1";
  return `/apis/${apiVersion}`;
}

/**
 * Build the full resource path for get/delete (single resource) or list.
 */
function resourcePath({ apiVersion, kind, name, namespace }) {
  const base = apiBasePath(apiVersion);
  const plural = pluralizeKind(kind);
  if (namespace) {
    const p = `${base}/namespaces/${namespace}/${plural}`;
    return name ? `${p}/${name}` : p;
  }
  return name ? `${base}/${plural}/${name}` : `${base}/${plural}`;
}

/**
 * Try to parse a manifest string as JSON first, then fall back to a
 * minimal YAML-ish parser. Since the project has no YAML dependency we
 * rely on the manifest being JSON (which `kubectl` and `oc` both accept).
 */
function parseManifest(raw) {
  const trimmed = raw.trim();
  // Attempt JSON first (most programmatic callers will send JSON)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  // Very thin YAML subset: only supports flat & one-level nested scalars.
  // Callers should prefer JSON for complex manifests.
  throw new Error(
    "YAML manifests are not supported in this build. Please provide the manifest as a JSON string."
  );
}

export function registerGenericTools(server) {
  // ---------- generic_get ----------
  server.tool(
    "generic_get",
    "Get any Kubernetes resource by apiVersion, kind, and name",
    {
      apiVersion: z
        .string()
        .describe('API version, e.g. "v1", "apps/v1", "route.openshift.io/v1"'),
      kind: z.string().describe('Resource kind, e.g. "Deployment", "Service"'),
      name: z.string().describe("Name of the resource"),
      namespace: z
        .string()
        .optional()
        .describe("Namespace (omit for cluster-scoped resources)"),
    },
    async ({ apiVersion, kind, name, namespace }) => {
      try {
        const path = resourcePath({ apiVersion, kind, name, namespace });
        const data = await ocpGet(path);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- generic_list ----------
  server.tool(
    "generic_list",
    "List any Kubernetes resources by apiVersion and kind, with optional selectors",
    {
      apiVersion: z
        .string()
        .describe('API version, e.g. "v1", "apps/v1"'),
      kind: z.string().describe('Resource kind, e.g. "Pod", "Deployment"'),
      namespace: z
        .string()
        .optional()
        .describe("Namespace (omit for all namespaces / cluster-scoped)"),
      labelSelector: z
        .string()
        .optional()
        .describe("Label selector, e.g. app=nginx"),
      fieldSelector: z
        .string()
        .optional()
        .describe("Field selector, e.g. status.phase=Running"),
    },
    async ({ apiVersion, kind, namespace, labelSelector, fieldSelector }) => {
      try {
        let path = resourcePath({ apiVersion, kind, namespace });
        const params = new URLSearchParams();
        if (labelSelector) params.set("labelSelector", labelSelector);
        if (fieldSelector) params.set("fieldSelector", fieldSelector);
        const qs = params.toString();
        if (qs) path += `?${qs}`;

        const data = await ocpGet(path);
        const items = (data.items || []).map((item) => ({
          name: item.metadata?.name,
          namespace: item.metadata?.namespace,
          creationTimestamp: item.metadata?.creationTimestamp,
          labels: item.metadata?.labels,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { kind: data.kind, count: items.length, items },
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

  // ---------- generic_create ----------
  server.tool(
    "generic_create",
    "Create any Kubernetes resource from a JSON manifest",
    {
      manifest: z
        .string()
        .describe("Resource manifest as a JSON string"),
      namespace: z
        .string()
        .optional()
        .describe("Override namespace (uses manifest metadata.namespace if omitted)"),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, perform a server-side dry run only"),
    },
    async ({ manifest, namespace, dryRun }) => {
      try {
        const obj = parseManifest(manifest);
        const apiVersion = obj.apiVersion;
        const kind = obj.kind;
        if (!apiVersion || !kind) {
          throw new Error("Manifest must include apiVersion and kind");
        }
        const ns = namespace || obj.metadata?.namespace;
        let path = resourcePath({ apiVersion, kind, namespace: ns });
        if (dryRun) path += (path.includes("?") ? "&" : "?") + "dryRun=All";

        const data = await ocpPost(path, obj);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  action: "created",
                  kind: data.kind,
                  name: data.metadata?.name,
                  namespace: data.metadata?.namespace,
                  uid: data.metadata?.uid,
                  dryRun: !!dryRun,
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

  // ---------- generic_delete ----------
  server.tool(
    "generic_delete",
    "Delete any Kubernetes resource by apiVersion, kind, and name",
    {
      apiVersion: z
        .string()
        .describe('API version, e.g. "v1", "apps/v1"'),
      kind: z.string().describe('Resource kind, e.g. "Deployment"'),
      name: z.string().describe("Name of the resource to delete"),
      namespace: z
        .string()
        .optional()
        .describe("Namespace (omit for cluster-scoped resources)"),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, perform a server-side dry run only"),
    },
    async ({ apiVersion, kind, name, namespace, dryRun }) => {
      try {
        let path = resourcePath({ apiVersion, kind, name, namespace });
        if (dryRun) path += (path.includes("?") ? "&" : "?") + "dryRun=All";

        await ocpDelete(path);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  action: "deleted",
                  apiVersion,
                  kind,
                  name,
                  namespace: namespace || "(cluster-scoped)",
                  dryRun: !!dryRun,
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

  // ---------- generic_scale ----------
  server.tool(
    "generic_scale",
    "Get or update the scale of any scalable Kubernetes resource (Deployment, StatefulSet, ReplicaSet, etc.)",
    {
      apiVersion: z.string().describe('API version, e.g. "apps/v1"'),
      kind: z.string().describe('Resource kind, e.g. "Deployment", "StatefulSet"'),
      name: z.string().describe("Name of the resource"),
      namespace: z.string().optional().describe("Namespace"),
      scale: z.number().optional().describe("Desired replica count (omit to just read current scale)"),
    },
    async ({ apiVersion, kind, name, namespace, scale }) => {
      try {
        const base = apiBasePath(apiVersion);
        const plural = pluralizeKind(kind);
        const scalePath = namespace
          ? `${base}/namespaces/${namespace}/${plural}/${name}/scale`
          : `${base}/${plural}/${name}/scale`;

        if (scale === undefined || scale === null) {
          const data = await ocpGet(scalePath);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                kind: `${kind}/Scale`,
                name,
                namespace: namespace || "(cluster-scoped)",
                currentReplicas: data.status?.replicas ?? 0,
                desiredReplicas: data.spec?.replicas ?? 0,
              }, null, 2),
            }],
          };
        }

        const currentScale = await ocpGet(scalePath);
        currentScale.spec.replicas = scale;
        const data = await ocpFetch(scalePath, {
          method: "PUT",
          body: JSON.stringify(currentScale),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              action: "scaled",
              kind,
              name,
              namespace: namespace || "(cluster-scoped)",
              previousReplicas: currentScale.status?.replicas ?? "unknown",
              newReplicas: scale,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- generic_apply ----------
  server.tool(
    "generic_apply",
    "Apply (server-side patch) a Kubernetes resource from a JSON manifest",
    {
      manifest: z
        .string()
        .describe("Resource manifest as a JSON string (must include apiVersion, kind, metadata.name)"),
      namespace: z
        .string()
        .optional()
        .describe("Override namespace (uses manifest metadata.namespace if omitted)"),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, perform a server-side dry run only"),
    },
    async ({ manifest, namespace, dryRun }) => {
      try {
        const obj = parseManifest(manifest);
        const apiVersion = obj.apiVersion;
        const kind = obj.kind;
        const name = obj.metadata?.name;
        if (!apiVersion || !kind || !name) {
          throw new Error(
            "Manifest must include apiVersion, kind, and metadata.name"
          );
        }
        const ns = namespace || obj.metadata?.namespace;
        let path = resourcePath({ apiVersion, kind, name, namespace: ns });
        if (dryRun) path += (path.includes("?") ? "&" : "?") + "dryRun=All";

        const data = await ocpPatch(path, obj);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  action: "applied",
                  kind: data.kind,
                  name: data.metadata?.name,
                  namespace: data.metadata?.namespace,
                  resourceVersion: data.metadata?.resourceVersion,
                  dryRun: !!dryRun,
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
