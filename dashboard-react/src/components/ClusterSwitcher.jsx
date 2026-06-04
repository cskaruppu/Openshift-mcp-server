import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { useClusterStore } from "../store/clusterStore";

/**
 * Cluster switcher. Lists the hub plus every connected agent and lets the user
 * switch the active cluster. Switching only updates the store — every widget
 * re-queries automatically with the new cluster key.
 */
export function ClusterSwitcher() {
  const activeCluster = useClusterStore((s) => s.activeCluster);
  const setActiveCluster = useClusterStore((s) => s.setActiveCluster);

  // Fleet-wide query (not cluster-scoped): list of connected agents.
  const { data } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const agentsList = Array.isArray(data?.agents) ? data.agents : [];
  const clusters = [{ key: "local", label: "Hub Cluster (Primary)" }, ...agentsList.map((a) => ({ key: a.clusterName || a.name, label: a.clusterName || a.name }))];

  return (
    <div className="cluster-switcher">
      <label htmlFor="cluster-select">Cluster:</label>
      <select id="cluster-select" value={activeCluster} onChange={(e) => setActiveCluster(e.target.value)}>
        {clusters.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      <span className="cluster-badge">{activeCluster === "local" ? "HUB" : "REMOTE"}</span>
    </div>
  );
}
