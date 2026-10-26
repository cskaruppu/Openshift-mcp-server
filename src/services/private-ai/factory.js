// Private AI Factory floor: what the GPUs, the models on them and the guardrails
// are doing right now. Read only when the Factory floor tab is open, from the
// sources that already exist:
//
//   GPU cards    DCGM through the GPU cluster's monitoring (tools/gpu-metrics.js)
//   GPU slices   HAMi's per-pod allocation annotation (which pod owns how many MiB of which card)
//   models       each model's own /metrics (vLLM, Text Embeddings Inference)
//   energy       DCGM's per-card energy counter, since the session started
//   traffic      the router's log and guardrail counters
//
//   PRIVATE_AI_CLOUD_PRICE_PER_MTOK   cloud price per million tokens for "saved vs cloud" (default 5)
//   PRIVATE_AI_GRID_KG_PER_KWH        grid carbon intensity for CO2e (default 0.4)
//   PRIVATE_AI_MODELS_NAMESPACE       where the InferenceServices live on the GPU cluster (default openshift-mcp)

import { lanFetch } from "../../utils/lan-dns.js";
import * as router from "./router.js";
import { embeddingModel } from "./embeddings.js";

const MODELS_NS = () => process.env.PRIVATE_AI_MODELS_NAMESPACE || "openshift-mcp";
const PRICE = () => { const n = Number(process.env.PRIVATE_AI_CLOUD_PRICE_PER_MTOK); return Number.isFinite(n) && n > 0 ? n : 5; };
const GRID = () => { const n = Number(process.env.PRIVATE_AI_GRID_KG_PER_KWH); return Number.isFinite(n) && n >= 0 ? n : 0.4; };
const HISTORY = 40;

let _deps = { runForCluster: (_c, fn) => fn(), gpu: null, prom: null, ocp: null };
export function configureFactory(deps) { _deps = { ..._deps, ...deps }; }

/* ─────────────────────────── Prometheus text ─────────────────────────── */

/** Parse Prometheus exposition text into [{ name, labels, value }]. */
export function parseMetrics(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line || line[0] === "#") continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+([-+0-9.eE]+|NaN|\+Inf|-Inf)/);
    if (!m) continue;
    const labels = {};
    if (m[3]) for (const p of m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[p[1]] = p[2];
    out.push({ name: m[1], labels, value: Number(m[4]) });
  }
  return out;
}
const sum = (ms, ...names) => {
  for (const n of names) { const hit = ms.filter((x) => x.name === n); if (hit.length) return hit.reduce((s, x) => s + (Number.isFinite(x.value) ? x.value : 0), 0); }
  return null;
};

/* ─────────────────────────── per-model metrics ─────────────────────────── */

const _prev = new Map(); // url → { at, gen, ttftSum, ttftCount, reqSum, reqCount }

async function scrape(m) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await lanFetch(`${m.url}/metrics`, { signal: ctl.signal, headers: process.env.PRIVATE_AI_API_KEY ? { Authorization: `Bearer ${process.env.PRIVATE_AI_API_KEY}` } : {} });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { metrics: parseMetrics(await r.text()) };
  } catch (e) { return { error: e?.name === "AbortError" ? "timed out" : e.message }; }
  finally { clearTimeout(t); }
}

