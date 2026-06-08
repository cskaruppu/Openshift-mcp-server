import { useState } from 'react';
import { useActiveCluster } from '../store/clusterStore';
import { ActionCard, SeverityBadge, StatusDot } from '../design';
import { useClusterQuery } from '../hooks/useClusterQuery';

export function OperateView() {
  const cluster = useActiveCluster();
  const { data: podData } = useClusterQuery('/api/pods/status');

  const pods = podData?.pods || podData?.items || [];
  const atRisk = pods.filter((p) => {
    const phase = p.phase || p.status?.phase || '';
    const restarts = p.restarts || 0;
    return phase !== 'Running' && phase !== 'Succeeded' || restarts > 5;
  }).slice(0, 10);

  return (
    <div className="ds-view-operate">
      <div className="ds-view-header">
        <h1 className="ds-view-title">Operate</h1>
        <span className="ds-view-cluster">{cluster === 'local' ? 'Hub Cluster' : cluster}</span>
      </div>

      <div className="ds-operate-section">
        <h2 className="ds-section-title">Active Fix Proposals</h2>
        {atRisk.length === 0 && (
          <div className="ds-empty">No pods currently need attention. All workloads are healthy.</div>
        )}
        {atRisk.map((p, i) => {
          const name = p.name || p.metadata?.name || 'unknown';
          const ns = p.namespace || p.metadata?.namespace || '';
          const phase = p.phase || p.status?.phase || 'Unknown';
          const restarts = p.restarts || 0;
          return (
            <ActionCard
              key={i}
              title={`${name} — ${phase}`}
              severity={restarts > 20 ? 'SEV-1' : restarts > 5 ? 'SEV-2' : 'SEV-3'}
              description={`Namespace: ${ns} · ${restarts} restarts`}
              risk="Assessed by AI upon diagnosis"
              actions={[
                {
                  label: 'Diagnose & Fix →',
                  primary: true,
                  onClick: () => {
                    window.dispatchEvent(new CustomEvent('ai-bar-query', {
                      detail: { text: `diagnose and fix pod ${name} in namespace ${ns}`, cluster },
                    }));
                  },
                },
              ]}
            />
          );
        })}
      </div>

      <div className="ds-operate-section">
        <h2 className="ds-section-title">Quick Actions</h2>
        <div className="ds-operate-actions-grid">
          <button className="ds-operate-action" onClick={() => window.dispatchEvent(new CustomEvent('ai-bar-query', { detail: { text: 'show all failing pods and diagnose', cluster } }))}>
            <span className="ds-operate-action-icon">🔍</span>
            <span>Diagnose All Failures</span>
          </button>
          <button className="ds-operate-action" onClick={() => window.dispatchEvent(new CustomEvent('ai-bar-query', { detail: { text: 'show resource optimization recommendations', cluster } }))}>
            <span className="ds-operate-action-icon">📊</span>
            <span>Resource Optimization</span>
          </button>
          <button className="ds-operate-action" onClick={() => window.dispatchEvent(new CustomEvent('ai-bar-query', { detail: { text: 'check certificate expiry', cluster } }))}>
            <span className="ds-operate-action-icon">🔐</span>
            <span>Certificate Check</span>
          </button>
          <button className="ds-operate-action" onClick={() => window.dispatchEvent(new CustomEvent('ai-bar-query', { detail: { text: 'show cluster security posture', cluster } }))}>
            <span className="ds-operate-action-icon">🛡</span>
            <span>Security Posture</span>
          </button>
        </div>
      </div>
    </div>
  );
}
