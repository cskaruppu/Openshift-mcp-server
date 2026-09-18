// ---------------------------------------------------------------------------
// Test migration into an isolated namespace
// ---------------------------------------------------------------------------
/**
 * Prove a machine boots on OpenShift Virtualization before the real cutover —
 * the question a customer who has seen Zerto's test failover will ask, and the
 * one MTV has no answer for.
 *
 * It is also the most dangerous thing in this product, for two reasons that
 * have nothing to do with the target:
 *
 *  1. MTV powers the SOURCE off before a cold copy. A "test" that takes
 *     production down is not a test, and a button labelled "test migration"
 *     that does it is the worst possible way to find out. So a powered-on
 *     machine is refused for cold, every time, with the reason.
 *  2. A test VM that boots onto a routable network carries the ORIGINAL IP and
 *     MAC. Two machines with one address on one L2 is an outage of the real
 *     one, and a second domain-joined clone of a running server is worse. So
 *     isolation is not an option here: no isolation, no plan.
 *
 * Nothing in this file writes to a cluster. It produces refusals, manifests and
 * a teardown, and a human applies them — the model advises, code decides, a
 * person approves.
 *
 * Everything except preflight() is pure.
 */
import { ocpGet } from "../utils/openshift-client.js";

export const MTV_NS = "openshift-mtv";
/** Namespaces a test migration must never be pointed at. */
export const PROTECTED_NAMESPACES = Object.freeze([
  "default", "kube-system", "kube-public", "kube-node-lease", "openshift",
  "openshift-mtv", "openshift-cnv", "openshift-monitoring", "openshift-operators",
]);

/** A DNS-1123 namespace derived from a wave name, prefixed so it is obvious. */
export function sandboxNamespace(wave = "wave", prefix = "mig-test") {
  const safe = String(wave).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "wave";
  return `${prefix}-${safe}`.slice(0, 63).replace(/-$/, "");
}

/**
 * Whether these machines can be test-migrated at all, and why not. Pure.
 *
 * Each refusal names the machine and the fix, because "3 VMs cannot be tested"
 * is not something anybody can act on.
 */
export function testMigrationRefusals(vms = [], opts = {}) {
  const strategy = opts.strategy === "warm" ? "warm" : "cold";
  const refusals = [], warnings = [];

  for (const vm of vms) {
    const on = vm.poweredOn === true;

    if (strategy === "cold" && on) {
      refusals.push({
        name: vm.name, code: "cold-would-power-off-production",
        message: `${vm.name} is running. A cold migration powers the source off before it copies, so a cold "test" of this machine is a production outage. Power it off in a change window, or use a warm test — which leaves it running.`,
      });
      continue;
    }
    if (strategy === "warm") {
      if (vm.changeTrackingEnabled !== true) {
        refusals.push({
          name: vm.name, code: "warm-needs-cbt",
          message: `${vm.name} has no changed block tracking, so a warm copy is impossible and the only alternative would power it off. Enable CBT and rediscover, or test it during a window when it is already shut down.`,
        });
        continue;
      }
      if (vm.hasSnapshot === true) {
        refusals.push({
          name: vm.name, code: "warm-snapshot-chain",
          message: `${vm.name} already has snapshots in vCenter. Forklift takes its own to track changes and will not stack on an existing chain. Consolidate them first.`,
        });
        continue;
      }
      if (on) {
        warnings.push({
          name: vm.name, code: "warm-snapshots-the-source",
          message: `Testing ${vm.name} warm creates a Forklift snapshot on the source in vCenter. It is removed afterwards, but it is a change to a production machine and belongs in the change record.`,
        });
      }
    }
    if (vm.hasSnapshot === null || vm.changeTrackingEnabled === null) {
      warnings.push({
        name: vm.name, code: "unverified",
        message: `The inventory did not report snapshots or change tracking for ${vm.name}, so those checks could not run. That is not the same as passing them.`,
      });
    }
  }
  return { strategy, refusals, warnings, allowed: vms.filter((v) => !refusals.some((r) => r.name === v.name)) };
}

/**
 * The NetworkPolicy that makes the namespace a sandbox. Pure.
 *
 * Deny-all in BOTH directions. Ingress alone would still let a cloned domain
 * controller reach the real one and replicate — which is the failure that ends
 * a proof of concept. DNS is not excepted: a test VM that cannot resolve is a
 * smaller problem than one that can register itself.
 */
export function buildIsolationPolicy(namespace) {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "test-migration-isolation", namespace,
      labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai", "tcs.agentic-ai/kind": "test-migration" },
      annotations: {
        "tcs.agentic-ai/why": "A test-migrated VM carries the source's IP and MAC. Without this policy it would collide with the machine still running in production.",
      },
    },
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  };
}

