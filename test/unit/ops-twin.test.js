import { test } from "node:test";
import assert from "node:assert/strict";
import * as OT from "../../src/services/ops-twin.js";

const CARD = 95830;
// HAMi card ids are hex UUIDs: one per node and index.
const uid = (name, i) => `GPU-${{ tcsaiinode1: "a1", tcsaiinode2: "b2" }[name] || "c3"}0${i}-0000-4000-8000-000000000000`;
const node = (name, { rack, gpus = 0, master = false, cpu = "32", mem = "256Gi", taints = [] } = {}) => ({
  metadata: {
    name,
    labels: { ...(rack ? { "tcs.io/rack": rack } : {}), [master ? "node-role.kubernetes.io/master" : "node-role.kubernetes.io/worker"]: "" , ...(gpus ? { "nvidia.com/gpu.product": "NVIDIA-H100-NVL" } : {}) },
    annotations: gpus ? { "hami.io/node-nvidia-register": Array.from({ length: gpus }, (_, i) => `${uid(name, i)},10,${CARD},100,NVIDIA,0,true:`).join("") } : {},
  },
  spec: { taints: master ? [{ key: "node-role.kubernetes.io/master", effect: "NoSchedule" }, ...taints] : taints },
  status: { allocatable: { cpu, memory: mem }, conditions: [{ type: "Ready", status: "True" }] },
});
let n = 0;
const pod = (ns, nodeName, { owner = ["ReplicaSet", `app-${++n}-5d7f9c8b6`], hash = "5d7f9c8b6", cpu = "500m", mem = "1Gi", gpu = 0, cards = [], labels = {}, model = null, tolerations = [] } = {}) => ({
  metadata: {
    name: `${owner ? owner[1] : "bare"}-${++n}`, namespace: ns,
    labels: { "pod-template-hash": hash, ...labels, ...(model ? { "serving.kserve.io/inferenceservice": model } : {}) },
    annotations: cards.length ? { "hami.io/vgpu-devices-allocated": cards.map(([u, mib]) => `${u},NVIDIA,${mib},30:`).join("") + ";" } : {},
    ownerReferences: owner ? [{ kind: owner[0], name: owner[1], controller: true }] : [],
  },
  spec: { nodeName, tolerations, containers: [{ resources: { requests: { cpu, memory: mem }, limits: gpu ? { "nvidia.com/gpu": String(gpu), "nvidia.com/gpumem": String(cards.reduce((a, c) => a + c[1], 0)) } : {} } }] },
  status: { phase: "Running" },
});

function estate() {
  const nodes = [
    node("master-0", { master: true }),
    node("tcsaiinode1", { rack: "R2", gpus: 2 }), node("tcsaiinode2", { rack: "R3", gpus: 2 }),
    node("worker-03", { rack: "R2" }), node("worker-04", { rack: "R3" }),
  ];
  const pods = [
    pod("openshift-mcp", "tcsaiinode1", { owner: ["ReplicaSet", "llama-3-1-8b-predictor-7c9d8"], hash: "7c9d8", gpu: 1, cards: [[uid("tcsaiinode1", 0), 24576]], model: "llama-3-1-8b", cpu: "4", mem: "32Gi" }),
    pod("openshift-mcp", "tcsaiinode1", { owner: ["ReplicaSet", "bge-m3-predictor-6b5a4"], hash: "6b5a4", gpu: 1, cards: [[uid("tcsaiinode1", 0), 6144]], model: "bge-m3", cpu: "2", mem: "8Gi" }),
    pod("openshift-mcp", "tcsaiinode2", { owner: ["ReplicaSet", "qwen2-5-vl-7b-predictor-4a3b2"], hash: "4a3b2", gpu: 1, cards: [[uid("tcsaiinode2", 0), 24576]], model: "qwen2-5-vl-7b", cpu: "4", mem: "32Gi" }),
    pod("other-team", "tcsaiinode2", { owner: ["ReplicaSet", "trainer-9f8e7"], hash: "9f8e7", gpu: 1, cards: [[uid("tcsaiinode2", 1), 30000]] }),
    pod("payments", "tcsaiinode1", { owner: ["ReplicaSet", "payments-api-55aa1"], hash: "55aa1", labels: { app: "payments-api" } }),
    pod("payments", "worker-03", { owner: ["ReplicaSet", "payments-api-55aa1"], hash: "55aa1", labels: { app: "payments-api" } }),
    pod("openshift-dns", "tcsaiinode1", { owner: ["DaemonSet", "dns-default"] }),
    pod("vms", "tcsaiinode1", { owner: ["VirtualMachineInstance", "payments-db"], labels: { "vm.kubevirt.io/name": "payments-db" }, cpu: "4", mem: "16Gi" }),
    pod("vms", "tcsaiinode1", { owner: ["VirtualMachineInstance", "win2019-ad"], labels: { "vm.kubevirt.io/name": "win2019-ad" }, cpu: "2", mem: "8Gi" }),
  ];
  const vmi = (name, migratable) => ({ metadata: { namespace: "vms", name }, spec: {}, status: { nodeName: "tcsaiinode1", phase: "Running", conditions: [{ type: "LiveMigratable", status: migratable ? "True" : "False" }] } });
  const vm = (name) => ({ metadata: { namespace: "vms", name }, spec: { runStrategy: "Always" } });
  return OT.buildTwin({
    nodes, pods,
    pdbs: [{ metadata: { namespace: "payments", name: "payments-api" }, spec: { minAvailable: 2, selector: { matchLabels: { app: "payments-api" } } }, status: { disruptionsAllowed: 0, currentHealthy: 2, desiredHealthy: 2 } }],
    vmis: [vmi("payments-db", true), vmi("win2019-ad", false)], vms: [vm("payments-db"), vm("win2019-ad")],
    isvcs: [{ metadata: { namespace: "openshift-mcp", name: "gpt-oss-120b", annotations: { "serving.kserve.io/stop": "true" } }, spec: { predictor: { model: { resources: { limits: { "nvidia.com/gpu": "1", "nvidia.com/gpumem": "76000" } } } } } }],
    telemetry: [{ uuid: uid("tcsaiinode1", 0), powerW: 310, tempC: 58 }, { uuid: uid("tcsaiinode1", 1), powerW: 70, tempC: 41 }],
  }, { cluster: "gpu" });
}

