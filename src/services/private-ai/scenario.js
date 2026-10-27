// Act 2 scenario engine: a real fault on a real workload, repeatable, with a
// one-click reset.
//
// The demo workload is deploy/demo/private-ai-ops/scenario-payments.yaml
// (applied once by an operator). "Inject" rolls out a new revision that mounts
// a config nginx rejects — a bad release. From there nothing is staged: the
// platform's own incident detector must see the crash loop, the orchestrator
// writes the RCA, raises the ticket, plans the fix (rollback of the bad
// revision) and waits for a person to approve it. The clock runs from the
// moment the fault is injected to the moment the incident is verified fixed.
//
// Reset restores revision-1's config whatever state the incident is in.

import { registerPart, changed } from "./persist.js";
import { ocpFetch, ocpPatch } from "../../utils/openshift-client.js";

export const NS = process.env.PRIVATE_AI_SCENARIO_NS || "tcs-demo-payments";
const DEP = "payments-api";
const GOOD = "payments-api-config";
const BAD = "payments-api-config-v2";
const WATCH_MS = 10000;
const WATCH_LIMIT_MS = 30 * 60000;

let _state = { phase: "idle", faultAt: null, sessionId: null, detectedAt: null, resolvedAt: null, by: null, log: [] };
let _timer = null;
let _deps = { runForCluster: (_c, fn) => fn(), detect: null, promote: null, getSession: null, ocp: null };
const O = () => _deps.ocp || { fetch: ocpFetch, patch: ocpPatch };

export function configureScenario(deps) { _deps = { ..._deps, ...deps }; }

function note(text) {
  _state.log.push({ at: new Date().toISOString(), text });
  if (_state.log.length > 40) _state.log.shift();
  changed();
}

async function readDeployment() {
  return O().fetch(`/apis/apps/v1/namespaces/${NS}/deployments/${DEP}`);
}

/** Where the demo workload stands, plus the live incident session. */
export async function scenarioStatus({ cluster = "local" } = {}) {
  const live = await _deps.runForCluster(cluster, async () => {
    try {
      const d = await readDeployment();
      const vol = (d.spec?.template?.spec?.volumes || []).find((v) => v.name === "config");
      const st = d.status || {};
      return {
        installed: true,
        revision: Number(d.metadata?.annotations?.["deployment.kubernetes.io/revision"] || 0),
        release: d.spec?.template?.metadata?.annotations?.["tcs.com/release"] || null,
        config: vol?.configMap?.name || null,
        replicas: d.spec?.replicas ?? 0, ready: st.readyReplicas || 0, updated: st.updatedReplicas || 0, unavailable: st.unavailableReplicas || 0,
      };
    } catch (e) {
      return { installed: false, error: /404/.test(e.message) ? `Not installed — apply deploy/demo/private-ai-ops/scenario-payments.yaml` : e.message };
    }
  }).catch((e) => ({ installed: false, error: e.message }));
  let session = null;
  if (_state.sessionId && _deps.getSession) {
    try { session = await _deps.getSession(_state.sessionId); } catch { session = null; }
  }
  const resolvedAt = _state.resolvedAt || (session && ["resolved", "closed"].includes(session.state) ? (session.history || []).find((h) => h.to === "resolved")?.at || session.updatedAt : null);
  if (resolvedAt && !_state.resolvedAt) { _state.resolvedAt = resolvedAt; _state.phase = "resolved"; note("Incident verified fixed"); stopWatch(); }
  const end = _state.resolvedAt ? new Date(_state.resolvedAt).getTime() : Date.now();
  return {
    namespace: NS, deployment: DEP, live, phase: _state.phase,
    faultAt: _state.faultAt, detectedAt: _state.detectedAt, resolvedAt: _state.resolvedAt, by: _state.by,
    elapsedSec: _state.faultAt ? Math.max(0, Math.round((end - new Date(_state.faultAt).getTime()) / 1000)) : null,
    session: session ? {
      id: session.id, state: session.state, title: session.title, severity: session.severity, signal: session.signal,
      incidentNumber: session.incidentNumber, rca: session.rca, remediation: session.remediation, verification: session.verification,
      history: session.history, evidence: (session.evidence || []).slice(0, 8),
    } : null,
    log: _state.log.slice().reverse(),
  };
}

