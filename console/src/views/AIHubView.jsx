import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { useActiveCluster } from "../store/clusterStore";
import { useChatStore } from "../store/chatStore";
import { useViewStore } from "../store/viewStore";
import { PLATFORM_MAP, getPlatformInfo } from "../lib/platforms";

/* ── Constants ── */

const LLM_PROVIDERS = [
  { key: "builtin", abbr: "TA", color: "#e04040", name: "Built-in (TCS AI)" },
  { key: "anthropic", abbr: "CL", color: "#d4a27f", name: "Anthropic Claude" },
  { key: "openai", abbr: "GP", color: "#10a37f", name: "OpenAI" },
  { key: "azure", abbr: "AZ", color: "#0078d4", name: "Azure OpenAI" },
  { key: "google", abbr: "GE", color: "#4285f4", name: "Google Gemini" },
  { key: "bedrock", abbr: "BK", color: "#ff9900", name: "AWS Bedrock" },
  { key: "ollama", abbr: "OL", color: "#1d1d1f", name: "Ollama (Local)" },
];

const FLEET_SUGGESTIONS = [
  { label: "Upgrades", q: "Which clusters need version upgrades?" },
  { label: "Health", q: "Show cluster health across fleet" },
  { label: "Problem Pods", q: "List pods in error state across all clusters" },
  { label: "Security", q: "Run security audit across fleet" },
  { label: "Inventory", q: "Show full cluster inventory" },
];

const ENDPOINTS = [
  { label: "A2A Discovery", url: "/.well-known/agent.json" },
  { label: "Agent Registry", url: "/api/agents" },
  { label: "OpenAPI Spec", url: "/openapi.yaml" },
  { label: "Full MCP Server", url: "/sse" },
];

const FRAMEWORKS = [
  "Microsoft Agent Framework",
  "Anthropic Claude",
  "LangChain",
  "Any MCP client",
];

const PLATFORM_PILLS = Object.values(PLATFORM_MAP);

// Maps manifest icon names to display glyphs — mirrors the legacy agentEmojiFor().
const AGENT_ICON_MAP = {
  server: "\u{1F5A5}",            // 🖥
  package: "\u{1F4E6}",           // 📦
  stethoscope: "\u{1FA7A}",       // 🩺
  "arrow-up-circle": "\u{2B06}",  // ⬆
  "clipboard-check": "\u{1F4CB}", // 📋
  shield: "\u{1F6E1}",            // 🛡
  "shield-check": "\u{1F6E1}",    // 🛡
  network: "\u{1F310}",           // 🌐
  "git-branch": "\u{1F500}",      // 🔀
  activity: "\u{1F4C8}",          // 📈
  monitor: "\u{1F5A5}",           // 🖥
  brain: "\u{1F9E0}",             // 🧠
  globe: "\u{1F30D}",             // 🌍
};
function agentIcon(name) {
  return AGENT_ICON_MAP[(name || "").toLowerCase()] || "\u{1F916}";
}

// Legacy category display order.
const CATEGORY_ORDER = ["Operations", "Lifecycle", "Platform", "Governance", "Intelligence"];

