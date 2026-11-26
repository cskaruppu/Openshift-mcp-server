import { useState } from "react";

// User & Access → Access insights (services/access-insights.js): what people
// have versus what they use, with suggestions that become normal requests,
// a risk score per identity, and session alerts. And Guardrails: the rules
// applied to every access request.

const KIND = { disable: ["Disable", "dis"], remove: ["Remove role", "rm"], downgrade: ["Downgrade", "dn"], narrow: ["Narrow scope", "sc"], temporary: ["Make temporary", "jit"], reduce: ["Reduce", "sa"], peer: ["Review", "rm"], mover: ["Moved team", "sc"], joiner: ["New joiner", "jit"] };
const FILTERS = [["", "All"], ["disable", "Disable"], ["remove", "Remove"], ["downgrade", "Downgrade"], ["narrow", "Narrow"], ["temporary", "Temporary"], ["reduce", "Service accounts"], ["peer", "Peers"]];
const ACTION = { "end-sessions": "End sessions", "remove-kubeadmin": "Request kubeadmin removal", ask: "Ask: was this you?", incident: "Open ServiceNow incident", disable: "Request disable" };
const when = (iso) => (iso ? String(iso).replace("T", " ").slice(0, 16) : "");

export function InsightsTab({ ins, label, canApprove, busy, onRaise, onDismiss, onAlert, onOpenPerson, onRefresh, clustersParam }) {
  const [kf, setKf] = useState("");
  const [showAll, setShowAll] = useState(false);
  if (!ins) return <div className="vgf-empty">Reading logins, roles{` and the audit log`}…</div>;
  const k = ins.kpis;
  const list = ins.suggestions.filter((s) => !kf || s.kind === kf);
  const count = (id) => ins.suggestions.filter((s) => s.kind === id).length;
  const open = ins.alerts.filter((a) => !["closed", "confirmed"].includes(a.status));
  return (
    <div className="ai-wrap">
      <div className="ai-src">
        {ins.audit ? <><span className="ai-dot ok" />Audit log: {ins.audit.source} · {ins.audit.clusters.length} cluster{ins.audit.clusters.length === 1 ? "" : "s"} · last {ins.audit.days} days{ins.audit.error ? ` · last read failed: ${ins.audit.error}` : ""}</>
          : ins.auditError ? <><span className="ai-dot crit" />Audit log not readable: {ins.auditError}</>
            : <><span className="ai-dot warn" />Audit log not connected: suggestions come from logins and roles only. Set ACCESS_AUDIT_SOURCE to compare what people have with what they use.</>}
        {ins.watching?.since && <span className="vc-muted"> · watching logins since {String(ins.watching.since).slice(0, 10)}</span>}
        <span className="ai-src-r">
          <button className="vc-btn ghost sm" onClick={() => onRefresh(true)}>Refresh</button>
          <a className="vc-btn sm" href={`/api/user-access/insights/evidence.txt?clusters=${encodeURIComponent(clustersParam)}`}>Export evidence</a>
        </span>
      </div>

      <div className="ua-kpis ai-kpis">
        <div className="ua-kpi"><b>{k.identities}</b><span>people and accounts · {k.people} people, {k.serviceAccounts} privileged service accounts</span></div>
        <div className={"ua-kpi" + (k.highRisk ? " crit" : "")}><b>{k.highRisk}</b><span>high-risk identities (score 67+)</span></div>
        <div className={"ua-kpi" + (k.suggestions ? " warn" : "")}><b>{k.suggestions}</b><span>suggestions open · would remove {k.grantsRemoved} grant{k.grantsRemoved === 1 ? "" : "s"}</span></div>
        <div className={"ua-kpi" + (k.unusedPct > 20 ? " warn" : "")}><b>{k.unusedPct}%</b><span>unused access · {k.unusedBasis}</span></div>
        <div className={"ua-kpi" + (k.standingPct > 50 ? " warn" : "")}><b>{k.standingPct}%</b><span>standing admin · {k.privileged} privileged grants · goal 0%</span></div>
        <div className="ua-kpi ok"><b>{k.avgRisk} → {k.avgRiskAfter}</b><span>average risk if all suggestions are applied</span></div>
      </div>

      <div className="ai-grid">
        <div className="vc-card">
          <div className="vgf-label">Suggestions <span className="ai-chips">
            {FILTERS.filter(([id]) => !id || count(id)).map(([id, l]) => <button key={id} className={"ai-chip" + (kf === id ? " on" : "")} onClick={() => setKf(id)}>{l} {id ? count(id) : ins.suggestions.length}</button>)}
          </span></div>
          <div className="ai-tw">
            <table className="ua-t ai-t">
              <thead><tr><th style={{ width: "15%" }}>Who</th><th style={{ width: "18%" }}>Suggestion</th><th>Why (evidence)</th><th style={{ width: "11%" }}>Cluster</th><th style={{ width: "6%" }}>Risk</th><th style={{ width: "19%" }} /></tr></thead>
              <tbody>
                {(showAll ? list : list.slice(0, 25)).map((s) => (
                  <tr key={s.id}>
                    <td>{s.kind === "reduce" ? <b>{s.user}</b> : <button className="ua-name" onClick={() => onOpenPerson(s.user)}>{s.user}</button>}<div className="vc-muted ua-small">{s.kind === "reduce" ? "service account" : s.confidence === "review" ? "worth a review" : ""}</div></td>
                    <td><span className={"ai-act " + (KIND[s.kind]?.[1] || "rm")}>{KIND[s.kind]?.[0] || s.kind}</span><div className="vc-muted ua-small">{s.title}</div></td>
                    <td>{s.why}<div className="ai-ev">{s.evidence.map((e, i) => <i key={i}>{e}</i>)}</div>{s.manual && <div className="ua-small ua-flag warn">{s.manual}</div>}</td>
                    <td className="ua-small">{s.clusters.length > 2 ? `${s.clusters.length} clusters` : s.clusters.map(label).join(", ")}</td>
                    <td className="ai-red">{s.delta ? `−${s.delta}` : ""}</td>
                    <td><div className="ai-btns">
                      {s.requests.length > 0 && <button className="vc-btn primary sm" disabled={!!busy} onClick={() => onRaise(s)} title={s.requests.map((r) => r.kind).join(" + ")}>{busy === s.id ? "Raising…" : s.requests.length > 1 ? `Raise ${s.requests.length} requests` : "Raise request"}</button>}
                      <button className="vc-btn ghost sm" disabled={!!busy} onClick={() => onDismiss(s)}>Dismiss…</button>
                    </div></td>
                  </tr>
                ))}
                {!list.length && <tr><td colSpan={6} className="vc-muted">Nothing to suggest{ins.audit ? "." : " from logins and roles. Connect the audit log for suggestions from what people actually do."}</td></tr>}
              </tbody>
            </table>
          </div>
          {list.length > 25 && !showAll && <button className="ua-link" onClick={() => setShowAll(true)}>Show all {list.length}</button>}
          <p className="ua-hint">The agent only suggests. Each button raises a normal request, checked by the guardrails and approved here or in ServiceNow. A dismissal needs a reason, goes into the evidence and comes back after 90 days.</p>
        </div>

        <div className="ai-side">
          {open.slice(0, 4).map((a) => (
            <div key={a.id} className={"ai-alert " + a.level}>
              <h4><span className={"ai-tag " + (a.level === "crit" ? "r" : "y")}>{a.level === "crit" ? "SECURITY ALERT" : "SESSION ALERT"}</span> {a.title}</h4>
              <p>{a.text}{a.status !== "open" ? ` · ${a.status}${a.statusBy ? ` by ${a.statusBy}` : ""}` : ""}{a.ticket ? ` · ${a.ticket}` : ""}</p>
              {a.facts.length > 0 && <ul>{a.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>}
              <div className="ai-btns ai-btns-l">
                {canApprove && a.actions.map((x) => <button key={x} className={"vc-btn sm" + (x === a.actions[0] ? " primary" : "")} disabled={!!busy} onClick={() => onAlert(a, x)}>{ACTION[x] || x}</button>)}
                <button className="vc-btn ghost sm" disabled={!!busy} onClick={() => onAlert(a, "confirmed")}>It was me / expected</button>
                <button className="vc-btn ghost sm" disabled={!!busy} onClick={() => onAlert(a, "notme")}>Not recognised</button>
              </div>
            </div>
          ))}
          {open.length > 4 && <p className="ua-hint">{open.length - 4} more alert{open.length - 4 > 1 ? "s" : ""}; deal with the ones above first.</p>}
          {!open.length && <div className="vc-card ai-calm"><b>No open session alerts.</b><p className="vc-muted ua-small">kubeadmin and break-glass logins, bulk secret reads, shells in production pods, role bindings made by hand, failed logins, unusual hours and first logins on a cluster are watched{ins.audit ? "" : " (the last five need the audit log)"}.</p></div>}

          <div className="vc-card">
            <div className="vgf-label">Riskiest identities <span>0–100</span></div>
            <div className="ai-rk">
              {ins.identities.slice(0, 8).map((i) => (
                <div key={`${i.kind}${i.name}${i.cluster || ""}`} className="ai-rr">
                  <b title={i.kind}>{i.name}</b>
                  <div className="ai-bar"><i className={i.score >= 67 ? "crit" : i.score >= 34 ? "warn" : "ok"} style={{ width: `${i.score}%` }} /></div>
                  <span className="ai-s">{i.score}</span>
                  <span className="ai-why">{i.kind !== "person" ? `${i.kind} · ` : ""}{i.why}</span>
                </div>
              ))}
              {!ins.identities.length && <span className="vc-muted">No identities with roles.</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GuardrailsTab({ ins, canApprove, busy, onToggle }) {
  if (!ins) return <div className="vgf-empty">Loading guardrails…</div>;
  return (
    <div className="ai-wrap">
      <div className="vc-card">
        <div className="vgf-label">Guardrails applied to every access request <span>checked when the request is made, before anyone approves it</span></div>
        <div className="ai-pol">
          {ins.policies.map((p) => (
            <div key={p.id} className={"ai-pc" + (p.enabled ? "" : " off")}>
              <b>{p.label}
                <label className="ai-tgl" title={canApprove ? "" : "Admins change guardrails"}>
                  <input type="checkbox" checked={p.enabled} disabled={!canApprove || !!busy} onChange={(e) => onToggle(p.id, e.target.checked)} aria-label={p.label} /><span />
                </label>
              </b>
              <span>{p.text}</span>
              <em className={p.effect === "block" ? "blk" : p.effect === "auto" ? "auto" : "apr"}>{{ block: "BLOCK", approval: "MORE APPROVAL", flag: "FLAG", auto: "AUTOMATIC", require: "REQUIRED" }[p.effect]} · {p.count} in 30 days</em>
              <small>{p.controlRefs.slice(0, 2).join(" · ")}</small>
            </div>
          ))}
        </div>
        <p className="ua-hint">A blocked request is held: it can be changed to an alternative the guardrail offers, get its ticket number, or be overridden by an Admin with a reason (it then needs two approvers). Every decision is in the audit trail and the evidence export.</p>
      </div>
      <div className="vc-card">
        <div className="vgf-label">HR feed <span>joiners, movers and leavers</span></div>
        {ins.hrConfigured
          ? ins.hr ? <p className="ua-small">Read {String(ins.hr.at).slice(0, 16).replace("T", " ")}: {ins.hr.leavers} leaver{ins.hr.leavers === 1 ? "" : "s"}, {ins.hr.movers} mover{ins.hr.movers === 1 ? "" : "s"}, {ins.hr.joiners} joiner{ins.hr.joiners === 1 ? "" : "s"} · {ins.hr.processed} leaver{ins.hr.processed === 1 ? "" : "s"} disabled so far.</p> : <p className="ua-small vc-muted">Configured; first read within 6 hours.</p>
          : <p className="ua-small vc-muted">Not connected. Set ACCESS_HR_FEED_URL to a JSON or CSV export (user, status, team, previous team, date) from ServiceNow HR, Workday or your directory: leavers are disabled on every cluster the same day, movers and joiners become suggestions.</p>}
      </div>
      <div className="vc-card">
        <div className="vgf-label">Standards these controls support</div>
        <div className="ai-ctl">
          {Object.entries(ins.controls || {}).map(([k, v]) => <div key={k}><b>{{ "least-privilege": "Least privilege", inactive: "Inactive accounts", privileged: "Privileged access", review: "Access reviews", sod: "Separation of duties", monitoring: "Monitoring", jml: "Joiners, movers, leavers", emergency: "Emergency accounts", "service-accounts": "Service accounts" }[k] || k}</b><span>{v.join(" · ")}</span></div>)}
        </div>
      </div>
    </div>
  );
}
