/**
 * Regression tests for src/services/nlu.js
 *
 * Every query that has ever produced the wrong answer in production lives
 * here. A new bug => add a row, fix the parser, run `npm test`.
 *
 * Run with: node --test test/unit/nlu.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../../src/services/nlu.js";

// Helper: assert a subset of the parsed object matches.
function assertParse(input, expected, memory) {
  const got = parse(input, memory);
  for (const [k, v] of Object.entries(expected)) {
    assert.deepStrictEqual(
      got[k], v,
      `parse(${JSON.stringify(input)}).${k} = ${JSON.stringify(got[k])}, expected ${JSON.stringify(v)}\nfull: ${JSON.stringify(got)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Namespace extraction — the historically-bug-prone area
// ---------------------------------------------------------------------------
test("namespace: 'list of pods running on namespace trident'", () => {
  assertParse("list of pods running on namespace trident", {
    intent: "list", resource: "pod", namespace: "trident",
  });
});

test("namespace: 'how many pods running under trident namespace'", () => {
  assertParse("how many pods running under trident namespace", {
    intent: "list", resource: "pod", namespace: "trident", scope: "count",
  });
});

test("namespace: 'show pods in trident'", () => {
  assertParse("show pods in trident", {
    intent: "list", resource: "pod", namespace: "trident",
  });
});

test("namespace: 'pods in openshift-monitoring'", () => {
  assertParse("pods in openshift-monitoring", {
    resource: "pod", namespace: "openshift-monitoring",
  });
});

test("namespace: '-n trident get pods'", () => {
  assertParse("-n trident get pods", {
    intent: "get", resource: "pod", namespace: "trident",
  });
});

test("namespace: 'show me pods of namespace default'", () => {
  // 'of' is dropped; 'namespace default' wins.
  assertParse("show me pods of namespace default", {
    intent: "list", resource: "pod", namespace: "default",
  });
});

test("namespace: 'list pods --namespace kasten-io'", () => {
  assertParse("list pods --namespace kasten-io", {
    intent: "list", resource: "pod", namespace: "kasten-io",
  });
});

test("namespace: 'kasten-io project pods'", () => {
  assertParse("kasten-io project pods", {
    resource: "pod", namespace: "kasten-io",
  });
});

test("namespace: NEVER capture resource word as namespace", () => {
  // The classic failure: "list of pods" must not capture pods as namespace.
  const got = parse("list of pods");
  assert.equal(got.namespace, null);
  assert.equal(got.resource, "pod");
});

test("namespace: NEVER capture verb as namespace", () => {
  const got = parse("for running pods");
  assert.equal(got.namespace, null);
});

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------
test("intent: list with 'list'", () => {
  assertParse("list deployments", { intent: "list", resource: "deployment" });
});

test("intent: list with 'show'", () => {
  assertParse("show me services", { intent: "list", resource: "service" });
});

test("intent: count with 'how many'", () => {
  assertParse("how many pods are running?", {
    intent: "list", resource: "pod", scope: "count",
  });
});

test("intent: get with 'describe'", () => {
  assertParse("describe pod nginx-12345 in default", {
    intent: "get", resource: "pod", name: "nginx-12345", namespace: "default",
  });
});

test("intent: delete", () => {
  assertParse("delete pod stuck-pod-abc in trident", {
    intent: "delete", resource: "pod", name: "stuck-pod-abc", namespace: "trident",
  });
});

test("intent: logs without 'pod' keyword", () => {
  // Should infer resource=pod
  assertParse("show logs for nginx-12345 in default", {
    intent: "logs", resource: "pod", name: "nginx-12345", namespace: "default",
  });
});

test("intent: logs with --tail", () => {
  const p = parse("logs nginx-12345 in default tail 200");
  assert.equal(p.intent, "logs");
  assert.equal(p.options.tail, 200);
});

test("intent: top pods", () => {
  assertParse("top pods in trident", {
    intent: "top", resource: "pod", namespace: "trident",
  });
});

test("intent: exec", () => {
  const p = parse('exec nginx-12345 in default -- ls /tmp');
  assert.equal(p.intent, "exec");
  assert.equal(p.resource, "pod");
  assert.equal(p.name, "nginx-12345");
  assert.equal(p.namespace, "default");
  assert.equal(p.options.command, "ls /tmp");
});

test("intent: run image", () => {
  const p = parse("run image: nginx:latest in default");
  assert.equal(p.intent, "run");
  assert.equal(p.options.image, "nginx:latest");
  assert.equal(p.namespace, "default");
});

test("intent: scale deployment", () => {
  const p = parse("scale deployment nginx to 5 in default");
  assert.equal(p.intent, "update");
  assert.equal(p.resource, "deployment");
  assert.equal(p.name, "nginx");
  assert.equal(p.namespace, "default");
  assert.equal(p.options.replicas, 5);
});

// ---------------------------------------------------------------------------
// Filters (issue type)
// ---------------------------------------------------------------------------
test("filter: CrashLoopBackOff", () => {
  assertParse("show crashloopbackoff pods", {
    intent: "list", resource: "pod", filter: "CrashLoopBackOff",
  });
});

test("filter: typo 'crashlookerror'", () => {
  // The historical bug — must still be detected.
  assertParse("show me crashlookerror pod", {
    intent: "list", resource: "pod", filter: "CrashLoopBackOff",
  });
});

test("filter: ImagePullBackOff", () => {
  assertParse("any imagepullbackoff pods?", {
    resource: "pod", filter: "ImagePullBackOff",
  });
});

test("filter: OOMKilled", () => {
  assertParse("oomkilled pods in production", {
    resource: "pod", filter: "OOMKilled", namespace: "production",
  });
});

test("filter: 'pods with issues' defaults to pod resource + Failed filter", () => {
  const p = parse("pods with issues");
  assert.equal(p.resource, "pod");
  assert.equal(p.filter, "Failed");
});

// ---------------------------------------------------------------------------
// Resource recognition
// ---------------------------------------------------------------------------
test("resource: deployments", () => {
  assertParse("list deployments", { resource: "deployment" });
});

test("resource: services svc alias", () => {
  assertParse("list svc in default", { resource: "service", namespace: "default" });
});

test("resource: configmaps cm alias", () => {
  assertParse("show cm in kube-system", { resource: "configmap", namespace: "kube-system" });
});

test("resource: routes (openshift)", () => {
  assertParse("list routes in default", { resource: "route", namespace: "default" });
});

test("resource: nodes (cluster scoped, no namespace)", () => {
  const p = parse("list all nodes");
  assert.equal(p.resource, "node");
  assert.equal(p.namespace, null);
  // allNs is meaningless for cluster-scoped resources, don't assert it.
});

test("resource: namespaces", () => {
  assertParse("list all namespaces", { resource: "namespace", allNs: true });
});

test("resource: projects (openshift)", () => {
  assertParse("list projects", { resource: "project" });
});

test("resource: events all namespaces", () => {
  assertParse("show events in all namespaces", {
    resource: "event", allNs: true,
  });
});

test("resource: events specific namespace", () => {
  assertParse("show events in trident namespace", {
    resource: "event", namespace: "trident",
  });
});

// ---------------------------------------------------------------------------
// allNs / scope
// ---------------------------------------------------------------------------
test("allNs: 'pods in all namespaces'", () => {
  assertParse("show pods in all namespaces", {
    resource: "pod", allNs: true,
  });
});

test("scope: cluster health", () => {
  const p = parse("is the cluster healthy?");
  assert.equal(p.scope, "health");
});

// ---------------------------------------------------------------------------
// Conversation memory / pronoun resolution
// ---------------------------------------------------------------------------
test("memory: 'show its logs' resolves to last pod", () => {
  const p = parse("show its logs", { resource: "pod", name: "nginx-1", namespace: "default" });
  assert.equal(p.intent, "logs");
  assert.equal(p.resource, "pod");
  assert.equal(p.name, "nginx-1");
  assert.equal(p.namespace, "default");
});

test("memory: 'delete it' resolves to last pod", () => {
  const p = parse("delete it", { resource: "pod", name: "stuck-pod", namespace: "trident" });
  assert.equal(p.intent, "delete");
  assert.equal(p.name, "stuck-pod");
  assert.equal(p.namespace, "trident");
});

test("memory: 'now in production namespace' switches namespace", () => {
  const p = parse("same in production namespace", { resource: "pod", namespace: "default" });
  // The new 'production namespace' wins over memory.
  assert.equal(p.namespace, "production");
  assert.equal(p.resource, "pod");
});

// ---------------------------------------------------------------------------
// Help / unknown
// ---------------------------------------------------------------------------
test("help: bare 'help'", () => {
  assertParse("help", { intent: "help" });
});

test("unknown: empty message", () => {
  assertParse("", { intent: "unknown" });
});

test("unknown: 'hello'", () => {
  assertParse("hello", { intent: "unknown" });
});
