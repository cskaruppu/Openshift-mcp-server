/**
 * Alertmanager client — fetches firing alerts from the in-cluster
 * alertmanager. Used by the proactive alert watcher and dashboard badge.
 *
 * Graceful fallback: if Alertmanager isn't reachable, returns an empty list.
 */

import { readFile } from "node:fs/promises";

const DEFAULT_URL =
  process.env.ALERTMANAGER_URL ||
  "https://alertmanager-main.openshift-monitoring.svc:9095";

let _tk = null;
async function getToken() {
  if (_tk) return _tk;
  if (process.env.OPENSHIFT_TOKEN) return (_tk = process.env.OPENSHIFT_TOKEN);
  try {
    _tk = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
  } catch {
    _tk = null;
  }
  return _tk;
}

export async function listFiringAlerts() {
  try {
    const tk = await getToken();
    const resp = await fetch(`${DEFAULT_URL}/api/v2/alerts?filter=state%3Dactive`, {
      headers: tk ? { Authorization: `Bearer ${tk}` } : {},
    });
    if (!resp.ok) return [];
    const arr = await resp.json();
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((a) => a.status?.state === "active")
      .slice(0, 100)
      .map((a) => ({
        name: a.labels?.alertname || "unknown",
        severity: a.labels?.severity || "info",
        namespace: a.labels?.namespace || null,
        pod: a.labels?.pod || null,
        summary: a.annotations?.summary || "",
        description: a.annotations?.description || "",
        startsAt: a.startsAt,
        labels: a.labels || {},
      }));
  } catch {
    return [];
  }
}

export async function isAlertmanagerReachable() {
  try {
    await listFiringAlerts();
    return true;
  } catch {
    return false;
  }
}
