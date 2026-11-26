/**
 * Access insights — least privilege from what people actually do.
 *
 * User & Access knows who HAS which role on which cluster. This module adds
 * what they USE (the OpenShift API audit log, read from Loki, Elasticsearch
 * or Splunk) and what the platform has seen of their logins, and turns the
 * difference into:
 *
 *   - suggestions: disable, remove a role, downgrade, narrow the scope, make
 *     admin temporary, reduce a service account, peer outliers, HR movers
 *     and joiners. Each one carries its evidence and the request(s) that
 *     would carry it out; nothing is changed without an approved request;
 *   - a risk score (0–100) per person and privileged service account;
 *   - guardrails evaluated on every access request (block, extra approver,
 *     flag, auto-approve), with alternatives for a blocked request;
 *   - session alerts: kubeadmin and break-glass use, secrets read in bulk,
 *     exec into production pods, role bindings made by hand, failed logins,
 *     a login at an unusual hour or on a new cluster;
 *   - HR feed: leavers disabled, movers and joiners suggested;
 *   - compliance mapping and an evidence report.
 *
 * Pure functions (analyze, scorePerson, evaluateRequest, alertsFrom…) do the
 * work and are tested; the stateful wrappers read the audit source and keep
 * observations, dismissals, alert state and policy settings.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

const DAY = 86400000;
const INACTIVE_DAYS = () => Number(process.env.ACCESS_INACTIVE_DAYS || process.env.USER_ACCESS_INACTIVE_DAYS) || 90;
const TEMP_DAYS = () => Number(process.env.ACCESS_TEMPORARY_DAYS) || 5;
const PROD = () => new RegExp(process.env.USER_ACCESS_PROD_PATTERN || "prod", "i");
const STATE_KEY = "access_insights_state";
const READ = new Set(["get", "list", "watch"]);
const WRITE = new Set(["create", "update", "patch"]);
const DEL = new Set(["delete", "deletecollection"]);
const PRIV = new Set(["cluster-admin", "admin"]);
const RBAC_RES = new Set(["roles", "rolebindings"]);
const isSA = (u) => /^system:serviceaccount:/.test(u || "");
const KUBEADMIN = "kube:admin";
const hid = (...p) => createHash("sha1").update(p.join("|")).digest("hex").slice(0, 12);
const iso = (t) => new Date(t).toISOString();

let _deps = {
  audit: null,          // { name, usage({ days, alertHours }) → usage } (an adapter below), or null
  store: null,          // { get(key), set(key, value) }
  now: () => Date.now(),
  notify: null,         // ({ type, title, message, severity })
  auditLog: () => {},   // (title, details, actor)
  hrFeed: null,         // async () → [{ user, status, team, previousTeam, date }]
  selfApproveDefault: false,
};
export function configureAccessInsights(deps) { _deps = { ..._deps, ...deps }; }

/* ─────────────────────────── compliance ─────────────────────────── */

export const CONTROLS = {
  "least-privilege": ["ISO 27001:2022 A.5.15, A.5.18", "SOC 2 CC6.1, CC6.3", "PCI DSS 4.0 7.2.1, 7.2.2", "NIST 800-53 AC-6", "HIPAA 164.308(a)(4)"],
  inactive: ["PCI DSS 4.0 8.2.6 (inactive accounts within 90 days)", "NIST 800-53 AC-2(3)", "ISO 27001:2022 A.5.18", "SOC 2 CC6.2"],
  privileged: ["ISO 27001:2022 A.8.2", "PCI DSS 4.0 7.2.2, 8.6", "NIST 800-53 AC-6(5), AC-6(7)", "SOC 2 CC6.3"],
  review: ["ISO 27001:2022 A.5.18", "PCI DSS 4.0 7.2.4, 7.2.5.1", "SOC 2 CC6.2", "NIST 800-53 AC-2(j)"],
  sod: ["ISO 27001:2022 A.5.3", "NIST 800-53 AC-5", "SOC 2 CC5.1"],
  monitoring: ["ISO 27001:2022 A.8.15, A.8.16", "PCI DSS 4.0 10.2.1.2", "NIST 800-53 AU-6", "SOC 2 CC7.2", "HIPAA 164.312(b)"],
  jml: ["ISO 27001:2022 A.5.16, A.5.18", "PCI DSS 4.0 8.2.5", "NIST 800-53 AC-2(1)", "SOC 2 CC6.2"],
  emergency: ["NIST 800-53 AC-2(2)", "PCI DSS 4.0 8.2.2", "ISO 27001:2022 A.8.2"],
  "service-accounts": ["PCI DSS 4.0 7.2.5, 8.6.1", "NIST 800-53 AC-6", "ISO 27001:2022 A.8.2"],
};
const CONTROL_OF = { disable: ["inactive"], remove: ["least-privilege", "review"], downgrade: ["least-privilege"], narrow: ["least-privilege"], temporary: ["privileged"], reduce: ["service-accounts"], peer: ["least-privilege", "review"], mover: ["jml"], joiner: ["jml"] };

/* ─────────────────────────── policies (guardrails) ─────────────────────────── */

export const POLICY_DEFS = [
  { id: "no-standing-ca-prod", label: "No standing cluster-admin on production", text: "Only temporary, 4 h maximum.", effect: "block", controls: ["privileged"] },
  { id: "two-approvers-high", label: "Two approvers for High risk", text: "A request scoring 67 or more needs two Admins (or the ServiceNow change).", effect: "approval", controls: ["sod", "privileged"] },
  { id: "peer-check", label: "Peer check", text: "Flag access that hardly anyone else in the team holds.", effect: "flag", controls: ["least-privilege"] },
  { id: "auto-approve-low", label: "Low risk approves itself", text: "view or edit on non-production, temporary, 8 h or less.", effect: "auto", controls: ["least-privilege"] },
  { id: "no-local-prod", label: "No local users on production", text: "htpasswd logins only for labs and break-glass.", effect: "block", controls: ["privileged"] },
  { id: "no-self-approval", label: "No self-approval", text: "Requester and approver must differ.", effect: "block", controls: ["sod"] },
  { id: "ticket-privileged", label: "Ticket for privileged roles", text: "admin and cluster-admin need a ServiceNow number.", effect: "require", controls: ["privileged"] },
  { id: "hr-leavers", label: "Leavers from HR", text: "Disable on every cluster the day HR marks a leaver.", effect: "auto", controls: ["jml"] },
];
export function policyDefaults() {
  return Object.fromEntries(POLICY_DEFS.map((p) => [p.id, { enabled: p.id === "no-self-approval" ? !_deps.selfApproveDefault : true }]));
}

/** Risk of a request itself (0–100), from what it gives and where. Pure. */
export function requestRisk(q, { prod = PROD(), personScore = 0, peerOutlier = false } = {}) {
  const reasons = [];
  let s = 0;
  const add = (p, t) => { if (p) { s += p; reasons.push({ points: p, text: t }); } };
  if (q.kind !== "grant") {
    const base = { "reset-password": 20, "remove-kubeadmin": 25, enable: 15 }[q.kind] ?? 10;
    add(base, q.kind === "enable" ? "Restores access" : q.kind === "reset-password" ? "New credentials" : "Takes access away");
  } else {
    add({ "cluster-admin": 55, admin: 25, edit: 15, "cluster-reader": 12, view: 5 }[q.role] || 10, `Role ${q.role}`);
    if (q.clusters.some((c) => prod.test(c))) add(15, "Production cluster");
    if (PRIV.has(q.role) && !q.expires) add(10, "Permanent");
    if (q.clusters.length >= 3) add(5, `${q.clusters.length} clusters`);
    if (q.mode === "htpasswd") add(10, "Local (htpasswd) login");
    if (peerOutlier) add(10, "Unusual for the team");
    if (personScore >= 67) add(10, `Person already high risk (${personScore})`);
  }
  s = Math.max(0, Math.min(100, s));
  return { score: s, level: s >= 67 ? "High" : s >= 34 ? "Medium" : "Low", reasons };
}

/**
 * Guardrails for one request. ctx: { policies, people (name → summary row),
 * teams, writes (user → [{ cluster, ns, writes }]), scores (name → score) }.
 * Pure.
 */
