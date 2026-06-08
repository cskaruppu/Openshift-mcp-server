import { useEffect, useRef } from 'react';

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm, onCancel }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="ds-confirm-overlay" onClick={onCancel}>
      <div className="ds-confirm-dialog" ref={ref} onClick={(e) => e.stopPropagation()}>
        <h3 className="ds-confirm-title">{title}</h3>
        <p className="ds-confirm-msg">{message}</p>
        <div className="ds-confirm-actions">
          <button className="ds-confirm-cancel" onClick={onCancel}>{cancelLabel}</button>
          <button className={`ds-confirm-ok ${danger ? 'ds-confirm-danger' : ''}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
