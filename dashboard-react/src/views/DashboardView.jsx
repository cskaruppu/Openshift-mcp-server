import { ClusterHealthWidget } from "../components/widgets/ClusterHealthWidget";
import { NodesWidget } from "../components/widgets/NodesWidget";
import { NamespacesWidget } from "../components/widgets/NamespacesWidget";
import { ClusterOperatorsWidget } from "../components/widgets/ClusterOperatorsWidget";
import { ActiveAlertsWidget } from "../components/widgets/ActiveAlertsWidget";
import { PodsAtRiskWidget } from "../components/widgets/PodsAtRiskWidget";
import { ScoreWidget } from "../components/widgets/ScoreWidget";
import { NodeTopologyWidget } from "../components/widgets/NodeTopologyWidget";
import { NamespaceHeatmapWidget } from "../components/widgets/NamespaceHeatmapWidget";
import { RiskPredictionsWidget } from "../components/widgets/RiskPredictionsWidget";
import { AppChangesWidget } from "../components/widgets/AppChangesWidget";
import { MulticlusterWidget } from "../components/widgets/MulticlusterWidget";
import { HealthTimelineWidget } from "../components/widgets/HealthTimelineWidget";
import { EmergencyActionsWidget } from "../components/widgets/EmergencyActionsWidget";
import { AnsibleWidget } from "../components/widgets/AnsibleWidget";

export function DashboardView() {
  return (
    <div className="dash">
      {/* ── Primary Metrics (hero row) ── */}
      <section className="dash-section">
        <div className="dash-hero-row">
          <div className="dash-hero-card hero-health">
            <ClusterHealthWidget />
          </div>
          <div className="dash-hero-card hero-nodes">
            <NodesWidget />
          </div>
          <div className="dash-hero-card hero-ns">
            <NamespacesWidget />
          </div>
          <div className="dash-hero-card hero-ops">
            <ClusterOperatorsWidget />
          </div>
        </div>
      </section>

      {/* ── Alerts & Risk Row ── */}
      <section className="dash-section">
        <div className="dash-alerts-row">
          <div className="dash-alert-card alert-active">
            <ActiveAlertsWidget />
          </div>
          <div className="dash-alert-card alert-pods">
            <PodsAtRiskWidget />
          </div>
        </div>
      </section>

      {/* ── Score Cards Grid ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Compliance & Operations</h2>
        </div>
        <div className="dash-scores-grid">
          <div className="dash-score-card score-cis">
            <ScoreWidget
              title="CIS Compliance / Security"
              path="/api/dashboard/security"
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
          <div className="dash-score-card score-opt">
            <ScoreWidget
              title="Resource Optimization"
              path="/api/dashboard/optimization"
              map={(d) => ({ value: `${d.efficiencyScore}/100`, grade: d.grade, label: `Reclaim ${d.reclaimCpu || 0}m CPU · ${d.reclaimMemGi || 0}Gi` })}
            />
          </div>
          <div className="dash-score-card score-vuln">
            <ScoreWidget
              title="Image Vulnerability Scanner"
              path="/api/dashboard/image-vulns"
              map={(d) => ({ value: `${d.riskScore}/100`, grade: d.grade, label: `${d.critical || 0} critical · ${d.high || 0} high · ${d.totalImages || 0} images` })}
            />
          </div>
          <div className="dash-score-card score-app">
            <ScoreWidget
              title="Application Changes"
              path="/api/dashboard/app-changes"
              map={(d) => ({
                value: `${d.totalChanges ?? 0}`,
                grade: (d.critical ?? 0) > 0 ? "F" : (d.warning ?? 0) > 0 ? "C" : "A",
                label: `${d.critical ?? 0} critical · ${d.trackedWorkloads ?? 0} tracked`,
              })}
            />
          </div>
        </div>
      </section>

      {/* ── Application Change Watcher (full feature) ── */}
      <section className="dash-section">
        <AppChangesWidget />
      </section>

      {/* ── Ansible Automation ── */}
      <section className="dash-section">
        <div className="dash-ansible-row">
          <AnsibleWidget />
        </div>
      </section>

      {/* ── Fleet Overview ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Fleet & Infrastructure</h2>
        </div>
        <MulticlusterWidget />
      </section>

      {/* ── Health & Topology (side by side) ── */}
      <section className="dash-section">
        <div className="dash-twin-row">
          <div className="dash-twin-card">
            <HealthTimelineWidget />
          </div>
          <div className="dash-twin-card">
            <NodeTopologyWidget />
          </div>
        </div>
      </section>

      {/* ── Namespace Heatmap ── */}
      <section className="dash-section">
        <NamespaceHeatmapWidget />
      </section>

      {/* ── AI Risk Predictions ── */}
      <section className="dash-section">
        <RiskPredictionsWidget />
      </section>

      {/* ── Emergency Actions ── */}
      <section className="dash-section">
        <EmergencyActionsWidget />
      </section>
    </div>
  );
}
