import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLUSTER_LABELS_PATH = join(mkdtempSync(join(tmpdir(), "labels-")), "labels.json");
const CL = await import("../../src/services/cluster-labels.js");

test("a display name is stored per cluster ID and can be cleared", async () => {
  CL._resetClusterLabels();
  const r = await CL.setClusterLabel("cluster02-gpu", "  Dell AI Factory - Private AI ");
  assert.equal(r.label, "Dell AI Factory - Private AI");
  assert.deepEqual(CL.clusterLabels(), { "cluster02-gpu": "Dell AI Factory - Private AI" });
  CL._resetClusterLabels();
  assert.deepEqual(await CL.restoreClusterLabels(), { "cluster02-gpu": "Dell AI Factory - Private AI" });
  await CL.setClusterLabel("cluster02-gpu", "");
  assert.deepEqual(CL.clusterLabels(), {});
});

test("display names reject markup, overlong names and bad IDs", async () => {
  await assert.rejects(CL.setClusterLabel("cluster02-gpu", "<script>"), /letters/);
  await assert.rejects(CL.setClusterLabel("cluster02-gpu", "x".repeat(61)), /at most 60/);
  await assert.rejects(CL.setClusterLabel("../etc", "x"), /cluster ID/);
});