export function AIHubView() {
  const cluster = useActiveCluster();
  const setSeed = useChatStore((s) => s.setSeed);
  const setActiveView = useViewStore((s) => s.setActiveView);
  const [fleetQuery, setFleetQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [detailAgent, setDetailAgent] = useState(null);

  const { data: agentData } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 10_000,
  });

  // Federated MCP hub tools (external connected servers).
  const { data: toolsData } = useQuery({
    queryKey: ["/api/hub/tools"],
    queryFn: ({ signal }) => apiGet("/api/hub/tools", { signal }).catch(() => ({})),
    staleTime: 30_000,
  });

  const { data: llmData } = useQuery({
    queryKey: ["/api/settings/llm"],
    queryFn: ({ signal }) => apiGet("/api/settings/llm", { signal }).catch(() => ({})),
    staleTime: 30_000,
  });

  // Real query-trace stats + per-agent analytics (last 30 days) — same source the legacy app uses.
  const { data: traceStats } = useQuery({
    queryKey: ["/api/traces/stats"],
    queryFn: ({ signal }) => apiGet("/api/traces/stats?days=30", { signal }).catch(() => ({})),
    staleTime: 30_000,
  });
  const { data: traceAnalytics } = useQuery({
    queryKey: ["/api/traces/analytics"],
    queryFn: ({ signal }) => apiGet("/api/traces/analytics?days=30", { signal }).catch(() => ({})),
    staleTime: 30_000,
  });

  // Hub platform derived from live cluster summary, not assumed.
  const { data: hubSummary } = useQuery({
    queryKey: ["/api/cluster/summary", "local"],
    queryFn: ({ signal }) => apiGet("/api/cluster/summary", { signal }),
    staleTime: 60_000,
  });
  const hubPInfo = getPlatformInfo(hubSummary?.platform);

  // Real agent registry from manifests.
  const { data: registryData } = useQuery({
    queryKey: ["/api/agents"],
    queryFn: ({ signal }) => apiGet("/api/agents", { signal }).catch(() => ({})),
    staleTime: 60_000,
  });

  const registryAgents = Array.isArray(registryData?.agents) ? registryData.agents : [];
  const registryTotal = registryData?.total ?? registryAgents.length;
  const serviceCount = new Set(registryAgents.flatMap((a) => a.services || [])).size;

  // Total MCP tools across all agents (sum incl. shared tools) — matches the
  // registry's own totalTools count, e.g. 167.
  const registryToolCount = registryData?.totalTools ?? registryAgents.reduce((s, a) => s + (a.tools?.length || 0), 0);
  // Unique built-in tools (for the capability grid).
  const registryTools = [...new Set(registryAgents.flatMap((a) => a.tools || []))];
  // Federated tools from external MCP servers connected to the hub.
  const hubTools = Array.isArray(toolsData?.tools) ? toolsData.tools : [];
  // Combined, de-duplicated tool catalogue for the capability grid.
  const uniqueToolSet = new Set(registryTools);
  for (const t of hubTools) uniqueToolSet.add(t.name || t);
  const toolList = [
    ...registryTools.map((name) => ({ name })),
    ...hubTools.filter((t) => !registryTools.includes(t.name)),
  ];
  const uniqueToolCount = uniqueToolSet.size;
  // Headline "tools" number tracks the registry total (167) plus any federated.
  const toolCount = registryToolCount + hubTools.filter((t) => !registryTools.includes(t.name)).length;

  const agents = Array.isArray(agentData?.agents) ? agentData.agents : [];
  const clusterCount = 1 + agents.length;
  const activeProviders = LLM_PROVIDERS.filter((p) => p.key === "builtin" || llmData?.[p.key]?.enabled).length;

  // Real per-agent usage analytics from the query tracer.
  const agentAnalytics = Array.isArray(traceAnalytics?.agents) ? traceAnalytics.agents : [];
  const totalQueries = traceStats?.total_queries ?? 0;
  const avgLatencyMs = traceStats?.avg_duration_ms ?? 0;
  const activeAgentCount = agentAnalytics.length;
  const peakHour = traceStats?.busiest_hours?.[0]?.hour;
  const connectedAgents = agents.filter((a) => a.status === "live" || a.status === "active").length;

  const handleFleetQuery = useCallback(() => {
    if (!fleetQuery.trim()) return;
    // Route the fleet question into the AI Chat (scoped to the active cluster)
    // where it runs against the real LLM + tools, instead of faking a response.
    setSeed(cluster, fleetQuery);
    setActiveView("chat");
    setFleetQuery("");
  }, [fleetQuery, cluster, setSeed, setActiveView]);

  // Group the real registry agents by their manifest category.
  const categoryMap = new Map();
  for (const a of registryAgents) {
    const cat = a.category || "Other";
    if (!categoryMap.has(cat)) categoryMap.set(cat, { name: cat, color: a.color || "#3b82f6", agents: [] });
    categoryMap.get(cat).agents.push(a);
  }
  const allCategories = Array.from(categoryMap.values()).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a.name); const ib = CATEGORY_ORDER.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const filteredCategories =
    selectedCategory === "all"
      ? allCategories
      : allCategories.filter((c) => c.name === selectedCategory);

  return (
    <div className="view-pane hub-view">
      {/* Hero Quick-Launch Bar */}
      <div className="hub-hero">
        <div className="hub-hero-inner">
          <div className="hub-hero-left">
            <div className="hub-hero-title">
              Enterprise Intelligence Platform
              <span className="hub-hero-badge">FLEET VIEW · ALL CLUSTERS</span>
            </div>
            <div className="hub-hero-sub">Unified AI control plane for multi-cluster Kubernetes</div>
          </div>
          <div className="hub-stat-rings">
            <div className="hub-stat-ring" style={{ color: "#22c55e", borderColor: "#22c55e" }}>
              <div className="hsr-num">{clusterCount}</div>
              <div className="hsr-label">Clusters</div>
            </div>
            <div className="hub-stat-ring" style={{ color: "#818cf8", borderColor: "#818cf8" }}>
              <div className="hsr-num">{toolCount || "--"}</div>
              <div className="hsr-label">Tools</div>
            </div>
            <div className="hub-stat-ring" style={{ color: "#fbbf24", borderColor: "#fbbf24" }}>
              <div className="hsr-num">{activeProviders}</div>
              <div className="hsr-label">LLMs</div>
            </div>
          </div>
        </div>
      </div>

      {/* Fleet AI Section */}
      <div className="hub-fleet-ai card">
        <div className="hub-section-head">
          <span style={{ fontSize: 16 }}>{"🌍"}</span>
          <h3>Fleet AI — Cross-Cluster Queries</h3>
        </div>
        <div className="hub-fleet-input-row">
          <input
            className="hub-fleet-input"
            placeholder="Ask across all clusters..."
            value={fleetQuery}
            onChange={(e) => setFleetQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleFleetQuery()}
          />
          <button className="hub-fleet-send" onClick={handleFleetQuery}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
        <div className="hub-fleet-chips">
          {FLEET_SUGGESTIONS.map((s) => (
            <button key={s.label} className="hub-fleet-chip" onClick={() => setFleetQuery(s.q)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Agent Usage Analytics — real query-trace data (last 30 days) */}
      <div className="hub-analytics card">
        <div className="hub-section-head">
          <span style={{ fontSize: 16 }}>{"📊"}</span>
          <h3>Agent Usage Analytics</h3>
          <span className="hub-tool-count">Last 30 days</span>
        </div>
        <div className="hub-analytics-grid">
          <AnalyticsStat label="Total Queries" value={totalQueries} color="#8b5cf6" />
          <AnalyticsStat label="Active Agents" value={activeAgentCount} color="var(--ok)" />
          <AnalyticsStat label="Avg Latency" value={avgLatencyMs ? `${avgLatencyMs}ms` : "--"} color="#22d3ee" />
          <AnalyticsStat label="Peak Hour" value={peakHour != null ? `${String(peakHour).padStart(2, "0")}:00` : "--"} color="#f59e0b" />
          <AnalyticsStat label="MCP Tools" value={toolCount || "--"} color="var(--accent2)" />
          <AnalyticsStat label="Clusters" value={clusterCount} color="#ec4899" />
        </div>

        {/* Per-agent usage table — real invocation data */}
        {agentAnalytics.length > 0 && (
          <div className="agent-usage-table">
            <div className="aut-head">
              <span>Agent</span><span>Invocations</span><span>Avg Latency</span><span>Error Rate</span><span>Last Used</span>
            </div>
            {agentAnalytics.slice(0, 8).map((a) => (
              <div className="aut-row" key={a.agent_id || a.agent_name}>
                <span className="aut-name">{a.agent_name || a.agent_id}</span>
                <span>{a.invocation_count}</span>
                <span>{a.avg_duration_ms != null ? `${a.avg_duration_ms}ms` : "--"}</span>
                <span style={{ color: a.error_rate > 0 ? "var(--crit)" : "var(--ok)" }}>{a.error_rate ?? 0}%</span>
                <span className="aut-time">{a.last_used ? timeAgo(a.last_used) : "--"}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* LLM Integration + Clusters */}
      <div className="hub-two-col">
        {/* AI Brain Providers */}
        <div className="card hub-panel">
          <div className="hub-section-head">
            <span style={{ fontSize: 16 }}>{"🧠"}</span>
            <h3>AI Brain — LLM Providers</h3>
          </div>
          <div className="hub-llm-grid">
            {LLM_PROVIDERS.map((p) => {
              const active = p.key === "builtin" || llmData?.[p.key]?.enabled;
              return (
                <div key={p.key} className={"hub-llm-pill" + (active ? " active" : "")}>
                  <span className="hub-llm-abbr" style={{ background: p.color }}>{p.abbr}</span>
                  <span className="hub-llm-name">{p.name}</span>
                  <span className={"hub-llm-status " + (active ? "on" : "off")}>{active ? "Active" : "Off"}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Kubernetes Clusters */}
        <div className="card hub-panel">
          <div className="hub-section-head">
            <span style={{ fontSize: 16 }}>{"☸"}</span>
            <h3>Kubernetes Clusters</h3>
          </div>
          <div className="hub-cluster-list">
            <div className="hub-cluster-item hub">
              <span className="hub-cluster-dot" style={{ background: "#22c55e" }} />
              <span className="hub-cluster-platform" style={{ color: hubPInfo.color }}>{hubPInfo.icon}</span>
              <span className="hub-cluster-name">Hub Cluster (Primary)</span>
              <span className="hub-cluster-plat-label">{hubPInfo.name}</span>
              <span className="badge badge-ok">Active</span>
            </div>
            {agents.map((a) => {
              const pInfo = getPlatformInfo(a.platform);
              const isLive = a.status === "live" || a.status === "active";
              return (
                <div key={a.clusterName} className="hub-cluster-item">
                  <span className="hub-cluster-dot" style={{ background: isLive ? "#22c55e" : "#ef4444" }} />
                  <span className="hub-cluster-platform" style={{ color: pInfo.color }}>{pInfo.icon}</span>
                  <span className="hub-cluster-name">{a.clusterName}</span>
                  <span className="hub-cluster-plat-label">{pInfo.name}</span>
                  <span className={"badge " + (isLive ? "badge-ok" : "badge-crit")}>
                    {isLive ? "Active" : a.status}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="hub-add-cluster-row">
            <div className="hub-add-label">Supported Platforms</div>
            <div className="hub-platform-pills">
              {PLATFORM_PILLS.map((p) => (
                <span key={p.key} className="hub-platform-pill" style={{ borderColor: p.color, color: p.color }}>
                  {p.icon} {p.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* MCP Capabilities — unique tools across the registry + federated servers */}
      <div className="card hub-panel">
        <div className="hub-section-head">
          <span style={{ fontSize: 16 }}>{"🔧"}</span>
          <h3>MCP Capabilities</h3>
          <span className="hub-tool-count">{toolCount} total · {uniqueToolCount} unique</span>
        </div>
        {uniqueToolCount === 0 ? (
          <div className="metric muted" style={{ fontSize: 13 }}>No tools reported</div>
        ) : (
          <div className="hub-mcp-grid">
            {toolList.map((t, i) => (
              <div key={t.name || i} className="hub-mcp-tool" title={t.description || t.name}>
                <span className="hub-mcp-icon">{"⚙"}</span>
                {t.name}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── AGENT REGISTRY ── */}
      <div className="hub-agent-registry">
        <div className="agents-hero">
          <div className="agents-hero-inner">
            <div>
              <div className="agents-hero-title">Agent Registry</div>
              <div className="agents-hero-badges">
                <span className="agents-hero-badge">MCP-native</span>
                <span className="agents-hero-badge">Framework-agnostic</span>
                <span className="agents-hero-badge">A2A discovery</span>
                <span className="agents-hero-badge">OpenAPI 3.1</span>
              </div>
            </div>
            <div className="agents-hero-stats">
              <div className="agents-stat">
                <div className="agents-stat-num">{registryTotal}</div>
                <div className="agents-stat-lbl">Agents</div>
              </div>
              <div className="agents-stat">
                <div className="agents-stat-num">{toolCount}</div>
                <div className="agents-stat-lbl">MCP Tools</div>
              </div>
              <div className="agents-stat">
                <div className="agents-stat-num">{serviceCount}</div>
                <div className="agents-stat-lbl">Services</div>
              </div>
            </div>
          </div>
        </div>

        {/* Integration Endpoints */}
        <div className="agents-endpoints card">
          <div className="agents-endpoints-title">Integration Endpoints</div>
          <div className="agents-endpoints-grid">
            {ENDPOINTS.map((ep) => (
              <div key={ep.label} className="agents-endpoint">
                <div className="agents-endpoint-label">{ep.label}</div>
                <code className="agents-endpoint-url">{ep.url}</code>
              </div>
            ))}
          </div>
          <div className="agents-frameworks">
            <span className="agents-frameworks-label">Compatible:</span>
            {FRAMEWORKS.map((f) => (
              <span key={f} className="agents-framework-pill">{f}</span>
            ))}
          </div>
        </div>

        {/* Agent Orchestration Flow */}
        {registryAgents.length > 0 && (
          <AgentFlowDiagram categories={allCategories} onSelect={setDetailAgent} />
        )}

        {/* Category Filter */}
        <div className="agents-filter-bar">
          <button className={"agents-filter-btn" + (selectedCategory === "all" ? " active" : "")} onClick={() => setSelectedCategory("all")}>All Agents</button>
          {allCategories.map((c) => (
            <button
              key={c.name}
              className={"agents-filter-btn" + (selectedCategory === c.name ? " active" : "")}
              style={selectedCategory === c.name ? { background: c.color, borderColor: c.color } : {}}
              onClick={() => setSelectedCategory(c.name)}
            >
              {c.name}
            </button>
          ))}
        </div>

        {/* Agent Cards — real registry data */}
        {registryAgents.length === 0 && (
          <div className="metric muted" style={{ fontSize: 13, padding: "20px 0" }}>Loading agent registry…</div>
        )}
        {filteredCategories.map((cat) => (
          <div key={cat.name} className="agents-category">
            <div className="agents-category-title" style={{ color: cat.color }}>
              <span className="agents-cat-dot" style={{ background: cat.color }} />
              {cat.name}
              <span className="agents-cat-count">{cat.agents.length}</span>
            </div>
            <div className="agents-cards-grid">
              {cat.agents.map((ag) => (
                <div
                  key={ag.id || ag.name}
                  className="agents-card"
                  style={{ borderTopColor: ag.color || cat.color }}
                  onClick={() => setDetailAgent(ag)}
                >
                  <div className="agents-card-icon">{agentIcon(ag.icon)}</div>
                  <div className="agents-card-name">{ag.name}</div>
                  <div className="agents-card-desc">{ag.description}</div>
                  <div className="agents-card-tools">
                    {(ag.tools || []).slice(0, 5).map((t) => (
                      <span key={t} className="agents-card-tool">{t}</span>
                    ))}
                    {(ag.tools || []).length > 5 && (
                      <span className="agents-card-tool">+{ag.tools.length - 5}</span>
                    )}
                  </div>
                  <div className="agents-card-status">
                    <span className="agents-card-dot" /> {(ag.protocols || []).map((p) => p.toUpperCase()).join(" · ") || "MCP"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Agent Detail Drawer — real registry data */}
      {detailAgent && (
        <div className="agent-detail-overlay" onClick={() => setDetailAgent(null)}>
          <div className="agent-detail" onClick={(e) => e.stopPropagation()}>
            <button className="agent-detail-close" onClick={() => setDetailAgent(null)}>&times;</button>
            <div className="agent-detail-icon">{agentIcon(detailAgent.icon)}</div>
            <h3>{detailAgent.name}</h3>
            <div className="agent-detail-cat" style={{ color: detailAgent.color }}>{detailAgent.category}{detailAgent.version ? ` · v${detailAgent.version}` : ""}</div>
            <p>{detailAgent.description}</p>

            {detailAgent.mcpEndpoint && (
              <>
                <h4>MCP Endpoint</h4>
                <div className="agent-detail-mcp">{detailAgent.mcpEndpoint}</div>
              </>
            )}

            {Array.isArray(detailAgent.capabilities) && detailAgent.capabilities.length > 0 && (
              <>
                <h4>Capabilities</h4>
                <ul>
                  {detailAgent.capabilities.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </>
            )}

            <h4>MCP Tools ({(detailAgent.tools || []).length})</h4>
            <div className="agent-detail-tool-list">
              {(detailAgent.tools || []).map((t) => (
                <span key={t} className="agent-detail-tool">{t}</span>
              ))}
            </div>

            {Array.isArray(detailAgent.services) && detailAgent.services.length > 0 && (
              <>
                <h4>Services</h4>
                <div className="agent-detail-tool-list">
                  {detailAgent.services.map((s) => (
                    <span key={s} className="agent-detail-tool">{s}</span>
                  ))}
                </div>
              </>
            )}

            <h4>Protocols</h4>
            <div className="agent-detail-protos">
              {(detailAgent.protocols || ["mcp"]).map((p) => (
                <span key={p} className="agent-detail-proto">{p}</span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AnalyticsStat({ label, value, color }) {
  return (
    <div className="hub-analytics-card">
      <div className="ha-value" style={{ color }}>{value}</div>
      <div className="ha-label">{label}</div>
    </div>
  );
}

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "--";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* Agent Orchestration Flow — User → AI Orchestrator → all agents, grouped by category. */
function AgentFlowDiagram({ categories, onSelect }) {
  const COL_W = 150, NODE_W = 134, NODE_H = 52, ROW_H = 70;
  const cols = categories.length;
  const maxRows = Math.max(1, ...categories.map((c) => c.agents.length));
  const width = Math.max(680, cols * COL_W + 30);
  const topY = 16, orchY = 96, agentTopY = 200;
  const height = agentTopY + maxRows * ROW_H + 10;
  const orchX = width / 2;

  return (
    <div className="agent-flow card">
      <div className="agent-flow-head">
        <span style={{ fontSize: 15 }}>{"🧭"}</span>
        <h3>Agent Orchestration Flow</h3>
        <span className="agent-flow-legend">
          <span><span className="afl-dot" style={{ background: "#6366f1" }} /> Orchestrator</span>
          <span><span className="afl-dot" style={{ background: "#22c55e" }} /> Agent</span>
        </span>
      </div>
      <div className="agent-flow-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: width, maxHeight: height }}>
          {/* edges: orchestrator → each agent */}
          {categories.map((cat, ci) =>
            cat.agents.map((a, ri) => {
              const ax = 15 + ci * COL_W + NODE_W / 2;
              const ay = agentTopY + ri * ROW_H;
              return (
                <path
                  key={`e-${a.id || a.name}`}
                  d={`M ${orchX} ${orchY + 28} C ${orchX} ${orchY + 80}, ${ax} ${ay - 40}, ${ax} ${ay}`}
                  stroke={a.color || "#3b82f6"} strokeWidth="1.2" fill="none" opacity="0.35"
                />
              );
            })
          )}
          {/* user → orchestrator */}
          <line x1={orchX} y1={topY + 24} x2={orchX} y2={orchY} stroke="#64748b" strokeWidth="1.4" />

          {/* user node */}
          <g>
            <rect x={orchX - 55} y={topY} width="110" height="26" rx="13" fill="#1e293b" stroke="#334155" />
            <text x={orchX} y={topY + 17} textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="600">{"\u{1F464} User Query"}</text>
          </g>

          {/* orchestrator node */}
          <g>
            <rect x={orchX - 130} y={orchY} width="260" height="44" rx="10" fill="url(#orchGrad)" stroke="#6366f1" />
            <text x={orchX} y={orchY + 20} textAnchor="middle" fill="#fff" fontSize="12.5" fontWeight="800">{"\u{1F9E0} AI Orchestrator"}</text>
            <text x={orchX} y={orchY + 35} textAnchor="middle" fill="#c7d2fe" fontSize="9">LLM Router · Intent Classification</text>
          </g>
          <defs>
            <linearGradient id="orchGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#312e81" /><stop offset="100%" stopColor="#4338ca" />
            </linearGradient>
          </defs>

          {/* agent nodes */}
          {categories.map((cat, ci) =>
            cat.agents.map((a, ri) => {
              const ax = 15 + ci * COL_W;
              const ay = agentTopY + ri * ROW_H;
              return (
                <g key={a.id || a.name} style={{ cursor: "pointer" }} onClick={() => onSelect(a)}>
                  <rect x={ax} y={ay} width={NODE_W} height={NODE_H} rx="9"
                    fill="#0d1117" stroke={a.color || "#3b82f6"} strokeWidth="1.3" />
                  <circle cx={ax + 14} cy={ay + 16} r="4" fill={a.color || "#3b82f6"} />
                  <text x={ax + 26} y={ay + 19} fill="#e2e8f0" fontSize="10" fontWeight="700">
                    {(a.name || "").replace(/ Agent$/, "").slice(0, 16)}
                  </text>
                  <text x={ax + 10} y={ay + 38} fill="#94a3b8" fontSize="8.5">
                    {(a.tools?.length || 0)} tools · {cat.name}
                  </text>
                </g>
              );
            })
          )}
        </svg>
      </div>
    </div>
  );
}
