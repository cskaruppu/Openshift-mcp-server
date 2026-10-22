/**
 * Vulnerability remediation workflow, end to end, against fakes of the
 * cluster, GitLab / GitHub, the registry and the gate scanner.
 * Run with: node --test test/unit/remediation-workflow.test.js
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert";

process.env.REMEDIATION_GIT_HOSTS = JSON.stringify([{ host: "gitlab.tcs.local", provider: "gitlab" }]);
process.env.GITLAB_TOKEN = "glpat-test";
process.env.GITHUB_TOKEN = "ghp-test";

const W = await import("../../src/services/remediation/workflow.js");
const T = await import("../../src/services/remediation/triage.js");
const { evaluateGate, summarizeTrivy, gateJobSpec } = await import("../../src/services/remediation/gate.js");
const kev = await import("../../src/services/kev-feed.js");

kev._setKevCatalogForTest({ vulnerabilities: [{ cveID: "CVE-2021-44228", dueDate: "2021-12-24", knownRansomwareCampaignUse: "Known" }] });

const OLD = "quay.io/tcs/payments-api:3.14.2";
const NEW = "quay.io/tcs/payments-api:3.14.3";
const SCAN = {
  image: OLD, source: "trivy", critical: 1, high: 1, medium: 0, low: 0, priority: { tier: "fix-now", score: 95 },
  vulnerabilities: [
    { id: "CVE-2021-44228", severity: "critical", cvss: 10, kev: true, package: "org.apache.logging.log4j:log4j-core", version: "2.14.1", fixedBy: "2.15.0", pkgClass: "lang-pkgs", pkgType: "jar" },
    { id: "CVE-2023-4911", severity: "high", cvss: 7.8, package: "libc6", version: "2.36-9", fixedBy: "2.36-9+deb12u3", pkgClass: "os-pkgs", pkgType: "debian" },
    { id: "CVE-2023-45853", severity: "critical", cvss: 9.8, package: "zlib1g", version: "1.2.13", fixedBy: null, pkgClass: "os-pkgs", pkgType: "debian" },
  ],
};

/* ── fakes ── */
let cluster, patches, gateResult, mr, files, mrBodies;
function fakeOcp() {
  return {
    fetch: async (path) => {
      if (path === "/apis/apps/v1/namespaces/payments/deployments") return { items: [cluster.deployment] };
      if (path.startsWith("/apis/apps/v1/namespaces/payments/statefulsets") || path.startsWith("/apis/apps/v1/namespaces/payments/daemonsets")) return { items: [] };
      if (path === "/api/v1/namespaces/payments") return { metadata: { labels: { "tcs.com/owner": "payments-team" }, annotations: {} } };
      if (path === "/apis/apps/v1/namespaces/payments/deployments/payments-api") return cluster.deployment;
      throw new Error(`unexpected GET ${path}`);
    },
    patch: async (path, body) => { patches.push({ path, body }); cluster.deployment.spec.template.spec.containers[0].image = body.spec.template.spec.containers[0].image; },
  };
}
const deployment = (annotations) => ({
  metadata: { name: "payments-api", generation: 2, annotations, labels: {} },
  spec: { replicas: 2, template: { spec: { containers: [{ name: "api", image: OLD }] } } },
  status: { observedGeneration: 2, updatedReplicas: 2, availableReplicas: 2, replicas: 2, conditions: [] },
});

