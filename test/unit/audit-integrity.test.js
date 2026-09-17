import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toOcsf, auditRetentionDays, verifyAuditChain } from "../../src/services/audit-log.js";

// ══ Tamper evidence ══════════════════════════════════════════════════════
test("with no database the chain is unverified, not verified", async () => {
  const r = await verifyAuditChain();
  assert.equal(r.verified, null, "nothing to check is not the same as checked and intact");
  assert.notEqual(r.verified, true);
  assert.match(r.reason, /cannot be verified|empty/i);
});

test("retention is configurable and no longer 90 days hardcoded", () => {
  const d = auditRetentionDays();
  assert.ok(Number.isFinite(d));
  assert.ok(d >= 365, `retention is ${d}; SOX and PCI commonly expect a year`);
});

// ══ OCSF ═════════════════════════════════════════════════════════════════
const entry = {
  id: 42, event_type: "action_taken", severity: "critical",
  title: "Deleted namespace prod-old", namespace: "prod-old", username: "s.menon",
  source: "chat", created_at: "2026-09-17T14:02:11Z", entry_hash: "abc123",
  details: { command: "oc delete ns prod-old" },
};

test("an event maps onto the OCSF shape a SIEM already understands", () => {
  const o = toOcsf(entry);
  assert.equal(o.class_uid, 6003);
  assert.equal(o.category_uid, 6);
  assert.equal(o.severity_id, 5, "critical");
  assert.equal(o.time, Date.parse("2026-09-17T14:02:11Z"), "OCSF wants epoch milliseconds");
  assert.equal(o.time_dt, "2026-09-17T14:02:11.000Z");
  assert.equal(o.actor.user.name, "s.menon");
  assert.deepEqual(o.resources, [{ type: "Namespace", name: "prod-old" }]);
  assert.equal(o.metadata.version, "1.1.0");
});

test("the entry hash travels with the record, so a SIEM can prove what it holds", () => {
  assert.equal(toOcsf(entry).metadata.uid, "abc123");
  // A row that predates tamper-evidence carries no uid rather than a fake one.
  const { entry_hash, ...old } = entry;
  assert.equal(toOcsf(old).metadata.uid, undefined);
});

test("fields this trail does not record are left out, not invented", () => {
  const sparse = toOcsf({ event_type: "login", severity: "info", title: "Signed in", created_at: "2026-09-17T00:00:00Z" });
  assert.equal(sparse.actor, undefined, "no username recorded means no actor claimed");
  assert.equal(sparse.resources, undefined);
  assert.equal(sparse.class_uid, 3002, "login maps to Authentication");
});

test("an unknown event type still maps to something ingestible", () => {
  const o = toOcsf({ event_type: "something_new", severity: "warn", title: "x", created_at: "2026-09-17T00:00:00Z" });
  assert.ok(o.class_uid, "a SIEM must not receive a record with no class");
  assert.equal(o.severity_id, 3);
});

// ══ The view ═════════════════════════════════════════════════════════════
const UI = readFileSync("console/src/views/AuditView.jsx", "utf8");

// A red 0% beside "0 actions executed" says the platform fails everything.
test("success rate is null, not 0%, when nothing has run", () => {
  assert.match(UI, /const rate = total \? Math\.round\(\(successCount \/ total\) \* 100\) : null/);
  assert.match(UI, /rate === null \? "—"/, "it must render as unknown, not as zero");
  // Colour now comes from a class, not an inline --stat-c: null adds no
  // class at all, so the card stays neutral rather than turning red.
  assert.match(UI, /rate === null \? "" : rate >= 90 \? " good" : rate >= 70 \? " warn" : " alert"/,
    "no data must add no colour class");
  assert.doesNotMatch(UI, /"--stat-c"/, "six inline accent colours gave the row no hierarchy");
});

test("the CIS score carries a denominator", () => {
  assert.match(UI, /aud-stat-denom/);
  assert.match(UI, /\/100/, "a bare '6' cannot be read");
});

test("failed findings are broken down by severity", () => {
  assert.match(UI, /const sevSplit = useMemo/);
  assert.match(UI, /critical", "high", "medium", "low", "info"/);
});

test("retention is stated in the UI rather than left in the source", () => {
  assert.match(UI, /integrity\?\.retentionDays/);
  assert.doesNotMatch(UI, /90-day event log/, "the hardcoded claim must be gone");
});

test("the trail says whether it can be trusted, with unverified as its own state", () => {
  assert.match(UI, /Chain intact/);
  assert.match(UI, /Chain broken/);
  assert.match(UI, /Not verified/, "unverifiable is not the same as tampered with");
});

// ══ The five smaller items ═══════════════════════════════════════════════
test("the trail can be filtered to a period", () => {
  assert.match(UI, /const \[trailFrom, setTrailFrom\]/);
  assert.match(UI, /const \[trailTo, setTrailTo\]/);
  assert.match(UI, /type="date"/, "audits work in periods, not in scroll distance");
  // An end date that excluded its own last day would quietly drop evidence.
  assert.match(UI, /setHours\(23, 59, 59, 999\)/);
  assert.match(UI, /setHours\(0, 0, 0, 0\)/);
});

test("the trail can be filtered to a person", () => {
  assert.match(UI, /const trailUsers = useMemo/);
  assert.match(UI, /trailUser !== "all"\) list = list\.filter\(\(e\) => e\.username === trailUser\)/);
});

