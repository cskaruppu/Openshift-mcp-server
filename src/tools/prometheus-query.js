/**
 * Prometheus/Thanos query toolset — execute PromQL queries against the
 * in-cluster Thanos Querier or Prometheus instance.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";

const THANOS_URL =
  process.env.THANOS_QUERIER_URL ||
  process.env.PROMETHEUS_URL ||
  "https://thanos-querier.openshift-monitoring.svc:9091";

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

async function promFetch(path) {
  const tk = await getToken();
  const resp = await fetch(`${THANOS_URL}${path}`, {
    headers: {
      ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Prometheus API ${resp.status}: ${body.slice(0, 500)}`);
  }
  return resp.json();
}

function formatInstantResult(data) {
  const resultType = data?.data?.resultType;
  const results = data?.data?.result || [];

  if (results.length === 0) return "No results returned for this query.";

  if (resultType === "vector") {
    const lines = ["### Query Results (Instant Vector)\n"];
    lines.push("| Metric | Value | Timestamp |");
    lines.push("|---|---|---|");
    for (const r of results.slice(0, 100)) {
      const labels = Object.entries(r.metric || {})
        .map(([k, v]) => `${k}="${v}"`)
        .join(", ");
      const [ts, val] = r.value || [];
      const time = ts ? new Date(ts * 1000).toISOString() : "";
      lines.push(`| ${labels || "(no labels)"} | ${val} | ${time} |`);
    }
    if (results.length > 100) lines.push(`\n_Showing 100 of ${results.length} results._`);
    return lines.join("\n");
  }

  if (resultType === "scalar" || resultType === "string") {
    const [ts, val] = data.data.result;
    return `**Result:** ${val} (at ${new Date(ts * 1000).toISOString()})`;
  }

  return JSON.stringify(data.data, null, 2);
}

function formatRangeResult(data) {
  const results = data?.data?.result || [];
  if (results.length === 0) return "No results returned for this range query.";

  const lines = ["### Query Results (Range)\n"];
  for (const r of results.slice(0, 20)) {
    const labels = Object.entries(r.metric || {})
      .map(([k, v]) => `${k}="${v}"`)
      .join(", ");
    const values = r.values || [];
    lines.push(`**${labels || "(no labels)"}** — ${values.length} data points`);

    if (values.length <= 10) {
      lines.push("| Timestamp | Value |");
      lines.push("|---|---|");
      for (const [ts, val] of values) {
        lines.push(`| ${new Date(ts * 1000).toISOString()} | ${val} |`);
      }
    } else {
      const first = values[0];
      const last = values[values.length - 1];
      const min = values.reduce((m, v) => Math.min(m, parseFloat(v[1])), Infinity);
      const max = values.reduce((m, v) => Math.max(m, parseFloat(v[1])), -Infinity);
      const avg = values.reduce((s, v) => s + parseFloat(v[1]), 0) / values.length;
      lines.push(`  - Range: ${new Date(first[0] * 1000).toISOString()} → ${new Date(last[0] * 1000).toISOString()}`);
      lines.push(`  - Points: ${values.length} | Min: ${min.toFixed(2)} | Max: ${max.toFixed(2)} | Avg: ${avg.toFixed(2)}`);
      lines.push(`  - First: ${first[1]} | Last: ${last[1]}`);
    }
    lines.push("");
  }
  if (results.length > 20) lines.push(`_Showing 20 of ${results.length} series._`);
  return lines.join("\n");
}

export function registerPrometheusTools(server) {
  server.tool(
    "prometheus_query",
    "Execute an instant PromQL query against the cluster's Thanos Querier or Prometheus",
    {
      query: z.string().describe("PromQL query string, e.g. 'up{job=\"kubelet\"}'"),
      time: z.string().optional().describe("Evaluation timestamp (RFC3339 or Unix timestamp). Defaults to now."),
    },
    async ({ query, time }) => {
      try {
        const params = new URLSearchParams({ query });
        if (time) params.set("time", time);
        const data = await promFetch(`/api/v1/query?${params.toString()}`);

        if (data.status !== "success") {
          return { content: [{ type: "text", text: `Query failed: ${data.error || data.errorType || "unknown error"}` }], isError: true };
        }

        return { content: [{ type: "text", text: formatInstantResult(data) }] };
      } catch (err) {
        if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOTFOUND")) {
          return {
            content: [{
              type: "text",
              text: `Cannot reach Prometheus/Thanos at ${THANOS_URL}.\n\nSet THANOS_QUERIER_URL or PROMETHEUS_URL env var to the correct endpoint.\n\nFor OpenShift, the default is: https://thanos-querier.openshift-monitoring.svc:9091`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "prometheus_query_range",
    "Execute a range PromQL query for time-series data and trends",
    {
      query: z.string().describe("PromQL query string"),
      start: z.string().describe("Start time (RFC3339, Unix timestamp, or relative like '-1h')"),
      end: z.string().describe("End time (RFC3339, Unix timestamp, 'now', or relative like '-5m')"),
      step: z.string().optional().describe("Query resolution step width, e.g. '15s', '1m', '5m'. Auto-calculated if omitted."),
    },
    async ({ query, start, end, step }) => {
      try {
        const now = Date.now() / 1000;

        let startTs = start;
        let endTs = end;
        if (start.startsWith("-")) {
          const secs = parseDuration(start.slice(1));
          startTs = String(Math.floor(now - secs));
        }
        if (end === "now") {
          endTs = String(Math.floor(now));
        } else if (end.startsWith("-")) {
          const secs = parseDuration(end.slice(1));
          endTs = String(Math.floor(now - secs));
        }

        if (!step) {
          const rangeSecs = parseFloat(endTs) - parseFloat(startTs);
          if (rangeSecs <= 3600) step = "15s";
          else if (rangeSecs <= 86400) step = "1m";
          else if (rangeSecs <= 604800) step = "5m";
          else step = "15m";
        }

        const params = new URLSearchParams({ query, start: startTs, end: endTs, step });
        const data = await promFetch(`/api/v1/query_range?${params.toString()}`);

        if (data.status !== "success") {
          return { content: [{ type: "text", text: `Query failed: ${data.error || data.errorType || "unknown error"}` }], isError: true };
        }

        return { content: [{ type: "text", text: formatRangeResult(data) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "alertmanager_query",
    "Query alerts from the cluster's Alertmanager with advanced filtering",
    {
      active: z.boolean().optional().default(true).describe("Include firing alerts"),
      silenced: z.boolean().optional().default(false).describe("Include silenced alerts"),
      inhibited: z.boolean().optional().default(false).describe("Include inhibited alerts"),
      filter: z.string().optional().describe("Alertmanager filter syntax, e.g. 'severity=\"critical\"'"),
    },
    async ({ active, silenced, inhibited, filter }) => {
      try {
        const alertmanagerUrl =
          process.env.ALERTMANAGER_URL ||
          "https://alertmanager-main.openshift-monitoring.svc:9095";

        const params = new URLSearchParams();
        if (active !== undefined) params.set("active", String(active));
        if (silenced !== undefined) params.set("silenced", String(silenced));
        if (inhibited !== undefined) params.set("inhibited", String(inhibited));
        if (filter) params.append("filter", filter);

        const tk = await getToken();
        const resp = await fetch(`${alertmanagerUrl}/api/v2/alerts?${params.toString()}`, {
          headers: {
            ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
            Accept: "application/json",
          },
        });

        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`Alertmanager ${resp.status}: ${body.slice(0, 300)}`);
        }

        const alerts = await resp.json();
        if (!Array.isArray(alerts) || alerts.length === 0) {
          return { content: [{ type: "text", text: "No alerts match the given filters." }] };
        }

        const lines = [
          `### Alertmanager Alerts (${alerts.length} found)\n`,
          "| Alert | Severity | State | Namespace | Started | Summary |",
          "|---|---|---|---|---|---|",
        ];

        for (const a of alerts.slice(0, 50)) {
          const name = a.labels?.alertname || "unknown";
          const severity = a.labels?.severity || "info";
          const state = a.status?.state || "unknown";
          const ns = a.labels?.namespace || "-";
          const started = a.startsAt ? new Date(a.startsAt).toISOString().slice(0, 19) : "-";
          const summary = (a.annotations?.summary || a.annotations?.description || "").slice(0, 100);
          lines.push(`| ${name} | ${severity} | ${state} | ${ns} | ${started} | ${summary} |`);
        }

        if (alerts.length > 50) lines.push(`\n_Showing 50 of ${alerts.length} alerts._`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error querying alerts: ${err.message}` }], isError: true };
      }
    }
  );
}

function parseDuration(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return parseFloat(str);
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return val;
    case "m": return val * 60;
    case "h": return val * 3600;
    case "d": return val * 86400;
    default: return val;
  }
}
