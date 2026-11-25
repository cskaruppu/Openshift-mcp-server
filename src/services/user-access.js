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
    case "unbind": return applyUnbind(p);
    case "unbindsubject": return applyUnbindSubject(p);
    case "disable": return applyDisable(p.user);
    case "enable": return applyEnable(p.user, p.snapshot);
    case "setpass": return applySetPassword(p.user, p.hash);
    case "sessions": return revokeSessions(p.user);
    case "can-i": return canI(p);
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
  const slim = (b) => ({ metadata: { name: b.metadata?.name, namespace: b.metadata?.namespace, creationTimestamp: b.metadata?.creationTimestamp || null, labels: { [MANAGED]: b.metadata?.labels?.[MANAGED] || undefined }, annotations: { "tcs.io/request": b.metadata?.annotations?.["tcs.io/request"] || undefined } }, roleRef: b.roleRef, subjects: b.subjects });
  // Service accounts with cluster-admin or admin outside the platform's own namespaces.
  const privilegedSAs = [];
  for (const b of [...(crbs || []), ...(rbs || [])]) {
    if (!["cluster-admin", "admin"].includes(b.roleRef?.name)) continue;
    for (const sub of b.subjects || []) if (sub.kind === "ServiceAccount" && !/^(openshift|kube)-|^(openshift|kube-system|default)$/.test(sub.namespace || "")) privilegedSAs.push({ namespace: sub.namespace, name: sub.name, role: b.roleRef.name, binding: b.metadata?.name, scope: b.metadata?.namespace || "cluster" });
  }
  // What each offered role is, from the cluster itself.
  const roleDocs = {};
  await Promise.all(ROLES.map(async (r) => {
    try {
      const cr = await get(`/apis/rbac.authorization.k8s.io/v1/clusterroles/${r}`);
      if (!cr) return;
      const rules = cr.rules || [];
      roleDocs[r] = {
        description: cr.metadata?.annotations?.["openshift.io/description"] || null,
        rules: rules.length, aggregated: !!cr.aggregationRule,
        verbs: [...new Set(rules.flatMap((x) => x.verbs || []))].slice(0, 12),
        resources: [...new Set(rules.flatMap((x) => x.resources || []))].slice(0, 30),
      };
    } catch { /* optional */ }
  }));
  let kubeadmin = null;
  try { kubeadmin = !!(await get("/api/v1/namespaces/kube-system/secrets/kubeadmin")); } catch { kubeadmin = null; }
  const idps = describeIdps(oauth);
  const htpasswdUsers = {};
  let htpasswdLocked = null;
  for (const p of idps.filter((x) => x.htpasswdSecret)) {
    try {
      const s = await get(`/api/v1/namespaces/openshift-config/secrets/${p.htpasswdSecret}`);
      const text = s?.data?.htpasswd ? Buffer.from(s.data.htpasswd, "base64").toString("utf8") : "";
      const rows = parseHtpasswd(text);
      htpasswdUsers[p.name] = rows.map((r) => r.user);
      for (const r of rows) if (r.hash.startsWith("!")) (htpasswdLocked ||= []).push(r.user);
    } catch { htpasswdUsers[p.name] = null; }
  }
  // Last login per user, from tokens, without shipping the tokens themselves.
  const lastLogin = tokens ? {} : null;
  const sessions = tokens ? {} : null;
  const nowMs = Date.now();
  for (const t of tokens || []) {
    const u = t.userName, at = t.metadata?.creationTimestamp;
    if (u && at && (!lastLogin[u] || at > lastLogin[u])) lastLogin[u] = at;
    const exp = t.expiresIn ? Date.parse(at) + t.expiresIn * 1000 : null;
    if (u && (!exp || exp > nowMs)) sessions[u] = (sessions[u] || 0) + 1;
  }
  return {
    idps,
    users: (users || []).map((u) => ({ metadata: { name: u.metadata?.name, creationTimestamp: u.metadata?.creationTimestamp || null }, identities: u.identities || [] })),
    groups: (groups || []).map((g) => ({ metadata: { name: g.metadata?.name, labels: g.metadata?.labels || {}, annotations: g.metadata?.annotations || {} }, users: g.users || [] })),
    crbs: (crbs || []).filter(human).map(slim), rbs: (rbs || []).filter(human).map(slim),
    identities: [], tokens: lastLogin ? Object.entries(lastLogin).map(([userName, at]) => ({ userName, metadata: { creationTimestamp: at } })) : null,
    kubeadmin, htpasswdUsers, htpasswdLocked: htpasswdLocked || [], sessions, roleDocs, privilegedSAs,
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
  const person = (n) => (people[n] ||= { grants: [], source: null, lastLogin: null, identities: [], createdAt: null, sessions: 0, locked: false, provider: null });
  const lockedSet = new Set(raw.htpasswdLocked || []);
  for (const u of raw.users) {
    const p = person(u.metadata.name);
    p.identities = u.identities || [];
    p.createdAt = u.metadata?.creationTimestamp || null;
    p.provider = (u.identities || [])[0]?.split(":")[0] || null;
    const prov = (u.identities || [])[0]?.split(":")[0];
    const idp = idpType.get(prov);
    p.source = idp ? (idp.type === "HTPasswd" ? "htpasswd" : idp.label) : prov || null;
  }
  const add = (subject, role, scope, b) => {
    const binding = { name: b.metadata?.name, namespace: b.metadata?.namespace || null, managed: b.metadata?.labels?.[MANAGED] === MANAGED_VAL, request: b.metadata?.annotations?.["tcs.io/request"] || null, createdAt: b.metadata?.creationTimestamp || null };
    if (subject.kind === "User" && !isSystem(subject.name)) person(subject.name).grants.push({ role, scope, via: "direct", binding });
    if (subject.kind === "Group" && !isSystem(subject.name)) {
      const synced = !!groupMeta.get(subject.name)?.metadata?.labels?.["openshift.io/ldap.host"];
      for (const m of groupUsers.get(subject.name) || []) if (!isSystem(m)) person(m).grants.push({ role, scope, via: subject.name, synced, binding });
    }
  };
  for (const b of raw.crbs) {
    const role = b.roleRef?.name;
    if (b.roleRef?.kind !== "ClusterRole" || !ROLESET.has(role)) continue;
    for (const s of b.subjects || []) add(s, role, "cluster", b);
  }
  for (const b of raw.rbs) {
    const role = b.roleRef?.name;
    if (!ROLESET.has(role) || CLUSTER_ROLES.has(role)) continue;
    for (const s of b.subjects || []) add(s, role, b.metadata.namespace, b);
  }
  for (const [n, p] of Object.entries(people)) { p.sessions = raw.sessions?.[n] || 0; p.locked = lockedSet.has(n); }
  for (const n of lockedSet) person(n).locked = true;
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
  // Possible leavers: logs in through AD/LDAP but is no longer in any group synced from it.
  const syncedGroups = raw.groups.filter((g) => g.metadata?.labels?.["openshift.io/ldap.host"]);
  if (syncedGroups.length) {
    const inSynced = new Set(syncedGroups.flatMap((g) => g.users || []));
    for (const [n, p] of Object.entries(people)) {
      if (idpType.get(p.provider)?.type === "LDAP" && !inSynced.has(n) && p.grants.length) flags.push({ level: "warn", person: n, text: "not in any AD-synced group any more (possible leaver)", leaver: true });
    }
  }
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
      const row = (people[name] ||= { name, source: null, clusters: {}, detail: {}, lastLogin: null, flags: [] });
      row.source = row.source || p.source;
      row.clusters[r.cluster] = p.grants;
      row.detail[r.cluster] = { exists: p.identities.length > 0 || !!p.createdAt, createdAt: p.createdAt, provider: p.provider, source: p.source, sessions: p.sessions, locked: p.locked };
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
  const gov = governance(per.filter((x) => x.ok), rows, st, now);
  for (const r of rows) {
    const rot = st.rotation?.[r.name];
    if (rot?.everyDays) {
      const due = rot.lastSetAt ? Date.parse(rot.lastSetAt) + rot.everyDays * 86400000 : null;
      r.rotation = { everyDays: rot.everyDays, lastSetAt: rot.lastSetAt || null, dueAt: due ? new Date(due).toISOString() : null, overdue: !due || due < now };
      if (r.rotation.overdue) r.flags.push({ level: "warn", text: rot.lastSetAt ? "password rotation overdue" : "password never rotated by the platform" });
    }
    if (st.disabled?.[r.name]) r.disabled = st.disabled[r.name];
  }
  return {
    roleDocs: Object.fromEntries(ROLES.map((role) => [role, { ...ROLE_DOC[role], cluster: per.find((x) => x.ok && x.raw.roleDocs?.[role])?.raw.roleDocs[role] || null }])),
    governance: gov,
    reviews: (st.reviews || []).map(reviewSummary),
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
      unofficial: gov.unofficial.length, sod: gov.sod.length, leavers: gov.leavers.length,
    },
    requests: st.requests.slice(0, 200),
    roles: ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r], clusterWide: CLUSTER_ROLES.has(r) })),
  };
}

