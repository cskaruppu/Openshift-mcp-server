// ---------------------------------------------------------------------------
// In-guest discovery
// ---------------------------------------------------------------------------
/**
 * What is actually RUNNING inside a virtual machine.
 *
 * vCenter tells you the shape of the box — cores, memory, disks, NICs, guest
 * OS string. It does not tell you that the box is a Tomcat serving one war
 * file, or a Postgres nobody documented, and that difference is the entire
 * containerisation decision. Every assessment tool that skips this step is
 * guessing from the VM name.
 *
 * Two layers, because they cost different things:
 *
 *   1. GUEST PROPERTIES — free. VMware Tools already reports the OS, hostname,
 *      addresses and filesystem usage up to vCenter, so one property read
 *      covers the whole wave with the credential the product already holds.
 *
 *   2. PROCESS LIST — needs a credential INSIDE the guest. ListProcessesInGuest
 *      returns name, owner and command line inline in the SOAP response, with
 *      no file transfer and nothing installed and nothing written to the guest.
 *      That is the cheapest possible read of the one fact that matters most.
 *
 * Deliberately NOT here: running a probe script via StartProgramInGuest. It
 * would give listening ports, unit files and package lists, but it executes
 * code inside a machine somebody else owns and needs file transfer to collect
 * the output. That is a different conversation with a customer, and a tool
 * that quietly runs commands in production guests does not deserve to be
 * trusted. Ports and units are therefore reported as UNREAD, not as absent.
 *
 * The rule, the same one source-readiness.js runs on:
 *   A FACT NOT READ IS NOT A FACT OF ZERO.
 * No processes read is never reported as "no processes running".
 */

import { vcSoap, vcenterConfig, xmlEscape } from "../utils/vcenter-client.js";

/** How many machines to ask for guest properties in one call. */
export const PROPERTY_BATCH = 100;

/** Guest facts vCenter will hand over without a credential inside the guest. */
const GUEST_PROPS = [
  "name",
  "runtime.powerState",
  // Identity, for de-duplicating a fleet. The BIOS UUID follows the machine
  // and is what makes "the same VM registered in two clusters" a fact rather
  // than a guess from matching hostnames — two machines legitimately share a
  // hostname more often than anyone expects.
  "config.uuid",
  "config.instanceUuid",
  "guest.guestFullName",
  "guest.guestFamily",
  "guest.guestId",
  "guest.hostName",
  "guest.ipAddress",
  "guest.toolsRunningStatus",
  "guest.toolsVersionStatus2",
  "guest.guestState",
  // The mount table, with capacity and free space per filesystem. VMware Tools
  // already reports this to vCenter, so it costs nothing beyond the property
  // read already being made — and it is the fact the containerisation decision
  // turns on most often after the process list. A machine with a 400GB mount
  // at /var/lib/pgsql is not a container candidate whatever its process list
  // said, and until this was read the agent had to say "no volume claimed,
  // because local state cannot be identified without reading the filesystem".
  "guest.disk",
];

// ---------------------------------------------------------------------------
// Request builders — pure, so the wire format is testable without a vCenter
// ---------------------------------------------------------------------------

/**
 * RetrievePropertiesEx over a set of VirtualMachine MoRefs.
 *
 * One objectSet per VM rather than a container view with a traversal spec:
 * the caller already knows exactly which machines are in the wave, and a
 * traversal would walk the whole inventory to find them again.
 */
export function buildGuestPropertiesBody({ propertyCollector = "propertyCollector", vmIds = [] }) {
  const objects = vmIds
    .map((id) => `<objectSet><obj type="VirtualMachine">${xmlEscape(id)}</obj><skip>false</skip></objectSet>`)
    .join("");
  const paths = GUEST_PROPS.map((p) => `<pathSet>${p}</pathSet>`).join("");
  return `<RetrievePropertiesEx xmlns="urn:vim25">`
    + `<_this type="PropertyCollector">${xmlEscape(propertyCollector)}</_this>`
    + `<specSet><propSet><type>VirtualMachine</type><all>false</all>${paths}</propSet>${objects}</specSet>`
    + `<options/></RetrievePropertiesEx>`;
}

