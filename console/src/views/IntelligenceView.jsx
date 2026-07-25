import { useState, useCallback, useMemo } from "react";
import { useClusterQuery } from "../hooks/useClusterQuery";
import { useActiveCluster } from "../store/clusterStore";
import { useChatStore } from "../store/chatStore";
import { useViewStore } from "../store/viewStore";
import { showToast } from "../store/toastStore";
import { clusterUrl } from "../api/client";
import { formatTimestamp } from "../utils/format";
import { SopRunner } from "../components/SopRunner";

const SEV = { critical: "#ef4444", warning: "#f59e0b", info: "#3b82f6" };

function sevBucket(s) {
  if (!s) return "info";
  const l = typeof s === "string" ? s.toLowerCase() : "";
  if (/crit|sev1/.test(l) || (typeof s === "number" && s >= 80)) return "critical";
  if (/warn|high|sev2/.test(l) || (typeof s === "number" && s >= 50)) return "warning";
  return "info";
}

function sevLabel(s) {
  if (typeof s === "number") return s >= 80 ? "CRITICAL" : s >= 50 ? "WARNING" : "INFO";
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

const fmt = formatTimestamp;

export function IntelligenceView() {
  const cluster = useActiveCluster();

  const { data: intelData, isLoading: intelLoading, isError: intelError, error: intelErr, refetch: refetchIntel } =
    useClusterQuery("/api/intelligence/dashboard", { refetchInterval: 30_000 });
  const { data: alertsData, refetch: refetchAlerts } =
    useClusterQuery("/api/alerts", { refetchInterval: 20_000 });
  const { data: incData, refetch: refetchInc } =
    useClusterQuery("/api/incidents?limit=50", { refetchInterval: 30_000 });
  const { data: incStats } =
    useClusterQuery("/api/incidents/stats?days=30", { refetchInterval: 60_000 });
  const { data: rulesData, refetch: refetchRules } =
    useClusterQuery("/api/intelligence/rules", { refetchInterval: 60_000 });
  const { data: kbData, refetch: refetchKB } =
    useClusterQuery("/api/intelligence/kb", { refetchInterval: 60_000 });
  const { data: playbookData } =
    useClusterQuery("/api/intelligence/playbook?limit=10&sinceDays=90", { refetchInterval: 120_000 });
  const { data: silencesData, refetch: refetchSilences } =
    useClusterQuery("/api/alerts/silences", { refetchInterval: 30_000 });
  const { data: timelineData, refetch: refetchTimeline } =
    useClusterQuery("/api/change-timeline?window=24h&limit=50", { refetchInterval: 60_000 });
  const { data: corrData, refetch: refetchCorr } =
    useClusterQuery("/api/intelligence/correlations", { refetchInterval: 30_000 });
  // Autonomous incident detection (shadow mode) — threshold breaches that WOULD
  // have opened an incident. Read-only; no tickets are raised.
  const { data: detectData, refetch: refetchDetect, isLoading: detectLoading } =
    useClusterQuery("/api/intelligence/detected-incidents", { refetchInterval: 60_000 });
  // Managed incident sessions (Phase 2) — the approval queue. Polled faster
  // because remediation/verification progresses in the background.
  const { data: sessData, refetch: refetchSessions } =
    useClusterQuery("/api/intelligence/incident-sessions", { refetchInterval: 10_000 });

  const setChatSeed = useChatStore((s) => s.setSeed);
  const setActiveView = useViewStore((s) => s.setActiveView);

  const detected = useMemo(() => (Array.isArray(detectData?.incidents) ? detectData.incidents : []), [detectData]);
  const dStats = detectData?.stats || {};
  const sessions = useMemo(() => (Array.isArray(sessData?.sessions) ? sessData.sessions : []), [sessData]);
  const awaiting = useMemo(() => sessions.filter((s) => s.state === "awaiting_approval"), [sessions]);
  const liveSessions = useMemo(() => sessions.filter((s) => s.state !== "closed"), [sessions]);
  // Signatures already under management — so a detection isn't promoted twice.
  const managedSigs = useMemo(() => new Set(liveSessions.map((s) => s.signature)), [liveSessions]);
  const [busySession, setBusySession] = useState({});

  const callSession = useCallback(async (path, body, okMsg) => {
    setBusySession((p) => ({ ...p, [path]: true }));
    try {
      const res = await fetch(clusterUrl(path, cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) showToast(d.error, "err");
      else showToast(okMsg, "ok");
      refetchSessions();
    } catch (e) {
      showToast(e.message, "err");
    } finally {
      setBusySession((p) => ({ ...p, [path]: false }));
    }
  }, [cluster, refetchSessions]);

  const promoteDetection = useCallback((inc) => {
    callSession("/api/intelligence/incident-sessions/promote", { detection: inc },
      "Incident opened — running RCA, ticket and dry-run…");
  }, [callSession]);

  // Hand a detection to the AI Chat, which runs the SAME incident_response
  // pipeline UC-01 uses — so the RCA comes back in the identical format.
  const investigateDetection = useCallback((inc) => {
    const target = inc.kind === "node"
      ? `node ${inc.node}`
      : inc.kind === "operator"
        ? `cluster operator ${inc.target}`
        : inc.kind === "pvc"
          ? `pvc ${inc.target}${inc.namespace ? ` in namespace ${inc.namespace}` : ""}`
          : `pod ${inc.affected?.[0]?.pod || inc.target}${inc.namespace ? ` in namespace ${inc.namespace}` : ""}`;
    setChatSeed(cluster, `Investigate ${target} — ${inc.signal} detected for ${inc.dwellMinutes ?? "?"}m. Generate the RCA and propose a fix.`);
    setActiveView("chat");
  }, [cluster, setChatSeed, setActiveView]);

  const [activeTab, setActiveTab] = useState("insights");
  const [sevFilter, setSevFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [clusterFilterVal, setClusterFilterVal] = useState("all");
  const [nsFilter, setNsFilter] = useState("all");
  const [insightTab, setInsightTab] = useState("all");
  const [expandedCards, setExpandedCards] = useState({});
  const [analyzing, setAnalyzing] = useState({});
  const [analyses, setAnalyses] = useState({});
  const [dismissing, setDismissing] = useState({});

  const [incStatusFilter, setIncStatusFilter] = useState("all");
  const [showDeclare, setShowDeclare] = useState(false);
  const [declareForm, setDeclareForm] = useState({ title: "", severity: "sev2", description: "", namespaces: "", services: "" });
  const [declaring, setDeclaring] = useState(false);

  const [ruleDesc, setRuleDesc] = useState("");
  const [ruleName, setRuleName] = useState("");
  const [creatingRule, setCreatingRule] = useState(false);

  const [silenceAlert, setSilenceAlert] = useState(null);
  const [silenceHours, setSilenceHours] = useState(4);
  const [corrAnalyzing, setCorrAnalyzing] = useState({});
  const [corrAnalyses, setCorrAnalyses] = useState({});

  const insights = intelData?.insights || [];
  const predictions = intelData?.predictions || [];
  const monitoring = intelData?.monitoring ?? false;
  const proactive = intelData?.proactive || {};
  const alerts = useMemo(() => (alertsData?.alerts || []).filter((a) => !a.silenced), [alertsData]);
  const alertSummary = alertsData?.summary || {};

  const allItems = useMemo(() => {
    const items = [];
    for (const ins of insights) {
      items.push({
        id: ins.id || `ins-${items.length}`, kind: "insight",
        title: ins.title || ins.type || "Insight", severity: ins.severity,
        sevBucket: sevBucket(ins.severity), message: ins.message || ins.description || ins.detail || "",
        namespace: ins.namespace, resource: ins.resource, source: ins.source || "proactive",
        cluster: ins.cluster, timestamp: ins.timestamp, recommendation: ins.recommendation,
        count: ins.count, rootCause: ins.rootCause, impact: ins.impact,
        fixCommand: ins.fixCommand, fixAvailable: ins.fixAvailable, raw: ins,
      });
    }
    for (const a of alerts) {
      if (items.find((i) => i.resource === a.resource && i.namespace === a.namespace && i.title === a.name)) continue;
      items.push({
        id: `alert-${items.length}`, kind: "alert", title: a.name,
        severity: a.severity, sevBucket: sevBucket(a.severity),
        message: a.summary || "", namespace: a.namespace, resource: a.resource,
        source: a.source || "alertmanager", cluster: null, timestamp: a.since, count: a.count, raw: a,
      });
    }
    items.sort((a, b) => {
      const order = { critical: 0, warning: 1, info: 2 };
      // Severity first, then recurrence (count), then recency — so a recurring
      // active critical outranks a stale one-off, like Datadog Watchdog.
      return (order[a.sevBucket] ?? 2) - (order[b.sevBucket] ?? 2)
        || (b.count || 1) - (a.count || 1)
        || new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
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
    if (insightTab === "insights") list = list.filter((i) => i.kind === "insight");
    if (insightTab === "alerts") list = list.filter((i) => i.kind === "alert");
    if (sevFilter !== "all") list = list.filter((i) => i.sevBucket === sevFilter);
    if (clusterFilterVal !== "all") list = list.filter((i) => i.cluster === clusterFilterVal);
    if (nsFilter !== "all") list = list.filter((i) => i.namespace === nsFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((i) => [i.title, i.message, i.namespace, i.resource, i.source, i.cluster].filter(Boolean).join(" ").toLowerCase().includes(q));
    }
    return list;
  }, [allItems, insightTab, sevFilter, clusterFilterVal, nsFilter, search]);

  const toggleCard = useCallback((id) => setExpandedCards((p) => ({ ...p, [id]: !p[id] })), []);

  const handleRefresh = useCallback(() => {
    refetchIntel(); refetchAlerts(); refetchInc(); refetchRules(); refetchKB(); refetchTimeline();
    showToast("Refreshing…", "ok");
  }, [refetchIntel, refetchAlerts, refetchInc, refetchRules, refetchKB, refetchTimeline]);

  const handleAnalyze = useCallback(async (item) => {
    if (item.kind !== "insight") return;
    setAnalyzing((p) => ({ ...p, [item.id]: true }));
    try {
      const res = await fetch(clusterUrl("/api/intelligence/insights/analyze", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.raw.id }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setAnalyses((p) => ({ ...p, [item.id]: json.analysis }));
      showToast("AI analysis complete", "ok");
    } catch (err) { showToast("Analysis failed: " + err.message, "err"); }
    finally { setAnalyzing((p) => ({ ...p, [item.id]: false })); }
  }, [cluster]);

  const handleDismiss = useCallback(async (item) => {
    if (item.kind !== "insight") return;
    setDismissing((p) => ({ ...p, [item.id]: true }));
    try {
      await fetch(clusterUrl("/api/intelligence/insights/dismiss", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.raw.id }),
      });
      refetchIntel(); showToast("Insight dismissed", "ok");
    } catch (err) { showToast("Dismiss failed: " + err.message, "err"); }
    finally { setDismissing((p) => ({ ...p, [item.id]: false })); }
  }, [cluster, refetchIntel]);

  const [fixing, setFixing] = useState({});
  const handleAutoFix = useCallback(async (item) => {
    if (!item.fixCommand) return;
    if (!window.confirm(`Queue this remediation for review?\n\n${item.fixCommand}\n\nIt will be recorded to the audit trail for ${cluster === "local" ? "the hub cluster" : cluster}.`)) return;
    setFixing((p) => ({ ...p, [item.id]: true }));
    try {
      const res = await fetch(clusterUrl("/api/intelligence/insights/fix", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.raw.id, command: item.fixCommand }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) throw new Error(json.error || `Server error ${res.status}`);
      refetchIntel();
      showToast("Remediation queued for review", "ok");
    } catch (err) { showToast("Auto-fix failed: " + err.message, "err"); }
    finally { setFixing((p) => ({ ...p, [item.id]: false })); }
  }, [cluster, refetchIntel]);

  const handleRunPredictions = useCallback(async () => {
    showToast("Running predictive analysis…", "ok");
    try {
      await fetch(clusterUrl("/api/intelligence/predictions/run", cluster), { method: "POST" });
      refetchIntel(); showToast("Predictions updated", "ok");
    } catch (err) { showToast("Failed: " + err.message, "err"); }
  }, [cluster, refetchIntel]);

  const handleSilence = useCallback(async (alertName, ns) => {
    try {
      await fetch(clusterUrl("/api/alerts/silence", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: alertName, namespace: ns || "", duration: silenceHours }),
      });
      refetchAlerts(); refetchSilences(); setSilenceAlert(null);
      showToast(`Alert silenced for ${silenceHours}h`, "ok");
    } catch (err) { showToast("Silence failed: " + err.message, "err"); }
  }, [cluster, silenceHours, refetchAlerts, refetchSilences]);

  const handleUnsilence = useCallback(async (name, ns) => {
    try {
      await fetch(clusterUrl("/api/alerts/silence", cluster), {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, namespace: ns || "" }),
      });
      refetchAlerts(); refetchSilences(); showToast("Alert unsilenced", "ok");
    } catch (err) { showToast("Unsilence failed: " + err.message, "err"); }
  }, [cluster, refetchAlerts, refetchSilences]);

  const handleDeclareIncident = useCallback(async () => {
    if (!declareForm.title.trim()) { showToast("Title required", "err"); return; }
    setDeclaring(true);
    try {
      await fetch(clusterUrl("/api/incidents", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: declareForm.title, severity: declareForm.severity,
          description: declareForm.description,
          affectedNamespaces: declareForm.namespaces.split(",").map((s) => s.trim()).filter(Boolean),
          affectedServices: declareForm.services.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      refetchInc(); setShowDeclare(false);
      setDeclareForm({ title: "", severity: "sev2", description: "", namespaces: "", services: "" });
      showToast("Incident declared", "ok");
    } catch (err) { showToast("Failed: " + err.message, "err"); }
    finally { setDeclaring(false); }
  }, [cluster, declareForm, refetchInc]);

  const handleAdvanceIncident = useCallback(async (incId, newStatus) => {
    try {
      await fetch(clusterUrl(`/api/incidents/${encodeURIComponent(incId)}`, cluster), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      refetchInc(); showToast(`Incident ${newStatus}`, "ok");
    } catch (err) { showToast("Failed: " + err.message, "err"); }
  }, [cluster, refetchInc]);

  const handleResolveIncident = useCallback(async (incId) => {
    try {
      await fetch(clusterUrl(`/api/incidents/${encodeURIComponent(incId)}/resolve`, cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "dashboard" }),
      });
      refetchInc(); showToast("Incident resolved", "ok");
    } catch (err) { showToast("Failed: " + err.message, "err"); }
  }, [cluster, refetchInc]);

  const handleCloseIncident = useCallback(async (incId) => {
    try {
      await fetch(clusterUrl(`/api/incidents/${encodeURIComponent(incId)}/close`, cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "dashboard" }),
      });
      refetchInc(); showToast("Incident closed", "ok");
    } catch (err) { showToast("Failed: " + err.message, "err"); }
  }, [cluster, refetchInc]);

  const handleCreateRule = useCallback(async () => {
    if (!ruleDesc.trim()) return;
    setCreatingRule(true);
    try {
      const res = await fetch(clusterUrl("/api/intelligence/rules", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: ruleDesc, name: ruleName || undefined }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      refetchRules(); setRuleDesc(""); setRuleName("");
      showToast("Rule created", "ok");
    } catch (err) { showToast("Failed: " + err.message, "err"); }
    finally { setCreatingRule(false); }
  }, [cluster, ruleDesc, ruleName, refetchRules]);

  const handleToggleRule = useCallback(async (id, enabled) => {
    try {
      await fetch(clusterUrl(`/api/intelligence/rules/${id}`, cluster), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      refetchRules();
    } catch (err) { showToast("Toggle failed: " + err.message, "err"); }
  }, [cluster, refetchRules]);

  const handleDeleteRule = useCallback(async (id) => {
    try {
      await fetch(clusterUrl(`/api/intelligence/rules/${id}`, cluster), { method: "DELETE" });
      refetchRules(); showToast("Rule deleted", "ok");
    } catch (err) { showToast("Delete failed: " + err.message, "err"); }
  }, [cluster, refetchRules]);

  const handleRateKB = useCallback(async (id, delta) => {
    try {
      await fetch(clusterUrl("/api/intelligence/kb/rate", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, delta }),
      });
      refetchKB();
    } catch {}
  }, [cluster, refetchKB]);

  const incidents = incData?.incidents || [];
  const filteredInc = useMemo(() => {
    if (incStatusFilter === "all") return incidents;
    if (incStatusFilter === "open") return incidents.filter((i) => !["resolved", "closed"].includes(i.status));
    return incidents.filter((i) => i.status === incStatusFilter || i.severity === incStatusFilter);
  }, [incidents, incStatusFilter]);

  const rules = rulesData?.rules || [];
  const kbEntries = kbData?.entries || [];
  const kbStats = kbData?.stats || {};
  const playbook = playbookData?.playbook || {};
  const playbookStats = playbookData?.stats || {};
  const silences = silencesData?.silences || [];
  const tlEvents = timelineData?.events || [];
  const tlStats = timelineData?.stats || {};
  const iStats = incStats || {};

  const totalActive = allItems.length;

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
                <p>Real-time alerts, proactive monitoring, incident management &amp; automation
                  {cluster !== "local" && <span className="intel-cluster-badge">{cluster}</span>}
                </p>
              </div>
            </div>
            <div className="intel-hero-actions">
              <button className="intel-hero-btn" onClick={handleRefresh}>Refresh</button>
            </div>
          </div>

          <div className="intel-hero-stats">
            <div className="intel-stat-box" style={{ "--stat-color": "#ef4444" }}>
              <div className="intel-stat-val">{sevCounts.critical}</div>
              <div className="intel-stat-label">Critical</div>
            </div>
            <div className="intel-stat-box" style={{ "--stat-color": "#f59e0b" }}>
              <div className="intel-stat-val">{sevCounts.warning}</div>
              <div className="intel-stat-label">Warning</div>
            </div>
            <div className="intel-stat-box" style={{ "--stat-color": "#8b5cf6" }}>
              <div className="intel-stat-val">{predictions.length}</div>
              <div className="intel-stat-label">Predicted</div>
            </div>
            <div className="intel-stat-box" style={{ "--stat-color": "#22c55e" }}>
              <div className="intel-stat-val">{iStats.open || 0}</div>
              <div className="intel-stat-label">Open Incidents</div>
            </div>
            <div className="intel-stat-box" style={{ "--stat-color": "#06b6d4" }}>
              <div className="intel-stat-val">{rules.length}</div>
              <div className="intel-stat-label">Auto Rules</div>
            </div>
            <div className="intel-stat-box" style={{ "--stat-color": monitoring ? "#22c55e" : "#64748b" }}>
              <div className="intel-stat-val">{monitoring ? "ON" : "OFF"}</div>
              <div className="intel-stat-label">Monitoring</div>
            </div>
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
            </div>
          </div>
        </div>
        {silences.length > 0 && (
          <span className="intel-silence-count">{silences.length} silenced alert{silences.length > 1 ? "s" : ""}</span>
        )}
      </div>

      {/* ═══ TABS ═══ */}
      <div className="intel-tabs">
        {[
          { key: "insights", label: "Insights & Alerts", count: totalActive },
          { key: "autodetect", label: awaiting.length > 0 ? `Auto-Detect · ${awaiting.length} to approve` : "Auto-Detect", count: detected.length },
          { key: "incidents", label: "Incidents", count: incidents.length },
          { key: "timeline", label: "Change Timeline", count: tlEvents.length },
          { key: "predictions", label: "Predictions", count: predictions.length },
          { key: "rules", label: "Automation Rules", count: rules.length },
          { key: "kb", label: "Knowledge Base", count: kbEntries.length },
          { key: "playbook", label: "Team Playbook" },
          { key: "correlation", label: "Cross-Cluster", count: corrData?.correlationCount || 0 },
        ].map((t) => (
          <button key={t.key} className={"intel-tab" + (activeTab === t.key ? " active" : "")} onClick={() => setActiveTab(t.key)}>
            {t.label}
            {t.count != null && <span className="intel-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* ═══ 1. INSIGHTS & ALERTS ═══ */}
      {activeTab === "insights" && (
        <div className="intel-section">
          <div className="intel-tabs" style={{ marginBottom: 12 }}>
            {[{ key: "all", label: "All", count: allItems.length }, { key: "insights", label: "AI Insights", count: insights.length }, { key: "alerts", label: "Cluster Alerts", count: alerts.length }].map((t) => (
              <button key={t.key} className={"intel-tab" + (insightTab === t.key ? " active" : "")} onClick={() => setInsightTab(t.key)}>
                {t.label}<span className="intel-tab-count">{t.count}</span>
              </button>
            ))}
          </div>
          <div className="intel-filter-row">
            <div className="intel-sev-pills">
              {[{ key: "all", label: "All" }, { key: "critical", label: "Critical", color: SEV.critical }, { key: "warning", label: "Warning", color: SEV.warning }, { key: "info", label: "Info", color: SEV.info }].map((p) => (
                <button key={p.key} className={"intel-sev-pill" + (sevFilter === p.key ? " active" : "")}
                  style={sevFilter === p.key && p.color ? { background: p.color, borderColor: p.color, color: "#fff" } : {}}
                  onClick={() => setSevFilter(p.key)}>
                  {p.label}<span className="intel-sev-count">{sevCounts[p.key] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="intel-search-row">
              <input className="intel-search" type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {uniqueNs.length > 0 && (
                <select className="intel-filter-select" value={nsFilter} onChange={(e) => setNsFilter(e.target.value)}>
                  <option value="all">All Namespaces</option>
                  {uniqueNs.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              )}
            </div>
          </div>

          <div className="intel-card-list">
            {filtered.length === 0 && <div className="intel-empty">{allItems.length === 0 ? "No active alerts — cluster healthy" : "No items match filters"}</div>}
            {filtered.map((item) => {
              const sc = SEV[item.sevBucket] || SEV.info;
              const isExp = !!expandedCards[item.id];
              return (
                <div key={item.id} className={"intel-card" + (isExp ? " expanded" : "")} style={{ "--card-sev": sc }}>
                  <div className="intel-card-head" onClick={() => toggleCard(item.id)}>
                    <div className="intel-card-body">
                      <div className="intel-card-row1">
                        <span className="intel-card-title">{item.title}</span>
                        <span className={"intel-card-sev-badge " + item.sevBucket}>{sevLabel(item.severity)}</span>
                        <span className={"intel-card-kind-badge " + item.kind}>{item.kind === "insight" ? "AI Insight" : "Alert"}</span>
                        {item.source && <span className="intel-card-source">{item.source}</span>}
                      </div>
                      {item.message && <div className="intel-card-msg">{item.message}</div>}
                      {!isExp && item.recommendation && (
                        <div className="intel-card-reco">
                          <span className="intel-card-reco-lbl">Recommended</span>
                          <span className="intel-card-reco-txt">{item.recommendation}</span>
                        </div>
                      )}
                      <div className="intel-card-meta">
                        {item.namespace && <span>NS: <code>{item.namespace}</code></span>}
                        {item.resource && <span>Res: <code>{item.resource}</code></span>}
                        {item.count > 1 && <span className="intel-card-count">{item.count}× recurring</span>}
                        {item.timestamp && <span title={formatTimestamp(item.timestamp)}>{timeAgo(item.timestamp)}</span>}
                      </div>
                    </div>
                    <div className="intel-card-actions">
                      {item.kind === "insight" && (
                        <>
                          <button className="intel-card-btn primary" onClick={(e) => { e.stopPropagation(); handleAnalyze(item); }} disabled={analyzing[item.id]}>
                            {analyzing[item.id] ? "…" : "Investigate"}
                          </button>
                          <button className="intel-card-btn" onClick={(e) => { e.stopPropagation(); handleDismiss(item); }} disabled={dismissing[item.id]}>Dismiss</button>
                        </>
                      )}
                      {item.kind === "alert" && (
                        <button className="intel-card-btn" onClick={(e) => { e.stopPropagation(); setSilenceAlert(item); }}>Silence</button>
                      )}
                      {item.fixCommand && (
                        <button className="intel-card-btn success" onClick={(e) => { e.stopPropagation(); handleAutoFix(item); }} disabled={fixing[item.id]}>
                          {fixing[item.id] ? "Fixing…" : "Auto-fix"}
                        </button>
                      )}
                      <span className="intel-card-chevron">{isExp ? "▲" : "▼"}</span>
                    </div>
                  </div>
                  {isExp && (
                    <div className="intel-card-detail">
                      {item.recommendation && <div className="intel-detail-block recommendation"><span className="intel-detail-lbl">Recommendation</span><p>{item.recommendation}</p></div>}
                      {item.rootCause && <div className="intel-detail-block"><span className="intel-detail-lbl">Root Cause</span><p>{item.rootCause}</p></div>}
                      {item.impact && <div className="intel-detail-block"><span className="intel-detail-lbl">Impact</span><p>{item.impact}</p></div>}
                      {item.fixCommand && (
                        <div className="intel-fix-cmd"><code>{item.fixCommand}</code>
                          <button onClick={() => { navigator.clipboard.writeText(item.fixCommand); showToast("Copied", "ok"); }}>Copy</button>
                        </div>
                      )}
                      {analyses[item.id] && (
                        <div className="intel-ai-panel"><div className="intel-ai-header"><span className="intel-ai-spark">AI</span>AI Deep Analysis</div><div className="intel-ai-text">{analyses[item.id]}</div></div>
                      )}
                      {!analyses[item.id] && item.kind === "insight" && (
                        <button className="intel-card-btn primary" onClick={() => handleAnalyze(item)} disabled={analyzing[item.id]} style={{ marginTop: 8 }}>
                          {analyzing[item.id] ? "Analyzing…" : "Run AI Deep Analysis"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Silence dialog */}
          {silenceAlert && (
            <div className="intel-modal-overlay" onClick={() => setSilenceAlert(null)}>
              <div className="intel-modal" onClick={(e) => e.stopPropagation()}>
                <h4>Silence Alert</h4>
                <p>Silence "{silenceAlert.title}" for:</p>
                <select className="intel-filter-select" value={silenceHours} onChange={(e) => setSilenceHours(Number(e.target.value))}>
                  {[1, 2, 4, 8, 12, 24, 48].map((h) => <option key={h} value={h}>{h} hours</option>)}
                </select>
                <div className="intel-modal-actions">
                  <button className="intel-card-btn" onClick={() => setSilenceAlert(null)}>Cancel</button>
                  <button className="intel-card-btn primary" onClick={() => handleSilence(silenceAlert.title, silenceAlert.namespace)}>Silence</button>
                </div>
              </div>
            </div>
          )}

          {/* Active silences */}
          {silences.length > 0 && (
            <div className="intel-silences">
              <h4 className="intel-sub-title">Active Silences ({silences.length})</h4>
              {silences.map((s, i) => (
                <div key={i} className="intel-silence-row">
                  <span className="intel-silence-name">{s.name}</span>
                  {s.namespace && <span className="intel-silence-ns">{s.namespace}</span>}
                  <span className="intel-silence-exp">expires {timeAgo(s.expiresAt)}</span>
                  <button className="intel-card-btn" onClick={() => handleUnsilence(s.name, s.namespace)}>Unsilence</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ 1b. AUTONOMOUS DETECTION (SHADOW MODE) ═══ */}
      {activeTab === "autodetect" && (
        <div className="intel-section">
          <div className="intel-section-head">
            <div className="intel-section-title">
              <div className="intel-section-icon" style={{ background: "linear-gradient(135deg, #0ea5e9, #6366f1)" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </div>
              <div>
                <h3>Autonomous Incident Detection</h3>
                <p>Threshold breach → correlation → incident, with no human trigger</p>
              </div>
            </div>
            <button className="intel-hero-btn" onClick={() => refetchDetect()}>Re-scan</button>
          </div>

          {/* Shadow-mode banner — the whole point of Phase 1 */}
          <div style={{
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            padding: "10px 14px", borderRadius: 10, marginBottom: 14,
            background: "rgba(14,165,233,.12)", border: "1px solid rgba(14,165,233,.4)", fontSize: 12.5,
          }}>
            <strong style={{ color: "#38bdf8" }}>SHADOW MODE</strong>
            <span style={{ opacity: .9 }}>
              {detectData?.notice || "Detections only — no tickets raised, nothing remediated."}
            </span>
            <span style={{ marginLeft: "auto", opacity: .75 }}>
              Autonomous action: <strong style={{ color: detectData?.autoActEnabled ? "#22c55e" : "#94a3b8" }}>
                {detectData?.autoActEnabled ? "ENABLED" : "OFF"}
              </strong>
            </span>
          </div>

          {detectData?.disabled && (
            <div className="intel-empty">Auto-detection is disabled. Set <code>INCIDENT_AUTO_DETECT=true</code> to enable.</div>
          )}
          {detectData?.error && <div className="intel-empty">{detectData.error}</div>}

          {/* ── APPROVAL INBOX — the single human gate ── */}
          {liveSessions.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div className="intel-section-title" style={{ marginBottom: 10 }}>
                <div>
                  <h3 style={{ fontSize: 14 }}>
                    Approval Inbox
                    {awaiting.length > 0 && (
                      <span style={{ marginLeft: 8, padding: "2px 8px", borderRadius: 999, fontSize: 11,
                        background: "rgba(245,158,11,.2)", color: "#fbbf24", border: "1px solid rgba(245,158,11,.45)" }}>
                        {awaiting.length} awaiting approval
                      </span>
                    )}
                  </h3>
                  <p style={{ fontSize: 11.5 }}>
                    RCA, ticket and dry-run are already done. Approving applies the fix, then verification and ticket closure run automatically.
                  </p>
                </div>
              </div>

              <div className="intel-card-list">
                {liveSessions.map((s) => {
                  const sc = sevBucket(s.severity);
                  const color = SEV[sc] || SEV.info;
                  const gate = s.state === "awaiting_approval";
                  const running = ["approved", "remediating", "verifying"].includes(s.state);
                  const bad = ["failed", "rolled_back", "escalated"].includes(s.state);
                  const aPath = `/api/intelligence/incident-sessions/${s.id}/approve`;
                  const rPath = `/api/intelligence/incident-sessions/${s.id}/reject`;
                  const STATE_LABEL = {
                    detected: "Detected", triaged: "RCA generated", inc_raised: "Ticket raised",
                    fix_proposed: "Fix proposed", dry_run_passed: "Dry-run passed",
                    awaiting_approval: "⏸ Awaiting your approval", approved: "Approved",
                    remediating: "⏳ Applying fix…", verifying: "⏳ Verifying…",
                    resolved: "Resolved", closed: "Closed", rejected: "Rejected",
                    escalated: "⚠ Escalated — needs a human", rolled_back: "⚠ Not verified — rolled back",
                    failed: "❌ Failed",
                  };
                  return (
                    <div key={s.id} className="intel-card"
                      style={{ "--card-sev": color, ...(gate ? { boxShadow: "0 0 0 1px rgba(245,158,11,.5)" } : {}) }}>
                      <div className="intel-card-head">
                        <div className="intel-card-body">
                          <div className="intel-card-row1">
                            <span className="intel-card-title">{s.title}</span>
                            <span className={"intel-card-sev-badge " + sc}>{s.severity}</span>
                            <span className="intel-card-kind-badge" style={{
                              background: gate ? "rgba(245,158,11,.18)" : bad ? "rgba(239,68,68,.18)" : running ? "rgba(14,165,233,.18)" : "rgba(34,197,94,.18)",
                              color: gate ? "#fbbf24" : bad ? "#fca5a5" : running ? "#38bdf8" : "#4ade80",
                            }}>{STATE_LABEL[s.state] || s.state}</span>
                            {s.incidentNumber && <span className="intel-card-source">{s.incidentNumber}</span>}
                          </div>

                          {s.rca?.rootCause && (
                            <div className="intel-card-msg"><strong>Root cause:</strong> {s.rca.rootCause}</div>
                          )}

                          {s.remediation?.command && (
                            <div className="intel-card-reco" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                              <span className="intel-card-reco-lbl">
                                Proposed fix · risk {s.remediation.risk} · {s.remediation.reversible ? "reversible" : "NOT reversible"}
                              </span>
                              <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>{s.remediation.command}</code>
                              {s.remediation.rationale && (
                                <span style={{ fontSize: 11.5, opacity: .85 }}>{s.remediation.rationale}</span>
                              )}
                            </div>
                          )}

                          {s.dryRunOutput && (
                            <div style={{ marginTop: 6, fontSize: 11, opacity: .8 }}>
                              <strong>Dry-run:</strong> {String(s.dryRunOutput).slice(0, 220)}
                            </div>
                          )}
                          {s.escalationReason && (
                            <div style={{ marginTop: 6, fontSize: 11.5, color: "#fca5a5" }}>{s.escalationReason}</div>
                          )}
                          {s.verification?.summary && (
                            <div style={{ marginTop: 6, fontSize: 11.5, color: s.verification.ok ? "#4ade80" : "#fbbf24" }}>
                              <strong>Verification:</strong> {s.verification.summary}
                            </div>
                          )}

                          <div className="intel-card-meta">
                            {s.namespace && <span>ns: {s.namespace}</span>}
                            {s.target && <span>target: {s.target}</span>}
                            <span>opened {timeAgo(s.detectedAt)}</span>
                            {s.approvedBy && <span>approved by {s.approvedBy}</span>}
                            {s.state === "closed" && <span style={{ color: s.ticketClosed ? "#4ade80" : "#94a3b8" }}>
                              {s.ticketClosed ? "ticket closed with RCA" : "ticket left open"}
                            </span>}
                          </div>
                        </div>

                        <div className="intel-card-actions" style={{ gap: 6 }}>
                          {gate && (
                            <>
                              <button className="intel-card-btn success" disabled={!!busySession[aPath]}
                                onClick={() => callSession(aPath, { actor: "operator" }, "Approved — applying fix, then verifying and closing")}>
                                {busySession[aPath] ? "…" : "Approve & Fix"}
                              </button>
                              <button className="intel-card-btn" disabled={!!busySession[rPath]}
                                onClick={() => callSession(rPath, { actor: "operator", reason: "Rejected from Approval Inbox" }, "Rejected — incident left for manual handling")}>
                                Reject
                              </button>
                            </>
                          )}
                          <a className="intel-card-btn" href={clusterUrl(`/api/intelligence/incident-sessions/${s.id}/rca`, cluster)}
                            target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                            View RCA
                          </a>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Detection KPIs — the numbers that justify threshold tuning */}
          <div className="intel-inc-stats">
            <div className="intel-inc-stat" style={{ "--is-c": "#0ea5e9" }}><span>{dStats.incidents ?? 0}</span><label>Incidents</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#8b5cf6" }}><span>{dStats.symptoms ?? 0}</span><label>Raw Symptoms</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#22c55e" }}><span>{dStats.correlationSavings ?? 0}</span><label>Tickets Avoided</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#f59e0b" }}><span>{dStats.wouldRaiseTickets ?? 0}</span><label>Would Ticket</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#64748b" }}><span>{dStats.suppressedDuplicates ?? 0}</span><label>Suppressed</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#ef4444" }}><span>{dStats.recurring ?? 0}</span><label>Recurring</label></div>
          </div>

          <div className="intel-card-list">
            {detectLoading && detected.length === 0 && <div className="intel-empty">Evaluating thresholds…</div>}
            {!detectLoading && detected.length === 0 && !detectData?.disabled && (
              <div className="intel-empty">No threshold breaches sustained past their dwell time. Nothing would have been ticketed.</div>
            )}
            {detected.map((inc) => {
              const sc = sevBucket(inc.severity);
              const color = SEV[sc] || SEV.info;
              return (
                <div key={inc.signature} className="intel-card" style={{ "--card-sev": color }}>
                  <div className="intel-card-head">
                    <div className="intel-card-body">
                      <div className="intel-card-row1">
                        <span className="intel-card-title">{inc.title}</span>
                        <span className={"intel-card-sev-badge " + sc}>{inc.severity}</span>
                        {inc.correlation !== "single" && (
                          <span className="intel-card-kind-badge" style={{ background: "rgba(34,197,94,.18)", color: "#4ade80" }}>
                            {inc.correlation === "node-cascade" ? "node cascade" : "grouped"} · {inc.symptomCount} symptoms
                          </span>
                        )}
                        {inc.recurring && <span className="intel-card-count">{inc.occurrences}× recurring</span>}
                      </div>

                      <div className="intel-card-msg">
                        Fired <strong>{inc.rule}</strong>
                        {inc.dwellMinutes != null && <> after <strong>{inc.dwellMinutes}m</strong> (threshold {inc.threshold?.dwellMinutes ?? 0}m)</>}
                        {inc.thresholdStandard && <> · standard: <code>{inc.thresholdStandard}</code></>}
                      </div>

                      {inc.rootHint && (
                        <div className="intel-card-reco">
                          <span className="intel-card-reco-lbl">Correlation</span>
                          <span className="intel-card-reco-txt">{inc.rootHint}</span>
                        </div>
                      )}

                      {inc.evidence?.length > 0 && (
                        <div style={{ marginTop: 6, fontSize: 11.5, opacity: .85, display: "flex", flexDirection: "column", gap: 2 }}>
                          {inc.evidence.slice(0, 3).map((e, i) => <div key={i}>• {e}</div>)}
                          {inc.evidence.length > 3 && <div style={{ opacity: .7 }}>+{inc.evidence.length - 3} more</div>}
                        </div>
                      )}

                      <div className="intel-card-meta">
                        {inc.namespace && <span>ns: {inc.namespace}</span>}
                        {inc.node && <span>node: {inc.node}</span>}
                        <span>first seen {timeAgo(inc.firstSeen)}</span>
                        <span style={{ color: inc.wouldRaiseTicket ? "#f59e0b" : "#64748b" }}>
                          {inc.wouldRaiseTicket ? "would raise ServiceNow INC" : "below ticket threshold"}
                        </span>
                        {inc.wouldBeAutoRemediable && <span style={{ color: "#4ade80" }}>auto-remediable (with approval)</span>}
                      </div>
                    </div>
                    <div className="intel-card-actions" style={{ gap: 6 }}>
                      {managedSigs.has(inc.signature) ? (
                        <span style={{ fontSize: 11, color: "#4ade80" }}>in Approval Inbox ↑</span>
                      ) : (
                        <button
                          className="intel-card-btn success"
                          disabled={!!busySession["/api/intelligence/incident-sessions/promote"]}
                          title="Run RCA, raise the ServiceNow incident, propose a fix and dry-run it — then wait for your approval"
                          onClick={() => promoteDetection(inc)}
                        >
                          Open Incident →
                        </button>
                      )}
                      <button className="intel-card-btn" onClick={() => investigateDetection(inc)}>
                        Ask AI
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Active threshold policy — tuning transparency */}
          {detectData?.thresholds && (
            <div style={{ marginTop: 18 }}>
              <div className="intel-section-title" style={{ marginBottom: 8 }}>
                <div><h3 style={{ fontSize: 14 }}>Active Threshold Policy</h3>
                  <p style={{ fontSize: 11.5 }}>Defaults follow the kubernetes-mixin / kube-prometheus standards. Override with <code>INCIDENT_THRESHOLDS</code>.</p></div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 8 }}>
                {Object.entries(detectData.thresholds).map(([k, v]) => (
                  <div key={k} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 11.5 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <strong>{k}</strong>
                      <span style={{ color: v.enabled ? "#4ade80" : "#64748b" }}>{v.enabled ? "on" : "off"}</span>
                    </div>
                    <div style={{ opacity: .8, marginTop: 3 }}>
                      {v.dwellMinutes != null && <>dwell {v.dwellMinutes}m · </>}
                      {v.minRestarts != null && <>restarts ≥{v.minRestarts} · </>}
                      {v.freePctBelow != null && <>free &lt;{v.freePctBelow}% · </>}
                      {v.severity}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ 2. INCIDENT LIFECYCLE ═══ */}
      {activeTab === "incidents" && (
        <div className="intel-section">
          <div className="intel-section-head">
            <div className="intel-section-title">
              <div className="intel-section-icon" style={{ background: "linear-gradient(135deg, #ef4444, #f97316)" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              </div>
              <div><h3>Incident Lifecycle Manager</h3><p>Declared → Triaging → Investigating → Mitigating → Resolved → Closed</p></div>
            </div>
            <button className="intel-hero-btn" style={{ background: "rgba(239,68,68,.15)", borderColor: "rgba(239,68,68,.4)", color: "#fca5a5" }} onClick={() => setShowDeclare(true)}>Declare Incident</button>
          </div>

          {/* Incident stats */}
          <div className="intel-inc-stats">
            <div className="intel-inc-stat" style={{ "--is-c": "#8b5cf6" }}><span>{iStats.total || 0}</span><label>Total</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#ef4444" }}><span>{iStats.open || 0}</span><label>Open</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#f59e0b" }}><span>{iStats.incidentsThisWeek || 0}</span><label>This Week</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#22c55e" }}><span>{iStats.avgMTTR != null ? `${Math.round(iStats.avgMTTR)}m` : "—"}</span><label>Avg MTTR</label></div>
          </div>

          {/* Status filter */}
          <div className="intel-sev-pills" style={{ marginBottom: 12 }}>
            {["all", "open", "declared", "investigating", "mitigating", "resolved", "closed"].map((s) => (
              <button key={s} className={"intel-sev-pill" + (incStatusFilter === s ? " active" : "")} onClick={() => setIncStatusFilter(s)}>
                {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>

          {/* Incidents list */}
          <div className="intel-card-list">
            {filteredInc.length === 0 && <div className="intel-empty">No incidents</div>}
            {filteredInc.map((inc) => {
              const sc = sevBucket(inc.severity);
              const color = SEV[sc] || SEV.info;
              const STATUS_NEXT = { declared: "investigating", investigating: "mitigating", mitigating: null };
              const next = STATUS_NEXT[inc.status];
              return (
                <div key={inc.incident_id || inc.id} className="intel-card" style={{ "--card-sev": color }}>
                  <div className="intel-card-head">
                    <div className="intel-card-body">
                      <div className="intel-card-row1">
                        <span className="intel-card-title">{inc.incident_id || inc.id}: {inc.title}</span>
                        <span className={"intel-card-sev-badge " + sc}>{(inc.severity || "sev3").toUpperCase()}</span>
                        <span className="intel-card-source">{inc.status}</span>
                      </div>
                      {inc.description && <div className="intel-card-msg">{inc.description}</div>}
                      <div className="intel-card-meta">
                        {inc.assignee && <span>Assignee: {inc.assignee}</span>}
                        <span>Created {timeAgo(inc.created_at)}</span>
                        {inc.affected_namespaces?.length > 0 && <span>NS: {inc.affected_namespaces.join(", ")}</span>}
                      </div>
                    </div>
                    <div className="intel-card-actions">
                      {next && <button className="intel-card-btn primary" onClick={() => handleAdvanceIncident(inc.incident_id, next)}>→ {next}</button>}
                      {inc.status === "mitigating" && <button className="intel-card-btn success" onClick={() => handleResolveIncident(inc.incident_id)}>Resolve</button>}
                      {inc.status === "resolved" && <button className="intel-card-btn" onClick={() => handleCloseIncident(inc.incident_id)}>Close</button>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Declare dialog */}
          {showDeclare && (
            <div className="intel-modal-overlay" onClick={() => setShowDeclare(false)}>
              <div className="intel-modal wide" onClick={(e) => e.stopPropagation()}>
                <h4>Declare Incident</h4>
                <label className="intel-modal-lbl">Title *</label>
                <input className="intel-modal-input" value={declareForm.title} onChange={(e) => setDeclareForm((f) => ({ ...f, title: e.target.value }))} placeholder="Brief incident title" />
                <label className="intel-modal-lbl">Severity</label>
                <select className="intel-filter-select" value={declareForm.severity} onChange={(e) => setDeclareForm((f) => ({ ...f, severity: e.target.value }))}>
                  {["sev1", "sev2", "sev3", "sev4"].map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
                </select>
                <label className="intel-modal-lbl">Description</label>
                <textarea className="intel-modal-textarea" value={declareForm.description} onChange={(e) => setDeclareForm((f) => ({ ...f, description: e.target.value }))} rows={3} />
                <label className="intel-modal-lbl">Affected Namespaces (comma-separated)</label>
                <input className="intel-modal-input" value={declareForm.namespaces} onChange={(e) => setDeclareForm((f) => ({ ...f, namespaces: e.target.value }))} />
                <label className="intel-modal-lbl">Affected Services (comma-separated)</label>
                <input className="intel-modal-input" value={declareForm.services} onChange={(e) => setDeclareForm((f) => ({ ...f, services: e.target.value }))} />
                <div className="intel-modal-actions">
                  <button className="intel-card-btn" onClick={() => setShowDeclare(false)}>Cancel</button>
                  <button className="intel-card-btn primary" onClick={handleDeclareIncident} disabled={declaring}>{declaring ? "Declaring…" : "Declare"}</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ 3. CHANGE TIMELINE ═══ */}
      {activeTab === "timeline" && (
        <div className="intel-section">
          <div className="intel-section-head">
            <div className="intel-section-title">
              <div className="intel-section-icon" style={{ background: "linear-gradient(135deg, #06b6d4, #3b82f6)" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <div><h3>Change Timeline</h3><p>Correlate deployments, configs, scaling &amp; alerts</p></div>
            </div>
            <button className="intel-hero-btn" onClick={() => refetchTimeline()}>Refresh</button>
          </div>

          <div className="intel-tl-list">
            {tlEvents.length === 0 && <div className="intel-empty">No changes in the last 24 hours</div>}
            {tlEvents.slice(0, 60).map((ev, i) => {
              const ec = ev.severity === "critical" ? "#ef4444" : ev.severity === "warning" ? "#f59e0b" : ev.source === "deployment" ? "#3b82f6" : ev.source === "configmap" ? "#8b5cf6" : "#06b6d4";
              return (
                <div key={i} className="intel-tl-entry" style={{ "--tl-c": ec }}>
                  <div className="intel-tl-dot" />
                  <div className="intel-tl-content">
                    <div className="intel-tl-row1">
                      <span className="intel-tl-source">{ev.source || ev.type || "event"}</span>
                      {ev.severity && <span className={"intel-card-sev-badge " + sevBucket(ev.severity)}>{ev.severity}</span>}
                      <span className="intel-tl-time intel-ts">{fmt(ev.timestamp || ev.time)}</span>
                    </div>
                    <div className="intel-tl-msg">{ev.message || ev.description || ev.summary || "—"}</div>
                    {(ev.namespace || ev.resource) && (
                      <div className="intel-card-meta">
                        {ev.namespace && <span>NS: {ev.namespace}</span>}
                        {ev.resource && <span>Res: {ev.resource}</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ 4. PREDICTIONS ═══ */}
      {activeTab === "predictions" && (
        <div className="intel-section">
          <div className="intel-section-head">
            <div className="intel-section-title">
              <div className="intel-section-icon pred-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              </div>
              <div><h3>Predictive Intelligence</h3><p>Forecasted issues based on trend analysis &amp; historical data</p></div>
            </div>
            <button className="intel-hero-btn" onClick={handleRunPredictions}>Run Predictions</button>
          </div>

          <div className="intel-pred-list">
            {predictions.length === 0 && <div className="intel-empty">No predictions — trends are stable</div>}
            {predictions.map((p, i) => {
              const score = p.score ?? p.riskScore ?? null;
              const confidence = p.confidence ?? null;
              const sc = SEV[sevBucket(p.severity || p.risk)] || "#8b5cf6";
              return (
                <div key={p.id || `pred-${i}`} className="intel-pred-card" style={{ "--pred-color": sc }}>
                  <div className="intel-pred-score-ring">
                    <span className="intel-pred-score" style={{ background: sc + "22", color: sc }}>{score ?? "?"}</span>
                  </div>
                  <div className="intel-pred-body">
                    <div className="intel-pred-title">{p.target || p.resource || p.title || "Prediction"}</div>
                    <div className="intel-pred-detail">{p.reason || p.message || p.prediction || ""}</div>
                    <div className="intel-pred-tags">
                      {score != null && <span className="intel-pred-tag" style={{ color: sc }}>Risk: {score}</span>}
                      {p.hoursRemaining != null && <span className="intel-pred-tag eta">ETA: {p.hoursRemaining}h</span>}
                    </div>
                    {confidence != null && (() => {
                      const pct = typeof confidence === "number" ? Math.round(confidence * 100) : parseInt(confidence) || 0;
                      return (
                        <div className="intel-pred-conf">
                          <span className="intel-pred-conf-lbl">Confidence</span>
                          <div className="intel-pred-conf-bar"><div className="intel-pred-conf-fill" style={{ width: pct + "%", background: sc }} /></div>
                          <span className="intel-pred-conf-pct">{pct}%</span>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ 5. AUTOMATION RULES ═══ */}
      {activeTab === "rules" && (
        <div className="intel-section">
          <div className="intel-section-head">
            <div className="intel-section-title">
              <div className="intel-section-icon auto-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
              </div>
              <div><h3>Automation Rules</h3><p>When X happens, do Y — automated remediation</p></div>
            </div>
          </div>

          {/* Create rule */}
          <div className="intel-rule-create">
            <input className="intel-modal-input" placeholder="Rule name (optional)" value={ruleName} onChange={(e) => setRuleName(e.target.value)} style={{ maxWidth: 200 }} />
            <input className="intel-modal-input" placeholder='Rule description, e.g. "When CrashLoopBackOff in ns production, restart pod and notify Slack"' value={ruleDesc} onChange={(e) => setRuleDesc(e.target.value)} style={{ flex: 1 }} />
            <button className="intel-card-btn primary" onClick={handleCreateRule} disabled={creatingRule || !ruleDesc.trim()}>
              {creatingRule ? "Creating…" : "Create Rule"}
            </button>
          </div>

          {/* Rules list */}
          <div className="intel-card-list">
            {rules.length === 0 && <div className="intel-empty">No automation rules configured</div>}
            {rules.map((r) => (
              <div key={r.id} className="intel-card" style={{ "--card-sev": r.enabled ? "#22c55e" : "#64748b" }}>
                <div className="intel-card-head">
                  <div className="intel-card-body">
                    <div className="intel-card-row1">
                      <span className="intel-card-title">{r.name || `Rule #${r.id}`}</span>
                      <span className={"intel-card-sev-badge " + (r.enabled ? "info" : "warning")}>{r.enabled ? "ACTIVE" : "DISABLED"}</span>
                      {r.executions > 0 && <span className="intel-card-source">{r.executions} executions</span>}
                    </div>
                    <div className="intel-card-msg">{r.description}</div>
                    <div className="intel-card-meta">
                      {r.conditionTypes?.length > 0 && <span>Triggers: {r.conditionTypes.join(", ")}</span>}
                      {r.namespaceFilter && <span>NS: {r.namespaceFilter}</span>}
                      {r.lastTriggered && <span>Last: {timeAgo(r.lastTriggered)}</span>}
                      <span>Cooldown: {r.cooldownMinutes || 0}m</span>
                    </div>
                  </div>
                  <div className="intel-card-actions">
                    <button className="intel-card-btn" onClick={() => handleToggleRule(r.id, r.enabled)}>{r.enabled ? "Disable" : "Enable"}</button>
                    <button className="intel-card-btn" style={{ color: "#ef4444" }} onClick={() => handleDeleteRule(r.id)}>Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ 6. KNOWLEDGE BASE ═══ */}
      {activeTab === "kb" && (
        <div className="intel-section">
          <div className="intel-section-head">
            <div className="intel-section-title">
              <div className="intel-section-icon kb-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              </div>
              <div><h3>Knowledge Base</h3><p>Learned resolutions from past incidents</p></div>
            </div>
          </div>

          {/* KB Stats */}
          <div className="intel-kb-top-stats">
            <div className="intel-kb-stat"><div className="intel-kb-stat-val">{kbStats.totalEntries || 0}</div><div className="intel-kb-stat-lbl">Entries</div></div>
            <div className="intel-kb-stat"><div className="intel-kb-stat-val">{kbStats.avgEffectiveness ?? 0}</div><div className="intel-kb-stat-lbl">Avg Rating</div></div>
            <div className="intel-kb-stat"><div className="intel-kb-stat-val">{Object.keys(kbStats.byType || {}).length}</div><div className="intel-kb-stat-lbl">Issue Types</div></div>
          </div>

          {kbStats.byType && Object.keys(kbStats.byType).length > 0 && (
            <div className="intel-kb-types">
              {Object.entries(kbStats.byType).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([type, count]) => (
                <span key={type} className="intel-kb-type-pill">{type} <strong>{count}</strong></span>
              ))}
            </div>
          )}

          {/* KB Entries */}
          <div className="intel-card-list" style={{ marginTop: 14 }}>
            {kbEntries.length === 0 && <div className="intel-empty">No KB entries yet — they are created when incidents are resolved</div>}
            {kbEntries.slice(0, 30).map((e) => (
              <div key={e.id} className="intel-card" style={{ "--card-sev": "#06b6d4" }}>
                <div className="intel-card-head">
                  <div className="intel-card-body">
                    <div className="intel-card-row1">
                      <span className="intel-card-title">{e.type || "Resolution"}</span>
                      <span className="intel-card-source">{e.resource_pattern || "*"}</span>
                      {e.tags?.length > 0 && e.tags.slice(0, 3).map((t) => <span key={t} className="intel-card-kind-badge insight">{t}</span>)}
                    </div>
                    {e.symptoms && <div className="intel-card-msg"><strong>Symptoms:</strong> {e.symptoms}</div>}
                    {e.root_cause && <div className="intel-card-msg"><strong>Root Cause:</strong> {e.root_cause}</div>}
                    {e.resolution && <div className="intel-card-msg" style={{ color: "#22c55e" }}><strong>Resolution:</strong> {e.resolution}</div>}
                    {e.commands && <div className="intel-fix-cmd"><code>{e.commands}</code></div>}
                    <div className="intel-card-meta">
                      {e.namespace_pattern && e.namespace_pattern !== "*" && <span>NS: {e.namespace_pattern}</span>}
                      <span>Effectiveness: {e.effectiveness || 0}</span>
                      <span>{timeAgo(e.created_at)}</span>
                    </div>
                  </div>
                  <div className="intel-card-actions">
                    <button className="intel-card-btn success" onClick={() => handleRateKB(e.id, 1)} title="Helpful">👍</button>
                    <button className="intel-card-btn" onClick={() => handleRateKB(e.id, -1)} title="Not helpful">👎</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ 7. TEAM PLAYBOOK ═══ */}
      {activeTab === "playbook" && (
        <div className="intel-section">
          <div className="intel-section-head">
            <div className="intel-section-title">
              <div className="intel-section-icon" style={{ background: "linear-gradient(135deg, #f59e0b, #ef4444)" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              </div>
              <div><h3>Team Playbook</h3><p>Learned patterns from incident history (last 90 days)</p></div>
            </div>
          </div>

          {/* Playbook stats */}
          {playbookStats.total != null && (
            <div className="intel-inc-stats" style={{ marginBottom: 14 }}>
              <div className="intel-inc-stat" style={{ "--is-c": "#8b5cf6" }}><span>{playbookStats.total || 0}</span><label>Incidents</label></div>
              <div className="intel-inc-stat" style={{ "--is-c": "#ef4444" }}><span>{playbookStats.open || 0}</span><label>Open</label></div>
              <div className="intel-inc-stat" style={{ "--is-c": "#22c55e" }}><span>{playbookStats.avgMTTR != null ? `${Math.round(playbookStats.avgMTTR)}m` : "—"}</span><label>Avg MTTR</label></div>
            </div>
          )}

          {/* Playbook patterns */}
          <div className="intel-card-list">
            {(!playbook.patterns || playbook.patterns.length === 0) && (!playbook.topIssues || playbook.topIssues.length === 0) && (
              <div className="intel-empty">No playbook patterns yet — they build as incidents are resolved</div>
            )}
            {(playbook.patterns || playbook.topIssues || []).map((p, i) => (
              <div key={i} className="intel-card" style={{ "--card-sev": "#f59e0b" }}>
                <div className="intel-card-head">
                  <div className="intel-card-body">
                    <div className="intel-card-row1">
                      <span className="intel-card-title">{p.type || p.issueType || p.signature || "Pattern"}</span>
                      {p.count && <span className="intel-card-source">{p.count} occurrences</span>}
                      {p.avgResolutionMinutes && <span className="intel-card-kind-badge insight">~{Math.round(p.avgResolutionMinutes)}m to resolve</span>}
                    </div>
                    {p.lastResolution && <div className="intel-card-msg"><strong>Last fix:</strong> {p.lastResolution}</div>}
                    {p.commonNamespaces?.length > 0 && (
                      <div className="intel-card-meta"><span>Common NS: {p.commonNamespaces.join(", ")}</span></div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ 8. CROSS-CLUSTER CORRELATION ═══ */}
      {activeTab === "correlation" && (
        <div className="intel-section">
          <div className="intel-section-head">
            <div className="intel-section-title">
              <div className="intel-section-icon" style={{ background: "linear-gradient(135deg, #ec4899, #8b5cf6)" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/><line x1="15.5" y1="8.5" x2="8.5" y2="15.5"/></svg>
              </div>
              <div>
                <h3>Cross-Cluster Anomaly Correlation</h3>
                <p>AI-detected patterns spanning multiple clusters — shared root causes that single-cluster tools miss</p>
              </div>
            </div>
            <button className="intel-btn" onClick={() => refetchCorr()} style={{ marginLeft: "auto" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Refresh
            </button>
          </div>

          {/* Summary stats */}
          {corrData && (
            <div className="intel-inc-stats" style={{ marginBottom: 14 }}>
              <div className="intel-inc-stat" style={{ "--is-c": "#8b5cf6" }}>
                <span>{corrData.totalSignals || 0}</span><label>Signals</label>
              </div>
              <div className="intel-inc-stat" style={{ "--is-c": "#3b82f6" }}>
                <span>{(corrData.clustersCovered || []).length}</span><label>Clusters</label>
              </div>
              <div className="intel-inc-stat" style={{ "--is-c": "#ef4444" }}>
                <span>{corrData.criticalCount || 0}</span><label>Critical</label>
              </div>
              <div className="intel-inc-stat" style={{ "--is-c": "#f59e0b" }}>
                <span>{corrData.correlationCount || 0}</span><label>Correlations</label>
              </div>
            </div>
          )}

          {/* Correlations list */}
          <div className="intel-card-list">
            {(!corrData?.correlations || corrData.correlations.length === 0) && (
              <div className="intel-empty">
                {corrData?.totalSignals === 0
                  ? "No signals detected — cluster data will appear as agents report"
                  : "No cross-cluster correlations detected — all anomalies appear isolated to individual clusters"}
              </div>
            )}
            {(corrData?.correlations || []).map((c) => (
              <div key={c.id} className="intel-card" style={{ "--card-sev": c.severity === "critical" ? "#ef4444" : "#f59e0b" }}>
                <div className="intel-card-head">
                  <div className="intel-card-body">
                    <div className="intel-card-row1">
                      <span className="intel-card-sev" style={{ background: c.severity === "critical" ? "#ef4444" : "#f59e0b", color: "#fff", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>
                        {c.severity?.toUpperCase()}
                      </span>
                      <span className="intel-card-title" style={{ marginLeft: 8 }}>
                        {c.types?.join(", ") || "Correlated Anomaly"}
                      </span>
                      <span className="intel-card-source" style={{ marginLeft: "auto" }}>
                        {c.signalCount} signals · {c.clusterCount} clusters
                      </span>
                    </div>
                    <div className="intel-card-msg" style={{ marginTop: 6 }}>{c.summary}</div>
                    <div className="intel-card-meta" style={{ marginTop: 6 }}>
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        {(c.clusters || []).map((cl) => (
                          <span key={cl} style={{ background: "#1e293b", color: "#94a3b8", padding: "2px 8px", borderRadius: 4, fontSize: 11 }}>{cl}</span>
                        ))}
                      </span>
                      <span style={{ marginLeft: 12, fontSize: 11, color: "#64748b" }}>
                        {c.spreadMinutes === 0 ? "Simultaneous" : `Spread: ${c.spreadMinutes}m`} · First: {timeAgo(c.firstSeen)}
                      </span>
                    </div>

                    {/* Signal details (expandable) */}
                    {expandedCards[c.id] && (
                      <div style={{ marginTop: 10, padding: "8px 10px", background: "#0f172a", borderRadius: 6, fontSize: 12 }}>
                        <div style={{ fontWeight: 600, marginBottom: 6, color: "#94a3b8" }}>Signals:</div>
                        {(c.signals || []).map((s, si) => (
                          <div key={si} style={{ padding: "3px 0", color: "#cbd5e1", borderBottom: si < c.signals.length - 1 ? "1px solid #1e293b" : "none" }}>
                            <span style={{ color: SEV[s.severity] || "#3b82f6", fontWeight: 600 }}>[{s.cluster}]</span>{" "}
                            <span style={{ color: "#e2e8f0" }}>{s.type}</span>: {s.summary}
                            <span style={{ color: "#475569", marginLeft: 8 }}>{timeAgo(s.timestamp)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* AI Analysis result */}
                    {corrAnalyses[c.id] && (
                      <div style={{ marginTop: 10, padding: "10px 12px", background: "linear-gradient(135deg, #1e1b4b, #0f172a)", borderRadius: 6, border: "1px solid #4c1d95" }}>
                        <div style={{ fontWeight: 600, marginBottom: 6, color: "#a78bfa", fontSize: 12 }}>AI Root Cause Analysis</div>
                        <div style={{ fontSize: 12, color: "#e2e8f0", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                          {corrAnalyses[c.id]}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="intel-card-actions" style={{ borderTop: "1px solid #1e293b", padding: "6px 12px", display: "flex", gap: 8 }}>
                  <button className="intel-btn" onClick={() => setExpandedCards(p => ({ ...p, [c.id]: !p[c.id] }))}>
                    {expandedCards[c.id] ? "Collapse" : "Details"}
                  </button>
                  <button
                    className="intel-btn"
                    disabled={corrAnalyzing[c.id]}
                    onClick={async () => {
                      setCorrAnalyzing(p => ({ ...p, [c.id]: true }));
                      try {
                        const resp = await fetch(clusterUrl("/api/intelligence/correlations/investigate"), {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ correlationId: c.id }),
                        });
                        const data = await resp.json();
                        if (data.analysis?.analysis) {
                          setCorrAnalyses(p => ({ ...p, [c.id]: data.analysis.analysis }));
                        } else {
                          showToast("AI analysis unavailable — check LLM configuration", "warning");
                        }
                      } catch (err) {
                        showToast("Analysis failed: " + err.message, "error");
                      }
                      setCorrAnalyzing(p => ({ ...p, [c.id]: false }));
                    }}
                  >
                    {corrAnalyzing[c.id] ? "Analyzing..." : "AI Investigate"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SOP Runner — compile a runbook into a validated, dry-run plan */}
      <SopRunner />
    </div>
  );
}
