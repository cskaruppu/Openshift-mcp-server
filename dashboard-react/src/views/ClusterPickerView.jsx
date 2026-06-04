import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { useAuthStore } from "../store/authStore";
import { useThemeStore } from "../store/themeStore";

const PLATFORM_MAP = {
  openshift: { name: "OpenShift", icon: "\u{1F3F0}", color: "#e04040" },
  eks: { name: "Amazon EKS", icon: "\u{1F4E6}", color: "#ff9900" },
  aks: { name: "Azure AKS", icon: "\u{2601}️", color: "#0078d4" },
  gke: { name: "Google GKE", icon: "\u{1F310}", color: "#4285f4" },
  rancher: { name: "Rancher", icon: "\u{1F42E}", color: "#0075a8" },
  k8s: { name: "Kubernetes", icon: "☸", color: "#326ce5" },
};

function getPlatformInfo(platform) {
  return PLATFORM_MAP[(platform || "k8s").toLowerCase()] || PLATFORM_MAP.k8s;
}

export function ClusterPickerView({ onSelectCluster, onLogout, onOpenSettings }) {
  const user = useAuthStore((s) => s.user);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  const { data: agentData } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const { data: healthData } = useQuery({
    queryKey: ["/api/dashboard/health", "local"],
    queryFn: ({ signal }) => apiGet("/api/dashboard/health", { signal }),
    staleTime: 15_000,
  });

  const { data: nodesData } = useQuery({
    queryKey: ["/api/dashboard/nodes", "local"],
    queryFn: ({ signal }) => apiGet("/api/dashboard/nodes", { signal }),
    staleTime: 15_000,
  });

  const remoteAgents = agentData?.agents || {};
  const remoteNames = Object.keys(remoteAgents);

  const hubVersion = healthData?.version || "--";
  const hubNodes = nodesData ? `${nodesData.ready || 0}/${nodesData.total || 0}` : "--";
  const hubPods = healthData?.pods ?? "--";
  const hubPlatform = healthData?.platform || "openshift";
  const hubPInfo = getPlatformInfo(hubPlatform);

  return (
    <div className="cluster-picker">
      {/* Header */}
      <div className="cp-header">
        <div className="cp-brand">
          <svg viewBox="0 0 44 44" fill="none" width="40" height="40">
            <circle cx="22" cy="22" r="20" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" fill="none"/>
            <clipPath id="cpCircle"><circle cx="22" cy="22" r="16"/></clipPath>
            <g clipPath="url(#cpCircle)" opacity="0.85">
              <line x1="6" y1="2" x2="18" y2="42" stroke="#ef4444" strokeWidth="3.2"/>
              <line x1="11" y1="2" x2="23" y2="42" stroke="#f97316" strokeWidth="3.2"/>
              <line x1="16" y1="2" x2="28" y2="42" stroke="#facc15" strokeWidth="3.2"/>
              <line x1="21" y1="2" x2="33" y2="42" stroke="#22c55e" strokeWidth="3.2"/>
              <line x1="26" y1="2" x2="38" y2="42" stroke="#3b82f6" strokeWidth="3.2"/>
              <line x1="31" y1="2" x2="43" y2="42" stroke="#8b5cf6" strokeWidth="3.2"/>
              <line x1="36" y1="2" x2="48" y2="42" stroke="#ec4899" strokeWidth="3.2"/>
            </g>
            <circle cx="22" cy="22" r="16" stroke="rgba(255,255,255,0.25)" strokeWidth="1.8" fill="none"/>
          </svg>
          <div className="cp-brand-text">
            <span className="cp-brand-name">
              <span className="tcs">TCS</span>{" "}
              <span className="agentic">Agentic</span>{" "}
              <span className="ai">AI</span>
            </span>
            <span className="cp-brand-sub">Enterprise Intelligence Platform</span>
          </div>
        </div>
        <div className="cp-user">
          <div className="cp-header-actions">
            <button className="cp-action-btn" onClick={toggleTheme} title="Toggle theme">
              <span dangerouslySetInnerHTML={{ __html: theme === "light" ? "&#x2600;" : "&#x263E;" }} />
            </button>
            <button className="cp-action-btn" onClick={onOpenSettings} title="Settings">&#x2699;</button>
          </div>
          {user && user.name !== "anonymous" && (
            <>
              <span className="cp-user-label">{user.display_name || user.name}</span>
              <button className="cp-logout-btn" onClick={onLogout}>Sign Out</button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="cp-body">
        <div className="cp-title">Select a Cluster</div>
        <div className="cp-subtitle">Choose a Kubernetes cluster to manage. Each workspace is scoped to the selected cluster.</div>

        <div className="cp-grid">
          {/* Hub cluster card */}
          <div className="cp-card" onClick={() => onSelectCluster("local")}>
            <div className="cp-card-header">
              <div className="cp-card-icon" style={{ background: hubPInfo.color + "15", color: hubPInfo.color }}>
                {hubPInfo.icon}
              </div>
              <div className="cp-card-info">
                <div className="cp-card-name">Hub Cluster <span className="cp-card-primary-badge">PRIMARY</span></div>
                <div className="cp-card-platform">{hubPInfo.name}</div>
              </div>
            </div>
            <div className="cp-card-status">
              <span className="cp-card-status-dot" style={{ background: "var(--ok)", animation: "pulse 2s infinite" }} />
              <span className="cp-card-status-label" style={{ color: "var(--ok)" }}>Active</span>
            </div>
            <div className="cp-card-stats">
              <div className="cp-card-stat">
                <div className="cp-card-stat-val">{hubVersion}</div>
                <div className="cp-card-stat-lbl">Version</div>
              </div>
              <div className="cp-card-stat">
                <div className="cp-card-stat-val">{hubNodes}</div>
                <div className="cp-card-stat-lbl">Nodes</div>
              </div>
              <div className="cp-card-stat">
                <div className="cp-card-stat-val">{hubPods}</div>
                <div className="cp-card-stat-lbl">Pods</div>
              </div>
            </div>
          </div>

          {/* Remote cluster cards */}
          {remoteNames.map((name) => {
            const agent = remoteAgents[name];
            const pInfo = getPlatformInfo(agent.platform);
            const isActive = agent.status === "active" || agent.status === "connected";
            const statusColor = isActive ? "var(--ok)"
              : agent.status === "stale" ? "var(--warn)"
              : agent.status === "unreachable" || agent.status === "error" ? "var(--crit)"
              : "var(--text2)";
            const statusLabel = isActive ? "Active"
              : agent.status === "stale" ? "Stale"
              : agent.status || "Connecting";
            const summary = agent.summary || {};

            return (
              <div className="cp-card" key={name} onClick={() => onSelectCluster(name)}>
                <div className="cp-card-header">
                  <div className="cp-card-icon" style={{ background: pInfo.color + "15", color: pInfo.color }}>
                    {pInfo.icon}
                  </div>
                  <div className="cp-card-info">
                    <div className="cp-card-name">{name}</div>
                    <div className="cp-card-platform">{pInfo.name}</div>
                  </div>
                </div>
                <div className="cp-card-status">
                  <span className="cp-card-status-dot" style={{
                    background: statusColor,
                    animation: isActive ? "pulse 2s infinite" : "none"
                  }} />
                  <span className="cp-card-status-label" style={{ color: statusColor }}>{statusLabel}</span>
                </div>
                <div className="cp-card-stats">
                  <div className="cp-card-stat">
                    <div className="cp-card-stat-val">{summary.version || "--"}</div>
                    <div className="cp-card-stat-lbl">Version</div>
                  </div>
                  <div className="cp-card-stat">
                    <div className="cp-card-stat-val">{summary.nodes || "--"}</div>
                    <div className="cp-card-stat-lbl">Nodes</div>
                  </div>
                  <div className="cp-card-stat">
                    <div className="cp-card-stat-val">{summary.pods ?? "--"}</div>
                    <div className="cp-card-stat-lbl">Pods</div>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Add Cluster card */}
          <div className="cp-card-add" onClick={onOpenSettings}>
            <div className="cp-card-add-icon">+</div>
            <div className="cp-card-add-label">Connect a Cluster</div>
            <div className="cp-card-add-platforms">
              {Object.values(PLATFORM_MAP).map((p) => (
                <span key={p.name} className="cp-platform-pill" style={{ color: p.color, borderColor: p.color }}>
                  {p.icon} {p.name}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Fleet AI bar */}
        <FleetAIBar />
      </div>
    </div>
  );
}

function FleetAIBar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);

  const ask = async (q) => {
    const text = q || query;
    if (!text.trim()) return;
    setLoading(true);
    setResponse("");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, scope: "fleet" }),
      });
      const data = await res.json();
      setResponse(data.response || data.message || JSON.stringify(data));
    } catch (err) {
      setResponse("Error: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const QUICK = [
    { label: "Health overview", q: "fleet health overview" },
    { label: "Upgrades", q: "which clusters have upgrades available?" },
    { label: "Problem pods", q: "problem pods across all clusters" },
    { label: "Security posture", q: "security posture across the fleet" },
    { label: "Capacity", q: "fleet inventory and capacity" },
  ];

  return (
    <div className={"cp-fleet-bar" + (open ? " open" : "")}>
      <div className="cp-fleet-bar-inner">
        <div className="cp-fleet-bar-header" onClick={() => setOpen(!open)}>
          <div className="cp-fleet-bar-title">
            <span>{"\u{1F30D}"}</span>
            <span className="cp-fleet-label">Fleet AI</span>
            <span className="cp-fleet-badge">ALL CLUSTERS</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="cp-fleet-bar-hint">Ask across every connected cluster</span>
            <span className="cp-fleet-bar-chevron">{"▼"}</span>
          </div>
        </div>
        {open && (
          <div className="cp-fleet-bar-body" style={{ display: "block" }}>
            <div className="cp-fleet-input-row">
              <input
                type="text"
                className="cp-fleet-input"
                placeholder="e.g. which clusters have upgrades available?"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ask()}
              />
              <button className="cp-fleet-btn" onClick={() => ask()} disabled={loading}>
                {loading ? "Thinking…" : "Ask Fleet"}
              </button>
            </div>
            <div className="cp-fleet-chips">
              {QUICK.map((c) => (
                <button key={c.label} className="fleet-chip" onClick={() => { setQuery(c.q); ask(c.q); }}>
                  {c.label}
                </button>
              ))}
            </div>
            {response && (
              <div className="cp-fleet-response" style={{ display: "block", marginTop: 12, whiteSpace: "pre-wrap" }}>
                {response}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

