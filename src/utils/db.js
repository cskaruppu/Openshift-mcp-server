/**
 * PostgreSQL database client.
 *
 * Lazy initialized. If DATABASE_URL is not set the helpers all become no-ops
 * so the rest of the app continues to work in stateless mode.
 */

let _pool = null;
let _initPromise = null;
let _enabled = false;
let _initFailed = false;

function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    null
  );
}

async function init() {
  if (_pool || _initFailed) return _pool;
  if (_initPromise) return _initPromise;

  const url = getDatabaseUrl();
  if (!url) {
    _initFailed = true;
    return null;
  }

  _initPromise = (async () => {
    try {
      const pgModule = await import("pg");
      const { Pool } = pgModule.default || pgModule;
      _pool = new Pool({
        connectionString: url,
        max: parseInt(process.env.DATABASE_POOL_MAX || "10", 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        ssl:
          process.env.DATABASE_SSL === "true"
            ? { rejectUnauthorized: false }
            : undefined,
      });
      _pool.on("error", (err) => {
        console.error("[db] unexpected pool error:", err.message);
      });
      // Ping
      await _pool.query("SELECT 1");
      _enabled = true;
      console.log("[db] PostgreSQL connected");
      await ensureSchema();
      return _pool;
    } catch (err) {
      console.warn(
        "[db] PostgreSQL unavailable, running in stateless mode:",
        err.message
      );
      _initFailed = true;
      _pool = null;
      _enabled = false;
      return null;
    }
  })();

  return _initPromise;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  html TEXT,
  provider TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS query_log (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT,
  query TEXT NOT NULL,
  intents TEXT[],
  cache_hit BOOLEAN DEFAULT FALSE,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_query_log_created ON query_log(created_at DESC);

CREATE TABLE IF NOT EXISTS executed_actions (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  namespace TEXT,
  success BOOLEAN,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_executed_actions_created ON executed_actions(created_at DESC);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  namespace TEXT,
  options JSONB,
  status TEXT NOT NULL DEFAULT 'pending_confirmation',
  servicenow_cr_number TEXT,
  servicenow_sys_id TEXT,
  requested_by TEXT,
  summary TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pending_actions_conv ON pending_actions(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status, updated_at DESC);
`;

async function ensureSchema() {
  if (!_pool) return;
  try {
    await _pool.query(SCHEMA_SQL);
    console.log("[db] schema ensured");
  } catch (err) {
    console.error("[db] failed to ensure schema:", err.message);
  }
}

/**
 * Run a parameterized query. Returns { rows, rowCount } or null if DB disabled.
 */
export async function query(text, params = []) {
  await init();
  if (!_pool) return null;
  try {
    return await _pool.query(text, params);
  } catch (err) {
    console.error("[db] query error:", err.message);
    return null;
  }
}

/** Returns true if the DB is configured and reachable. */
export async function isEnabled() {
  await init();
  return _enabled;
}

/** Eager initialization — call at startup. */
export async function initDb() {
  await init();
  return _enabled;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _enabled = false;
  }
}
