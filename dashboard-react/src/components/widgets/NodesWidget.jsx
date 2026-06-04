import { useClusterQuery } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

/**
 * Nodes widget. Reads /api/cluster/summary (nodes block) for the active cluster.
 */
export function NodesWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/cluster/summary");

  const nodes = data?.nodes;
  const ready = nodes?.ready ?? 0;
  const total = nodes?.total ?? 0;
  const allReady = total > 0 && ready === total;

  return (
    <WidgetCard title="Nodes">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        <>
          <div className={`metric ${allReady ? "ok" : "warn"}`}>
            {total ? `${ready} / ${total}` : "--"}
          </div>
          <div className="metric-label">
            {nodes ? `Ready · ${nodes.totalCPU || 0} CPU · ${nodes.totalMemGi || 0} Gi Memory` : ""}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
