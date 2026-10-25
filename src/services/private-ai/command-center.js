// Command Center: one read of everything the four acts show, from the modules
// that do the work — nothing here computes a number of its own beyond adding
// up what those modules recorded since the session started.
//
//   PRIVATE_AI_OPS=true            Command Center on by default (Settings → Private AI can change it;
//                                  PRIVATE_AI_OPS=false switches it off for good)
//   COMMAND_CENTER_BANNER=true     launch banner on the dashboard by default
//   PRIVATE_AI_CLOUD_PRICE_PER_MTOK  cloud price per million tokens, for "cost avoided"
//   PRIVATE_AI_HARDWARE            the line in the header, e.g. "Dell PowerEdge XE9680 · 2× NVIDIA H100"

import { ocpFetch, ocpPost, ocpDelete } from "../../utils/openshift-client.js";
import * as router from "./router.js";
import { embeddingModel, embeddingStats } from "./embeddings.js";
import { scenarioStatus } from "./scenario.js";
import { batchStatus } from "./vm-batch.js";
import { effectiveSettings, clusterAccessSummary } from "./settings.js";
import { expiryText } from "./access.js";

const EGRESS_POLICY = "tcs-private-ai-no-internet";
const ns = () => process.env.MCP_NAMESPACE || process.env.NAMESPACE || "openshift-mcp";

let _session = { since: new Date().toISOString(), egressBlockedAt: null };
let _deps = { runForCluster: (_c, fn) => fn(), gpu: null, scanSummary: null, remediations: null, ocp: null };
const O = () => _deps.ocp || { fetch: ocpFetch, post: ocpPost, del: ocpDelete };
export function configureCommandCenter(deps) { _deps = { ..._deps, ...deps }; }

export function commandCenterEnabled() { return effectiveSettings().commandCenter; }

export function startSession() {
  router.resetTraffic();
  _session = { since: new Date().toISOString(), egressBlockedAt: _session.egressBlockedAt };
  return _session;
}

/* ─────────────────────────── egress ─────────────────────────── */

// Allow the platform to reach the cluster and private networks only: the API
// server, DNS, the model endpoints and the database are all on private ranges,
// the public internet is not. Adjust the ranges if your cluster uses public IPs
// internally.
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];

