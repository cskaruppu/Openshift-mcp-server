// ---------------------------------------------------------------------------
// One estate, many clusters
// ---------------------------------------------------------------------------
/**
 * A containerisation assessment run per cluster answers the wrong question.
 *
 * The product manages a fleet, and the same vCenter is frequently registered
 * in more than one cluster's MTV — a hub and a DR site, or two teams who each
 * added it. Assess per cluster and one machine is counted twice, appears twice
 * in the candidate rate, and if the two runs used different guest credentials
 * it can be a candidate in one and blocked in the other. A funnel built on
 * that is wrong in the direction that flatters it.
 *
 * So: identify machines, merge what is provably the same machine, and refuse
 * to merge what merely looks similar.
 *
 * IDENTITY, strongest first:
 *   biosUuid       — follows the machine. Two clusters reporting the same BIOS
 *                    UUID are looking at one machine, and that is a fact.
 *   vcenter+moref  — a managed object id is unique WITHIN a vCenter, so this
 *                    holds only when the vCenter URL matches too.
 *   hostname       — a hint, never a merge. Two machines share a hostname more
 *                    often than anyone expects, and silently merging a pair of
 *                    them would hide one of them completely.
 *
 * Everything here is pure.
 */

import { VERDICTS } from "./containerization-readiness.js";

/** Verdicts that mean "we did not assess this". */
const NOT_ASSESSED = new Set([VERDICTS.UNREADABLE, VERDICTS.POWERED_OFF]);

/** Rank, so the strongest available evidence for a verdict wins a merge. */
const VERDICT_RANK = {
  [VERDICTS.POWERED_OFF]: 0,
  [VERDICTS.UNREADABLE]: 1,
  [VERDICTS.INCONCLUSIVE]: 2,
  [VERDICTS.READY]: 3,
  [VERDICTS.WITH_WORK]: 4,
  // A blocker found anywhere in the fleet is the fact that matters. If one
  // cluster's credential could see the Postgres and another's could not, the
  // machine has a Postgres.
  [VERDICTS.VM_ONLY]: 5,
};

/**
 * A stable key for one observation.
 *
 * @param {object} entry { cluster, provider, vcenterUrl, vm, guest, result }
 */
export function machineIdentity(entry = {}) {
  const g = entry.guest || {};
  const vm = entry.vm || {};
  const bios = (g.biosUuid || vm.biosUuid || "").trim().toLowerCase();
  if (bios) return { key: `bios:${bios}`, basis: "biosUuid", confidence: "certain" };

  const vc = (entry.vcenterUrl || g.vcenterUrl || "").replace(/\/+$/, "").toLowerCase();
  const moref = (g.vmId || vm.id || "").trim();
  if (vc && moref) return { key: `vc:${vc}|${moref}`, basis: "vCenter + managed object id", confidence: "certain" };

  const host = (g.hostname || vm.hostname || "").trim().toLowerCase();
  if (host) return { key: `host:${host}`, basis: "hostname", confidence: "probable" };

  const name = (g.name || vm.name || "").trim().toLowerCase();
  return { key: `name:${name || Math.random().toString(36).slice(2)}`, basis: "name only", confidence: "weak" };
}

/**
 * Merge observations of the same machine across clusters.
 *
 * @param {Array} entries [{ cluster, provider, vcenterUrl, vm, guest, result }]
 * @returns {{machines:Array, duplicates:Array, conflicts:Array, possible:Array}}
 */
