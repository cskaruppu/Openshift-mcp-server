import { useState, useCallback, useRef } from "react";
import { useActiveCluster } from "../store/clusterStore";
import { showToast } from "../store/toastStore";

function clusterUrl(path, cluster) {
  if (!cluster || cluster === "local") return path;
  return `${path}${path.includes("?") ? "&" : "?"}cluster=${encodeURIComponent(cluster)}`;
}

const riskColor = (r) => (r === "high" ? "#ef4444" : r === "medium" ? "#f59e0b" : "#22c55e");

const CATEGORY_LABEL = {
  create_namespace: "Namespace", resource_quota: "ResourceQuota", limit_range: "LimitRange",
  network_policy: "NetworkPolicy", rbac_binding: "RBAC", scale_workload: "Scale",
  restart_workload: "Restart", set_image: "Set Image", set_resources: "Set Resources",
  apply_manifest: "Apply", cordon_node: "Cordon", drain_node: "Drain", backup: "Backup",
  restore: "Restore", verify: "Verify", servicenow_change: "ServiceNow CR", manual_step: "Manual",
};

/**
 * SOP Runner (Phase A) — upload/paste a Standard Operating Procedure; the AI
 * compiles it into a validated, step-by-step plan with per-step commands, risk
 * and dry-run preview. Execution (approve & run) is Phase B — intentionally not
 * wired here, so nothing touches a cluster.
 */
