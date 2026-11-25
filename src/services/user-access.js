/**
 * User & Access — who can log in to which cluster, and with what rights,
 * across every cluster the hub manages; and governed changes to it.
 *
 * OpenShift has no "create user with password" API: people come from an
 * identity provider (OAuth). So "giving someone access" here means one of:
 *   - directory (AD / LDAP / SSO): add them to a platform-managed Group and
 *     bind that group to a role. No password exists or is created.
 *   - htpasswd: add a bcrypt entry to the cluster's htpasswd Secret, then the
 *     same group and binding. The password is generated once, returned once
 *     to the approver, and never stored.
 *
 * Every change is a request that someone with the Admin role approves before
 * anything touches a cluster. Grants can expire; a background tick removes
 * expired access. "Remove everywhere" takes a person off every cluster.
 *
 * Reads and writes run per cluster through deps.run(cluster, fn), which puts
 * the cluster's API connection in context (spoke agent credentials or direct
 * access). A cluster reached only through the read-only bridge can be read
 * but not changed; its result says so.
 */
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

const STORE_KEY = "user_access_state";
const FILE = () => `${process.env.USER_ACCESS_STATE_DIR || "/data"}/mcp-user-access.json`;
const INACTIVE_DAYS = () => Number(process.env.USER_ACCESS_INACTIVE_DAYS) || 90;
const MANAGED = "tcs.io/managed-by";
const MANAGED_VAL = "user-access";
export const ROLES = ["view", "edit", "admin", "cluster-reader", "cluster-admin"];
const CLUSTER_ROLES = new Set(["cluster-reader", "cluster-admin"]);
const ROLE_LABEL = { view: "Viewer", edit: "Developer", admin: "Namespace admin", "cluster-reader": "Cluster reader", "cluster-admin": "Cluster admin" };

let _deps = {
  run: async (_cluster, fn) => fn(),              // run fn with the cluster's API in context
  // Run one operation on a cluster. The server routes it: to a spoke agent's
  // own User & Access endpoint, through Private AI cluster access, or through
  // direct access. The default runs it in-process with run().
  exec: null,
  ocp: null,                                      // { fetch, post, patch, delete } — context-aware
  now: () => Date.now(),
  audit: () => {},
  snApproval: null,                               // async (sysId) → "approved" | "rejected" | other
};
export function configureUserAccess(deps) { _deps = { ..._deps, ...deps }; }
const exec = (cluster, op, payload, ctx) => (_deps.exec ? _deps.exec(cluster, op, payload, ctx) : _deps.run(cluster, () => localOp(op, payload)));

/** One operation on the cluster in context. Also what a spoke runs for the hub. */
export async function localOp(op, p = {}) {
  switch (op) {
    case "read": return readCluster();
    case "grant": return applyGrant(p.q, p.hash || null);
    case "revoke": return applyRevoke(p.user);
    case "kubeadmin": return applyRemoveKubeadmin();
    case "expire": return applyExpire(p.q);
    default: throw err("Unknown operation");
  }
}

/* ─────────────────────────── small helpers ─────────────────────────── */

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const statusOf = (e) => Number(String(e?.message || "").match(/OCP API (\d{3})/)?.[1]) || e?.status || 0;
const get = async (path) => { try { return await _deps.ocp.fetch(path); } catch (e) { if (statusOf(e) === 404) return null; throw e; } };
const list = async (path) => { try { return (await _deps.ocp.fetch(path))?.items || []; } catch { return null; } };
const MERGE = "application/merge-patch+json";

export const validUser = (u) => /^[A-Za-z0-9][A-Za-z0-9._@+\-]{0,127}$/.test(String(u || "")) && !/^system:/.test(u);
export const validName = (n) => /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(String(n || ""));
const isSystem = (n) => /^system:/.test(String(n || ""));

