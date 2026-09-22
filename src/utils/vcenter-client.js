/**
 * vCenter client — the agent's OWN read-only connection to vSphere.
 *
 * Everything else in this product reads vCenter through Forklift's inventory,
 * which mirrors the SOAP object model. Two things a migration needs badly are
 * not in that mirror:
 *
 *   TAGS live in vAPI, a separate REST surface, so a Forklift-only view reports
 *   "no tags" for an estate that is fully tagged. That is a fact about the
 *   connection, not the estate, and the difference decides whether a customer
 *   hears "you are untagged" or "we cannot see your tags".
 *
 *   PERFORMANCE HISTORY is only in the Web Services (SOAP) API — QueryPerf.
 *   There is no REST equivalent in 7.x, and the vStats API in 8.x covers a
 *   different, opt-in set of counters. Without it, right-sizing has nothing to
 *   measure, because this agent's own Prometheus watches the DESTINATION and
 *   has no history for a VM still running on VMware.
 *
 * So this connects directly, with credentials of its own, and asks for nothing
 * it does not need: System.Read on the vCenter is enough for both.
 *
 * Every failure here degrades to "no data" with a reason. A migration is
 * planned on these numbers — a client that guesses when it cannot read is
 * worse than one that says so.
 */
import { Agent, fetch as undiciFetch } from "undici";

/**
 * vCenter appliances are routinely fronted by their own self-signed cert, and
 * in an estate with several of them that is a per-appliance fact — one may
 * present a proper chain and the next may not. So there are two dispatchers,
 * and a credential picks the one it asked for. A single global agent would let
 * one lax appliance silently disable verification for every other.
 */
const _agents = new Map();
function agent(insecure = false) {
  const key = insecure ? "insecure" : "verified";
  if (_agents.has(key)) return _agents.get(key);
  const a = new Agent({
    connect: { timeout: 15_000, rejectUnauthorized: !insecure },
    keepAliveTimeout: 30_000,
    connections: 8,
  });
  _agents.set(key, a);
  return a;
}

/**
 * MTV stores a vSphere provider's URL as the SDK endpoint —
 * https://vcenter.example.com/sdk. The REST surface lives at the root, and the
 * SOAP client appends /sdk itself, so the suffix has to come off exactly once.
 * Getting this wrong produces /sdk/sdk, which 404s in a way that reads like a
 * wrong password.
 */
export function normaliseVcenterUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "").replace(/\/sdk$/i, "");
}

/** One credential, in the shape every call here expects. Pure. */
export function vcenterCredential({ url, username, password, insecure = false, source = "unknown" } = {}) {
  const u = normaliseVcenterUrl(url);
  if (!u || !username || !password) {
    return {
      configured: false, url: u, user: username || "", source,
      reason: "No vCenter credential is configured for this source provider. Settings → Integrations → vCenter — the agent needs its own read-only account to read tags and performance history, neither of which is in Forklift's inventory.",
    };
  }
  if (!/^https:\/\//i.test(u)) {
    return { configured: false, url: u, user: username, source, reason: "The vCenter URL must be an https:// address." };
  }
  return { configured: true, url: u, user: username, pass: password, insecure: insecure === true, source, reason: null };
}

/**
 * The global credential, from environment variables. Read on every call rather
 * than at module load, so a value written by the settings API takes effect
 * without a restart — same as ServiceNow.
 *
 * This is the FALLBACK. An estate with more than one vCenter configures each
 * source provider separately, because one global credential cannot be right
 * for two different vCenters at once.
 */
export function vcenterConfig(env = process.env) {
  return vcenterCredential({
    url: env.VCENTER_URL, username: env.VCENTER_USERNAME, password: env.VCENTER_PASSWORD,
    insecure: String(env.VCENTER_INSECURE || "") === "true",
    source: "environment",
  });
}

// ── Session ────────────────────────────────────────────────────────────────
/**
 * vSphere sessions are expensive to create and vCenter caps how many are open,
 * so one is reused until it expires. Cached against the URL and user, so a
 * changed credential is never silently used with the old session.
 */
const _sessions = new Map();            // "url|user" → { token, expires }
const SESSION_TTL_MS = 9 * 60_000;      // vCenter idles sessions out at ~10 min

/** Clear one vCenter's session, or all of them. */
export function _resetSession(key = null) {
  if (key) _sessions.delete(key); else _sessions.clear();
}

