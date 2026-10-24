// Direct access to the GPU cluster: read a kubeconfig, and find out what a
// token really is — whose it is, how much it may do, and when it stops
// working — before the Command Center relies on it on stage.

import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { withRemoteCluster, ocpGet, ocpPost } from "../../utils/openshift-client.js";

const fail = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * The API URL, CA and token of one context in a kubeconfig. Only token logins
 * can be used: client certificates and exec plugins never leave the machine
 * that holds them, so they cannot be handed to the hub.
 */
export function parseKubeconfig(text, wanted = null) {
  let kc;
  try { kc = yaml.load(String(text || "")); } catch (e) { throw fail(`Not a kubeconfig: ${e.message.split("\n")[0]}`); }
  if (!kc || typeof kc !== "object" || !Array.isArray(kc.contexts)) throw fail("Not a kubeconfig (no contexts)");
  const contexts = kc.contexts.map((c) => c?.name).filter(Boolean);
  const name = wanted || kc["current-context"] || contexts[0];
  const ctx = kc.contexts.find((c) => c?.name === name)?.context;
  if (!ctx) throw fail(`Context "${name}" is not in this kubeconfig`);
  const cluster = (kc.clusters || []).find((c) => c?.name === ctx.cluster)?.cluster;
  const user = (kc.users || []).find((u) => u?.name === ctx.user)?.user || {};
  if (!cluster?.server) throw fail(`Context "${name}" has no cluster server`);

  let caCert = null;
  if (cluster["certificate-authority-data"]) {
    caCert = Buffer.from(cluster["certificate-authority-data"], "base64").toString("utf8");
    if (!caCert.includes("BEGIN CERTIFICATE")) throw fail("certificate-authority-data is not a PEM certificate");
  }
  const notes = [];
  if (cluster["certificate-authority"]) notes.push("The CA is a file on your machine (certificate-authority), not in the kubeconfig — paste it in the CA field if the test reports a certificate error");
  if (cluster["insecure-skip-tls-verify"]) notes.push("This kubeconfig skips certificate checks; the hub does not — paste the cluster's CA if the test reports a certificate error");

  if (!user.token) {
    const how = user["client-certificate-data"] || user["client-certificate"] ? "a client certificate"
      : user.exec ? "an exec plugin" : user["auth-provider"] ? "an auth provider" : user.username ? "a username and password" : "no token";
    throw fail(`Context "${name}" logs in with ${how}, which cannot be handed to the hub. Log in with a token (oc login) or use connect-gpu-cluster.sh`);
  }
  return { contexts, context: name, apiUrl: String(cluster.server).replace(/\/+$/, ""), caCert, token: String(user.token).trim(), notes };
}

/** Expiry written inside a service-account (JWT) token; null for other tokens. */
export function jwtExpiry(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return { expiresAt: p.exp ? new Date(p.exp * 1000).toISOString() : null, subject: p.sub || null };
  } catch { return null; }
}

// An OpenShift OAuth token ("sha256~…") is stored as an object named after its hash.
const oauthObjectName = (token) => "sha256~" + createHash("sha256").update(token.slice("sha256~".length)).digest("base64url");

/**
 * Connect with the token and report: cluster version, who it is, whether it is
 * cluster-admin, and when it expires. Throws when the cluster cannot be used.
 */
export async function inspectAccess({ apiUrl, token, caCert }) {
  return withRemoteCluster(apiUrl, token, async () => {
    const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
    const out = { version: cv?.status?.desired?.version || "unknown", identity: null, kind: "token", clusterAdmin: false, expiresAt: null, permanent: false };

    const jwt = jwtExpiry(token);
    if (jwt) {
      out.kind = "service account";
      out.identity = jwt.subject;
      out.expiresAt = jwt.expiresAt;
      out.permanent = !jwt.expiresAt;
    } else if (token.startsWith("sha256~")) {
      out.kind = "user login";
      try {
        const t = await ocpGet(`/apis/oauth.openshift.io/v1/useroauthaccesstokens/${encodeURIComponent(oauthObjectName(token))}`);
        out.identity = t.userName || null;
        if (t.expiresIn > 0) out.expiresAt = new Date(new Date(t.metadata.creationTimestamp).getTime() + t.expiresIn * 1000).toISOString();
        else out.permanent = true;
      } catch { /* not allowed to read it: expiry unknown */ }
    }
    if (!out.identity) {
      try { out.identity = (await ocpPost("/apis/authentication.k8s.io/v1/selfsubjectreviews", { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview" }))?.status?.userInfo?.username || null; } catch { /* older clusters */ }
    }
    try {
      const r = await ocpPost("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: { verb: "*", group: "*", resource: "*" } } });
      out.clusterAdmin = !!r?.status?.allowed;
    } catch { /* unknown */ }
    return out;
  }, { ca: caCert || null });
}

/** "expires in 2 d 5 h" / "expired 3 h ago" / null. */
export function expiryText(expiresAt, now = Date.now()) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now;
  const abs = Math.abs(ms), d = Math.floor(abs / 86400000), h = Math.floor((abs % 86400000) / 3600000), m = Math.floor((abs % 3600000) / 60000);
  const span = d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
  return ms > 0 ? `expires in ${span}` : `expired ${span} ago`;
}

/** Explain a connection failure in terms of what to do about it. */
export function explainFailure(e) {
  const why = [e.message, e.cause?.code, e.cause?.message].filter((x, i, l) => x && l.indexOf(x) === i).join(" · ");
  const hint = /CERT|certificate|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(why) ? " — paste the cluster's CA certificate"
    : /401|Unauthorized/i.test(why) ? " — the token was rejected or has expired"
    : /403|Forbidden/i.test(why) ? " — the token works but lacks read access (apply gpu-cluster-access.yaml)"
    : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|abort/i.test(why) ? " — the hub cannot reach that address" : "";
  return `Could not connect: ${why}${hint}`;
}
