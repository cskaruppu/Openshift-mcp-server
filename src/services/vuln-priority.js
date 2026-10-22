// Risk-based prioritisation for image findings.
//
// Severity alone sorts thousands of CVEs into a list nobody can finish. What
// enterprise scanners do instead, and what this does, is combine four facts
// that are each checkable:
//   - is it known to be exploited?        CISA KEV
//   - how likely is exploitation soon?    FIRST EPSS
//   - can it be fixed today?              the scanner's fixed version
//   - does it matter where it runs?       running · externally exposed · privileged
// into a TIER a team can act on and a SCORE that orders within it. Every input
// is shown beside the result as a factor, so the ranking can be argued with.
// No AI is involved: the same scan gives the same order every time.

export const TIERS = ["fix-now", "fix-soon", "plan", "monitor", "hygiene"];
export const TIER_LABEL = { "fix-now": "Fix now", "fix-soon": "Fix soon", plan: "Plan", monitor: "Monitor", hygiene: "Hygiene only" };

const HIGH_EPSS = 0.5;   // top ~1% of CVEs by exploit likelihood
const MID_EPSS = 0.1;

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

/** Per-CVE enrichment: KEV and EPSS. Mutates nothing. */
export function enrichVuln(v, { kev, epss }) {
  const id = String(v.id || "").toUpperCase();
  const e = epss?.get(id);
  return { ...v, kev: !!kev?.has(id), epss: e ? e.epss : null, epssPercentile: e ? e.percentile : null };
}

/**
 * Prioritise one image.
 * @param img      a scan result row (vulnerabilities already enriched)
 * @param rt       runtime context for the image, or null when unknown
 */
export function prioritizeImage(img, rt) {
  const vulns = img.vulnerabilities || [];
  const hygieneOnly = img.source === "static";
  const kevVulns = vulns.filter(v => v.kev);
  const fixable = (v) => !!(v.fixedBy || v.fix);
  const kevFixable = kevVulns.filter(fixable).length;
  const critFix = vulns.filter(v => v.severity === "critical" && fixable(v)).length;
  const highFix = vulns.filter(v => v.severity === "high" && fixable(v)).length;
  const maxEpss = Math.max(0, ...vulns.map(v => v.epss || 0));
  const running = rt ? rt.running : null;
  const exposed = !!(rt && rt.exposure && rt.exposure.length > 0);
  const privileged = !!(rt && rt.privileged);

  const factors = [];
  if (kevVulns.length) factors.push({ key: "kev", label: `${kevVulns.length} known exploited`, detail: `In CISA KEV: ${kevVulns.slice(0, 5).map(v => v.id).join(", ")}` });
  if (maxEpss >= MID_EPSS) factors.push({ key: "epss", label: `EPSS ${epssLabel(maxEpss)}`, detail: "Highest FIRST EPSS probability of exploitation in the next 30 days" });
  if (exposed) factors.push({ key: "exposed", label: "Externally exposed", detail: rt.exposure.slice(0, 3).map(e => `${e.kind} ${e.name}${e.host ? ` (${e.host})` : ""}`).join(" · ") });
  if (privileged) factors.push({ key: "privileged", label: "Privileged", detail: "Runs privileged, on the host network, or under an elevated SCC" });
  else if (rt && rt.root) factors.push({ key: "root", label: "Runs as root", detail: "UID 0 or the anyuid SCC" });
  if (critFix + highFix > 0) factors.push({ key: "fixable", label: `${critFix + highFix} fixable C/H`, detail: "Critical or High CVEs with an upstream fixed version" });
  if (running === false) factors.push({ key: "not-running", label: "Not running", detail: "No running pod uses this image" });
  // Hygiene rules are not CVEs: "fixable" there means "re-tag it", which is
  // not the same claim, so only the runtime facts are kept.
  if (hygieneOnly) {
    const keep = factors.filter(f => f.key === "exposed" || f.key === "privileged" || f.key === "root" || f.key === "not-running");
    factors.length = 0;
    factors.push({ key: "hygiene", label: "No CVE scan yet", detail: "Image-hygiene rules only until the scanner reports" }, ...keep);
  }

  let tier;
  if (hygieneOnly) tier = "hygiene";
  // Fix now: a known-exploited CVE that can be patched today (CISA's own
  // remediation rule for KEV), or a fixable Critical/likely-exploited CVE
  // reachable from outside the cluster.
  else if (kevFixable > 0 || (exposed && (critFix > 0 || (maxEpss >= HIGH_EPSS && highFix > 0)))) tier = "fix-now";
  // Fix soon: exploited but no patch yet (mitigate), likely to be exploited,
  // or a fixable Critical inside the cluster.
  else if (kevVulns.length > 0 || critFix > 0 || (maxEpss >= HIGH_EPSS && critFix + highFix > 0) || (highFix > 0 && (exposed || privileged)) || maxEpss >= MID_EPSS) tier = "fix-soon";
  else if (highFix > 0 || (img.critical || 0) > 0) tier = "plan";
  else tier = "monitor";
  // An image nobody runs cannot be attacked through the cluster; keep it on
  // the list, but behind everything that is live.
  if (running === false && (tier === "fix-now" || tier === "fix-soon")) tier = "plan";

  // Score orders images inside a tier. Bounded, additive, and every term is a
  // factor shown above.
  let score = Math.min(10, img.maxCVSS || 0) * 5;                       // ≤ 50
  score += Math.min(20, kevVulns.length * 10);                          // ≤ 20
  score += Math.round(maxEpss * 10);                                    // ≤ 10
  score += exposed ? 10 : 0;
  score += privileged ? 5 : (rt && rt.root ? 2 : 0);
  score += Math.min(5, critFix + highFix);
  if (running === false) score *= 0.5;
  if (hygieneOnly) score = Math.min(score, 30);
  score = Math.round(Math.max(0, Math.min(100, score)));

  return { tier, tierLabel: TIER_LABEL[tier], score, factors, running, exposed, privileged, root: !!(rt && rt.root), kevCount: kevVulns.length, maxEpss: maxEpss || null };
}

