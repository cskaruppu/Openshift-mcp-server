// ---------------------------------------------------------------------------
// Resource fidelity — what a VM is promised on VMware vs what it gets here
// ---------------------------------------------------------------------------
/**
 * A migration that copies every byte correctly can still land a workload that
 * runs slower than it did, because the two platforms mean different things by
 * "4 vCPU and 16 GB".
 *
 * On VMware a VM is assigned vCPUs and memory, and may additionally hold
 * RESERVATIONS (guaranteed), LIMITS (capped), SHARES (relative priority),
 * latency sensitivity and CPU affinity. A tuned database typically has a full
 * memory reservation and a CPU reservation, and that is why it performs.
 *
 * On OpenShift Virtualization the VM is a pod:
 *
 *   CPU     Requests are the guest's vCPU count divided by the cluster's
 *           cpuAllocationRatio — 10 by default. A 4 vCPU guest requests 400m.
 *           The guest still SEES 4 CPUs; it is scheduled as 0.4 of a core and
 *           competes with every other pod on the node. This is the big one.
 *
 *   Memory  Requested in full, plus virt-launcher overhead, so it is genuinely
 *           reserved at schedule time. But with no limit set the pod is
 *           Burstable, not Guaranteed, and Burstable pods are evicted first
 *           under node memory pressure.
 *
 *   The rest MTV does not translate reservations, limits, shares, latency
 *           sensitivity or affinity at all. They are simply gone.
 *
 * Getting the guarantee back is a deliberate act — dedicatedCpuPlacement,
 * matching requests and limits, sometimes hugepages — and it is far cheaper to
 * decide before the wave than to debug afterwards from a performance ticket.
 *
 * Everything here is pure. Facts the inventory does not report stay null and
 * are reported as unknown, never as "no reservation".
 */

/** OpenShift Virtualization's default CPU overcommit. */
export const DEFAULT_CPU_RATIO = 10;

