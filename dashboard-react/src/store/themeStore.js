import { create } from "zustand";

const saved = typeof localStorage !== "undefined" ? localStorage.getItem("mcp-theme") : null;

export const useThemeStore = create((set) => ({
  theme: saved === "light" ? "light" : "dark",
  toggle() {
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      localStorage.setItem("mcp-theme", next);
      return { theme: next };
    });
  },
}));
