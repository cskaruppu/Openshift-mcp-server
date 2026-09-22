import { test } from "node:test";
import assert from "node:assert/strict";
import { vcenterConfig, soapEnvelope, xmlEscape } from "../../src/utils/vcenter-client.js";
import { shapeAssociations, applyTags } from "../../src/services/vcenter-tags.js";
import {
  intervalForWindow, buildQueryPerfBody, parseCounterIds, parsePerfResponse, toSamples,
  COUNTERS, DEFAULT_MHZ_PER_CORE,
} from "../../src/services/vcenter-perf.js";
import { rightSize } from "../../src/services/rightsizing.js";

// ── Configuration ──────────────────────────────────────────────────────────

test("a missing or half-filled vCenter credential is refused with a usable reason", () => {
  assert.equal(vcenterConfig({}).configured, false);
  assert.match(vcenterConfig({}).reason, /VCENTER_URL, VCENTER_USERNAME and VCENTER_PASSWORD/);
  assert.equal(vcenterConfig({ VCENTER_URL: "https://vc", VCENTER_USERNAME: "u" }).configured, false);
  // Plain http would put the credential on the wire in clear.
  assert.match(vcenterConfig({ VCENTER_URL: "http://vc", VCENTER_USERNAME: "u", VCENTER_PASSWORD: "p" }).reason, /must be an https/);

  const ok = vcenterConfig({ VCENTER_URL: "https://vc.local/", VCENTER_USERNAME: "u", VCENTER_PASSWORD: "p" });
  assert.equal(ok.configured, true);
  assert.equal(ok.url, "https://vc.local", "a trailing slash would double up in every path");
  assert.equal(ok.insecure, false, "certificate checking stays on unless explicitly disabled");
});

test("values going into SOAP are escaped, because they come from vCenter", () => {
  assert.equal(xmlEscape(`a<b>&"c'`), "a&lt;b&gt;&amp;&quot;c&apos;");
  assert.match(soapEnvelope("<X/>"), /<soapenv:Body><X\/><\/soapenv:Body>/);
});

// ── Tags ───────────────────────────────────────────────────────────────────

const tagIndex = new Map([
  ["t1", { name: "payments", category_id: "c1" }],
  ["t2", { name: "p.raghavan", category_id: "c2" }],
  ["t3", { name: "production", category_id: null }],
]);
const catIndex = new Map([["c1", "app"], ["c2", "owner"]]);

test("vAPI associations become the category/name pairs declaredApp reads", () => {
  const out = shapeAssociations([
    { object_id: { id: "vm-101", type: "VirtualMachine" }, tag_ids: ["t1", "t2"] },
    { object_id: { id: "vm-102", type: "VirtualMachine" }, tag_ids: ["t3"] },
    { object_id: { id: "vm-103", type: "VirtualMachine" }, tag_ids: [] },
  ], tagIndex, catIndex);

  assert.deepEqual(out.get("vm-101"), [{ category: "app", name: "payments" }, { category: "owner", name: "p.raghavan" }]);
  // An uncategorised tag keeps its name rather than being dropped.
  assert.deepEqual(out.get("vm-102"), [{ category: null, name: "production" }]);
  // Asked and genuinely has none — which is not the same as never asked.
  assert.deepEqual(out.get("vm-103"), []);
});

test("a machine vCenter did not answer for keeps 'not reported', not an empty list", () => {
  const vms = [{ name: "a", id: "vm-101", tags: null }, { name: "b", id: "vm-999", tags: null }];
  const byId = shapeAssociations([{ object_id: { id: "vm-101" }, tag_ids: ["t1"] }], tagIndex, catIndex);
  const { vms: out, tagged, answered } = applyTags(vms, byId);

  assert.deepEqual(out[0].tags, [{ category: "app", name: "payments" }]);
  assert.equal(out[1].tags, null, "silence is reported as silence, never as 'no tags'");
  assert.equal(tagged, 1);
  assert.equal(answered, 1);
});

test("an unknown tag id is skipped rather than producing a nameless group", () => {
  const out = shapeAssociations([{ object_id: { id: "vm-1" }, tag_ids: ["t1", "ghost"] }], tagIndex, catIndex);
  assert.deepEqual(out.get("vm-1"), [{ category: "app", name: "payments" }]);
});

// ── Performance ────────────────────────────────────────────────────────────

test("the rollup interval follows the window, because vCenter does not keep 5-minute data for a month", () => {
  assert.equal(intervalForWindow(1), 300);
  assert.equal(intervalForWindow(7), 1800);
  assert.equal(intervalForWindow(30), 7200);
  assert.equal(intervalForWindow(90), 86400);
});

test("the QueryPerf body asks for both counters, per entity, over the window", () => {
  const body = buildQueryPerfBody({ perfManager: "PerfMgr", entities: ["vm-1", "vm-2"], counterIds: [6, 24], days: 30 });
  assert.equal((body.match(/<querySpec>/g) || []).length, 2, "one spec per machine");
  assert.match(body, /<entity type="VirtualMachine">vm-1<\/entity>/);
  assert.match(body, /<counterId>6<\/counterId>/);
  assert.match(body, /<counterId>24<\/counterId>/);
  assert.match(body, /<intervalId>7200<\/intervalId>/);
});