const b64 = (s) => Buffer.from(s).toString("base64");
const YAML = `apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n      - name: api\n        image: ${OLD}\n`;
function fakeFetch() {
  return async (url, opts = {}) => {
    const u = String(url);
    const reply = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (body == null ? "" : JSON.stringify(body)), json: async () => body });
    if (u.startsWith("https://quay.io/v2/")) return reply(u.includes("does-not-exist") ? 404 : 200, null, { "docker-content-digest": "sha256:abc" });
    if (u.startsWith("https://gitlab.tcs.local/api/v4/projects/retail%2Fgitops")) {
      const rest = u.replace("https://gitlab.tcs.local/api/v4/projects/retail%2Fgitops", "");
      if (rest === "") return reply(200, { default_branch: "main" });
      if (rest.startsWith("/repository/tree")) return reply(200, rest.includes("page=1") ? [{ type: "blob", path: "apps/payments/deployment.yaml" }, { type: "blob", path: "apps/payments/README.md" }] : []);
      if (rest.startsWith("/repository/files/")) return reply(200, { content: b64(files["apps/payments/deployment.yaml"]), blob_id: "b1" });
      if (rest === "/repository/commits" && opts.method === "POST") { const b = JSON.parse(opts.body); for (const a of b.actions) files[`branch:${a.file_path}`] = a.content; return reply(201, { id: "c1" }); }
      if (rest === "/merge_requests" && opts.method === "POST") { mrBodies.push(JSON.parse(opts.body)); return reply(201, { iid: 42 + mrBodies.length - 1, web_url: `https://gitlab.tcs.local/retail/gitops/-/merge_requests/${42 + mrBodies.length - 1}` }); }
      if (rest.startsWith("/merge_requests/42")) return reply(200, { state: mr.state, merge_commit_sha: mr.state === "merged" ? "m1" : null, head_pipeline: { status: mr.pipeline }, web_url: "https://gitlab.tcs.local/retail/gitops/-/merge_requests/42" });
    }
    throw new Error(`unexpected fetch ${opts.method || "GET"} ${u}`);
  };
}

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

beforeEach(() => {
  W._reset();
  patches = []; mrBodies = []; files = { "apps/payments/deployment.yaml": YAML };
  mr = { state: "opened", pipeline: "running" };
  gateResult = { done: true, ok: true, report: { critical: 0, high: 0, medium: 2, total: 2, vulns: [{ id: "CVE-2023-45853", severity: "critical", package: "zlib1g" }].filter(() => false) } };
  global.fetch = fakeFetch();
  W.configure({
    runForCluster: (_c, fn) => fn(), snow: { enabled: () => false }, ocp: fakeOcp(),
    gate: { start: async () => ({ job: "tcs-gate-x", namespace: "openshift-mcp", startedAt: new Date().toISOString() }), poll: async () => gateResult },
    scanNamespace: async () => ({ source: "trivy", critical: 0, high: 0, medium: 1, low: 0, vulnerabilities: [{ id: "CVE-2023-45853" }] }),
    audit: () => {},
  });
});

describe("triage", () => {
  test("each CVE is classified by the change that fixes it", () => {
    const plan = T.triageImage({ vulnerabilities: SCAN.vulnerabilities, firstParty: true, firstSeen: "2026-10-01T00:00:00Z" });
    const by = Object.fromEntries(plan.items.map((i) => [i.id, i]));
    assert.equal(by["CVE-2021-44228"].fixType, "dependency");
    assert.equal(by["CVE-2021-44228"].ecosystem, "maven");
    assert.equal(by["CVE-2023-4911"].fixType, "base-image");
    assert.equal(by["CVE-2023-45853"].fixType, "no-fix");
  });
  test("a vendor image is fixed by the vendor's next tag, whatever the package", () => {
    const plan = T.triageImage({ vulnerabilities: SCAN.vulnerabilities, firstParty: false });
    assert.deepEqual([...new Set(plan.items.map((i) => i.fixType))].sort(), ["no-fix", "vendor-tag"]);
  });
  test("KEV CVEs are due in 14 days from discovery (CISA's past date kept for reference); others follow the severity policy", () => {
    const plan = T.triageImage({ vulnerabilities: SCAN.vulnerabilities, firstParty: true, firstSeen: "2026-10-01T00:00:00Z" });
    const by = Object.fromEntries(plan.items.map((i) => [i.id, i]));
    assert.equal(by["CVE-2021-44228"].due, "2026-10-15");
    assert.equal(by["CVE-2021-44228"].cisaDue, "2021-12-24");
    assert.equal(by["CVE-2021-44228"].ransomware, true);
    assert.equal(by["CVE-2023-4911"].due, "2026-10-31");
  });
  test("a CISA due date that is sooner and still ahead wins", () => {
    kev._setKevCatalogForTest({ vulnerabilities: [{ cveID: "CVE-2026-1000", dueDate: "2026-10-08" }, { cveID: "CVE-2021-44228", dueDate: "2021-12-24", knownRansomwareCampaignUse: "Known" }] });
    const d = T.dueDateFor({ id: "CVE-2026-1000", kev: true, severity: "high" }, { firstSeen: "2026-10-01T00:00:00Z" });
    assert.equal(d.due, "2026-10-08");
    assert.equal(d.basis, "CISA KEV due date");
  });
  test("Go stdlib is a toolchain rebuild, not a module bump", () => {
    assert.equal(T.classifyVuln({ package: "stdlib", fixedBy: "1.21.11", pkgClass: "lang-pkgs", pkgType: "gobinary" }, { firstParty: true }).type, "toolchain");
  });
  test("owner comes from labels, and says when it is only a guess", () => {
    assert.equal(T.resolveOwner({ namespace: "p", nsMeta: { labels: { "tcs.com/owner": "pay" } } }).team, "pay");
    assert.equal(T.resolveOwner({ namespace: "p" }).source, "namespace (no owner label)");
  });
});