/** First-token time, tokens/s and load for one model, from the change since the last read. */
export function modelStats(ms, prev, now = Date.now()) {
  const cur = {
    at: now,
    gen: sum(ms, "vllm:generation_tokens_total", "vllm:generation_tokens"),
    ttftSum: sum(ms, "vllm:time_to_first_token_seconds_sum"), ttftCount: sum(ms, "vllm:time_to_first_token_seconds_count"),
    reqSum: sum(ms, "te_request_duration_sum", "te_request_inference_duration_sum"), reqCount: sum(ms, "te_request_duration_count", "te_request_count"),
  };
  const dt = prev ? (now - prev.at) / 1000 : 0;
  const d = (k) => (prev && cur[k] != null && prev[k] != null && cur[k] >= prev[k] ? cur[k] - prev[k] : null);
  const ttft = d("ttftCount") ? d("ttftSum") / d("ttftCount") : (cur.ttftCount ? cur.ttftSum / cur.ttftCount : null);
  const req = d("reqCount") ? d("reqSum") / d("reqCount") : (cur.reqCount ? cur.reqSum / cur.reqCount : null);
  const cache = sum(ms, "vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc");
  return {
    cur,
    stats: {
      ttftMs: ttft != null ? Math.round(ttft * 1000) : req != null ? Math.round(req * 1000) : null,
      tokensPerSec: dt > 0 && d("gen") != null ? Math.round(d("gen") / dt) : null,
      running: sum(ms, "vllm:num_requests_running", "te_queue_size"),
      waiting: sum(ms, "vllm:num_requests_waiting"),
      kvCachePct: cache != null ? Math.round(cache * (cache <= 1 ? 100 : 1)) : null,
      tokensTotal: cur.gen,
    },
  };
}

async function modelsNow() {
  const list = [...router.models(), ...(embeddingModel() ? [embeddingModel()] : [])];
  return Promise.all(list.map(async (m) => {
    const [h, s] = await Promise.all([router.checkHealth(m), scrape(m)]);
    let stats = null;
    if (s.metrics) { const r = modelStats(s.metrics, _prev.get(m.url)); _prev.set(m.url, r.cur); stats = r.stats; }
    return { role: m.role, label: m.label, model: m.model, gpu: m.gpu, ready: !!h.ok, healthMs: h.ms, error: h.ok ? null : h.error, metricsError: s.error || null, stats };
  }));
}

/* ─────────────────────────── GPU floor (DCGM + HAMi) ─────────────────────────── */

/** HAMi's allocation annotation → [{ uuid, mib }]. Format: "GPU-<uuid>,NVIDIA,<MiB>,<cores>:" per device, ";" per container. */
export function hamiSlices(annotation) {
  const out = [];
  for (const m of String(annotation || "").matchAll(/(GPU-[0-9a-fA-F-]+),[^,]*,(\d+),(\d+)/g)) out.push({ uuid: m[1], mib: Number(m[2]), cores: Number(m[3]) });
  return out;
}

const shortOwner = (p) => (p.metadata.labels?.["serving.kserve.io/inferenceservice"] || p.metadata.labels?.["tcs.com/model"]
  || p.metadata.labels?.["app.kubernetes.io/name"] || p.metadata.name.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "").replace(/-[a-z0-9]{5}$/, ""));

/** Which pod owns which slice of which card, from the GPU cluster's running pods. */
export function slicesFromPods(pods, modelNames = []) {
  const byUuid = new Map(); const unplaced = [];
  for (const p of pods || []) {
    const ann = p.metadata?.annotations || {};
    const owner = shortOwner(p);
    const ours = modelNames.includes(owner) || p.metadata?.labels?.["tcs.com/demo"] === "private-ai-ops";
    const entry = { owner, namespace: p.metadata.namespace, pod: p.metadata.name, node: p.spec?.nodeName || null, ours };
    const sl = hamiSlices(ann["hami.io/vgpu-devices-allocated"] || ann["hami.io/devices-allocated"]);
    if (sl.length) { for (const s of sl) { if (!byUuid.has(s.uuid)) byUuid.set(s.uuid, []); byUuid.get(s.uuid).push({ ...entry, mib: s.mib }); } continue; }
    const lim = (p.spec?.containers || []).reduce((a, c) => a + (Number(c.resources?.limits?.["nvidia.com/gpumem"]) || 0), 0);
    const gpus = (p.spec?.containers || []).reduce((a, c) => a + (Number(c.resources?.limits?.["nvidia.com/gpu"]) || 0), 0);
    if (gpus) unplaced.push({ ...entry, mib: lim || null });
  }
  return { byUuid, unplaced };
}

