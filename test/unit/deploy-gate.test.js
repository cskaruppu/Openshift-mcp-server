/**
 * The App Deployment Agent's pre-deploy gate, end to end as code:
 *
 *   1. the generator's own output must score A against the gate it ships
 *   2. a profile narrows the controls, and what it excludes is NOT counted as passed
 *   3. image hygiene and vulnerability are two scores, and "unscanned" is not "clean"
 *   4. remediation closes what it claims to close, is idempotent, and never
 *      mutates its input
 *   5. the evidence record is tamper-evident, and notices a YAML edit made after
 *      the gate ran
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateManifests } from "../../src/services/manifest-generator.js";
import { cisCheckManifests, scanManifestImages, imageHygiene } from "../../src/services/manifest-scan.js";
import { remediateManifests, unifiedDiff } from "../../src/services/manifest-remediate.js";
import { resolveProfile, listProfiles, gateVerdict } from "../../src/services/policy-profiles.js";
import { buildGateRecord, verifyGateRecord, gateCoversManifests, manifestDigest } from "../../src/services/gate-record.js";

const ais = () => ({
  appName: "shop", namespace: "shop", targetPlatform: "openshift",
  sharedSecrets: [{ name: "db-cred", keys: ["username", "password", "database"], autoGenerate: true, usedBy: ["db"] }],
  tiers: [
    { name: "web", role: "frontend", image: "registry.redhat.io/ubi9/nginx-124@sha256:aaa", port: 8080, expose: true,
      replicas: { min: 2, max: 4 }, resources: {}, envVars: [], probes: { readiness: { type: "http", path: "/", port: 8080 } } },
    { name: "db", role: "database", image: "quay.io/sclorg/postgresql-16-c9s@sha256:ccc", port: 5432,
      replicas: { min: 1, max: 1 }, resources: {}, envVars: [], initSql: "CREATE TABLE t(i int);",
      storage: { size: "20Gi", mountPath: "/var/lib/pgsql/data", storageClass: "thin", accessMode: "ReadWriteOnce" } },
  ],
  networkPolicies: [{ from: "web", to: "db", port: 5432, protocol: "TCP", allowed: true }],
  deployOrder: ["db", "web"],
});

// ── 1. Secure by default ──────────────────────────────────────────────────

test("the generator's own output scores A against the gate the agent ships", () => {
  const g = generateManifests(ais());
  const r = cisCheckManifests(g.manifests.map((m) => m.json));
  assert.equal(r.summary.grade, "A", `failing: ${r.controls.filter((c) => c.status === "FAIL").map((c) => c.id).join(", ")}`);
  assert.equal(r.summary.failed, 0);
  assert.equal(r.verdict.pass, true);
});

test("every pod spec is hardened, including the init Job", () => {
  const g = generateManifests(ais());
  const pods = g.manifests
    .filter((m) => ["Deployment", "Job"].includes(m.kind))
    .map((m) => ({ name: `${m.kind}/${m.name}`, ps: m.json.spec.template.spec }));
  assert.ok(pods.some((p) => p.name === "Job/db-init"), "the init Job must be in the set");
  for (const { name, ps } of pods) {
    assert.equal(ps.securityContext.runAsNonRoot, true, name);
    assert.equal(ps.securityContext.seccompProfile.type, "RuntimeDefault", name);
    assert.notEqual(ps.serviceAccountName, "default", name);
    assert.equal(ps.automountServiceAccountToken, false, name);
    for (const c of ps.containers) {
      assert.equal(c.securityContext.allowPrivilegeEscalation, false, `${name}:${c.name}`);
      assert.deepEqual(c.securityContext.capabilities.drop, ["ALL"], `${name}:${c.name}`);
      assert.ok(c.resources.limits.cpu && c.resources.limits.memory, `${name}:${c.name} must carry limits`);
    }
  }
});

test("a dedicated ServiceAccount exists for every tier that uses one", () => {
  const g = generateManifests(ais());
  const sas = new Set(g.manifests.filter((m) => m.kind === "ServiceAccount").map((m) => m.name));
  for (const m of g.manifests.filter((x) => ["Deployment", "Job"].includes(x.kind))) {
    assert.ok(sas.has(m.json.spec.template.spec.serviceAccountName), `no ServiceAccount for ${m.kind}/${m.name}`);
  }
});

test("a document asking for root is obeyed, and the opt-out is reported", () => {
  const a = ais();
  a.tiers[0].security = { runAsNonRoot: false };
  const g = generateManifests(a);
  const web = g.manifests.find((m) => m.kind === "Deployment" && m.name === "web");
  assert.equal(web.json.spec.template.spec.securityContext?.runAsNonRoot, undefined);
  assert.match(g.securityApplied[0], /except web, where the document asked for root/);
});

test("resource limits the document did not state are reported as assumptions", () => {
  const g = generateManifests(ais());
  assert.ok(g.assumptions.length > 0, "silent invented limits are the thing this prevents");
  for (const a of g.assumptions) assert.match(a, /was used so the pod satisfies CIS-5\.2\.4/);
});

test("readOnlyRootFilesystem is not defaulted on, and is honoured when asked for", () => {
  const off = generateManifests(ais());
  const webOff = off.manifests.find((m) => m.kind === "Deployment" && m.name === "web");
  assert.equal(webOff.json.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem, undefined);
  const a = ais();
  a.tiers[0].security = { readOnlyRootFs: true };
  const on = generateManifests(a);
  const webOn = on.manifests.find((m) => m.kind === "Deployment" && m.name === "web");
  assert.equal(webOn.json.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
});

// ── 2. Policy profiles ────────────────────────────────────────────────────

test("every profile names a standard and a version", () => {
  for (const p of listProfiles()) {
    assert.ok(p.name && p.version && p.standard, `${p.id} must say what it is`);
    assert.ok(p.controlCount > 0);
  }
});

test("a narrower profile marks the controls it excludes N/A, and does not count them as passed", () => {
  const weak = [{ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "x", namespace: "n" },
    spec: { template: { spec: { containers: [{ name: "c", image: "nginx:latest" }] } } } }];
  const all = cisCheckManifests(weak, { profile: "cis-1.9" });
  const narrow = cisCheckManifests(weak, { profile: "pss-baseline" });
  assert.equal(all.summary.total, 10);
  assert.equal(narrow.summary.total, 3);
  assert.equal(narrow.summary.notEvaluated, 7);
  const na = narrow.controls.filter((c) => c.status === "N/A");
  assert.equal(na.length, 7);
  for (const c of na) assert.match(c.note, /Not evaluated/);
  // The excluded controls must not be counted as passes anywhere.
  assert.ok(narrow.summary.passed + narrow.summary.failed === narrow.summary.total);
});

test("a profile can raise a control's severity without changing the reading", () => {
  const weak = [{ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "x", namespace: "n" },
    spec: { template: { spec: { containers: [{ name: "c", image: "nginx:latest" }] } } } }];
  const cis = cisCheckManifests(weak, { profile: "cis-1.9" }).controls.find((c) => c.id === "CIS-5.2.5");
  const pss = cisCheckManifests(weak, { profile: "pss-restricted" }).controls.find((c) => c.id === "CIS-5.2.5");
  assert.equal(cis.severity, "warning");
  assert.equal(pss.severity, "critical");
  assert.equal(cis.status, pss.status); // same reading
});

test("the fail threshold decides whether the gate blocks", () => {
  const controls = [{ id: "A", status: "FAIL", severity: "warning" }];
  const p = resolveProfile("cis-1.9");
  assert.equal(gateVerdict(controls, p, "any").pass, false);
  assert.equal(gateVerdict(controls, p, "warning").pass, false);
  assert.equal(gateVerdict(controls, p, "critical").pass, true);
  assert.equal(gateVerdict(controls, p, "none").pass, true);
  assert.match(gateVerdict(controls, p, "critical").reason, /reports but does not block/);
});

test("an unknown profile id falls back to the default rather than scoring nothing", () => {
  assert.equal(resolveProfile("nope").id, resolveProfile(null).id);
});

test("a manifest set with no workload is not a pass", () => {
  const r = cisCheckManifests([{ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c" } }]);
  assert.equal(r.applicable, false);
  assert.equal(r.verdict.pass, false);
  assert.match(r.verdict.reason, /not a pass/);
});

// ── 3. Hygiene and vulnerability are two scores ───────────────────────────

test("unscanned images grade as unknown, never as clean", async () => {
  const m = [{ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "x", namespace: "n" },
    spec: { template: { spec: { containers: [{ name: "c", image: "registry.redhat.io/ubi9/nginx@sha256:abc" }] } } } }];
  const r = await scanManifestImages(m, { enrich: false });
  assert.equal(r.hygiene.grade, "A", "a digest-pinned image on a trusted registry carries nothing above advisory");
  assert.equal(r.hygiene.noDefects, 1);
  assert.equal(r.vulnerability.status, "unscanned");
  assert.equal(r.vulnerability.grade, "—");
  assert.match(r.vulnerability.basis, /unknown, not clean/);
});

test("a clean-reference application does not lose points for having many images", async () => {
  const mk = (i) => ({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: `t${i}`, namespace: "n" },
    spec: { template: { spec: { containers: [{ name: "c", image: `registry.redhat.io/ubi9/app${i}:1.0` }] } } } });
  const three = await scanManifestImages([mk(1), mk(2), mk(3)], { enrich: false });
  const twelve = await scanManifestImages(Array.from({ length: 12 }, (_, i) => mk(i)), { enrich: false });
  assert.equal(three.hygiene.grade, twelve.hygiene.grade,
    "the old mixed score graded a 12-image app worse than a 3-image app with identical references");
});

test("hygiene findings are never added into the CVE buckets", async () => {
  const m = [{ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "x", namespace: "n" },
    spec: { template: { spec: { containers: [{ name: "c", image: "nginx:latest" }] } } } }];
  const r = await scanManifestImages(m, { enrich: false });
  assert.ok(r.hygiene.findings > 0, "nginx:latest has reference findings");
  assert.equal(r.vulnerability.critical, 0);
  assert.equal(r.vulnerability.high, 0);
  assert.equal(r.images[0].scanned, false);
});

test("imageHygiene still flags an unpinned tag and clears a pinned digest", () => {
  assert.ok(imageHygiene("nginx:latest").findings.some((f) => f.id === "IMG-001"));
  assert.ok(!imageHygiene("registry.redhat.io/ubi9/nginx@sha256:abcdef").findings.some((f) => ["IMG-001", "IMG-002"].includes(f.id)));
});

// ── 4. Remediation ────────────────────────────────────────────────────────

const weakSet = () => ([
  { apiVersion: "v1", kind: "Namespace", metadata: { name: "legacy" } },
  { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "portal", namespace: "legacy" },
    spec: { template: { spec: { hostNetwork: true, containers: [{
      name: "portal", image: "nginx:latest", ports: [{ containerPort: 8080 }],
      env: [{ name: "DB_PASSWORD", value: "hunter2" }, { name: "LOG_LEVEL", value: "info" }],
      securityContext: { privileged: true },
    }] } } } },
]);

test("remediation closes what it claims to close", () => {
  const before = cisCheckManifests(weakSet());
  assert.equal(before.summary.grade, "F");
  const r = remediateManifests(weakSet());
  const after = cisCheckManifests(r.manifests);
  assert.equal(after.summary.grade, "A", `still failing: ${after.controls.filter((c) => c.status === "FAIL").map((c) => c.id).join(", ")}`);
  assert.equal(after.verdict.pass, true);
});

test("remediation never mutates its input", () => {
  const input = weakSet();
  remediateManifests(input);
  assert.equal(input[1].spec.template.spec.containers[0].securityContext.privileged, true);
  assert.equal(input[1].spec.template.spec.hostNetwork, true);
  assert.equal(input.length, 2);
});

test("remediation is idempotent — a second run changes nothing", () => {
  const r1 = remediateManifests(weakSet());
  const r2 = remediateManifests(r1.manifests);
  assert.equal(r2.counts.fixes, 0);
  assert.equal(r2.patched, false);
});

test("every fix is attributed to a control and declares its risk", () => {
  const r = remediateManifests(weakSet());
  assert.ok(r.fixes.length > 0);
  for (const f of r.fixes) {
    assert.match(f.control, /^CIS-/);
    assert.ok(["safe", "verify"].includes(f.risk), `${f.control} must declare a risk`);
    assert.ok(f.why && f.why.length > 30, `${f.control} must say why, not just what`);
    assert.ok(f.target);
  }
});

test("the risky fixes are labelled risky, not slipped in as safe", () => {
  const r = remediateManifests(weakSet());
  const byControl = Object.fromEntries(r.fixes.map((f) => [f.control, f]));
  // Inventing resource limits and forcing a root image to non-root can both
  // stop the workload running. Neither may ever be presented as safe.
  assert.equal(byControl["CIS-5.2.4"].risk, "verify");
  assert.equal(byControl["CIS-5.2.6"].risk, "verify");
  assert.match(byControl["CIS-5.2.4"].why, /NOT measured/);
});

test("dropping capabilities on a low-port container warns about NET_BIND_SERVICE", () => {
  const set = weakSet();
  set[1].spec.template.spec.containers[0].ports = [{ containerPort: 80 }];
  const r = remediateManifests(set);
  const f = r.fixes.find((x) => x.control === "CIS-5.2.8");
  assert.equal(f.risk, "verify");
  assert.match(f.why, /NET_BIND_SERVICE/);
});

test("a plaintext credential is moved into a Secret, and the file-not-vault caveat is stated", () => {
  const r = remediateManifests(weakSet());
  const dep = r.manifests.find((m) => m.kind === "Deployment");
  const env = dep.spec.template.spec.containers[0].env.find((e) => e.name === "DB_PASSWORD");
  assert.equal(env.value, undefined);
  assert.equal(env.valueFrom.secretKeyRef.name, "portal-env");
  const sec = r.manifests.find((m) => m.kind === "Secret" && m.metadata.name === "portal-env");
  assert.equal(Buffer.from(sec.data.DB_PASSWORD, "base64").toString(), "hunter2");
  assert.match(r.fixes.find((f) => f.control === "CIS-5.4.1").why, /encoding and not encryption/);
});

test("the default-deny NetworkPolicy it adds is accompanied by what it cannot derive", () => {
  const r = remediateManifests(weakSet());
  assert.ok(r.manifests.some((m) => m.kind === "NetworkPolicy"));
  const u = r.unfixable.find((x) => x.control === "CIS-5.3.2");
  assert.ok(u, "adding deny-all without saying the allows are missing would break the app silently");
  assert.match(u.why, /decision, not a reading/);
});

test("a profile that excludes a control means remediation does not touch it", () => {
  const r = remediateManifests(weakSet(), { profile: "pss-baseline" });
  // baseline covers 5.2.1 / 5.2.5 / 5.2.7 only.
  assert.deepEqual([...new Set(r.fixes.map((f) => f.control))].sort(), ["CIS-5.2.1", "CIS-5.2.5", "CIS-5.2.7"]);
  const dep = r.manifests.find((m) => m.kind === "Deployment");
  assert.equal(dep.spec.template.spec.serviceAccountName, undefined, "5.1.6 is outside baseline");
  assert.equal(dep.spec.template.spec.containers[0].resources, undefined, "5.2.4 is outside baseline");
});

test("the diff is a real unified diff of the change", () => {
  const r = remediateManifests(weakSet());
  assert.match(r.diff, /^--- generated\.yaml\n\+\+\+ remediated\.yaml\n@@ /);
  assert.ok(r.diff.includes("-      hostNetwork: true"));
  assert.ok(r.diff.includes("+        runAsNonRoot: true"));
});

test("unifiedDiff returns nothing when nothing changed", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n"), "");
});

// ── 5. The evidence record ────────────────────────────────────────────────

test("the manifest digest ignores key order and document order", () => {
  const a = [{ kind: "Service", metadata: { name: "s" }, spec: { x: 1, y: 2 } }, { kind: "Deployment", metadata: { name: "d" } }];
  const b = [{ kind: "Deployment", metadata: { name: "d" } }, { metadata: { name: "s" }, spec: { y: 2, x: 1 }, kind: "Service" }];
  assert.equal(manifestDigest(a).value, manifestDigest(b).value);
});

test("the record carries the standard, the version and every control", () => {
  const g = generateManifests(ais());
  const objs = g.manifests.map((m) => m.json);
  const cis = cisCheckManifests(objs, { profile: "pss-restricted" });
  const rec = buildGateRecord({ manifests: objs, cis, user: "u", cluster: "c", namespace: "shop" });
  assert.equal(rec.policy.id, "pss-restricted");
  assert.ok(rec.policy.version);
  assert.equal(rec.compliance.controls.length, cis.controls.length);
  assert.equal(rec.compliance.threshold, cis.verdict.threshold);
});

test("the record says which checks were not run instead of leaving them blank", () => {
  const rec = buildGateRecord({ manifests: [{ kind: "ConfigMap", metadata: { name: "c" } }] });
  assert.ok(rec.checksNotRun.includes("policy compliance"));
  assert.ok(rec.checksNotRun.includes("image hygiene and vulnerability"));
});

test("an unsigned record says it is unsigned rather than claiming a signature", () => {
  const before = process.env.GATE_SIGNING_KEY;
  delete process.env.GATE_SIGNING_KEY;
  try {
    const rec = buildGateRecord({ manifests: [{ kind: "ConfigMap", metadata: { name: "c" } }] });
    assert.equal(rec.signature.signed, false);
    assert.equal(rec.signature.algorithm, "sha256");
    assert.match(rec.signature.note, /not a signature/);
  } finally { if (before !== undefined) process.env.GATE_SIGNING_KEY = before; }
});

test("a signed record is tamper-evident", () => {
  const before = process.env.GATE_SIGNING_KEY;
  process.env.GATE_SIGNING_KEY = "unit-test-key";
  try {
    const rec = buildGateRecord({ manifests: [{ kind: "ConfigMap", metadata: { name: "c" } }] });
    assert.equal(rec.signature.signed, true);
    assert.equal(verifyGateRecord(rec).valid, true);
    const forged = { ...rec, compliance: { grade: "A", pass: true } };
    assert.equal(verifyGateRecord(forged).valid, false);
  } finally {
    if (before === undefined) delete process.env.GATE_SIGNING_KEY; else process.env.GATE_SIGNING_KEY = before;
  }
});

test("a YAML edit made after the gate ran is noticed, not waved through", () => {
  const g = generateManifests(ais());
  const objs = g.manifests.map((m) => m.json);
  const rec = buildGateRecord({ manifests: objs, cis: cisCheckManifests(objs) });
  assert.equal(gateCoversManifests(rec, objs).covered, true);

  const edited = JSON.parse(JSON.stringify(objs));
  const dep = edited.find((m) => m.kind === "Deployment");
  dep.spec.template.spec.containers[0].securityContext.privileged = true;
  const cov = gateCoversManifests(rec, edited);
  assert.equal(cov.covered, false);
  assert.equal(cov.reason, "digest-mismatch");
  assert.match(cov.message, /EDITED after the gate ran/);
});

test("an added or removed object is named, not just counted", () => {
  const objs = [{ kind: "Deployment", metadata: { name: "d", namespace: "n" } }];
  const rec = buildGateRecord({ manifests: objs });
  const cov = gateCoversManifests(rec, [...objs, { kind: "Secret", metadata: { name: "oops", namespace: "n" } }]);
  assert.equal(cov.covered, false);
  assert.ok(cov.added.some((o) => o.includes("oops")));
});

test("deploying with no gate record at all is recorded as unchecked", () => {
  const cov = gateCoversManifests(null, [{ kind: "Deployment", metadata: { name: "d" } }]);
  assert.equal(cov.covered, false);
  assert.equal(cov.reason, "no-gate-record");
  assert.match(cov.message, /Nothing verified these manifests/);
});
