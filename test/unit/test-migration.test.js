import { test } from "node:test";
import assert from "node:assert/strict";
import {
  proposeTestMigration, testMigrationRefusals, buildIsolationPolicy, sandboxNamespace,
  validationChecklist, teardownPlan, PROTECTED_NAMESPACES,
} from "../../src/services/test-migration.js";

const vm = (name, over = {}) => ({ name, id: `vm-${name}`, poweredOn: false, changeTrackingEnabled: true, hasSnapshot: false, ...over });
const opts = {
  sourceProvider: "vcenter-prod", targetProvider: "host",
  storageMap: "sm-1", networkMap: "nm-isolated", wave: "wave-1",
};

test("a running machine is never cold-tested, because MTV powers the source off first", () => {
  const r = testMigrationRefusals([vm("prod-db", { poweredOn: true })], { strategy: "cold" });
  assert.equal(r.refusals.length, 1);
  assert.equal(r.refusals[0].code, "cold-would-power-off-production");
  assert.match(r.refusals[0].message, /is a production outage/);
  assert.equal(r.allowed.length, 0);
});

test("a powered-off machine is cold-testable with no disruption at all", () => {
  const r = testMigrationRefusals([vm("archive-01", { poweredOn: false })], { strategy: "cold" });
  assert.equal(r.refusals.length, 0);
  assert.equal(r.allowed.length, 1);
});

test("a warm test needs change tracking and a clean snapshot chain", () => {
  const noCbt = testMigrationRefusals([vm("a", { poweredOn: true, changeTrackingEnabled: false })], { strategy: "warm" });
  assert.equal(noCbt.refusals[0].code, "warm-needs-cbt");

  const snap = testMigrationRefusals([vm("b", { poweredOn: true, hasSnapshot: true })], { strategy: "warm" });
  assert.equal(snap.refusals[0].code, "warm-snapshot-chain");
});

test("a warm test says out loud that it changes the production machine", () => {
  const r = testMigrationRefusals([vm("live", { poweredOn: true })], { strategy: "warm" });
  assert.equal(r.refusals.length, 0);
  assert.equal(r.warnings[0].code, "warm-snapshots-the-source");
  assert.match(r.warnings[0].message, /belongs in the change record/);
});

test("checks the inventory could not answer are warned about, never counted as passed", () => {
  const r = testMigrationRefusals([vm("mystery", { poweredOn: false, hasSnapshot: null, changeTrackingEnabled: null })], { strategy: "cold" });
  assert.ok(r.warnings.some((w) => w.code === "unverified"));
  assert.match(r.warnings.find((w) => w.code === "unverified").message, /not the same as passing them/);
});

test("isolation denies egress as well as ingress", () => {
  const p = buildIsolationPolicy("mig-test-wave-1");
  assert.deepEqual(p.spec.policyTypes, ["Ingress", "Egress"]);
  assert.deepEqual(p.spec.podSelector, {}, "every pod in the namespace, with no exceptions");
  // Egress is the one that matters: a cloned domain controller that can REACH
  // the real one is the failure, and an ingress-only policy would allow it.
  assert.match(p.metadata.annotations["tcs.agentic-ai/why"], /collide with the machine still running/);
});

test("no network map means no plan — a test VM carries the original IP and MAC", () => {
  const out = proposeTestMigration([vm("a")], { ...opts, networkMap: null });
  assert.equal(out.ok, false);
  assert.equal(out.blocking[0].code, "no-network-map");
  assert.deepEqual(out.manifests, [], "nothing is offered to apply");
  assert.equal(out.teardown, null);
});

test("a platform namespace is refused, because teardown deletes the namespace", () => {
  for (const ns of PROTECTED_NAMESPACES) {
    const out = proposeTestMigration([vm("a")], { ...opts, namespace: ns });
    assert.equal(out.ok, false, ns);
    assert.ok(out.blocking.some((b) => b.code === "protected-namespace"), ns);
  }
});

test("a namespace holding somebody else's work is refused", () => {
  const out = proposeTestMigration([vm("a")], { ...opts, namespaceInUse: true });
  assert.equal(out.ok, false);
  assert.equal(out.blocking[0].code, "namespace-in-use");
});

test("a complete proposal isolates before it copies", () => {
  const out = proposeTestMigration([vm("a"), vm("b")], opts);
  assert.equal(out.ok, true);
  assert.equal(out.namespace, "mig-test-wave-1");
  const kinds = out.manifests.map((m) => m.kind);
  assert.deepEqual(kinds, ["Namespace", "NetworkPolicy", "Plan"]);
  assert.ok(kinds.indexOf("NetworkPolicy") < kinds.indexOf("Plan"), "the policy exists before anything boots");
  assert.match(out.order[0], /before anything is copied/);
  assert.equal(out.manifests[2].spec.targetNamespace, "mig-test-wave-1");
  assert.equal(out.manifests[2].spec.warm, false);
  assert.equal(out.manifests[2].metadata.labels["tcs.agentic-ai/kind"], "test-migration");
});

test("a test plan is separate from the real one, and labelled disposable", () => {
  const out = proposeTestMigration([vm("a")], opts);
  const plan = out.manifests.find((m) => m.kind === "Plan");
  assert.match(plan.metadata.name, /^test-/);
  assert.equal(plan.metadata.annotations["tcs.agentic-ai/disposable"], "true");
  assert.notEqual(plan.spec.targetNamespace, "openshift-mtv");
});

test("the checklist checks the guest booted, not only that the VM exists", () => {
  const cl = validationChecklist([vm("a")], "mig-test-wave-1");
  const booted = cl.find((c) => c.id === "booted");
  assert.equal(booted.automatic, false);
  assert.match(booted.why, /inaccessible-boot-device/);
  // The scheduling check is the one that grades the capacity prediction.
  assert.match(cl.find((c) => c.id === "scheduled").why, /the prediction was wrong/);
});

test("teardown removes everything and warns about volumes that outlive it", () => {
  const t = teardownPlan("test-wave-1-cold", "mig-test-wave-1");
  assert.deepEqual(t.commands, ["oc delete plan test-wave-1-cold -n openshift-mtv", "oc delete namespace mig-test-wave-1"]);
  assert.match(t.note, /source machines in vCenter are untouched/);
  assert.match(t.warning, /reclaim policy is Retain/);
});

test("a sandbox namespace is always DNS-safe and always prefixed", () => {
  assert.equal(sandboxNamespace("Wave 1 — Payments!"), "mig-test-wave-1-payments");
  assert.equal(sandboxNamespace(""), "mig-test-wave");
  assert.ok(sandboxNamespace("x".repeat(200)).length <= 63);
});

test("a selection where nothing is testable produces no manifests", () => {
  const out = proposeTestMigration([vm("a", { poweredOn: true })], { ...opts, strategy: "cold" });
  assert.equal(out.ok, false);
  assert.ok(out.blocking.some((b) => b.code === "nothing-testable"));
  assert.equal(out.refusals.length, 1);
});
