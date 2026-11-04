import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHamiRegister, parseHamiAllocation } from "../../src/tools/gpu-metrics.js";

test("HAMi's node register gives the physical cards (colon list and JSON)", () => {
  const old = "GPU-aaa1,10,95830,100,NVIDIA-NVIDIA H100 NVL,0,true:GPU-bbb2,10,95830,100,NVIDIA-NVIDIA H100 NVL,0,true:";
  assert.deepEqual(parseHamiRegister(old).map((c) => [c.uuid, c.splits, c.mib]), [["GPU-aaa1", 10, 95830], ["GPU-bbb2", 10, 95830]]);
  const json = JSON.stringify([{ id: "GPU-aaa1", count: 10, devmem: 95830 }, { id: "GPU-bbb2", count: 10, devmem: 95830 }]);
  assert.equal(parseHamiRegister(json).length, 2);
  assert.deepEqual(parseHamiRegister(undefined), []);
});

test("HAMi's pod record gives the card and the memory slice", () => {
  assert.deepEqual(parseHamiAllocation("GPU-aaa1,NVIDIA,24576,0:;"), [{ uuid: "GPU-aaa1", mib: 24576 }]);
  assert.deepEqual(parseHamiAllocation("GPU-aaa1,NVIDIA,6144,0:;GPU-bbb2,NVIDIA,1024,0:;").map((x) => x.uuid), ["GPU-aaa1", "GPU-bbb2"]);
  assert.deepEqual(parseHamiAllocation(""), []);
});
