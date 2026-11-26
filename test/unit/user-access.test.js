import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import * as UA from "../../src/services/user-access.js";
import { AsyncLocalStorage } from "node:async_hooks";

// Like the server: the cluster's API connection travels in async context.
const als = new AsyncLocalStorage();
const ctxOcp = { fetch: (...a) => als.getStore().fetch(...a), post: (...a) => als.getStore().post(...a), patch: (...a) => als.getStore().patch(...a), delete: (...a) => als.getStore().delete(...a) };

/* A tiny in-memory Kubernetes: enough paths for User & Access. */
function fakeCluster({ ldapGroup = false, kubeadmin = true, htpasswd = "breakglass:$2y$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu\n", tokens = [] } = {}) {
  const store = new Map();
  const put = (path, obj) => store.set(path, JSON.parse(JSON.stringify(obj)));
  put("/apis/config.openshift.io/v1/oauths/cluster", { spec: { identityProviders: [
    { name: "corp-ad", type: "LDAP", ldap: {} },
    { name: "local", type: "HTPasswd", htpasswd: { fileData: { name: "htpass-secret" } } },
  ] } });
  put("/api/v1/namespaces/openshift-config/secrets/htpass-secret", { data: { htpasswd: Buffer.from(htpasswd).toString("base64") } });
  if (kubeadmin) put("/api/v1/namespaces/kube-system/secrets/kubeadmin", { data: {} });
  put("/api/v1/namespaces/payments", { metadata: { name: "payments" } });
  put("/apis/user.openshift.io/v1/users/rahul", { metadata: { name: "rahul" }, identities: ["corp-ad:CN=rahul"] });
  put("/apis/user.openshift.io/v1/users/suresh", { metadata: { name: "suresh" }, identities: ["corp-ad:CN=suresh"] });
  put("/apis/user.openshift.io/v1/groups/platform-admins", { metadata: { name: "platform-admins", ...(ldapGroup ? { labels: { "openshift.io/ldap.host": "ad.example.com" } } : {}) }, users: ["rahul"] });
  put("/apis/user.openshift.io/v1/groups/payments-dev", { metadata: { name: "payments-dev" }, users: ["suresh"] });
  put("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/admins", { metadata: { name: "admins" }, roleRef: { kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "Group", name: "platform-admins" }] });
  put("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/karthik-admin", { metadata: { name: "karthik-admin" }, roleRef: { kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "User", name: "karthik" }] });
  put("/apis/rbac.authorization.k8s.io/v1/namespaces/payments/rolebindings/dev", { metadata: { name: "dev", namespace: "payments" }, roleRef: { kind: "ClusterRole", name: "edit" }, subjects: [{ kind: "Group", name: "payments-dev" }, { kind: "User", name: "suresh" }] });
  tokens.forEach((t, i) => put(`/apis/oauth.openshift.io/v1/oauthaccesstokens/${t.metadata?.name || `tok${i}`}`, { ...t, metadata: { name: t.metadata?.name || `tok${i}`, ...t.metadata } }));
  const listOf = (prefix, depth) => ({ items: [...store.entries()].filter(([k]) => k.startsWith(prefix) && k.slice(prefix.length).split("/").length === depth).map(([, v]) => v) });
  const notFound = () => { throw new Error("OCP API 404: not found"); };
  const ocp = {
    fetch: async (path) => {
      if (path === "/apis/user.openshift.io/v1/users") return listOf("/apis/user.openshift.io/v1/users/", 1);
      if (path === "/apis/user.openshift.io/v1/groups") return listOf("/apis/user.openshift.io/v1/groups/", 1);
      if (path === "/apis/user.openshift.io/v1/identities") return { items: [] };
      if (path === "/apis/oauth.openshift.io/v1/oauthaccesstokens") return listOf("/apis/oauth.openshift.io/v1/oauthaccesstokens/", 1);
      if (/\/namespaces\/[^/]+\/rolebindings$/.test(path)) return listOf(path + "/", 1);
      if (path === "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings") return listOf("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/", 1);
      if (path === "/apis/rbac.authorization.k8s.io/v1/rolebindings") return { items: [...store.entries()].filter(([k]) => /\/namespaces\/[^/]+\/rolebindings\/[^/]+$/.test(k)).map(([, v]) => v) };
      return store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : notFound();
    },
    post: async (path, body) => {
      const name = body.metadata.name;
      const full = `${path}/${name}`;
      if (store.has(full)) throw new Error("OCP API 409: exists");
      put(full, body); return body;
    },
    patch: async (path, body) => { if (!store.has(path)) notFound(); put(path, { ...store.get(path), ...body }); return store.get(path); },
    delete: async (path) => { if (!store.has(path)) notFound(); store.delete(path); return {}; },
  };
  return { store, ocp };
}

