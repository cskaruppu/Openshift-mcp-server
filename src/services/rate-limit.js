/**
 * Simple in-memory token-bucket rate limiter.
 *
 * Keyed by a source identifier (IP, SA, or user-supplied token). Used on
 * /api/chat and /api/execute to prevent runaway automation. Good enough for
 * a single-replica deployment; a multi-replica setup should swap this for a
 * Redis-backed version.
 */

const DEFAULT_BURST = parseInt(process.env.RATE_LIMIT_BURST || "30", 10);
const DEFAULT_REFILL_PER_SEC = parseFloat(process.env.RATE_LIMIT_REFILL || "0.5");

const buckets = new Map();

function nowSec() {
  return Date.now() / 1000;
}

/**
 * Try to consume one token for `key`. Returns {allowed, retryAfter}.
 */
export function consume(key, { burst = DEFAULT_BURST, refillPerSec = DEFAULT_REFILL_PER_SEC } = {}) {
  const now = nowSec();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, ts: now };
    buckets.set(key, b);
  }
  // Refill
  const delta = now - b.ts;
  b.tokens = Math.min(burst, b.tokens + delta * refillPerSec);
  b.ts = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  }
  const retryAfter = Math.ceil((1 - b.tokens) / refillPerSec);
  return { allowed: false, retryAfter };
}

export function sourceKey(req) {
  const h = req.headers || {};
  return (
    h["x-forwarded-for"] ||
    h["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "anonymous"
  );
}

/** Small middleware — writes 429 and returns true if limited. */
export function enforce(req, res, opts) {
  const key = sourceKey(req);
  const r = consume(key, opts);
  if (!r.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": String(r.retryAfter),
    });
    res.end(JSON.stringify({ error: "Rate limit exceeded", retryAfter: r.retryAfter }));
    return true;
  }
  return false;
}

// Periodic cleanup so we don't leak memory
setInterval(() => {
  const cutoff = nowSec() - 600;
  for (const [k, b] of buckets) {
    if (b.ts < cutoff) buckets.delete(k);
  }
}, 60000).unref?.();