export function egressPolicy() {
  return {
    apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
    metadata: { name: EGRESS_POLICY, namespace: ns(), labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai", "tcs.com/purpose": "private-ai-no-internet" } },
    spec: {
      podSelector: {},
      policyTypes: ["Egress"],
      egress: [{ to: PRIVATE_RANGES.map((cidr) => ({ ipBlock: { cidr } })) }, { to: [{ namespaceSelector: {} }] }],
    },
  };
}

// Always the platform's own namespace on the hub — whichever cluster has the GPUs.
export async function egressStatus() {
  try {
    const p = await O().fetch(`/apis/networking.k8s.io/v1/namespaces/${ns()}/networkpolicies/${EGRESS_POLICY}`);
    return { blocked: true, since: p.metadata?.creationTimestamp || _session.egressBlockedAt, policy: EGRESS_POLICY, namespace: ns() };
  } catch (e) {
    return { blocked: false, since: null, policy: EGRESS_POLICY, namespace: ns(), error: /404/.test(e.message) ? null : e.message };
  }
}

export async function setEgress(block) {
  if (block) {
    try { await O().post(`/apis/networking.k8s.io/v1/namespaces/${ns()}/networkpolicies`, egressPolicy()); }
    catch (e) { if (!/409/.test(e.message)) throw e; }
    _session.egressBlockedAt = new Date().toISOString();
  } else {
    try { await O().del(`/apis/networking.k8s.io/v1/namespaces/${ns()}/networkpolicies/${EGRESS_POLICY}`); }
    catch (e) { if (!/404/.test(e.message)) throw e; }
    _session.egressBlockedAt = null;
  }
  return egressStatus();
}

/* ─────────────────────────── the read ─────────────────────────── */

export async function commandCenterState({ cluster = "local" } = {}) {
  const list = router.models();
  const embed = embeddingModel();
  const healthOf = async (m) => ({ ...m, health: await router.checkHealth(m) });
  const [models, embedModel, gpu, egress, scenario, scan, recs] = await Promise.all([
    Promise.all(list.map(healthOf)),
    embed ? healthOf(embed) : null,
    _deps.gpu ? _deps.runForCluster(cluster, () => _deps.gpu()).catch((e) => ({ available: false, reason: e.message })) : null,
    egressStatus(),
    scenarioStatus({ cluster }),
    _deps.scanSummary ? _deps.scanSummary(cluster).catch(() => null) : null,
    _deps.remediations ? _deps.remediations(cluster).catch(() => []) : [],
  ]);
  const traffic = router.trafficCounts();
  const batch = batchStatus();
  const since = new Date(_session.since).getTime();
  const recent = (recs || []).filter((r) => new Date(r.updatedAt).getTime() >= since);
  const resolved = recent.filter((r) => r.state === "resolved");
  const kevFixed = new Set();
  for (const r of resolved) for (const id of (r.verify?.fixed || [])) if ((r.plan?.items || []).find((i) => i.id === id)?.kev) kevFixed.add(id);
  const price = Number(process.env.PRIVATE_AI_CLOUD_PRICE_PER_MTOK);
  const incidentChange = scenario.session && ["resolved", "closed"].includes(scenario.session.state) ? 1 : 0;
  const changes = resolved.length + incidentChange;
  const approved = resolved.filter((r) => r.approval).length + (incidentChange && (scenario.session.history || []).some((h) => h.to === "approved") ? 1 : 0);

  return {
    enabled: commandCenterEnabled(),
    banner: effectiveSettings().banner,
    hardware: process.env.PRIVATE_AI_HARDWARE || null,
    cluster, access: accessExpiry(cluster),
    session: { ..._session },
    act1: {
      routerOn: effectiveSettings().routeChat, models, embed: embedModel ? { ...embedModel, stats: embeddingStats() } : null,
      traffic: { ...traffic, onPrem: traffic.total - traffic.cloudCalls }, log: router.trafficLog(40), gpu, egress,
    },
    act2: scenario,
    act3: { scan, remediation: recent[0] || (recs || [])[0] || null, resolved: resolved.length },
    act4: batch,
    scorecard: {
      mttrSec: scenario.resolvedAt ? scenario.elapsedSec : null,
      symptoms: scenario.session ? (scenario.session.evidence || []).length : null,
      changes, approved,
      kevFixed: kevFixed.size,
      vmsAssessed: batch.state === "done" ? batch.total : batch.done || 0, vmsElapsedMs: batch.elapsedMs || null, vmsSynthetic: !!batch.synthetic,
      aiOnPrem: traffic.total - traffic.cloudCalls, cloudCalls: traffic.cloudCalls, sensitiveKept: traffic.sensitiveKeptOnPrem,
      tokens: traffic.tokens, costAvoided: Number.isFinite(price) && price > 0 ? Math.round((traffic.tokens / 1e6) * price * 100) / 100 : null,
      egressBlockedSince: egress.blocked ? egress.since : null,
      gpuAvgUtil: gpu?.summary?.avgUtilPct ?? null,
    },
  };
}

/* ─────────────────────────── prerequisites ─────────────────────────── */

// What each switch in Settings → Private AI needs, checked live. Every check
// says what was found and, when it fails, the one thing to do about it.
const DEMO_NS = () => process.env.PRIVATE_AI_SCENARIO_NS || "tcs-demo-payments";

async function canI(verb, group, resource, namespace) {
  const r = await O().post("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", {
    apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview",
    spec: { resourceAttributes: { verb, group, resource, namespace } },
  });
  return !!r?.status?.allowed;
}

export function gpuInventory(nodes) {
  const out = { nodes: 0, gpus: 0, mig: {} };
  for (const n of nodes || []) {
    const a = n.status?.allocatable || {};
    let has = false;
    for (const [k, v] of Object.entries(a)) {
      const q = parseInt(v, 10) || 0;
      if (k === "nvidia.com/gpu" && q > 0) { out.gpus += q; has = true; }
      else if (k.startsWith("nvidia.com/mig-") && q > 0) { out.mig[k.slice("nvidia.com/mig-".length)] = (out.mig[k.slice("nvidia.com/mig-".length)] || 0) + q; has = true; }
    }
    if (has) out.nodes++;
  }
  return out;
}

/** Expiry of the saved access to `cluster`: expired / expiringSoon (< 24 h) / text. */
export function accessExpiry(cluster, now = Date.now()) {
  const a = cluster && cluster !== "local" ? clusterAccessSummary(cluster) : null;
  if (!a?.expiresAt) return { expiresAt: null, expired: false, expiringSoon: false, expiry: a?.permanent ? "does not expire" : null };
  const left = new Date(a.expiresAt).getTime() - now;
  return { expiresAt: a.expiresAt, expired: left <= 0, expiringSoon: left > 0 && left < 86400000, expiry: expiryText(a.expiresAt, now) };
}

const ACCESS = {
  local: { ok: true, detail: "The platform runs on this cluster" },
  direct: { ok: true, detail: "Direct API access (stored credentials)" },
  agent: { ok: false, detail: "Connected through its agent, which only sends reports: the hub cannot read GPUs, run the scenario or roll back there" },
  spoke: { ok: false, detail: "Connected as a spoke, which only answers the dashboard: the hub cannot run the scenario or roll back there" },
  none: { ok: false, detail: "Not connected to this platform" },
};

export async function prerequisites({ cluster = "local" } = {}) {
  const run = (fn) => _deps.runForCluster(cluster, fn);
  const list = [...router.models(), ...(embeddingModel() ? [embeddingModel()] : [])];
  const mode = cluster === "local" ? "local" : _deps.clusterAccess ? (await _deps.clusterAccess(cluster)) : "direct";
  const access = { ...(ACCESS[mode] || ACCESS.none), mode, ...accessExpiry(cluster),
    fix: ["local", "direct"].includes(mode) ? null : "Connect it for direct access below (deploy/demo/private-ai-ops/connect-gpu-cluster.sh prints the values)" };
  const saved = cluster === "local" ? null : clusterAccessSummary(cluster);
  if (saved) {
    const who = [saved.identity, saved.kind && `(${saved.kind}${saved.source === "kubeconfig" ? ", from kubeconfig" : ""})`].filter(Boolean).join(" ");
    access.detail = `Direct API access${who ? " as " + who : ""} · ${saved.expiresAt ? expiryText(saved.expiresAt) : saved.permanent ? "does not expire" : "expiry unknown"}${saved.clusterAdmin ? " · cluster-admin rights" : ""}`;
    if (access.expired) { access.ok = false; access.fix = "Renew it: re-run connect-gpu-cluster.sh (or log in again for a kubeconfig) and save the new token below"; }
    else if (access.expiringSoon) access.fix = "Expires within a day — renew before the demo: re-run connect-gpu-cluster.sh and save the new token";
    else if (saved.clusterAdmin) access.fix = "Works, but with far more rights than the demo needs — prefer connect-gpu-cluster.sh (read-only + the demo namespace)";
  }
  // A failed call through stored credentials comes back as "not reachable":
  // say what is worth checking instead of the internal wording.
  const why = (e) => (/not reachable/i.test(e.message) ? `the hub could not call ${cluster}'s API — check the URL, token and CA in Cluster access` : e.message);
  const blocked = { ok: false, detail: "Needs cluster access first", fix: null };

  const gpu = !access.ok ? blocked : run(async () => {
    const items = (await O().fetch("/api/v1/nodes")).items;
    const inv = gpuInventory(items);
    // Physical cards, the way the cluster card counts them: time-slicing advertises
    // each card many times over (4 cards shared 10 ways = 40 "GPUs").
    const { computeFromNodes } = await import("../cluster-compute.js");
    const hw = computeFromNodes(items);
    const replicas = Math.max(1, ...items.map((n) => parseInt(n.metadata?.labels?.["nvidia.com/gpu.replicas"], 10) || 1));
    const mig = Object.entries(inv.mig).map(([p, n]) => `${n}× ${p}`).join(" · ");
    const ok = hw.gpus + Object.values(inv.mig).reduce((s, n) => s + n, 0) > 0;
    const parts = [hw.gpus ? `${hw.gpus}× ${hw.gpuModel || "GPU"}` : null, replicas > 1 ? `time-sliced ×${replicas} (${inv.gpus} shares)` : null, mig ? `MIG ${mig}` : null].filter(Boolean);
    return { ok, detail: ok ? `${parts.join(" · ")} on ${inv.nodes} node${inv.nodes > 1 ? "s" : ""}` : "No NVIDIA GPUs offered by any node",
      fix: ok ? null : "Install the NVIDIA GPU Operator", inventory: { ...inv, physical: hw.gpus, replicas } };
  }).catch((e) => ({ ok: false, detail: `Could not read nodes: ${why(e)}`, fix: null }));

  // Models are called by the platform itself, so this check runs from here whatever the cluster.
  const models = Promise.all(list.map(async (m) => ({ role: m.role, model: m.model, gpu: m.gpu, health: await router.checkHealth(m) }))).then((ms) => {
    const ready = ms.filter((m) => m.health?.ok);
    const chatReady = ready.some((m) => m.role === "large" || m.role === "small");
    return {
      ok: ms.length > 0 && ready.length === ms.length, chatReady, ready: ready.length, total: ms.length, models: ms,
      detail: ms.length ? `${ready.length}/${ms.length} ready · ${ms.map((m) => `${m.model}${m.health?.ok ? "" : " (not answering)"}`).join(", ")}` : "No models connected to the platform",
      fix: !ms.length ? `Deploy the models (oc apply -k deploy/demo/private-ai-ops/models) and connect them: ./enable.sh${cluster === "local" ? "" : " --models-context <" + cluster + " context>"}`
        : ready.length < ms.length ? "Check the InferenceServices (oc -n tcs-private-ai get inferenceservice) and that the platform can reach their URLs" : null,
    };
  });

  const demo = !access.ok ? blocked : scenarioStatus({ cluster }).then((s) => ({
    ok: !!s.live?.installed,
    detail: s.live?.installed ? `${s.deployment} in ${s.namespace} · ${s.live.ready}/${s.live.replicas} ready`
      : /Not installed/.test(s.live?.error || "Not installed") ? `${DEMO_NS()} not found` : `Could not check: ${why({ message: s.live.error })}`,
    fix: s.live?.installed ? null : `oc apply -f deploy/demo/private-ai-ops/scenario-payments.yaml${cluster === "local" ? "" : " (on " + cluster + ")"}`,
  })).catch((e) => ({ ok: false, detail: why(e), fix: null }));

  // The scenario and the rollback act on the GPU cluster; the internet switch on the platform's own namespace.
  const perms = Promise.all([
    access.ok ? run(() => canI("patch", "apps", "deployments", DEMO_NS())).then((ok) => [`patch deployments in ${DEMO_NS()}${cluster === "local" ? "" : " on " + cluster}`, ok]).catch(() => [`patch deployments in ${DEMO_NS()} (could not check)`, false]) : null,
    canI("create", "networking.k8s.io", "networkpolicies", ns()).then((ok) => [`create network policies in ${ns()}`, ok]),
    canI("delete", "networking.k8s.io", "networkpolicies", ns()).then((ok) => [`delete network policies in ${ns()}`, ok]),
  ].filter(Boolean)).then((checks) => {
    const missing = checks.filter(([, ok]) => !ok).map(([what]) => what);
    const gpuSide = missing.some((m) => m.startsWith("patch"));
    return { ok: access.ok && !missing.length, detail: missing.length ? `Missing: ${missing.join(", ")}` : access.ok ? "Can run the scenario, roll back and cut the internet" : "Internet switch OK; the rest needs cluster access first",
      fix: !missing.length ? null : gpuSide && cluster !== "local" ? "Run deploy/demo/private-ai-ops/connect-gpu-cluster.sh (grants the demo namespace) and re-apply the platform RBAC on the hub"
        : "Re-apply deploy/dashboard/manifests/serviceaccount.yaml (or the Helm chart) and bind the remediator role in the demo namespace" };
  }).catch((e) => ({ ok: false, detail: `Could not check: ${e.message}`, fix: null }));

  const [g, m, d, p] = await Promise.all([gpu, models, demo, perms]);
  return { checkedAt: new Date().toISOString(), cluster, access, gpu: g, models: m, demo: d, permissions: p };
}
