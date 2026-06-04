import { useState, useEffect } from "react";
import { useViewStore } from "../store/viewStore";

const SHORTCUTS = [
  { keys: "Ctrl+1", desc: "Dashboard" },
  { keys: "Ctrl+2", desc: "AI Chat" },
  { keys: "Ctrl+3", desc: "Audit" },
  { keys: "Ctrl+4", desc: "AI Intelligence" },
  { keys: "Ctrl+/", desc: "Keyboard shortcuts" },
  { keys: "Escape", desc: "Close overlay" },
];

export function useKeyboardShortcuts() {
  const setActiveView = useViewStore((s) => s.setActiveView);
  const [kbdOpen, setKbdOpen] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      const isInput = ["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement?.tagName
      );
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key === "/") {
        e.preventDefault();
        setKbdOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setKbdOpen(false);
        return;
      }
      if (isInput && !ctrl) return;
      if (ctrl && e.key === "1") { e.preventDefault(); setActiveView("dashboard"); }
      if (ctrl && e.key === "2") { e.preventDefault(); setActiveView("chat"); }
      if (ctrl && e.key === "3") { e.preventDefault(); setActiveView("audit"); }
      if (ctrl && e.key === "4") { e.preventDefault(); setActiveView("intelligence"); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setActiveView]);

  return { kbdOpen, setKbdOpen };
}

export function KbdOverlay({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="kbd-overlay open" onClick={onClose}>
      <div className="kbd-panel" onClick={(e) => e.stopPropagation()}>
        <div className="kbd-title">
          Keyboard Shortcuts
          <button className="kbd-close" onClick={onClose}>&times;</button>
        </div>
        {SHORTCUTS.map((s) => (
          <div className="kbd-row" key={s.keys}>
            <kbd className="kbd-key">{s.keys}</kbd>
            <span className="kbd-desc">{s.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
