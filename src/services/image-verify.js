// Checks that stand between an AI-suggested image and the cluster.
//
// A language model can name an image tag that does not exist, or one that
// exists but is not the image the workload runs. Neither may reach a patch:
//   - parseImageRef / isConcreteImageRef  reject placeholders and malformed refs
//   - sameImage                           matches a running container to the
//                                         scanned image, never "the first one"
//   - verifyImageExists                   asks the registry whether the tag is
//                                         real before it is applied
//   - citedCves                           pulls CVE ids out of model text so they
//                                         can be checked against the scan

const REF_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(\.[a-z0-9-]+)*(:\d+)?(\/[a-z0-9]+([._-]{1,2}[a-z0-9]+)*)*(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

/** Split an image reference into registry, repository, tag and digest. */
export function parseImageRef(ref) {
  let s = String(ref || "").trim();
  if (!s) return null;
  let digest = null;
  const at = s.indexOf("@");
  if (at >= 0) { digest = s.slice(at + 1); s = s.slice(0, at); }
  let tag = null;
  const lastSlash = s.lastIndexOf("/");
  const colon = s.lastIndexOf(":");
  if (colon > lastSlash) { tag = s.slice(colon + 1); s = s.slice(0, colon); }
  const parts = s.split("/");
  let registry = "docker.io";
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) {
    registry = parts.shift();
  }
  let repo = parts.join("/");
  if (registry === "docker.io" || registry === "index.docker.io" || registry === "registry-1.docker.io") {
    registry = "docker.io";
    if (!repo.includes("/")) repo = `library/${repo}`;
  }
  if (!tag && !digest) tag = "latest";
  return { registry, repo, tag, digest };
}

/** A ref the cluster could actually pull: no placeholders, well formed. */
export function isConcreteImageRef(ref) {
  const s = String(ref || "").trim();
  if (!s || /[<>{}\s]/.test(s)) return false;
  if (/patched-tag|latest-stable|pin-specific|your[-_]|placeholder/i.test(s)) return false;
  return REF_RE.test(s);
}

/** True when two refs name the same image (same registry, repo, and tag or digest). */
export function sameImage(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const x = parseImageRef(a), y = parseImageRef(b);
  if (!x || !y) return false;
  if (x.registry !== y.registry || x.repo !== y.repo) return false;
  if (x.digest && y.digest) return x.digest === y.digest;
  if (x.digest || y.digest) return false;
  return x.tag === y.tag;
}

/**
 * Same repository and tag, ignoring a digest only one side carries — how a
 * pod spec (repo:tag) is matched to a scanner report (repo:tag@sha256:…).
 */
