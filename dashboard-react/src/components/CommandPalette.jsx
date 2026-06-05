import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useViewStore } from "../store/viewStore";
import { useChatStore } from "../store/chatStore";
import { useThemeStore } from "../store/themeStore";
import { useActiveCluster } from "../store/clusterStore";

/**
 * Global command palette (⌘K / Ctrl+K). A single, fast entry point to navigate,
 * fire agentic actions and run quick commands — the hallmark of a premium app.
 * Self-contained: drives the view / chat / theme stores directly.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const cluster = useActiveCluster();
  const setActiveView = useViewStore((s) => s.setActiveView);
  const setSeed = useChatStore((s) => s.setSeed);
  const clearChat = useChatStore((s) => s.clear);
  const toggleTheme = useThemeStore((s) => s.toggle);

  const go = useCallback((view) => { setActiveView(view); setOpen(false); }, [setActiveView]);
  const ask = useCallback((prompt) => {
    setSeed(cluster, prompt);
    setActiveView("chat");
    setOpen(false);
  }, [cluster, setSeed, setActiveView]);

  const commands = useMemo(() => [
    // Navigate
    { id: "nav-dash", group: "Navigate", label: "Dashboard", hint: "Ctrl+1", icon: "▥", run: () => go("dashboard"), kw: "home overview vitals" },
    { id: "nav-chat", group: "Navigate", label: "AI Chat", hint: "Ctrl+2", icon: "✦", run: () => go("chat"), kw: "assistant agent ask" },
    { id: "nav-audit", group: "Navigate", label: "Audit & Compliance", hint: "Ctrl+3", icon: "🛡", run: () => go("audit"), kw: "compliance cis trail change request" },
    { id: "nav-intel", group: "Navigate", label: "AI Intelligence", hint: "Ctrl+4", icon: "◎", run: () => go("intelligence"), kw: "insights incidents predictions alerts" },
    // Agentic actions
    { id: "act-rightsize", group: "AI Actions", label: "Right-size workloads", hint: "/rightsize", icon: "⊞", run: () => ask("/rightsize"), kw: "cpu memory requests limits overcommit optimize" },
    { id: "act-triage", group: "AI Actions", label: "Triage failing pods", hint: "/triage", icon: "⚑", run: () => ask("/triage"), kw: "crashloop oomkilled imagepull restart fix" },
    { id: "act-health", group: "AI Actions", label: "Cluster health summary", hint: "/health", icon: "♥", run: () => ask("/health"), kw: "status nodes operators" },
    { id: "act-security", group: "AI Actions", label: "Run security audit", hint: "/security", icon: "🔒", run: () => ask("/security"), kw: "rbac scc compliance" },
    { id: "act-upgrade", group: "AI Actions", label: "Check upgrade readiness", hint: "/upgrade-check", icon: "↑", run: () => ask("/upgrade-check"), kw: "version preflight" },
    // Quick actions
    { id: "q-newchat", group: "Quick Actions", label: "New chat", hint: "", icon: "＋", run: () => { clearChat(cluster); go("chat"); }, kw: "conversation reset" },
    { id: "q-theme", group: "Quick Actions", label: "Toggle light / dark theme", hint: "", icon: "◐", run: () => { toggleTheme(); setOpen(false); }, kw: "dark light appearance" },
    { id: "q-refresh", group: "Quick Actions", label: "Refresh dashboard", hint: "", icon: "↻", run: () => window.location.reload(), kw: "reload" },
  ], [go, ask, clearChat, cluster, toggleTheme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => (c.label + " " + c.group + " " + (c.kw || "") + " " + c.hint).toLowerCase().includes(q));
  }, [commands, query]);

  // Group the flat filtered list for display while keeping a flat index for nav.
  const groups = useMemo(() => {
    const m = new Map();
    filtered.forEach((c, i) => {
      if (!m.has(c.group)) m.set(c.group, []);
      m.get(c.group).push({ ...c, index: i });
    });
    return [...m.entries()];
  }, [filtered]);

  // Global ⌘K / Ctrl+K toggle, plus a custom event so UI affordances can open it.
  useEffect(() => {
    const handler = (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const openEvt = () => setOpen(true);
    document.addEventListener("keydown", handler);
    window.addEventListener("open-command-palette", openEvt);
    return () => {
      document.removeEventListener("keydown", handler);
      window.removeEventListener("open-command-palette", openEvt);
    };
  }, []);

  // Reset state + focus on open.
  useEffect(() => {
    if (open) { setQuery(""); setActive(0); setTimeout(() => inputRef.current?.focus(), 20); }
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  function onKeyDown(e) {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); filtered[active]?.run(); }
  }

  // Keep the active row in view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-cmd-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  return (
    <div className="cmdk-overlay" onClick={() => setOpen(false)}>
      <div className="cmdk-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="cmdk-input-row">
          <svg className="cmdk-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Search actions, navigate, ask the agent…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Command palette search"
          />
          <kbd className="cmdk-esc">Esc</kbd>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {filtered.length === 0 && <div className="cmdk-empty">No matching commands</div>}
          {groups.map(([group, items]) => (
            <div key={group} className="cmdk-group">
              <div className="cmdk-group-label">{group}</div>
              {items.map((c) => (
                <button
                  key={c.id}
                  data-cmd-index={c.index}
                  className={"cmdk-item" + (c.index === active ? " active" : "")}
                  onMouseMove={() => setActive(c.index)}
                  onClick={() => c.run()}
                >
                  <span className="cmdk-item-icon">{c.icon}</span>
                  <span className="cmdk-item-label">{c.label}</span>
                  {c.hint && <kbd className="cmdk-item-hint">{c.hint}</kbd>}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="cmdk-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
