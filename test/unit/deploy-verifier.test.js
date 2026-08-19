import { test } from "node:test";
import assert from "node:assert/strict";
import { rolloutStatus, classifyApply, probeVerdict, kindPath, kindApiVersion, applyRank } from "../../src/services/deploy-verifier.js";

// ── rolloutStatus: kubectl rollout status semantics ─────────────────────────
// These states are exactly the ones that made "readyReplicas >= desired" lie
// during UC-05: old pods still Ready while the new revision hasn't landed.

const dep = (over = {}) => ({
  kind: "Deployment",
  metadata: { name: "web", generation: 2, ...over.metadata },
  spec: { replicas: 2, ...over.spec },
  status: { observedGeneration: 2, updatedReplicas: 2, replicas: 2, readyReplicas: 2, unavailableReplicas: 0, ...over.status },
});

test("rollout complete passes", () => {
  const v = rolloutStatus(dep());
  assert.equal(v.ok, true);
  assert.match(v.summary, /rollout complete/);
});

test("controller has not observed the new generation → not complete", () => {
  const v = rolloutStatus(dep({ status: { observedGeneration: 1 } }));
  assert.equal(v.ok, false);
  assert.match(v.summary, /not observed/);
});

test("old pods still Ready but new revision not rolled out → not complete", () => {
  // The UC-05 trap: readyReplicas satisfies spec.replicas, yet these are the OLD pods.
  const v = rolloutStatus(dep({ status: { updatedReplicas: 0, readyReplicas: 2 } }));
  assert.equal(v.ok, false);
  assert.match(v.summary, /0\/2 new replicas/);
});

test("old replicas still terminating → not complete", () => {
  const v = rolloutStatus(dep({ status: { updatedReplicas: 2, replicas: 3 } }));
  assert.equal(v.ok, false);
  assert.match(v.summary, /old replica/);
});

test("unavailable replicas → not complete", () => {
  const v = rolloutStatus(dep({ status: { unavailableReplicas: 1 } }));
  assert.equal(v.ok, false);
  assert.match(v.summary, /unavailable/);
});

test("ready below desired → not complete", () => {
  const v = rolloutStatus(dep({ status: { readyReplicas: 1 } }));
  assert.equal(v.ok, false);
  assert.match(v.summary, /1\/2 replicas ready/);
});

test("statefulset revision mismatch → not complete", () => {
  const v = rolloutStatus({
    kind: "StatefulSet",
    metadata: { name: "db", generation: 2 },
    spec: { replicas: 1 },
    status: { observedGeneration: 2, updatedReplicas: 1, replicas: 1, readyReplicas: 1, currentRevision: "db-1", updateRevision: "db-2" },
  });
  assert.equal(v.ok, false);
  assert.match(v.summary, /revision/);
});

test("scaled to zero on purpose is not a failure", () => {
  const v = rolloutStatus(dep({ spec: { replicas: 0 }, status: { updatedReplicas: 0, replicas: 0, readyReplicas: 0 } }));
  assert.equal(v.ok, true);
});

test("daemonset: updated below desired → not complete; complete passes", () => {
  const ds = (st) => ({ kind: "DaemonSet", metadata: { name: "agent", generation: 1 }, status: { observedGeneration: 1, ...st } });
  assert.equal(rolloutStatus(ds({ desiredNumberScheduled: 3, updatedNumberScheduled: 2, numberReady: 2, numberUnavailable: 0 })).ok, false);
  assert.equal(rolloutStatus(ds({ desiredNumberScheduled: 3, updatedNumberScheduled: 3, numberReady: 3, numberUnavailable: 0 })).ok, true);
});

test("missing object → not ok", () => {
  assert.equal(rolloutStatus(null).ok, false);
});

// ── classifyApply: kubectl-apply-style action reporting ─────────────────────

test("no prior object → created", () => {
  assert.equal(classifyApply(null, { metadata: { resourceVersion: "5" } }), "created");
});

test("resourceVersion bumped → configured", () => {
  assert.equal(classifyApply({ metadata: { resourceVersion: "5" } }, { metadata: { resourceVersion: "9" } }), "configured");
});

test("resourceVersion unchanged → unchanged", () => {
  assert.equal(classifyApply({ metadata: { resourceVersion: "5" } }, { metadata: { resourceVersion: "5" } }), "unchanged");
});

test("dry-run on an existing object can only claim configured, never unchanged", () => {
  // A dry-run never bumps resourceVersion, so equality proves nothing.
  assert.equal(classifyApply({ metadata: { resourceVersion: "5" } }, { metadata: { resourceVersion: "5" } }, { dryRun: true }), "configured");
});

// ── probeVerdict: the router's 503 means the user cannot use this yet ───────

test("2xx/3xx serve, 4xx reachable-but-flagged, 5xx fail, null unreachable", () => {
  assert.equal(probeVerdict(200).ok, true);
  assert.equal(probeVerdict(302).ok, true);
  const auth = probeVerdict(401);
  assert.equal(auth.ok, true);
  assert.match(auth.label, /reachable/);
  assert.equal(probeVerdict(503).ok, false);
  assert.equal(probeVerdict(null).ok, false);
});

// ── kind routing stays consistent with itself ───────────────────────────────

test("every pathed kind has an apiVersion and a rank", () => {
  for (const k of ["Deployment", "Service", "Route", "Secret", "NetworkPolicy", "Job", "StatefulSet", "HorizontalPodAutoscaler"]) {
    assert.ok(kindPath(k, "ns"), `path for ${k}`);
    assert.ok(kindApiVersion(k), `apiVersion for ${k}`);
    assert.equal(typeof applyRank(k), "number");
  }
  assert.equal(kindPath("NotAKind", "ns"), null);
});

test("apply order: namespace before config before workloads before exposure", () => {
  assert.ok(applyRank("Namespace") < applyRank("Secret"));
  assert.ok(applyRank("Secret") < applyRank("Deployment"));
  assert.ok(applyRank("Deployment") < applyRank("Route"));
  assert.ok(applyRank("NetworkPolicy") < applyRank("Deployment"));
});
