import { useState, useEffect, useCallback, useMemo } from "react";
import { showToast } from "../../store/toastStore";
import { clusterUrl, splitImage, relTime } from "./vulnModel";
import { SevPill, KevTag } from "./VulnParts";

// The remediation workflow, as the operator sees it: one record per image,
// seven steps, every decision made by the server and every step on record.

export const STEP_LABELS = ["Triage", "Plan", "Pre-deploy gate", "Change & approval", "Approved", "Deploy", "Verify", "Closed"];
export const STATE_LABEL = {
  triaged: "Triaged", planned: "Planned", gating: "Gate running", "gate-failed": "Gate failed", "gate-passed": "Gate passed",
  "awaiting-approval": "Awaiting approval", rejected: "Rejected", approved: "Approved", deploying: "Deploying", "rolled-back": "Rolled back",
  "deploy-failed": "Not rolled out", verifying: "Verifying", "verify-failed": "Not fully fixed", resolved: "Resolved", exception: "Risk accepted", cancelled: "Cancelled",
};
const STATE_STEP = { triaged: 1, planned: 2, gating: 3, "gate-failed": 3, "gate-passed": 3, "awaiting-approval": 4, rejected: 4, approved: 5, deploying: 6, "rolled-back": 6, "deploy-failed": 6, verifying: 7, "verify-failed": 7, resolved: 8 };
const BAD = new Set(["gate-failed", "rejected", "rolled-back", "deploy-failed", "verify-failed"]);
const TONE = (s) => (s === "resolved" ? "ok" : BAD.has(s) ? "bad" : s === "exception" || s === "cancelled" ? "muted" : "run");

const FIX_LABEL = {
  "vendor-tag": "Move to the vendor's patched tag", "base-image": "Rebuild on a patched base image", dependency: "Bump an application dependency",
  toolchain: "Rebuild with a patched language runtime", "no-fix": "No fix published — mitigate or accept",
};

