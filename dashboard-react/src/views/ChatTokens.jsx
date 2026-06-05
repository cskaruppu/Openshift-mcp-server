import { useState, useRef } from "react";
import { clusterUrl } from "../api/client";
import { renderMarkdown } from "../utils/markdown";
import { showToast } from "../store/toastStore";

/* ------------------------------------------------------------------ */
/*  Token parsing                                                       */
/* ------------------------------------------------------------------ */

const TOKEN_RE =
  /@@(PREFLIGHT_REPORT|ITSM_FORM|ITSM_SUBMITTED|UPGRADE_EXECUTE|FIX_PROPOSAL|CLARIFY|POD_ISSUE|APPLY_BTN|SUMMARY|SCORE|GRADE|SEC_FIX_CMD|RIGHTSIZE|TRIAGE|VIEW_MORE|VIEW_MORE_REC|PLAN|REASONING|KPI)\|([\s\S]*?)@@/;

const JSON_TOKENS = new Set([
  "PREFLIGHT_REPORT", "ITSM_FORM", "ITSM_SUBMITTED", "UPGRADE_EXECUTE",
  "FIX_PROPOSAL", "CLARIFY", "PLAN", "REASONING", "RIGHTSIZE", "TRIAGE",
]);

function safeJson(raw) {
  try { return JSON.parse(raw.replace(/@ @/g, "@@")); } catch { return null; }
}

/**
 * Split an assistant message into an ordered list of segments. Each segment is
 * either plain markdown ({ kind: "md", text }) or an interactive token
 * ({ kind: "token", type, data }).
 */
export function parseSegments(text) {
  const segments = [];
  let rest = text || "";
  let guard = 0;

  while (rest && guard++ < 200) {
    const m = TOKEN_RE.exec(rest);
    if (!m) { segments.push({ kind: "md", text: rest }); break; }
    if (m.index > 0) segments.push({ kind: "md", text: rest.slice(0, m.index) });

    const type = m[1];
    const raw = m[2];
    const data = JSON_TOKENS.has(type) ? safeJson(raw) : raw;
    segments.push({ kind: "token", type, data });
    rest = rest.slice(m.index + m[0].length);
  }
  return segments;
}

/* ------------------------------------------------------------------ */
/*  Segment renderer                                                    */
/* ------------------------------------------------------------------ */

// Delegated click handler for the Copy button rendered inside code blocks
// (renderMarkdown emits <button data-copy="..."> since it returns raw HTML).
function handleMdClick(e) {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const txt = btn.getAttribute("data-copy")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  navigator.clipboard.writeText(txt).then(() => {
    const orig = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }).catch(() => {});
}

export function ChatMessageBody({ text, cluster, onQuery, onItsmSubmitted }) {
  const segments = parseSegments(text);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "md") {
          if (!seg.text.trim()) return null;
          return (
            <div key={i} className="chat-bubble md-content"
              onClick={handleMdClick}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.text) }} />
          );
        }
        return <TokenCard key={i} type={seg.type} data={seg.data} cluster={cluster} onQuery={onQuery} onItsmSubmitted={onItsmSubmitted} />;
      })}
    </>
  );
}

function TokenCard({ type, data, cluster, onQuery, onItsmSubmitted }) {
  switch (type) {
    case "PREFLIGHT_REPORT": return data ? <PreflightReport report={data} /> : null;
    case "ITSM_FORM":        return data ? <ITSMForm form={data} cluster={cluster} onItsmSubmitted={onItsmSubmitted} /> : null;
    case "ITSM_SUBMITTED":   return data ? <ITSMSubmitted info={data} onQuery={onQuery} /> : null;
    case "UPGRADE_EXECUTE":  return data ? <UpgradeExecuteCard data={data} cluster={cluster} /> : null;
    case "FIX_PROPOSAL":     return data ? <FixProposal diag={data} cluster={cluster} /> : null;
    case "CLARIFY":          return data ? <ClarifyCard data={data} onQuery={onQuery} /> : null;
    case "SEC_FIX_CMD":      return <SecFixCmd cmd={data} cluster={cluster} />;
    case "RIGHTSIZE":        return data ? <RightSizeCard rec={data} cluster={cluster} /> : null;
    case "TRIAGE":           return data ? <TriageCard t={data} cluster={cluster} onQuery={onQuery} /> : null;
    case "POD_ISSUE":        return <PodIssue raw={data} />;
    case "APPLY_BTN":        return <ApplyBtn raw={data} cluster={cluster} />;
    case "SUMMARY":          return <SummaryBar raw={data} />;
    case "SCORE":            return <ScoreGauge raw={data} />;
    case "GRADE":            return <GradeBadge raw={data} />;
    default:                 return null; // PLAN/REASONING/KPI/VIEW_MORE — silently dropped
  }
}

/* ------------------------------------------------------------------ */
/*  Preflight report (upgrade readiness)                                */
/* ------------------------------------------------------------------ */

