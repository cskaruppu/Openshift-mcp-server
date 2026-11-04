import { test } from "node:test";
import assert from "node:assert/strict";
import * as AS from "../../src/services/private-ai/autosleep.js";

function setup(t0) {
  AS._resetAutoSleep();
  let now = t0;
  const isvc = { "llama-3-1-8b": { stopped: false }, "bge-m3": { stopped: false } };
  const calls = [];
  const models = [
    { model: "llama-3-1-8b", role: "small", cluster: "gpu", url: "http://llama" },
    { model: "bge-m3", role: "embed", cluster: "gpu", url: "http://bge" },
  ];
  AS.configureAutoSleep({
    models: () => models,
    health: async (m) => ({ ok: !isvc[m.model].stopped }),
    running: async (_c, name) => isvc[name] || null,
    setRunning: async (c, name, run) => { calls.push([c, name, run]); isvc[name].stopped = !run; },
    preferred: () => "gpu",
    audit: () => {},
    now: () => now,
  });
  return { advance: (min) => { now += min * 60_000; }, isvc, calls, at: () => now };
}

test("a quiet model sleeps after its idle limit; an answer resets the clock", async () => {
  const c = setup(Date.parse("2026-11-04T02:00:00Z"));
  AS.setPolicy({ model: "llama-3-1-8b", enabled: true, idleMin: 30 });
  c.advance(20);
  AS.noteUse({ model: "llama-3-1-8b", cluster: "gpu", at: new Date(c.at()).toISOString(), onPrem: true });
  c.advance(20);
  assert.deepEqual((await AS.tick()).slept, [], "used 20 min ago: still awake");
  c.advance(15);
  assert.deepEqual((await AS.tick()).slept, ["llama-3-1-8b"]);
  assert.deepEqual(c.calls.at(-1), ["gpu", "llama-3-1-8b", false]);
  assert.ok(AS.status().models["llama-3-1-8b"].asleep);
  assert.equal(c.isvc["bge-m3"].stopped, false, "a model without a policy is never touched");
});

test("a request for a sleeping model wakes it; the wake is timed", async () => {
  const c = setup(Date.parse("2026-11-04T02:00:00Z"));
  AS.setPolicy({ model: "llama-3-1-8b", enabled: true, idleMin: 10 });
  c.advance(11); await AS.tick();
  const w = AS.wakeFor("small");
  assert.equal(w.model, "llama-3-1-8b");
  await new Promise((r) => setImmediate(r));
  assert.equal(c.isvc["llama-3-1-8b"].stopped, false);
  const starts = c.calls.filter((x) => x[2] === true).length;
  assert.equal(AS.wakeFor("small").model, "llama-3-1-8b", "still waking: the router keeps saying so");
  await new Promise((r) => setImmediate(r));
  assert.equal(c.calls.filter((x) => x[2] === true).length, starts, "no second start while waking");
  c.advance(2); await AS.tick();
  assert.equal(AS.status().models["llama-3-1-8b"].woke.seconds, 120);
  c.advance(5);
  assert.deepEqual((await AS.tick()).slept, [], "the wake counts as activity");
});

test("keep-awake hours: no sleep inside them, and a sleeping model wakes when they begin", async () => {
  // 2026-11-04 is a Wednesday. 07:30 UTC, window Mon–Fri 08:00–20:00 UTC.
  const c = setup(Date.parse("2026-11-04T07:30:00Z"));
  const keepAwake = { days: [1, 2, 3, 4, 5], from: "08:00", to: "20:00", tz: "UTC" };
  AS.setPolicy({ model: "llama-3-1-8b", enabled: true, idleMin: 10, keepAwake });
  c.advance(11); await AS.tick();
  assert.ok(AS.status().models["llama-3-1-8b"].asleep, "07:41: outside the hours, asleep");
  c.advance(20);
  assert.deepEqual((await AS.tick()).woke, ["llama-3-1-8b"], "08:01: hours began, woken");
  c.advance(60);
  assert.deepEqual((await AS.tick()).slept, [], "09:01: inside the hours, stays awake");
  assert.equal(AS.inWindow({ days: [1, 2, 3, 4, 5], from: "20:00", to: "06:00", tz: "UTC" }, Date.parse("2026-11-05T03:00:00Z")), true, "overnight window");
});

test("always on and invalid policies", async () => {
  const c = setup(Date.parse("2026-11-04T02:00:00Z"));
  AS.setPolicy({ model: "bge-m3", enabled: true, idleMin: 10, alwaysOn: true });
  c.advance(60);
  assert.deepEqual((await AS.tick()).slept, []);
  assert.throws(() => AS.setPolicy({ model: "llama-3-1-8b", enabled: true, idleMin: 7 }), /Idle limit/);
  assert.throws(() => AS.setPolicy({ model: "Bad Name", enabled: true }), /Not a valid model/);
  assert.throws(() => AS.setPolicy({ model: "llama-3-1-8b", enabled: true, keepAwake: { days: [], from: "8", to: "20:00" } }), /Keep-awake/);
});

test("started by hand while asleep: auto-sleep notices and can sleep it again later", async () => {
  const c = setup(Date.parse("2026-11-04T02:00:00Z"));
  AS.setPolicy({ model: "llama-3-1-8b", enabled: true, idleMin: 10 });
  c.advance(11); await AS.tick();
  c.isvc["llama-3-1-8b"].stopped = false;   // someone pressed Start
  c.advance(1); await AS.tick();
  assert.equal(AS.status().models["llama-3-1-8b"].asleep, null);
  c.advance(11);
  assert.deepEqual((await AS.tick()).slept, ["llama-3-1-8b"]);
});
