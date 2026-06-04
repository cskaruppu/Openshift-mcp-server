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
import { useAuthStore } from "./store/authStore";
import { useThemeStore } from "./store/themeStore";
import { showToast } from "./store/toastStore";
import { useClusterStore, useActiveCluster } from "./store/clusterStore";
import { useViewStore } from "./store/viewStore";

const NAV = [
  { key: "dashboard", label: "Dashboard" },
  { key: "chat", label: "AI Chat" },
  { key: "audit", label: "Audit" },
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
  const { kbdOpen, setKbdOpen } = useKeyboardShortcuts();

  const { data: agentData } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 10_000,
    refetchInterval: 30_000,
    enabled: authenticated,
  });

  const agentsList = Array.isArray(agentData?.agents) ? agentData.agents : [];
  const hasRemoteClusters = agentsList.length > 0;

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
                  <span className="wbc-dot" style={{ background: "#22c55e" }} />
                  <span className="wbc-name">{cluster === "local" ? "Hub Cluster" : cluster}</span>
                  <span className="wbc-badge" style={{ background: cluster === "local" ? "linear-gradient(135deg,#e04040,#c03030)" : "#3b82f6", color: "#fff" }}>
                    {cluster === "local" ? "PRIMARY" : "REMOTE"}
                  </span>
                </span>
              </div>
              <div className="workspace-breadcrumb-right">
                <ClusterSwitcher />
              </div>
            </div>
          )}

          <header className="app-header">
            <div className="brand">
              <span className="brand-mark">TCS</span> Agentic AI
              <span className="brand-sub">Multi-Cluster Dashboard</span>
            </div>
            <nav className="nav-tabs">
              {NAV.map((t) => (
                <button
                  key={t.key}
                  className={"nav-tab" + (activeView === t.key ? " active" : "")}
                  onClick={() => setActiveView(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="header-actions">
              {!hasRemoteClusters && <ClusterSwitcher />}
              <button
                className="icon-btn"
                onClick={toggleTheme}
                title="Toggle theme"
                dangerouslySetInnerHTML={{ __html: theme === "light" ? "&#x2600;" : "&#x263E;" }}
              />
              <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings">
                &#x2699;
              </button>
              {user && user.name !== "anonymous" && (
                <span className="user-badge">{user.display_name || user.name}</span>
              )}
            </div>
          </header>

          <main className="main-area">
            {activeView === "dashboard" && <DashboardView />}
            {activeView === "chat" && <ChatView />}
            {activeView === "audit" && <AuditView />}
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
