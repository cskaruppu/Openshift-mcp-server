// Private AI fleet: several GPU clusters, each with its own models.
//
// Every GPU cluster keeps its own list of connected models, found in OpenShift
// AI on that cluster (InferenceServices + their Routes), so connecting one
// cluster never replaces another's. The router uses all of them:
//
//   routing   whether a cluster's models answer at all
//   sensitive whether requests with secrets / personal data may go there
//             (data residency: switch off for a cluster outside the allowed region)
//   mode      "preferred": the selected GPU cluster first, others on failure
//             "least-loaded": the cluster whose model has the fewest requests running
//
// The models enable.sh sets in the environment still work and are attributed to
// the selected GPU cluster. Stored like the other Private AI settings: kv_store,
// with a JSON file fallback.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { query as dbQuery, isEnabled as dbEnabled } from "../../utils/db.js";

const DB_KEY = "private_ai_fleet";
const FILE_PATH = process.env.PRIVATE_AI_FLEET_PATH || "/data/mcp-private-ai-fleet.json";
const MODELS_NS = () => process.env.PRIVATE_AI_MODELS_NAMESPACE || "openshift-mcp";
const ROLE_LABEL = { large: "Reasoning", small: "Fast answers", vision: "Vision", coder: "Code and YAML", embed: "Incident memory" };

let _fleet = { mode: "preferred", clusters: {} };
let _deps = { runForCluster: (_c, fn) => fn(), ocp: null, gpu: null, preferred: () => null, accessClusters: () => [], label: (c) => c };
export function configureFleet(deps) { _deps = { ..._deps, ...deps }; }

/* ─────────────────────────── storage ─────────────────────────── */

export async function restoreFleet() {
  try {
    if (await dbEnabled()) {
      const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [DB_KEY]);
      let v = r?.rows?.[0]?.value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
      if (v && typeof v === "object") { _fleet = { mode: "preferred", clusters: {}, ...v }; return; }
    }
  } catch { /* fall through */ }
  try { const v = JSON.parse(await readFile(FILE_PATH, "utf8")); if (v && typeof v === "object") _fleet = { mode: "preferred", clusters: {}, ...v }; } catch { /* nothing stored */ }
}

async function persist() {
  try {
    if (await dbEnabled()) {
      await dbQuery(`INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`, [DB_KEY, JSON.stringify(_fleet)]);
      return "database";
    }
  } catch { /* DB optional */ }
  try { await mkdir(dirname(FILE_PATH), { recursive: true }).catch(() => {}); await writeFile(FILE_PATH, JSON.stringify(_fleet, null, 2), "utf8"); return "file"; }
  catch { return "memory"; }
}
export function _resetFleet() { _fleet = { mode: "preferred", clusters: {} }; }

const validCluster = (c) => typeof c === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(c);
const policyOf = (c) => ({ routing: true, sensitive: true, region: "", ...(_fleet.clusters[c]?.policy || {}) });

/* ─────────────────────────── what the router reads ─────────────────────────── */

/** Every discovered model on every cluster, with that cluster's policy. */
export function fleetModels() {
  const out = [];
  for (const [cluster, c] of Object.entries(_fleet.clusters)) {
    const pol = policyOf(cluster);
    for (const m of c.models || []) out.push({ ...m, cluster, routing: pol.routing, sensitiveOk: pol.sensitive, region: pol.region });
  }
  return out;
}
export function routingMode() { return _fleet.mode === "least-loaded" ? "least-loaded" : "preferred"; }
export function preferredCluster() { return _deps.preferred() || null; }

/* ─────────────────────────── discovery ─────────────────────────── */

/** What a model is for, from its annotation or its name. */
export function inferRole(name, annotations = {}) {
  const set = annotations["tcs.com/role"];
  if (set && ROLE_LABEL[set]) return set;
  const n = String(name || "").toLowerCase();
  if (/embed|bge|\be5\b|gte|minilm|nomic/.test(n)) return "embed";
  if (/-vl\b|-vl-|vision|llava|pixtral|qwen.*vl|idefics/.test(n)) return "vision";
  if (/coder|starcoder|codellama|code-/.test(n)) return "coder";
  const size = Number((n.match(/(\d+(?:\.\d+)?)b\b/) || [])[1]);
  if (Number.isFinite(size) && size >= 30) return "large";
  return "small";
}

/** The port a Route must name to reach a Service's pods. On a Route a number means the
    pod port (not the Service port), so use the port's name, else the pod port. */
export function routePort(svc) {
  const p = svc?.spec?.ports?.[0];
  if (!p) return null;
  return p.name || p.targetPort || p.port || null;
}

