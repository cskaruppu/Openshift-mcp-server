import { ClusterHealthWidget } from "../components/widgets/ClusterHealthWidget";
import { NodesWidget } from "../components/widgets/NodesWidget";
import { PodsWidget } from "../components/widgets/PodsWidget";
import { NamespacesWidget } from "../components/widgets/NamespacesWidget";
import { ClusterOperatorsWidget } from "../components/widgets/ClusterOperatorsWidget";
import { ActiveAlertsWidget } from "../components/widgets/ActiveAlertsWidget";
import { PodsAtRiskWidget } from "../components/widgets/PodsAtRiskWidget";
import { ScoreWidget } from "../components/widgets/ScoreWidget";
import { NodeTopologyWidget } from "../components/widgets/NodeTopologyWidget";
import { NamespaceHeatmapWidget } from "../components/widgets/NamespaceHeatmapWidget";
import { AppChangesWidget } from "../components/widgets/AppChangesWidget";
import { ImageVulnsWidget } from "../components/widgets/ImageVulnsWidget";
import { HealthTimelineWidget } from "../components/widgets/HealthTimelineWidget";
import { ResourceOptimizationWidget } from "../components/widgets/ResourceOptimizationWidget";
import { CapacityWidget } from "../components/widgets/CapacityWidget";
import { EmergencyActionsWidget } from "../components/widgets/EmergencyActionsWidget";
import { REFRESH } from "../hooks/useClusterQuery";

/**
 * Dashboard — a single pane ordered by operational priority, top to bottom:
 *
 *   1. Cluster vitals (hero)      — is the cluster healthy right now?
 *   2. What needs attention       — active alerts & pods at risk
 *   3. Governance posture         — CIS / GitOps / DR scorecards
 *   4. Security & change risk     — image vulns, app changes
 *   5. Capacity & utilization     — live CPU/mem/headroom + resource optimization
 *   6. Trends & topology          — health timeline, node topology, heatmap
 *   7. Operator actions           — emergency actions (last, deliberate)
 *
 * Risk predictions live in AI Intelligence, ServiceNow CRs in Audit — they are
 * intentionally not duplicated here.
 */
export function DashboardView() {
  return (
    <div className="dash">
      {/* ── 1. Cluster Vitals (hero) ── */}
      <section className="dash-section">
        <div className="dash-hero-row">
          <div className="dash-hero-card hero-health">
            <ClusterHealthWidget />
          </div>
          <div className="dash-hero-card hero-nodes">
            <NodesWidget />
          </div>
          <div className="dash-hero-card hero-pods">
            <PodsWidget />
          </div>
          <div className="dash-hero-card hero-ns">
            <NamespacesWidget />
          </div>
          <div className="dash-hero-card hero-ops">
            <ClusterOperatorsWidget />
          </div>
        </div>
      </section>

      {/* ── 2. Needs Attention ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Needs Attention</h2>
        </div>
        <div className="dash-alerts-row">
          <div className="dash-alert-card alert-active">
            <ActiveAlertsWidget />
          </div>
          <div className="dash-alert-card alert-pods">
            <PodsAtRiskWidget />
          </div>
        </div>
      </section>

      {/* ── 3. Governance Posture (compliance & operations scorecards) ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Governance Posture</h2>
        </div>
        <div className="dash-scores-grid">
          <div className="dash-score-card score-cis">
            <ScoreWidget
              title="CIS Compliance / Security"
              path="/api/dashboard/security"
              linkTo="audit"
              linkLabel="View in Audit"
              refreshMs={REFRESH.SCAN}
              map={(d) => ({ value: `${d.score}/100`, grade: d.grade, label: `${(d.findings || []).length} findings` })}
            />
          </div>
          <div className="dash-score-card score-gitops">
            <ScoreWidget
              title="GitOps Sync Status"
              path="/api/dashboard/gitops"
              map={(d) => ({ value: `${d.synced}/${d.total}`, label: `${d.outOfSync || 0} out-of-sync · ${d.degraded || 0} degraded` })}
            />
          </div>
          <div className="dash-score-card score-dr">
            <ScoreWidget
              title="DR Readiness"
              path="/api/dashboard/dr"
              map={(d) => ({ value: `${d.score}/100`, grade: d.grade, label: `${d.completed || 0} backups · ${d.failed || 0} failed` })}
            />
          </div>
        </div>
      </section>

      {/* ── 4. Security & Change Risk (side by side) ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Security &amp; Change Risk</h2>
        </div>
        <div className="dash-twin-row">
          <div className="dash-twin-card">
            <ImageVulnsWidget />
          </div>
          <div className="dash-twin-card">
            <AppChangesWidget />
          </div>
        </div>
      </section>

      {/* ── 5. Capacity & Resource Utilization ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Capacity &amp; Resource Utilization</h2>
        </div>
        <CapacityWidget />
      </section>
      <section className="dash-section">
        <ResourceOptimizationWidget />
      </section>

      {/* ── 6. Trends & Topology ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Trends &amp; Topology</h2>
        </div>
        <div className="dash-twin-row">
          <div className="dash-twin-card">
            <HealthTimelineWidget />
          </div>
          <div className="dash-twin-card">
            <NodeTopologyWidget />
          </div>
        </div>
      </section>
      <section className="dash-section">
        <NamespaceHeatmapWidget />
      </section>

      {/* ── 7. Operator Actions (deliberate, last) ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Operator Actions</h2>
        </div>
        <EmergencyActionsWidget />
      </section>
    </div>
  );
}