test("the twin reads cards, slices, VMs, models and racks", () => {
  const t = estate();
  const g1 = t.nodes.find((x) => x.name === "tcsaiinode1");
  assert.equal(g1.cards.length, 2);
  assert.equal(g1.cards[0].slices.length, 2, "llama and bge-m3 share GPU-0");
  assert.deepEqual(t.racks, { Unassigned: ["master-0"], R2: ["tcsaiinode1", "worker-03"], R3: ["tcsaiinode2", "worker-04"] });
  assert.equal(t.vms.length, 2);
  assert.equal(t.models.find((m) => m.name === "gpt-oss-120b").asleep, true);
  assert.equal(OT.overview(t).counts.gpus, 4);
});

test("drain: models move by GPU memory, VMs migrate or restart, the budget and a sleeper are flagged", () => {
  const r = OT.simulate(estate(), { kind: "drain", node: "tcsaiinode1" });
  const llama = r.moves.find((m) => m.name === "llama-3-1-8b");
  assert.equal(llama.to, "tcsaiinode2");
  assert.equal(llama.card.uuid, uid("tcsaiinode2", 1), "tightest fit: keeps the bigger hole free for a bigger model");
  assert.equal(r.moves.find((m) => m.name === "payments-db").how, "live");
  assert.equal(r.moves.find((m) => m.name === "win2019-ad").how, "restart");
  assert.ok(r.impact.some((i) => /payments-api holds the drain/.test(i.title) && i.fix?.kind === "scale"));
  assert.ok(r.impact.some((i) => /gpt-oss-120b can’t wake/.test(i.title)), "76 GB needed, at most 64 GiB free on one card meanwhile");
  assert.equal(r.verdict.level, "warn");
  assert.equal(r.kpis.gpusInService, "2 / 4");
  assert.equal(r.kpis.powerW, -380);
  assert.ok(!r.moves.some((m) => /dns-default/.test(m.name)), "DaemonSet pods are not moved");
  assert.match(OT.report(r), /Verdict: Safe with \d actions? first/);
});

test("a GPU fails: its models move to another card, others are untouched", () => {
  const r = OT.simulate(estate(), { kind: "gpu-fail", node: "tcsaiinode1", card: uid("tcsaiinode1", 0) });
  const moved = r.moves.filter((m) => m.kind === "model").map((m) => [m.name, m.card?.uuid]);
  assert.equal(moved.length, 2);
  for (const [, card] of moved) assert.notEqual(card, uid("tcsaiinode1", 0));
  assert.equal(r.kpis.gpusInService, "3 / 4");
  assert.equal(r.verdict.level === "crit", false);
});

