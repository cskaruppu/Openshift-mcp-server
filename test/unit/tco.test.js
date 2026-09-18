import { test } from "node:test";
import assert from "node:assert/strict";
import { infraPricing, footprint, tcoComparison, DEFAULT_THREADS_PER_CORE } from "../../src/services/tco.js";

const vm = (name, host, over = {}) => ({ name, host, cpuCount: 8, memoryGiB: 32, diskGiB: 1024, ...over });
const vms = [vm("a", "esx-01"), vm("b", "esx-01"), vm("c", "esx-02"), vm("d", "esx-03")];
const capacity = {
  virtNodeCount: 4,
  placement: { available: true, nodesUsed: 2, nodes: [
    { name: "w1", vmCount: 3, cpuMillis: 64000, memGiB: 256 },
    { name: "w2", vmCount: 1, cpuMillis: 64000, memGiB: 256 },
    { name: "w3", vmCount: 0, cpuMillis: 64000, memGiB: 256 },
  ] },
};
const RATES = JSON.stringify({
  vspherePerSocketYear: 3450, vcenterPerInstanceYear: 6000,
  openshiftPerCorePairYear: 2100, socketsPerHost: 2, currency: "USD",
});

test("no rate card means no cost at all, and the footprint still renders", () => {
  const t = tcoComparison(vms, capacity, { env: {} });
  assert.equal(t.priced, false);
  assert.equal(t.saving, null);
  assert.match(t.headline, /nothing reports what you pay for vSphere/);
  // The countable half is the point: it works on day one at every customer.
  assert.equal(t.source.rows.find((r) => r.k === "Hosts carrying these VMs").v, "3");
  assert.equal(t.source.rows.find((r) => r.k === "Allocated vCPU").v, "32");
  assert.equal(t.target.rows.find((r) => r.k === "Nodes this wave uses").v, "2 of 4");
});

test("a missing rate shows nothing rather than zero", () => {
  const partial = JSON.stringify({ openshiftPerCorePairYear: 2100, socketsPerHost: 2 });
  const t = tcoComparison(vms, capacity, { env: { INFRA_PRICING: partial } });
  assert.equal(t.priced, false);
  assert.ok(!t.source.rows.some((r) => /vSphere/.test(r.k)), "an unpriced line is absent, not $0");
  assert.ok(t.notes.some((n) => /no vspherePerSocketYear rate was supplied/.test(n)));
});

test("sockets are never inferred from the VM inventory", () => {
  const noSockets = JSON.stringify({ vspherePerSocketYear: 3450, openshiftPerCorePairYear: 2100 });
  const t = tcoComparison(vms, capacity, { env: { INFRA_PRICING: noSockets } });
  assert.equal(t.priced, false);
  assert.ok(t.notes.some((n) => /cannot be derived from the VM inventory/.test(n)));
  assert.equal(footprint(vms, capacity).source.socketsKnown, false);
});

test("a complete rate card prices both sides and shows the arithmetic", () => {
  const t = tcoComparison(vms, capacity, { env: { INFRA_PRICING: RATES, INFRA_PRICING_AS_OF: "2026-09" } });
  assert.equal(t.priced, true);
  // 3 hosts × 2 sockets × $3450 = $20,700, plus one vCenter at $6,000.
  assert.equal(t.source.annual, 26700);
  // Two nodes in use × 64 threads = 128 threads ÷ 2 = 64 cores → 32 pairs × $2100.
  assert.equal(t.target.annual, 32 * 2100);
  assert.equal(t.saving, 26700 - 67200);
  assert.ok(t.basis.lines.some((l) => /3 hosts × 2 sockets/.test(l)));
  assert.ok(t.basis.lines.some((l) => /128 reported threads ÷ 2 per core = 64 cores → 32 pairs/.test(l)));
  assert.equal(t.basis.asOf, "2026-09");
});

