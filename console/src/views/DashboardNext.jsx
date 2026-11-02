import { useState, useEffect, useCallback, useMemo } from "react";
import { useClusterQuery, REFRESH } from "../hooks/useClusterQuery";
import { useActiveCluster } from "../store/clusterStore";
import { useDashLayout } from "../store/dashLayoutStore";
import { normalize } from "../components/vuln/vulnModel";
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
import { GpuOverviewWidget } from "../components/widgets/GpuOverviewWidget";
import { EmergencyActionsWidget } from "../components/widgets/EmergencyActionsWidget";
import { CommandCenterBanner } from "../components/commandcenter/CommandCenter";

// The Dashboard, new layout — the same widgets as the classic Dashboard
// (views/DashboardView.jsx, unchanged), arranged in four zones so the first
// screen answers "is my cluster OK, and what needs me?":
//
//   1. Status strip     six numbers; each opens its classic card
//   2. Needs attention  one ranked list built from the same endpoints the
//                       classic cards read (alerts, pods, operators, images,
//                       backups, GitOps, CIS) — nothing is computed that a
//                       card does not already show
//   3. Posture          the score cards as compact rows
//   4. Explore          the detailed widgets, one tab at a time
//
// Emergency Actions opens from the toolbar in a side drawer. Chosen in
// Settings → Appearance; the "Classic layout" link switches back at once.

const VIEWS = {
  ops: { label: "Operations", tab: "capacity", first: ["health", "pods", "ops", "dr"] },
  sec: { label: "Security", tab: "security", first: ["security", "compliance"] },
  cap: { label: "Capacity", tab: "capacity", first: ["pods", "health"] },
};
const TABS = [["security", "Security"], ["capacity", "Capacity"], ["trends", "Trends"]];
const SEV_RANK = { critical: 0, high: 1, warning: 1, medium: 2, info: 3 };
const LAST_VISIT = "mcp-dash-last-visit";

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

function Spotlight({ item, onClose }) {
  useEffect(() => {
    if (!item) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [item, onClose]);
  if (!item) return null;
  return (
    <div className="dash-spotlight-overlay" onClick={onClose}>
      <div className="dash-spotlight-content" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={item.label}>
        <div className="dash-spotlight-header">
          <span className="dash-spotlight-label">{item.label}</span>
          <button className="dash-spotlight-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="dash-spotlight-body">{item.node}</div>
      </div>
    </div>
  );
}

function Drawer({ open, onClose, title, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="dn-drawer-veil" onClick={onClose}>
      <aside className="dn-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header><h3>{title}</h3><button className="dn-x" onClick={onClose} aria-label="Close">✕</button></header>
        <div className="dn-drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** A small ring for a 0–100 score; the number is always printed beside it. */
function Ring({ pct, tone }) {
  const r = 15, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, pct || 0));
  return (
    <svg className="dn-ring" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
      <circle cx="20" cy="20" r={r} fill="none" stroke={tone} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 20 20)" />
    </svg>
  );
}

const toneOf = (pct) => (pct == null ? "var(--text2)" : pct >= 80 ? "var(--ok)" : pct >= 60 ? "var(--warn)" : "var(--crit)");