function setup(clusters) {
  UA._resetUserAccess();
  const audit = [];
  UA.configureUserAccess({
    run: async (c, fn) => als.run(clusters[c].ocp, fn),
    exec: null, snApproval: null, notify: null, policy: null,
    ocp: ctxOcp,
    now: () => Date.parse("2026-11-25T10:00:00Z"),
    audit: (t) => audit.push(t),
  });
  return audit;
}

test("access read: grants through groups and directly, kubeadmin and direct-admin flags", async () => {
  const c = fakeCluster();
  setup({ hub: c });
  const raw = await als.run(c.ocp, () => UA.readCluster());
  const a = UA.accessOf(raw, { now: Date.parse("2026-11-25T10:00:00Z") });
  assert.deepEqual(a.people.rahul.grants.map(({ role, scope, via }) => ({ role, scope, via })), [{ role: "cluster-admin", scope: "cluster", via: "platform-admins" }]);
  assert.equal(a.people.rahul.grants[0].binding.name, "admins");
  assert.equal(a.people.suresh.grants.length, 2, "edit via payments-dev and directly");
  assert.ok(a.flags.some((f) => f.person === "karthik" && /directly/.test(f.text)));
  assert.ok(a.flags.some((f) => f.person === "kubeadmin"));
  assert.deepEqual(raw.htpasswdUsers.local, ["breakglass"]);
  assert.equal(a.people.rahul.source, "AD / LDAP");
});

test("summary across clusters: people grid, kubeadmin row, unreachable cluster shown as such", async () => {
  const hub = fakeCluster(), dev = fakeCluster({ kubeadmin: false });
  setup({ hub, dev, broken: { ocp: { fetch: async () => { throw new Error("OCP API 503: down"); } } } });
  const s = await UA.summary(["hub", "dev", "broken"]);
  assert.equal(s.kpis.reachable, 2);
  assert.equal(s.kpis.kubeadmin, 1);
  assert.equal(s.clusters.find((c) => c.cluster === "broken").ok, false);
  const k = s.people.find((p) => p.name === "kubeadmin");
  assert.equal(k.kubeadmin.hub, true); assert.equal(k.kubeadmin.dev, false);
  assert.ok(s.people.find((p) => p.name === "rahul").clusters.dev.length);
});

test("grant through company login: request, someone else approves, group and binding appear on each cluster", async () => {
  const hub = fakeCluster(), dev = fakeCluster();
  const audit = setup({ hub, dev });
  const q = await UA.createRequest({ kind: "grant", clusters: ["hub", "dev"], user: "priya", role: "edit", namespace: "payments", expires: "2027-03-31" }, "anita");
  assert.equal(q.status, "pending");
  assert.equal(q.group, "tcs-edit-payments");
  await assert.rejects(UA.approveRequest(q.id, "anita"), /other than the requester/);
  const out = await UA.approveRequest(q.id, "rahul");
  assert.equal(out.status, "done");
  assert.equal(out.password, null, "no password for company login");
  for (const c of [hub, dev]) {
    assert.deepEqual(c.store.get("/apis/user.openshift.io/v1/groups/tcs-edit-payments").users, ["priya"]);
    const rb = c.store.get("/apis/rbac.authorization.k8s.io/v1/namespaces/payments/rolebindings/tcs-ua-tcs-edit-payments-edit");
    assert.equal(rb.roleRef.name, "edit");
  }
  assert.ok(audit.some((t) => /approved/.test(t)));
});

