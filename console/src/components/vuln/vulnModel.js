// Shared model for the Image Vulnerabilities card and the Vulnerability
// Center: one place that turns the API response into what both draw, so the
// card's numbers and the Center's are the same numbers.
//
// The server prioritises (KEV + EPSS + fix + runtime). A spoke cluster still
// on an older build sends no `priority`; for those rows a conservative tier is
// derived here from the same rules minus the runtime facts it does not have,
// and the row says so (`priority.derived`).

export const TIERS = ["fix-now", "fix-soon", "plan", "monitor", "hygiene"];
export const TIER_LABEL = { "fix-now": "Fix now", "fix-soon": "Fix soon", plan: "Plan", monitor: "Monitor", hygiene: "Hygiene only" };
export const TIER_HINT = {
  "fix-now": "Known exploited, or a fixable Critical that is exposed or very likely to be exploited",
  "fix-soon": "Fixable Critical, or a fixable High that is exposed or privileged",
  plan: "Fixable High, or a Critical with no fix yet — schedule it",
  monitor: "Medium and Low only — patch with the next rebuild",
  hygiene: "No CVE scan yet — image-hygiene rules only",
};
export const SEVS = ["critical", "high", "medium", "low"];

export const sevVar = (s) => `var(--vc-${s === "critical" ? "crit" : s === "high" ? "high" : s === "medium" ? "med" : "low"})`;
export const tierVar = (t) => `var(--vc-t-${t})`;

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

function derivePriority(img) {
  const vulns = img.vulnerabilities || [];
  const kev = vulns.filter((v) => v.kev).length;
  const fixC = vulns.filter((v) => v.severity === "critical" && v.fix).length;
  const fixH = vulns.filter((v) => v.severity === "high" && v.fix).length;
  let tier = "monitor";
  if (img.source === "static") tier = "hygiene";
  else if (kev > 0) tier = "fix-now";
  else if (fixC > 0) tier = "fix-soon";
  else if (fixH > 0 || (img.critical || 0) > 0) tier = "plan";
  const factors = [];
  if (kev) factors.push({ key: "kev", label: `${kev} known exploited` });
  if (fixC + fixH) factors.push({ key: "fixable", label: `${fixC + fixH} fixable C/H` });
  return { tier, tierLabel: TIER_LABEL[tier], score: Math.round(Math.min(10, img.maxCVSS || 0) * 5 + Math.min(20, kev * 10)), factors, running: null, exposed: false, privileged: false, kevCount: kev, derived: true };
}

function aggregateCves(images) {
  const by = new Map();
  for (const img of images) {
    if (img.source === "static") continue;
    for (const v of img.vulnerabilities || []) {
      if (!/^(CVE|GHSA)-/i.test(v.id || "")) continue;
      let r = by.get(v.id);
      if (!r) { r = { id: v.id, severity: v.severity, cvss: v.cvss || 0, cvssEstimated: v.cvssEstimated, kev: !!v.kev, epss: v.epss ?? null, description: v.description, link: v.link, packages: [], fixedVersions: [], images: [], namespaces: [], running: false, exposed: false }; by.set(v.id, r); }
      if ((SEV_RANK[v.severity] || 0) > (SEV_RANK[r.severity] || 0)) r.severity = v.severity;
      if (v.package && !r.packages.includes(v.package)) r.packages.push(v.package);
      if (v.fix && !r.fixedVersions.includes(v.fix)) r.fixedVersions.push(v.fix);
      if (!r.images.includes(img.fullImage || img.image)) r.images.push(img.fullImage || img.image);
      if (img.namespace && !r.namespaces.includes(img.namespace)) r.namespaces.push(img.namespace);
    }
  }
  return [...by.values()].map((r) => ({ ...r, fixable: r.fixedVersions.length > 0, imageCount: r.images.length }))
    .sort((a, b) => (b.kev - a.kev) || ((b.epss || 0) - (a.epss || 0)) || ((SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0)) || (b.cvss - a.cvss));
}

/** Split "quay.io/org/app:1.2@sha256:…" into what a table shows. */
export function splitImage(ref) {
  let s = String(ref || "");
  const at = s.indexOf("@");
  const digest = at >= 0 ? s.slice(at + 1) : null;
  if (at >= 0) s = s.slice(0, at);
  const slash = s.lastIndexOf("/");
  const colon = s.lastIndexOf(":");
  const tag = colon > slash ? s.slice(colon + 1) : (digest ? null : "latest");
  if (colon > slash) s = s.slice(0, colon);
  const parts = s.split("/");
  const name = parts.pop();
  return { name, path: parts.join("/"), tag, digest: digest ? digest.replace("sha256:", "").slice(0, 12) : null };
}

export function normalize(d) {
  if (!d) return null;
  const images = (d.topImages || []).map((img) => ({ ...img, priority: img.priority || derivePriority(img) }));
  const TR = (t) => TIERS.indexOf(t);
  images.sort((a, b) => TR(a.priority.tier) - TR(b.priority.tier) || (b.priority.score || 0) - (a.priority.score || 0));
  const cves = Array.isArray(d.cves) && d.cves.length ? d.cves : aggregateCves(images);
  const p = d.prioritization || null;
  const tiers = p?.tiers || Object.fromEntries(TIERS.map((t) => [t, images.filter((i) => i.priority.tier === t).length]));
  const cov = d.coverage || {};
  const coverage = {
    live: cov.live ?? images.filter((i) => i.source && i.source !== "static").length,
    total: cov.total ?? (d.totalImages || images.length),
    engine: cov.liveEngine || (d.scannerType !== "static-analysis" ? d.scannerType : null),
  };
  coverage.pct = coverage.total ? Math.round((coverage.live / coverage.total) * 100) : 0;
  const fixableCves = cves.filter((c) => c.fixable).length;
  const funnel = p?.funnel || [
    { key: "all", label: "Unique CVEs", count: cves.length },
    { key: "fixable", label: "Fix available", count: fixableCves },
    { key: "exploitable", label: "Known or likely exploited", count: cves.filter((c) => c.fixable && (c.kev || (c.epss || 0) >= 0.1)).length },
  ];
  return {
    raw: d, images, cves, tiers, funnel, coverage,
    runtimeKnown: !!p?.runtimeKnown,
    derived: !p,
    kevCves: p?.kevCves ?? cves.filter((c) => c.kev).length,
    uniqueCves: p?.uniqueCves ?? cves.length,
    fixablePct: cves.length ? Math.round((fixableCves / cves.length) * 100) : 0,
    exposedImages: p?.exposedImages ?? 0,
    runningImages: p?.runningImages ?? null,
    privilegedImages: p?.privilegedImages ?? 0,
    namespaces: p?.namespaces || [],
    kev: d.kev || null,
    epss: p?.epss || null,
    sev: { critical: d.critical || 0, high: d.high || 0, medium: d.medium || 0, low: d.low || 0 },
    history: (d.history || []).slice().reverse(),
  };
}

export function relTime(iso) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const pct = (x) => { if (x == null) return "—"; const p = Math.floor(x * 1000) / 10; return `${p >= 10 && p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`; };

export function clusterUrl(path, cluster) {
  if (!cluster || cluster === "local") return path;
  return `${path}${path.includes("?") ? "&" : "?"}cluster=${encodeURIComponent(cluster)}`;
}

export function toCsv(rows, cols) {
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map((c) => esc(c[0])).join(","), ...rows.map((r) => cols.map((c) => esc(c[1](r))).join(","))].join("\n");
}

export function download(name, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
