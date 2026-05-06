/**
 * Centralized LLM client.
 *
 * Supports three providers — openai, anthropic, ollama — plus a "none" mode
 * for built-in analysis. Exposes three flavors of call:
 *
 *   callLLM({messages, tools}) → {text, toolCalls}
 *   callLLMStream({messages, onDelta, onToolCall}) → {text, toolCalls}
 *   classifyJSON({prompt, schemaHint}) → parsed object | null
 *
 * Any provider can be selected per-request by passing an `opts` object so the
 * dashboard's provider dropdown still works.
 */

import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || "none";
const DEFAULT_API_URL = process.env.LLM_API_URL || "http://localhost:11434";
const DEFAULT_API_KEY = process.env.LLM_API_KEY || "";
const DEFAULT_MODEL = process.env.LLM_MODEL || "gpt-4";
const DEFAULT_AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "";
const DEFAULT_AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview";

const AZURE_USE_MANAGED_IDENTITY = process.env.AZURE_USE_MANAGED_IDENTITY === "true";
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || "";
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || "";

const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  || process.env.https_proxy || process.env.http_proxy || "";

if (HTTPS_PROXY) {
  console.error(`[llm] Using proxy for external LLM calls: ${HTTPS_PROXY}`);
}

const llmDispatcher = HTTPS_PROXY
  ? new ProxyAgent({ uri: HTTPS_PROXY, requestTls: { rejectUnauthorized: false } })
  : new Agent({
      connect: { rejectUnauthorized: false, timeout: 30_000 },
      bodyTimeout: 60_000,
      headersTimeout: 30_000,
      keepAliveTimeout: 10_000,
      pipelining: 0,
    });

