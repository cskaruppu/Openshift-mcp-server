import { useState, useEffect, useCallback, useRef } from "react";
import { useClusterQuery } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";
import { showToast } from "../../store/toastStore";

function clusterUrl(path, cluster) {
  if (!cluster || cluster === "local") return path;
  return `${path}${path.includes("?") ? "&" : "?"}cluster=${encodeURIComponent(cluster)}`;
}

const CHANGE_ICONS = {
  "image-update": { icon: "\u{1F4E6}", color: "#ef4444", label: "Image" },
  "config-change": { icon: "\u{1F527}", color: "#f59e0b", label: "Config" },
  scale: { icon: "\u{2696}", color: "#3b82f6", label: "Scale" },
  "resource-tune": { icon: "\u{1F4CA}", color: "#8b5cf6", label: "Resource" },
  other: { icon: "\u{1F504}", color: "#6b7280", label: "Other" },
};

function relTime(iso) {
  if (!iso) return "--";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function AppChangesWidget() {
  const cluster = useActiveCluster();
  const { data, isLoading, isError, error, refetch } = useClusterQuery(
    "/api/dashboard/app-changes",
    { refetchInterval: 5_000, staleTime: 3_000 }
  );
  const [nsPanelOpen, setNsPanelOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [expandedChange, setExpandedChange] = useState(null);
  const [workloadsOpen, setWorkloadsOpen] = useState(false);
  const [filterType, setFilterType] = useState("all");
  const [filterRisk, setFilterRisk] = useState("all");
  const [bulkRunning, setBulkRunning] = useState(false);
  const [optimisticNs, setOptimisticNs] = useState(null);
  const [removedIds, setRemovedIds] = useState(new Set());
  const [actionFeedback, setActionFeedback] = useState(null);

  const unavailable = data && data.available === false;
  const watched = data?.watchedNamespaces || [];
  const effectiveWatched = optimisticNs !== null ? optimisticNs : watched;
  const tracked = data?.trackedWorkloads ?? 0;
  const changes = data?.recentChanges || [];
  const timeline = data?.timelineStats || {};
  const history = data?.changeHistory || [];
  const gitops = data?.gitopsDrift || {};

  useEffect(() => {
    if (optimisticNs === null) return;
    const serverSet = new Set(watched);
    const optSet = new Set(optimisticNs);
    if (serverSet.size === optSet.size && [...optSet].every(ns => serverSet.has(ns))) {
      setOptimisticNs(null);
    }
  }, [watched, optimisticNs]);

  const handleNsUpdate = useCallback((trackedList) => {
    if (Array.isArray(trackedList)) setOptimisticNs(trackedList);
    refetch();
  }, [refetch]);

  const handlePanelClose = useCallback(() => {
    setNsPanelOpen(false);
    refetch();
  }, [refetch]);

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await fetch(clusterUrl("/api/dashboard/app-changes/scan", cluster), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Cluster-Context": cluster || "local" },
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) {
        showToast(`Scan: ${d.error}`, "err");
      } else {
        showToast(`Scan complete: ${d.newChanges ?? 0} new, ${d.pendingChanges ?? 0} pending`, "ok");
      }
      setRemovedIds(new Set());
      refetch();
    } catch (err) {
      showToast("Scan failed: " + err.message, "err");
    } finally {
      setScanning(false);
    }
  };

  const handleAction = async (changeId, action, changeInfo) => {
    setRemovedIds(prev => { const next = new Set(prev); next.add(changeId); return next; });
    if (expandedChange === changeId) setExpandedChange(null);

    const labels = {
      agree: { verb: "Agreed", detail: changeInfo ? `${changeInfo.kind}/${changeInfo.name} — baseline updated to current state` : "Change accepted" },
      dismiss: { verb: "Rolling back", detail: changeInfo ? `${changeInfo.kind}/${changeInfo.name} — reverting to previous baseline` : "Rollback initiated" },
      acknowledge: { verb: "Acknowledged", detail: changeInfo ? `${changeInfo.kind}/${changeInfo.name} — cleared from queue` : "Change cleared" },
    };
    const label = labels[action] || { verb: action, detail: "" };

    if (action === "dismiss" && changeInfo) {
      setActionFeedback({
        action: "dismiss",
        kind: changeInfo.kind,
        name: changeInfo.name,
        namespace: changeInfo.namespace,
        rollbackPreview: changeInfo.rollbackPreview,
      });
      setTimeout(() => setActionFeedback(null), 4000);
    }

    showToast(`${label.verb}: ${label.detail}`, "ok");

    try {
      const res = await fetch(clusterUrl("/api/dashboard/app-changes/action", cluster), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Cluster-Context": cluster || "local" },
        body: JSON.stringify({ changeId, action }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) {
        showToast(d.error || `${action} failed — restoring card`, "err");
        setRemovedIds(prev => { const next = new Set(prev); next.delete(changeId); return next; });
      }
      refetch();
    } catch (err) {
      showToast(`Action failed: ${err.message} — restoring card`, "err");
      setRemovedIds(prev => { const next = new Set(prev); next.delete(changeId); return next; });
    }
  };

  useEffect(() => {
    if (removedIds.size === 0) return;
    const serverIds = new Set((data?.recentChanges || []).map(c => c.id));
    const stillRelevant = new Set([...removedIds].filter(id => serverIds.has(id)));
    if (stillRelevant.size < removedIds.size) setRemovedIds(stillRelevant);
  }, [data, removedIds]);

  const handleBulkAction = async (action) => {
    setBulkRunning(true);
    const affectedIds = filteredChanges.map(c => c.id);
    setRemovedIds(prev => { const next = new Set(prev); for (const id of affectedIds) next.add(id); return next; });
    showToast(`Bulk ${action}: ${affectedIds.length} changes processing...`, "ok");
    try {
      const filter = {};
      if (filterType !== "all") filter.changeType = filterType;
      if (filterRisk !== "all") filter.riskLevel = filterRisk;
      const res = await fetch(clusterUrl("/api/dashboard/app-changes/bulk-action", cluster), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Cluster-Context": cluster || "local" },
        body: JSON.stringify({ action, filter }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) {
        showToast(d.message || `Bulk ${action} failed`, "err");
        setRemovedIds(new Set());
      } else {
        showToast(d.message || `Bulk ${action}: ${affectedIds.length} changes resolved`, "ok");
      }
      refetch();
    } catch (err) {
      showToast("Bulk action failed: " + err.message, "err");
      setRemovedIds(new Set());
    } finally {
      setBulkRunning(false);
    }
  };

  const visibleChanges = (data?.recentChanges || []).filter(c => !removedIds.has(c.id));
  const filteredChanges = visibleChanges.filter(c => {
    if (filterType !== "all" && c.changeType !== filterType) return false;
    if (filterRisk !== "all" && c.riskLevel !== filterRisk) return false;
    return true;
  });

  const total = visibleChanges.length;
  const critical = visibleChanges.filter(c => c.severity === "critical").length;
  const warning = visibleChanges.filter(c => c.severity === "warning").length;
  const changeTypes = {};
  for (const c of visibleChanges) { const t = c.changeType || "other"; changeTypes[t] = (changeTypes[t] || 0) + 1; }

  if (isLoading) {
    return (
      <div className="acw">
        <div className="acw-header"><h3>Application Change Watcher</h3></div>
        <div className="acw-loading">Loading…</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="acw">
        <div className="acw-header"><h3>Application Change Watcher</h3></div>
        <div className="acw-error">{String(error?.message)}</div>
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="acw">
        <div className="acw-header"><h3>Application Change Watcher</h3></div>
        <div className="acw-unavailable">{data.message || "Not available for remote clusters"}</div>
      </div>
    );
  }

  const hasNamespaces = effectiveWatched.length > 0;
  const nsHealth = data?.namespaceHealth || {};

  const groupedChanges = (() => {
    if (filteredChanges.length === 0) return [];
    const now = Date.now();
    const groups = [
      { label: "Last 1 Hour", max: 3600000, items: [] },
      { label: "Last 6 Hours", max: 21600000, items: [] },
      { label: "Last 24 Hours", max: 86400000, items: [] },
      { label: "Older", max: Infinity, items: [] },
    ];
    for (const c of filteredChanges) {
      const age = now - new Date(c.timestamp || c.detectedAt).getTime();
      const g = groups.find(g => age < g.max);
      if (g) g.items.push(c);
    }
    return groups.filter(g => g.items.length > 0);
  })();

  return (
    <div className="acw">
      {/* Header */}
      <div className="acw-header">
        <h3>
          <span className="acw-icon">{"\u{1F50D}"}</span>
          Application Change Watcher
        </h3>
        <div className="acw-header-actions">
          {hasNamespaces && (
            <button className="acw-scan-btn" onClick={handleScan} disabled={scanning}>
              {scanning ? "Scanning…" : "Scan Now"}
            </button>
          )}
          <button
            className={"acw-ns-btn" + (hasNamespaces ? "" : " empty")}
            onClick={() => setNsPanelOpen(!nsPanelOpen)}
          >
            {hasNamespaces ? `${effectiveWatched.length} Namespace${effectiveWatched.length > 1 ? "s" : ""}` : "Select Namespaces"}
          </button>
        </div>
      </div>

      {/* Namespace Manager Panel */}
      {nsPanelOpen && (
        <NamespaceManager
          cluster={cluster}
          watched={effectiveWatched}
          onClose={handlePanelClose}
          onUpdate={handleNsUpdate}
        />
      )}

      {/* Empty State — no namespaces tracked */}
      {!hasNamespaces && !nsPanelOpen && (
        <div className="acw-empty-state">
          <div className="acw-empty-icon">{"\u{1F4E1}"}</div>
          <div className="acw-empty-title">No Namespaces Tracked</div>
          <div className="acw-empty-desc">
            Select namespaces to begin monitoring application changes in real-time.
            Track deployments, config changes, scaling events, and image updates across your workloads.
          </div>
          <button className="acw-empty-btn" onClick={() => setNsPanelOpen(true)}>
            {"\u{2795}"} Add Namespaces to Track
          </button>
        </div>
      )}

      {/* Main content — only when namespaces are tracked */}
      {hasNamespaces && (
        <>
          {/* Namespace Health Summary Bar */}
          {Object.keys(nsHealth).length > 0 && (
            <div className="acw-ns-health">
              {Object.entries(nsHealth).map(([ns, h]) => {
                const nsChanges = visibleChanges.filter(c => c.namespace === ns).length;
                const nsHighRisk = visibleChanges.filter(c => c.namespace === ns && (c.riskLevel === "critical" || c.riskLevel === "high")).length;
                return (
                  <div key={ns} className="acw-ns-health-item">
                    <span className="acw-ns-health-name">{ns}</span>
                    <span className="acw-ns-health-stat">{h.deployments} Dep</span>
                    <span className="acw-ns-health-stat">{h.statefulsets} Sts</span>
                    <span className="acw-ns-health-stat">{h.runningPods}/{h.pods} Po</span>
                    {nsChanges > 0 && (
                      <span className={"acw-ns-health-changes" + (nsHighRisk > 0 ? " high" : "")}>
                        {nsChanges} change{nsChanges !== 1 ? "s" : ""}{nsHighRisk > 0 ? ` (${nsHighRisk} high risk)` : ""}
                      </span>
                    )}
                    {nsChanges === 0 && <span className="acw-ns-health-clean">{"✓"} Clean</span>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Summary Row */}
          <div className="acw-summary">
            <div className="acw-ring" onClick={() => setWorkloadsOpen(!workloadsOpen)} title="View tracked workloads">
              <svg viewBox="0 0 60 60" width="56" height="56">
                <circle cx="30" cy="30" r="26" fill="none" stroke="var(--border)" strokeWidth="4" />
                <circle
                  cx="30" cy="30" r="26" fill="none"
                  stroke={critical > 0 ? "var(--crit)" : warning > 0 ? "var(--warn)" : "var(--ok)"}
                  strokeWidth="4"
                  strokeDasharray={`${Math.min(1, tracked > 0 ? 1 : 0) * 163.4} 163.4`}
                  strokeLinecap="round"
                  transform="rotate(-90 30 30)"
                />
                <text x="30" y="34" textAnchor="middle" fill="var(--text)" fontSize="16" fontWeight="800">{tracked}</text>
              </svg>
              <div className="acw-ring-label">
                <div className="acw-ring-title">Tracked Workloads</div>
                <div className="acw-ring-sub">{effectiveWatched.join(", ") || "none"}</div>
              </div>
            </div>
            <div className="acw-changes-count">
              <div className={"acw-change-num " + (critical > 0 ? "crit" : warning > 0 ? "warn" : "ok")}>{total}</div>
              <div className="acw-change-lbl">Changes</div>
            </div>
          </div>

          {/* Workloads detail (collapsible) */}
          {workloadsOpen && <WorkloadsViewer cluster={cluster} />}

          {/* Change Type Breakdown — mini donut + pills */}
          {Object.keys(changeTypes).length > 0 && (
            <div className="acw-types">
              <MiniDonut changeTypes={changeTypes} total={total} />
              <div className="acw-type-pills">
                {Object.entries(changeTypes).map(([type, count]) => {
                  const info = CHANGE_ICONS[type] || CHANGE_ICONS.other;
                  return (
                    <div key={type} className="acw-type-pill" style={{ borderColor: info.color }}>
                      <span>{info.icon}</span>
                      <span>{info.label}</span>
                      <span className="acw-type-count" style={{ background: info.color }}>{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 24h Velocity Bar */}
          {timeline.hourlyBuckets?.length > 0 && (
            <VelocityBar buckets={timeline.hourlyBuckets} />
          )}

          {/* Changes List */}
          {filteredChanges.length > 0 && (
            <div className="acw-changes">
              <div className="acw-changes-title">Pending Changes</div>

              {/* Filter Bar */}
              <div className="acw-filter-bar">
                {[["all", "All"], ["image-update", "Image"], ["config-change", "Config"], ["scale", "Scale"], ["resource-tune", "Resource"]].map(([k, l]) => (
                  <button key={k} className={"acw-filter-chip" + (filterType === k ? " active" : "")} onClick={() => setFilterType(k)}>{l}</button>
                ))}
                <span style={{ width: 1, height: 16, background: "var(--border)", margin: "0 2px" }} />
                {[["all", "All Risk"], ["critical", "Critical"], ["high", "High"], ["medium", "Med"], ["low", "Low"]].map(([k, l]) => (
                  <button key={k} className={"acw-filter-chip" + (filterRisk === k ? " active" : "")} onClick={() => setFilterRisk(k)}>{l}</button>
                ))}
              </div>

              {/* Bulk Actions */}
              {filteredChanges.length > 1 && (
                <div className="acw-bulk-bar">
                  <span className="acw-bulk-label">Bulk</span>
                  <button className="acw-bulk-btn agree" disabled={bulkRunning} onClick={() => handleBulkAction("agree")}>Agree All</button>
                  <button className="acw-bulk-btn ack" disabled={bulkRunning} onClick={() => handleBulkAction("acknowledge")}>Ack All</button>
                  <button className="acw-bulk-btn dismiss" disabled={bulkRunning} onClick={() => handleBulkAction("dismiss")}>Dismiss All</button>
                  <span className="acw-bulk-count">{filteredChanges.length} changes</span>
                </div>
              )}

              {/* Time-grouped changes */}
              {groupedChanges.map((group) => (
                <div key={group.label} className="acw-time-group">
                  <div className="acw-time-group-header">
                    <span className="acw-time-group-line" />
                    <span className="acw-time-group-label">{group.label}</span>
                    <span className="acw-time-group-count">{group.items.length}</span>
                    <span className="acw-time-group-line" />
                  </div>
                  {group.items.map((c) => (
                    <ChangeCard
                      key={c.id}
                      change={c}
                      expanded={expandedChange === c.id}
                      onToggle={() => setExpandedChange(expandedChange === c.id ? null : c.id)}
                      onAction={handleAction}
                      cluster={cluster}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* No changes — clean state */}
          {filteredChanges.length === 0 && (
            <div className="acw-clean-state">
              <span className="acw-clean-icon">{"✅"}</span>
              <span className="acw-clean-text">No pending changes detected across {effectiveWatched.length} tracked namespace{effectiveWatched.length > 1 ? "s" : ""}</span>
            </div>
          )}

          {/* GitOps Drift */}
          {gitops.argoInstalled && (
            <div className="acw-gitops">
              <div className="acw-gitops-title">GitOps Drift</div>
              <div className="acw-gitops-stats">
                <span className="acw-gitops-stat ok">{gitops.synced || 0} synced</span>
                <span className="acw-gitops-stat warn">{gitops.drifted || 0} drifted</span>
              </div>
              {(gitops.apps || []).slice(0, 5).map((app) => (
                <div key={app.name} className="acw-gitops-app">
                  <span className={"acw-gitops-dot " + (app.isDrifted ? "warn" : "ok")} />
                  <span>{app.name}</span>
                  <span className="acw-gitops-sync">{app.syncStatus}</span>
                </div>
              ))}
            </div>
          )}

          {/* Recent History */}
          {history.length > 0 && (
            <div className="acw-history">
              <div className="acw-history-title">Recent Actions</div>
              {history.slice(0, 5).map((h, i) => (
                <div key={i} className="acw-history-item">
                  <span className={"acw-action-badge " + h.action}>{h.action}</span>
                  <span>{h.kind}/{h.name}</span>
                  <span className="acw-history-time">{relTime(h.resolvedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Action Feedback — rollback details slide-in */}
      {actionFeedback && actionFeedback.action === "dismiss" && (
        <div className="acw-action-feedback" onClick={() => setActionFeedback(null)}>
          <div className="acw-feedback-icon">{"↩️"}</div>
          <div className="acw-feedback-body">
            <div className="acw-feedback-title">Rollback Initiated</div>
            <div className="acw-feedback-detail">
              <strong>{actionFeedback.kind}/{actionFeedback.name}</strong> in <strong>{actionFeedback.namespace}</strong> is reverting to baseline
            </div>
            {actionFeedback.rollbackPreview && (
              <div className="acw-feedback-preview">
                Replicas: {actionFeedback.rollbackPreview.replicas}
                {(actionFeedback.rollbackPreview.containers || []).map((ct, i) => (
                  <span key={i}> · {ct.name}: {ct.image}</span>
                ))}
              </div>
            )}
          </div>
          <div className="acw-feedback-progress" />
        </div>
      )}
    </div>
  );
}

/* ── Namespace Manager with AI Recommendations ── */
function NamespaceManager({ cluster, watched, onClose, onUpdate }) {
  const [allNs, setAllNs] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [trackedNs, setTrackedNs] = useState([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedAvail, setSelectedAvail] = useState(new Set());
  const [selectedTracked, setSelectedTracked] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [showRecs, setShowRecs] = useState(true);
  const lastClickAvail = useRef(null);
  const lastClickTracked = useRef(null);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch(clusterUrl("/api/dashboard/app-changes", cluster));
      const d = await res.json();
      const discovered = d.discoveredNamespaces || [];
      const watchedSet = new Set(d.watchedNamespaces || watched || []);
      setAllNs(discovered);
      setTrackedNs([...watchedSet]);
      if (d.nsRecommendations) setRecommendations(d.nsRecommendations);
    } catch {
      setAllNs([]);
      setTrackedNs([...watched]);
    } finally {
      setLoading(false);
    }
  }, [watched, cluster]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const timer = setInterval(loadData, 30_000);
    return () => clearInterval(timer);
  }, [loadData]);

  const trackedSet = new Set(trackedNs);
  const availableNs = allNs
    .filter((n) => !trackedSet.has(n.namespace))
    .filter((n) => !search || n.namespace.toLowerCase().includes(search.toLowerCase()))
    .filter((n) => filter === "all" || filter === "recommended" || (n.workloads || 0) > 0);

  const recMap = Object.fromEntries(recommendations.filter(r => !trackedSet.has(r.namespace)).map(r => [r.namespace, r]));
  const highRecs = recommendations.filter(r => r.recommendation === "high" && !trackedSet.has(r.namespace));

  const handleSelect = (ns, side, e) => {
    const setFn = side === "avail" ? setSelectedAvail : setSelectedTracked;
    const lastRef = side === "avail" ? lastClickAvail : lastClickTracked;
    const list = side === "avail" ? availableNs.map((n) => n.namespace) : trackedNs;

    setFn((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && lastRef.current) {
        const start = list.indexOf(lastRef.current);
        const end = list.indexOf(ns);
        if (start >= 0 && end >= 0) {
          const [lo, hi] = start < end ? [start, end] : [end, start];
          for (let i = lo; i <= hi; i++) next.add(list[i]);
          return next;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        next.has(ns) ? next.delete(ns) : next.add(ns);
      } else {
        next.clear();
        next.add(ns);
      }
      lastRef.current = ns;
      return next;
    });
  };

  const transfer = async (namespaces, action) => {
    try {
      await fetch(clusterUrl("/api/dashboard/app-changes/namespaces", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, namespaces }),
      });
      showToast(`${namespaces.length} namespace(s) ${action === "add" ? "tracked" : "removed"}`, "ok");
      setSelectedAvail(new Set());
      setSelectedTracked(new Set());
      const newTracked = action === "add"
        ? [...new Set([...trackedNs, ...namespaces])]
        : trackedNs.filter(ns => !namespaces.includes(ns));
      setTrackedNs(newTracked);
      onUpdate(newTracked);
      loadData();
    } catch (err) {
      showToast("Transfer failed: " + err.message, "err");
    }
  };

  const trackSelected = () => transfer([...selectedAvail], "add");
  const untrackSelected = () => transfer([...selectedTracked], "remove");
  const trackAll = () => transfer(availableNs.map((n) => n.namespace), "add");
  const removeAll = () => transfer([...trackedNs], "remove");
  const trackRecommended = () => transfer(highRecs.map(r => r.namespace), "add");

  const handleDrop = (e, side) => {
    e.preventDefault();
    e.currentTarget.classList.remove("acw-drop-active");
    try {
      const ns = JSON.parse(e.dataTransfer.getData("text/plain"));
      if (side === "tracked" && Array.isArray(ns)) transfer(ns, "add");
      else if (side === "avail" && Array.isArray(ns)) transfer(ns, "remove");
    } catch {}
  };

  const handleDragStart = (e, ns, side) => {
    const sel = side === "avail" ? selectedAvail : selectedTracked;
    const items = sel.has(ns) ? [...sel] : [ns];
    e.dataTransfer.setData("text/plain", JSON.stringify(items));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.currentTarget.classList.add("acw-drop-active");
  };

  const handleDragLeave = (e) => {
    e.currentTarget.classList.remove("acw-drop-active");
  };

  const quickTransfer = (ns, side) => {
    transfer([ns], side === "avail" ? "add" : "remove");
  };

  return (
    <div className="acw-ns-panel">
      <div className="acw-ns-header">
        <div className="acw-ns-title">
          Manage Namespaces
          <span className="acw-live-dot" />
          <span className="acw-live-label">LIVE</span>
        </div>
        <div className="acw-ns-actions">
          <button className="acw-ns-track-all" onClick={trackAll}>Track All &raquo;</button>
          <button className="acw-ns-remove-all" onClick={removeAll}>&laquo; Remove All</button>
          <button className="acw-ns-close" onClick={onClose}>&times;</button>
        </div>
      </div>

      {/* AI Recommendations Banner */}
      {highRecs.length > 0 && showRecs && (
        <div className="acw-ai-recs">
          <div className="acw-ai-recs-header">
            <span className="acw-ai-recs-icon">{"\u{1F9E0}"}</span>
            <span className="acw-ai-recs-title">AI Recommended</span>
            <span className="acw-ai-recs-count">{highRecs.length} namespace{highRecs.length > 1 ? "s" : ""}</span>
            <button className="acw-ai-recs-dismiss" onClick={() => setShowRecs(false)} title="Dismiss">{"×"}</button>
          </div>
          <div className="acw-ai-recs-list">
            {highRecs.slice(0, 4).map(r => (
              <div key={r.namespace} className="acw-ai-rec-item" onClick={() => transfer([r.namespace], "add")}>
                <div className="acw-ai-rec-name">{r.namespace}</div>
                <div className="acw-ai-rec-reason">{r.aiSummary}</div>
                <div className="acw-ai-rec-score">
                  <span className="acw-ai-rec-bar" style={{ width: `${r.score}%` }} />
                </div>
              </div>
            ))}
          </div>
          {highRecs.length > 1 && (
            <button className="acw-ai-recs-track-btn" onClick={trackRecommended}>
              {"\u{2795}"} Track All {highRecs.length} Recommended
            </button>
          )}
        </div>
      )}

      <div className="acw-ns-search-row">
        <input
          className="acw-ns-search"
          placeholder="Search namespaces..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="acw-ns-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All</option>
          <option value="workloads">With Workloads</option>
          <option value="recommended">AI Recommended</option>
        </select>
      </div>
      <div className="acw-ns-transfer">
        {/* Available */}
        <div
          className="acw-ns-list-panel"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, "avail")}
        >
          <div className="acw-ns-list-head">
            <span>Available</span>
            <span className="acw-ns-count">{availableNs.length}</span>
          </div>
          <div className="acw-ns-list">
            {loading ? <div className="acw-ns-loading">Loading…</div> : availableNs.map((n) => {
              const rec = recMap[n.namespace];
              return (
                <div
                  key={n.namespace}
                  className={"acw-ns-item" + (selectedAvail.has(n.namespace) ? " selected" : "") + (rec?.recommendation === "high" ? " recommended" : "")}
                  draggable
                  onClick={(e) => handleSelect(n.namespace, "avail", e)}
                  onDragStart={(e) => handleDragStart(e, n.namespace, "avail")}
                  onDoubleClick={() => quickTransfer(n.namespace, "avail")}
                >
                  <span className="acw-ns-dot" />
                  <span className="acw-ns-name">{n.namespace}</span>
                  {rec?.recommendation === "high" && <span className="acw-ns-rec-badge">AI</span>}
                  {n.breakdown && (
                    <span className="acw-ns-badges">
                      {n.breakdown.deployments > 0 && <span className="acw-wb dep">{n.breakdown.deployments} Dep</span>}
                      {n.breakdown.statefulsets > 0 && <span className="acw-wb sts">{n.breakdown.statefulsets} Sts</span>}
                      {n.breakdown.daemonsets > 0 && <span className="acw-wb ds">{n.breakdown.daemonsets} Ds</span>}
                      {n.breakdown.pods > 0 && <span className="acw-wb po">{n.breakdown.pods} Po</span>}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Transfer Buttons */}
        <div className="acw-ns-arrows">
          <button className="acw-arrow-btn" onClick={trackSelected} disabled={selectedAvail.size === 0} title="Track selected">&raquo;</button>
          <button className="acw-arrow-btn" onClick={untrackSelected} disabled={selectedTracked.size === 0} title="Untrack selected">&laquo;</button>
        </div>

        {/* Tracked */}
        <div
          className="acw-ns-list-panel tracked"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, "tracked")}
        >
          <div className="acw-ns-list-head">
            <span>Tracked</span>
            <span className="acw-ns-count">{trackedNs.length}</span>
          </div>
          <div className="acw-ns-list">
            {trackedNs.map((ns) => (
              <div
                key={ns}
                className={"acw-ns-item" + (selectedTracked.has(ns) ? " selected" : "")}
                draggable
                onClick={(e) => handleSelect(ns, "tracked", e)}
                onDragStart={(e) => handleDragStart(e, ns, "tracked")}
                onDoubleClick={() => quickTransfer(ns, "tracked")}
              >
                <span className="acw-ns-dot tracked" />
                <span className="acw-ns-name">{ns}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="acw-ns-hints">
        Click to select · Shift+click for range · Drag &amp; drop to transfer · Double-click to quick transfer
      </div>
    </div>
  );
}

/* ── Workloads Viewer ── */
function WorkloadsViewer({ cluster }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(clusterUrl("/api/dashboard/app-changes/workloads", cluster))
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="acw-workloads-loading">Loading workloads…</div>;
  if (!data?.namespaces) return null;

  return (
    <div className="acw-workloads">
      {Object.entries(data.namespaces).map(([ns, workloads]) => (
        <div key={ns} className="acw-wl-ns">
          <div className="acw-wl-ns-title">{ns}</div>
          <div className="acw-wl-list">
            {(workloads || []).map((w, i) => (
              <div key={i} className="acw-wl-item">
                <span className="acw-wl-kind">{w.kind}</span>
                <span className="acw-wl-name">{w.name}</span>
                <span className="acw-wl-replicas">{w.replicas ?? "--"} replicas</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Velocity Bar ── */
function VelocityBar({ buckets }) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <div className="acw-velocity">
      <div className="acw-velocity-title">24h Change Velocity</div>
      <div className="acw-velocity-bars">
        {buckets.map((b, i) => (
          <div key={i} className="acw-vel-col" title={`${String(b.hour).padStart(2, "0")}:00 — ${b.total} change(s)`}>
            <div
              className="acw-vel-bar"
              style={{
                height: `${(b.total / max) * 100}%`,
                background: b.critical > 0 ? "var(--crit)" : b.warning > 0 ? "var(--warn)" : "var(--ok)",
              }}
            />
            {i % 6 === 0 && <span className="acw-vel-lbl">{String(b.hour).padStart(2, "0")}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Mini Donut Chart ── */
function MiniDonut({ changeTypes, total }) {
  const types = Object.entries(changeTypes);
  if (types.length === 0 || total === 0) return null;
  const r = 18, cx = 24, cy = 24, circumference = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg viewBox="0 0 48 48" width="44" height="44" className="acw-mini-donut">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth="6" />
      {types.map(([type, count]) => {
        const info = CHANGE_ICONS[type] || CHANGE_ICONS.other;
        const pct = count / total;
        const dash = pct * circumference;
        const seg = (
          <circle key={type} cx={cx} cy={cy} r={r} fill="none"
            stroke={info.color} strokeWidth="6"
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        );
        offset += dash;
        return seg;
      })}
      <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fill="var(--text)" fontSize="11" fontWeight="800">{total}</text>
    </svg>
  );
}

/* ── Change Card with AI Intelligence ── */
function ChangeCard({ change, expanded, onToggle, onAction, cluster }) {
  const c = change;
  const typeInfo = CHANGE_ICONS[c.changeType] || CHANGE_ICONS.other;
  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [timelineData, setTimelineData] = useState(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const correlated = c.correlatedWith || [];

  const handleAnalyze = async () => {
    setAiLoading(true);
    try {
      const res = await fetch(clusterUrl("/api/dashboard/app-changes/analyze", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeId: c.id }),
      });
      const d = await res.json().catch(() => ({}));
      setAiAnalysis(d.analysis || d.error || "Analysis unavailable");
    } catch (err) {
      setAiAnalysis("Failed: " + err.message);
    } finally {
      setAiLoading(false);
    }
  };

  const loadTimeline = async () => {
    if (timelineData) { setShowTimeline(!showTimeline); return; }
    try {
      const res = await fetch(clusterUrl(`/api/dashboard/app-changes/timeline?namespace=${encodeURIComponent(c.namespace)}&kind=${encodeURIComponent(c.kind)}&name=${encodeURIComponent(c.name)}`, cluster));
      const d = await res.json().catch(() => ({}));
      setTimelineData(d);
      setShowTimeline(true);
    } catch { setTimelineData({ changes: [], resolutions: [] }); setShowTimeline(true); }
  };

  return (
    <div className={"acw-change-card" + (expanded ? " expanded" : "")} style={{ borderLeftColor: typeInfo.color }}>
      <div className="acw-change-row" onClick={onToggle}>
        <span className="acw-change-icon">{typeInfo.icon}</span>
        <div className="acw-change-info">
          <div className="acw-change-resource">
            <span className="acw-change-kind-badge">{c.kind}</span>
            {c.name}
            {c.riskScore != null && (
              <span className={"acw-risk-badge " + (c.riskLevel || "low")} title={`Risk: ${c.riskScore}/100`}>
                RSK {c.riskScore}
              </span>
            )}
            {correlated.length > 0 && (
              <span className="acw-corr-badge" title={`${correlated.length} related change${correlated.length > 1 ? "s" : ""}`}>
                {"\u{1F517}"} {correlated.length}
              </span>
            )}
          </div>
          <div className="acw-change-meta">
            {c.namespace} · {relTime(c.changedBy?.time || c.detectedAt)}
            {c.changedBy?.method && <> · via {c.changedBy.method}</>}
            {c.blastRadius != null && c.blastRadius > 0 && (
              <span className="acw-blast-radius" title={`${c.blastRadius} pod(s) affected`}>
                · {"\u{1F4A5}"} {c.blastRadius} pod{c.blastRadius !== 1 ? "s" : ""} affected
              </span>
            )}
          </div>
          {/* Inline AI Risk Explanation — always visible */}
          {c.aiExplanation && (
            <div className="acw-ai-inline">
              <span className="acw-ai-inline-icon">{"\u{1F9E0}"}</span>
              <span className="acw-ai-inline-text">{c.aiExplanation}</span>
            </div>
          )}
        </div>
        {c.followUp && <span className="acw-followup" title="Follow-up change">↻</span>}
        {c.changeFreezeViolation && <span className="acw-freeze-badge" title="Off-hours change">⏰</span>}
        <span className="acw-change-chevron">{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div className="acw-change-detail">
          {/* Change Correlation */}
          {correlated.length > 0 && (
            <div className="acw-corr-section">
              <div className="acw-corr-title">{"\u{1F517}"} Related Changes ({correlated.length})</div>
              {correlated.map((r, i) => (
                <div key={i} className="acw-corr-item">
                  <span className="acw-corr-resource">{r.kind}/{r.name}</span>
                  <span className="acw-corr-ns">{r.namespace}</span>
                  <span className="acw-corr-reason">{r.reason}</span>
                </div>
              ))}
            </div>
          )}

          {/* Field-level changes */}
          {(c.changes || []).length > 0 && (
            <div className="acw-diff-section">
              <div className="acw-diff-title">Changes</div>
              {c.changes.map((ch, i) => (
                <div key={i} className="acw-diff-row">
                  <span className="acw-diff-field">{ch.field}</span>
                  {ch.old && <span className="acw-diff-old">{String(ch.old)}</span>}
                  <span className="acw-diff-arrow">{"→"}</span>
                  <span className="acw-diff-new">{String(ch.new || ch.value || "")}</span>
                </div>
              ))}
            </div>
          )}

          {/* Correlated Events */}
          {(c.correlatedEvents || []).length > 0 && (
            <div className="acw-events-section">
              <div className="acw-events-title">Correlated Events</div>
              {c.correlatedEvents.map((ev, i) => (
                <div key={i} className="acw-event-row">
                  <span className={"acw-event-type " + (ev.type || "").toLowerCase()}>{ev.type}</span>
                  <span>{ev.reason}</span>
                  {ev.count > 1 && <span className="acw-event-count">x{ev.count}</span>}
                </div>
              ))}
            </div>
          )}

          {/* AI Deep Analysis (on-demand via LLM) */}
          <div className="acw-ai-section">
            <div className="acw-ai-title"><span className="acw-ai-icon">{"\u{1F916}"}</span> AI Deep Analysis</div>
            {!aiAnalysis && (
              <button className="acw-ai-btn" onClick={handleAnalyze} disabled={aiLoading}>
                {aiLoading ? "Analyzing..." : "Run Deep Analysis"}
              </button>
            )}
            {aiAnalysis && <div className="acw-ai-result">{aiAnalysis}</div>}
          </div>

          {/* Rollback Preview */}
          {c.rollbackPreview && (
            <div className="acw-rollback-section">
              <div className="acw-rollback-title">Rollback Preview (if dismissed)</div>
              <div className="acw-rollback-info">
                Replicas will be set to: {c.rollbackPreview.replicas}
              </div>
              {(c.rollbackPreview.containers || []).map((ct, i) => (
                <div key={i} className="acw-rollback-container">
                  Container <strong>{ct.name}</strong>: {ct.image}
                </div>
              ))}
            </div>
          )}

          {/* Workload Timeline */}
          <div className="acw-timeline-section">
            <button className="acw-timeline-toggle" onClick={loadTimeline}>
              {showTimeline ? "Hide" : "Show"} Change History
            </button>
            {showTimeline && timelineData && (
              <div style={{ marginTop: 6 }}>
                <div className="acw-timeline-title">Recent Changes for {c.kind}/{c.name}</div>
                {(timelineData.changes || []).length === 0 && (timelineData.resolutions || []).length === 0 && (
                  <div style={{ fontSize: 11, color: "var(--text2)" }}>No prior changes recorded</div>
                )}
                {(timelineData.changes || []).slice(0, 8).map((t, i) => (
                  <div key={i} className="acw-timeline-row">
                    <span className={"acw-timeline-dot " + (t.severity || "info")} />
                    <span className="acw-timeline-time">{relTime(t.timestamp)}</span>
                    <span className="acw-timeline-desc">{t.changeType} — {t.changeCount} field(s), RSK {t.riskScore}</span>
                  </div>
                ))}
                {(timelineData.resolutions || []).slice(0, 5).map((r, i) => (
                  <div key={`r${i}`} className="acw-timeline-row">
                    <span className={"acw-timeline-dot info"} />
                    <span className="acw-timeline-time">{relTime(r.resolvedAt)}</span>
                    <span className="acw-timeline-desc">{r.changeSummary || r.changeType}</span>
                    <span className={"acw-timeline-badge " + r.action}>{r.action}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="acw-action-row">
            <button className="acw-action-btn agree" onClick={() => onAction(c.id, "agree", { kind: c.kind, name: c.name, namespace: c.namespace })}>
              {"✓"} Agree
            </button>
            <button className="acw-action-btn dismiss" onClick={() => onAction(c.id, "dismiss", { kind: c.kind, name: c.name, namespace: c.namespace, rollbackPreview: c.rollbackPreview })}>
              {"✗"} Dismiss
            </button>
            <button className="acw-action-btn ack" onClick={() => onAction(c.id, "acknowledge", { kind: c.kind, name: c.name, namespace: c.namespace })}>
              Ack
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
