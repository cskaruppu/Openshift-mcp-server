// ---------------------------------------------------------------------------
// Right-sizing from measured utilisation
// ---------------------------------------------------------------------------
/**
 * What these machines actually use, versus what they were given.
 *
 * This matters more on OpenShift Virtualization than it did on VMware. A
 * KubeVirt VM is a pod, so it must fit on ONE node: a 16 vCPU / 64 GiB machine
 * that has never gone above 3 vCPU is not just wasted money, it is a placement
 * constraint that can push a wave over the edge of a node.
 *
 * The hard part is not the arithmetic, it is the honesty. This agent runs in
 * the DESTINATION, so its Prometheus watches the target cluster — it has no
 * history for a VM still running on VMware. Source utilisation has to come from
 * somewhere the customer already has, and plenty of estates have nothing. So:
 *
 *   - a machine with no samples gets NO recommendation and says why;
 *   - a machine with too few samples, or too short a window, gets none either,
 *     because a p95 over four hours is not a p95 over a month;
 *   - a recommendation is never below a floor, and never silently shrinks a
 *     machine that was deliberately pinned or reserved;
 *   - undersized machines are reported as loudly as oversized ones. A tool that
 *     only ever shrinks things is a cost tool wearing a capacity tool's badge,
 *     and it gets believed exactly once.
 *
 * Everything except readUtilisation() is pure.
 */
import { promQuery } from "./prometheus.js";

/** Below these, a percentile is arithmetic rather than evidence. */
export const MIN_SAMPLES = 100;
export const MIN_WINDOW_DAYS = 7;
/** Nothing is recommended below this, whatever the measurement says. */
export const FLOOR = Object.freeze({ cpuCount: 1, memoryGiB: 1 });
/** Headroom over the observed peak, so a recommendation is not a ceiling. */
export const DEFAULT_HEADROOM = 1.25;
/** vCPU counts worth recommending. Odd numbers above two confuse capacity planning. */
export const VCPU_STEPS = Object.freeze([1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128]);
/**
 * Below this, a "recommendation" is noise. Proposing 16 GiB → 15 GiB costs a
 * change request, a reboot and an argument, and frees nothing worth having —
 * and a tool that proposes it is not read carefully the second time.
 */
export const MATERIAL = Object.freeze({ vcpu: 2, memGiB: 4 });

/** The p-th percentile of a sample set, nearest-rank. Pure. */
export function percentile(values = [], p = 0.95) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.ceil(p * xs.length);
  return xs[Math.min(xs.length - 1, Math.max(0, rank - 1))];
}

const stepUp = (n) => VCPU_STEPS.find((s) => s >= n) ?? VCPU_STEPS[VCPU_STEPS.length - 1];

/**
 * Whether a sample set is worth drawing a conclusion from. Pure.
 *
 * Returned as a reason rather than a boolean, because "we have no data" and
 * "we have six hours of data" need different sentences in front of a customer.
 */
export function coverageOf(samples = {}, opts = {}) {
  const minSamples = opts.minSamples ?? MIN_SAMPLES;
  const minDays = opts.minWindowDays ?? MIN_WINDOW_DAYS;
  const cpu = samples.cpu || [], mem = samples.memory || [];
  const n = Math.min(cpu.length, mem.length);
  if (!n) return { ok: false, reason: "No utilisation history was found for this machine.", samples: 0, windowDays: null };
  const days = samples.windowDays ?? null;
  if (days != null && days < minDays) {
    return { ok: false, samples: n, windowDays: days, reason: `Only ${days} day${days === 1 ? "" : "s"} of history — a peak over ${days} day${days === 1 ? "" : "s"} is not a peak over ${minDays}, and resizing on it would be a guess with a number attached.` };
  }
  if (n < minSamples) {
    return { ok: false, samples: n, windowDays: days, reason: `Only ${n} sample${n === 1 ? "" : "s"} — below the ${minSamples} needed before a percentile means anything.` };
  }
  return { ok: true, samples: n, windowDays: days, reason: null };
}

