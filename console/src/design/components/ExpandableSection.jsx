import { useState } from 'react';

export function ExpandableSection({ title, badge, defaultOpen = false, children, className = '' }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`ds-expandable ${open ? 'ds-expandable-open' : ''} ${className}`}>
      <button className="ds-expandable-header" onClick={() => setOpen(!open)}>
        <span className="ds-expandable-arrow">{open ? '▾' : '▸'}</span>
        <span className="ds-expandable-title">{title}</span>
        {badge && <span className="ds-expandable-badge">{badge}</span>}
      </button>
      {open && <div className="ds-expandable-body">{children}</div>}
    </div>
  );
}
