import { useState, useCallback, useMemo } from "react";
import { useClusterQuery } from "../hooks/useClusterQuery";
import { useActiveCluster } from "../store/clusterStore";

/* ─────────────────────────────────────────────
   AI Intelligence Command Center
   Full-featured view matching legacy dashboard
   ───────────────────────────────────────────── */

/* ── Inline styles (CSS-in-JS, matches legacy class names) ────────── */

const S = {
  /* Hero */
  hero: {
    position: "relative",
    background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)",
    border: "1px solid #334155",
    borderRadius: 16,
    padding: "22px 26px",
    marginBottom: 18,
    overflow: "hidden",
  },
  heroGlow: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(circle at 30% 50%, #6366f120 0%, transparent 60%), radial-gradient(circle at 80% 30%, #ef444415 0%, transparent 60%)",
    pointerEvents: "none",
    animation: "aicGlow 8s ease infinite alternate",
  },
  heroInner: { position: "relative", zIndex: 1 },
  heroTitle: { display: "flex", alignItems: "center", gap: 14, marginBottom: 18 },
  pulse: {
    width: 42,
    height: 42,
    borderRadius: 12,
    background: "linear-gradient(135deg, #ef4444, #6366f1)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    animation: "aicPulse 2s infinite",
  },
  pulseDot: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: "#fff",
    boxShadow: "0 0 8px #fff",
  },
  heroName: {
    fontSize: 22,
    fontWeight: 800,
    color: "#f8fafc",
    letterSpacing: "-0.5px",
  },
  heroSub: { fontSize: 12, color: "#94a3b8", marginTop: 2 },
  heroStats: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: 10,
    marginBottom: 14,
  },
  heroStatBox: (color) => ({
    background: "#1e293b80",
    border: "1px solid #334155",
    borderLeft: `3px solid ${color}`,
    borderRadius: 10,
    padding: "12px 14px",
    backdropFilter: "blur(10px)",
  }),
  heroStatVal: (color) => ({
    fontSize: 24,
    fontWeight: 800,
    color,
    lineHeight: 1,
  }),
  heroStatLabel: {
    fontSize: 10,
    color: "#64748b",
    marginTop: 4,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    fontWeight: 600,
  },
  heroStatus: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 12,
    color: "#94a3b8",
    flexWrap: "wrap",
  },
  heroSep: { color: "#475569" },
  heroBtn: {
    background: "#1e293b",
    border: "1px solid #334155",
    color: "#cbd5e1",
    borderRadius: 6,
    padding: "5px 12px",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
  },

  /* Section container */
  section: {
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "18px 20px",
    marginBottom: 16,
  },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  sectionIcon: (bg) => ({
    width: 34,
    height: 34,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 16,
    color: "#fff",
    flexShrink: 0,
    background: bg,
  }),
  sectionName: { fontSize: 15, fontWeight: 700, color: "var(--text)" },
  sectionSub: { fontSize: 11, color: "var(--text2)", marginTop: 1 },

  /* Severity filter pills */
  pillsRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 14,
    flexWrap: "wrap",
  },
  pill: (active, color) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: active ? (color || "var(--accent)") : "var(--bg)",
    border: `1px solid ${active ? (color || "var(--accent)") : "var(--border)"}`,
    borderRadius: 999,
    padding: "6px 14px",
    color: active ? "#fff" : "var(--text)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    transition: "all .15s",
  }),
  pillBadge: (active) => ({
    background: active ? "rgba(255,255,255,0.2)" : "var(--border)",
    color: active ? "#fff" : "var(--text2)",
    padding: "1px 7px",
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 700,
  }),

  /* Search & filter bar */
  searchWrap: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginLeft: "auto",
    flexWrap: "wrap",
  },
  searchInput: {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "6px 10px",
    color: "var(--text)",
    fontSize: 12,
    outline: "none",
    minWidth: 200,
  },
  filterSelect: {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "6px 10px",
    color: "var(--text)",
    fontSize: 12,
    outline: "none",
  },
  toggleLabel: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    color: "var(--text2)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  /* Insight cards */
  cardList: { display: "flex", flexDirection: "column", gap: 10 },
  card: (sevColor) => ({
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderLeft: `4px solid ${sevColor}`,
    borderRadius: 10,
    overflow: "hidden",
    transition: "all .15s",
  }),
  cardHead: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    padding: "12px 16px",
    cursor: "pointer",
  },
  cardBody: { flex: 1, minWidth: 0 },
  cardRow1: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    marginBottom: 4,
  },
  cardName: { fontSize: 13, fontWeight: 700, color: "var(--text)" },
  badge: (bg, color) => ({
    fontSize: 9,
    fontWeight: 700,
    padding: "2px 7px",
    borderRadius: 4,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    background: bg,
    color,
  }),
  cardSummary: {
    fontSize: 12,
    color: "var(--text2)",
    marginTop: 6,
    lineHeight: 1.5,
  },
  cardMeta: {
    fontSize: 11,
    color: "var(--text2)",
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
  },
  metaItem: { display: "inline-flex", alignItems: "center", gap: 4 },
  cardActions: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  actionBtn: (variant) => {
    const base = {
      background: "transparent",
      border: "1px solid var(--border)",
      color: "var(--text2)",
      borderRadius: 6,
      padding: "5px 10px",
      cursor: "pointer",
      fontSize: 11,
      fontWeight: 600,
      whiteSpace: "nowrap",
    };
    if (variant === "primary")
      return { ...base, background: "var(--accent2)", color: "#fff", borderColor: "var(--accent2)" };
    if (variant === "success")
      return { ...base, color: "#22c55e", borderColor: "rgba(34,197,94,0.27)" };
    if (variant === "danger")
      return { ...base, color: "#ef4444" };
    return base;
  },

  /* AI analysis expandable */
  aiPanel: {
    borderTop: "1px solid var(--border)",
    background: "linear-gradient(180deg, rgba(99,102,241,0.03), transparent)",
    padding: "14px 16px",
  },
  aiHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
    fontSize: 11,
    color: "var(--text2)",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  aiSpark: {
    width: 18,
    height: 18,
    borderRadius: 4,
    background: "linear-gradient(135deg, #6366f1, #a855f7)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: 11,
    fontWeight: 700,
  },
  aiGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginBottom: 8,
  },
  aiBlock: {
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "10px 12px",
  },
  aiLabel: {
    fontSize: 10,
    color: "var(--text2)",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginBottom: 4,
  },
  aiText: {
    fontSize: 12,
    color: "var(--text)",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
  fixCmd: {
    background: "var(--card-deep, #0d1117)",
    border: "1px solid var(--border2, #30363d)",
    borderRadius: 6,
    padding: "8px 12px",
    fontFamily: "'SF Mono', 'Cascadia Code', monospace",
    fontSize: 11,
    color: "var(--ok, #22c55e)",
    marginTop: 8,
    display: "flex",
    alignItems: "center",
    gap: 8,
    overflowX: "auto",
  },
  fixCmdCode: { flex: 1, whiteSpace: "pre", fontFamily: "inherit", color: "inherit" },
  fixCmdBtn: {
    background: "#1f6feb",
    border: "none",
    color: "#fff",
    borderRadius: 4,
    padding: "3px 10px",
    cursor: "pointer",
    fontSize: 10,
    fontWeight: 600,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },

  /* Prediction cards */
  predCard: {
    display: "flex",
    gap: 10,
    padding: 10,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    alignItems: "flex-start",
  },
  predIcon: { fontSize: 20, flexShrink: 0 },
  predBody: { flex: 1, minWidth: 0 },
  predTitle: { fontSize: 12, fontWeight: 700, color: "var(--text)" },
  predDetail: { fontSize: 11, color: "var(--text2)", marginTop: 3, lineHeight: 1.5 },
  predConf: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 10,
    background: "var(--card)",
    padding: "2px 8px",
    borderRadius: 999,
    marginTop: 6,
  },

  /* Monitoring banner */
  monitorBanner: (active) => ({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: active
      ? "linear-gradient(135deg, rgba(34,197,94,0.08), rgba(16,185,129,0.05))"
      : "linear-gradient(135deg, rgba(239,68,68,0.06), rgba(239,68,68,0.03))",
    border: `1px solid ${active ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`,
    borderRadius: 12,
    padding: "14px 20px",
    marginBottom: 16,
  }),
  monitorDot: (active) => ({
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: active ? "#22c55e" : "#ef4444",
    display: "inline-block",
    marginRight: 8,
    boxShadow: active ? "0 0 6px #22c55e" : "0 0 6px #ef4444",
  }),
  toggleSwitch: {
    position: "relative",
    width: 42,
    height: 22,
    borderRadius: 11,
    cursor: "pointer",
    border: "none",
    transition: "background .2s",
    flexShrink: 0,
  },
  toggleKnob: (active) => ({
    position: "absolute",
    top: 2,
    left: active ? 22 : 2,
    width: 18,
    height: 18,
    borderRadius: "50%",
    background: "#fff",
    transition: "left .2s",
    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
  }),

  /* Empty state */
  empty: {
    textAlign: "center",
    padding: "40px 20px",
    color: "var(--text2)",
    fontSize: 13,
  },

  /* Loading */
  loadingBar: {
    height: 3,
    borderRadius: 2,
    background: "var(--border)",
    overflow: "hidden",
    position: "relative",
    width: 180,
    margin: "40px auto",
  },
  loadingFill: {
    position: "absolute",
    inset: 0,
    width: "40%",
    background: "var(--accent)",
    borderRadius: 2,
    animation: "loadSlide 1s ease infinite",
  },
};

