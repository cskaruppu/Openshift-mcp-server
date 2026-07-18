/**
 * Fleet memory — RAG over this fleet's own operational history.
 *
 * Every applied fix (ServiceNow agent, topology fix-from-node, remediations)
 * is recorded as a memory: symptom → root cause → action → outcome. When the
 * AI later analyzes an incident or topology, the most similar past cases are
 * retrieved and grounded into the prompt ("we saw this before — this fix
 * worked"), so answers improve with every incident the platform handles.
 *
 * v1 retrieval is LOCAL LEXICAL similarity (token overlap) — zero external
 * dependencies, works air-gapped, no embedding provider needed. The recall()
 * interface is embedding-ready: swapping in a vector backend (pgvector +
 * llm embeddings) changes only this file.
 *
 * Storage: a bounded JSON file (default under MCP_DATA_DIR or /tmp). Mount a
 * PVC at MCP_DATA_DIR for durability across pod restarts.
 * Disable entirely with FLEET_MEMORY_ENABLED=false.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const enabled = () => (process.env.FLEET_MEMORY_ENABLED || "true").toLowerCase() !== "false";
const file = () => process.env.FLEET_MEMORY_FILE || join(process.env.MCP_DATA_DIR || "/tmp", "fleet-memory.json");
const MAX_RECORDS = 500;

let _mem = null;
let _saveTimer = null;

function load() {
  if (_mem) return _mem;
  try { _mem = JSON.parse(readFileSync(file(), "utf8")); } catch { _mem = []; }
  if (!Array.isArray(_mem)) _mem = [];
  return _mem;
}

function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try { mkdirSync(dirname(file()), { recursive: true }); writeFileSync(file(), JSON.stringify(_mem.slice(-MAX_RECORDS))); }
    catch { /* memory persists in-process; recording must never break a fix */ }
  }, 300);
}

// Tokenizer: lowercase words; long hex/hash runs collapsed so pod-name
// suffixes don't dominate similarity.
const tokenize = (s) => String(s || "").toLowerCase().replace(/[0-9a-f]{6,}/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Record an operational memory. Never throws. */
export function remember(rec) {
  if (!enabled()) return;
  try {
    const m = load();
    m.push({ ts: new Date().toISOString(), ...rec });
    if (m.length > MAX_RECORDS) m.splice(0, m.length - MAX_RECORDS);
    scheduleSave();
  } catch { /* no-op */ }
}

/** Retrieve the k most similar past cases for a free-text query. */
export function recall(query, k = 3) {
  if (!enabled()) return [];
  try {
    const q = new Set(tokenize(query));
    if (q.size === 0) return [];
    return load()
      .map((r) => {
        const toks = tokenize(`${r.symptom || ""} ${r.rootCause || ""} ${r.action || ""} ${r.namespace || ""} ${r.workload || ""}`);
        let hits = 0;
        for (const w of new Set(toks)) if (q.has(w)) hits++;
        return { r, score: hits / Math.sqrt(new Set(toks).size + 1) };
      })
      .filter((x) => x.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => ({ ...x.r, similarity: Math.round(x.score * 100) / 100 }));
  } catch { return []; }
}

/** Build a prompt context block of similar past cases ("" when none). */
export function buildMemoryContext(query, k = 3) {
  const hits = recall(query, k);
  if (hits.length === 0) return "";
  return "\nFLEET MEMORY — similar past cases handled on THIS fleet (prefer these proven fixes when relevant):\n" +
    hits.map((h) => `- [${(h.ts || "").slice(0, 10)} ${h.cluster || "?"}/${h.namespace || "?"}] symptom: ${h.symptom || "?"} → root cause: ${h.rootCause || "n/a"} → fix: ${h.action || "?"} → outcome: ${h.outcome || "applied"}`).join("\n") + "\n";
}

export function memoryStats() {
  try { const m = load(); return { enabled: enabled(), records: m.length, latest: m[m.length - 1]?.ts || null, file: file() }; }
  catch { return { enabled: enabled(), records: 0, latest: null }; }
}