async function floorNow() {
  if (!_deps.gpu) return { available: false, reason: "GPU telemetry not configured" };
  const g = await _deps.gpu().catch((e) => ({ available: false, reason: e.message }));
  let pods = [];
  try { pods = (await _deps.ocp.fetch("/api/v1/pods?fieldSelector=status.phase%3DRunning")).items || []; } catch { /* slices optional */ }
  const models = [...router.models().map((m) => m.model), ...(embeddingModel() ? [embeddingModel().model] : [])];
  const { byUuid, unplaced } = slicesFromPods(pods, models);
  const cards = (g.gpus || []).map((c) => {
    const owners = (c.uuid && byUuid.get(c.uuid)) || [];
    const total = c.memTotalMiB || null;
    // A pod DCGM attributes the whole card to (no HAMi slice): show it as owning the used memory.
    if (!owners.length && c.pod) owners.push({ owner: c.pod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, ""), namespace: c.namespace, pod: c.pod, mib: c.memUsedMiB, ours: false });
    const reserved = owners.reduce((a, o) => a + (o.mib || 0), 0);
    return { node: c.node, index: c.index, uuid: c.uuid, model: c.model, utilPct: c.utilPct, memUsedMiB: c.memUsedMiB, memTotalMiB: total,
      tempC: c.tempC, powerW: c.powerW, powerLimitW: c.powerLimitW, status: c.status, slices: owners, freeMiB: total != null ? Math.max(0, total - reserved) : null };
  });
  // No DCGM telemetry: still draw the cards the API server knows about, with
  // the GPU pods on each node, so the floor is never empty when GPUs exist.
  if (!cards.length) {
    for (const n of g.nodes || g.inventory?.nodes || []) {
      const count = Number(n.gpuCount ?? n.capacity) || 0;
      const onNode = unplaced.filter((u) => u.node === n.name);
      for (let i = 0; i < count; i++) {
        cards.push({ node: n.name, index: i, uuid: null, model: n.model || n.product || "GPU", utilPct: null, memUsedMiB: null,
          memTotalMiB: n.memoryMiBPerGpu || null, tempC: null, powerW: null, powerLimitW: null, status: null,
          slices: i === 0 ? onNode : [], freeMiB: null });
      }
      unplaced.splice(0, unplaced.length, ...unplaced.filter((u) => u.node !== n.name));
    }
  }
  const nodes = [...new Set(cards.map((c) => c.node))].map((n) => ({ name: n, cards: cards.filter((c) => c.node === n).sort((a, b) => Number(a.index) - Number(b.index)) }));
  return { available: g.available !== false && cards.length > 0 && g.telemetry !== "unavailable", telemetry: g.telemetry || (cards.length ? "ok" : "unavailable"),
    reason: g.reason || g.telemetryReason || null, nodes, unplaced, inventory: g.summary || null };
}

/* ─────────────────────────── energy ─────────────────────────── */

let _energyStart = null; // { at, mj } at the session start
async function energyNow(since) {
  if (!_deps.prom) return null;
  const rows = await _deps.prom("sum(DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION)").catch(() => []);
  const mj = Number(rows?.[0]?.value?.[1]);
  if (!Number.isFinite(mj)) return null;
  if (!_energyStart || _energyStart.since !== since) _energyStart = { since, mj };
  const kwh = Math.max(0, mj - _energyStart.mj) / 3.6e9; // millijoules → kWh
  return { kwh: Math.round(kwh * 1000) / 1000, co2Kg: Math.round(kwh * GRID() * 100) / 100, gridKgPerKwh: GRID() };
}

/* ─────────────────────────── history (sparklines) ─────────────────────────── */

const _hist = [];
let _lastSample = 0;
function sample(k) {
  if (Date.now() - _lastSample < 8000) return;
  _lastSample = Date.now();
  _hist.push({ at: new Date().toISOString(), onPrem: k.onPrem, saved: k.savedUsd, ttft: k.ttftMs, tps: k.tokensPerSec, guard: k.guardrailStops, kwh: k.energy?.kwh ?? null });
  if (_hist.length > HISTORY) _hist.shift();
}
export function resetFactory() { _hist.length = 0; _lastSample = 0; _energyStart = null; _prev.clear(); }

