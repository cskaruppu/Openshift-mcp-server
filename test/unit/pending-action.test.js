import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingAction } from "../../src/services/vm-migration.js";

const gate = (o = {}) => ({ required: true, approved: false, number: null, state: "none", ...o });
const dec = (o = {}) => ({ number: null, state: "none", raised: false, approved: false, ...o });

test("an unapproved plan is waiting on the board, not on the phase", () => {
  const p = pendingAction({ phase: "ready", gate: gate({ number: "CHG001", state: "submitted" }), decommission: dec() });
  assert.equal(p.owner, "change board");
  assert.match(p.action, /CHG001/);
  assert.equal(p.done, false);
});

test("no change request yet is the operator's move", () => {
  const p = pendingAction({ phase: "validating", gate: gate(), decommission: dec() });
  assert.equal(p.owner, "you");
  assert.match(p.action, /Raise a change request/);
});

test("a rejected request says raise a new one, and does not read as approved", () => {
  const p = pendingAction({ phase: "ready", gate: gate({ number: "CHG002", state: "rejected" }), decommission: dec() });
  assert.equal(p.owner, "you");
  assert.match(p.action, /rejected/);
});

test("approved and ready is the operator's move to start", () => {
  const p = pendingAction({ phase: "ready", gate: gate({ number: "CHG003", state: "approved", approved: true }), decommission: dec() });
  assert.equal(p.owner, "you");
  assert.match(p.action, /start the migration/i);
});

test("a warm plan holding after precopy asks for a cutover, not a restart", () => {
  const p = pendingAction({ phase: "awaiting-cutover", warm: true, gate: gate({ approved: true, number: "CHG004", state: "approved" }), decommission: dec() });
  assert.equal(p.owner, "you");
  assert.match(p.action, /cut over/i);
});

// The case the console could not show at all: MTV calls this finished, we do not.
test("migrated with a decommission awaiting approval is pending, not done", () => {
  const p = pendingAction({
    phase: "migrated",
    gate: gate({ approved: true, number: "CHG005", state: "approved" }),
    decommission: dec({ number: "CHG006", state: "submitted", raised: true }),
  });
  assert.equal(p.done, false, "a plan awaiting decommission approval still has work left");
  assert.equal(p.owner, "change board");
  assert.match(p.action, /CHG006/);
});

test("migrated with an approved decommission waits on the VMware team", () => {
  const p = pendingAction({
    phase: "migrated",
    gate: gate({ approved: true }),
    decommission: dec({ number: "CHG007", state: "approved", raised: true, approved: true }),
  });
  assert.equal(p.owner, "VMware team");
  assert.equal(p.done, false);
});

test("migrated with nothing raised invites verification and retirement", () => {
  const p = pendingAction({ phase: "migrated", gate: gate({ approved: true }), decommission: dec() });
  assert.equal(p.owner, "you");
  assert.match(p.action, /Verify/);
  assert.equal(p.done, false);
});

test("a rejected decommission is genuinely done — the sources stay", () => {
  const p = pendingAction({
    phase: "migrated", gate: gate({ approved: true }),
    decommission: dec({ number: "CHG008", state: "rejected", raised: true }),
  });
  assert.equal(p.done, true, "nothing is pending once the board says the sources stay");
});

test("a failed plan is done and says so without chasing anyone", () => {
  const p = pendingAction({ phase: "failed", gate: gate(), decommission: dec() });
  assert.equal(p.done, true);
  assert.equal(p.owner, "you");
});

test("transferring belongs to nobody — it is the machine's turn", () => {
  const cold = pendingAction({ phase: "transferring", warm: false, gate: gate({ approved: true }), decommission: dec() });
  assert.equal(cold.owner, "nobody");
  assert.match(cold.action, /guests are down/i);
  const warm = pendingAction({ phase: "transferring", warm: true, gate: gate({ approved: true }), decommission: dec() });
  assert.match(warm.action, /stay up/i);
});

// Reopen keys off `done`, so every state must set it deliberately.
test("every phase yields a boolean done and a non-empty action", () => {
  for (const phase of ["validating", "ready", "transferring", "awaiting-cutover", "migrated", "failed"]) {
    const p = pendingAction({ phase, gate: gate({ approved: true }), decommission: dec() });
    assert.equal(typeof p.done, "boolean", `${phase} must decide done`);
    assert.ok(p.action && p.action.length > 10, `${phase} must say something useful`);
    assert.ok(["you", "change board", "VMware team", "nobody"].includes(p.owner), `${phase} owner "${p.owner}" has no badge`);
  }
});
