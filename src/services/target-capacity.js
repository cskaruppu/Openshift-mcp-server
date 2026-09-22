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

// ── Placement ──────────────────────────────────────────────────────────────
/** A node can host a VM only when it is Ready, uncordoned and virt-schedulable. */
const usableNodes = (capacity) =>
  (capacity?.nodes || []).filter((n) => n.ready && !n.cordoned && n.virtSchedulable);

const r2 = (n) => Number(n.toFixed(2));

/**
 * Where each machine in the wave actually lands. Pure.
 *
 * Summing a wave's memory against a cluster's total headroom answers a question
 * nobody asked. 336 GiB free across six nodes does not place forty-two 8 GiB
 * machines if the free memory is fragmented — and checking each VM against the
 * emptiest node one at a time is worse, because it never accounts for the VM
 * placed there a moment earlier. Both give an answer that is wrong in the
 * optimistic direction, which is the direction that costs an outage.
 *
 * So the wave is packed as a SET. Largest memory first (first-fit-decreasing):
 * it is the standard bin-packing heuristic, it is deterministic, and it is
 * stated in the output — a packer that will not explain its rule gets overruled
 * by the first engineer who disagrees with it.
 *
 * Three ways a machine fails to land, and they need three different actions:
 *   hardware — bigger than any node. Buy nodes, or drop it.
 *   cluster  — no node had that much free even before the wave started. Scale.
 *   wave     — a node did have room, and the machines ahead of it took it.
 *              Re-order the wave, or split it. The cluster is not the problem.
 */
