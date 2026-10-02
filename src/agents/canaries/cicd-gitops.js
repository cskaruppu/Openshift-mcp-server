/**
 * Canary cases for the App Deployment Agent.
 *
 * What these are protecting: this agent tells a customer their manifests are
 * hardened and compliant. If that stops being true — a default flipped, a
 * control dropped out of a profile, a scanner grading unknown as clean — nothing
 * else in the system notices, because none of it is an error.
 *
 * Every case here is `pure`: a function over a fixture, no cluster, no network,
 * no model. They can run on any schedule, on any replica, at no cost.
 */

import { generateManifests } from "../../services/manifest-generator.js";
import { cisCheckManifests, scanManifestImages } from "../../services/manifest-scan.js";
import { remediateManifests } from "../../services/manifest-remediate.js";

const AIS = () => ({
  appName: "canary", namespace: "canary", targetPlatform: "openshift",
  tiers: [
    { name: "web", role: "frontend", image: "registry.redhat.io/ubi9/nginx-124@sha256:aaa",
      port: 8080, expose: true, replicas: { min: 1, max: 1 }, resources: {}, envVars: [] },
    { name: "db", role: "database", image: "quay.io/sclorg/postgresql-16-c9s@sha256:ccc",
      port: 5432, replicas: { min: 1, max: 1 }, resources: {}, envVars: [] },
  ],
  networkPolicies: [{ from: "web", to: "db", port: 5432, protocol: "TCP", allowed: true }],
  deployOrder: ["db", "web"],
});

const WEAK = () => ([
  { apiVersion: "v1", kind: "Namespace", metadata: { name: "weak" } },
  { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "app", namespace: "weak" },
    spec: { template: { spec: { hostNetwork: true, containers: [{
      name: "app", image: "nginx:latest",
      env: [{ name: "DB_PASSWORD", value: "plaintext" }],
      securityContext: { privileged: true },
    }] } } } },
]);

export default [
  {
    id: "generates-hardened-manifests",
    kind: "pure",
    title: "What it generates passes the gate it ships",
    why: "The agent's banner promises security-hardened manifests. If its own output stops scoring A against its own CIS check, the promise is false and no test, error rate or governance check would say so.",
    run: async () => {
      const g = generateManifests(AIS());
      const objs = g.manifests.map((m) => m.json);
      const r = cisCheckManifests(objs);
      return {
        grade: r.summary.grade, failed: r.summary.failed, pass: r.verdict.pass,
        failing: r.controls.filter((c) => c.status === "FAIL").map((c) => c.id),
        __evidence: { read: objs.length, expected: objs.length, confidence: "high", concluded: true },
      };
    },
    expect: [
      { path: "grade", assert: "equals", value: "A", note: "Anything below A means a hardening default regressed." },
      { path: "failed", assert: "equals", value: 0 },
      { path: "pass", assert: "equals", value: true },
    ],
  },

  {
    id: "every-pod-has-a-service-account",
    kind: "pure",
    title: "No generated workload runs as the default ServiceAccount",
    why: "The default ServiceAccount is shared by everything in a namespace, so any RoleBinding on it leaks to every workload. This is the single control most likely to be quietly dropped by a refactor of the generator.",
    run: async () => {
      const g = generateManifests(AIS());
      const sas = g.manifests
        .filter((m) => ["Deployment", "Job", "StatefulSet"].includes(m.kind))
        .map((m) => m.json.spec.template.spec.serviceAccountName || "default");
      return { serviceAccounts: sas, defaults: sas.filter((s) => s === "default").length };
    },
    expect: [
      { path: "defaults", assert: "equals", value: 0 },
      { path: "serviceAccounts", assert: "excludes", value: "default" },
    ],
  },

  {
    id: "remediation-closes-what-it-claims",
    kind: "pure",
    title: "One-click remediation really does take F to A",
    why: "The console shows 'grade F → A' before the user applies the patch. If remediation stops closing a control, that label becomes a lie the user acts on.",
    run: async () => {
      const before = cisCheckManifests(WEAK());
      const r = remediateManifests(WEAK());
      const after = cisCheckManifests(r.manifests);
      const second = remediateManifests(r.manifests);
      return {
        beforeGrade: before.summary.grade,
        afterGrade: after.summary.grade,
        afterFailed: after.summary.failed,
        idempotentFixes: second.counts.fixes,
        riskyLabelled: r.fixes.filter((f) => f.risk === "verify").length,
      };
    },
    expect: [
      { path: "beforeGrade", assert: "equals", value: "F" },
      { path: "afterGrade", assert: "equals", value: "A" },
      { path: "afterFailed", assert: "equals", value: 0 },
      { path: "idempotentFixes", assert: "equals", value: 0, note: "Re-running remediation on a remediated set must change nothing." },
      { path: "riskyLabelled", assert: "atLeast", value: 1, note: "Fixes that can stop a workload must stay labelled 'verify'. Silently marking them safe is how a gate starts breaking production." },
    ],
  },

  {
    id: "unscanned-images-are-not-clean",
    kind: "pure",
    title: "An image nothing scanned grades unknown, never A",
    why: "Grading an unscanned image A reads as 'no vulnerabilities' when it means 'nobody looked'. This is the most dangerous possible regression in the image panel and it would look like an improvement on a dashboard.",
    run: async () => {
      const m = [{ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "x", namespace: "n" },
        spec: { template: { spec: { containers: [{ name: "c", image: "registry.redhat.io/ubi9/nginx@sha256:abc" }] } } } }];
      const r = await scanManifestImages(m, { enrich: false });
      return { status: r.vulnerability.status, grade: r.vulnerability.grade, scanned: r.vulnerability.scanned };
    },
    expect: [
      { path: "status", assert: "equals", value: "unscanned" },
      { path: "grade", assert: "equals", value: "—", note: "A letter grade here would be a claim nobody made." },
      { path: "scanned", assert: "equals", value: 0 },
    ],
  },

  {
    id: "narrow-profile-does-not-inflate-the-score",
    kind: "pure",
    title: "Controls outside the chosen profile are not counted as passed",
    why: "If excluded controls ever fold into the passes, choosing a narrower standard would raise the grade — and every customer would choose the narrowest one.",
    run: async () => {
      const weak = WEAK();
      const narrow = cisCheckManifests(weak, { profile: "pss-baseline" });
      return {
        scored: narrow.summary.total,
        notEvaluated: narrow.summary.notEvaluated,
        sums: narrow.summary.passed + narrow.summary.failed === narrow.summary.total,
        naMarked: narrow.controls.filter((c) => c.status === "N/A").length,
      };
    },
    expect: [
      { path: "sums", assert: "equals", value: true, note: "passed + failed must equal the scored total, with N/A outside both." },
      { path: "notEvaluated", assert: "atLeast", value: 1 },
      { path: "naMarked", assert: "atLeast", value: 1 },
    ],
  },
];
