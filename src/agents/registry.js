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

/**
 * An agent narrowed to one of its declared profiles.
 *
 * A profile is a smaller allow-list over the same tools — which is exactly what
 * an agent already is, so this costs almost nothing. It answers the request
 * that keeps coming up as "can I have the old version": what people usually
 * want is not old behaviour, it is LESS surface. A read-only profile of the VM
 * Migration Agent hands someone discovery, analysis and verification and makes
 * `migrate` and `decommission` unreachable — the tool is never registered on
 * their server, so it cannot be called by mistake or on purpose.
 *
 * It also fixes something the governance view could not express: blast radius
 * was per agent, so VM Migration was `irreversible` for everyone including
 * somebody who only ever reads. A profile carries its own.
 *
 * A profile may only ever NARROW. A tool named in a profile but not in the
 * agent is dropped, so a profile can never become a way to widen an agent's
 * reach past what its manifest declared and review approved.
 */
export async function getAgentProfile(agentId, profileName) {
  const agent = await getAgentById(agentId);
  if (!agent) return null;
  if (!profileName) return agent;

  const p = agent.profiles?.[profileName];
  if (!p) return null;

  const declared = new Set(agent.tools || []);
  const tools = (p.tools || []).filter((t) => declared.has(t));

  return {
    ...agent,
    id: `${agent.id}:${profileName}`,
    baseId: agent.id,
    profile: profileName,
    name: p.name || `${agent.name} (${profileName})`,
    description: p.description || agent.description,
    tools,
    profiles: undefined,
    governance: {
      ...(agent.governance || {}),
      // The narrower radius wins; a profile cannot claim to be safer than it is
      // by declaring one its tools do not support, but it can be narrower than
      // the agent — which is the whole point.
      ...(p.blastRadius ? { blastRadius: p.blastRadius } : {}),
      ...(p.autonomyLevel ? { autonomyLevel: p.autonomyLevel } : {}),
    },
  };
}

/** Every profile declared across the fleet, as flat rows. */
export async function listProfiles() {
  const agents = await getAgents();
  const out = [];
  for (const a of agents) {
    for (const [name, p] of Object.entries(a.profiles || {})) {
      const declared = new Set(a.tools || []);
      const kept = (p.tools || []).filter((t) => declared.has(t));
      out.push({
        id: `${a.id}:${name}`, baseId: a.id, profile: name,
        name: p.name || `${a.name} (${name})`,
        description: p.description || null,
        toolCount: kept.length,
        // A tool listed in a profile that the agent does not have is a manifest
        // error worth surfacing rather than silently swallowing.
        unknownTools: (p.tools || []).filter((t) => !declared.has(t)),
        blastRadius: p.blastRadius || a.governance?.blastRadius || null,
        autonomyLevel: p.autonomyLevel || a.governance?.autonomyLevel || null,
      });
    }
  }
  return out;
}

/**
 * Posture and scorecard for ONE agent, by the same route the lens takes.
 *
 * Exists so a promotion request carries exactly the evidence the requester was
 * looking at when they pressed the button. Recomputing it differently — or
 * later — would mean the change request says something the console never
 * showed, which is the sort of discrepancy that surfaces at an audit.
 */
