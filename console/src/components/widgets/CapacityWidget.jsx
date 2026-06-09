import { useMemo } from "react";
import { useClusterQuery, REFRESH } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";
import { useChatStore } from "../../store/chatStore";
import { useViewStore } from "../../store/viewStore";
import { WidgetCard } from "../WidgetCard";
import { formatNumber } from "../../utils/format";

/* Utilization → color: low is wasteful (blue/amber), healthy mid (green),
   high is hot (red). Restrained, threshold-only palette — not a rainbow. */
function utilTone(pct) {
  if (pct == null) return "var(--text2)";
  if (pct >= 90) return "#ef4444";
  if (pct >= 75) return "#f59e0b";
  if (pct >= 15) return "#22c55e";
  return "#3b82f6"; // very low = over-provisioned
}
/* Headroom → color: lots of headroom is good (green), little is dangerous. */
function headroomTone(pct) {
  if (pct == null) return "var(--text2)";
  if (pct >= 30) return "#22c55e";
  if (pct >= 15) return "#f59e0b";
  return "#ef4444";
}

/** Compact SVG ring gauge (matches the audit compliance ring aesthetic). */
function Gauge({ value, label, sub }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const r = 34, c = 2 * Math.PI * r;
  const tone = utilTone(value);
  return (
    <div className="cap-gauge">
      <svg viewBox="0 0 80 80" width="80" height="80">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--border)" strokeWidth="7" />
        <circle
          cx="40" cy="40" r={r} fill="none" stroke={tone} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)}
          style={{ transform: "rotate(-90deg)", transformOrigin: "center", transition: "stroke-dashoffset .8s ease, stroke .4s" }}
        />
      </svg>
      <div className="cap-gauge-center">
        <span className="cap-gauge-val" style={{ color: tone }}>{value == null ? "—" : `${value}%`}</span>
      </div>
      <div className="cap-gauge-label">{label}</div>
      {sub && <div className="cap-gauge-sub">{sub}</div>}
    </div>
  );
}

/** Requested-vs-allocatable bar — the overcommit / capacity-planning signal. */
function HeadroomBar({ label, requestedPct, headroomPct }) {
  const reqTone = headroomTone(headroomPct);
  return (
    <div className="cap-hr">
      <div className="cap-hr-top">
        <span className="cap-hr-label">{label}</span>
        <span className="cap-hr-val">
          {requestedPct == null ? "—" : `${requestedPct}% requested`}
          {headroomPct != null && <span className="cap-hr-free" style={{ color: reqTone }}> · {headroomPct}% free</span>}
        </span>
      </div>
      <div className="cap-hr-track">
        <div className="cap-hr-fill" style={{ width: `${Math.min(100, requestedPct || 0)}%`, background: reqTone }} />
      </div>
    </div>
  );
}

