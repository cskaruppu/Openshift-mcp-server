/**
 * What the Image Vulnerabilities widget may claim, and what may reach a patch.
 * Run with: node --test test/unit/image-vuln-trust.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const kev = await import("../../src/services/kev-feed.js");
const { parseImageRef, isConcreteImageRef, sameImage, verifyImageExists, citedCves } =
  await import("../../src/services/image-verify.js");

const catalog = (ids) => ({
  catalogVersion: "2026.10.21", dateReleased: "2026-10-21T00:00:00Z",
  vulnerabilities: ids.map(cveID => ({ cveID })),
});

describe("CISA KEV catalog", () => {
  test("only catalog ids are flagged — a CVSS 9.8 alone is not 'exploited'", () => {
    kev._setKevCatalogForTest(catalog(["CVE-2021-44228"]));
    assert.equal(kev.isKnownExploited("cve-2021-44228"), true);
    assert.equal(kev.isKnownExploited("CVE-2099-0001"), false);
    assert.equal(kev.kevStatus().status, "live");
    assert.equal(kev.kevStatus().count, 1);
  });

  test("rejects a document that is not the catalog", () => {
    assert.throws(() => kev.parseKevCatalog({ foo: 1 }));
    assert.throws(() => kev.parseKevCatalog({ vulnerabilities: [] }));
  });

  test("loads from KEV_FEED_FILE for air-gapped clusters", async () => {
    kev._setKevCatalogForTest(null);
    const dir = mkdtempSync(join(tmpdir(), "kev-"));
    const file = join(dir, "kev.json");
    writeFileSync(file, JSON.stringify(catalog(["CVE-2024-3094", "CVE-2023-4863"])));
    process.env.KEV_FEED_FILE = file;
    try {
      const set = await kev.getKevSet();
      assert.equal(set.size, 2);
      assert.equal(kev.kevStatus().status, "live");
      assert.match(kev.kevStatus().source, /^file:/);
    } finally { delete process.env.KEV_FEED_FILE; }
  });

  test("an unreadable catalog flags nothing and says so", async () => {
    kev._setKevCatalogForTest(null);
    process.env.KEV_FEED_FILE = "/nonexistent/kev.json";
    try {
      const set = await kev.getKevSet();
      assert.equal(set.size, 0);
      assert.equal(kev.kevStatus().status, "unavailable");
    } finally { delete process.env.KEV_FEED_FILE; kev._setKevCatalogForTest(null); }
  });
});

describe("image references", () => {
  test("parses registry, repo and tag, defaulting Docker Hub", () => {
    assert.deepEqual(parseImageRef("nginx"), { registry: "docker.io", repo: "library/nginx", tag: "latest", digest: null });
    assert.deepEqual(parseImageRef("quay.io/org/app:1.2.3"), { registry: "quay.io", repo: "org/app", tag: "1.2.3", digest: null });
    assert.equal(parseImageRef("registry.local:5000/a/b:v1").registry, "registry.local:5000");
  });

  test("placeholders and malformed refs are not appliable", () => {
    for (const bad of ["nginx:<patched-tag>", "nginx:<latest-stable-tag>", "", "has space:1", "quay.io/x:{tag}", "nginx:pin-specific-version"]) {
      assert.equal(isConcreteImageRef(bad), false, bad);
    }
    for (const good of ["nginx:1.27.2", "quay.io/org/app:1.2.3", "registry.local:5000/a/b@sha256:" + "a".repeat(64)]) {
      assert.equal(isConcreteImageRef(good), true, good);
    }
  });

  test("sameImage matches the running container, not a look-alike", () => {
    assert.equal(sameImage("nginx:1.25", "docker.io/library/nginx:1.25"), true);
    assert.equal(sameImage("nginx:1.25", "nginx:1.26"), false);
    assert.equal(sameImage("quay.io/a/nginx:1.25", "docker.io/library/nginx:1.25"), false);
    assert.equal(sameImage("nginx", "nginx:latest"), true);
  });
});

describe("registry check", () => {
  const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
  test("follows the anonymous token challenge and reports existence", async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      calls.push(url);
      if (url.startsWith("https://auth.example/token")) return { ok: true, status: 200, json: async () => ({ token: "t" }), headers: headers({}) };
      if (!opts.headers?.Authorization) return { ok: false, status: 401, headers: headers({ "www-authenticate": 'Bearer realm="https://auth.example/token",service="reg"' }) };
      return { ok: true, status: 200, headers: headers({ "docker-content-digest": "sha256:abc" }) };
    };
    const r = await verifyImageExists("quay.io/org/app:1.2.3", { fetchImpl });
    assert.deepEqual(r, { exists: true, digest: "sha256:abc" });
    assert.equal(calls.length, 3);
  });

  test("a 404 means the AI named a tag that does not exist", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, headers: headers({}) });
    const r = await verifyImageExists("quay.io/org/app:9.9.9-made-up", { fetchImpl });
    assert.equal(r.exists, false);
  });

  test("an unreachable registry is 'unknown', not 'exists'", async () => {
    const fetchImpl = async () => { throw new Error("ENOTFOUND"); };
    const r = await verifyImageExists("quay.io/org/app:1", { fetchImpl });
    assert.equal(r.exists, null);
  });

  test("placeholders never reach the network", async () => {
    let called = false;
    const r = await verifyImageExists("nginx:<patched-tag>", { fetchImpl: async () => { called = true; } });
    assert.equal(r.exists, false);
    assert.equal(called, false);
  });
});

test("citedCves pulls every CVE id out of model text", () => {
  assert.deepEqual(citedCves("Fix cve-2021-44228 and CVE-2023-4863.", "again CVE-2021-44228"), ["CVE-2021-44228", "CVE-2023-4863"]);
  assert.deepEqual(citedCves("no ids here"), []);
});

describe("upgrade candidates come from real registry tags", async () => {
  const { upgradeCandidates, parseVersionTag } = await import("../../src/services/image-verify.js");
  test("newest patch, newest minor, newest — same flavour, no pre-releases", () => {
    const tags = ["2.4.49", "2.4.62", "2.4.69", "2.4.69-alpine", "2.5.0-rc1", "2.6.1", "3.0.0", "latest", "2.4"];
    assert.deepEqual(upgradeCandidates("2.4.49", tags).map((c) => [c.kind, c.tag]), [["patch", "2.4.69"], ["minor", "2.6.1"], ["latest", "3.0.0"]]);
    assert.deepEqual(upgradeCandidates("2.4.49-alpine", tags).map((c) => c.tag), ["2.4.69-alpine"]);
  });
  test("keeps the v-prefix and precision of the running tag", () => {
    assert.deepEqual(upgradeCandidates("v1.6.1", ["v1.6.2", "1.7.0", "v1.8.0"]).map((c) => c.tag), ["v1.6.2", "v1.8.0"]);
    assert.deepEqual(upgradeCandidates("3.8-slim", ["3.8.20-slim", "3.12-slim", "3.13-rc-slim"]).map((c) => c.tag), ["3.12-slim"]);
  });
  test("a tag that is not a version offers nothing rather than a guess", () => {
    assert.equal(parseVersionTag("latest"), null);
    assert.deepEqual(upgradeCandidates("latest", ["1.0.0"]), []);
  });
});
