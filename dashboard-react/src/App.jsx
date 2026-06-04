import { useEffect, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api/client";
import { ClusterSwitcher } from "./components/ClusterSwitcher";
import { LoginOverlay } from "./components/LoginOverlay";
import { SettingsPanel } from "./components/SettingsPanel";
import { ToastStack } from "./components/ToastStack";
import { KbdOverlay, useKeyboardShortcuts } from "./components/KeyboardShortcuts";
import { ClusterPickerView } from "./views/ClusterPickerView";
import { DashboardView } from "./views/DashboardView";
import { AuditView } from "./views/AuditView";
import { IntelligenceView } from "./views/IntelligenceView";
import { ChatView } from "./views/ChatView";
import { AIHubView } from "./views/AIHubView";
import { useAuthStore } from "./store/authStore";
import { useThemeStore } from "./store/themeStore";
import { showToast } from "./store/toastStore";
import { useClusterStore, useActiveCluster } from "./store/clusterStore";
import { useViewStore } from "./store/viewStore";
import { getPlatformInfo } from "./lib/platforms";

const NAV = [
  { key: "dashboard", label: "Dashboard" },
  { key: "chat", label: "AI Chat" },
  { key: "audit", label: "Audit" },
  { key: "hub", label: "AI Hub" },
  { key: "intelligence", label: "AI Intelligence" },
];

export default function App() {
  const cluster = useActiveCluster();
  const setActiveCluster = useClusterStore((s) => s.setActiveCluster);
  const activeView = useViewStore((s) => s.activeView);
  const setActiveView = useViewStore((s) => s.setActiveView);
  const { checked, authenticated, user } = useAuthStore();
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inClusterPicker, setInClusterPicker] = useState(true);
  const [agentsModalOpen, setAgentsModalOpen] = useState(false);
  const { kbdOpen, setKbdOpen } = useKeyboardShortcuts();

  const { data: agentData } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 10_000,
    refetchInterval: 30_000,
    enabled: authenticated,
  });

  // Hub platform is derived from the live cluster summary — never assumed.
  const { data: hubSummary } = useQuery({
    queryKey: ["/api/cluster/summary", "local"],
    queryFn: ({ signal }) => apiGet("/api/cluster/summary", { signal }),
    staleTime: 60_000,
    enabled: authenticated,
  });

  const agentsList = Array.isArray(agentData?.agents) ? agentData.agents : [];
  const hasRemoteClusters = agentsList.length > 0;

  const isHub = cluster === "local";
  const activeAgent = !isHub ? agentsList.find((a) => (a.clusterName || a.name) === cluster) : null;
  const activePlatform = getPlatformInfo(isHub ? hubSummary?.platform : activeAgent?.platform);

  useEffect(() => {
    document.body.classList.toggle("light-theme", theme === "light");
  }, [theme]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth/status");
        const data = await res.json();
        if (data.authenticated) {
          useAuthStore.getState().setAuth(data.user);
        } else if (data.mode === "none") {
          useAuthStore.getState().setAuth({ name: "anonymous", role: "admin" });
        } else {
          useAuthStore.getState().setUnauthenticated(data.mode);
        }
      } catch {
        useAuthStore.getState().setAuth({ name: "anonymous", role: "admin" });
      }
    })();
  }, []);

  useEffect(() => {
    if (authenticated && agentData) {
      const hasRemote = Array.isArray(agentData.agents) && agentData.agents.length > 0;
      if (!hasRemote) {
        setInClusterPicker(false);
      }
    }
  }, [authenticated, agentData]);

  const handleSelectCluster = useCallback((name) => {
    setActiveCluster(name);
    setInClusterPicker(false);
    setActiveView("dashboard");
  }, [setActiveCluster, setActiveView]);

  const handleBackToPicker = useCallback(() => {
    setInClusterPicker(true);
  }, []);

  const handleLogout = useCallback(async () => {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    useAuthStore.getState().logout();
    useAuthStore.getState().setUnauthenticated("password");
    setInClusterPicker(true);
    showToast("Signed out", "ok");
  }, []);

  if (!checked) {
    return (
      <div className="app-loading-screen">
        <div className="app-loading-logo">TA</div>
        <div className="app-loading-text">TCS Agentic AI</div>
        <div className="app-loading-bar" />
      </div>
    );
  }

  return (
    <>
      <LoginOverlay />
      {authenticated && inClusterPicker && (
        <ClusterPickerView
          onSelectCluster={handleSelectCluster}
          onLogout={handleLogout}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      {authenticated && !inClusterPicker && (
        <div className="app">
          {/* Workspace breadcrumb bar */}
          {hasRemoteClusters && (
            <div className="workspace-breadcrumb">
              <div className="workspace-breadcrumb-left">
                <button className="workspace-breadcrumb-back" onClick={handleBackToPicker}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M8 1L3 6l5 5"/>
                  </svg>
                  All Clusters
                </button>
                <span className="workspace-breadcrumb-sep">/</span>
                <span className="workspace-breadcrumb-cluster">
                  <span className="wbc-dot" style={{ background: activeAgent?.status === "live" || isHub ? "#22c55e" : "#f59e0b" }} />
                  <span className="wbc-platform" style={{ color: activePlatform.color }}>{activePlatform.icon}</span>
                  <span className="wbc-name">{isHub ? "Hub" : cluster}</span>
                  <span className="wbc-badge" style={{ background: isHub ? `linear-gradient(135deg,${activePlatform.color},${activePlatform.color}dd)` : activePlatform.color, color: "#fff" }}>
                    {isHub ? `${activePlatform.name.toUpperCase()} · PRIMARY` : `${activePlatform.name.toUpperCase()} · REMOTE`}
                  </span>
                </span>
              </div>
              <div className="workspace-breadcrumb-right">
                <VersionLabel />
                <ClusterSwitcher />
              </div>
            </div>
          )}

          <header className="app-header">
            <div className="brand">
              <span className="brand-mark">TCS</span> Agentic AI
              <span className="brand-sub">Enterprise Intelligence Platform</span>
            </div>
            <nav className="nav-tabs">
              {NAV.map((t) => (
                <button
                  key={t.key}
                  className={"nav-tab" + (activeView === t.key ? " active" : "")}
                  onClick={() => setActiveView(t.key)}
                >
                  {t.label}
                  {t.key === "intelligence" && (
                    <span className="alerts-badge" style={{ background: "#6366f1", marginLeft: 6 }}>0</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="header-actions">
              {/* Connection status */}
              <div className="conn-status">
                <span className="conn-dot connected" />
                <span className="conn-label">Connected</span>
              </div>

              {!hasRemoteClusters && <ClusterSwitcher />}

              <button className="icon-btn" onClick={() => { showToast("Refreshing...", "ok"); window.location.reload(); }} title="Refresh">
                &#x21bb;
              </button>
              <button
                className="icon-btn"
                onClick={toggleTheme}
                title="Toggle theme"
                dangerouslySetInnerHTML={{ __html: theme === "light" ? "&#x2600;" : "&#x263E;" }}
              />
              <button className="icon-btn" onClick={() => setKbdOpen(true)} title="Keyboard shortcuts (Ctrl+/)">
                &#x2328;
              </button>
              <button className="settings-gear" onClick={() => setSettingsOpen(true)} title="Settings">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              <button
                className={"agents-icon-btn" + (agentsModalOpen ? " active" : "")}
                onClick={() => { setAgentsModalOpen(!agentsModalOpen); setActiveView("hub"); }}
                title="AI Agents"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="7" r="3" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" />
                  <line x1="12" y1="10" x2="5" y2="15.5" /><line x1="12" y1="10" x2="19" y2="15.5" />
                  <line x1="5" y1="15.5" x2="19" y2="15.5" strokeDasharray="2 2" opacity="0.5" />
                </svg>
                {agentsList.length > 0 && <span className="agents-icon-badge">{agentsList.length}</span>}
              </button>
              {user && user.name !== "anonymous" && (
                <>
                  <span className="user-badge">{user.display_name || user.name}</span>
                  <button className="icon-btn logout-btn" onClick={handleLogout} title="Sign out">
                    &#x23FB;
                  </button>
                </>
              )}
            </div>
          </header>

          <main className="main-area">
            {activeView === "dashboard" && <DashboardView />}
            {activeView === "chat" && <ChatView />}
            {activeView === "audit" && <AuditView />}
            {activeView === "hub" && <AIHubView />}
            {activeView === "intelligence" && <IntelligenceView />}
          </main>

          <footer className="app-footer">
            Active cluster: <strong>{cluster === "local" ? "Hub" : cluster}</strong>
            {user && user.name !== "anonymous" && <> — signed in as <strong>{user.name}</strong></>}
          </footer>
        </div>
      )}
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <KbdOverlay open={kbdOpen} onClose={() => setKbdOpen(false)} />
      <ToastStack />
    </>
  );
}

function VersionLabel() {
  const cluster = useActiveCluster();
  const { data: summaryData } = useQuery({
    queryKey: ["/api/cluster/summary", cluster],
    queryFn: ({ signal }) => apiGet("/api/cluster/summary", { signal }),
    staleTime: 60_000,
    enabled: cluster === "local",
  });
  const { data: agentData } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 30_000,
  });

  let ver;
  if (cluster === "local") {
    ver = summaryData?.cluster?.version;
  } else {
    const agents = Array.isArray(agentData?.agents) ? agentData.agents : [];
    const agent = agents.find((a) => (a.clusterName || a.name) === cluster);
    ver = agent?.summary?.version;
  }
  if (!ver) return null;
  return <span className="wbc-version">v{ver}</span>;
}