/**
 * What one machine should be, given what it has done. Pure.
 *
 * @param {object} vm       normalised VM
 * @param {object} samples  { cpu: number[] (cores), memory: number[] (GiB), windowDays }
 */
export function rightSize(vm = {}, samples = null, opts = {}) {
  const headroom = opts.headroom ?? DEFAULT_HEADROOM;
  const current = { cpuCount: vm.cpuCount ?? null, memoryGiB: vm.memoryGiB ?? null };
  const base = { name: vm.name, current, recommended: null, p95: null, verdict: "unmeasured", reason: null, evidence: [] };

  if (current.cpuCount == null || current.memoryGiB == null) {
    return { ...base, reason: "The inventory did not report this machine's CPU or memory, so there is nothing to compare a measurement against." };
  }

  const cov = coverageOf(samples || {}, opts);
  if (!cov.ok) return { ...base, coverage: cov, reason: cov.reason };

  const cpuP95 = percentile(samples.cpu, 0.95);
  const memP95 = percentile(samples.memory, 0.95);
  if (cpuP95 == null || memP95 == null) return { ...base, coverage: cov, reason: "Utilisation samples were present but unusable." };
  const p95 = { cpuCores: Number(cpuP95.toFixed(2)), memoryGiB: Number(memP95.toFixed(1)) };

  // Machines somebody deliberately pinned or reserved are not resized on a
  // graph. The reservation is the statement of intent, and it outranks a
  // percentile — flag them for a human instead of quietly shrinking them.
  const pinned = [];
  if (vm.latencySensitivity && /high/i.test(String(vm.latencySensitivity))) pinned.push("latency sensitivity is set to high");
  if (Array.isArray(vm.cpuAffinity) && vm.cpuAffinity.length) pinned.push("CPU affinity is pinned");
  if (Array.isArray(vm.numaNodeAffinity) && vm.numaNodeAffinity.length) pinned.push("NUMA node affinity is pinned");
  if (vm.memoryReservationLockedToMax === true) pinned.push("memory is reserved and locked to maximum");
  if (Number(vm.cpuReservation) > 0) pinned.push(`${vm.cpuReservation} MHz of CPU is reserved`);
  if (Number(vm.memoryReservation) > 0) pinned.push(`${vm.memoryReservation} MB of memory is reserved`);

  const wantCpu = Math.max(FLOOR.cpuCount, stepUp(Math.ceil(p95.cpuCores * headroom)));
  const wantMem = Math.max(FLOOR.memoryGiB, Math.ceil(p95.memoryGiB * headroom));
  const evidence = [
    `p95 CPU ${p95.cpuCores} of ${current.cpuCount} vCPU over ${cov.windowDays ?? "the sampled"} day${cov.windowDays === 1 ? "" : "s"} (${cov.samples} samples)`,
    `p95 memory ${p95.memoryGiB} of ${current.memoryGiB} GiB`,
    `${Math.round((headroom - 1) * 100)}% headroom added over the observed peak`,
  ];

  if (pinned.length) {
    return {
      ...base, coverage: cov, p95, verdict: "pinned", evidence,
      reason: `Not resized automatically: ${pinned.join(", ")}. Somebody chose that on purpose, and a percentile does not outrank it — review with the application owner.`,
      // Shown so the saving is visible even though it is not recommended.
      wouldBe: { cpuCount: wantCpu, memoryGiB: wantMem },
    };
  }

  // Under-provisioned is a finding, not a saving, and it is reported first.
  if (p95.cpuCores > current.cpuCount * 0.9 || p95.memoryGiB > current.memoryGiB * 0.9) {
    return {
      ...base, coverage: cov, p95, verdict: "undersized", evidence,
      recommended: { cpuCount: Math.max(current.cpuCount, wantCpu), memoryGiB: Math.max(current.memoryGiB, wantMem) },
      reason: "This machine runs close to what it was given. Migrating it at its current size carries the problem across — and on OpenShift Virtualization it will be a Burstable pod, evictable under node pressure.",
    };
  }

  const recommended = { cpuCount: Math.min(current.cpuCount, wantCpu), memoryGiB: Math.min(current.memoryGiB, wantMem) };
  const freedCpu = current.cpuCount - recommended.cpuCount;
  const freedMem = current.memoryGiB - recommended.memoryGiB;

  // Worth a change request, or not worth mentioning. There is no third state:
  // a recommendation nobody would act on still costs the reader's attention.
  if (freedCpu < MATERIAL.vcpu && freedMem < MATERIAL.memGiB) {
    return {
      ...base, coverage: cov, p95, verdict: "correct", evidence,
      reason: freedCpu > 0 || freedMem > 0
        ? `Within ${MATERIAL.vcpu} vCPU and ${MATERIAL.memGiB} GiB of the right size — too small a change to be worth a reboot.`
        : "Already the right size for what it does.",
    };
  }

  return {
    ...base, coverage: cov, p95, verdict: "oversized", evidence, recommended,
    freed: { cpuCount: freedCpu, memoryGiB: freedMem },
    // Just this machine's numbers. The reason the size matters on KubeVirt is
    // the same for every row, so it is said once under the table rather than
    // fourteen times inside it, where it becomes wallpaper.
    reason: `Uses ${p95.cpuCores} vCPU and ${p95.memoryGiB} GiB at p95, against ${current.cpuCount} and ${current.memoryGiB}.`,
  };
}

