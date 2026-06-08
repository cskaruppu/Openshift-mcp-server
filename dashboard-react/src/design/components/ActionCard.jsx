import { SeverityBadge } from './SeverityBadge';

export function ActionCard({ title, severity, confidence, description, risk, actions, children, className = '' }) {
  return (
    <div className={`ds-action-card ${className}`}>
      <div className="ds-action-card-head">
        <span className="ds-action-card-title">{title}</span>
        {severity && <SeverityBadge level={severity} />}
        {confidence != null && (
          <span className="ds-action-card-conf">{confidence}% confidence</span>
        )}
      </div>
      {description && <p className="ds-action-card-desc">{description}</p>}
      {risk && (
        <div className="ds-action-card-risk">
          Risk: <strong>{risk}</strong>
        </div>
      )}
      {children}
      {actions && actions.length > 0 && (
        <div className="ds-action-card-actions">
          {actions.map((a, i) => (
            <button key={i} className={`ds-action-btn ${a.primary ? 'ds-action-btn-primary' : ''}`} onClick={a.onClick} disabled={a.disabled}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
