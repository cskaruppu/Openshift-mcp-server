import { useClusterQuery } from "../hooks/useClusterQuery";
import { useActiveCluster } from "../store/clusterStore";

/**
 * Audit view — executed actions, pending approvals, and query analytics for the
 * ACTIVE cluster. Cluster-scoped via useClusterQuery, so the audit trail can
 * never show another cluster's activity.
 */
export function AuditView() {
  const cluster = useActiveCluster();
  const { data, isLoading, isError, error } = useClusterQuery("/api/audit", { refetchInterval: 20_000 });

  const executed = data?.executed || [];
  const pending = data?.pending || [];
  const queries = data?.queries || [];
  const stats = data?.queryStats || {};

  const total = executed.length;
  const success = executed.filter((e) => e.success).length;
  const rate = total ? Math.round((success / total) * 100) : 0;

  return (
    <div className="view-pane">
      <div className="view-head">
        <h2>Audit &amp; Activity</h2>
        <span className="scope-chip">Scope: {cluster === "local" ? "Hub (local)" : cluster}</span>
      </div>

      {isLoading && <div className="metric muted">Loading audit data…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}

      {!isLoading && !isError && (
        <>
          <div className="stat-row">
            <Stat label="Executed" value={total} color="#3b82f6" />
            <Stat label="Success rate" value={`${rate}%`} color={rate >= 90 ? "#22c55e" : "#f59e0b"} />
            <Stat label="Pending approvals" value={pending.length} color={pending.length ? "#f59e0b" : "#22c55e"} />
            <Stat label="Queries" value={queries.length} color="#8b5cf6" />
            <Stat label="Cache hit" value={`${stats.cacheHitRate || 0}%`} color="#06b6d4" />
          </div>

          <h3 className="section-title">Recent Executed Actions</h3>
          <table className="audit-table">
            <thead>
              <tr><th>When</th><th>Action</th><th>Target</th><th>Namespace</th><th>Result</th></tr>
            </thead>
            <tbody>
              {executed.slice(0, 25).map((e, i) => (
                <tr key={i}>
                  <td>{fmt(e.created_at || e.createdAt)}</td>
                  <td>{e.action}</td>
                  <td>{e.target || "—"}</td>
                  <td>{e.namespace || "—"}</td>
                  <td><span className="pill" style={{ background: e.success ? "#22c55e" : "#ef4444" }}>{e.success ? "success" : "failed"}</span></td>
                </tr>
              ))}
              {executed.length === 0 && <tr><td colSpan={5} className="muted">No executed actions for this cluster</td></tr>}
            </tbody>
          </table>

          {pending.length > 0 && (
            <>
              <h3 className="section-title">Pending Approvals</h3>
              <table className="audit-table">
                <thead><tr><th>Action</th><th>Resource</th><th>Namespace</th><th>Status</th></tr></thead>
                <tbody>
                  {pending.slice(0, 15).map((p, i) => (
                    <tr key={i}>
                      <td>{p.action}</td>
                      <td>{p.resource_name || p.resourceName || "—"}</td>
                      <td>{p.namespace || "—"}</td>
                      <td><span className="pill" style={{ background: "#f59e0b" }}>{p.status || "pending"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="stat-box">
      <div className="stat-value" style={{ color }}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function fmt(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}