/** The GuestOperationsManager owns a processManager; read it rather than guess. */
export function buildProcessManagerLookupBody({ propertyCollector = "propertyCollector", guestOperationsManager }) {
  return `<RetrievePropertiesEx xmlns="urn:vim25">`
    + `<_this type="PropertyCollector">${xmlEscape(propertyCollector)}</_this>`
    + `<specSet>`
    + `<propSet><type>GuestOperationsManager</type><all>false</all><pathSet>processManager</pathSet></propSet>`
    + `<objectSet><obj type="GuestOperationsManager">${xmlEscape(guestOperationsManager)}</obj><skip>false</skip></objectSet>`
    + `</specSet><options/></RetrievePropertiesEx>`;
}

/**
 * ListProcessesInGuest for one machine.
 *
 * interactiveSession is false on purpose: an interactive session requires a
 * user to already be logged in at the console, which on a server is almost
 * never true, and asking for one turns a working read into InvalidGuestLogin.
 */
export function buildListProcessesBody({ processManager, vmId, username, password }) {
  return `<ListProcessesInGuest xmlns="urn:vim25">`
    + `<_this type="GuestProcessManager">${xmlEscape(processManager)}</_this>`
    + `<vm type="VirtualMachine">${xmlEscape(vmId)}</vm>`
    + `<auth xsi:type="NamePasswordAuthentication">`
    + `<interactiveSession>false</interactiveSession>`
    + `<username>${xmlEscape(username)}</username>`
    + `<password>${xmlEscape(password)}</password>`
    + `</auth></ListProcessesInGuest>`;
}

// ---------------------------------------------------------------------------
// Response parsers — pure
// ---------------------------------------------------------------------------

const tag = (xml, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
};

