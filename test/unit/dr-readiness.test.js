/**
 * DR readiness scoring, lifted out of the Velero MCP tool handler.
 *
 * The extraction exists so this can be checked without a cluster, and the
 * reason it was worth doing is the first test here: an absent OADP operator is
 * an ordinary 404. Nothing throws, nothing alerts, and a readiness panel that
 * renders that as anything other than "nothing could be restored" is the most
 * expensive wrong number this product can show.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreDrReadiness } from "../../src/tools/velero.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const healthy = (over = {}) => ({
  installed: true, now: NOW,
  backups: [{ name: "daily-1", phase: "Completed", completionTimestamp: daysAgo(1), startTimestamp: daysAgo(1), expiration: daysAgo(-30) }],
  schedules: [{ name: "daily", paused: false }],
  locations: [{ status: { phase: "Available" } }],
  ...over,
});

test("no Velero scores 0/F and says nothing could be restored", () => {
  const r = scoreDrReadiness({ installed: false, error: "404 not found" });
  assert.equal(r.score, 0);
  assert.equal(r.grade, "F");
  assert.equal(r.installed, false);
  assert.match(r.findings[0].message, /not a passing state/);
  assert.equal(r.findings[0].severity, "critical");
});

test("a healthy setup grades A with no critical findings", () => {
  const r = scoreDrReadiness(healthy());
  assert.equal(r.grade, "A");
  assert.equal(r.installed, true);
  assert.equal(r.findings.filter((f) => f.severity === "critical").length, 0);
});

test("never having completed a backup cannot reach A or B", () => {
  const r = scoreDrReadiness(healthy({ backups: [] }));
  assert.ok(["C", "D", "F"].includes(r.grade), `graded ${r.grade}`);
  assert.ok(r.findings.some((f) => /No successful backup has ever completed/.test(f.message)));
});

test("paused schedules are not schedules", () => {
  const r = scoreDrReadiness(healthy({ schedules: [{ name: "daily", paused: true }] }));
  assert.ok(r.findings.some((f) => /All backup schedules are paused/.test(f.message)));
});

test("no schedule at all is reported separately from a paused one", () => {
  const r = scoreDrReadiness(healthy({ schedules: [] }));
  assert.ok(r.findings.some((f) => /No backup schedules defined/.test(f.message)));
});

test("a stale backup is reported with its real age", () => {
  const r = scoreDrReadiness(healthy({
    backups: [{ name: "old", phase: "Completed", completionTimestamp: daysAgo(180), startTimestamp: daysAgo(180), expiration: daysAgo(-1) }],
    maxBackupAgeDays: 7,
  }));
  assert.equal(r.summary.lastSuccessfulBackupAgeDays, 180);
  assert.ok(r.findings.some((f) => /180 days old \(threshold 7\)/.test(f.message)));
});

test("storage that exists but is not Available is critical, and distinct from none at all", () => {
  const none = scoreDrReadiness(healthy({ locations: [] }));
  const broken = scoreDrReadiness(healthy({ locations: [{ status: { phase: "Unavailable" } }] }));
  assert.ok(none.findings.some((f) => /No BackupStorageLocations defined/.test(f.message)));
  assert.ok(broken.findings.some((f) => /No BackupStorageLocations are Available/.test(f.message)));
});

test("recent failures lower the score but are capped", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, phase: "Failed", startTimestamp: daysAgo(1), expiration: daysAgo(-1) }));
  const r = scoreDrReadiness(healthy({ backups: [...healthy().backups, ...many] }));
  assert.ok(r.findings.some((f) => /10 backup\(s\) failed in the last 7 days/.test(f.message)));
  assert.ok(r.score >= 0, "the score never goes negative");
});

test("the score is clamped to 0 and never negative", () => {
  const r = scoreDrReadiness({ installed: true, now: NOW, backups: [], schedules: [], locations: [] });
  assert.ok(r.score >= 0);
  assert.equal(r.grade, "F");
});

test("the summary reports what was read, not what was assumed", () => {
  const r = scoreDrReadiness(healthy());
  assert.equal(r.summary.totalBackups, 1);
  assert.equal(r.summary.completed, 1);
  assert.equal(r.summary.schedules, 1);
  assert.equal(r.summary.storageLocations, 1);
  assert.equal(r.summary.availableStorageLocations, 1);
  assert.equal(r.summary.lastSuccessfulBackup, "daily-1");
});

test("the clock is injectable, so the grade does not drift with wall time", () => {
  const a = scoreDrReadiness(healthy());
  const b = scoreDrReadiness(healthy());
  assert.deepEqual(a, b);
  assert.equal(a.summary.lastSuccessfulBackupAgeDays, 1);
});
