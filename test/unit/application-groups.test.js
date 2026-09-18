import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicationGroups, declaredApp, identityCoverage, folderFromPath, appKeys, DEFAULT_APP_KEYS,
} from "../../src/services/application-groups.js";
import { normaliseTags, normaliseAttrs } from "../../src/services/vm-migration.js";

const vm = (name, over = {}) => ({ name, diskGiB: 100, memoryGiB: 16, cpuCount: 4, tags: null, customAttributes: null, ...over });

test("tags arrive in three shapes and leave in one", () => {
  assert.deepEqual(normaliseTags(["app:payments"]), [{ category: "app", name: "payments" }]);
  assert.deepEqual(normaliseTags([{ category: { name: "app" }, name: "identity" }]), [{ category: "app", name: "identity" }]);
  assert.deepEqual(normaliseTags(["production"]), [{ category: null, name: "production" }]);
  assert.equal(normaliseTags(undefined), null, "a provider that never mentions tags is not a machine without tags");
  assert.deepEqual(normaliseTags([]), []);
  assert.deepEqual(normaliseAttrs({ Owner: "p.raghavan", Empty: "  " }), { Owner: "p.raghavan" });
  assert.equal(normaliseAttrs(null), null);
});

test("a tag beats an attribute beats a resource pool beats a folder", () => {
  const all = {
    tags: [{ category: "app", name: "payments" }],
    customAttributes: { application: "from-attr" },
    resourcePool: "from-pool", path: "/dc/vm/from-folder/web01",
  };
  assert.equal(declaredApp(vm("web01", all)).source, "tag");
  assert.equal(declaredApp(vm("web01", { ...all, tags: null })).source, "attribute");
  assert.equal(declaredApp(vm("web01", { ...all, tags: null, customAttributes: null })).source, "resourcePool");
  assert.equal(declaredApp(vm("web01", { ...all, tags: null, customAttributes: null, resourcePool: null })).source, "folder");
});

test("a resource pool and a folder are declared, but weakly — they are often not applications", () => {
  assert.equal(declaredApp(vm("a", { tags: [{ category: "app", name: "payments" }] })).strength, "declared");
  assert.equal(declaredApp(vm("a", { resourcePool: "Tier1" })).strength, "weak");
  assert.equal(declaredApp(vm("a", { resourcePool: "Resources" })), null, "vSphere's default pool names nothing");
  assert.equal(folderFromPath("/dc/vm/web01", "web01"), null, "'vm' is vSphere scaffolding, not an application");
  assert.equal(folderFromPath("/dc/vm/payments/web01", "web01"), "payments");
});

test("a connected CMDB outranks everything the hypervisor says", () => {
  const d = declaredApp(vm("web01", { tags: [{ category: "app", name: "stale-tag" }] }),
    { cmdb: { web01: { application: "payments", owner: "p.raghavan" } } });
  assert.equal(d.source, "cmdb");
  assert.equal(d.app, "payments");
  assert.equal(d.owner, "p.raghavan");
});

test("machines with nothing to group them by are listed, never guessed into a bucket", () => {
  const out = applicationGroups([
    vm("pay-01", { tags: [{ category: "app", name: "payments" }] }),
    vm("pay-02", { tags: [{ category: "app", name: "payments" }] }),
    vm("orphan-01", { tags: [] }),
    vm("orphan-02", { tags: [] }),
  ]);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].count, 2);
  assert.deepEqual(out.ungrouped.map((u) => u.name), ["orphan-01", "orphan-02"]);
  assert.match(out.headline, /2 carry nothing to group them by/);
});

test("'we cannot see your tags' and 'you have no tags' are different answers", () => {
  const blind = identityCoverage([vm("a"), vm("b")]);
  assert.equal(blind.tagsCarried, false);
  assert.match(blind.note, /does not carry vCenter tags at all/);

  const untagged = identityCoverage([vm("a", { tags: [] }), vm("b", { tags: [] })]);
  assert.equal(untagged.tagsCarried, true);
  assert.match(untagged.note, /estate fact, not a connection problem/);

  const tagged = identityCoverage([vm("a", { tags: [{ category: "app", name: "x" }] })]);
  assert.equal(tagged.note, null);
});

test("a wave that cuts an application in half says so, with both halves counted", () => {
  const vms = ["pay-01", "pay-02", "pay-03"].map((n) => vm(n, { tags: [{ category: "app", name: "payments" }] }));
  const out = applicationGroups(vms, {
    placement: { placed: [{ name: "pay-01" }, { name: "pay-02" }], unplaced: [{ name: "pay-03" }] },
  });
  assert.equal(out.groups[0].split, true);
  assert.equal(out.groups[0].placed, 2);
  assert.equal(out.groups[0].blocked, 1);
  assert.match(out.warnings[0].message, /running across two platforms/);
});

test("a fully placed application is not warned about", () => {
  const vms = ["pay-01", "pay-02"].map((n) => vm(n, { tags: [{ category: "app", name: "payments" }] }));
  const out = applicationGroups(vms, { placement: { placed: [{ name: "pay-01" }, { name: "pay-02" }], unplaced: [] } });
  assert.equal(out.groups[0].split, false);
  assert.equal(out.warnings.length, 0);
});

test("the attribute names that mean 'application' are configurable, because every estate differs", () => {
  assert.equal(appKeys({}), DEFAULT_APP_KEYS);
  const keys = appKeys({ APP_TAG_KEYS: "cost-centre, svc" });
  assert.deepEqual(keys, ["cost-centre", "svc"]);
  const d = declaredApp(vm("a", { customAttributes: { "Cost Centre": "retail" } }), { appKeys: keys });
  assert.equal(d.app, "retail", "matching ignores case, spaces, dashes and underscores");
});
