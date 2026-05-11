/**
 * Persistent Memory Service (Pillar 3).
 *
 * Three layers of memory beyond the existing per-conversation memory:
 *  1. user_preferences  → per-user defaults (default namespace, verbosity,
 *                         preferred clusters, response format)
 *  2. team_knowledge    → shared facts/playbooks contributed by team members
 *  3. user_facts        → things the AI learned about a specific user
 *                         ("I always work on production cluster X")
 *
 * All writes are best-effort. If no DB is configured, the service falls back
 * to an in-memory Map (process lifetime only).
 */

import { query, isEnabled } from "../utils/db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  default_namespace TEXT,
  default_cluster TEXT,
  preferred_provider TEXT,
  verbosity TEXT DEFAULT 'normal',
  persona TEXT DEFAULT 'sre',
  show_costs BOOLEAN DEFAULT FALSE,
  auto_apply_recommendations BOOLEAN DEFAULT FALSE,
  prefs JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_facts (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  source TEXT,
  weight REAL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, fact_type, fact_value)
);
CREATE INDEX IF NOT EXISTS idx_user_facts_user ON user_facts(user_id, fact_type);

CREATE TABLE IF NOT EXISTS team_knowledge (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[],
  contributed_by TEXT,
  helpful_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_knowledge_topic ON team_knowledge(topic);
CREATE INDEX IF NOT EXISTS idx_team_knowledge_tags ON team_knowledge USING GIN(tags);
`;

let _schemaEnsured = false;
async function ensureMemorySchema() {
  if (_schemaEnsured) return;
  if (!(await isEnabled())) return;
  try {
    await query(SCHEMA);
    _schemaEnsured = true;
  } catch (err) {
    console.error("[memory] schema init failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback (process lifetime only)
// ---------------------------------------------------------------------------
const _memPrefs = new Map();    // userId -> prefs object
const _memFacts = new Map();    // userId -> [{type, value, ...}]
const _memTeamKB = [];          // [{ topic, content, tags, ... }]

// ---------------------------------------------------------------------------
// User Preferences
// ---------------------------------------------------------------------------

const DEFAULT_PREFS = {
  defaultNamespace: null,
  defaultCluster: null,
  preferredProvider: null,
  verbosity: "normal",      // terse | normal | detailed
  persona: "sre",           // sre | developer | manager | security
  showCosts: false,
  autoApplyRecommendations: false,
  prefs: {},
};

export async function getUserPreferences(userId) {
  if (!userId) return { ...DEFAULT_PREFS };
  await ensureMemorySchema();
  if (!(await isEnabled())) {
    return _memPrefs.get(userId) || { ...DEFAULT_PREFS, userId };
  }
  try {
    const res = await query(
      `SELECT default_namespace, default_cluster, preferred_provider,
              verbosity, persona, show_costs, auto_apply_recommendations, prefs
       FROM user_preferences WHERE user_id = $1`,
      [userId]
    );
    if (!res?.rows?.length) return { ...DEFAULT_PREFS, userId };
    const r = res.rows[0];
    return {
      userId,
      defaultNamespace: r.default_namespace || null,
      defaultCluster: r.default_cluster || null,
      preferredProvider: r.preferred_provider || null,
      verbosity: r.verbosity || "normal",
      persona: r.persona || "sre",
      showCosts: !!r.show_costs,
      autoApplyRecommendations: !!r.auto_apply_recommendations,
      prefs: r.prefs || {},
    };
  } catch (err) {
    return { ...DEFAULT_PREFS, userId };
  }
}

export async function setUserPreferences(userId, updates) {
  if (!userId) return false;
  await ensureMemorySchema();

  if (!(await isEnabled())) {
    const existing = _memPrefs.get(userId) || { ...DEFAULT_PREFS, userId };
    _memPrefs.set(userId, { ...existing, ...updates });
    return true;
  }

  const fields = {
    default_namespace: updates.defaultNamespace,
    default_cluster: updates.defaultCluster,
    preferred_provider: updates.preferredProvider,
    verbosity: updates.verbosity,
    persona: updates.persona,
    show_costs: updates.showCosts,
    auto_apply_recommendations: updates.autoApplyRecommendations,
    prefs: updates.prefs,
  };

  try {
    await query(
      `INSERT INTO user_preferences
       (user_id, default_namespace, default_cluster, preferred_provider,
        verbosity, persona, show_costs, auto_apply_recommendations, prefs, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         default_namespace = COALESCE(EXCLUDED.default_namespace, user_preferences.default_namespace),
         default_cluster = COALESCE(EXCLUDED.default_cluster, user_preferences.default_cluster),
         preferred_provider = COALESCE(EXCLUDED.preferred_provider, user_preferences.preferred_provider),
         verbosity = COALESCE(EXCLUDED.verbosity, user_preferences.verbosity),
         persona = COALESCE(EXCLUDED.persona, user_preferences.persona),
         show_costs = COALESCE(EXCLUDED.show_costs, user_preferences.show_costs),
         auto_apply_recommendations = COALESCE(EXCLUDED.auto_apply_recommendations, user_preferences.auto_apply_recommendations),
         prefs = COALESCE(EXCLUDED.prefs, user_preferences.prefs),
         updated_at = NOW()`,
      [
        userId,
        fields.default_namespace ?? null,
        fields.default_cluster ?? null,
        fields.preferred_provider ?? null,
        fields.verbosity ?? null,
        fields.persona ?? null,
        fields.show_costs ?? null,
        fields.auto_apply_recommendations ?? null,
        fields.prefs ? JSON.stringify(fields.prefs) : null,
      ]
    );
    return true;
  } catch (err) {
    console.error("[memory] setUserPreferences failed:", err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// User Facts — things learned about the user during conversations
// ---------------------------------------------------------------------------

const FACT_TYPES = [
  "frequent_namespace",   // namespaces user often references
  "frequent_cluster",
  "frequent_resource",
  "preferred_format",     // table | yaml | json
  "asked_about",          // topics they've asked about
];

export async function recordUserFact({ userId, factType, factValue, source }) {
  if (!userId || !factType || !factValue) return;
  if (!FACT_TYPES.includes(factType)) return;
  await ensureMemorySchema();

  if (!(await isEnabled())) {
    const arr = _memFacts.get(userId) || [];
    const idx = arr.findIndex((f) => f.type === factType && f.value === factValue);
    if (idx >= 0) { arr[idx].weight = (arr[idx].weight || 1) + 1; arr[idx].lastUsed = Date.now(); }
    else arr.push({ type: factType, value: factValue, weight: 1, source, lastUsed: Date.now() });
    _memFacts.set(userId, arr);
    return;
  }

  try {
    await query(
      `INSERT INTO user_facts (user_id, fact_type, fact_value, source, weight, last_used)
       VALUES ($1, $2, $3, $4, 1.0, NOW())
       ON CONFLICT (user_id, fact_type, fact_value) DO UPDATE SET
         weight = user_facts.weight + 1,
         last_used = NOW()`,
      [userId, factType, factValue, source || null]
    );
  } catch (err) {
    // silent
  }
}

export async function getUserFacts(userId, factType, limit = 10) {
  if (!userId) return [];
  await ensureMemorySchema();

  if (!(await isEnabled())) {
    const arr = _memFacts.get(userId) || [];
    return arr
      .filter((f) => !factType || f.type === factType)
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, limit);
  }

  try {
    const conditions = ["user_id = $1"];
    const params = [userId];
    if (factType) { params.push(factType); conditions.push(`fact_type = $${params.length}`); }
    params.push(limit);
    const res = await query(
      `SELECT fact_type AS type, fact_value AS value, weight, last_used
       FROM user_facts WHERE ${conditions.join(" AND ")}
       ORDER BY weight DESC, last_used DESC LIMIT $${params.length}`,
      params
    );
    return res?.rows || [];
  } catch (err) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Team Knowledge Base
// ---------------------------------------------------------------------------

export async function addTeamKnowledge({ topic, content, tags, contributedBy }) {
  if (!topic || !content) return null;
  await ensureMemorySchema();

  if (!(await isEnabled())) {
    const entry = {
      id: _memTeamKB.length + 1,
      topic, content,
      tags: Array.isArray(tags) ? tags : [],
      contributedBy: contributedBy || null,
      helpfulCount: 0,
      createdAt: Date.now(),
    };
    _memTeamKB.push(entry);
    return entry;
  }

  try {
    const res = await query(
      `INSERT INTO team_knowledge (topic, content, tags, contributed_by)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [topic, content, Array.isArray(tags) ? tags : null, contributedBy || null]
    );
    return res?.rows?.[0] || null;
  } catch (err) {
    console.error("[memory] addTeamKnowledge failed:", err.message);
    return null;
  }
}

