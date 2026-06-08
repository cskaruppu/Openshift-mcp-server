import { useEffect, useState, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api/client";
import { AppShell } from "./design/layouts/AppShell";
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
import { ObserveView } from "./views/ObserveView";
import { OperateView } from "./views/OperateView";
import { TicketsView } from "./views/TicketsView";
import { UpgradeView } from "./views/UpgradeView";
import { useAuthStore } from "./store/authStore";
import { useThemeStore } from "./store/themeStore";
import { showToast } from "./store/toastStore";
import { useClusterStore, useActiveCluster } from "./store/clusterStore";
import { useViewStore } from "./store/viewStore";

export default function App() {
  const cluster = useActiveCluster();
  const setActiveCluster = useClusterStore((s) => s.setActiveCluster);
  const activeView = useViewStore((s) => s.activeView);
  const setActiveView = useViewStore((s) => s.setActiveView);
  const { checked, authenticated, user } = useAuthStore();
  const theme = useThemeStore((s) => s.theme);
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

  // Cluster picker (workspace selection) — shown before entering a cluster
  if (authenticated && inClusterPicker) {
    return (
      <>
        <ClusterPickerView
          onSelectCluster={handleSelectCluster}
          onLogout={handleLogout}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenAgentRegistry={() => setAgentRegOpen(true)}
          onOpenUserMgmt={() => setUserMgmtOpen(true)}
        />
        <AgentRegistryModal open={agentRegOpen} onClose={() => setAgentRegOpen(false)} />
        <UserManagementPanel open={userMgmtOpen} onClose={() => setUserMgmtOpen(false)} />
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <KbdOverlay open={kbdOpen} onClose={() => setKbdOpen(false)} />
        <ToastStack />
      </>
    );
  }

  // Main workspace — AppShell enforces TopBar + ClusterStrip + LeftNav + AI Bar + Footer
  return (
    <>
      <LoginOverlay />
      {authenticated && (
        <AppShell
          onBack={handleBackToPicker}
          onLogout={handleLogout}
          onKbd={() => setKbdOpen(true)}
          onSettings={() => setSettingsOpen(true)}
          onSelectCluster={(id) => setActiveCluster(id)}
        >
          {activeView === "dashboard" && <DashboardView />}
          {activeView === "chat" && <ChatView />}
          {activeView === "observe" && <ObserveView />}
          {activeView === "operate" && <OperateView />}
          {activeView === "upgrade" && <UpgradeView />}
          {activeView === "tickets" && <TicketsView />}
          {activeView === "audit" && <AuditView />}
          {activeView === "intelligence" && <IntelligenceView />}
        </AppShell>
      )}

      <AgentRegistryModal open={agentRegOpen} onClose={() => setAgentRegOpen(false)} />
      <UserManagementPanel open={userMgmtOpen} onClose={() => setUserMgmtOpen(false)} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <KbdOverlay open={kbdOpen} onClose={() => setKbdOpen(false)} />
      <CommandPalette />
      <ToastStack />
    </>
  );
}
