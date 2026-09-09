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
import { classifyJSON, classifyJSONWithMeta, llmEnabled } from "./llm.js";
import { fenceUntrusted, UNTRUSTED_GUARD } from "./untrusted.js";

const FORKLIFT = "apis/forklift.konveyor.io/v1beta1";
const KUBEVIRT = "apis/kubevirt.io/v1";
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
    // The VDDK init image: optional in MTV, strongly recommended by Red Hat,
    // and a hard requirement for anything on vSAN. Read from the provider we
    // are already fetching, so detecting it costs nothing.
    vddkImage: p.spec?.settings?.vddkInitImage || null,
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
// 2b-2. VDDK — the single biggest lever on transfer speed
// ---------------------------------------------------------------------------
/**
 * MTV can migrate from vSphere with or without the VMware VDDK init image.
 * Red Hat's guidance is unambiguous: create one. It accelerates the transfer
 * and reduces the risk of a plan failing — and a VM backed by vSAN will not
 * migrate without it at all.
 *
 * The agent detects whether it is configured, and shows both estimates so the
 * choice is a number rather than a doc link. What it will NOT do is invent the
 * speed difference: the ratio is a named, printed assumption until this cluster
 * has measured its own, exactly like the transfer estimate itself.
 *
 * Default 3, overridable with MTV_VDDK_SPEEDUP.
 */