export function deduplicate(entries = []) {
  const byKey = new Map();
  for (const e of entries) {
    const id = machineIdentity(e);
    if (!byKey.has(id.key)) byKey.set(id.key, { id, observations: [] });
    byKey.get(id.key).observations.push(e);
  }

  const machines = [], duplicates = [], conflicts = [];
  for (const { id, observations } of byKey.values()) {
    // The observation that saw the most wins, and the rest are kept — a
    // merged record that discards the other readings cannot be audited.
    const ranked = [...observations].sort(
      (a, b) => (VERDICT_RANK[b.result?.verdict] ?? -1) - (VERDICT_RANK[a.result?.verdict] ?? -1),
    );
    const best = ranked[0];
    const seenIn = observations.map((o) => ({
      cluster: o.cluster || null, provider: o.provider || null, vcenter: o.vcenterUrl || null,
      verdict: o.result?.verdict || null,
    }));

    const verdicts = [...new Set(seenIn.map((s) => s.verdict).filter(Boolean))];
    if (observations.length > 1) {
      duplicates.push({ key: id.key, basis: id.basis, name: best.result?.name || best.vm?.name || null, seenIn });
    }
    // Disagreement is a finding, not noise to be smoothed away. The usual
    // cause is that one cluster's run had a guest credential and the other's
    // did not, and saying so sends someone to fix the run rather than to
    // argue with the verdict.
    if (verdicts.length > 1) {
      const assessed = seenIn.filter((s) => !NOT_ASSESSED.has(s.verdict));
      conflicts.push({
        key: id.key, name: best.result?.name || best.vm?.name || null, seenIn,
        resolved: best.result?.verdict || null,
        why: assessed.length < seenIn.length
          ? "One cluster could not read inside this machine and another could. The reading that saw more is used."
          : "The same machine scored differently in two clusters, and both runs read it. The stricter verdict is used — a blocker found anywhere in the fleet is a blocker.",
      });
    }

    machines.push({
      identity: id,
      name: best.result?.name || best.vm?.name || null,
      result: best.result || null,
      seenIn,
      clusters: [...new Set(seenIn.map((s) => s.cluster).filter(Boolean))],
      duplicated: observations.length > 1,
      conflicting: verdicts.length > 1,
    });
  }

  // Machines merged only because their hostnames matched. Surfaced separately
  // so nobody discovers later that two unrelated boxes were counted as one.
  const possible = machines
    .filter((m) => m.duplicated && m.identity.confidence !== "certain")
    .map((m) => ({
      name: m.name, basis: m.identity.basis, confidence: m.identity.confidence, seenIn: m.seenIn,
      note: "Merged on a weaker key than a machine UUID. Confirm these are the same machine before trusting the count.",
    }));

  return { machines, duplicates, conflicts, possible };
}

/**
 * The portfolio view — what a programme is planned from.
 *
 * Machine-level verdicts answer "what do I do with this box". A portfolio
 * answers "where does the work actually sit", and the top blockers are the
 * number that decides whether a containerisation programme is six weeks or two
 * years: fifty machines blocked on a local database is one workstream, not
 * fifty problems.
 */
export function portfolio(machines = []) {
  const byVerdict = {}, byRuntime = {}, byBlocker = new Map(), byCluster = {};

  for (const m of machines) {
    const r = m.result || {};
    byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
    for (const c of m.clusters) byCluster[c] = (byCluster[c] || 0) + 1;
    for (const rt of r.runtimes || []) byRuntime[rt.label] = (byRuntime[rt.label] || 0) + 1;
    for (const b of [...(r.blockers || []), ...(r.concerns || []).filter((c) => c.required)]) {
      if (!byBlocker.has(b.id)) byBlocker.set(b.id, { id: b.id, title: b.title, blocks: !!b.blocks, machines: [] });
      byBlocker.get(b.id).machines.push(m.name);
    }
  }

  const topBlockers = [...byBlocker.values()]
    .map((b) => ({ ...b, count: b.machines.length, machines: b.machines.slice(0, 12) }))
    .sort((a, b) => b.count - a.count || Number(b.blocks) - Number(a.blocks));

  return {
    byVerdict,
    byRuntime: Object.entries(byRuntime).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
    byCluster,
    topBlockers,
    note: topBlockers.length
      ? `The largest single reason is "${topBlockers[0].title}" on ${topBlockers[0].count} machine${topBlockers[0].count === 1 ? "" : "s"}. Reasons cluster: a programme plans against ${topBlockers.length} of them, not against every machine separately.`
      : "No blockers or required work were recorded across the estate.",
  };
}

/**
 * The fleet funnel, over de-duplicated machines.
 *
 * Deliberately separate from the per-cluster funnel: this one is the number
 * that goes on a slide, and it must count each machine once.
 */
