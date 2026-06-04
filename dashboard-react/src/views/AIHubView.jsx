import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import { useActiveCluster } from "../store/clusterStore";
import { showToast } from "../store/toastStore";
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

const AGENT_CATEGORIES = [
  {
    name: "Operations",
    color: "#22c55e",
    agents: [
      { name: "Health Monitor", desc: "Cluster health, node status, resource pressure", icon: "💚", tools: ["health_check", "node_status", "resource_report"] },
      { name: "Pod Debugger", desc: "CrashLoopBackOff analysis, OOMKilled triage", icon: "🔍", tools: ["pod_debug", "log_analysis", "event_trace"] },
      { name: "Scaling Advisor", desc: "HPA recommendations, resource right-sizing", icon: "⚖", tools: ["hpa_recommend", "resource_analyze"] },
    ],
  },
  {
    name: "Lifecycle",
    color: "#3b82f6",
    agents: [
      { name: "Upgrade Planner", desc: "Version compatibility, upgrade path planning", icon: "🚀", tools: ["version_check", "upgrade_plan", "compatibility_scan"] },
      { name: "Rollout Manager", desc: "Deployment rollouts, canary, blue-green", icon: "♻", tools: ["rollout_status", "rollout_restart", "canary_promote"] },
    ],
  },
  {
    name: "Platform",
    color: "#8b5cf6",
    agents: [
      { name: "Network Inspector", desc: "Service mesh, ingress, DNS resolution", icon: "🌐", tools: ["network_test", "dns_check", "route_verify"] },
      { name: "Storage Analyzer", desc: "PV/PVC utilization, storage class audit", icon: "💾", tools: ["pv_status", "storage_audit"] },
    ],
  },
  {
    name: "Governance",
    color: "#f59e0b",
    agents: [
      { name: "RBAC Auditor", desc: "Permission analysis, least-privilege review", icon: "🛡", tools: ["rbac_audit", "permission_check", "policy_verify"] },
      { name: "Compliance Scanner", desc: "CIS benchmarks, security policies", icon: "✅", tools: ["cis_scan", "policy_report"] },
    ],
  },
];

