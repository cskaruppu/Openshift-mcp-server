// Auto-sleep for the Private AI models: stop a model in OpenShift AI after it
// has answered nothing for a while, and start it again when it is needed.
//
//   sleep   every minute, a model with auto-sleep on, outside its keep-awake
//           hours and quiet for its idle limit, is stopped the way the Stop
//           button does it (serving.kserve.io/stop: "true"): its pods go, its
//           GPU memory is released, nothing is deleted.
//   wake    when the router wants a model that is asleep, it is started at once
//           and the request is answered by the next healthy model meanwhile;
//           a model asleep at the start of its keep-awake hours is started
//           then, so working hours never wait for it.
//
// "Quiet" is measured from the router's own record: the last answer the model
// gave, the moment it woke, or when the policy was set, whichever is latest.
// Calls that reach a model's Route without the router are not seen, which is
// why auto-sleep is off until someone turns it on for a model.

import { registerPart, changed } from "./persist.js";

const IDLE_CHOICES = [10, 15, 30, 60, 120, 240];
const WAKE_DEBOUNCE_MS = 5 * 60_000;
const MAX_EVENTS = 100;

let _deps = {
  models: () => [],                       // router.models(): { model, role, cluster, url, ... }
  health: async () => ({ ok: false }),    // router.checkHealth(model)
  running: async () => null,              // (cluster, name) → { stopped, ready } | null
  setRunning: async () => {},             // (cluster, name, run) → patch serving.kserve.io/stop
  preferred: () => null,
  audit: () => {},
  now: () => Date.now(),
};
export function configureAutoSleep(deps) { _deps = { ..._deps, ...deps }; }

let _st = { policies: {}, sleeping: {}, woke: {}, lastUse: {}, events: [] };
registerPart("autosleep", { exportState: () => _st, importState: (v) => { _st = { policies: {}, sleeping: {}, woke: {}, lastUse: {}, events: [], ...v }; } });
export function _resetAutoSleep() { _st = { policies: {}, sleeping: {}, woke: {}, lastUse: {}, events: [] }; }

const key = (cluster, model) => `${cluster || "local"}|${model}`;
const clusterOf = (m) => m?.cluster || _deps.preferred() || "local";
const iso = () => new Date(_deps.now()).toISOString();
function event(kind, k, text) {
  _st.events.unshift({ at: iso(), kind, model: k.split("|")[1], cluster: k.split("|")[0], text });
  if (_st.events.length > MAX_EVENTS) _st.events.length = MAX_EVENTS;
}

/* ─────────────────────────── policy ─────────────────────────── */

const DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** Validate and store a model's policy. */
export function setPolicy({ cluster, model, enabled, idleMin, alwaysOn, keepAwake }, actor = "admin") {
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(String(model || ""))) throw Object.assign(new Error("Not a valid model name"), { status: 400 });
  const m = _deps.models().find((x) => x.model === model && (!cluster || clusterOf(x) === cluster));
  const c = cluster || clusterOf(m);
  const k = key(c, model);
  const cur = _st.policies[k] || {};
  const idle = Number(idleMin ?? cur.idleMin ?? 30);
  if (!IDLE_CHOICES.includes(idle)) throw Object.assign(new Error(`Idle limit is one of ${IDLE_CHOICES.join(", ")} minutes`), { status: 400 });
  let ka = keepAwake === undefined ? cur.keepAwake || null : keepAwake;
  if (ka) {
    const days = [...new Set((ka.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    if (!DAY.test(ka.from || "") || !DAY.test(ka.to || "") || !days.length) throw Object.assign(new Error("Keep-awake hours need days and a from / to time (HH:MM)"), { status: 400 });
    let tz = String(ka.tz || "UTC");
    try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); } catch { tz = "UTC"; }
    ka = { days, from: ka.from, to: ka.to, tz };
  }
  const next = { enabled: !!(enabled ?? cur.enabled), idleMin: idle, alwaysOn: !!(alwaysOn ?? cur.alwaysOn), keepAwake: ka, role: m?.role || cur.role || null, setAt: iso(), setBy: actor };
  _st.policies[k] = next;
  event("policy", k, next.enabled && !next.alwaysOn ? `Auto-sleep on: sleeps after ${idle} min without a request${ka ? `, kept awake ${fmtWindow(ka)}` : ""}` : next.alwaysOn ? "Always on" : "Auto-sleep off");
  changed();
  return { cluster: c, model, policy: next };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function fmtWindow(ka) {
  const d = ka.days.join(",") === "1,2,3,4,5" ? "Mon–Fri" : ka.days.length === 7 ? "every day" : ka.days.map((x) => DAYS[x]).join(", ");
  return `${d} ${ka.from}–${ka.to} (${ka.tz})`;
}

/** Is `now` inside the keep-awake hours, in the policy's own time zone? */
export function inWindow(ka, now = _deps.now()) {
  if (!ka) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: ka.tz || "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const day = DAYS.indexOf(parts.weekday);
  const hm = `${parts.hour}:${parts.minute}`;
  const overnight = ka.from > ka.to;   // e.g. 20:00–06:00
  if (!overnight) return ka.days.includes(day) && hm >= ka.from && hm < ka.to;
  const prev = (day + 6) % 7;
  return (ka.days.includes(day) && hm >= ka.from) || (ka.days.includes(prev) && hm < ka.to);
}

/* ─────────────────────────── activity ─────────────────────────── */

/** The router calls this for every answer a model gives. */
export function noteUse(decision) {
  if (!decision?.model || decision.blocked || decision.onPrem === false) return;
  const k = key(decision.cluster || _deps.preferred() || "local", decision.model);
  _st.lastUse[k] = decision.at || iso();
}

function idleSince(k, p) {
  const t = [_st.lastUse[k], _st.woke[k]?.at, p.setAt].filter(Boolean).map((x) => Date.parse(x));
  return t.length ? Math.max(...t) : _deps.now();
}

/* ─────────────────────────── sleep and wake ─────────────────────────── */

/** One pass: sleep the quiet ones, wake the ones whose keep-awake hours began, time the wakes. */
export async function tick() {
  const now = _deps.now();
  const out = { slept: [], woke: [] };
  for (const [k, p] of Object.entries(_st.policies)) {
    const [cluster, model] = k.split("|");
    if (!p.enabled || p.alwaysOn) continue;
    const asleep = _st.sleeping[k];
    const awakeHours = inWindow(p.keepAwake, now);
    if (asleep) {
      if (awakeHours) { await wakeKey(k, "keep-awake hours began").catch((e) => event("error", k, `Could not start: ${e.message}`)); out.woke.push(model); continue; }
      // Started by someone else (Start button, models.sh): it is awake again.
      const st = await _deps.running(cluster, model).catch(() => null);
      if (st && !st.stopped) { delete _st.sleeping[k]; _st.woke[k] = { at: iso(), why: "started by hand", readyAt: null, seconds: null }; event("wake", k, "Started outside auto-sleep"); changed(); }
      continue;
    }
    if (awakeHours) continue;
    const quietMin = (now - idleSince(k, p)) / 60_000;
    if (quietMin < p.idleMin) continue;
    let st = null;
    try { st = await _deps.running(cluster, model); } catch { continue; }
    if (!st || st.stopped) continue;   // not found, or already stopped by someone
    try {
      await _deps.setRunning(cluster, model, false);
      _st.sleeping[k] = { at: iso(), afterMin: Math.round(quietMin), role: p.role };
      event("sleep", k, `Asleep after ${Math.round(quietMin)} min without a request; GPU memory released`);
      _deps.audit(`Auto-sleep: ${model} on ${cluster} stopped after ${Math.round(quietMin)} min without a request`, { cluster, model });
      out.slept.push(model);
      changed();
    } catch (e) { event("error", k, `Could not stop: ${e.message}`); }
  }
  // How long did the last wakes take? (first healthy answer after the start)
  for (const [k, w] of Object.entries(_st.woke)) {
    if (w.readyAt) continue;
    const m = _deps.models().find((x) => key(clusterOf(x), x.model) === k);
    if (!m) continue;
    const h = await _deps.health(m).catch(() => ({ ok: false }));
    if (h.ok) { w.readyAt = iso(); w.seconds = Math.round((Date.parse(w.readyAt) - Date.parse(w.at)) / 1000); event("ready", k, `Awake and answering, ${w.seconds} s after the start`); changed(); }
  }
  return out;
}

async function wakeKey(k, why) {
  const [cluster, model] = k.split("|");
  const w = _st.woke[k];
  if (w && !w.readyAt && _deps.now() - Date.parse(w.at) < WAKE_DEBOUNCE_MS) return w;   // already waking
  await _deps.setRunning(cluster, model, true);
  delete _st.sleeping[k];
  _st.woke[k] = { at: iso(), why, readyAt: null, seconds: null, lastSeconds: w?.seconds ?? w?.lastSeconds ?? null };
  event("wake", k, `Waking: ${why}`);
  _deps.audit(`Auto-sleep: ${model} on ${cluster} started (${why})`, { cluster, model });
  changed();
  return _st.woke[k];
}

/**
 * The router asks for a role whose model is not answering. If a model of that
 * role is asleep, start it (no waiting here) and say which, and how long the
 * last wake took.
 */
export function wakeFor(role, cluster = null) {
  const hit = Object.entries(_st.sleeping).find(([k, s]) => s.role === role && (!cluster || k.startsWith(`${cluster}|`)))
    || Object.entries(_st.woke).find(([k, w]) => !w.readyAt && _st.policies[k]?.role === role && (!cluster || k.startsWith(`${cluster}|`)));
  if (!hit) return null;
  const [k] = hit;
  wakeKey(k, "a request needed it").catch((e) => event("error", k, `Could not start: ${e.message}`));
  const w = _st.woke[k];
  return { model: k.split("|")[1], cluster: k.split("|")[0], lastWakeSeconds: w?.seconds ?? w?.lastSeconds ?? null };
}

/** Wake by hand (the Models tab). */
export async function wakeNow(cluster, model) { return wakeKey(key(cluster, model), "started from the Models tab"); }

/** Per model: its policy and what auto-sleep is doing with it. */
export function status() {
  const now = _deps.now();
  const rows = {};
  for (const m of _deps.models()) {
    const k = key(clusterOf(m), m.model);
    const p = _st.policies[k] || null;
    const since = p ? idleSince(k, p) : (_st.lastUse[k] ? Date.parse(_st.lastUse[k]) : null);
    rows[m.model] = {
      cluster: clusterOf(m), policy: p, asleep: _st.sleeping[k] || null, woke: _st.woke[k] || null,
      lastUse: _st.lastUse[k] || null, quietMin: since != null ? Math.floor((now - since) / 60_000) : null,
      inKeepAwake: p ? inWindow(p.keepAwake, now) : false,
      sleepsInMin: p?.enabled && !p.alwaysOn && !_st.sleeping[k] && !inWindow(p.keepAwake, now) ? Math.max(0, p.idleMin - Math.floor((now - since) / 60_000)) : null,
    };
  }
  return { models: rows, events: _st.events.slice(0, 30), idleChoices: IDLE_CHOICES };
}
