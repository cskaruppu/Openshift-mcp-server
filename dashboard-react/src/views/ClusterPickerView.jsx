import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { useAuthStore } from "../store/authStore";
import { useThemeStore } from "../store/themeStore";
import { showToast } from "../store/toastStore";

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

function statusDisplay(status) {
  if (status === "live" || status === "active" || status === "connected") return { label: "Active", color: "var(--ok)", pulse: true };
  if (status === "waiting" || status === "registered") return { label: "Awaiting Data", color: "var(--accent2)", pulse: true };
  if (status === "stale") return { label: "Stale", color: "var(--warn)", pulse: false };
  if (status === "unreachable" || status === "error") return { label: "Unreachable", color: "var(--crit)", pulse: false };
  if (status === "auth-error") return { label: "Auth Error", color: "var(--crit)", pulse: false };
  if (status === "pending") return { label: "Agent Not Installed", color: "var(--warn)", pulse: false };
  return { label: status || "Connecting", color: "var(--text2)", pulse: false };
}

function KebabMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="kebab-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="kebab-btn" onClick={() => setOpen(!open)} title="Cluster actions">&#x22EE;</button>
      {open && (
        <div className="kebab-dropdown open">
          {items.map((item, i) =>
            item.sep ? <div key={i} className="kebab-sep" /> : (
              <button key={i} className={"kebab-item" + (item.danger ? " danger" : "")} onClick={() => { setOpen(false); item.action(); }}>
                <span>{item.icon}</span> {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

async function clusterAction(url, method, successMsg) {
  try {
    const res = await fetch(url, { method: method || "POST" });
    const data = await res.json().catch(() => ({}));
    showToast(data.message || successMsg, res.ok ? "ok" : "err");
  } catch (err) {
    showToast("Error: " + err.message, "err");
  }
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

  const { data: hubData } = useQuery({
    queryKey: ["/api/cluster/summary", "local"],
    queryFn: ({ signal }) => apiGet("/api/cluster/summary", { signal }),
    staleTime: 15_000,
  });

  const remoteAgents = Array.isArray(agentData?.agents) ? agentData.agents : [];

  const lci = hubData || {};
  const isOCP = lci.isOpenShift !== undefined ? lci.isOpenShift : true;
  const hubPlatform = lci.platform || "openshift";
  const hubPInfo = getPlatformInfo(hubPlatform);
  const hubVersion = isOCP ? (lci.cluster?.version || "--") : (lci.cluster?.kubernetesVersion || lci.cluster?.version || "--");
  const hubNodes = lci.nodes ? `${lci.nodes.ready || 0}/${lci.nodes.total || 0}` : "--";
  const hubPods = lci.pods?.total ?? lci.pods?.running ?? "--";

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
              <KebabMenu items={[
                { icon: "📊", label: "Open Dashboard", action: () => onSelectCluster("local") },
                { icon: "🔍", label: "Verify Health", action: () => { clusterAction("/api/cluster/health-check", "POST", "Hub health check started"); } },
                { sep: true },
                { icon: "🔒", label: "Sync RBAC", action: () => { clusterAction("/api/cluster/rbac-sync", "POST", "RBAC sync initiated"); } },
              ]} />
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
          {remoteAgents.map((agent) => {
            const clusterName = agent.clusterName || agent.name || "unknown";
            const pInfo = getPlatformInfo(agent.platform);
            const st = statusDisplay(agent.status);
            const summary = agent.summary || {};

            return (
              <div className="cp-card" key={clusterName} onClick={() => onSelectCluster(clusterName)}>
                <div className="cp-card-header">
                  <div className="cp-card-icon" style={{ background: pInfo.color + "15", color: pInfo.color }}>
                    {pInfo.icon}
                  </div>
                  <div className="cp-card-info">
                    <div className="cp-card-name">{clusterName}</div>
                    <div className="cp-card-platform">{pInfo.name}</div>
                  </div>
                  <KebabMenu items={[
                    { icon: "📊", label: "Status Check", action: () => { clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/status`, "GET", "Status check complete"); } },
                    { icon: "🔍", label: "Verify Health", action: () => { clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/health-check`, "POST", "Health check started"); } },
                    { icon: "✏️", label: "Edit Cluster", action: () => { onOpenSettings(); } },
                    { icon: "↻", label: "Reconnect", action: () => { clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/reconnect`, "POST", "Reconnect initiated"); } },
                    { sep: true },
                    { icon: "🔒", label: "Sync RBAC", action: () => { clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/rbac-sync`, "POST", "RBAC sync initiated"); } },
                    { icon: "🔄", label: "Redeploy Agent", action: () => { if (confirm(`Redeploy agent on ${clusterName}?`)) clusterAction(`/api/agent/${encodeURIComponent(clusterName)}/redeploy`, "POST", "Redeploy initiated"); } },
                    { sep: true },
                    { icon: "🗑️", label: "Remove Cluster", danger: true, action: () => { if (confirm(`Remove cluster "${clusterName}"? This cannot be undone.`)) clusterAction(`/api/agent/${encodeURIComponent(clusterName)}`, "DELETE", `Cluster ${clusterName} removed`); } },
                  ]} />
                </div>
                <div className="cp-card-status">
                  <span className="cp-card-status-dot" style={{
                    background: st.color,
                    animation: st.pulse ? "pulse 2s infinite" : "none"
                  }} />
                  <span className="cp-card-status-label" style={{ color: st.color }}>{st.label}</span>
                </div>
                <div className="cp-card-stats">
                  <div className="cp-card-stat">
                    <div className="cp-card-stat-val">{summary.version || agent.version || "--"}</div>
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
