// ---------------------------------------------------------------------------
// What this wave costs, before and after
// ---------------------------------------------------------------------------
/**
 * The business case, and the number a customer's procurement team will attack
 * hardest — so it is built to survive that rather than to look large.
 *
 * Four rules, each of which exists because the opposite loses the argument:
 *
 *  1. COUNTABLE AND PRICED ARE SEPARATE. Hosts, sockets, cores, nodes, vCPU and
 *     storage are read from the estate and the cluster, and always render. The
 *     money needs a rate card, and no API anywhere returns what a customer pays
 *     for vSphere — vCenter does not expose it, because it does not know. So
 *     with no rate card there is no money, and everything else still works.
 *  2. AN UNPRICED LINE SHOWS NOTHING, NEVER ZERO. A missing rate quietly priced
 *     at nought is how a saving becomes indefensible in one line.
 *  3. THE ARITHMETIC IS SHOWN. Every figure carries the multiplication that
 *     produced it, the way the AI cost basis already does.
 *  4. NO LIST-VERSUS-DISCOUNTED COMPARISON. Pricing VMware at list against
 *     OpenShift at the customer's negotiated rate is a rigged win, and the
 *     mixture is flagged rather than quietly totalled.
 *
 * Deliberately excluded: power, cooling, rack space, staff time, hardware
 * refresh. Each makes the number bigger and the argument weaker, because each
 * invites a debate about assumptions instead of about the migration.
 *
 * Everything here is pure.
 */

/**
 * OpenShift Virtualization Engine is licensed per BARE-METAL WORKER NODE.
 *
 * Not per core, not per socket. Red Hat's self-managed subscription guide:
 * "One bare-metal node subscription is required per physical server... A
 * physical node is 1 server regardless of the number of CPU sockets in the
 * server, or cores in the CPUs." Control plane nodes are included and are not
 * counted.
 *
 * This has a consequence the panel has to state, because it inverts the usual
 * intuition: the subscription cost does NOT scale with the wave. Migrating
 * twice as many machines onto the same nodes costs the same. It is a property
 * of the cluster, not of what is running on it.
 */
export const OPENSHIFT_LICENSE_UNIT = "bare-metal worker node";

/**
 * The rate card, as configuration. Same shape and the same discipline as
 * MODEL_PRICING: supply your own and the figure is exact; supply nothing and
 * there is no figure at all.
 *
 *   INFRA_PRICING = {"vspherePerSocketYear":3450,"vcenterPerInstanceYear":6000,
 *                    "openshiftPerNodeYear":12000,"socketsPerHost":2,
 *                    "currency":"USD","basis":"configured"}
 */
export function infraPricing(env = process.env) {
  const raw = env.INFRA_PRICING;
  if (!raw) {
    return { configured: false, rates: null, source: "none", asOf: null,
      reason: "No rate card is configured. Set INFRA_PRICING to your own licensing rates — nothing here is guessed, and no API reports what you pay for vSphere." };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    return { configured: false, rates: null, source: "none", asOf: null,
      reason: "INFRA_PRICING is not valid JSON, so no cost is shown. A cost figure built on a rate card nobody could read would be worse than none." };
  }
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return {
    configured: true,
    source: parsed.basis === "list" ? "list-price" : "configured",
    asOf: env.INFRA_PRICING_AS_OF || parsed.asOf || null,
    currency: parsed.currency || "USD",
    rates: {
      vspherePerSocketYear: num(parsed.vspherePerSocketYear),
      vcenterPerInstanceYear: num(parsed.vcenterPerInstanceYear),
      openshiftPerNodeYear: num(parsed.openshiftPerNodeYear),
      socketsPerHost: num(parsed.socketsPerHost),
      vcenterInstances: num(parsed.vcenterInstances) ?? 1,
    },
    reason: null,
  };
}

/**
 * A negative is written "-$77,100", not "$-77,100". The second is what naive
 * concatenation produces, and it reads as a typo in exactly the meeting where
 * the number is being questioned.
 */
const money = (n, currency = "USD") => {
  const sym = { USD: "$", EUR: "€", GBP: "£", INR: "₹" }[currency] || "";
  const v = Math.round(n);
  return `${v < 0 ? "-" : ""}${sym}${Math.abs(v).toLocaleString()}`;
};

