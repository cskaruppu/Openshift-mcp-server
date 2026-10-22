// GitHub and GitLab, for remediation changes.
//
// A production fix is a reviewed change in source control, not a live patch:
// the platform opens a pull request (GitHub) or merge request (GitLab) that
// carries the edit, the CVEs it closes, the due date and the change-request
// number; the customer's own CI builds and scans it, a person approves and
// merges it, and their GitOps controller (or the platform, after approval)
// rolls it out. Nothing here merges or pushes to a protected branch.
//
// Configuration
//   GITHUB_TOKEN / GITLAB_TOKEN      tokens (from a Kubernetes Secret)
//   REMEDIATION_GIT_HOSTS            self-hosted instances, e.g.
//     '[{"host":"gitlab.tcs.local","provider":"gitlab","tokenEnv":"GITLAB_TCS_TOKEN"},
//       {"host":"github.tcs.com","provider":"github","tokenEnv":"GHE_TOKEN"}]'
// GitHub tokens need contents:write + pull_requests:write on the repository;
// GitLab tokens need the `api` scope and Developer access.

const TIMEOUT_MS = 15000;

function hosts() {
  let extra = [];
  try { extra = JSON.parse(process.env.REMEDIATION_GIT_HOSTS || "[]"); } catch { extra = []; }
  return [
    { host: "github.com", provider: "github", apiBase: "https://api.github.com", tokenEnv: "GITHUB_TOKEN" },
    { host: "gitlab.com", provider: "gitlab", apiBase: "https://gitlab.com/api/v4", tokenEnv: "GITLAB_TOKEN" },
    ...extra.map((h) => ({
      ...h,
      apiBase: h.apiBase || (h.provider === "github" ? `https://${h.host}/api/v3` : `https://${h.host}/api/v4`),
      tokenEnv: h.tokenEnv || (h.provider === "github" ? "GITHUB_TOKEN" : "GITLAB_TOKEN"),
    })),
  ];
}

/** "https://github.com/org/repo.git", "git@gitlab.com:grp/sub/proj.git" → { provider, host, path, apiBase, configured } */
export function parseRepoUrl(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  let host, path;
  const ssh = s.match(/^[\w.-]+@([^:]+):(.+)$/);
  if (ssh) { host = ssh[1]; path = ssh[2]; }
  else {
    try { const u = new URL(s); host = u.host; path = u.pathname.replace(/^\/+/, ""); } catch { return null; }
  }
  path = path.replace(/\.git$/, "").replace(/\/+$/, "").replace(/\/-\/.*$/, "");
  const h = hosts().find((x) => x.host === host) || (/gitlab/i.test(host) ? { host, provider: "gitlab", apiBase: `https://${host}/api/v4`, tokenEnv: "GITLAB_TOKEN" }
    : /github/i.test(host) ? { host, provider: "github", apiBase: `https://${host}/api/v3`, tokenEnv: "GITHUB_TOKEN" } : null);
  if (!h || !path) return null;
  return { provider: h.provider, host, path, apiBase: h.apiBase, tokenEnv: h.tokenEnv, configured: !!process.env[h.tokenEnv], webUrl: `https://${host}/${path}` };
}

export function gitStatus() {
  return hosts().map((h) => ({ host: h.host, provider: h.provider, configured: !!process.env[h.tokenEnv] }));
}

