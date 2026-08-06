/**
 * VM Lifecycle — UC-06 Phase 3: the agent owns what it provisioned.
 *
 * Phase 2 wrote provenance onto every VM the platform creates — owner, cost
 * centre, request id, expiry, and the size that was chosen. This module reads
 * it back and acts on it:
 *
 *   fleet()        — every VM we provisioned, with its provenance and live usage
 *   expirySweep()  — VMs past their stated decommission date
 *   rightSizing()  — VMs whose real usage no longer matches the size we picked
 *
 * Each finding carries a ready-to-raise change request that references the
 * ORIGINAL request id. That back-reference is the point: a competitor can
 * provision a VM, but only an agent that also operates the estate can say
 * "the VM I built for you in March under CHG0041022 is now undersized".
 *
 * Nothing here mutates anything. It produces recommendations and change
 * requests; a human approves, exactly as in Phase 2.
 */

import { ocpGet } from "../utils/openshift-client.js";
import { promQuery } from "./prometheus.js";
import { listProvisionables, parseMemToMi, reconcileSizing, normalizeVMRequest } from "./vm-provisioning.js";

const KUBEVIRT_API = "apis/kubevirt.io/v1";
const MANAGED_BY = "app.kubernetes.io/managed-by=tcs-agentic-ai";

// Sustained pressure thresholds. Deliberately conservative: a right-sizing
// recommendation that fires on a spike trains people to ignore them.
const MEM_HIGH_PCT = parseInt(process.env.VM_MEM_HIGH_PCT || "85", 10);
const MEM_LOW_PCT = parseInt(process.env.VM_MEM_LOW_PCT || "25", 10);
const CPU_HIGH_PCT = parseInt(process.env.VM_CPU_HIGH_PCT || "80", 10);
const CPU_LOW_PCT = parseInt(process.env.VM_CPU_LOW_PCT || "10", 10);
const SUSTAIN_DAYS = parseInt(process.env.VM_SUSTAIN_DAYS || "7", 10);
const EXPIRY_WARN_DAYS = parseInt(process.env.VM_EXPIRY_WARN_DAYS || "14", 10);

const daysBetween = (a, b) => Math.round((b - a) / 86400000);

/**
 * Every VM this platform provisioned, with provenance and live state.
 * VMs created by hand are deliberately excluded — the agent only claims
 * ownership of what it actually built.
 */
export async function fleet({ includeUnmanaged = false } = {}) {
  let list;
  try {
    list = await ocpGet(`/${KUBEVIRT_API}/virtualmachines`
      + (includeUnmanaged ? "" : `?labelSelector=${encodeURIComponent(MANAGED_BY)}`));
  } catch (e) {
    return { vms: [], error: e.message };
  }
  const vms = (list.items || []).map((vm) => {
    const ann = vm.metadata?.annotations || {};
    const lab = vm.metadata?.labels || {};
    const conds = vm.status?.conditions || [];
    const ready = conds.some((c) => c.type === "Ready" && c.status === "True");
    return {
      name: vm.metadata.name,
      namespace: vm.metadata.namespace,
      created: vm.metadata.creationTimestamp,
      printableStatus: vm.status?.printableStatus || (ready ? "Running" : "Unknown"),
      ready,
      runStrategy: vm.spec?.runStrategy || null,
      instanceType: vm.spec?.instancetype?.name || null,
      cpuCores: vm.spec?.template?.spec?.domain?.cpu?.cores ?? null,
      memory: vm.spec?.template?.spec?.domain?.memory?.guest ?? null,
      diskSize: vm.spec?.dataVolumeTemplates?.[0]?.spec?.storage?.resources?.requests?.storage ?? null,
      provenance: {
        managed: lab["app.kubernetes.io/managed-by"] === "tcs-agentic-ai",
        owner: ann["tcs.ai/owner"] || null,
        costCentre: lab["tcs.ai/cost-centre"] || null,
        environment: lab["tcs.ai/environment"] || null,
        requestId: ann["tcs.ai/request-id"] || null,
        provisionedAt: ann["tcs.ai/provisioned-at"] || vm.metadata.creationTimestamp || null,
        expiresOn: ann["tcs.ai/expires-on"] || null,
        sizingRationale: ann["tcs.ai/sizing-rationale"] || null,
      },
    };
  });
  return { vms };
}

// ---------------------------------------------------------------------------
// Guest usage
// ---------------------------------------------------------------------------
/**
 * Live memory and CPU utilisation per VM, from the KubeVirt exporter.
 * Returns a map keyed "namespace/name". Absent entries simply mean no data —
 * every caller treats that as "cannot judge", never as "idle".
 */
