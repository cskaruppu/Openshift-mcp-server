// ---------------------------------------------------------------------------
// From a verdict to a buildable proposal
// ---------------------------------------------------------------------------
/**
 * The step after scoring: a Containerfile and the OpenShift manifests that
 * would run the result, for a machine the assessment said is a candidate.
 *
 * Three rules, all of which are refusals rather than warnings:
 *
 *  1. NOTHING IS GENERATED FOR A MACHINE THAT WAS NOT ASSESSED. A scaffold for
 *     a machine nobody could read inside is a guess wearing a YAML costume,
 *     and it would be indistinguishable from a real proposal a week later.
 *
 *  2. NOTHING IS GENERATED FOR A BLOCKED MACHINE. A Containerfile for a host
 *     running Postgres is an invitation to build it.
 *
 *  3. EVERY UNKNOWN IS AN ASSUMPTION, LISTED SEPARATELY. The agent does not
 *     execute anything in the guest, so it has never seen a listening port, a
 *     config file or the application's files. The port in the manifest is a
 *     convention, not a reading, and it says so next to the port.
 *
 * This PROPOSES. It does not build, push, tag or deploy anything — same
 * separation as test-migration.js, and for the same reason: a human has to be
 * able to read the thing before it exists.
 *
 * Everything here is pure.
 */

import { generateManifests } from "./manifest-generator.js";
import { containerfileFor, CONVENTIONAL_PORT } from "./containerfile-templates.js";
import { distinctWorkloads, VERDICTS } from "./containerization-readiness.js";

/** Verdicts a build may be proposed for. Everything else is refused. */
const BUILDABLE = new Set([VERDICTS.READY, VERDICTS.WITH_WORK]);

/**
 * Why this machine gets no scaffold. Returns null when it may have one.
 *
 * Phrased as the reason rather than as "not eligible": the operator is going
 * to ask why, and the answer is already known here.
 */
export function planRefusal(result) {
  if (!result) return { code: "no-result", message: "This machine has not been assessed." };
  if (result.verdict === VERDICTS.POWERED_OFF) {
    return { code: "powered-off", message: "The machine is powered off, so nothing was read from it. Start it and re-assess, or retire it." };
  }
  if (result.verdict === VERDICTS.UNREADABLE) {
    return { code: "unreadable", message: `Nothing inside this machine was read, so there is nothing to base an image on. ${result.summary}` };
  }
  if (result.verdict === VERDICTS.INCONCLUSIVE) {
    return { code: "inconclusive", message: "No recognised application runtime is running, so there is no base image to propose. An owner has to identify the workload first." };
  }
  if (result.verdict === VERDICTS.VM_ONLY) {
    const b = result.blockers?.[0];
    return { code: b?.id || "blocked", message: `${b?.title || "This machine is blocked"}. ${b?.action || "Migrate it as a VM."}` };
  }
  if (!BUILDABLE.has(result.verdict)) return { code: "unknown-verdict", message: `Verdict "${result.verdict}" carries no build path.` };
  return null;
}

const dns = (s) => String(s || "app").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "app";

/**
 * Propose a build for one assessed machine.
 *
 * @param {object} result   one entry from scoreSelection()
 * @param {object} opts     { namespace, appName }
 * @returns {{ok:boolean, refusal?:object, machine, namespace, tiers, containerfiles, manifests, assumptions, nextSteps}}
 */