export function CapacityWidget() {
  const cluster = useActiveCluster();
  const setSeed = useChatStore((s) => s.setSeed);
  const setActiveView = useViewStore((s) => s.setActiveView);

  const { data: summary, isLoading: l1, isError: e1 } = useClusterQuery("/api/cluster/summary", { refetchInterval: REFRESH.VITALS });
  const { data: nm } = useClusterQuery("/api/node-metrics", { refetchInterval: REFRESH.STANDARD });
  const { data: opt } = useClusterQuery("/api/dashboard/optimization", { refetchInterval: REFRESH.SCAN });
  const { data: issues } = useClusterQuery("/api/pods/issues", { refetchInterval: REFRESH.VITALS });
  const { data: nodes } = useClusterQuery("/api/nodes", { refetchInterval: REFRESH.STANDARD });

  const view = useMemo(() => {
    // Actual utilization — sum real usage across nodes ÷ cluster capacity.
    const metrics = Array.isArray(nm) ? nm : nm?.metrics || nm?.nodes || [];
    let cpuUsed = 0, memUsed = 0;
    for (const n of metrics) {
      cpuUsed += parseFloat(n.cpuUsage) || 0;     // "2.45 cores" → 2.45
      memUsed += parseFloat(n.memoryUsage) || 0;  // "12.5 Gi"   → 12.5
    }
    const cpuCap = summary?.nodes?.totalCPU || 0;
    const memCap = summary?.nodes?.totalMemGi || 0;
    const cpuPct = cpuCap ? Math.round((cpuUsed / cpuCap) * 100) : null;
    const memPct = memCap ? Math.round((memUsed / memCap) * 100) : null;

    // Requested headroom (overcommit signal) from the optimization analysis.
    const cpuHeadroom = opt?.cpuHeadroom ?? null;
    const memHeadroom = opt?.memHeadroom ?? null;
    const cpuReq = cpuHeadroom == null ? null : Math.max(0, 100 - cpuHeadroom);
    const memReq = memHeadroom == null ? null : Math.max(0, 100 - memHeadroom);

    // Pod failures grouped by reason.
    const issuesArr = Array.isArray(issues) ? issues : issues?.pods || [];
    const fail = { crash: 0, oom: 0, imgpull: 0, errimg: 0 };
    for (const p of issuesArr) {
      for (const it of p.issues || []) {
        const r = (it.reason || "").toLowerCase();
        if (r.includes("crashloop")) fail.crash++;
        else if (r.includes("oomkilled")) fail.oom++;
        else if (r.includes("imagepullbackoff")) fail.imgpull++;
        else if (r.includes("errimagepull")) fail.errimg++;
      }
    }

    // Node pressure & readiness.
    const nodesArr = Array.isArray(nodes) ? nodes : nodes?.nodes || [];
    const press = { mem: 0, disk: 0, pid: 0, notReady: 0 };
    for (const n of nodesArr) {
      if (n.memoryPressure) press.mem++;
      if (n.diskPressure) press.disk++;
      if (n.pidPressure) press.pid++;
      if (n.ready === false) press.notReady++;
    }

    return {
      cpuPct, memPct, cpuUsed, memUsed, cpuCap, memCap,
      cpuReq, memReq, cpuHeadroom, memHeadroom,
      fail, press,
      noLimits: opt?.noLimits ?? null,
      reclaimCpu: opt?.reclaimCpu ?? null,
      reclaimMemGi: opt?.reclaimMemGi ?? null,
    };
  }, [summary, nm, opt, issues, nodes]);

  // Feed the agent: jump to chat with the deterministic /rightsize command,
  // which returns interactive apply cards built from live optimization data.
  function askAI() {
    setSeed(cluster, "/rightsize");
    setActiveView("chat");
  }

  // Hand failing pods to the agent for one-click triage fixes.
  function triage() {
    setSeed(cluster, "/triage");
    setActiveView("chat");
  }

  const totalFailures = view.fail.crash + view.fail.oom + view.fail.imgpull + view.fail.errimg;

  const failItems = [
    { k: "CrashLoopBackOff", n: view.fail.crash, c: "#ef4444" },
    { k: "OOMKilled", n: view.fail.oom, c: "#f97316" },
    { k: "ImagePullBackOff", n: view.fail.imgpull, c: "#f59e0b" },
    { k: "ErrImagePull", n: view.fail.errimg, c: "#eab308" },
  ];
  const pressItems = [
    { k: "Memory Pressure", n: view.press.mem },
    { k: "Disk Pressure", n: view.press.disk },
    { k: "PID Pressure", n: view.press.pid },
    { k: "Not Ready", n: view.press.notReady },
  ];

  return (
    <WidgetCard
      title="Capacity & Utilization"
      className="span-all"
      linkTo="chat"
      linkLabel="Ask AI to right-size"
    >
      {l1 && <div className="metric-skeleton" />}
      {e1 && <div className="metric-error"><span className="metric-error-msg">Couldn’t load capacity data</span></div>}
      {!l1 && !e1 && (
        <div className="cap-grid">
          {/* Utilization gauges */}
          <div className="cap-block cap-gauges">
            <Gauge
              value={view.cpuPct}
              label="CPU"
              sub={view.cpuCap ? `${view.cpuUsed.toFixed(1)} / ${formatNumber(view.cpuCap)} cores` : null}
            />
            <Gauge
              value={view.memPct}
              label="Memory"
              sub={view.memCap ? `${formatNumber(Math.round(view.memUsed))} / ${formatNumber(view.memCap)} GiB` : null}
            />
          </div>

          {/* Requested headroom (overcommit) */}
          <div className="cap-block">
            <div className="cap-block-title">Request Headroom</div>
            <HeadroomBar label="CPU" requestedPct={view.cpuReq} headroomPct={view.cpuHeadroom} />
            <HeadroomBar label="Memory" requestedPct={view.memReq} headroomPct={view.memHeadroom} />
            {view.noLimits != null && view.noLimits > 0 && (
              <div className="cap-note">{view.noLimits} pod{view.noLimits === 1 ? "" : "s"} without resource limits</div>
            )}
          </div>

          {/* Pod failures by reason */}
          <div className="cap-block">
            <div className="cap-block-title">
              Pod Failures
              {totalFailures > 0 && (
                <button className="cap-block-action" onClick={triage}>Triage →</button>
              )}
            </div>
            <div className="cap-chips">
              {failItems.map((f) => (
                <div key={f.k} className={"cap-chip" + (f.n > 0 ? " hot" : "")} style={f.n > 0 ? { "--chip-c": f.c } : {}}>
                  <span className="cap-chip-n">{f.n}</span>
                  <span className="cap-chip-k">{f.k}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Node pressure */}
          <div className="cap-block">
            <div className="cap-block-title">Node Pressure</div>
            <div className="cap-chips">
              {pressItems.map((p) => (
                <div key={p.k} className={"cap-chip" + (p.n > 0 ? " hot" : "")} style={p.n > 0 ? { "--chip-c": "#ef4444" } : {}}>
                  <span className="cap-chip-n">{p.n}</span>
                  <span className="cap-chip-k">{p.k}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Agent CTA */}
          <div className="cap-cta-row">
            <button className="cap-cta" onClick={askAI}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/><line x1="10" y1="22" x2="14" y2="22"/></svg>
              Ask AI to right-size this cluster
            </button>
          </div>
        </div>
      )}
    </WidgetCard>
  );
}