/* ─────────────────────────── governance ─────────────────────────── */

/** What each offered role lets someone do, in plain words. */
export const ROLE_DOC = {
  view: { label: "Viewer", scope: "namespace", text: "See most objects in the namespace: pods, deployments, services, routes, logs. Cannot change anything, and cannot see secrets or who has access." },
  edit: { label: "Developer", scope: "namespace", text: "Create, change and delete most objects in the namespace, including deployments, services, routes, config maps and secrets. Cannot change roles or who has access." },
  admin: { label: "Namespace admin", scope: "namespace", text: "Everything a developer can do, plus manage roles and access within the namespace. Cannot change quotas or the namespace itself." },
  "cluster-reader": { label: "Cluster reader", scope: "cluster", text: "Read most objects in every namespace and cluster settings, including nodes and operators. Cannot change anything or read secrets." },
  "cluster-admin": { label: "Cluster admin", scope: "cluster", text: "Full control of every object in every namespace and of the cluster itself, including security settings and other people’s access. Give it through a group, and for limited periods." },
};

const PROD = () => new RegExp(process.env.USER_ACCESS_PROD_PATTERN || "prod", "i");
export const bindingKey = (cluster, ns, binding, kind, name) => `${cluster}|${ns || ""}|${binding}|${kind}:${name}`;