/**
 * What the estate looks like on both sides, counted. Pure.
 *
 * @param {Array}  vms        normalised VMs (for host count, vCPU, storage)
 * @param {object} capacity   capacityVerdict() output (for nodes and cores)
 * @param {object} rightsizing fleetRightSizing() output, optional
 */
export function footprint(vms = [], capacity = null, rightsizing = null) {
  // Distinct ESXi hosts carrying these machines. Discovery already reads it.
  const hosts = [...new Set(vms.map((v) => v.host).filter(Boolean))];
  const vcpu = vms.reduce((n, v) => n + (v.cpuCount || 0), 0);
  const memGiB = vms.reduce((n, v) => n + (v.memoryGiB || 0), 0);
  const diskGiB = vms.reduce((n, v) => n + (v.diskGiB || 0), 0);

  // After right-sizing, over the machines that were actually measured. The
  // rest keep their configured size, which is why this is never presented as
  // "the estate's vCPU after right-sizing".
  const freedVcpu = rightsizing?.saving?.vcpuFreed ?? null;
  const vcpuAfter = freedVcpu == null ? null : vcpu - freedVcpu;

  const nodes = capacity?.placement?.available ? capacity.placement.nodesUsed : null;
  const nodeList = capacity?.placement?.nodes || [];
  return {
    source: {
      vmCount: vms.length,
      hostCount: hosts.length || null,
      hosts,
      vcpu, memGiB, diskGiB,
      // Never inferred: a VM's coresPerSocket says nothing about the physical
      // sockets in the host underneath it.
      socketsKnown: false,
    },
    target: {
      nodesUsed: nodes,
      nodesTotal: capacity?.virtNodeCount ?? null,
      vcpu, vcpuAfter,
      // Every virtualization-capable worker, because that is the licensing
      // unit — not the subset this wave lands on.
      virtNodes: capacity?.virtNodeCount ?? null,
    },
    rightsized: rightsizing
      ? { measured: rightsizing.coverage.measured, total: rightsizing.coverage.total, vcpuFreed: freedVcpu }
      : null,
  };
}

/**
 * The before-and-after, priced only as far as the rate card allows. Pure.
 */
