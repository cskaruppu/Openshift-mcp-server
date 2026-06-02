/**
 * Chat history service — DB-backed persistence for conversations.
 *
 * Falls back gracefully to "disabled" when PostgreSQL is not configured;
 * the dashboard then keeps using browser localStorage.
 */

import { query, isEnabled as dbEnabled } from "../utils/db.js";

function newId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

/** True if persistent chat history is available. */
export async function isHistoryEnabled() {
  return dbEnabled();
}

/**
 * List conversations, newest first.
 * @param {number} limit
 * @param {string|null} cluster - when provided, only chats for that cluster
 *   are returned (per-cluster single pane of glass). Omit/null = all clusters.
 */
export async function listChats(limit = 100, cluster = null) {
  const filterCluster = cluster && cluster !== "all";
  const r = await query(
    `SELECT c.id,
            c.title,
            c.starred,
            c.locked,
            c.cluster,
            c.created_at,
            c.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
      ${filterCluster ? "WHERE c.cluster = $2" : ""}
      ORDER BY c.starred DESC, c.updated_at DESC
      LIMIT $1`,
    filterCluster ? [limit, cluster] : [limit]
  );
  if (!r) return [];
  return r.rows.map((row) => ({
    id: row.id,
    title: row.title,
    starred: row.starred || false,
    locked: row.locked || false,
    cluster: row.cluster || "local",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count) || 0,
  }));
}

/** Get a single conversation with its messages. */
export async function getChat(id) {
  const conv = await query(
    `SELECT id, title, starred, locked, created_at, updated_at FROM conversations WHERE id = $1`,
    [id]
  );
  if (!conv || conv.rowCount === 0) return null;

  const msgs = await query(
    `SELECT id, role, content, html, provider, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY id ASC`,
    [id]
  );

  const c = conv.rows[0];
  return {
    id: c.id,
    title: c.title,
    starred: c.starred || false,
    locked: c.locked || false,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    messages: (msgs?.rows || []).map((m) => ({
      id: Number(m.id),
      role: m.role,
      content: m.content,
      html: m.html,
      provider: m.provider,
      createdAt: m.created_at,
    })),
  };
}

/** Create a new conversation, tagged with the cluster it belongs to. */
export async function createChat({ id, title, cluster } = {}) {
  const cid = id || newId();
  const t = title || "New chat";
  const cl = cluster || "local";
  const r = await query(
    `INSERT INTO conversations (id, title, cluster) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, cluster = EXCLUDED.cluster, updated_at = NOW()
     RETURNING id, title, cluster, created_at, updated_at`,
    [cid, t, cl]
  );
  if (!r || r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    title: row.title,
    cluster: row.cluster || "local",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: [],
  };
}

/** Append a message to a conversation, creating the conversation if needed. */
export async function addMessage(conversationId, { role, content, html, provider, cluster }) {
  if (!conversationId) return null;

  // Make sure the conversation exists, tagged with the originating cluster.
  await query(
    `INSERT INTO conversations (id, title, cluster) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [conversationId, role === "user" ? truncateTitle(content) : "New chat", cluster || "local"]
  );

  const r = await query(
    `INSERT INTO messages (conversation_id, role, content, html, provider)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
    [conversationId, role, content || "", html || null, provider || null]
  );
  if (!r) return null;

  // Auto-set title from first user message
  if (role === "user") {
    await query(
      `UPDATE conversations
          SET title = CASE
                        WHEN title = 'New chat' OR title IS NULL OR title = ''
                        THEN $2
                        ELSE title
                      END,
              updated_at = NOW()
        WHERE id = $1`,
      [conversationId, truncateTitle(content)]
    );
  } else {
    await query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
      [conversationId]
    );
  }

  return {
    id: Number(r.rows[0].id),
    createdAt: r.rows[0].created_at,
  };
}

/** Update a message's content by DB id. */
export async function updateMessage(conversationId, messageId, { content, html }) {
  const r = await query(
    `UPDATE messages SET content = $1, html = $2
      WHERE id = $3 AND conversation_id = $4
      RETURNING id`,
    [content, html || null, messageId, conversationId]
  );
  return r && r.rowCount > 0;
}