/**
 * Unofficial grants, separation-of-duties findings, possible leavers and
 * privileged service accounts, across the clusters read. Pure.
 */
export function governance(okPer, rows, st, now) {
  void now;
  const baseline = new Set(st.baseline || []);
  const unofficial = [];
  for (const r of okPer) {
    for (const b of [...r.raw.crbs.map((x) => ({ ...x, cl: true })), ...r.raw.rbs]) {
      const role = b.roleRef?.name;
      if (!["cluster-admin", "admin"].includes(role)) continue;
      if (b.metadata?.labels?.[MANAGED] === MANAGED_VAL) continue;
      for (const sub of b.subjects || []) {
        if (!["User", "Group"].includes(sub.kind) || isSystem(sub.name)) continue;
        const key = bindingKey(r.cluster, b.cl ? null : b.metadata?.namespace, b.metadata?.name, sub.kind, sub.name);
        if (baseline.has(key)) continue;
        unofficial.push({ key, cluster: r.cluster, binding: b.metadata?.name, namespace: b.cl ? null : b.metadata?.namespace || null, role, subjectKind: sub.kind, subject: sub.name, createdAt: b.metadata?.creationTimestamp || null });
      }
    }
  }
  const prod = PROD();
  const approvers = new Set((st.requests || []).filter((q) => q.decidedBy && !/^ServiceNow /.test(q.decidedBy) && q.status !== "rejected").map((q) => q.decidedBy));
  const sod = [];
  for (const p of rows.filter((x) => !x.builtin)) {
    const adminOn = Object.entries(p.clusters).filter(([, g]) => g.some((x) => x.role === "cluster-admin")).map(([c]) => c);
    const prodAdmin = adminOn.filter((c) => prod.test(c));
    const direct = Object.entries(p.clusters).filter(([, g]) => g.some((x) => x.role === "cluster-admin" && x.via === "direct")).map(([c]) => c);
    if (direct.length) sod.push({ rule: "direct-admin", person: p.name, clusters: direct, text: "cluster-admin given directly to a person, not through a group" });
    if (prodAdmin.length && /htpasswd/.test(p.source || "")) sod.push({ rule: "local-prod-admin", person: p.name, clusters: prodAdmin, text: "a local (htpasswd) user holds cluster-admin on production" });
    if (prodAdmin.length && approvers.has(p.name)) sod.push({ rule: "approver-admin", person: p.name, clusters: prodAdmin, text: "approves access requests and also holds cluster-admin on production" });
    if (okPer.length >= 3 && adminOn.length === okPer.length) sod.push({ rule: "standing-admin", person: p.name, clusters: adminOn, text: "standing cluster-admin on every cluster; prefer temporary elevation" });
  }
  const leavers = rows.filter((p) => p.flags.some((f) => f.leaver)).map((p) => ({ person: p.name, clusters: p.flags.filter((f) => f.leaver).map((f) => f.cluster) }));
  const privilegedSAs = okPer.flatMap((r) => (r.raw.privilegedSAs || []).map((x) => ({ ...x, cluster: r.cluster })));
  return { unofficial, sod, leavers, privilegedSAs, baselineSize: baseline.size };
}

/** Accept unofficial grants as approved (they stop being flagged). */
export async function acceptBaseline(keys, actor) {
  const list2 = (keys || []).filter((k) => typeof k === "string" && k.length < 600).slice(0, 5000);
  const st = await load();
  const set = new Set(st.baseline || []);
  for (const k of list2) set.add(k);
  st.baseline = [...set];
  await save();
  _deps.audit(`User & Access: ${list2.length} existing grant${list2.length === 1 ? "" : "s"} accepted as approved`, { keys: list2.slice(0, 50) }, actor);
  return { baseline: st.baseline.length };
}

/** Password rotation rule for a local user: every N days, or none. */
export async function setRotation(user, everyDays, actor) {
  if (!validUser(user)) throw err("Not a valid user name");
  const st = await load();
  st.rotation ||= {};
  if (!everyDays) delete st.rotation[user];
  else {
    const d = Number(everyDays);
    if (![30, 60, 90, 180, 365].includes(d)) throw err("Rotation can be every 30, 60, 90, 180 or 365 days");
    st.rotation[user] = { ...(st.rotation[user] || {}), everyDays: d };
  }
  await save();
  _deps.audit(`User & Access: password rotation for ${user} ${everyDays ? `every ${everyDays} days` : "turned off"}`, { user, everyDays }, actor);
  return st.rotation[user] || null;
}

