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

/** vCenter appliances are routinely fronted by their own self-signed cert. */
let _agent = null;
function agent() {
  if (_agent) return _agent;
  _agent = new Agent({
    connect: {
      timeout: 15_000,
      // Opt-in only, and named for what it is. Default stays secure.
      rejectUnauthorized: String(process.env.VCENTER_INSECURE || "") !== "true",
    },
    keepAliveTimeout: 30_000,
    connections: 8,
  });
  return _agent;
}

/**
 * Read on every call rather than at module load, so a credential added from
 * the settings panel takes effect without a restart — same as ServiceNow.
 */
export function vcenterConfig(env = process.env) {
  const url = String(env.VCENTER_URL || "").replace(/\/+$/, "");
  const user = env.VCENTER_USERNAME || "";
  const pass = env.VCENTER_PASSWORD || "";
  if (!url || !user || !pass) {
    return {
      configured: false, url, user,
      reason: "No vCenter credential is configured. Set VCENTER_URL, VCENTER_USERNAME and VCENTER_PASSWORD to let the agent read tags and performance history directly — Forklift's inventory carries neither.",
    };
  }
  if (!/^https:\/\//i.test(url)) {
    return { configured: false, url, user, reason: "VCENTER_URL must be an https:// address." };
  }
  return { configured: true, url, user, pass, insecure: String(env.VCENTER_INSECURE || "") === "true", reason: null };
}

// ── Session ────────────────────────────────────────────────────────────────
/**
 * vSphere sessions are expensive to create and vCenter caps how many are open,
 * so one is reused until it expires. Cached against the URL and user, so a
 * changed credential is never silently used with the old session.
 */
let _session = null;
const SESSION_TTL_MS = 9 * 60_000;      // vCenter idles sessions out at ~10 min

export function _resetSession() { _session = null; }   // tests only

async function sessionToken(cfg) {
  const key = `${cfg.url}|${cfg.user}`;
  if (_session && _session.key === key && Date.now() < _session.expires) return _session.token;

  const auth = Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64");
  // 7.0u2+ serves /api; older appliances only /rest. Try the modern path first
  // and fall back, because the difference is invisible until it 404s.
  for (const path of ["/api/session", "/rest/com/vmware/cis/session"]) {
    let resp;
    try {
      resp = await undiciFetch(`${cfg.url}${path}`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        dispatcher: agent(),
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
    _session = { key, token, expires: Date.now() + SESSION_TTL_MS, rest: path.startsWith("/rest") };
    return token;
  }
  throw new Error("vCenter has no recognisable session endpoint — is this a vCenter, or an ESXi host?");
}

/** One authenticated call. Returns parsed JSON, or throws with a usable reason. */
export async function vcFetch(path, { method = "GET", body = null, timeoutMs = 30_000 } = {}) {
  const cfg = vcenterConfig();
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
    dispatcher: agent(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status === 401) { _session = null; throw new Error("vCenter session expired or was rejected."); }
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
let _soap = null;
const SOAP_TTL_MS = 25 * 60_000;

export function _resetSoap() { _soap = null; }   // tests only

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
    dispatcher: agent(),
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
  if (_soap && _soap.key === key && Date.now() < _soap.expires) return _soap;

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
  _soap = { key, cookie, perfManager, expires: Date.now() + SOAP_TTL_MS };
  return _soap;
}

/**
 * One authenticated SOAP call. `body` is built by the caller; the PerfManager
 * MoRef is handed back so the caller does not have to guess it.
 */
export async function vcSoap(buildBody, { timeoutMs = 60_000 } = {}) {
  const cfg = vcenterConfig();
  if (!cfg.configured) throw new Error(cfg.reason);
  const s = await soapSession(cfg);
  try {
    const { text } = await soapPost(cfg, soapEnvelope(buildBody(s)), s.cookie, timeoutMs);
    return text;
  } catch (e) {
    // An expired cookie reads as a fault, not a 401 — retry once from clean.
    if (/NotAuthenticated|session is not authenticated/i.test(e.message)) {
      _soap = null;
      const again = await soapSession(cfg);
      const { text } = await soapPost(cfg, soapEnvelope(buildBody(again)), again.cookie, timeoutMs);
      return text;
    }
    throw e;
  }
}
