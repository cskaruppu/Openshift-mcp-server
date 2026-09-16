/**
 * Which agent is doing the work, carried through the call stack.
 *
 * Token spend has to land on the agent that caused it, and the alternative was
 * threading an `agentId` argument through 36 call sites across 18 files — 21 of
 * them in chat-api.js alone — and then through every call site added
 * afterwards. That is the kind of change that is 95% done forever: the next
 * person adds a model call, forgets the argument, and their spend quietly
 * rejoins the unattributed pile.
 *
 * So the agent is set ONCE where it is known — at the route that belongs to it,
 * or at the point chat resolves which agent handled a turn — and read at the
 * one place that records usage. AsyncLocalStorage carries it across every await
 * in between without any function in the middle knowing it exists.
 *
 * WHAT THIS DOES NOT DO IS GUESS. With no agent in context, usage is recorded
 * with a null agent and reported as unattributed — never assigned to whichever
 * agent happens to be nearby. An unattributed call is a gap somebody can close;
 * a wrongly attributed one is a number that looks right and is not, which is
 * the failure this whole line of work has been undoing.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/**
 * Run `fn` inside a fresh agent context.
 *
 * The store is a mutable object rather than a plain id, so a route that only
 * discovers which agent it belongs to part-way through can still set it — which
 * is the normal case for chat, where the agent is known once the tools that ran
 * have been mapped back to their owner.
 */
export function withAgentContext(fn) {
  return storage.run({ agentId: null, agentVersion: null }, fn);
}

/** Name the agent for the rest of this request. No-op outside a context. */
export function setCurrentAgent(agentId, agentVersion = null) {
  const store = storage.getStore();
  if (!store || !agentId) return false;
  store.agentId = agentId;
  if (agentVersion) store.agentVersion = agentVersion;
  return true;
}

/** The agent in scope, or nulls. Never throws, never guesses. */
export function currentAgent() {
  const store = storage.getStore();
  return {
    agentId: store?.agentId || null,
    agentVersion: store?.agentVersion || null,
  };
}

/**
 * Run one piece of work as a named agent, restoring whatever was in scope
 * afterwards. For a background job or a nested call that belongs to a different
 * agent than the request it started from.
 */
export async function asAgent(agentId, fn, agentVersion = null) {
  const store = storage.getStore();
  if (!store) return storage.run({ agentId, agentVersion }, fn);
  const prev = { agentId: store.agentId, agentVersion: store.agentVersion };
  store.agentId = agentId;
  if (agentVersion) store.agentVersion = agentVersion;
  try {
    return await fn();
  } finally {
    store.agentId = prev.agentId;
    store.agentVersion = prev.agentVersion;
  }
}
