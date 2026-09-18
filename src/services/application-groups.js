// ---------------------------------------------------------------------------
// Applications, not a flat VM list
// ---------------------------------------------------------------------------
/**
 * A migration is planned per application. MTV has no concept of one, so every
 * plan starts as a list of machine names and someone reconstructs the
 * application from memory.
 *
 * The distinction this file exists to keep is between what the source DECLARES
 * and what a heuristic INFERS. A vCenter tag reading `app=payments` is a fact
 * somebody typed on purpose; two machines sharing a /24 is a hint. Both are
 * useful and they must never be shown as the same kind of thing, because
 * grouping decides what moves together — and a confident wrong grouping is
 * worse than an honest blank, since it silently splits a working system across
 * two platforms for a month.
 *
 * So: declared sources win, in a stated precedence; inference never creates a
 * group here (affinity.js does that, separately, labelled as inference); and
 * machines the source says nothing about are listed as ungroupable rather than
 * swept into a bucket.
 *
 * Everything here is pure.
 */

/**
 * Attribute and tag names that mean "this is the application". Configurable
 * because every estate names it differently — and a wrong key silently groups
 * nothing, so it is worth being able to fix without a release.
 */
export const DEFAULT_APP_KEYS = Object.freeze([
  "app", "application", "appname", "app-name", "app_name",
  "service", "businessservice", "business-service", "business_service",
  "system", "product", "workload",
]);

/** Owner attributes, read alongside the application so a group has a person. */
export const DEFAULT_OWNER_KEYS = Object.freeze([
  "owner", "appowner", "app-owner", "technicalowner", "contact", "team",
]);

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");

/** Configured keys, or the defaults. `APP_TAG_KEYS` is a comma-separated list. */
export function appKeys(env = process.env) {
  const raw = env.APP_TAG_KEYS;
  if (!raw) return DEFAULT_APP_KEYS;
  const keys = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  return keys.length ? keys : DEFAULT_APP_KEYS;
}

export function ownerKeys(env = process.env) {
  const raw = env.APP_OWNER_KEYS;
  if (!raw) return DEFAULT_OWNER_KEYS;
  const keys = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  return keys.length ? keys : DEFAULT_OWNER_KEYS;
}

/**
 * The strongest declared statement of what application a machine belongs to.
 *
 * Precedence, strongest first, and the reason for the order: a tag is chosen
 * per machine on purpose; a custom attribute is the same intent with less
 * structure; a resource pool groups for scheduling and is often — but not
 * always — an application; a folder is organisational and frequently just
 * "Production". The last two are therefore declared-but-weak, and labelled as
 * such rather than treated as equal to a tag.
 */
export function declaredApp(vm = {}, opts = {}) {
  const keys = (opts.appKeys || appKeys()).map(norm);
  const owners = (opts.ownerKeys || ownerKeys()).map(norm);
  const hit = (k) => keys.includes(norm(k));

  // A CMDB is the strongest source of all when one is connected: it is the
  // system of record, maintained by people whose job that is.
  if (opts.cmdb && opts.cmdb[vm.name]) {
    const c = opts.cmdb[vm.name];
    const name = typeof c === "string" ? c : c.application;
    if (name) {
      return { app: String(name).trim(), source: "cmdb", strength: "declared", owner: (typeof c === "object" && c.owner) || null, evidence: "From the configuration management database." };
    }
  }

  if (Array.isArray(vm.tags)) {
    const tag = vm.tags.find((t) => t.category && hit(t.category)) || null;
    if (tag) {
      const ownerTag = vm.tags.find((t) => t.category && owners.includes(norm(t.category)));
      return { app: tag.name, source: "tag", strength: "declared", owner: ownerTag?.name || null, evidence: `vCenter tag ${tag.category}: ${tag.name}` };
    }
  }

  if (vm.customAttributes) {
    const key = Object.keys(vm.customAttributes).find(hit);
    if (key) {
      const ownerKey = Object.keys(vm.customAttributes).find((k) => owners.includes(norm(k)));
      return {
        app: vm.customAttributes[key], source: "attribute", strength: "declared",
        owner: ownerKey ? vm.customAttributes[ownerKey] : null,
        evidence: `vCenter custom attribute ${key}: ${vm.customAttributes[key]}`,
      };
    }
  }

  if (vm.resourcePool && !/^(resources|\/)?$/i.test(String(vm.resourcePool).trim())) {
    return { app: String(vm.resourcePool).trim(), source: "resourcePool", strength: "weak", owner: null, evidence: `vCenter resource pool ${vm.resourcePool}` };
  }

  const folder = vm.folder || folderFromPath(vm.path, vm.name);
  if (folder) {
    return { app: folder, source: "folder", strength: "weak", owner: null, evidence: `vCenter folder ${folder}` };
  }

  return null;
}

/** The folder segment of an inventory path, with the VM's own name removed. */
export function folderFromPath(path, name) {
  if (!path) return null;
  const parts = String(path).split("/").map((s) => s.trim()).filter(Boolean);
  if (name && parts.length && parts[parts.length - 1] === String(name).trim()) parts.pop();
  const last = parts[parts.length - 1] || null;
  // These are vSphere's own scaffolding, not anybody's application.
  if (!last || /^(vm|datacenter|host|vmFolder|Discovered virtual machine)$/i.test(last)) return null;
  return last;
}

