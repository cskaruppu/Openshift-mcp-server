import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { useClusterStore } from "../store/clusterStore";
import { getPlatformInfo } from "../lib/platforms";

export function ClusterSwitcher() {
  const activeCluster = useClusterStore((s) => s.activeCluster);
  const setActiveCluster = useClusterStore((s) => s.setActiveCluster);

  const { data } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const agentsList = Array.isArray(data?.agents) ? data.agents : [];
  const clusters = [
    { key: "local", label: "Hub Cluster (Primary)", platform: "openshift" },
    ...agentsList.map((a) => ({
      key: a.clusterName || a.name,
      label: a.clusterName || a.name,
      platform: a.platform || "k8s",
    })),
  ];

  const activeDef = clusters.find((c) => c.key === activeCluster) || clusters[0];
  const pInfo = getPlatformInfo(activeDef?.platform);

  return (
    <div className="cluster-switcher">
      <label htmlFor="cluster-select">Cluster:</label>
      <select id="cluster-select" value={activeCluster} onChange={(e) => setActiveCluster(e.target.value)}>
        {clusters.map((c) => {
          const p = getPlatformInfo(c.platform);
          return (
            <option key={c.key} value={c.key}>
              {p.icon} {c.label}
            </option>
          );
        })}
      </select>
      <span className="cluster-badge" style={{ background: pInfo.color }}>
        {activeCluster === "local" ? "HUB" : "REMOTE"}
      </span>
    </div>
  );
}
