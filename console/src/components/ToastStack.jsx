import { useToastStore } from "../store/toastStore";

export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  if (!toasts.length) return null;

  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind || ""} show`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
