import { useState } from "react";

/** One-click copy with visible feedback — endpoints exist to be pasted. */
function CopyBtn({ text, small }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        try { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); } catch { /* clipboard unavailable */ }
      }}
      title={"Copy " + text}
      style={{ padding: small ? "1px 7px" : "3px 10px", borderRadius: 6, border: "1px solid var(--border,#e4e8f1)",
        background: ok ? "rgba(22,163,74,0.12)" : "var(--card-bg,#fff)", color: ok ? "#16a34a" : "var(--muted,#5a6373)",
        fontSize: small ? "0.64rem" : "0.72rem", fontWeight: 700, cursor: "pointer", flex: "0 0 auto" }}>
      {ok ? "✓ copied" : "⧉ copy"}
    </button>
  );
}

/** Full connectable SSE URL for an agent, wherever the console is served from. */
function sseUrlOf(agent) {
  return agent.mcpSseUrl || `${window.location.origin}${agent.mcpEndpoint || `/mcp/${agent.id}`}/sse`;
}
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { useActiveCluster } from "../store/clusterStore";
import { getPlatformInfo } from "../lib/platforms";

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

const AGENT_ICON_MAP = {
  server: "\u{1F5A5}",
  package: "\u{1F4E6}",
  stethoscope: "\u{1FA7A}",
  "arrow-up-circle": "\u{2B06}",
  "clipboard-check": "\u{1F4CB}",
  shield: "\u{1F6E1}",
  "shield-check": "\u{1F6E1}",
  network: "\u{1F310}",
  "git-branch": "\u{1F500}",
  activity: "\u{1F4C8}",
  monitor: "\u{1F5A5}",
  brain: "\u{1F9E0}",
  globe: "\u{1F30D}",
};
function agentIcon(name) {
  return AGENT_ICON_MAP[(name || "").toLowerCase()] || "\u{1F916}";
}

