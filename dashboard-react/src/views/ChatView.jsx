import { useEffect, useRef, useState, useMemo } from "react";
import { useActiveCluster } from "../store/clusterStore";
import { useChatStore } from "../store/chatStore";
import { clusterUrl } from "../api/client";
import { renderMarkdown } from "../utils/markdown";
import { showToast } from "../store/toastStore";

export function ChatView() {
  const cluster = useActiveCluster();
  const conv = useChatStore((s) => s.byCluster[cluster]) || { messages: [], conversationId: null };
  const { addMessage, updateLastAssistant, setConversationId, clear } = useChatStore();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conv.messages, stage]);

  useEffect(() => {
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [cluster]);

  const takeSeed = useChatStore((s) => s.takeSeed);
  useEffect(() => {
    const seed = takeSeed(cluster);
    if (seed) setInput(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster]);

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

  function handleNewChat() {
    clear(cluster);
    setInput("");
    showToast("Chat cleared", "ok");
  }

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

  async function send() {
    const msg = input.trim();
    if (!msg || busy) return;
    setInput("");
    addMessage(cluster, { role: "user", text: msg });
    addMessage(cluster, { role: "assistant", text: "" });
    setBusy(true);
    setStage("querying");

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const sendingCluster = cluster;

    try {
      const res = await fetch(clusterUrl("/api/chat", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Cluster-Context": cluster },
        body: JSON.stringify({ message: msg, conversationId: conv.conversationId, stream: true }),
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
              if (evt.stage) setStage(evt.stage);
              if (evt.delta) { full += evt.delta; updateLastAssistant(sendingCluster, full); }
              if (evt.done) {
                if (evt.conversationId) setConversationId(sendingCluster, evt.conversationId);
              }
            } catch { /* ignore non-JSON keepalives */ }
          }
        }
        if (!full) updateLastAssistant(sendingCluster, "(no response)");
      }
    } catch (e) {
      if (e.name !== "AbortError") updateLastAssistant(sendingCluster, "Error: " + e.message);
    } finally {
      setBusy(false);
      setStage("");
      abortRef.current = null;
    }
  }

  return (
    <div className="chat-layout">
      {/* Sidebar */}
      <aside className="chat-sidebar">
        <div className="chat-sidebar-header">
          <button className="chat-new-btn" onClick={handleNewChat}>+ New Chat</button>
        </div>
        <div className="chat-sidebar-search">
          <input
            type="text"
            placeholder="Search conversations…"
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

      {/* Main chat area */}
      <div className="chat-view">
        <div className="chat-header-bar">
          <h2 className="chat-title">AI Chat</h2>
          <span className="scope-chip">Scope: {cluster === "local" ? "Hub (local)" : cluster}</span>
          {stage && <span className="chat-stage-chip">{stage}…</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="chat-clear" onClick={exportConversation} title="Export conversation" disabled={!conv.messages.length}>Export</button>
            <button className="chat-clear" onClick={handleNewChat} title="Clear this cluster's conversation">Clear</button>
          </div>
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {conv.messages.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty-icon">{"\u{1F916}"}</div>
              <div className="chat-empty-title">Ask about this cluster</div>
              <div className="chat-empty-desc">
                Try "show pods at risk", "why is operator X degraded", or "summarize cluster health".
                Answers are scoped to <strong>{cluster === "local" ? "the hub" : cluster}</strong>.
              </div>
              <div className="chat-quick-prompts">
                {["Summarize cluster health", "Show pods at risk", "List degraded operators", "Check node resource usage"].map((q) => (
                  <button key={q} className="chat-quick-btn" onClick={() => { setInput(q); }}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {conv.messages.map((m, i) => (
            <div key={i} className={"chat-msg " + m.role}>
              <div className="chat-avatar">{m.role === "user" ? "You" : "TA"}</div>
              {m.role === "assistant" ? (
                <div
                  className="chat-bubble md-content"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(m.text || (busy && i === conv.messages.length - 1 ? (stage || "thinking") + "…" : "")),
                  }}
                />
              ) : (
                <div className="chat-bubble">{m.text}</div>
              )}
            </div>
          ))}
        </div>

        <div className="chat-input-row">
          <textarea
            className="chat-input"
            placeholder={`Message AI about ${cluster === "local" ? "the hub cluster" : cluster}…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={2}
          />
          <button className="chat-send" onClick={send} disabled={busy || !input.trim()}>
            {busy ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
