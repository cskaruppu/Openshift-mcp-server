import { useAuthStore } from '../../store/authStore';
import { useThemeStore } from '../../store/themeStore';
import { showToast } from '../../store/toastStore';

export function TopBar({ onBack, onLogout, onKbd, onSettings }) {
  const user = useAuthStore((s) => s.user);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  return (
    <header className="ds-topbar">
      <div className="ds-topbar-left">
        {onBack && (
          <button className="ds-topbar-back" onClick={onBack} title="Back to cluster selection">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M8 1L3 6l5 5"/></svg>
          </button>
        )}
        <div className="ds-topbar-brand">
          <span className="ds-topbar-brand-mark">TCS</span> Agentic AI
          <span className="ds-topbar-brand-sub">Enterprise Intelligence Platform</span>
        </div>
      </div>
      <div className="ds-topbar-right">
        <div className="ds-topbar-conn">
          <span className="ds-topbar-conn-dot" />
          <span className="ds-topbar-conn-label">Connected</span>
        </div>
        <button className="ds-topbar-icon" onClick={() => { showToast('Refreshing...', 'ok'); window.location.reload(); }} title="Refresh">↻</button>
        <button className="ds-topbar-icon" onClick={toggleTheme} title="Toggle theme" dangerouslySetInnerHTML={{ __html: theme === 'light' ? '&#x2600;' : '&#x263E;' }} />
        <button className="ds-topbar-cmdk" onClick={() => window.dispatchEvent(new Event('open-command-palette'))} title="Command palette (Ctrl+K)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
        <button className="ds-topbar-icon" onClick={onKbd} title="Keyboard shortcuts (Ctrl+/)">⌨</button>
        {onSettings && <button className="ds-topbar-icon" onClick={onSettings} title="Settings">⚙</button>}
        {user && user.name !== 'anonymous' && (
          <>
            <span className="ds-topbar-user">{user.display_name || user.name}</span>
            <button className="ds-topbar-icon ds-topbar-logout" onClick={onLogout} title="Sign out">⏻</button>
          </>
        )}
      </div>
    </header>
  );
}
