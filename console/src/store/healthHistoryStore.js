import { create } from "zustand";

/**
 * Per-cluster health snapshot history for the Health Timeline widget.
 * Keyed by cluster so each cluster shows only its own history.
 */
export const useHealthHistoryStore = create((set, get) => ({
  byCluster: {}, // { [cluster]: [{ t, health }] }

  record(cluster, health) {
    if (!health) return;
    const list = get().byCluster[cluster] || [];
    const last = list[list.length - 1];
    // Only append when health changes or every snapshot tick.
    const next = [...list, { t: Date.now(), health }].slice(-48); // keep last 48 points
    if (last && last.health === health && list.length > 0 && next.length === list.length + 1) {
      // still append to show continuity; cap handled by slice
    }
    set((state) => ({ byCluster: { ...state.byCluster, [cluster]: next } }));
  },

  get(cluster) {
    return get().byCluster[cluster] || [];
  },
}));