export function evaluateRequest(q, ctx = {}) {
  const pol = { ...policyDefaults(), ...(ctx.policies || {}) };
  const on = (id) => pol[id]?.enabled !== false;
  const prod = ctx.prod || PROD();
  const findings = [], alternatives = [];
  const prodCl = q.clusters.filter((c) => prod.test(c));
  // Peers: members of the person's smallest team (4+ others) who hold the same role and scope.
  let peer = null;
  if (q.kind === "grant" && ctx.people && ctx.teams) {
    const scope = q.namespace || "cluster";
    const p = ctx.people[q.user];
    for (const g of (p?.groups || []).filter((g) => ctx.teams[g] && !ctx.teams[g].managed && !/^tcs-/.test(g))) {
      const others = ctx.teams[g].members.filter((m) => m !== q.user);
      if (others.length < 4) continue;
      const have = others.filter((m) => q.clusters.some((c) => (ctx.people[m]?.clusters?.[c] || []).some((x) => x.role === q.role && x.scope === scope))).length;
      if (!peer || others.length < peer.of) peer = { team: g, have, of: others.length };
    }
  }
  const outlier = !!(peer && peer.have / peer.of <= 0.2);
  const risk = requestRisk(q, { prod, personScore: ctx.scores?.[q.user] || 0, peerOutlier: outlier });
  if (q.kind === "grant") {
    const hours = q.hours || (q.expires ? (Date.parse(q.expires) - (ctx.now || Date.now())) / 3600000 : null);
    if (on("no-standing-ca-prod") && q.role === "cluster-admin" && prodCl.length && !(hours && hours <= 4.01)) {
      findings.push({ policy: "no-standing-ca-prod", level: "block", text: `No standing cluster-admin on production (${prodCl.join(", ")}): at most 4 hours.` });
      alternatives.push({ label: "cluster-admin for 4 hours", bodies: [{ ...pick(q), hours: 4, expires: undefined }] });
    }
    if (on("no-local-prod") && q.mode === "htpasswd" && prodCl.length) {
      findings.push({ policy: "no-local-prod", level: "block", text: "No local (htpasswd) users on production: use the company login." });
      alternatives.push({ label: "Same access with the company login", bodies: [{ ...pick(q), mode: "directory" }] });
    }
    if (on("ticket-privileged") && PRIV.has(q.role) && !q.changeRef) findings.push({ policy: "ticket-privileged", level: "block", text: `${q.role} needs a ServiceNow change or incident number.`, needsRef: true });
    if (on("peer-check") && outlier) findings.push({ policy: "peer-check", level: "flag", text: `Unusual: ${peer.have} of ${peer.of} others in ${peer.team} hold ${q.role}${q.namespace ? ` on ${q.namespace}` : ""}.` });
    // A smaller alternative, from what the person actually changed recently.
    if (findings.some((f) => f.level === "block") && PRIV.has(q.role)) {
      const w = (ctx.writes?.[q.user] || []).filter((x) => q.clusters.includes(x.cluster) && x.ns).sort((a, b) => b.writes - a.writes);
      const nss = [...new Set(w.map((x) => x.ns))].slice(0, 3);
      if (nss.length) alternatives.push({ label: `edit in ${nss.join(", ")} for 8 hours (what they changed recently)`, bodies: nss.map((ns) => ({ ...pick(q), role: "edit", namespace: ns, hours: 8, expires: undefined, changeRef: q.changeRef || undefined })) });
    }
  }
  const approvalsNeeded = on("two-approvers-high") && risk.score >= 67 ? 2 : 1;
  if (approvalsNeeded > 1) findings.push({ policy: "two-approvers-high", level: "approval", text: `High risk (${risk.score}): two approvers.` });
  const blocked = findings.some((f) => f.level === "block");
  const auto = !blocked && on("auto-approve-low") && q.kind === "grant" && ["view", "edit"].includes(q.role) && !prodCl.length && q.hours && q.hours <= 8
    && q.mode !== "htpasswd" && (q.delivery || "direct") === "direct" && risk.score < 34 && !findings.some((f) => f.level === "flag");
  if (auto) findings.push({ policy: "auto-approve-low", level: "auto", text: "Low risk, temporary, non-production: approved by policy." });
  return { risk, findings, alternatives, approvalsNeeded, decision: blocked ? "block" : auto ? "auto" : "pending", peer };
}
const pick = (q) => ({ kind: "grant", user: q.user, clusters: q.clusters, role: q.role, namespace: q.namespace || undefined, mode: q.mode, group: undefined, delivery: q.delivery, reason: q.reason, changeRef: q.changeRef || undefined });

/* ─────────────────────────── usage from the audit log ─────────────────────────── */

/**
 * Index usage rows per cluster and user. Pure.
 * → { [cluster]: { [user]: { reads, writes, byNs: { ns: { r, w, rbac } }, clusterWrites, osWrites, days:Set, privDays:Set, last } } }
 */
export function indexUsage(usage) {
  if (!usage) return null;
  const U = {};
  const u = (c, n) => ((U[c] ||= {})[n] ||= { reads: 0, writes: 0, byNs: {}, clusterWrites: 0, osWrites: 0, days: new Set(), privDays: new Set(), last: null });
  for (const r of usage.rows || []) {
    const x = u(r.cluster, r.user), n = Number(r.count) || 0;
    const ns = r.ns || "";
    const isW = WRITE.has(r.verb) || DEL.has(r.verb) || (r.verb === "create" && r.sub);
    const bucket = ns ? (x.byNs[ns] ||= { r: 0, w: 0, rbac: 0 }) : null;
    if (READ.has(r.verb)) { x.reads += n; if (bucket) bucket.r += n; }
    else if (isW) {
      x.writes += n;
      if (bucket) { bucket.w += n; if (RBAC_RES.has(r.resource)) bucket.rbac += n; }
      if (!ns) x.clusterWrites += n;
      else if (/^(openshift|kube)-|^kube-system$/.test(ns)) x.osWrites += n;
    }
  }
  for (const a of usage.activity || []) { const x = u(a.cluster, a.user); x.days.add(a.day); if (!x.last || a.day > x.last) x.last = a.day; }
  for (const a of usage.privDays || []) u(a.cluster, a.user).privDays.add(a.day);
  return U;
}

const EMPTY = { reads: 0, writes: 0, byNs: {}, clusterWrites: 0, osWrites: 0, days: new Set(), privDays: new Set(), last: null };

/* ─────────────────────────── risk per identity ─────────────────────────── */

const ROLE_PTS = { "cluster-admin": 35, admin: 15, edit: 8, "cluster-reader": 6, view: 2 };
const PROD_PTS = { "cluster-admin": 10, admin: 5, edit: 5, "cluster-reader": 2, view: 0 };

/** 0–100 for one person (a summary row). Pure. */
export function scorePerson(p, ctx = {}) {
  const prod = ctx.prod || PROD();
  const reasons = [];
  let s = 0;
  const add = (pts, text) => { if (pts) { s += pts; reasons.push({ points: pts, text }); } };
  if (p.disabled) return { score: 0, level: "Low", reasons: [{ points: 0, text: "Disabled" }] };
  const grants = Object.entries(p.clusters || {}).flatMap(([c, gs]) => (gs || []).map((g) => ({ ...g, cluster: c })));
  if (grants.length) {
    const top = grants.map((g) => ({ g, pts: (ROLE_PTS[g.role] || 0) + (prod.test(g.cluster) ? PROD_PTS[g.role] || 0 : 0) })).sort((a, b) => b.pts - a.pts)[0];
    add(top.pts, `${top.g.role}${top.g.scope !== "cluster" ? ` in ${top.g.scope}` : ""} on ${top.g.cluster}`);
    const priv = grants.filter((g) => PRIV.has(g.role));
    const privCl = new Set(priv.map((g) => g.cluster));
    if (privCl.size >= 3) add(6, `admin rights on ${privCl.size} clusters`);
    if (priv.some((g) => g.via === "direct")) add(8, "given directly, not through a group");
    if (priv.some((g) => g.binding && !g.binding.managed && g.via !== "built-in")) add(6, "given by hand, not through a request");
    const temp = ctx.temporary || new Set();
    if (priv.some((g) => !temp.has(`${p.name}|${g.cluster}|${g.role}|${g.scope}`))) add(6, "standing (permanent) admin rights");
    if (/htpasswd/.test(p.source || "")) add(priv.some((g) => prod.test(g.cluster)) ? 14 : 6, priv.some((g) => prod.test(g.cluster)) ? "local login with admin on production" : "local (htpasswd) login");
    if (ctx.idleDays >= 60) add(8, `no activity for ${ctx.idleDays} days`);
    if (ctx.unusedPriv) add(6, "admin rights not used");
  }
  if (p.rotation?.overdue) add(4, "password rotation overdue");
  if (ctx.alert === "crit") add(15, "security alert open");
  else if (ctx.alert === "warn") add(6, "session alert open");
  if (p.builtin) add(15, "built-in account with no named owner");
  s = Math.max(0, Math.min(100, Math.round(s)));
  return { score: s, level: s >= 67 ? "High" : s >= 34 ? "Medium" : "Low", reasons };
}

function scoreSA(x, used, prod) {
  const reasons = [];
  let s = 0;
  const add = (pts, t) => { s += pts; reasons.push({ points: pts, text: t }); };
  add(x.role === "cluster-admin" && x.scope === "cluster" ? 45 : x.role === "cluster-admin" ? 25 : 20, `${x.role}${x.scope === "cluster" ? " cluster-wide" : ` in ${x.scope}`}`);
  if (prod.test(x.cluster)) add(10, "production");
  if (used === false) add(10, "token not used");
  s = Math.min(100, s);
  return { score: s, level: s >= 67 ? "High" : s >= 34 ? "Medium" : "Low", reasons };
}

/* ─────────────────────────── the analysis ─────────────────────────── */

const grantList = (p) => Object.entries(p.clusters || {}).flatMap(([c, gs]) => (gs || []).map((g) => ({ ...g, cluster: c })));

/**
 * Everything the Access insights tab shows. Pure.
 * input: { sum, usage, obs, dismissed, alertState, storedAlerts, hr, now }
 */
