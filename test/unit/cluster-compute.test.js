/**
 * CPU / GPU detection for the cluster cards (services/cluster-compute.js).
 * Run with: node --test test/unit/cluster-compute.test.js
 */
import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";

const C = await import("../../src/services/cluster-compute.js");
const { withRemoteCluster } = await import("../../src/utils/openshift-client.js");

const node = (cap, labels = {}) => ({ metadata: { labels }, status: { capacity: cap } });

test("CPU quantities in every unit Kubernetes uses", () => {
  assert.equal(C.parseCores("2"), 2);
  assert.equal(C.parseCores("250m"), 0.25);
  assert.equal(C.parseCores("1500000n"), 0.0015);
  assert.equal(C.parseCores("750u"), 0.00075);
  assert.equal(C.parseCores(undefined), 0);
});

test("GPU model names come out short and readable", () => {
  assert.equal(C.shortGpuModel("NVIDIA-H100-80GB-HBM3"), "H100");
  assert.equal(C.shortGpuModel("NVIDIA-A100-SXM4-40GB"), "A100");
  assert.equal(C.shortGpuModel("Tesla-T4"), "T4");
  assert.equal(C.shortGpuModel("NVIDIA-L40S"), "L40S");
  assert.equal(C.shortGpuModel(""), null);
});

test("a CPU-only cluster: vCPU summed, no GPUs", () => {
  const c = C.computeFromNodes([node({ cpu: "16" }), node({ cpu: "16" }), node({ cpu: "16" })]);
  assert.deepEqual(c, { vcpu: 48, gpus: 0, migSlices: 0, shared: false, gpuModel: null, gpuModels: null, gpuVendor: null, cpuVendor: null, cpuFamily: null, arch: null });
});

test("2× H100 with GPU 1 split by MIG still counts two physical GPUs, plus the slices", () => {
  const c = C.computeFromNodes([
    node({ cpu: "128", "nvidia.com/gpu": "1", "nvidia.com/mig-3g.40gb": "1", "nvidia.com/mig-2g.20gb": "1", "nvidia.com/mig-1g.10gb": "2" },
      { "nvidia.com/gpu.product": "NVIDIA-H100-80GB-HBM3", "nvidia.com/gpu.count": "2" }),
    node({ cpu: "32" }), node({ cpu: "32" }),
  ]);
  assert.deepEqual(c, { vcpu: 192, gpus: 2, migSlices: 4, shared: false, gpuModel: "H100", gpuModels: null, gpuVendor: "NVIDIA", cpuVendor: null, cpuFamily: null, arch: null });
});

test("time-slicing: 2 cards shared 20 ways are advertised as 40 GPUs, but are 2× H100", () => {
  const withLabel = C.computeFromNodes([node({ cpu: "128", "nvidia.com/gpu": "40" },
    { "nvidia.com/gpu.product": "NVIDIA-H100-80GB-HBM3-SHARED", "nvidia.com/gpu.count": "2", "nvidia.com/gpu.replicas": "20" })]);
  assert.deepEqual([withLabel.gpus, withLabel.gpuModel, withLabel.shared], [2, "H100", true]);
  const noCountLabel = C.computeFromNodes([node({ cpu: "128", "nvidia.com/gpu": "40" }, { "nvidia.com/gpu.product": "NVIDIA-H100-80GB-HBM3", "nvidia.com/gpu.replicas": "20" })]);
  assert.equal(noCountLabel.gpus, 2);
});

test("mixed GPU models are listed per model, the most common first", () => {
  const c = C.computeFromNodes([
    node({ cpu: "8", "nvidia.com/gpu": "4" }, { "nvidia.com/gpu.product": "NVIDIA-L40S" }),
    node({ cpu: "8", "nvidia.com/gpu": "1" }, { "nvidia.com/gpu.product": "Tesla-T4" }),
  ]);
  assert.equal(c.gpuModel, "L40S");
  assert.deepEqual(c.gpuModels, { L40S: 4, T4: 1 });
});

