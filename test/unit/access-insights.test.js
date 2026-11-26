import { test } from "node:test";
import assert from "node:assert/strict";
import * as AI from "../../src/services/access-insights.js";

const NOW = Date.parse("2026-11-26T10:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const old = { createdAt: ago(400), managed: false, name: "b" };
const g = (role, scope, via = "direct", extra = {}) => ({ role, scope, via, binding: { ...old, ...extra } });

function sum() {
  const team = ["anita", "vikram", "ravi", "sita", "gopal", "uma"];
  const person = (name, clusters, { last = ago(1), source = "Company AD", groups = ["app-dev"], created = ago(300) } = {}) => ({
    name, source, clusters, groups, lastLogin: last, flags: [],
    detail: Object.fromEntries(Object.keys(clusters).map((c) => [c, { exists: true, createdAt: created, source, sessions: 0, lastLogin: last }])),
  });
  return {
    people: [
      person("suresh", { "ocp-prod-01": [g("edit", "payments", "payments-dev")] }, { last: ago(120) }),
      person("karthik", { "ocp-prod-01": [g("cluster-admin", "cluster")] }),
      person("priya", { "ocp-prod-01": [g("cluster-admin", "cluster", "platform-admins")] }, { groups: ["platform-admins"] }),
      person("rahul", { "ocp-prod-01": [g("cluster-admin", "cluster", "platform-admins")] }, { groups: ["platform-admins"] }),
      person("anita", { "ocp-dev-01": [g("edit", "billing")] }),
      person("vikram", { "ocp-prod-01": [g("view", "payments"), g("edit", "prod-db")] }),
      ...team.slice(2).map((n) => person(n, { "ocp-prod-01": [g("view", "payments")] })),
      { name: "kubeadmin", builtin: true, source: "built-in", clusters: { "ocp-prod-01": [{ role: "cluster-admin", scope: "cluster", via: "built-in" }] }, detail: {}, flags: [] },
    ],
    teams: { "app-dev": { members: team, synced: false, managed: false }, "platform-admins": { members: ["priya", "rahul"], synced: false, managed: false } },
    clusters: [{ cluster: "ocp-prod-01", ok: true, lastLoginKnown: true, breakglass: { kubeadminSessions: 1, kubeadminLastLogin: "2026-11-26T02:14:00Z" } }, { cluster: "ocp-dev-01", ok: true, lastLoginKnown: true, breakglass: {} }],
    governance: { privilegedSAs: [{ namespace: "ci", name: "builder", role: "cluster-admin", binding: "builder-admin", scope: "cluster", cluster: "ocp-dev-01" }] },
    requests: [],
  };
}

const row = (cluster, user, verb, ns, resource, count, sub = "") => ({ cluster, user, verb, ns, resource, sub, count });
function usage() {
  return {
    source: "test", days: 90, from: ago(90), to: ago(0),
    rows: [
      row("ocp-prod-01", "karthik", "get", "payments", "pods", 1200), row("ocp-prod-01", "karthik", "list", "", "nodes", 642),
      row("ocp-prod-01", "priya", "patch", "payments", "deployments", 400), row("ocp-prod-01", "priya", "create", "payments", "rolebindings", 12), row("ocp-prod-01", "priya", "get", "web", "pods", 11),
      row("ocp-prod-01", "rahul", "patch", "", "nodes", 2), row("ocp-prod-01", "rahul", "patch", "shop", "deployments", 50),
      row("ocp-prod-01", "vikram", "get", "payments", "pods", 30),
      row("ocp-dev-01", "anita", "get", "qa", "pods", 5),
      ...["ravi", "sita", "gopal", "uma"].map((u) => row("ocp-prod-01", u, "get", "payments", "pods", 10)),
    ],
    activity: [{ cluster: "ocp-prod-01", user: "karthik", day: "2026-11-25" }],
    privDays: [{ cluster: "ocp-prod-01", user: "rahul", day: "2026-09-12" }, { cluster: "ocp-prod-01", user: "rahul", day: "2026-10-03" }],
    events: [
      ...Array.from({ length: 37 }, (_, i) => ({ at: "2026-11-26T02:20:00Z", cluster: "ocp-prod-01", user: "kube:admin", verb: "get", ns: `ns${i % 6}`, resource: "secrets", name: `s${i}` })),
      { at: "2026-11-26T02:30:00Z", cluster: "ocp-prod-01", user: "kube:admin", verb: "create", ns: "", resource: "clusterrolebindings", name: "tmp-admin" },
      ...Array.from({ length: 3 }, (_, i) => ({ at: "2026-11-26T05:00:00Z", cluster: "ocp-prod-01", user: "vikram", verb: "create", ns: "payments", resource: "pods", sub: "exec", name: `api-${i}` })),
      ...Array.from({ length: 12 }, () => ({ at: "2026-11-26T06:00:00Z", cluster: "ocp-prod-01", user: null, loginFailed: true, loginUser: "meena", ip: "10.1.1.9" })),
    ],
  };
}

test("suggestions from logins and the audit log", () => {
  const out = AI.analyze({ sum: sum(), usage: usage(), now: NOW });
  const by = (u) => out.suggestions.filter((s) => s.user === u);
  assert.equal(by("suresh")[0].kind, "disable");
  assert.equal(by("karthik")[0].kind, "downgrade");
  assert.match(by("karthik")[0].title, /cluster-reader/);
  assert.deepEqual(by("karthik")[0].requests.map((r) => r.kind), ["grant", "remove-role"]);
  const pr = by("priya")[0];
  assert.equal(pr.kind, "narrow");
  assert.equal(pr.requests[0].role, "admin");           // she changes role bindings there
  assert.equal(pr.requests[0].namespace, "payments");
  assert.equal(by("rahul")[0].kind, "temporary");
  assert.equal(by("anita")[0].kind, "remove");           // edit in billing never used
  assert.ok(by("vikram").some((s) => s.kind === "remove" && s.scope === "prod-db"));
  const sa = out.suggestions.find((s) => s.kind === "reduce");
  assert.equal(sa.requests[0].subjectKind, "ServiceAccount");
  assert.ok(out.suggestions.every((s) => s.evidence.length && s.controls.length));
  assert.ok(out.kpis.avgRiskAfter < out.kpis.avgRisk);
  assert.equal(out.kpis.standingPct, 100);
});

test("without an audit log: disable from logins, peers, no used-versus-granted", () => {
  const s = sum();
  s.people.find((p) => p.name === "vikram").clusters["ocp-prod-01"].push(g("admin", "ledger"));
  const out = AI.analyze({ sum: s, usage: null, now: NOW });
  assert.ok(out.suggestions.some((x) => x.user === "suresh" && x.kind === "disable"));
  assert.ok(!out.suggestions.some((x) => ["downgrade", "narrow", "temporary"].includes(x.kind)));
  const peer = out.suggestions.find((x) => x.kind === "peer" && x.user === "vikram");
  assert.ok(peer);
  assert.match(peer.evidence[0], /peers do not have it/);
  assert.equal(out.audit, null);
});

test("watching only proves inactivity where logins are readable", () => {
  const s = sum();
  for (const p of s.people) { p.lastLogin = null; for (const d of Object.values(p.detail)) d.lastLogin = null; }
  const watched = AI.analyze({ sum: s, usage: null, obs: { since: ago(100) }, now: NOW });
  assert.ok(watched.suggestions.some((x) => x.kind === "disable"));
  s.clusters[0].lastLoginKnown = false; s.clusters[1].lastLoginKnown = false;
  const blind = AI.analyze({ sum: s, usage: null, obs: { since: ago(100) }, now: NOW });
  assert.ok(!blind.suggestions.some((x) => x.kind === "disable"));
});

test("dismissed suggestions stay away for 90 days", () => {
  const first = AI.analyze({ sum: sum(), usage: usage(), now: NOW });
  const id = first.suggestions[0].id;
  const next = AI.analyze({ sum: sum(), usage: usage(), now: NOW, dismissed: { [id]: { until: ago(-90) } } });
  assert.ok(!next.suggestions.some((s) => s.id === id));
});

test("risk per identity: kubeadmin and standing direct cluster-admin on production are high", () => {
  const out = AI.analyze({ sum: sum(), usage: usage(), now: NOW });
  const r = Object.fromEntries(out.identities.map((i) => [i.name, i.score]));
  assert.ok(r.kubeadmin >= 67);
  assert.ok(r.karthik >= 67);
  assert.ok(r.karthik > r.anita);
  assert.ok(out.identities.some((i) => i.kind === "service account"));
});

test("alerts: kubeadmin, exec on production, failed logins", () => {
  const out = AI.analyze({ sum: sum(), usage: usage(), now: NOW });
  const k = out.alerts.find((a) => a.kind === "kubeadmin");
  assert.equal(k.level, "crit");
  assert.ok(k.facts.some((f) => /37 secrets/.test(f)));
  assert.ok(k.facts.some((f) => /ClusterRoleBinding tmp-admin/.test(f)));
  assert.ok(out.alerts.some((a) => a.kind === "exec" && a.user === "vikram"));
  assert.ok(out.alerts.some((a) => a.kind === "failed-logins" && a.user === "meena"));
  const closed = AI.analyze({ sum: sum(), usage: usage(), now: NOW, alertState: { [k.id]: { status: "confirmed", by: "x" } } });
  assert.equal(closed.alerts.find((a) => a.id === k.id).status, "confirmed");
});

test("guardrails: standing cluster-admin on production is blocked with alternatives", () => {
  const s = sum();
  const people = Object.fromEntries(s.people.map((p) => [p.name, p]));
  const q = { kind: "grant", user: "anita", clusters: ["ocp-prod-01"], role: "cluster-admin", namespace: null, mode: "directory", delivery: "direct", reason: "debug" };
  const ev = AI.evaluateRequest(q, { people, teams: s.teams, writes: { anita: [{ cluster: "ocp-prod-01", ns: "qa-1", writes: 40 }] } });
  assert.equal(ev.decision, "block");
  assert.ok(ev.findings.some((f) => f.policy === "no-standing-ca-prod"));
  assert.ok(ev.findings.some((f) => f.policy === "ticket-privileged"));
  assert.ok(ev.findings.some((f) => f.policy === "peer-check"));
  assert.equal(ev.approvalsNeeded, 2);
  assert.deepEqual(ev.alternatives.map((a) => a.bodies[0].hours), [4, 8]);
  assert.equal(ev.alternatives[1].bodies[0].namespace, "qa-1");
  const off = AI.evaluateRequest(q, { policies: { "no-standing-ca-prod": { enabled: false }, "ticket-privileged": { enabled: false } } });
  assert.notEqual(off.decision, "block");
});

test("guardrails: local users on production blocked; low-risk temporary access approves itself", () => {
  const local = AI.evaluateRequest({ kind: "grant", user: "x", clusters: ["ocp-prod-01"], role: "view", namespace: "a", mode: "htpasswd", delivery: "direct" });
  assert.equal(local.decision, "block");
  assert.equal(local.alternatives[0].bodies[0].mode, "directory");
  const low = AI.evaluateRequest({ kind: "grant", user: "x", clusters: ["ocp-dev-01"], role: "edit", namespace: "a", mode: "directory", delivery: "direct", hours: 8 });
  assert.equal(low.decision, "auto");
  const perm = AI.evaluateRequest({ kind: "grant", user: "x", clusters: ["ocp-dev-01"], role: "edit", namespace: "a", mode: "directory", delivery: "direct" });
  assert.equal(perm.decision, "pending");
  assert.equal(AI.evaluateRequest({ kind: "disable", user: "x", clusters: ["ocp-prod-01"] }).decision, "pending");
});

test("logins: unusual hour and first login on a new cluster", () => {
  const s = sum();
  let obs = { since: ago(30), lastSeen: { rahul: { "ocp-dev-01": ago(2) } }, hours: { rahul: Array.from({ length: 24 }, (_, h) => (h >= 8 && h <= 18 ? 2 : 0)) } };
  const r = s.people.find((p) => p.name === "rahul");
  r.detail["ocp-prod-01"].lastLogin = "2026-11-26T03:10:00Z";
  const { alerts, obs: o2 } = AI.observeLogins(obs, s, NOW);
  assert.ok(alerts.some((a) => a.kind === "unusual-hour" && a.user === "rahul"));
  assert.ok(alerts.some((a) => a.kind === "new-cluster" && a.user === "rahul"));
  assert.equal(o2.lastSeen.rahul["ocp-prod-01"], "2026-11-26T03:10:00Z");
  assert.equal(AI.observeLogins(o2, s, NOW).alerts.length, 0, "the same login is not seen twice");
});

test("Loki adapter: metric and log queries become usage, events parsed", async () => {
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(u);
    const q = new URL(u).searchParams.get("query");
    let result = [];
    if (u.includes("/query?")) result = [{ metric: { cluster: "abc-123", user: "karthik", verb: "get", ns: "payments", resource: "pods" }, value: [0, "12"] }];
    else if (/sum by \(cluster, user\)/.test(q)) result = [{ metric: { cluster: "abc-123", user: "karthik" }, values: [[String(NOW / 1000), "3"]] }];
    else result = [{ values: [[String(NOW * 1e6), JSON.stringify({ user: { username: "kube:admin" }, verb: "get", objectRef: { resource: "secrets", namespace: "a" }, openshift: { cluster_id: "abc-123" }, requestReceivedTimestamp: "2026-11-26T02:00:00Z" })]] }];
    return { ok: true, json: async () => ({ status: "success", data: { result } }) };
  };
  process.env.ACCESS_AUDIT_CLUSTER_MAP = JSON.stringify({ "abc-123": "ocp-prod-01" });
  const a = AI.lokiAdapter({ url: "https://loki/api/logs/v1/audit", fetchImpl });
  const u = await a.usage({ days: 45, now: NOW });
  delete process.env.ACCESS_AUDIT_CLUSTER_MAP;
  assert.equal(calls.filter((c) => c.includes("/query?")).length, 2, "45 days in two windows of at most 30");
  assert.equal(u.rows[0].cluster, "ocp-prod-01");
  assert.equal(u.rows.reduce((x, r) => x + r.count, 0), 24);
  assert.ok(u.activity.length >= 1);
  assert.equal(u.events[0].user, "kube:admin");
  assert.equal(u.events[0].resource, "secrets");
});

test("HR feed: CSV leavers, movers and joiners; evidence report", () => {
  const hr = AI.parseHr("user,status,team,previous team,date\nsuresh,leaver,payments,,2026-11-20\nanita,mover,platform,qa-team,2026-11-01\nneha,joiner,app-dev,,2026-11-25\n");
  assert.deepEqual([hr.leavers.length, hr.movers.length, hr.joiners.length], [1, 1, 1]);
  const s = sum();
  s.people.find((p) => p.name === "anita").clusters["ocp-dev-01"][0].via = "qa-team";
  const out = AI.analyze({ sum: s, usage: null, hr, now: NOW, packages: { "app-dev": [{ role: "view", namespace: "payments", clusters: ["ocp-dev-01"] }] } });
  assert.ok(out.suggestions.some((x) => x.kind === "mover" && x.user === "anita"));
  assert.ok(out.suggestions.some((x) => x.kind === "joiner" && x.user === "neha"));
  const text = AI.evidenceText(out, { policies: {} });
  assert.match(text, /GUARDRAILS/);
  assert.match(text, /PCI DSS 4.0/);
});