export async function buildPostureFor(agentId) {
  const agent = await getAgentById(agentId);
  if (!agent) return null;

  const { agentPosture } = await import("./governance.js");
  const { scoreAgent } = await import("./scorecard.js");

  let claim = null, promotion = null, served = null, seen = null;
  try {
    const { getOwnership } = await import("../services/agent-ownership.js");
    claim = (await getOwnership()).get(agentId) || null;
  } catch { /* no claims */ }
  try {
    const { getPromotion } = await import("./promotion.js");
    promotion = await getPromotion(agentId);
  } catch { /* no promotions */ }
  try {
    const { implementedTools } = await import("./tool-index.js");
    served = await implementedTools();
  } catch { /* probe unavailable */ }
  try {
    const { getAgentAnalytics } = await import("../services/query-tracer.js");
    seen = ((await getAgentAnalytics({ days: 30 })).agents || [])
      .find((x) => (x.agent_id || x.agent_name) === agentId) || null;
  } catch { /* no traces */ }

  const posture = agentPosture(
    agent,
    seen ? { tools: seen.most_common_tools || [] } : null,
    Date.now(),
    { claim, promotion },
  );
  const scorecard = scoreAgent({
    owner: posture.owner, blastRadius: posture.blastRadius, trustTier: posture.trustTier,
    autonomy: posture.autonomy, certification: posture.certification, reconciled: posture.reconciled,
    missingTools: served ? (agent.tools || []).filter((t) => !served.has(t)) : null,
    lastUsed: seen?.last_used || null, errorRate: seen?.error_rate ?? null,
    hasExamples: !!(agent.examples?.length),
  });
  return { agent, posture, scorecard };
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

  // Every listing carries the complete, connectable URLs. A registry whose
  // entries can't be connected to from what's on screen is a catalogue of
  // names, not of agents.
  const proto0 = req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http");
  const base0 = `${proto0}://${req.headers.host || "localhost"}`;
  const withUrls = (a) => ({
    ...a,
    transport: "sse",
    mcpSseUrl: `${base0}${a.mcpEndpoint}/sse`,
    mcpMessageUrl: `${base0}${a.mcpEndpoint}/message`,
    toolsUrl: `${base0}/api/agents/${a.id}/tools`,
  });
  const registryEndpoints = {
    agentCard: `${base0}/.well-known/agent.json`,
    agents: `${base0}/api/agents`,
    categories: `${base0}/api/agents/categories`,
    combinedMcpSse: `${base0}/sse`,
    catalogDoc: `${base0}/api/docs/download?doc=agent-catalog`,
    startHere: `${base0}/api/docs/download?doc=start-here`,
  };

  // ── Governance lens ────────────────────────────────────────────────────
  // The same agents, asked a different question: what is each permitted to do,
  // who owns it, what did it actually spend, and is it behaving inside its own
  // declaration. Served separately from /api/agents so the catalog stays cheap
  // — this one reads telemetry.
  if (url.pathname === "/api/agents/governance") {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const manifestAgents = await getAgents();
    const { agentPosture, fleetPosture } = await import("./governance.js");

    // External agents connected through the MCP hub are agents too, and they
    // are the ones this lens exists for. They live in a different place from
    // the manifests, so without this they would be onboardable and ungovernable
    // — present in the tool pool, absent from every posture count.
    let externalAgents = [];
    try {
      const { listServers } = await import("../services/mcp-hub.js");
      externalAgents = (listServers() || [])
        .filter((srv) => srv.id !== "builtin")
        .map((srv) => ({
          id: srv.id,
          name: srv.name,
          category: "External",
          description: `Connected over ${srv.type}${srv.url ? ` from ${srv.url}` : ""}.`,
          tools: (srv.tools || []).map((t) => t.name),
          // trustTier defaults to "external" at connect time — that is a fact
          // about where it came from, not an assumption. Everything else stays
          // exactly as declared, including undeclared.
          governance: srv.governance || { trustTier: "external" },
          _external: true,
          _onboardedBy: srv.onboardedBy || null,
          _status: srv.status,
        }));
    } catch { /* hub unavailable — manifest agents still answer */ }

    const agents = [...manifestAgents, ...externalAgents];

    // What telemetry actually recorded. Absent means absent — never inferred.
    let usage = { available: false, byAgent: new Map(), unattributed: null };
    try {
      const { getAgentTokenUsage } = await import("../services/telemetry.js");
      usage = await getAgentTokenUsage({ days });
    } catch { /* no telemetry — every agent reports "not attributed" */ }

    let observedBy = new Map();
    try {
      const { getAgentAnalytics } = await import("../services/query-tracer.js");
      const an = await getAgentAnalytics({ days });
      observedBy = new Map((an.agents || []).map((a) => [a.agent_id || a.agent_name, a]));
    } catch { /* no traces — posture still answers the declared half */ }

    // Accepted ownership, and candidates for the agents nobody has accepted.
    // Both best-effort: a registry that fails to load because CODEOWNERS is
    // missing would be a poor trade for a convenience.
    let claims = new Map();
    try {
      const { getOwnership } = await import("../services/agent-ownership.js");
      claims = await getOwnership();
    } catch { /* no claims — manifest declarations still stand */ }

    // Approved promotions move an agent off probation and certify it, the same
    // way a claim gives it an owner: recorded here, merged at read time, with
    // the manifest still the durable answer.
    let promotions = new Map();
    try {
      const { getPromotions } = await import("./promotion.js");
      promotions = await getPromotions();
    } catch { /* no promotions — every agent sits at its declared lifecycle */ }

    let hints = new Map();
    try {
      const unowned = agents.filter((a) => !a.governance?.owner && !claims.has(a.id)).map((a) => a.id);
      if (unowned.length) {
        const { suggestOwners } = await import("./owner-hints.js");
        hints = await suggestOwners(unowned);
      }
    } catch { /* no suggestions — the Claim field is then simply empty */ }

    // Which declared tools are actually served. Cached after the first call.
    let served = null;
    try {
      const { implementedTools } = await import("./tool-index.js");
      served = await implementedTools();
    } catch { /* probe unavailable — the tools check reports unknown */ }

    const { scoreAgent, scoreFleet } = await import("./scorecard.js");

    const now = Date.now();
    const postures = agents.map((a) => {
      const seen = observedBy.get(a.id) || null;
      const p = agentPosture(a, seen ? {
        tools: seen.most_common_tools || [],
        // Egress and caller attribution are not captured yet. An empty array
        // would read as "nothing observed, all clear"; these stay undefined so
        // the posture reports them as unobserved rather than clean.
      } : null, now, {
        claim: claims.get(a.id) || null,
        suggestion: hints.get(a.id) || null,
        promotion: promotions.get(a.id) || null,
      });
      const u = usage.byAgent.get(a.id) || null;
      return {
        ...p,
        activity: seen ? {
          invocations: seen.invocation_count ?? null,
          avgDurationMs: seen.avg_duration_ms ?? null,
          errorRate: seen.error_rate ?? null,
          lastUsed: seen.last_used || null,
        } : null,
        // Measured, or null. There is no third option here by design — the
        // figure this replaced was apportioned by invocation share and bore no
        // relation to what the agent spent.
        usage: u ? { ...u, attributed: true } : { attributed: false },
        external: !!a._external,
        onboardedBy: a._onboardedBy || null,
        connectionStatus: a._status || null,
        // One number and the reasons it is not higher. Sixteen agents fit in a
        // table; sixty need a ranked worklist.
        scorecard: scoreAgent({
          owner: p.owner,
          blastRadius: p.blastRadius,
          trustTier: p.trustTier,
          autonomy: p.autonomy,
          certification: p.certification,
          reconciled: p.reconciled,
          // null, not [], when the probe could not run — "checked, none
          // missing" and "could not check" score very differently.
          missingTools: served ? (a.tools || []).filter((t) => !served.has(t)) : null,
          lastUsed: seen?.last_used || null,
          errorRate: seen?.error_rate ?? null,
          hasExamples: !!(a.examples?.length),
        }),
      };
    });

    // "My agents". At sixty agents nobody reads the fleet table, but every
    // owner reads their own five rows — the same reason an HR system opens on
    // your team rather than the company directory. Matches an owner declared in
    // the manifest OR accepted by claim, since both mean the same thing here.
    const me = req.user?.name || null;
    const scope = url.searchParams.get("scope") === "mine" ? "mine" : "all";
    const mine = me
      ? postures.filter((p) => p.owner === me || p.claim?.by === me)
      : [];
    const shown = scope === "mine" ? mine : postures;

    sendJson(res, 200, {
      days,
      scope, user: me, mineCount: mine.length, totalCount: postures.length,
      fleet: fleetPosture(shown),
      health: scoreFleet(shown.map((p) => p.scorecard)),
      tokensAttributed: usage.available,
      unattributed: usage.unattributed,
      // Said once, plainly, so the console does not have to guess why a whole
      // column is empty.
      usageNote: usage.available
        ? (usage.unattributed?.calls
          ? `${usage.unattributed.calls} model call(s) in this window carry no agent, so their ${usage.unattributed.totalTokens.toLocaleString()} tokens are unattributed rather than shared out.`
          : null)
        : "Per-agent token usage is not being recorded yet, so cost per agent is not attributed.",
      agents: shown,
    });
    return true;
  }

  if (url.pathname === "/api/agents") {
    const agents = await getAgents();
    sendJson(res, 200, {
      total: agents.length,
      totalTools: agents.reduce((sum, a) => sum + (a.tools?.length || 0), 0),
      registry: registryEndpoints,
      agents: agents.map(withUrls),
    });
    return true;
  }

  if (url.pathname === "/api/agents/categories") {
    const groups = await getCategories();
    sendJson(res, 200, {
      registry: registryEndpoints,
      categories: groups.map((g) => ({ ...g, agents: g.agents.map(withUrls) })),
    });
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
    // Self-describing: a client that fetches one agent should not have to
    // reconstruct its transport URLs from a convention it cannot see.
    const proto = req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http");
    const base = `${proto}://${req.headers.host || "localhost"}`;
    sendJson(res, 200, {
      ...agent,
      transport: "sse",
      mcpSseUrl: `${base}${agent.mcpEndpoint}/sse`,
      mcpMessageUrl: `${base}${agent.mcpEndpoint}/message`,
      toolsUrl: `${base}/api/agents/${agent.id}/tools`,
    });
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
    type: "mcp-gateway",
    description:
      "MCP Gateway and AI Control Plane for multi-cluster Kubernetes management. " +
      "Single MCP endpoint that multiplexes tool calls across all connected clusters via AI-Native Cluster Agents. " +
      "Supports OpenShift, EKS, AKS, GKE, Rancher, and vanilla K8s. " +
      "MCP-native, framework-agnostic — compatible with Microsoft Agent Framework, Anthropic Claude Agent SDK, LangChain, and any MCP-aware client.",
    version: "2.0.0",
    publisher: {
      name: "TCS",
      url: "https://www.tcs.com",
    },
    protocols: ["mcp", "mcp-gateway-v1", "rest", "a2a"],
    gateway: {
      protocol: "mcp-gateway-v1",
      heartbeatInterval: 30,
      staleThreshold: 90,
      unreachableThreshold: 300,
      agentType: "ai-native",
    },
    capabilities: {
      agents: agents.length,
      tools: totalTools,
      streaming: true,
      humanInTheLoop: true,
      multiCluster: true,
      autonomous: true,
      gateway: true,
      aiNativeAgents: true,
    },
    endpoints: {
      mcp: `${baseUrl}/mcp`,
      mcpGateway: `${baseUrl}/sse`,
      rest: `${baseUrl}/api`,
      agents: `${baseUrl}/api/agents`,
      categories: `${baseUrl}/api/agents/categories`,
      heartbeat: `${baseUrl}/api/agent/heartbeat`,
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
      // The CONNECTABLE URL. The manifest's mcpEndpoint is a base path, and
      // advertising it bare returned 404 for every client that trusted the
      // card — MCP over SSE connects to the /sse endpoint and posts replies to
      // /message. Publish both, and name the transport, so a framework can
      // wire this up without reading our source.
      transport: "sse",
      mcpEndpoint: `${baseUrl}${a.mcpEndpoint}/sse`,
      mcpSseUrl: `${baseUrl}${a.mcpEndpoint}/sse`,
      mcpMessageUrl: `${baseUrl}${a.mcpEndpoint}/message`,
      toolsUrl: `${baseUrl}/api/agents/${a.id}/tools`,
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
