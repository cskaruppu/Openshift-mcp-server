import { test } from "node:test";
import assert from "node:assert/strict";
import {
  affinityGroups, subnetOf, nameShape, folderOf, MAX_SUBNET_MEMBERS,
} from "../../src/services/affinity.js";
// splitGroups lives in the console tree — the two container images have
// disjoint build contexts, so it cannot be shared across them. It is still
// tested here, from the repo where both halves exist.
import { splitGroups } from "../../console/src/lib/affinity.js";

const vm = (name, ip, path, datastores = [], diskGiB = 100) => ({
  name, ips: ip ? [ip] : [], path, datastores, diskGiB,
});
const namesOf = (g) => g.members.slice().sort();

// ── Signals ────────────────────────────────────────────────────────────────

test("a /24 is derived only from a real, routable IPv4", () => {
  assert.equal(subnetOf("10.131.71.75"), "10.131.71.0/24");
  assert.equal(subnetOf("127.0.0.1"), null, "loopback groups nothing");
  assert.equal(subnetOf("169.254.0.2"), null, "link-local groups nothing");
  assert.equal(subnetOf("fe80::1"), null);
  assert.equal(subnetOf("999.1.1.1"), null);
  assert.equal(subnetOf(""), null);
});

test("a name's shape is its digits removed, and a name without digits has none", () => {
  assert.equal(nameShape("HDS071075-mvm2"), "hds#-mvm#");
  assert.equal(nameShape("HDS071076-mvm3"), "hds#-mvm#", "sequential names share a shape");
  assert.equal(nameShape("web01"), "web#");
  // Without this guard every digit-free name would match every other one.
  assert.equal(nameShape("jenkins"), null);
  assert.equal(nameShape("12345"), null, "digits alone say nothing");
});

test("the folder is the path with the VM itself removed", () => {
  assert.equal(folderOf({ path: "/DC/vm/ShopApp/web01" }), "/DC/vm/ShopApp");
  assert.equal(folderOf({ path: "web01" }), null);
  assert.equal(folderOf({}), null);
});

// ── Grouping ───────────────────────────────────────────────────────────────

test("machines sharing a folder and a subnet group with high confidence", () => {
  const g = affinityGroups([
    vm("web01", "10.20.5.11", "/DC/vm/ShopApp/web01", ["ds-02"]),
    vm("web02", "10.20.5.12", "/DC/vm/ShopApp/web02", ["ds-02"]),
    vm("db01", "10.20.5.30", "/DC/vm/ShopApp/db01", ["ds-03"]),
  ]);
  assert.equal(g.length, 1);
  assert.deepEqual(namesOf(g[0]), ["db01", "web01", "web02"]);
  assert.equal(g[0].confidence, "high");
  assert.ok(g[0].evidence.some((e) => e.kind === "folder"));
  assert.equal(g[0].diskGiB, 300);
});

test("one weak signal alone never makes a group", () => {
  // Same subnet, nothing else in common. A flat network is not an application.
  const g = affinityGroups([
    vm("jenkins", "10.99.1.4", null),
    vm("wiki", "10.99.1.5", null),
  ]);
  assert.equal(g.length, 0, "a shared subnet on its own is not evidence");

  // Two weak signals agreeing is enough.
  const g2 = affinityGroups([
    vm("app01", "10.99.1.4", null),
    vm("app02", "10.99.1.5", null),
  ]);
  assert.equal(g2.length, 1, "subnet + naming pattern corroborate");
  assert.equal(g2[0].confidence, "medium");
});

test("a shared folder is enough on its own — it is a deliberate human act", () => {
  const g = affinityGroups([
    vm("alpha", null, "/DC/vm/Payments/alpha"),
    vm("bravo", null, "/DC/vm/Payments/bravo"),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].confidence, "medium", "a folder alone is a suggestion, not a certainty");
});

test("an over-populated signal is dropped rather than grouping the estate", () => {
  // Every machine on one flat /24, with no other signal in common.
  const many = Array.from({ length: MAX_SUBNET_MEMBERS + 4 }, (_, i) =>
    ({ name: `host-${String.fromCharCode(97 + i)}`, ips: ["10.0.0." + (i + 1)], path: null, datastores: [] }));
  assert.equal(affinityGroups(many).length, 0,
    "a subnet shared by the whole estate is a network, not a system");
});

test("groups do not need every member to share the same pair of signals", () => {
  // web01–web02 share a name shape; web02–db01 share only the folder. The
  // folder link is what holds all three together.
  const g = affinityGroups([
    vm("web01", "10.1.1.1", "/DC/vm/App/web01"),
    vm("web02", "10.1.1.2", "/DC/vm/App/web02"),
    vm("db01", "10.9.9.9", "/DC/vm/App/db01"),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].size, 3);
});

test("an empty or single-VM estate produces nothing", () => {
  assert.deepEqual(affinityGroups([]), []);
  assert.deepEqual(affinityGroups([vm("only", "10.0.0.1", "/DC/vm/x/only")]), []);
});

// ── The warning that matters ───────────────────────────────────────────────

test("a split is reported only when a group is genuinely cut in half", () => {
  const groups = affinityGroups([
    vm("web01", "10.20.5.11", "/DC/vm/ShopApp/web01"),
    vm("web02", "10.20.5.12", "/DC/vm/ShopApp/web02"),
    vm("db01", "10.20.5.30", "/DC/vm/ShopApp/db01"),
  ]);

  const split = splitGroups(groups, ["web01", "web02"]);
  assert.equal(split.length, 1);
  assert.deepEqual(split[0].leftBehind, ["db01"]);
  assert.match(split[0].message, /db01 would stay on VMware/);
  assert.ok(split[0].because.length > 0, "the warning must say why these are grouped");

  // All three in: nothing to say.
  assert.deepEqual(splitGroups(groups, ["web01", "web02", "db01"]), []);
  // None of them in: also nothing to say — this wave simply is not about them.
  assert.deepEqual(splitGroups(groups, ["unrelated"]), []);
});

test("the worst split is reported first", () => {
  const groups = [
    { id: "a", members: ["a1", "a2"], size: 2, confidence: "medium", evidence: [{ text: "x" }] },
    { id: "b", members: ["b1", "b2", "b3", "b4"], size: 4, confidence: "high", evidence: [{ text: "y" }] },
  ];
  const split = splitGroups(groups, ["a1", "b1"]);
  assert.equal(split[0].id, "b", "3 machines left behind outranks 1");
  assert.equal(split[0].leftBehind.length, 3);
});
