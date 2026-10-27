// Private AI model router.
//
// Every AI call in the product goes through llm.js. With LLM_PROVIDER=private
// that call is routed here first, and the router picks which of the models
// served on the cluster's own GPUs answers it:
//
//   image attached                          → vision model
//   asks for YAML / a script / a manifest   → coder model (or the large one)
//   tools, investigations, plans, analyses  → large reasoning model
//   short questions and summaries           → small fast model
//   "@deep" "@fast" "@vision" "@code"        → the user's explicit choice
//
// and one rule above all of them: a request that carries secrets, keys,
// credentials or customer identifiers is kept on-prem, whatever else is
// configured. A cloud model is used only when PRIVATE_AI_CLOUD_PROVIDER is set,
// the request is not sensitive, and no on-prem model can answer.
//
// The models are OpenAI-compatible endpoints (vLLM on OpenShift AI / KServe):
//   PRIVATE_AI_LARGE_URL   PRIVATE_AI_LARGE_MODEL    (default gpt-oss-120b)
//   PRIVATE_AI_SMALL_URL   PRIVATE_AI_SMALL_MODEL
//   PRIVATE_AI_VISION_URL  PRIVATE_AI_VISION_MODEL
//   PRIVATE_AI_CODER_URL   PRIVATE_AI_CODER_MODEL    (optional → large)
//   PRIVATE_AI_<ROLE>_GPU  label shown on screen, e.g. "GPU 0 · H100"
//   PRIVATE_AI_API_KEY     bearer token, if the endpoints require one

import { randomBytes } from "node:crypto";
import { lanFetch } from "../../utils/lan-dns.js";
import { registerPart, changed } from "./persist.js";

export const ROLES = ["large", "small", "vision", "coder"];
const ROLE_LABEL = { large: "Reasoning", small: "Fast answers", vision: "Vision", coder: "Code and YAML" };
const DEFAULT_MODEL = { large: "gpt-oss-120b", small: "llama-3-1-8b", vision: "qwen2-5-vl-7b", coder: "" };

// Models discovered on the GPU clusters (fleet.js), with each cluster's policy.
// Set at startup; tests and single-cluster setups use the environment only.
let _fleet = { models: () => [], mode: () => "preferred", preferred: () => null };
export function setFleetProvider(p) { _fleet = { ..._fleet, ...p }; }

// Requests running per endpoint, as last read from each model's /metrics (factory.js).
const _load = new Map();
export function noteLoad(url, running) { if (url && Number.isFinite(running)) _load.set(url, running); }

/** The environment's models (enable.sh) plus every cluster's discovered ones; one entry per URL. */
export function models() {
  const out = envModels();
  const seen = new Set(out.map((m) => m.url));
  for (const m of _fleet.models()) {
    if (!m.url || seen.has(m.url) || !ROLES.includes(m.role)) continue;
    seen.add(m.url);
    out.push({ role: m.role, label: ROLE_LABEL[m.role] || m.label, url: m.url.replace(/\/+$/, ""), model: m.model, gpu: m.gpu || null,
      cluster: m.cluster, routing: m.routing !== false, sensitiveOk: m.sensitiveOk !== false, region: m.region || "" });
  }
  return out;
}

/** Order the models able to take a request: allowed by their cluster's policy, then preferred / least-loaded. */
export function rankCandidates(list, role, { sensitive = false } = {}) {
  const pref = _fleet.preferred();
  const ok = list.filter((m) => m.role === role && m.routing !== false && !(sensitive && m.sensitiveOk === false));
  const prefRank = (m) => (m.cluster == null || m.cluster === pref ? 0 : 1);
  return ok.sort(_fleet.mode() === "least-loaded"
    ? (a, b) => (_load.get(a.url) ?? 0) - (_load.get(b.url) ?? 0) || prefRank(a) - prefRank(b)
    : (a, b) => prefRank(a) - prefRank(b) || (_load.get(a.url) ?? 0) - (_load.get(b.url) ?? 0));
}

function envModels() {
  const out = [];
  for (const role of ROLES) {
    const R = role.toUpperCase();
    const url = (process.env[`PRIVATE_AI_${R}_URL`] || "").replace(/\/+$/, "");
    if (!url) continue;
    out.push({
      role, label: ROLE_LABEL[role], url,
      model: process.env[`PRIVATE_AI_${R}_MODEL`] || DEFAULT_MODEL[role] || role,
      gpu: process.env[`PRIVATE_AI_${R}_GPU`] || null,
      cluster: process.env.PRIVATE_AI_MODELS_CLUSTER || _fleet.preferred() || null, routing: true, sensitiveOk: true, region: "",
    });
  }
  return out;
}

