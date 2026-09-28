// ---------------------------------------------------------------------------
// Red Hat MTA / Konveyor — application analysis
// ---------------------------------------------------------------------------
/**
 * Why this exists rather than more rules of our own.
 *
 * The agent reads a RUNNING machine and is good at the operational reasons a
 * container is the wrong answer — a database on the box, a desktop session, a
 * node-locked licence. It is not, and should not pretend to be, a code
 * analyser. "Will this Java application run in a container" is a question the
 * Migration Toolkit for Applications has been answering since it was Windup,
 * with a rule corpus nobody is going to reproduce in regexes over command
 * lines, and — the part that actually matters in front of a customer — with
 * Red Hat's name and support behind the answer.
 *
 * So the division is deliberate and is the thing to say out loud in the room:
 *
 *   MTA   — what is wrong INSIDE the code. Rules, effort, Red Hat supported.
 *   Agent — what is wrong AROUND the code, on the machine it runs on.
 *
 * Neither tool produces both columns. Presenting them side by side, each
 * attributed, is worth more than either alone and is honest about which half
 * came from where.
 *
 * THE HANDOFF IS NOT MAGIC, and this is stated in the UI too: MTA analyses an
 * artefact or a repository. This agent executes nothing inside a guest, so it
 * cannot extract a war from a running machine. It identifies WHICH machines
 * carry a Java workload and what it saw; a human or a pipeline supplies the
 * artefact. Anything else would be a lie about where the war came from.
 *
 * VERSION TOLERANCE. MTA's API has moved — Windup, then Tackle, then MTA 6,
 * then MTA 7, with Konveyor upstream moving separately. Rather than hardcode
 * one shape and break on the others, this DISCOVERS what is installed, reports
 * exactly what it found, and lets the Hub base URL be overridden by
 * configuration so a version difference is a setting rather than a release.
 */

import { ocpGet } from "../utils/openshift-client.js";
import { fetch as undiciFetch, Agent } from "undici";

/**
 * The API groups MTA has shipped under, newest first.
 *
 * All three are checked because a customer's cluster carries whichever came
 * with their subscription, and guessing wrong reports "not installed" for a
 * product that is running.
 */
export const MTA_GROUPS = Object.freeze([
  { group: "mta.konveyor.io", version: "v1alpha1", label: "MTA 7.x" },
  { group: "tackle.konveyor.io", version: "v1alpha1", label: "MTA 6.x / Tackle" },
  { group: "konveyor.io", version: "v1alpha1", label: "Konveyor upstream" },
]);

/** Namespaces MTA is conventionally installed into. */
export const MTA_NAMESPACES = Object.freeze(["openshift-mta", "mta", "konveyor-tackle", "openshift-migration-toolkit"]);

const nowIso = () => new Date().toISOString();

/**
 * What an API error means, kept apart from "not installed".
 *
 * Same rule as the MTV readiness check: a 403 means the operator is there and
 * we may not look at it, which is a role to grant. Reporting that as "not
 * installed" sends someone to reinstall a working product.
 */
export function mtaAccessVerdict({ status, error }) {
  if (status === 403) {
    return {
      code: "rbac-denied", rbacDenied: true,
      message: "MTA is installed, but this service account may not read its resources. Grant read on the MTA API group — a cluster-side role binding, no image rebuild.",
    };
  }
  if (status === 404) return null;                 // genuinely absent; the caller says so
  if (status === 401) return { code: "unauthorised", message: "The cluster rejected the credential when reading MTA resources." };
  if (error) return { code: "unreachable", message: `MTA resources could not be read: ${error}` };
  return null;
}

/** The externally reachable host of a Route, or null. */
export function routeHost(route) {
  const h = route?.spec?.host || route?.status?.ingress?.[0]?.host || null;
  if (!h) return null;
  const tls = route?.spec?.tls ? "https" : "http";
  return `${tls}://${h}`;
}

/**
 * Is MTA usable, and if not, exactly why.
 *
 * Never throws. Mirrors checkMtvReadiness() deliberately — the operator learns
 * one shape of answer for "is the thing I depend on actually there".
 */
