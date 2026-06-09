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
  starred BOOLEAN NOT NULL DEFAULT FALSE,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  cluster TEXT NOT NULL DEFAULT 'local',
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
  cluster TEXT NOT NULL DEFAULT 'local',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_query_log_created ON query_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_log_cluster ON query_log(cluster, created_at DESC);

CREATE TABLE IF NOT EXISTS executed_actions (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  namespace TEXT,
  success BOOLEAN,
  result JSONB,
  cluster TEXT NOT NULL DEFAULT 'local',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_executed_actions_created ON executed_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executed_actions_cluster ON executed_actions(cluster, created_at DESC);

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

CREATE TABLE IF NOT EXISTS health_reports (
  id BIGSERIAL PRIMARY KEY,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_health_reports_created ON health_reports(created_at DESC);

CREATE TABLE IF NOT EXISTS message_feedback (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT,
  message_id TEXT,
  rating SMALLINT NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_message_feedback_conv ON message_feedback(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_suppressions (
  fingerprint TEXT PRIMARY KEY,
  suppressed_until TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS silenced_alerts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT '',
  cluster TEXT NOT NULL DEFAULT 'local',
  silenced_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_silenced_alerts_lookup ON silenced_alerts (name, namespace, cluster);
CREATE INDEX IF NOT EXISTS idx_silenced_alerts_expiry ON silenced_alerts (expires_at);

CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 1: per-cluster snapshot store (ACM/Rancher-style warm cache).
-- One row per cluster, upserted on every agent report. Scales to any number
-- of clusters without write amplification, survives hub restarts, and is the
-- authoritative read source for the dashboard when the store is enabled.
CREATE TABLE IF NOT EXISTS cluster_snapshots (
  cluster TEXT PRIMARY KEY,
  platform TEXT,
  report JSONB NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cluster_snapshots_reported ON cluster_snapshots (reported_at DESC);

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  namespaces TEXT[] DEFAULT '{}',
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  force_password_change BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  sys_id TEXT,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  title TEXT,
  target_version TEXT,
  from_version TEXT,
  channel TEXT,
  upgrade_type TEXT,
  scheduled_date TIMESTAMPTZ,
  preflight_report JSONB,
  metadata JSONB,
  cluster TEXT NOT NULL DEFAULT 'local',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cr_status ON change_requests (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cr_ticket ON change_requests (ticket_id);
CREATE INDEX IF NOT EXISTS idx_cr_cluster ON change_requests (cluster, updated_at DESC);

CREATE TABLE IF NOT EXISTS upgrade_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  cluster TEXT NOT NULL DEFAULT 'local',
  state TEXT NOT NULL DEFAULT 'idle',
  from_version TEXT,
  target_version TEXT,
  channel TEXT,
  upgrade_type TEXT,
  preflight_report JSONB,
  component_analysis JSONB,
  remediation_plan JSONB,
  remediation_results JSONB,
  cr_ticket_id TEXT,
  cr_sys_id TEXT,
  dry_run_result JSONB,
  post_assessment JSONB,
  monitoring_data JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_upgrade_sessions_conv ON upgrade_sessions(conversation_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_upgrade_sessions_state ON upgrade_sessions(state, updated_at DESC);
`;

async function ensureSchema() {
  if (!_pool) return;
  try {
    await _pool.query(SCHEMA_SQL);
    await _pool.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE
    `).catch(() => {});
    await _pool.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE
    `).catch(() => {});
    await _pool.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS cluster TEXT NOT NULL DEFAULT 'local'
    `).catch(() => {});
    await _pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_cluster ON conversations(cluster, updated_at DESC)
    `).catch(() => {});
    await _pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ DEFAULT NOW()
    `).catch(() => {});
    await _pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT FALSE
    `).catch(() => {});
    // Phase A: cluster columns for audit/intelligence tables
    await _pool.query(`
      ALTER TABLE executed_actions ADD COLUMN IF NOT EXISTS cluster TEXT NOT NULL DEFAULT 'local'
    `).catch(() => {});
    await _pool.query(`
      CREATE INDEX IF NOT EXISTS idx_executed_actions_cluster ON executed_actions(cluster, created_at DESC)
    `).catch(() => {});
    await _pool.query(`
      ALTER TABLE query_log ADD COLUMN IF NOT EXISTS cluster TEXT NOT NULL DEFAULT 'local'
    `).catch(() => {});
    await _pool.query(`
      CREATE INDEX IF NOT EXISTS idx_query_log_cluster ON query_log(cluster, created_at DESC)
    `).catch(() => {});
    await _pool.query(`
      ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS cluster TEXT NOT NULL DEFAULT 'local'
    `).catch(() => {});
    await _pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cr_cluster ON change_requests(cluster, updated_at DESC)
    `).catch(() => {});
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

// ---------------------------------------------------------------------------
// Phase 1: per-cluster snapshot store
// ---------------------------------------------------------------------------

/**
 * Upsert a single cluster's latest report. One row per cluster — scales to any
 * number of clusters and avoids rewriting all clusters on every report.
 */
export async function saveClusterSnapshot(cluster, platform, report) {
  if (!cluster || !report) return false;
  const r = await query(
    `INSERT INTO cluster_snapshots (cluster, platform, report, reported_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (cluster)
     DO UPDATE SET platform = $2, report = $3, reported_at = NOW(), updated_at = NOW()`,
    [cluster, platform || null, JSON.stringify(report)]
  );
  return !!r;
}

/** Load one cluster's latest snapshot, or null. */
export async function loadClusterSnapshot(cluster) {
  if (!cluster) return null;
  const r = await query(
    "SELECT cluster, platform, report, reported_at FROM cluster_snapshots WHERE cluster = $1",
    [cluster]
  );
  if (!r?.rows?.length) return null;
  const row = r.rows[0];
  return {
    cluster: row.cluster,
    platform: row.platform,
    report: typeof row.report === "string" ? JSON.parse(row.report) : row.report,
    reportedAt: row.reported_at,
  };
}

/** Load all cluster snapshots (used for startup hydration). */
export async function loadAllClusterSnapshots() {
  const r = await query(
    "SELECT cluster, platform, report, reported_at FROM cluster_snapshots ORDER BY reported_at DESC"
  );
  if (!r?.rows?.length) return [];
  return r.rows.map((row) => ({
    cluster: row.cluster,
    platform: row.platform,
    report: typeof row.report === "string" ? JSON.parse(row.report) : row.report,
    reportedAt: row.reported_at,
  }));
}

/** Remove a cluster's snapshot (on cluster removal). */
export async function deleteClusterSnapshot(cluster) {
  if (!cluster) return;
  await query("DELETE FROM cluster_snapshots WHERE cluster = $1", [cluster]);
}