export function analyze({ sum, usage = null, obs = {}, dismissed = {}, alertState = {}, storedAlerts = [], hr = null, now = Date.now(), packages = null }) {
  const prod = PROD();
  const U = indexUsage(usage);
  const days = usage?.days || 0;
  const people = sum.people.filter((p) => !p.builtin);
  const byName = Object.fromEntries(sum.people.map((p) => [p.name, p]));
  const temporary = new Set();
  for (const q of sum.requests || []) if (q.kind === "grant" && q.expires && Date.parse(q.expires) > now && ["done", "partly done"].includes(q.status)) for (const c of q.clusters) temporary.add(`${q.user}|${c}|${q.role}|${q.namespace || "cluster"}`);
  const watchDays = obs.since ? Math.floor((now - Date.parse(obs.since)) / DAY) : 0;
  const loginKnown = Object.fromEntries((sum.clusters || []).map((c) => [c.cluster, c.ok ? c.lastLoginKnown !== false : false]));
  const suggestions = [];
  const push = (s) => {
    const id = hid(s.kind, s.user, s.clusters.join(","), s.title);
    const d = dismissed[id];
    if (d && Date.parse(d.until) > now) return;
    suggestions.push({ id, controls: CONTROL_OF[s.kind] || [], confidence: "high", manual: null, ...s });
  };

  // Alerts first: they feed the scores.
  const alerts = alertsFrom({ sum, usage, now, stored: storedAlerts, state: alertState });
  const alertOf = {};
  for (const a of alerts.filter((x) => x.status !== "closed" && x.status !== "confirmed")) alertOf[a.user] = alertOf[a.user] === "crit" || a.level === "crit" ? "crit" : "warn";

  const idleOf = (p) => {
    const seen = [p.lastLogin, ...Object.values(p.detail || {}).map((d) => d.lastLogin), ...Object.values(obs.lastSeen?.[p.name] || {})].filter(Boolean).map((t) => Date.parse(t));
    if (U) for (const c of Object.keys(U)) { const l = U[c][p.name]?.last; if (l) seen.push(Date.parse(`${l}T23:59:59Z`)); }
    const created = Object.values(p.detail || {}).map((d) => Date.parse(d.createdAt || "")).filter(Boolean);
    const age = created.length ? Math.floor((now - Math.min(...created)) / DAY) : null;
    if (seen.length) return { days: Math.floor((now - Math.max(...seen)) / DAY), last: iso(Math.max(...seen)), proven: true };
    // Watching only proves anything where logins can be read.
    const readable = Object.keys(p.detail || {}).every((c) => loginKnown[c] !== false);
    const proven = Math.max(readable ? watchDays : 0, U ? days : 0);
    return { days: age != null ? Math.min(proven, age) : proven, last: null, proven: false, watching: watchDays };
  };

  const scoreCtx = (p, extra = {}) => {
    const idle = idleOf(p).days;
    let unusedPriv = false;
    if (U) for (const g of grantList(p).filter((x) => PRIV.has(x.role))) { const u = U[g.cluster]?.[p.name] || EMPTY; if (!u.writes) unusedPriv = true; }
    return { prod, temporary, idleDays: idle, unusedPriv, alert: alertOf[p.name], ...extra };
  };

  for (const p of people) {
    if (p.disabled) continue;
    const grants = grantList(p).filter((g) => g.via !== "built-in");
    if (!grants.length) continue;
    const idle = idleOf(p);
    const before = scorePerson(p, scoreCtx(p)).score;
    const deltaFor = (mut) => {
      const q = { ...p, clusters: Object.fromEntries(Object.entries(p.clusters).map(([c, gs]) => [c, gs.slice()])) };
      mut(q);
      return before - scorePerson(q, scoreCtx(q)).score;
    };

    // ── inactive: disable ──
    if (idle.days >= INACTIVE_DAYS()) {
      const where = Object.keys(p.clusters).filter((c) => (p.clusters[c] || []).length || p.detail?.[c]?.exists);
      const synced = grants.filter((g) => g.synced).map((g) => g.via);
      push({
        kind: "disable", user: p.name, clusters: where, title: "Disable",
        why: idle.proven ? `No activity on any cluster for ${idle.days} days` : `No login seen in ${idle.days} days of watching`,
        evidence: [idle.last ? `last seen ${idle.last.slice(0, 10)}` : "never seen logging in", `${Object.values(p.detail || {}).reduce((a, d) => a + (d.sessions || 0), 0)} sessions`, ...(synced.length ? [`still in AD group ${[...new Set(synced)].join(", ")}`] : [])],
        delta: before, requests: [{ kind: "disable", user: p.name, clusters: where, reason: `Inactive ${idle.days} days (Access insights)` }],
        manual: synced.length ? "Also disable the account in AD" : null,
      });
      continue;
    }

    const seenGrant = new Set();
    // ── from the audit log: used versus granted ──
    if (U) {
      for (const g of grants) {
        if (g.binding?.createdAt && now - Date.parse(g.binding.createdAt) < days * DAY) continue;   // too new to judge
        if (temporary.has(`${p.name}|${g.cluster}|${g.role}|${g.scope}`)) continue;
        const u = U[g.cluster]?.[p.name] || EMPTY;
        const s = g.scope === "cluster" ? { r: u.reads, w: u.writes, rbac: 0 } : (u.byNs[g.scope] || { r: 0, w: 0, rbac: 0 });
        const remove = { kind: "remove-role", user: p.name, clusters: [g.cluster], role: g.role, scope: g.scope, via: g.via, reason: "" };
        const grant = (role, ns) => ({ kind: "grant", user: p.name, clusters: [g.cluster], role, namespace: ns || undefined, mode: "directory", reason: "" });
        const dropGrant = (q) => { q.clusters[g.cluster] = q.clusters[g.cluster].filter((x) => !(x.role === g.role && x.scope === g.scope && x.via === g.via)); };
        const where = g.scope === "cluster" ? "" : ` in ${g.scope}`;
        let sug = null;
        if (!s.r && !s.w) {
          sug = { kind: "remove", title: `Remove ${g.role}${where}`, why: `Not used in ${days} days`, evidence: [`0 actions${where}`, g.binding?.createdAt ? `granted ${g.binding.createdAt.slice(0, 10)}` : "grant date unknown", ...(g.binding?.request ? [`from ${g.binding.request}`] : [])], requests: [remove], delta: deltaFor(dropGrant) };
        } else if (g.role === "cluster-admin") {
          const nsW = Object.entries(u.byNs).filter(([, v]) => v.w).sort((a, b) => b[1].w - a[1].w);
          const totalW = nsW.reduce((a, [, v]) => a + v.w, 0);
          const top = []; let acc = 0;
          for (const [ns, v] of nsW) { if (acc >= totalW * 0.9 || top.length >= 3) break; top.push([ns, v]); acc += v.w; }
          if (!u.writes) sug = { kind: "downgrade", title: "cluster-admin → cluster-reader", why: `Only read actions in ${days} days`, evidence: [`${u.reads.toLocaleString()} reads`, "0 changes", ...(g.binding && !g.binding.managed ? ["given by hand, not via request"] : [])], requests: [grant("cluster-reader"), remove], delta: deltaFor((q) => { dropGrant(q); q.clusters[g.cluster].push({ role: "cluster-reader", scope: "cluster", via: "tcs-cluster-reader" }); }) };
          else if (!u.clusterWrites && !u.osWrites && top.length) {
            const roles = top.map(([ns, v]) => [ns, v.rbac ? "admin" : "edit"]);
            sug = { kind: "narrow", title: `cluster-admin → ${roles.map(([ns, r]) => `${r} in ${ns}`).join(", ")}`, why: `${Math.round((acc / totalW) * 100)}% of the changes are in ${top.length === 1 ? "one namespace" : `${top.length} namespaces`}, none cluster-wide`, evidence: [...top.map(([ns, v]) => `${ns}: ${v.w} changes`), "0 cluster-wide changes"], requests: [...roles.map(([ns, r]) => grant(r, ns)), remove], delta: deltaFor((q) => { dropGrant(q); for (const [ns, r] of roles) q.clusters[g.cluster].push({ role: r, scope: ns, via: `tcs-${r}-${ns}` }); }) };
          } else if (u.privDays.size <= TEMP_DAYS()) sug = { kind: "temporary", title: "Standing → on request", why: `Used cluster-admin rights on ${u.privDays.size} day${u.privDays.size === 1 ? "" : "s"} in ${days}`, evidence: [...[...u.privDays].sort().slice(-4).map((d) => `cluster-wide change ${d}`), "request temporary cluster-admin when needed"], requests: [remove], delta: deltaFor(dropGrant) };
        } else if (g.role === "admin" && !s.w) sug = { kind: "downgrade", title: `admin → view in ${g.scope}`, why: `Only read in ${g.scope} for ${days} days`, evidence: [`${s.r} reads`, "0 changes"], requests: [grant("view", g.scope), remove], delta: deltaFor((q) => { dropGrant(q); q.clusters[g.cluster].push({ role: "view", scope: g.scope, via: `tcs-view-${g.scope}` }); }) };
        else if (g.role === "admin" && !s.rbac) sug = { kind: "downgrade", title: `admin → edit in ${g.scope}`, why: "Never changed roles or access in the namespace", evidence: [`${s.w} changes`, "0 role or binding changes"], requests: [grant("edit", g.scope), remove], delta: deltaFor((q) => { dropGrant(q); q.clusters[g.cluster].push({ role: "edit", scope: g.scope, via: `tcs-edit-${g.scope}` }); }) };
        else if (g.role === "edit" && !s.w) sug = { kind: "downgrade", title: `edit → view in ${g.scope}`, why: `Only read in ${g.scope} for ${days} days`, evidence: [`${s.r} reads`, "0 changes"], requests: [grant("view", g.scope), remove], delta: deltaFor((q) => { dropGrant(q); q.clusters[g.cluster].push({ role: "view", scope: g.scope, via: `tcs-view-${g.scope}` }); }) };
        if (!sug) continue;
        seenGrant.add(`${g.cluster}|${g.role}|${g.scope}`);
        // An AD-synced group cannot be changed here.
        if (g.synced) { sug.requests = sug.requests.filter((r) => r.kind !== "remove-role"); sug.manual = `Remove ${p.name} from AD group ${g.via}`; }
        for (const r of sug.requests) r.reason = `${sug.title}: ${sug.why} (Access insights)`;
        push({ ...sug, user: p.name, clusters: [g.cluster], role: g.role, scope: g.scope });
      }
    }

    // ── peers: access hardly anyone in the team has ──
    const teams = (p.groups || []).filter((t) => sum.teams?.[t] && !sum.teams[t].managed && !/^tcs-/.test(t));
    for (const g of grants.filter((x) => x.role !== "view" && !seenGrant.has(`${x.cluster}|${x.role}|${x.scope}`))) {
      for (const t of teams.filter((x) => x !== g.via)) {
        const others = sum.teams[t].members.filter((m) => m !== p.name && byName[m]);
        if (others.length < 4) continue;
        const have = others.filter((m) => (byName[m].clusters?.[g.cluster] || []).some((x) => x.role === g.role && x.scope === g.scope)).length;
        if (have / others.length > 0.2) continue;
        const req = { kind: "remove-role", user: p.name, clusters: [g.cluster], role: g.role, scope: g.scope, via: g.via, reason: `Peer check: ${have} of ${others.length} in ${t} hold it (Access insights)` };
        push({ kind: "peer", user: p.name, clusters: [g.cluster], role: g.role, scope: g.scope, title: `Review ${g.role}${g.scope !== "cluster" ? ` in ${g.scope}` : ""}`, why: `Only ${have ? `${have + 1}` : "member"} of ${t} with this access`, evidence: [`${others.length - have} of ${others.length} peers do not have it`, ...(U ? [`${(U[g.cluster]?.[p.name]?.byNs?.[g.scope]?.r || 0) + (U[g.cluster]?.[p.name]?.byNs?.[g.scope]?.w || 0)} actions in ${days} days`] : [])], requests: g.synced ? [] : [req], manual: g.synced ? `Remove ${p.name} from AD group ${g.via}` : null, confidence: "review", delta: deltaFor((q) => { q.clusters[g.cluster] = q.clusters[g.cluster].filter((x) => !(x.role === g.role && x.scope === g.scope)); }) });
        break;
      }
    }
  }

  // ── privileged service accounts ──
  const saRisk = [];
  for (const x of sum.governance?.privilegedSAs || []) {
    const uname = `system:serviceaccount:${x.namespace}:${x.name}`;
    const u = U ? U[x.cluster]?.[uname] || EMPTY : null;
    const used = u ? !!(u.reads || u.writes) : null;
    saRisk.push({ name: `${x.namespace}/${x.name}`, kind: "service account", cluster: x.cluster, ...scoreSA(x, used, prod) });
    if (!u) continue;
    const body = { kind: "remove-binding", clusters: [x.cluster], binding: x.binding, namespace: x.scope === "cluster" ? null : x.scope, subjectKind: "ServiceAccount", subject: `${x.namespace}/${x.name}`, role: x.role };
    const ownOnly = Object.keys(u.byNs).every((ns) => ns === x.namespace || !u.byNs[ns].w) && !u.clusterWrites;
    if (!used) push({ kind: "reduce", user: `${x.namespace}/${x.name}`, clusters: [x.cluster], title: `Remove ${x.role}`, why: `Token not used in ${days} days`, evidence: [`${x.role}${x.scope === "cluster" ? " cluster-wide" : ` in ${x.scope}`}`, `binding ${x.binding}`], requests: [{ ...body, reason: `Unused ${days} days (Access insights)` }], delta: saRisk.at(-1).score });
    else if (x.role === "cluster-admin" && x.scope === "cluster" && ownOnly) push({ kind: "reduce", user: `${x.namespace}/${x.name}`, clusters: [x.cluster], title: `cluster-admin → edit in ${x.namespace}`, why: `Only changes things in its own namespace`, evidence: [`${u.writes} changes, all in ${x.namespace}`, "0 cluster-wide changes"], requests: [{ ...body, reason: `Only acts in ${x.namespace} (Access insights)` }], manual: `Then give it edit in ${x.namespace}: oc adm policy add-role-to-user edit -z ${x.name} -n ${x.namespace}`, delta: 25 });
  }

  // ── HR: movers and joiners ──
  for (const h of hr?.movers || []) {
    const p = byName[h.user];
    if (!p) continue;
    const old = grantList(p).filter((g) => g.via === h.previousTeam || (g.via === "direct" && h.previousTeam));
    if (!old.length) continue;
    push({ kind: "mover", user: p.name, clusters: [...new Set(old.map((g) => g.cluster))], title: "Moved team: review old access", why: `HR: moved from ${h.previousTeam || "another team"} to ${h.team}${h.date ? ` on ${String(h.date).slice(0, 10)}` : ""}`, evidence: old.slice(0, 4).map((g) => `${g.role}${g.scope !== "cluster" ? ` in ${g.scope}` : ""} via ${g.via}`), requests: old.filter((g) => !g.synced).map((g) => ({ kind: "remove-role", user: p.name, clusters: [g.cluster], role: g.role, scope: g.scope, via: g.via, reason: `HR: moved to ${h.team} (Access insights)` })), confidence: "review", delta: 0 });
  }
  for (const h of hr?.joiners || []) {
    const pkg = packages?.[h.team];
    if (!pkg?.length || (byName[h.user] && grantList(byName[h.user]).length)) continue;
    push({ kind: "joiner", user: h.user, clusters: [...new Set(pkg.flatMap((x) => x.clusters || ["local"]))], title: `Give the ${h.team} starter access`, why: `HR: joined ${h.team}${h.date ? ` on ${String(h.date).slice(0, 10)}` : ""}`, evidence: pkg.map((x) => `${x.role}${x.namespace ? ` in ${x.namespace}` : ""}`), requests: pkg.map((x) => ({ kind: "grant", user: h.user, clusters: x.clusters || ["local"], role: x.role, namespace: x.namespace || undefined, mode: "directory", reason: `HR joiner: ${h.team} package` })), confidence: "review", delta: 0 });
  }

  // ── risk per identity ──
  const identities = [];
  for (const p of sum.people) {
    const r = p.builtin ? scorePerson(p, { prod, alert: alertOf[KUBEADMIN] || alertOf[p.name] }) : scorePerson(p, scoreCtx(p));
    if (!grantList(p).length && !r.score) continue;
    identities.push({ name: p.name, kind: p.builtin ? "built-in" : /htpasswd/.test(p.source || "") ? "local user" : "person", ...r, why: r.reasons.slice(0, 3).map((x) => x.text).join(" · ") });
  }
  identities.push(...saRisk.map((x) => ({ ...x, why: x.reasons.map((y) => y.text).join(" · ") })));
  identities.sort((a, b) => b.score - a.score);

  // ── KPIs ──
  const allGrants = people.filter((p) => !p.disabled).flatMap((p) => grantList(p).map((g) => ({ ...g, user: p.name })));
  const priv = allGrants.filter((g) => PRIV.has(g.role));
  const standing = priv.filter((g) => !temporary.has(`${g.user}|${g.cluster}|${g.role}|${g.scope}`)).length;
  let unused = null;
  if (U) {
    const old = allGrants.filter((g) => !(g.binding?.createdAt && now - Date.parse(g.binding.createdAt) < days * DAY));
    const idle = old.filter((g) => { const u = U[g.cluster]?.[g.user] || EMPTY; return g.scope === "cluster" ? !(u.reads || u.writes) : !(u.byNs[g.scope]?.r || u.byNs[g.scope]?.w); });
    unused = old.length ? Math.round((idle.length / old.length) * 100) : 0;
  } else {
    const idle = allGrants.filter((g) => idleOf(byName[g.user]).days >= 60);
    unused = allGrants.length ? Math.round((idle.length / allGrants.length) * 100) : 0;
  }
  const personIds = identities.filter((i) => i.kind !== "service account");
  const avg = personIds.length ? Math.round(personIds.reduce((a, i) => a + i.score, 0) / personIds.length) : 0;
  const cut = suggestions.filter((s) => !["mover", "joiner", "reduce"].includes(s.kind)).reduce((a, s) => a + Math.max(0, s.delta || 0), 0);
  const after = personIds.length ? Math.max(0, Math.round((personIds.reduce((a, i) => a + i.score, 0) - cut) / personIds.length)) : 0;
  const kpis = {
    identities: personIds.length + saRisk.length, people: personIds.length, serviceAccounts: saRisk.length,
    highRisk: identities.filter((i) => i.score >= 67).length,
    suggestions: suggestions.length, grantsRemoved: suggestions.reduce((a, s) => a + s.requests.filter((r) => ["remove-role", "remove-binding"].includes(r.kind)).length, 0),
    unusedPct: unused, unusedBasis: U ? `not used in ${days} days (audit log)` : "people with no login for 60+ days",
    standingPct: priv.length ? Math.round((standing / priv.length) * 100) : 0, privileged: priv.length,
    avgRisk: avg, avgRiskAfter: after, alerts: alerts.filter((a) => !["closed", "confirmed"].includes(a.status)).length,
  };

  // Hints for access reviews: keep or remove, with the reason.
  const reviewHints = {};
  for (const s of suggestions.filter((x) => x.role)) reviewHints[`${s.user}|${s.clusters[0]}|${s.role}|${s.scope}`] = { suggest: "remove", why: s.why };
  for (const p of people) for (const g of grantList(p)) {
    const k = `${p.name}|${g.cluster}|${g.role}|${g.scope}`;
    if (reviewHints[k]) continue;
    const u = U?.[g.cluster]?.[p.name];
    const used = u && (g.scope === "cluster" ? u.reads + u.writes : (u.byNs[g.scope]?.r || 0) + (u.byNs[g.scope]?.w || 0));
    const idle = idleOf(p);
    if (used) reviewHints[k] = { suggest: "keep", why: `${used} actions in ${days} days` };
    else if (idle.days >= 60) reviewHints[k] = { suggest: "remove", why: `no activity for ${idle.days} days` };
    else if (idle.last) reviewHints[k] = { suggest: "keep", why: `active ${idle.days ? `${idle.days} days ago` : "today"}` };
  }

  suggestions.sort((a, b) => (b.delta || 0) - (a.delta || 0));
  return {
    at: iso(now), audit: usage ? { source: usage.source, days, from: usage.from, to: usage.to, clusters: Object.keys(U || {}), error: usage.error || null } : null,
    watching: { since: obs.since || null, days: watchDays }, kpis, suggestions, identities: identities.slice(0, 200), alerts, reviewHints,
  };
}