test("CPU % from the metrics API; a CPU-only cluster never asks for GPU metrics; the result is cached", async () => {
  const seen = [];
  const srv = http.createServer((q, r) => {
    seen.push(q.url);
    r.setHeader("content-type", "application/json");
    if (q.url === "/apis/metrics.k8s.io/v1beta1/nodes") return r.end(JSON.stringify({ items: [{ usage: { cpu: "6000m" } }, { usage: { cpu: "4" } }, { usage: { cpu: "2000000000n" } }] }));
    r.statusCode = 404; r.end("{}");
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  try {
    C._resetComputeCache();
    const nodes = [node({ cpu: "16" }), node({ cpu: "16" }), node({ cpu: "16" })];
    const run = () => withRemoteCluster(`http://127.0.0.1:${srv.address().port}`, "t", () => C.clusterCompute(nodes, { cacheKey: "x" }));
    const first = await run();
    assert.equal(first.cpuPct, null, "the summary does not wait for the measurement");
    await withRemoteCluster(`http://127.0.0.1:${srv.address().port}`, "t", () => C._settleLive("x"));
    const c = await run();
    assert.equal(c.cpuPct, 25, "12 of 48 cores, from the background measurement");
    assert.equal(c.gpuPct, null);
    assert.ok(!seen.some((u) => /prometheus|thanos|query/i.test(u)), "no GPU metrics query on a CPU-only cluster");
    const n = seen.length;
    await run();
    assert.equal(seen.length, n, "within 20 s no new measurement is started");
  } finally { srv.close(); }
});

test("no metrics API: CPU % is null, not a guess", async () => {
  const srv = http.createServer((q, r) => { r.statusCode = 404; r.end("{}"); });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  try {
    C._resetComputeCache();
    const url = `http://127.0.0.1:${srv.address().port}`;
    await withRemoteCluster(url, "t", async () => { await C.clusterCompute([node({ cpu: "8" })], { cacheKey: "y" }); await C._settleLive("y"); });
    const c = await withRemoteCluster(url, "t", () => C.clusterCompute([node({ cpu: "8" })], { cacheKey: "y" }));
    assert.equal(c.vcpu, 8);
    assert.equal(c.cpuPct, null);
  } finally { srv.close(); }
});

test("vendors: GPU from the resource name, CPU from NFD, else the architecture", () => {
  const nvidia = C.computeFromNodes([node({ cpu: "64", "nvidia.com/gpu": "2" }, { "feature.node.kubernetes.io/cpu-model.vendor_id": "Intel", "kubernetes.io/arch": "amd64" })]);
  assert.deepEqual([nvidia.gpuVendor, nvidia.cpuVendor, nvidia.arch], ["NVIDIA", "Intel", "x86-64"]);
  const amd = C.computeFromNodes([node({ cpu: "64", "amd.com/gpu": "8" }, { "feature.node.kubernetes.io/cpu-model.vendor_id": "AMD" })]);
  assert.deepEqual([amd.gpuVendor, amd.cpuVendor], ["AMD", "AMD"]);
  const intelGpu = C.computeFromNodes([node({ cpu: "32", "gpu.intel.com/i915": "1" })]);
  assert.equal(intelGpu.gpuVendor, "Intel");
  const migOnly = C.computeFromNodes([node({ cpu: "32", "nvidia.com/mig-1g.10gb": "7" }, { "nvidia.com/gpu.count": "1" })]);
  assert.equal(migOnly.gpuVendor, "NVIDIA", "a fully MIG-split card is still NVIDIA");
  const noNfd = C.computeFromNodes([{ metadata: { labels: {} }, status: { capacity: { cpu: "16" }, nodeInfo: { architecture: "arm64" } } }]);
  assert.deepEqual([noNfd.cpuVendor, noNfd.arch, noNfd.gpuVendor], [null, "Arm64", null]);
});

test("CPU family from the local CPU, only when its vendor agrees with the nodes", () => {
  assert.deepEqual(C.parseCpuModel("Intel(R) Xeon(R) Gold 6430"), { vendor: "Intel", family: "Xeon" });
  assert.deepEqual(C.parseCpuModel("AMD EPYC 9654 96-Core Processor"), { vendor: "AMD", family: "EPYC" });
  assert.deepEqual(C.parseCpuModel("QEMU Virtual CPU version 2.5+"), { vendor: null, family: null });
  const base = { cpuVendor: "Intel", arch: "x86-64" };
  assert.equal(C.withCpuFamily(base, { vendor: "Intel", family: "Xeon" }).cpuFamily, "Xeon");
  assert.equal(C.withCpuFamily(base, { vendor: "AMD", family: "EPYC" }).cpuFamily, undefined, "a different vendor is not trusted");
  const noNfd = C.withCpuFamily({ cpuVendor: null, arch: "x86-64" }, { vendor: "AMD", family: "EPYC" });
  assert.deepEqual([noNfd.cpuVendor, noNfd.cpuFamily], ["AMD", "EPYC"]);
});

test("a slow GPU cluster never slows the summary down", async () => {
  const srv = http.createServer((q, r) => { setTimeout(() => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ items: [] })); }, 3000); });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  try {
    C._resetComputeCache();
    const t0 = Date.now();
    const c = await withRemoteCluster(`http://127.0.0.1:${srv.address().port}`, "t", () =>
      C.clusterCompute([node({ cpu: "64", "nvidia.com/gpu": "2" }, { "nvidia.com/gpu.product": "NVIDIA-H100-80GB-HBM3" })], { cacheKey: "slow" }));
    assert.ok(Date.now() - t0 < 500, `returned in ${Date.now() - t0} ms`);
    assert.deepEqual([c.gpus, c.gpuVendor, c.gpuModel, c.gpuPct], [2, "NVIDIA", "H100", null]);
  } finally { srv.close(); }
});

test("what the cluster runs on is looked up in the background and appears on the next summary", async () => {
  const srv = http.createServer((q, r) => {
    r.setHeader("content-type", "application/json");
    if (q.url === "/apis/config.openshift.io/v1/infrastructures/cluster") return r.end(JSON.stringify({ status: { platformStatus: { type: "VSphere" } } }));
    r.statusCode = 404; r.end("{}");
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  try {
    C._resetComputeCache();
    const url = `http://127.0.0.1:${srv.address().port}`;
    const run = () => withRemoteCluster(url, "t", () => C.clusterCompute([node({ cpu: "8" })], { cacheKey: "vs" }));
    assert.equal((await run()).infra, null, "not waited for");
    await withRemoteCluster(url, "t", () => C._settleLive("vs"));
    assert.equal((await run()).infra?.name, "VMware vSphere");
  } finally { srv.close(); }
});
