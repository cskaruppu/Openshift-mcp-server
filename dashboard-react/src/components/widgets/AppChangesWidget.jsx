import { useClusterQuery } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

/**
 * Application Change Watcher. Local-cluster capability — the backend returns
 * { available:false } for remote clusters, which we surface cleanly.
 */
export function AppChangesWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/dashboard/app-changes");

  const unavailable = data && (data.available === false);
  const total = data?.totalChanges ?? 0;
  const critical = data?.critical ?? 0;
  const warning = data?.warning ?? 0;

  return (
    <WidgetCard title="Application Change Watcher">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        unavailable ? (
          <>
            <div className="metric muted">N/A</div>
            <div className="metric-label">{data.message || "Not available for remote clusters"}</div>
          </>
        ) : (
          <>
            <div className={`metric ${critical ? "crit" : warning ? "warn" : "ok"}`}>{total}</div>
            <div className="metric-label">{critical} critical · {warning} warning · {data?.baselines ?? 0} baselines</div>
          </>
        )
      )}
    </WidgetCard>
  );
}
