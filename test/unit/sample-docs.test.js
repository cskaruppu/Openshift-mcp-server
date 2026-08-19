import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdownText } from "../../src/services/doc-parser.js";
import { extractAIS } from "../../src/services/ais-extractor.js";
import { generateManifests } from "../../src/services/manifest-generator.js";

// The sample requirement documents are shipped as KNOWN-GOOD inputs. These
// tests pin the whole chain — markdown → deterministic extraction → manifest
// generation — so a change to the extractor or generator that would silently
// break the samples breaks the build instead. No LLM is configured in the
// test environment: if extraction falls back to the LLM, these fail, which is
// exactly the guarantee the documents promise (deterministic, every time).

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/sample-requirements");
const load = async (f) => {
  const parsed = parseMarkdownText(readFileSync(resolve(DOCS, f), "utf8"));
  const { intent } = await extractAIS(parsed);
  return intent;
};
const byKind = (manifests, kind) => manifests.filter((m) => m.kind === kind);
const named = (manifests, kind, name) => manifests.find((m) => m.kind === kind && m.name === name);

// Walk every NetworkPolicy peer and reject the two classic invalids:
// an empty peer object (API server refuses it) and string ports.
function assertPoliciesValid(manifests) {
  for (const np of byKind(manifests, "NetworkPolicy")) {
    for (const dir of ["ingress", "egress"]) {
      for (const rule of np.json.spec[dir] || []) {
        for (const peer of rule.from || rule.to || []) {
          assert.ok(Object.keys(peer).length > 0, `${np.name}: empty peer is invalid`);
        }
        for (const p of rule.ports || []) {
          assert.equal(typeof p.port, "number", `${np.name}: port must be numeric, got ${JSON.stringify(p.port)}`);
        }
      }
    }
  }
}

test("01-hello-web extracts deterministically and generates a working baseline", async () => {
  const intent = await load("01-hello-web.md");
  assert.equal(intent.appName, "hello-web");
  assert.equal(intent.namespace, "demo-hello-web");
  assert.equal(intent.tiers.length, 1);
  const web = intent.tiers[0];
  assert.equal(web.name, "web");
  assert.equal(web.image, "docker.io/nginxinc/nginx-unprivileged:1.27");
  assert.equal(web.port, 8080);
  assert.equal(web.replicas.min, 2);
  assert.equal(web.expose, true);
  assert.equal(web.tls, "edge");
  assert.ok(web.probes.liveness && web.probes.readiness);

  const { manifests } = generateManifests(intent);
  assert.ok(named(manifests, "Route", "web").json.spec.tls.termination === "edge");
  // No matrix in the doc → the documented OpenShift baseline, not a dead namespace.
  assert.ok(named(manifests, "NetworkPolicy", "default-deny-all"));
  assert.ok(named(manifests, "NetworkPolicy", "allow-dns-egress"));
  assert.ok(named(manifests, "NetworkPolicy", "allow-same-namespace"));
  assert.ok(named(manifests, "NetworkPolicy", "allow-external-to-web"));
  assertPoliciesValid(manifests);
});

test("02-three-tier-orders: full extraction — tiers, secret, configmap, storage, HPA, matrix", async () => {
  const intent = await load("02-three-tier-orders.md");
  assert.equal(intent.appName, "orders");
  assert.equal(intent.namespace, "demo-orders");
  assert.deepEqual(intent.deployOrder, ["db", "api", "web"]);
  assert.deepEqual(intent.tiers.map((t) => t.name).sort(), ["api", "db", "web"]);

  const db = intent.tiers.find((t) => t.name === "db");
  assert.equal(db.role, "database");
  assert.equal(db.image, "quay.io/sclorg/postgresql-15-c9s:latest");
  assert.equal(db.storage.size, "2Gi");
  assert.equal(db.storage.mountPath, "/var/lib/pgsql/data");
  assert.match(db.initSql, /CREATE TABLE IF NOT EXISTS orders/);
  // Credential env comes from the shared secret, not inline values.
  const pgUser = db.envVars.find((e) => e.name === "POSTGRESQL_USER");
  assert.equal(pgUser.fromSecret, "db-credentials");
  assert.equal(pgUser.secretKey, "username");

  const api = intent.tiers.find((t) => t.name === "api");
  assert.equal(api.replicas.min, 2);
  assert.equal(api.replicas.max, 4);
  assert.equal(api.envVars.find((e) => e.name === "HTTP_PORT")?.value, "8080");
  assert.equal(api.envVars.find((e) => e.name === "DATABASE_PASSWORD")?.fromSecret, "db-credentials");

  assert.equal(intent.sharedSecrets.length, 1);
  assert.deepEqual(intent.sharedSecrets[0].keys, ["username", "password", "database"]);
  assert.equal(intent.configMaps.length, 1);
  assert.equal(intent.configMaps[0].data.APP_MODE, "demo");
  // 4 rows in the matrix, one of them explicitly denied.
  assert.equal(intent.networkPolicies.length, 4);
  assert.equal(intent.networkPolicies.filter((r) => r.allowed).length, 3);
  assert.ok(intent.validationTests.length >= 3);
});

