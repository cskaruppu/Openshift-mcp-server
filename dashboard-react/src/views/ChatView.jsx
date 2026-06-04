import { useEffect, useRef, useState } from "react";
import { useActiveCluster } from "../store/clusterStore";
import { useChatStore } from "../store/chatStore";
import { clusterUrl } from "../api/client";

/**
 * AI Chat view — conversational ops assistant, scoped to the ACTIVE cluster.
 *
 * Isolation: messages are stored per-cluster in chatStore, and every request is
 * cluster-scoped (clusterUrl + X-Cluster-Context). Switching clusters swaps the
 * conversation entirely — cluster A's chat is never visible under cluster B.
 *
 * Streaming contract (matches backend handleChatAPI):
 *   POST /api/chat  { message, conversationId, stream:true }  Accept: text/event-stream
 *   SSE: data: { stage }            -> progress
 *        data: { delta }            -> reply text
 *        data: { done, provider, conversationId }
 *        data: [DONE]
 */
export function ChatView() {
  const cluster = useActiveCluster();
  const conv = useChatStore((s) => s.byCluster[cluster]) || { messages: [], conversationId: null };
  const { addMessage, updateLastAssistant, setConversationId, clear } = useChatStore();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conv.messages, stage]);

  // Cancel any in-flight chat when the cluster changes (isolation).
  useEffect(() => {
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [cluster]);

  // Pick up a seed message set by Emergency Actions for this cluster.
  const takeSeed = useChatStore((s) => s.takeSeed);
  useEffect(() => {
    const seed = takeSeed(cluster);
    if (seed) setInput(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster]);

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
    <div className="chat-view">
      <div className="view-head" style={{ padding: "16px 24px 0" }}>
        <h2>AI Chat</h2>
        <span className="scope-chip">Scope: {cluster === "local" ? "Hub (local)" : cluster}</span>
        <button className="chat-clear" onClick={() => clear(cluster)} title="Clear this cluster's conversation">Clear</button>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {conv.messages.length === 0 && (
          <div className="chat-empty">
            Ask about this cluster — e.g. “show pods at risk”, “why is operator X degraded”,
            “summarize cluster health”. Answers are scoped to <strong>{cluster === "local" ? "the hub" : cluster}</strong>.
          </div>
        )}
        {conv.messages.map((m, i) => (
          <div key={i} className={"chat-msg " + m.role}>
            <div className="chat-avatar">{m.role === "user" ? "You" : "TA"}</div>
            <div className="chat-bubble">{m.text || (busy && i === conv.messages.length - 1 ? (stage || "thinking") + "…" : "")}</div>
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
  );
}