export function useRemediationRecords(cluster, active) {
  const [data, setData] = useState({ records: [], policy: null, you: null, loaded: false, error: null });
  const load = useCallback(async () => {
    try {
      const r = await fetch(clusterUrl("/api/remediation", cluster));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load remediations");
      setData({ ...j, loaded: true, error: null });
    } catch (e) { setData((d) => ({ ...d, loaded: true, error: e.message })); }
  }, [cluster]);
  useEffect(() => {
    if (!active) return undefined;
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [active, load]);
  const act = useCallback(async (id, action, body = {}) => {
    const path = id ? `/api/remediation/${id}${action ? `/${action}` : ""}` : "/api/remediation";
    const r = await fetch(clusterUrl(path, cluster), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    await load();
    return j;
  }, [cluster, load]);
  return { ...data, reload: load, act };
}

// Whole calendar days from today (UTC) to the due date: 0 = due today.
const daysLeft = (due) => (due ? Math.round((Date.parse(due) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000) : null);
export function DueTag({ due }) {
  const d = daysLeft(due);
  if (d == null) return <span className="vc-muted">—</span>;
  return <span className={"rw-due" + (d < 0 ? " over" : d <= 7 ? " soon" : "")} title={`Due ${due}`}>{d < 0 ? `${-d}d overdue` : d === 0 ? "due today" : `${d}d left`}</span>;
}
export function StateTag({ state }) {
  return <span className={`rw-state ${TONE(state)}`}>{STATE_LABEL[state] || state}</span>;
}

/* ─────────────────────────── Remediation tab ─────────────────────────── */

export function RemediationTab({ rw, onOpenImage }) {
  const recs = rw.records || [];
  const open = recs.filter((r) => !["resolved", "cancelled", "rejected"].includes(r.state));
  const overdue = open.filter((r) => r.state !== "exception" && daysLeft(r.due) < 0);
  const k = [
    ["Open", open.length], ["Overdue", overdue.length, overdue.length ? "var(--vc-crit)" : null],
    ["Awaiting approval", recs.filter((r) => r.state === "awaiting-approval").length],
    ["Rolling out", recs.filter((r) => r.state === "deploying" || r.state === "verifying").length],
    ["Resolved", recs.filter((r) => r.state === "resolved").length, "#22a06b"],
    ["Risk accepted", recs.filter((r) => r.state === "exception").length],
  ];
  return (
    <>
      <div className="rw-kpis">{k.map(([l, v, c]) => <div key={l} className="rw-kpi" style={c ? { "--k": c } : undefined}><span>{l}</span><b>{v}</b></div>)}</div>
      <PolicyStrip policy={rw.policy} />
      <div className="vc-tablewrap">
        <table className="vc-table">
          <thead><tr><th>Record</th><th>Image</th><th>Owner</th><th>State</th><th>Due</th><th>Change request</th><th>PR / MR</th><th>Updated</th></tr></thead>
          <tbody>
            {!rw.loaded && <tr><td colSpan={8} className="vc-empty">Loading…</td></tr>}
            {rw.loaded && recs.length === 0 && <tr><td colSpan={8} className="vc-empty">No remediations yet. Open an image and start one from its Remediation tab.</td></tr>}
            {recs.map((r) => (
              <tr key={r.id} onClick={() => onOpenImage(r.image)}>
                <td className="vc-mono">{r.id}</td>
                <td><span className="vc-img-name">{splitImage(r.image).name}<span className="vc-img-tag">:{splitImage(r.image).tag}</span></span><div className="vc-muted vc-mono">{r.namespace}</div></td>
                <td>{r.owner?.team}</td>
                <td><StateTag state={r.state} /></td>
                <td>{r.state === "resolved" ? <span className="vc-muted">—</span> : <DueTag due={r.due} />}</td>
                <td className="vc-mono">{r.changeRequest?.number || (r.approval?.mode === "in-app" ? "in-app" : "—")}</td>
                <td>{(r.changes || []).length ? r.changes.map((c) => <a key={c.url} href={c.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="rw-link">{c.provider === "gitlab" ? "!" : "#"}{c.number}</a>) : <span className="vc-muted">—</span>}</td>
                <td className="vc-muted">{relTime(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PolicyStrip({ policy }) {
  if (!policy) return null;
  const gits = (policy.git || []).filter((g) => g.configured).map((g) => g.host);
  return (
    <div className="rw-policy">
      <span><b>Source control</b> {gits.length ? gits.join(", ") : <span className="vc-warn">no GitHub / GitLab token configured</span>}</span>
      <span><b>Approval</b> {policy.serviceNow ? "ServiceNow change request" : "in-app, Admin, four-eyes"}</span>
      <span><b>Direct rollout</b> {policy.directPatch ? "allowed after approval when no Git path exists" : "disabled"}</span>
      <span><b>Risk acceptance</b> up to {policy.maxExceptionDays} days · KEV 14 days</span>
      <span><b>Rollback</b> automatic after {policy.rolloutTimeoutMin} min unhealthy</span>
    </div>
  );
}

/* ─────────────────────────── drawer panel ─────────────────────────── */

export function RemediationPanel({ img, rw, cluster }) {
  const key = img.fullImage || img.image;
  const rec = useMemo(() => (rw.records || []).find((r) => r.image === key && r.namespace === img.namespace && !["cancelled", "rejected"].includes(r.state))
    || (rw.records || []).find((r) => r.image === key && r.namespace === img.namespace), [rw.records, key, img.namespace]);
  const [busy, setBusy] = useState("");
  const run = async (label, fn) => {
    setBusy(label);
    try { await fn(); } catch (e) { showToast(e.message, "err"); } finally { setBusy(""); }
  };

  if (!rec) {
    return (
      <div className="rw">
        <div className="rw-start">
          <div>
            <h4>Start a remediation</h4>
            <p>The platform triages every CVE in this image by the change that fixes it, sets the owner and due date from policy, and walks the fix through a pre-deploy scan, a reviewed PR / MR and change request, approval, a watched rollout and a verifying re-scan. Nothing reaches production before approval.</p>
          </div>
          <button className="vc-btn primary" disabled={!!busy || !rw.you?.canWrite} title={rw.you?.canWrite ? undefined : "Needs the Operator or Admin role"}
            onClick={() => run("start", async () => { await rw.act(null, null, { image: key, namespace: img.namespace }); showToast("Remediation opened", "ok"); })}>
            {busy === "start" ? "Triaging…" : "Start remediation"}
          </button>
        </div>
        {rw.error && <div className="vc-alert">{rw.error}</div>}
      </div>
    );
  }

  const step = STATE_STEP[rec.state] || 0;
  const can = rw.you?.canWrite;
  const act = (a, body, msg) => run(a, async () => { await rw.act(rec.id, a, body); if (msg) showToast(msg, "ok"); });

  return (
    <div className="rw">
      <div className="rw-head">
        <div>
          <div className="rw-id"><span className="vc-mono">{rec.id}</span><StateTag state={rec.state} />{rec.state !== "resolved" && rec.state !== "exception" && <DueTag due={rec.due} />}</div>
          <div className="vc-muted rw-meta">
            Owner <b>{rec.owner.team}</b>{rec.owner.source !== "label" && " (no owner label)"} · opened by {rec.createdBy} {relTime(rec.createdAt)}
            {rec.workload ? <> · {rec.workload.kind}/{rec.workload.name} · container {rec.workload.container}</> : <span className="vc-warn"> · no workload runs this image</span>}
          </div>
        </div>
        <button className="vc-btn ghost sm" onClick={() => act("refresh")} disabled={!!busy} title="Check gate, approvals and rollout now">Refresh</button>
      </div>

      <ol className="rw-steps">
        {STEP_LABELS.map((l, i) => {
          const n = i + 1;
          const cls = rec.state === "exception" || rec.state === "cancelled" ? "" : n < step || rec.state === "resolved" ? "done" : n === step ? (BAD.has(rec.state) ? "bad" : "on") : "";
          return <li key={l} className={cls}><span>{cls === "done" ? "✓" : n}</span>{l}</li>;
        })}
      </ol>

      {rec.state === "exception" && (
        <div className="rw-card warn"><b>Risk accepted</b> by {rec.exception.by} until {rec.exception.expires.slice(0, 10)} — {rec.exception.reason}{rec.exception.compensating ? <><br />Compensating control: {rec.exception.compensating}</> : null}<div className="vc-muted">The finding reopens automatically on expiry.</div></div>
      )}

      {/* 1 — Fix plan */}
      <section className="rw-sec">
        <header><span className="rw-n">1</span><h5>Fix plan</h5><span className="vc-muted">{rec.plan.items.length} CVE(s) · {rec.firstParty ? "built by your team" : "vendor image"} · due dates from {rec.plan.items.some((i) => i.kev) ? "CISA KEV and " : ""}policy</span></header>
        {rec.plan.groups.map((g) => (
          <div key={g.key} className={"rw-group t-" + g.type}>
            <div className="rw-group-h"><b>{FIX_LABEL[g.type]}{g.ecosystem && g.type === "dependency" ? ` · ${g.ecosystem}` : ""}</b><span className="vc-muted">{g.where}</span><DueTag due={g.due} /></div>
            <table className="vc-table compact">
              <tbody>
                {g.packages.slice(0, 8).map((p) => (
                  <tr key={p.package}>
                    <td className="vc-mono">{p.package}</td>
                    <td className="vc-mono">{p.installed || "—"} → {p.fixed ? <b className="vc-fixver">{p.fixed}</b> : <span className="vc-muted">no fix yet</span>}</td>
                    <td className="rw-cves">{p.cves.slice(0, 4).map((c) => { const it = rec.plan.items.find((x) => x.id === c); return <span key={c} className="vc-mono">{c}{it?.kev && <KevTag />}</span>; })}{p.cves.length > 4 && <span className="vc-muted">+{p.cves.length - 4}</span>}</td>
                    <td>{(() => { const it = rec.plan.items.find((x) => x.id === p.cves[0]); return it ? <SevPill s={it.severity} /> : null; })()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {g.packages.length > 8 && <div className="vc-muted rw-more">+{g.packages.length - 8} more packages</div>}
          </div>
        ))}
      </section>

      {/* 2 — Replacement */}
      <TargetSection rec={rec} img={img} cluster={cluster} can={can} busy={busy} act={act} />

      {/* 3 — Gate */}
      <section className="rw-sec">
        <header><span className="rw-n">3</span><h5>Pre-deploy gate</h5><span className="vc-muted">the replacement is scanned before anyone approves it</span></header>
        {!rec.gate && <div className="vc-muted">Not run yet.</div>}
        {rec.gate?.mode === "ci" && <div className="rw-card">Deferred to CI: the replacement is built from the source change, so the pipeline on the PR / MR is the gate. Approval waits for it to pass.</div>}
        {rec.gate?.status === "running" && <div className="rw-card run">Scanning <code>{rec.gate.image}</code> with a Trivy Job ({rec.gate.job}) — started {relTime(rec.gate.startedAt)}.</div>}
        {rec.gate?.eval && (
          <div className={"rw-card " + (rec.gate.eval.pass ? "ok" : "bad")}>
            <b>{rec.gate.eval.pass ? "Passed" : "Failed"}</b> — replacement has Critical {rec.gate.eval.counts.critical} · High {rec.gate.eval.counts.high} (today {rec.current.critical} · {rec.current.high}); {rec.gate.eval.fixed.length} targeted CVE(s) confirmed gone.
            {rec.gate.eval.reasons.map((r) => <div key={r} className="rw-reason">✕ {r}</div>)}
            {rec.gate.eval.warnings.map((r) => <div key={r} className="rw-reason warn">⚠ {r}</div>)}
          </div>
        )}
        {rec.gate?.error && <div className="rw-card bad">{rec.gate.error}</div>}
        {["planned", "gate-failed"].includes(rec.state) && (
          <button className="vc-btn" disabled={!can || !!busy} onClick={() => act("gate", {}, "Pre-deploy scan started")}>{busy === "gate" ? "Starting…" : rec.gate ? "Run the gate again" : "Run pre-deploy gate"}</button>
        )}
      </section>

      {/* 4 — Change & approval */}
      <ChangeSection rec={rec} rw={rw} can={can} busy={busy} act={act} run={run} />

      {/* 5/6 — Deploy */}
      <section className="rw-sec">
        <header><span className="rw-n">5</span><h5>Deploy</h5><span className="vc-muted">{rec.deploy?.mode === "gitops" ? "the merge rolls it out through GitOps" : rec.deploy?.mode === "direct" ? "the platform patches the one container after approval" : "after approval"}</span></header>
        {rec.state === "approved" && rec.deploy?.mode === "gitops" && <div className="rw-card">Approved — merge the {rec.changes.map((c) => <a key={c.url} href={c.url} target="_blank" rel="noreferrer" className="rw-link">{c.provider === "gitlab" ? "MR !" : "PR #"}{c.number}</a>)} to roll out. The platform watches the sync and the rollout.</div>}
        {rec.state === "approved" && rec.deploy?.mode === "direct" && (
          <div className="rw-card">
            <span className="vc-warn">No Git change — this rollout will not be in source control.</span> Approved by {rec.approval?.by}.
            <div style={{ marginTop: 8 }}><button className="vc-btn danger" disabled={!can || !!busy} onClick={() => { if (window.confirm(`Roll ${rec.workload.kind}/${rec.workload.name} to ${rec.target.image}?\n\nApproved change; the rollout is watched and rolled back automatically if unhealthy.`)) act("deploy", {}, "Rollout started"); }}>{busy === "deploy" ? "Starting…" : "Start approved rollout"}</button></div>
          </div>
        )}
        {rec.deploy?.startedAt && (
          <div className={"rw-card " + (rec.state === "rolled-back" || rec.state === "deploy-failed" ? "bad" : rec.deploy.completedAt ? "ok" : "run")}>
            {rec.deploy.mergedAt && <div>Merged {relTime(rec.deploy.mergedAt)}</div>}
            {rec.deploy.syncedAt ? <div>Rollout of <code>{rec.deploy.liveImage}</code> started {relTime(rec.deploy.syncedAt)}</div> : rec.state === "deploying" && <div>Waiting for the new image to appear on the workload…</div>}
            {rec.deploy.completedAt && <div>✓ All replicas updated and available {relTime(rec.deploy.completedAt)}</div>}
            {rec.state === "rolled-back" && <div>Rolled back{rec.deploy.revert ? <> — revert {rec.deploy.revert.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="rw-link">{u.split("/").slice(-2).join("/")}</a>)}</> : ` to ${rec.deploy.before.image}`}</div>}
          </div>
        )}
        {["deploying", "verifying", "verify-failed", "deploy-failed"].includes(rec.state) && (
          <button className="vc-btn ghost" disabled={!can || !!busy} onClick={() => { if (window.confirm("Roll this change back now?")) act("rollback", { reason: "manual rollback" }, "Rollback started"); }}>Roll back</button>
        )}
      </section>

      {/* 7 — Verify */}
      <section className="rw-sec">
        <header><span className="rw-n">6</span><h5>Verify & close</h5><span className="vc-muted">the scanner re-reports on the running image; the CVEs must be gone</span></header>
        {rec.state === "verifying" && !rec.verify && <div className="rw-card run">Waiting for the scanner to report on the new image…</div>}
        {rec.verify && (
          <div className={"rw-card " + (rec.verify.remaining.length ? "bad" : "ok")}>
            <b>{rec.verify.remaining.length ? `${rec.verify.remaining.length} targeted CVE(s) still present` : `Verified — ${rec.verify.fixed.length} CVE(s) removed`}</b>
            <div>Before {rec.current.critical}C / {rec.current.high}H / {rec.current.medium}M → after {rec.verify.after.critical}C / {rec.verify.after.high}H / {rec.verify.after.medium}M</div>
            {rec.verify.remaining.length > 0 && <div className="vc-mono">{rec.verify.remaining.join(", ")}</div>}
            {rec.state === "resolved" && rec.changeRequest && <div>Evidence recorded on {rec.changeRequest.number}.</div>}
          </div>
        )}
        {rec.state === "resolved" && <PromoteForm rec={rec} act={act} can={can} busy={busy} />}
      </section>

      {/* Exception / cancel */}
      {!["resolved", "cancelled", "rejected", "exception"].includes(rec.state) && <ExceptionForm rec={rec} act={act} you={rw.you} busy={busy} />}

      {/* Audit */}
      <section className="rw-sec">
        <header><h5>History</h5><span className="vc-muted">also written to the platform's tamper-evident audit trail</span></header>
        <ol className="rw-hist">
          {rec.history.slice().reverse().map((h, i) => (
            <li key={i}><span className="vc-muted">{new Date(h.at).toLocaleString()}</span><b>{h.actor}</b>{h.from !== h.to && <StateTag state={h.to} />}<span>{h.note}</span></li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function TargetSection({ rec, img, cluster, can, busy, act }) {
  const editable = ["triaged", "planned", "gate-failed", "rolled-back", "deploy-failed", "verify-failed"].includes(rec.state);
  const [image, setImage] = useState(rec.target?.image || "");
  const [base, setBase] = useState(rec.baseImage || "");
  const [suggesting, setSuggesting] = useState(false);
  const [aiNote, setAiNote] = useState(null);
  useEffect(() => { setImage(rec.target?.image || ""); setBase(rec.baseImage || ""); }, [rec.target?.image, rec.baseImage]);
  const needsBase = rec.firstParty && rec.plan.groups.some((g) => g.type === "base-image");
  const suggest = async () => {
    setSuggesting(true); setAiNote(null);
    try {
      const r = await fetch(clusterUrl("/api/ai/image-remediation", cluster), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: rec.image, namespace: rec.namespace, deployment: rec.workload?.name || "", vulnerabilities: img.vulnerabilities || [] }) });
      const j = await r.json();
      if (j.recommendedImage && !/[<>]/.test(j.recommendedImage)) { setImage(j.recommendedImage); setAiNote(j.imageCheck?.exists === true ? "AI suggestion — tag exists in its registry. Review, then save." : `AI suggestion — ${j.imageCheck?.reason || "not verified"}. Review, then save.`); }
      else setAiNote(j.note || "The AI did not return a usable tag — enter one.");
    } catch (e) { setAiNote(e.message); } finally { setSuggesting(false); }
  };
  return (
    <section className="rw-sec">
      <header><span className="rw-n">2</span><h5>Replacement</h5><span className="vc-muted">{rec.firstParty ? "a patched tag, or leave empty to let CI build it from the source change" : "the vendor's patched tag"}</span></header>
      {rec.target && <div className={"rw-card " + (rec.target.verified?.exists === true ? "ok" : "warn")}>Target <code>{rec.target.image}</code> — {rec.target.verified?.exists === true ? "exists in its registry" : `not verified: ${rec.target.verified?.reason}`}{rec.target.source !== "operator" ? ` · ${rec.target.source}` : ""}</div>}
      {editable && (
        <div className="rw-form">
          <label>Replacement image<input value={image} onChange={(e) => setImage(e.target.value)} placeholder={`${splitImage(rec.image).path}/${splitImage(rec.image).name}:<patched tag>`} /></label>
          {needsBase && <label>New base image <span className="vc-muted">(for the Dockerfile FROM)</span><input value={base} onChange={(e) => setBase(e.target.value)} placeholder="e.g. registry.access.redhat.com/ubi9/ubi-minimal:9.5" /></label>}
          <div className="rw-form-actions">
            <button className="vc-btn ghost" onClick={suggest} disabled={suggesting}>{suggesting ? "Asking…" : "Suggest with AI"}</button>
            <button className="vc-btn" disabled={!can || !!busy || (!image && !base && !rec.firstParty)} onClick={() => act("target", { image: image || undefined, baseImage: needsBase ? base : undefined, source: aiNote ? "AI suggestion, reviewed" : "operator" }, "Plan saved")}>{busy === "target" ? "Checking registry…" : "Save plan"}</button>
          </div>
          {aiNote && <div className="vc-muted">{aiNote}</div>}
        </div>
      )}
    </section>
  );
}

function ChangeSection({ rec, rw, can, busy, act, run }) {
  const [preview, setPreview] = useState(null);
  const [win, setWin] = useState({ start: "", end: "" });
  const srcGit = rec.repos?.source, opsGit = rec.repos?.gitops;
  return (
    <section className="rw-sec">
      <header><span className="rw-n">4</span><h5>Change & approval</h5><span className="vc-muted">a reviewed PR / MR and a change request — approval before anything rolls out</span></header>
      <div className="rw-repos">
        <div><span className="vc-muted">GitOps repo</span>{opsGit ? <a href={opsGit.webUrl} target="_blank" rel="noreferrer" className="rw-link">{opsGit.provider} · {opsGit.path}{opsGit.dir ? `/${opsGit.dir}` : ""}</a> : <span className="vc-muted">not found — annotate <code>tcs.com/gitops-repo</code> or use Argo CD</span>}{opsGit && !opsGit.configured && <span className="vc-warn"> · token missing</span>}</div>
        <div><span className="vc-muted">Source repo</span>{srcGit ? <a href={srcGit.webUrl} target="_blank" rel="noreferrer" className="rw-link">{srcGit.provider} · {srcGit.path}</a> : <span className="vc-muted">{rec.firstParty ? "not found" : "vendor image — none"}</span>}{srcGit && !srcGit.configured && <span className="vc-warn"> · token missing</span>}</div>
      </div>
      {rec.state === "gate-passed" && (
        <>
          <div className="rw-form-actions">
            <button className="vc-btn ghost" disabled={!!busy} onClick={() => run("preview", async () => setPreview(await rw.act(rec.id, "preview")))}>{busy === "preview" ? "Reading repositories…" : "Preview changes"}</button>
          </div>
          {preview && preview.map((p) => (
            <div key={p.repo} className="rw-diff">
              <div className="rw-diff-h"><b>{p.repo === "gitops" ? "GitOps" : "Source"}</b> · {p.provider} · {p.webUrl?.replace(/^https:\/\//, "")} @ {p.base}{p.via ? ` · via ${p.via}` : ""}</div>
              {p.edits.map((e) => <div key={e.path}><div className="vc-mono rw-diff-f">{e.path}</div><pre>{e.diff.map((l) => <span key={l} className={l[0] === "+" ? "add" : "del"}>{l}{"\n"}</span>)}</pre></div>)}
              {p.note && <div className="vc-muted">{p.note}</div>}
            </div>
          ))}
          {preview && !preview.some((p) => p.edits.length) && <div className="rw-card warn">No Git change can be built. {rw.policy?.directPatch ? "The platform will raise the change request and roll out the one container itself after approval — the change will not be in source control." : "Direct rollout is disabled by policy."}</div>}
          <div className="rw-form">
            <div className="rw-window">
              <label>Change window start <span className="vc-muted">(optional)</span><input type="datetime-local" value={win.start} onChange={(e) => setWin((w) => ({ ...w, start: e.target.value }))} /></label>
              <label>End<input type="datetime-local" value={win.end} onChange={(e) => setWin((w) => ({ ...w, end: e.target.value }))} /></label>
            </div>
            <div className="rw-form-actions">
              <button className="vc-btn primary" disabled={!can || !!busy} onClick={() => act("change", { window: win.start ? { start: new Date(win.start).toISOString(), end: win.end ? new Date(win.end).toISOString() : null } : null }, "Change raised")}>
                {busy === "change" ? "Raising…" : `Open ${[opsGit, srcGit].some((g) => g?.provider === "gitlab") ? "MR" : "PR"} & raise change request`}
              </button>
            </div>
          </div>
        </>
      )}
      {rec.changeRequest && <div className="rw-card">Change request <b>{rec.changeRequest.number}</b> · approval <b>{rec.changeRequest.approval || "requested"}</b>{rec.changeRequest.window?.start ? ` · window ${new Date(rec.changeRequest.window.start).toLocaleString()}${rec.changeRequest.window.end ? ` – ${new Date(rec.changeRequest.window.end).toLocaleString()}` : ""}` : ""}</div>}
      {(rec.changes || []).map((c) => (
        <div key={c.url} className="rw-card">
          <a href={c.url} target="_blank" rel="noreferrer" className="rw-link">{c.provider === "gitlab" ? "MR !" : "PR #"}{c.number}</a> · {c.repo} · {c.files.length} file(s) ·
          state <b>{c.status?.state || "open"}</b> · CI <span className={"rw-ci " + (c.status?.checks || "none")}>{c.status?.checks || "none"}</span>
          {c.status?.error && <span className="vc-warn"> · {c.status.error}</span>}
        </div>
      ))}
      {rec.state === "awaiting-approval" && !rec.changeRequest && (
        <div className="rw-card">
          Waiting for an Admin other than {rec.createdBy} to approve.
          <div style={{ marginTop: 8 }}><button className="vc-btn primary" disabled={!rw.you?.isAdmin || rw.you?.name === rec.createdBy || !!busy} title={!rw.you?.isAdmin ? "Needs the Admin role" : rw.you?.name === rec.createdBy ? "The requester cannot approve their own change" : undefined}
            onClick={() => { const n = window.prompt("Approval note (recorded on the change):", ""); if (n !== null) act("approve", { note: n }, "Approved"); }}>Approve change</button></div>
        </div>
      )}
      {rec.state === "awaiting-approval" && rec.changeRequest && <div className="vc-muted">Approve {rec.changeRequest.number} in ServiceNow — the platform picks it up automatically.</div>}
      {rec.approval && <div className="rw-card ok">Approved by <b>{rec.approval.by}</b> ({rec.approval.mode === "servicenow" ? "ServiceNow" : "in-app"}) {relTime(rec.approval.at)}{rec.approval.note ? ` — ${rec.approval.note}` : ""}</div>}
    </section>
  );
}

function ExceptionForm({ rec, act, you, busy }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ reason: "", compensating: "", days: 30 });
  const kevFix = rec.plan.items.some((i) => i.kev && i.fixed);
  return (
    <section className="rw-sec">
      <header><h5>Other actions</h5></header>
      {!open ? (
        <div className="rw-form-actions">
          <button className="vc-btn ghost" onClick={() => setOpen(true)} disabled={!you?.isAdmin} title={you?.isAdmin ? undefined : "Needs the Admin role"}>Accept risk…</button>
          <button className="vc-btn ghost" disabled={!you?.canWrite || !!busy || ["deploying", "verifying"].includes(rec.state)} onClick={() => { const r = window.prompt("Reason for cancelling:", ""); if (r !== null) act("cancel", { reason: r }, "Cancelled"); }}>Cancel remediation</button>
        </div>
      ) : (
        <div className="rw-form">
          <label>Reason (why it cannot be fixed now)<textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
          <label>Compensating control<input value={f.compensating} onChange={(e) => setF({ ...f, compensating: e.target.value })} placeholder="e.g. NetworkPolicy blocks ingress; WAF rule 942100" /></label>
          <label>Expires in (days)<input type="number" min={1} max={kevFix ? 14 : 90} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></label>
          {kevFix && <div className="vc-warn">Contains a fixable CISA KEV CVE — at most 14 days.</div>}
          <div className="rw-form-actions">
            <button className="vc-btn" onClick={() => setOpen(false)}>Back</button>
            <button className="vc-btn primary" disabled={!!busy} onClick={() => act("exception", f, "Risk acceptance recorded").then(() => setOpen(false))}>Record risk acceptance</button>
          </div>
        </div>
      )}
    </section>
  );
}

function PromoteForm({ rec, act, can, busy }) {
  const [t, setT] = useState({ cluster: "", namespace: rec.namespace });
  return (
    <div className="rw-form">
      <div className="vc-muted">Promote this verified fix to the next environment — it reuses the plan and the gate result, and goes through its own change and approval there.</div>
      <div className="rw-window">
        <label>Cluster<input value={t.cluster} onChange={(e) => setT({ ...t, cluster: e.target.value })} placeholder="e.g. prod-east" /></label>
        <label>Namespace<input value={t.namespace} onChange={(e) => setT({ ...t, namespace: e.target.value })} /></label>
      </div>
      <div className="rw-form-actions"><button className="vc-btn" disabled={!can || !!busy || !t.cluster} onClick={() => act("promote", t, "Promotion opened")}>{busy === "promote" ? "Opening…" : "Promote"}</button></div>
    </div>
  );
}