test("the filter says it only narrows what was loaded", () => {
  assert.match(UI, /Filters the \{trailEntries\.length\} most recent entries loaded/,
    "otherwise somebody concludes March was quiet when March was never fetched");
});

test("timestamps are UTC-first, with local on hover", () => {
  assert.match(UI, /toISOString\(\)\.replace\("T", " "\)/);
  assert.match(UI, /aud-ts-z/);
  assert.match(UI, /local · \$\{timeAgo\(ts\)\}/, "local time belongs on the tooltip, not in the record");
});

test("an invalid timestamp renders as unknown rather than 'Invalid Date'", () => {
  assert.match(UI, /Number\.isNaN\(d\.getTime\(\)\)/);
});

test("the export buttons say what they export, and how much", () => {
  assert.match(UI, /Export \{filteredExecuted\.length\} action/);
  assert.doesNotMatch(UI, />Export JSON</, "a bare label on a seven-tab page says nothing");
  assert.doesNotMatch(UI, />Export CSV</);
});

test("0 of 12 controls before any scan reads as unknown, not as failure", () => {
  assert.match(UI, /no scan has run/);
});

// ══ One page, one clock ══════════════════════════════════════════════════
// Changing TimeCell to UTC left two compliance timestamps on local time, so
// the page showed two clocks at once. This pins every timestamp to TimeCell.
test("every timestamp on the Audit page goes through TimeCell", () => {
  const strays = UI.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\bfmt\(|formatTimestamp\(/.test(l))
    .filter(([, l]) => !/^\s*\/[/*]|\*/.test(l))          // not a comment
    .filter(([, l]) => !/title=\{`/.test(l));              // the tooltip inside TimeCell
  assert.deepEqual(strays, [],
    "a bare formatTimestamp call renders local time beside UTC everywhere else");
});

test("the convenient shortcut back to local-only formatting is gone", () => {
  assert.doesNotMatch(UI, /^const fmt = formatTimestamp;$/m,
    "the alias is how the two clocks appeared in the first place");
});

// ══ Empty states say which kind of empty ═════════════════════════════════
test("an empty trail is distinguished from one filtered to nothing", () => {
  assert.match(UI, /trailEntries\.length === 0/);
  assert.match(UI, /None of the \$\{trailEntries\.length\} loaded entries match these filters/,
    "with a period and a user filter, 'not found' cannot tell you which happened");
});

test("change requests say the same two things", () => {
  assert.match(UI, /No change requests have been raised yet/);
  assert.match(UI, /No change requests match the current filters/);
});

// ══ Four tables, no duplication ══════════════════════════════════════════
// Validated against the source: executed_actions, audit_trail, query_traces
// and audit_log share no rows and no writers. The tabs looked redundant
// because their names all meant "things that happened", not because the data
// overlapped — so the fix is labels, plus surfacing the table nothing showed.
test("each tab says what it holds and points at the others", () => {
  assert.match(UI, /Security &amp; Compliance Events/);
  assert.match(UI, /Commands Run/);
  assert.match(UI, /Scans, policy violations, logins and role changes/);
  assert.match(UI, /Only queries that went through AI Chat/);
});

test("the tab labels no longer all read as 'things that happened'", () => {
  assert.doesNotMatch(UI, /label: "Audit Trail"/);
  assert.doesNotMatch(UI, /label: "Activity & Actions"/);
  assert.match(UI, /label: "Security Events"/);
  assert.match(UI, /label: "Commands Run"/);
});

// audit_log has recorded every blocked command since guardrails shipped, and
// no view ever called /api/audit-log. A refused destructive command is the
// thing an auditor most wants to see.
test("commands refused by the guardrails are finally visible", () => {
  assert.match(UI, /api\/audit-log\?limit=100/);
  assert.match(UI, /commands? refused by policy|command\{blockedDecisions/);
  assert.match(UI, /block_reason/);
});

test("only refusals are surfaced, so nothing appears twice", () => {
  assert.match(UI, /\.filter\(\(d\) => d\.allowed === false\)/,
    "an allowed command already appears as one that ran; showing it again is the duplication this set out to prevent");
});
