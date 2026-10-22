import { useState, useMemo, useCallback } from "react";
import { useClusterQuery, REFRESH } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";
import { showToast } from "../../store/toastStore";
import { normalize, relTime, clusterUrl, TIER_LABEL, tierVar } from "../vuln/vulnModel";
import { TierBadge, SevBar, FactorChips, ImageName, Funnel } from "../vuln/VulnParts";
import { VulnerabilityCenter } from "../vuln/VulnerabilityCenter";

// Image Vulnerabilities — the dashboard card.
//
// A card answers three questions at a glance: how exposed are we, what must
// be fixed first, and can the numbers be trusted. Everything deeper — the
// inventory, the CVE view, runtime exposure, the fix — lives in the
// Vulnerability Center this card opens, so the dashboard stays a dashboard.

export function ImageVulnsWidget() {
  const cluster = useActiveCluster();
  const { data, isLoading, isError, error, refetch } = useClusterQuery("/api/dashboard/image-vulns", { refetchInterval: REFRESH.SCAN });
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(null);
  const [scanning, setScanning] = useState(false);
  const model = useMemo(() => (data && data.available !== false ? normalize(data) : null), [data]);
  const clearFocus = useCallback(() => setFocus(null), []);
  const close = useCallback(() => setOpen(false), []);

  const rescan = async () => {
    setScanning(true);
    try {
      const r = await fetch(clusterUrl("/api/dashboard/image-vulns?rescan=true", cluster));
      await r.json();
      showToast("Image scan complete", "ok");
      refetch();
    } catch (e) { showToast("Scan failed: " + e.message, "err"); }
    finally { setScanning(false); }
  };

  const head = (
    <div className="vcw-head">
      <div>
        <h3>Image Vulnerabilities</h3>
        <span className="vcw-sub">Risk-prioritised · CVE scan + CISA KEV + FIRST EPSS + runtime</span>
      </div>
      {model && (
        <div className="vcw-actions">
          <button className="vc-btn ghost sm" onClick={rescan} disabled={scanning} title="Rescan now">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className={scanning ? "vc-spin" : ""}><path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2v3h-3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {scanning ? "Scanning" : "Rescan"}
          </button>
          <button className="vc-btn primary sm" onClick={() => setOpen(true)}>Open Vulnerability Center <span aria-hidden="true">→</span></button>
        </div>
      )}
    </div>
  );

  if (isLoading) return <div className="vcw">{head}<div className="vcw-state"><span className="vcw-skel" /><span className="vcw-skel" /><span className="vcw-skel short" /></div></div>;
  if (isError) return <div className="vcw">{head}<div className="vcw-state err">{String(error?.message)}</div></div>;
  if (!model) return <div className="vcw">{head}<div className="vcw-state">{data?.message || "Not installed on this cluster"}</div></div>;

  const m = model;
  const top = m.images.filter((i) => i.priority.tier === "fix-now" || i.priority.tier === "fix-soon").slice(0, 5);
  const list = top.length ? top : m.images.slice(0, 5);
  const engine = m.coverage.engine === "trivy-operator" ? "Trivy Operator" : m.coverage.engine === "quay-cso" ? "Quay / Clair" : null;

  return (
    <div className="vcw">
      {head}

      <div className="vcw-kpis">
        <button className="vcw-kpi hot" style={{ "--k": tierVar("fix-now") }} onClick={() => setOpen(true)} title={`${TIER_LABEL["fix-now"]}: known exploited, or a fixable Critical that is exposed or very likely to be exploited`}>
          <span>Fix now</span><b>{m.tiers["fix-now"] || 0}</b><em>images</em>
        </button>
        <div className="vcw-kpi" style={{ "--k": "var(--vc-crit)" }}><span>Known exploited</span><b>{m.kevCves}</b><em>CVEs in CISA KEV</em></div>
        <div className="vcw-kpi"><span>Exposed</span><b>{m.runtimeKnown ? m.exposedImages : "—"}</b><em>{m.runtimeKnown ? "images reachable from outside" : "runtime unknown"}</em></div>
        <div className="vcw-kpi" style={m.coverage.pct < 50 ? { "--k": "var(--vc-high)" } : undefined}><span>Coverage</span><b>{m.coverage.pct}%</b><em>{m.coverage.live}/{m.coverage.total} live-scanned</em></div>
      </div>

      <div className="vcw-mid">
        <div className="vcw-funnel">
          <div className="vcw-label">From every CVE to the few that matter</div>
          <Funnel steps={m.funnel} compact />
        </div>
        <div className="vcw-sev">
          <div className="vcw-label">All findings</div>
          <SevBar c={m.sev.critical} h={m.sev.high} m={m.sev.medium} l={m.sev.low} width={150} />
          <div className="vcw-sevkey"><span>Critical</span><span>High</span><span>Medium</span><span>Low</span></div>
        </div>
      </div>

      <div className="vcw-list">
        <div className="vcw-label">{top.length ? "Fix first" : "Highest risk"}<span>{top.length ? "ranked by exploitation, exposure and fix availability" : "no image needs urgent action"}</span></div>
        {list.map((img) => {
          const key = img.fullImage || img.image;
          return (
            <button key={key + (img.cluster || "")} className="vcw-row" onClick={() => { setFocus(key); setOpen(true); }}>
              <TierBadge tier={img.priority.tier} size="sm" />
              <ImageName image={key} cluster={img.cluster} />
              <FactorChips factors={(img.priority.factors || []).filter((f) => f.key !== "fixable")} max={2} />
              <SevBar c={img.critical} h={img.high} m={img.medium} l={img.low} width={56} />
              <span className="vcw-chev" aria-hidden="true">›</span>
            </button>
          );
        })}
      </div>

      <div className="vcw-foot">
        <span className={"vcw-dot" + (engine ? " live" : "")} />
        {engine ? <><b>{engine}</b> CVE data</> : <b>Hygiene rules only — no CVE scanner detected</b>}
        <span className="vcw-sep">·</span>KEV {m.kev?.status === "live" ? <b>v{m.kev.catalogVersion}</b> : <span className="vc-warn">{m.kev?.status || "pending"}</span>}
        <span className="vcw-sep">·</span>EPSS {m.epss?.status === "live" ? <b>live</b> : <span className="vc-warn">{m.epss?.status || "n/a"}</span>}
        <span className="vcw-sep">·</span>scanned {relTime(m.raw.timestamp)}
      </div>

      <VulnerabilityCenter open={open} onClose={close} model={m} cluster={cluster} refetch={refetch} focusImage={focus} onFocusConsumed={clearFocus} />
    </div>
  );
}