/** Whether a Route's port reaches one of the Service's pods. No port: the router picks one. */
export function routeMatches(route, svc) {
  const want = route?.spec?.port?.targetPort;
  if (want == null || want === "") return true;
  return (svc?.spec?.ports || []).some((p) => p.name === want || String(p.targetPort ?? p.port) === String(want));
}

/* Self-repair: when a model answers 502/503 through its Route, look at that cluster's
   Routes again (at most every two minutes per cluster) and fix the ones that are wrong. */
const HEAL_EVERY_MS = 120000;
const _heal = new Map();   // cluster → { at, notes: [] }
export async function healRoutes(cluster) {
  if (!validCluster(cluster)) return null;
  const last = _heal.get(cluster);
  if (last && Date.now() - last.at < HEAL_EVERY_MS) return last;
  const cur = { at: Date.now(), notes: [], running: true };
  _heal.set(cluster, cur);
  try {
    const r = await discoverModels(cluster, { actor: "self-repair" });
    cur.notes = r.models.filter((m) => m.routeNote).map((m) => ({ model: m.model, note: m.routeNote }));
    if (cur.notes.length) console.error(`[private-ai] ${cluster}: ${cur.notes.map((n) => `${n.model}: ${n.note}`).join("; ")}`);
  } catch (e) { cur.error = e.message; }
  cur.running = false;
  return cur;
}
export function healStatus(cluster) { return _heal.get(cluster) || null; }
export function _resetHeal() { _heal.clear(); }

/** Find the OpenShift AI models on one cluster and remember the running ones (with their Route URLs).
    Models stopped in OpenShift AI are listed but not used; discover again after starting them. */