test("htpasswd grant: bcrypt entry added, password returned once and not stored", async () => {
  const hub = fakeCluster();
  setup({ hub });
  const q = await UA.createRequest({ kind: "grant", mode: "htpasswd", clusters: ["hub"], user: "lab-user1", role: "view", namespace: "payments" }, "a");
  const out = await UA.approveRequest(q.id, "b");
  assert.equal(out.status, "done");
  assert.equal(out.password.length, 16);
  const text = Buffer.from(hub.store.get("/api/v1/namespaces/openshift-config/secrets/htpass-secret").data.htpasswd, "base64").toString();
  const row = UA.parseHtpasswd(text).find((r) => r.user === "lab-user1");
  assert.ok(bcrypt.compareSync(out.password, row.hash));
  assert.ok(text.includes("breakglass:"), "existing entries kept");
  const again = (await UA.summary(["hub"])).requests.find((r) => r.id === q.id);
  assert.equal(again.password, undefined);
  assert.throws(() => UA.validateRequest({ kind: "grant", mode: "htpasswd", clusters: ["hub"], user: "x", role: "view", namespace: "payments", delivery: "gitops" }), /only be applied directly/);
});

test("an AD-synced group is not edited; a missing namespace changes nothing", async () => {
  const hub = fakeCluster({ ldapGroup: true });
  setup({ hub });
  const q = await UA.createRequest({ kind: "grant", clusters: ["hub"], user: "priya", role: "cluster-admin", group: "platform-admins" }, "a");
  const out = await UA.approveRequest(q.id, "b");
  assert.equal(out.status, "failed");
  assert.match(out.results[0].text, /synced from AD/);
  const q2 = await UA.createRequest({ kind: "grant", clusters: ["hub"], user: "priya", role: "edit", namespace: "missing-ns" }, "a");
  const out2 = await UA.approveRequest(q2.id, "b");
  assert.match(out2.results[0].text, /does not exist/);
  assert.equal(hub.store.has("/apis/user.openshift.io/v1/groups/tcs-edit-missing-ns"), false);
});

test("remove everywhere: groups, direct bindings, local login, user; never the last admin", async () => {
  const hub = fakeCluster({ htpasswd: "suresh:$2a$10$x\nbreakglass:$2a$10$y\n" });
  setup({ hub });
  const q = await UA.createRequest({ kind: "revoke", clusters: ["hub"], user: "suresh" }, "a");
  const out = await UA.approveRequest(q.id, "b");
  assert.equal(out.status, "done", out.results[0].text);
  assert.deepEqual(hub.store.get("/apis/user.openshift.io/v1/groups/payments-dev").users, []);
  assert.deepEqual(hub.store.get("/apis/rbac.authorization.k8s.io/v1/namespaces/payments/rolebindings/dev").subjects, [{ kind: "Group", name: "payments-dev" }]);
  assert.equal(hub.store.has("/apis/user.openshift.io/v1/users/suresh"), false);
  const text = Buffer.from(hub.store.get("/api/v1/namespaces/openshift-config/secrets/htpass-secret").data.htpasswd, "base64").toString();
  assert.equal(text.includes("suresh:"), false);
  // Last admin who can log in: refused.
  const solo = fakeCluster({ kubeadmin: false });
  solo.store.delete("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/karthik-admin");
  setup({ solo });
  const q2 = await UA.createRequest({ kind: "revoke", clusters: ["solo"], user: "rahul" }, "a");
  const out2 = await UA.approveRequest(q2.id, "b");
  assert.match(out2.results[0].text, /only cluster-admin/);
});

