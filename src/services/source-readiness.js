// ---------------------------------------------------------------------------
// Source-side readiness checks
// ---------------------------------------------------------------------------
/**
 * The VMware facts that decide whether a migration succeeds, beyond "is the
 * guest OS certified".
 *
 * MTV's own validation catches some of these and reports them as concerns. It
 * does not catch all of them, and it does not tell you what to DO about the
 * ones it catches. These are the checks a migration engineer runs by hand, in
 * the order they bite, written down once.
 *
 * The rule that makes this trustworthy: A CHECK WITH NO DATA IS NOT A PASS.
 * If the inventory does not report whether a VM has snapshots, this says
 * "not reported" and counts it as unchecked — it never says "no snapshots".
 * Silence looking like a clean bill of health is how an assessment tool loses
 * the right to be believed.
 *
 * Everything here is pure.
 */

/** Present-or-unknown: null means the inventory did not report the fact. */
export function flag(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return null;
}

/** These strings end up in a change record and a printed report, so they agree. */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isAre = (n) => (n === 1 ? "is" : "are");
const mapsMap = (n) => (n === 1 ? "maps" : "map");

/** Devices that have no equivalent on OpenShift Virtualization. */
const DEVICE_PATTERNS = [
  [/pcipassthrough|passthru|passthrough/i, "PCI passthrough device"],
  [/sriov/i, "SR-IOV interface"],
  [/vgpu|videocard.*3d|gpu/i, "GPU / vGPU device"],
  [/usb/i, "USB controller or device"],
  [/serialport/i, "serial port"],
  [/parallelport/i, "parallel port"],
  [/sound|audio/i, "sound device"],
  [/floppy/i, "floppy drive"],
];

/**
 * Run every source-side check against one VM.
 *
 * @returns {{findings:Array, unchecked:Array, coverage:{ran:number,total:number}}}
 *   findings  — what is wrong, with severity, whether it blocks, and the fix
 *   unchecked — checks that could not run, and why
 */