export async function mtaReadiness(env = process.env) {
  const blocking = [], warnings = [];
  const safe = async (p) => {
    try { return await ocpGet(p); }
    catch (e) {
      const m = /OCP API (\d{3})/.exec(e.message || "");
      return { __error: e.message, __status: m ? Number(m[1]) : 0 };
    }
  };

  // An explicit URL wins over discovery. An air-gapped or externally hosted
  // MTA is a real deployment and discovery would never find it.
  const configured = (env.MTA_HUB_URL || "").replace(/\/+$/, "");

  let found = null;
  for (const g of MTA_GROUPS) {
    for (const ns of MTA_NAMESPACES) {
      const r = await safe(`/apis/${g.group}/${g.version}/namespaces/${ns}/tackles`);
      const verdict = mtaAccessVerdict({ status: r.__status, error: r.__error });
      if (verdict?.rbacDenied) {
        blocking.push(verdict);
        return { ok: false, blocking, warnings, installed: true, readable: false, flavour: g.label, namespace: ns, hubUrl: configured || null, checkedAt: nowIso() };
      }
      if (Array.isArray(r.items) && r.items.length) { found = { ...g, namespace: ns, cr: r.items[0] }; break; }
    }
    if (found) break;
  }

  if (!found && !configured) {
    blocking.push({
      code: "not-installed",
      message: "The Migration Toolkit for Applications is not installed on this cluster. Install the MTA operator from OperatorHub, or set MTA_HUB_URL if it runs elsewhere.",
    });
    return { ok: false, blocking, warnings, installed: false, readable: true, hubUrl: null, checkedAt: nowIso() };
  }

  // The Hub's route. Only looked for where the CR was found — a route of the
  // same name in another namespace belongs to something else.
  let hubUrl = configured || null;
  if (!hubUrl && found) {
    const routes = await safe(`/apis/route.openshift.io/v1/namespaces/${found.namespace}/routes`);
    const r = (routes.items || []).find((x) => /mta|tackle|konveyor/i.test(x.metadata?.name || ""));
    hubUrl = routeHost(r);
    if (!hubUrl) {
      warnings.push({
        code: "no-route",
        message: `MTA is installed in ${found.namespace} but no Route to its Hub was found. Set MTA_HUB_URL to reach it, or expose the Hub service.`,
      });
    }
  }

  const ready = found ? isReady(found.cr) : null;
  if (found && ready === false) {
    warnings.push({ code: "not-ready", message: `The MTA instance in ${found.namespace} is not reporting Ready yet. Analyses submitted now may fail.` });
  }

  return {
    ok: Boolean(hubUrl) && blocking.length === 0,
    blocking, warnings,
    installed: Boolean(found) || Boolean(configured),
    readable: true,
    flavour: found?.label || (configured ? "configured externally" : null),
    namespace: found?.namespace || null,
    hubUrl,
    hubUrlSource: configured ? "MTA_HUB_URL" : hubUrl ? "route" : null,
    checkedAt: nowIso(),
  };
}

function isReady(cr) {
  const conds = cr?.status?.conditions || [];
  if (!conds.length) return null;
  const c = conds.find((x) => /ready|successful|deployed/i.test(x.type || ""));
  return c ? c.status === "True" : null;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
/**
 * Normalise an MTA issue into the shape the console already renders.
 *
 * Tolerant of several response shapes on purpose: MTA 6 called these "issues"
 * with a `rule` string, MTA 7 nests a `ruleset`/`rule` pair, and Konveyor's
 * analyzer emits `violations`. Rather than pin one and break on a customer's
 * version, the fields are read defensively and whatever is genuinely missing
 * stays null instead of being invented.
 *
 * Attribution is not optional. Every finding says it came from MTA and carries
 * its rule id, because the entire point of this integration is that the
 * customer can check it against Red Hat's own tool.
 */
export function normaliseIssues(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.issues) ? raw.issues
    : Array.isArray(raw?.violations) ? raw.violations
    : Array.isArray(raw?.items) ? raw.items : [];

  return list.map((i) => {
    const ruleset = i.ruleset || i.rulesetName || i.ruleSet || null;
    const rule = i.rule || i.ruleId || i.ruleID || i.name || null;
    const incidents = Array.isArray(i.incidents) ? i.incidents : [];
    return {
      source: "mta",
      id: [ruleset, rule].filter(Boolean).join("/") || "mta-issue",
      ruleset, rule,
      title: i.description || i.name || i.title || rule || "MTA finding",
      category: i.category || i.severity || null,
      // MTA reports effort in story points per incident. It is the number a
      // programme is actually planned from, so it is carried through rather
      // than flattened into "high/medium/low".
      effort: Number.isFinite(Number(i.effort)) ? Number(i.effort) : null,
      incidents: incidents.length || Number(i.totalIncidents) || null,
      files: [...new Set(incidents.map((x) => x.file || x.uri).filter(Boolean))].slice(0, 5),
      message: incidents[0]?.message || i.message || null,
      links: (i.links || i.labels || []).slice?.(0, 3) || [],
    };
  });
}

