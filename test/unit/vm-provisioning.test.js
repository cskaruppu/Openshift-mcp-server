/**
 * VM request extraction and sizing reconciliation.
 * Run with: node --test test/unit/vm-provisioning.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";

const {
  extractVMRequest, reconcileSizing, normalizeVMRequest,
  buildVMManifest, missingFields, vmNames, parseMemToMi,
} = await import("../../src/services/vm-provisioning.js");

describe("VM intent extraction", () => {
  test("a full request extracts every field", async () => {
    const { request: r } = await extractVMRequest(
      "Provision a RHEL 9 VM called sap-app-01 in namespace sap, 8 vCPU, 32GB RAM, "
      + "200GB disk, production, cost centre CC-4471, expires 2026-12-31, "
      + "ssh-ed25519 AAAAC3Nz me@host");
    assert.equal(r.name, "sap-app-01");
    assert.equal(r.namespace, "sap");
    assert.equal(r.cpuCores, 8);
    assert.equal(r.memoryMi, 32768, "32GB RAM must not be confused with the 200GB disk");
    assert.equal(r.diskSizeGi, 200);
    assert.equal(r.environment, "prod");
    assert.equal(r.costCentre, "CC-4471");
    assert.equal(r.expiresOn, "2026-12-31");
    assert.match(r.sshKey, /^ssh-ed25519 /);
  });

  test("'RHEL 9 VMs' is a version, not a quantity", async () => {
    const { request: r } = await extractVMRequest("I need three RHEL 9 VMs named web in the apps namespace");
    assert.equal(r.count, 3, "word-number should win over the OS version digit");
    assert.equal(r.namespace, "apps", "'in the apps namespace' must not capture the article");
  });

  test("environment is not inferred from a VM's own name", async () => {
    const { request: r } = await extractVMRequest("create a fedora vm called test-box in sandbox with 2 cores and 4GB");
    assert.equal(r.name, "test-box");
    assert.equal(r.environment, null, "'test' inside 'test-box' must not set the environment");
  });

  test("'in namespace X' does not capture the literal word namespace", async () => {
    const { request: r } = await extractVMRequest("build a vm called dc-01 in namespace infra");
    assert.equal(r.namespace, "infra");
  });

  test("an empty ask reports everything that is missing", async () => {
    const { request: r, missing } = await extractVMRequest("provision a vm");
    assert.equal(r.name, "");
    for (const f of ["name", "namespace", "sourceDataSource", "sshKey", "sizing"]) {
      assert.ok(missing.includes(f), `expected ${f} to be reported missing`);
    }
  });

  test("batch requests produce indexed names", () => {
    assert.deepEqual(vmNames(normalizeVMRequest({ name: "web", count: 3 })), ["web-1", "web-2", "web-3"]);
    assert.deepEqual(vmNames(normalizeVMRequest({ name: "web", count: 1 })), ["web"]);
  });
});

describe("sizing reconciliation", () => {
  const its = [
    { name: "u1.small", cpu: 1, memory: "2Gi" },
    { name: "u1.medium", cpu: 4, memory: "16Gi" },
    { name: "u1.large", cpu: 8, memory: "32Gi" },
    { name: "u1.xlarge", cpu: 16, memory: "64Gi" },
  ];
  test("an exact match says so", () => {
    const r = reconcileSizing(normalizeVMRequest({ cpuCores: 8, memoryMi: 32768 }), its);
    assert.equal(r.verdict, "exact");
    assert.equal(r.chosen.name, "u1.large");
  });
  test("rounding up states the delta", () => {
    const r = reconcileSizing(normalizeVMRequest({ cpuCores: 6, memoryMi: 20480 }), its);
    assert.equal(r.verdict, "rounded-up");
    assert.equal(r.chosen.name, "u1.large");
    assert.equal(r.delta.cpu, 2);
    assert.equal(r.delta.memoryGi, 12);
  });
  test("a request beyond the catalogue is flagged, not silently rounded", () => {
    const r = reconcileSizing(normalizeVMRequest({ cpuCores: 64, memoryMi: 262144 }), its);
    assert.equal(r.verdict, "exceeds-catalogue");
    assert.equal(r.chosen, null);
  });
  test("parseMemToMi handles the usual units", () => {
    assert.equal(parseMemToMi("32Gi"), 32768);
    assert.equal(parseMemToMi("512Mi"), 512);
    assert.equal(parseMemToMi(""), 0);
  });
});

describe("manifest", () => {
  const req = normalizeVMRequest({
    name: "sap-app", namespace: "sap", sourceDataSource: "rhel9", instanceType: "u1.large",
    diskSizeGi: 200, storageClass: "ocs-sc", sshKey: "ssh-ed25519 AAAA me@h",
    networkAttachmentDefinition: "vlan300", owner: "platform team", environment: "prod",
  });

  test("the root disk is persistent, never a containerDisk", () => {
    const m = buildVMManifest(req, "sap-app-1");
    const json = JSON.stringify(m);
    assert.ok(!json.includes("containerDisk"), "containerDisk is ephemeral and must never be the root disk");
    assert.ok(!json.includes("emptyDisk"), "emptyDisk is ephemeral");
    assert.equal(m.spec.template.spec.volumes[0].dataVolume.name, "sap-app-1-rootdisk");
    assert.equal(m.spec.dataVolumeTemplates[0].spec.sourceRef.name, "rhel9");
    assert.equal(m.spec.dataVolumeTemplates[0].spec.storage.resources.requests.storage, "200Gi");
  });

  test("cloud-init carries the key, and password login is off", () => {
    const m = buildVMManifest(req, "sap-app-1");
    const ud = m.spec.template.spec.volumes[1].cloudInitNoCloud.userData;
    assert.match(ud, /ssh-ed25519 AAAA/);
    assert.match(ud, /ssh_pwauth: false/);
    assert.match(ud, /hostname: sap-app-1/);
  });

  test("a VLAN uses multus; otherwise pod networking", () => {
    assert.equal(buildVMManifest(req, "x").spec.template.spec.networks[0].multus.networkName, "vlan300");
    const pod = buildVMManifest(normalizeVMRequest({ ...req, networkAttachmentDefinition: null }), "x");
    assert.ok(pod.spec.template.spec.networks[0].pod);
  });

  test("provenance is written for later day-2 ownership", () => {
    const m = buildVMManifest(req, "x");
    assert.equal(m.metadata.labels["app.kubernetes.io/managed-by"], "tcs-agentic-ai");
    assert.equal(m.metadata.labels["tcs.ai/owner"], "platform-team", "label values must be sanitised");
    assert.equal(m.metadata.labels["tcs.ai/environment"], "prod");
  });

  test("missingFields accepts any of the three boot sources", () => {
    assert.ok(!missingFields(req).includes("sourceDataSource"));
    const reg = normalizeVMRequest({ ...req, sourceDataSource: null, sourceRegistryUrl: "docker://x" });
    assert.ok(!missingFields(reg).includes("sourceDataSource"));
    const none = normalizeVMRequest({ ...req, sourceDataSource: null });
    assert.ok(missingFields(none).includes("sourceDataSource"));
  });
});

// ── createNamespace opt-in ──────────────────────────────────────────────────
// Creating a namespace is a side effect, so it is never inferred from a name
// that happens not to exist — the operator ticks the box.
test("createNamespace defaults to false and is only ever an explicit opt-in", () => {
  assert.equal(normalizeVMRequest({ name: "a", namespace: "sap" }).createNamespace, false);
  assert.equal(normalizeVMRequest({ name: "a", namespace: "sap", createNamespace: false }).createNamespace, false);
  // Truthy-but-not-true values must not enable a cluster mutation.
  assert.equal(normalizeVMRequest({ name: "a", namespace: "sap", createNamespace: "yes" }).createNamespace, false);
  assert.equal(normalizeVMRequest({ name: "a", namespace: "sap", createNamespace: 1 }).createNamespace, false);
  assert.equal(normalizeVMRequest({ name: "a", namespace: "sap", createNamespace: true }).createNamespace, true);
});

test("namespace name is preserved verbatim for the create path", () => {
  // The UI lowercases as you type; normalize must not silently alter what the
  // operator confirmed, or the created namespace and the target would diverge.
  assert.equal(normalizeVMRequest({ namespace: "  team-alpha  " }).namespace, "team-alpha");
});
