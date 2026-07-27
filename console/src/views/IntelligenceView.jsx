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
  const { data: incSettingsData, refetch: refetchIncSettings } =
    useClusterQuery("/api/intelligence/incident-settings", { refetchInterval: 120_000 });
  // Duplicate-ticket backlog (read-only sweep of open incidents we raised).
  const { data: dupData, refetch: refetchDupes } =
    useClusterQuery("/api/intelligence/incident-duplicates", { refetchInterval: 300_000 });
  // Change ledger — every mutation we applied, with its recorded inverse.
  const { data: changeData, refetch: refetchChanges } =
    useClusterQuery("/api/intelligence/changes", { refetchInterval: 60_000 });

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
  // Actionable vs chronic — chronic entries are informational (Problem
  // candidates) and would otherwise bury the few that can actually be ticketed.
  const [detectFilter, setDetectFilter] = useState("actionable");
  // Repeat offenders — surfaced at the top so a returning fault is impossible to miss.
  const escalations = useMemo(() => detected.filter((d) => d.escalated), [detected]);
  const visibleDetections = useMemo(() => {
    if (detectFilter === "chronic") return detected.filter((d) => d.chronic);
    if (detectFilter === "actionable") return detected.filter((d) => !d.chronic);
    return detected;
  }, [detected, detectFilter]);

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
      refetchDupes();
      refetchChanges();
    } catch (e) {
      showToast(e.message, "err");
    } finally {
      setBusySession((p) => ({ ...p, [path]: false }));
    }
  }, [cluster, refetchSessions]);

  const [revertPreview, setRevertPreview] = useState({});
  const revertChange = useCallback(async (id, { dryRun, useNativeUndo = false }) => {
    const key = `rev-${id}`;
    setBusySession((p) => ({ ...p, [key]: true }));
    try {
      const res = await fetch(clusterUrl(`/api/intelligence/changes/${id}/revert`, cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun, useNativeUndo, actor: "operator" }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) { showToast(d.error, "err"); return; }
      if (dryRun) {
        setRevertPreview((p) => ({ ...p, [id]: d.output || "dry-run OK" }));
        showToast("Revert dry-run passed — review, then Revert", "ok");
      } else {
        showToast(d.verification?.ok ? "Reverted and verified" : "Reverted — verification did not pass", d.verification?.ok ? "ok" : "warn");
        refetchChanges();
      }
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusySession((p) => ({ ...p, [key]: false })); }
  }, [cluster, refetchChanges]);

  const promoteDetection = useCallback((inc) => {
    callSession("/api/intelligence/incident-sessions/promote", { detection: inc },
      "Incident opened — running RCA, ticket and dry-run…");
  }, [callSession]);

  // ── Incident automation settings (editable, no redeploy) ──
  const [showIncSettings, setShowIncSettings] = useState(false);
  const [incForm, setIncForm] = useState(null);
  const [savingInc, setSavingInc] = useState(false);
  const incSettings = incSettingsData?.settings || null;

  // Seed the form the first time settings arrive (and whenever the panel opens).
  const openIncSettings = useCallback(() => {
    setIncForm({
      autoAct: !!incSettings?.autoAct,
      assignmentGroup: incSettings?.assignmentGroup || "",
      chronicHours: incSettings?.chronicHours ?? 24,
      severityFloor: incSettings?.severityFloor || "SEV-2",
      maxTicketsPerHour: incSettings?.maxTicketsPerHour ?? 10,
      selfHealScans: incSettings?.selfHealScans ?? 2,
      chronicActivityOverride: incSettings?.chronicActivityOverride !== false,
      attachRcaReports: incSettings?.attachRcaReports !== false,
      autoCloseDuplicates: !!incSettings?.autoCloseDuplicates,
    });
    setShowIncSettings(true);
  }, [incSettings]);

  const saveIncSettings = useCallback(async () => {
    if (!incForm) return;
    setSavingInc(true);
    try {
      const res = await fetch(clusterUrl("/api/intelligence/incident-settings", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(incForm),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) { showToast(d.error, "err"); return; }
      // Surface a mistyped queue name instead of silently leaving it unassigned.
      if (d.groupCheck?.checked && d.groupCheck.found === false) {
        showToast(`Saved, but ServiceNow has no group named "${d.groupCheck.name}" — incidents will use default routing`, "warn");
      } else {
        showToast(d.settings?.autoAct ? "Saved — autonomous mode ON" : "Settings saved", "ok");
      }
      setShowIncSettings(false);
      refetchIncSettings(); refetchSessions(); refetchDetect();
    } catch (e) {
      showToast(e.message, "err");
    } finally { setSavingInc(false); }
  }, [incForm, cluster, refetchIncSettings, refetchSessions, refetchDetect]);

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

  // ── Layout mode ──────────────────────────────────────────────────────────
  // "focused" groups the nav and splits Auto-Detect into Live/History/Policy.
  // "classic" is the original flat 8-tab layout, kept as an instant escape
  // hatch: it is a localStorage flag, so switching back needs no redeploy.
  const [layout, setLayout] = useState(() => {
    try { return localStorage.getItem("intelLayout") || "focused"; } catch { return "focused"; }
  });
  const focused = layout === "focused";
  const switchLayout = useCallback((next) => {
    setLayout(next);
    try { localStorage.setItem("intelLayout", next); } catch { /* private mode */ }
  }, []);
  // Sub-view within Autonomous (focused layout only).
  const [autoSub, setAutoSub] = useState("live");
  const [moreOpen, setMoreOpen] = useState(false);
  // Section visibility: classic shows everything stacked (original behaviour);
  // focused assigns each section to one sub-view.
  const showSub = useCallback((sub) => !focused || autoSub === sub, [focused, autoSub]);

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

          {/* Outcome metrics in the focused layout — the original counts merely
              restated the tab badges, and "Monitoring" was shown twice. */}
          <div className="intel-hero-stats">
            {(focused ? [
              { v: iStats.avgMTTR != null ? `${Math.round(iStats.avgMTTR)}m` : "—", l: "Median MTTR", c: "#22c55e" },
              { v: awaiting.length, l: "Awaiting You", c: awaiting.length > 0 ? "#f59e0b" : "#64748b" },
              { v: sessions.filter((x) => x.state === "closed").length, l: "Auto-Resolved", c: "#06b6d4" },
              { v: dStats.correlationSavings ?? 0, l: "Tickets Avoided", c: "#22c55e" },
              { v: dStats.escalated ?? 0, l: "Escalated", c: (dStats.escalated ?? 0) > 0 ? "#ef4444" : "#64748b" },
              { v: sevCounts.critical, l: "Critical Alerts", c: "#ef4444" },
            ] : [
              { v: sevCounts.critical, l: "Critical", c: "#ef4444" },
              { v: sevCounts.warning, l: "Warning", c: "#f59e0b" },
              { v: predictions.length, l: "Predicted", c: "#8b5cf6" },
              { v: iStats.open || 0, l: "Open Incidents", c: "#22c55e" },
              { v: rules.length, l: "Auto Rules", c: "#06b6d4" },
              { v: monitoring ? "ON" : "OFF", l: "Monitoring", c: monitoring ? "#22c55e" : "#64748b" },
            ]).map((k) => (
              <div key={k.l} className="intel-stat-box" style={{ "--stat-color": k.c }}>
                <div className="intel-stat-val">{k.v}</div>
                <div className="intel-stat-label">{k.l}</div>
              </div>
            ))}
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
      {/* Focused layout promotes the two sections people actually use and files
          the rest under "More", so the nav advertises what is live instead of a
          row of zeroes. Classic keeps the original flat list. */}
      <div className="intel-tabs">
        {(focused ? [
          { key: "insights", label: "Overview", count: totalActive },
          { key: "autodetect", label: awaiting.length > 0 ? `Autonomous · ${awaiting.length} to approve` : "Autonomous", count: detected.length },
          { key: "predictions", label: "Predictions", count: predictions.length },
        ] : [
          { key: "insights", label: "Insights & Alerts", count: totalActive },
          { key: "autodetect", label: awaiting.length > 0 ? `Auto-Detect · ${awaiting.length} to approve` : "Auto-Detect", count: detected.length },
          { key: "incidents", label: "Incidents", count: incidents.length },
          { key: "timeline", label: "Change Timeline", count: tlEvents.length },
          { key: "predictions", label: "Predictions", count: predictions.length },
          { key: "rules", label: "Automation Rules", count: rules.length },
          { key: "kb", label: "Knowledge Base", count: kbEntries.length },
          { key: "playbook", label: "Team Playbook" },
          { key: "correlation", label: "Cross-Cluster", count: corrData?.correlationCount || 0 },
        ]).map((t) => (
          <button key={t.key} className={"intel-tab" + (activeTab === t.key ? " active" : "")} onClick={() => setActiveTab(t.key)}>
            {t.label}
            {t.count != null && <span className="intel-tab-count">{t.count}</span>}
          </button>
        ))}

        {/* "More" collects the sections that are usually empty, so they stay
            reachable without occupying prime navigation. */}
        {focused && (
          <div style={{ position: "relative" }}>
            <button className={"intel-tab" + (["incidents", "timeline", "rules", "kb", "playbook", "correlation"].includes(activeTab) ? " active" : "")}
              onClick={() => setMoreOpen((o) => !o)}>
              More ▾
            </button>
            {moreOpen && (
              <div style={{
                position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 40, minWidth: 210,
                background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10,
                boxShadow: "0 10px 30px rgba(0,0,0,.35)", padding: 6,
              }}>
                {[
                  { key: "incidents", label: "Incidents", count: incidents.length },
                  { key: "timeline", label: "Cluster Drift (changes seen)", count: tlEvents.length },
                  { key: "rules", label: "Automation Rules", count: rules.length },
                  { key: "kb", label: "Knowledge Base", count: kbEntries.length },
                  { key: "playbook", label: "Team Playbook · SOP Runner" },
                  { key: "correlation", label: "Cross-Cluster", count: corrData?.correlationCount || 0 },
                ].map((m) => (
                  <button key={m.key}
                    onClick={() => { setActiveTab(m.key); setMoreOpen(false); }}
                    style={{
                      display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between",
                      gap: 10, padding: "7px 10px", borderRadius: 7, border: "none", cursor: "pointer",
                      background: activeTab === m.key ? "color-mix(in srgb, var(--text2) 14%, transparent)" : "transparent",
                      color: "var(--text)", font: "inherit", fontSize: 12.5, textAlign: "left",
                    }}>
                    <span>{m.label}</span>
                    {m.count != null && <span style={{ opacity: .6, fontSize: 11 }}>{m.count}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Instant escape hatch — no rebuild, no redeploy. */}
        <button className="intel-tab" style={{ marginLeft: "auto", opacity: .75, fontSize: 11 }}
          title={focused ? "Switch back to the original flat 8-tab layout" : "Switch to the grouped layout"}
          onClick={() => switchLayout(focused ? "classic" : "focused")}>
          {focused ? "↩ Classic layout" : "✦ New layout"}
        </button>
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
            <div style={{ display: "flex", gap: 8 }}>
              <button className="intel-hero-btn" onClick={openIncSettings}>⚙ Automation Settings</button>
              <button className="intel-hero-btn" onClick={() => refetchDetect()}>Re-scan</button>
            </div>
          </div>

          {/* Three purposeful sub-views instead of one long scroll:
              Live = what needs me now · History = what we changed · Policy = how it behaves. */}
          {focused && (
            <div className="intel-tabs" style={{ marginBottom: 14 }}>
              {[
                { k: "live", label: "Live", count: escalations.length + awaiting.length + visibleDetections.length },
                { k: "history", label: "History", count: changeData?.changes?.length ?? 0 },
                { k: "policy", label: "Policy", count: null },
              ].map((t) => (
                <button key={t.k} className={"intel-tab" + (autoSub === t.k ? " active" : "")}
                  onClick={() => setAutoSub(t.k)}>
                  {t.label}
                  {t.count != null && <span className="intel-tab-count">{t.count}</span>}
                </button>
              ))}
            </div>
          )}

          {/* ── Automation settings — editable without a redeploy ── */}
          {showIncSettings && incForm && (
            <div style={{
              border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 16,
              background: "color-mix(in srgb, var(--text2) 6%, transparent)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                <div>
                  <h3 style={{ fontSize: 14, margin: 0 }}>Incident Automation Settings</h3>
                  <p style={{ fontSize: 11.5, opacity: .8, margin: "3px 0 0" }}>
                    Applied live on the next scan — no pod restart. Stored in the database
                    {incSettings?._storage ? ` (currently: ${incSettings._storage})` : ""}.
                  </p>
                </div>
                <button className="intel-card-btn" onClick={() => setShowIncSettings(false)}>Close</button>
              </div>

              {/* Master switch */}
              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 9,
                border: `1px solid ${incForm.autoAct ? "rgba(34,197,94,.5)" : "var(--border)"}`,
                background: incForm.autoAct ? "rgba(34,197,94,.10)" : "transparent", cursor: "pointer", marginBottom: 12,
              }}>
                <input type="checkbox" checked={incForm.autoAct} style={{ marginTop: 3 }}
                  onChange={(e) => setIncForm((f) => ({ ...f, autoAct: e.target.checked }))} />
                <span style={{ fontSize: 12.5 }}>
                  <strong>Autonomous mode</strong> — raise ServiceNow incidents automatically when a threshold
                  breaches, and auto-close them when the condition self-resolves.
                  <span style={{ display: "block", opacity: .8, marginTop: 2 }}>
                    Applying a fix always still requires your approval.
                  </span>
                </span>
              </label>

              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 12px", borderRadius: 9,
                border: "1px solid var(--border)", cursor: "pointer", marginBottom: 12,
              }}>
                <input type="checkbox" checked={incForm.chronicActivityOverride} style={{ marginTop: 3 }}
                  onChange={(e) => setIncForm((f) => ({ ...f, chronicActivityOverride: e.target.checked }))} />
                <span style={{ fontSize: 12.5 }}>
                  <strong>Treat actively-failing workloads as live, regardless of age</strong>
                  <span style={{ display: "block", opacity: .8, marginTop: 2 }}>
                    A container still restarting right now is a live incident even if it has been failing for days.
                    Turn off to classify purely by age.
                  </span>
                </span>
              </label>

              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 12px", borderRadius: 9,
                border: "1px solid var(--border)", cursor: "pointer", marginBottom: 10,
              }}>
                <input type="checkbox" checked={incForm.attachRcaReports} style={{ marginTop: 3 }}
                  onChange={(e) => setIncForm((f) => ({ ...f, attachRcaReports: e.target.checked }))} />
                <span style={{ fontSize: 12.5 }}>
                  <strong>Attach the RCA report (HTML + PDF) to the ticket</strong>
                  <span style={{ display: "block", opacity: .8, marginTop: 2 }}>
                    Attached before closing, so auditors see the full report in ServiceNow rather than a link.
                    The text RCA always stays in the close notes regardless.
                  </span>
                </span>
              </label>

              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 12px", borderRadius: 9,
                border: `1px solid ${incForm.autoCloseDuplicates ? "rgba(245,158,11,.5)" : "var(--border)"}`,
                background: incForm.autoCloseDuplicates ? "rgba(245,158,11,.08)" : "transparent",
                cursor: "pointer", marginBottom: 12,
              }}>
                <input type="checkbox" checked={incForm.autoCloseDuplicates} style={{ marginTop: 3 }}
                  onChange={(e) => setIncForm((f) => ({ ...f, autoCloseDuplicates: e.target.checked }))} />
                <span style={{ fontSize: 12.5 }}>
                  <strong>Auto-close duplicate tickets we raised</strong>
                  <span style={{ display: "block", opacity: .8, marginTop: 2 }}>
                    Only ever touches tickets raised by this platform. Human-raised tickets are linked and
                    annotated but never closed automatically.
                  </span>
                </span>
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 600, display: "block", marginBottom: 4 }}>
                    ServiceNow assignment group
                  </label>
                  <input type="text" value={incForm.assignmentGroup} placeholder="e.g. Platform-SRE (blank = default)"
                    onChange={(e) => setIncForm((f) => ({ ...f, assignmentGroup: e.target.value }))}
                    style={{ width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--card)", color: "var(--text)", fontSize: 12.5 }} />
                  <div style={{ fontSize: 10.5, opacity: .7, marginTop: 3 }}>
                    The admin queue incidents are assigned to. Verified against ServiceNow on save.
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 600, display: "block", marginBottom: 4 }}>Severity floor</label>
                  <select value={incForm.severityFloor}
                    onChange={(e) => setIncForm((f) => ({ ...f, severityFloor: e.target.value }))}
                    style={{ width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--card)", color: "var(--text)", fontSize: 12.5 }}>
                    {["SEV-1", "SEV-2", "SEV-3", "SEV-4"].map((s) => <option key={s} value={s}>{s} and worse</option>)}
                  </select>
                  <div style={{ fontSize: 10.5, opacity: .7, marginTop: 3 }}>Only these are auto-ticketed.</div>
                </div>

                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 600, display: "block", marginBottom: 4 }}>Chronic window (hours)</label>
                  <input type="number" min="0" max="8760" value={incForm.chronicHours}
                    onChange={(e) => setIncForm((f) => ({ ...f, chronicHours: e.target.value }))}
                    style={{ width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--card)", color: "var(--text)", fontSize: 12.5 }} />
                  <div style={{ fontSize: 10.5, opacity: .7, marginTop: 3 }}>
                    Older than this when first seen → Problem candidate, not a new incident.
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 600, display: "block", marginBottom: 4 }}>Max tickets / hour</label>
                  <input type="number" min="1" max="500" value={incForm.maxTicketsPerHour}
                    onChange={(e) => setIncForm((f) => ({ ...f, maxTicketsPerHour: e.target.value }))}
                    style={{ width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--card)", color: "var(--text)", fontSize: 12.5 }} />
                  <div style={{ fontSize: 10.5, opacity: .7, marginTop: 3 }}>Storm brake.</div>
                </div>

                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 600, display: "block", marginBottom: 4 }}>Self-heal confirm scans</label>
                  <input type="number" min="1" max="20" value={incForm.selfHealScans}
                    onChange={(e) => setIncForm((f) => ({ ...f, selfHealScans: e.target.value }))}
                    style={{ width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--card)", color: "var(--text)", fontSize: 12.5 }} />
                  <div style={{ fontSize: 10.5, opacity: .7, marginTop: 3 }}>
                    Clear scans required before auto-closing (guards against flapping).
                  </div>
                </div>
              </div>

              {incForm.autoAct && (
                <div style={{ marginTop: 12, padding: "9px 12px", borderRadius: 8, fontSize: 12,
                  background: "rgba(245,158,11,.12)", border: "1px solid rgba(245,158,11,.4)" }}>
                  ⚠ Turning this on lets the system create real ServiceNow incidents unattended.
                  With the current policy, <strong>{dStats.wouldRaiseTickets ?? 0}</strong> of{" "}
                  <strong>{dStats.detections ?? 0}</strong> detections would be ticketed
                  {dStats.chronic > 0 && <> ({dStats.chronic} chronic are excluded)</>}.
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button className="intel-card-btn primary" disabled={savingInc} onClick={saveIncSettings}>
                  {savingInc ? "Saving…" : "Save settings"}
                </button>
                <button className="intel-card-btn" onClick={() => setShowIncSettings(false)}>Cancel</button>
              </div>
            </div>
          )}

          {/* Shadow-mode banner — the whole point of Phase 1 */}
          <div style={{
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            padding: "10px 14px", borderRadius: 10, marginBottom: 14,
            background: "rgba(14,165,233,.12)", border: "1px solid rgba(14,165,233,.4)", fontSize: 12.5,
          }}>
            <strong style={{ color: sessData?.autoActEnabled ? "#4ade80" : "#38bdf8" }}>
              {sessData?.autoActEnabled ? "AUTONOMOUS MODE" : "SHADOW MODE"}
            </strong>
            <span style={{ opacity: .9 }}>
              {sessData?.autoActEnabled
                ? "Eligible breaches raise a ServiceNow incident automatically and self-resolved conditions close themselves. Fixes still require your approval."
                : (detectData?.notice || "Detections only — no tickets raised, nothing remediated.")}
            </span>
            <span style={{ marginLeft: "auto", opacity: .75 }}>
              Autonomous action: <strong style={{ color: sessData?.autoActEnabled ? "#22c55e" : "#94a3b8" }}>
                {sessData?.autoActEnabled ? "ENABLED" : "OFF"}
              </strong>
              {sessData?.selfHealed > 0 && (
                <span style={{ marginLeft: 10, color: "#4ade80" }}>· {sessData.selfHealed} self-healed</span>
              )}
            </span>
          </div>

          {detectData?.disabled && (
            <div className="intel-empty">Auto-detection is disabled. Set <code>INCIDENT_AUTO_DETECT=true</code> to enable.</div>
          )}
          {detectData?.error && <div className="intel-empty">{detectData.error}</div>}

          {/* ── DUPLICATE TICKET BACKLOG — groups that pre-date correlation dedup ── */}
          {showSub("policy") && dupData?.groups?.length > 0 && (
            <div style={{
              border: "1px solid rgba(14,165,233,.45)", borderRadius: 12, padding: 14, marginBottom: 16,
              background: "rgba(14,165,233,.07)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 14, color: "#38bdf8" }}>
                  Duplicate tickets — {dupData.groups.length} group{dupData.groups.length > 1 ? "s" : ""}
                </strong>
                <span style={{ fontSize: 11.5, opacity: .85 }}>
                  Open incidents raised for the same condition. Linking is safe; only tickets this platform
                  raised are closed — human-raised ones are annotated and left for you.
                </span>
                <button className="intel-card-btn primary" style={{ marginLeft: "auto" }}
                  disabled={!!busySession["/api/intelligence/incident-duplicates/reconcile"]}
                  onClick={() => callSession("/api/intelligence/incident-duplicates/reconcile", {},
                    "Duplicates linked — ours closed, human-raised left open")}>
                  {busySession["/api/intelligence/incident-duplicates/reconcile"] ? "…" : "Link & clean up"}
                </button>
              </div>
              {dupData.groups.slice(0, 8).map((g) => (
                <div key={g.correlationId} style={{
                  padding: "8px 10px", borderRadius: 8, marginTop: 6,
                  background: "rgba(0,0,0,.14)", border: "1px solid rgba(14,165,233,.25)", fontSize: 12,
                }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                    <strong>{g.primary.number}</strong>
                    <span style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 999,
                      background: "rgba(34,197,94,.2)", color: "#4ade80" }}>primary</span>
                    <span style={{ opacity: .85, maxWidth: 460, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {g.primary.shortDescription}
                    </span>
                  </div>
                  <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {g.duplicates.map((d) => (
                      <span key={d.number} style={{
                        fontSize: 10.5, padding: "1px 7px", borderRadius: 999,
                        background: d.ours ? "rgba(14,165,233,.2)" : "rgba(245,158,11,.2)",
                        color: d.ours ? "#38bdf8" : "#fbbf24",
                      }} title={d.ours ? "Raised by this platform — safe to auto-close" : "Human-raised — will be linked and annotated only"}>
                        {d.number} · {d.ours ? "ours" : "human"}{d.alreadyLinked ? " · linked" : ""}
                      </span>
                    ))}
                  </div>
                  <div style={{ marginTop: 3, fontSize: 10.5, opacity: .7 }}>
                    correlation <code>{g.correlationId}</code>
                  </div>
                </div>
              ))}
              {dupData.groups.length > 8 && (
                <div style={{ marginTop: 6, fontSize: 11, opacity: .7 }}>+{dupData.groups.length - 8} more group(s)</div>
              )}
            </div>
          )}

          {/* ── ESCALATIONS — repeat offenders demand attention now ── */}
          {showSub("live") && escalations.length > 0 && (
            <div style={{
              border: "1px solid rgba(220,38,38,.5)", borderRadius: 12, padding: 14, marginBottom: 16,
              background: "rgba(220,38,38,.08)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 15 }}>⚠</span>
                <strong style={{ fontSize: 14, color: "#fca5a5" }}>
                  Escalated — {escalations.length} recurring condition{escalations.length > 1 ? "s" : ""}
                </strong>
                <span style={{ fontSize: 11.5, opacity: .85 }}>
                  Returned {detectData?.policy?.escalateAfterOccurrences ?? 3}+ times. A fault that keeps coming back is an
                  unresolved root cause — raise a Problem record rather than closing another Incident.
                </span>
              </div>
              {escalations.map((e) => (
                <div key={e.signature} style={{
                  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                  padding: "8px 10px", borderRadius: 8, marginTop: 6,
                  background: "rgba(0,0,0,.15)", border: "1px solid rgba(220,38,38,.3)",
                }}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 999,
                    background: "rgba(220,38,38,.25)", color: "#fca5a5" }}>{e.severity}</span>
                  {e.baseSeverity && e.baseSeverity !== e.severity && (
                    <span style={{ fontSize: 10.5, opacity: .7 }}>was {e.baseSeverity}</span>
                  )}
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{e.title}</span>
                  <span style={{ fontSize: 11, color: "#fca5a5" }}>{e.occurrences}× recurring</span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    {!managedSigs.has(e.signature) && (
                      <button className="intel-card-btn success" onClick={() => promoteDetection(e)}>Open Incident →</button>
                    )}
                    <button className="intel-card-btn" onClick={() => investigateDetection(e)}>Ask AI</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── APPROVAL INBOX — the single human gate ── */}
          {showSub("live") && liveSessions.length > 0 && (
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
                  const dPath = `/api/intelligence/incident-sessions/${s.id}/dry-run`;
                  const pPath = `/api/intelligence/incident-sessions/${s.id}/replan`;
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
                            {s.itilPriority && <span className="intel-card-source">{s.itilPriority}</span>}
                            {s.reusedExistingTicket && (
                              <span className="intel-card-kind-badge" style={{ background: "rgba(14,165,233,.18)", color: "#38bdf8" }}
                                title="An open ticket already existed for this condition — attached to it instead of raising a duplicate">
                                existing ticket reused
                              </span>
                            )}
                            {s.closedExternally && (
                              <span className="intel-card-kind-badge" style={{ background: "rgba(100,116,139,.25)", color: "#cbd5e1" }}>
                                closed in ServiceNow
                              </span>
                            )}
                            {s.selfHealed && (
                              <span className="intel-card-kind-badge" style={{ background: "rgba(34,197,94,.18)", color: "#4ade80" }}>
                                self-healed · auto-closed
                              </span>
                            )}
                            {s.promotedBy === "auto-detect" && (
                              <span className="intel-card-kind-badge" style={{ background: "rgba(14,165,233,.18)", color: "#38bdf8" }}>
                                auto-raised
                              </span>
                            )}
                          </div>

                          {s.rca?.rootCause && (
                            <div className="intel-card-msg">
                              <strong>Root cause:</strong> {s.rca.rootCause}
                              {s.rca.category && <span style={{ opacity: .75 }}> · {s.rca.category}</span>}
                              {s.rca.aiAnalysed && (
                                <span style={{ marginLeft: 6, fontSize: 10, padding: "1px 6px", borderRadius: 999,
                                  background: "rgba(139,92,246,.2)", color: "#c4b5fd" }}>
                                  AI analysis{s.rca.confidence ? ` · ${s.rca.confidence}` : ""}
                                </span>
                              )}
                            </div>
                          )}

                          {/* Detailed AI analysis — the "why", not just the label */}
                          {s.rca?.analysis && (
                            <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.55, opacity: .92 }}>
                              {s.rca.analysis}
                            </div>
                          )}
                          {s.rca?.impact && (
                            <div style={{ marginTop: 5, fontSize: 11.5 }}>
                              <strong>Impact:</strong> {s.rca.impact}
                            </div>
                          )}
                          {s.rca?.whyChain?.length > 0 && (
                            <div style={{ marginTop: 6, fontSize: 11.5, opacity: .88 }}>
                              <strong>Causal chain:</strong>{" "}
                              {s.rca.whyChain.join(" → ")}
                            </div>
                          )}
                          {s.rca?.logLines?.length > 0 && (
                            <details style={{ marginTop: 6 }}>
                              <summary style={{ cursor: "pointer", fontSize: 11.5, opacity: .85 }}>
                                Log evidence ({s.rca.logLines.length} line{s.rca.logLines.length === 1 ? "" : "s"})
                              </summary>
                              <div style={{ marginTop: 4, fontFamily: "var(--font-mono, monospace)", fontSize: 10.5, opacity: .85,
                                maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                                {s.rca.logLines.slice(0, 12).map((l, i) => <div key={i}>| {l}</div>)}
                              </div>
                            </details>
                          )}
                          {s.rca && !s.rca.aiAnalysed && s.rca.aiUnavailableReason && (
                            <div style={{ marginTop: 5, fontSize: 11, opacity: .7, fontStyle: "italic" }}>
                              {s.rca.aiUnavailableReason}
                            </div>
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
                            <div style={{
                              marginTop: 7, padding: "7px 10px", borderRadius: 7, fontSize: 11.5,
                              background: "color-mix(in srgb, var(--text2) 10%, transparent)",
                              border: `1px solid ${s.dryRunOk === false ? "rgba(239,68,68,.4)" : "var(--border)"}`,
                            }}>
                              <strong style={{ color: s.dryRunOk === false ? "#fca5a5" : "#4ade80" }}>
                                {s.dryRunOk === false ? "Dry-run failed" : "Dry-run passed"}
                              </strong>
                              {s.dryRunAt && <span style={{ opacity: .65 }}> · {timeAgo(s.dryRunAt)}</span>}
                              <div style={{ fontFamily: "var(--font-mono, monospace)", marginTop: 3, opacity: .9, wordBreak: "break-word" }}>
                                {String(s.dryRunOutput).slice(0, 300)}
                              </div>
                            </div>
                          )}
                          {s.escalationReason && (
                            <div style={{ marginTop: 6, fontSize: 11.5, color: "#fca5a5" }}>{s.escalationReason}</div>
                          )}
                          {/* CLI transcript — exactly what ran, in terminal form */}
                          {s.terminal?.length > 0 && (
                            <pre style={{
                              marginTop: 8, marginBottom: 0, padding: "10px 12px", borderRadius: 8,
                              background: "#0b1220", color: "#e2e8f0", border: "1px solid rgba(148,163,184,.25)",
                              fontFamily: "var(--font-mono, ui-monospace, Menlo, monospace)", fontSize: 11,
                              lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word",
                              maxHeight: 220, overflowY: "auto",
                            }}>
                              {s.terminal.map((l, i) => (
                                <div key={i} style={{
                                  color: l.startsWith("$") ? "#86efac"
                                    : l.startsWith("# NOT") ? "#fca5a5"
                                    : l.startsWith("#") ? "#7dd3fc" : "#e2e8f0",
                                }}>{l || "\u00a0"}</div>
                              ))}
                            </pre>
                          )}

                          {/* Before / after container status — evidence, not a claim */}
                          {(s.beforeSnapshot?.rows?.length > 0 || s.afterSnapshot?.rows?.length > 0) && (
                            <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                              {[["Before fix", s.beforeSnapshot], ["After fix", s.afterSnapshot]].map(([label, snap]) =>
                                snap?.rows?.length ? (
                                  <div key={label} style={{ flex: 1, minWidth: 260, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                                    <div style={{ padding: "5px 9px", fontSize: 11, fontWeight: 700,
                                      background: label === "After fix" ? "rgba(34,197,94,.14)" : "rgba(100,116,139,.16)",
                                      color: label === "After fix" ? "#4ade80" : "var(--text2)" }}>{label}</div>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5,
                                      fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                                      <thead><tr>{snap.header.map((h) => (
                                        <th key={h} style={{ textAlign: "left", padding: "4px 6px", opacity: .6, fontWeight: 600 }}>{h}</th>
                                      ))}</tr></thead>
                                      <tbody>{snap.rows.map((r) => (
                                        <tr key={r.name} style={{ borderTop: "1px solid var(--border)" }}>
                                          <td style={{ padding: "4px 6px", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</td>
                                          <td style={{ padding: "4px 6px", color: r.healthy ? "#4ade80" : "#fbbf24" }}>{r.ready}</td>
                                          <td style={{ padding: "4px 6px", color: r.healthy ? "#4ade80" : "#fca5a5" }}>{r.status}</td>
                                          <td style={{ padding: "4px 6px" }}>{r.restarts}</td>
                                          <td style={{ padding: "4px 6px", opacity: .7 }}>{r.age}</td>
                                        </tr>
                                      ))}</tbody>
                                    </table>
                                  </div>
                                ) : null)}
                            </div>
                          )}

                          {(s.rcaAttachments || s.duplicateGroup) && (
                            <div style={{ marginTop: 6, fontSize: 11.5, display: "flex", flexWrap: "wrap", gap: 10 }}>
                              {s.rcaAttachments && (
                                <span style={{ color: (s.rcaAttachments.html || s.rcaAttachments.pdf) ? "#4ade80" : "#fbbf24" }}>
                                  📎 RCA attached: {[s.rcaAttachments.html && "HTML", s.rcaAttachments.pdf && "PDF"].filter(Boolean).join(" + ") || "none"}
                                  {s.rcaAttachments.error && <span style={{ opacity: .75 }}> — {s.rcaAttachments.error}</span>}
                                </span>
                              )}
                              {s.duplicateGroup?.linked?.length > 0 && (
                                <span style={{ color: "#38bdf8" }}>
                                  🔗 {s.duplicateGroup.linked.length} duplicate ticket(s) linked
                                  {s.duplicateGroup.closed?.length > 0 && ` · ${s.duplicateGroup.closed.length} auto-closed`}
                                  {s.duplicateGroup.humanOwned?.length > 0 && ` · ${s.duplicateGroup.humanOwned.length} human-raised left open`}
                                </span>
                              )}
                            </div>
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

                        <div className="intel-card-actions" style={{ gap: 6, flexWrap: "wrap" }}>
                          {gate && (
                            <>
                              <button className="intel-card-btn" disabled={!!busySession[dPath]}
                                title="Preview the change against the live API server (?dryRun=All) — nothing is modified"
                                onClick={() => callSession(dPath, {}, "Dry-run complete — review the output, then Apply Fix")}>
                                {busySession[dPath] ? "…" : "▷ Dry-run"}
                              </button>
                              <button className="intel-card-btn success" disabled={!!busySession[aPath]}
                                title="Apply the fix, then verify and close the ticket with the RCA — all automatic"
                                onClick={() => callSession(aPath, { actor: "operator" }, "Applying fix — verification and ticket closure will follow automatically")}>
                                {busySession[aPath] ? "…" : "✅ Apply Fix"}
                              </button>
                              <button className="intel-card-btn" disabled={!!busySession[rPath]}
                                onClick={() => callSession(rPath, { actor: "operator", reason: "Rejected from Approval Inbox" }, "Rejected — incident left for manual handling")}>
                                Reject
                              </button>
                            </>
                          )}
                          {s.state === "escalated" && (
                            <button className="intel-card-btn" disabled={!!busySession[pPath]}
                              title="Re-attempt automated remediation planning for this incident"
                              onClick={() => callSession(pPath, {}, "Fix found — review the dry-run, then Apply Fix")}>
                              {busySession[pPath] ? "…" : "↻ Retry auto-fix"}
                            </button>
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
          {showSub("live") && <>
          <div className="intel-inc-stats">
            <div className="intel-inc-stat" style={{ "--is-c": "#0ea5e9" }}><span>{dStats.detections ?? 0}</span><label>Detections</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#8b5cf6" }}><span>{dStats.symptoms ?? 0}</span><label>Raw Symptoms</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#22c55e" }}><span>{dStats.correlationSavings ?? 0}</span><label>Tickets Avoided</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#f59e0b" }}><span>{dStats.wouldRaiseTickets ?? 0}</span><label>Auto-Ticket Eligible</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#64748b" }}><span>{dStats.chronic ?? 0}</span><label>Chronic (Problem)</label></div>
            <div className="intel-inc-stat" style={{ "--is-c": "#ef4444" }}><span>{dStats.recurring ?? 0}</span><label>Recurring</label></div>
          </div>

          {/* Policy transparency — why N of M would actually get a ticket */}
          {detectData?.policy && (
            <div style={{ fontSize: 11.5, opacity: .8, margin: "-4px 0 14px" }}>
              Auto-ticket policy: severity ≤ <strong>{detectData.policy.autoSeverityFloor}</strong> ·
              conditions older than <strong>{detectData.policy.chronicHours}h</strong> when first seen are treated as
              chronic <em>Problem</em> candidates, not new incidents ·
              rate limit <strong>{sessData?.ticketBudget?.limit ?? "—"}/hour</strong>
              {sessData?.ticketBudget && ` (${sessData.ticketBudget.usedLastHour} used)`}
              {" · queue "}
              <strong>{incSettings?.assignmentGroup || "ServiceNow default routing"}</strong>
              {" · "}
              <button onClick={openIncSettings}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#38bdf8", font: "inherit", textDecoration: "underline" }}>
                change
              </button>
            </div>
          )}

          {/* Actionable / chronic split — chronic entries are Problem candidates */}
          <div className="intel-sev-pills" style={{ marginBottom: 10 }}>
            {[
              { k: "actionable", label: `Actionable (${detected.filter((d) => !d.chronic).length})` },
              { k: "chronic", label: `Chronic → Problem (${detected.filter((d) => d.chronic).length})` },
              { k: "all", label: `All (${detected.length})` },
            ].map((p) => (
              <button key={p.k} className={"intel-sev-pill" + (detectFilter === p.k ? " active" : "")}
                onClick={() => setDetectFilter(p.k)}>{p.label}</button>
            ))}
          </div>

          <div className="intel-card-list">
            {detectLoading && detected.length === 0 && <div className="intel-empty">Evaluating thresholds…</div>}
            {!detectLoading && detected.length === 0 && !detectData?.disabled && (
              <div className="intel-empty">No threshold breaches sustained past their dwell time. Nothing would have been ticketed.</div>
            )}
            {!detectLoading && detected.length > 0 && visibleDetections.length === 0 && (
              <div className="intel-empty">
                {detectFilter === "actionable"
                  ? `No actionable detections — all ${detected.length} are chronic (long-standing) and are treated as Problem candidates.`
                  : "None in this category."}
              </div>
            )}
            {visibleDetections.map((inc) => {
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
                            {inc.correlation === "node-cascade" ? "node cascade"
                              : inc.correlation === "causal-merge" ? "merged — 1 ticket"
                              : "grouped"} · {inc.symptomCount} symptoms
                          </span>
                        )}
                        {/* Badge discipline: cards were carrying eight or more chips
                            at once, leaving the eye no entry point. Show the most
                            decision-relevant few; collapse the rest behind "+N". */}
                        {(() => {
                          const badges = [
                            inc.escalated && { k: "escalated", el: <span className="intel-card-kind-badge" style={{ background: "rgba(220,38,38,.25)", color: "#fca5a5" }} title={inc.escalationReason || ""}>⚠ escalated {inc.occurrences}×</span> },
                            inc.activityOverride && { k: "old but active", el: <span className="intel-card-kind-badge" style={{ background: "rgba(239,68,68,.18)", color: "#fca5a5" }} title={inc.activityReason || ""}>old but ACTIVE</span> },
                            inc.chronic && { k: "chronic", el: <span className="intel-card-kind-badge" style={{ background: "rgba(100,116,139,.25)", color: "#cbd5e1" }} title={inc.chronicReason || ""}>chronic → Problem</span> },
                            inc.recurring && { k: "recurring", el: <span className="intel-card-count">{inc.occurrences}× recurring</span> },
                          ].filter(Boolean);
                          const cap = focused ? 2 : badges.length;
                          const shown = badges.slice(0, cap);
                          const hidden = badges.length - shown.length;
                          return (<>
                            {shown.map((b) => <span key={b.k}>{b.el}</span>)}
                            {hidden > 0 && (
                              <span className="intel-card-kind-badge"
                                style={{ background: "rgba(100,116,139,.2)", color: "#94a3b8" }}
                                title={badges.slice(cap).map((b) => b.k).join(" · ")}>＋{hidden}</span>
                            )}
                          </>);
                        })()}
                      </div>

                      <div className="intel-card-msg">
                        Fired <strong>{inc.rule}</strong>
                        {inc.dwellMinutes != null && <> after <strong>{inc.dwellHuman || `${inc.dwellMinutes}m`}</strong> (threshold {inc.threshold?.dwellMinutes ?? 0}m)</>}
                        {inc.thresholdStandard && <> · standard: <code>{inc.thresholdStandard}</code></>}
                        {/* Which container actually failed — essential for 1/2 pods */}
                        {inc.containers?.length > 0 && (
                          <> · container{inc.containers.length > 1 ? "s" : ""}: <strong>{inc.containers.join(", ")}</strong></>
                        )}
                        {inc.signals?.length > 1 && (
                          <div style={{ marginTop: 3 }}>
                            Signals merged into this one incident: <strong>{inc.signals.join(" → ")}</strong>
                          </div>
                        )}
                      </div>

                      {/* Live restart activity — catches flapping containers that
                          are Running at the moment of the scan */}
                      {inc.restartRate && (
                        <div style={{
                          marginTop: 5, display: "inline-block", padding: "2px 8px", borderRadius: 999,
                          fontSize: 11, background: "rgba(239,68,68,.15)", color: "#fca5a5",
                          border: "1px solid rgba(239,68,68,.35)",
                        }}>
                          ⟳ actively restarting — {inc.restartRate.gained}× in the last {inc.restartRate.windowMinutes}m
                          {inc.restartRate.total != null && <span style={{ opacity: .8 }}> (total {inc.restartRate.total})</span>}
                        </div>
                      )}

                      {/* Rationale matters but is not scannable — behind a
                          disclosure in the focused layout, inline in classic. */}
                      {(inc.chronicReason || inc.escalationReason || inc.activityReason) && (focused ? (
                        <details style={{ marginTop: 5 }}>
                          <summary style={{ cursor: "pointer", fontSize: 11.5, opacity: .8 }}>Why this classification</summary>
                          <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 3 }}>
                            {inc.escalationReason && <div style={{ fontSize: 11.5, color: "#fca5a5" }}>{inc.escalationReason}</div>}
                            {inc.activityReason && <div style={{ fontSize: 11.5, color: "#fca5a5" }}>{inc.activityReason}</div>}
                            {inc.chronicReason && <div style={{ fontSize: 11.5, color: "#cbd5e1" }}>{inc.chronicReason}</div>}
                          </div>
                        </details>
                      ) : (<>
                        {inc.chronicReason && <div style={{ marginTop: 5, fontSize: 11.5, color: "#cbd5e1", opacity: .9 }}>{inc.chronicReason}</div>}
                        {inc.escalationReason && <div style={{ marginTop: 5, fontSize: 11.5, color: "#fca5a5" }}>{inc.escalationReason}</div>}
                        {inc.activityReason && <div style={{ marginTop: 5, fontSize: 11.5, color: "#fca5a5" }}>{inc.activityReason}</div>}
                      </>))}

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
                        <span style={{ color: inc.autoTicketEligible ? "#f59e0b" : "#64748b" }}>
                          {inc.autoTicketEligible
                            ? "eligible for auto-ticket"
                            : inc.autoTicketBlockedBy === "chronic"
                              ? "chronic — manual only"
                              : `below ${detectData?.policy?.autoSeverityFloor || "severity floor"}`}
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
          </>}

          {/* ── HISTORY — what we changed, and how to undo it ── */}
          {showSub("history") && changeData?.changes?.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div className="intel-section-title" style={{ marginBottom: 8 }}>
                <div>
                  <h3 style={{ fontSize: 14 }}>
                    History — applied changes
                    {changeData.stats?.revertable > 0 && (
                      <span style={{ marginLeft: 8, padding: "2px 8px", borderRadius: 999, fontSize: 11,
                        background: "rgba(14,165,233,.2)", color: "#38bdf8", border: "1px solid rgba(14,165,233,.45)" }}>
                        {changeData.stats.revertable} revertable
                      </span>
                    )}
                  </h3>
                  <p style={{ fontSize: 11.5 }}>
                    Every cluster change this platform applied, with the inverse recorded at apply time.
                    Reverting runs the same dry-run → apply → verify path as the original fix.
                    {changeData.stats?.reverted > 0 && ` · ${changeData.stats.reverted} already reverted`}
                  </p>
                </div>
              </div>

              <div className="intel-card-list">
                {changeData.changes.map((c) => {
                  const bk = `rev-${c.id}`;
                  const isRevert = !!c.revertOf;
                  const done = !!c.revertedAt;
                  return (
                    <div key={c.id} className="intel-card"
                      style={{ "--card-sev": done ? "#64748b" : isRevert ? "#0891b2" : "#22c55e", opacity: done ? .75 : 1 }}>
                      <div className="intel-card-head">
                        <div className="intel-card-body">
                          <div className="intel-card-row1">
                            <span className="intel-card-title">
                              <code>{c.action}</code> · {c.namespace}/{c.resourceName}
                              {c.container && <span style={{ opacity: .8 }}> · container {c.container}</span>}
                            </span>
                            {c.incidentNumber && <span className="intel-card-source">{c.incidentNumber}</span>}
                            {isRevert && (
                              <span className="intel-card-kind-badge" style={{ background: "rgba(8,145,178,.2)", color: "#67e8f9" }}>
                                revert
                              </span>
                            )}
                            {done && (
                              <span className="intel-card-kind-badge" style={{ background: "rgba(100,116,139,.25)", color: "#cbd5e1" }}>
                                reverted {timeAgo(c.revertedAt)}{c.revertedBy ? ` by ${c.revertedBy}` : ""}
                              </span>
                            )}
                            {!done && !c.revertable && (
                              <span className="intel-card-kind-badge" style={{ background: "rgba(100,116,139,.2)", color: "#94a3b8" }}
                                title={c.revertReason || ""}>not revertable</span>
                            )}
                          </div>

                          {/* what actually changed */}
                          {(c.beforeValue || c.afterValue) && (
                            <div style={{ marginTop: 5, fontSize: 12, fontFamily: "var(--font-mono, monospace)" }}>
                              {Object.keys(c.afterValue || c.beforeValue || {}).map((k) => (
                                <div key={k}>
                                  <span style={{ opacity: .7 }}>{k}: </span>
                                  <span style={{ color: "#fca5a5" }}>{String(c.beforeValue?.[k] ?? "—")}</span>
                                  <span style={{ opacity: .6 }}> → </span>
                                  <span style={{ color: "#4ade80" }}>{String(c.afterValue?.[k] ?? "—")}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          <div style={{ marginTop: 5, fontSize: 11.5, fontFamily: "var(--font-mono, monospace)", opacity: .85, wordBreak: "break-all" }}>
                            $ {c.command}
                          </div>

                          {!done && !c.revertable && c.revertReason && (
                            <div style={{ marginTop: 5, fontSize: 11.5, color: "#94a3b8" }}>
                              {c.revertReason}
                              {c.nativeUndo && (
                                <div style={{ marginTop: 3, color: "#67e8f9", fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>
                                  $ {c.nativeUndo}
                                  <span style={{ color: "#94a3b8", fontFamily: "inherit" }}>
                                    {" "}— restores the whole previous pod template, so unrelated changes since would also be undone.
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          {revertPreview[c.id] && (
                            <pre style={{
                              marginTop: 7, marginBottom: 0, padding: "8px 10px", borderRadius: 7, fontSize: 11,
                              background: "#0b1220", color: "#7dd3fc", border: "1px solid rgba(148,163,184,.25)",
                              whiteSpace: "pre-wrap", wordBreak: "break-word",
                            }}>{revertPreview[c.id]}</pre>
                          )}

                          <div className="intel-card-meta">
                            <span>applied {timeAgo(c.appliedAt)}</span>
                            {c.approvedBy && <span>by {c.approvedBy}</span>}
                            {c.risk && <span>risk {c.risk}</span>}
                            <span style={{ color: c.verification?.ok ? "#4ade80" : "#fbbf24" }}>
                              {c.verification?.ok ? "verified" : "not verified"}
                            </span>
                          </div>
                        </div>

                        <div className="intel-card-actions" style={{ gap: 6, flexWrap: "wrap" }}>
                          {!done && c.revertable && (
                            <>
                              <button className="intel-card-btn" disabled={!!busySession[bk]}
                                title="Preview the revert against the live API server — nothing is modified"
                                onClick={() => revertChange(c.id, { dryRun: true })}>
                                {busySession[bk] ? "…" : "▷ Dry-run revert"}
                              </button>
                              <button className="intel-card-btn" disabled={!!busySession[bk]}
                                style={{ borderColor: "#f59e0b", color: "#fbbf24" }}
                                title="Undo exactly this change, then verify — recorded as its own ledger entry"
                                onClick={() => revertChange(c.id, { dryRun: false })}>
                                ↩ Revert
                              </button>
                            </>
                          )}
                          {/* No exact inverse, but Kubernetes can still roll the
                              Deployment back to its previous revision. */}
                          {!done && !c.revertable && c.nativeUndo && (
                            <>
                              <button className="intel-card-btn" disabled={!!busySession[bk]}
                                title={`Preview: ${c.nativeUndo}`}
                                onClick={() => revertChange(c.id, { dryRun: true, useNativeUndo: true })}>
                                {busySession[bk] ? "…" : "▷ Dry-run rollout undo"}
                              </button>
                              <button className="intel-card-btn" disabled={!!busySession[bk]}
                                style={{ borderColor: "#0891b2", color: "#67e8f9" }}
                                title="Roll the Deployment back to its previous revision. This restores the ENTIRE prior pod template, so any unrelated change made since will also be undone."
                                onClick={() => revertChange(c.id, { dryRun: false, useNativeUndo: true })}>
                                ↩ Rollout undo
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Active threshold policy — tuning transparency */}
          {showSub("policy") && detectData?.thresholds && (
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

      {/* SOP Runner — compile a runbook into a validated, dry-run plan.
          This previously sat OUTSIDE every activeTab guard, so it rendered at the
          bottom of all eight tabs. It is a deliberate authoring tool, not triage
          furniture, so it now lives only in Team Playbook (reachable via More). */}
      {activeTab === "playbook" && <SopRunner />}
    </div>
  );
}
