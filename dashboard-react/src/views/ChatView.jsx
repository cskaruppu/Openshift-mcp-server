import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useActiveCluster } from "../store/clusterStore";
import { useChatStore } from "../store/chatStore";
import { clusterUrl } from "../api/client";
import { showToast } from "../store/toastStore";
import { ChatMessageBody } from "./ChatTokens";

const PROVIDER_META = {
  builtin:   { icon: "TA", color: "#e04040",  label: "Built-in Analysis", desc: "No API key needed" },
  anthropic: { icon: "Cl", color: "#d97706",  label: "Anthropic",         desc: "Claude Sonnet / Opus" },
  openai:    { icon: "GP", color: "#10a37f",  label: "OpenAI",            desc: "GPT-4 / GPT-4o" },
  azure:     { icon: "Az", color: "#0078d4",  label: "Azure OpenAI",      desc: "Azure-hosted GPT" },
  google:    { icon: "Gm", color: "#4285f4",  label: "Google Gemini",     desc: "Gemini Pro" },
  bedrock:   { icon: "Bk", color: "#ff9900",  label: "AWS Bedrock",       desc: "Claude / Titan" },
  ollama:    { icon: "Ol", color: "#333",      label: "Ollama",            desc: "Local models" },
};

const SLASH_COMMANDS = [
  { cmd: "/help",            desc: "Show available commands",                cat: "general" },
  { cmd: "/health",          desc: "Cluster health summary",                 cat: "cluster" },
  { cmd: "/pods",            desc: "Show pod summary across cluster",        cat: "cluster" },
  { cmd: "/nodes",           desc: "List cluster nodes with status",         cat: "cluster" },
  { cmd: "/deployments",     desc: "List deployments across namespaces",     cat: "cluster" },
  { cmd: "/events",          desc: "Recent cluster events",                  cat: "cluster" },
  { cmd: "/alerts",          desc: "Active alerts",                          cat: "cluster" },
  { cmd: "/pipelines",       desc: "List Tekton pipelines",                  cat: "cluster" },
  { cmd: "/vms",             desc: "List KubeVirt virtual machines",         cat: "cluster" },
  { cmd: "/security",        desc: "Security audit",                         cat: "security" },
  { cmd: "/compliance",      desc: "CIS / NIST 800-190 compliance check",   cat: "security" },
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

const CAT_COLORS = { general: "#94a3b8", cluster: "#3b82f6", security: "#ef4444", intelligence: "#8b5cf6" };
const CAT_LABELS = { general: "General", cluster: "Cluster", security: "Security", intelligence: "Intelligence" };

const WELCOME_CARDS = [
  { title: "Cluster Health",      desc: "Overall status, node readiness & operator health", color: "#22c55e", icon: "H", prompt: "Summarize cluster health" },
  { title: "Troubleshoot",        desc: "CrashLoopBackOff pods, failures & restarts",      color: "#ef4444", icon: "T", prompt: "Show pods in CrashLoopBackOff" },
  { title: "Security Audit",      desc: "RBAC, SCC, network policies & compliance",        color: "#f59e0b", icon: "S", prompt: "Run a security audit" },
  { title: "Resources & Metrics", desc: "CPU, memory, storage utilization trends",          color: "#3b82f6", icon: "R", prompt: "Show top pods by CPU and memory" },
];

const QUICK_PROMPTS = [
  "Summarize cluster health",
  "Show pods at risk",
  "List degraded operators",
  "Check node resource usage",
  "Show recent events",
  "Audit security posture",
];

const STAGE_DEFS = [
  { key: "parse",    label: "Parsing" },
  { key: "query",    label: "Querying" },
  { key: "generate", label: "Generating" },
];

function getFollowUps(text) {
  if (!text) return [];
  const l = text.toLowerCase();
  if (l.includes("health") || l.includes("status"))
    return ["Show failing pods", "Check node pressure", "List recent events"];
  if (l.includes("pod") || l.includes("crash"))
    return ["Show pod logs", "Describe the failing pod", "Check resource limits"];
  if (l.includes("security") || l.includes("audit"))
    return ["List RBAC misconfigurations", "Show privileged containers", "Check network policies"];
  if (l.includes("node"))
    return ["Show node resource usage", "List taints and tolerations", "Check disk pressure"];
  if (l.includes("deploy"))
    return ["Show rollout history", "Check replica status", "List failed deployments"];
  return ["Show cluster health", "List recent events", "Check resource usage"];
}

function timeAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60000) return "just now";
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ChatView() {
  const cluster = useActiveCluster();
  const conv = useChatStore((s) => s.byCluster[cluster]) || { messages: [], conversationId: null };
  const { addMessage, updateLastAssistant, setConversationId, clear } = useChatStore();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [completedStages, setCompletedStages] = useState(new Set());
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [toolCalls, setToolCalls] = useState([]);
  const [followUps, setFollowUps] = useState([]);
  const [inputFocused, setInputFocused] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [providers, setProviders] = useState({});
  const [activeProvider, setActiveProvider] = useState("builtin");
  const [providerOpen, setProviderOpen] = useState(false);

  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);

  const [likedMsgs, setLikedMsgs] = useState(new Set());
  const [dislikedMsgs, setDislikedMsgs] = useState(new Set());

  const [savedChats, setSavedChats] = useState([]);

  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const providerRef = useRef(null);
  const slashRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conv.messages, stage, toolCalls]);

  useEffect(() => {
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [cluster]);

  const takeSeed = useChatStore((s) => s.takeSeed);
  useEffect(() => {
    const seed = takeSeed(cluster);
    if (seed) setInput(seed);
  }, [cluster]); // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(clusterUrl("/api/chats?limit=30", cluster));
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.conversations)) setSavedChats(data.conversations);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [cluster]);

  useEffect(() => {
    function onDoc(e) {
      if (providerOpen && providerRef.current && !providerRef.current.contains(e.target)) setProviderOpen(false);
      if (slashOpen && slashRef.current && !slashRef.current.contains(e.target)) setSlashOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [providerOpen, slashOpen]);

  const allClusters = useChatStore((s) => s.byCluster);
  const conversations = useMemo(() => {
    const list = [];
    for (const [c, data] of Object.entries(allClusters)) {
      if (data.messages.length > 0) {
        const firstUser = data.messages.find((m) => m.role === "user");
        const preview = firstUser?.text || data.messages[0]?.text || "(empty)";
        list.push({ cluster: c, preview: preview.slice(0, 80), count: data.messages.length, active: c === cluster });
      }
    }
    return list;
  }, [allClusters, cluster]);

  const filteredConversations = sidebarSearch
    ? conversations.filter((c) => c.cluster.toLowerCase().includes(sidebarSearch.toLowerCase()) || c.preview.toLowerCase().includes(sidebarSearch.toLowerCase()))
    : conversations;

  const filteredSlash = useMemo(() => {
    if (!slashFilter) return SLASH_COMMANDS;
    const q = slashFilter.toLowerCase();
    return SLASH_COMMANDS.filter((s) => s.cmd.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q));
  }, [slashFilter]);

  const groupedSlash = useMemo(() => {
    const groups = {};
    for (const sc of filteredSlash) {
      (groups[sc.cat] ??= []).push(sc);
    }
    return groups;
  }, [filteredSlash]);

  const handleInputChange = useCallback((e) => {
    const val = e.target.value;
    setInput(val);
    if (val.startsWith("/")) {
      setSlashOpen(true);
      setSlashFilter(val);
      setSlashIdx(0);
    } else {
      setSlashOpen(false);
      setSlashFilter("");
    }
  }, []);

  const pickSlash = useCallback((cmd) => {
    setInput(cmd + " ");
    setSlashOpen(false);
    setSlashFilter("");
    textareaRef.current?.focus();
  }, []);

  function handleNewChat() {
    clear(cluster);
    setInput("");
    setToolCalls([]);
    setFollowUps([]);
    setCompletedStages(new Set());
    showToast("New conversation started", "ok");
  }

  function exportConversation() {
    if (!conv.messages.length) return;
    const data = { cluster, messages: conv.messages, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `chat-${cluster}-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    showToast("Exported", "ok");
  }

  function copyMessage(text) {
    navigator.clipboard.writeText(text).then(() => showToast("Copied", "ok")).catch(() => {});
  }

  function retryLast() {
    const lastUser = [...conv.messages].reverse().find((m) => m.role === "user");
    if (lastUser) sendText(lastUser.text);
  }

  const sendFeedback = useCallback(async (msgIdx, reaction) => {
    try {
      await fetch(clusterUrl("/api/chat/feedback", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conv.conversationId,
          messageIndex: msgIdx,
          reaction,
          cluster,
        }),
      });
    } catch { /* silent */ }
  }, [cluster, conv.conversationId]);

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
        const doneStages = new Set();

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
                if (stage) doneStages.add(stage);
                setStage(evt.stage);
                setCompletedStages(new Set(doneStages));
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
                doneStages.add("parse"); doneStages.add("query"); doneStages.add("generate");
                setCompletedStages(new Set(doneStages));
              }
            } catch { /* ignore */ }
          }
        }
        if (!full) updateLastAssistant(sendingCluster, "(no response)");
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

  function handleKeyDown(e) {
    if (slashOpen && filteredSlash.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => Math.min(i + 1, filteredSlash.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(filteredSlash[slashIdx].cmd); return; }
      if (e.key === "Escape") { setSlashOpen(false); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function handleAbort() {
    if (abortRef.current) { abortRef.current.abort(); showToast("Aborted", "warn"); }
  }

  const activeMeta = PROVIDER_META[activeProvider] || PROVIDER_META.builtin;

  const availableProviders = useMemo(() => {
    const keys = Object.keys(providers).filter((k) => providers[k]?.enabled);
    if (!keys.includes("builtin")) keys.unshift("builtin");
    return keys;
  }, [providers]);

  function stageState(key) {
    if (completedStages.has(key)) return "done";
    if (stage === key) return "active";
    return "pending";
  }

  const hasMessages = conv.messages.length > 0;

  return (
    <div className="ac">
      {/* ── Sidebar toggle (mobile + desktop) ── */}
      <button className="ac-sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)} title="Conversations">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        {conversations.length > 0 && <span className="ac-sidebar-badge">{conversations.length}</span>}
      </button>

      {/* ── Sidebar ── */}
      <aside className={"ac-sidebar" + (sidebarOpen ? " open" : "")}>
        <div className="ac-sidebar-head">
          <span className="ac-sidebar-title">Conversations</span>
          <button className="ac-sidebar-close" onClick={() => setSidebarOpen(false)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <button className="ac-new-btn" onClick={handleNewChat}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Chat
        </button>
        <div className="ac-sidebar-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" placeholder="Search..." value={sidebarSearch} onChange={(e) => setSidebarSearch(e.target.value)} />
        </div>
        <div className="ac-sidebar-list">
          {filteredConversations.length === 0 && <div className="ac-sidebar-empty">No conversations</div>}
          {filteredConversations.map((c) => (
            <div key={c.cluster} className={"ac-conv-item" + (c.active ? " active" : "")}>
              <div className="ac-conv-cluster">{c.cluster === "local" ? "Hub Cluster" : c.cluster}</div>
              <div className="ac-conv-preview">{c.preview}</div>
              <span className="ac-conv-count">{c.count}</span>
            </div>
          ))}
          {savedChats.length > 0 && (
            <>
              <div className="ac-sidebar-divider">Saved</div>
              {savedChats.slice(0, 15).map((ch) => (
                <div key={ch.id} className="ac-conv-item">
                  <div className="ac-conv-cluster">{ch.title || "Untitled"}</div>
                  <div className="ac-conv-preview">{ch.cluster} &middot; {timeAgo(ch.updated_at || ch.created_at)}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </aside>
      {sidebarOpen && <div className="ac-sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* ── Main chat ── */}
      <div className="ac-main">
        {/* Header */}
        <div className="ac-header">
          <div className="ac-header-left">
            <h2 className="ac-title">AI Chat</h2>
            <span className="ac-scope-chip">{cluster === "local" ? "Hub" : cluster}</span>
          </div>
          <div className="ac-header-right">
            {busy && (
              <button className="ac-header-btn ac-abort-btn" onClick={handleAbort}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                Stop
              </button>
            )}
            <button className="ac-header-btn" onClick={exportConversation} disabled={!hasMessages} title="Export">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button className="ac-header-btn" onClick={handleNewChat} title="New chat">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="ac-messages" ref={scrollRef}>
          {/* Welcome */}
          {!hasMessages && (
            <div className="ac-welcome">
              <div className="ac-welcome-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
                  <line x1="10" y1="22" x2="14" y2="22"/>
                  <line x1="9" y1="9" x2="9.01" y2="9"/>
                  <line x1="15" y1="9" x2="15.01" y2="9"/>
                </svg>
              </div>
              <h2 className="ac-welcome-title">What can I help you with?</h2>
              <p className="ac-welcome-desc">
                AI-powered cluster intelligence scoped to <strong>{cluster === "local" ? "the hub cluster" : cluster}</strong>.
                Ask anything or use <code>/</code> commands.
              </p>

              <div className="ac-welcome-grid">
                {WELCOME_CARDS.map((c) => (
                  <button key={c.title} className="ac-welcome-card" onClick={() => sendText(c.prompt)}>
                    <div className="ac-wc-icon" style={{ background: c.color }}>{c.icon}</div>
                    <div className="ac-wc-body">
                      <div className="ac-wc-title">{c.title}</div>
                      <div className="ac-wc-desc">{c.desc}</div>
                    </div>
                    <svg className="ac-wc-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                  </button>
                ))}
              </div>

              <div className="ac-quick-grid">
                {QUICK_PROMPTS.map((q) => (
                  <button key={q} className="ac-quick-btn" onClick={() => sendText(q)}>{q}</button>
                ))}
              </div>
            </div>
          )}

          {/* Message list */}
          {conv.messages.map((m, i) => {
            const isLastAI = m.role === "assistant" && i === conv.messages.length - 1;
            return (
              <div key={i} className={"ac-msg ac-msg-" + m.role}>
                <div className="ac-avatar">
                  {m.role === "user" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  ) : (
                    <div className="ac-ai-icon" style={{ background: activeMeta.color }}>{activeMeta.icon}</div>
                  )}
                </div>
                <div className="ac-msg-content">
                  {/* Thinking stages */}
                  {busy && isLastAI && stage && (
                    <div className="ac-thinking">
                      {STAGE_DEFS.map((sd) => {
                        const st = stageState(sd.key);
                        return (
                          <div key={sd.key} className={"ac-think-step " + st}>
                            <div className="ac-think-icon" />
                            <span>{sd.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Tool calls */}
                  {isLastAI && toolCalls.length > 0 && (
                    <div className="ac-tool-calls">
                      {toolCalls.map((tc, ti) => (
                        <div key={ti} className="ac-tool-card">
                          <span className="ac-tool-name">{tc.name}</span>
                          {tc.arguments && (
                            <code className="ac-tool-args">
                              {typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments, null, 2)}
                            </code>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Message body */}
                  {m.role === "assistant" ? (
                    m.text && <ChatMessageBody text={m.text} cluster={cluster} onQuery={(q) => sendText(q)} />
                  ) : (
                    <div className="ac-bubble">{m.text}</div>
                  )}

                  {/* Message actions */}
                  {m.role === "assistant" && m.text && !(busy && isLastAI) && (
                    <div className="ac-msg-actions">
                      <button className="ac-action-btn" onClick={() => copyMessage(m.text)} title="Copy">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                      </button>
                      <button
                        className={"ac-action-btn" + (likedMsgs.has(i) ? " liked" : "")}
                        onClick={() => {
                          const wasLiked = likedMsgs.has(i);
                          setLikedMsgs((p) => { const n = new Set(p); wasLiked ? n.delete(i) : n.add(i); return n; });
                          setDislikedMsgs((p) => { const n = new Set(p); n.delete(i); return n; });
                          if (!wasLiked) sendFeedback(i, "like");
                        }}
                        title="Helpful"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill={likedMsgs.has(i) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
                      </button>
                      <button
                        className={"ac-action-btn" + (dislikedMsgs.has(i) ? " disliked" : "")}
                        onClick={() => {
                          const wasDisliked = dislikedMsgs.has(i);
                          setDislikedMsgs((p) => { const n = new Set(p); wasDisliked ? n.delete(i) : n.add(i); return n; });
                          setLikedMsgs((p) => { const n = new Set(p); n.delete(i); return n; });
                          if (!wasDisliked) sendFeedback(i, "dislike");
                        }}
                        title="Not helpful"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill={dislikedMsgs.has(i) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg>
                      </button>
                      <button className="ac-action-btn" onClick={retryLast} title="Retry">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                      </button>
                    </div>
                  )}

                  {/* Follow-ups */}
                  {!busy && isLastAI && followUps.length > 0 && (
                    <div className="ac-follow-ups">
                      {followUps.map((fu) => (
                        <button key={fu} className="ac-follow-btn" onClick={() => sendText(fu)}>{fu}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Input area */}
        <div className="ac-input-area">
          {/* Slash palette */}
          {slashOpen && filteredSlash.length > 0 && (
            <div className="ac-slash-palette" ref={slashRef}>
              <div className="ac-slash-head">Commands</div>
              {Object.entries(groupedSlash).map(([cat, cmds]) => (
                <div key={cat}>
                  <div className="ac-slash-group">
                    <span className="ac-slash-dot" style={{ background: CAT_COLORS[cat] }} />
                    {CAT_LABELS[cat] || cat}
                  </div>
                  {cmds.map((sc) => {
                    const idx = filteredSlash.indexOf(sc);
                    return (
                      <button
                        key={sc.cmd}
                        className={"ac-slash-item" + (idx === slashIdx ? " active" : "")}
                        onClick={() => pickSlash(sc.cmd)}
                        onMouseEnter={() => setSlashIdx(idx)}
                      >
                        <span className="ac-slash-cmd">{sc.cmd}</span>
                        <span className="ac-slash-desc">{sc.desc}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          <div className={"ac-input-pill" + (inputFocused ? " focused" : "")}>
            {/* Provider switcher */}
            <div className="ac-provider-wrap" ref={providerRef}>
              <button className="ac-provider-toggle" onClick={() => setProviderOpen((v) => !v)} title={activeMeta.label}>
                <div className="ac-provider-icon" style={{ background: activeMeta.color }}>{activeMeta.icon}</div>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points={providerOpen ? "18 15 12 9 6 15" : "6 9 12 15 18 9"}/></svg>
              </button>
              {providerOpen && (
                <div className="ac-provider-dropdown">
                  <div className="ac-provider-dd-head">LLM Provider</div>
                  {(availableProviders.length > 0 ? availableProviders : Object.keys(PROVIDER_META)).map((key) => {
                    const meta = PROVIDER_META[key] || PROVIDER_META.builtin;
                    return (
                      <button
                        key={key}
                        className={"ac-provider-option" + (key === activeProvider ? " active" : "")}
                        onClick={() => { setActiveProvider(key); setProviderOpen(false); showToast(`Using ${meta.label}`, "ok"); }}
                      >
                        <div className="ac-provider-icon" style={{ background: meta.color }}>{meta.icon}</div>
                        <div className="ac-provider-info">
                          <div className="ac-provider-name">{meta.label}</div>
                          <div className="ac-provider-desc">{meta.desc}</div>
                        </div>
                        {key === activeProvider && (
                          <svg className="ac-provider-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <textarea
              ref={textareaRef}
              className="ac-textarea"
              placeholder={`Ask about ${cluster === "local" ? "the hub cluster" : cluster}...`}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              rows={1}
            />

            <div className="ac-input-hint">
              <kbd>/</kbd> commands
            </div>

            {busy ? (
              <button className="ac-send-btn abort" onClick={handleAbort} title="Stop">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              </button>
            ) : (
              <button className="ac-send-btn" onClick={send} disabled={!input.trim()} title="Send">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
