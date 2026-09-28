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
