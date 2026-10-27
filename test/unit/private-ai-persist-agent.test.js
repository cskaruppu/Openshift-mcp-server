import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An agent (MCP_MODE=spoke) must never write the Factory record: it shares the hub's
// database through the relay and would overwrite the control plane's copy.
process.env.MCP_MODE = "spoke";
const file = join(mkdtempSync(join(tmpdir(), "pai-agent-")), "state.json");
process.env.PRIVATE_AI_STATE_PATH = file;
const P = await import("../../src/services/private-ai/persist.js");

test("an agent neither saves nor restores the Private AI Factory record", async () => {
  P.registerPart("x", { exportState: () => ({ a: 1 }), importState: () => { throw new Error("must not restore"); } });
  assert.match(await P.save(), /agent/);
  assert.equal(existsSync(file), false);
  assert.equal((await P.restore()).restored, false);
  assert.equal(P.persistStatus().owner, false);
  delete process.env.MCP_MODE;
});