test("remove kubeadmin only when another admin can log in", async () => {
  const hub = fakeCluster();
  setup({ hub });
  const q = await UA.createRequest({ kind: "remove-kubeadmin", clusters: ["hub"] }, "a");
  const out = await UA.approveRequest(q.id, "b");
  assert.equal(out.status, "done");
  assert.equal(hub.store.has("/api/v1/namespaces/kube-system/secrets/kubeadmin"), false);
  const bare = fakeCluster();
  for (const k of [...bare.store.keys()]) if (/clusterrolebindings/.test(k)) bare.store.delete(k);
  setup({ bare });
  const q2 = await UA.createRequest({ kind: "remove-kubeadmin", clusters: ["bare"] }, "a");
  assert.match((await UA.approveRequest(q2.id, "b")).results[0].text, /No other user has cluster-admin/);
});

test("expired access is removed by the tick; ACM delivery generates a policy instead of applying", async () => {
  const hub = fakeCluster();
  let now = Date.parse("2026-11-25T10:00:00Z");
  setup({ hub });
  UA.configureUserAccess({ now: () => now });
  const q = await UA.createRequest({ kind: "grant", clusters: ["hub"], user: "temp", role: "view", namespace: "payments", expires: "2026-12-01" }, "a");
  await UA.approveRequest(q.id, "b");
  assert.deepEqual(await UA.expireTick(), []);
  now = Date.parse("2026-12-02T00:00:00Z");
  assert.deepEqual(await UA.expireTick(), [q.id]);
  assert.deepEqual(hub.store.get("/apis/user.openshift.io/v1/groups/tcs-view-payments").users, []);
  now = Date.parse("2026-11-25T10:00:00Z");
  const a = await UA.createRequest({ kind: "grant", clusters: ["hub", "dev"], user: "priya", role: "edit", namespace: "payments", delivery: "acm" }, "a");
  const out = await UA.approveRequest(a.id, "b");
  assert.match(out.manifests, /kind: Policy/);
  assert.match(out.manifests, /complianceType: musthave/);
  assert.equal(hub.store.has("/apis/user.openshift.io/v1/groups/tcs-edit-payments"), false, "nothing applied directly");
});

test("validation", () => {
  assert.throws(() => UA.validateRequest({ kind: "grant", clusters: [], user: "a", role: "view", namespace: "x" }), /at least one cluster/);
  assert.throws(() => UA.validateRequest({ kind: "grant", clusters: ["c"], user: "system:admin", role: "view", namespace: "x" }), /user name/);
  assert.throws(() => UA.validateRequest({ kind: "grant", clusters: ["c"], user: "a", role: "god", namespace: "x" }), /Pick a role/);
  assert.equal(UA.validateRequest({ kind: "grant", clusters: ["c"], user: "a@b.com", role: "cluster-admin" }).namespace, null);
  assert.equal(UA.managedGroupName("edit", "payments"), "tcs-edit-payments");
});

