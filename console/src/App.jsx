import { useEffect, useState, useCallback, useRef, Component } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api/client";
import { LoginOverlay } from "./components/LoginOverlay";
import { SettingsPanel } from "./components/SettingsPanel";
import { UserManagementPanel } from "./components/UserManagementPanel";
import { AgentRegistryModal } from "./components/AgentRegistryModal";
import { ToastStack } from "./components/ToastStack";
import { KbdOverlay, useKeyboardShortcuts } from "./components/KeyboardShortcuts";
import { CommandPalette } from "./components/CommandPalette";
import { ClusterPickerView } from "./views/ClusterPickerView";
import { DashboardView } from "./views/DashboardView";
import { AuditView } from "./views/AuditView";
import { IntelligenceView } from "./views/IntelligenceView";
import { ChatView } from "./views/ChatView";
import { AutopilotView } from "./views/AutopilotView";
import { useAuthStore } from "./store/authStore";
import { useThemeStore } from "./store/themeStore";
import { showToast } from "./store/toastStore";
import { useClusterStore, useActiveCluster } from "./store/clusterStore";
import { useViewStore } from "./store/viewStore";

class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(err, info) { console.error("[ErrorBoundary]", err, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 40, fontFamily: "Inter, system-ui, sans-serif", maxWidth: 600, margin: "60px auto" }}>
        <h2 style={{ color: "#ef4444", marginBottom: 12 }}>Something went wrong</h2>
        <p style={{ color: "#64748b", marginBottom: 16 }}>The application encountered an unexpected error. Try refreshing the page.</p>
        <pre style={{ background: "#1e293b", color: "#f8fafc", padding: 16, borderRadius: 8, fontSize: 12, overflow: "auto", maxHeight: 200 }}>
          {this.state.error?.message || "Unknown error"}
        </pre>
        <button onClick={() => window.location.reload()} style={{ marginTop: 16, padding: "10px 24px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 14 }}>
          Reload Page
        </button>
        <button onClick={() => this.setState({ error: null })} style={{ marginTop: 16, marginLeft: 12, padding: "10px 24px", background: "transparent", color: "#6366f1", border: "1px solid #6366f1", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 14 }}>
          Try Again
        </button>
      </div>
    );
  }
}

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
  // Altitude scope: "cluster" = the per-cluster tabs; "fleet" = cross-cluster
  // surfaces (Autopilot). The scope switcher in the header toggles between them.
  const [scope, setScope] = useState("cluster");
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
      let retries = 2;
      while (retries >= 0) {
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
          break;
        } catch {
          if (retries > 0) {
            retries--;
            await new Promise((r) => setTimeout(r, 1000));
          } else {
            useAuthStore.getState().setAuth({ name: "anonymous", role: "admin" });
          }
        }
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
      // Only auto-enter the hub workspace when its MCP agent is actually
      // running — otherwise stay on the picker, which shows deploy guidance.
      const hubReady = agentData.hubAgentDeployed !== false;
      if (!hasRemote && hubReady) setInClusterPicker(false);
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
    <ErrorBoundary>
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
            <div className="scope-switch" role="tablist" aria-label="Scope">
              <button
                className={"scope-btn" + (scope === "cluster" ? " active" : "")}
                onClick={() => setScope("cluster")}
                title="Operate on the selected cluster"
              >
                Cluster
              </button>
              <button
                className={"scope-btn" + (scope === "fleet" ? " active" : "")}
                onClick={() => setScope("fleet")}
                title="Cross-cluster automation (Autopilot)"
              >
                Fleet
              </button>
            </div>
            <nav className="nav-tabs">
              {scope === "cluster" && NAV.map((t) => (
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
              {scope === "fleet" && (
                <button className="nav-tab active">🛫 Autopilot</button>
              )}
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
              <button
                className="cmdk-trigger"
                onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
                title="Command palette (Ctrl+K)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <span className="cmdk-trigger-label">Search</span>
                <kbd>⌘K</kbd>
              </button>
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
            {scope === "fleet" ? (
              <AutopilotView />
            ) : (
              <>
                {activeView === "dashboard" && <DashboardView />}
                {activeView === "chat" && <ChatView />}
                {activeView === "audit" && <AuditView />}
                {activeView === "intelligence" && <IntelligenceView />}
              </>
            )}
          </main>

          <footer className="app-footer">
            Powered by <strong>TCS</strong> · &copy; {new Date().getFullYear()} Tata Consultancy Services. All rights reserved.
          </footer>

          <CommandPalette />
        </div>
      )}

      <AgentRegistryModal open={agentRegOpen} onClose={handleCloseAgentRegistry} />
      <UserManagementPanel open={userMgmtOpen} onClose={handleCloseUserMgmt} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <KbdOverlay open={kbdOpen} onClose={() => setKbdOpen(false)} />
      <ToastStack />
    </ErrorBoundary>
  );
}

