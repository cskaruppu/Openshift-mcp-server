import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useActiveCluster } from "../store/clusterStore";
import { useChatStore } from "../store/chatStore";
import { clusterUrl } from "../api/client";
import { showToast } from "../store/toastStore";
import { ChatMessageBody } from "./ChatTokens";

/* ── Provider metadata ── */
const PROVIDER_META = {
  builtin:   { icon: "TA", color: "#e04040",  label: "Built-in Analysis", desc: "No API key needed" },
  anthropic: { icon: "Cl", color: "#d97706",  label: "Anthropic",         desc: "Claude Sonnet / Opus" },
  openai:    { icon: "GP", color: "#10a37f",  label: "OpenAI",            desc: "GPT-4 / GPT-4o" },
  azure:     { icon: "Az", color: "#0078d4",  label: "Azure OpenAI",      desc: "Azure-hosted GPT" },
  google:    { icon: "Gm", color: "#4285f4",  label: "Google Gemini",     desc: "Gemini Pro" },
  bedrock:   { icon: "Bk", color: "#ff9900",  label: "AWS Bedrock",       desc: "Claude / Titan" },
  ollama:    { icon: "Ol", color: "#333",      label: "Ollama",            desc: "Local models" },
};

/* ── Slash commands ── */
const SLASH_COMMANDS = [
  { cmd: "/help",            desc: "Show available commands",                cat: "general" },
  { cmd: "/health",          desc: "Cluster health summary",                 cat: "cluster" },
  { cmd: "/pods",            desc: "Show pod summary across cluster",         cat: "cluster" },
  { cmd: "/nodes",           desc: "List cluster nodes with status",         cat: "cluster" },
  { cmd: "/deployments",     desc: "List deployments across namespaces",     cat: "cluster" },
  { cmd: "/events",          desc: "Recent cluster events",                  cat: "cluster" },
  { cmd: "/alerts",          desc: "Active alerts",                          cat: "cluster" },
  { cmd: "/pipelines",       desc: "List Tekton pipelines",                  cat: "cluster" },
  { cmd: "/vms",             desc: "List KubeVirt virtual machines",         cat: "cluster" },
  { cmd: "/security",        desc: "Security audit",                         cat: "security" },
  { cmd: "/compliance",      desc: "CIS / NIST 800-190 compliance check",    cat: "security" },
  { cmd: "/scc-audit",       desc: "Audit pods for over-privileged SCC",     cat: "security" },
  { cmd: "/explain-scc",     desc: "Explain which SCC is assigned to a pod", cat: "security" },
  { cmd: "/generate-policy", desc: "Generate K8s/OCP policy from prompt",    cat: "security" },
  { cmd: "/upgrade-check",   desc: "Check cluster upgrade readiness",        cat: "intelligence" },
  { cmd: "/cert-check",      desc: "Check for expiring TLS certificates",    cat: "intelligence" },
  { cmd: "/operator-health", desc: "Diagnose OLM operator issues",           cat: "intelligence" },
  { cmd: "/what-if",         desc: "Predict impact of a change",             cat: "intelligence" },
  { cmd: "/drift",           desc: "Detect configuration drift across ACM",  cat: "intelligence" },
  { cmd: "/timeline",        desc: "Build incident timeline",                cat: "intelligence" },
  { cmd: "/cost",            desc: "Analyze workload cost efficiency",       cat: "intelligence" },
  { cmd: "/topology",        desc: "Service dependency map for a namespace", cat: "intelligence" },
];

const CAT_COLORS = { general: "#a1a1aa", cluster: "#3b82f6", security: "#ef4444", intelligence: "#8b5cf6" };

/* ── Welcome category cards ── */
const WELCOME_CARDS = [
  { title: "Cluster Health",      desc: "Check cluster health and status",          bg: "#22c55e", icon: "❤", prompt: "Summarize cluster health" },
  { title: "Troubleshoot",        desc: "Show CrashLoopBackOff pods and failures",  bg: "#ef4444", icon: "⚠", prompt: "Show pods in CrashLoopBackOff" },
  { title: "Security Audit",      desc: "Run a security audit",                     bg: "#f59e0b", icon: "\u{1F6E1}", prompt: "Run a security audit" },
  { title: "Resources & Metrics", desc: "Show top pods by CPU and memory",          bg: "#3b82f6", icon: "\u{1F4CA}", prompt: "Show top pods by CPU and memory" },
];