test("ServiceNow approval applies the request; a rejection rejects it; htpasswd still needs a person", async () => {
  const hub = fakeCluster();
  setup({ hub });
  const state = {};
  UA.configureUserAccess({ snApproval: async (sys) => state[sys] || "requested" });
  const a = await UA.createRequest({ kind: "grant", clusters: ["hub"], user: "priya", role: "edit", namespace: "payments" }, "admin");
  const b = await UA.createRequest({ kind: "revoke", clusters: ["hub"], user: "suresh" }, "admin");
  const c = await UA.createRequest({ kind: "grant", mode: "htpasswd", clusters: ["hub"], user: "lab1", role: "view", namespace: "payments" }, "admin");
  await UA.setTicket(a.id, "CHG001", "s1"); await UA.setTicket(b.id, "CHG002", "s2"); await UA.setTicket(c.id, "CHG003", "s3");
  assert.deepEqual(await UA.serviceNowTick(), [], "nothing decided yet");
  state.s1 = "approved"; state.s2 = "rejected"; state.s3 = "approved";
  assert.deepEqual((await UA.serviceNowTick()).sort(), [a.id, b.id].sort());
  const s = await UA.summary(["hub"]);
  assert.equal(s.requests.find((r) => r.id === a.id).status, "done");
  assert.equal(s.requests.find((r) => r.id === a.id).decidedBy, "ServiceNow CHG001");
  assert.equal(s.requests.find((r) => r.id === b.id).status, "rejected");
  const h = s.requests.find((r) => r.id === c.id);
  assert.equal(h.status, "pending"); assert.equal(h.snApproved, true);
  assert.deepEqual(hub.store.get("/apis/user.openshift.io/v1/groups/tcs-edit-payments").users, ["priya"]);
});

test("operations can be routed elsewhere (as to a spoke agent), and the read leaves out what is not needed", async () => {
  const hub = fakeCluster();
  setup({ hub });
  const seen = [];
  UA.configureUserAccess({ exec: async (cluster, op, payload) => { seen.push([cluster, op]); return als.run(hub.ocp, () => UA.localOp(op, payload)); } });
  const s = await UA.summary(["spoke-1"]);
  assert.equal(s.clusters[0].ok, true);
  const q = await UA.createRequest({ kind: "grant", clusters: ["spoke-1"], user: "priya", role: "view", namespace: "payments" }, "a");
  await UA.approveRequest(q.id, "b");
  assert.deepEqual(seen, [["spoke-1", "read"], ["spoke-1", "grant"]]);
  const raw = await als.run(hub.ocp, () => UA.readCluster());
  assert.ok(raw.crbs.every((b) => ["cluster-admin", "cluster-reader"].includes(b.roleRef.name)));
  assert.equal(JSON.stringify(raw).includes("$2y$"), false, "no password hashes leave the cluster");
});

const tok = (userName, name) => ({ userName, metadata: { name, creationTimestamp: "2026-11-24T10:00:00Z" } });

test("remove one role: a direct binding, or the person's place in the group that gives it", async () => {
  const hub = fakeCluster();
  setup({ hub });
  const a = await UA.createRequest({ kind: "remove-role", clusters: ["hub"], user: "suresh", role: "edit", scope: "payments", via: "direct" }, "a");
  assert.equal((await UA.approveRequest(a.id, "b")).status, "done");
  assert.deepEqual(hub.store.get("/apis/rbac.authorization.k8s.io/v1/namespaces/payments/rolebindings/dev").subjects, [{ kind: "Group", name: "payments-dev" }]);
  const b = await UA.createRequest({ kind: "remove-role", clusters: ["hub"], user: "suresh", role: "edit", scope: "payments", via: "payments-dev" }, "a");
  const out = await UA.approveRequest(b.id, "b");
  assert.match(out.results[0].text, /removed from payments-dev/);
  assert.deepEqual(hub.store.get("/apis/user.openshift.io/v1/groups/payments-dev").users, []);
});