/* ─────────────────────────── session alerts ─────────────────────────── */

const ALERT_SECRETS = () => Number(process.env.ACCESS_ALERT_SECRETS) || 20;
const FAILED_LOGINS = () => Number(process.env.ACCESS_ALERT_FAILED_LOGINS) || 10;
const BREAKGLASS = () => String(process.env.ACCESS_BREAKGLASS_USERS || "breakglass").split(",").map((x) => x.trim()).filter(Boolean);

/** Alerts from sessions, audit events of the last hours and stored observations. Pure. */
export function alertsFrom({ sum, usage, now = Date.now(), stored = [], state = {} }) {
  const prod = PROD();
  const out = [];
  const day = iso(now).slice(0, 10);
  const add = (a) => { const id = a.id || hid(a.kind, a.cluster, a.user, a.key || day); const s = state[id] || {}; out.push({ id, status: s.status || "open", statusBy: s.by || null, ticket: s.ticket || null, ...a }); };
  const ev = usage?.events || [];
  const evOf = (c, u) => ev.filter((e) => e.cluster === c && e.user === u);
  // kubeadmin in use.
  for (const c of (sum.clusters || []).filter((x) => x.ok)) {
    const bg = c.breakglass || {};
    const mine = evOf(c.cluster, KUBEADMIN);
    if (!bg.kubeadminSessions && !mine.length) continue;
    const secrets = mine.filter((e) => e.resource === "secrets" && READ.has(e.verb));
    const binds = mine.filter((e) => /rolebindings$/.test(e.resource || "") && (WRITE.has(e.verb)));
    const ips = [...new Set(mine.map((e) => e.ip).filter(Boolean))];
    add({ kind: "kubeadmin", level: "crit", cluster: c.cluster, user: KUBEADMIN, title: `kubeadmin used on ${c.cluster}`, at: bg.kubeadminLastLogin || mine[0]?.at || null,
      text: `${bg.kubeadminLastLogin ? `Logged in ${bg.kubeadminLastLogin.replace("T", " ").slice(0, 16)}` : "Active"}${ips.length ? ` from ${ips.slice(0, 2).join(", ")}` : ""}.`,
      facts: [...(bg.kubeadminSessions ? [`${bg.kubeadminSessions} active session${bg.kubeadminSessions > 1 ? "s" : ""}`] : []), ...(secrets.length ? [`read ${secrets.length} secrets in ${new Set(secrets.map((e) => e.ns)).size} namespaces`] : []), ...binds.slice(0, 3).map((e) => `${e.verb === "create" ? "created" : "changed"} ${e.resource === "clusterrolebindings" ? "ClusterRoleBinding" : "RoleBinding"} ${e.name || ""}${e.ns ? ` in ${e.ns}` : ""}`), "kubeadmin should only be used in an emergency"],
      actions: ["end-sessions", "remove-kubeadmin", "ask", "incident"], controls: ["emergency", "monitoring"] });
  }
  // Break-glass users with a session.
  for (const p of sum.people.filter((x) => BREAKGLASS().includes(x.name))) {
    for (const [c, d] of Object.entries(p.detail || {})) if (d.sessions) add({ kind: "breakglass", level: "crit", cluster: c, user: p.name, title: `Break-glass account ${p.name} used on ${c}`, at: d.lastLogin || null, text: "An emergency account has an active session.", facts: [`${d.sessions} active session${d.sessions > 1 ? "s" : ""}`, "confirm there is an incident behind it"], actions: ["end-sessions", "ask", "incident"], controls: ["emergency"] });
  }
  // From the audit events of the last hours.
  const by = new Map();
  for (const e of ev.filter((x) => x.user && x.user !== KUBEADMIN && !isSA(x.user))) { const k = `${e.cluster}|${e.user}`; if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
  for (const [k, list] of by) {
    const [c, u] = k.split("|");
    const secrets = list.filter((e) => e.resource === "secrets" && READ.has(e.verb) && !e.denied);
    const nss = new Set(secrets.map((e) => e.ns));
    if (secrets.length >= ALERT_SECRETS() || nss.size >= 3) add({ kind: "secrets", level: prod.test(c) ? "crit" : "warn", cluster: c, user: u, title: `${u} read ${secrets.length} secrets on ${c}`, at: secrets[0]?.at, text: `In ${nss.size} namespace${nss.size > 1 ? "s" : ""} in the last hours.`, facts: [...nss].slice(0, 6).map((ns) => `${ns}: ${secrets.filter((e) => e.ns === ns).length}`), actions: ["end-sessions", "ask", "disable", "incident"], controls: ["monitoring"] });
    const exec = list.filter((e) => e.resource === "pods" && ["exec", "attach"].includes(e.sub) && !e.denied);
    if (exec.length && prod.test(c)) add({ kind: "exec", level: "warn", cluster: c, user: u, title: `${u} opened a shell in ${exec.length} production pod${exec.length > 1 ? "s" : ""}`, at: exec[0]?.at, text: `On ${c}.`, facts: exec.slice(0, 5).map((e) => `${e.ns}/${e.name}`), actions: ["ask", "end-sessions", "incident"], controls: ["monitoring", "privileged"] });
    const rb = list.filter((e) => /rolebindings$/.test(e.resource || "") && WRITE.has(e.verb) && !e.denied);
    if (rb.length) add({ kind: "rbac", level: rb.some((e) => e.resource === "clusterrolebindings") ? "crit" : "warn", cluster: c, user: u, title: `${u} changed access by hand on ${c}`, at: rb[0]?.at, text: "Role bindings created or changed outside User & Access.", facts: rb.slice(0, 5).map((e) => `${e.verb} ${e.resource === "clusterrolebindings" ? "ClusterRoleBinding" : `RoleBinding in ${e.ns}`} ${e.name || ""}`), actions: ["ask", "disable", "incident"], controls: ["monitoring", "sod"] });
  }
  // Failed logins (OAuth server audit events).
  const fails = new Map();
  for (const e of ev.filter((x) => x.loginFailed)) { const k = `${e.cluster}|${e.loginUser || e.user}`; fails.set(k, [...(fails.get(k) || []), e]); }
  for (const [k, list] of fails) {
    if (list.length < FAILED_LOGINS()) continue;
    const [c, u] = k.split("|");
    add({ kind: "failed-logins", level: "warn", cluster: c, user: u, title: `${list.length} failed logins for ${u} on ${c}`, at: list[0]?.at, text: "Possible password guessing.", facts: [...new Set(list.map((e) => e.ip).filter(Boolean))].slice(0, 4).map((ip) => `from ${ip}`), actions: ["ask", "disable", "incident"], controls: ["monitoring"] });
  }
  // Stored observations (unusual hour, new cluster), last 7 days.
  for (const a of stored.filter((x) => now - Date.parse(x.at) < 7 * DAY)) add({ ...a, actions: ["ask", "end-sessions"], controls: ["monitoring"] });
  return out.sort((a, b) => (a.level === "crit" ? 0 : 1) - (b.level === "crit" ? 0 : 1) || String(b.at || "").localeCompare(String(a.at || "")));
}

/** Watch logins between ticks: last seen per cluster, usual hours, new clusters. Pure on (obs, sum). */
export function observeLogins(obs, sum, now = Date.now()) {
  const o = { since: obs.since || iso(now), lastSeen: { ...(obs.lastSeen || {}) }, hours: { ...(obs.hours || {}) } };
  const alerts = [];
  for (const p of sum.people.filter((x) => !x.builtin)) {
    for (const [c, d] of Object.entries(p.detail || {})) {
      if (!d.lastLogin) continue;
      const prev = o.lastSeen[p.name]?.[c];
      if (prev && prev >= d.lastLogin) continue;
      const hist = (o.hours[p.name] ||= Array(24).fill(0));
      const h = new Date(d.lastLogin).getUTCHours();
      const total = hist.reduce((a, x) => a + x, 0);
      const knownClusters = Object.keys(o.lastSeen[p.name] || {});
      const privHere = (p.clusters?.[c] || []).some((g) => PRIV.has(g.role));
      if (total >= 10 && !hist[h]) alerts.push({ kind: "unusual-hour", level: "warn", cluster: c, user: p.name, at: d.lastLogin, key: d.lastLogin, title: `${p.name} logged in at an unusual hour on ${c}`, text: `${String(h).padStart(2, "0")}:00 UTC; never seen at this hour in ${total} earlier logins.`, facts: [] });
      if (!prev && knownClusters.length && now - Date.parse(o.since) >= 7 * DAY && privHere) alerts.push({ kind: "new-cluster", level: "warn", cluster: c, user: p.name, at: d.lastLogin, key: d.lastLogin, title: `${p.name} logged in to ${c} for the first time`, text: "With admin rights there; usually works on other clusters.", facts: [`usual: ${knownClusters.slice(0, 3).join(", ")}`] });
      hist[h]++;
      (o.lastSeen[p.name] ||= {})[c] = d.lastLogin;
    }
  }
  return { obs: o, alerts };
}

/* ─────────────────────────── evidence ─────────────────────────── */

export function evidenceText(res, { policies = {}, policyStats = {}, actor = null, dismissed = {} } = {}) {
  const L = [];
  const k = res.kpis;
  L.push("ACCESS GOVERNANCE — EVIDENCE", `Generated ${res.at}${actor ? ` by ${actor}` : ""}`, "");
  L.push(`Audit log: ${res.audit ? `${res.audit.source}, last ${res.audit.days} days, clusters ${res.audit.clusters.join(", ") || "none"}` : "not connected (suggestions from logins only)"}`);
  L.push(`Identities: ${k.identities} (${k.people} people, ${k.serviceAccounts} privileged service accounts) · high risk: ${k.highRisk}`);
  L.push(`Unused access: ${k.unusedPct}% (${k.unusedBasis}) · standing admin: ${k.standingPct}% of ${k.privileged} privileged grants`);
  L.push(`Average risk ${k.avgRisk} → ${k.avgRiskAfter} if all suggestions are applied`, "");
  L.push("GUARDRAILS");
  for (const p of POLICY_DEFS) L.push(`- [${policies[p.id]?.enabled === false ? "off" : "on"}] ${p.label}: ${p.text} · this month: ${policyStats[p.id] || 0} · ${p.controls.flatMap((c) => CONTROLS[c]).slice(0, 3).join("; ")}`);
  L.push("", "SUGGESTIONS (open)");
  for (const s of res.suggestions) L.push(`- ${s.user} · ${s.clusters.join(", ")} · ${s.title}: ${s.why} [${s.evidence.join("; ")}] → ${(s.controls || []).flatMap((c) => CONTROLS[c] || []).slice(0, 2).join("; ")}`);
  const dis = Object.entries(dismissed);
  if (dis.length) { L.push("", "DISMISSED (with reason)"); for (const [id, d] of dis) L.push(`- ${id} ${d.title || ""} by ${d.by} on ${d.at.slice(0, 10)}: ${d.reason} (until ${d.until.slice(0, 10)})`); }
  L.push("", "SESSION ALERTS");
  for (const a of res.alerts) L.push(`- [${a.level}] ${a.title} · ${a.status}${a.statusBy ? ` by ${a.statusBy}` : ""}${a.ticket ? ` · ${a.ticket}` : ""}: ${a.facts.join("; ")}`);
  L.push("", "HIGHEST RISK");
  for (const i of res.identities.slice(0, 15)) L.push(`- ${i.name} (${i.kind}) ${i.score}: ${i.why}`);
  L.push("", "Method: roles are read from each cluster's bindings and groups; use is read from the OpenShift API audit log; logins from OAuth tokens. Suggestions are only applied through approved requests.");
  return L.join("\n");
}

/* ─────────────────────────── audit-log adapters ─────────────────────────── */

const clusterMap = () => { try { return JSON.parse(process.env.ACCESS_AUDIT_CLUSTER_MAP || "{}"); } catch { return {}; } };
const mapCluster = (v) => clusterMap()[v] || (v ? v : process.env.ACCESS_AUDIT_DEFAULT_CLUSTER || "local");
const NOISE = /^system:(node:|kube-|apiserver|anonymous|aggregator|admin$|openshift|serviceaccount:(openshift|kube)-)/;
export const keepUser = (u) => !!u && !NOISE.test(u);

/** One audit event (OpenShift / Kubernetes JSON) → the fields we use. */
export function parseAuditEvent(o, clusterField = process.env.ACCESS_AUDIT_CLUSTER_FIELD || "openshift.cluster_id") {
  if (!o || typeof o !== "object") return null;
  const getPath = (obj, path) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), obj);
  const ann = o.annotations || {};
  const decision = ann["authentication.openshift.io/decision"];
  const loginUser = ann["authentication.openshift.io/username"];
  return {
    at: o.requestReceivedTimestamp || o.stageTimestamp || o["@timestamp"] || null,
    cluster: mapCluster(getPath(o, clusterField) || o.openshift?.cluster_id || ""),
    user: o.user?.username || null, verb: o.verb || null,
    ns: o.objectRef?.namespace || "", resource: o.objectRef?.resource || "", sub: o.objectRef?.subresource || "", name: o.objectRef?.name || "",
    ip: (o.sourceIPs || [])[0] || null, denied: Number(o.responseStatus?.code) === 403,
    loginFailed: decision === "deny" || decision === "error", loginUser: loginUser || null,
  };
}

