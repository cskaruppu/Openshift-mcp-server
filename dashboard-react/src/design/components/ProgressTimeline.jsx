export function ProgressTimeline({ steps = [], currentIndex = 0, className = '' }) {
  return (
    <div className={`ds-timeline ${className}`}>
      <div className="ds-timeline-track">
        {steps.map((step, i) => {
          const state = i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'pending';
          return (
            <div key={i} className={`ds-timeline-step ds-timeline-${state}`}>
              <div className="ds-timeline-dot">
                {state === 'done' ? '✓' : state === 'active' ? '●' : '○'}
              </div>
              {i < steps.length - 1 && <div className="ds-timeline-line" />}
              <div className="ds-timeline-label">{step.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
