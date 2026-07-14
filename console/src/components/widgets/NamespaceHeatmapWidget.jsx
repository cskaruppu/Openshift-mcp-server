import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../../api/client";
import { useClusterQuery } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";

const healthColor = (h) =>
  h === "critical" ? "#ef4444" : h === "warning" ? "#f59e0b" : h === "pending" ? "#3b82f6" : h === "healthy" ? "#22c55e" : "#444";

// Component status → color/label (topology nodes)
const STATUS = {
  healthy: { c: "#16a34a", bg: "rgba(22,163,74,0.12)", label: "Healthy" },
  warning: { c: "#d97706", bg: "rgba(217,119,6,0.12)", label: "Warning" },
  error: { c: "#dc2626", bg: "rgba(220,38,38,0.12)", label: "Error" },
  idle: { c: "#64748b", bg: "rgba(100,116,139,0.12)", label: "Idle" },
};

const KIND_ICON = { Route: "🌐", Service: "🔀", Deployment: "📦", StatefulSet: "🗃", DaemonSet: "🛰", Pod: "▪" };

/**
 * Namespace Heatmap — a colored cell per namespace for the active cluster.
 * Clicking a cell opens a workload-topology popup for that namespace.
 */
export function NamespaceHeatmapWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/namespaces");
  const [selected, setSelected] = useState(null);
  const raw = data?.namespaces ?? (Array.isArray(data) ? data : []);
  const namespaces = raw.slice().sort((a, b) => (b.podCount || 0) - (a.podCount || 0));
  const totalAllPods = data?.totalPods ?? 0;
  const systemPods = data?.systemPods ?? 0;

  const counts = { healthy: 0, warning: 0, critical: 0, pending: 0 };
  let userPods = 0;
  for (const ns of namespaces) {
    if (counts[ns.health] != null) counts[ns.health]++;
    userPods += ns.podCount || 0;
  }

  return (
    <div className="widget-card span-all">
      <div className="widget-title">Namespace Heatmap</div>
      <div className="widget-body">
        {isLoading && <div className="metric muted">Loading namespaces…</div>}
        {isError && <div className="metric err">{String(error.message)}</div>}
        {!isLoading && !isError && (
          <>
            <div className="metric-label" style={{ marginBottom: 10 }}>
              {namespaces.length} namespaces · {userPods} user pods{systemPods > 0 ? ` · ${systemPods} system` : ""}{totalAllPods > 0 ? ` · ${totalAllPods} total` : ""} ·
              <span style={{ color: "#22c55e" }}> {counts.healthy} healthy</span> ·
              <span style={{ color: "#f59e0b" }}> {counts.warning} warning</span> ·
              <span style={{ color: "#ef4444" }}> {counts.critical} critical</span>
              <span style={{ color: "var(--muted,#94a3b8)" }}> · click a namespace for its topology</span>
            </div>
            <div className="heatmap-grid">
              {namespaces.map((ns) => (
                <div
                  key={ns.name}
                  className="heatmap-cell"
                  style={{ background: healthColor(ns.health), cursor: "pointer" }}
                  title={`${ns.name} — ${ns.podCount || 0} pods (${ns.health || "idle"}) · click for topology`}
                  onClick={() => setSelected(ns.name)}
                >
                  <span className="heatmap-label">{ns.name}</span>
                  <span className="heatmap-count">{ns.podCount || 0}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {selected && <NamespaceTopologyModal namespace={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/* ── Topology popup for one namespace ── */
function NamespaceTopologyModal({ namespace, onClose }) {
  const cluster = useActiveCluster();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["/api/topology/namespace", namespace, cluster],
    queryFn: ({ signal }) => apiGet(`/api/topology/namespace?namespace=${encodeURIComponent(namespace)}`, { cluster, signal }),
    staleTime: 15_000,
  });
  const topo = data && !data.error ? data : null;
  const s = topo?.summary;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,14,25,0.62)", backdropFilter: "blur(7px)", WebkitBackdropFilter: "blur(7px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <style>{`@keyframes nt-pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}`}</style>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(960px, 96vw)", maxHeight: "88vh", background: "var(--bg,#0f1420)", border: "1px solid var(--border,#243045)", borderRadius: 16, boxShadow: "0 24px 70px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", overflow: "hidden", animation: "nt-pop .18s cubic-bezier(.2,.7,.3,1)" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--border,#243045)", background: "linear-gradient(90deg, rgba(61,90,254,0.10), rgba(14,165,160,0.06))" }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: "linear-gradient(135deg,#3d5afe,#0ea5a0)", display: "grid", placeItems: "center", fontSize: "1.15rem" }}>🧩</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: "1.05rem", color: "var(--fg,#e6ebf5)" }}>{namespace}</div>
            <div style={{ fontSize: "0.76rem", color: "var(--muted,#94a3b8)" }}>Workload topology · Route → Service → Workload → Pods</div>
          </div>
          <button onClick={() => refetch()} title="Refresh" style={{ padding: "6px 11px", borderRadius: 8, border: "1px solid var(--border,#243045)", background: "transparent", color: "var(--muted,#94a3b8)", fontWeight: 700, fontSize: "0.78rem", cursor: "pointer" }}>{isFetching ? "…" : "↻"}</button>
          <button onClick={onClose} title="Close" style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid var(--border,#243045)", background: "transparent", color: "var(--muted,#94a3b8)", fontSize: "1.1rem", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {/* Summary chips */}
        {s && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "12px 20px 0" }}>
            <Chip>{s.workloads} workloads</Chip>
            <Chip c="#16a34a">{s.healthy} healthy</Chip>
            {s.warning > 0 && <Chip c="#d97706">{s.warning} warning</Chip>}
            {s.error > 0 && <Chip c="#dc2626">{s.error} error</Chip>}
            <Chip>{s.services} services</Chip>
            <Chip>{s.routes} routes</Chip>
            <Chip>{s.runningPods}/{s.pods} pods ready</Chip>
            <span style={{ marginLeft: "auto", fontSize: "0.74rem", fontWeight: 800, color: topo.ok ? "#16a34a" : "#dc2626", alignSelf: "center" }}>{topo.ok ? "● No blocking errors" : "● Errors detected"}</span>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
          {isLoading && <div style={{ color: "var(--muted,#94a3b8)" }}>Building topology…</div>}
          {isError && <div style={{ color: "#dc2626" }}>{String(error.message)}</div>}
          {data?.error && <div style={{ color: "#dc2626" }}>{data.error}</div>}

          {topo && (
            <>
              {/* Issues (errors between components) */}
              {topo.issues.length > 0 && (
                <div style={{ marginBottom: 16, border: "1px solid var(--border,#243045)", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "8px 12px", fontWeight: 800, fontSize: "0.8rem", color: "var(--fg,#e6ebf5)", background: "rgba(220,38,38,0.08)" }}>⚠ {topo.issues.length} issue(s) between components</div>
                  <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
                    {topo.issues.map((i, k) => (
                      <div key={k} style={{ fontSize: "0.8rem", display: "flex", gap: 7, alignItems: "baseline" }}>
                        <span style={{ color: i.level === "error" ? "#dc2626" : "#d97706", fontWeight: 800 }}>{i.level === "error" ? "✗" : "!"}</span>
                        <span style={{ color: "var(--fg,#cbd5e1)" }}>{i.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Flow chains */}
              {topo.chains.length === 0 && topo.standalone.length === 0 && (
                <div style={{ color: "var(--muted,#94a3b8)", fontSize: "0.86rem" }}>No workloads found in this namespace.</div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {topo.chains.map((ch, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "stretch", gap: 8, flexWrap: "wrap", padding: 10, borderRadius: 10, border: "1px solid var(--border,#243045)", background: "var(--card-bg,#131a28)" }}>
                    {ch.route && <><Node n={ch.route} sub={ch.route.host} /> <Arrow /></>}
                    {ch.service && <><Node n={ch.service} sub={ch.service.selector && Object.keys(ch.service.selector).length ? `${ch.service.readyEndpoints}/${ch.service.matchedPods} endpoints` : "no selector"} /> {ch.workload && <Arrow />}</>}
                    {ch.workload ? <WorkloadNode w={ch.workload} /> : (ch.service && !ch.workload && <span style={{ alignSelf: "center", fontSize: "0.76rem", color: "#dc2626" }}>→ no matching workload</span>)}
                  </div>
                ))}
                {topo.standalone.length > 0 && (
                  <>
                    <div style={{ fontSize: "0.76rem", fontWeight: 800, color: "var(--muted,#94a3b8)", marginTop: 4 }}>Internal workloads (no Service in front)</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {topo.standalone.map((w, i) => <WorkloadNode key={i} w={w} />)}
                    </div>
                  </>
                )}
              </div>

              {/* Legend */}
              <div style={{ display: "flex", gap: 14, marginTop: 16, flexWrap: "wrap", fontSize: "0.72rem", color: "var(--muted,#94a3b8)" }}>
                {Object.entries(STATUS).map(([k, v]) => (
                  <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 3, background: v.c }} /> {v.label}</span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Chip({ children, c }) {
  return <span style={{ fontSize: "0.74rem", fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: c ? c + "22" : "rgba(148,163,184,0.14)", color: c || "var(--muted,#94a3b8)" }}>{children}</span>;
}

function Arrow() {
  return <span style={{ alignSelf: "center", color: "var(--muted,#5a6b85)", fontSize: "1.1rem", fontWeight: 700 }}>→</span>;
}

function Node({ n, sub }) {
  const st = STATUS[n.status] || STATUS.idle;
  return (
    <div style={{ minWidth: 140, borderRadius: 9, border: `1px solid ${st.c}55`, background: st.bg, padding: "8px 11px", alignSelf: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: "0.82rem" }}>{KIND_ICON[n.kind] || "▫"}</span>
        <span style={{ fontSize: "0.68rem", fontWeight: 800, color: st.c, textTransform: "uppercase", letterSpacing: "0.03em" }}>{n.kind}</span>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: st.c, marginLeft: "auto" }} />
      </div>
      <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--fg,#e6ebf5)", marginTop: 2, wordBreak: "break-all" }}>{n.name}</div>
      {sub && <div style={{ fontSize: "0.68rem", color: "var(--muted,#94a3b8)", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function WorkloadNode({ w }) {
  const st = STATUS[w.status] || STATUS.idle;
  return (
    <div style={{ minWidth: 168, borderRadius: 9, border: `1px solid ${st.c}55`, background: st.bg, padding: "8px 11px", alignSelf: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: "0.82rem" }}>{KIND_ICON[w.kind] || "📦"}</span>
        <span style={{ fontSize: "0.68rem", fontWeight: 800, color: st.c, textTransform: "uppercase", letterSpacing: "0.03em" }}>{w.kind}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.7rem", fontWeight: 800, color: st.c }}>{w.ready}/{w.desired}</span>
      </div>
      <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--fg,#e6ebf5)", marginTop: 2, wordBreak: "break-all" }}>{w.name}</div>
      {w.reasons.length > 0 && <div style={{ fontSize: "0.68rem", color: "#dc2626", marginTop: 2 }}>{w.reasons.join(", ")}</div>}
      {w.pods.some((p) => p.status !== "healthy") && (
        <div style={{ marginTop: 4, display: "flex", gap: 3, flexWrap: "wrap" }}>
          {w.pods.map((p, i) => <span key={i} title={`${p.name} · ${p.phase}${p.reasons.length ? " · " + p.reasons.join(",") : ""}`} style={{ width: 8, height: 8, borderRadius: 999, background: (STATUS[p.status] || STATUS.idle).c }} />)}
        </div>
      )}
    </div>
  );
}
