import { useState, useCallback } from "react";
import { useClusterQuery, REFRESH } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";
import { showToast } from "../../store/toastStore";

function clusterUrl(path, cluster) {
  if (!cluster || cluster === "local") return path;
  return `${path}${path.includes("?") ? "&" : "?"}cluster=${encodeURIComponent(cluster)}`;
}

const gradeColor = (g) => {
  if (g === "A") return "#22c55e";
  if (g === "B") return "#3b82f6";
  if (g === "C") return "#f59e0b";
  if (g === "D") return "#f97316";
  return "#ef4444";
};

const cvssColor = (v) => {
  if (v >= 9) return "#ef4444";
  if (v >= 7) return "#f97316";
  if (v >= 4) return "#f59e0b";
  return "#22c55e";
};

const sevColor = (s) => {
  if (s === "critical") return "#ef4444";
  if (s === "high") return "#f97316";
  if (s === "medium") return "#f59e0b";
  return "#22c55e";
};

const filterColor = (f) => {
  if (f === "exploitable") return "#dc2626";
  if (f === "critical") return "#ef4444";
  if (f === "high") return "#f97316";
  if (f === "medium") return "#3b82f6";
  return "#22c55e";
};

// Does an image have any finding matching the active filter?
const imgMatchesFilter = (img, filter) => {
  if (!filter) return true;
  if (filter === "exploitable") return (img.exploitable || 0) > 0;
  return (img[filter] || 0) > 0;
};

// Filter an image's CVE list to the active severity / exploitable filter
const filterVulns = (vulns, filter) => {
  if (!filter) return vulns;
  if (filter === "exploitable") return vulns.filter((v) => v.exploitable);
  return vulns.filter((v) => (v.severity || "").toLowerCase() === filter);
};

const frameworkIcon = (fw) => {
  const map = { "NIST NVD": "N", "CIS": "C", "OWASP": "O", "SOC2": "S", "PCI-DSS": "P" };
  for (const [k, v] of Object.entries(map)) if ((fw || "").includes(k)) return v;
  return "AI";
};

