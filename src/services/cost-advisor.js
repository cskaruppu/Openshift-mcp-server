/**
 * Cost / efficiency advisor.
 *
 * Joins pod resource requests/limits with actual usage from Prometheus to
 * flag over- and under-provisioned workloads. Used by:
 *   - /api/advisor (dashboard tab)
 *   - The `/efficiency` slash command
 */

import { ocpGet } from "../utils/openshift-client.js";
import { promQuery } from "./prometheus.js";

function parseCpu(s) {
  if (!s) return 0;
  if (s.endsWith("m")) return parseInt(s, 10) / 1000;
  return parseFloat(s);
}

function parseMem(s) {
  if (!s) return 0;
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  const m = String(s).match(/^(\d+(?:\.\d+)?)([KMGT]i?)?$/);
  if (!m) return parseFloat(s) || 0;
  const num = parseFloat(m[1]);
  const u = m[2];
  return num * (units[u] || 1);
}

/**
 * Analyse all workloads and return efficiency findings.
 * - overProvisioned: request > 3x p95 actual usage
 * - underProvisioned: actual usage > 0.9x limit
 * - noLimits: no memory or CPU limit set
 */
export async function analyzeEfficiency() {
  const findings = { overProvisioned: [], underProvisioned: [], noLimits: [] };

  // 1. List deployments (we advise on controllers, not individual pods)
  let deps = [];
  try {
    const d = await ocpGet("/apis/apps/v1/deployments");
    deps = d.items || [];
  } catch {
    return findings;
  }

  // 2. Pull actual usage from Prometheus for each namespace:pod
  let cpuRows = [];
  let memRows = [];
  try {
    cpuRows = await promQuery(
      `quantile_over_time(0.95, sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!=""}[5m]))[24h:5m])`
    );
  } catch {}
  try {
    memRows = await promQuery(
      `quantile_over_time(0.95, sum by (namespace, pod) (container_memory_working_set_bytes{container!=""})[24h:5m])`
    );
  } catch {}

  const cpuByPod = new Map();
  for (const r of cpuRows) {
    const k = `${r.metric.namespace}/${r.metric.pod}`;
    cpuByPod.set(k, parseFloat(r.value?.[1] || 0));
  }
  const memByPod = new Map();
  for (const r of memRows) {
    const k = `${r.metric.namespace}/${r.metric.pod}`;
    memByPod.set(k, parseFloat(r.value?.[1] || 0));
  }

  // 3. Walk deployments
  for (const d of deps) {
    const ns = d.metadata.namespace;
    const name = d.metadata.name;
    const container = d.spec?.template?.spec?.containers?.[0];
    if (!container) continue;
    const req = container.resources?.requests || {};
    const lim = container.resources?.limits || {};
    const cpuReq = parseCpu(req.cpu);
    const memReq = parseMem(req.memory);
    const cpuLim = parseCpu(lim.cpu);
    const memLim = parseMem(lim.memory);

    if (!lim.memory || !lim.cpu) {
      findings.noLimits.push({ ns, name, missing: [!lim.cpu && "cpu", !lim.memory && "memory"].filter(Boolean) });
    }

    // Look up usage by matching any pod whose name starts with deployment name
    let maxCpu = 0;
    let maxMem = 0;
    for (const [k, v] of cpuByPod) if (k.startsWith(`${ns}/${name}-`)) maxCpu = Math.max(maxCpu, v);
    for (const [k, v] of memByPod) if (k.startsWith(`${ns}/${name}-`)) maxMem = Math.max(maxMem, v);

    if (cpuReq > 0 && maxCpu > 0 && cpuReq > 3 * maxCpu) {
      findings.overProvisioned.push({
        ns, name, kind: "cpu", request: cpuReq.toFixed(3), actual: maxCpu.toFixed(3),
      });
    }
    if (memReq > 0 && maxMem > 0 && memReq > 3 * maxMem) {
      findings.overProvisioned.push({
        ns, name, kind: "memory", request: formatBytes(memReq), actual: formatBytes(maxMem),
      });
    }
    if (memLim > 0 && maxMem > 0.9 * memLim) {
      findings.underProvisioned.push({
        ns, name, kind: "memory", limit: formatBytes(memLim), actual: formatBytes(maxMem),
      });
    }
    if (cpuLim > 0 && maxCpu > 0.9 * cpuLim) {
      findings.underProvisioned.push({
        ns, name, kind: "cpu", limit: cpuLim.toFixed(3), actual: maxCpu.toFixed(3),
      });
    }
  }

  return findings;
}

function formatBytes(b) {
  if (!b) return "0";
  const units = ["B", "Ki", "Mi", "Gi", "Ti"];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)}${units[i]}`;
}