test("a migration that costs more says so in the headline, not in a footnote", () => {
  const t = tcoComparison(vms, capacity, { env: { INFRA_PRICING: RATES } });
  assert.ok(t.saving < 0, "this fixture is more expensive after");
  assert.match(t.headline, /the migration costs \$40,500 a year MORE/);
  assert.match(t.headline, /the number to take into the decision/);

  // And the other direction still reads as a saving, in plain words.
  const cheap = JSON.stringify({ ...JSON.parse(RATES), openshiftPerCorePairYear: 100 });
  const t2 = tcoComparison(vms, capacity, { env: { INFRA_PRICING: cheap } });
  assert.ok(t2.saving > 0);
  assert.match(t2.headline, /a year less/);
  assert.equal(t2.savingDirection, "saved");
});

test("list prices are labelled, because a list-versus-negotiated comparison is rigged", () => {
  const list = JSON.stringify({ ...JSON.parse(RATES), basis: "list" });
  const t = tcoComparison(vms, capacity, { env: { INFRA_PRICING: list } });
  assert.equal(t.basis.source, "list-price");
  assert.ok(t.notes.some((n) => /is not a comparison/.test(n)));
});

test("threads are converted to physical cores, and the assumption is stated", () => {
  assert.equal(DEFAULT_THREADS_PER_CORE, 2);
  const t = tcoComparison(vms, capacity, { env: { INFRA_PRICING: RATES } });
  assert.ok(t.notes.some((n) => /Set threadsPerCore in the rate card/.test(n)));

  const oneThread = JSON.stringify({ ...JSON.parse(RATES), threadsPerCore: 1 });
  const t1 = tcoComparison(vms, capacity, { env: { INFRA_PRICING: oneThread } });
  assert.equal(t1.target.annual, 64 * 2100, "no hyperthreading doubles the core pairs");
});

test("unreadable pricing configuration refuses rather than half-pricing the wave", () => {
  const p = infraPricing({ INFRA_PRICING: "{not json" });
  assert.equal(p.configured, false);
  assert.match(p.reason, /not valid JSON/);
  assert.equal(tcoComparison(vms, capacity, { env: { INFRA_PRICING: "{not json" } }).priced, false);
});

test("the right-sizing caveat travels with the cost, so a partial saving is never quoted as total", () => {
  const rs = { saving: { vcpuFreed: 12 }, coverage: { measured: 2, total: 4 }, caveat: "2 machines have no usable history." };
  const t = tcoComparison(vms, capacity, { env: { INFRA_PRICING: RATES }, rightsizing: rs });
  assert.equal(t.target.rows.find((r) => r.k === "Allocated vCPU").v, "20 (from 32)");
  assert.ok(t.notes.some((n) => /no usable history/.test(n)));
});

test("power, cooling and staff time are excluded on purpose, and it is stated", () => {
  const t = tcoComparison(vms, capacity, { env: { INFRA_PRICING: RATES } });
  assert.ok(t.notes.some((n) => /Power, cooling, rack space, hardware refresh and staff time are deliberately excluded/.test(n)));
});

test("an estate whose hosts were never reported prices nothing and says why", () => {
  const hostless = vms.map((v) => ({ ...v, host: null }));
  const t = tcoComparison(hostless, capacity, { env: { INFRA_PRICING: RATES } });
  assert.equal(t.priced, false);
  assert.match(t.source.rows.find((r) => r.k === "Hosts carrying these VMs").why, /did not report which host/);
});

test("a negative reads as -$77,100, never $-77,100, and the unit is not doubled", () => {
  const t = tcoComparison(vms, capacity, { env: { INFRA_PRICING: RATES } });
  assert.ok(t.saving < 0);
  assert.equal(t.savingLabel, "$40,500 / yr", "the label carries its own unit, once, unsigned");
  assert.equal(t.savingDirection, "more, not less");
  assert.ok(!t.headline.includes("$-"), t.headline);
  assert.match(t.headline, /costs \$40,500 a year MORE/);
  assert.equal(t.source.annualLabel, "$26,700");
});
