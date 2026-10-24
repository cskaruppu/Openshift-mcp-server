// One-time setup of limited, expiring access to the GPU cluster, done by the
// hub with a login it does not keep (e.g. the installer's system:admin
// certificate). It does what connect-gpu-cluster.sh does — the demo app, a
// service account that reads the cluster and changes only the demo namespace,
// and a token that expires — and returns that token. The admin login is used
// for these calls only and then dropped with the request.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { withRemoteCluster, ocpPatch, ocpPost } from "../../utils/openshift-client.js";

const MANIFESTS = ["scenario-payments.yaml", "gpu-cluster-access.yaml"]; // order: the demo namespace first
const SA_NS = "tcs-agentic-ai-access";
const SA = "tcs-agentic-ai-hub";
const FIELD_MANAGER = "tcs-agentic-ai";

// Where each kind lives in the API. Only the kinds in the two manifests.
const KINDS = {
  Namespace: { base: "/api/v1", plural: "namespaces", namespaced: false },
  ConfigMap: { base: "/api/v1", plural: "configmaps", namespaced: true },
  Service: { base: "/api/v1", plural: "services", namespaced: true },
  ServiceAccount: { base: "/api/v1", plural: "serviceaccounts", namespaced: true },
  Deployment: { base: "/apis/apps/v1", plural: "deployments", namespaced: true },
  ClusterRole: { base: "/apis/rbac.authorization.k8s.io/v1", plural: "clusterroles", namespaced: false },
  ClusterRoleBinding: { base: "/apis/rbac.authorization.k8s.io/v1", plural: "clusterrolebindings", namespaced: false },
  RoleBinding: { base: "/apis/rbac.authorization.k8s.io/v1", plural: "rolebindings", namespaced: true },
};

export async function setupObjects() {
  const out = [];
  for (const f of MANIFESTS) {
    const text = await readFile(fileURLToPath(new URL(`./manifests/${f}`, import.meta.url)), "utf8");
    for (const doc of yaml.loadAll(text)) if (doc && doc.kind) out.push(doc);
  }
  return out;
}

export function objectPath(obj) {
  const k = KINDS[obj.kind];
  if (!k) throw new Error(`No API path known for ${obj.kind}`);
  const ns = k.namespaced ? `/namespaces/${encodeURIComponent(obj.metadata.namespace)}` : "";
  return `${k.base}${ns}/${k.plural}/${encodeURIComponent(obj.metadata.name)}`;
}

/**
 * Apply the setup and issue a token for the service account.
 * `login` is { apiUrl, caCert, clientCert, clientKey } or { apiUrl, caCert, token }.
 */
export async function setupLimitedAccess(login, { durationHours = 72 } = {}) {
  const hours = Math.min(720, Math.max(1, Math.round(Number(durationHours) || 72)));
  const objects = await setupObjects();
  return withRemoteCluster(login.apiUrl, login.token || null, async () => {
    const applied = [];
    for (const obj of objects) {
      // Server-side apply: creates or updates, idempotent across re-runs.
      await ocpPatch(`${objectPath(obj)}?fieldManager=${FIELD_MANAGER}&force=true`, obj, "application/apply-patch+yaml");
      applied.push(`${obj.kind}/${obj.metadata.name}`);
    }
    const tr = await ocpPost(`/api/v1/namespaces/${SA_NS}/serviceaccounts/${SA}/token`, {
      apiVersion: "authentication.k8s.io/v1", kind: "TokenRequest", spec: { expirationSeconds: hours * 3600 },
    });
    if (!tr?.status?.token) throw new Error("The cluster did not issue a token for the service account");
    return { token: tr.status.token, expiresAt: tr.status.expirationTimestamp || null, hours, applied };
  }, { ca: login.caCert || null, cert: login.clientCert || null, key: login.clientKey || null });
}
