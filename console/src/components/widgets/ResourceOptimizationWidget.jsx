import { useState, useCallback } from "react";
import { useClusterQuery, REFRESH } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";
import { showToast } from "../../store/toastStore";

function clusterUrl(path, cluster) {
  if (!cluster || cluster === "local") return path;
  return `${path}${path.includes("?") ? "&" : "?"}cluster=${encodeURIComponent(cluster)}`;
}

const gradeColor = (g) =>
  g === "A" ? "#22c55e" : g === "B" ? "#84cc16" : g === "C" ? "#f59e0b" : g === "D" ? "#f97316" : "#ef4444";

const headroomColor = (pct) =>
  pct >= 30 ? "#22c55e" : pct >= 15 ? "#f59e0b" : "#ef4444";

const utilizationColor = (pct) =>
  pct <= 20 ? "#ef4444" : pct <= 50 ? "#f59e0b" : pct <= 85 ? "#22c55e" : "#3b82f6";

const sevColor = (s) => {
  if (s === "critical") return "#ef4444";
  if (s === "high") return "#f97316";
  if (s === "medium") return "#f59e0b";
  return "#22c55e";
};

export function ResourceOptimizationWidget() {
  const cluster = useActiveCluster();
  const { data, isLoading, isError, error, refetch } = useClusterQuery(
    "/api/dashboard/optimization",
    { refetchInterval: REFRESH.SCAN }
  );
  const [expanded, setExpanded] = useState(null);
  const [showPVCs, setShowPVCs] = useState(false);
  const [deletingPVC, setDeletingPVC] = useState(null);
  const [aiFindings, setAiFindings] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiProvider, setAiProvider] = useState(null);
  const [expandedAi, setExpandedAi] = useState(null);

  const handleDeletePVC = useCallback(async (name, ns) => {
    if (!confirm(`Delete orphaned PVC "${name}" in namespace "${ns}"?`)) return;
    setDeletingPVC(`${ns}/${name}`);
    try {
      const res = await fetch(clusterUrl(`/api/pvc/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, cluster), { method: "DELETE" });
      if (res.ok) { showToast(`PVC ${name} deleted`, "ok"); refetch(); }
      else showToast("Delete failed", "err");
    } catch (err) { showToast("Delete failed: " + err.message, "err"); }
    finally { setDeletingPVC(null); }
  }, [cluster, refetch]);

  const handleAiAnalysis = useCallback(async () => {
    setAiLoading(true);
    setAiFindings(null);
    try {
      const res = await fetch(clusterUrl("/api/ai/optimization-analysis", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Analysis failed");
      setAiFindings(json.findings || []);
      setAiProvider(json.provider || null);
      showToast(`AI optimization analysis — ${(json.findings || []).length} recommendations`, "ok");
    } catch (err) {
      showToast("AI analysis failed: " + err.message, "err");
    } finally {
      setAiLoading(false);
    }
  }, [cluster]);

  if (isLoading) return <div className="ro"><div className="ro-header"><h3>Resource Optimization</h3></div><div className="ro-loading">Analyzing resource usage…</div></div>;
  if (isError) return <div className="ro"><div className="ro-header"><h3>Resource Optimization</h3></div><div className="ro-error">{String(error?.message)}</div></div>;
  if (!data) return <div className="ro"><div className="ro-header"><h3>Resource Optimization</h3></div><div className="ro-empty">No optimization data available</div></div>;

  const d = data;
  const score = d.efficiencyScore ?? 0;
  const gc = gradeColor(d.grade);
  const circumference = 2 * Math.PI * 42;
  const offset = circumference - (score / 100) * circumference;

  const cpuH = d.cpuHeadroom ?? 0;
  const memH = d.memHeadroom ?? 0;
  const pvc = d.pvc || {};
  const problems = d.topProblems || [];
  const orphaned = pvc.orphanedList || [];

  const totalIssues = (d.overProvisioned || 0) + (d.underProvisioned || 0) + (d.noLimits || 0);
  const healthPct = d.totalPods > 0 ? Math.round(((d.totalPods - totalIssues) / d.totalPods) * 100) : 100;

  const stoTotal = (pvc.usedStorageGi || 0) + (pvc.allocatedUnusedGi || 0) + (pvc.orphanedStorageGi || 0) || 1;
  const stoUsedPct = ((pvc.usedStorageGi || 0) / stoTotal) * 100;
  const stoAllocPct = ((pvc.allocatedUnusedGi || 0) / stoTotal) * 100;
  const stoOrphPct = ((pvc.orphanedStorageGi || 0) / stoTotal) * 100;

  return (
    <div className="ro">
      {/* Header */}
      <div className="ro-header">
        <h3>Resource Optimization</h3>
        <div className="ro-header-actions">
          <button className="ro-ai-btn" onClick={handleAiAnalysis} disabled={aiLoading}>
            {aiLoading ? "Analyzing…" : "AI Optimization"}
          </button>
          <button className="ro-refresh-btn" onClick={() => refetch()} title="Refresh analysis">Analyze</button>
        </div>
      </div>

      {/* Hero: Score + Reclaim */}
      <div className="ro-hero">
        <div className="ro-score-ring">
          <svg viewBox="0 0 96 96" width="96" height="96">
            <circle cx="48" cy="48" r="42" fill="none" stroke="var(--border)" strokeWidth="6" />
            <circle cx="48" cy="48" r="42" fill="none" stroke={gc} strokeWidth="6" strokeLinecap="round"
              strokeDasharray={circumference} strokeDashoffset={offset}
              style={{ transform: "rotate(-90deg)", transformOrigin: "center", transition: "stroke-dashoffset .8s ease" }} />
          </svg>
          <div className="ro-score-inner">
            <div className="ro-score-num">{score}</div>
            <div className="ro-score-max">/100</div>
          </div>
        </div>
        <div className="ro-hero-info">
          <div className="ro-grade-pill" style={{ background: gc + "18", color: gc, borderColor: gc }}>{d.grade || "?"}</div>
          <div className="ro-hero-label">Efficiency Score</div>
          <div className="ro-hero-meta">{d.totalPods || 0} pods analyzed · {healthPct}% properly sized</div>
        </div>

        <div className="ro-reclaim-cards">
          <div className="ro-reclaim-card">
            <div className="ro-reclaim-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#3b82f6" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6M9 12h4"/></svg>
            </div>
            <div className="ro-reclaim-val">{d.reclaimCpu || 0}<span className="ro-reclaim-unit">m</span></div>
            <div className="ro-reclaim-label">CPU Reclaim</div>
          </div>
          <div className="ro-reclaim-card">
            <div className="ro-reclaim-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#8b5cf6" strokeWidth="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h4M14 10v4"/></svg>
            </div>
            <div className="ro-reclaim-val">{d.reclaimMemGi || 0}<span className="ro-reclaim-unit">Gi</span></div>
            <div className="ro-reclaim-label">Memory Reclaim</div>
          </div>
          <div className="ro-reclaim-card">
            <div className="ro-reclaim-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#06b6d4" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
            </div>
            <div className="ro-reclaim-val">{d.reclaimStorageGi || 0}<span className="ro-reclaim-unit">Gi</span></div>
            <div className="ro-reclaim-label">Storage Reclaim</div>
          </div>
        </div>
      </div>

      {/* Pod Issue Stats */}
      <div className="ro-issue-row">
        <div className="ro-issue-card" style={{ "--issue-color": "#ef4444" }}>
          <div className="ro-issue-num">{d.overProvisioned || 0}</div>
          <div className="ro-issue-label">Over-provisioned</div>
          <div className="ro-issue-hint">CPU usage &lt;10% of request</div>
        </div>
        <div className="ro-issue-card" style={{ "--issue-color": "#f97316" }}>
          <div className="ro-issue-num">{d.underProvisioned || 0}</div>
          <div className="ro-issue-label">Under-provisioned</div>
          <div className="ro-issue-hint">CPU usage &gt;150% of request</div>
        </div>
        <div className="ro-issue-card" style={{ "--issue-color": "#f59e0b" }}>
          <div className="ro-issue-num">{d.noLimits || 0}</div>
          <div className="ro-issue-label">No Limits Set</div>
          <div className="ro-issue-hint">CIS 5.4.1 compliance gap</div>
        </div>
      </div>

      {/* Headroom Gauges */}
      <div className="ro-headroom">
        <div className="ro-headroom-title">Cluster Headroom</div>
        <div className="ro-headroom-row">
          <div className="ro-gauge">
            <div className="ro-gauge-label">
              <span>CPU</span>
              <span style={{ color: headroomColor(cpuH), fontWeight: 700 }}>{cpuH.toFixed(1)}%</span>
            </div>
            <div className="ro-gauge-track">
              <div className="ro-gauge-fill" style={{ width: `${Math.min(100, cpuH)}%`, background: headroomColor(cpuH) }} />
            </div>
            <div className="ro-gauge-hint">{cpuH >= 30 ? "Healthy" : cpuH >= 15 ? "Tight" : "Critical"}</div>
          </div>
          <div className="ro-gauge">
            <div className="ro-gauge-label">
              <span>Memory</span>
              <span style={{ color: headroomColor(memH), fontWeight: 700 }}>{memH.toFixed(1)}%</span>
            </div>
            <div className="ro-gauge-track">
              <div className="ro-gauge-fill" style={{ width: `${Math.min(100, memH)}%`, background: headroomColor(memH) }} />
            </div>
            <div className="ro-gauge-hint">{memH >= 30 ? "Healthy" : memH >= 15 ? "Tight" : "Critical"}</div>
          </div>
        </div>
        <div className="ro-headroom-bench">Best practice: 20–40% headroom (Google SRE)</div>
      </div>

      {/* Right-Sizing Opportunities */}
      {problems.length > 0 && (
        <div className="ro-problems">
          <div className="ro-problems-title">Top Right-Sizing Opportunities</div>
          <div className="ro-problems-list">
            {problems.map((p, i) => (
              <div key={i} className={"ro-problem" + (expanded === i ? " expanded" : "")} style={{ "--prob-color": p.type === "over" ? "#ef4444" : p.type === "under" ? "#f97316" : "#f59e0b" }}>
                <div className="ro-problem-header" onClick={() => setExpanded(expanded === i ? null : i)}>
                  <span className="ro-problem-tag">{p.type === "over" ? "OVER" : p.type === "under" ? "UNDER" : "NOLIM"}</span>
                  <div className="ro-problem-info">
                    <div className="ro-problem-name">{p.name}</div>
                    <div className="ro-problem-ns">{p.ns}</div>
                  </div>
                  <div className="ro-problem-cpu">
                    <span className="ro-cpu-used">{p.cpuUsed}m</span>
                    <span className="ro-cpu-arrow">→</span>
                    <span className="ro-cpu-req">{p.cpuReq}m</span>
                  </div>
                  <span className="ro-problem-chevron">{expanded === i ? "▲" : "▼"}</span>
                </div>
                {expanded === i && (
                  <div className="ro-problem-detail">
                    <div className="ro-detail-grid">
                      <div className="ro-detail-item">
                        <span className="ro-detail-lbl">CPU Request</span>
                        <span className="ro-detail-val">{p.cpuReq}m</span>
                      </div>
                      <div className="ro-detail-item">
                        <span className="ro-detail-lbl">CPU Usage</span>
                        <span className="ro-detail-val">{p.cpuUsed}m</span>
                      </div>
                      <div className="ro-detail-item">
                        <span className="ro-detail-lbl">Memory Request</span>
                        <span className="ro-detail-val">{p.memReq}Mi</span>
                      </div>
                      <div className="ro-detail-item">
                        <span className="ro-detail-lbl">Memory Usage</span>
                        <span className="ro-detail-val">{p.memUsed}Mi</span>
                      </div>
                    </div>
                    {(p.cpuRecommend || p.memRecommend) && (
                      <div className="ro-recommend">
                        <div className="ro-recommend-title">Recommended</div>
                        <div className="ro-recommend-vals">
                          {p.cpuRecommend && <span>CPU: <strong>{p.cpuRecommend}m</strong></span>}
                          {p.memRecommend && <span>Memory: <strong>{p.memRecommend}Mi</strong></span>}
                        </div>
                      </div>
                    )}
                    {p.detail && <div className="ro-problem-note">{p.detail}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Storage Overview */}
      {pvc.total > 0 && (
        <div className="ro-storage">
          <div className="ro-storage-header">
            <span className="ro-storage-title">Storage Overview</span>
            <span className="ro-storage-meta">{pvc.total} PVCs · {(pvc.totalCapacityGi || 0).toFixed(1)} Gi total</span>
          </div>

          {/* Stacked bar */}
          <div className="ro-sto-bar-row">
            <div className="ro-sto-bar">
              <div className="ro-sto-seg" style={{ width: `${stoUsedPct}%`, background: "#22c55e" }} title={`Used: ${(pvc.usedStorageGi || 0).toFixed(1)} Gi`} />
              <div className="ro-sto-seg" style={{ width: `${stoAllocPct}%`, background: "#3b82f6" }} title={`Allocated unused: ${(pvc.allocatedUnusedGi || 0).toFixed(1)} Gi`} />
              <div className="ro-sto-seg" style={{ width: `${stoOrphPct}%`, background: "#f97316" }} title={`Orphaned: ${(pvc.orphanedStorageGi || 0).toFixed(1)} Gi`} />
            </div>
            <div className="ro-sto-legend">
              <span><span className="ro-sto-dot" style={{ background: "#22c55e" }} />Used ({(pvc.usedStorageGi || 0).toFixed(1)} Gi)</span>
              <span><span className="ro-sto-dot" style={{ background: "#3b82f6" }} />Allocated Unused ({(pvc.allocatedUnusedGi || 0).toFixed(1)} Gi)</span>
              <span><span className="ro-sto-dot" style={{ background: "#f97316" }} />Orphaned ({(pvc.orphanedStorageGi || 0).toFixed(1)} Gi)</span>
            </div>
          </div>

          {/* PVC Stats */}
          <div className="ro-pvc-stats">
            <div className="ro-pvc-stat"><strong>{pvc.bound || 0}</strong> bound</div>
            <div className="ro-pvc-stat"><strong style={{ color: "#f97316" }}>{pvc.orphaned || 0}</strong> orphaned</div>
            <div className="ro-pvc-stat"><strong style={{ color: "#f59e0b" }}>{pvc.pending || 0}</strong> pending</div>
            {pvc.lost > 0 && <div className="ro-pvc-stat"><strong style={{ color: "#ef4444" }}>{pvc.lost}</strong> lost</div>}
          </div>

          {/* Orphaned PVCs */}
          {orphaned.length > 0 && (
            <div className="ro-orphaned">
              <button className="ro-orphaned-toggle" onClick={() => setShowPVCs(!showPVCs)}>
                <span>{showPVCs ? "▲" : "▼"}</span> {orphaned.length} Orphaned PVC{orphaned.length > 1 ? "s" : ""} — reclaimable {(pvc.orphanedStorageGi || 0).toFixed(1)} Gi
              </button>
              {showPVCs && (
                <div className="ro-orphaned-list">
                  {orphaned.slice(0, 15).map((o, i) => (
                    <div key={i} className="ro-orphaned-row">
                      <div className="ro-orphaned-info">
                        <span className="ro-orphaned-name">{o.name}</span>
                        <span className="ro-orphaned-ns">{o.ns}</span>
                      </div>
                      <span className="ro-orphaned-size">{o.sizeGi?.toFixed(1) || o.size} Gi</span>
                      <span className="ro-orphaned-sc">{o.storageClass || "—"}</span>
                      <span className="ro-orphaned-age">{o.ageDays || 0}d</span>
                      <button
                        className="ro-orphaned-del"
                        onClick={() => handleDeletePVC(o.name, o.ns)}
                        disabled={deletingPVC === `${o.ns}/${o.name}`}
                      >
                        {deletingPVC === `${o.ns}/${o.name}` ? "…" : "Delete"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* PVC Details */}
          {(pvc.pvcDetails || []).length > 0 && (
            <div className="ro-pvc-table-wrap">
              <table className="ro-pvc-table">
                <thead>
                  <tr>
                    <th>PVC</th>
                    <th>Namespace</th>
                    <th>Size</th>
                    <th>Used</th>
                    <th>Class</th>
                    <th>Status</th>
                    <th>Recommendation</th>
                  </tr>
                </thead>
                <tbody>
                  {(pvc.pvcDetails || []).slice(0, 12).map((p, i) => (
                    <tr key={i}>
                      <td className="ro-pvc-name">{p.name}</td>
                      <td className="ro-pvc-ns">{p.ns}</td>
                      <td>{p.sizeGi?.toFixed(1) || "—"} Gi</td>
                      <td>
                        <span style={{ color: utilizationColor(p.usedPct || 0), fontWeight: 700 }}>
                          {(p.usedPct || 0).toFixed(0)}%
                        </span>
                      </td>
                      <td className="ro-pvc-sc">{p.storageClass || "—"}</td>
                      <td>
                        <span className={"ro-pvc-phase " + (p.phase || "").toLowerCase()}>
                          {p.phase || "—"}
                        </span>
                      </td>
                      <td className="ro-pvc-rec">{p.recommendation || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Industry Benchmarks */}
      <div className="ro-benchmarks">
        <div className="ro-bench-title">Industry Benchmarks</div>
        <div className="ro-bench-grid">
          <BenchmarkPill label="Right-Sizing" value={healthPct} target={85} unit="%" source="Gartner FinOps" />
          <BenchmarkPill label="Limits Coverage" value={d.totalPods > 0 ? Math.round(((d.totalPods - (d.noLimits || 0)) / d.totalPods) * 100) : 100} target={100} unit="%" source="CIS 5.4.1" />
          <BenchmarkPill label="CPU Headroom" value={Math.round(cpuH)} target={25} unit="%" source="Google SRE" above />
          <BenchmarkPill label="Storage Waste" value={pvc.total > 0 ? Math.round(((pvc.orphaned || 0) / pvc.total) * 100) : 0} target={5} unit="%" source="FinOps" invert />
        </div>
      </div>

      {/* AI Optimization Analysis */}
      {aiLoading && (
        <div className="ro-ai-loading">
          <div className="ro-ai-spinner" />
          <span>AI analyzing historical utilization, capacity trends & FinOps benchmarks…</span>
        </div>
      )}

      {aiFindings && aiFindings.length > 0 && (
        <div className="ro-ai-panel">
          <div className="ro-ai-header">
            <div className="ro-ai-header-left">
              <span className="ro-ai-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22l-.75-12.07A4.001 4.001 0 0 1 12 2z"/><circle cx="12" cy="6" r="1" fill="#8b5cf6"/><path d="M5 10l2 2M19 10l-2 2M5 18h3M16 18h3"/></svg>
              </span>
              <h4>AI Optimization Recommendations</h4>
              <span className="ro-ai-count">{aiFindings.length} insights</span>
            </div>
            {aiProvider && <span className="ro-ai-provider">{aiProvider}</span>}
          </div>
          <div className="ro-ai-findings">
            {aiFindings.map((f, i) => (
              <div key={i} className={"ro-ai-finding" + (expandedAi === i ? " expanded" : "")} style={{ "--ai-sev": sevColor(f.severity) }}>
                <div className="ro-ai-finding-header" onClick={() => setExpandedAi(expandedAi === i ? null : i)}>
                  <span className="ro-ai-sev-dot" />
                  <div className="ro-ai-finding-title">
                    <div className="ro-ai-title-text">{f.title}</div>
                    <div className="ro-ai-title-meta">
                      <span className={"ro-ai-sev-pill " + f.severity}>{f.severity}</span>
                      {f.category && <span className="ro-ai-cat">{f.category}</span>}
                      {f.timeframe && <span className="ro-ai-timeframe">{f.timeframe}</span>}
                      {f.savings && <span className="ro-ai-savings">{f.savings}</span>}
                    </div>
                  </div>
                  <span className="ro-ai-chevron">{expandedAi === i ? "▲" : "▼"}</span>
                </div>
                {expandedAi === i && (
                  <div className="ro-ai-finding-body">
                    {f.evidence && <div className="ro-ai-section"><span className="ro-ai-lbl">Evidence</span><p>{f.evidence}</p></div>}
                    {f.impact && <div className="ro-ai-section"><span className="ro-ai-lbl">Impact</span><p>{f.impact}</p></div>}
                    {f.action && <div className="ro-ai-section ro-ai-action"><span className="ro-ai-lbl">Recommended Action</span><p>{f.action}</p></div>}
                    <div className="ro-ai-footer-tags">
                      {f.confidence && <span className="ro-ai-conf">{Math.round(f.confidence * 100)}% confidence</span>}
                      {f.timeframe && <span className="ro-ai-tf-tag">{f.timeframe}</span>}
                      {f.savings && <span className="ro-ai-save-tag">{f.savings}</span>}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BenchmarkPill({ label, value, target, unit, source, invert, above }) {
  const met = invert ? value <= target : above ? value >= target : value >= target;
  const color = met ? "#22c55e" : value >= (invert ? target * 2 : target * 0.7) ? "#f59e0b" : "#ef4444";
  return (
    <div className="ro-bench-pill" style={{ "--bench-color": color }}>
      <div className="ro-bench-val">{value}{unit}</div>
      <div className="ro-bench-label">{label}</div>
      <div className="ro-bench-target">{invert ? "≤" : "≥"}{target}{unit} <span className="ro-bench-src">{source}</span></div>
      <div className="ro-bench-status" style={{ color }}>{met ? "✓ Met" : "✗ Below"}</div>
    </div>
  );
}