describe("gate policy", () => {
  const targets = [{ id: "CVE-1", fixed: "2" }, { id: "CVE-2", fixed: null }];
  const rep = (vulns, c = 0, h = 0) => ({ critical: c, high: h, medium: 0, vulns });
  test("passes when the fixed CVEs are gone and nothing got worse", () => {
    const e = evaluateGate(rep([{ id: "CVE-2" }]), { targetCves: targets, current: { critical: 1, high: 2 }, kev: new Set() });
    assert.equal(e.pass, true);
    assert.deepEqual(e.fixed, ["CVE-1"]);
  });
  test("fails if a CVE it should fix is still there, if a KEV CVE is present, or Criticals went up", () => {
    assert.equal(evaluateGate(rep([{ id: "CVE-1" }]), { targetCves: targets, current: { critical: 1 }, kev: new Set() }).pass, false);
    assert.equal(evaluateGate(rep([{ id: "CVE-9" }]), { targetCves: targets, current: { critical: 1 }, kev: new Set(["CVE-9"]) }).pass, false);
    assert.equal(evaluateGate(rep([], 3), { targetCves: targets, current: { critical: 1 }, kev: new Set() }).pass, false);
  });
  test("more Highs is a warning for the reviewer, not a block", () => {
    const e = evaluateGate(rep([], 0, 5), { targetCves: targets, current: { critical: 1, high: 2 }, kev: new Set() });
    assert.equal(e.pass, true);
    assert.equal(e.warnings.length, 1);
  });
  test("the gate Job is unprivileged, bounded and cleans up after itself", () => {
    const j = gateJobSpec("tcs-gate-1", NEW);
    const c = j.spec.template.spec.containers[0];
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    assert.equal(c.securityContext.runAsNonRoot, true);
    assert.equal(j.spec.template.spec.automountServiceAccountToken, false);
    assert.ok(j.spec.activeDeadlineSeconds > 0 && j.spec.ttlSecondsAfterFinished > 0);
    assert.equal(c.args.at(-1), NEW);
  });
  test("reads Trivy JSON", () => {
    const s = summarizeTrivy({ ArtifactName: NEW, Results: [{ Vulnerabilities: [{ VulnerabilityID: "CVE-1", Severity: "CRITICAL", PkgName: "x" }, { VulnerabilityID: "CVE-1", Severity: "CRITICAL", PkgName: "x" }] }] });
    assert.equal(s.critical, 1);
  });
});