const DNS_RETRY_CODES = new Set(["EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const MAX_RETRIES = 5;

async function llmFetch(url, opts, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await undiciFetch(url, { ...opts, dispatcher: llmDispatcher });
    } catch (err) {
      const code = err.cause?.code || err.code || "";
      if (attempt < retries && DNS_RETRY_CODES.has(code)) {
        const delay = Math.min(2000 * Math.pow(2, attempt) + Math.random() * 1000, 15000);
        console.error(`[llm] Network error (${code}), retry ${attempt + 1}/${retries} in ${Math.round(delay)}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

export function llmEnabled(opts = {}) {
  const p = opts.provider || DEFAULT_PROVIDER;
  return p && p !== "none";
}

export function getSupportedProviders() {
  return ["openai", "azure", "anthropic", "ollama", "none"];
}

function resolveOpts(opts = {}) {
  return {
    provider: opts.provider || DEFAULT_PROVIDER,
    apiUrl: opts.apiUrl || DEFAULT_API_URL,
    apiKey: opts.apiKey || DEFAULT_API_KEY,
    model: opts.model || DEFAULT_MODEL,
    maxTokens: opts.maxTokens || 2000,
    temperature: opts.temperature ?? 0.3,
    system: opts.system || null,
    tools: opts.tools || null,
    azureDeployment: opts.azureDeployment || opts.deployment || DEFAULT_AZURE_DEPLOYMENT,
    azureApiVersion: opts.azureApiVersion || opts.apiVersion || DEFAULT_AZURE_API_VERSION,
    maxRetries: opts.maxRetries ?? MAX_RETRIES,
  };
}

// ---------------------------------------------------------------------------
// Non-streaming call — returns { text, toolCalls }
// ---------------------------------------------------------------------------
export async function callLLM({ messages, ...opts }) {
  const o = resolveOpts(opts);
  if (o.provider === "azure") return callAzureOpenAI(messages, o, false);
  if (o.provider === "openai") return callOpenAI(messages, o, false);
  if (o.provider === "anthropic") return callAnthropic(messages, o, false);
  if (o.provider === "ollama") return callOllama(messages, o, false);
  return { text: "", toolCalls: [] };
}

// ---------------------------------------------------------------------------
// Streaming call — invokes `onDelta(text)` for each token chunk and
// `onToolCall(tc)` for tool-use blocks. Returns final aggregated result.
// ---------------------------------------------------------------------------
export async function callLLMStream({ messages, onDelta, onToolCall, ...opts }) {
  const o = resolveOpts(opts);
  const hooks = { onDelta, onToolCall };
  if (o.provider === "azure") return callAzureOpenAI(messages, o, true, hooks);
  if (o.provider === "openai") return callOpenAI(messages, o, true, hooks);
  if (o.provider === "anthropic") return callAnthropic(messages, o, true, hooks);
  if (o.provider === "ollama") return callOllama(messages, o, true, hooks);
  return { text: "", toolCalls: [] };
}

// ---------------------------------------------------------------------------
// JSON classification helper — used by NLU→LLM fallback.
// Returns the parsed object, or null if unable to parse.
// ---------------------------------------------------------------------------
export async function classifyJSON({ prompt, system, ...opts }) {
  try {
    const r = await callLLM({
      messages: [{ role: "user", content: prompt }],
      system: system || "Respond ONLY with a JSON object. No prose.",
      temperature: 0,
      maxTokens: 400,
      ...opts,
    });
    const text = (r.text || "").trim();
    // Strip ```json fences if present
    const unfenced = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end < 0) return null;
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ===========================================================================
// OpenAI (OpenAI + Azure + any OpenAI-compatible endpoint)
// ===========================================================================
async function callOpenAI(messages, o, stream, hooks = {}) {
  const url = `${o.apiUrl.replace(/\/$/, "") || "https://api.openai.com"}/v1/chat/completions`;
  const body = {
    model: o.model,
    messages: o.system
      ? [{ role: "system", content: o.system }, ...messages]
      : messages,
    max_tokens: o.maxTokens,
    temperature: o.temperature,
    stream: !!stream,
  };
  if (o.tools && o.tools.length) {
    body.tools = o.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  let resp;
  try {
    resp = await llmFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, o.maxRetries);
  } catch (fetchErr) {
    const cause = fetchErr.cause || {};
    const detail = cause.code || cause.message || fetchErr.message;
    throw new Error(`OpenAI network error: ${detail}`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${err.substring(0, 500)}`);
  }
  if (!stream && !contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
    const body = await resp.text();
    throw new Error(`OpenAI returned non-JSON (${contentType}). Response: ${body.substring(0, 300)}`);
  }
  if (!stream) {
    const data = await resp.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content || "";
    const toolCalls = (choice?.message?.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: safeJSON(tc.function?.arguments),
    }));
    return { text, toolCalls, raw: data };
  }
  // Streaming — parse SSE lines
  let text = "";
  const toolCalls = [];
  await readSSE(resp.body, (evt) => {
    if (evt === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(evt); } catch { return; }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      text += delta.content;
      hooks.onDelta?.(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, name: "", arguments: "" };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
      }
    }
  });
  const parsedCalls = toolCalls.filter(Boolean).map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: safeJSON(tc.arguments),
  }));
  for (const tc of parsedCalls) hooks.onToolCall?.(tc);
  return { text, toolCalls: parsedCalls };
}

// ===========================================================================
// Azure Managed Identity token helper
// ===========================================================================
let _azureTokenCache = { token: null, expiresAt: 0 };

async function getAzureToken() {
  if (_azureTokenCache.token && Date.now() < _azureTokenCache.expiresAt - 60000) {
    return _azureTokenCache.token;
  }
  const scope = "https://cognitiveservices.azure.com/.default";
  const url = AZURE_CLIENT_ID
    ? `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(scope)}&client_id=${AZURE_CLIENT_ID}`
    : `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(scope)}`;

  const resp = await undiciFetch(url, {
    headers: { "Metadata": "true" },
    dispatcher: new Agent({ connect: { timeout: 5000 } }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Azure managed identity token error ${resp.status}: ${err.substring(0, 200)}`);
  }
  const data = await resp.json();
  _azureTokenCache = {
    token: data.access_token,
    expiresAt: parseInt(data.expires_on, 10) * 1000,
  };
  return data.access_token;
}

// ===========================================================================
// Azure OpenAI
// ===========================================================================
async function callAzureOpenAI(messages, o, stream, hooks = {}) {
  const baseUrl = (o.apiUrl || "").replace(/\/$/, "");
  const deployment = o.azureDeployment || o.model || "gpt-4";
  const apiVersion = o.azureApiVersion || DEFAULT_AZURE_API_VERSION;
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  const body = {
    messages: o.system
      ? [{ role: "system", content: o.system }, ...messages]
      : messages,
    max_tokens: o.maxTokens,
    temperature: o.temperature,
    stream: !!stream,
  };
  if (o.tools && o.tools.length) {
    body.tools = o.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  let authHeaders;
  if (AZURE_USE_MANAGED_IDENTITY || o.azureManagedIdentity) {
    const token = await getAzureToken();
    authHeaders = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
  } else {
    authHeaders = { "api-key": o.apiKey, "Content-Type": "application/json" };
  }

  let resp;
  try {
    resp = await llmFetch(url, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
    }, o.maxRetries);
  } catch (fetchErr) {
    const cause = fetchErr.cause || {};
    const detail = cause.code || cause.message || fetchErr.message;
    throw new Error(`Azure OpenAI network error: ${detail} (URL: ${baseUrl})`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (resp.status === 429) {
    const retryAfter = resp.headers.get("retry-after") || "10";
    const delay = parseInt(retryAfter, 10) * 1000;
    console.warn(`[llm] Azure rate limited, retry after ${retryAfter}s`);
    await new Promise(r => setTimeout(r, delay));
    // Retry once
    return callAzureOpenAI(messages, { ...o, maxRetries: 0 }, stream, hooks);
  }
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Azure OpenAI ${resp.status}: ${err.substring(0, 500)} (URL: ${url})`);
  }
  if (!stream && !contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
    const body = await resp.text();
    throw new Error(`Azure OpenAI returned non-JSON (${contentType}). A proxy may be intercepting requests. Response: ${body.substring(0, 300)} (URL: ${url})`);
  }
  if (!stream) {
    const data = await resp.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content || "";
    const toolCalls = (choice?.message?.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: safeJSON(tc.function?.arguments),
    }));
    // Check Azure content safety filters
    const filterResults = data.choices?.[0]?.content_filter_results;
    if (filterResults) {
      const blocked = Object.entries(filterResults).filter(([_, v]) => v.filtered);
      if (blocked.length > 0) {
        console.warn(`[llm] Azure content filter blocked: ${blocked.map(([k]) => k).join(", ")}`);
        return { text: "I cannot provide that response due to content safety policies. Please rephrase your question.", toolCalls: [], filtered: true };
      }
    }
    return { text, toolCalls, raw: data };
  }
  // Streaming — Azure uses same SSE format as OpenAI
  let text = "";
  const toolCalls = [];
  await readSSE(resp.body, (evt) => {
    if (evt === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(evt); } catch { return; }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      text += delta.content;
      hooks.onDelta?.(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, name: "", arguments: "" };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
      }
    }
  });
  const parsedCalls = toolCalls.filter(Boolean).map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: safeJSON(tc.arguments),
  }));
  for (const tc of parsedCalls) hooks.onToolCall?.(tc);
  return { text, toolCalls: parsedCalls };
}

// ===========================================================================
// Anthropic Claude
// ===========================================================================
async function callAnthropic(messages, o, stream, hooks = {}) {
  const url = `${o.apiUrl.replace(/\/$/, "") || "https://api.anthropic.com"}/v1/messages`;
  // Anthropic expects system separate and only user/assistant messages
  const amsgs = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const body = {
    model: o.model && o.model !== "gpt-4" ? o.model : "claude-sonnet-4-20250514",
    system: o.system || undefined,
    messages: amsgs,
    max_tokens: o.maxTokens,
    temperature: o.temperature,
    stream: !!stream,
  };
  if (o.tools && o.tools.length) {
    body.tools = o.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }
  let resp;
  try {
    resp = await llmFetch(url, {
      method: "POST",
      headers: {
        "x-api-key": o.apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    }, o.maxRetries);
  } catch (fetchErr) {
    const cause = fetchErr.cause || {};
    const detail = cause.code || cause.message || fetchErr.message;
    throw new Error(`Anthropic network error: ${detail}`);
  }
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${err.substring(0, 500)}`);
  }
  if (!stream) {
    const data = await resp.json();
    let text = "";
    const toolCalls = [];
    for (const block of data.content || []) {
      if (block.type === "text") text += block.text;
      if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
      }
    }
    return { text, toolCalls, raw: data };
  }
  // Streaming
  let text = "";
  const toolCalls = [];
  let currentTool = null;
  let currentToolJson = "";
  await readSSE(resp.body, (evt) => {
    let chunk;
    try { chunk = JSON.parse(evt); } catch { return; }
    if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") {
      currentTool = { id: chunk.content_block.id, name: chunk.content_block.name, arguments: null };
      currentToolJson = "";
    }
    if (chunk.type === "content_block_delta") {
      if (chunk.delta?.type === "text_delta") {
        text += chunk.delta.text;
        hooks.onDelta?.(chunk.delta.text);
      }
      if (chunk.delta?.type === "input_json_delta") {
        currentToolJson += chunk.delta.partial_json || "";
      }
    }
    if (chunk.type === "content_block_stop" && currentTool) {
      currentTool.arguments = safeJSON(currentToolJson);
      toolCalls.push(currentTool);
      hooks.onToolCall?.(currentTool);
      currentTool = null;
    }
  });
  return { text, toolCalls };
}