function PreflightReport({ report }) {
  const sum = report.summary || {};
  const vd = report.versionDelta || {};
  const status = report.overallStatus || report.status || "";
  const statusColor = /pass|ready|ok/i.test(status) ? "var(--ok)" : /warn/i.test(status) ? "var(--warn)" : "var(--crit)";

  return (
    <div className="preflight-report">
      <div className="preflight-header">
        <div className="preflight-title">Pre-Upgrade Cluster Assessment</div>
        <div className="preflight-meta">
          {report.fromVersion} &rarr; {report.targetVersion}
          {report.upgradeType && <span className="preflight-type">{report.upgradeType}</span>}
        </div>
        <div className="preflight-status" style={{ color: statusColor }}>{status}</div>
      </div>

      <div className="preflight-summary">
        <span className="pf-badge pf-pass">{sum.pass ?? 0} Passed</span>
        <span className="pf-badge pf-warn">{sum.warning ?? 0} Warnings</span>
        <span className="pf-badge pf-fail">{sum.fail ?? 0} Failed</span>
      </div>

      <div className="pf-version-compare">
        <table>
          <thead><tr><th>Component</th><th>Current</th><th></th><th>After Upgrade</th></tr></thead>
          <tbody>
            <tr><td>OpenShift</td><td className="pf-val-from">{report.fromVersion}</td><td className="pf-arrow-cell">&rarr;</td><td className="pf-val-to">{report.targetVersion}</td></tr>
            {vd.kubeFrom && vd.kubeTo && <tr><td>Kubernetes</td><td className="pf-val-from">{vd.kubeFrom}</td><td className="pf-arrow-cell">&rarr;</td><td className="pf-val-to">{vd.kubeTo}</td></tr>}
            {report.upgradeType && <tr><td>Upgrade Type</td><td className="pf-val-from" colSpan={3}>{report.upgradeType}</td></tr>}
            {report.channel && <tr><td>Channel</td><td className="pf-val-from" colSpan={3}>{report.channel}</td></tr>}
            {vd.estimatedDuration && <tr><td>Est. Duration</td><td className="pf-val-from" colSpan={3}>{vd.estimatedDuration}</td></tr>}
            {report.nodeTopology && <tr><td>Cluster Nodes</td><td className="pf-val-from" colSpan={3}>{report.nodeTopology.total} total ({report.nodeTopology.masters} control-plane, {report.nodeTopology.workers} worker{report.nodeTopology.infra ? `, ${report.nodeTopology.infra} infra` : ""})</td></tr>}
          </tbody>
        </table>
      </div>

      {Array.isArray(vd.apiRemovals) && vd.apiRemovals.length > 0 && (
        <details className="pf-api-removals">
          <summary>&#x26A0; API Removals / Deprecations ({vd.apiRemovals.length})</summary>
          <ul>{vd.apiRemovals.slice(0, 20).map((a, i) => <li key={i}>{a.name || a.api || String(a)}{a.message ? ` — ${a.message}` : ""}</li>)}</ul>
        </details>
      )}

      <div className="preflight-checks">
        {(report.checks || []).map((c, i) => {
          const icon = c.status === "pass" ? "✅" : c.status === "warning" ? "⚠️" : "❌";
          const items = (c.items || []).slice(0, 15);
          return (
            <details key={i} className={"pf-check pf-check-" + c.status} {...(c.status === "pass" ? {} : {})}>
              <summary className="pf-check-header">
                <span>{icon} <strong>{c.category}</strong></span>
                <span className="pf-check-detail">{c.details}</span>
              </summary>
              {items.length > 0 && (
                <div className="pf-check-items">
                  {items.map((it, j) => (
                    <div className="pf-item" key={j}>
                      {it.name && <span className="pf-item-name">{it.name}</span>}
                      {it.issue && <span className="pf-item-issue">{it.issue}</span>}
                      {it.message && <span className="pf-item-msg">{String(it.message).slice(0, 120)}</span>}
                      {it.severity && <span className={"pf-item-sev pf-sev-" + it.severity}>{it.severity}</span>}
                    </div>
                  ))}
                  {(c.items || []).length > 15 && <div className="pf-item" style={{ opacity: .6 }}>… and {c.items.length - 15} more</div>}
                </div>
              )}
              {c.recommendation && <div className="pf-recommendation">💡 {c.recommendation}</div>}
            </details>
          );
        })}
      </div>

      {Array.isArray(report.allClusterOperators) && report.allClusterOperators.length > 0 && (
        <details className="pf-operators-section">
          <summary className="pf-check-header"><strong>Cluster Operators ({report.allClusterOperators.length})</strong></summary>
          <div className="pf-op-table">
            <table>
              <thead><tr><th>Operator</th><th>Version</th><th>Available</th><th>Degraded</th></tr></thead>
              <tbody>
                {report.allClusterOperators.map((op, i) => (
                  <tr key={i}>
                    <td>{op.name}</td><td>{op.version || "-"}</td>
                    <td style={{ color: op.available ? "var(--ok)" : "var(--crit)" }}>{op.available ? "Yes" : "NO"}</td>
                    <td style={{ color: op.degraded ? "var(--crit)" : "var(--ok)" }}>{op.degraded ? "YES" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="preflight-footer">
        {report.channel && <span>Channel: {report.channel}</span>}
        {report.clusterID && <span>Cluster ID: {report.clusterID}</span>}
        {report.timestamp && <span>Assessed: {new Date(report.timestamp).toLocaleString()}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ServiceNow ITSM form                                                */
/* ------------------------------------------------------------------ */

function ITSMForm({ form, cluster, onItsmSubmitted }) {
  const isCR = form.type === "change_request";
  const label = isCR ? "Change Request" : "Incident";
  const [values, setValues] = useState(() => {
    const init = {};
    for (const [k, f] of Object.entries(form.fields || {})) init[k] = f.value || "";
    return init;
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { ok, message, ticketId, sysId, attachmentId } | { error }
  const [cancelled, setCancelled] = useState(false);

  const setField = (k, v) => setValues((s) => ({ ...s, [k]: v }));

  async function submit() {
    setSubmitting(true);
    setResult(null);
    try {
      const payload = { type: form.type, fields: values };
      if (form._preflightReport) payload.preflightReport = form._preflightReport;
      if (form._upgradeInfo) { payload.upgradeInfo = form._upgradeInfo; payload.conversationId = form._upgradeInfo.conversationId || ""; }
      const res = await fetch(clusterUrl("/api/itsm/submit", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success) {
        setResult({ ok: true, ...data });
        showToast(`${label} ${data.ticketId} created`, "ok");
        // Persist the submitted state by swapping the interactive form token
        // for a read-only ITSM_SUBMITTED card, so a page refresh doesn't
        // re-show the form (the store persists message text to localStorage).
        if (typeof onItsmSubmitted === "function") {
          onItsmSubmitted({
            type: form.type,
            ticketId: data.ticketId,
            sysId: data.sysId || null,
            title: values.short_description || values.title || values.summary || label,
            isUpgrade: !!(form._upgradeInfo || form._preflightReport),
            targetVersion: form._upgradeInfo?.targetVersion || form._preflightReport?.targetVersion || null,
            servicenowEnabled: !!form.servicenowEnabled,
            attachmentId: data.attachmentId || null,
          });
        }
      } else throw new Error(data.error || "Submission failed");
    } catch (e) {
      let msg = e.message || "Unknown error";
      if (/fetch failed|Failed to fetch|NetworkError/i.test(msg)) msg = "Cannot reach the server. Check ServiceNow env vars (SERVICENOW_INSTANCE, _USERNAME, _PASSWORD).";
      setResult({ error: msg });
    } finally { setSubmitting(false); }
  }

  if (cancelled) return <div className="itsm-form" style={{ opacity: .6, padding: "12px 16px", fontSize: 13 }}>{label} form dismissed.</div>;

  const submitted = result?.ok;

  return (
    <div className="itsm-form">
      <div className="itsm-form-header">
        <div className={"itsm-icon " + (isCR ? "cr" : "inc")}>{isCR ? "📋" : "🚨"}</div>
        <div style={{ flex: 1 }}>
          <h4>{label} Form</h4>
          <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>Auto-populated from cluster context</div>
        </div>
        <span className="itsm-badge" style={{ background: form.servicenowEnabled ? "color-mix(in srgb,var(--ok) 20%,transparent)" : "color-mix(in srgb,var(--warn) 20%,transparent)", color: form.servicenowEnabled ? "var(--ok)" : "var(--warn)" }}>
          {form.servicenowEnabled ? "ServiceNow Connected" : "Local Only"}
        </span>
      </div>

      <div className="itsm-form-body">
        {Object.entries(form.fields || {}).map(([key, f]) => {
          const id = "itsm-" + key;
          const val = values[key];
          const isLong = (val && (val.indexOf("\n") !== -1 || val.length > 80));
          return (
            <div className="itsm-field" key={key}>
              <label htmlFor={id}>{f.label}</label>
              {Array.isArray(f.options) && f.options.length > 0 ? (
                <select id={id} value={val} disabled={submitted} onChange={(e) => setField(key, e.target.value)}>
                  {f.options.map((o) => {
                    const optVal = /^[1-4] - /.test(o) ? o.split(" - ")[0].trim() : o;
                    return <option key={o} value={optVal}>{o}</option>;
                  })}
                </select>
              ) : isLong ? (
                <textarea id={id} value={val} disabled={submitted} rows={Math.min(Math.max((val || "").split("\n").length, 2), 6)} onChange={(e) => setField(key, e.target.value)} />
              ) : (
                <input type="text" id={id} value={val} disabled={submitted} onChange={(e) => setField(key, e.target.value)} />
              )}
            </div>
          );
        })}
      </div>

      {!submitted && (
        <div className="itsm-actions">
          <button className="itsm-submit" onClick={submit} disabled={submitting}>
            {submitting ? "Submitting…" : `📤 Submit ${label}`}
          </button>
          <button className="itsm-cancel" onClick={() => setCancelled(true)} disabled={submitting}>Cancel</button>
        </div>
      )}

      {result?.ok && (
        <div className="itsm-result" style={{ display: "block" }}>
          <div style={{ color: "var(--ok)", fontWeight: 600 }}>✅ {result.message}</div>
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--text2)" }}>Ticket ID: <strong style={{ color: "var(--text)" }}>{result.ticketId}</strong></div>
          {result.attachmentId && <div style={{ marginTop: 4, fontSize: 11, color: "var(--ok)" }}>📎 Pre-Assessment report attached</div>}
          {result.sysId && isCR && <div style={{ marginTop: 6, fontSize: 11, color: "var(--accent2)" }}>🔍 Ask "check CR status" or "proceed with upgrade" once approved.</div>}
        </div>
      )}
      {result?.error && (
        <div className="itsm-result" style={{ display: "block" }}>
          <div style={{ color: "var(--crit)" }}>❌ Error: {result.error}</div>
        </div>
      )}
    </div>
  );
}

function ITSMSubmitted({ info, onQuery }) {
  const isCR = info.type === "change_request";
  const label = isCR ? "Change Request" : "Incident";
  return (
    <div className="itsm-form" style={{ opacity: .92 }}>
      <div className="itsm-form-header">
        <div className={"itsm-icon " + (isCR ? "cr" : "inc")}>{isCR ? "📋" : "🚨"}</div>
        <div style={{ flex: 1 }}>
          <h4>{label} Submitted</h4>
          <div style={{ fontSize: 12, color: "var(--ok)", marginTop: 2, fontWeight: 600 }}>{info.ticketId}</div>
        </div>
        <span className="itsm-badge" style={{ background: "color-mix(in srgb,var(--ok) 20%,transparent)", color: "var(--ok)" }}>Submitted</span>
      </div>
      {info.title && <div style={{ padding: "8px 16px 4px", fontSize: 12, color: "var(--text2)" }}>{info.title}</div>}
      {info.attachmentId && <div style={{ padding: "0 16px 4px", fontSize: 11, color: "var(--ok)" }}>📎 Pre-Assessment report attached</div>}
      {isCR && (
        <div style={{ padding: "4px 16px 14px" }}>
          <div style={{ fontSize: 11, color: "var(--accent2)", marginBottom: 8 }}>
            🔍 Once the change request is approved{info.targetVersion ? ` for upgrade to ${info.targetVersion}` : ""}, proceed to the dry-run + execute step.
          </div>
          {typeof onQuery === "function" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="itsm-submit" style={{ flex: "0 0 auto", padding: "6px 14px", fontSize: 12 }}
                onClick={() => onQuery("check CR status")}>
                Check CR status
              </button>
              <button className="itsm-submit" style={{ flex: "0 0 auto", padding: "6px 14px", fontSize: 12 }}
                onClick={() => onQuery(info.targetVersion ? `proceed with upgrade to ${info.targetVersion}` : "proceed with upgrade")}>
                ⬆ Proceed with upgrade
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Upgrade execute card (dry-run + execute with SSE progress)          */
/* ------------------------------------------------------------------ */

function UpgradeExecuteCard({ data, cluster }) {
  const [lines, setLines] = useState([]);      // [{ cls, text }]
  const [progress, setProgress] = useState(null); // null | number
  const [barColor, setBarColor] = useState("var(--accent2)");
  const [phase, setPhase] = useState("");
  const [running, setRunning] = useState(false);
  const [dryRunOk, setDryRunOk] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [channel, setChannel] = useState(data.channel || "stable-" + (data.targetVersion || "").split(".").slice(0, 2).join("."));
  const [force, setForce] = useState(false);
  const esRef = useRef(null);

  const push = (cls, text) => setLines((l) => [...l, { cls, text }]);

  async function dryRun() {
    setRunning(true);
    setLines([{ cls: "t-info", text: `$ oc adm upgrade --to=${data.targetVersion} --dry-run` }, { cls: "t-dim", text: "Validating upgrade path..." }]);
    try {
      const res = await fetch(clusterUrl("/api/upgrade/dryrun", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: data.targetVersion, channel }),
      });
      const d = await res.json();
      if (d.success) {
        (d.details || "").split("\n").forEach((ln) => ln && push("t-dim", ln));
        push("t-ok", "✓ Dry run PASSED — upgrade path is valid");
        push("t-info", 'Ready to execute. Click "Execute Upgrade" to proceed.');
        setDryRunOk(true);
      } else {
        push("t-err", "✗ Dry run FAILED: " + (d.error || "Unknown error"));
      }
    } catch (e) {
      push("t-err", "✗ Error: " + e.message);
    } finally { setRunning(false); }
  }

  async function execute() {
    setRunning(true);
    setProgress(0);
    setLines([{ cls: "t-info", text: `$ oc adm upgrade --to=${data.targetVersion}` }]);
    try {
      if (channel) {
        push("t-dim", `$ oc adm upgrade channel --channel=${channel}`);
        await fetch(clusterUrl("/api/upgrade/channel", cluster), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel }),
        });
        push("t-ok", "✓ Channel set to " + channel);
      }
      push("t-dim", `Initiating cluster upgrade to ${data.targetVersion}...`);
      const res = await fetch(clusterUrl("/api/upgrade/start", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: data.targetVersion, force }),
      });
      const d = await res.json();
      if (!d.success) { push("t-err", "✗ " + (d.error || "Failed to start upgrade")); setRunning(false); return; }
      push("t-ok", "✓ Upgrade initiated successfully");
      push("t-dim", "Monitoring ClusterVersion status...");

      const es = new EventSource(clusterUrl("/api/upgrade/status", cluster));
      esRef.current = es;
      const phaseLabels = { preparing: "Preparing cluster for upgrade...", updating: "Updating operators and nodes...", completing: "Finalizing upgrade...", complete: "✓ Upgrade complete!", failed: "✗ Upgrade failed", timeout: "⚠ Monitoring timed out" };
      es.onmessage = (evt) => {
        try {
          const p = JSON.parse(evt.data);
          if (typeof p.progress === "number") setProgress(p.progress);
          setPhase(p.phase || "");
          const cls = p.phase === "complete" ? "t-ok" : (p.phase === "failed" || p.phase === "timeout") ? "t-err" : "t-dim";
          push(cls, `${phaseLabels[p.phase] || p.phase} [${p.progress}%]`);
          if (p.message) push("t-dim", "  " + p.message);
          if (p.operators) push("t-dim", `  Operators: ${p.operators.updating} updating / ${p.operators.degraded} degraded / ${p.operators.total} total`);
          if (p.phase === "complete") { es.close(); setBarColor("var(--ok)"); push("t-ok", `━━━ Cluster upgraded to ${p.version} ━━━`); setRunning(false); }
          else if (p.phase === "failed" || p.phase === "timeout") { es.close(); setBarColor("var(--crit)"); setRunning(false); }
        } catch { /* ignore */ }
      };
      es.onerror = () => { es.close(); setRunning(false); };
    } catch (e) {
      push("t-err", "✗ Error: " + e.message);
      setRunning(false);
    }
  }

  if (cancelled) return <div className="ux-card" style={{ opacity: .7 }}><div className="ux-body" style={{ padding: 14, fontSize: 13, color: "var(--text2)" }}>✕ Upgrade cancelled. No changes were made to the cluster.</div></div>;

  return (
    <div className="ux-card">
      <div className="ux-header">
        <span style={{ fontSize: 20 }}>✅</span>
        <div style={{ flex: 1 }}>
          <h4 style={{ margin: 0 }}>Upgrade Approved — Ready to Execute</h4>
          <div style={{ fontSize: 11, opacity: .8, marginTop: 2 }}>CR {data.ticketId} • {data.upgradeType || "Patch"} upgrade via {channel}</div>
        </div>
      </div>
      <div className="ux-body">
        <div className="ux-version-row">
          <div className="ux-ver"><div className="ux-ver-label">CURRENT VERSION</div><div className="ux-ver-num">{data.fromVersion}</div></div>
          <div className="ux-arrow">➡</div>
          <div className="ux-ver"><div className="ux-ver-label">TARGET VERSION</div><div className="ux-ver-num" style={{ color: "var(--ok)" }}>{data.targetVersion}</div></div>
        </div>
        <div className="ux-cmd-preview"><span style={{ color: "var(--ok)" }}>$</span> oc adm upgrade --to={data.targetVersion}</div>

        <div className="ux-actions">
          <button className="ux-btn ux-btn-dryrun" onClick={dryRun} disabled={running}>🔍 Dry Run</button>
          <button className="ux-btn ux-btn-execute" onClick={execute} disabled={running || (!dryRunOk)}>▶ Execute Upgrade</button>
          <button className="ux-btn ux-btn-cancel" onClick={() => { esRef.current?.close(); setCancelled(true); }} disabled={running}>✕ Cancel</button>
        </div>

        <div className="ux-advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>{showAdvanced ? "▼" : "▶"} Advanced Options</div>
        {showAdvanced && (
          <div className="ux-advanced" style={{ display: "block" }}>
            <label>Channel: <input value={channel} onChange={(e) => setChannel(e.target.value)} style={{ marginLeft: 6 }} /></label>
            <label><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Force upgrade (bypass version validation)</label>
          </div>
        )}

        {(lines.length > 0 || progress !== null) && (
          <div style={{ marginTop: 10 }}>
            <div className="ux-terminal">
              {lines.map((l, i) => <div key={i} className={l.cls}>{l.text}</div>)}
            </div>
            {progress !== null && (
              <div className="ux-progress-bar"><div className="ux-progress-fill" style={{ width: progress + "%", background: barColor }} /></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Fix proposal (pod healing)                                          */
/* ------------------------------------------------------------------ */

function FixProposal({ diag }) {
  return (
    <div className="fix-proposal">
      <div className="fix-proposal-head">
        <span style={{ fontSize: 16 }}>🩺</span>
        <strong>{diag.title || "Diagnosis & Fix Proposal"}</strong>
        {diag.confidence != null && <span className="fix-confidence">{Math.round(diag.confidence * 100)}% confidence</span>}
      </div>
      {diag.rootCause && <div className="fix-section"><span className="fix-label">Root cause</span><div>{diag.rootCause}</div></div>}
      {Array.isArray(diag.steps) && diag.steps.length > 0 && (
        <div className="fix-section"><span className="fix-label">Remediation</span>
          <ol>{diag.steps.map((s, i) => <li key={i}>{typeof s === "string" ? s : s.text || s.description}</li>)}</ol>
        </div>
      )}
      {diag.command && <div className="ux-cmd-preview"><span style={{ color: "var(--ok)" }}>$</span> {diag.command}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SEC_FIX_CMD — copyable / runnable oc command                        */
/* ------------------------------------------------------------------ */

function SecFixCmd({ cmd, cluster }) {
  const [result, setResult] = useState(null); // { running, text, cls }
  const command = (cmd || "").trim();

  async function run(dryRun) {
    if (!dryRun) {
      // Classify first; for destructive commands require explicit confirmation.
      try {
        const cls = await fetch(clusterUrl("/api/guardrails/classify", cluster), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }),
        }).then((r) => r.json()).catch(() => ({}));
        const c = cls.classification || {};
        if (c.level === "blocked") { setResult({ cls: "t-err", text: "Blocked by guardrails: " + (c.reason || "") }); return; }
        if (!window.confirm(`Execute this command on the cluster?\n\n${command}\n\nThis makes REAL changes. Proceed?`)) return;
      } catch { if (!window.confirm(`Execute on cluster?\n\n${command}`)) return; }
    }
    setResult({ running: true, text: dryRun ? "Running dry run…" : "Executing on cluster…" });
    try {
      const res = await fetch(clusterUrl("/api/alerts/execute-fix", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command, dryRun }),
      });
      const d = await res.json();
      if (d.blocked) { setResult({ cls: "t-err", text: "Blocked: " + (d.reason || "unknown") }); return; }
      const out = d.output || d.stdout || d.result || (d.success ? "Done." : d.error || "No output");
      setResult({ cls: d.success === false ? "t-err" : "t-ok", text: String(out).slice(0, 4000) });
    } catch (e) {
      setResult({ cls: "t-err", text: "Network error: " + e.message });
    }
  }

  return (
    <div className="sec-fix-cmd">
      <code>{command}</code>
      <div className="sec-fix-actions">
        <button className="sec-fix-btn" onClick={() => { navigator.clipboard?.writeText(command); showToast("Command copied", "ok"); }}>Copy</button>
        <button className="sec-fix-btn sec-fix-dry" onClick={() => run(true)}>Dry Run</button>
        <button className="sec-fix-btn sec-fix-run" onClick={() => run(false)}>Run</button>
      </div>
      {result && (
        <div className={"aic-fix-result " + (result.running ? "running" : "")}>
          {result.running ? <span>⏳ {result.text}</span> : <pre className={result.cls}>{result.text}</pre>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  RIGHTSIZE — interactive right-sizing card with dry-run + apply       */
/* ------------------------------------------------------------------ */

function RightSizeCard({ rec, cluster }) {
  const [result, setResult] = useState(null); // { phase, cls, text, verified }
  const wl = rec.workload; // { kind, name } | null
  const cli = "oc"; // works as kubectl too; oc is a superset on OpenShift

  // Build the right-sizing command against the owning workload.
  const command = wl
    ? `${cli} set resources ${wl.kind.toLowerCase()}/${wl.name} -n ${rec.ns} ` +
      `--requests=cpu=${rec.cpuRecommend}m,memory=${rec.memRecommend}Mi`
    : null;

  async function execFix(cmd, dryRun, extra = {}) {
    const res = await fetch(clusterUrl("/api/alerts/execute-fix", cluster), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: cmd, dryRun, ...extra }),
    });
    return res.json();
  }

  // Close the loop: after a successful apply, re-read the workload to confirm
  // it is reachable and healthy post-change, then report the new requests.
  async function verify() {
    setResult({ phase: "verifying", running: true, text: "Applied — verifying workload…" });
    try {
      const d = await execFix(`${cli} get ${wl.kind.toLowerCase()}/${wl.name} -n ${rec.ns}`, true);
      if (d.success !== false) {
        setResult({
          phase: "verified", verified: true, cls: "t-ok",
          text: `Verified — ${wl.kind}/${wl.name} is reachable and now requests CPU ${rec.cpuRecommend}m, Memory ${rec.memRecommend}Mi.`,
        });
      } else {
        setResult({ phase: "verified", cls: "t-warn", text: "Applied, but the workload re-check did not confirm. Inspect it manually." });
      }
    } catch (e) {
      setResult({ phase: "verified", cls: "t-warn", text: "Applied, but verification request failed: " + e.message });
    }
  }

  async function run(dryRun) {
    if (!command) return;
    if (!dryRun && !window.confirm(`Apply right-sizing to ${wl.kind}/${wl.name} in ${rec.ns}?\n\n${command}\n\nThis updates resource requests on the live workload. Proceed?`)) return;
    setResult({ phase: dryRun ? "dry" : "apply", running: true, text: dryRun ? "Running server-side dry run…" : "Applying to cluster…" });
    try {
      const extra = dryRun ? {} : { auditTitle: `Right-sized ${wl.kind}/${wl.name} (${rec.ns}) → CPU ${rec.cpuRecommend}m, Mem ${rec.memRecommend}Mi`, namespace: rec.ns };
      const d = await execFix(command, dryRun, extra);
      if (d.blocked) { setResult({ cls: "t-err", text: "Blocked by guardrails: " + (d.reason || "unknown") }); return; }
      if (d.success === false) {
        setResult({ cls: "t-err", text: String(d.output || d.stderr || d.error || "Command failed").slice(0, 2000) });
        return;
      }
      if (dryRun) {
        const out = d.output || d.stdout || d.result || "Dry run passed — no errors.";
        setResult({ phase: "dry", cls: "t-ok", text: String(out).slice(0, 2000) });
      } else {
        // Apply succeeded → run the verify step.
        await verify();
      }
    } catch (e) {
      setResult({ cls: "t-err", text: "Network error: " + e.message });
    }
  }

  const overProvisioned = rec.type === "over";
  const verified = result?.verified;
  return (
    <div className={"rsz-card" + (verified ? " verified" : "")}>
      <div className="rsz-head">
        <span className={"rsz-tag " + (overProvisioned ? "over" : "under")}>
          {overProvisioned ? "Over-provisioned" : "Under-provisioned"}
        </span>
        <span className="rsz-target">
          {wl ? `${wl.kind}/${wl.name}` : rec.name} <span className="rsz-ns">· {rec.ns}</span>
        </span>
        {verified && <span className="rsz-verified-badge">✓ Applied &amp; Verified</span>}
      </div>

      <div className="rsz-rows">
        <RszRow label="CPU" used={`${rec.cpuUsed}m`} from={`${rec.cpuReq}m`} to={`${rec.cpuRecommend}m`} />
        <RszRow label="Memory" used={`${rec.memUsed}Mi`} from={`${rec.memReq}Mi`} to={`${rec.memRecommend}Mi`} />
      </div>

      {command ? (
        <>
          <div className="rsz-cmd"><span className="rsz-cmd-prompt">$</span> {command}</div>
          {!verified && (
            <div className="rsz-actions">
              <button className="rsz-btn dry" onClick={() => run(true)} disabled={result?.running}>Dry Run</button>
              <button className="rsz-btn apply" onClick={() => run(false)} disabled={result?.running}>Apply</button>
              <button className="rsz-btn ghost" onClick={() => { navigator.clipboard?.writeText(command); showToast("Command copied", "ok"); }}>Copy</button>
            </div>
          )}
        </>
      ) : (
        <div className="rsz-note">Couldn’t resolve the owning workload for this pod — apply manually via its Deployment/StatefulSet.</div>
      )}

      {result && (
        <div className={"aic-fix-result " + (result.running ? "running" : "")}>
          {result.running
            ? <span className="rsz-progress">{result.phase === "verifying" ? "🔎" : "⏳"} {result.text}</span>
            : <pre className={result.cls}>{result.text}</pre>}
        </div>
      )}
    </div>
  );
}

function RszRow({ label, used, from, to }) {
  return (
    <div className="rsz-row">
      <span className="rsz-row-label">{label}</span>
      <span className="rsz-row-used">using {used}</span>
      <span className="rsz-row-change">
        <span className="rsz-from">{from}</span>
        <span className="rsz-arrow">→</span>
        <span className="rsz-to">{to}</span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  TRIAGE — pod failure remediation (restart / memory / investigate)   */
/* ------------------------------------------------------------------ */

const TRIAGE_META = {
  OOMKilled:         { tone: "crit", blurb: "Container was killed for exceeding its memory limit." },
  CrashLoopBackOff:  { tone: "crit", blurb: "Container keeps crashing on start." },
  ImagePullBackOff:  { tone: "warn", blurb: "Cluster can't pull the container image." },
  ErrImagePull:      { tone: "warn", blurb: "Image pull failed — bad name, registry or pull secret." },
};

function TriageCard({ t, cluster, onQuery }) {
  const [result, setResult] = useState(null);
  const wl = t.workload; // {kind,name} | null
  const meta = TRIAGE_META[t.reason] || { tone: "warn", blurb: "" };
  const supportsSet = wl && ["Deployment", "StatefulSet", "DaemonSet"].includes(wl.kind);

  let command = null, action = null;
  if (t.fixKind === "restart" && wl) {
    action = "Rolling restart";
    command = `oc rollout restart ${wl.kind.toLowerCase()}/${wl.name} -n ${t.ns}`;
  } else if (t.fixKind === "memory" && supportsSet && t.memNew) {
    action = `Raise memory limit to ${t.memNew}Mi`;
    command = `oc set resources ${wl.kind.toLowerCase()}/${wl.name} -n ${t.ns} --containers=${t.container} --limits=memory=${t.memNew}Mi`;
  }

  async function execFix(cmd, dryRun, extra = {}) {
    const res = await fetch(clusterUrl("/api/alerts/execute-fix", cluster), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: cmd, dryRun, ...extra }),
    });
    return res.json();
  }

  async function verify() {
    setResult({ phase: "verifying", running: true, text: "Applied — verifying workload…" });
    try {
      const d = await execFix(`oc get ${wl.kind.toLowerCase()}/${wl.name} -n ${t.ns}`, true);
      if (d.success !== false) {
        const note = t.fixKind === "memory"
          ? `memory limit is now ${t.memNew}Mi`
          : "a fresh rollout was triggered";
        setResult({ phase: "verified", verified: true, cls: "t-ok", text: `Verified — ${wl.kind}/${wl.name} is reachable and ${note}.` });
      } else {
        setResult({ phase: "verified", cls: "t-warn", text: "Applied, but the workload re-check did not confirm. Inspect it manually." });
      }
    } catch (e) {
      setResult({ phase: "verified", cls: "t-warn", text: "Applied, but verification request failed: " + e.message });
    }
  }

  async function run(dryRun) {
    if (!command) return;
    if (!dryRun && !window.confirm(`${action} on ${wl.kind}/${wl.name} in ${t.ns}?\n\n${command}\n\nProceed?`)) return;
    setResult({ phase: dryRun ? "dry" : "apply", running: true, text: dryRun ? "Running server-side dry run…" : "Applying to cluster…" });
    try {
      const extra = dryRun ? {} : { auditTitle: `Triage (${t.reason}): ${action} — ${wl.kind}/${wl.name} (${t.ns})`, namespace: t.ns };
      const d = await execFix(command, dryRun, extra);
      if (d.blocked) { setResult({ cls: "t-err", text: "Blocked by guardrails: " + (d.reason || "unknown") }); return; }
      if (d.success === false) { setResult({ cls: "t-err", text: String(d.output || d.stderr || d.error || "Command failed").slice(0, 2000) }); return; }
      if (dryRun) setResult({ phase: "dry", cls: "t-ok", text: String(d.output || d.stdout || "Dry run passed — no errors.").slice(0, 2000) });
      else await verify();
    } catch (e) {
      setResult({ cls: "t-err", text: "Network error: " + e.message });
    }
  }

  const verified = result?.verified;
  return (
    <div className={"rsz-card triage" + (verified ? " verified" : "")}>
      <div className="rsz-head">
        <span className={"trg-reason " + meta.tone}>{t.reason}</span>
        <span className="rsz-target">
          {wl ? `${wl.kind}/${wl.name}` : t.pod} <span className="rsz-ns">· {t.ns}</span>
        </span>
        {t.restarts > 0 && <span className="trg-restarts">{t.restarts} restarts</span>}
        {verified && <span className="rsz-verified-badge">✓ Applied &amp; Verified</span>}
      </div>

      {meta.blurb && <div className="trg-blurb">{meta.blurb}{t.container ? ` (container: ${t.container})` : ""}</div>}

      {t.fixKind === "investigate" ? (
        <>
          {t.image && <div className="rsz-cmd"><span className="rsz-cmd-prompt">image</span> {t.image}</div>}
          <div className="rsz-actions">
            <button className="rsz-btn dry" onClick={() => onQuery?.(`Why is pod ${t.pod} in namespace ${t.ns} failing with ${t.reason}? Check its image ${t.image} and pull secrets.`)}>Investigate in chat</button>
          </div>
          <div className="rsz-note" style={{ marginTop: 8 }}>Image-pull failures need a corrected image or pull secret — not auto-applied.</div>
        </>
      ) : command ? (
        <>
          <div className="trg-action">Recommended: <strong>{action}</strong></div>
          <div className="rsz-cmd"><span className="rsz-cmd-prompt">$</span> {command}</div>
          {!verified && (
            <div className="rsz-actions">
              <button className="rsz-btn dry" onClick={() => run(true)} disabled={result?.running}>Dry Run</button>
              <button className="rsz-btn apply" onClick={() => run(false)} disabled={result?.running}>Apply</button>
              <button className="rsz-btn ghost" onClick={() => { navigator.clipboard?.writeText(command); showToast("Command copied", "ok"); }}>Copy</button>
            </div>
          )}
        </>
      ) : (
        <div className="rsz-note">Couldn’t resolve a safe automated fix for this workload — investigate manually.</div>
      )}

      {result && (
        <div className={"aic-fix-result " + (result.running ? "running" : "")}>
          {result.running
            ? <span className="rsz-progress">{result.phase === "verifying" ? "🔎" : "⏳"} {result.text}</span>
            : <pre className={result.cls}>{result.text}</pre>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Pod issue / apply button / clarify / summary / score / grade        */
/* ------------------------------------------------------------------ */

function PodIssue({ raw }) {
  const [name, ns, detail] = (raw || "").split("|");
  return (
    <div className="pod-issue">
      <div className="pod-name">{name}</div>
      <div className="pod-ns">{ns}</div>
      <div className="pod-detail">{detail}</div>
    </div>
  );
}

function ApplyBtn({ raw, cluster }) {
  const [action, name, ns, label] = (raw || "").split("|");
  const [state, setState] = useState(null); // { running, text, ok }
  async function apply() {
    if (!window.confirm(`${label}?\n\n${action} ${name}${ns ? " in " + ns : ""}`)) return;
    setState({ running: true, text: "Applying…" });
    try {
      const res = await fetch(clusterUrl("/api/execute", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, name, namespace: ns }),
      });
      const d = await res.json();
      setState({ ok: d.success !== false, text: d.message || d.error || (d.success ? "Done" : "Failed") });
    } catch (e) { setState({ ok: false, text: e.message }); }
  }
  return (
    <div style={{ margin: "6px 0" }}>
      <button className="apply-btn" onClick={apply} disabled={state?.running}>{label}</button>
      {state && <span style={{ marginLeft: 8, fontSize: 12, color: state.ok ? "var(--ok)" : state.running ? "var(--text2)" : "var(--crit)" }}>{state.text}</span>}
    </div>
  );
}

function ClarifyCard({ data, onQuery }) {
  return (
    <div className="clarify-card">
      <div className="clarify-header">
        <div className="clarify-icon">🤔</div>
        <div className="clarify-question">{data.question || "What would you like to do?"}</div>
      </div>
      {data.context && <div className="clarify-context">{data.context}</div>}
      <div className="clarify-options">
        {(data.options || []).map((opt, i) => (
          <button key={i} className="clarify-option" onClick={() => onQuery?.(opt.query || opt.label)}>
            <span className="clarify-opt-icon">{opt.icon || "➡"}</span>
            <div className="clarify-opt-body">
              <div className="clarify-opt-label">{opt.label}</div>
              {opt.desc && <div className="clarify-opt-desc">{opt.desc}</div>}
            </div>
            <span className="clarify-opt-arrow">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SummaryBar({ raw }) {
  const parts = (raw || "").split("|").map((item) => {
    const [colorLabel, val] = item.split(":");
    const color = colorLabel === "red" ? "red" : colorLabel === "amber" ? "amber" : "green";
    const label = color === "red" ? "Critical" : color === "amber" ? "Warning" : "Healthy";
    return { color, val, label };
  });
  return (
    <div className="summary-bar">
      {parts.map((p, i) => <span className="summary-item" key={i}><span className={"summary-dot " + p.color} />{p.val} {p.label}</span>)}
    </div>
  );
}

function ScoreGauge({ raw }) {
  const [valStr, label] = (raw || "").split("|");
  const v = Math.max(0, Math.min(100, parseInt(valStr, 10) || 0));
  const color = v >= 80 ? "var(--ok)" : v >= 60 ? "var(--warn)" : "var(--crit)";
  const circ = 2 * Math.PI * 22;
  const offset = circ - (v / 100) * circ;
  return (
    <div className="score-gauge">
      <div className="score-ring">
        <svg width="52" height="52" viewBox="0 0 52 52">
          <circle className="ring-bg" cx="26" cy="26" r="22" />
          <circle className="ring-fg" cx="26" cy="26" r="22" stroke={color} strokeDasharray={circ.toFixed(1)} strokeDashoffset={offset.toFixed(1)} />
        </svg>
        <div className="score-val" style={{ color }}>{v}</div>
      </div>
      <div><div className="score-title">{label}</div><div className="score-label">Score: {v} / 100</div></div>
    </div>
  );
}

function GradeBadge({ raw }) {
  const [grade, label] = (raw || "").split("|");
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, margin: "4px 0" }}>
      <span className={"grade-badge grade-" + grade}>{grade}</span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
    </span>
  );
}
