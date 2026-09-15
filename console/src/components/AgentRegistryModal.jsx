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

/* Posture rendering. Four states, and "unreviewed" sits between good and bad
   rather than being folded into either — it means nobody has looked, which is
   where every agent starts and is not the same as being fine. */
const VERDICT = {
  "action-required": { label: "action required", bg: "var(--st-crit-bg)", fg: "var(--st-crit-ink)", icon: "✖" },
  attention:         { label: "attention",       bg: "var(--st-warn-bg)", fg: "var(--st-warn-ink)", icon: "⚠" },
  unreviewed:        { label: "unreviewed",      bg: "var(--st-unknown-bg)", fg: "var(--st-unknown-ink)", icon: "?" },
  governed:          { label: "governed",        bg: "var(--st-good-bg)", fg: "var(--st-good-ink)", icon: "✓" },
};
/* Blast radius is a permanent property of the agent, so it gets a stripe.
   Pills in this console mean state that changes. */
const RADIUS_COLOR = { "read-only": "var(--st-unknown)", mutating: "var(--st-warn)", irreversible: "var(--st-crit)" };

/** An undeclared field reads as undeclared, never as blank. */
function Undeclared({ what = "not declared" }) {
  return <span style={{ color: "var(--st-unknown-ink)", fontStyle: "italic", fontSize: "0.72rem" }}>{what}</span>;
}

const nf = new Intl.NumberFormat();

/**
 * The governance lens — the same agents, asked what they are permitted to do.
 *
 * Sorted by posture and not by spend: the first row is the agent behaving
 * outside its declaration, because a governance panel that leads with cost gets
 * read by finance and ignored by security.
 */