export function packWave(vms = [], capacity = null, opts = {}) {
  const usable = usableNodes(capacity);
  if (capacity?.available !== true || !usable.length) {
    return {
      available: false, placed: [], unplaced: [], nodes: [], fits: null,
      placedCount: 0, unplacedCount: 0,
      reason: capacity?.available === false
        ? "Target capacity could not be read, so placement was not simulated."
        : "No virtualization-capable node was found, so nothing can be placed.",
    };
  }

  // Remaining room starts at what the scheduler has NOT already reserved.
  const bins = usable.map((n) => ({
    name: n.name, cpuMillis: n.cpuMillis, memGiB: n.memGiB,
    freeCpuMillis: n.freeCpuMillis, freeMemGiB: n.freeMemGiB,
    remCpuMillis: n.freeCpuMillis, remMemGiB: n.freeMemGiB,
    vms: [],
  }));
  const biggestMem = Math.max(...bins.map((b) => b.memGiB));
  const biggestCpu = Math.max(...bins.map((b) => b.cpuMillis));
  const biggestNode = bins.find((b) => b.memGiB === biggestMem);

  // Decreasing by memory, then CPU, then input order — so the same wave against
  // the same cluster always produces the same plan.
  //
  // The direction is a real choice, not a detail. Largest-first packs the most
  // GiB and proves the big machines can land; smallest-first places the most
  // MACHINES. On a cluster with one node and a tight fit those differ, and a
  // panel that silently picks one and reports "8 of 15" as though it were the
  // answer is hiding a decision the operator should be making.
  const smallestFirst = opts.order === "smallest-first";
  const order = vms
    .map((v, i) => ({ vm: v, i, need: vmDemand(v, opts) }))
    .sort((a, b) => (smallestFirst
      ? a.need.memGiB - b.need.memGiB || a.need.cpuMillis - b.need.cpuMillis || a.i - b.i
      : b.need.memGiB - a.need.memGiB || b.need.cpuMillis - a.need.cpuMillis || a.i - b.i));

  const placed = [], unplaced = [];
  for (const { vm, need } of order) {
    if (need.memGiB > biggestMem || need.cpuMillis > biggestCpu) {
      unplaced.push({
        name: vm.name, need, permanent: true, blockedBy: "hardware",
        reason: `Needs ${need.memGiB.toFixed(1)} GiB and ${need.cpuMillis}m, but the largest virtualization node (${biggestNode.name}) offers only ${biggestNode.memGiB} GiB and ${biggestNode.cpuMillis}m. A VM is a pod — it must fit on one node — so this machine would never schedule here, whatever the cluster's total capacity.`,
      });
      continue;
    }
    // Could it have landed anywhere before this wave started? The answer is
    // what separates "the cluster is full" from "the wave filled it".
    const everHadRoom = bins.some((b) => need.memGiB <= b.freeMemGiB && need.cpuMillis <= b.freeCpuMillis);
    const bin = bins.find((b) => need.memGiB <= b.remMemGiB && need.cpuMillis <= b.remCpuMillis);

    if (!bin) {
      const ahead = placed.length;
      const emptiest = bins.slice().sort((a, b) => b.remMemGiB - a.remMemGiB)[0];
      unplaced.push({
        name: vm.name, need, permanent: false,
        blockedBy: everHadRoom ? "wave" : "cluster",
        ahead: everHadRoom ? ahead : null,
        reason: everHadRoom
          ? `Needs ${need.memGiB.toFixed(1)} GiB, and a node had that free before the wave started — so on its own it would fit. After the ${ahead} machine${ahead === 1 ? "" : "s"} ahead of it in this wave are placed, the emptiest node has ${emptiest.remMemGiB.toFixed(1)} GiB left. The wave blocks this machine, not the cluster: re-order it, or move it to the next wave.`
          : `Fits the hardware, but no node has room — the emptiest (${emptiest.name}) has ${emptiest.freeMemGiB.toFixed(1)} GiB and ${emptiest.freeCpuMillis}m unreserved. Scale the cluster or free capacity before cutover.`,
      });
      continue;
    }

    bin.remMemGiB = r2(bin.remMemGiB - need.memGiB);
    bin.remCpuMillis -= need.cpuMillis;
    bin.vms.push(vm.name);
    placed.push({
      name: vm.name, node: bin.name, need,
      spareMemGiB: bin.remMemGiB, spareCpuMillis: bin.remCpuMillis,
      // Nothing else this size fits here afterwards. Worth saying, because it
      // is the row that turns into a blocker when one more VM joins the wave.
      tight: bin.remMemGiB < need.memGiB,
    });
  }

  const nodes = bins.map((b) => ({
    name: b.name, memGiB: b.memGiB, cpuMillis: b.cpuMillis,
    vmCount: b.vms.length, vms: b.vms,
    // What this wave adds, and what the node carries in total afterwards.
    assignedMemGiB: r2(b.freeMemGiB - b.remMemGiB),
    usedMemGiB: r2(b.memGiB - b.remMemGiB),
    freeAfterMemGiB: b.remMemGiB,
    pctMem: b.memGiB > 0 ? Math.round(((b.memGiB - b.remMemGiB) / b.memGiB) * 100) : null,
  }));

  // Would the other direction place more machines? Only worth asking when
  // something failed to land, and only one level deep.
  let alternative = null;
  if (unplaced.length && !opts._noAlternative) {
    const other = packWave(vms, capacity, {
      ...opts, _noAlternative: true,
      order: smallestFirst ? "largest-first" : "smallest-first",
    });
    if (other.available && other.placedCount > placed.length) {
      alternative = {
        order: smallestFirst ? "largest-first" : "smallest-first",
        placedCount: other.placedCount,
        gain: other.placedCount - placed.length,
        note: `Ordered ${smallestFirst ? "largest" : "smallest"}-first, ${other.placedCount} of ${vms.length} would place rather than ${placed.length} — the same cluster, a different wave order. Neither is more correct: ${smallestFirst ? "smallest" : "largest"}-first proves the biggest machines can land and moves the most data; the other moves the most machines per window. Choose by what the outage window is for.`,
      };
    }
  }

  return {
    available: true,
    fits: unplaced.length === 0,
    placed, unplaced, nodes,
    placedCount: placed.length, unplacedCount: unplaced.length,
    nodesUsed: nodes.filter((n) => n.vmCount > 0).length,
    excluded: capacity.excluded || [],
    order: smallestFirst ? "smallest-first" : "largest-first",
    alternative,
    // Named, because the order decides which machine is the one left over.
    // The scheduler spreads by default rather than packing tight, so this
    // answers "can every machine be placed at once" — it is a feasibility
    // proof, not a prediction of the node each VM ends up on. Saying "lands on
    // worker-03" as though it were a forecast would be a claim this cannot
    // make, and the first person to check it would find it wrong.
    heuristic: `Packed ${smallestFirst ? "smallest-memory-first (first-fit-increasing)" : "largest-memory-first (first-fit-decreasing)"} onto nodes that are Ready, uncordoned and virt-schedulable. This shows that a placement exists, not where the scheduler will choose: it spreads across nodes by default rather than filling them.`,
  };
}

/**
 * What happens if one node is lost mid-wave — patching, a drain, a failure.
 * Pure: the same pack, re-run with each node removed in turn.
 *
 * No assessment tool answers this, because none of them are operating the
 * target. It is the difference between "the wave fits" and "the wave fits as
 * long as nothing happens for four hours".
 */
