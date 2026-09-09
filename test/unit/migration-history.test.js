import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stagesFrom, recordMigration, listMigrations, pruneHistory, _memoryRows, _clearMemory,
} from "../../src/services/migration-history.js";

test("the stage timeline is read from the plan, never accumulated", () => {
  // Every timestamp already exists on the Plan or its status, which is why the
  // row can be written once at the end instead of appended to as it goes — and
  // why a pod restart mid-copy loses nothing.
  const plan = {
    metadata: {
      creationTimestamp: "2026-09-09T10:00:00Z",
      annotations: {
        "tcs.agentic-ai/change-request-state": "approved",
        "tcs.agentic-ai/change-request-checked-at": "2026-09-09T11:00:00Z",
        "tcs.agentic-ai/change-request-closed": "2026-09-09T16:00:00Z",
      },
    },
  };
  const status = { vms: [{
    started: "2026-09-09T12:00:00Z", completed: "2026-09-09T15:00:00Z",
    steps: [
      { name: "DiskTransfer", completedAt: "2026-09-09T13:00:00Z" },
      { name: "Cutover", completedAt: "2026-09-09T14:30:00Z" },
    ],
  }] };

  const s = stagesFrom(plan, status, { verifiedAt: "2026-09-09T15:30:00Z" });
  assert.equal(s.created, "2026-09-09T10:00:00Z");
  assert.equal(s.approved, "2026-09-09T11:00:00Z");
  assert.equal(s.transferStarted, "2026-09-09T12:00:00Z");
  assert.equal(s.precopyDone, "2026-09-09T13:00:00Z");
  assert.equal(s.cutover, "2026-09-09T14:30:00Z");
  assert.equal(s.verified, "2026-09-09T15:30:00Z");
  assert.equal(s.closed, "2026-09-09T16:00:00Z");

  // A stage that never happened is null, not a guess. A cold migration has no
  // cutover, and inventing one would be worse than leaving it blank.
  const cold = stagesFrom({ metadata: { creationTimestamp: "2026-09-09T10:00:00Z" } },
    { vms: [{ started: "2026-09-09T12:00:00Z", steps: [{ name: "DiskTransfer", completedAt: "2026-09-09T13:00:00Z" }] }] });
  assert.equal(cold.cutover, null);
  assert.equal(cold.verified, null);
  // An unapproved plan has no approval time — the annotation only counts when
  // the state actually says approved.
  assert.equal(stagesFrom({ metadata: { annotations: {
    "tcs.agentic-ai/change-request-state": "submitted",
    "tcs.agentic-ai/change-request-checked-at": "2026-09-09T11:00:00Z",
  } } }, {}).approved, null);

  assert.deepEqual(stagesFrom({}, {}), {
    created: null, approved: null, transferStarted: null,
    precopyDone: null, cutover: null, finished: null, verified: null, closed: null,
  });
});

test("history survives the plan, and a rolled-back run is kept alongside its retry", async () => {
  _clearMemory();

  // The case this exists for: a migration is rolled back — which DELETES the
  // Plan — and the same machine is migrated again days later. Both attempts
  // have to be visible, which is why rows are keyed by a generated id and not
  // by plan name.
  const first = await recordMigration({
    planName: "mig-linux-warm-dev-20260909", outcome: "rolled-back",
    strategy: "warm", vmNames: ["redhat2"], totalGiB: 20, changeRequest: "CHG0030076",
    finishedAt: "2026-09-09T15:00:00Z", note: "Removed from OpenShift: virtualmachine/redhat2",
  });
  const second = await recordMigration({
    planName: "mig-linux-warm-dev-20260911", outcome: "migrated",
    strategy: "warm", vmNames: ["redhat2"], totalGiB: 20, changeRequest: "CHG0030081",
    finishedAt: "2026-09-11T15:00:00Z", estimatedMinutes: 21, actualMinutes: 26,
    verification: { verdict: "passed", counts: { pass: 5, warn: 0, fail: 0, unchecked: 0 } },
  });
  assert.notEqual(first.id, second.id, "each run is its own row");

  const { migrations } = await listMigrations({ limit: 10 });
  assert.equal(migrations.length, 2, "the rolled-back attempt is not overwritten by the retry");
  // Newest FIRST, by when the migration finished — the same order the database
  // returns, so the console shows the same list either way.
  assert.equal(migrations[0].planName, "mig-linux-warm-dev-20260911");
  assert.equal(migrations[1].planName, "mig-linux-warm-dev-20260909");
  assert.deepEqual(migrations.map((m) => m.outcome).sort(), ["migrated", "rolled-back"]);

  // Promised against measured, kept as a pair — the next estimate is only as
  // good as this measurement.
  const done = migrations.find((m) => m.outcome === "migrated");
  assert.equal(done.estimatedMinutes, 21);
  assert.equal(done.actualMinutes, 26);
  assert.equal(done.verification.verdict, "passed");

  // Filtering by plan finds one run without disturbing the other.
  assert.equal((await listMigrations({ planName: "mig-linux-warm-dev-20260911" })).migrations.length, 1);
});

test("without a database the history says so rather than looking durable", async () => {
  _clearMemory();
  await recordMigration({ planName: "p", outcome: "migrated" });
  const r = await listMigrations({});
  // The whole value of a history panel is that it can be believed. An
  // in-memory fallback that presents itself as an archive is worse than none.
  assert.equal(r.durable, false);
  assert.match(r.note, /lost when the pod restarts/);
  assert.match(r.note, /ServiceNow remain the durable record/);
  assert.equal(r.retentionDays, 365, "longer than the change ledger's 90 days");
});

test("retention is the only way a row leaves", async () => {
  _clearMemory();
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  await recordMigration({ planName: "ancient", outcome: "migrated", finishedAt: old });
  await recordMigration({ planName: "recent", outcome: "migrated" });
  assert.equal(_memoryRows().length, 2);

  const pruned = await pruneHistory();
  assert.equal(pruned.pruned, 1);
  assert.equal(_memoryRows().length, 1);
  assert.equal(_memoryRows()[0].planName, "recent");

  // There is no update path at all — history a writer can edit is not history.
  const mod = await import("../../src/services/migration-history.js");
  assert.equal(typeof mod.updateMigration, "undefined");
  assert.equal(typeof mod.deleteMigration, "undefined");
});