/**
 * Total effort, in MTA's own units.
 *
 * Multiplied by incidents, because one rule broken in forty files is forty
 * pieces of work — quoting the rule count instead is how a six-month
 * programme gets estimated at two weeks.
 */
export function effortSummary(issues = []) {
  let points = 0, counted = 0, unknown = 0;
  for (const i of issues) {
    if (i.effort == null) { unknown++; continue; }
    points += i.effort * (i.incidents || 1);
    counted++;
  }
  return {
    points, counted, unknown,
    note: unknown
      ? `${points} story points across ${counted} findings. ${unknown} finding${unknown === 1 ? " carries" : "s carry"} no effort estimate and ${unknown === 1 ? "is" : "are"} not in the total.`
      : `${points} story points across ${counted} findings, as MTA scores them.`,
  };
}

/**
 * The two-column view — the reason this integration exists.
 *
 * Kept strictly separated rather than merged into one score. They answer
 * different questions and are trusted for different reasons, and a single
 * blended number would hide which half a customer is entitled to verify
 * against Red Hat's own tool.
 */
export function combinedView(assessment, mta = null) {
  return {
    machine: assessment?.name || null,
    platform: {
      source: "TCS Agentic AI — read from the running machine",
      verdict: assessment?.verdict || null,
      summary: assessment?.summary || null,
      blockers: assessment?.blockers || [],
      concerns: (assessment?.concerns || []).filter((c) => c.required),
      unread: assessment?.unchecked || [],
    },
    code: mta?.ok
      ? {
        source: `Red Hat MTA${mta.flavour ? ` (${mta.flavour})` : ""} — read from the application artefact`,
        analysed: true,
        issues: mta.issues || [],
        effort: mta.effort || null,
        artefact: mta.artefact || null,
      }
      : {
        source: "Red Hat MTA",
        analysed: false,
        reason: mta?.reason
          || "No artefact was analysed. MTA reads a war, jar or repository; this agent reads a running machine and cannot extract one, so the artefact has to be supplied.",
      },
    // Said once, plainly, because it is the question an architect asks.
    division: "MTA reports what is wrong inside the code. The agent reports what is wrong around it, on the machine it runs on. Neither tool produces both columns.",
  };
}

// ---------------------------------------------------------------------------
// Hub calls
// ---------------------------------------------------------------------------
const dispatcher = new Agent({ connect: { rejectUnauthorized: false, timeout: 20_000 }, headersTimeout: 60_000 });

/**
 * One call to the MTA Hub.
 *
 * A response that is not the JSON we expect is reported as a VERSION mismatch
 * naming the URL tried, not as an outage — that is the difference between
 * "set MTA_API_PREFIX" and "page the platform team".
 */
export async function hubFetch(hubUrl, path, { method = "GET", body = null, token = null, prefix = null } = {}) {
  const base = String(hubUrl || "").replace(/\/+$/, "");
  const p = `${prefix ?? process.env.MTA_API_PREFIX ?? "/hub"}${path}`;
  const url = `${base}${p}`;
  let resp;
  try {
    resp = await undiciFetch(url, {
      method,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      dispatcher,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`MTA Hub at ${url} could not be reached: ${e.cause?.code || e.message}`);
  }
  const text = await resp.text();
  if (!resp.ok) throw new Error(`MTA Hub returned ${resp.status} for ${p}${text ? `: ${text.slice(0, 200)}` : ""}`);
  try { return text ? JSON.parse(text) : null; }
  catch {
    throw new Error(`MTA Hub answered ${url} with something that is not JSON. This usually means the API path differs on your MTA version — set MTA_API_PREFIX to match it.`);
  }
}

/** Applications MTA already knows about, so an analysis is not submitted twice. */
export async function listApplications(hubUrl, opts = {}) {
  const r = await hubFetch(hubUrl, "/applications", opts);
  return Array.isArray(r) ? r : (r?.items || []);
}

/** Findings for one application MTA has already analysed. */
export async function applicationIssues(hubUrl, appId, opts = {}) {
  const raw = await hubFetch(hubUrl, `/applications/${encodeURIComponent(appId)}/analysis/issues`, opts);
  const issues = normaliseIssues(raw);
  return { issues, effort: effortSummary(issues) };
}
