/**
 * Shared formatting helpers for production-grade, high-signal data display.
 * Used across Dashboard, Audit and AI Intelligence views so numbers, timestamps
 * and identifiers render consistently (tabular figures, compact large numbers,
 * fixed-width ISO timestamps with relative hints).
 */

const _compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** Compact large numbers: 14000 → "14K", 2_300_000 → "2.3M". Small ints pass through. */
export function formatNumber(n) {
  if (n == null || n === "") return "—";
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return String(n);
  if (Math.abs(num) < 1000) return String(num);
  return _compact.format(num);
}

/** Fixed-width ISO-ish timestamp: "2026-06-05 15:04:22" — scannable & column-aligned. */
export function formatTimestamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Relative time: "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return "just now";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}
