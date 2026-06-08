import { useClusterQuery } from '../hooks/useClusterQuery';
import { useActiveCluster } from '../store/clusterStore';
import { StatusDot, SeverityBadge, ExpandableSection } from '../design';

function sevFromStatus(phase, restarts) {
  if (restarts > 20) return 'SEV-1';
  if (phase === 'Failed' || phase === 'CrashLoopBackOff' || phase === 'OOMKilled') return 'SEV-1';
  if (phase === 'Pending' || phase === 'ImagePullBackOff') return 'SEV-2';
  if (restarts > 5) return 'SEV-2';
  if (phase === 'Unknown' || restarts > 0) return 'SEV-3';
  return null;
}

function dotStatus(phase) {
  if (phase === 'Running' || phase === 'Succeeded') return 'active';
  if (phase === 'Pending' || phase === 'Unknown') return 'warning';
  return 'critical';
}

export function ObserveView() {
  const cluster = useActiveCluster();
  const { data: summary, isLoading: sumLoad } = useClusterQuery('/api/cluster/summary');
  const { data: podData, isLoading: podLoad } = useClusterQuery('/api/pods/status');

  const pods = podData?.pods || podData?.items || [];
  const problemPods = pods.filter((p) => {
    const phase = p.status?.phase || p.phase || '';
    const restarts = p.restarts || p.status?.containerStatuses?.reduce((s, c) => s + (c.restartCount || 0), 0) || 0;
    return phase !== 'Running' && phase !== 'Succeeded' || restarts > 0;
  }).sort((a, b) => {
    const ra = a.restarts || 0, rb = b.restarts || 0;
    return rb - ra;
  }).slice(0, 20);

  const running = pods.filter((p) => (p.status?.phase || p.phase) === 'Running').length;
  const failed = pods.filter((p) => (p.status?.phase || p.phase) === 'Failed').length;
  const pending = pods.filter((p) => {
    const ph = p.status?.phase || p.phase || '';
    return ph !== 'Running' && ph !== 'Succeeded' && ph !== 'Failed';
  }).length;

  return (
    <div className="ds-view-observe">
      <div className="ds-view-header">
        <h1 className="ds-view-title">Observe</h1>
        <span className="ds-view-cluster">{cluster === 'local' ? 'Hub Cluster' : cluster}</span>
      </div>

      <div className="ds-observe-summary">
        <div className="ds-observe-stat">
          <span className="ds-observe-stat-val">{pods.length}</span>
          <span className="ds-observe-stat-label">Total Pods</span>
        </div>
        <div className="ds-observe-stat">
          <StatusDot status="active" size={8} />
          <span className="ds-observe-stat-val">{running}</span>
          <span className="ds-observe-stat-label">Running</span>
        </div>
        <div className="ds-observe-stat">
          <StatusDot status="critical" size={8} />
          <span className="ds-observe-stat-val">{failed}</span>
          <span className="ds-observe-stat-label">Failed</span>
        </div>
        <div className="ds-observe-stat">
          <StatusDot status="warning" size={8} />
          <span className="ds-observe-stat-val">{pending}</span>
          <span className="ds-observe-stat-label">Warning/Pending</span>
        </div>
      </div>

      <div className="ds-observe-section">
        <h2 className="ds-observe-section-title">Problem Pods</h2>
        {(sumLoad || podLoad) && <div className="ds-loading">Loading cluster data...</div>}
        {!podLoad && problemPods.length === 0 && (
          <div className="ds-empty">All pods are healthy</div>
        )}
        <div className="ds-observe-pods">
          {problemPods.map((p, i) => {
            const name = p.name || p.metadata?.name || 'unknown';
            const ns = p.namespace || p.metadata?.namespace || '';
            const phase = p.phase || p.status?.phase || 'Unknown';
            const restarts = p.restarts || p.status?.containerStatuses?.reduce((s, c) => s + (c.restartCount || 0), 0) || 0;
            const sev = sevFromStatus(phase, restarts);
            return (
              <div key={i} className="ds-observe-pod-row">
                {sev && <SeverityBadge level={sev} />}
                <StatusDot status={dotStatus(phase)} size={7} />
                <span className="ds-observe-pod-name">{name}</span>
                <span className="ds-observe-pod-ns">{ns}</span>
                <span className="ds-observe-pod-phase">{phase}</span>
                {restarts > 0 && <span className="ds-observe-pod-restarts">{restarts} restarts</span>}
                <button className="ds-observe-diagnose" onClick={() => {
                  window.dispatchEvent(new CustomEvent('ai-bar-query', { detail: { text: `diagnose pod ${name} in namespace ${ns}`, cluster } }));
                }}>Diagnose →</button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="ds-observe-section">
        <h2 className="ds-observe-section-title">Resource Utilization</h2>
        <div className="ds-observe-resources">
          {summary?.cpu != null && (
            <div className="ds-observe-res-bar">
              <span className="ds-observe-res-label">CPU</span>
              <div className="ds-observe-bar-track">
                <div className="ds-observe-bar-fill" style={{ width: `${Math.min(summary.cpu, 100)}%`, background: summary.cpu > 85 ? 'var(--crit)' : summary.cpu > 70 ? 'var(--warn)' : 'var(--ok)' }} />
              </div>
              <span className="ds-observe-res-pct">{summary.cpu}%</span>
            </div>
          )}
          {summary?.memory != null && (
            <div className="ds-observe-res-bar">
              <span className="ds-observe-res-label">Memory</span>
              <div className="ds-observe-bar-track">
                <div className="ds-observe-bar-fill" style={{ width: `${Math.min(summary.memory, 100)}%`, background: summary.memory > 85 ? 'var(--crit)' : summary.memory > 70 ? 'var(--warn)' : 'var(--ok)' }} />
              </div>
              <span className="ds-observe-res-pct">{summary.memory}%</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