async function sessionToken(cfg) {
  // Keyed per vCenter AND per user: an estate with three vCenters holds three
  // live sessions, and a single slot would thrash between them — logging in
  // again on every call and eventually tripping vCenter's session cap.
  const key = `${cfg.url}|${cfg.user}`;
  const held = _sessions.get(key);
  if (held && Date.now() < held.expires) return held.token;

  const auth = Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64");
  // 7.0u2+ serves /api; older appliances only /rest. Try the modern path first
  // and fall back, because the difference is invisible until it 404s.
  for (const path of ["/api/session", "/rest/com/vmware/cis/session"]) {
    let resp;
    try {
      resp = await undiciFetch(`${cfg.url}${path}`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        dispatcher: agent(cfg.insecure),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new Error(`vCenter is not reachable at ${cfg.url}: ${e.message}`);
    }
    if (resp.status === 404) continue;
    if (resp.status === 401) throw new Error("vCenter rejected the credential (401). The account needs System.Read.");
    if (!resp.ok) throw new Error(`vCenter session failed (${resp.status}).`);
    const body = await resp.json().catch(() => null);
    // /api returns the token as a bare JSON string; /rest wraps it in {value}.
    const token = typeof body === "string" ? body : body?.value;
    if (!token) throw new Error("vCenter returned no session token.");
    _sessions.set(key, { token, expires: Date.now() + SESSION_TTL_MS, rest: path.startsWith("/rest") });
    return token;
  }
  throw new Error("vCenter has no recognisable session endpoint — is this a vCenter, or an ESXi host?");
}

/** One authenticated call. Returns parsed JSON, or throws with a usable reason. */
export async function vcFetch(path, { cfg = null, method = "GET", body = null, timeoutMs = 30_000 } = {}) {
  cfg = cfg || vcenterConfig();
  if (!cfg.configured) throw new Error(cfg.reason);
  const token = await sessionToken(cfg);
  const resp = await undiciFetch(`${cfg.url}${path}`, {
    method,
    headers: {
      // Both header names are accepted; sending both covers 7.0 and 8.0.
      "vmware-api-session-id": token,
      "vmware-use-header-authn": token,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    dispatcher: agent(cfg.insecure),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status === 401) { _resetSession(`${cfg.url}|${cfg.user}`); throw new Error("vCenter session expired or was rejected."); }
  if (!resp.ok) throw new Error(`vCenter ${method} ${path} failed (${resp.status}).`);
  const json = await resp.json().catch(() => null);
  // /rest wraps every payload in {value}; /api returns it bare.
  return json && typeof json === "object" && "value" in json && Object.keys(json).length === 1 ? json.value : json;
}

// ── SOAP ───────────────────────────────────────────────────────────────────
/**
 * The Web Services API is a different protocol with a different session: a
 * `vmware_soap_session` cookie, not the REST token. Kept separate rather than
 * bolted onto the REST session, because conflating them is the kind of bug
 * that only appears once the first session expires in production.
 */
const _soaps = new Map();               // "url|user" → { cookie, perfManager, expires }
const SOAP_TTL_MS = 25 * 60_000;

/** Clear one vCenter's SOAP session, or all of them. */
export function _resetSoap(key = null) {
  if (key) _soaps.delete(key); else _soaps.clear();
}

/** Escape a value going into an XML element. VM names come from vCenter. */
export const xmlEscape = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Wrap a VIM25 call body in the envelope vCenter expects. Pure. */
export function soapEnvelope(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"`
    + ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`
    + ` xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="urn:vim25">`
    + `<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

async function soapPost(cfg, envelope, cookie, timeoutMs) {
  const resp = await undiciFetch(`${cfg.url}/sdk`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: '"urn:vim25/7.0"',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: envelope,
    dispatcher: agent(cfg.insecure),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  if (!resp.ok) {
    const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(text)?.[1];
    throw new Error(`vCenter SOAP call failed (${resp.status})${fault ? `: ${fault.trim()}` : ""}.`);
  }
  return { text, setCookie: resp.headers.get("set-cookie") || null };
}

/** Log in to the Web Services API and keep the cookie. */
async function soapSession(cfg) {
  const key = `${cfg.url}|${cfg.user}`;
  const held = _soaps.get(key);
  if (held && Date.now() < held.expires) return held;

  // The service content names the managers by MoRef; they are fixed in
  // practice but reading them is one call and survives an appliance that
  // disagrees with the convention.
  const content = await soapPost(cfg, soapEnvelope(
    `<RetrieveServiceContent><_this type="ServiceInstance">ServiceInstance</_this></RetrieveServiceContent>`,
  ), null, 20_000);
  const sessionManager = /<sessionManager[^>]*>([^<]+)<\/sessionManager>/.exec(content.text)?.[1] || "SessionManager";
  const perfManager = /<perfManager[^>]*>([^<]+)<\/perfManager>/.exec(content.text)?.[1] || "PerfMgr";

  const login = await soapPost(cfg, soapEnvelope(
    `<Login><_this type="SessionManager">${xmlEscape(sessionManager)}</_this>`
    + `<userName>${xmlEscape(cfg.user)}</userName><password>${xmlEscape(cfg.pass)}</password></Login>`,
  ), null, 20_000);

  const raw = login.setCookie || "";
  const cookie = /vmware_soap_session=[^;]+/.exec(raw)?.[0];
  if (!cookie) throw new Error("vCenter accepted the SOAP login but returned no session cookie.");
  const made = { key, cookie, perfManager, expires: Date.now() + SOAP_TTL_MS };
  _soaps.set(key, made);
  return made;
}

/**
 * One authenticated SOAP call. `body` is built by the caller; the PerfManager
 * MoRef is handed back so the caller does not have to guess it.
 */
export async function vcSoap(buildBody, { cfg = null, timeoutMs = 60_000 } = {}) {
  cfg = cfg || vcenterConfig();
  if (!cfg.configured) throw new Error(cfg.reason);
  const s = await soapSession(cfg);
  try {
    const { text } = await soapPost(cfg, soapEnvelope(buildBody(s)), s.cookie, timeoutMs);
    return text;
  } catch (e) {
    // An expired cookie reads as a fault, not a 401 — retry once from clean.
    if (/NotAuthenticated|session is not authenticated/i.test(e.message)) {
      _resetSoap(`${cfg.url}|${cfg.user}`);
      const again = await soapSession(cfg);
      const { text } = await soapPost(cfg, soapEnvelope(buildBody(again)), again.cookie, timeoutMs);
      return text;
    }
    throw e;
  }
}
