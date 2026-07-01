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

  const compile = useCallback(async (formData, jsonBody) => {
    setLoading(true);
    setPlan(null);
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

  const destructiveCount = (plan?.steps || []).filter(s => s.destructive).length;

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

          <div className="sop-footer">
            <span>
              {plan.steps?.length || 0} step(s) · {destructiveCount} destructive · preview only — nothing was executed.
            </span>
            <span className="sop-phaseb-note">Approve &amp; Execute (with rollback + ServiceNow Change Request) is Phase B.</span>
          </div>
        </div>
      )}
    </div>
  );
}
