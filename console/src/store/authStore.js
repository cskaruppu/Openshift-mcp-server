import { create } from "zustand";

export const useAuthStore = create((set) => ({
  checked: false,
  authenticated: false,
  user: null,
  authMode: "password",

  setAuth(user) {
    set({ checked: true, authenticated: true, user });
  },
  setUnauthenticated(mode) {
    set({ checked: true, authenticated: false, user: null, authMode: mode || "password" });
  },
  logout() {
    set({ authenticated: false, user: null });
  },
}));
