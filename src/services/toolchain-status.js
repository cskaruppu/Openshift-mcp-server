// ---------------------------------------------------------------------------
// Is the toolchain actually there?
// ---------------------------------------------------------------------------
/**
 * Every layer this agent hands work to, checked against the live cluster.
 *
 * The first version of the toolchain table checked MTA and drew the other four
 * rows green from a literal. That is worse than not showing them: a green dot
 * beside "Tekton" on a cluster with no OpenShift Pipelines is the product
 * telling a customer something it has not looked at, in the one panel whose
 * entire purpose is to be checkable. So every row is now a real API probe.
 *
 * Two things this is careful about:
 *
 *  1. WHAT EACH LAYER IS REQUIRED FOR. Discovery needs MTV and a vCenter.
 *     It does NOT need Tekton, and blocking discovery because OpenShift
 *     Pipelines is absent would be inventing a dependency that does not exist.
 *     So each component declares which capability it gates, and the console
 *     disables exactly that capability and no more.
 *
 *  2. MISSING vs UNREADABLE. A 403 means the thing is installed and we may not
 *     look at it, which is a role to grant. Reported as "not installed" it
 *     sends someone to reinstall a product that is running — the same trap
 *     the MTV and MTA checks already avoid, now applied to all five.
 *
 * Never throws.
 */

import { ocpGet } from "../utils/openshift-client.js";

/** What a capability needs before the console should offer it. */
export const CAPABILITIES = Object.freeze({
  DISCOVER: "discover",     // list VMs on a source provider and read their guests
  ANALYSE: "code-analysis", // MTA's view of the application
  BUILD: "build",           // BuildConfig / ImageStream
  PIPELINE: "pipeline",     // Tekton
  RUN_VM: "run-vm",         // the VM destination, for machines that stay machines
});

const COMPONENTS = [
  {
    id: "mtv", layer: "VM migration", tool: "MTV / Konveyor Forklift",
    provenance: "Red Hat, in your subscription",
    gates: [CAPABILITIES.DISCOVER],
    probe: "/apis/forklift.konveyor.io/v1beta1/providers",
    absent: "MTV is not installed. The Containerization Agent reads its VM inventory and its vCenter credential from MTV, so discovery cannot run without it. Install the Migration Toolkit for Virtualization from OperatorHub.",
  },
  {
    id: "build", layer: "Build", tool: "OpenShift BuildConfig · Buildah",
    provenance: "Ships with OpenShift",
    gates: [CAPABILITIES.BUILD],
    probe: "/apis/build.openshift.io/v1/buildconfigs",
    absent: "The build API is not served by this cluster. On OpenShift it always is; on plain Kubernetes it is not, and the build proposal would produce manifests nothing can apply.",
  },
  {
    id: "tekton", layer: "Pipeline", tool: "Tekton · OpenShift Pipelines",
    provenance: "Red Hat operator, CNCF project",
    gates: [CAPABILITIES.PIPELINE],
    probe: "/apis/tekton.dev/v1/pipelines",
    absent: "OpenShift Pipelines is not installed. The binary build path still works without it — the pipeline is what the build becomes once the application has a repository. Install it from OperatorHub when you get there.",
  },
  {
    id: "kubevirt", layer: "Run — virtual machines", tool: "OpenShift Virtualization · KubeVirt",
    provenance: "Red Hat",
    gates: [CAPABILITIES.RUN_VM],
    probe: "/apis/kubevirt.io/v1/virtualmachines",
    absent: "OpenShift Virtualization is not installed. Machines this assessment says to keep as VMs would have nowhere to land on this cluster — which is the half of the answer that makes the disposition useful.",
  },
];

const nowIso = () => new Date().toISOString();

/**
 * One probe. Returns the three states that matter and never conflates them.
 *
 * `present` is deliberately tri-state: true, false, or null when we could not
 * find out. A null is rendered differently from a false, because "we could not
 * check" and "it is not there" lead somewhere different.
 */