async function call(repo, method, path, body, { fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const token = process.env[repo.tokenEnv];
  if (!token) throw new Error(`${repo.provider === "github" ? "GitHub" : "GitLab"} token not configured (${repo.tokenEnv})`);
  const headers = repo.provider === "github"
    ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
    : { "PRIVATE-TOKEN": token, Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await f(`${repo.apiBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const text = await r.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
    if (!r.ok) {
      const msg = json.message || json.error || (Array.isArray(json.errors) ? json.errors.map((e) => e.message || e).join("; ") : "") || text.slice(0, 200);
      throw Object.assign(new Error(`${repo.provider} ${method} ${path.split("?")[0]} → HTTP ${r.status}${msg ? `: ${msg}` : ""}`), { status: r.status });
    }
    return json;
  } finally { clearTimeout(t); }
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(String(s || "").replace(/\n/g, ""), "base64").toString("utf8");
const ghPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const glId = (repo) => encodeURIComponent(repo.path);

/** The repository's default branch. */
export async function defaultBranch(repo, opts) {
  if (repo.provider === "github") return (await call(repo, "GET", `/repos/${repo.path}`, null, opts)).default_branch;
  return (await call(repo, "GET", `/projects/${glId(repo)}`, null, opts)).default_branch;
}

/** File paths under `dir` (recursive), capped. */
export async function listFiles(repo, ref, dir = "", opts, cap = 2000) {
  const clean = String(dir || "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (repo.provider === "github") {
    const t = await call(repo, "GET", `/repos/${repo.path}/git/trees/${encodeURIComponent(ref)}?recursive=1`, null, opts);
    return (t.tree || []).filter((e) => e.type === "blob" && (!clean || e.path === clean || e.path.startsWith(clean + "/"))).map((e) => e.path).slice(0, cap);
  }
  const out = [];
  for (let page = 1; page <= 20 && out.length < cap; page++) {
    const q = new URLSearchParams({ ref, recursive: "true", per_page: "100", page: String(page) });
    if (clean) q.set("path", clean);
    const items = await call(repo, "GET", `/projects/${glId(repo)}/repository/tree?${q}`, null, opts);
    if (!Array.isArray(items) || items.length === 0) break;
    for (const e of items) if (e.type === "blob") out.push(e.path);
    if (items.length < 100) break;
  }
  return out.slice(0, cap);
}

/** { content, sha } of a file at ref, or null when absent. */
export async function getFile(repo, ref, path, opts) {
  try {
    if (repo.provider === "github") {
      const r = await call(repo, "GET", `/repos/${repo.path}/contents/${ghPath(path)}?ref=${encodeURIComponent(ref)}`, null, opts);
      return { content: unb64(r.content), sha: r.sha };
    }
    const r = await call(repo, "GET", `/projects/${glId(repo)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`, null, opts);
    return { content: unb64(r.content), sha: r.blob_id };
  } catch (e) { if (e.status === 404) return null; throw e; }
}

/**
 * Open a PR / MR on a new branch carrying `files` ([{ path, content, sha }]).
 * Returns { number, url, branch, base }.
 */
export async function openChange(repo, { base, branch, title, body, files, labels = ["security", "vulnerability-remediation"] }, opts) {
  if (!files?.length) throw new Error("No file changes to propose");
  if (repo.provider === "github") {
    const head = await call(repo, "GET", `/repos/${repo.path}/git/ref/heads/${encodeURIComponent(base)}`, null, opts);
    await call(repo, "POST", `/repos/${repo.path}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.object.sha }, opts);
    for (const f of files) {
      await call(repo, "PUT", `/repos/${repo.path}/contents/${ghPath(f.path)}`, { message: `${title}\n\n${f.path}`, content: b64(f.content), sha: f.sha, branch }, opts);
    }
    const pr = await call(repo, "POST", `/repos/${repo.path}/pulls`, { title, head: branch, base, body, maintainer_can_modify: true }, opts);
    try { await call(repo, "POST", `/repos/${repo.path}/issues/${pr.number}/labels`, { labels }, opts); } catch { /* labels are optional */ }
    return { number: pr.number, url: pr.html_url, branch, base };
  }
  await call(repo, "POST", `/projects/${glId(repo)}/repository/commits`, {
    branch, start_branch: base, commit_message: title,
    actions: files.map((f) => ({ action: "update", file_path: f.path, content: f.content })),
  }, opts);
  const mr = await call(repo, "POST", `/projects/${glId(repo)}/merge_requests`, {
    source_branch: branch, target_branch: base, title, description: body, remove_source_branch: true, labels: labels.join(","),
  }, opts);
  return { number: mr.iid, url: mr.web_url, branch, base };
}

/**
 * Where a PR / MR stands: { state: open|merged|closed, checks: success|failure|pending|none, mergeSha }.
 * "checks" is the customer's CI on the change — their build and their scan.
 */
export async function changeStatus(repo, number, opts) {
  if (repo.provider === "github") {
    const pr = await call(repo, "GET", `/repos/${repo.path}/pulls/${number}`, null, opts);
    const sha = pr.head?.sha;
    let checks = "none";
    try {
      const runs = await call(repo, "GET", `/repos/${repo.path}/commits/${sha}/check-runs?per_page=100`, null, opts);
      const st = await call(repo, "GET", `/repos/${repo.path}/commits/${sha}/status`, null, opts);
      const conclusions = (runs.check_runs || []).map((c) => (c.status !== "completed" ? "pending" : c.conclusion));
      if ((st.statuses || []).length) conclusions.push(st.state === "success" ? "success" : st.state === "pending" ? "pending" : "failure");
      if (conclusions.length) checks = conclusions.some((c) => c === "failure" || c === "timed_out" || c === "cancelled" || c === "action_required") ? "failure"
        : conclusions.some((c) => c === "pending" || c === null) ? "pending" : "success";
    } catch { /* checks unreadable */ }
    return { state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open", checks, mergeSha: pr.merge_commit_sha || null, url: pr.html_url };
  }
  const mr = await call(repo, "GET", `/projects/${glId(repo)}/merge_requests/${number}`, null, opts);
  const p = mr.head_pipeline?.status;
  const checks = !p ? "none" : p === "success" ? "success" : (p === "failed" || p === "canceled") ? "failure" : "pending";
  return { state: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open", checks, mergeSha: mr.merge_commit_sha || null, url: mr.web_url };
}

/* ─────────────────────────── file edits (pure) ─────────────────────────── */

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function repoVariants(ref) {
  // nginx:1.25 may be written docker.io/library/nginx, library/nginx or nginx.
  const noTag = String(ref).split("@")[0].replace(/:[^/:]+$/, "");
  const v = new Set([noTag]);
  const m = noTag.match(/^(?:docker\.io\/|index\.docker\.io\/|registry-1\.docker\.io\/)?(?:library\/)?(.+)$/);
  if (m && !/^[^/]+\.[^/]+\//.test(noTag.replace(/^docker\.io\//, ""))) { v.add(m[1]); v.add(`library/${m[1]}`); v.add(`docker.io/${m[1].includes("/") ? m[1] : "library/" + m[1]}`); }
  return [...v].sort((a, b) => b.length - a.length);
}
const tagOf = (ref) => { const s = String(ref).split("@")[0]; const i = s.lastIndexOf(":"); return i > s.lastIndexOf("/") ? s.slice(i + 1) : "latest"; };

/**
 * Replace an image reference in Kubernetes YAML, Kustomize and Helm values.
 * Returns { text, count }.
 */
export function replaceImageRef(text, oldRef, newRef) {
  let count = 0;
  const oldTag = tagOf(oldRef), newTag = tagOf(newRef);
  const repos = repoVariants(oldRef);
  const repoAlt = repos.map(esc).join("|");
  // 1. image: <repo>:<tag>[@digest]
  let out = text.replace(new RegExp(`(\\bimage:\\s*["']?)(?:${repoAlt}):${esc(oldTag)}(?:@sha256:[a-f0-9]{64})?(["']?)`, "g"), (_m, a, b) => { count++; return `${a}${newRef}${b}`; });
  // 2. Kustomize images: - name: <repo> … newTag: <tag>
  out = out.replace(new RegExp(`(-\\s*name:\\s*["']?(?:${repoAlt})["']?\\s*\\n(?:\\s+[\\w]+:.*\\n){0,3}?\\s+newTag:\\s*["']?)${esc(oldTag)}(["']?)`, "g"), (_m, a, b) => { count++; return `${a}${newTag}${b}`; });
  // 3. Helm values: repository: <repo> … tag: <tag>
  out = out.replace(new RegExp(`(repository:\\s*["']?(?:${repoAlt})["']?\\s*\\n(?:\\s+[\\w]+:.*\\n){0,3}?\\s+tag:\\s*["']?)${esc(oldTag)}(["']?)`, "g"), (_m, a, b) => { count++; return `${a}${newTag}${b}`; });
  return { text: out, count };
}

/** Point FROM lines that use `oldBase`'s repository (or every final-stage FROM when none given) at `newBase`. */
export function bumpDockerfileFrom(text, newBase, oldBase) {
  let count = 0;
  const repos = oldBase ? repoVariants(oldBase).map(esc).join("|") : null;
  const out = text.replace(/^(\s*FROM\s+(?:--platform=\S+\s+)?)(\S+)(.*)$/gim, (m, a, img, rest) => {
    if (/^\$\{?/.test(img) || img === "scratch") return m;
    if (repos && !new RegExp(`^(?:${repos})(?::|@|$)`).test(img)) return m;
    if (!repos && repoVariants(img)[0] !== repoVariants(newBase)[0]) return m;
    count++; return `${a}${newBase}${rest}`;
  });
  return { text: out, count };
}

/** go.mod: require line for `module` → `version`; `go`/`toolchain` for stdlib. */
export function bumpGoMod(text, module, version) {
  let count = 0;
  const v = version.startsWith("v") ? version : `v${version}`;
  if (module === "stdlib") {
    const plain = version.replace(/^v/, "");
    let out = text.replace(/^(toolchain\s+go)(\S+)/m, (m, a, cur) => (cmpVer(cur, plain) < 0 ? (count++, `${a}${plain}`) : m));
    if (!count) out = out.replace(/^(go[ \t]+)(\d+\.\d+(?:\.\d+)?)[ \t]*$/m, (m, a, cur) => (cmpVer(cur, plain) < 0 ? (count++, `${a}${plain}`) : m));
    return { text: out, count };
  }
  const out = text.replace(new RegExp(`^(\\s*(?:require\\s+)?${esc(module)}\\s+)(v[^\\s]+)(.*)$`, "gm"), (m, a, cur, rest) => (cmpVer(cur, v) < 0 ? (count++, `${a}${v}${rest}`) : m));
  return { text: out, count };
}

/** package.json: dependency `name` → `version`, keeping the range prefix. */
export function bumpPackageJson(text, name, version) {
  let count = 0;
  const out = text.replace(new RegExp(`("${esc(name)}"\\s*:\\s*")([~^>=<]*)([^"]+)(")`, "g"), (m, a, pre, cur, z) => (cmpVer(cur, version) < 0 ? (count++, `${a}${pre}${version}${z}`) : m));
  return { text: out, count };
}

/** requirements.txt: `name==x` → `name==version` (other specifiers → `>=version`). */
export function bumpRequirements(text, name, version) {
  let count = 0;
  const out = text.replace(new RegExp(`^(${esc(name)}(?:\\[[^\\]]*\\])?)\\s*(==|~=|>=|<=|<|>)?\\s*([^\\s;#,]*)(.*)$`, "gim"), (m, a, op, cur, rest) => {
    if (cur && cmpVer(cur, version) >= 0) return m;
    count++; return `${a}${op === "==" ? "==" : ">="}${version}${rest}`;
  });
  return { text: out, count };
}

/** pom.xml: <groupId>g</groupId><artifactId>a</artifactId><version>x</version>, or the ${property} it uses. */
export function bumpPom(text, coord, version) {
  const [g, a] = String(coord).split(":");
  const dep = new RegExp(`(<groupId>\\s*${esc(g)}\\s*</groupId>\\s*<artifactId>\\s*${esc(a)}\\s*</artifactId>\\s*<version>)([^<]+)(</version>)`, "g");
  let count = 0;
  const props = new Set();
  let out = text.replace(dep, (m, p1, cur, p3) => {
    const prop = cur.trim().match(/^\$\{([^}]+)\}$/);
    if (prop) { props.add(prop[1]); return m; }
    if (cmpVer(cur, version) < 0) { count++; return `${p1}${version}${p3}`; }
    return m;
  });
  for (const p of props) {
    out = out.replace(new RegExp(`(<${esc(p)}>)([^<]+)(</${esc(p)}>)`), (m, x, c, y) => (cmpVer(c, version) < 0 ? (count++, `${x}${version}${y}`) : m));
  }
  return { text: out, count };
}

/** Loose version compare: -1, 0, 1. Debian epochs and suffixes are compared piecewise. */
export function cmpVer(a, b) {
  const norm = (s) => String(s || "").replace(/^v/, "").replace(/^\d+:/, "").split(/[^0-9A-Za-z]+/).filter(Boolean);
  const x = norm(a), y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i], q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = /^\d+$/.test(p), nq = /^\d+$/.test(q);
    if (np && nq) { const d = Number(p) - Number(q); if (d) return d < 0 ? -1 : 1; }
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** A unified-style diff of the changed lines, for review in the UI before anything is opened. */
export function lineDiff(before, after, max = 40) {
  const a = before.split("\n"), b = after.split("\n");
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < max; i++) {
    if (a[i] !== b[i]) { if (a[i] !== undefined) out.push(`-${a[i]}`); if (b[i] !== undefined) out.push(`+${b[i]}`); }
  }
  return out;
}
