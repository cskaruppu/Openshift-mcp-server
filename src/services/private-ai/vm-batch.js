// Act 4: assess a whole VMware estate in one run, on the cluster's GPUs.
//
// The VM Migration Agent already does the work per selection: analyseFleet()
// decides support level and blockers in code, adviseMigration() asks the model
// for warm/cold and risk — 40 VMs per call, clamped by code afterwards. This
// runs that same pipeline over every VM, many calls in parallel, which is
// practical only when the model is local (no per-call cost, no rate limit).
//
// Input: a real inventory (CSV exported from vCenter or the agent, parsed by
// machine-csv.js) or a SYNTHETIC sample estate for rehearsal, which is always
// labelled as such on screen.

import { analyseFleet, adviseMigration, normaliseInventoryVM } from "../vm-migration.js";

const CHUNK = 40;
const CONCURRENCY = () => Math.max(1, Number(process.env.PRIVATE_AI_BATCH_CONCURRENCY) || 8);

let _run = null;

/* ─────────────────────────── synthetic sample estate ─────────────────────────── */

// Deterministic, so every rehearsal shows the same estate.
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const OS = [
  ["Red Hat Enterprise Linux 8 (64-bit)", "rhel8_64Guest", 22], ["Red Hat Enterprise Linux 9 (64-bit)", "rhel9_64Guest", 12],
  ["Red Hat Enterprise Linux 7 (64-bit)", "rhel7_64Guest", 9], ["Microsoft Windows Server 2019 (64-bit)", "windows2019srv_64Guest", 15],
  ["Microsoft Windows Server 2022 (64-bit)", "windows2019srvNext_64Guest", 8], ["Microsoft Windows Server 2016 (64-bit)", "windows9Server64Guest", 9],
  ["Microsoft Windows Server 2012 R2 (64-bit)", "windows8Server64Guest", 5], ["Ubuntu Linux (64-bit)", "ubuntu64Guest", 8],
  ["CentOS 7 (64-bit)", "centos7_64Guest", 6], ["SUSE Linux Enterprise 15 (64-bit)", "sles15_64Guest", 4], ["Microsoft Windows Server 2008 R2 (64-bit)", "windows7Server64Guest", 2],
];
const TIERS = ["web", "app", "api", "db", "batch", "mq", "etl", "auth", "rpt", "cache"];
const BUS = ["payments", "cards", "loans", "crm", "hr", "treasury", "branch", "digital", "risk", "ops"];

export function sampleEstate(count = 2000, seed = 2026) {
  const r = rng(seed);
  const total = OS.reduce((s, o) => s + o[2], 0);
  const pickOS = () => { let x = r() * total; for (const o of OS) { if ((x -= o[2]) <= 0) return o; } return OS[0]; };
  const vms = [];
  for (let i = 0; i < count; i++) {
    const [guestName, guestId] = pickOS();
    const tier = TIERS[Math.floor(r() * TIERS.length)], bu = BUS[Math.floor(r() * BUS.length)];
    const disks = Array.from({ length: tier === "db" ? 2 + Math.floor(r() * 3) : 1 + Math.floor(r() * 2) }, () => ({ capacity: Math.round((tier === "db" ? 200 + r() * 1800 : 40 + r() * 260) * 1073741824) }));
    vms.push(normaliseInventoryVM({
      id: `vm-${10000 + i}`, name: `${bu}-${tier}-${String(i % 97).padStart(2, "0")}${String.fromCharCode(97 + (i % 26))}`,
      guestName, guestId, powerState: r() < 0.9 ? "poweredOn" : "poweredOff",
      cpuCount: [2, 2, 4, 4, 8, 16][Math.floor(r() * 6)], memoryMB: [4096, 8192, 8192, 16384, 32768, 65536][Math.floor(r() * 6)],
      disks, changeTrackingEnabled: r() < 0.7, guestToolsStatus: r() < 0.93 ? "toolsOk" : "toolsNotRunning",
      firmware: r() < 0.6 ? "efi" : "bios", isTemplate: false, connectionState: "connected", faultToleranceEnabled: false,
    }));
  }
  return vms;
}

/* ─────────────────────────── the run ─────────────────────────── */

export function batchStatus() {
  if (!_run) return { state: "idle" };
  const { vms, ...rest } = _run;
  const elapsedMs = (_run.finishedAt ? new Date(_run.finishedAt) : new Date()) - new Date(_run.startedAt);
  return { ...rest, total: vms.length, elapsedMs, vmsPerMinute: _run.done ? Math.round(_run.done / Math.max(elapsedMs / 60000, 1 / 60)) : 0 };
}

