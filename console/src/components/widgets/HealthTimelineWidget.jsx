import { useEffect } from "react";
import { useClusterQuery } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";
import { useHealthHistoryStore } from "../../store/healthHistoryStore";

const STATUS = {
  healthy:  { color: "#22c55e", bg: "rgba(34,197,94,0.12)",  label: "Healthy",  icon: "✓" },
  degraded: { color: "#f59e0b", bg: "rgba(245,158,11,0.12)", label: "Degraded", icon: "!" },
  warning:  { color: "#f59e0b", bg: "rgba(245,158,11,0.12)", label: "Warning",  icon: "!" },
  critical: { color: "#ef4444", bg: "rgba(239,68,68,0.12)",  label: "Critical", icon: "✕" },
};
const info = (h) => STATUS[h] || { color: "#555", bg: "rgba(80,80,80,0.12)", label: h || "--", icon: "?" };

export function HealthTimelineWidget() {
  const cluster = useActiveCluster();
  const { data } = useClusterQuery("/api/cluster/summary");
  const record = useHealthHistoryStore((s) => s.record);
  const history = useHealthHistoryStore((s) => s.byCluster[cluster]) || [];

  const health = data?.cluster?.health;
  const version = data?.cluster?.version;
  const si = info(health);

  useEffect(() => {
    if (health) record(cluster, health);
  }, [health, cluster, data?.lastReportTime]);

  const upCount = history.filter((p) => p.health === "healthy").length;
  const uptimePct = history.length > 0 ? Math.round((upCount / history.length) * 100) : 100;

  return (
    <div className="widget-card span-all ht-widget">
      <div className="ht-header">
        <div className="ht-title-row">
          <div className="widget-title" style={{ margin: 0 }}>Health Timeline</div>
          <div className="ht-meta">{history.length} checks · {uptimePct}% uptime</div>
        </div>
        <div className="ht-status-pill" style={{ background: si.bg, color: si.color, borderColor: si.color }}>
          <span className="ht-status-icon">{si.icon}</span>
          <span>{si.label}</span>
          {version && <span className="ht-version">v{version}</span>}
        </div>
      </div>

      <div className="ht-body">
        {history.length === 0 ? (
          <div className="metric muted" style={{ fontSize: 13 }}>Collecting health snapshots…</div>
        ) : (
          <>
            <div className="ht-track">
              {history.map((p, i) => {
                const s = info(p.health);
                const isLatest = i === history.length - 1;
                const ts = new Date(p.t);
                return (
                  <div
                    key={i}
                    className={"ht-segment" + (isLatest ? " ht-latest" : "")}
                    style={{ "--seg-color": s.color }}
                    title={`${ts.toLocaleTimeString()} — ${s.label}`}
                  >
                    <div className="ht-seg-bar" />
                    <div className="ht-seg-dot" />
                  </div>
                );
              })}
            </div>
            <div className="ht-axis">
              <span>{new Date(history[0].t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <span>now</span>
            </div>
          </>
        )}
      </div>

      {history.length > 0 && (
        <div className="ht-legend">
          {Object.entries(STATUS).map(([key, s]) => {
            const count = history.filter((p) => p.health === key).length;
            if (count === 0) return null;
            return (
              <div key={key} className="ht-legend-item">
                <span className="ht-legend-dot" style={{ background: s.color }} />
                <span>{s.label}</span>
                <span className="ht-legend-count">{count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