test("rack loses power: everything in the rack is lost at once and VMs restart, not migrate", () => {
  const r = OT.simulate(estate(), { kind: "rack-fail", rack: "R2" });
  assert.ok(r.view.filter((v) => v.state === "lost").map((v) => v.name).sort().join() === "tcsaiinode1,worker-03");
  assert.ok(r.moves.filter((m) => m.kind === "vm").every((m) => m.how !== "live"));
  // payments-api lost both pods: one item says the budget is broken until they are back.
  assert.ok(r.impact.some((i) => /payments-api drops below its budget/.test(i.title)));
});

test("add a model: it fits on the card with room, or the reason is given", () => {
  const t = estate();
  const ok = OT.simulate(t, { kind: "add-model", gpuGiB: 60, name: "mistral-small" });
  assert.equal(ok.verdict.level, "ok");
  const no = OT.simulate(t, { kind: "add-model", gpuGiB: 95, name: "big" });
  assert.equal(no.verdict.level, "crit");
  assert.match(no.impact.find((i) => i.level === "crit").text, /needs 95 GiB on one card/);
});

test("upgrade checks each worker drain; master taints keep workloads off the control plane", () => {
  const r = OT.simulate(estate(), { kind: "upgrade" });
  assert.equal(r.perNode.length, 4);
  assert.ok(r.perNode.every((s) => s.node !== "master-0"));
  const d = OT.simulate(estate(), { kind: "drain", node: "worker-03" });
  assert.ok(!d.moves.some((m) => m.to === "master-0"), "nothing lands on a tainted master");
});

test("migrating VMs in: fit count and headroom for a node failure", () => {
  const r = OT.simulate(estate(), { kind: "add-vms", count: 20, cpu: 2, memGiB: 8 });
  assert.equal(r.verdict.level === "crit", false);
  const big = OT.simulate(estate(), { kind: "add-vms", count: 200, cpu: 4, memGiB: 32 });
  assert.equal(big.verdict.level, "crit");
});

test("ask the twin: plain questions become scenarios", () => {
  const t = estate();
  assert.deepEqual(OT.parseQuestion(t, "What happens if I drain tcsaiinode1 tonight?"), { kind: "drain", node: "tcsaiinode1" });
  assert.deepEqual(OT.parseQuestion(t, "what if tcsaiinode2 goes down"), { kind: "node-fail", node: "tcsaiinode2" });
  assert.deepEqual(OT.parseQuestion(t, "rack R3 loses power"), { kind: "rack-fail", rack: "R3" });
  assert.equal(OT.parseQuestion(t, "can we add a model that needs 40 GiB").kind, "add-model");
  assert.equal(OT.parseQuestion(t, "is the upgrade safe").kind, "upgrade");
  assert.equal(OT.parseQuestion(t, "hello"), null);
});

test("quantities and selectors", () => {
  assert.equal(OT.cpuMilli("250m"), 250); assert.equal(OT.cpuMilli("2"), 2000);
  assert.equal(OT.memMiB("2Gi"), 2048); assert.equal(OT.memMiB("1G"), 954);
  assert.equal(OT.selectorMatches({ matchExpressions: [{ key: "app", operator: "In", values: ["a"] }] }, { app: "a" }), true);
  assert.equal(OT.selectorMatches({ matchLabels: { app: "b" } }, { app: "a" }), false);
});

test("risk score: verdict, findings and production raise it; levels map to ServiceNow", () => {
  const t = estate();
  const drain = OT.simulate(t, { kind: "drain", node: "tcsaiinode1" });
  const r = OT.computeRisk(drain, { cluster: "gpu" });
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(["Low", "Medium", "High"].includes(r.level));
  assert.ok(r.reasons.length >= 1);
  const prod = OT.computeRisk(drain, { cluster: "payments-prod" });
  assert.ok(prod.score > r.score, "production adds risk");
  const safe = OT.simulate(t, { kind: "drain", node: "worker-04" });
  assert.ok(OT.computeRisk(safe, { cluster: "lab" }).score <= r.score);
  assert.equal(OT.computeRisk({ ...drain, verdict: { level: "crit", title: "x" } }, { cluster: "prod-1" }).level, "High");
});

test("site fails, and critical single replicas become outages", () => {
  const t = estate();
  t.sites = { "DC-East": ["tcsaiinode1", "worker-03"] };
  const out = OT.simulate(t, { kind: "site-fail", site: "DC-East" });
  assert.equal(out.scenario.subject, "site DC-East");
  assert.throws(() => OT.simulate(t, { kind: "site-fail", site: "Mars" }), /No site/);
  const plain = OT.simulate(t, { kind: "drain", node: "tcsaiinode2" });
  const crit = OT.simulate(t, { kind: "drain", node: "tcsaiinode2", critical: "other-team" });
  assert.ok(crit.impact.some((i) => /critical app/.test(i.title)));
  assert.ok(["crit"].includes(crit.verdict.level) || crit.impact.filter((i) => i.level === "crit").length > plain.impact.filter((i) => i.level === "crit").length);
});

