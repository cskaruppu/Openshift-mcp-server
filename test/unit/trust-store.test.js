/**
 * Why MTV can reach a vCenter this agent could not.
 * Run with: node --test test/unit/trust-store.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extractCertificates, clusterTrustBundle, caForConnection, _resetTrustCache, BUNDLE_PATHS } =
  await import("../../src/utils/trust-store.js");

const pem = (n) => `-----BEGIN CERTIFICATE-----\nFAKE${n}\n-----END CERTIFICATE-----`;

describe("reading the pod's trust", () => {
  test("a bundle yields every certificate in it, not just the first", () => {
    assert.equal(extractCertificates(`${pem(1)}\n${pem(2)}`).length, 2);
    assert.deepEqual(extractCertificates("not a certificate"), []);
  });

  test("the system bundle OpenShift populates is one of the paths looked at", () => {
    // This is the file Go reads and Node does not, which is the entire reason
    // MTV could reach a vCenter this agent reported as untrusted.
    assert.ok(BUNDLE_PATHS.includes("/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"));
  });

  test("an explicitly mounted bundle is read", () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-"));
    const f = join(dir, "ca.pem");
    writeFileSync(f, `${pem("A")}\n${pem("B")}`);
    _resetTrustCache();
    const b = clusterTrustBundle({ VCENTER_CA_BUNDLE: f });
    assert.ok(b.certs.length >= 2);
    assert.ok(b.sources.some((s) => s.path === f));
    _resetTrustCache();
  });

  test("a pod with nothing mounted says so rather than implying it is fine", () => {
    _resetTrustCache();
    const b = clusterTrustBundle({ VCENTER_CA_BUNDLE: "/nonexistent", NODE_EXTRA_CA_CERTS: "" });
    if (!b.certs.length) assert.match(b.note, /beyond Node's built-in public roots/);
    _resetTrustCache();
  });
});

describe("building a chain for one connection", () => {
  test("the provider's CA and the pod's bundle are merged, not chosen between", () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-"));
    const f = join(dir, "ca.pem");
    writeFileSync(f, pem("POD"));
    _resetTrustCache();
    const chain = caForConnection(pem("PROVIDER"), { VCENTER_CA_BUNDLE: f });
    // An enterprise chain often needs an intermediate from the provider and a
    // root from the pod; it verifies only when both are present.
    assert.ok(chain.some((c) => c.includes("PROVIDER")));
    assert.ok(chain.some((c) => c.includes("POD")));
    _resetTrustCache();
  });

  test("the same authority in two bundles appears once", () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-"));
    const f = join(dir, "ca.pem");
    writeFileSync(f, pem("SAME"));
    _resetTrustCache();
    const chain = caForConnection(pem("SAME"), { VCENTER_CA_BUNDLE: f });
    assert.equal(chain.filter((c) => c.includes("SAME")).length, 1);
    _resetTrustCache();
  });
});
