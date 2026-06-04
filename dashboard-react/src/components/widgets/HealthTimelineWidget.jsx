import { useEffect } from "react";
import { useClusterQuery } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";
import { useHealthHistoryStore } from "../../store/healthHistoryStore";

const color = (h) => (h === "healthy" ? "#22c55e" : h === "degraded" || h === "warning" ? "#f59e0b" : h ? "#ef4444" : "#444");

/**
 * Health Timeline — records the active cluster's health on each poll and renders
 * the last N snapshots as a sparkline-style bar strip. Per-cluster history.
 */
export function HealthTimelineWidget() {
  const cluster = useActiveCluster();
  const { data } = useClusterQuery("/api/cluster/summary");
  const record = useHealthHistoryStore((s) => s.record);
  const history = useHealthHistoryStore((s) => s.byCluster[cluster]) || [];

  const health = data?.cluster?.health;
  useEffect(() => {
    if (health) record(cluster, health);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health, cluster, data?.lastReportTime]);

  return (
    <div className="widget-card span-all">
      <div className="widget-title">Health Timeline (last {history.length} checks)</div>
      <div className="widget-body">
        {history.length === 0 ? (
          <div className="metric muted" style={{ fontSize: 14 }}>Collecting health snapshots…</div>
        ) : (
          <div className="timeline-strip">
            {history.map((p, i) => (
              <span key={i} className="timeline-bar" style={{ background: color(p.health) }} title={`${new Date(p.t).toLocaleTimeString()} — ${p.health}`} />
            ))}
          </div>
        )}
        <div className="metric-label" style={{ marginTop: 8 }}>
          Current: <span style={{ color: color(health) }}>{health || "--"}</span>
        </div>
      </div>
    </div>
  );
}
