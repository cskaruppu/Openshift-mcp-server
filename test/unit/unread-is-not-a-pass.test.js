/**
 * One habit, five places: catch the read failure, return an empty list, score
 * the empty list. The empty list always scores well.
 *
 * Each test below drives one of those places into the state where it used to
 * lie. They are collected in one file deliberately — the bug is not five bugs,
 * it is one reflex appearing five times, and seeing them together is the point.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreDrReadiness, veleroPresence, veleroReadReason } from "../../src/tools/velero.js";

const err = (msg) => new Error(msg);

// ── 1 & 5. DR readiness: absent, unreadable, and the four copies ─────────

test("a 404 means Velero is absent — grade F is earned", () => {
  const r = scoreDrReadiness({ installed: veleroPresence(err("OCP API 404 Not Found")) });
  assert.equal(r.installed, false);
  assert.equal(r.score, 0);
  assert.equal(r.grade, "F");
  assert.match(r.findings[0].message, /no backups at all/);
});

test("a 403 does not prove absence — it is unknown, with no grade", () => {
  // The product learned this with MTA: the API server authorises before it
  // routes, so a 403 says nothing about whether the thing exists.
  const r = scoreDrReadiness({ installed: veleroPresence(err("OCP API 403 Forbidden")), error: "forbidden" });
  assert.equal(r.installed, null);
  assert.equal(r.score, null);
  assert.equal(r.grade, "—");
  assert.match(r.findings[0].message, /neither a pass nor a failure/);
});

test("an unreachable cluster is unknown, not absent", () => {
  const r = scoreDrReadiness({ installed: veleroPresence(err("fetch failed")) });
  assert.equal(r.installed, null);
  assert.equal(r.score, null);
});

test("the failure reason is in words, not an internal URL", () => {
  assert.equal(veleroReadReason(err("OCP API 403 Forbidden")), "this service account may not read velero.io resources");
  assert.equal(veleroReadReason(err("OCP API 401 Unauthorized")), "the cluster rejected the credential");
  assert.match(veleroReadReason(err("Failed to parse URL from https://undefined:undefined/apis")), /could not be reached/);
  assert.doesNotMatch(veleroReadReason(err("Failed to parse URL from https://undefined:undefined/apis")), /undefined:undefined/);
});

test("optional reads that FAILED are not scored as 'none configured'", () => {
  // Deducting 25 points for "no backup schedules" when nobody could list them
  // turns a permissions gap into a backup gap.
  const base = {
    installed: true, now: Date.parse("2026-06-01T00:00:00Z"),
    backups: [{ name: "b", phase: "Completed", completionTimestamp: "2026-05-31T00:00:00Z", expiration: "x" }],
    locations: [{ status: { phase: "Available" } }],
  };
  const unread = scoreDrReadiness({ ...base, schedules: [], schedulesRead: false });
  const genuinelyNone = scoreDrReadiness({ ...base, schedules: [], schedulesRead: true });
  assert.ok(unread.score > genuinelyNone.score, `unread ${unread.score} should beat a real gap ${genuinelyNone.score}`);
  assert.deepEqual(unread.unreadable, ["Schedules"]);
  assert.match(unread.note, /could not be read/);
  assert.equal(genuinelyNone.unreadable, null);
});

test("the scorer reports the counts the dashboard widget needs, so nothing has to re-derive them", () => {
  // The widget used to regex the failure count back out of a finding's prose,
  // and a sibling copy invented a storage-location count from the schedule
  // count. Both are gone; the summary carries the facts.
  const r = scoreDrReadiness({
    installed: true, now: Date.parse("2026-06-01T00:00:00Z"),
    backups: [
      { name: "ok", phase: "Completed", completionTimestamp: "2026-05-31T00:00:00Z", expiration: "x" },
      { name: "bad", phase: "Failed", startTimestamp: "2026-05-31T00:00:00Z", expiration: "x" },
    ],
    schedules: [{ name: "daily", paused: false }, { name: "weekly", paused: true }],
    locations: [{ status: { phase: "Available" } }],
  });
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.schedules, 2);
  assert.equal(r.summary.activeSchedules, 1);
  assert.equal(r.summary.storageLocations, 1);
});

test("DR readiness is implemented exactly once", async () => {
  // Four copies disagreed. The dashboard's reported `installed: true` on a
  // cluster with no Velero, because every read was caught into an empty list
  // so its "not installed" branch was unreachable.
  const { readFile } = await import("node:fs/promises");
  const files = [
    "src/services/dashboard-api.js",
    "src/services/chat-api.js",
    "src/index.js",
  ];
  for (const f of files) {
    const src = await readFile(new URL(`../../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /score -= 30;[\s\S]{0,400}No BackupStorageLocations/,
      `${f} still carries its own copy of the DR scoring`);
  }
});

// ── 2. The verification pyramid ─────────────────────────────────────────

test("an unreadable namespace is unverified, and every level says which", async () => {
  const { verifyNamespace } = await import("../../src/services/deploy-verifier.js");
  const r = await verifyNamespace("a-namespace-that-cannot-be-read");
  assert.equal(r.passed, false);
  assert.equal(r.unread, true, "the result must distinguish 'broken' from 'nobody could look'");
  assert.match(r.unreadNote, /unverified, not failed/);

  for (const level of r.levels) {
    assert.equal(level.passed, false, `${level.id} passed on a namespace nobody could read`);
  }
  // The specific sentences that used to be asserted over nothing.
  const details = r.levels.flatMap((l) => l.checks.map((c) => c.detail)).join(" | ");
  assert.doesNotMatch(details, /none in a failure state/);
  assert.doesNotMatch(details, /no Routes exposed — internal application/);
  assert.doesNotMatch(details, /no selector-bearing Services to check/);
});

// ── 3 & 4 are exercised through their tool handlers, which need a cluster;
// their pure parts are asserted by the agents' canaries. What CAN be asserted
// here is that the reflex itself is gone from the source.

test("no scorer still silently swallows a read failure into an empty list", async () => {
  const { readFile } = await import("node:fs/promises");
  const checked = [
    ["src/services/deploy-verifier.js", /catch \{ return \{ items: \[\] \}; \}/],
    ["src/tools/recommendations.js", /clusteroperators"\)\.catch\(\(\) => \(\{ items: \[\] \}\)\)/],
  ];
  for (const [f, pattern] of checked) {
    const src = await readFile(new URL(`../../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, pattern,
      `${f} still catches a read failure into an empty list with no marker — the empty list then scores well`);
  }
});
