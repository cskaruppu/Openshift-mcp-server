/**
 * MCP Orchestrator — unified agent loop that routes tool calls
 * across all connected MCP servers (built-in + external).
 *
 * This is the brain of the KubeNexus AI platform:
 *   1. Collects tools from all connected MCP servers via the Hub
 *   2. Sends user message + tool definitions to the chosen LLM
 *   3. When LLM returns tool_calls, dispatches them to the correct MCP server
 *   4. Feeds results back and loops until LLM is done
 */

import { callLLM, callLLMStream } from "./llm.js";
import { getAllTools, callTool, getToolCount } from "./mcp-hub.js";

const MAX_STEPS = parseInt(process.env.ORCHESTRATOR_MAX_STEPS || "10", 10);
const MAX_TOOLS_PER_STEP = parseInt(process.env.ORCHESTRATOR_MAX_TOOLS_PER_STEP || "6", 10);

function buildSystemPrompt(serverSummary) {
  return `You are KubeNexus AI — a powerful enterprise platform for OpenShift cluster management, diagnostics, and automation.

You have access to tools from multiple connected MCP servers. Use them to investigate, diagnose, and solve problems.

Connected tool sources:
${serverSummary}

Guidelines:
- Always call tools to gather evidence before answering. Never guess or fabricate data.
- Start broad (list resources), then drill into specifics (get details, logs, events).
- Correlate multiple data sources: events + container state + logs + metrics.
- For CrashLoopBackOff: fetch previous logs (previous=true) and Warning events.
- For ImagePullBackOff: check the image field and registry connectivity.
- For OOMKilled: check resource limits vs actual usage via metrics.
- For network issues: check NetworkPolicies, Services, Routes, DNS.
- Stop calling tools once you have enough evidence to answer.
- When using external MCP server tools, call them by their exact name.
- Respond in Markdown with clear sections: **Findings**, **Root Cause**, **Recommended Action**.
- For mutations (restart/delete/scale): describe what would change and ask user to confirm.
- Be concise. Show key evidence, not raw JSON dumps.
- If a tool fails, try an alternative approach or explain the limitation.`;
}

function toolsToOpenAIFormat(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: `[${t._source === "builtin" ? "OpenShift" : t._serverId}] ${t.description}`,
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

function toolsToLLMFormat(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: `[${t._source === "builtin" ? "OpenShift" : t._serverId}] ${t.description}`,
    input_schema: t.input_schema || { type: "object", properties: {} },
  }));
}

/**
 * Run the orchestrator for a single user query.
 *
 * @param {object} params
 * @param {string} params.userMessage - The user's question
 * @param {string} [params.contextHint] - Pre-gathered cluster context
 * @param {object} [params.llmOpts] - LLM provider options
 * @param {function} [params.onDelta] - Streaming text callback
 * @param {function} [params.onStep] - Step progress callback
 * @param {function} [params.onToolCall] - Tool call notification callback
 * @param {string[]} [params.serverFilter] - Only use tools from these server IDs
 * @param {Array} [params.conversationHistory] - Prior messages for multi-turn
 * @returns {Promise<{text, steps, toolCalls, toolSources}>}
 */
export async function runOrchestrator({
  userMessage,
  contextHint = null,
  llmOpts = {},
  onDelta = null,
  onStep = null,
  onToolCall = null,
  serverFilter = null,
  conversationHistory = null,
}) {
  let allTools = getAllTools();

  if (serverFilter && serverFilter.length > 0) {
    allTools = allTools.filter(
      (t) => serverFilter.includes(t._serverId) || serverFilter.includes("builtin")
    );
  }

  const serverSummary = summarizeServers(allTools);
  const systemPrompt = buildSystemPrompt(serverSummary);
  const llmTools = toolsToLLMFormat(allTools);

  const messages = [];

  if (conversationHistory && conversationHistory.length > 0) {
    messages.push(...conversationHistory);
  }

  let userContent = userMessage;
  if (contextHint) {
    const ctxStr = typeof contextHint === "string"
      ? contextHint
      : JSON.stringify(contextHint).slice(0, 6000);
    userContent = `${userMessage}\n\n--- Pre-gathered cluster context ---\n${ctxStr}`;
  }
  messages.push({ role: "user", content: userContent });

  const steps = [];
  const allToolCalls = [];
  const toolSources = {};

  for (let step = 0; step < MAX_STEPS; step++) {
    const isLastStep = step === MAX_STEPS - 1;
    const streaming = onDelta && isLastStep;
    const fn = streaming ? callLLMStream : callLLM;

    const res = await fn({
      messages,
      system: systemPrompt,
      tools: llmTools.length > 0 ? llmTools : null,
      maxTokens: 3000,
      temperature: 0.2,
      onDelta,
      ...llmOpts,
    });

    const { text, toolCalls = [] } = res;

    steps.push({
      step,
      text: text || "",
      toolCalls: toolCalls.map((tc) => ({
        name: tc.name,
        arguments: tc.arguments,
      })),
    });
    onStep?.({ step, text, toolCalls, totalTools: allTools.length });

    if (!toolCalls.length || isLastStep) {
      return { text: text || "", steps, toolCalls: allToolCalls, toolSources };
    }

    messages.push({
      role: "assistant",
      content:
        text ||
        toolCalls.map((tc) => `Calling ${tc.name}(${JSON.stringify(tc.arguments)})`).join("; "),
    });

    const toRun = toolCalls.slice(0, MAX_TOOLS_PER_STEP);
    const results = await Promise.all(
      toRun.map(async (tc) => {
        onToolCall?.({ name: tc.name, arguments: tc.arguments, step });
        const r = await callTool(tc.name, tc.arguments);
        return { tc, r };
      })
    );

    const toolSummaries = [];
    for (const { tc, r } of results) {
      allToolCalls.push({
        name: tc.name,
        arguments: tc.arguments,
        ok: r.ok,
        error: r.error,
        source: r.source || "builtin",
      });
      toolSources[tc.name] = r.source || "builtin";

      if (r.ok) {
        const compact = JSON.stringify(r.result).slice(0, 5000);
        toolSummaries.push(`Tool ${tc.name} result:\n${compact}`);
      } else {
        toolSummaries.push(`Tool ${tc.name} ERROR: ${r.error}`);
      }
    }
    messages.push({ role: "user", content: toolSummaries.join("\n\n") });
  }

  const final = await callLLM({
    messages: [
      ...messages,
      {
        role: "user",
        content:
          "You have reached the investigation step limit. Give your best answer now using the evidence already gathered.",
      },
    ],
    system: buildSystemPrompt(summarizeServers(allTools)),
    tools: null,
    maxTokens: 2000,
    temperature: 0.2,
    ...llmOpts,
  });

  return { text: final.text, steps, toolCalls: allToolCalls, toolSources };
}

function summarizeServers(tools) {
  const bySource = {};
  for (const t of tools) {
    const key = t._source === "builtin" ? "OpenShift Built-in" : t._serverId;
    if (!bySource[key]) bySource[key] = [];
    bySource[key].push(t.name);
  }
  return Object.entries(bySource)
    .map(([src, names]) => `- ${src}: ${names.length} tools (${names.slice(0, 5).join(", ")}${names.length > 5 ? "..." : ""})`)
    .join("\n");
}

export { getAllTools, getToolCount };
