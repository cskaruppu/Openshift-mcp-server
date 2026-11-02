// VM Guard — OpenShift Virtualization VMs, watched from the outside.
//
// Nothing is installed in a guest. Three sources, each saying what it is:
//
//   1. CONFIGURATION — the VirtualMachine objects. Each VM's shape (CPU,
//      memory, disks, networks, firmware, devices) is kept; every difference
//      from the last read is a change, and every difference from the approved
//      shape (the baseline) is "off baseline". Who changed it: the tool that
//      wrote the field (managedFields: OpenShift console, oc/kubectl, a
//      controller). The person needs the cluster audit log, which this does
//      not read — it says "tool", not "user".
//
//   2. GUEST OS — the VMI status KubeVirt fills from the QEMU guest agent, or
//      the OS template label when no agent reports. End-of-life is a fixed
//      table of published dates.
//
//   3. PACKAGE CVEs — an agentless disk scan, off unless enabled
//      (VM_GUARD_SCAN=true): snapshot the VM's root disk, restore the snapshot
//      to a new claim, run Trivy's VM scanner on that copy in a Job, read its
//      JSON, delete the copy. The VM keeps running and is never touched.
//
// A FACT NOT READ IS NOT A FACT OF ZERO: a VM never scanned shows "not
// scanned", never "0 CVEs".

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";
import { TIER_LABEL, prioritizeImage, enrichVuln } from "./vuln-priority.js";

const MAX_CHANGES = 500;
const MAX_VULNS_PER_VM = 400;
const REFRESH_MS = Number(process.env.VM_GUARD_REFRESH_MS) || 60_000;
const SCAN_ON = () => String(process.env.VM_GUARD_SCAN || "").toLowerCase() === "true";
const SCANNER_IMAGE = () => process.env.VM_GUARD_SCANNER_IMAGE || "docker.io/aquasec/trivy:0.57.1";
const MAX_PARALLEL = () => Math.max(1, Number(process.env.VM_GUARD_SCAN_PARALLEL) || 2);
const SCAN_TIMEOUT_MS = () => (Number(process.env.VM_GUARD_SCAN_TIMEOUT_MIN) || 45) * 60_000;

let _deps = {
  ocp: null,                          // { fetch, post, delete }
  kev: async () => new Set(),
  epss: async () => new Map(),
  now: () => Date.now(),
  storeKey: (cluster) => `vm_guard:${cluster || "local"}`,
};
export function configureVmGuard(deps) { _deps = { ..._deps, ...deps }; }

/* ─────────────────────────── state, per cluster ─────────────────────────── */

const _state = new Map();   // cluster → { vms: {key: rec}, changes: [], scans: {key: scan}, queue: [], readAt }
const _loading = new Map();
const blank = () => ({ vms: {}, changes: [], scans: {}, queue: [], readAt: null });
const filePath = (cluster) => `${process.env.VM_GUARD_STATE_DIR || "/data"}/mcp-vm-guard-${String(cluster || "local").replace(/[^A-Za-z0-9._-]/g, "_")}.json`;

async function load(cluster) {
  if (_state.has(cluster)) return _state.get(cluster);
  if (!_loading.has(cluster)) {
    _loading.set(cluster, (async () => {
      let st = null;
      try {
        if (await dbEnabled()) {
          const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [_deps.storeKey(cluster)]);
          let v = r?.rows?.[0]?.value;
          if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
          if (v && typeof v === "object") st = v;
        }
      } catch { /* fall through */ }
      if (!st) { try { st = JSON.parse(await readFile(filePath(cluster), "utf8")); } catch { /* none */ } }
      _state.set(cluster, { ...blank(), ...(st || {}) });
      return _state.get(cluster);
    })());
  }
  return _loading.get(cluster);
}

async function save(cluster) {
  const st = _state.get(cluster);
  if (!st) return "memory";
  const json = JSON.stringify(st).replace(/\\u0000/g, "");
  try {
    if (await dbEnabled()) {
      await dbQuery(`INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`, [_deps.storeKey(cluster), json]);
      return "database";
    }
  } catch { /* fall through */ }
  try { await mkdir(dirname(filePath(cluster)), { recursive: true }).catch(() => {}); await writeFile(filePath(cluster), json, "utf8"); return "file"; }
  catch { return "memory"; }
}
export function _resetVmGuard() { _state.clear(); _loading.clear(); }

/* ─────────────────────────── VM shape ─────────────────────────── */

const keyOf = (ns, name) => `${ns}/${name}`;

