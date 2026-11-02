import { useState, useEffect, useCallback } from "react";
import { useClusterQuery, REFRESH } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";
import { clusterUrl } from "../../api/client";
import { showToast } from "../../store/toastStore";
import { TierBadge, SevBar, Kpi } from "../vuln/VulnParts";

// VM Guard — OpenShift Virtualization VMs, watched without an agent
// (services/vm-guard.js): configuration changes against an approved baseline,
// guest OS and end of life, and package CVEs from an optional disk scan.
// Two dashboard cards and the VM Guard window they open. A VM never scanned
// says "Not scanned", never "0 CVEs".

export function useVmGuard() {
  return useClusterQuery("/api/vm-guard", { refetchInterval: REFRESH.STANDARD });
}

export const rel = (iso) => {
  if (!iso) return "—";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const FACTOR_CLASS = { kev: "vc-f-kev", exposed: "vc-f-exposed", eol: "vc-f-epss", epss: "vc-f-epss", baseline: "vc-f-privileged", unscanned: "vc-f-not-running" };

export function Tier({ v }) {
  if (v.tier === "hygiene") {
    return <span className="vc-tier vc-tier-sm" style={{ "--t": "var(--vc-t-hygiene)" }} title={v.scan?.error || ""}><span className="vc-tier-dot" />{v.tierLabel}</span>;
  }
  return <TierBadge tier={v.tier} size="sm" />;
}

export function Factors({ factors = [], max = 3 }) {
  return (
    <span className="vc-factors">
      {factors.slice(0, max).map((f) => <span key={f.key} className={"vc-factor " + (FACTOR_CLASS[f.key] || "")} title={f.detail}>{f.label}</span>)}
    </span>
  );
}

export function ChangeTag({ c }) {
  if (c.weakens) return <span className="vc-tier vc-tier-sm" style={{ "--t": "var(--vc-crit)" }} title={c.weakens}><span className="vc-tier-dot" />Weakens</span>;
  const k = { exposure: ["Network", "var(--vc-high)"], security: ["Security", "var(--vc-high)"], size: ["Size", "var(--vc-t-plan)"], storage: ["Storage", "var(--vc-t-plan)"] }[c.kind] || ["Change", "var(--vc-t-monitor)"];
  return <span className="vc-tier vc-tier-sm" style={{ "--t": k[1] }}><span className="vc-tier-dot" />{k[0]}</span>;
}

/* ─────────────────────────── dashboard cards ─────────────────────────── */

export function VmVulnsWidget({ data, onOpen }) {
  const t = data.totals;
  const top = data.vms.slice(0, 4);
  return (
    <div className="vcw">
      <div className="vcw-head">
        <div><h3>VM Vulnerabilities</h3><span className="vcw-sub">Agentless · guest OS, end of life and disk-scan CVEs · CISA KEV + FIRST EPSS</span></div>
        <div className="vcw-actions"><button className="vc-btn primary sm" onClick={() => onOpen("vms")}>Open VM Guard <span aria-hidden="true">→</span></button></div>
      </div>
      <div className="vcw-kpis">
        <button className="vcw-kpi hot" style={{ "--k": "var(--vc-t-fix-now)" }} onClick={() => onOpen("vms")}><span>Fix now</span><b>{t.fixNow}</b><em>VMs</em></button>
        <div className="vcw-kpi" style={{ "--k": "var(--vc-crit)" }}><span>Known exploited</span><b>{t.scanned ? t.kev : "—"}</b><em>{t.scanned ? "CVEs in CISA KEV" : "needs a disk scan"}</em></div>
        <div className="vcw-kpi" style={t.eol ? { "--k": "var(--vc-high)" } : undefined}><span>End of life OS</span><b>{t.eol}</b><em>VMs</em></div>
        <div className="vcw-kpi" style={t.scanned < t.vms ? { "--k": "var(--vc-high)" } : undefined}><span>Disk-scanned</span><b>{t.scanned}/{t.vms}</b><em>{data.scan.enabled ? (data.scan.running ? `${data.scan.running} scanning now` : "VMs") : "scanning off"}</em></div>
      </div>
      {t.scanned > 0 ? (
        <div className="vcw-mid"><div className="vcw-sev" style={{ flex: 1 }}>
          <div className="vcw-label">All findings · {t.scanned} scanned VMs</div>
          <SevBar c={t.sev.critical} h={t.sev.high} m={t.sev.medium} l={t.sev.low} width={220} />
          <div className="vcw-sevkey"><span>Critical</span><span>High</span><span>Medium</span><span>Low</span></div>
        </div></div>
      ) : (
        <div className="vcw-state">{data.scan.enabled ? "No VM disk has been scanned yet. Open VM Guard and press Scan." : "Package CVEs need a disk scan, which is off. Guest OS and end-of-life are shown without it."}</div>
      )}
      <div className="vcw-list">
        <div className="vcw-label">Fix first<span>ranked by known exploitation, exposure and end of life</span></div>
        {top.map((v) => (
          <button key={v.key} className="vcw-row" onClick={() => onOpen("vms", v.key)}>
            <Tier v={v} />
            <span className="vc-img"><span className="vc-img-name">{v.name}</span><span className="vc-img-path">{v.namespace} · {v.os || "OS not reported"}</span></span>
            <Factors factors={v.factors} max={2} />
            {v.scan?.status === "done" ? <SevBar c={v.sev.critical} h={v.sev.high} m={v.sev.medium} l={v.sev.low} width={56} /> : <span className="vc-muted" style={{ fontSize: "0.72rem" }}>—</span>}
            <span className="vcw-chev" aria-hidden="true">›</span>
          </button>
        ))}
      </div>
      <div className="vcw-foot"><span className="vcw-dot live" /><b>VM Guard</b> · {t.vms} VMs · {t.running} running<span className="vcw-sep">·</span>read {rel(data.readAt)}</div>
    </div>
  );
}

export function VmChangesWidget({ data, onOpen }) {
  const t = data.totals, ct = data.changeTotals;
  return (
    <div className="vcw">
      <div className="vcw-head">
        <div><h3>VM Configuration Changes</h3><span className="vcw-sub">CPU, memory, disks, networks and security settings · against each VM’s approved baseline</span></div>
        <div className="vcw-actions"><button className="vc-btn primary sm" onClick={() => onOpen("changes")}>View all <span aria-hidden="true">→</span></button></div>
      </div>
      <div className="vcw-kpis">
        <div className="vcw-kpi"><span>Changes, 7 days</span><b>{ct.week}</b><em>in {ct.weekVms} VMs</em></div>
        <button className="vcw-kpi hot" style={{ "--k": "var(--vc-crit)" }} onClick={() => onOpen("vms")}><span>Off baseline</span><b>{t.offBaseline}</b><em>need review</em></button>
        <div className="vcw-kpi" style={t.restartRequired ? { "--k": "var(--vc-med)" } : undefined}><span>Waiting for restart</span><b>{t.restartRequired}</b><em>saved, not applied</em></div>
        <div className="vcw-kpi" style={ct.weakening ? { "--k": "var(--vc-crit)" } : undefined}><span>Weakening</span><b>{ct.weakening}</b><em>Secure Boot, TPM, networks</em></div>
      </div>
      <div className="vcw-list">
        <div className="vcw-label">Latest changes<span>read from the VirtualMachine definitions</span></div>
        {!data.changes.length && <div className="vcw-state">No change since VM Guard started watching. Baselines were taken from each VM as first seen.</div>}
        {data.changes.slice(0, 4).map((c, i) => (
          <button key={i} className="vcw-row" onClick={() => onOpen("changes")}>
            <ChangeTag c={c} />
            <span className="vc-img"><span className="vc-img-name">{c.vm}</span><span className="vc-img-path">{c.label}: {c.before} → {c.after}</span></span>
            <span className="vc-factors">{c.tool && <span className="vc-factor">{c.tool}</span>}</span>
            <span className="vc-muted" style={{ fontSize: "0.72rem", whiteSpace: "nowrap" }}>{rel(c.at)}</span>
            <span className="vcw-chev" aria-hidden="true">›</span>
          </button>
        ))}
      </div>
      <div className="vcw-foot"><span className="vcw-dot live" />Watching <b>{t.vms}</b> VirtualMachines<span className="vcw-sep">·</span>who changed it: the tool that wrote the VM (user names need the audit log)</div>
    </div>
  );
}

/* ─────────────────────────── the VM Guard window ─────────────────────────── */

export function VmGuardCenter({ open, onClose, data, tab: tab0 = "vms", focus = null, refetch }) {
  const cluster = useActiveCluster();
  const [tab, setTab] = useState(tab0);
  const [sel, setSel] = useState(focus);
  const [busy, setBusy] = useState("");
  useEffect(() => { if (open) { setTab(tab0); setSel(focus); } }, [open, tab0, focus]);
  useEffect(() => {
    if (!open) return undefined;
    const k = (e) => { if (e.key === "Escape") { if (sel) setSel(null); else onClose(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, sel, onClose]);
  const act = useCallback(async (path, body, ok) => {
    setBusy(path);
    try {
      const r = await fetch(clusterUrl(`/api/vm-guard/${path}`, cluster), { method: "POST", headers: { "Content-Type": "application/json", "X-Cluster-Context": cluster || "local" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      showToast(typeof ok === "function" ? ok(j) : ok, "ok"); refetch?.();
    } catch (e) { showToast(e.message, "err"); } finally { setBusy(""); }
  }, [cluster, refetch]);
  if (!open || !data) return null;
  const t = data.totals, admin = !!data.you?.canManage;
  const vm = sel ? data.vms.find((v) => v.key === sel) : null;

  return (
    <div className="vc-overlay" style={{ display: "flex" }} onClick={onClose}>
      <div className="vc-shell max" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="VM Guard">
        <div className="ah-head vc-head">
          <div className="ah-lockup" style={{ flex: 1, minWidth: 0 }}>
            <span className="tcs-lock"><img className="tcs-lock-logo" src="/brand/tcs-logo-white.png" alt="Tata Consultancy Services" width="1000" height="238" /><span className="tcs-lock-rule" aria-hidden="true" /><span className="tcs-lock-name">TCS Agentic AI for Hybrid Infrastructure</span></span>
            <span className="ah-lockup-rule" aria-hidden="true" />
            <span className="ah-lockup-mod"><span className="ah-lockup-qual">Virtualization Security</span><span className="ah-lockup-module">VM Guard</span></span>
          </div>
          <div className="ah-winbtns">
            <button className="ah-winbtn close" onClick={onClose} title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" strokeWidth="1" /></svg></button>
          </div>
        </div>
        <div className="vc-body">
          <div className="vc-context">
            <div className="vc-context-left">
              <span className="vc-scope"><span className="vc-scope-dot" />{cluster && cluster !== "local" ? cluster : "Local cluster"}</span>
              <span className="vc-provenance"><b>Agentless</b> · VM definitions read {rel(data.readAt)} · guest OS from the guest agent · disk scan {data.scan.enabled ? <b>on</b> : <span className="vc-warn">off</span>}{data.scan.running ? ` · ${data.scan.running} scanning, ${data.scan.queued} queued` : ""}</span>
            </div>
            <div className="vc-context-right">
              {admin && data.scan.enabled && <button className="vc-btn" disabled={!!busy} onClick={() => act("scan", { namespace: "", name: "*" }, (j) => `${j.queued} VM${j.queued === 1 ? "" : "s"} queued for a disk scan`)}>Scan all VMs</button>}
            </div>
          </div>
          <div className="vc-kpis">
            <Kpi label="Fix now" value={t.fixNow} sub="VMs" tone="var(--vc-t-fix-now)" />
            <Kpi label="Critical" value={t.scanned ? t.sev.critical : "—"} sub={t.scanned ? `in ${t.vmsWith.critical} VMs` : "needs a disk scan"} tone="var(--vc-crit)" />
            <Kpi label="High" value={t.scanned ? t.sev.high : "—"} sub={t.scanned ? `in ${t.vmsWith.high} VMs` : "needs a disk scan"} tone="var(--vc-high)" />
            <Kpi label="End of life OS" value={t.eol} sub="VMs" tone={t.eol ? "var(--vc-high)" : undefined} />
            <Kpi label="Exposed" value={t.exposed} sub="LoadBalancer, NodePort, Route or bridged NIC" />
            <Kpi label="Off baseline" value={t.offBaseline} sub={`${t.restartRequired} waiting for restart`} tone={t.offBaseline ? "var(--vc-high)" : undefined} />
          </div>
          <div className="vc-tabs" role="tablist">
            {[["vms", "Virtual machines", t.vms], ["changes", "Configuration changes", data.changes.length]].map(([k, l, n]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={"vc-tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{l}<span className="vc-tab-n">{n}</span></button>
            ))}
          </div>

          {tab === "vms" && (
            <div className="vc-tablewrap">
              <table className="vc-table">
                <thead><tr><th>Priority</th><th>Virtual machine</th><th>Operating system</th><th>Risk factors</th><th>Severity  C · H · M · L</th><th>Size</th><th>State</th></tr></thead>
                <tbody>
                  {!data.vms.length && <tr><td colSpan={7} className="vc-empty">No VirtualMachines on this cluster.</td></tr>}
                  {data.vms.map((v) => (
                    <tr key={v.key} className={sel === v.key ? "sel" : ""} onClick={() => setSel(v.key)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setSel(v.key); }}>
                      <td><Tier v={v} /></td>
                      <td><b>{v.name}</b><div className="vc-muted">{v.namespace}</div></td>
                      <td>{v.os || <span className="vc-muted">not reported</span>}<div className="vc-muted">{v.osSource || ""}</div></td>
                      <td><Factors factors={v.factors} /></td>
                      <td>{v.scan?.status === "done" ? <SevBar c={v.sev.critical} h={v.sev.high} m={v.sev.medium} l={v.sev.low} width={90} /> : <span className="vc-muted">{v.scan?.status === "failed" ? "scan failed" : v.scan ? v.scan.status : "not scanned"}</span>}</td>
                      <td className="vc-muted">{v.vcpus} vCPU · {v.memory || "—"}</td>
                      <td>{v.state}{v.restartRequired && <div className="vc-warn">restart required</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === "changes" && (
            <div className="vc-tablewrap">
              <table className="vc-table">
                <thead><tr><th>When</th><th>Virtual machine</th><th>Change</th><th>Before</th><th>After</th><th>By (tool)</th><th></th></tr></thead>
                <tbody>
                  {!data.changes.length && <tr><td colSpan={7} className="vc-empty">No change since VM Guard started watching.</td></tr>}
                  {data.changes.map((c, i) => (
                    <tr key={i}>
                      <td className="vc-muted" title={c.at}>{rel(c.at)}</td>
                      <td><b>{c.vm}</b><div className="vc-muted">{c.namespace}</div></td>
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
        </div>

        {vm && <VmDetail vm={vm} scanEnabled={data.scan.enabled} admin={admin} busy={busy} act={act} onClose={() => setSel(null)} />}
      </div>
    </div>
  );
}

/** One VM in full: risk factors, end of life, exposure, baseline drift, findings, fix command and actions.
    `act(path, body, okMessage)` posts to that VM's cluster; `extra` adds buttons (the fleet view's ticket). */
export function VmDetail({ vm, scanEnabled, admin, busy, act, onClose, cluster = null, extra = null }) {
  return (
    <aside className="vg-detail" role="dialog" aria-label={`${vm.name} details`}>
      <header>
        <div><h3>{vm.name}</h3><span className="vc-muted">{cluster ? `${cluster} · ` : ""}{vm.namespace} · {vm.os || "OS not reported"}{vm.kernel ? ` · kernel ${vm.kernel}` : ""}</span></div>
        <button className="ah-winbtn" onClick={onClose} aria-label="Close details">✕</button>
      </header>
      <div className="vg-detail-body">
        <div className="vg-row"><Tier v={vm} /><Factors factors={vm.factors} max={6} /></div>
        {(admin || extra) && (
          <div className="vg-actions">
            {admin && scanEnabled && <button className="vc-btn primary" disabled={!!busy} onClick={() => act("scan", { namespace: vm.namespace, name: vm.name }, `Disk scan of ${vm.name} queued`)}>Scan disk now</button>}
            {admin && <button className="vc-btn" disabled={!!busy} onClick={() => act("snapshot", { namespace: vm.namespace, name: vm.name }, (j) => `Snapshot ${j.snapshot} requested`)}>Snapshot before patching</button>}
            {admin && vm.offBaseline.length > 0 && <button className="vc-btn ghost" disabled={!!busy} onClick={() => act("baseline", { namespace: vm.namespace, name: vm.name }, `${vm.name}: current configuration approved`)}>Approve current as baseline</button>}
            {extra}
          </div>
        )}
        {!admin && <p className="vc-muted" style={{ fontSize: "0.78rem" }}>Scanning, snapshots and baselines need the Admin role.</p>}
        {vm.eol && <p className="vg-note">{vm.eol.name} left standard support on {vm.eol.since}: no more security fixes from the vendor.</p>}
        {vm.exposure.length > 0 && <p className="vg-note">Reachable through {vm.exposure.map((e) => `${e.kind} ${e.name}${e.host ? ` (${e.host})` : ""}`).join(", ")}.</p>}
        {vm.offBaseline.length > 0 && (
          <section><h4>Off baseline</h4>
            {vm.offBaseline.map((d, i) => <div key={i} className="vg-diff"><span>{d.label}</span><span className="vg-mono vc-muted">{d.before}</span><span aria-hidden="true">→</span><span className="vg-mono">{d.after}</span></div>)}
          </section>
        )}
        <section><h4>Findings</h4>
          {vm.scan?.status !== "done" && <p className="vg-note">{vm.scan?.status === "failed" ? `The last scan failed: ${vm.scan.error}` : vm.scan ? `Disk scan ${vm.scan.status}…` : scanEnabled ? "Not scanned yet." : "Package CVEs need a disk scan, which is off on this platform."}</p>}
          {vm.scan?.status === "done" && !vm.vulns.length && <p className="vg-note">The last disk scan found no known vulnerabilities.</p>}
          {vm.fix && <div className="vg-fix"><span className="vc-muted">Update the affected packages (critical, high and known exploited):</span><code>{vm.fix}</code></div>}
          {vm.scan?.status === "done" && vm.vulns.length > 0 && (
            <table className="vc-table compact" style={{ marginTop: 10 }}><thead><tr><th>CVE</th><th>Severity</th><th>Package</th><th>Fixed in</th></tr></thead>
              <tbody>{vm.vulns.slice(0, 15).map((x) => <tr key={x.id + x.pkg}><td className="vg-mono">{x.id}{x.kev && <span className="vc-factor vc-f-kev" style={{ marginLeft: 6 }}>KEV</span>}</td><td>{x.severity}</td><td>{x.pkg} <span className="vc-muted">{x.installed}</span></td><td className="vg-mono">{x.fix || "no fix yet"}</td></tr>)}</tbody></table>
          )}
          {vm.scan?.status === "done" && vm.vulns.length > 15 && <p className="vc-muted" style={{ fontSize: "0.76rem", margin: "6px 0 0" }}>The 15 most urgent of {vm.sev.critical + vm.sev.high + vm.sev.medium + vm.sev.low}: known exploited first, then by severity.</p>}
        </section>
      </div>
    </aside>
  );
}