export function DashboardNext() {
  const cluster = useActiveCluster();
  const setLayout = useDashLayout((s) => s.setLayout);
  const [view, setViewRaw] = useState(() => (VIEWS[store.get("mcp-dash-view", "ops")] ? store.get("mcp-dash-view", "ops") : "ops"));
  const [tab, setTabRaw] = useState(() => store.get("mcp-dash-tab", VIEWS[view].tab));
  const [spot, setSpot] = useState(null);
  const [actions, setActions] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const setView = (v) => { setViewRaw(v); store.set("mcp-dash-view", v); setTab(VIEWS[v].tab); };
  const setTab = (t) => { setTabRaw(t); store.set("mcp-dash-tab", t); };
  const closeSpot = useCallback(() => setSpot(null), []);
  const open = (label, node) => setSpot({ label, node });

  // "Since your last visit": remembered per browser and per cluster, moved on when the page closes.
  const visitKey = `${LAST_VISIT}:${cluster || "local"}`;
  const [lastVisit] = useState(() => Number(store.get(visitKey, 0)) || 0);
  useEffect(() => () => store.set(visitKey, String(Date.now())), [visitKey]);

  const useQ = (path, ms) => useClusterQuery(path, { refetchInterval: ms });
  const summary = useQ("/api/cluster/summary", REFRESH.VITALS).data;
  const opsData = useQ("/api/cluster/operators", REFRESH.VITALS).data;
  const alertsData = useQ("/api/alerts", REFRESH.VITALS).data;
  const podsData = useQ("/api/pods/issues", REFRESH.VITALS).data;
  const sec = useQ("/api/dashboard/security", REFRESH.SCAN).data;
  const git = useQ("/api/dashboard/gitops", REFRESH.SCAN).data;
  const dr = useQ("/api/dashboard/dr", REFRESH.SCAN).data;
  const img = useQ("/api/dashboard/image-vulns", REFRESH.SCAN).data;

  const ops = Array.isArray(opsData) ? opsData : [];
  const alerts = (alertsData?.alerts || []).filter((a) => !a.silenced);
  const pods = Array.isArray(podsData) ? podsData : [];
  const vulns = useMemo(() => (img && img.available !== false ? normalize(img) : null), [img]);
  const health = summary?.cluster?.health;
  const degraded = ops.filter((o) => o.health === "degraded");

  const cisCard = <ScoreWidget title="CIS Compliance / Security" path="/api/dashboard/security" linkTo="audit" linkLabel="View in Audit" refreshMs={REFRESH.SCAN}
    map={(d) => ({ value: `${d.score}/100`, grade: d.grade, label: `${(d.findings || []).length} findings` })} />;
  const gitCard = <ScoreWidget title="GitOps Sync Status" path="/api/dashboard/gitops"
    map={(d) => ({ value: `${d.synced}/${d.total}`, label: `${d.outOfSync || 0} out-of-sync · ${d.degraded || 0} degraded` })} />;
  const drCard = <ScoreWidget title="DR Readiness" path="/api/dashboard/dr"
    map={(d) => ({ value: `${d.score}/100`, grade: d.grade, label: `${d.completed || 0} backups · ${d.failed || 0} failed` })} />;

  // Zone 2: one list, each row from a card's own data, ranked by severity.
  const items = useMemo(() => {
    const out = [];
    for (const a of alerts.slice(0, 20)) {
      out.push({ k: `a-${a.name}-${a.namespace}-${a.since}`, cat: "health", sev: a.severity === "critical" ? "critical" : a.severity === "warning" ? "warning" : "info",
        title: a.summary || a.name, meta: [a.name, a.namespace].filter(Boolean).join(" · "), src: "Active Alerts", since: a.since,
        go: () => open("Active Alerts", <ActiveAlertsWidget />) });
    }
    const failing = pods.filter((p) => ["Failed", "CrashLoopBackOff"].includes(p.phase));
    for (const p of failing.slice(0, 5)) {
      const why = p.issues?.[0]?.reason;
      out.push({ k: `p-${p.namespace}-${p.name}`, cat: "pods", sev: "high", title: `${p.namespace}/${p.name} ${why ? `· ${why}` : `is ${p.phase}`}`,
        meta: p.issues?.[0]?.restarts ? `${p.issues[0].restarts} restarts` : p.node || "", src: "Pods at Risk",
        go: () => open("Pods at Risk", <PodsAtRiskWidget />) });
    }
    if (pods.length > failing.length) out.push({ k: "p-rest", cat: "pods", sev: "medium", title: `${pods.length - failing.length} more pods with issues`, meta: "pending, restarting or degraded", src: "Pods at Risk", go: () => open("Pods at Risk", <PodsAtRiskWidget />) });
    for (const o of degraded.slice(0, 3)) out.push({ k: `o-${o.name}`, cat: "ops", sev: "high", title: `Cluster operator ${o.name} is degraded`, meta: o.message || "", src: "Cluster Operators", go: () => open("Cluster Operators", <ClusterOperatorsWidget />) });
    if (vulns) {
      const now = vulns.images.filter((i) => i.priority.tier === "fix-now");
      if (now.length) out.push({ k: "img", cat: "security", sev: "critical", title: `${now.length} image${now.length === 1 ? "" : "s"} to fix now`,
        meta: `${vulns.kevCves} known-exploited CVEs · ${now.slice(0, 2).map((i) => (i.fullImage || i.image || "").split("/").pop()).join(", ")}`, src: "Image Vulnerabilities", go: () => setTab("security") });
    }
    if (dr && dr.failed > 0) out.push({ k: "dr", cat: "dr", sev: "medium", title: `${dr.failed} backup${dr.failed === 1 ? "" : "s"} failed`, meta: `DR readiness ${dr.score ?? "—"}/100`, src: "DR Readiness", go: () => open("DR Readiness", drCard) });
    if (git && git.outOfSync > 0) out.push({ k: "git", cat: "compliance", sev: "medium", title: `${git.outOfSync} GitOps app${git.outOfSync === 1 ? "" : "s"} out of sync`, meta: `${git.degraded || 0} degraded`, src: "GitOps Sync", go: () => open("GitOps Sync", gitCard) });
    const first = VIEWS[view].first;
    const rank = (i) => (SEV_RANK[i.sev] ?? 3) * 10 + (first.includes(i.cat) ? 0 : 5);
    return out.sort((a, b) => rank(a) - rank(b));
  }, [alerts, pods, degraded, vulns, dr, git, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const fresh = lastVisit ? alerts.filter((a) => a.since && new Date(a.since).getTime() > lastVisit).length : null;
  const shown = showAll ? items : items.slice(0, 5);

  const num = (n) => (n == null ? "—" : Number(n).toLocaleString());
  const nodes = summary?.nodes, podsSum = summary?.pods, ns = summary?.namespaces;
  const avail = ops.filter((o) => o.health === "available").length;
  const crit = alertsData?.summary?.critical || 0, warn = alertsData?.summary?.warning || 0;
  const tiles = [
    { k: "health", label: "Health", value: health ? health[0].toUpperCase() + health.slice(1) : "—", sub: summary?.cluster?.version ? `OpenShift ${summary.cluster.version}` : "cluster status",
      tone: health === "healthy" ? "ok" : health ? "warn" : "", node: <ClusterHealthWidget /> },
    { k: "nodes", label: "Nodes", value: nodes?.total ? `${nodes.ready} / ${nodes.total}` : "—", sub: nodes ? `${nodes.totalCPU || 0} CPU · ${nodes.totalMemGi || 0} Gi` : "ready",
      tone: nodes?.total && nodes.ready === nodes.total ? "ok" : nodes?.total ? "warn" : "", node: <NodesWidget /> },
    { k: "pods", label: "Pods", value: podsSum?.total ? num(podsSum.running) : "—", sub: podsSum?.total ? `running of ${num(podsSum.total)}` : "running",
      tone: podsSum?.total && podsSum.running === podsSum.total ? "ok" : podsSum?.total ? "warn" : "", node: <PodsWidget /> },
    { k: "ns", label: summary?.isOpenShift ? "Projects" : "Namespaces", value: ns ? num(ns.user) : "—", sub: ns ? `${num(ns.system)} system` : "user", tone: "", node: <NamespacesWidget /> },
    { k: "ops", label: "Operators", value: ops.length ? `${avail} / ${ops.length}` : "—", sub: ops.length ? (degraded.length ? `${degraded.length} degraded` : "all available") : "not OpenShift",
      tone: ops.length ? (degraded.length ? "warn" : "ok") : "", node: <ClusterOperatorsWidget /> },
    { k: "alerts", label: "Alerts", value: alertsData ? num(alerts.length) : "—", sub: `${crit} critical · ${warn} warning`, tone: crit ? "crit" : alerts.length ? "warn" : alertsData ? "ok" : "", node: <ActiveAlertsWidget /> },
  ];

  const posture = [
    { k: "cis", label: "CIS compliance", pct: sec?.score, value: sec?.score != null ? `${sec.score}` : "—", sub: sec?.grade ? `grade ${sec.grade} · ${(sec.findings || []).length} findings` : "not scanned yet", node: cisCard },
    { k: "git", label: "GitOps sync", pct: git?.total ? Math.round((git.synced / git.total) * 100) : null, value: git?.total ? `${git.synced}/${git.total}` : "—", sub: git?.total ? `${git.outOfSync || 0} out of sync` : "no GitOps apps found", node: gitCard },
    { k: "dr", label: "DR readiness", pct: dr?.score, value: dr?.score != null ? `${dr.score}` : "—", sub: dr?.score != null ? `${dr.completed || 0} backups · ${dr.failed || 0} failed` : dr?.message || "no backup tool found", node: drCard },
    // No score exists for images: the ring is full and its colour is the state (fix now / fix soon / clear).
    { k: "img", label: "Image risk", pct: vulns ? 100 : null, tone: vulns ? (vulns.tiers["fix-now"] ? "var(--crit)" : vulns.tiers["fix-soon"] ? "var(--warn)" : "var(--ok)") : undefined,
      value: vulns ? `${vulns.tiers["fix-now"] || 0}` : "—",
      sub: vulns ? `fix now · ${vulns.kevCves} known exploited` : "no CVE scan yet", go: () => setTab("security") },
  ];

  return (
    <div className="dash dn">
      <CommandCenterBanner />

      <div className="dn-bar">
        <div className="dn-seg" role="tablist" aria-label="View">
          {Object.entries(VIEWS).map(([k, v]) => <button key={k} role="tab" aria-selected={view === k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{v.label}</button>)}
        </div>
        <span className="dn-since">{fresh == null ? "First visit on this cluster" : fresh ? `${fresh} new alert${fresh === 1 ? "" : "s"} since your last visit` : "Nothing new since your last visit"}</span>
        <span className="dn-sp" />
        <button className="dn-link" onClick={() => setLayout("classic")} title="Back to the classic Dashboard (Settings → Appearance)">Classic layout</button>
        <button className="dn-actions" onClick={() => setActions(true)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.5l6.5 12h-13z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8 6v3.5M8 11.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          Actions
        </button>
      </div>

      {/* Zone 1 */}
      <section className="dn-strip" aria-label="Cluster status">
        {tiles.map((t) => (
          <button key={t.k} className={"dn-tile " + (t.tone || "")} onClick={() => open(t.label, t.node)} title={`Open ${t.label}`}>
            <span className="dn-tl">{t.label}</span>
            <b>{t.value}</b>
            <span className="dn-ts">{t.sub}</span>
          </button>
        ))}
      </section>

      <div className="dn-main">
        {/* Zone 2 */}
        <section className="dn-card dn-attn">
          <header><h2>Needs attention</h2><span>{items.length ? `${items.length} item${items.length === 1 ? "" : "s"} · most urgent first` : ""}</span></header>
          {!items.length && (
            <div className="dn-clear"><span className="dn-check" aria-hidden="true">✓</span><div><b>Nothing needs you right now</b><span>No firing alerts, failing pods, degraded operators, fix-now images or failed backups.</span></div></div>
          )}
          <ul className="dn-feed">
            {shown.map((i) => (
              <li key={i.k}>
                <button onClick={i.go}>
                  <span className={"dn-sev " + i.sev}>{i.sev === "warning" ? "Warning" : i.sev[0].toUpperCase() + i.sev.slice(1)}</span>
                  <span className="dn-it"><b>{i.title}</b><span>{[i.meta, i.src].filter(Boolean).join(" · ")}</span></span>
                  <span className="dn-go" aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
          {items.length > 5 && <button className="dn-more" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${items.length}`}</button>}
        </section>

        {/* Zone 3 */}
        <section className="dn-card dn-post">
          <header><h2>Posture</h2><span>click a row for the full card</span></header>
          <ul>
            {posture.map((p) => (
              <li key={p.k}>
                <button onClick={p.go || (() => open(p.label, p.node))}>
                  <Ring pct={p.pct} tone={p.tone || toneOf(p.pct)} />
                  <span className="dn-pl"><b>{p.label}</b><span>{p.sub}</span></span>
                  <span className="dn-pv" style={{ color: p.tone || toneOf(p.pct) }}>{p.value}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Zone 4 */}
      <section className="dn-card dn-explore">
        <div className="dn-tabs" role="tablist" aria-label="Explore">
          {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab === "security" && (
          <div className="dash-twin-row">
            <div className="dash-twin-card"><ImageVulnsWidget /></div>
            <div className="dash-twin-card"><AppChangesWidget /></div>
          </div>
        )}
        {tab === "capacity" && (
          <div className="dn-stack">
            <div className="dn-joined"><CapacityWidget /><ResourceOptimizationWidget /></div>
            <GpuOverviewWidget />
          </div>
        )}
        {tab === "trends" && (
          <div className="dn-stack">
            <div className="dash-twin-row">
              <div className="dash-twin-card"><HealthTimelineWidget /></div>
              <div className="dash-twin-card"><NodeTopologyWidget /></div>
            </div>
            <NamespaceHeatmapWidget />
          </div>
        )}
      </section>

      <Spotlight item={spot} onClose={closeSpot} />
      <Drawer open={actions} onClose={() => setActions(false)} title="Emergency actions"><EmergencyActionsWidget /></Drawer>
    </div>
  );
}