export function proposeContainerBuild(result, opts = {}) {
  const refusal = planRefusal(result);
  if (refusal) return { ok: false, refusal, machine: result?.name || null };

  const machine = result.name || result.vmId;
  const namespace = dns(opts.namespace || `${machine}-modernised`);
  const appName = dns(opts.appName || machine);

  // One tier per distinct workload. A web server in front of an application is
  // a Route on the target, not a second image, so it never becomes a tier —
  // building it would reproduce a reverse proxy the platform already provides.
  const workloads = distinctWorkloads(result.runtimes || []);
  const chosen = workloads.length ? workloads : (result.runtimes || []).slice(0, 1);

  const containerfiles = [], tiers = [], assumptions = [], refusedTiers = [];
  let firstPort = null;

  for (const [i, rt] of chosen.entries()) {
    const name = dns(chosen.length > 1 ? `${appName}-${rt.id}` : appName);
    const cf = containerfileFor(rt, { machine, vmId: result.vmId });
    if (!cf.ok) { refusedTiers.push({ runtime: rt.label, reason: cf.reason }); continue; }

    containerfiles.push({ tier: name, runtime: rt.id, runtimeLabel: rt.label, base: cf.base, port: cf.port, containerfile: cf.containerfile });
    if (firstPort == null) firstPort = cf.port;

    tiers.push({
      name,
      role: i === 0 ? "frontend" : "backend",
      // The image does not exist yet. Naming it after the tier is what the
      // build would produce, and leaving it blank would generate a Deployment
      // that cannot be read as a proposal.
      image: `image-registry.openshift-image-registry.svc:5000/${namespace}/${name}:latest`,
      port: cf.port,
      replicas: { min: 1, max: 1 },
      // Only the first tier is exposed. Which one faces the world is a decision
      // the agent has no evidence for, so it takes the primary runtime and says
      // so in the assumptions rather than exposing everything.
      expose: i === 0,
      probes: {
        readiness: { type: "tcp", port: cf.port },
        liveness: { type: "tcp", port: cf.port },
      },
      // Hardened by default rather than by a checkbox. A workload lifted off a
      // VM is the one most likely to have assumed root, a writable root
      // filesystem and whatever capabilities the kernel offered — so the
      // proposal takes them away up front, where it is an argument during
      // review rather than a finding during an audit.
      security: { runAsNonRoot: true, readOnlyRootFs: true, dropCapabilities: true },
    });

    assumptions.push({
      id: `port-${name}`, field: "containerPort", value: cf.port,
      why: `${cf.port} is the conventional port for ${rt.label}. Listening ports were never read — that needs a command run inside the guest, which this agent does not do.`,
      confirm: `Check what ${machine} actually listens on before building. A wrong port builds, starts, passes its probe if the probe is wrong too, and serves nothing.`,
    });
  }

  if (!containerfiles.length) {
    return {
      ok: false,
      refusal: { code: "no-base-image", message: refusedTiers.map((r) => `${r.runtime}: ${r.reason}`).join(" ") || "No runtime could be given a base image." },
      machine,
    };
  }

  // Assumptions that are true of every proposal, listed once.
  assumptions.push(
    {
      id: "artifact", field: "application files", value: "placeholder paths",
      why: "The agent never executes anything in the guest, so it has not seen the application's files. Unlike App2Container it cannot extract the war, jar or publish output.",
      confirm: "Point every COPY line at your real build output. Until then the Containerfile is a scaffold, not a build.",
    },
    {
      id: "probes", field: "health probes", value: "TCP on the container port",
      why: "A TCP probe only proves something is listening. No HTTP health path was read, because config files were not read.",
      confirm: "Replace with an httpGet probe on the application's real health endpoint. A TCP probe will report a wedged application as healthy.",
    },
    {
      id: "resources", field: "requests and limits", value: "not set",
      why: "The VM's size is not the container's requirement — a 4 vCPU VM running one Tomcat does not need 4 cores. Setting requests from the VM shape is the single most expensive mistake in a migration like this.",
      confirm: "Measure the workload and set requests from what it uses. The right-sizing panel does this from vCenter history.",
    },
    {
      id: "state", field: "persistent data", value: "no volume claimed",
      why: "No PersistentVolumeClaim is proposed because no local state was identified — and local state cannot be identified without reading the filesystem.",
      confirm: "Confirm the application writes nothing to local disk that matters. If it does, that data needs a volume and a migration of its own.",
    },
    {
      id: "config", field: "configuration and secrets", value: "none extracted",
      why: "Configuration files, environment and credentials on this machine were not read.",
      confirm: "Find what the application reads at start-up and move it to a ConfigMap and a Secret before the first deployment.",
    },
  );
  if (chosen.length > 1) {
    assumptions.push({
      id: "exposure", field: "which tier is exposed", value: tiers[0]?.name,
      why: `${chosen.length} workloads share this machine and there is no evidence about which one faces users.`,
      confirm: "Confirm the routing before applying, and expect whatever they shared on local disk to need finding.",
    });
  }

  const ais = {
    appName, namespace, targetPlatform: "openshift",
    tiers, configMaps: [], sharedSecrets: [], networkPolicies: [],
  };

  let manifests = [], summary = null;
  try {
    const gen = generateManifests(ais);
    manifests = gen.manifests || [];
    summary = gen.summary || null;
  } catch (e) {
    return { ok: false, refusal: { code: "manifest-error", message: `The manifests could not be generated: ${e.message}` }, machine };
  }

  return {
    ok: true, machine, vmId: result.vmId || null, namespace, appName,
    verdict: result.verdict, tiers, containerfiles, manifests, summary, ais,
    assumptions, refusedTiers,
    // What has to happen, in the order it bites. The concerns the assessment
    // raised come FIRST — a multi-app host that is not split produces two
    // images that both still share a filesystem nobody looked at.
    nextSteps: [
      ...(result.concerns || []).filter((c) => c.required).map((c) => `Resolve first: ${c.title}. ${c.action || ""}`.trim()),
      "Confirm every assumption on this proposal, starting with the port.",
      "Point the COPY lines at the real build output.",
      "Build the image in a pipeline, scan it, and push it to the registry.",
      `Deploy to a fenced namespace (${namespace}) and prove it answers before anything is pointed at it.`,
      "Keep the VM until the container has served real traffic for an agreed window.",
    ],
  };
}

/** Propose builds for a whole assessment, keeping the refusals visible. */
export function proposeForSelection(results = [], opts = {}) {
  const plans = [], refused = [];
  for (const r of results) {
    const p = proposeContainerBuild(r, opts);
    if (p.ok) plans.push(p); else refused.push({ machine: r.name || r.vmId, ...p.refusal });
  }
  return {
    plans, refused,
    note: `${plans.length} of ${results.length} machines ${plans.length === 1 ? "has" : "have"} a build proposal.`
      + (refused.length ? ` ${refused.length} ${refused.length === 1 ? "does" : "do"} not, and each says why.` : ""),
  };
}

export { CONVENTIONAL_PORT };
