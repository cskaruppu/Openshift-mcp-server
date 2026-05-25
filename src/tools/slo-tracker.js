import { ocpGet } from "../utils/openshift-client.js";
import { query as dbQuery } from "../utils/db.js";

const DB_KEY = "slo_definitions";
const PROM_URL_KEY = "prometheus_url";

let _slos = new Map();
let _prometheusUrl = null;
let _promDiscovered = false;

const PROM_DISCOVERY_PATHS = [
  "/api/v1/namespaces/openshift-monitoring/services/prometheus-k8s",
  "/api/v1/namespaces/monitoring/services/prometheus",
  "/api/v1/namespaces/prometheus/services/prometheus",
];

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
  } catch {}
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
  } catch {}
  try {
    const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [PROM_URL_KEY]);
    if (result?.rows?.length > 0) {
      _prometheusUrl = typeof result.rows[0].value === "string" ? result.rows[0].value : result.rows[0].value?.url;
    }
  } catch {}
}

async function discoverPrometheus() {
  if (_promDiscovered) return _prometheusUrl;
  _promDiscovered = true;

  if (process.env.PROMETHEUS_URL) {
    _prometheusUrl = process.env.PROMETHEUS_URL;
    return _prometheusUrl;
  }

  for (const path of PROM_DISCOVERY_PATHS) {
    try {
      const svc = await ocpGet(path);
      const ns = svc.metadata.namespace;
      const name = svc.metadata.name;
      const port = svc.spec?.ports?.[0]?.port || 9090;
      _prometheusUrl = `http://${name}.${ns}.svc:${port}`;
      return _prometheusUrl;
    } catch {}
  }

  return null;
}

async function queryPrometheus(promql, time) {
  const url = _prometheusUrl;
  if (!url) return null;

  try {
    const params = new URLSearchParams({ query: promql });
    if (time) params.set("time", time);
    const resp = await fetch(`${url}/api/v1/query?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== "success") return null;
    return data.data;
  } catch {
    return null;
  }
}

async function queryPrometheusRange(promql, start, end, step) {
  const url = _prometheusUrl;
  if (!url) return null;

  try {
    const params = new URLSearchParams({ query: promql, start: String(start), end: String(end), step: step || "5m" });
    const resp = await fetch(`${url}/api/v1/query_range?${params}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== "success") return null;
    return data.data;
  } catch {
    return null;
  }
}

export async function setPrometheusUrl(url) {
  _prometheusUrl = url || null;
  _promDiscovered = true;
  try {
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [PROM_URL_KEY, JSON.stringify({ url: _prometheusUrl })]
    );
  } catch {}
  return _prometheusUrl;
}

export function getPrometheusUrl() {
  return _prometheusUrl;
}

export async function getPrometheusStatus() {
  await discoverPrometheus();
  if (!_prometheusUrl) return { connected: false, url: null };
  try {
    const resp = await fetch(`${_prometheusUrl}/api/v1/status/config`, { signal: AbortSignal.timeout(5000) });
    return { connected: resp.ok, url: _prometheusUrl };
  } catch {
    return { connected: false, url: _prometheusUrl };
  }
}

export async function defineSLO(sloConfig) {
  const { name, namespace, targetAvailability, windowDays, deploymentName, promqlAvailability, promqlLatency } = sloConfig;

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
    promqlAvailability: promqlAvailability || null,
    promqlLatency: promqlLatency || null,
    createdAt: new Date().toISOString(),
  };

  _slos.set(id, slo);
  await persistSLOs();

  return slo;
}

async function measureWithPrometheus(slo) {
  await discoverPrometheus();
  if (!_prometheusUrl) return null;

  const windowSeconds = slo.windowDays * 86400;
  const windowStr = `${slo.windowDays}d`;

  if (slo.promqlAvailability) {
    const data = await queryPrometheus(slo.promqlAvailability);
    if (data?.result?.[0]?.value?.[1]) {
      const availability = parseFloat(data.result[0].value[1]) * 100;
      return { availability, source: "prometheus-custom" };
    }
  }

  // Default SLI: success rate from istio/envoy metrics or kube-state-metrics
  const successRateQueries = [
    `sum(rate(http_requests_total{namespace="${slo.namespace}",code=~"2.."}[${windowStr}])) / sum(rate(http_requests_total{namespace="${slo.namespace}"}[${windowStr}]))`,
    `sum(rate(istio_requests_total{destination_service_namespace="${slo.namespace}",response_code=~"2.."}[${windowStr}])) / sum(rate(istio_requests_total{destination_service_namespace="${slo.namespace}"}[${windowStr}]))`,
    `sum(rate(grpc_server_handled_total{grpc_code="OK",namespace="${slo.namespace}"}[${windowStr}])) / sum(rate(grpc_server_handled_total{namespace="${slo.namespace}"}[${windowStr}]))`,
  ];

  for (const q of successRateQueries) {
    const data = await queryPrometheus(q);
    if (data?.result?.[0]?.value?.[1]) {
      const val = parseFloat(data.result[0].value[1]);
      if (!isNaN(val) && val > 0) {
        return { availability: val * 100, source: "prometheus" };
      }
    }
  }

  // Latency SLI if provided
  if (slo.promqlLatency) {
    const data = await queryPrometheus(slo.promqlLatency);
    if (data?.result?.[0]?.value?.[1]) {
      return { latencyP99: parseFloat(data.result[0].value[1]), source: "prometheus-latency" };
    }
  }

  return null;
}

export async function getSLOStatus() {
  const results = [];

  for (const slo of _slos.values()) {
    try {
      const promMetrics = await measureWithPrometheus(slo);

      const [deploymentResp, podsResp] = await Promise.all([
        ocpGet(`/apis/apps/v1/namespaces/${slo.namespace}/deployments/${slo.deploymentName}`),
        ocpGet(`/api/v1/namespaces/${slo.namespace}/pods?labelSelector=app=${slo.deploymentName}`),
      ]);

      const pods = podsResp.items || [];
      const totalPods = pods.length;

      if (totalPods === 0) {
        results.push(buildSLOResult(slo, 0, 0, 0, promMetrics));
        continue;
      }

      let unhealthyPods = 0;
      let totalRestarts = 0;
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

      const desiredReplicas = deploymentResp.spec?.replicas || 1;
      const windowMinutes = slo.windowDays * 24 * 60;
      const expectedTotalMinutes = windowMinutes * desiredReplicas;

      const podAvailability =
        totalPods > 0
          ? ((totalPods - unhealthyPods) / totalPods) * 100
          : 0;

      const restartPenaltyMinutes = totalRestarts * 0.5;
      const effectiveDowntimeMinutes = totalDowntimeMinutes + restartPenaltyMinutes;

      results.push(buildSLOResult(slo, podAvailability, effectiveDowntimeMinutes, expectedTotalMinutes, promMetrics));
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
        metricsSource: "error",
        error: err.message,
      });
    }
  }

  return results;
}

function buildSLOResult(slo, podAvailability, downtimeMinutes, expectedTotalMinutes, promMetrics) {
  // Use Prometheus availability if available, otherwise fall back to pod health
  const availability = promMetrics?.availability ?? podAvailability;
  const metricsSource = promMetrics?.source || "pod-health";

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
    metricsSource,
    latencyP99: promMetrics?.latencyP99 || null,
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
    metricsSource: s.metricsSource,
  }));
}