export function runSourceChecks(vm = {}) {
  const findings = [], unchecked = [];
  let total = 0, ran = 0;

  /** Register a check. `fact` is null when the inventory did not report it. */
  const check = (id, label, fact, evaluate) => {
    total++;
    if (fact === null || fact === undefined) {
      unchecked.push({ id, label, reason: "The source inventory did not report this." });
      return;
    }
    ran++;
    const f = evaluate(fact);
    if (f) findings.push({ id, ...f });
  };

  // ── Things that stop the migration outright ─────────────────────────────
  check("template", "Is a template", flag(vm.isTemplate), (v) => v && {
    severity: "critical", blocks: true, title: "This is a VM template, not a virtual machine",
    detail: "Templates have no running state and are not migrated by a Plan.",
    action: "Convert the template to a VM in vCenter first, or exclude it from the wave.",
  });

  check("faultTolerance", "Fault Tolerance", flag(vm.faultToleranceEnabled), (v) => v && {
    severity: "critical", blocks: true, title: "Fault Tolerance is enabled",
    detail: "An FT pair shares live state between a primary and a secondary VM. There is no equivalent on OpenShift Virtualization, and the VM cannot be snapshotted for transfer.",
    action: "Turn off Fault Tolerance in vCenter before migrating. Rebuild the availability requirement with more than one replica on the target.",
  });

  check("connection", "Connection state", vm.connectionState ?? null, (v) => !/^connected$/i.test(String(v)) && {
    severity: "critical", blocks: true, title: `Source VM is "${v}", not connected`,
    detail: "vCenter cannot currently reach this VM's host, so its inventory is stale and its disks cannot be read.",
    action: "Restore the host connection in vCenter and re-run discovery before including this machine.",
  });

  // Independent disks sit outside snapshots by design, so neither changed block
  // tracking nor the snapshot a transfer relies on can see them.
  check("independentDisk", "Independent disks", vm.disks ? vm.disks : null, (disks) => {
    const bad = disks.filter((d) => /independent/i.test(String(d.mode || "")));
    return bad.length && {
      severity: "critical", blocks: true, title: `${plural(bad.length, "disk", "disks")} in independent mode`,
      detail: `${bad.map((d) => d.name || "disk").join(", ")} ${isAre(bad.length)} excluded from snapshots, so the transfer has nothing consistent to copy from.`,
      action: "Change these disks to dependent mode in vCenter (the VM must be powered off), then re-run discovery.",
    };
  });

  check("rdm", "Raw device mappings", vm.disks ? vm.disks : null, (disks) => {
    const bad = disks.filter((d) => d.rdm);
    return bad.length && {
      severity: "critical", blocks: true, title: plural(bad.length, "raw device mapping", "raw device mappings"),
      detail: `${bad.map((d) => d.name || "disk").join(", ")} ${mapsMap(bad.length)} directly to a LUN rather than to a VMDK, so there is no virtual disk to copy.`,
      action: "Present the LUN to OpenShift as a PV and attach it after migration, or convert the RDM to a VMDK first.",
    };
  });

  check("sharedDisk", "Shared disks", vm.disks ? vm.disks : null, (disks) => {
    const bad = disks.filter((d) => d.shared);
    return bad.length && {
      severity: "critical", blocks: true, title: `${plural(bad.length, "shared disk", "shared disks")}`,
      detail: `${bad.map((d) => d.name || "disk").join(", ")} ${isAre(bad.length)} shared with another VM, typically a guest cluster. Copying one side of a shared disk produces an inconsistent target.`,
      action: "Migrate the cluster as a unit with shared storage provisioned on the target, or rebuild the guest cluster there.",
    };
  });

  // ── Things that make the migration fail late, or land badly ─────────────
  check("snapshots", "Snapshots", vm.hasSnapshot, (v) => v && {
    severity: "warning", blocks: false, required: true, title: "The VM has snapshots",
    detail: `A snapshot chain means the transfer copies the chain, not a single flat disk${vm.warmEligible ? ", and a warm migration takes another snapshot on top of it" : ""}. Transfers are slower and more likely to fail.`,
    action: "Consolidate or delete the snapshots in vCenter before migrating, then re-run discovery.",
  });

  // Matched by what is WRONG, not by what looks right: vSphere's value for a
  // stopped agent is "toolsNotRunning", which contains the word "running" and
  // sails straight through a naive positive match.
  check("tools", "VMware Tools", vm.toolsStatus ?? null, (v) => {
    const t = String(v);
    const stopped = /not[\s_-]*running|not[\s_-]*installed|unmanaged/i.test(t);
    const stale = !stopped && /old|out[\s_-]*of[\s_-]*date|upgrade|needupgrade/i.test(t);
    if (!stopped && !stale) return null;
    return stopped
      ? {
          severity: "warning", blocks: false, required: false, title: `VMware Tools: ${t}`,
          detail: "Without a running guest agent vCenter reports no IP addresses, a cold migration cannot shut the guest down cleanly, and there is far less to verify after cutover.",
          action: "Start or install VMware Tools on the guest and re-run discovery.",
        }
      : {
          severity: "info", blocks: false, required: false, title: `VMware Tools are out of date (${t})`,
          detail: "An old agent still reports, but guest quiescing and clean shutdown are less reliable.",
          action: "Update VMware Tools before the cutover window if this VM matters.",
        };
  });

  // A vTPM is not optional on the target: KubeVirt keeps TPM state in a
  // persistent volume, and that has to be configured on the cluster first.
  check("tpm", "Virtual TPM", flag(vm.tpmEnabled), (v) => v && {
    severity: "warning", blocks: false, required: true, title: "Virtual TPM is attached",
    detail: "OpenShift Virtualization stores TPM state in a persistent volume, which needs vmStateStorageClass set on the HyperConverged resource. Without it the migrated VM starts without its TPM — and a Windows 11 guest will not boot at all.",
    action: "Confirm vmStateStorageClass is configured on the target cluster before migrating this VM.",
  });

  check("secureBoot", "Secure Boot", flag(vm.secureBoot), (v) => v && {
    severity: "warning", blocks: false, required: true, title: "Secure Boot is enabled",
    detail: "The target VM must be created with EFI firmware and SMM enabled, or it will not boot with Secure Boot on.",
    action: "Verify the migrated VM has EFI + SMM before first boot, or accept it booting with Secure Boot disabled.",
  });

  check("firmware", "Firmware", vm.firmware ?? null, (v) => /efi/i.test(String(v)) && {
    severity: "info", blocks: false, required: false, title: "Boots with EFI firmware",
    detail: "MTV sets EFI on the target VM. Worth confirming after the first boot, since a firmware mismatch produces a VM that will not start.",
    action: "Check the migrated VM boots to its own bootloader rather than to the EFI shell.",
  });

  check("devices", "Attached devices", vm.devices ? vm.devices : null, (devices) => {
    const hits = [];
    for (const d of devices) {
      const kind = String(d.kind || d.Kind || d.type || "");
      const hit = DEVICE_PATTERNS.find(([re]) => re.test(kind));
      if (hit) hits.push(hit[1]);
    }
    const unique = [...new Set(hits)];
    // A sound card is noise; a passthrough GPU is a migration that produces a
    // VM which cannot start. Both are worth listing, at different weights.
    const serious = unique.filter((u) => /passthrough|SR-IOV|GPU/i.test(u));
    return unique.length && {
      severity: serious.length ? "warning" : "info",
      blocks: false, required: serious.length > 0,
      title: `${plural(unique.length, "device type", "device types")} with no target equivalent: ${unique.join(", ")}`,
      detail: serious.length
        ? "Passthrough and SR-IOV devices are bound to specific source hardware. The VM will migrate and then fail to start, or start without the function it depends on."
        : "These devices are dropped during conversion. Harmless for most workloads, but worth knowing.",
      action: serious.length
        ? "Remove the device in vCenter and plan the equivalent on OpenShift, or exclude this VM from the wave."
        : "No action needed unless the guest depends on them.",
    };
  });

  check("nics", "Network interfaces", vm.nics ? vm.nics : null, (nics) => {
    const networks = [...new Set(nics.map((n) => n.network || n.name).filter(Boolean))];
    return networks.length > 1 && {
      severity: "warning", blocks: false, required: true,
      title: `${nics.length} NICs across ${networks.length} networks`,
      detail: `Every source network needs its own entry in the network map: ${networks.join(", ")}. A missing entry fails plan validation, not the copy — so it surfaces after you have committed to a wave.`,
      action: "Confirm the network map covers all of these before creating the plan.",
    };
  });

  check("cpuAffinity", "CPU pinning", vm.cpuAffinity ? vm.cpuAffinity : null, (a) => a.length > 0 && {
    severity: "info", blocks: false, required: false, title: "CPU affinity is pinned on the source",
    detail: `Pinned to ${a.join(", ")}. KubeVirt does not carry this over; it has its own dedicated-CPU placement, which is configured differently.`,
    action: "If this VM is pinned for latency, plan dedicated CPU placement on the target rather than assuming it followed.",
  });

  check("hotAdd", "Hot-add", flag(vm.cpuHotAddEnabled, vm.memoryHotAddEnabled), (v) => v && {
    severity: "info", blocks: false, required: false, title: "CPU or memory hot-add is enabled",
    detail: "KubeVirt resizes a VM by changing its spec and restarting it, so hot-add does not carry across.",
    action: "No action before migrating. Expect a restart to be needed for future resizes.",
  });

  return { findings, unchecked, coverage: { ran, total } };
}

/**
 * A one-line summary of how much of the assessment was actually possible.
 *
 * Shown next to the verdict on purpose: "12 of 14 checks ran" is the difference
 * between a clean bill of health and a shrug.
 */
export function coverageNote(coverage, unchecked = []) {
  if (!coverage?.total) return null;
  if (coverage.ran === coverage.total) return `All ${coverage.total} source checks ran.`;
  const missing = unchecked.slice(0, 4).map((u) => u.label).join(", ");
  return `${coverage.ran} of ${coverage.total} source checks ran. Not reported by the inventory: ${missing}${unchecked.length > 4 ? ` +${unchecked.length - 4} more` : ""}.`;
}