describe("GitOps path on GitLab, in-app four-eyes approval", () => {
  test("triage → plan → gate → MR → approval → merge → rollout → verified", async () => {
    cluster = { deployment: deployment({ "tcs.com/gitops-repo": "https://gitlab.tcs.local/retail/gitops.git", "tcs.com/gitops-path": "apps/payments" }) };
    let rec = await W.create({ namespace: "payments", image: OLD, scan: SCAN, actor: "alice" });
    assert.equal(rec.state, "triaged");
    assert.equal(rec.owner.team, "payments-team");
    assert.equal(rec.workload.container, "api");
    assert.equal(rec.repos.gitops.provider, "gitlab");
    assert.equal(rec.due, rec.plan.items.find((i) => i.id === "CVE-2021-44228").due, "earliest due date is the KEV one");

    // the same image is not opened twice
    assert.equal((await W.create({ namespace: "payments", image: OLD, scan: SCAN, actor: "bob" })).id, rec.id);

    await assert.rejects(W.setTarget(rec.id, { image: "quay.io/tcs/payments-api:does-not-exist" }, "alice"), /not found/);
    rec = await W.setTarget(rec.id, { image: NEW }, "alice");
    assert.equal(rec.state, "planned");
    await assert.rejects(W.raiseChange(rec.id, {}, "alice"), /gate must pass/);

    rec = await W.runGate(rec.id, "alice");
    assert.equal(rec.state, "gating");
    await W.tick();
    rec = await W.get(rec.id);
    assert.equal(rec.state, "gate-passed", rec.history.at(-1).note);

    const preview = await W.previewChange(rec.id);
    assert.equal(preview[0].edits.length, 1);
    assert.ok(preview[0].edits[0].diff.some((l) => l.includes(NEW)));

    rec = await W.raiseChange(rec.id, {}, "alice");
    assert.equal(rec.state, "awaiting-approval");
    assert.equal(rec.changes[0].number, 42);
    assert.match(files["branch:apps/payments/deployment.yaml"], /payments-api:3\.14\.3/);
    assert.match(mrBodies[0].description, /CVE-2021-44228/);
    assert.equal(patches.length, 0, "nothing touches the cluster before approval");

    await assert.rejects(W.approve(rec.id, {}, "alice", { isAdmin: true }), /separation of duties/);
    await assert.rejects(W.approve(rec.id, {}, "bob", { isAdmin: false }), /Admin/);
    rec = await W.approve(rec.id, { note: "CAB 22-Oct" }, "bob", { isAdmin: true });
    assert.equal(rec.state, "approved");
    await assert.rejects(W.deploy(rec.id, "bob"), /merged/);

    // merge → GitOps sync → rollout
    mr = { state: "merged", pipeline: "success" };
    await W.tick();
    rec = await W.get(rec.id);
    assert.equal(rec.state, "deploying");
    cluster.deployment.spec.template.spec.containers[0].image = NEW;   // Argo CD synced
    await W.tick();
    rec = await W.get(rec.id);
    assert.equal(rec.state, "verifying");
    await W.tick();
    rec = await W.get(rec.id);
    assert.equal(rec.state, "resolved", rec.history.at(-1).note);
    assert.deepEqual(rec.verify.remaining, []);
    assert.ok(rec.verify.fixed.includes("CVE-2021-44228"));
    assert.equal(patches.length, 0, "the platform never patched — GitOps did");
  });
});

describe("direct path (no Git), gate and rollback", () => {
  test("a KEV CVE in the replacement fails the gate", async () => {
    cluster = { deployment: deployment({}) };
    let rec = await W.create({ namespace: "payments", image: OLD, scan: SCAN, actor: "alice" });
    await W.setTarget(rec.id, { image: NEW }, "alice");
    await W.runGate(rec.id, "alice");
    gateResult = { done: true, ok: true, report: { critical: 1, high: 0, medium: 0, total: 1, vulns: [{ id: "CVE-2021-44228", severity: "critical" }] } };
    await W.tick();
    rec = await W.get(rec.id);
    assert.equal(rec.state, "gate-failed");
    assert.ok(rec.gate.eval.reasons.some((r) => /KEV/.test(r)));
  });

  test("an unhealthy rollout is rolled back automatically", async () => {
    cluster = { deployment: deployment({}) };
    let rec = await W.create({ namespace: "payments", image: OLD, scan: SCAN, actor: "alice" });
    await W.setTarget(rec.id, { image: NEW }, "alice");
    await W.runGate(rec.id, "alice");
    await W.tick();
    rec = await W.raiseChange(rec.id, {}, "alice");
    assert.equal(rec.deploy.mode, "direct");
    await assert.rejects(W.deploy(rec.id, "alice"), /approved/);
    await W.approve(rec.id, {}, "bob", { isAdmin: true });
    rec = await W.deploy(rec.id, "bob");
    assert.equal(patches.at(-1).body.spec.template.spec.containers[0].image, NEW);
    cluster.deployment.status.conditions = [{ type: "Progressing", reason: "ProgressDeadlineExceeded", message: "ReplicaSet has timed out progressing" }];
    await W.tick();
    rec = await W.get(rec.id);
    assert.equal(rec.state, "rolled-back");
    assert.equal(patches.at(-1).body.spec.template.spec.containers[0].image, OLD);
  });

  test("direct rollout can be switched off by policy", async () => {
    process.env.REMEDIATION_DIRECT_PATCH = "false";
    try {
      cluster = { deployment: deployment({}) };
      const rec = await W.create({ namespace: "payments", image: OLD, scan: SCAN, actor: "alice" });
      await W.setTarget(rec.id, { image: NEW }, "alice");
      await W.runGate(rec.id, "alice");
      await W.tick();
      await assert.rejects(W.raiseChange(rec.id, {}, "alice"), /disabled by policy/);
    } finally { delete process.env.REMEDIATION_DIRECT_PATCH; }
  });
});