export function fleetFunnel(machines = []) {
  const total = machines.length;
  let assessed = 0, candidates = 0;
  for (const m of machines) {
    const v = m.result?.verdict;
    if (!NOT_ASSESSED.has(v)) assessed++;
    if (v === VERDICTS.READY || v === VERDICTS.WITH_WORK) candidates++;
  }
  return {
    total, assessed, notAssessed: total - assessed, candidates,
    candidatePctOfEstate: total ? Math.round((candidates / total) * 100) : 0,
    candidatePctOfAssessed: assessed ? Math.round((candidates / assessed) * 100) : 0,
    note: assessed === total
      ? `All ${total} distinct machines were assessed.`
      : `${assessed} of ${total} distinct machines were assessed. ${total - assessed} could not be read and ${total - assessed === 1 ? "is" : "are"} not counted as a candidate or as blocked.`,
  };
}

/**
 * What talks to what — the gap this agent cannot close on its own.
 *
 * Network flows are not visible from vCenter and cannot be read without
 * executing something in the guest, so they are SUPPLIED: an export from NSX,
 * Device42, a CMDB or an APM. When they are, a candidate that is talked to by
 * a machine staying as a VM is flagged, because that dependency crosses the
 * boundary between the two destinations and is exactly what breaks a wave.
 *
 * When they are not supplied, that is stated rather than passed over — a
 * migration plan built with no dependency data is a plan with a known hole in
 * it, and the hole should be on the page.
 */
export function dependencyView(machines = [], flows = null) {
  if (!Array.isArray(flows) || !flows.length) {
    return {
      supplied: false,
      note: "No dependency data was supplied, so nothing is known about what these machines talk to. Network flows cannot be read from vCenter and this agent runs nothing inside a guest. Export them from NSX, Device42, a CMDB or your APM and supply them here.",
      crossings: [],
    };
  }

  const byName = new Map(machines.map((m) => [String(m.name || "").toLowerCase(), m]));
  const staysVm = (n) => byName.get(String(n || "").toLowerCase())?.result?.verdict === VERDICTS.VM_ONLY;
  const isCandidate = (n) => {
    const v = byName.get(String(n || "").toLowerCase())?.result?.verdict;
    return v === VERDICTS.READY || v === VERDICTS.WITH_WORK;
  };

  const crossings = [];
  for (const f of flows) {
    const from = f.from || f.source, to = f.to || f.destination;
    if (!from || !to) continue;
    if (isCandidate(to) && staysVm(from)) {
      crossings.push({ from, to, port: f.port || null, direction: "vm-to-container",
        note: `${from} stays a VM and talks to ${to}, which would become a container. That dependency crosses platforms — confirm the route and the network policy before the wave.` });
    }
    if (isCandidate(from) && staysVm(to)) {
      crossings.push({ from, to, port: f.port || null, direction: "container-to-vm",
        note: `${from} would become a container and depends on ${to}, which stays a VM. The container needs egress to it, which the default-deny policy in the proposal does not allow.` });
    }
  }
  return {
    supplied: true, flows: flows.length, crossings,
    note: crossings.length
      ? `${crossings.length} dependenc${crossings.length === 1 ? "y crosses" : "ies cross"} between machines that would become containers and machines that stay VMs. Each one needs a route and a network policy that the proposal does not yet contain.`
      : `${flows.length} flows supplied and none crosses between the two destinations.`,
  };
}

/** The whole fleet analysis in one call. */
export function fleetAnalysis(entries = [], { flows = null } = {}) {
  const dedup = deduplicate(entries);
  return {
    ...dedup,
    funnel: fleetFunnel(dedup.machines),
    portfolio: portfolio(dedup.machines),
    dependencies: dependencyView(dedup.machines, flows),
    observations: entries.length,
    distinct: dedup.machines.length,
    note: entries.length === dedup.machines.length
      ? `${entries.length} machines, each seen once.`
      : `${entries.length} observations across the fleet resolved to ${dedup.machines.length} distinct machine${dedup.machines.length === 1 ? "" : "s"}. `
        + `${entries.length - dedup.machines.length} ${entries.length - dedup.machines.length === 1 ? "was a machine" : "were machines"} already seen in another cluster.`,
  };
}
