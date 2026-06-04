import { useClusterQuery } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

/** Cluster Operators — OpenShift operators health for the active cluster. */
export function ClusterOperatorsWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/cluster/operators");

  const ops = Array.isArray(data) ? data : [];
  const total = ops.length;
  const degraded = ops.filter((o) => o.health === "degraded");
  const available = ops.filter((o) => o.health === "available").length;

  return (
    <WidgetCard title="Cluster Operators">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        <>
          <div className={`metric ${degraded.length ? "warn" : "ok"}`}>
            {total ? `${available} / ${total}` : "--"}
          </div>
          <div className="metric-label">
            {total ? (degraded.length ? `${degraded.length} degraded: ${degraded.slice(0, 3).map((o) => o.name).join(", ")}` : "All operators healthy") : "Not an OpenShift cluster"}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
