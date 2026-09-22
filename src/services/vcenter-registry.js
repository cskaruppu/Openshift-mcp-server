// ---------------------------------------------------------------------------
// Which vCenter, for which source provider
// ---------------------------------------------------------------------------
/**
 * An estate with one vCenter can get away with a single credential. An estate
 * with several cannot, and neither can a fleet where each OpenShift cluster
 * has its own MTV pointing somewhere different. One global username and
 * password is not a smaller version of that problem — it is the wrong answer
 * to it, because it will authenticate successfully against the wrong vCenter
 * and return somebody else's tags.
 *
 * So credentials are keyed by MTV SOURCE PROVIDER. That key is the right one
 * for three reasons:
 *
 *   - a provider's uid is unique across every cluster in the fleet, so the
 *     same key works whether there is one vCenter or thirty;
 *   - the provider already carries the vCenter's address in spec.url, so the
 *     URL never has to be typed twice and cannot drift out of step with the
 *     one MTV is actually migrating from;
 *   - it is what the operator already chose at the Discover step, so nothing
 *     new has to be picked to make the lookup work.
 *
 * Everything here is pure; the storage lives in dashboard-api.js beside the
 * other integration settings.
 */
import { vcenterCredential, vcenterConfig, normaliseVcenterUrl } from "../utils/vcenter-client.js";

/**
 * Resolve the credential to use for one source provider. Pure.
 *
 * Order, strongest first:
 *   1. A credential registered against this provider's uid.
 *   2. A credential registered against this provider's vCenter HOST — so two
 *      clusters whose MTV points at the same appliance are configured once.
 *   3. The global credential, which is correct only while there is one vCenter.
 *
 * The URL always comes from the provider when the provider supplied one. A
 * stored URL is a fallback for a provider that could not be read, never an
 * override: if they disagree, MTV is migrating from the one in spec.url and
 * that is the one whose tags and counters describe these machines.
 */
export function resolveVcenter(provider = null, store = {}, env = process.env) {
  const byUid = store.providers || {};
  const byHost = store.hosts || {};
  const providerUrl = normaliseVcenterUrl(provider?.url);
  const host = hostOf(providerUrl);

  const entry = (provider?.uid && byUid[provider.uid])
    || (host && byHost[host])
    || null;

  if (entry) {
    const cred = vcenterCredential({
      url: providerUrl || entry.url,
      username: entry.username,
      password: entry.password,
      insecure: entry.insecure,
      source: byUid[provider?.uid] ? "provider" : "host",
    });
    if (cred.configured) return { ...cred, provider: provider?.name || null, providerUid: provider?.uid || null };
    // A half-filled entry is worse than none: it reads as configured in the
    // settings list and fails at the first call. Say which field is missing.
    return { ...cred, provider: provider?.name || null, providerUid: provider?.uid || null };
  }

  const global = vcenterConfig(env);
  if (global.configured) {
    // A global credential against a provider whose vCenter it does not match
    // is the single most dangerous case here, so it is refused rather than
    // tried: it would authenticate and return the wrong estate's tags.
    if (providerUrl && hostOf(global.url) && hostOf(global.url) !== host) {
      return {
        configured: false, url: providerUrl, user: "", source: "global-mismatch",
        provider: provider?.name || null, providerUid: provider?.uid || null,
        reason: `The global vCenter credential points at ${hostOf(global.url)}, but the source provider "${provider?.name}" migrates from ${host}. Register a credential for this provider rather than reusing one for a different vCenter — it would authenticate and return the wrong estate's tags.`,
      };
    }
    return {
      ...vcenterCredential({ url: providerUrl || global.url, username: global.user, password: global.pass, insecure: global.insecure, source: "global" }),
      provider: provider?.name || null, providerUid: provider?.uid || null,
    };
  }

  return {
    configured: false, url: providerUrl, user: "", source: "none",
    provider: provider?.name || null, providerUid: provider?.uid || null,
    reason: provider?.name
      ? `No vCenter credential is registered for the source provider "${provider.name}"${host ? ` (${host})` : ""}. Settings → Integrations → vCenter.`
      : "No vCenter credential is configured.",
  };
}

/** The host part of a URL, for matching two providers onto one appliance. Pure. */
export function hostOf(url) {
  try { return new URL(normaliseVcenterUrl(url)).host.toLowerCase() || null; } catch { return null; }
}

/**
 * What the settings screen shows: every source provider, and whether it has a
 * credential. Pure.
 *
 * Providers are listed even when unconfigured — an estate where two of five
 * vCenters are wired up should say so, rather than showing two rows and
 * leaving the operator to notice the other three are missing.
 */