/**
 * Whether the inventory carries application identity at all. Pure.
 *
 * Forklift mirrors vCenter's SOAP inventory; vCenter tags live in vAPI, so many
 * providers report none. That is a fact about the connection, not about the
 * estate, and the difference decides whether the answer is "your machines are
 * untagged" or "we cannot see your tags" — which need completely different
 * conversations with a customer.
 */
export function identityCoverage(vms = []) {
  const n = vms.length;
  const reported = (f) => vms.filter(f).length;
  const sources = {
    cmdb: 0,
    tag: reported((v) => Array.isArray(v.tags) && v.tags.length > 0),
    attribute: reported((v) => v.customAttributes && Object.keys(v.customAttributes).length > 0),
    resourcePool: reported((v) => !!v.resourcePool),
    folder: reported((v) => !!(v.folder || folderFromPath(v.path, v.name))),
  };
  // null vs [] — "the provider never mentioned tags" vs "it did and there are none".
  const tagsCarried = vms.some((v) => v.tags !== null && v.tags !== undefined);
  const attrsCarried = vms.some((v) => v.customAttributes !== null && v.customAttributes !== undefined);
  return {
    total: n, sources, tagsCarried, attrsCarried,
    note: !tagsCarried
      ? "This provider's inventory does not carry vCenter tags at all — Forklift mirrors the SOAP inventory and tags live in vAPI. Grouping falls back to resource pools and folders, or to a CMDB if one is connected."
      : sources.tag === 0
        ? "The inventory carries tags, and none of these machines has one. That is an estate fact, not a connection problem."
        : null,
  };
}

/**
 * Group a fleet by declared application. Pure.
 *
 * @param {Array} vms   normalised VMs
 * @param {object} opts { cmdb, appKeys, ownerKeys, placement }
 */
export function applicationGroups(vms = [], opts = {}) {
  const coverage = identityCoverage(vms);
  const byApp = new Map();
  const ungrouped = [];

  for (const vm of vms) {
    const d = declaredApp(vm, opts);
    if (!d) { ungrouped.push({ name: vm.name, diskGiB: vm.diskGiB || 0, memoryGiB: vm.memoryGiB || 0 }); continue; }
    const key = norm(d.app);
    if (!byApp.has(key)) byApp.set(key, { app: d.app, source: d.source, strength: d.strength, owner: d.owner, members: [], evidence: new Set() });
    const g = byApp.get(key);
    g.evidence.add(d.evidence);
    // A stronger source anywhere in the group upgrades the whole group's label:
    // "grouped by tag, and two of these came from the folder" is more useful
    // than silently downgrading the lot.
    if (d.strength === "declared" && g.strength === "weak") { g.strength = "declared"; g.source = d.source; }
    if (!g.owner && d.owner) g.owner = d.owner;
    g.members.push({
      name: vm.name, diskGiB: vm.diskGiB || 0, memoryGiB: vm.memoryGiB || 0,
      cpuCount: vm.cpuCount || 0, source: d.source,
    });
  }

  // Where each member lands, when a placement was simulated — so "this wave
  // splits payments in half" is answerable at the point the wave is chosen.
  const landing = new Map();
  for (const p of opts.placement?.placed || []) landing.set(p.name, true);
  for (const u of opts.placement?.unplaced || []) landing.set(u.name, false);

  const groups = [...byApp.values()]
    .map((g) => {
      const placed = g.members.filter((m) => landing.get(m.name) === true).length;
      const blocked = g.members.filter((m) => landing.get(m.name) === false).length;
      return {
        app: g.app, source: g.source, strength: g.strength, owner: g.owner,
        evidence: [...g.evidence].slice(0, 3),
        members: g.members.map((m) => m.name),
        count: g.members.length,
        diskGiB: g.members.reduce((n, m) => n + m.diskGiB, 0),
        memoryGiB: g.members.reduce((n, m) => n + m.memoryGiB, 0),
        cpuCount: g.members.reduce((n, m) => n + m.cpuCount, 0),
        placed, blocked,
        // The warning that matters: some of this application lands and some
        // does not, which leaves it running across two platforms.
        split: landing.size > 0 && placed > 0 && blocked > 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.app.localeCompare(b.app));

  const splitGroups = groups.filter((g) => g.split);
  return {
    groups, ungrouped, coverage,
    grouped: vms.length - ungrouped.length,
    headline: groups.length === 0
      ? `No machine carries an application tag, attribute, resource pool or folder that could group it${coverage.note ? "" : " — they are listed individually rather than guessed into applications"}.`
      : `${groups.length} application${groups.length === 1 ? "" : "s"} across ${vms.length - ungrouped.length} of ${vms.length} machine${vms.length === 1 ? "" : "s"}${ungrouped.length ? `; ${ungrouped.length} carry nothing to group them by` : ""}.`,
    warnings: splitGroups.map((g) => ({
      app: g.app,
      message: `${g.placed} of ${g.count} machines in ${g.app} can be placed and ${g.blocked} cannot. Migrating part of an application leaves it running across two platforms, with the latency and firewall rules that implies.`,
    })),
  };
}