export async function discoverModels(cluster, { actor = "admin", expose = true } = {}) {
  if (!validCluster(cluster)) throw Object.assign(new Error("Not a valid cluster"), { status: 400 });
  const ns = MODELS_NS();
  const found = await _deps.runForCluster(cluster, async () => {
    const isvcs = (await _deps.ocp.fetch(`/apis/serving.kserve.io/v1beta1/namespaces/${ns}/inferenceservices`)).items || [];
    const routes = await _deps.ocp.fetch(`/apis/route.openshift.io/v1/namespaces/${ns}/routes`).then((r) => r.items || []).catch(() => []);
    const services = await _deps.ocp.fetch(`/api/v1/namespaces/${ns}/services`).then((r) => r.items || []).catch(() => []);
    const out = [];
    for (const i of isvcs) {
      const name = i.metadata.name;
      const svc = services.find((x) => x.metadata?.name === `${name}-predictor`) || null;
      const port = routePort(svc);
      let route = routes.find((r) => r.metadata.name === name || r.spec?.to?.name === `${name}-predictor`);
      let routeNote = null;
      if (!route && expose) {
        try {
          route = await _deps.ocp.post(`/apis/route.openshift.io/v1/namespaces/${ns}/routes`, {
            apiVersion: "route.openshift.io/v1", kind: "Route",
            metadata: { name, namespace: ns, labels: { "tcs.com/demo": "private-ai-ops" } },
            spec: { to: { kind: "Service", name: `${name}-predictor` }, ...(port != null ? { port: { targetPort: port } } : {}) },
          });
        } catch { /* no permission to create Routes: listed, not reachable */ }
      } else if (route && svc && !routeMatches(route, svc) && port != null) {
        // The Route names a port the model's pods do not have, so the router answers 503
        // (OpenShift AI can recreate the predictor Service with another port name).
        const was = route.spec.port.targetPort;
        try {
          if (!_deps.ocp.patch) throw new Error("no patch");
          await _deps.ocp.patch(`/apis/route.openshift.io/v1/namespaces/${ns}/routes/${route.metadata.name}`, { spec: { port: { targetPort: port } } }, "application/merge-patch+json");
          routeNote = `Route port ${was} → ${port} (repaired)`;
        } catch {
          routeNote = `Route points at port ${was}, the model serves on ${port}: allow "patch" on routes (re-apply gpu-cluster-access.yaml) or run enable.sh`;
        }
      }
      const host = route?.spec?.host || null;
      const tls = !!route?.spec?.tls;
      const role = inferRole(name, i.metadata.annotations || {});
      out.push({
        model: name, role, label: ROLE_LABEL[role],
        url: host ? `${tls ? "https" : "http"}://${host}` : null,
        healthPath: role === "embed" ? "/health" : undefined,
        ready: (i.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True"),
        stopped: i.metadata.annotations?.["serving.kserve.io/stop"] === "true",
        ...(routeNote ? { routeNote } : {}),
      });
    }
    return out;
  });
  _fleet.clusters[cluster] = { ...(_fleet.clusters[cluster] || {}), models: found.filter((m) => m.url && !m.stopped).map(({ ready: _r, stopped: _s, routeNote: _n, ...m }) => m),
    discoveredAt: new Date().toISOString(), discoveredBy: actor };
  const storage = await persist();
  return { cluster, models: found, storage };
}

export async function setClusterPolicy(cluster, patch = {}) {
  if (!validCluster(cluster)) throw Object.assign(new Error("Not a valid cluster"), { status: 400 });
  const cur = policyOf(cluster);
  const next = {
    routing: typeof patch.routing === "boolean" ? patch.routing : cur.routing,
    sensitive: typeof patch.sensitive === "boolean" ? patch.sensitive : cur.sensitive,
    region: typeof patch.region === "string" ? patch.region.replace(/[^\p{L}\p{N} .,()/-]/gu, "").slice(0, 40) : cur.region,
  };
  _fleet.clusters[cluster] = { ...(_fleet.clusters[cluster] || { models: [] }), policy: next };
  return { cluster, policy: next, storage: await persist() };
}

export async function setRoutingMode(mode) {
  if (!["preferred", "least-loaded"].includes(mode)) throw Object.assign(new Error("Mode is preferred or least-loaded"), { status: 400 });
  _fleet.mode = mode;
  return { mode, storage: await persist() };
}

export async function forgetCluster(cluster) {
  delete _fleet.clusters[cluster];
  return { cluster, storage: await persist() };
}

/* ─────────────────────────── fleet overview ─────────────────────────── */

/** The GPU clusters the Factory knows: with saved access, with discovered models, and the selected one. */
export function fleetClusters() {
  const pref = preferredCluster();
  return [...new Set([...(pref ? [pref] : []), ..._deps.accessClusters(), ...Object.keys(_fleet.clusters)])].filter((c) => c && c !== "local");
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

async function clusterSummary(cluster, models) {
  const g = await withTimeout(_deps.runForCluster(cluster, () => _deps.gpu()), 15000, "GPU read").catch((e) => ({ available: false, reason: e.message }));
  const gpus = g.gpus || [];
  const cards = gpus.length || g.summary?.totalGpus || 0;
  const memTot = gpus.reduce((a, x) => a + (x.memTotalMiB || 0), 0);
  const memUsed = gpus.reduce((a, x) => a + (x.memUsedMiB || 0), 0);
  const util = gpus.filter((x) => x.utilPct != null);
  const mine = models.filter((m) => m.cluster === cluster);
  return {
    cluster, label: _deps.label(cluster), preferred: cluster === preferredCluster(), policy: policyOf(cluster),
    cards, gpuModel: (gpus[0]?.model || g.summary?.models?.[0] || "").replace(/NVIDIA\s*/i, "").split(" ")[0] || null,
    nodes: g.summary?.nodes ?? null,
    avgUtilPct: util.length ? Math.round(util.reduce((a, x) => a + x.utilPct, 0) / util.length) : null,
    memUsedPct: memTot ? Math.round((memUsed / memTot) * 100) : null, memTotalMiB: memTot || null,
    powerW: gpus.some((x) => x.powerW != null) ? Math.round(gpus.reduce((a, x) => a + (x.powerW || 0), 0)) : null,
    telemetry: gpus.length ? "ok" : g.telemetry || (g.available === false ? "unavailable" : "inventory"),
    reason: gpus.length ? null : g.reason || g.telemetryReason || g.message || null,
    models: mine.map((m) => ({ model: m.model, role: m.role, ready: m.ready, url: m.url })),
    discoveredAt: _fleet.clusters[cluster]?.discoveredAt || null,
  };
}

/** One tile per GPU cluster plus fleet totals. `models` = the router's models with health. */
export async function fleetState(models = []) {
  const list = fleetClusters();
  const clusters = await Promise.all(list.map((c) => clusterSummary(c, models)));
  const sumOf = (k) => clusters.reduce((a, c) => a + (c[k] || 0), 0);
  const memTot = sumOf("memTotalMiB");
  return {
    mode: routingMode(), preferred: preferredCluster(), clusters,
    totals: {
      clusters: clusters.length, cards: sumOf("cards"),
      models: models.length, modelsReady: models.filter((m) => m.ready).length,
      powerW: clusters.some((c) => c.powerW != null) ? sumOf("powerW") : null,
      memUsedPct: memTot ? Math.round(clusters.reduce((a, c) => a + ((c.memUsedPct || 0) / 100) * (c.memTotalMiB || 0), 0) / memTot * 100) : null,
    },
  };
}
