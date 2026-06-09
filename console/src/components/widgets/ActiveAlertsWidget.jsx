import { useClusterQuery, REFRESH } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

export function ActiveAlertsWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/alerts", { refetchInterval: REFRESH.VITALS });

  const alerts = (data?.alerts || []).filter((a) => !a.silenced);
  const summary = data?.summary || {};

  return (
    <WidgetCard title="Active Alerts" linkTo="intelligence" linkLabel="View in AI Intelligence">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        <>
          <div className={`metric ${alerts.length ? "warn" : "ok"}`}>
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
