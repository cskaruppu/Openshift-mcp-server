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
