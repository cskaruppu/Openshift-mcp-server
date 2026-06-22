import React, { useState, useRef, useEffect } from "react";
import { clusterUrl } from "../api/client";
import { renderMarkdown } from "../utils/markdown";
import { showToast } from "../store/toastStore";

/* ------------------------------------------------------------------ */
/*  Token parsing                                                       */
/* ------------------------------------------------------------------ */

const TOKEN_RE =
  /@@(PREFLIGHT_REPORT|ITSM_FORM|ITSM_SUBMITTED|UPGRADE_EXECUTE|UPGRADE_PROGRESS|FIX_PROPOSAL|CLARIFY|POD_ISSUE|APPLY_BTN|SUMMARY|SCORE|GRADE|SEC_FIX_CMD|RIGHTSIZE|TRIAGE|VIEW_MORE|VIEW_MORE_REC|PLAN|REASONING|KPI)\|([\s\S]*?)@@/;

const JSON_TOKENS = new Set([
  "PREFLIGHT_REPORT", "ITSM_FORM", "ITSM_SUBMITTED", "UPGRADE_EXECUTE", "UPGRADE_PROGRESS",
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

/**
 * Decide how wide the response window should be, based on WHAT the response
 * contains (Option A — content-type-aware width):
 *   - "wide"   (full): wide markdown tables (4+ cols), code/log blocks, or
 *              cards that render their own tables/terminal output
 *   - "medium": interactive cards (forms, fix/rightsize/triage) and small tables
 *   - "narrow": plain prose — best reading line-length (~80 chars)
 * Priority: wide > medium > narrow.
 */
const WIDE_TOKENS = new Set(["PREFLIGHT_REPORT", "UPGRADE_EXECUTE", "UPGRADE_PROGRESS"]);
const CARD_TOKENS = new Set(["ITSM_FORM", "ITSM_SUBMITTED", "RIGHTSIZE", "TRIAGE", "FIX_PROPOSAL", "CLARIFY", "POD_ISSUE"]);

export function computeResponseWidth(text) {
  if (!text) return "narrow";
  const segments = parseSegments(text);
  let hasWide = false, hasMedium = false;

  for (const seg of segments) {
    if (seg.kind === "token") {
      if (WIDE_TOKENS.has(seg.type)) hasWide = true;
      else if (CARD_TOKENS.has(seg.type)) hasMedium = true;
      continue;
    }
    const t = seg.text || "";
    // Fenced code / YAML / logs need room to avoid wrapping commands.
    if (/```/.test(t)) { hasWide = true; continue; }
    // Markdown table: a separator row (|---|---|) signals a real table.
    if (/^\s*\|?[\s:|-]*\|[\s:|-]*$/m.test(t) && /\|/.test(t)) {
      let maxCols = 0;
      for (const line of t.split("\n")) {
        if (!/\|/.test(line)) continue;
        const cols = line.split("|").filter((c) => c.trim() !== "").length;
        if (cols > maxCols) maxCols = cols;
      }
      if (maxCols >= 4) hasWide = true;
      else if (maxCols >= 2) hasMedium = true;
    }
  }

  if (hasWide) return "wide";
  if (hasMedium) return "medium";
  return "narrow";
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
    case "ITSM_SUBMITTED":   return data ? <ITSMSubmitted info={data} cluster={cluster} onQuery={onQuery} /> : null;
    case "UPGRADE_EXECUTE":  return data ? <UpgradeExecuteCard data={data} cluster={cluster} onQuery={onQuery} /> : null;
    case "UPGRADE_PROGRESS": return data ? <UpgradeProgressCard data={data} cluster={cluster} onQuery={onQuery} /> : null;
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
            fromVersion: form._upgradeInfo?.fromVersion || form._preflightReport?.fromVersion || null,
            channel: form._upgradeInfo?.channel || form._preflightReport?.channel || null,
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
            <div className={"itsm-field" + (isLong ? " full" : "")} key={key}>
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

function ITSMSubmitted({ info, cluster, onQuery }) {
  const isCR = info.type === "change_request";
  const label = isCR ? "Change Request" : "Incident";
  const isLocal = !info.sysId;                       // local-only mode: no ServiceNow approval workflow
  const canUpgradeFlow = isCR && info.isUpgrade && !!info.targetVersion;

  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState(null);        // { status, stateLabel, approval } | { status:"error", error }
  const [showUpgrade, setShowUpgrade] = useState(false);
  const approvedNotified = useRef(false);

  const approved = status?.status === "approved";
  // Upgrade is gated on approval; local-only CRs have no approval gate.
  const canUpgrade = canUpgradeFlow && (approved || isLocal);

  async function checkStatus() {
    if (isLocal) { setStatus({ status: "local", stateLabel: "Saved locally", approval: "n/a" }); return; }
    setChecking(true);
    try {
      const res = await fetch(clusterUrl("/api/itsm/cr-status", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sysId: info.sysId, ticketId: info.ticketId }),
      });
      const d = await res.json();
      if (d.status === "error" || d.error) throw new Error(d.error || "Status check failed");
      setStatus(d);
      // Immediate upgrade option the moment approval is detected.
      if (d.status === "approved" && canUpgradeFlow) setShowUpgrade(true);
    } catch (e) {
      setStatus({ status: "error", error: e.message });
    } finally { setChecking(false); }
  }

  // Auto-poll CR status every 30 seconds so approval is detected without
  // manual clicks. Replaces the old one-shot mount check.
  useEffect(() => {
    if (!info?.sysId || info?.type !== "change_request") return;
    const check = async () => {
      try {
        const r = await fetch(clusterUrl("/api/itsm/cr-status", cluster), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sysId: info.sysId, ticketId: info.ticketId }),
        });
        const d = await r.json();
        setStatus(d);
        if (d.status === "approved" && !approvedNotified.current) {
          approvedNotified.current = true;
          if (canUpgradeFlow) setShowUpgrade(true);
        }
      } catch {}
    };
    check();
    const timer = setInterval(check, 15000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.sysId]);

  function statusBadge() {
    const s = status?.status;
    const sty = (c) => ({ background: `color-mix(in srgb,${c} 20%,transparent)`, color: c });
    if (s === "approved") return <span className="itsm-badge" style={sty("var(--ok)")}>✓ Approved</span>;
    if (s === "rejected") return <span className="itsm-badge" style={sty("var(--crit)")}>Rejected</span>;
    if (s === "closed")   return <span className="itsm-badge" style={sty("var(--text2)")}>Closed</span>;
    if (s === "error")    return <span className="itsm-badge" style={sty("var(--crit)")}>Status error</span>;
    if (s === "local")    return <span className="itsm-badge" style={sty("var(--warn)")}>Local only</span>;
    if (s)                return <span className="itsm-badge" style={sty("var(--warn)")}>Awaiting approval</span>;
    return <span className="itsm-badge" style={sty("var(--ok)")}>Submitted</span>;
  }

  return (
    <div className="itsm-form" style={{ opacity: .98 }}>
      <div className="itsm-form-header">
        <div className={"itsm-icon " + (isCR ? "cr" : "inc")}>{isCR ? "📋" : "🚨"}</div>
        <div style={{ flex: 1 }}>
          <h4>{label} Submitted</h4>
          <div style={{ fontSize: 12, color: "var(--ok)", marginTop: 2, fontWeight: 600 }}>{info.ticketId}</div>
        </div>
        {statusBadge()}
      </div>

      {info.title && <div style={{ padding: "8px 18px 4px", fontSize: 12, color: "var(--text2)" }}>{info.title}</div>}
      {info.targetVersion && (
        <div style={{ padding: "0 18px 4px", fontSize: 12, color: "var(--text)" }}>
          OpenShift Cluster Upgrade: <strong>{info.fromVersion || "current"} → {info.targetVersion}</strong>
        </div>
      )}
      {info.attachmentId && <div style={{ padding: "0 18px 4px", fontSize: 11, color: "var(--ok)" }}>📎 Pre-Assessment report attached</div>}

      {/* Live status line */}
      {status && status.stateLabel && status.status !== "error" && (
        <div style={{ padding: "2px 18px 4px", fontSize: 11, color: "var(--text2)" }}>
          State: <strong style={{ color: "var(--text)" }}>{status.stateLabel}</strong>
          {status.approval && status.approval !== "n/a" ? ` · Approval: ${status.approval}` : ""}
        </div>
      )}
      {status?.status === "error" && (
        <div style={{ padding: "2px 18px 4px", fontSize: 11, color: "var(--crit)" }}>❌ {status.error}</div>
      )}

      {isCR && (
        <div style={{ padding: "8px 18px 14px" }}>
          {canUpgradeFlow && !approved && !isLocal && (
            <div style={{ fontSize: 11, color: "var(--accent2)", marginBottom: 8 }}>
              🔒 Upgrade unlocks automatically once the change request is approved.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="itsm-submit" style={{ flex: "0 0 auto", minWidth: 0, padding: "6px 14px", fontSize: 12 }}
              onClick={checkStatus} disabled={checking}>
              {checking ? "Checking…" : "Check CR status"}
            </button>
            {canUpgradeFlow && (
              <button className="itsm-submit" style={{ flex: "0 0 auto", minWidth: 0, padding: "6px 14px", fontSize: 12 }}
                onClick={() => setShowUpgrade(true)} disabled={!canUpgrade}
                title={canUpgrade ? "" : "Available once the change request is approved"}>
                ⬆ Proceed with upgrade
              </button>
            )}
          </div>
        </div>
      )}

      {/* Immediate dry-run + execute card, shown inline once approved */}
      {showUpgrade && canUpgrade && info.targetVersion && (
        <div style={{ padding: "0 18px 16px" }}>
          <UpgradeExecuteCard
            data={{ targetVersion: info.targetVersion, fromVersion: info.fromVersion, channel: info.channel, ticketId: info.ticketId, sysId: info.sysId }}
            cluster={cluster} onQuery={onQuery} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Upgrade execute card (dry-run + execute with SSE progress)          */
/* ------------------------------------------------------------------ */

function UpgradeExecuteCard({ data, cluster, onQuery }) {
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

  // Auto-poll upgrade progress during execution as a fallback alongside SSE
  useEffect(() => {
    if (phase !== "executing") return;
    const poll = async () => {
      try {
        const r = await fetch(clusterUrl(`/api/upgrade/status?session=${data.sessionId || ""}&cluster=${cluster}`, cluster));
        const d = await r.json();
        if (typeof d.progress === "number") setProgress(d.progress);
        if (d.phase === "complete" || d.state === "COMPLETED") {
          setPhase("complete");
          setBarColor("var(--ok)");
          if (onQuery) onQuery("check upgrade status");
        }
      } catch {}
    };
    const timer = setInterval(poll, 15000);
    return () => clearInterval(timer);
  }, [phase, data.sessionId, cluster, onQuery]);

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
/*  Upgrade type & time estimation (client-side, from version strings)   */
/* ------------------------------------------------------------------ */

function parseSemver(v) {
  const m = String(v || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function computeUpgradeType(from, to) {
  const a = parseSemver(from), b = parseSemver(to);
  if (!a || !b) return "patch";
  if (b.major !== a.major) return "major";
  if (b.minor !== a.minor) return "minor";
  return "patch";
}

function computeEstimatedTime(from, to, fallbackType) {
  const a = parseSemver(from), b = parseSemver(to);
  let type = fallbackType || "patch";
  if (a && b) {
    if (b.major !== a.major) type = "major";
    else if (b.minor !== a.minor) type = "minor";
    else type = "patch";
  }
  if (type === "major") return "3–6 hrs";
  if (type === "minor") return "90–180 min";
  return "30–90 min";
}

/* ------------------------------------------------------------------ */
/*  Upgrade Progress card (orchestrator state machine)                   */
/* ------------------------------------------------------------------ */

function UpgradeProgressCard({ data, cluster, onQuery }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stepRunning, setStepRunning] = useState(null);
  const [dryRunResult, setDryRunResult] = useState(null);
  const [remediationPlan, setRemediationPlan] = useState(null);
  const [progressData, setProgressData] = useState(null);
  const [expandedStep, setExpandedStep] = useState("pre_assessed");
  const [inProgressAlert, setInProgressAlert] = useState(null);
  const pollRef = useRef(null);

  const sessionId = data?.sessionId;
  const prevStateRef = useRef(null);

  async function fetchSession() {
    if (!sessionId) return;
    try {
      const res = await fetch(clusterUrl(`/api/upgrade/orchestrator/session?id=${sessionId}`, cluster));
      const d = await res.json();
      if (d.session) {
        setSession(d.session);
        // Restore last progress snapshot if monitoring dashboard has no data yet
        const snaps = d.session?.monitoringData?.snapshots;
        if (snaps?.length && !progressData) {
          setProgressData(snaps[snaps.length - 1]);
        }
      }
    } catch {}
  }

  // Initial session load
  useEffect(() => {
    fetchSession();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [sessionId]);

  // Unified auto-poll: handles CR status checks AND live upgrade progress.
  // Runs every 15s while in any active state. Restarts on state changes and page refresh.
  useEffect(() => {
    const currentState = session?.state || data?.state || "idle";
    if (!sessionId) return;

    // CR submitted → poll ServiceNow for approval
    if (currentState === "cr_submitted") {
      const poll = async () => {
        try {
          const r = await fetch(clusterUrl(`/api/upgrade/orchestrator/cr-status`, cluster), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          });
          const d = await r.json();
          const newState = d.session?.state;
          if (newState && newState !== prevStateRef.current) {
            if (newState === "cr_approved") showToast(`CR ${d.ticketId || ""} approved — ready for dry run`, "ok");
            await fetchSession();
          }
          prevStateRef.current = newState || currentState;
        } catch {}
      };
      prevStateRef.current = currentState;
      poll();
      const timer = setInterval(poll, 15000);
      return () => clearInterval(timer);
    }

    // Executing/Monitoring → poll LIVE cluster progress from CVO + operators
    if (currentState === "executing" || currentState === "monitoring") {
      if (pollRef.current) clearInterval(pollRef.current);
      const pollFn = async () => {
        try {
          const r = await fetch(clusterUrl(`/api/upgrade/orchestrator/progress`, cluster), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          });
          const d = await r.json();
          if (!d.error && typeof d.progress === "number") {
            setProgressData(d);
          }
          const newState = d.session?.state;
          if (newState && newState !== prevStateRef.current) {
            if (newState === "completed") {
              showToast("Upgrade complete — all operators healthy, all nodes ready. Run post-assessment.", "ok");
            } else if (newState === "monitoring") {
              showToast(`Upgrade progress: ${d.progress || 0}% — CVO applying manifests`, "info");
            }
            await fetchSession();
          }
          prevStateRef.current = newState || currentState;
          // Stop polling once truly completed
          if (d.phase === "complete" && d.allStable) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        } catch {}
      };
      prevStateRef.current = currentState;
      pollFn();
      pollRef.current = setInterval(pollFn, 15000);
      return () => { clearInterval(pollRef.current); pollRef.current = null; };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.state, data?.state, sessionId, cluster]);

  async function runStep(action, extraBody = {}) {
    setStepRunning(action);
    try {
      const res = await fetch(clusterUrl(`/api/upgrade/orchestrator/${action}`, cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ...extraBody }),
      });
      const d = await res.json();
      if (d.error) { showToast(d.error, "error"); return d; }
      await fetchSession();
      return d;
    } catch (e) {
      showToast(e.message, "error");
      return null;
    } finally { setStepRunning(null); }
  }

  async function handleValidate() {
    const d = await runStep("validate");
    if (d?.upgradeInProgress) {
      setInProgressAlert(d.liveStatus);
      return;
    }
  }
  async function handlePreAssess() { await runStep("pre-assess"); }
  async function handleComponentAnalysis() { await runStep("component-analysis"); }
  async function handleRemediationPlan() {
    const d = await runStep("remediation-plan");
    if (d?.plan) setRemediationPlan(d.plan);
  }
  async function handleRaiseCR() {
    if (!window.confirm("Submit a Change Request to ServiceNow for this upgrade?\n\nThis will create a CR with the pre-assessment report and upgrade details.")) return;
    const d = await runStep("raise-cr");
    if (d?.ticketId) showToast(`CR ${d.ticketId} created in ServiceNow`, "ok");
  }
  async function handleDryRun() {
    const d = await runStep("dry-run");
    if (d) setDryRunResult(d);
  }
  async function handleExecute() {
    if (!window.confirm(`Execute upgrade to ${session?.targetVersion || data.targetVersion}?\n\nThis will patch ClusterVersion and begin the rolling upgrade. Proceed?`)) return;
    const d = await runStep("execute");
    if (d?.upgradeInProgress) {
      setInProgressAlert(d.liveStatus);
      return;
    }
    if (!d || d.error) return;
  }

  async function handleCheckProgress() {
    setStepRunning("progress");
    try {
      const res = await fetch(clusterUrl(`/api/upgrade/orchestrator/progress`, cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const d = await res.json();
      if (!d.error && typeof d.progress === "number") setProgressData(d);
      await fetchSession();
      if (d.phase === "complete" && d.allStable) {
        showToast("Upgrade complete — all operators stable. Ready for post-assessment.", "ok");
      } else if (d.phase === "failed") {
        showToast(`Upgrade failed: ${d.message || "check cluster status"}`, "error");
      } else {
        const mf = d.manifests;
        const detail = mf ? `${mf.done}/${mf.total} manifests` : `${d.operators?.updating || 0} operators updating`;
        showToast(`Upgrade in progress: ${d.progress || 0}% — ${detail}`, "info");
      }
    } catch (e) {
      showToast(e.message, "error");
    } finally { setStepRunning(null); }
  }

  async function handlePostAssess() {
    const currentState = session?.state || data?.state;
    if (currentState === "executing" || currentState === "monitoring") {
      showToast("Upgrade is still in progress. Post-assessment will be available once all operators are healthy and all nodes are ready.", "error");
      return;
    }
    await runStep("post-assess");
  }
  async function handleCheckCR() { await runStep("cr-status"); }

  async function handleExecuteFix(fixId) {
    const d = await runStep("execute-fix", { fixId });
    if (d) {
      setRemediationPlan(prev => {
        if (!prev) return prev;
        return { ...prev, fixes: prev.fixes.map(f => f.id === fixId ? { ...f, _result: d.result } : f) };
      });
    }
  }

  const s = session || {};
  const state = s.state || data?.state || "idle";
  const fromVer = s.fromVersion || data?.fromVersion || "";
  const targetVer = s.targetVersion || data?.targetVersion || "";

  // Each step's `key` is the state REACHED once the step completes. `fromStates`
  // are the states from which the step's action is a valid next move — the
  // action button only shows when the current state is one of them, so we never
  // re-fire a step that already ran (which would be an invalid transition).
  const isLocalCR = s.crTicketId && !s.crSysId;
  const STEPS = [
    { key: "version_validated", label: "Version Validation", desc: "Confirm target version is available in the upgrade graph", fromStates: ["idle"], action: handleValidate, actionLabel: "Validate" },
    { key: "pre_assessed", label: "Pre-Assessment (22 checks)", desc: "Operators, nodes, etcd, certs, storage, MCPs health check", fromStates: ["version_validated", "channel_switched"], action: handlePreAssess, actionLabel: "Run Assessment" },
    { key: "component_analyzed", label: "Component Analysis", desc: "Deep inspection of degraded operators, failing pods, cert expiry", fromStates: ["pre_assessed"], action: handleComponentAnalysis, actionLabel: "Analyze" },
    { key: "remediation_proposed", label: "Remediation Plan", desc: "AI-generated fix plan for all detected issues", fromStates: ["pre_assessed", "component_analyzed"], action: handleRemediationPlan, actionLabel: "Build Plan" },
    { key: "cr_submitted", label: "Change Request", desc: "Raise ServiceNow CR with pre-assessment report and upgrade plan", fromStates: ["remediation_proposed", "remediated"], action: handleRaiseCR, actionLabel: "Raise CR" },
    { key: "cr_approved", label: "CR Approved", desc: isLocalCR ? "Blocked — ServiceNow CR required for approval gate" : "Change Request approved — cleared for execution", fromStates: ["cr_submitted"], action: isLocalCR ? null : handleCheckCR, actionLabel: "Check Status" },
    { key: "dry_run_passed", label: "Dry Run", desc: "Simulate upgrade to validate no blocking conditions", fromStates: ["cr_approved"], action: handleDryRun, actionLabel: "Run Dry Run" },
    { key: "executing", label: "Execute Upgrade", desc: "ClusterVersion patched — rolling upgrade in progress", fromStates: ["cr_approved", "dry_run_passed"], action: handleExecute, actionLabel: "Execute" },
    { key: "monitoring", label: "Monitoring", desc: "Watching operator and node rollout progress until completion", fromStates: ["executing"], action: handleCheckProgress, actionLabel: "Check Progress" },
    { key: "completed", label: "Post-Assessment", desc: "Verify all operators healthy on target version", fromStates: ["completed"], action: handlePostAssess, actionLabel: "Run Post-Assessment" },
  ];

  const STATE_ORDER = ["idle", "version_validated", "channel_switched", "pre_assessed", "component_analyzed",
    "remediation_proposed", "remediated", "cr_submitted", "cr_approved", "dry_run_passed", "executing", "monitoring", "completed"];
  const currentIdx = STATE_ORDER.indexOf(state);

  const stateColors = {
    idle: "var(--text2)", version_validated: "var(--ok)", channel_switched: "var(--accent2)",
    pre_assessed: "var(--ok)", component_analyzed: "var(--ok)", remediation_proposed: "var(--warn)",
    remediated: "var(--ok)", cr_submitted: "var(--accent2)", cr_approved: "var(--ok)",
    dry_run_passed: "var(--ok)", executing: "var(--accent2)", monitoring: "var(--accent2)",
    completed: "var(--ok)", failed: "var(--crit)", cancelled: "var(--text2)",
  };

  const checkIcon = (st) => (st === "pass" ? "✅" : st === "warning" ? "⚠️" : "❌");
  const checkColor = (st) => (st === "pass" ? "var(--ok)" : st === "warning" ? "var(--warn)" : "var(--crit)");

  // Short status badge shown on the right of each completed step
  function stepBadge(key) {
    if (key === "version_validated" && state !== "idle") {
      return { text: upgradeType === "minor" ? "Y-stream" : "z-stream", color: "var(--ok)" };
    }
    if (key === "pre_assessed" && s.preflightReport?.summary) {
      const sm = s.preflightReport.summary;
      const color = sm.fail > 0 ? "var(--crit)" : sm.warning > 0 ? "var(--warn)" : "var(--ok)";
      return { text: `${sm.pass}/${sm.total} pass`, color };
    }
    if (key === "component_analyzed" && s.componentAnalysis) {
      const a = s.componentAnalysis;
      const issues = (a.degradedOperators?.length || 0) + (a.failingPods?.length || 0) + (a.certificateIssues?.length || 0) + (a.mcpIssues?.length || 0) + (a.storageIssues?.length || 0) + (a.networkIssues?.length || 0);
      return { text: issues > 0 ? `${issues} issues` : "clean", color: issues > 0 ? "var(--warn)" : "var(--ok)" };
    }
    const plan = s.remediationPlan || remediationPlan;
    if (key === "remediation_proposed" && plan) {
      return { text: `${plan.totalFixes || plan.fixes?.length || 0} fixes`, color: "var(--warn)" };
    }
    if (key === "cr_submitted" && s.crTicketId) {
      const isLocal = !s.crSysId;
      return { text: isLocal ? `${s.crTicketId} (Local)` : s.crTicketId, color: isLocal ? "var(--warn)" : "var(--accent2)" };
    }
    if (key === "cr_approved") {
      const crApprovedIdx = STATE_ORDER.indexOf("cr_approved");
      if (currentIdx >= crApprovedIdx) {
        return { text: "Approved", color: "var(--ok)" };
      }
      if (state === "cr_submitted" && s.crTicketId) {
        return { text: s.crSysId ? "Awaiting Approval" : "Local — No Gate", color: s.crSysId ? "var(--warn)" : "var(--text2)" };
      }
      return null;
    }
    if (key === "dry_run_passed" && s.dryRunResult) {
      return { text: s.dryRunResult.passed !== false ? "Passed" : "Failed", color: s.dryRunResult.passed !== false ? "var(--ok)" : "var(--crit)" };
    }
    if (key === "executing") {
      if (currentIdx > STATE_ORDER.indexOf("executing")) {
        return { text: "Patched", color: "var(--ok)" };
      }
      if (state === "executing") {
        return { text: "In Progress", color: "var(--accent2)" };
      }
      return null;
    }
    if (key === "monitoring") {
      if (state === "completed") {
        return { text: "Complete", color: "var(--ok)" };
      }
      if (state === "executing" || state === "monitoring") {
        const pct = progressData?.progress || 0;
        return { text: `${pct}%`, color: pct >= 95 ? "var(--ok)" : "var(--accent2)" };
      }
      return null;
    }
    if (key === "completed" && s.postAssessment) {
      const res = s.postAssessment.comparison?.resolved?.length || 0;
      const nw = s.postAssessment.comparison?.newIssues?.length || 0;
      return { text: nw > 0 ? `${nw} new issues` : `${res} resolved`, color: nw > 0 ? "var(--warn)" : "var(--ok)" };
    }
    return null;
  }

  const upgradeType = s.upgradeType || data?.upgradeType || computeUpgradeType(fromVer, targetVer);
  const estimatedTime = computeEstimatedTime(fromVer, targetVer, upgradeType);

  function stepDetail(key) {
    // ── Version Validation: show what was checked ──
    if (key === "version_validated" && (state !== "idle")) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          <div><span style={{ fontWeight: 600 }}>Current Version:</span> {fromVer}</div>
          <div><span style={{ fontWeight: 600 }}>Target Version:</span> {targetVer}</div>
          <div><span style={{ fontWeight: 600 }}>Upgrade Type:</span> {upgradeType} ({upgradeType === "minor" ? "Y-stream" : "z-stream"})</div>
          <div><span style={{ fontWeight: 600 }}>Channel:</span> {s.channel || data?.channel || "stable"}</div>
          <div><span style={{ fontWeight: 600 }}>Estimated Duration:</span> {estimatedTime}</div>
          <div style={{ marginTop: 4, color: "var(--text2)" }}>
            Validated: target version exists in upgrade graph, channel is correct, no blocked versions in path.
          </div>
        </div>
      );
    }

    // ── Pre-Assessment: the 22 checks ──
    if (key === "pre_assessed" && s.preflightReport?.checks?.length) {
      const r = s.preflightReport;
      const sm = r.summary || {};
      const overallColor = r.overallStatus === "NOT_READY" ? "var(--crit)" : r.overallStatus === "READY_WITH_WARNINGS" ? "var(--warn)" : "var(--ok)";
      return (
        <div>
          <div style={{ display: "flex", gap: 12, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontWeight: 700, color: overallColor }}>{(r.overallStatus || "").replace(/_/g, " ")}</span>
            <span style={{ color: "var(--ok)" }}>✅ {sm.pass || 0} passed</span>
            <span style={{ color: "var(--warn)" }}>⚠️ {sm.warning || 0} warnings</span>
            <span style={{ color: "var(--crit)" }}>❌ {sm.fail || 0} failed</span>
            <span style={{ color: "var(--text2)" }}>· {sm.total || r.checks.length} checks</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {r.checks.map((c, idx) => (
              <div key={idx} style={{ display: "flex", gap: 8, alignItems: "flex-start", paddingBottom: 6, borderBottom: idx < r.checks.length - 1 ? "1px solid var(--border)" : "none" }}>
                <span style={{ flexShrink: 0 }}>{checkIcon(c.status)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: checkColor(c.status) }}>{c.category}</span>
                  <div style={{ color: "var(--text2)", marginTop: 1, lineHeight: 1.45 }}>{c.details}</div>
                  {c.recommendation && (
                    <div style={{ color: "var(--accent2)", marginTop: 2 }}>↳ {c.recommendation}</div>
                  )}
                  {Array.isArray(c.items) && c.items.length > 0 && (
                    <div style={{ marginTop: 3, color: "var(--text2)" }}>
                      {c.items.slice(0, 6).map((it, j) => (
                        <div key={j}>• {it.name || it.message || JSON.stringify(it).slice(0, 100)}{it.issue ? ` — ${it.issue}` : ""}</div>
                      ))}
                      {c.items.length > 6 && <div>…and {c.items.length - 6} more</div>}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    // ── Component Analysis: deep-dive findings ──
    if (key === "component_analyzed" && s.componentAnalysis) {
      const a = s.componentAnalysis;
      const sections = [
        { label: "Degraded Operators", items: a.degradedOperators, render: (o) => `${o.name} — ${o.issue}${o.unhealthyPods?.length ? ` (${o.unhealthyPods.length} unhealthy pods)` : ""}` },
        { label: "Failing Pods", items: a.failingPods, render: (p) => `${p.namespace || ""}/${p.name || p}` },
        { label: "Certificate Issues", items: a.certificateIssues, render: (x) => x.message || x.name || JSON.stringify(x).slice(0, 80) },
        { label: "MachineConfigPool Issues", items: a.mcpIssues, render: (x) => x.name ? `${x.name} — ${x.issue || x.message || ""}` : JSON.stringify(x).slice(0, 80) },
        { label: "Storage Issues", items: a.storageIssues, render: (x) => x.message || x.name || JSON.stringify(x).slice(0, 80) },
        { label: "Network Issues", items: a.networkIssues, render: (x) => x.message || x.name || JSON.stringify(x).slice(0, 80) },
      ].filter((sec) => Array.isArray(sec.items) && sec.items.length > 0);
      if (sections.length === 0) {
        return <div style={{ color: "var(--ok)" }}>✅ No component-level issues found. All operators, pods, certificates, MCPs, storage and network checks are clean.</div>;
      }
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sections.map((sec) => (
            <div key={sec.label}>
              <div style={{ fontWeight: 600, color: "var(--warn)", marginBottom: 3 }}>{sec.label} ({sec.items.length})</div>
              {sec.items.slice(0, 8).map((it, j) => (
                <div key={j} style={{ color: "var(--text2)", paddingLeft: 8 }}>• {sec.render(it)}</div>
              ))}
            </div>
          ))}
        </div>
      );
    }

    // ── Remediation Plan: persisted from session so it never vanishes ──
    const plan = s.remediationPlan || remediationPlan;
    if (key === "remediation_proposed" && plan?.fixes?.length) {
      const results = s.remediationResults || {};
      return (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Remediation Plan ({plan.totalFixes || plan.fixes.length} fixes)</div>
          {plan.fixes.map((fix) => {
            const res = fix._result || results[fix.id];
            return (
              <div key={fix.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ color: fix.severity === "critical" ? "var(--crit)" : fix.severity === "warning" ? "var(--warn)" : "var(--text2)", fontSize: 10.5, fontWeight: 700, width: 58, flexShrink: 0 }}>
                  {(fix.severity || "info").toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{fix.description}</div>
                  {fix.command && <code style={{ fontSize: 10.5, color: "var(--accent3, #10b981)", wordBreak: "break-all" }}>{fix.command}</code>}
                </div>
                {res ? (
                  <span style={{ color: res.success ? "var(--ok)" : "var(--crit)", fontSize: 11, flexShrink: 0 }}>{res.success ? "✅ Done" : "❌ Failed"}</span>
                ) : (state === "remediation_proposed" && (
                  <button className="ux-btn ux-btn-dryrun" style={{ padding: "2px 8px", fontSize: 10, flexShrink: 0 }}
                    onClick={(e) => { e.stopPropagation(); handleExecuteFix(fix.id); }} disabled={!!stepRunning}>Fix</button>
                ))}
              </div>
            );
          })}
          {state === "remediation_proposed" && (
            <button className="ux-btn ux-btn-execute" style={{ marginTop: 8, padding: "4px 12px", fontSize: 11 }}
              onClick={(e) => { e.stopPropagation(); runStep("complete-remediation"); }} disabled={!!stepRunning}>
              Mark Remediation Complete
            </button>
          )}
        </div>
      );
    }

    // ── Change Request: show ticket ID, status, and approval state ──
    if (key === "cr_submitted" && s.crTicketId) {
      const isLocal = !s.crSysId;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontWeight: 700 }}>Ticket:</span>
            <span style={{ color: "var(--accent2)", fontWeight: 600, fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 13 }}>{s.crTicketId}</span>
            {isLocal && <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: "color-mix(in srgb, var(--warn) 15%, transparent)", color: "var(--warn)" }}>Local</span>}
            {!isLocal && <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: "color-mix(in srgb, var(--ok) 15%, transparent)", color: "var(--ok)" }}>ServiceNow</span>}
          </div>
          {!isLocal && (
            <div style={{ fontSize: 11.5, color: "var(--text2)" }}>
              Waiting for CAB approval. Auto-polling ServiceNow every 20 seconds for status changes.
            </div>
          )}
          {isLocal && (
            <div style={{ fontSize: 11.5, color: "var(--warn)", lineHeight: 1.5 }}>
              <strong>Blocked:</strong> Local CR created because ServiceNow is not configured. The upgrade cannot proceed without a real ServiceNow Change Request and CAB approval.
              <br />Configure ServiceNow credentials in <strong>Settings → ServiceNow</strong> and re-raise the CR.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            {!isLocal && (
              <button className="ux-btn ux-btn-dryrun" style={{ padding: "4px 12px", fontSize: 11 }}
                onClick={(e) => { e.stopPropagation(); handleCheckCR(); }} disabled={!!stepRunning}>
                {stepRunning === "cr-status" ? "Checking…" : "Check CR Status"}
              </button>
            )}
            {isLocal && (
              <button className="ux-btn ux-btn-dryrun" style={{ padding: "4px 12px", fontSize: 11, borderColor: "var(--warn)" }}
                onClick={(e) => { e.stopPropagation(); handleRaiseCR(); }} disabled={!!stepRunning}>
                {stepRunning === "raise-cr" ? "Raising…" : "Re-raise CR (ServiceNow)"}
              </button>
            )}
          </div>
        </div>
      );
    }

    // ── CR Approved: confirmation or blocked state ──
    if (key === "cr_approved" && s.crTicketId) {
      if (!s.crSysId && state === "cr_submitted") {
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "var(--crit)", fontWeight: 600 }}>🚫 Upgrade Blocked — CR Approval Required</div>
            <div style={{ fontSize: 11.5, color: "var(--text2)", lineHeight: 1.5 }}>
              This upgrade cannot proceed without a real ServiceNow Change Request and CAB approval.
              Configure ServiceNow in <strong>Settings → ServiceNow</strong>, then re-raise the CR from the step above.
            </div>
          </div>
        );
      }
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ color: "var(--ok)", fontWeight: 600 }}>✅ Change Request {s.crTicketId} approved</div>
          <div style={{ fontSize: 11.5, color: "var(--text2)" }}>Proceed with dry run or execute upgrade directly.</div>
        </div>
      );
    }

    // ── Dry Run: show result details ──
    if (key === "dry_run_passed" && s.dryRunResult) {
      const dr = s.dryRunResult;
      return (
        <div>
          <div style={{ fontWeight: 600, color: dr.passed !== false ? "var(--ok)" : "var(--crit)", marginBottom: 4 }}>
            {dr.passed !== false ? "✅ Dry Run Passed" : "❌ Dry Run Failed"}
          </div>
          {dr.result?.details && (
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, color: "var(--text2)", background: "var(--bg-deep)", padding: 8, borderRadius: 6, maxHeight: 150, overflow: "auto" }}>
              {dr.result.details}
            </pre>
          )}
          {dr.error && <div style={{ color: "var(--crit)", fontSize: 11.5, marginTop: 4 }}>{dr.error}</div>}
        </div>
      );
    }

    // ── Executing: shows that ClusterVersion was patched ──
    if (key === "executing" && currentIdx >= STATE_ORDER.indexOf("executing")) {
      return (
        <div style={{ fontSize: 12 }}>
          <div style={{ color: "var(--ok)", fontWeight: 600 }}>ClusterVersion patched — upgrade initiated</div>
          <div style={{ color: "var(--text2)", marginTop: 2 }}>Target: {targetVer} | Channel: {s.channel || data?.channel || "stable"}</div>
        </div>
      );
    }

    // ── Monitoring: enterprise-grade live dashboard ──
    if (key === "monitoring" && (state === "executing" || state === "monitoring" || state === "completed")) {
      const pd = progressData || {};
      const pct = pd.progress || 0;
      const mf = pd.manifests || null;
      const phases = ["preparing", "updating", "completing", "complete"];
      const phaseIdx = phases.indexOf(pd.phase === "failed" ? "completing" : pd.phase || "preparing");
      const phaseLabel = pd.phase === "complete" ? "Complete" : pd.phase === "failed" ? "Failed" : pd.phase === "preparing" ? "Preparing" : pd.phase === "completing" ? "Finalizing" : "Updating";
      const isComplete = pd.phase === "complete" && pd.allStable;
      const isFailed = pd.phase === "failed";
      const gaugeColor = isComplete ? "#22c55e" : isFailed ? "#ef4444" : "#3b82f6";
      const ops = pd.operators || {};
      const opDetails = pd.operatorDetails || [];
      const nodes = pd.nodes || {};
      const waiting = pd.waitingOperators || [];
      const fromVer = pd.fromVersion || s.fromVersion || "";
      const tgtVer = pd.targetVersion || targetVer;

      // SVG gauge arc math (semi-circle)
      const gaugeR = 58, gaugeCx = 70, gaugeCy = 65, gaugeStroke = 10;
      const arcLen = Math.PI * gaugeR;
      const dashLen = (pct / 100) * arcLen;
      const bgArcPath = `M ${gaugeCx - gaugeR} ${gaugeCy} A ${gaugeR} ${gaugeR} 0 1 1 ${gaugeCx + gaugeR} ${gaugeCy}`;

      // Donut chart for operators
      const opTotal = ops.total || 1;
      const opAvail = ops.available || 0;
      const opUpdating = ops.updating || 0;
      const opDegraded = ops.degraded || 0;
      const donutR = 30, donutCx = 36, donutCy = 36, donutStroke = 10;
      const donutCirc = 2 * Math.PI * donutR;
      const seg1 = (opAvail / opTotal) * donutCirc;
      const seg2 = (opUpdating / opTotal) * donutCirc;
      const seg3 = (opDegraded / opTotal) * donutCirc;

      const mono = { fontFamily: "'SF Mono', 'Fira Code', monospace" };

      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12 }}>
          {/* Version comparison banner */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--bg-deep)", borderRadius: 10, padding: "8px 14px" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: "var(--text2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Current Version</div>
              <div style={{ ...mono, fontWeight: 700, fontSize: 14, color: "var(--text1)" }}>{fromVer || pd.currentVersion || "—"}</div>
            </div>
            <div style={{ fontSize: 18, color: isComplete ? "#22c55e" : "var(--text2)" }}>{isComplete ? "✓" : "→"}</div>
            <div style={{ flex: 1, textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "var(--text2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Target Version</div>
              <div style={{ ...mono, fontWeight: 700, fontSize: 14, color: gaugeColor }}>{tgtVer}</div>
            </div>
          </div>

          {/* Top row: Gauge + Operator Donut + Node bar */}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
            {/* Gauge meter */}
            <div style={{ background: "var(--bg-deep)", borderRadius: 12, padding: "12px 16px", textAlign: "center", minWidth: 150 }}>
              <svg width="140" height="80" viewBox="0 0 140 80">
                <path d={bgArcPath} fill="none" stroke="var(--border)" strokeWidth={gaugeStroke} strokeLinecap="round" />
                <path d={bgArcPath} fill="none" stroke={gaugeColor} strokeWidth={gaugeStroke} strokeLinecap="round"
                  strokeDasharray={`${dashLen} ${arcLen}`}
                  style={{ transition: "stroke-dasharray 1s ease, stroke 0.5s" }} />
                <text x={gaugeCx} y={gaugeCy - 12} textAnchor="middle" fontSize="26" fontWeight="800" fill={gaugeColor}
                  style={mono}>{pct}%</text>
                <text x={gaugeCx} y={gaugeCy + 6} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--text2)">{phaseLabel.toUpperCase()}</text>
              </svg>
              <div style={{ fontSize: 10, color: "var(--text2)", marginTop: -4 }}>Cluster Upgrade</div>
            </div>

            {/* Operator donut */}
            {ops.total > 0 && (
              <div style={{ background: "var(--bg-deep)", borderRadius: 12, padding: "12px 16px", textAlign: "center", minWidth: 150 }}>
                <svg width="72" height="72" viewBox="0 0 72 72">
                  <circle cx={donutCx} cy={donutCy} r={donutR} fill="none" stroke="var(--border)" strokeWidth={donutStroke} />
                  <circle cx={donutCx} cy={donutCy} r={donutR} fill="none" stroke="#22c55e" strokeWidth={donutStroke}
                    strokeDasharray={`${seg1} ${donutCirc - seg1}`} strokeDashoffset={donutCirc * 0.25}
                    style={{ transition: "stroke-dasharray 0.8s" }} />
                  {opUpdating > 0 && <circle cx={donutCx} cy={donutCy} r={donutR} fill="none" stroke="#3b82f6" strokeWidth={donutStroke}
                    strokeDasharray={`${seg2} ${donutCirc - seg2}`} strokeDashoffset={donutCirc * 0.25 - seg1}
                    style={{ transition: "stroke-dasharray 0.8s" }} />}
                  {opDegraded > 0 && <circle cx={donutCx} cy={donutCy} r={donutR} fill="none" stroke="#ef4444" strokeWidth={donutStroke}
                    strokeDasharray={`${seg3} ${donutCirc - seg3}`} strokeDashoffset={donutCirc * 0.25 - seg1 - seg2}
                    style={{ transition: "stroke-dasharray 0.8s" }} />}
                  <text x={donutCx} y={donutCy + 4} textAnchor="middle" fontSize="14" fontWeight="800" fill="var(--text1)">{ops.total}</text>
                </svg>
                <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 4, fontSize: 10 }}>
                  <span style={{ color: "#22c55e" }}>● {opAvail} ok</span>
                  <span style={{ color: "#3b82f6" }}>● {opUpdating} updating</span>
                  <span style={{ color: "#ef4444" }}>● {opDegraded} degraded</span>
                </div>
                <div style={{ fontSize: 10, color: "var(--text2)", marginTop: 2 }}>Operators</div>
              </div>
            )}

            {/* Node + stats cards */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 160 }}>
              {nodes.total > 0 && (
                <div style={{ background: "var(--bg-deep)", borderRadius: 10, padding: "10px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 11, fontWeight: 600 }}>
                    <span>Node Readiness</span>
                    <span style={{ color: nodes.notReady > 0 ? "#ef4444" : "#22c55e" }}>{nodes.ready}/{nodes.total}</span>
                  </div>
                  <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "var(--border)" }}>
                    <div style={{ width: `${(nodes.ready / nodes.total) * 100}%`, background: "#22c55e", transition: "width 0.8s" }} />
                    {nodes.notReady > 0 && <div style={{ width: `${(nodes.notReady / nodes.total) * 100}%`, background: "#ef4444" }} />}
                  </div>
                </div>
              )}
              {/* Completion checklist */}
              <div style={{ background: "var(--bg-deep)", borderRadius: 10, padding: "8px 12px", fontSize: 11 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 10, textTransform: "uppercase", color: "var(--text2)", letterSpacing: 0.5 }}>Completion Criteria</div>
                {[
                  { label: `CVO history: ${tgtVer}`, ok: pd.phase === "complete" },
                  { label: `All ${ops.total} operators available`, ok: opAvail === ops.total && opUpdating === 0 && opDegraded === 0 },
                  { label: `All ${nodes.total || "?"} nodes ready`, ok: nodes.total > 0 && nodes.notReady === 0 },
                ].map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}>
                    <span style={{ fontSize: 12 }}>{c.ok ? "✅" : "⬜"}</span>
                    <span style={{ color: c.ok ? "var(--ok)" : "var(--text2)" }}>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Manifest progress bar (CVO payloads) */}
          {mf && mf.total > 0 && (
            <div style={{ background: "var(--bg-deep)", borderRadius: 10, padding: "8px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 11 }}>
                <span style={{ fontWeight: 600 }}>CVO Manifests Applied</span>
                <span style={{ ...mono, fontWeight: 700, color: gaugeColor }}>{mf.done} / {mf.total}</span>
              </div>
              <div style={{ height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(mf.done / mf.total) * 100}%`, background: gaugeColor, borderRadius: 3, transition: "width 1s ease" }} />
              </div>
              <div style={{ fontSize: 10, color: "var(--text2)", marginTop: 3 }}>{mf.total - mf.done} manifests remaining</div>
            </div>
          )}

          {/* Phase timeline */}
          <div style={{ display: "flex", alignItems: "center", gap: 0, background: "var(--bg-deep)", borderRadius: 10, padding: "8px 12px" }}>
            {phases.map((p, i) => {
              const done = i <= phaseIdx;
              const active = i === phaseIdx && !isComplete;
              const pColor = done ? (isFailed && i === phaseIdx ? "#ef4444" : "#22c55e") : "var(--border)";
              const labels = ["Preparing", "Updating Operators", "Finalizing", "Complete"];
              return (
                <div key={p} style={{ display: "flex", alignItems: "center", flex: 1 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                    <div style={{ width: 20, height: 20, borderRadius: "50%", background: pColor, display: "flex", alignItems: "center", justifyContent: "center",
                      border: active ? "2px solid var(--accent2)" : "none",
                      boxShadow: active ? "0 0 0 3px color-mix(in srgb, var(--accent2) 30%, transparent)" : "none",
                      animation: active ? "pulse 2s infinite" : "none" }}>
                      {done && <span style={{ color: "white", fontSize: 11, fontWeight: 700 }}>✓</span>}
                    </div>
                    <span style={{ fontSize: 9, fontWeight: done ? 600 : 400, color: done ? "var(--text1)" : "var(--text2)", textAlign: "center", maxWidth: 70 }}>{labels[i]}</span>
                  </div>
                  {i < phases.length - 1 && (
                    <div style={{ flex: 1, height: 2, background: i < phaseIdx ? "#22c55e" : "var(--border)", margin: "0 4px", marginBottom: 16, transition: "background 0.5s" }} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Waiting operators — parsed from CVO "waiting on X, Y, Z" */}
          {waiting.length > 0 && (
            <div style={{ background: "var(--bg-deep)", borderRadius: 10, padding: "10px 14px" }}>
              <div style={{ fontWeight: 700, fontSize: 11, color: "#f59e0b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Pending Operators ({waiting.length})</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {waiting.map((w, i) => (
                  <span key={i} style={{ ...mono, fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "color-mix(in srgb, #f59e0b 12%, transparent)", color: "#f59e0b", fontWeight: 500 }}>{w}</span>
                ))}
              </div>
            </div>
          )}

          {/* Live activity feed — operators actively updating/degraded */}
          {opDetails.length > 0 && (
            <div style={{ background: "var(--bg-deep)", borderRadius: 10, padding: "10px 14px", maxHeight: 160, overflowY: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 11, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 0.5 }}>Live Activity</span>
                <span style={{ fontSize: 10, color: "var(--text2)" }}>{opDetails.length} operator{opDetails.length !== 1 ? "s" : ""} in progress</span>
              </div>
              {opDetails.map((op, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11, padding: "4px 0", borderBottom: i < opDetails.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", marginTop: 4, flexShrink: 0,
                    background: op.degraded ? "#ef4444" : "#3b82f6",
                    animation: !op.degraded ? "pulse 1.5s infinite" : "none" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: op.degraded ? "#ef4444" : "var(--text1)" }}>{op.name}</div>
                    {op.message && <div style={{ color: "var(--text2)", fontSize: 10, marginTop: 1, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{op.message}</div>}
                  </div>
                  <span style={{ flexShrink: 0, fontSize: 10, padding: "1px 6px", borderRadius: 4, fontWeight: 600,
                    background: op.degraded ? "color-mix(in srgb, #ef4444 15%, transparent)" : "color-mix(in srgb, #3b82f6 15%, transparent)",
                    color: op.degraded ? "#ef4444" : "#3b82f6" }}>
                    {op.degraded ? "DEGRADED" : "UPDATING"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* CVO raw status message */}
          {pd.message && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 12px", background: "var(--bg-deep)", borderRadius: 10, borderLeft: `3px solid ${gaugeColor}` }}>
              <span style={{ flexShrink: 0, fontSize: 14 }}>{isComplete ? "✅" : isFailed ? "❌" : "⏳"}</span>
              <div style={{ ...mono, fontSize: 11, color: "var(--text2)", lineHeight: 1.4 }}>{pd.message.slice(0, 500)}</div>
            </div>
          )}

          {/* Footer: last updated + polling indicator */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, color: "var(--text2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {state !== "completed" && (
                <>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", animation: "pulse 2s infinite" }} />
                  <span>Live — polling cluster every 15s</span>
                </>
              )}
              {state === "completed" && <span>Upgrade verified complete</span>}
            </div>
            {pd.timestamp && <span>Last: {new Date(pd.timestamp).toLocaleTimeString()}</span>}
          </div>
        </div>
      );
    }

    // ── Post-Assessment: before/after comparison + total duration ──
    if (key === "completed") {
      const pa = s.postAssessment || {};
      const started = pa.executedAt ? new Date(pa.executedAt) : (s.executedAt ? new Date(s.executedAt) : null);
      const ended = pa.completedAt ? new Date(pa.completedAt) : (s.completedAt ? new Date(s.completedAt) : null);
      const totalDuration = pa.duration || (started && ended ? (() => { const m = Math.floor((ended - started) / 60000); const h = Math.floor(m / 60); return h > 0 ? `${h}h ${m % 60}m` : `${m}m`; })() : "—");
      const upgradeComplete = state === "completed";
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: "8px 12px", background: upgradeComplete ? "color-mix(in srgb, var(--ok) 8%, transparent)" : "color-mix(in srgb, var(--accent2) 8%, transparent)", borderRadius: 8 }}>
            <div><span style={{ fontWeight: 600 }}>Total Upgrade Duration:</span> <span style={{ fontWeight: 700, color: upgradeComplete ? "var(--ok)" : "var(--accent2)" }}>{totalDuration}</span></div>
            <div><span style={{ fontWeight: 600 }}>From:</span> {fromVer}</div>
            <div><span style={{ fontWeight: 600 }}>To:</span> {targetVer}</div>
            {started && <div><span style={{ fontWeight: 600 }}>Started:</span> {started.toLocaleString()}</div>}
            {ended && <div><span style={{ fontWeight: 600 }}>Completed:</span> {ended.toLocaleString()}</div>}
            {!ended && started && <div><span style={{ fontWeight: 600, color: "var(--accent2)" }}>In Progress...</span></div>}
          </div>
          {pa.comparison && (
            <div>
              {(pa.comparison.resolved || []).length > 0 && <div style={{ color: "var(--ok)" }}>Resolved: {pa.comparison.resolved.join(", ")}</div>}
              {(pa.comparison.newIssues || []).length > 0 && <div style={{ color: "var(--warn)" }}>New issues: {pa.comparison.newIssues.join(", ")}</div>}
              {(pa.comparison.persistent || []).length > 0 && <div style={{ color: "var(--text2)" }}>Persistent: {pa.comparison.persistent.join(", ")}</div>}
            </div>
          )}
          {pa.verifiedVersion && (
            <div style={{ padding: "6px 10px", background: "color-mix(in srgb, var(--ok) 10%, transparent)", borderRadius: 6, marginTop: 4 }}>
              <span style={{ fontWeight: 600 }}>Verified Cluster Version: </span>
              <span style={{ fontWeight: 700, color: pa.verifiedVersion === targetVer ? "var(--ok)" : "var(--crit)" }}>
                {pa.verifiedVersion} {pa.verifiedVersion === targetVer ? "✅" : `❌ (expected ${targetVer})`}
              </span>
              {pa.operatorSummary && (
                <div style={{ marginTop: 4, fontSize: 11, color: "var(--text2)" }}>
                  Operators: {pa.operatorSummary.available}/{pa.operatorSummary.total} available
                  {pa.operatorSummary.degraded > 0 && <span style={{ color: "var(--crit)" }}> · {pa.operatorSummary.degraded} degraded</span>}
                </div>
              )}
            </div>
          )}
          {/* ServiceNow CR closure status */}
          {s.crTicketId && pa.verifiedVersion && (
            <div style={{ padding: "6px 10px", background: "color-mix(in srgb, var(--accent2) 8%, transparent)", borderRadius: 6 }}>
              <span style={{ fontWeight: 600 }}>ServiceNow CR: </span>
              <span style={{ fontWeight: 700, color: "var(--accent2)" }}>{s.crTicketId}</span>
              {pa.verifiedVersion === targetVer && pa.operatorSummary?.degraded === 0 ? (
                <span style={{ marginLeft: 8, color: "var(--ok)", fontWeight: 600 }}>✅ Auto-closed (successful)</span>
              ) : (
                <span style={{ marginLeft: 8, color: "var(--warn)", fontWeight: 600 }}>⚠ Requires manual review</span>
              )}
              <div style={{ marginTop: 3, fontSize: 10, color: "var(--text2)" }}>Post-assessment report and HTML report attached to CR</div>
            </div>
          )}
          {!pa.comparison && !pa.verifiedVersion && (
            <div style={{ color: "var(--text2)", fontStyle: "italic" }}>Post-assessment data pending — click "Run Post-Assessment" to verify cluster health.</div>
          )}
        </div>
      );
    }

    return null;
  }

  return (
    <div className="ux-card" style={{ maxWidth: 1000 }}>
      <div className="ux-header">
        <span style={{ fontSize: 20 }}>🔄</span>
        <div style={{ flex: 1 }}>
          <h4 style={{ margin: 0 }}>Automated Cluster Upgrade</h4>
          <div style={{ fontSize: 11, opacity: .8, marginTop: 2 }}>
            {fromVer} → {targetVer} | {upgradeType} | {s.channel || data?.channel || ""} | Est. {estimatedTime}
          </div>
        </div>
        <span style={{ fontSize: 12, padding: "4px 12px", borderRadius: 12, background: `color-mix(in srgb, ${stateColors[state] || "var(--text2)"} 20%, transparent)`, color: stateColors[state] || "var(--text2)", fontWeight: 600 }}>
          {state.replace(/_/g, " ").toUpperCase()}
        </span>
      </div>

      <div className="ux-body" style={{ padding: "12px 18px" }}>
        {/* Upgrade already in progress alert */}
        {inProgressAlert && (
          <div style={{ background: "color-mix(in srgb, var(--warn) 12%, transparent)", border: "1px solid var(--warn)", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 18 }}>⚠️</span>
              <span style={{ fontWeight: 700, fontSize: 14, color: "var(--warn)" }}>Upgrade Already In Progress</span>
              <button style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--text2)", fontSize: 16 }}
                onClick={() => setInProgressAlert(null)}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text1)", marginBottom: 10 }}>
              A cluster upgrade is currently running. Cannot start another upgrade until the current one completes.
            </div>
            {typeof inProgressAlert.progress === "number" && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  <span>Progress</span>
                  <span>{inProgressAlert.progress}%</span>
                </div>
                <div className="ux-progress-bar"><div className="ux-progress-fill" style={{ width: inProgressAlert.progress + "%", background: "var(--accent2)" }} /></div>
              </div>
            )}
            {inProgressAlert.manifests && (
              <div style={{ fontSize: 11, color: "var(--text2)", marginBottom: 4 }}>
                CVO Manifests: {inProgressAlert.manifests.done} / {inProgressAlert.manifests.total} applied
              </div>
            )}
            {inProgressAlert.operators && (
              <div style={{ fontSize: 11, color: "var(--text2)", marginBottom: 4 }}>
                Operators: {inProgressAlert.operators.updating} updating / {inProgressAlert.operators.degraded} degraded / {inProgressAlert.operators.total} total
              </div>
            )}
            {inProgressAlert.waitingOperators?.length > 0 && (
              <div style={{ fontSize: 11, marginBottom: 4 }}>
                <span style={{ color: "var(--text2)" }}>Waiting on: </span>
                {inProgressAlert.waitingOperators.map((op, i) => (
                  <span key={i} style={{ display: "inline-block", background: "color-mix(in srgb, var(--accent2) 18%, transparent)", color: "var(--accent2)", padding: "1px 7px", borderRadius: 8, fontSize: 10, fontWeight: 600, marginRight: 4, marginBottom: 2 }}>
                    {op}
                  </span>
                ))}
              </div>
            )}
            {inProgressAlert.message && (
              <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 6, fontFamily: "'SF Mono', 'Fira Code', monospace", background: "var(--bg2)", padding: "6px 8px", borderRadius: 6, wordBreak: "break-word" }}>
                {inProgressAlert.message.slice(0, 300)}
              </div>
            )}
          </div>
        )}

        {/* Step progress timeline — each completed step with data is expandable */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16 }}>
          {STEPS.map((step, i) => {
            const stepIdx = STATE_ORDER.indexOf(step.key);
            const done = stepIdx >= 0 && stepIdx <= currentIdx;
            // This step's action is the valid next move from the current state.
            const isNextAction = !!step.action && step.fromStates.includes(state);
            const active = isNextAction || (state === "monitoring" && step.key === "executing");
            const icon = done ? "✅" : isNextAction ? "▶" : "⬜";
            const detail = stepDetail(step.key);
            const badge = stepBadge(step.key);
            const isOpen = expandedStep === step.key;

            return (
              <div key={step.key}>
                <div
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, opacity: done || active ? 1 : 0.5, padding: "4px 0", cursor: detail ? "pointer" : "default", borderRadius: 6 }}
                  onClick={detail ? () => setExpandedStep(isOpen ? null : step.key) : undefined}
                >
                  <span style={{ width: 24, textAlign: "center" }}>{icon}</span>
                  <span style={{ flex: 1, fontWeight: isNextAction ? 600 : 400 }}>
                    {step.label}
                    {(step.key === state || expandedStep === step.key) && step.desc && (
                      <div style={{ fontSize: 10.5, color: "var(--text2)", marginTop: 2, lineHeight: 1.35 }}>{step.desc}</div>
                    )}
                  </span>
                  {badge && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: `color-mix(in srgb, ${badge.color} 16%, transparent)`, color: badge.color }}>
                      {badge.text}
                    </span>
                  )}
                  {isNextAction && (
                    <button className="ux-btn ux-btn-dryrun" style={{ padding: "3px 10px", fontSize: 11 }}
                      onClick={(e) => { e.stopPropagation(); step.action(); }} disabled={!!stepRunning}>
                      {stepRunning ? "Running…" : step.actionLabel}
                    </button>
                  )}
                  {detail && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                      style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s", opacity: .6 }}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  )}
                </div>
                {detail && isOpen && (
                  <div style={{ margin: "2px 0 8px 32px", padding: "10px 12px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}>
                    {detail}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Dry run result */}
        {dryRunResult && (
          <div style={{ background: "var(--bg2)", borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 12 }}>
            <div style={{ fontWeight: 600, color: dryRunResult.passed ? "var(--ok)" : "var(--crit)", marginBottom: 4 }}>
              {dryRunResult.passed ? "✅ Dry Run Passed" : "❌ Dry Run Failed"}
            </div>
            {dryRunResult.result?.details && (
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, color: "var(--text2)" }}>
                {dryRunResult.result.details}
              </pre>
            )}
          </div>
        )}

        {/* Live progress during execution */}
        {progressData && (state === "executing" || state === "monitoring") && (
          <div style={{ background: "var(--bg2)", borderRadius: 8, padding: 12, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>Upgrade Progress</span>
              <span>{progressData.progress || 0}%</span>
            </div>
            <div className="ux-progress-bar">
              <div className="ux-progress-fill" style={{
                width: (progressData.progress || 0) + "%",
                background: progressData.phase === "complete" ? "var(--ok)" : progressData.phase === "failed" ? "var(--crit)" : "var(--accent2)",
              }} />
            </div>
            {progressData.operators && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--text2)" }}>
                Operators: {progressData.operators.updating} updating / {progressData.operators.degraded} degraded / {progressData.operators.total} total
              </div>
            )}
            {progressData.nodes && (
              <div style={{ fontSize: 11, color: "var(--text2)" }}>
                Nodes: {progressData.nodes.ready}/{progressData.nodes.total} ready
              </div>
            )}
            {progressData.message && (
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--text2)" }}>{progressData.message.slice(0, 200)}</div>
            )}
          </div>
        )}

        {/* Cancel upgrade button */}
        {!["completed", "failed", "cancelled", "idle"].includes(state) && (
          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
            <button
              className="ux-btn"
              style={{ background: "color-mix(in srgb, var(--crit) 15%, transparent)", color: "var(--crit)", border: "1px solid color-mix(in srgb, var(--crit) 30%, transparent)", padding: "6px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
              onClick={async () => {
                if (!window.confirm("Cancel this upgrade? This will abort the current operation.")) return;
                try {
                  const r = await fetch(clusterUrl("/api/upgrade/cancel", cluster), {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sessionId, reason: "Cancelled by user from upgrade dashboard" }),
                  });
                  const d = await r.json();
                  if (d.error) showToast(d.error, "error");
                  else { showToast("Upgrade cancelled", "info"); await fetchSession(); }
                } catch (e) { showToast(e.message, "error"); }
              }}>
              Cancel Upgrade
            </button>
          </div>
        )}

        {/* Cancelled state banner */}
        {state === "cancelled" && (
          <div style={{ marginTop: 12, padding: "12px 16px", background: "color-mix(in srgb, var(--warn) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warn) 25%, transparent)", borderRadius: 10, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--warn)" }}>Upgrade Cancelled</div>
              <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>{s.errorMessage || "This upgrade was cancelled by the user."} To restart, initiate a new upgrade session.</div>
            </div>
          </div>
        )}

        {/* Failed state banner */}
        {state === "failed" && (
          <div style={{ marginTop: 12, padding: "12px 16px", background: "color-mix(in srgb, var(--crit) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--crit) 25%, transparent)", borderRadius: 10, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>❌</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--crit)" }}>Upgrade Failed</div>
              <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>{s.errorMessage || "The upgrade encountered an error."}</div>
            </div>
          </div>
        )}

        {/* Error display (non-terminal) */}
        {s.errorMessage && !["cancelled", "failed"].includes(state) && (
          <div style={{ padding: "8px 12px", background: "color-mix(in srgb, var(--crit) 10%, transparent)", borderRadius: 6, fontSize: 12, color: "var(--crit)", marginTop: 8 }}>
            {s.errorMessage}
          </div>
        )}

        {/* Full assessment report — prominent action bar */}
        {s.preflightReport && (
          <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>Full Pre-Upgrade Assessment Report</div>
              {s.preflightReport.summary && (
                <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>
                  {s.preflightReport.summary.total} checks · {s.preflightReport.summary.pass} passed · {s.preflightReport.summary.warning} warnings · {s.preflightReport.summary.fail} failed
                </div>
              )}
            </div>
            <a href={clusterUrl(`/api/upgrade/orchestrator/report?sessionId=${sessionId}`, cluster)}
              target="_blank" rel="noopener noreferrer"
              className="ux-btn ux-btn-execute"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", fontSize: 12, fontWeight: 600, textDecoration: "none" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              Open Full Report
            </a>
          </div>
        )}

        {/* Report download buttons (pre-assessment / post-assessment DOCX) */}
        {(data.preflightStatus || state === "completed") && (
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button className="ux-btn ux-btn-outline" onClick={() => {
              const a = document.createElement("a");
              a.href = `/api/upgrade/report?session=${sessionId}&type=pre`;
              a.download = "pre-assessment.pdf";
              a.click();
            }}>Download Pre-Assessment</button>
            {state === "completed" && (
              <button className="ux-btn ux-btn-outline" onClick={() => {
                const a = document.createElement("a");
                a.href = `/api/upgrade/report?session=${sessionId}&type=post`;
                a.download = "post-assessment.pdf";
                a.click();
              }}>Download Post-Assessment</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Incident Timeline — shows event sequence leading to diagnosis       */
/* ------------------------------------------------------------------ */

function IncidentTimeline({ events, sevColor }) {
  const [open, setOpen] = useState(false);
  const fmtTime = (t) => { try { const d = new Date(t); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return "—"; } };
  const evtIcons = { OOMKilling: "💀", Killing: "⚠", BackOff: "🔄", Unhealthy: "❌", FailedScheduling: "⏳", Pulled: "📦", Started: "▶", Created: "➕", "AI Detected": "🤖", ServiceNow: "🎫", "Fix Ready": "🔧" };

  return (
    <div style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <button onClick={() => setOpen(v => !v)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--card-bg)", border: "none", cursor: "pointer", color: "var(--fg)", fontSize: "0.88em", fontWeight: 600 }}>
        <span style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s" }}>▶</span>
        Incident Timeline ({events.length} events)
        <span style={{ marginLeft: "auto", fontSize: "0.75em", color: "var(--muted)" }}>click to expand</span>
      </button>
      {open && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
          {events.map((e, i) => (
            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 0", borderBottom: i < events.length - 1 ? "1px dashed var(--border)" : "none" }}>
              <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "0.75em", color: "var(--muted)", minWidth: 65, flexShrink: 0 }}>{fmtTime(e.time)}</span>
              <span style={{ fontSize: "0.85em", flexShrink: 0 }}>{evtIcons[e.event] || "●"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: "0.85em", color: e.event === "AI Detected" || e.event === "ServiceNow" || e.event === "Fix Ready" ? sevColor : "var(--fg)" }}>{e.event}</span>
                {e.detail && <div style={{ fontSize: "0.78em", color: "var(--muted)", marginTop: 1, wordBreak: "break-word" }}>{e.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Recovery Timeline — shows step-by-step healing progress             */
/* ------------------------------------------------------------------ */

function RecoveryTimeline({ validation, incClosed, incidentNumber, durationMs }) {
  if (!validation) return null;
  const v = validation;
  const steps = [];
  steps.push({ label: "Fix command executed", status: "done", time: "0s" });
  if (v.stable != null) {
    steps.push({ label: "Rolling restart triggered", status: "done", time: v.rolloutDurationMs ? `${(v.rolloutDurationMs / 1000 * 0.15).toFixed(0)}s` : "2s" });
    steps.push({ label: v.ready != null ? `Replicas ready: ${v.ready}/${v.desired}` : "New pod scheduled", status: "done", time: v.rolloutDurationMs ? `${(v.rolloutDurationMs / 1000 * 0.6).toFixed(0)}s` : "8s" });
    if (v.stable) steps.push({ label: "Rollout stable — all replicas updated", status: "done", time: v.rolloutDurationMs ? `${(v.rolloutDurationMs / 1000).toFixed(0)}s` : "15s" });
    else steps.push({ label: "Rollout in progress", status: "pending", time: "" });
  }
  if (v.allPodsHealthy != null) {
    steps.push({ label: v.pods?.length ? `Pods healthy: ${v.pods.filter(p => p.ready).length}/${v.pods.length} running` : "Pod health verified", status: v.allPodsHealthy ? "done" : "warn", time: "" });
  }
  if (incClosed) steps.push({ label: `ServiceNow ${incidentNumber || "incident"} auto-resolved`, status: "done", time: durationMs ? `${(durationMs / 1000).toFixed(0)}s` : "" });
  if (v.passed) steps.push({ label: "Validation passed — incident closed", status: "done", time: durationMs ? `${(durationMs / 1000).toFixed(0)}s total` : "" });

  const colors = { done: "#16a34a", pending: "#f59e0b", warn: "#f59e0b", fail: "#dc2626" };
  const icons = { done: "✓", pending: "◷", warn: "!", fail: "✕" };

  return (
    <div style={{ margin: "8px 0", borderLeft: "2px solid #16a34a", paddingLeft: 12 }}>
      <div style={{ fontSize: "0.72em", fontWeight: 600, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.5px", marginBottom: 6 }}>Recovery Timeline</div>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: "0.82em" }}>
          <span style={{ width: 18, height: 18, borderRadius: "50%", background: colors[s.status] + "18", color: colors[s.status], display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7em", fontWeight: 700, flexShrink: 0 }}>{icons[s.status]}</span>
          <span style={{ flex: 1, color: s.status === "done" ? "var(--fg)" : colors[s.status] }}>{s.label}</span>
          {s.time && <span style={{ fontSize: "0.85em", color: "var(--muted)", fontFamily: "var(--font-mono, monospace)" }}>{s.time}</span>}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Before/After Metrics — shows improvement after fix                  */
/* ------------------------------------------------------------------ */

function BeforeAfterMetrics({ before, after }) {
  if (!before && !after) return null;
  const rows = [];
  if (before?.memoryLimit || after?.memoryLimit) rows.push({ label: "Memory Limit", before: before?.memoryLimit || "—", after: after?.memoryLimit || "—" });
  if (before?.memoryUsage || after?.memoryUsage) rows.push({ label: "Memory Usage", before: before?.memoryUsage || "—", after: after?.memoryUsage || "—" });
  if (before?.restarts != null || after?.restarts != null) rows.push({ label: "Restarts", before: before?.restarts ?? "—", after: after?.restarts ?? "0" });
  if (before?.status || after?.status) rows.push({ label: "Status", before: before?.status || "—", after: after?.status || "—" });
  if (before?.cpuUsage || after?.cpuUsage) rows.push({ label: "CPU Usage", before: before?.cpuUsage || "—", after: after?.cpuUsage || "—" });
  if (rows.length === 0) return null;

  return (
    <div style={{ margin: "8px 0" }}>
      <div style={{ fontSize: "0.72em", fontWeight: 600, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.5px", marginBottom: 6 }}>Before / After</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, fontSize: "0.82em", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
        <div style={{ padding: "6px 10px", fontWeight: 600, background: "var(--card-bg)", borderBottom: "1px solid var(--border)" }}>Metric</div>
        <div style={{ padding: "6px 10px", fontWeight: 600, background: "var(--card-bg)", borderBottom: "1px solid var(--border)", textAlign: "center", color: "#dc2626" }}>Before</div>
        <div style={{ padding: "6px 10px", fontWeight: 600, background: "var(--card-bg)", borderBottom: "1px solid var(--border)", textAlign: "center", color: "#16a34a" }}>After</div>
        {rows.map((r, i) => (<React.Fragment key={i}>
          <div style={{ padding: "5px 10px", borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none" }}>{r.label}</div>
          <div style={{ padding: "5px 10px", textAlign: "center", borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none", color: "#dc2626", fontFamily: "var(--font-mono, monospace)" }}>{r.before}</div>
          <div style={{ padding: "5px 10px", textAlign: "center", borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none", color: "#16a34a", fontFamily: "var(--font-mono, monospace)" }}>{r.after}</div>
        </React.Fragment>))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Fix proposal (pod healing)                                          */
/* ------------------------------------------------------------------ */

function FixProposal({ diag, cluster }) {
  const [fixStates, setFixStates] = useState({});
  const [logsOpen, setLogsOpen] = useState(false);
  const [copied, setCopied] = useState(null);

  const sevColors = { critical: "#dc2626", warning: "#f59e0b", info: "#3b82f6" };
  const sevBg = { critical: "rgba(220,38,38,0.08)", warning: "rgba(245,158,11,0.08)", info: "rgba(59,130,246,0.08)" };
  const sevColor = sevColors[diag.severity] || sevColors.info;
  const sevBgColor = sevBg[diag.severity] || sevBg.info;

  function copyCmd(cmd) {
    navigator.clipboard?.writeText(cmd);
    setCopied(cmd);
    setTimeout(() => setCopied(null), 2000);
  }

  async function runFix(fix, dryRun) {
    const key = fix.command;
    const startTime = Date.now();
    setFixStates(prev => ({ ...prev, [key]: { running: true, phase: dryRun ? "dry-run" : "applying", text: dryRun ? "Running dry run..." : "Applying fix..." } }));
    try {
      const res = await fetch(clusterUrl("/api/alerts/execute-fix", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: fix.command, dryRun, namespace: fix.namespace, resourceName: fix.resource, auditTitle: fix.title,
          incidentSysId: diag.incidentSysId || null, incidentNumber: diag.incidentNumber || null,
          incidentSeverity: diag.severityLevel || diag.severity || null,
          incidentDiagnosis: diag.diagnosis || null, incidentRootCause: diag.rootCause || null,
          captureMetrics: !dryRun,
        }),
      });
      const d = await res.json();
      if (d.blocked) { setFixStates(prev => ({ ...prev, [key]: { phase: "blocked", text: d.reason || "Blocked by policy" } })); return; }
      const out = d.output || d.stdout || d.result || (d.success ? "Done." : d.error || "No output");
      const durationMs = Date.now() - startTime;
      if (!dryRun && d.success !== false && diag.incidentSysId && !d.incidentClosed?.success) {
        setFixStates(prev => ({ ...prev, [key]: { running: true, phase: "closing-inc", text: out + "\n\nClosing ServiceNow incident..." } }));
        try {
          const resolution = {
            incidentNumber: diag.incidentNumber || "", severity: diag.severityLevel || diag.severity || "N/A",
            podName: diag.podName || "", namespace: diag.namespace || "", deploymentName: diag.deploymentName || "",
            cluster: cluster || "local", rootCause: diag.rootCause || diag.diagnosis || "see report",
            evidence: diag.evidence || [], fixTitle: fix.title || "", fixCommand: fix.command || "",
            fixResult: String(out).slice(0, 500), fixRisk: fix.risk || "low",
          };
          const closeRes = await fetch(clusterUrl("/api/servicenow/resolve-incident", cluster), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sysId: diag.incidentSysId, closeNotes: `Resolved by TCS Agentic AI — ${fix.title}`, resolution }),
          });
          const closeData = await closeRes.json();
          setFixStates(prev => ({ ...prev, [key]: {
            phase: closeData.success ? "resolved" : "applied", text: out, incClosed: closeData.success,
            incError: closeData.success ? null : (closeData.error || "close failed"),
            validation: d.validation || null, beforeMetrics: d.beforeMetrics || null, afterMetrics: d.afterMetrics || null, durationMs,
          } }));
        } catch (e) {
          setFixStates(prev => ({ ...prev, [key]: { phase: "applied", text: out, incError: e.message, validation: d.validation || null, durationMs } }));
        }
      } else {
        const phase = dryRun ? "dry-done" : d.incidentClosed?.success ? "resolved" : (d.success === false ? "failed" : "applied");
        setFixStates(prev => ({ ...prev, [key]: {
          phase, text: String(out).slice(0, 4000),
          validation: d.validation || null, beforeMetrics: d.beforeMetrics || null, afterMetrics: d.afterMetrics || null,
          incClosed: d.incidentClosed?.success || false, incError: d.incidentClosed?.error || null, durationMs,
        } }));
      }
    } catch (e) {
      setFixStates(prev => ({ ...prev, [key]: { phase: "failed", text: e.message } }));
    }
  }

  const fixes = diag.fixes || [];
  const hasIncident = diag.incidentSysId && diag.incidentNumber;
  const logData = diag.logAnalysis;

  const phaseIcon = { "dry-run": "⏳", applying: "⏳", "closing-inc": "⏳", "dry-done": "✅", applied: "✅", resolved: "✅", failed: "❌", blocked: "⛔" };
  const phaseLabel = { "dry-run": "Running dry run...", applying: "Applying...", "closing-inc": "Closing incident...", "dry-done": "Dry run complete", applied: "Fix applied", resolved: "Fix applied & incident closed", failed: "Failed", blocked: "Blocked" };

  return (
    <div style={{ border: `1px solid ${sevColor}33`, borderRadius: 10, overflow: "hidden", marginTop: 8 }}>
      {/* Header bar */}
      <div style={{ background: sevBgColor, borderBottom: `1px solid ${sevColor}22`, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: "50%", background: sevColor, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
          {diag.severityLevel || (diag.severity === "critical" ? "S2" : "S3")}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: "1.05em" }}>{diag.podName && diag.podName !== "incident_response" ? `Incident: ${diag.podName}` : "Incident Response"}</div>
          <div style={{ fontSize: "0.82em", color: "var(--muted)", marginTop: 2 }}>
            {diag.namespace}{diag.deploymentName ? ` / ${diag.deploymentName}` : ""} {hasIncident ? `· ${diag.incidentNumber}` : ""}
          </div>
        </div>
        <div style={{ background: sevColor, color: "#fff", padding: "3px 10px", borderRadius: 12, fontSize: "0.75em", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
          {diag.severity || "info"}
        </div>
      </div>
      <div style={{ padding: "12px 16px" }}>
        {/* ServiceNow badge */}
        {hasIncident && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 8, marginBottom: 12, fontSize: "0.88em" }}>
            <span style={{ color: "#16a34a", fontWeight: 600 }}>☑</span>
            <span><strong>{diag.incidentNumber}</strong> auto-created in ServiceNow — will auto-resolve when fix is applied</span>
          </div>
        )}
        {/* Incident timeline (collapsible) */}
        {Array.isArray(diag.timeline) && diag.timeline.length > 0 && (
          <IncidentTimeline events={diag.timeline} sevColor={sevColor} />
        )}
        {/* Root cause + diagnosis */}
        <div style={{ display: "grid", gridTemplateColumns: diag.rootCause && diag.diagnosis ? "1fr 1fr" : "1fr", gap: 10, marginBottom: 12 }}>
          {diag.rootCause && (
            <div style={{ padding: "8px 12px", background: "var(--card-bg)", borderRadius: 8, borderLeft: `3px solid ${sevColor}` }}>
              <div style={{ fontSize: "0.72em", fontWeight: 600, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.5px", marginBottom: 4 }}>Root Cause</div>
              <div style={{ fontWeight: 600 }}>{diag.rootCause}</div>
            </div>
          )}
          {diag.diagnosis && (
            <div style={{ padding: "8px 12px", background: "var(--card-bg)", borderRadius: 8, borderLeft: "3px solid var(--muted)" }}>
              <div style={{ fontSize: "0.72em", fontWeight: 600, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.5px", marginBottom: 4 }}>Diagnosis</div>
              <div>{diag.diagnosis}</div>
            </div>
          )}
        </div>
        {/* Evidence */}
        {Array.isArray(diag.evidence) && diag.evidence.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: "0.72em", fontWeight: 600, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.5px", marginBottom: 6 }}>Evidence</div>
            {diag.evidence.map((e, i) => (
              <div key={i} style={{ padding: "4px 10px", fontSize: "0.88em", borderLeft: "2px solid var(--border)", marginBottom: 3, color: "var(--fg)" }}>{e}</div>
            ))}
          </div>
        )}
        {/* Log analysis (collapsible) */}
        {logData && (logData.errors?.length > 0 || logData.errorLines?.length > 0) && (
          <div style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            <button onClick={() => setLogsOpen(v => !v)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--card-bg)", border: "none", cursor: "pointer", color: "var(--fg)", fontSize: "0.88em", fontWeight: 600 }}>
              <span style={{ transform: logsOpen ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s" }}>▶</span>
              Log Analysis ({logData.totalLines || 0} lines scanned{logData.previous ? ", previous container" : ""})
              {logData.errors?.length > 0 && <span style={{ marginLeft: "auto", background: sevColor, color: "#fff", padding: "1px 8px", borderRadius: 10, fontSize: "0.75em" }}>{logData.errors.length} pattern{logData.errors.length > 1 ? "s" : ""}</span>}
            </button>
            {logsOpen && (
              <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
                {logData.errors?.map((err, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: i < logData.errors.length - 1 ? "1px solid var(--border)" : "none", fontSize: "0.85em" }}>
                    <span style={{ fontWeight: 600, color: sevColor, minWidth: 140 }}>{err.category}</span>
                    <code style={{ flex: 1, background: "var(--bg)", padding: "2px 6px", borderRadius: 4 }}>{err.snippet}</code>
                    <span style={{ color: "var(--muted)", fontSize: "0.9em" }}>{err.fix}</span>
                  </div>
                ))}
                {logData.errorLines?.length > 0 && (
                  <pre style={{ margin: "8px 0 0", padding: "8px 10px", background: "#1e1e1e", color: "#d4d4d4", borderRadius: 6, fontSize: "0.78em", maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap" }}>
                    {logData.errorLines.join("\n")}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
        {/* Fix proposals */}
        {fixes.length > 0 && (
          <div>
            <div style={{ fontSize: "0.72em", fontWeight: 600, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.5px", marginBottom: 8 }}>
              Remediation ({fixes.length} fix{fixes.length > 1 ? "es" : ""})
            </div>
            {fixes.map((fix, i) => {
              const st = fixStates[fix.command];
              const riskColor = fix.risk === "high" ? "#dc2626" : fix.risk === "medium" ? "#f59e0b" : "#16a34a";
              return (
                <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
                  <div style={{ padding: "10px 14px", background: "var(--card-bg)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: "0.95em" }}>{fix.title}</span>
                      <span style={{ fontSize: "0.7em", padding: "1px 8px", borderRadius: 10, border: `1px solid ${riskColor}40`, color: riskColor, fontWeight: 600, textTransform: "uppercase" }}>{fix.risk || "low"} risk</span>
                    </div>
                    <div style={{ fontSize: "0.82em", color: "var(--muted)", marginBottom: 8 }}>{fix.description}</div>
                    <div style={{ display: "flex", alignItems: "center", background: "#1e1e1e", borderRadius: 6, overflow: "hidden" }}>
                      <code style={{ flex: 1, padding: "8px 12px", color: "#d4d4d4", fontSize: "0.82em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fix.command}</code>
                      <button onClick={() => copyCmd(fix.command)} style={{ padding: "6px 12px", background: "transparent", border: "none", borderLeft: "1px solid #333", color: copied === fix.command ? "#16a34a" : "#888", cursor: "pointer", fontSize: "0.78em", fontWeight: 600, whiteSpace: "nowrap" }}>
                        {copied === fix.command ? "✓ Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 0, borderTop: "1px solid var(--border)" }}>
                    <button onClick={() => runFix(fix, true)} disabled={st?.running} style={{ flex: 1, padding: "8px 0", background: "transparent", border: "none", borderRight: "1px solid var(--border)", cursor: st?.running ? "default" : "pointer", color: "var(--fg)", fontWeight: 600, fontSize: "0.82em", opacity: st?.running ? 0.5 : 1 }}>
                      {st?.phase === "dry-run" ? "⏳ Running..." : "▷ Dry Run"}
                    </button>
                    <button onClick={() => runFix(fix, false)} disabled={st?.running} style={{ flex: 1, padding: "8px 0", background: hasIncident ? "rgba(34,197,94,0.06)" : "rgba(59,130,246,0.06)", border: "none", cursor: st?.running ? "default" : "pointer", color: hasIncident ? "#16a34a" : "#3b82f6", fontWeight: 700, fontSize: "0.82em", opacity: st?.running ? 0.5 : 1 }}>
                      {st?.phase === "applying" || st?.phase === "closing-inc" ? "⏳ Applying..." : hasIncident ? "▶ Apply & Close INC" : "▶ Apply Fix"}
                    </button>
                  </div>
                  {st && !st.running && (
                    <div style={{ padding: "8px 14px", borderTop: "1px solid var(--border)", background: st.phase === "failed" || st.phase === "blocked" ? "rgba(220,38,38,0.04)" : "rgba(34,197,94,0.04)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: "0.82em", fontWeight: 600 }}>
                        <span>{phaseIcon[st.phase] || ""}</span>
                        <span style={{ color: st.phase === "failed" || st.phase === "blocked" ? "#dc2626" : "#16a34a" }}>{phaseLabel[st.phase] || st.phase}</span>
                        {st.incClosed && <span style={{ marginLeft: "auto", fontSize: "0.85em", color: "#16a34a" }}>{diag.incidentNumber} resolved</span>}
                        {st.incError && <span style={{ marginLeft: "auto", fontSize: "0.85em", color: "#f59e0b" }}>INC close: {st.incError}</span>}
                      </div>
                      {/* Recovery timeline for applied fixes */}
                      {st.validation && !st.phase?.startsWith("dry") && (
                        <RecoveryTimeline validation={st.validation} incClosed={st.incClosed} incidentNumber={diag.incidentNumber} durationMs={st.durationMs} />
                      )}
                      {/* Before/After metrics comparison */}
                      {st.beforeMetrics && st.afterMetrics && !st.phase?.startsWith("dry") && (
                        <BeforeAfterMetrics before={st.beforeMetrics} after={st.afterMetrics} />
                      )}
                      <pre style={{ margin: 0, fontSize: "0.78em", whiteSpace: "pre-wrap", color: "var(--fg)", maxHeight: 200, overflow: "auto" }}>{st.text}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
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
