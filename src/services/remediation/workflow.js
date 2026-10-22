// Vulnerability remediation workflow — the production path from "this image
// has CVEs" to "the fix is live, verified and closed", with every step on
// record.
//
//   1 Triage     each CVE classified by how it is fixed; owner and due date set
//   2 Plan       a replacement image chosen and confirmed to exist
//   3 Gate       the replacement scanned BEFORE approval; must fix what it claims,
//                carry no KEV CVE, and not add Criticals
//   4 Change     a PR (GitHub) / MR (GitLab) with the edit, and a ServiceNow
//                change request — or, with no Git source known, a CR alone
//   5 Approval   from ServiceNow, or in-app by an Admin who is not the requester
//   6 Deploy     the merge rolls it out through GitOps (or, approved and gated,
//                the platform patches the one container); the rollout is
//                watched and rolled back automatically if it fails
//   7 Verify     the scanner re-reports on the new image; the CVEs must be gone;
//                the CR is closed with before/after evidence
//   Exception    risk acceptance with a reason, an approver and an expiry, after
//                which the finding reopens by itself
//
// Nothing in this file merges a PR, approves a CR or skips a gate.

import { randomBytes } from "node:crypto";
import { ocpFetch, ocpPatch } from "../../utils/openshift-client.js";
import { query as dbQuery } from "../../utils/db.js";
import { getKevSet } from "../kev-feed.js";
import { sameImage, parseImageRef, isConcreteImageRef, verifyImageExists, suggestUpgrades } from "../image-verify.js";
import { triageImage, resolveOwner } from "./triage.js";
import * as git from "./git-providers.js";
import { startGateScan, pollGateScan, evaluateGate } from "./gate.js";

const KV_KEY = "vuln_remediations";
const TICK_MS = 30000;
const ROLLOUT_TIMEOUT_MS = (Number(process.env.REMEDIATION_ROLLOUT_TIMEOUT_MIN) || 15) * 60000;
const SYNC_TIMEOUT_MS = (Number(process.env.REMEDIATION_GITOPS_SYNC_TIMEOUT_MIN) || 60) * 60000;
const VERIFY_TIMEOUT_MS = (Number(process.env.REMEDIATION_VERIFY_TIMEOUT_MIN) || 120) * 60000;
const MAX_EXCEPTION_DAYS = Number(process.env.REMEDIATION_MAX_EXCEPTION_DAYS) || 90;

export const STATES = {
  triaged: { step: 1, label: "Triaged" },
  planned: { step: 2, label: "Planned" },
  gating: { step: 3, label: "Pre-deploy scan running" },
  "gate-failed": { step: 3, label: "Gate failed", blocked: true },
  "gate-passed": { step: 3, label: "Gate passed" },
  "awaiting-approval": { step: 4, label: "Awaiting approval" },
  rejected: { step: 4, label: "Rejected", terminal: true },
  approved: { step: 5, label: "Approved" },
  deploying: { step: 6, label: "Deploying" },
  "rolled-back": { step: 6, label: "Rolled back", blocked: true },
  "deploy-failed": { step: 6, label: "Not rolled out", blocked: true },
  verifying: { step: 7, label: "Verifying" },
  "verify-failed": { step: 7, label: "Not fully fixed", blocked: true },
  resolved: { step: 8, label: "Resolved", terminal: true },
  exception: { step: 0, label: "Risk accepted" },
  cancelled: { step: 0, label: "Cancelled", terminal: true },
};
const ACTIVE = new Set(["gating", "awaiting-approval", "approved", "deploying", "verifying", "exception"]);

const _records = new Map();
let _loaded = false;
let _deps = { runForCluster: (_c, fn) => fn(), snow: null, scanNamespace: null, ocp: null, gate: null };
const O = () => _deps.ocp || { fetch: ocpFetch, patch: ocpPatch };
const G = () => _deps.gate || { start: startGateScan, poll: pollGateScan };

/* ─────────────────────────── persistence ─────────────────────────── */