/* ─────────────────────────── access reviews ─────────────────────────── */

function reviewSummary(r) {
  return { id: r.id, name: r.name, createdBy: r.createdBy, createdAt: r.createdAt, due: r.due, status: r.status, scope: r.scope, items: r.items.length, decided: r.items.filter((i) => i.decision).length, keep: r.items.filter((i) => i.decision === "keep").length, remove: r.items.filter((i) => i.decision === "remove").length, closedAt: r.closedAt || null, requests: r.requests || [] };
}

/** Start a review: a snapshot of who has what, for people to confirm or remove. */
export async function createReview({ name, due, scope = "privileged" }, sum, actor) {
  const st = await load();
  st.reviews ||= [];
  const dueT = Date.parse(due);
  if (!dueT || dueT <= _deps.now()) throw err("Give a due date in the future");
  const items = [];
  for (const p of sum.people.filter((x) => !x.builtin)) {
    for (const [cluster, grants] of Object.entries(p.clusters)) {
      for (const g of grants) {
        if (scope !== "all" && !["cluster-admin", "admin"].includes(g.role)) continue;
        const key = `${p.name}|${cluster}|${g.role}|${g.scope}|${g.via}`;
        if (items.some((i) => i.key === key)) continue;
        items.push({ key, person: p.name, cluster, role: g.role, scope: g.scope, via: g.via, synced: !!g.synced, decision: null });
      }
    }
  }
  if (!items.length) throw err("Nothing to review in that scope");
  const r = { id: `AR-${String(st.reviews.length + 1).padStart(3, "0")}`, name: String(name || "Access review").slice(0, 120), createdBy: actor, createdAt: new Date(_deps.now()).toISOString(), due: new Date(dueT).toISOString(), scope: scope === "all" ? "all" : "privileged", status: "open", items: items.slice(0, 3000) };
  st.reviews.unshift(r);
  await save();
  _deps.audit(`User & Access: access review ${r.id} started (${r.items.length} grants)`, { id: r.id }, actor);
  _deps.notify?.({ type: "access_review", severity: "info", title: `Access review ${r.id} started`, message: `${r.name}: ${r.items.length} grants to confirm by ${r.due.slice(0, 10)}.` });
  return reviewSummary(r);
}
export async function getReview(id) {
  const r = ((await load()).reviews || []).find((x) => x.id === id);
  if (!r) throw err("No such review", 404);
  return r;
}
export async function decideReview(id, decisions, actor) {
  const r = await getReview(id);
  if (r.status !== "open") throw err("This review is closed", 409);
  const at = new Date(_deps.now()).toISOString();
  for (const d of decisions || []) {
    const it = r.items.find((i) => i.key === d.key);
    if (it && ["keep", "remove", null].includes(d.decision)) Object.assign(it, { decision: d.decision, by: actor, at });
  }
  await save();
  return reviewSummary(r);
}
/** Close: every "remove" (and, if asked, everything not reviewed) becomes a removal request. */
export async function closeReview(id, { removeUnreviewed = false } = {}, actor) {
  const r = await getReview(id);
  if (r.status !== "open") throw err("This review is closed", 409);
  const out = [];
  for (const it of r.items.filter((i) => i.decision === "remove" || (removeUnreviewed && !i.decision))) {
    try {
      const q = await createRequest({ kind: "remove-role", clusters: [it.cluster], user: it.person, role: it.role, scope: it.scope, via: it.via, reason: `Access review ${r.id}${it.decision ? "" : ": not confirmed by the due date"}` }, actor);
      out.push(q.id);
    } catch (e) { out.push(`${it.person}: ${e.message}`); }
  }
  Object.assign(r, { status: "closed", closedAt: new Date(_deps.now()).toISOString(), closedBy: actor, requests: out });
  await save();
  _deps.audit(`User & Access: access review ${r.id} closed; ${out.length} removal request${out.length === 1 ? "" : "s"} raised`, { id, requests: out }, actor);
  return reviewSummary(r);
}

