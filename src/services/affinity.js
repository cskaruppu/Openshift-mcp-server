// ---------------------------------------------------------------------------
// Move-together groups
// ---------------------------------------------------------------------------
/**
 * Which machines are probably one working system, so a wave does not cut one in
 * half.
 *
 * MTV has no concept of an application. It sees fourteen unrelated VMs, and it
 * will happily let you migrate the web tier this Saturday and the database it
 * talks to next month. Both migrations succeed. For a month the system is split
 * across two platforms with different networks, different latency and firewall
 * rules that do not exist yet on one side.
 *
 * This is INFERENCE, not knowledge, and it is labelled as such everywhere. It
 * reads only what discovery already collects — addresses, names, vCenter folder,
 * datastores — and every group carries the evidence behind it so a person can
 * disagree in one glance. It never blocks anything; it warns when a selection
 * splits a group, which is the moment the information is worth having.
 *
 * Everything here is pure.
 *
 * NOTE: the companion splitGroups() — "which groups does this selection cut in
 * half" — lives in console/src/lib/affinity.js, not here. It depends on what is
 * ticked in the browser right now, so only the console calls it, and the two
 * container images have disjoint build contexts: the console image copies only
 * console/, this one copies only src/. A file imported across that line
 * resolves on a developer's disk and fails in the build.
 */

/**
 * A subnet shared by half the estate is a network, not an application. Above
 * this many members the signal says nothing and is dropped rather than
 * generating a group nobody believes.
 */
export const MAX_SUBNET_MEMBERS = 8;
/** Same idea for a naming convention: "vm###" across forty machines is a policy. */
export const MAX_SHAPE_MEMBERS = 12;
/** And for a datastore, which is usually shared by everything on a cluster. */
export const MAX_DATASTORE_MEMBERS = 6;

/** The /24 an IPv4 address sits in. IPv6 and loopback are ignored. */
export function subnetOf(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(String(ip || "").trim());
  if (!m) return null;
  const [a, b, c] = [m[1], m[2], m[3]].map(Number);
  if ([a, b, c].some((n) => n > 255)) return null;
  if (a === 127 || (a === 169 && b === 254)) return null;    // loopback, link-local
  return `${a}.${b}.${c}.0/24`;
}

/**
 * The shape of a name with its numbers removed: "HDS071075-mvm2" and
 * "HDS071076-mvm3" are both "hds#-mvm#".
 *
 * This is what makes a naming convention legible as a signal. A name with no
 * digits at all has no shape worth comparing — "backup" and "jenkins" would
 * otherwise look identical.
 */
export function nameShape(name) {
  const s = String(name || "").toLowerCase().trim();
  if (!s) return null;
  if (!/\d/.test(s)) return null;
  const shape = s.replace(/\d+/g, "#");
  // A name that is only digits and separators tells us nothing.
  return /[a-z]/.test(shape) ? shape : null;
}

/** The vCenter folder a VM lives in — its path with the VM's own name removed. */
export function folderOf(vm) {
  const p = vm.path || vm.folder || null;
  if (!p) return null;
  const parts = String(p).split("/").filter(Boolean);
  if (parts.length < 2) return null;
  parts.pop();                                    // drop the VM itself
  return "/" + parts.join("/");
}

/** Every signal one VM emits. Pure. */
export function signalsFor(vm = {}) {
  return {
    subnets: [...new Set((vm.ips || []).map(subnetOf).filter(Boolean))],
    shape: nameShape(vm.name),
    folder: folderOf(vm),
    datastores: [...new Set(vm.datastores || [])],
  };
}

// ── Grouping ───────────────────────────────────────────────────────────────
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  return { find, union: (a, b) => { const [x, y] = [find(a), find(b)]; if (x !== y) parent[x] = y; } };
}

/**
 * Group VMs that look like one system.
 *
 * The joining rule, chosen so a group is worth reading rather than merely
 * plausible: a shared vCenter FOLDER is enough on its own, because a folder is
 * a deliberate human act. Everything else needs corroboration — two weak
 * signals agreeing, never one alone. A shared subnet by itself would group
 * every machine on a flat network.
 *
 * @param {Array} vms  normalised VMs: { name, ips[], path, datastores[] }
 * @returns {Array} groups, each with members, evidence and a confidence
 */