async function load() {
  if (_loaded) return;
  _loaded = true;
  try {
    const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [KV_KEY]);
    const v = r?.rows?.[0]?.value;
    const arr = typeof v === "string" ? JSON.parse(v) : v;
    if (Array.isArray(arr)) for (const rec of arr) _records.set(rec.id, rec);
  } catch { /* no database — in memory */ }
}
let _saveTimer = null;
function save() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      await dbQuery(`INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [KV_KEY, JSON.stringify([..._records.values()].slice(-2000))]);
    } catch { /* in memory only */ }
  }, 300);
}

function transition(rec, state, actor, note) {
  const entry = { at: new Date().toISOString(), actor: actor || "system", from: rec.state, to: state, note: note || "" };
  rec.history.push(entry);
  rec.state = state;
  rec.updatedAt = entry.at;
  save();
  // Every state change also goes to the platform's tamper-evident audit trail.
  try { _deps.audit?.(rec, entry); } catch { /* the record keeps its own history */ }
}
function note(rec, actor, text) {
  rec.history.push({ at: new Date().toISOString(), actor: actor || "system", from: rec.state, to: rec.state, note: text });
  rec.updatedAt = new Date().toISOString();
  save();
}

const err = (status, message) => Object.assign(new Error(message), { status });
const newId = () => `REM-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`;

/* ─────────────────────────── configuration ─────────────────────────── */

export function configure(deps) { _deps = { ..._deps, ...deps }; }

export function policySummary() {
  return {
    git: git.gitStatus(),
    serviceNow: !!_deps.snow?.enabled?.(),
    directPatch: process.env.REMEDIATION_DIRECT_PATCH !== "false",
    selfApproval: process.env.REMEDIATION_ALLOW_SELF_APPROVAL === "true",
    maxExceptionDays: MAX_EXCEPTION_DAYS,
    rolloutTimeoutMin: ROLLOUT_TIMEOUT_MS / 60000,
  };
}

/* ─────────────────────────── discovery ─────────────────────────── */

const KINDS = [["deployments", "Deployment"], ["statefulsets", "StatefulSet"], ["daemonsets", "DaemonSet"]];

/** The workload and container that actually run `image` in `namespace`. */
export async function findWorkload(namespace, image) {
  for (const [res, kind] of KINDS) {
    let list;
    try { list = await O().fetch(`/apis/apps/v1/namespaces/${namespace}/${res}`); } catch { continue; }
    for (const w of (list.items || [])) {
      const c = (w.spec?.template?.spec?.containers || []).find((x) => sameImage(x.image, image));
      if (c) return { kind, resource: res, name: w.metadata.name, container: c.name, image: c.image, meta: { labels: w.metadata.labels || {}, annotations: w.metadata.annotations || {} }, replicas: w.spec?.replicas ?? 1 };
    }
  }
  return null;
}

/** Source and GitOps repositories, from annotations and Argo CD. */
export async function discoverRepos(workload, nsMeta) {
  const a = { ...(nsMeta?.annotations || {}), ...(workload?.meta?.annotations || {}) };
  const out = { source: null, gitops: null };
  const src = a["tcs.com/source-repo"] || a["app.openshift.io/vcs-uri"];
  if (src) { const p = git.parseRepoUrl(src); if (p) out.source = { ...p, ref: a["app.openshift.io/vcs-ref"] || a["tcs.com/source-branch"] || null, dir: a["tcs.com/source-path"] || "" }; }
  const go = a["tcs.com/gitops-repo"];
  if (go) { const p = git.parseRepoUrl(go); if (p) out.gitops = { ...p, ref: a["tcs.com/gitops-branch"] || null, dir: a["tcs.com/gitops-path"] || "", via: "annotation" }; }
  if (!out.gitops) {
    const track = a["argocd.argoproj.io/tracking-id"];
    const app = (track && track.split(":")[0]) || workload?.meta?.labels?.["app.kubernetes.io/instance"] || workload?.meta?.labels?.["argocd.argoproj.io/instance"];
    if (app) {
      try {
        const apps = await O().fetch("/apis/argoproj.io/v1alpha1/applications");
        const found = (apps.items || []).find((x) => x.metadata.name === app);
        const s = found?.spec?.source || found?.spec?.sources?.[0];
        const p = s && git.parseRepoUrl(s.repoURL);
        if (p) out.gitops = { ...p, ref: s.targetRevision && s.targetRevision !== "HEAD" ? s.targetRevision : null, dir: s.path || "", via: `Argo CD application ${found.metadata.namespace}/${app}` };
      } catch { /* Argo CD not installed or not readable */ }
    }
  }
  return out;
}

const FIRST_PARTY = () => String(process.env.REMEDIATION_FIRST_PARTY_REGISTRIES || "").split(",").map((s) => s.trim()).filter(Boolean);

/* ─────────────────────────── actions ─────────────────────────── */

export async function list({ cluster } = {}) {
  await load();
  return [..._records.values()].filter((r) => !cluster || r.cluster === cluster).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function get(id) { await load(); const r = _records.get(id); if (!r) throw err(404, `No remediation ${id}`); return r; }

/**
 * Open (or return the open) remediation for an image. `scan` is the server's
 * own scan row for the image — the CVE list is never taken from the browser.
 */
export async function create({ cluster = "local", namespace, image, scan, actor }) {
  await load();
  if (!namespace || !image) throw err(400, "image and namespace are required");
  if (!scan) throw err(404, "This image is not in the current scan — rescan first");
  const open = [..._records.values()].find((r) => r.cluster === cluster && r.namespace === namespace && sameImage(r.image, image) && !STATES[r.state].terminal);
  if (open) return open;

  return _deps.runForCluster(cluster, async () => {
    const workload = await findWorkload(namespace, image);
    let nsMeta = {};
    try { const ns = await O().fetch(`/api/v1/namespaces/${namespace}`); nsMeta = { labels: ns.metadata.labels || {}, annotations: ns.metadata.annotations || {} }; } catch { /* no access */ }
    const repos = workload ? await discoverRepos(workload, nsMeta) : { source: null, gitops: null };
    const ref = parseImageRef(image);
    const firstParty = !!repos.source || FIRST_PARTY().some((p) => image.startsWith(p) || `${ref?.registry}/${ref?.repo}`.startsWith(p));
    const plan = triageImage({ vulnerabilities: scan.vulnerabilities || [], firstParty, firstSeen: scan.firstSeen || new Date().toISOString() });
    const now = new Date().toISOString();
    const rec = {
      id: newId(), cluster, namespace, image, createdAt: now, updatedAt: now, createdBy: actor || "unknown", state: "triaged",
      workload: workload ? { kind: workload.kind, resource: workload.resource, name: workload.name, container: workload.container, image: workload.image } : null,
      owner: resolveOwner({ namespace, nsMeta, workloadMeta: workload?.meta }),
      firstParty, repos, plan, due: plan.due,
      current: { critical: scan.critical || 0, high: scan.high || 0, medium: scan.medium || 0, low: scan.low || 0 },
      priority: scan.priority ? { tier: scan.priority.tier, score: scan.priority.score } : null,
      target: null, baseImage: null, gate: null, changes: [], changeRequest: null, approval: null, deploy: null, verify: null, exception: null,
      history: [{ at: now, actor: actor || "unknown", from: null, to: "triaged", note: `Opened for ${plan.items.length} CVE(s); ${plan.groups.length} fix type(s)` }],
    };
    // Real newer tags from the registry, offered in the plan — not guessed.
    try { rec.candidates = (await suggestUpgrades(image)).candidates || []; } catch { rec.candidates = []; }
    if (!workload) rec.history.push({ at: now, actor: "system", from: "triaged", to: "triaged", note: `No Deployment, StatefulSet or DaemonSet in ${namespace} runs this image — it can be tracked and excepted, not deployed` });
    _records.set(rec.id, rec);
    save();
    return rec;
  });
}

/** Re-read the registry's newer tags for the record's image. */
export async function refreshCandidates(id) {
  const rec = await get(id);
  const r = await suggestUpgrades(rec.image).catch((e) => ({ candidates: [], reason: e.message }));
  rec.candidates = r.candidates || [];
  save();
  return { candidates: rec.candidates, reason: r.reason || null };
}

/** Choose the replacement image (and, for a base-image rebuild, the new base). */
export async function setTarget(id, { image, baseImage, source = "operator" }, actor) {
  const rec = await get(id);
  if (!["triaged", "planned", "gate-failed", "rolled-back", "deploy-failed", "verify-failed"].includes(rec.state)) throw err(409, `Cannot change the target while ${STATES[rec.state].label.toLowerCase()}`);
  if (image) {
    if (!isConcreteImageRef(image)) throw err(400, "Not a valid image reference");
    if (sameImage(image, rec.image)) throw err(400, "That is the image already running");
    const check = await verifyImageExists(image);
    // A first-party image is built by CI from the source change, so its new
    // tag does not exist yet — that is expected, and the CI pipeline on the
    // PR / MR becomes the gate. A vendor tag must already exist.
    const toBuild = check.exists === false && rec.firstParty && !!rec.repos.source;
    if (check.exists === false && !toBuild) throw err(400, `Image not found: ${check.reason}`);
    if (toBuild) check.toBeBuilt = true;
    rec.target = { image, source, verified: check, at: new Date().toISOString(), by: actor };
  }
  if (baseImage !== undefined) {
    if (baseImage && !isConcreteImageRef(baseImage)) throw err(400, "Not a valid base image reference");
    rec.baseImage = baseImage || null;
  }
  rec.gate = null;
  transition(rec, "planned", actor, `Target ${rec.target?.image || "—"}${rec.target?.verified?.exists === true ? " (verified in registry)" : rec.target ? ` (not verified: ${rec.target.verified?.reason})` : ""}${rec.baseImage ? `; base ${rec.baseImage}` : ""}`);
  return rec;
}

/** Start the pre-deploy scan of the target image. */
export async function runGate(id, actor) {
  const rec = await get(id);
  if (!["planned", "gate-failed"].includes(rec.state)) throw err(409, "Choose a target image first");
  if (!rec.target?.image || rec.target?.verified?.toBeBuilt) {
    // A first-party fix that is rebuilt by CI has no image yet: its gate is
    // the CI pipeline on the PR / MR, checked before approval.
    if (rec.firstParty && rec.repos.source) {
      rec.gate = { mode: "ci", status: "deferred", note: "The replacement is built by CI from the source PR / MR; its pipeline checks are the gate" };
      transition(rec, "gate-passed", actor, "Gate deferred to the CI pipeline on the source change");
      return rec;
    }
    throw err(409, "Choose a target image first");
  }
  return _deps.runForCluster(rec.cluster, async () => {
    const job = await G().start(rec.target.image, { recordId: rec.id });
    rec.gate = { mode: "scan", status: "running", ...job, image: rec.target.image };
    transition(rec, "gating", actor, `Pre-deploy scan of ${rec.target.image} started (Job ${job.job})`);
    return rec;
  });
}

/** Build the file edits the change would make — shown for review before anything is opened. */
export async function previewChange(id) {
  const rec = await get(id);
  return buildChanges(rec);
}

async function buildChanges(rec) {
  const out = [];
  const oldRef = rec.workload?.image || rec.image;
  if (rec.repos.gitops && rec.target?.image) {
    const r = rec.repos.gitops;
    const ref = r.ref || await git.defaultBranch(r);
    const files = (await git.listFiles(r, ref, r.dir)).filter((p) => /\.(ya?ml|json)$/i.test(p)).slice(0, 150);
    const edits = [];
    for (const p of files) {
      const f = await git.getFile(r, ref, p);
      if (!f) continue;
      const { text, count } = git.replaceImageRef(f.content, oldRef, rec.target.image);
      if (count) edits.push({ path: p, sha: f.sha, before: f.content, content: text, diff: git.lineDiff(f.content, text) });
    }
    out.push({ repo: "gitops", provider: r.provider, webUrl: r.webUrl, base: ref, via: r.via, edits, note: edits.length ? null : `No manifest under ${r.dir || "/"} references ${oldRef}` });
  }
  if (rec.repos.source && rec.firstParty) {
    const r = rec.repos.source;
    const ref = r.ref && !/^[0-9a-f]{7,40}$/.test(r.ref) ? r.ref : await git.defaultBranch(r);
    const dir = (r.dir || "").replace(/\/+$/, "");
    const at = (p) => (dir ? `${dir}/${p}` : p);
    const edits = [];
    const touch = async (path, fn) => {
      const existing = edits.find((e) => e.path === path);
      const f = existing ? { content: existing.content, sha: existing.sha } : await git.getFile(r, ref, path);
      if (!f) return false;
      const { text, count } = fn(f.content);
      if (!count) return false;
      if (existing) { existing.content = text; existing.diff = git.lineDiff(existing.before, text); }
      else edits.push({ path, sha: f.sha, before: f.content, content: text, diff: git.lineDiff(f.content, text) });
      return true;
    };
    const first = (v) => String(v || "").split(",")[0].trim();
    const skipped = [];
    for (const g of rec.plan.groups) {
      if (g.type === "dependency") {
        for (const p of g.packages) {
          const v = first(p.fixed);
          let ok = false;
          if (g.ecosystem === "go") ok = await touch(at("go.mod"), (t) => git.bumpGoMod(t, p.package, v));
          else if (g.ecosystem === "npm") ok = await touch(at("package.json"), (t) => git.bumpPackageJson(t, p.package, v));
          else if (g.ecosystem === "pip") ok = await touch(at("requirements.txt"), (t) => git.bumpRequirements(t, p.package, v));
          else if (g.ecosystem === "maven") ok = await touch(at("pom.xml"), (t) => git.bumpPom(t, p.package, v));
          if (!ok) skipped.push(`${p.package} → ${v}`);
        }
      } else if (g.type === "toolchain") {
        const v = first(g.items[0]?.minVersion || g.packages[0]?.fixed).replace(/^v/, "");
        await touch(at("go.mod"), (t) => git.bumpGoMod(t, "stdlib", v));
        await touch(at("Dockerfile"), (t) => {
          let count = 0;
          const text = t.replace(/^(\s*FROM\s+(?:--platform=\S+\s+)?(?:\S*\/)?golang:)(\d+\.\d+(?:\.\d+)?)([^\s]*)/gim, (m, a, cur, rest) => (git.cmpVer(cur, v) < 0 ? (count++, `${a}${v}${rest}`) : m));
          return { text, count };
        });
      } else if (g.type === "base-image" && rec.baseImage) {
        await touch(at("Dockerfile"), (t) => git.bumpDockerfileFrom(t, rec.baseImage));
      }
    }
    // Release the fix under the target tag: when the build manifest's own
    // version is the running tag (1.0.0), set it to the target's (1.0.1) so
    // CI publishes exactly the image the GitOps change points at.
    const curTag = parseImageRef(rec.image)?.tag, newTag = parseImageRef(rec.target?.image || "")?.tag;
    if (curTag && newTag && curTag !== newTag) {
      const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await touch(at("pom.xml"), (t) => { let count = 0; const text = t.replace(new RegExp(`(<artifactId>[^<]+</artifactId>\\s*<version>)${esc(curTag)}(</version>)`), (m, a, z) => (count++, `${a}${newTag}${z}`)); return { text, count }; });
      await touch(at("package.json"), (t) => { let count = 0; const text = t.replace(new RegExp(`("version"\\s*:\\s*")${esc(curTag)}(")`), (m, a, z) => (count++, `${a}${newTag}${z}`)); return { text, count }; });
    }
    const baseGroup = rec.plan.groups.find((g) => g.type === "base-image");
    out.push({ repo: "source", provider: r.provider, webUrl: r.webUrl, base: ref, edits,
      note: [skipped.length ? `Not found in the manifest, bump by hand: ${skipped.join(", ")}` : null,
        baseGroup && !rec.baseImage ? `${baseGroup.items.length} OS-package CVE(s) need a rebuild on a patched base — choose the new base image to edit the Dockerfile` : null].filter(Boolean).join(" · ") || null });
  }
  return out;
}

function prBody(rec, { crNumber } = {}) {
  const rows = rec.plan.items.slice(0, 60).map((i) => `| ${i.id} | ${i.severity}${i.kev ? " · **KEV**" : ""} | ${i.epss != null ? `${(i.epss * 100).toFixed(1)}%` : "—"} | \`${i.package}\` | ${i.installed || "—"} → ${i.fixed || "no fix"} | ${i.due} |`).join("\n");
  const g = rec.gate?.eval;
  return [
    `Automated remediation proposal from **TCS Agentic AI** — record \`${rec.id}\`.`,
    "",
    `**Workload:** \`${rec.workload ? `${rec.workload.kind}/${rec.workload.name}` : "—"}\` · container \`${rec.workload?.container || "—"}\` · namespace \`${rec.namespace}\` · cluster \`${rec.cluster}\``,
    `**Image:** \`${rec.image}\`${rec.target?.image ? ` → \`${rec.target.image}\`` : ""}`,
    `**Owner:** ${rec.owner.team} · **Due:** ${rec.due || "—"}${crNumber ? ` · **Change request:** ${crNumber}` : ""}`,
    "",
    "### Findings this change closes",
    "| CVE | Severity | EPSS | Package | Installed → Fixed | Due |",
    "|---|---|---|---|---|---|",
    rows,
    rec.plan.items.length > 60 ? `\n…and ${rec.plan.items.length - 60} more (see the record).` : "",
    "",
    "### Pre-deploy gate",
    rec.gate?.mode === "ci" ? "Deferred to this repository's CI pipeline: the build must scan clean before approval." : g ? `${g.pass ? "✅ Passed" : "❌ Failed"} — Critical ${g.counts.critical}, High ${g.counts.high} in the replacement image; ${g.fixed.length} targeted CVE(s) confirmed removed.${g.warnings.length ? `\n> ${g.warnings.join("; ")}` : ""}` : "Not run.",
    "",
    "### Rollout and backout",
    "Merging this rolls the change out through your normal pipeline. The platform watches the rollout, re-scans the running image, and records the result on the change request. **Backout:** revert this PR / MR.",
  ].join("\n");
}

/** Open the PR / MR(s) and raise the change request. */
export async function raiseChange(id, { window } = {}, actor) {
  const rec = await get(id);
  if (rec.state !== "gate-passed") throw err(409, "The pre-deploy gate must pass first");
  if (!rec.workload) throw err(409, "No running workload uses this image — nothing to deploy");
  const built = await _deps.runForCluster(rec.cluster, () => buildChanges(rec));
  const withEdits = built.filter((b) => b.edits.length);
  const mode = withEdits.length ? "gitops" : "direct";
  if (mode === "direct" && process.env.REMEDIATION_DIRECT_PATCH === "false") {
    throw err(409, `No Git change could be built (${built.map((b) => b.note).filter(Boolean).join("; ") || "no source or GitOps repository is annotated on the workload"}), and direct patching is disabled by policy`);
  }
  if (mode === "direct" && !rec.target?.image) throw err(409, "A direct rollout needs a replacement image");

  // Change request first, so its number goes into the PR.
  let cr = null;
  if (_deps.snow?.enabled?.()) {
    try {
      const kev = rec.plan.items.filter((i) => i.kev);
      const created = await _deps.snow.createChangeRequest({
        shortDescription: `[Security] Remediate ${rec.plan.items.length} CVE(s) in ${rec.workload.name} — ${rec.namespace}`.slice(0, 160),
        description: [`Vulnerability remediation ${rec.id} raised by TCS Agentic AI.`, "", `Cluster: ${rec.cluster}`, `Workload: ${rec.workload.kind}/${rec.workload.name} (container ${rec.workload.container})`,
          `Image: ${rec.image}${rec.target?.image ? ` → ${rec.target.image}` : ""}`, `Owner: ${rec.owner.team}`, `Due: ${rec.due}`, kev.length ? `CISA KEV: ${kev.map((k) => k.id).join(", ")}` : "",
          `Gate: ${rec.gate?.mode === "ci" ? "CI pipeline on the source change" : rec.gate?.eval?.pass ? "passed" : "—"}`].filter(Boolean).join("\n"),
        type: "normal", risk: kev.length || rec.current.critical ? "high" : "moderate", priority: kev.length ? "1" : rec.current.critical ? "2" : "3",
        category: "Software",
        justification: `Remediate ${rec.plan.items.length} CVE(s)${kev.length ? `, ${kev.length} known exploited` : ""}; due ${rec.due}.`,
        implementationPlan: mode === "gitops" ? "Merge the linked pull/merge request; GitOps rolls it out. The platform watches the rollout and rolls back automatically on failure." : `Platform patches ${rec.workload.kind}/${rec.workload.name} container ${rec.workload.container} to ${rec.target.image} after approval; rollout watched with automatic rollback.`,
        backoutPlan: mode === "gitops" ? "Revert the pull/merge request." : `Set ${rec.workload.container} back to ${rec.workload.image}.`,
        testPlan: "Pre-deploy scan of the replacement image; rollout health; post-deploy re-scan confirms the CVEs are gone.",
        startDate: window?.start || "", endDate: window?.end || "",
        workNotes: `[TCS Agentic AI] ${rec.id} raised by ${actor}`,
      });
      const r = created?.result ? (Array.isArray(created.result) ? created.result[0] : created.result) : null;
      if (r) cr = { number: r.number, sysId: r.sys_id, state: r.state, approval: r.approval || "requested", window: window || null };
    } catch (e) { throw err(502, `ServiceNow change request failed: ${e.message}`); }
  }
  rec.changeRequest = cr;

  // PR / MR for each repository with edits.
  rec.changes = [];
  for (const b of withEdits) {
    const r = b.repo === "gitops" ? rec.repos.gitops : rec.repos.source;
    const branch = `security/${rec.id.toLowerCase()}`;
    const title = `[Security] ${b.repo === "gitops" ? `Roll ${rec.workload.name} to ${rec.target?.image?.split("/").pop()}` : `Fix ${rec.plan.items.length} CVE(s) in ${rec.workload.name}`}${cr ? ` (${cr.number})` : ""}`;
    try {
      const pr = await git.openChange(r, { base: b.base, branch, title, body: prBody(rec, { crNumber: cr?.number }), files: b.edits.map((e) => ({ path: e.path, content: e.content, sha: e.sha })) });
      rec.changes.push({ repo: b.repo, provider: r.provider, url: pr.url, number: pr.number, branch, base: b.base, files: b.edits.map((e) => ({ path: e.path, diff: e.diff, before: e.before })), status: { state: "open", checks: "pending" } });
    } catch (e) {
      throw err(502, `${r.provider === "github" ? "GitHub" : "GitLab"} change failed: ${e.message}`);
    }
  }
  rec.deploy = { mode, before: { image: rec.workload.image } };
  if (cr && rec.changes.length) {
    try { await _deps.snow.updateRecord("change_request", cr.sysId, { work_notes: `Linked changes:\n${rec.changes.map((c) => c.url).join("\n")}` }); } catch { /* best effort */ }
  }
  transition(rec, "awaiting-approval", actor, [cr ? `Change request ${cr.number} raised` : "In-app approval required (ServiceNow not configured)", ...rec.changes.map((c) => `${c.provider === "github" ? "PR" : "MR"} ${c.url}`), mode === "direct" ? "No Git change: the platform will roll out after approval" : ""].filter(Boolean).join(" · "));
  return rec;
}

/** In-app approval, when ServiceNow is not the approver. Four-eyes. */
export async function approve(id, { note: text } = {}, actor, { isAdmin }) {
  const rec = await get(id);
  if (rec.state !== "awaiting-approval") throw err(409, "Nothing is awaiting approval");
  if (rec.changeRequest) throw err(409, `Approve change request ${rec.changeRequest.number} in ServiceNow — the platform picks the approval up automatically`);
  if (!isAdmin) throw err(403, "Approving a production change needs the Admin role");
  if (actor === rec.createdBy && process.env.REMEDIATION_ALLOW_SELF_APPROVAL !== "true") throw err(403, "The requester cannot approve their own change (separation of duties)");
  rec.approval = { mode: "in-app", by: actor, at: new Date().toISOString(), note: text || "" };
  transition(rec, "approved", actor, `Approved in-app${text ? `: ${text}` : ""}`);
  return rec;
}

/** Roll out an approved, gated change that has no Git path. */
export async function deploy(id, actor) {
  const rec = await get(id);
  if (rec.state !== "approved") throw err(409, "The change must be approved first");
  if (rec.deploy?.mode !== "direct") throw err(409, "This change rolls out when its PR / MR is merged");
  const w = rec.changeRequest?.window;
  if (w?.start && Date.now() < new Date(w.start).getTime()) throw err(409, `Outside the approved window — it opens ${w.start}`);
  if (w?.end && Date.now() > new Date(w.end).getTime()) throw err(409, `The approved window closed at ${w.end} — request a new one`);
  return _deps.runForCluster(rec.cluster, async () => {
    await patchImage(rec, rec.target.image);
    rec.deploy = { ...rec.deploy, startedAt: new Date().toISOString(), by: actor };
    transition(rec, "deploying", actor, `Rolling ${rec.workload.kind}/${rec.workload.name} container ${rec.workload.container} to ${rec.target.image}`);
    return rec;
  });
}

async function patchImage(rec, image) {
  const w = rec.workload;
  await O().patch(`/apis/apps/v1/namespaces/${rec.namespace}/${w.resource}/${w.name}`, { spec: { template: { spec: { containers: [{ name: w.container, image }] } } } });
}

/** Risk acceptance: reason, compensating control, approver (Admin, not the requester), expiry. */
export async function acceptRisk(id, { reason, compensating, days }, actor, { isAdmin }) {
  const rec = await get(id);
  if (STATES[rec.state].terminal) throw err(409, "This record is closed");
  if (!isAdmin) throw err(403, "Accepting risk needs the Admin role");
  if (actor === rec.createdBy && process.env.REMEDIATION_ALLOW_SELF_APPROVAL !== "true") throw err(403, "The requester cannot accept their own risk (separation of duties)");
  if (!reason || String(reason).trim().length < 15) throw err(400, "Give a reason of at least 15 characters");
  const d = Math.min(MAX_EXCEPTION_DAYS, Math.max(1, Number(days) || 30));
  const kev = rec.plan.items.filter((i) => i.kev && i.fixed);
  if (kev.length && d > 14) throw err(400, `CVEs in CISA KEV with a fix (${kev.map((k) => k.id).join(", ")}) can be accepted for at most 14 days`);
  rec.exception = { reason: String(reason).trim(), compensating: compensating || "", by: actor, at: new Date().toISOString(), expires: new Date(Date.now() + d * 86400000).toISOString(), previousState: rec.state };
  transition(rec, "exception", actor, `Risk accepted for ${d} day(s): ${rec.exception.reason}`);
  return rec;
}

export async function cancel(id, { reason } = {}, actor) {
  const rec = await get(id);
  if (["deploying", "verifying"].includes(rec.state)) throw err(409, "A rollout is in progress — roll it back instead");
  if (STATES[rec.state].terminal) return rec;
  if (rec.changeRequest?.sysId && _deps.snow?.cancelChangeRequest) { try { await _deps.snow.cancelChangeRequest(rec.changeRequest.sysId, { reason: reason || `Cancelled ${rec.id}` }); } catch { /* best effort */ } }
  transition(rec, "cancelled", actor, reason || "Cancelled");
  return rec;
}

export async function rollback(id, actor, why) {
  const rec = await get(id);
  if (!["deploying", "verifying", "verify-failed", "deploy-failed"].includes(rec.state)) throw err(409, "Nothing to roll back");
  return _deps.runForCluster(rec.cluster, async () => {
    if (rec.deploy?.mode === "direct") {
      await patchImage(rec, rec.deploy.before.image);
      transition(rec, "rolled-back", actor, `Rolled back to ${rec.deploy.before.image}${why ? ` — ${why}` : ""}`);
    } else {
      // GitOps: a revert PR / MR restores the files; the controller rolls back.
      const reverts = [];
      for (const c of rec.changes) {
        const r = c.repo === "gitops" ? rec.repos.gitops : rec.repos.source;
        try {
          const files = [];
          for (const f of c.files) { const cur = await git.getFile(r, c.base, f.path); if (cur) files.push({ path: f.path, content: f.before, sha: cur.sha }); }
          const pr = await git.openChange(r, { base: c.base, branch: `${c.branch}-revert-${Date.now().toString(36)}`, title: `[Security] Revert ${rec.id}${why ? ` — ${why}` : ""}`, body: `Reverts ${c.url}.\n\n${why || "Rollout failed health checks."}`, files });
          reverts.push(pr.url);
        } catch (e) { reverts.push(`revert failed: ${e.message}`); }
      }
      rec.deploy.revert = reverts;
      transition(rec, "rolled-back", actor, `Revert opened: ${reverts.join(" · ")}${why ? ` — ${why}` : ""}`);
    }
    if (rec.changeRequest?.sysId) { try { await _deps.snow.updateRecord("change_request", rec.changeRequest.sysId, { work_notes: `[TCS Agentic AI] Rolled back: ${why || "manual"}` }); } catch { /* best effort */ } }
    return rec;
  });
}

/** Carry an approved, gated fix to the next environment as a linked record. */
export async function promote(id, { cluster, namespace }, actor, { scanFor }) {
  const src = await get(id);
  if (src.state !== "resolved") throw err(409, "Promote after the fix is verified in this environment");
  const scan = await scanFor(cluster, namespace, src.image);
  const rec = await create({ cluster, namespace, image: src.image, scan, actor });
  rec.parentId = src.id;
  if (src.target?.image) rec.target = { ...src.target, source: `promoted from ${src.id}` };
  rec.baseImage = src.baseImage;
  if (src.gate?.eval?.pass || src.gate?.mode === "ci") rec.gate = { ...src.gate, inheritedFrom: src.id };
  transition(rec, rec.gate ? "gate-passed" : "planned", actor, `Promoted from ${src.id} (${src.cluster}/${src.namespace})`);
  return rec;
}

/* ─────────────────────────── worker ─────────────────────────── */

async function deploymentState(rec) {
  const w = rec.workload;
  const d = await O().fetch(`/apis/apps/v1/namespaces/${rec.namespace}/${w.resource}/${w.name}`);
  const c = (d.spec?.template?.spec?.containers || []).find((x) => x.name === w.container);
  const st = d.status || {};
  const want = d.spec?.replicas ?? 1;
  const progressing = (st.conditions || []).find((x) => x.type === "Progressing");
  const done = w.resource === "daemonsets"
    ? (st.updatedNumberScheduled === st.desiredNumberScheduled && st.numberAvailable === st.desiredNumberScheduled)
    : ((st.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0) && (st.updatedReplicas ?? 0) === want && (st.availableReplicas ?? 0) === want && (st.replicas ?? want) === want);
  return { image: c?.image, done, failed: progressing?.reason === "ProgressDeadlineExceeded", message: progressing?.message || "" };
}

async function tickOne(rec) {
  const now = Date.now();
  switch (rec.state) {
    case "gating": {
      const r = await G().poll(rec.gate);
      if (!r.done) {
        if (now - new Date(rec.gate.startedAt).getTime() > 20 * 60000) { rec.gate.status = "failed"; transition(rec, "gate-failed", "system", "Pre-deploy scan timed out"); }
        return;
      }
      if (!r.ok) { rec.gate = { ...rec.gate, status: "failed", error: r.error }; transition(rec, "gate-failed", "system", r.error); return; }
      const kev = await getKevSet();
      const ev = evaluateGate(r.report, { targetCves: rec.plan.items, current: rec.current, kev });
      rec.gate = { ...rec.gate, status: ev.pass ? "passed" : "failed", report: { ...r.report, vulns: r.report.vulns.slice(0, 120) }, eval: ev };
      transition(rec, ev.pass ? "gate-passed" : "gate-failed", "system", ev.pass ? `Gate passed: ${ev.fixed.length} targeted CVE(s) removed; Critical ${ev.counts.critical}, High ${ev.counts.high}` : ev.reasons.join("; "));
      return;
    }
    case "awaiting-approval":
    case "approved": {
      // PR / MR status: CI checks, merge, closure.
      for (const c of rec.changes) {
        const r = c.repo === "gitops" ? rec.repos.gitops : rec.repos.source;
        try {
          const s = await git.changeStatus(r, c.number);
          if (s.checks !== c.status?.checks && s.checks === "failure") note(rec, "system", `CI checks failed on ${c.url}`);
          c.status = s;
        } catch (e) { c.status = { ...(c.status || {}), error: e.message }; }
      }
      if (rec.changes.some((c) => c.status?.state === "closed")) { transition(rec, "rejected", "system", "The PR / MR was closed without merging"); return; }
      if (rec.gate?.mode === "ci" && rec.changes.some((c) => c.status?.checks === "failure")) return;
      // ServiceNow approval.
      if (rec.state === "awaiting-approval" && rec.changeRequest?.sysId && _deps.snow?.getRecord) {
        try {
          const g = await _deps.snow.getRecord("change_request", rec.changeRequest.sysId);
          const r = g?.result || {};
          rec.changeRequest.state = r.state; rec.changeRequest.approval = r.approval;
          const approvedStates = String(process.env.SERVICENOW_CHANGE_APPROVED_STATES || "-2,-1").split(",").map((s) => s.trim());
          if (r.approval === "rejected" || String(r.state) === (process.env.SERVICENOW_CANCEL_STATE || "4")) { transition(rec, "rejected", "servicenow", `Change request ${rec.changeRequest.number} ${r.approval === "rejected" ? "rejected" : "cancelled"}`); return; }
          if (r.approval === "approved" || approvedStates.includes(String(r.state))) {
            rec.approval = { mode: "servicenow", by: r.sys_updated_by || "ServiceNow", at: new Date().toISOString() };
            transition(rec, "approved", "servicenow", `Change request ${rec.changeRequest.number} approved`);
          }
        } catch { /* try again next tick */ }
      }
      // A merge is the GitOps deploy. Merged before approval is recorded as a breach, not hidden.
      const merged = rec.deploy?.mode === "gitops" && rec.changes.length && rec.changes.every((c) => c.status?.state === "merged");
      if (merged) {
        if (rec.state !== "approved") note(rec, "system", "⚠ Merged before the change was approved — recorded as a process exception");
        rec.deploy = { ...rec.deploy, startedAt: new Date().toISOString(), mergedAt: new Date().toISOString() };
        transition(rec, "deploying", "system", "Merged — waiting for GitOps to sync and roll out");
      }
      return;
    }
    case "deploying": {
      const s = await deploymentState(rec);
      const started = new Date(rec.deploy.startedAt).getTime();
      const target = rec.target?.image;
      // With a chosen target, the live image must BE it; a CI-built fix has no
      // tag in advance, so any move off the old image is the rollout.
      const synced = target ? sameImage(s.image, target) : !sameImage(s.image, rec.deploy.before.image);
      if (!synced) {
        if (now - started > SYNC_TIMEOUT_MS) transition(rec, "deploy-failed", "system", `GitOps did not roll out the change within ${SYNC_TIMEOUT_MS / 60000} minutes — check the Argo CD application`);
        return;
      }
      if (!rec.deploy.syncedAt) { rec.deploy.syncedAt = new Date().toISOString(); rec.deploy.liveImage = s.image; note(rec, "system", `Rollout started with ${s.image}`); }
      if (s.failed || (!s.done && now - new Date(rec.deploy.syncedAt).getTime() > ROLLOUT_TIMEOUT_MS)) {
        await rollback(rec.id, "system", s.failed ? `rollout failed: ${s.message}` : `rollout not healthy after ${ROLLOUT_TIMEOUT_MS / 60000} minutes`);
        return;
      }
      if (s.done) { rec.deploy.completedAt = new Date().toISOString(); transition(rec, "verifying", "system", "Rollout healthy — waiting for the scanner to report on the new image"); }
      return;
    }
    case "verifying": {
      const live = rec.deploy.liveImage || rec.target?.image;
      const scanRow = _deps.scanNamespace ? await _deps.scanNamespace(rec.namespace, live) : null;
      if (!scanRow || scanRow.source === "static") {
        if (now - new Date(rec.deploy.completedAt).getTime() > VERIFY_TIMEOUT_MS) note(rec, "system", "No scanner report on the new image yet — check the Trivy Operator");
        return;
      }
      const ids = new Set((scanRow.vulnerabilities || []).map((v) => String(v.id).toUpperCase()));
      const targeted = rec.plan.items.filter((i) => i.fixed);
      const remaining = targeted.filter((i) => ids.has(String(i.id).toUpperCase())).map((i) => i.id);
      const fixed = targeted.filter((i) => !ids.has(String(i.id).toUpperCase())).map((i) => i.id);
      rec.verify = { at: new Date().toISOString(), image: live, fixed, remaining, after: { critical: scanRow.critical, high: scanRow.high, medium: scanRow.medium, low: scanRow.low } };
      if (remaining.length) { transition(rec, "verify-failed", "system", `${remaining.length} targeted CVE(s) still present: ${remaining.slice(0, 6).join(", ")}`); return; }
      if (rec.changeRequest?.sysId) {
        try {
          await _deps.snow.updateRecord("change_request", rec.changeRequest.sysId, {
            work_notes: [`── REMEDIATION VERIFIED (${rec.id}) ──`, `Image: ${rec.deploy.before.image} → ${live}`,
              `Before: ${rec.current.critical}C / ${rec.current.high}H / ${rec.current.medium}M`, `After: ${scanRow.critical}C / ${scanRow.high}H / ${scanRow.medium}M`,
              `Fixed: ${fixed.join(", ")}`, ...rec.changes.map((c) => `Change: ${c.url}`)].join("\n"),
            state: process.env.SERVICENOW_CHANGE_REVIEW_STATE || "0", close_code: "successful", close_notes: `Verified by post-deploy scan: ${fixed.length} CVE(s) removed.`,
          });
        } catch { /* evidence also on the record */ }
      }
      transition(rec, "resolved", "system", `Verified: ${fixed.length} CVE(s) removed; now ${scanRow.critical}C / ${scanRow.high}H`);
      return;
    }
    case "exception": {
      if (now > new Date(rec.exception.expires).getTime()) {
        transition(rec, "triaged", "system", `Risk acceptance expired (${rec.exception.expires.slice(0, 10)}) — reopened`);
        rec.exception = { ...rec.exception, expired: true };
      }
      return;
    }
    default:
  }
}

let _timer = null;
let _ticking = false;
export async function tick() {
  if (_ticking) return;
  _ticking = true;
  try {
    await load();
    for (const rec of _records.values()) {
      if (!ACTIVE.has(rec.state)) continue;
      try { await _deps.runForCluster(rec.cluster, () => tickOne(rec)); }
      catch (e) { rec.lastError = { at: new Date().toISOString(), message: e.message }; }
    }
  } finally { _ticking = false; }
}
export function startWorker() {
  if (_timer) return;
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (_timer.unref) _timer.unref();
}

/** Test hook. */
export function _reset() { _records.clear(); _loaded = true; }