export function tcoComparison(vms = [], capacity = null, opts = {}) {
  const pricing = opts.pricing || infraPricing(opts.env);
  const fp = footprint(vms, capacity, opts.rightsizing || null);
  const rates = pricing.rates;
  const currency = pricing.currency || "USD";
  const lines = [];
  const notes = [];

  // ── Source side ──────────────────────────────────────────────────────────
  let sourceAnnual = null;
  const sourceRows = [
    { k: "Hosts carrying these VMs", v: fp.source.hostCount == null ? null : String(fp.source.hostCount),
      why: fp.source.hostCount == null ? "The inventory did not report which host each machine runs on." : null },
    { k: "Allocated vCPU", v: String(fp.source.vcpu) },
    { k: "Storage to move", v: `${(fp.source.diskGiB / 1024).toFixed(1)} TiB` },
  ];

  if (rates?.vspherePerSocketYear != null && rates.socketsPerHost != null && fp.source.hostCount != null) {
    const sockets = fp.source.hostCount * rates.socketsPerHost;
    const vsphere = sockets * rates.vspherePerSocketYear;
    const vcenter = (rates.vcenterPerInstanceYear ?? 0) * (rates.vcenterInstances ?? 1);
    sourceAnnual = vsphere + (rates.vcenterPerInstanceYear != null ? vcenter : 0);
    sourceRows.push({ k: "vSphere licensing", v: `${money(vsphere, currency)} / yr` });
    lines.push(`vSphere: ${fp.source.hostCount} hosts × ${rates.socketsPerHost} sockets × ${money(rates.vspherePerSocketYear, currency)} = ${money(vsphere, currency)}/yr`);
    if (rates.vcenterPerInstanceYear != null) {
      sourceRows.push({ k: "vCenter", v: `${money(vcenter, currency)} / yr` });
      lines.push(`vCenter: ${rates.vcenterInstances} × ${money(rates.vcenterPerInstanceYear, currency)} = ${money(vcenter, currency)}/yr`);
    }
  } else if (pricing.configured) {
    notes.push(rates?.socketsPerHost == null
      ? "vSphere licensing is not priced: socketsPerHost is missing from the rate card, and the number of physical sockets in an ESXi host cannot be derived from the VM inventory."
      : "vSphere licensing is not priced: no vspherePerSocketYear rate was supplied.");
  }

  // ── Target side ──────────────────────────────────────────────────────────
  let targetAnnual = null;
  const targetRows = [
    { k: "Nodes this wave uses", v: fp.target.nodesUsed == null ? null : `${fp.target.nodesUsed} of ${fp.target.nodesTotal}`,
      why: fp.target.nodesUsed == null ? "Placement could not be simulated, so the node count is unknown." : null },
    { k: "Allocated vCPU", v: fp.target.vcpuAfter == null ? String(fp.target.vcpu) : `${fp.target.vcpuAfter} (from ${fp.target.vcpu})` },
  ];

  // Licensed nodes are every virtualization-capable WORKER in the cluster, not
  // the subset this wave happens to land on. You subscribe the node; what runs
  // on it is not the unit. Counting only the wave's nodes would under-quote the
  // subscription, which is the direction that embarrasses someone in front of
  // procurement.
  const licensedNodes = fp.target.virtNodes;
  if (licensedNodes != null) {
    targetRows.push({ k: "Worker nodes to license", v: String(licensedNodes) });
  }

  if (licensedNodes != null && rates?.openshiftPerNodeYear != null) {
    targetAnnual = licensedNodes * rates.openshiftPerNodeYear;
    targetRows.push({ k: "OpenShift Virtualization", v: `${money(targetAnnual, currency)} / yr` });
    lines.push(`OpenShift: ${licensedNodes} bare-metal worker nodes × ${money(rates.openshiftPerNodeYear, currency)} = ${money(targetAnnual, currency)}/yr`);
    notes.push("OpenShift Virtualization Engine is licensed per bare-metal worker node — sockets and cores do not change the count, and control plane nodes are included rather than charged. So this figure does not scale with the wave: migrating twice as many machines onto these same nodes costs the same, and the cost per VM falls as you consolidate.");
  } else if (pricing.configured && rates?.openshiftPerNodeYear == null) {
    notes.push("OpenShift Virtualization is not priced: no openshiftPerNodeYear rate was supplied. It is licensed per bare-metal worker node, not per core or socket.");
  }

  // ── The comparison, only when both sides are real ────────────────────────
  const comparable = sourceAnnual != null && targetAnnual != null;
  const saving = comparable ? sourceAnnual - targetAnnual : null;

  if (pricing.source === "list-price") {
    notes.push("These are list prices. They ignore enterprise agreements, committed-use discounts and any negotiated renewal, so for most organisations they are the wrong number until INFRA_PRICING carries your own rates. Comparing a list price on one side against a negotiated price on the other is not a comparison.");
  }
  if (opts.rightsizing?.caveat) notes.push(opts.rightsizing.caveat);
  notes.push("Licensing only. Power, cooling, rack space, hardware refresh and staff time are deliberately excluded — each would make the saving larger and the argument weaker.");

  return {
    priced: comparable,
    currency,
    source: { rows: sourceRows, annual: sourceAnnual, annualLabel: sourceAnnual == null ? null : money(sourceAnnual, currency) },
    target: { rows: targetRows, annual: targetAnnual, annualLabel: targetAnnual == null ? null : money(targetAnnual, currency) },
    saving,
    savingLabel: saving == null ? null : `${money(Math.abs(saving), currency)} / yr`,
    // Which direction, in words. A migration that costs more is a fact the
    // customer needs before they sign, not after — and a panel that only knows
    // how to say "saved" is one nobody should trust with the other answer.
    savingDirection: saving == null ? null : saving > 0 ? "saved" : saving < 0 ? "more, not less" : "no change",
    headline: comparable
      ? saving >= 0
        ? `${money(sourceAnnual, currency)} a year today, ${money(targetAnnual, currency)} after — ${money(saving, currency)} a year less.`
        : `${money(sourceAnnual, currency)} a year today, ${money(targetAnnual, currency)} after. On these rates the migration costs ${money(-saving, currency)} a year MORE, and that is the number to take into the decision.`
      : pricing.configured
        ? "The footprint below is measured. The cost is not shown, because the rate card is missing the rates it would need — a figure built on a gap is worse than no figure."
        : "The footprint below is measured from your estate and this cluster. No cost is shown: nothing reports what you pay for vSphere, so the rates have to be configured.",
    basis: { source: pricing.source, asOf: pricing.asOf, lines, reason: pricing.reason },
    notes,
    footprint: fp,
  };
}
