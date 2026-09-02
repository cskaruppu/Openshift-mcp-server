import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotOf, diffAssessments, reportId, snapshotKey } from "../../src/services/assessment-store.js";
import { toCsv, toHtml, csvCell } from "../../src/services/assessment-report.js";

const analysis = (rows) => ({
  total: rows.length, byLevel: {}, totalDiskGiB: 0, totalCpu: 0, totalMemoryGiB: 0,
  matrix: { asOf: "2026-08", source: "Red Hat certified guest list." }, rows,
});
const vm = (name, over = {}) => ({
  name, level: "supported", os: { distro: "RHEL 9", family: "linux", reported: "rhel9_64Guest" },
  cpuCount: 4, memoryGiB: 16, diskGiB: 100, warmEligible: true, poweredOn: true,
  ips: ["10.0.0.1"], blockers: [], warnings: [], notes: [], actions: [], ...over,
});

// ── Drift ──────────────────────────────────────────────────────────────────

test("a report id is quotable and dated", () => {
  const id = reportId(new Date("2026-09-02T10:00:00Z"), "4F2A1B");
  assert.equal(id, "ASM-20260902-4F2A1B");
});

test("a provider uid becomes a legal ConfigMap data key", () => {
  assert.equal(snapshotKey("vsphere:42/abc def"), "vsphere-42-abc-def");
  assert.equal(snapshotKey(""), "default");
});

test("drift separates what got better from what got worse", () => {
  const prev = snapshotOf(analysis([
    vm("upgraded", { level: "unsupported", os: { distro: "CentOS 7/8" } }),
    vm("regressed"),
    vm("gone"),
  ]), { id: "ASM-1" });
  const next = snapshotOf(analysis([
    vm("upgraded", { os: { distro: "RHEL 9" } }),
    vm("regressed", { level: "unsupported" }),
    vm("brandnew"),
  ]), { id: "ASM-2" });

  const d = diffAssessments(prev, next);
  assert.deepEqual(d.improved.map((x) => x.name), ["upgraded"]);
  assert.deepEqual(d.regressed.map((x) => x.name), ["regressed"]);
  assert.deepEqual(d.added.map((x) => x.name), ["brandnew"]);
  assert.deepEqual(d.removed.map((x) => x.name), ["gone"]);
  assert.equal(d.sinceReportId, "ASM-1");
  assert.match(d.headline, /1 improved/);
});

test("enabling CBT reads as an improvement even when the support level is unchanged", () => {
  const prev = snapshotOf(analysis([vm("db01", { warmEligible: false })]), { id: "ASM-1" });
  const next = snapshotOf(analysis([vm("db01", { warmEligible: true })]), { id: "ASM-2" });
  const d = diffAssessments(prev, next);
  assert.equal(d.improved.length, 1);
  assert.match(d.improved[0].note, /warm migration is available/);
  assert.equal(d.regressed.length, 0);
});

test("a disk that grew is flagged, because the transfer estimate moved", () => {
  const prev = snapshotOf(analysis([vm("big", { diskGiB: 100 })]), { id: "ASM-1" });
  const same = snapshotOf(analysis([vm("big", { diskGiB: 105 })]), { id: "ASM-2" });
  const grown = snapshotOf(analysis([vm("big", { diskGiB: 400 })]), { id: "ASM-3" });
  assert.equal(diffAssessments(prev, same).changed.length, 0, "5% is noise, not news");
  assert.match(diffAssessments(prev, grown).changed[0].note, /grew from 100 to 400/);
});

test("an unchanged estate says so plainly, and a first run has no baseline", () => {
  const a = snapshotOf(analysis([vm("a")]), { id: "ASM-1" });
  const b = snapshotOf(analysis([vm("a")]), { id: "ASM-2" });
  assert.equal(diffAssessments(a, b).material, 0);
  assert.match(diffAssessments(a, b).headline, /Nothing has changed since ASM-1/);
  assert.equal(diffAssessments(null, b), null, "the first assessment has nothing to compare to");
});

// ── Evidence pack ──────────────────────────────────────────────────────────

test("CSV cells are quoted and cannot become spreadsheet formulas", () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  // A guest OS string or an MTV message is outside data — it must never execute.
  assert.equal(csvCell("=cmd|'/c calc'!A1"), `"'=cmd|'/c calc'!A1"`);
  assert.equal(csvCell("-2+3"), `"'-2+3"`);
  assert.equal(csvCell(null), '""');
});

test("the CSV register carries provenance above the machine rows", () => {
  const csv = toCsv(analysis([vm("web01")]), {
    reportId: "ASM-20260902-AAAAAA", at: "2026-09-02T10:00:00Z",
    provider: "vcenter-prod", cluster: "hub", actor: "operator",
    advice: [{ name: "web01", strategy: "warm", label: "Stays online" }],
  });
  assert.match(csv, /"ASM-20260902-AAAAAA"/);
  assert.match(csv, /"vcenter-prod"/);
  assert.match(csv, /"2026-08"/, "the matrix version is part of the evidence");
  assert.match(csv, /"web01"/);
  assert.match(csv, /"warm"/);
  assert.ok(csv.includes("\r\n"), "RFC 4180 line endings");
});

test("the printable pack escapes hostile content and states its own limits", () => {
  const html = toHtml(analysis([vm("<script>alert(1)</script>")]), {
    reportId: "ASM-1", at: "2026-09-02T10:00:00Z", cluster: "hub",
    capacity: { verdict: "tight", headline: "Tight.", demand: { memGiB: 100, cpuMillis: 4000, diskGiB: 900 },
      free: { memGiB: 120, cpuMillis: 8000 }, virtNodeCount: 3, perVm: [], notes: ["assumption"] },
  });
  assert.ok(!html.includes("<script>alert(1)</script>"), "VM names come from vCenter — never trusted");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /not on live utilisation/, "the capacity caveat must survive into the document");
  assert.match(html, /re-run before acting on it/);
  assert.match(html, /ASM-1/);
});

test("the pack renders with no capacity or drift rather than breaking", () => {
  const html = toHtml(analysis([vm("a")]), { reportId: "ASM-1" });
  assert.match(html, /Machine register/);
  assert.ok(!html.includes("Target capacity"));
  assert.ok(!html.includes("Change since the previous assessment"));
});

test("the pack separates 'can never schedule' from 'no room today'", () => {
  const html = toHtml(analysis([vm("a"), vm("b")]), {
    reportId: "ASM-1",
    capacity: {
      verdict: "blocked", headline: "Blocked.", demand: { memGiB: 10, cpuMillis: 100, diskGiB: 10 },
      free: { memGiB: 5, cpuMillis: 50 }, virtNodeCount: 1, notes: [],
      perVm: [
        { name: "too-big", fits: false, permanent: true, reason: "Larger than every node." },
        { name: "no-room", fits: false, permanent: false, reason: "No node has space right now." },
      ],
    },
  });
  assert.match(html, /can never schedule on this cluster/);
  assert.match(html, /no room today/);
  // The two must not be pooled: one needs hardware, the other needs a window.
  const never = html.slice(html.indexOf("can never schedule"), html.indexOf("no room today"));
  assert.ok(never.includes("too-big") && !never.includes("no-room"));
});
