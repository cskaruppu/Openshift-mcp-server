import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../../api/client";
import { useClusterStore } from "../../store/clusterStore";

/**
 * Multicluster (Fleet) widget. This is intentionally FLEET-WIDE, not
 * cluster-scoped — it lists every connected cluster and lets you jump to one.
 * It therefore uses a plain useQuery (no cluster key). Switching the active
 * cluster from here updates the store; all other widgets re-scope automatically.
 */
export function MulticlusterWidget() {
  const setActiveCluster = useClusterStore((s) => s.setActiveCluster);
  const activeCluster = useClusterStore((s) => s.activeCluster);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const agents = data?.agents || [];
  const live = agents.filter((a) => a.status === "live").length;

  return (
    <div className="widget-card span-all">
      <div className="widget-title">Multicluster — Fleet ({agents.length} connected · {live} live)</div>
      <div className="widget-body">
        {isLoading && <div className="metric muted">Loading fleet…</div>}
        {isError && <div className="metric err">{String(error.message)}</div>}
        {!isLoading && !isError && (
          <div className="fleet-grid">
            <button
              className={"fleet-card" + (activeCluster === "local" ? " active" : "")}
              onClick={() => setActiveCluster("local")}
            >
              <div className="fleet-name">Hub Cluster <span className="fleet-badge">PRIMARY</span></div>
              <div className="fleet-meta">OpenShift · local</div>
            </button>
            {agents.map((a) => (
              <button
                key={a.clusterName}
                className={"fleet-card" + (activeCluster === a.clusterName ? " active" : "")}
                onClick={() => setActiveCluster(a.clusterName)}
              >
                <div className="fleet-name">
                  {a.clusterName}
                  <span className="fleet-dot" style={{ background: a.status === "live" ? "#22c55e" : "#f59e0b" }} />
                </div>
                <div className="fleet-meta">
                  {(a.platform || "kubernetes")} · {a.summary ? `${a.summary.nodes} nodes · ${a.summary.pods} pods` : a.status}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
