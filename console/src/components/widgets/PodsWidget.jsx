import { useClusterQuery } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";
import { formatNumber } from "../../utils/format";

export function PodsWidget() {
  const { data, isLoading, isError } = useClusterQuery("/api/cluster/summary");

  const pods = data?.pods;
  const running = pods?.running ?? 0;
  const total = pods?.total ?? 0;
  const notRunning = total - running;
  const allHealthy = total > 0 && running === total;

  return (
    <WidgetCard title="Pods">
      {isLoading && <div className="metric-skeleton" />}
      {isError && <div className="metric-error"><span className="metric-error-msg">Couldn’t load data</span></div>}
      {!isLoading && !isError && (
        <>
          <div className={`metric ${allHealthy ? "ok" : notRunning > 0 ? "warn" : "muted"}`}>
            {total ? formatNumber(running) : "--"}
          </div>
          <div className="metric-label">
            {pods ? `Running of ${formatNumber(total)} total${notRunning > 0 ? ` · ${formatNumber(notRunning)} pending/failed` : ""}` : ""}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
