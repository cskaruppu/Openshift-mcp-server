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
