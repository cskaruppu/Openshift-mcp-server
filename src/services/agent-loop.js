/**
 * Agent reasoning loop.
 *
 * Drives the LLM through a plan → call tool → observe → decide cycle so the
 * assistant can investigate cluster problems the way a human SRE would.
 *
 * Flow:
 *   1. Build system prompt describing the tools + how to use them.
 *   2. Call LLM with user message + full tool registry.
 *   3. If response contains tool_calls, dispatch them all and append results.
 *   4. Loop until LLM stops requesting tools or maxSteps is reached.
 *   5. Return final text + transcript.
 *
 * Safety:
 *   - All tools are read-only — mutations still flow through action-workflow.
 *   - Per-step timeout, max step cap, max context size.
 */

import { callLLM, callLLMStream } from "./llm.js";
import { TOOLS, dispatchTool } from "./tools-registry.js";

const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || "6", 10);
const MAX_TOOLS_PER_STEP = parseInt(process.env.AGENT_MAX_TOOLS_PER_STEP || "4", 10);

const SYSTEM_PROMPT = `You are an OpenShift SRE assistant. Your job is to investigate cluster problems by calling tools to gather live data, then explain what you found and recommend the next step.

Guidelines:
- Always call tools to gather evidence before answering. Never guess.
- Start with a single broad tool call (list_pods, list_deployments, list_nodes) then drill into specific resources with get_pod, get_pod_logs, get_events_for_resource.
- Correlate events + container state + logs to identify the root cause.
- For CrashLoopBackOff: always fetch previous logs (previous=true) and recent Warning events.
- For ImagePullBackOff: check the image field and registry events.
- For OOMKilled: check resource limits on the pod spec.
- Stop calling tools once you have enough evidence to answer.
- Respond in Markdown with sections: "Findings", "Root cause", "Recommended action".
- If the user explicitly asks for a mutation (restart/delete/scale), DO NOT run it — tell the user to confirm via the approval panel and describe what would change.
- Be concise. Do not repeat JSON back to the user.`;

/**
 * Run the agent loop for a single user message.
 *
 * @param {object} params
 * @param {string} params.userMessage
 * @param {string} [params.contextHint] - pre-gathered context to seed the conversation
 * @param {object} [params.llmOpts]
 * @param {function} [params.onDelta] - called with streamed text tokens
 * @param {function} [params.onStep] - called after each step: (stepInfo) => void
 * @returns {Promise<{text, steps, toolCalls}>}
 */
export async function runAgent({
  userMessage,
  contextHint = null,
  llmOpts = {},
  onDelta = null,
  onStep = null,
}) {
  const messages = [];
  const steps = [];
  const allToolCalls = [];

  // Seed with optional pre-gathered context so the model doesn't re-fetch.
  let userContent = userMessage;
  if (contextHint) {
    userContent = `${userMessage}\n\n--- Pre-gathered cluster snapshot ---\n${JSON.stringify(
      contextHint
    ).slice(0, 5000)}`;
  }
  messages.push({ role: "user", content: userContent });

  for (let step = 0; step < MAX_STEPS; step++) {
    const streaming = onDelta && step === MAX_STEPS - 1; // only stream final answer
    const fn = streaming ? callLLMStream : callLLM;
    const res = await fn({
      messages,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      maxTokens: 2000,
      temperature: 0.2,
      onDelta,
      ...llmOpts,
    });
    const { text, toolCalls = [] } = res;

    steps.push({
      step,
      text,
      toolCalls: toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })),
    });
    onStep?.({ step, text, toolCalls });

    if (!toolCalls.length) {
      // Model answered without requesting more tools — we're done.
      return { text, steps, toolCalls: allToolCalls };
    }

    // Append assistant turn (with tool calls) to history
    messages.push({
      role: "assistant",
      content:
        text ||
        toolCalls.map((tc) => `Calling ${tc.name}(${JSON.stringify(tc.arguments)})`).join("; "),
    });

    // Dispatch tool calls (cap per step)
    const toRun = toolCalls.slice(0, MAX_TOOLS_PER_STEP);
    const results = await Promise.all(
      toRun.map((tc) =>
        dispatchTool(tc.name, tc.arguments).then((r) => ({ tc, r }))
      )
    );

    const toolSummaries = [];
    for (const { tc, r } of results) {
      allToolCalls.push({ name: tc.name, arguments: tc.arguments, ok: r.ok, error: r.error });
      if (r.ok) {
        const compact = JSON.stringify(r.result).slice(0, 4000);
        toolSummaries.push(`Tool ${tc.name} result:\n${compact}`);
      } else {
        toolSummaries.push(`Tool ${tc.name} ERROR: ${r.error}`);
      }
    }
    messages.push({ role: "user", content: toolSummaries.join("\n\n") });
  }

  // Hit step cap — ask for a final answer without tools
  const final = await callLLM({
    messages: [
      ...messages,
      { role: "user", content: "You have reached the investigation step limit. Give your best answer now using only the evidence already gathered. Do not request more tools." },
    ],
    system: SYSTEM_PROMPT,
    tools: null,
    maxTokens: 1500,
    temperature: 0.2,
    ...llmOpts,
  });
  return { text: final.text, steps, toolCalls: allToolCalls };
}