export async function guestUsage() {
  const out = new Map();
  const put = (m, key, val) => {
    const id = `${m.namespace}/${m.name}`;
    if (!m.namespace || !m.name || !Number.isFinite(val)) return;
    out.set(id, { ...(out.get(id) || {}), [key]: val });
  };

  // KubeVirt renamed several of these between releases, so try each candidate
  // and take the first that returns data rather than assuming one shape.
  const firstThatAnswers = async (queries) => {
    for (const q of queries) {
      try {
        const r = await promQuery(q);
        if (r.length) return r;
      } catch { /* try the next form */ }
    }
    return [];
  };

  const mem = await firstThatAnswers([
    `100 * (1 - sum by (namespace, name) (kubevirt_vmi_memory_available_bytes)
              / sum by (namespace, name) (kubevirt_vmi_memory_domain_bytes_total))`,
    `100 * (1 - sum by (namespace, name) (kubevirt_vmi_memory_available_bytes)
              / sum by (namespace, name) (kubevirt_vmi_memory_domain_bytes))`,
    `100 * sum by (namespace, name) (kubevirt_vmi_memory_used_bytes)
         / sum by (namespace, name) (kubevirt_vmi_memory_domain_bytes_total)`,
  ]);
  for (const s of mem) put(s.metric, "memPct", Math.round(parseFloat(s.value[1])));

  // CPU as a percentage of the vCPUs the VM was given. The vcpu label on
  // kubevirt_vmi_vcpu_seconds_total gives the allocated count.
  const cpu = await firstThatAnswers([
    `100 * sum by (namespace, name) (rate(kubevirt_vmi_cpu_usage_seconds_total[30m]))
         / count by (namespace, name) (kubevirt_vmi_vcpu_seconds_total)`,
    `100 * sum by (namespace, name) (rate(kubevirt_vmi_vcpu_seconds_total[30m]))
         / count by (namespace, name) (kubevirt_vmi_vcpu_seconds_total)`,
  ]);
  for (const s of cpu) put(s.metric, "cpuPct", Math.round(parseFloat(s.value[1])));

  // Guest filesystem — only reported when the qemu-guest-agent is installed.
  const disk = await firstThatAnswers([
    `max by (namespace, name) (100 * (1 - kubevirt_vmi_filesystem_free_bytes
                                        / kubevirt_vmi_filesystem_capacity_bytes))`,
  ]);
  for (const s of disk) put(s.metric, "diskPct", Math.round(parseFloat(s.value[1])));

  return out;
}

// ---------------------------------------------------------------------------
// Access — how do I actually get into this VM?
// ---------------------------------------------------------------------------
/**
 * The question every platform makes you go hunting for. We provisioned the VM,
 * so we know the username, and the VMI reports the address once it is up.
 */