async function probe(path) {
  try {
    await ocpGet(path);
    return { present: true, readable: true, status: 200, reason: null };
  } catch (e) {
    const m = /OCP API (\d{3})/.exec(e.message || "");
    const status = m ? Number(m[1]) : 0;
    if (status === 404) return { present: false, readable: true, status, reason: null };
    if (status === 403) {
      return {
        present: true, readable: false, status,
        reason: "Installed, but this service account may not read it. Grant read on this API group — a cluster-side role binding, no image rebuild.",
      };
    }
    if (status === 401) return { present: null, readable: false, status, reason: "The cluster rejected the credential." };
    // A cluster that is not reachable at all produces a URL-parse or socket
    // error, and surfacing that verbatim tells an operator nothing they can
    // act on — "Failed to parse URL from https://undefined:undefined" is the
    // API server address being unset, not a missing operator.
    if (/Failed to parse URL|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|fetch failed/i.test(e.message || "")) {
      return { present: null, readable: false, status, reason: "This cluster could not be reached, so nothing on it could be checked. The toolchain may well be installed." };
    }
    return { present: null, readable: false, status, reason: `Could not be checked: ${e.message}` };
  }
}

/**
 * The whole toolchain, plus which capabilities are safe to offer.
 *
 * @returns {{components:Array, capabilities:object, checkedAt:string}}
 */
export async function toolchainStatus(opts = {}) {
  const components = [];

  for (const c of COMPONENTS) {
    const r = await probe(c.probe);
    components.push({
      id: c.id, layer: c.layer, tool: c.tool, provenance: c.provenance, gates: c.gates,
      // usable means: it is there AND we can see it. Anything else disables
      // what it gates, with the reason attached rather than a bare red dot.
      usable: r.present === true && r.readable === true,
      present: r.present, readable: r.readable,
      reason: r.present === false ? c.absent : r.reason,
    });
  }

  // MTA has its own richer check — several API groups, several namespaces and
  // a Hub route — so it is delegated rather than duplicated here.
  try {
    const { mtaReadiness } = await import("./mta-client.js");
    const mta = await mtaReadiness(opts.env || process.env);
    components.splice(1, 0, {
      id: "mta", layer: "Code analysis",
      tool: `Red Hat MTA${mta.flavour ? ` · ${mta.flavour}` : ""}`,
      provenance: "Red Hat operator, Konveyor upstream",
      gates: [CAPABILITIES.ANALYSE],
      usable: mta.ok === true,
      present: mta.installed, readable: mta.readable,
      reason: mta.ok ? null : ((mta.blocking || [])[0]?.message || (mta.warnings || [])[0]?.message || null),
      hubUrl: mta.hubUrl || null,
    });
  } catch (e) {
    components.splice(1, 0, {
      id: "mta", layer: "Code analysis", tool: "Red Hat MTA",
      provenance: "Red Hat operator, Konveyor upstream", gates: [CAPABILITIES.ANALYSE],
      usable: false, present: null, readable: false, reason: `Could not be checked: ${e.message}`,
    });
  }

  // This product's own layer. Stated, not probed — it is the thing doing the
  // probing. Claiming to have verified itself would be theatre.
  components.push({
    id: "agent", layer: "Discovery, disposition, evidence", tool: "TCS Agentic AI",
    provenance: "This product", gates: [], usable: true, present: true, readable: true, reason: null, self: true,
  });

  // A capability is offered only when everything gating it is usable, and
  // carries the reasons it is not so the console never disables a button
  // without saying why.
  const capabilities = {};
  for (const key of Object.values(CAPABILITIES)) {
    const needed = components.filter((c) => (c.gates || []).includes(key));
    const missing = needed.filter((c) => !c.usable);
    capabilities[key] = {
      ready: missing.length === 0,
      requires: needed.map((c) => c.tool),
      blockedBy: missing.map((c) => ({ id: c.id, tool: c.tool, reason: c.reason })),
    };
  }

  return { components, capabilities, checkedAt: nowIso() };
}
