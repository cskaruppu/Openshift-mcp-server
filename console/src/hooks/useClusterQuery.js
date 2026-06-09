import { useQuery } from "@tanstack/react-query";
import { useActiveCluster } from "../store/clusterStore";
import { apiGet } from "../api/client";

/**
 * Refresh tiers — match polling frequency to how fast each data type actually
 * changes and how expensive it is to fetch. Avoids hammering the cluster API
 * (and the hub proxy for spokes) with redundant expensive scans.
 *
 *   VITALS   — cheap live signals you actively watch (health, nodes, pods,
 *              operators, alerts). Poll often.
 *   STANDARD — moderate cost / moderate change (topology, heatmap, capacity).
 *   SCAN     — heavy live scans whose results change slowly (image vulns,
 *              resource optimization, CIS compliance). Polling fast is waste.
 *
 * NOTE: React Query dedupes by [path, cluster] and uses the SHORTEST interval
 * among observers of the same key — so a shared endpoint refreshes at its
 * fastest consumer's tier.
 */
export const REFRESH = {
  VITALS: 15_000,    // 15s
  STANDARD: 30_000,  // 30s
  SCAN: 300_000,     // 5 min
};

/**
 * The single primitive every widget uses to fetch cluster-scoped data.
 *
 * Isolation is guaranteed by construction:
 *   1. The active cluster id is part of the query KEY: [path, cluster].
 *      When the cluster changes, the key changes, so React Query treats it as a
 *      completely different query — the old cluster's data is never shown.
 *   2. The fetcher receives `signal` from React Query, which is aborted when the
 *      key changes, cancelling in-flight requests for the previous cluster.
 *   3. The cluster id is passed to the API client so the request carries the
 *      correct `?cluster=` param and `X-Cluster-Context` header.
 *
 * There is deliberately NO way to fetch cluster data without going through this
 * hook, so a widget cannot accidentally show another cluster's data.
 *
 * @param {string} path - API path, e.g. "/api/cluster/summary"
 * @param {object} [options] - extra react-query options (staleTime, etc.)
 */
export function useClusterQuery(path, options = {}) {
  const cluster = useActiveCluster();
  return useQuery({
    queryKey: [path, cluster],
    queryFn: ({ signal }) => apiGet(path, { cluster, signal }),
    // Stale-while-revalidate: show cached data instantly, refetch in background.
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
    ...options,
  });
}
