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

test("the evidence pack states what the AI did and what it did not", () => {
  const ai = {
    consulted: true, calls: 2, succeeded: 2, failed: 0, provider: "openai", model: "gpt-4o",
    promptTokens: 2700, completionTokens: 712, totalTokens: 3412, durationMs: 1740, corrections: 1,
    advisedByAI: ["Warm or cold per VM"], decidedByCode: ["Guest OS support level", "Target capacity"],
    touchpoints: [],
  };
  const html = toHtml(analysis([vm("a")]), { reportId: "ASM-1", ai });
  assert.match(html, /AI provenance/);
  assert.match(html, /gpt-4o/);
  assert.match(html, /3412/);
  assert.match(html, /overruled by policy/i);
  assert.match(html, /Decided by code, with no model involved/);
  assert.match(html, /no cluster access and no tools/);

  const csv = toCsv(analysis([vm("a")]), { reportId: "ASM-1", ai });
  assert.match(csv, /"AI provider \/ model","openai \/ gpt-4o"/);
  assert.match(csv, /"AI recommendations overruled","1"/);
  assert.match(csv, /"Decided by code, not AI"/);
});

test("with no model consulted the pack says so rather than omitting the section", () => {
  const ai = { consulted: false, calls: 0, corrections: 0, advisedByAI: [], decidedByCode: ["Guest OS support level"], touchpoints: [] };
  const html = toHtml(analysis([vm("a")]), { reportId: "ASM-1", ai });
  assert.match(html, /No language model was consulted/);
  assert.ok(!html.includes("Provider and model"), "no model table for a run that used none");

  const csv = toCsv(analysis([vm("a")]), { reportId: "ASM-1", ai });
  assert.match(csv, /"AI consulted","no"/);
});

// ── Target drift ───────────────────────────────────────────────────────────

const withCapacity = (rows, nodes, placed = [], unplaced = []) => ({
  ...analysis(rows),
  capacity: {
    verdict: unplaced.length ? "fragmented" : "fits", virtNodeCount: nodes.length,
    placement: { nodes, placed, unplaced, placedCount: placed.length, unplacedCount: unplaced.length },
  },
});

test("a verdict records the cluster it was made against, not just the estate", () => {
  const s = snapshotOf(withCapacity(
    [vm("web01")],
    [{ name: "w1", memGiB: 64, cpuMillis: 32000 }],
    [{ name: "web01", node: "w1" }],
  ), { id: "ASM-1" });
  assert.equal(s.capacity.virtNodeCount, 1);
  assert.deepEqual(s.capacity.nodes, [{ name: "w1", memGiB: 64, cpuMillis: 32000 }]);
  assert.equal(s.vms.web01.landsOn, "w1");
  assert.equal(s.vms.web01.placement, "placed");
});

test("replacing a worker with a smaller one changes verdicts nobody touched", () => {
  const prev = snapshotOf(withCapacity(
    [vm("web01")],
    [{ name: "w1", memGiB: 256, cpuMillis: 32000 }],
    [{ name: "web01", node: "w1" }],
  ), { id: "ASM-1" });
  const next = snapshotOf(withCapacity(
    [vm("web01")],
    [{ name: "w1", memGiB: 32, cpuMillis: 32000 }],
    [],
    [{ name: "web01", blockedBy: "hardware" }],
  ), { id: "ASM-2" });

  const d = diffAssessments(prev, next);
  assert.equal(d.capacity.resized.length, 1);
  assert.match(d.capacity.resized[0].note, /Shrank from 256 to 32 GiB/);
  assert.equal(d.capacity.regressed.length, 1);
  assert.equal(d.capacity.regressed[0].name, "web01");
  assert.match(d.capacity.regressed[0].note, /too large for any node/);
  assert.match(d.capacity.headline, /1 verdict changed/);
  // The estate itself did not move, so the source drift is silent — and the
  // assessment is still out of date. Saying "nothing changed" here would be
  // the exact failure this panel exists to prevent.
  assert.equal(d.counts.improved + d.counts.regressed, 0);
  assert.ok(d.material > 0);
  assert.match(d.headline, /1 verdict changed/);
});

test("a machine that lands somewhere new is reported, but not as a regression", () => {
  const nodes = [{ name: "w1", memGiB: 64, cpuMillis: 32000 }, { name: "w2", memGiB: 64, cpuMillis: 32000 }];
  const prev = snapshotOf(withCapacity([vm("a")], nodes, [{ name: "a", node: "w1" }]), { id: "ASM-1" });
  const next = snapshotOf(withCapacity([vm("a")], nodes, [{ name: "a", node: "w2" }]), { id: "ASM-2" });
  const d = diffAssessments(prev, next);
  assert.equal(d.capacity.moved.length, 1);
  assert.equal(d.capacity.regressed.length, 0);
  assert.equal(d.capacity.material, 0, "a reshuffle is news, not a change of outcome");
  assert.match(d.headline, /Nothing has changed/);
});

test("an assessment with no capacity reading does not invent target drift", () => {
  const a = snapshotOf(analysis([vm("a")]), { id: "ASM-1" });
  const b = snapshotOf(analysis([vm("a")]), { id: "ASM-2" });
  assert.equal(a.capacity, null);
  assert.equal(diffAssessments(a, b).capacity, null);
  assert.equal(diffAssessments(a, b).material, 0);
});

test("the evidence pack carries the placement and the node-loss rehearsal", () => {
  const html = toHtml(analysis([vm("a")]), {
    reportId: "ASM-1",
    capacity: {
      verdict: "fragmented", headline: "Room exists but cannot be reached.",
      demand: { memGiB: 100, cpuMillis: 400, diskGiB: 10 }, free: { memGiB: 120, cpuMillis: 800 },
      virtNodeCount: 2, perVm: [], notes: [],
      placement: {
        available: true, placedCount: 1, unplacedCount: 1, nodesUsed: 1,
        nodes: [{ name: "w1", vmCount: 1, usedMemGiB: 60, memGiB: 64 }],
        unplaced: [{ name: "late", blockedBy: "wave", reason: "The wave blocks this machine, not the cluster." }],
      },
      rehearsal: { available: true, headline: "Losing w1 would strand 1 machine.", nodes: [{ node: "w1", hosted: 1, stillPlaces: 0, stranded: 1 }] },
    },
  });
  assert.match(html, /packed as a set/);
  assert.match(html, /blocked by the wave itself, not by the cluster/i);
  assert.match(html, /If a node is lost mid-wave/);
  assert.match(html, /1 no longer do/);
});

test("a pack with no placement reading omits the section rather than printing zeros", () => {
  const html = toHtml(analysis([vm("a")]), {
    reportId: "ASM-1",
    capacity: { verdict: "fits", headline: "Fits.", demand: { memGiB: 1, cpuMillis: 1, diskGiB: 1 },
      free: { memGiB: 9, cpuMillis: 9 }, virtNodeCount: 1, perVm: [], notes: [] },
  });
  assert.ok(!html.includes("Placement"));
  assert.ok(!html.includes("If a node is lost mid-wave"));
});