// ===========================================================================
// Ollama (local)
// ===========================================================================
async function callOllama(messages, o, stream, hooks = {}) {
  const url = `${o.apiUrl.replace(/\/$/, "") || "http://localhost:11434"}/api/chat`;
  const body = {
    model: o.model && o.model !== "gpt-4" ? o.model : "llama3",
    messages: o.system
      ? [{ role: "system", content: o.system }, ...messages]
      : messages,
    stream: !!stream,
    options: { temperature: o.temperature },
  };
  if (o.tools && o.tools.length) {
    body.tools = o.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  let resp;
  try {
    resp = await llmFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, o.maxRetries);
  } catch (fetchErr) {
    const cause = fetchErr.cause || {};
    const detail = cause.code || cause.message || fetchErr.message;
    throw new Error(`Ollama network error: ${detail}`);
  }
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Ollama ${resp.status}: ${err.substring(0, 500)}`);
  }
  if (!stream) {
    const data = await resp.json();
    const text = data.message?.content || "";
    const toolCalls = (data.message?.tool_calls || []).map((tc) => ({
      id: tc.id || `ollama-${Math.random().toString(36).slice(2, 8)}`,
      name: tc.function?.name,
      arguments: tc.function?.arguments,
    }));
    return { text, toolCalls, raw: data };
  }
  // Streaming — Ollama emits NDJSON
  let text = "";
  const toolCalls = [];
  await readNDJSON(resp.body, (chunk) => {
    if (chunk.message?.content) {
      text += chunk.message.content;
      hooks.onDelta?.(chunk.message.content);
    }
    if (chunk.message?.tool_calls) {
      for (const tc of chunk.message.tool_calls) {
        toolCalls.push({
          id: tc.id || `ollama-${Math.random().toString(36).slice(2, 8)}`,
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        });
        hooks.onToolCall?.(toolCalls[toolCalls.length - 1]);
      }
    }
  });
  return { text, toolCalls };
}

// ---------------------------------------------------------------------------
// Fallback chain — tries providers in order until one succeeds
// ---------------------------------------------------------------------------
const LLM_SETTINGS_PATH = process.env.LLM_SETTINGS_PATH || "/data/mcp-llm-settings.json";

async function loadFallbackChain() {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(LLM_SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw);
    return settings.fallbackChain || null;
  } catch {
    return null;
  }
}

async function loadProviderSettings() {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(LLM_SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw);
    return settings.providers || {};
  } catch {
    return {};
  }
}

/**
 * Call LLM with automatic fallback through a chain of providers.
 *
 * Tries the primary provider first, then falls back through the configured
 * chain (from /tmp/mcp-llm-settings.json) on network/auth/rate-limit errors.
 *
 * @param {object} opts - Same opts as callLLM, plus `messages`
 * @returns {{ text, toolCalls, provider: string, fallback: boolean }}
 */
export async function callLLMWithFallback({ messages, ...opts }) {
  const o = resolveOpts(opts);
  const chain = await loadFallbackChain() || [o.provider, "none"];
  const providerSettings = await loadProviderSettings();

  // Ensure primary provider is first
  const orderedChain = [o.provider, ...chain.filter((p) => p !== o.provider)];
  // Deduplicate
  const seen = new Set();
  const uniqueChain = orderedChain.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  let lastError = null;
  for (let i = 0; i < uniqueChain.length; i++) {
    const provider = uniqueChain[i];
    if (provider === "none") {
      return { text: "", toolCalls: [], provider: "none", fallback: i > 0 };
    }

    // Build opts for this provider from saved settings or request opts
    const pSettings = providerSettings[provider] || {};
    const callOpts = {
      ...opts,
      provider,
      apiKey: i === 0 ? (opts.apiKey || pSettings.apiKey || "") : (pSettings.apiKey || ""),
      apiUrl: i === 0 ? (opts.apiUrl || pSettings.apiUrl || "") : (pSettings.apiUrl || ""),
      model: i === 0 ? (opts.model || pSettings.model || "") : (pSettings.model || ""),
    };

    try {
      console.error(`[llm-fallback] Trying provider: ${provider}${i > 0 ? " (fallback)" : ""}`);
      const result = await callLLM({ messages, ...callOpts });
      return { ...result, provider, fallback: i > 0 };
    } catch (err) {
      lastError = err;
      console.error(`[llm-fallback] Provider ${provider} failed: ${err.message}`);
      // Only fallback on network, auth, or rate-limit errors
      const status = err.message?.match(/\b(401|403|429|500|502|503|504|ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b/);
      if (!status && i === 0) {
        // Not a fallback-worthy error on primary — rethrow
        throw err;
      }
    }
  }

  throw lastError || new Error("All LLM providers in fallback chain failed");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeJSON(s) {
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return s; }
}

async function readSSE(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6).trim();
          if (payload) onEvent(payload);
        }
      }
    }
  }
}

async function readNDJSON(body, onChunk) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { onChunk(JSON.parse(line)); } catch {}
    }
  }
}
