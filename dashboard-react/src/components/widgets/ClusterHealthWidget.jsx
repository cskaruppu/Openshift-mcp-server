import { useClusterQuery } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

/**
 * Cluster Health widget. Reads /api/cluster/summary scoped to the active
 * cluster. No manual guards — useClusterQuery handles isolation.
 */
export function ClusterHealthWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/cluster/summary");

  const health = data?.cluster?.health;
  const version = data?.cluster?.version;
  const isOCP = data?.isOpenShift;
  const channel = data?.cluster?.channel;

  const healthColor =
    health === "healthy" ? "#22c55e" : health === "degraded" || health === "warning" ? "#f59e0b" : health ? "#ef4444" : "#888";

  return (
    <WidgetCard title="Cluster Health">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        <>
          <div className="metric" style={{ color: healthColor }}>
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