function GovernanceLens({ data }) {
  if (!data) return <div className="ar-gov-loading">Reading agent posture…</div>;

  const agents = Array.isArray(data.agents) ? data.agents : [];
  const fleet = data.fleet || {};
  const ORDER = { "action-required": 0, attention: 1, unreviewed: 2, governed: 3 };
  const rows = agents.slice().sort((a, b) =>
    (ORDER[a.verdict] ?? 9) - (ORDER[b.verdict] ?? 9)
    || (b.usage?.totalTokens || 0) - (a.usage?.totalTokens || 0)
    || (a.name || "").localeCompare(b.name || ""));

  const stat = (n, label, sub, alert) => (
    <div className={"ar-stat" + (alert ? " ar-stat-alert" : "")} key={label}>
      <div className="ar-stat-num">{n}</div>
      <div className="ar-stat-label">{label}</div>
      {sub && <div className="ar-gov-substat">{sub}</div>}
    </div>
  );

  return (
    <>
      <div className="ar-stats-row">
        {stat(fleet.agents ?? "--", "Agents", fleet.external ? `${fleet.external} external` : "all first-party")}
        {stat(fleet.certified ?? "--", "Certified", fleet.expiringSoon ? `${fleet.expiringSoon} expiring` : null)}
        {stat(fleet.irreversible ?? "--", "Irreversible", "require approval")}
        {stat(fleet.unowned ?? "--", "Unowned", "nobody accountable", (fleet.unowned || 0) > 0)}
        {stat(fleet.needsAttention ?? "--", "Needs attention", null, (fleet.needsAttention || 0) > 0)}
      </div>

      {/* The worst true thing, in one sentence, before any table. */}
      {fleet.headline && (
        <div className={"ar-gov-headline" + (fleet.byVerdict?.["action-required"] ? " crit" : "")}>
          {fleet.headline}
        </div>
      )}

      {data.usageNote && <div className="ar-gov-note">{data.usageNote}</div>}

      <div className="ar-gov-scroll">
        <table className="ar-gov-table">
          <thead>
            <tr>
              <th>Agent</th><th>Owner</th><th>Trust</th><th>Blast radius</th><th>Autonomy</th>
              <th className="ar-num">Tokens 30d</th><th>Certified</th><th>Posture</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const v = VERDICT[a.verdict] || VERDICT.unreviewed;
              const cert = a.certification || {};
              return (
                <tr key={a.id} className={a.verdict === "action-required" ? "ar-gov-flag" : a.verdict === "attention" ? "ar-gov-watch" : undefined}>
                  <td>
                    <div className="ar-gov-name">{a.name}</div>
                    <div className="ar-gov-id">{a.id} · {a.toolCount} tool{a.toolCount === 1 ? "" : "s"}</div>
                    {a.category && <div className="ar-gov-cat">{a.category}</div>}
                  </td>
                  <td>{a.owner || <Undeclared what="no owner" />}</td>
                  <td>{a.trustTier
                    ? <span className={"ar-gov-pill " + (a.trustTier === "external" ? "crit" : "good")}>{a.trustTier}</span>
                    : <Undeclared />}</td>
                  <td>{a.blastRadius
                    ? <span className="ar-gov-radius"><i style={{ background: RADIUS_COLOR[a.blastRadius] }} />{a.blastRadius}</span>
                    : <Undeclared />}</td>
                  <td>{a.autonomy
                    ? <span className="ar-gov-pill acc">{a.autonomy.replace(/-/g, " ")}</span>
                    : <Undeclared />}</td>
                  <td className="ar-num">
                    {a.usage?.attributed
                      ? nf.format(a.usage.totalTokens || 0)
                      : <Undeclared what="not attributed" />}
                  </td>
                  <td>{cert.state === "never" ? <Undeclared what="never" />
                    : cert.state === "expired" ? <span className="ar-gov-pill crit">expired</span>
                    : cert.state === "expiring" ? <span className="ar-gov-pill warn">{cert.expiresInDays}d left</span>
                    : cert.state === "no-expiry" ? <span className="ar-gov-pill warn">no expiry</span>
                    : new Date(cert.certifiedAt).toLocaleDateString()}</td>
                  <td>
                    <span className="ar-gov-pill" style={{ background: v.bg, color: v.fg }}>{v.icon} {v.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* The first row of every table needs a reason, and for most of these it
          is the same one: nobody has declared anything yet. Saying what to do
          about it beats leaving a screen of grey question marks. */}
      {fleet.byVerdict?.unreviewed > 0 && (
        <div className="ar-gov-note">
          An agent is <b>unreviewed</b> until its manifest declares an owner, a trust tier, a blast radius and
          an autonomy level. Add a <code>governance</code> block to the manifest in
          <code> src/agents/manifests/</code> to move it out of this state — nothing here infers those
          answers, because guessing who is accountable for an agent is worse than admitting nobody is.
        </div>
      )}
    </>
  );
}

export function AgentRegistryModal({ open, onClose }) {
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [detailAgent, setDetailAgent] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [lens, setLens] = useState("catalog");
  /* Zoom scales the modal body only. Sixteen agents across five categories do
     not fit a laptop viewport at full size, and the fix people reach for is
     the browser's own zoom, which shrinks the whole console including the
     chrome they navigate by. This shrinks the content and leaves the header,
     the lens and the close button at full size. */
  const [zoom, setZoom] = useState(1);

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

  /* Posture reads telemetry, so it is only fetched when the lens asks for it —
     the catalog stays as cheap as it is today. */
  const { data: govData } = useQuery({
    queryKey: ["/api/agents/governance"],
    queryFn: ({ signal }) => apiGet("/api/agents/governance?days=30", { signal }).catch(() => ({})),
    staleTime: 60_000,
    enabled: open && lens === "governance",
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

          {/* One object, two audiences. Integrators want endpoints and tools;
              owners, security and audit want permission and behaviour. Two
              separate screens would mean each half goes stale for the people
              who never open it. */}
          <div className="ar-lens" role="group" aria-label="Registry view">
            <button className={"ar-lens-btn" + (lens === "catalog" ? " active" : "")}
              onClick={() => setLens("catalog")}
              title="Endpoints, protocols and tool reference — how do I call this agent">Catalog</button>
            <button className={"ar-lens-btn" + (lens === "governance" ? " active" : "")}
              onClick={() => setLens("governance")}
              title="Owner, permission, spend and behaviour — what is it allowed to do">Governance</button>
          </div>

          {/* Zoom out. Sixteen agents across five categories overflow a laptop
              viewport, and browser zoom shrinks the console chrome along with
              the content. This scales the body only. */}
          <div className="ar-zoom" role="group" aria-label="Zoom">
            <button className="ar-zoom-btn" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(2)))}
              disabled={zoom <= 0.6} title="Zoom out — fit more on screen" aria-label="Zoom out">−</button>
            <button className="ar-zoom-level" onClick={() => setZoom(1)} title="Reset to 100%">{Math.round(zoom * 100)}%</button>
            <button className="ar-zoom-btn" onClick={() => setZoom((z) => Math.min(1.2, +(z + 0.1).toFixed(2)))}
              disabled={zoom >= 1.2} title="Zoom in" aria-label="Zoom in">+</button>
          </div>

          <button className="ar-modal-close" onClick={onClose}>&times;</button>
        </div>

        {/* Body. Zoom scales content and re-widens it by the inverse, so
            shrinking the type fills the row rather than leaving a gutter. */}
        <div className="ar-modal-body"
          style={zoom === 1 ? undefined : {
            zoom,
            // `zoom` is the only property that reflows rather than merely
            // painting smaller — a transform would keep the old layout box and
            // leave the panel scrolling sideways at 70%.
          }}>
          {lens === "governance" ? (
            <GovernanceLens data={govData} />
          ) : (<>
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
                    {/* Measured, or said to be unmeasured. This used to show a
                        share of the fleet total apportioned by invocation
                        count, which bore no relation to what the agent spent —
                        an agent making a few large analysis calls read low and
                        one making many cheap lookups read high. */}
                    <span title={a.total_tokens == null ? "No model calls were recorded against this agent" : undefined}
                      style={a.total_tokens == null ? { color: "var(--st-unknown-ink)", fontStyle: "italic" } : undefined}>
                      {a.total_tokens != null ? formatTokens(a.total_tokens) : "not attributed"}
                    </span>
                    <span>{a.avg_duration_ms != null ? `${a.avg_duration_ms}ms` : "--"}</span>
                    <span style={{ color: a.error_rate > 0 ? "var(--crit)" : "var(--ok)" }}>{a.error_rate ?? 0}%</span>
                    <span className="ar-usage-time">{a.last_used ? timeAgo(a.last_used) : "--"}</span>
                  </div>
                ))}
              </div>
              {traceAnalytics?.tokensAttributed === false && (
                <div style={{ marginTop: 7, fontSize: "0.73rem", color: "var(--st-unknown-ink)" }}>
                  Per-agent token usage is not being recorded yet. Model calls carry no agent, so spend is
                  shown as unattributed rather than divided up.
                </div>
              )}
            </div>
          )}
          </>)}
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