test("disable suspends and ends sessions; enable restores exactly what was there", async () => {
  const hub = fakeCluster({ htpasswd: "suresh:$2a$10$abc\n", tokens: [tok("suresh", "t1"), tok("suresh", "t2"), tok("rahul", "t3")] });
  setup({ hub });
  const d = await UA.createRequest({ kind: "disable", clusters: ["hub"], user: "suresh" }, "a");
  const out = await UA.approveRequest(d.id, "b");
  assert.equal(out.status, "done", out.results[0].text);
  assert.match(out.results[0].text, /2 sessions ended/);
  assert.deepEqual(hub.store.get("/apis/user.openshift.io/v1/groups/payments-dev").users, []);
  assert.equal(hub.store.has("/apis/oauth.openshift.io/v1/oauthaccesstokens/t3"), true, "other people's sessions untouched");
  const ht = () => Buffer.from(hub.store.get("/api/v1/namespaces/openshift-config/secrets/htpass-secret").data.htpasswd, "base64").toString();
  assert.match(ht(), /^suresh:!/m);
  const s1 = await UA.summary(["hub"]);
  assert.equal(s1.people.find((p) => p.name === "suresh").disabled.request, d.id);
  const e = await UA.createRequest({ kind: "enable", clusters: ["hub"], user: "suresh", fromRequest: d.id }, "a");
  assert.equal((await UA.approveRequest(e.id, "b")).status, "done");
  assert.deepEqual(hub.store.get("/apis/user.openshift.io/v1/groups/payments-dev").users, ["suresh"]);
  assert.ok(hub.store.get("/apis/rbac.authorization.k8s.io/v1/namespaces/payments/rolebindings/dev").subjects.some((x) => x.kind === "User" && x.name === "suresh"));
  assert.match(ht(), /^suresh:\$2a/m);
});

test("reset password: new bcrypt hash, sessions ended, refused while disabled", async () => {
  const hub = fakeCluster({ htpasswd: "lab1:$2a$10$old\n", tokens: [tok("lab1", "t1")] });
  setup({ hub });
  const r = await UA.createRequest({ kind: "reset-password", clusters: ["hub"], user: "lab1" }, "a");
  const out = await UA.approveRequest(r.id, "b");
  assert.equal(out.status, "done");
  const row = UA.parseHtpasswd(Buffer.from(hub.store.get("/api/v1/namespaces/openshift-config/secrets/htpass-secret").data.htpasswd, "base64").toString()).find((x) => x.user === "lab1");
  assert.ok(bcrypt.compareSync(out.password, row.hash));
  assert.equal(hub.store.has("/apis/oauth.openshift.io/v1/oauthaccesstokens/t1"), false);
  const missing = await UA.createRequest({ kind: "reset-password", clusters: ["hub"], user: "nobody" }, "a");
  assert.match((await UA.approveRequest(missing.id, "b")).results[0].text, /no local/);
});

test("temporary access, unofficial grants, separation of duties, rotation and the entitlement report", async () => {
  const hub = fakeCluster();
  setup({ hub });
  const t = UA.validateRequest({ kind: "grant", clusters: ["hub"], user: "x", role: "cluster-admin", hours: 2 });
  assert.equal(Date.parse(t.expires) - Date.parse("2026-11-25T10:00:00Z"), 2 * 3600000);
  let s = await UA.summary(["hub"]);
  const keys = s.governance.unofficial.map((u) => u.key);
  assert.ok(s.governance.unofficial.some((u) => u.subject === "karthik"));
  assert.ok(s.governance.sod.some((x) => x.rule === "direct-admin" && x.person === "karthik"));
  await UA.acceptBaseline(keys, "rahul");
  s = await UA.summary(["hub"]);
  assert.equal(s.governance.unofficial.length, 0);
  await UA.setRotation("breakglass", 90, "rahul");
  s = await UA.summary(["hub"]);
  assert.equal(s.roleDocs["cluster-admin"].label, "Cluster admin");
  const csv = UA.entitlementCsv(s);
  assert.match(csv.split("\n")[0], /^person,login,cluster,role/);
  assert.ok(csv.includes("rahul,AD / LDAP,hub,cluster-admin"));
});