const QUICK_SUGGESTIONS = [
  "Summarize cluster health",
  "Show pods at risk",
  "List degraded operators",
  "Check node resource usage",
];

/* ── Thinking stages config ── */
const STAGE_DEFS = [
  { key: "parse",    label: "Understanding your question..." },
  { key: "query",    label: "Querying cluster data" },
  { key: "generate", label: "Generating response" },
];

/* ── Follow-up suggestions by keyword heuristic ── */
function getFollowUps(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  if (lower.includes("health") || lower.includes("status"))
    return ["Show failing pods", "Check node pressure", "List recent events"];
  if (lower.includes("pod") || lower.includes("crash"))
    return ["Show pod logs", "Describe the failing pod", "Check resource limits"];
  if (lower.includes("security") || lower.includes("audit"))
    return ["List RBAC misconfigurations", "Show privileged containers", "Check network policies"];
  if (lower.includes("node"))
    return ["Show node resource usage", "List taints and tolerations", "Check disk pressure"];
  if (lower.includes("deploy"))
    return ["Show rollout history", "Check replica status", "List failed deployments"];
  return ["Show cluster health", "List recent events", "Check resource usage"];
}

/* ── Inline styles (kept inside JS to avoid CSS file bloat for new elements) ── */
const S = {
  /* Provider switcher */
  providerToggle: {
    display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
    background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 20,
    padding: "4px 12px 4px 6px", fontSize: 12, fontWeight: 600, color: "var(--text)",
    userSelect: "none", transition: "border-color .15s", flexShrink: 0,
  },
  providerIcon: (color) => ({
    width: 24, height: 24, borderRadius: "50%", background: color, color: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 10, fontWeight: 800, flexShrink: 0, lineHeight: 1,
  }),
  providerDropdown: {
    position: "absolute", bottom: "calc(100% + 8px)", left: 0,
    background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
    boxShadow: "0 12px 40px rgba(0,0,0,.45)", padding: 6, minWidth: 260, zIndex: 100,
  },
  providerOption: (active) => ({
    display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
    borderRadius: 8, cursor: "pointer", background: active ? "var(--hover)" : "transparent",
    border: "none", width: "100%", textAlign: "left", color: "var(--text)",
    transition: "background .1s",
  }),
  providerLabel: { fontSize: 13, fontWeight: 600 },
  providerDesc:  { fontSize: 11, color: "var(--text2)" },

  /* Slash command palette */
  slashPalette: {
    position: "absolute", bottom: "calc(100% + 8px)", left: 0, right: 0,
    background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
    boxShadow: "0 12px 40px rgba(0,0,0,.45)", maxHeight: 320, overflowY: "auto",
    zIndex: 100, padding: 6,
  },
  slashItem: (active) => ({
    display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
    borderRadius: 8, cursor: "pointer", background: active ? "var(--hover)" : "transparent",
    border: "none", width: "100%", textAlign: "left", color: "var(--text)",
    transition: "background .1s",
  }),
  slashCmd: { fontSize: 13, fontWeight: 700, fontFamily: "monospace" },
  slashDesc: { fontSize: 12, color: "var(--text2)", flex: 1 },
  slashCatDot: (color) => ({
    width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0,
  }),

  /* Welcome */
  welcomeGrid: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 540, margin: "0 auto 20px",
  },
  welcomeCard: {
    background: "var(--card)", border: "1px solid var(--border)", borderRadius: 14,
    padding: 20, cursor: "pointer", transition: "border-color .15s, transform .15s",
    textAlign: "left",
  },
  welcomeIconWrap: (bg) => ({
    width: 40, height: 40, borderRadius: 10, background: bg, color: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 18, marginBottom: 10,
  }),
  welcomeTitle: { fontSize: 14, fontWeight: 700, marginBottom: 4 },
  welcomeDesc: { fontSize: 12, color: "var(--text2)", lineHeight: 1.5 },
  sugGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, maxWidth: 540, margin: "0 auto" },

  /* Thinking stages */
  stageBox: {
    display: "flex", flexDirection: "column", gap: 6, padding: "12px 16px",
    background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
    marginBottom: 8, maxWidth: "75%",
  },
  stageRow: (state) => ({
    display: "flex", alignItems: "center", gap: 8, fontSize: 13,
    color: state === "done" ? "var(--ok)" : state === "active" ? "var(--text)" : "var(--text2)",
    opacity: state === "pending" ? 0.45 : 1,
    transition: "opacity .2s, color .2s",
  }),

  /* Message actions */
  msgActions: {
    display: "flex", gap: 4, marginTop: 6,
  },
  actionBtn: {
    background: "none", border: "1px solid transparent", borderRadius: 6,
    padding: "3px 8px", cursor: "pointer", fontSize: 12, color: "var(--text2)",
    transition: "all .15s", display: "flex", alignItems: "center", gap: 4,
  },

  /* Tool call card */
  toolCard: {
    background: "rgba(99,102,241,.06)", border: "1px solid rgba(99,102,241,.15)",
    borderRadius: 10, padding: "10px 14px", marginBottom: 8, fontSize: 12,
  },
  toolName: { fontWeight: 700, color: "#818cf8", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 },
  toolArgs: {
    fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 11, color: "var(--text2)",
    background: "rgba(0,0,0,.2)", borderRadius: 6, padding: "6px 10px",
    maxHeight: 80, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
  },

  /* Follow-up chips */
  followUps: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 },
  followBtn: {
    background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 20,
    padding: "5px 14px", fontSize: 12, color: "var(--text2)", cursor: "pointer",
    transition: "all .15s",
  },

  /* Pill input bar */
  inputBar: {
    display: "flex", alignItems: "flex-end", gap: 0,
    padding: "10px 24px 16px", borderTop: "1px solid var(--border)",
    position: "relative",
  },
  inputPill: {
    display: "flex", alignItems: "flex-end", gap: 8, flex: 1,
    background: "var(--card)", border: "1px solid var(--border)", borderRadius: 24,
    padding: "6px 6px 6px 6px", transition: "border-color .15s",
  },
  inputPillFocused: {
    borderColor: "var(--accent2)",
  },
  textarea: {
    flex: 1, background: "transparent", border: "none", color: "var(--text)",
    fontSize: 14, resize: "none", fontFamily: "inherit", outline: "none",
    padding: "6px 8px", lineHeight: 1.5, maxHeight: 120, minHeight: 32,
  },
  sendBtn: (active) => ({
    width: 36, height: 36, borderRadius: "50%", border: "none", flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: active ? "pointer" : "not-allowed",
    background: active ? "var(--accent2)" : "var(--border)",
    color: "#fff", fontSize: 16, transition: "background .15s",
  }),
};


