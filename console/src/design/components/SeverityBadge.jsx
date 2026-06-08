import { tokens } from '../tokens';

const SEV_MAP = {
  'SEV-1': { bg: `${tokens.color.critical}22`, fg: tokens.color.critical, label: 'SEV-1' },
  'SEV-2': { bg: `${tokens.color.warning}22`, fg: tokens.color.warning, label: 'SEV-2' },
  'SEV-3': { bg: `${tokens.color.info}22`, fg: tokens.color.info, label: 'SEV-3' },
  'SEV-4': { bg: `${tokens.color.textMuted}22`, fg: tokens.color.textMuted, label: 'SEV-4' },
  'critical': { bg: `${tokens.color.critical}22`, fg: tokens.color.critical, label: 'Critical' },
  'high': { bg: `${tokens.color.critical}22`, fg: tokens.color.critical, label: 'High' },
  'warning': { bg: `${tokens.color.warning}22`, fg: tokens.color.warning, label: 'Warning' },
  'medium': { bg: `${tokens.color.warning}22`, fg: tokens.color.warning, label: 'Medium' },
  'low': { bg: `${tokens.color.success}22`, fg: tokens.color.success, label: 'Low' },
  'info': { bg: `${tokens.color.info}22`, fg: tokens.color.info, label: 'Info' },
};

export function SeverityBadge({ level, className = '' }) {
  const key = (level || '').toUpperCase();
  const cfg = SEV_MAP[key] || SEV_MAP[(level || '').toLowerCase()] || SEV_MAP['info'];
  return (
    <span
      className={`ds-sev-badge ${className}`}
      style={{
        display: 'inline-block', padding: '2px 8px', borderRadius: 9999,
        fontSize: 11, fontWeight: 600, background: cfg.bg, color: cfg.fg,
      }}
    >
      {cfg.label}
    </span>
  );
}
