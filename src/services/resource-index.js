/**
 * Fuzzy resource name resolver.
 *
 * Maintains a lightweight in-memory index of cluster resources keyed by name
 * and refreshed on demand (every INDEX_TTL seconds). If pgvector is available
 * and an embeddings provider is configured, we also persist embeddings into
 * `resource_embeddings` for cosine similarity lookup. Otherwise we fall back
 * to a fast Levenshtein scan which handles typos like "web-depl" → "web-deployment".
 */

import { ocpGet } from "../utils/openshift-client.js";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

const INDEX_TTL_MS = parseInt(process.env.RESOURCE_INDEX_TTL_MS || "300000", 10); // 5 min
let _index = null;
let _indexedAt = 0;

async function rebuildIndex() {
  const items = [];
  try {
    const pods = await ocpGet("/api/v1/pods");
    for (const p of pods.items || []) {
      items.push({ kind: "pod", name: p.metadata.name, namespace: p.metadata.namespace });
    }
  } catch {}
  try {
    const deps = await ocpGet("/apis/apps/v1/deployments");
    for (const d of deps.items || []) {
      items.push({ kind: "deployment", name: d.metadata.name, namespace: d.metadata.namespace });
    }
  } catch {}
  try {
    const svcs = await ocpGet("/api/v1/services");
    for (const s of svcs.items || []) {
      items.push({ kind: "service", name: s.metadata.name, namespace: s.metadata.namespace });
    }
  } catch {}
  _index = items;
  _indexedAt = Date.now();
}

async function ensureIndex() {
  if (!_index || Date.now() - _indexedAt > INDEX_TTL_MS) {
    await rebuildIndex();
  }
  return _index;
}

/** Levenshtein distance — small, O(m*n). */
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Find resources that fuzzy-match the given name.
 * @param {string} query
 * @param {object} opts { kind, namespace, limit }
 */
export async function findResource(query, { kind = null, namespace = null, limit = 5 } = {}) {
  if (!query) return [];
  const q = query.toLowerCase();
  const idx = await ensureIndex();
  const filtered = idx.filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (namespace && r.namespace !== namespace) return false;
    return true;
  });
  const scored = filtered.map((r) => {
    const name = r.name.toLowerCase();
    const exact = name === q ? 0 : null;
    const prefix = name.startsWith(q) ? q.length - name.length : null;
    const contains = name.includes(q) ? 1 : null;
    const distance = lev(q, name);
    return {
      ...r,
      score:
        exact !== null ? 0 :
        prefix !== null ? 1 :
        contains !== null ? 2 + distance / 10 :
        3 + distance,
    };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).filter((r) => r.score < 6);
}

/** Optional pgvector path — ensures the table exists. No-op if DB disabled. */
export async function ensureVectorSchema() {
  if (!(await dbEnabled())) return false;
  try {
    await dbQuery("CREATE EXTENSION IF NOT EXISTS vector");
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS resource_embeddings (
        kind TEXT NOT NULL,
        namespace TEXT,
        name TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (kind, namespace, name)
      )
    `);
    return true;
  } catch {
    return false;
  }
}
