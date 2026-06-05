-- OpenShift MCP Server — PostgreSQL schema
-- This is also applied automatically at startup by src/utils/db.js,
-- but you can run it manually with:
--   psql "$DATABASE_URL" -f db/schema.sql

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,         -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  html TEXT,                  -- optional rendered HTML for assistant replies
  provider TEXT,              -- llm provider used, if any
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

-- Pending actions — approval workflow for mutating operations.
-- Lifecycle: pending_confirmation -> awaiting_approval -> approved -> executed
--                                   \                  \           \
--                                    -> cancelled       -> rejected  -> failed
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  action TEXT NOT NULL,          -- 'restart' | 'delete' | 'scale'
  resource_type TEXT NOT NULL,   -- 'pod' | 'deployment' | 'daemonset' | 'statefulset' | ...
  resource_name TEXT NOT NULL,
  namespace TEXT,
  options JSONB,                 -- e.g. { replicas: 5 } for scale
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

-- Upgrade orchestrator — state machine for automated cluster upgrade lifecycle.
-- Each conversation can have at most one active upgrade session.
CREATE TABLE IF NOT EXISTS upgrade_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
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