const SENSITIVE_RE = 'secrets|"exec"|"attach"|rolebindings|authentication.openshift.io/decision|kube:admin';

/** Loki (LokiStack: url = https://<gateway>/api/logs/v1/audit). */
export function lokiAdapter({ url, token = null, fetchImpl = fetch, selector = process.env.ACCESS_AUDIT_LOKI_SELECTOR || '{log_type="audit"}', clusterPath = process.env.ACCESS_AUDIT_CLUSTER_FIELD || "openshift.cluster_id", maxRangeDays = 30 }) {
  const base = url.replace(/\/+$/, "");
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const get = async (path, params) => {
    const r = await fetchImpl(`${base}${path}?${new URLSearchParams(params)}`, { headers });
    if (!r.ok) throw new Error(`Loki answered ${r.status}`);
    const j = await r.json();
    if (j.status && j.status !== "success") throw new Error(`Loki: ${j.error || j.status}`);
    return j.data?.result || [];
  };
  const pipe = `${selector} | json user="user.username", verb="verb", ns="objectRef.namespace", resource="objectRef.resource", sub="objectRef.subresource", stage="stage", cluster="${clusterPath}" | stage!="RequestReceived" | user!="" | user!~"system:(node:|kube-|apiserver|anonymous|aggregator|admin|openshift|serviceaccount:(openshift|kube)-).*"`;
  const ns = (t) => `${BigInt(Math.round(t)) * 1000000n}`;
  return {
    name: "Loki",
    async usage({ days = 30, alertHours = 24, now = Date.now() } = {}) {
      const rows = [], activity = [], privDays = [];
      // Loki limits one query to about 30 days: split longer windows.
      for (let end = now, left = days; left > 0; left -= maxRangeDays, end -= maxRangeDays * DAY) {
        const d = Math.min(left, maxRangeDays);
        for (const r of await get("/loki/api/v1/query", { query: `sum by (cluster, user, verb, ns, resource, sub) (count_over_time(${pipe} [${d}d]))`, time: ns(end) })) {
          rows.push({ cluster: mapCluster(r.metric.cluster), user: r.metric.user, verb: r.metric.verb, ns: r.metric.ns || "", resource: r.metric.resource || "", sub: r.metric.sub || "", count: Number(r.value?.[1]) || 0 });
        }
        const range = { start: ns(end - d * DAY), end: ns(end), step: "86400" };
        for (const r of await get("/loki/api/v1/query_range", { ...range, query: `sum by (cluster, user) (count_over_time(${pipe} [1d]))` })) {
          for (const [t, v] of r.values || []) if (Number(v) > 0) activity.push({ cluster: mapCluster(r.metric.cluster), user: r.metric.user, day: iso(Number(t) * 1000 - 1).slice(0, 10) });
        }
        for (const r of await get("/loki/api/v1/query_range", { ...range, query: `sum by (cluster, user) (count_over_time(${pipe} | ns="" | verb=~"create|update|patch|delete|deletecollection" [1d]))` })) {
          for (const [t, v] of r.values || []) if (Number(v) > 0) privDays.push({ cluster: mapCluster(r.metric.cluster), user: r.metric.user, day: iso(Number(t) * 1000 - 1).slice(0, 10) });
        }
      }
      const events = [];
      for (const s of await get("/loki/api/v1/query_range", { query: `${selector} |~ \`${SENSITIVE_RE}\``, start: ns(now - alertHours * 3600000), end: ns(now), limit: "2000", direction: "backward" })) {
        for (const [, line] of s.values || []) { try { const e = parseAuditEvent(JSON.parse(line), clusterPath); if (e && (keepUser(e.user) || e.loginFailed || e.user === KUBEADMIN)) events.push(e); } catch { /* not JSON */ } }
      }
      return { source: "Loki", days, from: iso(now - days * DAY), to: iso(now), rows, activity, privDays, events };
    },
  };
}

