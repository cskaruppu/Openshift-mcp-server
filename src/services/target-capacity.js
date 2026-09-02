// ---------------------------------------------------------------------------
// Target capacity — will these VMs actually RUN once they land?
// ---------------------------------------------------------------------------
/**
 * Every migration assessment tool on the market reads the source. MTV reads the
 * source. This agent runs INSIDE the destination, so it can answer the question
 * none of them can: does the target cluster have room, and will each individual
 * machine schedule?
 *
 * The second half of that matters more than it sounds. A KubeVirt VM is a pod,
 * so it must fit on ONE node. A 64 GiB VM cannot run on 32 GiB workers. MTV
 * validates the plan, copies every byte correctly, creates the VirtualMachine —
 * and it sits Pending forever, after the outage has already been spent. Nothing
 * in the migration toolchain catches that today.
 *
 * Everything here except readClusterCapacity() is pure, so the arithmetic that
 * decides a blocker is tested rather than trusted.
 */
import { ocpGet } from "../utils/openshift-client.js";

/** Nodes only run VMs when virt-handler is healthy on them. */
export const VIRT_SCHEDULABLE_LABEL = "kubevirt.io/schedulable";

/**
 * OpenShift Virtualization's defaults, named rather than buried.
 *
 * cpuAllocationRatio 10 means a 4 vCPU guest requests 400m, not 4 cores — CPU
 * is deliberately overcommitted. Memory is NOT, and virt-launcher adds its own
 * overhead on top of the guest's RAM, which is why memory is almost always the
 * constraint that actually bites.
 */
export const DEFAULTS = Object.freeze({ cpuAllocationRatio: 10, memoryOverheadMiB: 256 });

// ── Quantity parsing ───────────────────────────────────────────────────────
/** Kubernetes CPU quantity → millicores. "2" → 2000, "500m" → 500. */
export function parseCpuMillis(v) {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  if (s.endsWith("m")) return Math.round(parseFloat(s) || 0);
  if (s.endsWith("n")) return Math.round((parseFloat(s) || 0) / 1e6);
  if (s.endsWith("u")) return Math.round((parseFloat(s) || 0) / 1e3);
  return Math.round((parseFloat(s) || 0) * 1000);
}

/** Kubernetes memory quantity → bytes. Handles Ki/Mi/Gi/Ti and K/M/G/T. */
export function parseMemBytes(v) {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  const m = /^([0-9.]+)\s*([EPTGMK]i?)?$/i.exec(s);
  if (!m) return 0;
  const n = parseFloat(m[1]) || 0;
  const unit = (m[2] || "").toLowerCase();
  const mult = {
    "": 1,
    k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15, e: 1e18,
    ki: 1024, mi: 1024 ** 2, gi: 1024 ** 3, ti: 1024 ** 4, pi: 1024 ** 5, ei: 1024 ** 6,
  }[unit] ?? 1;
  return Math.round(n * mult);
}

const toGiB = (bytes) => bytes / 1024 ** 3;

// ── What a migrated VM will ask the scheduler for ──────────────────────────
/**
 * The request a KubeVirt VM makes, which is NOT the VM's spec. Pure.
 *
 * @param {{cpuCount:number, memoryGiB:number}} vm
 */
export function vmDemand(vm = {}, opts = {}) {
  const { cpuAllocationRatio, memoryOverheadMiB } = { ...DEFAULTS, ...opts };
  const ratio = cpuAllocationRatio > 0 ? cpuAllocationRatio : 1;
  return {
    cpuMillis: Math.round(((vm.cpuCount || 0) * 1000) / ratio),
    memGiB: Number(((vm.memoryGiB || 0) + memoryOverheadMiB / 1024).toFixed(3)),
  };
}

// ── Reading the cluster ────────────────────────────────────────────────────
/**
 * Node capacity and what is already committed on it.
 *
 * Committed means the sum of pod REQUESTS, which is what the scheduler actually
 * reserves — not live utilisation. A node at 20% CPU usage but 95% requested has
 * no room for another VM, and quoting the 20% would be a lie that costs someone
 * an outage.
 */
