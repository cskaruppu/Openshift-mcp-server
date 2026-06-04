import { create } from "zustand";

/**
 * The single source of truth for the active cluster.
 *
 * This is the cornerstone of the isolation-by-design model: the active cluster
 * id is held in exactly ONE place. Every data query keys off it, so there is no
 * shared mutable per-widget state that can leak across clusters.
 *
 * When `activeCluster` changes, TanStack Query keys change too, which means:
 *   - In-flight queries for the old cluster are cancelled automatically.
 *   - The old cluster's cached data is structurally unreachable.
 *   - Widgets re-render from the new cluster's cache (or a loading state).
 *
 * No manual generation counters, no AbortControllers, no DOM clearing.
 */
export const useClusterStore = create((set) => ({
  activeCluster: "local", // "local" = hub; any other value = a remote cluster key
  setActiveCluster: (cluster) => set({ activeCluster: cluster || "local" }),
}));

/** Convenience hook returning just the active cluster id. */
export const useActiveCluster = () => useClusterStore((s) => s.activeCluster);
