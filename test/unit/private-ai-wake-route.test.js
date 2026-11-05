import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as R from "../../src/services/private-ai/router.js";

test("a deep question while the reasoning model sleeps: answered by the fast one, the reasoning one woken", async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"data":[]}'); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const woken = [];
  try {
    R.setFleetProvider({ models: () => [
      { model: "llama-3-1-8b", role: "small", cluster: "gpu", url: `http://127.0.0.1:${port}` },
      { model: "gpt-oss-120b", role: "large", cluster: "gpu", url: "http://127.0.0.1:1", stopped: true },
    ], preferred: () => "gpu" });
    // Without auto-sleep the stopped model is invisible: the router never wants "large".
    R.setSleepHooks({ wakeable: () => false, wakeFor: () => null, noteUse: () => {} });
    assert.ok(!R.models().some((m) => m.model === "gpt-oss-120b"));
    R.setSleepHooks({ wakeable: (_c, m) => m === "gpt-oss-120b", wakeFor: (role) => { woken.push(role); return { model: "gpt-oss-120b", lastWakeSeconds: 240 }; }, noteUse: () => {} });
    const { decision } = await R.route({ provider: "private" }, [{ role: "user", content: "Why is payments-api restarting? Find the root cause." }], { useCase: "ai-chat" });
    assert.equal(decision.wanted, "large");
    assert.equal(decision.model, "llama-3-1-8b");
    assert.deepEqual(decision.waking, { model: "gpt-oss-120b", role: "large", lastWakeSeconds: 240 });
    assert.match(decision.reason, /gpt-oss-120b is waking from auto-sleep \(about 4 min\), answered by llama-3-1-8b meanwhile/);
    assert.deepEqual(woken, ["large"]);
  } finally {
    srv.close();
    R.setFleetProvider({ models: () => [] });
    R.setSleepHooks({ wakeable: () => false, wakeFor: () => null, noteUse: () => {} });
  }
});
