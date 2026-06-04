import { useState, useMemo, useCallback } from "react";
import { useClusterQuery } from "../hooks/useClusterQuery";
import { useActiveCluster } from "../store/clusterStore";

/**
 * Audit view — executed actions, pending approvals, and query analytics for the
 * ACTIVE cluster. Cluster-scoped via useClusterQuery, so the audit trail can
 * never show another cluster's activity.
 *
 * Redesigned to match the legacy dashboard Audit section with filter pills,
 * time-range selector, export buttons, action-type dropdown, query analytics,
 * and improved table styling.
 */

/* ── constants ── */
const STATUS_FILTERS = ["All", "Success", "Failed", "ITSM"];
const TIME_RANGES = [
  { label: "Last Hour", ms: 3_600_000 },
  { label: "Last 24h", ms: 86_400_000 },
  { label: "Last 7 Days", ms: 604_800_000 },
  { label: "All Time", ms: 0 },
];
const ACTION_TYPES = ["All", "Scale", "Restart", "Delete", "Patch", "Create", "Update", "Rollback", "Approve", "Deny"];

/* ── styles (inline, scoped to this view) ── */
const S = {
  filterBar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
    marginBottom: 18,
  },
  pillGroup: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
  },
  pill: (active) => ({
    padding: "5px 14px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid",
    borderColor: active ? "#3b82f6" : "#334155",
    background: active ? "#3b82f620" : "transparent",
    color: active ? "#3b82f6" : "#a1a1aa",
    transition: "all .15s",
    userSelect: "none",
  }),
  select: {
    background: "#1a1d27",
    color: "#e4e4e7",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "5px 10px",
    fontSize: 12,
    cursor: "pointer",
    outline: "none",
  },
  exportBtn: {
    padding: "5px 14px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid #334155",
    background: "#1e293b80",
    color: "#a1a1aa",
    transition: "all .15s",
  },
  statBox: (color) => ({
    background: "#1e293b80",
    border: "1px solid #334155",
    borderLeft: `3px solid ${color}`,
    borderRadius: 10,
    padding: "12px 14px",
    minWidth: 120,
    flex: "1 1 120px",
  }),
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  },
  th: {
    textAlign: "left",
    color: "#a1a1aa",
    fontWeight: 600,
    padding: "10px 12px",
    borderBottom: "1px solid #2a2d3a",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: ".5px",
  },
  td: {
    padding: "10px 12px",
    borderBottom: "1px solid #1c2128",
  },
  statusPill: (status) => {
    const map = {
      success: { bg: "#22c55e22", color: "#22c55e", border: "#22c55e44" },
      failed: { bg: "#ef444422", color: "#ef4444", border: "#ef444444" },
      pending: { bg: "#f59e0b22", color: "#f59e0b", border: "#f59e0b44" },
    };
    const s = map[status] || map.pending;
    return {
      display: "inline-block",
      padding: "2px 10px",
      borderRadius: 9999,
      fontSize: 11,
      fontWeight: 600,
      background: s.bg,
      color: s.color,
      border: `1px solid ${s.border}`,
    };
  },
  analyticsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
    marginTop: 8,
  },
  analyticsCard: {
    background: "#1e293b80",
    border: "1px solid #334155",
    borderRadius: 10,
    padding: "16px 18px",
    textAlign: "center",
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  headerRight: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    textTransform: "uppercase",
    letterSpacing: ".5px",
    color: "#a1a1aa",
    margin: "22px 0 8px",
    fontWeight: 600,
  },
  emptyRow: {
    color: "#a1a1aa",
    textAlign: "center",
    padding: 16,
  },
};

