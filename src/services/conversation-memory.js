/**
 * Per-conversation short-term memory.
 *
 * Stores the last resource/name/namespace the user referenced so that
 * follow-up questions like "show its logs" or "delete it" can resolve
 * pronouns without re-asking.
 *
 * Backed by Redis when available (so multiple replicas share state),
 * falls back to an in-process LRU when Redis is not configured.
 */

import { cacheGet, cacheSet } from "../utils/cache.js";

const KEY_PREFIX = "conv-mem:";
const TTL_SECONDS = 60 * 60; // 1 hour

// Tiny in-memory fallback (capped to avoid unbounded growth).
const _memCache = new Map();
const MAX_MEM = 200;

function memSet(key, value) {
  if (_memCache.size >= MAX_MEM) {
    // delete oldest
    const oldest = _memCache.keys().next().value;
    _memCache.delete(oldest);
  }
  _memCache.set(key, value);
}

/**
 * Get the memory snapshot for a conversation.
 * Returns: { resource, name, namespace, lastIntent } or {} if none.
 */
export async function getMemory(conversationId) {
  if (!conversationId) return {};
  const key = KEY_PREFIX + conversationId;
  // Try Redis first
  const fromCache = await cacheGet(key);
  if (fromCache && typeof fromCache === "object") return fromCache;
  // Fallback to local
  return _memCache.get(key) || {};
}

/**
 * Merge an update into the conversation memory. Only non-null fields are
 * persisted. Pass `clear: true` to wipe.
 */
export async function updateMemory(conversationId, patch) {
  if (!conversationId) return;
  const key = KEY_PREFIX + conversationId;
  const cur = await getMemory(conversationId);
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null || v === "") continue;
    next[k] = v;
  }
  next.updatedAt = Date.now();
  // Persist to both Redis (if available) and local cache.
  await cacheSet(key, next, TTL_SECONDS).catch(() => {});
  memSet(key, next);
}

/** Helper: derive a memory patch from a parsed NLU result. */
export function memoryPatchFromParse(p) {
  return {
    resource: p?.resource || null,
    name: p?.name || null,
    namespace: p?.namespace || null,
    lastIntent: p?.intent || null,
  };
}
