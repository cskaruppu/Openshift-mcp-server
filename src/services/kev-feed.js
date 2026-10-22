// CISA Known Exploited Vulnerabilities (KEV) catalog.
//
// "Actively exploited" is a claim about the outside world, and the only party
// that can make it is CISA. So the flag comes from CISA's own feed and from
// nothing else: not a hand-picked list, and not a CVSS threshold (a 9.8 that
// no one has exploited is severe, not exploited). When the catalog cannot be
// loaded, nothing is flagged and the status says why — an empty answer that
// says "unavailable" is honest; a guessed one is not.
//
//   KEV_FEED_URL   override the CISA URL (an internal mirror), or "off"
//   KEV_FEED_FILE  read the catalog from disk — for air-gapped clusters, mount
//                  a copy of known_exploited_vulnerabilities.json here
//
// The catalog is refreshed once a day; a failed refresh keeps the last good
// copy and marks it stale rather than dropping it.

import { readFile } from "node:fs/promises";

export const CISA_KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const REFRESH_MS = 24 * 3600 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const FIRST_LOAD_WAIT_MS = 4000;

let _ids = new Set();
let _details = new Map();   // CVE → { dueDate, dateAdded, ransomware, action }
let _meta = { status: "not-loaded", count: 0 };
let _loadedAt = 0;
let _lastAttempt = 0;
let _inflight = null;

/** Parse the CISA catalog JSON. Throws on anything that is not the catalog. */
export function parseKevCatalog(doc) {
  const list = doc && Array.isArray(doc.vulnerabilities) ? doc.vulnerabilities : null;
  if (!list) throw new Error("not a KEV catalog (no vulnerabilities array)");
  const ids = new Set();
  const details = new Map();
  for (const v of list) {
    const id = String(v?.cveID || "").trim().toUpperCase();
    if (!/^CVE-\d{4}-\d{4,}$/.test(id)) continue;
    ids.add(id);
    details.set(id, { dueDate: v.dueDate || null, dateAdded: v.dateAdded || null, ransomware: v.knownRansomwareCampaignUse === "Known", action: v.requiredAction || null });
  }
  if (ids.size === 0) throw new Error("KEV catalog is empty");
  return { ids, details, catalogVersion: doc.catalogVersion || null, dateReleased: doc.dateReleased || null };
}

async function loadOnce() {
  const file = process.env.KEV_FEED_FILE;
  const url = process.env.KEV_FEED_URL || CISA_KEV_URL;
  _lastAttempt = Date.now();
  try {
    let doc, source;
    if (file) {
      doc = JSON.parse(await readFile(file, "utf8"));
      source = `file:${file}`;
    } else {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        doc = await r.json();
      } finally { clearTimeout(timer); }
      source = url;
    }
    const parsed = parseKevCatalog(doc);
    _ids = parsed.ids;
    _details = parsed.details;
    _loadedAt = Date.now();
    _meta = {
      status: "live", source, count: parsed.ids.size,
      catalogVersion: parsed.catalogVersion, dateReleased: parsed.dateReleased,
      fetchedAt: new Date(_loadedAt).toISOString(),
    };
  } catch (e) {
    const error = e?.name === "AbortError" ? "timed out" : (e?.message || String(e));
    // Keep the last good catalog; only say "unavailable" if there never was one.
    _meta = _ids.size > 0
      ? { ..._meta, status: "stale", error }
      : { status: "unavailable", count: 0, source: file ? `file:${file}` : url, error };
  }
}

function due() {
  if (_inflight) return false;
  if (_ids.size === 0) return Date.now() - _lastAttempt > RETRY_MS || _lastAttempt === 0;
  return Date.now() - _loadedAt > REFRESH_MS && Date.now() - _lastAttempt > RETRY_MS;
}

function refresh() {
  _inflight = loadOnce().finally(() => { _inflight = null; });
  return _inflight;
}

/**
 * The KEV id set. The first call waits briefly for the catalog; after that the
 * cached set is returned at once and refreshed in the background.
 */
export async function getKevSet() {
  if ((process.env.KEV_FEED_URL || "").toLowerCase() === "off") {
    _meta = { status: "disabled", count: 0 };
    return new Set();
  }
  if (due()) {
    const p = refresh();
    if (_ids.size === 0) {
      let timer;
      await Promise.race([p, new Promise(r => { timer = setTimeout(r, FIRST_LOAD_WAIT_MS); })]);
      clearTimeout(timer);
    }
  }
  return _ids;
}

export function kevStatus() { return { ..._meta }; }

/** CISA's remediation due date and ransomware flag for a KEV CVE, or null. */
export function kevDetails(cveId) {
  return _details.get(String(cveId || "").toUpperCase()) || null;
}

export function isKnownExploited(cveId) {
  return _ids.has(String(cveId || "").toUpperCase());
}

/** Test hook: install a catalog without the network. */
export function _setKevCatalogForTest(doc) {
  if (doc == null) { _ids = new Set(); _details = new Map(); _meta = { status: "not-loaded", count: 0 }; _loadedAt = 0; _lastAttempt = 0; return; }
  const parsed = parseKevCatalog(doc);
  _ids = parsed.ids; _details = parsed.details; _loadedAt = Date.now(); _lastAttempt = Date.now();
  _meta = { status: "live", source: "test", count: parsed.ids.size, catalogVersion: parsed.catalogVersion, dateReleased: parsed.dateReleased, fetchedAt: new Date().toISOString() };
}