/** Entitlement report: one row per person, cluster and role, with the approval behind it. */
export function entitlementCsv(sum) {
  const esc = (v) => { const x = String(v ?? ""); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const reqs = sum.requests || [];
  const rows = [["person", "login", "cluster", "role", "role name", "scope", "given via", "binding", "managed by platform", "request", "approved by", "approved at", "ends"]];
  for (const p of sum.people) {
    for (const [cluster, grants] of Object.entries(p.clusters)) {
      for (const g of grants) {
        const q = reqs.find((x) => x.kind === "grant" && x.user === p.name && x.role === g.role && (x.namespace || "cluster") === g.scope && x.clusters.includes(cluster) && ["done", "partly done"].includes(x.status));
        rows.push([p.name, p.detail?.[cluster]?.source || p.source || "", cluster, g.role, ROLE_DOC[g.role]?.label || g.role, g.scope, g.via, g.binding?.name || "", g.binding?.managed ? "yes" : "no", q?.id || g.binding?.request || "", q?.decidedBy || "", q?.decidedAt || "", q?.expires || ""]);
      }
    }
  }
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
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
  if (!["grant", "revoke", "remove-kubeadmin", "remove-role", "remove-binding", "disable", "enable", "reset-password"].includes(kind)) throw err("Unknown request");
  const clusters = [...new Set((Array.isArray(b.clusters) ? b.clusters : []).map(String))].filter((c) => /^[A-Za-z0-9._:-]{1,128}$/.test(c));
  if (!clusters.length) throw err("Pick at least one cluster");
  const reason = String(b.reason || "").slice(0, 300);
  if (kind === "remove-kubeadmin") return { kind, clusters, reason };
  if (kind === "remove-binding") {
    if (clusters.length !== 1) throw err("An unofficial grant belongs to one cluster");
    if (!/^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/.test(String(b.binding || "")) || !["User", "Group"].includes(b.subjectKind) || !b.subject || (b.namespace && !validName(b.namespace))) throw err("Not a valid binding");
    return { kind, clusters, binding: String(b.binding), namespace: b.namespace || null, subjectKind: b.subjectKind, subject: String(b.subject).slice(0, 253), role: String(b.role || ""), reason };
  }
  if (!validUser(b.user)) throw err("Give the person’s OpenShift user name (as their company login shows it, or a new local name)");
  if (kind === "revoke" || kind === "disable" || kind === "reset-password") return { kind, clusters, user: b.user, reason };
  if (kind === "enable") {
    if (!/^UA-\d{4,}$/.test(String(b.fromRequest || ""))) throw err("Enable restores what a Disable request removed: give that request");
    return { kind, clusters, user: b.user, fromRequest: b.fromRequest, reason };
  }
  if (kind === "remove-role") {
    const role = String(b.role || "");
    if (!ROLES.includes(role)) throw err("Pick a role");
    const scope = String(b.scope || "");
    if (scope !== "cluster" && !validName(scope)) throw err("Not a valid namespace");
    const via = String(b.via || "");
    if (via !== "direct" && !/^[A-Za-z0-9][A-Za-z0-9._@+ -]{0,252}$/.test(via)) throw err("Not a valid group");
    return { kind, clusters, user: b.user, role, scope, via, reason };
  }
  const mode = b.mode === "htpasswd" ? "htpasswd" : "directory";
  const role = String(b.role || "");
  if (!ROLES.includes(role)) throw err("Pick a role");
  const namespace = CLUSTER_ROLES.has(role) ? null : String(b.namespace || "");
  if (!CLUSTER_ROLES.has(role) && !validName(namespace)) throw err("Give the namespace for this role");
  const group = b.group ? String(b.group) : managedGroupName(role, namespace);
  if (!validName(group)) throw err("Not a valid group name");
  let expires = null;
  if (b.hours) {
    const h = Number(b.hours);
    if (![1, 2, 4, 8, 24, 72].includes(h)) throw err("Temporary access can last 1, 2, 4, 8, 24 or 72 hours");
    expires = new Date(_deps.now() + h * 3600000).toISOString();
  } else if (b.expires) {
    const t = Date.parse(b.expires);
    if (!t || t <= _deps.now()) throw err("The expiry date must be in the future");
    if (t > _deps.now() + 366 * 86400000) throw err("Access can be granted for at most a year at a time");
    expires = new Date(t).toISOString();
  }
  const delivery = ["direct", "acm", "gitops"].includes(b.delivery) ? b.delivery : "direct";
  if (mode === "htpasswd" && delivery !== "direct") throw err("Local (htpasswd) users can only be applied directly: their password must never go into Git or a policy");
  return { kind, clusters, user: b.user, mode, role, namespace, group, expires, hours: b.hours ? Number(b.hours) : null, delivery, reason };
}

export function describe(q) {
  if (q.kind === "remove-kubeadmin") return `Remove kubeadmin from ${q.clusters.length} cluster${q.clusters.length > 1 ? "s" : ""}`;
  const on = `${q.clusters.length} cluster${q.clusters.length > 1 ? "s" : ""}`;
  if (q.kind === "revoke") return `Delete ${q.user} from ${on} (access, login and sessions)`;
  if (q.kind === "disable") return `Disable ${q.user} on ${on} (access suspended, sessions ended)`;
  if (q.kind === "enable") return `Enable ${q.user} on ${on} (restore what ${q.fromRequest} removed)`;
  if (q.kind === "reset-password") return `Reset the local password of ${q.user} on ${on}`;
  if (q.kind === "remove-role") return `Remove ${ROLE_LABEL[q.role]} (${q.role})${q.scope !== "cluster" ? ` on ${q.scope}` : " cluster-wide"} from ${q.user}${q.via !== "direct" ? ` (via group ${q.via})` : ""} on ${on}`;
  if (q.kind === "remove-binding") return `Remove ${q.subjectKind.toLowerCase()} ${q.subject} from ${q.role} binding ${q.binding}${q.namespace ? ` in ${q.namespace}` : ""} on ${q.clusters[0]}`;
  if (q.hours) return `${q.user}: temporary ${ROLE_LABEL[q.role]}${q.namespace ? ` on ${q.namespace}` : ""} for ${q.hours} h on ${on}`;
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
  _deps.notify?.({ type: "access_request", severity: ["disable", "revoke"].includes(q.kind) || q.role === "cluster-admin" ? "warning" : "info", title: `Access request ${q.id} waiting for approval`, message: `${q.title}. Requested by ${actor}${q.reason ? `: ${q.reason}` : ""}.` });
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
    if ((q.kind === "grant" && q.mode === "htpasswd") || q.kind === "reset-password") { password = generatePassword(); hash = bcrypt.hashSync(password, 10); }
    const from = q.kind === "enable" ? st.requests.find((x) => x.id === q.fromRequest && x.kind === "disable" && x.user === q.user) : null;
    if (q.kind === "enable" && !from) { q.status = "pending"; await save(); throw err(`${q.fromRequest} is not a Disable request for ${q.user}`); }
    q.results = [];
    for (const c of q.clusters) {
      try {
        const op = { grant: "grant", revoke: "revoke", "remove-kubeadmin": "kubeadmin", "remove-role": "unbind", "remove-binding": "unbindsubject", disable: "disable", enable: "enable", "reset-password": "setpass" }[q.kind];
        const payload = op === "grant" ? { q: { id: q.id, user: q.user, mode: q.mode, role: q.role, namespace: q.namespace, group: q.group }, hash }
          : op === "unbind" ? { user: q.user, role: q.role, scope: q.scope, via: q.via }
            : op === "unbindsubject" ? { binding: q.binding, namespace: q.namespace, subjectKind: q.subjectKind, subject: q.subject }
              : op === "enable" ? { user: q.user, snapshot: from.results?.find((r) => r.cluster === c)?.snapshot || null }
                : op === "setpass" ? { user: q.user, hash }
                  : op === "kubeadmin" ? {} : { user: q.user };
        const res = await exec(c, op, payload, ctx);
        q.results.push(typeof res === "object" && res ? { cluster: c, ok: true, text: res.text, ...(res.snapshot ? { snapshot: res.snapshot } : {}) } : { cluster: c, ok: true, text: res });
      } catch (e) {
        q.results.push({ cluster: c, ok: false, text: /read-only/i.test(e.message) ? "This cluster is reached through the read-only bridge; changes need its agent credentials or direct access" : e.message.slice(0, 300) });
      }
    }
  }
  const good = q.results.filter((r) => r.ok).length;
  q.status = good === q.results.length ? "done" : good ? "partly done" : "failed";
  if (q.kind === "grant" && q.expires && q.delivery === "direct") q.expiryPending = good > 0;
  if (good && (q.kind === "reset-password" || (q.kind === "grant" && q.mode === "htpasswd"))) {
    st.rotation ||= {};
    if (st.rotation[q.user] || q.kind === "reset-password") st.rotation[q.user] = { ...(st.rotation[q.user] || {}), lastSetAt: q.decidedAt };
  }
  st.disabled ||= {};
  if (good && q.kind === "disable") st.disabled[q.user] = { at: q.decidedAt, request: q.id };
  if (good && (q.kind === "enable" || q.kind === "revoke")) delete st.disabled[q.user];
  await save();
  _deps.notify?.({ type: "access_change", severity: q.status === "done" ? "info" : "warning", title: `Access ${q.id} ${q.status}`, message: `${q.title}. Approved by ${via || actor}.${q.results.filter((r) => !r.ok).map((r) => ` ${r.cluster}: ${r.text}`).join("")}` });
  _deps.audit(`User & Access: ${q.id} approved${via ? ` in ${via}` : ""} — ${q.title}: ${q.status}`, { id, results: q.results }, via || actor);
  return { ...q, password, manifests };
}

