/**
 * A 403 does not prove that something is installed.
 * Run with: node --test test/unit/api-discovery.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";

const { statusOf } = await import("../../src/utils/api-discovery.js");
const { mtaAccessVerdict } = await import("../../src/services/mta-client.js");

describe("the 403 trap", () => {
  test("a 403 with the group NOT served is not 'installed'", () => {
    // The bug this closes: the API server authorizes before it routes, so a
    // service account with no rule for mta.konveyor.io is refused identically
    // whether MTA is installed or has never existed. Reading that as presence
    // told a customer to grant a role for a product they did not have.
    assert.equal(mtaAccessVerdict({ status: 403, groupServed: false }), null);
  });

  test("a 403 with the group served IS a role to grant", () => {
    const v = mtaAccessVerdict({ status: 403, groupServed: true });
    assert.equal(v.rbacDenied, true);
    assert.match(v.message, /may not read its resources/);
  });

  test("a 403 with discovery unanswered is indeterminate, not either answer", () => {
    const v = mtaAccessVerdict({ status: 403, groupServed: null });
    assert.equal(v.code, "indeterminate");
    assert.ok(!v.rbacDenied);
    assert.match(v.message, /system:discovery/);
  });

  test("404 stays absent and 401 stays a credential problem", () => {
    assert.equal(mtaAccessVerdict({ status: 404 }), null);
    assert.equal(mtaAccessVerdict({ status: 401 }).code, "unauthorised");
  });

  test("the status parser reads the client's error text", () => {
    assert.equal(statusOf(new Error("OCP API 403: forbidden")), 403);
    assert.equal(statusOf(new Error("socket hang up")), 0);
  });
});

test("an unreachable cluster still reports MTA as unknown, never absent", async () => {
  const { mtaReadiness } = await import("../../src/services/mta-client.js");
  const r = await mtaReadiness({});
  assert.equal(r.installed, null);
  assert.equal(r.blocking[0].code, "cluster-unreachable");
});

describe("the certificate decision travels with the assessment", () => {
  // The button says "accept this certificate for this assessment", and an
  // assessment is several calls: discovery lists the machines, the guest read
  // reads inside them, the OS panel reads the cluster. Applied to only the
  // first, the operator accepted a certificate and was then refused by it —
  // the worst of both, because the decision had already been made.
  test("every call that touches vCenter takes the flag", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../src/index.js", import.meta.url), "utf8");
    for (const route of ["/api/containerize/inventory", "/api/containerize/assess", "/api/containerize/fleet"]) {
      const at = src.indexOf(route);
      assert.ok(at > 0, `${route} is missing`);
      const block = src.slice(at, at + 4500);
      assert.match(block, /acceptCertificate/, `${route} ignores the operator's certificate decision`);
    }
  });

  test("the console never hardcodes the flag true", async () => {
    const { readFile } = await import("node:fs/promises");
    const ui = await readFile(new URL("../../console/src/components/ContainerizationAgent.jsx", import.meta.url), "utf8");
    // Turning verification off for everyone is not a decision a wizard makes.
    assert.doesNotMatch(ui, /acceptCertificate:\s*true\b/,
      "the flag must carry the operator's decision, never a literal");
  });
});
