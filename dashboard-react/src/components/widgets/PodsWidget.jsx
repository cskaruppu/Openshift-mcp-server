import { useClusterQuery } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

export function PodsWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/cluster/summary");

  const pods = data?.pods;
  const running = pods?.running ?? 0;
  const total = pods?.total ?? 0;
  const notRunning = total - running;
  const allHealthy = total > 0 && running === total;

  return (
    <WidgetCard title="Pods">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        <>
          <div className={`metric ${allHealthy ? "ok" : notRunning > 0 ? "warn" : "muted"}`}>
            {total ? running : "--"}
          </div>
          <div className="metric-label">
            {pods ? `Running of ${total} total${notRunning > 0 ? ` · ${notRunning} pending/failed` : ""}` : ""}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
