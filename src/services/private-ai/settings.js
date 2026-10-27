// Private AI switches an admin can flip in Settings → Private AI, without
// editing the Deployment.
//
//   commandCenter  the Command Center and its launchers
//   banner         the launch banner on the dashboard (needs commandCenter)
//   routeChat      AI Chat defaults to the on-prem models
//   cluster        the cluster with the GPUs and the demo app ("local" = the hub)
//
// A saved value wins over the environment, which is only the starting point
// (PRIVATE_AI_OPS, COMMAND_CENTER_BANNER, LLM_PROVIDER=private). The one
// exception is PRIVATE_AI_OPS=false: the deployment has switched the feature
// off and Settings cannot turn it back on — that is what disable.sh sets.
//
// Stored like the incident settings: kv_store, with a JSON file fallback.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { query as dbQuery, isEnabled as dbEnabled } from "../../utils/db.js";

const DB_KEY = "private_ai_settings";
const FILE_PATH = process.env.PRIVATE_AI_SETTINGS_PATH || "/data/mcp-private-ai-settings.json";
const KEYS = ["commandCenter", "banner", "routeChat"];

// demoTabs: how the stage demo appears in the Private AI Factory —
//   "event" numbered acts under "Live demo" (the presenter's running order)
//   "product" the same views under feature names, no numbers
//   "hidden" not shown (customers see Overview, Models, GPU fleet, Usage only)
export const DEMO_TABS = ["event", "product", "hidden"];
const EMPTY = { commandCenter: null, banner: null, routeChat: null, cluster: null, demoTabs: null, updatedBy: null, updatedAt: null };
let _saved = { ...EMPTY };

const validCluster = (c) => typeof c === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(c);
const pick = (raw = {}) => ({ ...Object.fromEntries(KEYS.map((k) => [k, typeof raw[k] === "boolean" ? raw[k] : null])), cluster: validCluster(raw.cluster) ? raw.cluster : null,
  demoTabs: DEMO_TABS.includes(raw.demoTabs) ? raw.demoTabs : null });

export function lockedOff() { return process.env.PRIVATE_AI_OPS === "false"; }

/** What is in force right now, and where each value came from. */
export function effectiveSettings() {
  const locked = lockedOff();
  const commandCenter = !locked && (_saved.commandCenter ?? process.env.PRIVATE_AI_OPS === "true");
  const banner = commandCenter && (_saved.banner ?? process.env.COMMAND_CENTER_BANNER === "true");
  const routeChat = !locked && (_saved.routeChat ?? (process.env.LLM_PROVIDER || "").toLowerCase() === "private");
  const source = (k) => (locked ? "deployment" : _saved[k] !== null ? "settings" : "environment");
  return {
    commandCenter, banner, routeChat, lockedOff: locked,
    cluster: _saved.cluster || process.env.PRIVATE_AI_CLUSTER || "local",
    demoTabs: _saved.demoTabs || (DEMO_TABS.includes(process.env.PRIVATE_AI_DEMO_TABS) ? process.env.PRIVATE_AI_DEMO_TABS : "event"),
    source: { commandCenter: source("commandCenter"), banner: source("banner"), routeChat: source("routeChat") },
    updatedBy: _saved.updatedBy, updatedAt: _saved.updatedAt,
  };
}

/** Read the stored switches into memory. Called once at startup; never throws. */
export async function restorePrivateAiSettings() {
  try {
    if (await dbEnabled()) {
      const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [DB_KEY]);
      let v = r?.rows?.[0]?.value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
      if (v && typeof v === "object") { _saved = { ...pick(v), updatedBy: v.updatedBy || null, updatedAt: v.updatedAt || null }; return effectiveSettings(); }
    }
  } catch { /* fall through */ }
  try {
    const v = JSON.parse(await readFile(FILE_PATH, "utf8"));
    if (v && typeof v === "object") _saved = { ...pick(v), updatedBy: v.updatedBy || null, updatedAt: v.updatedAt || null };
  } catch { /* nothing stored */ }
  return effectiveSettings();
}

