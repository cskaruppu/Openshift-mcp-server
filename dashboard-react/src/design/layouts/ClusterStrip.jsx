import { useEffect, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { useClusterStore, useActiveCluster } from '../../store/clusterStore';
import { StatusDot } from '../components/StatusDot';

function clusterStatus(agent) {
  if (!agent) return 'unknown';
  const s = (agent.status || '').toLowerCase();
  if (s === 'live' || s === 'active' || s === 'connected') return 'active';
  if (s === 'stale') return 'warning';
  if (s === 'unreachable' || s === 'error' || s === 'auth-error') return 'critical';
  if (s === 'pending' || s === 'waiting' || s === 'registered') return 'pending';
  return 'unknown';
}

export function ClusterStrip({ onSelectCluster }) {
  const cluster = useActiveCluster();
  const setActive = useClusterStore((s) => s.setActiveCluster);

  const { data: agentData } = useQuery({
    queryKey: ['/api/agent/status'],
    queryFn: ({ signal }) => apiGet('/api/agent/status', { signal }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const agents = agentData?.agents || [];
  const clusters = [
    { id: 'local', name: agentData?.clusterName || 'Hub Cluster', version: agentData?.version || '', status: 'active' },
    ...agents.map((a) => ({
      id: a.name || a.cluster,
      name: a.name || a.cluster,
      version: a.version || '',
      status: clusterStatus(a),
    })),
  ];

  const handleClick = useCallback((id) => {
    setActive(id);
    onSelectCluster?.(id);
  }, [setActive, onSelectCluster]);

  return (
    <div className="ds-cluster-strip">
      {clusters.map((c) => (
        <button
          key={c.id}
          className={`ds-cluster-chip ${cluster === c.id ? 'ds-cluster-chip-active' : ''}`}
          onClick={() => handleClick(c.id)}
          title={`${c.name}${c.version ? ' · ' + c.version : ''}`}
        >
          <StatusDot status={c.status} size={7} />
          <span className="ds-cluster-chip-name">{c.name}</span>
          {cluster === c.id && <span className="ds-cluster-chip-check">✓</span>}
        </button>
      ))}
    </div>
  );
}
