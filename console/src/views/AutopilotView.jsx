import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { useActiveCluster } from "../store/clusterStore";
import { SopRunner } from "../components/SopRunner";

/**
 * Autopilot — the fleet-level automation surface. Runbooks/SOPs are read here
 * (cluster-agnostic), then targeted at a chosen cluster. Lives at the Fleet
 * altitude, not inside a single cluster's tab set, because the SOP is compiled
 * before the target is chosen and it can drive any cluster in the fleet.
 */
export function AutopilotView() {
  const activeCluster = useActiveCluster();
  const [target, setTarget] = useState(activeCluster || "local");

  const { data: agentData } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 15_000,
  });

  const clusters = useMemo(() => {
    const list = new Set(["local"]);
    for (const a of (agentData?.agents || [])) {
      const name = a.clusterName || a.cluster || a.name;
      if (name) list.add(name);
    }
    if (activeCluster) list.add(activeCluster);
    return [...list];
  }, [agentData, activeCluster]);

  return (
    <div className="view-pane autopilot-view">
      {/* Fleet hero */}
      <div className="ap-hero">
        <div className="ap-hero-inner">
          <div className="ap-hero-left">
            <div className="ap-hero-title">
              <span className="ap-hero-icon">🛫</span>
              <h2>Autopilot</h2>
              <span className="ap-hero-badge">FLEET · AUTOMATION</span>
            </div>
            <div className="ap-hero-sub">
              Read a runbook / SOP, let AI compile it into a governed plan, then execute on a target cluster —
              with dry-run, approval, ServiceNow Change Request, and rollback.
            </div>
          </div>
          <div className="ap-hero-target">
            <label className="ap-target-label">Target cluster</label>
            <select className="ap-target-select" value={target} onChange={(e) => setTarget(e.target.value)}>
              {clusters.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <div className="ap-target-hint">Runbook executes on <strong>{target}</strong></div>
          </div>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="ap-breadcrumb">Fleet <span className="ap-crumb-sep">›</span> Autopilot <span className="ap-crumb-sep">›</span> Runbooks</div>

      {/* The SOP workbench, targeted at the chosen cluster */}
      <SopRunner cluster={target} />
    </div>
  );
}
