// Embeddings for incident memory ("have we seen this before?").
//
// The knowledge base matched past incidents by shared words, so "Postgres ran
// out of connections" and "too many clients already" never met. With an
// embedding model on the GPU (vLLM --task embed, e.g. BAAI/bge-m3) the match is
// on meaning. Nothing changes when it is not configured: callers fall back to
// the term-frequency vectors they used before.
//
//   PRIVATE_AI_EMBED_URL    OpenAI-compatible base URL (…/v1/embeddings)
//   PRIVATE_AI_EMBED_MODEL  default bge-m3
//   PRIVATE_AI_EMBED_GPU    label shown on screen

import { lanFetch } from "../../utils/lan-dns.js";
import { logDirect, complete as completeRoute } from "./router.js";

// Each lookup also appears in the Private AI Factory's AI traffic (role "embed"),
// without the texts themselves: only how many were compared.
function logLookup(m, n, ms, ok, error = null) {
  try {
    const d = logDirect({ id: Math.random().toString(16).slice(2, 14), at: new Date().toISOString(), question: `Incident memory: ${n} text${n === 1 ? "" : "s"} compared by meaning`,
      role: "embed", wanted: "embed", model: m.model, gpu: m.gpu || null, cluster: m.cluster || null, reason: "similar past incidents (embeddings)",
      sensitive: [], onPrem: true, useCase: "incident-memory", conversationId: null, ms: null, ok: null, tokens: null });
    completeRoute(d, { ms, ok, error });
  } catch { /* the lookup's own result is what matters */ }
}

const CACHE_MAX = 4000;
const _cache = new Map();
let _stats = { calls: 0, texts: 0, failures: 0, lastError: null, lastMs: null };

// An embedding model discovered on a GPU cluster (fleet.js), used when none is set in the environment.
let _fleetEmbed = () => null;
export function setEmbedProvider(fn) { _fleetEmbed = fn; }

export function embeddingsConfigured() { return !!process.env.PRIVATE_AI_EMBED_URL || !!_fleetEmbed(); }
export function embeddingModel() {
  if (process.env.PRIVATE_AI_EMBED_URL) return { role: "embed", label: "Incident memory", url: process.env.PRIVATE_AI_EMBED_URL.replace(/\/+$/, ""), model: process.env.PRIVATE_AI_EMBED_MODEL || "bge-m3", gpu: process.env.PRIVATE_AI_EMBED_GPU || null, healthPath: process.env.PRIVATE_AI_EMBED_HEALTH || "/health", cluster: process.env.PRIVATE_AI_MODELS_CLUSTER || null };
  const f = _fleetEmbed();
  return f ? { role: "embed", label: "Incident memory", url: f.url.replace(/\/+$/, ""), model: f.model, gpu: f.gpu || null, healthPath: "/health", cluster: f.cluster } : null;
}
export function embeddingStats() { return { ..._stats, cached: _cache.size }; }

/** Dense vectors for `texts` (same order), or null when the service is unavailable. */
export async function embedMany(texts, { fetchImpl } = {}) {
  const m = embeddingModel();
  if (!m || !texts.length) return null;
  const out = new Array(texts.length);
  const missing = [];
  texts.forEach((t, i) => { const c = _cache.get(t); if (c) out[i] = c; else missing.push(i); });
  if (missing.length) {
    const f = fetchImpl || lanFetch;
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      for (let s = 0; s < missing.length; s += 64) {
        const idx = missing.slice(s, s + 64);
        const r = await f(`${m.url}/v1/embeddings`, {
          method: "POST", signal: ctl.signal,
          headers: { "Content-Type": "application/json", ...(process.env.PRIVATE_AI_API_KEY ? { Authorization: `Bearer ${process.env.PRIVATE_AI_API_KEY}` } : {}) },
          body: JSON.stringify({ model: m.model, input: idx.map((i) => String(texts[i]).slice(0, 4000)) }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        (j.data || []).forEach((d, k) => {
          const v = normalise(d.embedding);
          out[idx[d.index ?? k]] = v;
          if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
          _cache.set(texts[idx[d.index ?? k]], v);
        });
      }
      _stats = { ..._stats, calls: _stats.calls + 1, texts: _stats.texts + missing.length, lastMs: Date.now() - t0, lastError: null };
      logLookup(m, missing.length, Date.now() - t0, true);
    } catch (e) {
      _stats = { ..._stats, failures: _stats.failures + 1, lastError: e?.name === "AbortError" ? "timed out" : e.message };
      logLookup(m, missing.length, Date.now() - t0, false, _stats.lastError);
      return null;
    } finally { clearTimeout(timer); }
  }
  return out.every(Boolean) ? out : null;
}

function normalise(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Float32Array.from(v, (x) => x / n);
}

/** Cosine of two unit vectors. */
export function denseCosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function _resetEmbeddings() { _cache.clear(); _stats = { calls: 0, texts: 0, failures: 0, lastError: null, lastMs: null }; }
