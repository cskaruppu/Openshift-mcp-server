import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useActiveCluster } from "../store/clusterStore";
import { useChatStore } from "../store/chatStore";
import { clusterUrl } from "../api/client";
import { showToast } from "../store/toastStore";
import { ChatMessageBody, computeResponseWidth } from "./ChatTokens";

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
  { cmd: "/rightsize",       desc: "Right-size workloads with one-click apply", cat: "intelligence" },
  { cmd: "/triage",          desc: "Triage failing pods with one-click fixes", cat: "intelligence" },
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
  { key: "parse",          label: "Parsing" },
  { key: "query",          label: "Querying" },
  { key: "investigating",  label: "Investigating" },
  { key: "generate",       label: "Generating" },
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

function clusterLabel(cluster) {
  if (!cluster || cluster === "local") return "Hub Cluster";
  return cluster;
}

// Bucket a timestamp into a human time group, the way leading AI chat apps do.
function timeGroup(ts) {
  if (!ts) return { label: "Older", order: 4 };
  const now = new Date();
  const then = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86400000;
  const t = then.getTime();
  if (t >= startOfToday) return { label: "Today", order: 0 };
  if (t >= startOfToday - dayMs) return { label: "Yesterday", order: 1 };
  if (t >= startOfToday - 7 * dayMs) return { label: "Previous 7 Days", order: 2 };
  if (t >= startOfToday - 30 * dayMs) return { label: "Previous 30 Days", order: 3 };
  return { label: "Older", order: 4 };
}

