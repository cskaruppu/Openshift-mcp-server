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
    <div className="dashboard-grid">
      {/* Every widget is scoped to the active cluster via useClusterQuery. */}
      <ClusterHealthWidget />
      <NodesWidget />
      <NamespacesWidget />
      <ClusterOperatorsWidget />
      <ActiveAlertsWidget />
      <PodsAtRiskWidget />

      <ScoreWidget
        title="CIS Compliance / Security"
        path="/api/dashboard/security"
        map={(d) => ({ value: `${d.score}/100`, grade: d.grade, label: `${(d.findings || []).length} findings` })}
      />
      <ScoreWidget
        title="GitOps Sync Status"
        path="/api/dashboard/gitops"
        map={(d) => ({ value: `${d.synced}/${d.total}`, label: `${d.outOfSync || 0} out-of-sync · ${d.degraded || 0} degraded` })}
      />
      <ScoreWidget
        title="DR Readiness"
        path="/api/dashboard/dr"
        map={(d) => ({ value: `${d.score}/100`, grade: d.grade, label: `${d.completed || 0} backups · ${d.failed || 0} failed` })}
      />
      <ScoreWidget
        title="Resource Optimization"
        path="/api/dashboard/optimization"
        map={(d) => ({ value: `${d.efficiencyScore}/100`, grade: d.grade, label: `Reclaim ${d.reclaimCpu || 0}m CPU · ${d.reclaimMemGi || 0}Gi` })}
      />
      <ScoreWidget
        title="Image Vulnerability Scanner"
        path="/api/dashboard/image-vulns"
        map={(d) => ({ value: `${d.riskScore}/100`, grade: d.grade, label: `${d.critical || 0} critical · ${d.high || 0} high · ${d.totalImages || 0} images` })}
      />
      <AppChangesWidget />
      <AnsibleWidget />

      {/* Full-width widgets */}
      <MulticlusterWidget />
      <HealthTimelineWidget />
      <NodeTopologyWidget />
      <NamespaceHeatmapWidget />
      <RiskPredictionsWidget />
      <EmergencyActionsWidget />
    </div>
  );
}
