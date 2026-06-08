import { LoginOverlay } from '../../components/LoginOverlay';
import { TopBar } from './TopBar';
import { ClusterStrip } from './ClusterStrip';
import { LeftNav } from './LeftNav';
import { PersistentAIBar } from './PersistentAIBar';
import { useAuthStore } from '../../store/authStore';

export function AppShell({ children, onBack, onLogout, onKbd, onSettings, onSelectCluster }) {
  const { checked, authenticated } = useAuthStore();

  if (!checked) {
    return (
      <div className="app-loading-screen">
        <div className="app-loading-logo">TA</div>
        <div className="app-loading-text">TCS Agentic AI</div>
        <div className="app-loading-bar" />
      </div>
    );
  }

  if (!authenticated) {
    return <LoginOverlay />;
  }

  return (
    <div className="ds-shell">
      <TopBar onBack={onBack} onLogout={onLogout} onKbd={onKbd} onSettings={onSettings} />
      <ClusterStrip onSelectCluster={onSelectCluster} />
      <div className="ds-shell-body">
        <LeftNav />
        <main className="ds-shell-content">
          {children}
        </main>
      </div>
      <PersistentAIBar />
      <footer className="ds-shell-footer">
        Powered by <strong>TCS</strong> &middot; &copy; {new Date().getFullYear()} Tata Consultancy Services. All rights reserved.
      </footer>
    </div>
  );
}