/** XML entities, in the four forms vCenter emits. */
export function unescapeXml(s) {
  return String(s ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * The guest mount table out of a `guest.disk` property value.
 *
 * Unlike every other property here this one is an array of structures, so it
 * is parsed from the raw block before the flat name/val sweep gets to it — the
 * sweep would hand back a string of XML.
 *
 * `capacity` and `freeSpace` are bytes, as 64-bit values that comfortably
 * exceed Number.MAX_SAFE_INTEGER only above 9 petabytes, so Number is safe and
 * BigInt would make every consumer awkward for no gain.
 *
 * filesystemType is vSphere 7+; older appliances omit it, and it comes back
 * null rather than guessed from the path.
 */
export function parseGuestDisks(block = "") {
  const val = /<propSet><name>guest\.disk<\/name><val[^>]*>([\s\S]*?)<\/val><\/propSet>/.exec(String(block))?.[1];
  if (!val) return null;                       // not reported — not "no disks"
  const disks = [];
  for (const m of val.matchAll(/<GuestDiskInfo[^>]*>([\s\S]*?)<\/GuestDiskInfo>/g)) {
    const b = m[1];
    const path = unescapeXml(tag(b, "diskPath") || "") || null;
    if (!path) continue;
    const capacity = Number(tag(b, "capacity"));
    const free = Number(tag(b, "freeSpace"));
    disks.push({
      path,
      capacityBytes: Number.isFinite(capacity) ? capacity : null,
      freeBytes: Number.isFinite(free) ? free : null,
      usedBytes: Number.isFinite(capacity) && Number.isFinite(free) ? capacity - free : null,
      filesystemType: unescapeXml(tag(b, "filesystemType") || "") || null,
    });
  }
  return disks;
}

/**
 * Turn a RetrievePropertiesEx response into one record per machine.
 *
 * Each objects block carries the MoRef and a flat list of name/val pairs, so
 * the parse is per-object rather than a global sweep — otherwise a machine
 * that reported nothing would silently inherit the previous machine's values.
 */
export function parseGuestProperties(xml = "") {
  const out = new Map();
  for (const block of String(xml).split(/<objects>/).slice(1)) {
    const id = /<obj type="VirtualMachine"[^>]*>([^<]+)<\/obj>/.exec(block)?.[1];
    if (!id) continue;
    const props = {};
    for (const m of block.matchAll(/<propSet><name>([^<]+)<\/name><val[^>]*>([\s\S]*?)<\/val><\/propSet>/g)) {
      props[m[1]] = unescapeXml(m[2]).trim();
    }
    const running = props["guest.toolsRunningStatus"] || null;
    out.set(id, {
      vmId: id,
      name: props.name || null,
      powerState: props["runtime.powerState"] || null,
      os: {
        fullName: props["guest.guestFullName"] || null,
        family: props["guest.guestFamily"] || null,
        id: props["guest.guestId"] || null,
      },
      hostname: props["guest.hostName"] || null,
      biosUuid: props["config.uuid"] || null,
      instanceUuid: props["config.instanceUuid"] || null,
      ipAddress: props["guest.ipAddress"] || null,
      toolsRunningStatus: running,
      // Tri-state on purpose. null means vCenter did not report the field at
      // all, which is a different problem from Tools being installed and
      // stopped, and they need different advice.
      toolsRunning: running == null ? null : running === "guestToolsRunning",
      guestState: props["guest.guestState"] || null,
      // null when vCenter did not report the property — which is a different
      // thing from a machine with no mounts, and the scorer must not read one
      // as the other.
      disks: parseGuestDisks(block),
    });
  }
  return out;
}

/** The processManager MoRef out of a GuestOperationsManager property read. */
export function parseProcessManager(xml = "") {
  return /<propSet><name>processManager<\/name><val[^>]*>([^<]+)<\/val><\/propSet>/.exec(String(xml))?.[1] || null;
}

/**
 * ListProcessesInGuest returns one <returnval> per process.
 *
 * cmdLine is the field that matters — "java" tells you nothing, and the same
 * `java` command line tells you it is Tomcat, which war file it serves, and
 * which JVM. It is also the field most likely to contain XML-escaped quotes,
 * hence the unescape.
 */
export function parseProcessList(xml = "") {
  const procs = [];
  for (const m of String(xml).matchAll(/<returnval>([\s\S]*?)<\/returnval>/g)) {
    const b = m[1];
    const name = tag(b, "name");
    if (!name) continue;
    procs.push({
      pid: Number(tag(b, "pid")) || null,
      name: unescapeXml(name),
      owner: unescapeXml(tag(b, "owner") || "") || null,
      cmdLine: unescapeXml(tag(b, "cmdLine") || "") || null,
      startTime: tag(b, "startTime") || null,
    });
  }
  return procs;
}

/**
 * What a guest-operations failure actually means, in the guest owner's terms.
 *
 * These four faults are the whole population in practice and they have four
 * completely different fixes — "could not read processes" as a single message
 * sends someone to the wrong team every time.
 */
export function categoriseGuestOpError(message = "") {
  const m = String(message);
  if (/InvalidGuestLogin|Failed to authenticate/i.test(m)) return "credential-rejected";
  if (/GuestOperationsUnavailable|guest operations agent|not (?:currently )?(?:running|available)/i.test(m)) return "tools-not-answering";
  if (/NoPermission|Permission to perform this operation was denied|GuestOperations\.Query/i.test(m)) return "vcenter-privilege";
  if (/NotSupported|not supported/i.test(m)) return "guest-unsupported";
  return "other";
}

export function describeGuestOpError(message = "") {
  const m = String(message);
  if (/InvalidGuestLogin|Failed to authenticate/i.test(m)) {
    return "The guest credential was rejected inside the machine. This is a local or domain account on the guest itself, not a vCenter login.";
  }
  if (/GuestOperationsUnavailable|guest operations agent|not (?:currently )?(?:running|available)/i.test(m)) {
    return "VMware Tools is not answering guest operations. It is installed but stopped, or the machine is still booting.";
  }
  if (/NoPermission|Permission to perform this operation was denied|GuestOperations\.Query/i.test(m)) {
    return "The vCenter account is missing the Guest Operations privilege. Grant Virtual Machine → Guest Operations → Guest Operation Program Execution (query) on this machine.";
  }
  if (/NotSupported|not supported/i.test(m)) {
    return "This guest OS does not support guest operations through VMware Tools.";
  }
  return m;
}

// ---------------------------------------------------------------------------
// The facts we could not read — listed, always
// ---------------------------------------------------------------------------
/**
 * Named here rather than left implicit, because the scorer must be able to say
 * which checks did not run. A tool that silently omits what it could not see
 * is indistinguishable from one that saw nothing wrong.
 */
export const UNREAD_WITHOUT_PROBE = Object.freeze([
  // Retired on Linux by guest-files.js, which reads /proc/net/tcp rather than
  // running `ss`. It stays in the list because the read is opt-in, needs a
  // guest credential, and has no equivalent on Windows — so for any machine
  // where it did not happen this is still the honest line. The orchestrator
  // removes it per machine once the ports have actually been read.
  { fact: "listeningPorts", reason: "Listening ports were not read. On Linux the agent can read them from /proc/net/tcp with a guest credential; on Windows there is no equivalent that does not run a command." },
  { fact: "services", reason: "systemd units and Windows services are not exposed without running a command inside the guest." },
  { fact: "packages", reason: "Installed packages and runtime versions are not exposed without running a command inside the guest." },
  { fact: "scheduledJobs", reason: "cron and Scheduled Tasks are not exposed without running a command inside the guest." },
  { fact: "kernelModules", reason: "Loaded kernel modules and drivers are not exposed without running a command inside the guest." },
  { fact: "configFiles", reason: "Application config and hardcoded addresses require reading files inside the guest." },
]);

/** An empty fact set for one machine, with the reason it is empty. */
export function unreadableGuest(vm, reason) {
  return {
    vmId: vm?.id || null,
    name: vm?.name || null,
    source: "none",
    powerState: vm?.powerState || null,
    os: { fullName: vm?.guestOS || vm?.osType || null, family: null, id: null },
    hostname: null,
    biosUuid: null,
    instanceUuid: null,
    ipAddress: null,
    toolsRunning: null,
    disks: null,
    processes: null,
    processReason: reason,
    ports: null,
    portReason: reason,
    unread: [...UNREAD_WITHOUT_PROBE],
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
/**
 * Discover what is running inside these machines.
 *
 * Never throws. A vCenter that will not answer, a guest with no Tools and a
 * machine that is powered off are three different outcomes, and each one comes
 * back as a record saying which it was — the caller renders the reason.
 *
 * @param {Array}  vms                      [{ id, name, ... }] — id is the vCenter MoRef
 * @param {object} opts.cfg                 vCenter credential (defaults to the configured one)
 * @param {object} opts.guestCredentials    { "<vm name or id>": {username,password} } or { "*": {...} }
 * @param {boolean} opts.readPorts          also read /proc/net/tcp for listening ports (Linux, opt-in)
 * @returns {{guests: Map<string,object>, source: string, reason: string|null, coverage: object}}
 */
export async function discoverGuests(vms = [], { cfg = null, guestCredentials = null, readPorts = false } = {}) {
  cfg = cfg || vcenterConfig();
  const coverage = { total: vms.length, properties: 0, processes: 0, failures: {} };
  const guests = new Map();

  if (!cfg.configured) {
    for (const vm of vms) guests.set(vm.id || vm.name, unreadableGuest(vm, cfg.reason));
    return { guests, source: "none", reason: cfg.reason, coverage };
  }

  const withIds = vms.filter((v) => v.id);
  if (!withIds.length) {
    const reason = "No machine in this selection carries a vCenter managed object id, so nothing can be looked up in the guest.";
    for (const vm of vms) guests.set(vm.id || vm.name, unreadableGuest(vm, reason));
    return { guests, source: "none", reason, coverage };
  }

  // ── Layer 1: guest properties ──────────────────────────────────────────
  let props = new Map();
  try {
    for (let i = 0; i < withIds.length; i += PROPERTY_BATCH) {
      const batch = withIds.slice(i, i + PROPERTY_BATCH);
      const xml = await vcSoap(() => buildGuestPropertiesBody({ vmIds: batch.map((v) => v.id) }), { cfg, timeoutMs: 60_000 });
      for (const [k, v] of parseGuestProperties(xml)) props.set(k, v);
    }
  } catch (e) {
    const reason = `vCenter would not return guest properties: ${e.message}`;
    for (const vm of vms) guests.set(vm.id || vm.name, unreadableGuest(vm, reason));
    return { guests, source: "none", reason, coverage };
  }

  for (const vm of vms) {
    const key = vm.id || vm.name;
    const p = vm.id ? props.get(vm.id) : null;
    if (!p) {
      guests.set(key, unreadableGuest(vm, "vCenter returned no guest properties for this machine."));
      continue;
    }
    coverage.properties++;
    guests.set(key, {
      ...p,
      name: p.name || vm.name || null,
      source: "vcenter-guest",
      processes: null,
      processReason: null,
      unread: [...UNREAD_WITHOUT_PROBE],
    });
  }

  // ── Layer 2: process list, only where a guest credential exists ────────
  if (!guestCredentials || !Object.keys(guestCredentials).length) {
    for (const g of guests.values()) {
      if (g.processes === null && !g.processReason) {
        g.processReason = "No guest credential was supplied, so what runs inside this machine was not read.";
      }
    }
    return { guests, source: "vcenter-guest", reason: null, coverage };
  }

  let processManager = null;
  try {
    const xml = await vcSoap((s) => buildProcessManagerLookupBody({ guestOperationsManager: s.guestOperationsManager }), { cfg, timeoutMs: 30_000 });
    processManager = parseProcessManager(xml);
  } catch (e) {
    for (const g of guests.values()) if (g.processes === null) g.processReason = describeGuestOpError(e.message);
    return { guests, source: "vcenter-guest", reason: describeGuestOpError(e.message), coverage };
  }
  if (!processManager) {
    const reason = "This vCenter did not report a guest process manager, so guest operations are unavailable.";
    for (const g of guests.values()) if (g.processes === null) g.processReason = reason;
    return { guests, source: "vcenter-guest", reason, coverage };
  }

  for (const vm of withIds) {
    const g = guests.get(vm.id || vm.name);
    if (!g) continue;

    // Both of these are ordinary states, not errors, and each needs its own
    // sentence — "could not read" for a powered-off machine sends someone
    // hunting a credential problem that does not exist.
    if (g.powerState && !/poweredOn/i.test(g.powerState)) {
      g.processReason = `The machine is ${g.powerState}. Nothing can be read from inside a machine that is not running.`;
      g.processFailure = "powered-off";
      continue;
    }
    if (g.toolsRunning === false) {
      g.processReason = "VMware Tools is not running in this guest, so what runs inside it cannot be read.";
      g.processFailure = "tools-not-running";
      continue;
    }

    const cred = credentialFor(vm, guestCredentials);
    if (!cred) {
      g.processReason = "No guest credential was supplied for this machine.";
      g.processFailure = "no-credential";
      continue;
    }

    try {
      const xml = await vcSoap(() => buildListProcessesBody({
        processManager, vmId: vm.id, username: cred.username, password: cred.password,
      }), { cfg, timeoutMs: 60_000 });
      g.processes = parseProcessList(xml);
      g.source = "vcenter-guest+processes";
      g.processReason = null;
      // A guest that answers with an empty list is genuinely idle — that IS a
      // fact, unlike a guest that refused to answer.
      coverage.processes++;
    } catch (e) {
      g.processReason = describeGuestOpError(e.message);
      // Categorised as well as described: a fleet where forty machines share
      // one root password and ten have their own needs those ten GROUPED, not
      // ten identical sentences the operator has to read one at a time.
      g.processFailure = categoriseGuestOpError(e.message);
      coverage.failures[g.processFailure] = (coverage.failures[g.processFailure] || 0) + 1;
    }
  }

  // ── Layer 3: listening ports, read from /proc rather than run ──────────
  if (readPorts) await readListeningPorts(withIds, guests, { cfg, guestCredentials, coverage });

  return {
    guests,
    source: coverage.processes ? "vcenter-guest+processes" : "vcenter-guest",
    reason: null,
    coverage,
  };
}

/**
 * Fill in `ports` for every machine whose processes were read.
 *
 * Only those machines: a guest that would not hand over its process list will
 * not hand over /proc either, and asking produces a second identical failure
 * the operator has to read twice.
 *
 * The file manager is resolved once for the whole wave rather than per
 * machine — it is a property of the vCenter, not of the guest.
 */
async function readListeningPorts(vms, guests, { cfg, guestCredentials, coverage }) {
  const { readGuestFile, resolveFileManager } = await import("./guest-files.js");
  const { listeningPorts } = await import("./guest-ports.js");

  let fileManager = null;
  try {
    fileManager = await resolveFileManager(cfg);
  } catch (e) {
    for (const g of guests.values()) {
      if (g.ports === undefined || g.ports === null) g.portReason = describeGuestOpError(e.message);
    }
    return;
  }

  for (const vm of vms) {
    const g = guests.get(vm.id || vm.name);
    if (!g) continue;
    if (g.processes === null) {
      g.ports = null;
      g.portReason = g.processReason || "Nothing inside this machine was read.";
      continue;
    }
    // Windows has no /proc. Say so once, here, rather than letting two file
    // reads fail and reporting it as a problem.
    if (/windows/i.test(g.os?.family || g.os?.fullName || "")) {
      g.ports = null;
      g.portReason = "This is a Windows guest. /proc does not exist, and there is no Windows equivalent this agent can read without running a command.";
      g.portFailure = "windows";
      continue;
    }

    const cred = credentialFor(vm, guestCredentials);
    if (!cred) { g.ports = null; g.portReason = "No guest credential was supplied for this machine."; continue; }

    const common = { vmId: vm.id, username: cred.username, password: cred.password, cfg, fileManager };
    const v4 = await readGuestFile({ ...common, fileId: "net-tcp" });
    const v6 = await readGuestFile({ ...common, fileId: "net-tcp6" });

    if (!v4.ok && !v6.ok) {
      g.ports = null;
      g.portReason = v4.reason || v6.reason;
      g.portFailure = v4.failure || v6.failure;
      coverage.failures[`ports:${g.portFailure}`] = (coverage.failures[`ports:${g.portFailure}`] || 0) + 1;
      continue;
    }

    const read = listeningPorts({ tcp: v4.ok ? v4.text : null, tcp6: v6.ok ? v6.text : null });
    g.ports = read.ports;
    g.portReason = null;
    // An IPv6-only read is a partial answer, not a complete one, and the
    // difference matters for a service bound to 0.0.0.0 only.
    g.portsPartial = !(v4.ok && v6.ok);
    g.unread = (g.unread || []).filter((u) => u.fact !== "listeningPorts");
    coverage.ports = (coverage.ports || 0) + 1;
  }
}

/** Per-machine credential, falling back to a wildcard. Name or id may key it. */
export function credentialFor(vm, creds = {}) {
  const c = creds[vm.id] || creds[vm.name] || creds["*"] || null;
  return c && c.username && c.password ? c : null;
}