const num = (...vals) => {
  for (const v of vals) {
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const bool = (...vals) => {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return null;
};

/**
 * What VMware currently promises this VM. Pure.
 *
 * Returns a class plus the evidence behind it, so the console never asserts
 * "guaranteed" without being able to say why.
 *
 * @returns {{class:"guaranteed"|"partial"|"shared"|"unknown", evidence:string[], known:boolean}}
 */
export function classifySourceQoS(vm = {}) {
  const cpuReservationMHz = num(vm.cpuReservation, vm.resourceConfig?.cpuAllocation?.reservation);
  const memReservationMB = num(vm.memoryReservation, vm.resourceConfig?.memoryAllocation?.reservation);
  const memLockedToMax = bool(vm.memoryReservationLockedToMax, vm.resourceConfig?.memoryReservationLockedToMax);
  const latency = vm.latencySensitivity ?? null;
  const pinned = Array.isArray(vm.cpuAffinity) ? vm.cpuAffinity.length > 0
    : Array.isArray(vm.numaNodeAffinity) ? vm.numaNodeAffinity.length > 0 : null;

  const evidence = [];
  let strong = false, some = false;

  if (memLockedToMax === true) { evidence.push("memory is reserved in full (\"reserve all guest memory\")"); strong = true; }
  else if (memReservationMB > 0) {
    const full = vm.memoryMB && memReservationMB >= vm.memoryMB;
    evidence.push(`${memReservationMB} MB of memory reserved${full ? " — the whole guest" : ""}`);
    if (full) strong = true; else some = true;
  }
  if (cpuReservationMHz > 0) { evidence.push(`${cpuReservationMHz} MHz of CPU reserved`); some = true; }
  if (/high/i.test(String(latency))) { evidence.push("latency sensitivity is High"); strong = true; }
  if (pinned === true) { evidence.push("CPU or NUMA affinity is pinned"); strong = true; }

  // Nothing observed AND nothing observable are different answers.
  const known = [cpuReservationMHz, memReservationMB, memLockedToMax, latency, pinned]
    .some((v) => v !== null && v !== undefined);
  if (!known) return { class: "unknown", evidence: [], known: false };

  return {
    class: strong ? "guaranteed" : some ? "partial" : "shared",
    evidence,
    known: true,
  };
}

/**
 * What the migrated VM will actually request, under this cluster's settings.
 * Pure. The guest's own view is unchanged — only the scheduler's is.
 */
export function targetProfile(vm = {}, { cpuAllocationRatio = DEFAULT_CPU_RATIO, memoryOverheadMiB = 256 } = {}) {
  const vcpu = vm.cpuCount || 0;
  const ratio = cpuAllocationRatio > 0 ? cpuAllocationRatio : 1;
  return {
    vcpu,
    cpuRequestMillis: Math.round((vcpu * 1000) / ratio),
    cpuRatio: ratio,
    memoryGiB: vm.memoryGiB || 0,
    memoryRequestGiB: Number(((vm.memoryGiB || 0) + memoryOverheadMiB / 1024).toFixed(2)),
    // No limits are set by a migrated VM, so it is Burstable — schedulable on
    // its request, evictable under pressure.
    qos: "Burstable",
  };
}

/**
 * Per-VM findings about the change in guarantee. Pure.
 *
 * Shaped like the source-readiness findings so the console renders both the
 * same way.
 */
export function resourceFindings(vm = {}, opts = {}) {
  const out = [];
  const src = classifySourceQoS(vm);
  const tgt = targetProfile(vm, opts);

  if (src.class === "guaranteed" || src.class === "partial") {
    const full = src.class === "guaranteed";
    out.push({
      id: "qosDrop",
      severity: full ? "warning" : "info",
      blocks: false, required: full,
      title: full
        ? "Guaranteed resources on VMware become best-effort here"
        : "Partly reserved on VMware; nothing is reserved after migration",
      detail: `On the source: ${src.evidence.join("; ")}. MTV does not carry reservations, limits, shares or latency sensitivity across, so this VM lands as a Burstable pod requesting ${tgt.cpuRequestMillis}m for its ${tgt.vcpu} vCPU.`,
      action: full
        ? "Set dedicatedCpuPlacement and matching CPU/memory limits on the migrated VM to restore a guarantee, and confirm CPU Manager is enabled on the target nodes. Otherwise expect this workload to behave differently under load."
        : "Decide whether this workload needs a guarantee on the target, and set it explicitly if so — nothing carries over.",
    });
  }

  // Worth saying for every VM: it is the single most surprising difference,
  // and it is invisible from inside the guest.
  if (tgt.vcpu > 0 && tgt.cpuRatio > 1) {
    out.push({
      id: "cpuOvercommit",
      severity: tgt.vcpu >= 8 ? "warning" : "info",
      blocks: false, required: false,
      title: `${tgt.vcpu} vCPU will request ${tgt.cpuRequestMillis}m`,
      detail: `OpenShift Virtualization overcommits CPU ${tgt.cpuRatio}:1 by default. The guest still sees ${tgt.vcpu} CPUs — it is the scheduler's view that changes, so nothing inside the VM reveals this.`,
      action: tgt.vcpu >= 8
        ? "For a CPU-bound workload this size, plan dedicated CPU placement or raise the request before the wave rather than after a performance ticket."
        : "No action for most workloads. Revisit if the application is CPU-bound.",
    });
  }

  // Ballooning on the source is direct evidence the host was already short of
  // memory — useful context for anyone sizing the target.
  const ballooned = num(vm.balloonedMemory);
  if (ballooned > 0) {
    out.push({
      id: "ballooning",
      severity: "info", blocks: false, required: false,
      title: `${ballooned} MB of memory is currently ballooned on the source`,
      detail: "The ESXi host is reclaiming memory from this guest, so its VMware host is under memory pressure. On OpenShift the full guest memory is requested up front instead.",
      action: "Size the target from the VM's configured memory, not from what it is being allowed today.",
    });
  }

  return { findings: out, sourceQoS: src, target: tgt };
}

/**
 * Fleet roll-up: assigned versus requested, and how many guarantees are lost.
 * Pure, so the headline number on the console is tested.
 */
export function resourceFidelity(vms = [], opts = {}) {
  const { cpuAllocationRatio = DEFAULT_CPU_RATIO } = opts;
  const byClass = { guaranteed: 0, partial: 0, shared: 0, unknown: 0 };
  let vcpu = 0, cpuRequestMillis = 0, memoryGiB = 0, memoryRequestGiB = 0;
  const losing = [];

  for (const vm of vms) {
    const src = classifySourceQoS(vm);
    const tgt = targetProfile(vm, opts);
    byClass[src.class]++;
    vcpu += tgt.vcpu;
    cpuRequestMillis += tgt.cpuRequestMillis;
    memoryGiB += tgt.memoryGiB;
    memoryRequestGiB += tgt.memoryRequestGiB;
    if (src.class === "guaranteed" || src.class === "partial") {
      losing.push({ name: vm.name, class: src.class, evidence: src.evidence });
    }
  }

  return {
    vms: vms.length,
    byClass,
    cpu: {
      assignedVcpu: vcpu,
      requestedMillis: cpuRequestMillis,
      requestedCores: Number((cpuRequestMillis / 1000).toFixed(1)),
      ratio: cpuAllocationRatio,
    },
    memory: {
      assignedGiB: Number(memoryGiB.toFixed(1)),
      requestedGiB: Number(memoryRequestGiB.toFixed(1)),
    },
    losing,
    // Said in one sentence, because this is the part people get wrong.
    headline: vcpu
      ? `${vcpu} vCPU assigned on VMware becomes ${Number((cpuRequestMillis / 1000).toFixed(1))} cores requested here — the guests still see ${vcpu}, but the scheduler does not.`
      : "No CPU assignment reported for this selection.",
    note: byClass.unknown === vms.length && vms.length > 0
      ? "The source inventory did not report reservations or shares, so nothing can be said about which VMs were guaranteed. The CPU figures above still hold."
      : null,
  };
}
