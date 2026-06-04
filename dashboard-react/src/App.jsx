import { ClusterSwitcher } from "./components/ClusterSwitcher";
import { ClusterHealthWidget } from "./components/widgets/ClusterHealthWidget";
import { NodesWidget } from "./components/widgets/NodesWidget";
import { NamespacesWidget } from "./components/widgets/NamespacesWidget";
import { useActiveCluster } from "./store/clusterStore";

export default function App() {
  const cluster = useActiveCluster();
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">TCS</span> Agentic AI
          <span className="brand-sub">Multi-Cluster Dashboard · Phase 2 (React)</span>
        </div>
        <ClusterSwitcher />
      </header>

      <main className="dashboard-grid">
        {/*
          Every widget below is scoped to the active cluster via useClusterQuery.
          Switching clusters re-keys all queries simultaneously — no manual
          clearing, guards, or aborts. This is isolation by design.
        */}
        <ClusterHealthWidget />
        <NodesWidget />
        <NamespacesWidget />
      </main>

      <footer className="app-footer">
        Active cluster context: <strong>{cluster}</strong> — all widgets above are
        scoped to this cluster. (Phase 2 foundation: 3 of 22 widgets migrated.)
      </footer>
    </div>
  );
}
