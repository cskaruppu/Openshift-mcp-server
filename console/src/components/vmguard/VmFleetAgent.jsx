import { useState, useEffect, useCallback, useMemo } from "react";
import { clusterUrl } from "../../api/client";
import { showToast } from "../../store/toastStore";
import { SevBar, Kpi } from "../vuln/VulnParts";
import { Tier, Factors, ChangeTag, VmDetail, rel } from "./VmGuard";

// Automation Hub → VM Security Agent: every OpenShift Virtualization VM on every
// cluster in one place. Each cluster answers GET /api/vm-guard through the
// platform's usual routing (its spoke agent, direct access or the bridge), so
// this view adds no new path to a cluster: it asks each one and puts the
// answers side by side. A cluster that does not answer is shown as such, never
// as "0 VMs".

const RANK = { "fix-now": 0, "fix-soon": 1, plan: 2, monitor: 3, hygiene: 4 };
const PRIORITIES = [["", "All priorities"], ["fix-now", "Fix now"], ["fix-soon", "Fix soon"], ["plan", "Plan"], ["monitor", "Monitor"], ["hygiene", "Not scanned"]];

async function readCluster(c) {
  try {
    const r = await fetch(clusterUrl("/api/vm-guard", c), { headers: { "X-Cluster-Context": c || "local", Accept: "application/json" }, credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { cluster: c, error: j.error || `HTTP ${r.status}` };
    return { cluster: c, ...j };
  } catch (e) { return { cluster: c, error: e.message }; }
}

export default function VmFleetAgent({ clusters = [] }) {
  const [res, setRes] = useState(null);
  const [labels, setLabels] = useState({});
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState("vms");
  const [fCluster, setFCluster] = useState("");
  const [fPrio, setFPrio] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null);   // { cluster, key }
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    if (!clusters.length) return;
    setLoading(true);
    const out = await Promise.all(clusters.map(readCluster));
    // "local" on a hub whose own cluster also has an agent is the same cluster
    // twice; keep the named one.
    const sig = (r) => (r.available ? `${r.readAt}|${r.vms.map((v) => v.key).join(",")}` : null);
    const named = new Set(out.filter((r) => r.cluster !== "local").map(sig).filter(Boolean));
    setRes(out.filter((r) => !(r.cluster === "local" && sig(r) && named.has(sig(r)))));
    setLoading(false);
  }, [clusters]);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { fetch("/api/cluster-labels").then((r) => r.json()).then((j) => setLabels(j.labels || {})).catch(() => {}); }, []);
  const label = (c) => (c === "local" ? labels.local || "This cluster" : labels[c] || c);

  const live = (res || []).filter((r) => r.available);
  const vms = useMemo(() => live.flatMap((r) => r.vms.map((v) => ({ ...v, cluster: r.cluster, scanEnabled: r.scan?.enabled, admin: !!r.you?.canManage })))
    .sort((a, b) => (RANK[a.tier] ?? 5) - (RANK[b.tier] ?? 5) || b.score - a.score || a.name.localeCompare(b.name)), [res]); // eslint-disable-line react-hooks/exhaustive-deps
  const changes = useMemo(() => live.flatMap((r) => r.changes.map((c) => ({ ...c, cluster: r.cluster })))
    .sort((a, b) => String(b.at).localeCompare(String(a.at))), [res]); // eslint-disable-line react-hooks/exhaustive-deps
  const match = (v) => (!fCluster || v.cluster === fCluster) && (!fPrio || v.tier === fPrio)
    && (!q || `${v.name} ${v.namespace} ${v.os || ""}`.toLowerCase().includes(q.toLowerCase()));
  const shownVms = vms.filter(match);
  const shownChanges = changes.filter((c) => (!fCluster || c.cluster === fCluster) && (!q || `${c.vm} ${c.namespace} ${c.label}`.toLowerCase().includes(q.toLowerCase())));
  const sum = (f) => live.reduce((n, r) => n + f(r), 0);
  const vm = sel ? vms.find((v) => v.cluster === sel.cluster && v.key === sel.key) : null;

  const act = useCallback(async (path, body, ok, cluster) => {
    setBusy(path);
    try {
      const url = path === "ticket" ? "/api/vm-guard/ticket" : clusterUrl(`/api/vm-guard/${path}`, cluster);
      const headers = { "Content-Type": "application/json", ...(path === "ticket" ? {} : { "X-Cluster-Context": cluster || "local" }) };
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      showToast(typeof ok === "function" ? ok(j) : ok, "ok");
      load();
    } catch (e) { showToast(e.message, "err"); } finally { setBusy(""); }
  }, [load]);

  if (!res) return <div className="vgf-empty">{clusters.length ? "Asking every cluster for its virtual machines…" : "No clusters connected yet."}</div>;

  return (
    <div className="vgf">
      <div className="vgf-intro">
        <div>
          <h3>Every virtual machine, every cluster</h3>
          <p>Agentless: configuration changes against an approved baseline, guest OS and end of life, exposure, and package CVEs where disk scanning is on. Each cluster is read through its own agent.</p>
        </div>
        <button className="vc-btn" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>

      <div className="vc-kpis">
        <Kpi label="Virtual machines" value={sum((r) => r.totals.vms)} sub={`${sum((r) => r.totals.running)} running · ${live.length} cluster${live.length === 1 ? "" : "s"}`} />
        <Kpi label="Fix now" value={sum((r) => r.totals.fixNow)} sub="VMs" tone="var(--vc-t-fix-now)" onClick={() => { setFPrio("fix-now"); setView("vms"); }} active={fPrio === "fix-now"} />
        <Kpi label="Known exploited" value={sum((r) => r.totals.scanned) ? new Set(vms.flatMap((v) => v.vulns.filter((x) => x.kev).map((x) => x.id))).size : "—"} sub={sum((r) => r.totals.scanned) ? "unique CVEs in CISA KEV" : "needs disk scans"} tone="var(--vc-crit)" />
        <Kpi label="End of life OS" value={sum((r) => r.totals.eol)} sub="VMs" tone={sum((r) => r.totals.eol) ? "var(--vc-high)" : undefined} />
        <Kpi label="Off baseline" value={sum((r) => r.totals.offBaseline)} sub={`${sum((r) => r.totals.restartRequired)} waiting for restart`} tone={sum((r) => r.totals.offBaseline) ? "var(--vc-high)" : undefined} />
        <Kpi label="Disk-scanned" value={`${sum((r) => r.totals.scanned)}/${sum((r) => r.totals.vms)}`} sub="VMs" />
      </div>

      <section className="vgf-clusters">
        <div className="vgf-label">By cluster<span>click a row to show only that cluster</span></div>
        <div className="vc-tablewrap">
          <table className="vc-table compact">
            <thead><tr><th>Cluster</th><th>VMs</th><th>Running</th><th>Fix now</th><th>End of life</th><th>Off baseline</th><th>Changes, 7 days</th><th>Disk scan</th><th>Read</th></tr></thead>
            <tbody>
              {res.map((r) => (
                <tr key={r.cluster} className={fCluster === r.cluster ? "sel" : ""} onClick={() => r.available && setFCluster(fCluster === r.cluster ? "" : r.cluster)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" && r.available) setFCluster(fCluster === r.cluster ? "" : r.cluster); }}>
                  <td><b>{label(r.cluster)}</b>{label(r.cluster) !== r.cluster && <div className="vc-muted">{r.cluster}</div>}</td>
                  {r.available ? (<>
                    <td>{r.totals.vms}</td><td>{r.totals.running}</td>
                    <td style={r.totals.fixNow ? { color: "var(--vc-crit)", fontWeight: 700 } : undefined}>{r.totals.fixNow}</td>
                    <td style={r.totals.eol ? { color: "var(--vc-high)", fontWeight: 700 } : undefined}>{r.totals.eol}</td>
                    <td style={r.totals.offBaseline ? { color: "var(--vc-high)", fontWeight: 700 } : undefined}>{r.totals.offBaseline}</td>
                    <td>{r.changeTotals.week}</td>
                    <td>{r.scan.enabled ? `${r.totals.scanned}/${r.totals.vms}` : <span className="vc-muted">off</span>}</td>
                    <td className="vc-muted">{rel(r.readAt)}</td>
                  </>) : (
                    <td colSpan={8} className="vc-muted">{r.error ? `Not answering: ${r.error}` : r.reason || "OpenShift Virtualization not found"}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="vgf-bar">
        <div className="vc-tabs sm" role="tablist">
          {[["vms", "Virtual machines", shownVms.length], ["changes", "Configuration changes", shownChanges.length]].map(([k, l, n]) => (
            <button key={k} role="tab" aria-selected={view === k} className={"vc-tab" + (view === k ? " on" : "")} onClick={() => setView(k)}>{l}<span className="vc-tab-n">{n}</span></button>
          ))}
        </div>
        <div className="vgf-filters">
          <select value={fCluster} onChange={(e) => setFCluster(e.target.value)} aria-label="Cluster"><option value="">All clusters</option>{live.map((r) => <option key={r.cluster} value={r.cluster}>{label(r.cluster)}</option>)}</select>
          {view === "vms" && <select value={fPrio} onChange={(e) => setFPrio(e.target.value)} aria-label="Priority">{PRIORITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="VM, namespace or OS" aria-label="Search" />
        </div>
      </div>

      {view === "vms" && (
        <div className="vc-tablewrap">
          <table className="vc-table">
            <thead><tr><th>Priority</th><th>Virtual machine</th><th>Cluster</th><th>Operating system</th><th>Risk factors</th><th>Severity  C · H · M · L</th><th>Size</th><th>State</th></tr></thead>
            <tbody>
              {!shownVms.length && <tr><td colSpan={8} className="vc-empty">{vms.length ? "No VM matches these filters." : "No virtual machines found on the connected clusters."}</td></tr>}
              {shownVms.map((v) => (
                <tr key={v.cluster + v.key} className={sel?.cluster === v.cluster && sel?.key === v.key ? "sel" : ""} onClick={() => setSel({ cluster: v.cluster, key: v.key })} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") setSel({ cluster: v.cluster, key: v.key }); }}>
                  <td><Tier v={v} /></td>
                  <td><b>{v.name}</b><div className="vc-muted">{v.namespace}</div></td>
                  <td>{label(v.cluster)}</td>
                  <td>{v.os || <span className="vc-muted">not reported</span>}</td>
                  <td><Factors factors={v.factors} /></td>
                  <td>{v.scan?.status === "done" ? <SevBar c={v.sev.critical} h={v.sev.high} m={v.sev.medium} l={v.sev.low} width={80} /> : <span className="vc-muted">{v.scan ? v.scan.status : "not scanned"}</span>}</td>
                  <td className="vc-muted">{v.vcpus} vCPU · {v.memory || "—"}</td>
                  <td>{v.state}{v.restartRequired && <div className="vc-warn">restart required</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === "changes" && (
        <div className="vc-tablewrap">
          <table className="vc-table">
            <thead><tr><th>When</th><th>Virtual machine</th><th>Cluster</th><th>Change</th><th>Before</th><th>After</th><th>By (tool)</th><th></th></tr></thead>
            <tbody>
              {!shownChanges.length && <tr><td colSpan={8} className="vc-empty">No configuration change recorded yet.</td></tr>}
              {shownChanges.slice(0, 300).map((c, i) => (
                <tr key={i}>
                  <td className="vc-muted" title={c.at}>{rel(c.at)}</td>
                  <td><b>{c.vm}</b><div className="vc-muted">{c.namespace}</div></td>
                  <td>{label(c.cluster)}</td>
                  <td>{c.label}{c.weakens && <div className="vc-warn">{c.weakens}</div>}</td>
                  <td className="vc-muted vg-mono">{c.before}</td>
                  <td className="vg-mono">{c.after}</td>
                  <td className="vc-muted">{c.tool || "—"}</td>
                  <td><ChangeTag c={c} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {vm && (
        <VmDetail vm={vm} cluster={label(vm.cluster)} scanEnabled={vm.scanEnabled} admin={vm.admin} busy={busy}
          act={(path, body, ok) => act(path, body, ok, vm.cluster)} onClose={() => setSel(null)}
          extra={vm.tier !== "monitor" && (
            <button className="vc-btn ghost" disabled={!!busy} title="One open ServiceNow incident per VM; asking again shows the open one"
              onClick={() => act("ticket", { cluster: vm.cluster, namespace: vm.namespace, name: vm.name, priority: vm.tier, summary: vm.factors.map((f) => f.label).join(", ") || vm.tierLabel,
                findings: [...vm.factors.map((f) => `${f.label}: ${f.detail || ""}`), ...vm.offBaseline.map((d) => `${d.label}: ${d.before} → ${d.after}`), ...vm.vulns.filter((x) => x.kev || x.severity === "critical").slice(0, 8).map((x) => `${x.id} (${x.severity}${x.kev ? ", known exploited" : ""}) in ${x.pkg}${x.fix ? `, fixed in ${x.fix}` : ""}`)],
                fix: vm.fix }, (j) => (j.existing ? `${j.number} is already open for ${vm.name}` : `${j.number || "Incident"} raised for ${vm.name}`), vm.cluster)}>
              Raise ServiceNow ticket
            </button>
          )} />
      )}
    </div>
  );
}
