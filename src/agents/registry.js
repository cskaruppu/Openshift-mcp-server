/**
 * Agent Registry — loads agent manifests, exposes them via REST API.
 *
 * This is the standards layer that turns the MCP server's tools into
 * named, discoverable, framework-portable agents. Existing tool code
 * is unchanged — manifests describe which tools belong to which agent.
 *
 * Endpoints (mounted in src/index.js):
 *   GET /.well-known/agent.json     — A2A-compatible agent card
 *   GET /api/agents                 — list of all agents
 *   GET /api/agents/:id             — single agent detail
 *   GET /api/agents/:id/tools       — tools belonging to an agent
 *   GET /api/agents/categories      — agents grouped by category
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = resolve(__dirname, "manifests");

let _agents = null;
let _byId = null;
let _byTool = null;

export async function loadAgents() {
  if (_agents) return _agents;
  try {
    const files = await readdir(MANIFESTS_DIR);
    const manifestFiles = files.filter((f) => f.endsWith(".json"));
    const loaded = [];
    for (const f of manifestFiles) {
      try {
        const content = await readFile(resolve(MANIFESTS_DIR, f), "utf8");
        loaded.push(JSON.parse(content));
      } catch (e) {
        console.error(`[agents] Failed to load manifest ${f}:`, e.message);
      }
    }
    loaded.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    _agents = loaded;
    _byId = new Map(loaded.map((a) => [a.id, a]));
    _byTool = new Map();
    for (const a of loaded) {
      for (const t of a.tools || []) {
        if (!_byTool.has(t)) _byTool.set(t, []);
        _byTool.get(t).push(a.id);
      }
    }
    return _agents;
  } catch (e) {
    console.error("[agents] Failed to load agent registry:", e.message);
    _agents = [];
    _byId = new Map();
    _byTool = new Map();
    return _agents;
  }
}

export async function getAgents() {
  await loadAgents();
  return _agents;
}

export async function getAgentById(id) {
  await loadAgents();
  return _byId.get(id) || null;
}

export async function getAgentsByTool(toolName) {
  await loadAgents();
  return _byTool.get(toolName) || [];
}

export async function getCategories() {
  const agents = await getAgents();
  const map = new Map();
  for (const a of agents) {
    const cat = a.category || "Other";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(a);
  }
  return Array.from(map.entries()).map(([category, items]) => ({ category, agents: items }));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Handle /api/agents/* and /.well-known/agent.json routes.
 * Returns true when handled, false when caller should continue.
 */
export async function handleAgentRoutes(req, res, url) {
  if (req.method !== "GET") return false;

  if (url.pathname === "/.well-known/agent.json") {
    return serveAgentCard(req, res);
  }

  if (url.pathname === "/api/agents") {
    const agents = await getAgents();
    sendJson(res, 200, {
      total: agents.length,
      totalTools: agents.reduce((sum, a) => sum + (a.tools?.length || 0), 0),
      agents,
    });
    return true;
  }

  if (url.pathname === "/api/agents/categories") {
    const groups = await getCategories();
    sendJson(res, 200, { categories: groups });
    return true;
  }

  if (url.pathname === "/api/agents/flow") {
    const agents = await getAgents();
    const nodes = [
      { id: "user", type: "user", label: "User", x: 400, y: 20 },
      { id: "orchestrator", type: "orchestrator", label: "AI Orchestrator (LLM)", x: 400, y: 120 },
    ];
    const edges = [
      { from: "user", to: "orchestrator", label: "Query" },
      { from: "orchestrator", to: "user", label: "Answer", dashed: true },
    ];
    const categoryPositions = { Operations: 0, Lifecycle: 1, Platform: 2, Governance: 3, Intelligence: 4 };
    const byCategory = new Map();
    for (const a of agents) {
      const cat = a.category || "Other";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(a);
    }
    let catIdx = 0;
    for (const [cat, group] of byCategory) {
      const baseX = 80 + catIdx * 160;
      for (let i = 0; i < group.length; i++) {
        const a = group[i];
        nodes.push({
          id: a.id,
          type: "agent",
          label: a.name,
          icon: a.icon,
          color: a.color,
          category: cat,
          toolCount: a.tools?.length || 0,
          x: baseX,
          y: 260 + i * 90,
        });
        edges.push({ from: "orchestrator", to: a.id, label: "" });
      }
      catIdx++;
    }
    sendJson(res, 200, { nodes, edges, totalAgents: agents.length });
    return true;
  }

  const idMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (idMatch) {
    const agent = await getAgentById(idMatch[1]);
    if (!agent) {
      sendJson(res, 404, { error: "Agent not found", id: idMatch[1] });
      return true;
    }
    sendJson(res, 200, agent);
    return true;
  }

  const toolsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/tools$/);
  if (toolsMatch) {
    const agent = await getAgentById(toolsMatch[1]);
    if (!agent) {
      sendJson(res, 404, { error: "Agent not found", id: toolsMatch[1] });
      return true;
    }
    sendJson(res, 200, { id: agent.id, name: agent.name, tools: agent.tools || [] });
    return true;
  }

  return false;
}

async function serveAgentCard(req, res) {
  const agents = await getAgents();
  const totalTools = agents.reduce((sum, a) => sum + (a.tools?.length || 0), 0);
  const host = req.headers.host || "localhost";
  const proto = (req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http"));
  const baseUrl = `${proto}://${host}`;

  const card = {
    name: "TCS Agentic AI",
    description:
      "Enterprise AI platform for OpenShift cluster management, diagnostics, upgrades, ITSM, and proactive intelligence. " +
      "MCP-native, framework-agnostic — compatible with Microsoft Agent Framework, Anthropic Claude Agent SDK, LangChain, and any MCP-aware client.",
    version: "2.0.0",
    publisher: {
      name: "TCS",
      url: "https://www.tcs.com",
    },
    protocols: ["mcp", "rest", "a2a"],
    capabilities: {
      agents: agents.length,
      tools: totalTools,
      streaming: true,
      humanInTheLoop: true,
      multiCluster: true,
      autonomous: true,
    },
    endpoints: {
      mcp: `${baseUrl}/mcp`,
      rest: `${baseUrl}/api`,
      agents: `${baseUrl}/api/agents`,
      categories: `${baseUrl}/api/agents/categories`,
      openapi: `${baseUrl}/openapi.yaml`,
      dashboard: `${baseUrl}/`,
    },
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      category: a.category,
      icon: a.icon,
      toolCount: (a.tools || []).length,
      mcpEndpoint: `${baseUrl}${a.mcpEndpoint}`,
      detailUrl: `${baseUrl}/api/agents/${a.id}`,
    })),
    authentication: {
      schemes: ["bearer", "oauth2"],
    },
    compliance: {
      mcp: "https://modelcontextprotocol.io/specification",
      a2a: "https://github.com/google/A2A",
      openapi: "https://spec.openapis.org/oas/v3.1.0",
    },
  };

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
  res.end(JSON.stringify(card, null, 2));
  return true;
}