export const tierRank = (t) => TIERS.indexOf(t);

/** "94%", "99.9%", "3.1%" — never "100%": EPSS is a probability, not a certainty. */
export function epssLabel(e) {
  const p = Math.floor(e * 1000) / 10;
  return `${p >= 10 && p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

/** Sort CVEs most urgent first: KEV, then EPSS, then severity, then CVSS. */
export function compareVulns(a, b) {
  return (b.kev - a.kev)
    || ((b.epss || 0) - (a.epss || 0))
    || ((SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0))
    || ((b.cvss || 0) - (a.cvss || 0));
}

/**
 * One row per CVE across every live-scanned image, with where it is.
 * Hygiene rules (IMG-00x) are not CVEs and are left out.
 */
export function aggregateCves(images, limit = 300) {
  const byId = new Map();
  for (const img of images) {
    if (img.source === "static") continue;
    for (const v of (img.vulnerabilities || [])) {
      const id = String(v.id || "");
      if (!/^(CVE|GHSA)-/i.test(id)) continue;
      let row = byId.get(id);
      if (!row) {
        row = { id, severity: v.severity, cvss: v.cvss || 0, cvssEstimated: !!v.cvssEstimated, kev: !!v.kev, epss: v.epss ?? null, epssPercentile: v.epssPercentile ?? null,
          description: v.description || "", link: v.link || null, packages: new Set(), fixedVersions: new Set(), images: new Set(), namespaces: new Set(), running: false, exposed: false };
        byId.set(id, row);
      }
      if ((SEV_RANK[v.severity] || 0) > (SEV_RANK[row.severity] || 0)) row.severity = v.severity;
      if ((v.cvss || 0) > row.cvss) { row.cvss = v.cvss; row.cvssEstimated = !!v.cvssEstimated; }
      if (v.package) row.packages.add(v.package);
      if (v.fixedBy || v.fix) row.fixedVersions.add(v.fixedBy || v.fix);
      row.images.add(img.image);
      if (img.namespace) row.namespaces.add(img.namespace);
      if (img.priority?.running) row.running = true;
      if (img.priority?.exposed) row.exposed = true;
    }
  }
  const rows = [...byId.values()].map(r => ({
    ...r, packages: [...r.packages].slice(0, 5), fixedVersions: [...r.fixedVersions].slice(0, 3),
    fixable: r.fixedVersions.size > 0, imageCount: r.images.size, images: [...r.images].slice(0, 8), namespaces: [...r.namespaces].slice(0, 8),
  }));
  rows.sort(compareVulns);
  return { total: rows.length, rows: rows.slice(0, limit) };
}

/**
 * The noise-reduction funnel: unique CVEs, then each step keeps those that
 * also meet the next condition. When runtime context is unknown, the running
 * and exposure steps are omitted rather than guessed.
 */
export function buildFunnel(cveRows, { runtimeKnown }) {
  const steps = [{ key: "all", label: "Unique CVEs", count: cveRows.length }];
  let set = cveRows.filter(r => r.fixable);
  steps.push({ key: "fixable", label: "Fix available", count: set.length });
  if (runtimeKnown) {
    set = set.filter(r => r.running);
    steps.push({ key: "running", label: "In running workloads", count: set.length });
  }
  set = set.filter(r => r.kev || (r.epss || 0) >= MID_EPSS);
  steps.push({ key: "exploitable", label: "Known or likely exploited", count: set.length, detail: "In CISA KEV, or EPSS ≥ 10%" });
  if (runtimeKnown) {
    set = set.filter(r => r.exposed);
    steps.push({ key: "exposed", label: "…and externally exposed", count: set.length });
  }
  return steps;
}
