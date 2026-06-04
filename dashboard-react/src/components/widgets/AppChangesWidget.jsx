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
    { refetchInterval: 15_000 }
  );
  const [nsPanelOpen, setNsPanelOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [expandedChange, setExpandedChange] = useState(null);
  const [workloadsOpen, setWorkloadsOpen] = useState(false);

  const unavailable = data && data.available === false;
  const total = data?.totalChanges ?? 0;
  const critical = data?.critical ?? 0;
  const warning = data?.warning ?? 0;
  const watched = data?.watchedNamespaces || [];
  const tracked = data?.trackedWorkloads ?? 0;
  const changes = data?.recentChanges || [];
  const changeTypes = data?.changeTypeBreakdown || {};
  const timeline = data?.timelineStats || {};
  const history = data?.changeHistory || [];
  const gitops = data?.gitopsDrift || {};

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await fetch(clusterUrl("/api/dashboard/app-changes/scan", cluster), { method: "POST" });
      const d = await res.json().catch(() => ({}));
      showToast(d.newChanges != null ? `Scan complete: ${d.newChanges} new changes` : "Scan complete", "ok");
      refetch();
    } catch (err) {
      showToast("Scan failed: " + err.message, "err");
    } finally {
      setScanning(false);
    }
  };

  const handleAction = async (changeId, action) => {
    try {
      const res = await fetch(clusterUrl("/api/dashboard/app-changes/action", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeId, action }),
      });
      const d = await res.json().catch(() => ({}));
      showToast(d.message || `Change ${action}d`, res.ok ? "ok" : "err");
      refetch();
    } catch (err) {
      showToast("Action failed: " + err.message, "err");
    }
  };

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

  return (
    <div className="acw">
      {/* Header */}
      <div className="acw-header">
        <h3>
          <span className="acw-icon">{"\u{1F50D}"}</span>
          Application Change Watcher
        </h3>
        <div className="acw-header-actions">
          <button className="acw-scan-btn" onClick={handleScan} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan Now"}
          </button>
          <button
            className="acw-ns-btn"
            onClick={() => setNsPanelOpen(!nsPanelOpen)}
          >
            {watched.length} Namespaces
          </button>
        </div>
      </div>

      {/* Namespace Manager Panel */}
      {nsPanelOpen && (
        <NamespaceManager
          cluster={cluster}
          watched={watched}
          onClose={() => setNsPanelOpen(false)}
          onUpdate={refetch}
        />
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
            <div className="acw-ring-sub">{watched.join(", ") || "none"}</div>
          </div>
        </div>
        <div className="acw-changes-count">
          <div className={"acw-change-num " + (critical > 0 ? "crit" : warning > 0 ? "warn" : "ok")}>{total}</div>
          <div className="acw-change-lbl">Changes</div>
        </div>
      </div>

      {/* Workloads detail (collapsible) */}
      {workloadsOpen && <WorkloadsViewer cluster={cluster} />}

      {/* Change Type Breakdown */}
      {Object.keys(changeTypes).length > 0 && (
        <div className="acw-types">
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
      )}

      {/* 24h Velocity Bar */}
      {timeline.hourlyBuckets?.length > 0 && (
        <VelocityBar buckets={timeline.hourlyBuckets} />
      )}

      {/* Changes List */}
      {changes.length > 0 && (
        <div className="acw-changes">
          <div className="acw-changes-title">Pending Changes</div>
          {changes.map((c) => (
            <ChangeCard
              key={c.id}
              change={c}
              expanded={expandedChange === c.id}
              onToggle={() => setExpandedChange(expandedChange === c.id ? null : c.id)}
              onAction={handleAction}
            />
          ))}
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
    </div>
  );
}

/* ── Namespace Manager ── */
function NamespaceManager({ cluster, watched, onClose, onUpdate }) {
  const [allNs, setAllNs] = useState([]);
  const [trackedNs, setTrackedNs] = useState([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedAvail, setSelectedAvail] = useState(new Set());
  const [selectedTracked, setSelectedTracked] = useState(new Set());
  const [loading, setLoading] = useState(true);
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
    .filter((n) => filter === "all" || (n.workloads || 0) > 0);

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
      loadData();
      onUpdate();
    } catch (err) {
      showToast("Transfer failed: " + err.message, "err");
    }
  };

  const trackSelected = () => transfer([...selectedAvail], "add");
  const untrackSelected = () => transfer([...selectedTracked], "remove");
  const trackAll = () => transfer(availableNs.map((n) => n.namespace), "add");
  const removeAll = () => transfer([...trackedNs], "remove");

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
            {loading ? <div className="acw-ns-loading">Loading…</div> : availableNs.map((n) => (
              <div
                key={n.namespace}
                className={"acw-ns-item" + (selectedAvail.has(n.namespace) ? " selected" : "")}
                draggable
                onClick={(e) => handleSelect(n.namespace, "avail", e)}
                onDragStart={(e) => handleDragStart(e, n.namespace, "avail")}
                onDoubleClick={() => quickTransfer(n.namespace, "avail")}
              >
                <span className="acw-ns-dot" />
                <span className="acw-ns-name">{n.namespace}</span>
                {n.breakdown && (
                  <span className="acw-ns-badges">
                    {n.breakdown.deployments > 0 && <span className="acw-wb dep">{n.breakdown.deployments} Dep</span>}
                    {n.breakdown.statefulsets > 0 && <span className="acw-wb sts">{n.breakdown.statefulsets} Sts</span>}
                    {n.breakdown.daemonsets > 0 && <span className="acw-wb ds">{n.breakdown.daemonsets} Ds</span>}
                    {n.breakdown.pods > 0 && <span className="acw-wb po">{n.breakdown.pods} Po</span>}
                  </span>
                )}
              </div>
            ))}
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

/* ── Change Card ── */
function ChangeCard({ change, expanded, onToggle, onAction }) {
  const c = change;
  const typeInfo = CHANGE_ICONS[c.changeType] || CHANGE_ICONS.other;

  return (
    <div className={"acw-change-card" + (expanded ? " expanded" : "")} style={{ borderLeftColor: typeInfo.color }}>
      <div className="acw-change-row" onClick={onToggle}>
        <span className="acw-change-icon">{typeInfo.icon}</span>
        <div className="acw-change-info">
          <div className="acw-change-resource">
            {c.kind}/{c.name}
            {c.riskScore != null && (
              <span className={"acw-risk-badge " + (c.riskLevel || "low")} title={`Risk: ${c.riskScore}/100`}>
                RSK {c.riskScore}
              </span>
            )}
          </div>
          <div className="acw-change-meta">
            {c.namespace} · {relTime(c.changedBy?.time || c.detectedAt)}
            {c.changedBy?.method && <> · via {c.changedBy.method}</>}
          </div>
        </div>
        {c.followUp && <span className="acw-followup" title="Follow-up change">↻</span>}
        {c.changeFreezeViolation && <span className="acw-freeze-badge" title="Off-hours change">⏰</span>}
        <span className="acw-change-chevron">{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div className="acw-change-detail">
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

          {/* Action Buttons */}
          <div className="acw-action-row">
            <button className="acw-action-btn agree" onClick={() => onAction(c.id, "agree")}>
              {"✓"} Agree
            </button>
            <button className="acw-action-btn dismiss" onClick={() => onAction(c.id, "dismiss")}>
              {"✗"} Dismiss
            </button>
            <button className="acw-action-btn ack" onClick={() => onAction(c.id, "acknowledge")}>
              Ack
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
