// CPU or GPU tag on a cluster card, detected from the cluster itself
// (/api/cluster/summary → compute). A value that was not measured is left
// out of the tooltip, never guessed.

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

const pct = (v) => (Number.isFinite(v) ? Math.round(v) : null);

function gpuLabel(c) {
  const parts = [`${c.gpus}× ${c.gpuModel || "GPU"}`];
  if (c.migSlices) parts.push(`${c.migSlices} MIG slice${c.migSlices > 1 ? "s" : ""}`);
  if (c.shared) parts.push("time-sliced");
  return parts.join(" · ");
}

/**
 * One small tag beside the connection badge saying what the cluster computes
 * with: GPU when its nodes advertise GPUs, otherwise CPU. Capacity, model and
 * live usage are in the tooltip, so the card stays clean.
 */
export function ComputeTags({ compute: c }) {
  if (!c || !c.vcpu) return null;
  const cpuUse = pct(c.cpuPct);
  const gpuUse = pct(c.gpuPct);
  const cpuText = `${c.vcpu} vCPU${cpuUse !== null ? ` (${cpuUse}% in use)` : ""}`;
  if (c.gpus > 0) {
    const models = c.gpuModels ? Object.entries(c.gpuModels).map(([m, n]) => `${n}× ${m}`).join(", ") : gpuLabel(c);
    return (
      <span className="cp-cx-tag gpu" title={`GPU cluster · ${models}${gpuUse !== null ? ` (${gpuUse}% in use)` : ""} · ${cpuText}`} aria-label={`GPU cluster, ${gpuLabel(c)}`}>
        <GpuIcon size={11} />GPU
      </span>
    );
  }
  return (
    <span className="cp-cx-tag cpu" title={`CPU cluster · ${cpuText}${c.partial ? " · GPUs not reported by this cluster's agent yet" : ""}`} aria-label={`CPU cluster, ${c.vcpu} vCPU`}>
      <CpuIcon size={11} />CPU
    </span>
  );
}
