/**
 * Deprecated-API consumer discovery.
 *
 * OpenShift tracks every call to a deprecated/removed API in the
 * APIRequestCount resource (apiserver.openshift.io/v1), named
 * "<resource>.<version>.<group>". This turns a generic "migrate off <api>"
 * warning into the concrete list of workloads/users still calling it, so the
 * migration is targeted instead of guesswork.
 */

import { ocpGet } from "../utils/openshift-client.js";

/** Split "group/version" or "group.io/v1beta1" into { group, version }. */
function parseApi(api) {
  const s = String(api || "").trim();
  const idx = s.lastIndexOf("/");
  if (idx < 0) return { group: "", version: s };
  return { group: s.slice(0, idx), version: s.slice(idx + 1) };
}

export async function getDeprecatedAPIConsumers(api) {
  const { group, version } = parseApi(api);
  if (!version) return { api, error: "Could not parse the API group/version.", consumers: [], resources: [] };

  let items = [];
  try {
    const list = await ocpGet("/apis/apiserver.openshift.io/v1/apirequestcounts?limit=1000");
    items = list.items || [];
  } catch (e) {
    return { api, error: `APIRequestCount not available on this cluster: ${e.message}`, consumers: [], resources: [] };
  }

  // Match by name suffix ".<version>.<group>" (fall back to just version when
  // no group), e.g. "horizontalpodautoscalers.v2beta2.autoscaling".
  const suffix = group ? `.${version}.${group}` : `.${version}`;
  const matched = items.filter((it) => (it.metadata?.name || "").endsWith(suffix));

  const byKey = new Map();
  let removedInRelease = null;
  let totalRequests = 0;
  const resources = [];

  for (const it of matched) {
    resources.push(it.metadata.name);
    if (it.status?.removedInRelease) removedInRelease = it.status.removedInRelease;
    totalRequests += it.status?.requestCount || 0;
    // Aggregate consumers across last24h → byNode → byUser.
    for (const hour of (it.status?.last24h || [])) {
      for (const node of (hour.byNode || [])) {
        for (const user of (node.byUser || [])) {
          const username = user.username || "unknown";
          const userAgent = (user.userAgent || "").split(" ")[0] || "";
          const key = `${username}|${userAgent}`;
          const cur = byKey.get(key) || { username, userAgent, requestCount: 0, verbs: new Set() };
          cur.requestCount += user.requestCount || 0;
          for (const v of (user.byVerb || [])) cur.verbs.add(v.verb);
          byKey.set(key, cur);
        }
      }
    }
  }

  const consumers = [...byKey.values()]
    .map((c) => ({ username: c.username, userAgent: c.userAgent, requestCount: c.requestCount, verbs: [...c.verbs] }))
    .sort((a, b) => b.requestCount - a.requestCount)
    .slice(0, 40);

  return {
    api, group, version,
    removedInRelease,
    resources,
    totalRequests,
    consumers,
    note: matched.length === 0
      ? "No APIRequestCount records for this API — it may be unused, or usage tracking is disabled on this cluster."
      : consumers.length === 0
        ? "Matched the API but no per-user records in the last 24h — likely low/no recent usage."
        : null,
  };
}
