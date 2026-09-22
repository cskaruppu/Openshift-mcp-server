// ---------------------------------------------------------------------------
// vCenter tags, read from vAPI
// ---------------------------------------------------------------------------
/**
 * The fix for "14 of 15 machines carry nothing to group them by".
 *
 * Forklift mirrors the SOAP inventory. vCenter tags do not live there — they
 * live in vAPI, a separate REST service — so an estate that is fully tagged
 * reads as completely untagged through the provider. Every machine then falls
 * back to a folder name, or to nothing.
 *
 * Reading them takes three calls regardless of estate size: list the tags,
 * resolve their categories, then ask for the associations of every VM in one
 * batch. That matters — the per-object endpoint would be one call per machine,
 * and a thousand-VM estate would take minutes and hammer vCenter.
 *
 * The parsing and shaping are pure, so the part that decides what a machine
 * belongs to is tested rather than trusted.
 */
import { vcFetch, vcenterConfig } from "../utils/vcenter-client.js";

/** vAPI batches, but not without limit. 500 is comfortably inside vCenter's. */
export const BATCH = 500;

/**
 * Turn vAPI's three separate answers into the shape `declaredApp()` reads. Pure.
 *
 * @param {Array}  associations [{ object_id:{id,type}, tag_ids:[...] }]
 * @param {Map}    tagIndex     tagId → { name, category_id }
 * @param {Map}    catIndex     categoryId → category name
 */
export function shapeAssociations(associations = [], tagIndex = new Map(), catIndex = new Map()) {
  const out = new Map();
  for (const a of associations) {
    const vmId = a?.object_id?.id || a?.objectId?.id || null;
    if (!vmId) continue;
    const tags = [];
    for (const id of a.tag_ids || a.tagIds || []) {
      const t = tagIndex.get(id);
      if (!t?.name) continue;
      // A tag with no resolvable category still carries its name. Dropping it
      // would lose "production" and other uncategorised tags entirely.
      tags.push({ category: catIndex.get(t.category_id) || null, name: t.name });
    }
    // An empty array is meaningful: vCenter was asked and this VM has none.
    // That is a different statement from null, which means nobody asked.
    out.set(vmId, tags);
  }
  return out;
}

/**
 * Attach tags to the normalised VMs. Pure.
 *
 * Machines vCenter did not answer for keep `tags: null` — "not reported" —
 * rather than being handed an empty list they did not earn.
 */
export function applyTags(vms = [], byVmId = new Map()) {
  let tagged = 0;
  const out = vms.map((vm) => {
    if (!vm.id || !byVmId.has(vm.id)) return vm;
    const tags = byVmId.get(vm.id);
    if (tags.length) tagged++;
    return { ...vm, tags };
  });
  return { vms: out, tagged, answered: byVmId.size };
}

/**
 * Read every tag on these VMs. Returns the VMs enriched, plus what happened.
 *
 * Never throws: a tagging service that is down, or a credential without the
 * tagging privilege, leaves the estate exactly as Forklift reported it and
 * says why. Losing grouping is a degraded report; failing the whole assessment
 * over it is not a trade anybody would choose.
 */
export async function enrichWithTags(vms = [], { cfg = null } = {}) {
  cfg = cfg || vcenterConfig();
  if (!cfg.configured) return { vms, source: "none", tagged: 0, reason: cfg.reason };

  const ids = vms.map((v) => v.id).filter(Boolean);
  if (!ids.length) {
    return { vms, source: "none", tagged: 0, reason: "No machine in this wave carries a vCenter managed object id, so tags cannot be looked up." };
  }

  try {
    // 1. Every tag id, then each tag's name and category.
    const tagIds = await vcFetch("/api/cis/tagging/tag", { cfg });
    if (!Array.isArray(tagIds) || !tagIds.length) {
      return { vms, source: "vcenter", tagged: 0, reason: "This vCenter has no tags defined at all — the estate is genuinely untagged, rather than unreadable." };
    }
    const tagIndex = new Map(), catIds = new Set();
    // Sequential on purpose: a tagging service is not a data plane, and
    // hundreds of parallel requests is how a vCenter starts refusing them.
    for (const id of tagIds) {
      const t = await vcFetch(`/api/cis/tagging/tag/${encodeURIComponent(id)}`, { cfg }).catch(() => null);
      if (!t?.name) continue;
      tagIndex.set(id, { name: t.name, category_id: t.category_id });
      if (t.category_id) catIds.add(t.category_id);
    }
    const catIndex = new Map();
    for (const id of catIds) {
      const c = await vcFetch(`/api/cis/tagging/category/${encodeURIComponent(id)}`, { cfg }).catch(() => null);
      if (c?.name) catIndex.set(id, c.name);
    }

    // 2. Associations for every VM, batched.
    const associations = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const object_ids = ids.slice(i, i + BATCH).map((id) => ({ id, type: "VirtualMachine" }));
      const part = await vcFetch(
        "/api/cis/tagging/tag-association?action=list-attached-tags-on-objects",
        { cfg, method: "POST", body: { object_ids } },
      );
      if (Array.isArray(part)) associations.push(...part);
    }

    const byVmId = shapeAssociations(associations, tagIndex, catIndex);
    const applied = applyTags(vms, byVmId);
    return {
      vms: applied.vms, source: "vcenter", tagged: applied.tagged, credential: cfg.source,
      categories: [...catIndex.values()],
      reason: applied.tagged === 0
        ? `vCenter has ${tagIndex.size} tag${tagIndex.size === 1 ? "" : "s"} defined, and none of them is on a machine in this wave.`
        : null,
    };
  } catch (e) {
    return {
      vms, source: "error", tagged: 0,
      reason: `vCenter tags could not be read (${e.message}). Grouping falls back to resource pools and folders — the estate may be tagged and simply unreadable from here, so this is not evidence that it is not.`,
    };
  }
}