test("02-three-tier-orders: generated manifests honour the contract in both directions", async () => {
  const intent = await load("02-three-tier-orders.md");
  const { manifests } = generateManifests(intent);

  // Storage, secret, autoscaling, exposure
  assert.ok(named(manifests, "PersistentVolumeClaim", "db-data"));
  const secret = named(manifests, "Secret", "db-credentials");
  assert.deepEqual(Object.keys(secret.json.data).sort(), ["database", "password", "username"]);
  const hpa = named(manifests, "HorizontalPodAutoscaler", "api-hpa") || byKind(manifests, "HorizontalPodAutoscaler")[0];
  assert.ok(hpa, "API tier with min<max replicas must produce an HPA");
  assert.ok(named(manifests, "Route", "web"));
  assert.equal(named(manifests, "Route", "db"), undefined, "database must not be exposed");

  // The init Job: labelled so network policies can select it, SQL via env so
  // quoting in the schema can never break the shell command.
  const job = named(manifests, "Job", "db-init");
  const tpl = job.json.spec.template;
  assert.equal(tpl.metadata.labels.app, "db");
  const initEnv = tpl.spec.containers[0].env.find((e) => e.name === "INIT_SQL");
  assert.match(initEnv.value, /sample-widget/);
  assert.match(tpl.spec.containers[0].command[2], /"\$INIT_SQL"/);
  assert.equal(tpl.spec.containers[0].env.filter((e) => e.name === "PGPASSWORD").length, 1);

  // The matrix, both directions: ingress on the target, egress on the caller.
  assert.ok(named(manifests, "NetworkPolicy", "allow-web-to-api"));
  assert.ok(named(manifests, "NetworkPolicy", "allow-egress-web-to-api"));
  assert.ok(named(manifests, "NetworkPolicy", "allow-api-to-db"));
  assert.ok(named(manifests, "NetworkPolicy", "allow-egress-api-to-db"));
  // The init Job's self-traffic pair.
  assert.ok(named(manifests, "NetworkPolicy", "allow-db-to-db"));
  assert.ok(named(manifests, "NetworkPolicy", "allow-egress-db-to-db"));
  // Preconditions and exposure.
  assert.ok(named(manifests, "NetworkPolicy", "default-deny-all"));
  assert.ok(named(manifests, "NetworkPolicy", "allow-dns-egress"));
  assert.ok(named(manifests, "NetworkPolicy", "allow-external-to-web"));
  // The internet rule admits any source by omitting `from` entirely.
  const inet = named(manifests, "NetworkPolicy", "allow-internet-to-web");
  assert.ok(inet);
  assert.equal(inet.json.spec.ingress[0].from, undefined);
  // A matrix is present → no blanket same-namespace allow.
  assert.equal(named(manifests, "NetworkPolicy", "allow-same-namespace"), undefined);
  // The denied row generates nothing that would allow it.
  assert.equal(byKind(manifests, "NetworkPolicy").some((np) => /internet.*db|db.*internet/.test(np.name) && np.name !== "allow-internet-to-web" && np.name.includes("internet")), false);

  assertPoliciesValid(manifests);
});

test("03-negative-broken-image extracts cleanly — the failure belongs to the cluster, not the parser", async () => {
  const intent = await load("03-negative-broken-image.md");
  assert.equal(intent.namespace, "demo-negative");
  assert.equal(intent.tiers.length, 1);
  assert.match(intent.tiers[0].image, /1\.99-does-not-exist/);
  const { manifests } = generateManifests(intent);
  assert.ok(named(manifests, "Deployment", "web"));
  assertPoliciesValid(manifests);
});
