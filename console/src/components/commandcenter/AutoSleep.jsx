import { useState } from "react";

// Auto-sleep, one line under each model in Model performance
// (services/private-ai/autosleep.js): what it is doing now, and an editor for
// the idle limit, keep-awake hours and "always on". Admin only for changes.

const DAYS = [["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["0", "Sun"]];
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "—");
const mins = (s) => (s == null ? null : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

export function autoSleepSummary(r) {
  if (!r?.policy || (!r.policy.enabled && !r.policy.alwaysOn)) return { tone: "muted", text: "Auto-sleep off" };
  if (r.policy.alwaysOn) return { tone: "muted", text: "Always on: never put to sleep" };
  if (r.asleep) return { tone: "sleep", text: `Asleep since ${hhmm(r.asleep.at)} (${r.asleep.afterMin} min without a request) · wakes on the next request${r.woke?.lastSeconds || r.woke?.seconds ? `, about ${mins(r.woke.seconds ?? r.woke.lastSeconds)}` : ""}` };
  if (r.woke && !r.woke.readyAt) return { tone: "wake", text: `Waking since ${hhmm(r.woke.at)} (${r.woke.why})` };
  if (r.inKeepAwake) return { tone: "on", text: `Kept awake now (keep-awake hours) · sleeps after ${r.policy.idleMin} min idle outside them` };
  return { tone: "on", text: `Sleeps after ${r.policy.idleMin} min without a request · quiet ${r.quietMin ?? 0} min${r.sleepsInMin != null ? `, sleeps in ${r.sleepsInMin} min` : ""}${r.woke?.seconds ? ` · last wake took ${mins(r.woke.seconds)}` : ""}` };
}

export function AutoSleepLine({ model, r, idleChoices, canManage, busy, onSave, onWake }) {
  const [edit, setEdit] = useState(false);
  const p = r?.policy || {};
  const [enabled, setEnabled] = useState(!!p.enabled);
  const [alwaysOn, setAlwaysOn] = useState(!!p.alwaysOn);
  const [idleMin, setIdleMin] = useState(p.idleMin || 30);
  const [ka, setKa] = useState(!!p.keepAwake);
  const [days, setDays] = useState((p.keepAwake?.days || [1, 2, 3, 4, 5]).map(String));
  const [from, setFrom] = useState(p.keepAwake?.from || "08:00");
  const [to, setTo] = useState(p.keepAwake?.to || "20:00");
  if (!r) return null;
  const sum = autoSleepSummary(r);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const save = () => onSave({ model, cluster: r.cluster, enabled, alwaysOn, idleMin: Number(idleMin), keepAwake: ka ? { days: days.map(Number), from, to, tz: p.keepAwake?.tz || tz } : null }, () => setEdit(false));
  return (
    <div className="as-line">
      <div className="as-row">
        <span className={"as-dot " + sum.tone} aria-hidden="true" />
        <span className="as-text">{sum.text}</span>
        {r.asleep && canManage && <button className="vc-btn ghost sm" disabled={!!busy} onClick={() => onWake(model, r.cluster)}>Wake now</button>}
        {canManage && <button className="vc-btn ghost sm" onClick={() => setEdit((v) => !v)}>{edit ? "Close" : "Auto-sleep…"}</button>}
      </div>
      {edit && (
        <div className="as-edit">
          <label className="as-check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Put to sleep when quiet</label>
          <label className="as-field">after
            <select value={idleMin} onChange={(e) => setIdleMin(e.target.value)} disabled={!enabled || alwaysOn}>{idleChoices.map((n) => <option key={n} value={n}>{n >= 60 ? `${n / 60} h` : `${n} min`}</option>)}</select>
            without a request
          </label>
          <label className="as-check"><input type="checkbox" checked={ka} onChange={(e) => setKa(e.target.checked)} disabled={!enabled || alwaysOn} /> Keep awake</label>
          {ka && (
            <span className="as-field">
              {DAYS.map(([v, l]) => (
                <label key={v} className="as-day"><input type="checkbox" checked={days.includes(v)} disabled={!enabled || alwaysOn}
                  onChange={(e) => setDays((d) => (e.target.checked ? [...d, v] : d.filter((x) => x !== v)))} />{l}</label>
              ))}
              <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} disabled={!enabled || alwaysOn} aria-label="From" />
              –<input type="time" value={to} onChange={(e) => setTo(e.target.value)} disabled={!enabled || alwaysOn} aria-label="To" />
              <span className="cc-muted">{p.keepAwake?.tz || tz}</span>
            </span>
          )}
          <label className="as-check"><input type="checkbox" checked={alwaysOn} onChange={(e) => setAlwaysOn(e.target.checked)} /> Always on (never sleeps)</label>
          <div className="as-actions">
            <button className="vc-btn primary sm" disabled={!!busy || (ka && !days.length)} onClick={save}>Save</button>
            <span className="cc-muted">A sleeping model is stopped in OpenShift AI (nothing is deleted). The first request starts it again; other models answer meanwhile.</span>
          </div>
        </div>
      )}
    </div>
  );
}
