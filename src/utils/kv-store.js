/**
 * A small key/value store for service records: the database's kv_store table
 * when there is one, else a JSON file per key (STATE_DIR, default /data).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { query as dbQuery, isEnabled as dbEnabled } from "./db.js";

const dir = () => process.env.KV_STATE_DIR || process.env.OPS_TWIN_STATE_DIR || "/data";

export async function kvGet(key) {
  try {
    if (await dbEnabled()) {
      const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [key]);
      let v = r?.rows?.[0]?.value;
      if (typeof v === "string") v = JSON.parse(v);
      return v || null;
    }
  } catch { /* fall through to the file */ }
  try { return JSON.parse(await readFile(`${dir()}/mcp-${key}.json`, "utf8")); } catch { return null; }
}

export async function kvSet(key, value) {
  const json = JSON.stringify(value);
  try {
    if (await dbEnabled()) {
      await dbQuery("INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()", [key, json]);
      return;
    }
  } catch { /* fall through to the file */ }
  try { await mkdir(dir(), { recursive: true }); await writeFile(`${dir()}/mcp-${key}.json`, json, "utf8"); } catch { /* memory only */ }
}

export const kvStore = { get: kvGet, set: kvSet };
