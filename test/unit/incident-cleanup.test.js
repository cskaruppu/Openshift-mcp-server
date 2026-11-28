import { test } from "node:test";
import assert from "node:assert/strict";
import * as IM from "../../src/services/incident-manager.js";

const day = 86400000;
const at = (d) => new Date(Date.now() - d * day).toISOString();
const row = (id, title, { d = 0, upd = d, status = "declared", src = "agent-health-sweep", cluster = "local" } = {}) => ({
  incident_id: id, title, status, cluster, severity: "sev2", created_at: at(d), updated_at: at(upd),
  timeline: [{ ts: at(d), actor: src, action: "declared" }],
});

test("plan: duplicates of a newer open record and stale records are closed; the newest is kept", () => {
  const rows = [
    row("INC-1", "Agent rca canary failed", { d: 30 }), row("INC-2", "Agent rca canary failed", { d: 20 }), row("INC-3", "Agent rca canary failed", { d: 1 }),
    row("INC-4", "payments-api down", { d: 10, src: "admin" }), row("INC-5", "disk full", { d: 2, src: "admin" }),
    row("INC-6", "Agent rca canary failed", { d: 5, cluster: "ocp-prod-01" }),
  ];
  const p = IM.planCleanup(rows, { olderThanDays: 7 });
  const ids = p.close.map((c) => c.id).sort();
  assert.deepEqual(ids, ["INC-1", "INC-2", "INC-4"]);
  assert.equal(p.duplicates, 2);
  assert.equal(p.stale, 1);
  assert.equal(p.keep, 3);
  assert.equal(p.groups[0].count, 2);
  assert.equal(p.groups[0].source, "agent-health-sweep");
  const noDup = IM.planCleanup(rows, { olderThanDays: 7, duplicates: false });
  assert.deepEqual(noDup.close.map((c) => c.id).sort(), ["INC-1", "INC-2", "INC-4"], "without duplicate matching, only age counts");
  assert.equal(noDup.duplicates, 0);
});

test("preview changes nothing; run closes with a note and keeps the record", async () => {
  IM._seedIncidentsForTest([
    row("INC-10", "Agent x canary failed", { d: 40 }), row("INC-11", "Agent x canary failed", { d: 3 }),
    row("INC-12", "old one", { d: 50, src: "admin" }), row("INC-13", "recent", { d: 1, src: "admin" }),
    row("INC-14", "already closed", { d: 60, status: "closed" }),
  ]);
  const pv = await IM.previewCleanup({ olderThanDays: 7 });
  assert.equal(pv.open, 4);
  assert.equal(pv.toClose, 2);
  assert.equal(pv.close, undefined, "the preview does not ship the rows");
  assert.equal((await IM.getIncident("INC-10")).status, "declared");
  const out = await IM.runCleanup({ olderThanDays: 7, actor: "tester" });
  assert.equal(out.closed, 2);
  const a = await IM.getIncident("INC-10");
  assert.equal(a.status, "closed");
  assert.match(a.resolution_note, /duplicate of INC-11/);
  assert.equal(a.timeline.at(-1).actor, "tester");
  assert.equal((await IM.getIncident("INC-11")).status, "declared");
  assert.equal((await IM.getIncident("INC-13")).status, "declared");
  assert.equal((await IM.runCleanup({ olderThanDays: 7 })).closed, 0, "running again closes nothing");
});

test("an open incident is found again after a restart, so it is not raised twice", async () => {
  IM._seedIncidentsForTest([row("INC-20", "Agent y canary failed", { d: 2 })]);
  const f = await IM.findOpenIncident({ title: "Agent y canary failed", declaredBy: "agent-health-sweep" });
  assert.equal(f.incident_id, "INC-20");
  assert.equal(await IM.findOpenIncident({ title: "Agent y canary failed", declaredBy: "someone-else" }), null);
});
