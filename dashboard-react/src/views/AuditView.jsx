import { useState, useMemo, useCallback } from "react";
import { useClusterQuery } from "../hooks/useClusterQuery";
import { useActiveCluster } from "../store/clusterStore";
import { clusterUrl } from "../api/client";
import { showToast } from "../store/toastStore";

const STATUS_FILTERS = ["All", "Success", "Failed", "ITSM"];
const TIME_RANGES = [
  { label: "Last Hour", ms: 3_600_000 },
  { label: "Last 24h", ms: 86_400_000 },
  { label: "Last 7 Days", ms: 604_800_000 },
  { label: "Last 30 Days", ms: 2_592_000_000 },
  { label: "All Time", ms: 0 },
];
const ACTION_TYPES = ["All", "Scale", "Restart", "Delete", "Patch", "Create", "Update", "Rollback", "Approve", "Deny"];
const TRAIL_TYPES = ["all", "compliance_scan", "policy_violation", "change_detected", "action_taken", "slo_breach", "config_change", "login"];

const gradeColor = (g) =>
  g === "A" ? "#22c55e" : g === "B" ? "#84cc16" : g === "C" ? "#f59e0b" : g === "D" ? "#f97316" : "#ef4444";

const sevColor = (s) => {
  if (s === "critical") return "#ef4444";
  if (s === "warning" || s === "high") return "#f59e0b";
  return "#3b82f6";
};

const statusIcon = (st) =>
  st === "PASS" ? "✓" : st === "FAIL" ? "✗" : "!";

function fmt(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(u);
}

