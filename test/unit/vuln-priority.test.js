/**
 * Risk-based prioritisation: the order the Vulnerability Center shows is the
 * order these rules produce, from checkable facts only.
 * Run with: node --test test/unit/vuln-priority.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";

const P = await import("../../src/services/vuln-priority.js");
const { collectRuntimeContext } = await import("../../src/services/vuln-context.js");
const { parseEpssCsv } = await import("../../src/services/epss-feed.js");

const v = (id, severity, extra = {}) => ({ id, severity, cvss: { critical: 9.8, high: 7.5, medium: 5, low: 2 }[severity], fixedBy: "1.2.3", ...extra });
const img = (vulns, extra = {}) => ({
  image: "quay.io/a/app:1", source: "trivy", vulnerabilities: vulns,
  critical: vulns.filter((x) => x.severity === "critical").length, high: vulns.filter((x) => x.severity === "high").length,
  maxCVSS: Math.max(0, ...vulns.map((x) => x.cvss || 0)), ...extra,
});
const rt = (o = {}) => ({ running: true, podCount: 2, exposure: [], privileged: false, root: false, pods: [], namespaces: ["ns"], ...o });
const EXPOSED = [{ kind: "Route", name: "web", host: "web.apps", service: "web", namespace: "ns" }];

describe("tiers", () => {
  test("a fixable known-exploited CVE is Fix now, even inside the cluster", () => {
    const p = P.prioritizeImage(img([v("CVE-1", "high", { kev: true })]), rt());
    assert.equal(p.tier, "fix-now");
    assert.ok(p.factors.some((f) => f.key === "kev"));
  });
  test("known exploited with no fix yet is Fix soon (mitigate)", () => {
    assert.equal(P.prioritizeImage(img([v("CVE-1", "high", { kev: true, fixedBy: null })]), rt()).tier, "fix-soon");
  });
  test("a fixable Critical behind a Route is Fix now; the same Critical internal is Fix soon", () => {
    assert.equal(P.prioritizeImage(img([v("CVE-1", "critical")]), rt({ exposure: EXPOSED })).tier, "fix-now");
    assert.equal(P.prioritizeImage(img([v("CVE-1", "critical")]), rt()).tier, "fix-soon");
  });
  test("high EPSS lifts a fixable High to Fix soon internally, Fix now when exposed", () => {
    assert.equal(P.prioritizeImage(img([v("CVE-1", "high", { epss: 0.7 })]), rt()).tier, "fix-soon");
    assert.equal(P.prioritizeImage(img([v("CVE-1", "high", { epss: 0.7 })]), rt({ exposure: EXPOSED })).tier, "fix-now");
  });
  test("an image nobody runs is never above Plan", () => {
    const p = P.prioritizeImage(img([v("CVE-1", "critical", { kev: true })]), rt({ running: false, podCount: 0 }));
    assert.equal(p.tier, "plan");
    assert.ok(p.factors.some((f) => f.key === "not-running"));
  });
  test("hygiene-only rows stay Hygiene and do not claim CVE fixability", () => {
    const p = P.prioritizeImage(img([v("IMG-001", "high")], { source: "static" }), rt());
    assert.equal(p.tier, "hygiene");
    assert.ok(!p.factors.some((f) => f.key === "fixable"));
  });
  test("Medium/Low only is Monitor", () => {
    assert.equal(P.prioritizeImage(img([v("CVE-1", "medium"), v("CVE-2", "low")]), rt()).tier, "monitor");
  });
  test("no runtime context: tiers from scan data only, running unknown", () => {
    const p = P.prioritizeImage(img([v("CVE-1", "critical")]), null);
    assert.equal(p.tier, "fix-soon");
    assert.equal(p.running, null);
  });
  test("score is bounded and deterministic", () => {
    const a = P.prioritizeImage(img([v("CVE-1", "critical", { kev: true, epss: 0.99 }), v("CVE-2", "critical", { kev: true })]), rt({ exposure: EXPOSED, privileged: true }));
    const b = P.prioritizeImage(img([v("CVE-1", "critical", { kev: true, epss: 0.99 }), v("CVE-2", "critical", { kev: true })]), rt({ exposure: EXPOSED, privileged: true }));
    assert.equal(a.score, b.score);
    assert.ok(a.score <= 100 && a.score > 90);
  });
});

test("EPSS labels never say 100%", () => {
  assert.equal(P.epssLabel(0.99999), "99.9%");
  assert.equal(P.epssLabel(0.94), "94%");
  assert.equal(P.epssLabel(0.031), "3.1%");
});

describe("CVE roll-up and funnel", () => {
  const a = img([v("CVE-1", "critical", { kev: true }), v("CVE-2", "high", { fixedBy: null }), v("IMG-001", "high")], { priority: { running: true, exposed: true } });
  const b = img([v("CVE-1", "high"), v("CVE-3", "medium", { epss: 0.2 })], { image: "quay.io/a/b:2", priority: { running: false, exposed: false } });
  const agg = P.aggregateCves([a, b]);
  test("one row per CVE, highest severity kept, hygiene ids left out", () => {
    assert.equal(agg.total, 3);
    const r1 = agg.rows.find((r) => r.id === "CVE-1");
    assert.equal(r1.severity, "critical");
    assert.equal(r1.imageCount, 2);
    assert.ok(!agg.rows.some((r) => r.id === "IMG-001"));
    assert.equal(agg.rows[0].id, "CVE-1", "KEV sorts first");
  });
  test("each funnel step is a subset of the one before", () => {
    const f = P.buildFunnel(agg.rows, { runtimeKnown: true });
    for (let i = 1; i < f.length; i++) assert.ok(f[i].count <= f[i - 1].count, `${f[i].key} ≤ ${f[i - 1].key}`);
    assert.deepEqual(f.map((s) => s.key), ["all", "fixable", "running", "exploitable", "exposed"]);
  });
  test("without runtime context the running and exposure steps are omitted, not guessed", () => {
    assert.deepEqual(P.buildFunnel(agg.rows, { runtimeKnown: false }).map((s) => s.key), ["all", "fixable", "exploitable"]);
  });
});

describe("runtime context", () => {
  const api = {
    "/api/v1/pods?fieldSelector=status.phase%3DRunning": { items: [
      { metadata: { name: "web-1", namespace: "shop", labels: { app: "web" }, annotations: { "openshift.io/scc": "restricted-v2" } },
        spec: { nodeName: "w1", containers: [{ name: "web", image: "quay.io/a/web:1.0" }] }, status: { containerStatuses: [{ name: "web", imageID: "quay.io/a/web@sha256:" + "a".repeat(64) }] } },
      { metadata: { name: "agent-1", namespace: "mon", labels: { app: "agent" }, annotations: { "openshift.io/scc": "privileged" } },
        spec: { containers: [{ name: "agent", image: "quay.io/a/agent:2" }] }, status: {} },
    ] },
    "/api/v1/services": { items: [{ metadata: { name: "web", namespace: "shop" }, spec: { selector: { app: "web" }, type: "ClusterIP" } }] },
    "/apis/route.openshift.io/v1/routes": { items: [{ metadata: { name: "shop", namespace: "shop" }, spec: { host: "shop.apps", to: { name: "web" }, tls: {} } }] },
    "/apis/networking.k8s.io/v1/ingresses": { items: [] },
  };
  const get = async (p) => { if (api[p]) return api[p]; throw new Error("404"); };

  test("Route → Service → pod marks the image exposed", async () => {
    const ctx = await collectRuntimeContext({ get });
    const r = ctx.lookup("quay.io/a/web:1.0");
    assert.equal(r.running, true);
    assert.equal(r.exposure[0].kind, "Route");
    assert.equal(r.exposure[0].host, "shop.apps");
  });
  test("a digest match counts; a different tag of the same repo does not", async () => {
    const ctx = await collectRuntimeContext({ get });
    assert.equal(ctx.lookup("quay.io/a/web:1.0@sha256:" + "a".repeat(64)).running, true);
    assert.equal(ctx.lookup("quay.io/a/web:2.0").running, false);
  });
  test("privileged SCC is flagged", async () => {
    const ctx = await collectRuntimeContext({ get });
    assert.equal(ctx.lookup("quay.io/a/agent:2").privileged, true);
  });
  test("no permission to list pods → context unavailable, nothing guessed", async () => {
    const ctx = await collectRuntimeContext({ get: async () => { throw new Error("403"); } });
    assert.equal(ctx.available, false);
  });
});

test("parses FIRST's EPSS CSV", () => {
  const m = parseEpssCsv("#model_version:v2025.03.14,score_date:2026-10-21T00:00:00+0000\ncve,epss,percentile\nCVE-2021-44228,0.99999,1.00000\nCVE-2019-0001,0.03049,0.87438\n");
  assert.equal(m.size, 2);
  assert.equal(m.get("CVE-2021-44228").epss, 0.99999);
  assert.equal(m.get("CVE-2019-0001").date, "2026-10-21");
});