test("access review: decide, close, and removals become requests", async () => {
  const hub = fakeCluster();
  setup({ hub });
  const s = await UA.summary(["hub"]);
  const r = await UA.createReview({ name: "Q4 admins", due: "2026-12-31", scope: "privileged" }, s, "rahul");
  const full = await UA.getReview(r.id);
  assert.ok(full.items.length >= 2);
  const karthik = full.items.find((i) => i.person === "karthik");
  await UA.decideReview(r.id, [{ key: karthik.key, decision: "remove" }], "anita");
  const closed = await UA.closeReview(r.id, { removeUnreviewed: false }, "anita");
  assert.equal(closed.status, "closed");
  assert.equal(closed.requests.length, 1);
  const q = (await UA.summary(["hub"])).requests.find((x) => x.id === closed.requests[0]);
  assert.equal(q.kind, "remove-role");
  assert.equal(q.user, "karthik");
});

test("guardrails on requests: held, override with two approvers, alternative, auto-approve", async () => {
  const c = fakeCluster();
  setup({ "ocp-prod-01": c, "ocp-dev-01": fakeCluster() });
  const AI = await import("../../src/services/access-insights.js");
  UA.configureUserAccess({ policy: async (q) => AI.evaluateRequest(q, {}) });
  // Standing cluster-admin on production: held.
  const held = await UA.createRequest({ kind: "grant", user: "meena", clusters: ["ocp-prod-01"], role: "cluster-admin", reason: "debug" }, "meena");
  assert.equal(held.status, "held");
  assert.ok(held.policy.findings.some((f) => f.policy === "no-standing-ca-prod"));
  await assert.rejects(UA.approveRequest(held.id, "admin2", {}), /held/);
  // Replace it by the 4-hour alternative (still needs its ticket).
  const rep = await UA.replaceRequest(held.id, 0, "admin2");
  assert.equal(rep.replaced.status, "replaced");
  assert.equal(rep.created[0].hours, 4);
  assert.equal(rep.created[0].status, "held");
  const withRef = await UA.setChangeRef(rep.created[0].id, "CHG0031234", "meena");
  assert.equal(withRef.status, "pending");
  assert.equal(withRef.approvalsNeeded, 2);
  const one = await UA.approveRequest(withRef.id, "admin2", {});
  assert.equal(one.waiting, true);
  await assert.rejects(UA.approveRequest(withRef.id, "admin2", {}), /second Admin/);
  const two = await UA.approveRequest(withRef.id, "admin3", {});
  assert.equal(two.status, "done");
  // Override needs a reason.
  const h2 = await UA.createRequest({ kind: "grant", user: "x1", clusters: ["ocp-prod-01"], role: "view", namespace: "payments", mode: "htpasswd" }, "a");
  assert.equal(h2.status, "held");
  await assert.rejects(UA.overrideRequest(h2.id, "admin2", ""), /reason/);
  const ov = await UA.overrideRequest(h2.id, "admin2", "Vendor laptop without AD for the audit week");
  assert.equal(ov.status, "pending");
  assert.equal(ov.override.by, "admin2");
  // Low risk, temporary, non-production: approved by policy.
  const auto = await UA.createRequest({ kind: "grant", user: "neha", clusters: ["ocp-dev-01"], role: "edit", namespace: "payments", hours: 8 }, "neha");
  assert.equal(auto.status, "done");
  assert.match(auto.decidedBy, /Policy/);
  UA.configureUserAccess({ policy: null });
});

test("service-account bindings can be removed through a request", async () => {
  const c = fakeCluster();
  c.store.set("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/builder-admin", { metadata: { name: "builder-admin" }, roleRef: { kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "ServiceAccount", name: "builder", namespace: "ci" }, { kind: "ServiceAccount", name: "builder", namespace: "other" }] });
  setup({ local: c });
  const q = await UA.createRequest({ kind: "remove-binding", clusters: ["local"], binding: "builder-admin", subjectKind: "ServiceAccount", subject: "ci/builder", role: "cluster-admin" }, "a");
  const r = await UA.approveRequest(q.id, "b", {});
  assert.equal(r.status, "done");
  const left = c.store.get("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/builder-admin").subjects;
  assert.deepEqual(left.map((s) => s.namespace), ["other"]);
});