export function ImageVulnsWidget() {
  const cluster = useActiveCluster();
  const { data, isLoading, isError, error, refetch } = useClusterQuery(
    "/api/dashboard/image-vulns",
    { refetchInterval: REFRESH.SCAN }
  );
  const [scanning, setScanning] = useState(false);
  const [expandedImg, setExpandedImg] = useState(null);
  const [sevFilter, setSevFilter] = useState(null); // null | critical | high | medium | low | exploitable
  const [aiFix, setAiFix] = useState({}); // { [imageKey]: { loading, data, error } }
  const [remediate, setRemediate] = useState({}); // { [imageKey]: { phase, dryRun, result, error } }
  const [aiFindings, setAiFindings] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiProvider, setAiProvider] = useState(null);
  const [expandedAi, setExpandedAi] = useState(null);

  const toggleFilter = useCallback((key) => {
    setSevFilter((prev) => (prev === key ? null : key));
    setExpandedImg(null);
  }, []);

  const handleAiFix = useCallback(async (img) => {
    const key = img.fullImage || img.image;
    setAiFix((p) => ({ ...p, [key]: { loading: true } }));
    try {
      const res = await fetch(clusterUrl("/api/ai/image-remediation", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: img.fullImage || img.image,
          namespace: img.namespace,
          deployment: (img.pods && img.pods[0]?.pod) ? img.pods[0].pod.replace(/-[a-f0-9]+(-[a-z0-9]+)?$/, "") : "",
          vulnerabilities: img.vulnerabilities || [],
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Remediation failed");
      setAiFix((p) => ({ ...p, [key]: { loading: false, data } }));
      showToast("AI remediation ready", "ok");
    } catch (err) {
      setAiFix((p) => ({ ...p, [key]: { loading: false, error: err.message } }));
      showToast("AI fix failed: " + err.message, "err");
    }
  }, [cluster]);

  const copyCmd = useCallback((cmd) => {
    try { navigator.clipboard?.writeText(cmd); showToast("Command copied", "ok"); } catch { /* ignore */ }
  }, []);

  const runRemediation = useCallback(async (img, dryRun) => {
    const key = img.fullImage || img.image;
    const fixData = (aiFix[key] || {}).data;
    const newImage = fixData?.recommendedImage;
    if (!newImage || /[<>]/.test(newImage)) {
      showToast("Run AI Fix first to get a concrete target image", "err");
      return;
    }
    setRemediate((p) => ({ ...p, [key]: { phase: dryRun ? "dry-running" : "applying", dryRun } }));
    try {
      const res = await fetch(clusterUrl("/api/security/remediate-image", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: img.fullImage || img.image,
          namespace: img.namespace,
          deployment: (img.workload?.name) || ((img.pods && img.pods[0]?.pod) ? img.pods[0].pod.replace(/-[a-f0-9]+(-[a-z0-9]+)?$/, "") : ""),
          container: img.pods && img.pods[0]?.container,
          newImage,
          dryRun,
          exploitable: img.exploitable || 0,
          before: { critical: img.critical || 0, high: img.high || 0, medium: img.medium || 0, low: img.low || 0, total: img.total || 0 },
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || "Remediation failed");
      setRemediate((p) => ({ ...p, [key]: { phase: dryRun ? "dry-done" : "applied", dryRun, result: data } }));
      showToast(dryRun ? "Dry run complete" : `Applied${data.changeRequest?.number ? " · " + data.changeRequest.number : ""}`, "ok");
    } catch (err) {
      setRemediate((p) => ({ ...p, [key]: { phase: "failed", dryRun, error: err.message } }));
      showToast("Remediation failed: " + err.message, "err");
    }
  }, [cluster, aiFix]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch(clusterUrl("/api/dashboard/image-vulns?rescan=true", cluster));
      await res.json();
      showToast("Image scan complete", "ok");
      refetch();
    } catch (err) {
      showToast("Scan failed: " + err.message, "err");
    } finally {
      setScanning(false);
    }
  }, [cluster, refetch]);

  const handleAiAnalysis = useCallback(async () => {
    setAiLoading(true);
    setAiFindings(null);
    try {
      const res = await fetch(clusterUrl("/api/ai/image-vuln-analysis", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json().catch(() => ({ findings: [], error: "Empty response from server" }));
      if (!res.ok) throw new Error(json.error || "Analysis failed");
      if (json.error && (!json.findings || json.findings.length === 0)) throw new Error(json.error);
      setAiFindings(json.findings || []);
      setAiProvider(json.provider || null);
      showToast(`AI analysis complete — ${(json.findings || []).length} findings`, "ok");
    } catch (err) {
      showToast("AI analysis failed: " + err.message, "err");
    } finally {
      setAiLoading(false);
    }
  }, [cluster]);

  if (isLoading) {
    return (
      <div className="ivs">
        <div className="ivs-header"><h3>Image Vulnerability Scanner</h3></div>
        <div className="ivs-loading">Scanning images…</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="ivs">
        <div className="ivs-header"><h3>Image Vulnerability Scanner</h3></div>
        <div className="ivs-error">{String(error?.message)}</div>
      </div>
    );
  }

  if (!data || data.available === false) {
    return (
      <div className="ivs">
        <div className="ivs-header"><h3>Image Vulnerability Scanner</h3></div>
        <div className="ivs-unavailable">{data?.message || "Not installed on this cluster"}</div>
      </div>
    );
  }

  const d = data;
  const gc = gradeColor(d.grade);
  const total = d.totalVulns || 0;
  const score = d.riskScore ?? 0;
  const ring = total > 0 ? Math.max(5, Math.min(100, score)) : 0;
  const circumference = 2 * Math.PI * 27;
  const offset = circumference - (ring / 100) * circumference;
  const comp = d.compliance || {};
  const age = d.ageSummary || {};
  const ageTotal = (age.fresh || 0) + (age.aging || 0) + (age.stale || 0) || 1;
  const fixPct = total > 0 ? Math.round(((d.fixable || 0) / total) * 100) : 0;
  // Scanner mode — distinguishes a real dynamic CVE feed from static heuristics
  const SCANNER_MODES = {
    "trivy-operator": { label: "Live CVE · Trivy", live: true, tip: "Dynamic CVE scanning via Trivy Operator (NVD + GHSA + OS vendor feeds). Works on OpenShift, EKS, AKS, GKE." },
    "quay-cso": { label: "Live CVE · Quay/Clair", live: true, tip: "Dynamic CVE scanning via Red Hat Quay Container Security Operator (Clair)." },
    "openshift-image-api": { label: "OCP Image API", live: false, tip: "OpenShift image metadata source." },
    "static-analysis": { label: "Static Analysis", live: false, tip: "Heuristic image-hygiene checks (CIS 5.5.1/5.5.2, registry trust). Install Trivy Operator for live CVE scanning." },
  };
  const scannerMode = SCANNER_MODES[d.scannerType] || SCANNER_MODES["static-analysis"];
  const scannerLabel = scannerMode.label;

  return (
    <div className="ivs">
      {/* Header */}
      <div className="ivs-header">
        <h3>Image Vulnerability Scanner</h3>
        <div className="ivs-header-actions">
          <span
            className={"ivs-scanner-badge" + (scannerMode.live ? " ivs-scanner-live" : " ivs-scanner-static")}
            title={scannerMode.tip}
          >
            {scannerMode.live && <span className="ivs-scanner-dot" />}
            {scannerLabel}
          </span>
          <button className="ivs-ai-btn" onClick={handleAiAnalysis} disabled={aiLoading}>
            {aiLoading ? "Analyzing…" : "AI Security Analysis"}
          </button>
          <button className="ivs-scan-btn" onClick={handleScan} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan"}
          </button>
        </div>
      </div>

      {/* Hero Row: posture ring + grade + reason + key metrics */}
      <div className="ivs-hero2">
        <div className="ivs-hero2-score">
          <div className="ivs-donut">
            <svg viewBox="0 0 64 64" width="72" height="72">
              <circle cx="32" cy="32" r="27" fill="none" stroke="var(--border)" strokeWidth="6" />
              <circle
                cx="32" cy="32" r="27" fill="none"
                stroke={gc} strokeWidth="6" strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                style={{ transform: "rotate(-90deg)", transformOrigin: "center", transition: "stroke-dashoffset .8s ease" }}
              />
            </svg>
            <div className="ivs-donut-inner">
              <div className="ivs-donut-score" style={{ color: gc }}>{score}</div>
              <div className="ivs-donut-of">/100</div>
            </div>
          </div>
          <div className="ivs-hero2-gradewrap">
            <div className="ivs-grade-pill" style={{ background: gc + "18", color: gc, borderColor: gc }}>{d.grade || "?"}</div>
            <div className="ivs-grade-label">Security Posture</div>
          </div>
        </div>
        <div className="ivs-hero2-detail">
          <div className="ivs-hero2-reason" style={{ borderColor: gc + "55" }}>
            <span className="ivs-hero2-reason-icon" style={{ color: gc }}>●</span>
            {d.scoreReason || `${total} findings across ${d.totalImages || 0} images`}
          </div>
          <div className="ivs-hero2-meta">
            {d.totalImages || 0} images scanned · {total} findings · Max CVSS{" "}
            <strong style={{ color: cvssColor(d.maxCVSS || 0) }}>{(d.maxCVSS || 0).toFixed(1)}</strong>
            {" · "}<strong style={{ color: "var(--accent3, #06b6d4)" }}>{d.fixable || 0}</strong> fixable
            {" · scanned "}{d.timestamp ? relTime(d.timestamp) : "--"}
          </div>
        </div>
      </div>

      {/* Severity + Exploitable Cards — click to filter */}
      <div className="ivs-severity-row ivs-severity-row5">
        {(d.exploitable || 0) > 0 && (
          <button
            type="button"
            className={"ivs-sev-card ivs-sev-card-kev" + (sevFilter === "exploitable" ? " active" : "")}
            style={{ "--sev-color": "#dc2626" }}
            onClick={() => toggleFilter("exploitable")}
            title="Filter to actively-exploited findings"
          >
            <div className="ivs-sev-val">{d.exploitable}</div>
            <div className="ivs-sev-label">🔴 Exploitable</div>
          </button>
        )}
        {[
          { key: "critical", color: "var(--crit)", val: d.critical || 0 },
          { key: "high", color: "var(--warn)", val: d.high || 0 },
          { key: "medium", color: "#3b82f6", val: d.medium || 0 },
          { key: "low", color: "var(--ok)", val: d.low || 0 },
        ].map((s) => (
          <button
            type="button"
            key={s.key}
            className={"ivs-sev-card" + (sevFilter === s.key ? " active" : "") + (s.val === 0 ? " ivs-sev-empty" : "")}
            style={{ "--sev-color": s.color }}
            onClick={() => s.val > 0 && toggleFilter(s.key)}
            title={s.val > 0 ? `Filter to ${s.key} findings` : `No ${s.key} findings`}
          >
            <div className="ivs-sev-val">{s.val}</div>
            <div className="ivs-sev-label">{s.key}</div>
          </button>
        ))}
      </div>

      {/* Active filter banner */}
      {sevFilter && (
        <div className="ivs-filter-banner">
          <span className="ivs-filter-banner-dot" style={{ background: filterColor(sevFilter) }} />
          Showing <strong>{sevFilter === "exploitable" ? "actively-exploited" : sevFilter}</strong> findings only
          <button type="button" className="ivs-filter-clear" onClick={() => setSevFilter(null)}>Clear ✕</button>
        </div>
      )}

      {/* Fixable Progress (labeled) */}
      <div className="ivs-fixwrap">
        <div className="ivs-fixwrap-head">
          <span>Remediable Findings</span>
          <span className="ivs-fixwrap-pct"><strong>{fixPct}%</strong> fixable now ({d.fixable || 0}/{total})</span>
        </div>
        <div className="ivs-progress-track">
          <div className="ivs-progress-bar" style={{ width: `${fixPct}%` }} />
        </div>
      </div>

      {/* Compliance Badges */}
      <div className="ivs-compliance-row">
        <ComplianceBadge icon="shield" color="var(--accent3, #06b6d4)" count={comp.signed || 0} total={comp.total || 0} label="signed" />
        <ComplianceBadge icon="doc" color="#8b5cf6" count={comp.sbom || 0} total={comp.total || 0} label="SBOM" />
        <ComplianceBadge icon="lock" color="var(--warn)" count={comp.pinned || 0} total={comp.total || 0} label="pinned" />
        <ComplianceBadge icon="check" color="var(--ok)" count={comp.trusted || 0} total={comp.total || 0} label="trusted" />
      </div>

      {/* Image Freshness */}
      <div className="ivs-freshness">
        <div className="ivs-freshness-header">
          <span>Image Freshness</span>
          <span className="ivs-freshness-counts">
            <span style={{ color: "var(--ok)" }}>{age.fresh || 0} fresh</span>
            {" / "}
            <span style={{ color: "var(--warn)" }}>{age.aging || 0} aging</span>
            {" / "}
            <span style={{ color: "var(--crit)" }}>{age.stale || 0} stale</span>
          </span>
        </div>
        <div className="ivs-freshness-track">
          <div className="ivs-fresh-bar" style={{ width: `${((age.fresh || 0) / ageTotal) * 100}%`, background: "var(--ok)" }} />
          <div className="ivs-fresh-bar" style={{ width: `${((age.aging || 0) / ageTotal) * 100}%`, background: "var(--warn)" }} />
          <div className="ivs-fresh-bar" style={{ width: `${((age.stale || 0) / ageTotal) * 100}%`, background: "var(--crit)" }} />
        </div>
      </div>

      {/* Top Images */}
      {(d.topImages || []).length > 0 && (() => {
        const visibleImages = (d.topImages || []).filter((img) => imgMatchesFilter(img, sevFilter)).slice(0, 12);
        return (
        <div className="ivs-images">
          <div className="ivs-images-title">
            Top Vulnerable Images
            <span className="ivs-images-subtitle">
              {sevFilter ? `${visibleImages.length} image(s) with ${sevFilter} findings` : "click a row for CVE detail & remediation"}
            </span>
          </div>
          <div className="ivs-img-table-head">
            <span>Image</span>
            <span>Namespace</span>
            <span className="ivs-col-c">Severity</span>
            <span className="ivs-col-c">Max CVSS</span>
            <span className="ivs-col-c">Fixable</span>
            <span className="ivs-col-c">Age</span>
          </div>
          <div className="ivs-images-list">
            {visibleImages.length === 0 && (
              <div className="ivs-muted" style={{ padding: "10px 4px" }}>No images match this filter.</div>
            )}
            {visibleImages.map((img, i) => {
              const ageChip = img.age?.label || img.age?.status || (typeof img.age === "string" ? img.age : null);
              return (
              <div key={i} className={"ivs-img-row" + (expandedImg === i ? " expanded" : "")}>
                <div className="ivs-img-summary2" onClick={() => setExpandedImg(expandedImg === i ? null : i)}>
                  <span className="ivs-img-name" title={img.fullImage || img.image}>
                    <span className="ivs-img-chevron">{expandedImg === i ? "▾" : "▸"}</span>
                    {img.image}
                    {(img.exploitable || 0) > 0 && <span className="ivs-img-kev" title="Contains actively-exploited (KEV) CVEs">KEV</span>}
                  </span>
                  <span className="ivs-img-ns">{img.namespace || "—"}</span>
                  <span className="ivs-img-sevs ivs-col-c">
                    {img.critical > 0 && <span className="ivs-img-sev crit" title={`${img.critical} Critical`}>{img.critical} C</span>}
                    {img.high > 0 && <span className="ivs-img-sev high" title={`${img.high} High`}>{img.high} H</span>}
                    {img.medium > 0 && <span className="ivs-img-sev med" title={`${img.medium} Medium`}>{img.medium} M</span>}
                    {img.low > 0 && <span className="ivs-img-sev low" title={`${img.low} Low`}>{img.low} L</span>}
                    {!img.critical && !img.high && !img.medium && !img.low && <span className="ivs-muted">—</span>}
                  </span>
                  <span className="ivs-img-cvss ivs-col-c" style={{ color: cvssColor(img.maxCVSS || 0) }}>
                    {(img.maxCVSS || 0).toFixed(1)}
                  </span>
                  <span className="ivs-col-c ivs-img-fixable">{img.fixable || 0}/{img.total || 0}</span>
                  <span className="ivs-col-c">{ageChip ? <span className="ivs-age-chip">{ageChip}</span> : <span className="ivs-muted">—</span>}</span>
                </div>
                {expandedImg === i && (() => {
                  const shownVulns = filterVulns(img.vulnerabilities || [], sevFilter).slice(0, 20);
                  const fixKey = img.fullImage || img.image;
                  const fixState = aiFix[fixKey] || {};
                  return (
                  <div className="ivs-img-detail">
                    {/* Quick heuristic remediation + AI Fix action */}
                    <div className="ivs-img-reco">
                      <span className="ivs-img-reco-icon">✨</span>
                      <span style={{ flex: 1 }}>
                        <strong>Remediation:</strong> {img.recommendedFix || "Review CVEs below and upgrade to a patched image."}
                      </span>
                      <button
                        type="button"
                        className="ivs-aifix-btn"
                        onClick={(e) => { e.stopPropagation(); handleAiFix(img); }}
                        disabled={fixState.loading}
                      >
                        {fixState.loading ? "Generating…" : "🪄 AI Fix"}
                      </button>
                    </div>

                    {/* AI-generated remediation plan */}
                    {fixState.data && (
                      <div className="ivs-aifix-panel">
                        <div className="ivs-aifix-head">
                          <span className="ivs-aifix-badge">AI Remediation Plan</span>
                          <span className="ivs-aifix-meta">
                            fixes {fixState.data.fixesCount ?? "?"}/{fixState.data.totalCount ?? (img.vulnerabilities || []).length} · {fixState.data.provider || "AI"}
                          </span>
                        </div>
                        {fixState.data.rationale && <p className="ivs-aifix-rationale">{fixState.data.rationale}</p>}
                        {fixState.data.recommendedImage && (
                          <div className="ivs-aifix-row">
                            <span className="ivs-aifix-lbl">Use image</span>
                            <code className="ivs-ver-new">{fixState.data.recommendedImage}</code>
                          </div>
                        )}
                        {fixState.data.command && (
                          <div className="ivs-aifix-cmd">
                            <code>{fixState.data.command}</code>
                            <button type="button" className="ivs-aifix-copy" onClick={(e) => { e.stopPropagation(); copyCmd(fixState.data.command); }}>Copy</button>
                          </div>
                        )}
                        {Array.isArray(fixState.data.steps) && fixState.data.steps.length > 0 && (
                          <ol className="ivs-aifix-steps">
                            {fixState.data.steps.map((st, si) => <li key={si}>{st}</li>)}
                          </ol>
                        )}
                        {fixState.data.dockerfilePatch && (
                          <pre className="ivs-aifix-docker">{fixState.data.dockerfilePatch}</pre>
                        )}

                        {/* End-to-end remediation: Dry Run → Apply & Raise CR */}
                        {(() => {
                          const rem = remediate[fixKey] || {};
                          const concreteTarget = fixState.data.recommendedImage && !/[<>]/.test(fixState.data.recommendedImage);
                          const busy = rem.phase === "dry-running" || rem.phase === "applying";
                          return (
                            <>
                              <div className="ivs-remediate-actions">
                                <button type="button" className="ivs-rem-dry" disabled={busy || !concreteTarget}
                                  onClick={(e) => { e.stopPropagation(); runRemediation(img, true); }}>
                                  {rem.phase === "dry-running" ? "Previewing…" : "▷ Dry Run"}
                                </button>
                                <button type="button" className="ivs-rem-apply" disabled={busy || !concreteTarget}
                                  onClick={(e) => { e.stopPropagation(); if (window.confirm(`Apply fix to ${img.image}?\n\nThis patches the deployment image on the cluster and raises a ServiceNow Change Request.`)) runRemediation(img, false); }}>
                                  {rem.phase === "applying" ? "Applying…" : "▶ Apply & Raise CR"}
                                </button>
                                {!concreteTarget && <span className="ivs-rem-hint">AI returned a placeholder tag — not auto-appliable</span>}
                              </div>

                              {/* Dry run preview */}
                              {rem.phase === "dry-done" && rem.result && (
                                <div className="ivs-rem-result dry">
                                  <div className="ivs-rem-result-head">▷ Dry Run — preview only, nothing changed</div>
                                  <div className="ivs-rem-line">{rem.result.target} · container <code>{rem.result.container}</code></div>
                                  <div className="ivs-rem-line"><code className="ivs-ver-old">{rem.result.oldImage}</code> → <code className="ivs-ver-new">{rem.result.newImage}</code></div>
                                  {rem.result.willRaiseChangeRequest && <div className="ivs-rem-line">✓ Will raise a ServiceNow Change Request on Apply</div>}
                                  {rem.result.willRaiseIncident && <div className="ivs-rem-line" style={{ color: "#dc2626" }}>⚠ Exploitable — will also raise an Incident</div>}
                                </div>
                              )}

                              {/* Applied result */}
                              {rem.phase === "applied" && rem.result && (
                                <div className="ivs-rem-result applied">
                                  <div className="ivs-rem-result-head ok">✓ Applied — image patched, rollout triggered</div>
                                  <div className="ivs-rem-line"><code className="ivs-ver-old">{rem.result.oldImage}</code> → <code className="ivs-ver-new">{rem.result.newImage}</code></div>
                                  {rem.result.changeRequest?.number && <div className="ivs-rem-line">📋 Change Request: <strong>{rem.result.changeRequest.number}</strong></div>}
                                  {rem.result.incident?.number && <div className="ivs-rem-line" style={{ color: "#dc2626" }}>🚨 Incident: <strong>{rem.result.incident.number}</strong></div>}
                                  <div className="ivs-rem-line">
                                    Findings: {rem.result.before?.high || 0}H/{rem.result.before?.medium || 0}M →{" "}
                                    {rem.result.after?.pending ? <em>re-scan pending</em> : `${rem.result.after?.high || 0}H/${rem.result.after?.medium || 0}M`}
                                  </div>
                                  <div className="ivs-rem-line ivs-muted">Backout: <code>{rem.result.backoutCommand}</code></div>
                                </div>
                              )}
                              {rem.phase === "failed" && <div className="ivs-aifix-err">Remediation failed: {rem.error}</div>}
                            </>
                          );
                        })()}
                      </div>
                    )}
                    {fixState.error && <div className="ivs-aifix-err">AI fix failed: {fixState.error}</div>}
                    {shownVulns.length > 0 ? (
                      <table className="ivs-vuln-table">
                        <thead>
                          <tr><th>CVSS</th><th>Severity</th><th>CVE</th><th>Package</th><th>Installed → Fixed</th></tr>
                        </thead>
                        <tbody>
                          {shownVulns.map((v, vi) => (
                            <tr key={vi} className={v.exploitable ? "ivs-vuln-kev" : ""}>
                              <td style={{ color: cvssColor(v.cvss || 0), fontWeight: 700 }}>{(v.cvss || 0).toFixed(1)}</td>
                              <td>
                                <span className={"ivs-sev-pill " + (v.severity || "").toLowerCase()}>{v.severity}</span>
                                {v.exploitable && <span className="ivs-vuln-kev-tag" title={v.kev ? "CISA KEV — actively exploited" : "CVSS ≥ 9.0"}>{v.kev ? "KEV" : "EXPLOIT"}</span>}
                              </td>
                              <td className="ivs-cve-id">
                                {v.link ? <a href={v.link} target="_blank" rel="noreferrer">{v.id}</a> : v.id}
                              </td>
                              <td>{v.package || "—"}</td>
                              <td>
                                {v.version ? <code className="ivs-ver-old">{v.version}</code> : <span className="ivs-muted">—</span>}
                                {v.fix ? <> → <code className="ivs-ver-new">{v.fix}</code></> : <span className="ivs-muted"> (no fix)</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="ivs-muted" style={{ padding: "8px 4px" }}>
                        {sevFilter ? `No ${sevFilter} CVEs in this image.` : "No detailed CVE data for this image."}
                      </div>
                    )}
                  </div>
                  );
                })()}
              </div>
            );})}
          </div>
        </div>
      );})()}

      {/* AI Security Analysis */}
      {aiLoading && (
        <div className="ivs-ai-loading">
          <div className="ivs-ai-spinner" />
          <span>AI is analyzing vulnerabilities against NIST NVD, CIS, OWASP benchmarks…</span>
        </div>
      )}

      {aiFindings && aiFindings.length > 0 && (
        <div className="ivs-ai-panel">
          <div className="ivs-ai-header">
            <div className="ivs-ai-header-left">
              <span className="ivs-ai-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22l-.75-12.07A4.001 4.001 0 0 1 12 2z"/><circle cx="12" cy="6" r="1" fill="#8b5cf6"/><path d="M5 10l2 2M19 10l-2 2M5 18h3M16 18h3"/></svg>
              </span>
              <h4>AI Security Analysis</h4>
              <span className="ivs-ai-count">{aiFindings.length} findings</span>
            </div>
            {aiProvider && <span className="ivs-ai-provider">{aiProvider}</span>}
          </div>
          <div className="ivs-ai-findings">
            {aiFindings.map((f, i) => (
              <div key={i} className={"ivs-ai-finding" + (expandedAi === i ? " expanded" : "")} style={{ "--ai-sev": sevColor(f.severity) }}>
                <div className="ivs-ai-finding-header" onClick={() => setExpandedAi(expandedAi === i ? null : i)}>
                  <span className="ivs-ai-sev-dot" />
                  <span className="ivs-ai-fw-badge">{frameworkIcon(f.framework)}</span>
                  <div className="ivs-ai-finding-title">
                    <div className="ivs-ai-title-text">{f.title}</div>
                    <div className="ivs-ai-title-meta">
                      <span className={"ivs-ai-sev-pill " + f.severity}>{f.severity}</span>
                      {f.category && <span className="ivs-ai-cat">{f.category}</span>}
                      {f.confidence && <span className="ivs-ai-conf">{Math.round(f.confidence * 100)}% conf</span>}
                    </div>
                  </div>
                  <span className="ivs-ai-chevron">{expandedAi === i ? "▲" : "▼"}</span>
                </div>
                {expandedAi === i && (
                  <div className="ivs-ai-finding-body">
                    {f.evidence && <div className="ivs-ai-section"><span className="ivs-ai-lbl">Evidence</span><p>{f.evidence}</p></div>}
                    {f.impact && <div className="ivs-ai-section"><span className="ivs-ai-lbl">Impact</span><p>{f.impact}</p></div>}
                    {f.action && <div className="ivs-ai-section ivs-ai-action"><span className="ivs-ai-lbl">Recommended Action</span><p>{f.action}</p></div>}
                    {f.framework && <div className="ivs-ai-framework-tag">{f.framework}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ComplianceBadge({ icon, color, count, total, label }) {
  const icons = {
    shield: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    doc: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
    lock: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
    check: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
  };
  return (
    <div className="ivs-badge" style={{ "--badge-color": color }}>
      {icons[icon]}
      <span className="ivs-badge-count">{count}/{total}</span>
      <span>{label}</span>
    </div>
  );
}

function relTime(iso) {
  if (!iso) return "--";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
