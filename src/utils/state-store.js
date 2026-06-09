/**
 * State store — single persistence helper for server settings/state.
 *
 * PostgreSQL kv_store is the source of truth (management plane). A JSON file
 * path may be given as fallback so standalone/dev deployments without a DB
 * keep working. This is what makes the MCP server pod stateless: with a DB
 * configured, nothing of value lives on the pod filesystem.
 *
 * Reads:  DB first, then legacy file (migration path for pre-DB deployments).
 * Writes: DB first; file is best-effort dual-write for fallback/debugging.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { query as dbQuery, isEnabled as dbEnabled } from "./db.js";

/** Load a JSON value by key. Returns null when not found anywhere. */
export async function loadState(key, filePath = null) {
  if (await dbEnabled()) {
    try {
      const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [key]);
      if (r?.rows?.length > 0) {
        const v = r.rows[0].value;
        return typeof v === "string" ? JSON.parse(v) : v;
      }
    } catch { /* fall through to file */ }
  }
  if (filePath) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch { /* not found */ }
  }
  return null;
}

/** Save a JSON value by key. Returns true when persisted durably (DB). */
export async function saveState(key, value, filePath = null) {
  let dbSaved = false;
  if (await dbEnabled()) {
    try {
      await dbQuery(
        `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
      dbSaved = true;
    } catch { /* fall through to file */ }
  }
  if (filePath) {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
    } catch (err) {
      if (!dbSaved) throw err;
    }
  }
  return dbSaved;
}

/** Delete a stored key (DB only; files are left for manual cleanup). */
export async function deleteState(key) {
  if (await dbEnabled()) {
    try {
      await dbQuery("DELETE FROM kv_store WHERE key = $1", [key]);
      return true;
    } catch { /* ignore */ }
  }
  return false;
}
