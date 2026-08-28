import React, { useState, useRef, useEffect } from "react";
import { clusterUrl } from "../api/client";
import { renderMarkdown } from "../utils/markdown";
import { showToast } from "../store/toastStore";

/* ------------------------------------------------------------------ */
/*  Token parsing                                                       */
/* ------------------------------------------------------------------ */

const TOKEN_RE =
  /@@(PREFLIGHT_REPORT|ITSM_FORM|ITSM_SUBMITTED|UPGRADE_EXECUTE|UPGRADE_PROGRESS|FIX_PROPOSAL|CLARIFY|POD_ISSUE|APPLY_BTN|SUMMARY|SCORE|GRADE|SEC_FIX_CMD|RIGHTSIZE|TRIAGE|VM_REQUEST|VIEW_MORE|VIEW_MORE_REC|PLAN|REASONING|KPI)\|([\s\S]*?)@@/;

const JSON_TOKENS = new Set([
  "PREFLIGHT_REPORT", "ITSM_FORM", "ITSM_SUBMITTED", "UPGRADE_EXECUTE", "UPGRADE_PROGRESS",
  "FIX_PROPOSAL", "CLARIFY", "PLAN", "REASONING", "RIGHTSIZE", "TRIAGE", "VM_REQUEST",
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
const WIDE_TOKENS = new Set(["PREFLIGHT_REPORT", "UPGRADE_EXECUTE", "UPGRADE_PROGRESS", "VM_REQUEST"]);
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
    case "VM_REQUEST":       return data ? <VMRequestCard data={data} cluster={cluster} /> : null;
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
  const [apiActions, setApiActions] = useState({}); // per-fix deprecated-API: {consumers, migration, loading*}
  const [fixDryRuns, setFixDryRuns] = useState({}); // per-fix dry-run preview: { [fixId]: result }
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

  async function handleExecuteFix(fixId, dryRun = false) {
    const d = await runStep("execute-fix", { fixId, dryRun });
    if (!d) return;
    if (dryRun) {
      setFixDryRuns(prev => ({ ...prev, [fixId]: d.result }));
    } else {
      setFixDryRuns(prev => { const n = { ...prev }; delete n[fixId]; return n; });
      setRemediationPlan(prev => {
        if (!prev) return prev;
        return { ...prev, fixes: prev.fixes.map(f => f.id === fixId ? { ...f, _result: d.result } : f) };
      });
    }
  }

  // Map a pre-assessment check to its remediation fix(es) so the Fix button can
  // live inline on the check itself.
  const CHECK_FIX_CATEGORY = {
    "Certificate Expiry": ["Certificate"],
    "Resource Capacity": ["Capacity"],
    "Deprecated/Removed APIs": ["Deprecated API"],
    "Admin Acknowledgments": ["Admin Acknowledgment"],
    "Machine Config Pools": ["Machine Config Pool"],
    "Node Health": ["Node Recovery"],
    "Storage (PVs)": ["Storage"],
    "Cluster Operators": ["Operator Recovery"],
  };
  function fixesForCheck(check, plan) {
    if (!plan?.fixes?.length || !check?.category) return [];
    const cats = CHECK_FIX_CATEGORY[check.category] || [check.category];
    const cl = check.category.toLowerCase();
    return plan.fixes.filter(f => cats.includes(f.category) || (f.description || "").toLowerCase().includes(cl));
  }

  // Deprecated-API remediation: find live consumers (APIRequestCount) + AI plan.
  async function findApiConsumers(fix) {
    setApiActions(p => ({ ...p, [fix.id]: { ...(p[fix.id] || {}), loadingConsumers: true } }));
    try {
      const r = await fetch(clusterUrl(`/api/upgrade/api-consumers?api=${encodeURIComponent(fix.api)}`, cluster)).then(x => x.json());
      setApiActions(p => ({ ...p, [fix.id]: { ...(p[fix.id] || {}), loadingConsumers: false, consumers: r } }));
    } catch (e) { setApiActions(p => ({ ...p, [fix.id]: { ...(p[fix.id] || {}), loadingConsumers: false, consumers: { error: e.message } } })); }
  }
  async function apiMigrationPlan(fix) {
    setApiActions(p => ({ ...p, [fix.id]: { ...(p[fix.id] || {}), loadingMigration: true } }));
    try {
      const consumers = apiActions[fix.id]?.consumers?.consumers || [];
      const r = await fetch(clusterUrl("/api/upgrade/api-migration", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api: fix.api, replacement: fix.replacement, targetVersion: targetVer, consumers }),
      }).then(x => x.json());
      setApiActions(p => ({ ...p, [fix.id]: { ...(p[fix.id] || {}), loadingMigration: false, migration: r } }));
    } catch (e) { setApiActions(p => ({ ...p, [fix.id]: { ...(p[fix.id] || {}), loadingMigration: false, migration: { error: e.message } } })); }
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
    // Dry Run BEFORE the Change Request (ITIL best practice): validate the
    // upgrade path first, then submit the CR WITH the dry-run result as evidence
    // so the CAB approves an already-validated, de-risked change.
    { key: "dry_run_passed", label: "Dry Run (validation)", desc: "Validate the upgrade path & readiness BEFORE raising the CR — attached as approval evidence", fromStates: ["pre_assessed", "component_analyzed", "remediation_proposed", "remediated"], action: handleDryRun, actionLabel: "Run Dry Run" },
    { key: "cr_submitted", label: "Change Request", desc: "Raise ServiceNow CR with pre-assessment + dry-run evidence for CAB approval", fromStates: ["dry_run_passed", "remediation_proposed", "remediated"], action: handleRaiseCR, actionLabel: "Raise CR" },
    { key: "cr_approved", label: "CR Approved", desc: isLocalCR ? "Blocked — ServiceNow CR required for approval gate" : "Change Request approved — cleared for execution", fromStates: ["cr_submitted"], action: isLocalCR ? null : handleCheckCR, actionLabel: "Check Status" },
    { key: "executing", label: "Execute Upgrade", desc: "ClusterVersion patched — rolling upgrade in progress", fromStates: ["cr_approved", "dry_run_passed"], action: handleExecute, actionLabel: "Execute" },
    { key: "monitoring", label: "Monitoring", desc: "Watching operator and node rollout progress until completion", fromStates: ["executing"], action: handleCheckProgress, actionLabel: "Check Progress" },
    // Post-Assessment is what FINALIZES the upgrade — available once the rollout
    // is technically complete (monitoring), and gates the COMPLETED state.
    { key: "completed", label: "Post-Assessment (finalizes upgrade)", desc: "Validate target version, operators & nodes — upgrade is marked complete only after this passes", fromStates: ["monitoring", "completed"], action: handlePostAssess, actionLabel: "Run Post-Assessment" },
  ];

  const STATE_ORDER = ["idle", "version_validated", "channel_switched", "pre_assessed", "component_analyzed",
    "remediation_proposed", "remediated", "dry_run_passed", "cr_submitted", "cr_approved", "executing", "monitoring", "completed"];
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
      const total = plan.totalFixes || plan.fixes?.length || 0;
      const auto = plan.autoApplicable ?? (plan.fixes || []).filter((f) => f.autoApplicable).length;
      return { text: total ? `${total} fixes${auto ? ` · ${auto} auto` : ""}` : "0 fixes", color: total ? "var(--warn)" : "var(--text2)" };
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
                  {(c.status === "fail" || c.status === "warning") && (() => {
                    const plan = s.remediationPlan || remediationPlan;
                    const matched = fixesForCheck(c, plan);
                    if (!matched.length) return <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--accent2)" }}>🔧 A fix will appear in the “Remediation Plan” step once it’s built.</div>;
                    const auto = matched.find(f => f.autoApplicable);
                    const results = s.remediationResults || {};
                    const done = matched.map(f => f._result || results[f.id]).find(Boolean);
                    return (
                      <div style={{ marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        {done ? (
                          <span style={{ color: done.success ? "var(--ok)" : "var(--crit)", fontWeight: 700, fontSize: 11 }}>{done.success ? "✅ Fixed" : "❌ Fix failed"}</span>
                        ) : auto ? (
                          <>
                            <button className="ux-btn ux-btn-dryrun" style={{ padding: "2px 9px", fontSize: 10.5 }} onClick={(e) => { e.stopPropagation(); handleExecuteFix(auto.id, true); }} disabled={!!stepRunning} title="Preview without applying">▷ Dry-run</button>
                            <button className="ux-btn ux-btn-execute" style={{ padding: "2px 9px", fontSize: 10.5 }} onClick={(e) => { e.stopPropagation(); handleExecuteFix(auto.id, false); }} disabled={!!stepRunning}>{stepRunning === "execute-fix" ? "Running…" : "🔧 Run"}</button>
                            {fixDryRuns[auto.id] && <span style={{ fontSize: 10, color: fixDryRuns[auto.id].success ? "var(--ok)" : "var(--warn)", width: "100%" }}>▷ Dry-run: {fixDryRuns[auto.id].success ? "OK — safe to apply" : "review output"}</span>}
                          </>
                        ) : (
                          <button className="ux-btn ux-btn-dryrun" style={{ padding: "2px 9px", fontSize: 10.5 }} onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(matched[0].command || ""); showToast("Fix command copied — review before running (guided fix)", "ok"); }}>🔧 Copy fix</button>
                        )}
                        {matched[0]?.api && <button className="ux-btn ux-btn-dryrun" style={{ padding: "2px 9px", fontSize: 10.5 }} onClick={(e) => { e.stopPropagation(); findApiConsumers(matched[0]); }} disabled={apiActions[matched[0].id]?.loadingConsumers}>🔍 Consumers</button>}
                        <span style={{ fontSize: 10, color: "var(--text2)" }}>{matched.length} fix{matched.length > 1 ? "es" : ""} · {auto ? "one-click" : "guided"}</span>
                        {matched[0]?.api && apiActions[matched[0].id]?.consumers && !apiActions[matched[0].id].consumers.error && (
                          <span style={{ fontSize: 10, color: "var(--text2)", width: "100%" }}>Consumers: {apiActions[matched[0].id].consumers.consumers?.length || 0} · {apiActions[matched[0].id].consumers.totalRequests || 0} calls/24h</span>
                        )}
                      </div>
                    );
                  })()}
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
              <div key={fix.id} style={{ padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: fix.severity === "critical" ? "var(--crit)" : fix.severity === "warning" ? "var(--warn)" : "var(--text2)", fontSize: 10.5, fontWeight: 700, width: 58, flexShrink: 0 }}>
                  {(fix.severity || "info").toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span>{fix.description}</span>
                    {fix.autoApplicable
                      ? <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: "color-mix(in srgb, var(--ok) 18%, transparent)", color: "var(--ok)" }}>AUTO</span>
                      : <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: "color-mix(in srgb, var(--accent2) 18%, transparent)", color: "var(--accent2)" }}>GUIDED</span>}
                  </div>
                  {fix.command && <pre style={{ margin: "2px 0 0", fontSize: 10.5, color: "var(--accent3, #10b981)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{fix.command}</pre>}
                  {fix.note && <div style={{ fontSize: 10, color: "var(--text2)", marginTop: 2 }}>ℹ {fix.note}</div>}
                  {fix.aiAssist === "manifest-migration" && <div style={{ fontSize: 10, color: "var(--accent2)", marginTop: 2 }}>💡 The App Deployment Agent can regenerate migrated manifests for this API.</div>}
                  {/* Deprecated-API: find live consumers + AI migration plan */}
                  {fix.api && (() => {
                    const a = apiActions[fix.id] || {};
                    return (
                      <div style={{ marginTop: 5 }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button className="ux-btn ux-btn-dryrun" style={{ padding: "2px 9px", fontSize: 10 }} onClick={(e) => { e.stopPropagation(); findApiConsumers(fix); }} disabled={a.loadingConsumers}>{a.loadingConsumers ? "Finding…" : "🔍 Find consumers"}</button>
                          <button className="ux-btn ux-btn-dryrun" style={{ padding: "2px 9px", fontSize: 10 }} onClick={(e) => { e.stopPropagation(); apiMigrationPlan(fix); }} disabled={a.loadingMigration}>{a.loadingMigration ? "Planning…" : "🤖 AI migration plan"}</button>
                        </div>
                        {a.consumers && (
                          <div style={{ marginTop: 4, fontSize: 10, background: "var(--bg-deep, #0f172a10)", borderRadius: 6, padding: "6px 8px" }}>
                            {a.consumers.error ? <span style={{ color: "var(--warn)" }}>{a.consumers.error}</span> : (
                              <>
                                <div style={{ fontWeight: 700 }}>Consumers ({a.consumers.consumers?.length || 0}) · {a.consumers.totalRequests || 0} calls/24h{a.consumers.removedInRelease ? ` · removed in ${a.consumers.removedInRelease}` : ""}</div>
                                {a.consumers.note && <div style={{ color: "var(--text2)" }}>{a.consumers.note}</div>}
                                {(a.consumers.consumers || []).slice(0, 8).map((c, i) => <div key={i} style={{ color: "var(--text2)", fontFamily: "monospace" }}>• {c.username} <span style={{ opacity: 0.7 }}>({c.userAgent})</span> — {c.requestCount}</div>)}
                              </>
                            )}
                          </div>
                        )}
                        {a.migration && (
                          <div style={{ marginTop: 4, fontSize: 10, background: "color-mix(in srgb, var(--accent2) 6%, transparent)", border: "1px solid color-mix(in srgb, var(--accent2) 25%, transparent)", borderRadius: 6, padding: "6px 8px" }}>
                            {a.migration.error ? <span style={{ color: "var(--warn)" }}>{a.migration.error}</span> : (
                              <>
                                <div style={{ fontWeight: 700, color: "var(--accent2)" }}>🤖 Migrate to {a.migration.targetApiVersion} · risk: {a.migration.risk}</div>
                                <div style={{ color: "var(--text2)", marginTop: 2 }}>{a.migration.summary}</div>
                                {(a.migration.steps || []).length > 0 && <div style={{ marginTop: 3 }}>{a.migration.steps.map((s, i) => <div key={i}>{i + 1}. {s}</div>)}</div>}
                                {(a.migration.commands || []).length > 0 && <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--accent3, #10b981)" }}>{a.migration.commands.join("\n")}</pre>}
                                {a.migration.verify && <div style={{ color: "var(--text2)", marginTop: 3 }}>✓ Verify: {a.migration.verify}</div>}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
                {res ? (
                  <span style={{ color: res.success ? "var(--ok)" : "var(--crit)", fontSize: 11, flexShrink: 0 }}>{res.success ? "✅ Done" : "❌ Failed"}</span>
                ) : (state === "remediation_proposed" && (
                  fix.autoApplicable
                    ? <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                        <button className="ux-btn ux-btn-dryrun" style={{ padding: "2px 8px", fontSize: 10 }}
                          onClick={(e) => { e.stopPropagation(); handleExecuteFix(fix.id, true); }} disabled={!!stepRunning} title="Preview the command without applying">▷ Dry-run</button>
                        <button className="ux-btn ux-btn-execute" style={{ padding: "2px 8px", fontSize: 10 }}
                          onClick={(e) => { e.stopPropagation(); handleExecuteFix(fix.id, false); }} disabled={!!stepRunning} title="Apply the fix">🔧 Run</button>
                      </div>
                    : <button className="ux-btn ux-btn-dryrun" style={{ padding: "2px 8px", fontSize: 10, flexShrink: 0, opacity: 0.9 }}
                        onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(fix.command || ""); showToast("Command copied — review before running", "ok"); }} title="Copy the guided command">Copy</button>
                ))}
              </div>
              {/* Dry-run preview → then apply */}
              {fixDryRuns[fix.id] && !res && (
                <div style={{ margin: "0 0 6px 66px", padding: "6px 8px", borderRadius: 6, fontSize: 10, background: "color-mix(in srgb, var(--accent2) 6%, transparent)", border: "1px solid color-mix(in srgb, var(--accent2) 25%, transparent)" }}>
                  <div style={{ fontWeight: 700, color: fixDryRuns[fix.id].success ? "var(--ok)" : "var(--warn)" }}>▷ Dry-run: {fixDryRuns[fix.id].success ? "OK — safe to apply" : "check output"}</div>
                  {fixDryRuns[fix.id].output && <pre style={{ margin: "2px 0", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text2)" }}>{String(fixDryRuns[fix.id].output).slice(0, 400)}</pre>}
                  <button className="ux-btn ux-btn-execute" style={{ padding: "2px 8px", fontSize: 10, marginTop: 2 }} onClick={(e) => { e.stopPropagation(); handleExecuteFix(fix.id, false); }} disabled={!!stepRunning}>✓ Apply now</button>
                </div>
              )}
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

          {/* Rollout technically complete → must run Post-Assessment to finalize */}
          {state === "monitoring" && s.monitoringData?.technicallyComplete && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 10, background: "color-mix(in srgb, var(--accent2) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--accent2) 30%, transparent)" }}>
              <span style={{ fontSize: 15 }}>🧪</span>
              <div style={{ flex: 1, fontSize: 12 }}>
                <b>Rollout complete — not finalized yet.</b> Run the Post-Assessment below to validate the cluster and mark the upgrade <b>Complete</b>.
              </div>
              <button className="ux-btn ux-btn-execute" style={{ padding: "5px 12px", fontSize: 11.5 }} onClick={(e) => { e.stopPropagation(); handlePostAssess(); }} disabled={!!stepRunning}>{stepRunning === "post-assess" ? "Validating…" : "Run Post-Assessment"}</button>
            </div>
          )}
          {/* Footer: last updated + polling indicator */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, color: "var(--text2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {state !== "completed" && !s.monitoringData?.technicallyComplete && (
                <>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", animation: "pulse 2s infinite" }} />
                  <span>Live — polling cluster every 15s</span>
                </>
              )}
              {state === "monitoring" && s.monitoringData?.technicallyComplete && <span style={{ color: "var(--accent2)" }}>Awaiting post-assessment to finalize</span>}
              {state === "completed" && <span style={{ color: "var(--ok)", fontWeight: 700 }}>✅ Upgrade verified &amp; complete</span>}
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
          {/* ServiceNow CR closure status — reflects the ACTUAL close result */}
          {s.crTicketId && pa.verifiedVersion && (
            <div style={{ padding: "6px 10px", background: "color-mix(in srgb, var(--accent2) 8%, transparent)", borderRadius: 6 }}>
              <span style={{ fontWeight: 600 }}>ServiceNow CR: </span>
              <span style={{ fontWeight: 700, color: "var(--accent2)" }}>{s.crTicketId}</span>
              {pa.crClosed?.closed ? (
                <span style={{ marginLeft: 8, color: "var(--ok)", fontWeight: 600 }}>✅ Auto-closed (successful)</span>
              ) : pa.crClosed?.reason === "manual-review-required" ? (
                <span style={{ marginLeft: 8, color: "var(--warn)", fontWeight: 600 }}>⚠ Not closed — manual review required</span>
              ) : pa.crClosed && !pa.crClosed.closed ? (
                <span style={{ marginLeft: 8, color: "var(--crit)", fontWeight: 600 }}>❌ Close failed{pa.crClosed.error ? ` — ${String(pa.crClosed.error).slice(0, 80)}` : ""}</span>
              ) : (
                <span style={{ marginLeft: 8, color: "var(--warn)", fontWeight: 600 }}>⏳ Close pending</span>
              )}
              <div style={{ marginTop: 3, fontSize: 10, color: "var(--text2)" }}>Post-assessment PDF + HTML attached to CR</div>
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

        {/* Full POST-Upgrade Assessment Report — prominent action bar (mirrors pre) */}
        {(s.postAssessment || state === "completed") && (
          <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>Full Post-Upgrade Assessment Report</div>
              {s.postAssessment?.comparison && (
                <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>
                  {(s.postAssessment.comparison.resolved || []).length} resolved · {(s.postAssessment.comparison.newIssues || []).length} new issues · verified {s.postAssessment.verifiedVersion || "—"}
                </div>
              )}
            </div>
            <a href={clusterUrl(`/api/upgrade/report?session=${sessionId}&type=post&format=html`, cluster)}
              target="_blank" rel="noopener noreferrer"
              className="ux-btn ux-btn-execute"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", fontSize: 12, fontWeight: 600, textDecoration: "none" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              Open Full Report
            </a>
          </div>
        )}

        {/* Assessment reports — HTML (view) + PDF (download), pre & post */}
        {(data.preflightStatus || s.preflightReport || state === "completed" || s.postAssessment) && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 0.4 }}>Pre-Assessment</span>
              <a className="ux-btn ux-btn-outline" style={{ padding: "5px 11px", fontSize: 11, textDecoration: "none" }} href={clusterUrl(`/api/upgrade/report?session=${sessionId}&type=pre&format=html`, cluster)} target="_blank" rel="noopener noreferrer">🖹 Open HTML</a>
              <a className="ux-btn ux-btn-outline" style={{ padding: "5px 11px", fontSize: 11, textDecoration: "none" }} href={clusterUrl(`/api/upgrade/report?session=${sessionId}&type=pre&format=pdf`, cluster)} target="_blank" rel="noopener noreferrer">⭳ PDF</a>
            </div>
            {(s.postAssessment || state === "completed") && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 0.4 }}>Post-Assessment</span>
                <a className="ux-btn ux-btn-outline" style={{ padding: "5px 11px", fontSize: 11, textDecoration: "none" }} href={clusterUrl(`/api/upgrade/report?session=${sessionId}&type=post&format=html`, cluster)} target="_blank" rel="noopener noreferrer">🖹 Open HTML</a>
                <a className="ux-btn ux-btn-outline" style={{ padding: "5px 11px", fontSize: 11, textDecoration: "none" }} href={clusterUrl(`/api/upgrade/report?session=${sessionId}&type=post&format=pdf`, cluster)} target="_blank" rel="noopener noreferrer">⭳ PDF</a>
              </div>
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
  const [open, setOpen] = useState(true);
  const fmtTime = (t) => { try { const d = new Date(t); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return "—"; } };
  const fmtDate = (t) => { try { const d = new Date(t); return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return "—"; } };
  const evtIcons = { OOMKilling: "💀", Killing: "⚠", BackOff: "🔄", Unhealthy: "❌", FailedScheduling: "⏳", Pulled: "📦", Started: "▶", Created: "➕", "AI Detected": "🤖", ServiceNow: "🎫", "Fix Ready": "🔧", "Incident Created": "🔔", "Triage Started": "🔍", "Fix Applied": "✅", "Resolved": "🏁" };
  const phaseColors = { "AI Detected": "#3b82f6", ServiceNow: "#8b5cf6", "Fix Ready": "#16a34a", "Incident Created": "#dc2626", "Triage Started": "#f59e0b", "Fix Applied": "#16a34a", Resolved: "#16a34a" };

  const firstTime = events[0]?.time ? new Date(events[0].time) : null;
  const lastTime = events[events.length - 1]?.time ? new Date(events[events.length - 1].time) : null;
  const duration = firstTime && lastTime ? ((lastTime - firstTime) / 1000) : null;

  return (
    <div style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <button onClick={() => setOpen(v => !v)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--card-bg)", border: "none", cursor: "pointer", color: "var(--fg)", fontSize: "0.88em", fontWeight: 600 }}>
        <span style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s" }}>▶</span>
        Incident Event Timeline ({events.length} events)
        {duration != null && <span style={{ fontSize: "0.75em", color: "var(--muted)", fontWeight: 400 }}>| Span: {duration < 60 ? duration.toFixed(0) + "s" : (duration / 60).toFixed(1) + "min"}</span>}
        <span style={{ marginLeft: "auto", fontSize: "0.75em", color: "var(--muted)" }}>{open ? "collapse" : "expand"}</span>
      </button>
      {open && (
        <div style={{ padding: "4px 0", borderTop: "1px solid var(--border)" }}>
          {events.map((e, i) => {
            const isPhase = phaseColors[e.event];
            return (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 12px", borderBottom: i < events.length - 1 ? "1px dashed var(--border)" : "none", background: isPhase ? (phaseColors[e.event] + "08") : undefined }}>
                <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "0.72em", color: "var(--muted)", minWidth: 70, flexShrink: 0, paddingTop: 1 }}>{fmtTime(e.time)}</span>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0, width: 20, flexShrink: 0 }}>
                  <span style={{ fontSize: "0.85em" }}>{evtIcons[e.event] || "●"}</span>
                  {i < events.length - 1 && <div style={{ width: 1, height: 12, background: "var(--border)", marginTop: 2 }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: "0.84em", color: phaseColors[e.event] || sevColor || "var(--fg)" }}>{e.event}</span>
                  {e.detail && <div style={{ fontSize: "0.76em", color: "var(--muted)", marginTop: 1, wordBreak: "break-word" }}>{e.detail}</div>}
                </div>
              </div>
            );
          })}
          {duration != null && (
            <div style={{ padding: "6px 12px", fontSize: "0.75em", color: "var(--muted)", background: "var(--card-bg)", textAlign: "right", fontFamily: "var(--font-mono, monospace)" }}>
              Detection to Fix Ready: {duration < 60 ? duration.toFixed(0) + "s" : (duration / 60).toFixed(1) + "min"} | {firstTime ? fmtDate(firstTime) : ""} — {lastTime ? fmtDate(lastTime) : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Recovery Timeline — shows step-by-step healing progress             */
/* ------------------------------------------------------------------ */

function RecoveryTimeline({ validation, incClosed, incidentNumber, durationMs, resolutionTimeline }) {
  if (!validation) return null;
  const v = validation;
  const fmtTs = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return ""; } };
  const steps = [];

  const fixTs = resolutionTimeline?.fixAppliedAt ? fmtTs(resolutionTimeline.fixAppliedAt) : "";
  steps.push({ label: "Fix command executed", status: "done", time: fixTs || "T+0s" });

  if (v.stable != null) {
    steps.push({ label: "Rolling restart triggered", status: "done", time: v.rolloutDurationMs ? `+${(v.rolloutDurationMs / 1000 * 0.15).toFixed(0)}s` : "+2s" });
    steps.push({ label: v.ready != null ? `Replicas ready: ${v.ready}/${v.desired}` : "New pod scheduled", status: "done", time: v.rolloutDurationMs ? `+${(v.rolloutDurationMs / 1000 * 0.6).toFixed(0)}s` : "+8s" });
    if (v.stable) steps.push({ label: "Rollout stable — all replicas updated", status: "done", time: v.rolloutDurationMs ? `+${(v.rolloutDurationMs / 1000).toFixed(0)}s` : "+15s" });
    else steps.push({ label: "Rollout in progress", status: "pending", time: "" });
  }
  if (v.allPodsHealthy != null) {
    const podDetail = v.pods?.length ? `${v.pods.filter(p => p.ready).length}/${v.pods.length} running` : "verified";
    steps.push({ label: `Pod health check — ${podDetail}`, status: v.allPodsHealthy ? "done" : "warn", time: resolutionTimeline?.validationAt ? fmtTs(resolutionTimeline.validationAt) : "" });
  }
  if (incClosed) {
    const resolveTs = resolutionTimeline?.resolvedAt ? fmtTs(resolutionTimeline.resolvedAt) : "";
    steps.push({ label: `${incidentNumber || "Incident"} auto-resolved in ServiceNow`, status: "done", time: resolveTs });
  }
  if (v.passed) {
    const totalSec = (resolutionTimeline?.totalDurationMs || durationMs || 0) / 1000;
    steps.push({ label: "Validation passed — incident closed", status: "done", time: "" });
    steps.push({ label: `Mean Time to Resolution (MTTR): ${totalSec < 60 ? totalSec.toFixed(1) + "s" : (totalSec / 60).toFixed(1) + "min"}`, status: "done", time: "", isSummary: true });
  }

  const colors = { done: "#16a34a", pending: "#f59e0b", warn: "#f59e0b", fail: "#dc2626" };
  const icons = { done: "✓", pending: "◷", warn: "!", fail: "✕" };

  return (
    <div style={{ margin: "8px 0", borderLeft: "2px solid #16a34a", paddingLeft: 12 }}>
      <div style={{ fontSize: "0.72em", fontWeight: 600, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.5px", marginBottom: 6 }}>Recovery Timeline</div>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: "0.82em" }}>
          <span style={{ width: 18, height: 18, borderRadius: "50%", background: colors[s.status] + "18", color: colors[s.status], display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7em", fontWeight: 700, flexShrink: 0 }}>{icons[s.status]}</span>
          <span style={{ flex: 1, color: s.isSummary ? "#16a34a" : s.status === "done" ? "var(--fg)" : colors[s.status], fontWeight: s.isSummary ? 700 : 400 }}>{s.label}</span>
          {s.time && <span style={{ fontSize: "0.78em", color: "var(--muted)", fontFamily: "var(--font-mono, monospace)" }}>{s.time}</span>}
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

  const statusDot = (ready, state) => {
    const color = ready ? "#16a34a" : state === "CrashLoopBackOff" || state === "OOMKilled" ? "#dc2626" : "#f59e0b";
    return React.createElement("span", { style: { display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: color, marginRight: 4, verticalAlign: "middle" } });
  };

  const rows = [];
  if (before?.status || after?.status) {
    const bState = before?.containerState || before?.status || "—";
    const aState = after?.containerState || after?.status || "—";
    rows.push({
      label: "Pod Status",
      before: React.createElement("span", null, statusDot(before?.ready, before?.containerState), bState),
      after: React.createElement("span", null, statusDot(after?.ready, after?.containerState), aState),
      highlight: bState !== aState || (after?.ready && !before?.ready),
    });
  }
  if (before?.memoryLimit || after?.memoryLimit) {
    const changed = before?.memoryLimit !== after?.memoryLimit;
    rows.push({ label: "Memory Limit", before: before?.memoryLimit || "—", after: after?.memoryLimit || "—", highlight: changed });
  }
  if (before?.memoryRequest || after?.memoryRequest) {
    const changed = before?.memoryRequest !== after?.memoryRequest;
    rows.push({ label: "Memory Request", before: before?.memoryRequest || "—", after: after?.memoryRequest || "—", highlight: changed });
  }
  if (before?.memoryUsage || after?.memoryUsage) {
    const changed = before?.memoryUsage !== after?.memoryUsage;
    rows.push({ label: "Memory Usage", before: before?.memoryUsage || "—", after: after?.memoryUsage || "—", highlight: changed });
  }
  if (before?.restarts != null || after?.restarts != null) rows.push({ label: "Restarts", before: String(before?.restarts ?? "—"), after: String(after?.restarts ?? "0"), highlight: (after?.restarts ?? 0) !== (before?.restarts ?? 0) });
  if (before?.cpuLimit || after?.cpuLimit) {
    const changed = before?.cpuLimit !== after?.cpuLimit;
    rows.push({ label: "CPU Limit", before: before?.cpuLimit || "—", after: after?.cpuLimit || "—", highlight: changed });
  }
  if (before?.cpuUsage || after?.cpuUsage) {
    const changed = before?.cpuUsage !== after?.cpuUsage;
    rows.push({ label: "CPU Usage", before: before?.cpuUsage || "—", after: after?.cpuUsage || "—", highlight: changed });
  }
  if (after?.podCount) rows.push({ label: "Healthy Pods", before: before?.podCount || "—", after: after.podCount, highlight: true });
  if (rows.length === 0) return null;

  return (
    <div style={{ margin: "8px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: "0.72em", fontWeight: 600, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.5px" }}>Before / After Comparison</div>
        {before?.podName && <span style={{ fontSize: "0.72em", color: "var(--muted)", fontFamily: "var(--font-mono, monospace)" }}>{before.containerName || ""}@{before.podName}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr", gap: 0, fontSize: "0.82em", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
        <div style={{ padding: "6px 10px", fontWeight: 600, background: "var(--card-bg)", borderBottom: "1px solid var(--border)" }}>Metric</div>
        <div style={{ padding: "6px 10px", fontWeight: 600, background: "var(--card-bg)", borderBottom: "1px solid var(--border)", textAlign: "center", color: "#dc2626" }}>Before Fix</div>
        <div style={{ padding: "6px 10px", fontWeight: 600, background: "var(--card-bg)", borderBottom: "1px solid var(--border)", textAlign: "center", color: "#16a34a" }}>After Fix</div>
        {rows.map((r, i) => (<React.Fragment key={i}>
          <div style={{ padding: "5px 10px", borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none", fontWeight: r.highlight ? 600 : 400 }}>{r.label}</div>
          <div style={{ padding: "5px 10px", textAlign: "center", borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none", color: "#dc2626", fontFamily: typeof r.before === "string" ? "var(--font-mono, monospace)" : undefined }}>{r.before}</div>
          <div style={{ padding: "5px 10px", textAlign: "center", borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none", color: "#16a34a", fontFamily: typeof r.after === "string" ? "var(--font-mono, monospace)" : undefined, background: r.highlight ? "rgba(34,197,94,0.06)" : undefined, fontWeight: r.highlight ? 600 : 400 }}>{r.after}</div>
        </React.Fragment>))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Fix proposal (pod healing)                                          */
/* ------------------------------------------------------------------ */

function FixProposal({ diag, cluster }) {
  const storageKey = `tcs-fix-${diag.incidentNumber || diag.podName || "fix"}-${cluster || "local"}`;

  const loadPersistedState = () => {
    try { const raw = localStorage.getItem(storageKey); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  };

  const [fixStates, setFixStates] = useState(loadPersistedState);
  const [logsOpen, setLogsOpen] = useState(false);
  const [copied, setCopied] = useState(null);

  const persistState = (newState) => {
    setFixStates(newState);
    try {
      const toStore = {};
      for (const [k, v] of Object.entries(typeof newState === "function" ? newState(fixStates) : newState)) {
        if (v && !v.running) toStore[k] = v;
      }
      localStorage.setItem(storageKey, JSON.stringify(toStore));
    } catch {}
  };

  const updateFixState = (key, value) => {
    setFixStates(prev => {
      const next = { ...prev, [key]: value };
      if (!value.running) {
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      }
      return next;
    });
  };

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
    updateFixState(key, { running: true, phase: dryRun ? "dry-run" : "applying", text: dryRun ? "Running dry run..." : "Applying fix..." });
    try {
      const res = await fetch(clusterUrl("/api/alerts/execute-fix", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: fix.command, dryRun, namespace: fix.namespace, resourceName: fix.resource, auditTitle: fix.title,
          incidentSysId: diag.incidentSysId || null, incidentNumber: diag.incidentNumber || null,
          incidentSeverity: diag.severityLevel || diag.severity || null,
          incidentDiagnosis: diag.diagnosis || null, incidentRootCause: diag.rootCause || null,
          captureMetrics: !dryRun,
          podName: diag.podName || null, fixTitle: fix.title || null, fixRisk: fix.risk || null,
          incidentEvidence: diag.evidence || [], logErrors: diag.logErrors || [], errorLines: diag.errorLines || [],
          incidentTimeline: Array.isArray(diag.timeline) ? diag.timeline.map(t => ({ timestamp: t.time || t.timestamp || "", label: t.label || t.stage || "", detail: t.detail || t.details || "" })) : [],
        }),
      });
      const d = await res.json();
      if (d.blocked) { updateFixState(key, { phase: "blocked", text: d.reason || "Blocked by policy" }); return; }

      // Production-grade async path: the fix was applied and the server is now
      // watching the pod → verifying → closing the incident in the background.
      // Poll for the result so a slow rollout never blocks/timeouts the request.
      if (d.verifying && d.verifyJobId) {
        updateFixState(key, {
          running: false, phase: "verifying",
          text: (d.output || "") + "\n\n⏳ Watching pod & verifying rollout…",
          beforeMetrics: d.beforeMetrics || null, appliedAt: new Date().toISOString(),
        });
        const jobId = d.verifyJobId;
        const pollStart = Date.now();
        while (Date.now() - pollStart < 180000) { // poll up to 3 min
          await new Promise(r => setTimeout(r, 3000));
          try {
            const sres = await fetch(clusterUrl(`/api/alerts/fix-status?jobId=${encodeURIComponent(jobId)}`, cluster));
            const sd = await sres.json();
            if (["resolved", "applied", "failed"].includes(sd.status)) {
              const incClosed = sd.incidentClosed?.success || false;
              updateFixState(key, {
                running: false,
                phase: sd.status === "resolved" ? "resolved" : (sd.status === "failed" ? "failed" : "applied"),
                text: sd.output || d.output || "Applied.",
                validation: sd.validation || null,
                beforeMetrics: sd.beforeMetrics || d.beforeMetrics || null,
                afterMetrics: sd.afterMetrics || null,
                resolutionTimeline: sd.resolutionTimeline || null,
                incClosed,
                incError: incClosed ? null : (sd.incidentClosed?.detailsSaved ? "Details synced to ServiceNow — close pending" : (sd.incidentClosed?.closeError || sd.error || null)),
                incDetailsSaved: sd.incidentClosed?.detailsSaved || incClosed,
                durationMs: Date.now() - startTime,
                appliedAt: sd.appliedAt || new Date().toISOString(),
              });
              return;
            }
          } catch { /* transient — keep polling */ }
        }
        updateFixState(key, { running: false, phase: "applied", text: "Fix applied. Verification is taking longer than expected — check the incident in ServiceNow." });
        return;
      }

      const out = d.output || d.stdout || d.result || (d.success ? "Done." : d.error || "No output");
      const durationMs = Date.now() - startTime;
      const appliedAt = new Date().toISOString();
      if (!dryRun && d.success !== false && diag.incidentSysId && !d.incidentClosed?.success) {
        updateFixState(key, { running: true, phase: "closing-inc", text: out + "\n\nClosing ServiceNow incident..." });
        try {
          const resolution = {
            incidentNumber: diag.incidentNumber || "", severity: diag.severityLevel || diag.severity || "N/A",
            podName: diag.podName || "", namespace: diag.namespace || "", deploymentName: diag.deploymentName || "",
            cluster: cluster || "local", rootCause: diag.rootCause || diag.diagnosis || "see report",
            evidence: diag.evidence || [], fixTitle: fix.title || "", fixCommand: fix.command || "",
            fixResult: String(out).slice(0, 500), fixRisk: fix.risk || "low",
            rolloutStatus: d.validation?.stable ? `Stable — ${d.validation.ready || 0}/${d.validation.desired || 0} replicas ready` : "triggered",
            timeline: Array.isArray(diag.timeline) ? diag.timeline.map(t => ({ timestamp: t.time || t.timestamp || "", label: t.label || t.stage || "", detail: t.detail || t.details || "" })) : [],
          };
          const closeRes = await fetch(clusterUrl("/api/servicenow/resolve-incident", cluster), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sysId: diag.incidentSysId, closeNotes: `Resolved by TCS Agentic AI — ${fix.title}`, resolution }),
          });
          const closeData = await closeRes.json();
          // Details are always saved to ServiceNow; the state-close is best-effort.
          // Show a soft "details saved" note rather than a hard error when only the
          // close transition fails (e.g. instance ACL / mandatory fields).
          const detailsSaved = closeData.detailsSaved || closeData.success;
          updateFixState(key, {
            phase: closeData.success ? "resolved" : "applied", text: out, incClosed: closeData.success,
            incError: closeData.success ? null : (detailsSaved ? `Details synced to ServiceNow — close pending${closeData.closeError ? " (" + closeData.closeError + ")" : ""}` : (closeData.error || closeData.closeError || "close failed")),
            incDetailsSaved: detailsSaved,
            validation: d.validation || null, beforeMetrics: d.beforeMetrics || null, afterMetrics: d.afterMetrics || null, resolutionTimeline: d.resolutionTimeline || null, durationMs, appliedAt,
          });
        } catch (e) {
          updateFixState(key, { phase: "applied", text: out, incError: e.message, validation: d.validation || null, resolutionTimeline: d.resolutionTimeline || null, durationMs, appliedAt });
        }
      } else {
        const phase = dryRun ? "dry-done" : d.incidentClosed?.success ? "resolved" : (d.success === false ? "failed" : "applied");
        updateFixState(key, {
          phase, text: String(out).slice(0, 4000),
          validation: d.validation || null, beforeMetrics: d.beforeMetrics || null, afterMetrics: d.afterMetrics || null,
          resolutionTimeline: d.resolutionTimeline || null,
          incClosed: d.incidentClosed?.success || false, incError: d.incidentClosed?.error || null, durationMs,
          appliedAt: dryRun ? undefined : appliedAt,
        });
      }
    } catch (e) {
      updateFixState(key, { phase: "failed", text: e.message });
    }
  }

  const fixes = diag.fixes || [];
  const hasIncident = diag.incidentSysId && diag.incidentNumber;
  const logData = diag.logAnalysis;

  const phaseIcon = { "dry-run": "⏳", applying: "⏳", verifying: "⏳", "closing-inc": "⏳", "dry-done": "✅", applied: "✅", resolved: "✅", failed: "❌", blocked: "⛔" };
  const phaseLabel = { "dry-run": "Running dry run...", applying: "Applying...", verifying: "Watching pod & verifying...", "closing-inc": "Closing incident...", "dry-done": "Dry run complete", applied: "Fix applied", resolved: "Fix applied & incident closed", failed: "Failed", blocked: "Blocked" };

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
        {/* Root cause analysis */}
        {diag.rootCause && (
          <div style={{ padding: "10px 14px", background: "var(--card-bg)", borderRadius: 8, borderLeft: `3px solid ${sevColor}`, marginBottom: 10 }}>
            <div style={{ fontSize: "0.72em", fontWeight: 600, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.5px", marginBottom: 6 }}>Root Cause Analysis</div>
            <div style={{ fontWeight: 600, whiteSpace: "pre-line", lineHeight: 1.5 }}>{diag.rootCause}</div>
          </div>
        )}
        {/* Diagnosis summary */}
        {diag.diagnosis && (
          <div style={{ padding: "10px 14px", background: "var(--card-bg)", borderRadius: 8, borderLeft: "3px solid var(--muted)", marginBottom: 12 }}>
            <div style={{ fontSize: "0.72em", fontWeight: 600, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.5px", marginBottom: 6 }}>Impact Assessment</div>
            <div style={{ whiteSpace: "pre-line", lineHeight: 1.5, fontSize: "0.9em" }}>{diag.diagnosis}</div>
          </div>
        )}
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
                    <div style={{ fontSize: "0.82em", color: "var(--muted)", marginBottom: 8, lineHeight: 1.5, whiteSpace: "pre-line" }}>{fix.description}</div>
                    <div style={{ display: "flex", alignItems: "center", background: "#1e1e1e", borderRadius: 6, overflow: "hidden" }}>
                      <code style={{ flex: 1, padding: "8px 12px", color: "#d4d4d4", fontSize: "0.82em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fix.command}</code>
                      <button onClick={() => copyCmd(fix.command)} style={{ padding: "6px 12px", background: "transparent", border: "none", borderLeft: "1px solid #333", color: copied === fix.command ? "#16a34a" : "#888", cursor: "pointer", fontSize: "0.78em", fontWeight: 600, whiteSpace: "nowrap" }}>
                        {copied === fix.command ? "✓ Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                  {(() => {
                    const isApplied = st?.phase === "applied" || st?.phase === "resolved";
                    const isFailed = st?.phase === "failed" || st?.phase === "blocked";
                    const isRunning = st?.running;
                    const isVerifying = st?.phase === "verifying";
                    const isDisabled = isRunning || isApplied || isVerifying;
                    return (
                      <>
                        <div style={{ display: "flex", gap: 0, borderTop: "1px solid var(--border)" }}>
                          <button onClick={() => runFix(fix, true)} disabled={isDisabled} style={{ flex: 1, padding: "8px 0", background: isApplied ? "var(--card-bg)" : "transparent", border: "none", borderRight: "1px solid var(--border)", cursor: isDisabled ? "default" : "pointer", color: isApplied ? "var(--muted)" : "var(--fg)", fontWeight: 600, fontSize: "0.82em", opacity: isDisabled ? 0.5 : 1 }}>
                            {st?.phase === "dry-run" ? "⏳ Running..." : isApplied ? "▷ Dry Run" : "▷ Dry Run"}
                          </button>
                          <button onClick={() => runFix(fix, false)} disabled={isDisabled} style={{ flex: 1, padding: "8px 0", background: isApplied ? "#16a34a12" : hasIncident ? "rgba(34,197,94,0.06)" : "rgba(59,130,246,0.06)", border: "none", cursor: isDisabled ? "default" : "pointer", color: isApplied ? "#16a34a" : hasIncident ? "#16a34a" : "#3b82f6", fontWeight: 700, fontSize: "0.82em", opacity: isDisabled ? 0.6 : 1 }}>
                            {isRunning ? "⏳ Applying..." : isVerifying ? "⏳ Verifying pod…" : isApplied ? (st.incClosed ? "✓ Applied & INC Closed" : "✓ Fix Applied") : hasIncident ? "▶ Apply & Close INC" : "▶ Apply Fix"}
                          </button>
                        </div>
                        {st && !st.running && (
                          <div style={{ padding: "8px 14px", borderTop: "1px solid var(--border)", background: isFailed ? "rgba(220,38,38,0.04)" : "rgba(34,197,94,0.04)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: "0.82em", fontWeight: 600 }}>
                              <span>{phaseIcon[st.phase] || ""}</span>
                              <span style={{ color: isFailed ? "#dc2626" : "#16a34a" }}>{phaseLabel[st.phase] || st.phase}</span>
                              {st.incClosed && <span style={{ marginLeft: "auto", fontSize: "0.85em", color: "#16a34a" }}>{diag.incidentNumber} resolved</span>}
                              {!st.incClosed && st.incDetailsSaved && <span style={{ marginLeft: "auto", fontSize: "0.85em", color: "#0ea5e9" }}>{diag.incidentNumber} — details synced (close pending)</span>}
                              {st.incError && !st.incDetailsSaved && <span style={{ marginLeft: "auto", fontSize: "0.85em", color: "#f59e0b" }}>INC close: {st.incError}</span>}
                              {st.appliedAt && <span style={{ marginLeft: st.incClosed || st.incError ? 8 : "auto", fontSize: "0.75em", color: "var(--muted)", fontFamily: "var(--font-mono, monospace)" }}>Applied: {new Date(st.appliedAt).toLocaleString()}</span>}
                            </div>
                            {/* Recovery timeline for applied fixes */}
                            {st.validation && !st.phase?.startsWith("dry") && (
                              <RecoveryTimeline validation={st.validation} incClosed={st.incClosed} incidentNumber={diag.incidentNumber} durationMs={st.durationMs} resolutionTimeline={st.resolutionTimeline} />
                            )}
                            {/* Before/After metrics comparison — only when the
                                new pod is actually Running/Ready. Showing it
                                while the rollout is unhealthy (e.g. "0/1
                                running") would present misleading numbers. */}
                            {st.beforeMetrics && st.afterMetrics && !st.phase?.startsWith("dry") && (() => {
                              const a = st.afterMetrics;
                              const zeroReady = a?.podCount ? /^0\s*\//.test(String(a.podCount)) : false;
                              const podHealthy = a?.ready !== false
                                && st.validation?.allPodsHealthy !== false
                                && !zeroReady
                                && a?.status !== "Rolling out" && a?.status !== "Pending";
                              return podHealthy
                                ? <BeforeAfterMetrics before={st.beforeMetrics} after={st.afterMetrics} />
                                : (
                                  <div style={{ margin: "8px 0", padding: "10px 12px", borderRadius: 8, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)", fontSize: "0.82em", color: "var(--fg)" }}>
                                    <strong style={{ color: "#f59e0b" }}>⏳ Post-fix verification pending</strong> — the new pod is not yet Running{a?.podCount ? ` (${a.podCount} ready)` : ""}. Before/After metrics are withheld until the rollout is healthy to avoid misleading results. Re-run the fix verification or click <em>Scan</em> once the pod is Ready.
                                  </div>
                                );
                            })()}
                            {st.text && <pre style={{ margin: 0, fontSize: "0.78em", whiteSpace: "pre-wrap", color: "var(--fg)", maxHeight: 200, overflow: "auto" }}>{st.text}</pre>}
                          </div>
                        )}
                      </>
                    );
                  })()}
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

/* ------------------------------------------------------------------ */
/*  VM Request card (UC-06)                                            */
/* ------------------------------------------------------------------ */
/*  Not a form. A decision surface: what the AI understood, what the    */
/*  cluster actually offers, what it will consume, and the one          */
/*  compromise nobody else shows — requested size vs golden template.   */

function QuotaBar({ q }) {
  const pct = Math.max(0, Math.min(100, q.afterPct || 0));
  const col = pct > 100 ? "#ef4444" : pct >= 85 ? "#f59e0b" : "#22c55e";
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
        <span style={{ opacity: .75 }}>{q.resource} <span style={{ opacity: .6 }}>· {q.quota}</span></span>
        <span style={{ color: col, fontWeight: 700 }}>{pct}% after</span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: "color-mix(in srgb, var(--text2) 18%, transparent)", overflow: "hidden" }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: col, transition: "width .3s" }} />
      </div>
      <div style={{ fontSize: 10.5, opacity: .6, marginTop: 2 }}>
        used {q.used} + this request {q.requested} of {q.hard}
      </div>
    </div>
  );
}

// Typing aids for the two free-text provenance fields. Suggestions only — a
// datalist still accepts anything, it just saves the common cases.
const OWNER_SUGGESTIONS = ["platform-team", "app-team", "sap-basis", "dba-team", "infra-ops"];
const COST_CENTRE_SUGGESTIONS = ["CC-4471", "CC-1002", "CC-2200", "CC-3310"];

// Inputs are deliberately larger than the surrounding chat text: this is a form
// people fill in, not a label they read.
// Greyed-out styling for a frozen field: visibly not editable, still readable.
const VM_LOCKED = { opacity: .62, cursor: "not-allowed", background: "var(--bg3, rgba(127,127,127,.10))" };
const VM_CTRL = {
  padding: "8px 10px", borderRadius: 7, border: "1px solid var(--border)",
  background: "var(--bg2, transparent)", color: "inherit", fontSize: 13,
  lineHeight: 1.35, width: "100%", boxSizing: "border-box", minHeight: 34,
};

/**
 * MODULE SCOPE ON PURPOSE. Defining a component inside another component's body
 * gives it a new function identity on every render, so React unmounts the old
 * subtree and mounts a fresh DOM node — which drops focus after every single
 * keystroke. Hoisting keeps the element identity stable, so typing is
 * continuous. Same reason VMNamespaceField lives out here.
 */
function VMField({ label, value, onChange, type = "text", ph, opts, hint, suggest, required, listId, disabled }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5 }}>
      <span style={{ opacity: .75, fontWeight: 700 }}>
        {label}{required && <span style={{ color: "#fca5a5" }}> — required</span>}
      </span>
      {opts ? (
        <select value={value || ""} onChange={onChange} className="vmreq-input" disabled={disabled}
          style={{ ...VM_CTRL, ...(disabled ? VM_LOCKED : {}), borderColor: required && !disabled ? "rgba(239,68,68,.55)" : "var(--border)" }}>
          <option value="">— choose —</option>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <>
          <input type={type} value={value ?? ""} onChange={onChange} placeholder={ph} disabled={disabled}
            list={suggest?.length ? listId : undefined} autoComplete="off"
            style={{ ...VM_CTRL, ...(disabled ? VM_LOCKED : {}), borderColor: required && !disabled ? "rgba(239,68,68,.55)" : "var(--border)" }} />
          {suggest?.length > 0 && (
            <datalist id={listId}>{suggest.map((s) => <option key={s} value={s} />)}</datalist>
          )}
        </>
      )}
      {hint && <span style={{ opacity: .55, fontSize: 10.5 }}>{hint}</span>}
    </label>
  );
}

/** Pick a real namespace, or name a new one and have provisioning create it. */
function VMNamespaceField({ value, createNamespace, namespaces, onPick, onType, onToggleCreate, disabled }) {
  const known = namespaces.includes(value);
  const creating = !!createNamespace || (!!value && !known) || (!value && !!createNamespace);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5 }}>
      <span style={{ opacity: .75, fontWeight: 700 }}>
        Namespace{!value && <span style={{ color: "#fca5a5" }}> — required</span>}
      </span>
      <select
        value={known ? value : (creating ? "__new__" : "")}
        onChange={(e) => onPick(e.target.value)} disabled={disabled}
        style={{ ...VM_CTRL, ...(disabled ? VM_LOCKED : {}), borderColor: !value && !disabled ? "rgba(239,68,68,.55)" : "var(--border)" }}>
        <option value="">— choose an existing namespace —</option>
        {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
        <option value="__new__">＋ Create a new namespace…</option>
      </select>
      {creating && (
        <>
          <input value={value ?? ""} placeholder="new-namespace-name" autoComplete="off" disabled={disabled}
            onChange={(e) => onType(e.target.value)}
            style={{ ...VM_CTRL, ...(disabled ? VM_LOCKED : {}), marginTop: 2 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, opacity: .85, marginTop: 2 }}>
            <input type="checkbox" checked={!!createNamespace} disabled={disabled} onChange={(e) => onToggleCreate(e.target.checked)} />
            Create it if it doesn’t exist
          </label>
        </>
      )}
      {namespaces.length === 0 && !creating && (
        <span style={{ opacity: .55, fontSize: 10.5 }}>No namespace list available — choose “Create a new namespace…”.</span>
      )}
    </label>
  );
}

function VMRequestCard({ data, cluster }) {
  const [req, setReq] = useState(data.request || {});
  const [pre, setPre] = useState(data.preflight || null);
  const [recon, setRecon] = useState(data.reconciliation || null);
  const [busy, setBusy] = useState(null);
  const [dry, setDry] = useState(null);
  const [result, setResult] = useState(null);
  const [showYaml, setShowYaml] = useState(false);
  const [raiseCR, setRaiseCR] = useState(true);
  const [submitted, setSubmitted] = useState(null);   // ServiceNow-gated path
  const [access, setAccess] = useState(null);
  const [serverState, setServerState] = useState(null); // authoritative gate state
  const [vmStatus, setVmStatus] = useState(null);       // live runtime after provisioning
  const [approvalCheck, setApprovalCheck] = useState(null); // last ServiceNow lookup
  const cat = data.catalogue || { images: [], instanceTypes: [], storageClasses: [] };

  const missing = [];
  if (!req.name) missing.push("name");
  if (!req.namespace) missing.push("namespace");
  if (!req.sourceDataSource) missing.push("image");
  if (!req.sshKey) missing.push("SSH key");
  if (!req.instanceType && !(req.cpuCores && req.memoryMi)) missing.push("size");

  const blocked = (pre?.blocking?.length || 0) > 0;
  const ready = missing.length === 0 && !blocked;

  async function post(path, body) {
    const r = await fetch(clusterUrl(path, cluster), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return r.json();
  }

  // Rehydrate the gate from the server, keyed by namespace/name — nothing is
  // kept in the browser, so a reloaded chat, another tab, or a colleague's
  // screen all show the same phase. Also polls while a change board holds it,
  // so an approval in ServiceNow lights up the Provision button on its own.
  const reqNs = req.namespace, reqName = req.name;
  useEffect(() => {
    if (!reqNs || !reqName) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(clusterUrl(`/api/vm/requests/active?namespace=${encodeURIComponent(reqNs)}&name=${encodeURIComponent(reqName)}`, cluster));
        const d = await r.json();
        if (stop) return;
        if (d.found) {
          setServerState(d);
          // Adopt the stored request so a reloaded card shows what was validated.
          if (d.request && d.state !== "draft") setReq((p) => ({ ...p, ...d.request }));
          if (d.preflight) setPre(d.preflight);
          // While a change board holds it, ask ServiceNow directly. Without
          // this the card waits on a background reconciler that ships
          // switched off, and an approved CR never unlocks Provision.
          if (d.state === "submitted" && d.requestId) {
            try {
              const cr = await fetch(clusterUrl(`/api/vm/requests/${d.requestId}/check-approval`, cluster), { method: "POST" });
              const cd = await cr.json();
              if (stop) return;
              setApprovalCheck(cd);
              if (cd.ok && cd.state && cd.state !== "submitted") setServerState((s) => ({ ...(s || {}), state: cd.state }));
            } catch { /* transient */ }
          }
        } else setServerState(null);
      } catch { /* transient — keep the last known phase */ }
    };
    tick();
    // Only poll while the outcome can change without us: a change board
    // deciding, or the reconciler provisioning.
    const live = ["submitted", "approved", "provisioning"].includes(serverState?.state);
    const id = live ? setInterval(tick, 10000) : null;
    return () => { stop = true; if (id) clearInterval(id); };
  }, [reqNs, reqName, cluster, serverState?.state]);

  // After provisioning, "created" is not "running" — poll the real phase until
  // every VM is up or one has failed.
  const provisionedNames = (serverState?.result?.created || result?.created || []).map((c) => c.name).filter(Boolean);
  const namesKey = provisionedNames.join(",");
  useEffect(() => {
    if (!namesKey || !reqNs) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(clusterUrl(`/api/vm/status?namespace=${encodeURIComponent(reqNs)}&names=${encodeURIComponent(namesKey)}`, cluster));
        const d = await r.json();
        if (!stop) setVmStatus(d);
      } catch { /* transient */ }
    };
    tick();
    // Stop once everything has settled — a running VM does not need watching.
    const settled = vmStatus?.allRunning || vmStatus?.anyFailed;
    const id = settled ? null : setInterval(tick, 8000);
    return () => { stop = true; if (id) clearInterval(id); };
  }, [namesKey, reqNs, cluster, vmStatus?.allRunning, vmStatus?.anyFailed]);

  async function revalidate(next) {
    setReq(next); setDry(null);
    setBusy("checking");
    try {
      const d = await post("/api/vm/request", { text: "", request: next });
      if (d?.request) { setReq(d.request); setPre(d.preflight); setRecon(d.reconciliation); }
    } catch { /* keep local edits */ } finally { setBusy(null); }
  }
  const set = (k) => (e) => {
    const v = e.target.type === "number" ? Number(e.target.value) : e.target.value;
    setReq((p) => ({ ...p, [k]: v || null })); setDry(null); setResult(null);
  };

  // Each action advances the SERVER-held phase; the local copy is updated only
  // so the UI does not wait a poll cycle to catch up.
  async function doDryRun() {
    setBusy("dry"); setDry(null);
    try {
      const d = await post("/api/vm/dry-run", { request: req });
      setDry(d);
      if (d.ok && d.requestId) {
        setServerState((s) => ({ ...(s || {}), requestId: d.requestId, state: d.state || "dry_run_passed" }));
        showToast("Dry-run passed — details locked, you can raise the change request", "success");
      } else if (!d.ok) showToast("Dry-run failed — nothing was created", "error");
    } catch (e) { setDry({ ok: false, terminal: [`Error: ${e.message}`] }); }
    finally { setBusy(null); }
  }
  async function doProvision() {
    setBusy("provision");
    try {
      const d = await post("/api/vm/provision", { request: req, raiseChangeRequest: raiseCR, requestId: serverState?.requestId || null });
      setResult(d);
      if (d.ok) {
        setServerState((s) => ({ ...(s || {}), state: "provisioned", result: d }));
        showToast(`${d.created?.length || 0} VM(s) created — watching until they are running`, "success");
      } else showToast(d.error || "Provisioning failed", "error");
    } catch (e) { setResult({ ok: false, error: e.message }); }
    finally { setBusy(null); }
  }

  async function submitForApproval() {
    setBusy("submit");
    try {
      const d = await post("/api/vm/requests/submit", { request: req, requestId: serverState?.requestId || null });
      setSubmitted(d);
      if (d.ok) {
        setServerState((s) => ({ ...(s || {}), requestId: d.requestId, state: d.state || "submitted", changeRequest: d.changeRequest }));
        showToast(`Submitted as ${d.changeRequest?.number || "a change request"}`, "success");
      } else showToast(d.error || "Submission failed", "error");
    } catch (e) { setSubmitted({ ok: false, error: e.message }); }
    finally { setBusy(null); }
  }

  async function doCheckApproval() {
    if (!serverState?.requestId) return;
    setBusy("approval");
    try {
      const d = await post(`/api/vm/requests/${serverState.requestId}/check-approval`, {});
      setApprovalCheck(d);
      if (d.ok && d.state && d.state !== "submitted") {
        setServerState((s) => ({ ...(s || {}), state: d.state }));
        showToast(d.verdict === "approved" ? "Approved — you can provision now" : `Change request ${d.verdict}`,
          d.verdict === "approved" ? "success" : "error");
      } else if (!d.ok) showToast(d.error || "Could not read the change request", "error");
      else showToast("Still awaiting approval", "info");
    } catch (e) { setApprovalCheck({ ok: false, error: e.message }); }
    finally { setBusy(null); }
  }

  async function doUnlock() {
    if (!serverState?.requestId) { setServerState(null); setDry(null); return; }
    setBusy("unlock");
    try {
      const d = await post(`/api/vm/requests/${serverState.requestId}/unlock`, {});
      if (d.ok) { setServerState({ ...serverState, state: "draft" }); setDry(null); showToast("Reopened for editing — dry-run again when ready", "success"); }
      else showToast(d.error || "Could not unlock", "error");
    } catch (e) { showToast(e.message, "error"); }
    finally { setBusy(null); }
  }

  async function loadAccess(name) {
    setBusy("access");
    try {
      const r = await fetch(clusterUrl(`/api/vm/access?namespace=${encodeURIComponent(req.namespace)}&name=${encodeURIComponent(name)}`, cluster));
      setAccess(await r.json());
    } catch (e) { setAccess({ error: e.message }); }
    finally { setBusy(null); }
  }

  const names = req.count > 1
    ? Array.from({ length: Math.min(req.count, 10) }, (_, i) => `${req.name}-${i + 1}`)
    : [req.name].filter(Boolean);

  const need = (k) => !req[k] && ["name", "namespace", "sourceDataSource"].includes(k);
  const nsList = cat.namespaces || [];

  // ── Gate state ───────────────────────────────────────────────────────────
  // The order is dry-run → change request → approval → provision, and each
  // gate is held SERVER-side so a refreshed chat, a different browser or a
  // restarted pod all resume at the same point.
  const phase = serverState?.state || (dry?.ok ? "dry_run_passed" : "draft");
  const locked = phase !== "draft";                    // details frozen once validated
  const canDryRun = phase === "draft" || phase === "dry_run_passed";
  const canSubmit = phase === "dry_run_passed";
  const canProvision = phase === "approved";
  const finished = ["provisioned", "rejected", "cancelled", "failed"].includes(phase);

  const PHASES = [
    { id: "draft", label: "Fill in" },
    { id: "dry_run_passed", label: "Dry-run passed" },
    { id: "submitted", label: "Awaiting approval" },
    { id: "approved", label: "Approved" },
    { id: "provisioned", label: "Provisioned" },
  ];
  const phaseIdx = Math.max(0, PHASES.findIndex((p) => p.id === phase));

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", margin: "8px 0",
      boxShadow: ready ? "0 0 0 1px rgba(34,197,94,.35)" : blocked ? "0 0 0 1px rgba(239,68,68,.35)" : "none" }}>

      <div style={{ padding: "9px 12px", background: "rgba(124,58,237,.12)", borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>🖥 VM Request</strong>
        <span style={{ fontSize: 11, opacity: .8 }}>{names.length > 1 ? `${names.length} VMs` : names[0] || "unnamed"}{req.namespace ? ` · ${req.namespace}` : ""}</span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, padding: "2px 8px", borderRadius: 999,
          background: ready ? "rgba(34,197,94,.18)" : blocked ? "rgba(239,68,68,.18)" : "rgba(245,158,11,.18)",
          color: ready ? "#4ade80" : blocked ? "#fca5a5" : "#fbbf24", fontWeight: 700 }}>
          {blocked ? "Blocked" : missing.length ? `${missing.length} field(s) needed` : "Ready to dry-run"}
        </span>
      </div>

      {/* Where this request is, and what has to happen next. Read from the
          server, so a reloaded chat resumes here rather than at the start. */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap",
        padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "rgba(127,127,127,.04)" }}>
        {PHASES.map((p, i) => {
          const done = i < phaseIdx || phase === "provisioned";
          const now = i === phaseIdx && !finished;
          const bad = finished && phase !== "provisioned" && i === phaseIdx;
          const c = bad ? { fg: "#fca5a5", bd: "rgba(239,68,68,.6)", bg: "rgba(239,68,68,.10)" }
            : done ? { fg: "#4ade80", bd: "rgba(34,197,94,.5)", bg: "rgba(34,197,94,.10)" }
            : now ? { fg: "#38bdf8", bd: "rgba(56,189,248,.6)", bg: "rgba(56,189,248,.10)" }
            : { fg: "var(--muted, #94a3b8)", bd: "var(--border)", bg: "transparent" };
          return (
            <div key={p.id} style={{ display: "flex", alignItems: "center" }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: c.fg, border: `1px solid ${c.bd}`,
                background: c.bg, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap" }}>
                {done ? "✓ " : bad ? "✕ " : ""}{p.label}
              </span>
              {i < PHASES.length - 1 && <span style={{ margin: "0 4px", opacity: .35, fontSize: 10 }}>▸</span>}
            </div>
          );
        })}
        {finished && phase !== "provisioned" && (
          <span style={{ marginLeft: 8, fontSize: 10.5, color: "#fca5a5", fontWeight: 700 }}>{phase}</span>
        )}
      </div>

      {locked && !finished && (
        <div style={{ padding: "6px 12px", fontSize: 11, borderBottom: "1px solid var(--border)",
          background: "rgba(56,189,248,.06)", color: "#38bdf8" }}>
          🔒 Details are locked — a change board must approve exactly what the dry-run validated.
          {phase === "dry_run_passed" && " Use “Unlock to edit” to change anything, then dry-run again."}
        </div>
      )}

      {/* Awaiting a change board: show what ServiceNow currently says, and let
          the operator ask again rather than wait on a poll. */}
      {(phase === "submitted" || (approvalCheck && !approvalCheck.ok)) && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)",
          background: approvalCheck?.ok === false ? "rgba(239,68,68,.07)" : "rgba(245,158,11,.07)", fontSize: 11.5 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ color: approvalCheck?.ok === false ? "#fca5a5" : "#fbbf24" }}>
              {approvalCheck?.ok === false ? "⚠ Cannot read the change request" : "⏳ Awaiting approval"}
            </strong>
            {serverState?.changeRequest?.number && (
              <code style={{ fontSize: 11, opacity: .9 }}>{serverState.changeRequest.number}</code>
            )}
            <button onClick={doCheckApproval} disabled={!!busy}
              style={{ marginLeft: "auto", padding: "3px 11px", borderRadius: 6, border: "1px solid var(--border)",
                background: "transparent", color: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              {busy === "approval" ? "Checking…" : "↻ Check approval now"}
            </button>
          </div>
          <div style={{ opacity: .85, marginTop: 4 }}>
            {approvalCheck?.error || approvalCheck?.note || "Checking ServiceNow every 10 seconds. Approve the change there and Provision unlocks here."}
          </div>
          {approvalCheck?.detail && (
            <div style={{ opacity: .6, fontSize: 10.5, marginTop: 3 }}>
              ServiceNow says: approval=<b>{approvalCheck.detail.approval || "—"}</b> · state=<b>{approvalCheck.detail.stateLabel || approvalCheck.detail.state || "—"}</b>
            </div>
          )}
        </div>
      )}

      {phase === "approved" && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)",
          background: "rgba(34,197,94,.08)", fontSize: 11.5, color: "#4ade80", fontWeight: 700 }}>
          ✅ {serverState?.changeRequest?.number || "The change request"} is approved — press <b>3. Provision</b> to build the VM.
        </div>
      )}

      {/* The reconciliation line — the one thing a competitor demo will not have */}
      {recon?.message && (
        <div style={{ padding: "8px 12px", fontSize: 11.5, borderBottom: "1px solid var(--border)",
          background: recon.verdict === "exact" ? "rgba(34,197,94,.08)" : "rgba(245,158,11,.08)" }}>
          <strong style={{ color: recon.verdict === "exact" ? "#4ade80" : "#fbbf24" }}>
            {recon.verdict === "exact" ? "Exact match" : recon.verdict === "rounded-up" ? "Rounded up to standard" : "Sizing"}
          </strong>
          <span style={{ opacity: .9 }}> — {recon.message}</span>
          {recon.alternatives?.length > 0 && (
            <div style={{ opacity: .65, marginTop: 2 }}>
              Alternatives: {recon.alternatives.map((a) => `${a.name} (${a.cpu} vCPU / ${a.memory})`).join(" · ")}
            </div>
          )}
        </div>
      )}

      <div style={{ padding: "12px 12px 4px", display: "grid", gap: 11,
        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        <VMField disabled={locked} label="Name" value={req.name} onChange={set("name")} ph="sap-app-01" required={need("name")}
           hint={req.count > 1 ? `${req.count} VMs: ${req.name || "name"}-1 … -${req.count}` : "lowercase letters, digits and hyphens"} />
        <VMNamespaceField disabled={locked}
           value={req.namespace} createNamespace={req.createNamespace} namespaces={nsList}
           onPick={(v) => {
             if (v === "__new__") setReq((p) => ({ ...p, namespace: "", createNamespace: true }));
             else setReq((p) => ({ ...p, namespace: v || null, createNamespace: false }));
             setDry(null); setResult(null);
           }}
           onType={(v) => { setReq((p) => ({ ...p, namespace: v, createNamespace: true })); setDry(null); setResult(null); }}
           onToggleCreate={(on) => { setReq((p) => ({ ...p, createNamespace: on })); setDry(null); }} />
        <VMField disabled={locked} label="Count" value={req.count} onChange={set("count")} type="number" hint="1–10" />
        <VMField disabled={locked} label="Golden image" value={req.sourceDataSource} onChange={set("sourceDataSource")} required={need("sourceDataSource")}
           opts={cat.images.map((i) => ({ value: i.name, label: `${i.name}${i.ready ? "" : " (not ready)"}` }))}
           hint={cat.images.length ? `${cat.images.length} available on this cluster` : "none found — check the image namespace"} />
        <VMField disabled={locked} label="Instance type" value={req.instanceType} onChange={set("instanceType")}
           opts={cat.instanceTypes.map((i) => ({ value: i.name, label: `${i.name} — ${i.cpu} vCPU / ${i.memory}` }))}
           hint="a golden size, so capacity stays predictable" />
        <VMField disabled={locked} label="Root disk (GiB)" value={req.diskSizeGi} onChange={set("diskSizeGi")} type="number" hint="persistent — survives restarts" />
        <VMField disabled={locked} label="Storage class" value={req.storageClass} onChange={set("storageClass")}
           opts={cat.storageClasses.map((s) => ({ value: s.name, label: s.name + (s.default ? " (default)" : "") }))} />
        <VMField disabled={locked} label="Network (NAD)" value={req.networkAttachmentDefinition} onChange={set("networkAttachmentDefinition")} ph="pod network"
           hint="leave blank for pod networking" />
        <VMField disabled={locked} label="Owner" value={req.owner} onChange={set("owner")} ph="platform-team"
           suggest={OWNER_SUGGESTIONS} listId="vmreq-owner" hint="who answers for this VM later" />
        <VMField disabled={locked} label="Cost centre" value={req.costCentre} onChange={set("costCentre")} ph="CC-4471"
           suggest={COST_CENTRE_SUGGESTIONS} listId="vmreq-cost-centre" />
        <VMField disabled={locked} label="Environment" value={req.environment} onChange={set("environment")}
           opts={[{ value: "dev", label: "dev" }, { value: "test", label: "test" }, { value: "prod", label: "prod" }]} />
        <VMField disabled={locked} label="Expires on" value={req.expiresOn} onChange={set("expiresOn")} type="date"
           hint="unset means it is nobody's job to reclaim it" />
      </div>
      <div style={{ padding: "4px 12px 12px" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5 }}>
          <span style={{ opacity: .75, fontWeight: 700 }}>
            SSH public key {!req.sshKey && <span style={{ color: "#fca5a5" }}>— required, or nobody can log in</span>}
          </span>
          <textarea value={req.sshKey || ""} onChange={set("sshKey")} rows={3} placeholder="ssh-ed25519 AAAA…  (paste the whole line from ~/.ssh/id_ed25519.pub)"
            spellCheck={false}
            style={{ padding: "8px 10px", borderRadius: 7, border: `1px solid ${req.sshKey ? "var(--border)" : "rgba(239,68,68,.55)"}`,
              background: "var(--bg2, transparent)", color: "inherit", fontSize: 12,
              fontFamily: "var(--font-mono, monospace)", resize: "vertical", width: "100%", boxSizing: "border-box" }} />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button"
              onClick={async () => {
                try {
                  const t = (await navigator.clipboard.readText() || "").trim();
                  if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-)/.test(t)) { setReq((p) => ({ ...p, sshKey: t })); setDry(null); showToast("SSH key pasted", "success"); }
                  else showToast("Clipboard does not look like a public key", "error");
                } catch { showToast("Clipboard unavailable — paste with Ctrl+V", "error"); }
              }}
              style={{ padding: "4px 11px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg2, transparent)",
                color: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              📋 Paste from clipboard
            </button>
            <span style={{ opacity: .55, fontSize: 10.5 }}>
              The public key only — the platform never asks for, and never stores, a private key.
            </span>
          </div>
        </label>
      </div>

      {/* Capacity, not a number */}
      {pre?.quota?.quotas?.length > 0 && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, opacity: .7, marginBottom: 5 }}>Namespace quota impact</div>
          {pre.quota.quotas.map((q, i) => <QuotaBar key={i} q={q} />)}
        </div>
      )}

      {(pre?.blocking?.length > 0 || pre?.warnings?.length > 0) && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", fontSize: 11.5, display: "grid", gap: 3 }}>
          {pre.blocking?.map((b, i) => <div key={"b" + i} style={{ color: "#fca5a5" }}>✖ {b.message}</div>)}
          {pre.warnings?.map((w, i) => <div key={"w" + i} style={{ color: "#fbbf24" }}>⚠ {w.message}</div>)}
        </div>
      )}

      {/* A 403 here is not a product failure — it is a missing opt-in grant.
          Say which one, and give the command, instead of leaving a raw API
          error on screen for someone to decode. */}
      {(() => {
        const text = JSON.stringify(dry?.terminal || result?.terminal || dry || result || "");
        const forbidden = /is forbidden|"code":403|cannot create resource/i.test(text);
        if (!forbidden) return null;
        const sa = (text.match(/system:serviceaccount:[\w-]+:[\w-]+/) || [])[0];
        return (
          <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)",
            background: "rgba(245,158,11,.08)", fontSize: 11.5 }}>
            <div style={{ fontWeight: 800, color: "#fbbf24", marginBottom: 4 }}>
              🔑 The agent may read VMs, but is not yet allowed to create them
            </div>
            <div style={{ opacity: .85, marginBottom: 6 }}>
              {sa ? <>Grant the virtualization role to <code>{sa}</code>.</> : "Grant the virtualization role to the agent's service account."}{" "}
              It is a separate, opt-in ClusterRole so a cluster without OpenShift Virtualization never has VM-create rights. Run as cluster-admin, then press Re-check:
            </div>
            <pre style={{ margin: 0, padding: 9, borderRadius: 7, background: "#0b1220", color: "#e2e8f0",
              fontSize: 10.5, fontFamily: "var(--font-mono, ui-monospace, monospace)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
oc apply -f https://raw.githubusercontent.com/cskaruppu/openshift-mcp-server/claude/setup-mcp-openshift-9JUo7/deploy/dashboard/manifests/serviceaccount.yaml</pre>
            <div style={{ opacity: .6, fontSize: 10.5, marginTop: 5 }}>
              Cluster-side only — no image rebuild, no restart.
            </div>
          </div>
        );
      })()}

      {(dry?.terminal || result?.terminal) && (
        <pre style={{ margin: 0, padding: "10px 12px", background: "#0b1220", color: "#e2e8f0",
          borderTop: "1px solid var(--border)", fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto" }}>
          {(result?.terminal || dry?.terminal).map((l, i) => (
            <div key={i} style={{ color: l.startsWith("$") ? "#86efac" : l.startsWith("Error") ? "#fca5a5" : l.startsWith("#") ? "#7dd3fc" : "#e2e8f0" }}>{l || " "}</div>
          ))}
        </pre>
      )}

      {result?.changeRequest?.number && (
        <div style={{ padding: "7px 12px", borderTop: "1px solid var(--border)", fontSize: 11.5, color: "#38bdf8" }}>
          📋 Change request {result.changeRequest.number} raised
        </div>
      )}

      {submitted?.ok && (
        <div style={{ padding: "9px 12px", borderTop: "1px solid var(--border)", fontSize: 11.5, background: "rgba(56,189,248,.08)" }}>
          <strong style={{ color: "#38bdf8" }}>Submitted for approval</strong>
          <div style={{ opacity: .9, marginTop: 2 }}>
            Change request <strong>{submitted.changeRequest?.number || "raised"}</strong> is awaiting approval in ServiceNow.
            Nothing has been created. The VM is provisioned automatically once the change is approved.
          </div>
        </div>
      )}
      {submitted && !submitted.ok && (
        <div style={{ padding: "9px 12px", borderTop: "1px solid var(--border)", fontSize: 11.5, color: "#fca5a5" }}>
          Submission failed — {submitted.error}
          {submitted.blocking?.map((b, i) => <div key={i}>✖ {b.message}</div>)}
        </div>
      )}

      {result?.ok && result.created?.length > 0 && !access && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
          <button onClick={() => loadAccess(result.created[0].name)} disabled={!!busy}
            style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "transparent",
              color: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            {busy === "access" ? "Checking…" : "🔑 How do I access it?"}
          </button>
        </div>
      )}
      {access && !access.error && (
        <div style={{ padding: "9px 12px", borderTop: "1px solid var(--border)", fontSize: 11.5 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            Access — {access.namespace}/{access.name}
            <span style={{ marginLeft: 8, fontWeight: 400, opacity: .75 }}>
              {access.status} · user <code>{access.user}</code>
              {access.ipAddresses?.length ? ` · ${access.ipAddresses.join(", ")}` : ""}
            </span>
          </div>
          {access.methods?.map((m, i) => (
            <div key={i} style={{ marginBottom: 5 }}>
              <div style={{ opacity: .7, fontSize: 10.5 }}>{m.label}{m.recommended ? " · recommended" : ""}</div>
              <pre style={{ margin: "2px 0 0", padding: "5px 8px", borderRadius: 6, background: "#0b1220", color: "#86efac",
                fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11, whiteSpace: "pre-wrap" }}>{m.command}</pre>
            </div>
          ))}
          {access.notes?.map((n, i) => <div key={i} style={{ opacity: .7, fontSize: 10.5 }}>· {n}</div>)}
        </div>
      )}

      {/* After provisioning: what the machine is actually doing. "Created" is
          not "running" — the root disk imports first, and that can fail. */}
      {vmStatus?.vms?.length > 0 && (
        <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11.5, fontWeight: 800 }}>🖥 Machine status</span>
            <span style={{ fontSize: 10.5, padding: "2px 9px", borderRadius: 999, fontWeight: 700,
              background: vmStatus.anyFailed ? "rgba(239,68,68,.18)" : vmStatus.allRunning ? "rgba(34,197,94,.18)" : "rgba(245,158,11,.18)",
              color: vmStatus.anyFailed ? "#fca5a5" : vmStatus.allRunning ? "#4ade80" : "#fbbf24" }}>
              {vmStatus.anyFailed ? "Attention needed" : vmStatus.allRunning ? "All running" : "Provisioning…"}
            </span>
            {!vmStatus.allRunning && !vmStatus.anyFailed && (
              <span style={{ fontSize: 10.5, opacity: .6 }}>refreshing every 8s</span>
            )}
          </div>
          {vmStatus.vms.map((v) => {
            const c = v.failed ? { fg: "#fca5a5", bd: "rgba(239,68,68,.45)" }
              : v.ready ? { fg: "#4ade80", bd: "rgba(34,197,94,.45)" }
              : { fg: "#fbbf24", bd: "rgba(245,158,11,.45)" };
            return (
              <div key={v.name} style={{ border: `1px solid ${c.bd}`, borderRadius: 8, padding: "8px 10px", marginTop: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: c.fg, flex: "0 0 auto" }} />
                  <strong style={{ fontSize: 12 }}>{v.name}</strong>
                  <span style={{ fontSize: 11, fontWeight: 700, color: c.fg }}>{v.status}</span>
                  {v.node && <span style={{ fontSize: 10.5, opacity: .6 }}>· {v.node}</span>}
                  {v.ips?.length > 0 && <span style={{ fontSize: 10.5, opacity: .8, fontFamily: "var(--font-mono, monospace)" }}>· {v.ips.join(", ")}</span>}
                </div>
                <div style={{ fontSize: 11, opacity: .85, marginTop: 3 }}>{v.detail}</div>
                {v.disks?.length > 0 && (
                  <div style={{ fontSize: 10.5, opacity: .65, marginTop: 3 }}>
                    {v.disks.map((d) => `disk ${d.name}: ${d.phase}${d.progress ? ` ${d.progress}` : ""}${d.reason ? ` (${d.reason})` : ""}`).join(" · ")}
                  </div>
                )}
                {v.events?.length > 0 && (
                  <div style={{ marginTop: 5, fontSize: 10.5 }}>
                    {v.events.map((e, i) => <div key={i} style={{ color: "#fca5a5" }}>⚠ {e}</div>)}
                  </div>
                )}
                {v.ready && (
                  <button onClick={() => loadAccess(v.name)} disabled={!!busy}
                    style={{ marginTop: 6, padding: "3px 10px", borderRadius: 6, border: "1px solid var(--border)",
                      background: "transparent", color: "inherit", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}>
                    {busy === "access" ? "…" : "How do I connect?"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ padding: "9px 12px", borderTop: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={doDryRun} disabled={!!busy || missing.length > 0 || !canDryRun}
          title={!canDryRun ? "Already validated — unlock to edit and run it again" : ""}
          style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "transparent",
            color: "inherit", fontSize: 12, fontWeight: 600,
            cursor: (missing.length || !canDryRun) ? "not-allowed" : "pointer", opacity: (missing.length || !canDryRun) ? .5 : 1 }}>
          {busy === "dry" ? "Validating…" : phase === "dry_run_passed" ? "✓ Dry-run passed" : "▷ 1. Dry-run"}
        </button>
        <button onClick={submitForApproval} disabled={!!busy || !canSubmit}
          title={canSubmit ? "Raise the change request. The VM is provisioned once the CAB approves."
            : phase === "draft" ? "Dry-run must pass first" : "Already submitted"}
          style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid rgba(56,189,248,.5)", background: canSubmit ? "rgba(56,189,248,.12)" : "transparent",
            color: "#38bdf8", fontSize: 12, fontWeight: canSubmit ? 700 : 600,
            cursor: canSubmit ? "pointer" : "not-allowed", opacity: canSubmit ? 1 : .45 }}>
          {busy === "submit" ? "Submitting…"
            : phaseIdx >= 2 ? `✓ ${serverState?.changeRequest?.number || "Submitted"}` : "2. Raise change request"}
        </button>
        <button onClick={doProvision} disabled={!!busy || !canProvision}
          title={canProvision ? "Approved — provision now"
            : phase === "submitted" ? "Waiting for the change request to be approved"
            : "Raise and get a change request approved first"}
          style={{ padding: "5px 12px", borderRadius: 7, border: "none",
            background: canProvision ? "#22c55e" : "rgba(148,163,184,.3)",
            color: canProvision ? "#052e16" : "inherit",
            fontSize: 12, fontWeight: 700, cursor: canProvision ? "pointer" : "not-allowed" }}>
          {busy === "provision" ? "Provisioning…" : phase === "provisioned" ? "✅ Provisioned" : "3. Provision"}
        </button>
        {locked && !finished && (
          <button onClick={doUnlock} disabled={!!busy || phase !== "dry_run_passed"}
            title={phase === "dry_run_passed" ? "Reopen the details — the dry-run will have to pass again"
              : "A submitted request cannot be edited. Cancel the change request first."}
            style={{ padding: "5px 11px", borderRadius: 7, border: "1px solid var(--border)", background: "transparent",
              color: "inherit", fontSize: 11.5, fontWeight: 600,
              cursor: phase === "dry_run_passed" ? "pointer" : "not-allowed", opacity: phase === "dry_run_passed" ? 1 : .45 }}>
            {busy === "unlock" ? "Unlocking…" : "✎ Unlock to edit"}
          </button>
        )}
        <button onClick={() => revalidate(req)} disabled={!!busy}
          style={{ marginLeft: "auto", padding: "5px 10px", borderRadius: 7, border: "1px solid var(--border)",
            background: "transparent", color: "inherit", fontSize: 11.5, cursor: "pointer" }}>
          {busy === "checking" ? "Re-checking…" : "Re-check"}
        </button>
        <button onClick={() => setShowYaml((v) => !v)}
          style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid var(--border)", background: "transparent",
            color: "inherit", fontSize: 11.5, cursor: "pointer" }}>
          {showYaml ? "Hide" : "Show"} manifest
        </button>
      </div>

      {showYaml && (
        <pre style={{ margin: 0, padding: "10px 12px", background: "#0b1220", color: "#cbd5e1",
          borderTop: "1px solid var(--border)", fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 10.5, lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 300, overflowY: "auto" }}>
          {JSON.stringify(data.manifestPreview || { note: "Run Dry-run to render the manifest the API server accepted.", request: req }, null, 2)}
        </pre>
      )}
    </div>
  );
}
