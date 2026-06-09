import { useClusterQuery, REFRESH } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

/**
 * Cluster Health widget. Reads /api/cluster/summary scoped to the active
 * cluster. No manual guards — useClusterQuery handles isolation.
 */
export function ClusterHealthWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/cluster/summary", { refetchInterval: REFRESH.VITALS });

  const health = data?.cluster?.health;
  const version = data?.cluster?.version;
  const isOCP = data?.isOpenShift;
  const channel = data?.cluster?.channel;

  const healthClass = health === "healthy" ? "ok" : health === "degraded" || health === "warning" ? "warn" : health ? "crit" : "muted";

  return (
    <WidgetCard title="Cluster Health">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        <>
          <div className={`metric ${healthClass}`}>
            {health ? health.charAt(0).toUpperCase() + health.slice(1) : "--"}
          </div>
          <div className="metric-label">
            {version ? `${isOCP ? "OpenShift" : "Kubernetes"} ${version}${channel ? " · " + channel : ""}` : ""}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
