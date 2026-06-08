import { tokens } from '../tokens';

const STATUS_MAP = {
  healthy: { color: tokens.color.success, pulse: true, label: 'Healthy' },
  active: { color: tokens.color.success, pulse: true, label: 'Active' },
  connected: { color: tokens.color.success, pulse: true, label: 'Connected' },
  live: { color: tokens.color.success, pulse: true, label: 'Live' },
  running: { color: tokens.color.success, pulse: true, label: 'Running' },
  warning: { color: tokens.color.warning, pulse: false, label: 'Warning' },
  stale: { color: tokens.color.warning, pulse: false, label: 'Stale' },
  degraded: { color: tokens.color.warning, pulse: false, label: 'Degraded' },
  critical: { color: tokens.color.critical, pulse: false, label: 'Critical' },
  error: { color: tokens.color.critical, pulse: false, label: 'Error' },
  unreachable: { color: tokens.color.critical, pulse: false, label: 'Unreachable' },
  offline: { color: tokens.color.critical, pulse: false, label: 'Offline' },
  info: { color: tokens.color.info, pulse: false, label: 'Info' },
  pending: { color: tokens.color.warning, pulse: true, label: 'Pending' },
  unknown: { color: tokens.color.textMuted, pulse: false, label: 'Unknown' },
};

export function StatusDot({ status = 'unknown', size = 8, showLabel = false, className = '' }) {
  const key = (status || 'unknown').toLowerCase();
  const cfg = STATUS_MAP[key] || STATUS_MAP.unknown;
  return (
    <span className={`ds-status-dot ${className}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: size, height: size, borderRadius: '50%',
          background: cfg.color,
          boxShadow: cfg.pulse ? `0 0 0 3px ${cfg.color}33` : 'none',
          animation: cfg.pulse ? 'ds-pulse 2s ease-in-out infinite' : 'none',
          flexShrink: 0,
        }}
      />
      {showLabel && <span style={{ fontSize: 12, fontWeight: 500, color: cfg.color }}>{cfg.label}</span>}
    </span>
  );
}