export function ChatView() {
  const cluster = useActiveCluster();
  const conv = useChatStore((s) => s.byCluster[cluster]) || { messages: [], conversationId: null };
  const { addMessage, updateLastAssistant, setConversationId, clear } = useChatStore();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");        // current stage key
  const [completedStages, setCompletedStages] = useState(new Set());
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [toolCalls, setToolCalls] = useState([]); // tool trace for current response
  const [followUps, setFollowUps] = useState([]);
  const [inputFocused, setInputFocused] = useState(false);

  /* Provider state */
  const [providers, setProviders] = useState({});
  const [activeProvider, setActiveProvider] = useState("builtin");
  const [providerOpen, setProviderOpen] = useState(false);

  /* Slash palette state */
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);

  /* Message action state */
  const [likedMsgs, setLikedMsgs] = useState(new Set());
  const [dislikedMsgs, setDislikedMsgs] = useState(new Set());

  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const providerRef = useRef(null);
  const slashRef = useRef(null);

  /* ── Auto-scroll ── */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conv.messages, stage, toolCalls]);

  /* ── Abort on cluster switch ── */
  useEffect(() => {
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [cluster]);

  /* ── Seed from Emergency Actions ── */
  const takeSeed = useChatStore((s) => s.takeSeed);
  useEffect(() => {
    const seed = takeSeed(cluster);
    if (seed) setInput(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster]);

  /* ── Load LLM providers on mount ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(clusterUrl("/api/settings/llm", cluster));
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.providers) setProviders(data.providers);
        if (data.defaultProvider) setActiveProvider(data.defaultProvider);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [cluster]);

  /* ── Close dropdowns on outside click ── */
  useEffect(() => {
    function onDoc(e) {
      if (providerOpen && providerRef.current && !providerRef.current.contains(e.target)) setProviderOpen(false);
      if (slashOpen && slashRef.current && !slashRef.current.contains(e.target)) setSlashOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [providerOpen, slashOpen]);

  /* ── Conversation list ── */
  const allClusters = useChatStore((s) => s.byCluster);
  const conversations = useMemo(() => {
    const list = [];
    for (const [c, data] of Object.entries(allClusters)) {
      if (data.messages.length > 0) {
        const firstUserMsg = data.messages.find((m) => m.role === "user");
        const preview = firstUserMsg?.text || data.messages[0]?.text || "(empty)";
        list.push({ cluster: c, preview: preview.slice(0, 60), count: data.messages.length });
      }
    }
    return list;
  }, [allClusters]);

  const filteredConversations = sidebarSearch
    ? conversations.filter((c) => c.cluster.toLowerCase().includes(sidebarSearch.toLowerCase()) || c.preview.toLowerCase().includes(sidebarSearch.toLowerCase()))
    : conversations;

  /* ── Slash command filtering ── */
  const filteredSlash = useMemo(() => {
    if (!slashFilter) return SLASH_COMMANDS;
    const q = slashFilter.toLowerCase();
    return SLASH_COMMANDS.filter((s) => s.cmd.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q));
  }, [slashFilter]);

  /* ── Input change handler with slash detection ── */
  const handleInputChange = useCallback((e) => {
    const val = e.target.value;
    setInput(val);

    // Detect slash at start of input
    if (val.startsWith("/")) {
      setSlashOpen(true);
      setSlashFilter(val);
      setSlashIdx(0);
    } else {
      setSlashOpen(false);
      setSlashFilter("");
    }
  }, []);

  /* ── Pick a slash command ── */
  const pickSlash = useCallback((cmd) => {
    setInput(cmd + " ");
    setSlashOpen(false);
    setSlashFilter("");
    textareaRef.current?.focus();
  }, []);

  /* ── New chat ── */
  function handleNewChat() {
    clear(cluster);
    setInput("");
    setToolCalls([]);
    setFollowUps([]);
    setCompletedStages(new Set());
    showToast("Chat cleared", "ok");
  }

  /* ── Export ── */
  function exportConversation() {
    if (!conv.messages.length) return;
    const data = { cluster, messages: conv.messages, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${cluster}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Conversation exported", "ok");
  }

  /* ── Copy message text ── */
  function copyMessage(text) {
    navigator.clipboard.writeText(text).then(() => showToast("Copied to clipboard", "ok")).catch(() => {});
  }

  /* ── Retry last user message ── */
  function retryLast() {
    const lastUser = [...conv.messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      setInput(lastUser.text);
    }
  }

  /* ── Send message (optionally with an explicit text override) ── */
  async function sendText(text) { return send(text); }
  async function send(override) {
    const msg = (typeof override === "string" ? override : input).trim();
    if (!msg || busy) return;
    setInput("");
    setSlashOpen(false);
    setFollowUps([]);
    setToolCalls([]);
    setCompletedStages(new Set());
    addMessage(cluster, { role: "user", text: msg });
    addMessage(cluster, { role: "assistant", text: "", toolCalls: [], followUps: [] });
    setBusy(true);
    setStage("parse");

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const sendingCluster = cluster;
    const currentToolCalls = [];

    try {
      const res = await fetch(clusterUrl("/api/chat", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Cluster-Context": cluster },
        body: JSON.stringify({ message: msg, conversationId: conv.conversationId, stream: true, provider: activeProvider, cluster }),
        signal: ctrl.signal,
      });

      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("text/event-stream")) {
        const data = res.ok ? await res.json() : { error: `Server error ${res.status}` };
        updateLastAssistant(sendingCluster, data.reply || data.error || "No response");
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let full = "";
        const done_stages = new Set();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
              const evt = JSON.parse(payload);
              if (evt.stage) {
                // Mark previous stage as done
                if (stage) done_stages.add(stage);
                setStage(evt.stage);
                setCompletedStages(new Set(done_stages));
              }
              if (evt.delta) {
                full += evt.delta;
                updateLastAssistant(sendingCluster, full);
              }
              if (evt.toolCall) {
                currentToolCalls.push(evt.toolCall);
                setToolCalls([...currentToolCalls]);
              }
              if (evt.done) {
                if (evt.conversationId) setConversationId(sendingCluster, evt.conversationId);
                // All stages done
                done_stages.add("parse");
                done_stages.add("query");
                done_stages.add("generate");
                setCompletedStages(new Set(done_stages));
              }
            } catch { /* ignore non-JSON keepalives */ }
          }
        }
        if (!full) updateLastAssistant(sendingCluster, "(no response)");
        // Generate follow-ups based on the response
        setFollowUps(getFollowUps(full));
      }
    } catch (e) {
      if (e.name !== "AbortError") updateLastAssistant(sendingCluster, "Error: " + e.message);
    } finally {
      setBusy(false);
      setStage("");
      abortRef.current = null;
    }
  }

  /* ── Keyboard in textarea ── */
  function handleKeyDown(e) {
    if (slashOpen && filteredSlash.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, filteredSlash.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickSlash(filteredSlash[slashIdx].cmd);
        return;
      }
      if (e.key === "Escape") {
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  /* ── Active provider meta ── */
  const activeMeta = PROVIDER_META[activeProvider] || PROVIDER_META.builtin;

  /* ── Available provider keys (enabled ones from API) ── */
  const availableProviders = useMemo(() => {
    const keys = Object.keys(providers).filter((k) => providers[k]?.enabled);
    // Always include builtin
    if (!keys.includes("builtin")) keys.unshift("builtin");
    return keys;
  }, [providers]);

  /* ── Determine stage state for each thinking step ── */
  function stageState(key) {
    if (completedStages.has(key)) return "done";
    if (stage === key) return "active";
    return "pending";
  }

  /* ── Render spinner/check ── */
  function StageIcon({ state }) {
    if (state === "done") return <span style={{ color: "var(--ok)", fontSize: 14 }}>{"✓"}</span>;
    if (state === "active") return (
      <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid var(--accent2)", borderTopColor: "transparent", borderRadius: "50%", animation: "spin .8s linear infinite" }} />
    );
    return <span style={{ color: "var(--text2)", fontSize: 14 }}>{"○"}</span>;
  }

  /* ── Abort handler ── */
  function handleAbort() {
    if (abortRef.current) {
      abortRef.current.abort();
      showToast("Request aborted", "warn");
    }
  }

  return (
    <div className="chat-layout">
      {/* ── Sidebar ── */}
      <aside className="chat-sidebar">
        <div className="chat-sidebar-header">
          <button className="chat-new-btn" onClick={handleNewChat}>+ New Chat</button>
        </div>
        <div className="chat-sidebar-search">
          <input
            type="text"
            placeholder="Search conversations..."
            value={sidebarSearch}
            onChange={(e) => setSidebarSearch(e.target.value)}
          />
        </div>
        <div className="chat-sidebar-list">
          {filteredConversations.length === 0 && (
            <div className="chat-sidebar-empty">No conversations yet</div>
          )}
          {filteredConversations.map((c) => (
            <div
              key={c.cluster}
              className={"chat-sidebar-item" + (c.cluster === cluster ? " active" : "")}
            >
              <div className="chat-sidebar-item-cluster">{c.cluster === "local" ? "Hub" : c.cluster}</div>
              <div className="chat-sidebar-item-preview">{c.preview}</div>
              <div className="chat-sidebar-item-count">{c.count} msgs</div>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main chat area ── */}
      <div className="chat-view">
        <div className="chat-header-bar">
          <h2 className="chat-title">AI Chat</h2>
          <span className="scope-chip">Scope: {cluster === "local" ? "Hub (local)" : cluster}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="chat-clear" onClick={exportConversation} title="Export conversation" disabled={!conv.messages.length}>Export</button>
            <button className="chat-clear" onClick={handleNewChat} title="Clear this cluster's conversation">Clear</button>
            {busy && (
              <button className="chat-clear" onClick={handleAbort} title="Abort current request" style={{ borderColor: "var(--crit)", color: "var(--crit)" }}>Abort</button>
            )}
          </div>
        </div>

        {/* ── Message scroll area ── */}
        <div className="chat-scroll" ref={scrollRef}>
          {/* ── Welcome screen ── */}
          {conv.messages.length === 0 && (
            <div className="chat-empty" style={{ maxWidth: 600 }}>
              <div className="chat-empty-icon">{"\u{1F916}"}</div>
              <div className="chat-empty-title">Ask about this cluster</div>
              <div className="chat-empty-desc" style={{ marginBottom: 24 }}>
                AI-powered cluster intelligence scoped to <strong>{cluster === "local" ? "the hub" : cluster}</strong>.
                Try a slash command or pick a category below.
              </div>

              {/* 2x2 category cards */}
              <div style={S.welcomeGrid}>
                {WELCOME_CARDS.map((card) => (
                  <div
                    key={card.title}
                    style={S.welcomeCard}
                    className="welcome-card-hover"
                    onClick={() => { setInput(card.prompt); }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = card.bg; e.currentTarget.style.transform = "translateY(-2px)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.transform = "none"; }}
                  >
                    <div style={S.welcomeIconWrap(card.bg)}>{card.icon}</div>
                    <div style={S.welcomeTitle}>{card.title}</div>
                    <div style={S.welcomeDesc}>{card.desc}</div>
                  </div>
                ))}
              </div>

              {/* 2-col suggestion buttons */}
              <div style={S.sugGrid}>
                {QUICK_SUGGESTIONS.map((q) => (
                  <button key={q} className="chat-quick-btn" onClick={() => setInput(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Messages ── */}
          {conv.messages.map((m, i) => (
            <div key={i}>
              <div className={"chat-msg " + m.role}>
                <div className="chat-avatar">
                  {m.role === "user" ? "You" : (
                    <span style={{ color: activeMeta.color, fontSize: 11, fontWeight: 800 }}>{activeMeta.icon}</span>
                  )}
                </div>
                {m.role === "assistant" ? (
                  <div style={{ maxWidth: "75%" }}>
                    {/* Thinking stages - show while streaming for last assistant message */}
                    {busy && i === conv.messages.length - 1 && stage && (
                      <div style={S.stageBox}>
                        {STAGE_DEFS.map((sd) => {
                          const st = stageState(sd.key);
                          return (
                            <div key={sd.key} style={S.stageRow(st)}>
                              <StageIcon state={st} />
                              <span>{sd.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Tool call cards - show during streaming for last message */}
                    {i === conv.messages.length - 1 && toolCalls.length > 0 && toolCalls.map((tc, ti) => (
                      <div key={ti} style={S.toolCard}>
                        <div style={S.toolName}>
                          <span style={{ fontSize: 14 }}>{"⚙"}</span>
                          <span>{tc.name}</span>
                        </div>
                        {tc.arguments && (
                          <div style={S.toolArgs}>
                            {typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments, null, 2)}
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Message bubble — markdown + interactive token cards */}
                    {m.text && <ChatMessageBody text={m.text} cluster={cluster} onQuery={(q) => { setInput(q); setTimeout(() => sendText(q), 0); }} />}

                    {/* Message actions - only on completed assistant messages with content */}
                    {m.text && !(busy && i === conv.messages.length - 1) && (
                      <div style={S.msgActions}>
                        <button
                          style={S.actionBtn}
                          onClick={() => copyMessage(m.text)}
                          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "var(--text2)"; }}
                          title="Copy"
                        >
                          {"\u{1F4CB}"} Copy
                        </button>
                        <button
                          style={{ ...S.actionBtn, color: likedMsgs.has(i) ? "var(--ok)" : "var(--text2)" }}
                          onClick={() => {
                            setLikedMsgs((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
                            setDislikedMsgs((prev) => { const n = new Set(prev); n.delete(i); return n; });
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; }}
                          title="Like"
                        >
                          {likedMsgs.has(i) ? "\u{1F44D}" : "\u{1F44D}"} Like
                        </button>
                        <button
                          style={{ ...S.actionBtn, color: dislikedMsgs.has(i) ? "var(--crit)" : "var(--text2)" }}
                          onClick={() => {
                            setDislikedMsgs((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
                            setLikedMsgs((prev) => { const n = new Set(prev); n.delete(i); return n; });
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; }}
                          title="Dislike"
                        >
                          {"\u{1F44E}"} Dislike
                        </button>
                        <button
                          style={S.actionBtn}
                          onClick={retryLast}
                          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "var(--text2)"; }}
                          title="Retry"
                        >
                          {"↻"} Retry
                        </button>
                      </div>
                    )}

                    {/* Follow-up suggestions - only after the final completed assistant message */}
                    {!busy && i === conv.messages.length - 1 && followUps.length > 0 && (
                      <div style={S.followUps}>
                        {followUps.map((fu) => (
                          <button
                            key={fu}
                            style={S.followBtn}
                            onClick={() => setInput(fu)}
                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent2)"; e.currentTarget.style.color = "var(--text)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text2)"; }}
                          >
                            {fu}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="chat-bubble">{m.text}</div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* ── Input bar (pill style) ── */}
        <div style={S.inputBar}>
          {/* Slash palette */}
          {slashOpen && filteredSlash.length > 0 && (
            <div style={S.slashPalette} ref={slashRef}>
              {filteredSlash.map((sc, idx) => (
                <button
                  key={sc.cmd}
                  style={S.slashItem(idx === slashIdx)}
                  onClick={() => pickSlash(sc.cmd)}
                  onMouseEnter={() => setSlashIdx(idx)}
                >
                  <span style={S.slashCatDot(CAT_COLORS[sc.cat])} />
                  <span style={S.slashCmd}>{sc.cmd}</span>
                  <span style={S.slashDesc}>{sc.desc}</span>
                </button>
              ))}
            </div>
          )}

          <div style={{ ...S.inputPill, ...(inputFocused ? S.inputPillFocused : {}) }}>
            {/* Provider switcher */}
            <div style={{ position: "relative" }} ref={providerRef}>
              <div
                style={S.providerToggle}
                onClick={() => setProviderOpen((v) => !v)}
                title={`Provider: ${activeMeta.label}`}
              >
                <div style={S.providerIcon(activeMeta.color)}>{activeMeta.icon}</div>
                <span style={{ whiteSpace: "nowrap" }}>{activeMeta.label}</span>
                <span style={{ fontSize: 10, color: "var(--text2)", marginLeft: 2 }}>{providerOpen ? "▲" : "▼"}</span>
              </div>
              {providerOpen && (
                <div style={S.providerDropdown}>
                  {(availableProviders.length > 0 ? availableProviders : Object.keys(PROVIDER_META)).map((key) => {
                    const meta = PROVIDER_META[key] || PROVIDER_META.builtin;
                    return (
                      <button
                        key={key}
                        style={S.providerOption(key === activeProvider)}
                        onClick={() => { setActiveProvider(key); setProviderOpen(false); showToast(`Switched to ${meta.label}`, "ok"); }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--hover)"; }}
                        onMouseLeave={(e) => { if (key !== activeProvider) e.currentTarget.style.background = "transparent"; }}
                      >
                        <div style={S.providerIcon(meta.color)}>{meta.icon}</div>
                        <div>
                          <div style={S.providerLabel}>{meta.label}</div>
                          <div style={S.providerDesc}>{meta.desc}</div>
                        </div>
                        {key === activeProvider && <span style={{ marginLeft: "auto", color: "var(--ok)", fontSize: 14 }}>{"✓"}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              style={S.textarea}
              placeholder={`Message AI about ${cluster === "local" ? "the hub cluster" : cluster}... (type / for commands)`}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              rows={1}
            />

            {/* Send button (circle) */}
            {busy ? (
              <button
                style={{ ...S.sendBtn(true), background: "var(--crit)" }}
                onClick={handleAbort}
                title="Abort"
              >
                {"■"}
              </button>
            ) : (
              <button
                style={S.sendBtn(!!input.trim())}
                onClick={send}
                disabled={!input.trim()}
                title="Send"
              >
                {"↑"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Inline keyframe for spinner */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .welcome-card-hover:hover {
          box-shadow: 0 4px 20px rgba(0,0,0,.2);
        }
      `}</style>
    </div>
  );
}
