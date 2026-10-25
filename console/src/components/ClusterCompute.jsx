// CPU / GPU at a glance on a cluster card: what the cluster has and how busy
// it is, detected from the cluster (/api/cluster/summary → compute). A value
// that was not measured shows "—", never a guess.

const CpuIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </svg>
);
const GpuIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="6" width="20" height="11" rx="2" /><circle cx="8.5" cy="11.5" r="2.5" /><circle cx="15.5" cy="11.5" r="2.5" /><path d="M5 17v3M9 17v3M13 17v3" />
  </svg>
);

const pct = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);

function Meter({ kind, icon, label, value, sub, title }) {
  const v = pct(value);
  return (
    <div className={"cp-cx-m " + kind} title={title}>
      <div className="cp-cx-top">{icon}{label}<b>{v === null ? "—" : `${v}%`}</b></div>
      <div className="cp-cx-bar" role="meter" aria-label={`${label} in use`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v ?? undefined}><i style={{ width: `${v ?? 0}%` }} /></div>
      <div className="cp-cx-sub">{sub}</div>
    </div>
  );
}

function gpuLabel(c) {
  const parts = [`${c.gpus}× ${c.gpuModel || "GPU"}`];
  if (c.migSlices) parts.push(`${c.migSlices} MIG slice${c.migSlices > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

/** The CPU and GPU meters, placed between the status line and the stats. */
export function ClusterCompute({ compute: c }) {
  if (!c || !c.vcpu) return null;
  const models = c.gpuModels ? Object.entries(c.gpuModels).map(([m, n]) => `${n}× ${m}`).join(", ") : null;
  return (
    <div className="cp-cx" onClick={(e) => e.stopPropagation()}>
      <Meter kind="cpu" icon={<CpuIcon />} label="CPU" value={c.cpuPct} sub={`${c.vcpu} vCPU${Number.isFinite(c.cpuPct) ? " · in use" : ""}`}
        title={Number.isFinite(c.cpuPct) ? `${c.cpuPct}% of ${c.vcpu} vCPU in use across the cluster` : "CPU usage not available (cluster metrics API not reachable)"} />
      {c.gpus > 0 ? (
        <Meter kind="gpu" icon={<GpuIcon />} label="GPU" value={c.gpuPct} sub={gpuLabel(c)}
          title={`${models || gpuLabel(c)}${Number.isFinite(c.gpuPct) ? ` · ${c.gpuPct}% average utilisation (DCGM)` : " · utilisation not available (DCGM metrics not scraped)"}`} />
      ) : (
        <Meter kind="none" icon={<GpuIcon />} label="GPU" value={null} sub={c.partial ? "Not reported yet" : "No accelerators"}
          title={c.partial ? "This cluster's agent runs an older version that does not report GPUs — update it to see them" : "No GPU is advertised by any node"} />
      )}
    </div>
  );
}

/** The small "GPU" tag next to the connection badge, on clusters with GPUs. */
export function GpuTag({ compute: c }) {
  if (!c || !(c.gpus > 0)) return null;
  return <span className="cp-cx-tag" title={gpuLabel(c)}><GpuIcon size={11} />GPU</span>;
}
