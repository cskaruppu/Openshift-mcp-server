import { tokens } from '../tokens';
import { useViewStore } from '../../store/viewStore';

export function LeftNav() {
  const activeView = useViewStore((s) => s.activeView);
  const setView = useViewStore((s) => s.setActiveView);

  return (
    <nav className="ds-leftnav">
      {tokens.nav.map((item) => (
        <button
          key={item.key}
          className={`ds-leftnav-item ${activeView === item.key ? 'ds-leftnav-active' : ''}`}
          onClick={() => setView(item.key)}
          title={item.label}
        >
          <span className="ds-leftnav-icon">{item.icon}</span>
          <span className="ds-leftnav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
