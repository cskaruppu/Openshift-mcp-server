// Remediation triage: for each CVE in an image, HOW it gets fixed, WHO owns
// it and WHEN it is due.
//
// "Upgrade the image" is not a plan. A CVE in an OS package is fixed by
// rebuilding on a patched base image; one in a Go module, Maven artifact or
// npm package by bumping that dependency and rebuilding; one in a vendor
// image (nginx, redis) by moving to the vendor's newer tag; one with no fix
// yet by a mitigation or a time-boxed risk acceptance. Each needs a different
// change, in a different repository, reviewed by a different team — so each
// CVE is classified on its own, from what the scanner reports about the
// package, and the plan groups them by the change that fixes them.

import { kevDetails } from "../kev-feed.js";

export const FIX_TYPES = {
  "base-image": { label: "Rebuild on a patched base image", where: "Dockerfile FROM / base image", owner: "image" },
  dependency: { label: "Bump an application dependency", where: "dependency manifest in the source repo", owner: "app" },
  toolchain: { label: "Rebuild with a patched language runtime", where: "builder image / toolchain version", owner: "app" },
  "vendor-tag": { label: "Move to the vendor's patched tag", where: "image reference in the GitOps manifests", owner: "platform" },
  "no-fix": { label: "No fix published — mitigate or accept", where: "compensating control / risk acceptance", owner: "security" },
};

const OS_TYPES = new Set(["debian", "ubuntu", "alpine", "redhat", "rhel", "centos", "rocky", "alma", "amazon", "oracle", "suse", "photon", "wolfi", "chainguard", "mariner", "azurelinux", "distroless"]);