/** Run one read-only operation on a cluster (for the "Can they…?" check). */
export async function runOn(cluster, op, payload, ctx) {
  if (op !== "can-i") throw err("Not allowed");
  return exec(cluster, op, payload, ctx);
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
      if ((q.kind === "grant" && q.mode === "htpasswd") || q.kind === "reset-password") { if (!q.snApproved) { q.snApproved = true; await save(); } continue; }
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
  const ended = await revokeSessions(user);
  if (ended) done.push(`${ended} active session${ended > 1 ? "s" : ""} ended`);
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

/** End a person's active sessions: delete their OAuth access tokens. Returns how many. */
export async function revokeSessions(user) {
  const toks = await list("/apis/oauth.openshift.io/v1/oauthaccesstokens");
  let n = 0;
  for (const t of (toks || []).filter((x) => x.userName === user)) {
    try { await _deps.ocp.delete(`/apis/oauth.openshift.io/v1/oauthaccesstokens/${encodeURIComponent(t.metadata.name)}`); n++; } catch { /* gone */ }
  }
  return n;
}

const bindingPath = (b, ns) => (ns ? `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/${b}` : `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${b}`);

/** Take one subject out of one binding; the binding goes when it was the last. */
export async function applyUnbindSubject({ binding, namespace, subjectKind, subject }) {
  const path = bindingPath(binding, namespace);
  const b = await get(path);
  if (!b) return `binding ${binding} is already gone`;
  const subs = b.subjects || [];
  const rest = subs.filter((x) => !(x.kind === subjectKind && x.name === subject));
  if (rest.length === subs.length) return `${subject} is no longer in ${binding}`;
  if (rest.length) await _deps.ocp.patch(path, { subjects: rest }, MERGE); else await _deps.ocp.delete(path);
  return `${subjectKind.toLowerCase()} ${subject} removed from ${binding}${rest.length ? "" : " (binding deleted)"}`;
}

/** Remove one role from one person: the direct bindings, or their place in the group that gives it. */
export async function applyUnbind({ user, role, scope, via }) {
  if (via === "direct") {
    const ns = scope === "cluster" ? null : scope;
    const all = await list(ns ? `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings` : "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings");
    const hits = (all || []).filter((b) => b.roleRef?.name === role && (b.subjects || []).some((x) => x.kind === "User" && x.name === user));
    if (!hits.length) return `${user} has no direct ${role} binding${ns ? ` in ${ns}` : ""} here`;
    const out = [];
    for (const b of hits) out.push(await applyUnbindSubject({ binding: b.metadata.name, namespace: ns, subjectKind: "User", subject: user }));
    return out.join("; ");
  }
  const g = await get(`/apis/user.openshift.io/v1/groups/${via}`);
  if (!g || !(g.users || []).includes(user)) return `${user} is no longer in ${via}`;
  if (g.metadata?.labels?.["openshift.io/ldap.host"]) throw err(`${via} is synced from AD/LDAP: remove ${user} from it in the directory`, 409);
  await _deps.ocp.patch(`/apis/user.openshift.io/v1/groups/${via}`, { users: g.users.filter((u) => u !== user) }, MERGE);
  return `${user} removed from ${via}, which gives ${role}${scope !== "cluster" ? ` on ${scope}` : ""}${g.users.length > 1 ? " (other members keep it)" : ""}`;
}

async function htpasswdEdit(user, fn) {
  const idps = describeIdps(await get("/apis/config.openshift.io/v1/oauths/cluster")).filter((x) => x.htpasswdSecret);
  let touched = 0;
  for (const p of idps) {
    const s = await get(`/api/v1/namespaces/openshift-config/secrets/${p.htpasswdSecret}`);
    const rows = parseHtpasswd(s?.data?.htpasswd ? Buffer.from(s.data.htpasswd, "base64").toString("utf8") : "");
    const i = rows.findIndex((r) => r.user === user);
    if (i < 0) continue;
    const next = fn(rows[i].hash);
    touched++;
    if (next === rows[i].hash) continue;
    rows[i] = { user, hash: next };
    await _deps.ocp.patch(`/api/v1/namespaces/openshift-config/secrets/${p.htpasswdSecret}`, { data: { htpasswd: Buffer.from(rows.map((r) => `${r.user}:${r.hash}`).join("\n") + "\n").toString("base64") } }, MERGE);
  }
  return touched;
}

/**
 * Disable (suspend): remember the person's groups and direct bindings, take
 * them away, lock a local login and end sessions. Enable puts it all back.
 */
export async function applyDisable(user) {
  const raw = await readCluster();
  const acc = accessOf(raw);
  const others = Object.entries(acc.people).filter(([n, p]) => n !== user && p.grants.some((g) => g.role === "cluster-admin"));
  if (acc.people[user]?.grants.some((g) => g.role === "cluster-admin") && !others.length && !raw.kubeadmin) throw err(`${user} is the only cluster-admin who can log in here; add another admin first`, 409);
  const snapshot = { groups: [], bindings: [], synced: [] };
  for (const g of raw.groups.filter((x) => (x.users || []).includes(user))) {
    if (g.metadata?.labels?.["openshift.io/ldap.host"]) { snapshot.synced.push(g.metadata.name); continue; }
    await _deps.ocp.patch(`/apis/user.openshift.io/v1/groups/${g.metadata.name}`, { users: g.users.filter((u) => u !== user) }, MERGE);
    snapshot.groups.push(g.metadata.name);
  }
  for (const b of [...raw.crbs.map((x) => ({ ...x, cl: true })), ...raw.rbs]) {
    if (!(b.subjects || []).some((x) => x.kind === "User" && x.name === user)) continue;
    snapshot.bindings.push({ name: b.metadata.name, namespace: b.cl ? null : b.metadata.namespace, role: b.roleRef.name, roleKind: b.roleRef.kind || "ClusterRole" });
    await applyUnbindSubject({ binding: b.metadata.name, namespace: b.cl ? null : b.metadata.namespace, subjectKind: "User", subject: user });
  }
  const locked = await htpasswdEdit(user, (h) => (h.startsWith("!") ? h : `!${h}`));
  const ended = await revokeSessions(user);
  const parts = [`${snapshot.groups.length} group${snapshot.groups.length === 1 ? "" : "s"} and ${snapshot.bindings.length} direct binding${snapshot.bindings.length === 1 ? "" : "s"} suspended`];
  if (locked) parts.push("local login locked");
  if (ended) parts.push(`${ended} session${ended > 1 ? "s" : ""} ended`);
  if (snapshot.synced.length) parts.push(`still in AD-synced ${snapshot.synced.join(", ")}: disable the account in AD too`);
  return { text: parts.join("; "), snapshot };
}

export async function applyEnable(user, snapshot) {
  if (!snapshot) throw err("Nothing was recorded for this cluster when it was disabled", 409);
  const done = [];
  for (const name of snapshot.groups || []) {
    const g = await get(`/apis/user.openshift.io/v1/groups/${name}`);
    if (!g) { await _deps.ocp.post("/apis/user.openshift.io/v1/groups", { apiVersion: "user.openshift.io/v1", kind: "Group", metadata: { name, labels }, users: [user] }); done.push(`${name} recreated`); continue; }
    if (!(g.users || []).includes(user)) { await _deps.ocp.patch(`/apis/user.openshift.io/v1/groups/${name}`, { users: [...(g.users || []), user] }, MERGE); done.push(`back in ${name}`); }
  }
  for (const b of snapshot.bindings || []) {
    const path = bindingPath(b.name, b.namespace);
    const cur = await get(path);
    const subject = { apiGroup: "rbac.authorization.k8s.io", kind: "User", name: user };
    if (cur) {
      if (!(cur.subjects || []).some((x) => x.kind === "User" && x.name === user)) await _deps.ocp.patch(path, { subjects: [...(cur.subjects || []), subject] }, MERGE);
    } else {
      const body = { apiVersion: "rbac.authorization.k8s.io/v1", kind: b.namespace ? "RoleBinding" : "ClusterRoleBinding", metadata: { name: b.name, ...(b.namespace ? { namespace: b.namespace } : {}), labels }, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: b.roleKind || "ClusterRole", name: b.role }, subjects: [subject] };
      await _deps.ocp.post(b.namespace ? `/apis/rbac.authorization.k8s.io/v1/namespaces/${b.namespace}/rolebindings` : "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings", body);
    }
    done.push(`${b.role} binding ${b.name} restored`);
  }
  const unlocked = await htpasswdEdit(user, (h) => (h.startsWith("!") ? h.slice(1) : h));
  if (unlocked) done.push("local login unlocked");
  return done.length ? done.join("; ") : "nothing to restore";
}