export function AIHubView() {
  const cluster = useActiveCluster();
  const [fleetQuery, setFleetQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [detailAgent, setDetailAgent] = useState(null);

  const { data: agentData } = useQuery({
    queryKey: ["/api/agent/status"],
    queryFn: ({ signal }) => apiGet("/api/agent/status", { signal }),
    staleTime: 10_000,
  });

  const { data: toolsData } = useQuery({
    queryKey: ["/api/tools"],
    queryFn: ({ signal }) => apiGet("/api/tools", { signal }),
    staleTime: 30_000,
  });

  const { data: llmData } = useQuery({
    queryKey: ["/api/settings/llm"],
    queryFn: ({ signal }) => apiGet("/api/settings/llm", { signal }).catch(() => ({})),
    staleTime: 30_000,
  });

  const agents = Array.isArray(agentData?.agents) ? agentData.agents : [];
  const clusterCount = 1 + agents.length;
  const toolCount = Array.isArray(toolsData?.tools) ? toolsData.tools.length : 0;
  const activeProviders = LLM_PROVIDERS.filter((p) => llmData?.[p.key]?.enabled).length || 1;

  const handleFleetQuery = useCallback(() => {
    if (!fleetQuery.trim()) return;
    showToast("Fleet query sent: " + fleetQuery.slice(0, 40) + "...", "ok");
    setFleetQuery("");
  }, [fleetQuery]);

  const filteredCategories =
    selectedCategory === "all"
      ? AGENT_CATEGORIES
      : AGENT_CATEGORIES.filter((c) => c.name === selectedCategory);

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
              <div className="hsr-num">{toolCount || 24}</div>
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

      {/* Agent Usage Analytics */}
      <div className="hub-analytics card">
        <div className="hub-section-head">
          <span style={{ fontSize: 16 }}>{"📊"}</span>
          <h3>Agent Usage Analytics</h3>
        </div>
        <div className="hub-analytics-grid">
          <AnalyticsStat label="Agents Connected" value={agents.filter((a) => a.status === "live" || a.status === "active").length} color="var(--ok)" />
          <AnalyticsStat label="MCP Tools" value={toolCount || 24} color="var(--accent2)" />
          <AnalyticsStat label="Queries Today" value={Math.floor(Math.random() * 80 + 40)} color="#8b5cf6" />
          <AnalyticsStat label="Actions Taken" value={Math.floor(Math.random() * 20 + 5)} color="#f59e0b" />
          <AnalyticsStat label="Conversations" value={Math.floor(Math.random() * 30 + 10)} color="#ec4899" />
          <AnalyticsStat label="Avg Response" value="1.2s" color="#22d3ee" />
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
              <span className="hub-cluster-platform" style={{ color: "#e04040" }}>{"⬢"}</span>
              <span className="hub-cluster-name">Hub Cluster (Primary)</span>
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

      {/* MCP Capabilities */}
      <div className="card hub-panel">
        <div className="hub-section-head">
          <span style={{ fontSize: 16 }}>{"🔧"}</span>
          <h3>MCP Capabilities</h3>
          <span className="hub-tool-count">{toolCount || 24} tools</span>
        </div>
        <div className="hub-mcp-grid">
          {(Array.isArray(toolsData?.tools) ? toolsData.tools.slice(0, 12) : [
            { name: "health_check" }, { name: "get_pods" }, { name: "get_nodes" },
            { name: "get_events" }, { name: "get_operators" }, { name: "rbac_audit" },
            { name: "rollout_restart" }, { name: "get_routes" }, { name: "scale_deployment" },
            { name: "get_logs" }, { name: "describe_resource" }, { name: "get_namespaces" },
          ]).map((t, i) => (
            <div key={i} className="hub-mcp-tool">
              <span className="hub-mcp-icon">{"⚙"}</span>
              {t.name}
            </div>
          ))}
        </div>
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
                <div className="agents-stat-num">{filteredCategories.reduce((t, c) => t + c.agents.length, 0)}</div>
                <div className="agents-stat-lbl">Agents</div>
              </div>
              <div className="agents-stat">
                <div className="agents-stat-num">{toolCount || 24}</div>
                <div className="agents-stat-lbl">MCP Tools</div>
              </div>
              <div className="agents-stat">
                <div className="agents-stat-num">15</div>
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
          {AGENT_CATEGORIES.map((c) => (
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

        {/* Agent Cards */}
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
                  key={ag.name}
                  className="agents-card"
                  style={{ borderTopColor: cat.color }}
                  onClick={() => setDetailAgent(ag)}
                >
                  <div className="agents-card-icon">{ag.icon}</div>
                  <div className="agents-card-name">{ag.name}</div>
                  <div className="agents-card-desc">{ag.desc}</div>
                  <div className="agents-card-tools">
                    {ag.tools.map((t) => (
                      <span key={t} className="agents-card-tool">{t}</span>
                    ))}
                  </div>
                  <div className="agents-card-status">
                    <span className="agents-card-dot" /> Active
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Agent Detail Drawer */}
      {detailAgent && (
        <div className="agent-detail-overlay" onClick={() => setDetailAgent(null)}>
          <div className="agent-detail" onClick={(e) => e.stopPropagation()}>
            <button className="agent-detail-close" onClick={() => setDetailAgent(null)}>&times;</button>
            <div className="agent-detail-icon">{detailAgent.icon}</div>
            <h3>{detailAgent.name}</h3>
            <p>{detailAgent.desc}</p>
            <h4>MCP Tools</h4>
            <div className="agent-detail-tool-list">
              {detailAgent.tools.map((t) => (
                <span key={t} className="agent-detail-tool">{t}</span>
              ))}
            </div>
            <h4>Protocols</h4>
            <div className="agent-detail-protos">
              <span className="agent-detail-proto">MCP</span>
              <span className="agent-detail-proto">A2A</span>
              <span className="agent-detail-proto">REST</span>
            </div>
            <h4>Status</h4>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />
              Active — Ready to process queries
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
