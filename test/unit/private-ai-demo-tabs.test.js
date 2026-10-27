import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRIVATE_AI_SETTINGS_PATH = join(mkdtempSync(join(tmpdir(), "pai-set-")), "s.json");
const PS = await import("../../src/services/private-ai/settings.js");

test("demo tabs: event by default, product or hidden when chosen, anything else refused, kept across a restart", async () => {
  PS._resetPrivateAiSettings();
  assert.equal(PS.effectiveSettings().demoTabs, "event");
  await PS.savePrivateAiSettings({ demoTabs: "product" });
  assert.equal(PS.effectiveSettings().demoTabs, "product");
  await assert.rejects(PS.savePrivateAiSettings({ demoTabs: "everything" }), /event, product or hidden/);
  await PS.savePrivateAiSettings({ demoTabs: "hidden" });
  PS._resetPrivateAiSettings();
  await PS.restorePrivateAiSettings();
  assert.equal(PS.effectiveSettings().demoTabs, "hidden");
  PS._resetPrivateAiSettings();
});
