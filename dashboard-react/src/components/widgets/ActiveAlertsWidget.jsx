import { useClusterQuery } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

/** Active Alerts — firing alerts + warning events for the active cluster. */
export function ActiveAlertsWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/alerts");

  const alerts = (data?.alerts || []).filter((a) => !a.silenced);
  const summary = data?.summary || {};

  return (
    <WidgetCard title="Active Alerts">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        <>
          <div className="metric" style={{ color: alerts.length ? "#f59e0b" : "#22c55e" }}>
            {alerts.length}
          </div>
          <div className="metric-label">
            {summary.critical || 0} critical · {summary.warning || 0} warning · {summary.info || 0} info
          </div>
        </>
      )}
    </WidgetCard>
  );
}
