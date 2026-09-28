/**
 * Guest OS support: matrix freshness and cluster corroboration.
 * Run with: node --test test/unit/os-support.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";

const { matrixAge, imageMatches, reconcile, supportPosture } = await import("../../src/services/os-support.js");
const { SUPPORT_MATRIX } = await import("../../src/services/vm-migration.js");

describe("matrix freshness", () => {
  const at = (iso) => Date.parse(iso);
  test("age is graded against Red Hat's release cadence, not an arbitrary limit", () => {
    assert.equal(matrixAge("2026-09-01", at("2026-09-20")).stale, "current");
    assert.equal(matrixAge("2026-01-01", at("2026-09-20")).stale, "ageing");
    assert.equal(matrixAge("2024-01-01", at("2026-09-20")).stale, "stale");
  });

  test("a matrix with no date says so rather than assuming it is fresh", () => {
    const a = matrixAge(null);
    assert.equal(a.stale, null);
    assert.match(a.note, /carries no date/);
  });

  test("the shipped matrix carries a date and the article it came from", () => {
    assert.ok(SUPPORT_MATRIX.asOf, "an undated matrix is worse than none");
    assert.match(SUPPORT_MATRIX.url, /^https:\/\//);
  });
});

describe("cluster corroboration", () => {
  test("a label matches its DataSource name loosely", () => {
    assert.ok(imageMatches("RHEL 9", "rhel9"));
    assert.ok(imageMatches("Windows Server 2022", "win2k22") === false, "a loose match must not become a wrong one");
    assert.ok(imageMatches("CentOS Stream 9", "centos-stream9"));
  });

  test("supported and shipped is corroborated; supported and not shipped is only documented", () => {
    const { rows } = reconcile(
      [{ distro: "RHEL 9", level: "supported", count: 4 }, { distro: "RHEL 8", level: "supported", count: 2 }],
      [{ name: "rhel9", ready: true }],
    );
    assert.equal(rows[0].status, "corroborated");
    assert.equal(rows[1].status, "documented");
    assert.match(rows[1].note, /ships no boot source/);
  });

  test("an image the matrix does not list suggests the matrix is older than the cluster", () => {
    const { rows, undocumented } = reconcile(
      [{ distro: "Ubuntu 30.04", level: "unknown", count: 1 }],
      [{ name: "rhel10", ready: true }],
    );
    assert.equal(rows[0].status, "matrix-only");
    assert.deepEqual(undocumented, ["rhel10"]);
  });

  test("an unready image does not count as corroboration", () => {
    const { rows } = reconcile([{ distro: "RHEL 9", level: "supported", count: 1 }], [{ name: "rhel9", ready: false }]);
    assert.equal(rows[0].status, "documented", "an image that is not Ready proves nothing");
  });
});

test("the posture degrades on an unreachable cluster without losing the matrix", async () => {
  const out = await supportPosture([
    { name: "a", guestOS: "Red Hat Enterprise Linux 9 (64-bit)" },
    { name: "b", guestOS: "Microsoft Windows Server 2012 R2 (64-bit)" },
    { name: "c" },
  ]);
  assert.equal(out.totals.machines, 3);
  assert.equal(out.totals.unreported, 1, "a machine with no guest OS is counted, not dropped");
  assert.ok(out.totals.unsupported >= 1, "Server 2012 R2 is known-to-run, not supported");
  assert.ok(out.matrix.asOf);
  assert.equal(out.images.readable, false);
  assert.match(out.images.reason, /cannot be corroborated/);
  assert.match(out.headline, /machines across/);
});

describe("what the model is allowed to do", () => {
  test("the digest carries facts, and no machine internals", async () => {
    const { digestForAdvice } = await import("../../src/services/containerization-advice.js");
    const d = digestForAdvice({
      fleet: { distinct: 40, observations: 47, funnel: { candidates: 9, candidatePctOfEstate: 22, notAssessed: 6 },
        portfolio: { topBlockers: [{ title: "PostgreSQL is running on this machine", count: 12, blocks: true, machines: ["a", "b"] }], byRuntime: [] },
        conflicts: [], dependencies: { supplied: false } },
      posture: { distributions: [{ distro: "RHEL 7", level: "unsupported", count: 20, image: null, status: "matrix-only" }],
        matrix: { asOf: "2026-09-02", age: { days: 26, stale: "current" }, url: "https://example" },
        cluster: { openshift: "4.20.3" }, unreported: 2 },
    });
    assert.equal(d.estate.distinctMachines, 40);
    assert.equal(d.operatingSystems[0].matrixSays, "unsupported",
      "the level is COMPUTED and handed to the model — the model never derives it");
    assert.equal(d.matrix.asOf, "2026-09-02");
    // No command lines, no addresses, no hostnames beyond the examples already
    // present in a finding.
    assert.ok(!JSON.stringify(d).includes("cmdLine"));
  });

  test("with no model configured the caller loses the narrative and nothing else", async () => {
    const { adviseOnAssessment } = await import("../../src/services/containerization-advice.js");
    const r = await adviseOnAssessment({ posture: { distributions: [] } });
    assert.equal(r.advisory, true);
    assert.equal(r.available, false);
    assert.equal(r.advice, null);
    assert.match(r.reason, /computed without one/);
  });
});
