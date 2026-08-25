/**
 * Reflection — post-action verification ("did my last fix actually work?").
 *
 * For each executed action in the recent past, checks whether the action
 * achieved its intended outcome by re-querying the cluster. Outcomes:
 *   - "confirmed"   — the fix worked (pod now running, deployment ready, etc.)
 *   - "regressed"   — the fix didn't hold (problem returned)
 *   - "unknown"     — could not verify (resource missing, no clear signal)
 *
 * Used by the /reflect slash command and by the reasoning trace to surface
 * fix effectiveness.
 */

import { ocpGet } from "../utils/openshift-client.js";
import { query, isEnabled } from "../utils/db.js";

/**
 * Run reflection over recent executed actions and return a report.
 * @param {object} opts - { lookbackMinutes }
 */
export async function runReflectionCheck({ lookbackMinutes = 60 } = {}) {
  if (!(await isEnabled())) {
    return { checked: 0, confirmed: 0, regressed: 0, unknown: 0, items: [], lookbackMinutes };
  }
  const sinceISO = new Date(Date.now() - lookbackMinutes * 60_000).toISOString();
  let rows;
  try {
    const r = await query(
      `SELECT id, action, target, namespace, success, created_at, metadata
       FROM executed_actions WHERE created_at >= $1 AND success = TRUE
       ORDER BY id DESC LIMIT 50`,
      [sinceISO]
    );
    rows = r?.rows || [];
  } catch { rows = []; }

  const items = [];
  let confirmed = 0, regressed = 0, unknown = 0;

  for (const row of rows) {
    const result = await _verifyAction(row);
    items.push(result);
    if (result.status === "confirmed") confirmed++;
    else if (result.status === "regressed") regressed++;
    else unknown++;
  }

  return { checked: rows.length, confirmed, regressed, unknown, items, lookbackMinutes };
}

async function _verifyAction(row) {
  const action = (row.action || "").toLowerCase();
  const target = row.target || "";
  const ns = row.namespace || null;

  // Action: restart / delete pod → expect pod to be re-created and Running
  if (/^(restart|delete)\s+pod/.test(action) || (action.includes("delete") && action.includes("pod"))) {
    if (!ns || !target) return { id: row.id, action, target, status: "unknown", verdict: "Insufficient context to verify" };
    try {
      const deployRoot = target.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/, "");
      const pods = await ocpGet(`/api/v1/namespaces/${ns}/pods`);
      const replacementPods = (pods.items || []).filter((p) => p.metadata?.name?.startsWith(deployRoot));
      const running = replacementPods.filter((p) => p.status?.phase === "Running" && (p.status?.containerStatuses || []).every((c) => c.ready));
      if (running.length > 0) return { id: row.id, action, target, status: "confirmed", verdict: `${running.length} replacement pod(s) running.` };
      if (replacementPods.some((p) => (p.status?.containerStatuses || []).some((c) => c.state?.waiting?.reason === "CrashLoopBackOff"))) {
        return { id: row.id, action, target, status: "regressed", verdict: "Replacement pod is also CrashLoopBackOff — the underlying problem remains." };
      }
      return { id: row.id, action, target, status: "unknown", verdict: "No replacement pod found in this namespace." };
    } catch (err) {
      return { id: row.id, action, target, status: "unknown", verdict: `Verification failed: ${err.message}` };
    }
  }

  // Action: scale deployment → expect spec.replicas to match status.replicas
  if (/^scale\s+deployment/.test(action) || (action.includes("scale") && action.includes("deployment"))) {
    if (!ns || !target) return { id: row.id, action, target, status: "unknown", verdict: "Insufficient context" };
    try {
      const d = await ocpGet(`/apis/apps/v1/namespaces/${ns}/deployments/${target}`);
      const desired = d.spec?.replicas;
      const ready = d.status?.readyReplicas || 0;
      if (desired != null && ready >= desired) return { id: row.id, action, target, status: "confirmed", verdict: `Deployment scaled: ${ready}/${desired} ready.` };
      return { id: row.id, action, target, status: "regressed", verdict: `Only ${ready}/${desired} replicas ready.` };
    } catch (err) {
      return { id: row.id, action, target, status: "unknown", verdict: `Could not verify: ${err.message}` };
    }
  }

  // Action: approve CSR → expect status.conditions to include Approved=True
  if (/^approve\s+csr/.test(action) || action.includes("certificate approve")) {
    try {
      const csr = await ocpGet(`/apis/certificates.k8s.io/v1/certificatesigningrequests/${target}`);
      const approved = (csr.status?.conditions || []).some((c) => c.type === "Approved" && c.status === "True");
      return approved
        ? { id: row.id, action, target, status: "confirmed", verdict: "CSR is now approved." }
        : { id: row.id, action, target, status: "regressed", verdict: "CSR still not approved." };
    } catch (err) {
      return { id: row.id, action, target, status: "unknown", verdict: `CSR not found: ${err.message}` };
    }
  }

  // Action: cordon / uncordon node
  if (/^(cordon|uncordon)/.test(action)) {
    try {
      const node = await ocpGet(`/api/v1/nodes/${target}`);
      const unsched = node.spec?.unschedulable || false;
      const expected = action.startsWith("cordon") ? true : false;
      return unsched === expected
        ? { id: row.id, action, target, status: "confirmed", verdict: `Node is ${expected ? "cordoned" : "schedulable"}.` }
        : { id: row.id, action, target, status: "regressed", verdict: `Expected unschedulable=${expected}, got ${unsched}.` };
    } catch (err) {
      return { id: row.id, action, target, status: "unknown", verdict: `Node not found: ${err.message}` };
    }
  }

  // Action: drain → harder to verify; check if node still has pods other than DaemonSets
  if (/^drain/.test(action)) {
    try {
      const pods = await ocpGet(`/api/v1/pods?fieldSelector=spec.nodeName=${target}`);
      const nonDS = (pods.items || []).filter((p) => !(p.metadata?.ownerReferences || []).some((o) => o.kind === "DaemonSet"));
      return nonDS.length === 0
        ? { id: row.id, action, target, status: "confirmed", verdict: `Node drained — no non-DaemonSet pods remain.` }
        : { id: row.id, action, target, status: "regressed", verdict: `Node still has ${nonDS.length} non-DaemonSet pod(s).` };
    } catch (err) {
      return { id: row.id, action, target, status: "unknown", verdict: `Drain verification failed: ${err.message}` };
    }
  }

  return { id: row.id, action, target, status: "unknown", verdict: "No automatic verifier for this action type." };
}
