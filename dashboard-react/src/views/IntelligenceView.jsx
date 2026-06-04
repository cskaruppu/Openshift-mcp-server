import { useState, useCallback, useMemo } from "react";
import { useClusterQuery } from "../hooks/useClusterQuery";
import { useActiveCluster } from "../store/clusterStore";
import { showToast } from "../store/toastStore";
import { clusterUrl } from "../api/client";

const SEV = { critical: "#ef4444", warning: "#f59e0b", info: "#3b82f6" };

function sevBucket(s) {
  if (!s) return "info";
  const l = typeof s === "string" ? s.toLowerCase() : "";
  if (/crit/.test(l) || (typeof s === "number" && s >= 80)) return "critical";
  if (/warn|high/.test(l) || (typeof s === "number" && s >= 50)) return "warning";
  return "info";
}

function sevLabel(s) {
  if (typeof s === "number") {
    if (s >= 80) return "CRITICAL";
    if (s >= 50) return "WARNING";
    return "INFO";
  }
  return (s || "info").toUpperCase();
}

function timeAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 0) return "just now";
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function IntelligenceView() {
  const cluster = useActiveCluster();

  const { data: intelData, isLoading: intelLoading, isError: intelError, error: intelErr, refetch: refetchIntel } =
    useClusterQuery("/api/intelligence/dashboard", { refetchInterval: 30_000 });

  const { data: alertsData, refetch: refetchAlerts } =
    useClusterQuery("/api/alerts", { refetchInterval: 20_000 });

  const [sevFilter, setSevFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [clusterFilter, setClusterFilter] = useState("all");
  const [nsFilter, setNsFilter] = useState("all");
  const [tab, setTab] = useState("insights");
  const [expandedCards, setExpandedCards] = useState({});
  const [analyzing, setAnalyzing] = useState({});
  const [analyses, setAnalyses] = useState({});
  const [dismissing, setDismissing] = useState({});

  const insights = intelData?.insights || [];
  const predictions = intelData?.predictions || [];
  const kb = intelData?.knowledgeBase || {};
  const rulesCount = intelData?.automationRules ?? 0;
  const monitoring = intelData?.monitoring ?? false;
  const proactive = intelData?.proactive || {};

  const alerts = useMemo(() => {
    if (!alertsData?.alerts) return [];
    return alertsData.alerts.filter((a) => !a.silenced);
  }, [alertsData]);

  const alertSummary = alertsData?.summary || { critical: 0, warning: 0, info: 0 };

  const allItems = useMemo(() => {
    const items = [];
    for (const ins of insights) {
      items.push({
        id: ins.id || `ins-${items.length}`,
        kind: "insight",
        title: ins.title || ins.type || "Insight",
        severity: ins.severity,
        sevBucket: sevBucket(ins.severity),
        message: ins.message || ins.description || ins.detail || "",
        namespace: ins.namespace,
        resource: ins.resource,
        source: ins.source || "proactive",
        cluster: ins.cluster,
        timestamp: ins.timestamp,
        recommendation: ins.recommendation,
        count: ins.count,
        rootCause: ins.rootCause,
        impact: ins.impact,
        fixCommand: ins.fixCommand,
        fixAvailable: ins.fixAvailable,
        raw: ins,
      });
    }
    for (const a of alerts) {
      const dup = items.find(
        (i) => i.resource === a.resource && i.namespace === a.namespace && i.title === a.name
      );
      if (dup) continue;
      items.push({
        id: `alert-${items.length}`,
        kind: "alert",
        title: a.name,
        severity: a.severity,
        sevBucket: sevBucket(a.severity),
        message: a.summary || "",
        namespace: a.namespace,
        resource: a.resource,
        source: a.source || "alertmanager",
        cluster: null,
        timestamp: a.since,
        count: a.count,
        raw: a,
      });
    }
    items.sort((a, b) => {
      const order = { critical: 0, warning: 1, info: 2 };
      const sa = order[a.sevBucket] ?? 2;
      const sb = order[b.sevBucket] ?? 2;
      if (sa !== sb) return sa - sb;
      return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
    });
    return items;
  }, [insights, alerts]);

  const sevCounts = useMemo(() => {
    const c = { all: allItems.length, critical: 0, warning: 0, info: 0 };
    for (const i of allItems) c[i.sevBucket]++;
    return c;
  }, [allItems]);

  const uniqueClusters = useMemo(() => [...new Set(allItems.map((i) => i.cluster).filter(Boolean))].sort(), [allItems]);
  const uniqueNs = useMemo(() => [...new Set(allItems.map((i) => i.namespace).filter(Boolean))].sort(), [allItems]);

  const filtered = useMemo(() => {
    let list = allItems;
    if (tab === "insights") list = list.filter((i) => i.kind === "insight");
    if (tab === "alerts") list = list.filter((i) => i.kind === "alert");
    if (sevFilter !== "all") list = list.filter((i) => i.sevBucket === sevFilter);
    if (clusterFilter !== "all") list = list.filter((i) => i.cluster === clusterFilter);
    if (nsFilter !== "all") list = list.filter((i) => i.namespace === nsFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((i) =>
        [i.title, i.message, i.namespace, i.resource, i.source, i.cluster].filter(Boolean).join(" ").toLowerCase().includes(q)
      );
    }
    return list;
  }, [allItems, tab, sevFilter, clusterFilter, nsFilter, search]);

  const toggleCard = useCallback((id) => setExpandedCards((p) => ({ ...p, [id]: !p[id] })), []);

  const handleRefresh = useCallback(() => {
    refetchIntel();
    refetchAlerts();
    showToast("Refreshing intelligence data…", "ok");
  }, [refetchIntel, refetchAlerts]);

  const handleAnalyze = useCallback(async (item) => {
    if (item.kind !== "insight") return;
    setAnalyzing((p) => ({ ...p, [item.id]: true }));
    try {
      const res = await fetch(clusterUrl("/api/intelligence/insights/analyze", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.raw.id }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setAnalyses((p) => ({ ...p, [item.id]: json.analysis }));
      showToast("AI analysis complete", "ok");
    } catch (err) {
      showToast("Analysis failed: " + err.message, "err");
    } finally {
      setAnalyzing((p) => ({ ...p, [item.id]: false }));
    }
  }, [cluster]);

  const handleDismiss = useCallback(async (item) => {
    if (item.kind !== "insight") return;
    setDismissing((p) => ({ ...p, [item.id]: true }));
    try {
      await fetch(clusterUrl("/api/intelligence/insights/dismiss", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.raw.id }),
      });
      refetchIntel();
      showToast("Insight dismissed", "ok");
    } catch (err) {
      showToast("Dismiss failed: " + err.message, "err");
    } finally {
      setDismissing((p) => ({ ...p, [item.id]: false }));
    }
  }, [cluster, refetchIntel]);

  const handleRunPredictions = useCallback(async () => {
    try {
      showToast("Running predictive analysis…", "ok");
      await fetch(clusterUrl("/api/intelligence/predictions/run", cluster), { method: "POST" });
      refetchIntel();
      showToast("Predictions updated", "ok");
    } catch (err) {
      showToast("Prediction run failed: " + err.message, "err");
    }
  }, [cluster, refetchIntel]);

  if (intelLoading) {
    return (
      <div className="intel">
        <div className="intel-loading">
          <div className="intel-loading-bar"><div className="intel-loading-fill" /></div>
          <span>Loading intelligence data…</span>
        </div>
      </div>
    );
  }

  if (intelError) {
    return (
      <div className="intel">
        <div className="intel-err-panel">
          <div className="intel-err-title">Failed to load intelligence data</div>
          <div className="intel-err-msg">{String(intelErr?.message || intelErr)}</div>
          <button className="intel-err-retry" onClick={() => refetchIntel()}>Retry</button>
        </div>
      </div>
    );
  }

  const totalActive = allItems.length;
  const predCount = predictions.length;
  const kbTotal = kb.totalEntries ?? kb.total ?? kb.count ?? 0;

  return (
    <div className="intel">

      {/* ═══ HERO ═══ */}
      <div className="intel-hero">
        <div className="intel-hero-glow" />
        <div className="intel-hero-inner">
          <div className="intel-hero-top">
            <div className="intel-hero-title">
              <div className="intel-pulse"><span className="intel-pulse-dot" /></div>
              <div>
                <h2>AI Intelligence Command Center</h2>
                <p>
                  Real-time alerts, proactive monitoring, predictions &amp; automation
                  {cluster !== "local" && <span className="intel-cluster-badge">{cluster}</span>}
                </p>
              </div>
            </div>
            <div className="intel-hero-actions">
              <button className="intel-hero-btn" onClick={handleRefresh}>Refresh</button>
            </div>
          </div>

          <div className="intel-hero-stats">
            <div className="intel-stat-box" style={{ "--stat-color": "#8b5cf6" }}>
              <div className="intel-stat-val">{totalActive}</div>
              <div className="intel-stat-label">Active Alerts</div>
            </div>
            <div className="intel-stat-box" style={{ "--stat-color": "#ef4444" }}>
              <div className="intel-stat-val">{alertSummary.critical + (proactive.critical || 0)}</div>
              <div className="intel-stat-label">Critical</div>
            </div>
            <div className="intel-stat-box" style={{ "--stat-color": "#f59e0b" }}>
              <div className="intel-stat-val">{alertSummary.warning + (proactive.warning || 0)}</div>
              <div className="intel-stat-label">Warning</div>
            </div>
            <div className="intel-stat-box" style={{ "--stat-color": "#06b6d4" }}>
              <div className="intel-stat-val">{predCount}</div>
              <div className="intel-stat-label">Predictions</div>
            </div>
            <div className="intel-stat-box" style={{ "--stat-color": "#22c55e" }}>
              <div className="intel-stat-val">{kbTotal}</div>
              <div className="intel-stat-label">KB Entries</div>
            </div>
          </div>

          <div className="intel-hero-status">
            <span className={"intel-status-dot " + (monitoring ? "on" : "off")} />
            <span>Proactive monitoring: <strong>{monitoring ? "Active" : "Paused"}</strong></span>
            <span className="intel-hero-sep">&bull;</span>
            <span>{rulesCount} automation rule{rulesCount !== 1 ? "s" : ""}</span>
            <span className="intel-hero-sep">&bull;</span>
            <span>Auto-refresh 30s</span>
          </div>
        </div>
      </div>

      {/* ═══ MONITORING BANNER ═══ */}
      <div className={"intel-monitor-banner " + (monitoring ? "active" : "inactive")}>
        <div className="intel-monitor-info">
          <span className={"intel-monitor-dot " + (monitoring ? "on" : "off")} />
          <div>
            <div className="intel-monitor-title">Proactive Monitoring: {monitoring ? "ON" : "OFF"}</div>
            <div className="intel-monitor-sub">
              {proactive.status || (monitoring ? "Background scanning every 60s" : "Enable monitoring for proactive alerts")}
              {proactive.countdown && <> &middot; {proactive.countdown}</>}
            </div>
          </div>
        </div>
      </div>

      {/* ═══ TABS + FILTERS ═══ */}
      <div className="intel-section">
        <div className="intel-section-head">
          <div className="intel-section-title">
            <div className="intel-section-icon sev-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            </div>
            <div>
              <h3>Real-Time Intelligence</h3>
              <p>Live alerts &amp; AI-investigated findings across your cluster</p>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="intel-tabs">
          {[
            { key: "all", label: "All", count: allItems.length },
            { key: "insights", label: "AI Insights", count: insights.length },
            { key: "alerts", label: "Cluster Alerts", count: alerts.length },
          ].map((t) => (
            <button key={t.key} className={"intel-tab" + (tab === t.key ? " active" : "")} onClick={() => setTab(t.key)}>
              {t.label}
              <span className="intel-tab-count">{t.count}</span>
            </button>
          ))}
        </div>

        {/* Severity pills */}
        <div className="intel-filter-row">
          <div className="intel-sev-pills">
            {[
              { key: "all", label: "All", color: null },
              { key: "critical", label: "Critical", color: SEV.critical },
              { key: "warning", label: "Warning", color: SEV.warning },
              { key: "info", label: "Info", color: SEV.info },
            ].map((p) => (
              <button
                key={p.key}
                className={"intel-sev-pill" + (sevFilter === p.key ? " active" : "")}
                style={sevFilter === p.key && p.color ? { background: p.color, borderColor: p.color, color: "#fff" } : {}}
                onClick={() => setSevFilter(p.key)}
              >
                {p.label}
                <span className="intel-sev-count">{sevCounts[p.key] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="intel-search-row">
            <input
              className="intel-search"
              type="text"
              placeholder="Search alerts, namespaces, resources…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {uniqueClusters.length > 0 && (
              <select className="intel-filter-select" value={clusterFilter} onChange={(e) => setClusterFilter(e.target.value)}>
                <option value="all">All Clusters</option>
                {uniqueClusters.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            {uniqueNs.length > 0 && (
              <select className="intel-filter-select" value={nsFilter} onChange={(e) => setNsFilter(e.target.value)}>
                <option value="all">All Namespaces</option>
                {uniqueNs.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}
          </div>
        </div>

        {/* Cards */}
        <div className="intel-card-list">
          {filtered.length === 0 && (
            <div className="intel-empty">
              {allItems.length === 0
                ? "No active alerts or insights — your cluster is healthy"
                : "No items match the current filters"}
            </div>
          )}
          {filtered.map((item) => {
            const sc = SEV[item.sevBucket] || SEV.info;
            const isExpanded = !!expandedCards[item.id];
            const aiResult = analyses[item.id];
            const isAnalyzing = analyzing[item.id];
            const isDismissing = dismissing[item.id];

            return (
              <div key={item.id} className={"intel-card" + (isExpanded ? " expanded" : "")} style={{ "--card-sev": sc }}>
                <div className="intel-card-head" onClick={() => toggleCard(item.id)}>
                  <span className="intel-card-sev-bar" />
                  <div className="intel-card-body">
                    <div className="intel-card-row1">
                      <span className="intel-card-title">{item.title}</span>
                      <span className={"intel-card-sev-badge " + item.sevBucket}>{sevLabel(item.severity)}</span>
                      <span className={"intel-card-kind-badge " + item.kind}>{item.kind === "insight" ? "AI Insight" : "Alert"}</span>
                      {item.source && <span className="intel-card-source">{item.source}</span>}
                      {item.cluster && <span className="intel-card-cluster">{item.cluster}</span>}
                    </div>
                    {item.message && <div className="intel-card-msg">{item.message}</div>}
                    <div className="intel-card-meta">
                      {item.namespace && <span>NS: {item.namespace}</span>}
                      {item.resource && <span>Res: {item.resource}</span>}
                      {item.count > 1 && <span>{item.count}x</span>}
                      {item.timestamp && <span>{timeAgo(item.timestamp)}</span>}
                    </div>
                  </div>
                  <div className="intel-card-actions">
                    {item.kind === "insight" && (
                      <>
                        <button
                          className="intel-card-btn primary"
                          onClick={(e) => { e.stopPropagation(); handleAnalyze(item); }}
                          disabled={isAnalyzing}
                        >
                          {isAnalyzing ? "Analyzing…" : "Investigate"}
                        </button>
                        <button
                          className="intel-card-btn"
                          onClick={(e) => { e.stopPropagation(); handleDismiss(item); }}
                          disabled={isDismissing}
                        >
                          {isDismissing ? "…" : "Dismiss"}
                        </button>
                      </>
                    )}
                    {(item.fixAvailable || item.fixCommand) && (
                      <button className="intel-card-btn success">Auto-fix</button>
                    )}
                    <span className="intel-card-chevron">{isExpanded ? "▲" : "▼"}</span>
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="intel-card-detail">
                    {item.recommendation && (
                      <div className="intel-detail-block recommendation">
                        <span className="intel-detail-lbl">Recommendation</span>
                        <p>{item.recommendation}</p>
                      </div>
                    )}
                    {item.rootCause && (
                      <div className="intel-detail-block">
                        <span className="intel-detail-lbl">Root Cause</span>
                        <p>{item.rootCause}</p>
                      </div>
                    )}
                    {item.impact && (
                      <div className="intel-detail-block">
                        <span className="intel-detail-lbl">Impact</span>
                        <p>{item.impact}</p>
                      </div>
                    )}
                    {item.fixCommand && (
                      <div className="intel-fix-cmd">
                        <code>{item.fixCommand}</code>
                        <button onClick={() => { navigator.clipboard.writeText(item.fixCommand); showToast("Copied", "ok"); }}>Copy</button>
                      </div>
                    )}
                    {/* AI Analysis result */}
                    {aiResult && (
                      <div className="intel-ai-panel">
                        <div className="intel-ai-header">
                          <span className="intel-ai-spark">AI</span>
                          AI Deep Analysis
                        </div>
                        <div className="intel-ai-text">{aiResult}</div>
                      </div>
                    )}
                    {!aiResult && item.kind === "insight" && (
                      <button
                        className="intel-card-btn primary"
                        onClick={() => handleAnalyze(item)}
                        disabled={isAnalyzing}
                        style={{ marginTop: 8 }}
                      >
                        {isAnalyzing ? "Running AI analysis…" : "Run AI Deep Analysis"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══ PREDICTIVE INTELLIGENCE ═══ */}
      <div className="intel-section">
        <div className="intel-section-head">
          <div className="intel-section-title">
            <div className="intel-section-icon pred-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            </div>
            <div>
              <h3>Predictive Intelligence</h3>
              <p>Forecasted issues based on trend analysis &amp; historical data</p>
            </div>
          </div>
          <button className="intel-hero-btn" onClick={handleRunPredictions}>Run Predictions</button>
        </div>

        <div className="intel-pred-list">
          {predictions.length === 0 && (
            <div className="intel-empty">No predictions — trends are stable</div>
          )}
          {predictions.map((p, i) => {
            const score = p.score ?? p.riskScore ?? null;
            const confidence = p.confidence ?? null;
            const sc = SEV[sevBucket(p.severity || p.risk)] || "#8b5cf6";
            return (
              <div key={p.id || `pred-${i}`} className="intel-pred-card" style={{ "--pred-color": sc }}>
                <div className="intel-pred-score-ring">
                  {score != null ? (
                    <span className="intel-pred-score" style={{ background: sc + "22", color: sc }}>{score}</span>
                  ) : (
                    <span className="intel-pred-score" style={{ background: "rgba(139,92,246,0.12)", color: "#8b5cf6" }}>?</span>
                  )}
                </div>
                <div className="intel-pred-body">
                  <div className="intel-pred-title">{p.target || p.resource || p.title || "Prediction"}</div>
                  <div className="intel-pred-detail">{p.reason || p.message || p.prediction || ""}</div>
                  <div className="intel-pred-tags">
                    {score != null && <span className="intel-pred-tag" style={{ color: sc }}>Risk: {score}</span>}
                    {confidence != null && (
                      <span className="intel-pred-tag conf">
                        Confidence: {typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : confidence}
                      </span>
                    )}
                    {p.hoursRemaining != null && (
                      <span className="intel-pred-tag eta">ETA: {p.hoursRemaining}h</span>
                    )}
                    {p.severity && (
                      <span className={"intel-card-sev-badge " + sevBucket(p.severity)}>{(p.severity || "").toUpperCase()}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══ KNOWLEDGE BASE & AUTOMATION ═══ */}
      <div className="intel-bottom-row">
        <div className="intel-section intel-kb-panel">
          <div className="intel-section-head">
            <div className="intel-section-title">
              <div className="intel-section-icon kb-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              </div>
              <div>
                <h3>Knowledge Base</h3>
                <p>Learned resolutions from past incidents</p>
              </div>
            </div>
          </div>
          <div className="intel-kb-stats">
            <div className="intel-kb-stat">
              <div className="intel-kb-stat-val">{kbTotal}</div>
              <div className="intel-kb-stat-lbl">Total Entries</div>
            </div>
            <div className="intel-kb-stat">
              <div className="intel-kb-stat-val">{kb.avgEffectiveness ?? 0}</div>
              <div className="intel-kb-stat-lbl">Avg Effectiveness</div>
            </div>
            <div className="intel-kb-stat">
              <div className="intel-kb-stat-val">{Object.keys(kb.byType || {}).length}</div>
              <div className="intel-kb-stat-lbl">Issue Types</div>
            </div>
          </div>
          {kb.byType && Object.keys(kb.byType).length > 0 && (
            <div className="intel-kb-types">
              {Object.entries(kb.byType).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([type, count]) => (
                <span key={type} className="intel-kb-type-pill">
                  {type} <strong>{count}</strong>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="intel-section intel-auto-panel">
          <div className="intel-section-head">
            <div className="intel-section-title">
              <div className="intel-section-icon auto-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
              </div>
              <div>
                <h3>Automation</h3>
                <p>Rules for automatic remediation</p>
              </div>
            </div>
          </div>
          <div className="intel-auto-stats">
            <div className="intel-auto-stat">
              <div className="intel-auto-stat-val">{rulesCount}</div>
              <div className="intel-auto-stat-lbl">Active Rules</div>
            </div>
            <div className="intel-auto-stat">
              <div className="intel-auto-stat-val" style={{ color: monitoring ? "#22c55e" : "#ef4444" }}>
                {monitoring ? "ON" : "OFF"}
              </div>
              <div className="intel-auto-stat-lbl">Monitor Status</div>
            </div>
          </div>
          <div className="intel-auto-info">
            Automation evaluates active insights against configured rules and applies safe remediation actions automatically.
          </div>
        </div>
      </div>
    </div>
  );
}