/* ─────────────────────────── the read ─────────────────────────── */

export async function factoryState({ cluster = "local", since }) {
  const [models, floor, energy, isvcs] = await Promise.all([
    modelsNow(),
    _deps.runForCluster(cluster, floorNow).catch((e) => ({ available: false, reason: e.message, nodes: [] })),
    _deps.runForCluster(cluster, () => energyNow(since)).catch(() => null),
    _deps.runForCluster(cluster, () => listModels()).catch(() => []),
  ]);
  const t = router.trafficCounts();
  const g = router.guardrails();
  const onPrem = t.total - t.cloudCalls - g.injectionsBlocked;
  const chat = models.filter((m) => m.role !== "embed" && m.stats);
  const ttfts = chat.map((m) => m.stats.ttftMs).filter((v) => v != null).sort((a, b) => a - b);
  const log = router.trafficLog(40);
  const done = log.filter((x) => x.ms && x.ok !== false).map((x) => x.ms).sort((a, b) => a - b);
  const kpis = {
    onPrem, onPremPct: onPrem + t.cloudCalls ? Math.round((onPrem / (onPrem + t.cloudCalls)) * 100) : 100,
    savedUsd: Math.round((t.tokens / 1e6) * PRICE() * 100) / 100, pricePerMTok: PRICE(), tokens: t.tokens,
    ttftMs: ttfts.length ? ttfts[Math.floor(ttfts.length / 2)] : done.length ? done[Math.floor(done.length / 2)] : null,
    ttftSource: ttfts.length ? "first token (vLLM)" : "full answer (router)",
    tokensPerSec: chat.reduce((a, m) => a + (m.stats.tokensPerSec || 0), 0) || (chat.length ? 0 : null),
    guardrailStops: g.injectionsBlocked + g.sensitiveKeptOnPrem, leaks: t.cloudCalls ? null : 0,
    energy,
  };
  sample(kpis);
  const roles = t.byRole || {};
  const routed = Object.entries(roles).filter(([r]) => r !== "none").reduce((a, [, n]) => a + n, 0);
  const totalMem = floor.nodes?.flatMap((n) => n.cards).reduce((a, c) => a + (c.memTotalMiB || 0), 0) || 0;
  const freeMem = floor.nodes?.flatMap((n) => n.cards).reduce((a, c) => a + (c.freeMiB || 0), 0) || 0;
  const freeCards = floor.nodes?.flatMap((n) => n.cards).filter((c) => c.memTotalMiB && c.freeMiB >= c.memTotalMiB * 0.95).length || 0;
  return {
    kpis, history: _hist.slice(),
    router: { on: routed > 0, split: Object.fromEntries(Object.entries(roles).filter(([r]) => r !== "none").map(([r, n]) => [r, routed ? Math.round((n / routed) * 100) : 0])) },
    floor, models: models.map((m) => ({ ...m, control: isvcs.find((i) => i.name === m.model) || null })),
    capacity: { totalMiB: totalMem, freeMiB: freeMem, usedPct: totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null, freeCards },
    guardrails: g, log: log.slice(0, 8),
  };
}

/* ─────────────────────────── model controls (OpenShift AI stop / start) ─────────────────────────── */

