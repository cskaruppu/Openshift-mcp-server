import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VM_GUARD_STATE_DIR = mkdtempSync(join(tmpdir(), "vmg-"));
const VG = await import("../../src/services/vm-guard.js");

const vm = (over = {}) => ({
  metadata: { name: "pay-db-01", namespace: "payments", labels: { "vm.kubevirt.io/template": "rhel8-server-small" }, annotations: { "vm.kubevirt.io/os": "rhel8.6" },
    managedFields: [{ manager: "Mozilla", operation: "Update", time: "2026-11-01T09:42:00Z", fieldsV1: { "f:spec": {} } }] },
  spec: {
    runStrategy: "Always",
    dataVolumeTemplates: [{ metadata: { name: "pay-db-01-root" }, spec: { storage: { resources: { requests: { storage: "60Gi" } } } } }],
    template: { metadata: { labels: { app: "pay-db" } }, spec: {
      domain: { cpu: { cores: 4, sockets: 1, threads: 1 }, memory: { guest: "16Gi" }, firmware: { bootloader: { efi: { secureBoot: true } } },
        devices: { disks: [{ name: "rootdisk", disk: { bus: "virtio" }, bootOrder: 1 }], interfaces: [{ name: "default", masquerade: {} }] } },
      networks: [{ name: "default", pod: {} }],
      volumes: [{ name: "rootdisk", dataVolume: { name: "pay-db-01-root" } }],
    } },
    ...over.spec,
  },
  status: { printableStatus: "Running", conditions: [] , ...over.status },
});

test("a VM's shape: CPU, memory, disks, NICs and firmware", () => {
  const s = VG.vmShape(vm());
  assert.equal(s.vcpus, 4);
  assert.equal(s.memoryMiB, 16384);
  assert.deepEqual(s.disks.map((d) => [d.name, d.claim, d.size]), [["rootdisk", "pay-db-01-root", "60Gi"]]);
  assert.deepEqual(s.nics.map((n) => [n.binding, n.network]), [["masquerade", "pod network"]]);
  assert.equal(s.firmware, "UEFI");
  assert.equal(s.secureBoot, true);
  assert.equal(VG.toMiB("2Gi"), 2048);
  assert.equal(VG.toMiB("512Mi"), 512);
});

test("changes are readable, and weakening ones are named", () => {
  const a = VG.vmShape(vm());
  const b2 = vm();
  b2.spec.template.spec.domain.memory.guest = "32Gi";
  b2.spec.template.spec.domain.firmware.bootloader.efi.secureBoot = false;
  b2.spec.template.spec.domain.devices.interfaces.push({ name: "nic-2", bridge: {} });
  b2.spec.template.spec.networks.push({ name: "nic-2", multus: { networkName: "dmz-vlan-40" } });
  const d = VG.diffShape(a, VG.vmShape(b2));
  const byField = Object.fromEntries(d.map((x) => [x.field, x]));
  assert.equal(byField.memoryMiB.before, "16 Gi");
  assert.equal(byField.memoryMiB.after, "32 Gi");
  assert.equal(VG.weakening(byField.secureBoot), "Secure Boot turned off");
  assert.equal(VG.weakening(byField["nic:nic-2"]), "Joined an external network");
  assert.equal(VG.diffShape(a, VG.vmShape(vm())).length, 0, "the same VM read twice has no changes");
});

test("who changed it: the tool, from managedFields", () => {
  assert.deepEqual(VG.lastWriter(vm()), { tool: "OpenShift console", at: "2026-11-01T09:42:00Z" });
});

test("guest OS: guest agent first, else the template; end of life from published dates", () => {
  assert.equal(VG.guestOs(vm(), { status: { guestOSInfo: { prettyName: "Red Hat Enterprise Linux 8.6 (Ootpa)", kernelRelease: "4.18.0-372" } } }).source, "guest agent");
  assert.equal(VG.guestOs(vm(), null).name, "Red Hat Enterprise Linux 8.6");
  const now = Date.parse("2026-11-01");
  assert.equal(VG.endOfLife("CentOS Linux 7 (Core)", now).name, "CentOS 7");
  assert.equal(VG.endOfLife("Windows Server 2012 R2 Standard", now).name, "Windows Server 2012");
  assert.equal(VG.endOfLife("Red Hat Enterprise Linux 9.4", now), null);
});

test("exposure: LoadBalancer services and Routes that select the VM, and bridged NICs", () => {
  const v = vm();
  const svcs = [
    { metadata: { name: "pay-db-lb", namespace: "payments" }, spec: { type: "LoadBalancer", selector: { app: "pay-db" }, ports: [{ port: 5432 }] } },
    { metadata: { name: "other", namespace: "payments" }, spec: { type: "LoadBalancer", selector: { app: "web" }, ports: [{ port: 80 }] } },
    { metadata: { name: "pay-db-int", namespace: "payments" }, spec: { type: "ClusterIP", selector: { "vm.kubevirt.io/name": "pay-db-01" } } },
  ];
  const routes = [{ metadata: { name: "pay-db", namespace: "payments" }, spec: { host: "pay-db.apps.lab", to: { name: "pay-db-int" } } }];
  const e = VG.exposureOf(v, svcs, routes);
  assert.deepEqual(e.map((x) => [x.kind, x.name]), [["LoadBalancer", "pay-db-lb"], ["Route", "pay-db"]]);
});

