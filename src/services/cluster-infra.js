// What a cluster runs on — bare metal (and whose servers), VMware, another
// hypervisor or a cloud — for the cluster cards. Detected, in order:
//
//   1. OpenShift's Infrastructure resource: status.platformStatus.type
//      (VSphere, BareMetal, AWS, Azure, Nutanix, …)
//   2. the nodes' providerID scheme (vsphere://, aws://, …)
//   3. the machine this pod runs on, from /sys/class/dmi/id: "Dell Inc." /
//      "PowerEdge R760xa" on bare metal, "VMware, Inc." in a VM. Needed for
//      platform None / External installs (common for bare-metal agent-based
//      installs), where 1 and 2 say nothing. Only for the pod's own cluster.
//
// When none of them is conclusive the result is null: the card shows the CPU
// instead of a guess.

import { readFile } from "node:fs/promises";
import { ocpGet } from "../utils/openshift-client.js";

const PLATFORM = {
  vsphere: { kind: "vsphere", name: "VMware vSphere" },
  baremetal: { kind: "baremetal", name: "Bare metal" },
  aws: { kind: "cloud", name: "AWS" }, azure: { kind: "cloud", name: "Azure" }, gcp: { kind: "cloud", name: "Google Cloud" },
  ibmcloud: { kind: "cloud", name: "IBM Cloud" }, powervs: { kind: "cloud", name: "IBM Power VS" }, alibabacloud: { kind: "cloud", name: "Alibaba Cloud" },
  nutanix: { kind: "virtual", name: "Nutanix AHV" }, openstack: { kind: "virtual", name: "OpenStack" }, ovirt: { kind: "virtual", name: "Red Hat Virtualization" },
  kubevirt: { kind: "virtual", name: "OpenShift Virtualization" },
};
const PROVIDER_ID = { vsphere: "vsphere", aws: "aws", azure: "azure", gce: "gcp", openstack: "openstack", ibm: "ibmcloud", nutanix: "nutanix", kubevirt: "kubevirt", baremetalhost: "baremetal", "metal3": "baremetal" };

// sys_vendor → hypervisor (a VM) or server maker (bare metal).
const HYPERVISOR = [[/vmware/i, { kind: "vsphere", name: "VMware vSphere" }], [/qemu|red hat|kvm/i, { kind: "virtual", name: "KVM" }],
  [/microsoft corporation/i, { kind: "virtual", name: "Hyper-V" }], [/nutanix/i, { kind: "virtual", name: "Nutanix AHV" }],
  [/xen/i, { kind: "virtual", name: "Xen" }], [/innotek|virtualbox/i, { kind: "virtual", name: "VirtualBox" }],
  [/amazon ec2/i, { kind: "cloud", name: "AWS" }], [/google/i, { kind: "cloud", name: "Google Cloud" }]];
const MAKER = [[/^dell/i, "Dell"], [/^(hpe|hewlett)/i, "HPE"], [/lenovo/i, "Lenovo"], [/supermicro/i, "Supermicro"], [/cisco/i, "Cisco"],
  [/fujitsu/i, "Fujitsu"], [/inspur/i, "Inspur"], [/huawei|xfusion/i, "Huawei"], [/quanta/i, "Quanta"], [/gigabyte/i, "Gigabyte"], [/nvidia/i, "NVIDIA"]];

const FAMILY_NAME = { powerflex: "PowerFlex", vxrail: "VxRail", powerscale: "PowerScale", apex: "APEX", poweredge: "PowerEdge", proliant: "ProLiant", thinksystem: "ThinkSystem", thinkagile: "ThinkAgile", ucs: "UCS", primergy: "PRIMERGY", dgx: "DGX", hgx: "HGX", superserver: "SuperServer", synergy: "Synergy", apollo: "Apollo", edgeline: "Edgeline" };

/** Turn sys_vendor + product_name into what the machine is. */
export function fromDmi(vendor, product) {
  const v = String(vendor || "").trim(), p = String(product || "").trim();
  if (!v && !p) return null;
  const hv = HYPERVISOR.find(([re]) => re.test(v) || re.test(p));
  if (hv) return { ...hv[1], source: "machine" };
  const maker = MAKER.find(([re]) => re.test(v));
  if (!maker) return null;
  // "PowerEdge R760xa" → family "PowerEdge", model "R760xa"
  // Dell's engineered lines (PowerFlex, VxRail, …) name the system better than the server inside them.
  const fam = p.match(/\b(PowerFlex|VxRail|PowerScale|APEX|PowerEdge|ProLiant|ThinkSystem|ThinkAgile|UCS|PRIMERGY|DGX|HGX|SuperServer|Synergy|Apollo|Edgeline|XE\d{4})\b/i);
  const family = fam ? FAMILY_NAME[fam[1].toLowerCase()] || fam[1] : null;
  return { kind: "baremetal", name: "Bare metal", maker: maker[1], family, model: p || null, source: "machine" };
}

let _dmi;
async function localDmi() {
  if (_dmi !== undefined) return _dmi;
  const rd = (f) => readFile(`/sys/class/dmi/id/${f}`, "utf8").then((s) => s.trim()).catch(() => "");
  const [vendor, product] = await Promise.all([rd("sys_vendor"), rd("product_name")]);
  _dmi = fromDmi(vendor, product);
  return _dmi;
}

/** From the Infrastructure resource and node providerIDs. Pure: the inputs are passed in. */
export function fromPlatform(platformType, nodes) {
  const t = String(platformType || "").toLowerCase();
  if (PLATFORM[t]) return { ...PLATFORM[t], source: "platform" };
  const schemes = new Map();
  for (const n of nodes || []) {
    const scheme = String(n.spec?.providerID || "").split("://")[0].toLowerCase();
    if (PROVIDER_ID[scheme]) schemes.set(PROVIDER_ID[scheme], (schemes.get(PROVIDER_ID[scheme]) || 0) + 1);
  }
  const top = [...schemes.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? { ...PLATFORM[top[0]], source: "providerID" } : null;
}

const _platformCache = new Map(); // cacheKey → { at, type }
async function platformType(cacheKey, now) {
  const c = _platformCache.get(cacheKey);
  if (c && now - c.at < 10 * 60_000) return c.type;
  let type = null;
  try {
    const inf = await ocpGet("/apis/config.openshift.io/v1/infrastructures/cluster");
    type = inf?.status?.platformStatus?.type || inf?.status?.platform || null;
  } catch { /* not OpenShift, or not allowed */ }
  _platformCache.set(cacheKey, { at: now, type });
  return type;
}

/**
 * What the cluster in the current context runs on, or null when unknown.
 * A bare-metal (or platform None) cluster seen from its own pod also gets the
 * server maker and model.
 */
export async function clusterInfra(nodes, { cacheKey = "local", now = Date.now() } = {}) {
  const fromApi = fromPlatform(await platformType(cacheKey, now), nodes);
  const machine = cacheKey === "local" ? await localDmi() : null;
  if (fromApi && fromApi.kind !== "baremetal") return fromApi;
  if (fromApi?.kind === "baremetal") return machine?.kind === "baremetal" ? { ...machine, source: "platform" } : fromApi;
  return machine; // platform None / External, or not OpenShift: the machine decides
}

export function _resetInfra() { _dmi = undefined; _platformCache.clear(); }
export function _setDmiForTest(v) { _dmi = v; }
