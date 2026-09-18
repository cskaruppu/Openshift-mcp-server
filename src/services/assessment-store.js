// ---------------------------------------------------------------------------
// Assessment snapshots and drift
// ---------------------------------------------------------------------------
/**
 * An estate assessment is out of date almost immediately. Someone enables CBT,
 * someone upgrades a guest, someone adds four VMs, someone grows a disk — and
 * the report the migration board approved last month quietly stops describing
 * reality. Every tool in this space produces assessments; almost none of them
 * tell you what CHANGED since the last one.
 *
 * Snapshots live in a ConfigMap in the cluster, for the same reason the approval
 * gate does: the comparison has to survive a pod restart, a different operator
 * and a browser refresh, and the cluster is already the thing that persists.
 *
 * diffAssessments() is pure, so the comparison is tested rather than trusted.
 */
import { ocpGet, ocpPost, ocpPatch } from "../utils/openshift-client.js";
import { readFileSync } from "node:fs";

/**
 * One ConfigMap for every provider's baseline, keyed inside `data`.
 *
 * A ConfigMap per provider would need a wildcard in the RBAC resourceNames
 * list, and Kubernetes has no wildcard there — so it would mean granting write
 * on every ConfigMap in the namespace. A single fixed name keeps the grant
 * exact.
 */
export const BASELINE_CM = "tcs-migration-assessments";

/** The namespace this agent runs in, or a sensible fallback for local runs. */
export function agentNamespace() {
  if (process.env.AGENT_NAMESPACE) return process.env.AGENT_NAMESPACE;
  try {
    const ns = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8").trim();
    if (ns) return ns;
  } catch { /* not running in-cluster */ }
  return "openshift-mcp";                 // where this agent is deployed
}

