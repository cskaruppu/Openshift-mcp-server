import { useState, useCallback } from "react";
import { useClusterQuery } from "../../hooks/useClusterQuery";
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

const frameworkIcon = (fw) => {
  const map = { "NIST NVD": "N", "CIS": "C", "OWASP": "O", "SOC2": "S", "PCI-DSS": "P" };
  for (const [k, v] of Object.entries(map)) if ((fw || "").includes(k)) return v;
  return "AI";
};

export function ImageVulnsWidget() {
  const cluster = useActiveCluster();
  const { data, isLoading, isError, error, refetch } = useClusterQuery(
    "/api/dashboard/image-vulns",
    { refetchInterval: 60_000 }
  );
  const [scanning, setScanning] = useState(false);
  const [expandedImg, setExpandedImg] = useState(null);
  const [aiFindings, setAiFindings] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiProvider, setAiProvider] = useState(null);
  const [expandedAi, setExpandedAi] = useState(null);

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
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Analysis failed");
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
  const scannerLabel = d.scannerType === "quay-cso" ? "Quay CSO" : d.scannerType === "openshift-image-api" ? "OCP API" : "Static Analysis";

  return (
    <div className="ivs">
      {/* Header */}
      <div className="ivs-header">
        <h3>Image Vulnerability Scanner</h3>
        <div className="ivs-header-actions">
          <span className="ivs-scanner-badge">{scannerLabel}</span>
          <button className="ivs-ai-btn" onClick={handleAiAnalysis} disabled={aiLoading}>
            {aiLoading ? "Analyzing…" : "AI Security Analysis"}
          </button>
          <button className="ivs-scan-btn" onClick={handleScan} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan"}
          </button>
        </div>
      </div>

      {/* Hero Row: Donut + Grade + Findings */}
      <div className="ivs-hero">
        <div className="ivs-donut">
          <svg viewBox="0 0 64 64" width="64" height="64">
            <circle cx="32" cy="32" r="27" fill="none" stroke="var(--border)" strokeWidth="5" />
            <circle
              cx="32" cy="32" r="27" fill="none"
              stroke={gc} strokeWidth="5" strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              style={{ transform: "rotate(-90deg)", transformOrigin: "center", transition: "stroke-dashoffset .8s ease" }}
            />
          </svg>
          <div className="ivs-donut-score">{score}</div>
        </div>
        <div className="ivs-grade-info">
          <div className="ivs-grade-pill" style={{ background: gc + "18", color: gc, borderColor: gc }}>
            {d.grade || "?"}
          </div>
          <div className="ivs-grade-label">Security Grade</div>
          <div className="ivs-grade-meta">
            {d.totalImages || 0} images · {total} findings · scanned {d.timestamp ? relTime(d.timestamp) : "--"}
          </div>
        </div>
        <div className="ivs-findings-count">
          <div className="ivs-findings-num" style={{ color: total > 0 ? "var(--crit)" : "var(--ok)" }}>{total}</div>
          <div className="ivs-findings-label">Findings</div>
        </div>
      </div>

      {/* Severity Cards */}
      <div className="ivs-severity-row">
        {[
          { key: "critical", color: "var(--crit)", val: d.critical || 0 },
          { key: "high", color: "var(--warn)", val: d.high || 0 },
          { key: "medium", color: "#3b82f6", val: d.medium || 0 },
          { key: "low", color: "var(--ok)", val: d.low || 0 },
        ].map((s) => (
          <div key={s.key} className="ivs-sev-card" style={{ "--sev-color": s.color }}>
            <div className="ivs-sev-val">{s.val}</div>
            <div className="ivs-sev-label">{s.key}</div>
          </div>
        ))}
      </div>

      {/* Stats Row */}
      <div className="ivs-stats-row">
        <span>{d.totalImages || 0} images scanned</span>
        <span>Max CVSS: <strong style={{ color: cvssColor(d.maxCVSS || 0) }}>{(d.maxCVSS || 0).toFixed(1)}</strong></span>
        <span><strong style={{ color: "var(--accent3, #06b6d4)" }}>{d.fixable || 0}</strong> fixable</span>
      </div>

      {/* Fixable Progress */}
      <div className="ivs-progress-track">
        <div className="ivs-progress-bar" style={{ width: `${fixPct}%` }} />
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
      {(d.topImages || []).length > 0 && (
        <div className="ivs-images">
          <div className="ivs-images-title">Top Vulnerable Images</div>
          <div className="ivs-images-list">
            {(d.topImages || []).slice(0, 10).map((img, i) => (
              <div key={i} className={"ivs-img-row" + (expandedImg === i ? " expanded" : "")}>
                <div className="ivs-img-summary" onClick={() => setExpandedImg(expandedImg === i ? null : i)}>
                  <span className="ivs-img-name" title={img.fullImage || img.image}>{img.image}</span>
                  <span className="ivs-img-ns">{img.namespace}</span>
                  <div className="ivs-img-sevs">
                    {img.critical > 0 && <span className="ivs-img-sev crit">{img.critical}C</span>}
                    {img.high > 0 && <span className="ivs-img-sev high">{img.high}H</span>}
                    {img.medium > 0 && <span className="ivs-img-sev med">{img.medium}M</span>}
                    {img.low > 0 && <span className="ivs-img-sev low">{img.low}L</span>}
                  </div>
                  <span className="ivs-img-cvss" style={{ color: cvssColor(img.maxCVSS || 0) }}>
                    {(img.maxCVSS || 0).toFixed(1)}
                  </span>
                  <span className="ivs-img-chevron">{expandedImg === i ? "▲" : "▼"}</span>
                </div>
                {expandedImg === i && (img.vulnerabilities || []).length > 0 && (
                  <div className="ivs-img-detail">
                    <table className="ivs-vuln-table">
                      <thead>
                        <tr><th>CVSS</th><th>Severity</th><th>CVE</th><th>Package</th><th>Fix</th></tr>
                      </thead>
                      <tbody>
                        {(img.vulnerabilities || []).slice(0, 15).map((v, vi) => (
                          <tr key={vi}>
                            <td style={{ color: cvssColor(v.cvss || 0), fontWeight: 700 }}>{(v.cvss || 0).toFixed(1)}</td>
                            <td><span className={"ivs-sev-pill " + (v.severity || "").toLowerCase()}>{v.severity}</span></td>
                            <td className="ivs-cve-id">{v.id}</td>
                            <td>{v.package}{v.version ? `@${v.version}` : ""}</td>
                            <td>{v.fix ? <span style={{ color: "var(--ok)" }}>{"✓"} {v.fix}</span> : <span style={{ color: "var(--text2)" }}>—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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
