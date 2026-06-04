import { useClusterQuery } from "../../hooks/useClusterQuery";

/**
 * AI Risk Predictions — derives a risk list from pod issues for the active
 * cluster (restart storms, crash loops, failures). Mirrors the legacy
 * loadRiskPredictions logic at a high level. Full-width widget.
 */
function scoreFromPod(p) {
  let score = 0;
  const issue = (p.issues && p.issues[0]) || {};
  const restarts = issue.restarts || 0;
  const phase = p.phase || "";
  if (phase === "Failed") score += 50;
  if (/CrashLoop/i.test(phase) || /CrashLoop/i.test(issue.reason || "")) score += 60;
  if (/ImagePull|ErrImage/i.test(issue.reason || "")) score += 40;
  score += Math.min(40, restarts * 5);
  return Math.min(100, score);
}

export function RiskPredictionsWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/pods/issues");
  const pods = Array.isArray(data) ? data : [];

  const risks = pods
    .map((p) => ({
      target: `${p.namespace}/${p.name}`,
      reason: (p.issues && p.issues[0]?.reason) || p.phase || "issue",
      score: scoreFromPod(p),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const sev = (s) => (s >= 70 ? "#ef4444" : s >= 40 ? "#f59e0b" : "#3b82f6");

  return (
    <div className="widget-card span-all">
      <div className="widget-title">AI Risk Predictions (Evidence-Based)</div>
      <div className="widget-body">
        {isLoading && <div className="metric muted">Analyzing…</div>}
        {isError && <div className="metric err">{String(error.message)}</div>}
        {!isLoading && !isError && risks.length === 0 && (
          <div className="metric muted" style={{ fontSize: 14 }}>No elevated risks detected</div>
        )}
        {!isLoading && !isError && risks.length > 0 && (
          <div className="risk-list">
            {risks.map((r) => (
              <div className="risk-row" key={r.target}>
                <span className="risk-score" style={{ background: sev(r.score) }}>{r.score}</span>
                <span className="risk-target">{r.target}</span>
                <span className="risk-reason">{r.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