/** ConfigMap data keys allow [-._a-zA-Z0-9]; a vSphere provider uid does not. */
export function snapshotKey(provider = "default") {
  const safe = String(provider).replace(/[^-._a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(0, 200).replace(/^-+|-+$/g, "");
  return safe || "default";
}

/**
 * A stable, human-quotable identifier for one assessment run. Ends up on the
 * exported evidence pack and in the change request, so a person can say "the
 * blockers in ASM-20260902-4F2A1B" and everyone knows which run they mean.
 */
export function reportId(at = new Date(), rand = null) {
  const stamp = at.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = rand || Math.random().toString(16).slice(2, 8).toUpperCase().padEnd(6, "0");
  return `ASM-${stamp}-${suffix}`;
}

/**
 * Reduce a full analysis to the facts worth comparing. Pure.
 *
 * Deliberately small: a snapshot is stored in a ConfigMap, and ConfigMaps have
 * a 1 MiB ceiling. Keeping only what drift is measured against means a
 * thousand-VM estate still fits comfortably.
 */
export function snapshotOf(analysis, { provider = null, cluster = "local", at = new Date(), id = null } = {}) {
  // Where each machine landed last time, so a verdict that quietly changed
  // because someone replaced a worker can be named rather than discovered.
  const landing = new Map();
  for (const p of analysis?.capacity?.placement?.placed || []) {
    landing.set(p.name, { node: p.node, state: "placed" });
  }
  for (const u of analysis?.capacity?.placement?.unplaced || []) {
    landing.set(u.name, {
      node: null,
      state: u.blockedBy === "hardware" ? "never" : u.blockedBy === "wave" ? "wave-blocked" : "no-room",
    });
  }

  return {
    reportId: id || reportId(at),
    at: at.toISOString(),
    provider, cluster,
    matrixAsOf: analysis?.matrix?.asOf || null,
    total: analysis?.total || 0,
    byLevel: analysis?.byLevel || {},
    totalDiskGiB: analysis?.totalDiskGiB || 0,
    // The target, not just the source. An assessment is a claim about a
    // specific cluster on a specific day; when that cluster's nodes change, the
    // claim changes with it — and every other tool in this space would still be
    // showing last month's answer. A node list is a few dozen short entries, so
    // this stays well inside the ConfigMap ceiling.
    capacity: analysis?.capacity ? {
      verdict: analysis.capacity.verdict || null,
      virtNodeCount: analysis.capacity.virtNodeCount ?? null,
      placedCount: analysis.capacity.placement?.placedCount ?? null,
      unplacedCount: analysis.capacity.placement?.unplacedCount ?? null,
      nodes: (analysis.capacity.placement?.nodes || [])
        .map((n) => ({ name: n.name, memGiB: n.memGiB, cpuMillis: n.cpuMillis })),
    } : null,
    vms: Object.fromEntries((analysis?.rows || []).map((r) => [r.name, {
      level: r.level,
      distro: r.os?.distro || null,
      cpuCount: r.cpuCount ?? null,
      memoryGiB: r.memoryGiB ?? null,
      diskGiB: r.diskGiB || 0,
      warmEligible: r.warmEligible === true,
      poweredOn: r.poweredOn === true,
      landsOn: landing.get(r.name)?.node ?? null,
      placement: landing.get(r.name)?.state ?? null,
    }])),
  };
}

const PLACEMENT_LABEL = {
  placed: "places",
  never: "too large for any node",
  "no-room": "no node has room",
  "wave-blocked": "blocked by the machines ahead of it",
};

/**
 * What changed about the TARGET since the last assessment. Pure.
 *
 * Every product in this space hands over a report, and a report cannot know it
 * went stale. This agent lives in the destination, so it can say that two
 * workers were replaced with smaller ones at 14:00 and which verdicts moved as
 * a result — without anyone re-reading forty rows to find out.
 */
export function diffCapacity(prev, next) {
  if (!prev?.capacity || !next?.capacity) return null;
  const before = new Map((prev.capacity.nodes || []).map((n) => [n.name, n]));
  const after = new Map((next.capacity.nodes || []).map((n) => [n.name, n]));

  const added = [...after.keys()].filter((n) => !before.has(n))
    .map((n) => ({ name: n, note: `New virtualization node — ${after.get(n).memGiB} GiB.` }));
  const removed = [...before.keys()].filter((n) => !after.has(n))
    .map((n) => ({ name: n, note: `No longer available to host VMs — it had ${before.get(n).memGiB} GiB.` }));
  const resized = [];
  for (const [name, b] of before) {
    const a = after.get(name);
    if (!a || a.memGiB === b.memGiB) continue;
    resized.push({
      name, fromGiB: b.memGiB, toGiB: a.memGiB,
      note: `${a.memGiB > b.memGiB ? "Grew" : "Shrank"} from ${b.memGiB} to ${a.memGiB} GiB — every machine measured against this node has been re-checked.`,
    });
  }

  // Verdict movements, which are what a person actually acts on.
  const improved = [], regressed = [], moved = [];
  for (const [name, b] of Object.entries(prev.vms || {})) {
    const a = (next.vms || {})[name];
    if (!a || !b.placement || !a.placement) continue;
    if (a.placement !== b.placement) {
      const entry = {
        name, from: b.placement, to: a.placement,
        note: `Now ${PLACEMENT_LABEL[a.placement] || a.placement} — it previously ${PLACEMENT_LABEL[b.placement] || b.placement}.`,
      };
      (a.placement === "placed" ? improved : regressed).push(entry);
    } else if (a.placement === "placed" && a.landsOn && b.landsOn && a.landsOn !== b.landsOn) {
      moved.push({ name, from: b.landsOn, to: a.landsOn, note: `Now lands on ${a.landsOn} rather than ${b.landsOn}.` });
    }
  }

  const counts = {
    nodesAdded: added.length, nodesRemoved: removed.length, nodesResized: resized.length,
    improved: improved.length, regressed: regressed.length, moved: moved.length,
  };
  const material = added.length + removed.length + resized.length + improved.length + regressed.length;
  const changedVerdicts = improved.length + regressed.length;
  return {
    added, removed, resized, improved, regressed, moved, counts, material,
    nodeCountBefore: prev.capacity.virtNodeCount ?? null,
    nodeCountAfter: next.capacity.virtNodeCount ?? null,
    headline: material === 0
      ? "The target cluster is unchanged since the last assessment."
      : [
          added.length && `${added.length} node${added.length === 1 ? "" : "s"} added`,
          removed.length && `${removed.length} node${removed.length === 1 ? "" : "s"} gone`,
          resized.length && `${resized.length} node${resized.length === 1 ? "" : "s"} resized`,
          changedVerdicts && `${changedVerdicts} verdict${changedVerdicts === 1 ? "" : "s"} changed`,
        ].filter(Boolean).join(" · "),
  };
}

const RANK = { supported: 0, caveats: 1, unknown: 2, unsupported: 3 };

/**
 * What changed between two assessments. Pure.
 *
 * Improvements and regressions are separated on purpose. "3 VMs changed" is a
 * fact nobody can act on; "2 became migratable, 1 regressed" is a status report.
 */
export function diffAssessments(prev, next) {
  if (!prev || !next) return null;
  const before = prev.vms || {}, after = next.vms || {};

  const added = Object.keys(after).filter((n) => !(n in before))
    .map((n) => ({ name: n, level: after[n].level, note: `New in this vCenter — ${after[n].distro || "guest OS unknown"}, ${after[n].diskGiB} GiB.` }));
  const removed = Object.keys(before).filter((n) => !(n in after))
    .map((n) => ({ name: n, level: before[n].level, note: "No longer present in the source inventory." }));

  const improved = [], regressed = [], changed = [];
  for (const [name, b] of Object.entries(before)) {
    const a = after[name];
    if (!a) continue;

    if (a.level !== b.level) {
      const entry = { name, from: b.level, to: a.level, note: `Support level moved from ${b.level} to ${a.level}${a.distro !== b.distro ? ` (guest is now ${a.distro})` : ""}.` };
      (RANK[a.level] < RANK[b.level] ? improved : regressed).push(entry);
    }

    // Facts that change what a migration will DO, even when the level holds.
    if (a.warmEligible !== b.warmEligible) {
      (a.warmEligible ? improved : regressed).push({
        name, from: b.warmEligible ? "warm" : "cold-only", to: a.warmEligible ? "warm" : "cold-only",
        note: a.warmEligible
          ? "Changed block tracking is now enabled — warm migration is available, so this VM no longer needs an outage for the whole copy."
          : "Changed block tracking is no longer enabled — this VM has dropped back to cold-only.",
      });
    }
    if (a.distro !== b.distro && a.level === b.level) {
      changed.push({ name, note: `Guest OS re-reported as ${a.distro || "unknown"} (was ${b.distro || "unknown"}).` });
    }
    // 10% is the threshold at which a re-estimate is worth doing.
    if (b.diskGiB > 0 && Math.abs(a.diskGiB - b.diskGiB) / b.diskGiB > 0.1) {
      changed.push({
        name,
        note: `Storage ${a.diskGiB > b.diskGiB ? "grew" : "shrank"} from ${b.diskGiB} to ${a.diskGiB} GiB — the transfer estimate for this VM has moved.`,
      });
    }
  }

  // The source is only half of an assessment. A cluster whose workers were
  // replaced overnight invalidates verdicts nobody touched.
  const capacity = diffCapacity(prev, next);

  const counts = { added: added.length, removed: removed.length, improved: improved.length, regressed: regressed.length, changed: changed.length, capacity: capacity?.material || 0 };
  const material = counts.added + counts.removed + counts.improved + counts.regressed + counts.changed + counts.capacity;
  return {
    since: prev.at, sinceReportId: prev.reportId,
    added, removed, improved, regressed, changed, counts, material, capacity,
    headline: material === 0
      ? `Nothing has changed since ${prev.reportId}.`
      : [
          counts.added && `${counts.added} new`,
          counts.removed && `${counts.removed} gone`,
          counts.improved && `${counts.improved} improved`,
          counts.regressed && `${counts.regressed} regressed`,
          counts.changed && `${counts.changed} otherwise changed`,
          counts.capacity && `target: ${capacity.headline}`,
        ].filter(Boolean).join(" · "),
  };
}

// ── Persistence ────────────────────────────────────────────────────────────
/** The previous assessment for this provider, or null on the first ever run. */
export async function loadSnapshot(provider) {
  const ns = agentNamespace();
  const cm = await ocpGet(`/api/v1/namespaces/${ns}/configmaps/${BASELINE_CM}`).catch(() => null);
  const raw = cm?.data?.[snapshotKey(provider)];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Record this assessment as the new baseline. Best-effort: an assessment that
 * cannot be saved is still a valid assessment, so a failure here never fails
 * the report — it only means the next run has nothing to compare against.
 */
export async function saveSnapshot(provider, snapshot) {
  const ns = agentNamespace();
  const name = BASELINE_CM;
  const body = {
    apiVersion: "v1", kind: "ConfigMap",
    metadata: {
      name, namespace: ns,
      labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai", "tcs.agentic-ai/kind": "migration-assessment" },
      annotations: { "tcs.agentic-ai/last-report-id": snapshot.reportId, "tcs.agentic-ai/last-assessed-at": snapshot.at },
    },
    // A merge patch on `data` replaces only this provider's key, so two
    // vCenters assessed by two people do not overwrite each other.
    data: { [snapshotKey(provider)]: JSON.stringify(snapshot) },
  };
  // Patch the existing baseline; create it the first time. Either order needs a
  // fallback, and patch-then-create keeps the common path to one call.
  try {
    await ocpPatch(`/api/v1/namespaces/${ns}/configmaps/${name}`,
      { metadata: body.metadata, data: body.data }, "application/merge-patch+json");
    return { ok: true, name, namespace: ns };
  } catch {
    try {
      await ocpPost(`/api/v1/namespaces/${ns}/configmaps`, body);
      return { ok: true, name, namespace: ns, created: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}
