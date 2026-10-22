// FIRST EPSS — the probability that a CVE is exploited in the next 30 days.
//
// CVSS says how bad a CVE would be; EPSS says how likely it is to be used.
// Together with CISA KEV (already exploited) they are what risk-based
// prioritisation is built on. Scores come from FIRST's public API and are
// cached for a day; nothing is estimated when they are missing.
//
//   EPSS_FEED_URL   override the API base (an internal mirror), or "off"
//   EPSS_FEED_FILE  read FIRST's daily CSV (epss_scores-current.csv[.gz])
//                   from disk — for air-gapped clusters

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

export const FIRST_EPSS_URL = "https://api.first.org/data/v1/epss";
const TTL_MS = 24 * 3600 * 1000;
const BATCH = 50;
const MAX_PER_CALL = 600;
const TIMEOUT_MS = 8000;

const _cache = new Map();        // CVE → { epss, percentile, date, ts }
let _fileLoaded = false;
let _meta = { status: "not-loaded" };

/** Parse FIRST's CSV: an optional "#model_version…" line, a header, then rows. */
export function parseEpssCsv(text) {
  const out = new Map();
  let date = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("#")) { const m = line.match(/score_date:(\S+)/); if (m) date = m[1].slice(0, 10); continue; }
    const [cve, epss, percentile] = line.split(",");
    if (!/^CVE-/i.test(cve || "")) continue;
    out.set(cve.toUpperCase(), { epss: Number(epss), percentile: Number(percentile), date });
  }
  return out;
}

async function loadFile(file) {
  let buf = await readFile(file);
  if (file.endsWith(".gz")) buf = gunzipSync(buf);
  const rows = parseEpssCsv(buf.toString("utf8"));
  const ts = Date.now();
  for (const [k, v] of rows) _cache.set(k, { ...v, ts });
  _fileLoaded = true;
  _meta = { status: "live", source: `file:${file}`, count: rows.size, date: [...rows.values()][0]?.date || null };
}

async function fetchBatch(ids, base) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${base}?cve=${ids.join(",")}`, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const ts = Date.now();
    const seen = new Set();
    for (const row of (j.data || [])) {
      const id = String(row.cve || "").toUpperCase();
      seen.add(id);
      _cache.set(id, { epss: Number(row.epss), percentile: Number(row.percentile), date: row.date || null, ts });
    }
    // A CVE FIRST has no score for is remembered as such, so it is not re-asked every scan.
    for (const id of ids) if (!seen.has(id)) _cache.set(id, { epss: null, percentile: null, date: null, ts });
  } finally { clearTimeout(t); }
}

/**
 * Scores for the given CVE ids: Map(CVE → { epss, percentile, date }).
 * CVEs with no score are absent from the map.
 */
export async function getEpssScores(cveIds) {
  const ids = [...new Set((cveIds || []).map(x => String(x).toUpperCase()).filter(x => /^CVE-\d{4}-\d{4,}$/.test(x)))];
  const out = new Map();
  if ((process.env.EPSS_FEED_URL || "").toLowerCase() === "off") {
    _meta = { status: "disabled" };
    return out;
  }
  try {
    const file = process.env.EPSS_FEED_FILE;
    if (file) {
      if (!_fileLoaded) await loadFile(file);
    } else {
      const base = process.env.EPSS_FEED_URL || FIRST_EPSS_URL;
      const now = Date.now();
      const missing = ids.filter(id => { const c = _cache.get(id); return !c || now - c.ts > TTL_MS; }).slice(0, MAX_PER_CALL);
      const batches = [];
      for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
      for (let i = 0; i < batches.length; i += 4) await Promise.all(batches.slice(i, i + 4).map(b => fetchBatch(b, base)));
      _meta = { status: "live", source: base, count: _cache.size, fetchedAt: new Date().toISOString() };
    }
  } catch (e) {
    const error = e?.name === "AbortError" ? "timed out" : (e?.message || String(e));
    _meta = _cache.size > 0 ? { ..._meta, status: "stale", error } : { status: "unavailable", error };
  }
  for (const id of ids) {
    const c = _cache.get(id);
    if (c && c.epss != null && Number.isFinite(c.epss)) out.set(id, { epss: c.epss, percentile: c.percentile, date: c.date });
  }
  return out;
}

export function epssStatus() { return { ..._meta }; }

/** Test hook. */
export function _setEpssForTest(rows) {
  _cache.clear(); _fileLoaded = false;
  const ts = Date.now();
  for (const [k, v] of Object.entries(rows || {})) _cache.set(k.toUpperCase(), { epss: v, percentile: v, date: "2026-10-21", ts });
  _meta = rows ? { status: "live", source: "test", count: _cache.size } : { status: "not-loaded" };
}
