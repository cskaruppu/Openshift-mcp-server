import { useEffect, useState, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api/client";
import { LoginOverlay } from "./components/LoginOverlay";
import { SettingsPanel } from "./components/SettingsPanel";
import { UserManagementPanel } from "./components/UserManagementPanel";
import { AgentRegistryModal } from "./components/AgentRegistryModal";
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

// Per-cluster views only. AI Hub / Agent Registry / Settings are fleet-level
// and live on the centralized cluster-picker screen, not inside a cluster.
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
  const [userMgmtOpen, setUserMgmtOpen] = useState(false);
  const [agentRegOpen, setAgentRegOpen] = useState(false);
  const [inClusterPicker, setInClusterPicker] = useState(true);
  const { kbdOpen, setKbdOpen } = useKeyboardShortcuts();

  const { data: agentData } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 10_000,
    refetchInterval: 30_000,
    enabled: authenticated,
  });


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

  // One-time auto-skip: if the only cluster is the hub, drop the user straight
  // into its workspace on first load. Must not re-fire on later refetches, or it
  // would kick the user out whenever they return to the centralized picker.
  const autoSkippedRef = useRef(false);
  useEffect(() => {
    if (autoSkippedRef.current) return;
    if (authenticated && agentData) {
      autoSkippedRef.current = true;
      const hasRemote = Array.isArray(agentData.agents) && agentData.agents.length > 0;
      if (!hasRemote) setInClusterPicker(false);
    }
  }, [authenticated, agentData]);

  const handleSelectCluster = useCallback((name) => {
    setActiveCluster(name);
    setInClusterPicker(false);
    setActiveView("dashboard");
  }, [setActiveCluster, setActiveView]);

  const handleOpenAgentRegistry = useCallback(() => {
    setAgentRegOpen(true);
  }, []);
  const handleCloseAgentRegistry = useCallback(() => {
    setAgentRegOpen(false);
  }, []);
  const handleOpenUserMgmt = useCallback(() => {
    setUserMgmtOpen(true);
  }, []);
  const handleCloseUserMgmt = useCallback(() => {
    setUserMgmtOpen(false);
  }, []);

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
          onOpenAgentRegistry={handleOpenAgentRegistry}
          onOpenUserMgmt={handleOpenUserMgmt}
        />
      )}
      {authenticated && !inClusterPicker && (
        <div className="app">
          <header className="app-header">
            <div className="header-left">
              <button className="back-pill" onClick={handleBackToPicker} title="Back to cluster selection">
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M8 1L3 6l5 5"/>
                </svg>
              </button>
              <div className="brand">
                <span className="brand-mark">TCS</span> Agentic AI
                <span className="brand-sub">Enterprise Intelligence Platform</span>
              </div>
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
              <div className="conn-status">
                <span className="conn-dot connected" />
                <span className="conn-label">Connected</span>
              </div>
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
            {activeView === "intelligence" && <IntelligenceView />}
          </main>

          <footer className="app-footer">
            <span className="app-footer-left">
              Active cluster: <strong>{cluster === "local" ? "Hub" : cluster}</strong>
              {user && user.name !== "anonymous" && <> — signed in as <strong>{user.name}</strong></>}
            </span>
            <span className="app-footer-right">
              Powered by <strong>TCS</strong> · &copy; {new Date().getFullYear()} Tata Consultancy Services. All rights reserved.
            </span>
          </footer>
        </div>
      )}

      <AgentRegistryModal open={agentRegOpen} onClose={handleCloseAgentRegistry} />
      <UserManagementPanel open={userMgmtOpen} onClose={handleCloseUserMgmt} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <KbdOverlay open={kbdOpen} onClose={() => setKbdOpen(false)} />
      <ToastStack />
    </>
  );
}