/**
 * The fleet roll-up. Pure.
 *
 * `unmeasured` is a first-class number here rather than a rounding error: a
 * saving computed over the 40% of an estate that happened to have monitoring,
 * and presented as the estate's saving, is the single easiest way to lose an
 * argument with a customer's finance team.
 */
export function fleetRightSizing(vms = [], samplesByVm = {}, opts = {}) {
  const rows = vms.map((vm) => rightSize(vm, samplesByVm[vm.name] || null, opts));
  const by = (v) => rows.filter((r) => r.verdict === v);
  const measured = rows.filter((r) => r.verdict !== "unmeasured");
  const sum = (list, f) => list.reduce((n, r) => n + (f(r) || 0), 0);

  const resizable = by("oversized");
  const before = { cpu: sum(resizable, (r) => r.current.cpuCount), memGiB: sum(resizable, (r) => r.current.memoryGiB) };
  const after = { cpu: sum(resizable, (r) => r.recommended.cpuCount), memGiB: sum(resizable, (r) => r.recommended.memoryGiB) };

  return {
    rows,
    counts: {
      total: vms.length,
      measured: measured.length,
      unmeasured: rows.length - measured.length,
      oversized: resizable.length, undersized: by("undersized").length,
      correct: by("correct").length, pinned: by("pinned").length,
    },
    // Only over what was actually measured AND is actually resizable.
    saving: resizable.length
      ? {
          vcpuBefore: before.cpu, vcpuAfter: after.cpu, vcpuFreed: before.cpu - after.cpu,
          memGiBBefore: before.memGiB, memGiBAfter: after.memGiB, memGiBFreed: before.memGiB - after.memGiB,
          pctVcpu: before.cpu ? Math.round(((before.cpu - after.cpu) / before.cpu) * 100) : null,
        }
      : null,
    coverage: {
      measured: measured.length, total: vms.length,
      pct: vms.length ? Math.round((measured.length / vms.length) * 100) : null,
    },
    headline: measured.length === 0
      ? `No utilisation history was found for any of these ${vms.length} machine${vms.length === 1 ? "" : "s"}, so nothing is recommended. Connect a source of source-side metrics, or migrate at the configured sizes.`
      : `${measured.length} of ${vms.length} machine${vms.length === 1 ? "" : "s"} have enough history to size from${resizable.length ? `; ${resizable.length} are larger than they need to be` : "; none is oversized"}${by("undersized").length ? `, and ${by("undersized").length} run close to their limit` : ""}.`,
    // Said out loud wherever the saving is shown.
    caveat: rows.length - measured.length > 0
      ? `${rows.length - measured.length} machine${rows.length - measured.length === 1 ? " has" : "s have"} no usable history and are counted at their configured size. Unmeasured is not the same as zero, and no saving is claimed for them.`
      : null,
  };
}

