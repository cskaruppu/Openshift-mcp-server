// What a cluster runs on, and its GPUs, on a cluster card — detected from the cluster itself
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

const ServerIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
  </svg>
);
const VmIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="7" y="3" width="14" height="10" rx="1.5" /><rect x="3" y="11" width="14" height="10" rx="1.5" /><path d="M7 17h6" />
  </svg>
);
const CloudIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 18h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.4 9.1 4.5 4.5 0 0 0 7 18z" />
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

function Chip({ kind, cls, icon, label, vendor, model, title }) {
  return (
    <span className={`cp-hw-c ${kind} ${cls}`} title={title}>
      <span className="cp-hw-ic">{icon}</span>
      <span className="cp-hw-k">{label}</span>
      {vendor && <b>{vendor}</b>}
      {model && <em>{model}</em>}
    </span>
  );
}

/** What the cluster runs on, as chip parts: bare metal (and whose servers), VMware, another hypervisor, a cloud. */
function infraChip(i) {
  if (i.kind === "baremetal") {
    return { cls: i.maker === "Dell" ? "v-dell" : "v-metal", icon: <ServerIcon size={13} />, label: "Bare metal",
      vendor: i.maker || "Bare metal", model: i.maker ? i.family : null,
      title: `Bare metal${i.maker ? ` · ${i.maker} ${i.model || i.family || ""}`.trimEnd() : ""}` };
  }
  if (i.kind === "vsphere") return { cls: "v-vmware", icon: <VmIcon size={13} />, label: "VM", vendor: "VMware", model: "vSphere", title: "Virtual machines on VMware vSphere" };
  if (i.kind === "cloud") return { cls: "v-cloud", icon: <CloudIcon size={13} />, label: "Cloud", vendor: i.name, model: null, title: `Cloud · ${i.name}` };
  return { cls: "v-virtual", icon: <VmIcon size={13} />, label: "VM", vendor: i.name, model: null, title: `Virtual machines on ${i.name}` };
}

/**
 * The hardware row inside a cluster card: what the cluster runs on (bare metal
 * and whose servers, VMware, a cloud) and, on clusters with GPUs, the GPU
 * vendor, count and model. Vendor names are text in the vendor's colour (no
 * logo files). The CPU details and live usage are in the tooltips. When the
 * platform cannot be told, the first chip shows the CPU instead.
 */
export function HardwareRow({ compute: c }) {
  if (!c || !c.vcpu) return null;
  const cpuUse = pct(c.cpuPct);
  const gpuUse = pct(c.gpuPct);
  const cpuName = [c.cpuVendor, c.cpuFamily].filter(Boolean).join(" ") || c.arch || "CPU";
  const cpuText = `${cpuName}${c.arch && c.cpuVendor ? ` (${c.arch})` : ""} · ${c.vcpu} vCPU${cpuUse !== null ? ` · ${cpuUse}% in use` : ""}`;
  const models = c.gpuModels ? Object.entries(c.gpuModels).map(([m, n]) => `${n}× ${m}`).join(", ") : null;
  const infra = c.infra ? infraChip(c.infra) : null;
  return (
    <div className="cp-hw" onClick={(e) => e.stopPropagation()}>
      {infra ? (
        <Chip kind="infra" cls={infra.cls} icon={infra.icon} label={infra.label} vendor={infra.vendor} model={infra.model} title={`${infra.title} · CPU: ${cpuText}`} />
      ) : (
        <Chip kind="cpu" cls={`v-${VENDOR_CLASS[c.cpuVendor] || "none"}`} icon={<CpuIcon size={13} />} label="CPU" vendor={c.cpuVendor}
          model={c.cpuVendor ? c.cpuFamily : c.arch || `${c.vcpu} vCPU`}
          title={`CPU · ${cpuText}${c.partial ? " · this cluster's agent does not report hardware details yet" : ""}`} />
      )}
      {c.gpus > 0 && (
        <Chip kind="gpu" cls={`v-${VENDOR_CLASS[c.gpuVendor] || "none"}`} icon={<GpuIcon size={13} />} label="GPU" vendor={c.gpuVendor}
          model={models ? `${c.gpus}× GPU` : `${c.gpus}× ${c.gpuModel || "GPU"}`}
          title={`GPU · ${c.gpuVendor ? c.gpuVendor + " " : ""}${models || gpuLabel(c)}${gpuUse !== null ? ` · ${gpuUse}% in use` : ""}`} />
      )}
    </div>
  );
}
