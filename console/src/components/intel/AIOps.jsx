import { useState } from "react";
import { clusterUrl } from "../../api/client";

// AI Intelligence → "AI Operations" layout: one path from signal to resolution
// (detect → diagnose → decide → fix → verify), four destinations instead of
// ten tabs, and the manager's view (noise, service levels, prevention,
// autonomy) beside the work. Pure presentation: the data and actions come from
// IntelligenceView, which renders the existing sections underneath.

const num = (n) => (n == null ? "—" : Number(n).toLocaleString());

export const OPS_TABS = [
  { key: "needs", label: "Needs you" },
  { key: "incidents", label: "Incidents" },
  { key: "prevent", label: "Prevent" },
  { key: "automation", label: "Automation" },
];

// Each destination's views, mapped onto the existing sections.
export const OPS_SUBS = {
  needs: [],
  incidents: [
    { key: "active", label: "Active", tab: "autodetect", sub: "active" },
    { key: "register", label: "Incident register", tab: "incidents" },
    { key: "signals", label: "Alerts & AI insights", tab: "insights" },
    { key: "changes", label: "Cluster changes", tab: "timeline" },
    { key: "cross", label: "Cross-cluster", tab: "correlation" },
    { key: "history", label: "Fix history", tab: "autodetect", sub: "history" },
  ],
  prevent: [{ key: "predictions", label: "Predictions", tab: "predictions" }],
  automation: [
    { key: "policy", label: "Policy & thresholds", tab: "autodetect", sub: "policy" },
    { key: "rules", label: "Automation rules", tab: "rules" },
    { key: "playbook", label: "Playbooks", tab: "playbook" },
    { key: "kb", label: "Knowledge base", tab: "kb" },
  ],
};

export function OpsHeader({ cluster, flow, counts, monitoring, autoAct, opsTab, opsSub, onTab, onSub, onSettings, onRefresh, onLayout }) {
  const subs = OPS_SUBS[opsTab] || [];
  return (
    <div className="aio-head">
      <div className="aio-top">
        <div>
          <h2>AI Operations{cluster !== "local" && <span className="aio-cl">{cluster}</span>}</h2>
          <p>Detect → diagnose → decide → fix → verify. The agent does the work; you approve what changes the cluster.</p>
        </div>
        <div className="aio-top-r">
          <span className="aio-pill"><span className={"aio-dot " + (monitoring ? "on" : "off")} />{monitoring ? "Watching · every 60 s" : "Monitoring off"}</span>
          <span className="aio-pill">Autonomy: <b className={autoAct ? "ok" : ""}>{autoAct ? "Tickets automatic · fixes approved" : "Shadow mode"}</b></span>
          <button className="aio-btn" onClick={onSettings}>Automation settings</button>
          <button className="aio-btn" onClick={onRefresh}>Refresh</button>
        </div>
      </div>

      <div className="aio-flow" role="list" aria-label="From signal to resolution">
        {flow.map((s) => (
          <button key={s.key} role="listitem" className={"aio-st" + (s.tone ? ` ${s.tone}` : "")} onClick={s.go} title={s.hint || ""}>
            <small>{s.label}</small>
            <b>{num(s.value)}</b>
            <span>{s.sub}</span>
          </button>
        ))}
      </div>

      <div className="aio-nav" role="tablist">
        {OPS_TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={opsTab === t.key} className={opsTab === t.key ? "on" : ""} onClick={() => onTab(t.key)}>
            {t.label}{counts[t.key] != null && <span className={"aio-cnt" + (t.key === "needs" && counts.needs ? " w" : "")}>{num(counts[t.key])}</span>}
          </button>
        ))}
        <button className="aio-layout" onClick={onLayout} title="The previous layouts stay available">Previous layout</button>
      </div>
      {subs.length > 1 && (
        <div className="aio-sub" role="tablist">
          {subs.map((s) => <button key={s.key} role="tab" aria-selected={opsSub === s.key} className={opsSub === s.key ? "on" : ""} onClick={() => onSub(s.key)}>{s.label}{counts[`sub:${s.key}`] != null && <span className="aio-cnt">{num(counts[`sub:${s.key}`])}</span>}</button>)}
        </div>
      )}
    </div>
  );
}

export function OpsSide({ funnel, levels, predictions, autonomy, onPrevent, onAutomation }) {
  const top = Math.max(1, funnel[0]?.value || 1);
  const quiet = funnel[0]?.value ? Math.max(0, Math.round((1 - (funnel[funnel.length - 1].value || 0) / funnel[0].value) * 100)) : null;
  return (
    <aside className="aio-side">
      <div className="aio-card">
        <div className="aio-lbl">Noise reduction <span>now</span></div>
        <div className="aio-big">{quiet == null ? "—" : `${quiet}%`}<span>of signals never needed a person</span></div>
        <div className="aio-funnel">
          {funnel.map((f, i) => (
            <div key={f.label} className="aio-fr"><span>{f.label}</span><i className={`l${i}`} style={{ width: `${Math.max(2, Math.round(((f.value || 0) / top) * 100))}%` }} /><b>{num(f.value)}</b></div>
          ))}
        </div>
      </div>
      <div className="aio-card">
        <div className="aio-lbl">Service levels <span>last 30 days</span></div>
        <dl className="aio-kv">{levels.map((l) => <div key={l.label}><dt>{l.label}</dt><dd>{l.value}</dd></div>)}</dl>
      </div>
      <div className="aio-card">
        <div className="aio-lbl">Prevent <button className="aio-link" onClick={onPrevent}>All predictions</button></div>
        {predictions.length ? predictions.slice(0, 3).map((p, i) => (
          <div key={i} className="aio-pi"><span className={"aio-ic " + (p.tone || "w")}>{p.tone === "i" ? "i" : "!"}</span><div>{p.title}<small>{p.sub}</small></div></div>
        )) : <p className="aio-muted">Nothing predicted to break. Predictions run on usage trends and capacity.</p>}
      </div>
      <div className="aio-card">
        <div className="aio-lbl">Automation <button className="aio-link" onClick={onAutomation}>Change</button></div>
        <div className="aio-aut">{autonomy.map((a) => <div key={a.label}><span>{a.label}</span><span className={"aio-lv " + a.level}>{{ auto: "Automatic", approve: "Approval", off: "Off", never: "Never" }[a.level]}</span></div>)}</div>
      </div>
    </aside>
  );
}