export async function vmAccess(namespace, name) {
  let vm = null, vmi = null;
  try { vm = await ocpGet(`/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachines/${name}`); }
  catch (e) { return { error: `VM ${namespace}/${name} not found: ${e.message}` }; }
  try { vmi = await ocpGet(`/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachineinstances/${name}`); }
  catch { /* not running yet — still worth returning the commands */ }

  // The cloud-init user we created at provisioning time.
  const userData = (vm.spec?.template?.spec?.volumes || [])
    .find((v) => v.cloudInitNoCloud)?.cloudInitNoCloud?.userData || "";
  const user = /^\s*-\s*name:\s*(\S+)/m.exec(userData)?.[1] || "cloud-user";

  const ips = (vmi?.status?.interfaces || []).map((i) => i.ipAddress).filter(Boolean);
  const status = vm.status?.printableStatus || "Unknown";
  const ready = (vm.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True");
  const agentConnected = (vmi?.status?.conditions || [])
    .some((c) => c.type === "AgentConnected" && c.status === "True");

  const methods = [
    { label: "SSH via virtctl (works without exposing the VM)", command: `virtctl ssh ${user}@${name} -n ${namespace}`, recommended: true },
    { label: "Serial console", command: `virtctl console ${name} -n ${namespace}` },
    { label: "Graphical console (VNC)", command: `virtctl vnc ${name} -n ${namespace}` },
  ];
  if (ips.length) {
    methods.push({ label: `Direct SSH (reachable from the cluster network)`, command: `ssh ${user}@${ips[0]}` });
  }
  methods.push({
    label: "Port-forward SSH to your workstation",
    command: `virtctl port-forward vm/${name} 2222:22 -n ${namespace}\n# then: ssh -p 2222 ${user}@localhost`,
  });

  return {
    namespace, name, status, ready, user,
    ipAddresses: ips,
    guestAgent: agentConnected ? "connected" : "not reporting",
    methods,
    notes: [
      !ready ? "The VM is not Ready yet — these commands will work once it finishes starting." : null,
      !ips.length && ready ? "No IP reported yet. virtctl ssh works regardless; direct SSH needs the address." : null,
      !agentConnected && ready ? "qemu-guest-agent is not reporting. Install it in the image for IP reporting and graceful shutdown." : null,
      "Authentication is by the SSH key supplied at provisioning. Password login is disabled.",
    ].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Expiry enforcement — the field everyone records and nobody acts on
// ---------------------------------------------------------------------------
export async function expirySweep() {
  const { vms, error } = await fleet();
  if (error) return { expired: [], expiringSoon: [], noExpiry: [], error };
  const now = Date.now();
  const expired = [], expiringSoon = [], noExpiry = [];

  for (const vm of vms) {
    const raw = vm.provenance.expiresOn;
    if (!raw) { noExpiry.push(vm); continue; }
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) { noExpiry.push({ ...vm, note: `Unparseable expiry "${raw}"` }); continue; }
    const days = daysBetween(now, t);
    if (days < 0) {
      expired.push({
        ...vm, daysOverdue: -days,
        recommendation: `Decommission — expired ${-days} day(s) ago on ${raw}.`,
        command: `oc delete virtualmachine ${vm.name} -n ${vm.namespace}`,
        changeRequest: decommissionCR(vm, -days),
      });
    } else if (days <= EXPIRY_WARN_DAYS) {
      expiringSoon.push({ ...vm, daysRemaining: days,
        recommendation: `Expires in ${days} day(s). Confirm with ${vm.provenance.owner || "the owner"} whether to extend or decommission.` });
    }
  }
  expired.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return {
    expired, expiringSoon, noExpiry,
    summary: `${vms.length} managed VM(s): ${expired.length} expired, ${expiringSoon.length} expiring within ${EXPIRY_WARN_DAYS} days, ${noExpiry.length} with no expiry set.`,
  };
}

function decommissionCR(vm, daysOverdue) {
  return {
    shortDescription: `Decommission expired VM ${vm.namespace}/${vm.name}`,
    description: [
      `This VM was provisioned by TCS Agentic AI${vm.provenance.requestId ? ` under ${vm.provenance.requestId}` : ""}`
        + `${vm.provenance.provisionedAt ? ` on ${vm.provenance.provisionedAt.slice(0, 10)}` : ""}.`,
      `It was recorded as expiring on ${vm.provenance.expiresOn} and is now ${daysOverdue} day(s) past that date.`,
      "",
      `Owner       : ${vm.provenance.owner || "not recorded"}`,
      `Cost centre : ${vm.provenance.costCentre || "not recorded"}`,
      `Environment : ${vm.provenance.environment || "not recorded"}`,
      `Size        : ${vm.instanceType || `${vm.cpuCores} vCPU / ${vm.memory}`}, ${vm.diskSize || "unknown"} disk`,
      "",
      "Reclaiming this VM releases its quota and its storage.",
    ].join("\n"),
    type: "standard", category: "Infrastructure", risk: "low",
    implementationPlan: `oc delete virtualmachine ${vm.name} -n ${vm.namespace}`,
    backoutPlan: "Re-provision from the original request. The root disk is deleted with the VM, so confirm any data is backed up first.",
    testPlan: `oc get vm ${vm.name} -n ${vm.namespace} returns NotFound; namespace quota shows the released capacity.`,
  };
}

// ---------------------------------------------------------------------------
// Right-sizing — the loop closing
// ---------------------------------------------------------------------------
/**
 * VMs whose observed usage no longer matches the size chosen at provisioning
 * time. Each recommendation references the original request, which is the
 * whole point of having written the provenance.
 */
export async function rightSizing() {
  const { vms, error } = await fleet();
  if (error) return { candidates: [], error };
  const usage = await guestUsage();
  const cat = await listProvisionables().catch(() => ({ instanceTypes: [] }));
  const its = cat.instanceTypes || [];

  const candidates = [];
  for (const vm of vms) {
    if (!vm.ready) continue;                                  // judge only running VMs
    const u = usage.get(`${vm.namespace}/${vm.name}`);
    if (!u || !Number.isFinite(u.memPct)) continue;           // no data is not evidence
    const ageDays = vm.provenance.provisionedAt
      ? daysBetween(Date.parse(vm.provenance.provisionedAt), Date.now()) : null;
    if (ageDays != null && ageDays < SUSTAIN_DAYS) continue;   // too new to judge

    const cur = currentSize(vm, its);
    if (!cur.cpu || !cur.memMi) continue;

    let direction = null, why = null;
    if (u.memPct >= MEM_HIGH_PCT) {
      direction = "up";
      why = `memory has been at ${u.memPct}% of ${fmtMi(cur.memMi)}`;
    } else if (u.memPct <= MEM_LOW_PCT && (u.cpuPct == null || u.cpuPct <= CPU_LOW_PCT)) {
      direction = "down";
      why = `memory is at ${u.memPct}% of ${fmtMi(cur.memMi)}`
        + (u.cpuPct != null ? ` and CPU at ${u.cpuPct}%` : "");
    } else if (u.cpuPct != null && u.cpuPct >= CPU_HIGH_PCT) {
      direction = "up";
      why = `CPU has been at ${u.cpuPct}% of ${cur.cpu} vCPU`;
    }
    if (!direction) continue;

    const target = proposeSize(cur, direction, its);
    if (!target) continue;

    candidates.push({
      name: vm.name, namespace: vm.namespace,
      provenance: vm.provenance,
      current: { instanceType: vm.instanceType, cpu: cur.cpu, memory: fmtMi(cur.memMi) },
      observed: { memPct: u.memPct, cpuPct: u.cpuPct ?? null, diskPct: u.diskPct ?? null, ageDays },
      direction,
      proposed: target,
      rationale: buildRationale(vm, why, direction, target, ageDays),
      command: target.instanceType
        ? `oc patch virtualmachine ${vm.name} -n ${vm.namespace} --type=merge -p '{"spec":{"instancetype":{"name":"${target.instanceType}"}}}'`
        : `oc patch virtualmachine ${vm.name} -n ${vm.namespace} --type=merge -p '{"spec":{"template":{"spec":{"domain":{"memory":{"guest":"${target.memory}"}}}}}}'`,
      changeRequest: rightSizeCR(vm, cur, target, why, direction),
      note: "Applying this restarts the VM — an instance type change is not hot-pluggable.",
    });
  }
  candidates.sort((a, b) => (b.observed.memPct || 0) - (a.observed.memPct || 0));
  return {
    candidates,
    summary: candidates.length
      ? `${candidates.length} provisioned VM(s) no longer match the size chosen for them.`
      : `Every provisioned VM is sized appropriately for its observed usage.`,
    thresholds: { MEM_HIGH_PCT, MEM_LOW_PCT, CPU_HIGH_PCT, CPU_LOW_PCT, SUSTAIN_DAYS },
  };
}

const fmtMi = (mi) => (mi >= 1024 ? `${Math.round((mi / 1024) * 10) / 10}Gi` : `${mi}Mi`);

function currentSize(vm, instanceTypes) {
  if (vm.instanceType) {
    const it = instanceTypes.find((i) => i.name === vm.instanceType);
    if (it) return { cpu: it.cpu, memMi: parseMemToMi(it.memory), instanceType: it.name };
  }
  return { cpu: vm.cpuCores || null, memMi: parseMemToMi(vm.memory), instanceType: null };
}

/** Next size up or down in the catalogue; falls back to doubling/halving memory. */
function proposeSize(cur, direction, instanceTypes) {
  if (instanceTypes.length) {
    const sorted = [...instanceTypes].sort((a, b) => a.cpu - b.cpu || parseMemToMi(a.memory) - parseMemToMi(b.memory));
    const idx = sorted.findIndex((i) => i.cpu === cur.cpu && parseMemToMi(i.memory) === cur.memMi);
    if (idx !== -1) {
      const next = direction === "up" ? sorted[idx + 1] : sorted[idx - 1];
      if (next) return { instanceType: next.name, cpu: next.cpu, memory: next.memory };
      return null;                                  // already at the edge of the catalogue
    }
    // Not on a standard size — recommend the nearest standard in that direction.
    const want = direction === "up"
      ? { cpuCores: cur.cpu, memoryMi: Math.round(cur.memMi * 2) }
      : { cpuCores: Math.max(1, Math.floor(cur.cpu / 2)), memoryMi: Math.max(512, Math.round(cur.memMi / 2)) };
    const rec = reconcileSizing(normalizeVMRequest(want), sorted);
    if (rec.chosen) return { instanceType: rec.chosen.name, cpu: rec.chosen.cpu, memory: rec.chosen.memory };
  }
  const memMi = direction === "up" ? cur.memMi * 2 : Math.max(512, Math.round(cur.memMi / 2));
  return { instanceType: null, cpu: cur.cpu, memory: fmtMi(memMi) };
}

/** The sentence that only an agent which provisioned the VM can write. */
function buildRationale(vm, why, direction, target, ageDays) {
  const p = vm.provenance;
  const origin = p.requestId
    ? `This VM was provisioned under ${p.requestId}`
    : "This VM was provisioned by TCS Agentic AI";
  const when = p.provisionedAt ? ` on ${p.provisionedAt.slice(0, 10)}` : "";
  const sized = vm.instanceType ? `, sized ${vm.instanceType}` : "";
  const because = p.sizingRationale ? ` (${p.sizingRationale})` : "";
  const forDays = ageDays != null ? ` over ${ageDays} day(s)` : "";
  const verb = direction === "up" ? "Recommend increasing" : "Recommend reducing";
  return `${origin}${when}${sized}${because}. Since then, ${why}${forDays}. `
    + `${verb} it to ${target.instanceType || target.memory}.`;
}

function rightSizeCR(vm, cur, target, why, direction) {
  return {
    shortDescription: `Right-size VM ${vm.namespace}/${vm.name} `
      + `(${cur.instanceType || `${cur.cpu} vCPU`} → ${target.instanceType || target.memory})`,
    description: [
      buildRationale(vm, why, direction, target, null),
      "",
      `Original request : ${vm.provenance.requestId || "not recorded"}`,
      `Provisioned      : ${vm.provenance.provisionedAt || "unknown"}`,
      `Owner            : ${vm.provenance.owner || "not recorded"}`,
      `Cost centre      : ${vm.provenance.costCentre || "not recorded"}`,
      `Environment      : ${vm.provenance.environment || "not recorded"}`,
      "",
      `Current : ${cur.instanceType || `${cur.cpu} vCPU / ${fmtMi(cur.memMi)}`}`,
      `Proposed: ${target.instanceType || `${target.cpu} vCPU / ${target.memory}`}`,
      "",
      "Note: changing the instance type restarts the VM. Schedule accordingly.",
    ].join("\n"),
    type: "normal", category: "Infrastructure",
    risk: vm.provenance.environment === "prod" ? "moderate" : "low",
    implementationPlan: target.instanceType
      ? `oc patch virtualmachine ${vm.name} -n ${vm.namespace} --type=merge -p '{"spec":{"instancetype":{"name":"${target.instanceType}"}}}'\n`
        + `oc restart vm ${vm.name} -n ${vm.namespace}`
      : `oc patch virtualmachine ${vm.name} -n ${vm.namespace} --type=merge -p '{"spec":{"template":{"spec":{"domain":{"memory":{"guest":"${target.memory}"}}}}}}'`,
    backoutPlan: cur.instanceType
      ? `oc patch virtualmachine ${vm.name} -n ${vm.namespace} --type=merge -p '{"spec":{"instancetype":{"name":"${cur.instanceType}"}}}'`
      : `Restore memory to ${fmtMi(cur.memMi)}.`,
    testPlan: `VM returns to Running; guest memory utilisation settles below ${MEM_HIGH_PCT}%.`,
  };
}

/**
 * Everything the console needs for the lifecycle view, in one call.
 */
export async function lifecycleReport() {
  const [f, exp, rs] = await Promise.all([
    fleet().catch((e) => ({ vms: [], error: e.message })),
    expirySweep().catch((e) => ({ expired: [], expiringSoon: [], noExpiry: [], error: e.message })),
    rightSizing().catch((e) => ({ candidates: [], error: e.message })),
  ]);
  const managed = f.vms || [];
  return {
    generatedAt: new Date().toISOString(),
    fleet: {
      total: managed.length,
      running: managed.filter((v) => v.ready).length,
      byEnvironment: managed.reduce((m, v) => {
        const k = v.provenance.environment || "unlabelled";
        m[k] = (m[k] || 0) + 1; return m;
      }, {}),
      unowned: managed.filter((v) => !v.provenance.owner).length,
      withoutExpiry: (exp.noExpiry || []).length,
    },
    expiry: exp,
    rightSizing: rs,
    vms: managed,
  };
}
