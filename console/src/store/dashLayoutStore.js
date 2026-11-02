import { create } from "zustand";

// Which Dashboard layout this person sees: "classic" (the original, the default)
// or "new" (DashboardNext). Kept per browser, like the theme; switching is
// instant and changes nothing else.
const KEY = "mcp-dash-layout";
const read = () => { try { return localStorage.getItem(KEY) === "new" ? "new" : "classic"; } catch { return "classic"; } };

export const useDashLayout = create((set) => ({
  layout: read(),
  setLayout(layout) {
    const next = layout === "new" ? "new" : "classic";
    try { localStorage.setItem(KEY, next); } catch { /* private window */ }
    set({ layout: next });
  },
}));
