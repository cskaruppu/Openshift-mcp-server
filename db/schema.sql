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
