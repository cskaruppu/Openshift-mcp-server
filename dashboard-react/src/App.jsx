import { ClusterSwitcher } from "./components/ClusterSwitcher";
import { DashboardView } from "./views/DashboardView";
import { AuditView } from "./views/AuditView";
import { IntelligenceView } from "./views/IntelligenceView";
import { ChatView } from "./views/ChatView";
import { useActiveCluster } from "./store/clusterStore";
import { useViewStore } from "./store/viewStore";

const MIGRATED = 22;
const TOTAL = 22;

const NAV = [
  { key: "dashboard", label: "Dashboard" },
  { key: "chat", label: "AI Chat" },
  { key: "audit", label: "Audit" },
  { key: "intelligence", label: "AI Intelligence" },
];

export default function App() {
  const cluster = useActiveCluster();
  const activeView = useViewStore((s) => s.activeView);
  const setActiveView = useViewStore((s) => s.setActiveView);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">TCS</span> Agentic AI
          <span className="brand-sub">Multi-Cluster Dashboard · Phase 2 (React)</span>
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
        <ClusterSwitcher />
      </header>

      <main className="main-area">
        {activeView === "dashboard" && <DashboardView />}
        {activeView === "chat" && <ChatView />}
        {activeView === "audit" && <AuditView />}
        {activeView === "intelligence" && <IntelligenceView />}
      </main>

      <footer className="app-footer">
        Active cluster context: <strong>{cluster}</strong> — every view above is
        scoped to this cluster. (Phase 2: {MIGRATED} of {TOTAL} widgets/views migrated.)
      </footer>
    </div>
  );
}
