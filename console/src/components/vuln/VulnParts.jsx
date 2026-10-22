import { SEVS, TIER_LABEL, TIER_HINT, sevVar, tierVar, splitImage, pct } from "./vulnModel";

// Small, shared pieces of the vulnerability UI. Colour always comes with a
// word or a number beside it, so nothing is carried by colour alone.

export function TierBadge({ tier, size = "md" }) {
  return (
    <span className={`vc-tier vc-tier-${size}`} style={{ "--t": tierVar(tier) }} title={TIER_HINT[tier]}>
      <span className="vc-tier-dot" aria-hidden="true" />{TIER_LABEL[tier] || tier}
    </span>
  );
}

/** Stacked C/H/M/L bar with the counts printed beside it. */
export function SevBar({ c = 0, h = 0, m = 0, l = 0, width = 96, showCounts = true }) {
  const total = c + h + m + l;
  const parts = [["critical", c], ["high", h], ["medium", m], ["low", l]];
  return (
    <span className="vc-sevbar" title={`${c} Critical · ${h} High · ${m} Medium · ${l} Low`}>
      <span className="vc-sevbar-track" style={{ width }}>
        {total === 0 ? null : parts.map(([s, n]) => n > 0 && (
          <span key={s} style={{ width: `${Math.max(4, (n / total) * 100)}%`, background: sevVar(s) }} />
        ))}
      </span>
      {showCounts && (
        <span className="vc-sevbar-nums">
          {parts.map(([s, n]) => (
            <span key={s} className={n ? "" : "vc-zero"} style={n ? { color: sevVar(s) } : undefined}>{n}</span>
          ))}
        </span>
      )}
    </span>
  );
}

export function SevPill({ s }) {
  return <span className="vc-sevpill" style={{ "--s": sevVar(s) }}>{s}</span>;
}

const FACTOR_ICON = {
  kev: "M8 1.5 15 14H1z M8 6v3.5 M8 11.6v.1",
  epss: "M2 13h12 M3.5 10.5l3-3 2.5 2 4-5",
  exposed: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z M2 8h12 M8 2c2 2 2 10 0 12 M8 2c-2 2-2 10 0 12",
  privileged: "M8 1.5l5.5 2v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4z",
  root: "M8 1.5l5.5 2v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4z",
  fixable: "M3 8.5l3 3 7-7",
  "not-running": "M4 4l8 8 M12 4l-8 8",
};

export function FactorChips({ factors = [], max = 4 }) {
  const shown = factors.slice(0, max);
  return (
    <span className="vc-factors">
      {shown.map((f) => (
        <span key={f.key} className={`vc-factor vc-f-${f.key}`} title={f.detail || f.label}>
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d={FACTOR_ICON[f.key] || FACTOR_ICON.fixable} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {f.label}
        </span>
      ))}
      {factors.length > max && <span className="vc-factor vc-f-more">+{factors.length - max}</span>}
    </span>
  );
}

export function EpssMeter({ epss, percentile }) {
  if (epss == null) return <span className="vc-muted" title="No EPSS score published for this CVE">—</span>;
  const w = Math.max(3, Math.min(100, epss * 100));
  const hot = epss >= 0.1;
  return (
    <span className="vc-epss" title={`EPSS ${pct(epss)} probability of exploitation in the next 30 days${percentile != null ? ` · higher than ${Math.round(percentile * 100)}% of CVEs` : ""}`}>
      <span className="vc-epss-track"><span style={{ width: `${w}%`, background: hot ? "var(--vc-crit)" : "var(--tcs-blue)" }} /></span>
      <span className={hot ? "vc-epss-hot" : ""}>{pct(epss)}</span>
    </span>
  );
}

export function KevTag() {
  return <span className="vc-kev" title="Listed in CISA's Known Exploited Vulnerabilities catalog">KEV</span>;
}

export function SourceTag({ source }) {
  const live = source && source !== "static";
  return (
    <span className={"vc-src" + (live ? " live" : "")} title={live ? "Real CVE data from a live scanner" : "No CVE scan yet — hygiene rules only"}>
      {source === "trivy" ? "Trivy" : source === "clair" ? "Clair" : "Hygiene"}
    </span>
  );
}

export function ImageName({ image, cluster }) {
  const p = splitImage(image);
  return (
    <span className="vc-img" title={image}>
      <span className="vc-img-name">{p.name}<span className="vc-img-tag">{p.tag ? `:${p.tag}` : ""}{p.digest ? ` @${p.digest}` : ""}</span></span>
      <span className="vc-img-path">{cluster ? `${cluster} · ` : ""}{p.path || "docker.io"}</span>
    </span>
  );
}

/** The noise-reduction funnel — each step a subset of the one before. */
export function Funnel({ steps = [], compact = false }) {
  const max = Math.max(1, steps[0]?.count || 1);
  return (
    <div className={"vc-funnel" + (compact ? " compact" : "")}>
      {steps.map((s, i) => {
        const w = Math.max(2, (s.count / max) * 100);
        const last = i === steps.length - 1;
        return (
          <div key={s.key} className={"vc-funnel-row" + (last ? " last" : "")} title={s.detail || s.label}>
            <span className="vc-funnel-label">{s.label}</span>
            <span className="vc-funnel-bar"><span style={{ width: `${w}%` }} /></span>
            <span className="vc-funnel-num">{s.count.toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Critical + High over recent scans. Hidden with fewer than two points. */
export function Trend({ history = [] }) {
  if (history.length < 2) return <div className="vc-muted vc-trend-empty">Trend appears after the next scan</div>;
  const ys = history.map((h) => (h.critical || 0) + (h.high || 0));
  const max = Math.max(1, ...ys), W = 220, H = 48;
  const pts = ys.map((y, i) => `${(i / (ys.length - 1)) * W},${H - 4 - (y / max) * (H - 10)}`).join(" ");
  const delta = ys[ys.length - 1] - ys[0];
  return (
    <div className="vc-trend">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-label="Critical and High findings over recent scans">
        <polyline points={pts} fill="none" stroke="var(--tcs-blue)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <span className={"vc-trend-delta" + (delta > 0 ? " up" : delta < 0 ? " down" : "")}>
        {delta === 0 ? "No change" : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)} C/H`} over {history.length} scans
      </span>
    </div>
  );
}

export function Kpi({ label, value, sub, tone, onClick, active }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag type={onClick ? "button" : undefined} className={"vc-kpi" + (active ? " active" : "") + (onClick ? " clickable" : "")} style={tone ? { "--k": tone } : undefined} onClick={onClick}>
      <span className="vc-kpi-label">{label}</span>
      <span className="vc-kpi-value">{value}</span>
      {sub && <span className="vc-kpi-sub">{sub}</span>}
    </Tag>
  );
}

export { SEVS };
