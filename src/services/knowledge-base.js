/**
 * Incident Knowledge Base — learns from past incidents and resolutions.
 *
 * When the AI resolves an issue, the resolution is stored with context
 * (symptoms, root cause, fix). When a similar issue recurs, the KB finds
 * matching past resolutions and provides them as context to the LLM.
 *
 * This gives KubeNexus AI a "memory" that improves over time —
 * something no competitor has.
 *
 * Storage: PostgreSQL (primary), in-memory fallback.
 * Matching: keyword + type + resource pattern similarity scoring.
 */

import { query as dbQuery } from "../utils/db.js";
import { callLLM } from "./llm.js";

let _embeddingCache = new Map();
const MAX_EMBEDDING_CACHE = 200;

const _memKB = [];
const MAX_ENTRIES = 500;

async function computeEmbedding(text) {
  const cached = _embeddingCache.get(text);
  if (cached) return cached;

  // Use a simple TF-IDF-like approach as fallback when no embedding API is available
  // This gives us semantic-ish matching without requiring an external API
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2);

  // Build term frequency vector
  const tf = {};
  for (const w of words) {
    tf[w] = (tf[w] || 0) + 1;
  }

  // Normalize
  const norm = Math.sqrt(Object.values(tf).reduce((s, v) => s + v * v, 0)) || 1;
  for (const k in tf) tf[k] /= norm;

  if (_embeddingCache.size >= MAX_EMBEDDING_CACHE) {
    const first = _embeddingCache.keys().next().value;
    _embeddingCache.delete(first);
  }
  _embeddingCache.set(text, tf);
  return tf;
}

function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, normA = 0, normB = 0;
  for (const k of keys) {
    const va = a[k] || 0;
    const vb = b[k] || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export async function initKnowledgeBase() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS incident_kb (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        resource_pattern TEXT,
        namespace_pattern TEXT,
        symptoms TEXT NOT NULL,
        root_cause TEXT,
        resolution TEXT NOT NULL,
        commands TEXT,
        tags TEXT[],
        effectiveness INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_kb_type ON incident_kb (type)`);

    const rows = await dbQuery("SELECT * FROM incident_kb ORDER BY effectiveness DESC, updated_at DESC LIMIT $1", [MAX_ENTRIES]);
    if (rows?.rows) {
      _memKB.length = 0;
      _memKB.push(...rows.rows);
    }
    console.error(`[knowledge-base] Loaded ${_memKB.length} knowledge entries`);
  } catch {
    console.warn("[knowledge-base] DB not available, using in-memory only");
  }
}

/**
 * Record a resolved incident for future reference.
 */
export async function recordResolution({
  type,
  resourcePattern,
  namespacePattern,
  symptoms,
  rootCause,
  resolution,
  commands,
  tags,
}) {
  const entry = {
    type: type || "unknown",
    resource_pattern: resourcePattern || "*",
    namespace_pattern: namespacePattern || "*",
    symptoms: symptoms || "",
    root_cause: rootCause || "",
    resolution: resolution || "",
    commands: commands || "",
    tags: tags || [],
    effectiveness: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  try {
    const result = await dbQuery(
      `INSERT INTO incident_kb (type, resource_pattern, namespace_pattern, symptoms, root_cause, resolution, commands, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [entry.type, entry.resource_pattern, entry.namespace_pattern, entry.symptoms, entry.root_cause, entry.resolution, entry.commands, entry.tags]
    );
    entry.id = result?.rows?.[0]?.id;
  } catch { /* DB optional */ }

  _memKB.unshift(entry);
  if (_memKB.length > MAX_ENTRIES) _memKB.pop();
  return entry;
}

/**
 * Find similar past resolutions for a given issue.
 * Returns scored matches sorted by relevance.
 */
export async function findSimilar({ type, resource, namespace, symptoms, limit = 5 }) {
  const scored = [];
  const queryEmbed = symptoms ? await computeEmbedding(symptoms) : null;

  for (const entry of _memKB) {
    let score = 0;

    // Original keyword scoring
    if (entry.type === type) score += 40;

    if (resource && entry.resource_pattern !== "*") {
      if (resource.includes(entry.resource_pattern) || entry.resource_pattern.includes(resource)) {
        score += 15;
      }
    }

    if (namespace && entry.namespace_pattern !== "*") {
      if (namespace === entry.namespace_pattern) score += 10;
    }

    if (symptoms && entry.symptoms) {
      const words = symptoms.toLowerCase().split(/\s+/);
      const entryWords = entry.symptoms.toLowerCase().split(/\s+/);
      const overlap = words.filter((w) => entryWords.includes(w)).length;
      score += Math.min(overlap * 5, 25);
    }

    // Semantic similarity boost (0-30 points)
    if (queryEmbed && entry.symptoms) {
      const entryEmbed = await computeEmbedding(entry.symptoms);
      const sim = cosineSimilarity(queryEmbed, entryEmbed);
      score += Math.round(sim * 30);
    }

    score += Math.min(entry.effectiveness || 0, 10);

    if (score > 10) {
      scored.push({ ...entry, relevanceScore: score });
    }
  }

  return scored
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit);
}

/**
 * Mark a resolution as effective (thumbs up) or ineffective (thumbs down).
 */
export async function rateResolution(id, delta) {
  const entry = _memKB.find((e) => e.id === id);
  if (entry) {
    entry.effectiveness = (entry.effectiveness || 0) + delta;
    entry.updated_at = new Date().toISOString();
  }
  try {
    await dbQuery(
      "UPDATE incident_kb SET effectiveness = effectiveness + $1, updated_at = NOW() WHERE id = $2",
      [delta, id]
    );
  } catch { /* DB optional */ }
}

/**
 * Build context string from KB matches for injection into LLM prompts.
 */
export function buildKBContext(matches) {
  if (!matches || matches.length === 0) return "";
  return "\n\n--- Past Resolutions from Knowledge Base ---\n" +
    matches.map((m, i) =>
      `${i + 1}. [${m.type}] ${m.symptoms}\n   Root cause: ${m.root_cause}\n   Resolution: ${m.resolution}` +
      (m.commands ? `\n   Commands: ${m.commands}` : "")
    ).join("\n\n");
}

export function getStats() {
  return {
    totalEntries: _memKB.length,
    byType: _memKB.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {}),
    avgEffectiveness: _memKB.length > 0
      ? Math.round(_memKB.reduce((s, e) => s + (e.effectiveness || 0), 0) / _memKB.length * 10) / 10
      : 0,
  };
}

export function getAllEntries(limit = 50) {
  return _memKB.slice(0, limit);
}