export function SopRunner() {
  const cluster = useActiveCluster();
  const [text, setText] = useState("");
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState("");
  const fileRef = useRef(null);
  const [params, setParams] = useState({});
  const [execPhase, setExecPhase] = useState(null); // dry-running | applying | done | failed
  const [execResults, setExecResults] = useState(null);
  const [execMeta, setExecMeta] = useState(null); // { changeRequest, created, rolledBack, success }

  const compile = useCallback(async (formData, jsonBody) => {
    setLoading(true);
    setPlan(null); setParams({}); setExecResults(null); setExecMeta(null); setExecPhase(null);
    try {
      const opts = formData
        ? { method: "POST", body: formData }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(jsonBody) };
      const res = await fetch(clusterUrl("/api/sop/compile", cluster), opts);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Compile failed");
      setPlan(data);
      showToast(`Compiled ${data.steps?.length || 0} step(s) · ${data.compiler}`, "ok");
    } catch (err) {
      showToast("SOP compile failed: " + err.message, "err");
    } finally {
      setLoading(false);
    }
  }, [cluster]);

  const handleCompileText = useCallback(() => {
    if (!text.trim()) { showToast("Paste an SOP or choose a file first", "err"); return; }
    compile(null, { text });
  }, [text, compile]);

  const handleFile = useCallback((e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const fd = new FormData();
    fd.append("file", f);
    compile(fd, null);
  }, [compile]);

  const runExecute = useCallback(async (mode) => {
    setExecPhase(mode === "apply" ? "applying" : "dry-running");
    setExecResults(null);
    try {
      const res = await fetch(clusterUrl("/api/sop/execute", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, params, mode }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Execution failed");
      setExecResults(data.results || []);
      setExecMeta(mode === "apply" ? { changeRequest: data.changeRequest, created: data.created, rolledBack: data.rolledBack, success: data.success } : null);
      setExecPhase(mode === "apply" ? (data.success ? "done" : "failed") : "dry-done");
      showToast(mode === "apply"
        ? (data.success ? `Executed${data.changeRequest?.number ? " · " + data.changeRequest.number : ""}` : "Execution failed — rolled back")
        : `Dry run: ${(data.results || []).filter(r => r.status === "validated" || r.status === "ok").length} ready`, mode === "apply" && !data.success ? "err" : "ok");
    } catch (err) {
      setExecPhase("failed");
      showToast("SOP execute failed: " + err.message, "err");
    }
  }, [cluster, plan, params]);

  const runRollback = useCallback(async () => {
    if (!execMeta?.created?.length) return;
    try {
      const res = await fetch(clusterUrl("/api/sop/rollback", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ created: execMeta.created }),
      });
      const data = await res.json();
      showToast(`Rolled back: ${(data.deleted || []).join(", ") || "nothing"}`, "ok");
      setExecMeta((m) => ({ ...m, created: [], rolledBack: data.deleted || [] }));
    } catch (err) { showToast("Rollback failed: " + err.message, "err"); }
  }, [cluster, execMeta]);

  const destructiveCount = (plan?.steps || []).filter(s => s.destructive).length;
  const unfilled = (plan?.missingParams || []).filter((k) => !params[k]);
  const statusColor = (s) => ({ done: "#16a34a", validated: "#16a34a", ok: "#16a34a", auto: "#06b6d4", warn: "#f59e0b", manual: "#a78bfa", skipped: "#6b7280", error: "#ef4444" }[s] || "#6b7280");

  return (
    <div className="sop card">
      <div className="hub-section-head">
        <span style={{ fontSize: 16 }}>📋</span>
        <h3>SOP Runner — compile a runbook into a plan</h3>
        <span className="sop-phase-badge">Phase A · Preview &amp; Dry-Run</span>
      </div>

      <div className="sop-input-area">
        <textarea
          className="sop-textarea"
          placeholder="Paste a Standard Operating Procedure here — e.g. 'SOP-014: Onboard a new namespace… 1. Create namespace… 2. Apply ResourceQuota…' — or upload a .docx / .md file."
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
        />
        <div className="sop-actions">
          <button className="sop-compile-btn" onClick={handleCompileText} disabled={loading}>
            {loading ? "Compiling…" : "⚙️ Compile Plan"}
          </button>
          <button className="sop-upload-btn" onClick={() => fileRef.current?.click()} disabled={loading}>
            📎 Upload .docx / .md
          </button>
          <input ref={fileRef} type="file" accept=".docx,.md,.markdown,.txt" style={{ display: "none" }} onChange={handleFile} />
          {fileName && <span className="sop-filename">{fileName}</span>}
        </div>
      </div>

      {plan && (
        <div className="sop-plan">
          <div className="sop-plan-head">
            <div>
              <div className="sop-plan-title">{plan.title || "Operating Procedure"}</div>
              <div className="sop-plan-summary">{plan.summary}</div>
            </div>
            <span className="sop-compiler-badge">{plan.compiler === "heuristic" ? "heuristic" : "AI · " + plan.compiler}</span>
          </div>

          {plan.missingParams?.length > 0 && (
            <div className="sop-missing">
              <strong>Parameters the operator must supply:</strong>{" "}
              {plan.missingParams.map((p) => <code key={p} className="sop-param">{p}</code>)}
            </div>
          )}

          {plan.suggestions?.length > 0 && (
            <div className="sop-critic">
              <div className="sop-critic-head">🔎 SOP Review — {plan.suggestions.length} suggestion(s)</div>
              {plan.suggestions.map((s, i) => (
                <div key={i} className={"sop-critic-item sev-" + (s.severity || "info")}>
                  <span className="sop-critic-dot" />
                  <span className="sop-critic-type">{(s.type || "info").replace(/_/g, " ")}</span>
                  <span className="sop-critic-text">{s.text}</span>
                </div>
              ))}
            </div>
          )}

          {plan.steps?.length > 0 ? (
            <div className="sop-steps">
              {plan.steps.map((s) => (
                <div key={s.n} className="sop-step">
                  <div className="sop-step-num">{s.n}</div>
                  <div className="sop-step-body">
                    <div className="sop-step-top">
                      <span className="sop-step-title">{s.title}</span>
                      <span className="sop-cat-chip">{CATEGORY_LABEL[s.category] || s.category}</span>
                      <span className="sop-risk-chip" style={{ background: riskColor(s.risk) + "22", color: riskColor(s.risk) }}>{s.risk}</span>
                      {s.destructive && <span className="sop-destructive">⚠ destructive</span>}
                      {(() => { const r = (execResults || []).find(x => x.n === s.n); return r ? <span className="sop-step-status" style={{ marginLeft: "auto", color: statusColor(r.status) }}>{r.status}{r.detail ? " · " + r.detail : ""}</span> : null; })()}
                    </div>
                    {s.description && s.description !== s.title && <div className="sop-step-desc">{s.description}</div>}
                    {s.command && (
                      <div className="sop-step-cmd">
                        <span className="sop-dry">dry-run</span>
                        <code>{s.command}</code>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="sop-empty">No executable steps were detected in this document.</div>
          )}

          {/* Phase B — parameters + execution controls */}
          {plan.steps?.length > 0 && (
            <div className="sop-exec">
              {plan.missingParams?.length > 0 && (
                <div className="sop-param-inputs">
                  {plan.missingParams.map((k) => (
                    <label key={k} className="sop-param-field">
                      <span>{k}</span>
                      <input value={params[k] || ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} placeholder={`<${k}>`} />
                    </label>
                  ))}
                </div>
              )}
              <div className="sop-exec-actions">
                <button className="sop-dry-btn" onClick={() => runExecute("dryrun")} disabled={execPhase === "dry-running" || execPhase === "applying"}>
                  {execPhase === "dry-running" ? "Validating…" : "▷ Dry Run All"}
                </button>
                <button
                  className="sop-apply-btn"
                  disabled={execPhase === "applying" || execPhase === "dry-running" || unfilled.length > 0}
                  onClick={() => { if (window.confirm(`Execute this SOP on cluster "${cluster}"?\n\nThis raises a ServiceNow Change Request and applies ${plan.steps.length - destructiveCount} step(s). Destructive steps are NOT auto-run. Anything created is auto-rolled-back on failure.`)) runExecute("apply"); }}
                >
                  {execPhase === "applying" ? "Executing…" : "▶ Approve & Execute"}
                </button>
                {unfilled.length > 0 && <span className="sop-exec-hint">Fill {unfilled.join(", ")} to enable execute</span>}
                {execMeta?.created?.length > 0 && (
                  <button className="sop-rollback-btn" onClick={runRollback}>↩ Rollback ({execMeta.created.length})</button>
                )}
              </div>

              {execMeta && (
                <div className={"sop-exec-result " + (execMeta.success ? "ok" : "fail")}>
                  {execMeta.success ? "✓ Executed successfully" : "✗ Failed — auto-rolled back"}
                  {execMeta.changeRequest?.number && <> · Change Request <strong>{execMeta.changeRequest.number}</strong></>}
                  {execMeta.rolledBack?.length > 0 && <> · rolled back: {execMeta.rolledBack.join(", ")}</>}
                </div>
              )}
            </div>
          )}

          <div className="sop-footer">
            <span>{plan.steps?.length || 0} step(s) · {destructiveCount} destructive (never auto-run)</span>
            <span className="sop-phaseb-note">Dry-run validates; Execute raises a ServiceNow Change Request, applies safe steps, and auto-rolls-back on failure.</span>
          </div>
        </div>
      )}
    </div>
  );
}
