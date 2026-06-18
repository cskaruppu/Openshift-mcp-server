import { useState, useRef, useCallback, useEffect } from "react";
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

function FocusableWidget({ children, label }) {
  const ref = useRef(null);
  const [focused, setFocused] = useState(false);

  const open = useCallback(() => {
    setFocused(true);
    document.body.style.overflow = "hidden";
  }, []);

  const close = useCallback(() => {
    setFocused(false);
    document.body.style.overflow = "";
  }, []);

  useEffect(() => {
    if (!focused) return;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, close]);

  return (
    <>
      <div ref={ref} className={"dash-focusable" + (focused ? " is-focused" : "")}>
        <button className="dash-focus-btn" onClick={open} title={`Expand ${label || "widget"}`}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M6 1H1v5M15 10v5h-5M10 1h5v5M1 10v5h5" />
          </svg>
        </button>
        {children}
      </div>
      {focused && (
        <div className="dash-spotlight-overlay" onClick={close}>
          <div className="dash-spotlight-content" onClick={e => e.stopPropagation()}>
            <div className="dash-spotlight-header">
              <span className="dash-spotlight-label">{label}</span>
              <button className="dash-spotlight-close" onClick={close}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 4L4 12M4 4l8 8" />
                </svg>
              </button>
            </div>
            <div className="dash-spotlight-body">
              {children}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

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
            <FocusableWidget label="Cluster Health"><ClusterHealthWidget /></FocusableWidget>
          </div>
          <div className="dash-hero-card hero-nodes">
            <FocusableWidget label="Nodes"><NodesWidget /></FocusableWidget>
          </div>
          <div className="dash-hero-card hero-pods">
            <FocusableWidget label="Pods"><PodsWidget /></FocusableWidget>
          </div>
          <div className="dash-hero-card hero-ns">
            <FocusableWidget label="Namespaces"><NamespacesWidget /></FocusableWidget>
          </div>
          <div className="dash-hero-card hero-ops">
            <FocusableWidget label="Cluster Operators"><ClusterOperatorsWidget /></FocusableWidget>
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
            <FocusableWidget label="Active Alerts"><ActiveAlertsWidget /></FocusableWidget>
          </div>
          <div className="dash-alert-card alert-pods">
            <FocusableWidget label="Pods at Risk"><PodsAtRiskWidget /></FocusableWidget>
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
            <FocusableWidget label="CIS Compliance">
            <ScoreWidget
              title="CIS Compliance / Security"
              path="/api/dashboard/security"
              linkTo="audit"
              linkLabel="View in Audit"
              refreshMs={REFRESH.SCAN}
              map={(d) => ({ value: `${d.score}/100`, grade: d.grade, label: `${(d.findings || []).length} findings` })}
            />
            </FocusableWidget>
          </div>
          <div className="dash-score-card score-gitops">
            <FocusableWidget label="GitOps Sync">
            <ScoreWidget
              title="GitOps Sync Status"
              path="/api/dashboard/gitops"
              map={(d) => ({ value: `${d.synced}/${d.total}`, label: `${d.outOfSync || 0} out-of-sync · ${d.degraded || 0} degraded` })}
            />
            </FocusableWidget>
          </div>
          <div className="dash-score-card score-dr">
            <FocusableWidget label="DR Readiness">
            <ScoreWidget
              title="DR Readiness"
              path="/api/dashboard/dr"
              map={(d) => ({ value: `${d.score}/100`, grade: d.grade, label: `${d.completed || 0} backups · ${d.failed || 0} failed` })}
            />
            </FocusableWidget>
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
            <FocusableWidget label="Image Vulnerabilities"><ImageVulnsWidget /></FocusableWidget>
          </div>
          <div className="dash-twin-card">
            <FocusableWidget label="Application Change Watcher"><AppChangesWidget /></FocusableWidget>
          </div>
        </div>
      </section>

      {/* ── 5. Capacity & Resource Utilization ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Capacity &amp; Resource Utilization</h2>
        </div>
        <FocusableWidget label="Capacity"><CapacityWidget /></FocusableWidget>
      </section>
      <section className="dash-section">
        <FocusableWidget label="Resource Optimization"><ResourceOptimizationWidget /></FocusableWidget>
      </section>

      {/* ── 6. Trends & Topology ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Trends &amp; Topology</h2>
        </div>
        <div className="dash-twin-row">
          <div className="dash-twin-card">
            <FocusableWidget label="Health Timeline"><HealthTimelineWidget /></FocusableWidget>
          </div>
          <div className="dash-twin-card">
            <FocusableWidget label="Node Topology"><NodeTopologyWidget /></FocusableWidget>
          </div>
        </div>
      </section>
      <section className="dash-section">
        <FocusableWidget label="Namespace Heatmap"><NamespaceHeatmapWidget /></FocusableWidget>
      </section>

      {/* ── 7. Operator Actions (deliberate, last) ── */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Operator Actions</h2>
        </div>
        <FocusableWidget label="Emergency Actions"><EmergencyActionsWidget /></FocusableWidget>
      </section>
    </div>
  );
}