async function listModels() {
  const r = await _deps.ocp.fetch(`/apis/serving.kserve.io/v1beta1/namespaces/${MODELS_NS()}/inferenceservices`);
  return (r.items || []).map((i) => ({ name: i.metadata.name, stopped: i.metadata.annotations?.["serving.kserve.io/stop"] === "true",
    ready: (i.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True") }));
}

export async function setModelRunning({ cluster = "local", name, run }) {
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(String(name || ""))) throw Object.assign(new Error("Not a valid model name"), { status: 400 });
  return _deps.runForCluster(cluster, async () => {
    await _deps.ocp.patch(`/apis/serving.kserve.io/v1beta1/namespaces/${MODELS_NS()}/inferenceservices/${name}`,
      { metadata: { annotations: { "serving.kserve.io/stop": run ? "false" : "true" } } }, "application/merge-patch+json");
    return { name, running: !!run };
  });
}

/* ─────────────────────────── side by side ─────────────────────────── */

const SYSTEM = "You are an SRE assistant for OpenShift and Kubernetes. Answer in at most three sentences, concrete and actionable.";

async function ask(m, question) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await lanFetch(`${m.url}/v1/chat/completions`, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", ...(process.env.PRIVATE_AI_API_KEY ? { Authorization: `Bearer ${process.env.PRIVATE_AI_API_KEY}` } : {}) },
      body: JSON.stringify({ model: m.model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: question }], max_tokens: 400, temperature: 0.2 }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    const msg = j.choices?.[0]?.message || {};
    return { ok: true, answer: String(msg.content || msg.reasoning_content || "").trim(), ms: Date.now() - t0, tokens: j.usage?.completion_tokens ?? null, totalTokens: j.usage?.total_tokens ?? null };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "timed out" : e.message, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

/** The same question to the fast and the reasoning model, in parallel. */
export async function compare(question) {
  const q = String(question || "").trim().slice(0, 1000);
  if (!q) throw Object.assign(new Error("Type a question first"), { status: 400 });
  const inj = router.injection(q);
  if (inj) throw Object.assign(new Error(`Blocked by the Private AI guardrails (${inj})`), { status: 400 });
  const list = router.models();
  const pick = ["small", "large"].map((r) => list.find((m) => m.role === r)).filter(Boolean);
  if (pick.length < 2) throw Object.assign(new Error("Side by side needs both the fast and the reasoning model connected"), { status: 409 });
  const answers = await Promise.all(pick.map(async (m) => {
    const a = await ask(m, q);
    const d = router.logDirect({ id: Math.random().toString(16).slice(2, 14), at: new Date().toISOString(), question: q.slice(0, 140), role: m.role, wanted: m.role,
      model: m.model, gpu: m.gpu, reason: "side by side", sensitive: router.sensitivity(q), onPrem: true, useCase: "side-by-side", conversationId: null, ms: null, ok: null, tokens: null });
    router.complete(d, { ms: a.ms, ok: a.ok, usage: a.totalTokens ? { totalTokens: a.totalTokens } : null });
    return { role: m.role, label: m.label, model: m.model, gpu: m.gpu, ...a };
  }));
  return { question: q, answers };
}

/* ─────────────────────────── evidence pack ─────────────────────────── */

const esc = (v) => String(v ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (iso) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");

/** A printable, self-contained HTML report of the session (Save as PDF from the browser). */
export function evidenceHtml({ state, factory, actor, cluster }) {
  const k = factory.kpis; const g = factory.guardrails; const a1 = state.act1; const sc = state.scorecard;
  const rows = (arr, cols) => arr.map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof c === "function" ? c(r) : r[c])}</td>`).join("")}</tr>`).join("");
  const cards = (factory.floor.nodes || []).flatMap((n) => n.cards.map((c) => ({ ...c, node: n.name })));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Private AI Factory — evidence pack</title>
<style>body{font:13px/1.45 Inter,system-ui,sans-serif;color:#14202f;margin:32px;max-width:1000px}h1{font-size:22px;margin:0}h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid #dbe2eb;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{border-bottom:1px solid #e6ebf1;padding:5px 6px;text-align:left;vertical-align:top}th{color:#5f6f84;font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.kpi{border:1px solid #dbe2eb;border-radius:8px;padding:8px}.kpi b{display:block;font-size:18px}.muted{color:#5f6f84}
@media print{body{margin:12mm}button{display:none}}</style></head><body>
<button onclick="window.print()" style="float:right;padding:8px 14px">Save as PDF</button>
<h1>Private AI Factory — evidence pack</h1>
<p class="muted">Generated ${esc(when(new Date().toISOString()))} by ${esc(actor)} · GPU cluster ${esc(cluster)} · ${esc(state.hardware || "")}<br>Session since ${esc(when(state.session?.since))}</p>
<h2>Summary</h2><div class="kpis">
<div class="kpi"><span class="muted">AI answers on-prem</span><b>${esc(k.onPrem)}</b>${esc(k.onPremPct)}% of AI traffic</div>
<div class="kpi"><span class="muted">Calls to cloud AI</span><b>${esc(a1.traffic.cloudCalls)}</b>${a1.traffic.cloudCalls ? "non-sensitive only, by policy" : "none"}</div>
<div class="kpi"><span class="muted">Sensitive requests kept on-prem</span><b>${esc(g.sensitiveKeptOnPrem)}</b>${esc(g.masked)} items masked in logs</div>
<div class="kpi"><span class="muted">Prompt injections blocked</span><b>${esc(g.injectionsBlocked)}</b>guardrails ${g.on ? "on" : "off"}</div>
<div class="kpi"><span class="muted">Tokens served on-prem</span><b>${esc(k.tokens)}</b>≈ $${esc(k.savedUsd)} at $${esc(k.pricePerMTok)}/M tokens</div>
<div class="kpi"><span class="muted">Internet egress</span><b>${a1.egress.blocked ? "Blocked" : "Open"}</b>${a1.egress.blocked ? "since " + esc(when(a1.egress.since)) : ""}</div>
<div class="kpi"><span class="muted">GPU energy this session</span><b>${k.energy ? esc(k.energy.kwh) + " kWh" : "—"}</b>${k.energy ? esc(k.energy.co2Kg) + " kg CO₂e" : "DCGM energy not available"}</div>
<div class="kpi"><span class="muted">Changes approved by a person</span><b>${esc(sc.approved)} / ${esc(sc.changes)}</b>incident MTTR ${sc.mttrSec != null ? esc(sc.mttrSec) + " s" : "—"}</div></div>
<h2>Models</h2><table><tr><th>Model</th><th>Role</th><th>GPU</th><th>State</th><th>First token</th><th>Tokens/s</th></tr>
${rows(factory.models, ["model", "label", "gpu", (m) => (m.ready ? "ready" : m.error || "not answering"), (m) => (m.stats?.ttftMs != null ? m.stats.ttftMs + " ms" : "—"), (m) => m.stats?.tokensPerSec ?? "—"])}</table>
<h2>GPUs</h2><table><tr><th>Node</th><th>Card</th><th>Utilisation</th><th>Memory</th><th>Temp</th><th>Power</th><th>Owned by</th></tr>
${rows(cards, ["node", (c) => `${c.model} #${c.index}`, (c) => (c.utilPct != null ? c.utilPct + "%" : "—"), (c) => (c.memUsedMiB != null ? `${Math.round(c.memUsedMiB / 1024)} / ${Math.round((c.memTotalMiB || 0) / 1024)} GB` : "—"), (c) => (c.tempC != null ? c.tempC + " °C" : "—"), (c) => (c.powerW != null ? Math.round(c.powerW) + " W" : "—"), (c) => c.slices.map((s) => `${s.owner} ${s.mib ? Math.round(s.mib / 1024) + " GB" : ""}`).join(", ") || "free"])}</table>
<h2>Guardrail events</h2><table><tr><th>Time</th><th>Action</th><th>Why</th><th>Request (masked)</th></tr>
${rows(g.events, [(e) => when(e.at), (e) => (e.kind === "blocked" ? "Blocked" : "Kept on-prem"), "what", "question"]) || "<tr><td colspan=4 class=muted>None this session</td></tr>"}</table>
<h2>AI traffic (latest 40, questions masked)</h2><table><tr><th>Time</th><th>Question</th><th>Answered by</th><th>Why</th><th>Duration</th></tr>
${rows(a1.log || [], [(r) => when(r.at), "question", (r) => r.model || (r.blocked ? "blocked" : "—"), "reason", (r) => (r.ms ? (r.ms / 1000).toFixed(1) + " s" : "—")])}</table>
<p class="muted" style="margin-top:24px">Every figure comes from the platform's own records: the AI router log, the guardrail counters, DCGM GPU telemetry and the incident and remediation workflows. Detailed entries are in the Audit trail.</p>
</body></html>`;
}
