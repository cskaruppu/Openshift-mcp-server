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
  assert.deepEqual(c, { vcpu: 48, gpus: 0, migSlices: 0, gpuModel: null, gpuModels: null });
});

test("2× H100 with GPU 1 split by MIG still counts two physical GPUs, plus the slices", () => {
  const c = C.computeFromNodes([
    node({ cpu: "128", "nvidia.com/gpu": "1", "nvidia.com/mig-3g.40gb": "1", "nvidia.com/mig-2g.20gb": "1", "nvidia.com/mig-1g.10gb": "2" },
      { "nvidia.com/gpu.product": "NVIDIA-H100-80GB-HBM3", "nvidia.com/gpu.count": "2" }),
    node({ cpu: "32" }), node({ cpu: "32" }),
  ]);
  assert.deepEqual(c, { vcpu: 192, gpus: 2, migSlices: 4, gpuModel: "H100", gpuModels: null });
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
    const c = await run();
    assert.equal(c.cpuPct, 25, "12 of 48 cores");
    assert.equal(c.gpuPct, null);
    assert.ok(!seen.some((u) => /prometheus|thanos|query/i.test(u)), "no GPU metrics query on a CPU-only cluster");
    const n = seen.length;
    await run();
    assert.equal(seen.length, n, "second call within 20 s is served from the cache");
  } finally { srv.close(); }
});

test("no metrics API: CPU % is null, not a guess", async () => {
  const srv = http.createServer((q, r) => { r.statusCode = 404; r.end("{}"); });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  try {
    C._resetComputeCache();
    const c = await withRemoteCluster(`http://127.0.0.1:${srv.address().port}`, "t", () => C.clusterCompute([node({ cpu: "8" })], { cacheKey: "y" }));
    assert.equal(c.vcpu, 8);
    assert.equal(c.cpuPct, null);
  } finally { srv.close(); }
});
