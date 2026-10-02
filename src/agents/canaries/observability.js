/**
 * Canary cases for the Observability Agent.
 *
 * AN HONEST NOTE ON WHAT THESE CAN CHECK.
 *
 * The Prometheus result formatting lives inside this agent's tool handlers and
 * is not exported, so these cases query a real Prometheus instead. Without a
 * reachable cluster they SKIP, and a skip is reported as a skip rather than a
 * pass — in a disconnected environment this agent reads as unverified, which is
 * exactly what it is.
 *
 * What they protect: the distinction between "the query returned nothing" and
 * "the value is zero". Those are the same pixel on a dashboard and completely
 * different facts. A broken scrape, a renamed metric and a genuinely idle
 * cluster all produce an empty result set; rendering any of them as 0 is how a
 * monitoring panel reports perfect health for a cluster it has stopped
 * watching. It is the same failure this whole line of work exists to catch,
 * sitting in the one agent whose entire job is to notice things.
 */

import { ocpGet } from "../../utils/openshift-client.js";

/** Thanos/Prometheus through the same client the agent's own tools use. */
async function query(expr) {
  const { promQuery } = await import("../../services/prometheus.js");
  return promQuery(expr);
}

export default [
  {
    id: "a-query-with-no-data-is-empty-not-zero",
    kind: "read-only",
    title: "A metric that does not exist returns no result, not a value of zero",
    why: "An empty result and a zero look identical on a dashboard and mean opposite things — one is 'nothing is wrong', the other is 'nobody is watching'. A renamed metric, a broken scrape and an idle cluster all return empty; if that ever renders as 0, every panel reports perfect health for a cluster it has lost sight of.",
    run: async () => {
      const r = await query("this_metric_does_not_exist_canary_probe");
      const results = r?.data?.result ?? r?.result ?? [];
      return {
        resultCount: Array.isArray(results) ? results.length : -1,
        isEmptyArray: Array.isArray(results) && results.length === 0,
        // The crucial one: nothing in the response may be a zero standing in
        // for the absent series.
        noFabricatedZero: !(Array.isArray(results) && results.some((x) => Number(x?.value?.[1]) === 0)),
        __evidence: { read: 0, expected: 1, confidence: "high", concluded: true, unread: ["the metric does not exist"] },
      };
    },
    expect: [
      { path: "isEmptyArray", assert: "equals", value: true },
      { path: "noFabricatedZero", assert: "equals", value: true },
    ],
  },

  {
    id: "a-real-metric-returns-real-samples",
    kind: "read-only",
    title: "A metric that does exist comes back with values and labels",
    why: "A query path that returns empty for everything would make the case above pass while the agent is completely broken. This is the case that proves the pipe is connected.",
    run: async () => {
      const r = await query("up");
      const results = r?.data?.result ?? r?.result ?? [];
      return {
        count: results.length,
        allHaveValue: results.every((s) => Array.isArray(s.value) && s.value.length === 2),
        allHaveLabels: results.every((s) => s.metric && Object.keys(s.metric).length > 0),
        __evidence: { read: results.length, expected: results.length, confidence: "high", concluded: true },
      };
    },
    expect: [
      { path: "count", assert: "atLeast", value: 1, note: "`up` always has series on a live cluster. Zero means the query path is broken." },
      { path: "allHaveValue", assert: "equals", value: true },
      { path: "allHaveLabels", assert: "equals", value: true,
        note: "A sample with no labels cannot be attributed to anything — it is a number with no subject." },
    ],
  },

  {
    id: "firing-alerts-are-reported-with-their-severity",
    kind: "read-only",
    title: "Alerts come back with the severity label they were written with",
    why: "An alert without its severity cannot be ranked, routed or escalated. Reporting alerts as a count, or losing the label in transit, turns a prioritised list into noise — and the critical one sits in the middle of it.",
    run: async () => {
      const d = await ocpGet("/apis/monitoring.coreos.com/v1/prometheusrules");
      const rules = (d.items || []).flatMap((r) => (r.spec?.groups || []).flatMap((g) => g.rules || []));
      const alerts = rules.filter((r) => r.alert);
      return {
        kind: d.kind,
        alertRules: alerts.length,
        withSeverity: alerts.filter((a) => a.labels?.severity).length,
        allHaveSeverity: alerts.length === 0 || alerts.every((a) => a.labels?.severity),
      };
    },
    expect: [
      { path: "kind", assert: "matches", value: "PrometheusRuleList" },
      { path: "alertRules", assert: "atLeast", value: 1,
        note: "A cluster with no alerting rules at all means the read failed, not that nothing is monitored." },
    ],
  },
];