/** Find a message by content substring and replace it. */
export async function replaceMessageContent(conversationId, search, newContent) {
  const r = await query(
    `UPDATE messages SET content = $1, html = NULL
      WHERE id = (
        SELECT id FROM messages
        WHERE conversation_id = $2 AND content LIKE '%' || $3 || '%'
        ORDER BY id DESC LIMIT 1
      )
      RETURNING id`,
    [newContent, conversationId, search]
  );
  return r && r.rowCount > 0;
}

/** Update conversation title. */
export async function updateTitle(id, title) {
  const r = await query(
    `UPDATE conversations SET title = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, title`,
    [id, truncateTitle(title)]
  );
  return r && r.rowCount > 0;
}

/** Toggle or set the starred flag on a conversation. */
export async function updateStarred(id, starred) {
  const r = await query(
    `UPDATE conversations SET starred = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, starred`,
    [id, Boolean(starred)]
  );
  return r && r.rowCount > 0;
}

/** Toggle or set the locked flag on a conversation. */
export async function updateLocked(id, locked) {
  const r = await query(
    `UPDATE conversations SET locked = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, locked`,
    [id, Boolean(locked)]
  );
  return r && r.rowCount > 0;
}

/** Check if a chat is locked. Returns null if chat not found. */
export async function isLocked(id) {
  const r = await query(`SELECT locked FROM conversations WHERE id = $1`, [id]);
  if (!r || r.rowCount === 0) return null;
  return Boolean(r.rows[0].locked);
}

/** Search conversations by title or message content (optionally scoped to a cluster). */
export async function searchChats(term, limit = 50, cluster = null) {
  if (!term || !term.trim()) return [];
  const pattern = `%${term.trim()}%`;
  const filterCluster = cluster && cluster !== "all";
  const r = await query(
    `SELECT DISTINCT c.id,
            c.title,
            c.starred,
            c.locked,
            c.cluster,
            c.created_at,
            c.updated_at,
            (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = c.id) AS message_count,
            (SELECT m3.content FROM messages m3
             WHERE m3.conversation_id = c.id AND m3.content ILIKE $1
             ORDER BY m3.id LIMIT 1) AS matched_snippet
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE (c.title ILIKE $1 OR m.content ILIKE $1)${filterCluster ? " AND c.cluster = $3" : ""}
      ORDER BY c.starred DESC, c.updated_at DESC
      LIMIT $2`,
    filterCluster ? [pattern, limit, cluster] : [pattern, limit]
  );
  if (!r) return [];
  return r.rows.map((row) => ({
    id: row.id,
    title: row.title,
    starred: row.starred || false,
    locked: row.locked || false,
    cluster: row.cluster || "local",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count) || 0,
    matchedSnippet: row.matched_snippet || null,
  }));
}

/** Delete a conversation and its messages. */
export async function deleteChat(id) {
  const r = await query(`DELETE FROM conversations WHERE id = $1`, [id]);
  return r && r.rowCount > 0;
}

/** Insert a row into query_log. Best-effort, never throws. */
export async function logQuery({
  conversationId,
  query: q,
  intents,
  cacheHit,
  durationMs,
}) {
  await query(
    `INSERT INTO query_log (conversation_id, query, intents, cache_hit, duration_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      conversationId || null,
      q || "",
      Array.isArray(intents) ? intents : null,
      Boolean(cacheHit),
      Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    ]
  );
}

/** Insert a row into executed_actions. */
export async function logExecutedAction({
  conversationId,
  action,
  target,
  namespace,
  success,
  result,
}) {
  await query(
    `INSERT INTO executed_actions (conversation_id, action, target, namespace, success, result)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      conversationId || null,
      action || "",
      target || null,
      namespace || null,
      success == null ? null : Boolean(success),
      result == null ? null : JSON.stringify(result),
    ]
  );
}

function truncateTitle(s) {
  if (!s) return "New chat";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 77) + "..." : t || "New chat";
}
