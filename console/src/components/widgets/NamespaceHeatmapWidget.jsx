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

const KIND_ICON = {
  Namespace: "🗂", Route: "🌐", Service: "🔀", Deployment: "📦", StatefulSet: "🗃", DaemonSet: "🛰",
  ReplicaSet: "🧬", Pod: "⬢", ConfigMap: "📄", Secret: "🔑", PVC: "💾", ServiceAccount: "👤",
  ImageStream: "🖼", RoleBinding: "🛡", NetworkPolicy: "🧱",
};

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

              {/* Hierarchical topology graph — Namespace → resources → RS → Pod */}
              {(!topo.graph || topo.graph.nodes.length <= 1) ? (
                <div style={{ color: "var(--muted,#94a3b8)", fontSize: "0.86rem" }}>No workloads found in this namespace.</div>
              ) : (
                <TopologyGraph graph={topo.graph} />
              )}

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

/* Hierarchical tree layout (deterministic) + SVG connectors, ACM-style. */
const NODE_W = 96, CIRCLE = 46, LEVEL_H = 118, PAD = 24;

function layoutTree(graph) {
  const map = new Map(graph.nodes.map((n) => [n.id, { ...n, children: [] }]));
  const hasParent = new Set();
  for (const e of graph.edges) {
    const p = map.get(e.source), c = map.get(e.target);
    if (p && c) { p.children.push(c); hasParent.add(c.id); }
  }
  const root = map.get((graph.nodes.find((n) => !hasParent.has(n.id)) || graph.nodes[0]).id);
  let cursor = 0;
  const place = (node, depth) => {
    node.y = depth * LEVEL_H + PAD;
    if (node.children.length === 0) { node.x = cursor * (NODE_W + 14) + PAD; cursor++; }
    else { node.children.forEach((c) => place(c, depth + 1)); node.x = (node.children[0].x + node.children[node.children.length - 1].x) / 2; }
  };
  place(root, 0);
  const all = [...map.values()];
  const width = Math.max(...all.map((n) => n.x)) + NODE_W + PAD;
  const height = Math.max(...all.map((n) => n.y)) + CIRCLE + 40 + PAD;
  const idx = new Map(all.map((n) => [n.id, n]));
  const edges = graph.edges.map((e) => ({ from: idx.get(e.source), to: idx.get(e.target) })).filter((e) => e.from && e.to);
  return { nodes: all, edges, width, height };
}

function TopologyGraph({ graph }) {
  const { nodes, edges, width, height } = layoutTree(graph);
  const cx = (n) => n.x + NODE_W / 2;
  return (
    <div style={{ overflow: "auto", border: "1px solid var(--border,#243045)", borderRadius: 10, background: "var(--card-bg,#0d1320)" }}>
      <div style={{ position: "relative", width, height, minWidth: "100%" }}>
        <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {edges.map((e, i) => {
            const x1 = cx(e.from), y1 = e.from.y + CIRCLE, x2 = cx(e.to), y2 = e.to.y;
            const my = (y1 + y2) / 2;
            return <path key={i} d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`} fill="none" stroke="var(--border,#334155)" strokeWidth="1.5" />;
          })}
        </svg>
        {nodes.map((n) => {
          const st = STATUS[n.status] || STATUS.idle;
          return (
            <div key={n.id} style={{ position: "absolute", left: n.x, top: n.y, width: NODE_W, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ position: "relative", width: CIRCLE, height: CIRCLE, borderRadius: "50%", background: st.bg, border: `2px solid ${st.c}`, display: "grid", placeItems: "center", fontSize: "1.15rem" }}>
                {KIND_ICON[n.kind] || "▫"}
                {/* status dot */}
                <span style={{ position: "absolute", top: -3, left: -3, width: 12, height: 12, borderRadius: "50%", background: st.c, border: "2px solid var(--card-bg,#0d1320)" }} />
                {/* count badge */}
                {n.count > 1 && <span style={{ position: "absolute", top: -5, right: -5, minWidth: 16, height: 16, padding: "0 3px", borderRadius: 8, background: "#3d5afe", color: "#fff", fontSize: "0.62rem", fontWeight: 800, display: "grid", placeItems: "center" }}>{n.count}</span>}
              </div>
              <div title={n.name} style={{ marginTop: 5, maxWidth: NODE_W, textAlign: "center", fontSize: "0.66rem", fontWeight: 600, color: "var(--fg,#cbd5e1)", padding: "2px 6px", borderRadius: 6, border: "1px solid var(--border,#243045)", background: "var(--bg,#131a28)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.name}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
