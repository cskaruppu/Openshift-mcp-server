import { useClusterQuery } from "../../hooks/useClusterQuery";

/**
 * Node Topology — renders a card per node for the active cluster, with role,
 * ready state, and capacity. Full-width widget.
 */
export function NodeTopologyWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/nodes");
  const nodes = Array.isArray(data) ? data : [];

  return (
    <div className="widget-card span-all">
      <div className="widget-title">Node Topology</div>
      <div className="widget-body">
        {isLoading && <div className="metric muted">Loading nodes…</div>}
        {isError && <div className="metric err">{String(error.message)}</div>}
        {!isLoading && !isError && nodes.length === 0 && (
          <div className="metric muted" style={{ fontSize: 14 }}>No nodes reported</div>
        )}
        {!isLoading && !isError && nodes.length > 0 && (
          <div className="node-grid">
            {nodes.map((n) => {
              const roles = (Array.isArray(n.roles) ? n.roles : []).join(", ") || "worker";
              const pressure = n.memoryPressure || n.diskPressure || n.pidPressure;
              const dot = !n.ready ? "#ef4444" : pressure ? "#f59e0b" : "#22c55e";
              return (
                <div className="node-card" key={n.name}>
                  <div className="node-head">
                    <span className="node-dot" style={{ background: dot }} />
                    <span className="node-name">{n.name}</span>
                  </div>
                  <div className="node-meta">{roles}</div>
                  <div className="node-meta">
                    {n.cpu} CPU · {n.memory}
                    {n.kubeletVersion ? ` · ${n.kubeletVersion}` : ""}
                  </div>
                  <div className="node-meta">{n.ready ? "Ready" : "NotReady"}{pressure ? " · pressure" : ""}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
