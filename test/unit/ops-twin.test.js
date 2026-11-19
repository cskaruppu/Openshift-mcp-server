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