/** The sandbox namespace itself, labelled so teardown can find everything. */
export function buildSandboxNamespace(namespace, { wave = null, actor = "operator" } = {}) {
  return {
    apiVersion: "v1", kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "app.kubernetes.io/managed-by": "tcs-agentic-ai",
        "tcs.agentic-ai/kind": "test-migration",
        // Pod security stays enforced: a test is not a reason to relax it.
        "pod-security.kubernetes.io/enforce": "baseline",
      },
      annotations: {
        "tcs.agentic-ai/wave": wave || "",
        "tcs.agentic-ai/created-by": actor,
        "tcs.agentic-ai/disposable": "true",
      },
    },
  };
}

/**
 * The Plan. Deliberately a separate Plan from the real one, into a separate
 * namespace, so nothing about the test can be mistaken for the migration —
 * including by a later operator reading `oc get plans`.
 */
export function buildTestPlanManifest({ planName, namespace, vms, sourceProvider, targetProvider, networkMap, storageMap, strategy = "cold", wave = null }) {
  return {
    apiVersion: "forklift.konveyor.io/v1beta1",
    kind: "Plan",
    metadata: {
      name: planName, namespace: MTV_NS,
      labels: {
        "app.kubernetes.io/managed-by": "tcs-agentic-ai",
        "tcs.agentic-ai/kind": "test-migration",
        "tcs.agentic-ai/strategy": strategy,
      },
      annotations: {
        "tcs.agentic-ai/wave": wave || "",
        "tcs.agentic-ai/sandbox-namespace": namespace,
        "tcs.agentic-ai/disposable": "true",
        "tcs.agentic-ai/why": "Test migration. The VMs it creates are throwaway and the namespace is deleted afterwards.",
      },
    },
    spec: {
      provider: {
        source: { name: sourceProvider, namespace: MTV_NS },
        destination: { name: targetProvider, namespace: MTV_NS },
      },
      map: {
        network: { name: networkMap, namespace: MTV_NS },
        storage: { name: storageMap, namespace: MTV_NS },
      },
      targetNamespace: namespace,
      warm: strategy === "warm",
      vms: vms.map((v) => (v.id ? { id: v.id, name: v.name } : { name: v.name })),
    },
  };
}

/**
 * What to check once the machines are up, in the order a person would.
 *
 * A test migration that only proves "the VM exists" proves almost nothing —
 * MTV already reported that. The value is in the boot, the guest agent and the
 * disks, which is where a migration actually fails.
 */
export function validationChecklist(vms = [], namespace) {
  return [
    { id: "created", label: "The VirtualMachine objects exist", how: `oc get vm -n ${namespace}`, automatic: true },
    { id: "scheduled", label: "Every VM found a node and is not Pending", how: `oc get vmi -n ${namespace} -o wide`, automatic: true,
      why: "This is the check the whole capacity panel exists to predict. If a VM sits Pending here, the prediction was wrong and that is worth knowing now." },
    { id: "running", label: "Every VM reached Running", how: `oc get vmi -n ${namespace}`, automatic: true },
    { id: "booted", label: "The guest booted, not just the VM", how: `virtctl console <vm> -n ${namespace}`, automatic: false,
      why: "A Windows machine migrated without VirtIO drivers reaches Running and then sits at an inaccessible-boot-device stop code. The VM is up; the guest is not." },
    { id: "agent", label: "The guest agent is reporting", how: `oc get vmi <vm> -n ${namespace} -o jsonpath='{.status.guestOSInfo}'`, automatic: true,
      why: "Proves the OS is genuinely alive rather than sitting at a firmware prompt." },
    { id: "disks", label: "Every disk is attached and the right size", how: `oc get vm <vm> -n ${namespace} -o jsonpath='{.spec.template.spec.domain.devices.disks}'`, automatic: true },
    { id: "app", label: "The application starts", how: "Console in and check the service, database or listener by hand.", automatic: false,
      why: `Nothing in the platform can verify this, and it is the only check that answers the question the business asked. The VM has no network — ${namespace} denies all traffic — so this is done from the console.` },
  ].map((c) => ({ ...c, vms: vms.map((v) => v.name) }));
}

/** Removing a test leaves nothing behind. Ordered: plan first, namespace last. */
export function teardownPlan(planName, namespace) {
  return {
    commands: [
      `oc delete plan ${planName} -n ${MTV_NS}`,
      `oc delete namespace ${namespace}`,
    ],
    note: `Deleting the namespace removes the test VMs and their disks. The source machines in vCenter are untouched — a test migration copies, it never moves.`,
    warning: `The PersistentVolumeClaims go with the namespace. If the storage class reclaim policy is Retain, the volumes survive and are worth checking: oc get pv | grep ${namespace}`,
  };
}

