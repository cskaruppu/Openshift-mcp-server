// Command Center: one read of everything the four acts show, from the modules
// that do the work — nothing here computes a number of its own beyond adding
// up what those modules recorded since the session started.
//
//   PRIVATE_AI_OPS=true            turns the Command Center on (launchers appear)
//   COMMAND_CENTER_BANNER=true     shows the launch banner on the dashboard
//   PRIVATE_AI_CLOUD_PRICE_PER_MTOK  cloud price per million tokens, for "cost avoided"
//   PRIVATE_AI_HARDWARE            the line in the header, e.g. "Dell PowerEdge XE9680 · 2× NVIDIA H100"

import { ocpFetch, ocpPost, ocpDelete } from "../../utils/openshift-client.js";
import * as router from "./router.js";
import { embeddingModel, embeddingStats } from "./embeddings.js";
import { scenarioStatus } from "./scenario.js";
import { batchStatus } from "./vm-batch.js";

const EGRESS_POLICY = "tcs-private-ai-no-internet";
const ns = () => process.env.MCP_NAMESPACE || process.env.NAMESPACE || "openshift-mcp";

let _session = { since: new Date().toISOString(), egressBlockedAt: null };
let _deps = { runForCluster: (_c, fn) => fn(), gpu: null, scanSummary: null, remediations: null, ocp: null };
const O = () => _deps.ocp || { fetch: ocpFetch, post: ocpPost, del: ocpDelete };
export function configureCommandCenter(deps) { _deps = { ..._deps, ...deps }; }

export function commandCenterEnabled() { return process.env.PRIVATE_AI_OPS === "true"; }

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

export async function egressStatus({ cluster = "local" } = {}) {
  try {
    const p = await _deps.runForCluster(cluster, () => O().fetch(`/apis/networking.k8s.io/v1/namespaces/${ns()}/networkpolicies/${EGRESS_POLICY}`));
    return { blocked: true, since: p.metadata?.creationTimestamp || _session.egressBlockedAt, policy: EGRESS_POLICY, namespace: ns() };
  } catch (e) {
    return { blocked: false, since: null, policy: EGRESS_POLICY, namespace: ns(), error: /404/.test(e.message) ? null : e.message };
  }
}

export async function setEgress(block, { cluster = "local" } = {}) {
  await _deps.runForCluster(cluster, async () => {
    if (block) {
      try { await O().post(`/apis/networking.k8s.io/v1/namespaces/${ns()}/networkpolicies`, egressPolicy()); }
      catch (e) { if (!/409/.test(e.message)) throw e; }
      _session.egressBlockedAt = new Date().toISOString();
    } else {
      try { await O().del(`/apis/networking.k8s.io/v1/namespaces/${ns()}/networkpolicies/${EGRESS_POLICY}`); }
      catch (e) { if (!/404/.test(e.message)) throw e; }
      _session.egressBlockedAt = null;
    }
  });
  return egressStatus({ cluster });
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
    egressStatus({ cluster }),
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
    banner: process.env.COMMAND_CENTER_BANNER === "true",
    hardware: process.env.PRIVATE_AI_HARDWARE || null,
    session: { ..._session },
    act1: {
      routerOn: router.routerEnabled(), models, embed: embedModel ? { ...embedModel, stats: embeddingStats() } : null,
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
