import { useClusterQuery } from "../hooks/useClusterQuery";
import { useActiveCluster } from "../store/clusterStore";

/**
 * AI Intelligence view — proactive insights, predictions, knowledge base, and
 * automation rules for the ACTIVE cluster. Cluster-scoped via useClusterQuery.
 */
export function IntelligenceView() {
  const cluster = useActiveCluster();
  const { data, isLoading, isError, error } = useClusterQuery("/api/intelligence/dashboard", { refetchInterval: 30_000 });

  const insights = data?.insights || [];
  const predictions = data?.predictions || [];
  const kb = data?.knowledgeBase || {};
  const rules = data?.automationRules ?? 0;
  const proactive = data?.proactive || {};

  const sevColor = (s) =>
    /crit/i.test(s) ? "#ef4444" : /warn|high/i.test(s) ? "#f59e0b" : /info|low/i.test(s) ? "#3b82f6" : "#8b5cf6";

  return (
    <div className="view-pane">
      <div className="view-head">
        <h2>AI Intelligence</h2>
        <span className="scope-chip">Scope: {cluster === "local" ? "Hub (local)" : cluster}</span>
      </div>

      {isLoading && <div className="metric muted">Loading intelligence…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}

      {!isLoading && !isError && (
        <>
          <div className="stat-row">
            <Stat label="Active insights" value={insights.length} color="#8b5cf6" />
            <Stat label="Predictions" value={predictions.length} color="#f59e0b" />
            <Stat label="KB entries" value={kb.total ?? kb.count ?? 0} color="#06b6d4" />
            <Stat label="Automation rules" value={rules} color="#22c55e" />
            <Stat label="Monitoring" value={data?.monitoring ? "ON" : "OFF"} color={data?.monitoring ? "#22c55e" : "#888"} />
          </div>

          <h3 className="section-title">Proactive Insights</h3>
          <div className="risk-list">
            {insights.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No active insights for this cluster</div>}
            {insights.map((ins, i) => (
              <div className="risk-row" key={i}>
                <span className="risk-score" style={{ background: sevColor(ins.severity) }}>{(ins.severity || "info").slice(0, 4)}</span>
                <span className="risk-target">{ins.title || ins.type || "Insight"}</span>
                <span className="risk-reason">{ins.message || ins.description || ins.summary || ""}</span>
              </div>
            ))}
          </div>

          <h3 className="section-title">Predictive Analysis</h3>
          <div className="risk-list">
            {predictions.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No predictions for this cluster</div>}
            {predictions.slice(0, 10).map((p, i) => (
              <div className="risk-row" key={i}>
                <span className="risk-score" style={{ background: sevColor(p.severity || p.risk) }}>
                  {p.score != null ? p.score : (p.risk || "?")}
                </span>
                <span className="risk-target">{p.target || p.resource || p.title || "prediction"}</span>
                <span className="risk-reason">{p.reason || p.message || p.prediction || ""}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="stat-box">
      <div className="stat-value" style={{ color }}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
