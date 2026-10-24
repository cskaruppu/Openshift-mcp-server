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

const CACHE_MAX = 4000;
const _cache = new Map();
let _stats = { calls: 0, texts: 0, failures: 0, lastError: null, lastMs: null };

export function embeddingsConfigured() { return !!process.env.PRIVATE_AI_EMBED_URL; }
export function embeddingModel() {
  return embeddingsConfigured() ? { role: "embed", label: "Incident memory", url: process.env.PRIVATE_AI_EMBED_URL.replace(/\/+$/, ""), model: process.env.PRIVATE_AI_EMBED_MODEL || "bge-m3", gpu: process.env.PRIVATE_AI_EMBED_GPU || null, healthPath: process.env.PRIVATE_AI_EMBED_HEALTH || "/health" } : null;
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
    const f = fetchImpl || fetch;
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
    } catch (e) {
      _stats = { ..._stats, failures: _stats.failures + 1, lastError: e?.name === "AbortError" ? "timed out" : e.message };
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