test("counter ids are resolved by name, because the numbers move between versions", () => {
  const xml = `
    <PerfCounterInfo><key>6</key>
      <nameInfo><key>usagemhz</key></nameInfo><groupInfo><key>cpu</key></groupInfo><rollupType>average</rollupType>
    </PerfCounterInfo>
    <PerfCounterInfo><key>24</key>
      <nameInfo><key>active</key></nameInfo><groupInfo><key>mem</key></groupInfo><rollupType>average</rollupType>
    </PerfCounterInfo>
    <PerfCounterInfo><key>99</key>
      <nameInfo><key>usage</key></nameInfo><groupInfo><key>cpu</key></groupInfo><rollupType>maximum</rollupType>
    </PerfCounterInfo>`;
  assert.deepEqual(parseCounterIds(xml), { cpu: 6, memory: 24 });
  assert.equal(COUNTERS.cpu, "cpu.usagemhz.average");
  assert.equal(COUNTERS.memory, "mem.active.average", "active, not consumed — consumed includes memory the guest stopped using");
  assert.deepEqual(parseCounterIds("<nothing/>"), {}, "an unrecognisable answer yields no ids, not wrong ones");
});

test("a QueryPerf response parses per entity, and -1 gaps never become zeroes", () => {
  // The real wire format: one <value> element per sample inside a
  // PerfMetricIntSeries — not the comma-separated string pyVmomi prints.
  const xml = `
    <returnval xsi:type="PerfEntityMetric">
      <entity type="VirtualMachine">vm-1</entity>
      <sampleInfo><interval>7200</interval><timestamp>2026-09-22T00:00:00Z</timestamp></sampleInfo>
      <value xsi:type="PerfMetricIntSeries">
        <id><counterId>6</counterId><instance></instance></id>
        <value>1200</value><value>2400</value><value>-1</value><value>3600</value>
      </value>
      <value xsi:type="PerfMetricIntSeries">
        <id><counterId>24</counterId><instance></instance></id>
        <value>1048576</value><value>2097152</value>
      </value>
    </returnval>
    <returnval xsi:type="PerfEntityMetric">
      <entity type="VirtualMachine">vm-2</entity>
      <value xsi:type="PerfMetricIntSeries">
        <id><counterId>6</counterId><instance></instance></id>
        <value>600</value>
      </value>
    </returnval>`;
  const out = parsePerfResponse(xml, { cpu: 6, memory: 24 });

  assert.deepEqual(out.get("vm-1").cpu, [1200, 2400, 3600], "-1 means 'no sample', and averaging it in drags a busy machine towards idle");
  assert.deepEqual(out.get("vm-1").memory, [1048576, 2097152]);
  assert.deepEqual(out.get("vm-2").cpu, [600]);
  assert.deepEqual(out.get("vm-2").memory, []);
  assert.equal(out.size, 2);
});

test("a counter we did not ask for is ignored rather than mixed into another series", () => {
  const xml = `<returnval><entity type="VirtualMachine">vm-1</entity>
    <value><id><counterId>6</counterId></id><value>1200</value></value>
    <value><id><counterId>777</counterId></id><value>99999</value></value>
    <value><id><counterId>24</counterId></id><value>1048576</value></value></returnval>`;
  const out = parsePerfResponse(xml, { cpu: 6, memory: 24 });
  assert.deepEqual(out.get("vm-1").cpu, [1200], "the unknown counter's sample must not land in cpu");
  assert.deepEqual(out.get("vm-1").memory, [1048576]);
});

test("MHz becomes cores and KB becomes GiB, at the host's real clock", () => {
  const s = toSamples({ cpu: [2400, 1200], memory: [1048576, 2097152] }, { mhzPerCore: 2400, windowDays: 30 });
  assert.deepEqual(s.cpu, [1, 0.5]);
  assert.deepEqual(s.memory, [1, 2]);
  assert.equal(s.windowDays, 30);

  // A faster host means the same MHz is fewer cores. Getting this wrong would
  // mis-size every machine on that host by the ratio of the two clocks.
  assert.deepEqual(toSamples({ cpu: [3600], memory: [] }, { mhzPerCore: 3600 }).cpu, [1]);
  assert.deepEqual(toSamples({ cpu: [2400], memory: [] }, { mhzPerCore: 0 }).cpu, [2400 / DEFAULT_MHZ_PER_CORE]);
});

test("vCenter samples feed straight into a right-sizing verdict", () => {
  // 200 two-hour samples at 2.8 cores and 11 GiB — a month of a quiet machine.
  const raw = { cpu: Array(200).fill(2.8 * 2400), memory: Array(200).fill(11 * 1024 * 1024) };
  const samples = toSamples(raw, { mhzPerCore: 2400, windowDays: 30 });
  const r = rightSize({ name: "redhat3", cpuCount: 24, memoryGiB: 64 }, samples);

  assert.equal(r.verdict, "oversized");
  assert.deepEqual(r.recommended, { cpuCount: 4, memoryGiB: 14 });
  assert.ok(r.evidence.some((e) => /over 30 days \(200 samples\)/.test(e)));
});
