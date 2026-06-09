import { useClusterQuery, REFRESH } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

/** Pods at Risk — pods with issues for the active cluster. */
export function PodsAtRiskWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/pods/issues", { refetchInterval: REFRESH.VITALS });

  const pods = Array.isArray(data) ? data : [];
  const failed = pods.filter((p) => p.phase === "Failed" || p.phase === "CrashLoopBackOff").length;

  return (
    <WidgetCard title="Pods at Risk" linkTo="intelligence" linkLabel="View in AI Intelligence">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        <>
          <div className={`metric ${pods.length ? "warn" : "ok"}`}>
            {pods.length}
          </div>
          <div className="metric-label">
            {pods.length ? `${failed} failing · ${pods.slice(0, 2).map((p) => p.namespace + "/" + p.name).join(", ")}` : "No pods at risk"}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