/** Store the switches given in `patch` (true/false; null = back to the environment). */
export async function savePrivateAiSettings(patch, { actor = "admin" } = {}) {
  if (lockedOff()) throw Object.assign(new Error("Private AI is switched off by the deployment (PRIVATE_AI_OPS=false)"), { status: 409 });
  const next = { ..._saved };
  for (const k of KEYS) if (k in patch && (typeof patch[k] === "boolean" || patch[k] === null)) next[k] = patch[k];
  if ("demoTabs" in patch) {
    if (patch.demoTabs !== null && !DEMO_TABS.includes(patch.demoTabs)) throw Object.assign(new Error("Demo tabs: event, product or hidden"), { status: 400 });
    next.demoTabs = patch.demoTabs;
  }
  if ("cluster" in patch) {
    if (patch.cluster !== null && !validCluster(patch.cluster)) throw Object.assign(new Error("Not a valid cluster name"), { status: 400 });
    next.cluster = patch.cluster;
  }
  next.updatedBy = actor;
  next.updatedAt = new Date().toISOString();
  _saved = next;
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
  return { ...effectiveSettings(), storage };
}

export function _resetPrivateAiSettings() { _saved = { ...EMPTY }; }

/* ───────────── direct API access to the GPU cluster ─────────────
   Kept here, not in the platform's shared cluster credentials, so that
   connecting a cluster for the Command Center changes nothing about how the
   rest of the console reaches it. Tokens never leave the server. */

const ACCESS_KEY = "private_ai_cluster_access";
const ACCESS_FILE = process.env.PRIVATE_AI_ACCESS_PATH || "/data/mcp-private-ai-access.json";
let _access = {};

/** Clusters with direct access saved (the GPU clusters the Factory can read). */
export function accessClusters() { return Object.keys(_access); }
export function getClusterAccess(cluster) { return (cluster && _access[cluster]) || null; }
export function clusterAccessSummary(cluster) {
  const a = getClusterAccess(cluster);
  return a ? { apiUrl: a.apiUrl, customCa: !!a.caCert, savedBy: a.savedBy, savedAt: a.savedAt, source: a.source || "token",
    identity: a.identity || null, kind: a.kind || null, clusterAdmin: !!a.clusterAdmin, expiresAt: a.expiresAt || null, permanent: !!a.permanent } : null;
}

async function persistAccess() {
  try {
    if (await dbEnabled()) {
      await dbQuery(
        `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [ACCESS_KEY, JSON.stringify(_access)]
      );
      return "database";
    }
  } catch { /* DB optional */ }
  try {
    await mkdir(dirname(ACCESS_FILE), { recursive: true }).catch(() => {});
    await writeFile(ACCESS_FILE, JSON.stringify(_access), { encoding: "utf8", mode: 0o600 });
    return "file";
  } catch { return "memory"; }
}

export function validateAccess({ apiUrl, token, caCert } = {}) {
  if (typeof apiUrl !== "string" || !/^https:\/\/[^\s/]+(:\d+)?\/?$/.test(apiUrl.trim())) throw Object.assign(new Error("API URL must look like https://api.<cluster>:6443"), { status: 400 });
  if (typeof token !== "string" || token.trim().length < 20) throw Object.assign(new Error("A service account token is required"), { status: 400 });
  if (caCert != null && caCert !== "" && (typeof caCert !== "string" || !caCert.includes("BEGIN CERTIFICATE"))) throw Object.assign(new Error("The CA certificate must be PEM (-----BEGIN CERTIFICATE-----)"), { status: 400 });
  return { apiUrl: apiUrl.trim().replace(/\/+$/, ""), token: token.trim(), caCert: caCert ? caCert.trim() : null };
}

/** `info` is what inspectAccess found: identity, kind, clusterAdmin, expiresAt, permanent; `source` token | kubeconfig. */
export async function saveClusterAccess(cluster, input, { actor = "admin", info = {}, source = "token" } = {}) {
  if (!validCluster(cluster) || cluster === "local") throw Object.assign(new Error("Pick the GPU cluster first"), { status: 400 });
  const { identity = null, kind = null, clusterAdmin = false, expiresAt = null, permanent = false } = info;
  _access = { ..._access, [cluster]: { ...validateAccess(input), source, identity, kind, clusterAdmin, expiresAt, permanent, savedBy: actor, savedAt: new Date().toISOString() } };
  return { storage: await persistAccess(), ...clusterAccessSummary(cluster) };
}

export async function removeClusterAccess(cluster) {
  const { [cluster]: _gone, ...rest } = _access;
  _access = rest;
  return { storage: await persistAccess() };
}

export async function restoreClusterAccess() {
  try {
    if (await dbEnabled()) {
      const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [ACCESS_KEY]);
      let v = r?.rows?.[0]?.value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
      if (v && typeof v === "object") { _access = v; return; }
    }
  } catch { /* fall through */ }
  try { const v = JSON.parse(await readFile(ACCESS_FILE, "utf8")); if (v && typeof v === "object") _access = v; } catch { /* nothing stored */ }
}

export function _resetClusterAccess() { _access = {}; }
