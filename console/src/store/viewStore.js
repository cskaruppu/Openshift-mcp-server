import { create } from "zustand";

/**
 * Active top-level view (dashboard | audit | chat | intelligence).
 * Kept separate from cluster state so switching views never changes the cluster
 * context, and switching clusters never changes the view.
 */
export const useViewStore = create((set) => ({
  activeView: "dashboard",
  setActiveView: (view) => set({ activeView: view }),
}));