export function nodeLossRehearsal(vms = [], capacity = null, opts = {}) {
  const base = packWave(vms, capacity, opts);
  if (!base.available) return { available: false, reason: base.reason, nodes: [] };

  const usable = usableNodes(capacity);
  if (usable.length < 2) {
    return {
      available: true, nodes: [], singleNode: true,
      note: "Only one node can host a VM, so there is nothing to fail over to — losing it strands the whole wave.",
    };
  }

  const baseUnplaced = new Set(base.unplaced.map((u) => u.name));
  const rows = usable.map((n) => {
    const without = { ...capacity, nodes: (capacity.nodes || []).filter((x) => x.name !== n.name) };
    const p = packWave(vms, without, opts);
    // Machines that placed with this node and do not place without it. Repacking
    // reshuffles, so this is counted from the outcome rather than assumed to be
    // the ones that happened to land here.
    const stranded = p.available ? p.unplaced.filter((u) => !baseUnplaced.has(u.name)) : [];
    const hosted = base.nodes.find((b) => b.name === n.name)?.vmCount || 0;
    const overCommitted = p.available ? p.nodes.filter((x) => x.pctMem != null && x.pctMem >= 90).length : 0;
    return {
      node: n.name, hosted,
      // Losing a node re-packs the WHOLE wave, so the machines left over are
      // not necessarily the ones that happened to be sitting on it. Reporting
      // "4 to rehome, 4 rehomed" would be arithmetic about the wrong set: the
      // number that matters is how much of the wave still places at all.
      stillPlaces: p.available ? p.placedCount : 0,
      stranded: p.available ? stranded.length : hosted,
      strandedNames: stranded.slice(0, 6).map((s) => s.name),
      tightNodesAfter: overCommitted,
      absorbs: p.available && stranded.length === 0,
    };
  });

  const worst = rows.slice().sort((a, b) => b.stranded - a.stranded)[0];
  return {
    available: true,
    nodes: rows,
    worst: worst?.stranded ? worst : null,
    headline: worst?.stranded
      ? `Losing ${worst.node} mid-wave would strand ${worst.stranded} machine${worst.stranded === 1 ? "" : "s"} — do not drain it while this wave runs.`
      : "Any single node can be lost mid-wave and every machine still has somewhere to go.",
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

  // Where each machine actually lands, packed as a set. The totals below say
  // whether the room exists; only this says whether it can be reached.
  const placement = packWave(vms, capacity, opts);
  const rehearsal = nodeLossRehearsal(vms, capacity, opts);
  const waveBlocked = (placement.unplaced || []).filter((u) => u.blockedBy === "wave");

  // Memory is the binding constraint: it is not overcommitted, CPU is.
  const memRatio = free.freeMemGiB > 0 ? demand.memGiB / free.freeMemGiB : Infinity;
  const verdict = never.length ? "blocked"
    : memRatio > 1 ? "exceeds"
    // The room exists in total and still cannot be reached: free memory is
    // spread across nodes in pieces too small for these machines. Aggregate
    // arithmetic alone would call this a pass.
    : waveBlocked.length ? "fragmented"
    : memRatio > 0.8 ? "tight"
    : "fits";

  const headline = {
    blocked: `${never.length} VM${never.length === 1 ? "" : "s"} cannot schedule on any node in this cluster, whatever the cluster's total capacity.`,
    exceeds: `This wave needs ${demand.memGiB} GiB but only ${free.freeMemGiB} GiB is unreserved across ${capacity.virtNodeCount} virtualization node(s).`,
    fragmented: `The cluster has room — ${demand.memGiB} GiB of ${free.freeMemGiB} GiB unreserved — but ${waveBlocked.length} machine${waveBlocked.length === 1 ? "" : "s"} still cannot be placed, because the free memory is split across nodes in pieces too small to take them.`,
    tight: `This wave needs ${demand.memGiB} GiB of the ${free.freeMemGiB} GiB unreserved — it fits, with little margin left.`,
    fits: `All ${placement.placedCount} machine${placement.placedCount === 1 ? "" : "s"} place onto ${placement.nodesUsed} of ${capacity.virtNodeCount} virtualization node(s) — ${demand.memGiB} GiB of ${free.freeMemGiB} GiB unreserved.`,
  }[verdict];

  const notes = [];
  if (notNow.length) notes.push(`${notNow.length} VM(s) fit the hardware but no single node has room today — scale or free capacity before cutover.`);
  if (placement.available) notes.push(placement.heuristic);
  if (rehearsal.available && rehearsal.worst) notes.push(rehearsal.headline);
  if (capacity.excluded?.length) {
    notes.push(`${capacity.excluded.length} node(s) excluded from this calculation: ${capacity.excluded.map((e) => `${e.name} (${e.reason})`).join("; ")}`);
  }
  if (capacity.partial) notes.push("Pod requests could not be read in full, so committed capacity is a lower bound and real headroom may be smaller.");
  const { cpuAllocationRatio, memoryOverheadMiB } = { ...DEFAULTS, ...opts };
  notes.push(`Assumes OpenShift Virtualization defaults: CPU overcommitted ${cpuAllocationRatio}:1, memory not overcommitted, ${memoryOverheadMiB} MiB virt-launcher overhead per VM.`);

  return {
    verdict, demand, perVm, headline, notes,
    placement, rehearsal,
    free: { cpuMillis: free.freeCpuMillis, memGiB: free.freeMemGiB },
    allocatable: { cpuMillis: free.cpuMillis, memGiB: free.memGiB },
    virtNodeCount: capacity.virtNodeCount,
    largestNode: capacity.largestNode,
  };
}