/**
 * Start an assessment. Returns at once; poll batchStatus().
 * @param vms     normalised VMs (or null with sample=true)
 * @param sample  true → the synthetic estate (labelled on screen)
 */
export function startBatch({ vms = null, sample = false, count = 2000, actor = "presenter" } = {}) {
  if (_run && _run.state === "running") throw Object.assign(new Error("An assessment is already running"), { status: 409 });
  const list = sample ? sampleEstate(Math.min(5000, Math.max(10, Number(count) || 2000))) : (vms || []).map((v) => (v.guestOS !== undefined ? v : normaliseInventoryVM(v)));
  if (!list.length) throw Object.assign(new Error("No VMs to assess — upload an inventory or use the sample estate"), { status: 400 });
  _run = {
    id: `assess-${Date.now().toString(36)}`, state: "running", synthetic: !!sample, startedAt: new Date().toISOString(), finishedAt: null, by: actor,
    vms: list, done: 0, aiCalls: 0, aiSource: { ai: 0, heuristic: 0 }, errors: 0,
    analysis: null, decisions: null, waves: null, unsupported: null,
  };
  run(_run).catch((e) => { _run.state = "failed"; _run.error = e.message; _run.finishedAt = new Date().toISOString(); });
  return batchStatus();
}

async function run(r) {
  // 1. Support level and blockers: deterministic, all VMs at once.
  const analysis = analyseFleet(r.vms);
  r.analysis = { total: analysis.total, byLevel: analysis.byLevel, totalDiskGiB: analysis.totalDiskGiB, warmEligible: analysis.warmEligible,
    families: (analysis.families || []).map((f) => ({ family: f.family, total: f.total })) };
  const levelByName = new Map((analysis.rows || analysis.vms || []).map((x) => [x.name, x.level]));

  // 2. Migration method and risk: the model, CHUNK VMs per call, in parallel.
  const chunks = [];
  for (let i = 0; i < r.vms.length; i += CHUNK) chunks.push(r.vms.slice(i, i + CHUNK));
  const advice = [];
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const c = chunks[next++];
      try {
        const a = await adviseMigration(c, { reportId: r.id });
        r.aiCalls += a.source === "ai" ? 1 : 0;
        r.aiSource[a.source === "ai" ? "ai" : "heuristic"] += c.length;
        advice.push(...(a.advice || []));
      } catch { r.errors++; }
      r.done = Math.min(r.vms.length, r.done + c.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY(), chunks.length) }, worker));

  // 3. Decisions and waves, in code, from what the two steps returned.
  const byName = new Map(advice.map((a) => [a.name, a]));
  const dec = { move: 0, upgradeFirst: 0, retire: 0, review: 0 };
  const waves = { 1: [], 2: [], 3: [], hold: [] };
  for (const vm of r.vms) {
    const level = levelByName.get(vm.name) || "unknown";
    const a = byName.get(vm.name);
    if (!vm.poweredOn) { dec.retire++; waves.hold.push(vm.name); continue; }
    if (level === "unsupported") { dec.upgradeFirst++; waves.hold.push(vm.name); continue; }
    if (level === "unknown") { dec.review++; waves.hold.push(vm.name); continue; }
    dec.move++;
    const risk = a?.risk || (level === "caveats" ? "medium" : "low");
    waves[risk === "low" ? 1 : risk === "medium" ? 2 : 3].push(vm.name);
  }
  r.decisions = [
    { key: "move", label: "Move to OpenShift Virtualization", n: dec.move, why: "Supported guest, no blockers" },
    { key: "upgradeFirst", label: "Upgrade the OS first", n: dec.upgradeFirst, why: "Guest OS not supported on the target" },
    { key: "retire", label: "Candidate to retire", n: dec.retire, why: "Powered off in the inventory" },
    { key: "review", label: "Needs review", n: dec.review, why: "Guest OS could not be identified" },
  ];
  r.waves = [
    { name: "Wave 1", risk: "Low", n: waves[1].length, sample: waves[1].slice(0, 5) },
    { name: "Wave 2", risk: "Medium", n: waves[2].length, sample: waves[2].slice(0, 5) },
    { name: "Wave 3", risk: "High", n: waves[3].length, sample: waves[3].slice(0, 5) },
    { name: "Hold", risk: "—", n: waves.hold.length, sample: waves.hold.slice(0, 5) },
  ];
  r.state = "done";
  r.finishedAt = new Date().toISOString();
}

export function _resetBatch() { _run = null; }