export function registryStatus(providers = [], store = {}, env = process.env) {
  return providers
    .filter((p) => p.isSource !== false)
    .map((p) => {
      const cred = resolveVcenter(p, store, env);
      return {
        uid: p.uid, name: p.name, type: p.type || "vsphere",
        url: normaliseVcenterUrl(p.url), host: hostOf(p.url),
        configured: cred.configured,
        source: cred.source,
        username: cred.configured ? cred.user : (store.providers?.[p.uid]?.username || ""),
        insecure: store.providers?.[p.uid]?.insecure === true,
        reason: cred.reason,
      };
    });
}

// ── MTV's own credential ───────────────────────────────────────────────────
/**
 * Turn a Forklift provider Secret into a credential. Pure.
 *
 * Forklift stores a vSphere provider's credentials as base64 in the Secret's
 * `data`: `user`, `password`, and optionally `url`, `insecureSkipVerify` and
 * `cacert`. Reusing them is the right default — they are per provider by
 * construction, they are already correct, and they rotate with MTV rather than
 * drifting away from it.
 *
 * The honest caveat, which the settings screen states rather than hides: this
 * account is MTV's, and MTV needs more than read — it powers machines off and
 * takes snapshots. The agent only ever reads with it, but an organisation that
 * wants the assessment to run under a genuinely read-only account should
 * register one per provider, which then takes precedence.
 */
export function credentialFromMtvSecret(secret = null, providerUrl = null) {
  const data = secret?.data || null;
  if (!data) return null;
  const dec = (k) => {
    const v = data[k];
    if (typeof v !== "string" || !v) return null;
    try { return Buffer.from(v, "base64").toString("utf8").trim(); } catch { return null; }
  };
  const username = dec("user") || dec("username");
  const password = dec("password");
  if (!username || !password) return null;

  // insecureSkipVerify is stored as the string "true"/"false". A provider
  // trusting a self-signed appliance must not become a verified connection
  // here, or every call fails with a certificate error that reads like a
  // network fault.
  const insecure = /^true$/i.test(dec("insecureSkipVerify") || "");
  return vcenterCredential({
    url: providerUrl || dec("url"),
    username, password, insecure,
    source: "mtv-secret",
  });
}

/**
 * The full resolution, including MTV's own secret. Async only because reading
 * a Secret is a cluster call; the ordering logic stays in resolveVcenter().
 *
 * @param {function} readSecret  async (name, namespace) => Secret | null
 */
export async function resolveForProvider(provider, store = {}, readSecret = null, env = process.env) {
  // An explicitly registered credential always wins: it is the one somebody
  // chose on purpose, and the whole point of registering it is to NOT use
  // MTV's more privileged account.
  const explicit = resolveVcenter(provider, { providers: store.providers, hosts: store.hosts }, {});
  if (explicit.configured) return explicit;

  // Then MTV's, unless it has been turned off.
  const useMtv = store.useMtvSecret !== false && env.VCENTER_USE_MTV_SECRET !== "false";
  let mtvNote = null;
  if (provider?.secret) {
    if (!useMtv) {
      mtvNote = `Reusing MTV's own credential is turned off, so "${provider.name}" needs a read-only credential registered against it.`;
    } else if (typeof readSecret !== "function") {
      mtvNote = `MTV holds a credential for "${provider.name}" in ${provider.secret.namespace}/${provider.secret.name}, but this agent has no way to read secrets.`;
    } else {
      try {
        const secret = await readSecret(provider.secret.name, provider.secret.namespace);
        const cred = credentialFromMtvSecret(secret, provider.url);
        if (cred?.configured) {
          return { ...cred, provider: provider.name || null, providerUid: provider.uid || null };
        }
        mtvNote = `MTV's secret ${provider.secret.namespace}/${provider.secret.name} does not carry a usable username and password.`;
      } catch (e) {
        mtvNote = `MTV holds a credential for "${provider.name}" in ${provider.secret.namespace}/${provider.secret.name}, but this agent could not read it (${e.message}) — grant get on that secret, or register a read-only credential for this provider in Settings.`;
      }
    }
  }

  // Finally the global credential, with the mismatch guard.
  const global = resolveVcenter(provider, store, env);
  if (global.configured) return global;

  // A reason that names the secret beats a generic one: it says exactly what
  // to grant, to whom, and where the alternative lives.
  return { ...global, reason: mtvNote || global.reason };
}
