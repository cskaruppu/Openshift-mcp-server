import { ocpGet } from "../utils/openshift-client.js";
import { query as dbQuery } from "../utils/db.js";

const DB_KEY = "slo_definitions";

let _slos = new Map();

function generateId() {
  return `slo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function persistSLOs() {
  try {
    const data = Array.from(_slos.values());
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [DB_KEY, JSON.stringify(data)]
    );
  } catch {
    // Best-effort persistence
  }
}

export async function loadSLOs() {
  try {
    const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [DB_KEY]);
    if (result?.rows?.length > 0) {
      const stored = result.rows[0].value;
      const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
      if (Array.isArray(parsed)) {
        for (const slo of parsed) {
          if (slo.id) _slos.set(slo.id, slo);
        }
      }
    }
  } catch {
    // Non-critical
  }
}

export async function defineSLO(sloConfig) {
  const { name, namespace, targetAvailability, windowDays, deploymentName } = sloConfig;

  if (!name || !namespace || !deploymentName) {
    throw new Error("name, namespace, and deploymentName are required");
  }

  const id = generateId();
  const slo = {
    id,
    name,
    namespace,
    targetAvailability: targetAvailability ?? 99.9,
    windowDays: windowDays ?? 30,
    deploymentName,
    createdAt: new Date().toISOString(),
  };

  _slos.set(id, slo);
  await persistSLOs();

  return slo;
}

export async function getSLOStatus() {
  const results = [];

  for (const slo of _slos.values()) {
    try {
      const [deploymentResp, podsResp] = await Promise.all([
        ocpGet(`/apis/apps/v1/namespaces/${slo.namespace}/deployments/${slo.deploymentName}`),
        ocpGet(`/api/v1/namespaces/${slo.namespace}/pods?labelSelector=app=${slo.deploymentName}`),
      ]);

      const pods = podsResp.items || [];
      const totalPods = pods.length;

      if (totalPods === 0) {
        results.push(buildSLOResult(slo, 0, 0, 0));
        continue;
      }

      let unhealthyPods = 0;
      let totalRestarts = 0;
      let totalUptimeMinutes = 0;
      let totalDowntimeMinutes = 0;

      const now = Date.now();
      const windowMs = slo.windowDays * 24 * 60 * 60 * 1000;
      const windowStart = now - windowMs;

      for (const pod of pods) {
        const phase = pod.status?.phase;
        const conditions = pod.status?.conditions || [];
        const readyCondition = conditions.find((c) => c.type === "Ready");
        const isReady = readyCondition?.status === "True";

        if (phase !== "Running" || !isReady) {
          unhealthyPods++;
        }

        for (const cs of pod.status?.containerStatuses || []) {
          totalRestarts += cs.restartCount || 0;

          const startedAt = cs.state?.running?.startedAt
            ? new Date(cs.state.running.startedAt).getTime()
            : null;

          if (startedAt) {
            const effectiveStart = Math.max(startedAt, windowStart);
            const uptimeMs = now - effectiveStart;
            totalUptimeMinutes += uptimeMs / 60000;

            if (cs.restartCount > 0 && cs.lastState?.terminated) {
              const terminatedAt = cs.lastState.terminated.finishedAt
                ? new Date(cs.lastState.terminated.finishedAt).getTime()
                : null;
              const restartedAt = cs.lastState.terminated.startedAt
                ? new Date(cs.lastState.terminated.startedAt).getTime()
                : null;

              if (terminatedAt && restartedAt && terminatedAt > windowStart) {
                const downMs = Math.abs(terminatedAt - restartedAt);
                totalDowntimeMinutes += (downMs * Math.min(cs.restartCount, 10)) / 60000;
              }
            }
          }
        }
      }

      const desiredReplicas = deploymentResp.spec?.replicas || 1;
      const windowMinutes = slo.windowDays * 24 * 60;
      const expectedTotalMinutes = windowMinutes * desiredReplicas;

      const availability =
        totalPods > 0
          ? ((totalPods - unhealthyPods) / totalPods) * 100
          : 0;

      const restartPenaltyMinutes = totalRestarts * 0.5;
      const effectiveDowntimeMinutes = totalDowntimeMinutes + restartPenaltyMinutes;

      results.push(buildSLOResult(slo, availability, effectiveDowntimeMinutes, expectedTotalMinutes));
    } catch (err) {
      results.push({
        id: slo.id,
        name: slo.name,
        namespace: slo.namespace,
        target: slo.targetAvailability,
        currentAvailability: null,
        errorBudgetTotal: null,
        errorBudgetRemaining: null,
        errorBudgetPct: null,
        status: "unknown",
        burnRate: null,
        error: err.message,
      });
    }
  }

  return results;
}

function buildSLOResult(slo, availability, downtimeMinutes, expectedTotalMinutes) {
  const windowMinutes = slo.windowDays * 24 * 60;
  const errorBudgetTotal = ((1 - slo.targetAvailability / 100) * windowMinutes);
  const errorBudgetRemaining = Math.max(0, errorBudgetTotal - downtimeMinutes);
  const errorBudgetPct =
    errorBudgetTotal > 0
      ? Math.round((errorBudgetRemaining / errorBudgetTotal) * 10000) / 100
      : 0;

  const elapsedDays = Math.max(1, slo.windowDays);
  const idealBurnPerDay = errorBudgetTotal / slo.windowDays;
  const actualBurnPerDay = downtimeMinutes / elapsedDays;
  const burnRate = idealBurnPerDay > 0 ? Math.round((actualBurnPerDay / idealBurnPerDay) * 100) / 100 : 0;

  let status;
  if (errorBudgetPct > 50) {
    status = "healthy";
  } else if (errorBudgetPct > 10) {
    status = "warning";
  } else {
    status = "critical";
  }

  if (availability < slo.targetAvailability) {
    status = "critical";
  }

  return {
    id: slo.id,
    name: slo.name,
    namespace: slo.namespace,
    target: slo.targetAvailability,
    currentAvailability: Math.round(availability * 1000) / 1000,
    errorBudgetTotal: Math.round(errorBudgetTotal * 100) / 100,
    errorBudgetRemaining: Math.round(errorBudgetRemaining * 100) / 100,
    errorBudgetPct,
    status,
    burnRate,
  };
}

export function getAllSLOs() {
  return Array.from(_slos.values());
}

export async function deleteSLO(id) {
  const existed = _slos.delete(id);
  if (existed) {
    await persistSLOs();
  }
  return existed;
}

export async function calculateErrorBudget() {
  const statuses = await getSLOStatus();
  return statuses.map((s) => ({
    id: s.id,
    name: s.name,
    namespace: s.namespace,
    target: s.target,
    errorBudgetTotal: s.errorBudgetTotal,
    errorBudgetRemaining: s.errorBudgetRemaining,
    errorBudgetPct: s.errorBudgetPct,
    burnRate: s.burnRate,
    status: s.status,
  }));
}