/* ── helpers ── */
function fmt(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── sub-components ── */
function Stat({ label, value, color }) {
  return (
    <div style={S.statBox(color)}>
      <div style={{ fontSize: 26, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: "#a1a1aa", marginTop: 4 }}>{label}</div>
    </div>
  );
}

function StatusPill({ status }) {
  const normalized =
    status === true || status === "success"
      ? "success"
      : status === false || status === "failed"
      ? "failed"
      : "pending";
  return <span style={S.statusPill(normalized)}>{normalized}</span>;
}

function HoverRow({ children, style }) {
  const [hovered, setHovered] = useState(false);
  return (
    <tr
      style={{
        ...style,
        background: hovered ? "#ffffff08" : "transparent",
        transition: "background .12s",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </tr>
  );
}

/* ── main component ── */
export function AuditView() {
  const cluster = useActiveCluster();
  const { data, isLoading, isError, error } = useClusterQuery("/api/audit", {
    refetchInterval: 20_000,
  });

  /* --- state --- */
  const [statusFilter, setStatusFilter] = useState("All");
  const [timeRange, setTimeRange] = useState("All Time");
  const [actionType, setActionType] = useState("All");

  /* --- raw data --- */
  const executed = data?.executed || [];
  const pending = data?.pending || [];
  const queries = data?.queries || [];
  const queryStats = data?.queryStats || {};

  /* --- derived / filtered data --- */
  const filteredExecuted = useMemo(() => {
    let list = [...executed];

    // time range
    const range = TIME_RANGES.find((t) => t.label === timeRange);
    if (range && range.ms > 0) {
      const cutoff = Date.now() - range.ms;
      list = list.filter((e) => {
        const ts = e.created_at || e.createdAt;
        return ts && new Date(ts).getTime() >= cutoff;
      });
    }

    // status filter
    if (statusFilter === "Success") {
      list = list.filter((e) => e.success === true);
    } else if (statusFilter === "Failed") {
      list = list.filter((e) => e.success === false);
    } else if (statusFilter === "ITSM") {
      list = list.filter((e) => e.itsm || e.ticketId || e.itsmRef);
    }

    // action type
    if (actionType !== "All") {
      list = list.filter(
        (e) => (e.action || "").toLowerCase() === actionType.toLowerCase()
      );
    }

    return list;
  }, [executed, statusFilter, timeRange, actionType]);

  const total = executed.length;
  const successCount = executed.filter((e) => e.success).length;
  const failedCount = executed.filter((e) => e.success === false).length;
  const rate = total ? Math.round((successCount / total) * 100) : 0;

  /* --- export handlers --- */
  const handleExportJSON = useCallback(() => {
    const payload = {
      cluster,
      exported: new Date().toISOString(),
      filters: { statusFilter, timeRange, actionType },
      executed: filteredExecuted,
      pending,
      queries,
      queryStats,
    };
    downloadFile(JSON.stringify(payload, null, 2), `audit-${cluster}-${Date.now()}.json`, "application/json");
  }, [cluster, statusFilter, timeRange, actionType, filteredExecuted, pending, queries, queryStats]);

  const handleExportCSV = useCallback(() => {
    const headers = ["Timestamp", "Action", "Target", "Namespace", "Status", "User", "Details"];
    const rows = filteredExecuted.map((e) => [
      e.created_at || e.createdAt || "",
      e.action || "",
      e.target || "",
      e.namespace || "",
      e.success ? "success" : "failed",
      e.user || e.initiator || "",
      e.details || e.message || "",
    ]);
    const csv = [headers, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadFile(csv, `audit-${cluster}-${Date.now()}.csv`, "text/csv");
  }, [cluster, filteredExecuted]);

  return (
    <div className="view-pane">
      {/* ── Header ── */}
      <div style={S.headerRow}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Audit &amp; Activity</h2>
        <span className="scope-chip">
          Scope: {cluster === "local" ? "Hub (local)" : cluster}
        </span>
        <div style={S.headerRight}>
          <button
            style={S.exportBtn}
            onClick={handleExportJSON}
            title="Export filtered audit data as JSON"
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#3b82f6"; e.currentTarget.style.color = "#e4e4e7"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#334155"; e.currentTarget.style.color = "#a1a1aa"; }}
          >
            Export JSON
          </button>
          <button
            style={S.exportBtn}
            onClick={handleExportCSV}
            title="Export filtered audit data as CSV"
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#3b82f6"; e.currentTarget.style.color = "#e4e4e7"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#334155"; e.currentTarget.style.color = "#a1a1aa"; }}
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div style={S.filterBar}>
        {/* Status pills */}
        <div style={S.pillGroup}>
          {STATUS_FILTERS.map((f) => (
            <span
              key={f}
              style={S.pill(statusFilter === f)}
              onClick={() => setStatusFilter(f)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && setStatusFilter(f)}
            >
              {f}
            </span>
          ))}
        </div>

        {/* Time range dropdown */}
        <select
          style={S.select}
          value={timeRange}
          onChange={(e) => setTimeRange(e.target.value)}
          aria-label="Time range"
        >
          {TIME_RANGES.map((t) => (
            <option key={t.label} value={t.label}>
              {t.label}
            </option>
          ))}
        </select>

        {/* Action type dropdown */}
        <select
          style={S.select}
          value={actionType}
          onChange={(e) => setActionType(e.target.value)}
          aria-label="Action type"
        >
          {ACTION_TYPES.map((a) => (
            <option key={a} value={a}>
              {a === "All" ? "All Actions" : a}
            </option>
          ))}
        </select>
      </div>

      {/* ── Loading / Error ── */}
      {isLoading && <div className="metric muted">Loading audit data...</div>}
      {isError && (
        <div className="metric err">{String(error.message)}</div>
      )}

      {!isLoading && !isError && (
        <>
          {/* ── Stat Boxes ── */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
            <Stat label="Total Executed" value={total} color="#3b82f6" />
            <Stat
              label="Success Rate"
              value={`${rate}%`}
              color={rate >= 90 ? "#22c55e" : rate >= 70 ? "#f59e0b" : "#ef4444"}
            />
            <Stat label="Failed" value={failedCount} color="#ef4444" />
            <Stat
              label="Pending Approvals"
              value={pending.length}
              color={pending.length ? "#f59e0b" : "#22c55e"}
            />
            <Stat
              label="Queries"
              value={queries.length}
              color="#8b5cf6"
            />
          </div>

          {/* ── Filtered count ── */}
          <div
            style={{
              fontSize: 12,
              color: "#a1a1aa",
              marginBottom: 6,
            }}
          >
            Showing {filteredExecuted.length} of {total} executed actions
            {statusFilter !== "All" && <> &middot; Filter: <strong style={{ color: "#3b82f6" }}>{statusFilter}</strong></>}
            {actionType !== "All" && <> &middot; Type: <strong style={{ color: "#3b82f6" }}>{actionType}</strong></>}
            {timeRange !== "All Time" && <> &middot; Range: <strong style={{ color: "#3b82f6" }}>{timeRange}</strong></>}
          </div>

          {/* ── Executed Actions Table ── */}
          <h3 style={S.sectionTitle}>Recent Executed Actions</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>When</th>
                  <th style={S.th}>Action</th>
                  <th style={S.th}>Target</th>
                  <th style={S.th}>Namespace</th>
                  <th style={S.th}>User</th>
                  <th style={S.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredExecuted.length === 0 && (
                  <tr>
                    <td colSpan={6} style={S.emptyRow}>
                      No executed actions match the current filters
                    </td>
                  </tr>
                )}
                {filteredExecuted.slice(0, 50).map((e, i) => (
                  <HoverRow key={i}>
                    <td style={S.td}>{fmt(e.created_at || e.createdAt)}</td>
                    <td style={S.td}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 6,
                          fontSize: 11,
                          fontWeight: 600,
                          background: "#3b82f618",
                          color: "#60a5fa",
                          border: "1px solid #3b82f630",
                        }}
                      >
                        {e.action || "—"}
                      </span>
                    </td>
                    <td style={S.td}>{e.target || "—"}</td>
                    <td style={{ ...S.td, color: "#a1a1aa" }}>{e.namespace || "—"}</td>
                    <td style={{ ...S.td, color: "#a1a1aa", fontSize: 12 }}>{e.user || e.initiator || "—"}</td>
                    <td style={S.td}>
                      <StatusPill status={e.success} />
                    </td>
                  </HoverRow>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Pending Approvals Table ── */}
          {pending.length > 0 && (
            <>
              <h3 style={S.sectionTitle}>Pending Approvals</h3>
              <div style={{ overflowX: "auto" }}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>Action</th>
                      <th style={S.th}>Resource</th>
                      <th style={S.th}>Namespace</th>
                      <th style={S.th}>Requested By</th>
                      <th style={S.th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.slice(0, 25).map((p, i) => (
                      <HoverRow key={i}>
                        <td style={S.td}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 600,
                              background: "#f59e0b18",
                              color: "#fbbf24",
                              border: "1px solid #f59e0b30",
                            }}
                          >
                            {p.action || "—"}
                          </span>
                        </td>
                        <td style={S.td}>{p.resource_name || p.resourceName || "—"}</td>
                        <td style={{ ...S.td, color: "#a1a1aa" }}>{p.namespace || "—"}</td>
                        <td style={{ ...S.td, color: "#a1a1aa", fontSize: 12 }}>{p.user || p.requestedBy || "—"}</td>
                        <td style={S.td}>
                          <StatusPill status={p.status || "pending"} />
                        </td>
                      </HoverRow>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ── Query Analytics ── */}
          <h3 style={S.sectionTitle}>Query Analytics</h3>
          <div style={S.analyticsGrid}>
            <div style={S.analyticsCard}>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#8b5cf6" }}>
                {queryStats.totalQueries ?? queries.length ?? 0}
              </div>
              <div style={{ fontSize: 11, color: "#a1a1aa", marginTop: 4 }}>Total Queries</div>
            </div>
            <div style={S.analyticsCard}>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#06b6d4" }}>
                {fmtDuration(queryStats.avgResponseTime)}
              </div>
              <div style={{ fontSize: 11, color: "#a1a1aa", marginTop: 4 }}>Avg Response Time</div>
            </div>
            <div style={S.analyticsCard}>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#22c55e" }}>
                {queryStats.cacheHitRate != null ? `${queryStats.cacheHitRate}%` : "—"}
              </div>
              <div style={{ fontSize: 11, color: "#a1a1aa", marginTop: 4 }}>Cache Hit Rate</div>
            </div>
            <div style={S.analyticsCard}>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#f59e0b" }}>
                {queryStats.errorRate != null ? `${queryStats.errorRate}%` : "—"}
              </div>
              <div style={{ fontSize: 11, color: "#a1a1aa", marginTop: 4 }}>Error Rate</div>
            </div>
          </div>

          {/* ── Recent Queries Table ── */}
          {queries.length > 0 && (
            <>
              <h3 style={S.sectionTitle}>Recent Queries</h3>
              <div style={{ overflowX: "auto" }}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>When</th>
                      <th style={S.th}>Query</th>
                      <th style={S.th}>Response Time</th>
                      <th style={S.th}>Cache</th>
                      <th style={S.th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queries.slice(0, 25).map((q, i) => (
                      <HoverRow key={i}>
                        <td style={S.td}>{fmt(q.created_at || q.createdAt || q.timestamp)}</td>
                        <td style={{ ...S.td, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {q.query || q.prompt || q.text || "—"}
                        </td>
                        <td style={S.td}>{fmtDuration(q.responseTime || q.duration)}</td>
                        <td style={S.td}>
                          {q.cached || q.cacheHit ? (
                            <span style={{ color: "#22c55e", fontSize: 11, fontWeight: 600 }}>HIT</span>
                          ) : (
                            <span style={{ color: "#a1a1aa", fontSize: 11 }}>MISS</span>
                          )}
                        </td>
                        <td style={S.td}>
                          <StatusPill status={q.success != null ? q.success : q.status || "success"} />
                        </td>
                      </HoverRow>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