// Incident register clean-up: preview what would be closed (duplicates of a
// newer open record, and records with no activity for N days), then close.

export function RegisterCleanup({ cluster, open, shown, canAdmin, onDone }) {
  const [openPanel, setOpenPanel] = useState(false);
  const [days, setDays] = useState(7);
  const [dup, setDup] = useState(true);
  const [all, setAll] = useState(false);
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const q = (d = days, du = dup, a = all) => `/api/incidents/cleanup?olderThanDays=${d}&duplicates=${du}${a ? "&cluster=all" : ""}`;
  const preview = async (d = days, du = dup, a = all) => {
    setBusy(true); setErr(null); setDone(null);
    try {
      const r = await fetch(a ? q(d, du, a) : clusterUrl(q(d, du, a), cluster), { credentials: "same-origin", headers: { Accept: "application/json" } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Preview failed (${r.status})`);
      setPv(j);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const run = async () => {
    if (!pv?.toClose) return;
    if (!window.confirm(`Close ${pv.toClose.toLocaleString()} incident records${all ? " on every cluster" : ""}?\n\n${pv.duplicates} duplicates of a newer open record and ${pv.stale} with no activity for ${days}+ days. ${pv.keep.toLocaleString()} stay open.\n\nThe records are kept as closed, with a note; ServiceNow is not changed.`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(all ? q() : clusterUrl(q(), cluster), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ olderThanDays: days, duplicates: dup, ...(all ? { cluster: "all" } : {}) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Clean-up failed (${r.status})`);
      setDone(j); setPv(null); onDone?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="aio-note aio-clean">
      <div className="aio-clean-h">
        <span>Showing the newest {shown} of <b>{Number(open || 0).toLocaleString()}</b> open incident records. Most old ones are duplicates or have had no activity for a long time.</span>
        <button className="aio-btn" onClick={() => { setOpenPanel((v) => !v); if (!pv) preview(); }}>{openPanel ? "Hide clean-up" : "Clean up the register…"}</button>
      </div>
      {openPanel && (
        <div className="aio-clean-b">
          <div className="aio-clean-opts">
            <label>Close records with no activity for
              <select value={days} onChange={(e) => { const d = Number(e.target.value); setDays(d); preview(d); }}>{[3, 7, 14, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
            </label>
            <label><input type="checkbox" checked={dup} onChange={(e) => { setDup(e.target.checked); preview(days, e.target.checked); }} /> and duplicates of a newer open record (the newest stays open)</label>
            <label><input type="checkbox" checked={all} onChange={(e) => { setAll(e.target.checked); preview(days, dup, e.target.checked); }} /> every cluster</label>
          </div>
          {err && <div className="aio-err">{err}</div>}
          {busy && !pv && <div className="aio-muted">Reading the register…</div>}
          {pv && (<>
            <p className="aio-clean-sum"><b>{pv.toClose.toLocaleString()}</b> of {pv.open.toLocaleString()} open records would be closed: {pv.duplicates.toLocaleString()} duplicates, {pv.stale.toLocaleString()} with no activity for {days}+ days. <b>{pv.keep.toLocaleString()}</b> stay open.</p>
            {pv.groups.length > 0 && (
              <table className="aio-clean-t">
                <thead><tr><th>Raised by</th><th>Title</th><th>Records</th><th>Duplicates</th><th>Inactive</th><th>From – to</th></tr></thead>
                <tbody>{pv.groups.slice(0, 8).map((g, i) => <tr key={i}><td>{g.source}</td><td>{g.title}</td><td><b>{g.count}</b></td><td>{g.duplicates}</td><td>{g.stale}</td><td>{String(g.oldest).slice(0, 10)} – {String(g.newest).slice(0, 10)}</td></tr>)}</tbody>
              </table>
            )}
            <div className="aio-clean-a">
              <button className="aio-btn primary" disabled={!canAdmin || busy || !pv.toClose} title={canAdmin ? "" : "Needs the Admin role"} onClick={run}>{busy ? "Closing…" : `Close ${pv.toClose.toLocaleString()} records`}</button>
              <span className="aio-muted">Records are kept as closed with a note and a timeline entry, and recorded in the audit trail. ServiceNow tickets are not changed. Closed records older than 90 days are removed by the normal retention.</span>
            </div>
          </>)}
          {done && <p className="aio-ok">Closed {done.closed.toLocaleString()} records ({done.duplicates} duplicates, {done.stale} inactive). {done.keptOpen.toLocaleString()} remain open.</p>}
        </div>
      )}
    </div>
  );
}