test("Trivy VM results are parsed, and the fix command follows the OS", () => {
  const doc = { Metadata: { OS: { Family: "redhat", Name: "8.6" } }, Results: [{ Vulnerabilities: [
    { VulnerabilityID: "CVE-2024-6387", PkgName: "openssh", InstalledVersion: "8.0p1-19", FixedVersion: "8.0p1-24.el8", Severity: "CRITICAL", CVSS: { nvd: { V3Score: 8.1 } } },
    { VulnerabilityID: "CVE-2023-0001", PkgName: "curl", InstalledVersion: "7.61.1-25", FixedVersion: "", Severity: "LOW" },
    { VulnerabilityID: "CVE-2024-6387", PkgName: "openssh", Severity: "CRITICAL" },
  ] }] };
  const r = VG.parseTrivy(doc);
  assert.equal(r.os, "Red Hat Enterprise Linux 8.6");
  assert.equal(r.vulns.length, 2);
  assert.equal(r.vulns[0].cvss, 8.1);
  assert.equal(VG.fixCommand(r.os, r.vulns), "dnf update openssh");
  assert.equal(VG.fixCommand("ubuntu 20.04", r.vulns), "apt-get install --only-upgrade openssh");
});

function fakeCluster() {
  const objs = { vms: [vm()] };
  const calls = [];
  const ocp = {
    fetch: async (p) => {
      calls.push(["GET", p]);
      if (p === "/apis/kubevirt.io/v1/virtualmachines") return { items: objs.vms };
      if (p === "/apis/kubevirt.io/v1/virtualmachineinstances") return { items: [] };
      if (p === "/api/v1/services" || p === "/apis/route.openshift.io/v1/routes") return { items: [] };
      if (p.includes("/persistentvolumeclaims/pay-db-01-root")) return { spec: { accessModes: ["ReadWriteOnce"], volumeMode: "Filesystem", storageClassName: "ocs-rbd" }, status: { capacity: { storage: "60Gi" } } };
      if (p.includes("/jobs/")) return { status: { succeeded: 1 } };
      if (p.includes("/pods?labelSelector")) return { items: [{ metadata: { name: "scan-pod" } }] };
      if (p.includes("/log")) return `2026 INFO\n${JSON.stringify({ Metadata: { OS: { Family: "redhat", Name: "8.6" } }, Results: [{ Vulnerabilities: [{ VulnerabilityID: "CVE-2024-6387", PkgName: "openssh", FixedVersion: "8.0p1-24", Severity: "CRITICAL" }] }] })}`;
      throw new Error("404 not found");
    },
    post: async (p, b) => { calls.push(["POST", p, b.kind]); return b; },
    delete: async (p) => { calls.push(["DELETE", p]); },
  };
  return { objs, calls, ocp };
}

test("changes between reads are recorded with the tool; the baseline stays until approved", async () => {
  VG._resetVmGuard();
  const c = fakeCluster();
  let t = Date.parse("2026-11-01T10:00:00Z");
  VG.configureVmGuard({ ocp: c.ocp, now: () => t, kev: async () => new Set(["CVE-2024-6387"]), epss: async () => new Map(), storeKey: () => "vm_guard:test-a" });
  let s = await VG.summary("test-a");
  assert.equal(s.available, true);
  assert.equal(s.vms[0].name, "pay-db-01");
  assert.equal(s.vms[0].tierLabel, "Not scanned");
  assert.equal(s.changes.length, 0);
  const changed = vm();
  changed.spec.template.spec.domain.firmware.bootloader.efi.secureBoot = false;
  c.objs.vms = [changed];
  t += 120_000;
  s = await VG.summary("test-a");
  assert.equal(s.changes[0].label, "Secure Boot");
  assert.equal(s.changes[0].weakens, "Secure Boot turned off");
  assert.equal(s.changes[0].tool, "OpenShift console");
  assert.equal(s.totals.offBaseline, 1);
  await VG.approveBaseline("test-a", "payments", "pay-db-01", "alice");
  t += 120_000;
  s = await VG.summary("test-a");
  assert.equal(s.totals.offBaseline, 0);
});

test("a disk scan: snapshot, restored claim, Trivy job, results read, copies deleted", async () => {
  VG._resetVmGuard();
  const c = fakeCluster();
  let t = Date.parse("2026-11-01T10:00:00Z");
  VG.configureVmGuard({ ocp: c.ocp, now: () => t, kev: async () => new Set(["CVE-2024-6387"]), epss: async () => new Map(), storeKey: () => "vm_guard:test-b" });
  await assert.rejects(VG.requestScan("test-b", "payments", "pay-db-01"), /Disk scanning is off/);
  process.env.VM_GUARD_SCAN = "true";
  try {
    await VG.requestScan("test-b", "payments", "pay-db-01");
    const posts = c.calls.filter((x) => x[0] === "POST").map((x) => x[2]);
    assert.deepEqual(posts, ["VolumeSnapshot", "PersistentVolumeClaim", "Job"]);
    t += 60_000;
    await VG.pollScans("test-b");
    const s = await VG.summary("test-b", { force: true });
    const r = s.vms[0];
    assert.equal(r.scan.status, "done");
    assert.equal(r.sev.critical, 1);
    assert.equal(r.kevCount, 1);
    assert.equal(r.tier, "fix-now", "a fixable known-exploited CVE is fix now");
    assert.equal(r.fix, "dnf update openssh");
    assert.equal(c.calls.filter((x) => x[0] === "DELETE").length, 3, "job, claim and snapshot are deleted");
  } finally { delete process.env.VM_GUARD_SCAN; }
});