/* ── Keyframe injection ────────────────────── */
const KEYFRAMES_ID = "__intel-keyframes";
if (typeof document !== "undefined" && !document.getElementById(KEYFRAMES_ID)) {
  const style = document.createElement("style");
  style.id = KEYFRAMES_ID;
  style.textContent = `
    @keyframes aicPulse {
      0%   { box-shadow: 0 0 0 0 rgba(99,102,241,0.5); }
      70%  { box-shadow: 0 0 0 16px rgba(99,102,241,0); }
      100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); }
    }
    @keyframes aicGlow {
      0%   { opacity: .5; }
      100% { opacity: 1;  }
    }
  `;
  document.head.appendChild(style);
}

/* ── Helpers ───────────────────────────────── */

const SEV_COLORS = {
  critical: "#ef4444",
  warning: "#f59e0b",
  info: "#3b82f6",
};

function sevColor(s) {
  if (!s) return "#8b5cf6";
  const l = s.toLowerCase();
  if (/crit/.test(l)) return SEV_COLORS.critical;
  if (/warn|high/.test(l)) return SEV_COLORS.warning;
  if (/info|low/.test(l)) return SEV_COLORS.info;
  return "#8b5cf6";
}

function sevClass(s) {
  if (!s) return "info";
  const l = s.toLowerCase();
  if (/crit/.test(l)) return "critical";
  if (/warn|high/.test(l)) return "warning";
  return "info";
}

