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

// Maps manifest icon names (e.g. "shield") to display glyphs.
const AGENT_ICON_MAP = {
  shield: "\u{1F6E1}", heart: "\u{1F49A}", search: "\u{1F50D}", wrench: "\u{1F527}",
  rocket: "\u{1F680}", recycle: "♻", globe: "\u{1F310}", database: "\u{1F4BE}",
  lock: "\u{1F512}", check: "✅", chart: "\u{1F4CA}", bell: "\u{1F514}",
  network: "\u{1F578}", cpu: "\u{1F9E0}", cloud: "☁", layers: "\u{1F5C2}",
  gear: "⚙", server: "\u{1F5A5}", activity: "\u{1F493}", box: "\u{1F4E6}",
};
function agentIcon(name) {
  return AGENT_ICON_MAP[(name || "").toLowerCase()] || "\u{1F916}";
}

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

  // Real usage analytics from the audit trail (last 30 days).
  const { data: statsData } = useQuery({
    queryKey: ["/api/audit-trail/stats"],
    queryFn: ({ signal }) => apiGet("/api/audit-trail/stats?days=30", { signal }).catch(() => ({})),
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

  // Unique built-in tools across all agent manifests.
  const registryTools = [...new Set(registryAgents.flatMap((a) => a.tools || []))];
  // Federated tools from external MCP servers connected to the hub.
  const hubTools = Array.isArray(toolsData?.tools) ? toolsData.tools : [];
  // Combined, de-duplicated tool catalogue for display.
  const toolNameSet = new Set(registryTools);
  for (const t of hubTools) toolNameSet.add(t.name || t);
  const toolList = [
    ...registryTools.map((name) => ({ name })),
    ...hubTools.filter((t) => !registryTools.includes(t.name)),
  ];
  const toolCount = toolNameSet.size;

  const agents = Array.isArray(agentData?.agents) ? agentData.agents : [];
  const clusterCount = 1 + agents.length;
  const activeProviders = LLM_PROVIDERS.filter((p) => p.key === "builtin" || llmData?.[p.key]?.enabled).length;

  // Derive real counts from the audit-trail stats response.
  const byType = Array.isArray(statsData?.byType) ? statsData.byType : [];
  const totalEvents = byType.reduce((sum, t) => sum + (t.count || 0), 0);
  const sumTypes = (re) => byType.filter((t) => re.test(t.event_type || t.type || "")).reduce((s, t) => s + (t.count || 0), 0);
  const queryCount = sumTypes(/query|chat|question|ask/i);
  const actionCount = sumTypes(/action|remediat|scale|restart|delete|drain|cordon|deploy|rollout/i);
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
  const allCategories = Array.from(categoryMap.values());
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

      {/* Agent Usage Analytics — real values from the audit trail (last 30 days) */}
      <div className="hub-analytics card">
        <div className="hub-section-head">
          <span style={{ fontSize: 16 }}>{"📊"}</span>
          <h3>Agent Usage Analytics</h3>
          <span className="hub-tool-count">Last 30 days</span>
        </div>
        <div className="hub-analytics-grid">
          <AnalyticsStat label="Agents Connected" value={connectedAgents} color="var(--ok)" />
          <AnalyticsStat label="MCP Tools" value={toolCount || "--"} color="var(--accent2)" />
          <AnalyticsStat label="Total Events" value={totalEvents} color="#8b5cf6" />
          <AnalyticsStat label="Queries" value={queryCount} color="#22d3ee" />
          <AnalyticsStat label="Actions Taken" value={actionCount} color="#f59e0b" />
          <AnalyticsStat label="Clusters" value={clusterCount} color="#ec4899" />
        </div>
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

      {/* MCP Capabilities — real tools from /api/tools */}
      <div className="card hub-panel">
        <div className="hub-section-head">
          <span style={{ fontSize: 16 }}>{"🔧"}</span>
          <h3>MCP Capabilities</h3>
          <span className="hub-tool-count">{toolCount} tools</span>
        </div>
        {toolCount === 0 ? (
          <div className="metric muted" style={{ fontSize: 13 }}>No tools reported</div>
        ) : (
          <div className="hub-mcp-grid">
            {toolList.slice(0, 24).map((t, i) => (
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
