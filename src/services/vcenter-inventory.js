// ---------------------------------------------------------------------------
// The machine inventory, from vCenter directly
// ---------------------------------------------------------------------------
/**
 * Why this exists: MTV should never have been a prerequisite for an ASSESSMENT.
 *
 * The Workload Modernization Agent read its VM list from MTV's inventory service,
 * which was convenient — MTV already holds the vCenter URL and credential, so
 * nothing had to be configured twice. But convenience became a dependency, and
 * the dependency is wrong in a way a customer will notice immediately:
 *
 *   MTV is a MIGRATION tool. Requiring it to ASSESS is like requiring a moving
 *   company before you are allowed to walk round the house.
 *
 * A customer evaluating whether to containerise has not necessarily decided to
 * migrate anything, may not have installed MTV, and should not have to install
 * an operator whose job is copying disks in order to be told which of their
 * machines are Tomcats. Red Hat's own architecture agrees: MTA 8 models this as
 * a "source platform" — a type, an API URL and a credential — with a pluggable
 * discovery provider per platform. Not as a dependency on a migration product.
 *
 * So inventory now has three sources, in order of preference:
 *
 *   1. vCenter DIRECTLY — this file. A configured vCenter needs no operator on
 *      the cluster at all.
 *   2. MTV, when it happens to be installed — reuses the credential it already
 *      holds, so nothing is configured twice. Still supported, no longer
 *      required.
 *   3. A supplied list — for an estate that is neither, or that is not VMware.
 *
 * Everything that talks to vCenter is here; the parsers are pure.
 */

import { vcSoap, vcenterConfig, xmlEscape } from "../utils/vcenter-client.js";

/** Properties worth one round trip. The same set guest-discovery reads. */
const VM_PROPS = [
  "name",
  "config.uuid",
  "config.instanceUuid",
  "config.template",
  "config.hardware.numCPU",
  "config.hardware.memoryMB",
  "runtime.powerState",
  "guest.guestFullName",
  "guest.guestId",
  "guest.hostName",
  "guest.ipAddress",
  "guest.toolsRunningStatus",
];

// ---------------------------------------------------------------------------
// Request builders — pure
// ---------------------------------------------------------------------------

/** A view over every VirtualMachine below the root folder. */
export function buildContainerViewBody({ viewManager = "ViewManager", rootFolder = "group-d1" }) {
  return `<CreateContainerView xmlns="urn:vim25">`
    + `<_this type="ViewManager">${xmlEscape(viewManager)}</_this>`
    + `<container type="Folder">${xmlEscape(rootFolder)}</container>`
    + `<type>VirtualMachine</type><recursive>true</recursive>`
    + `</CreateContainerView>`;
}

/**
 * Retrieve properties for everything in the view.
 *
 * The traversal spec is the part that is easy to get wrong: a ContainerView
 * holds its contents in a `view` property, so the selection walks
 * ContainerView → view → VirtualMachine. Without it the call returns the view
 * object itself and nothing else, which looks like an estate of one machine.
 */
export function buildInventoryBody({ propertyCollector = "propertyCollector", view }) {
  const paths = VM_PROPS.map((p) => `<pathSet>${p}</pathSet>`).join("");
  return `<RetrievePropertiesEx xmlns="urn:vim25">`
    + `<_this type="PropertyCollector">${xmlEscape(propertyCollector)}</_this>`
    + `<specSet>`
    + `<propSet><type>VirtualMachine</type><all>false</all>${paths}</propSet>`
    + `<objectSet>`
    + `<obj type="ContainerView">${xmlEscape(view)}</obj><skip>true</skip>`
    + `<selectSet xsi:type="TraversalSpec">`
    + `<name>viewToVm</name><type>ContainerView</type><path>view</path><skip>false</skip>`
    + `</selectSet>`
    + `</objectSet>`
    + `</specSet><options/></RetrievePropertiesEx>`;
}

/** Paging: vCenter returns a token when the result set is longer than one page. */
export function buildContinueBody({ propertyCollector = "propertyCollector", token }) {
  return `<ContinueRetrievePropertiesEx xmlns="urn:vim25">`
    + `<_this type="PropertyCollector">${xmlEscape(propertyCollector)}</_this>`
    + `<token>${xmlEscape(token)}</token></ContinueRetrievePropertiesEx>`;
}

export function buildDestroyViewBody(view) {
  return `<DestroyView xmlns="urn:vim25"><_this type="ContainerView">${xmlEscape(view)}</_this></DestroyView>`;
}