export function affinityGroups(vms = []) {
  if (vms.length < 2) return [];
  const sig = vms.map(signalsFor);

  // Count members per signal value, so an over-populated signal can be dropped.
  const tally = (get) => {
    const m = new Map();
    sig.forEach((s, i) => { for (const v of get(s)) m.set(v, [...(m.get(v) || []), i]); });
    return m;
  };
  const subnets = tally((s) => s.subnets);
  const shapes = tally((s) => (s.shape ? [s.shape] : []));
  const folders = tally((s) => (s.folder ? [s.folder] : []));
  const stores = tally((s) => s.datastores);

  const useful = (map, cap) => new Map([...map].filter(([, ids]) => ids.length >= 2 && ids.length <= cap));
  const okSubnets = useful(subnets, MAX_SUBNET_MEMBERS);
  const okShapes = useful(shapes, MAX_SHAPE_MEMBERS);
  const okFolders = useful(folders, Infinity);      // a folder is always meaningful
  const okStores = useful(stores, MAX_DATASTORE_MEMBERS);

  // Pairwise evidence.
  const uf = makeUnionFind(vms.length);
  const pairEvidence = new Map();
  const addPair = (i, j, kind, value) => {
    const key = i < j ? `${i}|${j}` : `${j}|${i}`;
    const list = pairEvidence.get(key) || [];
    list.push({ kind, value });
    pairEvidence.set(key, list);
  };
  for (const [map, kind] of [[okSubnets, "subnet"], [okShapes, "name"], [okFolders, "folder"], [okStores, "datastore"]]) {
    for (const [value, ids] of map) {
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) addPair(ids[a], ids[b], kind, value);
    }
  }
  for (const [key, ev] of pairEvidence) {
    const [i, j] = key.split("|").map(Number);
    const hasFolder = ev.some((e) => e.kind === "folder");
    if (hasFolder || ev.length >= 2) uf.union(i, j);
  }

  // Collect, then describe.
  const byRoot = new Map();
  vms.forEach((_, i) => {
    const r = uf.find(i);
    byRoot.set(r, [...(byRoot.get(r) || []), i]);
  });

  const groups = [];
  for (const ids of byRoot.values()) {
    if (ids.length < 2) continue;
    const evidence = new Map();
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const key = ids[a] < ids[b] ? `${ids[a]}|${ids[b]}` : `${ids[b]}|${ids[a]}`;
        for (const e of pairEvidence.get(key) || []) evidence.set(`${e.kind}:${e.value}`, e);
      }
    }
    const kinds = new Set([...evidence.values()].map((e) => e.kind));
    // A folder plus corroboration is as sure as inference gets here; a folder
    // alone, or two weak signals, is a suggestion worth checking.
    const confidence = kinds.has("folder") && kinds.size > 1 ? "high"
      : kinds.has("folder") || kinds.size >= 2 ? "medium" : "low";
    groups.push({
      id: ids.map((i) => vms[i].name).sort().join("|").slice(0, 120),
      members: ids.map((i) => vms[i].name),
      size: ids.length,
      confidence,
      evidence: [...evidence.values()].map((e) => describeEvidence(e)),
      diskGiB: ids.reduce((n, i) => n + (vms[i].diskGiB || 0), 0),
    });
  }
  return groups.sort((a, b) => b.size - a.size);
}

function describeEvidence(e) {
  switch (e.kind) {
    case "subnet": return { kind: e.kind, value: e.value, text: `share the subnet ${e.value}` };
    case "name": return { kind: e.kind, value: e.value, text: `follow the naming pattern ${e.value}` };
    case "folder": return { kind: e.kind, value: e.value, text: `sit in the vCenter folder ${e.value}` };
    case "datastore": return { kind: e.kind, value: e.value, text: `share the datastore ${e.value}` };
    default: return { kind: e.kind, value: e.value, text: String(e.value) };
  }
}