export function ChatView() {
  const cluster = useActiveCluster();
  const conv = useChatStore((s) => s.byCluster[cluster]) || { messages: [], conversationId: null, chatId: null };
  const { addMessage, updateLastAssistant, updateMessage, setConversationId, setChatId, loadChat, clear } = useChatStore();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [completedStages, setCompletedStages] = useState(new Set());
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [toolCalls, setToolCalls] = useState([]);
  const [toolProgress, setToolProgress] = useState("");
  const [followUps, setFollowUps] = useState([]);
  const [imgBusy, setImgBusy] = useState(false);
  const [pendingImage, setPendingImage] = useState(null); // { dataUrl, name } staged in composer
  const imgInputRef = useRef(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const [providers, setProviders] = useState({});
  const [activeProvider, setActiveProvider] = useState("builtin");
  const [providerOpen, setProviderOpen] = useState(false);

  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);

  const [likedMsgs, setLikedMsgs] = useState(new Set());
  const [dislikedMsgs, setDislikedMsgs] = useState(new Set());

  const [savedChats, setSavedChats] = useState([]);

  const [rightOpen, setRightOpen] = useState(false);
  const [pendingActions, setPendingActions] = useState([]);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [msgMeta, setMsgMeta] = useState({});
  const [renamingId, setRenamingId] = useState(null);
  const [renameVal, setRenameVal] = useState("");

  const abortRef = useRef(null);
  const msgIndexRef = useRef(0);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const providerRef = useRef(null);
  const slashRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conv.messages, stage, toolCalls]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
  }, []);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, []);

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
        // LLM provider config is MANAGEMENT-PLANE (global) — it lives in the
        // hub/control-plane DB, not on individual clusters. Always fetch it
        // hub-global (no cluster param) so the configured providers show up in
        // AI Chat for EVERY selected cluster, including secondary clusters that
        // carry no LLM config of their own.
        const res = await fetch("/api/settings/llm");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.providers) setProviders(data.providers);
        // Default to whichever LLM is configured: explicit default first,
        // otherwise the first enabled non-builtin provider, else built-in.
        if (data.defaultProvider && data.providers?.[data.defaultProvider]?.enabled) {
          setActiveProvider(data.defaultProvider);
        } else if (data.defaultProvider && data.defaultProvider !== "builtin") {
          setActiveProvider(data.defaultProvider);
        } else {
          const firstEnabled = Object.keys(data.providers || {}).find(
            (k) => k !== "builtin" && data.providers[k]?.enabled
          );
          setActiveProvider(firstEnabled || data.defaultProvider || "builtin");
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [cluster]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Always scope to the active cluster (incl. "local"/Hub). Omitting the
        // cluster param makes the backend return EVERY cluster's chats, which is
        // why history used to leak across clusters.
        const res = await fetch(`/api/chats?limit=30&cluster=${encodeURIComponent(cluster)}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.chats)) setSavedChats(data.chats);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [cluster]);

  // Only workload actions awaiting confirmation are surfaced in chat; CR/
  // ServiceNow lifecycle is owned by Audit → Change Requests.
  const refreshPending = useCallback(async () => {
    try {
      const aRes = await fetch(clusterUrl("/api/actions", cluster));
      if (aRes.ok) {
        const d = await aRes.json();
        const all = d.actions || [];
        setPendingActions(all.filter((a) => a.status === "pending_confirmation" || a.status === "awaiting_approval"));
      }
    } catch { /* silent */ }
  }, [cluster]);

  useEffect(() => {
    refreshPending();
    const iv = setInterval(refreshPending, 30000);
    return () => clearInterval(iv);
  }, [refreshPending]);

  useEffect(() => {
    function onDoc(e) {
      if (providerOpen && providerRef.current && !providerRef.current.contains(e.target)) setProviderOpen(false);
      if (slashOpen && slashRef.current && !slashRef.current.contains(e.target)) setSlashOpen(false);
      if (ctxMenu && !e.target.closest(".ac-ctx-menu")) setCtxMenu(null);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [providerOpen, slashOpen, ctxMenu]);

  // Single, unified chat history (source of truth = persisted savedChats).
  // Starred chats are pinned on top; the rest are bucketed by time, the way
  // leading AI chat apps (ChatGPT / Claude / Gemini) present history.
  const { pinnedChats, chatGroups } = useMemo(() => {
    const q = sidebarSearch.trim().toLowerCase();
    // Scope to the active cluster (defensive — the backend already filters).
    const scoped = savedChats.filter((c) => (c.cluster || "local") === cluster);
    const filtered = q
      ? scoped.filter((c) => (c.title || "").toLowerCase().includes(q))
      : scoped;
    const pinned = filtered.filter((c) => c.starred);
    const rest = filtered.filter((c) => !c.starred);
    const buckets = new Map();
    for (const c of rest) {
      const g = timeGroup(c.updatedAt || c.updated_at || c.createdAt || c.created_at);
      if (!buckets.has(g.label)) buckets.set(g.label, { label: g.label, order: g.order, items: [] });
      buckets.get(g.label).items.push(c);
    }
    const groups = [...buckets.values()].sort((a, b) => a.order - b.order);
    return { pinnedChats: pinned, chatGroups: groups };
  }, [savedChats, sidebarSearch]);

  const totalChats = savedChats.length;

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

  async function confirmPendingAction(id) {
    try {
      const res = await fetch(clusterUrl(`/api/actions/${id}/confirm`, cluster), { method: "POST" });
      if (res.ok) { showToast("Action confirmed", "ok"); refreshPending(); }
      else showToast("Failed to confirm action", "error");
    } catch { showToast("Failed to confirm action", "error"); }
  }

  async function cancelPendingAction(id) {
    try {
      const res = await fetch(clusterUrl(`/api/actions/${id}/cancel`, cluster), { method: "POST" });
      if (res.ok) { showToast("Action cancelled", "ok"); refreshPending(); }
      else showToast("Failed to cancel", "error");
    } catch { showToast("Failed to cancel", "error"); }
  }


  const reloadSavedChats = useCallback(async () => {
    try {
      const res = await fetch(`/api/chats?limit=30&cluster=${encodeURIComponent(cluster)}`);
      if (res.ok) { const d = await res.json(); if (Array.isArray(d.chats)) setSavedChats(d.chats); }
    } catch { /* silent */ }
  }, [cluster]);

  async function ensureChatRecord(firstMsg) {
    if (conv.chatId) return conv.chatId;
    const id = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fetch(clusterUrl("/api/chats", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, title: firstMsg.slice(0, 60), cluster }),
      });
    } catch { /* silent */ }
    setChatId(cluster, id);
    return id;
  }

  async function persistMessages(chatId) {
    const msgs = useChatStore.getState().getConversation(cluster).messages;
    try {
      await fetch(clusterUrl(`/api/chats/${chatId}/messages`, cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: msgs.map((m) => ({ role: m.role, content: m.text || "" })),
          cluster,
        }),
      });
    } catch { /* silent */ }
  }

  // When an ITSM form is submitted, swap its interactive token for a read-only
  // ITSM_SUBMITTED card in the stored message. This keeps the submitted state
  // across a page refresh (store persists to localStorage) and prevents the
  // form from re-appearing as submittable. Also re-persists to the backend.
  function handleItsmSubmitted(index, info) {
    const conv = useChatStore.getState().getConversation(cluster);
    const msg = conv.messages[index];
    if (!msg || !msg.text) return;
    const submittedToken = `@@ITSM_SUBMITTED|${JSON.stringify(info).replace(/@@/g, "@ @")}@@`;
    const newText = msg.text.replace(/@@ITSM_FORM\|[\s\S]*?@@/, submittedToken);
    if (newText === msg.text) return;
    updateMessage(cluster, index, { text: newText });
    const cid = useChatStore.getState().getConversation(cluster).chatId;
    if (cid) persistMessages(cid);
  }

  async function loadSavedChat(chat) {
    try {
      const res = await fetch(clusterUrl(`/api/chats/${chat.id}`, cluster));
      if (!res.ok) { showToast("Failed to load chat", "error"); return; }
      const d = await res.json();
      const ch = d.chat || d;
      const msgs = (ch.messages || []).map((m) => ({
        role: m.role || "user",
        text: m.text || m.content || "",
      }));
      loadChat(cluster, chat.id, ch.conversationId || chat.id, msgs);
      showToast("Loaded: " + (chat.title || "Untitled"), "ok");
    } catch { showToast("Failed to load chat", "error"); }
  }

  async function starChat(id, starred) {
    // Optimistic UI — reflect the change instantly, then persist.
    setSavedChats((prev) => prev.map((c) => (c.id === id ? { ...c, starred } : c)));
    try {
      const res = await fetch(clusterUrl(`/api/chats/${id}`, cluster), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred }),
      });
      if (res.ok) {
        showToast(starred ? "Starred" : "Unstarred", "ok");
        reloadSavedChats();
      } else {
        setSavedChats((prev) => prev.map((c) => (c.id === id ? { ...c, starred: !starred } : c)));
        showToast("Failed to update — is chat history persistence enabled?", "error");
      }
    } catch {
      setSavedChats((prev) => prev.map((c) => (c.id === id ? { ...c, starred: !starred } : c)));
      showToast("Failed to update", "error");
    }
  }

  async function lockChat(id, locked) {
    // Optimistic UI — show the lock badge immediately so it never looks like a no-op.
    setSavedChats((prev) => prev.map((c) => (c.id === id ? { ...c, locked } : c)));
    try {
      const res = await fetch(clusterUrl(`/api/chats/${id}`, cluster), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked }),
      });
      if (res.ok) {
        showToast(locked ? "Chat locked — protected from deletion" : "Chat unlocked", "ok");
        reloadSavedChats();
      } else {
        // Revert on failure and tell the user why (DB persistence likely off).
        setSavedChats((prev) => prev.map((c) => (c.id === id ? { ...c, locked: !locked } : c)));
        showToast("Lock failed — chat history persistence not enabled", "error");
      }
    } catch {
      setSavedChats((prev) => prev.map((c) => (c.id === id ? { ...c, locked: !locked } : c)));
      showToast("Failed to update", "error");
    }
  }

  async function renameChat(id, title) {
    try {
      const res = await fetch(clusterUrl(`/api/chats/${id}`, cluster), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (res.ok) {
        showToast("Renamed", "ok");
        reloadSavedChats();
      }
    } catch { showToast("Failed to rename", "error"); }
  }

  async function deleteSavedChat(id) {
    const chat = savedChats.find((c) => c.id === id);
    const title = chat?.title || "this chat";
    // A locked chat must be explicitly unlocked first — mirror that in the prompt.
    if (chat?.locked) {
      showToast("Chat is locked — unlock it before deleting", "warn");
      return;
    }
    // Confirmation gate — deletion is permanent and cannot be undone.
    if (!window.confirm(`Delete "${title}"?\n\nThis permanently removes the conversation and all its messages. This cannot be undone.`)) {
      return;
    }
    // Optimistic removal for instant feedback.
    const snapshot = savedChats;
    setSavedChats((prev) => prev.filter((c) => c.id !== id));
    try {
      const res = await fetch(clusterUrl(`/api/chats/${id}`, cluster), { method: "DELETE" });
      if (res.ok) {
        showToast("Chat deleted", "ok");
        if (conv.chatId === id) handleNewChat();
        reloadSavedChats();
      } else {
        const d = await res.json().catch(() => ({}));
        setSavedChats(snapshot);
        if (d.locked) showToast("Chat is locked — unlock first", "warn");
        else showToast("Failed to delete", "error");
      }
    } catch {
      setSavedChats(snapshot);
      showToast("Failed to delete", "error");
    }
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
    // If a screenshot is staged, hitting Enter/Send submits it for analysis
    // (any typed text becomes the question about the image).
    if (pendingImage && typeof override !== "string") {
      const cap = input.trim();
      const img = pendingImage;
      setInput(""); setPendingImage(null);
      runImageAnalysis(img.dataUrl, cap);
      return;
    }
    const msg = (typeof override === "string" ? override : input).trim();
    if (!msg || busy) return;
    setInput("");
    setSlashOpen(false);
    setFollowUps([]);
    setToolCalls([]);
    setToolProgress("");
    setCompletedStages(new Set());
    const now = Date.now();
    const userIdx = conv.messages.length;
    const aiIdx = userIdx + 1;
    msgIndexRef.current = aiIdx;
    addMessage(cluster, { role: "user", text: msg });
    addMessage(cluster, { role: "assistant", text: "", toolCalls: [], followUps: [] });
    setMsgMeta((prev) => ({
      ...prev,
      [userIdx]: { timestamp: now },
      [aiIdx]: { timestamp: now, provider: activeProvider },
    }));
    setBusy(true);
    setStage("parse");

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const sendingCluster = cluster;
    const currentToolCalls = [];

    try {
      // The backend treats provider "none" as the built-in analysis path and
      // resolves stored credentials for any real provider (azure/openai/...) so
      // the request routes through MCP → the configured agentic AI LLM.
      const wireProvider = activeProvider === "builtin" ? "none" : activeProvider;
      const res = await fetch(clusterUrl("/api/chat", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Cluster-Context": cluster },
        body: JSON.stringify({ message: msg, conversationId: conv.conversationId, stream: true, provider: wireProvider, cluster, history: conv.messages.slice(-10).map(m => ({ role: m.role, content: m.text || m.content || "" })) }),
        signal: ctrl.signal,
      });

      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("text/event-stream")) {
        let data;
        if (res.ok) {
          data = await res.json();
        } else {
          try { data = await res.json(); } catch { data = {}; }
          data.error = data.error || `Server error ${res.status}`;
        }
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
              if (evt.toolProgress) {
                setToolProgress(evt.toolProgress);
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
                doneStages.add("parse"); doneStages.add("query"); doneStages.add("investigating"); doneStages.add("generate");
                setCompletedStages(new Set(doneStages));
                if (evt.toolsUsed?.length > 0) {
                  setToolCalls(evt.toolsUsed.map(name => ({ name })));
                }
                // Normalize the built-in identifiers back to "builtin" so the
                // response window shows the correct provider identity badge.
                // When an LLM config error fires, errorProvider carries the
                // real provider name — show it so the user knows what failed.
                const rawProv = evt.errorProvider || evt.provider || activeProvider;
                const resolvedProvider = (rawProv === "none" || rawProv === "built-in") ? "builtin" : rawProv;
                setMsgMeta((prev) => ({
                  ...prev,
                  [msgIndexRef.current]: {
                    ...prev[msgIndexRef.current],
                    provider: resolvedProvider,
                    confidence: full.length > 200 ? "high" : full.length > 50 ? "medium" : "low",
                    usage: evt.usage || null,
                  },
                }));
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
      try {
        const cid = await ensureChatRecord(msg);
        await persistMessages(cid);
        reloadSavedChats();
      } catch { /* silent */ }
    }
  }

  // ── Vision: analyze a pasted/attached screenshot (pod list, events, logs) ──
  const sevIcon = (s) => s === "critical" ? "🔴" : s === "high" ? "🟠" : s === "medium" ? "🟡" : "⚪";
  function formatImageAnalysis(d) {
    const L = [`**🖼️ Screenshot analysis**\n\n${d.summary || ""}`];
    if (d.findings?.length) { L.push("\n\n**Findings**"); d.findings.forEach((f) => L.push(`\n- ${sevIcon(f.severity)} \`${f.resource}\`${f.kind ? ` (${f.kind})` : ""} — ${f.symptom}`)); }
    if (d.events?.length) { L.push("\n\n**Events / errors read**"); d.events.forEach((e) => L.push(`\n- ${e}`)); }
    if (d.likelyCauses?.length) { L.push("\n\n**Likely cause(s)**"); d.likelyCauses.forEach((e) => L.push(`\n- ${e}`)); }
    if (d.suggestions?.length) { L.push("\n\n**Suggested next steps**"); d.suggestions.forEach((e) => L.push(`\n- ${e}`)); }
    if (d.followUp) L.push(`\n\n${d.followUp}`);
    return L.join("");
  }
  // Stage an image into the composer (preview). User hits Enter/Send to submit.
  function attachImage(file) {
    if (!file) return;
    if (!file.type?.startsWith("image/")) { showToast("Attach an image (PNG/JPG screenshot)", "warn"); return; }
    const r = new FileReader();
    r.onload = () => { setPendingImage({ dataUrl: r.result, name: file.name || "screenshot.png" }); textareaRef.current?.focus(); };
    r.onerror = () => showToast("Could not read that image", "err");
    r.readAsDataURL(file);
  }
  function handlePaste(e) {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type?.startsWith("image/")) { const f = it.getAsFile(); if (f) { e.preventDefault(); attachImage(f); return; } }
    }
  }

  // Submit the staged image (with the typed text as an optional question).
  async function runImageAnalysis(dataUrl, question) {
    if (imgBusy || busy) return;
    setImgBusy(true);
    try {
      addMessage(cluster, { role: "user", text: `🖼️ *Screenshot for analysis*${question ? `\n\n${question}` : ""}`, image: dataUrl });
      addMessage(cluster, { role: "assistant", text: "Reading the screenshot…" });
      setFollowUps([]);
      const wireProvider = activeProvider === "builtin" ? "none" : activeProvider;
      const res = await fetch(clusterUrl("/api/chat/analyze-image", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: dataUrl, question, provider: wireProvider, cluster }),
      });
      const d = await res.json().catch(() => ({ error: "Invalid response" }));
      if (d.error) { updateLastAssistant(cluster, "⚠ " + d.error); return; }
      if (d.readable === false) { updateLastAssistant(cluster, d.summary || "No readable Kubernetes content found in that image."); return; }
      updateLastAssistant(cluster, formatImageAnalysis(d));
      // Grounding loop: follow-ups run LIVE RCA on the real cluster (object form).
      const fus = (d.entities || []).filter((e) => e.pod).slice(0, 3)
        .map((e) => ({ label: `🔎 Investigate ${e.pod}${e.namespace ? ` (${e.namespace})` : ""} live`, rca: { pod: e.pod, namespace: e.namespace } }));
      if (fus.length) setFollowUps(fus);
    } catch (e) { updateLastAssistant(cluster, "Error analyzing image: " + e.message); }
    finally { setImgBusy(false); }
  }

  // Direct live RCA against the real cluster — what the image follow-ups call,
  // so the answer is grounded, not a generic chat reply.
  async function runLiveRca({ pod, namespace }) {
    if (busy || imgBusy) return;
    const ns = namespace || "";
    addMessage(cluster, { role: "user", text: `Investigate pod \`${pod}\`${ns ? ` in namespace \`${ns}\`` : ""} on the live cluster` });
    addMessage(cluster, { role: "assistant", text: `Running live RCA on ${pod}${ns ? ` in ${ns}` : ""}…` });
    setFollowUps([]);
    try {
      if (!ns) { updateLastAssistant(cluster, `I couldn't read the namespace for **${pod}** from the screenshot. Which namespace is it in? (or run \`oc get pod ${pod} -A\`)`); return; }
      const res = await fetch(clusterUrl("/api/rca/investigate", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: ns, pod }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) { updateLastAssistant(cluster, `⚠ ${d.error}`); return; }
      const L = [`**🔎 Live RCA — \`${pod}\`${ns ? ` in \`${ns}\`` : ""}**`];
      if (d.rootCause) L.push(`\n\n**Root cause:** ${d.rootCause}${d.severity ? ` _(severity: ${d.severity})_` : ""}`);
      if (d.recommendation) L.push(`\n\n**Recommended fix:** ${d.recommendation}`);
      const chain = Array.isArray(d.causalChain) ? d.causalChain : [];
      if (chain.length) { L.push("\n\n**Evidence:**"); chain.slice(0, 6).forEach((c) => L.push(`\n- ${c.evidence || c.cause}${c.confidence ? ` _(${Math.round(c.confidence * 100)}%)_` : ""}`)); }
      if (L.length === 1) L.push(`\n\nThe pod could not be found on the live cluster — it may have been replaced, or the name/namespace differs from the screenshot. Try \`oc get pods -n ${ns}\`.`);
      updateLastAssistant(cluster, L.join(""));
    } catch (e) { updateLastAssistant(cluster, "Error running live RCA: " + e.message); }
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

  // A provider can be enabled yet unusable (credentials never saved). The
  // settings endpoint masks keys ("****xxxx" / "configured") but an absent
  // key comes back empty — enough to tell configured from not, so the user
  // sees the warning BEFORE sending instead of an error after.
  function providerConfigured(key) {
    if (key === "builtin") return true;
    const cfg = providers[key];
    if (!cfg) return false;
    if (key === "ollama") return !!cfg.apiUrl;
    if (key === "azure") return !!(cfg.apiKey && cfg.apiUrl && (cfg.deployment || cfg.model));
    return !!cfg.apiKey; // openai, anthropic, google, bedrock
  }

  function stageState(key) {
    if (completedStages.has(key)) return "done";
    if (stage === key) return "active";
    return "pending";
  }

  const hasMessages = conv.messages.length > 0;

  // A single, plain chat-history row — title only, hover-reveal menu, inline
  // star/lock markers. Mirrors how ChatGPT / Claude / Gemini render history.
  function renderHistItem(ch) {
    const active = conv.chatId === ch.id;
    const menuKey = `hist-${ch.id}`;
    return (
      <div key={ch.id} className={"ac-hist-item" + (active ? " active" : "")} onClick={() => loadSavedChat(ch)}>
        {renamingId === ch.id ? (
          <input className="ac-rename-input" value={renameVal} autoFocus
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { renameChat(ch.id, renameVal); setRenamingId(null); } if (e.key === "Escape") setRenamingId(null); }}
            onBlur={() => { renameChat(ch.id, renameVal); setRenamingId(null); }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            {ch.starred && <span className="ac-hist-icon star" title="Starred">&#9733;</span>}
            {ch.locked && <span className="ac-hist-icon lock" title="Locked">&#128274;</span>}
            <span className="ac-hist-title">{ch.title || "New chat"}</span>
            <button className="ac-hist-menu-btn" title="More" onClick={(e) => { e.stopPropagation(); setCtxMenu(ctxMenu === menuKey ? null : menuKey); }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
            </button>
          </>
        )}
        {ctxMenu === menuKey && (
          <div className="ac-ctx-menu" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { starChat(ch.id, !ch.starred); setCtxMenu(null); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              {ch.starred ? "Unstar" : "Star"}
            </button>
            <button onClick={() => { lockChat(ch.id, !ch.locked); setCtxMenu(null); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              {ch.locked ? "Unlock" : "Lock"}
            </button>
            <button onClick={() => { setRenamingId(ch.id); setRenameVal(ch.title || ""); setCtxMenu(null); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
              Rename
            </button>
            <div className="ac-ctx-divider" />
            <button className="ac-ctx-danger" onClick={() => { deleteSavedChat(ch.id); setCtxMenu(null); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              Delete
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="ac">
      {/* ── Sidebar toggle (mobile only) ── */}
      <button className="ac-sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)} title="Chat history" aria-label="Toggle chat history sidebar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        {totalChats > 0 && <span className="ac-sidebar-badge">{totalChats}</span>}
      </button>

      {/* ── Left Sidebar (always visible desktop, slide mobile) ── */}
      <aside className={"ac-sidebar" + (sidebarOpen ? " open" : "") + (sidebarCollapsed ? " collapsed" : "")}>
        <button className="ac-new-btn" onClick={handleNewChat}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New chat
        </button>
        <div className="ac-sidebar-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" placeholder="Search chats" value={sidebarSearch} onChange={(e) => setSidebarSearch(e.target.value)} />
        </div>
        <div className="ac-sidebar-list">
          {totalChats === 0 && (
            <div className="ac-sidebar-empty">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span>No chats yet</span>
              <small>Start a conversation and it will be saved here.</small>
            </div>
          )}

          {pinnedChats.length > 0 && (
            <div className="ac-hist-group">
              <div className="ac-hist-label">Starred</div>
              {pinnedChats.map((ch) => renderHistItem(ch))}
            </div>
          )}

          {chatGroups.map((g) => (
            <div key={g.label} className="ac-hist-group">
              <div className="ac-hist-label">{g.label}</div>
              {g.items.map((ch) => renderHistItem(ch))}
            </div>
          ))}
        </div>
      </aside>
      {sidebarOpen && <div className="ac-sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* ── Main chat ── */}
      <div className="ac-main">
        {/* Header */}
        <div className="ac-header">
          <div className="ac-header-left">
            <button className="ac-sidebar-collapse-btn" onClick={() => setSidebarCollapsed((v) => !v)} title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {sidebarCollapsed
                  ? <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><polyline points="14 8 18 12 14 16"/></>
                  : <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><polyline points="16 8 12 12 16 16"/></>}
              </svg>
            </button>
            <h2 className="ac-title">AI Chat</h2>
          </div>
          <div className="ac-header-right">
            {busy && (
              <button className="ac-header-btn ac-abort-btn" onClick={handleAbort}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                Stop
              </button>
            )}
            <button className="ac-header-btn" onClick={exportConversation} disabled={!hasMessages} title="Export" aria-label="Export conversation">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button className="ac-header-btn" onClick={handleNewChat} title="New chat" aria-label="New chat">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button className={"ac-header-btn" + (rightOpen ? " active" : "")} onClick={() => setRightOpen((v) => !v)} title="Actions panel" aria-label="Toggle actions panel" aria-pressed={rightOpen}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="ac-messages-wrap">
        <div className="ac-messages" ref={scrollRef} onScroll={handleScroll}>
          {/* Welcome */}
          {!hasMessages && (
            <div className="ac-welcome">
              <div className="ac-welcome-badge">
                <span className="ac-welcome-badge-dot" />
                {clusterLabel(cluster)} · {activeMeta.label}
              </div>
              <div className="ac-welcome-icon">
                <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
                  <line x1="10" y1="22" x2="14" y2="22"/>
                  <line x1="9" y1="9" x2="9.01" y2="9"/>
                  <line x1="15" y1="9" x2="15.01" y2="9"/>
                </svg>
              </div>
              <h2 className="ac-welcome-title">Welcome to {clusterLabel(cluster)}</h2>
              <p className="ac-welcome-desc">
                Your AI operations copilot for this cluster. Ask about health, workloads,
                security and upgrades — or start with a suggestion below.
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
            const meta = msgMeta[i] || {};
            const prov = meta.provider || activeProvider;
            const provMeta = PROVIDER_META[prov] || PROVIDER_META.builtin;
            const ts = meta.timestamp ? new Date(meta.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

            if (m.role === "user") {
              return (
                <div key={i} className="ac-msg ac-msg-user">
                  <div className="ac-user-row">
                    <div className="ac-bubble">
                      {m.image && <img src={m.image} alt="screenshot" style={{ display: "block", maxWidth: 320, maxHeight: 220, borderRadius: 10, marginBottom: m.text ? 8 : 0, border: "1px solid rgba(255,255,255,0.25)" }} />}
                      {m.text}
                    </div>
                    <div className="ac-user-meta">
                      {ts && <span className="ac-msg-time">{ts}</span>}
                    </div>
                  </div>
                </div>
              );
            }

            const widthCls = "ac-w-" + computeResponseWidth(m.text);
            return (
              <div key={i} className="ac-msg ac-msg-assistant">
                <div className={"ac-window " + widthCls}>
                  {/* Window header */}
                  <div className="ac-win-header">
                    <div className="ac-win-identity">
                      <div className="ac-win-icon" style={{ background: provMeta.color }}>{provMeta.icon}</div>
                      <span className="ac-win-name">TCS Agentic AI</span>
                      <span className="ac-win-provider-badge" style={{ background: provMeta.color + "22", color: provMeta.color }}>{prov === "builtin" ? "built-in" : provMeta.label}</span>
                      {meta.usage && (
                        <span className="ac-token-pill">
                          {meta.usage.total_tokens ? `${meta.usage.total_tokens} tokens` :
                           meta.usage.prompt_tokens ? `${meta.usage.prompt_tokens + (meta.usage.completion_tokens || 0)} tokens` : null}
                        </span>
                      )}
                    </div>
                    {ts && <span className="ac-win-time">{ts}</span>}
                  </div>

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
                      {toolProgress && (
                        <div className="ac-tool-progress">{toolProgress}</div>
                      )}
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

                  {/* Window body */}
                  <div className={"ac-win-body" + (busy && isLastAI ? " ac-streaming-cursor" : "")}>
                    {m.text && <ChatMessageBody text={m.text} cluster={cluster} onQuery={(q) => sendText(q)} onItsmSubmitted={(info) => handleItsmSubmitted(i, info)} />}
                  </div>

                  {/* Window footer with actions */}
                  {m.text && !(busy && isLastAI) && (
                    <div className="ac-win-footer">
                      <div className="ac-msg-actions">
                        <button className="ac-action-btn" onClick={() => copyMessage(m.text)} title="Copy" aria-label="Copy message">
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
                          aria-label="Mark response as helpful"
                          aria-pressed={likedMsgs.has(i)}
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
                          aria-label="Mark response as not helpful"
                          aria-pressed={dislikedMsgs.has(i)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill={dislikedMsgs.has(i) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg>
                        </button>
                        <button className="ac-action-btn" onClick={retryLast} title="Retry" aria-label="Retry last message">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                        </button>
                      </div>
                      {/* Follow-ups */}
                      {!busy && isLastAI && followUps.length > 0 && (
                        <div className="ac-follow-ups">
                          {followUps.map((fu, fi) => {
                            const label = typeof fu === "string" ? fu : fu.label;
                            return <button key={label + fi} className="ac-follow-btn" onClick={() => (typeof fu === "object" && fu.rca) ? runLiveRca(fu.rca) : sendText(fu)}>{label}</button>;
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className={"ac-scroll-fade" + (showScrollBtn ? " visible" : "")} />
        {showScrollBtn && (
          <button className="ac-scroll-bottom" onClick={scrollToBottom} title="Scroll to bottom">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
        )}
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
            {/* Staged screenshot preview — submit with Enter (optionally add a question) */}
            {pendingImage && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 6px 4px" }}>
                <img src={pendingImage.dataUrl} alt="screenshot" style={{ height: 56, maxWidth: 120, borderRadius: 8, border: "1px solid var(--border,#e4e8f1)", objectFit: "cover" }} />
                <div style={{ fontSize: "0.78rem", color: "var(--muted,#5a6373)" }}>
                  <div style={{ fontWeight: 700, color: "var(--fg,#151a29)" }}>🖼 {pendingImage.name}</div>
                  <div>{imgBusy ? "Analyzing…" : "Press Enter to analyze (add a question first if you like)"}</div>
                </div>
                <button onClick={() => setPendingImage(null)} disabled={imgBusy} title="Remove" style={{ marginLeft: "auto", width: 26, height: 26, borderRadius: 7, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--muted,#5a6373)", cursor: "pointer", fontSize: "1rem", lineHeight: 1 }}>×</button>
              </div>
            )}
            {/* Row 1 — full-width textarea so typed text never gets squeezed */}
            <textarea
              ref={textareaRef}
              className="ac-textarea"
              placeholder={`Ask about ${clusterLabel(cluster)}...`}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              rows={1}
            />

            {/* Row 2 — toolbar: model selector (left), hint + send (right) */}
            <div className="ac-input-toolbar">
              <div className="ac-provider-wrap" ref={providerRef}>
                <button className="ac-provider-toggle" onClick={() => setProviderOpen((v) => !v)} title={`Model: ${activeMeta.label}`}>
                  <div className="ac-provider-icon" style={{ background: activeMeta.color }}>{activeMeta.icon}</div>
                  <span className="ac-provider-toggle-name">{activeMeta.label}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points={providerOpen ? "18 15 12 9 6 15" : "6 9 12 15 18 9"}/></svg>
                </button>
                {providerOpen && (
                  <div className="ac-provider-dropdown">
                    <div className="ac-provider-dd-head">LLM Provider</div>
                    {(availableProviders.length > 0 ? availableProviders : Object.keys(PROVIDER_META)).map((key) => {
                      const meta = PROVIDER_META[key] || PROVIDER_META.builtin;
                      const configured = providerConfigured(key);
                      return (
                        <button
                          key={key}
                          className={"ac-provider-option" + (key === activeProvider ? " active" : "")}
                          style={configured ? undefined : { opacity: 0.65 }}
                          onClick={() => {
                            setActiveProvider(key); setProviderOpen(false);
                            if (configured) showToast(`Using ${meta.label}`, "ok");
                            else showToast(`${meta.label} is not configured — set it up in Settings`, "warn");
                          }}
                        >
                          <div className="ac-provider-icon" style={{ background: meta.color }}>{meta.icon}</div>
                          <div className="ac-provider-info">
                            <div className="ac-provider-name">{meta.label}</div>
                            <div className="ac-provider-desc">
                              {configured ? meta.desc : (
                                <span style={{ color: "#d97706", fontWeight: 600 }}>&#9888; Not configured — set up in Settings</span>
                              )}
                            </div>
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

              <div className="ac-input-toolbar-right">
                <input ref={imgInputRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) attachImage(f); e.target.value = ""; }} />
                <button className="ac-send-btn" style={{ background: "transparent", color: imgBusy ? "#94a3b8" : "#7c3aed", border: "1px solid rgba(124,58,237,0.4)" }} onClick={() => imgInputRef.current?.click()} disabled={imgBusy || busy} title="Attach a screenshot (pod list, events, logs) — or just paste an image, then hit Enter">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                </button>
                <span className="ac-input-hint"><kbd>/</kbd> commands &middot; 🖼 paste image &middot; <kbd>&#8629;</kbd> send</span>
                {busy ? (
                  <button className="ac-send-btn abort" onClick={handleAbort} title="Stop">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                  </button>
                ) : (
                  <button className="ac-send-btn" onClick={send} disabled={!input.trim() && !pendingImage} title={pendingImage ? "Analyze screenshot" : "Send"}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right Panel: workload confirmations only ──
         CR / ServiceNow lifecycle lives in Audit → Change Requests (single
         source of truth); Fix Proposals are handled in AI Intelligence. This
         panel is scoped to actions that need the user's confirmation right now. */}
      {rightOpen && (
        <aside className="ac-right">
          <div className="ac-right-head">
            <span className="ac-right-title">Awaiting your confirmation</span>
          </div>

          <div className="ac-right-body">
            <div className="ac-rp-section">
              {pendingActions.length === 0 ? (
                <p className="ac-rp-empty">No actions awaiting confirmation. Ask me to restart, scale or edit a workload and it will appear here for you to approve.</p>
              ) : (
                <div className="ac-rp-list">
                  {pendingActions.map((act) => (
                    <div key={act.id} className="ac-rp-card">
                      <div className="ac-rp-card-head">
                        <span className="ac-rp-card-id">{act.action || act.resourceType}</span>
                        <span className="ac-rp-badge warn">{(act.status || "pending").replace(/_/g, " ")}</span>
                      </div>
                      <div className="ac-rp-card-title">{act.resourceName || act.description || "Action"}</div>
                      {act.namespace && <div className="ac-rp-card-sub">ns: {act.namespace}</div>}
                      <div className="ac-rp-card-actions">
                        <button className="ac-rp-action confirm" onClick={() => confirmPendingAction(act.id)}>Confirm</button>
                        <button className="ac-rp-action cancel" onClick={() => cancelPendingAction(act.id)}>Cancel</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="ac-rp-section">
              <p className="ac-rp-hint">
                Change requests &amp; their ServiceNow lifecycle are tracked in
                <strong> Audit → Change Requests</strong>.
              </p>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