/** New password for a local user: the htpasswd entry on this cluster, then end old sessions. */
export async function applySetPassword(user, hash) {
  if (!hash) throw err("No password given");
  let wasLocked = false;
  const n = await htpasswdEdit(user, (h) => { if (h.startsWith("!")) { wasLocked = true; return h; } return hash; });
  if (!n) throw err(`${user} has no local (htpasswd) login on this cluster`, 404);
  if (wasLocked) throw err(`${user} is disabled here; enable them before resetting the password`, 409);
  const ended = await revokeSessions(user);
  return `password replaced in the htpasswd Secret${ended ? `; ${ended} old session${ended > 1 ? "s" : ""} ended` : ""}`;
}

/** Can this person do this? A SubjectAccessReview with their groups. */
export async function canI({ user, verb, resource, namespace, group = "" }) {
  const groups = ((await list("/apis/user.openshift.io/v1/groups")) || []).filter((g) => (g.users || []).includes(user)).map((g) => g.metadata.name);
  const r = await _deps.ocp.post("/apis/authorization.k8s.io/v1/subjectaccessreviews", {
    apiVersion: "authorization.k8s.io/v1", kind: "SubjectAccessReview",
    spec: { user, groups: [...groups, "system:authenticated", "system:authenticated:oauth"], resourceAttributes: { verb, resource, group, ...(namespace ? { namespace } : {}) } },
  });
  return { allowed: !!r?.status?.allowed, reason: r?.status?.reason || null, groups };
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
    _deps.notify?.({ type: "access_change", severity: "info", title: `Access ${q.id} expired`, message: `${q.user}: ${q.role}${q.namespace ? ` on ${q.namespace}` : ""} removed on ${results.length} cluster${results.length === 1 ? "" : "s"}.` });
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