/** "2Gi", "2048Mi", "1G" → MiB (binary units exact, decimal units converted, a bare number is bytes). */
export function toMiB(q) {
  if (q == null) return null;
  const m = String(q).trim().match(/^([0-9.]+)\s*([KMGTP]i?|k)?$/);
  if (!m) return null;
  const MI = 1048576;
  const per = { Ki: 1024, Mi: MI, Gi: 1024 * MI, Ti: 1048576 * MI, Pi: 1073741824 * MI, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[m[2] || ""] ?? 1;
  return Math.round((Number(m[1]) * per) / MI);
}
const gib = (mib) => (mib == null ? null : `${Math.round((mib / 1024) * 10) / 10} Gi`);

/** The parts of a VM people care about when it changes. Stable key order, so two reads compare equal. */
export function vmShape(vm) {
  const spec = vm?.spec?.template?.spec || {};
  const dom = spec.domain || {};
  const cpu = dom.cpu || {};
  const vols = Object.fromEntries((spec.volumes || []).map((v) => [v.name, v]));
  const dvt = Object.fromEntries((vm?.spec?.dataVolumeTemplates || []).map((d) => [d.metadata?.name, d]));
  const disks = (dom.devices?.disks || []).map((d) => {
    const v = vols[d.name] || {};
    const claim = v.dataVolume?.name || v.persistentVolumeClaim?.claimName || null;
    const t = claim ? dvt[claim] : null;
    const size = t?.spec?.storage?.resources?.requests?.storage || t?.spec?.pvc?.resources?.requests?.storage || null;
    const source = claim ? `claim ${claim}` : v.containerDisk ? "container disk" : v.cloudInitNoCloud || v.cloudInitConfigDrive ? "cloud-init" : v.secret ? "secret" : v.configMap ? "config map" : Object.keys(v).find((k) => k !== "name") || "—";
    return { name: d.name, bus: d.disk?.bus || d.cdrom?.bus || d.lun?.bus || null, kind: d.cdrom ? "cdrom" : d.lun ? "lun" : "disk", source, claim, size, boot: d.bootOrder ?? null };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const nets = Object.fromEntries((spec.networks || []).map((n) => [n.name, n]));
  const nics = (dom.devices?.interfaces || []).map((i) => {
    const n = nets[i.name] || {};
    const binding = i.masquerade ? "masquerade" : i.bridge ? "bridge" : i.sriov ? "sriov" : i.binding?.name || Object.keys(i).find((k) => !["name", "model", "macAddress", "ports"].includes(k)) || "default";
    return { name: i.name, binding, network: n.pod ? "pod network" : n.multus?.networkName || "—", mac: i.macAddress || null };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const fw = dom.firmware || {};
  const efi = fw.bootloader?.efi;
  const memory = toMiB(dom.memory?.guest || dom.resources?.requests?.memory || dom.resources?.limits?.memory);
  return {
    cores: cpu.cores ?? null, sockets: cpu.sockets ?? null, threads: cpu.threads ?? null,
    vcpus: (cpu.cores || 1) * (cpu.sockets || 1) * (cpu.threads || 1),
    cpuModel: cpu.model || null, dedicatedCpu: !!cpu.dedicatedCpuPlacement,
    memoryMiB: memory,
    disks, nics,
    firmware: efi ? "UEFI" : fw.bootloader?.bios ? "BIOS" : "default",
    secureBoot: efi ? efi.secureBoot !== false : false,
    tpm: !!dom.devices?.tpm,
    gpus: (dom.devices?.gpus || []).map((g) => g.deviceName).sort(),
    hostDevices: (dom.devices?.hostDevices || []).map((g) => g.deviceName).sort(),
    runStrategy: vm?.spec?.runStrategy || (vm?.spec?.running === true ? "Always" : vm?.spec?.running === false ? "Halted" : null),
    evictionStrategy: spec.evictionStrategy || null,
  };
}

const RISK = { secureBoot: "security", tpm: "security", firmware: "security", nics: "exposure", hostDevices: "security", gpus: "size", cores: "size", sockets: "size", threads: "size", vcpus: "size", memoryMiB: "size", disks: "storage" };
const LABEL = { cores: "CPU cores", sockets: "CPU sockets", threads: "CPU threads", vcpus: "vCPUs", cpuModel: "CPU model", dedicatedCpu: "Dedicated CPUs", memoryMiB: "Memory", firmware: "Firmware", secureBoot: "Secure Boot", tpm: "TPM", gpus: "GPUs", hostDevices: "Host devices", runStrategy: "Run strategy", evictionStrategy: "Eviction strategy" };

const fmt = (field, v) => {
  if (v == null || v === "") return "—";
  if (field === "memoryMiB") return gib(v);
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  return String(v);
};

/** What differs between two shapes, as readable lines. Disks and NICs are compared by name. */
export function diffShape(a, b) {
  if (!a || !b) return [];
  const out = [];
  for (const f of Object.keys(LABEL)) {
    if (f === "vcpus") continue;   // follows cores × sockets × threads
    if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) out.push({ field: f, label: LABEL[f], kind: RISK[f] || "other", before: fmt(f, a[f]), after: fmt(f, b[f]) });
  }
  const byName = (arr) => Object.fromEntries((arr || []).map((x) => [x.name, x]));
  const da = byName(a.disks), db = byName(b.disks);
  for (const n of new Set([...Object.keys(da), ...Object.keys(db)])) {
    const x = da[n], y = db[n];
    if (!x) out.push({ field: `disk:${n}`, label: `Disk ${n}`, kind: "storage", before: "—", after: `added · ${y.source}${y.size ? ` · ${y.size}` : ""}` });
    else if (!y) out.push({ field: `disk:${n}`, label: `Disk ${n}`, kind: "storage", before: `${x.source}${x.size ? ` · ${x.size}` : ""}`, after: "removed" });
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ field: `disk:${n}`, label: `Disk ${n}`, kind: "storage", before: [x.source, x.size, x.bus].filter(Boolean).join(" · "), after: [y.source, y.size, y.bus].filter(Boolean).join(" · ") });
  }
  const na = byName(a.nics), nb = byName(b.nics);
  for (const n of new Set([...Object.keys(na), ...Object.keys(nb)])) {
    const x = na[n], y = nb[n];
    if (!x) out.push({ field: `nic:${n}`, label: `Network interface ${n}`, kind: "exposure", before: "—", after: `added · ${y.binding} → ${y.network}` });
    else if (!y) out.push({ field: `nic:${n}`, label: `Network interface ${n}`, kind: "exposure", before: `${x.binding} → ${x.network}`, after: "removed" });
    else if (x.binding !== y.binding || x.network !== y.network) out.push({ field: `nic:${n}`, label: `Network interface ${n}`, kind: "exposure", before: `${x.binding} → ${x.network}`, after: `${y.binding} → ${y.network}` });
  }
  return out;
}

/** A change that weakens the VM: Secure Boot or TPM off, a host device or a bridged NIC added. */
export function weakening(d) {
  if (d.field === "secureBoot" && d.after === "off") return "Secure Boot turned off";
  if (d.field === "tpm" && d.after === "off") return "TPM removed";
  if (d.field === "hostDevices" && d.after !== "none") return "Host device passed through";
  if (d.field.startsWith("nic:") && /added|bridge|sriov/.test(d.after) && !/pod network/.test(d.after)) return "Joined an external network";
  return null;
}

const MANAGER = [[/^Mozilla/i, "OpenShift console"], [/^kubectl|^oc$|^oc-/i, "oc / kubectl"], [/^virt-/i, "KubeVirt"], [/^argocd|^argo/i, "Argo CD (GitOps)"], [/^helm/i, "Helm"], [/^ansible|^kubernetes\.core/i, "Ansible"], [/^cdi/i, "CDI"]];
/** The tool that last wrote the VM's spec, and when (managedFields). */
export function lastWriter(vm) {
  const mf = (vm?.metadata?.managedFields || []).filter((f) => f.operation !== "Status" && f.subresource !== "status" && (!f.fieldsV1 || JSON.stringify(f.fieldsV1).includes("f:spec")));
  const last = mf.sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")))[0];
  if (!last) return { tool: null, at: null };
  const m = MANAGER.find(([re]) => re.test(last.manager || ""));
  return { tool: m ? m[1] : last.manager || null, at: last.time || null };
}

/* ─────────────────────────── guest OS and end of life ─────────────────────────── */

// Published end of standard support (vendor dates). Extended support sold
// separately is not assumed.
const EOL = [
  [/centos[^0-9]*7\b|centos linux 7/i, "2024-06-30", "CentOS 7"],
  [/centos[^0-9]*8\b|centos linux 8/i, "2021-12-31", "CentOS 8"],
  [/red hat enterprise linux[^0-9]*6\b|rhel[^0-9]*6\b/i, "2020-11-30", "RHEL 6"],
  [/red hat enterprise linux[^0-9]*7\b|rhel[^0-9]*7\b/i, "2024-06-30", "RHEL 7"],
  [/ubuntu[^0-9]*16\.04/i, "2021-04-30", "Ubuntu 16.04"],
  [/ubuntu[^0-9]*18\.04/i, "2023-05-31", "Ubuntu 18.04"],
  [/ubuntu[^0-9]*20\.04/i, "2025-05-31", "Ubuntu 20.04"],
  [/debian[^0-9]*9\b/i, "2022-06-30", "Debian 9"],
  [/debian[^0-9]*10\b/i, "2024-06-30", "Debian 10"],
  [/windows server 2008/i, "2020-01-14", "Windows Server 2008"],
  [/windows server 2012/i, "2023-10-10", "Windows Server 2012"],
  [/windows 7\b/i, "2020-01-14", "Windows 7"],
  [/windows 10\b/i, "2025-10-14", "Windows 10"],
  [/sles[^0-9]*12|suse linux enterprise server 12/i, "2024-10-31", "SLES 12"],
];
export function endOfLife(osName, now = Date.now()) {
  if (!osName) return null;
  const hit = EOL.find(([re]) => re.test(osName));
  if (!hit) return null;
  return Date.parse(hit[1]) < now ? { name: hit[2], since: hit[1] } : null;
}

/** What the VM runs: the guest agent's report when it is running, else the OS template label. */
export function guestOs(vm, vmi) {
  const g = vmi?.status?.guestOSInfo;
  if (g && (g.prettyName || g.name)) return { name: g.prettyName || `${g.name} ${g.version || ""}`.trim(), kernel: g.kernelRelease || null, source: "guest agent" };
  const labels = { ...(vm?.metadata?.labels || {}), ...(vm?.spec?.template?.metadata?.labels || {}) };
  const ann = vm?.metadata?.annotations || {};
  const tpl = Object.keys(labels).find((k) => k.startsWith("os.template.kubevirt.io/"));
  const id = ann["vm.kubevirt.io/os"] || (tpl ? tpl.split("/")[1] : null);
  if (!id) return null;
  return { name: prettyOsId(id), kernel: null, source: "template" };
}
function prettyOsId(id) {
  const m = String(id).match(/^([a-z]+?)(\d[\w.]*)?$/i);
  const fam = { rhel: "Red Hat Enterprise Linux", centos: "CentOS", centosstream: "CentOS Stream", fedora: "Fedora", ubuntu: "Ubuntu", debian: "Debian", win: "Windows", windows: "Windows", sles: "SLES", opensuse: "openSUSE" }[(m?.[1] || "").toLowerCase()];
  if (!fam) return id;
  let v = m?.[2] || "";
  if (/^win/i.test(m[1]) && /^2k/i.test(v)) v = `Server 20${v.slice(2)}`;
  if (/^win/i.test(m[1]) && /^(2k\d+|20\d\d)/.test(v)) v = `Server ${v}`;
  v = v.replace(/r2$/i, " R2");
  return `${fam} ${v}`.trim();
}

/* ─────────────────────────── exposure ─────────────────────────── */

/** How the VM can be reached from outside: LoadBalancer / NodePort Services and Routes that select its pod, and bridged NICs. */
export function exposureOf(vm, services = [], routes = []) {
  const ns = vm.metadata.namespace;
  const labels = { ...(vm.spec?.template?.metadata?.labels || {}), "vm.kubevirt.io/name": vm.metadata.name, "kubevirt.io/domain": vm.metadata.name };
  const out = [];
  const selects = (s) => s.metadata?.namespace === ns && s.spec?.selector && Object.keys(s.spec.selector).length && Object.entries(s.spec.selector).every(([k, v]) => labels[k] === v);
  const mine = services.filter(selects);
  for (const s of mine) {
    if (s.spec.type === "LoadBalancer" || s.spec.type === "NodePort") out.push({ kind: s.spec.type, name: s.metadata.name, host: (s.spec.ports || []).map((p) => (s.spec.type === "NodePort" ? p.nodePort : p.port)).filter(Boolean).join(",") || null });
  }
  for (const r of routes) {
    if (r.metadata?.namespace === ns && mine.some((s) => s.metadata.name === r.spec?.to?.name)) out.push({ kind: "Route", name: r.metadata.name, host: r.spec.host || null });
  }
  for (const n of vmShape(vm).nics) if ((n.binding === "bridge" || n.binding === "sriov") && n.network !== "pod network") out.push({ kind: "Bridged network", name: n.network, host: null });
  return out;
}

/* ─────────────────────────── disk scan (Trivy) results ─────────────────────────── */

/** Trivy JSON → { os, vulns }. */
const TRIVY_FAMILY = { redhat: "Red Hat Enterprise Linux", centos: "CentOS", rocky: "Rocky Linux", alma: "AlmaLinux", fedora: "Fedora", ubuntu: "Ubuntu", debian: "Debian", "sles": "SLES", "opensuse.leap": "openSUSE Leap", oracle: "Oracle Linux", amazon: "Amazon Linux" };
export function parseTrivy(doc) {
  const d = typeof doc === "string" ? JSON.parse(doc) : doc;
  const f = String(d?.Metadata?.OS?.Family || "").toLowerCase();
  const os = d?.Metadata?.OS ? `${TRIVY_FAMILY[f] || d.Metadata.OS.Family || ""} ${d.Metadata.OS.Name || ""}`.trim() : null;
  const seen = new Set(); const vulns = [];
  for (const r of d?.Results || []) {
    for (const v of r.Vulnerabilities || []) {
      const id = String(v.VulnerabilityID || "").toUpperCase();
      const k = `${id}|${v.PkgName}`;
      if (!id || seen.has(k)) continue;
      seen.add(k);
      const cvss = Math.max(0, ...Object.values(v.CVSS || {}).map((c) => c.V3Score || c.V2Score || 0));
      vulns.push({ id, severity: String(v.Severity || "unknown").toLowerCase(), pkg: v.PkgName, installed: v.InstalledVersion || null, fix: v.FixedVersion || null, cvss: cvss || null, title: (v.Title || "").slice(0, 160) || null });
    }
  }
  return { os, vulns };
}

/** The update command for the fixable packages, by OS family. */
export function fixCommand(os, vulns) {
  const pkgs = [...new Set(vulns.filter((v) => v.fix).map((v) => v.pkg))].sort();
  if (!pkgs.length) return null;
  const o = String(os || "").toLowerCase();
  if (/red ?hat|rhel|centos|rocky|alma|fedora|oracle|amazon/.test(o)) return `dnf update ${pkgs.join(" ")}`;
  if (/ubuntu|debian/.test(o)) return `apt-get install --only-upgrade ${pkgs.join(" ")}`;
  if (/suse|sles/.test(o)) return `zypper update ${pkgs.join(" ")}`;
  return null;
}

/* ─────────────────────────── reading the cluster ─────────────────────────── */

const list = async (path) => { try { return (await _deps.ocp.fetch(path))?.items || []; } catch { return null; } };

/** Read every VM, record what changed, keep the baselines. Cached for REFRESH_MS unless forced. */
export async function refresh(cluster = "local", { force = false } = {}) {
  const st = await load(cluster);
  const now = _deps.now();
  if (!force && st.readAt && now - Date.parse(st.readAt) < REFRESH_MS && st.lastRead) return st;
  const vms = await list("/apis/kubevirt.io/v1/virtualmachines");
  if (vms === null) { st.lastRead = { available: false, reason: "OpenShift Virtualization is not installed here, or the platform cannot list VirtualMachines" }; st.readAt = new Date(now).toISOString(); return st; }
  const [vmis, svcs, routes] = await Promise.all([
    list("/apis/kubevirt.io/v1/virtualmachineinstances"), list("/api/v1/services"), list("/apis/route.openshift.io/v1/routes"),
  ]);
  const vmiBy = Object.fromEntries((vmis || []).map((i) => [keyOf(i.metadata.namespace, i.metadata.name), i]));
  const at = new Date(now).toISOString();
  const seen = new Set();
  for (const vm of vms) {
    const k = keyOf(vm.metadata.namespace, vm.metadata.name);
    seen.add(k);
    const shape = vmShape(vm);
    const rec = st.vms[k] || { firstSeen: at, baseline: shape, baselineAt: at, baselineBy: "first seen" };
    if (rec.shape) {
      const d = diffShape(rec.shape, shape);
      if (d.length) {
        const w = lastWriter(vm);
        for (const c of d) st.changes.unshift({ at: w.at && Date.parse(w.at) > Date.parse(rec.readAt || 0) ? w.at : at, vm: vm.metadata.name, namespace: vm.metadata.namespace, ...c, tool: w.tool, weakens: weakening(c) });
      }
    }
    const vmi = vmiBy[k];
    const cond = (vm.status?.conditions || []);
    st.vms[k] = {
      ...rec, name: vm.metadata.name, namespace: vm.metadata.namespace, shape, readAt: at,
      state: vm.status?.printableStatus || (vmi ? "Running" : "Stopped"),
      restartRequired: cond.some((c) => c.type === "RestartRequired" && c.status === "True"),
      os: guestOs(vm, vmi) || rec.os || null,
      exposure: exposureOf(vm, svcs || [], routes || []),
      writer: lastWriter(vm),
    };
  }
  for (const k of Object.keys(st.vms)) if (!seen.has(k)) delete st.vms[k];
  if (st.changes.length > MAX_CHANGES) st.changes.length = MAX_CHANGES;
  st.readAt = at;
  st.lastRead = { available: true, vms: vms.length, servicesRead: svcs !== null, routesRead: routes !== null };
  if (SCAN_ON()) await pollScans(cluster).catch(() => {});
  await save(cluster);
  return st;
}

/* ─────────────────────────── summary for the UI ─────────────────────────── */

const SEV = ["critical", "high", "medium", "low"];

/** One row per VM, ranked like images: KEV, exposure, fixable, end of life. */
export async function summary(cluster = "local", { force = false } = {}) {
  const st = await refresh(cluster, { force });
  if (!st.lastRead?.available) return { available: false, reason: st.lastRead?.reason || "Not read yet", scan: scanInfo(st) };
  const kev = await _deps.kev().catch(() => new Set());
  const allIds = Object.values(st.scans).flatMap((s) => (s.vulns || []).map((v) => v.id));
  const epss = allIds.length ? await _deps.epss([...new Set(allIds)]).catch(() => new Map()) : new Map();
  const vms = Object.entries(st.vms).map(([k, r]) => {
    const scan = st.scans[k] || null;
    const vulns = (scan?.vulns || []).map((v) => enrichVuln(v, { kev, epss }));
    const sev = Object.fromEntries(SEV.map((s) => [s, vulns.filter((v) => v.severity === s).length]));
    const eol = endOfLife(r.os?.name, _deps.now()) || endOfLife(scan?.os, _deps.now());
    const offBaseline = diffShape(r.baseline, r.shape);
    const running = !/stopped|halted/i.test(r.state || "");
    const factors0 = [];
    let pr;
    if (scan?.status === "done") {
      pr = prioritizeImage({ vulnerabilities: vulns.map((v) => ({ ...v, fixedBy: v.fix })), critical: sev.critical, maxCVSS: Math.max(0, ...vulns.map((v) => v.cvss || 0)), source: "trivy" },
        { running, exposure: r.exposure, privileged: false });
      if (eol && pr.tier !== "fix-now") { pr.tier = pr.tier === "monitor" || pr.tier === "plan" ? "fix-soon" : pr.tier; pr.tierLabel = TIER_LABEL[pr.tier]; }
    } else {
      // Not scanned: only what is known without a scan.
      const tier = eol ? (r.exposure.length ? "fix-now" : "fix-soon") : "hygiene";
      const scanning = scan?.status === "running" || scan?.status === "queued";
      pr = { tier, tierLabel: eol ? TIER_LABEL[tier] : scanning ? "Scanning" : "Not scanned", score: eol ? 40 + (r.exposure.length ? 10 : 0) : 0, factors: [] };
      if (!eol) factors0.push({ key: "unscanned", label: scanning ? "Scanning" : "Not scanned", detail: scan?.error ? `Last scan failed: ${scan.error}` : "Package CVEs need a disk scan" });
    }
    const factors = [...(pr.factors || []).filter((f) => f.key !== "not-running"), ...factors0];
    if (eol) factors.unshift({ key: "eol", label: "End of life", detail: `${eol.name}: standard support ended ${eol.since}` });
    if (r.exposure.length && !factors.some((f) => f.key === "exposed")) factors.push({ key: "exposed", label: "Externally exposed", detail: r.exposure.map((e) => `${e.kind} ${e.name}${e.host ? ` (${e.host})` : ""}`).join(" · ") });
    if (offBaseline.length) factors.push({ key: "baseline", label: "Off baseline", detail: offBaseline.map((d) => `${d.label}: ${d.before} → ${d.after}`).join(" · ") });
    return {
      key: k, name: r.name, namespace: r.namespace, state: r.state, restartRequired: r.restartRequired,
      os: r.os?.name || scan?.os || null, osSource: r.os?.source || (scan?.os ? "disk scan" : null), kernel: r.os?.kernel || null,
      vcpus: r.shape.vcpus, memory: gib(r.shape.memoryMiB), disks: r.shape.disks.filter((d) => d.kind === "disk").length,
      exposure: r.exposure, eol, offBaseline, writer: r.writer,
      scan: scan ? { status: scan.status, at: scan.finishedAt || scan.startedAt || null, error: scan.error || null } : null,
      sev, kevCount: vulns.filter((v) => v.kev).length,
      tier: pr.tier, tierLabel: pr.tierLabel, score: pr.score, factors,
      vulns: vulns.sort((a, b) => (b.kev - a.kev) || SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || (b.cvss || 0) - (a.cvss || 0)).slice(0, 60),
      fix: scan?.status === "done" ? fixCommand(scan.os || r.os?.name, vulns.filter((v) => ["critical", "high"].includes(v.severity) || v.kev)) : null,
    };
  });
  const rank = { "fix-now": 0, "fix-soon": 1, plan: 2, monitor: 3, hygiene: 4 };
  vms.sort((a, b) => (rank[a.tier] ?? 5) - (rank[b.tier] ?? 5) || b.score - a.score || a.name.localeCompare(b.name));
  const scanned = vms.filter((v) => v.scan?.status === "done");
  const totals = {
    vms: vms.length, running: vms.filter((v) => !/stopped|halted/i.test(v.state || "")).length,
    scanned: scanned.length,
    sev: Object.fromEntries(SEV.map((s) => [s, scanned.reduce((n, v) => n + v.sev[s], 0)])),
    vmsWith: Object.fromEntries(SEV.map((s) => [s, scanned.filter((v) => v.sev[s] > 0).length])),
    kev: new Set(scanned.flatMap((v) => v.vulns.filter((x) => x.kev).map((x) => x.id))).size,
    fixNow: vms.filter((v) => v.tier === "fix-now").length,
    eol: vms.filter((v) => v.eol).length,
    exposed: vms.filter((v) => v.exposure.length).length,
    offBaseline: vms.filter((v) => v.offBaseline.length).length,
    restartRequired: vms.filter((v) => v.restartRequired).length,
  };
  const week = _deps.now() - 7 * 864e5;
  const recent = st.changes.filter((c) => Date.parse(c.at) >= week);
  return {
    available: true, readAt: st.readAt, totals, vms,
    changes: st.changes.slice(0, 200),
    changeTotals: { week: recent.length, weekVms: new Set(recent.map((c) => `${c.namespace}/${c.vm}`)).size, weakening: recent.filter((c) => c.weakens).length },
    scan: scanInfo(st), kev: { count: kev.size },
  };
}

function scanInfo(st) {
  return { enabled: SCAN_ON(), image: SCANNER_IMAGE(), running: Object.values(st.scans).filter((s) => s.status === "running").length, queued: st.queue.length };
}

/* ─────────────────────────── actions ─────────────────────────── */

const validName = (s) => typeof s === "string" && /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(s);
function need(ns, name) { if (!validName(ns) || !validName(name)) throw Object.assign(new Error("Not a valid VM name or namespace"), { status: 400 }); }

/** Approve the VM's current shape as its baseline. */
export async function approveBaseline(cluster, ns, name, actor) {
  need(ns, name);
  const st = await refresh(cluster, { force: true });
  const r = st.vms[keyOf(ns, name)];
  if (!r) throw Object.assign(new Error(`${ns}/${name} was not found`), { status: 404 });
  r.baseline = r.shape; r.baselineAt = new Date(_deps.now()).toISOString(); r.baselineBy = actor || "admin";
  await save(cluster);
  return { vm: name, namespace: ns, baselineAt: r.baselineAt };
}

/** A VirtualMachineSnapshot, for rollback before patching. */
export async function snapshotVm(cluster, ns, name, actor) {
  need(ns, name);
  const snap = `${name}-vmguard-${new Date(_deps.now()).toISOString().replace(/[-:T]/g, "").slice(0, 12)}`.slice(0, 63);
  const body = (v) => ({ apiVersion: `snapshot.kubevirt.io/${v}`, kind: "VirtualMachineSnapshot", metadata: { name: snap, namespace: ns, labels: { "tcs.com/vm-guard": "true" }, annotations: { "tcs.com/requested-by": String(actor || "admin") } },
    spec: { source: { apiGroup: "kubevirt.io", kind: "VirtualMachine", name } } });
  try { await _deps.ocp.post(`/apis/snapshot.kubevirt.io/v1beta1/namespaces/${ns}/virtualmachinesnapshots`, body("v1beta1")); }
  catch (e) {
    if (!/404|not found/i.test(e.message)) throw e;
    await _deps.ocp.post(`/apis/snapshot.kubevirt.io/v1alpha1/namespaces/${ns}/virtualmachinesnapshots`, body("v1alpha1"));
  }
  return { snapshot: snap, namespace: ns };
}

/** Queue a disk scan for one VM (or every VM when name is "*"). */
export async function requestScan(cluster, ns, name) {
  if (!SCAN_ON()) throw Object.assign(new Error("Disk scanning is off. Set VM_GUARD_SCAN=true on the platform (see deploy/vm-guard/README.md) to scan VM disks."), { status: 409 });
  const st = await refresh(cluster, { force: true });
  const keys = name === "*" ? Object.keys(st.vms) : (need(ns, name), [keyOf(ns, name)]);
  let added = 0;
  for (const k of keys) {
    if (!st.vms[k]) continue;
    const s = st.scans[k];
    if (s && (s.status === "running" || s.status === "queued")) continue;
    st.scans[k] = { ...(s || {}), status: "queued", queuedAt: new Date(_deps.now()).toISOString(), error: null };
    st.queue.push(k); added++;
  }
  await pollScans(cluster);
  await save(cluster);
  return { queued: added };
}

/** The root disk's claim: the boot-order-1 disk, else the first disk backed by a claim. */
function rootClaim(rec) {
  const d = [...rec.shape.disks].filter((x) => x.kind === "disk" && x.claim).sort((a, b) => (a.boot ?? 99) - (b.boot ?? 99))[0];
  return d?.claim || null;
}

/** Advance scans: start queued ones up to the limit, collect finished ones, clean up. */
export async function pollScans(cluster = "local") {
  const st = await load(cluster);
  const ocp = _deps.ocp;
  const now = _deps.now();
  for (const [k, s] of Object.entries(st.scans)) {
    if (s.status !== "running") continue;
    const [ns] = k.split("/");
    try {
      const job = await ocp.fetch(`/apis/batch/v1/namespaces/${ns}/jobs/${s.job}`).catch(() => null);
      const done = job?.status?.succeeded > 0, failed = job?.status?.failed > 0 || (!job && s.jobCreated);
      const late = now - Date.parse(s.startedAt) > SCAN_TIMEOUT_MS();
      if (!done && !failed && !late) continue;
      let logs = "";
      const pods = (await ocp.fetch(`/api/v1/namespaces/${ns}/pods?labelSelector=job-name%3D${s.job}`).catch(() => null))?.items || [];
      if (pods[0]) logs = await ocp.fetch(`/api/v1/namespaces/${ns}/pods/${pods[0].metadata.name}/log?container=scan`, { headers: { Accept: "text/plain" } }).catch(() => "");
      if (done) {
        const start = String(logs).indexOf("{");
        const res = parseTrivy(String(logs).slice(start));
        Object.assign(s, { status: "done", finishedAt: new Date(now).toISOString(), os: res.os, vulns: res.vulns.slice(0, MAX_VULNS_PER_VM), total: res.vulns.length, error: null });
      } else {
        Object.assign(s, { status: "failed", finishedAt: new Date(now).toISOString(), error: late ? "The scan did not finish in time" : (String(logs).trim().split("\n").slice(-3).join(" ").slice(0, 300) || "The scan job failed") });
      }
    } catch (e) {
      Object.assign(s, { status: "failed", finishedAt: new Date(now).toISOString(), error: e.message });
    }
    await cleanup(ns, s).catch(() => {});
  }
  // Start queued scans.
  let running = Object.values(st.scans).filter((s) => s.status === "running").length;
  while (st.queue.length && running < MAX_PARALLEL()) {
    const k = st.queue.shift();
    const s = st.scans[k]; const rec = st.vms[k];
    if (!s || s.status !== "queued" || !rec) continue;
    try { await startScan(k, rec, s); running++; }
    catch (e) { Object.assign(s, { status: "failed", finishedAt: new Date(now).toISOString(), error: e.message }); }
  }
}

async function startScan(k, rec, s) {
  const [ns, name] = k.split("/");
  const claim = rootClaim(rec);
  if (!claim) throw new Error("No root disk backed by a persistent volume claim (container disks are scanned through their image instead)");
  const ocp = _deps.ocp;
  const pvc = await ocp.fetch(`/api/v1/namespaces/${ns}/persistentvolumeclaims/${claim}`);
  const tag = `vmguard-${name}`.slice(0, 40) + "-" + new Date(_deps.now()).toISOString().replace(/[-:T.Z]/g, "").slice(4, 12);
  const block = pvc.spec?.volumeMode === "Block";
  await ocp.post(`/apis/snapshot.storage.k8s.io/v1/namespaces/${ns}/volumesnapshots`, {
    apiVersion: "snapshot.storage.k8s.io/v1", kind: "VolumeSnapshot", metadata: { name: tag, namespace: ns, labels: { "tcs.com/vm-guard": "true" } },
    spec: { source: { persistentVolumeClaimName: claim }, ...(process.env.VM_GUARD_SNAPSHOT_CLASS ? { volumeSnapshotClassName: process.env.VM_GUARD_SNAPSHOT_CLASS } : {}) },
  });
  await ocp.post(`/api/v1/namespaces/${ns}/persistentvolumeclaims`, {
    apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: tag, namespace: ns, labels: { "tcs.com/vm-guard": "true" } },
    spec: { accessModes: pvc.spec.accessModes, volumeMode: pvc.spec.volumeMode || "Filesystem", storageClassName: pvc.spec.storageClassName,
      resources: { requests: { storage: pvc.status?.capacity?.storage || pvc.spec.resources?.requests?.storage } },
      dataSource: { apiGroup: "snapshot.storage.k8s.io", kind: "VolumeSnapshot", name: tag } },
  });
  const target = block ? "/dev/vmdisk" : "/disk/disk.img";
  const env = [{ name: "TRIVY_NO_PROGRESS", value: "true" }, { name: "TRIVY_CACHE_DIR", value: "/tmp/trivy" },
    ...(process.env.VM_GUARD_TRIVY_DB_REPO ? [{ name: "TRIVY_DB_REPOSITORY", value: process.env.VM_GUARD_TRIVY_DB_REPO }] : [])];
  await ocp.post(`/apis/batch/v1/namespaces/${ns}/jobs`, {
    apiVersion: "batch/v1", kind: "Job", metadata: { name: tag, namespace: ns, labels: { "tcs.com/vm-guard": "true" } },
    spec: { backoffLimit: 0, ttlSecondsAfterFinished: 3600, activeDeadlineSeconds: Math.round(SCAN_TIMEOUT_MS() / 1000), template: { metadata: { labels: { "tcs.com/vm-guard": "true" } }, spec: {
      restartPolicy: "Never", ...(process.env.VM_GUARD_SCANNER_SA ? { serviceAccountName: process.env.VM_GUARD_SCANNER_SA } : {}),
      containers: [{ name: "scan", image: SCANNER_IMAGE(), args: ["vm", "--scanners", "vuln", "--format", "json", "--quiet", target], env,
        resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "4Gi" } },
        ...(block ? { volumeDevices: [{ name: "disk", devicePath: "/dev/vmdisk" }] } : { volumeMounts: [{ name: "disk", mountPath: "/disk", readOnly: true }] }) }],
      volumes: [{ name: "disk", persistentVolumeClaim: { claimName: tag, readOnly: !block } }],
    } } },
  });
  Object.assign(s, { status: "running", startedAt: new Date(_deps.now()).toISOString(), job: tag, snapshot: tag, claim: tag, jobCreated: true, error: null });
}

async function cleanup(ns, s) {
  const ocp = _deps.ocp;
  if (s.job) await ocp.delete(`/apis/batch/v1/namespaces/${ns}/jobs/${s.job}?propagationPolicy=Background`).catch(() => {});
  if (s.claim) await ocp.delete(`/api/v1/namespaces/${ns}/persistentvolumeclaims/${s.claim}`).catch(() => {});
  if (s.snapshot) await ocp.delete(`/apis/snapshot.storage.k8s.io/v1/namespaces/${ns}/volumesnapshots/${s.snapshot}`).catch(() => {});
  delete s.jobCreated;
}