describe("risk acceptance", () => {
  test("needs an Admin who is not the requester, a real reason, and ≤14 days for a fixable KEV", async () => {
    cluster = { deployment: deployment({}) };
    const rec = await W.create({ namespace: "payments", image: OLD, scan: SCAN, actor: "alice" });
    await assert.rejects(W.acceptRisk(rec.id, { reason: "legacy app, decommissioning soon", days: 10 }, "alice", { isAdmin: true }), /separation of duties/);
    await assert.rejects(W.acceptRisk(rec.id, { reason: "later", days: 10 }, "bob", { isAdmin: true }), /15 characters/);
    await assert.rejects(W.acceptRisk(rec.id, { reason: "legacy app, decommissioning soon", days: 30 }, "bob", { isAdmin: true }), /14 days/);
    const r = await W.acceptRisk(rec.id, { reason: "legacy app, decommissioning soon", compensating: "NetworkPolicy deny-all ingress", days: 7 }, "bob", { isAdmin: true });
    assert.equal(r.state, "exception");
  });
  test("an expired acceptance reopens by itself", async () => {
    cluster = { deployment: deployment({}) };
    const rec = await W.create({ namespace: "payments", image: OLD, scan: { ...SCAN, vulnerabilities: SCAN.vulnerabilities.slice(1) }, actor: "alice" });
    await W.acceptRisk(rec.id, { reason: "legacy app, decommissioning soon", days: 30 }, "bob", { isAdmin: true });
    (await W.get(rec.id)).exception.expires = new Date(Date.now() - 1000).toISOString();
    await W.tick();
    assert.equal((await W.get(rec.id)).state, "triaged");
  });
});

describe("GitHub", () => {
  test("opens a PR on a new branch and reads merge + CI status", async () => {
    const git = await import("../../src/services/remediation/git-providers.js");
    const calls = [];
    global.fetch = async (url, opts = {}) => {
      const u = String(url).replace("https://api.github.com", "");
      calls.push(`${opts.method || "GET"} ${u.split("?")[0]}`);
      const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
      if (u === "/repos/tcs/gitops/git/ref/heads/main") return reply(200, { object: { sha: "base1" } });
      if (u === "/repos/tcs/gitops/git/refs") return reply(201, {});
      if (u.startsWith("/repos/tcs/gitops/contents/")) { assert.equal(JSON.parse(opts.body).branch, "security/rem-1"); return reply(200, {}); }
      if (u === "/repos/tcs/gitops/pulls" && opts.method === "POST") return reply(201, { number: 7, html_url: "https://github.com/tcs/gitops/pull/7" });
      if (u.startsWith("/repos/tcs/gitops/issues/7/labels")) return reply(200, []);
      if (u === "/repos/tcs/gitops/pulls/7") return reply(200, { merged: false, state: "open", head: { sha: "h1" }, html_url: "https://github.com/tcs/gitops/pull/7" });
      if (u.startsWith("/repos/tcs/gitops/commits/h1/check-runs")) return reply(200, { check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }] });
      if (u === "/repos/tcs/gitops/commits/h1/status") return reply(200, { statuses: [] });
      return reply(404, { message: "nope" });
    };
    const repo = git.parseRepoUrl("https://github.com/tcs/gitops.git");
    const pr = await git.openChange(repo, { base: "main", branch: "security/rem-1", title: "t", body: "b", files: [{ path: "apps/a.yaml", content: "x", sha: "s" }] });
    assert.equal(pr.number, 7);
    assert.deepEqual(calls.slice(0, 4), ["GET /repos/tcs/gitops/git/ref/heads/main", "POST /repos/tcs/gitops/git/refs", "PUT /repos/tcs/gitops/contents/apps/a.yaml", "POST /repos/tcs/gitops/pulls"]);
    const st = await git.changeStatus(repo, 7);
    assert.equal(st.state, "open");
    assert.equal(st.checks, "failure", "one failed check fails the change");
  });
});