// ── Reading utilisation ────────────────────────────────────────────────────
/**
 * Where source-side utilisation can come from, in order of preference.
 *
 * Nothing here invents a series. When no source is configured the answer is an
 * empty map and a stated reason, which is what makes the blank column in the
 * console honest rather than broken.
 */
export async function readUtilisation(vms = [], opts = {}) {
  const names = vms.map((v) => v.name).filter(Boolean);
  if (!names.length) return { source: "none", samples: {}, reason: "No machines to look up." };

  // 1. Samples handed in with the request — a customer's own export from
  //    vCenter, Aria, Turbonomic or a CMDB. Their data beats anything guessed.
  if (opts.supplied && Object.keys(opts.supplied).length) {
    return { source: "supplied", samples: opts.supplied, reason: null,
      basis: "Utilisation supplied with the request — measured by your own tooling, not by this agent." };
  }

  const days = opts.windowDays ?? 30;

  // 2. vCenter itself, when the agent has a credential of its own. This is the
  //    only source that works without the customer having built anything: the
  //    history is already there, behind QueryPerf, and has been all along.
  try {
    const { readVcenterUtilisation } = await import("./vcenter-perf.js");
    const vc = await readVcenterUtilisation(vms, { days });
    if (vc.source === "vcenter" && Object.keys(vc.samples).length) {
      return { source: "vcenter", samples: vc.samples, reason: null, basis: vc.basis };
    }
    // Remember why, so the panel can say something better than "no data" when
    // a credential IS configured and still produced nothing.
    if (vc.reason) opts._vcReason = vc.reason;
  } catch { /* module or credential unavailable — fall through */ }

  // 3. Prometheus, IF something is scraping the source hypervisor into it.
  //    vmware_exporter is the common case. This agent's Prometheus watches the
  //    DESTINATION, so this only works when the customer has wired the source
  //    in too — which is worth attempting and never worth assuming.
  try {
    const cpuRows = await promQuery(
      `quantile_over_time(0.95, vmware_vm_cpu_usage_average[${days}d])`,
    ).catch(() => []);
    const memRows = await promQuery(
      `quantile_over_time(0.95, vmware_vm_mem_usage_average[${days}d])`,
    ).catch(() => []);
    if (cpuRows.length || memRows.length) {
      const samples = {};
      const put = (rows, key, scale) => {
        for (const r of rows) {
          const name = r.metric?.vm_name || r.metric?.vm || r.metric?.instance;
          if (!name || !names.includes(name)) continue;
          samples[name] ||= { cpu: [], memory: [], windowDays: days };
          samples[name][key] = [Number(r.value?.[1] || 0) * scale];
        }
      };
      put(cpuRows, "cpu", 1);
      put(memRows, "memory", 1);
      return { source: "prometheus", samples, reason: null,
        basis: `Read from Prometheus over ${days} days (vmware_exporter series).` };
    }
  } catch { /* no Prometheus, or no vSphere series in it */ }

  return {
    source: "none", samples: {},
    // When a vCenter credential IS configured and still produced nothing, that
    // reason is far more useful than the generic one — it names what to fix.
    reason: opts._vcReason
      || "No source-side utilisation is available. This agent runs inside the destination cluster, so its own metrics cover the target, not the VMs still on VMware. Give it a read-only vCenter credential (VCENTER_URL, VCENTER_USERNAME, VCENTER_PASSWORD) and it reads the history vCenter has kept all along — or point it at a Prometheus scraping vmware_exporter, or supply samples from your existing monitoring.",
  };
}