/** Roll out the bad release. */
export async function injectFault({ cluster = "local", actor = "presenter" } = {}) {
  if (_state.phase === "faulted" || _state.phase === "responding") throw Object.assign(new Error("A fault is already in progress — reset first"), { status: 409 });
  await _deps.runForCluster(cluster, async () => {
    await readDeployment();
    await O().patch(`/apis/apps/v1/namespaces/${NS}/deployments/${DEP}`, {
      spec: { template: {
        metadata: { annotations: { "tcs.com/release": "2026.10.2 (connection-pool tuning)" } },
        spec: { volumes: [{ name: "config", configMap: { name: BAD } }] },
      } },
    });
  });
  _state = { phase: "faulted", faultAt: new Date().toISOString(), sessionId: null, detectedAt: null, resolvedAt: null, by: actor, log: [], cluster };
  note(`Release 2026.10.2 rolled out by ${actor} — the new pods will fail to start`);
  startWatch(cluster);
  return scenarioStatus({ cluster });
}

/** Restore the healthy config and clear the scenario. */
export async function resetScenario({ cluster = "local", actor = "presenter" } = {}) {
  stopWatch();
  await _deps.runForCluster(cluster, async () => {
    await O().patch(`/apis/apps/v1/namespaces/${NS}/deployments/${DEP}`, {
      spec: { template: {
        metadata: { annotations: { "tcs.com/release": "2026.10.1 (baseline)" } },
        spec: { volumes: [{ name: "config", configMap: { name: GOOD } }] },
      } },
    });
  });
  _state = { phase: "idle", faultAt: null, sessionId: null, detectedAt: null, resolvedAt: null, by: null, log: [] };
  note(`Reset by ${actor}: baseline config restored`);
  return scenarioStatus({ cluster });
}

/* The watch: run the platform's detector on a short loop while a fault is live,
   and hand the first detection in the demo namespace to the orchestrator. */
function startWatch(cluster) {
  stopWatch();
  const started = Date.now();
  _timer = setInterval(async () => {
    if (Date.now() - started > WATCH_LIMIT_MS) { note("Stopped watching after 30 minutes"); stopWatch(); return; }
    if (_state.sessionId || !_deps.detect || !_deps.promote) return;
    try {
      const result = await _deps.runForCluster(cluster, () => _deps.detect());
      const det = (result?.incidents || []).find((x) => x.namespace === NS);
      if (!det) return;
      _state.detectedAt = new Date().toISOString();
      note(`Detected by the platform: ${det.title || det.signal}`);
      const session = await _deps.runForCluster(cluster, () => _deps.promote(det, { cluster, actor: "command-center" }));
      _state.sessionId = session?.id || null;
      _state.phase = "responding";
      note(`Incident response started${session?.incidentNumber ? ` · ${session.incidentNumber}` : ""}`);
    } catch (e) { note(`Watch error: ${e.message}`); }
  }, WATCH_MS);
  if (_timer.unref) _timer.unref();
}
function stopWatch() { if (_timer) clearInterval(_timer); _timer = null; }

// Survives a restart (persist.js); a fault still in progress picks up watching again.
registerPart("scenario", {
  exportState: () => ({ ..._state, log: _state.log.slice() }),
  importState: (st) => {
    if (!st || !st.phase) return;
    _state = { phase: st.phase, faultAt: st.faultAt || null, sessionId: st.sessionId || null, detectedAt: st.detectedAt || null,
      resolvedAt: st.resolvedAt || null, by: st.by || null, log: Array.isArray(st.log) ? st.log.slice(-40) : [], cluster: st.cluster || "local" };
    if (["faulted", "responding"].includes(_state.phase)) startWatch(_state.cluster);
  },
});

export function _resetScenarioForTest() { stopWatch(); _state = { phase: "idle", faultAt: null, sessionId: null, detectedAt: null, resolvedAt: null, by: null, log: [] }; }