/* ─────────────────────────── sensitivity ─────────────────────────── */

const SENSITIVE = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // No \b before the keyword: "db_password=" has no word boundary at "password".
  ["credential", /(?<![a-z])(pass(word|wd)?|secret|api[_-]?key|access[_-]?key|client[_-]?secret|token)\s*[:=]\s*\S{4,}/i],
  ["bearer token", /\bbearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  ["cloud key", /\b(AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["GitHub / GitLab token", /\b(ghp|gho|ghs|glpat)[-_][A-Za-z0-9_-]{16,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["card number", /\b(?:\d[ -]?){13,16}\b/, luhn],
  ["email address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ["Aadhaar / national id", /\b\d{4}\s\d{4}\s\d{4}\b/],
];

/** What, if anything, makes this text sensitive. Read on the ORIGINAL text, before redaction. */
export function sensitivity(text) {
  const found = [];
  for (const [name, re, check] of SENSITIVE) {
    if (!check) { if (re.test(text)) found.push(name); continue; }
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    if ([...String(text).matchAll(g)].some((m) => check(m[0]))) found.push(name);
  }
  return found;
}

// A card number is 13–19 digits that pass the Luhn check — not any long number.
function luhn(s) {
  const d = String(s).replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/* ─────────────────────────── guardrails ─────────────────────────── */

// Prompt-injection and jailbreak attempts are refused before any model sees them.
// Narrow on purpose: an operator asking "why did the pod ignore its limits" must pass.
// PRIVATE_AI_GUARDRAILS=false turns the check off.
const INJECTION = [
  ["override instructions", /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)*(previous|prior|above|earlier|system|original)\s+(instructions?|rules|prompts?|guidelines)\b/i],
  ["reveal system prompt", /\b(reveal|print|show|repeat|leak|output|dump)\s+(me\s+)?(your|the)\s+(system\s+prompt|hidden\s+(instructions|prompt)|initial\s+instructions)\b/i],
  ["jailbreak persona", /\b(you\s+are\s+now|act\s+as|pretend\s+(to\s+be|you\s+are))\s+(an?\s+)?(DAN|unfiltered|unrestricted|jailbroken|developer\s+mode)\b/i],
  ["policy bypass", /\b(bypass|disable|turn\s+off)\s+(your\s+|the\s+|all\s+)*(safety|guardrails?|content\s+filter|restrictions)\b/i],
];

/** Which injection pattern, if any, the text matches. */
export function injection(text) {
  if (process.env.PRIVATE_AI_GUARDRAILS === "false") return null;
  for (const [name, re] of INJECTION) if (re.test(String(text || ""))) return name;
  return null;
}

const MAX_EVENTS = 50;
const _guard = { injectionsBlocked: 0, events: [] };
function guardEvent(kind, what, question) {
  _guard.events.push({ at: new Date().toISOString(), kind, what, question: preview(question) });
  if (_guard.events.length > MAX_EVENTS) _guard.events.shift();
  changed();
}
/** Counters and the latest events for the guardrails panel (questions masked). */
export function guardrails() {
  return { on: process.env.PRIVATE_AI_GUARDRAILS !== "false", injectionsBlocked: _guard.injectionsBlocked,
    sensitiveKeptOnPrem: _counts.sensitiveKeptOnPrem, masked: _counts.masked, events: _guard.events.slice(-10).reverse() };
}

/* ─────────────────────────── decision ─────────────────────────── */

const textOf = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p?.text || "").join(" ") : "");

/**
 * Pick a role for one request. Pure: same input, same answer.
 * @returns {{ role, reason, sensitive: string[], override: string|null, cleaned: string|null }}
 */
export function decide({ messages = [], system = "", images = null, tools = null, available = ROLES }) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const q = textOf(lastUser).trim();
  const all = [system || "", ...messages.map(textOf)].join("\n");
  const sensitive = sensitivity(all);
  const has = (r) => available.includes(r);
  const pick = (r, reason) => ({ role: has(r) ? r : has("large") ? "large" : available[0], reason, sensitive, override: null, cleaned: null });

  const ov = q.match(/^@(deep|fast|vision|code)\b\s*/i);
  if (ov) {
    const role = { deep: "large", fast: "small", vision: "vision", code: "coder" }[ov[1].toLowerCase()];
    return { ...pick(role, `you asked for @${ov[1].toLowerCase()}`), override: role, cleaned: q.slice(ov[0].length) };
  }
  if (images && images.length) return pick("vision", "image attached");
  if (/\b(ya?ml|manifest|networkpolicy|dockerfile|helm|kustomiz|script|bash|terraform|ansible|regex|write (a|the) (code|function|policy|rule))\b/i.test(q)) {
    return pick(has("coder") ? "coder" : "large", "writes code or YAML");
  }
  if (tools && tools.length) return pick("large", "investigation with cluster tools");
  if (/\b(why|root cause|rca|investigate|diagnos|fix|remediat|plan|migrat|analy[sz]e|assess|compare|recommend|impact|risk)\b/i.test(q) || q.length > 600 || messages.length > 8) {
    return pick("large", "needs multi-step reasoning");
  }
  if (q && q.length <= 400) return pick("small", "quick question");
  return pick("large", "default for analysis");
}

/* ─────────────────────────── health ─────────────────────────── */

const _health = new Map(); // url → { ok, at, ms, error }
const HEALTH_TTL_MS = 20000;

export async function checkHealth(m, { force = false } = {}) {
  const h = _health.get(m.url);
  if (!force && h && Date.now() - h.at < HEALTH_TTL_MS) return h;
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  let res;
  try {
    const r = await lanFetch(`${m.url}${m.healthPath || "/v1/models"}`, { signal: ctl.signal, headers: process.env.PRIVATE_AI_API_KEY ? { Authorization: `Bearer ${process.env.PRIVATE_AI_API_KEY}` } : {} });
    res = { ok: r.ok, at: Date.now(), ms: Date.now() - t0, error: r.ok ? null : `HTTP ${r.status}` };
  } catch (e) {
    res = { ok: false, at: Date.now(), ms: Date.now() - t0, error: e?.name === "AbortError" ? "timed out" : e.message };
  } finally { clearTimeout(timer); }
  _health.set(m.url, res);
  return res;
}

/* ─────────────────────────── traffic log ─────────────────────────── */

const MAX_LOG = 300;
const _log = [];
const _counts = { total: 0, byRole: {}, sensitiveKeptOnPrem: 0, cloudCalls: 0, failures: 0, tokens: 0, masked: 0 };
let _since = new Date().toISOString();

function preview(q, max = 140) {
  // What the traffic panel shows: the text with anything sensitive masked.
  let s = String(q || "").replace(/\s+/g, " ").trim();
  for (const [, re] of SENSITIVE) s = s.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "••••••");
  return s.length > max ? s.slice(0, max - 3) + "…" : s;
}

export function trafficLog(limit = 50, { conversationId = null } = {}) {
  const src = conversationId ? _log.filter((d) => d.conversationId === conversationId) : _log;
  // The conversation id is for matching an answer to its route, not for display.
  return src.slice(-limit).reverse().map(({ conversationId: _c, ...d }) => d);
}
export function trafficCounts() { return { ..._counts, byRole: { ..._counts.byRole }, since: _since }; }
export function resetTraffic() {
  _log.length = 0; Object.assign(_counts, { total: 0, byRole: {}, sensitiveKeptOnPrem: 0, cloudCalls: 0, failures: 0, tokens: 0, masked: 0 });
  _guard.injectionsBlocked = 0; _guard.events.length = 0; _since = new Date().toISOString();
  changed();
}

/* ─────────────────────────── usage (enterprise view) ─────────────────────────── */

// Running totals per model, user, feature and day. Not limited to the last 300
// requests and not cleared by "New session": this is the usage record.
const MAX_DAYS = 60;
let _usage = { since: new Date().toISOString(), byModel: {}, byUser: {}, byFeature: {}, byDay: {} };
const blank = () => ({ requests: 0, ok: 0, failed: 0, blocked: 0, tokensIn: 0, tokensOut: 0, tokens: 0, ms: 0, timed: 0 });
function bump(map, key, d, fn) { const k = key || "unknown"; map[k] = map[k] || blank(); fn(map[k], d); }
function countUsage(d, kind) {
  const day = String(d.at || new Date().toISOString()).slice(0, 10);
  const add = (u) => {
    if (kind === "blocked") { u.requests++; u.blocked++; return; }
    u.requests++; if (d.ok) u.ok++; else u.failed++;
    u.tokensIn += d.promptTokens || 0; u.tokensOut += d.completionTokens || 0; u.tokens += d.tokens || 0;
    if (d.ms) { u.ms += d.ms; u.timed++; }
  };
  bump(_usage.byModel, d.blocked ? "(blocked)" : d.model || (d.onPrem === false ? "cloud" : "none"), d, add);
  bump(_usage.byUser, d.user || "platform (background)", d, add);
  bump(_usage.byFeature, d.useCase || "other", d, add);
  bump(_usage.byDay, day, d, add);
  const days = Object.keys(_usage.byDay).sort();
  for (const old of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete _usage.byDay[old];
}
export function usage() { return JSON.parse(JSON.stringify(_usage)); }
export function resetUsage() { _usage = { since: new Date().toISOString(), byModel: {}, byUser: {}, byFeature: {}, byDay: {} }; changed(); }

// Saved across restarts (persist.js). The log holds masked questions only.
registerPart("traffic", {
  exportState: () => ({ since: _since, counts: { ..._counts, byRole: { ..._counts.byRole } }, log: _log.slice(-MAX_LOG), guard: { injectionsBlocked: _guard.injectionsBlocked, events: _guard.events.slice() }, usage: _usage }),
  importState: (st) => {
    if (st.since) _since = st.since;
    if (st.counts) Object.assign(_counts, st.counts, { byRole: { ...(st.counts.byRole || {}) } });
    if (Array.isArray(st.log)) { _log.length = 0; _log.push(...st.log.slice(-MAX_LOG)); }
    if (st.guard) { _guard.injectionsBlocked = st.guard.injectionsBlocked || 0; _guard.events.length = 0; _guard.events.push(...(st.guard.events || []).slice(-MAX_EVENTS)); }
    if (st.usage && st.usage.byModel) _usage = { since: st.usage.since || _usage.since, byModel: st.usage.byModel || {}, byUser: st.usage.byUser || {}, byFeature: st.usage.byFeature || {}, byDay: st.usage.byDay || {} };
  },
});

/* ─────────────────────────── routing ─────────────────────────── */

/**
 * Turn resolved llm.js options for provider "private" into options for the
 * chosen endpoint. Returns { o, decision } — `o` is ready for callOpenAI, or
 * for the cloud provider when (and only when) policy allows it.
 */
export async function route(o, messages, { useCase = null, conversationId = null, user = null } = {}) {
  const list = models();
  const available = list.map((m) => m.role);
  if (!list.length) throw Object.assign(new Error("Private AI is selected but no model endpoints are configured (PRIVATE_AI_LARGE_URL …)"), { llmConfigError: true });
  const lastQ = textOf([...messages].reverse().find((m) => m.role === "user"));
  const inj = injection(lastQ);
  if (inj) {
    _guard.injectionsBlocked++; guardEvent("blocked", inj, lastQ);
    record({ id: randomBytes(6).toString("hex"), at: new Date().toISOString(), question: preview(lastQ), role: null, wanted: null, model: null, gpu: null,
      reason: `guardrail: ${inj}`, sensitive: [], onPrem: true, blocked: true, useCase, conversationId, user, ms: 0, ok: false, tokens: null });
    throw Object.assign(new Error(`Blocked by the Private AI guardrails (${inj}). Rephrase the request without asking the assistant to override its instructions.`), { status: 400, guardrail: inj });
  }
  const d = decide({ messages, system: o.system, images: o.images, tools: o.tools, available });
  if (d.sensitive.length) guardEvent("on-prem", d.sensitive.join(", "), lastQ);

  // Prefer the chosen role — on any GPU cluster its policy allows, in the fleet's
  // order — and if every copy is down, the nearest healthy on-prem model.
  const order = [d.role, ...(d.role === "small" ? ["large"] : d.role === "vision" ? [] : ["small"]), ...available].filter((r, i, a) => a.indexOf(r) === i);
  let chosen = null, fallbackNote = null;
  const firstPick = rankCandidates(list, d.role, { sensitive: d.sensitive.length > 0 })[0] || null;
  for (const role of order) {
    if (role === "vision" && d.role !== "vision") continue;
    for (const m of rankCandidates(list, role, { sensitive: d.sensitive.length > 0 })) {
      const h = await checkHealth(m);
      if (!h.ok) continue;
      chosen = m;
      if (role !== d.role) fallbackNote = `${d.role} model unavailable (${firstPick ? (await checkHealth(firstPick)).error || "down" : "none allowed"})`;
      else if (firstPick && m.url !== firstPick.url) fallbackNote = `${firstPick.model} on ${firstPick.cluster || "the selected cluster"} unavailable, answered on ${m.cluster}`;
      break;
    }
    if (chosen) break;
  }

  const cloud = process.env.PRIVATE_AI_CLOUD_PROVIDER;
  const decision = {
    id: randomBytes(6).toString("hex"), at: new Date().toISOString(), question: preview([...messages].reverse().find((m) => m.role === "user")?.content || useCase || ""),
    role: chosen?.role || null, wanted: d.role, model: chosen?.model || null, gpu: chosen?.gpu || null, cluster: chosen?.cluster || null, reason: fallbackNote ? `${d.reason} · ${fallbackNote}` : d.reason,
    sensitive: d.sensitive, onPrem: true, useCase, conversationId, user, ms: null, ok: null, tokens: null,
    // For the request detail panel: what the model was given and what it did.
    toolsOffered: Array.isArray(o.tools) ? o.tools.length : 0, images: Array.isArray(o.images) ? o.images.length : 0,
    turns: messages.length, override: d.override || null,
  };

  let out;
  if (chosen) {
    out = { ...o, provider: "openai", apiUrl: chosen.url, model: chosen.model, apiKey: process.env.PRIVATE_AI_API_KEY || "not-required", azureDeployment: null };
  } else if (cloud && !d.sensitive.length) {
    decision.onPrem = false; decision.role = "cloud"; decision.model = process.env.PRIVATE_AI_CLOUD_MODEL || process.env.PRIVATE_AI_CLOUD_DEPLOYMENT || cloud;
    decision.reason = `${d.reason} · no on-prem model healthy, policy allows cloud for non-sensitive requests`;
    out = { ...o, provider: cloud, apiUrl: process.env.PRIVATE_AI_CLOUD_URL || o.apiUrl, apiKey: process.env.PRIVATE_AI_CLOUD_KEY || o.apiKey,
      model: process.env.PRIVATE_AI_CLOUD_MODEL || o.model, azureDeployment: process.env.PRIVATE_AI_CLOUD_DEPLOYMENT || o.azureDeployment };
  } else {
    decision.ok = false; decision.reason = d.sensitive.length ? `${d.reason} · sensitive (${d.sensitive.join(", ")}), cloud not allowed` : `${d.reason} · no on-prem model healthy`;
    record(decision);
    throw Object.assign(new Error(`No private AI model is available to answer${d.sensitive.length ? " (request contains sensitive data, so it was not sent to a cloud model)" : ""}.`), { status: 503 });
  }
  record(decision);
  // `cleaned`: the last user message without its "@deep" prefix, for the caller to send.
  return { o: out, decision, cleaned: d.cleaned };
}

function record(decision) {
  _log.push(decision);
  if (_log.length > MAX_LOG) _log.shift();
  _counts.total++;
  _counts.byRole[decision.role || "none"] = (_counts.byRole[decision.role || "none"] || 0) + 1;
  if (decision.sensitive.length && decision.onPrem) { _counts.sensitiveKeptOnPrem++; _counts.masked += decision.sensitive.length; }
  if (!decision.onPrem) _counts.cloudCalls++;
  if (decision.blocked) countUsage(decision, "blocked");
  changed();
}

/** Log a call made outside llm.js (e.g. the side-by-side comparison) like any routed answer. */
export function logDirect(decision) { decision.question = preview(decision.question); record(decision); return decision; }

/** Called by llm.js when the call finishes. */
export function complete(decision, { ms, ok, usage, firstTokenMs = null, toolCalls = null, text = null, error = null }) {
  if (!decision) return;
  decision.ms = ms; decision.ok = ok;
  decision.firstTokenMs = firstTokenMs;
  decision.promptTokens = usage?.promptTokens ?? null;
  decision.completionTokens = usage?.completionTokens ?? null;
  decision.toolCalls = Array.isArray(toolCalls) ? toolCalls.map((t) => t?.name || t?.function?.name || "tool").slice(0, 12) : [];
  decision.answer = text ? preview(text, 400) : null;
  decision.error = error ? String(error).slice(0, 300) : null;
  const t = usage ? (usage.totalTokens ?? (((usage.promptTokens || 0) + (usage.completionTokens || 0)) || null)) : null;
  decision.tokens = t || null;
  if (!decision._counted) {
    decision._counted = true;
    if (t) _counts.tokens += t;
    if (!ok) _counts.failures++;
    countUsage(decision, "done");
  }
  changed();
}