test("peak load: extra replicas placed, shortfall gives nodes needed", () => {
  const t = estate();
  const ok = OT.simulate(t, { kind: "peak", namespaces: ["payments"], factor: 2 });
  assert.equal(ok.scenario.kind, "peak");
  assert.ok(ok.kpis.moves >= 1);
  const big = OT.simulate(t, { kind: "peak", namespaces: "payments", factor: 10 });
  assert.ok(big.kpis.moves + big.kpis.cannotMove >= 18);
  assert.throws(() => OT.simulate(t, { kind: "peak", namespaces: "payments", factor: 50 }), /between/);
});

test("maintenance window: nodes scheduled into the hours given", () => {
  const t = estate();
  const w = OT.simulate(t, { kind: "window", windowHours: 1 });
  assert.equal(w.window.hours, 1);
  assert.ok(w.window.schedule.length === 4);
  assert.ok(w.window.windowsNeeded >= 1);
  assert.ok(w.plan.length === 4);
});

test("retire nodes: savings and verdict", () => {
  const t = estate();
  const r = OT.simulate(t, { kind: "retire", nodes: "worker-04" });
  assert.equal(r.savings.nodes, 1);
  assert.ok(r.savings.kwhMonth > 0);
  assert.equal(r.savings.money, null);
});

test("blast radius of a node and of a service account", () => {
  const t = estate();
  t.saBindings = [{ ns: "payments", sa: "default", role: "cluster-admin", scope: "cluster" }];
  for (const p of t.pods) p.sa = p.sa || "default";
  const n = OT.simulate(t, { kind: "blast", node: "tcsaiinode1" });
  assert.equal(n.verdict.level, "crit");
  assert.ok(n.plan.some((x) => /Rotate/.test(x.text)));
  const sa = OT.simulate(t, { kind: "blast", serviceAccount: "payments/default" });
  assert.ok(sa.impact.some((i) => /Full control/.test(i.title)));
  const none = OT.simulate(t, { kind: "blast", serviceAccount: "other-team/builder" });
  assert.notEqual(none.verdict.level, "crit");
});

test("DR failover between two clusters, and N+1 resilience", () => {
  const src = estate(), dst = estate();
  dst.cluster = "dr";
  const f = OT.failover(OT.exportTwin(src), dst, {});
  assert.equal(f.scenario.subject, "gpu → dr");
  assert.ok(f.kpis.moves > 0);
  const small = { ...dst, nodes: dst.nodes.filter((x) => x.name === "master-0" || x.name === "worker-04"), pods: [] };
  const g = OT.failover(src, small, { critical: "payments" });
  assert.notEqual(g.verdict.level, "ok");
  const r = OT.resilience(src);
  assert.equal(r.workers, 4);
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(r.per.length, 4);
});

test("accuracy: a drain prediction is scored once the node is drained", () => {
  const before = estate();
  const out = OT.simulate(before, { kind: "drain", node: "worker-03" });
  const pred = { node: "worker-03", moves: out.moves.filter((m) => m.to && m.kind !== "vm").map((m) => ({ ns: m.ns, workload: m.workload || m.name, to: m.to })) };
  assert.ok(pred.moves.length >= 1);
  assert.equal(OT.scorePrediction(pred, before), null, "not drained yet");
  const after = estate();
  const target = pred.moves[0].to;
  for (const p of after.pods) if (p.node === "worker-03") p.node = target;
  after.nodes.find((x) => x.name === "worker-03").schedulable = false;
  const s = OT.scorePrediction(pred, after);
  assert.ok(s.landed >= 1);
  assert.equal(s.placementPct, 100);
});

test("ask the twin: windows, peaks and blast radius", () => {
  const t = estate();
  assert.deepEqual(OT.parseQuestion(t, "patch everything in a 4 hour window"), { kind: "window", windowHours: 4 });
  const p = OT.parseQuestion(t, "can payments take 3x traffic on sale day?");
  assert.equal(p.kind, "peak"); assert.equal(p.factor, 3); assert.deepEqual(p.namespaces, ["payments"]);
  assert.deepEqual(OT.parseQuestion(t, "what if worker-04 is compromised"), { kind: "blast", node: "worker-04" });
});
