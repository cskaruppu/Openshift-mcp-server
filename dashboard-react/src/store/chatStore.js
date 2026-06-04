import { create } from "zustand";

/**
 * Per-cluster chat state. Conversations are stored keyed by cluster id, so the
 * AI Chat for cluster A is never visible while cluster B is active — chat
 * isolation by construction. Switching clusters swaps the whole conversation.
 */
export const useChatStore = create((set, get) => ({
  byCluster: {}, // { [cluster]: { messages: [{role,text}], conversationId } }

  getConversation(cluster) {
    return get().byCluster[cluster] || { messages: [], conversationId: null };
  },

  addMessage(cluster, message) {
    set((state) => {
      const conv = state.byCluster[cluster] || { messages: [], conversationId: null };
      return { byCluster: { ...state.byCluster, [cluster]: { ...conv, messages: [...conv.messages, message] } } };
    });
  },

  // Replace the last assistant message's text (used while streaming the reply).
  updateLastAssistant(cluster, text) {
    set((state) => {
      const conv = state.byCluster[cluster] || { messages: [], conversationId: null };
      const msgs = conv.messages.slice();
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") { msgs[i] = { ...msgs[i], text }; break; }
      }
      return { byCluster: { ...state.byCluster, [cluster]: { ...conv, messages: msgs } } };
    });
  },

  setConversationId(cluster, conversationId) {
    set((state) => {
      const conv = state.byCluster[cluster] || { messages: [], conversationId: null };
      return { byCluster: { ...state.byCluster, [cluster]: { ...conv, conversationId } } };
    });
  },

  clear(cluster) {
    set((state) => ({ byCluster: { ...state.byCluster, [cluster]: { messages: [], conversationId: null } } }));
  },
}));
