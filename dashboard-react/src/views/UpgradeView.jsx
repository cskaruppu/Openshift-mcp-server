import { useState, useEffect } from 'react';
import { useActiveCluster } from '../store/clusterStore';
import { ProgressTimeline, ExpandableSection, StatusDot } from '../design';
import { useClusterQuery } from '../hooks/useClusterQuery';

const UPGRADE_STEPS = [
  { key: 'preflight', label: 'Pre-Assessment' },
  { key: 'version_validated', label: 'Version Validated' },
  { key: 'snapshot', label: 'Snapshot' },
  { key: 'control_plane', label: 'Control Plane' },
  { key: 'workers', label: 'Worker Nodes' },
  { key: 'operators', label: 'Operators' },
  { key: 'post_check', label: 'Post-Check' },
  { key: 'completed', label: 'Completed' },
];

export function UpgradeView() {
  const cluster = useActiveCluster();
  const { data: versionData } = useClusterQuery('/api/cluster/summary');
  const [session, setSession] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/upgrade/session?cluster=${encodeURIComponent(cluster)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.session) setSession(data.session);
        }
      } catch {}
    })();
  }, [cluster]);

  const currentVersion = versionData?.version || versionData?.openshiftVersion || 'Unknown';
  const currentStep = session?.currentStep || 0;

  return (
    <div className="ds-view-upgrade">
      <div className="ds-view-header">
        <h1 className="ds-view-title">Upgrade</h1>
        <span className="ds-view-cluster">{cluster === 'local' ? 'Hub Cluster' : cluster}</span>
      </div>

      <div className="ds-upgrade-version">
        <div className="ds-upgrade-ver-current">
          <span className="ds-upgrade-ver-label">Current Version</span>
          <span className="ds-upgrade-ver-val">{currentVersion}</span>
        </div>
        {session?.targetVersion && (
          <>
            <span className="ds-upgrade-arrow">→</span>
            <div className="ds-upgrade-ver-target">
              <span className="ds-upgrade-ver-label">Target Version</span>
              <span className="ds-upgrade-ver-val">{session.targetVersion}</span>
            </div>
          </>
        )}
      </div>

      {session && (
        <ProgressTimeline steps={UPGRADE_STEPS} currentIndex={currentStep} />
      )}

      {!session && (
        <div className="ds-upgrade-start">
          <p>No active upgrade session. Start a new upgrade by asking the AI assistant.</p>
          <button className="ds-upgrade-start-btn" onClick={() => {
            window.dispatchEvent(new CustomEvent('ai-bar-query', {
              detail: { text: `what upgrade options are available for this cluster?`, cluster },
            }));
          }}>
            Check Available Upgrades →
          </button>
        </div>
      )}

      {session?.preflightResults && (
        <ExpandableSection title="Pre-Assessment Results" badge={`${session.preflightResults.passed || 0} passed`} defaultOpen>
          <div className="ds-upgrade-checks">
            {(session.preflightResults.checks || []).map((check, i) => (
              <div key={i} className="ds-upgrade-check-row">
                <StatusDot status={check.status === 'pass' ? 'active' : check.status === 'warn' ? 'warning' : 'critical'} size={7} />
                <span className="ds-upgrade-check-name">{check.name || check.category}</span>
                <span className="ds-upgrade-check-status">{check.status}</span>
                {check.details && <span className="ds-upgrade-check-detail">{check.details}</span>}
              </div>
            ))}
          </div>
        </ExpandableSection>
      )}

      {session?.steps && session.steps.length > 0 && (
        <div className="ds-upgrade-steps">
          {session.steps.map((step, i) => (
            <ExpandableSection key={i} title={step.label || step.name || `Step ${i + 1}`} badge={step.status}>
              <div className="ds-upgrade-step-detail">
                {step.details && <p>{step.details}</p>}
                {step.duration && <p>Duration: {step.duration}</p>}
                {step.components && step.components.map((comp, j) => (
                  <div key={j} className="ds-upgrade-comp-row">
                    <StatusDot status={comp.status === 'healthy' || comp.status === 'done' ? 'active' : 'warning'} size={6} />
                    <span>{comp.name}</span>
                    <span>{comp.version || comp.status}</span>
                  </div>
                ))}
              </div>
            </ExpandableSection>
          ))}
        </div>
      )}
    </div>
  );
}
