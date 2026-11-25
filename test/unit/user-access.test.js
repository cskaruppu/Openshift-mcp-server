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
  const listOf = (prefix, depth) => ({ items: [...store.entries()].filter(([k]) => k.startsWith(prefix) && k.slice(prefix.length).split("/").length === depth).map(([, v]) => v) });
  const notFound = () => { throw new Error("OCP API 404: not found"); };
  const ocp = {
    fetch: async (path) => {
      if (path === "/apis/user.openshift.io/v1/users") return listOf("/apis/user.openshift.io/v1/users/", 1);
      if (path === "/apis/user.openshift.io/v1/groups") return listOf("/apis/user.openshift.io/v1/groups/", 1);
      if (path === "/apis/user.openshift.io/v1/identities") return { items: [] };
      if (path === "/apis/oauth.openshift.io/v1/oauthaccesstokens") return { items: tokens };
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
  assert.deepEqual(a.people.rahul.grants, [{ role: "cluster-admin", scope: "cluster", via: "platform-admins" }]);
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
