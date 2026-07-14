import { useState, useEffect, useRef, useMemo } from "react";
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
  const [expand, setExpand] = useState(false);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["/api/topology/namespace", namespace, cluster, expand],
    queryFn: ({ signal }) => apiGet(`/api/topology/namespace?namespace=${encodeURIComponent(namespace)}${expand ? "&expand=1" : ""}`, { cluster, signal }),
    staleTime: 15_000,
  });
  const topo = data && !data.error ? data : null;
  const s = topo?.summary;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,14,25,0.55)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <style>{`@keyframes nt-pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}`}</style>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(1000px, 96vw)", maxHeight: "90vh", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 16, boxShadow: "0 24px 70px rgba(0,0,0,0.35)", display: "flex", flexDirection: "column", overflow: "hidden", animation: "nt-pop .18s cubic-bezier(.2,.7,.3,1)", color: "#1e293b" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid #e2e8f0", background: "linear-gradient(90deg, rgba(61,90,254,0.08), rgba(14,165,160,0.05))" }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#3d5afe,#0ea5a0)", display: "grid", placeItems: "center", fontSize: "1.1rem" }}>🧩</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: "1.02rem", color: "#0f172a" }}>{namespace}</div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Namespace topology · Namespace → workloads → pods & resources</div>
          </div>
          <div style={{ display: "inline-flex", gap: 3, padding: 3, borderRadius: 9, background: "#f1f5f9", border: "1px solid #e2e8f0" }}>
            {[["", "Grouped"], ["1", "Expanded"]].map(([v, label]) => (
              <button key={label} onClick={() => setExpand(v === "1")} style={{ padding: "5px 11px", borderRadius: 7, border: "none", background: (expand ? "1" : "") === v ? "#3d5afe" : "transparent", color: (expand ? "1" : "") === v ? "#fff" : "#475569", fontWeight: 700, fontSize: "0.76rem", cursor: "pointer" }}>{label}</button>
            ))}
          </div>
          <button onClick={() => refetch()} title="Refresh" style={{ padding: "6px 11px", borderRadius: 8, border: "1px solid #e2e8f0", background: "#fff", color: "#475569", fontWeight: 700, fontSize: "0.78rem", cursor: "pointer" }}>{isFetching ? "…" : "↻"}</button>
          <button onClick={onClose} title="Close" style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid #e2e8f0", background: "#fff", color: "#475569", fontSize: "1.1rem", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {/* Summary chips */}
        {s && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "12px 18px 0" }}>
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
        <div style={{ flex: 1, overflow: "auto", padding: 18, background: "#ffffff" }}>
          {isLoading && <div style={{ color: "#64748b" }}>Building topology…</div>}
          {isError && <div style={{ color: "#dc2626" }}>{String(error.message)}</div>}
          {data?.error && <div style={{ color: "#dc2626" }}>{data.error}</div>}

          {topo && (
            <>
              {/* Issues (errors between components) */}
              {topo.issues.length > 0 && (
                <div style={{ marginBottom: 14, border: "1px solid #fecaca", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "8px 12px", fontWeight: 800, fontSize: "0.8rem", color: "#b91c1c", background: "#fef2f2" }}>⚠ {topo.issues.length} issue(s) between components</div>
                  <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
                    {topo.issues.map((i, k) => (
                      <div key={k} style={{ fontSize: "0.8rem", display: "flex", gap: 7, alignItems: "baseline" }}>
                        <span style={{ color: i.level === "error" ? "#dc2626" : "#d97706", fontWeight: 800 }}>{i.level === "error" ? "✗" : "!"}</span>
                        <span style={{ color: "#334155" }}>{i.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Interactive hierarchical topology graph */}
              {(!topo.graph || topo.graph.nodes.length <= 1) ? (
                <div style={{ color: "#64748b", fontSize: "0.86rem" }}>No workloads found in this namespace.</div>
              ) : (
                <TopologyGraph graph={topo.graph} />
              )}

              {/* Legend */}
              <div style={{ display: "flex", gap: 14, marginTop: 12, flexWrap: "wrap", fontSize: "0.72rem", color: "#64748b" }}>
                {Object.entries(STATUS).map(([k, v]) => (
                  <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 3, background: v.c }} /> {v.label}</span>
                ))}
                <span style={{ marginLeft: "auto" }}>drag background to pan · scroll to zoom · drag a node to move it</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Chip({ children, c }) {
  return <span style={{ fontSize: "0.74rem", fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: c ? c + "1f" : "#f1f5f9", color: c || "#475569", border: `1px solid ${c ? c + "44" : "#e2e8f0"}` }}>{children}</span>;
}

/* Deterministic hierarchical tree layout. */
const NODE_W = 104, CIRCLE = 44, LEVEL_H = 116, PAD = 30, LEAF_GAP = 16;

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
    if (node.children.length === 0) { node.x = cursor * (NODE_W + LEAF_GAP) + PAD; cursor++; }
    else { node.children.forEach((c) => place(c, depth + 1)); node.x = (node.children[0].x + node.children[node.children.length - 1].x) / 2; }
  };
  place(root, 0);
  const all = [...map.values()];
  const width = Math.max(...all.map((n) => n.x)) + NODE_W + PAD;
  const height = Math.max(...all.map((n) => n.y)) + CIRCLE + 46 + PAD;
  const idx = new Map(all.map((n) => [n.id, n]));
  const edges = graph.edges.map((e) => ({ from: e.source, to: e.target })).filter((e) => idx.get(e.from) && idx.get(e.to));
  return { nodes: all, edges, width, height, idx };
}

/* Interactive (pan / zoom / drag-node) topology canvas — light, readable. */
function TopologyGraph({ graph }) {
  const base = useMemo(() => layoutTree(graph), [graph]);
  const [pos, setPos] = useState({});           // node id → {x,y} overrides
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const vpRef = useRef(null);
  const drag = useRef(null);
  const viewRef = useRef(view); viewRef.current = view;

  useEffect(() => { setPos({}); setView({ z: 1, x: 0, y: 0 }); }, [graph]);

  useEffect(() => {
    const move = (e) => {
      const d = drag.current; if (!d) return;
      if (d.type === "pan") setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
      else { const z = viewRef.current.z; setPos((p) => ({ ...p, [d.id]: { x: d.ox + (e.clientX - d.sx) / z, y: d.oy + (e.clientY - d.sy) / z } })); }
    };
    const up = () => { drag.current = null; };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
  }, []);

  const nodePos = (n) => pos[n.id] || { x: n.x, y: n.y };
  const cx = (n) => nodePos(n).x + NODE_W / 2;

  // Non-passive wheel listener so we can preventDefault and zoom (not scroll).
  useEffect(() => {
    const el = vpRef.current; if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      setView((v) => {
        const z2 = Math.min(2.4, Math.max(0.3, v.z * (e.deltaY < 0 ? 1.12 : 0.89)));
        const wx = (mx - v.x) / v.z, wy = (my - v.y) / v.z;
        return { z: z2, x: mx - wx * z2, y: my - wy * z2 };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const startPan = (e) => { drag.current = { type: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }; };
  const startNode = (e, n) => { e.stopPropagation(); const p = nodePos(n); drag.current = { type: "node", id: n.id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y }; };
  const zoomBy = (f) => setView((v) => ({ ...v, z: Math.min(2.4, Math.max(0.3, v.z * f)) }));
  const reset = () => { setPos({}); setView({ z: 1, x: 0, y: 0 }); };

  const btn = { width: 28, height: 28, borderRadius: 7, border: "1px solid #e2e8f0", background: "#fff", color: "#334155", fontWeight: 800, fontSize: "0.9rem", cursor: "pointer", lineHeight: 1 };

  return (
    <div style={{ position: "relative", height: 470, border: "1px solid #e2e8f0", borderRadius: 12, background: "#f8fafc", overflow: "hidden" }}>
      <div ref={vpRef} onMouseDown={startPan} style={{ position: "absolute", inset: 0, cursor: "grab" }}>
        <div style={{ position: "absolute", transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg width={base.width} height={base.height} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
            {base.edges.map((e, i) => {
              const from = base.idx.get(e.from), to = base.idx.get(e.to);
              const x1 = cx(from), y1 = nodePos(from).y + CIRCLE, x2 = cx(to), y2 = nodePos(to).y;
              const my = (y1 + y2) / 2;
              const bad = (to.status === "error");
              return <path key={i} d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`} fill="none" stroke={bad ? "#fca5a5" : "#cbd5e1"} strokeWidth="1.6" />;
            })}
          </svg>
          {base.nodes.map((n) => {
            const st = STATUS[n.status] || STATUS.idle;
            const p = nodePos(n);
            return (
              <div key={n.id} onMouseDown={(e) => startNode(e, n)} style={{ position: "absolute", left: p.x, top: p.y, width: NODE_W, display: "flex", flexDirection: "column", alignItems: "center", cursor: "grab", userSelect: "none" }}>
                <div style={{ position: "relative", width: CIRCLE, height: CIRCLE, borderRadius: "50%", background: "#fff", border: `2.5px solid ${st.c}`, display: "grid", placeItems: "center", fontSize: "1.05rem", boxShadow: "0 1px 4px rgba(15,23,42,0.12)" }}>
                  {KIND_ICON[n.kind] || "▫"}
                  <span title={st.label} style={{ position: "absolute", top: -3, left: -3, width: 12, height: 12, borderRadius: "50%", background: st.c, border: "2px solid #fff" }} />
                  {n.count > 1 && <span style={{ position: "absolute", top: -6, right: -6, minWidth: 16, height: 16, padding: "0 3px", borderRadius: 8, background: "#3d5afe", color: "#fff", fontSize: "0.62rem", fontWeight: 800, display: "grid", placeItems: "center", border: "1.5px solid #fff" }}>{n.count}</span>}
                </div>
                <div style={{ fontSize: "0.6rem", fontWeight: 800, color: st.c, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 4 }}>{n.kind}</div>
                <div title={n.name} style={{ maxWidth: NODE_W + 8, textAlign: "center", fontSize: "0.68rem", fontWeight: 600, color: "#1e293b", padding: "2px 7px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{n.name}</div>
                {n.replicas && <div style={{ fontSize: "0.62rem", fontWeight: 700, color: st.c, marginTop: 1 }}>{n.replicas}</div>}
                {n.reasons && n.reasons.length > 0 && <div style={{ fontSize: "0.6rem", color: "#dc2626", marginTop: 1, maxWidth: NODE_W + 8, textAlign: "center" }}>{n.reasons.join(", ")}</div>}
              </div>
            );
          })}
        </div>
      </div>
      {/* Controls */}
      <div style={{ position: "absolute", top: 10, right: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <button style={btn} onClick={() => zoomBy(1.2)} title="Zoom in">+</button>
        <button style={btn} onClick={() => zoomBy(0.83)} title="Zoom out">−</button>
        <button style={{ ...btn, fontSize: "0.7rem" }} onClick={reset} title="Reset view">⟳</button>
      </div>
      <div style={{ position: "absolute", bottom: 8, left: 10, fontSize: "0.68rem", color: "#94a3b8", background: "rgba(255,255,255,0.7)", padding: "2px 7px", borderRadius: 6 }}>{Math.round(view.z * 100)}%</div>
    </div>
  );
}