/**
 * The whole proposal: what will be created, what was refused, and how to undo
 * it. Pure — this returns a plan, it does not execute one.
 */
export function proposeTestMigration(vms = [], opts = {}) {
  const wave = opts.wave || "wave-1";
  const namespace = opts.namespace || sandboxNamespace(wave);
  const strategy = opts.strategy === "warm" ? "warm" : "cold";
  const { refusals, warnings, allowed } = testMigrationRefusals(vms, { strategy });

  const blocking = [];
  if (PROTECTED_NAMESPACES.includes(namespace)) {
    blocking.push({ code: "protected-namespace", message: `${namespace} is a platform namespace. A test migration creates and then deletes its namespace, so it must have one of its own.` });
  }
  if (!opts.sourceProvider) blocking.push({ code: "no-source-provider", message: "No source provider was given." });
  if (!opts.targetProvider) blocking.push({ code: "no-target-provider", message: "No target provider was given." });
  if (!opts.storageMap) blocking.push({ code: "no-storage-map", message: "A test migration copies real disks and needs a StorageMap, the same as a real one." });
  if (!opts.networkMap) {
    blocking.push({
      code: "no-network-map",
      message: "No NetworkMap was given. A test VM boots with the source machine's IP and MAC, so it must be mapped to a network it cannot reach production from — the pod network with the isolation policy below, or a dedicated isolated attachment.",
    });
  }
  if (opts.namespaceInUse) {
    blocking.push({ code: "namespace-in-use", message: `${namespace} already contains workloads this agent did not create. Teardown deletes the whole namespace, so it will not be pointed at one that holds anything else.` });
  }
  if (!allowed.length && vms.length) {
    blocking.push({ code: "nothing-testable", message: `None of the ${vms.length} selected machines can be test-migrated ${strategy}. See the refusals for each.` });
  }

  const planName = `test-${sandboxNamespace(wave, "mig").replace(/^mig-/, "")}-${strategy}`.slice(0, 57);
  const ok = blocking.length === 0;

  return {
    ok, namespace, planName, strategy, wave,
    vms: allowed.map((v) => v.name),
    refusals, warnings, blocking,
    manifests: ok ? [
      buildSandboxNamespace(namespace, { wave, actor: opts.actor }),
      // The policy is applied BEFORE the plan runs. A VM that boots for even a
      // minute on a routable network with a live machine's address has already
      // done the damage this whole design exists to avoid.
      buildIsolationPolicy(namespace),
      buildTestPlanManifest({ planName, namespace, vms: allowed, strategy, wave, ...opts }),
    ] : [],
    order: ok ? [
      `Create ${namespace} and apply the isolation policy — before anything is copied.`,
      `Create the test plan and let MTV validate it.`,
      `Run it, then work down the checklist.`,
      `Tear the namespace down. The result is a yes or a no, not an environment to keep.`,
    ] : [],
    checklist: ok ? validationChecklist(allowed, namespace) : [],
    teardown: ok ? teardownPlan(planName, namespace) : null,
    headline: ok
      ? `${allowed.length} machine${allowed.length === 1 ? "" : "s"} can be test-migrated ${strategy} into ${namespace}, isolated from every network.${refusals.length ? ` ${refusals.length} refused.` : ""}`
      : blocking[0].message,
  };
}

// ── The one thing that reads the cluster ───────────────────────────────────
/**
 * Whether the sandbox namespace is safe to use. A namespace that already holds
 * somebody's workload must never be proposed, because teardown deletes it.
 */
export async function preflight(namespace) {
  const ns = await ocpGet(`/api/v1/namespaces/${namespace}`).catch(() => null);
  if (!ns) return { exists: false, inUse: false, reason: null };
  const managed = ns.metadata?.labels?.["app.kubernetes.io/managed-by"] === "tcs-agentic-ai"
    && ns.metadata?.labels?.["tcs.agentic-ai/kind"] === "test-migration";
  const pods = await ocpGet(`/api/v1/namespaces/${namespace}/pods?limit=5`).catch(() => null);
  const busy = (pods?.items || []).length > 0;
  return {
    exists: true,
    inUse: !managed,
    hasWorkloads: busy,
    reason: managed
      ? (busy ? `${namespace} is a previous test sandbox and still has workloads in it. Tear it down before starting another.` : null)
      : `${namespace} exists and was not created by this agent. Teardown deletes the whole namespace, so a different name is needed.`,
  };
}
