import { create } from "zustand";

let _nextId = 0;

export const useToastStore = create((set) => ({
  toasts: [],
  show(message, kind = "ok") {
    const id = ++_nextId;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 3000);
  },
}));

export function showToast(message, kind) {
  useToastStore.getState().show(message, kind);
}