export async function searchTeamKnowledge(searchTerms, limit = 5) {
  await ensureMemorySchema();
  const terms = Array.isArray(searchTerms) ? searchTerms : String(searchTerms || "").split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  if (!(await isEnabled())) {
    return _memTeamKB
      .filter((e) => terms.some((t) =>
        e.topic.toLowerCase().includes(t.toLowerCase()) ||
        e.content.toLowerCase().includes(t.toLowerCase()) ||
        (e.tags && e.tags.some((tag) => tag.toLowerCase().includes(t.toLowerCase())))
      ))
      .sort((a, b) => (b.helpfulCount || 0) - (a.helpfulCount || 0))
      .slice(0, limit);
  }

  const ilikePatterns = terms.map((t) => "%" + t + "%");
  try {
    const res = await query(
      `SELECT id, topic, content, tags, contributed_by, helpful_count, created_at
       FROM team_knowledge
       WHERE topic ILIKE ANY($1::text[]) OR content ILIKE ANY($1::text[])
       ORDER BY helpful_count DESC, created_at DESC LIMIT $2`,
      [ilikePatterns, limit]
    );
    return res?.rows || [];
  } catch (err) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helper: extract default user ID from a request (header-based for now)
// In the future this will pull from OAuth bearer token or OpenShift identity
// ---------------------------------------------------------------------------
export function getUserIdFromRequest(req) {
  // Priority: X-User-Id header > X-Forwarded-User > conversation user
  const h = req?.headers || {};
  return h["x-user-id"] || h["x-forwarded-user"] || h["x-remote-user"] || null;
}

// ---------------------------------------------------------------------------
// Build a context string for the LLM system prompt
// ---------------------------------------------------------------------------
export async function buildUserContextString(userId) {
  if (!userId) return "";
  const [prefs, facts] = await Promise.all([
    getUserPreferences(userId),
    getUserFacts(userId, null, 5),
  ]);
  const parts = [];
  if (prefs.persona && prefs.persona !== "sre") parts.push(`User role: ${prefs.persona}`);
  if (prefs.verbosity && prefs.verbosity !== "normal") parts.push(`Response verbosity: ${prefs.verbosity}`);
  if (prefs.defaultNamespace) parts.push(`Default namespace: ${prefs.defaultNamespace}`);
  if (prefs.defaultCluster) parts.push(`Default cluster: ${prefs.defaultCluster}`);
  if (facts.length > 0) {
    const factSummary = facts.map((f) => `${f.type}=${f.value}`).join(", ");
    parts.push(`Known facts: ${factSummary}`);
  }
  return parts.length ? `\n\nUser context (from memory): ${parts.join(" | ")}` : "";
}
