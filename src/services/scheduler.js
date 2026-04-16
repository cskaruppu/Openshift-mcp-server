/**
 * Lightweight recurring scheduler (no external cron dep).
 *
 * Used by:
 *   - Scheduled health checks (#18): runs every HEALTH_CHECK_INTERVAL_MS
 *   - Resource index rebuild: every RESOURCE_INDEX_TTL_MS
 *   - Alert poll: every ALERT_POLL_INTERVAL_MS
 *
 * All tasks are best-effort. Failures are logged and the scheduler continues.
 */

const tasks = new Map();

/**
 * Register a recurring task.
 * @param {string} name
 * @param {number} intervalMs
 * @param {() => Promise<void>} fn
 * @param {{runImmediately?: boolean}} [opts]
 */
export function schedule(name, intervalMs, fn, opts = {}) {
  if (tasks.has(name)) return;
  const runOnce = async () => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[scheduler] ${name} failed:`, err.message);
    }
  };
  const handle = setInterval(runOnce, intervalMs);
  tasks.set(name, handle);
  if (opts.runImmediately) {
    // Non-blocking
    setImmediate(runOnce);
  }
}

export function unschedule(name) {
  const h = tasks.get(name);
  if (h) {
    clearInterval(h);
    tasks.delete(name);
  }
}

export function listTasks() {
  return Array.from(tasks.keys());
}

// ---------------------------------------------------------------------------
// Health check task
// ---------------------------------------------------------------------------
import { ocpGet } from "../utils/openshift-client.js";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

async function runHealthCheck() {
  const report = {
    timestamp: new Date().toISOString(),
    nodes: { total: 0, ready: 0, notReady: 0 },
    pods: { total: 0, running: 0, problem: 0 },
    operators: { total: 0, degraded: 0 },
  };
  try {
    const n = await ocpGet("/api/v1/nodes");
    for (const node of n.items || []) {
      report.nodes.total++;
      const ready = (node.status?.conditions || []).some(
        (c) => c.type === "Ready" && c.status === "True"
      );
      if (ready) report.nodes.ready++;
      else report.nodes.notReady++;
    }
  } catch {}
  try {
    const p = await ocpGet("/api/v1/pods");
    for (const pod of p.items || []) {
      report.pods.total++;
      const phase = pod.status?.phase;
      if (phase === "Running") report.pods.running++;
      if (phase === "Failed" || phase === "Unknown") report.pods.problem++;
    }
  } catch {}
  try {
    const o = await ocpGet("/apis/config.openshift.io/v1/clusteroperators");
    for (const op of o.items || []) {
      report.operators.total++;
      const degraded = (op.status?.conditions || []).some(
        (c) => c.type === "Degraded" && c.status === "True"
      );
      if (degraded) report.operators.degraded++;
    }
  } catch {}

  if (await dbEnabled()) {
    await dbQuery(
      `INSERT INTO health_reports (report, created_at) VALUES ($1, NOW())`,
      [JSON.stringify(report)]
    ).catch(() => {});
  }
  return report;
}

export function startHealthCheckTask() {
  const interval = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || "300000", 10); // 5 min
  schedule("health-check", interval, runHealthCheck, { runImmediately: false });
}

export async function getLatestHealthReport() {
  if (!(await dbEnabled())) return null;
  const r = await dbQuery(
    `SELECT report, created_at FROM health_reports ORDER BY created_at DESC LIMIT 1`
  );
  return r?.rows?.[0] || null;
}

export async function runHealthCheckNow() {
  return runHealthCheck();
}
