// ---------------------------------------------------------------------------
// The discovery manifest, in MTA's shape
// ---------------------------------------------------------------------------
/**
 * MTA 8 has a model for exactly what this agent does, and we should use its
 * vocabulary rather than invent a parallel one.
 *
 * Red Hat calls it PLATFORM AWARENESS: a *source platform* is a type, an API
 * URL and a credential; *coordinates* identify an application within that
 * platform; *discovery* fetches the runtime configuration of applications at
 * those coordinates and produces a *discovery manifest*; and the manifest
 * drives *asset generation* for the target platform.
 *
 * In MTA 8 the only implemented source platform is Cloud Foundry. vSphere is
 * not one — Red Hat built the framework and wrote one provider. So this agent
 * is not competing with MTA here, it is the vSphere provider MTA does not
 * have, and emitting its manifest in MTA's shape is what makes that claim
 * real rather than rhetorical: the same document, a different platform.
 *
 * Two rules carried over from everything else in this product:
 *
 *   - A COORDINATE IS NOT A GUESS. The vCenter URL plus the machine's BIOS
 *     UUID identifies one machine and survives being renamed. The MoRef is
 *     recorded beside it because it is what vCenter APIs take, but it is
 *     scoped to the vCenter and says so.
 *   - WHAT WAS NOT READ IS IN THE DOCUMENT. A manifest that lists only what we
 *     found reads as complete. The `unread` block is part of the schema, not
 *     an afterthought.
 *
 * Everything here is pure.
 */

const SCHEMA = "tcs.agentic-ai/discovery-manifest/v1";

/** Platform type, in MTA's vocabulary. */
export const PLATFORM_VSPHERE = "vsphere";

/**
 * Coordinates for one machine.
 *
 * MTA's Cloud Foundry coordinates are {name, space}. The vSphere equivalent is
 * the vCenter that owns it plus an identifier within it — and which identifier
 * matters, so both are carried with their scope stated.
 */
export function coordinates({ vcenter = null, vm = {}, guest = {} } = {}) {
  const biosUuid = guest.biosUuid || vm.biosUuid || null;
  return {
    platform: PLATFORM_VSPHERE,
    instance: vcenter || null,
    // Stable across rename, power cycle and vCenter re-registration.
    machineUuid: biosUuid,
    // Scoped to `instance`. Meaningless without it, and said so.
    managedObjectId: guest.vmId || vm.id || null,
    managedObjectIdScope: vcenter ? `unique within ${vcenter}` : "unique within its vCenter only",
    name: guest.name || vm.name || null,
    hostname: guest.hostname || null,
  };
}

/**
 * What was observed at those coordinates.
 *
 * Deliberately the RUNTIME configuration — what is running and how it was
 * invoked — because that is what MTA's manifests carry for Cloud Foundry, and
 * what asset generation needs. Not the VM's hardware shape, which describes
 * the box rather than the workload.
 */
export function observedConfiguration(guest = {}, result = {}) {
  const procs = Array.isArray(guest.processes) ? guest.processes : null;
  return {
    powerState: guest.powerState || null,
    operatingSystem: guest.os?.fullName || null,
    operatingSystemId: guest.os?.id || null,
    toolsRunning: guest.toolsRunning ?? null,
    addresses: [guest.ipAddress].filter(Boolean),
    runtimes: (result.runtimes || []).map((r) => ({
      id: r.id, label: r.label, suggestedBaseImage: r.base || null, evidence: r.evidence || null,
    })),
    datastores: (result.datastores || []).map((d) => ({ id: d.id, label: d.label, evidence: d.evidence || null })),
    processCount: procs ? procs.length : null,
    // The command lines are the evidence every finding is drawn from, and a
    // manifest without them cannot be argued with. Capped, because a busy
    // machine has hundreds and a manifest is a document, not a dump.
    processes: procs ? procs.slice(0, 80).map((p) => ({ name: p.name, owner: p.owner || null, commandLine: p.cmdLine || null })) : null,
  };
}

/**
 * One application entry.
 *
 * `disposition` is the field MTA has no equivalent for, and it is the point of
 * this agent: MTA's manifests describe things that are becoming containers,
 * because Cloud Foundry applications already are. A vSphere estate contains
 * machines that should stay machines, and a manifest that could not say so
 * would be describing a different estate from the real one.
 */
export function manifestEntry({ vcenter = null, vm = {}, guest = {}, result = {} } = {}) {
  return {
    name: result.name || guest.name || vm.name || null,
    coordinates: coordinates({ vcenter, vm, guest }),
    disposition: {
      verdict: result.verdict || null,
      confidence: result.confidence || null,
      summary: result.summary || null,
      blockers: (result.blockers || []).map((b) => ({ id: b.id, title: b.title, action: b.action || null, evidence: b.evidence || null })),
      requiredWork: (result.concerns || []).filter((c) => c.required)
        .map((c) => ({ id: c.id, title: c.title, action: c.action || null })),
    },
    observed: observedConfiguration(guest, result),
    // Part of the schema, not a footnote. A manifest listing only what was
    // found reads as complete, and this one is not.
    unread: (result.unchecked || []).map((u) => ({ fact: u.fact, reason: u.reason })),
  };
}

/**
 * The manifest for a whole discovery run.
 *
 * @param {Array}  entries  [{ vcenter, vm, guest, result }]
 * @param {object} meta     { at, actor, clusters, method }
 */
export function discoveryManifest(entries = [], meta = {}) {
  const apps = entries.map(manifestEntry);
  const byVerdict = {};
  for (const a of apps) byVerdict[a.disposition.verdict] = (byVerdict[a.disposition.verdict] || 0) + 1;

  return {
    schema: SCHEMA,
    // Named after MTA's concept so the correspondence is explicit rather than
    // claimed in a slide.
    kind: "DiscoveryManifest",
    generatedAt: meta.at || new Date().toISOString(),
    generatedBy: { product: "TCS Agentic AI — Workload Modernization Agent", actor: meta.actor || null },
    sourcePlatform: {
      type: PLATFORM_VSPHERE,
      instances: [...new Set(apps.map((a) => a.coordinates.instance).filter(Boolean))],
      note: "MTA 8 implements Cloud Foundry as a source platform; vSphere is not one of them. This manifest is that platform's equivalent, in the same shape.",
    },
    method: {
      read: "VMware Tools guest operations — guest properties and the running process list.",
      executedInGuest: false,
      installedInGuest: false,
      note: meta.method || "Nothing was executed inside any guest and nothing was installed. Listening ports, unit files, packages, scheduled jobs, kernel modules and configuration were not read.",
    },
    applications: apps,
    summary: { total: apps.length, byVerdict },
  };
}
