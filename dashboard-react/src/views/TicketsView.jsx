import { useState, useEffect } from 'react';
import { SeverityBadge, StatusDot } from '../design';

const STATUS_ORDER = { new: 0, 'in progress': 1, 'on hold': 2, resolved: 3, closed: 4 };

export function TicketsView() {
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/servicenow/incidents');
        const data = await res.json();
        if (!cancelled) setIncidents(data.incidents || data.result || []);
      } catch { /* ServiceNow may not be configured */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = incidents.filter((inc) => {
    if (filter === 'all') return true;
    if (filter === 'open') return !['resolved', 'closed'].includes((inc.state_label || inc.state || '').toLowerCase());
    if (filter === 'resolved') return (inc.state_label || inc.state || '').toLowerCase() === 'resolved';
    if (filter === 'closed') return (inc.state_label || inc.state || '').toLowerCase() === 'closed';
    return true;
  });

  const openCount = incidents.filter((i) => !['resolved', 'closed'].includes((i.state_label || i.state || '').toLowerCase())).length;
  const resolvedCount = incidents.filter((i) => (i.state_label || i.state || '').toLowerCase() === 'resolved').length;
  const closedCount = incidents.filter((i) => (i.state_label || i.state || '').toLowerCase() === 'closed').length;

  return (
    <div className="ds-view-tickets">
      <div className="ds-view-header">
        <h1 className="ds-view-title">Tickets</h1>
        <span className="ds-view-subtitle">ServiceNow Integration</span>
      </div>

      <div className="ds-tickets-pipeline">
        <div className="ds-tickets-stat" onClick={() => setFilter('open')}>
          <span className="ds-tickets-stat-val">{openCount}</span>
          <span className="ds-tickets-stat-label">Open</span>
        </div>
        <div className="ds-tickets-stat" onClick={() => setFilter('resolved')}>
          <span className="ds-tickets-stat-val">{resolvedCount}</span>
          <span className="ds-tickets-stat-label">Resolved</span>
        </div>
        <div className="ds-tickets-stat" onClick={() => setFilter('closed')}>
          <span className="ds-tickets-stat-val">{closedCount}</span>
          <span className="ds-tickets-stat-label">Closed</span>
        </div>
        <div className="ds-tickets-stat" onClick={() => setFilter('all')}>
          <span className="ds-tickets-stat-val">{incidents.length}</span>
          <span className="ds-tickets-stat-label">Total</span>
        </div>
      </div>

      {loading && <div className="ds-loading">Loading incidents...</div>}
      {!loading && filtered.length === 0 && (
        <div className="ds-empty">
          {incidents.length === 0
            ? 'No incidents found. ServiceNow integration creates incidents automatically when AI diagnoses issues.'
            : 'No incidents match the selected filter.'}
        </div>
      )}

      <div className="ds-tickets-list">
        {filtered.map((inc, i) => {
          const sev = inc.severity || inc.impact;
          const sevLabel = sev === '1' || sev === 1 ? 'SEV-1' : sev === '2' || sev === 2 ? 'SEV-2' : 'SEV-3';
          const state = (inc.state_label || inc.state || 'New').toLowerCase();
          const dotStatus = ['resolved', 'closed'].includes(state) ? 'active' : state === 'in progress' ? 'warning' : 'critical';
          return (
            <div key={i} className="ds-ticket-card">
              <div className="ds-ticket-head">
                <SeverityBadge level={sevLabel} />
                <span className="ds-ticket-number">{inc.number || `INC${String(i).padStart(7, '0')}`}</span>
                <StatusDot status={dotStatus} size={7} showLabel />
              </div>
              <div className="ds-ticket-desc">{inc.short_description || inc.description || 'No description'}</div>
              <div className="ds-ticket-meta">
                {inc.assignment_group && <span>Team: {inc.assignment_group}</span>}
                {inc.opened_at && <span>Created: {new Date(inc.opened_at).toLocaleString()}</span>}
              </div>
              {inc.work_notes && (
                <div className="ds-ticket-notes">
                  <strong>Latest note:</strong> {typeof inc.work_notes === 'string' ? inc.work_notes.slice(0, 200) : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