/** Elasticsearch / OpenSearch: composite aggregations over the audit index. */
export function elasticAdapter({ url, index = process.env.ACCESS_AUDIT_ES_INDEX || "audit-*", token = null, basic = null, fetchImpl = fetch, prefix = process.env.ACCESS_AUDIT_ES_PREFIX || "", kw = process.env.ACCESS_AUDIT_ES_KEYWORD ?? "", clusterField = process.env.ACCESS_AUDIT_CLUSTER_FIELD || "openshift.cluster_id" }) {
  const f = (x) => `${prefix}${x}${kw}`;
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : basic ? { Authorization: `Basic ${basic}` } : {}) };
  const search = async (body) => {
    const r = await fetchImpl(`${url.replace(/\/+$/, "")}/${index}/_search`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Elasticsearch answered ${r.status}`);
    return r.json();
  };
  const composite = async (sources, query) => {
    const out = [];
    let after;
    for (let i = 0; i < 30; i++) {
      const j = await search({ size: 0, query, aggs: { g: { composite: { size: 1000, sources, ...(after ? { after } : {}) } } } });
      const b = j.aggregations?.g?.buckets || [];
      out.push(...b);
      after = j.aggregations?.g?.after_key;
      if (!after || b.length < 1000) break;
    }
    return out;
  };
  const term = (name, field, missing = false) => ({ [name]: { terms: { field, ...(missing ? { missing_bucket: true } : {}) } } });
  return {
    name: "Elasticsearch",
    async usage({ days = 30, alertHours = 24, now = Date.now() } = {}) {
      const range = (ms) => ({ range: { [`${prefix}@timestamp`]: { gte: iso(now - ms), lte: iso(now) } } });
      const q = { bool: { filter: [range(days * DAY)], must_not: [{ term: { [f("stage")]: "RequestReceived" } }] } };
      const users = [term("cluster", f(clusterField), true), term("user", f("user.username"))];
      const rows = (await composite([...users, term("verb", f("verb")), term("ns", f("objectRef.namespace"), true), term("resource", f("objectRef.resource"), true), term("sub", f("objectRef.subresource"), true)], q))
        .filter((b) => keepUser(b.key.user)).map((b) => ({ cluster: mapCluster(b.key.cluster), user: b.key.user, verb: b.key.verb, ns: b.key.ns || "", resource: b.key.resource || "", sub: b.key.sub || "", count: b.doc_count }));
      const dayAgg = { day: { date_histogram: { field: `${prefix}@timestamp`, calendar_interval: "1d", format: "yyyy-MM-dd" } } };
      const activity = (await composite([...users, dayAgg], q)).filter((b) => keepUser(b.key.user)).map((b) => ({ cluster: mapCluster(b.key.cluster), user: b.key.user, day: b.key.day }));
      const qp = { bool: { ...q.bool, must_not: [...q.bool.must_not, { exists: { field: f("objectRef.namespace") } }], filter: [...q.bool.filter, { terms: { [f("verb")]: ["create", "update", "patch", "delete", "deletecollection"] } }] } };
      const privDays = (await composite([...users, dayAgg], qp)).filter((b) => keepUser(b.key.user)).map((b) => ({ cluster: mapCluster(b.key.cluster), user: b.key.user, day: b.key.day }));
      const j = await search({ size: 2000, sort: [{ [`${prefix}@timestamp`]: "desc" }], query: { bool: { filter: [range(alertHours * 3600000)], should: [{ term: { [f("objectRef.resource")]: "secrets" } }, { terms: { [f("objectRef.subresource")]: ["exec", "attach"] } }, { terms: { [f("objectRef.resource")]: ["rolebindings", "clusterrolebindings"] } }, { term: { [f("user.username")]: KUBEADMIN } }, { exists: { field: `${prefix}annotations.authentication.openshift.io/decision` } }], minimum_should_match: 1 } } });
      const events = (j.hits?.hits || []).map((h) => parseAuditEvent(prefix ? h._source?.[prefix.replace(/\.$/, "")] || h._source : h._source, clusterField)).filter((e) => e && (keepUser(e.user) || e.loginFailed || e.user === KUBEADMIN));
      return { source: "Elasticsearch", days, from: iso(now - days * DAY), to: iso(now), rows, activity, privDays, events };
    },
  };
}

/** Splunk: the export search endpoint, JSON results. */
export function splunkAdapter({ url, token, index = process.env.ACCESS_AUDIT_SPLUNK_INDEX || "openshift_audit", fetchImpl = fetch, clusterField = process.env.ACCESS_AUDIT_CLUSTER_FIELD || "openshift.cluster_id" }) {
  const run = async (search) => {
    const r = await fetchImpl(`${url.replace(/\/+$/, "")}/services/search/jobs/export`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ search, output_mode: "json" }).toString() });
    if (!r.ok) throw new Error(`Splunk answered ${r.status}`);
    return (await r.text()).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).result; } catch { return null; } }).filter(Boolean);
  };
  const ren = `rename "user.username" as user, "objectRef.namespace" as ns, "objectRef.resource" as resource, "objectRef.subresource" as sub, "${clusterField}" as cluster`;
  return {
    name: "Splunk",
    async usage({ days = 30, alertHours = 24, now = Date.now() } = {}) {
      const base = `search index=${index} earliest=-${days}d stage!=RequestReceived | ${ren} | fillnull value="" ns resource sub cluster`;
      const rows = (await run(`${base} | stats count by cluster user verb ns resource sub`)).filter((r) => keepUser(r.user)).map((r) => ({ cluster: mapCluster(r.cluster), user: r.user, verb: r.verb, ns: r.ns || "", resource: r.resource || "", sub: r.sub || "", count: Number(r.count) || 0 }));
      const activity = (await run(`${base} | eval day=strftime(_time, "%Y-%m-%d") | stats count by cluster user day`)).filter((r) => keepUser(r.user)).map((r) => ({ cluster: mapCluster(r.cluster), user: r.user, day: r.day }));
      const privDays = (await run(`${base} | where ns="" AND verb IN ("create","update","patch","delete","deletecollection") | eval day=strftime(_time, "%Y-%m-%d") | stats count by cluster user day`)).filter((r) => keepUser(r.user)).map((r) => ({ cluster: mapCluster(r.cluster), user: r.user, day: r.day }));
      const raw = await run(`search index=${index} earliest=-${alertHours}h ("secrets" OR "exec" OR "attach" OR "rolebindings" OR "kube:admin" OR "authentication.openshift.io/decision") | head 2000 | table _raw`);
      const events = raw.map((r) => { try { return parseAuditEvent(JSON.parse(r._raw), clusterField); } catch { return null; } }).filter((e) => e && (keepUser(e.user) || e.loginFailed || e.user === KUBEADMIN));
      return { source: "Splunk", days, from: iso(now - days * DAY), to: iso(now), rows, activity, privDays, events };
    },
  };
}

/** The adapter configured by environment, or null. */
export function auditFromEnv(fetchImpl = fetch) {
  const kind = String(process.env.ACCESS_AUDIT_SOURCE || "").toLowerCase();
  const url = process.env.ACCESS_AUDIT_URL;
  if (!kind || kind === "none" || !url) return null;
  let token = process.env.ACCESS_AUDIT_TOKEN || null;
  const tf = process.env.ACCESS_AUDIT_TOKEN_FILE || (kind === "loki" && !token ? "/var/run/secrets/kubernetes.io/serviceaccount/token" : null);
  if (!token && tf && existsSync(tf)) { try { token = readFileSync(tf, "utf8").trim(); } catch { /* none */ } }
  if (kind === "loki") return lokiAdapter({ url, token, fetchImpl });
  if (kind === "elasticsearch" || kind === "elastic" || kind === "opensearch") return elasticAdapter({ url, token, basic: process.env.ACCESS_AUDIT_BASIC || null, fetchImpl });
  if (kind === "splunk") return splunkAdapter({ url, token, fetchImpl });
  return null;
}

/* ─────────────────────────── HR feed ─────────────────────────── */

/** JSON array or CSV (user,status,team,previousTeam,date) → leavers, movers, joiners. Pure. */
export function parseHr(input) {
  let rows = [];
  if (Array.isArray(input)) rows = input;
  else if (typeof input === "string") {
    const lines = input.split(/\r?\n/).filter((l) => l.trim());
    const head = (lines.shift() || "").split(",").map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
    rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [head[i], v.trim()])));
    rows = rows.map((r) => ({ user: r.user || r.username, status: r.status, team: r.team, previousTeam: r.previousteam || r.oldteam, date: r.date }));
  }
  const norm = rows.filter((r) => r && r.user).map((r) => ({ user: String(r.user), status: String(r.status || "").toLowerCase(), team: r.team || null, previousTeam: r.previousTeam || null, date: r.date || null }));
  return {
    leavers: norm.filter((r) => /leav|terminat|exit|inactive/.test(r.status)),
    movers: norm.filter((r) => /mov|transfer/.test(r.status)),
    joiners: norm.filter((r) => /join|new|hire/.test(r.status)),
  };
}

/* ─────────────────────────── service (stateful) ─────────────────────────── */

let _state = null;
let _usage = { at: 0, data: null, error: null };
let _last = null;                       // { sum, result, at } for guardrails and tools
async function load() {
  if (_state) return _state;
  let v = null;
  try { v = await _deps.store?.get(STATE_KEY); } catch { /* none */ }
  _state = { obs: {}, dismissed: {}, alertState: {}, alerts: [], policies: {}, hr: { processed: {} }, ...(v && typeof v === "object" ? v : {}) };
  return _state;
}
async function save() { try { await _deps.store?.set(STATE_KEY, _state); } catch { /* memory only */ } }
export function _resetAccessInsights() { _state = null; _usage = { at: 0, data: null, error: null }; _last = null; }

export async function policies() {
  const st = await load();
  return { ...policyDefaults(), ...st.policies };
}
export async function setPolicy(id, enabled, actor) {
  if (!POLICY_DEFS.some((p) => p.id === id)) throw Object.assign(new Error("No such guardrail"), { status: 400 });
  const st = await load();
  st.policies[id] = { enabled: !!enabled, by: actor, at: iso(_deps.now()) };
  await save();
  _deps.auditLog(`Access guardrail "${POLICY_DEFS.find((p) => p.id === id).label}" turned ${enabled ? "on" : "off"}`, { id }, actor);
  return policies();
}

async function usage({ refresh = false } = {}) {
  if (!_deps.audit) return null;
  const ttl = Number(process.env.ACCESS_AUDIT_CACHE_MS) || 15 * 60000;
  if (!refresh && _usage.data && _deps.now() - _usage.at < ttl) return _usage.data;
  try {
    const days = Math.max(7, Math.min(180, Number(process.env.ACCESS_AUDIT_DAYS) || 90));
    _usage = { at: _deps.now(), data: await _deps.audit.usage({ days, alertHours: Number(process.env.ACCESS_ALERT_HOURS) || 24, now: _deps.now() }), error: null };
  } catch (e) {
    _usage = { at: _deps.now(), data: _usage.data ? { ..._usage.data, error: e.message } : null, error: e.message };
  }
  return _usage.data;
}

/** Record logins seen now; store any alerts they raise. */
export async function observe(sum) {
  const st = await load();
  const { obs, alerts } = observeLogins(st.obs, sum, _deps.now());
  st.obs = obs;
  if (alerts.length) {
    const known = new Set(st.alerts.map((a) => a.key + a.user));
    for (const a of alerts.filter((x) => !known.has(x.key + x.user))) {
      st.alerts.unshift(a);
      _deps.notify?.({ type: "access_alert", severity: "warning", title: a.title, message: a.text });
    }
    st.alerts = st.alerts.slice(0, 300);
  }
  await save();
  return alerts;
}

function parseJsonEnv(name) { try { return JSON.parse(process.env[name] || "null"); } catch { return null; } }

/** Everything for the tab, from a User & Access summary. */
export async function insights(sum, { refresh = false } = {}) {
  await observe(sum).catch(() => {});
  const st = await load();
  const u = await usage({ refresh });
  let hr = null;
  if (st.hr?.last) hr = st.hr.last;
  const result = analyze({ sum, usage: u, obs: st.obs, dismissed: st.dismissed, alertState: st.alertState, storedAlerts: st.alerts, hr, now: _deps.now(), packages: parseJsonEnv("ACCESS_PACKAGES") });
  if (_deps.audit && !u) result.auditError = _usage.error || "The audit log did not answer";
  // Notify new critical alerts once.
  st.notified ||= {};
  for (const a of result.alerts.filter((x) => x.level === "crit" && x.status === "open" && !st.notified[x.id])) {
    st.notified[a.id] = iso(_deps.now());
    _deps.notify?.({ type: "access_alert", severity: "critical", title: a.title, message: `${a.text} ${a.facts.join("; ")}` });
  }
  await save();
  _last = { sum, result, at: _deps.now(), usage: u };
  const pol = await policies();
  return { ...result, policies: POLICY_DEFS.map((p) => ({ ...p, enabled: pol[p.id]?.enabled !== false, controlRefs: p.controls.flatMap((c) => CONTROLS[c]).slice(0, 4), count: policyStats(sum.requests || [], _deps.now())[p.id] || 0 })), controls: CONTROLS, hr: st.hr?.last ? { at: st.hr.at, leavers: st.hr.last.leavers.length, movers: st.hr.last.movers.length, joiners: st.hr.last.joiners.length, processed: Object.keys(st.hr.processed || {}).length } : null, hrConfigured: !!_deps.hrFeed };
}

/** How often each guardrail acted in the last 30 days. Pure. */
export function policyStats(requests, now = Date.now()) {
  const out = {};
  for (const q of requests.filter((x) => now - Date.parse(x.requestedAt || 0) < 30 * DAY)) {
    for (const f of q.policy?.findings || []) out[f.policy] = (out[f.policy] || 0) + 1;
    if (/HR leaver/.test(q.decidedBy || "")) out["hr-leavers"] = (out["hr-leavers"] || 0) + 1;
  }
  return out;
}

/** The hook User & Access calls on every new request. Uses the last analysis; no cluster calls. */
export async function policyHook(q) {
  const pol = await policies();
  const sum = _last?.sum;
  const people = sum ? Object.fromEntries(sum.people.map((p) => [p.name, p])) : null;
  const writes = {};
  if (_last?.usage) for (const r of _last.usage.rows) if (WRITE.has(r.verb) || DEL.has(r.verb)) (writes[r.user] ||= []).push({ cluster: r.cluster, ns: r.ns, writes: r.count });
  const scores = Object.fromEntries((_last?.result?.identities || []).map((i) => [i.name, i.score]));
  return evaluateRequest(q, { policies: pol, people, teams: sum?.teams, writes, scores, now: _deps.now() });
}
export async function selfApprovalBlocked() { return (await policies())["no-self-approval"]?.enabled !== false; }

export async function dismiss(id, reason, actor, title = "") {
  const why = String(reason || "").trim().slice(0, 300);
  if (why.length < 5) throw Object.assign(new Error("Give a reason (it goes into the evidence)"), { status: 400 });
  const st = await load();
  st.dismissed[id] = { by: actor, at: iso(_deps.now()), reason: why, until: iso(_deps.now() + 90 * DAY), title: String(title).slice(0, 160) };
  await save();
  _deps.auditLog(`Access insight dismissed: ${title || id} — ${why}`, { id }, actor);
  return st.dismissed[id];
}
export async function dismissedList() { return (await load()).dismissed; }

/** Mark an alert: asked, confirmed (it was me), notme, closed, or with a ticket. */
export async function setAlertState(id, status, actor, extra = {}) {
  if (!["asked", "confirmed", "notme", "closed", "ticket"].includes(status)) throw Object.assign(new Error("Unknown alert state"), { status: 400 });
  const st = await load();
  const prev = st.alertState[id] || {};
  st.alertState[id] = { ...prev, status: status === "ticket" ? prev.status || "open" : status, by: actor, at: iso(_deps.now()), ...extra };
  await save();
  _deps.auditLog(`Access alert ${id}: ${status}${extra.ticket ? ` (${extra.ticket})` : ""}`, { id, ...extra }, actor);
  return st.alertState[id];
}
export function lastAlert(id) { return _last?.result?.alerts.find((a) => a.id === id) || null; }
export function lastSuggestion(id) { return _last?.result?.suggestions.find((s) => s.id === id) || null; }
export function lastResult() { return _last; }

/** HR feed: leavers disabled (when the guardrail is on), movers and joiners kept for suggestions. */
export async function hrTick(sum, { createRequest }) {
  if (!_deps.hrFeed) return null;
  const st = await load();
  const hr = parseHr(await _deps.hrFeed());
  st.hr = { ...(st.hr || {}), at: iso(_deps.now()), last: hr, processed: st.hr?.processed || {} };
  const on = (await policies())["hr-leavers"]?.enabled !== false;
  const out = [];
  if (on) {
    for (const l of hr.leavers) {
      if (st.hr.processed[l.user]) continue;
      const p = sum.people.find((x) => x.name === l.user);
      if (!p || p.disabled) continue;
      const where = Object.keys(p.clusters).filter((c) => (p.clusters[c] || []).length || p.detail?.[c]?.exists);
      if (!where.length) continue;
      try {
        const q = await createRequest({ kind: "disable", user: l.user, clusters: where, reason: `HR: leaver${l.date ? ` on ${String(l.date).slice(0, 10)}` : ""}` }, "hr-feed", { autoVia: "Policy: HR leaver" });
        st.hr.processed[l.user] = q.id;
        out.push(q.id);
      } catch (e) { st.hr.processed[l.user] = `failed: ${e.message.slice(0, 80)}`; }
    }
  }
  await save();
  return { leavers: hr.leavers.length, movers: hr.movers.length, joiners: hr.joiners.length, disabled: out };
}