// ---------------------------------------------------------------------------
// Parsers — pure
// ---------------------------------------------------------------------------

export function parseViewRef(xml = "") {
  return /<returnval type="ContainerView"[^>]*>([^<]+)<\/returnval>/.exec(String(xml))?.[1]
    || /<returnval[^>]*>(session\[[^<]+\]|[\w-]+)<\/returnval>/.exec(String(xml))?.[1]
    || null;
}

/** The continuation token, when there is another page. */
export function parseToken(xml = "") {
  return /<token>([^<]+)<\/token>/.exec(String(xml))?.[1] || null;
}

const unescapeXml = (s) => String(s ?? "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, "&");

/**
 * One record per machine, in the shape the rest of the pipeline already joins
 * on — the same keys MTV's inventory produced, so nothing downstream has to
 * know which source it came from.
 */
export function parseInventory(xml = "") {
  const out = [];
  for (const block of String(xml).split(/<objects>/).slice(1)) {
    const id = /<obj type="VirtualMachine"[^>]*>([^<]+)<\/obj>/.exec(block)?.[1];
    if (!id) continue;
    const props = {};
    for (const m of block.matchAll(/<propSet><name>([^<]+)<\/name><val[^>]*>([\s\S]*?)<\/val><\/propSet>/g)) {
      props[m[1]] = unescapeXml(m[2]).trim();
    }
    // Templates are not running machines. They carry no processes, cannot be
    // read inside, and counting them would inflate the denominator of every
    // percentage this product reports.
    if (props["config.template"] === "true") continue;

    const mem = Number(props["config.hardware.memoryMB"]);
    out.push({
      id,
      name: props.name || null,
      guestOS: props["guest.guestFullName"] || null,
      guestId: props["guest.guestId"] || null,
      hostname: props["guest.hostName"] || null,
      ipAddress: props["guest.ipAddress"] || null,
      biosUuid: props["config.uuid"] || null,
      instanceUuid: props["config.instanceUuid"] || null,
      powerState: props["runtime.powerState"] || null,
      poweredOn: /poweredOn/i.test(props["runtime.powerState"] || ""),
      cpuCount: Number(props["config.hardware.numCPU"]) || null,
      memoryGiB: Number.isFinite(mem) ? Math.round((mem / 1024) * 10) / 10 : null,
      toolsRunningStatus: props["guest.toolsRunningStatus"] || null,
      source: "vcenter",
    });
  }
  return out;
}

/** Case-insensitive substring, the same filter MTV's search applied. */
export function filterByName(vms = [], search = "") {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return vms;
  return vms.filter((v) => String(v.name || "").toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
/**
 * List the machines a vCenter knows about. Never throws.
 *
 * @returns {{vms:Array, source:string, reason:string|null, vcenter:string|null}}
 */
export async function listVcenterInventory({ cfg = null, search = "", limit = 5000 } = {}) {
  cfg = cfg || vcenterConfig();
  if (!cfg.configured) return { vms: [], source: "none", reason: cfg.reason, vcenter: null };

  let view = null;
  try {
    const viewXml = await vcSoap(() => buildContainerViewBody({}), { cfg, timeoutMs: 45_000 });
    view = parseViewRef(viewXml);
    if (!view) {
      return { vms: [], source: "error", vcenter: cfg.url, reason: "vCenter did not return a container view, so the inventory could not be walked." };
    }

    const vms = [];
    let xml = await vcSoap(() => buildInventoryBody({ view }), { cfg, timeoutMs: 120_000 });
    vms.push(...parseInventory(xml));
    let token = parseToken(xml);
    // Paged deliberately rather than assumed to fit: a real estate is thousands
    // of machines and vCenter will not hand them over in one response.
    while (token && vms.length < limit) {
      xml = await vcSoap(() => buildContinueBody({ token }), { cfg, timeoutMs: 120_000 });
      vms.push(...parseInventory(xml));
      token = parseToken(xml);
    }

    return {
      vms: filterByName(vms, search).slice(0, limit),
      source: "vcenter", vcenter: cfg.url, reason: null,
      total: vms.length,
    };
  } catch (e) {
    return { vms: [], source: "error", vcenter: cfg.url, reason: `vCenter would not return its inventory: ${e.message}` };
  } finally {
    // A view left behind is a server-side object that lives until the session
    // expires. Harmless once; on a polling agent it is a leak.
    if (view) { try { await vcSoap(() => buildDestroyViewBody(view), { cfg, timeoutMs: 15_000 }); } catch { /* best effort */ } }
  }
}
