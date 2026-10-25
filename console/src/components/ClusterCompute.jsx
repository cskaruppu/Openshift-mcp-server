// CPU / GPU hardware on a cluster card, detected from the cluster itself
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

const VENDOR_CLASS = { Intel: "intel", AMD: "amd", NVIDIA: "nvidia", Arm: "arm", Ampere: "arm" };

function Chip({ kind, vendor, model, title }) {
  return (
    <span className={`cp-hw-c ${kind} v-${VENDOR_CLASS[vendor] || "none"}`} title={title}>
      <span className="cp-hw-ic">{kind === "gpu" ? <GpuIcon size={13} /> : <CpuIcon size={13} />}</span>
      <span className="cp-hw-k">{kind}</span>
      {vendor && <b>{vendor}</b>}
      {model && <em>{model}</em>}
    </span>
  );
}

/**
 * The hardware row inside a cluster card: the CPU vendor and family, and on
 * clusters with GPUs the GPU vendor, count and model. Vendor names are shown
 * as text in the vendor's colour (no logo files). Capacity and live usage are
 * in the tooltips.
 */
export function HardwareRow({ compute: c }) {
  if (!c || !c.vcpu) return null;
  const cpuUse = pct(c.cpuPct);
  const gpuUse = pct(c.gpuPct);
  const cpuName = [c.cpuVendor, c.cpuFamily].filter(Boolean).join(" ") || c.arch || "CPU";
  const cpuTitle = `CPU · ${cpuName}${c.arch && c.cpuVendor ? ` (${c.arch})` : ""} · ${c.vcpu} vCPU${cpuUse !== null ? ` · ${cpuUse}% in use` : ""}${c.partial ? " · this cluster's agent does not report hardware details yet" : ""}`;
  const models = c.gpuModels ? Object.entries(c.gpuModels).map(([m, n]) => `${n}× ${m}`).join(", ") : null;
  return (
    <div className="cp-hw" onClick={(e) => e.stopPropagation()}>
      <Chip kind="cpu" vendor={c.cpuVendor} model={c.cpuVendor ? c.cpuFamily : c.arch || `${c.vcpu} vCPU`} title={cpuTitle} />
      {c.gpus > 0 && (
        <Chip kind="gpu" vendor={c.gpuVendor} model={models ? `${c.gpus}× GPU` : `${c.gpus}× ${c.gpuModel || "GPU"}`}
          title={`GPU · ${c.gpuVendor ? c.gpuVendor + " " : ""}${models || gpuLabel(c)}${gpuUse !== null ? ` · ${gpuUse}% in use` : ""}`} />
      )}
    </div>
  );
}
