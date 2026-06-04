import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../../api/client";
import { useClusterStore } from "../../store/clusterStore";
import { getPlatformInfo } from "../../lib/platforms";

export function MulticlusterWidget() {
  const setActiveCluster = useClusterStore((s) => s.setActiveCluster);
  const activeCluster = useClusterStore((s) => s.activeCluster);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const live = agents.filter((a) => a.status === "live").length;

  return (
    <div className="widget-card span-all">
      <div className="widget-header">
        <div className="widget-title">Multicluster — Fleet ({1 + agents.length} connected · {1 + live} live)</div>
      </div>
      <div className="widget-body">
        {isLoading && <div className="metric muted">Loading fleet…</div>}
        {isError && <div className="metric err">{String(error.message)}</div>}
        {!isLoading && !isError && (
          <div className="fleet-grid">
            {/* Hub cluster card */}
            <FleetClusterCard
              name="Hub Cluster"
              platform="openshift"
              isHub
              isActive={activeCluster === "local"}
              status="live"
              meta="local"
              onClick={() => setActiveCluster("local")}
            />
            {/* Remote cluster cards */}
            {agents.map((a) => {
              const name = a.clusterName || a.name || "unknown";
              return (
                <FleetClusterCard
                  key={name}
                  name={name}
                  platform={a.platform}
                  isActive={activeCluster === name}
                  status={a.status}
                  meta={a.summary ? `${a.summary.nodes} nodes · ${a.summary.pods} pods` : a.status}
                  version={a.summary?.version}
                  onClick={() => setActiveCluster(name)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FleetClusterCard({ name, platform, isHub, isActive, status, meta, version, onClick }) {
  const pInfo = getPlatformInfo(platform);
  const isLive = status === "live" || status === "active" || status === "connected";

  return (
    <button className={"fleet-card" + (isActive ? " active" : "")} onClick={onClick}>
      <div className="fleet-name">
        <span className="fleet-platform-icon" style={{ color: pInfo.color }}>{pInfo.icon}</span>
        {name}
        {isHub && <span className="fleet-badge">PRIMARY</span>}
        {!isHub && <span className="fleet-dot" style={{ background: isLive ? "#22c55e" : "#f59e0b" }} />}
      </div>
      <div className="fleet-meta">
        {pInfo.name}{version ? ` · v${version}` : ""} · {meta}
      </div>
    </button>
  );
}
