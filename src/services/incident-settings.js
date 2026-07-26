/**
 * Incident automation settings — runtime-configurable policy.
 *
 * Everything the autonomous incident loop needs to be tuned by an operator
 * (autonomous on/off, the ServiceNow queue to assign to, the chronic window,
 * the severity floor, the ticket rate limit) lives here instead of only in
 * environment variables, so changing it does NOT require editing a Deployment
 * and restarting the pod.
 *
 * Precedence on load: database → file → environment → built-in defaults.
 * On save we ALSO write the values into process.env, because the detector,
 * orchestrator and feature flags all read those names at call time — so a save
 * takes effect on the very next detection scan, live.
 *
 * Mirrors the existing LLM / ServiceNow settings pattern (kv_store + a JSON file
 * fallback) so behaviour is consistent and survives a pod restart with or
 * without Postgres.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

const DB_KEY = "incident_automation_settings";
const FILE_PATH = process.env.INCIDENT_SETTINGS_PATH || "/data/mcp-incident-settings.json";

export const DEFAULTS = {
  autoDetect: true,          // read-only detection (safe)
  autoAct: false,            // raise tickets + auto-close without a human trigger
  assignmentGroup: "",       // ServiceNow queue; blank = instance default routing
  chronicHours: 24,          // older than this when first seen → Problem candidate
  severityFloor: "SEV-2",    // only this severity or worse is auto-ticketed
  maxTicketsPerHour: 10,     // storm brake
  selfHealScans: 2,          // consecutive clear scans before auto-closing
};

const VALID_SEVERITIES = new Set(["SEV-1", "SEV-2", "SEV-3", "SEV-4"]);

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** Coerce arbitrary input into a valid, safe settings object. */
export function normalize(raw = {}) {
  const sev = String(raw.severityFloor || DEFAULTS.severityFloor).toUpperCase();
  return {
    autoDetect: raw.autoDetect !== undefined ? Boolean(raw.autoDetect) : DEFAULTS.autoDetect,
    autoAct: raw.autoAct !== undefined ? Boolean(raw.autoAct) : DEFAULTS.autoAct,
    assignmentGroup: String(raw.assignmentGroup ?? DEFAULTS.assignmentGroup).trim().slice(0, 120),
    chronicHours: clampInt(raw.chronicHours, 0, 24 * 365, DEFAULTS.chronicHours),
    severityFloor: VALID_SEVERITIES.has(sev) ? sev : DEFAULTS.severityFloor,
    maxTicketsPerHour: clampInt(raw.maxTicketsPerHour, 1, 500, DEFAULTS.maxTicketsPerHour),
    selfHealScans: clampInt(raw.selfHealScans, 1, 20, DEFAULTS.selfHealScans),
  };
}

/** Push settings into process.env so every consumer picks them up immediately. */
export function applyToEnv(s) {
  process.env.INCIDENT_AUTO_DETECT = s.autoDetect ? "true" : "false";
  process.env.INCIDENT_AUTO_ACT = s.autoAct ? "true" : "false";
  process.env.SERVICENOW_ASSIGNMENT_GROUP = s.assignmentGroup || "";
  process.env.INCIDENT_CHRONIC_HOURS = String(s.chronicHours);
  process.env.INCIDENT_AUTO_SEVERITY_FLOOR = s.severityFloor;
  process.env.INCIDENT_MAX_TICKETS_PER_HOUR = String(s.maxTicketsPerHour);
  process.env.INCIDENT_SELFHEAL_SCANS = String(s.selfHealScans);
}

/** Load from DB → file → env → defaults. Never throws. */
export async function loadIncidentSettings() {
  try {
    if (await dbEnabled()) {
      const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [DB_KEY]);
      if (r?.rows?.length) {
        let v = r.rows[0].value;
        if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
        if (v && typeof v === "object") return { ...normalize(v), _storage: "database" };
      }
    }
  } catch { /* fall through */ }
  try {
    const parsed = JSON.parse(await readFile(FILE_PATH, "utf8"));
    if (parsed && typeof parsed === "object") return { ...normalize(parsed), _storage: "file" };
  } catch { /* fall through */ }
  // Environment / defaults — nothing persisted yet.
  return {
    ...normalize({
      autoDetect: process.env.INCIDENT_AUTO_DETECT !== "false",
      autoAct: process.env.INCIDENT_AUTO_ACT === "true",
      assignmentGroup: process.env.SERVICENOW_ASSIGNMENT_GROUP || "",
      chronicHours: process.env.INCIDENT_CHRONIC_HOURS,
      severityFloor: process.env.INCIDENT_AUTO_SEVERITY_FLOOR,
      maxTicketsPerHour: process.env.INCIDENT_MAX_TICKETS_PER_HOUR,
      selfHealScans: process.env.INCIDENT_SELFHEAL_SCANS,
    }),
    _storage: "environment",
  };
}

/** Persist (DB + file) and apply live. Returns the stored settings. */
export async function saveIncidentSettings(patch) {
  const current = await loadIncidentSettings();
  const merged = normalize({ ...current, ...patch });
  applyToEnv(merged);

  let savedToDB = false, savedToFile = false;
  try {
    if (await dbEnabled()) {
      await dbQuery(
        `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [DB_KEY, JSON.stringify(merged)]
      );
      savedToDB = true;
    }
  } catch { /* DB optional */ }
  try {
    await mkdir(dirname(FILE_PATH), { recursive: true }).catch(() => {});
    await writeFile(FILE_PATH, JSON.stringify(merged, null, 2), "utf8");
    savedToFile = true;
  } catch { /* file optional */ }

  return { ...merged, _storage: savedToDB ? "database" : savedToFile ? "file" : "memory", savedToDB, savedToFile };
}

/** Restore persisted settings into env at startup. */
export async function restoreIncidentSettings() {
  const s = await loadIncidentSettings();
  applyToEnv(s);
  if (s._storage !== "environment") {
    console.log(`[incident-settings] restored from ${s._storage} — autoAct=${s.autoAct}, queue="${s.assignmentGroup || "(instance default)"}", chronic=${s.chronicHours}h, floor=${s.severityFloor}`);
  }
  return s;
}

/**
 * Best-effort check that an assignment group actually exists in ServiceNow, so
 * a typo doesn't silently leave every incident unassigned.
 * @returns {Promise<{checked:boolean, found?:boolean, name?:string, error?:string}>}
 */
export async function verifyAssignmentGroup(name) {
  if (!name) return { checked: false };
  try {
    const { queryRecords } = await import("../utils/servicenow-client.js");
    const res = await queryRecords("sys_user_group", `name=${name}`, 1);
    const rows = res?.result || res || [];
    if (Array.isArray(rows) && rows.length > 0) {
      return { checked: true, found: true, name: rows[0].name || name, sysId: rows[0].sys_id || null };
    }
    return { checked: true, found: false, name };
  } catch (e) {
    return { checked: false, error: e.message };
  }
}
