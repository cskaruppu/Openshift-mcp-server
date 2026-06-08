import { useState, useCallback } from "react";
import { useClusterQuery } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";
import { showToast } from "../../store/toastStore";

function clusterUrl(path, cluster) {
  if (!cluster || cluster === "local") return path;
  return `${path}${path.includes("?") ? "&" : "?"}cluster=${encodeURIComponent(cluster)}`;
}

const SEV = {
  critical: { color: "#ef4444", bg: "rgba(239,68,68,0.1)", icon: "!" },
  warning: { color: "#f59e0b", bg: "rgba(245,158,11,0.1)", icon: "!" },
  info: { color: "#3b82f6", bg: "rgba(59,130,246,0.1)", icon: "i" },
};

const CAT_ICONS = {
  pod: "\u{1F4E6}",
  node: "\u{1F5A5}",
  cluster: "\u{2601}",
  operator: "\u{2699}",
  capacity: "\u{1F4CA}",
  restart: "\u{1F504}",
  memory: "\u{1F9E0}",
  cpu: "\u{26A1}",
  event: "\u{1F514}",
  correlation: "\u{1F517}",
  cascade: "\u{26D4}",
  spof: "\u{26A0}",
  security: "\u{1F512}",
  namespace_health: "\u{1F3E2}",
  pattern: "\u{1F50D}",
  stale: "\u{23F0}",
};

function sevInfo(s) { return SEV[s] || SEV.info; }
function catIcon(cat) { return CAT_ICONS[cat] || "\u{1F50D}"; }

