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
  assert.match(UI, /rate === null \? "#64748b"/, "and not in red");
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