function sevBadgeBg(s) {
  const c = sevColor(s);
  return c + "22";
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return "just now";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/* ── Sub-components ────────────────────────── */

function HeroStatBox({ label, value, color }) {
  return (
    <div style={S.heroStatBox(color)}>
      <div style={S.heroStatVal(color)}>{value}</div>
      <div style={S.heroStatLabel}>{label}</div>
    </div>
  );
}

function SeverityPills({ counts, active, onChange }) {
  const pills = [
    { key: "all", label: "All", color: null },
    { key: "critical", label: "Critical", color: SEV_COLORS.critical },
    { key: "warning", label: "Warning", color: SEV_COLORS.warning },
    { key: "info", label: "Info", color: SEV_COLORS.info },
  ];
  return (
    <div style={S.pillsRow}>
      {pills.map((p) => (
        <button
          key={p.key}
          style={S.pill(active === p.key, p.color)}
          onClick={() => onChange(p.key)}
        >
          <span>{p.label}</span>
          <span style={S.pillBadge(active === p.key)}>
            {counts[p.key] ?? 0}
          </span>
        </button>
      ))}
    </div>
  );
}

function SearchFilterBar({ search, onSearch, clusters, namespaces, clusterFilter, nsFilter, onClusterFilter, onNsFilter, grouped, onGroupToggle }) {
  return (
    <div style={S.searchWrap}>
      <input
        type="text"
        style={S.searchInput}
        placeholder="Search alerts, namespaces, resources..."
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <select style={S.filterSelect} value={clusterFilter} onChange={(e) => onClusterFilter(e.target.value)} title="Filter by cluster">
        <option value="all">All Clusters</option>
        {clusters.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <select style={S.filterSelect} value={nsFilter} onChange={(e) => onNsFilter(e.target.value)} title="Filter by namespace">
        <option value="all">All Namespaces</option>
        {namespaces.map((ns) => (
          <option key={ns} value={ns}>{ns}</option>
        ))}
      </select>
      <label style={S.toggleLabel}>
        <input type="checkbox" checked={grouped} onChange={(e) => onGroupToggle(e.target.checked)} />
        Group similar
      </label>
    </div>
  );
}

function InsightCard({ insight, expanded, onToggle }) {
  const sc = sevColor(insight.severity);
  const summary = insight.message || insight.description || insight.summary || "";
  const hasAI = insight.rootCause || insight.impact || insight.fixCommand || insight.fixAvailable;

  return (
    <div style={S.card(sc)}>
      {/* Card head */}
      <div style={S.cardHead} onClick={onToggle}>
        <div style={S.cardBody}>
          <div style={S.cardRow1}>
            <span style={S.cardName}>{insight.title || insight.type || "Insight"}</span>
            <span style={S.badge(sevBadgeBg(insight.severity), sc)}>
              {(insight.severity || "info").toUpperCase()}
            </span>
            {insight.source && (
              <span style={S.badge("var(--border)", "var(--text2)")}>
                {insight.source}
              </span>
            )}
            {insight.cluster && (
              <span style={S.badge("rgba(99,102,241,0.13)", "#a5b4fc")}>
                {insight.cluster}
              </span>
            )}
          </div>
          {summary && <div style={S.cardSummary}>{summary}</div>}
          <div style={S.cardMeta}>
            {insight.namespace && <span style={S.metaItem}>NS: {insight.namespace}</span>}
            {insight.resource && <span style={S.metaItem}>Res: {insight.resource}</span>}
            {insight.timestamp && <span style={S.metaItem}>{timeAgo(insight.timestamp)}</span>}
          </div>
        </div>
        <div style={S.cardActions}>
          <button style={S.actionBtn("primary")} onClick={(e) => { e.stopPropagation(); }}>
            Investigate
          </button>
          <button style={S.actionBtn()} onClick={(e) => { e.stopPropagation(); }}>
            Dismiss
          </button>
          {(insight.fixAvailable || insight.fixCommand) && (
            <button style={S.actionBtn("success")} onClick={(e) => { e.stopPropagation(); }}>
              Auto-fix
            </button>
          )}
        </div>
      </div>

      {/* Expandable AI analysis */}
      {expanded && hasAI && (
        <div style={S.aiPanel}>
          <div style={S.aiHead}>
            <span style={S.aiSpark}>AI</span>
            AI Analysis
          </div>
          <div style={S.aiGrid}>
            {insight.rootCause && (
              <div style={S.aiBlock}>
                <div style={S.aiLabel}>Root Cause</div>
                <div style={S.aiText}>{insight.rootCause}</div>
              </div>
            )}
            {insight.impact && (
              <div style={S.aiBlock}>
                <div style={S.aiLabel}>Impact</div>
                <div style={S.aiText}>{insight.impact}</div>
              </div>
            )}
          </div>
          {insight.fixCommand && (
            <div style={S.fixCmd}>
              <code style={S.fixCmdCode}>{insight.fixCommand}</code>
              <button style={S.fixCmdBtn}>Copy</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PredictionCard({ prediction }) {
  const score = prediction.score ?? prediction.riskScore ?? null;
  const confidence = prediction.confidence ?? null;
  const sc = sevColor(prediction.severity || prediction.risk);

  return (
    <div style={S.predCard}>
      <div style={{ ...S.predIcon, color: sc }}>
        {score != null ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 36,
              height: 36,
              borderRadius: 8,
              background: sc + "22",
              color: sc,
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            {score}
          </span>
        ) : (
          "\u{1F52E}"
        )}
      </div>
      <div style={S.predBody}>
        <div style={S.predTitle}>
          {prediction.target || prediction.resource || prediction.title || "Prediction"}
        </div>
        <div style={S.predDetail}>
          {prediction.reason || prediction.message || prediction.prediction || ""}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
          {score != null && (
            <span style={{ ...S.predConf, color: sc }}>
              Risk Score: {score}
            </span>
          )}
          {confidence != null && (
            <span style={{ ...S.predConf, color: "#a5b4fc" }}>
              Confidence: {typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : confidence}
            </span>
          )}
          {prediction.severity && (
            <span style={S.badge(sevBadgeBg(prediction.severity), sevColor(prediction.severity))}>
              {prediction.severity.toUpperCase()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function MonitoringBanner({ active, proactive }) {
  const status = proactive?.status || (active ? "Active" : "Inactive");
  const countdown = proactive?.countdown || null;
  const investigating = proactive?.investigating || null;

  return (
    <div style={S.monitorBanner(active)}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={S.monitorDot(active)} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            Proactive Monitoring: {active ? "ON" : "OFF"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>
            {status}
            {countdown && <> &middot; {countdown}</>}
            {investigating && <> &middot; Investigating: {investigating}</>}
          </div>
        </div>
      </div>
      <button
        style={{
          ...S.toggleSwitch,
          background: active ? "#22c55e" : "#4b5563",
        }}
        title={active ? "Disable proactive monitoring" : "Enable proactive monitoring"}
        aria-label="Toggle proactive monitoring"
      >
        <span style={S.toggleKnob(active)} />
      </button>
    </div>
  );
}

/* ── Main View ─────────────────────────────── */

export function IntelligenceView() {
  const cluster = useActiveCluster();
  const { data, isLoading, isError, error, refetch } = useClusterQuery(
    "/api/intelligence/dashboard",
    { refetchInterval: 30_000 },
  );

  /* State */
  const [sevFilter, setSevFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [clusterFilter, setClusterFilter] = useState("all");
  const [nsFilter, setNsFilter] = useState("all");
  const [grouped, setGrouped] = useState(false);
  const [expandedCards, setExpandedCards] = useState({});

  /* Data slices */
  const insights = data?.insights || [];
  const predictions = data?.predictions || [];
  const kb = data?.knowledgeBase || {};
  const rules = data?.automationRules ?? 0;
  const monitoring = data?.monitoring ?? false;
  const proactive = data?.proactive || {};

  /* Derived counts */
  const sevCounts = useMemo(() => {
    const c = { all: insights.length, critical: 0, warning: 0, info: 0 };
    for (const ins of insights) {
      const sc = sevClass(ins.severity);
      if (sc === "critical") c.critical++;
      else if (sc === "warning") c.warning++;
      else c.info++;
    }
    return c;
  }, [insights]);

  /* Unique clusters & namespaces for filter dropdowns */
  const uniqueClusters = useMemo(() => {
    const s = new Set();
    for (const ins of insights) if (ins.cluster) s.add(ins.cluster);
    return [...s].sort();
  }, [insights]);

  const uniqueNamespaces = useMemo(() => {
    const s = new Set();
    for (const ins of insights) if (ins.namespace) s.add(ins.namespace);
    return [...s].sort();
  }, [insights]);

  /* Filtered insights */
  const filteredInsights = useMemo(() => {
    let list = insights;
    if (sevFilter !== "all") {
      list = list.filter((i) => sevClass(i.severity) === sevFilter);
    }
    if (clusterFilter !== "all") {
      list = list.filter((i) => i.cluster === clusterFilter);
    }
    if (nsFilter !== "all") {
      list = list.filter((i) => i.namespace === nsFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((i) => {
        const hay = [i.title, i.type, i.message, i.description, i.summary, i.namespace, i.resource, i.source, i.cluster]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }, [insights, sevFilter, clusterFilter, nsFilter, search]);

  /* Toggle expand */
  const toggleCard = useCallback((id) => {
    setExpandedCards((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  /* ── Render ───────────────────────────────── */

  if (isLoading) {
    return (
      <div className="view-pane" style={{ padding: 24 }}>
        <div style={S.loadingBar}>
          <div style={S.loadingFill} />
        </div>
        <div style={{ textAlign: "center", color: "var(--text2)", fontSize: 13 }}>
          Loading intelligence data...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="view-pane" style={{ padding: 24 }}>
        <div style={{ ...S.section, borderColor: "rgba(239,68,68,0.3)" }}>
          <div style={{ color: "var(--crit)", fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            Failed to load intelligence data
          </div>
          <div style={{ color: "var(--text2)", fontSize: 12 }}>
            {String(error?.message || error)}
          </div>
          <button style={{ ...S.heroBtn, marginTop: 12 }} onClick={() => refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view-pane" style={{ padding: 24 }}>

      {/* ═══ 1. COMMAND CENTER HERO ═══ */}
      <div style={S.hero}>
        <div style={S.heroGlow} />
        <div style={S.heroInner}>
          {/* Title row */}
          <div style={S.heroTitle}>
            <div style={S.pulse}>
              <span style={S.pulseDot} />
            </div>
            <div>
              <div style={S.heroName}>AI Intelligence Command Center</div>
              <div style={S.heroSub}>
                Proactive monitoring, predictions &amp; automation
                {cluster !== "local" && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: "#0f172a",
                      background: "#38bdf8",
                      borderRadius: 5,
                      padding: "2px 7px",
                      verticalAlign: "middle",
                      marginLeft: 8,
                    }}
                  >
                    {cluster}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Stat boxes */}
          <div style={S.heroStats}>
            <HeroStatBox label="Active Insights" value={insights.length} color="#8b5cf6" />
            <HeroStatBox label="Predictions" value={predictions.length} color="#f59e0b" />
            <HeroStatBox label="KB Entries" value={kb.total ?? kb.count ?? 0} color="#06b6d4" />
            <HeroStatBox label="Automation Rules" value={rules} color="#22c55e" />
            <HeroStatBox
              label="Monitoring"
              value={monitoring ? "ON" : "OFF"}
              color={monitoring ? "#22c55e" : "#64748b"}
            />
          </div>

          {/* Status bar */}
          <div style={S.heroStatus}>
            <span>{proactive?.status || (monitoring ? "Proactive monitoring active" : "Monitoring paused")}</span>
            <span style={S.heroSep}>&bull;</span>
            <span>{proactive?.countdown || "Auto-refresh in 30s"}</span>
            <span style={S.heroSep}>&bull;</span>
            <button style={S.heroBtn} onClick={() => refetch()}>
              &#x21BB; Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ═══ 2. PROACTIVE MONITORING BANNER ═══ */}
      <MonitoringBanner active={monitoring} proactive={proactive} />

      {/* ═══ 3. PROACTIVE INSIGHTS SECTION ═══ */}
      <div style={S.section}>
        <div style={S.sectionHead}>
          <div style={S.sectionTitle}>
            <span style={S.sectionIcon("linear-gradient(135deg, #6366f1, #a855f7)")}>
              &#x1F50D;
            </span>
            <div>
              <div style={S.sectionName}>Proactive Insights</div>
              <div style={S.sectionSub}>
                AI-investigated findings across your cluster
              </div>
            </div>
          </div>
        </div>

        {/* Severity pills + search */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <SeverityPills counts={sevCounts} active={sevFilter} onChange={setSevFilter} />
          <SearchFilterBar
            search={search}
            onSearch={setSearch}
            clusters={uniqueClusters}
            namespaces={uniqueNamespaces}
            clusterFilter={clusterFilter}
            nsFilter={nsFilter}
            onClusterFilter={setClusterFilter}
            onNsFilter={setNsFilter}
            grouped={grouped}
            onGroupToggle={setGrouped}
          />
        </div>

        {/* Insight cards */}
        <div style={S.cardList}>
          {filteredInsights.length === 0 && (
            <div style={S.empty}>
              {insights.length === 0
                ? "No active insights for this cluster"
                : "No insights match the current filters"}
            </div>
          )}
          {filteredInsights.map((ins, i) => {
            const key = ins.id || `insight-${i}`;
            return (
              <InsightCard
                key={key}
                insight={ins}
                expanded={!!expandedCards[key]}
                onToggle={() => toggleCard(key)}
              />
            );
          })}
        </div>
      </div>

      {/* ═══ 4. PREDICTIVE ANALYSIS SECTION ═══ */}
      <div style={S.section}>
        <div style={S.sectionHead}>
          <div style={S.sectionTitle}>
            <span style={S.sectionIcon("linear-gradient(135deg, #6366f1, #a855f7)")}>
              &#x1F52E;
            </span>
            <div>
              <div style={S.sectionName}>Predictive Intelligence</div>
              <div style={S.sectionSub}>
                Forecasted issues based on trend analysis
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {predictions.length === 0 && (
            <div style={S.empty}>No predictions for this cluster</div>
          )}
          {predictions.map((p, i) => (
            <PredictionCard key={p.id || `pred-${i}`} prediction={p} />
          ))}
        </div>
      </div>
    </div>
  );
}
