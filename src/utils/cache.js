/**
 * Redis cache client.
 *
 * Lazy initialized. If REDIS_URL is not set the helpers all become no-ops
 * (cacheGet returns null, cacheSet returns false), so the rest of the app
 * works without caching.
 */

let _client = null;
let _initPromise = null;
let _enabled = false;
let _initFailed = false;

function getRedisUrl() {
  return process.env.REDIS_URL || process.env.CACHE_URL || null;
}

async function init() {
  if (_client || _initFailed) return _client;
  if (_initPromise) return _initPromise;

  const url = getRedisUrl();
  if (!url) {
    _initFailed = true;
    return null;
  }

  _initPromise = (async () => {
    try {
      const ioredisModule = await import("ioredis");
      const Redis = ioredisModule.default || ioredisModule;
      _client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        connectTimeout: 5000,
        retryStrategy(times) {
          if (times > 5) return null;
          return Math.min(times * 200, 2000);
        },
      });
      _client.on("error", (err) => {
        // Don't spam logs once we know it's broken
        if (_enabled) {
          console.warn("[cache] redis error:", err.message);
          _enabled = false;
        }
      });
      _client.on("ready", () => {
        _enabled = true;
        console.log("[cache] Redis ready");
      });
      await _client.connect();
      // Ping
      await _client.ping();
      _enabled = true;
      console.log("[cache] Redis connected");
      return _client;
    } catch (err) {
      console.warn(
        "[cache] Redis unavailable, running without cache:",
        err.message
      );
      _initFailed = true;
      _client = null;
      _enabled = false;
      return null;
    }
  })();

  return _initPromise;
}

const PREFIX = process.env.CACHE_PREFIX || "ocp-mcp:";

function k(key) {
  return `${PREFIX}${key}`;
}

/**
 * Get a JSON value from the cache, or null if missing / disabled.
 */
export async function cacheGet(key) {
  await init();
  if (!_client || !_enabled) return null;
  try {
    const raw = await _client.get(k(key));
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch (err) {
    console.warn("[cache] get error:", err.message);
    return null;
  }
}

/**
 * Set a JSON value in the cache with TTL (seconds). Returns true on success.
 */
export async function cacheSet(key, value, ttlSeconds = 60) {
  await init();
  if (!_client || !_enabled) return false;
  try {
    const payload = typeof value === "string" ? value : JSON.stringify(value);
    if (ttlSeconds > 0) {
      await _client.set(k(key), payload, "EX", ttlSeconds);
    } else {
      await _client.set(k(key), payload);
    }
    return true;
  } catch (err) {
    console.warn("[cache] set error:", err.message);
    return false;
  }
}

/** Delete a single key from the cache. */
export async function cacheDel(key) {
  await init();
  if (!_client || !_enabled) return false;
  try {
    await _client.del(k(key));
    return true;
  } catch (err) {
    console.warn("[cache] del error:", err.message);
    return false;
  }
}

/** Delete keys matching a pattern (e.g. "chat:*"). Use sparingly. */
export async function cacheDelPattern(pattern) {
  await init();
  if (!_client || !_enabled) return 0;
  try {
    const stream = _client.scanStream({ match: k(pattern), count: 100 });
    let deleted = 0;
    for await (const keys of stream) {
      if (keys.length) {
        deleted += keys.length;
        await _client.del(...keys);
      }
    }
    return deleted;
  } catch (err) {
    console.warn("[cache] del-pattern error:", err.message);
    return 0;
  }
}

/** Returns true if Redis is configured and reachable. */
export async function isEnabled() {
  await init();
  return _enabled;
}

/** Eager initialization — call at startup. */
export async function initCache() {
  await init();
  return _enabled;
}

export async function closeCache() {
  if (_client) {
    try {
      await _client.quit();
    } catch {
      _client.disconnect();
    }
    _client = null;
    _enabled = false;
  }
}
