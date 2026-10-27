// Keeps the Private AI Factory's records across restarts: the AI traffic log and
// its counters, guardrail events, the session start and egress state, and the
// headline trend lines. Stored in PostgreSQL (kv_store, on the database's
// persistent volume); without a database, in /data as a fallback.
//
// Writes are batched: a change schedules one save a few seconds later, so a busy
// chat does not write on every token. Questions in the log are already masked by
// the router before they are kept, so nothing sensitive is stored.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { query as dbQuery, isEnabled as dbEnabled } from "../../utils/db.js";

const DB_KEY = "private_ai_factory_state";
const FILE_PATH = process.env.PRIVATE_AI_STATE_PATH || "/data/mcp-private-ai-state.json";
const DELAY_MS = Number(process.env.PRIVATE_AI_STATE_SAVE_MS) || 3000;

let _parts = {};          // name → { exportState, importState }
let _timer = null;
let _lastSaved = null;
let _storage = "memory";

/** Register a module whose state is saved: exportState() → JSON-able, importState(obj). */
export function registerPart(name, part) { _parts[name] = part; }

/** Called by a module whenever its state changed. */
export function changed() {
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; save().catch(() => {}); }, DELAY_MS);
  if (_timer.unref) _timer.unref();
}

export async function save() {
  const state = { savedAt: new Date().toISOString() };
  for (const [name, p] of Object.entries(_parts)) { try { state[name] = p.exportState(); } catch { /* skip that part */ } }
  try {
    if (await dbEnabled()) {
      await dbQuery(`INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`, [DB_KEY, JSON.stringify(state)]);
      _storage = "database"; _lastSaved = state.savedAt; return _storage;
    }
  } catch { /* fall back to the file */ }
  try {
    await mkdir(dirname(FILE_PATH), { recursive: true }).catch(() => {});
    await writeFile(FILE_PATH, JSON.stringify(state), "utf8");
    _storage = "file";
  } catch { _storage = "memory"; }
  _lastSaved = state.savedAt;
  return _storage;
}

/** Load the saved state into every registered module. Called once at startup; never throws. */
export async function restore() {
  let state = null;
  try {
    if (await dbEnabled()) {
      const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [DB_KEY]);
      let v = r?.rows?.[0]?.value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
      if (v && typeof v === "object") { state = v; _storage = "database"; }
    }
  } catch { /* fall through */ }
  if (!state) {
    try { const v = JSON.parse(await readFile(FILE_PATH, "utf8")); if (v && typeof v === "object") { state = v; _storage = "file"; } } catch { /* nothing saved */ }
  }
  if (!state) return { restored: false };
  for (const [name, p] of Object.entries(_parts)) { if (state[name]) { try { p.importState(state[name]); } catch { /* keep defaults */ } } }
  _lastSaved = state.savedAt || null;
  return { restored: true, savedAt: _lastSaved, storage: _storage };
}

export function persistStatus() { return { storage: _storage, lastSaved: _lastSaved }; }
export function _resetPersist() { _parts = {}; if (_timer) clearTimeout(_timer); _timer = null; _lastSaved = null; _storage = "memory"; }
