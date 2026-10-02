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
  return storage.run(newStore(), fn);
}

/**
 * The store carries more than the agent id now, and for the same reason it
 * carried that: the facts live at the bottom of the call stack and are needed
 * at the top, and threading them through would be a change that is never
 * finished.
 *
 *   egress  — every outbound host this request touched, so the governance lens
 *             can reconcile it against what the manifest declared. The
 *             `undeclared-egress` finding has existed since governance.js was
 *             written and has never been able to fire, because nothing
 *             collected this.
 *   chain   — the agents in the current delegation chain, outermost first, so
 *             `maxDelegationDepth` becomes something that can be enforced
 *             rather than something that is merely displayed.
 *   evidence— what the operation actually read, against how confident it
 *             sounded. See health-signals.js for why that is the one signal
 *             that catches an agent failing while reporting success.
 */
function newStore(agentId = null, agentVersion = null) {
  return { agentId, agentVersion, egress: new Set(), chain: agentId ? [agentId] : [], evidence: null };
}

/**
 * Record an outbound host this request contacted.
 *
 * Called by the clients that leave the cluster — vCenter, the MTA hub,
 * ServiceNow, an LLM endpoint. A host recorded here that the manifest never
 * declared becomes a critical governance finding.
 *
 * Accepts a URL, a host, or a logical name ("vcenter"); a URL is reduced to its
 * hostname so credentials and paths can never reach the trace.
 */
export function recordEgress(target) {
  const store = storage.getStore();
  if (!store || !target) return false;
  let host = String(target).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try { host = new URL(host).hostname; } catch { /* keep the raw value */ }
  }
  host = host.replace(/^.*@/, "").split("/")[0].split("?")[0];
  if (!host) return false;
  store.egress.add(host);
  return true;
}

/** Every host contacted so far in this request. */
export function currentEgress() {
  return [...(storage.getStore()?.egress || [])];
}

/** The delegation chain in scope, outermost agent first. */
export function currentChain() {
  return [...(storage.getStore()?.chain || [])];
}

/**
 * Record what this operation read, and how confident it was about the answer.
 *
 * Counts accumulate — an agent that reads in several passes calls this several
 * times — but confidence is a statement about the final answer, so the last one
 * wins.
 */
export function recordEvidence({ read = 0, expected = 0, confidence = null, unread = [], concluded = null } = {}) {
  const store = storage.getStore();
  if (!store) return false;
  const e = store.evidence || { read: 0, expected: 0, confidence: null, unread: [], concluded: null };
  e.read += Number(read) || 0;
  e.expected += Number(expected) || 0;
  if (confidence) e.confidence = confidence;
  if (concluded !== null) e.concluded = concluded;
  for (const u of unread || []) if (!e.unread.includes(u)) e.unread.push(u);
  store.evidence = e;
  return true;
}

/** What has been recorded about this operation's evidence, or null. */
export function currentEvidence() {
  const e = storage.getStore()?.evidence;
  return e ? { ...e, unread: [...e.unread] } : null;
}

/** Name the agent for the rest of this request. No-op outside a context. */
export function setCurrentAgent(agentId, agentVersion = null) {
  const store = storage.getStore();
  if (!store || !agentId) return false;
  store.agentId = agentId;
  if (agentVersion) store.agentVersion = agentVersion;
  // Naming the agent that owns a request starts the chain; it does not extend
  // one. Delegation is asAgent(), below.
  if (store.chain.length === 0) store.chain.push(agentId);
  else store.chain[0] = agentId;
  return true;
}

/**
 * Raised when a delegation chain goes deeper than the manifest permits, or
 * starts to loop. Carries the chain so the message can show the path.
 */
export class DelegationRefused extends Error {
  constructor(verdict) {
    super(verdict.headline);
    this.name = "DelegationRefused";
    this.verdict = verdict;
  }
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
export async function asAgent(agentId, fn, agentVersion = null, { maxDepth = null } = {}) {
  const store = storage.getStore();
  if (!store) return storage.run(newStore(agentId, agentVersion), fn);

  // This is delegation: one agent handing work to another. It is the only place
  // the chain grows, which makes it the only place depth can be enforced.
  const chain = [...store.chain, agentId];
  const { delegationVerdict } = await import("../agents/health-signals.js");
  const verdict = delegationVerdict(chain, maxDepth);
  if (verdict.severity === "critical") {
    // Refused, not logged and allowed. A cycle does not stop on its own, and a
    // chain past its declared limit is doing something nobody sanctioned.
    throw new DelegationRefused(verdict);
  }

  const prev = { agentId: store.agentId, agentVersion: store.agentVersion, chain: store.chain };
  store.agentId = agentId;
  store.chain = chain;
  if (agentVersion) store.agentVersion = agentVersion;
  try {
    return await fn();
  } finally {
    store.agentId = prev.agentId;
    store.agentVersion = prev.agentVersion;
    store.chain = prev.chain;
  }
}