function relTime(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function scoreFromPod(p) {
  let score = 0;
  const issue = (p.issues && p.issues[0]) || {};
  const restarts = issue.restarts || 0;
  const phase = p.phase || "";
  if (phase === "Failed") score += 50;
  if (/CrashLoop/i.test(phase) || /CrashLoop/i.test(issue.reason || "")) score += 60;
  if (/ImagePull|ErrImage/i.test(issue.reason || "")) score += 40;
  if (/OOM/i.test(issue.reason || "")) score += 55;
  score += Math.min(40, restarts * 5);
  return Math.min(100, score);
}

function deriveNodeRisks(nodes) {
  if (!Array.isArray(nodes)) return [];
  const risks = [];
  for (const n of nodes) {
    if (!n.ready) {
      risks.push({
        id: `node-notready-${n.name}`, category: "node", severity: "critical",
        title: `Node ${n.name} is NotReady`,
        target: n.name, scope: "node",
        evidence: `Node has been in NotReady state. Roles: ${(n.roles || []).join(", ") || "worker"}`,
        impact: "Pods on this node will be evicted. Workloads may experience downtime.",
        action: "Check kubelet status, node connectivity, and resource availability.",
        confidence: 99, score: 95,
      });
    }
    if (n.memoryPressure) {
      risks.push({
        id: `node-mem-${n.name}`, category: "memory", severity: "warning",
        title: `Memory pressure on ${n.name}`,
        target: n.name, scope: "node",
        evidence: "Node is reporting MemoryPressure condition.",
        impact: "OOM kills likely. Pods may be evicted to free memory.",
        action: "Investigate memory-intensive workloads. Consider scaling or adding nodes.",
        confidence: 95, score: 75,
      });
    }
    if (n.diskPressure) {
      risks.push({
        id: `node-disk-${n.name}`, category: "capacity", severity: "warning",
        title: `Disk pressure on ${n.name}`,
        target: n.name, scope: "node",
        evidence: "Node is reporting DiskPressure condition.",
        impact: "Container image pulls may fail. Log rotation stopped.",
        action: "Clean up unused images, check log volume, expand disk.",
        confidence: 95, score: 70,
      });
    }
    if (n.pidPressure) {
      risks.push({
        id: `node-pid-${n.name}`, category: "node", severity: "warning",
        title: `PID pressure on ${n.name}`,
        target: n.name, scope: "node",
        evidence: "Node is reporting PIDPressure condition.",
        impact: "New processes cannot be created. Pods may fail to start.",
        action: "Investigate process leaks. Check for fork bombs or runaway containers.",
        confidence: 95, score: 65,
      });
    }
  }
  return risks;
}

function derivePodRisks(pods) {
  if (!Array.isArray(pods)) return [];
  return pods.map((p) => {
    const issue = (p.issues && p.issues[0]) || {};
    const score = scoreFromPod(p);
    if (score === 0) return null;
    const reason = issue.reason || p.phase || "issue";
    let category = "pod";
    if (/CrashLoop/i.test(reason)) category = "restart";
    else if (/OOM/i.test(reason)) category = "memory";
    else if (/ImagePull/i.test(reason)) category = "pod";

    const sev = score >= 70 ? "critical" : score >= 40 ? "warning" : "info";
    return {
      id: `pod-${p.namespace}-${p.name}`,
      category, severity: sev,
      title: `${p.name}: ${reason}`,
      target: `${p.namespace}/${p.name}`, scope: "pod",
      evidence: `Phase: ${p.phase}. Restarts: ${issue.restarts || 0}. Reason: ${reason}`,
      impact: sev === "critical" ? "Service disruption likely. Dependent services may cascade fail." : "Pod health degraded. May recover or escalate.",
      action: reason.includes("CrashLoop") ? "Check container logs, fix application error or resource limits." : reason.includes("ImagePull") ? "Verify image name, registry credentials, and network connectivity." : "Investigate pod logs and events.",
      confidence: 99, score,
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 15);
}

export function RiskPredictionsWidget() {
  const cluster = useActiveCluster();
  const { data: podData, isLoading: podLoading } = useClusterQuery("/api/pods/issues");
  const { data: nodeData, isLoading: nodeLoading } = useClusterQuery("/api/nodes");
  const { data: predData, isLoading: predLoading, refetch: refetchPred } = useClusterQuery(
    "/api/intelligence/predictions",
    { refetchInterval: 60_000 }
  );

  const [llmFindings, setLlmFindings] = useState([]);
  const [llmRunning, setLlmRunning] = useState(false);
  const [filter, setFilter] = useState("all");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [expandedRisk, setExpandedRisk] = useState(null);

  const podRisks = derivePodRisks(Array.isArray(podData) ? podData : []);
  const nodeRisks = deriveNodeRisks(Array.isArray(nodeData) ? nodeData : []);

  const predictions = (predData?.predictions || []).map((p) => ({
    id: `pred-${p.type}-${p.target || "cluster"}`,
    category: p.type?.includes("Memory") ? "memory" : p.type?.includes("CPU") ? "cpu" : p.type?.includes("Restart") ? "restart" : p.type?.includes("Event") ? "event" : p.type?.includes("Operator") ? "operator" : "cluster",
    severity: p.severity || "info",
    title: p.type?.replace(/([A-Z])/g, " $1").trim() || "Prediction",
    target: p.target || "cluster",
    scope: p.type?.includes("Node") || p.type?.includes("Memory") || p.type?.includes("CPU") ? "node" : p.type?.includes("Restart") ? "pod" : "cluster",
    evidence: p.reason || "",
    impact: p.hoursRemaining ? `Estimated ${p.hoursRemaining.toFixed(1)}h until threshold breach` : "",
    action: p.action || "",
    confidence: Math.round((p.confidence || 0.7) * 100),
    score: Math.round((p.confidence || 0.7) * (p.severity === "critical" ? 95 : p.severity === "warning" ? 70 : 45)),
    predicted: true,
  }));

  const llmMapped = llmFindings.map((f) => ({
    id: `llm-${f.title?.slice(0, 20)}`,
    category: f.category || "pattern",
    severity: f.severity || "info",
    title: f.title || "AI Finding",
    target: f.target || "cluster",
    scope: "cluster",
    evidence: f.evidence || "",
    impact: f.impact || "",
    action: f.action || "",
    confidence: f.confidence || 85,
    score: f.confidence || 85,
    llm: true,
  }));

  const allRisks = [...podRisks, ...nodeRisks, ...predictions, ...llmMapped]
    .sort((a, b) => b.score - a.score);

  const filtered = allRisks
    .filter((r) => filter === "all" || r.severity === filter)
    .filter((r) => scopeFilter === "all" || r.scope === scopeFilter);

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const r of allRisks) { if (counts[r.severity] !== undefined) counts[r.severity]++; }
  const avgConf = allRisks.length > 0 ? Math.round(allRisks.reduce((s, r) => s + (r.confidence || 0), 0) / allRisks.length) : 0;

  const isLoading = podLoading || nodeLoading || predLoading;

  const runLLMAnalysis = useCallback(async () => {
    setLlmRunning(true);
    try {
      const res = await fetch(clusterUrl("/api/risk-analysis", cluster), { method: "POST" });
      const data = await res.json();
      setLlmFindings(data.findings || data.risks || []);
      showToast(`AI analysis complete: ${(data.findings || data.risks || []).length} findings`, "ok");
    } catch (err) {
      showToast("AI analysis failed: " + err.message, "err");
    } finally {
      setLlmRunning(false);
    }
  }, [cluster]);

  const runPredictions = useCallback(async () => {
    try {
      await fetch(clusterUrl("/api/intelligence/predictions/run", cluster), { method: "POST" });
      refetchPred();
      showToast("Predictive analysis refreshed", "ok");
    } catch (err) {
      showToast("Prediction refresh failed: " + err.message, "err");
    }
  }, [cluster, refetchPred]);

  return (
    <div className="rp">
      {/* Header */}
      <div className="rp-header">
        <div className="rp-title-row">
          <h3>AI Risk Predictions</h3>
          <div className="rp-accuracy">
            <div className="rp-accuracy-ring">
              <svg viewBox="0 0 36 36" width="32" height="32">
                <circle cx="18" cy="18" r="15" fill="none" stroke="var(--border)" strokeWidth="3" />
                <circle cx="18" cy="18" r="15" fill="none" stroke={avgConf >= 80 ? "#22c55e" : avgConf >= 60 ? "#f59e0b" : "#ef4444"} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${avgConf * 0.942} 94.2`} style={{ transform: "rotate(-90deg)", transformOrigin: "center" }} />
              </svg>
              <span className="rp-accuracy-val">{avgConf}%</span>
            </div>
            <span className="rp-accuracy-label">Accuracy</span>
          </div>
        </div>
        <div className="rp-actions">
          <button className="rp-btn rp-btn-pred" onClick={runPredictions} title="Run predictive trend analysis">
            Predict Trends
          </button>
          <button className="rp-btn rp-btn-llm" onClick={runLLMAnalysis} disabled={llmRunning} title="Run AI deep pattern analysis">
            {llmRunning ? "Analyzing…" : "AI Deep Analysis"}
          </button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="rp-stats">
        <div className="rp-stat">
          <div className="rp-stat-val">{allRisks.length}</div>
          <div className="rp-stat-label">Total Findings</div>
        </div>
        <div className="rp-stat rp-stat-crit">
          <div className="rp-stat-val" style={{ color: "var(--crit)" }}>{counts.critical}</div>
          <div className="rp-stat-label">Critical</div>
        </div>
        <div className="rp-stat rp-stat-warn">
          <div className="rp-stat-val" style={{ color: "var(--warn)" }}>{counts.warning}</div>
          <div className="rp-stat-label">Warning</div>
        </div>
        <div className="rp-stat">
          <div className="rp-stat-val" style={{ color: "#3b82f6" }}>{counts.info}</div>
          <div className="rp-stat-label">Info</div>
        </div>
        <div className="rp-stat">
          <div className="rp-stat-val">{predictions.length}</div>
          <div className="rp-stat-label">Predicted</div>
        </div>
        <div className="rp-stat">
          <div className="rp-stat-val">{llmMapped.length}</div>
          <div className="rp-stat-label">AI Findings</div>
        </div>
      </div>

      {/* Filters */}
      <div className="rp-filters">
        <div className="rp-filter-group">
          {["all", "critical", "warning", "info"].map((f) => (
            <button key={f} className={"rp-filter-pill" + (filter === f ? " active" : "")} onClick={() => setFilter(f)} style={f !== "all" ? { "--pill-color": SEV[f]?.color } : {}}>
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              {f !== "all" && <span className="rp-pill-count">{counts[f]}</span>}
            </button>
          ))}
        </div>
        <div className="rp-filter-group">
          {["all", "cluster", "node", "pod"].map((s) => (
            <button key={s} className={"rp-scope-pill" + (scopeFilter === s ? " active" : "")} onClick={() => setScopeFilter(s)}>
              {s === "all" ? "All Scopes" : s.charAt(0).toUpperCase() + s.slice(1) + " Level"}
            </button>
          ))}
        </div>
      </div>

      {/* Risk List */}
      <div className="rp-list">
        {isLoading && <div className="rp-empty">Analyzing cluster state…</div>}
        {!isLoading && filtered.length === 0 && (
          <div className="rp-empty">
            <div className="rp-empty-icon">{"\u{2705}"}</div>
            <div>No elevated risks detected</div>
            <div className="rp-empty-hint">All systems operating within normal parameters</div>
          </div>
        )}
        {!isLoading && filtered.map((r) => (
          <RiskCard
            key={r.id}
            risk={r}
            expanded={expandedRisk === r.id}
            onToggle={() => setExpandedRisk(expandedRisk === r.id ? null : r.id)}
          />
        ))}
      </div>
    </div>
  );
}

function RiskCard({ risk, expanded, onToggle }) {
  const r = risk;
  const si = sevInfo(r.severity);
  return (
    <div className={"rp-card" + (expanded ? " expanded" : "")} style={{ "--risk-color": si.color }}>
      <div className="rp-card-header" onClick={onToggle}>
        <div className="rp-card-left">
          <span className="rp-card-icon">{catIcon(r.category)}</span>
          <div className="rp-card-info">
            <div className="rp-card-title">{r.title}</div>
            <div className="rp-card-meta">
              <span className="rp-sev-badge" style={{ background: si.bg, color: si.color }}>{r.severity}</span>
              <span className="rp-scope-badge">{r.scope}</span>
              {r.predicted && <span className="rp-pred-badge">PREDICTED</span>}
              {r.llm && <span className="rp-llm-badge">AI</span>}
              <span className="rp-card-target">{r.target}</span>
            </div>
          </div>
        </div>
        <div className="rp-card-right">
          <div className="rp-card-score">
            <div className="rp-score-bar">
              <div className="rp-score-fill" style={{ width: `${r.score}%`, background: si.color }} />
            </div>
            <span className="rp-score-num">{r.score}</span>
          </div>
          <div className="rp-card-conf">{r.confidence}% conf</div>
          <span className="rp-card-chevron">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>
      {expanded && (
        <div className="rp-card-detail">
          {r.evidence && (
            <div className="rp-detail-section">
              <div className="rp-detail-label">Evidence</div>
              <div className="rp-detail-text">{r.evidence}</div>
            </div>
          )}
          {r.impact && (
            <div className="rp-detail-section">
              <div className="rp-detail-label">Impact</div>
              <div className="rp-detail-text">{r.impact}</div>
            </div>
          )}
          {r.action && (
            <div className="rp-detail-section">
              <div className="rp-detail-label">Recommended Action</div>
              <div className="rp-detail-text rp-detail-action">{r.action}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
