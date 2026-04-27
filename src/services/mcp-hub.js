/**
 * MCP Hub Manager — connects to external MCP servers as a client.
 *
 * Maintains a registry of connected MCP servers and their tools.
 * Built-in OpenShift tools are exposed as a "local" provider.
 * External servers connect via stdio, SSE, or StreamableHTTP.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOOLS as builtinTools, dispatchTool as dispatchBuiltinTool } from "./tools-registry.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const CONFIG_PATH = process.env.MCP_HUB_CONFIG || "/data/mcp-hub-servers.json";

const connections = new Map();
let _configLoaded = false;

function makeId() {
  return "mcp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function builtinToolsAsOpenAI() {
  return builtinTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    _source: "builtin",
    _serverId: "builtin",
  }));
}

export function getBuiltinTools() {
  return builtinToolsAsOpenAI();
}

async function createTransport(config) {
  const { type } = config;
  if (type === "sse") {
    return new SSEClientTransport(new URL(config.url));
  }
  if (type === "streamable-http") {
    return new StreamableHTTPClientTransport(new URL(config.url));
  }
  if (type === "stdio") {
    const env = { ...process.env, ...(config.env || {}) };
    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env,
    });
  }
  throw new Error(`Unsupported transport type: ${type}`);
}

export async function connectServer(config) {
  const id = config.id || makeId();
  if (connections.has(id)) {
    throw new Error(`Server "${id}" already connected`);
  }

  const client = new Client(
    { name: "tcs-cloudnexus-hub", version: "1.0.0" },
    { capabilities: {} }
  );

  const transport = await createTransport(config);

  client.onerror = (err) => {
    console.error(`[mcp-hub] Error on server "${config.name || id}":`, err.message || err);
  };

  await client.connect(transport);

  let tools = [];
  try {
    const result = await client.listTools();
    tools = (result.tools || []).map((t) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.inputSchema || {},
      _source: "external",
      _serverId: id,
    }));
  } catch (err) {
    console.error(`[mcp-hub] Failed to list tools from "${config.name || id}":`, err.message);
  }

  const entry = {
    id,
    name: config.name || id,
    type: config.type,
    url: config.url || null,
    command: config.command || null,
    args: config.args || [],
    env: config.env || {},
    client,
    transport,
    tools,
    status: "connected",
    connectedAt: new Date().toISOString(),
  };

  connections.set(id, entry);
  console.error(`[mcp-hub] Connected to "${entry.name}" — ${tools.length} tools`);
  await saveConfig();
  return serializeEntry(entry);
}

export async function disconnectServer(id) {
  const entry = connections.get(id);
  if (!entry) throw new Error(`Server "${id}" not found`);
  try {
    await entry.transport.close?.();
  } catch { /* ignore */ }
  connections.delete(id);
  await saveConfig();
  return { ok: true, id };
}

export async function reconnectServer(id) {
  const entry = connections.get(id);
  if (!entry) throw new Error(`Server "${id}" not found`);
  const config = {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    url: entry.url,
    command: entry.command,
    args: entry.args,
    env: entry.env,
  };
  try { await disconnectServer(id); } catch { /* ignore */ }
  return connectServer(config);
}

export function listServers() {
  const servers = [
    {
      id: "builtin",
      name: "OpenShift Built-in Tools",
      type: "local",
      status: "connected",
      toolCount: builtinTools.length,
      tools: builtinToolsAsOpenAI().map((t) => ({ name: t.name, description: t.description })),
    },
  ];
  for (const entry of connections.values()) {
    servers.push(serializeEntry(entry));
  }
  return servers;
}

export function getAllTools() {
  const all = [...builtinToolsAsOpenAI()];
  for (const entry of connections.values()) {
    if (entry.status === "connected") {
      all.push(...entry.tools);
    }
  }
  return all;
}

export function getToolCount() {
  let count = builtinTools.length;
  for (const entry of connections.values()) {
    count += entry.tools.length;
  }
  return count;
}

export async function callTool(toolName, args) {
  const builtinMatch = builtinTools.find((t) => t.name === toolName);
  if (builtinMatch) {
    return dispatchBuiltinTool(toolName, args);
  }

  for (const entry of connections.values()) {
    const tool = entry.tools.find((t) => t.name === toolName);
    if (tool) {
      try {
        const result = await entry.client.callTool({ name: toolName, arguments: args || {} });
        const text = (result.content || [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        return { ok: true, result: parsed, source: entry.name };
      } catch (err) {
        return { ok: false, error: err.message, source: entry.name };
      }
    }
  }

  return { ok: false, error: `Tool "${toolName}" not found in any connected server` };
}

export function findToolServer(toolName) {
  if (builtinTools.find((t) => t.name === toolName)) return "builtin";
  for (const entry of connections.values()) {
    if (entry.tools.find((t) => t.name === toolName)) return entry.id;
  }
  return null;
}

function serializeEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    url: entry.url,
    command: entry.command,
    status: entry.status,
    connectedAt: entry.connectedAt,
    toolCount: entry.tools.length,
    tools: entry.tools.map((t) => ({ name: t.name, description: t.description })),
  };
}

async function saveConfig() {
  const configs = [];
  for (const entry of connections.values()) {
    configs.push({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      url: entry.url,
      command: entry.command,
      args: entry.args,
      env: entry.env,
    });
  }
  try {
    const dir = resolve(CONFIG_PATH, "..");
    await mkdir(dir, { recursive: true }).catch(() => {});
    await writeFile(CONFIG_PATH, JSON.stringify(configs, null, 2));
  } catch (err) {
    console.error(`[mcp-hub] Failed to save config:`, err.message);
  }
}

export async function loadAndReconnect() {
  if (_configLoaded) return;
  _configLoaded = true;
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const configs = JSON.parse(raw);
    for (const cfg of configs) {
      try {
        await connectServer(cfg);
      } catch (err) {
        console.error(`[mcp-hub] Auto-reconnect failed for "${cfg.name || cfg.id}":`, err.message);
      }
    }
  } catch {
    // No saved config — first run
  }
}

export function getConnectionCount() {
  return connections.size;
}