/** Turn a group name into one the platform manages: tcs-<role>-<namespace|cluster>. */
export function managedGroupName(role, namespace) {
  return `tcs-${role}-${namespace || "cluster"}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63).replace(/-+$/, "");
}

/** htpasswd text → [{user, hash}] (hashes stay server-side). */
export function parseHtpasswd(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes(":"))
    .map((l) => { const i = l.indexOf(":"); return { user: l.slice(0, i), hash: l.slice(i + 1) }; });
}
export function addHtpasswd(text, user, hash) {
  const rows = parseHtpasswd(text);
  if (rows.some((r) => r.user === user)) throw err(`${user} already has a local (htpasswd) login on this cluster`, 409);
  return [...rows, { user, hash }].map((r) => `${r.user}:${r.hash}`).join("\n") + "\n";
}
export function removeHtpasswd(text, user) {
  const rows = parseHtpasswd(text);
  return { text: rows.filter((r) => r.user !== user).map((r) => `${r.user}:${r.hash}`).join("\n") + "\n", removed: rows.some((r) => r.user === user) };
}
/** A password people can type: 16 characters, no look-alikes. */
export function generatePassword() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const b = randomBytes(16);
  return Array.from(b, (x) => A[x % A.length]).join("");
}

/** OAuth identity providers in plain words. */
export function describeIdps(oauth) {
  return (oauth?.spec?.identityProviders || []).map((p) => {
    const type = p.type || "Unknown";
    const label = { HTPasswd: "htpasswd", LDAP: "AD / LDAP", OpenID: "SSO (OpenID Connect)", GitHub: "GitHub", GitLab: "GitLab", Google: "Google", Keystone: "Keystone", BasicAuth: "Basic auth", RequestHeader: "Request header" }[type] || type;
    const issuer = p.openID?.issuer || "";
    return {
      name: p.name, type, label: type === "OpenID" && /microsoftonline|login\.windows/.test(issuer) ? "Entra ID (SSO)" : type === "OpenID" && /keycloak|\/realms\//.test(issuer) ? "Keycloak (SSO)" : label,
      company: !["HTPasswd", "BasicAuth"].includes(type),
      htpasswdSecret: type === "HTPasswd" ? p.htpasswd?.fileData?.name || null : null,
    };
  });
}

/* ─────────────────────────── reading one cluster ─────────────────────────── */

/** Everything about access on the cluster in context. */
export async function readCluster() {
  const [oauth, users, groups, crbs, rbs, identities, tokens] = await Promise.all([
    get("/apis/config.openshift.io/v1/oauths/cluster").catch(() => null),
    list("/apis/user.openshift.io/v1/users"),
    list("/apis/user.openshift.io/v1/groups"),
    list("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings"),
    list("/apis/rbac.authorization.k8s.io/v1/rolebindings"),
    list("/apis/user.openshift.io/v1/identities"),
    list("/apis/oauth.openshift.io/v1/oauthaccesstokens"),
  ]);
  if (users === null && groups === null && crbs === null) throw err("Could not read users, groups or role bindings: the cluster is unreachable or the platform lacks permission (see deploy/user-access/rbac.yaml)", 502);
  // Keep only bindings to the roles we show, naming people or groups: a busy
  // cluster has thousands of service-account bindings that say nothing here.
  const ROLESET = new Set(ROLES);
  const human = (b) => ROLESET.has(b.roleRef?.name) && (b.subjects || []).some((s) => (s.kind === "User" || s.kind === "Group") && !isSystem(s.name));
  const slim = (b) => ({ metadata: { name: b.metadata?.name, namespace: b.metadata?.namespace }, roleRef: b.roleRef, subjects: b.subjects });
  let kubeadmin = null;
  try { kubeadmin = !!(await get("/api/v1/namespaces/kube-system/secrets/kubeadmin")); } catch { kubeadmin = null; }
  const idps = describeIdps(oauth);
  const htpasswdUsers = {};
  for (const p of idps.filter((x) => x.htpasswdSecret)) {
    try {
      const s = await get(`/api/v1/namespaces/openshift-config/secrets/${p.htpasswdSecret}`);
      const text = s?.data?.htpasswd ? Buffer.from(s.data.htpasswd, "base64").toString("utf8") : "";
      htpasswdUsers[p.name] = parseHtpasswd(text).map((r) => r.user);
    } catch { htpasswdUsers[p.name] = null; }
  }
  // Last login per user, from tokens, without shipping the tokens themselves.
  const lastLogin = tokens ? {} : null;
  for (const t of tokens || []) { const u = t.userName, at = t.metadata?.creationTimestamp; if (u && at && (!lastLogin[u] || at > lastLogin[u])) lastLogin[u] = at; }
  return {
    idps,
    users: (users || []).map((u) => ({ metadata: { name: u.metadata?.name }, identities: u.identities || [] })),
    groups: (groups || []).map((g) => ({ metadata: { name: g.metadata?.name, labels: g.metadata?.labels || {}, annotations: g.metadata?.annotations || {} }, users: g.users || [] })),
    crbs: (crbs || []).filter(human).map(slim), rbs: (rbs || []).filter(human).map(slim),
    identities: [], tokens: lastLogin ? Object.entries(lastLogin).map(([userName, at]) => ({ userName, metadata: { creationTimestamp: at } })) : null,
    kubeadmin, htpasswdUsers,
  };
}

/**
 * Who has what on one cluster, from the raw read. Pure.
 * → { people: { name: { grants: [{role, scope, via}], source, lastLogin } }, groups, flags }
 */
export function accessOf(raw, { now = Date.now() } = {}) {
  const ROLESET = new Set(ROLES);
  const groupUsers = new Map(raw.groups.map((g) => [g.metadata.name, g.users || []]));
  const groupMeta = new Map(raw.groups.map((g) => [g.metadata.name, g]));
  const idpType = new Map((raw.idps || []).map((p) => [p.name, p]));
  const people = {};
  const person = (n) => (people[n] ||= { grants: [], source: null, lastLogin: null, identities: [] });
  for (const u of raw.users) {
    const p = person(u.metadata.name);
    p.identities = u.identities || [];
    const prov = (u.identities || [])[0]?.split(":")[0];
    const idp = idpType.get(prov);
    p.source = idp ? (idp.type === "HTPasswd" ? "htpasswd" : idp.label) : prov || null;
  }
  const add = (subject, role, scope, via) => {
    if (subject.kind === "User" && !isSystem(subject.name)) person(subject.name).grants.push({ role, scope, via: "direct" });
    if (subject.kind === "Group" && !isSystem(subject.name)) for (const m of groupUsers.get(subject.name) || []) if (!isSystem(m)) person(m).grants.push({ role, scope, via: subject.name });
  };
  for (const b of raw.crbs) {
    const role = b.roleRef?.name;
    if (b.roleRef?.kind !== "ClusterRole" || !ROLESET.has(role)) continue;
    for (const s of b.subjects || []) add(s, role, "cluster");
  }
  for (const b of raw.rbs) {
    const role = b.roleRef?.name;
    if (!ROLESET.has(role) || CLUSTER_ROLES.has(role)) continue;
    for (const s of b.subjects || []) add(s, role, b.metadata.namespace);
  }
  // Last login: the newest OAuth access token per user (when readable).
  if (raw.tokens) for (const t of raw.tokens) {
    const u = t.userName, at = Date.parse(t.metadata?.creationTimestamp || "");
    if (u && people[u] && at && (!people[u].lastLogin || at > Date.parse(people[u].lastLogin))) people[u].lastLogin = new Date(at).toISOString();
  }
  const ap = raw.idps.filter((p) => p.company);
  const flags = [];
  const admins = Object.entries(people).filter(([, p]) => p.grants.some((g) => g.role === "cluster-admin"));
  for (const [n, p] of admins) if (p.grants.some((g) => g.role === "cluster-admin" && g.via === "direct")) flags.push({ level: "warn", person: n, text: "cluster-admin given directly, not through a group" });
  if (raw.kubeadmin && (ap.length || raw.idps.length) && admins.length) flags.push({ level: "crit", person: "kubeadmin", text: "kubeadmin still present; remove it once another admin can log in" });
  if (!ap.length) flags.push({ level: "warn", text: raw.idps.length ? "no company login (only htpasswd)" : "no identity provider configured" });
  const cutoff = now - INACTIVE_DAYS() * 86400000;
  for (const [n, p] of Object.entries(people)) if (p.grants.length && p.lastLogin && Date.parse(p.lastLogin) < cutoff) flags.push({ level: "warn", person: n, text: `last login ${Math.round((now - Date.parse(p.lastLogin)) / 86400000)} days ago` });
  const groups = raw.groups.map((g) => ({
    name: g.metadata.name, members: (g.users || []).length,
    synced: !!(g.metadata?.labels?.["openshift.io/ldap.host"] || g.metadata?.annotations?.["openshift.io/ldap.url"]),
    syncedAt: g.metadata?.annotations?.["openshift.io/ldap.sync-time"] || null,
    managed: g.metadata?.labels?.[MANAGED] === MANAGED_VAL,
  }));
  void groupMeta;
  return { people, groups, flags, admins: admins.length };
}

/* ─────────────────────────── summary across clusters ─────────────────────────── */

export async function summary(clusters, ctx = null) {
  const now = _deps.now();
  const per = await Promise.all(clusters.map(async (c) => {
    try {
      const raw = await exec(c, "read", {}, ctx);
      const acc = accessOf(raw, { now });
      return { cluster: c, ok: true, raw, acc };
    } catch (e) { return { cluster: c, ok: false, error: e.message }; }
  }));
  const people = {};
  for (const r of per.filter((x) => x.ok)) {
    for (const [name, p] of Object.entries(r.acc.people)) {
      if (!p.grants.length && !p.identities.length) continue;
      const row = (people[name] ||= { name, source: null, clusters: {}, lastLogin: null, flags: [] });
      row.source = row.source || p.source;
      row.clusters[r.cluster] = p.grants;
      if (p.lastLogin && (!row.lastLogin || p.lastLogin > row.lastLogin)) row.lastLogin = p.lastLogin;
    }
    for (const f of r.acc.flags) if (f.person && people[f.person]) people[f.person].flags.push({ ...f, cluster: r.cluster });
  }
  // kubeadmin as a row of its own.
  const kube = per.filter((x) => x.ok).map((x) => [x.cluster, x.raw.kubeadmin]);
  if (kube.some(([, v]) => v)) people.kubeadmin = { name: "kubeadmin", source: "built-in", clusters: Object.fromEntries(kube.map(([c, v]) => [c, v ? [{ role: "cluster-admin", scope: "cluster", via: "built-in" }] : []])), lastLogin: null, flags: [{ level: "crit", text: "remove once company login works" }], builtin: true, kubeadmin: Object.fromEntries(kube) };
  // htpasswd files that differ from the first cluster that has one.
  const ht = per.filter((x) => x.ok).map((x) => [x.cluster, [...new Set(Object.values(x.raw.htpasswdUsers).flat().filter(Boolean))]]);
  const base = ht.find(([, u]) => u.length);
  const clusterRows = per.map((r) => {
    if (!r.ok) return { cluster: r.cluster, ok: false, error: r.error };
    const mine = ht.find(([c]) => c === r.cluster)?.[1] || [];
    const diff = base && base[0] !== r.cluster && mine.length ? [...new Set([...mine.filter((u) => !base[1].includes(u)), ...base[1].filter((u) => !mine.includes(u))])] : [];
    const synced = r.acc.groups.filter((g) => g.synced).map((g) => g.syncedAt).filter(Boolean).sort().pop() || null;
    return {
      cluster: r.cluster, ok: true, idps: r.raw.idps.map(({ name, type, label, company }) => ({ name, type, label, company })),
      kubeadmin: r.raw.kubeadmin, htpasswdUsers: mine.length, htpasswdDiffers: diff.length ? { from: base[0], users: diff.length } : null,
      lastGroupSync: synced, admins: r.acc.admins, flags: r.acc.flags.filter((f) => !f.person),
      groups: r.acc.groups.filter((g) => !isSystem(g.name)).map((g) => ({ name: g.name, members: g.members, synced: g.synced, managed: g.managed })),
      lastLoginKnown: !!r.raw.tokens,
    };
  });
  const rows = Object.values(people).sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0) || a.name.localeCompare(b.name));
  const ok = clusterRows.filter((c) => c.ok);
  const st = await load();
  return {
    at: new Date(now).toISOString(),
    clusters: clusterRows,
    people: rows,
    kpis: {
      clusters: clusters.length, reachable: ok.length,
      companyLogin: ok.filter((c) => c.idps.some((p) => p.company)).length,
      people: rows.filter((r) => !r.builtin && Object.values(r.clusters).some((g) => g.length)).length,
      clusterAdmins: rows.filter((r) => !r.builtin && Object.values(r.clusters).some((g) => g.some((x) => x.role === "cluster-admin"))).length,
      directAdmins: rows.filter((r) => r.flags.some((f) => /directly/.test(f.text))).length,
      kubeadmin: ok.filter((c) => c.kubeadmin).length,
      inactive: rows.filter((r) => r.flags.some((f) => /last login/.test(f.text))).length,
      pending: st.requests.filter((q) => q.status === "pending").length,
    },
    requests: st.requests.slice(0, 50),
    roles: ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r], clusterWide: CLUSTER_ROLES.has(r) })),
  };
}

/* ─────────────────────────── requests ─────────────────────────── */

let _state = null;
async function load() {
  if (_state) return _state;
  let st = null;
  try { if (await dbEnabled()) { const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [STORE_KEY]); let v = r?.rows?.[0]?.value; if (typeof v === "string") v = JSON.parse(v); if (v && typeof v === "object") st = v; } } catch { /* fall through */ }
  if (!st) { try { st = JSON.parse(await readFile(FILE(), "utf8")); } catch { /* none */ } }
  _state = { seq: 0, requests: [], ...(st || {}) };
  return _state;
}
async function save() {
  const json = JSON.stringify(_state);
  try { if (await dbEnabled()) { await dbQuery("INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()", [STORE_KEY, json]); return; } } catch { /* fall through */ }
  try { await mkdir(dirname(FILE()), { recursive: true }); await writeFile(FILE(), json, "utf8"); } catch { /* memory only */ }
}
export function _resetUserAccess() { _state = { seq: 0, requests: [] }; }

/** Check and normalise a request body. */
export function validateRequest(b) {
  const kind = b?.kind;
  if (!["grant", "revoke", "remove-kubeadmin"].includes(kind)) throw err("Unknown request");
  const clusters = [...new Set((Array.isArray(b.clusters) ? b.clusters : []).map(String))].filter((c) => /^[A-Za-z0-9._:-]{1,128}$/.test(c));
  if (!clusters.length) throw err("Pick at least one cluster");
  if (kind === "remove-kubeadmin") return { kind, clusters, reason: String(b.reason || "").slice(0, 300) };
  if (!validUser(b.user)) throw err("Give the person’s OpenShift user name (as their company login shows it, or a new local name)");
  if (kind === "revoke") return { kind, clusters, user: b.user, reason: String(b.reason || "").slice(0, 300) };
  const mode = b.mode === "htpasswd" ? "htpasswd" : "directory";
  const role = String(b.role || "");
  if (!ROLES.includes(role)) throw err("Pick a role");
  const namespace = CLUSTER_ROLES.has(role) ? null : String(b.namespace || "");
  if (!CLUSTER_ROLES.has(role) && !validName(namespace)) throw err("Give the namespace for this role");
  const group = b.group ? String(b.group) : managedGroupName(role, namespace);
  if (!validName(group)) throw err("Not a valid group name");
  let expires = null;
  if (b.expires) {
    const t = Date.parse(b.expires);
    if (!t || t <= _deps.now()) throw err("The expiry date must be in the future");
    if (t > _deps.now() + 366 * 86400000) throw err("Access can be granted for at most a year at a time");
    expires = new Date(t).toISOString();
  }
  const delivery = ["direct", "acm", "gitops"].includes(b.delivery) ? b.delivery : "direct";
  if (mode === "htpasswd" && delivery !== "direct") throw err("Local (htpasswd) users can only be applied directly: their password must never go into Git or a policy");
  return { kind, clusters, user: b.user, mode, role, namespace, group, expires, delivery, reason: String(b.reason || "").slice(0, 300) };
}

export function describe(q) {
  if (q.kind === "remove-kubeadmin") return `Remove kubeadmin from ${q.clusters.length} cluster${q.clusters.length > 1 ? "s" : ""}`;
  if (q.kind === "revoke") return `Remove ${q.user} from ${q.clusters.length} cluster${q.clusters.length > 1 ? "s" : ""}`;
  return `${q.user}: ${ROLE_LABEL[q.role]}${q.namespace ? ` on namespace ${q.namespace}` : ""} on ${q.clusters.length} cluster${q.clusters.length > 1 ? "s" : ""}${q.expires ? ` until ${q.expires.slice(0, 10)}` : ""}${q.mode === "htpasswd" ? " (local htpasswd login)" : ""}`;
}

export async function createRequest(body, actor) {
  const v = validateRequest(body);
  const st = await load();
  const q = { id: `UA-${String(++st.seq).padStart(4, "0")}`, ...v, status: "pending", requestedBy: actor, requestedAt: new Date(_deps.now()).toISOString(), title: describe(v) };
  st.requests.unshift(q);
  st.requests = st.requests.slice(0, 500);
  await save();
  _deps.audit(`User & Access: request ${q.id} — ${q.title}`, { id: q.id }, actor);
  return q;
}

export async function rejectRequest(id, actor, note) {
  const st = await load();
  const q = st.requests.find((x) => x.id === id);
  if (!q) throw err("No such request", 404);
  if (q.status !== "pending") throw err(`This request is already ${q.status}`, 409);
  Object.assign(q, { status: "rejected", decidedBy: actor, decidedAt: new Date(_deps.now()).toISOString(), note: String(note || "").slice(0, 300) });
  await save();
  _deps.audit(`User & Access: ${q.id} rejected`, { id }, actor);
  return q;
}

/**
 * Approve and carry out. Returns the request with per-cluster results; for an
 * htpasswd grant, also `password`, shown once and never stored.
 */
export async function approveRequest(id, actor, { allowSelf = false, ctx = null, via = null } = {}) {
  const st = await load();
  const q = st.requests.find((x) => x.id === id);
  if (!q) throw err("No such request", 404);
  if (q.status !== "pending") throw err(`This request is already ${q.status}`, 409);
  if (!via && !allowSelf && q.requestedBy && q.requestedBy === actor) throw err("Someone other than the requester must approve (or approve the ServiceNow change)", 403);
  q.status = "running"; q.decidedBy = via || actor; q.decidedAt = new Date(_deps.now()).toISOString();
  await save();
  let password = null, manifests = null;
  if (q.kind === "grant" && q.delivery !== "direct") {
    manifests = grantManifests(q);
    q.results = q.clusters.map((c) => ({ cluster: c, ok: true, text: q.delivery === "acm" ? "ACM policy generated for you to apply on the hub" : "Manifests generated for your GitOps repository" }));
  } else {
    let hash = null;
    if (q.kind === "grant" && q.mode === "htpasswd") { password = generatePassword(); hash = bcrypt.hashSync(password, 10); }
    q.results = [];
    for (const c of q.clusters) {
      try {
        const op = q.kind === "grant" ? "grant" : q.kind === "revoke" ? "revoke" : "kubeadmin";
        const payload = op === "grant" ? { q: { id: q.id, user: q.user, mode: q.mode, role: q.role, namespace: q.namespace, group: q.group }, hash } : op === "revoke" ? { user: q.user } : {};
        const text = await exec(c, op, payload, ctx);
        q.results.push({ cluster: c, ok: true, text });
      } catch (e) {
        q.results.push({ cluster: c, ok: false, text: /read-only/i.test(e.message) ? "This cluster is reached through the read-only bridge; changes need its agent credentials or direct access" : e.message.slice(0, 300) });
      }
    }
  }
  const good = q.results.filter((r) => r.ok).length;
  q.status = good === q.results.length ? "done" : good ? "partly done" : "failed";
  if (q.kind === "grant" && q.expires && q.delivery === "direct") q.expiryPending = good > 0;
  await save();
  _deps.audit(`User & Access: ${q.id} approved${via ? ` in ${via}` : ""} — ${q.title}: ${q.status}`, { id, results: q.results }, via || actor);
  return { ...q, password, manifests };
}

export async function getRequest(id) {
  const q = (await load()).requests.find((x) => x.id === id);
  if (!q) throw err("No such request", 404);
  return q;
}
export async function setTicket(id, number, sysId = null) {
  const q = await getRequest(id);
  q.ticket = number;
  if (sysId) q.ticketSysId = sysId;
  await save();
  return q;
}

/**
 * Background: a pending request whose ServiceNow change has been approved is
 * applied; one whose change was rejected is rejected. The ServiceNow approval
 * is the approval. A password for an htpasswd user is never produced this way:
 * those need an approver in the platform, who sees it once.
 */
export async function serviceNowTick() {
  if (!_deps.snApproval) return [];
  const st = await load();
  const out = [];
  for (const q of st.requests.filter((x) => x.status === "pending" && x.ticketSysId)) {
    let a;
    try { a = await _deps.snApproval(q.ticketSysId); } catch { continue; }
    if (a === "approved") {
      if (q.kind === "grant" && q.mode === "htpasswd") { q.snApproved = true; await save(); continue; }
      await approveRequest(q.id, "servicenow", { via: `ServiceNow ${q.ticket}` });
      out.push(q.id);
    } else if (a === "rejected") {
      await rejectRequest(q.id, `ServiceNow ${q.ticket}`, "Rejected in ServiceNow");
      out.push(q.id);
    }
  }
  return out;
}

/* ─────────────────────────── changes on one cluster ─────────────────────────── */

const labels = { [MANAGED]: MANAGED_VAL };

async function ensureGroupMember(group, user) {
  const g = await get(`/apis/user.openshift.io/v1/groups/${group}`);
  if (!g) {
    await _deps.ocp.post("/apis/user.openshift.io/v1/groups", { apiVersion: "user.openshift.io/v1", kind: "Group", metadata: { name: group, labels }, users: [user] });
    return `group ${group} created with ${user}`;
  }
  if (g.metadata?.labels?.["openshift.io/ldap.host"]) {
    if ((g.users || []).includes(user)) return `${user} is already in ${group} (synced from AD)`;
    throw err(`${group} is synced from AD/LDAP; add ${user} to it in the directory instead (a change here would be undone by the next sync)`, 409);
  }
  if ((g.users || []).includes(user)) return `${user} already in ${group}`;
  await _deps.ocp.patch(`/apis/user.openshift.io/v1/groups/${group}`, { users: [...(g.users || []), user] }, MERGE);
  return `${user} added to ${group}`;
}

async function ensureBinding(q) {
  const name = `tcs-ua-${q.group}-${q.role}`.slice(0, 63).replace(/-+$/, "");
  const body = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    metadata: { name, labels, annotations: { "tcs.io/request": q.id } },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: q.role },
    subjects: [{ apiGroup: "rbac.authorization.k8s.io", kind: "Group", name: q.group }],
  };
  if (q.namespace) {
    if (!(await get(`/api/v1/namespaces/${q.namespace}`))) throw err(`Namespace ${q.namespace} does not exist on this cluster`, 404);
    if (await get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${q.namespace}/rolebindings/${name}`)) return `binding ${name} already there`;
    await _deps.ocp.post(`/apis/rbac.authorization.k8s.io/v1/namespaces/${q.namespace}/rolebindings`, { ...body, kind: "RoleBinding", metadata: { ...body.metadata, namespace: q.namespace } });
  } else {
    if (await get(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${name}`)) return `binding ${name} already there`;
    await _deps.ocp.post("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings", { ...body, kind: "ClusterRoleBinding" });
  }
  return `group ${q.group} bound to ${q.role}${q.namespace ? ` in ${q.namespace}` : " cluster-wide"}`;
}

async function htpasswdSecret() {
  const oauth = await get("/apis/config.openshift.io/v1/oauths/cluster");
  const idp = describeIdps(oauth).find((p) => p.htpasswdSecret);
  if (!idp) throw err("This cluster has no htpasswd login configured; add an HTPasswd identity provider first, or use company login", 409);
  const s = await get(`/api/v1/namespaces/openshift-config/secrets/${idp.htpasswdSecret}`);
  if (!s) throw err(`The htpasswd Secret ${idp.htpasswdSecret} is missing in openshift-config`, 409);
  return { name: idp.htpasswdSecret, text: s.data?.htpasswd ? Buffer.from(s.data.htpasswd, "base64").toString("utf8") : "" };
}

export async function applyGrant(q, hash) {
  const steps = [];
  if (q.mode === "htpasswd") {
    const s = await htpasswdSecret();
    const text = addHtpasswd(s.text, q.user, hash);
    await _deps.ocp.patch(`/api/v1/namespaces/openshift-config/secrets/${s.name}`, { data: { htpasswd: Buffer.from(text).toString("base64") } }, MERGE);
    steps.push(`local login for ${q.user} added to ${s.name}`);
  }
  // Check the namespace before touching groups, so a typo changes nothing.
  if (q.namespace && !(await get(`/api/v1/namespaces/${q.namespace}`))) throw err(`Namespace ${q.namespace} does not exist on this cluster`, 404);
  steps.push(await ensureGroupMember(q.group, q.user));
  steps.push(await ensureBinding(q));
  return steps.join("; ");
}

/** Take a person off this cluster: groups, direct bindings, local login, user and identities. */
export async function applyRevoke(user) {
  const raw = await readCluster();
  const acc = accessOf(raw);
  // Never leave a cluster without a cluster-admin who can log in.
  const others = Object.entries(acc.people).filter(([n, p]) => n !== user && p.grants.some((g) => g.role === "cluster-admin"));
  const isAdmin = acc.people[user]?.grants.some((g) => g.role === "cluster-admin");
  if (isAdmin && !others.length && !raw.kubeadmin) throw err(`${user} is the only cluster-admin who can log in here; add another admin first`, 409);
  const done = [], kept = [];
  for (const g of raw.groups) {
    if (!(g.users || []).includes(user)) continue;
    if (g.metadata?.labels?.["openshift.io/ldap.host"]) { kept.push(g.metadata.name); continue; }
    await _deps.ocp.patch(`/apis/user.openshift.io/v1/groups/${g.metadata.name}`, { users: g.users.filter((u) => u !== user) }, MERGE);
    done.push(`left ${g.metadata.name}`);
  }
  for (const b of [...raw.crbs.map((x) => ({ ...x, cluster: true })), ...raw.rbs]) {
    const subs = b.subjects || [];
    if (!subs.some((s) => s.kind === "User" && s.name === user)) continue;
    const path = b.cluster ? `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${b.metadata.name}` : `/apis/rbac.authorization.k8s.io/v1/namespaces/${b.metadata.namespace}/rolebindings/${b.metadata.name}`;
    const rest = subs.filter((s) => !(s.kind === "User" && s.name === user));
    if (rest.length) await _deps.ocp.patch(path, { subjects: rest }, MERGE); else await _deps.ocp.delete(path);
    done.push(`binding ${b.metadata.name} ${rest.length ? "updated" : "removed"}`);
  }
  const idps = describeIdps(await get("/apis/config.openshift.io/v1/oauths/cluster"));
  for (const p of idps.filter((x) => x.htpasswdSecret)) {
    const s = await get(`/api/v1/namespaces/openshift-config/secrets/${p.htpasswdSecret}`);
    const r = removeHtpasswd(s?.data?.htpasswd ? Buffer.from(s.data.htpasswd, "base64").toString("utf8") : "", user);
    if (r.removed) { await _deps.ocp.patch(`/api/v1/namespaces/openshift-config/secrets/${p.htpasswdSecret}`, { data: { htpasswd: Buffer.from(r.text).toString("base64") } }, MERGE); done.push(`local login removed from ${p.htpasswdSecret}`); }
  }
  const u = raw.users.find((x) => x.metadata.name === user);
  if (u) {
    for (const i of u.identities || []) { try { await _deps.ocp.delete(`/apis/user.openshift.io/v1/identities/${encodeURIComponent(i)}`); } catch { /* already gone */ } }
    await _deps.ocp.delete(`/apis/user.openshift.io/v1/users/${encodeURIComponent(user)}`);
    done.push("user and identities deleted");
  }
  if (!done.length && !kept.length) return `${user} had no access here`;
  return [done.join("; "), kept.length ? `still in AD-synced group${kept.length > 1 ? "s" : ""} ${kept.join(", ")}: remove in the directory` : ""].filter(Boolean).join(". ");
}

/** Delete kube-system/kubeadmin, only when someone else can log in as cluster-admin. */
export async function applyRemoveKubeadmin() {
  const raw = await readCluster();
  if (!raw.kubeadmin) return "kubeadmin already removed";
  const acc = accessOf(raw);
  const admins = Object.entries(acc.people).filter(([, p]) => p.grants.some((g) => g.role === "cluster-admin"));
  if (!raw.idps.length) throw err("No identity provider is configured: removing kubeadmin would lock everyone out", 409);
  if (!admins.length) throw err("No other user has cluster-admin yet: grant it to someone (through a group) first", 409);
  await _deps.ocp.delete("/api/v1/namespaces/kube-system/secrets/kubeadmin");
  return `kubeadmin removed; ${admins.length} other cluster-admin${admins.length > 1 ? "s" : ""} can log in`;
}

/** Remove a person from a platform-managed group (expiry). */
export async function applyExpire(q) {
  const g = await get(`/apis/user.openshift.io/v1/groups/${q.group}`);
  if (!g || !(g.users || []).includes(q.user)) return `${q.user} no longer in ${q.group}`;
  if (g.metadata?.labels?.["openshift.io/ldap.host"]) return `${q.group} is AD-synced; remove ${q.user} in the directory`;
  await _deps.ocp.patch(`/apis/user.openshift.io/v1/groups/${q.group}`, { users: g.users.filter((u) => u !== q.user) }, MERGE);
  return `${q.user} removed from ${q.group} (access expired)`;
}

/** Background: take away access whose expiry date has passed. */
export async function expireTick() {
  const st = await load();
  const now = _deps.now();
  const out = [];
  for (const q of st.requests.filter((x) => x.kind === "grant" && x.expiryPending && x.expires && Date.parse(x.expires) <= now)) {
    const results = [];
    for (const r of (q.results || []).filter((x) => x.ok)) {
      try { results.push({ cluster: r.cluster, ok: true, text: await exec(r.cluster, "expire", { q: { user: q.user, group: q.group } }, null) }); }
      catch (e) { results.push({ cluster: r.cluster, ok: false, text: e.message.slice(0, 200) }); }
    }
    q.expiryPending = results.some((r) => !r.ok);
    q.expired = { at: new Date(now).toISOString(), results };
    out.push(q.id);
    _deps.audit(`User & Access: ${q.id} expired — ${q.user} removed from ${q.group}`, { id: q.id, results }, "system");
  }
  if (out.length) await save();
  return out;
}

/* ─────────────────────────── ACM / GitOps delivery ─────────────────────────── */

const yamlStr = (s) => (/^[A-Za-z0-9._@\/-]+$/.test(s) ? s : JSON.stringify(s));
function objectYaml(o, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(o)) return o.map((x) => (typeof x === "object" ? `${pad}- ${objectYaml(x, indent + 2).trimStart()}` : `${pad}- ${yamlStr(String(x))}`)).join("\n");
  return Object.entries(o).map(([k, v]) => {
    if (v && typeof v === "object") return `${pad}${k}:\n${objectYaml(v, indent + 2)}`;
    return `${pad}${k}: ${yamlStr(String(v))}`;
  }).join("\n");
}
/** The Group and binding as YAML; for ACM, wrapped in a Policy that enforces them. */
export function grantManifests(q) {
  const group = { apiVersion: "user.openshift.io/v1", kind: "Group", metadata: { name: q.group, labels }, users: [q.user] };
  const name = `tcs-ua-${q.group}-${q.role}`.slice(0, 63).replace(/-+$/, "");
  const binding = {
    apiVersion: "rbac.authorization.k8s.io/v1", kind: q.namespace ? "RoleBinding" : "ClusterRoleBinding",
    metadata: { name, ...(q.namespace ? { namespace: q.namespace } : {}), labels },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: q.role },
    subjects: [{ apiGroup: "rbac.authorization.k8s.io", kind: "Group", name: q.group }],
  };
  if (q.delivery !== "acm") return [group, binding].map((o) => objectYaml(o)).join("\n---\n") + "\n";
  const policy = {
    apiVersion: "policy.open-cluster-management.io/v1", kind: "Policy",
    metadata: { name: `tcs-access-${q.group}`.slice(0, 63), namespace: "tcs-policies", annotations: { "policy.open-cluster-management.io/standards": "NIST SP 800-53", "policy.open-cluster-management.io/categories": "AC Access Control", "policy.open-cluster-management.io/controls": "AC-2 Account Management" } },
    spec: { remediationAction: "enforce", disabled: false, "policy-templates": [{ objectDefinition: { apiVersion: "policy.open-cluster-management.io/v1", kind: "ConfigurationPolicy", metadata: { name: `tcs-access-${q.group}`.slice(0, 63) }, spec: { remediationAction: "enforce", severity: "medium", "object-templates": [{ complianceType: "musthave", objectDefinition: group }, { complianceType: "musthave", objectDefinition: binding }] } } }] },
  };
  return `# Apply on the ACM hub, then bind it to these clusters with a Placement:\n# ${q.clusters.join(", ")}\n${objectYaml(policy)}\n`;
}