/** Ecosystem of a language package, from Trivy's type or the package name. */
export function ecosystemOf(v) {
  const t = String(v.pkgType || "").toLowerCase();
  const name = String(v.package || "");
  const tgt = String(v.target || "").toLowerCase();
  if (/gobinary|gomod/.test(t) || /go\.(mod|sum)$/.test(tgt) || /^(golang\.org|github\.com|go\.|google\.golang\.org|k8s\.io|sigs\.k8s\.io|gopkg\.in)\//.test(name) || name === "stdlib") return "go";
  if (/jar|pom|gradle|maven/.test(t) || /\.(jar|war|ear)$/.test(tgt) || /pom\.xml$/.test(tgt) || /^[a-z0-9_.-]+\.[a-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(name)) return "maven";
  if (/npm|node|yarn|pnpm/.test(t) || /package(-lock)?\.json$|yarn\.lock$|pnpm-lock/.test(tgt)) return "npm";
  if (/pip|python|poetry|pipenv|conda/.test(t) || /requirements.*\.txt$|poetry\.lock$|pipfile/.test(tgt) || /site-packages|dist-packages/.test(tgt)) return "pip";
  if (/gem|bundler/.test(t) || /gemfile/.test(tgt)) return "ruby";
  if (/nuget|dotnet/.test(t) || /\.deps\.json$|packages\.lock\.json$/.test(tgt)) return "nuget";
  if (/cargo|rust/.test(t) || /cargo\.lock$/.test(tgt)) return "cargo";
  if (/composer|php/.test(t)) return "composer";
  return null;
}

export const MANIFEST_FILES = {
  go: ["go.mod"], maven: ["pom.xml"], npm: ["package.json"], pip: ["requirements.txt", "requirements/base.txt", "pyproject.toml"],
  ruby: ["Gemfile"], nuget: ["*.csproj"], cargo: ["Cargo.toml"], composer: ["composer.json"],
};

/**
 * Classify one CVE.
 * @param v       a scanner vulnerability row
 * @param ctx     { firstParty } — true when the image is built by the customer
 *                (a source repo is known), false for vendor images
 */
export function classifyVuln(v, { firstParty }) {
  const fix = v.fixedBy || v.fix || null;
  if (!fix) return { type: "no-fix" };
  const cls = String(v.pkgClass || "").toLowerCase();
  const eco = cls === "os-pkgs" ? null : ecosystemOf(v);
  const isOs = cls === "os-pkgs" || OS_TYPES.has(String(v.pkgType || "").toLowerCase()) || (!eco && cls !== "lang-pkgs");
  // A vendor image is not rebuilt by the customer: whatever the package, the
  // fix is the vendor's next patched tag.
  if (!firstParty) return { type: "vendor-tag" };
  if (isOs) return { type: "base-image" };
  if (eco === "go" && v.package === "stdlib") return { type: "toolchain", ecosystem: "go", runtime: "Go", minVersion: String(fix).replace(/^v/, "").split(",")[0].trim() };
  return { type: "dependency", ecosystem: eco || "unknown", manifest: (MANIFEST_FILES[eco] || [])[0] || null };
}

/** Days allowed per severity, and for KEV; overridable with REMEDIATION_SLA_DAYS='{"kev":14,"critical":7,...}'. */
export function slaPolicy() {
  const def = { kev: 14, critical: 15, high: 30, medium: 90, low: 180 };
  try { return { ...def, ...(JSON.parse(process.env.REMEDIATION_SLA_DAYS || "{}")) }; } catch { return def; }
}

const addDays = (iso, d) => new Date(new Date(iso).getTime() + d * 86400000).toISOString().slice(0, 10);

/**
 * Due date for one CVE, counted from when it was found here.
 * KEV: the policy's KEV window (default 14 days — CISA BOD 22-01's window for
 * newly added entries), or CISA's own due date when that is sooner and still
 * ahead. CISA's dates for old entries are years past; they are kept for
 * reference, not used to call a finding found today "1,700 days overdue".
 * Otherwise: the policy's days for its severity.
 */
export function dueDateFor(v, { firstSeen, policy = slaPolicy() }) {
  const start = firstSeen || new Date().toISOString();
  const sevDays = policy[v.severity] ?? policy.low;
  if (v.kev) {
    const k = kevDetails(v.id);
    let due = addDays(start, Math.min(policy.kev ?? 14, sevDays));
    let basis = `known exploited · ${Math.min(policy.kev ?? 14, sevDays)}-day policy`;
    if (k?.dueDate && k.dueDate >= start.slice(0, 10) && k.dueDate < due) { due = k.dueDate; basis = "CISA KEV due date"; }
    return { due, basis, cisaDue: k?.dueDate || null };
  }
  return { due: addDays(start, sevDays), basis: `${v.severity} · ${sevDays}-day policy` };
}

/**
 * Who owns the fix, from labels and annotations on the namespace and the
 * workload — the convention most platform teams already use. Falls back to
 * the namespace name, said so.
 */
export function resolveOwner({ namespace, nsMeta = {}, workloadMeta = {} }) {
  const pick = (m) => m && (m["tcs.com/owner"] || m["owner"] || m["app.kubernetes.io/owner"] || m["team"] || m["app.kubernetes.io/part-of"]);
  const a = { ...(nsMeta.labels || {}), ...(nsMeta.annotations || {}) };
  const w = { ...(workloadMeta.labels || {}), ...(workloadMeta.annotations || {}) };
  const team = pick(w) || pick(a);
  const contact = w["tcs.com/owner-email"] || a["tcs.com/owner-email"] || a["openshift.io/requester"] || null;
  return team ? { team, contact, source: "label" } : { team: `${namespace} team`, contact, source: "namespace (no owner label)" };
}

/**
 * Triage a whole image into a plan: CVEs grouped by the change that fixes
 * them, each group with its own due date (the earliest of its CVEs).
 */
export function triageImage({ vulnerabilities = [], firstParty, firstSeen }) {
  const policy = slaPolicy();
  const items = vulnerabilities
    .filter((v) => /^(CVE|GHSA)-/i.test(v.id || ""))
    .map((v) => {
      const c = classifyVuln(v, { firstParty });
      const due = dueDateFor(v, { firstSeen, policy });
      const k = v.kev ? kevDetails(v.id) : null;
      return {
        id: v.id, severity: v.severity, cvss: v.cvss || 0, epss: v.epss ?? null, kev: !!v.kev, ransomware: !!k?.ransomware,
        package: v.package || "", installed: v.version || "", fixed: v.fixedBy || v.fix || null, target: v.target || null,
        fixType: c.type, ecosystem: c.ecosystem || null, manifest: c.manifest || null, runtime: c.runtime || null, minVersion: c.minVersion || null,
        due: due.due, dueBasis: due.basis, cisaDue: due.cisaDue || null,
      };
    });
  const groups = {};
  for (const it of items) {
    const key = it.fixType === "dependency" ? `dependency:${it.ecosystem}` : it.fixType;
    const g = groups[key] || (groups[key] = { key, type: it.fixType, ecosystem: it.ecosystem, label: FIX_TYPES[it.fixType].label, where: it.manifest || FIX_TYPES[it.fixType].where, items: [], due: it.due });
    g.items.push(it);
    if (it.due < g.due) g.due = it.due;
  }
  const order = ["vendor-tag", "base-image", "toolchain", "dependency", "no-fix"];
  const list = Object.values(groups).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.due.localeCompare(b.due));
  for (const g of list) {
    // One line per package: the bump a reviewer will see in the PR.
    const byPkg = new Map();
    for (const it of g.items) {
      const p = byPkg.get(it.package) || { package: it.package, installed: it.installed, fixed: it.fixed, cves: [] };
      p.cves.push(it.id);
      if (it.fixed && (!p.fixed || String(it.fixed) > String(p.fixed))) p.fixed = it.fixed;
      byPkg.set(it.package, p);
    }
    g.packages = [...byPkg.values()];
  }
  const due = items.length ? items.reduce((m, i) => (i.due < m ? i.due : m), items[0].due) : null;
  return { items, groups: list, due, policy };
}