/** Whether a source provider has a VDDK init image set. */
export async function providerVddk(uid) {
  const list = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/providers`).catch(() => ({ items: [] }));
  const p = (list.items || []).find((x) => x.metadata?.uid === uid || x.metadata?.name === uid);
  const image = p?.spec?.settings?.vddkInitImage || null;
  // "Not found" is not "not configured" — an unreachable provider must not be
  // reported as one without a VDDK image.
  return { found: !!p, configured: p ? !!image : null, image };
}

export function vddkSpeedup() {
  const n = Number(process.env.MTV_VDDK_SPEEDUP);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

/**
 * The same wave costed both ways. Pure.
 *
 * `measured` throughput was achieved under whatever configuration is in force
 * today, so it is the WITH figure when VDDK is configured and the WITHOUT
 * figure when it is not — deriving the other one from it, rather than assuming
 * the measurement applies to both.
 *
 * @param {Array} vms
 * @param {{strategy, throughputMBps, concurrency, vddkConfigured}} opts
 */
export function vddkComparison(vms = [], {
  strategy = "cold", throughputMBps = null, concurrency = 2, vddkConfigured = false,
} = {}) {
  const ratio = vddkSpeedup();
  // The rate in hand — measured, or the conservative default — describes the
  // configuration IN FORCE. The other side is derived from it.
  //
  // Passing null through for the unmeasured case was a bug: estimateMigration
  // substitutes the same default for both, so the two columns came out
  // identical and a real difference looked like no difference at all.
  const base = throughputMBps || DEFAULT_MBPS;
  const withMBps = vddkConfigured ? base : base * ratio;
  const withoutMBps = vddkConfigured ? base / ratio : base;

  const est = (mbps) => estimateMigration(vms, { strategy, throughputMBps: mbps, concurrency });
  return {
    configured: vddkConfigured,
    ratio,
    inUse: vddkConfigured ? "with" : "without",
    withVddk: est(withMBps),
    withoutVddk: est(withoutMBps),
    // Said plainly, because it is the whole point of showing two numbers.
    measured: throughputMBps != null,
    basis: throughputMBps == null
      ? `No completed migration on this cluster yet, so the ${vddkConfigured ? "with" : "without"}-VDDK figure is a conservative default of ${DEFAULT_MBPS} MiB/s and the other is derived from it.`
      : vddkConfigured
        ? `Measured on this cluster WITH VDDK. The without-VDDK figure divides it by an assumed ${ratio}×.`
        : `Measured on this cluster WITHOUT VDDK. The with-VDDK figure multiplies it by an assumed ${ratio}×.`,
    // Red Hat is explicit that VDDK matters and publishes no number for it.
    // Quoting them, rather than implying a figure they never gave.
    assumption: `Red Hat states that using MTV without VDDK "is not recommended and could result in significantly lower migration speeds", but publishes no throughput figure. The ${ratio}× ratio here is therefore an assumption — set MTV_VDDK_SPEEDUP to match what you measure.`,
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
/** Cutover cost per VM that does not depend on how fast the disks copied. */
const WARM_CUTOVER_MIN_PER_VM = 6;
/** …plus the delta the guest wrote while the copy ran. An assumption, named. */
const WARM_DELTA_FRACTION = 0.05;

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
    // Warm copies while the VM runs, so downtime is the cutover — but not a
    // flat number: the cutover has to copy whatever the guest wrote DURING the
    // transfer, so a slower link means a bigger delta to catch up on. Mostly
    // fixed, slightly rate-sensitive. The fraction is an assumption; the shape
    // is not, and a flat figure made a 3x slower link look free.
    ? (vms.length || 0) * WARM_CUTOVER_MIN_PER_VM + transferMin * WARM_DELTA_FRACTION
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
export function liveEta(samples = [], { windowSize = 6, awaitingCutover = false } = {}) {
  // A warm precopy that has finished moves no bytes, and that is success, not a
  // fault. Checked before anything else: the stall branch below cannot tell the
  // two apart from byte counts alone, and calling this one "stalled" sends
  // someone to debug a transfer pod that is doing exactly what it should.
  if (awaitingCutover) {
    const last = samples[samples.length - 1];
    const percent = last?.total ? Math.min(100, Math.round((last.bytes / last.total) * 100)) : 100;
    return {
      state: "awaiting-cutover", mbps: null, percent, etaMinutes: null, confidence: "n/a",
      basis: "The disks are copied. MTV is refreshing changed blocks while the guest keeps running, and waits for a cutover to be scheduled.",
    };
  }
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
  // Completion is checked BEFORE the stall: a transfer that has copied every
  // byte also moves no bytes, and the stall branch below cannot tell the two
  // apart. Checked the other way round — as it was — a finished migration
  // reported itself stalled for as long as anyone kept polling it.
  if (bytes >= total && total > 0) {
    return { state: "complete", mbps: null, percent: 100, etaMinutes: { low: 0, likely: 0, high: 0 }, confidence: "measured", basis: "Transfer complete." };
  }
  if (moved <= 0) {
    const stalledFor = Math.round(secs / 60);
    return {
      state: "stalled", mbps: 0, percent, etaMinutes: null, confidence: "n/a",
      basis: `No data has moved for about ${stalledFor} minute${stalledFor === 1 ? "" : "s"}. Check the transfer pod and the source platform before trusting any estimate.`,
    };
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
  // How long this transfer has been running, so a revised TOTAL can be stated
  // rather than only a remaining figure.
  const elapsedMinutes = round((last.at - samples[0].at) / 60000);
  return {
    state: "transferring",
    mbps: Math.round(mbps * 10) / 10,
    percent, elapsedMinutes, samples: watched,
    etaMinutes: { low: round(likely * (1 - spread)), likely: round(likely), high: round(likely * (1 + spread)) },
    confidence,
    basis: `Measured over the last ${Math.round(secs / 60) || 1} minute(s) at ${Math.round(mbps)} MiB/s${
      confidence === "low" ? " — still early, so this will sharpen as the transfer runs." : "."}`,
  };
}


/**
 * The forecast, judged against the transfer that is actually happening.
 *
 * A pre-flight estimate is only as good as the throughput it assumed. Once
 * bytes are moving, the migration is telling you what this source, this
 * network and this storage really do — and if that is a third of what was
 * assumed, the useful moment to find out is now, while someone can still tell
 * the change board, not afterwards.
 *
 * It also closes the loop the estimate opens: the measured rate is the number
 * that should replace the default on the next assessment, so the tool stops
 * guessing and starts remembering.
 *
 * Pure.
 *
 * @param {{mbps:number, minutes:number}|null} planned  stamped on the Plan at creation
 * @param {object} live  liveEta() output
 */
export function estimateVsActual(planned, live) {
  // Nothing to compare against a stalled, finished or not-yet-measured transfer.
  if (!planned?.mbps || !live || live.state !== "transferring" || !live.mbps) return null;

  const ratio = live.mbps / planned.mbps;
  const elapsed = live.elapsedMinutes || 0;
  const remaining = live.etaMinutes?.likely ?? 0;
  const revisedMinutes = elapsed + remaining;
  const plannedMinutes = planned.minutes ?? null;

  const verdict = ratio >= 1.15 ? "ahead"
    : ratio >= 0.85 ? "on-track"
    : ratio >= 0.5 ? "behind"
    : "far-behind";

  const times = (n) => `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}×`;
  const early = live.confidence === "low" ? "Early reading — " : "";
  const message = early + (verdict === "on-track"
    ? `Running at the rate the estimate assumed (${live.mbps} MiB/s).`
    : verdict === "ahead"
      ? `Running ${times(ratio)} faster than the estimate assumed${plannedMinutes ? ` — expect about ${revisedMinutes} min in total rather than ${plannedMinutes}` : ""}.`
      : `Running at ${times(ratio)} the assumed rate${plannedMinutes ? ` — expect about ${revisedMinutes} min in total rather than ${plannedMinutes}` : ""}.`);

  // Only suggest recalibrating once the measurement has earned it. Rewriting a
  // cluster-wide default from four samples would be worse than the default.
  const trustworthy = live.confidence === "medium" || live.confidence === "high";
  const materially = Math.abs(ratio - 1) > 0.25;
  return {
    verdict, ratio: Math.round(ratio * 100) / 100,
    plannedMbps: planned.mbps, actualMbps: live.mbps,
    plannedMinutes, revisedMinutes, elapsedMinutes: elapsed,
    confidence: live.confidence,
    message,
    calibration: trustworthy && materially
      ? {
          setting: "MTV_DEFAULT_MBPS",
          value: Math.max(1, Math.round(live.mbps)),
          reason: `This cluster is achieving ${live.mbps} MiB/s, not the ${planned.mbps} MiB/s the estimate assumed. Setting MTV_DEFAULT_MBPS=${Math.max(1, Math.round(live.mbps))} makes the next assessment start from what actually happens here.`,
        }
      : null,
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
export function fleetRemediation(analysis, opts = {}) {
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

  // 4b. No VDDK is not a style preference: it is slower, less reliable, and a
  //     hard stop for anything on vSAN.
  if (opts.vddkConfigured === false) {
    out.push({
      severity: "serious", title: "No VDDK image is configured on the source provider",
      vms: rows.map((r) => r.name),
      detail: "Red Hat recommends a VDDK init image for vSphere: it accelerates the transfer and reduces the risk of a plan failing. A VM backed by vSAN will not migrate without it at all.",
      action: "Build the VDDK init image and set it on the provider before the wave. If any of these machines are on vSAN storage, this is a blocker rather than a slow path.",
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
 * What the AI cost, and what it was allowed to decide.
 *
 * A change board approving a migration is entitled to know which parts of the
 * assessment a model touched, and an auditor asking a year later needs the same
 * answer. This is that record: the model consulted, how many times, at what
 * token cost, how many of its recommendations policy overruled — and, stated
 * explicitly, the things it did NOT decide.
 *
 * Pure, so the number quoted in a change record is tested.
 *
 * @param {Array} usages  the `usage` objects from adviseMigration / adviseFleet
 * @param {{overrides:number, source:string}} extra
 */
export function aiProvenance(usages = [], { overrides = 0, adviceSource = null, suggestionSource = null } = {}) {
  const used = usages.filter(Boolean);
  const ok = used.filter((u) => u.ok);
  const sum = (k) => used.reduce((n, u) => n + (u[k] || 0), 0);
  // Tokens are only summed where the provider actually reported them; a null
  // total is reported as unknown rather than silently counted as zero.
  const reported = used.filter((u) => u.totalTokens != null);

  const consulted = ok.length > 0;
  return {
    consulted,
    calls: used.length,
    succeeded: ok.length,
    failed: used.length - ok.length,
    provider: used[0]?.provider || null,
    model: used[0]?.model || null,
    promptTokens: reported.length ? sum("promptTokens") : null,
    completionTokens: reported.length ? sum("completionTokens") : null,
    totalTokens: reported.length ? sum("totalTokens") : null,
    tokensReported: reported.length === used.length,
    durationMs: sum("durationMs"),
    corrections: overrides,
    touchpoints: used.map((u) => ({ touchpoint: u.touchpoint, ok: u.ok, error: u.error || null })),
    // The half that matters most to a reviewer: what the model was NOT allowed
    // to do. Stated as fact, not as reassurance.
    decidedByCode: [
      "Guest OS support level and tier (Red Hat's certified list)",
      "All 15 source-side readiness checks",
      "Target capacity and per-VM node schedulability",
      "Resource guarantees lost on migration",
      "Move-together grouping, drift, and the transfer estimate",
    ],
    advisedByAI: consulted
      ? ["Warm or cold per VM, with a reason", "Wave sequencing and risk suggestions (at most 3)"]
      : [],
    note: consulted
      ? `${overrides} AI recommendation${overrides === 1 ? "" : "s"} overruled by policy before being shown.`
      : "No model was consulted. Every value in this assessment came from rules.",
    sources: { advice: adviceSource, suggestions: suggestionSource },
  };
}

/**
 * Fleet-level suggestions. The deterministic set above is always returned; the
 * LLM may add sequencing/wave advice on top, but it cannot remove or contradict
 * a finding — same "model advises, code decides" contract as adviseMigration().
 */
export async function adviseFleet(analysis, { reportId = null, vddkConfigured = undefined } = {}) {
  const base = fleetRemediation(analysis, { vddkConfigured });
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
    const { data: r, meta } = await classifyJSONWithMeta({
      conversationId: reportId || undefined,
      metadata: { useCase: "UC-10", touchpoint: "wave-sequencing" },
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
    return {
      source: extra.length ? "ai" : "heuristic",
      suggestions: [...base, ...extra],
      usage: { ...meta, touchpoint: "wave-sequencing", added: extra.length },
    };
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
export async function adviseMigration(vms = [], { window: maintenanceWindow = null, reportId = null } = {}) {
  const shortlist = vms.slice(0, 40).map((v) => ({
    name: v.name, poweredOn: v.poweredOn, diskGiB: v.diskGiB, diskCount: v.diskCount,
    guestOS: v.guestOS, cpu: v.cpuCount, memoryMB: v.memoryMB,
    changeTrackingEnabled: v.changeTrackingEnabled,
  }));
  if (!shortlist.length) return { source: "none", advice: [] };

  if (!llmEnabled()) return { source: "heuristic", advice: heuristicAdvice(vms) };

  try {
    const { data: r, meta } = await classifyJSONWithMeta({
      system: ADVISOR_SYSTEM,
      maxTokens: 1200,
      // Correlates every model call with the assessment that made it, so the
      // evidence pack and the change record can state what the AI cost.
      conversationId: reportId || undefined,
      metadata: { useCase: "UC-10", touchpoint: "method-advice", vms: shortlist.length },
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
      usage: { ...meta, touchpoint: "method-advice", vmsSent: shortlist.length },
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
export function planGroups(selection = [], { ai = null } = {}) {
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
    //
    // So does the rest of the source shape, for a different reason: it is what
    // verification compares against afterwards. Read back from the source later
    // it may be powered off, changed or decommissioned — the promise has to
    // travel with the plan that made it.
    byKey.get(key).vms.push({
      id: vm.id || null, name: vm.name, diskGiB: vm.diskGiB || 0,
      cpu: vm.cpuCount ?? null, memGiB: vm.memoryGiB ?? null,
      disks: Array.isArray(vm.disks) ? vm.disks.length : null,
      ips: Array.isArray(vm.ips) ? vm.ips.filter(Boolean).slice(0, 4) : [],
    });
  }

  const groups = [...byKey.values()].map((g, i) => ({
    ...g,
    ai,
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
        // Which assessment produced this plan, and what the AI did in it. The
        // change request is raised from the Plan — possibly days later, from a
        // fresh session — so the record has to travel with it.
        ...(group.ai ? { "tcs.agentic-ai/ai-provenance": JSON.stringify(group.ai).slice(0, 4000) } : {}),
        // The forecast, and the rate it assumed. Recorded at creation so the
        // live transfer can be judged against what was actually promised —
        // rather than against a throughput figure that has since moved.
        ...(group.planned?.mbps ? {
          "tcs.agentic-ai/planned-mbps": String(group.planned.mbps),
          "tcs.agentic-ai/planned-minutes": String(group.planned.minutes ?? ""),
        } : {}),
        // What the source looked like, so verification afterwards compares
        // against what was promised rather than against a source that has since
        // been powered off or decommissioned. Short keys: this is an
        // annotation, and annotations have a size limit worth respecting.
        "tcs.agentic-ai/source-vms": JSON.stringify(
          group.vms.map((v) => ({ n: v.name, c: v.cpu ?? null, m: v.memGiB ?? null, d: v.disks ?? null, g: v.diskGiB ?? null, i: v.ips || [] })),
        ).slice(0, 8000),
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
  // Once, not per poll: the rate assumed at creation is a fact about the plan.
  const tp = await clusterThroughput().catch(() => ({ mbps: null }));
  for (const g of groups) {
    const est = estimateMigration(g.vms, {
      strategy: g.strategy, throughputMBps: tp.mbps, concurrency: Math.min(2, g.vms.length),
    });
    const manifest = buildPlanManifest(
      { ...g, planned: { mbps: est.throughputMBps, minutes: est.wallClockMinutes.likely } },
      { targetProvider },
    );
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
    sourceProvider: p.spec?.provider?.source?.name || null,
    // The source footprint recorded at creation — what verification compares
    // against once the source itself may be off or gone.
    sourceVms: p.metadata?.annotations?.["tcs.agentic-ai/source-vms"] || null,
    vmCount: (p.spec?.vms || []).length,
    vmNames: (p.spec?.vms || []).map((v) => v.name || v.id).filter(Boolean),
    totalGiB: Number(p.metadata?.annotations?.["tcs.agentic-ai/total-gib"] || 0) || null,
    planned: p.metadata?.annotations?.["tcs.agentic-ai/planned-mbps"] ? {
      mbps: Number(p.metadata.annotations["tcs.agentic-ai/planned-mbps"]),
      minutes: Number(p.metadata.annotations["tcs.agentic-ai/planned-minutes"]) || null,
    } : null,
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
  // Read the phase before judging the byte counts — see liveEta.
  const cut = cutoverState(status);
  const decom = decommissionGate(await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`).catch(() => null) || {});
  const eta = liveEta(getProgressSamples(planName), { awaitingCutover: cut.awaitingCutover });
  return {
    ...status,
    progress: { bytes: snap.bytes, total: snap.total, activeVMs: snap.activeVMs },
    eta,
    // Waiting on a person, not on the network. The console needs to say which.
    cutover: cut,
    // The end-to-end route this plan is on. Warm and cold are different
    // journeys, so the console never has to work out which one to draw.
    decommission: decom,
    journey: (await import("./migration-verify.js")).migrationJourney({
      ...status, cutover: cut, decommission: decom,
      // Verification is not re-run on every poll — it reads the source
      // platform. The journey only needs to know whether it has passed.
      verification: _lastVerify.get(planName) || null,
    }),
    // The forecast, judged against what is actually happening.
    vsEstimate: estimateVsActual(status.planned, eta),
    // The APPROVED OUTAGE, judged against what is actually happening — a
    // different question from the one above, and the one with a change board
    // attached to it. Read from the window last seen on the change request, so
    // polling status costs no ServiceNow call.
    windowFit: (() => {
      const need = measuredOutage(status, eta);
      const w = _lastWindow.get(planName);
      return need && w ? windowFit({ win: w, neededMinutes: need.implementationMinutes, impactMinutes: need.minutes.likely }) : null;
    })(),
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
  let ai = null;
  try { ai = JSON.parse(plan.metadata?.annotations?.["tcs.agentic-ai/ai-provenance"] || "null"); } catch { /* not recorded */ }
  // The CAB is approving an outage, so the change record carries the numbers
  // they actually need: how long these machines are down, not only how long the
  // copy runs — and computed from THIS plan's footprint, not the wave's.
  const est = await estimatePlan(plan).catch(() => null);
  // Sized by strategy, because the two are not the same outage: a cold
  // migration is down for the whole copy, a warm one only for the cutover.
  const proposed = proposeWindow({ est, warm, vmCount: vms.length });
  const window = est
    ? [
        `Data to move       : ${est.totalGiB} GiB`,
        `Estimated transfer : ${est.wallClockMinutes.likely} min (${est.wallClockMinutes.low}-${est.wallClockMinutes.high})`,
        `Estimated downtime : ${est.downtimeMinutes.likely} min (${est.downtimeMinutes.low}-${est.downtimeMinutes.high})`,
        `Basis              : ${est.throughputMBps} MiB/s ${est.measured ? `measured from ${est.samples} completed migration(s) on this cluster` : "(conservative default — this cluster has completed no migrations yet)"}. ${est.note || ""}`.trim(),
        "",
        proposed ? proposed.basis : null,
        proposed ? "" : null,
        proposed ? "The start is a proposal — move it to suit your maintenance calendar, and the scheduled cutover follows wherever you put it." : null,
      ].filter(Boolean).join("\n")
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
        // A change board approving a migration is entitled to know which parts
        // of the assessment behind it a model touched.
        "AI involvement in the assessment that produced this plan:",
        ai?.consulted
          ? `  Consulted    : ${ai.provider || "?"} / ${ai.model || "?"}, ${ai.calls} call(s)${ai.totalTokens != null ? `, ${ai.totalTokens} tokens` : ""}`
          : "  Consulted    : no model was consulted; every value came from rules",
        ai?.consulted ? `  Advised      : ${ai.advisedByAI.join("; ")}` : null,
        ai?.consulted ? `  Overruled    : ${ai.corrections} AI recommendation(s) corrected by policy before being shown` : null,
        `  Decided by code : ${(ai?.decidedByCode || [
          "Guest OS support level and tier",
          "Source-side readiness checks",
          "Target capacity and node schedulability",
          "Transfer estimate",
        ]).join("; ")}`,
        "  The model has no cluster access and no tools. It advises; code decides; a person approves.",
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
      // A change request with no window cannot be scheduled against, and a
      // cutover cannot be gated on a window that was never asked for.
      ...(proposed ? { startDate: proposed.snowStart, endDate: proposed.snowEnd } : {}),
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
  // The record is already in hand, so this is the cheapest place to keep the
  // scheduled cutover honest with it: follow the window if the board moved it,
  // and warn them if what we are now measuring no longer fits what they
  // approved. Failing here must never turn an approval check into an error.
  const reconciled = await reconcileCutoverWindow(planName, { record }).catch(() => null);
  return {
    ok: true, gate: next, reconciled,
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
// 5b. Cutover — the outage, scheduled into the window that was approved
// ---------------------------------------------------------------------------
/**
 * A warm migration does not finish on its own, and that is the point of it.
 *
 * MTV copies the disks while the guest keeps serving users, then holds at the
 * last snapshot refreshing deltas and waits. Nothing else happens until a human
 * names the moment the guest is allowed to go down. In the plan's own words the
 * VM sits in "CopyingPaused", and the console read that as a stalled transfer —
 * which is exactly backwards. The copy has succeeded; it is waiting for us.
 *
 * So the cutover is treated as what it actually is: the outage. It is the thing
 * the change request asked the board to approve, so it happens inside the window
 * the board approved and the ticket records that it did. Nobody has to remember
 * to click a button at 2am, and nobody can take a production VM down at 3pm
 * because a console offered them a button that was always enabled.
 */

/** vSphere/Forklift phases that mean "precopy done, waiting to be told". */
const AWAITING_CUTOVER = /^(copyingpaused|copying_paused|precopy)$/i;

/**
 * Is this plan waiting on us rather than on the network? Pure.
 *
 * Only warm plans can be in this state. A cold plan that has stopped moving
 * bytes really has stopped, and must keep saying so.
 */
export function cutoverState(status = {}) {
  if (!status.warm) return { awaitingCutover: false, vms: [], reason: "Cold migration — there is no cutover step to wait for." };
  const vms = (status.vms || []).filter((v) => AWAITING_CUTOVER.test(String(v.phase || "")));
  if (!vms.length) return { awaitingCutover: false, vms: [], reason: null };
  return {
    awaitingCutover: true,
    vms: vms.map((v) => ({ name: v.name, phase: v.phase, since: v.started || null })),
    reason: `${vms.length === 1 ? "The disk copy is" : "The disk copies are"} done and MTV is holding at the last snapshot, refreshing changes while the ${vms.length === 1 ? "guest keeps" : "guests keep"} running. Nothing more moves until a cutover is scheduled.`,
  };
}

/**
 * The approved window, read off the change record. Pure.
 *
 * ServiceNow stores these as "YYYY-MM-DD HH:MM:SS" in the instance's own
 * timezone, which is a genuine ambiguity rather than a parsing bug — so an
 * unparseable or absent window is reported as absent, never as "open". A gate
 * that fails open is not a gate.
 */
export function cutoverWindow(record = {}, now = Date.now()) {
  const parse = (v) => {
    if (!v) return null;
    const t = Date.parse(String(v).trim().replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(String(v)) ? "" : "Z"));
    return Number.isFinite(t) ? t : null;
  };
  const start = parse(record.start_date), end = parse(record.end_date);
  if (!start && !end) {
    return { known: false, start: null, end: null, open: false,
      note: "The change record carries no planned start or end, so there is no window to check the cutover against." };
  }
  const open = (!start || now >= start) && (!end || now <= end);
  const mins = (a, b) => Math.round((a - b) / 60000);
  return {
    known: true,
    start: start ? new Date(start).toISOString() : null,
    end: end ? new Date(end).toISOString() : null,
    open,
    opensInMinutes: start && now < start ? mins(start, now) : null,
    closesInMinutes: end && open ? mins(end, now) : null,
    expired: !!(end && now > end),
    note: open
      ? end ? `Inside the approved window; it closes in ${mins(end, now)} min.` : "Inside the approved window."
      : start && now < start ? `The approved window opens in ${mins(start, now)} min.`
      : "The approved window has closed. Ask the change board to extend it or raise a new change request.",
  };
}

/**
 * May we cut over, and when? Pure, so the rule is tested rather than asserted.
 *
 * Three answers, never two: cut over now, schedule it for when the window
 * opens, or refuse. The middle one matters — it is the difference between a
 * tool that makes someone sit up until midnight and one that does not.
 */
export function cutoverDecision({ gate, window: win, state, now = Date.now() } = {}) {
  const no = (reason, fix) => ({ allowed: false, mode: "blocked", at: null, reason, fix });

  if (!state?.awaitingCutover) {
    return no("This plan is not waiting for a cutover.",
      "A cutover applies to a warm migration once its precopy is done.");
  }
  if (gate?.required !== false && !gate?.approved) {
    return no(
      gate?.number ? `${gate.number} is ${gate.state} — the cutover is the outage this change request asks to approve.`
        : "No change request has been raised for this plan.",
      gate?.number ? "Approve it in ServiceNow, then re-check the gate here." : "Raise the change request first.",
    );
  }
  // Approved, but the board named a window and we are not in it. Schedule
  // rather than refuse: MTV will cut over on its own at the timestamp.
  if (win?.known && !win.open) {
    if (win.expired) {
      return no("The approved change window has already closed.",
        "Ask the change board to extend the window, or raise a new change request for the cutover.");
    }
    return {
      allowed: true, mode: "schedule", at: win.start,
      reason: `Approved, but the window opens in ${win.opensInMinutes} min. MTV will cut over by itself at the start of the window.`,
      fix: null,
    };
  }
  return {
    allowed: true, mode: "now", at: new Date(now).toISOString(),
    reason: win?.known ? win.note : "Approved. No window is recorded on the change request, so the cutover runs when you ask for it.",
    fix: null,
  };
}

/**
 * The window to ask the change board for. Pure.
 *
 * The mistake this replaces is worth naming, because it is the obvious one: a
 * change window is NOT the outage. They are two different fields on the change
 * record and two different promises. start_date/end_date is the IMPLEMENTATION
 * WINDOW — the period the work is authorised to happen in. The outage is the
 * service impact inside it, and for a warm migration it is a small fraction of
 * it. Sizing the window from the downtime asked a board to authorise fifteen
 * minutes of work, which no change board would accept and no engineer could
 * work inside.
 *
 * What an implementation window has to cover, and what every change process
 * asks for:
 *
 *   pre-checks    the plan, the approval, the state of the source
 *   the work      the cutover for warm; the whole copy for cold
 *   verification  boot, address, disks, and someone testing the application
 *   BACKOUT       the one people leave out. If the cutover fails at minute ten
 *                 of a fifteen-minute window there is no authorised time left
 *                 to put it back, and now you are running unapproved work in
 *                 the middle of an incident.
 *   contingency   because the estimate is an estimate
 *
 * Floored at a standard maintenance slot (MIGRATION_MIN_WINDOW_HOURS, default
 * 4h), because that is the granularity real change calendars and freeze
 * periods work in — nobody schedules a 22-minute slot.
 *
 * Both numbers are returned and both go on the record: the board authorises a
 * window of hours in which the service is down for minutes, and saying so is
 * the difference between an honest change request and an alarming one.
 */
export function proposeWindow({ est, warm, vmCount = 1, now = Date.now(), leadHours = null, minHours = null } = {}) {
  if (!est) return null;
  const lead = leadHours ?? Number(process.env.MIGRATION_CR_LEAD_HOURS ?? 24);
  const floorHours = minHours ?? Number(process.env.MIGRATION_MIN_WINDOW_HOURS ?? 4);
  const n = Math.max(1, vmCount);

  // The high end of the estimate throughout, not the median: a window sized on
  // the likely figure is one the work overruns half the time.
  const work = Math.ceil(warm ? est.downtimeMinutes.high : est.wallClockMinutes.high);
  const precheck = 15;
  const verify = Math.max(15, 10 * n);
  // Powering the source VMs back on and confirming them. This is what the
  // window has to still have room for when something goes wrong late in it.
  const backout = 30 + 5 * n;
  const contingency = Math.max(15, Math.ceil(work * 0.3));

  const computed = precheck + work + verify + backout + contingency;
  const floorMin = floorHours * 60;
  // Rounded up to the next half hour. Change calendars are not written in
  // minutes, and a window ending at 03:07 invites someone to shave it.
  const minutes = Math.max(floorMin, Math.ceil(computed / 30) * 30);

  const start = new Date(Math.ceil((now + lead * 3600000) / 1800000) * 1800000);
  const end = new Date(start.getTime() + minutes * 60000);
  // The service impact — a different promise from the window, stated as one.
  const impact = warm ? est.downtimeMinutes : est.wallClockMinutes;

  const hrs = (m) => (m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`);
  return {
    start: start.toISOString(), end: end.toISOString(), minutes, hours: minutes / 60,
    // ServiceNow wants "YYYY-MM-DD HH:MM:SS" in UTC.
    snowStart: start.toISOString().slice(0, 19).replace("T", " "),
    snowEnd: end.toISOString().slice(0, 19).replace("T", " "),
    components: { precheck, work, verify, backout, contingency, computed },
    flooredToMinimum: minutes > Math.ceil(computed / 30) * 30,
    serviceImpact: { minutes: impact, note: warm
      ? "Downtime is the cutover only — the guest serves users while its disks copy."
      : "A cold migration is down for the whole copy." },
    basis: [
      `Implementation window: ${hrs(minutes)}.`,
      `  ${"Pre-checks".padEnd(18)} ${precheck} min`,
      `  ${(warm ? "Cutover" : "Power off and copy").padEnd(18)} ${work} min`,
      `  ${"Verification".padEnd(18)} ${verify} min`,
      `  ${"Backout if needed".padEnd(18)} ${backout} min`,
      `  ${"Contingency".padEnd(18)} ${contingency} min`,
      // Only said when it is true: the floor applies to a small wave, not to a
      // ten-hour copy that earned its window on its own.
      minutes > Math.ceil(computed / 30) * 30 ? `  Floored at the ${floorHours}h standard maintenance slot.` : null,
      "",
      `Expected service impact: ${impact.likely} min (${impact.low}-${impact.high}). ${warm
        ? "The guest keeps serving users while its disks copy; only the cutover is downtime."
        : "The guest is powered off for the whole copy."}`,
    ].filter((x) => x !== null).join("\n"),
  };
}

export function windowDrift(stamped, win, now = Date.now(), toleranceMs = 60000) {
  if (!stamped) return { drifted: false, reason: "No cutover is scheduled." };
  const at = Date.parse(stamped);
  if (!Number.isFinite(at)) return { drifted: false, reason: "The scheduled cutover is not a time that can be read." };
  if (at <= now) return { drifted: false, reason: "The scheduled cutover has already passed — it is not re-stamped." };
  if (!win?.known || !win.start) return { drifted: false, reason: "The change record carries no window to reconcile against." };

  const start = Date.parse(win.start);
  const end = win.end ? Date.parse(win.end) : null;
  const outside = at < start - toleranceMs || (end && at > end);
  if (!outside) return { drifted: false, reason: "The scheduled cutover is inside the approved window." };

  return {
    drifted: true, from: new Date(at).toISOString(), to: win.start,
    reason: at < start
      ? `The cutover is scheduled for ${new Date(at).toISOString()}, before the approved window opens at ${win.start}.`
      : `The cutover is scheduled for ${new Date(at).toISOString()}, after the approved window closes at ${win.end}.`,
  };
}

/**
 * Does the work still fit the window the board approved? Pure.
 *
 * The comparison that matters is the IMPLEMENTATION need against the window —
 * the copy or cutover, plus verifying it, plus enough left to put it back if it
 * goes wrong. Comparing the outage alone against the window would say a
 * 48-minute cutover "fits" a four-hour window right up to the moment it fails
 * with twenty minutes left and nowhere to back out to.
 *
 * Both numbers are reported, because the board cares about both: whether the
 * work fits the slot, and how long the service is actually down.
 */
export function windowFit({ win, approvedMinutes = null, neededMinutes = null, impactMinutes = null } = {}) {
  const approved = approvedMinutes ?? (win?.known && win.start && win.end
    ? Math.round((Date.parse(win.end) - Date.parse(win.start)) / 60000) : null);
  if (approved == null || neededMinutes == null) {
    return { known: false, fits: null, note: "Not enough measured to judge the window yet." };
  }
  const fits = neededMinutes <= approved;
  const hrs = (m) => (m >= 90 ? `${(m / 60).toFixed(1)}h` : `${m} min`);
  return {
    known: true, fits, approvedMinutes: approved, neededMinutes, impactMinutes,
    overrunMinutes: fits ? 0 : neededMinutes - approved,
    note: fits
      ? `The approved ${hrs(approved)} window still covers the ${hrs(neededMinutes)} the work now needs${impactMinutes != null ? `, of which ${hrs(impactMinutes)} is service impact` : ""}.`
      : `The approved window is ${hrs(approved)}. At the rate now being measured the work needs about ${hrs(neededMinutes)} including verification and time to back out — ${hrs(neededMinutes - approved)} more than was approved.`,
    action: fits ? null : "Ask the change board to extend the window, or take fewer machines in this wave.",
  };
}

/**
 * How long the outage now looks, from the rate this transfer is ACTUALLY
 * achieving rather than the one the estimate assumed.
 *
 * This is the whole point of measuring during a warm precopy. The copy runs for
 * hours against this source, this network and this storage, and tells us what
 * they really do. The cutover — the final delta plus the per-VM shutdown and
 * start — is then costed at that measured rate instead of at the default the
 * change request was sized with.
 *
 * Returns null while there is nothing measured, rather than a number dressed up
 * as one.
 */
export function measuredOutage(status = {}, live = null) {
  if (!live || live.state !== "transferring" || !live.mbps) return null;
  const vms = (status.vms || []).map((v) => ({
    name: v.name,
    diskGiB: v.diskGiB || (status.totalGiB && status.vmCount ? status.totalGiB / status.vmCount : 0),
  }));
  if (!vms.length) return null;
  const est = estimateMigration(vms, {
    strategy: status.warm ? "warm" : "cold",
    throughputMBps: live.mbps,
    concurrency: Math.min(2, vms.length),
  });
  // The window has to hold the work, not only the outage: verifying it, and
  // enough left to put it back. Same components proposeWindow sized it with,
  // re-costed at the rate actually being achieved.
  const n = vms.length;
  const work = Math.ceil(status.warm ? est.downtimeMinutes.high : est.wallClockMinutes.high);
  const implementation = 15 + work + Math.max(15, 10 * n) + (30 + 5 * n) + Math.max(15, Math.ceil(work * 0.3));
  return {
    minutes: est.downtimeMinutes,
    implementationMinutes: implementation,
    mbps: live.mbps,
    basis: `Costed at the ${live.mbps} MiB/s this transfer is measuring, not at the rate the estimate assumed.`,
  };
}

/** The Migration that is actually running this plan — the newest, not the first. */
export async function activeMigration(planName) {
  const list = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/migrations`).catch(() => ({ items: [] }));
  const mine = (list.items || [])
    .filter((m) => m.spec?.plan?.name === planName)
    .sort((a, b) => String(b.metadata?.creationTimestamp || "").localeCompare(String(a.metadata?.creationTimestamp || "")));
  return mine[0] || null;
}

/**
 * Everything the console needs to decide, in one read: is it waiting, what did
 * the board approve, and what may we do about it.
 */
export async function cutoverPosture(planName) {
  const status = await planStatus(planName);
  if (!status.found) return { found: false, planName };
  const state = cutoverState(status);
  let record = null, lookupError = null;
  if (state.awaitingCutover && status.gate?.sysId) {
    try {
      const { getRecord } = await import("../utils/servicenow-client.js");
      const cr = await getRecord("change_request", status.gate.sysId);
      record = cr?.result || cr || null;
    } catch (e) {
      // An unreachable ServiceNow is not an open window. Say which it is.
      lookupError = `Could not read the change window from ServiceNow: ${e.message}`;
    }
  }
  const win = record ? cutoverWindow(record) : { known: false, open: false, note: lookupError || "No change record to read a window from." };
  const mig = state.awaitingCutover ? await activeMigration(planName) : null;
  return {
    found: true, planName, state, gate: status.gate, window: win,
    scheduled: mig?.spec?.cutover || null,
    migrationName: mig?.metadata?.name || null,
    decision: cutoverDecision({ gate: status.gate, window: win, state }),
  };
}

/** Remembers what has already been said to the board, so it is not said twice. */
const FIT_ANN = "tcs.agentic-ai/window-fit-warned";

/**
 * The window last read off the change request, per plan.
 *
 * Kept so that polling status — which the console does every ten seconds — can
 * judge the measured outage against the approved one without a ServiceNow call
 * each time. Populated by the approval poll; absent until then, which is why
 * windowFit reads null rather than optimistic before the first read.
 */
const _lastWindow = new Map();

/**
 * Keep the scheduled cutover and the approved window honest with each other.
 *
 * Two jobs, both of which only matter between scheduling and firing:
 *
 *   1. The board moves the window. A cutover stamped against the old start
 *      fires outside the window they approved, on a decision taken before they
 *      changed it. Re-stamped to follow them.
 *
 *   2. The window no longer fits. It was sized from an estimate; the precopy
 *      has since measured what this source and network really do. If the
 *      outage now costs more than was approved, the board is told BEFORE the
 *      window opens — once, as a work note — while somebody can still extend it
 *      or take fewer machines.
 *
 * Called from the approval poll the console already runs, so this happens by
 * itself rather than needing anyone to press anything.
 */
export async function reconcileCutoverWindow(planName, { record = null, actor = "agent" } = {}) {
  const status = await planStatusWithEta(planName).catch(() => null);
  if (!status?.found || !status.warm) return { checked: false, reason: "Only a warm plan has a cutover to reconcile." };

  let cr = record;
  const gate = status.gate || {};
  if (!cr && gate.sysId) {
    try {
      const { getRecord } = await import("../utils/servicenow-client.js");
      const r = await getRecord("change_request", gate.sysId);
      cr = r?.result || r || null;
    } catch { cr = null; }
  }
  const win = cr ? cutoverWindow(cr) : { known: false, open: false };
  if (win.known) _lastWindow.set(planName, win);

  const mig = await activeMigration(planName);
  const stamped = mig?.spec?.cutover || null;
  const out = { checked: true, planName, window: win, stamped, drift: null, fit: null, actions: [] };

  // ── 1. Follow the board if they moved the window ────────────────────────
  const drift = windowDrift(stamped, win);
  out.drift = drift;
  if (drift.drifted && mig?.metadata?.name) {
    try {
      await ocpPatch(
        `/${FORKLIFT}/namespaces/${MTV_NS}/migrations/${mig.metadata.name}`,
        { spec: { cutover: drift.to } },
        "application/merge-patch+json",
      );
      out.actions.push(`Cutover re-stamped from ${drift.from} to ${drift.to} — the change window moved.`);
      await recordChange({
        cluster: "local", namespace: MTV_NS, resourceKind: "migration", resourceName: mig.metadata.name,
        action: "resync_cutover_to_change_window",
        command: `oc patch migration ${mig.metadata.name} -n ${MTV_NS} --type=merge -p '{"spec":{"cutover":"${drift.to}"}}'`,
        risk: "medium", approvedBy: gate.number || actor,
      }).catch(() => {});
      if (gate.sysId) {
        const { updateRecord } = await import("../utils/servicenow-client.js");
        await updateRecord("change_request", gate.sysId, {
          work_notes: `[TCS Agentic AI] The change window moved, so the scheduled cutover followed it: ${drift.from} → ${drift.to}.\n${drift.reason}`,
        }).catch(() => {});
      }
    } catch (e) {
      out.actions.push(`Could not re-stamp the cutover: ${e.message}`);
    }
  }

  // ── 2. Tell the board if the outage no longer fits what they approved ───
  const need = measuredOutage(status, status.eta);
  if (need) {
    const fit = windowFit({ win, neededMinutes: need.implementationMinutes, impactMinutes: need.minutes.likely });
    out.fit = { ...fit, measuredMbps: need.mbps };
    // Said once per plan. A work note on every ten-second poll is not a warning,
    // it is noise, and noise is how a real warning gets missed.
    const already = (await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`).catch(() => null))
      ?.metadata?.annotations?.[FIT_ANN];
    if (fit.known && !fit.fits && !already && gate.sysId) {
      try {
        const { updateRecord } = await import("../utils/servicenow-client.js");
        await updateRecord("change_request", gate.sysId, {
          work_notes: [
            "[TCS Agentic AI] The approved window no longer covers the work.",
            "",
            fit.note,
            need.basis,
            "",
            fit.action,
            "",
            "This is being raised before the window opens, while it can still be changed.",
          ].join("\n"),
        });
        await annotatePlan(planName, { [FIT_ANN]: new Date().toISOString() }).catch(() => {});
        out.actions.push(`${gate.number} told the work now needs ${fit.neededMinutes} min against an approved ${fit.approvedMinutes} min.`);
      } catch (e) {
        out.actions.push(`Could not add the window-fit note: ${e.message}`);
      }
    }
  }

  return out;
}

/**
 * Schedule the cutover by stamping the moment onto the running Migration.
 *
 * spec.cutover is how Forklift is told; setting it in the future is a genuine
 * schedule, not a timer in our process — so this survives the console being
 * closed, and the browser being on a different continent to the cluster.
 */
export async function scheduleCutover(planName, { at = null, actor = "operator", cluster = "local" } = {}) {
  const posture = await cutoverPosture(planName);
  if (!posture.found) return { ok: false, error: `Plan "${planName}" not found.` };

  const d = posture.decision;
  // An explicit time from the operator is still checked against the window —
  // the console offering a control is not the same as the board approving it.
  const requested = at ? Date.parse(at) : null;
  if (at && !Number.isFinite(requested)) return { ok: false, error: `"${at}" is not a time I can read.`, posture };
  if (at && posture.window?.known && posture.window.end && requested > Date.parse(posture.window.end)) {
    return { ok: false, error: "That moment is after the approved change window closes.", posture };
  }
  if (!d.allowed) return { ok: false, error: d.reason, fix: d.fix, posture };

  const when = at ? new Date(requested).toISOString() : d.at;
  if (!posture.migrationName) {
    return { ok: false, error: "No running Migration was found for this plan, so there is nothing to cut over.", posture };
  }

  try {
    await ocpPatch(
      `/${FORKLIFT}/namespaces/${MTV_NS}/migrations/${posture.migrationName}`,
      { spec: { cutover: when } },
      "application/merge-patch+json",
    );
  } catch (e) {
    return { ok: false, error: `Could not set the cutover on migration/${posture.migrationName}: ${e.message}`, posture };
  }

  await recordChange({
    cluster, namespace: MTV_NS, resourceKind: "migration", resourceName: posture.migrationName,
    action: "schedule_vm_cutover",
    command: `oc patch migration ${posture.migrationName} -n ${MTV_NS} --type=merge -p '{"spec":{"cutover":"${when}"}}'`,
    // This one takes production VMs down. It is not a low-risk annotation.
    risk: "high", approvedBy: posture.gate?.number || actor,
    revertCommand: `oc patch migration ${posture.migrationName} -n ${MTV_NS} --type=json -p '[{"op":"remove","path":"/spec/cutover"}]'  # only before it fires`,
  }).catch(() => {});

  // The ticket is the record, not this console. Written after the patch, so a
  // work note never claims something that did not happen.
  let noted = false;
  if (posture.gate?.sysId) {
    try {
      const { updateRecord } = await import("../utils/servicenow-client.js");
      const names = posture.state.vms.map((v) => v.name).join(", ");
      await updateRecord("change_request", posture.gate.sysId, {
        work_notes: [
          `[TCS Agentic AI] Cutover ${d.mode === "now" ? "started" : "scheduled"} for ${when} by ${actor}.`,
          `Plan      : ${planName}`,
          `Machines  : ${names}`,
          `Migration : ${posture.migrationName}`,
          "The disk copy is already complete. At cutover the guest is shut down on the source, the final changed blocks are copied, and the VM is started on OpenShift Virtualization.",
        ].join("\n"),
      });
      noted = true;
    } catch { /* the cutover is set; a missing work note must not undo it */ }
  }

  return {
    ok: true, planName, migrationName: posture.migrationName, cutover: when,
    mode: d.mode, workNoteAdded: noted,
    message: d.mode === "now"
      ? "Cutover started. The guests shut down, the final changes copy, and the VMs start on OpenShift."
      : `Cutover scheduled for ${new Date(when).toLocaleString()}. MTV performs it without anyone being present.`,
  };
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
/** Last verification verdict per plan, so polling need not re-read the source. */
const _lastVerify = new Map();

export async function verifyMigration(planName) {
  const status = await planStatus(planName);
  if (!status.found) return { ok: false, error: `Plan "${planName}" not found.` };
  const names = (status.vms || []).map((v) => v.name).filter(Boolean);
  if (!names.length || !status.targetNamespace) {
    return { ok: false, planName, error: "No migrated VMs to verify yet." };
  }

  const { verifyVM, verifySummary } = await import("./migration-verify.js");
  const { vmRuntimeStatus } = await import("./vm-provisioning.js");

  // 1. What the plan promised, recorded when it was created.
  let promised = [];
  try { promised = JSON.parse(status.sourceVms || "[]"); } catch { promised = []; }
  const promisedBy = Object.fromEntries(promised.map((p) => [p.n, {
    name: p.n, cpu: p.c, memGiB: p.m, disks: p.d, diskGiB: p.g, ips: p.i || [],
  }]));

  // 2. What is running on OpenShift now.
  const runtime = await vmRuntimeStatus(status.targetNamespace, names);
  const runtimeBy = Object.fromEntries((runtime.vms || []).map((v) => [v.name, v]));

  // 3. The shape the target was actually built with.
  const targetBy = {};
  for (const n of names) {
    const vm = await ocpGet(`/${KUBEVIRT}/namespaces/${status.targetNamespace}/virtualmachines/${n}`).catch(() => null);
    if (!vm) continue;
    const dom = vm.spec?.template?.spec?.domain || {};
    const memStr = dom.memory?.guest || dom.resources?.requests?.memory || null;
    targetBy[n] = {
      cpu: (dom.cpu?.cores || 1) * (dom.cpu?.sockets || 1) * (dom.cpu?.threads || 1),
      memGiB: memStr ? Math.round(parseMemGiB(memStr)) : null,
      disks: (dom.devices?.disks || []).length || null,
    };
  }

  // 4. Is the source off? An unreachable source platform leaves this NULL —
  //    which verifyVM reports as unchecked, never as "powered off".
  const sourceOff = await sourcePowerStates(status, names);

  const vms = names.map((n) => verifyVM(promisedBy[n] || { name: n }, runtimeBy[n] || null, targetBy[n] || null,
    Object.prototype.hasOwnProperty.call(sourceOff, n) ? sourceOff[n] : null));
  const summary = verifySummary(vms);

  _lastVerify.set(planName, { verdict: summary.verdict, at: Date.now() });
  return {
    ok: summary.verdict === "passed" || summary.verdict === "passed-with-warnings",
    planName, namespace: status.targetNamespace, verifiedAt: new Date().toISOString(),
    ...summary, vmChecks: vms,
    note: summary.headline,
  };
}

/** GiB from a Kubernetes quantity, for the one comparison that needs it. */
function parseMemGiB(v) {
  const m = String(v).match(/^(\d+(?:\.\d+)?)\s*([KMGTP]i?)?$/);
  if (!m) return NaN;
  const mult = { Ki: 1 / 1048576, Mi: 1 / 1024, Gi: 1, Ti: 1024, K: 1e3 / 2 ** 30, M: 1e6 / 2 ** 30, G: 1e9 / 2 ** 30, T: 1e12 / 2 ** 30 };
  return Number(m[1]) * (mult[m[2]] ?? 1 / 2 ** 30);
}

/**
 * Power state of each source VM, read from the provider inventory.
 *
 * Returns a map with an entry ONLY for VMs it could actually read. A name that
 * is absent means "not checked", and the caller must not read that as "off" —
 * this is the check that catches the same machine running on both platforms.
 */
async function sourcePowerStates(status, names) {
  const out = {};
  try {
    const providerName = status.sourceProvider;
    if (!providerName) return out;
    const p = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/providers/${providerName}`).catch(() => null);
    const uid = p?.metadata?.uid;
    if (!uid) return out;
    const vms = await discoverVMs(uid);
    for (const v of vms) {
      if (!names.includes(v.name)) continue;
      // normaliseInventoryVM fills an absent power state with the literal
      // "unknown". Treating that as a read value would answer "the source is
      // still ON" on the strength of having learned nothing — which is the one
      // mistake this check exists to avoid. It stays unchecked instead.
      const st = String(v.powerState || "").toLowerCase();
      if (!st || st === "unknown") continue;
      out[v.name] = /off|suspend/.test(st);
    }
  } catch { /* unreachable source: every VM stays unchecked, which is the point */ }
  return out;
}

// ---------------------------------------------------------------------------
// 8. Decommission — the last step, and the only irreversible one
// ---------------------------------------------------------------------------
/**
 * Until the source VMs are deleted, a migration is reversible: MTV powers them
 * off and never removes them, so the way back is to power them on again. That
 * is exactly why deleting them is a separate decision, with its own change
 * request, taken after the migrated machines have carried real traffic for long
 * enough to trust them.
 *
 * What this deliberately does NOT do is delete anything. The agent has
 * read-only access to the source platform — it can see a VM's power state, it
 * cannot remove it — and pretending otherwise would be worse than useless. It
 * raises the request, carries the evidence that justifies it, and tracks it to
 * closure. The deletion is performed by whoever owns vCenter, which is also
 * where the audit trail for an irreversible act belongs.
 */
const DECOM_ANN = {
  number: "tcs.agentic-ai/decommission-request",
  sysId: "tcs.agentic-ai/decommission-sys-id",
  state: "tcs.agentic-ai/decommission-state",
  at: "tcs.agentic-ai/decommission-checked-at",
};

/** How long the migrated machines must run before deletion is even offered. */
export function soakDays() {
  const n = Number(process.env.MIGRATION_SOAK_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

/**
 * May we ask to delete the source VMs yet? Pure.
 *
 * Four things have to be true, and each of them fails closed. The soak is the
 * one people want to skip, so it is stated in days remaining rather than as a
 * flat refusal — and it can be overridden deliberately, which is different from
 * it not being there.
 */
export function decommissionReadiness({ status, verification, since, now = Date.now(), days = 7 } = {}) {
  const blockers = [];

  if (!status?.succeeded) {
    blockers.push({ code: "not-migrated", message: "This plan has not completed. Nothing has been replaced yet." });
  }
  if (!verification) {
    blockers.push({ code: "not-verified", message: "The migration has not been verified. Run verification first." });
  } else if (verification.verdict === "failed") {
    blockers.push({ code: "verification-failed", message: `Verification failed — ${verification.headline}` });
  } else if (verification.verdict === "incomplete") {
    // The unrun check is usually the one that matters: we could not confirm the
    // source is off. Deleting on the strength of that is how the wrong VM goes.
    blockers.push({ code: "verification-incomplete", message: `${verification.counts?.unchecked || 0} verification check(s) could not run. Deleting a source VM on an incomplete check is how the wrong machine gets deleted.` });
  }
  if (verification?.splitBrain?.length) {
    blockers.push({ code: "split-brain", message: `${verification.splitBrain.join(", ")} still running on both platforms.` });
  }

  const elapsedDays = since ? (now - Date.parse(since)) / 86400000 : null;
  const soaked = days === 0 || (elapsedDays != null && elapsedDays >= days);
  const remaining = elapsedDays == null ? null : Math.max(0, Math.ceil(days - elapsedDays));

  return {
    ready: blockers.length === 0 && soaked,
    blockers,
    soak: {
      days, soaked, remainingDays: remaining,
      since: since || null,
      note: days === 0 ? "No soak period is configured."
        : elapsedDays == null ? "The migration completion time is not recorded, so the soak period cannot be measured."
        : soaked ? `Running on OpenShift for ${Math.floor(elapsedDays)} day(s).`
        : `${remaining} more day(s) before the source VMs are offered for deletion. They stay powered off and intact until then — this is the way back.`,
    },
    // Said in one line, because this is the sentence someone reads before
    // agreeing to an irreversible thing.
    next: blockers.length ? blockers[0].message
      : soaked ? "The migrated machines have run long enough. Raising the decommission request is the last step."
      : `Soaking — ${remaining} day(s) to go.`,
  };
}

/** Where the decommission stands, read from the Plan. Pure. */
export function decommissionGate(plan) {
  const a = plan?.metadata?.annotations || {};
  const number = a[DECOM_ANN.number] || null;
  const state = a[DECOM_ANN.state] || (number ? "submitted" : "none");
  return {
    number, sysId: a[DECOM_ANN.sysId] || null, state,
    checkedAt: a[DECOM_ANN.at] || null,
    raised: !!number,
    approved: state === "approved",
    next: !number ? "No decommission request has been raised."
      : state === "approved" ? `${number} is approved — the VMware team may delete the source VMs.`
      : state === "rejected" ? `${number} was rejected. The source VMs stay where they are.`
      : `${number} is awaiting approval.`,
  };
}

/** When the migrated machines started carrying traffic — the soak clock. */
function completedAt(status) {
  const times = (status.vms || []).map((v) => v.completed).filter(Boolean).map((t) => Date.parse(t)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** Everything the console needs to decide, in one read. */
export async function decommissionPosture(planName) {
  const status = await planStatus(planName);
  if (!status.found) return { found: false, planName };
  const plan = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`).catch(() => null);
  const verification = status.succeeded ? await verifyMigration(planName).catch(() => null) : null;
  const since = completedAt(status);
  const readiness = decommissionReadiness({
    status, verification, since, days: soakDays(),
  });
  return {
    found: true, planName, since,
    gate: decommissionGate(plan || {}),
    verification: verification ? { verdict: verification.verdict, headline: verification.headline, counts: verification.counts, splitBrain: verification.splitBrain } : null,
    ...readiness,
  };
}

/**
 * Raise the request to delete the source VMs.
 *
 * A second change request, not an amendment to the first: the migration was
 * reversible and this is not, they are approved by different people at
 * different times, and a rejected decommission must not reopen a migration that
 * succeeded. It carries the verification evidence, because "delete these
 * production VMs" is a request that has to justify itself.
 */
export async function raiseDecommissionCR(planName, { actor = "operator", cluster = "local", force = false } = {}) {
  const posture = await decommissionPosture(planName);
  if (!posture.found) return { ok: false, error: `Plan "${planName}" not found.` };
  if (posture.gate.raised && posture.gate.state !== "rejected") {
    return { ok: true, alreadyRaised: true, gate: posture.gate, message: `${posture.gate.number} already exists for this plan.` };
  }
  // The soak may be waived deliberately; a failed verification may not.
  if (posture.blockers.length) {
    return { ok: false, error: posture.blockers[0].message, blockers: posture.blockers, posture };
  }
  if (!posture.soak.soaked && !force) {
    return { ok: false, error: posture.soak.note, posture, waivable: true };
  }

  const plan = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`).catch(() => null);
  const vms = (plan?.spec?.vms || []).map((v) => v.name || v.id);
  const migrationCR = approvalGate(plan || {}).number;
  const v = posture.verification;

  let cr;
  try {
    const { createChangeRequest } = await import("../utils/servicenow-client.js");
    cr = await createChangeRequest({
      shortDescription: `Decommission ${vms.length} source VM(s) in VMware, migrated to OpenShift Virtualization: ${vms.slice(0, 4).join(", ")}${vms.length > 4 ? ` +${vms.length - 4}` : ""}`,
      description: [
        "These virtual machines were migrated to OpenShift Virtualization and have been running there since the date below. This request is to DELETE the original VMs in VMware.",
        "",
        `Plan                : ${planName}`,
        migrationCR ? `Migration change    : ${migrationCR}` : null,
        `Virtual machines    : ${vms.join(", ")}`,
        `Running on OpenShift: ${posture.since ? new Date(posture.since).toISOString() : "unknown"} (${posture.soak.days}-day soak ${posture.soak.soaked ? "complete" : "WAIVED by " + actor})`,
        `Target namespace    : ${plan?.spec?.targetNamespace || "unspecified"}`,
        "",
        "Verification at the time of this request:",
        `  Verdict : ${v?.verdict || "not run"}`,
        `  Detail  : ${v?.headline || "—"}`,
        v?.counts ? `  Checks  : ${v.counts.pass} passed, ${v.counts.warn} warning(s), ${v.counts.fail} failed, ${v.counts.unchecked} could not run` : null,
        "",
        "Until this request is carried out the migration remains reversible: the source VMs are powered off and intact, and powering them back on is the way back. After it, it is not.",
      ].filter(Boolean).join("\n"),
      type: "normal",
      category: "Infrastructure",
      // Deleting a VM is not a moderate risk however well it went.
      risk: "high",
      implementationPlan: [
        "In vCenter, for each VM listed above:",
        "  1. Confirm it is powered off.",
        "  2. Confirm the migrated VM of the same name is running on OpenShift Virtualization.",
        "  3. Take a final backup if policy requires one.",
        "  4. Delete from disk.",
      ].join("\n"),
      backoutPlan: "None after deletion. This is the point at which the migration stops being reversible — which is why it is a separate change request, raised only after the soak period.",
      testPlan: "Confirm the migrated VMs are still running and serving traffic after the source VMs are removed.",
    });
  } catch (e) {
    return { ok: false, error: `Could not raise the decommission request: ${e.message}` };
  }

  const rec = cr?.result || cr || {};
  const number = rec.number || null;
  if (!number) return { ok: false, error: "ServiceNow accepted the request but returned no change number." };

  await annotatePlan(planName, {
    [DECOM_ANN.number]: number,
    [DECOM_ANN.sysId]: rec.sys_id || "",
    [DECOM_ANN.state]: "submitted",
    [DECOM_ANN.at]: new Date().toISOString(),
  }).catch(() => {});
  await recordChange({
    cluster, namespace: MTV_NS, resourceKind: "plan", resourceName: planName,
    action: "raise_decommission_change_request", command: `# ServiceNow ${number}`,
    risk: "low", approvedBy: actor,
  }).catch(() => {});

  return {
    ok: true, number, sysId: rec.sys_id || null,
    waived: !posture.soak.soaked,
    message: `${number} raised. The source VMs stay powered off and intact until the VMware team carries it out.`,
  };
}