export function AuditView() {
  const cluster = useActiveCluster();

  const { data: auditData, isLoading: auditLoading, isError: auditError, error: auditErr } =
    useClusterQuery("/api/audit", { refetchInterval: 20_000 });

  const { data: compData, refetch: refetchComp } =
    useClusterQuery("/api/compliance/results", { refetchInterval: 60_000 });

  const { data: fwSummary, refetch: refetchFw } =
    useClusterQuery("/api/compliance/frameworks-summary", { refetchInterval: 120_000 });

  const { data: trailData, refetch: refetchTrail } =
    useClusterQuery("/api/audit-trail?limit=100", { refetchInterval: 30_000 });

  const { data: trailStats } =
    useClusterQuery("/api/audit-trail/stats?days=30", { refetchInterval: 120_000 });

  const { data: compHistory } =
    useClusterQuery("/api/compliance/history", { refetchInterval: 120_000 });

  const { data: crData, refetch: refetchCRs } =
    useClusterQuery("/api/cr?limit=50", { refetchInterval: 30_000 });

  const { data: pendingCRData } =
    useClusterQuery("/api/cr/pending", { refetchInterval: 30_000 });

  const [activeTab, setActiveTab] = useState("compliance");
  const [scanning, setScanning] = useState(false);
  const [catFilter, setCatFilter] = useState("all");
  const [findingSev, setFindingSev] = useState("all");
  const [findingStatus, setFindingStatus] = useState("all");
  const [expandedFinding, setExpandedFinding] = useState(null);
  const [expandedFw, setExpandedFw] = useState(null);

  const [statusFilter, setStatusFilter] = useState("All");
  const [timeRange, setTimeRange] = useState("All Time");
  const [actionType, setActionType] = useState("All");

  const [trailType, setTrailType] = useState("all");
  const [crStatusFilter, setCrStatusFilter] = useState("all");
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingCR, setSyncingCR] = useState({});
  const [dismissingCR, setDismissingCR] = useState({});

  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true);
    try {
      await fetch(clusterUrl("/api/cr/sync-all", cluster), { method: "POST" });
      refetchCRs();
      showToast("All CRs synced with ServiceNow", "ok");
    } catch (err) { showToast("Sync failed: " + err.message, "err"); }
    finally { setSyncingAll(false); }
  }, [cluster, refetchCRs]);

  const handleSyncCR = useCallback(async (ticketId) => {
    setSyncingCR((p) => ({ ...p, [ticketId]: true }));
    try {
      await fetch(clusterUrl(`/api/cr/${encodeURIComponent(ticketId)}/sync`, cluster), { method: "POST" });
      refetchCRs();
      showToast(`${ticketId} synced`, "ok");
    } catch (err) { showToast("Sync failed: " + err.message, "err"); }
    finally { setSyncingCR((p) => ({ ...p, [ticketId]: false })); }
  }, [cluster, refetchCRs]);

  const handleDismissCR = useCallback(async (ticketId) => {
    setDismissingCR((p) => ({ ...p, [ticketId]: true }));
    try {
      await fetch(clusterUrl(`/api/cr/${encodeURIComponent(ticketId)}`, cluster), { method: "DELETE" });
      refetchCRs();
      showToast(`${ticketId} dismissed`, "ok");
    } catch (err) { showToast("Dismiss failed: " + err.message, "err"); }
    finally { setDismissingCR((p) => ({ ...p, [ticketId]: false })); }
  }, [cluster, refetchCRs]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch(clusterUrl("/api/compliance/scan", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("Scan failed");
      await res.json();
      refetchComp();
      refetchFw();
      showToast("Compliance scan complete", "ok");
    } catch (err) {
      showToast("Scan failed: " + err.message, "err");
    } finally {
      setScanning(false);
    }
  }, [cluster, refetchComp, refetchFw]);

  const executed = auditData?.executed || [];
  const pending = auditData?.pending || [];
  const queries = auditData?.queries || [];
  const queryStats = auditData?.queryStats || {};

  const filteredExecuted = useMemo(() => {
    let list = [...executed];
    const range = TIME_RANGES.find((t) => t.label === timeRange);
    if (range && range.ms > 0) {
      const cutoff = Date.now() - range.ms;
      list = list.filter((e) => new Date(e.created_at || e.createdAt || 0).getTime() >= cutoff);
    }
    if (statusFilter === "Success") list = list.filter((e) => e.success === true);
    else if (statusFilter === "Failed") list = list.filter((e) => e.success === false);
    else if (statusFilter === "ITSM") list = list.filter((e) => e.itsm || e.ticketId);
    if (actionType !== "All") list = list.filter((e) => (e.action || "").toLowerCase() === actionType.toLowerCase());
    return list;
  }, [executed, statusFilter, timeRange, actionType]);

  const total = executed.length;
  const successCount = executed.filter((e) => e.success).length;
  const failedCount = executed.filter((e) => e.success === false).length;
  const rate = total ? Math.round((successCount / total) * 100) : 0;

  const findings = compData?.findings || [];
  const compScore = compData?.score ?? null;
  const compGrade = compData?.grade || "?";
  const compTotals = compData?.totals || {};
  const compSummary = compData?.summary || {};
  const categories = Object.keys(compSummary);

  const filteredFindings = useMemo(() => {
    let list = findings;
    if (catFilter !== "all") list = list.filter((f) => f.category === catFilter);
    if (findingSev !== "all") list = list.filter((f) => f.severity === findingSev);
    if (findingStatus !== "all") list = list.filter((f) => f.status === findingStatus);
    return list;
  }, [findings, catFilter, findingSev, findingStatus]);

  const frameworks = fwSummary?.results || [];

  const trailEntries = trailData?.entries || trailData?.events || [];
  const filteredTrail = useMemo(() => {
    if (trailType === "all") return trailEntries;
    return trailEntries.filter((e) => e.type === trailType);
  }, [trailEntries, trailType]);

  const trailStatsData = trailStats || {};

  const handleExportJSON = useCallback(() => {
    downloadFile(
      JSON.stringify({ cluster, exported: new Date().toISOString(), executed: filteredExecuted, pending, queries }, null, 2),
      `audit-${cluster}-${Date.now()}.json`, "application/json"
    );
  }, [cluster, filteredExecuted, pending, queries]);

  const handleExportCSV = useCallback(() => {
    const headers = ["Timestamp", "Action", "Target", "Namespace", "Status", "User", "Details"];
    const rows = filteredExecuted.map((e) => [
      e.created_at || e.createdAt || "", e.action || "", e.target || "",
      e.namespace || "", e.success ? "success" : "failed", e.user || e.initiator || "", e.details || e.message || "",
    ]);
    const csv = [headers, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadFile(csv, `audit-${cluster}-${Date.now()}.csv`, "text/csv");
  }, [cluster, filteredExecuted]);

  const historyList = compHistory?.history || [];

  return (
    <div className="aud">

      {/* ═══ HERO ═══ */}
      <div className="aud-hero">
        <div className="aud-hero-glow" />
        <div className="aud-hero-inner">
          <div className="aud-hero-top">
            <div className="aud-hero-title">
              <div className="aud-hero-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              </div>
              <div>
                <h2>Audit &amp; Compliance Center</h2>
                <p>CIS benchmarks, compliance frameworks, audit trail &amp; activity
                  {cluster !== "local" && <span className="aud-cluster-badge">{cluster}</span>}
                </p>
              </div>
            </div>
            <div className="aud-hero-actions">
              <button className="aud-hero-btn scan" onClick={handleScan} disabled={scanning}>
                {scanning ? "Scanning…" : "Run CIS Scan"}
              </button>
              <button className="aud-hero-btn" onClick={handleExportJSON}>Export JSON</button>
              <button className="aud-hero-btn" onClick={handleExportCSV}>Export CSV</button>
            </div>
          </div>

          {/* Hero stats */}
          <div className="aud-hero-stats">
            <div className="aud-stat-box" style={{ "--stat-c": compScore !== null ? gradeColor(compGrade) : "#64748b" }}>
              <div className="aud-stat-val">{compScore !== null ? compScore : "—"}</div>
              <div className="aud-stat-lbl">CIS Score</div>
            </div>
            <div className="aud-stat-box" style={{ "--stat-c": "#ef4444" }}>
              <div className="aud-stat-val">{compTotals.fail || 0}</div>
              <div className="aud-stat-lbl">Findings (Fail)</div>
            </div>
            <div className="aud-stat-box" style={{ "--stat-c": "#22c55e" }}>
              <div className="aud-stat-val">{compTotals.pass || 0}</div>
              <div className="aud-stat-lbl">Checks Passed</div>
            </div>
            <div className="aud-stat-box" style={{ "--stat-c": "#3b82f6" }}>
              <div className="aud-stat-val">{total}</div>
              <div className="aud-stat-lbl">Actions Executed</div>
            </div>
            <div className="aud-stat-box" style={{ "--stat-c": rate >= 90 ? "#22c55e" : rate >= 70 ? "#f59e0b" : "#ef4444" }}>
              <div className="aud-stat-val">{rate}%</div>
              <div className="aud-stat-lbl">Success Rate</div>
            </div>
            <div className="aud-stat-box" style={{ "--stat-c": "#8b5cf6" }}>
              <div className="aud-stat-val">{frameworks.length}</div>
              <div className="aud-stat-lbl">Frameworks</div>
            </div>
          </div>
        </div>
      </div>

      {/* ═══ TAB BAR ═══ */}
      <div className="aud-tabs">
        {[
          { key: "compliance", label: "CIS Compliance", icon: "shield" },
          { key: "frameworks", label: "Framework Profiles", icon: "layers" },
          { key: "change-requests", label: "Change Requests", count: (crData?.crs || []).length },
          { key: "trail", label: "Audit Trail", icon: "scroll" },
          { key: "activity", label: "Activity & Actions", icon: "zap" },
          { key: "analytics", label: "Query Analytics", icon: "chart" },
        ].map((t) => (
          <button key={t.key} className={"aud-tab" + (activeTab === t.key ? " active" : "")} onClick={() => setActiveTab(t.key)}>
            {t.label}
            {t.count != null && t.count > 0 && <span className="aud-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* ═══ 1. CIS COMPLIANCE ═══ */}
      {activeTab === "compliance" && (
        <div className="aud-section">
          {compScore === null ? (
            <div className="aud-empty-state">
              <div className="aud-empty-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              </div>
              <h3>No Compliance Scan Yet</h3>
              <p>Run a CIS Kubernetes Benchmark scan to see your cluster's security posture</p>
              <button className="aud-hero-btn scan" onClick={handleScan} disabled={scanning}>
                {scanning ? "Scanning…" : "Run CIS Scan"}
              </button>
            </div>
          ) : (
            <>
              {/* Score + Grade Ring */}
              <div className="aud-comp-hero">
                <div className="aud-comp-ring">
                  <svg viewBox="0 0 96 96" width="96" height="96">
                    <circle cx="48" cy="48" r="42" fill="none" stroke="var(--border)" strokeWidth="6" />
                    <circle cx="48" cy="48" r="42" fill="none" stroke={gradeColor(compGrade)} strokeWidth="6" strokeLinecap="round"
                      strokeDasharray={2 * Math.PI * 42} strokeDashoffset={2 * Math.PI * 42 * (1 - compScore / 100)}
                      style={{ transform: "rotate(-90deg)", transformOrigin: "center", transition: "stroke-dashoffset .8s ease" }} />
                  </svg>
                  <div className="aud-comp-ring-inner">
                    <div className="aud-comp-score">{compScore}</div>
                    <div className="aud-comp-max">/100</div>
                  </div>
                </div>
                <div className="aud-comp-info">
                  <div className="aud-comp-grade-pill" style={{ background: gradeColor(compGrade) + "18", color: gradeColor(compGrade), borderColor: gradeColor(compGrade) }}>
                    Grade {compGrade}
                  </div>
                  <div className="aud-comp-meta">
                    {compTotals.total || 0} checks · {compTotals.pass || 0} passed · {compTotals.fail || 0} failed · {compTotals.warn || 0} warnings
                  </div>
                  {compData?.scanTime && <div className="aud-comp-time">Scanned: {fmt(compData.scanTime)}</div>}
                </div>

                {/* Category cards */}
                <div className="aud-cat-cards">
                  {categories.map((cat) => {
                    const s = compSummary[cat] || {};
                    const isActive = catFilter === cat;
                    return (
                      <button
                        key={cat}
                        className={"aud-cat-card" + (isActive ? " active" : "")}
                        onClick={() => setCatFilter(isActive ? "all" : cat)}
                      >
                        <div className="aud-cat-name">{cat.replace(/-/g, " ")}</div>
                        <div className="aud-cat-counts">
                          <span className="aud-cat-pass">{s.pass || 0} pass</span>
                          <span className="aud-cat-fail">{s.fail || 0} fail</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Finding filters */}
              <div className="aud-finding-filters">
                <select className="aud-f-select" value={findingSev} onChange={(e) => setFindingSev(e.target.value)}>
                  <option value="all">All Severities</option>
                  <option value="critical">Critical</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                </select>
                <select className="aud-f-select" value={findingStatus} onChange={(e) => setFindingStatus(e.target.value)}>
                  <option value="all">All Statuses</option>
                  <option value="FAIL">Failed</option>
                  <option value="PASS">Passed</option>
                  <option value="WARN">Warning</option>
                </select>
                <span className="aud-f-count">{filteredFindings.length} findings</span>
              </div>

              {/* Findings list */}
              <div className="aud-findings-list">
                {filteredFindings.length === 0 && <div className="aud-empty">No findings match the current filters</div>}
                {filteredFindings.slice(0, 60).map((f, i) => {
                  const sc = f.status === "PASS" ? "#22c55e" : f.status === "FAIL" ? "#ef4444" : "#f59e0b";
                  const isExp = expandedFinding === i;
                  return (
                    <div key={i} className={"aud-finding" + (isExp ? " expanded" : "")} style={{ "--find-c": sc }}>
                      <div className="aud-finding-head" onClick={() => setExpandedFinding(isExp ? null : i)}>
                        <span className="aud-finding-status" style={{ color: sc }}>{statusIcon(f.status)}</span>
                        <div className="aud-finding-body">
                          <div className="aud-finding-row1">
                            <span className="aud-finding-id">{f.id}</span>
                            <span className="aud-finding-title">{f.title}</span>
                            <span className={"aud-finding-sev " + (f.severity || "info")}>{(f.severity || "info").toUpperCase()}</span>
                            <span className={"aud-finding-st " + (f.status || "").toLowerCase()}>{f.status}</span>
                          </div>
                          {f.namespace && <span className="aud-finding-ns">ns: {f.namespace}</span>}
                          {f.resource && <span className="aud-finding-res">{f.resource}</span>}
                        </div>
                        <span className="aud-finding-chevron">{isExp ? "▲" : "▼"}</span>
                      </div>
                      {isExp && (
                        <div className="aud-finding-detail">
                          {f.description && <div className="aud-fd-block"><span className="aud-fd-lbl">Description</span><p>{f.description}</p></div>}
                          {f.remediation && <div className="aud-fd-block remediation"><span className="aud-fd-lbl">Remediation</span><p>{f.remediation}</p></div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Compliance History */}
              {historyList.length > 1 && (
                <div className="aud-history">
                  <h4>Scan History</h4>
                  <div className="aud-history-list">
                    {historyList.slice(0, 10).map((h, i) => (
                      <div key={i} className="aud-history-item">
                        <span className="aud-history-score" style={{ color: gradeColor(h.score >= 90 ? "A" : h.score >= 80 ? "B" : h.score >= 70 ? "C" : "D") }}>
                          {h.score}
                        </span>
                        <span className="aud-history-time">{fmt(h.scanTime)}</span>
                        <span className="aud-history-counts">{h.totals?.fail || 0} fail · {h.totals?.pass || 0} pass</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══ 2. FRAMEWORK PROFILES ═══ */}
      {activeTab === "frameworks" && (
        <div className="aud-section">
          <div className="aud-section-intro">
            <h3>Compliance Framework Profiles</h3>
            <p>CIS findings mapped to industry compliance frameworks</p>
          </div>
          {frameworks.length === 0 ? (
            <div className="aud-empty">Run a CIS scan first to see framework evaluations</div>
          ) : (
            <div className="aud-fw-grid">
              {frameworks.map((fw, i) => {
                const gc = gradeColor(fw.grade || "F");
                const isExp = expandedFw === i;
                return (
                  <div key={fw.id || i} className={"aud-fw-card" + (isExp ? " expanded" : "")}>
                    <div className="aud-fw-head" onClick={() => setExpandedFw(isExp ? null : i)}>
                      <div className="aud-fw-score-ring" style={{ "--fw-c": gc }}>
                        <span>{fw.score ?? 0}</span>
                      </div>
                      <div className="aud-fw-info">
                        <div className="aud-fw-name">{fw.name}</div>
                        <div className="aud-fw-desc">{fw.description}</div>
                        <div className="aud-fw-stats">
                          <span style={{ color: "#22c55e" }}>{fw.compliant || 0} compliant</span>
                          <span style={{ color: "#f59e0b" }}>{fw.partial || 0} partial</span>
                          <span style={{ color: "#ef4444" }}>{fw.nonCompliant || 0} non-compliant</span>
                        </div>
                      </div>
                      <div className="aud-fw-grade" style={{ color: gc, borderColor: gc }}>{fw.grade || "?"}</div>
                    </div>
                    {isExp && fw.controls && (
                      <div className="aud-fw-controls">
                        {fw.controls.map((ctrl, ci) => (
                          <div key={ci} className={"aud-fw-ctrl " + (ctrl.status || "not-evaluated")}>
                            <span className="aud-fw-ctrl-id">{ctrl.controlId}</span>
                            <div className="aud-fw-ctrl-info">
                              <div className="aud-fw-ctrl-title">{ctrl.title}</div>
                              <div className="aud-fw-ctrl-desc">{ctrl.description}</div>
                            </div>
                            <span className={"aud-fw-ctrl-status " + (ctrl.status || "")}>{(ctrl.status || "N/A").replace("-", " ")}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══ 3. CHANGE REQUESTS (ServiceNow / ITSM) ═══ */}
      {activeTab === "change-requests" && (() => {
        const allCRs = crData?.crs || [];
        const pendingCRs = pendingCRData?.crs || [];
        const filtCRs = crStatusFilter === "all" ? allCRs :
          crStatusFilter === "pending" ? allCRs.filter((c) => ["submitted", "pending_approval", "awaiting_approval"].includes(c.status)) :
          allCRs.filter((c) => c.status === crStatusFilter);
        const STATUS_C = { submitted: "#3b82f6", pending_approval: "#f59e0b", awaiting_approval: "#f59e0b", approved: "#22c55e", scheduled: "#8b5cf6", executed: "#06b6d4", cancelled: "#ef4444", dismissed: "#64748b", rejected: "#ef4444" };
        return (
          <div className="aud-section">
            <div className="aud-section-head">
              <div className="aud-section-title">
                <div className="aud-section-icon" style={{ background: "linear-gradient(135deg, #0c5e2e, #22c55e)" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </div>
                <div>
                  <h3>Change Request Tracker</h3>
                  <p>ServiceNow CRs, approval status &amp; lifecycle tracking</p>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="aud-scan-btn" onClick={handleSyncAll} disabled={syncingAll}>
                  {syncingAll ? "Syncing..." : "Sync All from ServiceNow"}
                </button>
              </div>
            </div>

            {/* Stats row */}
            <div className="aud-cr-stats">
              <div className="aud-cr-stat" style={{ "--cs-c": "#3b82f6" }}><span>{allCRs.length}</span><label>Total</label></div>
              <div className="aud-cr-stat" style={{ "--cs-c": "#f59e0b" }}><span>{pendingCRs.length}</span><label>Pending</label></div>
              <div className="aud-cr-stat" style={{ "--cs-c": "#22c55e" }}><span>{allCRs.filter((c) => c.status === "approved").length}</span><label>Approved</label></div>
              <div className="aud-cr-stat" style={{ "--cs-c": "#06b6d4" }}><span>{allCRs.filter((c) => c.status === "executed").length}</span><label>Executed</label></div>
            </div>

            {/* Status filter */}
            <div className="aud-filter-row" style={{ marginBottom: 12 }}>
              {["all", "pending", "approved", "executed", "cancelled", "dismissed"].map((s) => (
                <button key={s} className={"aud-filter-pill" + (crStatusFilter === s ? " active" : "")} onClick={() => setCrStatusFilter(s)}>
                  {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>

            {/* CR list */}
            <div className="aud-cr-list">
              {filtCRs.length === 0 && <div className="aud-empty">No change requests found</div>}
              {filtCRs.map((cr) => {
                const stColor = STATUS_C[cr.status] || "#64748b";
                return (
                  <div key={cr.ticket_id || cr.ticketId} className="aud-cr-card" style={{ "--cr-c": stColor }}>
                    <div className="aud-cr-head">
                      <div className="aud-cr-id">{cr.ticket_id || cr.ticketId}</div>
                      <span className="aud-cr-status" style={{ background: stColor + "22", color: stColor }}>{(cr.status || "unknown").toUpperCase()}</span>
                      {cr.snow_number && <span className="aud-cr-snow">SN: {cr.snow_number}</span>}
                    </div>
                    <div className="aud-cr-title">{cr.title || cr.description || "—"}</div>
                    <div className="aud-cr-meta">
                      {cr.target_version && <span>Target: {cr.target_version}</span>}
                      {cr.cluster && <span>Cluster: {cr.cluster}</span>}
                      <span>{fmt(cr.created_at || cr.createdAt)}</span>
                      {cr.scheduled_date && <span>Scheduled: {fmt(cr.scheduled_date)}</span>}
                    </div>
                    <div className="aud-cr-actions">
                      <button className="aud-cr-btn" onClick={() => handleSyncCR(cr.ticket_id || cr.ticketId)} disabled={syncingCR[cr.ticket_id || cr.ticketId]}>
                        {syncingCR[cr.ticket_id || cr.ticketId] ? "..." : "Sync"}
                      </button>
                      {!["executed", "cancelled", "dismissed"].includes(cr.status) && (
                        <button className="aud-cr-btn dismiss" onClick={() => handleDismissCR(cr.ticket_id || cr.ticketId)} disabled={dismissingCR[cr.ticket_id || cr.ticketId]}>
                          Dismiss
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ═══ 4. AUDIT TRAIL ═══ */}
      {activeTab === "trail" && (
        <div className="aud-section">
          <div className="aud-section-intro">
            <h3>Persistent Audit Trail</h3>
            <p>90-day event log of all cluster compliance &amp; security events</p>
          </div>

          {/* Trail stats */}
          {trailStatsData.total != null && (
            <div className="aud-trail-stats">
              <div className="aud-trail-stat" style={{ "--ts-c": "#8b5cf6" }}>
                <div className="aud-trail-stat-val">{trailStatsData.total || 0}</div>
                <div className="aud-trail-stat-lbl">Total Events</div>
              </div>
              <div className="aud-trail-stat" style={{ "--ts-c": "#ef4444" }}>
                <div className="aud-trail-stat-val">{trailStatsData.critical || 0}</div>
                <div className="aud-trail-stat-lbl">Critical</div>
              </div>
              <div className="aud-trail-stat" style={{ "--ts-c": "#f59e0b" }}>
                <div className="aud-trail-stat-val">{trailStatsData.warnings || trailStatsData.warning || 0}</div>
                <div className="aud-trail-stat-lbl">Warnings</div>
              </div>
              <div className="aud-trail-stat" style={{ "--ts-c": "#3b82f6" }}>
                <div className="aud-trail-stat-val">{trailStatsData.info || 0}</div>
                <div className="aud-trail-stat-lbl">Info</div>
              </div>
            </div>
          )}

          {/* Trail type filter */}
          <div className="aud-trail-filters">
            {TRAIL_TYPES.map((t) => (
              <button key={t} className={"aud-trail-pill" + (trailType === t ? " active" : "")} onClick={() => setTrailType(t)}>
                {t === "all" ? "All Events" : t.replace(/_/g, " ")}
              </button>
            ))}
          </div>

          {/* Trail entries */}
          <div className="aud-trail-list">
            {filteredTrail.length === 0 && <div className="aud-empty">No audit trail entries found</div>}
            {filteredTrail.slice(0, 80).map((e, i) => {
              const ec = e.severity === "critical" ? "#ef4444" : e.severity === "warning" ? "#f59e0b" : "#3b82f6";
              return (
                <div key={i} className="aud-trail-entry" style={{ "--te-c": ec }}>
                  <div className="aud-trail-dot" />
                  <div className="aud-trail-content">
                    <div className="aud-trail-row1">
                      <span className="aud-trail-type">{(e.type || "event").replace(/_/g, " ")}</span>
                      {e.severity && <span className={"aud-trail-sev " + e.severity}>{e.severity}</span>}
                      <span className="aud-trail-time">{fmt(e.timestamp || e.created_at)}</span>
                    </div>
                    <div className="aud-trail-msg">{e.message || e.description || e.details || "—"}</div>
                    {(e.namespace || e.username || e.resource) && (
                      <div className="aud-trail-meta">
                        {e.namespace && <span>ns: {e.namespace}</span>}
                        {e.resource && <span>res: {e.resource}</span>}
                        {e.username && <span>user: {e.username}</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ 4. ACTIVITY & ACTIONS ═══ */}
      {activeTab === "activity" && (
        <div className="aud-section">
          {auditLoading && <div className="aud-loading">Loading audit data…</div>}
          {auditError && <div className="aud-err">{String(auditErr?.message)}</div>}

          {!auditLoading && !auditError && (
            <>
              {/* Filter bar */}
              <div className="aud-filter-bar">
                <div className="aud-pill-group">
                  {STATUS_FILTERS.map((f) => (
                    <button key={f} className={"aud-pill" + (statusFilter === f ? " active" : "")} onClick={() => setStatusFilter(f)}>
                      {f}
                    </button>
                  ))}
                </div>
                <select className="aud-f-select" value={timeRange} onChange={(e) => setTimeRange(e.target.value)}>
                  {TIME_RANGES.map((t) => <option key={t.label} value={t.label}>{t.label}</option>)}
                </select>
                <select className="aud-f-select" value={actionType} onChange={(e) => setActionType(e.target.value)}>
                  {ACTION_TYPES.map((a) => <option key={a} value={a}>{a === "All" ? "All Actions" : a}</option>)}
                </select>
              </div>

              {/* Activity stats */}
              <div className="aud-act-stats">
                <div className="aud-act-stat" style={{ "--as-c": "#3b82f6" }}><span>{total}</span><label>Total</label></div>
                <div className="aud-act-stat" style={{ "--as-c": "#22c55e" }}><span>{successCount}</span><label>Success</label></div>
                <div className="aud-act-stat" style={{ "--as-c": "#ef4444" }}><span>{failedCount}</span><label>Failed</label></div>
                <div className="aud-act-stat" style={{ "--as-c": "#f59e0b" }}><span>{pending.length}</span><label>Pending</label></div>
              </div>

              <div className="aud-f-count">Showing {filteredExecuted.length} of {total} actions</div>

              {/* Executed actions table */}
              <div className="aud-table-wrap">
                <table className="aud-table">
                  <thead>
                    <tr>
                      <th>When</th><th>Action</th><th>Target</th><th>Namespace</th><th>User</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExecuted.length === 0 && <tr><td colSpan={6} className="aud-table-empty">No actions match filters</td></tr>}
                    {filteredExecuted.slice(0, 50).map((e, i) => (
                      <tr key={i}>
                        <td>{fmt(e.created_at || e.createdAt)}</td>
                        <td><span className="aud-action-pill">{e.action || "—"}</span></td>
                        <td>{e.target || "—"}</td>
                        <td className="aud-muted">{e.namespace || "—"}</td>
                        <td className="aud-muted">{e.user || e.initiator || "—"}</td>
                        <td><span className={"aud-status-pill " + (e.success ? "ok" : "fail")}>{e.success ? "success" : "failed"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pending approvals */}
              {pending.length > 0 && (
                <>
                  <h4 className="aud-sub-title">Pending Approvals ({pending.length})</h4>
                  <div className="aud-table-wrap">
                    <table className="aud-table">
                      <thead>
                        <tr><th>Action</th><th>Resource</th><th>Namespace</th><th>Requested By</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {pending.slice(0, 25).map((p, i) => (
                          <tr key={i}>
                            <td><span className="aud-action-pill pending">{p.action || "—"}</span></td>
                            <td>{p.resource_name || p.resourceName || "—"}</td>
                            <td className="aud-muted">{p.namespace || "—"}</td>
                            <td className="aud-muted">{p.user || p.requestedBy || "—"}</td>
                            <td><span className="aud-status-pill pending">pending</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══ 5. QUERY ANALYTICS ═══ */}
      {activeTab === "analytics" && (
        <div className="aud-section">
          <div className="aud-analytics-grid">
            <div className="aud-analytics-card" style={{ "--ac-c": "#8b5cf6" }}>
              <div className="aud-ac-val">{queryStats.totalQueries ?? queries.length ?? 0}</div>
              <div className="aud-ac-lbl">Total Queries</div>
            </div>
            <div className="aud-analytics-card" style={{ "--ac-c": "#06b6d4" }}>
              <div className="aud-ac-val">{queryStats.avgResponseTime != null ? `${Math.round(queryStats.avgResponseTime)}ms` : "—"}</div>
              <div className="aud-ac-lbl">Avg Response Time</div>
            </div>
            <div className="aud-analytics-card" style={{ "--ac-c": "#22c55e" }}>
              <div className="aud-ac-val">{queryStats.cacheHitRate != null ? `${queryStats.cacheHitRate}%` : "—"}</div>
              <div className="aud-ac-lbl">Cache Hit Rate</div>
            </div>
            <div className="aud-analytics-card" style={{ "--ac-c": "#f59e0b" }}>
              <div className="aud-ac-val">{queryStats.errorRate != null ? `${queryStats.errorRate}%` : "—"}</div>
              <div className="aud-ac-lbl">Error Rate</div>
            </div>
          </div>

          {queries.length > 0 && (
            <>
              <h4 className="aud-sub-title">Recent Queries</h4>
              <div className="aud-table-wrap">
                <table className="aud-table">
                  <thead>
                    <tr><th>When</th><th>Query</th><th>Response Time</th><th>Cache</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {queries.slice(0, 25).map((q, i) => (
                      <tr key={i}>
                        <td>{fmt(q.created_at || q.createdAt || q.timestamp)}</td>
                        <td className="aud-query-text">{q.query || q.prompt || q.text || "—"}</td>
                        <td>{q.responseTime || q.duration ? `${Math.round(q.responseTime || q.duration)}ms` : "—"}</td>
                        <td>{q.cached || q.cacheHit ? <span className="aud-cache-hit">HIT</span> : <span className="aud-cache-miss">MISS</span>}</td>
                        <td><span className={"aud-status-pill " + ((q.success !== false && q.status !== "failed") ? "ok" : "fail")}>{(q.success !== false && q.status !== "failed") ? "success" : "failed"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
