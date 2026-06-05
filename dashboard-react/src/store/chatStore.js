import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Per-cluster chat state. Conversations are stored keyed by cluster id, so the
 * AI Chat for cluster A is never visible while cluster B is active — chat
 * isolation by construction. Switching clusters swaps the whole conversation.
 *
 * The active conversation is persisted to localStorage so a page refresh keeps
 * the on-screen messages (the backend remains the durable source of truth for
 * saved chat history).
 */
export const useChatStore = create(persist((set, get) => ({
  byCluster: {}, // { [cluster]: { messages: [{role,text}], conversationId, chatId } }
  seedByCluster: {}, // { [cluster]: "draft message" } — set by Emergency Actions

  setSeed(cluster, text) {
    set((state) => ({ seedByCluster: { ...state.seedByCluster, [cluster]: text } }));
  },
  takeSeed(cluster) {
    const seed = get().seedByCluster[cluster];
    if (seed) set((state) => ({ seedByCluster: { ...state.seedByCluster, [cluster]: null } }));
    return seed || null;
  },

  getConversation(cluster) {
    return get().byCluster[cluster] || { messages: [], conversationId: null, chatId: null };
  },

  addMessage(cluster, message) {
    set((state) => {
      const conv = state.byCluster[cluster] || { messages: [], conversationId: null, chatId: null };
      return { byCluster: { ...state.byCluster, [cluster]: { ...conv, messages: [...conv.messages, message] } } };
    });
  },

  // Patch a specific message by index (used to swap interactive tokens to
  // their resolved/read-only form, e.g. ITSM_FORM → ITSM_SUBMITTED, so the
  // resolved state survives a page refresh via the persisted store).
  updateMessage(cluster, index, patch) {
    set((state) => {
      const conv = state.byCluster[cluster] || { messages: [], conversationId: null, chatId: null };
      const msgs = conv.messages.slice();
      if (index >= 0 && index < msgs.length) {
        msgs[index] = { ...msgs[index], ...patch };
      }
      return { byCluster: { ...state.byCluster, [cluster]: { ...conv, messages: msgs } } };
    });
  },

  // Replace the last assistant message's text (used while streaming the reply).
  updateLastAssistant(cluster, text) {
    set((state) => {
      const conv = state.byCluster[cluster] || { messages: [], conversationId: null, chatId: null };
      const msgs = conv.messages.slice();
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") { msgs[i] = { ...msgs[i], text }; break; }
      }
      return { byCluster: { ...state.byCluster, [cluster]: { ...conv, messages: msgs } } };
    });
  },

  setConversationId(cluster, conversationId) {
    set((state) => {
      const conv = state.byCluster[cluster] || { messages: [], conversationId: null, chatId: null };
      return { byCluster: { ...state.byCluster, [cluster]: { ...conv, conversationId } } };
    });
  },

  setChatId(cluster, chatId) {
    set((state) => {
      const conv = state.byCluster[cluster] || { messages: [], conversationId: null, chatId: null };
      return { byCluster: { ...state.byCluster, [cluster]: { ...conv, chatId } } };
    });
  },

  loadChat(cluster, chatId, conversationId, messages) {
    set((state) => ({
      byCluster: {
        ...state.byCluster,
        [cluster]: { messages, conversationId: conversationId || chatId, chatId },
      },
    }));
  },

  clear(cluster) {
    set((state) => ({ byCluster: { ...state.byCluster, [cluster]: { messages: [], conversationId: null, chatId: null } } }));
  },
}), {
  name: "tcs-chat-store",
  storage: createJSONStorage(() => localStorage),
  // Only the conversations survive a refresh — not transient draft seeds.
  partialize: (s) => ({ byCluster: s.byCluster }),
}));