/** Ask ServiceNow where the decommission request stands, and write it back. */
export async function checkDecommissionApproval(planName) {
  const plan = await ocpGet(`/${FORKLIFT}/namespaces/${MTV_NS}/plans/${planName}`).catch(() => null);
  if (!plan) return { ok: false, error: `Plan "${planName}" not found.` };
  const gate = decommissionGate(plan);
  if (!gate.number) return { ok: true, gate, note: gate.next };

  let record;
  try {
    const { getRecord } = await import("../utils/servicenow-client.js");
    const cr = await getRecord("change_request", gate.sysId || gate.number);
    record = cr?.result || cr;
  } catch (e) {
    return { ok: false, gate, error: `Could not read ${gate.number} from ServiceNow: ${e.message}` };
  }
  if (!record) return { ok: false, gate, error: `ServiceNow returned no record for ${gate.number}.` };

  const verdict = readMigrationApproval(record);
  if (verdict !== gate.state) {
    await annotatePlan(planName, { [DECOM_ANN.state]: verdict, [DECOM_ANN.at]: new Date().toISOString() }).catch(() => {});
  }
  const next = decommissionGate({ metadata: { annotations: {
    [DECOM_ANN.number]: gate.number, [DECOM_ANN.sysId]: gate.sysId || "", [DECOM_ANN.state]: verdict,
  } } });
  return { ok: true, gate: next, note: next.next };
}
