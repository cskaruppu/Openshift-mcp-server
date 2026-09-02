/**
 * VM Migration — UC-10, on Migration Toolkit for Virtualization (MTV/Forklift).
 *
 *   readiness ──▶ discover ──▶ group into Plans ──▶ Plan (validates) ──▶ CR
 *                                                        │
 *                              approved ──▶ Migration ──▶ progress ──▶ verified
 *                                                        └──▶ ROLLBACK
 *
 * Three rules carried over from UC-06, for the same reasons:
 *
 *  1. The LLM never writes a Plan. It recommends warm vs cold and explains
 *     failures; every manifest is built by fixed logic from a typed struct.
 *  2. Nothing is autonomous. A migration moves production workloads, so it is
 *     human-selected and change-approved by construction.
 *  3. THE SOURCE VM IS NEVER DELETED. Cold migration powers it off; that is the
 *     way back, and it stays until a person raises a decommission request.
 *
 * MTV shape that drives the design: Plan.spec.vms is a LIST, but `warm`, the
 * provider, both maps and the target namespace are PLAN-level. So a selection
 * that mixes strategies or targets becomes several Plans — planGroups() is
 * where that is decided, and it is pure so it can be tested.
 */

import { ocpGet, ocpPost, ocpPatch, ocpDelete, ocpFetch } from "../utils/openshift-client.js";
import { nodeFit } from "./target-capacity.js";
import { runSourceChecks } from "./source-readiness.js";
import { resourceFindings } from "./resource-fidelity.js";
import { recordChange } from "./change-ledger.js";
import { classifyJSON, llmEnabled } from "./llm.js";
import { fenceUntrusted, UNTRUSTED_GUARD } from "./untrusted.js";

const FORKLIFT = "apis/forklift.konveyor.io/v1beta1";
const MTV_NS = process.env.MTV_NAMESPACE || "openshift-mtv";

/** Providers whose VMs we can migrate FROM. */
const SOURCE_TYPES = new Set(["vsphere", "ovirt", "openstack", "ova"]);

const nowIso = () => new Date().toISOString();
const cond = (o, type) => (o?.status?.conditions || []).find((c) => c.type === type);
const isTrue = (o, type) => cond(o, type)?.status === "True";

// ---------------------------------------------------------------------------
// 1. Readiness — is MTV actually usable, not merely installed
// ---------------------------------------------------------------------------
/**
 * Everything that must be true before a migration can be planned, checked
 * against the live cluster. Deliberately reports WHY each item failed and what
 * to do, rather than a bare boolean: "MTV not ready" helps nobody.
 *
 * @returns {{ok:boolean, blocking:Array, warnings:Array, operator:object,
 *            providers:Array, storageMaps:Array, networkMaps:Array}}
 */
/**
 * What a failure to read forklift.konveyor.io actually means. Pure, because
 * this exact distinction was got wrong in the field: MTV v2.11.7 was installed
 * and healthy, the agent simply had no RBAC for it, and a 403 was reported as
 * "not installed" — which sends someone to reinstall a working operator.
 *
 * @returns {null|{code:string, message:string, fix?:string, rbacDenied?:boolean}}
 */
export function mtvAccessVerdict({ status = 0, error = null, namespace = MTV_NS } = {}) {
  if (!error) return null;
  if (status === 403) {
    return {
      code: "mtv-rbac-denied",
      rbacDenied: true,
      message: `MTV is installed, but this service account may not read forklift.konveyor.io resources in "${namespace}". Grant the migration role — it is an opt-in ClusterRole, applied cluster-side with no image rebuild.`,
      fix: "oc apply -f https://raw.githubusercontent.com/cskaruppu/openshift-mcp-server/claude/setup-mcp-openshift-9JUo7/deploy/dashboard/manifests/serviceaccount.yaml",
    };
  }
  if (status === 404) {
    return {
      code: "mtv-not-installed",
      message: "The forklift.konveyor.io API is not served by this cluster — the MTV operator is not installed.",
    };
  }
  return {
    code: "mtv-not-installed",
    message: `Could not read MTV in "${namespace}": ${error}. Install the MTV operator, or set MTV_NAMESPACE if it lives elsewhere.`,
  };
}