function formatTokens(n) {
  if (n == null) return "--";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

const CATEGORY_ORDER = ["Operations", "Lifecycle", "Platform", "Governance", "Intelligence"];

export function AgentRegistryModal({ open, onClose }) {
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [detailAgent, setDetailAgent] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");

  const { data: registryData } = useQuery({
    queryKey: ["/api/agents"],
    queryFn: ({ signal }) => apiGet("/api/agents", { signal }).catch(() => ({})),
    staleTime: 60_000,
    enabled: open,
  });

  const { data: toolsData } = useQuery({
    queryKey: ["/api/hub/tools"],
    queryFn: ({ signal }) => apiGet("/api/hub/tools", { signal }).catch(() => ({})),
    staleTime: 30_000,
    enabled: open,
  });

  const { data: traceStats } = useQuery({
    queryKey: ["/api/traces/stats"],
    queryFn: ({ signal }) => apiGet("/api/traces/stats?days=30", { signal }).catch(() => ({})),
    staleTime: 30_000,
    enabled: open,
  });

  const { data: traceAnalytics } = useQuery({
    queryKey: ["/api/traces/analytics"],
    queryFn: ({ signal }) => apiGet("/api/traces/analytics?days=30", { signal }).catch(() => ({})),
    staleTime: 30_000,
    enabled: open,
  });

  if (!open) return null;

  const registryAgents = Array.isArray(registryData?.agents) ? registryData.agents : [];
  const registryTotal = registryData?.total ?? registryAgents.length;
  const serviceCount = new Set(registryAgents.flatMap((a) => a.services || [])).size;
  const registryToolCount = registryData?.totalTools ?? registryAgents.reduce((s, a) => s + (a.tools?.length || 0), 0);
  const registryTools = [...new Set(registryAgents.flatMap((a) => a.tools || []))];
  const hubTools = Array.isArray(toolsData?.tools) ? toolsData.tools : [];
  const toolCount = registryToolCount + hubTools.filter((t) => !registryTools.includes(t.name)).length;

  const agentAnalytics = Array.isArray(traceAnalytics?.agents) ? traceAnalytics.agents : [];
  const totalQueries = traceStats?.total_queries ?? 0;
  const avgLatencyMs = traceStats?.avg_duration_ms ?? 0;

  const categoryMap = new Map();
  for (const a of registryAgents) {
    const cat = a.category || "Other";
    if (!categoryMap.has(cat)) categoryMap.set(cat, { name: cat, color: a.color || "#3b82f6", agents: [] });
    categoryMap.get(cat).agents.push(a);
  }
  const allCategories = Array.from(categoryMap.values()).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a.name);
    const ib = CATEGORY_ORDER.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const filteredCategories = (selectedCategory === "all" ? allCategories : allCategories.filter((c) => c.name === selectedCategory))
    .map((cat) => {
      if (!searchTerm.trim()) return cat;
      const term = searchTerm.toLowerCase();
      const filtered = cat.agents.filter(
        (a) => (a.name || "").toLowerCase().includes(term) || (a.description || "").toLowerCase().includes(term) || (a.tools || []).some((t) => t.toLowerCase().includes(term))
      );
      return { ...cat, agents: filtered };
    })
    .filter((cat) => cat.agents.length > 0);

  return (
    <>
      <div className="ar-modal-overlay" onClick={onClose} />
      <div className="ar-modal">
        {/* Header */}
        <div className="ar-modal-header">
          <div className="ar-header-left">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="7" r="3" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" />
              <line x1="12" y1="10" x2="5" y2="15.5" /><line x1="12" y1="10" x2="19" y2="15.5" />
              <line x1="5" y1="15.5" x2="19" y2="15.5" strokeDasharray="2 2" opacity="0.5" />
            </svg>
            <h2>Agent Registry</h2>
            <span className="ar-header-badge">CENTRALIZED · ALL CLUSTERS</span>
          </div>
          <button className="ar-modal-close" onClick={onClose}>&times;</button>
        </div>

        {/* Body */}
        <div className="ar-modal-body">
          {/* Stats Hero */}
          <div className="ar-stats-row">
            <div className="ar-stat">
              <div className="ar-stat-num">{registryTotal}</div>
              <div className="ar-stat-label">Agents</div>
            </div>
            <div className="ar-stat">
              <div className="ar-stat-num">{toolCount || "--"}</div>
              <div className="ar-stat-label">MCP Tools</div>
            </div>
            <div className="ar-stat">
              <div className="ar-stat-num">{serviceCount}</div>
              <div className="ar-stat-label">Services</div>
            </div>
            <div className="ar-stat">
              <div className="ar-stat-num">{totalQueries}</div>
              <div className="ar-stat-label">Queries (30d)</div>
            </div>
            <div className="ar-stat">
              <div className="ar-stat-num">{avgLatencyMs ? `${avgLatencyMs}ms` : "--"}</div>
              <div className="ar-stat-label">Avg Latency</div>
            </div>
          </div>

          {/* Protocol Badges */}
          <div className="ar-protocol-row">
            <span className="ar-proto-badge">MCP-native</span>
            <span className="ar-proto-badge">Framework-agnostic</span>
            <span className="ar-proto-badge">A2A discovery</span>
            <span className="ar-proto-badge">OpenAPI 3.1</span>
          </div>

          {/* Integration Endpoints */}
          <div className="ar-endpoints">
            <div className="ar-endpoints-title">Integration Endpoints</div>
            <div className="ar-endpoints-grid">
              {ENDPOINTS.map((ep) => (
                <div key={ep.label} className="ar-endpoint">
                  <div className="ar-endpoint-label">{ep.label}</div>
                  <code className="ar-endpoint-url">{ep.url}</code>
                </div>
              ))}
            </div>
            <div className="ar-frameworks">
              <span className="ar-frameworks-label">Compatible:</span>
              {FRAMEWORKS.map((f) => (
                <span key={f} className="ar-framework-pill">{f}</span>
              ))}
            </div>
          </div>

          {/* Orchestration Flow */}
          {registryAgents.length > 0 && (
            <AgentFlowDiagram categories={allCategories} onSelect={setDetailAgent} />
          )}

          {/* Search + Filter */}
          <div className="ar-toolbar">
            <input
              className="ar-search"
              placeholder="Search agents, tools..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <div className="ar-filter-btns">
              <button className={"ar-filter-btn" + (selectedCategory === "all" ? " active" : "")} onClick={() => setSelectedCategory("all")}>All</button>
              {allCategories.map((c) => (
                <button
                  key={c.name}
                  className={"ar-filter-btn" + (selectedCategory === c.name ? " active" : "")}
                  style={selectedCategory === c.name ? { background: c.color, borderColor: c.color } : {}}
                  onClick={() => setSelectedCategory(c.name)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          {/* Registry endpoints — the front door for any external MCP/A2A client */}
          {(() => {
            const reg = registryData?.registry || {};
            const rows = [
              { l: "Agent card (A2A discovery)", u: reg.agentCard || `${window.location.origin}/.well-known/agent.json` },
              { l: "Registry API (all agents + URLs)", u: reg.agents || `${window.location.origin}/api/agents` },
              { l: "Combined MCP (all tools, one server)", u: reg.combinedMcpSse || `${window.location.origin}/sse` },
            ];
            return (
              <div style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: "10px 14px", marginBottom: 14, background: "var(--card-bg,#fff)" }}>
                <div style={{ fontSize: "0.74rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted,#5a6373)", marginBottom: 7 }}>
                  🔌 Registry endpoints — point any MCP or A2A client here
                </div>
                {rows.map((r) => (
                  <div key={r.l} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.72rem", color: "var(--muted,#5a6373)", flex: "0 0 250px" }}>{r.l}</span>
                    <code style={{ fontSize: "0.7rem", color: "var(--fg,#151a29)", background: "var(--bg,#f1f5f9)", padding: "2px 8px", borderRadius: 6, wordBreak: "break-all", flex: "1 1 320px" }}>{r.u}</code>
                    <CopyBtn text={r.u} small />
                  </div>
                ))}
                <div style={{ fontSize: "0.68rem", color: "var(--muted,#5a6373)", marginTop: 7 }}>
                  Each agent below is its own MCP server — click a card for its individual endpoint. Prefer a specific agent over the combined server: a focused tool list improves tool selection.
                </div>
              </div>
            );
          })()}

          {/* Agent Cards */}
          {registryAgents.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--text2)", padding: "20px 0", textAlign: "center" }}>Loading agent registry…</div>
          )}
          {filteredCategories.map((cat) => (
            <div key={cat.name} className="ar-category">
              <div className="ar-category-title" style={{ color: cat.color }}>
                <span className="ar-cat-dot" style={{ background: cat.color }} />
                {cat.name}
                <span className="ar-cat-count">{cat.agents.length}</span>
              </div>
              <div className="ar-cards-grid">
                {cat.agents.map((ag) => (
                  <div
                    key={ag.id || ag.name}
                    className="ar-card"
                    style={{ borderTopColor: ag.color || cat.color }}
                    onClick={() => setDetailAgent(ag)}
                  >
                    <div className="ar-card-icon">{agentIcon(ag.icon)}</div>
                    <div className="ar-card-name">{ag.name}</div>
                    <div className="ar-card-desc">{ag.description}</div>
                    <div className="ar-card-tools">
                      {(ag.tools || []).slice(0, 5).map((t) => (
                        <span key={t} className="ar-card-tool">{t}</span>
                      ))}
                      {(ag.tools || []).length > 5 && (
                        <span className="ar-card-tool">+{ag.tools.length - 5}</span>
                      )}
                    </div>
                    <div className="ar-card-status">
                      <span className="ar-card-dot" /> {(ag.protocols || []).map((p) => p.toUpperCase()).join(" · ") || "MCP"}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                      <code style={{ fontSize: "0.62rem", color: "var(--muted,#5a6373)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", flex: "1 1 auto" }}
                        title={sseUrlOf(ag)}>{sseUrlOf(ag)}</code>
                      <CopyBtn text={sseUrlOf(ag)} small />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Per-agent Usage Analytics */}
          {agentAnalytics.length > 0 && (
            <div className="ar-usage">
              <div className="ar-usage-title">Agent Usage (Last 30 Days)</div>
              <div className="ar-usage-table">
                <div className="ar-usage-head">
                  <span>Agent</span><span>Invocations</span><span>Tokens</span><span>Avg Latency</span><span>Error Rate</span><span>Last Used</span>
                </div>
                {agentAnalytics.slice(0, 10).map((a) => (
                  <div className="ar-usage-row" key={a.agent_id || a.agent_name}>
                    <span className="ar-usage-name">{a.agent_name || a.agent_id}</span>
                    <span>{a.invocation_count}</span>
                    <span>{a.total_tokens != null ? formatTokens(a.total_tokens) : "--"}</span>
                    <span>{a.avg_duration_ms != null ? `${a.avg_duration_ms}ms` : "--"}</span>
                    <span style={{ color: a.error_rate > 0 ? "var(--crit)" : "var(--ok)" }}>{a.error_rate ?? 0}%</span>
                    <span className="ar-usage-time">{a.last_used ? timeAgo(a.last_used) : "--"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Agent Detail Drawer */}
        {detailAgent && (
          <div className="agent-detail-overlay" onClick={() => setDetailAgent(null)}>
            <div className="agent-detail" onClick={(e) => e.stopPropagation()}>
              <button className="agent-detail-close" onClick={() => setDetailAgent(null)}>&times;</button>
              <div className="agent-detail-icon">{agentIcon(detailAgent.icon)}</div>
              <h3>{detailAgent.name}</h3>
              <div className="agent-detail-cat" style={{ color: detailAgent.color }}>{detailAgent.category}{detailAgent.version ? ` · v${detailAgent.version}` : ""}</div>
              <p>{detailAgent.description}</p>

              <h4>Connect — this agent is its own MCP server</h4>
              {(() => {
                const sse = sseUrlOf(detailAgent);
                const msg = detailAgent.mcpMessageUrl || sse.replace(/\/sse$/, "/message");
                const tools = detailAgent.toolsUrl || `${window.location.origin}/api/agents/${detailAgent.id}/tools`;
                const rows = [
                  { l: "SSE (connect)", u: sse },
                  { l: "Message (reply)", u: msg },
                  { l: "Tool list (REST)", u: tools },
                ];
                return (
                  <div style={{ marginBottom: 10 }}>
                    {rows.map((r) => (
                      <div key={r.l} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5, flexWrap: "wrap" }}>
                        <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--muted,#5a6373)", flex: "0 0 105px" }}>{r.l}</span>
                        <code className="agent-detail-mcp" style={{ flex: "1 1 260px", wordBreak: "break-all", margin: 0 }}>{r.u}</code>
                        <CopyBtn text={r.u} small />
                      </div>
                    ))}
                    <div style={{ fontSize: "0.68rem", color: "var(--muted,#5a6373)", marginTop: 6 }}>
                      Works with any MCP client — Claude, LangChain, Microsoft Agent Framework. Bearer token required when AUTH_MODE=token. The SSE stream must not be buffered by a proxy.
                    </div>
                  </div>
                );
              })()}

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
    </>
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
        <span style={{ fontSize: 15 }}>{"\u{1F9ED}"}</span>
        <h3>Agent Orchestration Flow</h3>
        <span className="agent-flow-legend">
          <span><span className="afl-dot" style={{ background: "#6366f1" }} /> Orchestrator</span>
          <span><span className="afl-dot" style={{ background: "#22c55e" }} /> Agent</span>
        </span>
      </div>
      <div className="agent-flow-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: width, maxHeight: height }}>
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
          <line x1={orchX} y1={topY + 24} x2={orchX} y2={orchY} stroke="#64748b" strokeWidth="1.4" />
          <g>
            <rect x={orchX - 55} y={topY} width="110" height="26" rx="13" fill="#1e293b" stroke="#334155" />
            <text x={orchX} y={topY + 17} textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="600">{"\u{1F464} User Query"}</text>
          </g>
          <g>
            <rect x={orchX - 130} y={orchY} width="260" height="44" rx="10" fill="url(#orchGrad2)" stroke="#6366f1" />
            <text x={orchX} y={orchY + 20} textAnchor="middle" fill="#fff" fontSize="12.5" fontWeight="800">{"\u{1F9E0} AI Orchestrator"}</text>
            <text x={orchX} y={orchY + 35} textAnchor="middle" fill="#c7d2fe" fontSize="9">LLM Router · Intent Classification</text>
          </g>
          <defs>
            <linearGradient id="orchGrad2" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#312e81" /><stop offset="100%" stopColor="#4338ca" />
            </linearGradient>
          </defs>
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