export async function readClusterCapacity({ podLimit = 3000 } = {}) {
  const nodeList = await ocpGet("/api/v1/nodes").catch(() => null);
  if (!nodeList) {
    return { available: false, reason: "Could not read nodes from the target cluster.", nodes: [] };
  }

  const nodes = (nodeList.items || []).map((n) => {
    const alloc = n.status?.allocatable || {};
    const ready = (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True");
    return {
      name: n.metadata?.name || "(unnamed)",
      ready,
      // spec.unschedulable is a cordon; it is not the same as "not ready".
      cordoned: n.spec?.unschedulable === true,
      // KubeVirt sets this label only where virt-handler is healthy. A node
      // without it has CPU and RAM the cluster can use — and a VM cannot.
      virtSchedulable: String(n.metadata?.labels?.[VIRT_SCHEDULABLE_LABEL] ?? "") === "true",
      cpuMillis: parseCpuMillis(alloc.cpu),
      memGiB: Number(toGiB(parseMemBytes(alloc.memory)).toFixed(2)),
      cpuCommittedMillis: 0,
      memCommittedGiB: 0,
    };
  });

  // Pod requests, so headroom means what the scheduler thinks it means.
  let partial = false;
  const byNode = new Map(nodes.map((n) => [n.name, n]));
  const pods = await ocpGet(`/api/v1/pods?limit=${podLimit}`).catch(() => null);
  if (pods) {
    if (pods.metadata?.continue) partial = true;
    for (const p of pods.items || []) {
      const phase = p.status?.phase;
      if (phase === "Succeeded" || phase === "Failed") continue;
      const node = byNode.get(p.spec?.nodeName);
      if (!node) continue;
      for (const c of p.spec?.containers || []) {
        node.cpuCommittedMillis += parseCpuMillis(c.resources?.requests?.cpu);
        node.memCommittedGiB += toGiB(parseMemBytes(c.resources?.requests?.memory));
      }
    }
  } else {
    partial = true;
  }
  for (const n of nodes) {
    n.memCommittedGiB = Number(n.memCommittedGiB.toFixed(2));
    n.freeCpuMillis = Math.max(0, n.cpuMillis - n.cpuCommittedMillis);
    n.freeMemGiB = Number(Math.max(0, n.memGiB - n.memCommittedGiB).toFixed(2));
  }

  return { available: true, partial, nodes, ...summariseNodes(nodes) };
}

/**
 * Roll nodes up into the numbers a decision is made from. Pure, so the whole
 * verdict can be tested against a fabricated cluster.
 *
 * Only nodes that can actually run a VM count: ready, uncordoned, and labelled
 * virt-schedulable. Counting the rest inflates headroom that no VM can reach.
 */
export function summariseNodes(nodes = []) {
  const usable = nodes.filter((n) => n.ready && !n.cordoned && n.virtSchedulable);
  const sum = (list, f) => list.reduce((a, b) => a + (f(b) || 0), 0);
  const largest = usable.slice().sort((a, b) => b.memGiB - a.memGiB)[0] || null;
  const mostFree = usable.slice().sort((a, b) => b.freeMemGiB - a.freeMemGiB)[0] || null;
  return {
    nodeCount: nodes.length,
    virtNodeCount: usable.length,
    excluded: nodes
      .filter((n) => !usable.includes(n))
      .map((n) => ({
        name: n.name,
        reason: !n.ready ? "not Ready" : n.cordoned ? "cordoned"
          : `no ${VIRT_SCHEDULABLE_LABEL}=true label — virt-handler is not running here`,
      })),
    totals: {
      cpuMillis: sum(usable, (n) => n.cpuMillis),
      memGiB: Number(sum(usable, (n) => n.memGiB).toFixed(2)),
      cpuCommittedMillis: sum(usable, (n) => n.cpuCommittedMillis),
      memCommittedGiB: Number(sum(usable, (n) => n.memCommittedGiB).toFixed(2)),
      freeCpuMillis: sum(usable, (n) => n.freeCpuMillis),
      freeMemGiB: Number(sum(usable, (n) => n.freeMemGiB).toFixed(2)),
    },
    // The single biggest machine a VM could ever land on, and the biggest gap
    // available right now. These are different questions and both get asked.
    largestNode: largest && { name: largest.name, cpuMillis: largest.cpuMillis, memGiB: largest.memGiB },
    mostFreeNode: mostFree && { name: mostFree.name, freeCpuMillis: mostFree.freeCpuMillis, freeMemGiB: mostFree.freeMemGiB },
  };
}

// ── The verdict ────────────────────────────────────────────────────────────
/**
 * Whether ONE VM can schedule. Pure.
 *
 * "Never" and "not right now" are different answers and must not be shown the
 * same way: the first needs bigger nodes, the second needs the cluster drained
 * or scaled, and only the first is worth blocking a plan over.
 */
export function nodeFit(vm, capacity, opts = {}) {
  const need = vmDemand(vm, opts);
  if (!capacity?.largestNode) {
    return { fits: null, need, reason: "No virtualization-capable node was found on the target cluster." };
  }
  const big = capacity.largestNode;
  if (need.memGiB > big.memGiB || need.cpuMillis > big.cpuMillis) {
    return {
      fits: false, permanent: true, need,
      reason: `Needs ${need.memGiB.toFixed(1)} GiB and ${need.cpuMillis}m, but the largest virtualization node (${big.name}) offers only ${big.memGiB} GiB and ${big.cpuMillis}m. A VM is a pod — it must fit on one node — so this machine would never schedule.`,
    };
  }
  const free = capacity.mostFreeNode;
  if (free && (need.memGiB > free.freeMemGiB || need.cpuMillis > free.freeCpuMillis)) {
    return {
      fits: false, permanent: false, need,
      reason: `Fits the hardware, but no node has room right now — the emptiest (${free.name}) has ${free.freeMemGiB} GiB and ${free.freeCpuMillis}m free. Scale the cluster or free capacity before cutover.`,
    };
  }
  return { fits: true, need, reason: null };
}

/**
 * Whether the WAVE fits, and which machines will not schedule. Pure.
 *
 * @param {Array} vms   [{ name, cpuCount, memoryGiB, diskGiB }]
 */
export function capacityVerdict(vms = [], capacity = null, opts = {}) {
  const demand = vms.reduce((acc, v) => {
    const d = vmDemand(v, opts);
    acc.cpuMillis += d.cpuMillis;
    acc.memGiB += d.memGiB;
    acc.diskGiB += v.diskGiB || 0;
    return acc;
  }, { cpuMillis: 0, memGiB: 0, diskGiB: 0 });
  demand.memGiB = Number(demand.memGiB.toFixed(1));

  if (!capacity?.available || !capacity.virtNodeCount) {
    return {
      verdict: "unknown", demand, perVm: [],
      headline: capacity?.available === false
        ? "Target capacity could not be read."
        : "No virtualization-capable node was found, so nothing can be scheduled yet.",
      notes: capacity?.excluded?.length
        ? [`${capacity.excluded.length} node(s) excluded: ${capacity.excluded.map((e) => `${e.name} (${e.reason})`).join("; ")}`]
        : [],
    };
  }

  const free = capacity.totals;
  const perVm = vms.map((v) => ({ name: v.name, ...nodeFit(v, capacity, opts) }));
  const never = perVm.filter((p) => p.fits === false && p.permanent);
  const notNow = perVm.filter((p) => p.fits === false && !p.permanent);

  // Memory is the binding constraint: it is not overcommitted, CPU is.
  const memRatio = free.freeMemGiB > 0 ? demand.memGiB / free.freeMemGiB : Infinity;
  const verdict = never.length ? "blocked"
    : memRatio > 1 ? "exceeds"
    : memRatio > 0.8 ? "tight"
    : "fits";

  const headline = {
    blocked: `${never.length} VM${never.length === 1 ? "" : "s"} cannot schedule on any node in this cluster, whatever the cluster's total capacity.`,
    exceeds: `This wave needs ${demand.memGiB} GiB but only ${free.freeMemGiB} GiB is unreserved across ${capacity.virtNodeCount} virtualization node(s).`,
    tight: `This wave needs ${demand.memGiB} GiB of the ${free.freeMemGiB} GiB unreserved — it fits, with little margin left.`,
    fits: `Fits: ${demand.memGiB} GiB of ${free.freeMemGiB} GiB unreserved across ${capacity.virtNodeCount} virtualization node(s).`,
  }[verdict];

  const notes = [];
  if (notNow.length) notes.push(`${notNow.length} VM(s) fit the hardware but no single node has room today — scale or free capacity before cutover.`);
  if (capacity.excluded?.length) {
    notes.push(`${capacity.excluded.length} node(s) excluded from this calculation: ${capacity.excluded.map((e) => `${e.name} (${e.reason})`).join("; ")}`);
  }
  if (capacity.partial) notes.push("Pod requests could not be read in full, so committed capacity is a lower bound and real headroom may be smaller.");
  const { cpuAllocationRatio, memoryOverheadMiB } = { ...DEFAULTS, ...opts };
  notes.push(`Assumes OpenShift Virtualization defaults: CPU overcommitted ${cpuAllocationRatio}:1, memory not overcommitted, ${memoryOverheadMiB} MiB virt-launcher overhead per VM.`);

  return {
    verdict, demand, perVm, headline, notes,
    free: { cpuMillis: free.freeCpuMillis, memGiB: free.freeMemGiB },
    allocatable: { cpuMillis: free.cpuMillis, memGiB: free.memGiB },
    virtNodeCount: capacity.virtNodeCount,
    largestNode: capacity.largestNode,
  };
}
