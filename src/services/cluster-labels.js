// Display names for clusters ("Dell AI Factory - Private AI" for cluster02-gpu).
//
// Only what the cluster cards show changes: the cluster's ID stays the key for
// the agent, credentials, chat state and Private AI settings, so renaming never
// breaks a connection. Stored like the Private AI settings: kv_store, with a
// JSON file fallback.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

const DB_KEY = "cluster_labels";
const FILE_PATH = process.env.CLUSTER_LABELS_PATH || "/data/mcp-cluster-labels.json";
const MAX = 60;

let _labels = {};

export function clusterLabels() { return { ..._labels }; }

/** Letters, digits, spaces and simple punctuation; trimmed; at most 60 characters. */
export function cleanLabel(s) {
  if (typeof s !== "string") return null;
  const v = s.replace(/\s+/g, " ").trim();
  if (!v) return "";
  if (v.length > MAX) throw Object.assign(new Error(`A display name is at most ${MAX} characters`), { status: 400 });
  if (!/^[\p{L}\p{N} .,:;()&+/'’·–—_-]+$/u.test(v)) throw Object.assign(new Error("Use letters, digits, spaces and simple punctuation"), { status: 400 });
  return v;
}

export async function restoreClusterLabels() {
  try {
    if (await dbEnabled()) {
      const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [DB_KEY]);
      let v = r?.rows?.[0]?.value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
      if (v && typeof v === "object") { _labels = { ...v }; return clusterLabels(); }
    }
  } catch { /* fall through */ }
  try {
    const v = JSON.parse(await readFile(FILE_PATH, "utf8"));
    if (v && typeof v === "object") _labels = { ...v };
  } catch { /* nothing stored */ }
  return clusterLabels();
}

/** Set (or with "" clear) the display name of one cluster. */
export async function setClusterLabel(cluster, label) {
  if (typeof cluster !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(cluster)) throw Object.assign(new Error("Not a valid cluster ID"), { status: 400 });
  const v = cleanLabel(label);
  if (v === null) throw Object.assign(new Error("label must be a string"), { status: 400 });
  const next = { ..._labels };
  if (v) next[cluster] = v; else delete next[cluster];
  _labels = next;
  let storage = "memory";
  try {
    if (await dbEnabled()) {
      await dbQuery(
        `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [DB_KEY, JSON.stringify(next)]
      );
      storage = "database";
    }
  } catch { /* DB optional */ }
  if (storage === "memory") {
    try {
      await mkdir(dirname(FILE_PATH), { recursive: true }).catch(() => {});
      await writeFile(FILE_PATH, JSON.stringify(next, null, 2), "utf8");
      storage = "file";
    } catch { /* file optional */ }
  }
  return { cluster, label: v || null, storage };
}

export function _resetClusterLabels() { _labels = {}; }