export async function checkMtvReadiness() {
  const blocking = [], warnings = [];
  // Keep the HTTP status: "we may not look" and "it is not there" are entirely
  // different problems with entirely different fixes, and conflating them sends
  // someone to reinstall an operator that was working all along.
  const safe = async (p) => {
    try { return await ocpGet(p); }
    catch (e) {
      const m = /OCP API (\d{3})/.exec(e.message || "");
      return { __error: e.message, __status: m ? Number(m[1]) : 0 };
    }
  };

  // Operator / controller
  const fc = await safe(`/${FORKLIFT}/namespaces/${MTV_NS}/forkliftcontrollers`);

  const access = mtvAccessVerdict({ status: fc.__status, error: fc.__error, namespace: MTV_NS });
  if (access) {
    blocking.push(access);
    return {
      ok: false, blocking, warnings, rbacDenied: access.rbacDenied,
      operator: { installed: !!access.rbacDenied, readable: false, namespace: MTV_NS },
      providers: [], sources: [], targets: [], storageMaps: [], networkMaps: [], checkedAt: nowIso(),
    };
  }

  const controller = (fc.items || [])[0] || null;
  const operator = {
    installed: !fc.__error && Array.isArray(fc.items),
    readable: !fc.__error,
    namespace: MTV_NS,
    name: controller?.metadata?.name || null,
    ready: controller ? isTrue(controller, "Successful") || isTrue(controller, "Ready") : false,
  };
  if (!controller) {
    blocking.push({ code: "no-forklift-controller", message: `No ForkliftController in ${MTV_NS} — the operator is installed but not configured.` });
  } else if (!operator.ready) {
    warnings.push({ code: "controller-not-ready", message: `ForkliftController "${operator.name}" is not reporting Ready yet.` });
  }

  // Providers
  const provList = await safe(`/${FORKLIFT}/namespaces/${MTV_NS}/providers`);
  const providers = (provList.items || []).map((p) => ({
    name: p.metadata.name,
    namespace: p.metadata.namespace,
    uid: p.metadata.uid,
    type: (p.spec?.type || "").toLowerCase(),
    url: p.spec?.url || null,
    isSource: SOURCE_TYPES.has((p.spec?.type || "").toLowerCase()),
    ready: isTrue(p, "Ready"),
    connected: isTrue(p, "ConnectionTested") || isTrue(p, "Ready"),
    reason: cond(p, "Ready")?.message || cond(p, "ConnectionTested")?.message || null,
  }));
  const sources = providers.filter((p) => p.isSource);
  const targets = providers.filter((p) => p.type === "openshift");

  if (sources.length === 0) {
    blocking.push({ code: "no-source-provider", message: "No source provider configured (vSphere, oVirt, OpenStack or OVA). Add one in MTV before migrating." });
  }
  if (targets.length === 0) {
    // MTV creates a "host" provider for the local cluster; its absence is unusual.
    blocking.push({ code: "no-target-provider", message: "No OpenShift target provider configured in MTV." });
  }
  for (const p of providers) {
    if (!p.connected) {
      blocking.push({ code: "provider-not-connected", message: `Provider "${p.name}" (${p.type}) is not connected${p.reason ? ` — ${p.reason}` : ""}. Check its URL and credentials secret.` });
    }
  }

  // Maps
  const [smList, nmList] = await Promise.all([
    safe(`/${FORKLIFT}/namespaces/${MTV_NS}/storagemaps`),
    safe(`/${FORKLIFT}/namespaces/${MTV_NS}/networkmaps`),
  ]);
  const mapOf = (list) => (list.items || []).map((m) => ({
    name: m.metadata.name,
    namespace: m.metadata.namespace,
    ready: isTrue(m, "Ready"),
    reason: cond(m, "Ready")?.message || null,
    sourceProvider: m.spec?.provider?.source?.name || null,
    targetProvider: m.spec?.provider?.destination?.name || null,
    entries: (m.spec?.map || []).length,
    // Source identifiers this map covers — used to prove a selection is mappable.
    covers: (m.spec?.map || []).map((e) => e.source?.id || e.source?.name || e.source?.type).filter(Boolean),
  }));
  const storageMaps = mapOf(smList), networkMaps = mapOf(nmList);

  if (storageMaps.length === 0) blocking.push({ code: "no-storage-map", message: "No StorageMap exists. Create one mapping each source datastore to a target storage class." });
  if (networkMaps.length === 0) blocking.push({ code: "no-network-map", message: "No NetworkMap exists. Create one mapping each source network to a target network." });
  for (const m of [...storageMaps, ...networkMaps]) {
    if (!m.ready) warnings.push({ code: "map-not-ready", message: `Map "${m.name}" is not Ready${m.reason ? ` — ${m.reason}` : ""}.` });
  }

  return {
    ok: blocking.length === 0,
    blocking, warnings, operator,
    providers, sources, targets, storageMaps, networkMaps,
    checkedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// 2. Discovery — VMs live in MTV's inventory service, not in Kubernetes
// ---------------------------------------------------------------------------
/**
 * MTV mirrors each provider's inventory into a service in its own namespace;
 * the VMs are NOT Kubernetes objects. Reached by ClusterIP read from the API
 * server, so no in-cluster DNS is required — the same approach the Prometheus
 * client uses, and for the same reason.
 */
async function inventoryBase() {
  const svc = await ocpGet(`/api/v1/namespaces/${MTV_NS}/services/forklift-inventory`).catch(() => null);
  if (!svc) throw new Error(`No "forklift-inventory" service in ${MTV_NS} — cannot list VMs.`);
  const ip = svc.spec?.clusterIP;
  const port = (svc.spec?.ports || []).find((p) => /https|api|8443/.test(`${p.name}${p.port}`))?.port
    || svc.spec?.ports?.[0]?.port || 8443;
  if (!ip || ip === "None") throw new Error("The forklift-inventory service has no ClusterIP.");
  return `https://${ip}:${port}`;
}

async function inventoryGet(path) {
  const { fetch: undiciFetch, Agent } = await import("undici");
  const { readFile } = await import("node:fs/promises");
  const base = await inventoryBase();
  let token = "";
  try { token = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim(); } catch { /* dev */ }
  // The inventory service presents a service-serving certificate. Verifying it
  // needs the service-ca bundle, which is not always mounted; reachability of a
  // service inside our own cluster is what matters here, not its identity.
  const agent = new Agent({ connect: { rejectUnauthorized: false, timeout: 8000 } });
  const r = await undiciFetch(`${base}${path}`, {
    dispatcher: agent,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Inventory ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.json();
}

/**
 * VMs discovered on a source provider, with the facts a migration decision
 * actually turns on: power state, disk footprint, and whether changed-block
 * tracking makes a warm migration possible at all.
 */
export async function discoverVMs(providerUid, { search = "" } = {}) {
  const raw = await inventoryGet(`/providers/vsphere/${providerUid}/vms?detail=1`)
    .catch(async () => inventoryGet(`/providers/${providerUid}/vms?detail=1`));
  const list = Array.isArray(raw) ? raw : (raw?.items || []);
  const vms = list.map((v) => normaliseInventoryVM(v));
  const q = search.trim().toLowerCase();
  return q ? vms.filter((v) => v.name.toLowerCase().includes(q)) : vms;
}

/** One shape regardless of provider flavour, so the card never branches. */
/** Tri-state: true / false / null when the source never mentioned the fact. */
function bool(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

export function normaliseInventoryVM(v = {}) {
  const disks = v.disks || v.Disks || [];
  const totalBytes = disks.reduce((n, d) => n + (d.capacity || d.Capacity || 0), 0);
  const cbt = v.changeTrackingEnabled ?? v.changeTrackingSupported ?? null;
  const powered = /poweredOn|up|ACTIVE|running/i.test(String(v.powerState || v.status || ""));

  // Addresses come from the guest agent (VMware Tools / qemu-ga). A VM with no
  // agent reports none — that is worth showing rather than leaving blank, since
  // it also means less can be verified after the migration.
  const nets = v.guestNetworks || v.guestNetworkInterfaces || v.ipAddresses || [];
  const ips = [...new Set(
    (Array.isArray(nets) ? nets : [])
      .map((n) => (typeof n === "string" ? n : n.ip || n.ipAddress || n.address))
      .filter(Boolean)
      .concat(v.ipAddress ? [v.ipAddress] : []),
  )].filter((ip) => !/^(127\.|::1|fe80:)/i.test(ip));

  const guestOS = v.guestName || v.guestFullName || v.osType || v.guestId || null;

  return {
    id: v.id || v.uuid || v.ID || null,
    name: v.name || v.Name || "(unnamed)",
    path: v.path || null,
    host: v.host?.name || v.host || null,
    powerState: v.powerState || v.status || "unknown",
    poweredOn: powered,

    // Compute
    cpuCount: v.cpuCount ?? v.cpuCores ?? null,
    coresPerSocket: v.coresPerSocket ?? null,
    memoryMB: v.memoryMB ?? (v.memory ? Math.round(v.memory / 1048576) : null),
    memoryGiB: v.memoryMB ? Math.round(v.memoryMB / 1024) : (v.memory ? Math.round(v.memory / 1073741824) : null),

    // Guest
    guestOS,
    guestId: v.guestId || null,
    hostName: v.hostName || v.guestHostName || null,
    ips,
    toolsStatus: v.guestToolsStatus || v.toolsStatus || null,
    firmware: v.firmware || (v.bootOptions?.efiSecureBootEnabled ? "efi" : null),

    // ── Facts the source-readiness checks run against ──────────────────────
    // Every one of these stays NULL when the inventory did not report it, so a
    // check that could not run is never mistaken for a check that passed.
    isTemplate: bool(v.isTemplate),
    connectionState: v.connectionState ?? null,
    faultToleranceEnabled: bool(v.faultToleranceEnabled),
    // Forklift reports a snapshot as a reference object, not a count.
    hasSnapshot: v.snapshot === undefined ? null
      : Array.isArray(v.snapshot) ? v.snapshot.length > 0
      : !!(v.snapshot && (v.snapshot.id || v.snapshot.kind || v.snapshot.name)),
    secureBoot: bool(v.secureBoot ?? v.bootOptions?.efiSecureBootEnabled),
    tpmEnabled: bool(v.tpmEnabled ?? v.tpmPresent),
    // What VMware currently PROMISES this VM. None of it survives migration,
    // so it has to be read before the wave rather than missed afterwards.
    cpuReservation: v.cpuReservation ?? v.resourceConfig?.cpuAllocation?.reservation ?? null,
    memoryReservation: v.memoryReservation ?? v.resourceConfig?.memoryAllocation?.reservation ?? null,
    memoryReservationLockedToMax: bool(v.memoryReservationLockedToMax ?? v.resourceConfig?.memoryReservationLockedToMax),
    latencySensitivity: v.latencySensitivity ?? null,
    balloonedMemory: v.balloonedMemory ?? null,
    cpuAffinity: Array.isArray(v.cpuAffinity) ? v.cpuAffinity : null,
    numaNodeAffinity: Array.isArray(v.numaNodeAffinity) ? v.numaNodeAffinity : null,
    cpuHotAddEnabled: bool(v.cpuHotAddEnabled),
    memoryHotAddEnabled: bool(v.memoryHotAddEnabled),
    devices: Array.isArray(v.devices) ? v.devices.map((d) => ({ kind: d.kind || d.Kind || d.type || "" })) : null,
    nics: Array.isArray(v.nICs || v.nics)
      ? (v.nICs || v.nics).map((n) => ({ network: n.network?.name || n.network || n.name || null, mac: n.mac || null }))
      : null,

    // Storage, per disk — a migration is a storage operation before anything else
    diskCount: disks.length,
    diskBytes: totalBytes,
    diskGiB: totalBytes ? Math.round(totalBytes / 1073741824) : null,
    disks: disks.map((d) => ({
      name: d.key || d.name || d.file || "disk",
      capacityGiB: (d.capacity || d.Capacity) ? Math.round((d.capacity || d.Capacity) / 1073741824) : null,
      datastore: d.datastore?.name || d.datastore?.id || d.Datastore || null,
      shared: d.shared === true,
      rdm: d.rdm === true || /rawDiskMapping/i.test(String(d.mode || "")),
      mode: d.mode || null,
    })),

    // Migration-relevant facts
    changeTrackingEnabled: cbt === true,
    warmEligible: cbt === true && powered,
    warmBlockedReason: cbt === true
      ? (powered ? null : "The VM is powered off — warm migration has nothing to track. Use cold.")
      : "Changed block tracking is not enabled on this VM, so an incremental copy is impossible. Use cold, or enable CBT and rediscover.",
    datastores: [...new Set(disks.map((d) => d.datastore?.id || d.datastore?.name || d.Datastore).filter(Boolean))],
    networks: (v.networks || v.Networks || []).map((n) => n.id || n.name || n).filter(Boolean),

    // MTV's own validation service runs OPA policies over each VM and returns
    // "concerns" with a category. Critical means the migration will fail.
    concerns: (v.concerns || []).map((c) => ({
      category: (c.category || "").toLowerCase(),
      label: c.label || "",
      assessment: c.assessment || "",
    })),

    // Classified guest, for the fleet view
    os: classifyGuestOS(guestOS, v.guestId),
  };
}

// ---------------------------------------------------------------------------
// 2a. Guest OS classification and the OpenShift Virtualization support matrix
// ---------------------------------------------------------------------------
/**
 * The support position for guest operating systems on OpenShift
 * Virtualization. Data, not code, and stamped with when it was written —
 * Red Hat's certified list moves with each release, and a matrix that pretends
 * otherwise is worse than none. Override with MTV_SUPPORT_MATRIX to pin your
 * own contractual position.
 *
 * Levels: supported | caveats | unsupported | unknown
 */
export const SUPPORT_MATRIX = {
  asOf: "2026-09-02",
  source: "Red Hat: Certified Guest Operating Systems in OpenShift Virtualization (article 4234591), read 2 September 2026. Confirm against the list for YOUR OpenShift version before committing to a wave.",
  url: "https://access.redhat.com/articles/4234591",

  // Red Hat publishes THREE tiers, not two, and flattening them loses the
  // distinction that actually matters in a support call:
  //
  //   certified  Red Hat has tested it and will support you on it.
  //   vendor     The OS vendor supports it (Oracle, SUSE, Canonical). Red Hat
  //              will help with the hypervisor; the guest is the vendor's.
  //   known      "Known to run" — it boots, nobody certifies it. End-of-life
  //              Windows lives here. Not the same thing as "will not work",
  //              and not the same thing as supported.
  //
  // `tier` is carried through to the console so a person can see which of the
  // three they are looking at rather than inferring it from a colour.
  tiers: {
    certified: "Red Hat certified",
    vendor: "Supported by the OS vendor",
    known: "Known to run — not certified",
    deprecated: "Deprecated by Red Hat",
    unlisted: "Not on Red Hat's certified list",
  },

  windows: [
    { match: /server\D*2025/i, label: "Windows Server 2025", level: "supported", tier: "certified" },
    { match: /server\D*2022/i, label: "Windows Server 2022", level: "supported", tier: "certified" },
    { match: /server\D*2019/i, label: "Windows Server 2019", level: "supported", tier: "certified" },
    { match: /server\D*2016/i, label: "Windows Server 2016", level: "supported", tier: "certified" },
    // Everything below is "known to run" in Red Hat's own words — it boots,
    // and you are on your own with it.
    { match: /server\D*2012\s*r2/i, label: "Windows Server 2012 R2", level: "unsupported", tier: "known",
      note: "Known to run, but not certified for OpenShift Virtualization, and past Microsoft end of extended support.",
      upgrade: "Windows Server 2022 or 2025" },
    { match: /server\D*2012/i, label: "Windows Server 2012", level: "unsupported", tier: "known",
      note: "Known to run, but not certified, and past Microsoft end of extended support.",
      upgrade: "Windows Server 2022 or 2025" },
    { match: /server\D*(2008|2003)/i, label: "Windows Server 2008/2003", level: "unsupported", tier: "known",
      note: "Known to run, not certified, and long past end of life. Migrate only as a lift-and-shift into a quarantined namespace.",
      upgrade: "Windows Server 2022 or 2025" },
    { match: /windows\s*11/i, label: "Windows 11", level: "supported", tier: "certified",
      note: "Certified. Requires EFI and a vTPM on the target, which needs vmStateStorageClass configured on the cluster." },
    { match: /windows\s*10/i, label: "Windows 10", level: "supported", tier: "certified" },
    { match: /windows\s*(7|8|xp|vista)/i, label: "Windows 7/8/XP", level: "unsupported", tier: "known",
      note: "Known to run, not certified, end of life.", upgrade: "Windows 10 or 11" },
  ],

  linux: [
    { match: /(rhel|red\s*hat\s*enterprise\s*linux)\D*10\b/i, label: "RHEL 10", level: "supported", tier: "certified" },
    { match: /(rhel|red\s*hat\s*enterprise\s*linux)\D*9\b/i, label: "RHEL 9", level: "supported", tier: "certified" },
    { match: /(rhel|red\s*hat\s*enterprise\s*linux)\D*8\b/i, label: "RHEL 8", level: "supported", tier: "certified" },
    // Certified on the list, but Red Hat maintenance ended in June 2024 — both
    // facts are true and the operator needs both.
    { match: /(rhel|red\s*hat\s*enterprise\s*linux)\D*7\b/i, label: "RHEL 7", level: "supported", tier: "certified",
      note: "Certified, but past end of maintenance support — an Extended Life Cycle Support subscription is needed to stay patched.",
      upgrade: "RHEL 9" },
    { match: /(rhel|red\s*hat\s*enterprise\s*linux)\D*6\b/i, label: "RHEL 6", level: "unsupported", tier: "deprecated",
      note: "Deprecated at OpenShift Virtualization 4.13 and listed for migration support only — it can be moved, not run supported.",
      upgrade: "RHEL 9" },
    { match: /(rhel|red\s*hat\s*enterprise\s*linux)\D*5\b/i, label: "RHEL 5", level: "unsupported", tier: "unlisted",
      note: "Not on the certified list; very old virtio support.", upgrade: "RHEL 9" },

    // Commercially supported by their own vendor rather than by Red Hat.
    { match: /oracle/i, label: "Oracle Linux", level: "caveats", tier: "vendor",
      note: "Oracle Linux 8 and 9 are supported by Oracle, not by Red Hat. Confirm your entitlement covers running it here." },
    { match: /sles|suse/i, label: "SUSE Linux Enterprise", level: "caveats", tier: "vendor",
      note: "SLES 15 SP5 and later, and SLES 16, are supported by SUSE rather than Red Hat. Confirm your entitlement." },
    { match: /ubuntu/i, label: "Ubuntu", level: "caveats", tier: "vendor",
      note: "Canonical supports Ubuntu LTS releases (18.04 through 25.04) here; Red Hat does not. Confirm the release is still in Canonical support." },

    // Deprecated by Red Hat, with a date.
    { match: /centos\s*stream\D*8\b/i, label: "CentOS Stream 8", level: "unsupported", tier: "deprecated",
      note: "Deprecated at OpenShift Virtualization 4.18 — an end-of-life product.",
      upgrade: "RHEL 9, or convert in place with convert2rhel" },
    { match: /centos\D*7\b/i, label: "CentOS 7", level: "unsupported", tier: "deprecated",
      note: "Deprecated at OpenShift Virtualization 4.18 — an end-of-life product.",
      upgrade: "RHEL 9, or convert in place with convert2rhel" },
    { match: /centos\s*stream/i, label: "CentOS Stream", level: "caveats", tier: "unlisted",
      note: "Not on Red Hat's certified list. Community support only.", upgrade: "RHEL 9 for a certified guest" },

    // Not on the list at all. That is a fact about the list, not a verdict on
    // the distribution — so it says exactly that.
    { match: /rocky/i, label: "Rocky Linux", level: "caveats", tier: "unlisted",
      note: "Not on Red Hat's certified list. Community support only.", upgrade: "RHEL 9 for a certified guest" },
    { match: /alma/i, label: "AlmaLinux", level: "caveats", tier: "unlisted",
      note: "Not on Red Hat's certified list. Community support only.", upgrade: "RHEL 9 for a certified guest" },
    { match: /debian/i, label: "Debian", level: "caveats", tier: "unlisted",
      note: "Not on Red Hat's certified list. Community support only." },
    { match: /fedora/i, label: "Fedora", level: "caveats", tier: "unlisted",
      note: "Not on Red Hat's certified list. Community support only; short lifecycle." },
  ],
};

/**
 * vSphere guestId → the operating system it actually means.
 *
 * MTV's inventory frequently reports only the guestId, and a guestId is not a
 * display name: "windows2019srvNext_64Guest" is VMware's identifier for Windows
 * Server 2022, not 2019 — "srvNext" means "the release after this one". Reading
 * it as a version string gets the answer wrong, which is why this is a lookup
 * table and not a regex over the raw text.
 *
 * Ordered: longer, more specific ids first.
 */
export const GUEST_ID_MAP = [
  [/^windows2022srvNext/i, () => "Microsoft Windows Server 2025"],
  [/^windows2019srvNext/i, () => "Microsoft Windows Server 2022"],
  [/^windows2019srv/i, () => "Microsoft Windows Server 2019"],
  [/^windows9Server/i, () => "Microsoft Windows Server 2016"],
  [/^windows8Server/i, () => "Microsoft Windows Server 2012"],
  [/^windows7Server/i, () => "Microsoft Windows Server 2008 R2"],
  [/^winLonghorn/i, () => "Microsoft Windows Server 2008"],
  [/^winNet/i, () => "Microsoft Windows Server 2003"],
  [/^win(2000|NT|XP)/i, () => "Microsoft Windows XP/2000"],
  [/^windows11/i, () => "Microsoft Windows 11"],
  [/^windows9(_|\d*Guest)/i, () => "Microsoft Windows 10"],
  [/^windows8(_|\d*Guest)/i, () => "Microsoft Windows 8"],
  [/^windows7(_|\d*Guest)/i, () => "Microsoft Windows 7"],
  [/^rhel(\d+)/i, (m) => `Red Hat Enterprise Linux ${m[1]}`],
  [/^centos(\d+)/i, (m) => `CentOS ${m[1]}`],
  [/^centos/i, () => "CentOS"],
  [/^oracleLinux(\d+)/i, (m) => `Oracle Linux ${m[1]}`],
  [/^oracleLinux/i, () => "Oracle Linux"],
  [/^sles(\d+)/i, (m) => `SUSE Linux Enterprise ${m[1]}`],
  [/^sles|^suse/i, () => "SUSE Linux Enterprise"],
  [/^debian(\d+)/i, (m) => `Debian ${m[1]}`],
  [/^debian/i, () => "Debian"],
  [/^ubuntu/i, () => "Ubuntu Linux"],
  [/^fedora/i, () => "Fedora Linux"],
  [/^rockylinux/i, () => "Rocky Linux"],
  [/^almalinux/i, () => "AlmaLinux"],
  [/^other\w*Linux/i, () => "Other Linux"],
];

/** A guestId can arrive in either field, so it has to be recognised by shape. */
function looksLikeGuestId(s) {
  return /^[a-z][A-Za-z0-9_]*Guest$/.test(s);
}

/** Expand a vSphere guestId to a display name, or null if it is not one. */
export function expandGuestId(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  for (const [re, fn] of GUEST_ID_MAP) {
    const m = re.exec(s);
    if (m) return fn(m);
  }
  return null;
}

/**
 * Turn a free-text guest OS string into a family, a distribution and a
 * support level. Pure — the classification rules are tested, not trusted.
 *
 * @returns {{family:string, distro:string, version:string|null, level:string, note:string|null, raw:string|null, reported:string|null}}
 */
export function classifyGuestOS(guestOS, guestId = null) {
  const reported = String(guestOS || guestId || "").trim();
  if (!reported) {
    return { family: "unknown", distro: "Unknown", version: null, level: "unknown", raw: null, reported: null,
      note: "No guest OS reported — the guest agent may not be running. Identify it before migrating." };
  }

  // Decode the id before matching. Without this, "windows2019srvNext_64Guest"
  // reaches the matrix as an opaque token, lands in no row, and a perfectly
  // ordinary Server 2022 fleet reports as "needs review".
  const id = String(guestId || "").trim() || (looksLikeGuestId(reported) ? reported : "");
  const raw = (id && expandGuestId(id)) || reported;

  const isWindows = /windows|microsoft/i.test(raw) || /^win/i.test(id);
  const table = isWindows ? SUPPORT_MATRIX.windows : SUPPORT_MATRIX.linux;
  const hit = table.find((e) => e.match.test(raw));

  if (hit) {
    const ver = /(\d{4}\s*r2|\d{1,4}(?:\.\d+)?)/i.exec(hit.label);
    return {
      family: isWindows ? "windows" : "linux",
      distro: hit.label,
      version: ver ? ver[1] : null,
      level: hit.level,
      tier: hit.tier || null,
      tierLabel: SUPPORT_MATRIX.tiers[hit.tier] || null,
      note: hit.note || null,
      upgrade: hit.upgrade || null,
      raw, reported,
    };
  }

  // Recognised as a family but not in the matrix — say so rather than guessing.
  const family = isWindows ? "windows" : /linux|unix|bsd|centos|debian|gentoo/i.test(raw) ? "linux" : "other";
  return {
    family,
    distro: raw.slice(0, 48),
    version: null,
    level: "unknown",
    tier: null, tierLabel: null,
    note: `"${raw.slice(0, 48)}" is not in the support matrix. Check Red Hat's certified guest list for your OpenShift version before migrating.`,
    raw, reported,
  };
}

// ---------------------------------------------------------------------------
// 2b. Supportability — can this VM migrate at all?
// ---------------------------------------------------------------------------
/**
 * Whether a VM can actually be migrated, and what a person needs to know first.
 *
 * The primary source is MTV itself: its validation service runs policies over
 * every discovered VM and returns "concerns" categorised Critical, Warning or
 * Information. A Critical concern means the migration WILL fail — an
 * independent or RDM disk that cannot be snapshotted, a passthrough device
 * that has no equivalent on the target, an unsupported guest. Surfacing those
 * before selection is the difference between a plan that fails at validation
 * and one that never gets built.
 *
 * On top of that we add checks MTV does not make, because they concern the
 * TARGET rather than the source.
 *
 * Pure, so the rules are tested rather than trusted.
 */
export function assessSupportability(vm = {}, { targetFreeGiB = null, capacity = null, cpuAllocationRatio = null } = {}) {
  const blockers = [], warnings = [], notes = [];

  // Can this machine schedule at all? A KubeVirt VM is a pod, so it must fit on
  // ONE node — MTV will happily copy 200 GiB for a VM that then sits Pending
  // forever because no worker is big enough. "Never" blocks; "not right now"
  // warns, because the two need completely different responses.
  if (capacity?.available) {
    const fit = nodeFit(vm, capacity);
    if (fit.fits === false) {
      (fit.permanent ? blockers : warnings).push({ source: "target", message: fit.reason });
    }
  }

  for (const c of vm.concerns || []) {
    const text = `${c.label}${c.assessment ? ` — ${c.assessment}` : ""}`.trim();
    // Forklift reports "Critical"/"Warning"/"Information"; normaliseInventoryVM
    // lowercases them, but this is also called on bodies posted straight from
    // the console — a mis-cased "Critical" must never downgrade to a note.
    const cat = String(c.category || "").toLowerCase();
    if (cat === "critical") blockers.push({ source: "mtv", message: text });
    else if (cat === "warning") warnings.push({ source: "mtv", message: text });
    else if (text) notes.push({ source: "mtv", message: text });
  }

  // Ours, about the target rather than the source.
  if (targetFreeGiB != null && vm.diskGiB && vm.diskGiB > targetFreeGiB) {
    blockers.push({
      source: "target",
      message: `Needs ${vm.diskGiB} GiB but only ${targetFreeGiB} GiB is available on the target storage class.`,
    });
  }
  if (/windows/i.test(vm.guestOS || "")) {
    notes.push({
      source: "target",
      message: "Windows guest — MTV installs virtio drivers during conversion. Confirm the guest boots and the network adapter appears before decommissioning the source.",
    });
  }

  // Source-side readiness: snapshots, independent disks, RDMs, passthrough
  // hardware, vTPM, Secure Boot, NIC coverage. MTV catches some of these and
  // says nothing about what to do; it misses others entirely.
  const checks = runSourceChecks(vm);
  // What the VM is promised on VMware versus what it will actually request
  // here. Never blocking — a workload that lands slower still lands.
  const resources = resourceFindings(vm, { cpuAllocationRatio: cpuAllocationRatio ?? undefined });
  checks.findings.push(...resources.findings);
  for (const f of checks.findings) {
    const entry = { source: "source-check", id: f.id, message: `${f.title}. ${f.detail}` };
    if (f.blocks) blockers.push(entry);
    else if (f.severity === "warning") warnings.push(entry);
    else notes.push(entry);
  }
  if ((vm.diskCount || 0) > 8) {
    warnings.push({ source: "target", message: `${vm.diskCount} disks — expect a proportionally longer transfer and more to verify afterwards.` });
  }
  if (!vm.poweredOn) {
    notes.push({ source: "mtv", message: "Already powered off — cold migration costs no additional downtime." });
  }

  return {
    name: vm.name,
    supported: blockers.length === 0,
    blockers, warnings, notes,
    // Kept whole so the console can show each finding's own fix, and so the
    // report can say how much of the assessment was actually possible.
    checks,
    sourceQoS: resources.sourceQoS,
    targetProfile: resources.target,
    // A single word for the table.
    verdict: blockers.length ? "blocked" : warnings.length ? "caution" : "supported",
  };
}

// ---------------------------------------------------------------------------
// 2c. Time estimate — MTV does not give one, and it is the first thing asked
// ---------------------------------------------------------------------------
/**
 * Throughput actually achieved on THIS cluster, measured from completed
 * migrations. An estimate built from a vendor number is a guess; one built
 * from your own storage and network is a forecast.
 *
 * @param {Array} history  [{ diskGiB, startedAt, completedAt }]
 * @returns {{mbps:number|null, samples:number, basis:string}}
 */
export function observedThroughput(history = []) {
  const usable = history.filter((h) => h.diskGiB > 0 && h.startedAt && h.completedAt);
  if (!usable.length) {
    return { mbps: null, samples: 0, basis: "No completed migrations yet — using a conservative default." };
  }
  const rates = usable.map((h) => {
    const secs = (new Date(h.completedAt) - new Date(h.startedAt)) / 1000;
    return secs > 0 ? (h.diskGiB * 1024) / secs : null;      // MiB/s
  }).filter((r) => r && r > 0 && r < 5000);                  // discard nonsense
  if (!rates.length) return { mbps: null, samples: 0, basis: "No usable timings yet." };
  rates.sort((a, b) => a - b);
  // Median, not mean: one stalled transfer should not drag the forecast down.
  const median = rates[Math.floor(rates.length / 2)];
  return {
    mbps: Math.round(median),
    samples: rates.length,
    basis: `Measured from ${rates.length} completed migration${rates.length === 1 ? "" : "s"} on this cluster (median ${Math.round(median)} MiB/s).`,
  };
}

/** Conservative default until this cluster has measured itself. */
const DEFAULT_MBPS = Number(process.env.MTV_DEFAULT_MBPS || 60);

/**
 * How long a wave will take, and how much of that is DOWNTIME — the two are
 * very different for warm, and conflating them is how maintenance windows get
 * blown.
 *
 * Reported as a range, because storage contention makes a single number a lie.
 */
export function estimateMigration(vms = [], { strategy = "cold", throughputMBps = null, concurrency = 2 } = {}) {
  const totalGiB = vms.reduce((n, v) => n + (v.diskGiB || 0), 0);
  const rate = throughputMBps || DEFAULT_MBPS;
  const par = Math.max(1, Math.min(concurrency, vms.length || 1));

  // Wall clock: total bytes over the aggregate rate, which does not scale
  // linearly with concurrency — the storage backend is the shared bottleneck.
  const aggregate = rate * Math.sqrt(par);
  const transferMin = totalGiB ? (totalGiB * 1024) / aggregate / 60 : 0;
  // Per VM: conversion, boot and verification, whatever the disk size.
  const overheadMin = (vms.length || 0) * 4;
  const likely = transferMin + overheadMin;

  const downtimeMin = strategy === "warm"
    // Warm copies while the VM runs; only the final delta and cutover cost.
    ? (vms.length || 0) * 6
    : likely;

  const round = (n) => Math.max(1, Math.round(n));
  return {
    vmCount: vms.length,
    totalGiB,
    strategy,
    throughputMBps: rate,
    concurrency: par,
    wallClockMinutes: { low: round(likely * 0.7), likely: round(likely), high: round(likely * 1.8) },
    downtimeMinutes: { low: round(downtimeMin * 0.7), likely: round(downtimeMin), high: round(downtimeMin * 1.8) },
    note: strategy === "warm"
      ? "Warm: the transfer happens while the VM runs, so only the cutover is downtime."
      : "Cold: the VM is powered off for the whole transfer, so transfer time IS downtime.",
  };
}


// ---------------------------------------------------------------------------
// 2d. Live ETA — measured DURING the transfer, not guessed before it
// ---------------------------------------------------------------------------
/**
 * A pre-flight estimate is a forecast from history. Once bytes are actually
 * moving, the migration is telling you its real rate — so the ETA should stop
 * being a prediction and become a measurement.
 *
 * Samples are kept per plan, in memory and deliberately transient: they
 * describe one run, and a restarted pod simply starts measuring again.
 */
const _samples = new Map();          // planName -> [{ at, bytes, total }]
const MAX_SAMPLES = 240;             // ~40 min at 10s, plenty for a rolling window

/** Bytes done and total across every VM in a plan, from MTV's own pipeline. */
export function progressSnapshot(status) {
  let bytes = 0, total = 0, activeVMs = 0;
  for (const v of status?.vms || []) {
    for (const s of v.steps || []) {
      if (!s.progress) continue;
      bytes += Number(s.progress.completed || 0);
      total += Number(s.progress.total || 0);
    }
    if (v.phase && !/Completed|Failed|Canceled|Pending/i.test(v.phase)) activeVMs++;
  }
  return { at: Date.now(), bytes, total, activeVMs };
}

export function recordProgressSample(planName, snap) {
  if (!planName || !snap || !snap.total) return;
  const arr = _samples.get(planName) || [];
  const last = arr[arr.length - 1];
  // Ignore a repeat with no elapsed time — it would divide by zero later.
  if (last && snap.at - last.at < 1000) return;
  arr.push(snap);
  if (arr.length > MAX_SAMPLES) arr.shift();
  _samples.set(planName, arr);
}

export function clearProgressSamples(planName) { _samples.delete(planName); }
export function getProgressSamples(planName) { return _samples.get(planName) || []; }

/**
 * ETA from what is actually happening right now.
 *
 * Uses a ROLLING window rather than the average since the start: a transfer
 * that has slowed should report a longer ETA immediately, not be flattered by
 * how fast it began. A window with no bytes moved is reported as stalled — an
 * ever-growing number is worse than an honest "not moving".
 *
 * Confidence widens the range when there is little to go on, so an early
 * estimate is visibly rough rather than falsely precise.
 *
 * @returns {{state:string, mbps:number|null, percent:number,
 *            etaMinutes:{low:number,likely:number,high:number}|null,
 *            confidence:string, basis:string}}
 */
export function liveEta(samples = [], { windowSize = 6 } = {}) {
  const total = samples[samples.length - 1]?.total || 0;
  const bytes = samples[samples.length - 1]?.bytes || 0;
  const percent = total ? Math.min(100, Math.round((bytes / total) * 100)) : 0;

  if (samples.length < 2) {
    return { state: "measuring", mbps: null, percent, etaMinutes: null,
      confidence: "none", basis: "Waiting for a second progress reading before an ETA can be measured." };
  }

  const win = samples.slice(-Math.max(2, windowSize));
  const first = win[0], last = win[win.length - 1];
  const secs = (last.at - first.at) / 1000;
  const moved = last.bytes - first.bytes;

  if (secs <= 0) {
    return { state: "measuring", mbps: null, percent, etaMinutes: null, confidence: "none", basis: "No elapsed time between readings yet." };
  }
  if (moved <= 0) {
    const stalledFor = Math.round(secs / 60);
    return {
      state: "stalled", mbps: 0, percent, etaMinutes: null, confidence: "n/a",
      basis: `No data has moved for about ${stalledFor} minute${stalledFor === 1 ? "" : "s"}. Check the transfer pod and the source platform before trusting any estimate.`,
    };
  }
  if (bytes >= total && total > 0) {
    return { state: "complete", mbps: null, percent: 100, etaMinutes: { low: 0, likely: 0, high: 0 }, confidence: "measured", basis: "Transfer complete." };
  }

  const mbps = moved / 1048576 / secs;                       // MiB/s, right now
  const remainingMiB = Math.max(0, (total - bytes) / 1048576);
  const likely = remainingMiB / mbps / 60;

  // The more of the transfer we have watched, the tighter the range deserves
  // to be. Early on, say so instead of implying precision we do not have.
  const watched = samples.length;
  const spread = watched >= 20 ? 0.15 : watched >= 8 ? 0.3 : 0.5;
  const confidence = watched >= 20 ? "high" : watched >= 8 ? "medium" : "low";

  const round = (n) => Math.max(0, Math.round(n));
  return {
    state: "transferring",
    mbps: Math.round(mbps * 10) / 10,
    percent,
    etaMinutes: { low: round(likely * (1 - spread)), likely: round(likely), high: round(likely * (1 + spread)) },
    confidence,
    basis: `Measured over the last ${Math.round(secs / 60) || 1} minute(s) at ${Math.round(mbps)} MiB/s${
      confidence === "low" ? " — still early, so this will sharpen as the transfer runs." : "."}`,
  };
}


// ---------------------------------------------------------------------------
// 2e. Fleet analysis — the overall picture before anyone selects anything
// ---------------------------------------------------------------------------
/**
 * Roll a discovered fleet up into what a person needs to decide a wave: how
 * many can move cleanly, how many need attention, what they run, and how much
 * data is involved.
 *
 * Pure, so the aggregation is tested. Support level is the ONLY thing that
 * decides a VM's status — MTV's Critical concerns and the guest OS matrix both
 * feed it, and the worse of the two wins.
 */
export function analyseFleet(vms = [], { targetFreeGiB = null, capacity = null, cpuAllocationRatio = null } = {}) {
  const RANK = { supported: 0, caveats: 1, unknown: 2, unsupported: 3 };
  const rows = vms.map((v) => {
    const support = assessSupportability(v, { targetFreeGiB, capacity, cpuAllocationRatio });
    const os = v.os || classifyGuestOS(v.guestOS, v.guestId);
    // The worse of "MTV says it will fail" and "the guest is not certified"
    // wins outright — a certified guest does not rescue a blocker, and a
    // concern-free VM running Server 2008 is still not supported.
    const mtvLevel = support.blockers.length ? "unsupported"
      : support.warnings.length ? "caveats" : "supported";
    const level = RANK[os.level] >= RANK[mtvLevel] ? os.level : mtvLevel;
    return {
      name: v.name, id: v.id,
      os, level,
      diskGiB: v.diskGiB || 0,
      memoryGiB: v.memoryGiB || null,
      cpuCount: v.cpuCount || null,
      ips: v.ips || [],
      poweredOn: v.poweredOn === true,
      diskCount: v.diskCount || 0,
      warmEligible: v.warmEligible === true,
      warmBlockedReason: v.warmBlockedReason || null,
      blockers: support.blockers, warnings: support.warnings, notes: support.notes,
      checks: support.checks,
      sourceQoS: support.sourceQoS,
      targetProfile: support.targetProfile,
    };
  });
  // What to change on each machine, attached to the machine — the validation
  // page is read one row at a time.
  for (const r of rows) r.actions = vmRemediation(r);

  const count = (pred) => rows.filter(pred).length;
  const byLevel = {
    supported: count((r) => r.level === "supported"),
    caveats: count((r) => r.level === "caveats"),
    unknown: count((r) => r.level === "unknown"),
    unsupported: count((r) => r.level === "unsupported"),
  };

  // Grouped by family, then by distribution — the two questions actually asked
  // ("how much Windows?" then "which Windows?").
  //
  // Each family also carries its share of the source landscape split by support
  // level, because "how many VMs are blocked" and "how much RAM is blocked" are
  // different numbers and capacity planning needs the second one.
  const zeroLevels = () => ({
    supported: { vms: 0, cpu: 0, memoryGiB: 0, diskGiB: 0 },
    caveats: { vms: 0, cpu: 0, memoryGiB: 0, diskGiB: 0 },
    unknown: { vms: 0, cpu: 0, memoryGiB: 0, diskGiB: 0 },
    unsupported: { vms: 0, cpu: 0, memoryGiB: 0, diskGiB: 0 },
  });
  const addTo = (bucket, r) => {
    bucket.vms++; bucket.cpu += r.cpuCount || 0;
    bucket.memoryGiB += r.memoryGiB || 0; bucket.diskGiB += r.diskGiB || 0;
  };

  const families = {};
  for (const r of rows) {
    const fam = (families[r.os.family] ||= {
      family: r.os.family, total: 0, diskGiB: 0, memoryGiB: 0, cpu: 0,
      levels: zeroLevels(), distros: {},
    });
    fam.total++; fam.diskGiB += r.diskGiB; fam.memoryGiB += r.memoryGiB || 0; fam.cpu += r.cpuCount || 0;
    addTo(fam.levels[r.level], r);
    const d = (fam.distros[r.os.distro] ||= {
      distro: r.os.distro, level: r.os.level, note: r.os.note,
      tier: r.os.tier || null, tierLabel: r.os.tierLabel || null,
      total: 0, diskGiB: 0, memoryGiB: 0, cpu: 0,
      supported: 0, caveats: 0, unknown: 0, unsupported: 0,
    });
    d.total++; d.diskGiB += r.diskGiB; d.memoryGiB += r.memoryGiB || 0; d.cpu += r.cpuCount || 0;
    d[r.level]++;
  }

  return {
    total: rows.length,
    byLevel,
    totalDiskGiB: rows.reduce((n, r) => n + r.diskGiB, 0),
    totalMemoryGiB: rows.reduce((n, r) => n + (r.memoryGiB || 0), 0),
    totalCpu: rows.reduce((n, r) => n + (r.cpuCount || 0), 0),
    poweredOn: count((r) => r.poweredOn),
    warmEligible: count((r) => r.warmEligible),
    families: Object.values(families)
      .map((f) => ({ ...f, distros: Object.values(f.distros).sort((a, b) => b.total - a.total) }))
      .sort((a, b) => b.total - a.total),
    rows,
    matrix: { asOf: SUPPORT_MATRIX.asOf, source: SUPPORT_MATRIX.source, url: SUPPORT_MATRIX.url },
  };
}

/**
 * What to do about ONE machine, in the order it has to be done.
 *
 * A fleet-level finding ("4 Windows VMs need drivers") tells a manager how big
 * the problem is; it does not tell the engineer holding a ticket for one VM
 * what to change. This does. Every action names the machine's own facts, and
 * "required" separates the things that block a migration from the things that
 * merely make it a worse idea.
 *
 * Pure, and tested.
 */
export function vmRemediation(row = {}) {
  const out = [];
  const os = row.os || {};

  // 1. Anything that makes the migration fail. Nothing else matters until it
  //    is cleared — and where the fix lives depends on who raised it.
  //    A source check knows its own fix, so it says it rather than being
  //    flattened into "clear this and re-run discovery".
  for (const b of row.blockers || []) {
    if (b.source === "source-check") continue;               // emitted below
    const onTarget = b.source === "target";
    out.push({
      severity: "critical", required: true,
      title: onTarget ? "Will not schedule on the target cluster" : "Blocked by MTV validation",
      detail: b.message,
      action: onTarget
        ? "Add a node large enough to hold this VM, or reduce the machine's memory before migrating. Copying it first would spend the outage for a VM that then stays Pending."
        : "Clear this on the source VM and re-run discovery, or leave the machine out of the wave.",
    });
  }

  // 1b. Source-side readiness — snapshots, independent disks, RDMs,
  //     passthrough hardware, vTPM, Secure Boot, NIC coverage. Blocking ones
  //     first, then the rest in the order the checks are defined.
  const src = row.checks?.findings || [];
  for (const f of [...src.filter((x) => x.blocks), ...src.filter((x) => !x.blocks)]) {
    out.push({
      severity: f.blocks ? "critical" : f.severity === "info" ? "info" : "warning",
      required: f.blocks || f.required === true,
      title: f.title, detail: f.detail, action: f.action,
    });
  }

  // 2. Target-side warnings — the machine fits the hardware but not today's
  //    free space. Different fix, different urgency, so it is said separately.
  for (const w of (row.warnings || []).filter((x) => x.source === "target")) {
    out.push({
      severity: "warning", required: true, title: "No node has room for this VM today",
      detail: w.message,
      action: "Scale the cluster, free reserved capacity, or schedule this machine into a later wave.",
    });
  }

  // 3. The guest itself. An unsupported OS migrates and then is unsupported —
  //    the expensive surprise if nobody says so before the wave.
  if (os.level === "unsupported") {
    out.push({
      severity: "serious", required: false,
      title: `Upgrade required — ${os.distro} is not certified`,
      detail: os.note || `${os.distro} is not on the OpenShift Virtualization certified guest list.`,
      action: os.upgrade
        ? `Upgrade the guest to ${os.upgrade} before migrating, or accept in writing that this VM runs unsupported.`
        : "Upgrade the guest to a certified release before migrating, or accept in writing that it runs unsupported.",
    });
  } else if (os.level === "caveats") {
    out.push({
      severity: "warning", required: false,
      title: `${os.distro} migrates, but is not fully supported`,
      detail: os.note || "Outside the certified guest list.",
      action: os.upgrade ? `Plan a move to ${os.upgrade}.` : "Confirm your support position for this guest before the wave.",
    });
  } else if (os.family === "unknown") {
    out.push({
      severity: "warning", required: true,
      title: "Guest OS could not be identified",
      detail: "vCenter reports no guest OS, which normally means VMware Tools is not running.",
      action: "Start VMware Tools on the guest and re-run discovery — this VM cannot be assessed until then.",
    });
  }

  // 4. Settings to enable on the source, in the order they bite.
  if (os.family === "windows") {
    out.push({
      severity: "warning", required: true,
      title: "VirtIO drivers needed",
      detail: "Windows has no in-box VirtIO storage driver, so a migrated disk is not bootable without one.",
      action: "Install virtio-win on the guest before migrating, or let MTV inject the drivers during conversion.",
    });
  }
  if (row.warmEligible === false && row.poweredOn) {
    out.push({
      severity: "warning", required: false,
      title: "Changed block tracking is off — warm migration unavailable",
      detail: row.warmBlockedReason
        || `Without CBT the whole ${row.diskGiB || "disk"} GiB copies in one pass with the VM shut down.`,
      action: "Enable CBT on the source VM in vCenter and re-run discovery to unlock warm migration.",
    });
  }
  if (row.diskGiB >= 500 && row.warmEligible === false) {
    out.push({
      severity: "warning", required: false,
      title: `${row.diskGiB} GiB cold copy — size the outage first`,
      detail: "A cold copy of this size keeps the machine down for the whole transfer.",
      action: "Book a maintenance window from the measured estimate on the plan step before scheduling this VM.",
    });
  }

  if (!out.length) {
    const cov = row.checks?.coverage;
    const partial = cov && cov.ran < cov.total;
    out.push({
      severity: "good", required: false, title: "Ready to migrate",
      // Never present an unrun check as a passed one.
      detail: partial
        ? `${cov.ran} of ${cov.total} source checks ran — the rest were not reported by the inventory.`
        : null,
      action: "Certified guest, no MTV concerns and nothing to change on the source.",
    });
  }
  return out;
}

/**
 * Turn an analysis into things a person can actually DO. Deterministic, so the
 * console has a useful answer with no LLM configured and the LLM has a floor it
 * cannot fall below.
 *
 * Every suggestion names the VMs it applies to — advice you cannot act on
 * because you do not know which machines it means is not advice.
 */
export function fleetRemediation(analysis) {
  const out = [];
  const rows = analysis?.rows || [];
  const named = (list, n = 4) => list.slice(0, n).map((r) => r.name).join(", ")
    + (list.length > n ? ` +${list.length - n} more` : "");

  // 1. Hard blockers first — these fail the migration, not just annoy it.
  //    Where the fix lives decides what to say, so source-side and target-side
  //    blockers are never merged into one instruction: "fix it at source" is
  //    useless advice for a VM that is simply too big for every node.
  const isTarget = (r) => r.blockers.some((b) => b.source === "target");
  const blockedTarget = rows.filter((r) => r.blockers.length && isTarget(r));
  const blockedSource = rows.filter((r) => r.blockers.length && !isTarget(r));

  if (blockedTarget.length) {
    out.push({
      severity: "critical", title: `${blockedTarget.length} VM${blockedTarget.length > 1 ? "s" : ""} will not schedule on the target cluster`,
      vms: blockedTarget.map((r) => r.name),
      detail: `${named(blockedTarget)} — ${[...new Set(blockedTarget.flatMap((r) => r.blockers.filter((b) => b.source === "target").map((b) => b.message)))].slice(0, 2).join(" ")}`,
      action: "Add a node large enough to hold the biggest of these, or reduce their memory before migrating. Copying first spends the outage on a VM that then stays Pending.",
    });
  }
  if (blockedSource.length) {
    const reasons = [...new Set(blockedSource.flatMap((r) => r.blockers.map((b) => b.message)))];
    out.push({
      severity: "critical", title: `${blockedSource.length} VM${blockedSource.length > 1 ? "s" : ""} cannot migrate as-is`,
      vms: blockedSource.map((r) => r.name),
      detail: `${named(blockedSource)} — ${reasons.slice(0, 3).join(" ")}`,
      action: "Remove these from the wave, or fix the blocker at source, then re-run discovery.",
    });
  }
  const blocked = [...blockedTarget, ...blockedSource];

  // 2. Guest OS that OpenShift Virtualization does not certify. Migrates, but
  //    unsupported afterwards — the expensive surprise if nobody says it now.
  const uncertified = rows.filter((r) => !r.blockers.length && r.os.level === "unsupported");
  if (uncertified.length) {
    out.push({
      severity: "serious", title: `${uncertified.length} guest OS not certified on OpenShift Virtualization`,
      vms: uncertified.map((r) => r.name),
      detail: `${named(uncertified)} run ${[...new Set(uncertified.map((r) => r.os.distro))].join(", ")}.`,
      action: "These will boot but are outside Red Hat support. Plan an in-place OS upgrade before migrating, or accept them as unsupported in writing.",
    });
  }

  // 3. Windows without VirtIO drivers is the single most common cause of a
  //    migrated VM that will not boot.
  const win = rows.filter((r) => r.os.family === "windows" && !r.blockers.length);
  if (win.length) {
    out.push({
      severity: "warning", title: `${win.length} Windows VM${win.length > 1 ? "s need" : " needs"} VirtIO drivers`,
      vms: win.map((r) => r.name),
      detail: `${named(win)}. Windows has no in-box VirtIO storage driver, so a migrated disk is not bootable without it.`,
      action: "Install virtio-win on each guest BEFORE migrating, or let MTV inject drivers during the conversion step.",
    });
  }

  // 4. Unknown guests are not safe to wave-plan — you are guessing.
  const unknown = rows.filter((r) => r.os.family === "unknown");
  if (unknown.length) {
    out.push({
      severity: "warning", title: `${unknown.length} VM${unknown.length > 1 ? "s" : ""} with no identifiable guest OS`,
      vms: unknown.map((r) => r.name),
      detail: `${named(unknown)} — vCenter reports no guest OS, usually because VMware Tools is not running.`,
      action: "Start VMware Tools and refresh the provider inventory so these can be assessed instead of guessed.",
    });
  }

  // 5. Snapshots are the single most common source-side surprise, and the
  //    cheapest to clear — worth calling out across the fleet, not per VM.
  const snapped = rows.filter((r) => (r.checks?.findings || []).some((f) => f.id === "snapshots"));
  if (snapped.length) {
    out.push({
      severity: "warning", title: `${snapped.length} VM${snapped.length > 1 ? "s have" : " has"} snapshots`,
      vms: snapped.map((r) => r.name),
      detail: `${named(snapped)} — the transfer copies the snapshot chain rather than a flat disk, which is slower and more likely to fail.`,
      action: "Consolidate snapshots in vCenter before the wave, then re-run discovery. This is usually the quickest win in the whole assessment.",
    });
  }

  // 6. Cold-only bulk is where the outage budget actually goes.
  const coldBig = rows.filter((r) => !r.warmEligible && r.diskGiB >= 200 && !r.blockers.length);
  if (coldBig.length) {
    const gib = coldBig.reduce((n, r) => n + r.diskGiB, 0);
    out.push({
      severity: "warning", title: `${coldBig.length} large VM${coldBig.length > 1 ? "s" : ""} can only migrate cold`,
      vms: coldBig.map((r) => r.name),
      detail: `${named(coldBig)} total ${gib} GiB with no changed block tracking, so each stays powered off for its whole copy.`,
      action: "Enable CBT on the source VM to unlock warm migration, or schedule these into a maintenance window sized from the estimate.",
    });
  }

  if (!out.length) {
    out.push({
      severity: "good", title: "No blockers found in this selection",
      vms: rows.map((r) => r.name),
      detail: `All ${rows.length} VM${rows.length === 1 ? "" : "s"} match a supported guest OS and MTV reported no critical concerns.`,
      action: "Continue to grouping and review the plans MTV will accept.",
    });
  }
  return out;
}

/**
 * Fleet-level suggestions. The deterministic set above is always returned; the
 * LLM may add sequencing/wave advice on top, but it cannot remove or contradict
 * a finding — same "model advises, code decides" contract as adviseMigration().
 */
export async function adviseFleet(analysis) {
  const base = fleetRemediation(analysis);
  if (!llmEnabled() || !analysis?.total) return { source: "heuristic", suggestions: base };

  const digest = {
    total: analysis.total, byLevel: analysis.byLevel,
    totalDiskGiB: analysis.totalDiskGiB, warmEligible: analysis.warmEligible,
    families: analysis.families.map((f) => ({
      family: f.family, total: f.total, diskGiB: f.diskGiB,
      distros: f.distros.map((d) => ({ distro: d.distro, level: d.level, total: d.total })),
    })),
  };
  try {
    const r = await classifyJSON({
      system: `You advise a platform team planning a VMware-to-OpenShift Virtualization migration wave.
You are given an ALREADY COMPUTED analysis. Do not re-classify support levels and do not contradict them.
Add at most 3 suggestions about SEQUENCING and RISK that the numbers imply — which group to move first, what to pilot, what to hold back.
Respond ONLY with JSON: {"suggestions":[{"severity":"good|warning|serious|critical","title":"<short>","detail":"<one or two sentences>","action":"<what to do>"}]}`
        + " " + UNTRUSTED_GUARD,
      maxTokens: 700,
      prompt: `Analysis of the selected fleet:\n\n${fenceUntrusted("FLEET_ANALYSIS", JSON.stringify(digest))}`,
    });
    const extra = (Array.isArray(r?.suggestions) ? r.suggestions : []).slice(0, 3)
      .filter((s) => s && typeof s.title === "string" && typeof s.action === "string")
      .map((s) => ({
        severity: ["good", "warning", "serious", "critical"].includes(s.severity) ? s.severity : "warning",
        title: String(s.title).slice(0, 120),
        detail: String(s.detail || "").slice(0, 400),
        action: String(s.action).slice(0, 300),
        vms: [], ai: true,
      }));
    return { source: extra.length ? "ai" : "heuristic", suggestions: [...base, ...extra] };
  } catch (e) {
    return { source: "heuristic", suggestions: base, note: `AI suggestions unavailable: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// 3b. Migration advisor — the one place reasoning genuinely helps
// ---------------------------------------------------------------------------
/**
 * Warm vs cold is the judgement call in a migration: it trades downtime
 * against transfer complexity, and the right answer depends on disk size, what
 * the machine does, and when the window is. That is reasoning, not a rule —
 * so it is the one part of UC-10 the LLM is given.
 *
 * The contract is the same as everywhere else in this product: the model
 * ADVISES, code DECIDES. Its output is clamped by clampAdvice() before it can
 * reach a plan, so a hallucinated "warm" for a VM without changed block
 * tracking is downgraded rather than trusted. It never sees or writes a
 * manifest.
 */
const ADVISOR_SYSTEM = `You advise on virtual machine migrations into OpenShift Virtualization.
For each VM decide "warm" or "cold" and give ONE short sentence of reasoning a platform engineer would accept.

warm  = the VM keeps running while its disks copy; a brief cutover at the end. Needs changed block tracking. Prefer for large disks, business-critical or business-hours workloads.
cold  = the VM is powered off for the whole copy. Simpler and more predictable. Prefer for small disks, already powered-off machines, and anything where a consistent point-in-time copy matters more than uptime (databases especially).

Also state what happens to the SOURCE machine's power during the copy:
  "stays-online"  = the VM keeps serving users while its disks copy (only possible with warm)
  "power-off"     = the VM must be shut down before the copy starts
  "already-off"   = the VM is already powered off, so the migration costs no additional downtime

Respond ONLY with JSON: {"advice":[{"name":"<vm name>","strategy":"warm|cold","power":"stays-online|power-off|already-off","reason":"<one sentence>","risk":"low|medium|high"}]}
No prose outside the JSON. Never invent a VM that was not listed.` + " " + UNTRUSTED_GUARD;

/**
 * What actually happens to the source machine, derived from the strategy and
 * its current power state. This is not a matter of opinion, so it is computed
 * rather than asked for — the model's answer is only ever a cross-check.
 */
export function powerPlan(vm = {}, strategy = "cold") {
  if (vm.poweredOn === false) {
    return { power: "already-off", label: "Already off",
      detail: "The machine is powered off now, so the migration costs no additional downtime." };
  }
  if (strategy === "warm") {
    return { power: "stays-online", label: "Stays online",
      detail: "Keeps serving users while the disks copy. A short cutover at the end is the only downtime." };
  }
  return { power: "power-off", label: "Must power off",
    detail: "A cold copy needs the machine shut down first, and it stays down until the target VM boots." };
}

/**
 * The guardrail. Whatever the model returns, physics wins: a VM that cannot
 * migrate warm is not migrated warm, and a VM that was not offered is dropped.
 * Pure, so the clamping is tested rather than trusted.
 */
export function clampAdvice(advice = [], vms = []) {
  const byName = new Map(vms.map((v) => [v.name, v]));
  const out = [];
  for (const a of advice) {
    const vm = byName.get(a?.name);
    if (!vm) continue;                                   // never invent a VM
    let strategy = a.strategy === "warm" ? "warm" : "cold";
    let reason = String(a.reason || "").slice(0, 220);
    let overridden = false;
    if (strategy === "warm" && vm.warmEligible === false) {
      strategy = "cold";
      overridden = true;
      reason = `${vm.warmBlockedReason || "Warm migration is not possible for this VM."} Recommended cold instead.`;
    }
    out.push({
      name: vm.name, strategy, reason,
      risk: ["low", "medium", "high"].includes(a.risk) ? a.risk : "medium",
      // The model may say what it likes about the power state; what actually
      // happens follows from the strategy and the machine's current state.
      ...powerPlan(vm, strategy),
      overridden,
    });
  }
  return out;
}

/** Deterministic advice, used when no LLM is configured or the call fails. */
export function heuristicAdvice(vms = []) {
  return vms.map((v) => {
    if (!v.warmEligible) {
      // Say what will HAPPEN, not only why warm is unavailable — a bare
      // "No CBT." leaves the operator to work out the consequence themselves.
      const outage = v.diskGiB
        ? `the VM stays powered off while ${v.diskGiB} GiB copies`
        : "the VM stays powered off for the whole copy";
      return {
        name: v.name, strategy: "cold",
        risk: (v.diskGiB || 0) >= 500 ? "high" : (v.diskGiB || 0) >= 200 ? "medium" : "low",
        reason: `${v.warmBlockedReason || "Warm migration is not available for this VM."} Cold is the only option, so ${outage}.`,
        ...powerPlan(v, "cold"),
        overridden: false,
      };
    }
    // Big disks are where downtime actually hurts; small ones are not worth
    // the extra moving parts of an incremental copy. A machine that is already
    // powered off has no uptime left to protect, so cold is simply cheaper.
    const big = (v.diskGiB || 0) >= 200;
    const strategy = v.poweredOn === false ? "cold" : big ? "warm" : "cold";
    return {
      name: v.name,
      strategy,
      risk: (v.diskGiB || 0) >= 500 ? "high" : big ? "medium" : "low",
      reason: v.poweredOn === false
        ? "Already powered off, so a cold copy costs no downtime and avoids the complexity of a cutover."
        : big
          ? `${v.diskGiB} GiB would mean a long outage if copied cold, and this VM supports changed block tracking.`
          : `Only ${v.diskGiB ?? "a few"} GiB — a cold copy is quick and avoids the complexity of a cutover.`,
      ...powerPlan(v, strategy),
      overridden: false,
    };
  });
}

/**
 * Recommend a strategy per VM. Returns the source of the advice so the console
 * can say whether a person is reading a model's opinion or a fixed rule.
 */
export async function adviseMigration(vms = [], { window: maintenanceWindow = null } = {}) {
  const shortlist = vms.slice(0, 40).map((v) => ({
    name: v.name, poweredOn: v.poweredOn, diskGiB: v.diskGiB, diskCount: v.diskCount,
    guestOS: v.guestOS, cpu: v.cpuCount, memoryMB: v.memoryMB,
    changeTrackingEnabled: v.changeTrackingEnabled,
  }));
  if (!shortlist.length) return { source: "none", advice: [] };

  if (!llmEnabled()) return { source: "heuristic", advice: heuristicAdvice(vms) };

  try {
    const r = await classifyJSON({
      system: ADVISOR_SYSTEM,
      maxTokens: 1200,
      prompt: `Advise on migrating these VMs${maintenanceWindow ? ` within this maintenance window: ${maintenanceWindow}` : ""}.\n\n`
        + fenceUntrusted("VM_INVENTORY", JSON.stringify(shortlist)),
    });
    const advice = clampAdvice(Array.isArray(r?.advice) ? r.advice : [], vms);
    // A model that answered for only some VMs must not silently drop the rest.
    const covered = new Set(advice.map((a) => a.name));
    const missing = heuristicAdvice(vms.filter((v) => !covered.has(v.name)));
    return {
      source: advice.length ? "ai" : "heuristic",
      advice: [...advice, ...missing],
      overrides: advice.filter((a) => a.overridden).length,
    };
  } catch (e) {
    return { source: "heuristic", advice: heuristicAdvice(vms), note: `AI advice unavailable: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// 3. Grouping — MTV forces this, so make it explicit rather than surprising
// ---------------------------------------------------------------------------
/**
 * Split a selection into the Plans MTV will actually accept.
 *
 * `warm`, the provider, both maps and the target namespace are PLAN-level in
 * Forklift, so any difference forces another Plan. Pure, and tested: getting
 * this wrong means a Plan the API server rejects, or worse, a silent mix.
 *
 * @param {Array} selection  [{ vm, strategy:"warm"|"cold", storageMap, networkMap, targetNamespace, sourceProvider }]
 * @returns {{groups:Array, errors:Array}}
 */
export function planGroups(selection = []) {
  const errors = [];
  const byKey = new Map();

  for (const s of selection) {
    const vm = s.vm || {};
    if (!vm.id && !vm.name) { errors.push({ message: "A selected VM has neither id nor name." }); continue; }
    const strategy = s.strategy === "warm" ? "warm" : "cold";
    if (strategy === "warm" && vm.warmEligible === false) {
      errors.push({ vm: vm.name, message: `${vm.name} cannot be migrated warm — ${vm.warmBlockedReason || "not eligible"}.` });
      continue;
    }
    // A VM missing any plan-level field is excluded, not grouped with a hole
    // in it — otherwise planGroups returns a group that builds an invalid
    // manifest, and the caller has to remember to check errors first.
    let incomplete = false;
    for (const [field, val] of Object.entries({
      sourceProvider: s.sourceProvider, storageMap: s.storageMap,
      networkMap: s.networkMap, targetNamespace: s.targetNamespace,
    })) {
      if (!val) { errors.push({ vm: vm.name, message: `${vm.name}: ${field} is not set.` }); incomplete = true; }
    }
    if (incomplete) continue;

    // MTV forces the first five: warm/cold, the provider, both maps and the
    // target namespace are all Plan-level. Operating system is ours, and it is
    // added on purpose — Windows and Linux are prepared differently (VirtIO
    // drivers, licensing, often a different team), verified differently, and
    // are almost always cut over in separate windows. A plan that mixes them
    // cannot be handed to either team.
    const osFamily = vm.os?.family || "unknown";
    const key = [s.sourceProvider, strategy, s.storageMap, s.networkMap, s.targetNamespace, osFamily].join("|");
    if (!byKey.has(key)) {
      byKey.set(key, {
        key, strategy, warm: strategy === "warm", osFamily,
        sourceProvider: s.sourceProvider, storageMap: s.storageMap,
        networkMap: s.networkMap, targetNamespace: s.targetNamespace,
        vms: [],
      });
    }
    // Size travels with the VM into the group: the plan's own footprint is
    // what its change request has to quote, not the wave's.
    byKey.get(key).vms.push({ id: vm.id || null, name: vm.name, diskGiB: vm.diskGiB || 0 });
  }

  const groups = [...byKey.values()].map((g, i) => ({
    ...g,
    planName: planNameFor(g, i),
    totalVMs: g.vms.length,
    totalGiB: g.vms.reduce((n, v) => n + (v.diskGiB || 0), 0),
  }));
  return { groups, errors };
}

/** Deterministic, DNS-safe Plan name — the same selection always names alike. */
export function planNameFor(group, index = 0) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const os = group.osFamily && group.osFamily !== "unknown" ? `${group.osFamily}-` : "";
  const base = `mig-${os}${group.strategy}-${group.targetNamespace}-${stamp}`;
  const safe = base.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 48).replace(/^-+|-+$/g, "");
  return index > 0 ? `${safe}-${index + 1}` : safe;
}

// ---------------------------------------------------------------------------
// 4. Manifests
// ---------------------------------------------------------------------------
export function buildPlanManifest(group, { targetProvider }) {
  return {
    apiVersion: "forklift.konveyor.io/v1beta1",
    kind: "Plan",
    metadata: {
      name: group.planName,
      namespace: MTV_NS,
      labels: {
        "app.kubernetes.io/managed-by": "tcs-agentic-ai",
        "tcs.agentic-ai/strategy": group.strategy,
        ...(group.osFamily ? { "tcs.agentic-ai/os-family": group.osFamily } : {}),
      },
      // Forklift's Plan spec carries VM names, not disk sizes. Recording the
      // footprint here means the change request can quote THIS plan's transfer
      // time — even when raised from a fresh session, days later, with the
      // original selection long gone from any browser.
      annotations: {
        "tcs.agentic-ai/total-gib": String(group.totalGiB ?? 0),
        "tcs.agentic-ai/vm-count": String(group.vms.length),
      },
    },
    spec: {
      provider: {
        source: { name: group.sourceProvider, namespace: MTV_NS },
        destination: { name: targetProvider, namespace: MTV_NS },
      },
      map: {
        network: { name: group.networkMap, namespace: MTV_NS },
        storage: { name: group.storageMap, namespace: MTV_NS },
      },
      targetNamespace: group.targetNamespace,
      // Plan-level, not per VM. This is why the selection was grouped.
      warm: group.warm === true,
      vms: group.vms.map((v) => (v.id ? { id: v.id, name: v.name } : { name: v.name })),
    },
  };
}

export function buildMigrationManifest(planName, { cutover = null } = {}) {
  return {
    apiVersion: "forklift.konveyor.io/v1beta1",
    kind: "Migration",
    metadata: {
      name: `${planName}-${Date.now().toString(36)}`,
      namespace: MTV_NS,
      labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
    },
    spec: {
      plan: { name: planName, namespace: MTV_NS },
      // Warm migrations copy continuously and cut over at this moment. Absent
      // means "cut over as soon as the operator asks".
      ...(cutover ? { cutover } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Create / execute
// ---------------------------------------------------------------------------
/** Create the Plans. Creating a Plan moves nothing — MTV validates it first. */
export async function createPlans(groups, { targetProvider, actor = "operator", cluster = "local" } = {}) {
  const created = [], failed = [], terminal = [];
  for (const g of groups) {
    const manifest = buildPlanManifest(g, { targetProvider });
    terminal.push(`$ oc apply -f plan-${g.planName}.yaml -n ${MTV_NS}`);
    try {
      const r = await ocpPost(`/${FORKLIFT}/namespaces/${MTV_NS}/plans`, manifest);
      created.push({ planName: g.planName, uid: r.metadata?.uid || null, strategy: g.strategy, vms: g.vms.length });
      terminal.push(`plan.forklift.konveyor.io/${g.planName} created (${g.vms.length} VM${g.vms.length === 1 ? "" : "s"}, ${g.strategy})`);
      await recordChange({
        cluster, namespace: MTV_NS, resourceKind: "plan", resourceName: g.planName,
        action: "create_migration_plan", command: `oc apply -f plan-${g.planName}.yaml -n ${MTV_NS}`,
        risk: "low", approvedBy: actor,
        // A Plan alone moves nothing, so its inverse is simply removing it.
        revertCommand: `oc delete plan ${g.planName} -n ${MTV_NS}`,
      }).catch(() => {});
    } catch (e) {
      failed.push({ planName: g.planName, error: e.message });
      terminal.push(`Error: ${e.message}`);
    }
  }
  return { ok: failed.length === 0, created, failed, terminal };
}

/** Plan validation verdict — the dry-run equivalent. Creating it moved nothing. */
export async function planStatus(planName) {
  const p = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`).catch(() => null);
  if (!p) return { found: false, planName };
  const c = (t) => cond(p, t);
  return {
    found: true, planName,
    ready: isTrue(p, "Ready"),
    executing: isTrue(p, "Executing"),
    succeeded: isTrue(p, "Succeeded"),
    failed: isTrue(p, "Failed"),
    canceled: isTrue(p, "Canceled"),
    warm: p.spec?.warm === true,
    targetNamespace: p.spec?.targetNamespace || null,
    vmCount: (p.spec?.vms || []).length,
    vmNames: (p.spec?.vms || []).map((v) => v.name || v.id).filter(Boolean),
    totalGiB: Number(p.metadata?.annotations?.["tcs.agentic-ai/total-gib"] || 0) || null,
    // The approval gate travels with the plan, so the console shows the same
    // answer the migrate endpoint will enforce.
    gate: approvalGate(p),
    // Anything MTV objects to — unmapped datastore, missing network, no CBT.
    critical: (p.status?.conditions || [])
      .filter((x) => x.category === "Critical" || (x.type === "Ready" && x.status === "False"))
      .map((x) => `${x.type}${x.reason ? `/${x.reason}` : ""}: ${x.message || ""}`.trim()),
    vms: (p.status?.migration?.vms || []).map(normalisePlanVM),
  };
}

/**
 * Plan status WITH a live, measured ETA. Every call adds a progress sample, so
 * simply polling this endpoint is what makes the estimate sharpen over time.
 */
export async function planStatusWithEta(planName) {
  const status = await planStatus(planName);
  if (!status.found) return status;
  const snap = progressSnapshot(status);
  if (status.executing || snap.bytes > 0) recordProgressSample(planName, snap);
  return {
    ...status,
    progress: { bytes: snap.bytes, total: snap.total, activeVMs: snap.activeVMs },
    eta: liveEta(getProgressSamples(planName)),
  };
}

function normalisePlanVM(v) {
  const pipeline = (v.pipeline || []).map((s) => ({
    name: s.name, phase: s.phase,
    progress: s.progress ? { completed: s.progress.completed, total: s.progress.total } : null,
  }));
  const done = pipeline.filter((s) => s.phase === "Completed").length;
  const err = (v.error?.reasons || []).join("; ") || v.error?.phase || null;
  return {
    id: v.id || null, name: v.name,
    phase: v.phase || "Pending",
    started: v.started || null, completed: v.completed || null,
    steps: pipeline, stepsDone: done, stepsTotal: pipeline.length,
    percent: pipeline.length ? Math.round((done / pipeline.length) * 100) : 0,
    error: err,
    failed: !!err || /Failed|Canceled/i.test(v.phase || ""),
  };
}

// ---------------------------------------------------------------------------
// 5b. Change-request gate
// ---------------------------------------------------------------------------
/**
 * Approval state lives on the Plan itself, as annotations.
 *
 * Not in memory, and not in the browser: a migration is approved once and may
 * be started hours later, by a different person, after a pod restart. The
 * cluster already holds the Plan, so it holds the approval too — refresh the
 * console, restart the server, come back tomorrow, the gate is where you left
 * it. It is also visible to anyone with `oc get plan -o yaml`, which an
 * in-memory gate never is.
 */
const CR_ANN = {
  number: "tcs.agentic-ai/change-request",
  sysId: "tcs.agentic-ai/change-request-sys-id",
  state: "tcs.agentic-ai/change-request-state",   // submitted | approved | rejected | cancelled
  at: "tcs.agentic-ai/change-request-checked-at",
};

/** Approval is required unless an operator has deliberately turned it off. */
export function approvalRequired() {
  return process.env.MIGRATION_REQUIRE_APPROVAL !== "false";
}

async function annotatePlan(planName, annotations) {
  return ocpPatch(
    `/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`,
    { metadata: { annotations } },
    "application/merge-patch+json",
  );
}

/** The gate, read from the cluster. Pure of side effects — it only looks. */
export function approvalGate(plan) {
  const a = plan?.metadata?.annotations || {};
  const number = a[CR_ANN.number] || null;
  const state = a[CR_ANN.state] || (number ? "submitted" : "none");
  return {
    required: approvalRequired(),
    number, sysId: a[CR_ANN.sysId] || null, state,
    checkedAt: a[CR_ANN.at] || null,
    approved: state === "approved",
    // Say what to do next rather than only what is wrong.
    next: state === "approved" ? "Approved — the migration can be started."
      : state === "rejected" ? "Rejected in ServiceNow. Raise a new change request if the plan has changed."
      : state === "cancelled" ? "Cancelled in ServiceNow. Raise a new change request to proceed."
      : number ? `${number} is awaiting approval.`
      : "Raise a change request before this migration can start.",
  };
}

/**
 * What this cluster actually achieves, measured from migrations it has already
 * completed. Lives here rather than in the route so the change request and the
 * console quote the same number.
 */
export async function clusterThroughput() {
  const plans = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans`).catch(() => ({ items: [] }));
  const history = [];
  for (const p of plans.items || []) {
    for (const v of p.status?.migration?.vms || []) {
      if (v.started && v.completed) history.push({ diskGiB: v.diskGiB || null, startedAt: v.started, completedAt: v.completed });
    }
  }
  return observedThroughput(history);
}

/**
 * The transfer estimate for ONE plan, from its own recorded footprint.
 *
 * Not the wave's: a wave that splits into two cold plans would otherwise put
 * the combined figure on both change requests, and a CAB approving an outage
 * is entitled to the number for the work in front of it.
 */
export async function estimatePlan(plan) {
  const ann = plan?.metadata?.annotations || {};
  const totalGiB = Number(ann["tcs.agentic-ai/total-gib"] || 0);
  const vmCount = Number(ann["tcs.agentic-ai/vm-count"] || (plan?.spec?.vms || []).length || 0);
  if (!totalGiB || !vmCount) return null;          // never invent a size
  const tp = await clusterThroughput();
  // estimateMigration works per VM; the plan only knows its total, so it is
  // spread evenly. The sum is what matters for wall clock, and the live ETA
  // replaces this the moment bytes actually move.
  const each = totalGiB / vmCount;
  const vms = Array.from({ length: vmCount }, (_, i) => ({ name: `vm${i}`, diskGiB: each }));
  return {
    ...estimateMigration(vms, {
      strategy: plan?.spec?.warm ? "warm" : "cold",
      throughputMBps: tp.mbps,
      concurrency: Math.min(2, vmCount),
    }),
    totalGiB,
    measured: tp.samples > 0,
    samples: tp.samples,
  };
}

/** Raise the CR for a plan and record it on the Plan. */
export async function raiseMigrationCR(planName, { actor = "operator", cluster = "local" } = {}) {
  const plan = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`).catch(() => null);
  if (!plan) return { ok: false, error: `Plan "${planName}" not found.` };

  const existing = approvalGate(plan);
  if (existing.number && existing.state !== "rejected" && existing.state !== "cancelled") {
    return { ok: true, alreadyRaised: true, gate: existing, message: `${existing.number} already exists for this plan.` };
  }

  const vms = (plan.spec?.vms || []).map((v) => v.name || v.id);
  const warm = plan.spec?.warm === true;
  const osFamily = plan.metadata?.labels?.["tcs.agentic-ai/os-family"] || null;
  // The CAB is approving an outage, so the change record carries the numbers
  // they actually need: how long these machines are down, not only how long the
  // copy runs — and computed from THIS plan's footprint, not the wave's.
  const est = await estimatePlan(plan).catch(() => null);
  const window = est
    ? [
        `Data to move       : ${est.totalGiB} GiB`,
        `Estimated transfer : ${est.wallClockMinutes.likely} min (${est.wallClockMinutes.low}-${est.wallClockMinutes.high})`,
        `Estimated downtime : ${est.downtimeMinutes.likely} min (${est.downtimeMinutes.low}-${est.downtimeMinutes.high})`,
        `Basis              : ${est.throughputMBps} MiB/s ${est.measured ? `measured from ${est.samples} completed migration(s) on this cluster` : "(conservative default — this cluster has completed no migrations yet)"}. ${est.note || ""}`.trim(),
      ].join("\n")
    : "Transfer time will be measured live once the migration starts.";

  let cr;
  try {
    const { createChangeRequest } = await import("../utils/servicenow-client.js");
    cr = await createChangeRequest({
      shortDescription: `Migrate ${vms.length} ${osFamily && osFamily !== "unknown" ? `${osFamily} ` : ""}VM(s) to OpenShift Virtualization (${warm ? "warm" : "cold"}): ${vms.slice(0, 4).join(", ")}${vms.length > 4 ? ` +${vms.length - 4}` : ""}`,
      description: [
        `Plan            : ${planName}`,
        `Strategy        : ${warm ? "warm — source stays online, short cutover" : "cold — source powered off for the whole copy"}`,
        osFamily ? `Operating system: ${osFamily}` : null,
        `Target namespace: ${plan.spec?.targetNamespace || "unspecified"}`,
        `Storage map     : ${plan.spec?.map?.storage?.name || "unspecified"}`,
        `Network map     : ${plan.spec?.map?.network?.name || "unspecified"}`,
        `Virtual machines: ${vms.join(", ")}`,
        "",
        window,
        "",
        "The source VMs are NOT deleted by this migration.",
      ].filter(Boolean).join("\n"),
      type: "normal",
      category: "Infrastructure",
      risk: warm ? "moderate" : "high",
      implementationPlan: `oc apply -f migration-${planName}.yaml -n ${MTV_NS}`,
      backoutPlan: [
        `oc delete migration -l plan=${planName} -n ${MTV_NS}`,
        `oc delete virtualmachine <migrated names> -n ${plan.spec?.targetNamespace || "<target>"}`,
        "Power the source VMs back on in vCenter. They were never deleted.",
      ].join("\n"),
      testPlan: `oc get vm -n ${plan.spec?.targetNamespace || "<target>"}; confirm each VM boots, has its IP, and its application answers.`,
    });
  } catch (e) {
    return { ok: false, error: `Could not raise the change request: ${e.message}` };
  }

  const rec = cr?.result || cr || {};
  const number = rec.number || null;
  if (!number) return { ok: false, error: "ServiceNow accepted the request but returned no change number." };

  await annotatePlan(planName, {
    [CR_ANN.number]: number,
    [CR_ANN.sysId]: rec.sys_id || "",
    [CR_ANN.state]: "submitted",
    [CR_ANN.at]: new Date().toISOString(),
  });
  await recordChange({
    cluster, namespace: MTV_NS, resourceKind: "plan", resourceName: planName,
    action: "raise_migration_change_request", command: `# ServiceNow ${number}`,
    risk: "low", approvedBy: actor,
  }).catch(() => {});

  return { ok: true, number, sysId: rec.sys_id || null, gate: { ...approvalGate({ metadata: { annotations: { [CR_ANN.number]: number, [CR_ANN.state]: "submitted" } } }) } };
}

/** Ask ServiceNow where the CR stands and write the answer back onto the Plan. */
export async function checkMigrationApproval(planName) {
  const plan = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`).catch(() => null);
  if (!plan) return { ok: false, error: `Plan "${planName}" not found.` };
  const gate = approvalGate(plan);
  if (!gate.number) return { ok: true, gate, note: "No change request has been raised for this plan yet." };
  if (gate.state === "approved") return { ok: true, gate, note: `${gate.number} is approved.` };

  let record;
  try {
    const { getRecord } = await import("../utils/servicenow-client.js");
    const cr = await getRecord("change_request", gate.sysId || gate.number);
    record = cr?.result || cr;
  } catch (e) {
    // Say WHY the lookup failed — an asleep instance and a rejected change are
    // very different things and must never look the same on screen.
    return { ok: false, gate, error: `Could not read ${gate.number} from ServiceNow: ${e.message}` };
  }
  if (!record) return { ok: false, gate, error: `ServiceNow returned no record for ${gate.number}.` };

  const verdict = readMigrationApproval(record);
  if (verdict !== gate.state) {
    await annotatePlan(planName, { [CR_ANN.state]: verdict, [CR_ANN.at]: new Date().toISOString() }).catch(() => {});
  }
  const next = approvalGate({ metadata: { annotations: {
    [CR_ANN.number]: gate.number, [CR_ANN.sysId]: gate.sysId || "", [CR_ANN.state]: verdict,
  } } });
  return {
    ok: true, gate: next,
    detail: { number: gate.number, approval: record.approval || null, state: record.state || null },
    note: next.next,
  };
}

/**
 * Read a ServiceNow change record's verdict. Pure, so the mapping is tested —
 * getting this wrong either blocks an approved migration or, far worse, lets an
 * unapproved one through.
 */
export function readMigrationApproval(record = {}) {
  const approval = String(record.approval || "").toLowerCase();
  const state = String(record.state || "").toLowerCase();
  if (approval === "rejected") return "rejected";
  if (state === "4" || /cancel/.test(state)) return "cancelled";
  // "Scheduled" (-2), "Implement" (-1) and "Review" (0) all mean the CAB has
  // signed off and the work may proceed.
  if (approval === "approved" || ["-2", "-1", "0"].includes(state) || /implement|scheduled|review/.test(state)) return "approved";
  return "submitted";
}

/** Execute an approved Plan. This is the point where data starts moving. */
export async function startMigration(planName, { cutover = null, actor = "operator", cluster = "local" } = {}) {
  const st = await planStatus(planName);
  if (!st.found) return { ok: false, error: `Plan "${planName}" not found.` };
  if (!st.ready) return { ok: false, error: `Plan "${planName}" is not Ready — MTV has not validated it.`, critical: st.critical };

  // The approval gate. Read from the cluster on every start, not from whatever
  // the browser last believed — the button being enabled is not authorisation.
  if (approvalRequired()) {
    const plan = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`).catch(() => null);
    const gate = approvalGate(plan);
    if (!gate.approved) {
      return { ok: false, gate, error: `Migration is not approved. ${gate.next}` };
    }
  }

  const manifest = buildMigrationManifest(planName, { cutover });
  try {
    const r = await ocpPost(`/${FORKLIFT}/namespaces/${MTV_NS}/migrations`, manifest);
    await recordChange({
      cluster, namespace: MTV_NS, resourceKind: "migration", resourceName: manifest.metadata.name,
      action: "start_vm_migration", command: `oc apply -f migration-${planName}.yaml -n ${MTV_NS}`,
      risk: "high", approvedBy: actor,
      revertCommand: `# cancel: oc delete migration ${manifest.metadata.name} -n ${MTV_NS}; then delete migrated VMs and power the source back on`,
    }).catch(() => {});
    return { ok: true, migrationName: manifest.metadata.name, planName, uid: r.metadata?.uid || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 6. Rollback — the way back, at every stage
// ---------------------------------------------------------------------------
/**
 * What rolling back MEANS depends on how far the migration got, and pretending
 * otherwise is how people lose data. Pure, so the decision can be tested.
 *
 * The invariant that makes any of this safe: MTV powers the source VM off for a
 * cold migration, it does not delete it. This platform never deletes a source
 * VM either. Rollback is therefore always possible — the cost is only how much
 * transferred work is discarded.
 *
 * @returns {{stage:string, reversible:boolean, actions:Array, sourceAction:string|null, warning:string|null}}
 */
export function rollbackPlan(status) {
  const anyStarted = (status?.vms || []).some((v) => v.started);
  const anyCompleted = (status?.vms || []).some((v) => /Completed|Succeeded/i.test(v.phase || ""));

  if (!status?.found) {
    return { stage: "unknown", reversible: false, actions: [], sourceAction: null, warning: "Plan not found — nothing to roll back." };
  }
  if (status.succeeded || anyCompleted) {
    return {
      stage: "migrated",
      reversible: true,
      actions: [
        "Delete the VirtualMachines this plan created in the target namespace",
        "Archive the plan so it cannot be re-run by accident",
      ],
      sourceAction: "Power the source VM(s) back on in the source platform. MTV powered them off for cutover; it did not delete them.",
      warning: "The migrated disks are discarded. Any data written INSIDE the migrated VM since cutover is lost — confirm nobody has started using it.",
    };
  }
  if (status.executing || anyStarted) {
    return {
      stage: status.warm ? "transferring-warm" : "transferring-cold",
      reversible: true,
      actions: [
        "Cancel the running migration",
        "Delete any partially created target VMs and their disks",
      ],
      sourceAction: status.warm
        ? "None — a warm migration has not cut over, so the source VM is still running and serving."
        : "Power the source VM(s) back on. A cold migration powered them off at the start.",
      warning: "Transferred data is discarded; a restarted migration copies from the beginning.",
    };
  }
  return {
    stage: "planned",
    reversible: true,
    actions: ["Delete the plan"],
    sourceAction: null,
    warning: null,
  };
}

/**
 * Execute the rollback. Deletes ONLY what this plan created — target VMs whose
 * provenance says they came from this plan — and never touches the source.
 */
export async function rollbackMigration(planName, { deleteTargetVMs = true, actor = "operator", cluster = "local" } = {}) {
  const status = await planStatus(planName);
  const decision = rollbackPlan(status);
  if (!status.found) return { ok: false, error: `Plan "${planName}" not found.`, decision };

  const terminal = [], deleted = [], failed = [];

  // 1. Stop anything in flight.
  const migs = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/migrations`).catch(() => ({ items: [] }));
  for (const m of (migs.items || []).filter((x) => x.spec?.plan?.name === planName)) {
    terminal.push(`$ oc delete migration ${m.metadata.name} -n ${MTV_NS}`);
    try { await ocpDelete(`/${FORKLIFT}/namespaces/${MTV_NS}/migrations/${m.metadata.name}`); deleted.push(`migration/${m.metadata.name}`); }
    catch (e) { failed.push({ target: `migration/${m.metadata.name}`, error: e.message }); }
  }

  // 2. Remove the VMs this plan produced, in the target namespace only.
  if (deleteTargetVMs && status.targetNamespace) {
    for (const v of status.vms || []) {
      if (!v.name) continue;
      terminal.push(`$ oc delete vm ${v.name} -n ${status.targetNamespace}`);
      try {
        await ocpDelete(`/apis/kubevirt.io/v1/namespaces/${status.targetNamespace}/virtualmachines/${v.name}`);
        deleted.push(`virtualmachine/${v.name}`);
      } catch (e) {
        if (/404|NotFound/i.test(e.message)) terminal.push(`# ${v.name} was not created — nothing to remove`);
        else failed.push({ target: `virtualmachine/${v.name}`, error: e.message });
      }
    }
  }

  // 3. Retire the plan so it cannot be re-run by accident.
  terminal.push(`$ oc delete plan ${planName} -n ${MTV_NS}`);
  try { await ocpDelete(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`); deleted.push(`plan/${planName}`); }
  catch (e) { failed.push({ target: `plan/${planName}`, error: e.message }); }

  await recordChange({
    cluster, namespace: MTV_NS, resourceKind: "plan", resourceName: planName,
    action: "rollback_vm_migration", command: `rollback ${planName}`,
    risk: "high", approvedBy: actor,
  }).catch(() => {});

  return {
    ok: failed.length === 0,
    planName, decision, deleted, failed, terminal,
    // Said last because it is the part the platform cannot do for you.
    sourceAction: decision.sourceAction,
    message: decision.sourceAction
      ? `Rolled back. ONE MANUAL STEP REMAINS: ${decision.sourceAction}`
      : "Rolled back. The source VMs were never touched.",
  };
}

// ---------------------------------------------------------------------------
// 7. Post-migration verification
// ---------------------------------------------------------------------------
/**
 * Migrated is not running. Reuses the VM phase classifier so a migrated machine
 * is judged by exactly the same rules as a provisioned one.
 */
export async function verifyMigration(planName) {
  const status = await planStatus(planName);
  if (!status.found) return { ok: false, error: `Plan "${planName}" not found.` };
  const { vmRuntimeStatus } = await import("./vm-provisioning.js");
  const names = (status.vms || []).map((v) => v.name).filter(Boolean);
  if (!names.length || !status.targetNamespace) {
    return { ok: false, planName, error: "No migrated VMs to verify yet." };
  }
  const runtime = await vmRuntimeStatus(status.targetNamespace, names);
  return {
    ok: runtime.allRunning,
    planName, namespace: status.targetNamespace,
    ...runtime,
    note: runtime.allRunning
      ? "Every migrated VM is running. The source VMs are still powered off — raise a decommission request when you are satisfied."
      : "Not every migrated VM is running yet.",
  };
}
