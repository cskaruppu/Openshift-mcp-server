import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { DockChip } from "../MinimizedDock";
import { showToast } from "../../store/toastStore";

// Private AI Operations Center — the stage and booth view.
//
// Every number here is read from /api/command-center, which reads the modules
// that do the work (the model router, the incident orchestrator, the
// remediation workflow, the VM Migration Agent). Nothing on this screen is
// computed or invented in the browser.
//
// Opened by any of: the workspace header button, the dashboard banner, Ctrl+K,
// or `window.dispatchEvent(new Event("open-command-center"))`.

const ACTS = [["act1", "1 · Private by design"], ["act2", "2 · Incident at scale"], ["act3", "3 · Secure the AI supply chain"], ["act4", "4 · Modernise at GPU speed"], ["score", "Scorecard"]];

const fmtClock = (sec) => (sec == null ? "--:--" : `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString());

async function post(path, body = {}) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

/** Mounted once by the app; opens on the "open-command-center" event. */
export function CommandCenterHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("open-command-center", onOpen);
    return () => window.removeEventListener("open-command-center", onOpen);
  }, []);
  return <CommandCenter open={open} onClose={() => setOpen(false)} />;
}

/** Whether the Command Center is switched on (Settings → Private AI). Asked once per
    page load, and again whenever Settings changes it (refreshCommandCenterEnabled). */
let _enabledPromise = null;
const ask = () => (_enabledPromise = fetch("/api/command-center").then((r) => (r.ok ? r.json() : { enabled: false })).catch(() => ({ enabled: false })));
export function refreshCommandCenterEnabled() { ask(); window.dispatchEvent(new Event("command-center-changed")); }

export function useCommandCenterEnabled() {
  const [st, setSt] = useState({ enabled: false, banner: false });
  useEffect(() => {
    let live = true;
    const read = () => (_enabledPromise || ask()).then((d) => { if (live) setSt({ enabled: !!d.enabled, banner: !!d.banner, hardware: d.hardware || null }); });
    read();
    window.addEventListener("command-center-changed", read);
    return () => { live = false; window.removeEventListener("command-center-changed", read); };
  }, []);
  return st;
}

export function CommandCenter({ open, onClose }) {
  const [act, setAct] = useState("act1");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState("");
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(true);
  const [now, setNow] = useState(Date.now());
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/command-center");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Command Center unavailable");
      setData(j); setErr(null);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => {
    if (!open || minimized) return undefined;
    load();
    timer.current = setInterval(load, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { clearInterval(timer.current); clearInterval(tick); window.removeEventListener("keydown", onKey, true); };
  }, [open, minimized, load, onClose]);
  useEffect(() => { if (!open) setMinimized(false); }, [open]);

  const act$ = async (label, fn, ok) => {
    setBusy(label);
    try { await fn(); if (ok) showToast(ok, "ok"); await load(); } catch (e) { showToast(e.message, "err"); } finally { setBusy(""); }
  };

  if (!open) return null;
  const d = data;
  const node = (
    <>
      {minimized && <DockChip label="Command Center" onRestore={() => setMinimized(false)} />}
      <div className="vc-overlay cc-overlay" style={{ display: minimized ? "none" : "flex" }} onClick={onClose}>
        <div className={"vc-shell cc-shell" + (maximized ? " max" : "")} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Private AI Operations Center">
          <div className="ah-head vc-head" onDoubleClick={(e) => { if (!e.target.closest("button")) setMaximized((v) => !v); }}>
            <div className="ah-lockup" style={{ flex: 1, minWidth: 0 }}>
              <span className="tcs-lock">
                <img className="tcs-lock-logo" src="/brand/tcs-logo-white.png" alt="Tata Consultancy Services" width="1000" height="238" />
                <span className="tcs-lock-rule" aria-hidden="true" />
                <span className="tcs-lock-name">TCS Agentic AI for Hybrid Infrastructure</span>
              </span>
              <span className="ah-lockup-rule" aria-hidden="true" />
              <span className="ah-lockup-mod"><span className="ah-lockup-qual">Command Center</span><span className="ah-lockup-module">Private AI Operations Center</span></span>
            </div>
            {d?.hardware && <span className="cc-hw">{d.hardware}</span>}
            {(d?.access?.expired || d?.access?.expiringSoon) && (
              <span className={"cc-access" + (d.access.expired ? " bad" : "")} title={`Direct access to ${d.cluster}: renew it in Settings → Private AI → Cluster access`}>
                {`Access to ${d.cluster} ${d.access.expiry}`}
              </span>
            )}
            {d?.enabled && (
              <span className={"cc-egress" + (d.act1.egress.blocked ? " on" : "")} title={d.act1.egress.blocked ? `NetworkPolicy ${d.act1.egress.policy} in ${d.act1.egress.namespace}` : "The platform can reach the internet"}>
                ● {d.act1.egress.blocked ? `Internet egress blocked · since ${fmtTime(d.act1.egress.since)}` : "Internet egress open"}
              </span>
            )}
            <span className="cc-clock">{new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <div className="ah-winbtns">
              <button className="ah-winbtn" onClick={() => setMinimized(true)} title="Minimise" aria-label="Minimise"><svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg></button>
              <button className="ah-winbtn" onClick={() => setMaximized((v) => !v)} title={maximized ? "Restore down" : "Maximise"} aria-label={maximized ? "Restore down" : "Maximise"}>
                {maximized ? <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1" /></svg> : <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>}
              </button>
              <button className="ah-winbtn close" onClick={onClose} title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" strokeWidth="1" /></svg></button>
            </div>
          </div>

          <nav className="cc-nav" aria-label="Acts">
            {ACTS.map(([k, l]) => <button key={k} className={"cc-act" + (act === k ? " on" : "")} onClick={() => setAct(k)}>{l}</button>)}
            <div style={{ flex: 1 }} />
            {d?.enabled && <span className="cc-since">Session since {fmtTime(d.session.since)}</span>}
            <button className="vc-btn ghost sm" disabled={!!busy} onClick={() => act$("session", () => post("/api/command-center/session/start"), "New session started — counters reset")}>Start new session</button>
          </nav>

          <div className="cc-body">
            {err && <div className="vc-alert">{err}</div>}
            {!d && !err && <div className="cc-empty">Loading…</div>}
            {d && !d.enabled && <div className="cc-empty">The Command Center is switched off. An admin can turn it on in Settings → Private AI.</div>}
            {d?.enabled && act === "act1" && <Act1 d={d} busy={busy} act$={act$} />}
            {d?.enabled && act === "act2" && <Act2 d={d} busy={busy} act$={act$} />}
            {d?.enabled && act === "act3" && <Act3 d={d} />}
            {d?.enabled && act === "act4" && <Act4 d={d} busy={busy} act$={act$} />}
            {d?.enabled && act === "score" && <Scorecard d={d} />}
          </div>
        </div>
      </div>
    </>
  );
  return createPortal(node, document.body);
}

/* ─────────────────────────── Act 1 ─────────────────────────── */

function Act1({ d, busy, act$ }) {
  const a = d.act1;
  const gpus = a.gpu?.gpus || [];
  const done = (a.log || []).filter((x) => x.ms);
  const median = done.length ? [...done].sort((x, y) => x.ms - y.ms)[Math.floor(done.length / 2)].ms : null;
  const models = [...(a.models || []), ...(a.embed ? [a.embed] : [])];
  return (
    <>
      <div className="cc-kpis">
        <Kpi label="AI answers on-prem" value={fmtNum(a.traffic.onPrem)} sub={`since ${fmtTime(a.traffic.since)}`} />
        <Kpi label="Calls to cloud AI" value={fmtNum(a.traffic.cloudCalls)} sub={a.traffic.cloudCalls ? "non-sensitive, by policy" : "none this session"} tone={a.traffic.cloudCalls ? "warn" : "ok"} />
        <Kpi label="Median answer time" value={median ? `${(median / 1000).toFixed(1)} s` : "—"} sub="last 40 answers" />
        {gpus.slice(0, 2).map((g, i) => <Kpi key={g.id || i} label={`GPU ${g.index ?? i} · ${String(g.model || "GPU").replace(/NVIDIA\s*/i, "")}`} value={g.utilPct != null ? `${g.utilPct}%` : "—"} sub={g.tempC != null ? `${g.tempC} °C · ${g.memPct ?? "—"}% memory` : g.node} tone="blue" />)}
        {!gpus.length && <Kpi label="GPUs" value={a.gpu?.physical?.gpus ?? a.gpu?.summary?.totalGpus ?? "—"}
          sub={a.gpu?.physical?.gpus ? `${a.gpu.physical.model ? `NVIDIA ${a.gpu.physical.model}` : "on this cluster"}${a.gpu.physical.shared ? " · time-sliced" : ""}` : a.gpu?.available === false ? "telemetry not available" : "on this cluster"} />}
      </div>
      <div className="cc-grid3">
        <section className="cc-card">
          <header><h3>Models on OpenShift AI</h3><span>KServe · vLLM</span></header>
          {!models.length && <p className="cc-note">No models connected yet. Deploy them and run enable.sh (Settings → Private AI shows each step).</p>}
          {models.map((m) => (
            <div key={m.role} className="cc-model">
              <div className="cc-model-h"><b>{m.model}</b>{m.gpu && <span className="cc-gpu">{m.gpu}</span>}</div>
              <span className="cc-muted">{m.label}</span>
              <span className={"cc-health" + (m.health?.ok ? " ok" : "")}>{m.health?.ok ? `● Ready · ${m.health.ms} ms` : `● ${m.health?.error || "unreachable"}`}</span>
            </div>
          ))}
        </section>
        <section className="cc-card cc-wide">
          <header><h3>AI traffic control</h3><span>{a.routerOn ? "every question routed to the right model" : "router off — turn on in Settings → Private AI"}</span></header>
          <div className="cc-table">
            <div className="cc-tr cc-th"><span>Time</span><span>Question</span><span>Answered by</span><span>Why</span><span className="r">Time</span></div>
            {(a.log || []).slice(0, 9).map((r) => (
              <div key={r.id} className={"cc-tr" + (r.sensitive?.length ? " sens" : "") + (r.ok === false ? " bad" : "")}>
                <span className="mono">{fmtTime(r.at)}</span>
                <span className="q">{r.question || r.useCase || "—"}</span>
                <span className={"m " + (r.role || "")}>{r.model || "—"}{r.gpu ? <em> · {r.gpu}</em> : null}</span>
                <span className="cc-muted">{r.reason}{r.sensitive?.length ? ` · ${r.sensitive.join(", ")}` : ""}</span>
                <span className="mono r">{r.ms ? `${(r.ms / 1000).toFixed(1)} s` : r.ok === false ? "failed" : "…"}</span>
              </div>
            ))}
            {!(a.log || []).length && <div className="cc-note">Ask something in AI Chat with "Private AI" selected — each answer appears here with the model that wrote it.</div>}
          </div>
        </section>
      </div>
      <section className={"cc-card cc-resid" + (a.egress.blocked ? " on" : "")}>
        <div>
          <h3>Data residency</h3>
          <p>{a.egress.blocked ? `The platform has no route to the internet (NetworkPolicy ${a.egress.policy}). Every answer on this screen came from the GPUs in this cluster.` : "The platform can reach the internet. Block it to show that every AI feature keeps working on-prem."}</p>
          <div className="cc-resid-stats">
            <span>Sensitive requests kept on-prem <b>{fmtNum(a.traffic.sensitiveKeptOnPrem)}</b></span>
            <span>Tokens served on-prem <b>{fmtNum(a.traffic.tokens)}</b></span>
            {a.embed && <span>Incident-memory lookups <b>{fmtNum(a.embed.stats?.calls)}</b></span>}
          </div>
        </div>
        <button className={"vc-btn " + (a.egress.blocked ? "ghost" : "danger")} disabled={!!busy}
          onClick={() => act$("egress", () => post("/api/command-center/egress", { block: !a.egress.blocked }), a.egress.blocked ? "Internet egress restored" : "Internet egress blocked")}>
          {a.egress.blocked ? "Restore internet access" : "Cut the internet"}
        </button>
      </section>
    </>
  );
}

/* ─────────────────────────── Act 2 ─────────────────────────── */

const STEP_LABEL = { detected: "Detected", triaged: "Root cause found", inc_raised: "Incident raised", fix_proposed: "Fix proposed and risk-scored", dry_run_passed: "Dry run passed", awaiting_approval: "Waiting for approval", approved: "Approved", remediating: "Rolling out the fix", verifying: "Verifying", resolved: "Verified, incident closed", closed: "Closed", escalated: "Escalated to a person", rolled_back: "Rolled back", failed: "Failed", rejected: "Rejected" };

function Act2({ d, busy, act$ }) {
  const s = d.act2;
  const ses = s.session;
  const live = s.live || {};
  const awaiting = ses?.state === "awaiting_approval";
  const t0 = s.faultAt ? new Date(s.faultAt).getTime() : null;
  const rel = (iso) => (t0 && iso ? fmtClock(Math.max(0, Math.round((new Date(iso).getTime() - t0) / 1000))) : "");
  return (
    <div className="cc-grid3 a2">
      <section className="cc-col">
        <div className={"cc-clockcard" + (s.resolvedAt ? " ok" : s.faultAt ? " run" : "")}>
          <span className="cc-lbl">Time to resolve · live</span>
          <span className="cc-bigclock">{fmtClock(s.elapsedSec)}</span>
          <span className="cc-muted">{s.faultAt ? `Fault at ${fmtTime(s.faultAt)}${s.detectedAt ? ` · detected ${fmtTime(s.detectedAt)}` : ""}${s.resolvedAt ? ` · fixed ${fmtTime(s.resolvedAt)}` : ""}` : "Inject the fault to start the clock"}</span>
        </div>
        <section className="cc-card">
          <header><h3>Demo workload</h3><span className="mono">{s.namespace}/{s.deployment}</span></header>
          {!live.installed ? <p className="cc-note">{live.error}</p> : (
            <>
              <div className="cc-kv"><span>Release</span><b>{live.release || "—"}</b></div>
              <div className="cc-kv"><span>Revision</span><b>{live.revision}</b></div>
              <div className="cc-kv"><span>Ready</span><b className={live.ready < live.replicas ? "warn" : "ok"}>{live.ready} / {live.replicas}</b></div>
              <div className="cc-kv"><span>Config</span><b className="mono">{live.config}</b></div>
            </>
          )}
          <div className="cc-actions">
            <button className="vc-btn danger" disabled={!!busy || !live.installed || ["faulted", "responding"].includes(s.phase)} onClick={() => act$("inject", () => post("/api/command-center/scenario/inject"), "Bad release rolled out")}>Inject fault</button>
            <button className="vc-btn ghost" disabled={!!busy || !live.installed} onClick={() => act$("reset", () => post("/api/command-center/scenario/reset"), "Scenario reset")}>Reset</button>
          </div>
        </section>
      </section>

      <section className="cc-card cc-wide">
        <header><h3>Root cause{ses?.rca?.aiAnalysed ? " · written by the on-prem model" : ""}</h3>{ses?.incidentNumber && <span className="cc-pill">{ses.incidentNumber} · {ses.severity}</span>}</header>
        {!ses && <p className="cc-note">{s.faultAt ? "Waiting for the platform's detector to see the failing pods…" : "No incident yet."}</p>}
        {ses && (
          <>
            <p className="cc-rca">{ses.rca?.rootCause || ses.title}</p>
            {ses.rca?.analysis && <p className="cc-muted">{ses.rca.analysis}</p>}
            {(ses.rca?.whyChain || []).length > 0 && <ol className="cc-why">{ses.rca.whyChain.slice(0, 4).map((w, i) => <li key={i}>{w}</li>)}</ol>}
            {(ses.rca?.logLines || []).length > 0 && <pre className="cc-log">{ses.rca.logLines.slice(-4).join("\n")}</pre>}
            {(ses.rca?.kbMatches || []).length > 0 && <div className="cc-seen"><span className="cc-lbl">Seen this before</span><span>{ses.rca.kbMatches[0].rootCause || ses.rca.kbMatches[0].matched}</span></div>}
            {ses.remediation && (
              <div className="cc-fix">
                <div className="cc-fix-h"><b>Proposed fix</b><span className="cc-pill warn">risk {ses.remediation.risk}{ses.remediation.reversible ? " · reversible" : ""}</span></div>
                {ses.remediation.command && <code>{ses.remediation.command}</code>}
                <span className="cc-muted">{ses.remediation.rationale}</span>
                {awaiting && <button className="vc-btn primary" disabled={!!busy} onClick={() => act$("approve", () => post("/api/command-center/incident/approve", { sessionId: ses.id }), "Fix approved")}>Approve fix</button>}
              </div>
            )}
          </>
        )}
      </section>

      <section className="cc-card">
        <header><h3>What happened, step by step</h3></header>
        <ol className="cc-steps">
          {s.faultAt && <li className="warn"><span className="mono">00:00</span><b>Bad release rolled out</b><em>{s.by}</em></li>}
          {(ses?.history || []).map((h, i) => <li key={i} className={/resolved|closed|approved/.test(h.to) ? "ok" : /failed|rolled_back|rejected/.test(h.to) ? "bad" : ""}><span className="mono">{rel(h.at)}</span><b>{STEP_LABEL[h.to] || h.to}</b></li>)}
          {!s.faultAt && <li><span className="mono">—</span><b>Waiting to start</b></li>}
        </ol>
      </section>
    </div>
  );
}

/* ─────────────────────────── Act 3 ─────────────────────────── */

function Act3({ d }) {
  const sc = d.act3.scan;
  const r = d.act3.remediation;
  return (
    <div className="cc-grid2">
      <section className="cc-card">
        <header><h3>Image security, this cluster</h3>{sc && <span>scan {fmtTime(sc.timestamp)}</span>}</header>
        {!sc ? <p className="cc-note">No scan yet — open the Image Vulnerabilities card and press Rescan.</p> : (
          <>
            <div className="cc-kpis small">
              <Kpi label="Fix now" value={sc.fixNow} sub="images" tone="crit" />
              <Kpi label="Known exploited" value={sc.kevCves} sub="CVEs in CISA KEV" tone="crit" />
              <Kpi label="Live-scanned" value={`${sc.live}/${sc.images}`} sub="images" />
            </div>
            {sc.top && (
              <div className="cc-topimg">
                <span className="cc-lbl">Highest risk</span>
                <b className="mono">{sc.top.image}</b>
                <span className="cc-muted">{sc.top.namespace} · risk {sc.top.score} · {sc.top.critical} Critical / {sc.top.high} High</span>
                {sc.top.kev.length > 0 && <span className="cc-kevlist">{sc.top.kev.map((k) => <span key={k} className="cc-pill crit">{k}</span>)}</span>}
              </div>
            )}
          </>
        )}
        <button className="vc-btn primary" onClick={() => window.dispatchEvent(new Event("open-vulnerability-center"))}>Open the Vulnerability Center</button>
      </section>
      <section className="cc-card">
        <header><h3>Remediation in flight</h3>{r && <span className="mono">{r.id}</span>}</header>
        {!r ? <p className="cc-note">No remediation yet. Start one from an image's Remediation tab in the Vulnerability Center.</p> : (
          <>
            <div className="cc-kv"><span>Image</span><b className="mono">{r.image}</b></div>
            <div className="cc-kv"><span>Replacement</span><b className="mono">{r.target?.image || "—"}</b></div>
            <div className="cc-kv"><span>State</span><b>{r.state}</b></div>
            <div className="cc-kv"><span>Owner · due</span><b>{r.owner?.team} · {r.due}</b></div>
            {r.gate?.eval && <div className="cc-kv"><span>Pre-deploy gate</span><b className={r.gate.eval.pass ? "ok" : "warn"}>{r.gate.eval.pass ? "passed" : "failed"} · {r.gate.eval.counts.critical} C / {r.gate.eval.counts.high} H</b></div>}
            {(r.changes || []).map((c) => <div key={c.url} className="cc-kv"><span>{c.provider === "gitlab" ? "Merge request" : "Pull request"}</span><a href={c.url} target="_blank" rel="noreferrer">{c.provider === "gitlab" ? "!" : "#"}{c.number} · {c.status?.state}</a></div>)}
            {r.changeRequest && <div className="cc-kv"><span>Change request</span><b>{r.changeRequest.number}</b></div>}
            {r.approval && <div className="cc-kv"><span>Approved by</span><b>{r.approval.by}</b></div>}
            {r.verify && <div className="cc-kv"><span>Verified</span><b className={r.verify.remaining.length ? "warn" : "ok"}>{r.verify.fixed.length} CVE(s) gone{r.verify.remaining.length ? `, ${r.verify.remaining.length} left` : ""}</b></div>}
          </>
        )}
      </section>
    </div>
  );
}

/* ─────────────────────────── Act 4 ─────────────────────────── */

function Act4({ d, busy, act$ }) {
  const b = d.act4;
  const fileRef = useRef(null);
  const running = b.state === "running";
  const pctDone = b.total ? Math.round(((b.done || 0) / b.total) * 100) : 0;
  const upload = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => act$("assess", () => post("/api/command-center/vm-assessment", { csv: String(rd.result) }), "Assessment started");
    rd.readAsText(f);
    e.target.value = "";
  };
  return (
    <div className="cc-grid2">
      <section className="cc-card">
        <header><h3>VMware estate assessment</h3>{b.synthetic && <span className="cc-pill warn">synthetic sample estate</span>}</header>
        <div className="cc-run">
          <div><span className="cc-bigclock sm">{b.elapsedMs != null ? fmtClock(Math.round(b.elapsedMs / 1000)) : "--:--"}</span><span className="cc-muted">elapsed</span></div>
          <div><b className="cc-num blue">{fmtNum(b.vmsPerMinute)}</b><span className="cc-muted">VMs per minute</span></div>
          <div><b className="cc-num ok">{fmtNum(b.done)}</b><span className="cc-muted">of {fmtNum(b.total)} done</span></div>
        </div>
        <div className="cc-bar"><span style={{ width: `${pctDone}%` }} /></div>
        <span className="cc-muted">Support level and blockers are decided in code for every VM; the on-prem model advises warm or cold and risk, 40 VMs per call, {b.aiCalls ? `${b.aiCalls} calls so far` : "many calls in parallel"}.</span>
        <div className="cc-actions">
          <button className="vc-btn primary" disabled={!!busy || running} onClick={() => act$("assess", () => post("/api/command-center/vm-assessment", { sample: true, count: 2000 }), "Assessment started")}>Assess the 2,000-VM sample estate</button>
          <button className="vc-btn ghost" disabled={!!busy || running} onClick={() => fileRef.current?.click()}>Upload an inventory CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={upload} />
        </div>
        {b.state === "failed" && <div className="vc-alert">{b.error}</div>}
      </section>
      <section className="cc-card">
        <header><h3>Decision per VM</h3></header>
        {!b.decisions ? <p className="cc-note">{running ? "Assessing…" : "Run an assessment to see the decisions and the waves."}</p> : (
          <>
            {b.decisions.map((x) => (
              <div key={x.key} className="cc-dec">
                <div className="cc-dec-h"><b>{x.label}</b><span className="mono">{fmtNum(x.n)}</span></div>
                <div className="cc-bar thin"><span style={{ width: `${b.total ? (x.n / b.total) * 100 : 0}%` }} className={x.key} /></div>
                <span className="cc-muted">{x.why}</span>
              </div>
            ))}
            <div className="cc-waves">
              {b.waves.map((w) => <div key={w.name} className="cc-wave"><b>{w.name}</b><span className="mono">{fmtNum(w.n)}</span><span className={"cc-pill " + (w.risk === "Low" ? "ok" : w.risk === "Medium" ? "warn" : w.risk === "High" ? "crit" : "")}>{w.risk}</span></div>)}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/* ─────────────────────────── Scorecard ─────────────────────────── */

function Scorecard({ d }) {
  const s = d.scorecard;
  const tiles = [
    ["Time to resolve", s.mttrSec != null ? fmtClock(s.mttrSec) : "—", "payments incident, fault to verified fix"],
    ["Evidence correlated", s.symptoms != null ? `${s.symptoms} → 1` : "—", "signals tied to one root cause"],
    ["Production changes", s.changes ? `${s.changes} · ${Math.round((s.approved / s.changes) * 100)}%` : "0", "approved by a person and audited"],
    ["Known-exploited CVEs fixed", fmtNum(s.kevFixed), "gated, approved, verified by re-scan"],
    ["VMs assessed", fmtNum(s.vmsAssessed), s.vmsElapsedMs ? `in ${fmtClock(Math.round(s.vmsElapsedMs / 1000))}${s.vmsSynthetic ? " · sample estate" : ""}` : "this session"],
    ["AI answers on-prem", fmtNum(s.aiOnPrem), `${fmtNum(s.sensitiveKept)} sensitive kept on-prem · ${fmtNum(s.cloudCalls)} cloud calls`],
    ["Internet egress", s.egressBlockedSince ? "blocked" : "open", s.egressBlockedSince ? `since ${fmtTime(s.egressBlockedSince)}` : "not blocked this session"],
    ["Cloud AI cost avoided", s.costAvoided != null ? `$${s.costAvoided.toLocaleString()}` : "—", s.costAvoided != null ? `${fmtNum(s.tokens)} tokens at your cloud price` : "set PRIVATE_AI_CLOUD_PRICE_PER_MTOK"],
  ];
  return (
    <div className="cc-score">
      <div className="cc-score-h"><span className="cc-lbl">This session · since {fmtTime(d.session.since)} · every number measured live</span><h2>Run, secure and modernise, with AI that stays in your data centre</h2></div>
      <div className="cc-score-grid">{tiles.map(([l, v, sub]) => <div key={l} className="cc-tile"><span className="cc-lbl">{l}</span><b>{v}</b><span className="cc-muted">{sub}</span></div>)}</div>
      <div className="cc-tagline"><span>Dell gives you the AI factory. TCS Agentic AI makes it run your infrastructure: privately, autonomously and under control.</span><span className="cc-pill warn">Every action in the audit trail</span></div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }) {
  return <div className={"cc-kpi " + (tone || "")}><span className="cc-lbl">{label}</span><b>{value}</b><span className="cc-muted">{sub}</span></div>;
}

/** The dashboard's launch banner — shown only when switched on in Settings → Private AI, dismissible per browser. */
export function CommandCenterBanner() {
  const { enabled, banner, hardware } = useCommandCenterEnabled();
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem("cc-banner-hidden") === "1"; } catch { return false; } });
  if (!enabled || !banner || hidden) return null;
  return (
    <div className="cc-banner">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8M12 17v4" /><path d="M6 13l3-3 2.5 2.5L16 8l2 2" /></svg>
      <div className="cc-banner-text">
        <b>Private AI Operations Center</b>
        <span>Live: AI on {hardware || "your own GPUs"} · incidents healed · CVEs fixed · VMware exit plan. Every number opens the real screen.</span>
      </div>
      <button className="vc-btn primary" onClick={() => window.dispatchEvent(new Event("open-command-center"))}>Open Command Center →</button>
      <button className="cc-banner-x" aria-label="Hide this banner" title="Hide this banner" onClick={() => { setHidden(true); try { localStorage.setItem("cc-banner-hidden", "1"); } catch { /* private window */ } }}>
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" strokeWidth="1.3" /></svg>
      </button>
    </div>
  );
}
