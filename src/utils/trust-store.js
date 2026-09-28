// ---------------------------------------------------------------------------
// The certificates this pod is supposed to trust
// ---------------------------------------------------------------------------
/**
 * Why MTV can reach a vCenter that this agent cannot.
 *
 * MTV is a Go program. Go reads the operating system's trust store, and on
 * OpenShift that store is populated for you: the cluster's additional
 * certificate authorities are injected into every pod that asks for them, and
 * `update-ca-trust` merges them into the system bundle. An enterprise vCenter
 * with a certificate from the company's own CA is therefore trusted by MTV
 * without anybody configuring anything.
 *
 * Node.js does not do this. It ships its own compiled-in list of public root
 * authorities and ignores the operating system entirely unless told otherwise.
 * So the same certificate, on the same pod, verified by one process and
 * rejected by the other — which reads as "the agent is broken" and is really
 * "the agent never looked at the bundle sitting next to it".
 *
 * This reads the bundles that actually exist on an OpenShift pod, in the order
 * they are conventionally mounted, and hands them to the TLS connection. It is
 * additive: the public roots still apply, so a vCenter with a certificate from
 * a commercial authority keeps working.
 *
 * Nothing here weakens verification. A certificate that no bundle vouches for
 * is still refused — the difference is that it is now refused for a real
 * reason rather than because nobody read the file.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Where OpenShift and RHEL put trusted CAs, most specific first.
 *
 * The first two are where the cluster-wide additional trust bundle lands when
 * a ConfigMap carrying it is mounted into the pod — which is how a platform
 * team distributes their internal CA. The third is the merged system bundle
 * that `update-ca-trust` produces, which is what Go reads and what makes MTV
 * work where this did not.
 */
export const BUNDLE_PATHS = Object.freeze([
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/certs/ca-certificates.crt",
]);

/** Directories whose files are each a PEM to trust. */
export const ANCHOR_DIRS = Object.freeze([
  "/etc/pki/ca-trust/source/anchors",
  "/etc/pki/tls/certs",
]);

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Every certificate in a blob, so a bundle and a single cert both work. */
export function extractCertificates(text = "") {
  return String(text).match(PEM) || [];
}

/** Read one file, returning its certificates. Never throws. */
function readCerts(path) {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return [];
    return extractCertificates(readFileSync(path, "utf8"));
  } catch { return []; }
}

let _cache = null;

/**
 * Every certificate authority this pod has been given.
 *
 * @param {object} env
 * @returns {{certs:string[], sources:Array<{path:string,count:number}>, note:string}}
 */
export function clusterTrustBundle(env = process.env, { refresh = false } = {}) {
  if (_cache && !refresh) return _cache;

  const sources = [], seen = new Set(), certs = [];
  const take = (path, found) => {
    let added = 0;
    for (const c of found) {
      const key = c.replace(/\s+/g, "");
      if (seen.has(key)) continue;       // the same CA appears in several bundles
      seen.add(key); certs.push(c); added++;
    }
    if (added) sources.push({ path, count: added });
  };

  // An explicit path wins and is checked first: an operator who has mounted a
  // bundle specifically for this should not have it ranked below a default.
  for (const p of [env.VCENTER_CA_BUNDLE, env.NODE_EXTRA_CA_CERTS].filter(Boolean)) take(p, readCerts(p));
  for (const p of BUNDLE_PATHS) take(p, readCerts(p));
  for (const dir of ANCHOR_DIRS) {
    try {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!/\.(pem|crt|cer)$/i.test(f)) continue;
        take(join(dir, f), readCerts(join(dir, f)));
      }
    } catch { /* an unreadable directory is not an error worth failing on */ }
  }

  _cache = {
    certs, sources,
    note: certs.length
      ? `${certs.length} certificate authorities read from ${sources.length} location${sources.length === 1 ? "" : "s"} on this pod.`
      : "No certificate authorities were found on this pod beyond Node's built-in public roots. A vCenter using an internal CA will not verify until that CA is mounted, or supplied on the provider.",
  };
  return _cache;
}

/** For tests, and for a pod whose bundle is remounted without a restart. */
export function _resetTrustCache() { _cache = null; }

/**
 * The CA list for one connection: the pod's bundle plus anything the provider
 * carries, de-duplicated.
 *
 * Order does not matter to OpenSSL, but completeness does — a chain that needs
 * an intermediate from the provider and a root from the pod verifies only when
 * both are present, which is exactly the enterprise case.
 */
export function caForConnection(providerCa = null, env = process.env) {
  const bundle = clusterTrustBundle(env);
  const own = providerCa ? extractCertificates(providerCa) : [];
  if (!own.length && !bundle.certs.length) return null;
  const seen = new Set(), out = [];
  for (const c of [...own, ...bundle.certs]) {
    const key = c.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key); out.push(c);
  }
  return out;
}