export function sameRepoTag(a, b) {
  const x = parseImageRef(a), y = parseImageRef(b);
  if (!x || !y || x.registry !== y.registry || x.repo !== y.repo) return false;
  if (x.digest && y.digest && x.digest === y.digest) return true;
  return !!x.tag && x.tag === y.tag;
}

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function timedFetch(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

function parseBearerChallenge(header) {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const out = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out.realm ? out : null;
}

/**
 * Ask the registry whether the image exists.
 *   { exists: true,  digest }   the registry returned the manifest
 *   { exists: false, reason }   the registry says there is no such tag/repo
 *   { exists: null,  reason }   could not tell (private registry, no egress)
 * Uses anonymous pull tokens only; nothing secret is sent.
 */
export async function verifyImageExists(ref, { fetchImpl } = {}) {
  const f = fetchImpl || timedFetch;
  const p = parseImageRef(ref);
  if (!p || !isConcreteImageRef(ref)) return { exists: false, reason: "not a valid image reference" };
  const host = p.registry === "docker.io" ? "registry-1.docker.io" : p.registry;
  const url = `https://${host}/v2/${p.repo}/manifests/${p.digest || p.tag}`;
  try {
    let r = await f(url, { method: "HEAD", headers: { Accept: MANIFEST_ACCEPT } });
    if (r.status === 401) {
      const ch = parseBearerChallenge(r.headers.get("www-authenticate"));
      if (!ch) return { exists: null, reason: "registry requires credentials" };
      const q = new URLSearchParams();
      if (ch.service) q.set("service", ch.service);
      q.set("scope", ch.scope || `repository:${p.repo}:pull`);
      const tr = await f(`${ch.realm}?${q}`, { headers: { Accept: "application/json" } });
      if (!tr.ok) return { exists: null, reason: `registry token refused (HTTP ${tr.status})` };
      const tj = await tr.json().catch(() => ({}));
      const token = tj.token || tj.access_token;
      if (!token) return { exists: null, reason: "registry gave no anonymous token" };
      r = await f(url, { method: "HEAD", headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` } });
    }
    if (r.ok) return { exists: true, digest: r.headers.get("docker-content-digest") || null };
    if (r.status === 404) return { exists: false, reason: `${p.registry} has no ${p.repo}:${p.digest || p.tag}` };
    if (r.status === 401 || r.status === 403) return { exists: null, reason: "registry requires credentials" };
    return { exists: null, reason: `registry answered HTTP ${r.status}` };
  } catch (e) {
    return { exists: null, reason: e?.name === "AbortError" ? "registry did not answer in time" : `registry unreachable (${e?.message || e})` };
  }
}

/** Every CVE id mentioned in a piece of model text, upper-cased, de-duplicated. */
export function citedCves(...texts) {
  const out = new Set();
  for (const t of texts) for (const m of String(t || "").matchAll(/CVE-\d{4}-\d{4,}/gi)) out.add(m[0].toUpperCase());
  return [...out];
}

/**
 * Every tag the registry publishes for the image's repository (anonymous
 * pull token; Docker Hub and OCI registries page with `Link`). Returns
 * { tags: [...] } or { tags: null, reason }.
 */
export async function listTags(ref, { fetchImpl, max = 5000 } = {}) {
  const f = fetchImpl || timedFetch;
  const p = parseImageRef(ref);
  if (!p) return { tags: null, reason: "not a valid image reference" };
  const host = p.registry === "docker.io" ? "registry-1.docker.io" : p.registry;
  let url = `https://${host}/v2/${p.repo}/tags/list?n=1000`;
  let token = null;
  const tags = [];
  try {
    for (let page = 0; page < 10 && url && tags.length < max; page++) {
      let r = await f(url, { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      if (r.status === 401 && !token) {
        const ch = parseBearerChallenge(r.headers.get("www-authenticate"));
        if (!ch) return { tags: null, reason: "registry requires credentials" };
        const q = new URLSearchParams();
        if (ch.service) q.set("service", ch.service);
        q.set("scope", ch.scope || `repository:${p.repo}:pull`);
        const tr = await f(`${ch.realm}?${q}`, { headers: { Accept: "application/json" } });
        if (!tr.ok) return { tags: null, reason: `registry token refused (HTTP ${tr.status})` };
        const tj = await tr.json().catch(() => ({}));
        token = tj.token || tj.access_token;
        if (!token) return { tags: null, reason: "registry gave no anonymous token" };
        r = await f(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
      }
      if (!r.ok) return { tags: tags.length ? tags : null, reason: `registry answered HTTP ${r.status}` };
      const j = await r.json().catch(() => ({}));
      tags.push(...(j.tags || []));
      const link = r.headers.get("link");
      const m = link && link.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? (m[1].startsWith("http") ? m[1] : `https://${host}${m[1]}`) : null;
    }
    return { tags };
  } catch (e) {
    return { tags: tags.length ? tags : null, reason: e?.name === "AbortError" ? "registry did not answer in time" : `registry unreachable (${e?.message || e})` };
  }
}

const PRERELEASE = /(^|[-.])(rc|alpha|beta|dev|nightly|snapshot|pre|preview|edge|canary|test)\d*([-.]|$)/i;

/** "v1.25.3-alpine" → { prefix:"v", nums:[1,25,3], flavor:"-alpine" }, or null for non-version tags. */
export function parseVersionTag(tag) {
  // A build number after "_" or "+" (eclipse-temurin's 17.0.8_7) is part of
  // the version, not of the flavour that follows it (-jre-jammy).
  const m = String(tag || "").match(/^(v?)(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[_+](\d+))?(.*)$/);
  if (!m) return null;
  const nums = [m[2], m[3], m[4], m[5]].filter((x) => x !== undefined).map(Number);
  return { prefix: m[1], nums, build: m[6] !== undefined ? Number(m[6]) : null, flavor: m[7] || "" };
}

const cmpNums = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };

/**
 * From the registry's real tags, the upgrade candidates for `currentTag`:
 * the newest patch (same major.minor), newest minor (same major) and newest
 * overall — same flavour (-alpine, -slim, -debian-12 …), same precision,
 * no pre-releases. Nothing is invented: each one is a tag that exists.
 */
export function upgradeCandidates(currentTag, tags) {
  const cur = parseVersionTag(currentTag);
  if (!cur || !Array.isArray(tags)) return [];
  const pool = [];
  for (const t of tags) {
    if (PRERELEASE.test(t.replace(cur.flavor, ""))) continue;
    const v = parseVersionTag(t);
    if (!v || v.flavor !== cur.flavor || v.prefix !== cur.prefix || v.nums.length !== cur.nums.length || (v.build === null) !== (cur.build === null)) continue;
    if (cmpNums([...v.nums, v.build ?? 0], [...cur.nums, cur.build ?? 0]) <= 0) continue;
    v.nums = [...v.nums, v.build ?? 0];
    pool.push({ tag: t, v });
  }
  pool.sort((a, b) => cmpNums(b.v.nums, a.v.nums));
  const out = [];
  const add = (kind, c) => { if (c && !out.some((o) => o.tag === c.tag)) out.push({ kind, tag: c.tag }); };
  add("patch", pool.find((c) => c.v.nums[0] === cur.nums[0] && (cur.nums.length < 3 || c.v.nums[1] === cur.nums[1])));
  add("minor", pool.find((c) => c.v.nums[0] === cur.nums[0]));
  add("latest", pool[0]);
  return out;
}

/** Real newer tags for an image, as full references. */
export async function suggestUpgrades(ref, opts) {
  const p = parseImageRef(ref);
  if (!p || p.digest && !p.tag) return { candidates: [], reason: "pinned by digest only — no tag to compare" };
  const list = await listTags(ref, opts);
  if (!list.tags) return { candidates: [], reason: list.reason };
  const base = String(ref).split("@")[0].replace(/:[^/:]+$/, "");
  return { candidates: upgradeCandidates(p.tag, list.tags).map((c) => ({ ...c, image: `${base}:${c.tag}` })), totalTags: list.tags.length };
}
